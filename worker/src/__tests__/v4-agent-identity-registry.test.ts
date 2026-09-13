/**
 * WP1 验收：Harness 进程内的身份解析。
 *
 * 这是可信 lineage 的另一半。Broker 侧证明了"没有令牌就没有权限"；这里证明的是"子 Agent
 * 的令牌是怎么来的，以及它的父节点是怎么确定的"。
 *
 * 父节点的判据是：一个子 Agent 一定是在父 Agent 执行委派工具（subagent / subagent_fork /
 * workflow / ralph）的过程中被创建的。契约把这些工具全部标成 mutating，而 policy 强制
 * mutationToolsSerial，所以同一时刻最多只有一次委派在进行。这不是启发式，而是由并行策略
 * 保证的不变量 —— 所以"没有进行中的委派却出现了新 Agent"必须 fail closed，而不是给它一个
 * 默认身份。
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  AgentIdentityRegistry,
  DELEGATION_TOOLS,
  agentIdentityRegistry,
  installAgentIdentityRegistry,
  resetAgentIdentityRegistryForTests,
} from '../harness-plugins/shared/agent-identity.js'
import { withIdentity } from '../harness-plugins/shared/broker-client.js'

const ROOT_AGENT = 'root-abc'
const ROOT_SESSION = 'session-abc'
const ROOT_CAPABILITY = 'root-capability-token'
const ROOT_TOOLS = ['read_snapshot_code', 'subagent', 'workflow', 'submit_review_result']

interface FakeBroker {
  socketPath: string
  token: string
  requests: Array<{ path: string; body: Record<string, unknown> }>
  /** 下一次 register-agent 的响应。 */
  respond: (body: Record<string, unknown>) => void
  status: (code: number) => void
  close(): Promise<void>
}

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  resetAgentIdentityRegistryForTests()
  while (cleanups.length > 0) {
    await cleanups.pop()!()
  }
})

async function startFakeBroker(): Promise<FakeBroker> {
  const socketRoot = mkdtempSync(join(tmpdir(), 'crp-identity-'))
  const socketPath = join(socketRoot, `${randomUUID().slice(0, 8)}.sock`)
  const token = 'attempt-token'
  const requests: FakeBroker['requests'] = []
  let responseBody: Record<string, unknown> = {
    accepted: true,
    agentCapability: 'child-capability',
    agentId: 'child-1',
    role: 'research-child',
    delegationDepth: 1,
    tools: ['read_snapshot_code'],
  }
  let responseStatus = 200

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      requests.push({
        path: req.url ?? '',
        body: raw.length > 0 ? (JSON.parse(raw) as Record<string, unknown>) : {},
      })
      const payload = JSON.stringify(responseBody)
      res.writeHead(responseStatus, { 'content-type': 'application/json' })
      res.end(payload)
    })
  })
  await new Promise<void>((resolve) => server.listen(socketPath, () => resolve()))

  const broker: FakeBroker = {
    socketPath,
    token,
    requests,
    respond: (body) => {
      responseBody = body
    },
    status: (code) => {
      responseStatus = code
    },
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      rmSync(socketRoot, { recursive: true, force: true })
    },
  }
  cleanups.push(() => broker.close())
  return broker
}

function registryFor(
  broker: FakeBroker,
  sessionHeader?: AgentRegistryConfigHeaderLookup,
): AgentIdentityRegistry {
  return new AgentIdentityRegistry({
    ...(sessionHeader ? { sessionHeader } : {}),
    socketPath: broker.socketPath,
    token: broker.token,
    timeoutMs: 3000,
    taskId: 'task-1',
    agentAttempt: 1,
    rootAgentId: ROOT_AGENT,
    rootSessionId: ROOT_SESSION,
    rootCapability: ROOT_CAPABILITY,
    rootTools: ROOT_TOOLS,
  })
}

describe('DELEGATION_TOOLS', () => {
  it('maps every tool that can create a child to its provider', () => {
    // 漏掉一个就意味着那条路径创建的子 Agent 找不到父节点，会被 fail closed 拒绝。
    expect(DELEGATION_TOOLS).toEqual({
      subagent: 'spawn',
      subagent_fork: 'fork',
      workflow: 'workflow',
      ralph: 'ralph',
    })
  })
})

