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
    request.once('error', reject)
    request.end()
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
      const tunneledSocket = tunnel
      request = https.request({
        createConnection: () => tunneledSocket,
        agent: false,
        servername: target.hostname,
        method: 'GET',
        path: `${target.pathname}${target.search}`,
        headers,
        timeout: timeoutMs,
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
    if (
      options.proxy &&
      (code === 'ECONNREFUSED' || code === 'EHOSTUNREACH' || code === 'ECONNRESET')
    ) {
      throw new ProxyHttpError('PROXY_UNREACHABLE', '宿主机代理不可用，请确认代理已启动')
    }
    throw new ProxyHttpError('NETWORK_ERROR', '网络请求失败')
  } finally {
    tunnel?.destroy()
  }
}
