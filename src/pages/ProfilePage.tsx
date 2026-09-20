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
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  changeMyPassword,
  deleteMyGitIdentity,
  disableMyGitIdentity,
  enqueueMyGitEmailDiscovery,
  getMyGitEmailDiscovery,
  getMyGitIdentity,
  saveMyGitIdentityFromCandidate,
  updateMyGitIdentityDetails,
  updateMyIdentityProfile,
} from '../lib/api'
import {
  GIT_IDENTITY_STATUS_META,
  describeGitEmailDiscoveryPhase,
  describeGitIdentityError,
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
  gitlabUsername?: string
}

/** 编辑一行 Git 身份时能改的东西：只有当初自己填进去的两列，邮箱不在其中。 */
interface GitIdentityEditFormValues {
  authorNameAliases?: string[]
  gitlabUsername?: string
}

/**
 * 个人中心里的 Git 身份自助维护。
 *
 * 唯一路径是"填 GitLab 用户名 → 本地 Worker 去 GitLab 反查你自己提的 MR → 从那些提交里
 * 列出你用过的邮箱 → 你点选一个"。**不提供手输邮箱**：手输没有任何证据，而没有证据的邮箱
 * 在归属引擎里根本不参与匹配（story-scope 只取 verification_status='VERIFIED'），
 * 留着它只会让人以为配好了。真查不到（新人还没提过 MR）由管理员在「用户管理」页代录。
 *
 * 候选按产品要求展示邮箱原文（只给本人自己的候选）；正式身份表里只有 HMAC 与脱敏形式。
 * 姓名与员工号不在这里维护，统一来自上面的「基本资料」。
 */
