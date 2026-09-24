import { useState } from 'react'
import { Alert, Card, Col, Descriptions, Empty, Row, Space, Statistic, Table, Tabs, Tag, Tooltip, Typography } from 'antd'
import {
  nextRuntimeScopePagination,
  RUNTIME_SCOPE_DEFAULT_PAGE_SIZE,
  RUNTIME_SCOPE_PAGE_SIZES,
  useRuntimeAnalysisScope,
  type RuntimeAnalysisScopeApi,
  type RuntimeAnalysisScopeCommit,
  type RuntimeRepositoryScope,
  type RuntimeScopeCommitView,
  type RuntimeScopeLevel,
  type RuntimeScopeMode,
  type RuntimeScopeStatus,
} from '../../hooks/useRuntimeAnalysisScope'
import {
  REASON_CODE_LABELS,
  SCOPE_ERROR_META,
  SCOPE_METRIC_HINTS,
} from './runtime-scope-labels'

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
const SCOPE_LEVEL_LABELS: Record<RuntimeScopeLevel, string> = {
  PRIMARY: '主范围',
  RELATED: '关联范围',
  GLOBAL: '全仓范围',
}
const RANGE_SOURCE_LABELS: Record<string, string> = {
  PREVIOUS_SUCCESSFUL_JOB: '沿用上次成功任务',
  TIME_DERIVED: '按时间窗推算',
  RELEASE_MANIFEST: '发布清单',
  UNAVAILABLE: '不可用',
}
const ENUMERATION_STATUS_LABELS: Record<string, string> = {
  PENDING: '待处理',
  COMPLETE: '完整',
  SHALLOW_INCOMPLETE: '浅克隆不完整',
  RANGE_TOO_LARGE: '范围过大',
  BASELINE_REQUIRED: '需要基线',
  FAILED: '失败',
}
const RELATION_STATUS_LABELS: Record<string, string> = {
  AUTO_SELECTED: '自动选中',
  AI_RELATED: 'AI 判定相关',
  AI_UNRELATED: 'AI 判定不相关',
  AI_UNCERTAIN: 'AI 不确定',
  EXCLUDED: '已排除',
}


/**
 * 指标标题 + 悬停解释。
 *
 * `tabIndex={0}` 不是装饰：antd Tooltip 只在可聚焦元素上响应键盘焦点，
 * 不加的话只能用鼠标看到解释。
 */
function MetricTitle({ text, hint }: { text: string; hint: string }) {
  return (
    <Tooltip title={hint}>
      <span tabIndex={0} className="scope-metric-title">{text}</span>
    </Tooltip>
  )
}

