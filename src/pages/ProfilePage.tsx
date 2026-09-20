import { useEffect, useMemo, useState } from 'react'
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Col,
  Form,
  Input,
  Modal,
  Popconfirm,
  Radio,
  Row,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  changeMyPassword,
  disableMyGitIdentity,
  enqueueMyGitEmailDiscovery,
  getMyGitEmailDiscovery,
  getMyGitIdentity,
  saveMyGitIdentity,
  saveMyGitIdentityFromCandidate,
  updateMyDisplayName,
} from '../lib/api'
import {
  GIT_IDENTITY_STATUS_META,
  describeGitEmailCandidate,
  describeGitEmailDiscoveryPhase,
  describeGitIdentityError,
  parseAuthorNameAliases,
} from '../lib/git-identity'
import type { DeveloperIdentityStatus, MyGitIdentityRecord, UserRole } from '../types'

const { Title, Text } = Typography

const roleMeta: Record<UserRole, { label: string; color: string }> = {
  ADMIN: { label: '管理员', color: 'green' },
  REVIEWER: { label: '审核者', color: 'blue' },
  VIEWER: { label: '查看者', color: 'default' },
}

interface ProfilePageProps {
  email: string | null
  displayName: string | null
  role: UserRole | undefined
}

interface PasswordFormValues {
  currentPassword: string
  newPassword: string
  confirmPassword: string
}

function containsControlCharacter(value: string) {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0
    return codePoint < 32 || codePoint === 127
  })
}

const identityStatusMeta = GIT_IDENTITY_STATUS_META

interface GitIdentityFormValues {
  displayName: string
  employeeCode?: string
  gitlabUsername?: string
  email?: string
  aliases?: string
}

/**
 * 个人中心里的 Git 身份自助维护。
 *
 * 主路径是"填 GitLab 用户名 → 本地 Worker 去 GitLab 反查你自己提的 MR → 从那些提交里
 * 列出你用过的邮箱 → 你点选一个"。这样人不用手打邮箱，也就不会打错；点选的那一条带着
 * GitLab 提交作为证据，存成"生效中"。手输邮箱仍然保留，但没有证据，只能存成"未验证"。
 *
 * 明文邮箱从头到尾不进浏览器：候选只带 y***@kingdee.com 这种脱敏形式和 candidate_id。
 */
