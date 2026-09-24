/**
 * Linky 用户故事选择器（V1.20 修订：实时直连）。
 *
 * 数据每次都从 Linky 现取，没有镜像、没有同步按钮 —— 「刷新」就是重新请求。
 * 看板页与批次导入页共用它：两边要看的字段、要过滤的维度完全一样，区别只在选完之后做什么。
 *
 * 筛选全部在**本地**做（一次拉回来的就是全量），所以切筛选条件不产生网络请求，
 * 分面计数也永远和列表一致 —— 不会出现"下拉里写 24 条、表里只有 3 条"。
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
  Spin,
  Table,
  Tag,
  Typography,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { useQuery } from '@tanstack/react-query'
import {
  fetchLinkyAttachments,
  fetchLinkyStories,
  fetchLinkyStoryDetail,
  linkyApiBase,
  type LinkyLiveStory,
} from '../../lib/linky-live'

const { Text, Paragraph } = Typography

export interface LinkyStoryPickerProps {
  selectable?: boolean
  selectedCodes?: string[]
  onSelectionChange?: (codes: string[], stories: LinkyLiveStory[]) => void
  /** 勾选区右侧的操作区（导入按钮等）。 */
  actions?: ReactNode
  /** 选中的项目组变化时通知外部（批次导入需要它来定义"这批需求的来源"）。 */
  onScopeChange?: (scope: { workspaceName: string | null; releaseWindow: string | null }) => void
}

function facet(values: Array<string | null>): Array<{ value: string; count: number }> {
  const counter = new Map<string, number>()
  for (const raw of values) {
    const value = raw === null || raw.trim() === '' ? '' : raw
    if (value === '') continue
    counter.set(value, (counter.get(value) ?? 0) + 1)
  }
  return [...counter.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.value.localeCompare(a.value))
}

