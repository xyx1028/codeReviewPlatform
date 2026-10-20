/**
 * 评审列表「项目组」列的纯逻辑（V1.62）。
 *
 * 单独成文件是为了能单测：这一列有三件容易写错的事 ——
 *
 *   1. **一个批次可以有多个项目组**（同一批次可以发起多次导入），所以筛选不能用
 *      "相等"，必须是"包含"。写成相等的话，跨组批次在任何单组筛选下都会消失。
 *   2. **历史批次没有项目组**（Excel 时代导入的需求 `linky_workspace_name` 为 null，
 *      实测本地库里那个 26 条需求的批次就是这样）。这种批次必须能被看见，也要能被筛出来，
 *      所以筛选项里要有一个显式的"未关联"，而不是让它们在筛选时静默消失。
 *   3. 筛选项要按中文排序，否则下拉里的顺序每次取数都可能不一样。
 */

/** 「未关联项目组」的筛选值。用一个不可能与真实项目组名相撞的标记。 */
export const NO_WORKSPACE_FILTER = '__none__'

export const NO_WORKSPACE_LABEL = '未关联项目组'

export interface BatchWorkspaceRow {
  workspace_names?: string[] | null
}

/** 规范化：去空白、去空值、去重，并按中文排序。 */
export function normalizeWorkspaceNames(input: string[] | null | undefined): string[] {
  if (!Array.isArray(input)) return []
  const cleaned = input
    .map((name) => (typeof name === 'string' ? name.trim() : ''))
    .filter((name) => name !== '')
  return [...new Set(cleaned)].sort((a, b) => a.localeCompare(b, 'zh-CN'))
}

/**
 * 构造筛选项。
 *
 * 只有在**确实存在**没有项目组的批次时才加「未关联项目组」—— 否则下拉里会多一个
 * 永远筛不出任何东西的选项。
 */
export function buildWorkspaceFilters(
  rows: readonly BatchWorkspaceRow[],
): Array<{ text: string; value: string }> {
  const names = new Set<string>()
  let hasEmpty = false
  for (const row of rows) {
    const normalized = normalizeWorkspaceNames(row.workspace_names)
    if (normalized.length === 0) {
      hasEmpty = true
      continue
    }
    for (const name of normalized) names.add(name)
  }
  const filters = [...names]
    .sort((a, b) => a.localeCompare(b, 'zh-CN'))
    .map((name) => ({ text: name, value: name }))
  if (hasEmpty) filters.push({ text: NO_WORKSPACE_LABEL, value: NO_WORKSPACE_FILTER })
  return filters
}

/** 单个筛选值是否命中某一行。多项目组按"包含"判定，不是相等。 */
export function matchesWorkspaceFilter(row: BatchWorkspaceRow, value: string): boolean {
  const normalized = normalizeWorkspaceNames(row.workspace_names)
  if (value === NO_WORKSPACE_FILTER) return normalized.length === 0
  return normalized.includes(value)
}
