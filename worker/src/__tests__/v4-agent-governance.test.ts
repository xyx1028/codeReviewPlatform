/**
 * WP1 / WP5 / WP7 验收：Agent 身份与授权、分层预算、Agent Tree 收敛。
 *
 * 对应第 10 节矩阵的 "Spawn/Fork"、"Submit"、"Budget"、"Cancel" 四行。最关键的一条是：
 * 子 Agent 即使伪造 root id 也无法提交 —— 因为 Broker 只按 capability token 查身份，而
 * 子 Agent 拿不到 root 的令牌。
 */

import { describe, expect, it, vi } from 'vitest'
import {
  AgentAuthorityLedger,
  defaultRoleForProvider,
  mintRootIdentity,
  type AgentIdentity,
} from '../ai/control/agent-authority-ledger.js'
import {
  AttemptTreeController,
  type AttemptEndReason,
} from '../ai/control/attempt-tree-controller.js'
import { HierarchicalBudgetLedger } from '../ai/control/hierarchical-budget-ledger.js'
import {
  normalizeCapabilityPolicy,
  SUBMIT_TOOL_NAME,
  V4_DEFAULT_POLICY,
  type V4CapabilityPolicy,
} from '../ai/policy/v4-capability-policy.js'
import { V4_ERROR_CODES, V4GovernanceError } from '../ai/policy/v4-errors.js'
import { rootLogger } from '../logger.js'

const logger = rootLogger.child({ test: 'v4-agent-governance' })

function policy(overrides: Record<string, unknown> = {}): V4CapabilityPolicy {
  return normalizeCapabilityPolicy({
    agents: { maxAgentsPerAttempt: 8, maxDelegationDepth: 2, maxConcurrentChildren: 4 },
    ...overrides,
  })
}

function ledgerFor(p: V4CapabilityPolicy = policy()): AgentAuthorityLedger {
  const identity = mintRootIdentity('task-1', 1)
  return new AgentAuthorityLedger({
    taskId: 'task-1',
    agentAttempt: 1,
    policy: p,
    rootAgentId: identity.rootAgentId,
    rootSessionId: identity.rootSessionId,
  })
}

async function spawnChild(
  ledger: AgentAuthorityLedger,
  input: { parentToken: string; agentId: string; provider?: 'spawn' | 'fork' | 'workflow' | 'ralph'; role?: string },
): Promise<{ token: string; identity: AgentIdentity }> {
  return ledger.registerChild({
    parentToken: input.parentToken,
    agentId: input.agentId,
    sessionId: `session-${input.agentId}`,
    provider: input.provider ?? 'spawn',
    requestedRole: input.role,
  })
}

describe('mintRootIdentity', () => {
  it('derives a stable identity from task and attempt', () => {
    // 稳定派生是 resume 能接回原会话的前提：随机 id 会让重启退化成"重新开始"。
    const a = mintRootIdentity('task-abc', 3)
    const b = mintRootIdentity('task-abc', 3)
    expect(a).toEqual(b)
    expect(mintRootIdentity('task-abc', 4)).not.toEqual(a)
    expect(mintRootIdentity('task-xyz', 3)).not.toEqual(a)
    expect(a.rootAgentId).toMatch(/^root-[0-9a-f]{32}$/)
    expect(a.rootSessionId).toMatch(/^session-[0-9a-f]{32}$/)
  })
})

describe('provider role defaults', () => {
  it('gives each provider its most conservative role by default', () => {
    // spawn 是新上下文的调查任务，fork 用于交叉审查：默认都是只读角色。
    expect(defaultRoleForProvider('spawn')).toBe('research-child')
    expect(defaultRoleForProvider('fork')).toBe('critic-child')
    expect(defaultRoleForProvider('workflow')).toBe('workflow-child')
    expect(defaultRoleForProvider('ralph')).toBe('research-child')
    expect(defaultRoleForProvider('root')).toBe('root-reviewer')
  })
})

describe('AgentAuthorityLedger root identity', () => {
  it('creates the root agent with the full policy tool surface', () => {
    const ledger = ledgerFor()
    const root = ledger.root
    expect(root.role).toBe('root-reviewer')
    expect(root.provider).toBe('root')
    expect(root.delegationDepth).toBe(0)
    expect(root.parentAgentId).toBeNull()
    expect(root.tools).toContain(SUBMIT_TOOL_NAME)
    expect(root.tools).toContain('bash')
    expect(root.tools).toContain('workflow')
    expect(root.capabilities.has('submitReview')).toBe(true)
    expect(ledger.rootCapabilityToken).toMatch(/^[A-Za-z0-9_-]{40,}$/)
  })

  it('authorizes the root for submit', () => {
    const ledger = ledgerFor()
    const authorized = ledger.authorize({
      token: ledger.rootCapabilityToken,
      capability: 'submitReview',
      claimedAgentId: ledger.root.agentId,
      toolName: SUBMIT_TOOL_NAME,
    })
    expect(authorized.identity.provider).toBe('root')
  })
})

