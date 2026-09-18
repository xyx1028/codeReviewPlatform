/**
 * 运行监控事件 Reporter（方案 §7.1 / §7.3 / §7.7）。
 *
 * 设计要点，每一条都是从"为什么现有 audit 无法表示正在调用"反推出来的：
 *
 *   * **必须有基于时间的 flush。** 只按条数 flush 会重现 `analysis_tool_audit` 的问题 ——
 *     "正在调用"永远来不及被看见。触发条件取三者之一：队列达到 `batchMax`、
 *     距上次 flush 达到 `flushMs`、或显式 `flush()`。
 *   * **同 flush 周期内闭合的工具折叠成一条 TERMINAL。** 毫秒级返回的
 *     `read` / `grep` / `glob` 各写两行是纯浪费。代价是 <flushMs 的工具不会出现
 *     "正在调用"态 —— 而人类监控台真正关心的恰恰是"卡住的工具"。
 *   * **有界队列 + 按优先级丢弃。** `*_DENIED` / `*_FAILED` / ATTEMPT / AGENT / JOB /
 *     TASK scope 事件永不丢弃：宁可挤掉高频工具事件，也不能丢掉"为什么失败"。
 *   * **有界退避，不是无限 unshift。** 仓库现有 Broker 审计"回队首、无退避"的写法在
 *     数据库抖动时会把队列钉死，这里不照抄。
 *   * **fail open。** 监控上报失败绝不影响工具执行、模型调用、预算、租约或提交校验。
 *   * **权限被回收就静默。** 数据库侧 `revoke execute` 停写时（42501）必须自动进入静默
 *     模式，而不是每批刷一条错误日志。
 *   * **同一 correlation 的相对顺序有保证。** 队列 FIFO，STARTED 必然与 TERMINAL 同批
 *     （被折叠）或在更早的批次。
 */

import { randomUUID } from 'node:crypto'
import type { Logger } from '../logger.js'
import {
  runtimeEventDropPriority,
  runtimeEventPhase,
  runtimeEventScope,
  type RuntimeEvent,
  type RuntimeEventBatchResult,
  type RuntimeEventDropPriority,
  type RuntimeEventPhase,
  type RuntimeEventScope,
  type RuntimeEventSink,
  type RuntimeEventTarget,
  type RuntimeEventType,
  type RuntimeEventWire,
} from './runtime-event-types.js'

/** 单次 flush 的硬超时。与数据库水位逃生阀的 30 秒留足余量。 */
const FLUSH_TIMEOUT_MS = 10_000

/** 有界退避：三次重试，之后整批丢弃并计数。 */
const RETRY_BACKOFF_MS = [200, 600, 1800] as const

/** 静默模式下的日志节流：每 5 分钟最多一条。 */
const SILENCE_LOG_INTERVAL_MS = 5 * 60_000

export interface RuntimeEventReporterStats {
  /** 成功落库的事件数（含数据库判定为重复的幂等重试）。 */
  reported: number
  /** 数据库返回的重复计数。 */
  duplicated: number
  /** 产生了但最终没有落库的事件数：队列溢出 + 整批失败 + 静默期间产生。 */
  dropped: number
  /** 数据库解析不到 agent node 而丢弃的条数。 */
  droppedUnresolvedAgent: number
  /** 数据库判定为非法（未登记类型 / 缺 run）的条数。 */
  droppedInvalid: number
  /** 折叠掉的 STARTED 条数。 */
  collapsed: number
  /** 整批失败次数。 */
  flushFailures: number
  /** 当前队列深度。 */
  queueDepth: number
  /** 是否已进入静默模式。 */
  silenced: boolean
  /** 数据库返回的最大事件 id，便于运维核对链路。 */
  maxEventId: number | null
}