function MyGitIdentityCard({ profileDisplayName }: { profileDisplayName: string | null }) {
  const { message } = AntApp.useApp()
  const queryClient = useQueryClient()
  const [form] = Form.useForm<GitIdentityFormValues>()
  const [editForm] = Form.useForm<GitIdentityEditFormValues>()
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<MyGitIdentityRecord | null>(null)
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

  const onSaved = async (result: { masked_email: string; claimed_existing_developer: boolean }) => {
    setOpen(false)
    resetDiscovery()
    form.resetFields()
    await queryClient.invalidateQueries({ queryKey: ['my-git-identity'] })
    message.success(
      `${result.claimed_existing_developer ? '已认领管理员预先录入的开发人员身份，并绑定 ' : 'Git 邮箱已保存：'}`
      + `${result.masked_email}（生效中）`,
    )
  }

  const saveCandidateMutation = useMutation({
    mutationFn: (values: GitIdentityFormValues) => saveMyGitIdentityFromCandidate({
      candidateId: selectedCandidateId!,
      // 姓名与员工号只有一个来源：个人中心的「基本资料」。
      displayName: (identityProfile?.display_name ?? profileDisplayName ?? '').trim(),
      employeeCode: identityProfile?.employee_code ?? null,
      // 别名不让人填：数据库直接用这个邮箱在提交里真实出现过的作者名。
      authorNameAliases: null,
      gitlabUsername: values.gitlabUsername?.trim() || null,
      gitlabUserId: discovery?.gitlab_user_id ?? null,
      // 已保存的邮箱不可编辑（库里只有 HMAC），所以这里永远是"新增一条"。
      gitIdentityId: null,
      expectedRevision: null,
    }),
    onSuccess: (result) => onSaved(result),
    onError: (error) => message.error(describeGitIdentityError(error.message)),
  })

  const editMutation = useMutation({
    mutationFn: (values: GitIdentityEditFormValues) => updateMyGitIdentityDetails({
      gitIdentityId: editing!.git_identity_id,
      authorNameAliases: (values.authorNameAliases ?? [])
        .map((alias) => alias.trim())
        .filter((alias) => alias !== ''),
      gitlabUsername: values.gitlabUsername?.trim() || null,
      expectedRevision: editing!.git_revision,
    }),
    onSuccess: async () => {
      setEditing(null)
      await queryClient.invalidateQueries({ queryKey: ['my-git-identity'] })
      message.success('已更新')
    },
    onError: (error) => message.error(describeGitIdentityError(error.message)),
  })

  /**
   * 删除是真删。数据库只在这条身份从没被分析快照冻结过时才放行，
   * 否则回 GIT_IDENTITY_IN_USE —— 那种情况要走「停用」，不能静默替换成另一种语义。
   */
  const deleteMutation = useMutation({
    mutationFn: (record: MyGitIdentityRecord) =>
      deleteMyGitIdentity(record.git_identity_id, record.git_revision),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['my-git-identity'] })
      message.success('已删除该 Git 邮箱')
    },
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

  const beginEdit = (record: MyGitIdentityRecord) => {
    setEditing(record)
    editForm.setFieldsValue({
      authorNameAliases: record.author_name_aliases,
      gitlabUsername: record.gitlab_username ?? undefined,
    })
  }

  const defaultGitlabUsername = () => identities.find((item) => item.gitlab_username)?.gitlab_username ?? undefined

  /** 新增一个 Git 邮箱。已保存的邮箱不可编辑（库里只有 HMAC，没有明文），只能新增或停用。 */
  const beginBind = () => {
    resetDiscovery()
    form.setFieldsValue({ gitlabUsername: defaultGitlabUsername() })
    setOpen(true)
  }

  return (
    <Card className="profile-card">
      <div className="profile-section-heading">
        <Title level={4}>Git 身份</Title>
        <Text type="secondary">
          告诉平台你本机 Git 提交用的是哪个邮箱，需求分析才能把你的提交和你负责的需求对上。
          邮箱由平台从你在 GitLab 上的提交里反查出来；存进身份表的只有它的 HMAC 与脱敏形式。
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
          <Button type="primary" onClick={beginBind}>新增 Git 邮箱</Button>
          <Text type="secondary">
            按 GitLab 用户名反查你的提交邮箱，选中即可绑定；姓名与员工号在上面「基本资料」里维护。
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
              width: 190,
              render: (_value, record) => (
                <Space size={4}>
                  {record.verification_status === 'DISABLED' ? (
                    <Text type="secondary">已停用</Text>
                  ) : (
                    <>
                      <Button type="link" style={{ padding: 0 }} onClick={() => beginEdit(record)}>
                        编辑
                      </Button>
                      <Popconfirm
                        title="停用这个 Git 邮箱？"
                        description="停用后新的分析不再用它匹配作者；已完成的分析记录保持不变。"
                        okText="停用"
                        cancelText="取消"
                        okButtonProps={{ loading: disableMutation.isPending }}
                        onConfirm={() => disableMutation.mutate(record)}
                      >
                        <Button type="link" danger style={{ padding: 0 }}>停用</Button>
                      </Popconfirm>
                    </>
                  )}
                  <Popconfirm
                    title="删除这个 Git 邮箱？"
                    description="删除后这条记录彻底消失。若它已被历史分析引用，平台会拒绝删除并提示改用停用。"
                    okText="删除"
                    cancelText="取消"
                    okButtonProps={{ danger: true, loading: deleteMutation.isPending }}
                    onConfirm={() => deleteMutation.mutate(record)}
                  >
                    <Button type="link" danger style={{ padding: 0 }}>删除</Button>
                  </Popconfirm>
                </Space>
              ),
            },
          ]}
        />
      </Space>

      <Modal
        open={editing !== null}
        width={560}
        title="编辑 Git 身份"
        onCancel={() => setEditing(null)}
        afterClose={() => editForm.resetFields()}
        destroyOnHidden
        okText="保存"
        cancelText="取消"
        confirmLoading={editMutation.isPending}
        onOk={() => editForm.submit()}
      >
        <Form
          form={editForm}
          layout="vertical"
          onFinish={(values) => editMutation.mutate(values)}
        >
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 16 }}
            title={`Git 邮箱：${editing?.masked_email ?? '未配置'}（不可修改）`}
            description="邮箱只能由平台从 GitLab 提交里反查确认，身份表里存的是它的 HMAC；要换邮箱请新增一条再停用这条。"
          />
          <Form.Item
            name="authorNameAliases"
            label="Git 作者别名"
            extra="这个邮箱在提交里用过的作者名。邮箱对不上时平台才会退而用它做弱匹配，最多 10 个。"
            rules={[{ type: 'array', max: 10, message: '最多 10 个别名' }]}
          >
            <Select
              mode="tags"
              placeholder="回车添加，例如：薛宇轩、yuxuan_xue"
              tokenSeparators={[',', '，', ' ']}
              open={false}
              suffixIcon={null}
            />
          </Form.Item>
          <Form.Item
            name="gitlabUsername"
            label="GitLab 用户名"
            extra="git.kingdee.com 个人设置里 Account 页面的 Path。"
            rules={[
              { pattern: /^[A-Za-z0-9][A-Za-z0-9_.-]{0,48}$/, message: '只能包含字母、数字、下划线、点和短横线' },
            ]}
          >
            <Input placeholder="yuxuan_xue" autoComplete="off" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        open={open}
        width={640}
        title="新增 Git 邮箱"
        onCancel={() => setOpen(false)}
        afterClose={() => { form.resetFields(); resetDiscovery() }}
        destroyOnHidden
        footer={[
          <Button key="cancel" onClick={() => setOpen(false)}>取消</Button>,
          <Button
            key="save-candidate"
            type="primary"
            disabled={selectedCandidateId === null}
            loading={saveCandidateMutation.isPending}
            onClick={() => form.submit()}
          >
            保存所选邮箱
          </Button>,
        ]}
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={(values) => saveCandidateMutation.mutate(values)}
        >
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 16 }}
            title={`将绑定到：${identityProfile?.display_name ?? profileDisplayName ?? '（未设置用户名）'}`
              + `${identityProfile?.employee_code ? `（员工号 ${identityProfile.employee_code}）` : ''}`}
            description="姓名与员工号取自上面的「基本资料」，需与需求里「开发人员」一栏一致；要改请到那里改。"
          />

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
                // 没有用户名时保存一定会被数据库拒（DEVELOPER_DISPLAY_NAME_REQUIRED），
                // 与其让人查完才撞墙，不如在这里就说清要先去基本资料填。
                if ((identityProfile?.display_name ?? profileDisplayName ?? '').trim() === '') {
                  message.warning('请先在上面「基本资料」里填写用户名（需与需求里的开发人员一致）')
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
                    {/* 明文只存在于本人自己的临时候选行；正式身份表里只有 HMAC 与脱敏值。 */}
                    <Text strong>{candidate.email ?? candidate.masked_email}</Text>
                    {candidate.already_bound ? <Tag style={{ marginLeft: 8 }}>已被绑定</Tag> : null}
                  </Radio>
                ))}
              </Radio.Group>
            </Form.Item>
          ) : null}

          {phase.kind === 'DONE_EMPTY' ? (
            <Text type="secondary">
              查不到通常是因为你还没在这四个仓库提过合并申请。平台不提供手动填写 ——
              没有 GitLab 提交作为证据的邮箱在归属分析里不会被采用。请联系管理员代录。
            </Text>
          ) : null}
        </Form>
      </Modal>
    </Card>
  )
}

