/**
 * Attempt 墙钟时间归因（方案 §6.9.2 / §13.1）。
 *
 * 这是 AI 侧的**第二条通道**。数据库里的 `analysis_agent_run_rollup` 是主通道，但它依赖
 * `compute_analysis_run_rollup` 成功、依赖事件还没被 30 天保留期清掉。这个类在 Worker
 * 进程内用**同一份事件流**独立算一遍，随 attempt 终态落一行自包含的 `attempt_rollup`
 * 结构化日志 —— 数据库汇总失败、事件被清理、甚至数据库短暂不可用时，那行日志里仍然有
 * 这次运行的完整归因。
 *
 * 字段名与 `analysis_agent_run_rollup` 的列名**逐字一致**：AI 用同一套名字既能查库也能
 * 读日志，不需要两套映射。归因算法与 SQL 侧同源：
 *
 *   wall_ms         = 终态 − ATTEMPT_STARTED
 *   setup_ms        = HARNESS_PROCESS_STARTED − ATTEMPT_STARTED
 *   model_ms_union  = 所有 MODEL correlation 区间的并集长度
 *   tool_ms_union   = 所有 TOOL  correlation 区间的并集长度
 *   busy_ms_union   = (MODEL ∪ TOOL) 的并集长度
 *   teardown_ms     = 终态 − 最后一个 TERMINAL 事件
 *   agent_idle_ms   = Σ 每个 Agent「已注册未终态但无未闭合 correlation」的时长
 *   unattributed_ms = wall − setup − busy_union − teardown
 *
 * `unattributed_ms` 允许为大值 —— 它是插桩盲区的度量，是发现"还没插桩到哪"的唯一手段。
 * 禁止把它摊进其它桶假装归因完整。
 */

import type { RuntimeEvent } from './runtime-event-types.js'
import { runtimeEventPhase, runtimeEventScope } from './runtime-event-types.js'
import type { RuntimeEventReporterStats } from './runtime-event-reporter.js'

interface OpenInterval {
  scope: 'MODEL' | 'TOOL'
  startMs: number | null
  endMs: number | null
  durationMs: number | null
  agentId: string | null
  toolName: string | null
  kind: string | null
  closed: boolean
}

export interface Interval {
  startMs: number
  endMs: number
}

/**
 * 平台 origin 工具：这 5 个经 Broker 执行（读冻结快照 / 提交结论），其余 25 个是
 * harness origin，在 Harness 进程内执行。
 *
 * 区分它们才能回答 §1.2 第 13 条"慢是模型侧还是平台侧"。必须与 0032 的
 * `analysis_runtime_platform_tool_names()` 逐字一致。
 */
export const PLATFORM_TOOL_NAMES = [
  'search_snapshot_code',
  'find_snapshot_files',
  'read_snapshot_code',
  'list_snapshot_commits',
  'submit_review_result',
] as const

/** 合并区间并返回并集总长度（毫秒）。与 SQL 侧的窗口函数合并同语义。 */
export function mergeIntervalsMs(intervals: readonly Interval[]): number {
  if (intervals.length === 0) return 0
  const sorted = [...intervals].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)
  let total = 0
  let currentStart = sorted[0]!.startMs
  let currentEnd = sorted[0]!.endMs
  for (let index = 1; index < sorted.length; index += 1) {
    const next = sorted[index]!
    if (next.startMs > currentEnd) {
      total += currentEnd - currentStart
      currentStart = next.startMs
      currentEnd = next.endMs
    } else if (next.endMs > currentEnd) {
      currentEnd = next.endMs
    }
  }
  return total + (currentEnd - currentStart)
}

/** 最大并发数。端点相同时先减后加，所以"紧邻但不重叠"不算并发。 */
export function maxOverlap(intervals: readonly Interval[]): number {
  const points: Array<{ at: number; delta: number }> = []
  for (const interval of intervals) {
    points.push({ at: interval.startMs, delta: 1 })
    points.push({ at: interval.endMs, delta: -1 })
  }
  points.sort((a, b) => a.at - b.at || a.delta - b.delta)
  let running = 0
  let peak = 0
  for (const point of points) {
    running += point.delta
    if (running > peak) peak = running
  }
  return peak
}

export interface AttemptRollupFingerprint {
  model_label: string | null
  policy_hash: string | null
  profile_config_hash: string | null
  harness_version: string | null
  capability_contract_hash: string | null
  prompt_version: string | null
  policy_version: number | null
}