export interface RuntimeEventReporterLike {
  readonly enabled: boolean
  /** 入队一条事件。永不抛出、永不阻塞调用方。 */
  report(event: RuntimeEvent): void
  /** 立即 flush 并等待完成。失败只计数，不抛出。 */
  flush(): Promise<void>
  /** 尽力 flush 一次后停止；不得无限阻塞 Attempt 收敛。 */
  close(): Promise<void>
  snapshot(): RuntimeEventReporterStats
  /** 生成一个 correlation id。绝不使用命令、URL 或路径。 */
  newCorrelationId(): string
  /**
   * 更新 fencing 用的 session revision（V1.9）。
   *
   * 恢复会让数据库把 run 的 `session_revision` 推进一格，而收敛路径（提交/失败之后
   * claim 已被烧掉）的事件只能靠 revision 通过 fencing。不同步的话最后一次 flush 会
   * 以 `RUNTIME_EVENT_FENCE_REJECTED` 整批丢失 —— 恰恰是终态那几条最需要的事件。
   */
  setSessionRevision?(revision: number): void
}

export interface RuntimeEventReporterOptions {
  target: RuntimeEventTarget
  sink: RuntimeEventSink
  logger: Logger
  enabled?: boolean
  /** 定时 flush 间隔，同时是折叠窗口。0 表示不装定时器（测试用）。 */
  flushMs?: number
  queueMax?: number
  batchMax?: number
  /** 注入时钟，便于测试折叠与退避。 */
  now?: () => number
  /** 注入 sleep，便于测试跳过真实退避等待。 */
  sleep?: (ms: number) => Promise<void>
}

interface QueuedEvent {
  wire: RuntimeEventWire
  type: RuntimeEventType
  scope: RuntimeEventScope
  phase: RuntimeEventPhase | null
  priority: RuntimeEventDropPriority
  occurredAtMs: number
  /** STARTED 尚未落库，可被同批 TERMINAL 折叠。 */
  pendingCollapse: boolean
}

type PayloadValue = string | number | boolean | null

function sanitizePayload(payload: unknown): Record<string, PayloadValue> {
  if (payload === null || payload === undefined || typeof payload !== 'object') return {}
  const out: Record<string, PayloadValue> = {}
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    if (value === undefined) continue
    if (value === null) {
      out[key] = null
    } else if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value
    }
    // 其它类型（对象、数组、函数）一律丢弃：payload 只允许标量。
    // 数据库侧还会按 event_type 重建一次 allowlist，这里只是第一道门。
  }
  return out
}

/** 权限被回收（`revoke execute`）的判据。 */
function isPrivilegeError(error: unknown): boolean {
  const record = error as { code?: unknown; message?: unknown } | null
  const code = typeof record?.code === 'string' ? record.code : ''
  const message = typeof record?.message === 'string' ? record.message : String(error ?? '')
  return (
    code === '42501' ||
    /\b42501\b/.test(message) ||
    /insufficient_privilege/i.test(message) ||
    /permission denied for function/i.test(message)
  )
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    if (typeof timer.unref === 'function') timer.unref()
  })
}

export class RuntimeEventReporter implements RuntimeEventReporterLike {
  readonly enabled: boolean

  private target: RuntimeEventTarget
  private readonly sink: RuntimeEventSink
  private readonly logger: Logger
  private readonly flushMs: number
  private readonly queueMax: number
  private readonly batchMax: number
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>

