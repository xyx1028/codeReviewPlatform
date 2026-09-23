import { useState } from 'react'
import { Alert, Button, Card, Form, Input, Modal, Space, Table, Tag } from 'antd'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { adminListDeveloperGitIdentities, adminSaveDeveloperGitIdentity } from '../lib/api'
import type { DeveloperGitIdentityRecord, DeveloperIdentityStatus } from '../types'

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

  const identities = useQuery({
    queryKey: ['developer-git-identities'],
    enabled: isAdmin,
    queryFn: adminListDeveloperGitIdentities,
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
    setOpen(true)
  }
  const beginEdit = (record: DeveloperGitIdentityRecord) => {
    setEditing(record)
    setAddingEmail(false)
    form.setFieldsValue({
      displayName: record.display_name,
      employeeCode: record.employee_code ?? undefined,
      email: '',
      aliases: record.author_name_aliases.join('，'),
      gitlabUsername: record.gitlab_username ?? undefined,
    })
    setOpen(true)
  }
  const beginAddEmail = (record: DeveloperGitIdentityRecord) => {
    setEditing(record)
    setAddingEmail(true)
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
      <Alert
        type="info"
        showIcon
        title="上线前必须先配置 Vault secret：analysis_identity_pepper"
        description="缺少时保存会明确返回 IDENTITY_PEPPER_MISSING；已有结构化 Story-Id 的分析仍可运行。成员在「个人中心 → Git 身份」自己维护的记录会标「本人维护」，这里代录的标「管理员代录」。邮箱只在数据库函数内计算 HMAC，页面、业务表和日志均不保存明文。"
      />
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
            { title: 'Git 邮箱', dataIndex: 'masked_email', width: 190, render: (value) => value ?? '未配置' },
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
        onCancel={() => { setOpen(false); setEditing(null); setAddingEmail(false); form.resetFields() }}
        onOk={() => form.submit()}
      >
        <Form form={form} layout="vertical" onFinish={(values) => save.mutate(values)}>
          <Form.Item name="displayName" label="开发人员姓名" rules={[{ required: true, message: '请输入与需求开发人员一致的姓名' }]}>
            <Input placeholder="例如：张三" />
          </Form.Item>
          <Form.Item name="employeeCode" label="员工号（推荐）"><Input placeholder="用于区分同名人员" /></Form.Item>
          <Form.Item
            name="email"
            label="Git author email"
            extra={
              editing !== null && !addingEmail
                ? `当前邮箱：${editing.masked_email ?? '未配置'}（数据库不存明文，无法回显，请重新完整输入一遍才能保存）`
                : '填写开发人员本机 Git 提交使用的邮箱。'
            }
            rules={[{ required: true, type: 'email', message: '请输入有效邮箱' }]}
          >
            <Input autoComplete="off" placeholder="developer@example.com" />
          </Form.Item>
          <Form.Item
            name="aliases"
            label="Git 作者别名"
            extra="提交里的 git config user.name，通常是英文或拼音，不是中文姓名。"
          >
            <Input placeholder="多个用逗号分隔，例如 yuxuan_xue, guolichen2025" />
          </Form.Item>
          <Form.Item name="gitlabUsername" label="GitLab 用户名"><Input placeholder="git.kingdee.com 个人设置里 Account 页面的 Path" /></Form.Item>
          {save.isError ? <Alert type="error" showIcon title="保存失败" description={save.error instanceof Error ? save.error.message : '未知错误'} /> : null}
        </Form>
      </Modal>
    </Space>
  )
}
