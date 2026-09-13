import { Alert, Card, Col, Descriptions, Empty, Row, Space, Statistic, Tag, Typography } from 'antd'
import { useQuery } from '@tanstack/react-query'
import { adminGetV4CapabilityPolicy } from '../lib/api'
import type { V4Capabilities } from '../types'

const { Title, Text, Paragraph } = Typography

// 20 个能力开关的中文标签。顺序与后端 build_v4_capability_policy 一致，便于比对。
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

/**
 * 默认能力策略（仅 ADMIN 只读展示）。
 * 明确定位：这是“看默认策略长什么样”的只读页面，不提供任何开关。
 * 普通启动流程仍然只有一个“开始 AI 分析”按钮，点一下由后端自动冻结默认 V4 Policy。
 */
export function HarnessPolicyPage({ isAdmin }: { isAdmin: boolean }) {
  const policyQuery = useQuery({
    queryKey: ['v4-capability-policy'],
    enabled: isAdmin,
    queryFn: adminGetV4CapabilityPolicy,
  })

  if (!isAdmin) {
    return <Alert type="warning" showIcon title="无权限访问" description="只有管理员可以查看默认能力策略。" />
  }

  const policy = policyQuery.data
  const capabilityEntries = Object.entries(capabilityLabels) as [keyof V4Capabilities, string][]

  return (
    <Space direction="vertical" size="large" className="page-stack">
      <div className="page-title">
        <Title level={2}>默认能力策略</Title>
        <Tag color="blue">只读</Tag>
      </div>

      {policyQuery.isError ? (
        <Alert type="error" showIcon title="能力策略加载失败" description={policyQuery.error.message} />
      ) : null}

      {policyQuery.isLoading ? (
        <Card loading />
      ) : policy ? (
        <>
          <Card title="能力开关">
            <Paragraph type="secondary">全部 20 个能力默认开启；本页只读，不提供关闭入口。</Paragraph>
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

          <Card title="Sandbox 沙箱">
            <Descriptions column={{ xs: 1, md: 2 }} size="small" bordered>
              <Descriptions.Item label="默认模式">{policy.sandbox.defaultMode}</Descriptions.Item>
              <Descriptions.Item label="完全访问">{policy.sandbox.dangerFullAccess ? '开启' : '关闭'}</Descriptions.Item>
              <Descriptions.Item label="命令超时">{policy.sandbox.commandTimeoutMs} ms</Descriptions.Item>
              <Descriptions.Item label="每次尝试最大进程数">{policy.sandbox.maxProcessesPerAttempt}</Descriptions.Item>
              <Descriptions.Item label="工作区最大字节">{policy.sandbox.maxWorkspaceBytes}</Descriptions.Item>
              <Descriptions.Item label="工作区最大文件数">{policy.sandbox.maxWorkspaceFiles}</Descriptions.Item>
            </Descriptions>
          </Card>

          <Card title="Agent Tree 上限">
            <Row gutter={[16, 16]}>
              <Col xs={12} md={6}><Statistic title="每次尝试最大 Agent 数" value={policy.agents.maxAgentsPerAttempt} /></Col>
              <Col xs={12} md={6}><Statistic title="最大委派深度" value={policy.agents.maxDelegationDepth} /></Col>
              <Col xs={12} md={6}><Statistic title="最大并发子 Agent" value={policy.agents.maxConcurrentChildren} /></Col>
              <Col xs={12} md={6}>
                <Statistic title="允许进程外 Provider" value={policy.agents.allowOutOfProcessProviders ? '是' : '否'} />
              </Col>
            </Row>
          </Card>

          <Card title="分层模型预算">
            <Row gutter={[16, 16]}>
              <Col xs={12} md={8}><Statistic title="总请求上限" value={policy.modelBudget.maxTotalRequests} /></Col>
              <Col xs={12} md={8}><Statistic title="根 Agent 请求上限" value={policy.modelBudget.maxRootRequests} /></Col>
              <Col xs={12} md={8}><Statistic title="子 Agent 请求上限" value={policy.modelBudget.maxChildRequests} /></Col>
              <Col xs={12} md={8}><Statistic title="重试请求上限" value={policy.modelBudget.maxRetryRequests} /></Col>
              <Col xs={12} md={8}><Statistic title="压缩请求上限" value={policy.modelBudget.maxCompactionRequests} /></Col>
              <Col xs={12} md={8}><Statistic title="Ralph 轮次上限" value={policy.modelBudget.maxRalphRounds} /></Col>
            </Row>
          </Card>

          <Card title="并行工具 / 工作流 / Jobs">
            <Descriptions column={{ xs: 1, md: 2 }} size="small" bordered>
              <Descriptions.Item label="每步最大并行工具数">{policy.parallelTools.maxPerStep}</Descriptions.Item>
              <Descriptions.Item label="变更类工具串行">{policy.parallelTools.mutationToolsSerial ? '是' : '否'}</Descriptions.Item>
              <Descriptions.Item label="工作流最大并发步骤">{policy.workflow.maxConcurrentSteps}</Descriptions.Item>
              <Descriptions.Item label="工作流最大运行时长">{policy.workflow.maxRuntimeMs} ms</Descriptions.Item>
              <Descriptions.Item label="每 Owner 最大并发 Job">{policy.jobs.maxConcurrentJobsPerOwner}</Descriptions.Item>
              <Descriptions.Item label="Job 最大运行时长">{policy.jobs.maxRuntimeMs} ms</Descriptions.Item>
            </Descriptions>
          </Card>

          <Card title="Web egress allowlist">
            <Descriptions column={{ xs: 1, md: 2 }} size="small" bordered>
              <Descriptions.Item label="每次尝试最大请求数">{policy.web.maxRequestsPerAttempt}</Descriptions.Item>
              <Descriptions.Item label="单响应最大字节">{policy.web.maxResponseBytes}</Descriptions.Item>
              <Descriptions.Item label="累计最大字节">{policy.web.maxTotalBytes}</Descriptions.Item>
              <Descriptions.Item label="允许 HTTP">{policy.web.allowHttp ? '是' : '否'}</Descriptions.Item>
              <Descriptions.Item label="允许端口">{policy.web.allowedPorts.join('、')}</Descriptions.Item>
              <Descriptions.Item label="禁止私有网络">{policy.web.denyPrivateNetworks ? '是' : '否'}</Descriptions.Item>
              <Descriptions.Item label="最大重定向">{policy.web.maxRedirects}</Descriptions.Item>
              <Descriptions.Item label="请求超时">{policy.web.requestTimeoutMs} ms</Descriptions.Item>
              <Descriptions.Item label="允许域名" span={2}>
                {policy.web.allowedDomains.length ? (
                  <Space wrap size={[6, 6]}>
                    {policy.web.allowedDomains.map((domain) => <Tag key={domain}>{domain}</Tag>)}
                  </Space>
                ) : (
                  <Text type="secondary">未配置允许域名</Text>
                )}
              </Descriptions.Item>
            </Descriptions>
          </Card>

          <Card title="Session 保留期">
            <Descriptions column={{ xs: 1, md: 2 }} size="small" bordered>
              <Descriptions.Item label="每多少事件建立检查点">{policy.session.checkpointEveryEvents}</Descriptions.Item>
              <Descriptions.Item label="保留天数">{policy.session.retentionDays} 天</Descriptions.Item>
              <Descriptions.Item label="静态加密">{policy.session.encryptAtRest ? '是' : '否'}</Descriptions.Item>
              <Descriptions.Item label="Worker 重启后恢复">{policy.session.resumeOnWorkerRestart ? '是' : '否'}</Descriptions.Item>
            </Descriptions>
          </Card>
        </>
      ) : (
        <Empty description="未返回能力策略" />
      )}
    </Space>
  )
}
