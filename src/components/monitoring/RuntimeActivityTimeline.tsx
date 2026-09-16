import { useMemo, useState } from 'react'
import {
  Button,
  Card,
  Collapse,
  Drawer,
  Empty,
  Segmented,
  Select,
  Switch,
  Tag,
  Typography,
} from 'antd'
import type {
  RuntimeAttemptSnapshot,
  RuntimeEvent,
  RuntimeEventPayload,
  RuntimeEventScope,
} from '../../types'
import {
  modelRequestKindLabels,
  runtimeActivityLabel,
  runtimeErrorCodeLabel,
  runtimeEventTypeLabel,
} from '../../lib/labels'
import { formatAge, formatDuration } from '../../lib/runtime-format'
import {
  buildRuntimeTimelineGroups,
  eventsForRuntimeTask,
  isRuntimeFailure,
  type RuntimeTimelineCluster,
  type RuntimeTimelineGroup,
} from '../../lib/runtime-timeline'

const { Text } = Typography

const SCOPE_LABELS: Record<RuntimeEventScope, string> = {
  JOB: '批次',
  TASK: '需求',
  ATTEMPT: 'Attempt',
  AGENT: 'Agent',
  MODEL: '模型',
  TOOL: '工具',
  WORKFLOW: 'Workflow',
  HARNESS_JOB: 'Harness Job',
}

const SCOPE_COLORS: Record<RuntimeEventScope, string> = {
  JOB: 'cyan',
  TASK: 'geekblue',
  ATTEMPT: 'blue',
  AGENT: 'magenta',
  MODEL: 'purple',
  TOOL: 'orange',
  WORKFLOW: 'default',
  HARNESS_JOB: 'default',
}

const ATTEMPT_STATUS: Record<string, { label: string; color: string }> = {
  RUNNING: { label: '运行中', color: 'processing' },
  COMMITTED: { label: '已提交', color: 'success' },
  FAILED: { label: '失败', color: 'error' },
}

/** payload 只渲染前端已知的白名单字段，刻意不提供通用 JSON viewer。 */
function payloadChips(payload: RuntimeEventPayload): string[] {
  const chips: string[] = []
  if (payload.tool_name !== undefined) chips.push(payload.tool_name)
  if (payload.model_request_kind !== undefined) {
    chips.push(modelRequestKindLabels[payload.model_request_kind] ?? payload.model_request_kind)
  }
  if (payload.repository_name !== undefined) chips.push(payload.repository_name)
  if (payload.agent_role !== undefined) chips.push(payload.agent_role)
  if (payload.delegation_depth !== undefined) chips.push(`深度 ${String(payload.delegation_depth)}`)
  if (payload.attempt_number !== undefined) chips.push(`第 ${String(payload.attempt_number)} 次`)
  if (payload.agent_count !== undefined) chips.push(`Agent ${String(payload.agent_count)}`)
  if (payload.retry_index !== undefined && payload.retry_index > 0) {
    chips.push(`重试 ${String(payload.retry_index)}`)
  }
  if (payload.exit_code !== undefined) chips.push(`退出码 ${String(payload.exit_code)}`)
  if (payload.hit_count !== undefined) chips.push(`命中 ${String(payload.hit_count)}`)
  if (payload.line_span !== undefined) chips.push(`${String(payload.line_span)} 行`)
  if (payload.output_bytes !== undefined) chips.push(`输出 ${String(payload.output_bytes)} B`)
  if (payload.truncated === true) chips.push('已截断')
  if (payload.input_tokens !== undefined || payload.output_tokens !== undefined) {
    const input = payload.input_tokens ?? null
    const output = payload.output_tokens ?? null
    chips.push(
      `Token ${input === null ? '未上报' : String(input)} / ${output === null ? '未上报' : String(output)}`,
    )
  }
  if (payload.events_reported !== undefined) chips.push(`上报 ${String(payload.events_reported)}`)
  if (payload.events_dropped !== undefined) chips.push(`丢弃 ${String(payload.events_dropped)}`)
  if (payload.reason_code !== undefined) {
    chips.push(runtimeErrorCodeLabel(payload.reason_code) ?? payload.reason_code)
  }
  return chips
}