  private queue: QueuedEvent[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private inFlight: Promise<void> | null = null
  private closed = false
  private silenced = false
  private lastSilenceLogAt = 0
  private highWaterLogged = false

  private stats: RuntimeEventReporterStats = {
    reported: 0,
    duplicated: 0,
    dropped: 0,
    droppedUnresolvedAgent: 0,
    droppedInvalid: 0,
    collapsed: 0,
    flushFailures: 0,
    queueDepth: 0,
    silenced: false,
    maxEventId: null,
  }

  constructor(options: RuntimeEventReporterOptions) {
    this.enabled = options.enabled ?? true
    this.target = options.target
    this.sink = options.sink
    this.logger = options.logger
    this.flushMs = options.flushMs ?? 800
    this.queueMax = Math.max(8, options.queueMax ?? 512)
    this.batchMax = Math.max(1, options.batchMax ?? 64)
    this.now = options.now ?? (() => Date.now())
    this.sleep = options.sleep ?? defaultSleep
  }

  /**
   * 跟上恢复后被数据库推进的 session revision。
   *
   * 只前进：一个更小的值只可能来自旧上下文，接受它等于自己制造 fencing 失败。
   */
  setSessionRevision(revision: number): void {
    if (!Number.isInteger(revision)) return
    const current = this.target.sessionRevision ?? 0
    if (revision <= current) return
    this.target = { ...this.target, sessionRevision: revision }
  }

  /** 派生一个共享同一 sink/配置但换 fencing 上下文的 Reporter。 */
  withTarget(target: RuntimeEventTarget): RuntimeEventReporter {    return new RuntimeEventReporter({
      target,
      sink: this.sink,
      logger: this.logger,
      enabled: this.enabled,
      flushMs: this.flushMs,
      queueMax: this.queueMax,
      batchMax: this.batchMax,
      now: this.now,
      sleep: this.sleep,
    })
  }

  newCorrelationId(): string {
    return randomUUID()
  }

  report(event: RuntimeEvent): void {
    if (!this.enabled || this.closed) return
    if (this.silenced) {
      this.stats.dropped += 1
      return
    }

    try {
      const type = event.type
      const scope = runtimeEventScope(type)
      const phase = runtimeEventPhase(type)
      const occurredAt = event.occurredAt ?? new Date(this.now())
      const payload = sanitizePayload((event as { payload?: unknown }).payload)
      const collapsed = payload.collapsed === true

      const wire: RuntimeEventWire = {
        event_uuid: randomUUID(),
        event_type: type,
        occurred_at: occurredAt.toISOString(),
        payload,
      }
      const agentId = (event as { agentId?: string }).agentId
      if (agentId !== undefined && agentId !== '') wire.agent_id = agentId
      const correlationId = (event as { correlationId?: string }).correlationId
      if (correlationId !== undefined && correlationId !== '') wire.correlation_id = correlationId
      const parentCorrelationId = (event as { parentCorrelationId?: string }).parentCorrelationId
      if (parentCorrelationId !== undefined && parentCorrelationId !== '') {
        wire.parent_correlation_id = parentCorrelationId
      }
      if (event.errorCode !== undefined && event.errorCode !== '') wire.error_code = event.errorCode
      if (typeof event.durationMs === 'number' && Number.isFinite(event.durationMs)) {
        wire.duration_ms = Math.max(0, Math.round(event.durationMs))
      }

      this.queue.push({
        wire,
        type,
        scope,
        phase,
        priority: runtimeEventDropPriority(type, collapsed),
        occurredAtMs: occurredAt.getTime(),
        pendingCollapse: phase === 'STARTED',
      })
      this.enforceQueueBound()
      this.stats.queueDepth = this.queue.length

      if (this.queue.length >= this.batchMax) {
        void this.flush()
      } else {
        this.scheduleTimer()
      }
    } catch {
      // 观测路径 fail open：入队失败也不能影响业务。
      this.stats.dropped += 1
    }
  }

  async flush(): Promise<void> {
    if (!this.enabled) return
    // 串行化：同一时刻只有一次 flush 在飞，保证批次顺序即入队顺序。
    const run = (this.inFlight ?? Promise.resolve()).then(() => this.drain())
    this.inFlight = run.catch(() => undefined)
    await this.inFlight
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.clearTimer()
    if (!this.enabled) return
    try {
      await Promise.race([
        this.flush(),
        this.sleep(FLUSH_TIMEOUT_MS).then(() => undefined),
      ])
    } catch {
      // close 永不抛出：Attempt 收敛不能被观测通道拖住。
    }
  }

  snapshot(): RuntimeEventReporterStats {
    return { ...this.stats, queueDepth: this.queue.length, silenced: this.silenced }
  }

  // -------------------------------------------------------------------------

  private scheduleTimer(): void {
    if (this.timer !== null || this.flushMs <= 0 || this.closed) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.flush()
    }, this.flushMs)
    if (typeof this.timer.unref === 'function') this.timer.unref()
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  /**
   * 队列溢出时按优先级丢弃：先丢已折叠的快工具 TERMINAL，再丢
   * `MODEL_REQUEST_COMPLETED`，再丢 `*_STARTED`。优先级 0 永不丢弃。
   */
  private enforceQueueBound(): void {
    if (this.queue.length <= this.queueMax) {
      if (this.queue.length < this.queueMax * 0.8) this.highWaterLogged = false
      return
    }
    if (!this.highWaterLogged) {
      this.highWaterLogged = true
      this.logger.warn('runtime_event_queue_high', { queue_depth: this.queue.length })
    }

    for (let priority = 3; priority >= 1 && this.queue.length > this.queueMax; priority -= 1) {
      let index = 0
      while (index < this.queue.length && this.queue.length > this.queueMax) {
        if (this.queue[index]!.priority === priority) {
          const [dropped] = this.queue.splice(index, 1)
          this.stats.dropped += 1
          this.logger.warn('runtime_event_dropped', {
            count: 1,
            event_type: dropped!.type,
            queue_depth: this.queue.length,
          })
        } else {
          index += 1
        }
      }
    }
  }