describe('AgentAuthorityLedger lineage', () => {
  it('registers a child under the delegating parent and narrows its tools', async () => {
    const ledger = ledgerFor()
    const child = await spawnChild(ledger, {
      parentToken: ledger.rootCapabilityToken,
      agentId: 'child-1',
    })
    expect(child.identity.parentAgentId).toBe(ledger.root.agentId)
    expect(child.identity.delegationDepth).toBe(1)
    expect(child.identity.role).toBe('research-child')
    // 子权限只能缩小。
    expect(child.identity.tools).not.toContain(SUBMIT_TOOL_NAME)
    expect(child.identity.tools).not.toContain('bash')
    expect(child.identity.tools).toContain('read_snapshot_code')
    expect(child.identity.capabilities.has('submitReview')).toBe(false)
    expect(child.identity.capabilities.has('snapshotRead')).toBe(true)
    // 令牌各不相同。
    expect(child.token).not.toBe(ledger.rootCapabilityToken)
  })

  it('refuses a child whose parent token is unknown', async () => {
    const ledger = ledgerFor()
    await expect(
      spawnChild(ledger, { parentToken: 'forged-token', agentId: 'child-1' }),
    ).rejects.toMatchObject({ code: V4_ERROR_CODES.AGENT_IDENTITY_INVALID })
  })

  it('refuses a child of a finished parent', async () => {
    const ledger = ledgerFor()
    const child = await spawnChild(ledger, {
      parentToken: ledger.rootCapabilityToken,
      agentId: 'child-1',
    })
    ledger.finish('child-1', 'FINISHED')
    // 迟到的 spawn：父的 turn 已经交出去了。
    await expect(
      spawnChild(ledger, { parentToken: child.token, agentId: 'grandchild-1' }),
    ).rejects.toMatchObject({ code: V4_ERROR_CODES.AGENT_TREE_CANCELLED })
  })

  it('is idempotent for a repeated registration under the same parent', async () => {
    const ledger = ledgerFor()
    const first = await spawnChild(ledger, {
      parentToken: ledger.rootCapabilityToken,
      agentId: 'child-1',
    })
    const second = await spawnChild(ledger, {
      parentToken: ledger.rootCapabilityToken,
      agentId: 'child-1',
    })
    expect(second.token).toBe(first.token)
    expect(ledger.totalCount()).toBe(2)
  })

  it('refuses to re-home an existing agent under a different parent', async () => {
    const ledger = ledgerFor()
    const childA = await spawnChild(ledger, {
      parentToken: ledger.rootCapabilityToken,
      agentId: 'child-a',
    })
    await spawnChild(ledger, { parentToken: ledger.rootCapabilityToken, agentId: 'child-b' })
    // 重挂 lineage 会让 tree digest 失去意义。
    await expect(
      spawnChild(ledger, { parentToken: childA.token, agentId: 'child-b' }),
    ).rejects.toThrow(/already registered under a different parent/)
  })

  it('enforces the delegation depth limit', async () => {
    const ledger = ledgerFor(policy({ agents: { maxDelegationDepth: 1, maxAgentsPerAttempt: 8, maxConcurrentChildren: 4 } }))
    const child = await spawnChild(ledger, {
      parentToken: ledger.rootCapabilityToken,
      agentId: 'child-1',
    })
    await expect(
      spawnChild(ledger, { parentToken: child.token, agentId: 'grandchild-1' }),
    ).rejects.toMatchObject({ code: V4_ERROR_CODES.AGENT_TREE_LIMIT_EXCEEDED })
  })

  it('enforces the total agent limit', async () => {
    const ledger = ledgerFor(policy({ agents: { maxAgentsPerAttempt: 3, maxDelegationDepth: 2, maxConcurrentChildren: 4 } }))
    await spawnChild(ledger, { parentToken: ledger.rootCapabilityToken, agentId: 'c1' })
    await spawnChild(ledger, { parentToken: ledger.rootCapabilityToken, agentId: 'c2' })
    await expect(
      spawnChild(ledger, { parentToken: ledger.rootCapabilityToken, agentId: 'c3' }),
    ).rejects.toMatchObject({ code: V4_ERROR_CODES.AGENT_TREE_LIMIT_EXCEEDED })
  })

  it('enforces the concurrent children limit and frees a slot when one finishes', async () => {
    const ledger = ledgerFor(
      policy({ agents: { maxConcurrentChildren: 2, maxAgentsPerAttempt: 8, maxDelegationDepth: 2 } }),
    )
    await spawnChild(ledger, { parentToken: ledger.rootCapabilityToken, agentId: 'c1' })
    await spawnChild(ledger, { parentToken: ledger.rootCapabilityToken, agentId: 'c2' })
    await expect(
      spawnChild(ledger, { parentToken: ledger.rootCapabilityToken, agentId: 'c3' }),
    ).rejects.toMatchObject({ code: V4_ERROR_CODES.AGENT_TREE_LIMIT_EXCEEDED })
    // 并发上限约束的是"同时活着的"，不是"总共创建过的"。
    ledger.finish('c1', 'FINISHED')
    await expect(
      spawnChild(ledger, { parentToken: ledger.rootCapabilityToken, agentId: 'c3' }),
    ).resolves.toBeDefined()
  })

  it('refuses a role the provider may not run', async () => {
    const ledger = ledgerFor()
    // fork 只允许 critic/research：请求实现型角色是提权尝试。
    await expect(
      spawnChild(ledger, {
        parentToken: ledger.rootCapabilityToken,
        agentId: 'c1',
        provider: 'fork',
        role: 'implementation-child',
      }),
    ).rejects.toMatchObject({ code: V4_ERROR_CODES.AGENT_ROLE_DENIED })
  })

  it('lets the root request an implementation child through spawn', async () => {
    const ledger = ledgerFor()
    const child = await spawnChild(ledger, {
      parentToken: ledger.rootCapabilityToken,
      agentId: 'impl-1',
      provider: 'spawn',
      role: 'implementation-child',
    })
    expect(child.identity.role).toBe('implementation-child')
    expect(child.identity.tools).toContain('write')
    expect(child.identity.tools).toContain('bash')
    // 实现型子 Agent 默认无 Web，也永远不能提交。
    expect(child.identity.tools).not.toContain('web_fetch')
    expect(child.identity.tools).not.toContain(SUBMIT_TOOL_NAME)
  })

  it('refuses a self-reported depth that does not follow from the parent', async () => {
    const ledger = ledgerFor()
    await expect(
      ledger.registerChild({
        parentToken: ledger.rootCapabilityToken,
        agentId: 'c1',
        sessionId: 's1',
        provider: 'spawn',
        // 自报 depth 0 试图把自己变成"根级"Agent。
        delegationDepth: 0,
      }),
    ).rejects.toThrow(/does not follow from the registered parent/)
  })

  it('persists a node before handing out its token', async () => {
    const persisted: string[] = []
    const identity = mintRootIdentity('task-1', 1)
    const ledger = new AgentAuthorityLedger({
      taskId: 'task-1',
      agentAttempt: 1,
      policy: policy(),
      rootAgentId: identity.rootAgentId,
      rootSessionId: identity.rootSessionId,
      persistNode: async (node) => {
        persisted.push(node.agentId)
      },
    })
    await spawnChild(ledger, { parentToken: ledger.rootCapabilityToken, agentId: 'c1' })
    expect(persisted).toEqual(['c1'])
  })

  it('does not register the child when the database refuses the lineage', async () => {
    const identity = mintRootIdentity('task-1', 1)
    const ledger = new AgentAuthorityLedger({
      taskId: 'task-1',
      agentAttempt: 1,
      policy: policy(),
      rootAgentId: identity.rootAgentId,
      rootSessionId: identity.rootSessionId,
      // 数据库是可信 lineage 的最终仲裁：它拒绝就等于没注册成功。
      persistNode: async () => {
        throw new Error('AGENT_TREE_LIMIT_EXCEEDED')
      },
    })
    await expect(
      spawnChild(ledger, { parentToken: ledger.rootCapabilityToken, agentId: 'c1' }),
    ).rejects.toThrow(/AGENT_TREE_LIMIT_EXCEEDED/)
    expect(ledger.get('c1')).toBeUndefined()
    expect(ledger.totalCount()).toBe(1)
  })
})

