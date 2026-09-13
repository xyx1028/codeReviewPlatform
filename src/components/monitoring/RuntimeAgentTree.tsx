import { Alert, Card, Empty, Segmented, Space, Tag, Tooltip, Typography } from 'antd'
import type { RuntimeAgentSnapshot, RuntimeAttemptSnapshot, RuntimeTaskSnapshot } from '../../types'
import {
  agentNodeStatusMeta,
  agentProviderLabels,
  agentRoleLabels,
  agentRunStatusMeta,
  modelRequestKindLabels,
  runtimeActivityLabel,
  runtimeErrorCodeLabel,
} from '../../lib/labels'
import { formatAge, formatElapsed, formatTokens } from '../../lib/runtime-format'

const { Text } = Typography

/**
 * 单个 Agent 卡片。
 *
 * 并发 Agent 各自显示自己的活动 —— run 级摘要只是「最近发生的活动」，不能冒充唯一活动。
 * `open_correlations` 是「卡在哪」的直接答案：未闭合的工具/模型请求及其已持续时间。
 */
function AgentCard({ agent, now }: { agent: RuntimeAgentSnapshot; now: number }) {
  const statusMeta = agentNodeStatusMeta[agent.status]
  const isWorkflowChild = agent.provider === 'workflow'
  return (
    <Card
      size="small"
      style={{ marginLeft: agent.delegation_depth * 20 }}
      title={
        <Space wrap size={[6, 4]}>
          <Tag color={statusMeta?.color ?? 'default'}>{statusMeta?.label ?? agent.status}</Tag>
          <Text strong>{agentRoleLabels[agent.agent_role] ?? agent.agent_role}</Text>
          <Tag>{agentProviderLabels[agent.provider] ?? agent.provider}</Tag>
          <Text type="secondary">深度 {agent.delegation_depth}</Text>
        </Space>
      }
    >
      <Space direction="vertical" size={4} style={{ width: '100%' }}>
        <Text type="secondary">
          模型请求 {agent.model_requests} · 工具调用 {agent.tool_calls} · 证据{' '}
          {agent.evidence_produced}
        </Text>
        <Text type="secondary">
          输入 Token {formatTokens(agent.input_tokens)} · 输出 Token{' '}
          {formatTokens(agent.output_tokens)}
        </Text>

        {agent.current_activity_status === 'RUNNING' ? (
          <Text>
            {runtimeActivityLabel(agent.current_activity_code)}
            {agent.current_tool_name === null ? '' : `：${agent.current_tool_name}`}
            {agent.current_activity_started_at === null
              ? ''
              : ` · 已持续 ${formatElapsed(agent.current_activity_started_at, now)}`}
          </Text>
        ) : (
          <Text type="secondary">
            {agent.status === 'RUNNING' ? '当前无未闭合活动' : '已结束'}
            {agent.current_activity_updated_at === null
              ? ''
              : ` · 最后更新 ${formatAge(agent.current_activity_updated_at, now)}`}
          </Text>
        )}

        {agent.open_correlations.length === 0 ? null : (
          <Space direction="vertical" size={2} style={{ width: '100%' }}>
            <Text type="secondary">未闭合的调用（这就是「卡在哪」）：</Text>
            {agent.open_correlations.map((open) => (
              <Space key={open.correlation_id} wrap size={[6, 2]}>
                <Tag color={open.scope === 'MODEL' ? 'purple' : 'blue'}>
                  {open.scope === 'MODEL' ? '模型请求' : '工具调用'}
                </Tag>
                <Text code>
                  {open.tool_name ??
                    modelRequestKindLabels[open.model_request_kind ?? 'other'] ??
                    open.event_type}
                </Text>
                <Text type="secondary">已持续 {formatElapsed(open.started_at, now)}</Text>
              </Space>
            ))}
          </Space>
        )}

        {agent.error_code === null ? null : (
          <Text type="danger">{runtimeErrorCodeLabel(agent.error_code)}</Text>
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
      </Space>
    </Card>
  )
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

  return (
    <Card
      className="runtime-agent-tree-card"
      title={`Attempt 与 Agent Tree · ${task.story_code}`}
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
      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        <Space wrap size={[8, 4]}>
          <Tag color={runMeta?.color ?? 'default'}>{runMeta?.label ?? attempt.status}</Tag>
          <Text type="secondary">阶段：{runtimeActivityLabel(attempt.attempt_phase_code)}</Text>
          {attempt.attempt_phase_started_at === null ? null : (
            <Text type="secondary">
              已持续 {formatElapsed(attempt.attempt_phase_started_at, now)}
            </Text>
          )}
          <Text type="secondary">Agent {attempt.agent_count}</Text>
          <Text type="secondary">最大深度 {attempt.max_depth_reached}</Text>
          {attempt.resume_count > 0 ? <Tag color="gold">恢复 {attempt.resume_count} 次</Tag> : null}
        </Space>
        <Space wrap size={[8, 4]}>
          <Text type="secondary">模型请求 {attempt.model_requests}</Text>
          <Text type="secondary">工具调用 {attempt.tool_calls}</Text>
          <Tooltip title="provider 不上报时数据库保持 null，界面显示“未上报”而不是 0">
            <Text type="secondary">
              Token {formatTokens(attempt.input_tokens)} / {formatTokens(attempt.output_tokens)}
            </Text>
          </Tooltip>
          {attempt.cancel_reason === null ? null : (
            <Text type="danger">取消原因：{runtimeErrorCodeLabel(attempt.cancel_reason)}</Text>
          )}
          {attempt.error_code === null ? null : (
            <Text type="danger">错误码：{runtimeErrorCodeLabel(attempt.error_code)}</Text>
          )}
        </Space>

        {attempt.agents.length === 0 ? (
          // Agent 只有数据库注册成功后才出现。没有节点就是真的还没有节点。
          <Empty description="还没有任何 Agent 在数据库登记成功" />
        ) : (
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            {[...attempt.agents]
              .sort(
                (a, b) =>
                  a.delegation_depth - b.delegation_depth ||
                  (a.started_at ?? '').localeCompare(b.started_at ?? ''),
              )
              .map((agent) => (
                <AgentCard key={agent.agent_node_id} agent={agent} now={now} />
              ))}
          </Space>
        )}

        <div className="runtime-scope-note">
          <Tag bordered={false}>范围说明</Tag>
          <Text type="secondary">
            Harness Job 实例树尚未接入；job_* 调用仍会出现在右侧时间线中。
          </Text>
        </div>
      </Space>
    </Card>
  )
}
