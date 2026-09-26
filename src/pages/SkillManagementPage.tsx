import {
  Alert,
  App as AntApp,
  Button,
  Descriptions,
  Empty,
  Input,
  Modal,
  Progress,
  Space,
  Steps,
  Table,
  Tag,
  Tooltip,
  Typography,
  Upload,
} from 'antd'
import type { UploadFile } from 'antd/es/upload/interface'
import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  adminCreateSkillDownloadUrl,
  adminDeleteReviewSkill,
  adminEnqueueSkillAiOptimization,
  adminGetReviewSkill,
  adminGetSkillAiOptimizationTask,
  adminGetSkillOptimizationDiff,
  adminGetSkillReviewEvidence,
  adminListReviewSkills,
  adminPublishSkillVersion,
  adminSetReviewSkillEnabled,
  adminUploadSkillBundle,
} from '../lib/api'
import { SkillCreateWizard } from './SkillCreateWizard'
import { SidebarPageTitle } from '../components/SidebarPageTitle'
import { getSkillBundleDownloadUrl } from '../lib/skill-download-url'
import { formatSkillVersion } from '../lib/skill-version'
import {
  canOptimizeFromEvidence,
  describeEvidenceUnavailable,
  collapseUnchanged,
  describeOptimizationError,
  fileChangeKind,
  FILE_CHANGE_LABELS,
  groupEvidenceBatches,
  isOptimizationInFlight,
  optimizationStepIndex,
  renderFileDiff,
  summarizeEvidence,
  type DiffLine,
} from '../lib/skill-ai-optimization'
import type {
  ReviewSkillListItem,
  ReviewSkillStatus,
  ReviewSkillVersionDetail,
  SkillBundleFile,
  SkillFileDiff,
  SkillFileRole,
  SkillHumanReviewKey,
  SkillReviewEvidence,
  SkillValidationResult,
  SkillVerdictKey,
} from '../types'

const { Text } = Typography

const STATUS_LABELS: Record<ReviewSkillStatus, { text: string; color: string }> = {
  DRAFT: { text: '草稿', color: 'default' },
  VALIDATING: { text: '校验中', color: 'processing' },
  PUBLISHED: { text: '已发布', color: 'green' },
  DISABLED: { text: '已停用', color: 'orange' },
  VALIDATION_FAILED: { text: '校验失败', color: 'red' },
}

const ROLE_LABELS: Record<SkillFileRole, string> = {
  ENTRY: '入口',
  REFERENCE: '参考资料',
  ASSET: '图片资源',
  TEMPLATE: '模板',
  SCRIPT: '脚本',
  OTHER: '其他',
}

/** V1.19 证据区块的列标签。顺序固定，与数据库返回的 key 一一对应。 */
const VERDICT_LABELS: Array<[SkillVerdictKey, string]> = [
  ['IMPLEMENTED', '已实现'],
  ['PARTIAL', '部分实现'],
  ['NOT_IMPLEMENTED', '未实现'],
  ['UNCERTAIN', '无法确定'],
]

const HUMAN_REVIEW_LABELS: Array<[SkillHumanReviewKey, string]> = [
  ['CORRECT', '人工：对'],
  ['PARTIALLY_CORRECT', '人工：部分对'],
  ['INCORRECT', '人工：错'],
  ['NEED_DISCUSSION', '人工：需讨论'],
]

const VERDICT_TEXT: Record<string, string> = Object.fromEntries(VERDICT_LABELS)
const HUMAN_REVIEW_TEXT: Record<string, string> = {
  CORRECT: '对',
  PARTIALLY_CORRECT: '部分对',
  INCORRECT: '错',
  NEED_DISCUSSION: '需讨论',
}

const SKILL_MODAL_STYLE = {
  height: 'min(660px, calc(100vh - 80px))',
  maxHeight: 'calc(100vh - 80px)',
} as const

const SKILL_MODAL_STYLES = {
  container: { height: '100%', display: 'flex', flexDirection: 'column' },
  body: {
    flex: '1 1 auto',
    minHeight: 0,
    overflow: 'auto',
    overscrollBehavior: 'contain',
    scrollbarGutter: 'stable',
  },
} as const

// 详情弹窗内容分两段：顶部信息区固定，文件列表区独立滚动。
// 这样切换文件列表页码时，技能元信息与「待发布/当前版本」状态块不会跟着滚动或移动。
const SKILL_DETAIL_BODY_STYLE = {
  height: '100%',
  display: 'flex',
  flexDirection: 'column',
  gap: 16,
  minHeight: 0,
  overflow: 'hidden',
} as const

const SKILL_DETAIL_HEADER_STYLE = {
  flex: '0 0 auto',
  display: 'flex',
  flexDirection: 'column',
  gap: 16,
} as const

const SKILL_DETAIL_SCROLL_STYLE = {
  flex: '1 1 auto',
  minHeight: 0,
  // 表格用 scroll.y 自己内部滚动，这里不再叠加一层滚动条（否则最右侧会多出一条外层滚动条）。
  overflow: 'hidden',
} as const

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

/** 服务端解析出来的文件树。展示 hash / MIME / 角色 / 大小，不展示任何文件正文。 */
export function BundleFileTree({ files }: { files: SkillBundleFile[] }) {
  const paginated = files.length > 10
  const wrapperRef = useRef<HTMLDivElement>(null)
  // 表体滚动高度。设了 scroll.y 后 antd 会把表头钉在顶部、表体内部滚动，分页行留在表格下方
  // （不进滚动区）。表格内部这一条是唯一的滚动条，外层文件列表区不再单独出滚动条。
  const [scrollY, setScrollY] = useState<number | undefined>(undefined)

  useLayoutEffect(() => {
    const el = wrapperRef.current
    if (el === null) return
    const compute = () => {
      const headerH = (el.querySelector('.ant-table-thead') as HTMLElement | null)?.offsetHeight ?? 39
      const pagEl = el.querySelector('.ant-table-pagination') as HTMLElement | null
      // 分页行留在滚动区之外，把它的高度（含 16px 外边距）从可用空间里扣掉，让它正好贴在底部。
      const pagH = pagEl === null ? 0 : pagEl.offsetHeight + 16
      const available = el.clientHeight - headerH - pagH
      setScrollY(available > 120 ? available : 120)
    }
    compute()
    const ro = new ResizeObserver(compute)
    ro.observe(el)
    return () => ro.disconnect()
  }, [files.length])

  return (
    <div ref={wrapperRef} style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <Table<SkillBundleFile>
        dataSource={files}
        rowKey="path"
        size="small"
        scroll={{ y: scrollY }}
        pagination={
          paginated
            ? {
                size: 'small',
                defaultPageSize: 10,
                showSizeChanger: true,
                pageSizeOptions: [10, 20, 50, 100],
                showTotal: (total, range) => `第 ${range[0]}-${range[1]} 条 / 共 ${total} 个文件`,
              }
            : false
        }
        columns={[
          { title: '路径', dataIndex: 'path', ellipsis: true },
          {
            title: '角色',
            dataIndex: 'role',
            width: 110,
            render: (role: SkillFileRole) => (
              <Tag color={role === 'SCRIPT' ? 'red' : role === 'ENTRY' ? 'blue' : 'default'}>
                {ROLE_LABELS[role]}
              </Tag>
            ),
          },
          { title: 'MIME', dataIndex: 'mediaType', width: 150 },
          {
            title: '大小',
            dataIndex: 'sizeBytes',
            width: 100,
            render: (value: number) => formatBytes(value),
          },
          {
            title: 'SHA-256',
            dataIndex: 'sha256',
            width: 160,
            render: (value: string) => (
              <Tooltip title={value}>
                <Text code>{value.replace('sha256:', '').slice(0, 12)}…</Text>
              </Tooltip>
            ),
          },
        ]}
      />
    </div>
  )
}