describe('AgentAuthorityLedger authorization', () => {
  it('refuses a request with no capability', () => {
    const ledger = ledgerFor()
    expect(() => ledger.authorize({ token: undefined, capability: 'snapshotRead' })).toThrow(
      /carries no agent capability/,
    )
    expect(() => ledger.authorize({ token: '', capability: 'snapshotRead' })).toThrow(
      /carries no agent capability/,
    )
  })

  it('refuses an unknown capability token', () => {
    const ledger = ledgerFor()
    expect(() =>
      ledger.authorize({ token: 'a'.repeat(43), capability: 'snapshotRead' }),
    ).toThrow(/unknown or has been revoked/)
  })

  it('refuses a child that forges the root agent id', async () => {
    const ledger = ledgerFor()
    const child = await spawnChild(ledger, {
      parentToken: ledger.rootCapabilityToken,
      agentId: 'c1',
    })
    // 这是 WP1 的核心断言：伪造 id 无效，因为身份只按令牌查。
    expect(() =>
      ledger.authorize({
        token: child.token,
        capability: 'snapshotRead',
        claimedAgentId: ledger.root.agentId,
      }),
    ).toThrow(/does not match the presented capability/)
  })

  it('refuses a child that calls submit_review_result with SUBMIT_ROOT_ONLY', async () => {
    const ledger = ledgerFor()
    const child = await spawnChild(ledger, {
      parentToken: ledger.rootCapabilityToken,
      agentId: 'c1',
    })
    try {
      ledger.authorize({
        token: child.token,
        capability: 'submitReview',
        claimedAgentId: 'c1',
        toolName: SUBMIT_TOOL_NAME,
      })
      throw new Error('expected the submission to be refused')
    } catch (err) {
      expect((err as V4GovernanceError).code).toBe(V4_ERROR_CODES.SUBMIT_ROOT_ONLY)
      // 消息要告诉模型下一步做什么，而不只是"拒绝"。
      expect((err as Error).message).toMatch(/return your findings to your parent/)
    }
  })

  it('refuses a tool outside the role surface with AGENT_ROLE_DENIED', async () => {
    const ledger = ledgerFor()
    const child = await spawnChild(ledger, {
      parentToken: ledger.rootCapabilityToken,
      agentId: 'c1',
    })
    try {
      ledger.authorize({
        token: child.token,
        capability: 'artifactWrite',
        claimedAgentId: 'c1',
        toolName: 'bash',
      })
      throw new Error('expected the tool to be refused')
    } catch (err) {
      expect((err as V4GovernanceError).code).toBe(V4_ERROR_CODES.AGENT_ROLE_DENIED)
    }
  })

  it('refuses a capability the role does not hold even when the tool name is omitted', async () => {
    const ledger = ledgerFor()
    const child = await spawnChild(ledger, {
      parentToken: ledger.rootCapabilityToken,
      agentId: 'c1',
    })
    // 直接请求 Broker 而不声明工具名，同样过不去：能力面来自角色。
    expect(() =>
      ledger.authorize({ token: child.token, capability: 'submitReview', claimedAgentId: 'c1' }),
    ).toThrow(/does not hold the submitReview capability/)
  })

  it('refuses an agent that already reached a terminal state', async () => {
    const ledger = ledgerFor()
    const child = await spawnChild(ledger, {
      parentToken: ledger.rootCapabilityToken,
      agentId: 'c1',
    })
    ledger.finish('c1', 'FINISHED')
    expect(() =>
      ledger.authorize({ token: child.token, capability: 'snapshotRead', claimedAgentId: 'c1' }),
    ).toThrow(/terminal state/)
  })
})

