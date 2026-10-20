/**
 * 密码恢复链接的落地识别。
 *
 * 为什么需要单独一个模块：implicit 流程下 GoTrue 把恢复凭据放在 URL 片段里
 * （`#access_token=...&type=recovery`），而 `detectSessionInUrl` 默认开启 —— 客户端
 * 初始化时会把它换成一个**正常会话**并把 hash 清掉。等页面渲染时再去读 `location.hash`
 * 已经什么都没有了，`App()` 只看到"有会话"，于是把人直接带进工作台，密码却还是旧的。
 *
 * 所以这里的 `captureRecoveryLanding()` 必须在 `createClient` 之前被调用一次，
 * 把事实先抄下来。解析逻辑做成纯函数，便于单测覆盖过期链接等分支。
 */

export interface RecoveryLanding {
  /** URL 里带着可用的恢复凭据（implicit 的 access_token 或 PKCE 的 code）。 */
  credential: boolean
  /** GoTrue 回传的失败原因（链接过期、已使用、被改写），已翻译成中文。 */
  error: string | null
}

const EMPTY_LANDING: RecoveryLanding = { credential: false, error: null }

/** GoTrue 恢复回调的错误码。未收录的错误码退回原始 description。 */
const recoveryErrorMessages: Record<string, string> = {
  otp_expired: '重置链接已过期或已被使用过，请重新发起找回密码。',
  access_denied: '重置链接无效，请重新发起找回密码。',
  invalid_request: '重置链接不完整，可能被邮件客户端改写，请重新发起找回密码。',
}

function pick(hash: URLSearchParams, query: URLSearchParams, key: string): string | null {
  return hash.get(key) ?? query.get(key)
}

/**
 * 解析一次恢复落地。
 *
 * @param hash   `location.hash`，带不带前导 `#` 都可以
 * @param search `location.search`，带不带前导 `?` 都可以
 */
export function parseRecoveryLanding(hash: string, search: string): RecoveryLanding {
  const hashParams = new URLSearchParams(hash.replace(/^#/, ''))
  const queryParams = new URLSearchParams(search.replace(/^\?/, ''))

  const errorCode = pick(hashParams, queryParams, 'error_code')
    ?? pick(hashParams, queryParams, 'error')
  if (errorCode) {
    const description = pick(hashParams, queryParams, 'error_description')
    return {
      credential: false,
      error: recoveryErrorMessages[errorCode]
        ?? (description ? description.replace(/\+/g, ' ') : recoveryErrorMessages.access_denied),
    }
  }

  // implicit 流程给 access_token + type=recovery；PKCE 流程只给 code（type 在邮件链接上）。
  const type = pick(hashParams, queryParams, 'type')
  const hasImplicitToken = hashParams.has('access_token') || queryParams.has('access_token')
  const hasPkceCode = queryParams.has('code') || hashParams.has('code')
  if (type === 'recovery' && (hasImplicitToken || hasPkceCode)) return { credential: true, error: null }
  // 一些邮件客户端会丢掉 type；只要落在重置页且带着凭据，就按恢复处理。
  if (hasPkceCode && !type) return { credential: true, error: null }

  return EMPTY_LANDING
}

export const RESET_PASSWORD_PATH = '/reset-password'

let landing: RecoveryLanding = EMPTY_LANDING
let recoveryEventSeen = false

/**
 * 抄下当前 URL 里的恢复落地信息。必须在创建 Supabase 客户端之前调用。
 *
 * 只认 `/reset-password` 这一个落地路径：别的页面上出现的 `code`/`error` 参数属于微信回调
 * 等既有链路，不能被当成密码恢复。
 */
export function captureRecoveryLanding(): RecoveryLanding {
  if (typeof window === 'undefined') return EMPTY_LANDING
  if (window.location.pathname !== RESET_PASSWORD_PATH) return EMPTY_LANDING
  landing = parseRecoveryLanding(window.location.hash, window.location.search)
  return landing
}

export function getRecoveryLanding(): RecoveryLanding {
  return landing
}

/** `onAuthStateChange` 收到 `PASSWORD_RECOVERY` 时调用，作为落地识别的第二个来源。 */
export function markRecoverySession(): void {
  recoveryEventSeen = true
}

/**
 * 当前是否处于密码恢复流。
 *
 * 为真时界面只允许停在重置页：带着一封邮件换来的会话直接进工作台，等于把邮箱当成了密码。
 */
export function isRecoveryFlow(): boolean {
  return landing.credential || recoveryEventSeen
}

/** 重置完成或用户主动放弃后清掉标记，避免界面被一直钉在重置页。 */
export function clearRecoveryFlow(): void {
  landing = EMPTY_LANDING
  recoveryEventSeen = false
}
