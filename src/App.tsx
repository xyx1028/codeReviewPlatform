import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Col,
  Descriptions,
  Divider,
  Empty,
  Form,
  Input,
  Layout,
  List,
  Menu,
  Modal,
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
  setActiveAiImport,
  signIn,
  signOut,
  signUp,
  uploadBatchFile,
} from './lib/api'
import type { CreateBatchInput } from './lib/api'
import { downloadAiTemplate, inferFieldMapping, parseAiWorkbook, parseSourceRows, readFirstSheet, sourceFieldLabels, templateVersion } from './lib/excel'
import type { FieldMapping, SourceFieldKey } from './lib/excel'
import { hashFile } from './lib/hash'
import { aiVerdictLabels, aiVerdictOptions, batchStatusLabels, humanReviewLabels, humanReviewOptions } from './lib/labels'
import { aiFillPrompt } from './lib/prompt'
import { supabaseConfigured } from './lib/supabase'
import type {
  AdminUserListItem,
  AiReviewResult,
  BatchStatus,
  BatchWorkspace,
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

  const isAdmin = profileQuery.data?.role === 'ADMIN'
  const selectedKey = location.pathname.startsWith('/users') ? '/users' : '/batches'
  const menuItems = [
    { key: '/batches', label: <Link to="/batches">批次列表</Link> },
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
          {profileQuery.data?.role !== 'ADMIN' ? (
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
            <Route path="/batches" element={<BatchesPage />} />
            <Route path="/users" element={<AdminUsersPage isAdmin={isAdmin} />} />
            <Route path="/batches/:batchId/*" element={<BatchPage />} />
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
        <Alert type="info" showIcon title="角色说明" description="管理员可以创建批次、导入文件、完成/重开批次并管理用户；审核者用于提交人工结论；查看者只查看数据。" />
      </Card>
      <Table rowKey="id" loading={usersQuery.isLoading} columns={columns} dataSource={usersQuery.data ?? []} />
    </Space>
  )
}

function BatchesPage() {
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
      render: (_value, record) => (
        <Button
          danger
          size="small"
          loading={deleteMutation.isPending}
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
      ),
    },
  ]

  return (
    <Space direction="vertical" size="large" className="page-stack">
      <PageTitle title="批次列表" extra={<Button type="primary" onClick={() => setOpen(true)}>创建批次</Button>} />
      <Table rowKey="id" loading={batchesQuery.isLoading} columns={columns} dataSource={batchesQuery.data ?? []} />
      <Modal title="创建每周评审批次" open={open} onCancel={() => setOpen(false)} onOk={() => form.submit()} confirmLoading={createMutation.isPending}>
        <Form form={form} layout="vertical" onFinish={(values) => createMutation.mutate(values)}>
          <Form.Item name="name" label="批次名称" rules={[{ required: true, message: '请输入批次名称' }]}>
            <Input placeholder="2026 年第 36 周需求评审" />
          </Form.Item>
          <Form.Item name="week_code" label="周标识" rules={[{ required: true, message: '请输入周标识' }]}>
            <Input placeholder="2026-W36" />
          </Form.Item>
          <Form.Item name="default_branch" label="默认代码基线分支">
            <Input placeholder="master / feature_dev" />
          </Form.Item>
          <Form.Item name="remark" label="备注">
            <Input.TextArea rows={3} />
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  )
}

function BatchPage() {
  const { batchId } = useParams()
  const batchQuery = useQuery({ queryKey: ['batch', batchId], enabled: Boolean(batchId), queryFn: () => getBatch(batchId!) })
  const location = useLocation()
  const navigate = useNavigate()

  if (!batchId) return <Navigate to="/batches" replace />
  if (batchQuery.isLoading) return <Spin />
  if (!batchQuery.data) return <Empty description="批次不存在" />

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
        <Route path="dashboard" element={<DashboardPage batchId={batchId} />} />
        <Route path="import" element={<SourceImportPage batchId={batchId} batch={batchQuery.data} />} />
        <Route path="ai-result" element={<AiResultPage batchId={batchId} />} />
        <Route path="reviews" element={<ReviewListPage batchId={batchId} />} />
        <Route path="reviews/:storyId" element={<ReviewDetailPage batchId={batchId} />} />
      </Routes>
    </Space>
  )
}

