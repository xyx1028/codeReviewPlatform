/**
 * 确认令牌（V1.56）。
 *
 * 为什么不靠"在工具描述里要求模型先查再提交"：工具描述约束不了模型的实际行为。而这个
 * 工具的每一次误提交都是一个真实批次加一份模型额度 —— 代价不对称，所以"必须先核对、
 * 必须让使用者看过"要做成**服务端可验证的硬门禁**，模型绕不过去。
 *
 * 令牌把四个关键参数（需求编号 / 项目组 / 分支 / 提交窗口）连同校验结论一起签进去：
 *
 *   · 参数被改动 → 签名对不上 → 必须重新确认。否则模型可以拿着"US-A 的确认"去提交 US-B。
 *   · 过期 → 拒收。使用者看过的那份数据可能已经变了，十分钟前的确认不代表现在的事实。
 *   · 校验结论一起签 → 回执能如实说"这次是核对过的"还是"没核对成"，而不是事后编。
 *
 * 密钥默认进程启动时随机生成：重启后旧令牌失效，这正是想要的（重启意味着无人确认过）。
 * 多实例部署必须显式配 `CRP_CONFIRM_SECRET`，否则 A 实例签的令牌到 B 实例会被拒。
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

export const DEFAULT_CONFIRM_TTL_MS = 15 * 60_000

export class ConfirmationError extends Error {
  constructor(message, { code } = {}) {
    super(message)
    this.name = 'ConfirmationError'
    this.code = code
  }
}

/**
 * 待签名的规范串。
 *
 * 固定字段顺序、固定分隔符：如果用 `JSON.stringify` 签，键顺序一变签名就全不认，
 * 而键顺序不是我们能控制的东西。
 */
export function canonicalPayload(claim) {
  return [
    `story=${claim.story_code ?? ''}`,
    `workspace=${claim.workspace_name ?? ''}`,
    `given=${claim.given_workspace ?? ''}`,
    `branch=${claim.branch ?? ''}`,
    `window=${claim.commit_window_days ?? ''}`,
    `verification=${claim.verification ?? ''}`,
    `exp=${claim.expires_at ?? ''}`,
  ].join('&')
}

export class ConfirmationSigner {
  #secret
  #ttlMs
  #now

  constructor({ secret = null, ttlMs = DEFAULT_CONFIRM_TTL_MS, now = () => Date.now() } = {}) {
    this.#secret =
      secret === null || String(secret).trim() === ''
        ? randomBytes(32).toString('hex')
        : String(secret)
    this.#ttlMs = ttlMs
    this.#now = now
  }

  get ttlMs() {
    return this.#ttlMs
  }

  /**
   * 签一张确认令牌。
   *
   * `workspace_name` 是**纠正后**的值（提交时真正用的那个），`given_workspace` 是调用方
   * 最初说的那个。两个都签进去的原因很具体：第二次调用时，客户端通常会把第一次的入参
   * 原样回传 —— 也就是那个写错的名字。只绑定纠正值的话，这次提交会因为"参数和确认过的
   * 不一致"被自己拒掉，而使用者刚刚才确认过。
   */
  issue({ story_code, workspace_name, given_workspace, branch, commit_window_days, verification }) {
    const claim = {
      story_code,
      workspace_name: workspace_name ?? '',
      given_workspace: given_workspace ?? '',
      branch,
      commit_window_days,
      verification,
      expires_at: this.#now() + this.#ttlMs,
    }
    const signature = createHmac('sha256', this.#secret)
      .update(canonicalPayload(claim))
      .digest('base64url')
    const body = Buffer.from(JSON.stringify(claim), 'utf8').toString('base64url')
    return `v1.${body}.${signature}`
  }

  /**
   * 校验令牌，并确认它签的就是这次要提交的参数。
   *
   * 失败一律抛 `ConfirmationError`，由上层翻译成"请重新确认"。绝不"签名不对但参数看着
   * 没问题就放过" —— 那等于没有门禁。
   */
  verify(token, expected) {
    const raw = String(token ?? '').trim()
    if (raw === '') {
      throw new ConfirmationError('缺少确认令牌。', { code: 'CONFIRMATION_REQUIRED' })
    }
    const parts = raw.split('.')
    if (parts.length !== 3 || parts[0] !== 'v1') {
      throw new ConfirmationError('确认令牌格式不对。', { code: 'CONFIRMATION_MALFORMED' })
    }

    let claim
    try {
      claim = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    } catch {
      throw new ConfirmationError('确认令牌无法解析。', { code: 'CONFIRMATION_MALFORMED' })
    }

    const expectedSignature = createHmac('sha256', this.#secret)
      .update(canonicalPayload(claim))
      .digest('base64url')
    const left = Buffer.from(parts[2], 'utf8')
    const right = Buffer.from(expectedSignature, 'utf8')
    if (left.length !== right.length || !timingSafeEqual(left, right)) {
      throw new ConfirmationError(
        '确认令牌签名不对（可能来自另一台 MCP 实例，或服务已重启）。',
        { code: 'CONFIRMATION_INVALID' },
      )
    }

    if (typeof claim.expires_at !== 'number' || claim.expires_at <= this.#now()) {
      throw new ConfirmationError('确认令牌已过期，请重新核对一次需求再提交。', {
        code: 'CONFIRMATION_EXPIRED',
      })
    }

    // 参数绑定：令牌只对它签过的那一组参数有效。
    const mismatched = []
    if (claim.story_code !== expected.story_code) mismatched.push('需求编号')
    if (claim.branch !== expected.branch) mismatched.push('目标分支')
    if (Number(claim.commit_window_days) !== Number(expected.commit_window_days)) {
      mismatched.push('提交时间窗口')
    }
    /**
     * 项目组允许两种写法通过：纠正后的值，或调用方第一次给的那个原始值。
     *
     * 后者不是放水 —— 提交时真正使用的永远是 `claim.workspace_name`（纠正后的那个），
     * 调用方这次传什么都不会改变落库的值。接受原始值只是为了不把"客户端把第一次的入参
     * 原样回传"这个最常见的行为判成参数不一致。给第三个值仍然要重新确认：那意味着
     * 使用者改了主意，而他改的那个版本没人确认过。
     */
    const givenWorkspace = expected.workspace_name ?? ''
    const acceptable = new Set([claim.workspace_name ?? '', claim.given_workspace ?? '', ''])
    if (!acceptable.has(givenWorkspace)) mismatched.push('项目组')

    if (mismatched.length > 0) {
      throw new ConfirmationError(
        `确认过的参数和这次提交的不一致（${mismatched.join('、')}）。请重新核对后再提交。`,
        { code: 'CONFIRMATION_PARAM_MISMATCH' },
      )
    }

    return claim
  }
}
