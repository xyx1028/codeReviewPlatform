import { useEffect, useMemo, useState } from 'react'
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
  claimInitialAdmin,
  completeBatch,
  confirmAiResultImport,
  confirmSourceImport,
  createBatch,
  deleteBatch,
  getBatch,
  findImportFileByHash,
  getBatchWorkspace,
  getFileDownloadUrl,
  getMyProfile,
  getSession,
  listAiImports,
  listBatches,
  listBatchOperationLogs,
  listImportFiles,
  listStories,
  onAuthChange,
  reopenBatch,
  saveHumanReview,
  setBatchDefaultBranch,
  signIn,
  signOut,
  signUp,
  uploadBatchFile,
} from './lib/api'
import type { CreateBatchInput } from './lib/api'
import { downloadAiTemplate, inferFieldMapping, parseAiWorkbook, parseSourceRows, readFirstSheet, sourceFieldLabels, templateVersion } from './lib/excel'
import type { FieldMapping, SourceFieldKey } from './lib/excel'
import { parseBaselineCommit } from './lib/baseline'
import { hashFile } from './lib/hash'
import { aiVerdictLabels, aiVerdictOptions, batchStatusLabels, humanReviewLabels, humanReviewOptions } from './lib/labels'
import { aiFillPrompt } from './lib/prompt'
import { supabaseConfigured } from './lib/supabase'
import type {
  AdminUserListItem,
  AiImportRecord,
  AiReviewResult,
  AiVerdict,
  BaselineCommit,
  BatchStatus,
  BatchWorkspace,
  DefaultBranch,
  HumanReviewResult,
  ReviewBatch,
  ReviewStory,
  SourceStoryInput,
  UserRole,
  ValidationIssue,
} from './types'
import './App.css'

const { Header, Content, Sider } = Layout
const { Title, Text, Paragraph } = Typography

type AuthMode = 'sign-in' | 'sign-up'

const defaultBranchOptions: { value: DefaultBranch; label: DefaultBranch }[] = [
  { value: 'feature_dev', label: 'feature_dev' },
  { value: 'feature_sit', label: 'feature_sit' },
  { value: 'release', label: 'release' },
]

