/**
 * RuntimeEventReporter 与归因 tracker 的行为契约（方案 §7.1 / §7.3 / §7.7 / §6.9.2）。
 *
 * 这些用例针对的是"为什么现有 analysis_tool_audit 无法表示正在调用"的每一条反推：
 * 定时 flush、同批折叠、按优先级丢弃、有界退避、幂等重试、权限被回收后静默，以及
 * 归因等式与 union/sum 的并行度语义。
 */

import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Logger } from '../logger.js'
import {
  NullRuntimeEventReporter,
  RuntimeEventReporter,
  buildRuntimeEventReporter,
} from '../monitoring/runtime-event-reporter.js'
import type {
  RuntimeEventBatchResult,
  RuntimeEventSink,
  RuntimeEventWire,
} from '../monitoring/runtime-event-types.js'
import {
  AttemptAttributionTracker,
  maxOverlap,
  mergeIntervalsMs,
} from '../monitoring/runtime-attribution.js'

const logger = new Logger({ minLevel: 'error', sink: () => undefined })

/**
 * 从 0032 迁移里解析 `analysis_agent_run_rollup` 的真实列名。
 *
 * 为什么读迁移文件而不是手写一张清单：方案 §13.1 要求 `attempt_rollup` 日志行的字段名
 * 与汇总表列名**逐字一致**，而手写清单只能在有人记得同步时成立。读文件让"给汇总表加了
 * 一列却忘了加进日志"这件事直接把测试跑红。
 */
function rollupColumnsFromMigration(): string[] {
  const migration = readFileSync(
    join(process.cwd(), 'supabase/migrations/0032_analysis_runtime_monitoring.sql'),
    'utf8',
  )
  const start = migration.indexOf('create table if not exists public.analysis_agent_run_rollup (')
  if (start < 0) throw new Error('rollup table DDL not found in 0032 migration')
  const open = migration.indexOf('(', start)

  // 按括号配平找到 DDL 结束位置，同时跳过块注释与行注释里的括号。
  let depth = 0
  let end = -1
  let index = open
  while (index < migration.length) {
    if (migration.startsWith('/*', index)) {
      index = migration.indexOf('*/', index) + 2
      continue
    }
    if (migration.startsWith('--', index)) {
      index = migration.indexOf('\n', index) + 1
      continue
    }
    const char = migration[index]
    if (char === '(') depth += 1
    else if (char === ')') {
      depth -= 1
      if (depth === 0) {
        end = index
        break
      }
    }
    index += 1
  }
  if (end < 0) throw new Error('unbalanced rollup table DDL')

  const body = migration
    .slice(open + 1, end)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/--[^\n]*/g, '')

  const columns: string[] = []
  let nesting = 0
  let buffer = ''
  for (const char of body) {
    if (char === '(') nesting += 1
    if (char === ')') nesting -= 1
    if (char === ',' && nesting === 0) {
      columns.push(buffer)
      buffer = ''
      continue
    }
    buffer += char
  }
  columns.push(buffer)

  return columns
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
    // 表级约束不是列。
    .filter((entry) => !/^(constraint|primary key|unique|check|foreign key)\b/i.test(entry))
    .map((entry) => /^[a-z_][a-z0-9_]*/.exec(entry)?.[0] ?? '')
    .filter((entry) => entry !== '')
}

interface RecordedBatch {
  events: RuntimeEventWire[]
  taskId?: string | null
  claimToken?: string | null
  agentAttempt?: number | null
  sessionRevision?: number | null
}

function fakeSink(options: {
  failTimes?: number
  error?: unknown
} = {}): { sink: RuntimeEventSink; batches: RecordedBatch[]; attempts: () => number } {
  const batches: RecordedBatch[] = []
  let calls = 0
  const sink: RuntimeEventSink = {
    reportRuntimeEventBatch: async (input) => {
      calls += 1
      if (options.failTimes !== undefined && calls <= options.failTimes) {
        throw options.error ?? new Error('database unreachable')
      }
      batches.push({
        events: input.events.map((event) => ({ ...event })),
        taskId: input.taskId,
        claimToken: input.claimToken,
        agentAttempt: input.agentAttempt,
        sessionRevision: input.sessionRevision,
      })
      const result: RuntimeEventBatchResult = {
        accepted: input.events.length,
        duplicated: 0,
        dropped_unresolved_agent: 0,
        dropped_invalid: 0,
        max_event_id: input.events.length,
      }
      return result
    },
  }
  return { sink, batches, attempts: () => calls }
}

