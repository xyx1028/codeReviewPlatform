import { Alert, Card, Empty, Segmented, Tag, Tooltip, Typography } from 'antd'
import type { RuntimeAgentSnapshot, RuntimeAttemptSnapshot, RuntimeTaskSnapshot } from '../../types'
import {
  agentNodeStatusMeta,
  agentProviderLabels,
  agentRoleLabels,
  agentRunStatusMeta,
  runtimeActivityLabel,
  runtimeErrorCodeLabel,
} from '../../lib/labels'
import { formatAge, formatDuration, formatElapsed, formatTokens } from '../../lib/runtime-format'

const { Text } = Typography

/**
 * 单个 Agent 卡片。
 *
 * 并发 Agent 各自显示自己的活动 —— run 级摘要只是「最近发生的活动」，不能冒充唯一活动。
 * `open_correlations` 是「卡在哪」的直接答案：未闭合的工具/模型请求及其已持续时间。
 */
function AgentNode({ agent, now }: { agent: RuntimeAgentSnapshot; now: number }) {
  const statusMeta = agentNodeStatusMeta[agent.status]
  const isWorkflowChild = agent.provider === 'workflow'
  const statusKind = agent.status === 'RUNNING'
    ? 'running'
    : agent.status === 'FAILED'
      ? 'error'
      : agent.status === 'CANCELLED'
        ? 'cancelled'
        : 'complete'
  return (
    <div
      className="runtime-agent-node"
      style={{ marginLeft: agent.delegation_depth * 20 }}
    >
      <div className="runtime-agent-node__header">
        <div className="runtime-agent-node__identity">
          <span
            className={`runtime-agent-node__status runtime-agent-node__status--${statusKind}`}
            aria-hidden="true"
          />
          <Text strong>{agentRoleLabels[agent.agent_role] ?? agent.agent_role}</Text>
          <Tag bordered={false}>{agentProviderLabels[agent.provider] ?? agent.provider}</Tag>
          <span className="runtime-agent-node__depth">深度 {agent.delegation_depth}</span>
        </div>
        <Tag color={statusMeta?.color ?? 'default'}>{statusMeta?.label ?? agent.status}</Tag>
      </div>

      <div className="runtime-agent-node__metrics">
        <div><span>模型请求</span><strong>{agent.model_requests}</strong></div>
        <div><span>工具调用</span><strong>{agent.tool_calls}</strong></div>
        <div><span>证据</span><strong>{agent.evidence_produced}</strong></div>
        <div>
          <span>Token</span>
          <strong>{formatTokens(agent.input_tokens)} / {formatTokens(agent.output_tokens)}</strong>
        </div>
      </div>

      <div className={`runtime-agent-node__activity runtime-agent-node__activity--${statusKind}`}>
        {agent.current_activity_status === 'RUNNING' ? (
          <>
            {runtimeActivityLabel(agent.current_activity_code)}
            {agent.current_tool_name === null ? '' : `：${agent.current_tool_name}`}
            {agent.current_activity_started_at === null
              ? ''
              : ` · 已持续 ${formatElapsed(agent.current_activity_started_at, now)}`}
          </>
        ) : (
          <>
            {agent.status === 'RUNNING' ? '当前无未闭合活动' : '已结束'}
            {agent.current_activity_updated_at === null
              ? ''
              : ` · 最后更新 ${formatAge(agent.current_activity_updated_at, now)}`}
          </>
        )}
      </div>

      {agent.error_code === null ? null : (
        <div className="runtime-agent-node__error">{runtimeErrorCodeLabel(agent.error_code)}</div>
      )}

      {isWorkflowChild ? (
        // Phase 3 之前平台没有 Workflow 的真实生命周期边界，绝不展示伪造的步骤树。
        <Alert
          type="info"
          showIcon
          message="Workflow 子 Agent 已运行，步骤明细尚未接入"
          description="它调用 workflow 工具本身会正常出现在工具时间线里；Workflow 实例与步骤需要新增 Broker 协议后才可展开。"
        />
      ) : null}
    </div>
  )
}

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
      <Card title="Attempt 与 Agent Tree">
        <Empty description="选择一个需求任务" />
      </Card>
    )
  }
  if (task.attempts.length === 0) {
    return (
      <Card title="Attempt 与 Agent Tree">
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

        <div className="runtime-agent-tree-section">
          <div className="runtime-agent-tree-section__heading">
            <span>Agent 执行树</span>
            <Text type="secondary">按委派深度排列</Text>
          </div>
          {attempt.agents.length === 0 ? (
            // Agent 只有数据库注册成功后才出现。没有节点就是真的还没有节点。
            <Empty description="还没有任何 Agent 在数据库登记成功" />
          ) : (
            <div className="runtime-agent-tree-nodes">
              {[...attempt.agents]
                .sort(
                  (a, b) =>
                    a.delegation_depth - b.delegation_depth ||
                    (a.started_at ?? '').localeCompare(b.started_at ?? ''),
                )
                .map((agent) => (
                  <AgentNode key={agent.agent_node_id} agent={agent} now={now} />
                ))}
            </div>
          )}
        </div>

      </div>
    </Card>
  )
}
