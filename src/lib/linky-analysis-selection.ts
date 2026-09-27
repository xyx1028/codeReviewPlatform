export interface PendingLinkyAnalysisSelection {
  workspaceName: string
  releaseWindow: string | null
  storyCodes: string[]
}

const STORAGE_PREFIX = 'codereviewplatform:pending-linky-analysis:'

function storageKey(batchId: string) {
  return `${STORAGE_PREFIX}${batchId}`
}

function canUseSessionStorage() {
  return typeof window !== 'undefined' && typeof window.sessionStorage !== 'undefined'
}

function normalize(input: Partial<PendingLinkyAnalysisSelection> | null): PendingLinkyAnalysisSelection | null {
  const workspaceName = typeof input?.workspaceName === 'string' ? input.workspaceName.trim() : ''
  const releaseWindow = typeof input?.releaseWindow === 'string' ? input.releaseWindow.trim() || null : null
  const storyCodes = Array.isArray(input?.storyCodes)
    ? [...new Set(input.storyCodes.filter((code): code is string => typeof code === 'string' && code.trim() !== '').map((code) => code.trim()))]
    : []
  if (workspaceName === '' || storyCodes.length === 0) return null
  return { workspaceName, releaseWindow, storyCodes }
}

/**
 * 尚未提交给服务端的选择只属于当前浏览器页签：它让用户在“原始需求导入”和
 * “AI 结果管理”间切换时不丢选择，但不会被误当作已冻结的业务事实。
 */
export function getPendingLinkyAnalysisSelection(batchId: string): PendingLinkyAnalysisSelection | null {
  if (!canUseSessionStorage()) return null
  try {
    const raw = window.sessionStorage.getItem(storageKey(batchId))
    if (!raw) return null
    const parsed = normalize(JSON.parse(raw) as Partial<PendingLinkyAnalysisSelection>)
    if (!parsed) window.sessionStorage.removeItem(storageKey(batchId))
    return parsed
  } catch {
    window.sessionStorage.removeItem(storageKey(batchId))
    return null
  }
}

export function setPendingLinkyAnalysisSelection(
  batchId: string,
  input: PendingLinkyAnalysisSelection | null,
) {
  if (!canUseSessionStorage()) return
  const value = normalize(input)
  if (!value) {
    window.sessionStorage.removeItem(storageKey(batchId))
    return
  }
  window.sessionStorage.setItem(storageKey(batchId), JSON.stringify(value))
}

export function clearPendingLinkyAnalysisSelection(batchId: string) {
  if (canUseSessionStorage()) window.sessionStorage.removeItem(storageKey(batchId))
}