export interface AttemptRollupInput {
  agent_run_id: string | null
  task_id: string
  batch_id: string | null
  job_id: string | null
  agent_attempt: number
  worker_id: string
  terminal_status: 'COMMITTED' | 'FAILED'
  terminal_error_code: string | null
  end_reason: string | null
  resumed: boolean
  resume_count: number
  fingerprint: AttemptRollupFingerprint
  agent_count: number
  max_depth: number
  input_tokens: number | null
  output_tokens: number | null
  /**
   * 已提交证据条数。Worker 在收敛时拿不到这个数（它属于提交事务），此时为 null ——
   * 宁可写 null 也不要用一个定义不同的数字冒充同名字段。
   */
  evidence_count: number | null
  artifact_count: number
  rejected_submissions: number
  reporter: RuntimeEventReporterStats
  finishedAtMs: number
}

/** 一行 `attempt_rollup` 日志的形状。字段名与汇总表列名逐字一致。 */
export interface AttemptRollupRecord {
  event: 'attempt_rollup'
  agent_run_id: string | null
  task_id: string
  job_id: string | null
  batch_id: string | null
  agent_attempt: number
  worker_id: string
  terminal_status: string
  terminal_error_code: string | null
  end_reason: string | null
  resumed: boolean
  resume_count: number
  model_label: string | null
  policy_hash: string | null
  profile_config_hash: string | null
  harness_version: string | null
  capability_contract_hash: string | null
  prompt_version: string | null
  policy_version: number | null
  wall_ms: number
  setup_ms: number
  model_ms_union: number
  tool_ms_union: number
  /**
   * 平台 origin 工具的区间并集。
   *
   * §1.2 第 13 条的第三项（数据库往返）首版**没有插桩**，落在 `unattributed_ms` 里；
   * 诊断 RPC 的 `instrumentation_gaps` 会把这条盲区显式列出来。这里不造一个
   * 名字像、语义不对的 `db_ms`。
   */
  platform_tool_ms_union: number
  busy_ms_union: number
  teardown_ms: number
  agent_idle_ms: number
  unattributed_ms: number
  model_ms_sum: number
  tool_ms_sum: number
  agent_count: number
  max_depth: number
  max_concurrent_agents: number
  max_concurrent_tools: number
  model_requests: number
  model_requests_by_kind: Record<string, number>
  model_requests_denied: number
  tool_calls: number
  tool_calls_denied: number
  tool_calls_failed: number
  tool_ms_by_name: Record<string, number>
  tool_calls_by_name: Record<string, number>
  input_tokens: number | null
  output_tokens: number | null
  evidence_count: number | null
  artifact_count: number
  rejected_submissions: number
  events_reported: number
  events_dropped: number
  unattributed_pct: number
  rollup_version: number
}

/** 归因算法版本。改了算法就升版本，AI 才不会把算法变更当成性能变化。 */
export const ATTEMPT_ROLLUP_VERSION = 1

export class AttemptAttributionTracker {
  private attemptStartedMs: number | null = null
  private harnessStartedMs: number | null = null
  private lastTerminalMs: number | null = null
  private readonly correlations = new Map<string, OpenInterval>()
  private readonly agentWindows = new Map<string, { startMs: number; endMs: number | null }>()
  private modelRequests = 0
  private modelRequestsDenied = 0
  private toolCalls = 0
  private toolCallsDenied = 0
  private toolCallsFailed = 0
  private readonly modelRequestsByKind: Record<string, number> = {}

  constructor(private readonly now: () => number = () => Date.now()) {}

  observeAttemptStarted(atMs: number = this.now()): void {
    if (this.attemptStartedMs === null) this.attemptStartedMs = atMs
  }

  observeHarnessProcessStarted(atMs: number = this.now()): void {
    if (this.harnessStartedMs === null) this.harnessStartedMs = atMs
  }

  /** Agent 注册成功（数据库确认之后）。这是 agent_idle_ms 窗口的起点。 */
  observeAgentRegistered(agentId: string, atMs: number = this.now()): void {
    if (!this.agentWindows.has(agentId)) {
      this.agentWindows.set(agentId, { startMs: atMs, endMs: null })
    }
  }

  observeAgentTerminal(agentId: string, atMs: number = this.now()): void {
    const window = this.agentWindows.get(agentId)
    if (window !== undefined && window.endMs === null) window.endMs = atMs
  }

