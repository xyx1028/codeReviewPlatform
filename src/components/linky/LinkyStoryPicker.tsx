/**
 * Linky 用户故事选择器（V1.20）。
 *
 * 看板页与批次导入页共用同一个组件：两边要看的字段、要过滤的维度、要看的正文与附件
 * 完全一样，区别只在选完之后做什么。
 *
 * 数据只来自镜像表（`linky_story_catalog`），不直连 Linky —— 那个接口只在公司内网可达，
 * 而页面是从公网加载的。「刷新」是往同步队列下一张单子，由内网侧的 Worker 去取数。
 */
import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Col,
  Descriptions,
  Drawer,
  Empty,
  Input,
  Row,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  createStoryAttachmentSignedUrl,
  describeLinkyError,
  enqueueLinkySync,
  getLinkyCatalogFacets,
  getLinkyCatalogStory,
  getLinkySync,
  listLinkyCatalog,
  listRecentLinkySyncs,
} from '../../lib/api'
import type { LinkyCatalogStory, LinkySyncDepth, LinkySyncRequest } from '../../types'

const { Text, Paragraph } = Typography

export interface LinkyStoryPickerProps {
  /** 是否允许触发同步（ADMIN / REVIEWER）。 */
  canSync: boolean
  /** 是否显示勾选框。看板与导入页都需要，纯浏览时可关掉。 */
  selectable?: boolean
  selectedIssueIds?: string[]
  onSelectionChange?: (issueIds: string[]) => void
  /** 勾选区下方的操作区（导入按钮等）。 */
  actions?: ReactNode
}

function teamNames(
  team: LinkyCatalogStory['team'],
  role: 'req' | 'dev' | 'test',
): string {
  const list = team?.[role] ?? []
  const names = list.map((member) => member.name).filter((name) => name && name.trim() !== '')
  return names.join('、')
}

function describeSync(sync: LinkySyncRequest | undefined): string {
  if (!sync) return '还没有同步过'
  const scope = [sync.workspace_name ?? '全部工作区', sync.release_window ?? null]
    .filter((part): part is string => part !== null)
    .join(' / ')
  const when = new Date(sync.created_at).toLocaleString()
  const depth = sync.depth === 'FULL' ? '完整同步' : '列表同步'
  if (sync.status === 'SUCCEEDED') {
    return `${when} ${depth}（${scope}）成功：列表 ${sync.stories_synced ?? 0} 条，正文 ${
      sync.details_synced ?? 0
    } 条，附件 ${sync.attachments_stored ?? 0} 个${
      (sync.attachments_failed ?? 0) > 0 ? `，失败 ${sync.attachments_failed} 个` : ''
    }`
  }
  if (sync.status === 'FAILED') {
    return `${when} ${depth}（${scope}）失败：${sync.error_code ?? ''} ${sync.error_message ?? ''}`
  }
  return `${when} ${depth}（${scope}）${sync.status === 'RUNNING' ? '正在执行' : '排队中'}`
}

