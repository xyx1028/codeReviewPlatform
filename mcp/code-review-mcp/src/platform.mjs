/**
 * 平台取数通道：Supabase Auth + PostgREST。
 *
 * 为什么不用 @supabase/supabase-js：这个包要能独立分发给别人跑，依赖越少越好。
 * 这里需要的只有"登录拿 JWT + 调 RPC + 读几张表"，裸 fetch 就够，也不会跟主仓库的
 * supabase-js 版本互相牵制。
 *
 * 安全边界：**只用 anon key + 用户 JWT**，不碰 service-role。因此 RLS 与各 RPC 自身的
 * 门禁继续生效 —— MCP 不是绕过权限的后门，它只是以某个平台账号的身份调用既有接口。
 */

/** 默认单次请求超时。没有超时的话，一次挂住的连接会让工具调用永远不返回。 */
const DEFAULT_TIMEOUT_MS = 30_000

export class PlatformError extends Error {
  /**
   * @param {object} options
   * @param {boolean} [options.indeterminate]
   *   true 表示**不知道服务端到底做了没有**（网络中断、超时、5xx、响应不是结构化错误）。
   *   这个区分不是为了日志好看：写操作失败时，"服务端明确拒绝"可以安全回滚，
   *   "不知道"绝不能 —— 回滚会把一个可能已经受理的任务删掉。
   */
  constructor(message, { code = null, status = null, hint = null, indeterminate = false } = {}) {
    super(message)
    this.name = 'PlatformError'
    this.code = code
    this.status = status
    this.hint = hint
    this.indeterminate = indeterminate
  }
}

/**
 * 从数据库报错里取稳定错误码。
 *
 * 平台的 RPC 一律 `raise exception 'SOME_CODE'`，PostgREST 把它放进 message。
 * 前端靠这些码决定提示文案，这里同样需要原始码：翻译成人话是 format 层的事，
 * 丢掉码就没法区分"模型停用"和"没连内网"。
 */
export function extractErrorCode(message) {
  const match = /\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b/.exec(String(message ?? ''))
  return match ? match[1] : null
}

/**
 * HTTP 状态码是否属于"结果不明"。
 *
 * 5xx / 408 / 425 / 429 都可能发生在**事务已经提交之后**（网关超时、连接被掐、重启），
 * 所以不能当成"服务端拒绝了"。4xx 业务错误是 PostgREST 在事务回滚后给出的，可以当拒绝。
 */
export function isIndeterminateStatus(status) {
  return status === 408 || status === 425 || status === 429 || status >= 500
}

export class PlatformClient {
  #config
  #fetch
  #session = null
  #signInPromise = null

  constructor(config, { fetchImpl = fetch, now = () => Date.now() } = {}) {
    this.#config = config
    this.#fetch = fetchImpl
    this.now = now
  }

  get email() {
    return this.#config.email
  }

  /** 已登录用户的 id；未登录时为 null。 */
  get userId() {
    return this.#session?.userId ?? null
  }

  get #timeoutMs() {
    return this.#config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  #signal() {
    // AbortSignal.timeout 从 Node 17.3 起可用；超时表现为 fetch reject，归入"结果不明"。
    return typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(this.#timeoutMs) : undefined
  }