  /** 消费一条运行监控事件。与 Reporter 看到的是同一份流。 */
  observe(event: RuntimeEvent): void {
    const type = event.type
    const scope = runtimeEventScope(type)
    const phase = runtimeEventPhase(type)
    const atMs = (event.occurredAt ?? new Date(this.now())).getTime()

    if (type === 'HARNESS_PROCESS_STARTED') this.observeHarnessProcessStarted(atMs)
    if (phase === 'TERMINAL') {
      this.lastTerminalMs = this.lastTerminalMs === null ? atMs : Math.max(this.lastTerminalMs, atMs)
    }

    if (scope !== 'MODEL' && scope !== 'TOOL') return
    const correlationId = (event as { correlationId?: string }).correlationId
    if (correlationId === undefined) return

    const payload = (event as { payload?: Record<string, unknown> }).payload ?? {}
    const existing = this.correlations.get(correlationId)
    const entry: OpenInterval =
      existing ??
      {
        scope,
        startMs: null,
        endMs: null,
        durationMs: null,
        agentId: (event as { agentId?: string }).agentId ?? null,
        toolName: typeof payload.tool_name === 'string' ? payload.tool_name : null,
        kind: typeof payload.model_request_kind === 'string' ? payload.model_request_kind : null,
        closed: false,
      }
    if (existing === undefined) this.correlations.set(correlationId, entry)
    if (entry.agentId === null && (event as { agentId?: string }).agentId !== undefined) {
      entry.agentId = (event as { agentId?: string }).agentId!
    }
    if (entry.toolName === null && typeof payload.tool_name === 'string') {
      entry.toolName = payload.tool_name
    }
    if (entry.kind === null && typeof payload.model_request_kind === 'string') {
      entry.kind = payload.model_request_kind
    }

    if (phase === 'STARTED') {
      entry.startMs = entry.startMs === null ? atMs : Math.min(entry.startMs, atMs)
      return
    }
    if (phase !== 'TERMINAL') return

    entry.closed = true
    if (typeof event.durationMs === 'number' && Number.isFinite(event.durationMs)) {
      entry.durationMs = Math.max(0, Math.round(event.durationMs))
    }
    // 折叠事件没有 STARTED 行：它的 occurred_at 就是区间起点，duration 是长度。
    if (entry.startMs === null) entry.startMs = atMs
    entry.endMs = entry.endMs === null ? atMs : Math.max(entry.endMs, atMs)

    switch (type) {
      case 'MODEL_REQUEST_COMPLETED':
      case 'MODEL_REQUEST_FAILED':
        this.modelRequests += 1
        this.modelRequestsByKind[entry.kind ?? 'other'] =
          (this.modelRequestsByKind[entry.kind ?? 'other'] ?? 0) + 1
        break
      case 'MODEL_REQUEST_DENIED':
        this.modelRequestsDenied += 1
        break
      case 'TOOL_CALL_COMPLETED':
      case 'TOOL_CALL_CANCELLED':
        this.toolCalls += 1
        break
      case 'TOOL_CALL_FAILED':
        this.toolCalls += 1
        this.toolCallsFailed += 1
        break
      case 'TOOL_CALL_DENIED':
        this.toolCallsDenied += 1
        break
      default:
        break
    }
  }

  private intervalsFor(
    scopes: ReadonlySet<'MODEL' | 'TOOL'>,
    agentId?: string,
    toolNames?: ReadonlySet<string>,
  ): Interval[] {
    const out: Interval[] = []
    for (const entry of this.correlations.values()) {
      if (!scopes.has(entry.scope)) continue
      if (agentId !== undefined && entry.agentId !== agentId) continue
      if (toolNames !== undefined && (entry.toolName === null || !toolNames.has(entry.toolName))) {
        continue
      }
      if (entry.startMs === null) continue
      const byDuration = entry.durationMs === null ? entry.startMs : entry.startMs + entry.durationMs
      const endMs = Math.max(entry.endMs ?? entry.startMs, byDuration)
      out.push({ startMs: entry.startMs, endMs })
    }
    return out
  }

  private sumFor(scope: 'MODEL' | 'TOOL'): number {
    let total = 0
    for (const interval of this.intervalsFor(new Set([scope]))) {
      total += interval.endMs - interval.startMs
    }
    return total
  }

