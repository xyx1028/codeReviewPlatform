import { LINKY_WORKSPACE_PRESETS } from './workspace-presets'

/** 候选列表未返回时，仍允许按完整名称查询；不把输入解释为接口地址。 */
export function workspaceOptions(names: readonly string[], search: string, selected?: string | null) {
  const known = [...new Set([...LINKY_WORKSPACE_PRESETS, ...names, selected ?? ''].map((name) => name.trim()).filter(Boolean))]
  const options = known.map((name) => ({ value: name, label: name }))
  const typed = search.trim()
  if (typed && !known.includes(typed)) {
    options.push({ value: typed, label: `${typed}（按完整名称查询）` })
  }
  return options
}
