/**
 * 「只让这一条请求走宿主机代理」的通用 HTTP 原语（V1.20）。
 *
 * 为什么不用全局 fetch 代理：`NODE_USE_ENV_PROXY` / 全局 dispatcher 会把 Supabase、
 * GitLab、Harness 的流量一起改道，故障域比要解决的问题大得多。这条理由在
 * `model-connectivity/probe.ts` 里已经写过一次，V1.20 把原语抽到这里共用，
 * 免得第三份拷贝继续漂移。
 *
 * 适用对象：公司内网只能经 Mac 宿主机代理访问的只读 HTTP 服务。
 * 实测过的典型场景是 Linky 取数接口（`feature.kingdee.com:2055` 解析到
 * `172.18.x.x`，容器没有那条 VPN 路由，只能经 `host.docker.internal` 的代理出去）。
 *
 * 安全约束：
 *   - 代理凭据只进 `Proxy-Authorization` 头，不进日志、不进错误信息；
 *   - HTTPS 目标走 CONNECT 隧道，TLS 端到端建立，代理看不到明文；
 *   - 响应体有硬上限，超限立刻断开，不把未知大小的内容读进内存。
 */
import http from 'node:http'
import https from 'node:https'
import tls from 'node:tls'
import type { ClientRequest, IncomingHttpHeaders, IncomingMessage } from 'node:http'
import type { Socket } from 'node:net'

export interface HostProxySettings {
  url: string
  username: string | null
  password: string | null
}

export type ProxyHttpErrorCode =
  | 'PROXY_TUNNEL_REJECTED'
  | 'PROXY_TUNNEL_TIMEOUT'
  | 'PROXY_UNREACHABLE'
  | 'REQUEST_TIMEOUT'
  | 'RESPONSE_TOO_LARGE'
  | 'NETWORK_ERROR'
  | 'ABORTED'

export class ProxyHttpError extends Error {
  constructor(
    public readonly code: ProxyHttpErrorCode,
    message: string,
    public readonly statusCode: number | null = null,
  ) {
    super(message)
    this.name = 'ProxyHttpError'
  }
}

export function urlPort(target: URL): number {
  if (target.port !== '') return Number(target.port)
  return target.protocol === 'https:' ? 443 : 80
}

export function proxyAuthHeader(proxy: HostProxySettings): Record<string, string> {
  if (!proxy.username || !proxy.password) return {}
  const encoded = Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64')
  return { 'Proxy-Authorization': `Basic ${encoded}` }
}

/**
 * 「连代理这一跳本身失败」的 errno 集合。
 *
 * 只有这一跳才允许被解释成 `PROXY_UNREACHABLE`。隧道建成之后再出现同样的 errno，
 * 含义完全不同（目标或 TLS 的问题），把它也报成"代理不可用"会把排查引向错的方向。
 */
const PROXY_HOP_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENOTFOUND',
  'ECONNRESET',
  'ETIMEDOUT',
  'EAI_AGAIN',
])

export function isProxyHopErrorCode(code: string | undefined): boolean {
  return code !== undefined && PROXY_HOP_ERROR_CODES.has(code)
}

function mapProxyHopError(error: unknown): ProxyHttpError {
  if (error instanceof ProxyHttpError) return error
  const code = (error as { code?: string } | null)?.code
  if (isProxyHopErrorCode(code)) {
    return new ProxyHttpError('PROXY_UNREACHABLE', '宿主机代理不可用，请确认代理已启动')
  }
  return new ProxyHttpError('NETWORK_ERROR', '连接宿主机代理失败')
}