function elapsed(group: RuntimeTimelineGroup): number | null {
  if (group.startedAt === null || group.finishedAt === null) return null
  const value = Date.parse(group.finishedAt) - Date.parse(group.startedAt)
  return Number.isFinite(value) && value >= 0 ? value : null
}

function groupHeader(group: RuntimeTimelineGroup) {
  if (group.attempt === null) {
    return (
      <div className="runtime-attempt-header">
        <div className="runtime-attempt-header__title">
          <span className="runtime-attempt-index">任务阶段</span>
          <Text type="secondary">领取与仓库准备；结论提交归入 Attempt</Text>
        </div>
        <Text type="secondary" className="runtime-attempt-header__stats">
          本页 {group.events.length} 条事件
        </Text>
      </div>
    )
  }

  const status = ATTEMPT_STATUS[group.attempt.status] ?? {
    label: group.attempt.status,
    color: 'default',
  }
  const duration = elapsed(group)
  return (
    <div className="runtime-attempt-header">
      <div className="runtime-attempt-header__title">
        <span className="runtime-attempt-index">Attempt #{group.attempt.agent_attempt}</span>
        <Tag color={status.color}>{status.label}</Tag>
        {group.failures > 0 ? <Tag color="error">{group.failures} 个异常</Tag> : null}
      </div>
      <div className="runtime-attempt-header__stats">
        <span>本页 {group.events.length} 条事件</span>
        {duration === null ? null : <span>{formatDuration(duration)}</span>}
      </div>
    </div>
  )
}

function eventTitle(cluster: RuntimeTimelineCluster): string {
  if (cluster.kind === 'setup') return '运行环境准备完成'
  return runtimeEventTypeLabel(cluster.representative.event_type)
}

function eventRow(
  cluster: RuntimeTimelineCluster,
  now: number,
  showCodes: boolean,
) {
  const event = cluster.representative
  const errorLabel = runtimeErrorCodeLabel(event.error_code)
  const chips = cluster.kind === 'setup'
    ? ['契约、快照、会话、工作区、Broker 与 Harness', `${cluster.count} 个步骤`]
    : payloadChips(event.payload)
  const duration = cluster.count > 1 ? cluster.totalDurationMs : event.duration_ms
  const dotKind = errorLabel !== null
    ? 'error'
    : event.phase === 'STARTED'
      ? 'running'
      : 'complete'

  return (
    <div
      className={`runtime-event-row runtime-event-row--${dotKind}`}
      key={cluster.key}
      role="listitem"
    >
      <time className="runtime-event-time" dateTime={event.occurred_at}>
        {formatAge(event.occurred_at, now)}
      </time>
      <div className={`runtime-event-dot runtime-event-dot--${dotKind}`} aria-hidden="true" />
      <div className="runtime-event-content">
        <div className="runtime-event-mainline">
          <Tag bordered={false} color={SCOPE_COLORS[event.scope]}>
            {SCOPE_LABELS[event.scope]}
          </Tag>
          <Text strong>{eventTitle(cluster)}</Text>
          {cluster.count > 1 ? <Tag>×{cluster.count}</Tag> : null}
          {event.phase === 'STARTED' ? <Tag color="processing">进行中</Tag> : null}
          {duration === null ? null : <Tag bordered={false}>{formatDuration(duration)}</Tag>}
          {event.clock_skewed ? <Tag color="gold">时钟偏差</Tag> : null}
        </div>
        {chips.length === 0 ? null : (
          <div className="runtime-event-meta">
            {chips.map((chip) => <span key={chip}>{chip}</span>)}
          </div>
        )}
        {errorLabel === null ? null : <Text type="danger">{errorLabel}</Text>}
        {showCodes ? (
          <code className="runtime-event-code">
            #{event.event_id} · {event.event_type} · {runtimeActivityLabel(event.activity_code)}
            {event.correlation_id === null ? '' : ` · corr ${event.correlation_id.slice(0, 8)}`}
          </code>
        ) : null}
      </div>
    </div>
  )
}