/**
 * 历史评审证据区块（V1.19）。
 *
 * 它回答一个问题：**这个技能上线之后，评审结果好不好？** 在这之前，`review_skill` 与
 * `ai_review_result` 之间没有任何界面把它们关联起来，管理员只能靠回忆判断该改哪里。
 *
 * 没有证据时显示明确的禁用说明，而不是一张空表：空表会让人以为"数据还没加载出来"。
 */
export function SkillReviewEvidenceBlock({
  evidence,
  loading,
}: {
  evidence: SkillReviewEvidence | null
  loading: boolean
}) {
  const batchGroups = useMemo(() => groupEvidenceBatches(evidence), [evidence])
  if (loading) return <Text type="secondary">正在汇总历史评审证据…</Text>
  if (evidence === null) return <Text type="secondary">暂无历史评审证据。</Text>
  if (!canOptimizeFromEvidence(evidence)) {
    const unavailable = describeEvidenceUnavailable(evidence)
    return <Alert type="info" showIcon message={unavailable.title} description={unavailable.detail} />
  }

  return (
    <Space direction="vertical" size="small" className="full-width">
      <Text>{summarizeEvidence(evidence)}</Text>
      <Descriptions size="small" column={4} bordered>
        {VERDICT_LABELS.map(([key, label]) => (
          <Descriptions.Item key={key} label={label}>
            {evidence.verdict_counts[key] ?? 0}
          </Descriptions.Item>
        ))}
        {HUMAN_REVIEW_LABELS.map(([key, label]) => (
          <Descriptions.Item key={key} label={label}>
            {evidence.human_review_counts[key] ?? 0}
          </Descriptions.Item>
        ))}
      </Descriptions>

      {/*
        用到这个技能的任务批次。
        显示批次名 + 周次而不是 Job id：管理员记得的是「第 39 周那个批次评得不准」，
        Job id 对他没有意义。同一批次重跑过就会有多个 Job，折进「分析任务次数」。
      */}
      <Text strong>用到这个技能的评审批次</Text>
      {batchGroups.length === 0 ? (
        <Text type="secondary">
          这些分析任务所属的批次信息不可用（升级前创建的历史任务不带批次投影）。
        </Text>
      ) : (
        <Table
          dataSource={batchGroups}
          rowKey="batch_id"
          size="small"
          pagination={batchGroups.length > 10 ? { size: 'small', pageSize: 10, showSizeChanger: true, pageSizeOptions: [10, 20, 50, 100] } : false}
          columns={[
            { title: '批次', dataIndex: 'batch_name', ellipsis: true },
            {
              title: '周次',
              dataIndex: 'week_code',
              width: 110,
              render: (value: string | null) => value ?? '—',
            },
            {
              title: '用到的技能版本',
              dataIndex: 'skill_versions',
              width: 140,
              render: (versions: number[]) =>
                versions.length === 0
                  ? '—'
                  : versions
                      .slice()
                      .sort((a, b) => a - b)
                      .map((version) => formatSkillVersion(version))
                      .join('、'),
            },
            {
              title: '分析任务次数',
              dataIndex: 'job_count',
              width: 120,
              align: 'center' as const,
            },
            {
              title: '评审结论数',
              dataIndex: 'result_count',
              width: 110,
              align: 'center' as const,
            },
            {
              title: '最近一次',
              dataIndex: 'latest_job_at',
              width: 165,
              render: (value: string | null) =>
                value === null ? '—' : new Date(value).toLocaleString(),
            },
          ]}
        />
      )}

      <Text strong>抽样评审结论</Text>
      {evidence.sample_findings.length === 0 ? (
        <Text type="secondary">这些分析任务下还没有产生评审结论。</Text>
      ) : (
        <Table
          dataSource={evidence.sample_findings.map((sample, index) => ({
            ...sample,
            key: `${sample.story_code}-${index}`,
          }))}
          rowKey="key"
          size="small"
          pagination={evidence.sample_findings.length > 10 ? { size: 'small', pageSize: 10, showSizeChanger: true, pageSizeOptions: [10, 20, 50, 100] } : false}
          columns={[
            { title: '需求', dataIndex: 'story_code', width: 120, ellipsis: true },
            {
              title: 'AI 结论',
              dataIndex: 'verdict',
              width: 130,
              render: (verdict: string) => <Tag>{VERDICT_TEXT[verdict] ?? verdict}</Tag>,
            },
            {
              title: '人工复核',
              dataIndex: 'human_review_result',
              width: 110,
              render: (value: string | null) =>
                value === null ? (
                  <Text type="secondary">未复核</Text>
                ) : (
                  <Tag color={value === 'CORRECT' ? 'green' : 'orange'}>
                    {HUMAN_REVIEW_TEXT[value] ?? value}
                  </Tag>
                ),
            },
            {
              title: '摘要 / 人工意见',
              key: 'text',
              render: (_unused: unknown, row: SkillReviewEvidence['sample_findings'][number]) => (
                <Space direction="vertical" size={0}>
                  <Text>{row.summary === '' ? '—' : row.summary}</Text>
                  {row.human_review_comment === null ? null : (
                    <Text type="secondary">人工：{row.human_review_comment}</Text>
                  )}
                </Space>
              ),
            },
          ]}
        />
      )}
    </Space>
  )
}

/**
 * 逐行 diff。
 *
 * 只渲染服务端认定为"改动过"的文件，两侧正文都由服务端从两个归档里解出来 —— 浏览器
 * 不解 ZIP、也读不到 `skill-bundles`（那个 bucket 对 `authenticated` 没有任何策略）。
 *
 * 大段未改动内容折叠：一份 SKILL.md 可能几百行而只改三处，全量渲染会让"确认发布"前的
 * 审阅退化成滚屏。
 */
