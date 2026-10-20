/**
 * 确认令牌（V1.56）。
 *
 * 为什么不靠"在工具描述里要求模型先查再提交"：工具描述约束不了模型的实际行为。而这个
 * 工具的每一次误提交都是一个真实批次加一份模型额度 —— 代价不对称，所以"必须先核对、
 * 必须让使用者看过"要做成**服务端可验证的硬门禁**，模型绕不过去。
 *
 * 服务端保存关键参数（需求编号集合 / 项目组 / 分支 / 提交窗口）及校验结论：
 *
 *   · 参数被改动 → 与确认记录不符 → 必须重新确认。否则模型可以拿着"US-A 的确认"去提交 US-B，
 *     或者拿着"这 2 条的确认"去提交 3 条。
 *   · 过期 → 拒收。使用者看过的那份数据可能已经变了，十分钟前的确认不代表现在的事实。
 *   · 校验结论一起保存 → 回执能如实说"这次是核对过的"还是"没核对成"，而不是事后编。
 *
 * V1.70：确认内容保存在进程内，客户端只回传 35 字符的随机引用，避免模型复制长正文时遗漏。
 * 重启后需重新核对；多实例需固定到签发引用的实例，共享签名密钥无法共享进程内记录。
 */

import { randomBytes } from 'node:crypto'

export const DEFAULT_CONFIRM_TTL_MS = 15 * 60_000

export class ConfirmationError extends Error {
  constructor(message, { code } = {}) {
    super(message)
    this.name = 'ConfirmationError'
    this.code = code
  }
}

/**
 * 编号集合规范化（排序去重）。模型第二次
 * 调用时很可能把编号顺序打乱，而"顺序"在这里没有任何语义 —— 导入单自己也会
 * `distinct … order by code`。但集合本身必须绑死：少一条、多一条都得重新确认。
 */
export function canonicalStoryCodes(codes) {
  const list = Array.isArray(codes) ? codes : [codes]
  return [...new Set(list.map((code) => String(code ?? '').trim()).filter((code) => code !== ''))]
    .sort()
    .join(',')
}

export class ConfirmationSigner {
  #pending = new Map()
  #maxPending
  #ttlMs
  #now

  constructor({ ttlMs = DEFAULT_CONFIRM_TTL_MS, now = () => Date.now(), maxPending = 10_000 } = {}) {
    if (!Number.isSafeInteger(maxPending) || maxPending < 1) {
      throw new TypeError('maxPending 必须是正整数')
    }
    this.#maxPending = maxPending
    this.#ttlMs = ttlMs
    this.#now = now
  }

  get ttlMs() {
    return this.#ttlMs
  }

  /**
   * 保存确认快照并生成短引用。保留类名以兼容工具层的既有调用。
   *
   * `story_codes` 是这次要评审的全部编号（单条时给 `story_code` 也行）。
   *
   * `workspace_name` 是**纠正后**的值（提交时真正用的那个），`given_workspace` 是调用方
   * 最初说的那个。两个都保存的原因很具体：第二次调用时，客户端通常会把第一次的入参
   * 原样回传 —— 也就是那个写错的名字。只绑定纠正值的话，这次提交会因为"参数和确认过的
   * 不一致"被自己拒掉，而使用者刚刚才确认过。
   */
  issue({
    story_code,
    story_codes,
    workspace_name,
    given_workspace,
    release_window,
    branch,
    commit_window_days,
    verification,
    caller = null,
  }) {
    const now = this.#now()
    for (const [key, entry] of this.#pending) {
      if (entry.claim.expires_at <= now) this.#pending.delete(key)
    }
    if (this.#pending.size >= this.#maxPending) {
      throw new ConfirmationError('待确认记录已满，请稍后重新核对。', {
        code: 'CONFIRMATION_CAPACITY',
      })
    }
    const codes = Array.isArray(story_codes)
      ? story_codes.map((code) => String(code ?? '').trim()).filter((code) => code !== '')
      : [String(story_code ?? '').trim()].filter((code) => code !== '')
    const claim = {
      story_codes: codes,
      workspace_name: workspace_name ?? '',
      given_workspace: given_workspace ?? '',
      /** 按发布窗口提交时冻结窗口名称，回执读取这份快照。 */
      release_window: release_window ?? '',
      branch,
      commit_window_days,
      verification,
      expires_at: now + this.#ttlMs,
    }
    let token
    do {
      token = `v2.${randomBytes(24).toString('base64url')}`
    } while (this.#pending.has(token))
    this.#pending.set(token, { claim: structuredClone(claim), caller })
    return token
  }

  /**
   * 读取确认快照，并校验这次要提交的参数。
   *
   * 失败一律抛 `ConfirmationError`，由上层翻译成"请重新确认"。绝不"编号不对但参数看着
   * 没问题就放过" —— 那等于没有门禁。
   */
  verify(token, expected) {
    const raw = String(token ?? '').trim()
    if (raw === '') {
      throw new ConfirmationError('缺少确认令牌。', { code: 'CONFIRMATION_REQUIRED' })
    }
    if (!/^v2\.[A-Za-z0-9_-]{32}$/.test(raw)) {
      throw new ConfirmationError('确认编号格式不对或是旧版令牌，请重新核对。', {
        code: 'CONFIRMATION_MALFORMED',
      })
    }
    const entry = this.#pending.get(raw)
    if (entry === undefined || entry.caller !== (expected.caller ?? null)) {
      throw new ConfirmationError(
        '确认编号不存在或不属于当前调用身份（可能服务已重启或请求到了其他实例），请重新核对。',
        { code: 'CONFIRMATION_INVALID' },
      )
    }
    const claim = entry.claim

    if (typeof claim.expires_at !== 'number' || claim.expires_at <= this.#now()) {
      this.#pending.delete(raw)
      throw new ConfirmationError('确认令牌已过期，请重新核对一次需求再提交。', {
        code: 'CONFIRMATION_EXPIRED',
      })
    }

    // 参数绑定：引用只对原来确认的那一组参数有效。
    const mismatched = []
    /*
     * 调用方这次可以**不回传编号**（V1.68）。
     *
     * 按发布窗口提交时，第一步枚举出来的可能是 34 个编号，要求客户端原样回传它们只是
     * 给模型增加一次抄错的机会 —— 而提交用的本来就是 `claim.story_codes`，调用方传什么
     * 都不会改变落库的值。快照在服务端保存，客户端不能修改，所以"没给"就不比。
     * 给了就必须一致：那是使用者改了主意，而他改的那个版本没人确认过。
     */
    const givenCodes = expected.story_codes ?? expected.story_code
    if (givenCodes !== undefined && givenCodes !== null) {
      const claimCodes = canonicalStoryCodes(claim.story_codes)
      const expectedCodes = canonicalStoryCodes(givenCodes)
      if (claimCodes !== expectedCodes) {
        // 多一条和少一条都要重新确认：使用者确认的是"这几条"，不是"这些里的任意子集"。
        mismatched.push(
          claimCodes.split(',').length === expectedCodes.split(',').length ? '需求编号' : '需求条数',
        )
      }
    }
    /** 发布窗口同理：没回传就不比，回传了必须和确认过的那个一致。 */
    const givenWindow = expected.release_window
    if (
      givenWindow !== undefined &&
      givenWindow !== null &&
      String(givenWindow).trim() !== '' &&
      String(givenWindow).trim() !== String(claim.release_window ?? '')
    ) {
      mismatched.push('发布窗口')
    }
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

    return structuredClone(claim)
  }
}
