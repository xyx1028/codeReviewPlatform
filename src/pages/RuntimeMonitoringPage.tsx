import { useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Button,
  Card,
  Col,
  Row,
  Space,
  Statistic,
  Typography,
} from 'antd'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import {
  adminListActiveAnalysisBatches,
  adminListAnalysisWorkers,
  getAnalysisRuntimeTaskEvents,
} from '../lib/api'
import { computeRuntimeFreshness, useRuntimeConsole } from '../hooks/useRuntimeConsole'
import { RuntimeBatchList } from '../components/monitoring/RuntimeBatchList'
import { RuntimeTaskList } from '../components/monitoring/RuntimeTaskList'
import { RuntimeAgentTree } from '../components/monitoring/RuntimeAgentTree'
import { RuntimeActivityTimeline } from '../components/monitoring/RuntimeActivityTimeline'
import { RuntimeFreshnessBadge } from '../components/monitoring/RuntimeFreshnessBadge'
import { formatAge } from '../lib/runtime-format'
import { agentRoleLabels } from '../lib/labels'
import { buildRuntimeTaskEventPage } from '../lib/runtime-timeline'

const { Title, Text } = Typography

const MOBILE_BREAKPOINT = 768
const DESKTOP_HISTORY_PAGE_SIZE = 60
const MOBILE_HISTORY_PAGE_SIZE = 30

function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== 'undefined' && window.innerWidth < MOBILE_BREAKPOINT,
  )
  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < MOBILE_BREAKPOINT)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return isMobile
}

/**
 * 真实运行监控台（V1.5 方案 §8）。
 *
 * 这个页面上每一句「正在……」都对应一条未闭合的 `phase='STARTED'` 事件与一行 node 投影。
 * 界面**不会**根据计数增长、工具名称或超时自行猜测阶段：没有后端事实的东西就明确显示
 * 「不可展开」或「未知」，而不是画一个看起来在动的进度条。
 *
 * 权限：导航仅 ADMIN 可见，这里再校验一次 `isAdmin`，而最终边界是服务端
 * `admin_list_active_analysis_batches` 的 `ensure_admin()` 与
 * `get_analysis_runtime_console` 的 `ensure_manage_review_batch()`。
 *
 * 与现有轮询的关系：这是唯一使用 cursor 模型的页面。批次详情页与 Worker 管理页继续用
 * 各自的固定间隔快照轮询，两者职责不重叠，同一屏不会出现两个不同的「最后更新时间」。
 */
