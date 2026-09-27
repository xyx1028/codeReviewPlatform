import { App as AntApp, Alert, Button, Card, Col, Empty, Row, Space, Statistic, Table, Tag, Tooltip, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useParams } from 'react-router-dom'
import { getAgentRunDetail, requestAttemptCancel } from '../lib/api'
import {
  agentNodeStatusMeta,
  agentProviderLabels,
  agentRoleLabels,
  agentRunStatusMeta,
  artifactTypeLabels,
  artifactVerificationMeta,
  evidenceOriginMeta,
  runtimeActivityLabel,
  toolPermissionVerdictMeta,
} from '../lib/labels'
import type { AgentRunStatus, AgentTreeNode, ArtifactSummary, EvidenceSummary, ToolSummaryRow } from '../types'

const { Title, Text } = Typography

// Agent 运行中才轮询：终态（已完成/失败/取消/已封存）后停止刷新，避免无谓请求。
function isRunActive(status: AgentRunStatus | undefined, sealedAt: string | null | undefined) {
  return status === 'RUNNING' && !sealedAt
}

function formatBytes(bytes: number) {
  if (bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const exponent = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  const value = bytes / 1024 ** exponent
  return `${value.toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`
}

/**
 * Token 未上报与 0 是两件不同的事：provider 没报量时数据库保持 null，
 * 界面必须说“未上报”，不能显示一个看起来像真实测量的 0。
 */
function formatTokens(value: number | null | undefined) {
  return value === null || value === undefined ? '未上报' : value.toLocaleString()
}

/**
 * Agent 运行详情：只读展示单个 story task 最新一次 Agent 尝试的安全元数据。
 * - Agent Tree 按 delegation_depth 缩进，回答“预算花在哪个子 Agent 上”。
 * - 分层预算 vs 真实 usage、工具调用计数与 permission verdict。
 * - Evidence 摘要区分 PINNED_SNAPSHOT（可证明既有实现）与 GENERATED_ARTIFACT（仅建议）。
 * - Artifact 摘要、取消按钮（仅有批次管理权限时展示，VIEWER 不可见）。
 * 所有源码正文、Session JSONL、storage locator、token 都不会返回到浏览器。
 */
export function AgentRunDetailPage({ canManage }: { canManage: boolean }) {
  const { taskId } = useParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { message, modal } = AntApp.useApp()

  const detailQuery = useQuery({
    queryKey: ['agent-run-detail', taskId],
    enabled: Boolean(taskId),
    queryFn: () => getAgentRunDetail(taskId!),
    // 运行中每 4 秒刷新，与自动分析卡片的轮询节奏保持一致。
    refetchInterval: (query) => {
      const data = query.state.data
      return data && isRunActive(data.status, data.sealed_at) ? 4000 : false
    },
  })

  const cancelMutation = useMutation({
    mutationFn: () => requestAttemptCancel(taskId!),
    onSuccess: (accepted) => {
      message.success(accepted ? '已请求取消当前 Agent 尝试' : '当前没有可取消的运行中尝试')
      queryClient.invalidateQueries({ queryKey: ['agent-run-detail', taskId] })
    },
    onError: (error) => message.error(error.message),
  })

  if (!taskId) return <Empty description="缺少任务标识" />
  if (detailQuery.isLoading) return <Card loading />
  if (detailQuery.isError) {
    return <Alert type="error" showIcon title="Agent 运行详情加载失败" description={detailQuery.error.message} />
  }

  const detail = detailQuery.data
  if (!detail) {
    return (
      <Space direction="vertical" size="large" className="page-stack">
        <Button type="link" onClick={() => navigate(-1)}>← 返回</Button>
        <Empty description="该需求尚未产生 Agent 运行记录" />
      </Space>
    )
  }

  const runActive = isRunActive(detail.status, detail.sealed_at)
  const statusMeta = agentRunStatusMeta[detail.status]
  const usage = detail.usage

  const confirmCancel = () => {
    modal.confirm({
      title: '取消当前 Agent 尝试？',
      content: '取消请求会级联到整棵 Agent Tree；已产生的安全元数据仍会保留。此操作不可撤销。',
      okText: '请求取消',
      okButtonProps: { danger: true },
      cancelText: '返回',
      onOk: () => cancelMutation.mutateAsync(),
    })
  }

  const agentColumns: ColumnsType<AgentTreeNode> = [
    {
      title: 'Agent（按委派深度缩进）',
      key: 'agent',
      render: (_value, node) => (
        // 用左内边距表达 delegation_depth 层级，直观呈现 Agent Tree。
        <div style={{ paddingInlineStart: node.delegation_depth * 20 }}>
          <Space wrap size={[6, 4]}>
            <Tag color={node.provider === 'root' ? 'geekblue' : 'blue'}>{agentRoleLabels[node.agent_role]}</Tag>
            <Text type="secondary">L{node.delegation_depth}</Text>
            <Tag>{agentProviderLabels[node.provider]}</Tag>
          </Space>
          <div>
            <Text code>{node.agent_id}</Text>
          </div>
        </div>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 110,
      render: (_value, node) => {
        const meta = agentNodeStatusMeta[node.status]
        return (
          <Space direction="vertical" size={2}>
            <Tag color={meta.color}>{meta.label}</Tag>
            {node.error_code ? <Text type="danger">{node.error_code}</Text> : null}
          </Space>
        )
      },
    },
    { title: '模型请求', dataIndex: 'model_requests', width: 100 },
    { title: '工具调用', dataIndex: 'tool_calls', width: 100 },
    { title: '产出证据', dataIndex: 'evidence_produced', width: 100 },
    {
      // V1.5 当前活动投影：只在 current_activity_status = 'RUNNING' 时才敢说"正在……"。
      // 这一列的数据源是后端事实事件更新的投影，不是从计数增长或工具名猜的。
      title: '当前真实活动',
      key: 'current_activity',
      width: 200,
      render: (_value, node) => {
        if (node.current_activity_status !== 'RUNNING') {
          return (
            <Text type="secondary">
              {node.status === 'RUNNING' ? '当前无未闭合活动' : '已结束'}
            </Text>
          )
        }
        const activity = runtimeActivityLabel(node.current_activity_code)
        const startedAt = node.current_activity_started_at
        const elapsed =
          startedAt === null || startedAt === undefined
            ? null
            : Math.max(0, Math.round((Date.now() - new Date(startedAt).getTime()) / 1000))
        return (
          <Space direction="vertical" size={0}>
            <Text>
              {activity}
              {node.current_tool_name ? `：${node.current_tool_name}` : ''}
            </Text>
            {elapsed === null ? null : (
              <Text type="secondary">已持续 {elapsed}s</Text>
            )}
          </Space>
        )
      },
    },
    {
      title: '耗时',
      key: 'duration',
      width: 140,
      render: (_value, node) => {
        if (!node.started_at) return '—'
        const end = node.finished_at ? new Date(node.finished_at).getTime() : Date.now()
        const seconds = Math.max(0, Math.round((end - new Date(node.started_at).getTime()) / 1000))
        return `${seconds}s`
      },
    },
  ]

  const toolColumns: ColumnsType<ToolSummaryRow> = [
    { title: '工具', dataIndex: 'tool_name' },
    {
      title: '权限判定',
      dataIndex: 'permission_verdict',
      width: 120,
      render: (_value, row) => {
        const meta = toolPermissionVerdictMeta[row.permission_verdict]
        return <Tag color={meta.color}>{meta.label}</Tag>
      },
    },
    { title: '调用次数', dataIndex: 'call_count', width: 110 },
    { title: '总耗时', dataIndex: 'total_duration_ms', width: 120, render: (ms: number) => `${ms} ms` },
  ]

  const evidenceColumns: ColumnsType<EvidenceSummary> = [
    {
      title: '来源',
      dataIndex: 'evidence_origin',
      width: 120,
      render: (_value, row) => {
        const meta = evidenceOriginMeta[row.evidence_origin]
        return (
          <Tooltip title={meta.hint}>
            <Tag color={meta.color}>{meta.label}</Tag>
          </Tooltip>
        )
      },
    },
    { title: '类型', dataIndex: 'evidence_type', width: 110, render: (value: string) => <Tag>{value}</Tag> },
    { title: '仓库', dataIndex: 'repository_name', width: 160 },
    {
      title: '文件',
      key: 'file',
      render: (_value, row) => (
        <Space direction="vertical" size={2}>
          <Text code>{row.file_path}</Text>
          {row.start_line ? (
            <Text type="secondary">{row.start_line}{row.end_line ? ` - ${row.end_line}` : ''} 行</Text>
          ) : null}
          <Text type="secondary">{row.description}</Text>
        </Space>
      ),
    },
  ]

  const artifactColumns: ColumnsType<ArtifactSummary> = [
    { title: '类型', dataIndex: 'artifact_type', width: 120, render: (value: ArtifactSummary['artifact_type']) => <Tag color="purple">{artifactTypeLabels[value]}</Tag> },
    { title: '工作区路径', dataIndex: 'workspace_path', render: (value: string) => <Text code>{value}</Text> },
    { title: '大小', dataIndex: 'size_bytes', width: 110, render: (bytes: number) => formatBytes(bytes) },
    {
      title: '校验状态',
      dataIndex: 'verification_status',
      width: 120,
      render: (value: ArtifactSummary['verification_status']) => {
        const meta = artifactVerificationMeta[value]
        return <Tag color={meta.color}>{meta.label}</Tag>
      },
    },
    { title: '内容哈希', dataIndex: 'content_hash', width: 160, ellipsis: true, render: (value: string) => <Text code>{value.slice(0, 12)}</Text> },
    { title: '生成时间', dataIndex: 'created_at', width: 190, render: (value: string) => new Date(value).toLocaleString() },
  ]

  const pinnedCount = detail.evidence.filter((item) => item.evidence_origin === 'PINNED_SNAPSHOT').length
  const generatedCount = detail.evidence.length - pinnedCount

  return (
    <main className="agent-run-detail">
      <section className="agent-run-hero" aria-labelledby="agent-run-detail-title">
        <div className="agent-run-hero__topline">
          <Button className="agent-run-back" type="link" onClick={() => navigate(-1)}>← 返回运行列表</Button>
          <Space wrap className="agent-run-hero__actions">
            <Tag color={statusMeta.color}>{statusMeta.label}</Tag>
            <Tag>第 {detail.agent_attempt} 次尝试</Tag>
            {runActive ? <Tag color="processing">实时更新中</Tag> : null}
            {/* 取消按钮只对有批次管理权限的用户展示：VIEWER 看得到详情但没有取消入口。 */}
            {canManage ? (
              <Button
                danger
                ghost
                disabled={!runActive || Boolean(detail.cancel_requested_at)}
                loading={cancelMutation.isPending}
                onClick={confirmCancel}
              >
                {detail.cancel_requested_at ? '已请求取消' : '取消本次尝试'}
              </Button>
            ) : null}
          </Space>
        </div>
        <div className="agent-run-hero__body">
          <div className="agent-run-hero__summary">
            <Text className="agent-run-hero__kicker">代码评审 · 执行指挥台</Text>
            <Title id="agent-run-detail-title" level={1}>Agent 运行详情</Title>
            <div className="agent-run-phase">
              <span className={runActive ? 'agent-run-phase__beacon agent-run-phase__beacon--active' : 'agent-run-phase__beacon'} aria-hidden="true" />
              <div>
                <Text className="agent-run-phase__label">{runActive ? '当前真实阶段' : '最后记录阶段'}</Text>
                <Text className="agent-run-phase__value">
                  {detail.attempt_phase_code ? runtimeActivityLabel(detail.attempt_phase_code) : '暂无阶段投影'}
                </Text>
                {detail.attempt_phase_started_at ? (
                  <Text className="agent-run-phase__time">自 {new Date(detail.attempt_phase_started_at).toLocaleString()}</Text>
                ) : null}
              </div>
            </div>
          </div>
          <div className="agent-run-hero__timing" aria-label="本次尝试时间">
            <div>
              <Text>开始运行</Text>
              <strong>{detail.started_at ? new Date(detail.started_at).toLocaleString() : '尚未开始'}</strong>
            </div>
            <div>
              <Text>{runActive ? '刷新节奏' : '结束时间'}</Text>
              <strong>{runActive ? '每 4 秒同步' : detail.finished_at ? new Date(detail.finished_at).toLocaleString() : '等待提交'}</strong>
            </div>
          </div>
        </div>
      </section>

      {detail.cancel_requested_at ? (
        <Alert
          className="agent-run-alert"
          type="warning"
          showIcon
          title="已请求取消"
          description={`取消原因：${detail.cancel_reason ?? 'USER_CANCELLED'}；请求时间：${new Date(detail.cancel_requested_at).toLocaleString()}。`}
        />
      ) : null}
      {detail.error_code ? (
        <Alert className="agent-run-alert" type="error" showIcon title={`运行错误：${detail.error_code}`} />
      ) : null}

      <section className="agent-run-section agent-run-pulse" aria-labelledby="agent-run-pulse-title">
        <div className="agent-run-section__heading">
          <div>
            <Text className="agent-run-section__eyebrow">本次尝试</Text>
            <Title id="agent-run-pulse-title" level={3}>运行脉冲</Title>
          </div>
          <Text type="secondary">结构规模与续跑状态</Text>
        </div>
        <Row gutter={[0, 0]} className="agent-run-pulse__grid">
          <Col xs={12} lg={6}><Statistic title="Agent 节点" value={usage.agent_count} /></Col>
          <Col xs={12} lg={6}><Statistic title="最大委派深度" value={usage.max_depth_reached} /></Col>
          <Col xs={12} lg={6}><Statistic title="Session 版本" value={detail.session_revision ?? 0} /></Col>
          <Col xs={12} lg={6}><Statistic title="恢复次数" value={detail.resume_count ?? 0} /></Col>
        </Row>
      </section>

      <div className="agent-run-detail-grid">
        <section className="agent-run-section agent-run-section--usage" aria-labelledby="agent-run-usage-title">
          <div className="agent-run-section__heading">
            <div>
              <Text className="agent-run-section__eyebrow">计量快照</Text>
              <Title id="agent-run-usage-title" level={3}>真实用量</Title>
            </div>
            <Text type="secondary">本次尝试累计</Text>
          </div>
          <Row gutter={[0, 0]} className="agent-run-usage__grid">
            <Col xs={12} sm={8}><Statistic title="模型请求" value={usage.model_requests} /></Col>
            <Col xs={12} sm={8}><Statistic title="根 Agent 请求" value={usage.root_model_requests} /></Col>
            <Col xs={12} sm={8}><Statistic title="子 Agent 请求" value={usage.child_model_requests} /></Col>
            <Col xs={12} sm={8}><Statistic title="工具调用" value={usage.tool_calls} /></Col>
            <Col xs={12} sm={8}><Statistic title="检索次数" value={usage.searches_run} /></Col>
            <Col xs={12} sm={8}><Statistic title="Ralph 轮次" value={usage.ralph_rounds} /></Col>
            <Col xs={12} sm={8}><Statistic title="重试请求" value={usage.retry_requests} /></Col>
            <Col xs={12} sm={8}><Statistic title="压缩请求" value={usage.compaction_requests} /></Col>
            <Col xs={12} sm={8}><Statistic title="Web 请求" value={usage.web_requests} /></Col>
            <Col xs={12} sm={8}><Statistic title="输入 Token" value={formatTokens(usage.input_tokens)} /></Col>
            <Col xs={12} sm={8}><Statistic title="输出 Token" value={formatTokens(usage.output_tokens)} /></Col>
            <Col xs={12} sm={8}><Statistic title="Web 字节" value={formatBytes(usage.web_bytes)} /></Col>
          </Row>
        </section>

        <section className="agent-run-section agent-run-section--ledger" aria-labelledby="agent-run-ledger-title">
          <div className="agent-run-section__heading">
            <div>
              <Text className="agent-run-section__eyebrow">可追溯性</Text>
              <Title id="agent-run-ledger-title" level={3}>运行账本</Title>
            </div>
          </div>
          <dl className="agent-run-ledger">
            {detail.committed_at ? <div><dt>提交时间</dt><dd>{new Date(detail.committed_at).toLocaleString()}</dd></div> : null}
            {detail.finished_at ? <div><dt>结束时间</dt><dd>{new Date(detail.finished_at).toLocaleString()}</dd></div> : null}
            {detail.sealed_at ? <div><dt>封存时间</dt><dd>{new Date(detail.sealed_at).toLocaleString()}</dd></div> : null}
            {detail.policy_hash ? <div className="agent-run-ledger__hash"><dt>Policy Hash</dt><dd><Text code>{detail.policy_hash}</Text></dd></div> : null}
            {detail.tree_digest ? <div className="agent-run-ledger__hash"><dt>Tree Digest</dt><dd><Text code>{detail.tree_digest}</Text></dd></div> : null}
            {!detail.committed_at && !detail.finished_at && !detail.sealed_at && !detail.policy_hash && !detail.tree_digest ? (
              <div><dt>记录状态</dt><dd>等待运行元数据</dd></div>
            ) : null}
          </dl>
        </section>
      </div>

      <section className="agent-run-section agent-run-section--table" aria-labelledby="agent-run-tree-title">
        <div className="agent-run-section__heading">
          <div>
            <Text className="agent-run-section__eyebrow">执行拓扑</Text>
            <Title id="agent-run-tree-title" level={3}>Agent Tree</Title>
          </div>
          <Text type="secondary">按委派深度展开</Text>
        </div>
        <Table<AgentTreeNode>
          rowKey="node_id"
          size="small"
          pagination={false}
          dataSource={detail.agents}
          columns={agentColumns}
          locale={{ emptyText: '暂无 Agent 节点' }}
        />
      </section>

      <section className="agent-run-section agent-run-section--table" aria-labelledby="agent-run-tool-title">
        <div className="agent-run-section__heading">
          <div>
            <Text className="agent-run-section__eyebrow">执行审计</Text>
            <Title id="agent-run-tool-title" level={3}>工具调用与权限判定</Title>
          </div>
        </div>
        <Table<ToolSummaryRow>
          rowKey={(row) => `${row.tool_name}-${row.permission_verdict}`}
          size="small"
          pagination={false}
          dataSource={detail.tool_summary}
          columns={toolColumns}
          locale={{ emptyText: '暂无工具调用' }}
        />
      </section>

      <section className="agent-run-section agent-run-section--table" aria-labelledby="agent-run-evidence-title">
        <div className="agent-run-section__heading">
          <div>
            <Text className="agent-run-section__eyebrow">评审依据</Text>
            <Title id="agent-run-evidence-title" level={3}>Evidence 摘要</Title>
          </div>
          <Space size={8} wrap>
            <Tag color={evidenceOriginMeta.PINNED_SNAPSHOT.color}>冻结快照 {pinnedCount}</Tag>
            <Tag color={evidenceOriginMeta.GENERATED_ARTIFACT.color}>生成产物 {generatedCount}</Tag>
          </Space>
        </div>
        <Table<EvidenceSummary>
          rowKey="evidence_id"
          size="small"
          pagination={false}
          dataSource={detail.evidence}
          columns={evidenceColumns}
          locale={{ emptyText: '暂无 Evidence' }}
        />
      </section>

      <section className="agent-run-section agent-run-section--table" aria-labelledby="agent-run-artifact-title">
        <div className="agent-run-section__heading">
          <div>
            <Text className="agent-run-section__eyebrow">留存产物</Text>
            <Title id="agent-run-artifact-title" level={3}>Artifact 摘要</Title>
          </div>
        </div>
        <Table<ArtifactSummary>
          rowKey="artifact_id"
          size="small"
          pagination={false}
          dataSource={detail.artifacts}
          columns={artifactColumns}
          locale={{ emptyText: '暂无 Artifact' }}
        />
      </section>
    </main>
  )
}