export function LinkyStoryPicker(props: LinkyStoryPickerProps) {
  const { message } = AntApp.useApp()
  const queryClient = useQueryClient()
  const [workspaceId, setWorkspaceId] = useState<string | null>(null)
  const [releaseWindow, setReleaseWindow] = useState<string | null>(null)
  const [iteration, setIteration] = useState<string | null>(null)
  const [statusLabel, setStatusLabel] = useState<string | null>(null)
  const [assigneeName, setAssigneeName] = useState<string | null>(null)
  const [keyword, setKeyword] = useState('')
  const [detailIssueId, setDetailIssueId] = useState<string | null>(null)
  const [watchedSyncId, setWatchedSyncId] = useState<string | null>(null)

  const facetsQuery = useQuery({
    queryKey: ['linky-facets', workspaceId],
    queryFn: () => getLinkyCatalogFacets(workspaceId),
  })
  const listQuery = useQuery({
    queryKey: ['linky-catalog', workspaceId, releaseWindow, iteration, statusLabel, assigneeName, keyword],
    queryFn: () =>
      listLinkyCatalog({ workspaceId, releaseWindow, iteration, statusLabel, assigneeName, keyword }),
  })
  const syncsQuery = useQuery({
    queryKey: ['linky-syncs'],
    queryFn: () => listRecentLinkySyncs(5),
    refetchInterval: watchedSyncId === null ? false : 2000,
  })
  const watchedSync = useQuery({
    queryKey: ['linky-sync', watchedSyncId],
    queryFn: () => getLinkySync(watchedSyncId as string),
    enabled: watchedSyncId !== null,
    refetchInterval: 2000,
  })
  const detailQuery = useQuery({
    queryKey: ['linky-catalog-story', detailIssueId],
    queryFn: () => getLinkyCatalogStory(detailIssueId as string),
    enabled: detailIssueId !== null,
  })

  // 同步跑完就刷新镜像视图，并停止轮询 —— 不让页面一直空转。
  useEffect(() => {
    const status = watchedSync.data?.status
    if (status !== 'SUCCEEDED' && status !== 'FAILED') return
    setWatchedSyncId(null)
    queryClient.invalidateQueries({ queryKey: ['linky-catalog'] })
    queryClient.invalidateQueries({ queryKey: ['linky-facets'] })
    queryClient.invalidateQueries({ queryKey: ['linky-syncs'] })
    if (status === 'SUCCEEDED') message.success('Linky 同步完成')
    else message.error(`Linky 同步失败：${watchedSync.data?.error_code ?? ''}`)
  }, [watchedSync.data?.status, watchedSync.data?.error_code, queryClient, message])

  const syncMutation = useMutation({
    mutationFn: (depth: LinkySyncDepth) => {
      const workspace = facetsQuery.data?.workspaces.find((entry) => entry.workspace_id === workspaceId)
      return enqueueLinkySync({
        depth,
        workspaceId: depth === 'FULL' ? workspaceId : workspaceId,
        workspaceName: depth === 'FULL' ? (workspace?.workspace_name ?? null) : null,
        releaseWindow: depth === 'FULL' ? releaseWindow : null,
      })
    },
    onSuccess: (syncId) => {
      setWatchedSyncId(syncId)
      queryClient.invalidateQueries({ queryKey: ['linky-syncs'] })
      message.info('已提交同步请求，由内网 Worker 执行；完成后列表会自动刷新。')
    },
    onError: (error) => message.error(describeLinkyError(error)),
  })

  const facetOptions = (entries: Array<{ value: string; count: number }> | undefined) =>
    (entries ?? [])
      .filter((entry) => entry.value !== '')
      .map((entry) => ({ value: entry.value, label: `${entry.value}（${entry.count}）` }))

  const columns: ColumnsType<LinkyCatalogStory> = useMemo(
    () => [
      { title: '编号', dataIndex: 'story_code', width: 150 },
      { title: '标题', dataIndex: 'title', ellipsis: true },
      {
        title: '状态',
        dataIndex: 'status_label',
        width: 120,
        render: (value: string | null) => (value ? <Tag>{value}</Tag> : <Text type="secondary">—</Text>),
      },
      { title: '负责人', dataIndex: 'assignee_name', width: 100 },
      {
        title: '开发',
        width: 130,
        render: (_, row) => teamNames(row.team, 'dev') || <Text type="secondary">—</Text>,
      },
      { title: '发布窗口', dataIndex: 'release_window', width: 120 },
      { title: '迭代', dataIndex: 'iteration', width: 170, ellipsis: true },
      {
        title: '正文',
        width: 90,
        render: (_, row) =>
          row.detail_synced_at === null ? (
            <Tag color="orange">未同步</Tag>
          ) : (
            <Tag color="green">已同步</Tag>
          ),
      },
      {
        title: '附件',
        dataIndex: 'attachment_count',
        width: 80,
        render: (value: number) => (value > 0 ? `${value} 个` : <Text type="secondary">无</Text>),
      },
    ],
    [],
  )

  const detail = detailQuery.data?.story ?? null
  const attachments = detailQuery.data?.attachments ?? []

  return (
    <Space direction="vertical" size="large" className="page-stack">
      <Card title="筛选">
        <Row gutter={[12, 12]}>
          <Col xs={24} md={8}>
            <Text strong>项目组</Text>
            <Select
              allowClear
              className="full-width select-with-margin"
              placeholder="全部项目组"
              loading={facetsQuery.isLoading}
              value={workspaceId ?? undefined}
              options={(facetsQuery.data?.workspaces ?? []).map((entry) => ({
                value: entry.workspace_id,
                label: `${entry.workspace_name}（${entry.count}）`,
              }))}
              onChange={(value) => {
                setWorkspaceId(value ?? null)
                setReleaseWindow(null)
                setIteration(null)
              }}
            />
          </Col>
          <Col xs={24} md={8}>
            <Text strong>发布窗口</Text>
            <Select
              allowClear
              className="full-width select-with-margin"
              placeholder="全部发布窗口"
              value={releaseWindow ?? undefined}
              options={facetOptions(facetsQuery.data?.release_windows)}
              onChange={(value) => setReleaseWindow(value ?? null)}
            />
          </Col>
          <Col xs={24} md={8}>
            <Text strong>迭代</Text>
            <Select
              allowClear
              className="full-width select-with-margin"
              placeholder="全部迭代"
              value={iteration ?? undefined}
              options={facetOptions(facetsQuery.data?.iterations)}
              onChange={(value) => setIteration(value ?? null)}
            />
          </Col>
          <Col xs={24} md={8}>
            <Text strong>需求状态</Text>
            <Select
              allowClear
              className="full-width select-with-margin"
              placeholder="全部状态"
              value={statusLabel ?? undefined}
              options={facetOptions(facetsQuery.data?.statuses)}
              onChange={(value) => setStatusLabel(value ?? null)}
            />
          </Col>
          <Col xs={24} md={8}>
            <Text strong>负责人</Text>
            <Select
              allowClear
              showSearch
              className="full-width select-with-margin"
              placeholder="全部负责人"
              value={assigneeName ?? undefined}
              options={facetOptions(facetsQuery.data?.assignees)}
              onChange={(value) => setAssigneeName(value ?? null)}
            />
          </Col>
          <Col xs={24} md={8}>
            <Text strong>关键字</Text>
            <Input.Search
              className="select-with-margin"
              allowClear
              placeholder="编号或标题"
              onSearch={(value) => setKeyword(value)}
            />
          </Col>
        </Row>
      </Card>

      <Card
        title="Linky 同步"
        extra={
          props.canSync ? (
            <Space>
              <Button
                loading={syncMutation.isPending && syncMutation.variables === 'LIST'}
                onClick={() => syncMutation.mutate('LIST')}
              >
                刷新列表
              </Button>
              <Button
                type="primary"
                disabled={workspaceId === null}
                loading={syncMutation.isPending && syncMutation.variables === 'FULL'}
                onClick={() => syncMutation.mutate('FULL')}
              >
                完整同步（含正文与附件）
              </Button>
            </Space>
          ) : null
        }
      >
        <Space direction="vertical" size="small" className="full-width">
          <Text type="secondary">{describeSync(syncsQuery.data?.[0])}</Text>
          {workspaceId === null ? (
            <Alert
              type="info"
              showIcon
              title="完整同步需要先选定项目组"
              description="完整同步会逐条抓取需求正文与附件；不限定项目组等于把所有工作区拉一遍，所以平台直接拒绝。选定项目组（可再选发布窗口收窄）后再点。"
            />
          ) : null}
          {watchedSyncId !== null ? (
            <Alert
              type="info"
              showIcon
              title="同步进行中"
              description="请求已提交给内网 Worker，完成后列表与分面会自动刷新。"
            />
          ) : null}
        </Space>
      </Card>

      <Card title={`用户故事（${listQuery.data?.length ?? 0} 条）`} extra={props.actions}>
        <Table<LinkyCatalogStory>
          rowKey="issue_id"
          size="small"
          loading={listQuery.isLoading}
          dataSource={listQuery.data ?? []}
          columns={columns}
          pagination={{ pageSize: 20, showSizeChanger: true }}
          locale={{ emptyText: <Empty description="镜像里还没有数据，请先点「刷新列表」" /> }}
          rowSelection={
            props.selectable
              ? {
                  selectedRowKeys: props.selectedIssueIds ?? [],
                  onChange: (keys) => props.onSelectionChange?.(keys.map((key) => String(key))),
                }
              : undefined
          }
          onRow={(row) => ({ onClick: () => setDetailIssueId(row.issue_id) })}
        />
      </Card>

      <Drawer
        width={720}
        open={detailIssueId !== null}
        onClose={() => setDetailIssueId(null)}
        title={detail ? `${detail.story_code} ${detail.title}` : '需求详情'}
        loading={detailQuery.isLoading}
      >
        {detail === null ? (
          <Empty description="没有找到这条需求" />
        ) : (
          <Space direction="vertical" size="middle" className="full-width">
            <Descriptions column={1} size="small" bordered>
              <Descriptions.Item label="项目组">{detail.workspace_name}</Descriptions.Item>
              <Descriptions.Item label="状态">{detail.status_label ?? '—'}</Descriptions.Item>
              <Descriptions.Item label="发布窗口">{detail.release_window ?? '—'}</Descriptions.Item>
              <Descriptions.Item label="迭代">{detail.iteration ?? '—'}</Descriptions.Item>
              <Descriptions.Item label="关联特性">{detail.subject_name ?? '—'}</Descriptions.Item>
              <Descriptions.Item label="需求人员">{teamNames(detail.team, 'req') || '—'}</Descriptions.Item>
              <Descriptions.Item label="开发人员">{teamNames(detail.team, 'dev') || '—'}</Descriptions.Item>
              <Descriptions.Item label="测试人员">{teamNames(detail.team, 'test') || '—'}</Descriptions.Item>
            </Descriptions>
            {detail.team_resolve_error !== null ? (
              <Alert
                type="warning"
                showIcon
                title="负责人解析降级"
                description={`Linky 侧返回：${detail.team_resolve_error}。平台不会编造人名，请人工确认。`}
              />
            ) : null}
            {detail.story_url !== null ? (
              <a href={detail.story_url} target="_blank" rel="noreferrer">
                在 Linky 中打开
              </a>
            ) : null}
            <Card size="small" title="需求正文">
              {detail.requirement_detail === null || detail.requirement_detail.trim() === '' ? (
                <Alert
                  type="warning"
                  showIcon
                  title="正文还没有同步"
                  description="这条需求只做过列表同步。请先对它所在的项目组做一次「完整同步」，否则导入会被拒绝——AI 不能在不知道需求内容的情况下判断代码。"
                />
              ) : (
                <Paragraph className="linky-requirement-detail">
                  {detail.requirement_detail}
                </Paragraph>
              )}
            </Card>
            <Card size="small" title={`附件（${attachments.length} 个）`}>
              {attachments.length === 0 ? (
                <Text type="secondary">这条需求没有可见附件</Text>
              ) : (
                <Space direction="vertical" className="full-width">
                  {attachments.map((attachment) => (
                    <Space key={attachment.id} wrap>
                      <Text>{attachment.filename}</Text>
                      <Text type="secondary">
                        {attachment.size_bytes === null ? '' : `${attachment.size_bytes} 字节`}
                      </Text>
                      <Tag
                        color={
                          attachment.fetch_status === 'STORED'
                            ? 'green'
                            : attachment.fetch_status === 'FAILED'
                              ? 'red'
                              : 'orange'
                        }
                      >
                        {attachment.fetch_status}
                      </Tag>
                      {attachment.fetch_status === 'STORED' && attachment.storage_path !== null ? (
                        <Button
                          size="small"
                          onClick={async () => {
                            try {
                              const url = await createStoryAttachmentSignedUrl(
                                attachment.storage_path as string,
                              )
                              window.open(url, '_blank', 'noreferrer')
                            } catch (error) {
                              message.error(describeLinkyError(error))
                            }
                          }}
                        >
                          下载
                        </Button>
                      ) : null}
                      {attachment.fetch_error !== null ? (
                        <Text type="danger">{attachment.fetch_error}</Text>
                      ) : null}
                    </Space>
                  ))}
                </Space>
              )}
            </Card>
          </Space>
        )}
      </Drawer>
    </Space>
  )
}
