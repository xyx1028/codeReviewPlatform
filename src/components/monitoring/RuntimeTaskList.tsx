import { useMemo, useState } from 'react'
import { Card, Empty, Input, Tag, Typography } from 'antd'
import type { RuntimeTaskSnapshot } from '../../types'
import {
  runtimeActivityLabel,
  runtimeErrorCodeLabel,
  storyTaskStatusMeta,
} from '../../lib/labels'
import { RuntimeFreshnessBadge } from './RuntimeFreshnessBadge'
import { formatAge, formatElapsed } from '../../lib/runtime-format'
import { computeRuntimeFreshness } from '../../hooks/useRuntimeConsole'

const { Text } = Typography

/** 一个任务的当前真实活动摘要：attempt 阶段 + 最近更新的运行中 Agent 活动。 */
function currentActivity(task: RuntimeTaskSnapshot): {
  label: string
  startedAt: string | null
  agentCount: number
  maxDepth: number
  openCount: number
} {
  const attempt = task.attempts[task.attempts.length - 1] ?? null
  if (attempt === null) {
    return { label: '尚未开始', startedAt: null, agentCount: 0, maxDepth: 0, openCount: 0 }
  }
  const running = [...attempt.agents]
    .filter((agent) => agent.current_activity_status === 'RUNNING')
    .sort((a, b) =>
      (b.current_activity_updated_at ?? '').localeCompare(a.current_activity_updated_at ?? ''),
    )
  const latest = running[0]
  const openCount = attempt.agents.reduce(
    (total, agent) => total + agent.open_correlations.length,
    0,
  )
  if (latest !== undefined) {
    const activity = runtimeActivityLabel(latest.current_activity_code)
    return {
      label: latest.current_tool_name === null ? activity : `${activity}：${latest.current_tool_name}`,
      startedAt: latest.current_activity_started_at,
      agentCount: attempt.agents.filter((agent) => agent.status === 'RUNNING').length,
      maxDepth: attempt.max_depth_reached,
      openCount,
    }
  }
  return {
    label: runtimeActivityLabel(attempt.attempt_phase_code),
    startedAt: attempt.attempt_phase_started_at,
    agentCount: attempt.agents.filter((agent) => agent.status === 'RUNNING').length,
    maxDepth: attempt.max_depth_reached,
    openCount,
  }
}

function shortWorker(workerId: string | null): string {
  if (workerId === null) return '未分配 Worker'
  const normalized = workerId.replace(/^worker-/, '')
  return normalized.length <= 12 ? normalized : normalized.slice(-12)
}

/** 紧凑的需求主列表。桌面端由父级工作台控制高度并在卡片内部滚动。 */
export function RuntimeTaskList({
  tasks,
  serverTime,
  watermarkLagMs,
  selectedTaskId,
  onSelect,
  isMobile,
}: {
  tasks: RuntimeTaskSnapshot[]
  serverTime: string
  watermarkLagMs: number | null
  selectedTaskId: string | null
  onSelect(taskId: string): void
  isMobile: boolean
}) {
  const [query, setQuery] = useState('')
  const now = Date.parse(serverTime)
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const visibleTasks = useMemo(
    () =>
      normalizedQuery === ''
        ? tasks
        : tasks.filter((task) =>
            `${task.story_code} ${task.story_name} ${task.project_name ?? ''} ${task.application_name ?? ''}`
              .toLocaleLowerCase()
              .includes(normalizedQuery),
          ),
    [tasks, normalizedQuery],
  )

  const freshnessOf = (task: RuntimeTaskSnapshot) =>
    computeRuntimeFreshness({
      serverTime,
      lastEventAt: task.last_event_at,
      watermarkLagMs,
      heartbeatAt: task.agent_status === 'RUNNING' ? task.heartbeat_at : null,
      isRunning: task.agent_status === 'RUNNING',
    })

  const running = tasks.filter((task) => task.agent_status === 'RUNNING').length
  const failed = tasks.filter((task) => task.agent_status === 'FAILED').length

  return (
    <Card
      size="small"
      className={`runtime-task-nav${isMobile ? ' runtime-task-nav--mobile' : ''}`}
      title={
        <div className="runtime-task-nav__heading">
          <span>需求任务</span>
          <Text type="secondary">{tasks.length} 项</Text>
        </div>
      }
      extra={
        <div className="runtime-task-nav__summary">
          <span className="runtime-status-dot runtime-status-dot--running" />
          <span>{running}</span>
          {failed > 0 ? (
            <>
              <span className="runtime-status-dot runtime-status-dot--failed" />
              <span>{failed}</span>
            </>
          ) : null}
        </div>
      }
    >
      {tasks.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="这个批次还没有需求任务" />
      ) : (
        <>
          <div className="runtime-task-search">
            <Input
              allowClear
              size="small"
              value={query}
              placeholder="搜索需求编号或名称"
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <div className="runtime-task-scroll" role="listbox" aria-label="需求任务">
            {visibleTasks.length === 0 ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有匹配的需求" />
            ) : (
              visibleTasks.map((task) => {
                const status = storyTaskStatusMeta[task.agent_status]
                const activity = currentActivity(task)
                const errorLabel = runtimeErrorCodeLabel(task.error_code)
                const selected = task.task_id === selectedTaskId
                return (
                  <button
                    key={task.task_id}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    className={`runtime-task-item${selected ? ' runtime-task-item--selected' : ''}`}
                    onClick={() => onSelect(task.task_id)}
                  >
                    <div className="runtime-task-item__topline">
                      <strong>{task.story_code}</strong>
                      <Tag bordered={false} color={status?.color ?? 'default'}>
                        {status?.label ?? task.agent_status}
                      </Tag>
                      {task.agent_attempt > 1 ? <Tag>重试 {task.agent_attempt}</Tag> : null}
                    </div>
                    <div className="runtime-task-item__name" title={task.story_name}>
                      {task.story_name}
                    </div>
                    <div className="runtime-task-item__activity">
                      <span className={activity.openCount > 0 ? 'is-live' : ''}>{activity.label}</span>
                      {activity.startedAt === null
                        ? null
                        : <span> · {formatElapsed(activity.startedAt, now)}</span>}
                    </div>
                    {task.agent_status === 'RUNNING' ? (
                      <div className="runtime-task-item__meta">
                        <span>{shortWorker(task.worker_id)}</span>
                        <span>运行中 Agent {activity.agentCount}</span>
                        {activity.maxDepth > 0 ? <span>深度 {activity.maxDepth}</span> : null}
                        <span>{formatAge(task.last_event_at, now)}</span>
                        <RuntimeFreshnessBadge freshness={freshnessOf(task)} />
                      </div>
                    ) : null}
                    {errorLabel === null ? null : (
                      <div className="runtime-task-item__error">{errorLabel}</div>
                    )}
                  </button>
                )
              })
            )}
          </div>
        </>
      )}
    </Card>
  )
}