/** 经代理建立 CONNECT 隧道。HTTPS 目标用它，TLS 仍在调用方与目标之间端到端。 */
export function openProxyTunnel(
  proxy: HostProxySettings,
  target: URL,
  timeoutMs: number,
): Promise<Socket> {
  const proxyUrl = new URL(proxy.url)
  return new Promise<Socket>((resolve, reject) => {
    const request = http.request({
      host: proxyUrl.hostname,
      port: urlPort(proxyUrl),
      method: 'CONNECT',
      path: `${target.hostname}:${urlPort(target)}`,
      headers: proxyAuthHeader(proxy),
      timeout: timeoutMs,
    })
    request.once('connect', (response: IncomingMessage, socket: Socket) => {
      if (response.statusCode !== 200) {
        socket.destroy()
        // 403 在实测里有一个非常具体的含义：宿主机代理的
        // MODEL_VPN_PROXY_ALLOWED_PORTS 没放开目标端口（默认只有 80,443）。
        reject(
          new ProxyHttpError(
            'PROXY_TUNNEL_REJECTED',
            `宿主机代理拒绝建立隧道（HTTP ${response.statusCode ?? 0}）`,
            response.statusCode ?? null,
          ),
        )
        return
      }
      resolve(socket)
    })
    request.once('timeout', () => {
      request.destroy(new ProxyHttpError('PROXY_TUNNEL_TIMEOUT', '宿主机代理建立隧道超时'))
    })
    // 这一跳连的就是代理，所以 ECONNREFUSED / ENOTFOUND 在这里确实等于"代理不可用"。
    request.once('error', (error: unknown) => reject(mapProxyHopError(error)))
    request.end()
  })
}

export interface TunneledHttpsRequestOptions {
  /** `openProxyTunnel` 返回的原始 socket。 */
  tunnel: Socket
  target: URL
  method: string
  headers: Record<string, string>
  timeoutMs: number
}

/**
 * 在已建立的 CONNECT 隧道上发起一次 HTTPS 请求。TLS 端到端，代理只看到密文。
 *
 * 为什么不能写成 `https.request({ createConnection: () => tunnel, agent: false })`：
 * Node 在 `agent === false` 时会**新建一个默认 Agent**，请求随后走 Agent 自己的
 * `createConnection`，options 里传进去的那个函数被完全忽略；options 里又没有 host/port，
 * 于是它去连 `127.0.0.1:443` 并以 ECONNREFUSED 失败。2026-09-24 实测到的表象是 Linky
 * 导入报 `LINKY_PROXY_UNREACHABLE`，而代理其实是好的（CONNECT 返回 200、宿主机 curl 200）——
 * 隧道建成了，请求根本没往里写一个字节。这条路径从引入起就没成功过。
 *
 * 正确做法是把 `createConnection` 挂在 Agent **实例**上：实例属性遮蔽
 * `Agent.prototype.createConnection`，而 Agent 的 `createSocket` 调用的正是
 * `this.createConnection`。
 */
export function tunneledHttpsRequest(options: TunneledHttpsRequestOptions): ClientRequest {
  const agent = new https.Agent({ keepAlive: false, maxSockets: 1 })
  agent.createConnection = () =>
    tls.connect({ socket: options.tunnel, servername: options.target.hostname })
  return https.request({
    agent,
    host: options.target.hostname,
    port: urlPort(options.target),
    method: options.method,
    path: `${options.target.pathname}${options.target.search}`,
    headers: options.headers,
    timeout: options.timeoutMs,
  })
}


export interface ProxyHttpGetOptions {
  url: string
  headers?: Record<string, string>
  timeoutMs: number
  proxy?: HostProxySettings | null
  signal?: AbortSignal
  /** 响应体硬上限。超限立刻断开并抛 RESPONSE_TOO_LARGE。 */
  maxBytes: number
}

export interface ProxyHttpGetResult {
  statusCode: number
  headers: IncomingHttpHeaders
  body: Buffer
}

/**
 * 一次 GET。三条路径：
 *   直连            —— 没配代理；
 *   CONNECT 隧道    —— 配了代理且目标是 https；
 *   绝对 URL 转发   —— 配了代理且目标是明文 http（DNS 与路由都在宿主机侧完成）。
 */
