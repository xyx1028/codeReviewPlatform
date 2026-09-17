import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Col,
  Divider,
  Empty,
  Form,
  Input,
  InputNumber,
  Layout,
  List,
  Menu,
  Modal,
  Progress,
  Radio,
  Row,
  Select,
  Space,
  Spin,
  Statistic,
  Steps,
  Switch,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
  Upload,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { Link, Navigate, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  adminListUsers,
  adminUpdateUserRole,
  adminCreateModelConfig,
  adminDeleteModelConfig,
  adminListModelConfigs,
  adminSetModelEnabled,
  enqueueModelConnectivityTest,
  getModelConnectivityTest,
  adminUpdateModelConfig,
  AuthActionError,
  claimInitialAdmin,
  completeBatch,
  consumeWechatAuthError,
  confirmAiResultImport,
  confirmSourceImport,
  createBatch,
  deleteBatch,
  enqueueAnalysisJob,
  getBatch,
  findImportFileByHash,
  getBatchWorkspace,
  getFileDownloadUrl,
  getLatestAnalysisJob,
  getMyProfile,
  getSession,
  listAiImports,
  listAnalysisStoryTasks,
  listBatches,
  listEnabledModelConfigs,
  listImportFiles,
  listModelDisplayNames,
  listOperationLogs,
  listRepositorySnapshots,
  listStories,
  onAuthChange,
  reopenBatch,
  retryAnalysisJob,
  saveHumanReview,
  setBatchDefaultBranch,
  setBatchModel,
  resendSignUpEmail,
  signIn,
  signOut,
  signUp,
  startWechatSignIn,
  uploadBatchFile,
  wechatLoginEnabled,
} from './lib/api'
import type { CreateBatchInput, ModelConfigInput } from './lib/api'
import { downloadAiTemplate, inferFieldMapping, parseAiWorkbook, parseSourceRows, readFirstSheet, sourceFieldLabels, templateVersion } from './lib/excel'
import type { FieldMapping, SourceFieldKey } from './lib/excel'
import { parseBaselineCommit } from './lib/baseline'
import { hashFile } from './lib/hash'
import { aiVerdictLabels, aiVerdictOptions, analysisJobStatusLabels, batchStatusLabels, humanReviewLabels, humanReviewOptions, resolveAnalysisError, storyTaskStatusLabels } from './lib/labels'
import { aiFillPrompt } from './lib/prompt'
import { WorkerManagementPage } from './pages/WorkerManagementPage'
import { RuntimeMonitoringPage } from './pages/RuntimeMonitoringPage'
import { AgentRunDetailPage } from './pages/AgentRunDetailPage'
import { HarnessPolicyPage } from './pages/HarnessPolicyPage'
import { SkillManagementPage } from './pages/SkillManagementPage'
import { ProfilePage } from './pages/ProfilePage'
import { supabaseConfigured } from './lib/supabase'
import type {
  AdminUserListItem,
  AiImportRecord,
  AiModelConfigSummary,
  ModelConnectivityTest,
  ModelNetworkAccessMode,
  AiReviewResult,
  AiVerdict,
  AnalysisJob,
  AnalysisRepositorySnapshot,
  AnalysisStoryTaskWithStory,
  BaselineCommit,
  BatchOperationLogWithBatch,
  BatchStatus,
  BatchWorkspace,
  DefaultBranch,
  HumanReviewResult,
  ReviewBatch,
  ReviewBatchListItem,
  ReviewStory,
  SourceStoryInput,
  UserRole,
  ValidationIssue,
} from './types'
import './App.css'

const { Header, Content, Sider } = Layout
const { Title, Text, Paragraph } = Typography

type AiResultMode = 'auto' | 'manual'

const defaultBranchOptions: { value: DefaultBranch; label: DefaultBranch }[] = [
  { value: 'feature_dev', label: 'feature_dev' },
  { value: 'feature_sit', label: 'feature_sit' },
  { value: 'release', label: 'release' },
]

function isSupportedDefaultBranch(branch: string | null): branch is DefaultBranch {
  return branch === 'feature_dev' || branch === 'feature_sit' || branch === 'release'
}

// 发布周期：年/月/日三个下拉拼接为 YYYYMMDD（例如 20260918）
type WeekCodeParts = { year?: number; month?: number; day?: number }

type CreateBatchFormValues = Omit<CreateBatchInput, 'week_code'> & { week_code_parts?: WeekCodeParts }

const WEEK_CODE_YEAR_BACK = 2
const WEEK_CODE_YEAR_FORWARD = 3

function pad2(value: number) {
  return String(value).padStart(2, '0')
}

function daysInMonth(year: number, month: number) {
  return new Date(year, month, 0).getDate()
}

function buildWeekCode(parts: WeekCodeParts) {
  const { year, month, day } = parts
  if (!year || !month || !day) return undefined
  return `${year}${pad2(month)}${pad2(day)}`
}

// 发布周期默认值：当天。每次打开弹窗时重新计算，避免页面长时间不刷新导致跨天后仍是旧日期。
function getTodayWeekCodeParts(): WeekCodeParts {
  const today = new Date()
  return { year: today.getFullYear(), month: today.getMonth() + 1, day: today.getDate() }
}

function WeekCodeSelect({
  value,
  onChange,
  disabled,
}: {
  value?: WeekCodeParts
  onChange?: (next: WeekCodeParts) => void
  disabled?: boolean
}) {
  const parts = value ?? {}

  const yearOptions = useMemo(() => {
    const currentYear = new Date().getFullYear()
    const years: number[] = []
    for (let year = currentYear - WEEK_CODE_YEAR_BACK; year <= currentYear + WEEK_CODE_YEAR_FORWARD; year += 1) {
      years.push(year)
    }
    return years.map((year) => ({ value: year, label: `${year} 年` }))
  }, [])

  const monthOptions = useMemo(
    () => Array.from({ length: 12 }, (_item, index) => ({ value: index + 1, label: `${index + 1} 月` })),
    [],
  )

  const dayOptions = useMemo(() => {
    const total = parts.year && parts.month ? daysInMonth(parts.year, parts.month) : 31
    return Array.from({ length: total }, (_item, index) => ({ value: index + 1, label: `${index + 1} 日` }))
  }, [parts.year, parts.month])

  const update = (next: WeekCodeParts) => {
    // 切换年月后如果原来的日期不存在（例如 2 月 30 日），清空日选择。
    const maxDay = next.year && next.month ? daysInMonth(next.year, next.month) : 31
    const normalized: WeekCodeParts = next.day && next.day > maxDay ? { ...next, day: undefined } : next
    onChange?.(normalized)
  }

  return (
    <Space.Compact block>
      <Select
        placeholder="年"
        className="week-code-select-year"
        disabled={disabled}
        value={parts.year}
        options={yearOptions}
        onChange={(year: number) => update({ ...parts, year })}
      />
      <Select
        placeholder="月"
        className="week-code-select-part"
        disabled={disabled}
        value={parts.month}
        options={monthOptions}
        onChange={(month: number) => update({ ...parts, month })}
      />
      <Select
        placeholder="日"
        className="week-code-select-part"
        disabled={disabled}
        value={parts.day}
        options={dayOptions}
        onChange={(day: number) => update({ ...parts, day })}
      />
    </Space.Compact>
  )
}

function issueColor(level: ValidationIssue['level']) {
  if (level === 'error') return 'red'
  if (level === 'warning') return 'gold'
  return 'blue'
}

function statusColor(status: BatchStatus) {
  if (status === 'COMPLETED') return 'green'
  if (status === 'REVIEWING') return 'blue'
  if (status === 'WAITING_AI_RESULT') return 'gold'
  return 'default'
}

function hasErrors(issues: ValidationIssue[]) {
  return issues.some((issue) => issue.level === 'error')
}

function getUserDisplayName(displayName: string | null | undefined, email: string | null | undefined) {
  const normalizedName = displayName?.trim()
  if (normalizedName) return normalizedName
  if (email?.endsWith('@wechat.invalid')) return '微信用户'
  return email?.split('@')[0] || '用户'
}

async function downloadStorageFile(storagePath: string) {
  const url = await getFileDownloadUrl(storagePath)
  window.open(url, '_blank', 'noopener,noreferrer')
}

function useBatchWorkspace(batchId: string | undefined) {
  return useQuery({
    queryKey: ['batch-workspace', batchId],
    enabled: Boolean(batchId),
    queryFn: () => getBatchWorkspace(batchId!),
  })
}

function useModelDisplayNameMap(enabled = true) {
  const modelNamesQuery = useQuery({
    queryKey: ['model-display-names'],
    queryFn: listModelDisplayNames,
    enabled,
  })
  return useMemo(() => {
    const map = new Map<string, string>()
    for (const model of modelNamesQuery.data ?? []) map.set(model.id, model.display_name)
    return map
  }, [modelNamesQuery.data])
}

function SetupPage() {
  return (
    <main className="center-page">
      <Card className="setup-card">
        <Title level={2}>AI 需求—代码一致性评审平台</Title>
        <Alert
          type="warning"
          showIcon
          title="缺少 Supabase 环境变量"
          description="复制 .env.example 为 .env.local，并填写 VITE_SUPABASE_URL 与 VITE_SUPABASE_ANON_KEY。数据库初始化 SQL 位于 supabase/migrations/0001_review_platform.sql。"
        />
      </Card>
    </main>
  )
}

function AuthPageLayout({
  title,
  description,
  children,
}: {
  title: string
  description: string
  children: ReactNode
}) {
  return (
    <main className="center-page auth-page">
      <Card className="auth-card" bordered={false}>
        <div className="auth-brand">
          <span className="auth-brand-mark">AI</span>
          <div>
            <Text strong>AI 需求—代码一致性评审平台</Text>
            <div className="auth-brand-caption">需求与代码的一致性质量门户</div>
          </div>
        </div>
        <div className="auth-heading">
          <Title level={2}>{title}</Title>
          <Paragraph type="secondary">{description}</Paragraph>
        </div>
        {children}
      </Card>
    </main>
  )
}

/**
 * 重发验证邮件的按钮。
 *
 * GoTrue 对重发有 60 秒冷却，前端同步一个倒计时：既挡住连点（连点只会换来一串报错），
 * 也让用户知道还要等多久，而不是对着一个「点了没反应」的按钮猜。
 */
function ResendConfirmationButton({ email, initialCooldown = 0, block }: { email: string; initialCooldown?: number; block?: boolean }) {
  const { message } = AntApp.useApp()
  const [seconds, setSeconds] = useState(initialCooldown)

  useEffect(() => {
    if (seconds <= 0) return
    const timer = window.setTimeout(() => setSeconds((value) => value - 1), 1000)
    return () => window.clearTimeout(timer)
  }, [seconds])

  const mutation = useMutation({
    mutationFn: () => resendSignUpEmail(email),
    onSuccess: () => {
      message.success('验证邮件已重新发送，请查收（记得看一下垃圾邮件箱）')
      setSeconds(60)
    },
    onError: (error) => message.error(error.message),
  })

  return (
    <Button
      block={block}
      disabled={seconds > 0}
      loading={mutation.isPending}
      onClick={() => mutation.mutate()}
    >
      {seconds > 0 ? `重新发送验证邮件（${seconds}s）` : '重新发送验证邮件'}
    </Button>
  )
}

function LoginPage() {
  const [wechatError] = useState(consumeWechatAuthError)
  const { message } = AntApp.useApp()
  // 只有确认是「邮箱没验证」才亮重发入口：密码错、账号不存在等情况给重发按钮属于误导。
  const [unconfirmedEmail, setUnconfirmedEmail] = useState<string | null>(null)
  const mutation = useMutation({
    mutationFn: (values: { email: string; password: string }) => signIn(values.email, values.password),
    onSuccess: () => {
      setUnconfirmedEmail(null)
      message.success('登录成功')
    },
    onError: (error, values) => {
      message.error(error.message)
      setUnconfirmedEmail(error instanceof AuthActionError && error.code === 'email_not_confirmed' ? values.email : null)
    },
  })

  return (
    <AuthPageLayout title="欢迎登录" description="使用你的邮箱账号进入评审工作台">
      {wechatError ? <Alert className="auth-alert" type="error" showIcon title={wechatError} /> : null}
      {unconfirmedEmail ? (
        <Alert
          className="auth-alert"
          type="warning"
          showIcon
          title="邮箱还没验证"
          description={(
            <div className="auth-alert-body">
              <Text type="secondary">
                验证邮件发到了 {unconfirmedEmail}，链接 24 小时内有效。没收到就翻一下垃圾邮件箱，或者重新发一封。
              </Text>
              <ResendConfirmationButton email={unconfirmedEmail} />
            </div>
          )}
        />
      ) : null}
      <Form layout="vertical" requiredMark={false} onFinish={(values) => mutation.mutate(values)}>
        <Form.Item name="email" label="邮箱" rules={[{ required: true, type: 'email', message: '请输入有效邮箱' }]}>
          <Input size="large" autoComplete="email" placeholder="name@example.com" />
        </Form.Item>
        <Form.Item name="password" label="密码" rules={[{ required: true, message: '请输入密码' }]}>
          <Input.Password size="large" autoComplete="current-password" placeholder="请输入密码" />
        </Form.Item>
        <Button className="auth-submit" type="primary" size="large" block htmlType="submit" loading={mutation.isPending}>
          登录
        </Button>
      </Form>
      <div className="auth-switch">
        <Text type="secondary">还没有账号？</Text>
        <Link to="/register">立即注册</Link>
      </div>
      {wechatLoginEnabled ? (
        <>
          <Divider plain>其他登录方式</Divider>
          <Button size="large" block onClick={() => startWechatSignIn().catch((error: Error) => message.error(error.message))}>
            微信扫码登录
          </Button>
          <Paragraph className="auth-hint" type="secondary">
            已有邮箱账号请先用邮箱登录，再到个人中心绑定微信，避免创建新账号。
          </Paragraph>
        </>
      ) : null}
    </AuthPageLayout>
  )
}

function RegisterPage() {
  const { message } = AntApp.useApp()
  const navigate = useNavigate()
  /**
   * 注册成功后停在结果页而不是立刻跳登录页。
   *
   * 原来是弹一条 toast 然后 replace 到 /login，提示三秒就消失，用户没记住要去收邮件、
   * 更没有重发的入口，邮件一丢就只能靠「再注册一次」自救。
   */
  const [result, setResult] = useState<{ email: string; alreadyRegistered: boolean } | null>(null)
  const mutation = useMutation({
    mutationFn: (values: { email: string; password: string; confirmPassword: string }) => signUp(values.email, values.password),
    onSuccess: (data, values) => {
      // 关掉邮箱验证时 signUp 直接返回 session，这时没有邮件要等，按老路径跳走。
      if (!data.needsEmailConfirmation) {
        message.success('注册成功')
        navigate('/login', { replace: true })
        return
      }
      setResult({ email: values.email, alreadyRegistered: data.alreadyRegistered })
    },
    onError: (error) => message.error(error.message),
  })

  if (result) {
    return (
      <AuthPageLayout
        title={result.alreadyRegistered ? '这个邮箱已注册过' : '验证邮件已发送'}
        description={result.alreadyRegistered ? '按下面的说明处理即可' : '完成邮箱验证后就能登录了'}
      >
        <Alert
          className="auth-alert"
          type={result.alreadyRegistered ? 'warning' : 'success'}
          showIcon
          title={result.email}
          description={result.alreadyRegistered
            ? '如果当时没完成验证，我们已经重新发了一封验证邮件；如果早就验证过了，直接返回登录即可。'
            : '点开邮件里的验证链接即可完成注册，链接 24 小时内有效。没收到先翻一下垃圾邮件箱。'}
        />
        <ResendConfirmationButton email={result.email} initialCooldown={60} block />
        <div className="auth-switch">
          <Text type="secondary">验证完成后</Text>
          <Link to="/login">返回登录</Link>
        </div>
      </AuthPageLayout>
    )
  }

  return (
    <AuthPageLayout title="创建账号" description="注册邮箱账号，开始使用代码一致性评审平台">
      <Form layout="vertical" requiredMark={false} onFinish={(values) => mutation.mutate(values)}>
        <Form.Item name="email" label="邮箱" rules={[{ required: true, type: 'email', message: '请输入有效邮箱' }]}>
          <Input size="large" autoComplete="email" placeholder="name@example.com" />
        </Form.Item>
        <Form.Item
          name="password"
          label="密码"
          rules={[
            { required: true, message: '请输入密码' },
            { min: 6, message: '密码至少需要 6 个字符' },
          ]}
        >
          <Input.Password size="large" autoComplete="new-password" placeholder="至少 6 个字符" />
        </Form.Item>
        <Form.Item
          name="confirmPassword"
          label="确认密码"
          dependencies={['password']}
          rules={[
            { required: true, message: '请再次输入密码' },
            ({ getFieldValue }) => ({
              validator(_, value) {
                if (!value || getFieldValue('password') === value) return Promise.resolve()
                return Promise.reject(new Error('两次输入的密码不一致'))
              },
            }),
          ]}
        >
          <Input.Password size="large" autoComplete="new-password" placeholder="再次输入密码" />
        </Form.Item>
        <Button className="auth-submit" type="primary" size="large" block htmlType="submit" loading={mutation.isPending}>
          注册
        </Button>
      </Form>
      <div className="auth-switch">
        <Text type="secondary">已有账号？</Text>
        <Link to="/login">返回登录</Link>
      </div>
    </AuthPageLayout>
  )
}

function AuthRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route path="*" element={<Navigate to="/login" replace />} />
    </Routes>
  )
}

function Shell({ session }: { session: Session }) {
  const location = useLocation()
  const { message } = AntApp.useApp()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const profileQuery = useQuery({ queryKey: ['my-profile'], queryFn: getMyProfile })
  const claimAdminMutation = useMutation({
    mutationFn: claimInitialAdmin,
    onSuccess: () => {
      message.success('已成为初始管理员')
      queryClient.invalidateQueries({ queryKey: ['my-profile'] })
    },
    onError: (error) => message.error(error.message),
  })
  const logoutMutation = useMutation({
    mutationFn: signOut,
    onSuccess: () => navigate('/'),
    onError: (error) => message.error(error.message),
  })

  const role = profileQuery.data?.role
  const isAdmin = role === 'ADMIN'
  const isWechatOnly = session.user.email?.endsWith('@wechat.invalid') ?? false
  const accountLabel = getUserDisplayName(profileQuery.data?.display_name, session.user.email)
  const canCreateBatch = role === 'ADMIN' || role === 'REVIEWER'
  const canManageBatch = (batch: ReviewBatch) => role === 'ADMIN' || (role === 'REVIEWER' && batch.created_by === session.user.id)
  const selectedKey = location.pathname.startsWith('/profile')
    ? '/profile'
    : location.pathname.startsWith('/users')
      ? '/users'
      : location.pathname.startsWith('/monitoring')
        ? '/monitoring'
        : location.pathname.startsWith('/workers')
          ? '/workers'
          : location.pathname.startsWith('/harness-policy')
            ? '/harness-policy'
            : location.pathname.startsWith('/skills')
              ? '/skills'
              : location.pathname.startsWith('/models')
              ? '/models'
              : location.pathname.startsWith('/model-operation-log')
                ? '/model-operation-log'
                : location.pathname.startsWith('/operation-log')
                  ? '/operation-log'
                  : '/batches'
  const menuItems = [
    { key: '/batches', label: <Link to="/batches">代码评审</Link> },
    {
      key: '/operation-logs',
      label: '操作日志',
      children: [
        { key: '/operation-log', label: <Link to="/operation-log">代码评审操作日志</Link> },
        ...(isAdmin ? [{ key: '/model-operation-log', label: <Link to="/model-operation-log">模型操作日志</Link> }] : []),
      ],
    },
    { key: '/profile', label: <Link to="/profile">个人中心</Link> },
    // 导航仅 ADMIN 显示，但这不是安全边界：服务端 ensure_admin() 才是。
    ...(isAdmin ? [{ key: '/monitoring', label: <Link to="/monitoring">Agent 运行监控</Link> }] : []),
    ...(isAdmin ? [{ key: '/workers', label: <Link to="/workers">调度中心</Link> }] : []),
    ...(isAdmin ? [{ key: '/harness-policy', label: <Link to="/harness-policy">默认能力策略</Link> }] : []),
    ...(isAdmin ? [{ key: '/skills', label: <Link to="/skills">评审技能</Link> }] : []),
    ...(isAdmin ? [{ key: '/models', label: <Link to="/models">模型管理</Link> }] : []),
    ...(isAdmin ? [{ key: '/users', label: <Link to="/users">用户管理</Link> }] : []),
  ]

  return (
    <Layout className="app-shell">
      <Header className="app-header">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true">AI</span>
          <div className="brand-copy">
            <Text className="brand">AI需求-开发-评审一致性平台</Text>
            <Text className="subtitle">需求与代码一致性 · 智能分析</Text>
          </div>
        </div>
        <Space>
          <Text className="header-version">版本 V1.7</Text>
          <Tag color={profileQuery.data?.role === 'ADMIN' ? 'green' : 'blue'}>{profileQuery.data?.role ?? '未配置角色'}</Tag>
          {role === 'REVIEWER' ? (
            <Button size="small" onClick={() => claimAdminMutation.mutate()} loading={claimAdminMutation.isPending}>
              申领初始管理员
            </Button>
          ) : null}
          <Text className="header-email">{accountLabel}</Text>
          <Button onClick={() => logoutMutation.mutate()} loading={logoutMutation.isPending}>退出</Button>
        </Space>
      </Header>
      <Layout>
        <Sider width={220} className="app-sider">
          <Menu
            mode="inline"
            selectedKeys={[selectedKey]}
            defaultOpenKeys={['/operation-logs']}
            items={menuItems}
          />
        </Sider>
        <Content className="app-content">
          <Routes>
            <Route path="/" element={<Navigate to="/batches" replace />} />
            <Route path="/batches" element={<BatchesPage canCreateBatch={canCreateBatch} canManageBatch={canManageBatch} />} />
            <Route path="/operation-log" element={<OperationLogPage scope="batch" />} />
            <Route path="/model-operation-log" element={<OperationLogPage scope="model" isAdmin={isAdmin} />} />
            <Route
              path="/profile"
              element={(
                <ProfilePage
                  email={isWechatOnly ? null : (session.user.email ?? null)}
                  displayName={profileQuery.data?.display_name ?? null}
                  role={role}
                />
              )}
            />
            <Route path="/monitoring" element={<RuntimeMonitoringPage isAdmin={isAdmin} />} />
            <Route path="/workers" element={<WorkerManagementPage isAdmin={isAdmin} />} />
            <Route path="/harness-policy" element={<HarnessPolicyPage isAdmin={isAdmin} />} />
            <Route path="/skills" element={<SkillManagementPage isAdmin={isAdmin} />} />
            <Route path="/models" element={<ModelConfigPage isAdmin={isAdmin} />} />
            <Route path="/users" element={<AdminUsersPage isAdmin={isAdmin} />} />
            <Route path="/batches/:batchId/*" element={<BatchPage canManageBatch={canManageBatch} />} />
            <Route path="*" element={<Navigate to="/batches" replace />} />
          </Routes>
        </Content>
      </Layout>
    </Layout>
  )
}

/**
 * 模型页只管"接入"：端点、密钥、并发闸门、平台侧超时和 token 窗口。
 *
 * Agent 的请求预算（总量、根/子 Agent、重试、压缩、Ralph 轮次）不在这里：
 * 它们属于 V4 能力策略，唯一入口是「默认能力策略」页，保存后随新建 Job 冻结。
 * 早先这里也有重试和压缩两项，和策略页写的是同一列，后保存的会覆盖先保存的。
 */
interface ModelFormValues {
  display_name: string
  base_url: string
  model_name: string
  /**
   * 网络类型。决定 Worker 直连还是经宿主机本机代理访问该模型（V1.7 阶段二）。
   *
   * 它取代了在代理侧维护目标域名白名单的做法：新增内网模型只需在这里选一次，
   * 不用再改代理配置并重启服务。
   */
  network_access_mode: ModelNetworkAccessMode
  max_parallel_tasks: number
  request_timeout_seconds: number
  context_window: number
  max_output_tokens: number
  api_key?: string
}

function ModelConfigPage({ isAdmin }: { isAdmin: boolean }) {
  const queryClient = useQueryClient()
  const { message, modal } = AntApp.useApp()
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<AiModelConfigSummary | null>(null)
  // 当前正在观察的连接测试。结果只从查询缓存读取，不镜像进 state：镜像会让"排队中→
  // 测试中→终态"这条状态机同时存在两份真相，刷新页面后还会显示已经过期的旧结论。
  const [watchedTest, setWatchedTest] = useState<{ modelId: string; testId: string } | null>(null)
  const [form] = Form.useForm<ModelFormValues>()

  const testQuery = useQuery({
    queryKey: ['model-connectivity-test', watchedTest?.testId],
    enabled: Boolean(watchedTest?.testId),
    queryFn: () => getModelConnectivityTest(watchedTest!.testId),
    refetchInterval: (query) => {
      const status = (query.state.data as ModelConnectivityTest | undefined)?.status
      // 终态停止轮询：否则一次点击会一直向数据库发请求。
      return status === 'SUCCEEDED' || status === 'FAILED' ? false : 1000
    },
  })

  const modelsQuery = useQuery({ queryKey: ['admin-model-configs'], enabled: isAdmin, queryFn: adminListModelConfigs })

  const upsertMutation = useMutation({
    mutationFn: async (values: ModelFormValues) => {
      const payload: ModelConfigInput = {
        display_name: values.display_name.trim(),
        base_url: values.base_url.trim(),
        model_name: values.model_name.trim(),
        max_parallel_tasks: values.max_parallel_tasks,
        request_timeout_ms: Math.round(values.request_timeout_seconds * 1000),
        context_window: values.context_window,
        max_output_tokens: values.max_output_tokens,
        network_access_mode: values.network_access_mode,
        // 留空表示不轮换密钥；编辑时永不回显旧值
        api_key: values.api_key && values.api_key.length ? values.api_key : null,
      }
      if (editing) return adminUpdateModelConfig(editing.id, payload)
      return adminCreateModelConfig(payload)
    },
    onSuccess: () => {
      message.success(editing ? '模型配置已更新' : '模型配置已创建')
      setOpen(false)
      setEditing(null)
      form.resetFields()
      queryClient.invalidateQueries({ queryKey: ['admin-model-configs'] })
      queryClient.invalidateQueries({ queryKey: ['enabled-model-configs'] })
      queryClient.invalidateQueries({ queryKey: ['model-display-names'] })
      queryClient.invalidateQueries({ queryKey: ['operation-log'] })
    },
    onError: (error) => message.error(error.message),
  })

  const setEnabledMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => adminSetModelEnabled(id, enabled),
    onSuccess: () => {
      message.success('模型状态已更新')
      queryClient.invalidateQueries({ queryKey: ['admin-model-configs'] })
      queryClient.invalidateQueries({ queryKey: ['enabled-model-configs'] })
      queryClient.invalidateQueries({ queryKey: ['operation-log'] })
    },
    onError: (error) => message.error(error.message),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => adminDeleteModelConfig(id),
    onSuccess: () => {
      message.success('模型配置已删除')
      queryClient.invalidateQueries({ queryKey: ['admin-model-configs'] })
      queryClient.invalidateQueries({ queryKey: ['enabled-model-configs'] })
      queryClient.invalidateQueries({ queryKey: ['model-display-names'] })
      queryClient.invalidateQueries({ queryKey: ['operation-log'] })
    },
    onError: (error) => message.error(error.message),
  })

  const testMutation = useMutation({
    mutationFn: (modelId: string) => enqueueModelConnectivityTest(modelId),
    onSuccess: (testId, modelId) => {
      setWatchedTest({ modelId, testId })
    },
    onError: (error) => message.error(error.message),
  })

  if (!isAdmin) {
    return <Alert type="warning" showIcon title="无权限访问" description="只有管理员可以管理模型配置。" />
  }

  const openCreate = () => {
    setEditing(null)
    form.resetFields()
    form.setFieldsValue({
      // 默认公网模型：这是改造前的行为，也是不会让人意外走进代理的那个取值。
      network_access_mode: 'DIRECT',
      max_parallel_tasks: 4,
      request_timeout_seconds: 180,
      context_window: 131072,
      max_output_tokens: 8192,
    })
    setOpen(true)
  }

  const openEdit = (record: AiModelConfigSummary) => {
    setEditing(record)
    // API Key 编辑时永不回显，字段留空
    form.setFieldsValue({
      display_name: record.display_name,
      base_url: record.base_url,
      model_name: record.model_name,
      // 旧行没有这个字段时按公网处理，与数据库的 default 一致。
      network_access_mode: record.network_access_mode ?? 'DIRECT',
      max_parallel_tasks: record.max_parallel_tasks,
      request_timeout_seconds: Math.round(record.request_timeout_ms / 1000),
      context_window: record.context_window ?? 131072,
      max_output_tokens: record.max_output_tokens ?? 8192,
      api_key: '',
    })
    setOpen(true)
  }

  const confirmDelete = (record: AiModelConfigSummary) => {
    modal.confirm({
      title: `删除模型“${record.display_name}”？`,
      content: '删除后无法恢复，关联的 API Key 也会从 Vault 清理。',
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: () => deleteMutation.mutateAsync(record.id),
    })
  }

  const columns: ColumnsType<AiModelConfigSummary> = [
    { title: '模型名称', dataIndex: 'display_name' },
    { title: 'Base URL', dataIndex: 'base_url', ellipsis: true },
    { title: 'Model', dataIndex: 'model_name', width: 160 },
    {
      title: '网络类型',
      dataIndex: 'network_access_mode',
      width: 110,
      render: (mode: ModelNetworkAccessMode | undefined) =>
        mode === 'HOST_PROXY' ? (
          <Tooltip title="Worker 经宿主机本机代理访问该模型；Worker 未配置代理时任务会明确失败，不会静默直连。">
            <Tag color="gold">内网模型</Tag>
          </Tooltip>
        ) : (
          <Tag>公网模型</Tag>
        ),
    },
    {
      title: 'API Key',
      dataIndex: 'has_api_key',
      width: 110,
      render: (has: boolean) => (has ? <Tag color="green">已配置</Tag> : <Tag color="red">未配置</Tag>),
    },
    { title: '最大并发', dataIndex: 'max_parallel_tasks', width: 90 },
    {
      title: '超时',
      dataIndex: 'request_timeout_ms',
      width: 90,
      render: (ms: number) => `${Math.round(ms / 1000)}s`,
    },
    {
      title: '启用',
      dataIndex: 'enabled',
      width: 100,
      render: (enabled: boolean, record) => (
        <Switch
          checked={enabled}
          loading={setEnabledMutation.isPending && setEnabledMutation.variables?.id === record.id}
          onChange={(checked) => setEnabledMutation.mutate({ id: record.id, enabled: checked })}
        />
      ),
    },
    { title: '更新时间', dataIndex: 'updated_at', width: 180, render: (value: string) => new Date(value).toLocaleString() },
    {
      title: '操作',
      width: 260,
      render: (_value, record) => {
        const deleteDisabled = record.is_referenced !== false
        const deleteTip = record.is_referenced
          ? '请先删除已经选择了该模型的代码评审批次'
          : deleteDisabled
            ? '暂时无法确认模型引用状态，请刷新后重试'
            : undefined
        const currentTest = watchedTest?.modelId === record.id ? testQuery.data : undefined
        const testPending = currentTest?.status === 'QUEUED' || currentTest?.status === 'RUNNING'
        const enqueuing = testMutation.isPending && testMutation.variables === record.id
        return (
          <Space wrap>
            <Button size="small" onClick={() => openEdit(record)}>编辑</Button>
            <Button
              size="small"
              loading={enqueuing || testPending}
              disabled={!record.has_api_key}
              onClick={() => testMutation.mutate(record.id)}
            >
              测试连接
            </Button>
            {currentTest?.status === 'QUEUED' && <Tag color="processing">排队中</Tag>}
            {currentTest?.status === 'RUNNING' && <Tag color="processing">测试中</Tag>}
            {currentTest?.status === 'SUCCEEDED' && (
              <Tag color="green">通过 {currentTest.latency_ms ?? 0}ms</Tag>
            )}
            {currentTest?.status === 'FAILED' && (
              <Tooltip title={currentTest.error_message ?? currentTest.error_code}>
                <Tag color="red">未通过</Tag>
              </Tooltip>
            )}
            <Tooltip title={deleteTip}>
              <span>
                <Button
                  danger
                  size="small"
                  disabled={deleteDisabled}
                  loading={deleteMutation.isPending && deleteMutation.variables === record.id}
                  onClick={() => confirmDelete(record)}
                >
                  删除
                </Button>
              </span>
            </Tooltip>
          </Space>
        )
      },
    },
  ]

  return (
    <Space direction="vertical" size="large" className="page-stack">
      <PageTitle title="模型管理" extra={<Button type="primary" onClick={openCreate}>新增模型</Button>} />
      <Table rowKey="id" loading={modelsQuery.isLoading} columns={columns} dataSource={modelsQuery.data ?? []} pagination={false} />
      <Modal
        title={editing ? `编辑模型：${editing.display_name}` : '新增模型'}
        open={open}
        onCancel={() => {
          setOpen(false)
          setEditing(null)
        }}
        onOk={() => form.submit()}
        confirmLoading={upsertMutation.isPending}
        destroyOnClose
      >
        <Form form={form} layout="vertical" onFinish={(values) => upsertMutation.mutate(values)}>
          <Form.Item name="display_name" label="模型名称" rules={[{ required: true, message: '请输入用于识别的名称，例如 Qwen 主账号' }]}>
            <Input placeholder="Qwen 主账号" />
          </Form.Item>
          <Alert
            className="mb-md"
            type="info"
            showIcon
            title="DeepSeek Harness Agent"
            description="所有自动分析统一由 Harness Agent 在一次会话内自主检索并分析，证据必须来自任务冻结的精确提交范围。"
          />
          <Form.Item name="base_url" label="Base URL" rules={[{ required: true, message: '请输入模型兼容接口地址' }]}>
            <Input placeholder="https://.../v1" />
          </Form.Item>
          <Form.Item name="model_name" label="Model" rules={[{ required: true, message: '请输入实际模型名称' }]}>
            <Input placeholder="qwen-max" />
          </Form.Item>
          <Form.Item
            name="network_access_mode"
            label="网络类型"
            rules={[{ required: true, message: '请选择网络类型' }]}
            extra="公网模型：Worker 直接请求。内网模型：Worker 经宿主机本机代理请求（需要该 Worker 已配置代理，否则连接测试与正式评审都会明确失败而不会静默直连）。"
          >
            <Select
              options={[
                { value: 'DIRECT', label: '公网模型（直接访问）' },
                { value: 'HOST_PROXY', label: '内网模型（经本机代理访问）' },
              ]}
            />
          </Form.Item>
          <Form.Item
            name="api_key"
            label={editing ? 'API Key（留空表示不修改）' : 'API Key'}
            rules={editing ? [] : [{ required: true, message: '请输入 API Key' }]}
            extra={editing ? '出于安全，编辑时不显示原 Key；仅在需要轮换时填写新值。' : undefined}
          >
            <Input.Password autoComplete="new-password" placeholder={editing ? '不修改请留空' : '仅密码方式输入'} />
          </Form.Item>
          <Form.Item
            name="max_parallel_tasks"
            label="最大并发需求数（1~20）"
            rules={[{ required: true, message: '请输入最大并发需求数' }]}
            extra="同一模型同时在分析的需求数上限，实时生效。Agent 内部的并发（子 Agent、并行工具）在「默认能力策略」里配置。"
          >
            <InputNumber min={1} max={20} className="full-width" />
          </Form.Item>
          <Form.Item
            name="request_timeout_seconds"
            label="平台请求超时（10~600 秒）"
            rules={[{ required: true, message: '请输入请求超时秒数' }]}
            extra="用于 Git 准备、Worker 与 Agent 之间的通信和连通性测试；Agent 执行单条命令的超时是「默认能力策略」里的沙箱命令超时。"
          >
            <InputNumber min={10} max={600} className="full-width" />
          </Form.Item>
          <Form.Item
            name="context_window"
            label="上下文窗口（token）"
            rules={[{ required: true, message: '请输入上下文窗口' }]}
          >
            <InputNumber min={8192} max={4194304} step={1024} className="full-width" />
          </Form.Item>
          <Form.Item
            name="max_output_tokens"
            label="单次最大输出（token）"
            rules={[{ required: true, message: '请输入单次最大输出' }]}
          >
            <InputNumber min={256} max={262144} step={256} className="full-width" />
          </Form.Item>
          <Alert
            type="info"
            showIcon
            title="模型请求预算在「默认能力策略」里配置"
            description="总请求、根 / 子 Agent、重试、压缩和 Ralph 轮次上限按模型维护，保存后随新建 Job 冻结；在这里重复一份会互相覆盖，所以只保留一个入口。"
          />
        </Form>
      </Modal>
    </Space>
  )
}