function translatedLabel(map: Record<string, string>, value: string): string {
  return map[value] ?? value
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
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState<number>(RUNTIME_SCOPE_DEFAULT_PAGE_SIZE)
  const scope = useRuntimeAnalysisScope({ taskId, view, api, page, pageSize })
  const summary = scope.summaryQuery.data
  // 换任务、换分类、换代次都必须回到第 1 页：否则会停在一个新分类里根本不存在的页码上，
  // 服务端按 offset 返回空数组，界面看起来像"没有提交"。
  const generation = summary?.generation ?? null
  const resetKey = `${taskId ?? ''}|${view}|${String(generation ?? '')}`
  const [lastResetKey, setLastResetKey] = useState(resetKey)
  if (resetKey !== lastResetKey) {
    setLastResetKey(resetKey)
    if (page !== 1) setPage(1)
  }

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
    { title: '来源', dataIndex: 'range_source', key: 'range_source', render: (value: string) => <Tooltip title={value}>{translatedLabel(RANGE_SOURCE_LABELS, value)}</Tooltip> },
    { title: 'Commit 数', dataIndex: 'commit_count', key: 'commit_count', render: (value: number | null) => value ?? '—' },
    { title: '完整性', dataIndex: 'enumeration_status', key: 'enumeration_status', render: (value: string) => <Tooltip title={value}><Tag color={value === 'COMPLETE' ? 'green' : 'orange'}>{translatedLabel(ENUMERATION_STATUS_LABELS, value)}</Tag></Tooltip> },
    { title: '解析时间', dataIndex: 'resolved_at', key: 'resolved_at', render: (value: string, row: RuntimeRepositoryScope) => <Tooltip title={utcRange(row)}>{new Date(value).toLocaleString()}</Tooltip> },
  ]
  const commitColumns = [
    { title: '状态', key: 'status', width: 145, render: (_: unknown, row: RuntimeAnalysisScopeCommit) => <Space size={4}><Tooltip title={row.relation_status}><Tag>{translatedLabel(RELATION_STATUS_LABELS, row.relation_status)}</Tag></Tooltip>{row.effective_status === 'REVERTED' ? <Tag color="orange">已回滚</Tag> : null}</Space> },
    { title: '仓库 / SHA', key: 'repository', width: 160, render: (_: unknown, row: RuntimeAnalysisScopeCommit) => <Space direction="vertical" size={0}><Text>{row.repository_name}</Text><Text code>{row.short_sha}</Text></Space> },
    { title: '提交时间', dataIndex: 'committed_at', key: 'committed_at', width: 170, render: (value: string) => new Date(value).toLocaleString() },
    { title: '提交人', key: 'author', width: 150, render: (_: unknown, row: RuntimeAnalysisScopeCommit) => <Space direction="vertical" size={0}><Text>{row.author_display_name}</Text><Text type="secondary">{row.author_email_masked ?? '邮箱未披露'}</Text></Space> },
    { title: '提交描述', dataIndex: 'subject', key: 'subject', ellipsis: true },
    { title: '变更', key: 'changes', width: 135, render: (_: unknown, row: RuntimeAnalysisScopeCommit) => `${String(row.files_changed)} 文件 · +${String(row.additions)} / -${String(row.deletions)}` },
    { title: '选择理由', dataIndex: 'reason_codes', key: 'reason_codes', width: 220, render: (values: string[]) => <Space size={[4, 4]} wrap>{values.map((value) => <Tooltip key={value} title={value}><Tag>{translatedLabel(REASON_CODE_LABELS, value)}</Tag></Tooltip>)}</Space> },
    { title: 'AI 实际读取', key: 'read', width: 110, render: (_: unknown, row: RuntimeAnalysisScopeCommit) => row.actually_read ? <Tag color="green">已读 {row.read_count}</Tag> : <Tag>未读</Tag> },
  ]

  return (
    <Card
      size="small"
      title="分析范围"
      extra={<Space><Tag color={status.color}>{status.label}</Tag><Tooltip title={summary.current_scope_level}><Tag color={LEVEL_COLORS[summary.current_scope_level]}>{SCOPE_LEVEL_LABELS[summary.current_scope_level]}</Tag></Tooltip></Space>}
    >
      {summary.error_code === null ? null : (
        <Alert
          style={{ marginBottom: 12 }}
          type={summary.status === 'FAILED' ? 'error' : 'warning'}
          showIcon
          title={
            <Space size={6} wrap>
              <Text strong>{SCOPE_ERROR_META[summary.error_code]?.label ?? summary.error_code}</Text>
              {/* 原始码保留：和日志、SQL、文档里出现的是同一个字符串，便于检索与沟通。 */}
              <Text type="secondary" code>{summary.error_code}</Text>
            </Space>
          }
          description={
            <>
              {SCOPE_ERROR_META[summary.error_code]?.hint ?? '未收录的原因码，请按原始码检索后端日志。'}
              <br />
              <Text type="secondary">这是后端冻结的降级或失败原因，不根据前端活动推断。</Text>
            </>
          }
        />
      )}
      <Descriptions size="small" column={{ xs: 1, md: 2 }}>
        <Descriptions.Item label="范围模式">{MODE_LABELS[summary.mode]}</Descriptions.Item>
        <Descriptions.Item label="时间窗">{summary.window_days === null ? <Text type="secondary">服务端未返回</Text> : <Tooltip title={summary.repositories.map((repository) => `${repository.repository_name}: ${utcRange(repository)}`).join('\n')}><Text>{`各仓冻结时刻向前 ${String(summary.window_days)} 天`}</Text></Tooltip>}</Descriptions.Item>
      </Descriptions>
      <Row gutter={[12, 12]} style={{ marginBottom: 12 }}>
        <Col xs={12} md={4}><Statistic title={<MetricTitle text="候选" hint={SCOPE_METRIC_HINTS.candidate} />} value={summary.candidate_count} /></Col>
        <Col xs={12} md={4}><Statistic title={<MetricTitle text="强关联" hint={SCOPE_METRIC_HINTS.strong} />} value={summary.strong_count} /></Col>
        <Col xs={12} md={4}><Statistic title={<MetricTitle text="AI 相关" hint={SCOPE_METRIC_HINTS.aiRelated} />} value={summary.ai_related_count} /></Col>
        <Col xs={12} md={4}><Statistic title={<MetricTitle text="AI 不确定" hint={SCOPE_METRIC_HINTS.aiUncertain} />} value={summary.ai_uncertain_count} /></Col>
        <Col xs={12} md={4}><Statistic title={<MetricTitle text="已读" hint={SCOPE_METRIC_HINTS.read} />} value={summary.read_count} /></Col>
        <Col xs={12} md={4}><Statistic title={<MetricTitle text="已回滚" hint={SCOPE_METRIC_HINTS.reverted} />} value={summary.reverted_count} /></Col>
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
        onChange={(key) => {
          setView(key as RuntimeScopeCommitView)
          setPage(1)
        }}
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
          loading={scope.commitsQuery.isFetching}
          dataSource={scope.commits}
          columns={commitColumns}
          pagination={{
            current: page,
            pageSize,
            total: scope.totalCommits,
            showSizeChanger: true,
            pageSizeOptions: RUNTIME_SCOPE_PAGE_SIZES.map((size) => String(size)),
            size: 'small',
            showTotal: (total, range) => `第 ${String(range[0])}–${String(range[1])} 条 / 共 ${String(total)} 条`,
            onChange: (nextPage, nextPageSize) => {
              const next = nextRuntimeScopePagination({ page, pageSize }, { page: nextPage, pageSize: nextPageSize })
              setPage(next.page)
              setPageSize(next.pageSize)
            },
          }}
          scroll={{ x: 1350 }}
          locale={{ emptyText: '该分类没有提交' }}
        />
      )}
      <Space direction="vertical" size={6} style={{ width: '100%', marginTop: 16 }}>
        <Text strong>范围扩展轨迹</Text>
        {summary.expansions.length === 0 ? <Text type="secondary">没有后端记录的范围扩展事实。</Text> : summary.expansions.map((item) => (
          <Card key={item.id} size="small">
            <Space wrap>
              <Tag>Attempt {item.attempt}</Tag>
              <Text>{item.agent_label}</Text>
              <Tag color={LEVEL_COLORS[item.from_level]}>{SCOPE_LEVEL_LABELS[item.from_level]}</Tag>
              <Text>→</Text>
              <Tag color={LEVEL_COLORS[item.to_level]}>{SCOPE_LEVEL_LABELS[item.to_level]}</Tag>
              <Tooltip title={item.reason_code}><Text code>{translatedLabel(REASON_CODE_LABELS, item.reason_code)}</Text></Tooltip>
              <Text type="secondary">{new Date(item.occurred_at).toLocaleString()}</Text>
            </Space>
          </Card>
        ))}
      </Space>
    </Card>
  )
}
