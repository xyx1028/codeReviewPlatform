/**
 * Broker 侧的运行监控插桩契约（方案 §7.2 / §7.3 / §7.5 / §7.7）。
 *
 * 这套用例守的是四件事：
 *
 *   1. 全部实时插桩通过**扩展现有路由的请求体**实现 —— 不新增 Broker 路由。新增一条路由
 *      会改变 manifest 哈希，而 factory.ts 会让新 Worker 拒绝所有旧哈希的在途任务，
 *      也就是部署必须先排空所有活动批次。
 *   2. `analysis_agent_run.tool_calls` 代表完整模型工具调用：platform 工具由执行路由计数，
 *      Harness-origin 工具由 lifecycle STARTED 计数；内部控制/观测路由不计且不得双计。
 *   3. 模型请求在 provider 不报 token 时同样有终态事件（token 保持 null）。
 *   4. 观测通道 fail open：reportRuntimeEvent 抛错不改变工具执行与授权结果。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  startAttemptControlBroker,
  type AttemptControlHandle,
} from '../ai/control/attempt-control-broker.js'
import {
  AgentAuthorityLedger,
  mintRootIdentity,
} from '../ai/control/agent-authority-ledger.js'
import { HierarchicalBudgetLedger } from '../ai/control/hierarchical-budget-ledger.js'
import {
  normalizeCapabilityPolicy,
  policyHash as hashPolicy,
} from '../ai/policy/v4-capability-policy.js'
import { Logger } from '../logger.js'
import type { SnapshotStore } from '../ai/snapshot/snapshot-store.js'
import type { RuntimeEvent } from '../monitoring/runtime-event-types.js'

const logger = new Logger({ minLevel: 'error', sink: () => undefined })
const TASK_ID = 'task-runtime-broker'
const ATTEMPT = 1

function fakeSnapshots(): SnapshotStore {
  return {
    pins: () => [
      { repository: 'kdmanage-backend', commitSha: 'a'.repeat(40), gitDir: '/nonexistent' },
    ],
    verifyPins: async () => undefined,
    search: async () => ({ hits: [], truncated: false, total: 0 }),
    findFiles: async () => ({
      repository: 'kdmanage-backend',
      paths: [],
      truncated: false,
      total: 0,
    }),
    commits: async () => [],
  } as unknown as SnapshotStore
}

interface Harness {
  broker: AttemptControlHandle
  authority: AgentAuthorityLedger
  events: RuntimeEvent[]
  post(
    route: string,
    body: Record<string, unknown>,
  ): Promise<{ status: number; body: Record<string, unknown> }>
}

let socketRoot = ''
let active: Harness | null = null

async function boot(options: { throwOnReport?: boolean } = {}): Promise<Harness> {
  const policy = normalizeCapabilityPolicy({
    agents: { maxAgentsPerAttempt: 8, maxDelegationDepth: 2, maxConcurrentChildren: 4 },
    modelBudget: { maxTotalRequests: 3, maxRootRequests: 3, maxChildRequests: 1 },
  })
  const identity = mintRootIdentity(TASK_ID, ATTEMPT)
  const authority = new AgentAuthorityLedger({
    taskId: TASK_ID,
    agentAttempt: ATTEMPT,
    policy,
    rootAgentId: identity.rootAgentId,
    rootSessionId: identity.rootSessionId,
  })
  const budget = new HierarchicalBudgetLedger({ policy })
  const events: RuntimeEvent[] = []

  const broker = await startAttemptControlBroker({
    taskId: TASK_ID,
    agentAttempt: ATTEMPT,
    sessionRevision: 1,
    snapshots: fakeSnapshots(),
    coveragePolicy: { requiredRepositories: ['kdmanage-backend'], minQueriesPerRepository: 0 },
    socketRoot,
    logger,
    policy,
    policyHash: hashPolicy(policy),
    authority,
    budget,
    commitReview: async () => ({ runId: 'run-1', committedAt: new Date().toISOString() }),
    isLeaseValid: () => true,
    flushAudit: async () => undefined,
    reportRuntimeEvent: (event) => {
      if (options.throwOnReport === true) throw new Error('reporter exploded')
      events.push(event)
    },
  })

  const post: Harness['post'] = (route, body) =>
    new Promise((resolve, reject) => {
      const payload = Buffer.from(JSON.stringify(body), 'utf8')
      const req = request(
        {
          socketPath: broker.socketPath,
          path: route,
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': String(payload.byteLength),
            authorization: `Bearer ${broker.token}`,
          },
        },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (chunk: Buffer) => chunks.push(chunk))
          res.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8')
            resolve({
              status: res.statusCode ?? 0,
              body: raw.length > 0 ? (JSON.parse(raw) as Record<string, unknown>) : {},
            })
          })
        },
      )
      req.on('error', reject)
      req.end(payload)
    })

  const harness: Harness = { broker, authority, events, post }
  active = harness
  return harness
}

function rootEnvelope(h: Harness, payload: Record<string, unknown> = {}) {
  return {
    ...payload,
    taskId: TASK_ID,
    agentAttempt: ATTEMPT,
    agentCapability: h.authority.rootCapabilityToken,
    agentId: h.authority.root.agentId,
    sessionId: h.authority.root.sessionId,
  }
}

beforeEach(() => {
  socketRoot = mkdtempSync(join(tmpdir(), 'crp-runtime-broker-'))
})

afterEach(async () => {
  await active?.broker.close().catch(() => undefined)
  active = null
  rmSync(socketRoot, { recursive: true, force: true })
})

describe('工具生命周期：/attempt/tool-audit 的 lifecycle 扩展', () => {
  it('STARTED 转投成 TOOL_CALL_STARTED，归属由令牌决定', async () => {
    const h = await boot()
    const response = await h.post(
      '/attempt/tool-audit',
      rootEnvelope(h, {
        toolName: 'bash',
        entries: [],
        lifecycle: {
          phase: 'STARTED',
          correlationId: 'corr-bash-1',
          toolName: 'bash',
          occurredAt: '2026-01-01T00:00:00.000Z',
        },
      }),
    )
    expect(response.status).toBe(200)

    const started = h.events.find((event) => event.type === 'TOOL_CALL_STARTED')
    expect(started).toBeDefined()
    expect((started as { correlationId?: string }).correlationId).toBe('corr-bash-1')
    // 归属永远由 capability 令牌决定的 identity 说了算，不由上报内容决定。
    expect((started as { agentId?: string }).agentId).toBe(h.authority.root.agentId)
    expect((started as { payload: { tool_name?: string } }).payload.tool_name).toBe('bash')
    expect((started as { payload: { agent_role?: string } }).payload.agent_role).toBe(
      'root-reviewer',
    )
  })

  it('覆盖 harness origin 工具：bash / read / edit / grep / web_search 都能产生 STARTED', async () => {
    const h = await boot()
    const harnessTools = ['bash', 'read', 'edit', 'grep', 'web_search']
    for (const toolName of harnessTools) {
      await h.post(
        '/attempt/tool-audit',
        rootEnvelope(h, {
          toolName,
          entries: [],
          lifecycle: {
            phase: 'STARTED',
            correlationId: `corr-${toolName}`,
            toolName,
          },
        }),
      )
    }
    const reported = h.events
      .filter((event) => event.type === 'TOOL_CALL_STARTED')
      .map((event) => (event as { payload: { tool_name?: string } }).payload.tool_name)
    // 这五个工具在 Harness 进程内执行，根本不经过 Broker dispatch。只有 tools/pre-execute
    // 这一层插桩能看到它们 —— 否则监控台只能显示 5 个平台快照工具。
    expect(reported).toEqual(harnessTools)
  })

  it('TERMINAL 按 outcome 分成 COMPLETED / FAILED / CANCELLED / DENIED', async () => {
    const h = await boot()
    const outcomes: Array<[string, string]> = [
      ['COMPLETED', 'TOOL_CALL_COMPLETED'],
      ['FAILED', 'TOOL_CALL_FAILED'],
      ['CANCELLED', 'TOOL_CALL_CANCELLED'],
      ['DENIED', 'TOOL_CALL_DENIED'],
    ]
    for (const [outcome] of outcomes) {
      await h.post(
        '/attempt/tool-audit',
        rootEnvelope(h, {
          toolName: 'bash',
          entries: [],
          lifecycle: {
            phase: 'TERMINAL',
            outcome,
            correlationId: `corr-${outcome}`,
            toolName: 'bash',
            durationMs: 1200,
            errorCode: 'TOOL_EXECUTION_FAILED',
            reasonCode: 'AGENT_ROLE_DENIED',
            exitCode: 3,
            outputBytes: 4096,
            truncated: true,
            hitCount: 0,
            lineSpan: 40,
          },
        }),
      )
    }
    for (const [, expected] of outcomes) {
      expect(h.events.some((event) => event.type === expected)).toBe(true)
    }
    const completed = h.events.find((event) => event.type === 'TOOL_CALL_COMPLETED') as
      | { payload: Record<string, unknown>; durationMs?: number }
      | undefined
    expect(completed?.durationMs).toBe(1200)
    // §6.5 的六个诊断扩展字段：全是整数/布尔，反推不出源码或凭据。
    expect(completed?.payload.exit_code).toBe(3)
    expect(completed?.payload.output_bytes).toBe(4096)
    expect(completed?.payload.truncated).toBe(true)
    expect(completed?.payload.hit_count).toBe(0)
    expect(completed?.payload.line_span).toBe(40)
  })

  it('缺 correlationId 或 toolName 的 lifecycle 被忽略，不产生半截事件', async () => {
    const h = await boot()
    await h.post(
      '/attempt/tool-audit',
      rootEnvelope(h, { entries: [], lifecycle: { phase: 'STARTED', toolName: 'bash' } }),
    )
    await h.post(
      '/attempt/tool-audit',
      rootEnvelope(h, { entries: [], lifecycle: { phase: 'STARTED', correlationId: 'c' } }),
    )
    expect(h.events).toHaveLength(0)
  })
})

describe('模型请求生命周期：reserve / report-usage 的 correlation 扩展', () => {
  it('verdict 通过时产生 MODEL_REQUEST_STARTED', async () => {
    const h = await boot()
    const response = await h.post(
      '/attempt/reserve-model-request',
      rootEnvelope(h, { kind: 'loop', count: 1, correlationId: 'corr-model-1', retryIndex: 0 }),
    )
    expect(response.status).toBe(200)
    expect(response.body.allowed).toBe(true)
    const started = h.events.find((event) => event.type === 'MODEL_REQUEST_STARTED')
    expect(started).toBeDefined()
    expect((started as { correlationId?: string }).correlationId).toBe('corr-model-1')
    expect(
      (started as { payload: { model_request_kind?: string } }).payload.model_request_kind,
    ).toBe('loop')
  })

  it('预算拒绝产生 MODEL_REQUEST_DENIED，provider 未被联系', async () => {
    const h = await boot()
    // 预算总量 3：第四次必然被拒。
    for (let index = 0; index < 3; index += 1) {
      await h.post(
        '/attempt/reserve-model-request',
        rootEnvelope(h, { kind: 'loop', count: 1, correlationId: `corr-ok-${String(index)}` }),
      )
    }
    const denied = await h.post(
      '/attempt/reserve-model-request',
      rootEnvelope(h, { kind: 'loop', count: 1, correlationId: 'corr-denied' }),
    )
    expect(denied.body.allowed).toBe(false)

    const event = h.events.find(
      (item) =>
        item.type === 'MODEL_REQUEST_DENIED' &&
        (item as { correlationId?: string }).correlationId === 'corr-denied',
    )
    expect(event).toBeDefined()
    expect((event as { payload: { permission_verdict?: string } }).payload.permission_verdict).toBe(
      'DENY',
    )
    // 被拒的 correlation 不会有 STARTED：provider 确实没有被联系。
    expect(
      h.events.some(
        (item) =>
          item.type === 'MODEL_REQUEST_STARTED' &&
          (item as { correlationId?: string }).correlationId === 'corr-denied',
      ),
    ).toBe(false)
  })

  it('provider 不报 token 时仍产生 MODEL_REQUEST_COMPLETED，token 保持 null', async () => {
    const h = await boot()
    await h.post(
      '/attempt/report-usage',
      rootEnvelope(h, {
        correlationId: 'corr-no-token',
        phase: 'TERMINAL',
        kind: 'loop',
        durationMs: 5000,
        failed: false,
      }),
    )
    const completed = h.events.find((event) => event.type === 'MODEL_REQUEST_COMPLETED') as
      | { payload: Record<string, unknown>; durationMs?: number }
      | undefined
    expect(completed).toBeDefined()
    expect(completed?.durationMs).toBe(5000)
    // null 与 0 是两件不同的事：0 会被当成"量到了但是零"。
    expect(completed?.payload.input_tokens).toBeNull()
    expect(completed?.payload.output_tokens).toBeNull()
  })

  it('failed = true 时产生 MODEL_REQUEST_FAILED', async () => {
    const h = await boot()
    await h.post(
      '/attempt/report-usage',
      rootEnvelope(h, {
        correlationId: 'corr-failed',
        phase: 'TERMINAL',
        kind: 'retry',
        durationMs: 900,
        retryIndex: 2,
        failed: true,
      }),
    )
    const failed = h.events.find((event) => event.type === 'MODEL_REQUEST_FAILED') as
      | { payload: Record<string, unknown> }
      | undefined
    expect(failed).toBeDefined()
    expect(failed?.payload.model_request_kind).toBe('retry')
    expect(failed?.payload.retry_index).toBe(2)
  })
})

describe('完整模型工具 usage 计数', () => {
  it('Harness lifecycle 计一次，观测上报与 model reservation 不额外计数', async () => {
    const h = await boot()
    const before = h.broker.usage()

    const lifecycle = { phase: 'STARTED', correlationId: 'corr-count', toolName: 'bash' }
    await h.post(
      '/attempt/tool-audit',
      rootEnvelope(h, { toolName: 'bash', entries: [], lifecycle }),
    )
    // 模拟同一 IPC payload 重放：correlation 去重后仍然只是一轮模型工具调用。
    await h.post(
      '/attempt/tool-audit',
      rootEnvelope(h, { toolName: 'bash', entries: [], lifecycle }),
    )
    await h.post(
      '/attempt/report-usage',
      rootEnvelope(h, { correlationId: 'corr-count', phase: 'TERMINAL', kind: 'loop' }),
    )
    await h.post(
      '/attempt/reserve-model-request',
      rootEnvelope(h, { correlationId: 'corr-model-count', kind: 'loop', count: 1 }),
    )

    const after = h.broker.usage()
    expect(after.toolCalls).toBe(before.toolCalls + 1)
    expect(after.modelRequests).toBe(before.modelRequests + 1)
    expect(after.toolCallsByName.bash).toBe(1)
    expect(after.toolCallsByName['tool-audit']).toBeUndefined()
    expect(after.toolCallsByName['report-usage']).toBeUndefined()
    expect(after.toolCallsByName['reserve-model-request']).toBeUndefined()
  })

  it('只把模型可见的 platform 执行路由计入 tool_calls', async () => {
    const h = await boot()
    const before = h.broker.usage()
    await h.post('/attempt/snapshot-pins', rootEnvelope(h, { toolName: 'read_snapshot_code' }))
    expect(h.broker.usage().toolCalls).toBe(before.toolCalls)

    await h.post(
      '/attempt/list-commits',
      rootEnvelope(h, { toolName: 'list_snapshot_commits', repository: 'kdmanage-backend' }),
    )
    const after = h.broker.usage()
    expect(after.toolCalls).toBe(before.toolCalls + 1)
    expect(after.toolCallsByName.list_snapshot_commits).toBe(1)
    expect(after.toolCallsByName['snapshot-pins']).toBeUndefined()
  })
})

describe('观测通道 fail open', () => {
  it('scopeCheck is authorization-only and never emits audit, event, or usage', async () => {
    const h = await boot()
    const beforeAudit = h.broker.pendingAudit()
    const response = await h.post(
      '/attempt/tool-audit',
      rootEnvelope(h, {
        toolName: 'read',
        scopeCheck: {
          toolName: 'read',
          arguments: { file_path: 'repos/sensitive/path.ts' },
        },
      }),
    )
    expect(response.body).toEqual({ allowed: true })
    expect(h.events).toHaveLength(0)
    expect(h.broker.pendingAudit()).toEqual(beforeAudit)
    expect(h.broker.usage().toolCalls).toBe(0)
  })

  it('reportRuntimeEvent 抛错不改变授权与工具结果', async () => {
    const h = await boot({ throwOnReport: true })
    const response = await h.post(
      '/attempt/reserve-model-request',
      rootEnvelope(h, { kind: 'loop', count: 1, correlationId: 'corr-explode' }),
    )
    // 监控失败不能放宽也不能收紧预算判定。
    expect(response.status).toBe(200)
    expect(response.body.allowed).toBe(true)

    const audit = await h.post(
      '/attempt/tool-audit',
      rootEnvelope(h, {
        toolName: 'bash',
        entries: [],
        lifecycle: { phase: 'STARTED', correlationId: 'corr-explode-2', toolName: 'bash' },
      }),
    )
    expect(audit.status).toBe(200)
  })

  it('未装配 reportRuntimeEvent 时 lifecycle 不发事件但仍计入 usage', async () => {
    const policy = normalizeCapabilityPolicy({})
    const identity = mintRootIdentity(TASK_ID, ATTEMPT)
    const authority = new AgentAuthorityLedger({
      taskId: TASK_ID,
      agentAttempt: ATTEMPT,
      policy,
      rootAgentId: identity.rootAgentId,
      rootSessionId: identity.rootSessionId,
    })
    const broker = await startAttemptControlBroker({
      taskId: TASK_ID,
      agentAttempt: ATTEMPT,
      sessionRevision: 1,
      snapshots: fakeSnapshots(),
      coveragePolicy: { requiredRepositories: ['kdmanage-backend'], minQueriesPerRepository: 0 },
      socketRoot,
      logger,
      policy,
      policyHash: hashPolicy(policy),
      authority,
      budget: new HierarchicalBudgetLedger({ policy }),
      commitReview: async () => ({ runId: 'r', committedAt: new Date().toISOString() }),
      isLeaseValid: () => true,
    })
    active = { broker, authority, events: [], post: async () => ({ status: 0, body: {} }) }

    const payload = Buffer.from(
      JSON.stringify({
        taskId: TASK_ID,
        agentAttempt: ATTEMPT,
        agentCapability: authority.rootCapabilityToken,
        agentId: authority.root.agentId,
        sessionId: authority.root.sessionId,
        toolName: 'bash',
        entries: [],
        lifecycle: { phase: 'STARTED', correlationId: 'corr-ignored', toolName: 'bash' },
      }),
      'utf8',
    )
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        {
          socketPath: broker.socketPath,
          path: '/attempt/tool-audit',
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': String(payload.byteLength),
            authorization: `Bearer ${broker.token}`,
          },
        },
        (res) => {
          res.resume()
          res.on('end', () => resolve(res.statusCode ?? 0))
        },
      )
      req.on('error', reject)
      req.end(payload)
    })
    expect(status).toBe(200)
    expect(broker.usage().toolCalls).toBe(1)
    expect(broker.usage().toolCallsByName.bash).toBe(1)
  })
})
