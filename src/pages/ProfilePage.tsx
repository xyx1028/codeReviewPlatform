import { useEffect, useState } from 'react'
import {
  Alert,
  App as AntApp,
  Avatar,
  Button,
  Card,
  Col,
  Form,
  Input,
  Modal,
  Row,
  Space,
  Spin,
  Tag,
  Typography,
} from 'antd'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  confirmWechatBinding,
  getWechatBindingStatus,
  startWechatBinding,
  unbindWechat,
  updateMyDisplayName,
  wechatLoginEnabled,
} from '../lib/api'
import type { UserRole } from '../types'

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

function containsControlCharacter(value: string) {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0
    return codePoint < 32 || codePoint === 127
  })
}

function consumeBindingResult(): { ticket: string | null; error: string | null } | null {
  const params = new URLSearchParams(window.location.hash.slice(1))
  const ticket = params.get('wechat_binding_ticket')
  const error = params.get('wechat_binding_error')
  if (!ticket && !error) return null

  params.delete('wechat_binding_ticket')
  params.delete('wechat_binding_error')
  const hash = params.toString()
  window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${hash ? `#${hash}` : ''}`)
  return { ticket, error }
}

export function ProfilePage({ email, displayName, role }: ProfilePageProps) {
  const { message } = AntApp.useApp()
  const queryClient = useQueryClient()
  const [profileForm] = Form.useForm<{ displayName: string }>()
  const [unbindOpen, setUnbindOpen] = useState(false)
  const [unbindForm] = Form.useForm<{ password: string }>()
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
  const bindingQuery = useQuery({
    queryKey: ['wechat-binding'],
    queryFn: getWechatBindingStatus,
    enabled: wechatLoginEnabled,
  })
  const bindMutation = useMutation({
    mutationFn: startWechatBinding,
    onError: (error) => message.error(error.message),
  })
  const confirmMutation = useMutation({
    mutationFn: confirmWechatBinding,
    onSuccess: async () => {
      message.success('微信绑定成功，下次可直接扫码登录')
      await queryClient.invalidateQueries({ queryKey: ['wechat-binding'] })
    },
    onError: (error) => message.error(error.message),
  })
  const unbindMutation = useMutation({
    mutationFn: (password: string) => unbindWechat(password),
    onSuccess: async () => {
      setUnbindOpen(false)
      unbindForm.resetFields()
      message.success('微信已解绑')
      await queryClient.invalidateQueries({ queryKey: ['wechat-binding'] })
    },
    onError: (error) => message.error(error.message),
  })

  useEffect(() => {
    profileForm.setFieldValue('displayName', displayName ?? '')
  }, [displayName, profileForm])

  useEffect(() => {
    const result = consumeBindingResult()
    if (!result) return
    if (result.ticket) confirmMutation.mutate(result.ticket)
    else message.error(result.error ?? '微信绑定失败，请重试')
  }, [confirmMutation, message])

  const accountName = displayName?.trim() || email?.split('@')[0] || '微信用户'
  const currentRole = role ? roleMeta[role] : { label: '未配置', color: 'default' }

  return (
    <>
      <Space direction="vertical" size={24} className="profile-page">
        <div className="profile-page-header">
          <div>
            <Text className="profile-eyebrow">ACCOUNT SETTINGS</Text>
            <Title level={2}>个人中心</Title>
            <Text type="secondary">管理你的公开用户名、账号信息与登录安全设置。</Text>
          </div>
        </div>

        <Card className="profile-card profile-account-card">
          <Row gutter={0} align="stretch">
            <Col xs={24} md={9} lg={8}>
              <div className="profile-summary">
                <Title level={4}>{accountName}</Title>
                <Text className="profile-email">{email || '微信账号'}</Text>
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

        <Card className="profile-card profile-login-card">
          <div className="profile-section-heading profile-login-heading">
            <Title level={4}>登录与安全</Title>
            <Text type="secondary">管理当前账号可使用的登录方式。</Text>
          </div>
          <div className="profile-login-panel">
            {!wechatLoginEnabled ? (
              <Alert type="info" showIcon title="微信登录未启用" description="部署人员完成微信开放平台配置后即可绑定。" />
            ) : confirmMutation.isPending ? (
              <Space><Spin /><Text>正在确认微信绑定…</Text></Space>
            ) : bindingQuery.isLoading ? (
              <Spin />
            ) : bindingQuery.isError ? (
              <Alert type="error" showIcon title="读取微信绑定状态失败" description={bindingQuery.error.message} />
            ) : !bindingQuery.data?.configured ? (
              <Alert type="warning" showIcon title="微信登录服务尚未配置" description="请联系管理员完成微信开放平台参数配置。" />
            ) : bindingQuery.data.bound ? (
              <Space direction="vertical" size="middle">
                <Space>
                  <Avatar src={bindingQuery.data.avatar_url ?? undefined}>
                    {bindingQuery.data.nickname?.slice(0, 1) || '微'}
                  </Avatar>
                  <div>
                    <div><Text strong>{bindingQuery.data.nickname || '已绑定微信'}</Text></div>
                    <Text type="secondary">下次可使用微信扫码登录当前账号</Text>
                  </div>
                </Space>
                {bindingQuery.data.can_unbind ? (
                  <Button danger onClick={() => setUnbindOpen(true)}>解绑微信</Button>
                ) : (
                  <Alert type="info" showIcon title="微信是当前账号唯一登录方式，暂不能解绑" />
                )}
              </Space>
            ) : (
              <Space direction="vertical">
                <Text>绑定微信后，后续可扫码登录当前账号，原有角色和业务数据保持不变。</Text>
                <Button type="primary" loading={bindMutation.isPending} onClick={() => bindMutation.mutate()}>
                  绑定微信
                </Button>
              </Space>
            )}
          </div>
        </Card>
      </Space>

      <Modal
        title="验证邮箱密码并解绑微信"
        open={unbindOpen}
        onCancel={() => {
          setUnbindOpen(false)
          unbindForm.resetFields()
        }}
        footer={null}
        destroyOnHidden
      >
        <Alert
          type="warning"
          showIcon
          title="解绑后将不能再用该微信登录"
          description="请输入当前邮箱密码，确认仍可通过邮箱登录后再解绑。"
          style={{ marginBottom: 16 }}
        />
        <Form
          form={unbindForm}
          layout="vertical"
          onFinish={({ password }) => unbindMutation.mutate(password)}
        >
          <Form.Item name="password" label="当前邮箱密码" rules={[{ required: true, message: '请输入当前邮箱密码' }]}>
            <Input.Password autoComplete="current-password" />
          </Form.Item>
          <Space>
            <Button type="primary" danger htmlType="submit" loading={unbindMutation.isPending}>确认解绑</Button>
            <Button onClick={() => setUnbindOpen(false)}>取消</Button>
          </Space>
        </Form>
      </Modal>
    </>
  )
}