export function ProfilePage({ email, displayName, role }: ProfilePageProps) {
  const { message } = AntApp.useApp()
  const queryClient = useQueryClient()
  const [profileForm] = Form.useForm<{ displayName: string; employeeCode?: string }>()
  const [passwordForm] = Form.useForm<PasswordFormValues>()
  const [passwordModalOpen, setPasswordModalOpen] = useState(false)
  /**
   * 用户名 + 员工号是"我是谁"的唯一声明处：保存时一并同步到开发人员身份，
   * 供归属规则跟需求里「开发人员」那一栏（格式如「向俊杰（41865）」）对齐。
   */
  const updateNameMutation = useMutation({
    mutationFn: (values: { displayName: string; employeeCode?: string }) =>
      updateMyIdentityProfile(values.displayName, values.employeeCode?.trim() || null),
    onSuccess: (result) => {
      queryClient.setQueryData(['my-profile'], result.profile)
      queryClient.invalidateQueries({ queryKey: ['admin-users'] })
      queryClient.invalidateQueries({ queryKey: ['my-git-identity'] })
      profileForm.setFieldsValue({
        displayName: result.profile.display_name ?? '',
        employeeCode: result.employee_code ?? undefined,
      })
      message.success(
        result.developer_id === null
          ? '用户名已更新'
          : '用户名与员工号已更新，并同步到你的开发人员身份',
      )
    },
    onError: (error) => message.error(describeGitIdentityError(error.message)),
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
          <Text type="secondary">管理你的用户名与员工号（需求里的「开发人员」就是它）、登录密码与 Git 身份。</Text>
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
                <Text type="secondary">
                  这里填的就是需求表里「开发人员」那一栏的你 —— 归属分析靠它把需求和你的提交对上，
                  所以写法要与需求一致（例如「向俊杰（41865）」对应用户名 向俊杰、员工号 41865）。
                </Text>
              </div>
              <Form
                form={profileForm}
                layout="vertical"
                className="profile-name-form"
                onFinish={(values) => updateNameMutation.mutate(values)}
              >
                <Form.Item
                  name="displayName"
                  label="用户名"
                  extra="用于页面顶部与操作记录，同时作为需求里「开发人员」的姓名。"
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
                <Form.Item
                  name="employeeCode"
                  label="员工号"
                  extra="需求里「开发人员」括号里的那个号，用来区分同名同事；不确定可以留空。"
                  rules={[
                    { max: 32, message: '员工号不能超过 32 个字符' },
                    {
                      validator: (_rule, value: string | undefined) =>
                        value && containsControlCharacter(value)
                          ? Promise.reject(new Error('员工号不能包含控制字符'))
                          : Promise.resolve(),
                    },
                  ]}
                >
                  <Input size="large" maxLength={32} placeholder="例如：41865" autoComplete="off" />
                </Form.Item>
                <div className="profile-form-actions">
                  <Button size="large" type="primary" htmlType="submit" loading={updateNameMutation.isPending}>
                    保存
                  </Button>
                  <Text type="secondary">保存后全站同步，并同步到你的开发人员身份</Text>
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
