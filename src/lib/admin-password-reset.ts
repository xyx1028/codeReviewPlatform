/**
 * 管理员代重置密码（V1.65）的前端纯逻辑。
 *
 * 临时密码在浏览器里生成：它只需要被管理员看一眼、转交给本人，平台不保存明文，
 * 所以没有理由让它经过服务端。生成与校验规则放在这里，便于单测，也避免散落在弹窗代码里。
 */

/** 数据库侧的下限（`admin_reset_user_password` 会再校验一次，这里只是提前拦住明显不合规的输入）。 */
export const TEMP_PASSWORD_MIN_LENGTH = 8

/** bcrypt 只取前 72 字节，超出部分被静默丢弃，所以这是硬上限而不是建议值。 */
export const TEMP_PASSWORD_MAX_BYTES = 72

/** 自动生成的长度：够强，又还能让人准确地念给同事听。 */
export const TEMP_PASSWORD_GENERATED_LENGTH = 14

// 剔除 0/O/o、1/l/I、2/Z、5/S、8/B 这类口头转述和手抄时最容易弄错的字符。
const LOWER = 'abcdefghjkmnpqrtuvwxy'
const UPPER = 'ACDEFGHJKLMNPQRTUVWXY'
const DIGIT = '34679'
// 只用在终端、Excel、聊天工具里都不会被转义或吃掉的符号。
const SYMBOL = '!@#%*-_=+'
const ALL = `${LOWER}${UPPER}${DIGIT}${SYMBOL}`

function randomIndexes(count: number): number[] {
  const bytes = new Uint32Array(count)
  crypto.getRandomValues(bytes)
  return Array.from(bytes)
}

function pick(charset: string, raw: number): string {
  return charset[raw % charset.length]
}

/**
 * 生成一个临时密码。
 *
 * 四类字符各保证至少一个（不少于一个符号是为了满足"看起来就该改掉"的直觉，
 * 以及某些邮箱/IT 规范对初始密码的要求），再用随机序打散，避免固定出现"小写开头"这种模式。
 */
export function generateTemporaryPassword(length: number = TEMP_PASSWORD_GENERATED_LENGTH): string {
  const size = Math.max(TEMP_PASSWORD_MIN_LENGTH, Math.min(length, TEMP_PASSWORD_MAX_BYTES))
  const required = [LOWER, UPPER, DIGIT, SYMBOL]
  const raw = randomIndexes(size + size)
  const chars = required.map((charset, index) => pick(charset, raw[index]))
  for (let index = required.length; index < size; index += 1) {
    chars.push(pick(ALL, raw[index]))
  }
  // Fisher–Yates，随机源取自同一批 getRandomValues 的后半段。
  for (let index = chars.length - 1; index > 0; index -= 1) {
    const swap = raw[size + index] % (index + 1)
    const current = chars[index]
    chars[index] = chars[swap]
    chars[swap] = current
  }
  return chars.join('')
}

/** 前端预检。真正的判定在数据库，这里只是为了不让一次必然失败的请求跑一趟。 */
export function validateTemporaryPassword(value: string): string | null {
  if (!value) return '请输入或生成临时密码'
  if (value !== value.trim()) return '密码两端不能有空格，转交时几乎一定会丢'
  if (value.length < TEMP_PASSWORD_MIN_LENGTH) return `密码至少需要 ${TEMP_PASSWORD_MIN_LENGTH} 个字符`
  if (new TextEncoder().encode(value).length > TEMP_PASSWORD_MAX_BYTES) {
    return `密码不能超过 ${TEMP_PASSWORD_MAX_BYTES} 字节（bcrypt 会把多出来的部分静默丢掉）`
  }
  return null
}

/** 数据库抛的稳定错误码 → 可行动的中文。未收录的原样返回，不把真实原因吞掉。 */
export function describeAdminPasswordResetError(message: string): string {
  if (message.includes('PASSWORD_REQUIRED')) return '临时密码不能为空。'
  if (message.includes('PASSWORD_TOO_SHORT')) return `临时密码至少需要 ${TEMP_PASSWORD_MIN_LENGTH} 个字符。`
  if (message.includes('PASSWORD_TOO_LONG')) return `临时密码不能超过 ${TEMP_PASSWORD_MAX_BYTES} 字节。`
  if (message.includes('PASSWORD_HAS_EDGE_SPACE')) return '临时密码两端不能有空格。'
  if (message.includes('USER_NOT_FOUND')) return '账号不存在或已被删除。'
  if (message.includes('WECHAT_ONLY_ACCOUNT')) return '这是微信注册的账号，没有邮箱密码登录通道，直接让本人用微信扫码登录即可。'
  if (message.includes('ADMIN role required')) return '只有管理员可以重置他人密码。'
  return message
}
