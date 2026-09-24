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
  Checkbox,
  Descriptions,
  Drawer,
  Empty,
  Input,
  Select,
  Space,
  Spin,
  Table,
  Tag,
  Tooltip,
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
import { pruneSelectionToScope, selectAllState, shouldResetSelection, toggleSelectAllFiltered } from './story-selection'

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
  const [pageSize, setPageSize] = useState(10)

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
  const scopedCodes = useMemo(() => new Set(scoped.map((story) => story.storyCode)), [scoped])
  /**
   * 没选项目组时不许勾选。
   *
   * 导入单按单一项目组冻结，而这个状态下的列表是跨全部工作区汇总的；放开勾选就等于允许
   * 提交一批注定 `LINKY_NOT_FOUND` 的编号。与其事后报错，不如在这里就选不上。
   *
   * 理由摆在两个当事控件上：筛选里「项目组」标签旁的一行提示（告诉去哪做），以及表头那个
   * 替换了全选框的占位符（解释为什么点不动）。都是 hover 出全文，不占版面。
   */
  const selectionLocked = props.selectable === true && workspaceName === null

  /**
   * 切项目组时清空历史勾选。
   *
   * 写在事件里而不是 effect 里：清空是"用户切了项目组"这个动作的直接后果，放进 effect
   * 会多一轮渲染，也会让 `preserveSelectedRowKeys` 在这一轮里短暂持有跨组的编号。
   */
  const changeWorkspace = (value: string | null) => {
    if (
      props.selectable === true &&
      shouldResetSelection({
        previousWorkspaceName: workspaceName,
        nextWorkspaceName: value,
        selectedCount: props.selectedCodes?.length ?? 0,
      })
    ) {
      const count = props.selectedCodes?.length ?? 0
      props.onSelectionChange?.([], [])
      message.info(`已清空之前勾选的 ${count} 条：一张导入单只能来自一个项目组`)
    }
    setWorkspaceName(value)
    setReleaseWindow(null)
  }

  const releaseWindows = useMemo(() => facet(scoped.map((story) => story.releaseWindow)), [scoped])
  const statuses = useMemo(() => facet(scoped.map((story) => story.statusLabel)), [scoped])
  const assignees = useMemo(() => facet(scoped.map((story) => story.assigneeName)), [scoped])

  // 筛选条件变了就回第 1 页：否则会停在一个已经没有数据的页码上。
  useEffect(() => {
    setPage(1)
  }, [workspaceName, releaseWindow, statusLabel, assigneeName, keyword])

  const filtered = useMemo(() => {
    const needle = keyword.trim().toLowerCase()
    return scoped.filter((story) => {
      if (releaseWindow !== null && story.releaseWindow !== releaseWindow) return false
      if (statusLabel !== null && story.statusLabel !== statusLabel) return false
      if (assigneeName !== null && story.assigneeName !== assigneeName) return false
      if (needle !== '') {
        const hay = `${story.storyCode} ${story.title}`.toLowerCase()
        if (!hay.includes(needle)) return false
      }
      return true
    })
  }, [scoped, releaseWindow, statusLabel, assigneeName, keyword])

  const options = (entries: Array<{ value: string; count: number }>) =>
    entries.map((entry) => ({ value: entry.value, label: `${entry.value}（${entry.count}）` }))

  /** 除项目组以外的筛选是否生效 —— 项目组定义导入口径，不跟着「清空」一起动。 */
  const secondaryFilterActive =
    releaseWindow !== null || statusLabel !== null || assigneeName !== null || keyword.trim() !== ''

  const clearSecondaryFilters = () => {
    setReleaseWindow(null)
    setStatusLabel(null)
    setAssigneeName(null)
    setKeyword('')
  }

  const selectedCodes = props.selectedCodes ?? []
  const filteredCodes = useMemo(() => filtered.map((story) => story.storyCode), [filtered])
  // 表头全选的口径是"当前筛选结果的全部条目"，与分页无关，理由见 selectAllState。
  // 不用 useMemo：`selectedCodes` 每次渲染都是新数组，memo 永远命中不了，只是噪音。
  const selectAll = selectAllState({ filteredCodes, selectedCodes })

  /** 勾选变化的唯一出口：先按项目组裁剪，再把编号与对应故事一起回传。 */
  const applySelection = (codes: readonly string[]) => {
    const kept = pruneSelectionToScope(codes, scopedCodes)
    const keptSet = new Set(kept)
    const chosen = scoped.filter((story) => keptSet.has(story.storyCode))
    props.onSelectionChange?.(kept, chosen)
  }

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

      {/*
        * 筛选与列表合成一张卡片。
        *
        * 原来是上下两张 Card：光是"筛选"这个标题、卡片内外边距和每个控件上面的文字标签，
        * 就把真正要看的列表推下去大半屏。控件的 placeholder 已经写着「全部项目组」之类，
        * 标签是重复信息，删掉不丢语义。
        */}
      <Card
        className="story-board-card"
        title={
          <span className="story-board-card__heading">
            用户故事
            <Text type="secondary" className="story-board-card__count">
              {filtered.length === all.length
                ? `${String(all.length)} 条`
                : `筛出 ${String(filtered.length)} / ${String(all.length)} 条`}
            </Text>
          </span>
        }
        extra={
          <Space wrap>
            <Text type="secondary">
              {storiesQuery.isFetching
                ? '正在从 Linky 取数…'
                : storiesQuery.dataUpdatedAt > 0
                  ? `数据时间 ${new Date(storiesQuery.dataUpdatedAt).toLocaleTimeString()}`
                  : ''}
            </Text>
            <Button
              size="small"
              loading={storiesQuery.isFetching}
              onClick={() => {
                void storiesQuery.refetch()
                message.info('正在从 Linky 重新取数')
              }}
            >
              刷新
            </Button>
            {props.actions}
          </Space>
        }
      >
        {/*
          * 筛选条用 flex 而不是 Row/Col 栅格：控件数量会变（导入页和看板页要的维度不同），
          * 栅格得跟着重算 span，flex 自己换行就行；末尾还能塞一个「清空筛选」而不占一格。
          */}
        <div className="story-filter-bar">
          <Select
            allowClear
            className="story-filter-bar__field story-filter-bar__field--wide"
            placeholder={selectionLocked ? '全部项目组（勾选前必选）' : '全部项目组'}
            status={selectionLocked ? 'warning' : undefined}
            loading={storiesQuery.isLoading}
            value={workspaceName ?? undefined}
            options={options(workspaces)}
            onChange={(value) => changeWorkspace(value ?? null)}
          />
          <Select
            allowClear
            className="story-filter-bar__field"
            placeholder="全部发布窗口"
            value={releaseWindow ?? undefined}
            options={options(releaseWindows)}
            onChange={(value) => setReleaseWindow(value ?? null)}
          />
          <Select
            allowClear
            className="story-filter-bar__field"
            placeholder="全部状态"
            value={statusLabel ?? undefined}
            options={options(statuses)}
            onChange={(value) => setStatusLabel(value ?? null)}
          />
          <Select
            allowClear
            showSearch
            className="story-filter-bar__field"
            placeholder="全部负责人"
            value={assigneeName ?? undefined}
            options={options(assignees)}
            onChange={(value) => setAssigneeName(value ?? null)}
          />
          <Input
            allowClear
            className="story-filter-bar__search"
            placeholder="编号或标题"
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
          />
          {secondaryFilterActive ? (
            <Tooltip title="项目组保持不变，其余条件清空">
              <Button type="link" size="small" onClick={clearSecondaryFilters}>
                清空筛选
              </Button>
            </Tooltip>
          ) : null}
        </div>

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
                  selectedRowKeys: selectedCodes,
                  preserveSelectedRowKeys: true,
                  // 没选项目组时禁用勾选框，理由见 selectionLocked。
                  getCheckboxProps: () => ({ disabled: selectionLocked }),
                  /*
                   * 锁定时把「全选」换成一个可悬浮的占位符。
                   *
                   * 原来这里是表格上方一整块 Alert：它把最该看的列表往下推，而且在"已经选了
                   * 项目组"的常规路径上纯属噪音。把理由挂在**被禁用的那个控件本身**上，
                   * 谁去点谁看得到，不占垂直空间。
                   */
                  columnTitle: selectionLocked ? (
                    <Tooltip title="先在上方选定项目组，才能勾选需求">
                      <span className="selection-locked-mark" aria-label="先选项目组才能勾选">
                        —
                      </span>
                    </Tooltip>
                  ) : (
                    /*
                     * 自己画全选框，不用 antd 默认的那个。
                     *
                     * 默认实现只管当前页：筛出 26 条、每页 10 条时点一次只勾 10 条，
                     * 得翻页点三次。这里换成"整份筛选结果"的三态框——勾上就是把筛出来的
                     * 全部选上，取消只移除筛选结果里的那些（筛选之外的同组勾选由
                     * preserveSelectedRowKeys 留着，不该被这个动作清掉）。
                     */
                    <Tooltip
                      title={
                        selectAll.checked
                          ? `取消已勾选的这 ${filteredCodes.length} 条`
                          : `全选当前筛选结果的 ${filteredCodes.length} 条（不只是本页）`
                      }
                    >
                      <Checkbox
                        checked={selectAll.checked}
                        indeterminate={selectAll.indeterminate}
                        disabled={filteredCodes.length === 0}
                        aria-label="全选当前筛选结果"
                        onChange={(event) =>
                          applySelection(
                            toggleSelectAllFiltered({
                              selectedCodes,
                              filteredCodes,
                              select: event.target.checked,
                            }),
                          )
                        }
                      />
                    </Tooltip>
                  ),
                  onChange: (keys) => {
                    // 只保留当前项目组里的编号：preserveSelectedRowKeys 留住的跨组勾选
                    // 提交后必然逐条 LINKY_NOT_FOUND。
                    applySelection(keys.map((key) => String(key)))
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
            <Card size="small" title="需求正文">
              {detail === null || detail.requirementDetail === null ? (
                <Alert
                  type="warning"
                  showIcon
                  title="这条需求在 Linky 里没有正文"
                  description="仍然可以导入，AI 会按标题和附件判断；但只有标题时一致性结论会明显更弱。要更准就先在 Linky 里补上需求描述或挂 PRD 附件。"
                />
              ) : (
                <Paragraph className="linky-requirement-detail">{detail.requirementDetail}</Paragraph>
              )}
            </Card>
            <Card
              size="small"
              title={`附件（${attachments.length} 个）`}
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