describe('AgentIdentityRegistry root resolution', () => {
  it('resolves the root by agent id or by session id without a broker round trip', async () => {
    const broker = await startFakeBroker()
    const registry = registryFor(broker)

    const byAgentId = await registry.resolve(ROOT_AGENT)
    expect(byAgentId.agentCapability).toBe(ROOT_CAPABILITY)
    expect(byAgentId.role).toBe('root-reviewer')
    expect(byAgentId.tools).toEqual(ROOT_TOOLS)

    // Worker 指定 ACP session id，所以 Harness 报出的 session id 与 rootSessionId 相等；
    // 这次比较是精确的，不是猜测。
    const bySessionId = await registry.resolve(ROOT_SESSION)
    expect(bySessionId.agentId).toBe(ROOT_AGENT)
    expect(broker.requests).toHaveLength(0)
  })

  it('refuses a call with no agent context', async () => {
    const broker = await startFakeBroker()
    const registry = registryFor(broker)
    // agent loop 一定会设置 agent 上下文；缺失说明这不是一次合法的工具调用。
    await expect(registry.resolve(undefined)).rejects.toMatchObject({
      code: 'AGENT_IDENTITY_INVALID',
    })
    await expect(registry.resolve('')).rejects.toMatchObject({ code: 'AGENT_IDENTITY_INVALID' })
  })
})