  summarize(input: AttemptRollupInput): AttemptRollupRecord {
    const startedMs = this.attemptStartedMs ?? input.finishedAtMs
    const finishedMs = Math.max(input.finishedAtMs, startedMs)
    const wallMs = finishedMs - startedMs

    const modelScopes = new Set<'MODEL' | 'TOOL'>(['MODEL'])
    const toolScopes = new Set<'MODEL' | 'TOOL'>(['TOOL'])
    const bothScopes = new Set<'MODEL' | 'TOOL'>(['MODEL', 'TOOL'])

    let setupMs =
      this.harnessStartedMs === null ? 0 : Math.max(0, this.harnessStartedMs - startedMs)
    setupMs = Math.min(setupMs, wallMs)
    let teardownMs = this.lastTerminalMs === null ? 0 : Math.max(0, finishedMs - this.lastTerminalMs)
    teardownMs = Math.min(teardownMs, Math.max(wallMs - setupMs, 0))

    const modelUnion = Math.min(mergeIntervalsMs(this.intervalsFor(modelScopes)), wallMs)
    const toolUnion = Math.min(mergeIntervalsMs(this.intervalsFor(toolScopes)), wallMs)
    const platformUnion = Math.min(
      mergeIntervalsMs(
        this.intervalsFor(toolScopes, undefined, new Set<string>(PLATFORM_TOOL_NAMES)),
      ),
      wallMs,
    )
    // 与 SQL 侧同一套钳制顺序，保证归因等式恒成立。
    const busyUnion = Math.min(
      mergeIntervalsMs(this.intervalsFor(bothScopes)),
      Math.max(wallMs - setupMs - teardownMs, 0),
    )
    const unattributedMs = Math.max(wallMs - setupMs - busyUnion - teardownMs, 0)

    let agentIdleMs = 0
    const agentIntervals: Interval[] = []
    for (const [agentId, window] of this.agentWindows) {
      const endMs = window.endMs ?? finishedMs
      const lifetime = Math.max(0, endMs - window.startMs)
      agentIntervals.push({ startMs: window.startMs, endMs: Math.max(endMs, window.startMs) })
      const busy = mergeIntervalsMs(this.intervalsFor(bothScopes, agentId))
      agentIdleMs += Math.max(0, lifetime - busy)
    }

    const toolMsByName: Record<string, number> = {}
    const toolCallsByName: Record<string, number> = {}
    for (const entry of this.correlations.values()) {
      if (entry.scope !== 'TOOL' || entry.startMs === null) continue
      const name = entry.toolName ?? 'unknown'
      const byDuration = entry.durationMs === null ? entry.startMs : entry.startMs + entry.durationMs
      const endMs = Math.max(entry.endMs ?? entry.startMs, byDuration)
      toolMsByName[name] = (toolMsByName[name] ?? 0) + (endMs - entry.startMs)
      toolCallsByName[name] = (toolCallsByName[name] ?? 0) + 1
    }

    return {
      event: 'attempt_rollup',
      agent_run_id: input.agent_run_id,
      task_id: input.task_id,
      job_id: input.job_id,
      batch_id: input.batch_id,
      agent_attempt: input.agent_attempt,
      worker_id: input.worker_id,
      terminal_status: input.terminal_status,
      terminal_error_code: input.terminal_error_code,
      end_reason: input.end_reason,
      resumed: input.resumed,
      resume_count: input.resume_count,
      model_label: input.fingerprint.model_label,
      policy_hash: input.fingerprint.policy_hash,
      profile_config_hash: input.fingerprint.profile_config_hash,
      harness_version: input.fingerprint.harness_version,
      capability_contract_hash: input.fingerprint.capability_contract_hash,
      prompt_version: input.fingerprint.prompt_version,
      policy_version: input.fingerprint.policy_version,
      wall_ms: wallMs,
      setup_ms: setupMs,
      model_ms_union: modelUnion,
      tool_ms_union: toolUnion,
      platform_tool_ms_union: platformUnion,
      busy_ms_union: busyUnion,
      teardown_ms: teardownMs,
      agent_idle_ms: agentIdleMs,
      unattributed_ms: unattributedMs,
      model_ms_sum: this.sumFor('MODEL'),
      tool_ms_sum: this.sumFor('TOOL'),
      agent_count: input.agent_count,
      max_depth: input.max_depth,
      max_concurrent_agents: Math.max(maxOverlap(agentIntervals), 1),
      max_concurrent_tools: maxOverlap(this.intervalsFor(toolScopes)),
      model_requests: this.modelRequests,
      model_requests_by_kind: { ...this.modelRequestsByKind },
      model_requests_denied: this.modelRequestsDenied,
      tool_calls: this.toolCalls,
      tool_calls_denied: this.toolCallsDenied,
      tool_calls_failed: this.toolCallsFailed,
      tool_ms_by_name: toolMsByName,
      tool_calls_by_name: toolCallsByName,
      input_tokens: input.input_tokens,
      output_tokens: input.output_tokens,
      evidence_count: input.evidence_count,
      artifact_count: input.artifact_count,
      rejected_submissions: input.rejected_submissions,
      events_reported: input.reporter.reported,
      events_dropped: input.reporter.dropped,
      unattributed_pct:
        wallMs === 0 ? 0 : Math.round((unattributedMs / wallMs) * 10000) / 100,
      rollup_version: ATTEMPT_ROLLUP_VERSION,
    }
  }

  /** 终态时仍未闭合的 correlation 数：插桩漏洞或进程被杀的直接证据。 */
  openCorrelationCount(): number {
    let open = 0
    for (const entry of this.correlations.values()) {
      if (!entry.closed) open += 1
    }
    return open
  }
}
