import { Alert, Card, Empty, Space, Table, Tag, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { adminListAnalysisWorkers, adminListRecoveryStoryLeases } from '../lib/api'
import { SidebarPageTitle } from '../components/SidebarPageTitle'
import type {
  AnalysisWorkerAssignment,
  AnalysisWorkerDetail,
  AnalysisWorkerPhase,
  AnalysisRecoveryLease,
} from '../types'

const { Text } = Typography

const phaseMeta: Record<AnalysisWorkerPhase, { label: string; color: string }> = {
  PREPARING: { label: '代码准备', color: 'cyan' },
  AGENT: { label: 'Agent 审核', color: 'magenta' },
  FINALIZING: { label: '结果汇总', color: 'geekblue' },
}

const UNKNOWN_PHASE = { label: '未知阶段', color: 'default' }

function shortId(value: string) {
  return value.slice(0, 8)
}

function WorkerAssignmentView({
  assignment,
  recovering,
}: {
  assignment: AnalysisWorkerAssignment
  recovering: boolean
}) {
  // 未知阶段来自更新的后端；显示占位而不是崩溃。
  const phase = phaseMeta[assignment.phase] ?? UNKNOWN_PHASE
  return (
    <div>
      <Space wrap size={[6, 4]}>
        <Tag color={phase.color}>{phase.label}</Tag>
        {recovering ? <Tag color="orange">待恢复租约</Tag> : null}
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

function agentLeaseCount(worker: AnalysisWorkerDetail): number {
  return worker.assignments.filter((assignment) => assignment.phase === 'AGENT').length
}

/**
 * The worker reports live in-process slots. The assignments list is sourced
 * from database leases, which can outlive a stopped process. A difference is
 * therefore visible recovery work, not spare capacity.
 */
function recoveryLeaseCount(worker: AnalysisWorkerDetail): number {
  return Math.max(0, agentLeaseCount(worker) - worker.reported_current_tasks)
}

function OfflineRecoveryLeaseView({ lease }: { lease: AnalysisRecoveryLease }) {
  return (
    <Space wrap size={[6, 2]}>
      <Tag color="orange">待恢复租约</Tag>
      <Text code>{lease.worker_id}</Text>
      <Link to={`/batches/${lease.batch_id}/ai-result`}>{lease.batch_name}</Link>
      <Text type="secondary">
        {lease.story_code ?? shortId(lease.job_id)}
        {lease.lease_expires_at ? ` · 租约到期：${new Date(lease.lease_expires_at).toLocaleString()}` : ''}
      </Text>
    </Space>
  )
}

export function WorkerManagementPage({ isAdmin }: { isAdmin: boolean }) {
  const workersQuery = useQuery({
    queryKey: ['admin-analysis-workers'],
    enabled: isAdmin,
    queryFn: adminListAnalysisWorkers,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
    staleTime: 3000,
  })
  const recoveryLeasesQuery = useQuery({
    queryKey: ['admin-analysis-recovery-leases'],
    enabled: isAdmin,
    queryFn: adminListRecoveryStoryLeases,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
    staleTime: 3000,
  })

  if (!isAdmin) {
    return <Alert type="error" showIcon title="无权限访问" description="只有管理员可以查看后台任务运行状态。" />
  }

  const overview = workersQuery.data
  const workers = overview?.workers ?? []
  const inProcessRecoveryLeaseTotal = workers.reduce(
    (total, worker) => total + recoveryLeaseCount(worker),
    0,
  )
  const offlineRecoveryLeases = recoveryLeasesQuery.data ?? []
  const recoveringLeaseTotal = inProcessRecoveryLeaseTotal + offlineRecoveryLeases.length
  const activeWorkerCount = workers.filter((worker) => worker.reported_current_tasks > 0).length
  const recoveringWorkerCount = workers.filter((worker) => recoveryLeaseCount(worker) > 0).length
  const idleWorkerCount = workers.length - activeWorkerCount - recoveringWorkerCount
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
      render: (_value, worker) => {
        const recovering = recoveryLeaseCount(worker)
        if (worker.reported_current_tasks > 0) {
          return (
            <Space size={4}>
              <Tag color="processing">工作中</Tag>
              {recovering > 0 ? <Tag color="orange">{recovering} 待恢复</Tag> : null}
            </Space>
          )
        }
        return <Tag color={recovering > 0 ? 'orange' : 'default'}>{recovering > 0 ? '待恢复' : '空闲'}</Tag>
      },
    },
    {
      title: '需求槽位',
      width: 120,
      render: (_value, worker) => `${worker.reported_current_tasks} / ${worker.slots}`,
    },
    {
      title: '当前代码评审任务',
      render: (_value, worker) => {
        const recovering = recoveryLeaseCount(worker)
        return worker.assignments.length ? (
          <Space direction="vertical" size="middle">
            {recovering > 0 ? (
              <Text type="warning">
                数据库有 {recovering} 条有效 Agent 租约，但当前进程没有对应运行槽位；Worker 重启后会等待其主动释放或租约到期回收。
              </Text>
            ) : null}
            {worker.assignments.map((assignment) => (
              <WorkerAssignmentView
                key={`${assignment.phase}-${assignment.task_id ?? assignment.job_id}`}
                assignment={assignment}
                recovering={
                  assignment.phase === 'AGENT'
                  && worker.reported_current_tasks === 0
                  && recovering > 0
                }
              />
            ))}
          </Space>
        ) : <Text type="secondary">当前空闲</Text>
      },
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
      <SidebarPageTitle title="后台任务监控" />

      <section className="worker-summary" aria-label="Worker 运行概览">
        <div className="worker-summary__item worker-summary__item--online">
          <span className="worker-summary__label">在线 Worker</span>
          <strong className="worker-summary__value">{overview?.online_count ?? 0}</strong>
        </div>
        <div className="worker-summary__item worker-summary__item--active">
          <span className="worker-summary__label">工作中</span>
          <strong className="worker-summary__value">{activeWorkerCount}</strong>
        </div>
        <div className="worker-summary__item worker-summary__item--recovery">
          <span className="worker-summary__label">待恢复租约</span>
          <strong className="worker-summary__value">{recoveringLeaseTotal}</strong>
        </div>
        <div className="worker-summary__item worker-summary__item--idle">
          <span className="worker-summary__label">空闲</span>
          <strong className="worker-summary__value">{Math.max(0, idleWorkerCount)}</strong>
        </div>
        <div className="worker-summary__item worker-summary__item--capacity">
          <span className="worker-summary__label">需求槽位</span>
          <strong className="worker-summary__value">
            {overview ? `${overview.reported_current_tasks} / ${overview.total_slots}` : '0 / 0'}
          </strong>
        </div>
      </section>

      {offlineRecoveryLeases.length > 0 ? (
        <Alert
          type="warning"
          showIcon
          title={`发现 ${offlineRecoveryLeases.length} 条离线 Worker 遗留租约`}
          description={
            <Space direction="vertical" size={4}>
              <Text>
                原 Worker 已不在线，任务不会计入任何运行槽位；它会在旧进程主动释放或租约到期后重新进入队列。
              </Text>
              {offlineRecoveryLeases.map((lease) => (
                <OfflineRecoveryLeaseView key={lease.task_id ?? lease.job_id} lease={lease} />
              ))}
            </Space>
          }
        />
      ) : null}

      {workersQuery.isError ? (
        <Alert
          type="error"
          showIcon
          title="后台任务状态加载失败"
          description={workersQuery.error.message}
        />
      ) : null}

      {recoveryLeasesQuery.isError ? (
        <Alert
          type="warning"
          showIcon
          title="遗留租约状态加载失败"
          description={recoveryLeasesQuery.error.message}
        />
      ) : null}

      <Card title="Worker 列表">
        <Table<AnalysisWorkerDetail>
          rowKey="worker_id"
          loading={workersQuery.isLoading}
          dataSource={workers}
          columns={columns}
          pagination={{ pageSize: 10, showSizeChanger: true, pageSizeOptions: [10, 20, 50, 100] }}
          scroll={{ x: 980 }}
          locale={{ emptyText: <Empty description="当前没有在线 Worker" /> }}
        />
      </Card>
    </Space>
  )
}
