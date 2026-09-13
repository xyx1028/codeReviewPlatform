/**
 * Harness 进程内的 Agent 身份解析。
 *
 * 平台自有的三个插件（authority、web、snapshot/submit 工具）都需要回答同一个问题：
 * "这次工具调用是哪个 Agent 发起的，它的 capability token 是什么"。这个模块是唯一的答案来源。
 *
 * 身份从哪来：
 *
 *   * 根 Agent 的 id 与 token 由 Worker 在启动 patch 里给定 —— 模型无从选择；
 *   * 子 Agent 的 id 是 Harness 的 session id（`exec.agent.id`），由 agent loop 设置，
 *     模型同样无从伪造；
 *   * 子 Agent 的 token 通过向 Broker 注册换取，注册时出示 **父 Agent** 的 token。
 *
 * 父是谁：一个子 Agent 一定是在父 Agent 执行 `subagent` / `subagent_fork` / `workflow` /
 * `ralph` 这类委派工具的过程中被创建的。契约把这些工具全部标成 `mutating: true`，而
 * policy 强制 `mutationToolsSerial`，所以同一时刻最多只有一次委派在进行 —— "当前正在
 * 执行委派工具的那个 Agent"就是父。这不是启发式，而是由并行策略保证的不变量。
 */

import { brokerPost, BrokerChannelError, type BrokerChannelOptions } from './broker-client.js'

/** 会创建子 Agent 的工具名，与 v4-capability-contract.json 的 mutating 标记一致。 */
export const DELEGATION_TOOLS: Record<string, 'spawn' | 'fork' | 'workflow' | 'ralph'> = {
  subagent: 'spawn',
  subagent_fork: 'fork',
  workflow: 'workflow',
  ralph: 'ralph',
}

export interface AgentIdentityRecord {
  agentId: string
  sessionId: string
  agentCapability: string
  role: string
  delegationDepth: number
  tools: readonly string[]
}

export interface AgentRegistryConfig extends BrokerChannelOptions {
  taskId: string
  agentAttempt: number
  rootAgentId: string
  rootSessionId: string
  rootCapability: string
  rootTools: readonly string[]
  /**
   * 按 session id 读取 Harness 的**权威**会话头部。
   *
   * 这是 lineage 的第一来源，优先于"当前正在执行委派工具的那个 Agent"这个时序推断。
   * Harness 在创建子 Agent 时把 `parentSession` / `delegationDepth` / `origin: 'subagent'`
   * 写进子会话头部（见 `dsh-subagent` 的 `childSessionMeta`），由 Harness 设置、模型无法伪造、
   * **与同步或异步无关**。
   *
   * 为什么必须有它：时序推断依赖"委派工具执行期间子 Agent 才会出现"。这个不变量对同步委派
   * 成立，对**后台委派不成立** —— `subagent` 带 `run_in_background: true` 时立即返回 job id，
   * post-execute 清掉委派标记之后子 Agent 才异步启动，那一刻栈上已经没有委派了。实测后果是
   * `[usage-reporter] IDENTITY_UNRESOLVED`，子 Agent 的模型请求被 fail closed 拒绝，job 直接
   * failed，而且失败原因不外泄 —— 表现成"后台委派静默无效"。
   */
  sessionHeader?: (sessionId: string) => { parentSession?: string; delegationDepth?: number; origin?: string } | undefined
}

/**
 * 进程内身份表。
 *
 * 一个 Harness 进程只服务一次 attempt，所以这是模块级单例：三个插件在同一个进程里，
 * 必须看到同一份身份表，否则 web 插件会以为自己不认识某个已注册的子 Agent。
 */
let registry: AgentIdentityRegistry | null = null