describe('AgentIdentityRegistry child registration', () => {
  it('adopts the first agent seen without a delegation as the root alias, exactly once', async () => {
    const broker = await startFakeBroker()
    const registry = registryFor(broker)

    // `session/new` 由 agent 侧生成 session id，Worker 无从指定，所以根 Agent 的 Harness
    // session id 不等于 Worker 派生的 rootSessionId。第一次见到它时认作 root 的别名。
    //
    // 这为什么不能被伪造：子 Agent 一定是在父 Agent 执行委派工具的过程中创建的，所以
    // "没有委派在进行"本身就排除了子 Agent。
    const aliased = await registry.resolve('acp-generated-session-id')
    expect(aliased.agentId).toBe(ROOT_AGENT)
    expect(aliased.agentCapability).toBe(ROOT_CAPABILITY)
    expect(broker.requests).toHaveLength(0)

    // 别名只授予一次：第二个来路不明的 Agent 仍然被拒绝，不会因为"看起来也像 root"
    // 而拿到 root 权限。
    await expect(registry.resolve('second-mystery-agent')).rejects.toMatchObject({
      code: 'AGENT_IDENTITY_INVALID',
    })
    expect(broker.requests).toHaveLength(0)
  })

  it('keeps resolving the root through its alias on later calls', async () => {
    const broker = await startFakeBroker()
    const registry = registryFor(broker)
    const first = await registry.resolve('acp-generated-session-id')
    const second = await registry.resolve('acp-generated-session-id')
    expect(second).toBe(first)
    expect(broker.requests).toHaveLength(0)
  })

  it('registers a spawn child under the delegating parent', async () => {
    const broker = await startFakeBroker()
    const registry = registryFor(broker)
    registry.beginDelegation(ROOT_AGENT, 'subagent')

    const child = await registry.resolve('child-1')
    expect(child.agentCapability).toBe('child-capability')
    expect(child.role).toBe('research-child')
    expect(child.delegationDepth).toBe(1)

    expect(broker.requests).toHaveLength(1)
    const body = broker.requests[0]!.body
    expect(broker.requests[0]!.path).toBe('/attempt/register-agent')
    // 注册出示的是父的令牌，不是子的（子还没有令牌）。
    expect(body.agentCapability).toBe(ROOT_CAPABILITY)
    expect(body.agentId).toBe(ROOT_AGENT)
    expect(body.provider).toBe('spawn')
    expect(body.childAgentId).toBe('child-1')
    expect(body.delegationDepth).toBe(1)
  })

  it('reports the provider that matches the delegation tool', async () => {
    for (const [tool, provider] of Object.entries(DELEGATION_TOOLS)) {
      resetAgentIdentityRegistryForTests()
      const broker = await startFakeBroker()
      const registry = registryFor(broker)
      registry.beginDelegation(ROOT_AGENT, tool)
      await registry.resolve(`child-${provider}`)
      expect(broker.requests[0]!.body.provider).toBe(provider)
    }
  })

  it('forwards an explicit role request for the platform to validate', async () => {
    const broker = await startFakeBroker()
    const registry = registryFor(broker)
    registry.beginDelegation(ROOT_AGENT, 'subagent', 'implementation-child')
    await registry.resolve('child-1')
    // 角色请求只是"请求"：Broker 会按 provider 的允许集合再校验一次。
    expect(broker.requests[0]!.body.requestedRole).toBe('implementation-child')
  })

  it('caches the child so later calls need no round trip', async () => {
    const broker = await startFakeBroker()
    const registry = registryFor(broker)
    registry.beginDelegation(ROOT_AGENT, 'subagent')
    await registry.resolve('child-1')
    await registry.resolve('child-1')
    await registry.resolve('child-1')
    expect(broker.requests).toHaveLength(1)
    expect(registry.known('child-1')?.agentCapability).toBe('child-capability')
  })

  it('shares one registration between concurrent first calls', async () => {
    const broker = await startFakeBroker()
    const registry = registryFor(broker)
    registry.beginDelegation(ROOT_AGENT, 'subagent')
    // 一个子 Agent 的多个并行工具调用不应当注册多次。
    const [a, b, c] = await Promise.all([
      registry.resolve('child-1'),
      registry.resolve('child-1'),
      registry.resolve('child-1'),
    ])
    expect(broker.requests).toHaveLength(1)
    expect(a.agentCapability).toBe(b.agentCapability)
    expect(b.agentCapability).toBe(c.agentCapability)
  })

  it('propagates a platform refusal instead of inventing an identity', async () => {
    const broker = await startFakeBroker()
    broker.status(403)
    broker.respond({ accepted: false, code: 'AGENT_TREE_LIMIT_EXCEEDED', reason: 'too many agents' })
    const registry = registryFor(broker)
    registry.beginDelegation(ROOT_AGENT, 'subagent')
    await expect(registry.resolve('child-1')).rejects.toMatchObject({
      code: 'AGENT_TREE_LIMIT_EXCEEDED',
    })
    expect(registry.known('child-1')).toBeUndefined()
  })

  it('refuses when the delegating parent is not itself registered', async () => {
    const broker = await startFakeBroker()
    const registry = registryFor(broker)
    // 一个未注册的 Agent 声称正在委派：它自己都没有身份，不能给别人签发。
    // 这里有委派在进行，所以走不到 root 别名那条分支。
    registry.beginDelegation('ghost-parent', 'subagent')
    await expect(registry.resolve('child-1')).rejects.toMatchObject({
      code: 'AGENT_IDENTITY_INVALID',
    })
  })

  it('stops attributing new agents once the delegation ends', async () => {
    const broker = await startFakeBroker()
    const registry = registryFor(broker)
    // 先把 root 别名用掉，这样后面的拒绝一定来自"没有可信父节点"，而不是别名认领。
    await registry.resolve('acp-generated-session-id')
    registry.beginDelegation(ROOT_AGENT, 'subagent')
    await registry.resolve('child-1')
    registry.endDelegation(ROOT_AGENT, 'subagent')
    // 委派已经结束：此后出现的新 Agent 没有可信父节点。
    await expect(registry.resolve('child-2')).rejects.toMatchObject({
      code: 'AGENT_IDENTITY_INVALID',
    })
  })

  it('ignores begin/end for tools that cannot create children', async () => {
    const broker = await startFakeBroker()
    const registry = registryFor(broker)
    // 先用掉 root 别名，隔离出"非委派工具不会开启委派"这一条。
    await registry.resolve('acp-generated-session-id')
    registry.beginDelegation(ROOT_AGENT, 'read_snapshot_code')
    await expect(registry.resolve('child-1')).rejects.toMatchObject({
      code: 'AGENT_IDENTITY_INVALID',
    })
    // endDelegation 对非委派工具同样是 no-op，不会误清掉真正在进行的委派。
    registry.beginDelegation(ROOT_AGENT, 'subagent')
    registry.endDelegation(ROOT_AGENT, 'read_snapshot_code')
    const child = await registry.resolve('child-1')
    expect(child.agentCapability).toBe('child-capability')
  })

  it('supports a nested delegation stack even though the policy serializes mutations', async () => {
    const broker = await startFakeBroker()
    const registry = registryFor(broker)
    registry.beginDelegation(ROOT_AGENT, 'workflow')
    broker.respond({
      accepted: true,
      agentCapability: 'wf-capability',
      agentId: 'wf-1',
      role: 'workflow-child',
      delegationDepth: 1,
      tools: ['read_snapshot_code', 'subagent'],
    })
    const workflowChild = await registry.resolve('wf-1')
    expect(workflowChild.role).toBe('workflow-child')

    // workflow child 再委派：栈顶变成它，所以新 Agent 归它而不是 root。
    registry.beginDelegation('wf-1', 'subagent')
    broker.respond({
      accepted: true,
      agentCapability: 'nested-capability',
      agentId: 'nested-1',
      role: 'research-child',
      delegationDepth: 2,
      tools: ['read_snapshot_code'],
    })
    await registry.resolve('nested-1')
    const last = broker.requests[broker.requests.length - 1]!.body
    expect(last.agentId).toBe('wf-1')
    expect(last.agentCapability).toBe('wf-capability')
    expect(last.delegationDepth).toBe(2)
  })

  it('drops a local capability once the agent finishes', async () => {
    const broker = await startFakeBroker()
    const registry = registryFor(broker)
    registry.beginDelegation(ROOT_AGENT, 'subagent')
    await registry.resolve('child-1')
    await registry.finish('child-1', 'FINISHED')
    expect(broker.requests.some((entry) => entry.path === '/attempt/finish-agent')).toBe(true)
    // 本地也删掉：否则后续调用会拿到一个必然被拒的令牌，错误信息会指向错误的原因。
    expect(registry.known('child-1')).toBeUndefined()
  })

  it('ignores finish for an agent it does not know', async () => {
    const broker = await startFakeBroker()
    const registry = registryFor(broker)
    await registry.finish('never-registered', 'FINISHED')
    expect(broker.requests).toHaveLength(0)
  })
})

