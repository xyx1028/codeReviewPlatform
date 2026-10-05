/**
 * Agent 身份、可信 lineage 与能力令牌 —— 全部在 Worker 侧。
 *
 * V3 的 Broker 只认识 `taskId + agentAttempt + token`，所以它无法回答"这次调用是根
 * Agent 发出的吗"。V4 把这个问题变成可判定的：
 *
 *   1. 根 Agent 的身份由 Worker 在启动前生成，不是模型报出来的；
 *   2. 每个子 Agent 必须先由父 Agent 注册（父必须已注册且仍在运行），才能拿到令牌；
 *   3. 令牌与 agentId 绑定、短期有效，且只能缩小权限；
 *   4. 每次工具调用都必须出示令牌 —— Broker 不看请求体里自报的 agentId。
 *
 * 关键点：模型可以往请求体里写任何 agentId，但它拿不到别人的令牌。伪造 root id 的调用
 * 会因为令牌不匹配而被拒绝，而不是因为"我们相信它没撒谎"。
 */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import {
  brokerCapabilitiesForRole,
  resolveToolsForRole,
  type AgentProvider,
  type AgentRole,
  type BrokerCapability,
  type V4CapabilityPolicy,
} from '../policy/v4-capability-policy.js'
import { V4_ERROR_CODES, V4GovernanceError } from '../policy/v4-errors.js'

/**
 * provider → 允许的 role。
 *
 * 这张表存在的理由：子 Agent 的角色不能由模型自报的 label 直接决定，但也不能一刀切成
 * 同一个角色（那样 fork 出来的 critic 会拿到它不需要的写权限）。折中是按 provider 给出
 * 一个允许集合，并把集合里最保守的那个作为默认值。请求一个不在集合里的角色直接拒绝。
 *
 * 这里不存在"提权越过 root"的可能：任何子角色都是 root 权限的真子集，而 root 权限本身
 * 由冻结的 policy 决定。
 */
const ROLES_BY_PROVIDER: Record<AgentProvider, readonly AgentRole[]> = {
  root: ['root-reviewer'],
  // spawn 是新上下文的调查任务，默认只读；root 可以显式要一个能写 overlay 的实现型子 Agent。
  spawn: ['research-child', 'critic-child', 'implementation-child'],
  // fork 继承父 Agent 已完成 turn 的历史，用于交叉审查，默认只读。
  fork: ['critic-child', 'research-child'],
  workflow: ['workflow-child'],
  ralph: ['research-child'],
}

/** provider 的默认角色：集合里第一个，也是最保守的那个。 */
export function defaultRoleForProvider(provider: AgentProvider): AgentRole {
  return ROLES_BY_PROVIDER[provider][0]!
}

export interface AgentIdentity {
  agentId: string
  sessionId: string
  parentAgentId: string | null
  role: AgentRole
  provider: AgentProvider
  delegationDepth: number
  /** 该 Agent 可见的工具集合（policy ∩ role ∩ depth ∩ sandbox）。 */
  tools: readonly string[]
  /** 该 Agent 可用的 Broker 能力。 */
  capabilities: ReadonlySet<BrokerCapability>
  /** 工具策略的稳定摘要，写进 analysis_agent_node 用于审计。 */
  toolPolicyHash: string
  status: 'RUNNING' | 'FINISHED' | 'FAILED' | 'CANCELLED'
  startedAt: string
  finishedAt: string | null
}

export interface RegisterChildInput {
  /** 父 Agent 的 capability token —— 只有已注册且在跑的父节点能造子节点。 */
  parentToken: string
  agentId: string
  sessionId: string
  provider: Exclude<AgentProvider, 'root'>
  /** 可选的角色请求，必须落在 provider 允许集合内。 */
  requestedRole?: string
  delegationDepth?: number
}

export interface AuthorizedCall {
  identity: AgentIdentity
  capability: BrokerCapability
}

export interface AgentAuthorityLedgerOptions {
  taskId: string
  agentAttempt: number
  policy: V4CapabilityPolicy
  /** 由 Worker 生成的稳定根身份。 */
  rootAgentId: string
  rootSessionId: string
  /** Keep slots for mandatory platform peers; children cannot consume them. */
  reservedPlatformRootSlots?: number
  /** 注册子节点时同步写库；返回 false 表示数据库拒绝了这次 lineage。 */
  persistNode?(identity: AgentIdentity): Promise<void>
}

function hashTools(role: AgentRole, tools: readonly string[]): string {
  return createHash('sha256').update(`${role}:${[...tools].sort().join(',')}`).digest('hex')
}