function AdminUsersPage({ isAdmin }: { isAdmin: boolean }) {
  const queryClient = useQueryClient()
  const { message } = AntApp.useApp()
  const usersQuery = useQuery({ queryKey: ['admin-users'], enabled: isAdmin, queryFn: adminListUsers })
  const updateRoleMutation = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: UserRole }) => adminUpdateUserRole(userId, role),
    onSuccess: () => {
      message.success('用户角色已更新')
      queryClient.invalidateQueries({ queryKey: ['admin-users'] })
      queryClient.invalidateQueries({ queryKey: ['my-profile'] })
    },
    onError: (error) => message.error(error.message),
  })

  if (!isAdmin) {
    return <Alert type="warning" showIcon title="无权限访问" description="只有管理员可以管理用户角色。" />
  }

  const roleOptions = [
    { value: 'ADMIN', label: '管理员' },
    { value: 'REVIEWER', label: '审核者' },
    { value: 'VIEWER', label: '查看者' },
  ]

  const columns: ColumnsType<AdminUserListItem> = [
    { title: '邮箱', dataIndex: 'email' },
    {
      title: '用户名',
      dataIndex: 'display_name',
      render: (value: string | null, record) => getUserDisplayName(value, record.email),
    },
    {
      title: '邮箱状态',
      dataIndex: 'email_confirmed_at',
      width: 150,
      filters: [
        { text: '待验证', value: 'pending' },
        { text: '已验证', value: 'confirmed' },
      ],
      onFilter: (value, record) => (value === 'pending' ? !record.email_confirmed_at : Boolean(record.email_confirmed_at)),
      render: (confirmedAt: string | null, record) => (confirmedAt ? (
        <Tooltip title={`验证于 ${new Date(confirmedAt).toLocaleString()}${record.last_sign_in_at ? `，最近登录 ${new Date(record.last_sign_in_at).toLocaleString()}` : '，从未登录'}`}>
          <Tag color="green">已验证</Tag>
        </Tooltip>
      ) : (
        <Tooltip title="注册后没点验证邮件，当前无法登录。可让他在登录页用「重新发送验证邮件」拿一封新的。">
          <Tag color="orange">待验证</Tag>
        </Tooltip>
      )),
    },
    {
      title: '角色',
      dataIndex: 'role',
      width: 180,
      render: (role: UserRole, record) => (
        <Select
          value={role}
          options={roleOptions}
          className="full-width"
          loading={updateRoleMutation.isPending}
          onChange={(nextRole) => updateRoleMutation.mutate({ userId: record.id, role: nextRole })}
        />
      ),
    },
    { title: '创建时间', dataIndex: 'created_at', width: 200, render: (value) => new Date(value).toLocaleString() },
  ]

  const pendingCount = usersQuery.data?.filter((user) => !user.email_confirmed_at).length ?? 0

  return (
    <Space direction="vertical" size="large" className="page-stack">
      <PageTitle title="用户管理" />
      {pendingCount > 0 ? (
        <Alert
          type="warning"
          showIcon
          title={`有 ${pendingCount} 个账号还没验证邮箱`}
          description="这些账号注册流程没走完，暂时登录不了。让本人在登录页点一次「重新发送验证邮件」即可；实在收不到邮件（企业邮箱网关拦截等）再去 Supabase 后台手动确认。"
        />
      ) : null}
      <Table rowKey="id" loading={usersQuery.isLoading} columns={columns} dataSource={usersQuery.data ?? []} />
    </Space>
  )
}

function BatchesPage({ canCreateBatch, canManageBatch }: { canCreateBatch: boolean; canManageBatch: (batch: ReviewBatch) => boolean }) {
  const [open, setOpen] = useState(false)
  const [form] = Form.useForm<CreateBatchFormValues>()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { message, modal } = AntApp.useApp()
  const batchesQuery = useQuery({ queryKey: ['batches'], queryFn: listBatches })
  const enabledModelsQuery = useQuery({
    queryKey: ['enabled-model-configs'],
    enabled: canCreateBatch,
    queryFn: listEnabledModelConfigs,
  })
  const modelNameById = useModelDisplayNameMap()
  const createMutation = useMutation({
    mutationFn: createBatch,
    onSuccess: (batch) => {
      message.success('批次已创建')
      setOpen(false)
      form.resetFields()
      queryClient.invalidateQueries({ queryKey: ['batches'] })
      queryClient.invalidateQueries({ queryKey: ['operation-log'] })
      navigate(`/batches/${batch.id}/import`)
    },
    onError: (error) => message.error(error.message),
  })
  const deleteMutation = useMutation({
    mutationFn: deleteBatch,
    onSuccess: () => {
      message.success('批次已删除')
      queryClient.invalidateQueries({ queryKey: ['batches'] })
      queryClient.invalidateQueries({ queryKey: ['operation-log'] })
    },
    onError: (error) => message.error(error.message),
  })

  const columns: ColumnsType<ReviewBatchListItem> = [
    {
      title: '评审描述',
      dataIndex: 'name',
      width: 260,
      ellipsis: { showTitle: false },
      render: (name: string, record) => (
        <Link to={`/batches/${record.id}/dashboard`} title={name}>{name}</Link>
      ),
    },
    { title: '发布周期', dataIndex: 'week_code', width: 140 },
    { title: '状态', dataIndex: 'status', width: 150, render: (status: BatchStatus) => <Tag color={statusColor(status)}>{batchStatusLabels[status]}</Tag> },
    { title: '代码基线', dataIndex: 'default_branch', width: 140, render: (value) => value || '-' },
    {
      title: '模型',
      dataIndex: 'ai_model_config_id',
      width: 160,
      render: (_value, record) => {
        const name = (record.ai_model_config_id ? modelNameById.get(record.ai_model_config_id) : null)
          ?? record.ai_model_snapshot?.display_name
        return name ? <Tag color="geekblue">{name}</Tag> : <Tag color="orange">未选择</Tag>
      },
    },
    { title: '创建人', dataIndex: 'creator_name', width: 140, render: (value: string | null) => value || '-' },
    { title: '创建时间', dataIndex: 'created_at', width: 180, render: (value) => new Date(value).toLocaleString() },
    {
      title: '操作',
      width: 100,
      render: (_value, record) => canManageBatch(record) ? (
        <Button
          danger
          size="small"
          loading={deleteMutation.isPending && deleteMutation.variables === record.id}
          onClick={() => {
            modal.confirm({
              title: '删除批次',
              content: `确定删除批次"${record.name}"（${record.week_code}）吗？该批次的全部需求、AI结果、人工确认和上传文件都会一起删除，且不可恢复。`,
              okText: '删除',
              okButtonProps: { danger: true },
              onOk: () => deleteMutation.mutate(record.id),
            })
          }}
        >
          删除
        </Button>
      ) : null,
    },
  ]

  return (
    <Space direction="vertical" size="large" className="page-stack">
      <PageTitle
        title="评审列表"
        extra={canCreateBatch ? (
          <Button
            type="primary"
            onClick={() => {
              form.resetFields()
              form.setFieldValue('week_code_parts', getTodayWeekCodeParts())
              setOpen(true)
            }}
          >
            创建代码评审
          </Button>
        ) : null}
      />
      <Table
        rowKey="id"
        loading={batchesQuery.isLoading}
        columns={columns}
        dataSource={batchesQuery.data ?? []}
        tableLayout="fixed"
      />
      <Modal title="创建每周评审批次" open={open} onCancel={() => setOpen(false)} onOk={() => form.submit()} confirmLoading={createMutation.isPending}>
        <Form
          form={form}
          layout="vertical"
          initialValues={{ week_code_parts: getTodayWeekCodeParts() }}
          onFinish={({ week_code_parts, ...rest }) => {
            const weekCode = buildWeekCode(week_code_parts ?? {})
            if (!weekCode) return
            createMutation.mutate({ ...rest, week_code: weekCode })
          }}
        >
          <Form.Item name="name" label="评审描述" rules={[{ required: true, message: '请输入评审描述' }]}>
            <Input placeholder="2026 年第 36 周需求评审" />
          </Form.Item>
          <Form.Item
            name="week_code_parts"
            label="发布周期"
            required
            extra="默认当天，可手动调整；年、月、日会自动拼接成 20260918 这种格式"
            rules={[
              {
                validator: async (_rule, value?: WeekCodeParts) => {
                  const weekCode = buildWeekCode(value ?? {})
                  if (!weekCode) throw new Error('请选择完整的发布周期（年 / 月 / 日）')
                  if (batchesQuery.data?.some((batch) => batch.week_code === weekCode)) throw new Error('发布周期已存在，请换一个')
                },
              },
            ]}
          >
            <WeekCodeSelect />
          </Form.Item>
          <Form.Item name="default_branch" label="代码基线" rules={[{ required: true, message: '请选择代码基线' }]}>
            <Select placeholder="选择代码基线" options={defaultBranchOptions} />
          </Form.Item>
          <Form.Item
            name="ai_model_config_id"
            label="模型"
            rules={[{ required: true, message: '请选择模型' }]}
            extra={enabledModelsQuery.data && enabledModelsQuery.data.length === 0 ? '暂无已启用且已配置密钥的模型，请先在“模型管理”中配置。' : undefined}
          >
            <Select
              placeholder="只显示已启用且已配置 Key 的模型"
              loading={enabledModelsQuery.isLoading}
              options={(enabledModelsQuery.data ?? []).map((model) => ({
                value: model.id,
                label: `${model.display_name} / ${model.model_name}`,
              }))}
              notFoundContent="暂无可用模型"
            />
          </Form.Item>
          <Form.Item name="remark" label="备注">
            <Input.TextArea rows={3} />
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  )
}

function BatchPage({ canManageBatch }: { canManageBatch: (batch: ReviewBatch) => boolean }) {
  const { batchId } = useParams()
  const batchQuery = useQuery({ queryKey: ['batch', batchId], enabled: Boolean(batchId), queryFn: () => getBatch(batchId!) })
  const location = useLocation()
  const navigate = useNavigate()

  if (!batchId) return <Navigate to="/batches" replace />
  if (batchQuery.isLoading) return <Spin />
  if (!batchQuery.data) return <Empty description="批次不存在" />

  const canManage = canManageBatch(batchQuery.data)
  const tabs = [
    { key: 'dashboard', label: '统计看板' },
    { key: 'import', label: '原始需求导入' },
    { key: 'ai-result', label: 'AI结果管理' },
    { key: 'reviews', label: '评审列表' },
  ]
  const activeKey = tabs.find((tab) => location.pathname.includes(`/${tab.key}`))?.key ?? 'dashboard'

  return (
    // 用 flex 容器代替 Space：页签下面紧跟着 Routes 渲染的内容，需要自己控制这段间距。
    <div className="page-stack batch-page">
      <PageTitle
        title={batchQuery.data.name}
        extra={<Tag color={statusColor(batchQuery.data.status)}>{batchStatusLabels[batchQuery.data.status]}</Tag>}
      />
      <Tabs className="batch-tabs" activeKey={activeKey} items={tabs} onChange={(key) => navigate(`/batches/${batchId}/${key}`)} />
      <Routes>
        <Route path="/" element={<Navigate to="dashboard" replace />} />
        <Route path="dashboard" element={<DashboardPage batchId={batchId} canManage={canManage} />} />
        <Route path="import" element={<SourceImportPage batchId={batchId} batch={batchQuery.data} canManage={canManage} />} />
        <Route path="ai-result" element={<AiResultPage batchId={batchId} canManage={canManage} />} />
        <Route path="reviews" element={<ReviewListPage batchId={batchId} />} />
        <Route path="reviews/:storyId" element={<ReviewDetailPage batchId={batchId} canManage={canManage} />} />
        {/* Agent 运行详情：VIEWER 也能进入只读查看，取消按钮由 canManage 控制。 */}
        <Route path="agent-runs/:taskId" element={<AgentRunDetailPage canManage={canManage} />} />
      </Routes>
    </div>
  )
}

function SourceImportPage({ batchId, batch, canManage }: { batchId: string; batch: ReviewBatch; canManage: boolean }) {
  const [file, setFile] = useState<File | null>(null)
  const [headers, setHeaders] = useState<string[]>([])
  const [rows, setRows] = useState<Record<string, unknown>[]>([])
  const [firstDataRowNumber, setFirstDataRowNumber] = useState(2)
  const [mapping, setMapping] = useState<FieldMapping>({})
  const { message } = AntApp.useApp()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const readOnly = !canManage || batch.status === 'COMPLETED'
  const storiesQuery = useQuery({ queryKey: ['stories', batchId], queryFn: () => listStories(batchId) })
  const sourceFilesQuery = useQuery({ queryKey: ['import-files', batchId, 'SOURCE'], queryFn: () => listImportFiles(batchId, 'SOURCE') })
  const alreadyImported = Boolean(storiesQuery.data?.length)
  const parsed = useMemo(() => parseSourceRows(rows, mapping, firstDataRowNumber), [rows, mapping, firstDataRowNumber])
  const importMutation = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error('请先选择文件')
      const fileHash = await hashFile(file)
      const existingFile = await findImportFileByHash(batchId, 'SOURCE', fileHash)
      if (existingFile) throw new Error('该原始需求文件已导入，请不要重复上传')
      const storagePath = await uploadBatchFile(batchId, 'SOURCE', file)
      return confirmSourceImport({ batchId, fileName: file.name, storagePath, fileHash, stories: parsed.stories, fieldMapping: mapping })
    },
    onSuccess: () => {
      message.success('原始需求已导入')
      setFile(null)
      setHeaders([])
      setRows([])
      setFirstDataRowNumber(2)
      queryClient.invalidateQueries({ queryKey: ['stories', batchId] })
      queryClient.invalidateQueries({ queryKey: ['import-files', batchId, 'SOURCE'] })
      queryClient.invalidateQueries({ queryKey: ['batch', batchId] })
      queryClient.invalidateQueries({ queryKey: ['batch-workspace', batchId] })
      queryClient.invalidateQueries({ queryKey: ['batches'] })
      navigate(`/batches/${batchId}/ai-result`)
    },
    onError: (error) => message.error(error.message),
  })

  return (
    <Space direction="vertical" size="large" className="page-stack">
      {readOnly ? <Alert type="warning" showIcon title={canManage ? '批次已完成' : '无管理权限'} description={canManage ? '批次完成后默认只读，如需继续导入请先在统计看板重新打开批次。' : '只有管理员或该批次的创建者可以导入文件。'} /> : null}
      {alreadyImported ? (
        <>
          <Alert
            type="info"
            showIcon
            title="本批次已完成原始需求导入"
            description={`已导入 ${storiesQuery.data?.length ?? 0} 条需求，一个批次只能导入一份原始需求文件。如需重新导入，请创建新批次。`}
          />
          <MappingForm headers={[]} mapping={sourceFilesQuery.data?.[0]?.field_mapping ?? {}} onChange={() => {}} readOnly />
        </>
      ) : (
        <>
          <Steps current={rows.length ? (hasErrors(parsed.issues) ? 2 : 3) : 0} items={[{ title: '选择文件' }, { title: '字段映射' }, { title: '数据校验' }, { title: '确认导入' }]} />
          <Upload.Dragger
            accept=".xlsx,.xls"
            maxCount={1}
            disabled={readOnly}
            beforeUpload={async (selectedFile) => {
              const workbookRows = await readFirstSheet(selectedFile)
              setFile(selectedFile)
              setHeaders(workbookRows.headers)
              setRows(workbookRows.rows)
              setFirstDataRowNumber(workbookRows.firstDataRowNumber)
              setMapping(inferFieldMapping(workbookRows.headers))
              return false
            }}
            onRemove={() => {
              setFile(null)
              setHeaders([])
              setRows([])
              setFirstDataRowNumber(2)
              setMapping({})
            }}
          >
            <p>点击或拖拽上传原始需求 Excel</p>
            <Text type="secondary">平台会先解析预览，不会立即入库。</Text>
          </Upload.Dragger>
          {headers.length ? <MappingForm headers={headers} mapping={mapping} onChange={setMapping} /> : null}
          {rows.length ? <SourcePreview parsed={parsed} /> : null}
          <Button type="primary" disabled={readOnly || !file || !parsed.stories.length || hasErrors(parsed.issues)} loading={importMutation.isPending} onClick={() => importMutation.mutate()}>
            确认导入
          </Button>
        </>
      )}
      <Card title="原始文件历史">
        <List
          dataSource={sourceFilesQuery.data ?? []}
          locale={{ emptyText: '暂无原始需求文件' }}
          renderItem={(item) => (
            <List.Item actions={[<Button key="download" size="small" onClick={() => downloadStorageFile(item.storage_path)}>下载</Button>]}>
              <List.Item.Meta title={item.file_name} description={new Date(item.created_at).toLocaleString()} />
            </List.Item>
          )}
        />
      </Card>
    </Space>
  )
}

