/**
 * 产品代码问答首页（V1.23）。
 *
 * 形态是对话窗口：左侧会话列表，右侧消息流 + 粘底输入区。它服务的场景很具体 ——
 * 产品经理在写需求之前想知道「某个仓库某个分支上，这个功能现在是怎么做的」，而他
 * 不熟悉工程细节，也不该为此占用开发的时间。
 *
 * 三件事在这个页面上是刻意的，不是没做完：
 *
 *   1. **仓库与分支在新建会话时定下，之后不可改。** 多轮对话里"你刚才说的那个方法"
 *      必须指向同一份代码；中途换仓库会让模型带着 A 仓的上下文解释 B 仓。
 *   2. **没有假进度条。** 每一句"正在……"都对应 Worker 在真实转换点上报的 stage。
 *      后端没上报的阶段，这里就不显示。
 *   3. **答案下面挂"依据"。** 列出 Agent 实际读过的文件与调用过的技能，产品可以拿着
 *      路径去找开发确认。一个无法核对的答案对写需求没有用。
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { DeleteOutlined, DownOutlined, EditOutlined, HistoryOutlined, MoreOutlined, PushpinOutlined } from '@ant-design/icons'
import {
  Alert,
  App as AntApp,
  Button,
  Collapse,
  Dropdown,
  Empty,
  Form,
  Input,
  List,
  Modal,
  Select,
  Space,
  Spin,
  Tag,
  Tooltip,
  Typography,
} from 'antd'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import {
  createCodeQaConversation,
  deleteCodeQaConversation,
  describeCodeQaRpcError,
  getCodeQaCatalog,
  getCodeQaConversation,
  listCodeQaConversations,
  listEnabledModelConfigs,
  renameCodeQaConversation,
  requestCodeQaTurn,
  setCodeQaConversationPinned,
} from '../lib/api'
import {
  CODE_QA_QUESTION_MAX_CHARS,
  codeQaPollInterval,
  describeCodeQaError,
  describeCodeQaStage,
  hasInFlightTurn,
  isCodeQaTurnTerminal,
  partitionCodeQaConversations,
  shouldWarnContextReset,
  summarizeCodeQaEvidence,
  validateCodeQaQuestion,
} from '../lib/code-qa'
import type { CodeQaConversationSummary, CodeQaTurn, DefaultBranch } from '../types'

const { Text, Paragraph, Title } = Typography

/** 分支的中文说明。产品不一定知道这三个分支各自意味着什么。 */
const BRANCH_HINTS: Record<DefaultBranch, string> = {
  feature_dev: '开发分支（最新，可能还没测过）',
  feature_sit: '集成测试分支',
  release: '发布分支（最接近线上）',
}

/** 无会话首页只提供真实、可回答的代码探索方向，不伪造产品能力。 */
const WELCOME_QUESTION_SUGGESTIONS = [
  '工单转派之后，原受理人的待办会怎么处理？',
  '现在的审批流有哪些驳回场景，各自回到哪一步？',
  '导出报表的字段是从哪些表和接口来的？',
  '这个功能的关键入口、服务和数据表分别在哪里？',
]

function TurnStatusTag({ turn }: { turn: CodeQaTurn }) {
  if (turn.status === 'FAILED') return <Tag color="red">失败</Tag>
  if (turn.status === 'SUCCEEDED') return <Tag color="green">已回答</Tag>
  return <Tag color="blue">{describeCodeQaStage(turn.stage)}</Tag>
}

/**
 * 一轮问答的"依据"区。
 *
 * 默认折叠：产品多数时候只想看答案。但它必须存在 —— 没有它，答案就是一段无法核对的
 * 文字，而这个平台的全部价值就建立在"结论可以回溯到证据"上。
 */