describe('AgentAuthorityLedger cancellation and sealing', () => {
  it('cancels the tree child-first and revokes every token', async () => {
    const ledger = ledgerFor()
    const child = await spawnChild(ledger, {
      parentToken: ledger.rootCapabilityToken,
      agentId: 'c1',
    })
    const grandchild = await spawnChild(ledger, { parentToken: child.token, agentId: 'g1' })

    const cancelled = ledger.cancelTree('USER_CANCELLED')
    // child-first：最深的先被取消，否则会留下"父已失效、子仍在写"的窗口。
    expect(cancelled.map((identity) => identity.agentId)).toEqual([
      'g1',
      'c1',
      ledger.root.agentId,
    ])
    for (const token of [ledger.rootCapabilityToken, child.token, grandchild.token]) {
      expect(() => ledger.authorize({ token, capability: 'snapshotRead' })).toThrow()
    }
    expect(ledger.cancelledReason()).toBe('USER_CANCELLED')
  })

  it('refuses any further activity after cancellation', async () => {
    const ledger = ledgerFor()
    const rootToken = ledger.rootCapabilityToken
    ledger.cancelTree('LEASE_LOST')
    await expect(spawnChild(ledger, { parentToken: rootToken, agentId: 'c1' })).rejects.toMatchObject(
      { code: V4_ERROR_CODES.AGENT_TREE_CANCELLED },
    )
    expect(() => ledger.authorize({ token: rootToken, capability: 'snapshotRead' })).toThrow(
      /cancelled/,
    )
  })

  it('seals after a commit so late calls report ATTEMPT_ALREADY_SEALED', async () => {
    const ledger = ledgerFor()
    const rootToken = ledger.rootCapabilityToken
    await spawnChild(ledger, { parentToken: rootToken, agentId: 'c1' })
    ledger.seal()
    expect(ledger.isSealed()).toBe(true)
    try {
      ledger.authorize({ token: rootToken, capability: 'snapshotRead' })
      throw new Error('expected the sealed attempt to refuse the call')
    } catch (err) {
      expect((err as V4GovernanceError).code).toBe(V4_ERROR_CODES.ATTEMPT_ALREADY_SEALED)
    }
    // 封存把所有节点收成 FINISHED，而不是留下 RUNNING。
    expect(ledger.all().every((identity) => identity.status !== 'RUNNING')).toBe(true)
  })

  it('produces a tree digest that covers lineage and excludes tokens', async () => {
    const ledger = ledgerFor()
    const before = ledger.treeDigest()
    const child = await spawnChild(ledger, {
      parentToken: ledger.rootCapabilityToken,
      agentId: 'c1',
    })
    const after = ledger.treeDigest()
    expect(after).not.toBe(before)
    expect(after).toMatch(/^[0-9a-f]{64}$/)
    // 令牌绝不能出现在任何持久化的东西里。
    expect(after).not.toContain(child.token)
    expect(ledger.treeDigest()).toBe(after)
  })

  it('keeps the tree digest stable across status transitions', async () => {
    // 摘要**不能**随节点状态变化。曾经是随的，代价是一条真实的误拒路径：
    // 子 Agent 结束时的 `/attempt/finish-agent` 上报失败（或子 Agent 与提交并发结束）时，
    // 本地账本已 FINISHED、数据库仍 RUNNING，两侧摘要不等 → 一次完全合法的提交被
    // AGENT_IDENTITY_INVALID 拒掉，而且是在模型费用全部花完之后。
    //
    // 摘要要证明的是"这棵树就是注册过的那棵树"，状态对这个结论没有贡献；未注册的 Agent、
    // 被改过父节点的 Agent、角色或工具策略不符的 Agent 仍然会让摘要不匹配。
    const ledger = ledgerFor()
    await spawnChild(ledger, { parentToken: ledger.rootCapabilityToken, agentId: 'c1' })
    const running = ledger.treeDigest()

    ledger.finish('c1', 'FINISHED')
    expect(ledger.treeDigest()).toBe(running)

    // 失败与取消同样不改变摘要。
    const other = ledgerFor()
    await spawnChild(other, { parentToken: other.rootCapabilityToken, agentId: 'c1' })
    const baseline = other.treeDigest()
    other.finish('c1', 'FAILED')
    expect(other.treeDigest()).toBe(baseline)
  })

  it('still detects an unregistered or re-parented agent', async () => {
    // 去掉状态之后，摘要必须仍然对身份与血缘敏感 —— 否则这次修复就把安全性质一起去掉了。
    const a = ledgerFor()
    await spawnChild(a, { parentToken: a.rootCapabilityToken, agentId: 'c1' })
    const oneChild = a.treeDigest()

    // 多一个 Agent：摘要必须变（未注册的 Agent 参与过就会被发现）。
    const b = ledgerFor()
    await spawnChild(b, { parentToken: b.rootCapabilityToken, agentId: 'c1' })
    await spawnChild(b, { parentToken: b.rootCapabilityToken, agentId: 'c2' })
    expect(b.treeDigest()).not.toBe(oneChild)

    // 换个角色：摘要必须变（角色决定工具面，不能被静默替换）。
    const c = ledgerFor()
    await spawnChild(c, {
      parentToken: c.rootCapabilityToken,
      agentId: 'c1',
      role: 'critic-child',
    })
    expect(c.treeDigest()).not.toBe(oneChild)
  })

  it('tracks live count, children and the deepest delegation', async () => {
    const ledger = ledgerFor()
    const child = await spawnChild(ledger, {
      parentToken: ledger.rootCapabilityToken,
      agentId: 'c1',
    })
    await spawnChild(ledger, { parentToken: child.token, agentId: 'g1' })
    expect(ledger.liveCount()).toBe(3)
    expect(ledger.maxDepthReached()).toBe(2)
    expect(ledger.childrenIdsOf(ledger.root.agentId)).toEqual(['c1'])
    expect(ledger.childrenIdsOf('c1')).toEqual(['g1'])
    ledger.finish('g1', 'FINISHED')
    expect(ledger.liveCount()).toBe(2)
  })
})