export async function proxyHttpGet(options: ProxyHttpGetOptions): Promise<ProxyHttpGetResult> {
  const target = new URL(options.url)
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new ProxyHttpError('NETWORK_ERROR', '目标地址必须是 http 或 https')
  }
  const timeoutMs = Math.min(Math.max(options.timeoutMs, 1000), 120_000)
  const headers: Record<string, string> = { Host: target.host, ...(options.headers ?? {}) }
  let tunnel: Socket | null = null

  try {
    let request: ClientRequest
    if (options.proxy && target.protocol === 'https:') {
      tunnel = await openProxyTunnel(options.proxy, target, timeoutMs)
      request = tunneledHttpsRequest({
        tunnel,
        target,
        method: 'GET',
        headers,
        timeoutMs,
      })
    } else if (options.proxy) {
      const proxyUrl = new URL(options.proxy.url)
      request = http.request({
        host: proxyUrl.hostname,
        port: urlPort(proxyUrl),
        method: 'GET',
        path: target.toString(),
        headers: { ...headers, ...proxyAuthHeader(options.proxy) },
        timeout: timeoutMs,
      })
    } else {
      const transport = target.protocol === 'https:' ? https : http
      request = transport.request({
        host: target.hostname,
        port: urlPort(target),
        method: 'GET',
        path: `${target.pathname}${target.search}`,
        headers,
        timeout: timeoutMs,
      })
    }

    return await new Promise<ProxyHttpGetResult>((resolve, reject) => {
      const abort = () => request.destroy(new ProxyHttpError('ABORTED', '请求已取消'))
      if (options.signal?.aborted) abort()
      options.signal?.addEventListener('abort', abort, { once: true })

      request.once('response', (response: IncomingMessage) => {
        const declared = Number(response.headers['content-length'] ?? '0')
        if (Number.isFinite(declared) && declared > options.maxBytes) {
          response.destroy()
          request.destroy()
          reject(
            new ProxyHttpError(
              'RESPONSE_TOO_LARGE',
              `响应体 ${declared} 字节超过上限 ${options.maxBytes}`,
              response.statusCode ?? null,
            ),
          )
          return
        }
        const chunks: Buffer[] = []
        let size = 0
        response.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > options.maxBytes) {
            response.destroy()
            request.destroy()
            reject(
              new ProxyHttpError(
                'RESPONSE_TOO_LARGE',
                `响应体超过上限 ${options.maxBytes} 字节`,
                response.statusCode ?? null,
              ),
            )
            return
          }
          chunks.push(chunk)
        })
        response.once('end', () =>
          resolve({
            statusCode: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks),
          }),
        )
        response.once('error', reject)
      })
      request.once('timeout', () => {
        request.destroy(new ProxyHttpError('REQUEST_TIMEOUT', `请求超过 ${timeoutMs}ms 未完成`))
      })
      request.once('error', reject)
      request.once('close', () => options.signal?.removeEventListener('abort', abort))
      request.end()
    })
  } catch (error) {
    if (error instanceof ProxyHttpError) throw error
    const code = (error as { code?: string } | null)?.code
    // 只有明文 HTTP 经代理转发这一条路径是"直接连代理"：它的 ECONNREFUSED 才等于代理不可用。
    // HTTPS 走 CONNECT 隧道，连代理那一跳的失败已经在 openProxyTunnel 里映射过了；
    // 到这里的错误发生在隧道建成之后，属于目标或 TLS，不能再报成"代理不可用"。
    if (options.proxy && target.protocol === 'http:' && isProxyHopErrorCode(code)) {
      throw new ProxyHttpError('PROXY_UNREACHABLE', '宿主机代理不可用，请确认代理已启动')
    }
    throw new ProxyHttpError('NETWORK_ERROR', '网络请求失败')
  } finally {
    tunnel?.destroy()
  }
}
