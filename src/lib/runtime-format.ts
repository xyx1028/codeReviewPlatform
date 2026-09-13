/**
 * 运行监控台的时间格式化。
 *
 * 单独放在 lib 里而不是和组件同文件：混在一起会破坏 Fast Refresh，而这几个函数
 * 在四个组件里都要用。
 */

/** 相对时间。用来回答「当前活动从何时开始」「最近一次事实事件何时到达」。 */
export function formatAge(from: string | null | undefined, now: number): string {
  if (from === null || from === undefined) return '—'
  const ageMs = now - Date.parse(from)
  if (Number.isNaN(ageMs)) return '—'
  if (ageMs < 1000) return '刚刚'
  if (ageMs < 60_000) return `${String(Math.floor(ageMs / 1000))} 秒前`
  if (ageMs < 3_600_000) return `${String(Math.floor(ageMs / 60_000))} 分钟前`
  return `${String(Math.floor(ageMs / 3_600_000))} 小时前`
}

/** 持续时长。 */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—'
  if (ms < 1000) return `${String(Math.round(ms))} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return `${String(minutes)} 分 ${String(seconds)} 秒`
}

/** 已运行多久（从某个开始时间到 now）。 */
export function formatElapsed(from: string | null | undefined, now: number): string {
  if (from === null || from === undefined) return '—'
  const started = Date.parse(from)
  if (Number.isNaN(started)) return '—'
  return formatDuration(Math.max(0, now - started))
}

/** Token 未上报与 0 是两件不同的事：provider 没报量时数据库保持 null。 */
export function formatTokens(value: number | null | undefined): string {
  return value === null || value === undefined ? '未上报' : value.toLocaleString()
}