/** 当前需求的运行事实：按 Attempt 折叠，默认精简，完整技术事件可随时切换查看。 */
export function RuntimeActivityTimeline({
  events,
  serverTime,
  agentOptions,
  attempts,
  taskId,
  taskLabel,
  historyPage,
  historyPageCount,
  historyTotal,
  historyHasNewer,
  historyHasOlder,
  historyLoading,
  onHistoryNewer,
  onHistoryOlder,
}: {
  events: RuntimeEvent[]
  serverTime: string
  agentOptions: Array<{ value: string; label: string }>
  attempts: RuntimeAttemptSnapshot[]
  taskId: string | null
  taskLabel: string | null
  historyPage: number
  historyPageCount: number
  historyTotal: number
  historyHasNewer: boolean
  historyHasOlder: boolean
  historyLoading: boolean
  onHistoryNewer(): void
  onHistoryOlder(): void
}) {
  const [scopeFilter, setScopeFilter] = useState<RuntimeEventScope[]>([])
  const [agentSelection, setAgentSelection] = useState<{
    taskId: string | null
    value: string | null
  }>({ taskId, value: null })
  const [failuresOnly, setFailuresOnly] = useState(false)
  const [compact, setCompact] = useState(true)
  const [showCodes, setShowCodes] = useState(false)
  const [openSelection, setOpenSelection] = useState<{
    context: string
    value: string | null
  } | null>(null)
  const [detailSelection, setDetailSelection] = useState<{
    taskId: string
    groupKey: string
  } | null>(null)
  const agentFilter = agentSelection.taskId === taskId ? agentSelection.value : null
  const now = Date.parse(serverTime)

  const matched = useMemo(() => {
    const scoped = eventsForRuntimeTask(events, taskId)
    return scoped.filter((event) => {
      if (scopeFilter.length > 0 && !scopeFilter.includes(event.scope)) return false
      if (agentFilter !== null && event.agent_node_id !== agentFilter) return false
      if (failuresOnly && !isRuntimeFailure(event)) return false
      return true
    })
  }, [events, taskId, scopeFilter, agentFilter, failuresOnly])

  const groups = useMemo(
    () => buildRuntimeTimelineGroups(matched, attempts, compact),
    [matched, attempts, compact],
  )
  const preferredKey = groups.find((group) => group.attempt === null)?.key ?? null
  const openContext = taskId ?? 'none'
  const activeKey =
    openSelection?.context === openContext ? openSelection.value : preferredKey
  const detailGroup =
    detailSelection?.taskId === taskId
      ? (groups.find((group) => group.key === detailSelection.groupKey) ?? null)
      : null

  const renderedRows = groups.reduce((total, group) => total + group.clusters.length, 0)
  const hiddenByCompact = compact ? Math.max(matched.length - renderedRows, 0) : 0

  return (
    <Card
      className="runtime-timeline-card"
      title={
        <div className="runtime-timeline-title">
          <span>运行时间线</span>
          <Text type="secondary" ellipsis>{taskLabel ?? '请先选择需求'}</Text>
        </div>
      }
    >
      <div className="runtime-timeline-toolbar">
        <div className="runtime-timeline-view-switch">
          <Segmented
            size="small"
            value={compact ? 'compact' : 'full'}
            onChange={(value) => setCompact(value === 'compact')}
            options={[
              { label: '精简视图', value: 'compact' },
              { label: '完整日志', value: 'full' },
            ]}
          />
          <Text type="secondary">
            当前需求共 {historyTotal} 条，本页 {matched.length} 条
            {hiddenByCompact > 0 ? `，已收起 ${String(hiddenByCompact)} 条重复/配对事件` : ''}
          </Text>
        </div>
        <div className="runtime-timeline-filters">
          <Select<RuntimeEventScope[]>
            mode="multiple"
            allowClear
            maxTagCount="responsive"
            size="small"
            placeholder="事件类型"
            value={scopeFilter}
            onChange={setScopeFilter}
            options={(Object.keys(SCOPE_LABELS) as RuntimeEventScope[]).map((scope) => ({
              value: scope,
              label: SCOPE_LABELS[scope],
            }))}
          />
          {agentOptions.length > 0 ? (
            <Select<string | null>
              allowClear
              size="small"
              placeholder="Agent"
              value={agentFilter}
              onChange={(value) => {
                setAgentSelection({ taskId, value: value ?? null })
              }}
              options={agentOptions}
            />
          ) : null}
          <label className="runtime-timeline-toggle">
            <Switch size="small" checked={failuresOnly} onChange={setFailuresOnly} />
            <span>仅异常</span>
          </label>
          <label className="runtime-timeline-toggle">
            <Switch size="small" checked={showCodes} onChange={setShowCodes} />
            <span>技术码</span>
          </label>
        </div>
      </div>

      {groups.length === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={
            taskId === null
              ? '选择一个需求后查看运行事实'
              : matched.length === 0
                ? '没有符合过滤条件的事件'
                : '还没有运行事实事件'
          }
        />
      ) : (
        <>
          <Collapse
            accordion
            size="small"
            className="runtime-attempt-collapse"
            activeKey={activeKey === null ? [] : [activeKey]}
            onChange={(key) => {
              const next = Array.isArray(key) ? key[0] : key
              setOpenSelection({
                context: openContext,
                value: typeof next === 'string' ? next : null,
              })
            }}
            items={groups.map((group) => {
              const isTaskStage = group.attempt === null
              return {
                key: group.key,
                label: groupHeader(group),
                showArrow: isTaskStage,
                collapsible: isTaskStage ? 'header' as const : 'icon' as const,
                extra: isTaskStage ? null : (
                  <Button
                    type="link"
                    size="small"
                    className="runtime-attempt-detail-button"
                    onClick={(event) => {
                      event.stopPropagation()
                      if (taskId === null) return
                      setDetailSelection({ taskId, groupKey: group.key })
                    }}
                  >
                    查看完整详情
                  </Button>
                ),
                children: isTaskStage ? (
                  <div className="runtime-event-list" role="list">
                    {group.clusters.map((item) => eventRow(item, now, showCodes))}
                  </div>
                ) : null,
              }
            })}
          />
          {taskId === null ? null : (
            <div className="runtime-timeline-pagination">
              <Button
                size="small"
                disabled={!historyHasNewer || historyLoading}
                onClick={onHistoryNewer}
              >
                较新一页
              </Button>
              <Text type="secondary">
                第 {historyPage} / {Math.max(historyPageCount, 1)} 页 · 共 {historyTotal} 条事件
              </Text>
              <Button
                size="small"
                disabled={!historyHasOlder}
                loading={historyLoading}
                onClick={onHistoryOlder}
              >
                更早一页
              </Button>
            </div>
          )}
        </>
      )}

      <Drawer
        className="runtime-attempt-detail-drawer"
        title={
          detailGroup?.attempt === null || detailGroup === null
            ? 'Attempt 完整详情'
            : `Attempt #${String(detailGroup.attempt.agent_attempt)} · 完整详情`
        }
        width="min(960px, 94vw)"
        open={detailGroup !== null}
        destroyOnHidden
        onClose={() => setDetailSelection(null)}
      >
        {detailGroup === null ? null : (
          <>
            <div className="runtime-attempt-detail-summary">
              {groupHeader(detailGroup)}
              <Text type="secondary">当前筛选条件与主页面保持一致</Text>
            </div>
            <div className="runtime-event-list runtime-event-list--drawer" role="list">
              {detailGroup.clusters.map((item) => eventRow(item, now, showCodes))}
            </div>
            <div className="runtime-timeline-pagination runtime-timeline-pagination--drawer">
              <Button
                size="small"
                disabled={!historyHasNewer || historyLoading}
                onClick={onHistoryNewer}
              >
                较新一页
              </Button>
              <Text type="secondary">
                第 {historyPage} / {Math.max(historyPageCount, 1)} 页 · 共 {historyTotal} 条事件
              </Text>
              <Button
                size="small"
                disabled={!historyHasOlder}
                loading={historyLoading}
                onClick={onHistoryOlder}
              >
                更早一页
              </Button>
            </div>
          </>
        )}
      </Drawer>
    </Card>
  )
}