describe('module-level registry installation', () => {
  it('throws before installation instead of returning null', () => {
    // 返回 null 会让每个插件各自兜底，而"兜底"在这里只能是猜一个身份。
    expect(() => agentIdentityRegistry()).toThrow(/has not been installed/)
  })

  it('is idempotent so all three platform plugins share one identity table', async () => {
    const broker = await startFakeBroker()
    const config = {
      socketPath: broker.socketPath,
      token: broker.token,
      taskId: 'task-1',
      agentAttempt: 1,
      rootAgentId: ROOT_AGENT,
      rootSessionId: ROOT_SESSION,
      rootCapability: ROOT_CAPABILITY,
      rootTools: ROOT_TOOLS,
    }
    const first = installAgentIdentityRegistry(config)
    const second = installAgentIdentityRegistry(config)
    expect(second).toBe(first)
    expect(agentIdentityRegistry()).toBe(first)

    // 一个插件注册的子 Agent，另一个插件必须看得见。
    first.beginDelegation(ROOT_AGENT, 'subagent')
    await agentIdentityRegistry().resolve('child-1')
    expect(first.known('child-1')).toBeDefined()
  })
})

describe('withIdentity envelope', () => {
  it('carries the attempt and the caller identity in one body', () => {
    const body = withIdentity(
      { taskId: 'task-1', agentAttempt: 2 },
      {
        agentCapability: 'cap',
        agentId: 'child-1',
        sessionId: 'session-1',
        toolCallId: 'call-9',
        toolName: 'read_snapshot_code',
      },
      { repository: 'kdmanage-backend' },
    )
    expect(body).toEqual({
      repository: 'kdmanage-backend',
      taskId: 'task-1',
      agentAttempt: 2,
      agentCapability: 'cap',
      agentId: 'child-1',
      sessionId: 'session-1',
      toolCallId: 'call-9',
      toolName: 'read_snapshot_code',
    })
  })

  it('defaults the optional call identifiers to null rather than omitting them', () => {
    const body = withIdentity(
      { taskId: 'task-1', agentAttempt: 1 },
      { agentCapability: 'cap', agentId: 'a', sessionId: 's' },
    )
    // 显式 null 让 Broker 侧不必区分"没报"和"报了 undefined"。
    expect(body.toolCallId).toBeNull()
    expect(body.toolName).toBeNull()
  })

  it('cannot be used to override the attempt envelope from the payload', () => {
    const body = withIdentity(
      { taskId: 'real-task', agentAttempt: 1 },
      { agentCapability: 'cap', agentId: 'a', sessionId: 's' },
      // 载荷里的 taskId 会被真实值覆盖：模型无法用它冒充别的 attempt。
      { taskId: 'forged-task', agentAttempt: 99 } as Record<string, unknown>,
    )
    expect(body.taskId).toBe('real-task')
    expect(body.agentAttempt).toBe(1)
  })
})