describe('HierarchicalBudgetLedger', () => {
  function budgetFor(overrides: Record<string, number>): HierarchicalBudgetLedger {
    return new HierarchicalBudgetLedger({
      policy: normalizeCapabilityPolicy({ modelBudget: overrides }),
    })
  }

  it('admits requests and reports the remaining total', () => {
    const budget = budgetFor({ maxTotalRequests: 5, maxRootRequests: 5, maxChildRequests: 5 })
    const verdict = budget.reserve({ agentId: 'root', isRoot: true, kind: 'loop' })
    expect(verdict.allowed).toBe(true)
    expect(verdict.remaining).toBe(4)
    expect(budget.snapshot().total).toBe(1)
    expect(budget.snapshot().root).toBe(1)
  })

  it('enforces the total hard cap across root, children, retry and compaction', () => {
    const budget = budgetFor({
      maxTotalRequests: 4,
      maxRootRequests: 4,
      maxChildRequests: 4,
      maxRetryRequests: 4,
      maxCompactionRequests: 4,
    })
    expect(budget.reserve({ agentId: 'root', isRoot: true, kind: 'loop' }).allowed).toBe(true)
    expect(budget.reserve({ agentId: 'c1', isRoot: false, kind: 'loop' }).allowed).toBe(true)
    expect(budget.reserve({ agentId: 'root', isRoot: true, kind: 'retry' }).allowed).toBe(true)
    expect(budget.reserve({ agentId: 'root', isRoot: true, kind: 'compaction' }).allowed).toBe(true)
    const denied = budget.reserve({ agentId: 'c2', isRoot: false, kind: 'loop' })
    expect(denied.allowed).toBe(false)
    expect(denied.code).toBe(V4_ERROR_CODES.MODEL_BUDGET_EXHAUSTED)
    // 总量先撞上时报 total：运维一眼能看出是整体预算不够。
    expect(denied.scope).toBe('total')
  })

  it('rejects non-finite, fractional and non-positive reservation counts without poisoning counters', () => {
    const budget = budgetFor({ maxTotalRequests: 10, maxRootRequests: 10 })
    for (const count of [Number.NaN, Infinity, 1.5, 0, -1]) {
      const verdict = budget.reserve({ agentId: 'root', isRoot: true, kind: 'loop', count })
      expect(verdict.allowed).toBe(false)
      expect(verdict.code).toBe(V4_ERROR_CODES.MODEL_BUDGET_EXHAUSTED)
    }
    expect(budget.snapshot().total).toBe(0)
    expect(budget.snapshot().root).toBe(0)
    expect(budget.snapshot().denied).toBe(5)
    expect(budget.reserve({ agentId: 'root', isRoot: true, kind: 'loop' }).allowed).toBe(true)
  })

  it('counts the child budget per agent, not shared across siblings', () => {
    const budget = budgetFor({ maxTotalRequests: 100, maxChildRequests: 2, maxRootRequests: 100 })
    expect(budget.reserve({ agentId: 'c1', isRoot: false, kind: 'loop' }).allowed).toBe(true)
    expect(budget.reserve({ agentId: 'c1', isRoot: false, kind: 'loop' }).allowed).toBe(true)
    expect(budget.reserve({ agentId: 'c1', isRoot: false, kind: 'loop' }).scope).toBe('child')
    // 共享一份额度会让第一个子 Agent 把兄弟的用光，破坏并行分析。
    expect(budget.reserve({ agentId: 'c2', isRoot: false, kind: 'loop' }).allowed).toBe(true)
  })

  it('meters retry, compaction and ralph separately from the loop', () => {
    const budget = budgetFor({
      maxTotalRequests: 100,
      maxRetryRequests: 1,
      maxCompactionRequests: 1,
      maxRalphRounds: 1,
      maxRootRequests: 100,
    })
    expect(budget.reserve({ agentId: 'root', isRoot: true, kind: 'retry' }).allowed).toBe(true)
    expect(budget.reserve({ agentId: 'root', isRoot: true, kind: 'retry' }).scope).toBe('retry')
    expect(budget.reserve({ agentId: 'root', isRoot: true, kind: 'compaction' }).allowed).toBe(true)
    expect(budget.reserve({ agentId: 'root', isRoot: true, kind: 'compaction' }).scope).toBe(
      'compaction',
    )
    expect(budget.reserve({ agentId: 'root', isRoot: true, kind: 'ralph' }).allowed).toBe(true)
    expect(budget.reserve({ agentId: 'root', isRoot: true, kind: 'ralph' }).scope).toBe('ralph')
    const counters = budget.snapshot()
    expect(counters.retry).toBe(1)
    expect(counters.compaction).toBe(1)
    expect(counters.ralph).toBe(1)
    expect(counters.denied).toBe(3)
  })

  it('enforces the root budget separately from the child budget', () => {
    const budget = budgetFor({ maxTotalRequests: 100, maxRootRequests: 1, maxChildRequests: 5 })
    expect(budget.reserve({ agentId: 'root', isRoot: true, kind: 'loop' }).allowed).toBe(true)
    expect(budget.reserve({ agentId: 'root', isRoot: true, kind: 'loop' }).scope).toBe('root')
    expect(budget.reserve({ agentId: 'c1', isRoot: false, kind: 'loop' }).allowed).toBe(true)
  })

  it('keeps token usage null when the provider does not report it', () => {
    const budget = budgetFor({ maxTotalRequests: 10 })
    budget.reserve({ agentId: 'root', isRoot: true, kind: 'loop' })
    budget.observeTokens({ agentId: 'root', inputTokens: null, outputTokens: null })
    // null 表示"provider 不报 token"，与"用了 0 个"是两件不同的事。
    expect(budget.snapshot().inputTokens).toBeNull()
    expect(budget.snapshot().outputTokens).toBeNull()
    budget.observeTokens({ agentId: 'root', inputTokens: 100, outputTokens: 20 })
    budget.observeTokens({ agentId: 'root', inputTokens: 50, outputTokens: 5 })
    expect(budget.snapshot().inputTokens).toBe(150)
    expect(budget.snapshot().outputTokens).toBe(25)
  })

  it('ignores non-finite token reports', () => {
    const budget = budgetFor({ maxTotalRequests: 10 })
    budget.observeTokens({ agentId: 'root', inputTokens: Number.NaN, outputTokens: Infinity })
    expect(budget.snapshot().inputTokens).toBeNull()
    expect(budget.snapshot().outputTokens).toBeNull()
  })

  it('notifies the caller of every successful reservation', () => {
    const seen: Array<{ agentId: string; kind: string; count: number }> = []
    const budget = new HierarchicalBudgetLedger({
      policy: normalizeCapabilityPolicy({ modelBudget: { maxTotalRequests: 2 } }),
      onReserved: (input) => seen.push({ agentId: input.agentId, kind: input.kind, count: input.count }),
    })
    budget.reserve({ agentId: 'root', isRoot: true, kind: 'loop' })
    budget.reserve({ agentId: 'root', isRoot: true, kind: 'loop' })
    budget.reserve({ agentId: 'root', isRoot: true, kind: 'loop' })
    // 只有成功的预留会通知：被拒的请求根本没花额度。
    expect(seen).toHaveLength(2)
    expect(budget.remainingTotal()).toBe(0)
  })

  it('tracks per-agent counters for the UI', () => {
    const budget = budgetFor({ maxTotalRequests: 100, maxChildRequests: 50, maxRootRequests: 50 })
    budget.reserve({ agentId: 'root', isRoot: true, kind: 'loop' })
    budget.reserve({ agentId: 'c1', isRoot: false, kind: 'loop', count: 3 })
    expect(budget.snapshot().byAgent).toEqual({ root: 1, c1: 3 })
  })
})

