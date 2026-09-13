/**
 * 运行监控台的取数状态机（V1.5 方案 §8.3）。
 *
 * 这个 hook 只负责「什么时候拉、拉哪一段、拉完怎么合并」的副作用编排；
 * 合并与游标推进的规则本身是纯函数，放在 `src/lib/runtime-cursor.ts` 里以便断言。
 *
 * 另外：页面隐藏时暂停短轮询，恢复可见时**先做一次完整快照再继续游标**。只补游标会
 * 漏掉后台期间的投影变化 —— 投影不由事件驱动，它是快照的一部分。
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { getAnalysisRuntimeConsole } from '../lib/api'
import {
  RuntimePullCoordinator,
  mergeRuntimeEvents,
  mergeRuntimeTasks,
  planCursorStep,
  type RuntimePullMode,
} from '../lib/runtime-cursor'
import type {
  AnalysisRuntimeConsoleResponse,
  RuntimeEvent,
  RuntimeTaskSnapshot,
} from '../types'

/** 事件增量补拉间隔。 */
const CURSOR_INTERVAL_MS = 2500
/** 完整快照校准间隔。 */
const SNAPSHOT_INTERVAL_MS = 12000
/** 单次 tick 内最多连续补拉多少页，避免积压时把浏览器打满。 */
const MAX_CATCHUP_PAGES = 20

export interface RuntimeConsoleState {
  batch: AnalysisRuntimeConsoleResponse['batch'] | null
  tasks: RuntimeTaskSnapshot[]
  events: RuntimeEvent[]
  cursor: AnalysisRuntimeConsoleResponse['cursor'] | null
  loading: boolean
  error: string | null
  /** 已应用的最后一个游标。UI 用它显示「补拉到哪」。 */
  appliedEventId: number | null
  /** 本地状态被 requires_full_snapshot 重置过的次数。 */
  resetCount: number
  refresh(): void
}

export interface UseRuntimeConsoleOptions {
  batchId: string | null
  /** 关闭自动刷新（例如非活动批次，或用户手动暂停）。 */
  enabled?: boolean
  /** 非活动批次降频：给一个更大的间隔，或 0 表示不自动增量。 */
  cursorIntervalMs?: number
  snapshotIntervalMs?: number
}

