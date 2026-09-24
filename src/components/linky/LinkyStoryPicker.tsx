/**
 * Linky 用户故事选择器（V1.20 修订：实时直连）。
 *
 * 数据每次都从 Linky 现取，没有镜像、没有同步按钮 —— 「刷新」就是重新请求。
 * 看板页与批次导入页共用它：两边要看的字段、要过滤的维度完全一样，区别只在选完之后做什么。
 *
 * 筛选全部在**本地**做（一次拉回来的就是全量），所以切筛选条件不产生网络请求，
 * 分面计数也永远和列表一致 —— 不会出现"下拉里写 24 条、表里只有 3 条"。
 */
import { Fragment, useEffect, useMemo, useState } from 'react'
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
  /** 勾选摘要条右侧的操作区（导入按钮等）。 */
  actions?: ReactNode
  /** 选中的项目组变化时通知外部（批次导入需要它来定义"这批需求的来源"）。 */
  onScopeChange?: (scope: { workspaceName: string | null; releaseWindow: string | null }) => void
  /**
   * 初始范围：给定项目组时直接跳过门禁，按这个组展示列表。
   *
   * 批次已经导入过一次之后回到这一页，用的就是上次那张导入单的口径 —— 让人重新选一遍
   * 自己刚选过的组是纯粹的返工。只在挂载时读一次，之后由用户自己切换。
   */
  initialWorkspaceName?: string | null
  initialReleaseWindow?: string | null
  /**
   * 已经冻结进本批次的需求编号：显示成已勾选，且不允许取消。
   *
   * 取消它们没有任何真实含义 —— 这一页只能往批次里加需求，没有移除通道，取消勾选并不会
   * 把需求从批次里拿出来。所以做成不可点，而不是让人点完以为改了什么。
   */
  lockedCodes?: string[]
}

/**
 * 某个维度上的可选值：去重、去空、倒序。
 *
 * 只回值，不回计数 —— 下拉里的「（225）」既占宽度又帮不上决策：选项目组时看的是名字，
 * 条数在选完之后卡片标题里就有，而且那里的口径（当前筛选结果）才和表格一致。
 */
function facet(values: Array<string | null>): string[] {
  const seen = new Set<string>()
  for (const raw of values) {
    const value = raw === null ? '' : raw.trim()
    if (value === '') continue
    seen.add(value)
  }
  return [...seen].sort((a, b) => b.localeCompare(a))
}