export function RuntimeMonitoringPage({ isAdmin }: { isAdmin: boolean }) {
  const isMobile = useIsMobile()
  const [pickedBatchId, setPickedBatchId] = useState<string | null>(null)
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  /**
   * 每个任务各自记住选中的 Attempt。
   *
   * 用一张 map 而不是「切换任务时 setState(null)」：后者要在 effect 里同步 setState，
   * 会触发一轮多余渲染。Attempt 不存在时 RuntimeAgentTree 会自动落到最新一次。
   */
  const [attemptByTask, setAttemptByTask] = useState<Record<string, number>>({})
  const [historyPageSelection, setHistoryPageSelection] = useState<{
    taskId: string | null
    index: number
  }>({ taskId: null, index: 0 })

  const batchesQuery = useQuery({
    queryKey: ['runtime-active-batches'],
    enabled: isAdmin,
    queryFn: adminListActiveAnalysisBatches,
    refetchInterval: 5000,
    refetchIntervalInBackground: false,
    staleTime: 3000,
  })
  const workersQuery = useQuery({
    queryKey: ['runtime-analysis-workers'],
    enabled: isAdmin,
    // 在线 Worker 与槽位不在监控 RPC 里重算：直接复用已有的 admin_list_analysis_workers。
    queryFn: adminListAnalysisWorkers,
    refetchInterval: 5000,
    refetchIntervalInBackground: false,
    staleTime: 3000,
  })

  const batches = batchesQuery.data?.batches ?? []
  const serverTime = batchesQuery.data?.server_time ?? new Date().toISOString()

  // 默认落到第一个活动批次；用户选中的批次消失后自动落到下一个。
  // 这是在渲染期派生的，不需要 effect —— 也就不会因为 batches 每次渲染都是新数组而抖动。
  const selectedBatchId =
    pickedBatchId !== null && batches.some((batch) => batch.batch_id === pickedBatchId)
      ? pickedBatchId
      : (batches[0]?.batch_id ?? null)

  const activeBatch = batches.find((batch) => batch.batch_id === selectedBatchId) ?? null
  const isBatchActive =
    activeBatch !== null &&
    ['QUEUED', 'PREPARING_CODE', 'PROCESSING', 'FINALIZING'].includes(activeBatch.job_status)

  const console = useRuntimeConsole({
    batchId: selectedBatchId,
    // 非活动批次降频到 15 秒：它不会再产生新事件，2.5 秒补拉纯属浪费。
    cursorIntervalMs: isBatchActive ? 2500 : 15000,
    snapshotIntervalMs: isBatchActive ? 12000 : 30000,
  })

  const selectedTask =
    console.tasks.find((task) => task.task_id === selectedTaskId) ??
    console.tasks.find((task) => task.agent_status === 'RUNNING') ??
    console.tasks[0] ??
    null

  const historyPageSize = isMobile ? MOBILE_HISTORY_PAGE_SIZE : DESKTOP_HISTORY_PAGE_SIZE
  const taskHistoryQuery = useInfiniteQuery({
    queryKey: ['runtime-task-event-history', selectedTask?.task_id ?? null, historyPageSize],
    enabled: isAdmin && selectedTask !== null,
    initialPageParam: null as number | null,
    queryFn: ({ pageParam }) => {
      if (selectedTask === null) throw new Error('请先选择需求任务')
      return getAnalysisRuntimeTaskEvents(selectedTask.task_id, pageParam, historyPageSize)
    },
    getNextPageParam: (lastPage) =>
      lastPage.cursor.has_more
        ? (lastPage.cursor.next_before_event_id ?? undefined)
        : undefined,
    staleTime: 5000,
    refetchOnWindowFocus: false,
  })

  const historyPages = taskHistoryQuery.data?.pages ?? []
  const requestedHistoryPageIndex =
    historyPageSelection.taskId === selectedTask?.task_id ? historyPageSelection.index : 0
  const historyPageIndex = Math.min(
    requestedHistoryPageIndex,
    Math.max(historyPages.length - 1, 0),
  )
  const historyPage = historyPages[historyPageIndex] ?? null
  const timelineEvents = useMemo(
    () =>
      buildRuntimeTaskEventPage(
        historyPage?.events ?? [],
        console.events,
        selectedTask?.task_id ?? null,
        historyPageIndex === 0,
      ),
    [historyPage, console.events, selectedTask?.task_id, historyPageIndex],
  )
  const taskAnchorCount = timelineEvents.filter((event) => event.scope === 'TASK').length
  const liveAttemptUuids = new Set((historyPage?.events ?? []).map((event) => event.event_uuid))
  const liveAttemptDelta = historyPageIndex === 0
    ? console.events.filter(
        (event) =>
          event.task_id === selectedTask?.task_id &&
          event.scope !== 'TASK' &&
          !liveAttemptUuids.has(event.event_uuid),
      ).length
    : 0
  const historyAttemptTotal = Math.max(
    (historyPage?.total_events ?? 0) + liveAttemptDelta,
    historyPage?.events.length ?? 0,
  )
  const historyTotal = historyAttemptTotal + taskAnchorCount
  const historyPageCount = Math.max(Math.ceil(historyAttemptTotal / historyPageSize), 1)
  const historyHasNewer = historyPageIndex > 0
  const historyHasOlder =
    historyPageIndex + 1 < historyPages.length || taskHistoryQuery.hasNextPage === true

  const showNewerHistory = () => {
    if (selectedTask === null || historyPageIndex === 0) return
    setHistoryPageSelection({ taskId: selectedTask.task_id, index: historyPageIndex - 1 })
  }

  const showOlderHistory = () => {
    if (selectedTask === null || !historyHasOlder || taskHistoryQuery.isFetchingNextPage) return
    const nextIndex = historyPageIndex + 1
    if (nextIndex < historyPages.length) {
      setHistoryPageSelection({ taskId: selectedTask.task_id, index: nextIndex })
      return
    }
    const taskId = selectedTask.task_id
    void taskHistoryQuery.fetchNextPage().then((result) => {
      if (result.data?.pages[nextIndex] !== undefined) {
        setHistoryPageSelection({ taskId, index: nextIndex })
      }
    })
  }

  const cursorServerTime = console.cursor?.server_time ?? serverTime
  const now = Date.parse(cursorServerTime)

  const selectedAttemptNumber = useMemo(() => {
    if (selectedTask === null || selectedTask.attempts.length === 0) return null
    const requested = attemptByTask[selectedTask.task_id]
    if (
      requested !== undefined &&
      selectedTask.attempts.some((attempt) => attempt.agent_attempt === requested)
    ) {
      return requested
    }
    return selectedTask.attempts[selectedTask.attempts.length - 1]!.agent_attempt
  }, [selectedTask, attemptByTask])

  const selectedAttemptSnapshot = useMemo(
    () =>
      selectedTask?.attempts.find(
        (attempt) => attempt.agent_attempt === selectedAttemptNumber,
      ) ?? null,
    [selectedTask, selectedAttemptNumber],
  )

  const agentOptions = useMemo(() => {
    return (selectedAttemptSnapshot?.agents ?? []).map((agent) => ({
      value: agent.agent_node_id,
      label: `${agentRoleLabels[agent.agent_role] ?? agent.agent_role} · ${agent.agent_id.slice(0, 8)}`,
    }))
  }, [selectedAttemptSnapshot])

  const workers = workersQuery.data?.workers ?? []
  const onlineWorkers = workers.length
  const busySlots = workers.reduce((total, worker) => total + worker.reported_current_tasks, 0)
  const totalSlots = workers.reduce((total, worker) => total + worker.slots, 0)

  const linkFreshness = computeRuntimeFreshness({
    serverTime: cursorServerTime,
    lastEventAt: console.batch?.last_event_at ?? activeBatch?.last_event_at ?? null,
    watermarkLagMs: console.cursor?.watermark_lag_ms ?? activeBatch?.watermark_lag_ms ?? null,
    heartbeatAt: null,
    isRunning: (console.batch?.running_stories ?? 0) > 0,
  })

  if (!isAdmin) {
    return (
      <Alert
        type="error"
        showIcon
        title="无权限访问"
        description="只有管理员可以查看真实运行监控台。服务端同样会拒绝非管理员的请求。"
      />
    )
  }

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Space direction="vertical" size={4} style={{ width: '100%' }}>
        <Title level={4} style={{ marginBottom: 0 }}>
          真实运行监控台
        </Title>
        <Text type="secondary">
          这里的每一条活动都由后端执行边界产生并被数据库接受。不足 800 毫秒就返回的工具
          不会出现「正在调用」态，只出现在已完成历史里 —— 监控台关心的是卡住的工具，
          不是闪过的工具。
        </Text>
      </Space>

      {batchesQuery.isError ? (
        <Alert
          type="error"
          showIcon
          title="读取活动批次失败"
          description={
            batchesQuery.error instanceof Error ? batchesQuery.error.message : '未知错误'
          }
        />
      ) : null}
      {console.error === null ? null : (
        <Alert
          type="warning"
          showIcon
          title="监控数据读取失败"
          description={`${console.error}。分析任务本身不受影响：事件链路故障不会把任务判定为失败。`}
        />
      )}
      {console.resetCount > 0 ? (
        <Alert
          type="info"
          showIcon
          title="本地时间线已重建"
          description={`游标早于事件保留期，已丢弃本地状态重新做全量快照（发生 ${String(console.resetCount)} 次）。`}
        />
      ) : null}

      <Card title="链路概览">
        <Row gutter={[16, 16]}>
          <Col xs={12} md={6}>
            <Statistic title="活动批次" value={batches.length} />
          </Col>
          <Col xs={12} md={6}>
            <Statistic
              title="运行中 / 等待需求"
              value={`${String(console.batch?.running_stories ?? 0)} / ${String(console.batch?.pending_stories ?? 0)}`}
            />
          </Col>
          <Col xs={12} md={6}>
            <Statistic
              title="成功 / 失败需求"
              value={`${String(console.batch?.succeeded_stories ?? 0)} / ${String(console.batch?.failed_stories ?? 0)}`}
            />
          </Col>
          <Col xs={12} md={6}>
            <Statistic
              title="在线 Worker / 占用槽位"
              value={`${String(onlineWorkers)} · ${String(busySlots)}/${String(totalSlots)}`}
            />
          </Col>
          <Col xs={24} md={12}>
            <Space direction="vertical" size={2}>
              <Text type="secondary">事件链路健康</Text>
              <Space wrap size={[8, 4]}>
                <RuntimeFreshnessBadge
                  freshness={linkFreshness}
                  detail={`确认滞后 ${String(console.cursor?.watermark_lag_ms ?? 0)} ms`}
                />
                <Text type="secondary">
                  最近事件 {formatAge(console.batch?.last_event_at ?? null, now)}
                </Text>
                <Text type="secondary">游标 #{console.appliedEventId ?? '—'}</Text>
              </Space>
            </Space>
          </Col>
          <Col xs={24} md={12}>
            <Space>
              <Button size="small" onClick={console.refresh} loading={console.loading}>
                立即重新快照
              </Button>
              {isBatchActive ? null : (
                <Text type="secondary">该批次已终态，自动刷新已降频。</Text>
              )}
            </Space>
          </Col>
        </Row>
      </Card>

      <RuntimeBatchList
        batches={batches}
        serverTime={serverTime}
        selectedBatchId={selectedBatchId}
        onSelect={(batchId) => {
          setPickedBatchId(batchId)
          setSelectedTaskId(null)
        }}
        isMobile={isMobile}
      />

      <div className="runtime-workbench">
        <aside className="runtime-workbench__master">
          <RuntimeTaskList
            tasks={console.tasks}
            serverTime={cursorServerTime}
            watermarkLagMs={console.cursor?.watermark_lag_ms ?? null}
            selectedTaskId={selectedTask?.task_id ?? null}
            onSelect={setSelectedTaskId}
            isMobile={isMobile}
          />
        </aside>

        <section className="runtime-workbench__detail">
          <RuntimeAgentTree
            task={selectedTask}
            selectedAttempt={selectedAttemptNumber}
            onSelectAttempt={(attempt) => {
              if (selectedTask === null) return
              setAttemptByTask((previous) => ({ ...previous, [selectedTask.task_id]: attempt }))
            }}
            now={now}
          />

          {taskHistoryQuery.isError ? (
            <Alert
              type="warning"
              showIcon
              title="读取需求历史失败"
              description={
                taskHistoryQuery.error instanceof Error
                  ? taskHistoryQuery.error.message
                  : '无法读取更早的 Attempt 事件'
              }
            />
          ) : null}

          <RuntimeActivityTimeline
            events={timelineEvents}
            serverTime={cursorServerTime}
            agentOptions={agentOptions}
            attempts={selectedTask?.attempts ?? []}
            taskId={selectedTask?.task_id ?? null}
            taskLabel={
              selectedTask === null
                ? null
                : `${selectedTask.story_code} · ${selectedTask.story_name}`
            }
            historyPage={historyPageIndex + 1}
            historyPageCount={historyPageCount}
            historyTotal={historyTotal}
            historyHasNewer={historyHasNewer}
            historyHasOlder={historyHasOlder}
            historyLoading={taskHistoryQuery.isLoading || taskHistoryQuery.isFetchingNextPage}
            onHistoryNewer={showNewerHistory}
            onHistoryOlder={showOlderHistory}
          />
        </section>
      </div>
    </Space>
  )
}