function SourceImportPage({ batchId, batch }: { batchId: string; batch: ReviewBatch }) {
  const [file, setFile] = useState<File | null>(null)
  const [headers, setHeaders] = useState<string[]>([])
  const [rows, setRows] = useState<Record<string, unknown>[]>([])
  const [mapping, setMapping] = useState<FieldMapping>({})
  const { message } = AntApp.useApp()
  const queryClient = useQueryClient()
  const readOnly = batch.status === 'COMPLETED'
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
    },
    onError: (error) => message.error(error.message),
  })

  return (
    <Space direction="vertical" size="large" className="page-stack">
      {readOnly ? <Alert type="warning" showIcon title="批次已完成" description="批次完成后默认只读，如需继续导入请先在统计看板重新打开批次。" /> : null}
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
  return (
    <Card title={readOnly ? '本次导入使用的字段映射' : '字段映射'}>
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

function AiResultPage({ batchId }: { batchId: string }) {
  const [file, setFile] = useState<File | null>(null)
  const [parsed, setParsed] = useState<Awaited<ReturnType<typeof parseAiWorkbook>> | null>(null)
  const { message } = AntApp.useApp()
  const queryClient = useQueryClient()
  const workspaceQuery = useBatchWorkspace(batchId)
  const aiImportsQuery = useQuery({ queryKey: ['ai-imports', batchId], queryFn: () => listAiImports(batchId) })
  const setActiveMutation = useMutation({
    mutationFn: setActiveAiImport,
    onSuccess: () => {
      message.success('生效版本已切换')
      queryClient.invalidateQueries({ queryKey: ['batch-workspace', batchId] })
      queryClient.invalidateQueries({ queryKey: ['batch', batchId] })
    },
    onError: (error) => message.error(error.message),
  })
  const importMutation = useMutation({
    mutationFn: async () => {
      if (!file || !parsed || !workspaceQuery.data) throw new Error('请先上传并解析AI结果文件')
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
        baselineBranch: parsed.batchInfo.baseline_branch || null,
        baselineCommit: parsed.batchInfo.baseline_commit || null,
        aiModel: parsed.batchInfo.ai_model || null,
        analyzedAt: parsed.batchInfo.analyzed_at ? new Date(parsed.batchInfo.analyzed_at).toISOString() : null,
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

  const readOnly = workspaceQuery.data.batch.status === 'COMPLETED'
  const alreadyImportedAi = Boolean(aiImportsQuery.data?.length)

  return (
    <Space direction="vertical" size="large" className="page-stack">
      {readOnly ? <Alert type="warning" showIcon title="批次已完成" description="批次完成后默认只读，如需继续导入或切换生效版本请先在统计看板重新打开批次。" /> : null}
      <Card>
        <Space wrap>
          <Button type="primary" disabled={!workspaceQuery.data.stories.length} onClick={() => downloadAiTemplate(workspaceQuery.data.batch, workspaceQuery.data.stories)}>
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
            disabled={readOnly}
            beforeUpload={async (selectedFile) => {
              const result = await parseAiWorkbook(selectedFile, workspaceQuery.data.batch, workspaceQuery.data.stories)
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
            { title: '基线分支', dataIndex: 'baseline_branch', render: (value) => value || '-' },
            { title: 'Commit', dataIndex: 'baseline_commit', render: (value) => value || '-' },
            { title: 'AI模型', dataIndex: 'ai_model', render: (value) => value || '-' },
            { title: '导入时间', dataIndex: 'created_at', render: (value) => new Date(value).toLocaleString() },
            {
              title: '操作',
              width: 220,
              render: (_value, record) => (
                <Space>
                  <Button
                    size="small"
                    disabled={readOnly || record.is_active}
                    loading={setActiveMutation.isPending}
                    onClick={() => setActiveMutation.mutate(record.id)}
                  >
                    设为生效
                  </Button>
                  <Button
                    size="small"
                    disabled={!record.import_file?.storage_path}
                    onClick={() => record.import_file && downloadStorageFile(record.import_file.storage_path)}
                  >
                    下载文件
                  </Button>
                </Space>
              ),
            },
          ]}
        />
      </Card>
    </Space>
  )
}

function ReviewListPage({ batchId }: { batchId: string }) {
  const [owner, setOwner] = useState('')
  const [verdict, setVerdict] = useState<string | undefined>()
  const [reviewStatus, setReviewStatus] = useState<string | undefined>()
  const workspaceQuery = useBatchWorkspace(batchId)

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
      const ownerMatched = owner ? row.story.owners_text.includes(owner) : true
      const verdictMatched = verdict ? row.result?.verdict === verdict : true
      const reviewMatched = reviewStatus === 'reviewed' ? Boolean(row.review) : reviewStatus === 'pending' ? !row.review : true
      return ownerMatched && verdictMatched && reviewMatched
    })
  }, [owner, reviewStatus, verdict, workspaceQuery.data])

  const columns: ColumnsType<(typeof rows)[number]> = [
    { title: '编码', dataIndex: ['story', 'story_code'], width: 160, render: (_value, row) => <Link to={`/batches/${batchId}/reviews/${row.story.id}`}>{row.story.story_code}</Link> },
    { title: '需求名称', dataIndex: ['story', 'story_name'] },
    { title: '负责人', dataIndex: ['story', 'owners_text'], width: 160 },
    { title: '应用', dataIndex: ['story', 'application_name'], width: 160, render: (value) => value || '-' },
    { title: 'AI判断', width: 130, render: (_value, row) => row.result?.verdict ? <Tag color="blue">{aiVerdictLabels[row.result.verdict]}</Tag> : <Tag>未分析</Tag> },
    { title: '证据', width: 90, dataIndex: 'evidenceCount' },
    { title: '人工状态', width: 160, render: (_value, row) => row.review ? <Tag color="green">{humanReviewLabels[row.review.result]}</Tag> : <Tag color="gold">待确认</Tag> },
  ]

  return (
    <Space direction="vertical" size="large" className="page-stack">
      <Card>
        <Space wrap>
          <Input.Search placeholder="按负责人筛选" allowClear onSearch={setOwner} onChange={(event) => setOwner(event.target.value)} />
          <Select allowClear placeholder="AI判断" className="filter-select" options={aiVerdictOptions} value={verdict} onChange={setVerdict} />
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
      <Table rowKey={(row) => row.story.id} loading={workspaceQuery.isLoading} columns={columns} dataSource={rows} />
    </Space>
  )
}

function ReviewDetailPage({ batchId }: { batchId: string }) {
  const { storyId } = useParams()
  const workspaceQuery = useBatchWorkspace(batchId)

  const detail = useMemo(() => {
    if (!workspaceQuery.data || !storyId) return null
    const story = workspaceQuery.data.stories.find((item) => item.id === storyId)
    if (!story) return null
    const aiResult = workspaceQuery.data.results.find((item) => item.story_id === story.id) ?? null
    const evidence = aiResult ? workspaceQuery.data.evidence.filter((item) => item.ai_review_result_id === aiResult.id) : []
    const humanReview = workspaceQuery.data.humanReviews.find((item) => item.story_id === story.id && item.ai_review_result_id === aiResult?.id) ?? null
    const nextStory = workspaceQuery.data.stories.find((item) => item.id !== story.id && !workspaceQuery.data?.humanReviews.some((review) => review.story_id === item.id)) ?? null
    const readOnly = workspaceQuery.data.batch.status === 'COMPLETED'
    return { story, aiResult, evidence, humanReview, nextStory, readOnly }
  }, [storyId, workspaceQuery.data])

  if (workspaceQuery.isLoading) return <Spin />
  if (!detail) return <Empty description="需求不存在" />

  return (
    <Row gutter={[16, 16]}>
      <Col span={24} lg={8} className="sticky-col"><StoryCard story={detail.story} /></Col>
      <Col span={24} lg={9}><AiResultCard result={detail.aiResult} evidence={detail.evidence} /></Col>
      <Col span={24} lg={7} className="sticky-col">
        <HumanReviewPanel batchId={batchId} detail={detail} readOnly={detail.readOnly} />
      </Col>
    </Row>
  )
}

function HumanReviewPanel({
  batchId,
  detail,
  readOnly,
}: {
  batchId: string
  detail: {
    story: ReviewStory
    aiResult: AiReviewResult | null
    evidence: BatchWorkspace['evidence']
    humanReview: BatchWorkspace['humanReviews'][number] | null
    nextStory: ReviewStory | null
  }
  readOnly: boolean
}) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { message } = AntApp.useApp()
  const [result, setResult] = useState<HumanReviewResult>(detail.humanReview?.result ?? 'CORRECT')
  const [comment, setComment] = useState(detail.humanReview?.comment ?? '')
  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!detail.aiResult) throw new Error('当前需求还没有AI结果，不能提交人工结论')
      return saveHumanReview(detail.story.id, detail.aiResult.id, result, comment || null)
    },
    onSuccess: () => {
      message.success('人工结论已保存')
      queryClient.invalidateQueries({ queryKey: ['batch-workspace', batchId] })
    },
    onError: (error) => message.error(error.message),
  })

  return (
    <Card title="人工结论">
      <Space direction="vertical" className="page-stack">
        {readOnly ? <Alert type="warning" showIcon title="批次已完成" description="批次完成后默认只读，人工结论已锁定。" /> : null}
        {detail.aiResult ? (
          <Space direction="vertical" className="page-stack">
            <Radio.Group disabled={readOnly} value={result} onChange={(event) => setResult(event.target.value)} options={humanReviewOptions} />
            <Input.TextArea rows={6} placeholder="补充意见" value={comment} disabled={readOnly} onChange={(event) => setComment(event.target.value)} />
            <Space>
              <Button type="primary" disabled={readOnly} loading={saveMutation.isPending} onClick={() => saveMutation.mutate()}>保存</Button>
              <Button
                disabled={readOnly}
                loading={saveMutation.isPending}
                onClick={() => saveMutation.mutate(undefined, { onSuccess: () => detail.nextStory && navigate(`/batches/${batchId}/reviews/${detail.nextStory.id}`) })}
              >
                保存并下一条
              </Button>
            </Space>
          </Space>
        ) : <Alert type="info" showIcon title="当前需求缺少AI结果" description="请先在AI结果管理中上传本批次结果。" />}
      </Space>
    </Card>
  )
}

