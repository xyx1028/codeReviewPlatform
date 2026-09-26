import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Empty,
  Form,
  InputNumber,
  Progress,
  Select,
  Space,
  Tag,
  Typography,
} from 'antd'
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  adminGetSkillCatalogLimits,
  adminGetV4CapabilityPolicy,
  adminListModelConfigs,
  adminListReviewSkills,
  adminUpdateSkillCatalogLimits,
  adminUpdateV4CapabilityPolicy,
} from '../lib/api'
import type {
  SkillCatalogLimitsConfig,
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

const MONO_NUMBER = new Intl.NumberFormat('en-US')

function formatGrouped(value: number): string {
  return MONO_NUMBER.format(value)
}

function formatMs(value: number): string {
  if (value % 3600000 === 0) return `${value / 3600000} h`
  if (value % 60000 === 0) return `${value / 60000} min`
  if (value % 1000 === 0) return `${value / 1000} s`
  return `${formatGrouped(value)} ms`
}

function formatBytes(value: number): string {
  const units: [number, string][] = [
    [1024 ** 4, 'TiB'],
    [1024 ** 3, 'GiB'],
    [1024 ** 2, 'MiB'],
    [1024, 'KiB'],
  ]
  for (const [size, label] of units) {
    if (value >= size && value % size === 0) return `${value / size} ${label}`
  }
  return `${formatGrouped(value)} B`
}

interface ParamRowProps {
  editing: boolean
  label: string
  value: number
  name: string[]
  min: number
  max: number
  step?: number
  suffix?: string
  display?: string
  raw?: string
}

/**
 * 清单式参数行：标签居左、等宽数值居右，点状引导线连接。
 * 只读时优先展示人性化单位（display），原始值（raw）以小字随附；
 * 编辑时切换为原始单位的 InputNumber，保存契约与后端校验不变。
 */
function ParamRow({
  editing,
  label,
  value,
  name,
  min,
  max,
  step = 1,
  suffix,
  display,
  raw,
}: ParamRowProps) {
  return (
    <div className="hps-row">
      <span className="hps-row-label">{label}</span>
      {editing ? (
        <Form.Item name={name} rules={[{ required: true, message: `请输入${label}` }]}>
          <InputNumber min={min} max={max} step={step} suffix={suffix} />
        </Form.Item>
      ) : (
        <span className="hps-row-value">
          <strong>{display ?? formatGrouped(value)}</strong>
          {!display && suffix ? <small>{suffix}</small> : null}
          {raw ? <small>{raw}</small> : null}
        </span>
      )}
    </div>
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
 * ADMIN 维护平台级技能目录容量上限（V1.8，可配置）。
 *
 * 独立于按模型的能力策略：技能目录是全平台共享的一份，与模型无关。保存仅影响之后新建的
 * 批次；单包上限仍是数据库常量，不在这里配置。区间与后端 RPC 校验一致（越界会被 RPC 拒绝）。
 */
const KIB = 1024
const MIB = 1024 * 1024

interface SkillLimitsForm {
  catalogBundles: number
  catalogRenderKiB: number
  catalogArchiveMiB: number
  catalogExpandedMiB: number
}

function CatalogCapacityMeter({
  title,
  used,
  limit,
  formatter = formatGrouped,
}: {
  title: string
  used: number
  limit: number
  formatter?: (value: number) => string
}) {
  const percent = limit === 0 ? 0 : Math.min(100, Math.round((used / limit) * 100))
  return (
    <div className="hps-capacity-meter">
      <div className="hps-capacity-meter-head">
        <Text type="secondary">{title}</Text>
        <span>
          <strong>{formatter(used)}</strong>
          <Text type="secondary"> / {formatter(limit)}</Text>
        </span>
      </div>
      <Progress
        percent={percent}
        size="small"
        showInfo={false}
        status={percent >= 100 ? 'exception' : percent >= 80 ? 'active' : 'normal'}
      />
    </div>
  )
}

function SkillCatalogLimitsCard({ isAdmin }: { isAdmin: boolean }) {
  const { message } = AntApp.useApp()
  const queryClient = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [form] = Form.useForm<SkillLimitsForm>()

  const limitsQuery = useQuery({
    queryKey: ['admin-skill-catalog-limits'],
    enabled: isAdmin,
    queryFn: adminGetSkillCatalogLimits,
  })
  const catalogQuery = useQuery({
    queryKey: ['admin-review-skills'],
    enabled: isAdmin,
    queryFn: adminListReviewSkills,
  })

  const updateMutation = useMutation({
    mutationFn: (values: SkillLimitsForm) =>
      adminUpdateSkillCatalogLimits({
        catalogBundles: values.catalogBundles,
        catalogRenderBytes: Math.round(values.catalogRenderKiB * KIB),
        catalogArchiveBytes: Math.round(values.catalogArchiveMiB * MIB),
        catalogExpandedBytes: Math.round(values.catalogExpandedMiB * MIB),
      }),
    onSuccess: (config: SkillCatalogLimitsConfig) => {
      queryClient.setQueryData(['admin-skill-catalog-limits'], config)
      message.success('技能目录容量上限已更新；仅影响之后新建的批次')
      setEditing(false)
      form.resetFields()
    },
    onError: (error: Error) => message.error(error.message),
  })

  const limits = limitsQuery.data
  const capacity = catalogQuery.data?.capacity

  const beginEdit = () => {
    if (!limits) return
    form.setFieldsValue({
      catalogBundles: limits.catalogBundles,
      catalogRenderKiB: Math.round(limits.catalogRenderBytes / KIB),
      catalogArchiveMiB: Math.round(limits.catalogArchiveBytes / MIB),
      catalogExpandedMiB: Math.round(limits.catalogExpandedBytes / MIB),
    })
    setEditing(true)
  }

  return (
    <Card
      className="harness-policy-card harness-policy-skill-card"
      title="技能目录容量上限（平台级）"
      loading={limitsQuery.isLoading}
      extra={
        editing ? (
          <Space>
            <Button onClick={() => setEditing(false)} disabled={updateMutation.isPending}>
              取消
            </Button>
            <Button type="primary" loading={updateMutation.isPending} onClick={() => form.submit()}>
              保存
            </Button>
          </Space>
        ) : (
          <Button type="primary" disabled={!limits} onClick={beginEdit}>
            编辑
          </Button>
        )
      }
    >
      {limitsQuery.isError ? (
        <Alert type="error" showIcon title="容量上限加载失败" description={limitsQuery.error.message} />
      ) : !limits ? (
        <Empty description="未返回技能目录容量上限" />
      ) : (
        <Form
          form={form}
          layout="vertical"
          onFinish={(values) => updateMutation.mutate(values)}
        >
          {capacity ? (
            <section className="hps-capacity-overview" aria-label="技能目录当前使用量">
              <div className="hps-capacity-overview-head">
                <div>
                  <Text strong>当前目录使用量</Text>
                  <Text type="secondary">实时统计已发布且启用的技能版本</Text>
                </div>
              </div>
              <div className="hps-capacity-grid">
                <CatalogCapacityMeter title="已启用技能" used={capacity.enabled_bundles} limit={limits.catalogBundles} />
                <CatalogCapacityMeter title="首轮目录渲染" used={capacity.catalog_render_bytes} limit={limits.catalogRenderBytes} formatter={formatBytes} />
                <CatalogCapacityMeter title="归档总量" used={capacity.archive_bytes} limit={limits.catalogArchiveBytes} formatter={formatBytes} />
                <CatalogCapacityMeter title="展开总量" used={capacity.expanded_bytes} limit={limits.catalogExpandedBytes} formatter={formatBytes} />
              </div>
            </section>
          ) : null}
          <div className="hps-limit-divider">
            <Text strong>目录容量上限</Text>
            <Text type="secondary">保存后仅影响之后新建的批次</Text>
          </div>
          <div className="hps-rows hps-rows--grid">
            <ParamRow editing={editing} label="已启用技能数上限" value={limits.catalogBundles} name={['catalogBundles']} min={1} max={200} suffix="个" />
            <ParamRow editing={editing} label="首轮目录渲染上限" value={Math.round(limits.catalogRenderBytes / KIB)} name={['catalogRenderKiB']} min={8} max={128} suffix="KiB" />
            <ParamRow editing={editing} label="归档总量上限" value={Math.round(limits.catalogArchiveBytes / MIB)} name={['catalogArchiveMiB']} min={10} max={1024} suffix="MiB" />
            <ParamRow editing={editing} label="展开总量上限" value={Math.round(limits.catalogExpandedBytes / MIB)} name={['catalogExpandedMiB']} min={50} max={2048} suffix="MiB" />
          </div>
        </Form>
      )}
    </Card>
  )
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
  const effectiveModel = models.find((model) => model.id === effectiveModelId)
  const capabilityEntries = Object.entries(capabilityLabels) as [keyof V4Capabilities, string][]
  const enabledCapabilityCount = policy
    ? capabilityEntries.filter(([key]) => policy.capabilities[key]).length
    : 0

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
    <div className="page-stack harness-policy-page">
      <section className="harness-policy-masthead">
        <div className="harness-policy-masthead-copy">
          <div className="harness-policy-title-row">
            <Title level={2} className="sidebar-page-title__heading">默认能力策略</Title>
            <Tag className="harness-policy-status-tag">{editing ? '配置中' : '按模型生效'}</Tag>
          </div>
          <Text className="harness-policy-subtitle">
            管理 Harness 的运行资源、Agent 协作和会话边界；保存仅用于之后创建的新任务。
          </Text>
        </div>
        <div className="harness-policy-controls">
          <Select
            value={effectiveModelId}
            loading={modelsQuery.isLoading}
            disabled={editing || models.length === 0}
            placeholder="选择模型配置"
            className="harness-policy-model-select"
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
        </div>
      </section>

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
          <div className="harness-policy-workbench">
            <section className="harness-policy-snapshot" aria-label="当前策略摘要">
              <div className="harness-policy-snapshot-item">
                <span>能力契约</span>
                <strong>{enabledCapabilityCount} / {capabilityEntries.length}</strong>
                <small>锁定开启</small>
              </div>
              <div className="harness-policy-snapshot-item">
                <span>命令超时</span>
                <strong>{formatMs(policy.sandbox.commandTimeoutMs)}</strong>
                <small>单次 Sandbox</small>
              </div>
              <div className="harness-policy-snapshot-item">
                <span>最大 Agent</span>
                <strong>{policy.agents.maxAgentsPerAttempt}</strong>
                <small>每次尝试</small>
              </div>
              <div className="harness-policy-snapshot-item">
                <span>模型请求</span>
                <strong>{policy.modelBudget.maxTotalRequests}</strong>
                <small>总预算上限</small>
              </div>
            </section>

            <Card className="harness-policy-card harness-policy-capability-card" title="能力契约（Harness contract 锁定）">
              <div className="harness-policy-capability-intro">
                <Paragraph type="secondary">
                  20 个模型能力保持开启，以保证 Worker 工具清单与 manifest hash 一致；此处不提供开关。
                </Paragraph>
                <Text className="harness-policy-lock-note">契约状态 · 已锁定</Text>
              </div>
              <div className="harness-policy-capability-grid">
                {capabilityEntries.map(([key, label]) => (
                  <div className="harness-policy-capability-item" key={key}>
                    <span className={policy.capabilities[key] ? 'harness-policy-capability-check is-enabled' : 'harness-policy-capability-check'}>
                      {policy.capabilities[key] ? '✓' : '—'}
                    </span>
                    <span>{label}</span>
                  </div>
                ))}
              </div>
            </Card>

            <div className="harness-policy-sheet">
              <header className="hps-sheet-head">
                <h3>运行资源限额</h3>
                <span>
                  作用于 <code>{effectiveModel ? effectiveModel.display_name : '—'}</code>，保存仅影响之后新建的任务
                </span>
              </header>

              <section className="hps-section">
                <div className="hps-rail">
                  <h4>Sandbox 沙箱资源</h4>
                  <p>每条命令在隔离沙箱中的时长、进程与容量边界。</p>
                  <ul className="hps-rail-notes">
                    <li>默认模式 {policy.sandbox.defaultMode}</li>
                    <li>完全访问已禁用</li>
                  </ul>
                </div>
                <div className="hps-rows">
                  <ParamRow editing={editing} label="命令超时" value={policy.sandbox.commandTimeoutMs} name={['sandbox', 'commandTimeoutMs']} min={1000} max={600000} step={1000} suffix="ms" display={formatMs(policy.sandbox.commandTimeoutMs)} raw={`${formatGrouped(policy.sandbox.commandTimeoutMs)} ms`} />
                  <ParamRow editing={editing} label="最大进程数" value={policy.sandbox.maxProcessesPerAttempt} name={['sandbox', 'maxProcessesPerAttempt']} min={1} max={4096} />
                  <ParamRow editing={editing} label="工作区最大字节" value={policy.sandbox.maxWorkspaceBytes} name={['sandbox', 'maxWorkspaceBytes']} min={1048576} max={1099511627776} step={1048576} display={formatBytes(policy.sandbox.maxWorkspaceBytes)} raw={`${formatGrouped(policy.sandbox.maxWorkspaceBytes)} B`} />
                  <ParamRow editing={editing} label="工作区最大文件数" value={policy.sandbox.maxWorkspaceFiles} name={['sandbox', 'maxWorkspaceFiles']} min={100} max={10000000} step={100} />
                </div>
              </section>

              <section className="hps-section">
                <div className="hps-rail">
                  <h4>Agent Tree 上限</h4>
                  <p>一次尝试内可派生的 Agent 规模与委派深度。</p>
                  <ul className="hps-rail-notes">
                    <li>进程外 Provider 已禁用</li>
                  </ul>
                </div>
                <div className="hps-rows">
                  <ParamRow editing={editing} label="每次尝试最大 Agent 数" value={policy.agents.maxAgentsPerAttempt} name={['agents', 'maxAgentsPerAttempt']} min={1} max={64} />
                  <ParamRow editing={editing} label="最大委派深度" value={policy.agents.maxDelegationDepth} name={['agents', 'maxDelegationDepth']} min={0} max={8} />
                  <ParamRow editing={editing} label="最大并发子 Agent" value={policy.agents.maxConcurrentChildren} name={['agents', 'maxConcurrentChildren']} min={1} max={32} />
                </div>
              </section>

              <section className="hps-section">
                <div className="hps-rail">
                  <h4>分层模型预算</h4>
                  <p>一次尝试内，各类模型请求的计数预算。</p>
                  <ul className="hps-rail-notes">
                    <li>上下文窗口与单次最大输出在「模型管理」维护</li>
                  </ul>
                </div>
                <div className="hps-rows">
                  <ParamRow editing={editing} label="总请求上限" value={policy.modelBudget.maxTotalRequests} name={['modelBudget', 'maxTotalRequests']} min={1} max={10000} />
                  <ParamRow editing={editing} label="根 Agent 请求上限" value={policy.modelBudget.maxRootRequests} name={['modelBudget', 'maxRootRequests']} min={1} max={10000} />
                  <ParamRow editing={editing} label="子 Agent 请求上限" value={policy.modelBudget.maxChildRequests} name={['modelBudget', 'maxChildRequests']} min={1} max={10000} />
                  <ParamRow editing={editing} label="重试请求上限" value={policy.modelBudget.maxRetryRequests} name={['modelBudget', 'maxRetryRequests']} min={0} max={100} />
                  <ParamRow editing={editing} label="压缩请求上限" value={policy.modelBudget.maxCompactionRequests} name={['modelBudget', 'maxCompactionRequests']} min={0} max={100} />
                  <ParamRow editing={editing} label="Ralph 轮次上限" value={policy.modelBudget.maxRalphRounds} name={['modelBudget', 'maxRalphRounds']} min={0} max={256} />
                </div>
              </section>

              <section className="hps-section">
                <div className="hps-rail">
                  <h4>并行工具 / 工作流 / Jobs</h4>
                  <p>工具并发上限，以及工作流与后台 Job 的运行时长。</p>
                  <ul className="hps-rail-notes">
                    <li>变更类工具固定串行执行</li>
                  </ul>
                </div>
                <div className="hps-rows">
                  <ParamRow editing={editing} label="每步最大并行工具数" value={policy.parallelTools.maxPerStep} name={['parallelTools', 'maxPerStep']} min={1} max={64} />
                  <ParamRow editing={editing} label="工作流最大并发步骤" value={policy.workflow.maxConcurrentSteps} name={['workflow', 'maxConcurrentSteps']} min={1} max={32} />
                  <ParamRow editing={editing} label="工作流最大运行时长" value={policy.workflow.maxRuntimeMs} name={['workflow', 'maxRuntimeMs']} min={1000} max={86400000} step={1000} suffix="ms" display={formatMs(policy.workflow.maxRuntimeMs)} raw={`${formatGrouped(policy.workflow.maxRuntimeMs)} ms`} />
                  <ParamRow editing={editing} label="每 Owner 最大并发 Job" value={policy.jobs.maxConcurrentJobsPerOwner} name={['jobs', 'maxConcurrentJobsPerOwner']} min={1} max={64} />
                  <ParamRow editing={editing} label="Job 最大运行时长" value={policy.jobs.maxRuntimeMs} name={['jobs', 'maxRuntimeMs']} min={1000} max={86400000} step={1000} suffix="ms" display={formatMs(policy.jobs.maxRuntimeMs)} raw={`${formatGrouped(policy.jobs.maxRuntimeMs)} ms`} />
                </div>
              </section>

              <section className="hps-section">
                <div className="hps-rail">
                  <h4>Web egress 白名单</h4>
                  <p>出网请求的域名白名单、配额与协议边界。</p>
                  <ul className="hps-rail-notes">
                    <li>仅 HTTPS / 443</li>
                    <li>私有网络已禁止</li>
                    <li>最大重定向 {policy.web.maxRedirects} 次</li>
                    <li>请求超时 {formatMs(policy.web.requestTimeoutMs)}</li>
                  </ul>
                </div>
                <div className="hps-rows">
                  <ParamRow editing={editing} label="每次尝试最大请求数" value={policy.web.maxRequestsPerAttempt} name={['web', 'maxRequestsPerAttempt']} min={0} max={10000} />
                  <ParamRow editing={editing} label="单响应最大字节" value={policy.web.maxResponseBytes} name={['web', 'maxResponseBytes']} min={1024} max={1073741824} step={1024} display={formatBytes(policy.web.maxResponseBytes)} raw={`${formatGrouped(policy.web.maxResponseBytes)} B`} />
                  <ParamRow editing={editing} label="累计最大字节" value={policy.web.maxTotalBytes} name={['web', 'maxTotalBytes']} min={1024} max={109951162777} step={1024} display={formatBytes(policy.web.maxTotalBytes)} raw={`${formatGrouped(policy.web.maxTotalBytes)} B`} />
                  <div className="hps-row hps-row--domains">
                    <span className="hps-row-label">允许域名</span>
                    {editing ? (
                      <Form.Item name={['web', 'allowedDomains']} className="hps-domains-field">
                        <Select mode="tags" tokenSeparators={[',', ' ']} placeholder="输入域名后回车，例如 api.example.com" />
                      </Form.Item>
                    ) : policy.web.allowedDomains.length ? (
                      <span className="hps-domain-tags">
                        {policy.web.allowedDomains.map((domain) => <Tag key={domain}>{domain}</Tag>)}
                      </span>
                    ) : (
                      <span className="hps-row-value">
                        <small>未配置，Web 请求将被拒绝</small>
                      </span>
                    )}
                  </div>
                </div>
              </section>

              <section className="hps-section">
                <div className="hps-rail">
                  <h4>Session 保留</h4>
                  <p>会话检查点的写入频率与数据保留周期。</p>
                  <ul className="hps-rail-notes">
                    <li>静态加密已开启</li>
                    <li>Worker 重启恢复已开启</li>
                  </ul>
                </div>
                <div className="hps-rows">
                  <ParamRow editing={editing} label="检查点事件间隔" value={policy.session.checkpointEveryEvents} name={['session', 'checkpointEveryEvents']} min={1} max={100000} />
                  <ParamRow editing={editing} label="保留天数" value={policy.session.retentionDays} name={['session', 'retentionDays']} min={1} max={365} suffix="天" />
                </div>
              </section>
            </div>
          </div>
        </Form>
      ) : (
        <Empty description="未返回能力策略" />
      )}

      <SkillCatalogLimitsCard isAdmin={isAdmin} />
    </div>
  )
}
