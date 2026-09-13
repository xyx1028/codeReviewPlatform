import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Col,
  Descriptions,
  Empty,
  Form,
  InputNumber,
  Row,
  Select,
  Space,
  Statistic,
  Tag,
  Typography,
} from 'antd'
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  adminGetV4CapabilityPolicy,
  adminListModelConfigs,
  adminUpdateV4CapabilityPolicy,
} from '../lib/api'
import type {
  V4Capabilities,
  V4CapabilityPolicy,
  V4CapabilityPolicyEditable,
} from '../types'

const { Title, Text, Paragraph } = Typography

const capabilityLabels: Record<keyof V4Capabilities, string> = {
  instructions: '系统指令',
  skills: 'Skills',
  goal: '目标（Goal）',
  plan: '计划（Plan）',
  todo: '待办（Todo）',
  ralph: 'Ralph 循环',
  subagentSpawn: '子 Agent 派生',
  subagentFork: '子 Agent 分叉',
  subagentControl: '子 Agent 控制',
  workflow: '工作流',
  jobs: '后台 Jobs',
  shell: 'Shell',
  filesystem: '文件系统',
  webSearch: 'Web 搜索',
  webFetch: 'Web 抓取',
  parallelTools: '并行工具',
  autoCompaction: '自动压缩',
  sessionPersistence: 'Session 持久化',
  sessionResume: 'Session 恢复',
  artifacts: 'Artifacts',
}

interface EditableStatisticProps {
  editing: boolean
  title: string
  value: number
  name: string[]
  min: number
  max: number
  step?: number
  suffix?: string
}

function EditableStatistic({
  editing,
  title,
  value,
  name,
  min,
  max,
  step = 1,
  suffix,
}: EditableStatisticProps) {
  if (!editing) return <Statistic title={title} value={value} suffix={suffix} />
  return (
    <Form.Item
      name={name}
      label={title}
      rules={[{ required: true, message: `请输入${title}` }]}
      className="mb-0"
    >
      <InputNumber min={min} max={max} step={step} suffix={suffix} className="full-width" />
    </Form.Item>
  )
}

function policyToEditable(policy: V4CapabilityPolicy): V4CapabilityPolicyEditable {
  return {
    sandbox: {
      commandTimeoutMs: policy.sandbox.commandTimeoutMs,
      maxProcessesPerAttempt: policy.sandbox.maxProcessesPerAttempt,
      maxWorkspaceBytes: policy.sandbox.maxWorkspaceBytes,
      maxWorkspaceFiles: policy.sandbox.maxWorkspaceFiles,
    },
    agents: {
      maxAgentsPerAttempt: policy.agents.maxAgentsPerAttempt,
      maxDelegationDepth: policy.agents.maxDelegationDepth,
      maxConcurrentChildren: policy.agents.maxConcurrentChildren,
    },
    workflow: { ...policy.workflow },
    jobs: { ...policy.jobs },
    parallelTools: { maxPerStep: policy.parallelTools.maxPerStep },
    modelBudget: { ...policy.modelBudget },
    web: {
      maxRequestsPerAttempt: policy.web.maxRequestsPerAttempt,
      maxResponseBytes: policy.web.maxResponseBytes,
      maxTotalBytes: policy.web.maxTotalBytes,
      allowedDomains: [...policy.web.allowedDomains],
    },
    session: {
      checkpointEveryEvents: policy.session.checkpointEveryEvents,
      retentionDays: policy.session.retentionDays,
    },
  }
}

/**
 * ADMIN 按模型维护 V4 运行资源限额。
 * 能力开关与安全边界仍由 Harness manifest 锁定；保存仅影响之后新建的 Job。
 */
