/**
 * Linky 取数接口的**只读**客户端（MCP 侧，V1.56）。
 *
 * 只为一件事存在：在**真正建批次之前**把调用方给的参数核对清楚。所以它只碰两个 GET
 * 端点，不下载附件、不读需求正文送去评审 —— 评审用的正文与附件仍然只由 Worker 在
 * 内网侧取并冻结。这条边界从 V1.20 起没变过：让调用方提供"需求正文"这一评审输入，
 * 平台无从判断它是否真的来自 Linky。
 *
 * base URL 只来自服务端环境变量，不接受任何调用方输入的 host —— MCP 不做 SSRF 跳板。
 * 路径只拼两个固定端点，编号经 encodeURIComponent。
 *
 * 实测结论（2026-10-19，见 V1.56 方案 §10.1），这些是本文件全部判断逻辑的依据：
 *
 *   · `workspace_name` 是**精确匹配**。不存在的工作区返回 `200 {"items":[],"total":0}`
 *     而**不是**报错 —— 一个写错的名字于是会安静地变成"这个组里没有需求"。
 *   · 工作区存在但上游凭据失效时返回 `400 {"detail":"Linky 返回错误（401）：invalid token"}`。
 *     两者的区别正好可以用来把话说准：是名字错了，还是平台侧 token 该换了。
 *   · 详情端点不带 `config_id` 时会自动遍历所有启用工作区，并在响应里给出可读的
 *     `workspace_name` —— 这就是"只给编号也能反查项目组"的依据。
 */

export const DEFAULT_LINKY_BASE_URL =
  'https://feature.kingdee.com:2055/quality-platform/api/linky'

/** 单次响应体上限。校验只读几个标量字段，不需要为大正文留空间。 */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024

export class LinkyLookupError extends Error {
  /**
   * @param {object} options
   * @param {boolean} [options.unverifiable]
   *   true 表示**没能完成校验**（连不上、超时、上游凭据失效），而不是"校验出参数是错的"。
   *   这个区分决定上层行为：参数错了就拒绝提交；校验做不到则要求使用者确认后照常提交 ——
   *   MCP 不在内网时整条链路不该被校验功能堵死。
   */
  constructor(message, { code, status = null, detail = null, unverifiable = false } = {}) {
    super(message)
    this.name = 'LinkyLookupError'
    this.code = code
    this.status = status
    this.detail = detail
    this.unverifiable = unverifiable
  }
}

/** 取上游错误响应里的 `detail`。那才是可操作的那句话，"HTTP 400"不是。 */
export function extractDetail(raw) {
  const text = String(raw ?? '').slice(0, 2000)
  if (text.trim() === '') return null
  try {
    const parsed = JSON.parse(text)
    if (typeof parsed === 'object' && parsed !== null) {
      for (const key of ['detail', 'message', 'error', 'msg']) {
        const value = parsed[key]
        if (typeof value === 'string' && value.trim() !== '') return value.trim().slice(0, 300)
      }
    }
  } catch {
    return text.replace(/\s+/g, ' ').trim().slice(0, 200)
  }
  return null
}

/**
 * 上游 4xx 是不是「平台侧 Linky 凭据失效」。
 *
 * 单列出来是因为处置完全不同：它不是使用者填错了参数，也不是我们的网络问题，
 * 重试、连 VPN、重启 Worker 全都没用。唯一的出路是让质量执行平台的维护者去
 * 「配置 › Linky 工作区」换一个有效 token。
 */
export function isUpstreamAuthFailure(status, detail) {
  if (status !== 400 && status !== 401 && status !== 403) return false
  if (detail === null) return status === 401 || status === 403
  return /invalid\s*token|unauthor|401|403|token\s*(已)?(失效|过期|无效)/i.test(detail)
}