function reporter(options: {
  sink: RuntimeEventSink
  queueMax?: number
  batchMax?: number
  now?: () => number
}): RuntimeEventReporter {
  return new RuntimeEventReporter({
    target: {
      workerId: 'worker-runtime-test',
      jobId: 'job-1',
      taskId: 'task-1',
      claimToken: 'claim-1',
      agentAttempt: 3,
      sessionRevision: 7,
    },
    sink: options.sink,
    logger,
    enabled: true,
    // 0 表示不装定时器：用例显式 flush，避免与真实时间赛跑。
    flushMs: 0,
    queueMax: options.queueMax ?? 512,
    batchMax: options.batchMax ?? 64,
    now: options.now,
    sleep: async () => undefined,
  })
}

describe('RuntimeEventReporter：折叠与批次语义', () => {
  it('同 flush 周期内闭合的工具只落一条带 collapsed 的 TERMINAL', async () => {
    const { sink, batches } = fakeSink()
    const r = reporter({ sink })
    const startedAt = new Date('2026-01-01T00:00:00.000Z')
    const finishedAt = new Date('2026-01-01T00:00:00.120Z')

    r.report({
      type: 'TOOL_CALL_STARTED',
      correlationId: 'corr-fast',
      agentId: 'agent-root',
      occurredAt: startedAt,
      payload: { tool_name: 'read' },
    })
    r.report({
      type: 'TOOL_CALL_COMPLETED',
      correlationId: 'corr-fast',
      agentId: 'agent-root',
      occurredAt: finishedAt,
      payload: { tool_name: 'read' },
    })
    await r.flush()

    expect(batches).toHaveLength(1)
    expect(batches[0]!.events).toHaveLength(1)
    const event = batches[0]!.events[0]!
    expect(event.event_type).toBe('TOOL_CALL_COMPLETED')
    expect(event.payload.collapsed).toBe(true)
    // 折叠后的 TERMINAL 以 STARTED 的时间为区间起点，duration 为实际耗时。
    expect(event.occurred_at).toBe(startedAt.toISOString())
    expect(event.duration_ms).toBe(120)
    expect(r.snapshot().collapsed).toBe(1)
  })

  it('TERMINAL 超出 flush 周期时落两条并按 correlation 配对', async () => {
    const { sink, batches } = fakeSink()
    const r = reporter({ sink })

    r.report({
      type: 'TOOL_CALL_STARTED',
      correlationId: 'corr-slow',
      agentId: 'agent-root',
      payload: { tool_name: 'bash' },
    })
    await r.flush()
    r.report({
      type: 'TOOL_CALL_COMPLETED',
      correlationId: 'corr-slow',
      agentId: 'agent-root',
      durationMs: 4200,
      payload: { tool_name: 'bash', duration_ms: 4200 },
    })
    await r.flush()

    expect(batches).toHaveLength(2)
    expect(batches[0]!.events[0]!.event_type).toBe('TOOL_CALL_STARTED')
    expect(batches[1]!.events[0]!.event_type).toBe('TOOL_CALL_COMPLETED')
    expect(batches[0]!.events[0]!.correlation_id).toBe('corr-slow')
    expect(batches[1]!.events[0]!.correlation_id).toBe('corr-slow')
    // 慢工具必须保留独立的 STARTED：它是"卡在哪"的唯一判据。
    expect(batches[0]!.events[0]!.payload.collapsed).toBeUndefined()
    expect(r.snapshot().collapsed).toBe(0)
  })

  it('fencing 上下文随每一批一起发送', async () => {
    const { sink, batches } = fakeSink()
    const r = reporter({ sink })
    r.report({ type: 'PINS_VERIFIED', payload: {} })
    await r.flush()
    expect(batches[0]!.taskId).toBe('task-1')
    expect(batches[0]!.claimToken).toBe('claim-1')
    expect(batches[0]!.agentAttempt).toBe(3)
    expect(batches[0]!.sessionRevision).toBe(7)
  })

  it('payload 只透传标量；对象与数组在入队时就被丢掉', async () => {
    const { sink, batches } = fakeSink()
    const r = reporter({ sink })
    r.report({
      type: 'TOOL_CALL_COMPLETED',
      correlationId: 'corr-scalars',
      agentId: 'agent-root',
      payload: {
        tool_name: 'grep',
        hit_count: 12,
        truncated: false,
        // @ts-expect-error 契约不允许，但运行时也必须挡住
        nested: { secret: 'sk-live' },
      },
    })
    await r.flush()
    const payload = batches[0]!.events[0]!.payload
    expect(payload.tool_name).toBe('grep')
    expect(payload.hit_count).toBe(12)
    expect(payload.truncated).toBe(false)
    expect(payload.nested).toBeUndefined()
  })
})

