/**
 * Linky 取数接口的只读客户端（V1.20）。
 *
 * 走 `net/proxy-http.ts` 的手工 CONNECT 隧道，而不是全局 fetch 代理：
 * 内网只能经 Mac 宿主机代理访问，但把全局代理打开会连带改道 Supabase、GitLab 与
 * Harness 的流量。实测数据（2026-09-24）：容器直连 `feature.kingdee.com:2055` 超时；
 * 经宿主机代理且代理放开了 2055 端口后 200，1.5 秒。
 *
 * 这个类只读，且只会拼四个固定路径。base URL 只来自 Worker 配置，不接受任何来自
 * 数据库或前端的 host —— Worker 不能变成 SSRF 跳板。
 */
import {
  type HostProxySettings,
  ProxyHttpError,
  proxyHttpGet,
} from '../net/proxy-http.js'
import type {
  LinkyAttachmentWire,
  LinkyStoryListItemWire,
  LinkyStoryListPage,
} from './mapping.js'

export const LINKY_MAX_PAGE_SIZE = 200

export type LinkyErrorCode =
  | 'LINKY_HTTP_ERROR'
  | 'LINKY_NOT_FOUND'
  | 'LINKY_TIMEOUT'
  | 'LINKY_PROXY_PORT_BLOCKED'
  | 'LINKY_PROXY_UNREACHABLE'
  | 'LINKY_NETWORK_ERROR'
  | 'LINKY_RESPONSE_INVALID'
  | 'LINKY_RESPONSE_TOO_LARGE'

export class LinkyApiError extends Error {
  constructor(
    public readonly code: LinkyErrorCode,
    message: string,
    public readonly statusCode: number | null = null,
  ) {
    super(message)
    this.name = 'LinkyApiError'
  }
}

export interface LinkyClientOptions {
  baseUrl: string
  proxy: HostProxySettings | null
  timeoutMs: number
  configId: string | null
  /** 单次响应体上限。列表/详情用这个，附件下载单独传。 */
  maxResponseBytes?: number
  sleep?: (ms: number) => Promise<void>
}

export interface LinkyStoryListQuery {
  workspaceId?: string | null
  workspaceName?: string | null
  assigneeName?: string | null
  page?: number
  pageSize?: number
}

export interface LinkyAttachmentDownload {
  body: Buffer
  contentType: string | null
}

const DEFAULT_SLEEP = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function mapProxyError(error: unknown): LinkyApiError {
  if (error instanceof ProxyHttpError) {
    switch (error.code) {
      case 'PROXY_TUNNEL_REJECTED':
        // 403 的含义很具体：宿主机代理的 MODEL_VPN_PROXY_ALLOWED_PORTS 没放开目标端口。
        return new LinkyApiError(
          'LINKY_PROXY_PORT_BLOCKED',
          `宿主机代理拒绝隧道（HTTP ${error.statusCode ?? 0}）；确认代理已放开 Linky 端口`,
          error.statusCode,
        )
      case 'PROXY_UNREACHABLE':
        return new LinkyApiError('LINKY_PROXY_UNREACHABLE', '宿主机代理不可用')
      case 'PROXY_TUNNEL_TIMEOUT':
      case 'REQUEST_TIMEOUT':
        return new LinkyApiError('LINKY_TIMEOUT', 'Linky 接口请求超时')
      case 'RESPONSE_TOO_LARGE':
        return new LinkyApiError('LINKY_RESPONSE_TOO_LARGE', error.message)
      default:
        return new LinkyApiError('LINKY_NETWORK_ERROR', 'Linky 接口网络错误')
    }
  }
  return new LinkyApiError('LINKY_NETWORK_ERROR', 'Linky 接口网络错误')
}

export class LinkyClient {
  private readonly base: string
  private readonly sleep: (ms: number) => Promise<void>

  constructor(private readonly options: LinkyClientOptions) {
    this.base = options.baseUrl.replace(/\/+$/, '')
    this.sleep = options.sleep ?? DEFAULT_SLEEP
  }

  private url(path: string, params: Record<string, string | number | null | undefined> = {}): string {
    const target = new URL(`${this.base}${path}`)
    if (this.options.configId !== null) target.searchParams.set('config_id', this.options.configId)
    for (const [key, value] of Object.entries(params)) {
      if (value === null || value === undefined || value === '') continue
      target.searchParams.set(key, String(value))
    }
    return target.toString()
  }