export function LinkyStoryPicker(props: LinkyStoryPickerProps) {
  const { message } = AntApp.useApp()
  const [workspaceName, setWorkspaceName] = useState<string | null>(null)
  const [releaseWindow, setReleaseWindow] = useState<string | null>(null)
  const [iteration, setIteration] = useState<string | null>(null)
  const [statusLabel, setStatusLabel] = useState<string | null>(null)
  const [assigneeName, setAssigneeName] = useState<string | null>(null)
  const [keyword, setKeyword] = useState('')
  const [detailCode, setDetailCode] = useState<string | null>(null)
  /**
   * 分页受控。
   *
   * 不能交给 antd 自己记：`dataSource` 的引用一变（刷新、窗口重新聚焦触发的重取都会变），
   * 它就把 current 重置回第 1 页 —— 表现就是"点了第 2 页又跳回来，像翻不动"。
   */
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)

  /**
   * 一次把范围内的故事全取回来。
   *
   * 没选项目组时不带 workspace 参数（接口会跨全部启用工作区汇总）—— 项目组下拉只能这么
   * 得到，因为接口没有"列出工作区"的端点。
   */
  const storiesQuery = useQuery({
    queryKey: ['linky-live-stories', workspaceName],
    queryFn: ({ signal }) => fetchLinkyStories({ workspaceName, signal }),
    staleTime: 30_000,
    // 关掉窗口聚焦重取：这个页面有显式「刷新」按钮，而自动重取会在用户切回标签页时
    // 换掉 dataSource，把翻页、勾选的位置一起冲掉。
    refetchOnWindowFocus: false,
    retry: false,
  })

  const detailQuery = useQuery({
    queryKey: ['linky-live-detail', detailCode],
    queryFn: ({ signal }) => fetchLinkyStoryDetail(detailCode as string, signal),
    enabled: detailCode !== null,
    retry: false,
  })
  const attachmentsQuery = useQuery({
    queryKey: ['linky-live-attachments', detailCode],
    queryFn: ({ signal }) => fetchLinkyAttachments(detailCode as string, signal),
    enabled: detailCode !== null,
    retry: false,
  })

  const all = storiesQuery.data?.stories ?? []

  useEffect(() => {
    props.onScopeChange?.({ workspaceName, releaseWindow })
  }, [workspaceName, releaseWindow, props.onScopeChange])

  const workspaces = useMemo(() => facet(all.map((story) => story.workspaceName)), [all])
  const scoped = useMemo(
    () => (workspaceName === null ? all : all.filter((story) => story.workspaceName === workspaceName)),
    [all, workspaceName],
  )
  const releaseWindows = useMemo(() => facet(scoped.map((story) => story.releaseWindow)), [scoped])
  const iterations = useMemo(() => facet(scoped.map((story) => story.iteration)), [scoped])
  const statuses = useMemo(() => facet(scoped.map((story) => story.statusLabel)), [scoped])
  const assignees = useMemo(() => facet(scoped.map((story) => story.assigneeName)), [scoped])

  // 筛选条件变了就回第 1 页：否则会停在一个已经没有数据的页码上。
  useEffect(() => {
    setPage(1)
  }, [workspaceName, releaseWindow, iteration, statusLabel, assigneeName, keyword])

  const filtered = useMemo(() => {
    const needle = keyword.trim().toLowerCase()
    return scoped.filter((story) => {
      if (releaseWindow !== null && story.releaseWindow !== releaseWindow) return false
      if (iteration !== null && story.iteration !== iteration) return false
      if (statusLabel !== null && story.statusLabel !== statusLabel) return false
      if (assigneeName !== null && story.assigneeName !== assigneeName) return false
      if (needle !== '') {
        const hay = `${story.storyCode} ${story.title}`.toLowerCase()
        if (!hay.includes(needle)) return false
      }
      return true
    })
  }, [scoped, releaseWindow, iteration, statusLabel, assigneeName, keyword])

  const options = (entries: Array<{ value: string; count: number }>) =>
    entries.map((entry) => ({ value: entry.value, label: `${entry.value}（${entry.count}）` }))

  const columns: ColumnsType<LinkyLiveStory> = useMemo(
    () => [
      { title: '编号', dataIndex: 'storyCode', width: 150 },
      { title: '标题', dataIndex: 'title', ellipsis: true },
      {
        title: '状态',
        dataIndex: 'statusLabel',
        width: 120,
        render: (value: string | null) => (value ? <Tag>{value}</Tag> : <Text type="secondary">—</Text>),
      },
      { title: '负责人', dataIndex: 'assigneeName', width: 100 },
      { title: '发布窗口', dataIndex: 'releaseWindow', width: 120 },
      { title: '迭代', dataIndex: 'iteration', width: 170, ellipsis: true },
      { title: '关联特性', dataIndex: 'subjectName', width: 200, ellipsis: true },
      {
        title: '',
        width: 72,
        fixed: 'right',
        render: (_, row) => (
          <Button
            size="small"
            type="link"
            onClick={(event) => {
              event.stopPropagation()
              setDetailCode(row.storyCode)
            }}
          >
            详情
          </Button>
        ),
      },
    ],
    [],
  )

  const detail = detailQuery.data ?? null
  const attachments = attachmentsQuery.data ?? []
  const loadError = storiesQuery.error

  return (
    <Space direction="vertical" size="large" className="page-stack">
      {loadError ? (
        <Alert
          type="error"
          showIcon
          title="读不到 Linky 的数据"
          description={
            <Space direction="vertical" size={4}>
              <span>{loadError instanceof Error ? loadError.message : String(loadError)}</span>
              <Text type="secondary">接口地址：{linkyApiBase()}</Text>
            </Space>
          }
          action={<Button size="small" onClick={() => storiesQuery.refetch()}>重试</Button>}
        />
      ) : null}

      <Card
        title="筛选"
        extra={
          <Space>
            <Text type="secondary">
              {storiesQuery.isFetching
                ? '正在从 Linky 取数…'
                : storiesQuery.dataUpdatedAt > 0
                  ? `数据时间 ${new Date(storiesQuery.dataUpdatedAt).toLocaleTimeString()}`
                  : ''}
            </Text>
            <Button
              loading={storiesQuery.isFetching}
              onClick={() => {
                void storiesQuery.refetch()
                message.info('正在从 Linky 重新取数')
              }}
            >
              刷新
            </Button>
          </Space>
        }
      >
        <Row gutter={[12, 12]}>
          <Col xs={24} md={8}>
            <Text strong>项目组</Text>
            <Select
              allowClear
              className="full-width select-with-margin"
              placeholder="全部项目组"
              loading={storiesQuery.isLoading}
              value={workspaceName ?? undefined}
              options={options(workspaces)}
              onChange={(value) => {
                setWorkspaceName(value ?? null)
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
              options={options(releaseWindows)}
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
              options={options(iterations)}
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
              options={options(statuses)}
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
              options={options(assignees)}
              onChange={(value) => setAssigneeName(value ?? null)}
            />
          </Col>
          <Col xs={24} md={8}>
            <Text strong>关键字</Text>
            <Input
              className="select-with-margin"
              allowClear
              placeholder="编号或标题"
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
            />
          </Col>
        </Row>
      </Card>

      <Card title={`用户故事（${filtered.length} / ${all.length} 条）`} extra={props.actions}>
        <Table<LinkyLiveStory>
          rowKey="storyCode"
          size="small"
          loading={storiesQuery.isLoading}
          dataSource={filtered}
          columns={columns}
          pagination={{
            current: page,
            pageSize,
            showSizeChanger: true,
            showTotal: (total) => `共 ${total} 条`,
            onChange: (nextPage, nextSize) => {
              setPage(nextPage)
              if (nextSize !== pageSize) setPageSize(nextSize)
            },
          }}
          locale={{
            emptyText: loadError ? (
              <Empty description="Linky 取数失败，见上方提示" />
            ) : (
              <Empty description="这个范围里没有需求" />
            ),
          }}
          rowSelection={
            props.selectable
              ? {
                  selectedRowKeys: props.selectedCodes ?? [],
                  preserveSelectedRowKeys: true,
                  onChange: (keys) => {
                    const codes = keys.map((key) => String(key))
                    const chosen = all.filter((story) => codes.includes(story.storyCode))
                    props.onSelectionChange?.(codes, chosen)
                  },
                }
              : undefined
          }
        />
      </Card>

      <Drawer
        width={720}
        open={detailCode !== null}
        onClose={() => setDetailCode(null)}
        title={detailCode ?? '需求详情'}
      >
        {detailQuery.isLoading ? (
          <Spin />
        ) : detailQuery.error ? (
          <Alert
            type="error"
            showIcon
            title="读不到这条需求"
            description={
              detailQuery.error instanceof Error ? detailQuery.error.message : '未知错误'
            }
          />
        ) : (
          <Space direction="vertical" size="middle" className="full-width">
            {(() => {
              const story = all.find((entry) => entry.storyCode === detailCode)
              if (story === undefined) return null
              return (
                <Descriptions column={1} size="small" bordered>
                  <Descriptions.Item label="标题">{story.title}</Descriptions.Item>
                  <Descriptions.Item label="项目组">{story.workspaceName}</Descriptions.Item>
                  <Descriptions.Item label="状态">{story.statusLabel ?? '—'}</Descriptions.Item>
                  <Descriptions.Item label="发布窗口">{story.releaseWindow ?? '—'}</Descriptions.Item>
                  <Descriptions.Item label="迭代">{story.iteration ?? '—'}</Descriptions.Item>
                  <Descriptions.Item label="关联特性">{story.subjectName ?? '—'}</Descriptions.Item>
                  <Descriptions.Item label="需求人员">
                    {detail?.team?.req.map((member) => member.name).join('、') || '—'}
                  </Descriptions.Item>
                  <Descriptions.Item label="开发人员">
                    {detail?.team?.dev.map((member) => member.name).join('、') || '—'}
                  </Descriptions.Item>
                  <Descriptions.Item label="测试人员">
                    {detail?.team?.test.map((member) => member.name).join('、') || '—'}
                  </Descriptions.Item>
                </Descriptions>
              )
            })()}
            {detail?.teamResolveError ? (
              <Alert
                type="warning"
                showIcon
                title="负责人解析降级"
                description={`Linky 侧返回：${detail.teamResolveError}。平台不会编造人名，请人工确认。`}
              />
            ) : null}
            <Card size="small" title="需求正文（实时）">
              {detail === null || detail.requirementDetail === null ? (
                <Alert
                  type="warning"
                  showIcon
                  title="这条需求在 Linky 里没有正文"
                  description="导入批次时会被拒绝——AI 不能在不知道需求内容的情况下判断代码是否实现了它。请先在 Linky 里补上需求描述。"
                />
              ) : (
                <Paragraph className="linky-requirement-detail">{detail.requirementDetail}</Paragraph>
              )}
            </Card>
            <Card
              size="small"
              title={`附件（${attachments.length} 个，实时）`}
              loading={attachmentsQuery.isLoading}
            >
              {attachmentsQuery.error ? (
                <Text type="danger">
                  {attachmentsQuery.error instanceof Error
                    ? attachmentsQuery.error.message
                    : '附件读取失败'}
                </Text>
              ) : attachments.length === 0 ? (
                <Text type="secondary">这条需求没有可见附件</Text>
              ) : (
                <Space direction="vertical" className="full-width">
                  {attachments.map((attachment) => (
                    <Space key={attachment.id} wrap>
                      <Text>{attachment.filename}</Text>
                      <Text type="secondary">
                        {attachment.sizeBytes === null ? '' : `${attachment.sizeBytes} 字节`}
                      </Text>
                      <Button
                        size="small"
                        href={attachment.downloadUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        下载
                      </Button>
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