describe('delegation tracking under vi.useFakeTimers', () => {
  it('does not depend on wall-clock time', async () => {
    vi.useFakeTimers()
    try {
      const broker = await startFakeBroker()
      const registry = registryFor(broker)
      registry.beginDelegation(ROOT_AGENT, 'subagent')
      // 身份解析里没有任何超时/时间窗口逻辑：父节点由委派栈决定，不由时间决定。
      const promise = registry.resolve('child-1')
      await vi.advanceTimersByTimeAsync(0)
      await expect(promise).resolves.toBeDefined()
    } finally {
      vi.useRealTimers()
    }
  })
})

/** 会话头部查找函数的形状，与 AgentRegistryConfig.sessionHeader 一致。 */
type AgentRegistryConfigHeaderLookup = (
  sessionId: string,
) => { parentSession?: string; delegationDepth?: number; origin?: string } | undefined

describe('lineage 来自 Harness 会话头部（后台委派的回归）', () => {
  it('没有进行中的委派也能按会话头部认领父 Agent', async () => {
    // 这是后台委派的核心场景：`subagent` 带 run_in_background 时立即返回 job id，
    // post-execute 清掉委派标记之后子 Agent 才异步启动 —— 那一刻"当前正在委派的 Agent"
    // 已经不存在了。此前这条路必然抛 AGENT_IDENTITY_INVALID，表现为
    // `[usage-reporter] IDENTITY_UNRESOLVED`，子 Agent 的模型请求被拒、job 直接 failed。
    const broker = await startFakeBroker()
    const registry = registryFor(broker, (sessionId) =>
      sessionId === 'bg-child'
        ? { parentSession: ROOT_AGENT, delegationDepth: 1, origin: 'subagent' }
        : undefined,
    )

    // 刻意**不**调用 beginDelegation：模拟委派工具已经返回、标记已清的状态。
    const identity = await registry.resolve('bg-child')
    expect(identity.agentId).toBe('bg-child')

    const registration = broker.requests.find((r) => r.path === '/attempt/register-agent')
    expect(registration).toBeDefined()
    // 出示的必须是父（这里是 root）的令牌，深度取头部声明的值。
    expect(registration?.body.agentId).toBe(ROOT_AGENT)
    expect(registration?.body.delegationDepth).toBe(1)
  })

  it('头部指向未注册的 session 时不猜测，仍然 fail closed', async () => {
    // 头部被污染或父已结束时，不能凭空造一条 lineage —— 回落到时序推断，而当前没有委派，
    // 于是必须拒绝。
    const broker = await startFakeBroker()
    const registry = registryFor(broker, () => ({
      parentSession: 'nobody-knows-this-session',
      delegationDepth: 1,
      origin: 'subagent',
    }))
    // 第一个未知 Agent 会被认作 root 别名（这是既有的、只授予一次的行为）。
    await registry.resolve('first-unknown')
    // 第二个就必须被拒绝：头部指向未注册的父，时序栈上也没有委派。
    await expect(registry.resolve('second-unknown')).rejects.toThrow(
      /without an in-flight delegation/,
    )
  })

  it('头部不声明 origin=subagent 时不参与认领', async () => {
    // 只有 Harness 明确标记为 subagent 的会话才允许按头部认领父，避免把普通会话误认成子 Agent。
    const broker = await startFakeBroker()
    const registry = registryFor(broker, () => ({
      parentSession: ROOT_AGENT,
      delegationDepth: 1,
      // origin 缺失
    }))
    await registry.resolve('alias-claim')
    await expect(registry.resolve('another-unknown')).rejects.toThrow(
      /without an in-flight delegation/,
    )
  })
})