export class AgentIdentityRegistry {
  private readonly byAgentId = new Map<string, AgentIdentityRecord>()
  /** 当前正在执行委派工具的 Agent 栈。串行策略下深度最多为 1，但栈更诚实。 */
  private readonly delegating: Array<{ agentId: string; provider: string; requestedRole?: string }> = []
  /** 同一个子 Agent 的并发首次调用共享一次注册。 */
  private readonly pending = new Map<string, Promise<AgentIdentityRecord>>()
  /**
   * 根 Agent 在 Harness 侧的真实 session id。
   *
   * `session/new` 由 agent 侧生成 id，所以它与 Worker 派生的 rootSessionId 不同。只允许
   * 被认领一次，见 `register()` 里的说明。
   */
  private rootAlias: string | null = null

  constructor(private readonly config: AgentRegistryConfig) {
    this.byAgentId.set(config.rootAgentId, {
      agentId: config.rootAgentId,
      sessionId: config.rootSessionId,
      agentCapability: config.rootCapability,
      role: 'root-reviewer',
      delegationDepth: 0,
      tools: config.rootTools,
    })
  }

  get rootAgentId(): string {
    return this.config.rootAgentId
  }

  known(agentId: string): AgentIdentityRecord | undefined {
    return this.byAgentId.get(agentId)
  }

  /** 记录一次委派工具开始执行。 */
  beginDelegation(agentId: string, toolName: string, requestedRole?: string): void {
    const provider = DELEGATION_TOOLS[toolName]
    if (!provider) return
    this.delegating.push({ agentId, provider, requestedRole })
  }

  /** 委派工具结束。 */
  endDelegation(agentId: string, toolName: string): void {
    if (!DELEGATION_TOOLS[toolName]) return
    for (let index = this.delegating.length - 1; index >= 0; index--) {
      if (this.delegating[index]!.agentId === agentId) {
        this.delegating.splice(index, 1)
        return
      }
    }
  }

  /**
   * 解析一次调用的身份，必要时先注册。
   *
   * `harnessAgentId` 是 Harness 给的 session id。它等于 root id 时直接返回 root；否则
   * 视为子 Agent，用当前委派中的父 Agent 的 token 去注册。
   */
  async resolve(harnessAgentId: string | undefined): Promise<AgentIdentityRecord> {
    if (harnessAgentId === undefined || harnessAgentId === '') {
      // 没有 agent 上下文的工具调用不存在合法来源：agent loop 一定会设置它。
      throw new BrokerChannelError(
        'the tool call carries no agent context',
        'AGENT_IDENTITY_INVALID',
      )
    }
    if (
      harnessAgentId === this.config.rootAgentId ||
      harnessAgentId === this.config.rootSessionId ||
      harnessAgentId === this.rootAlias
    ) {
      return this.byAgentId.get(this.config.rootAgentId)!
    }
    const known = this.byAgentId.get(harnessAgentId)
    if (known) return known

    const inFlight = this.pending.get(harnessAgentId)
    if (inFlight) return inFlight

    const registration = this.register(harnessAgentId)
    this.pending.set(harnessAgentId, registration)
    try {
      return await registration
    } finally {
      this.pending.delete(harnessAgentId)
    }
  }

