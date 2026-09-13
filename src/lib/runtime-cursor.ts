/**
 * 运行监控台游标模型的纯逻辑（V1.5 方案 §8.3）。
 *
 * 抽成纯函数是为了能被断言。这四条规则必须一起成立，散在 effect 里必然写漏其中一条，
 * 而写漏的后果都是「界面看起来正常，其实时间线有缺口」：
 *
 *   1. 游标只能推进到服务端给的 `next_event_id`，绝不能自己取 `max(event_id)`；
 *   2. `has_more` 为真时立即继续补拉，不等下一个 interval；
 *   3. 按 `event_uuid` 去重（不是按 id）——这是提交水位裁剪之外的第二道保险；
 *   4. `requires_full_snapshot` 为真时丢弃本地状态重做全量。
 */

import type {
  RuntimeConsoleCursor,
  RuntimeEvent,
  RuntimeFreshness,
  RuntimeTaskSnapshot,
} from '../types'

/** 时间线在内存里的上界：一个长批次的事件量远超一屏能看的。 */
export const MAX_TIMELINE_EVENTS = 2000

export type RuntimePullMode = 'snapshot' | 'cursor'

/**
 * 串行化同一批次的拉取，并给完整快照更高优先级。
 *
 * cursor tick 可以安全合并掉（下一轮仍从已确认游标继续），但 snapshot 不能丢：Agent 当前
 * 活动投影不由事件增量驱动，只能靠完整快照校准。`complete()` 会在当前请求结束后立即交出
 * 一个排队的 snapshot，从而避免长补拉把 12 秒校准和手动刷新永久吞掉。
 */
export class RuntimePullCoordinator {
  private running = false
  private snapshotPending = false

  readonly batchId: string | null

  constructor(batchId: string | null = null) {
    this.batchId = batchId
  }

  request(mode: RuntimePullMode): RuntimePullMode | null {
    if (!this.running) {
      this.running = true
      return mode
    }
    if (mode === 'snapshot') this.snapshotPending = true
    return null
  }

  complete(): RuntimePullMode | null {
    if (this.snapshotPending) {
      this.snapshotPending = false
      return 'snapshot'
    }
    this.running = false
    return null
  }

  reset(): void {
    this.running = false
    this.snapshotPending = false
  }
}

/**
 * 合并增量事件。
 *
 * 按 `event_uuid` 去重：Worker 重试复用同一个 uuid，所以这里能挡住一切重复投递 ——
 * 包括「断网 30 秒后恢复，服务端把同一段区间又发了一遍」。按 id 去重做不到这件事，
 * 因为服务端可以在同一个 id 上重发。
 */
export function mergeRuntimeEvents(
  previous: readonly RuntimeEvent[],
  incoming: readonly RuntimeEvent[],
): RuntimeEvent[] {
  if (incoming.length === 0) return [...previous]
  const seen = new Set(previous.map((event) => event.event_uuid))
  const merged = [...previous]
  for (const event of incoming) {
    if (seen.has(event.event_uuid)) continue
    seen.add(event.event_uuid)
    merged.push(event)
  }
  merged.sort((a, b) => a.event_id - b.event_id)
  return merged.length > MAX_TIMELINE_EVENTS
    ? merged.slice(merged.length - MAX_TIMELINE_EVENTS)
    : merged
}

/**
 * 合并 task 投影。
 *
 * 增量模式下服务端只返回「受本批事件影响的」task，所以必须按 id 覆盖而不是整体替换 ——
 * 整体替换会让没有新事件的 task 从界面上消失。
 */
export function mergeRuntimeTasks(
  previous: readonly RuntimeTaskSnapshot[],
  incoming: readonly RuntimeTaskSnapshot[],
  full: boolean,
): RuntimeTaskSnapshot[] {
  if (full) return [...incoming]
  if (incoming.length === 0) return [...previous]
  const byId = new Map(previous.map((task) => [task.task_id, task]))
  for (const task of incoming) byId.set(task.task_id, task)
  return [...byId.values()].sort((a, b) => a.story_code.localeCompare(b.story_code))
}

/**
 * 决定下一步动作。
 *
 * 返回 `reset` 时调用方必须丢弃本地事件与 task 数组并重做全量快照：游标已经早于事件
 * 保留期，继续增量只会得到一条有缺口的时间线。
 */
export interface CursorStep {
  action: 'reset' | 'continue' | 'idle'
  /** 应当写回本地的游标。`null` 表示保持不动。 */
  nextEventId: number | null
}

export function planCursorStep(
  cursor: RuntimeConsoleCursor,
  applied: number | null,
  wasFullSnapshot: boolean,
): CursorStep {
  // 增量请求撞上保留期边界：必须重做全量，不能带着缺口继续。
  if (cursor.requires_full_snapshot && !wasFullSnapshot) {
    return { action: 'reset', nextEventId: null }
  }
  // 只认服务端确认已过提交水位的最大 id。它可能小于我们已经应用过的游标（服务端刚好
  // 被一个长事务卡住），那种情况下不能回退。
  const advanced =
    cursor.next_event_id === null
      ? applied
      : applied === null
        ? cursor.next_event_id
        : Math.max(applied, cursor.next_event_id)
  return {
    // has_more 为真时立即继续补拉，否则积压永远追不平。
    action: cursor.has_more ? 'continue' : 'idle',
    nextEventId: advanced,
  }
}

/**
 * 五档数据新鲜度。
 *
 * 三种故障**分别**返回，不合并成一个「异常」：链路拥塞看数据库负载，长事务未提交只能等，
 * Worker 掉线要查进程 —— 合并之后运维不知道该做哪一件。
 */
export function computeRuntimeFreshness(input: {
  serverTime: string | null
  lastEventAt: string | null
  watermarkLagMs: number | null
  heartbeatAt: string | null
  isRunning: boolean
}): RuntimeFreshness {
  const now = input.serverTime === null ? Date.now() : Date.parse(input.serverTime)
  if (!Number.isFinite(now)) return input.isRunning ? 'STALE' : 'DELAYED'

  if (input.heartbeatAt !== null) {
    const heartbeatAt = Date.parse(input.heartbeatAt)
    // 运行中任务的心跳时间不可解析时不能乐观当作在线。
    if (!Number.isFinite(heartbeatAt)) return input.isRunning ? 'WORKER_OFFLINE' : 'DELAYED'
    const heartbeatAgeMs = now - heartbeatAt
    // 20 秒与 reclaim_stale_story_task_leases 的窗口一致：超过它任务随时会被接管。
    if (heartbeatAgeMs > 20000) return 'WORKER_OFFLINE'
  }
  if (input.watermarkLagMs !== null && input.watermarkLagMs > 3000) return 'AWAITING_COMMIT'

  if (input.lastEventAt === null) return input.isRunning ? 'STALE' : 'LIVE'
  const lastEventAt = Date.parse(input.lastEventAt)
  if (!Number.isFinite(lastEventAt)) return input.isRunning ? 'STALE' : 'DELAYED'
  const ageMs = now - lastEventAt
  if (ageMs < 5000) return 'LIVE'
  if (ageMs <= 15000) return 'DELAYED'
  return input.isRunning ? 'STALE' : 'DELAYED'
}