function TurnEvidence({ turn }: { turn: CodeQaTurn }) {
  const evidence = summarizeCodeQaEvidence(turn.evidence)
  const hasAnything =
    evidence.commits.length > 0 ||
    evidence.filesRead.length > 0 ||
    evidence.skillsUsed.length > 0
  if (!hasAnything) return null

  return (
    <Collapse
      ghost
      size="small"
      items={[
        {
          key: 'evidence',
          label: (
            <Text type="secondary" style={{ fontSize: 12 }}>
              依据：读了 {evidence.filesRead.length} 个文件
              {evidence.skillsUsed.length > 0 ? `，用了 ${evidence.skillsUsed.length} 个模块技能` : ''}
              {evidence.commits.length === 1
                ? `，代码版本 ${evidence.commits[0].shortSha}`
                : evidence.commits.length > 1
                  ? `，跨 ${evidence.commits.length} 个仓库`
                  : ''}
            </Text>
          ),
          children: (
            <Space direction="vertical" size={8} style={{ width: '100%' }}>
              {evidence.commits.length > 0 ? (
                <div>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    代码版本（每个仓库各自固定）：
                  </Text>
                  <ul style={{ margin: '4px 0 0', paddingLeft: 20 }}>
                    {evidence.commits.map((entry) => (
                      <li key={entry.repository}>
                        <Text style={{ fontSize: 12 }}>{entry.repository} @ </Text>
                        <Text code copyable={{ text: entry.commitSha }} style={{ fontSize: 12 }}>
                          {entry.shortSha}
                        </Text>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {evidence.filesRead.length > 0 ? (
                <div>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    实际读过的文件（可拿着路径找开发确认）：
                  </Text>
                  <ul style={{ margin: '4px 0 0', paddingLeft: 20 }}>
                    {evidence.filesRead.map((file) => (
                      <li key={file}>
                        <Text code style={{ fontSize: 12 }}>
                          {file}
                        </Text>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {evidence.skillsUsed.length > 0 ? (
                <div>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    参与回答的模块技能：
                  </Text>
                  <div style={{ marginTop: 4 }}>
                    {evidence.skillsUsed.map((skill) => (
                      <Tag key={skill}>{skill}</Tag>
                    ))}
                  </div>
                </div>
              ) : null}
              {evidence.toolCallCount !== null ? (
                <Text type="secondary" style={{ fontSize: 12 }}>
                  检索动作 {evidence.toolCallCount} 次
                  {turn.model_label ? ` · 模型 ${turn.model_label}` : ''}
                </Text>
              ) : null}
            </Space>
          ),
        },
      ]}
    />
  )
}

function MessageBubbles({ turn }: { turn: CodeQaTurn }) {
  return (
    <div className="code-qa-turn">
      <div className="code-qa-bubble code-qa-bubble-user">
        <Paragraph style={{ marginBottom: 0, whiteSpace: 'pre-wrap' }}>{turn.question}</Paragraph>
      </div>

      <div className="code-qa-bubble code-qa-bubble-agent">
        <div style={{ marginBottom: 8 }}>
          <TurnStatusTag turn={turn} />
        </div>

        {turn.status === 'FAILED' ? (
          <Alert
            type="error"
            showIcon
            message="这个问题没有回答成功"
            description={describeCodeQaError(turn.error_code, turn.error_message)}
          />
        ) : null}

        {!isCodeQaTurnTerminal(turn.status) ? (
          <Space>
            <Spin size="small" />
            <Text type="secondary">{describeCodeQaStage(turn.stage)}</Text>
          </Space>
        ) : null}

        {turn.answer ? (
          <Paragraph style={{ marginBottom: 8, whiteSpace: 'pre-wrap' }}>{turn.answer}</Paragraph>
        ) : null}

        <TurnEvidence turn={turn} />
      </div>
    </div>
  )
}

export default function CodeQaPage() {
  const { message, modal } = AntApp.useApp()
  const queryClient = useQueryClient()
  const [activeId, setActiveId] = useState<string | null>(null)
  // 产品页默认从居中新建会话开始；历史会话只能由用户主动选择。
  const [isStartingConversation, setIsStartingConversation] = useState(true)
  const [mobileHistoryExpanded, setMobileHistoryExpanded] = useState(false)
  const [draft, setDraft] = useState('')
  const [welcomeDraft, setWelcomeDraft] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const [renameTarget, setRenameTarget] = useState<CodeQaConversationSummary | null>(null)
  const [renameTitle, setRenameTitle] = useState('')
  const [createForm] = Form.useForm<{
    repositories: string[]
    branch: DefaultBranch
    modelConfigId: string
  }>()
  const streamEndRef = useRef<HTMLDivElement | null>(null)

  const catalogQuery = useQuery({ queryKey: ['code-qa-catalog'], queryFn: getCodeQaCatalog })
  // 只返回启用且已配置密钥的安全摘要；服务端创建 RPC 仍会再次校验，不能信任浏览器。
  const modelsQuery = useQuery({
    queryKey: ['enabled-model-configs'],
    queryFn: listEnabledModelConfigs,
  })
  const listQuery = useQuery({
    queryKey: ['code-qa-conversations'],
    queryFn: listCodeQaConversations,
  })

  const detailQuery = useQuery({
    queryKey: ['code-qa-conversation', activeId],
    queryFn: () => getCodeQaConversation(activeId as string),
    enabled: activeId !== null,
    // 有在飞轮次时 2 秒一次，全部终态后停。判定在 lib/code-qa.ts 里，可单测。
    refetchInterval: (query) => codeQaPollInterval(query.state.data),
  })

  const conversations = listQuery.data ?? []
  const { pinned: pinnedConversations, recent: recentConversations } = partitionCodeQaConversations(conversations)
  const detail = detailQuery.data
  const turns = detail?.turns ?? []
  const inFlight = hasInFlightTurn(turns)

  // 首次加载后自动选中最近一个会话；显式新建时保持居中提问态。
  useEffect(() => {
    if (!isStartingConversation && activeId === null && conversations.length > 0) {
      setActiveId(conversations[0].id)
    }
  }, [activeId, conversations, isStartingConversation])

  // 新消息进来时滚到底，行为与常见对话产品一致。
  useEffect(() => {
    streamEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [turns.length, turns[turns.length - 1]?.status])

  const createMutation = useMutation({
    mutationFn: createCodeQaConversation,
    onSuccess: (created) => {
      setCreateOpen(false)
      createForm.resetFields()
      setIsStartingConversation(false)
      setActiveId(created.id)
      queryClient.invalidateQueries({ queryKey: ['code-qa-conversations'] })
    },
    onError: (error) => message.error(describeCodeQaRpcError(error)),
  })

  const askMutation = useMutation({
    mutationFn: requestCodeQaTurn,
    onSuccess: () => {
      setDraft('')
      queryClient.invalidateQueries({ queryKey: ['code-qa-conversation', activeId] })
      queryClient.invalidateQueries({ queryKey: ['code-qa-conversations'] })
    },
    onError: (error) => message.error(describeCodeQaRpcError(error)),
  })

  const renameMutation = useMutation({
    mutationFn: (input: { conversationId: string; title: string }) => renameCodeQaConversation(input),
    onSuccess: (updated) => {
      if (activeId === updated.id) queryClient.invalidateQueries({ queryKey: ['code-qa-conversation', updated.id] })
      queryClient.invalidateQueries({ queryKey: ['code-qa-conversations'] })
      message.success('对话已重命名')
      setRenameTarget(null)
      setRenameTitle('')
    },
    onError: (error) => message.error(describeCodeQaRpcError(error)),
  })

  const pinMutation = useMutation({
    mutationFn: (input: { conversationId: string; isPinned: boolean }) =>
      setCodeQaConversationPinned(input),
    onSuccess: (updated) => {
      if (activeId === updated.id) queryClient.invalidateQueries({ queryKey: ['code-qa-conversation', updated.id] })
      queryClient.invalidateQueries({ queryKey: ['code-qa-conversations'] })
      message.success(updated.is_pinned ? '对话已置顶' : '已取消置顶')
    },
    onError: (error) => message.error(describeCodeQaRpcError(error)),
  })

  const deleteMutation = useMutation({
    mutationFn: deleteCodeQaConversation,
    onSuccess: (_result, deletedId) => {
      if (activeId === deletedId) {
        setActiveId(null)
        setIsStartingConversation(true)
      }
      queryClient.invalidateQueries({ queryKey: ['code-qa-conversations'] })
    },
    onError: (error) => message.error(describeCodeQaRpcError(error)),
  })

  const repositories = catalogQuery.data?.repositories ?? []
  const branches = catalogQuery.data?.branches ?? []
  const models = modelsQuery.data ?? []
  const hasNoSelectableModel = modelsQuery.isSuccess && models.length === 0

  const draftCheck = useMemo(
    () => validateCodeQaQuestion({ question: draft, hasInFlightTurn: inFlight }),
    [draft, inFlight],
  )

  const submitQuestion = () => {
    if (activeId === null) return
    if (!draftCheck.ok) {
      if (draft.trim() !== '') message.warning(draftCheck.reason)
      return
    }
    askMutation.mutate({ conversationId: activeId, question: draft.trim() })
  }

  const startNewConversation = () => {
    setMobileHistoryExpanded(false)
    setActiveId(null)
    setDraft('')
    setWelcomeDraft('')
    setIsStartingConversation(true)
  }

  const selectConversation = (conversationId: string) => {
    setMobileHistoryExpanded(false)
    setIsStartingConversation(false)
    setActiveId(conversationId)
  }

  /**
   * 首屏先收集用户真正想问的问题，再让用户明确代码范围；不能把“未选仓库”的草稿
   * 直接发给 Worker。创建成功后 draft 会保留在正常对话输入框中，等待用户确认发送。
   */
  const openConversationSetup = (question = welcomeDraft) => {
    setDraft(question.trim())
    setWelcomeDraft('')
    setCreateOpen(true)
  }

  const renderConversationGroup = (title: string, items: CodeQaConversationSummary[]) => (
    <section className="code-qa-conversation-group" aria-label={title}>
      <Text className="code-qa-conversation-group__title">{title}</Text>
      <List
        size="small"
        dataSource={items}
        renderItem={(item) => (
          <List.Item
            className={
              item.id === activeId ? 'code-qa-conv code-qa-conv-active' : 'code-qa-conv'
            }
            onClick={() => selectConversation(item.id)}
            role="button"
            tabIndex={0}
            aria-current={item.id === activeId}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                selectConversation(item.id)
              }
            }}
          >
            <div className="code-qa-conv__content">
              <Text
                className="code-qa-conv-title"
                ellipsis
                style={{ fontWeight: item.id === activeId ? 600 : 400 }}
              >
                {item.title}
              </Text>
              <Dropdown
                trigger={['click']}
                menu={{
                  items: [
                    {
                      key: 'pin',
                      icon: <PushpinOutlined />,
                      label: item.is_pinned ? '取消置顶' : '置顶',
                      disabled: pinMutation.isPending,
                    },
                    { type: 'divider' },
                    { key: 'rename', icon: <EditOutlined />, label: '重命名' },
                    { type: 'divider' },
                    { key: 'delete', danger: true, icon: <DeleteOutlined />, label: '删除' },
                  ],
                  onClick: ({ key, domEvent }) => {
                    domEvent.stopPropagation()
                    if (key === 'pin') {
                      pinMutation.mutate({ conversationId: item.id, isPinned: !item.is_pinned })
                      return
                    }
                    if (key === 'rename') {
                      setRenameTarget(item)
                      setRenameTitle(item.title)
                      return
                    }
                    modal.confirm({
                      title: `删除“${item.title}”？`,
                      content: '删除后历史问答不可恢复。',
                      okText: '删除',
                      cancelText: '取消',
                      okButtonProps: { danger: true },
                      onOk: () => deleteMutation.mutateAsync(item.id),
                    })
                  },
                }}
              >
                <Button
                  className="code-qa-conv__more"
                  type="text"
                  size="small"
                  icon={<MoreOutlined />}
                  aria-label={`管理对话：${item.title}`}
                  onClick={(event) => event.stopPropagation()}
                  onKeyDown={(event) => event.stopPropagation()}
                />
              </Dropdown>
            </div>
          </List.Item>
        )}
      />
    </section>
  )

  return (
    <div className={`code-qa-layout${isStartingConversation || activeId === null ? '' : ' code-qa-layout--active'}${mobileHistoryExpanded ? ' code-qa-layout--history-open' : ''}`}>
      <aside
        className={mobileHistoryExpanded ? 'code-qa-sidebar code-qa-sidebar--mobile-expanded' : 'code-qa-sidebar'}
        aria-label="历史会话"
      >
        <div className="code-qa-sidebar-heading">
          <Text className="code-qa-sidebar-title">历史对话</Text>
          <Button
            type="text"
            className="code-qa-history-toggle"
            aria-controls="code-qa-sidebar-history"
            aria-expanded={mobileHistoryExpanded}
            onClick={() => setMobileHistoryExpanded((expanded) => !expanded)}
          >
            <HistoryOutlined />
            <span>历史对话</span>
            {conversations.length > 0 ? <span className="code-qa-history-count">{conversations.length}</span> : null}
            <DownOutlined className="code-qa-history-chevron" />
          </Button>
          <Button
            type="primary"
            block
            className="code-qa-new-conversation"
            onClick={startNewConversation}
            disabled={repositories.length === 0 || hasNoSelectableModel}
          >
            新建对话
          </Button>
        </div>

        <div id="code-qa-sidebar-history" className="code-qa-sidebar-history">
          {listQuery.isLoading ? (
            <div style={{ padding: 16, textAlign: 'center' }}>
              <Spin size="small" />
            </div>
          ) : conversations.length === 0 ? (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="还没有对话"
              style={{ marginTop: 24 }}
            />
          ) : (
            <>
              {pinnedConversations.length > 0
                ? renderConversationGroup('置顶', pinnedConversations)
                : null}
              {recentConversations.length > 0
                ? renderConversationGroup('默认', recentConversations)
                : null}
            </>
          )}
        </div>
      </aside>

      <section className="code-qa-main" aria-label="对话">
        {isStartingConversation || activeId === null ? (
          <div className="code-qa-welcome" aria-labelledby="code-qa-welcome-title">
            <div className="code-qa-welcome-inner">
              <Title id="code-qa-welcome-title" level={1} className="code-qa-welcome-title">
                立即开启代码探索
              </Title>
              <Paragraph className="code-qa-welcome-description">
                描述你想了解的功能或流程。选择代码范围后，AI 会基于真实代码检索回答，并保留可核对的文件依据。
              </Paragraph>
              <div className="code-qa-welcome-composer">
                <Input.TextArea
                  className="code-qa-welcome-input"
                  value={welcomeDraft}
                  onChange={(event) => setWelcomeDraft(event.target.value)}
                  placeholder="描述你想了解的功能、流程或代码行为"
                  autoSize={false}
                  maxLength={CODE_QA_QUESTION_MAX_CHARS}
                  aria-label="输入想了解的代码问题"
                  onPressEnter={(event) => {
                    if (!event.shiftKey) {
                      event.preventDefault()
                      openConversationSetup()
                    }
                  }}
                />
                <div className="code-qa-welcome-actions">
                  <Text className="code-qa-welcome-hint">选择仓库和分支后开始提问 · Shift+Enter 换行</Text>
                  <Button type="primary" className="code-qa-welcome-start" onClick={() => openConversationSetup()}>
                    开始
                  </Button>
                </div>
              </div>
              <div className="code-qa-welcome-suggestions" aria-label="常见代码问题">
                {WELCOME_QUESTION_SUGGESTIONS.map((question) => (
                  <button
                    key={question}
                    className="code-qa-welcome-suggestion"
                    type="button"
                    onClick={() => openConversationSetup(question)}
                  >
                    {question}
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <>
            <div className="code-qa-topbar">
              <div className="code-qa-topbar-main">
                <Text className="code-qa-conversation-title">{detail?.title ?? '对话'}</Text>
                {detail ? (
                  <div className="code-qa-context-pills" aria-label="本次对话的代码与模型范围">
                    {detail.repositories.map((repo) => {
                      const sha = detail.commit_shas?.[repo]
                      return (
                        <Tooltip
                          key={repo}
                          title={
                            sha
                              ? `${repo} 固定看这一版代码：${sha}`
                              : `${repo}：代码还没拉取，第一次提问时拉取并固定`
                          }
                        >
                          <span className="code-qa-context-pill code-qa-context-repository">
                            <span className="code-qa-context-key">代码</span>
                            <span>{repo}</span>
                            <span className="code-qa-context-state">{sha ? `@ ${sha.slice(0, 8)}` : '待拉取'}</span>
                          </span>
                        </Tooltip>
                      )
                    })}
                    <span className="code-qa-context-pill code-qa-context-branch">
                      <span className="code-qa-context-key">分支</span>
                      <span>{detail.branch}</span>
                    </span>
                    {detail.selected_model_display_name ? (
                      <span className="code-qa-context-pill code-qa-context-model">
                        <span className="code-qa-context-key">模型</span>
                        <span>{detail.selected_model_display_name}</span>
                      </span>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>

            {shouldWarnContextReset(turns) ? (
              <Alert
                type="warning"
                showIcon
                style={{ marginBottom: 12 }}
                message="这个对话的上下文中断过一次"
                description="从上一轮开始，AI 不再记得更早的问答。追问时请把背景重新说一遍，或新建对话。"
              />
            ) : null}

            <div className="code-qa-stream" aria-live="polite">
              {detailQuery.isLoading ? (
                <div style={{ textAlign: 'center', padding: 24 }}>
                  <Spin />
                </div>
              ) : turns.length === 0 ? (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description="问第一个问题吧"
                  style={{ marginTop: 32 }}
                />
              ) : (
                turns.map((turn) => <MessageBubbles key={turn.id} turn={turn} />)
              )}
              <div ref={streamEndRef} />
            </div>

            <div className="code-qa-composer">
              <Input.TextArea
                className="code-qa-composer-input"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder={
                  inFlight ? '上一个问题还在回答中…' : '用自己的话描述你想了解的功能或流程'
                }
                autoSize={{ minRows: 1, maxRows: 5 }}
                maxLength={CODE_QA_QUESTION_MAX_CHARS}
                disabled={inFlight}
                aria-label="输入问题"
                onPressEnter={(event) => {
                  // Enter 发送，Shift+Enter 换行 —— 与常见对话产品一致。
                  if (!event.shiftKey) {
                    event.preventDefault()
                    submitQuestion()
                  }
                }}
              />
              <div className="code-qa-composer-actions">
                <Text className="code-qa-composer-hint" type="secondary">
                  Enter 发送 · Shift+Enter 换行
                </Text>
                <button
                  type="button"
                  aria-label="发送问题"
                  title="发送问题"
                  className="code-qa-send-button"
                  onClick={submitQuestion}
                  disabled={inFlight || draft.trim() === ''}
                >
                  {askMutation.isPending ? <Spin size="small" /> : <span className="code-qa-send-icon" aria-hidden="true" />}
                </button>
              </div>
            </div>
          </>
        )}
      </section>

      <Modal
        title="重命名对话"
        open={renameTarget !== null}
        okText="保存"
        cancelText="取消"
        okButtonProps={{ disabled: renameTitle.trim() === '' }}
        confirmLoading={renameMutation.isPending}
        onCancel={() => {
          setRenameTarget(null)
          setRenameTitle('')
        }}
        onOk={() => {
          if (renameTarget === null || renameTitle.trim() === '') return
          renameMutation.mutate({ conversationId: renameTarget.id, title: renameTitle.trim() })
        }}
        destroyOnHidden
      >
        <Input
          autoFocus
          maxLength={200}
          value={renameTitle}
          placeholder="输入对话名称"
          onChange={(event) => setRenameTitle(event.target.value)}
          onPressEnter={() => {
            if (renameTarget !== null && renameTitle.trim() !== '') {
              renameMutation.mutate({ conversationId: renameTarget.id, title: renameTitle.trim() })
            }
          }}
        />
      </Modal>

      <Modal
        title="新建对话"
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        onOk={() => createForm.submit()}
        confirmLoading={createMutation.isPending}
        okText="开始提问"
        cancelText="取消"
        destroyOnHidden
      >
        <Form
          form={createForm}
          layout="vertical"
          initialValues={{ branch: 'release' }}
          onFinish={(values) => createMutation.mutate(values)}
        >
          <Form.Item
            name="modelConfigId"
            label="问答模型（单选）"
            rules={[{ required: true, message: '请选择一个问答模型' }]}
          >
            <Select
              placeholder="选择一个用于本会话的模型"
              loading={modelsQuery.isLoading}
              disabled={hasNoSelectableModel}
              options={models.map((model) => ({
                value: model.id,
                label: model.display_name,
              }))}
            />
          </Form.Item>
          <Form.Item
            name="repositories"
            label="仓库（可多选）"
            rules={[{ required: true, message: '请至少选择一个仓库' }]}
          >
            <Select
              mode="multiple"
              allowClear
              placeholder="选择要问的代码仓库，可选多个"
              options={repositories.map((repo) => ({
                value: repo.name,
                label: `${repo.name}（${repo.gitlab_project}）`,
              }))}
              showSearch
              // 选 3 个以上时折叠成 "+N"，否则选择框会把弹窗撑变形。
              maxTagCount={3}
            />
          </Form.Item>
          <Form.Item
            name="branch"
            label="分支"
            rules={[{ required: true, message: '请选择分支' }]}
          >
            <Select
              options={branches.map((branch) => ({
                value: branch,
                label: `${branch} — ${BRANCH_HINTS[branch] ?? ''}`,
              }))}
            />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