export function SkillFileDiffView({ file }: { file: SkillFileDiff }) {
  const kind = fileChangeKind(file)
  const rendered = renderFileDiff(file)
  const rows = collapseUnchanged(rendered.lines)
  return (
    <div className="skill-diff">
      <div className="skill-diff__header">
        <Text code>{file.path}</Text>
        <Space size={4}>
          <Tag
            color={
              kind === 'ADDED'
                ? 'green'
                : kind === 'DELETED'
                  ? 'red'
                  : kind === 'BINARY'
                    ? 'default'
                    : 'blue'
            }
          >
            {FILE_CHANGE_LABELS[kind]}
          </Tag>
          {kind === 'BINARY' ? null : (
            <>
              <Tag color="green">+{rendered.stats.added}</Tag>
              <Tag color="red">-{rendered.stats.removed}</Tag>
            </>
          )}
          {rendered.lineEndingChanged ? <Tag color="orange">仅行尾符变化</Tag> : null}
        </Space>
      </div>
      {kind === 'BINARY' ? (
        <div className="skill-diff__gap">
          二进制文件，只能新增或删除，没有逐行 diff。
        </div>
      ) : (
        <pre className="skill-diff__body">
          {rows.map((row: DiffLine | null, index: number) =>
            row === null ? (
              <div key={`gap-${index}`} className="skill-diff__gap">
                ⋯ 省略未改动内容 ⋯
              </div>
            ) : (
              <div
                key={`${row.kind}-${index}`}
                className={`skill-diff__line skill-diff__line--${row.kind.toLowerCase()}`}
              >
                <span className="skill-diff__gutter">{row.beforeLineNumber ?? ''}</span>
                <span className="skill-diff__gutter">{row.afterLineNumber ?? ''}</span>
                <span className="skill-diff__sign">
                  {row.kind === 'ADDED' ? '+' : row.kind === 'REMOVED' ? '-' : ' '}
                </span>
                <span className="skill-diff__text">{row.text === '' ? ' ' : row.text}</span>
              </div>
            ),
          )}
        </pre>
      )}
    </div>
  )
}

/**
 * ADMIN 维护多文件 Skill Bundle。
 *
 * 页面的核心约束来自方案 §14：
 *
 *   * `name` 创建后不可改 —— 它是 `<DSH_HOME>/skills/<name>/` 的目录名，改它等于换一个技能；
 *   * 上传只到 staging，**校验成功后才能发布**；
 *   * 文件树、每文件 hash/MIME/角色/大小全部来自服务端解析，前端不自己解 ZIP；
 *   * 发布后不可替换 ZIP，只能创建下一版本。
 *
 * 导航只对 ADMIN 显示，但那不是安全边界：`ensure_admin()` 与 Edge Function 的
 * `requireAdmin` 才是。
 */
