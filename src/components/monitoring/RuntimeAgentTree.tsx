import { Card, Empty, Segmented, Tag, Tooltip, Typography } from 'antd'
import type { RuntimeAttemptSnapshot, RuntimeTaskSnapshot } from '../../types'
import { agentRunStatusMeta, runtimeActivityLabel, runtimeErrorCodeLabel } from '../../lib/labels'
import { formatDuration, formatElapsed, formatTokens } from '../../lib/runtime-format'

const { Text } = Typography

function attemptTiming(attempt: RuntimeAttemptSnapshot, now: number): string | null {
  if (attempt.started_at === null) return null
  if (attempt.status === 'RUNNING') return `已运行 ${formatElapsed(attempt.started_at, now)}`
  const finishedAt = attempt.finished_at ?? attempt.committed_at
  if (finishedAt === null) return null
  const duration = Date.parse(finishedAt) - Date.parse(attempt.started_at)
  return Number.isFinite(duration) && duration >= 0 ? `总耗时 ${formatDuration(duration)}` : null
}

/**
 * Attempt 切换器 + Agent Tree。
 *
 * Attempt 默认选最新一次；历史 Attempt 可切换 —— 一个被接管过两次的任务，
 * 只看最新一次是看不出「为什么重试」的。
 */
export function RuntimeAgentTree({
  task,
  selectedAttempt,
  onSelectAttempt,
  now,
}: {
  task: RuntimeTaskSnapshot | null
  selectedAttempt: number | null
  onSelectAttempt(attempt: number): void
  now: number
}) {
  if (task === null) {
    return (
      <Card title="执行概览">
        <Empty description="选择一个需求任务" />
      </Card>
    )
  }
  if (task.attempts.length === 0) {
    return (
      <Card title="执行概览">
        <Empty description="这个任务还没有 Attempt 运行事实" />
      </Card>
    )
  }

  const attempts = [...task.attempts].sort((a, b) => a.agent_attempt - b.agent_attempt)
  const latest = attempts[attempts.length - 1]!
  const attempt: RuntimeAttemptSnapshot =
    attempts.find((item) => item.agent_attempt === selectedAttempt) ?? latest
  const runMeta = agentRunStatusMeta[attempt.status]
  const timing = attemptTiming(attempt, now)

  return (
    <Card
      className="runtime-agent-tree-card"
      title={
        <div className="runtime-agent-tree-title">
          <span>执行概览</span>
          <Text type="secondary">{task.story_code}</Text>
        </div>
      }
      extra={
        attempts.length > 1 ? (
          <Segmented
            size="small"
            value={attempt.agent_attempt}
            onChange={(value) => onSelectAttempt(Number(value))}
            options={attempts.map((item) => ({
              value: item.agent_attempt,
              label: `第 ${String(item.agent_attempt)} 次`,
            }))}
          />
        ) : (
          <Text type="secondary">第 {attempt.agent_attempt} 次</Text>
        )
      }
    >
      <div className="runtime-agent-tree-layout">
        <div className="runtime-attempt-overview">
          <div className="runtime-attempt-overview__state">
            <div className="runtime-attempt-overview__state-main">
              <Tag color={runMeta?.color ?? 'default'}>{runMeta?.label ?? attempt.status}</Tag>
              <div>
                <strong>{runtimeActivityLabel(attempt.attempt_phase_code)}</strong>
                <span>第 {attempt.agent_attempt} 次执行{timing === null ? '' : ` · ${timing}`}</span>
              </div>
            </div>
            {attempt.resume_count > 0 ? <Tag color="gold">恢复 {attempt.resume_count} 次</Tag> : null}
          </div>

          <div className="runtime-attempt-overview__metrics">
            <div><span>Agent 总数</span><strong>{attempt.agent_count}</strong></div>
            <div><span>最大深度</span><strong>{attempt.max_depth_reached}</strong></div>
            <div><span>模型请求</span><strong>{attempt.model_requests}</strong></div>
            <div><span>工具调用</span><strong>{attempt.tool_calls}</strong></div>
            <Tooltip title="provider 不上报时数据库保持 null，界面显示“未上报”而不是 0">
              <div className="runtime-attempt-overview__token">
                <span>输入 / 输出 Token</span>
                <strong>{formatTokens(attempt.input_tokens)} / {formatTokens(attempt.output_tokens)}</strong>
              </div>
            </Tooltip>
          </div>

          {attempt.cancel_reason === null && attempt.error_code === null ? null : (
            <div className="runtime-attempt-overview__errors">
              {attempt.cancel_reason === null ? null : (
                <Text type="danger">取消原因：{runtimeErrorCodeLabel(attempt.cancel_reason)}</Text>
              )}
              {attempt.error_code === null ? null : (
                <Text type="danger">错误码：{runtimeErrorCodeLabel(attempt.error_code)}</Text>
              )}
            </div>
          )}
        </div>
      </div>
    </Card>
  )
}
