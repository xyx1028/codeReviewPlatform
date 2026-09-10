import { useEffect, useState } from 'react'
import {
  Alert,
  App as AntApp,
  Avatar,
  Button,
  Card,
  Descriptions,
  Form,
  Input,
  Modal,
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
  wechatLoginEnabled,
} from '../lib/api'
import type { UserRole } from '../types'

const { Title, Text } = Typography

interface ProfilePageProps {
  email: string | null
  displayName: string | null
  role: UserRole | undefined
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
  const [unbindOpen, setUnbindOpen] = useState(false)
  const [unbindForm] = Form.useForm<{ password: string }>()
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
    const result = consumeBindingResult()
    if (!result) return
    if (result.ticket) confirmMutation.mutate(result.ticket)
    else message.error(result.error ?? '微信绑定失败，请重试')
  }, [confirmMutation, message])

  return (
    <>
      <Space direction="vertical" size="large" className="page-stack">
        <Title level={2}>个人中心</Title>

        <Card title="账号信息">
          <Descriptions column={1}>
            <Descriptions.Item label="显示名称">{displayName || '未设置'}</Descriptions.Item>
            <Descriptions.Item label="邮箱">{email || '未设置（当前为微信账号）'}</Descriptions.Item>
            <Descriptions.Item label="角色"><Tag color="blue">{role ?? '未配置'}</Tag></Descriptions.Item>
          </Descriptions>
        </Card>

        <Card title="登录方式">
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
