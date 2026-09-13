import { Tag, Tooltip } from 'antd'
import type { RuntimeFreshness } from '../../types'
import { runtimeFreshnessMeta } from '../../lib/labels'

/**
 * 数据新鲜度徽标。
 *
 * 五档**分别**展示，不合并成一个「异常」：链路拥塞、长事务未提交和 Worker 掉线要
 * 采取的动作完全不同 —— 第一个看数据库负载，第二个等长事务结束，第三个查 Worker 进程。
 */
export function RuntimeFreshnessBadge({
  freshness,
  detail,
}: {
  freshness: RuntimeFreshness
  /** 附加的量化信息，例如「最近事件 8 秒前」。 */
  detail?: string | null
}) {
  const meta = runtimeFreshnessMeta[freshness]
  return (
    <Tooltip title={detail ? `${meta.hint} ${detail}` : meta.hint}>
      <Tag color={meta.color}>{meta.label}</Tag>
    </Tooltip>
  )
}