  private async register(harnessAgentId: string): Promise<AgentIdentityRecord> {
    // 第一来源：Harness 的权威会话头部。它对同步与异步委派同样成立。
    const resolvedByHeader = this.parentFromSessionHeader(harnessAgentId)
    const delegation = this.delegating[this.delegating.length - 1]

    if (resolvedByHeader) {
      // provider 头部里没有（它只说"是个 subagent"），所以能拿到时仍沿用委派栈上的
      // provider 与请求角色；拿不到时按最保守的 spawn/research 处理。
      return this.registerWithParent({
        harnessAgentId,
        parent: resolvedByHeader.parent,
        provider: delegation?.provider ?? 'spawn',
        requestedRole: delegation?.requestedRole,
        delegationDepth: resolvedByHeader.delegationDepth,
      })
    }

    if (!delegation) {
      // 没有进行中的委派却出现了新 Agent。只有一种合法解释：这是根 Agent 本身。
      //
      // ACP 的 `session/new` 由 agent 侧生成 session id，Worker 无从指定，所以根 Agent 的
      // Harness session id 不等于 Worker 派生的 rootSessionId。第一次见到它时把它认作 root
      // 的别名，此后 root 身份就有了稳定映射。
      //
      // 这个别名为什么不能被伪造：子 Agent 一定是在父 Agent 执行委派工具的过程中创建的
      // （契约把这些工具全部标成 mutating，policy 强制 mutationToolsSerial），所以"没有
      // 委派在进行"这个条件本身就排除了子 Agent。而别名只授予一次 —— 第二个来路不明的
      // Agent 仍然被拒绝，不会因为"看起来也像 root"而拿到 root 权限。
      if (this.rootAlias === null) {
        this.rootAlias = harnessAgentId
        return this.byAgentId.get(this.config.rootAgentId)!
      }
      // 要么是 policy 禁止的 out-of-process provider，要么是我们漏跟踪了一条创建路径。
      // 两种情况都必须 fail closed，而不是给它一个默认身份。
      throw new BrokerChannelError(
        'a new agent appeared without an in-flight delegation; refusing to grant it a capability',
        'AGENT_IDENTITY_INVALID',
      )
    }
    const parent = this.byAgentId.get(delegation.agentId)
    if (!parent) {
      throw new BrokerChannelError(
        'the delegating agent is not registered',
        'AGENT_IDENTITY_INVALID',
      )
    }

    return this.registerWithParent({
      harnessAgentId,
      parent,
      provider: delegation.provider,
      requestedRole: delegation.requestedRole,
      delegationDepth: parent.delegationDepth + 1,
    })
  }

  /**
   * 从 Harness 会话头部推出父 Agent。
   *
   * 只在头部明确声明 `origin === 'subagent'` 且 `parentSession` 指向一个**已注册**的 Agent 时
   * 才返回结果 —— 指向未知 session 时不做任何猜测，让调用方回落到时序推断或直接 fail closed。
   * 这样即使头部被意外污染，也不会凭空造出一条 lineage。
   */
  private parentFromSessionHeader(
    harnessAgentId: string,
  ): { parent: AgentIdentityRecord; delegationDepth: number } | null {
    const header = this.config.sessionHeader?.(harnessAgentId)
    if (!header || header.origin !== 'subagent') return null
    const parentSession = header.parentSession
    if (parentSession === undefined || parentSession === '') return null

    // 父可能是根 Agent（它在 Harness 侧的 session id 是 rootAlias），也可能是另一个子 Agent。
    const parentAgentId =
      parentSession === this.rootAlias ||
      parentSession === this.config.rootSessionId ||
      parentSession === this.config.rootAgentId
        ? this.config.rootAgentId
        : parentSession
    const parent = this.byAgentId.get(parentAgentId)
    if (!parent) return null

    const depth =
      typeof header.delegationDepth === 'number' && header.delegationDepth > 0
        ? header.delegationDepth
        : parent.delegationDepth + 1
    return { parent, delegationDepth: depth }
  }

  /** 向 Broker 注册一个子 Agent 并落地本地记录。 */
  private async registerWithParent(input: {
    harnessAgentId: string
    parent: AgentIdentityRecord
    provider: string
    requestedRole?: string
    delegationDepth: number
  }): Promise<AgentIdentityRecord> {
    const { harnessAgentId, parent } = input

    const response = await brokerPost<{
      accepted?: boolean
      code?: string
      reason?: string
      agentCapability?: string
      agentId?: string
      role?: string
      delegationDepth?: number
      tools?: string[]
    }>(this.config, '/attempt/register-agent', {
      taskId: this.config.taskId,
      agentAttempt: this.config.agentAttempt,
      agentCapability: parent.agentCapability,
      agentId: parent.agentId,
      sessionId: parent.sessionId,
      provider: input.provider,
      requestedRole: input.requestedRole,
      childAgentId: harnessAgentId,
      childSessionId: harnessAgentId,
      delegationDepth: input.delegationDepth,
    })

    if (response.status !== 200 || response.body?.accepted !== true) {
      throw new BrokerChannelError(
        response.body?.reason ?? 'the platform refused to register this agent',
        response.body?.code ?? 'AGENT_IDENTITY_INVALID',
        response.status,
      )
    }

    const record: AgentIdentityRecord = {
      agentId: harnessAgentId,
      sessionId: harnessAgentId,
      agentCapability: response.body.agentCapability!,
      role: response.body.role ?? 'research-child',
      delegationDepth: response.body.delegationDepth ?? input.delegationDepth,
      tools: response.body.tools ?? [],
    }
    this.byAgentId.set(record.agentId, record)
    return record
  }