function mintToken(): string {
  return randomBytes(32).toString('base64url')
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

export class AgentAuthorityLedger {
  private readonly byToken = new Map<string, AgentIdentity>()
  private readonly byAgentId = new Map<string, { identity: AgentIdentity; token: string }>()
  private readonly childrenOf = new Map<string, Set<string>>()
  private readonly rootToken: string
  private cancelled: string | null = null
  private sealed = false
  private remainingPlatformRootSlots: number

  constructor(private readonly options: AgentAuthorityLedgerOptions) {
    this.remainingPlatformRootSlots = options.reservedPlatformRootSlots ?? 0
    const role: AgentRole = 'root-reviewer'
    const tools = resolveToolsForRole({ role, policy: options.policy, delegationDepth: 0 })
    const identity: AgentIdentity = {
      agentId: options.rootAgentId,
      sessionId: options.rootSessionId,
      parentAgentId: null,
      role,
      provider: 'root',
      delegationDepth: 0,
      tools,
      capabilities: brokerCapabilitiesForRole({ role, policy: options.policy, delegationDepth: 0 }),
      toolPolicyHash: hashTools(role, tools),
      status: 'RUNNING',
      startedAt: new Date().toISOString(),
      finishedAt: null,
    }
    this.rootToken = mintToken()
    this.byToken.set(this.rootToken, identity)
    this.byAgentId.set(identity.agentId, { identity, token: this.rootToken })
    this.childrenOf.set(identity.agentId, new Set())
  }

  /** 根 Agent 的令牌。只交给 Harness 子进程的启动 patch，不进日志。 */
  get rootCapabilityToken(): string {
    return this.rootToken
  }

  get root(): AgentIdentity {
    return this.byAgentId.get(this.options.rootAgentId)!.identity
  }

  /** Only the platform may create a peer root; no model-facing registration path calls this. */
  async registerPlatformRoot(agentId: string, sessionId: string): Promise<{ identity: AgentIdentity; token: string }> {
    this.assertUsable()
    if (this.byAgentId.has(agentId)) throw new Error('platform phase root already exists')
    if (this.totalCount() >= this.options.policy.agents.maxAgentsPerAttempt) {
      throw new V4GovernanceError(V4_ERROR_CODES.AGENT_TREE_LIMIT_EXCEEDED, 'independent verification requires an available platform Agent slot')
    }
    const identity: AgentIdentity = {
      ...this.root, agentId, sessionId, parentAgentId: null, provider: 'root', delegationDepth: 0,
      status: 'RUNNING', startedAt: new Date().toISOString(), finishedAt: null,
    }
    await this.options.persistNode?.(identity)
    const token = mintToken()
    this.byToken.set(token, identity)
    this.byAgentId.set(agentId, { identity, token })
    this.childrenOf.set(agentId, new Set())
    this.remainingPlatformRootSlots = Math.max(0, this.remainingPlatformRootSlots - 1)
    return { identity, token }
  }

  /** Rotate the anchor root's secret between independently launched phase processes. */
  rotatePlatformRootToken(agentId: string): string {
    this.assertUsable()
    const entry = this.byAgentId.get(agentId)
    if (!entry || entry.identity.provider !== 'root' || entry.identity.status !== 'RUNNING') throw new Error('phase root is not running')
    this.byToken.delete(entry.token)
    const token = mintToken()
    this.byToken.set(token, entry.identity)
    this.byAgentId.set(agentId, { identity: entry.identity, token })
    return token
  }

  /** 当前活着的 Agent 数量。 */
  liveCount(): number {
    let count = 0
    for (const entry of this.byAgentId.values()) {
      if (entry.identity.status === 'RUNNING') count++
    }
    return count
  }

  totalCount(): number {
    return this.byAgentId.size
  }

  all(): AgentIdentity[] {
    return [...this.byAgentId.values()].map((entry) => entry.identity)
  }

  get(agentId: string): AgentIdentity | undefined {
    return this.byAgentId.get(agentId)?.identity
  }

  /** 直接子节点，创建顺序。 */
  childrenIdsOf(agentId: string): string[] {
    return [...(this.childrenOf.get(agentId) ?? [])]
  }

  /**
   * 注册一个子 Agent 并返回它自己的令牌。
   *
   * 拒绝的每一种情况都对应一条不可突破的边界，而不是"防御性编程"：
   *  - 父令牌无效 → 调用者根本不是这棵树里的 Agent；
   *  - 父节点已结束 → 迟到的 spawn，父的 turn 已经交出去了；
   *  - 深度或总数超限 → policy 冻结的上限；
   *  - 角色不在 provider 允许集合内 → 试图提权。
   */
  async registerChild(input: RegisterChildInput): Promise<{ token: string; identity: AgentIdentity }> {
    this.assertUsable()
    const parent = this.byToken.get(input.parentToken)
    if (!parent) {
      throw new V4GovernanceError(
        V4_ERROR_CODES.AGENT_IDENTITY_INVALID,
        'the caller does not hold a valid agent capability for this attempt',
      )
    }
    if (parent.status !== 'RUNNING') {
      throw new V4GovernanceError(
        V4_ERROR_CODES.AGENT_TREE_CANCELLED,
        'the delegating agent has already finished; it cannot start a new child',
      )
    }

    const existing = this.byAgentId.get(input.agentId)
    if (existing) {
      // 幂等：同一个 agentId 重复注册返回原令牌，但父节点必须一致，否则是重挂 lineage。
      if (existing.identity.parentAgentId !== parent.agentId) {
        throw new V4GovernanceError(
          V4_ERROR_CODES.AGENT_IDENTITY_INVALID,
          'this agent id is already registered under a different parent',
        )
      }
      return { token: existing.token, identity: existing.identity }
    }

    const allowed = ROLES_BY_PROVIDER[input.provider]
    if (!allowed) {
      throw new V4GovernanceError(
        V4_ERROR_CODES.AGENT_IDENTITY_INVALID,
        `unsupported subagent provider: ${input.provider}`,
      )
    }
    const role =
      input.requestedRole === undefined
        ? defaultRoleForProvider(input.provider)
        : (allowed.find((candidate) => candidate === input.requestedRole) ?? null)
    if (role === null) {
      throw new V4GovernanceError(
        V4_ERROR_CODES.AGENT_ROLE_DENIED,
        `provider ${input.provider} may not run role ${String(input.requestedRole)}`,
      )
    }

    const depth = input.delegationDepth ?? parent.delegationDepth + 1
    if (depth !== parent.delegationDepth + 1) {
      // 深度必须严格由 lineage 推出来。允许自报会让 depth 限制形同虚设。
      throw new V4GovernanceError(
        V4_ERROR_CODES.AGENT_IDENTITY_INVALID,
        'the reported delegation depth does not follow from the registered parent',
      )
    }
    if (depth > this.options.policy.agents.maxDelegationDepth) {
      throw new V4GovernanceError(
        V4_ERROR_CODES.AGENT_TREE_LIMIT_EXCEEDED,
        `delegation depth ${depth} exceeds the attempt limit of ${this.options.policy.agents.maxDelegationDepth}`,
      )
    }
    if (this.byAgentId.size >= this.options.policy.agents.maxAgentsPerAttempt - this.remainingPlatformRootSlots) {
      throw new V4GovernanceError(
        V4_ERROR_CODES.AGENT_TREE_LIMIT_EXCEEDED,
        `this attempt already has ${this.byAgentId.size} agents; ${this.remainingPlatformRootSlots} slots are reserved for platform verification within the limit ${this.options.policy.agents.maxAgentsPerAttempt}`,
      )
    }
    const liveSiblings = [...(this.childrenOf.get(parent.agentId) ?? [])].filter(
      (id) => this.byAgentId.get(id)?.identity.status === 'RUNNING',
    ).length
    if (liveSiblings >= this.options.policy.agents.maxConcurrentChildren) {
      throw new V4GovernanceError(
        V4_ERROR_CODES.AGENT_TREE_LIMIT_EXCEEDED,
        `agent already runs ${liveSiblings} concurrent children, the limit is ${this.options.policy.agents.maxConcurrentChildren}`,
      )
    }

    const tools = resolveToolsForRole({ role, policy: this.options.policy, delegationDepth: depth })
    // 子权限只能缩小：交集一次，确保任何角色表变更都不会让 child 看到 parent 没有的工具。
    const narrowed = tools.filter((tool) => parent.tools.includes(tool))
    const identity: AgentIdentity = {
      agentId: input.agentId,
      sessionId: input.sessionId,
      parentAgentId: parent.agentId,
      role,
      provider: input.provider,
      delegationDepth: depth,
      tools: narrowed,
      capabilities: intersectCapabilities(
        brokerCapabilitiesForRole({ role, policy: this.options.policy, delegationDepth: depth }),
        parent.capabilities,
      ),
      toolPolicyHash: hashTools(role, narrowed),
      status: 'RUNNING',
      startedAt: new Date().toISOString(),
      finishedAt: null,
    }

    // 先落库再发令牌：数据库是可信 lineage 的最终仲裁，它拒绝就等于没注册成功。
    await this.options.persistNode?.(identity)

    const token = mintToken()
    this.byToken.set(token, identity)
    this.byAgentId.set(identity.agentId, { identity, token })
    this.childrenOf.set(identity.agentId, new Set())
    this.childrenOf.get(parent.agentId)!.add(identity.agentId)
    return { token, identity }
  }

  /**
   * 校验一次工具调用。
   *
   * 只看令牌。请求体里自报的 agentId 只用于比对（不一致直接拒绝），从不用于查找身份 ——
   * 否则伪造 root id 就能拿到 root 权限。
   */
  authorize(input: {
    token: string | undefined
    capability: BrokerCapability
    claimedAgentId?: unknown
    toolName?: string
  }): AuthorizedCall {
    this.assertUsable()
    if (typeof input.token !== 'string' || input.token.length === 0) {
      throw new V4GovernanceError(
        V4_ERROR_CODES.AGENT_IDENTITY_INVALID,
        'the request carries no agent capability',
      )
    }
    // 常量时间比较不是为了防远程计时攻击（这是本机 socket），而是为了不给
    // "逐字节试探令牌" 留下任何可测量的信号。
    let identity: AgentIdentity | undefined
    for (const [token, candidate] of this.byToken) {
      if (constantTimeEquals(token, input.token)) {
        identity = candidate
        break
      }
    }
    if (!identity) {
      throw new V4GovernanceError(
        V4_ERROR_CODES.AGENT_IDENTITY_INVALID,
        'the agent capability is unknown or has been revoked',
      )
    }
    if (
      input.claimedAgentId !== undefined &&
      input.claimedAgentId !== null &&
      input.claimedAgentId !== identity.agentId
    ) {
      throw new V4GovernanceError(
        V4_ERROR_CODES.AGENT_IDENTITY_INVALID,
        'the reported agent id does not match the presented capability',
      )
    }
    if (identity.status !== 'RUNNING') {
      throw new V4GovernanceError(
        V4_ERROR_CODES.AGENT_TREE_CANCELLED,
        'this agent has already reached a terminal state',
      )
    }
    if (input.toolName !== undefined && !identity.tools.includes(input.toolName)) {
      // 提交是最常见的一种越权，单独给它一个码，好让 UI 和审计能一眼分辨。
      throw new V4GovernanceError(
        input.toolName === 'submit_review_result'
          ? V4_ERROR_CODES.SUBMIT_ROOT_ONLY
          : V4_ERROR_CODES.AGENT_ROLE_DENIED,
        input.toolName === 'submit_review_result'
          ? 'only the root reviewer may submit the final result; return your findings to your parent instead'
          : `role ${identity.role} may not call ${input.toolName}`,
      )
    }
    if (!identity.capabilities.has(input.capability)) {
      throw new V4GovernanceError(
        input.capability === 'submitReview'
          ? V4_ERROR_CODES.SUBMIT_ROOT_ONLY
          : V4_ERROR_CODES.AGENT_ROLE_DENIED,
        `role ${identity.role} does not hold the ${input.capability} capability`,
      )
    }
    return { identity, capability: input.capability }
  }

  /** 标记一个 Agent 终态。返回是否真的发生了状态变化。 */
  finish(agentId: string, status: 'FINISHED' | 'FAILED' | 'CANCELLED'): boolean {
    const entry = this.byAgentId.get(agentId)
    if (!entry || entry.identity.status !== 'RUNNING') return false
    const updated: AgentIdentity = {
      ...entry.identity,
      status,
      finishedAt: new Date().toISOString(),
    }
    this.byAgentId.set(agentId, { identity: updated, token: entry.token })
    this.byToken.set(entry.token, updated)
    return true
  }

  /**
   * 撤销一个 Agent 的令牌。取消路径用它来确保迟到的工具调用无法再写入。
   *
   * 撤销与 finish 分开：finish 是"这个 Agent 干完了"，撤销是"它的令牌此后一律不认"。
   */
  revoke(agentId: string): void {
    const entry = this.byAgentId.get(agentId)
    if (!entry) return
    this.byToken.delete(entry.token)
  }

  /**
   * child-first 收敛整棵树。
   *
   * 顺序是刻意的：先撤销最深的子节点，再往上走。反过来做会在父节点已经失效、子节点还
   * 活着的窗口里留下"孤儿仍在写入"的可能。
   */
  cancelTree(reason: string): AgentIdentity[] {
    this.cancelled = reason
    const ordered = this.all().sort((a, b) => b.delegationDepth - a.delegationDepth)
    const cancelledNodes: AgentIdentity[] = []
    for (const identity of ordered) {
      if (this.finish(identity.agentId, 'CANCELLED')) {
        cancelledNodes.push(this.get(identity.agentId)!)
      }
      this.revoke(identity.agentId)
    }
    return cancelledNodes
  }

  /** 提交成功后封存：此后任何调用都得到 ATTEMPT_ALREADY_SEALED。 */
  seal(): void {
    this.sealed = true
    for (const identity of this.all()) {
      this.finish(identity.agentId, 'FINISHED')
      this.revoke(identity.agentId)
    }
  }

  isSealed(): boolean {
    return this.sealed
  }

  cancelledReason(): string | null {
    return this.cancelled
  }

  /**
   * 整棵树的稳定摘要，随提交一起入库。
   *
   * 它回答的是"这份结果由哪棵 Agent Tree 产生"。摘要覆盖 lineage、角色、深度和终态，
   * 但不含令牌 —— 令牌绝不能出现在任何持久化的地方。
   */
  /**
   * Agent Tree 的摘要：只覆盖**身份与血缘**，刻意不含节点状态。
   *
   * 它证明的是"提交时看到的这棵树就是数据库里注册过的那棵树"——没有未注册的 Agent 参与。
   * `status` 对这个结论没有贡献，却引入过一个真实的误拒面：子 Agent 结束时的
   * `/attempt/finish-agent` 上报失败（或子 Agent 恰好与提交并发结束）时，本地账本已是
   * FINISHED、数据库仍是 RUNNING，两侧摘要必然不等，于是**一次完全合法的提交被
   * AGENT_IDENTITY_INVALID 拒掉**，而且是在模型费用全部花完之后。
   *
   * 实测：同一棵树，子 Agent 由 RUNNING 变 FINISHED 时摘要从 8a7381d4… 变为 8af71c68…。
   *
   * 字段与顺序必须与 SQL 的 `analysis_agent_tree_digest`（见 migration 0028）逐字一致，
   * 包括分隔符和排序规则——两侧算出不同字符串等于把所有提交拒掉。节点状态仍然逐节点持久化
   * 在 `analysis_agent_node.status`，可追溯性没有损失。
   */
  treeDigest(): string {
    const rows = this.all()
      .map((identity) =>
        [
          identity.agentId,
          identity.parentAgentId ?? '-',
          identity.role,
          identity.provider,
          String(identity.delegationDepth),
          identity.toolPolicyHash,
        ].join('|'),
      )
      .sort()
    return createHash('sha256').update(rows.join('\n')).digest('hex')
  }

  /** 每个 Agent 的最大深度，用于 usage 上报。 */
  maxDepthReached(): number {
    return this.all().reduce((max, identity) => Math.max(max, identity.delegationDepth), 0)
  }

  private assertUsable(): void {
    if (this.sealed) {
      throw new V4GovernanceError(
        V4_ERROR_CODES.ATTEMPT_ALREADY_SEALED,
        'this attempt has already been committed; no further agent activity is accepted',
      )
    }
    if (this.cancelled !== null) {
      throw new V4GovernanceError(
        V4_ERROR_CODES.AGENT_TREE_CANCELLED,
        `the agent tree was cancelled (${this.cancelled})`,
      )
    }
  }
}

function intersectCapabilities(
  child: ReadonlySet<BrokerCapability>,
  parent: ReadonlySet<BrokerCapability>,
): Set<BrokerCapability> {
  const result = new Set<BrokerCapability>()
  for (const capability of child) {
    if (parent.has(capability)) result.add(capability)
  }
  return result
}

/** 生成一次 attempt 的稳定根身份。Worker 生成，模型无从选择。 */
export function mintRootIdentity(taskId: string, agentAttempt: number): {
  rootAgentId: string
  rootSessionId: string
} {
  // 用 task + attempt 派生：同一个 attempt 重启后恢复 Session 时能算出同样的 id，
  // 这是 WP6 resume 能接回原会话的前提。
  const seed = createHash('sha256').update(`${taskId}:${agentAttempt}`).digest('hex')
  return {
    rootAgentId: `root-${seed.slice(0, 32)}`,
    rootSessionId: `session-${seed.slice(0, 32)}`,
  }
}

/** 为诊断生成一个不可预测的 correlation id（不用于授权）。 */
export function newCorrelationId(): string {
  return randomUUID()
}
