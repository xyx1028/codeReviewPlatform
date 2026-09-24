/**
 * 需求勾选的范围约束（V1.20 修订）。
 *
 * 为什么需要它：导入单的口径是**单一项目组**（`request_linky_batch_import` 只接受一个
 * workspace，Worker 也只列这个组的需求）。而看板在没选项目组时是跨全部工作区汇总取数，
 * antd 表格的 `preserveSelectedRowKeys` 又会留住换筛选之前的勾选 —— 两者叠加的结果是
 * 可以带着别的项目组的编号提交。2026-09-24 实测：43 条里 8 条属于另外两个工作区，
 * 全部以 `LINKY_NOT_FOUND` 逐条失败。
 *
 * 规则就两条，都在这里判，组件只负责把结果交给外部：
 *   1. 切项目组时清空历史勾选（`shouldResetSelection`）；
 *   2. 任何一次勾选变化都只保留当前项目组里的编号（`pruneSelectionToScope`）。
 */

/** 只保留落在当前项目组范围内的编号，顺序按用户的勾选顺序。 */
export function pruneSelectionToScope(
  keys: readonly string[],
  scopedCodes: ReadonlySet<string>,
): string[] {
  const seen = new Set<string>()
  const kept: string[] = []
  for (const key of keys) {
    if (!scopedCodes.has(key) || seen.has(key)) continue
    seen.add(key)
    kept.push(key)
  }
  return kept
}

/**
 * 表头全选框的三态。
 *
 * 口径是**当前筛选结果的全部条目**，不是当前页：筛出 26 条却只能一页一页勾，真实用法里
 * 就是翻三次页点三次全选，还容易漏。所以 `checked` 表示"筛选结果已全部勾上"，
 * 部分勾上是 `indeterminate`。筛选结果为空时两者都为 false（框也会禁用）。
 */
export function selectAllState(input: {
  filteredCodes: readonly string[]
  selectedCodes: readonly string[]
}): { checked: boolean; indeterminate: boolean } {
  if (input.filteredCodes.length === 0) return { checked: false, indeterminate: false }
  const selected = new Set(input.selectedCodes)
  let hit = 0
  for (const code of input.filteredCodes) {
    if (selected.has(code)) hit += 1
  }
  return { checked: hit === input.filteredCodes.length, indeterminate: hit > 0 && hit < input.filteredCodes.length }
}

/**
 * 表头全选/取消全选后的勾选集合。
 *
 * 只动筛选结果里的编号：勾上是在已有勾选后面追加（`preserveSelectedRowKeys` 留下的、
 * 当前筛选之外的同组勾选不能被"全选"这个动作悄悄清掉），取消则只移除筛选结果里的那些。
 */
export function toggleSelectAllFiltered(input: {
  selectedCodes: readonly string[]
  filteredCodes: readonly string[]
  select: boolean
}): string[] {
  const filtered = new Set(input.filteredCodes)
  if (!input.select) return input.selectedCodes.filter((code) => !filtered.has(code))
  const kept = [...input.selectedCodes]
  const seen = new Set(kept)
  for (const code of input.filteredCodes) {
    if (seen.has(code)) continue
    seen.add(code)
    kept.push(code)
  }
  return kept
}

/**
 * 项目组变了且手上有历史勾选时才需要清空。
 *
 * 首次挂载（`previous === current`）与空勾选都不触发，避免无意义的状态回写和提示。
 */
export function shouldResetSelection(input: {
  previousWorkspaceName: string | null
  nextWorkspaceName: string | null
  selectedCount: number
}): boolean {
  if (input.previousWorkspaceName === input.nextWorkspaceName) return false
  return input.selectedCount > 0
}
