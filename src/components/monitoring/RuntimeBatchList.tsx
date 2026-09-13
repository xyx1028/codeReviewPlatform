import { Button, Card, Empty, Progress, Space, Table, Tag, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { Link } from 'react-router-dom'
import type { ActiveAnalysisBatch } from '../../types'
import { analysisJobStatusMeta } from '../../lib/labels'
import { RuntimeFreshnessBadge } from './RuntimeFreshnessBadge'
import { formatAge, formatElapsed } from '../../lib/runtime-format'
import { computeRuntimeFreshness } from '../../hooks/useRuntimeConsole'

const { Text } = Typography

function batchFreshness(batch: ActiveAnalysisBatch, serverTime: string) {
  return computeRuntimeFreshness({
    serverTime,
    lastEventAt: batch.last_event_at,
    watermarkLagMs: batch.watermark_lag_ms,
    heartbeatAt: null,
    isRunning: batch.running_stories > 0,
  })
}

/**
 * 运行批次列表。
 *
 * 进度只显示可验证计数（`已完成 / 总数`），不显示虚构百分比 —— 一个「73%」在
 * 没有真实剩余量估算的情况下只是安慰剂。
 */
export function RuntimeBatchList({
  batches,
  serverTime,
  selectedBatchId,
  onSelect,
  isMobile,
}: {
  batches: ActiveAnalysisBatch[]
  serverTime: string
  selectedBatchId: string | null
  onSelect(batchId: string): void
  isMobile: boolean
}) {
  const now = Date.parse(serverTime)

  if (batches.length === 0) {
    return (
      <Card title="运行批次">
        <Empty description="当前没有正在准备、分析或汇总的批次" />
      </Card>
    )
  }

  if (isMobile) {
    return (
      <Card title="运行批次" size="small">
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          {batches.map((batch) => {
            const jobMeta = analysisJobStatusMeta[batch.job_status]
            return (
              <Card
                key={batch.batch_id}
                size="small"
                type={batch.batch_id === selectedBatchId ? 'inner' : undefined}
                onClick={() => onSelect(batch.batch_id)}
                style={{ cursor: 'pointer' }}
              >
                <Space direction="vertical" size={2} style={{ width: '100%' }}>
                  <Space wrap size={[6, 4]}>
                    <Text strong>{batch.batch_name}</Text>
                    <Tag color={jobMeta?.color ?? 'default'}>{jobMeta?.label ?? batch.job_status}</Tag>
                    <RuntimeFreshnessBadge freshness={batchFreshness(batch, serverTime)} />
                  </Space>
                  <Text type="secondary">
                    {batch.succeeded_stories}/{batch.total_stories} 个需求完成 · 运行中{' '}
                    {batch.running_stories} · 失败 {batch.failed_stories}
                  </Text>
                  <Text type="secondary">
                    运行时长 {formatElapsed(batch.job_started_at, now)} · 最后活动{' '}
                    {formatAge(batch.last_event_at, now)}
                  </Text>
                </Space>
              </Card>
            )
          })}
        </Space>
      </Card>
    )
  }

  const columns: ColumnsType<ActiveAnalysisBatch> = [
    {
      title: '批次',
      dataIndex: 'batch_name',
      render: (_, batch) => (
        <Space direction="vertical" size={0}>
          <Link to={`/batches/${batch.batch_id}/ai-result`}>{batch.batch_name}</Link>
          <Text type="secondary">{batch.week_code ?? '—'} · {batch.requested_branch}</Text>
        </Space>
      ),
    },
    {
      title: '分析任务状态',
      dataIndex: 'job_status',
      width: 140,
      render: (_, batch) => {
        const meta = analysisJobStatusMeta[batch.job_status]
        return <Tag color={meta?.color ?? 'default'}>{meta?.label ?? batch.job_status}</Tag>
      },
    },
    {
      title: '需求进度',
      width: 220,
      render: (_, batch) => (
        <Space direction="vertical" size={2} style={{ width: '100%' }}>
          <Progress
            percent={
              batch.total_stories === 0
                ? 0
                : Math.round((batch.succeeded_stories / batch.total_stories) * 100)
            }
            size="small"
            // 进度条只反映"已成功 / 总数"这个可验证的计数。
            format={() => `${String(batch.succeeded_stories)}/${String(batch.total_stories)}`}
            status={batch.failed_stories > 0 ? 'exception' : 'active'}
          />
          <Text type="secondary">
            运行中 {batch.running_stories} · 等待 {batch.pending_stories} · 失败{' '}
            {batch.failed_stories}
          </Text>
        </Space>
      ),
    },
    {
      title: '运行时长',
      width: 120,
      render: (_, batch) => <Text>{formatElapsed(batch.job_started_at, now)}</Text>,
    },
    {
      title: '最后活动',
      width: 150,
      render: (_, batch) => (
        <Space direction="vertical" size={0}>
          <Text>{formatAge(batch.last_event_at, now)}</Text>
          <Text type="secondary">事件 #{batch.last_event_id ?? '—'}</Text>
        </Space>
      ),
    },
    {
      title: '数据新鲜度',
      width: 150,
      render: (_, batch) => (
        <RuntimeFreshnessBadge
          freshness={batchFreshness(batch, serverTime)}
          detail={
            batch.watermark_lag_ms > 0
              ? `确认滞后 ${String(batch.watermark_lag_ms)} ms`
              : `最近事件 ${formatAge(batch.last_event_at, now)}`
          }
        />
      ),
    },
    {
      title: '',
      width: 90,
      render: (_, batch) => (
        <Button
          size="small"
          type={batch.batch_id === selectedBatchId ? 'primary' : 'default'}
          onClick={() => onSelect(batch.batch_id)}
        >
          查看
        </Button>
      ),
    },
  ]

  return (
    <Card title="运行批次">
      <Table<ActiveAnalysisBatch>
        rowKey="batch_id"
        size="small"
        pagination={false}
        dataSource={batches}
        columns={columns}
        onRow={(batch) => ({ onClick: () => onSelect(batch.batch_id) })}
        rowClassName={(batch) => (batch.batch_id === selectedBatchId ? 'ant-table-row-selected' : '')}
      />
    </Card>
  )
}