  /** 通知 Broker 一个 Agent 已经结束。 */
  async finish(agentId: string, status: 'FINISHED' | 'FAILED' | 'CANCELLED'): Promise<void> {
    const record = this.byAgentId.get(agentId)
    if (!record) return
    await brokerPost(this.config, '/attempt/finish-agent', {
      taskId: this.config.taskId,
      agentAttempt: this.config.agentAttempt,
      agentCapability: record.agentCapability,
      agentId: record.agentId,
      sessionId: record.sessionId,
      status,
    }).catch((err: unknown) => {
      // 上报失败必须留痕：Broker 没记下终态时，数据库里这个节点会停在 RUNNING，而本地令牌
      // 已经删掉 —— 提交时 Worker 侧与 DB 侧算出的 tree_digest 就会不一致，表现为合法提交被
      // AGENT_IDENTITY_INVALID 误拒。吞掉它等于把一个可诊断的问题变成随机故障。
      const code = err instanceof BrokerChannelError ? err.code : 'UNKNOWN'
      process.stderr.write(
        `[agent-identity] finish-agent report failed: code=${code} agent=${agentId.slice(0, 8)} ` +
          `status=${status}\n`,
      )
    })
    // 令牌在 Broker 侧已被撤销，本地也删掉，避免后续调用拿到一个必然被拒的令牌。
    this.byAgentId.delete(agentId)
  }
}

/** 安装进程内身份表。重复安装同一份配置是幂等的。 */
export function installAgentIdentityRegistry(config: AgentRegistryConfig): AgentIdentityRegistry {
  if (registry === null) {
    registry = new AgentIdentityRegistry(config)
  }
  return registry
}

/** 取进程内身份表。未安装时抛错，而不是返回 null 让调用方各自兜底。 */
export function agentIdentityRegistry(): AgentIdentityRegistry {  if (registry === null) {
    throw new BrokerChannelError(
      'the agent identity registry has not been installed for this attempt',
      'AGENT_IDENTITY_INVALID',
    )
  }
  return registry
}

/** 仅供测试：重置模块级单例。 */
export function resetAgentIdentityRegistryForTests(): void {
  registry = null
}

/**
 * 解析调用者身份，失败时抛出**带原因**的错误。
 *
 * 三个平台工具插件（snapshot / submit / web）此前各自写
 * `resolve(...).catch(() => null)` 然后抛一句笼统的"没有可验证的身份"。原因被扔掉的后果是
 * 真实的：后台委派失败时，`usage-reporter` 同样吞掉了原因，于是"job 为什么 failed"完全无法
 * 诊断，直到把原因打出来才看到是 `AGENT_IDENTITY_INVALID`。身份解析失败是结构性问题，
 * 必须带着错误码往上走。
 *
 * 错误码与短消息不含源码、Prompt 或凭据，可以安全地交给模型看 —— 模型知道是身份问题而不是
 * 参数问题，才不会换着参数反复重试烧预算。
 */
export async function resolveCallerIdentity(
  harnessAgentId: string | undefined,
  subject: string,
): Promise<AgentIdentityRecord> {
  try {
    return await agentIdentityRegistry().resolve(harnessAgentId)
  } catch (err) {
    const code = err instanceof BrokerChannelError ? err.code : 'AGENT_IDENTITY_INVALID'
    const message = (err as { message?: string })?.message ?? String(err)
    throw new BrokerChannelError(
      `${subject} has no verifiable agent identity (${code}: ${message})`,
      code,
    )
  }
}