  /**
   * 同 flush 周期折叠：TERMINAL 与它的 STARTED 都在这一批时，只落一条 TERMINAL，
   * 带 `duration_ms` 与 `payload.collapsed = true`。
   */
  private collapse(batch: QueuedEvent[]): QueuedEvent[] {
    const startedByCorrelation = new Map<string, number>()
    batch.forEach((item, index) => {
      const correlation = item.wire.correlation_id
      if (item.phase === 'STARTED' && item.pendingCollapse && correlation !== undefined) {
        startedByCorrelation.set(correlation, index)
      }
    })
    if (startedByCorrelation.size === 0) return batch

    const removed = new Set<number>()
    for (const item of batch) {
      const correlation = item.wire.correlation_id
      if (item.phase !== 'TERMINAL' || correlation === undefined) continue
      const startedIndex = startedByCorrelation.get(correlation)
      if (startedIndex === undefined) continue
      const started = batch[startedIndex]!
      removed.add(startedIndex)
      startedByCorrelation.delete(correlation)

      // 折叠后的 TERMINAL 以 STARTED 的时间为区间起点，duration 为实际耗时。
      // 归因侧据此重建 [start, start + duration] 区间，不需要 STARTED 行。
      item.wire.occurred_at = started.wire.occurred_at
      item.wire.payload = { ...item.wire.payload, collapsed: true }
      if (item.wire.duration_ms === undefined) {
        item.wire.duration_ms = Math.max(0, item.occurredAtMs - started.occurredAtMs)
      }
      if (typeof item.wire.payload.duration_ms === 'number') {
        item.wire.payload.duration_ms = item.wire.duration_ms
      }
      this.stats.collapsed += 1
    }

    if (removed.size === 0) return batch
    this.logger.debug('runtime_event_collapsed', { count: removed.size })
    return batch.filter((_, index) => !removed.has(index))
  }

  private async drain(): Promise<void> {
    // 单次调用最多连续发 32 批，避免一个持续高产的 attempt 把 flush 变成死循环。
    for (let round = 0; round < 32; round += 1) {
      if (this.silenced || this.queue.length === 0) return
      const taken = this.queue.splice(0, this.batchMax)
      // 未被折叠的 STARTED 即将落库，之后到达的 TERMINAL 只能作为独立事件。
      const batch = this.collapse(taken)
      for (const item of taken) item.pendingCollapse = false
      this.stats.queueDepth = this.queue.length
      if (batch.length === 0) continue
      await this.send(batch)
    }
  }

  private async send(batch: QueuedEvent[]): Promise<void> {
    const events = batch.map((item) => item.wire)
    const startedAt = this.now()

    for (let attempt = 0; attempt <= RETRY_BACKOFF_MS.length; attempt += 1) {
      try {
        const result = await this.withTimeout(
          this.sink.reportRuntimeEventBatch({ ...this.target, events }),
        )
        this.applyResult(result, events.length, this.now() - startedAt)
        return
      } catch (error) {
        if (isPrivilegeError(error)) {
          this.enterSilence('INSUFFICIENT_PRIVILEGE')
          this.stats.dropped += events.length
          return
        }
        const isLastAttempt = attempt === RETRY_BACKOFF_MS.length
        this.logger.warn('runtime_event_flush_failed', {
          count: events.length,
          attempt: attempt + 1,
          error_code: this.stableErrorCode(error),
        })
        if (isLastAttempt) {
          this.stats.flushFailures += 1
          this.stats.dropped += events.length
          return
        }
        await this.sleep(RETRY_BACKOFF_MS[attempt]!)
      }
    }
  }