function text(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

export class LinkyReadOnlyClient {
  #baseUrl
  #timeoutMs
  #fetch

  constructor({ baseUrl, timeoutMs = 8000, fetchImpl = fetch } = {}) {
    this.#baseUrl = String(baseUrl ?? '').replace(/\/+$/, '')
    this.#timeoutMs = timeoutMs
    this.#fetch = fetchImpl
  }

  get baseUrl() {
    return this.#baseUrl
  }

  async #getJson(path, params = {}) {
    const url = new URL(`${this.#baseUrl}${path}`)
    for (const [key, value] of Object.entries(params)) {
      if (value === null || value === undefined || value === '') continue
      url.searchParams.set(key, String(value))
    }

    let response
    try {
      response = await this.#fetch(url.toString(), {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal:
          typeof AbortSignal?.timeout === 'function'
            ? AbortSignal.timeout(this.#timeoutMs)
            : undefined,
      })
    } catch (error) {
      // 连不上/超时。MCP 可能压根不在内网 —— 这属于"校验做不到"，不是"参数错了"。
      throw new LinkyLookupError(
        `连不上 Linky 取数接口（${String(error?.message ?? error)}）`,
        { code: 'LINKY_UNREACHABLE', unverifiable: true },
      )
    }

    const raw = await response.text()
    if (raw.length > MAX_RESPONSE_BYTES) {
      throw new LinkyLookupError('Linky 响应过大', {
        code: 'LINKY_RESPONSE_TOO_LARGE',
        unverifiable: true,
      })
    }

    if (response.status === 404) {
      throw new LinkyLookupError(extractDetail(raw) ?? 'Linky 里找不到这条需求', {
        code: 'LINKY_STORY_NOT_FOUND',
        status: 404,
        detail: extractDetail(raw),
      })
    }

    if (!response.ok) {
      const detail = extractDetail(raw)
      if (isUpstreamAuthFailure(response.status, detail)) {
        throw new LinkyLookupError(
          `Linky 取数接口拒绝了平台侧凭据（HTTP ${response.status}${
            detail === null ? '' : `：${detail}`
          }）`,
          { code: 'LINKY_UPSTREAM_AUTH_FAILED', status: response.status, detail, unverifiable: true },
        )
      }
      throw new LinkyLookupError(
        `Linky 返回 HTTP ${response.status}${detail === null ? '' : `：${detail}`}`,
        { code: 'LINKY_HTTP_ERROR', status: response.status, detail, unverifiable: true },
      )
    }

    try {
      return JSON.parse(raw)
    } catch {
      throw new LinkyLookupError('Linky 返回的不是合法 JSON', {
        code: 'LINKY_RESPONSE_INVALID',
        unverifiable: true,
      })
    }
  }

  /**
   * 按编号取需求详情。
   *
   * 不传 `config_id`，让上游自动遍历所有启用工作区 —— 这正是"只给编号就能反查项目组"
   * 的依据（见 `/stories/help`）。
   */
  async getStory(storyCode) {
    const payload = await this.#getJson(`/stories/${encodeURIComponent(storyCode)}`)
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      throw new LinkyLookupError('Linky 详情响应不是对象', {
        code: 'LINKY_RESPONSE_INVALID',
        unverifiable: true,
      })
    }
    return payload
  }

  /**
   * 探一下上游整体是不是健康的。
   *
   * 只在"按编号查不到需求"之后调用，用来回答一个要紧的问题：**这个 404 可信吗？**
   * 上游凭据失效时，遍历工作区的那条路径可能根本没走完 —— 此时把"查不到"当成
   * "需求不存在"去拒绝提交，就是拿上游的故障去否认一条真实需求。
   *
   * 返回 `{ healthy, error }`。不抛错：它本身是一次辅助判断，失败了也只是让结论更保守。
   */
  async probeHealth() {
    try {
      await this.#getJson('/stories', { page: 1, page_size: 1 })
      return { healthy: true, error: null }
    } catch (error) {
      if (error instanceof LinkyLookupError) return { healthy: false, error }
      return { healthy: false, error: null }
    }
  }

  /**
   * 探一个项目组名是否真的能解析到工作区。
   *
   * 返回 `{ resolved, total }`。`resolved=false` 表示上游**正常返回了空列表** ——
   * 按上游契约那就是"这个工作区不存在"，而不是"它恰好没有需求"。
   */
  async probeWorkspace(workspaceName) {
    const payload = await this.#getJson('/stories', {
      workspace_name: workspaceName,
      page: 1,
      page_size: 1,
    })
    const record = typeof payload === 'object' && payload !== null ? payload : {}
    const items = Array.isArray(record.items) ? record.items : []
    const total = typeof record.total === 'number' ? record.total : items.length
    const first = items.length > 0 && typeof items[0] === 'object' && items[0] !== null
      ? text(items[0].workspace_name)
      : null
    return { resolved: total > 0 || items.length > 0, total, workspaceName: first }
  }
}
