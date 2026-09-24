/**
 * 导入失败条目的聚合（只服务展示）。
 *
 * 为什么需要它：Worker 是逐条提交的，失败原因高度重复 —— 实测一次 5 条失败全是同一个
 * `LINKY_IMPORT_STORY_NO_REQUIREMENT_SOURCE`，页面却按条铺了 5 行同样长的错误码，
 * 把真正要操作的列表推到屏幕外。按错误码聚合后，快照条上一个「N 条未导入」的小标记就说完了，
 * 逐条编号留给抽屉。
 */
export interface LinkyImportFailure {
  story_code: string
  code: string
  message: string
}

export interface LinkyImportFailureGroup {
  code: string
  message: string
  storyCodes: string[]
}

/** 按错误码聚合，组内保留原顺序，组间按条数倒序（同条数按首次出现顺序）。 */
export function groupImportFailures(
  failures: readonly LinkyImportFailure[],
): LinkyImportFailureGroup[] {
  const groups = new Map<string, LinkyImportFailureGroup>()
  const order: string[] = []
  for (const failure of failures) {
    const existing = groups.get(failure.code)
    if (existing === undefined) {
      groups.set(failure.code, {
        code: failure.code,
        message: failure.message,
        storyCodes: [failure.story_code],
      })
      order.push(failure.code)
      continue
    }
    existing.storyCodes.push(failure.story_code)
  }
  return order
    .map((code, index) => ({ group: groups.get(code)!, index }))
    .sort((a, b) => b.group.storyCodes.length - a.group.storyCodes.length || a.index - b.index)
    .map((entry) => entry.group)
}
