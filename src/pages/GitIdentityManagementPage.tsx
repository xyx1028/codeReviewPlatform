import { useEffect, useState } from 'react'
import { Alert, Button, Card, Form, Input, Modal, Radio, Space, Table, Tag, Tooltip, Typography, message } from 'antd'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  adminListDeveloperGitIdentities,
  adminSaveDeveloperGitIdentity,
  enqueueMyGitEmailDiscovery,
  getMyGitEmailDiscovery,
} from '../lib/api'
import { GIT_EMAIL_MATCH_REASON_META, describeGitEmailDiscoveryPhase } from '../lib/git-identity'
import type { DeveloperGitIdentityRecord, DeveloperIdentityStatus } from '../types'

const { Text } = Typography

interface IdentityFormValues {
  displayName: string
  employeeCode?: string
  email: string
  aliases?: string
  gitlabUsername?: string
}

const statusOptions = [
  { value: 'VERIFIED', label: '已验证' },
  { value: 'UNVERIFIED', label: '未验证' },
  { value: 'CONFLICT', label: '冲突' },
  { value: 'DISABLED', label: '已停用' },
]

export function GitIdentityManagementPage({ isAdmin }: { isAdmin: boolean }) {
  const [form] = Form.useForm<IdentityFormValues>()
  const queryClient = useQueryClient()
  const [editing, setEditing] = useState<DeveloperGitIdentityRecord | null>(null)
  const [addingEmail, setAddingEmail] = useState(false)
  const [open, setOpen] = useState(false)
  // 反查（管理员代查）：与个人中心用同一组 RPC —— enqueue 只按 GitLab 用户名排队，
  // requested_by 记的是发起人，所以管理员替别人查完全不需要新接口。
  const [discoveryId, setDiscoveryId] = useState<string | null>(null)
  const [discoveryStartedAt, setDiscoveryStartedAt] = useState<number | null>(null)
  const [nowTick, setNowTick] = useState(() => Date.now())
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(null)

  const identities = useQuery({
    queryKey: ['developer-git-identities'],
    enabled: isAdmin,
    queryFn: adminListDeveloperGitIdentities,
  })
  const discoveryQuery = useQuery({
    queryKey: ['admin-git-email-discovery', discoveryId],
    enabled: discoveryId !== null,
    queryFn: () => getMyGitEmailDiscovery(discoveryId!),
    // 终态就停轮询：这条链路会打 GitLab API，没必要一直问。
    refetchInterval: (query) => {
      const status = query.state.data?.status
      return status === 'SUCCEEDED' || status === 'FAILED' ? false : 2_000
    },
  })
  const discovery = discoveryId === null ? null : discoveryQuery.data ?? null
  const waiting = discovery !== null && (discovery.status === 'QUEUED' || discovery.status === 'RUNNING')
  // 只在等待期间跑这个计时器：它唯一的用途是判断"排队多久还没 Worker 领"。
  useEffect(() => {
    if (!waiting) return
    const timer = window.setInterval(() => setNowTick(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [waiting])
  const phase = describeGitEmailDiscoveryPhase(
    discovery,
    discoveryStartedAt === null ? 0 : nowTick - discoveryStartedAt,
    'ADMIN',
  )
  const candidates = discovery?.candidates ?? []

  const resetDiscovery = () => {
    setDiscoveryId(null)
    setDiscoveryStartedAt(null)
    setSelectedCandidateId(null)
  }
  const discover = useMutation({
    mutationFn: (gitlabUsername: string) => enqueueMyGitEmailDiscovery(gitlabUsername),
    onSuccess: (id) => {
      setSelectedCandidateId(null)
      setDiscoveryId(id)
      setDiscoveryStartedAt(Date.now())
      setNowTick(Date.now())
    },
    onError: (error) => message.error(error instanceof Error ? error.message : '查找失败'),
  })

  const save = useMutation({
    mutationFn: (values: IdentityFormValues) => adminSaveDeveloperGitIdentity({
      developerId: editing?.developer_id,
      gitIdentityId: addingEmail ? null : editing?.git_identity_id,
      displayName: values.displayName.trim(),
      employeeCode: values.employeeCode?.trim() || null,
      email: values.email.trim(),
      authorNameAliases: (values.aliases ?? '')
        .split(/[，,、;；\n]/)
        .map((value) => value.trim())
        .filter(Boolean),
      gitlabUsername: values.gitlabUsername?.trim() || null,
      // GitLab User ID 和身份状态不在表单里露出（新增/编辑主要就是为了配邮箱，露出这些
      // 只会让人不知道该填什么）。编辑/新增邮箱时原样保留当前值，避免整行覆盖语义把它们
      // 静默清空；只有全新建档时才用默认的「已验证」。
      gitlabUserId: addingEmail || editing === null ? null : editing.gitlab_user_id,
      developerStatus: editing?.status ?? 'VERIFIED',
      verificationStatus: addingEmail || editing === null ? 'VERIFIED' : editing.verification_status,
      expectedRevision: editing?.revision ?? null,
    }),
    onSuccess: async () => {
      setOpen(false)
      setEditing(null)
      setAddingEmail(false)
      resetDiscovery()
      form.resetFields()
      await queryClient.invalidateQueries({ queryKey: ['developer-git-identities'] })
    },
  })

  if (!isAdmin) {
    return <Alert type="error" showIcon title="无权限访问" description="只有管理员可以维护开发人员 Git 身份。" />
  }

  const beginCreate = () => {
    setEditing(null)
    setAddingEmail(false)
    resetDiscovery()
    setOpen(true)
  }
  const beginEdit = (record: DeveloperGitIdentityRecord) => {
    setEditing(record)
    setAddingEmail(false)
    resetDiscovery()
    form.setFieldsValue({
      displayName: record.display_name,
      employeeCode: record.employee_code ?? undefined,
      email: record.author_email ?? '',
      aliases: record.author_name_aliases.join('，'),
      gitlabUsername: record.gitlab_username ?? undefined,
    })
    setOpen(true)
  }
  const beginAddEmail = (record: DeveloperGitIdentityRecord) => {
    setEditing(record)
    setAddingEmail(true)
    resetDiscovery()
    form.setFieldsValue({
      displayName: record.display_name,
      employeeCode: record.employee_code ?? undefined,
      email: '',
      aliases: record.author_name_aliases.join('，'),
      gitlabUsername: undefined,
    })
    setOpen(true)
  }

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      {identities.isError ? <Alert type="error" showIcon title="读取 Git 身份失败" description={identities.error instanceof Error ? identities.error.message : '未知错误'} /> : null}
      <Card extra={<Button type="primary" onClick={beginCreate}>新增 Git 身份</Button>}>
        <Table<DeveloperGitIdentityRecord>
          rowKey="git_identity_id"
          loading={identities.isLoading}
          dataSource={identities.data ?? []}
          pagination={{ pageSize: 20, showSizeChanger: true }}
          scroll={{ x: 1050 }}
          columns={[
            { title: '开发人员', dataIndex: 'display_name', fixed: 'left', width: 150 },
            { title: '维护方式', dataIndex: 'auth_bound', width: 110, render: (value: boolean | undefined) => <Tag color={value ? 'blue' : undefined}>{value ? '本人维护' : '管理员代录'}</Tag> },
            { title: '员工号', dataIndex: 'employee_code', width: 110, render: (value) => value ?? '—' },
            {
              title: 'Git 邮箱',
              dataIndex: 'author_email',
              width: 230,
              // 明文优先。历史行（改造前建的、且反查候选里也查不到）没有明文，回落到掩码，
              // 并说明一次重新保存就能补上，而不是让人以为数据坏了。
              render: (value: string | null | undefined, record) =>
                value ?? (record.masked_email ? `${record.masked_email}（旧记录，保存一次即补全）` : '未配置'),
            },
            { title: '作者别名', dataIndex: 'author_name_aliases', width: 190, render: (values: string[]) => values.length ? values.join('、') : '—' },
            { title: 'GitLab 用户名', dataIndex: 'gitlab_username', width: 150, render: (value) => value ?? '—' },
            { title: '身份状态', dataIndex: 'verification_status', width: 110, render: (value: DeveloperIdentityStatus) => <Tag color={value === 'VERIFIED' ? 'green' : value === 'CONFLICT' ? 'red' : value === 'DISABLED' ? 'default' : 'orange'}>{statusOptions.find((item) => item.value === value)?.label ?? value}</Tag> },
            { title: '更新时间', dataIndex: 'updated_at', width: 180, render: (value: string) => new Date(value).toLocaleString() },
            { title: '操作', fixed: 'right', width: 150, render: (_value, record) => <Space size={0}><Button type="link" onClick={() => beginAddEmail(record)}>新增邮箱</Button><Button type="link" onClick={() => beginEdit(record)}>编辑</Button></Space> },
          ]}
        />
      </Card>
      <Modal
        open={open}
        title={addingEmail ? `为 ${editing?.display_name ?? ''} 新增 Git 邮箱` : editing ? '编辑 Git 身份' : '新增 Git 身份'}
        okText="保存"
        cancelText="取消"
        confirmLoading={save.isPending}
        onCancel={() => { setOpen(false); setEditing(null); setAddingEmail(false); resetDiscovery(); form.resetFields() }}
        onOk={() => form.submit()}
      >
        <Form form={form} layout="vertical" onFinish={(values) => save.mutate(values)}>
          <Form.Item name="displayName" label="开发人员姓名" rules={[{ required: true, message: '请输入与需求开发人员一致的姓名' }]}>
            <Input placeholder="例如：张三" />
          </Form.Item>
          <Form.Item name="employeeCode" label="员工号（推荐）"><Input placeholder="用于区分同名人员" /></Form.Item>

          {/* 先填 GitLab 用户名并反查，再选邮箱：管理员代录拿到的是与本人自助绑定同一份 GitLab 证据，
              而不是靠嘴问一个邮箱填进去。 */}
          <Form.Item
            name="gitlabUsername"
            label="GitLab 用户名"
            extra="就是 git.kingdee.com 个人设置里 Account 页面的 Path，例如 yuxuan_xue。"
            rules={[{ pattern: /^[A-Za-z0-9][A-Za-z0-9_.-]{0,48}$/, message: '只能包含字母、数字、下划线、点和短横线' }]}
          >
            <Input placeholder="yuxuan_xue" autoComplete="off" onChange={() => resetDiscovery()} />
          </Form.Item>
          <div style={{ marginBottom: 16 }}>
            <Button
              onClick={() => {
                const username = (form.getFieldValue('gitlabUsername') as string | undefined)?.trim() ?? ''
                if (username === '') {
                  message.warning('请先填写 GitLab 用户名')
                  return
                }
                discover.mutate(username)
              }}
              loading={discover.isPending || waiting}
            >
              {discovery === null ? '查找该用户的提交邮箱' : '重新查找'}
            </Button>
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

          {candidates.length > 0 ? (
            <Form.Item label="反查到的提交邮箱" required>
              <Radio.Group
                value={selectedCandidateId}
                onChange={(event) => {
                  const candidateId = event.target.value as string
                  setSelectedCandidateId(candidateId)
                  const picked = candidates.find((item) => item.candidate_id === candidateId)
                  if (picked?.email) form.setFieldValue('email', picked.email)
                  // 别名用这个邮箱在提交里真实出现过的作者名，省得管理员去猜。
                  if (picked && picked.author_names.length > 0) {
                    form.setFieldValue('aliases', picked.author_names.slice(0, 10).join('，'))
                  }
                }}
                style={{ display: 'flex', flexDirection: 'column', gap: 12, width: '100%' }}
              >
                {candidates.map((candidate) => {
                  const reason = candidate.match_reason === null
                    ? null
                    : GIT_EMAIL_MATCH_REASON_META[candidate.match_reason] ?? null
                  return (
                    <Radio key={candidate.candidate_id} value={candidate.candidate_id} disabled={candidate.already_bound}>
                      <Text strong>{candidate.email ?? candidate.masked_email}</Text>
                      <Text type="secondary" style={{ marginLeft: 8 }}>{candidate.commit_count} 个提交</Text>
                      {reason === null ? null : (
                        <Tooltip title={reason.hint}>
                          <Tag color={reason.color} style={{ marginLeft: 8 }}>{reason.label}</Tag>
                        </Tooltip>
                      )}
                      {candidate.already_bound ? <Tag style={{ marginLeft: 8 }}>已被绑定</Tag> : null}
                    </Radio>
                  )
                })}
              </Radio.Group>
            </Form.Item>
          ) : null}

          {/* 邮箱与别名一律由上面的反查候选带下来，不接受手工输入：
              手输的邮箱没有任何 GitLab 证据，一旦打错就是一条永远匹配不上的身份。
              编辑已有行时这两个值来自该行本身，同样只读。 */}
          <Form.Item
            name="email"
            label="Git author email"
            extra={
              editing !== null && !addingEmail && editing.author_email === null
                ? `这是改造前建的记录，库里没有明文（原掩码 ${editing.masked_email ?? '未配置'}）。请用上面的反查结果补全。`
                : undefined
            }
            rules={[{ required: true, type: 'email', message: '请先在上面选择反查到的邮箱' }]}
          >
            <Input readOnly autoComplete="off" placeholder="请先在上面选择反查到的邮箱" />
          </Form.Item>
          <Form.Item name="aliases" label="Git 作者别名">
            <Input readOnly placeholder="选择邮箱后自动带出" />
          </Form.Item>
          {save.isError ? <Alert type="error" showIcon title="保存失败" description={save.error instanceof Error ? save.error.message : '未知错误'} /> : null}
        </Form>
      </Modal>
    </Space>
  )
}