function isSupportedDefaultBranch(branch: string | null): branch is DefaultBranch {
  return branch === 'feature_dev' || branch === 'feature_sit' || branch === 'release'
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

function LoginPage() {
  const [mode, setMode] = useState<AuthMode>('sign-in')
  const { message } = AntApp.useApp()
  const mutation = useMutation({
    mutationFn: async (values: { email: string; password: string }) => {
      if (mode === 'sign-in') await signIn(values.email, values.password)
      else await signUp(values.email, values.password)
    },
    onSuccess: () => message.success(mode === 'sign-in' ? '登录成功' : '注册成功，请按 Supabase 邮件策略完成验证'),
    onError: (error) => message.error(error.message),
  })

  return (
    <main className="center-page">
      <Card className="login-card">
        <Title level={2}>AI 需求—代码一致性评审平台</Title>
        <Paragraph type="secondary">登录后管理每周评审批次、AI Excel 和人工确认。</Paragraph>
        <Form layout="vertical" onFinish={(values) => mutation.mutate(values)}>
          <Form.Item name="email" label="邮箱" rules={[{ required: true, type: 'email', message: '请输入邮箱' }]}>
            <Input autoComplete="email" />
          </Form.Item>
          <Form.Item name="password" label="密码" rules={[{ required: true, message: '请输入密码' }]}>
            <Input.Password autoComplete={mode === 'sign-in' ? 'current-password' : 'new-password'} />
          </Form.Item>
          <Space>
            <Button type="primary" htmlType="submit" loading={mutation.isPending}>
              {mode === 'sign-in' ? '登录' : '注册'}
            </Button>
            <Button type="link" onClick={() => setMode(mode === 'sign-in' ? 'sign-up' : 'sign-in')}>
              {mode === 'sign-in' ? '没有账号？注册' : '已有账号？登录'}
            </Button>
          </Space>
        </Form>
      </Card>
    </main>
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
  const canCreateBatch = role === 'ADMIN' || role === 'REVIEWER'
  const canManageBatch = (batch: ReviewBatch) => role === 'ADMIN' || (role === 'REVIEWER' && batch.created_by === session.user.id)
  const selectedKey = location.pathname.startsWith('/users') ? '/users' : '/batches'
  const menuItems = [
    { key: '/batches', label: <Link to="/batches">代码评审</Link> },
    ...(isAdmin ? [{ key: '/users', label: <Link to="/users">用户管理</Link> }] : []),
  ]

  return (
    <Layout className="app-shell">
      <Header className="app-header">
        <div>
          <Text className="brand">AI 需求—代码一致性评审平台</Text>
          <Text className="subtitle">轻量 V1 闭环</Text>
        </div>
        <Space>
          <Tag color={profileQuery.data?.role === 'ADMIN' ? 'green' : 'blue'}>{profileQuery.data?.role ?? '未配置角色'}</Tag>
          {role === 'REVIEWER' ? (
            <Button size="small" onClick={() => claimAdminMutation.mutate()} loading={claimAdminMutation.isPending}>
              申领初始管理员
            </Button>
          ) : null}
          <Text className="header-email">{session.user.email}</Text>
          <Button onClick={() => logoutMutation.mutate()} loading={logoutMutation.isPending}>退出</Button>
        </Space>
      </Header>
      <Layout>
        <Sider width={220} className="app-sider">
          <Menu
            mode="inline"
            selectedKeys={[selectedKey]}
            items={menuItems}
          />
        </Sider>
        <Content className="app-content">
          <Routes>
            <Route path="/" element={<Navigate to="/batches" replace />} />
            <Route path="/batches" element={<BatchesPage canCreateBatch={canCreateBatch} canManageBatch={canManageBatch} />} />
            <Route path="/users" element={<AdminUsersPage isAdmin={isAdmin} />} />
            <Route path="/batches/:batchId/*" element={<BatchPage canManageBatch={canManageBatch} />} />
            <Route path="*" element={<Navigate to="/batches" replace />} />
          </Routes>
        </Content>
      </Layout>
    </Layout>
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
    { title: '名称', dataIndex: 'display_name', render: (value) => value || '-' },
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

  return (
    <Space direction="vertical" size="large" className="page-stack">
      <PageTitle title="用户管理" />
      <Card>
        <Alert type="info" showIcon title="角色说明" description="管理员可以管理所有批次并管理用户；审核者可以创建和管理自己创建的批次；查看者只查看数据。" />
      </Card>
      <Table rowKey="id" loading={usersQuery.isLoading} columns={columns} dataSource={usersQuery.data ?? []} />
    </Space>
  )
}

function BatchesPage({ canCreateBatch, canManageBatch }: { canCreateBatch: boolean; canManageBatch: (batch: ReviewBatch) => boolean }) {
  const [open, setOpen] = useState(false)
  const [form] = Form.useForm<CreateBatchInput>()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { message, modal } = AntApp.useApp()
  const batchesQuery = useQuery({ queryKey: ['batches'], queryFn: listBatches })
  const createMutation = useMutation({
    mutationFn: createBatch,
    onSuccess: (batch) => {
      message.success('批次已创建')
      setOpen(false)
      form.resetFields()
      queryClient.invalidateQueries({ queryKey: ['batches'] })
      navigate(`/batches/${batch.id}/import`)
    },
    onError: (error) => message.error(error.message),
  })
  const deleteMutation = useMutation({
    mutationFn: deleteBatch,
    onSuccess: () => {
      message.success('批次已删除')
      queryClient.invalidateQueries({ queryKey: ['batches'] })
    },
    onError: (error) => message.error(error.message),
  })

  const columns: ColumnsType<ReviewBatch> = [
    { title: '批次名称', dataIndex: 'name', render: (name, record) => <Link to={`/batches/${record.id}/dashboard`}>{name}</Link> },
    { title: '周标识', dataIndex: 'week_code', width: 140 },
    { title: '状态', dataIndex: 'status', width: 150, render: (status: BatchStatus) => <Tag color={statusColor(status)}>{batchStatusLabels[status]}</Tag> },
    { title: '默认分支', dataIndex: 'default_branch', width: 140, render: (value) => value || '-' },
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
      <PageTitle title="批次列表" extra={canCreateBatch ? <Button type="primary" onClick={() => setOpen(true)}>创建批次</Button> : null} />
      <Table rowKey="id" loading={batchesQuery.isLoading} columns={columns} dataSource={batchesQuery.data ?? []} />
      <Modal title="创建每周评审批次" open={open} onCancel={() => setOpen(false)} onOk={() => form.submit()} confirmLoading={createMutation.isPending}>
        <Form form={form} layout="vertical" onFinish={(values) => createMutation.mutate(values)}>
          <Form.Item name="name" label="批次名称" rules={[{ required: true, message: '请输入批次名称' }]}>
            <Input placeholder="2026 年第 36 周需求评审" />
          </Form.Item>
          <Form.Item name="week_code" label="周标识" rules={[{ required: true, message: '请输入周标识' }]}>
            <Input placeholder="2026-W36" />
          </Form.Item>
          <Form.Item name="default_branch" label="默认代码基线分支" rules={[{ required: true, message: '请选择默认代码基线分支' }]}>
            <Select placeholder="选择代码基线分支" options={defaultBranchOptions} />
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
    <Space direction="vertical" size="large" className="page-stack">
      <PageTitle
        title={batchQuery.data.name}
        extra={<Tag color={statusColor(batchQuery.data.status)}>{batchStatusLabels[batchQuery.data.status]}</Tag>}
      />
      <Tabs activeKey={activeKey} items={tabs} onChange={(key) => navigate(`/batches/${batchId}/${key}`)} />
      <Routes>
        <Route path="/" element={<Navigate to="dashboard" replace />} />
        <Route path="dashboard" element={<DashboardPage batchId={batchId} canManage={canManage} />} />
        <Route path="import" element={<SourceImportPage batchId={batchId} batch={batchQuery.data} canManage={canManage} />} />
        <Route path="ai-result" element={<AiResultPage batchId={batchId} canManage={canManage} />} />
        <Route path="reviews" element={<ReviewListPage batchId={batchId} />} />
        <Route path="reviews/:storyId" element={<ReviewDetailPage batchId={batchId} canManage={canManage} />} />
      </Routes>
    </Space>
  )
}

function SourceImportPage({ batchId, batch, canManage }: { batchId: string; batch: ReviewBatch; canManage: boolean }) {
  const [file, setFile] = useState<File | null>(null)
  const [headers, setHeaders] = useState<string[]>([])
  const [rows, setRows] = useState<Record<string, unknown>[]>([])
  const [mapping, setMapping] = useState<FieldMapping>({})
  const { message } = AntApp.useApp()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const readOnly = !canManage || batch.status === 'COMPLETED'
  const storiesQuery = useQuery({ queryKey: ['stories', batchId], queryFn: () => listStories(batchId) })
  const sourceFilesQuery = useQuery({ queryKey: ['import-files', batchId, 'SOURCE'], queryFn: () => listImportFiles(batchId, 'SOURCE') })
  const alreadyImported = Boolean(storiesQuery.data?.length)
  const parsed = useMemo(() => parseSourceRows(rows, mapping), [rows, mapping])
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
              setMapping(inferFieldMapping(workbookRows.headers))
              return false
            }}
            onRemove={() => {
              setFile(null)
              setHeaders([])
              setRows([])
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
              { title: '负责人', dataIndex: 'owners_text' },
              { title: '应用', dataIndex: 'application_name' },
            ]}
          />
        </Card>
      </Col>
    </Row>
  )
}

