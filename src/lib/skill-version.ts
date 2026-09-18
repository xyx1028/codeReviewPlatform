/**
 * 数据库存储递增序号以保证对象路径和历史快照稳定；管理端将其展示为版本号。
 * 第 1 个版本为 1.0.0，之后每 10 次更新进一位：1.0.1 … 1.0.9 → 1.1.0。
 */
export function formatSkillVersion(version: number): string {
  const updateIndex = Math.max(0, Math.trunc(version) - 1)
  return `1.${Math.floor(updateIndex / 10)}.${updateIndex % 10}`
}