function MyGitIdentityCard({ profileDisplayName }: { profileDisplayName: string | null }) {
  const { message } = AntApp.useApp()
  const queryClient = useQueryClient()
  const [form] = Form.useForm<GitIdentityFormValues>()
  const [editing, setEditing] = useState<MyGitIdentityRecord | null>(null)
  const [open, setOpen] = useState(false)
  const [manualMode, setManualMode] = useState(false)
  const [discoveryId, setDiscoveryId] = useState<string | null>(null)
  const [discoveryStartedAt, setDiscoveryStartedAt] = useState<number | null>(null)
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(null)
  // 只用来驱动"排队超过 3 分钟"这句话的重算；不参与任何业务判定。
  const [nowTick, setNowTick] = useState(() => Date.now())

  const identityQuery = useQuery({ queryKey: ['my-git-identity'], queryFn: getMyGitIdentity })
  const identityProfile = identityQuery.data
  const identities = useMemo(
    () => identityProfile?.identities ?? [],
    [identityProfile],
  )
  const activeIdentities = identities.filter((item) => item.verification_status !== 'DISABLED')

  const discoveryQuery = useQuery({
    queryKey: ['my-git-email-discovery', discoveryId],
    enabled: discoveryId !== null,
    queryFn: () => getMyGitEmailDiscovery(discoveryId!),
    // 只在未完成时轮询：完成后立刻停，避免弹窗开着就一直打 RPC。
    refetchInterval: (query) => {
      const status = query.state.data?.status
      return status === 'QUEUED' || status === 'RUNNING' ? 2000 : false
    },
  })
  const discovery = discoveryId === null ? null : discoveryQuery.data ?? null
  const phase = describeGitEmailDiscoveryPhase(
    discovery,
    discoveryStartedAt === null ? 0 : nowTick - discoveryStartedAt,
  )
  const waiting = phase.kind === 'WAITING_WORKER' || phase.kind === 'RUNNING'
  const candidates = discovery?.candidates ?? []

  useEffect(() => {
    if (!waiting) return
    const timer = setInterval(() => setNowTick(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [waiting])

  const resetDiscovery = () => {
    setDiscoveryId(null)
    setDiscoveryStartedAt(null)
    setSelectedCandidateId(null)
  }

  const discoverMutation = useMutation({
    mutationFn: (gitlabUsername: string) => enqueueMyGitEmailDiscovery(gitlabUsername),
    onSuccess: (id) => {
      setSelectedCandidateId(null)
      setDiscoveryId(id)
      setDiscoveryStartedAt(Date.now())
      setNowTick(Date.now())
    },
    onError: (error) => message.error(describeGitIdentityError(error.message)),
  })

  const onSaved = async (result: { masked_email: string; claimed_existing_developer: boolean }, verified: boolean) => {
    setOpen(false)
    setEditing(null)
    setManualMode(false)
    resetDiscovery()
    form.resetFields()
    await queryClient.invalidateQueries({ queryKey: ['my-git-identity'] })
    message.success(
      `${result.claimed_existing_developer ? '已认领管理员预先录入的开发人员身份，并绑定 ' : 'Git 邮箱已保存：'}`
      + `${result.masked_email}${verified ? '（生效中）' : '（未验证）'}`,
    )
  }

  const saveCandidateMutation = useMutation({
    mutationFn: (values: GitIdentityFormValues) => saveMyGitIdentityFromCandidate({
      candidateId: selectedCandidateId!,
      displayName: values.displayName.trim(),
      employeeCode: values.employeeCode?.trim() || null,
      // 留空就用 GitLab 提交里真实出现过的作者名，不逼人自己猜 git config user.name。
      authorNameAliases: values.aliases === undefined || values.aliases.trim() === ''
        ? null
        : parseAuthorNameAliases(values.aliases),
      gitlabUsername: values.gitlabUsername?.trim() || null,
      gitlabUserId: discovery?.gitlab_user_id ?? null,
      gitIdentityId: editing?.git_identity_id ?? null,
      expectedRevision: editing?.git_revision ?? null,
    }),
    onSuccess: (result) => onSaved(result, result.verification_status === 'VERIFIED'),
    onError: (error) => message.error(describeGitIdentityError(error.message)),
  })

  const saveManualMutation = useMutation({
    mutationFn: (values: GitIdentityFormValues) => saveMyGitIdentity({
      gitIdentityId: editing?.git_identity_id ?? null,
      displayName: values.displayName.trim(),
      employeeCode: values.employeeCode?.trim() || null,
      email: (values.email ?? '').trim(),
      authorNameAliases: parseAuthorNameAliases(values.aliases),
      gitlabUsername: values.gitlabUsername?.trim() || null,
      gitlabUserId: null,
      expectedRevision: editing?.git_revision ?? null,
    }),
    onSuccess: (result) => onSaved(result, false),
    onError: (error) => message.error(describeGitIdentityError(error.message)),
  })

  const disableMutation = useMutation({
    mutationFn: (record: MyGitIdentityRecord) =>
      disableMyGitIdentity(record.git_identity_id, record.git_revision),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['my-git-identity'] })
      message.success('已停用该 Git 邮箱；历史分析记录仍然保留')
    },
    onError: (error) => message.error(describeGitIdentityError(error.message)),
  })

  const defaultGitlabUsername = () => identities.find((item) => item.gitlab_username)?.gitlab_username ?? undefined

  const beginCreate = () => {
    setEditing(null)
    setManualMode(false)
    resetDiscovery()
    form.setFieldsValue({
      displayName: identityProfile?.display_name ?? profileDisplayName ?? '',
      employeeCode: identityProfile?.employee_code ?? undefined,
      gitlabUsername: defaultGitlabUsername(),
      email: '',
      aliases: '',
    })
    setOpen(true)
  }

  const beginEdit = (record: MyGitIdentityRecord) => {
    setEditing(record)
    setManualMode(false)
    resetDiscovery()
    form.setFieldsValue({
      displayName: identityProfile?.display_name ?? profileDisplayName ?? '',
      employeeCode: identityProfile?.employee_code ?? undefined,
      gitlabUsername: record.gitlab_username ?? defaultGitlabUsername(),
      // 数据库里只有 HMAC，没有明文可回显；换邮箱要么重新查找，要么手输。
      email: '',
      aliases: record.author_name_aliases.join('，'),
    })
    setOpen(true)
  }

  return (
    <Card className="profile-card">
      <div className="profile-section-heading">
        <Title level={4}>Git 身份</Title>
        <Text type="secondary">
          告诉平台你本机 Git 提交用的是哪个邮箱，需求分析才能把你的提交和你负责的需求对上。
          邮箱只在数据库函数内计算 HMAC，页面、业务表和日志里都只有脱敏形式。
        </Text>
      </div>

      {identityQuery.isError ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 16 }}
          title="读取 Git 身份失败"
          description={describeGitIdentityError(
            identityQuery.error instanceof Error ? identityQuery.error.message : '未知错误',
          )}
        />
      ) : null}

      {!identityQuery.isLoading && activeIdentities.length === 0 ? (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          title="还没有配置 Git 邮箱"
          description="未配置时，你的提交只能靠需求号等文本线索关联，作者维度的归属规则会自动跳过。"
        />
      ) : null}

      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <div className="profile-form-actions">
          <Button type="primary" onClick={beginCreate}>新增 Git 邮箱</Button>
          <Text type="secondary">
            {identityProfile?.display_name
              ? `当前开发人员姓名：${identityProfile.display_name}${identityProfile.employee_code ? `（${identityProfile.employee_code}）` : ''}`
              : '姓名需与需求里的开发人员写法一致'}
          </Text>
        </div>
        <Table<MyGitIdentityRecord>
          rowKey="git_identity_id"
          size="middle"
          loading={identityQuery.isLoading}
          dataSource={identities}
          pagination={false}
          locale={{ emptyText: '暂无 Git 邮箱' }}
          scroll={{ x: 760 }}
          columns={[
            { title: 'Git 邮箱', dataIndex: 'masked_email', width: 180, render: (value: string | null) => value ?? '未配置' },
            {
              title: '作者别名',
              dataIndex: 'author_name_aliases',
              width: 180,
              render: (values: string[]) => (values.length ? values.join('、') : '—'),
            },
            { title: 'GitLab 用户名', dataIndex: 'gitlab_username', width: 140, render: (value: string | null) => value ?? '—' },
            {
              title: '状态',
              dataIndex: 'verification_status',
              width: 100,
              render: (value: DeveloperIdentityStatus) => (
                <Tag color={identityStatusMeta[value].color}>{identityStatusMeta[value].label}</Tag>
              ),
            },
            {
              title: '更新时间',
              dataIndex: 'updated_at',
              width: 170,
              render: (value: string) => new Date(value).toLocaleString(),
            },
            {
              title: '操作',
              width: 150,
              render: (_value, record) => (
                record.verification_status === 'DISABLED' ? (
                  <Text type="secondary">已停用</Text>
                ) : (
                  <Space size={0}>
                    <Button type="link" onClick={() => beginEdit(record)}>编辑</Button>
                    <Popconfirm
                      title="停用这个 Git 邮箱？"
                      description="停用后新的分析不再用它匹配作者；已完成的分析记录保持不变。"
                      okText="停用"
                      cancelText="取消"
                      okButtonProps={{ loading: disableMutation.isPending }}
                      onConfirm={() => disableMutation.mutate(record)}
                    >
                      <Button type="link" danger>停用</Button>
                    </Popconfirm>
                  </Space>
                )
              ),
            },
          ]}
        />
      </Space>

      <Modal
        open={open}
        width={640}
        title={editing ? '更换 / 确认 Git 邮箱' : '新增 Git 邮箱'}
        onCancel={() => { setOpen(false); setEditing(null) }}
        afterClose={() => { form.resetFields(); resetDiscovery(); setManualMode(false) }}
        destroyOnHidden
        footer={[
          <Button key="cancel" onClick={() => { setOpen(false); setEditing(null) }}>取消</Button>,
          manualMode ? (
            <Button
              key="save-manual"
              type="primary"
              danger
              loading={saveManualMutation.isPending}
              onClick={() => form.submit()}
            >
              仍然手动保存（未验证）
            </Button>
          ) : (
            <Button
              key="save-candidate"
              type="primary"
              disabled={selectedCandidateId === null}
              loading={saveCandidateMutation.isPending}
              onClick={() => form.submit()}
            >
              保存所选邮箱
            </Button>
          ),
        ]}
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={(values) => (manualMode ? saveManualMutation : saveCandidateMutation).mutate(values)}
        >
          <Form.Item
            name="displayName"
            label="开发人员姓名"
            extra="必须与需求里「开发人员」一栏的写法一致，否则无法把需求和你的提交对上。"
            rules={[{ required: true, whitespace: true, message: '请输入与需求一致的姓名' }, { max: 64, message: '姓名不能超过 64 个字符' }]}
          >
            <Input placeholder="例如：张三" />
          </Form.Item>
          <Form.Item name="employeeCode" label="员工号（推荐）" extra="有同名同事时用它区分。">
            <Input placeholder="例如：E-10086" />
          </Form.Item>

          {manualMode ? (
            <>
              <Alert
                type="warning"
                showIcon
                style={{ marginBottom: 16 }}
                title="手动填写的邮箱会被标记为「未验证」"
                description="平台没有证据证明这个邮箱是你的提交邮箱，作者维度的归属规则不会采用它。建议改用上面的查找方式。"
              />
              <Form.Item
                name="email"
                label="Git author email"
                extra={editing
                  ? `数据库里只存 HMAC，没有明文可回显；修改请重新输入完整邮箱。当前：${editing.masked_email ?? '未配置'}`
                  : '本机 git config user.email 的值。'}
                rules={[{ required: true, type: 'email', message: '请输入有效邮箱' }]}
              >
                <Input autoComplete="off" placeholder="you@example.com" />
              </Form.Item>
              <Form.Item name="aliases" label="Git 作者别名" extra="多个用逗号分隔；填写 git config user.name 可能出现的写法。">
                <Input placeholder="例如：Zhang San，zhangsan" />
              </Form.Item>
              <Form.Item name="gitlabUsername" label="GitLab 用户名">
                <Input placeholder="选填" />
              </Form.Item>
              <Button type="link" style={{ paddingLeft: 0 }} onClick={() => setManualMode(false)}>
                ← 回到按 GitLab 用户名查找
              </Button>
            </>
          ) : (
            <>
              <Form.Item
                name="gitlabUsername"
                label="GitLab 用户名"
                extra="就是 git.kingdee.com 个人设置里 Account 页面的 Path，例如 yuxuan_xue。"
                rules={[
                  { required: true, whitespace: true, message: '请输入 GitLab 用户名' },
                  { pattern: /^[A-Za-z0-9][A-Za-z0-9_.-]{0,48}$/, message: '只能包含字母、数字、下划线、点和短横线' },
                ]}
              >
                <Input
                  placeholder="yuxuan_xue"
                  autoComplete="off"
                  onChange={() => resetDiscovery()}
                />
              </Form.Item>
              <div className="profile-form-actions" style={{ marginBottom: 16 }}>
                <Button
                  onClick={() => {
                    const username = (form.getFieldValue('gitlabUsername') as string | undefined)?.trim() ?? ''
                    if (username === '') {
                      message.warning('请先填写 GitLab 用户名')
                      return
                    }
                    discoverMutation.mutate(username)
                  }}
                  loading={discoverMutation.isPending || waiting}
                >
                  {discovery === null ? '查找我的提交邮箱' : '重新查找'}
                </Button>
                <Text type="secondary">
                  平台会读取你在四个仓库里提的合并申请，从其中的提交里取出你用过的邮箱。
                </Text>
              </div>

              {phase.kind === 'WAITING_WORKER' || phase.kind === 'RUNNING' ? (
                <Alert type="info" showIcon style={{ marginBottom: 16 }} title={phase.hint} />
              ) : null}
              {phase.kind === 'NO_WORKER' ? (
                <Alert type="warning" showIcon style={{ marginBottom: 16 }} title="没有可用的 Worker" description={phase.hint} />
              ) : null}
              {phase.kind === 'FAILED' ? (
                <Alert type="error" showIcon style={{ marginBottom: 16 }} title="查找失败" description={phase.hint} />
              ) : null}
              {phase.kind === 'DONE_EMPTY' ? (
                <Alert type="warning" showIcon style={{ marginBottom: 16 }} title="没有找到提交邮箱" description={phase.hint} />
              ) : null}
              {phase.kind === 'DONE' ? (
                <Alert type="success" showIcon style={{ marginBottom: 16 }} title={phase.hint} />
              ) : null}

              {candidates.length > 0 ? (
                <Form.Item label="选择你的提交邮箱" required>
                  <Radio.Group
                    value={selectedCandidateId}
                    onChange={(event) => setSelectedCandidateId(event.target.value as string)}
                    style={{ display: 'flex', flexDirection: 'column', gap: 12, width: '100%' }}
                  >
                    {candidates.map((candidate) => (
                      <Radio key={candidate.candidate_id} value={candidate.candidate_id} disabled={candidate.already_bound}>
                        <Space direction="vertical" size={0}>
                          <Text strong>
                            {candidate.masked_email}
                            {candidate.already_bound ? <Tag style={{ marginLeft: 8 }}>已被绑定</Tag> : null}
                          </Text>
                          <Text type="secondary">{describeGitEmailCandidate(candidate)}</Text>
                          {candidate.merge_request_refs.length > 0 ? (
                            <Text type="secondary">来自 {candidate.merge_request_refs.join('、')}</Text>
                          ) : null}
                        </Space>
                      </Radio>
                    ))}
                  </Radio.Group>
                </Form.Item>
              ) : null}

              <Form.Item
                name="aliases"
                label="Git 作者别名（留空则用 GitLab 提交里的作者名）"
                extra="平台会把所选邮箱在提交里实际出现过的作者名一起存下来。"
              >
                <Input placeholder="例如：Zhang San，zhangsan" />
              </Form.Item>
              <Button type="link" style={{ paddingLeft: 0 }} onClick={() => setManualMode(true)}>
                查不到？改为手动填写邮箱（会标记为未验证）
              </Button>
            </>
          )}
        </Form>
      </Modal>
    </Card>
  )
}