function AiResultPage({ batchId, canManage }: { batchId: string; canManage: boolean }) {
  const [file, setFile] = useState<File | null>(null)
  const [parsed, setParsed] = useState<Awaited<ReturnType<typeof parseAiWorkbook>> | null>(null)
  const [defaultBranch, setDefaultBranch] = useState<DefaultBranch>()
  const { message, modal } = AntApp.useApp()
  const queryClient = useQueryClient()
  const workspaceQuery = useBatchWorkspace(batchId)
  const aiImportsQuery = useQuery({ queryKey: ['ai-imports', batchId], queryFn: () => listAiImports(batchId) })
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

  if (workspaceQuery.isLoading) return <Spin />
  if (!workspaceQuery.data) return <Empty />

  const readOnly = !canManage || workspaceQuery.data.batch.status === 'COMPLETED'
  const alreadyImportedAi = Boolean(aiImportsQuery.data?.length)

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
      <Card>
        <Space wrap>
          <Button type="primary" disabled={!workspaceQuery.data.stories.length || !isSupportedDefaultBranch(workspaceQuery.data.batch.default_branch)} onClick={() => downloadAiTemplate(workspaceQuery.data.batch, workspaceQuery.data.stories)}>
            下载AI填写模板
          </Button>
          <Text type="secondary">模板包含批次信息、需求评审、代码证据三个 Sheet。</Text>
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
      <Card title="AI报告版本">
        <Table
          rowKey="id"
          loading={aiImportsQuery.isLoading}
          dataSource={aiImportsQuery.data ?? []}
          pagination={false}
          columns={[
            { title: '版本', dataIndex: 'version', width: 90, render: (version) => `V${version}` },
            { title: '生效状态', dataIndex: 'is_active', width: 120, render: (active) => active ? <Tag color="green">当前生效</Tag> : <Tag>历史版本</Tag> },
            { title: '分析基线', render: (_value, record) => <BaselineImportDetails aiImport={record} /> },
            { title: '导入时间', dataIndex: 'created_at', render: (value) => new Date(value).toLocaleString() },
            {
              title: '操作',
              width: 120,
              render: (_value, record) => (
                <Button
                  size="small"
                  disabled={!record.import_file?.storage_path}
                  onClick={() => record.import_file && downloadStorageFile(record.import_file.storage_path)}
                >
                  下载文件
                </Button>
              ),
            },
          ]}
        />
      </Card>
    </Space>
  )
}