export function LinkyStoryPicker(props: LinkyStoryPickerProps) {
  const { message } = AntApp.useApp()
  const [workspaceName, setWorkspaceName] = useState<string | null>(props.initialWorkspaceName ?? null)
  const [releaseWindow, setReleaseWindow] = useState<string | null>(props.initialReleaseWindow ?? null)
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
   * 勾选模式下先选项目组，再出列表。
   *
   * 导入单的口径是**单一项目组**，所以"跨全部工作区的 266 条"在这一页里没有任何可操作
   * 含义 —— 它只会让人先在一张不能勾的大表里翻半天，再回到上面去选组。改成门禁之后，
   * 「没选组时禁用勾选框」那套解释性 UI（表头占位符 + 下拉的 warning 态）就没有存在的
   * 理由了，一并删掉：能点的东西不需要解释为什么不能点。
   *
   * 看板页（`selectable` 为 false）不设门禁：那里的目的就是跨组浏览。
   */
  const workspaceRequired = props.selectable === true
  const workspaceChosen = workspaceName !== null
  const listVisible = !workspaceRequired || workspaceChosen

  /**
   * 一次把范围内的故事全取回来。
   *
   * 选了项目组就带 workspace 参数（接口按组分页，不会被跨组总量的翻页上限截断）。
   */
  const storiesQuery = useQuery({
    queryKey: ['linky-live-stories', workspaceName],
    queryFn: ({ signal }) => fetchLinkyStories({ workspaceName, signal }),
    enabled: listVisible,
    staleTime: 30_000,
    // 关掉窗口聚焦重取：这个页面有显式「刷新」按钮，而自动重取会在用户切回标签页时
    // 换掉 dataSource，把翻页、勾选的位置一起冲掉。
    refetchOnWindowFocus: false,
    retry: false,
  })

  /**
   * 项目组清单单独一条查询，永远不带 workspace 参数。
   *
   * 接口没有"列出工作区"的端点，工作区只能从跨组汇总的结果里抽出来。它必须独立于上面
   * 那条：一旦选了组，`storiesQuery` 回的就只有这个组的需求，facet 出来的清单会缩成一项，
   * 表现就是"选了之后换不了组，得先清空再选"。
   *
   * 没选组时两条查询的 queryKey 完全相同，react-query 直接复用同一次请求，不会多打一次。
   */
  const workspaceCatalogQuery = useQuery({
    queryKey: ['linky-live-stories', null],
    queryFn: ({ signal }) => fetchLinkyStories({ workspaceName: null, signal }),
    staleTime: 5 * 60_000,
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

  const workspaces = useMemo(
    () => facet((workspaceCatalogQuery.data?.stories ?? []).map((story) => story.workspaceName)),
    [workspaceCatalogQuery.data],
  )
  const scoped = useMemo(
    () => (workspaceName === null ? all : all.filter((story) => story.workspaceName === workspaceName)),
    [all, workspaceName],
  )
  const scopedCodes = useMemo(() => new Set(scoped.map((story) => story.storyCode)), [scoped])

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

  const options = (values: readonly string[]) => values.map((value) => ({ value, label: value }))

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
  const lockedCodes = useMemo(() => new Set(props.lockedCodes ?? []), [props.lockedCodes])
  /*
   * 全选与三态框的口径是「当前筛选结果里**还能勾**的条目」。
   *
   * 已冻结的那些必须排除，否则筛出 5 条、其中 1 条已冻结时，勾满剩下 4 条也永远只能是
   * indeterminate —— 全选框看起来像点不动。
   */
  const filteredCodes = useMemo(
    () => filtered.map((story) => story.storyCode).filter((code) => !lockedCodes.has(code)),
    [filtered, lockedCodes],
  )
  // 不用 useMemo 包 selectAll：`selectedCodes` 每次渲染都是新数组，memo 永远命中不了，只是噪音。
  const selectAll = selectAllState({ filteredCodes, selectedCodes })
  /*
   * 表格里真正打勾的集合 = 已冻结 + 本次新勾。
   *
   * 已冻结那部分不进 `props.selectedCodes` —— 那个是"这次要提交什么"，而已冻结的需求已经在
   * 批次里了，混进去会让「已勾选 N 条」和导入单上的条数都变成一个说不清口径的数。
   *
   * 不 memo：`selectedCodes` 本来每次渲染都是新数组，memo 也命中不了。
   */
  const checkedRowKeys = [...lockedCodes, ...selectedCodes.filter((code) => !lockedCodes.has(code))]

  /** 勾选变化的唯一出口：先剔掉已冻结的，再按项目组裁剪，最后把编号与对应故事一起回传。 */
  const applySelection = (codes: readonly string[]) => {
    const kept = pruneSelectionToScope(
      codes.filter((code) => !lockedCodes.has(code)),
      scopedCodes,
    )
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
  /*
   * 取数失败一律就地报出来，并带上接口地址与「重试」。
   *
   * 两条查询都要覆盖：门禁状态下只有项目组清单在跑，列表查询是 disabled 的 —— 只看
   * `storiesQuery.error` 会让"不在内网"表现成一个空下拉，而不是一条错误。
   */
  const loadError = (listVisible ? storiesQuery.error : null) ?? workspaceCatalogQuery.error
  const fetching = listVisible ? storiesQuery.isFetching : workspaceCatalogQuery.isFetching
  const dataUpdatedAt = listVisible ? storiesQuery.dataUpdatedAt : workspaceCatalogQuery.dataUpdatedAt
  const refresh = () => {
    void (listVisible ? storiesQuery : workspaceCatalogQuery).refetch()
    message.info('正在从 Linky 重新取数')
  }

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
          action={<Button size="small" onClick={refresh}>重试</Button>}
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
              {!listVisible
                ? '待选项目组'
                : filtered.length === all.length
                  ? `${String(all.length)} 条`
                  : `筛出 ${String(filtered.length)} / ${String(all.length)} 条`}
            </Text>
          </span>
        }
        /*
         * 卡片头只留「数据时间 + 刷新」。
         *
         * 之前这里还挤着勾选摘要和导入主按钮，四样东西在一行里互相挤到「刷 新」都被折成
         * 两行。主按钮是这一页的终点动作，它该待在离勾选最近的地方（下面的摘要条），
         * 而不是和取数时间抢同一行。
         */
        extra={
          <div className="story-board-card__tools">
            <span className="story-board-card__updated">
              {fetching
                ? '正在从 Linky 取数…'
                : dataUpdatedAt > 0
                  ? `数据时间 ${new Date(dataUpdatedAt).toLocaleTimeString()}`
                  : ''}
            </span>
            <Button size="small" loading={fetching} onClick={refresh}>
              刷新
            </Button>
          </div>
        }
      >
        {!listVisible ? (
          /*
           * 项目组门禁。
           *
           * 这里刻意不摆一张空表格：空表格会让人以为"这个组没有需求"。页面在这个状态下只有
           * 一个可做的动作，所以只放这一个控件。
           */
          <div key="gate" className="story-gate">
            <span className="story-gate__mark" aria-hidden="true" />
            <div className="story-gate__copy">
              <span className="story-gate__title">先选一个项目组</span>
              <span className="story-gate__hint">
                一张导入单只能来自一个项目组。选定之后这里会列出该组的全部需求，再勾选要冻结进本批次的条目。
              </span>
            </div>
            <Select
              showSearch
              className="story-gate__select"
              size="large"
              placeholder="选择项目组"
              loading={workspaceCatalogQuery.isLoading}
              options={options(workspaces)}
              onChange={(value) => changeWorkspace(value ?? null)}
              notFoundContent={
                workspaceCatalogQuery.isLoading
                  ? '正在从 Linky 取数…'
                  : loadError
                    ? '取数失败，见上方提示'
                    : '没有可用的项目组'
              }
            />
          </div>
        ) : (
          /*
           * 这个 Fragment 必须带 key。
           *
           * 顶层**无 key** 的 Fragment 会被 React 拆开，它的孩子直接跟另一个分支的孩子逐位
           * 对齐：门禁那边第 3 个孩子是项目组下拉，列表这边第 3 个孩子是「状态」下拉，类型
           * 同为 Select，于是实例被复用 —— 而 antd Select 在 `value` 为 undefined 时是非受控的，
           * 内部值跟着实例留下来，表现就是「状态」那一格显示成刚选的项目组。带上 key 之后
           * 两个分支是不同节点，切换即卸载重建。
           */
          <Fragment key="list">
            {/*
              * 筛选条用 flex 而不是 Row/Col 栅格：控件数量会变（导入页和看板页要的维度不同），
              * 栅格得跟着重算 span，flex 自己换行就行；末尾还能塞一个「清空筛选」而不占一格。
              */}
            <div className="story-filter-bar">
              <Select
                allowClear={!workspaceRequired}
                className="story-filter-bar__field story-filter-bar__field--wide"
                placeholder="全部项目组"
                loading={workspaceCatalogQuery.isLoading}
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

            {props.selectable ? (
              /*
               * 勾选摘要条：只回答「选了几条」和「下一步点哪里」。
               *
               * 刻意不再重复项目组与发布窗口 —— 它们就在正上方那排筛选控件里，而且那里才是能
               * 改它们的地方。同一个值在相邻 2cm 内出现两次，只会让人怀疑两处是不是不同的东西。
               */
              <div
                className={`story-action-bar${selectedCodes.length > 0 ? ' story-action-bar--active' : ''}`}
              >
                <span className="story-action-bar__summary">
                  <span className="story-action-bar__count">{selectedCodes.length}</span>
                  <span className="story-action-bar__label">条待导入</span>
                  {lockedCodes.size > 0 ? (
                    /*
                     * 这一句不能省。
                     *
                     * 表里有打着勾的灰行、而计数写着 0 时，第一反应是"勾选坏了"。它要说清那些勾
                     * 不属于本次提交，以及为什么点不动。
                     */
                    <span className="story-action-bar__locked">
                      另有 {lockedCodes.size} 条已冻结在本批次，不可取消
                    </span>
                  ) : null}
                </span>
                {selectedCodes.length > 0 ? (
                  <Button type="link" size="small" onClick={() => applySelection([])}>
                    清空勾选
                  </Button>
                ) : null}
                <span className="story-action-bar__actions">{props.actions}</span>
              </div>
            ) : null}

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
                      selectedRowKeys: checkedRowKeys,
                      preserveSelectedRowKeys: true,
                      // 已冻结的行：勾上且点不动，理由见 lockedCodes。
                      getCheckboxProps: (row) => ({ disabled: lockedCodes.has(row.storyCode) }),
                      /*
                       * 自己画全选框，不用 antd 默认的那个。
                       *
                       * 默认实现只管当前页：筛出 26 条、每页 10 条时点一次只勾 10 条，
                       * 得翻页点三次。这里换成"整份筛选结果"的三态框——勾上就是把筛出来的
                       * 全部选上，取消只移除筛选结果里的那些（筛选之外的同组勾选由
                       * preserveSelectedRowKeys 留着，不该被这个动作清掉）。
                       */
                      columnTitle: (
                        <Tooltip
                          title={
                            selectAll.checked
                              ? `取消已勾选的这 ${filteredCodes.length} 条`
                              : `全选当前筛选结果里还能勾的 ${filteredCodes.length} 条（不只是本页）`
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
          </Fragment>
        )}
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