export function SkillManagementPage({ isAdmin }: { isAdmin: boolean }) {
  const { message, modal } = AntApp.useApp()
  const queryClient = useQueryClient()
  const [createOpen, setCreateOpen] = useState(false)
  const [keyword, setKeyword] = useState('')
  const [publishSkill, setPublishSkill] = useState<ReviewSkillListItem | null>(null)
  const [validation, setValidation] = useState<SkillValidationResult | null>(null)
  const [uploadedBundleName, setUploadedBundleName] = useState<string | null>(null)
  const [detailSkill, setDetailSkill] = useState<ReviewSkillListItem | null>(null)
  const [historySkillId, setHistorySkillId] = useState<string | null>(null)
  /** V1.19：正在查看/发起 AI 优化的技能。 */
  const [optimizeSkill, setOptimizeSkill] = useState<ReviewSkillListItem | null>(null)

  const catalogQuery = useQuery({
    queryKey: ['admin-review-skills'],
    enabled: isAdmin,
    queryFn: adminListReviewSkills,
  })
  const detailQuery = useQuery({
    queryKey: ['admin-review-skill', detailSkill?.id],
    enabled: detailSkill !== null,
    queryFn: () => adminGetReviewSkill(detailSkill!.id),
  })
  const historyQuery = useQuery({
    queryKey: ['admin-review-skill', historySkillId],
    enabled: historySkillId !== null,
    queryFn: () => adminGetReviewSkill(historySkillId!),
  })

  /*
   * ---- V1.19 技能 AI 优化 -------------------------------------------------
   *
   * 三个查询、一个 mutation：
   *
   *   evidenceQuery   详情弹窗与优化弹窗共用的证据聚合（只读）
   *   taskQuery       轮询任务状态，终态即停（与 ProfilePage 的 Git 邮箱反查同一模式）
   *   diffQuery       任务成功后才取两侧正文
   *
   * 轮询靠 `refetchInterval` 返回 false 停下，而不是靠一个 `useEffect` 清定时器：
   * 后者在弹窗快速开关时会留下孤儿定时器，表现为"关掉弹窗后还在请求"。
   */
  const evidenceSkillId = optimizeSkill?.id ?? detailSkill?.id ?? null
  const evidenceQuery = useQuery({
    queryKey: ['admin-skill-review-evidence', evidenceSkillId],
    enabled: isAdmin && evidenceSkillId !== null,
    queryFn: () => adminGetSkillReviewEvidence(evidenceSkillId!),
  })

  const taskQuery = useQuery({
    queryKey: ['admin-skill-ai-optimization', optimizeSkill?.id],
    enabled: optimizeSkill !== null,
    queryFn: () => adminGetSkillAiOptimizationTask(optimizeSkill!.id),
    refetchInterval: (query) =>
      isOptimizationInFlight(query.state.data?.status ?? null) ? 2500 : false,
  })
  const task = taskQuery.data ?? null

  const diffQuery = useQuery({
    queryKey: ['admin-skill-optimization-diff', task?.id, task?.result_upload_id],
    enabled: task !== null && task.status === 'SUCCEEDED' && task.result_upload_id !== null,
    queryFn: () => adminGetSkillOptimizationDiff(task!.id),
    retry: false,
  })

  const enqueueOptimizationMutation = useMutation({
    mutationFn: (skillId: string) => adminEnqueueSkillAiOptimization(skillId),
    onSuccess: (created) => {
      // 幂等：已有进行中任务时返回的就是那一条，所以直接写进缓存不会覆盖掉真实状态。
      queryClient.setQueryData(['admin-skill-ai-optimization', created.skill_id], created)
      queryClient.invalidateQueries({
        queryKey: ['admin-skill-ai-optimization', created.skill_id],
      })
    },
    onError: (error: Error) => message.error(error.message),
  })

  const publishOptimizationMutation = useMutation({
    mutationFn: (uploadId: string) =>
      // 与人工上传完全同一条发布路径：upload_id 不同，代码路径相同。
      adminPublishSkillVersion({ uploadId, acknowledgeScripts: true }),
    onSuccess: (result) => {
      message.success(`已发布 ${formatSkillVersion(result.version)}；只影响之后新建的 Job`)
      setOptimizeSkill(null)
      invalidate()
    },
    onError: (error: Error) => message.error(error.message),
  })

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['admin-review-skills'] })
    if (detailSkill !== null) {
      queryClient.invalidateQueries({ queryKey: ['admin-review-skill', detailSkill.id] })
    }
    if (historySkillId !== null) {
      queryClient.invalidateQueries({ queryKey: ['admin-review-skill', historySkillId] })
    }
  }

  const uploadMutation = useMutation({
    mutationFn: (input: { skillId: string; file: File }) =>
      adminUploadSkillBundle(input.skillId, input.file),
    onSuccess: (result, input) => {
      setValidation(result)
      setUploadedBundleName(input.file.name)
      message.success(`校验通过：${result.file_count} 个文件`)
      invalidate()
    },
    onError: (error: Error) => {
      setValidation(null)
      setUploadedBundleName(null)
      // 校验失败的原因已经落库，刷新后仍然可见 —— 这里只是让它立刻出现。
      message.error(error.message)
      invalidate()
    },
  })

  const publishMutation = useMutation({
    mutationFn: () => {
      if (validation === null) throw new Error('请先上传并通过校验')
      // description / whenToUse 不在这里传：它们由服务端从 SKILL.md 的 frontmatter 取。
      return adminPublishSkillVersion({
        uploadId: validation.upload_id,
        acknowledgeScripts: true,
      })
    },
    onSuccess: (result) => {
      message.success(`已更新至 ${formatSkillVersion(result.version)}`)
      setPublishSkill(null)
      setValidation(null)
      setUploadedBundleName(null)
      invalidate()
    },
    onError: (error: Error) => message.error(error.message),
  })

  // 直接发布草稿里已通过校验、待发布的 upload —— 不必重新上传一遍 ZIP。
  // 走的是同一个 publish action，只是 upload_id 来自 latest_upload 而不是本次会话的上传。
  const publishDraftMutation = useMutation({
    mutationFn: (uploadId: string) =>
      adminPublishSkillVersion({ uploadId, acknowledgeScripts: true }),
    onSuccess: (result) => {
      message.success(`已发布 ${formatSkillVersion(result.version)}`)
      invalidate()
    },
    onError: (error: Error) => message.error(error.message),
  })

  const deleteMutation = useMutation({
    mutationFn: (skillId: string) => adminDeleteReviewSkill(skillId),
    onSuccess: (result) => {
      if (result.orphaned_objects > 0) {
        // 库行已经删了，重试删除没有意义（技能已不存在）。孤儿对象只影响容量水位。
        message.warning(
          `已删除 ${result.skill_name}，但有 ${result.orphaned_objects} 个归档对象未能从存储清理，需要运维介入`,
        )
      } else {
        message.success(`已删除 ${result.skill_name}`)
      }
      invalidate()
    },
    onError: (error: Error) => message.error(error.message),
  })

  const enabledMutation = useMutation({    mutationFn: (input: { skillId: string; enabled: boolean }) =>
      adminSetReviewSkillEnabled(input.skillId, input.enabled),
    onSuccess: () => {
      message.success('技能状态已更新；只影响之后新建的 Job')
      invalidate()
    },
    onError: (error: Error) => message.error(error.message),
  })

  const downloadMutation = useMutation({
    mutationFn: (versionId: string) => adminCreateSkillDownloadUrl(versionId),
    onSuccess: (result) => {
      // 短期凭据：用浏览器可访问的 Supabase origin 补全后立即使用，不保存、不展示。
      window.open(getSkillBundleDownloadUrl(result.signed_path), '_blank', 'noopener,noreferrer')
    },
    onError: (error: Error) => message.error(error.message),
  })

  const skills = useMemo(() => catalogQuery.data?.skills ?? [], [catalogQuery.data])
  const filteredSkills = useMemo(() => {
    const kw = keyword.trim().toLowerCase()
    if (kw.length === 0) return skills
    return skills.filter(
      (skill) =>
        skill.name.toLowerCase().includes(kw) ||
        skill.display_name.toLowerCase().includes(kw),
    )
  }, [skills, keyword])

  if (!isAdmin) {
    return <Alert type="warning" showIcon message="仅管理员可以维护技能" />
  }

  const handleSkillRowAction = (key: string, row: ReviewSkillListItem) => {
    if (key === 'download' && row.current_version_id !== null) {
      downloadMutation.mutate(row.current_version_id)
      return
    }
    if (key === 'enable') {
      enabledMutation.mutate({ skillId: row.id, enabled: true })
      return
    }
    if (key === 'disable') {
      modal.confirm({
        title: `停用 ${row.name}？`,
        content: '停用只影响之后新建的 Job；已在运行的 Job 继续使用它冻结的版本。',
        onOk: () => enabledMutation.mutateAsync({ skillId: row.id, enabled: false }),
      })
      return
    }
    if (key === 'delete') {
      modal.confirm({
        title: `删除 ${row.name}？`,
        content:
          row.version_count > 0
            ? `将连同 ${row.version_count} 个已发布版本与其归档一起永久删除，不可恢复。` +
              '技能名会被释放，之后可以重新创建同名技能。'
            : '这是一个还没有任何版本的草稿，删除后技能名会被释放。',
        okText: '删除',
        okButtonProps: { danger: true },
        onOk: () => deleteMutation.mutateAsync(row.id),
      })
    }
  }

  const columns = [
    {
      title: '技能名称',
      dataIndex: 'name',
      width: 220,
      /*
       * 技能名是模型侧的唯一标识（`skill(name)` 就是按它调用），所以必须完整可读。
       * 早先没给宽度，被右边 8 个列挤成两行、code 背景断成两截，反而最难认。
       * 这里给固定宽度 + 不换行 + 溢出时 Tooltip 显示全名。
       */
      render: (name: string, row: ReviewSkillListItem) => (
        <Tooltip title="点击查看技能详情">
          <Button type="link" className="skill-name-link" onClick={() => setDetailSkill(row)}>
            <Text code className="skill-name-code">
              {name}
            </Text>
          </Button>
        </Tooltip>
      ),
    },
    { title: '显示名称', dataIndex: 'display_name', width: 180, ellipsis: true },
    {
      title: '状态',
      dataIndex: 'status',
      width: 96,
      filters: Object.entries(STATUS_LABELS).map(([value, meta]) => ({
        text: meta.text,
        value,
      })),
      onFilter: (value: string | number | bigint | boolean, row: ReviewSkillListItem) =>
        row.status === value,
      render: (status: ReviewSkillStatus) => (
        <Tag color={STATUS_LABELS[status].color}>{STATUS_LABELS[status].text}</Tag>
      ),
    },
    {
      title: '当前版本',
      dataIndex: 'current_version',
      width: 96,
      align: 'center' as const,
      render: (version: number | null) => (version === null ? '—' : formatSkillVersion(version)),
    },
    {
      title: '文件数',
      dataIndex: 'file_count',
      width: 88,
      align: 'center' as const,
      render: (v: number | null) => v ?? '—',
    },
    {
      title: '文件大小',
      key: 'size',
      width: 120,
      render: (_unused: unknown, row: ReviewSkillListItem) => (
        <Tooltip
          title={
            <Space direction="vertical" size={0}>
              <span>压缩包大小：{formatBytes(row.archive_size_bytes)}</span>
              <span>解压后大小：{formatBytes(row.expanded_size_bytes)}</span>
            </Space>
          }
        >
          <Text>{formatBytes(row.archive_size_bytes)}</Text>
        </Tooltip>
      ),
    },
    {
      title: '更新人 / 时间',
      key: 'audit',
      width: 180,
      render: (_unused: unknown, row: ReviewSkillListItem) => (
        <Space direction="vertical" size={0}>
          <Text>{row.published_by_name ?? '—'}</Text>
          <Text type="secondary" className="skill-size-secondary">
            {row.published_at === null ? '—' : new Date(row.published_at).toLocaleString()}
          </Text>
        </Space>
      ),
    },
    {
      title: '操作',
      key: 'actions',
      width: 360,
      // 固定在右侧：这张表有 10 列、横向要滚，操作跟着滚出屏幕就得来回拖。
      fixed: 'right' as const,
      render: (_unused: unknown, row: ReviewSkillListItem) => (
        <Space size={4}>
          {row.status === 'DRAFT' &&
          row.latest_upload !== null &&
          row.latest_upload.status === 'VALIDATED' ? (
            <Button
              size="small"
              type="link"
              className="table-action-link"
              loading={publishDraftMutation.isPending}
              onClick={() => {
                const upload = row.latest_upload
                if (upload === null) return
                modal.confirm({
                  title: `发布 ${row.name}？`,
                  content: upload.contains_scripts
                    ? '该技能包已通过校验，将发布为可用版本。注意：它包含 scripts/ 脚本文件，' +
                      '拥有 bash 的 Agent 可以显式运行这些脚本。确认发布？'
                    : '该技能包已通过校验，将发布为可用版本。发布后不可替换 ZIP，只能创建下一版本。',
                  okText: '发布',
                  onOk: () => publishDraftMutation.mutateAsync(upload.id),
                })
              }}
            >
              发布
            </Button>
          ) : null}
          <Button
            size="small"
            type="link"
            className="table-action-link"
            onClick={() => {
              setPublishSkill(row)
              setValidation(null)
              setUploadedBundleName(null)
            }}
          >
            更新版本
          </Button>
          <Button
            size="small"
            type="link"
            className="table-action-link"
            onClick={() => setHistorySkillId(row.id)}
          >
            版本历史
          </Button>
          {/*
            AI 优化只对「有已发布版本」的技能开放：优化的输入是当前已发布版本的正文 +
            它的历史评审结果，两者都需要这个技能真的上过线。是否有证据由弹窗里的证据区块
            如实说明，而不是在这里悄悄隐藏按钮 —— 隐藏会让管理员以为功能没上线。
          */}
          {row.current_version_id !== null ? (
            <Button
              size="small"
              type="link"
              className="table-action-link"
              onClick={() => setOptimizeSkill(row)}
            >
              AI 优化
            </Button>
          ) : null}
          {row.current_version_id !== null ? (
            <Button
              size="small"
              type="link"
              className="table-action-link"
              onClick={() => handleSkillRowAction('download', row)}
            >
              下载当前版本
            </Button>
          ) : null}
          {row.current_version_id !== null ? (
            <Button
              size="small"
              type="link"
              className="table-action-link"
              onClick={() => handleSkillRowAction(row.status === 'PUBLISHED' ? 'disable' : 'enable', row)}
            >
              {row.status === 'PUBLISHED' ? '停用' : '启用'}
            </Button>
          ) : null}
          <Tooltip
            title={
              row.referenced_by_job
                ? '这个技能已被至少一个 Analysis Job 冻结，不能删除。' +
                  'Job 的技能快照是「那次评审到底给了模型哪些技能」的唯一证据，' +
                  '删掉源技能等于让历史评审结果失去依据。改用「停用」：它只影响之后新建的 Job。'
                : undefined
            }
          >
            <span>
              <Button
                danger
                disabled={row.referenced_by_job}
                size="small"
                type="link"
                className="table-action-link"
                onClick={() => handleSkillRowAction('delete', row)}
              >
                删除
              </Button>
            </span>
          </Tooltip>
        </Space>
      ),
    },
  ]

  return (
    <Space direction="vertical" size="large" className="full-width">
      {/* 无外壳列表布局：标题、工具栏与表格直接落在页面内容区，避免再套一层卡片。 */}
      <section className="full-width" aria-label="技能列表">
        <Space direction="vertical" size="middle" className="full-width">
          <SidebarPageTitle title="技能" />
          <div className="skill-filter-bar">
            <Button type="primary" onClick={() => setCreateOpen(true)}>
              新增技能
            </Button>
            <Input.Search
              allowClear
              placeholder="搜索技能名称或显示名称"
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
              style={{ width: 260 }}
            />
            {/* 条数只在分页处显示一次：筛选栏右侧原来还有一个「共 N 条」，同一个数字
                在同一屏出现两遍，看的人会先怀疑两者是不是不同口径。 */}
          </div>

          <Table<ReviewSkillListItem>
            dataSource={filteredSkills}
            rowKey="id"
            size="middle"
            loading={catalogQuery.isLoading}
            columns={columns}
            // 固定列宽之和为 1340；隐藏不常用的脚本与描述列后，保留少量余量避免窄屏挤压。
            scroll={{ x: 1360 }}
            pagination={{
              pageSize: 10,
              showSizeChanger: true,
              pageSizeOptions: [10, 20, 50, 100],
              showTotal: (total) => `共 ${total} 条`,
            }}
            locale={{ emptyText: <Empty description="还没有技能。新增一个并上传 Bundle ZIP。" /> }}
          />
        </Space>
      </section>

      <SkillCreateWizard
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        onDone={() => {
          setCreateOpen(false)
          invalidate()
        }}
        onDraftChanged={invalidate}
      />

      <Modal
        title={detailSkill === null ? '技能详情' : `技能详情：${detailSkill.name}`}
        open={detailSkill !== null}
        width={960}
        className="skill-detail-modal"
        centered
        style={SKILL_MODAL_STYLE}
        styles={SKILL_MODAL_STYLES}
        footer={null}
        onCancel={() => setDetailSkill(null)}
        destroyOnHidden
      >
        {detailQuery.isLoading ? (
          <Text type="secondary">加载中…</Text>
        ) : detailSkill === null ? null : (
          <div style={SKILL_DETAIL_BODY_STYLE}>
            {/* 顶部信息区固定：技能元信息 + 待发布/当前版本状态。切换文件列表页码时它不参与滚动、不移动。 */}
            <div style={SKILL_DETAIL_HEADER_STYLE}>
              <Descriptions size="small" column={3} bordered>
                <Descriptions.Item label="技能编码">
                  <Text code>{detailSkill.name}</Text>
                </Descriptions.Item>
                <Descriptions.Item label="显示名称">{detailSkill.display_name}</Descriptions.Item>
                <Descriptions.Item label="状态">
                  <Tag color={STATUS_LABELS[detailSkill.status].color}>
                    {STATUS_LABELS[detailSkill.status].text}
                  </Tag>
                </Descriptions.Item>
                <Descriptions.Item label="当前版本">
                  {detailSkill.current_version === null ? '—' : formatSkillVersion(detailSkill.current_version)}
                </Descriptions.Item>
                <Descriptions.Item label="文件数">{detailSkill.file_count ?? '—'}</Descriptions.Item>
                <Descriptions.Item label="文件大小">
                  {formatBytes(detailSkill.archive_size_bytes)}
                </Descriptions.Item>
              </Descriptions>

              {detailSkill.latest_upload !== null ? (
                <>
                  <Text strong>待发布的技能包</Text>
                  <Descriptions size="small" column={3} bordered>
                    <Descriptions.Item label="状态">{detailSkill.latest_upload.status}</Descriptions.Item>
                    <Descriptions.Item label="文件数">
                      {detailSkill.latest_upload.file_count ?? '—'}
                    </Descriptions.Item>
                    <Descriptions.Item label="文件大小">
                      {formatBytes(detailSkill.latest_upload.archive_size_bytes)}
                    </Descriptions.Item>
                  </Descriptions>
                  {detailSkill.latest_upload.error_code !== null ? (
                    <Alert
                      type="error"
                      showIcon
                      message="校验未通过"
                      description={detailSkill.latest_upload.error_message}
                    />
                  ) : null}
                </>
              ) : detailQuery.data?.versions[0] !== undefined ? (
                <>
                  <Text strong>当前版本文件</Text>
                  <Descriptions size="small" column={3} bordered>
                    <Descriptions.Item label="版本">
                      {formatSkillVersion(detailQuery.data.versions[0].version)}
                    </Descriptions.Item>
                    <Descriptions.Item label="文件数">
                      {detailQuery.data.versions[0].file_count}
                    </Descriptions.Item>
                    <Descriptions.Item label="文件大小">
                      {formatBytes(detailQuery.data.versions[0].archive_size_bytes)}
                    </Descriptions.Item>
                  </Descriptions>
                </>
              ) : null}

              {/*
                V1.19 历史评审证据。放在详情弹窗里而不是单开一页：管理员判断"这个技能该不该
                改"的时候看的就是这一屏，把证据和版本信息拆到两个地方等于让他自己去关联。
              */}
              <Text strong>历史评审证据</Text>
              <SkillReviewEvidenceBlock
                evidence={evidenceQuery.data ?? null}
                loading={evidenceQuery.isLoading}
              />
              {canOptimizeFromEvidence(evidenceQuery.data ?? null) ? (
                <Button
                  type="primary"
                  onClick={() => {
                    setOptimizeSkill(detailSkill)
                    setDetailSkill(null)
                  }}
                >
                  用这些证据做 AI 优化
                </Button>
              ) : null}
            </div>

            {/* 文件列表区独立滚动：只有它随页码切换，顶部信息区保持不动。 */}
            <div style={SKILL_DETAIL_SCROLL_STYLE}>
              {detailSkill.latest_upload !== null ? (
                detailSkill.latest_upload.bundle_manifest !== null ? (
                  <BundleFileTree files={detailSkill.latest_upload.bundle_manifest.files} />
                ) : null
              ) : detailQuery.data?.versions[0] !== undefined ? (
                <BundleFileTree files={detailQuery.data.versions[0].bundle_manifest.files} />
              ) : (
                <Empty description="暂未上传技能包" />
              )}
            </div>
          </div>
        )}
      </Modal>

      <Modal
        title={
          publishSkill === null ? (
            '更新版本'
          ) : (
            <div className="skill-create-modal__title">
              <span>更新版本：{publishSkill.display_name}</span>
              <Text type="secondary">
                当前 {publishSkill.current_version === null ? '暂无已发布版本' : formatSkillVersion(publishSkill.current_version)}
                {' → '}提交后 {formatSkillVersion((publishSkill.current_version ?? 0) + 1)}
              </Text>
            </div>
          )
        }
        open={publishSkill !== null}
        width={960}
        className="skill-publish-modal"
        centered
        style={SKILL_MODAL_STYLE}
        styles={SKILL_MODAL_STYLES}
        onCancel={() => {
          setPublishSkill(null)
          setValidation(null)
          setUploadedBundleName(null)
        }}
        onOk={() => publishMutation.mutate()}
        okText="发布更新"
        okButtonProps={{ disabled: validation === null }}
        confirmLoading={publishMutation.isPending}
        destroyOnHidden
      >
        {publishSkill === null ? null : (
          <Space direction="vertical" size="middle" className="full-width">
            <Steps
              className="skill-create-modal__steps"
              current={validation === null ? 0 : 1}
              size="small"
              items={[{ title: '基本信息' }, { title: '内容检测' }, { title: '发布更新' }]}
            />

            <Alert
              type="info"
              showIcon
              message="以新 ZIP 中 SKILL.md 的 frontmatter 为准"
              description="技能编码不可修改；描述和使用场景会在服务端校验后从新版本技能包中重新解析。"
            />

            <div className="skill-update-modal__upload-section">
              <Text strong>上传更新包</Text>
              <Upload.Dragger
                className={`skill-upload-dragger${validation !== null || publishSkill.current_version_id !== null ? ' skill-upload-dragger--imported' : ''}`}
                accept=".zip"
                maxCount={1}
                multiple={false}
                fileList={[] as UploadFile[]}
                beforeUpload={(file) => {
                  setValidation(null)
                  setUploadedBundleName(null)
                  uploadMutation.reset()
                  uploadMutation.mutate({ skillId: publishSkill.id, file: file as unknown as File })
                  // 交给受控 signed-upload 链路，不让 antd 直接发请求。
                  return false
                }}
                disabled={uploadMutation.isPending}
              >
                {validation === null ? (
                  publishSkill.current_version_id === null ? (
                    <>
                      <p className="ant-upload-drag-icon" aria-hidden="true">⬆</p>
                      <p className="skill-upload-dragger__title">点击或拖拽上传 ZIP 更新包</p>
                      <p className="ant-upload-hint skill-upload-dragger__hint">
                        根目录需直接包含 <Text code>SKILL.md</Text>
                      </p>
                    </>
                  ) : (
                    <>
                      <span className="skill-upload-dragger__status-icon" aria-hidden="true">
                        ✓
                      </span>
                      <p className="skill-upload-dragger__title">当前已发布 ZIP</p>
                      <p className="skill-upload-dragger__file-name">
                        {formatSkillVersion(publishSkill.current_version ?? 1)} · {publishSkill.file_count ?? '—'} 个文件 ·{' '}
                        {formatBytes(publishSkill.archive_size_bytes)}
                      </p>
                      <p className="skill-upload-dragger__hint">点击或拖拽新的 ZIP 更新包以替换</p>
                    </>
                  )
                ) : (
                  <>
                    <span className="skill-upload-dragger__status-icon" aria-hidden="true">
                      ✓
                    </span>
                    <p className="skill-upload-dragger__title">待发布更新包已通过校验</p>
                    <p className="skill-upload-dragger__file-name" title={uploadedBundleName ?? undefined}>
                      {uploadedBundleName ?? 'ZIP 技能包'}
                    </p>
                    <p className="skill-upload-dragger__hint">
                      {validation.file_count} 个文件 · 点击或拖拽 ZIP 以替换
                    </p>
                  </>
                )}
              </Upload.Dragger>
            </div>

            <Descriptions title="当前技能信息" size="small" column={2} bordered>
              <Descriptions.Item label="技能编码">
                <Text code>{publishSkill.name}</Text>
              </Descriptions.Item>
              <Descriptions.Item label="显示名称">{publishSkill.display_name}</Descriptions.Item>
              <Descriptions.Item label="当前版本">
                {publishSkill.current_version === null ? '暂无已发布版本' : formatSkillVersion(publishSkill.current_version)}
              </Descriptions.Item>
              <Descriptions.Item label="即将发布">
                {formatSkillVersion((publishSkill.current_version ?? 0) + 1)}
              </Descriptions.Item>
              <Descriptions.Item label="当前文件数">{publishSkill.file_count ?? '—'}</Descriptions.Item>
              <Descriptions.Item label="当前 ZIP 大小">
                {formatBytes(publishSkill.archive_size_bytes)}
              </Descriptions.Item>
              <Descriptions.Item label="技能描述" span={2}>
                {publishSkill.description ?? <Text type="secondary">当前版本未提供描述</Text>}
              </Descriptions.Item>
              <Descriptions.Item label="使用场景" span={2}>
                {publishSkill.when_to_use ?? <Text type="secondary">未提供</Text>}
              </Descriptions.Item>
            </Descriptions>

            {uploadMutation.isPending ? <Progress percent={100} status="active" showInfo={false} /> : null}

            {uploadMutation.isError ? (
              <Alert type="error" showIcon message="校验未通过" description={uploadMutation.error.message} />
            ) : null}

            {validation !== null ? (
            <>
              <Descriptions size="small" column={3} bordered>
                <Descriptions.Item label="文件数">{validation.file_count}</Descriptions.Item>
                <Descriptions.Item label="ZIP 大小">
                  {formatBytes(validation.archive_size_bytes)}
                </Descriptions.Item>
                <Descriptions.Item label="展开大小">
                  {formatBytes(validation.expanded_size_bytes)}
                </Descriptions.Item>
                <Descriptions.Item label="archive SHA-256" span={3}>
                  <Text code>{validation.archive_sha256}</Text>
                </Descriptions.Item>
                <Descriptions.Item label="bundle hash" span={3}>
                  <Text code>{validation.bundle_hash}</Text>
                </Descriptions.Item>
              </Descriptions>

              {validation.tree.some((file) => file.role === 'ASSET') ? (
                <Alert
                  type="info"
                  showIcon
                  message="此版本包含图片资源"
                  description={
                    <>
                      模型用 <Text code>read_image</Text> 读图片，而它的准入检查看的是**模型路由
                      声明的输入模态**。只有部署侧打开 <Text code>MODEL_IMAGE_INPUT_ENABLED</Text>
                      （且模型端点确实接受图片）时，这些图片才对模型可见；否则它们仍会被完整
                      冻结与物化，只是模型读不到。详见 worker/OPERATIONS.md 第 17.9 节。
                    </>
                  }
                />
              ) : null}

              <BundleFileTree files={validation.tree} />
            </>
          ) : null}

          {validation !== null ? (
            <Descriptions
              size="small"
              column={1}
              bordered
              title="来自 SKILL.md frontmatter（唯一来源，不在这里编辑）"
            >
              <Descriptions.Item label="name">
                <Text code>{validation.frontmatter.name}</Text>
              </Descriptions.Item>
              <Descriptions.Item label="description（进入首轮目录，模型据此决定是否加载）">
                {validation.frontmatter.description}
              </Descriptions.Item>
              <Descriptions.Item label="whenToUse">
                {validation.frontmatter.whenToUse ?? <Text type="secondary">未提供</Text>}
              </Descriptions.Item>
            </Descriptions>
          ) : null}

          </Space>
        )}
      </Modal>

      {/*
        V1.19 AI 优化弹窗。
        流程固定三段：排队中 → AI 生成中 → 等待确认。最后一段必须由管理员看完 diff 再点
        「确认发布」—— 平台里没有任何一条让 AI 自己发布的路径。
      */}
      <Modal
        title={
          optimizeSkill === null ? 'AI 优化技能' : `AI 优化：${optimizeSkill.display_name}`
        }
        open={optimizeSkill !== null}
        width={960}
        centered
        style={SKILL_MODAL_STYLE}
        styles={SKILL_MODAL_STYLES}
        onCancel={() => setOptimizeSkill(null)}
        footer={
          task !== null && task.status === 'SUCCEEDED' && task.result_upload_id !== null ? (
            <Space>
              <Button onClick={() => setOptimizeSkill(null)}>放弃此次优化</Button>
              <Button
                type="primary"
                loading={publishOptimizationMutation.isPending}
                disabled={diffQuery.data === undefined}
                onClick={() => {
                  const uploadId = task.result_upload_id
                  if (uploadId === null) return
                  modal.confirm({
                    title: `发布 ${optimizeSkill?.name ?? ''} 的 AI 优化结果？`,
                    content:
                      diffQuery.data?.contains_scripts === true
                        ? '这份内容已经通过与人工上传完全相同的服务端校验，但它包含 scripts/ 下的' +
                          '可执行资源 —— 拥有 bash 的 Agent 可以显式运行它们。确认你已经看过这些脚本' +
                          '的完整内容？发布后不可替换，只能再发一个新版本。'
                        : '这份内容已经通过与人工上传完全相同的服务端校验。发布后不可替换，' +
                          '只能再发一个新版本；发布只影响之后新建的 Job，不影响历史或在途 Job。',
                    okText: '确认发布',
                    okButtonProps:
                      diffQuery.data?.contains_scripts === true ? { danger: true } : undefined,
                    onOk: () => publishOptimizationMutation.mutateAsync(uploadId),
                  })
                }}
              >
                确认发布
              </Button>
            </Space>
          ) : (
            <Button onClick={() => setOptimizeSkill(null)}>关闭</Button>
          )
        }
        destroyOnHidden
      >
        {optimizeSkill === null ? null : (
          <Space direction="vertical" size="middle" className="full-width">
            <Steps
              size="small"
              current={optimizationStepIndex(task?.status ?? null)}
              status={task?.status === 'FAILED' ? 'error' : undefined}
              items={[{ title: '排队中' }, { title: 'AI 生成中' }, { title: '等待确认' }]}
            />

            <Text strong>历史评审证据</Text>
            <SkillReviewEvidenceBlock
              evidence={evidenceQuery.data ?? null}
              loading={evidenceQuery.isLoading}
            />

            {task === null || task.status === 'FAILED' ? (
              <Space direction="vertical" size="small" className="full-width">
                {task?.status === 'FAILED' ? (
                  <Alert
                    /*
                     * 「AI 判断不需要改」是一次正常的终态，不是故障：用 warning 而不是 error，
                     * 否则管理员会去排查一个不存在的问题。
                     */
                    type={
                      task.error_code === 'SKILL_OPTIMIZATION_NO_CHANGE_NEEDED'
                        ? 'warning'
                        : 'error'
                    }
                    showIcon
                    message={
                      task.error_code === 'SKILL_OPTIMIZATION_NO_CHANGE_NEEDED'
                        ? '上次优化没有产出草稿：AI 判断当前证据不足以支撑修改'
                        : `上次优化失败（${task.error_code ?? '未知错误码'}）`
                    }
                    description={describeOptimizationError(task.error_code, task.error_message)}
                  />
                ) : null}
                <Button
                  type="primary"
                  loading={enqueueOptimizationMutation.isPending}
                  disabled={!canOptimizeFromEvidence(evidenceQuery.data ?? null)}
                  onClick={() => enqueueOptimizationMutation.mutate(optimizeSkill.id)}
                >
                  {task?.status === 'FAILED' ? '重新发起 AI 优化' : '开始 AI 优化'}
                </Button>
              </Space>
            ) : null}

            {isOptimizationInFlight(task?.status ?? null) ? (
              <Space direction="vertical" size="small" className="full-width">
                <Progress percent={task?.status === 'RUNNING' ? 70 : 20} status="active" showInfo={false} />
                <Text type="secondary">
                  {task?.status === 'QUEUED'
                    ? '已排队，等待一个在线的 Worker 认领。如果长时间停在这一步，请确认至少有一个 Worker 在运行。'
                    : 'AI 正在读取当前技能包与评审证据并改写内容。改完会先做一次结构检查，不通过时 AI 会自己重写（最多 3 次），所以这一步可能需要一到几分钟。'}
                </Text>
              </Space>
            ) : null}

            {task !== null && task.status === 'SUCCEEDED' ? (
              <Space direction="vertical" size="middle" className="full-width">
                {diffQuery.data?.contains_scripts === true ? (
                  <Alert
                    type="warning"
                    showIcon
                    message="这份草稿包含 scripts/ 下的可执行资源"
                    description="拥有 bash 的 Agent 可以显式运行这些脚本。请在 diff 里逐行看完脚本内容再决定是否发布。"
                  />
                ) : null}
                <Descriptions size="small" column={2} bordered title="AI 优化结果">
                  <Descriptions.Item label="改动文件">
                    {task.changed_paths.length === 0
                      ? '—'
                      : task.changed_paths.map((path) => (
                          <Tag key={path}>
                            <Text code>{path}</Text>
                          </Tag>
                        ))}
                  </Descriptions.Item>
                  <Descriptions.Item label="结构检查">
                    {task.model_attempts <= 1
                      ? '一次通过'
                      : `AI 自检不通过后重写了 ${task.model_attempts - 1} 次，最终通过`}
                  </Descriptions.Item>
                  <Descriptions.Item label="完成时间">
                    {task.finished_at === null ? '—' : new Date(task.finished_at).toLocaleString()}
                  </Descriptions.Item>
                  <Descriptions.Item label="发布后文件数">
                    {diffQuery.data?.file_count ?? '—'}
                  </Descriptions.Item>
                  <Descriptions.Item label="AI 修改理由" span={2}>
                    {task.ai_summary ?? <Text type="secondary">模型没有给出说明</Text>}
                  </Descriptions.Item>
                </Descriptions>

                {diffQuery.isLoading ? (
                  <Text type="secondary">正在取两侧正文以渲染 diff…</Text>
                ) : diffQuery.isError ? (
                  <Alert
                    type="error"
                    showIcon
                    message="无法渲染 diff"
                    description={(diffQuery.error as Error).message}
                  />
                ) : diffQuery.data === undefined ? null : (
                  diffQuery.data.files.map((file) => (
                    <SkillFileDiffView key={file.path} file={file} />
                  ))
                )}
              </Space>
            ) : null}
          </Space>
        )}
      </Modal>

      <Modal
        title="版本历史"
        open={historySkillId !== null}
        width={960}
        className="skill-history-modal"
        centered
        style={SKILL_MODAL_STYLE}
        styles={SKILL_MODAL_STYLES}
        footer={null}
        onCancel={() => setHistorySkillId(null)}
        destroyOnHidden
      >
        {historyQuery.isLoading ? (
          <Text type="secondary">加载中…</Text>
        ) : (
          <Table<ReviewSkillVersionDetail>
            className="skill-history-table"
            dataSource={historyQuery.data?.versions ?? []}
            rowKey="id"
            size="small"
            pagination={{
              size: 'small',
              defaultPageSize: 10,
              showSizeChanger: true,
              pageSizeOptions: [10, 20, 50, 100],
              showTotal: (total, range) => `第 ${range[0]}-${range[1]} 条 / 共 ${total} 个版本`,
            }}
            tableLayout="fixed"
            columns={[
              { title: '版本', dataIndex: 'version', width: 80, render: (v: number) => formatSkillVersion(v) },
              { title: '描述', dataIndex: 'description', width: 160, ellipsis: true },
              {
                title: '文件数',
                dataIndex: 'file_count',
                width: 72,
              },
              {
                title: '文件大小',
                key: 'size',
                width: 96,
                render: (_unused: unknown, row: ReviewSkillVersionDetail) => (
                  <Tooltip
                    title={
                      <Space direction="vertical" size={0}>
                        <span>压缩包大小：{formatBytes(row.archive_size_bytes)}</span>
                        <span>解压后大小：{formatBytes(row.expanded_size_bytes)}</span>
                      </Space>
                    }
                  >
                    <Text>{formatBytes(row.archive_size_bytes)}</Text>
                  </Tooltip>
                ),
              },
              {
                title: '脚本',
                dataIndex: 'contains_scripts',
                width: 64,
                render: (value: boolean) => (value ? <Tag color="red">含</Tag> : <Tag>无</Tag>),
              },
              {
                title: 'bundle hash',
                dataIndex: 'bundle_hash',
                width: 120,
                render: (value: string) => (
                  <Tooltip title={value}>
                    <Text code>{value.replace('sha256:', '').slice(0, 12)}…</Text>
                  </Tooltip>
                ),
              },
              {
                title: '发布时间',
                dataIndex: 'published_at',
                width: 148,
                ellipsis: true,
                render: (value: string) => new Date(value).toLocaleString(),
              },
              {
                title: '操作',
                key: 'actions',
                width: 72,
                render: (_unused: unknown, row: ReviewSkillVersionDetail) => (
                  <Button
                    size="small"
                    loading={downloadMutation.isPending}
                    onClick={() => downloadMutation.mutate(row.id)}
                  >
                    下载
                  </Button>
                ),
              },
            ]}
          />
        )}
      </Modal>
    </Space>
  )
}