  async #authRequest(grant, body) {
    let response
    try {
      response = await this.#fetch(`${this.#config.url}/auth/v1/token?grant_type=${grant}`, {
        method: 'POST',
        headers: {
          apikey: this.#config.anonKey,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(body),
        signal: this.#signal(),
      })
    } catch (error) {
      throw new PlatformError(`连不上平台登录接口：${String(error?.message ?? error)}`, {
        code: 'PLATFORM_UNREACHABLE',
        indeterminate: true,
      })
    }
    const text = await response.text()
    let payload = null
    try {
      payload = text === '' ? null : JSON.parse(text)
    } catch {
      throw new PlatformError(`登录接口返回的不是合法 JSON（HTTP ${response.status}）`, {
        status: response.status,
        indeterminate: true,
      })
    }
    if (!response.ok) {
      const detail = payload?.error_description ?? payload?.msg ?? payload?.message ?? text
      throw new PlatformError(`平台账号登录失败：${detail}`, {
        status: response.status,
        code: 'PLATFORM_SIGN_IN_FAILED',
        indeterminate: isIndeterminateStatus(response.status),
      })
    }
    if (typeof payload?.access_token !== 'string') {
      throw new PlatformError('登录响应里没有 access_token', { code: 'PLATFORM_SIGN_IN_FAILED' })
    }
    return {
      accessToken: payload.access_token,
      refreshToken: typeof payload.refresh_token === 'string' ? payload.refresh_token : null,
      // expires_in 是秒。提前 60 秒续期，避免卡在边界上。
      expiresAt: this.now() + Math.max((payload.expires_in ?? 3600) - 60, 30) * 1000,
      userId: payload?.user?.id ?? null,
    }
  }

  /** 懒登录 + 并发去重：同时来的多个工具调用只触发一次登录。 */
  async #ensureSession() {
    if (this.#session && this.#session.expiresAt > this.now()) return this.#session
    if (this.#signInPromise) return this.#signInPromise

    const refreshToken = this.#session?.refreshToken ?? null
    this.#signInPromise = (async () => {
      if (refreshToken) {
        try {
          this.#session = await this.#authRequest('refresh_token', { refresh_token: refreshToken })
          return this.#session
        } catch {
          // 刷新失败就老老实实重新登录，不要把"会话过期"伪装成"账号不可用"。
        }
      }
      this.#session = await this.#authRequest('password', {
        email: this.#config.email,
        password: this.#config.password,
      })
      return this.#session
    })().finally(() => {
      this.#signInPromise = null
    })

    return this.#signInPromise
  }

  async #request(path, init, { retryOn401 = true } = {}) {
    const session = await this.#ensureSession()
    let response
    try {
      response = await this.#fetch(`${this.#config.url}${path}`, {
        ...init,
        signal: this.#signal(),
        headers: {
          apikey: this.#config.anonKey,
          Authorization: `Bearer ${session.accessToken}`,
          Accept: 'application/json',
          ...(init.headers ?? {}),
        },
      })
    } catch (error) {
      // 网络层失败（连不上、超时、连接被掐）。读请求重试安全，写请求必须由上层决定，
      // 所以这里只如实标记"结果不明"，不自作主张重试。
      throw new PlatformError(`连不上平台接口：${String(error?.message ?? error)}`, {
        code: 'PLATFORM_UNREACHABLE',
        indeterminate: true,
      })
    }

    if (response.status === 401 && retryOn401) {
      this.#session = null
      return this.#request(path, init, { retryOn401: false })
    }

    const text = await response.text()
    let payload = null
    let parseFailed = false
    if (text !== '') {
      try {
        payload = JSON.parse(text)
      } catch {
        parseFailed = true
      }
    }

    if (!response.ok) {
      const structured = !parseFailed && payload !== null && typeof payload === 'object'
      const message = structured
        ? (payload.message ?? payload.error ?? `HTTP ${response.status}`)
        : `HTTP ${response.status}${text === '' ? '' : `：${text.slice(0, 200)}`}`
      throw new PlatformError(message, {
        status: response.status,
        code: extractErrorCode(message) ?? (structured ? (payload.code ?? null) : null),
        hint: structured ? (payload.hint ?? null) : null,
        // 非结构化响应（网关 HTML、空体）说明请求可能没走到数据库，也可能走到了。
        indeterminate: isIndeterminateStatus(response.status) || !structured,
      })
    }

    if (parseFailed) {
      throw new PlatformError(`平台返回的不是合法 JSON（HTTP ${response.status}）`, {
        status: response.status,
        indeterminate: true,
      })
    }

    return payload
  }

  /** 调一个 RPC。参数名与前端保持一致（p_ 前缀），便于和 src/lib/api.ts 对照。 */
  async rpc(name, args = {}) {
    return this.#request(`/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    })
  }

  /** PostgREST 表查询。query 的键值直接拼进查询串（`eq.`、`order` 等语法照 PostgREST 写）。 */
  async select(table, query = {}) {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue
      params.set(key, String(value))
    }
    const search = params.toString()
    return this.#request(`/rest/v1/${table}${search === '' ? '' : `?${search}`}`, { method: 'GET' })
  }

  async insert(table, row, { returning = 'representation' } = {}) {
    const payload = await this.#request(`/rest/v1/${table}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Prefer: `return=${returning}` },
      body: JSON.stringify(row),
    })
    return Array.isArray(payload) ? payload[0] : payload
  }
}