function ReviewListPage({ batchId }: { batchId: string }) {
  const [reviewStatus, setReviewStatus] = useState<string | undefined>()
  const location = useLocation()
  const navigate = useNavigate()
  const workspaceQuery = useBatchWorkspace(batchId)
  const ownerOptions = useMemo(() => {
    const names = new Set<string>()
    workspaceQuery.data?.stories.forEach((story) => {
      splitOwners(story.owners_text).forEach((name) => names.add(name))
    })
    return [...names].sort((a, b) => a.localeCompare(b, 'zh-CN')).map((name) => ({ value: name, label: name }))
  }, [workspaceQuery.data])
  const applicationOptions = useMemo(() => {
    const names = new Set<string>()
    workspaceQuery.data?.stories.forEach((story) => names.add(applicationGroupName(story)))
    return [...names].sort((a, b) => a.localeCompare(b, 'zh-CN')).map((name) => ({ value: name, label: name }))
  }, [workspaceQuery.data])
  const getSingleSearchParam = (name: string) => {
    const values = new URLSearchParams(location.search).getAll(name)
    return values.length === 1 && values[0] ? values[0] : undefined
  }
  const verdictParam = getSingleSearchParam('verdict')
  const ownerParam = getSingleSearchParam('owner')
  const applicationParam = getSingleSearchParam('application')
  const verdict = verdictParam && aiVerdictOptions.some((option) => option.value === verdictParam)
    ? verdictParam as AiVerdict
    : undefined
  const owner = ownerParam && ownerOptions.some((option) => option.value === ownerParam) ? ownerParam : undefined
  const application = applicationParam && applicationOptions.some((option) => option.value === applicationParam) ? applicationParam : undefined
  const updateFilters = (changes: Partial<Record<'verdict' | 'owner' | 'application', string | undefined>>) => {
    const searchParams = new URLSearchParams(location.search)
    Object.entries(changes).forEach(([name, value]) => {
      if (value) searchParams.set(name, value)
      else searchParams.delete(name)
    })
    const search = searchParams.toString()
    navigate({ pathname: location.pathname, search: search ? `?${search}` : '' })
  }

  const rows = useMemo(() => {
    if (!workspaceQuery.data) return []
    const resultByStory = new Map(workspaceQuery.data.results.map((result) => [result.story_id, result]))
    const reviewsByStory = new Map(workspaceQuery.data.humanReviews.map((review) => [review.story_id, review]))
    const evidenceCountByResult = new Map<string, number>()
    workspaceQuery.data.evidence.forEach((item) => evidenceCountByResult.set(item.ai_review_result_id, (evidenceCountByResult.get(item.ai_review_result_id) ?? 0) + 1))

    return workspaceQuery.data.stories.map((story) => {
      const result = resultByStory.get(story.id) ?? null
      const review = reviewsByStory.get(story.id) ?? null
      return { story, result, review, evidenceCount: result ? evidenceCountByResult.get(result.id) ?? 0 : 0 }
    }).filter((row) => {
      const ownerMatched = owner ? splitOwners(row.story.owners_text).includes(owner) : true
      const applicationMatched = application ? applicationGroupName(row.story) === application : true
      const verdictMatched = verdict ? row.result?.verdict === verdict : true
      const reviewMatched = reviewStatus === 'reviewed' ? Boolean(row.review) : reviewStatus === 'pending' ? !row.review : true
      return ownerMatched && applicationMatched && verdictMatched && reviewMatched
    })
  }, [application, owner, reviewStatus, verdict, workspaceQuery.data])

  const aiTagColors = { IMPLEMENTED: 'green', PARTIAL: 'orange', NOT_IMPLEMENTED: 'red', UNCERTAIN: 'default' }
  const humanTagColors = { CORRECT: 'green', PARTIALLY_CORRECT: 'orange', INCORRECT: 'red', NEED_DISCUSSION: 'purple' }
  const activeFilterCount = [owner, application, verdict, reviewStatus].filter(Boolean).length
  const columns: ColumnsType<(typeof rows)[number]> = [
    { title: '编码', dataIndex: ['story', 'story_code'], width: 150, render: (_value, row) => <Link className="review-story-code" to={`/batches/${batchId}/reviews/${row.story.id}`}>{row.story.story_code}</Link> },
    { title: '需求名称', dataIndex: ['story', 'story_name'], width: 340 },
    {
      title: '负责人',
      dataIndex: ['story', 'owners_text'],
      width: 190,
      render: (value) => <Space size={[4, 4]} wrap>{splitOwners(value).map((name) => <Tag key={name}>{name}</Tag>)}</Space>,
    },
    { title: '应用', dataIndex: ['story', 'application_name'], width: 120, render: (_value, row) => applicationGroupName(row.story) },
    {
      title: 'AI判断',
      width: 120,
      render: (_value, row) => row.result?.verdict
        ? <Tag color={aiTagColors[row.result.verdict]}>{aiVerdictLabels[row.result.verdict]}</Tag>
        : <Tag>未分析</Tag>,
    },
    { title: '证据', width: 90, render: (_value, row) => <Tag color={row.evidenceCount ? 'geekblue' : 'default'}>{row.evidenceCount} 条</Tag> },
    {
      title: '人工状态',
      width: 150,
      render: (_value, row) => row.review
        ? <Tag color={humanTagColors[row.review.result]}>{humanReviewLabels[row.review.result]}</Tag>
        : <Tag color="gold">待确认</Tag>,
    },
  ]

  return (
    <Space direction="vertical" size="large" className="page-stack review-list-page">
      <Card className="review-filter-card">
        <div className="review-filter-header">
          <div>
            <Text strong>筛选条件</Text>
            <Text type="secondary" className="review-filter-summary">当前显示 {rows.length} / {workspaceQuery.data?.stories.length ?? 0} 条需求</Text>
          </div>
          {activeFilterCount ? <Button type="link" onClick={() => { updateFilters({ owner: undefined, application: undefined, verdict: undefined }); setReviewStatus(undefined) }}>清空筛选</Button> : null}
        </div>
        <Space wrap className="review-filter-controls">
          <Select
            allowClear
            showSearch
            placeholder="按负责人筛选"
            className="filter-select"
            options={ownerOptions}
            value={owner}
            onChange={(value) => updateFilters({ owner: value })}
            filterOption={(input, option) => String(option?.label ?? '').includes(input)}
          />
          <Select
            allowClear
            showSearch
            placeholder="按应用筛选"
            className="filter-select"
            options={applicationOptions}
            value={application}
            onChange={(value) => updateFilters({ application: value })}
            filterOption={(input, option) => String(option?.label ?? '').includes(input)}
          />
          <Select allowClear placeholder="AI判断" className="filter-select" options={aiVerdictOptions} value={verdict} onChange={(value) => updateFilters({ verdict: value })} />
          <Select
            allowClear
            placeholder="人工状态"
            className="filter-select"
            value={reviewStatus}
            onChange={setReviewStatus}
            options={[{ value: 'pending', label: '待确认' }, { value: 'reviewed', label: '已确认' }]}
          />
        </Space>
      </Card>
      <Card className="review-table-card" bodyStyle={{ padding: 0 }}>
        <div className="review-table-inset">
          <Table
            rowKey={(row) => row.story.id}
            loading={workspaceQuery.isLoading}
            columns={columns}
            dataSource={rows}
            size="middle"
            scroll={{ x: 1120 }}
            pagination={{ pageSize: 20, showSizeChanger: false, showTotal: (total) => `共 ${total} 条` }}
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
  const operationLogQuery = useQuery({ queryKey: ['operation-log', batchId], queryFn: () => listBatchOperationLogs(batchId) })
  const queryClient = useQueryClient()
  const { message, modal } = AntApp.useApp()
  const completeMutation = useMutation({
    mutationFn: (force: boolean) => completeBatch(batchId, force),
    onSuccess: (pendingCount) => {
      message.success(pendingCount > 0 ? `已强制完成，仍有 ${pendingCount} 条未确认` : '批次已完成')
      queryClient.invalidateQueries({ queryKey: ['batch-workspace', batchId] })
      queryClient.invalidateQueries({ queryKey: ['batch', batchId] })
      queryClient.invalidateQueries({ queryKey: ['batches'] })
      queryClient.invalidateQueries({ queryKey: ['operation-log', batchId] })
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
      queryClient.invalidateQueries({ queryKey: ['operation-log', batchId] })
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

      <Row gutter={[16, 16]}>
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

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}><DistributionCard title="AI 判断分布" items={aiItems} total={stats.aiDone} /></Col>
        <Col xs={24} lg={12}><DistributionCard title="人工结论分布" items={humanItems} total={stats.reviewed} /></Col>
      </Row>

      <Row gutter={[16, 16]}>
        <Col xs={24} xl={12}><GroupedProgress title="按负责人统计" rows={stats.byOwner} batchId={batchId} filterKey="owner" note="协作需求按负责人分别计入" /></Col>
        <Col xs={24} xl={12}><GroupedProgress title="按应用统计" rows={stats.byApplication} batchId={batchId} filterKey="application" /></Col>
      </Row>

      <Card className="dashboard-card dashboard-log-card" title="操作日志">
        <List
          dataSource={operationLogQuery.data ?? []}
          locale={{ emptyText: '暂无完成或重新打开记录' }}
          renderItem={(item) => (
            <List.Item>
              <Space wrap>
                <Tag color={item.action === 'COMPLETE' ? 'green' : 'gold'}>{item.action === 'COMPLETE' ? '完成批次' : '重新打开'}</Tag>
                <Text>{new Date(item.created_at).toLocaleString()}</Text>
                {item.action === 'COMPLETE' ? <Text type="secondary">{item.forced ? `强制完成，当时仍有 ${item.pending_count ?? 0} 条未确认` : '正常完成'}</Text> : null}
              </Space>
            </List.Item>
          )}
        />
      </Card>
    </div>
  )
}

function StoryCard({ story }: { story: ReviewStory }) {
  const metadata = [
    { label: '负责人', value: story.owners_text },
    { label: '项目', value: story.project_name },
    { label: '应用', value: story.application_name },
    { label: '所属云', value: story.cloud_name },
    { label: '迭代', value: story.iteration_name },
    { label: '发布窗口', value: story.release_window },
    { label: '来源状态', value: story.source_status },
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
          {result.confidence === null ? <Text type="secondary">未填写</Text> : <><Progress percent={result.confidence} size="small" strokeColor="#2563eb" /><Text>{result.confidence}%</Text></>}
        </div>
        {aiImport ? <div className="review-ai-baseline"><Text type="secondary">分析基线</Text><BaselineImportDetails aiImport={aiImport} /></div> : null}
      </div>

      <div className="review-ai-highlight">
        <Text strong>分析摘要</Text>
        <Text>{result.summary || '暂无摘要'}</Text>
      </div>

      <div className="review-ai-sections">
        {sections.map((section) => (
          <section key={section.title} className={`review-ai-section review-ai-section--${section.tone}`}>
            <Text strong>{section.title}</Text>
            <Text>{section.value}</Text>
          </section>
        ))}
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

function splitOwners(ownersText: string) {
  const owners = ownersText.split(/[，,、；;]/).map((name) => name.trim()).filter(Boolean)
  return [...new Set(owners.length ? owners : ['未分配'])]
}

function applicationGroupName(story: ReviewStory) {
  return story.application_name || '未填写应用'
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
  const metadata = parseBaselineCommit(aiImport.baseline_commit)
  const branchMismatch = Boolean(metadata && metadata.actual_branch !== aiImport.baseline_branch)

  return (
    <div className="baseline-meta">
      <div className="baseline-meta__row">
        <BaselineMetaChip label="配置分支" value={aiImport.baseline_branch || '-'} />
        {metadata ? <BaselineMetaChip label="实际分支" value={metadata.actual_branch} tone={branchMismatch ? 'warning' : undefined} /> : null}
        <BaselineMetaChip label="模型" value={aiImport.ai_model || '-'} />
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
              <Text type="secondary">{item.label}</Text>
              <div className="dashboard-distribution-value">{item.value}</div>
              <Text type="secondary">{percentage(item.value, total)}%</Text>
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

function GroupedProgress({ title, rows, batchId, filterKey, note }: { title: string; rows: DashboardGroup[]; batchId: string; filterKey: 'owner' | 'application'; note?: string }) {
  const navigate = useNavigate()
  const reviewListPath = (name: string) => {
    const search = new URLSearchParams([[filterKey, name]]).toString()
    return `/batches/${batchId}/reviews?${search}`
  }

  return (
    <Card className="dashboard-card" title={<div className="dashboard-card-heading">{title}{note ? <Text type="secondary" className="dashboard-card-note">{note}</Text> : null}</div>}>
      <Table
        size="small"
        rowKey="name"
        pagination={false}
        scroll={{ x: 680 }}
        dataSource={rows}
        onRow={(row) => ({
          className: 'dashboard-group-row',
          onClick: (event) => {
            if (event.target instanceof Element && event.target.closest('a')) return
            navigate(reviewListPath(row.name))
          },
        })}
        columns={[
          {
            title: '名称',
            dataIndex: 'name',
            width: 180,
            render: (name: string) => <Link className="dashboard-group-link" to={reviewListPath(name)} aria-label={`查看${name}的评审列表`}>{name}</Link>,
          },
          { title: '总数', dataIndex: 'total', width: 72 },
          {
            title: 'AI 分析进度',
            width: 170,
            render: (_value, row: DashboardGroup) => (
              <div className="dashboard-progress-cell">
                <Progress percent={percentage(row.aiDone, row.total)} showInfo={false} strokeColor="#2563eb" size="small" />
                <Text type="secondary">{row.aiDone} / {row.total}</Text>
              </div>
            ),
          },
          {
            title: '人工确认进度',
            width: 170,
            render: (_value, row: DashboardGroup) => (
              <div className="dashboard-progress-cell">
                <Progress percent={percentage(row.reviewed, row.aiDone)} showInfo={false} strokeColor="#16a34a" size="small" />
                <Text type="secondary">{row.reviewed} / {row.aiDone}</Text>
              </div>
            ),
          },
          { title: '待处理', width: 84, render: (_value, row: DashboardGroup) => row.pendingAi + row.pendingReview },
        ]}
      />
    </Card>
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
  const applications = new Map<string, DashboardGroup>()

  resultByStory.forEach((result) => {
    if (result.verdict) aiDistribution[result.verdict] += 1
  })
  latestReviewByStory.forEach((review) => { humanDistribution[review.result] += 1 })

  workspace.stories.forEach((story) => {
    const aiDone = resultByStory.has(story.id)
    const reviewed = latestReviewByStory.has(story.id)
    splitOwners(story.owners_text).forEach((owner) => addGrouped(owners, owner, aiDone, reviewed))
    addGrouped(applications, applicationGroupName(story), aiDone, reviewed)
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
    byApplication: sortGroups([...applications.values()]),
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
  if (!session) return <LoginPage />
  return <Shell session={session} />
}
