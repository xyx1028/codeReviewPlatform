import { useEffect } from 'react'
import {
  App as AntApp,
  Button,
  Card,
  Col,
  Form,
  Input,
  Row,
  Space,
  Tag,
  Typography,
} from 'antd'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { updateMyDisplayName } from '../lib/api'
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

export function ProfilePage({ email, displayName, role }: ProfilePageProps) {
  const { message } = AntApp.useApp()
  const queryClient = useQueryClient()
  const [profileForm] = Form.useForm<{ displayName: string }>()
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
          <Text type="secondary">管理你的公开用户名与账号信息。</Text>
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
    </Space>
  )
}