describe('AttemptTreeController', () => {
  function controllerWith(
    input: {
      ledger?: AgentAuthorityLedger
      survivingPids?: number[]
      jobsCancelled?: number
    } = {},
  ): {
    controller: AttemptTreeController
    ledger: AgentAuthorityLedger
    terminal: Array<{ agentId: string; status: string }>
    fenced: AttemptEndReason[]
    workflowsCancelled: { count: number }
  } {
    const ledger = input.ledger ?? ledgerFor()
    const terminal: Array<{ agentId: string; status: string }> = []
    const fenced: AttemptEndReason[] = []
    const workflowsCancelled = { count: 0 }
    const controller = new AttemptTreeController({
      ledger,
      logger,
      markNodeTerminal: async (agentId, status) => {
        terminal.push({ agentId, status })
      },
      cancelWorkflows: async () => {
        workflowsCancelled.count++
      },
      jobs: { cancelJobsOf: async () => input.jobsCancelled ?? 0 },
      reaper: { reap: async () => input.survivingPids ?? [] },
      fence: async (reason) => {
        fenced.push(reason)
      },
    })
    return { controller, ledger, terminal, fenced, workflowsCancelled }
  }

  it('admits work until admission is closed', () => {
    const { controller } = controllerWith()
    expect(controller.admits).toBe(true)
    controller.closeAdmission('COMMITTED')
    expect(controller.admits).toBe(false)
  })

  it('seals rather than cancels after a successful commit', async () => {
    const { controller, ledger, terminal, fenced } = controllerWith()
    await spawnChild(ledger, { parentToken: ledger.rootCapabilityToken, agentId: 'c1' })
    const outcome = await controller.drain('COMMITTED')
    expect(outcome.reason).toBe('COMMITTED')
    // 提交成功后没必要强杀正在跑的 child，但它们再也不能影响结果。
    expect(outcome.cancelledAgents).toBe(0)
    expect(ledger.isSealed()).toBe(true)
    expect(terminal).toEqual([])
    expect(fenced).toEqual(['COMMITTED'])
  })

  it('cancels the whole tree and fences the database on cancellation', async () => {
    const { controller, ledger, terminal, fenced, workflowsCancelled } = controllerWith({
      jobsCancelled: 2,
    })
    const child = await spawnChild(ledger, {
      parentToken: ledger.rootCapabilityToken,
      agentId: 'c1',
    })
    await spawnChild(ledger, { parentToken: child.token, agentId: 'g1' })

    const outcome = await controller.drain('USER_CANCELLED')
    expect(outcome.cancelledAgents).toBe(3)
    // child-first 顺序也体现在数据库同步上。
    expect(terminal.map((entry) => entry.agentId)).toEqual(['g1', 'c1', ledger.root.agentId])
    expect(terminal.every((entry) => entry.status === 'CANCELLED')).toBe(true)
    expect(workflowsCancelled.count).toBe(1)
    // 每个 Agent 的 owner session 各 drain 一次 Job。
    expect(outcome.cancelledJobs).toBe(6)
    expect(fenced).toEqual(['USER_CANCELLED'])
    expect(outcome.cleanupFailed).toBe(false)
  })

  it('reports cleanupFailed when descendants survive the reap', async () => {
    const { controller } = controllerWith({ survivingPids: [4242] })
    const outcome = await controller.drain('WORKER_SHUTDOWN')
    // 对应 PROCESS_TREE_CLEANUP_FAILED：孤儿进程仍占 CPU 并持有 Workspace 句柄。
    expect(outcome.cleanupFailed).toBe(true)
    expect(outcome.survivingPids).toEqual([4242])
  })

  it('reports cleanupFailed when the reaper itself throws', async () => {
    const ledger = ledgerFor()
    const controller = new AttemptTreeController({
      ledger,
      logger,
      markNodeTerminal: null,
      cancelWorkflows: null,
      jobs: null,
      reaper: {
        reap: async () => {
          throw new Error('ps unavailable')
        },
      },
      fence: null,
    })
    const outcome = await controller.drain('ATTEMPT_FAILED')
    // 回收查询失败时不能报告"干净"。
    expect(outcome.cleanupFailed).toBe(true)
  })

  it('returns the same outcome for repeated drains', async () => {
    const { controller } = controllerWith()
    const first = await controller.drain('LEASE_LOST')
    const second = await controller.drain('USER_CANCELLED')
    expect(second).toBe(first)
    expect(second.reason).toBe('LEASE_LOST')
  })

  it('keeps converging when a database hook fails', async () => {
    const ledger = ledgerFor()
    await spawnChild(ledger, { parentToken: ledger.rootCapabilityToken, agentId: 'c1' })
    const reap = vi.fn(async () => [])
    const controller = new AttemptTreeController({
      ledger,
      logger,
      // 收敛不能因为一次网络抖动停下来。
      markNodeTerminal: async () => {
        throw new Error('network down')
      },
      cancelWorkflows: async () => {
        throw new Error('workflow holder gone')
      },
      jobs: {
        cancelJobsOf: async () => {
          throw new Error('jobs service gone')
        },
      },
      reaper: { reap },
      fence: async () => {
        throw new Error('fence failed')
      },
    })
    const outcome = await controller.drain('ATTEMPT_FAILED')
    expect(reap).toHaveBeenCalledOnce()
    expect(outcome.cancelledAgents).toBe(2)
    expect(outcome.cancelledJobs).toBe(0)
  })
})