describe('RuntimeEventReporter：有界队列与丢弃优先级', () => {
  it('溢出时先丢已折叠的快工具，*_DENIED / ATTEMPT scope 永不丢弃', async () => {
    const { sink, batches } = fakeSink()
    const r = reporter({ sink, queueMax: 8, batchMax: 1000 })

    // 永不丢弃的两类。
    r.report({ type: 'PINS_VERIFIED', payload: {} })
    r.report({
      type: 'TOOL_CALL_DENIED',
      correlationId: 'corr-denied',
      agentId: 'agent-child',
      payload: {
        tool_name: 'submit_review_result',
        permission_verdict: 'DENY',
        reason_code: 'SUBMIT_ROOT_ONLY',
      },
    })
    r.report({
      type: 'MODEL_REQUEST_FAILED',
      correlationId: 'corr-model-failed',
      agentId: 'agent-root',
      payload: { model_request_kind: 'loop' },
    })
    // 高频可丢事件：已折叠的快工具 TERMINAL。
    for (let index = 0; index < 40; index += 1) {
      r.report({
        type: 'TOOL_CALL_COMPLETED',
        correlationId: `corr-fast-${String(index)}`,
        agentId: 'agent-root',
        payload: { tool_name: 'read', collapsed: true },
      })
    }

    await r.flush()
    const types = batches.flatMap((batch) => batch.events.map((event) => event.event_type))
    expect(types).toContain('PINS_VERIFIED')
    expect(types).toContain('TOOL_CALL_DENIED')
    expect(types).toContain('MODEL_REQUEST_FAILED')
    expect(r.snapshot().dropped).toBeGreaterThan(0)
  })
})

describe('RuntimeEventReporter：有界退避与幂等', () => {
  it('数据库短暂不可用后同一个 event_uuid 重试，不会产生第二个 uuid', async () => {
    const { sink, batches, attempts } = fakeSink({ failTimes: 2 })
    const r = reporter({ sink })
    r.report({ type: 'BROKER_READY', payload: {} })
    await r.flush()

    expect(attempts()).toBe(3)
    expect(batches).toHaveLength(1)
    expect(batches[0]!.events).toHaveLength(1)
    expect(r.snapshot().reported).toBe(1)
    expect(r.snapshot().flushFailures).toBe(0)
  })

  it('三次退避后仍失败则整批丢弃并计数，不无限重排队', async () => {
    const { sink, batches, attempts } = fakeSink({ failTimes: 99 })
    const r = reporter({ sink })
    r.report({ type: 'BROKER_READY', payload: {} })
    r.report({ type: 'WORKSPACE_READY', payload: {} })
    await r.flush()

    // 1 次首发 + 3 次退避重试。
    expect(attempts()).toBe(4)
    expect(batches).toHaveLength(0)
    expect(r.snapshot().flushFailures).toBe(1)
    expect(r.snapshot().dropped).toBe(2)
    // 队列没有被重排队：下一次 flush 不会再打数据库。
    await r.flush()
    expect(attempts()).toBe(4)
  })

  it('insufficient_privilege 触发静默模式，此后不再上报', async () => {
    const privilegeError = Object.assign(new Error('permission denied for function'), {
      code: '42501',
    })
    const { sink, attempts } = fakeSink({ failTimes: 99, error: privilegeError })
    const r = reporter({ sink })
    r.report({ type: 'BROKER_READY', payload: {} })
    await r.flush()

    // 权限被回收不是抖动：一次就进静默，不做三次退避。
    expect(attempts()).toBe(1)
    expect(r.snapshot().silenced).toBe(true)

    r.report({ type: 'PROFILE_FROZEN', payload: {} })
    await r.flush()
    expect(attempts()).toBe(1)
    expect(r.snapshot().queueDepth).toBe(0)
  })

  it('close() 尽力 flush 一次，之后 report 变成 no-op', async () => {
    const { sink, batches } = fakeSink()
    const r = reporter({ sink })
    r.report({ type: 'ACP_TURN_STARTED', payload: {} })
    await r.close()
    expect(batches).toHaveLength(1)

    r.report({ type: 'PROFILE_FROZEN', payload: {} })
    await r.flush()
    expect(batches).toHaveLength(1)
  })

  it('入队即使抛错也不影响调用方（fail open）', () => {
    const { sink } = fakeSink()
    const r = reporter({ sink })
    expect(() =>
      r.report({
        type: 'TOOL_CALL_STARTED',
        correlationId: 'corr-ok',
        agentId: 'agent-root',
        payload: { tool_name: 'read' },
      }),
    ).not.toThrow()
  })
})