  /** GET + 一次重试。重试只覆盖网络抖动与 5xx；4xx 立即失败（重试没有意义）。 */
  private async get(
    url: string,
    options: { maxBytes?: number; signal?: AbortSignal } = {},
  ): Promise<{ statusCode: number; body: Buffer; contentType: string | null }> {
    const maxBytes = options.maxBytes ?? this.options.maxResponseBytes ?? 8 * 1024 * 1024
    let lastError: LinkyApiError | null = null
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (attempt > 0) await this.sleep(500 * attempt)
      try {
        const response = await proxyHttpGet({
          url,
          headers: { Accept: 'application/json, */*' },
          timeoutMs: this.options.timeoutMs,
          proxy: this.options.proxy,
          signal: options.signal,
          maxBytes,
        })
        if (response.statusCode === 404) {
          throw new LinkyApiError('LINKY_NOT_FOUND', 'Linky 找不到该故事或附件', 404)
        }
        if (response.statusCode >= 500) {
          lastError = new LinkyApiError(
            'LINKY_HTTP_ERROR',
            `Linky 返回 HTTP ${response.statusCode}`,
            response.statusCode,
          )
          continue
        }
        if (response.statusCode < 200 || response.statusCode > 299) {
          throw new LinkyApiError(
            'LINKY_HTTP_ERROR',
            `Linky 返回 HTTP ${response.statusCode}`,
            response.statusCode,
          )
        }
        const rawType = response.headers['content-type']
        return {
          statusCode: response.statusCode,
          body: response.body,
          contentType: typeof rawType === 'string' ? rawType : null,
        }
      } catch (error) {
        if (error instanceof LinkyApiError) {
          if (error.code === 'LINKY_NOT_FOUND' || error.code === 'LINKY_RESPONSE_TOO_LARGE') throw error
          lastError = error
          continue
        }
        const mapped = mapProxyError(error)
        if (mapped.code === 'LINKY_PROXY_PORT_BLOCKED' || mapped.code === 'LINKY_RESPONSE_TOO_LARGE') {
          // 端口没放开、响应超限都不是抖动，重试只是浪费一次往返。
          throw mapped
        }
        lastError = mapped
      }
    }
    throw lastError ?? new LinkyApiError('LINKY_NETWORK_ERROR', 'Linky 接口网络错误')
  }

  private async getJson(url: string, signal?: AbortSignal): Promise<unknown> {
    const response = await this.get(url, { signal })
    try {
      return JSON.parse(response.body.toString('utf8'))
    } catch {
      throw new LinkyApiError('LINKY_RESPONSE_INVALID', 'Linky 返回的不是合法 JSON')
    }
  }

  async listStories(query: LinkyStoryListQuery, signal?: AbortSignal): Promise<LinkyStoryListPage> {
    const pageSize = Math.min(Math.max(query.pageSize ?? LINKY_MAX_PAGE_SIZE, 1), LINKY_MAX_PAGE_SIZE)
    const url = this.url('/stories', {
      workspace_id: query.workspaceId ?? null,
      workspace_name: query.workspaceName ?? null,
      assignee_name: query.assigneeName ?? null,
      page: Math.max(query.page ?? 1, 1),
      page_size: pageSize,
    })
    const payload = await this.getJson(url, signal)
    if (typeof payload !== 'object' || payload === null) {
      throw new LinkyApiError('LINKY_RESPONSE_INVALID', 'Linky 列表响应不是对象')
    }
    const record = payload as Record<string, unknown>
    const items = Array.isArray(record.items) ? (record.items as LinkyStoryListItemWire[]) : null
    if (items === null) {
      throw new LinkyApiError('LINKY_RESPONSE_INVALID', 'Linky 列表响应缺少 items')
    }
    return {
      items,
      total: typeof record.total === 'number' ? record.total : items.length,
      page: typeof record.page === 'number' ? record.page : 1,
      pageSize: typeof record.page_size === 'number' ? record.page_size : pageSize,
      scopes: typeof record.scopes === 'number' ? record.scopes : 1,
    }
  }

  /**
   * 按分页把一个范围抓全。
   *
   * `maxPages` 是安全阀而不是业务限制：上游 total 与实际条数不一致时（或者被人改成
   * 死循环的分页语义），必须有一个地方停下来，而不是把 Worker 挂在这里。
   */
  async listAllStories(
    query: Omit<LinkyStoryListQuery, 'page'>,
    options: { maxPages?: number; signal?: AbortSignal } = {},
  ): Promise<{ items: LinkyStoryListItemWire[]; total: number; scopes: number; pages: number }> {
    const maxPages = Math.max(options.maxPages ?? 25, 1)
    const collected: LinkyStoryListItemWire[] = []
    let total = 0
    let scopes = 1
    let page = 1
    for (; page <= maxPages; page += 1) {
      const result = await this.listStories({ ...query, page }, options.signal)
      total = result.total
      scopes = result.scopes
      collected.push(...result.items)
      if (result.items.length === 0 || collected.length >= total) break
    }
    return { items: collected, total, scopes, pages: Math.min(page, maxPages) }
  }

  async getStory(story: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const payload = await this.getJson(
      this.url(`/stories/${encodeURIComponent(story)}`),
      signal,
    )
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      throw new LinkyApiError('LINKY_RESPONSE_INVALID', 'Linky 详情响应不是对象')
    }
    return payload as Record<string, unknown>
  }

  async listAttachments(story: string, signal?: AbortSignal): Promise<LinkyAttachmentWire[]> {
    const payload = await this.getJson(
      this.url(`/stories/${encodeURIComponent(story)}/attachments`),
      signal,
    )
    if (typeof payload !== 'object' || payload === null) {
      throw new LinkyApiError('LINKY_RESPONSE_INVALID', 'Linky 附件响应不是对象')
    }
    const items = (payload as Record<string, unknown>).items
    return Array.isArray(items) ? (items as LinkyAttachmentWire[]) : []
  }

  async downloadAttachment(
    story: string,
    attachmentId: string,
    options: { maxBytes: number; signal?: AbortSignal },
  ): Promise<LinkyAttachmentDownload> {
    const response = await this.get(
      this.url(`/stories/${encodeURIComponent(story)}/attachments/${encodeURIComponent(attachmentId)}/download`),
      { maxBytes: options.maxBytes, signal: options.signal },
    )
    if (response.body.length === 0) {
      throw new LinkyApiError('LINKY_RESPONSE_INVALID', '附件下载返回 0 字节')
    }
    return { body: response.body, contentType: response.contentType }
  }
}