  private applyResult(
    result: RuntimeEventBatchResult,
    sent: number,
    durationMs: number,
  ): void {
    const accepted = Number(result?.accepted ?? 0)
    const duplicated = Number(result?.duplicated ?? 0)
    const unresolved = Number(result?.dropped_unresolved_agent ?? 0)
    const invalid = Number(result?.dropped_invalid ?? 0)

    this.stats.reported += accepted
    this.stats.duplicated += duplicated
    this.stats.droppedUnresolvedAgent += unresolved
    this.stats.droppedInvalid += invalid
    // 既没被接受也没被数据库明确丢弃的，算链路丢失。
    const unaccounted = sent - accepted - unresolved - invalid
    if (unaccounted > 0) this.stats.dropped += unaccounted
    if (result?.max_event_id !== null && result?.max_event_id !== undefined) {
      const maxId = Number(result.max_event_id)
      if (Number.isFinite(maxId)) {
        this.stats.maxEventId = Math.max(this.stats.maxEventId ?? 0, maxId)
      }
    }

    this.logger.debug('runtime_event_flushed', {
      count: sent,
      duration_ms: durationMs,
      duplicated,
      dropped_unresolved_agent: unresolved,
    })
  }

  private enterSilence(reason: string): void {
    const wasSilenced = this.silenced
    this.silenced = true
    this.stats.silenced = true
    this.stats.dropped += this.queue.length
    this.queue = []
    this.stats.queueDepth = 0
    this.clearTimer()
    const nowMs = this.now()
    if (!wasSilenced || nowMs - this.lastSilenceLogAt >= SILENCE_LOG_INTERVAL_MS) {
      this.lastSilenceLogAt = nowMs
      this.logger.error('runtime_event_silenced', { reason })
    }
  }

  private stableErrorCode(error: unknown): string {
    const record = error as { code?: unknown } | null
    if (typeof record?.code === 'string' && record.code.trim() !== '') {
      return record.code.trim().slice(0, 64)
    }
    return 'RUNTIME_EVENT_FLUSH_ERROR'
  }

  private async withTimeout<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | null = null
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('RUNTIME_EVENT_FLUSH_TIMEOUT')),
            FLUSH_TIMEOUT_MS,
          )
          if (typeof timer.unref === 'function') timer.unref()
        }),
      ])
    } finally {
      if (timer !== null) clearTimeout(timer)
    }
  }
}

/**
 * 关闭态 Reporter：`RUNTIME_EVENTS_ENABLED=false` 时使用。
 *
 * 所有插桩点都拿到一个非空对象，因此调用侧不需要写 `reporter?.report(...)`，
 * 也就不会因为漏写可选链而在关闭态崩掉。
 */
export class NullRuntimeEventReporter implements RuntimeEventReporterLike {
  readonly enabled = false

  report(): void {}

  setSessionRevision(): void {}

  async flush(): Promise<void> {}

  async close(): Promise<void> {}

  newCorrelationId(): string {
    return randomUUID()
  }

  snapshot(): RuntimeEventReporterStats {
    return {
      reported: 0,
      duplicated: 0,
      dropped: 0,
      droppedUnresolvedAgent: 0,
      droppedInvalid: 0,
      collapsed: 0,
      flushFailures: 0,
      queueDepth: 0,
      silenced: false,
      maxEventId: null,
    }
  }
}

export interface RuntimeEventSettings {
  enabled: boolean
  flushMs: number
  queueMax: number
  batchMax: number
}

/**
 * 按配置装配一个 Reporter。关闭时返回 NullRuntimeEventReporter，所以调用侧永远拿到
 * 一个非空对象 —— 不需要写 `reporter?.report(...)`，也就不会因为漏写可选链而在关闭态崩掉。
 */
export function buildRuntimeEventReporter(input: {
  settings: RuntimeEventSettings
  target: RuntimeEventTarget
  sink: RuntimeEventSink
  logger: Logger
}): RuntimeEventReporterLike {
  if (!input.settings.enabled) return new NullRuntimeEventReporter()
  return new RuntimeEventReporter({
    target: input.target,
    sink: input.sink,
    logger: input.logger,
    enabled: true,
    flushMs: input.settings.flushMs,
    queueMax: input.settings.queueMax,
    batchMax: input.settings.batchMax,
  })
}