describe('定时 flush', () => {
  it('不满一批也会按 flushMs 自动 flush', async () => {
    vi.useFakeTimers()
    try {
      const { sink, batches } = fakeSink()
      const r = new RuntimeEventReporter({
        target: { workerId: 'w', jobId: 'j', taskId: 't', claimToken: 'c', agentAttempt: 1 },
        sink,
        logger,
        enabled: true,
        flushMs: 800,
        sleep: async () => undefined,
      })
      r.report({ type: 'PINS_VERIFIED', payload: {} })
      expect(batches).toHaveLength(0)
      await vi.advanceTimersByTimeAsync(800)
      // 只按条数 flush 会重现 analysis_tool_audit 的问题：正在调用永远来不及被看见。
      expect(batches).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('关闭态', () => {
  it('RUNTIME_EVENTS_ENABLED=false 时装配出 NullRuntimeEventReporter', async () => {
    const { sink, batches } = fakeSink()
    const r = buildRuntimeEventReporter({
      settings: { enabled: false, flushMs: 800, queueMax: 512, batchMax: 64 },
      target: { workerId: 'w', jobId: 'j' },
      sink,
      logger,
    })
    expect(r).toBeInstanceOf(NullRuntimeEventReporter)
    expect(r.enabled).toBe(false)
    r.report({ type: 'PINS_VERIFIED', payload: {} })
    await r.flush()
    await r.close()
    expect(batches).toHaveLength(0)
    expect(r.snapshot().reported).toBe(0)
  })
})

describe('区间原语', () => {
  it('并集合并重叠区间', () => {
    expect(
      mergeIntervalsMs([
        { startMs: 0, endMs: 1000 },
        { startMs: 500, endMs: 1500 },
        { startMs: 3000, endMs: 3500 },
      ]),
    ).toBe(2000)
  })

  it('紧邻但不重叠不算并发', () => {
    expect(
      maxOverlap([
        { startMs: 0, endMs: 1000 },
        { startMs: 1000, endMs: 2000 },
      ]),
    ).toBe(1)
    expect(
      maxOverlap([
        { startMs: 0, endMs: 1000 },
        { startMs: 999, endMs: 2000 },
      ]),
    ).toBe(2)
  })
})

describe('AttemptAttributionTracker：墙钟归因', () => {
  const base = Date.parse('2026-01-01T00:00:00.000Z')
  const at = (seconds: number) => new Date(base + seconds * 1000)

  function trackedAttempt(): AttemptAttributionTracker {
    const tracker = new AttemptAttributionTracker(() => base)
    tracker.observeAttemptStarted(base)
    tracker.observe({ type: 'HARNESS_PROCESS_STARTED', occurredAt: at(30), payload: {} })
    tracker.observeAgentRegistered('agent-root', base + 30_000)
    tracker.observeAgentRegistered('agent-child', base + 55_000)

    // 两个 Agent 的工具区间重叠：60–120 与 90–150。
    tracker.observe({
      type: 'TOOL_CALL_STARTED',
      correlationId: 'T1',
      agentId: 'agent-root',
      occurredAt: at(60),
      payload: { tool_name: 'bash' },
    })
    tracker.observe({
      type: 'TOOL_CALL_STARTED',
      correlationId: 'T2',
      agentId: 'agent-child',
      occurredAt: at(90),
      payload: { tool_name: 'edit' },
    })
    tracker.observe({
      type: 'TOOL_CALL_COMPLETED',
      correlationId: 'T1',
      agentId: 'agent-root',
      occurredAt: at(120),
      durationMs: 60_000,
      payload: { tool_name: 'bash' },
    })
    tracker.observe({
      type: 'TOOL_CALL_COMPLETED',
      correlationId: 'T2',
      agentId: 'agent-child',
      occurredAt: at(150),
      durationMs: 60_000,
      payload: { tool_name: 'edit' },
    })
    // 模型请求 160–200。
    tracker.observe({
      type: 'MODEL_REQUEST_STARTED',
      correlationId: 'M1',
      agentId: 'agent-root',
      occurredAt: at(160),
      payload: { model_request_kind: 'loop' },
    })
    tracker.observe({
      type: 'MODEL_REQUEST_COMPLETED',
      correlationId: 'M1',
      agentId: 'agent-root',
      occurredAt: at(200),
      durationMs: 40_000,
      payload: { model_request_kind: 'loop' },
    })
    tracker.observeAgentTerminal('agent-child', base + 300_000)
    tracker.observeAgentTerminal('agent-root', base + 600_000)
    return tracker
  }

  function summarize(tracker: AttemptAttributionTracker) {
    return tracker.summarize({
      agent_run_id: 'run-1',
      task_id: 'task-1',
      job_id: 'job-1',
      batch_id: 'batch-1',
      agent_attempt: 2,
      worker_id: 'worker-1',
      terminal_status: 'COMMITTED',
      terminal_error_code: null,
      end_reason: null,
      resumed: false,
      resume_count: 0,
      fingerprint: {
        model_label: 'model / m',
        policy_hash: 'p',
        profile_config_hash: 'c',
        harness_version: 'h',
        capability_contract_hash: 'k',
        prompt_version: 'v1',
        policy_version: 4,
      },
      agent_count: 2,
      max_depth: 1,
      input_tokens: 1000,
      output_tokens: 200,
      evidence_count: null,
      artifact_count: 0,
      rejected_submissions: 0,
      reporter: {
        reported: 42,
        duplicated: 0,
        dropped: 0,
        droppedUnresolvedAgent: 0,
        droppedInvalid: 0,
        collapsed: 3,
        flushFailures: 0,
        queueDepth: 0,
        silenced: false,
        maxEventId: 99,
      },
      finishedAtMs: base + 600_000,
    })
  }

  it('sum 与 union 都存：sum 是总消耗，union 是真实占用的墙钟', () => {
    const rollup = summarize(trackedAttempt())
    expect(rollup.tool_ms_union).toBe(90_000)
    expect(rollup.tool_ms_sum).toBe(120_000)
    expect(rollup.tool_ms_sum).toBeGreaterThan(rollup.tool_ms_union)
    expect(rollup.model_ms_union).toBe(40_000)
    expect(rollup.busy_ms_union).toBe(130_000)
    expect(rollup.max_concurrent_tools).toBe(2)
    expect(rollup.max_concurrent_agents).toBe(2)
  })

  it('归因等式恒成立，且 unattributed 不被摊平', () => {
    const rollup = summarize(trackedAttempt())
    expect(rollup.wall_ms).toBe(600_000)
    expect(rollup.setup_ms).toBe(30_000)
    // teardown = 终态 − 最后一个 TERMINAL 事件（200s）。
    expect(rollup.teardown_ms).toBe(400_000)
    expect(
      rollup.setup_ms + rollup.busy_ms_union + rollup.teardown_ms + rollup.unattributed_ms,
    ).toBe(rollup.wall_ms)
    expect(rollup.unattributed_ms).toBe(40_000)
    expect(rollup.unattributed_pct).toBeCloseTo(6.67, 1)
    expect(rollup.busy_ms_union).toBeLessThanOrEqual(rollup.wall_ms)
  })

  it('字段名与 analysis_agent_run_rollup 的列名逐字一致（对照迁移文件，不靠手写清单）', () => {
    const rollup = summarize(trackedAttempt())
    const columns = rollupColumnsFromMigration()

    // §13.1 明确不进日志的列：per_agent 体积太大，三个时间戳由日志自己的 timestamp 覆盖。
    // 这个集合被断言成"恰好等于"差集，所以将来给汇总表加一列时，要么同步加到日志行，
    // 要么必须回到这里显式声明"这一列不进日志"——不会悄悄漂移。
    const intentionallyAbsent = new Set(['per_agent', 'started_at', 'finished_at', 'computed_at'])
    // 日志行独有的键：event 是 logger 约定，unattributed_pct 是从两列算出来的派生值。
    const logOnlyKeys = new Set(['event', 'unattributed_pct'])

    expect(columns.length).toBeGreaterThan(40)

    const recordKeys = new Set(Object.keys(rollup))
    const missing = columns.filter((column) => !recordKeys.has(column))
    expect(new Set(missing)).toEqual(intentionallyAbsent)

    const columnSet = new Set(columns)
    const extra = [...recordKeys].filter((key) => !columnSet.has(key))
    expect(new Set(extra)).toEqual(logOnlyKeys)

    expect(rollup.event).toBe('attempt_rollup')
    expect(rollup.events_reported).toBe(42)
    expect(rollup.events_dropped).toBe(0)
  })

  it('agent_idle_ms 计的是已注册未终态但没有未闭合 correlation 的时长', () => {
    const rollup = summarize(trackedAttempt())
    // root: 存活 30s→600s = 570s，忙 60–120 与 160–200 共 100s → 空转 470s。
    // child: 存活 55s→300s = 245s，忙 90–150 共 60s → 空转 185s。
    expect(rollup.agent_idle_ms).toBe(470_000 + 185_000)
  })

  it('折叠事件没有 STARTED 行，区间由 occurred_at + duration 重建', () => {
    const tracker = new AttemptAttributionTracker(() => base)
    tracker.observeAttemptStarted(base)
    tracker.observe({
      type: 'TOOL_CALL_COMPLETED',
      correlationId: 'collapsed-1',
      agentId: 'agent-root',
      occurredAt: at(10),
      durationMs: 500,
      payload: { tool_name: 'read', collapsed: true },
    })
    const rollup = summarize(tracker)
    expect(rollup.tool_ms_sum).toBe(500)
    expect(rollup.tool_ms_union).toBe(500)
    expect(rollup.tool_calls_by_name.read).toBe(1)
    expect(rollup.tool_calls).toBe(1)
  })

  it('统计模型请求分桶、拒绝与失败计数', () => {
    const tracker = new AttemptAttributionTracker(() => base)
    tracker.observeAttemptStarted(base)
    tracker.observe({
      type: 'MODEL_REQUEST_COMPLETED',
      correlationId: 'm-loop',
      agentId: 'a',
      occurredAt: at(1),
      durationMs: 100,
      payload: { model_request_kind: 'loop' },
    })
    tracker.observe({
      type: 'MODEL_REQUEST_COMPLETED',
      correlationId: 'm-retry',
      agentId: 'a',
      occurredAt: at(2),
      durationMs: 100,
      payload: { model_request_kind: 'retry' },
    })
    tracker.observe({
      type: 'MODEL_REQUEST_DENIED',
      correlationId: 'm-denied',
      agentId: 'a',
      occurredAt: at(3),
      errorCode: 'MODEL_BUDGET_EXHAUSTED',
      payload: { model_request_kind: 'loop', reason_code: 'MODEL_BUDGET_EXHAUSTED' },
    })
    tracker.observe({
      type: 'TOOL_CALL_FAILED',
      correlationId: 't-failed',
      agentId: 'a',
      occurredAt: at(4),
      durationMs: 10,
      errorCode: 'TOOL_EXECUTION_FAILED',
      payload: { tool_name: 'bash' },
    })
    tracker.observe({
      type: 'TOOL_CALL_DENIED',
      correlationId: 't-denied',
      agentId: 'a',
      occurredAt: at(5),
      payload: {
        tool_name: 'submit_review_result',
        permission_verdict: 'DENY',
        reason_code: 'SUBMIT_ROOT_ONLY',
      },
    })
    const rollup = summarize(tracker)
    expect(rollup.model_requests).toBe(2)
    expect(rollup.model_requests_by_kind).toEqual({ loop: 1, retry: 1 })
    expect(rollup.model_requests_denied).toBe(1)
    expect(rollup.tool_calls_failed).toBe(1)
    expect(rollup.tool_calls_denied).toBe(1)
  })

  it('未闭合的 correlation 数可查：它是插桩漏洞或进程被杀的直接证据', () => {
    const tracker = new AttemptAttributionTracker(() => base)
    tracker.observeAttemptStarted(base)
    tracker.observe({
      type: 'TOOL_CALL_STARTED',
      correlationId: 'orphan',
      agentId: 'a',
      occurredAt: at(1),
      payload: { tool_name: 'web_fetch' },
    })
    expect(tracker.openCorrelationCount()).toBe(1)
    tracker.observe({
      type: 'TOOL_CALL_CANCELLED',
      correlationId: 'orphan',
      agentId: 'a',
      occurredAt: at(2),
      durationMs: 1000,
      payload: { tool_name: 'web_fetch' },
    })
    expect(tracker.openCorrelationCount()).toBe(0)
  })
})