function DashboardPage({ batchId }: { batchId: string }) {
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

  const stats = buildStats(workspaceQuery.data)
  return (
    <Space direction="vertical" size="large" className="page-stack">
      <Row gutter={[16, 16]}>
        <Col xs={24} md={8}><Card><Statistic title="需求总数" value={stats.total} /></Card></Col>
        <Col xs={24} md={8}><Card><Statistic title="AI已分析" value={stats.aiDone} suffix={`/ ${stats.total}`} /></Card></Col>
        <Col xs={24} md={8}><Card><Statistic title="人工已确认" value={stats.reviewed} suffix={`/ ${stats.aiDone}`} /></Card></Col>
      </Row>
      <Row gutter={[16, 16]}>
        <Col span={24} lg={12}><DistributionCard title="AI判断分布" data={stats.aiDistribution} labels={aiVerdictLabels} /></Col>
        <Col span={24} lg={12}><DistributionCard title="人工结论分布" data={stats.humanDistribution} labels={humanReviewLabels} /></Col>
      </Row>
      <Row gutter={[16, 16]}>
        <Col span={24} lg={12}><GroupedProgress title="按负责人统计" rows={stats.byOwner} /></Col>
        <Col span={24} lg={12}><GroupedProgress title="按应用统计" rows={stats.byApplication} /></Col>
      </Row>
      <Card>
        <Space>
          {workspaceQuery.data.batch.status === 'COMPLETED' ? (
            <Button loading={reopenMutation.isPending} onClick={() => reopenMutation.mutate()}>重新打开批次</Button>
          ) : (
            <Button type="primary" loading={completeMutation.isPending} onClick={() => completeMutation.mutate(false)}>完成批次</Button>
          )}
          <Text type="secondary">完成前会检查仍未确认的 AI 结果。</Text>
        </Space>
      </Card>
      <Card title="操作日志">
        <List
          dataSource={operationLogQuery.data ?? []}
          locale={{ emptyText: '暂无完成或重新打开记录' }}
          renderItem={(item) => (
            <List.Item>
              <Tag color={item.action === 'COMPLETE' ? 'green' : 'gold'}>{item.action === 'COMPLETE' ? '完成批次' : '重新打开'}</Tag>
              <Text>{new Date(item.created_at).toLocaleString()}</Text>
              {item.action === 'COMPLETE' ? <Text type="secondary">{item.forced ? `强制完成，当时仍有 ${item.pending_count ?? 0} 条未确认` : '正常完成'}</Text> : null}
            </List.Item>
          )}
        />
      </Card>
    </Space>
  )
}