function MappingForm({ headers, mapping, onChange, readOnly }: { headers: string[]; mapping: FieldMapping; onChange: (mapping: FieldMapping) => void; readOnly?: boolean }) {
  const fields = Object.keys(sourceFieldLabels) as SourceFieldKey[]
  const title = readOnly ? '本次导入使用的字段映射' : '字段映射'

  return (
    <Card
      title={
        <Tooltip title="用于将导入 Excel 中的列对应到系统模板的实体字段，确认后平台会按此映射解析需求数据。">
          <span className="field-mapping-title">{title}<span className="field-mapping-help">?</span></span>
        </Tooltip>
      }
    >
      <Row gutter={[16, 12]}>
        {fields.map((field) => (
          <Col xs={24} md={12} lg={8} key={field}>
            <Text strong>{sourceFieldLabels[field]}</Text>
            {readOnly ? (
              <div className="select-with-margin">
                <Text type={mapping[field] ? undefined : 'secondary'}>{mapping[field] || '未映射'}</Text>
              </div>
            ) : (
              <Select
                allowClear
                className="full-width select-with-margin"
                value={mapping[field]}
                placeholder="选择 Excel 列"
                options={headers.map((header) => ({ value: header, label: header }))}
                onChange={(value) => onChange({ ...mapping, [field]: value })}
              />
            )}
          </Col>
        ))}
      </Row>
    </Card>
  )
}

function SourcePreview({ parsed }: { parsed: { stories: SourceStoryInput[]; issues: ValidationIssue[] } }) {
  return (
    <Row gutter={[16, 16]}>
      <Col span={24} lg={10}>
        <IssuesCard issues={parsed.issues} />
      </Col>
      <Col span={24} lg={14}>
        <Card title={`预览 ${parsed.stories.length} 条有效需求`}>
          <Table
            rowKey="story_code"
            size="small"
            pagination={{ pageSize: 5 }}
            dataSource={parsed.stories.slice(0, 20)}
            columns={[
              { title: '编码', dataIndex: 'story_code' },
              { title: '名称', dataIndex: 'story_name' },
              { title: '开发人员', dataIndex: 'owners_text' },
              { title: '需求人员', dataIndex: 'requirement_handlers' },
              { title: '测试人员', dataIndex: 'test_handlers' },
            ]}
          />
        </Card>
      </Col>
    </Row>
  )
}


const ACTIVE_JOB_STATUSES: AnalysisJob['status'][] = ['QUEUED', 'PREPARING_CODE', 'PROCESSING', 'FINALIZING']

function isActiveJob(job: AnalysisJob | null | undefined) {
  return Boolean(job && ACTIVE_JOB_STATUSES.includes(job.status))
}