describe('policy narrowing under emergency breakers', () => {
  it('drops shell and web from the root surface without losing submit', () => {
    const narrowed = normalizeCapabilityPolicy({
      capabilities: { shell: false, webSearch: false, webFetch: false, jobs: false },
      sandbox: { defaultMode: 'read-only' },
    })
    const identity = mintRootIdentity('task-1', 1)
    const ledger = new AgentAuthorityLedger({
      taskId: 'task-1',
      agentAttempt: 1,
      policy: narrowed,
      rootAgentId: identity.rootAgentId,
      rootSessionId: identity.rootSessionId,
    })
    const root = ledger.root
    expect(root.tools).not.toContain('bash')
    expect(root.tools).not.toContain('web_search')
    expect(root.tools).not.toContain('write')
    // 熔断不能让 attempt 变成无法收敛。
    expect(root.tools).toContain(SUBMIT_TOOL_NAME)
    expect(root.capabilities.has('webEgress')).toBe(false)
    expect(root.capabilities.has('submitReview')).toBe(true)
  })

  it('keeps the default policy fully enabled', () => {
    const identity = mintRootIdentity('task-1', 1)
    const ledger = new AgentAuthorityLedger({
      taskId: 'task-1',
      agentAttempt: 1,
      policy: V4_DEFAULT_POLICY,
      rootAgentId: identity.rootAgentId,
      rootSessionId: identity.rootSessionId,
    })
    for (const capability of ['snapshotRead', 'webEgress', 'artifactWrite', 'submitReview'] as const) {
      expect(ledger.root.capabilities.has(capability), capability).toBe(true)
    }
  })
})