export function useRuntimeConsole(options: UseRuntimeConsoleOptions): RuntimeConsoleState {
  const { batchId } = options
  const enabled = options.enabled ?? true
  const cursorIntervalMs = options.cursorIntervalMs ?? CURSOR_INTERVAL_MS
  const snapshotIntervalMs = options.snapshotIntervalMs ?? SNAPSHOT_INTERVAL_MS

  const [batch, setBatch] = useState<AnalysisRuntimeConsoleResponse['batch'] | null>(null)
  const [tasks, setTasks] = useState<RuntimeTaskSnapshot[]>([])
  const [events, setEvents] = useState<RuntimeEvent[]>([])
  const [cursor, setCursor] = useState<AnalysisRuntimeConsoleResponse['cursor'] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [resetCount, setResetCount] = useState(0)

  /** 已应用的游标。放在 ref 里而不是 state：tick 之间必须读到最新值。 */
  const appliedRef = useRef<number | null>(null)
  const [applied, setApplied] = useState<number | null>(null)
  /** 每个批次使用独立协调器；旧批次的 finally 不会重置新批次正在运行的请求。 */
  const pullCoordinator = useMemo(() => new RuntimePullCoordinator(batchId), [batchId])
  /** await 返回后用当前选中批次校验，旧响应不得覆盖新批次。 */
  const activeBatchIdRef = useRef(batchId)
  useLayoutEffect(() => {
    activeBatchIdRef.current = batchId
  }, [batchId])
  /** 恢复可见后强制先做一次完整快照。 */
  const forceSnapshotRef = useRef(true)

  /** 丢弃本地游标位置；下一次请求会走完整快照。 */
  const reset = useCallback(() => {
    appliedRef.current = null
    forceSnapshotRef.current = true
  }, [])

  const pull = useCallback(
    async (mode: RuntimePullMode): Promise<void> => {
      if (batchId === null) return
      if (mode === 'snapshot') forceSnapshotRef.current = true

      // cursor tick 可以合并；snapshot 会由 coordinator 排到当前请求之后立即执行。
      let nextMode = pullCoordinator.request(mode)
      if (nextMode === null) return

      try {
        while (nextMode !== null) {
          let staleBatch = false
          try {
            let pages = 0
            let wantFull =
              nextMode === 'snapshot' || forceSnapshotRef.current || appliedRef.current === null
            for (;;) {
              const since = wantFull ? null : appliedRef.current
              const response = await getAnalysisRuntimeConsole(batchId, since)
              if (activeBatchIdRef.current !== batchId) {
                staleBatch = true
                break
              }

              setError(null)
              setBatch(response.batch)
              setCursor(response.cursor)

              const step = planCursorStep(response.cursor, appliedRef.current, wantFull)
              if (step.action === 'reset') {
                // 游标早于保留期：本地时间线一定有缺口，丢弃重做。
                appliedRef.current = null
                setApplied(null)
                setResetCount((count) => count + 1)
                wantFull = true
                continue
              }

              setTasks((previous) => mergeRuntimeTasks(previous, response.tasks, wantFull))
              setEvents((previous) =>
                wantFull
                  ? mergeRuntimeEvents([], response.events)
                  : mergeRuntimeEvents(previous, response.events),
              )
              if (step.nextEventId !== null) {
                appliedRef.current = step.nextEventId
                setApplied(step.nextEventId)
              }
              forceSnapshotRef.current = false
              wantFull = false

              pages += 1
              if (step.action !== 'continue' || pages >= MAX_CATCHUP_PAGES) break
            }
          } catch (err) {
            if (activeBatchIdRef.current === batchId) {
              setError(err instanceof Error ? err.message : String(err))
            }
          }

          if (staleBatch) break
          nextMode = pullCoordinator.complete()
          if (nextMode === 'snapshot') forceSnapshotRef.current = true
        }
      } finally {
        pullCoordinator.reset()
      }
    },
    [batchId, pullCoordinator],
  )

  const refresh = useCallback(() => {
    forceSnapshotRef.current = true
    void pull('snapshot')
  }, [pull])

  // 首次加载与切换批次：清掉旧批次视图，先丢弃游标，再做一次完整快照。
  // setTimeout(0) 让快速切换可以在 cleanup 中取消尚未发出的请求。
  useEffect(() => {
    reset()
    const timer = setTimeout(() => {
      if (activeBatchIdRef.current !== batchId) return
      setBatch(null)
      setTasks([])
      setEvents([])
      setCursor(null)
      setError(null)
      setApplied(null)
      setResetCount(0)
      if (batchId !== null) void pull('snapshot')
    }, 0)
    return () => clearTimeout(timer)
  }, [batchId, pull, reset])

  // 增量补拉。
  useEffect(() => {
    if (batchId === null || !enabled || cursorIntervalMs <= 0) return
    const timer = setInterval(() => {
      if (document.visibilityState !== 'visible') return
      void pull('cursor')
    }, cursorIntervalMs)
    return () => clearInterval(timer)
  }, [batchId, enabled, cursorIntervalMs, pull])

  // 完整快照校准。即使游标一切正常也要跑：投影是快照的一部分，不由事件驱动。
  useEffect(() => {
    if (batchId === null || !enabled || snapshotIntervalMs <= 0) return
    const timer = setInterval(() => {
      if (document.visibilityState !== 'visible') return
      void pull('snapshot')
    }, snapshotIntervalMs)
    return () => clearInterval(timer)
  }, [batchId, enabled, snapshotIntervalMs, pull])

  // 页面从后台恢复：先完整快照，再继续游标。
  useEffect(() => {
    if (batchId === null) return
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') return
      forceSnapshotRef.current = true
      void pull('snapshot')
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [batchId, pull])

  return {
    batch,
    tasks,
    events,
    cursor,
    // 首屏还没拿到任何快照就算加载中。派生而不是 setState：避免多余的一轮渲染。
    loading: batch === null && error === null,
    error,
    appliedEventId: applied,
    resetCount,
    refresh,
  }
}

export { computeRuntimeFreshness } from '../lib/runtime-cursor'

/** run 级「当前在做什么」= attempt 阶段 + 最近更新的运行中 Agent 活动（查询时聚合）。 */
export function useRunLevelActivity(task: RuntimeTaskSnapshot | null): {
  attemptPhase: string | null
  agentActivity: string | null
  agentToolName: string | null
  startedAt: string | null
} {
  return useMemo(() => {
    const attempt = task?.attempts[task.attempts.length - 1] ?? null
    if (attempt === null) {
      return { attemptPhase: null, agentActivity: null, agentToolName: null, startedAt: null }
    }
    const running = attempt.agents
      .filter((agent) => agent.current_activity_status === 'RUNNING')
      .sort((a, b) =>
        (b.current_activity_updated_at ?? '').localeCompare(a.current_activity_updated_at ?? ''),
      )
    const latest = running[0] ?? null
    return {
      attemptPhase: attempt.attempt_phase_code,
      agentActivity: latest?.current_activity_code ?? null,
      agentToolName: latest?.current_tool_name ?? null,
      startedAt: latest?.current_activity_started_at ?? attempt.attempt_phase_started_at,
    }
  }, [task])
}