export function ProfilePage({ email, displayName, role }: ProfilePageProps) {
  const { message } = AntApp.useApp()
  const queryClient = useQueryClient()
  const [profileForm] = Form.useForm<{ displayName: string }>()
  const [passwordForm] = Form.useForm<PasswordFormValues>()
  const [passwordModalOpen, setPasswordModalOpen] = useState(false)
  const updateNameMutation = useMutation({
    mutationFn: (nextDisplayName: string) => updateMyDisplayName(nextDisplayName),
    onSuccess: (profile) => {
      queryClient.setQueryData(['my-profile'], profile)
      queryClient.invalidateQueries({ queryKey: ['admin-users'] })
      profileForm.setFieldValue('displayName', profile.display_name ?? '')
      message.success('用户名已更新')
    },
    onError: (error) => message.error(error.message),
  })
  const changePasswordMutation = useMutation({
    mutationFn: ({ currentPassword, newPassword }: PasswordFormValues) =>
      changeMyPassword(currentPassword, newPassword),
    onSuccess: ({ otherSessionsRevoked }) => {
      setPasswordModalOpen(false)
      passwordForm.resetFields()
      message.success(
        otherSessionsRevoked
          ? '密码已修改，其他设备需要用新密码重新登录'
          : '密码已修改；其他设备的登录未能自动退出，建议手动检查',
      )
    },
    onError: (error) => message.error(error.message),
  })

  useEffect(() => {
    profileForm.setFieldValue('displayName', displayName ?? '')
  }, [displayName, profileForm])

  const accountName = displayName?.trim() || email?.split('@')[0] || '用户'
  const currentRole = role ? roleMeta[role] : { label: '未配置', color: 'default' }

  return (
    <Space direction="vertical" size={24} className="profile-page">
      <div className="profile-page-header">
        <div>
          <Text className="profile-eyebrow">ACCOUNT SETTINGS</Text>
          <Title level={2}>个人中心</Title>
          <Text type="secondary">管理你的公开用户名、账号信息、登录密码与 Git 身份。</Text>
        </div>
      </div>

      <Card className="profile-card profile-account-card">
        <Row gutter={0} align="stretch">
          <Col xs={24} md={9} lg={8}>
            <div className="profile-summary">
              <Title level={4}>{accountName}</Title>
              <Text className="profile-email">{email || '未绑定邮箱'}</Text>
              <Tag color={currentRole.color === 'default' ? undefined : currentRole.color}>
                {currentRole.label}
              </Tag>
              <Text type="secondary" className="profile-summary-hint">账号资料仅你本人可修改</Text>
            </div>
          </Col>
          <Col xs={24} md={15} lg={16}>
            <div className="profile-editor">
              <div className="profile-section-heading">
                <Title level={4}>基本资料</Title>
                <Text type="secondary">设置一个便于团队成员识别你的用户名。</Text>
              </div>
              <Form
                form={profileForm}
                layout="vertical"
                className="profile-name-form"
                onFinish={({ displayName: nextDisplayName }) => updateNameMutation.mutate(nextDisplayName)}
              >
                <Form.Item
                  name="displayName"
                  label="用户名"
                  extra="用于页面顶部、用户管理和后续操作记录中的用户识别。"
                  rules={[
                    { required: true, whitespace: true, message: '请输入用户名' },
                    { max: 32, message: '用户名不能超过 32 个字符' },
                    {
                      validator: (_rule, value: string | undefined) =>
                        value && containsControlCharacter(value)
                          ? Promise.reject(new Error('用户名不能包含控制字符'))
                          : Promise.resolve(),
                    },
                  ]}
                >
                  <Input size="large" maxLength={32} showCount placeholder="请输入用户名" autoComplete="nickname" />
                </Form.Item>
                <div className="profile-form-actions">
                  <Button size="large" type="primary" htmlType="submit" loading={updateNameMutation.isPending}>
                    保存用户名
                  </Button>
                  <Text type="secondary">保存后将在全站同步显示</Text>
                </div>
              </Form>
            </div>
          </Col>
        </Row>
      </Card>

      <Card className="profile-card profile-security-card">
        <div className="profile-security-row">
          <div className="profile-security-text">
            <Title level={4}>登录密码</Title>
            <Text type="secondary">
              {email
                ? '用于邮箱密码登录。修改后当前设备不掉线，其他设备的登录稍后失效。'
                : '微信登录账号没有邮箱密码，绑定邮箱后才能设置和修改密码。'}
            </Text>
          </div>
          {email ? (
            <Button size="large" onClick={() => setPasswordModalOpen(true)}>修改密码</Button>
          ) : (
            <Tooltip title="当前账号未绑定邮箱">
              <Button size="large" disabled>修改密码</Button>
            </Tooltip>
          )}
        </div>
      </Card>

      <MyGitIdentityCard profileDisplayName={displayName} />

      <Modal
        title="修改密码"
        open={passwordModalOpen}
        okText="确认修改"
        confirmLoading={changePasswordMutation.isPending}
        onOk={() => passwordForm.submit()}
        onCancel={() => setPasswordModalOpen(false)}
        // 关闭动画结束后再清空，避免关闭过程中字段闪成空白。
        afterClose={() => passwordForm.resetFields()}
        destroyOnHidden
      >
        <Form
          form={passwordForm}
          layout="vertical"
          requiredMark={false}
          onFinish={(values) => changePasswordMutation.mutate(values)}
        >
          <Form.Item
            name="currentPassword"
            label="当前密码"
            rules={[{ required: true, message: '请输入当前密码' }]}
          >
            <Input.Password autoComplete="current-password" placeholder="请输入当前密码" />
          </Form.Item>
          <Form.Item
            name="newPassword"
            label="新密码"
            rules={[
              { required: true, message: '请输入新密码' },
              { min: 6, message: '密码至少需要 6 个字符' },
              ({ getFieldValue }) => ({
                validator: (_rule, value: string | undefined) =>
                  value && value === getFieldValue('currentPassword')
                    ? Promise.reject(new Error('新密码不能与当前密码相同'))
                    : Promise.resolve(),
              }),
            ]}
          >
            <Input.Password autoComplete="new-password" placeholder="至少 6 个字符" />
          </Form.Item>
          <Form.Item
            name="confirmPassword"
            label="确认新密码"
            dependencies={['newPassword']}
            rules={[
              { required: true, message: '请再次输入新密码' },
              ({ getFieldValue }) => ({
                validator: (_rule, value: string | undefined) =>
                  !value || getFieldValue('newPassword') === value
                    ? Promise.resolve()
                    : Promise.reject(new Error('两次输入的密码不一致')),
              }),
            ]}
          >
            <Input.Password autoComplete="new-password" placeholder="再次输入新密码" />
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  )
}