function StoryCard({ story }: { story: ReviewStory }) {
  return (
    <Card title="需求信息">
      <Descriptions column={1} size="small">
        <Descriptions.Item label="编码">{story.story_code}</Descriptions.Item>
        <Descriptions.Item label="名称">{story.story_name}</Descriptions.Item>
        <Descriptions.Item label="负责人">{story.owners_text}</Descriptions.Item>
        <Descriptions.Item label="项目">{story.project_name || '-'}</Descriptions.Item>
        <Descriptions.Item label="应用">{story.application_name || '-'}</Descriptions.Item>
      </Descriptions>
    </Card>
  )
}

function AiResultCard({ result, evidence }: { result: AiReviewResult | null; evidence: BatchWorkspace['evidence'] }) {
  if (!result) return <Card title="AI分析"><Empty description="未分析" /></Card>
  return (
    <Card title="AI分析">
      <Descriptions column={1} size="small">
        <Descriptions.Item label="AI判断">{result.verdict ? aiVerdictLabels[result.verdict] : '未分析'}</Descriptions.Item>
        <Descriptions.Item label="置信度">{result.confidence ?? '-'}</Descriptions.Item>
        <Descriptions.Item label="分析摘要">{result.summary || '-'}</Descriptions.Item>
        <Descriptions.Item label="已实现内容">{result.implemented_content || '-'}</Descriptions.Item>
        <Descriptions.Item label="缺失内容">{result.missing_content || '-'}</Descriptions.Item>
        <Descriptions.Item label="风险">{result.risks || '-'}</Descriptions.Item>
        <Descriptions.Item label="建议测试点">{result.test_points || '-'}</Descriptions.Item>
      </Descriptions>
      <Divider />
      <List
        header="代码证据"
        dataSource={evidence}
        locale={{ emptyText: '暂无代码证据' }}
        renderItem={(item) => (
          <List.Item>
            <List.Item.Meta
              title={<Text className="evidence-title">{item.repository_name} / {item.file_path}</Text>}
              description={<Text type="secondary" className="evidence-description">{`${item.evidence_type}：${item.description}${item.start_line ? `（${item.start_line}-${item.end_line ?? item.start_line}行）` : ''}`}</Text>}
            />
          </List.Item>
        )}
      />
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

function DistributionCard<T extends string>({ title, data, labels }: { title: string; data: Record<T, number>; labels: Record<T, string> }) {
  return (
    <Card title={title}>
      <Space wrap>
        {(Object.entries(labels) as [T, string][]).map(([key, label]) => <Tag key={key}>{label}: {data[key] ?? 0}</Tag>)}
      </Space>
    </Card>
  )
}

function GroupedProgress({ title, rows }: { title: string; rows: { name: string; total: number; reviewed: number }[] }) {
  return (
    <Card title={title}>
      <Table
        size="small"
        rowKey="name"
        pagination={false}
        dataSource={rows}
        columns={[
          { title: '名称', dataIndex: 'name' },
          { title: '总数', dataIndex: 'total', width: 90 },
          { title: '已确认', dataIndex: 'reviewed', width: 90 },
        ]}
      />
    </Card>
  )
}

function buildStats(workspace: BatchWorkspace) {
  const resultByStory = new Map(workspace.results.map((result) => [result.story_id, result]))
  const reviewByStory = new Map(workspace.humanReviews.map((review) => [review.story_id, review]))
  const aiDistribution = { IMPLEMENTED: 0, PARTIAL: 0, NOT_IMPLEMENTED: 0, UNCERTAIN: 0 }
  const humanDistribution = { CORRECT: 0, PARTIALLY_CORRECT: 0, INCORRECT: 0, NEED_DISCUSSION: 0 }
  const grouped = new Map<string, { name: string; total: number; reviewed: number }>()
  const groupedApp = new Map<string, { name: string; total: number; reviewed: number }>()

  workspace.results.forEach((result) => {
    if (result.verdict) aiDistribution[result.verdict] += 1
  })
  workspace.humanReviews.forEach((review) => { humanDistribution[review.result] += 1 })
  workspace.stories.forEach((story) => {
    const reviewed = reviewByStory.has(story.id) ? 1 : 0
    addGrouped(grouped, story.owners_text || '未分配', reviewed)
    addGrouped(groupedApp, story.application_name || '未填写应用', reviewed)
  })

  return {
    total: workspace.stories.length,
    aiDone: workspace.stories.filter((story) => resultByStory.has(story.id)).length,
    reviewed: workspace.humanReviews.length,
    aiDistribution,
    humanDistribution,
    byOwner: [...grouped.values()],
    byApplication: [...groupedApp.values()],
  }
}

function addGrouped(map: Map<string, { name: string; total: number; reviewed: number }>, name: string, reviewed: number) {
  const current = map.get(name) ?? { name, total: 0, reviewed: 0 }
  current.total += 1
  current.reviewed += reviewed
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