export function HarnessPolicyPage({ isAdmin }: { isAdmin: boolean }) {
  const { message } = AntApp.useApp()
  const queryClient = useQueryClient()
  const [selectedModelId, setSelectedModelId] = useState<string>()
  const [editing, setEditing] = useState(false)
  const [form] = Form.useForm<V4CapabilityPolicyEditable>()

  const modelsQuery = useQuery({
    queryKey: ['admin-model-configs'],
    enabled: isAdmin,
    queryFn: adminListModelConfigs,
  })
  const models = modelsQuery.data ?? []
  const effectiveModelId = selectedModelId
    ?? models.find((model) => model.enabled)?.id
    ?? models[0]?.id

  const policyQuery = useQuery({
    queryKey: ['v4-capability-policy', effectiveModelId],
    enabled: isAdmin && Boolean(effectiveModelId),
    queryFn: () => adminGetV4CapabilityPolicy(effectiveModelId as string),
  })

  const updateMutation = useMutation({
    mutationFn: (values: V4CapabilityPolicyEditable) =>
      adminUpdateV4CapabilityPolicy(effectiveModelId as string, values),
    onSuccess: (policy) => {
      queryClient.setQueryData(['v4-capability-policy', effectiveModelId], policy)
      message.success('能力策略已保存，将从新建 Job 开始生效')
      setEditing(false)
      form.resetFields()
    },
    onError: (error) => message.error(error.message),
  })

  if (!isAdmin) {
    return <Alert type="warning" showIcon title="无权限访问" description="只有管理员可以配置默认能力策略。" />
  }

  const policy = policyQuery.data
  const selectedModel = models.find((model) => model.id === effectiveModelId)
  const capabilityEntries = Object.entries(capabilityLabels) as [keyof V4Capabilities, string][]

  const beginEdit = () => {
    if (!policy) return
    form.setFieldsValue(policyToEditable(policy))
    setEditing(true)
  }

  const cancelEdit = () => {
    setEditing(false)
    form.resetFields()
  }

  const savePolicy = (values: V4CapabilityPolicyEditable) => {
    const total = values.modelBudget.maxTotalRequests
    const scopedLimits = [
      values.modelBudget.maxRootRequests,
      values.modelBudget.maxChildRequests,
      values.modelBudget.maxRetryRequests,
      values.modelBudget.maxCompactionRequests,
    ]
    if (scopedLimits.some((limit) => limit > total)) {
      message.error('根、子 Agent、重试和压缩请求上限均不能超过总请求上限')
      return
    }
    updateMutation.mutate(values)
  }

  return (
    <Space direction="vertical" size="large" className="page-stack">
      <div className="page-title">
        <Space>
          <Title level={2}>默认能力策略</Title>
          <Tag color={editing ? 'gold' : 'blue'}>{editing ? '配置中' : '按模型生效'}</Tag>
        </Space>
        <Space wrap>
          <Select
            value={effectiveModelId}
            loading={modelsQuery.isLoading}
            disabled={editing || models.length === 0}
            placeholder="选择模型配置"
            style={{ minWidth: 240 }}
            options={models.map((model) => ({
              value: model.id,
              label: `${model.display_name}（${model.model_name}）${model.enabled ? '' : ' · 已停用'}`,
            }))}
            onChange={(modelId) => {
              setSelectedModelId(modelId)
              setEditing(false)
              form.resetFields()
            }}
          />
          {editing ? (
            <>
              <Button onClick={cancelEdit} disabled={updateMutation.isPending}>取消</Button>
              <Button type="primary" loading={updateMutation.isPending} onClick={() => form.submit()}>
                保存配置
              </Button>
            </>
          ) : (
            <Button type="primary" disabled={!policy} onClick={beginEdit}>编辑资源限额</Button>
          )}
        </Space>
      </div>

      <Alert
        type="info"
        showIcon
        title={selectedModel ? `当前配置：${selectedModel.display_name}（${selectedModel.model_name}）` : '请选择模型配置'}
        description="保存后仅影响之后新建的 Analysis Job；在途和历史 Job 使用已冻结快照，不会被改写。能力开关和安全边界由 Harness contract 锁定。"
      />

      {modelsQuery.isError ? (
        <Alert type="error" showIcon title="模型配置加载失败" description={modelsQuery.error.message} />
      ) : null}
      {policyQuery.isError ? (
        <Alert type="error" showIcon title="能力策略加载失败" description={policyQuery.error.message} />
      ) : null}

      {modelsQuery.isLoading || policyQuery.isLoading ? (
        <Card loading />
      ) : !effectiveModelId ? (
        <Empty description="请先在模型管理中创建模型配置" />
      ) : policy ? (
        <Form form={form} layout="vertical" onFinish={savePolicy}>
          <Space direction="vertical" size="large" className="full-width">
            <Card title="能力开关（Harness contract 锁定）">
              <Paragraph type="secondary">
                20 个模型能力保持开启，以保证 Worker 工具清单与 manifest hash 一致；此处不提供开关。
              </Paragraph>
              <Row gutter={[12, 12]}>
                {capabilityEntries.map(([key, label]) => (
                  <Col xs={12} md={8} lg={6} key={key}>
                    <Tag color={policy.capabilities[key] ? 'green' : 'red'}>
                      {policy.capabilities[key] ? '✓' : '✕'} {label}
                    </Tag>
                  </Col>
                ))}
              </Row>
            </Card>

            <Card title="Sandbox 沙箱资源">
              <Row gutter={[24, 20]}>
                <Col xs={24} md={12} xl={6}>
                  <EditableStatistic editing={editing} title="命令超时" value={policy.sandbox.commandTimeoutMs} name={['sandbox', 'commandTimeoutMs']} min={1000} max={600000} step={1000} suffix="ms" />
                </Col>
                <Col xs={24} md={12} xl={6}>
                  <EditableStatistic editing={editing} title="最大进程数" value={policy.sandbox.maxProcessesPerAttempt} name={['sandbox', 'maxProcessesPerAttempt']} min={1} max={4096} />
                </Col>
                <Col xs={24} md={12} xl={6}>
                  <EditableStatistic editing={editing} title="工作区最大字节" value={policy.sandbox.maxWorkspaceBytes} name={['sandbox', 'maxWorkspaceBytes']} min={1048576} max={1099511627776} step={1048576} />
                </Col>
                <Col xs={24} md={12} xl={6}>
                  <EditableStatistic editing={editing} title="工作区最大文件数" value={policy.sandbox.maxWorkspaceFiles} name={['sandbox', 'maxWorkspaceFiles']} min={100} max={10000000} step={100} />
                </Col>
              </Row>
              <Descriptions column={{ xs: 1, md: 2 }} size="small" bordered className="mt-md">
                <Descriptions.Item label="默认模式">{policy.sandbox.defaultMode}</Descriptions.Item>
                <Descriptions.Item label="完全访问"><Tag>固定关闭</Tag></Descriptions.Item>
              </Descriptions>
            </Card>

            <Card title="Agent Tree 上限">
              <Row gutter={[24, 20]}>
                <Col xs={24} md={8}>
                  <EditableStatistic editing={editing} title="每次尝试最大 Agent 数" value={policy.agents.maxAgentsPerAttempt} name={['agents', 'maxAgentsPerAttempt']} min={1} max={64} />
                </Col>
                <Col xs={24} md={8}>
                  <EditableStatistic editing={editing} title="最大委派深度" value={policy.agents.maxDelegationDepth} name={['agents', 'maxDelegationDepth']} min={0} max={8} />
                </Col>
                <Col xs={24} md={8}>
                  <EditableStatistic editing={editing} title="最大并发子 Agent" value={policy.agents.maxConcurrentChildren} name={['agents', 'maxConcurrentChildren']} min={1} max={32} />
                </Col>
              </Row>
              <Text type="secondary">进程外 Provider 固定关闭。</Text>
            </Card>

            <Card title="分层模型预算">
              <Row gutter={[24, 20]}>
                <Col xs={24} md={8}>
                  <EditableStatistic editing={editing} title="总请求上限" value={policy.modelBudget.maxTotalRequests} name={['modelBudget', 'maxTotalRequests']} min={1} max={10000} />
                </Col>
                <Col xs={24} md={8}>
                  <EditableStatistic editing={editing} title="根 Agent 请求上限" value={policy.modelBudget.maxRootRequests} name={['modelBudget', 'maxRootRequests']} min={1} max={10000} />
                </Col>
                <Col xs={24} md={8}>
                  <EditableStatistic editing={editing} title="子 Agent 请求上限" value={policy.modelBudget.maxChildRequests} name={['modelBudget', 'maxChildRequests']} min={1} max={10000} />
                </Col>
                <Col xs={24} md={8}>
                  <EditableStatistic editing={editing} title="重试请求上限" value={policy.modelBudget.maxRetryRequests} name={['modelBudget', 'maxRetryRequests']} min={0} max={100} />
                </Col>
                <Col xs={24} md={8}>
                  <EditableStatistic editing={editing} title="压缩请求上限" value={policy.modelBudget.maxCompactionRequests} name={['modelBudget', 'maxCompactionRequests']} min={0} max={100} />
                </Col>
                <Col xs={24} md={8}>
                  <EditableStatistic editing={editing} title="Ralph 轮次上限" value={policy.modelBudget.maxRalphRounds} name={['modelBudget', 'maxRalphRounds']} min={0} max={256} />
                </Col>
              </Row>
            </Card>

            <Card title="并行工具 / 工作流 / Jobs">
              <Row gutter={[24, 20]}>
                <Col xs={24} md={8}>
                  <EditableStatistic editing={editing} title="每步最大并行工具数" value={policy.parallelTools.maxPerStep} name={['parallelTools', 'maxPerStep']} min={1} max={64} />
                </Col>
                <Col xs={24} md={8}>
                  <EditableStatistic editing={editing} title="工作流最大并发步骤" value={policy.workflow.maxConcurrentSteps} name={['workflow', 'maxConcurrentSteps']} min={1} max={32} />
                </Col>
                <Col xs={24} md={8}>
                  <EditableStatistic editing={editing} title="工作流最大运行时长" value={policy.workflow.maxRuntimeMs} name={['workflow', 'maxRuntimeMs']} min={1000} max={86400000} step={1000} suffix="ms" />
                </Col>
                <Col xs={24} md={8}>
                  <EditableStatistic editing={editing} title="每 Owner 最大并发 Job" value={policy.jobs.maxConcurrentJobsPerOwner} name={['jobs', 'maxConcurrentJobsPerOwner']} min={1} max={64} />
                </Col>
                <Col xs={24} md={8}>
                  <EditableStatistic editing={editing} title="Job 最大运行时长" value={policy.jobs.maxRuntimeMs} name={['jobs', 'maxRuntimeMs']} min={1000} max={86400000} step={1000} suffix="ms" />
                </Col>
              </Row>
              <Text type="secondary">变更类工具固定串行执行。</Text>
            </Card>

            <Card title="Web egress allowlist">
              <Row gutter={[24, 20]}>
                <Col xs={24} md={8}>
                  <EditableStatistic editing={editing} title="每次尝试最大请求数" value={policy.web.maxRequestsPerAttempt} name={['web', 'maxRequestsPerAttempt']} min={0} max={10000} />
                </Col>
                <Col xs={24} md={8}>
                  <EditableStatistic editing={editing} title="单响应最大字节" value={policy.web.maxResponseBytes} name={['web', 'maxResponseBytes']} min={1024} max={1073741824} step={1024} />
                </Col>
                <Col xs={24} md={8}>
                  <EditableStatistic editing={editing} title="累计最大字节" value={policy.web.maxTotalBytes} name={['web', 'maxTotalBytes']} min={1024} max={109951162777} step={1024} />
                </Col>
              </Row>
              {editing ? (
                <Form.Item name={['web', 'allowedDomains']} label="允许域名" className="mt-md">
                  <Select mode="tags" tokenSeparators={[',', ' ']} placeholder="输入域名后回车，例如 api.example.com" />
                </Form.Item>
              ) : (
                <Descriptions column={1} size="small" bordered className="mt-md">
                  <Descriptions.Item label="允许域名">
                    {policy.web.allowedDomains.length
                      ? <Space wrap>{policy.web.allowedDomains.map((domain) => <Tag key={domain}>{domain}</Tag>)}</Space>
                      : <Text type="secondary">未配置；Web 请求将被拒绝</Text>}
                  </Descriptions.Item>
                </Descriptions>
              )}
              <Descriptions column={{ xs: 1, md: 2 }} size="small" bordered className="mt-md">
                <Descriptions.Item label="协议与端口">仅 HTTPS / 443</Descriptions.Item>
                <Descriptions.Item label="私有网络">固定禁止</Descriptions.Item>
                <Descriptions.Item label="最大重定向">{policy.web.maxRedirects}</Descriptions.Item>
                <Descriptions.Item label="请求超时">{policy.web.requestTimeoutMs} ms</Descriptions.Item>
              </Descriptions>
            </Card>

            <Card title="Session 保留">
              <Row gutter={[24, 20]}>
                <Col xs={24} md={12}>
                  <EditableStatistic editing={editing} title="检查点事件间隔" value={policy.session.checkpointEveryEvents} name={['session', 'checkpointEveryEvents']} min={1} max={100000} />
                </Col>
                <Col xs={24} md={12}>
                  <EditableStatistic editing={editing} title="保留天数" value={policy.session.retentionDays} name={['session', 'retentionDays']} min={1} max={365} suffix="天" />
                </Col>
              </Row>
              <Text type="secondary">静态加密与 Worker 重启恢复固定开启。</Text>
            </Card>
          </Space>
        </Form>
      ) : (
        <Empty description="未返回能力策略" />
      )}
    </Space>
  )
}
