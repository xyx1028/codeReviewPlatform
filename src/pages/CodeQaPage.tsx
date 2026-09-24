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
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Collapse,
  Empty,
  Form,
  Input,
  List,
  Modal,
  Popconfirm,
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
  requestCodeQaTurn,
} from '../lib/api'
import {
  CODE_QA_QUESTION_MAX_CHARS,
  codeQaPollInterval,
  describeCodeQaError,
  describeCodeQaStage,
  hasInFlightTurn,
  isCodeQaTurnTerminal,
  shouldWarnContextReset,
  summarizeCodeQaEvidence,
  validateCodeQaQuestion,
} from '../lib/code-qa'
import type { CodeQaTurn, DefaultBranch } from '../types'

const { Text, Paragraph, Title } = Typography

/** 分支的中文说明。产品不一定知道这三个分支各自意味着什么。 */
const BRANCH_HINTS: Record<DefaultBranch, string> = {
  feature_dev: '开发分支（最新，可能还没测过）',
  feature_sit: '集成测试分支',
  release: '发布分支（最接近线上）',
}

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
  const { message } = AntApp.useApp()
  const queryClient = useQueryClient()
  const [activeId, setActiveId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const [createForm] = Form.useForm<{ repositories: string[]; branch: DefaultBranch }>()
  const streamEndRef = useRef<HTMLDivElement | null>(null)

  const catalogQuery = useQuery({ queryKey: ['code-qa-catalog'], queryFn: getCodeQaCatalog })
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
  const detail = detailQuery.data
  const turns = detail?.turns ?? []
  const inFlight = hasInFlightTurn(turns)

  // 首次加载后自动选中最近一个会话，省掉一次点击。
  useEffect(() => {
    if (activeId === null && conversations.length > 0) {
      setActiveId(conversations[0].id)
    }
  }, [activeId, conversations])

  // 新消息进来时滚到底，行为与常见对话产品一致。
  useEffect(() => {
    streamEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [turns.length, turns[turns.length - 1]?.status])

  const createMutation = useMutation({
    mutationFn: createCodeQaConversation,
    onSuccess: (created) => {
      setCreateOpen(false)
      createForm.resetFields()
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

  const deleteMutation = useMutation({
    mutationFn: deleteCodeQaConversation,
    onSuccess: () => {
      setActiveId(null)
      queryClient.invalidateQueries({ queryKey: ['code-qa-conversations'] })
    },
    onError: (error) => message.error(describeCodeQaRpcError(error)),
  })

  const repositories = catalogQuery.data?.repositories ?? []
  const branches = catalogQuery.data?.branches ?? []
  const skills = catalogQuery.data?.skills ?? []

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

  return (
    <div className="code-qa-layout">
      <aside className="code-qa-sidebar" aria-label="会话列表">
        <Button
          type="primary"
          block
          onClick={() => setCreateOpen(true)}
          disabled={repositories.length === 0}
        >
          新建对话
        </Button>

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
          <List
            size="small"
            dataSource={conversations}
            renderItem={(item) => (
              <List.Item
                className={
                  item.id === activeId ? 'code-qa-conv code-qa-conv-active' : 'code-qa-conv'
                }
                onClick={() => setActiveId(item.id)}
                // 列表项可点，必须能用键盘操作。
                role="button"
                tabIndex={0}
                aria-current={item.id === activeId}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    setActiveId(item.id)
                  }
                }}
              >
                <Space direction="vertical" size={2} style={{ width: '100%' }}>
                  <Text ellipsis style={{ fontWeight: item.id === activeId ? 600 : 400 }}>
                    {item.title}
                  </Text>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {/* 多仓库时只显示"N 个仓库"，列宽放不下全部名字。悬浮看完整清单。 */}
                    {item.repositories.length === 1
                      ? item.repositories[0]
                      : `${item.repositories.length} 个仓库`}
                    {' · '}
                    {item.branch} · {item.turn_count} 问
                  </Text>
                </Space>
              </List.Item>
            )}
          />
        )}
      </aside>

      <section className="code-qa-main" aria-label="对话">
        {activeId === null ? (
          <Card>
            <Title level={4}>问问代码现在是怎么做的</Title>
            <Paragraph type="secondary">
              选一个仓库和分支新建对话，然后用自己的话提问。平台会拉取那个分支的真实代码，
              让 AI 自己去翻代码回答你，并把它读过的文件列出来供你核对。
            </Paragraph>
            <Paragraph type="secondary" style={{ marginBottom: 8 }}>
              适合问的问题，例如：
            </Paragraph>
            <ul style={{ color: 'rgba(0,0,0,0.45)' }}>
              <li>工单转派之后，原受理人的待办会怎么处理？</li>
              <li>现在的审批流一共有几种驳回场景，各自回到哪一步？</li>
              <li>导出报表的字段是从哪几张表来的？</li>
            </ul>
            {skills.length > 0 ? (
              <Paragraph type="secondary" style={{ marginTop: 16, marginBottom: 0 }}>
                可参与回答的模块技能：
                {skills.map((skill) => (
                  <Tooltip key={skill.name} title={skill.description ?? undefined}>
                    <Tag style={{ marginInlineStart: 4 }}>{skill.display_name ?? skill.name}</Tag>
                  </Tooltip>
                ))}
              </Paragraph>
            ) : null}
          </Card>
        ) : (
          <>
            <div className="code-qa-topbar">
              <Space size={8} wrap>
                <Text strong>{detail?.title ?? '对话'}</Text>
                {detail ? (
                  <>
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
                          <Tag color={sha ? 'purple' : undefined}>
                            {repo}
                            {sha ? ` @ ${sha.slice(0, 8)}` : ' · 待拉取'}
                          </Tag>
                        </Tooltip>
                      )
                    })}
                    <Tag color="geekblue">{detail.branch}</Tag>
                  </>
                ) : null}
              </Space>
              <Popconfirm
                title="删除这个对话？"
                description="删除后历史问答不可恢复。"
                okText="删除"
                cancelText="取消"
                okButtonProps={{ danger: true }}
                onConfirm={() => deleteMutation.mutate(activeId)}
              >
                <Button size="small" danger disabled={inFlight} loading={deleteMutation.isPending}>
                  删除
                </Button>
              </Popconfirm>
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
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder={
                  inFlight ? '上一个问题还在回答中…' : '用自己的话描述你想了解的功能或流程'
                }
                autoSize={{ minRows: 2, maxRows: 6 }}
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
                <Text type="secondary" style={{ fontSize: 12 }}>
                  Enter 发送 · Shift+Enter 换行
                </Text>
                <Button
                  type="primary"
                  onClick={submitQuestion}
                  loading={askMutation.isPending}
                  disabled={inFlight || draft.trim() === ''}
                >
                  发送
                </Button>
              </div>
            </div>
          </>
        )}
      </section>

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
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message="仓库和分支选定后不能再改"
          description="可以一次选多个仓库（比如前端 + 后端），适合问跨端联动的问题。一个对话固定看这些仓库的同一版代码，这样追问时引用的文件才不会错位。要换仓库或看最新代码，新建一个对话。"
        />
        <Form
          form={createForm}
          layout="vertical"
          initialValues={{ branch: 'release' }}
          onFinish={(values) => createMutation.mutate(values)}
        >
          <Form.Item
            name="repositories"
            label="仓库（可多选）"
            rules={[{ required: true, message: '请至少选择一个仓库' }]}
            extra="选多个仓库时，AI 会在每段结论上说清它属于哪个仓库。"
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
            extra="所有选中的仓库都看这个分支。"
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
