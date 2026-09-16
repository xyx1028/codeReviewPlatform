import type { RuntimeAttemptSnapshot, RuntimeEvent } from '../types'

export type RuntimeTimelineClusterKind = 'event' | 'setup'

export interface RuntimeTimelineCluster {
  key: string
  kind: RuntimeTimelineClusterKind
  representative: RuntimeEvent
  events: RuntimeEvent[]
  count: number
  totalDurationMs: number
}

export interface RuntimeTimelineGroup {
  key: string
  agentRunId: string | null
  attempt: RuntimeAttemptSnapshot | null
  events: RuntimeEvent[]
  clusters: RuntimeTimelineCluster[]
  failures: number
  startedAt: string | null
  finishedAt: string | null
}

const SETUP_EVENT_TYPES = new Set([
  'RUNTIME_CONTRACT_VERIFIED',
  'PINS_VERIFIED',
  'SESSION_SLOT_ACQUIRED',
  'WORKSPACE_READY',
  'BROKER_READY',
  'PROFILE_FROZEN',
  'HARNESS_PROCESS_STARTED',
  'ACP_TURN_STARTED',
  'ATTEMPT_INSTRUMENTATION_REPORTED',
])

/**
 * 时间线展示按事实发生时间排序，而不是按数据库取号顺序排序。
 *
 * Reporter 可能批量上报事件，较早发生的事件反而晚入库、拿到更大的 event_id。
 * event_id 仍负责游标推进；这里只在发生时间相同时用它保证展示顺序稳定。
 */
function compareNewestFirst(left: RuntimeEvent, right: RuntimeEvent): number {
  const leftTime = Date.parse(left.occurred_at)
  const rightTime = Date.parse(right.occurred_at)
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
    return rightTime - leftTime
  }
  return right.event_id - left.event_id
}

export function isRuntimeFailure(event: RuntimeEvent): boolean {
  return (
    event.event_type.endsWith('_FAILED') ||
    event.event_type.endsWith('_DENIED') ||
    event.error_code !== null
  )
}

/**
 * 当前时间线只展示所选需求的事实，绝不把同批次其它需求混进来。
 * JOB 事件没有 task_id，应留在批次层概览，不属于某个需求的 Attempt 时间线。
 */
export function eventsForRuntimeTask(
  events: RuntimeEvent[],
  taskId: string | null,
): RuntimeEvent[] {
  if (taskId === null) return []
  return events.filter((event) => event.task_id === taskId)
}

function compactKey(event: RuntimeEvent): string | null {
  if (event.scope !== 'TOOL' || event.phase !== 'TERMINAL') return null
  return [
    event.event_type,
    event.payload.tool_name ?? '',
    event.status ?? '',
    event.error_code ?? '',
    event.agent_node_id ?? '',
  ].join(':')
}

function cluster(
  key: string,
  kind: RuntimeTimelineClusterKind,
  events: RuntimeEvent[],
): RuntimeTimelineCluster {
  return {
    key,
    kind,
    representative: events[0]!,
    events,
    count: events.length,
    totalDurationMs: events.reduce((total, event) => total + (event.duration_ms ?? 0), 0),
  }
}

/**
 * 精简视图遵守两个事实边界：
 * 1. 同 correlation 已有 TERMINAL 时隐藏配对 STARTED；未闭合 STARTED 必须保留。
 * 2. 只合并显示，不改写/删除底层事件；完整日志随时可恢复逐条查看。
 */
export function compactRuntimeEvents(events: RuntimeEvent[]): RuntimeTimelineCluster[] {
  const terminals = new Set(
    events
      .filter((event) => event.phase === 'TERMINAL' && event.correlation_id !== null)
      .map((event) => event.correlation_id as string),
  )
  const visible = events
    .filter(
      (event) =>
        !(
          event.phase === 'STARTED' &&
          event.correlation_id !== null &&
          terminals.has(event.correlation_id)
        ),
    )
    .sort(compareNewestFirst)

  const setupEvents = visible.filter((event) => SETUP_EVENT_TYPES.has(event.event_type))
  const rows: RuntimeTimelineCluster[] = []
  let setupInserted = false

  for (let index = 0; index < visible.length; index++) {
    const event = visible[index]!
    if (SETUP_EVENT_TYPES.has(event.event_type)) {
      if (!setupInserted) {
        rows.push(cluster('setup', 'setup', setupEvents))
        setupInserted = true
      }
      continue
    }

    const key = compactKey(event)
    if (key === null) {
      rows.push(cluster(`event:${event.event_uuid}`, 'event', [event]))
      continue
    }

    const repeated = [event]
    while (index + 1 < visible.length && compactKey(visible[index + 1]!) === key) {
      repeated.push(visible[index + 1]!)
      index++
    }
    rows.push(cluster(`tool:${event.event_uuid}`, 'event', repeated))
  }

  return rows
}

function fullRuntimeEvents(events: RuntimeEvent[]): RuntimeTimelineCluster[] {
  return events
    .slice()
    .sort(compareNewestFirst)
    .map((event) => cluster(`event:${event.event_uuid}`, 'event', [event]))
}

export function buildRuntimeTimelineGroups(
  events: RuntimeEvent[],
  attempts: RuntimeAttemptSnapshot[],
  compact: boolean,
): RuntimeTimelineGroup[] {
  const attemptsByRun = new Map(attempts.map((attempt) => [attempt.agent_run_id, attempt]))
  const grouped = new Map<string, RuntimeEvent[]>()

  for (const event of events) {
    const key = event.agent_run_id ?? 'task'
    const bucket = grouped.get(key)
    if (bucket === undefined) grouped.set(key, [event])
    else bucket.push(event)
  }

  return [...grouped.entries()]
    .map(([key, groupEvents]): RuntimeTimelineGroup => {
      const agentRunId = key === 'task' ? null : key
      const attempt = agentRunId === null ? null : (attemptsByRun.get(agentRunId) ?? null)
      const ordered = groupEvents.slice().sort((left, right) => left.event_id - right.event_id)
      const first = ordered[0]
      const last = ordered[ordered.length - 1]
      return {
        key,
        agentRunId,
        attempt,
        events: ordered,
        clusters: compact ? compactRuntimeEvents(ordered) : fullRuntimeEvents(ordered),
        failures: ordered.filter(isRuntimeFailure).length,
        startedAt: attempt?.started_at ?? first?.occurred_at ?? null,
        finishedAt:
          attempt?.finished_at ?? attempt?.committed_at ?? last?.occurred_at ?? null,
      }
    })
    .sort((left, right) => {
      if (left.attempt !== null && right.attempt !== null) {
        return right.attempt.agent_attempt - left.attempt.agent_attempt
      }
      if (left.attempt !== null) return -1
      if (right.attempt !== null) return 1
      return 0
    })
}