function formatDuration(startedAt: string | null, finishedAt: string | null) {
  if (!startedAt) return '—'
  const start = new Date(startedAt).getTime()
  const end = finishedAt ? new Date(finishedAt).getTime() : Date.now()
  let seconds = Math.max(0, Math.floor((end - start) / 1000))
  const hh = Math.floor(seconds / 3600)
  seconds -= hh * 3600
  const mm = Math.floor(seconds / 60)
  const ss = seconds - mm * 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(hh)}:${pad(mm)}:${pad(ss)}`
}

const REQUIRED_REPOSITORIES = ['kdmanage-backend', 'kdmanage-frontend', 'tmanage-backend', 'tmanage-frontend']

/**
 * AI 自动分析卡片：主入口。
 * - 前置条件校验（权限、批次未完成、分支、模型、密钥、需求、无运行任务、无既有 AI 结果）。
 * - 历史批次可补选模型。
 * - 运行中每 4 秒轮询任务、快照、逐需求任务。
 * - 展示仓库快照、retrieval/analysis 进度、处理中需求、运行时长、错误码与可重试提示、按原 Commit 重试。
 */
function AutoAnalysisSection({
  batch,
  storyCount,
  canManage,
  hasExistingAiResult,
}: {
  batch: ReviewBatch
  storyCount: number
  canManage: boolean
  hasExistingAiResult: boolean
}) {
  const { message } = AntApp.useApp()
  const queryClient = useQueryClient()
  const [supplementalModelId, setSupplementalModelId] = useState<string>()

  const jobQuery = useQuery({
    queryKey: ['analysis-job', batch.id],
    queryFn: () => getLatestAnalysisJob(batch.id),
    refetchInterval: (query) => (isActiveJob(query.state.data as AnalysisJob | null) ? 4000 : false),
  })
  const job = jobQuery.data ?? null
  const jobActive = isActiveJob(job)

  const snapshotsQuery = useQuery({
    queryKey: ['analysis-snapshots', job?.id],
    enabled: Boolean(job?.id),
    queryFn: () => listRepositorySnapshots(job!.id),
    refetchInterval: jobActive ? 4000 : false,
  })
  const storyTasksQuery = useQuery({
    queryKey: ['analysis-story-tasks', job?.id],
    enabled: Boolean(job?.id),
    queryFn: () => listAnalysisStoryTasks(job!.id),
    refetchInterval: jobActive ? 4000 : false,
  })

  const enabledModelsQuery = useQuery({
    queryKey: ['enabled-model-configs'],
    enabled: canManage,
    queryFn: listEnabledModelConfigs,
  })
  const modelNameById = useModelDisplayNameMap()

  const invalidateAll = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['analysis-job', batch.id] })
    queryClient.invalidateQueries({ queryKey: ['batch', batch.id] })
    queryClient.invalidateQueries({ queryKey: ['batch-workspace', batch.id] })
    queryClient.invalidateQueries({ queryKey: ['ai-imports', batch.id] })
    queryClient.invalidateQueries({ queryKey: ['batches'] })
  }, [queryClient, batch.id])

  const setModelMutation = useMutation({
    mutationFn: () => {
      if (!supplementalModelId) throw new Error('请选择本批次使用的模型')
      return setBatchModel(batch.id, supplementalModelId)
    },
    onSuccess: () => {
      message.success('已为本批次选择模型')
      invalidateAll()
    },
    onError: (error) => message.error(error.message),
  })

  const enqueueMutation = useMutation({
    mutationFn: () => enqueueAnalysisJob(batch.id),
    onSuccess: () => {
      message.success('已发起 AI 分析')
      invalidateAll()
    },
    onError: (error) => message.error(error.message),
  })

  const retryMutation = useMutation({
    mutationFn: () => {
      if (!job) throw new Error('没有可重试的任务')
      return retryAnalysisJob(job.id)
    },
    onSuccess: () => {
      message.success('已按原 Commit 快照重试')
      invalidateAll()
    },
    onError: (error) => message.error(error.message),
  })

  // 运行中每秒刷新一次运行时长展示
  const [, forceTick] = useState(0)
  useEffect(() => {
    if (!jobActive) return
    const timer = setInterval(() => forceTick((n) => n + 1), 1000)
    return () => clearInterval(timer)
  }, [jobActive])

  const branchSupported = isSupportedDefaultBranch(batch.default_branch)
  const enabledModels = enabledModelsQuery.data ?? []
  // 实际确认所选模型仍在“已启用 + 已配置密钥”列表中（后端 has_api_key 已核验 Vault 存在）。
  const selectedModelEnabled = Boolean(
    batch.ai_model_config_id &&
      enabledModels.some((m) => m.id === batch.ai_model_config_id && m.enabled && m.has_api_key),
  )
  const modelReady = Boolean(batch.ai_model_config_id) && selectedModelEnabled
  const batchCompleted = batch.status === 'COMPLETED'

  // 自动分析成功后刷新导入/工作区（活动轮询停止的临界点）。
  const prevStatusRef = useRef<AnalysisJob['status'] | null>(null)
  useEffect(() => {
    const current = job?.status ?? null
    if (prevStatusRef.current && prevStatusRef.current !== 'SUCCEEDED' && current === 'SUCCEEDED') {
      invalidateAll()
    }
    prevStatusRef.current = current
  }, [job?.status, invalidateAll])

  // 前置条件（方案 5.2）
  const preconditions = [
    { label: '有管理该批次的权限', ok: canManage },
    { label: '批次未完成', ok: !batchCompleted },
    { label: '已选择受支持分支', ok: branchSupported },
    { label: '已选择可用模型（启用且已配置密钥）', ok: modelReady },
    { label: '已导入至少一条需求', ok: storyCount > 0 },
    { label: '当前没有运行中的分析任务', ok: !jobActive },
    { label: '当前批次尚未产生 AI 结果', ok: !hasExistingAiResult },
  ]
  const canStart = preconditions.every((item) => item.ok)

  const snapshots = snapshotsQuery.data ?? []
  const storyTasks = storyTasksQuery.data ?? []
  const agentDoneCount = storyTasks.filter((task) => task.agent_status === 'SUCCEEDED').length
  const processingStories = storyTasks.filter((task) => task.agent_status === 'RUNNING')
  const totalStories = job?.total_stories || storyTasks.length || storyCount
  const modelConfigId = batch.ai_model_config_id ?? job?.model_config_id ?? null
  const modelDisplay =
    (modelConfigId ? modelNameById.get(modelConfigId) : null) ??
    batch.ai_model_snapshot?.display_name ??
    job?.model_snapshot?.display_name ??
    (modelConfigId ? '已选择模型' : '未选择')
  const configuredModelName = modelConfigId
    ? enabledModels.find((model) => model.id === modelConfigId)?.model_name
    : undefined
  const modelName =
    batch.ai_model_snapshot?.model_name ??
    job?.model_snapshot?.model_name ??
    configuredModelName ??
    ''

  const resolvedError = resolveAnalysisError(job?.error_code, job?.error_message)
  const errorMeta = resolvedError.meta
  const retryable =
    job?.status === 'FAILED' &&
    job.execution_engine === 'deepseek-harness-acp' &&
    errorMeta.retryable

  return (
    <Card title="自动 AI 分析" className="auto-analysis-card">
      <Row gutter={[16, 8]}>
        <Col xs={12} md={6}><Statistic title="分支" value={batch.default_branch ?? '未选择'} /></Col>
        <Col xs={12} md={6}><Statistic title="需求" value={`${storyCount} 条`} /></Col>
        <Col xs={12} md={6}>
          <Statistic title="模型" value={modelName ? `${modelDisplay} / ${modelName}` : modelDisplay} />
        </Col>
        <Col xs={12} md={6}>
          <Statistic title="任务状态" value={job ? analysisJobStatusLabels[job.status] ?? job.status : '未开始'} />
        </Col>
      </Row>

      <Divider />

      {!batch.ai_model_config_id && canManage && !batchCompleted && !hasExistingAiResult ? (
        <Alert
          type="warning"
          showIcon
          className="mb-md"
          title="该批次尚未选择分析模型"
          description={
            <Space direction="vertical" className="full-width">
              <Text type="secondary">历史批次允许在首次开始分析前补选一次模型。</Text>
              <Space wrap>
                <Select
                  placeholder="选择已启用且已配置 Key 的模型"
                  style={{ minWidth: 260 }}
                  loading={enabledModelsQuery.isLoading}
                  value={supplementalModelId}
                  onChange={setSupplementalModelId}
                  options={enabledModels.map((model) => ({
                    value: model.id,
                    label: `${model.display_name} / ${model.model_name}`,
                  }))}
                  notFoundContent="暂无可用模型"
                />
                <Button type="primary" loading={setModelMutation.isPending} disabled={!supplementalModelId} onClick={() => setModelMutation.mutate()}>
                  保存模型
                </Button>
              </Space>
            </Space>
          }
        />
      ) : null}

      {batch.ai_model_config_id && !selectedModelEnabled && canManage && !batchCompleted && !hasExistingAiResult ? (
        <Alert
          type="error"
          showIcon
          className="mb-md"
          title="所选模型当前不可用"
          description="该批次绑定的模型已被停用或缺少 API Key（Vault 中无记录）。请在“模型管理”中重新启用或配置密钥后再开始分析。"
        />
      ) : null}

      {!hasExistingAiResult ? (
        <>
          {/* 开始自动分析前的条件检查 */}
          <div className="precondition-list">
            {preconditions.map((item) => (
              <Tag key={item.label} color={item.ok ? 'green' : 'default'} icon={undefined}>
                {item.ok ? '✓' : '•'} {item.label}
              </Tag>
            ))}
          </div>
        </>
      ) : null}

      <div className="mt-md">
        <Space wrap>
          <Button
            type="primary"
            disabled={!canStart}
            loading={enqueueMutation.isPending}
            onClick={() => enqueueMutation.mutate()}
          >
            开始 AI 分析
          </Button>
          {jobActive ? <Tag color="processing">分析进行中，页面每 4 秒自动刷新</Tag> : null}
        </Space>
      </div>

      {job ? (
        <>
          <Divider />
          <Row gutter={[16, 16]}>
            <Col xs={24} md={12}>
              <Statistic
                title="代码准备"
                value={`${snapshots.length}/4 仓库`}
                valueStyle={{ color: snapshots.length === 4 ? '#389e0d' : undefined }}
              />
            </Col>
            <Col xs={24} md={12}>
              <Statistic title="Agent 审核完成" value={`${agentDoneCount}/${totalStories}`} />
              <Progress
                percent={totalStories ? Math.round((agentDoneCount / totalStories) * 100) : 0}
                size="small"
              />
            </Col>
          </Row>

          <Row gutter={[16, 16]} className="mt-md">
            <Col xs={24} md={12}>
              <Text type="secondary">已运行：</Text>
              <Text strong> {formatDuration(job.started_at, job.finished_at)}</Text>
            </Col>
            <Col xs={24} md={12}>
              <Text type="secondary">处理中需求：</Text>
              {processingStories.length ? (
                <Space wrap size={[4, 4]}>
                  {processingStories.map((task) => (
                    <Tag key={task.id} color="blue">
                      {taskStoryLabel(task)}（{storyTaskStatusLabels.RUNNING}·Agent）
                    </Tag>
                  ))}
                </Space>
              ) : (
                <Text type="secondary"> 无</Text>
              )}
            </Col>
          </Row>

          {/* 仓库快照 */}
          <Divider titlePlacement="left" plain>仓库快照</Divider>
          <Table<AnalysisRepositorySnapshot>
            rowKey="id"
            size="small"
            pagination={false}
            loading={snapshotsQuery.isLoading}
            locale={{ emptyText: '仓库快照准备中' }}
            dataSource={snapshots}
            columns={[
              { title: '仓库', dataIndex: 'repository_name', width: 200 },
              { title: '分支', dataIndex: 'requested_branch', width: 140 },
              {
                title: 'Commit',
                dataIndex: 'commit_sha',
                render: (sha: string) => <Text code>{sha.slice(0, 12)}</Text>,
              },
              { title: 'Subject', dataIndex: 'commit_subject', render: (value) => value || '-' },
            ]}
          />
          {snapshots.length > 0 && snapshots.length < 4 ? (
            <Text type="secondary">
              待准备仓库：{REQUIRED_REPOSITORIES.filter((name) => !snapshots.some((s) => s.repository_name === name)).join('、')}
            </Text>
          ) : null}

          {/* 逐需求任务列表：每行提供进入 Agent 运行详情的入口（VIEWER 也可查看，只读）。 */}
          <Divider titlePlacement="left" plain>逐需求 Agent 任务</Divider>
          <Table<AnalysisStoryTaskWithStory>
            rowKey="id"
            size="small"
            pagination={{
              size: 'small',
              defaultPageSize: 10,
              showSizeChanger: true,
              pageSizeOptions: [10, 20, 50],
              showTotal: (total, range) => `第 ${range[0]}-${range[1]} 条 / 共 ${total} 个需求`,
            }}
            loading={storyTasksQuery.isLoading}
            locale={{ emptyText: '逐需求任务准备中' }}
            dataSource={storyTasks}
            columns={[
              { title: '需求', render: (_value, task) => taskStoryLabel(task) },
              {
                title: 'Agent 状态',
                dataIndex: 'agent_status',
                width: 140,
                filters: Object.entries(storyTaskStatusLabels).map(([value, text]) => ({ value, text })),
                onFilter: (value, task) => task.agent_status === value,
                render: (status: AnalysisStoryTaskWithStory['agent_status']) => (
                  <Tag color={status === 'SUCCEEDED' ? 'green' : status === 'FAILED' ? 'red' : status === 'RUNNING' ? 'processing' : 'default'}>
                    {storyTaskStatusLabels[status] ?? status}
                  </Tag>
                ),
              },
              {
                title: '操作',
                width: 120,
                render: (_value, task) => (
                  <Link to={`/batches/${batch.id}/agent-runs/${task.id}`}>运行详情</Link>
                ),
              },
            ]}
          />

          {/* 失败与重试 */}
          {job.status === 'FAILED' ? (
            <Alert
              className="mt-md"
              type="error"
              showIcon
              title={`分析失败：${errorMeta.title}`}
              description={
                <Space direction="vertical" className="full-width" size="small">
                  <Text>
                    <Text strong>原因：</Text>
                    {errorMeta.reason}
                  </Text>
                  <Text>
                    <Text strong>处理建议：</Text>
                    {errorMeta.suggestion}
                  </Text>
                  <Tag color={retryable ? 'green' : 'orange'}>
                    {retryable ? '处理根因后可按原 Commit 重试' : '不建议直接重试'}
                  </Tag>
                  <details>
                    <summary>技术详情</summary>
                    <Space direction="vertical" size={4} className="mt-sm">
                      <Text type="secondary">
                        错误码：<Text code>{resolvedError.code}</Text>
                        {resolvedError.originalCode && resolvedError.originalCode !== resolvedError.code
                          ? <>（数据库原始码：<Text code>{resolvedError.originalCode}</Text>）</>
                          : null}
                      </Text>
                      <Text code copyable>{job.error_message ?? '无额外技术信息'}</Text>
                    </Space>
                  </details>
                  {canManage ? (
                    <Button
                      danger
                      loading={retryMutation.isPending}
                      disabled={!retryable}
                      onClick={() => retryMutation.mutate()}
                    >
                      按原 Commit 重试
                    </Button>
                  ) : null}
                </Space>
              }
            />
          ) : null}

          {job.status === 'SUCCEEDED' ? (
            <Alert className="mt-md" type="success" showIcon title="AI 自动分析已完成" description="结果已写入当前批次，可进入评审列表进行人工确认。" />
          ) : null}
        </>
      ) : null}
    </Card>
  )
}

function taskStoryLabel(task: AnalysisStoryTaskWithStory) {
  // 优先展示需求编号（join review_story）；缺失时退化为短 story_id。
  return task.review_story?.story_code ?? task.story_id.slice(0, 8)
}
function AiResultPage({ batchId, canManage }: { batchId: string; canManage: boolean }) {
  const [resultMode, setResultMode] = useState<AiResultMode>('auto')
  const [file, setFile] = useState<File | null>(null)
  const [parsed, setParsed] = useState<Awaited<ReturnType<typeof parseAiWorkbook>> | null>(null)
  const [defaultBranch, setDefaultBranch] = useState<DefaultBranch>()
  const { message, modal } = AntApp.useApp()
  const queryClient = useQueryClient()
  const workspaceQuery = useBatchWorkspace(batchId)
  const aiImportsQuery = useQuery({ queryKey: ['ai-imports', batchId], queryFn: () => listAiImports(batchId) })
  const activeAiImport = aiImportsQuery.data?.find((item) => item.is_active) ?? null
  const lockedResultMode: AiResultMode | null = activeAiImport
    ? activeAiImport.import_file_id
      ? 'manual'
      : 'auto'
    : null
  const visibleResultMode = lockedResultMode ?? resultMode
  const setDefaultBranchMutation = useMutation({
    mutationFn: () => {
      if (!defaultBranch) throw new Error('请选择代码基线分支')
      return setBatchDefaultBranch(batchId, defaultBranch)
    },
    onSuccess: () => {
      message.success('代码基线分支已设置')
      queryClient.invalidateQueries({ queryKey: ['batch-workspace', batchId] })
      queryClient.invalidateQueries({ queryKey: ['batch', batchId] })
      queryClient.invalidateQueries({ queryKey: ['batches'] })
    },
    onError: (error) => message.error(error.message),
  })
  const importMutation = useMutation({
    mutationFn: async () => {
      if (!file || !parsed || !workspaceQuery.data) throw new Error('请先上传并解析AI结果文件')
      const { baseline_branch: baselineBranch, baseline_commit: baselineCommit, ai_model: aiModel } = parsed.batchInfo
      if (!baselineBranch || !baselineCommit || !aiModel || !parsed.analyzedAt) throw new Error('批次信息中的基线元数据未通过校验')

      const fileHash = await hashFile(file)
      const existingFile = await findImportFileByHash(batchId, 'AI_RESULT', fileHash)
      if (existingFile) throw new Error('该AI结果文件已导入，请不要重复上传')
      const storagePath = await uploadBatchFile(batchId, 'AI_RESULT', file)
      return confirmAiResultImport({
        batchId,
        fileName: file.name,
        storagePath,
        fileHash,
        templateVersion,
        baselineBranch,
        baselineCommit,
        aiModel,
        analyzedAt: parsed.analyzedAt,
        results: parsed.results,
        evidence: parsed.evidence,
      })
    },
    onSuccess: () => {
      message.success('AI结果已导入')
      setFile(null)
      setParsed(null)
      queryClient.invalidateQueries({ queryKey: ['batch-workspace', batchId] })
      queryClient.invalidateQueries({ queryKey: ['ai-imports', batchId] })
      queryClient.invalidateQueries({ queryKey: ['batch', batchId] })
      queryClient.invalidateQueries({ queryKey: ['batches'] })
    },
    onError: (error) => message.error(error.message),
  })

  if (workspaceQuery.isLoading || aiImportsQuery.isLoading) return <Spin />
  if (!workspaceQuery.data) return <Empty />
  if (aiImportsQuery.isError) {
    return <Alert type="error" showIcon title="AI 报告加载失败" description="暂时无法确认当前批次的 AI 结果来源，请刷新页面后重试。" />
  }

  const readOnly = !canManage || workspaceQuery.data.batch.status === 'COMPLETED'
  const alreadyImportedAi = Boolean(activeAiImport)

  return (
    <Space direction="vertical" size="large" className="page-stack">
      {readOnly ? <Alert type="warning" showIcon title={canManage ? '批次已完成' : '无管理权限'} description={canManage ? '批次完成后默认只读，如需继续导入或切换生效版本请先在统计看板重新打开批次。' : '只有管理员或该批次的创建者可以管理 AI 结果。'} /> : null}
      {!isSupportedDefaultBranch(workspaceQuery.data.batch.default_branch) && !alreadyImportedAi ? (
        <Card>
          <Alert type="info" showIcon title="请先设置代码基线分支" description="该历史批次尚未配置受支持的分支。设置后可下载 AI 模板；导入 AI 结果后不能再修改。" />
          <Space className="select-with-margin" wrap>
            <Select placeholder="选择代码基线分支" options={defaultBranchOptions} value={defaultBranch} onChange={setDefaultBranch} disabled={readOnly} />
            <Button type="primary" disabled={readOnly || !defaultBranch} loading={setDefaultBranchMutation.isPending} onClick={() => setDefaultBranchMutation.mutate()}>
              保存分支
            </Button>
          </Space>
        </Card>
      ) : null}
      <Card
        title={lockedResultMode ? 'AI 结果处理方式' : '选择 AI 结果处理方式'}
        className="ai-result-mode-picker"
        extra={lockedResultMode ? <Tag color="green">已锁定</Tag> : null}
      >
        {lockedResultMode ? (
          <Alert
            type="success"
            showIcon
            title={lockedResultMode === 'auto' ? '自动 AI 分析' : '人工手动 AI 分析'}
            description={
              lockedResultMode === 'auto'
                ? '本批次已通过自动 AI 分析生成结果，处理方式已锁定，只展示自动分析看板。'
                : '本批次已通过人工 AI Excel 导入结果，处理方式已锁定，只展示人工手动 AI 分析看板。'
            }
          />
        ) : (
          <>
            <Text type="secondary">两种流程相互独立。产生 AI 结果后，处理方式将被锁定且不能再切换。</Text>
            <Radio.Group
              className="ai-result-mode-options"
              value={resultMode}
              buttonStyle="solid"
              onChange={(event) => setResultMode(event.target.value as AiResultMode)}
            >
              <Radio.Button value="auto">
                <div className="ai-result-mode-content">
                  <Text strong>自动 AI 分析</Text>
                  <Text type="secondary">平台自动准备代码、检索需求并生成分析结果</Text>
                </div>
              </Radio.Button>
              <Radio.Button value="manual">
                <div className="ai-result-mode-content">
                  <Text strong>人工手动 AI 分析</Text>
                  <Text type="secondary">下载模板交给外部 AI 填写，再上传校验并导入</Text>
                </div>
              </Radio.Button>
            </Radio.Group>
          </>
        )}
      </Card>
      {visibleResultMode === 'auto' ? (
        <AutoAnalysisSection
          batch={workspaceQuery.data.batch}
          storyCount={workspaceQuery.data.stories.length}
          canManage={canManage}
          hasExistingAiResult={alreadyImportedAi}
        />
      ) : (
        <Space direction="vertical" size="large" className="page-stack">
          <Card title="人工手动 AI 分析流程">
        <Space wrap>
          <Button type="primary" disabled={!workspaceQuery.data.stories.length || !isSupportedDefaultBranch(workspaceQuery.data.batch.default_branch)} onClick={() => downloadAiTemplate(workspaceQuery.data.batch, workspaceQuery.data.stories)}>
            下载AI填写模板
          </Button>
          <Text type="secondary">如需人工分析，可下载模板；模板包含批次信息、需求评审、代码证据三个 Sheet。</Text>
        </Space>
      </Card>
      <Card title="AI填写规范（复制给AI）">
        <Typography.Paragraph copyable={{ text: aiFillPrompt }} className="prompt-block">
          {aiFillPrompt}
        </Typography.Paragraph>
        <Divider />
        <Text strong>交给AI的内容：</Text>
        <Row gutter={[16, 16]} className="ai-material-row">
          <Col xs={24} md={8}>
            <div className="ai-material-card">
              <div className="ai-material-index">1</div>
              <div>
                <Text strong>AI填写模板</Text>
                <div><Text type="secondary">下载后交给 AI 填写的 Excel 工作簿</Text></div>
              </div>
            </div>
          </Col>
          <Col xs={24} md={8}>
            <div className="ai-material-card">
              <div className="ai-material-index">2</div>
              <div>
                <Text strong>AI填写规范</Text>
                <div><Text type="secondary">上方可复制的固定填写要求和枚举约束</Text></div>
              </div>
            </div>
          </Col>
          <Col xs={24} md={8}>
            <div className="ai-material-card">
              <div className="ai-material-index">3</div>
              <div>
                <Text strong>待分析分支最新代码</Text>
                <div><Text type="secondary">指定分支/Commit 下允许分析的代码目录</Text></div>
              </div>
            </div>
          </Col>
        </Row>
      </Card>
      {alreadyImportedAi ? (
        <Alert
          type="info"
          showIcon
          title="本批次已完成 AI 结果导入"
          description="一个批次只能成功导入一次 AI 结果。如需重新导入，请删除当前批次后重新创建并导入。"
        />
      ) : (
        <>
          <Upload.Dragger
            accept=".xlsx,.xls"
            maxCount={1}
            disabled={readOnly || !isSupportedDefaultBranch(workspaceQuery.data.batch.default_branch)}
            beforeUpload={async (selectedFile) => {
              const result = await parseAiWorkbook(selectedFile, workspaceQuery.data.batch, workspaceQuery.data.stories)
              if (result.batchInfo.batch_id !== workspaceQuery.data.batch.id) {
                setFile(null)
                setParsed(null)
                modal.warning({
                  title: '导入文件与当前批次不一致',
                  content: `当前选择的 AI 分析文件不是由批次“${workspaceQuery.data.batch.name}”导出的模板生成。请先下载当前批次的 AI 填写模板，使用该模板完成 AI 分析后再重新导入。`,
                  okText: '重新选择文件',
                })
                return Upload.LIST_IGNORE
              }
              setFile(selectedFile)
              setParsed(result)
              return false
            }}
            onRemove={() => {
              setFile(null)
              setParsed(null)
            }}
          >
            <p>上传 AI 填写后的 Excel</p>
            <Text type="secondary">上传后先校验 batch_id、模板版本、原始字段、AI判断和代码证据。</Text>
          </Upload.Dragger>
          {parsed ? (
            <Row gutter={[16, 16]}>
              <Col span={24} lg={10}><IssuesCard issues={parsed.issues} /></Col>
              <Col span={24} lg={14}>
                <Card title="解析结果">
                  <Row gutter={16}>
                    <Col span={8}><Statistic title="AI结果" value={parsed.results.length} /></Col>
                    <Col span={8}><Statistic title="代码证据" value={parsed.evidence.length} /></Col>
                    <Col span={8}><Statistic title="错误" value={parsed.issues.filter((issue) => issue.level === 'error').length} /></Col>
                  </Row>
                  <Divider />
                  <Button type="primary" disabled={readOnly || hasErrors(parsed.issues)} loading={importMutation.isPending} onClick={() => importMutation.mutate()}>
                    确认导入AI结果
                  </Button>
                </Card>
              </Col>
            </Row>
          ) : null}
        </>
      )}
        </Space>
      )}
      <Card title="AI报告版本">
        <Table
          rowKey="id"
          loading={aiImportsQuery.isLoading}
          dataSource={aiImportsQuery.data ?? []}
          pagination={false}
          columns={[
            { title: '版本', dataIndex: 'version', width: 90, render: (version) => `V${version}` },
            { title: '生效状态', dataIndex: 'is_active', width: 120, render: (active) => active ? <Tag color="green">当前生效</Tag> : <Tag>历史版本</Tag> },
            {
              title: '来源',
              dataIndex: 'import_file_id',
              width: 110,
              render: (importFileId: string | null) =>
                importFileId ? <Tag color="blue">人工导入</Tag> : <Tag color="geekblue">AI 自动分析</Tag>,
            },
            { title: '分析基线', render: (_value, record) => <BaselineImportDetails aiImport={record} /> },
            { title: '导入时间', dataIndex: 'created_at', render: (value) => new Date(value).toLocaleString() },
            {
              title: '操作',
              width: 120,
              render: (_value, record) => (
                <Tooltip title={record.import_file_id ? '' : 'AI 自动分析结果无导出文件，下载不可用'}>
                  <Button
                    size="small"
                    disabled={!record.import_file?.storage_path}
                    onClick={() => record.import_file && downloadStorageFile(record.import_file.storage_path)}
                  >
                    下载文件
                  </Button>
                </Tooltip>
              ),
            },
          ]}
        />
      </Card>
    </Space>
  )
}

function ReviewListPage({ batchId }: { batchId: string }) {
  const [localColumnFilters, setLocalColumnFilters] = useState<Record<'storyCode' | 'storyName' | 'evidence' | 'humanStatus', string[] | null>>({
    storyCode: null,
    storyName: null,
    evidence: null,
    humanStatus: null,
  })
  const location = useLocation()
  const navigate = useNavigate()
  const workspaceQuery = useBatchWorkspace(batchId)
  const ownerOptions = useMemo(() => peopleFilterOptions(workspaceQuery.data?.stories, (story) => story.owners_text), [workspaceQuery.data])
  const requirementHandlerOptions = useMemo(() => peopleFilterOptions(workspaceQuery.data?.stories, (story) => story.requirement_handlers), [workspaceQuery.data])
  const testHandlerOptions = useMemo(() => peopleFilterOptions(workspaceQuery.data?.stories, (story) => story.test_handlers), [workspaceQuery.data])
  const statusOptions = useMemo(() => statusFilterOptions(workspaceQuery.data?.stories), [workspaceQuery.data])
  const getSingleSearchParam = (name: string) => {
    const values = new URLSearchParams(location.search).getAll(name)
    return values.length === 1 && values[0] ? values[0] : undefined
  }
  const verdictParam = getSingleSearchParam('verdict')
  const ownerParam = getSingleSearchParam('owner')
  const requirementHandlerParam = getSingleSearchParam('requirementHandler')
  const testHandlerParam = getSingleSearchParam('testHandler')
  const statusParam = getSingleSearchParam('status')
  const verdict = verdictParam && (
    verdictParam === 'UNANALYZED' || aiVerdictOptions.some((option) => option.value === verdictParam)
  ) ? verdictParam as AiVerdict | 'UNANALYZED' : undefined
  const owner = ownerParam && ownerOptions.some((option) => option.value === ownerParam) ? ownerParam : undefined
  const requirementHandler = requirementHandlerParam
    && requirementHandlerOptions.some((option) => option.value === requirementHandlerParam) ? requirementHandlerParam : undefined
  const testHandler = testHandlerParam
    && testHandlerOptions.some((option) => option.value === testHandlerParam) ? testHandlerParam : undefined
  const status = statusParam && statusOptions.some((option) => option.value === statusParam) ? statusParam : undefined
  const updateFilters = (changes: Partial<Record<GroupFilterKey | 'verdict', string | undefined>>) => {
    const searchParams = new URLSearchParams(location.search)
    Object.entries(changes).forEach(([name, value]) => {
      if (value) searchParams.set(name, value)
      else searchParams.delete(name)
    })
    const search = searchParams.toString()
    if (search === location.search.replace(/^\?/, '')) return
    navigate({ pathname: location.pathname, search: search ? `?${search}` : '' })
  }

  const rows = useMemo(() => {
    if (!workspaceQuery.data) return []
    const resultByStory = new Map(workspaceQuery.data.results.map((result) => [result.story_id, result]))
    const latestReviewByStory = new Map<string, BatchWorkspace['humanReviews'][number]>()
    workspaceQuery.data.humanReviews.forEach((review) => {
      const current = latestReviewByStory.get(review.story_id)
      if (!current || new Date(review.reviewed_at).getTime() > new Date(current.reviewed_at).getTime()) {
        latestReviewByStory.set(review.story_id, review)
      }
    })
    const evidenceCountByResult = new Map<string, number>()
    workspaceQuery.data.evidence.forEach((item) => evidenceCountByResult.set(item.ai_review_result_id, (evidenceCountByResult.get(item.ai_review_result_id) ?? 0) + 1))

    return workspaceQuery.data.stories.map((story) => {
      const result = resultByStory.get(story.id) ?? null
      const review = latestReviewByStory.get(story.id) ?? null
      return { story, result, review, evidenceCount: result ? evidenceCountByResult.get(result.id) ?? 0 : 0 }
    })
  }, [workspaceQuery.data])

  const toColumnFilters = (values: string[]) =>
    [...new Set(values)].sort((a, b) => a.localeCompare(b, 'zh-CN')).map((value) => ({ text: value, value }))
  const aiTagColors = { IMPLEMENTED: 'green', PARTIAL: 'orange', NOT_IMPLEMENTED: 'red', UNCERTAIN: 'default' }
  const humanTagColors = { CORRECT: 'green', PARTIALLY_CORRECT: 'orange', INCORRECT: 'red', NEED_DISCUSSION: 'purple' }
  const columns: ColumnsType<(typeof rows)[number]> = [
    {
      title: '编码',
      key: 'storyCode',
      dataIndex: ['story', 'story_code'],
      width: 150,
      filters: toColumnFilters(rows.map((row) => row.story.story_code)),
      filteredValue: localColumnFilters.storyCode,
      filterSearch: true,
      onFilter: (value, row) => row.story.story_code === String(value),
      render: (_value, row) => <Link className="review-story-code" to={`/batches/${batchId}/reviews/${row.story.id}`}>{row.story.story_code}</Link>,
    },
    {
      title: '需求名称',
      key: 'storyName',
      dataIndex: ['story', 'story_name'],
      width: 340,
      filters: toColumnFilters(rows.map((row) => row.story.story_name)),
      filteredValue: localColumnFilters.storyName,
      filterSearch: true,
      onFilter: (value, row) => row.story.story_name === String(value),
    },
    {
      title: '开发人员',
      key: 'owner',
      dataIndex: ['story', 'owners_text'],
      width: 190,
      filters: ownerOptions.map((option) => ({ text: option.label, value: option.value })),
      filteredValue: owner ? [owner] : null,
      filterSearch: true,
      filterMultiple: false,
      onFilter: (value, row) => splitPeople(row.story.owners_text).includes(String(value)),
      render: (value) => <PeopleTags value={value as string | null} />,
    },
    {
      title: '需求人员',
      key: 'requirementHandler',
      dataIndex: ['story', 'requirement_handlers'],
      width: 170,
      filters: requirementHandlerOptions.map((option) => ({ text: option.label, value: option.value })),
      filteredValue: requirementHandler ? [requirementHandler] : null,
      filterSearch: true,
      filterMultiple: false,
      onFilter: (value, row) => splitPeople(row.story.requirement_handlers).includes(String(value)),
      render: (value) => <PeopleTags value={value as string | null} />,
    },
    {
      title: '测试人员',
      key: 'testHandler',
      dataIndex: ['story', 'test_handlers'],
      width: 170,
      filters: testHandlerOptions.map((option) => ({ text: option.label, value: option.value })),
      filteredValue: testHandler ? [testHandler] : null,
      filterSearch: true,
      filterMultiple: false,
      onFilter: (value, row) => splitPeople(row.story.test_handlers).includes(String(value)),
      render: (value) => <PeopleTags value={value as string | null} />,
    },
    {
      title: '需求状态',
      key: 'status',
      dataIndex: ['story', 'source_status'],
      width: 140,
      filters: statusOptions.map((option) => ({ text: option.label, value: option.value })),
      filteredValue: status ? [status] : null,
      filterSearch: true,
      filterMultiple: false,
      onFilter: (value, row) => storyStatusName(row.story) === String(value),
      render: (_value, row) => <Tag>{storyStatusName(row.story)}</Tag>,
    },
    {
      title: 'AI判断',
      key: 'verdict',
      width: 120,
      filters: [
        ...aiVerdictOptions.map((option) => ({ text: option.label, value: option.value })),
        { text: '未分析', value: 'UNANALYZED' },
      ],
      filteredValue: verdict ? [verdict] : null,
      filterMultiple: false,
      onFilter: (value, row) => (row.result?.verdict ?? 'UNANALYZED') === String(value),
      render: (_value, row) => row.result?.verdict
        ? <Tag color={aiTagColors[row.result.verdict]}>{aiVerdictLabels[row.result.verdict]}</Tag>
        : <Tag>未分析</Tag>,
    },
    {
      title: '证据',
      key: 'evidence',
      width: 90,
      filters: [...new Set(rows.map((row) => row.evidenceCount))]
        .sort((a, b) => a - b)
        .map((count) => ({ text: `${count} 条`, value: String(count) })),
      filteredValue: localColumnFilters.evidence,
      onFilter: (value, row) => row.evidenceCount === Number(value),
      render: (_value, row) => <Tag color={row.evidenceCount ? 'geekblue' : 'default'}>{row.evidenceCount} 条</Tag>,
    },
    {
      title: '人工状态',
      key: 'humanStatus',
      width: 150,
      filters: [{ text: '待确认', value: 'pending' }, { text: '已确认', value: 'reviewed' }],
      filteredValue: localColumnFilters.humanStatus,
      filterMultiple: false,
      onFilter: (value, row) => value === 'reviewed' ? Boolean(row.review) : !row.review,
      render: (_value, row) => row.review
        ? <Tag color={humanTagColors[row.review.result]}>{humanReviewLabels[row.review.result]}</Tag>
        : <Tag color="gold">待确认</Tag>,
    },
  ]

  return (
    <Space direction="vertical" size="large" className="page-stack review-list-page">
      <Card className="review-table-card" bodyStyle={{ padding: 0 }}>
        <div className="review-table-inset">
          <Table
            rowKey={(row) => row.story.id}
            loading={workspaceQuery.isLoading}
            columns={columns}
            dataSource={rows}
            size="middle"
            scroll={{ x: 1520 }}
            pagination={{
              defaultPageSize: 10,
              showSizeChanger: true,
              pageSizeOptions: [10, 20, 50, 100],
              showTotal: (total, range) => `第 ${range[0]}-${range[1]} 条 / 共 ${total} 条`,
            }}
            onChange={(_pagination, filters, _sorter, extra) => {
              if (extra.action !== 'filter') return
              const normalize = (values: unknown) => Array.isArray(values) ? values.map(String) : null
              const storyCode = normalize(filters.storyCode)
              const storyName = normalize(filters.storyName)
              const evidence = normalize(filters.evidence)
              const humanStatus = normalize(filters.humanStatus)
              setLocalColumnFilters({ storyCode, storyName, evidence, humanStatus })
              updateFilters({
                owner: normalize(filters.owner)?.[0],
                requirementHandler: normalize(filters.requirementHandler)?.[0],
                testHandler: normalize(filters.testHandler)?.[0],
                status: normalize(filters.status)?.[0],
                verdict: normalize(filters.verdict)?.[0],
              })
            }}
          />
        </div>
      </Card>
    </Space>
  )
}

type ReviewDetail = {
  story: ReviewStory
  aiResult: AiReviewResult | null
  evidence: BatchWorkspace['evidence']
  humanReview: BatchWorkspace['humanReviews'][number] | null
  aiImport: BatchWorkspace['activeImport']
  nextStoryId: string | null
  reviewableIndex: number
  reviewableTotal: number
  readOnly: boolean
}

type HumanReviewFormValues = {
  result: HumanReviewResult
  comment: string
}

function ReviewDetailPage({ batchId, canManage }: { batchId: string; canManage: boolean }) {
  const { storyId } = useParams()
  const navigate = useNavigate()
  const workspaceQuery = useBatchWorkspace(batchId)

  const detail = useMemo<ReviewDetail | null>(() => {
    if (!workspaceQuery.data || !storyId) return null
    const story = workspaceQuery.data.stories.find((item) => item.id === storyId)
    if (!story) return null

    const resultByStory = new Map(workspaceQuery.data.results.filter((result) => result.verdict).map((result) => [result.story_id, result]))
    const latestReviewByStory = new Map<string, BatchWorkspace['humanReviews'][number]>()
    workspaceQuery.data.humanReviews.forEach((review) => {
      const current = latestReviewByStory.get(review.story_id)
      if (!current || new Date(review.reviewed_at).getTime() > new Date(current.reviewed_at).getTime()) {
        latestReviewByStory.set(review.story_id, review)
      }
    })

    const aiResult = resultByStory.get(story.id) ?? null
    const evidence = aiResult ? workspaceQuery.data.evidence.filter((item) => item.ai_review_result_id === aiResult.id) : []
    const humanReview = latestReviewByStory.get(story.id) ?? null
    const reviewableStories = workspaceQuery.data.stories.filter((item) => resultByStory.has(item.id))
    const reviewableIndex = reviewableStories.findIndex((item) => item.id === story.id)
    const unreviewedStories = [...reviewableStories.slice(reviewableIndex + 1), ...reviewableStories.slice(0, reviewableIndex)]
    const nextStoryId = unreviewedStories.find((item) => !latestReviewByStory.has(item.id))?.id ?? null

    return {
      story,
      aiResult,
      evidence,
      humanReview,
      aiImport: workspaceQuery.data.activeImport,
      nextStoryId,
      reviewableIndex,
      reviewableTotal: reviewableStories.length,
      readOnly: !canManage || workspaceQuery.data.batch.status === 'COMPLETED',
    }
  }, [canManage, storyId, workspaceQuery.data])

  if (workspaceQuery.isLoading) return <Spin />
  if (!detail) return <Empty description="需求不存在" />

  return (
    <div className="review-detail-page">
      <section className="review-detail-context">
        <div>
          <Button type="link" className="review-detail-back" onClick={() => navigate(`/batches/${batchId}/reviews`)}>← 返回评审列表</Button>
          <div className="review-detail-title-row">
            <Text className="review-detail-code">{detail.story.story_code}</Text>
            {detail.aiResult?.verdict ? <Tag color={aiVerdictColor(detail.aiResult.verdict)}>{aiVerdictLabels[detail.aiResult.verdict]}</Tag> : <Tag>未分析</Tag>}
            {detail.humanReview ? <Tag color={humanVerdictColor(detail.humanReview.result)}>{humanReviewLabels[detail.humanReview.result]}</Tag> : <Tag color="gold">待确认</Tag>}
          </div>
          <Title level={4}>{detail.story.story_name}</Title>
        </div>
        <Text type="secondary">第 {detail.reviewableIndex >= 0 ? detail.reviewableIndex + 1 : 0} / {detail.reviewableTotal} 条可评审需求</Text>
      </section>

      <div className="review-detail-grid">
        <div className="review-detail-story"><StoryCard story={detail.story} /></div>
        <div className="review-detail-ai"><AiResultCard result={detail.aiResult} evidence={detail.evidence} aiImport={detail.aiImport} /></div>
        <div className="review-detail-decision">
          <HumanReviewPanel key={`${detail.story.id}-${detail.aiResult?.id ?? 'no-ai'}`} batchId={batchId} detail={detail} />
        </div>
      </div>
    </div>
  )
}

function HumanReviewPanel({ batchId, detail }: { batchId: string; detail: ReviewDetail }) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { message } = AntApp.useApp()
  const [form] = Form.useForm<HumanReviewFormValues>()
  const reviewIdentity = `${detail.story.id}-${detail.aiResult?.id ?? 'no-ai'}`
  const saveMutation = useMutation({
    mutationFn: async ({ values, goNext }: { values: HumanReviewFormValues; goNext: boolean }) => {
      if (!detail.aiResult) throw new Error('当前需求还没有AI结果，不能提交人工结论')
      await saveHumanReview(detail.story.id, detail.aiResult.id, values.result, values.comment || null)
      return goNext
    },
    onSuccess: async (goNext) => {
      message.success('人工结论已保存')
      await queryClient.refetchQueries({ queryKey: ['batch-workspace', batchId] })
      if (goNext) {
        navigate(detail.nextStoryId ? `/batches/${batchId}/reviews/${detail.nextStoryId}` : `/batches/${batchId}/reviews`)
      }
    },
    onError: (error) => message.error(error.message),
  })

  useEffect(() => {
    form.setFieldsValue({
      result: detail.humanReview?.result ?? 'CORRECT',
      comment: detail.humanReview?.comment ?? '',
    })
  }, [detail.humanReview?.comment, detail.humanReview?.result, form, reviewIdentity])

  const submit = async (goNext: boolean) => {
    const values = await form.validateFields()
    saveMutation.mutate({ values, goNext })
  }

  return (
    <Card className="review-decision-card" title="人工结论">
      <Space direction="vertical" className="page-stack">
        {detail.readOnly ? <Alert type="warning" showIcon title="当前页面只读" description="批次已完成，或当前账号不是该批次的管理员或创建者。" /> : null}
        {detail.aiResult ? (
          <>
            <div className="review-decision-context">
              <Text type="secondary">AI 原判断</Text>
              <Tag color={aiVerdictColor(detail.aiResult.verdict)}>{detail.aiResult.verdict ? aiVerdictLabels[detail.aiResult.verdict] : '未分析'}</Tag>
              {detail.humanReview ? <Text type="secondary">上次保存：{new Date(detail.humanReview.reviewed_at).toLocaleString()}</Text> : null}
            </div>
            <Form form={form} layout="vertical" disabled={detail.readOnly}>
              <Form.Item name="result" label="核验结论" rules={[{ required: true, message: '请选择人工结论' }]}>
                <Radio.Group className="review-decision-options">
                  {humanReviewOptions.map((option) => (
                    <Radio key={option.value} value={option.value} className="review-decision-option">{option.label}</Radio>
                  ))}
                </Radio.Group>
              </Form.Item>
              <Form.Item name="comment" label="补充意见">
                <Input.TextArea rows={6} placeholder="记录需要补充、修正或讨论的内容" />
              </Form.Item>
            </Form>
            <div className="review-decision-actions">
              <Button block disabled={detail.readOnly} loading={saveMutation.isPending} onClick={() => submit(false)}>保存</Button>
              <Button type="primary" block disabled={detail.readOnly} loading={saveMutation.isPending} onClick={() => submit(true)}>
                {detail.nextStoryId ? '保存并下一条' : '保存并返回列表'}
              </Button>
            </div>
          </>
        ) : <Alert type="info" showIcon title="当前需求缺少AI结果" description="请先在AI结果管理中上传本批次结果。" />}
      </Space>
    </Card>
  )
}

function DashboardPage({ batchId, canManage }: { batchId: string; canManage: boolean }) {
  const workspaceQuery = useBatchWorkspace(batchId)
  const queryClient = useQueryClient()
  const { message, modal } = AntApp.useApp()
  const completeMutation = useMutation({
    mutationFn: (force: boolean) => completeBatch(batchId, force),
    onSuccess: (pendingCount) => {
      message.success(pendingCount > 0 ? `已强制完成，仍有 ${pendingCount} 条未确认` : '批次已完成')
      queryClient.invalidateQueries({ queryKey: ['batch-workspace', batchId] })
      queryClient.invalidateQueries({ queryKey: ['batch', batchId] })
      queryClient.invalidateQueries({ queryKey: ['batches'] })
      queryClient.invalidateQueries({ queryKey: ['operation-log'] })
    },
    onError: (error) => {
      modal.confirm({
        title: '仍有未确认需求',
        content: `${error.message}。是否强制完成批次？`,
        onOk: () => completeMutation.mutate(true),
      })
    },
  })
  const reopenMutation = useMutation({
    mutationFn: () => reopenBatch(batchId),
    onSuccess: () => {
      message.success('批次已重新打开')
      queryClient.invalidateQueries({ queryKey: ['batch-workspace', batchId] })
      queryClient.invalidateQueries({ queryKey: ['batch', batchId] })
      queryClient.invalidateQueries({ queryKey: ['batches'] })
      queryClient.invalidateQueries({ queryKey: ['operation-log'] })
    },
    onError: (error) => message.error(error.message),
  })

  if (workspaceQuery.isLoading) return <Spin />
  if (!workspaceQuery.data) return <Empty />

  const { batch, activeImport } = workspaceQuery.data
  const stats = buildStats(workspaceQuery.data)
  const aiItems: DistributionItem[] = [
    { label: aiVerdictLabels.IMPLEMENTED, value: stats.aiDistribution.IMPLEMENTED, color: '#16a34a', to: `/batches/${batchId}/reviews?verdict=IMPLEMENTED` },
    { label: aiVerdictLabels.PARTIAL, value: stats.aiDistribution.PARTIAL, color: '#f59e0b', to: `/batches/${batchId}/reviews?verdict=PARTIAL` },
    { label: aiVerdictLabels.NOT_IMPLEMENTED, value: stats.aiDistribution.NOT_IMPLEMENTED, color: '#ef4444', to: `/batches/${batchId}/reviews?verdict=NOT_IMPLEMENTED` },
    { label: aiVerdictLabels.UNCERTAIN, value: stats.aiDistribution.UNCERTAIN, color: '#64748b', to: `/batches/${batchId}/reviews?verdict=UNCERTAIN` },
  ]
  const humanItems: DistributionItem[] = [
    { label: humanReviewLabels.CORRECT, value: stats.humanDistribution.CORRECT, color: '#16a34a' },
    { label: humanReviewLabels.PARTIALLY_CORRECT, value: stats.humanDistribution.PARTIALLY_CORRECT, color: '#f59e0b' },
    { label: humanReviewLabels.INCORRECT, value: stats.humanDistribution.INCORRECT, color: '#ef4444' },
    { label: humanReviewLabels.NEED_DISCUSSION, value: stats.humanDistribution.NEED_DISCUSSION, color: '#7c3aed' },
  ]

  return (
    <div className="dashboard-page">
      <section className="dashboard-hero">
        <div>
          <div className="dashboard-eyebrow">评审进度概览</div>
          <Title level={3}>本批次完成度</Title>
          <Space wrap className="dashboard-hero__meta">
            <Tag color={statusColor(batch.status)}>{batchStatusLabels[batch.status]}</Tag>
            {activeImport ? <Text type="secondary">AI 报告 V{activeImport.version}</Text> : <Text type="secondary">尚未导入 AI 报告</Text>}
          </Space>
          {activeImport ? <BaselineImportDetails aiImport={activeImport} /> : null}
        </div>
        {canManage ? (
          <div className="dashboard-hero__actions">
            {batch.status === 'COMPLETED' ? (
              <Button size="large" loading={reopenMutation.isPending} onClick={() => reopenMutation.mutate()}>重新打开批次</Button>
            ) : (
              <Tooltip title="完成前会检查待确认项">
                <Button type="primary" size="large" loading={completeMutation.isPending} onClick={() => completeMutation.mutate(false)}>完成批次</Button>
              </Tooltip>
            )}
          </div>
        ) : null}
      </section>

      <Row gutter={[12, 12]}>
        <Col xs={24} md={8}>
          <Card className="dashboard-kpi-card dashboard-kpi-card--neutral">
            <Statistic title="需求总数" value={stats.total} />
            <div className="dashboard-kpi-footer"><Text type="secondary">待 AI 分析 {stats.pendingAi} 条</Text></div>
          </Card>
        </Col>
        <Col xs={24} md={8}>
          <Card className="dashboard-kpi-card dashboard-kpi-card--ai">
            <Statistic title="AI 已分析" value={stats.aiDone} suffix={`/ ${stats.total}`} />
            <div className="dashboard-kpi-footer">
              <Progress percent={percentage(stats.aiDone, stats.total)} showInfo={false} strokeColor="#2563eb" size="small" />
              <Text type="secondary">覆盖率 {percentage(stats.aiDone, stats.total)}%</Text>
            </div>
          </Card>
        </Col>
        <Col xs={24} md={8}>
          <Card className="dashboard-kpi-card dashboard-kpi-card--review">
            <Statistic title="人工已确认" value={stats.reviewed} suffix={`/ ${stats.aiDone}`} />
            <div className="dashboard-kpi-footer">
              <Progress percent={percentage(stats.reviewed, stats.aiDone)} showInfo={false} strokeColor="#16a34a" size="small" />
              <Text type="secondary">待确认 {stats.pendingReview} 条</Text>
            </div>
          </Card>
        </Col>
      </Row>

      <Row gutter={[12, 12]}>
        <Col xs={24} lg={12}><DistributionCard title="AI 判断分布" items={aiItems} total={stats.aiDone} /></Col>
        <Col xs={24} lg={12}><DistributionCard title="人工结论分布" items={humanItems} total={stats.reviewed} /></Col>
      </Row>

      {/*
        分组卡片用 CSS Grid 而不是 Ant Row/Col：各维度行数差得很多（状态维度可能只有 2 行，
        人员维度十几行），Row 里的 Col 各自按内容高度撑开，同排两张卡片底边会错开一大段空白。
        Grid 的同一行天然等高，配合卡片内部的滚动区，四张卡片底边始终对齐。
      */}
      <div className="dashboard-group-grid">
        <GroupedProgress title="按需求状态统计" rows={stats.byStatus} batchId={batchId} filterKey="status" note="需求在源系统里的状态" />
        <GroupedProgress title="按开发人员统计" rows={stats.byOwner} batchId={batchId} filterKey="owner" note="协作需求按开发人员分别计入" />
        <GroupedProgress title="按需求人员统计" rows={stats.byRequirementHandler} batchId={batchId} filterKey="requirementHandler" />
        <GroupedProgress title="按测试人员统计" rows={stats.byTestHandler} batchId={batchId} filterKey="testHandler" />
      </div>
    </div>
  )
}

type OperationLogScope = 'batch' | 'model'

const modelAuditFieldLabels: Record<string, string> = {
  display_name: '模型名称',
  base_url: 'Base URL',
  model_name: 'Model',
  max_parallel_tasks: '最大并发需求数',
  request_timeout_ms: '平台请求超时',
  context_window: '上下文窗口',
  max_output_tokens: '单次最大输出',
  // 这三列在新建模型时会入本审计表；之后只能由「默认能力策略」页改动，
  // 那条路径记的是 v4_capability_policy_audit，不会出现在这里。
  agent_max_model_requests: '模型请求上限（仅旧 Job 兜底）',
  agent_max_retry_requests: '重试请求上限',
  agent_max_compaction_requests: '压缩请求上限',
  retrieval_prompt_version: '检索提示词版本',
  analysis_prompt_version: '分析提示词版本',
  enabled: '启用状态',
  api_key: 'API Key',
}

function formatModelAuditValue(field: string, value: unknown) {
  if (value === null || value === undefined) return '-'
  if (field === 'enabled' && typeof value === 'boolean') return value ? '启用' : '停用'
  if (field === 'request_timeout_ms' && typeof value === 'number') return `${Math.round(value / 1000)} 秒`
  return String(value)
}

function OperationLogPage({ scope, isAdmin = false }: { scope: OperationLogScope; isAdmin?: boolean }) {
  const canRead = scope === 'batch' || isAdmin
  const operationLogQuery = useQuery({
    queryKey: ['operation-log', scope],
    queryFn: listOperationLogs,
    enabled: canRead,
  })
  const modelNameById = useModelDisplayNameMap(scope === 'model' && isAdmin)

  if (!canRead) {
    return <Alert type="warning" showIcon title="无权限访问" description="只有管理员可以查看模型操作日志。" />
  }

  const logs = operationLogQuery.data ?? []
  const sourceLogs = logs.filter((record) => scope === 'model'
    ? ['MODEL_DISPLAY_NAME_UPDATED', 'MODEL_CONFIG_CREATED', 'MODEL_CONFIG_UPDATED', 'MODEL_CONFIG_DELETED'].some((action) => action === record.action)
    : ['BATCH_CREATED', 'BATCH_DELETED', 'COMPLETE', 'REOPEN'].some((action) => action === record.action))
  const getBatchObjectLabel = (record: BatchOperationLogWithBatch) =>
    record.review_batch?.name ?? record.batch_name_snapshot ?? '批次已删除'
  const getBatchWeekCode = (record: BatchOperationLogWithBatch) =>
    record.review_batch?.week_code ?? record.batch_week_code_snapshot ?? '-'
  const getModelLabel = (record: BatchOperationLogWithBatch) => {
    const currentName = record.model_config_id ? modelNameById.get(record.model_config_id) : null
    return record.model_display_name_snapshot
      ?? currentName
      ?? record.new_model_display_name
      ?? record.old_model_display_name
      ?? '未知模型'
  }
  const getActionLabel = (record: BatchOperationLogWithBatch) => {
    if (record.action === 'BATCH_CREATED') return '创建代码评审'
    if (record.action === 'BATCH_DELETED') return '删除代码评审'
    if (record.action === 'COMPLETE') return '完成批次'
    if (record.action === 'REOPEN') return '重新打开'
    if (record.action === 'MODEL_CONFIG_CREATED') return '创建模型'
    if (record.action === 'MODEL_CONFIG_UPDATED') return '修改模型配置'
    if (record.action === 'MODEL_CONFIG_DELETED') return '删除模型'
    return '修改模型名称'
  }
  const getActionColor = (record: BatchOperationLogWithBatch) => {
    if (record.action === 'BATCH_CREATED') return 'blue'
    if (record.action === 'BATCH_DELETED') return 'red'
    if (record.action === 'COMPLETE') return 'green'
    if (record.action === 'REOPEN') return 'gold'
    if (record.action === 'MODEL_CONFIG_CREATED') return 'cyan'
    if (record.action === 'MODEL_CONFIG_UPDATED') return 'purple'
    if (record.action === 'MODEL_CONFIG_DELETED') return 'red'
    return 'geekblue'
  }
  const getOperatorLabel = (record: BatchOperationLogWithBatch) =>
    record.performed_by_display_name ?? record.performed_by ?? '-'
  const getOperationDate = (record: BatchOperationLogWithBatch) =>
    new Date(record.created_at).toLocaleDateString()
  const getModelChangeDescription = (record: BatchOperationLogWithBatch) => {
    const changedFields = record.changed_fields ?? []
    if (!changedFields.length) return '模型配置已更新'
    return changedFields.map((field) => {
      const label = modelAuditFieldLabels[field] ?? field
      if (field === 'api_key') {
        return record.action === 'MODEL_CONFIG_CREATED' ? `${label}：已配置` : `${label}：已轮换`
      }
      if (field === 'base_url') {
        return record.action === 'MODEL_CONFIG_CREATED' ? `${label}：已配置` : `${label}：已修改`
      }
      const nextValue = formatModelAuditValue(field, record.new_values?.[field])
      if (record.action === 'MODEL_CONFIG_CREATED') return `${label}：${nextValue}`
      const previousValue = formatModelAuditValue(field, record.old_values?.[field])
      return `${label}：${previousValue} → ${nextValue}`
    }).join('；')
  }
  const getDescription = (record: BatchOperationLogWithBatch) => {
    if (record.action === 'BATCH_CREATED') return '已创建代码评审批次'
    if (record.action === 'BATCH_DELETED') return '已删除代码评审批次及其关联数据'
    if (record.action === 'COMPLETE') {
      return record.forced ? `强制完成，当时仍有 ${record.pending_count ?? 0} 条未确认` : '正常完成'
    }
    if (record.action === 'REOPEN') return '批次已重新打开'
    if (record.action === 'MODEL_CONFIG_DELETED') return '模型配置已删除'
    if (record.action === 'MODEL_DISPLAY_NAME_UPDATED') {
      return `模型名称：${record.old_model_display_name ?? '-'} → ${record.new_model_display_name ?? '-'}`
    }
    return getModelChangeDescription(record)
  }
  const toColumnFilters = (values: string[]) =>
    [...new Set(values)].sort((a, b) => a.localeCompare(b, 'zh-CN')).map((value) => ({ text: value, value }))
  const createCommonColumns = (
    source: BatchOperationLogWithBatch[],
  ): ColumnsType<BatchOperationLogWithBatch> => [
    {
      title: '操作',
      width: 160,
      filters: toColumnFilters(source.map(getActionLabel)),
      onFilter: (value, record) => getActionLabel(record) === String(value),
      render: (_value, record) => <Tag color={getActionColor(record)}>{getActionLabel(record)}</Tag>,
    },
    {
      title: '操作人',
      width: 180,
      filters: toColumnFilters(source.map(getOperatorLabel)),
      filterSearch: true,
      onFilter: (value, record) => getOperatorLabel(record) === String(value),
      render: (_value, record) => getOperatorLabel(record),
    },
    {
      title: '操作时间',
      dataIndex: 'created_at',
      width: 200,
      filters: toColumnFilters(source.map(getOperationDate)),
      onFilter: (value, record) => getOperationDate(record) === String(value),
      render: (value) => new Date(value).toLocaleString(),
    },
    {
      title: '说明',
      minWidth: 320,
      filters: toColumnFilters(source.map(getDescription)),
      filterSearch: true,
      onFilter: (value, record) => getDescription(record) === String(value),
      render: (_value, record) => <Text type="secondary">{getDescription(record)}</Text>,
    },
  ]
  const batchColumns: ColumnsType<BatchOperationLogWithBatch> = [
    {
      title: '评审描述',
      width: 260,
      filters: toColumnFilters(sourceLogs.map(getBatchObjectLabel)),
      filterSearch: true,
      onFilter: (value, record) => getBatchObjectLabel(record) === String(value),
      render: (_value, record) => record.review_batch
        ? <Link to={`/batches/${record.review_batch.id}/dashboard`}>{record.review_batch.name}</Link>
        : (
          <Space size={6}>
            <Text>{record.batch_name_snapshot ?? '批次已删除'}</Text>
            <Tag color="red">已删除</Tag>
          </Space>
        ),
    },
    {
      title: '发布周期',
      width: 140,
      filters: toColumnFilters(sourceLogs.map(getBatchWeekCode)),
      filterSearch: true,
      onFilter: (value, record) => getBatchWeekCode(record) === String(value),
      render: (_value, record) => getBatchWeekCode(record),
    },
    ...createCommonColumns(sourceLogs),
  ]
  const modelColumns: ColumnsType<BatchOperationLogWithBatch> = [
    {
      title: '模型',
      width: 260,
      filters: toColumnFilters(sourceLogs.map(getModelLabel)),
      filterSearch: true,
      onFilter: (value, record) => getModelLabel(record) === String(value),
      render: (_value, record) => <Text>{getModelLabel(record)}</Text>,
    },
    ...createCommonColumns(sourceLogs),
  ]
  const pagination = {
    pageSize: 10,
    showSizeChanger: false,
    showTotal: (total: number) => `共 ${total} 条`,
  }

  const isModelScope = scope === 'model'
  const columns = isModelScope ? modelColumns : batchColumns
  const pageTitle = isModelScope ? '模型操作日志' : '代码评审操作日志'
  const emptyText = isModelScope ? '暂无模型配置操作日志' : '暂无代码评审操作日志'

  return (
    <Space direction="vertical" size="large" className="page-stack">
      <PageTitle title={pageTitle} />
      <Card className="dashboard-card dashboard-log-card">
        <Table
          rowKey="id"
          loading={operationLogQuery.isLoading}
          columns={columns}
          dataSource={sourceLogs}
          locale={{ emptyText }}
          pagination={pagination}
          scroll={{ x: isModelScope ? 1200 : 1150 }}
        />
      </Card>
    </Space>
  )
}

function StoryCard({ story }: { story: ReviewStory }) {
  const metadata = [
    { label: '开发人员', value: story.owners_text },
    { label: '需求人员', value: story.requirement_handlers },
    { label: '测试人员', value: story.test_handlers },
    { label: '关联特性', value: story.project_name },
    { label: '发布窗口', value: story.release_window },
    { label: '需求状态', value: story.source_status },
  ].filter((item) => item.value)

  return (
    <Card className="review-story-card" title="需求信息">
      <div className="review-story-code-block">{story.story_code}</div>
      <Title level={5} className="review-story-name">{story.story_name}</Title>
      <div className="review-story-metadata">
        {metadata.map((item) => <Tag key={item.label}>{item.label}：{item.value}</Tag>)}
      </div>
      {story.description ? <div className="review-story-detail"><Text strong>需求描述</Text><Text>{story.description}</Text></div> : null}
      {story.acceptance_criteria ? <div className="review-story-detail"><Text strong>验收标准</Text><Text>{story.acceptance_criteria}</Text></div> : null}
    </Card>
  )
}

function AiResultCard({ result, evidence, aiImport }: { result: AiReviewResult | null; evidence: BatchWorkspace['evidence']; aiImport: BatchWorkspace['activeImport'] }) {
  if (!result) return <Card className="review-ai-card" title="AI分析"><Empty description="未分析" /></Card>

  const sections = [
    { title: '已实现内容', value: result.implemented_content, tone: 'success' },
    { title: '缺失内容', value: result.missing_content, tone: 'warning' },
    { title: '风险', value: result.risks, tone: 'danger' },
    { title: '建议测试点', value: result.test_points, tone: 'info' },
    { title: 'AI 备注', value: result.ai_remark, tone: 'neutral' },
  ].filter((section) => section.value)
  const evidenceGroups = ['现有实现', '缺失依据', '风险依据'].map((type) => ({
    type,
    items: evidence.filter((item) => item.evidence_type === type),
  })).filter((group) => group.items.length)

  return (
    <Card className="review-ai-card" title="AI分析">
      <div className="review-ai-summary">
        <div>
          <Text type="secondary">AI 判断</Text>
          <div className="review-ai-verdict"><Tag color={aiVerdictColor(result.verdict)}>{result.verdict ? aiVerdictLabels[result.verdict] : '未分析'}</Tag></div>
        </div>
        <div className="review-ai-confidence">
          <Text type="secondary">置信度</Text>
          {result.confidence === null ? <Text type="secondary">未填写</Text> : <><Progress percent={result.confidence} showInfo={false} size="small" strokeColor="#2563eb" /><Text>{result.confidence}%</Text></>}
        </div>
        {aiImport ? <div className="review-ai-baseline"><Text type="secondary">分析基线</Text><BaselineImportDetails aiImport={aiImport} /></div> : null}
      </div>

      <div className="review-ai-highlight">
        <Text strong>分析摘要</Text>
        <Text>{result.summary || '暂无摘要'}</Text>
      </div>

      <div className="review-ai-details">
        <div className="review-ai-details__heading">
          <Text strong>分析详情</Text>
          <Text type="secondary">切换页签查看各项结论</Text>
        </div>
        <Tabs
          className="review-ai-tabs"
          size="small"
          items={sections.map((section) => ({
            key: section.title,
            label: (
              <span className="review-ai-tab-label">
                <span className={`review-ai-tab-dot review-ai-tab-dot--${section.tone}`} />
                {section.title}
              </span>
            ),
            children: (
              <section className={`review-ai-tab-panel review-ai-tab-panel--${section.tone}`}>
                <Text>{section.value}</Text>
              </section>
            ),
          }))}
        />
      </div>

      <Divider />
      <div className="review-evidence-heading"><Text strong>代码证据</Text><Text type="secondary">{evidence.length} 条</Text></div>
      {evidenceGroups.length ? evidenceGroups.map((group) => (
        <section key={group.type} className="review-evidence-group">
          <Tag color={evidenceTypeColor(group.type)}>{group.type}</Tag>
          {group.items.map((item) => (
            <div key={item.id} className="review-evidence-item">
              <div className="review-evidence-item__title"><Text strong>{item.repository_name}</Text><Text className="evidence-title">{item.file_path}</Text></div>
              <div className="review-evidence-item__meta">
                {item.commit_sha ? <Tag>{item.commit_sha.slice(0, 8)}</Tag> : null}
                {item.symbol_name ? <Tag>{item.symbol_name}</Tag> : null}
                {item.start_line ? <Text type="secondary">{item.start_line}{item.end_line ? ` - ${item.end_line}` : ''} 行</Text> : null}
              </div>
              <Text type="secondary" className="evidence-description">{item.description}</Text>
            </div>
          ))}
        </section>
      )) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无代码证据" />}
    </Card>
  )
}

function IssuesCard({ issues }: { issues: ValidationIssue[] }) {
  return (
    <Card title="校验结果">
      {issues.length ? (
        <List
          size="small"
          dataSource={issues}
          renderItem={(issue) => (
            <List.Item>
              <Tag color={issueColor(issue.level)}>{issue.level}</Tag>
              <Text>{issue.row ? `第 ${issue.row} 行：` : ''}{issue.message}</Text>
            </List.Item>
          )}
        />
      ) : <Alert type="success" showIcon title="校验通过" />}
    </Card>
  )
}

function PageTitle({ title, extra }: { title: string; extra?: ReactNode }) {
  return (
    <div className="page-title">
      <Title level={2}>{title}</Title>
      {extra}
    </div>
  )
}

type DashboardGroup = {
  name: string
  total: number
  aiDone: number
  reviewed: number
  pendingAi: number
  pendingReview: number
}

type DistributionItem = {
  label: string
  value: number
  color: string
  to?: string
}

/**
 * 人员列可能是「张烨,肖洋,尹昱杰」这种多人串，列表筛选和看板分组都要按单人拆。
 * 拆不出任何人时归到「未分配」，这样看板不会漏掉这批需求。
 * 需求人员 / 测试人员在历史批次里是 null，同样落到「未分配」。
 */
function splitPeople(peopleText: string | null | undefined) {
  const people = (peopleText ?? '').split(/[，,、；;]/).map((name) => name.trim()).filter(Boolean)
  return [...new Set(people.length ? people : ['未分配'])]
}

function PeopleTags({ value }: { value: string | null }) {
  return <Space size={[4, 4]} wrap>{splitPeople(value).map((name) => <Tag key={name}>{name}</Tag>)}</Space>
}

/** 把某个人员列拆成去重排序后的列筛选项。三个人员维度共用一套逻辑。 */
function peopleFilterOptions(stories: ReviewStory[] | undefined, pick: (story: ReviewStory) => string | null) {
  const names = new Set<string>()
  stories?.forEach((story) => splitPeople(pick(story)).forEach((name) => names.add(name)))
  return [...names].sort((a, b) => a.localeCompare(b, 'zh-CN')).map((name) => ({ value: name, label: name }))
}

/**
 * 需求状态的分组名。状态是单值，不做拆分。
 * 源系统没给状态时归到「未填写状态」，这样看板分组的合计始终等于需求总数。
 */
function storyStatusName(story: ReviewStory) {
  return story.source_status?.trim() || '未填写状态'
}

function statusFilterOptions(stories: ReviewStory[] | undefined) {
  const names = new Set<string>()
  stories?.forEach((story) => names.add(storyStatusName(story)))
  return [...names].sort((a, b) => a.localeCompare(b, 'zh-CN')).map((name) => ({ value: name, label: name }))
}

function BaselineMetaChip({ label, value, tone, mono = false }: { label: string; value: string; tone?: 'warning'; mono?: boolean }) {
  return (
    <span className={`baseline-chip${tone ? ` baseline-chip--${tone}` : ''}`}>
      <span className="baseline-chip__label">{label}</span>
      <span className={`baseline-chip__value${mono ? ' baseline-chip__value--mono' : ''}`}>{value}</span>
    </span>
  )
}

function BaselineCommitChips({ metadata }: { metadata: BaselineCommit }) {
  if (!metadata.commits.length) return null

  return (
    <div className="baseline-meta__row">
      {metadata.commits.map((commit) => (
        <Tooltip key={`${commit.repository}-${commit.sha}`} title={commit.subject ? `${commit.sha}\n${commit.subject}` : commit.sha}>
          <span>
            <BaselineMetaChip label={commit.repository} value={commit.sha.slice(0, 8)} mono />
          </span>
        </Tooltip>
      ))}
    </div>
  )
}

function BaselineImportDetails({ aiImport }: { aiImport: AiImportRecord }) {
  const modelNameById = useModelDisplayNameMap()
  const metadata = parseBaselineCommit(aiImport.baseline_commit)
  // 现在只会分析批次选定的那个分支，所以配置分支就是分析分支，只展示一个。
  // 历史数据里 AI 报告的 actual_branch 可能与配置不一致，这时标黄并在 tooltip 里说明。
  const analyzedBranch = aiImport.baseline_branch || metadata?.actual_branch || '-'
  const branchMismatch = Boolean(metadata && aiImport.baseline_branch && metadata.actual_branch !== aiImport.baseline_branch)
  const currentModelName = aiImport.ai_model_config_id
    ? modelNameById.get(aiImport.ai_model_config_id)
    : null

  return (
    <div className="baseline-meta">
      <div className="baseline-meta__row">
        {branchMismatch ? (
          <Tooltip title={`AI 报告填写的实际分支是 ${metadata?.actual_branch}，与批次配置的 ${aiImport.baseline_branch} 不一致`}>
            <span><BaselineMetaChip label="分析分支" value={analyzedBranch} tone="warning" /></span>
          </Tooltip>
        ) : (
          <BaselineMetaChip label="分析分支" value={analyzedBranch} />
        )}
        <BaselineMetaChip label="模型" value={currentModelName ?? aiImport.ai_model ?? '-'} />
        <BaselineMetaChip label="分析时间" value={aiImport.analyzed_at ? new Date(aiImport.analyzed_at).toLocaleString() : '-'} />
      </div>
      {metadata ? (
        <BaselineCommitChips metadata={metadata} />
      ) : aiImport.baseline_commit ? (
        <Text type="secondary" className="baseline-meta__raw">{aiImport.baseline_commit}</Text>
      ) : null}
    </div>
  )
}

function percentage(value: number, total: number) {
  return total ? Math.round((value / total) * 100) : 0
}

function aiVerdictColor(verdict: AiReviewResult['verdict']) {
  if (verdict === 'IMPLEMENTED') return 'green'
  if (verdict === 'PARTIAL') return 'orange'
  if (verdict === 'NOT_IMPLEMENTED') return 'red'
  return 'default'
}

function humanVerdictColor(verdict: HumanReviewResult) {
  if (verdict === 'CORRECT') return 'green'
  if (verdict === 'PARTIALLY_CORRECT') return 'orange'
  if (verdict === 'INCORRECT') return 'red'
  return 'purple'
}

function evidenceTypeColor(type: string) {
  if (type === '现有实现') return 'green'
  if (type === '缺失依据') return 'orange'
  return 'red'
}

function DistributionCard({ title, items, total }: { title: string; items: DistributionItem[]; total: number }) {
  return (
    <Card className="dashboard-card dashboard-distribution-card" title={title}>
      <div className="dashboard-distribution-grid">
        {items.map((item) => {
          const content = (
            <>
              <Text type="secondary" className="dashboard-distribution-label">{item.label}</Text>
              <div className="dashboard-distribution-value">{item.value}</div>
              <Text type="secondary" className="dashboard-distribution-percent">{percentage(item.value, total)}%</Text>
            </>
          )
          const style = { borderInlineStartColor: item.color }
          return item.to ? (
            <Link key={item.label} to={item.to} className="dashboard-distribution-item" style={style} aria-label={`查看${item.label}的评审列表（${item.value} 条）`}>
              {content}
            </Link>
          ) : (
            <div key={item.label} className="dashboard-distribution-item" style={style}>
              {content}
            </div>
          )
        })}
      </div>
    </Card>
  )
}

/** 看板分组卡片可下钻的维度，同时也是评审列表页的 URL 筛选参数名。 */
type GroupFilterKey = 'owner' | 'requirementHandler' | 'testHandler' | 'status'

/**
 * 分组进度列表。
 *
 * 这里刻意不用 Table：五列固定宽度加起来 680px，而两列布局下卡片只有 400 出头，
 * 每张卡都会挂一条横向滚动条。改成 CSS Grid 的紧凑列表后列宽随卡片伸缩，
 * 整行还能直接做成链接（原来是 tr 上挂 onClick，键盘用户只能摸到名称那一个链接）。
 */
function GroupedProgress({ title, rows, batchId, filterKey, note }: { title: string; rows: DashboardGroup[]; batchId: string; filterKey: GroupFilterKey; note?: string }) {
  const reviewListPath = (name: string) => {
    const search = new URLSearchParams([[filterKey, name]]).toString()
    return `/batches/${batchId}/reviews?${search}`
  }

  return (
    <Card
      className="dashboard-card dashboard-group-card"
      title={<div className="dashboard-card-heading">{title}{note ? <Text type="secondary" className="dashboard-card-note">{note}</Text> : null}</div>}
      extra={rows.length ? <Text type="secondary" className="dashboard-card-note">共 {rows.length} 项</Text> : null}
    >
      {rows.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无数据" />
      ) : (
        <div className="group-list">
          {/* 表头纯装饰：每行的语义由链接的 aria-label 完整给出，读屏不需要再听一遍列名。 */}
          <div className="group-list__head" aria-hidden="true">
            <span>名称</span>
            <span className="group-list__head-metric">AI 分析</span>
            <span className="group-list__head-metric">人工确认</span>
            <span className="group-list__head-pending">待处理</span>
          </div>
          <div className="group-list__body">
            {rows.map((row) => {
              const pending = row.pendingAi + row.pendingReview
              return (
                <Link
                  key={row.name}
                  to={reviewListPath(row.name)}
                  className="group-row"
                  aria-label={`${row.name}：共 ${row.total} 条，AI 已分析 ${row.aiDone} 条，人工已确认 ${row.reviewed} 条，待处理 ${pending} 条`}
                >
                  <span className="group-row__name">
                    <span className="group-row__label" title={row.name}>{row.name}</span>
                    <span className="group-row__total">{row.total}</span>
                  </span>
                  <GroupMetric done={row.aiDone} total={row.total} color="#2563eb" />
                  <GroupMetric done={row.reviewed} total={row.aiDone} color="#16a34a" />
                  <span className={pending > 0 ? 'group-row__pending group-row__pending--open' : 'group-row__pending'}>{pending}</span>
                </Link>
              )
            })}
          </div>
        </div>
      )}
    </Card>
  )
}

/** 单个进度指标：一行计数 + 一条细进度条，比 Ant Progress 的默认高度矮一半。 */
function GroupMetric({ done, total, color }: { done: number; total: number; color: string }) {
  return (
    <span className="group-metric">
      <span className="group-metric__count">{done}/{total}</span>
      <span className="group-metric__track">
        <span className="group-metric__fill" style={{ width: `${percentage(done, total)}%`, background: color }} />
      </span>
    </span>
  )
}

function buildStats(workspace: BatchWorkspace) {
  const resultByStory = new Map(workspace.results.filter((result) => result.verdict).map((result) => [result.story_id, result]))
  const latestReviewByStory = new Map<string, BatchWorkspace['humanReviews'][number]>()
  workspace.humanReviews.forEach((review) => {
    const current = latestReviewByStory.get(review.story_id)
    if (!current || new Date(review.reviewed_at).getTime() > new Date(current.reviewed_at).getTime()) {
      latestReviewByStory.set(review.story_id, review)
    }
  })

  const aiDistribution = { IMPLEMENTED: 0, PARTIAL: 0, NOT_IMPLEMENTED: 0, UNCERTAIN: 0 }
  const humanDistribution = { CORRECT: 0, PARTIALLY_CORRECT: 0, INCORRECT: 0, NEED_DISCUSSION: 0 }
  const owners = new Map<string, DashboardGroup>()
  const requirementHandlers = new Map<string, DashboardGroup>()
  const testHandlers = new Map<string, DashboardGroup>()
  const statuses = new Map<string, DashboardGroup>()

  resultByStory.forEach((result) => {
    if (result.verdict) aiDistribution[result.verdict] += 1
  })
  latestReviewByStory.forEach((review) => { humanDistribution[review.result] += 1 })

  workspace.stories.forEach((story) => {
    const aiDone = resultByStory.has(story.id)
    const reviewed = latestReviewByStory.has(story.id)
    // 三个维度都按单人拆分计入，所以协作需求会在每个参与人名下各计一次，
    // 各维度的合计会大于需求总数。
    splitPeople(story.owners_text).forEach((name) => addGrouped(owners, name, aiDone, reviewed))
    splitPeople(story.requirement_handlers).forEach((name) => addGrouped(requirementHandlers, name, aiDone, reviewed))
    splitPeople(story.test_handlers).forEach((name) => addGrouped(testHandlers, name, aiDone, reviewed))
    // 状态是单值，不像人员列那样拆分，所以这个维度的合计正好等于需求总数。
    addGrouped(statuses, storyStatusName(story), aiDone, reviewed)
  })

  const sortGroups = (groups: DashboardGroup[]) => groups.sort((a, b) => {
    const pendingDiff = (b.pendingAi + b.pendingReview) - (a.pendingAi + a.pendingReview)
    return pendingDiff || b.total - a.total || a.name.localeCompare(b.name, 'zh-CN')
  })

  const total = workspace.stories.length
  const aiDone = resultByStory.size
  const reviewed = latestReviewByStory.size
  return {
    total,
    aiDone,
    reviewed,
    pendingAi: total - aiDone,
    pendingReview: aiDone - reviewed,
    aiDistribution,
    humanDistribution,
    byOwner: sortGroups([...owners.values()]),
    byRequirementHandler: sortGroups([...requirementHandlers.values()]),
    byTestHandler: sortGroups([...testHandlers.values()]),
    byStatus: sortGroups([...statuses.values()]),
  }
}

function addGrouped(map: Map<string, DashboardGroup>, name: string, aiDone: boolean, reviewed: boolean) {
  const current = map.get(name) ?? { name, total: 0, aiDone: 0, reviewed: 0, pendingAi: 0, pendingReview: 0 }
  current.total += 1
  if (aiDone) current.aiDone += 1
  else current.pendingAi += 1
  if (reviewed) current.reviewed += 1
  else if (aiDone) current.pendingReview += 1
  map.set(name, current)
}

export default function App() {
  const [session, setSession] = useState<Session | null | undefined>()

  useEffect(() => {
    if (!supabaseConfigured) return
    getSession().then(setSession)
    const subscription = onAuthChange(setSession)
    return () => subscription.unsubscribe()
  }, [])

  if (!supabaseConfigured) return <SetupPage />
  if (session === undefined) return <main className="center-page"><Spin size="large" /></main>
  if (!session) return <AuthRoutes />
  return <Shell session={session} />
}
