import { useState } from 'react'
import { Alert, Button, Card, Col, Descriptions, Empty, Row, Space, Statistic, Table, Tabs, Tag, Tooltip, Typography } from 'antd'
import {
  useRuntimeAnalysisScope,
  type RuntimeAnalysisScopeApi,
  type RuntimeAnalysisScopeCommit,
  type RuntimeRepositoryScope,
  type RuntimeScopeCommitView,
  type RuntimeScopeLevel,
  type RuntimeScopeMode,
  type RuntimeScopeStatus,
} from '../../hooks/useRuntimeAnalysisScope'

const { Text } = Typography

const MODE_LABELS: Record<RuntimeScopeMode, string> = {
  EXACT_STORY_COMMITS: '精准需求提交',
  HYBRID_CANDIDATES: '强关联 + AI 候选',
  DEVELOPER_WINDOW: '开发人员时间窗',
  REQUIREMENT_REF_ONLY: '需求号命中',
  NO_CODE_EXPECTED: '无需代码',
  GLOBAL_FALLBACK: '全仓降级',
}
const STATUS_LABELS: Record<RuntimeScopeStatus, { label: string; color: string }> = {
  PREPARING: { label: '准备中', color: 'processing' },
  READY: { label: '已冻结', color: 'green' },
  DEGRADED: { label: '已降级', color: 'orange' },
  FAILED: { label: '失败', color: 'red' },
  LEGACY: { label: '旧任务', color: 'default' },
}
const LEVEL_COLORS: Record<RuntimeScopeLevel, string> = { PRIMARY: 'blue', RELATED: 'purple', GLOBAL: 'orange' }

function shortHash(value: string | null): string {
  return value === null ? '—' : value.replace(/^sha256:/, '').slice(0, 12)
}

function utcRange(repository: RuntimeRepositoryScope): string {
  return `${repository.range_start_at} ≤ committed_at < ${repository.range_end_at}`
}

