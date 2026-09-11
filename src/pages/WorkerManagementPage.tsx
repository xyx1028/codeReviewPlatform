import { Alert, Card, Col, Empty, Row, Space, Statistic, Table, Tag, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { adminListAnalysisWorkers } from '../lib/api'
import type {
  AnalysisWorkerAssignment,
  AnalysisWorkerDetail,
  AnalysisWorkerPhase,
} from '../types'

const { Title, Text } = Typography

const phaseMeta: Record<AnalysisWorkerPhase, { label: string; color: string }> = {
  PREPARING: { label: '代码准备', color: 'cyan' },
  AGENT: { label: 'Agent 审核', color: 'magenta' },
  FINALIZING: { label: '结果汇总', color: 'geekblue' },
}

const UNKNOWN_PHASE = { label: '未知阶段', color: 'default' }

function shortId(value: string) {
  return value.slice(0, 8)
}

function WorkerAssignmentView({ assignment }: { assignment: AnalysisWorkerAssignment }) {
  // 未知阶段来自更新的后端；显示占位而不是崩溃。
  const phase = phaseMeta[assignment.phase] ?? UNKNOWN_PHASE
  return (
    <div>
      <Space wrap size={[6, 4]}>
        <Tag color={phase.color}>{phase.label}</Tag>
        <Link to={`/batches/${assignment.batch_id}/ai-result`}>
          {assignment.batch_name}
        </Link>
        <Text type="secondary">{assignment.week_code}</Text>
      </Space>
      <div>
        <Text type="secondary">
          {assignment.story_code
            ? `需求 ${assignment.story_code}${assignment.story_name ? ` · ${assignment.story_name}` : ''}`
            : `分析任务 ${shortId(assignment.job_id)}`}
          {' · '}{assignment.requested_branch}
        </Text>
      </div>
    </div>
  )
}

export function WorkerManagementPage({ isAdmin }: { isAdmin: boolean }) {
  const workersQuery = useQuery({
    queryKey: ['admin-analysis-workers'],
    enabled: isAdmin,
    queryFn: adminListAnalysisWorkers,
    refetchInterval: 5000,
    refetchIntervalInBackground: false,
    staleTime: 3000,
  })

  if (!isAdmin) {
    return <Alert type="error" showIcon title="无权限访问" description="只有管理员可以查看后台任务运行状态。" />
  }

  const overview = workersQuery.data
  const columns: ColumnsType<AnalysisWorkerDetail> = [
    {
      title: 'Worker',
      dataIndex: 'worker_id',
      width: 220,
      render: (workerId: string) => <Text code>{workerId}</Text>,
    },
    {
      title: '在线状态',
      width: 110,
      render: (_value, worker) => (
        <Tag color={worker.online ? 'green' : 'default'}>
          {worker.online ? '在线' : '离线'}
        </Tag>
      ),
    },
    {
      title: '工作状态',
      width: 110,
      render: (_value, worker) => (
        <Tag color={worker.working ? 'processing' : 'default'}>
          {worker.working ? '工作中' : '空闲'}
        </Tag>
      ),
    },
    {
      title: '需求槽位',
      width: 120,
      render: (_value, worker) => `${worker.reported_current_tasks} / ${worker.slots}`,
    },
    {
      title: '当前代码评审任务',
      render: (_value, worker) => worker.assignments.length ? (
        <Space direction="vertical" size="middle">
          {worker.assignments.map((assignment) => (
            <WorkerAssignmentView
              key={`${assignment.phase}-${assignment.task_id ?? assignment.job_id}`}
              assignment={assignment}
            />
          ))}
        </Space>
      ) : <Text type="secondary">当前空闲</Text>,
    },
    {
      title: '最后心跳',
      dataIndex: 'last_seen_at',
      width: 190,
      render: (value: string) => new Date(value).toLocaleString(),
    },
  ]

  return (
    <Space direction="vertical" size="large" className="page-stack">
      <div className="page-title">
        <Title level={2}>后台任务监控</Title>
        <Tag color="blue">每 5 秒刷新</Tag>
      </div>

      <Alert
        type="info"
        showIcon
        title="Worker 负责执行自动 AI 分析"
        description="这里展示当前在线 Worker、工作状态以及正在处理的代码评审批次。所有 Worker 均执行统一的 DeepSeek Harness Agent 链路；数据库按槽位、任务租约和模型并发限制分配任务。Worker 超过 20 秒没有心跳后将不再计入在线数量。"
      />

      <Row gutter={[16, 16]}>
        <Col xs={12} lg={6}><Card><Statistic title="在线 Worker" value={overview?.online_count ?? 0} /></Card></Col>
        <Col xs={12} lg={6}><Card><Statistic title="工作中" value={overview?.working_count ?? 0} /></Card></Col>
        <Col xs={12} lg={6}><Card><Statistic title="空闲" value={overview?.idle_count ?? 0} /></Card></Col>
        <Col xs={12} lg={6}>
          <Card>
            <Statistic
              title="需求槽位"
              value={overview ? `${overview.reported_current_tasks} / ${overview.total_slots}` : '0 / 0'}
            />
          </Card>
        </Col>
      </Row>

      {workersQuery.isError ? (
        <Alert
          type="error"
          showIcon
          title="后台任务状态加载失败"
          description={workersQuery.error.message}
        />
      ) : null}

      <Card
        title="Worker 列表"
        extra={overview?.generated_at ? <Text type="secondary">更新时间：{new Date(overview.generated_at).toLocaleString()}</Text> : null}
      >
        <Table<AnalysisWorkerDetail>
          rowKey="worker_id"
          loading={workersQuery.isLoading}
          dataSource={overview?.workers ?? []}
          columns={columns}
          pagination={false}
          scroll={{ x: 980 }}
          locale={{ emptyText: <Empty description="当前没有在线 Worker" /> }}
        />
      </Card>
    </Space>
  )
}
