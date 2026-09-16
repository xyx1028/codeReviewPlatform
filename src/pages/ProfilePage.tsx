import { useEffect, useState } from 'react'
import {
  App as AntApp,
  Button,
  Card,
  Col,
  Form,
  Input,
  Modal,
  Row,
  Space,
  Tag,
  Tooltip,
  Typography,
} from 'antd'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { changeMyPassword, updateMyDisplayName } from '../lib/api'
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
          <Text type="secondary">管理你的公开用户名、账号信息与登录密码。</Text>
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