export function RuntimeAnalysisScopeCard({
  taskId,
  api = null,
}: {
  taskId: string | null
  api?: RuntimeAnalysisScopeApi | null
}) {
  const [view, setView] = useState<RuntimeScopeCommitView>('SELECTED')
  const scope = useRuntimeAnalysisScope({ taskId, view, api })
  const summary = scope.summaryQuery.data

  if (taskId === null) return <Card size="small" title="分析范围"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="请先选择需求任务" /></Card>
  if (!scope.apiAvailable) {
    return (
      <Card size="small" title="分析范围">
        <Alert type="info" showIcon title="待数据库 API 接入" description="范围卡片已定义类型化接口，但当前未注入 get_analysis_story_scope_summary / get_analysis_story_scope_commits，因此不会猜测提交范围。" />
      </Card>
    )
  }
  if (scope.summaryQuery.isLoading) return <Card size="small" title="分析范围" loading />
  if (scope.summaryQuery.isError) {
    return <Card size="small" title="分析范围"><Alert type="warning" showIcon title="读取分析范围失败" description={scope.summaryQuery.error instanceof Error ? scope.summaryQuery.error.message : '未知错误'} /></Card>
  }
  if (summary === null || summary === undefined) {
    return <Card size="small" title="分析范围"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="该任务尚无分析范围快照" /></Card>
  }
  const status = STATUS_LABELS[summary.status]
  const repositoryColumns = [
    { title: '仓库', dataIndex: 'repository_name', key: 'repository_name' },
    { title: 'base → head', key: 'sha', render: (_: unknown, row: RuntimeRepositoryScope) => <Text code>{row.base_sha?.slice(0, 8) ?? '—'} → {row.head_sha.slice(0, 8)}</Text> },
    { title: '来源', dataIndex: 'range_source', key: 'range_source' },
    { title: 'Commit 数', dataIndex: 'commit_count', key: 'commit_count', render: (value: number | null) => value ?? '—' },
    { title: '完整性', dataIndex: 'enumeration_status', key: 'enumeration_status', render: (value: string) => <Tag color={value === 'COMPLETE' ? 'green' : 'orange'}>{value}</Tag> },
    { title: '解析时间', dataIndex: 'resolved_at', key: 'resolved_at', render: (value: string, row: RuntimeRepositoryScope) => <Tooltip title={utcRange(row)}>{new Date(value).toLocaleString()}</Tooltip> },
  ]
  const commitColumns = [
    { title: '状态', key: 'status', width: 145, render: (_: unknown, row: RuntimeAnalysisScopeCommit) => <Space size={4}><Tag>{row.relation_status}</Tag>{row.effective_status === 'REVERTED' ? <Tag color="orange">已回滚</Tag> : null}</Space> },
    { title: '仓库 / SHA', key: 'repository', width: 160, render: (_: unknown, row: RuntimeAnalysisScopeCommit) => <Space direction="vertical" size={0}><Text>{row.repository_name}</Text><Text code>{row.short_sha}</Text></Space> },
    { title: '提交时间', dataIndex: 'committed_at', key: 'committed_at', width: 170, render: (value: string) => new Date(value).toLocaleString() },
    { title: '提交人', key: 'author', width: 150, render: (_: unknown, row: RuntimeAnalysisScopeCommit) => <Space direction="vertical" size={0}><Text>{row.author_display_name}</Text><Text type="secondary">{row.author_email_masked ?? '邮箱未披露'}</Text></Space> },
    { title: '提交描述', dataIndex: 'subject', key: 'subject', ellipsis: true },
    { title: '变更', key: 'changes', width: 135, render: (_: unknown, row: RuntimeAnalysisScopeCommit) => `${String(row.files_changed)} 文件 · +${String(row.additions)} / -${String(row.deletions)}` },
    { title: '选择理由', dataIndex: 'reason_codes', key: 'reason_codes', width: 220, render: (values: string[]) => <Space size={[4, 4]} wrap>{values.map((value) => <Tag key={value}>{value}</Tag>)}</Space> },
    { title: 'AI 实际读取', key: 'read', width: 110, render: (_: unknown, row: RuntimeAnalysisScopeCommit) => row.actually_read ? <Tag color="green">已读 {row.read_count}</Tag> : <Tag>未读</Tag> },
  ]

  return (
    <Card
      size="small"
      title="分析范围"
      extra={<Space><Tag color={status.color}>{status.label}</Tag><Tag color={LEVEL_COLORS[summary.current_scope_level]}>{summary.current_scope_level}</Tag></Space>}
    >
      {summary.error_code === null ? null : <Alert style={{ marginBottom: 12 }} type={summary.status === 'FAILED' ? 'error' : 'warning'} showIcon title={summary.error_code} description="这是后端冻结的降级或失败原因，不根据前端活动推断。" />}
      <Descriptions size="small" column={{ xs: 1, md: 3 }}>
        <Descriptions.Item label="范围模式">{MODE_LABELS[summary.mode]}</Descriptions.Item>
        <Descriptions.Item label="时间窗">{summary.window_days === null ? <Text type="secondary">服务端未返回</Text> : <Tooltip title={summary.repositories.map((repository) => `${repository.repository_name}: ${utcRange(repository)}`).join('\n')}><Text>{`各仓冻结时刻向前 ${String(summary.window_days)} 天`}</Text></Tooltip>}</Descriptions.Item>
        <Descriptions.Item label="算法 / Manifest"><Text code>{summary.algorithm_version} · {shortHash(summary.manifest_hash)}</Text></Descriptions.Item>
      </Descriptions>
      <Row gutter={[12, 12]} style={{ marginBottom: 12 }}>
        <Col xs={12} md={4}><Statistic title="候选" value={summary.candidate_count} /></Col>
        <Col xs={12} md={4}><Statistic title="强关联" value={summary.strong_count} /></Col>
        <Col xs={12} md={4}><Statistic title="AI 相关" value={summary.ai_related_count} /></Col>
        <Col xs={12} md={4}><Statistic title="AI 不确定" value={summary.ai_uncertain_count} /></Col>
        <Col xs={12} md={4}><Statistic title="已读" value={summary.read_count} /></Col>
        <Col xs={12} md={4}><Statistic title="已回滚" value={summary.reverted_count} /></Col>
      </Row>
      <Text strong>仓库范围</Text>
      <Table<RuntimeRepositoryScope>
        style={{ marginTop: 8 }}
        size="small"
        rowKey="repository_name"
        dataSource={summary.repositories}
        columns={repositoryColumns}
        pagination={false}
        scroll={{ x: 900 }}
        locale={{ emptyText: '没有仓库范围记录' }}
      />
      <Tabs
        style={{ marginTop: 12 }}
        activeKey={view}
        onChange={(key) => setView(key as RuntimeScopeCommitView)}
        items={[
          { key: 'SELECTED', label: '已选择提交' },
          { key: 'CANDIDATE', label: '候选' },
          { key: 'EXCLUDED', label: '已排除' },
        ]}
      />
      {scope.commitsQuery.isError ? <Alert type="warning" showIcon title="读取提交明细失败" description={scope.commitsQuery.error instanceof Error ? scope.commitsQuery.error.message : '未知错误'} /> : (
        <Table<RuntimeAnalysisScopeCommit>
          size="small"
          rowKey="candidate_id"
          loading={scope.commitsQuery.isLoading}
          dataSource={scope.commits}
          columns={commitColumns}
          pagination={false}
          scroll={{ x: 1350 }}
          locale={{ emptyText: '该分类没有提交' }}
        />
      )}
      {scope.commitsQuery.hasNextPage ? <Button style={{ marginTop: 8 }} block loading={scope.commitsQuery.isFetchingNextPage} onClick={() => void scope.commitsQuery.fetchNextPage()}>加载更多（已显示 {scope.commits.length}；当前分类共 {scope.totalCommits}）</Button> : null}
      <Space direction="vertical" size={6} style={{ width: '100%', marginTop: 16 }}>
        <Text strong>范围扩展轨迹</Text>
        {summary.expansions.length === 0 ? <Text type="secondary">没有后端记录的范围扩展事实。</Text> : summary.expansions.map((item) => (
          <Card key={item.id} size="small">
            <Space wrap>
              <Tag>Attempt {item.attempt}</Tag>
              <Text>{item.agent_label}</Text>
              <Tag color={LEVEL_COLORS[item.from_level]}>{item.from_level}</Tag>
              <Text>→</Text>
              <Tag color={LEVEL_COLORS[item.to_level]}>{item.to_level}</Tag>
              <Text code>{item.reason_code}</Text>
              <Text type="secondary">{new Date(item.occurred_at).toLocaleString()}</Text>
            </Space>
          </Card>
        ))}
      </Space>
    </Card>
  )
}
