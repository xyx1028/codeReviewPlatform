/**
 * 单模型最小连通性探测（V1.7）。
 *
 * 用 node:http / node:https 而不是 fetch：公司内网模型必须经 Mac 宿主机代理访问，而这里
 * 需要精确控制"仅这一条请求走代理"。全局 fetch 代理（NODE_USE_ENV_PROXY / 全局 dispatcher）
 * 会把 Supabase、GitLab 和 Harness 的流量一起改道，故障域比要解决的问题更大。
 *
 * 安全约束：只发送 `ping` 与 `max_tokens: 1`，读取后丢弃响应体，不记录 URL、Key 与正文。
 */
import http from 'node:http'
import https from 'node:https'
import type { ClientRequest, IncomingMessage } from 'node:http'
import type { Socket } from 'node:net'

export interface ModelProxySettings {
  url: string
  username: string | null
  password: string | null
}

export interface ModelConnectivityProbeInput {
  baseUrl: string
  modelName: string
  apiKey: string
  timeoutMs: number
  proxy?: ModelProxySettings | null
  signal?: AbortSignal
}

export interface ModelConnectivityProbeResult {
  statusCode: number
  latencyMs: number
}

export class ModelConnectivityProbeError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number | null = null,
    public readonly latencyMs: number | null = null,
  ) {
    super(message)
    this.name = 'ModelConnectivityProbeError'
  }
}

function proxyAuthHeader(proxy: ModelProxySettings): Record<string, string> {
  if (!proxy.username || !proxy.password) return {}
  const encoded = Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64')
  return { 'Proxy-Authorization': `Basic ${encoded}` }
}

function defaultPort(target: URL): number {
  if (target.port !== '') return Number(target.port)
  return target.protocol === 'https:' ? 443 : 80
}

/** 通过代理建立 CONNECT 隧道，用于 HTTPS 模型端点。 */
function openTunnel(
  proxy: ModelProxySettings,
  target: URL,
  timeoutMs: number,
): Promise<Socket> {
  const proxyUrl = new URL(proxy.url)
  return new Promise<Socket>((resolve, reject) => {
    const request = http.request({
      host: proxyUrl.hostname,
      port: defaultPort(proxyUrl),
      method: 'CONNECT',
      path: `${target.hostname}:${defaultPort(target)}`,
      headers: proxyAuthHeader(proxy),
      timeout: timeoutMs,
    })
    request.once('connect', (response: IncomingMessage, socket: Socket) => {
      if (response.statusCode !== 200) {
        socket.destroy()
        reject(
          new ModelConnectivityProbeError(
            `MODEL_PROXY_HTTP_${response.statusCode ?? 0}`,
            `Mac 代理拒绝建立隧道（HTTP ${response.statusCode ?? 0}）`,
          ),
        )
        return
      }
      resolve(socket)
    })
    request.once('timeout', () => request.destroy(new ModelConnectivityProbeError('MODEL_TIMEOUT', '模型连接测试超时')))
    request.once('error', reject)
    request.end()
  })
}

export async function probeModelConnectivity(
  input: ModelConnectivityProbeInput,
): Promise<ModelConnectivityProbeResult> {
  const timeoutMs = Math.min(Math.max(input.timeoutMs, 1000), 30000)
  let target: URL
  try {
    target = new URL(`${input.baseUrl.replace(/\/+$/, '')}/chat/completions`)
  } catch {
    throw new ModelConnectivityProbeError('MODEL_BASE_URL_INVALID', 'Base URL 不是合法的 HTTP(S) 地址')
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new ModelConnectivityProbeError('MODEL_BASE_URL_INVALID', 'Base URL 必须是 http 或 https')
  }

  const body = JSON.stringify({
    model: input.modelName,
    messages: [{ role: 'user', content: 'ping' }],
    max_tokens: 1,
  })
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Content-Length': String(Buffer.byteLength(body)),
    Authorization: `Bearer ${input.apiKey}`,
    Host: target.host,
  }

  const startedAt = Date.now()
  const elapsed = () => Date.now() - startedAt
  let tunnel: Socket | null = null

  try {
    let request: ClientRequest
    if (input.proxy && target.protocol === 'https:') {
      tunnel = await openTunnel(input.proxy, target, timeoutMs)
      const tunneledSocket = tunnel
      request = https.request({
        // 复用 CONNECT 隧道：TLS 在 Worker 与模型端点之间端到端建立，代理看不到明文。
        createConnection: () => tunneledSocket,
        agent: false,
        servername: target.hostname,
        method: 'POST',
        path: `${target.pathname}${target.search}`,
        headers,
        timeout: timeoutMs,
      })
    } else if (input.proxy) {
      const proxyUrl = new URL(input.proxy.url)
      request = http.request({
        host: proxyUrl.hostname,
        port: defaultPort(proxyUrl),
        method: 'POST',
        // 明文 HTTP 经代理时使用绝对 URL，由代理在 Mac 侧完成 DNS 与 VPN 路由。
        path: target.toString(),
        headers: { ...headers, ...proxyAuthHeader(input.proxy) },
        timeout: timeoutMs,
      })
    } else {
      const transport = target.protocol === 'https:' ? https : http
      request = transport.request({
        host: target.hostname,
        port: defaultPort(target),
        method: 'POST',
        path: `${target.pathname}${target.search}`,
        headers,
        timeout: timeoutMs,
      })
    }

    const statusCode = await new Promise<number>((resolve, reject) => {
      const abort = () => request.destroy(
        new ModelConnectivityProbeError('WORKER_SHUTDOWN', 'Worker 正在关闭'),
      )
      if (input.signal?.aborted) abort()
      input.signal?.addEventListener('abort', abort, { once: true })

      request.once('response', (response: IncomingMessage) => {
        // 读取并丢弃响应体：正文可能包含上游细节，不进日志也不入库。
        response.resume()
        response.once('end', () => resolve(response.statusCode ?? 0))
        response.once('error', reject)
      })
      request.once('timeout', () => request.destroy(
        new ModelConnectivityProbeError('MODEL_TIMEOUT', '模型连接测试超时'),
      ))
      request.once('error', reject)
      request.once('close', () => input.signal?.removeEventListener('abort', abort))
      request.end(body)
    })

    const latencyMs = elapsed()
    if (statusCode < 200 || statusCode > 299) {
      throw new ModelConnectivityProbeError(
        `MODEL_HTTP_${statusCode}`,
        `模型返回 HTTP ${statusCode}`,
        statusCode,
        latencyMs,
      )
    }
    return { statusCode, latencyMs }
  } catch (error) {
    if (error instanceof ModelConnectivityProbeError) {
      throw error.latencyMs === null
        ? new ModelConnectivityProbeError(error.code, error.message, error.statusCode, elapsed())
        : error
    }
    const code = (error as { code?: string } | null)?.code
    if (input.proxy && (code === 'ECONNREFUSED' || code === 'EHOSTUNREACH' || code === 'ECONNRESET')) {
      throw new ModelConnectivityProbeError(
        'MODEL_PROXY_UNREACHABLE',
        'Mac 宿主机代理不可用，请确认代理已启动',
        null,
        elapsed(),
      )
    }
    throw new ModelConnectivityProbeError(
      'MODEL_NETWORK_ERROR',
      '无法连接模型端点，请确认 Mac 已连接公司网络或 VPN',
      null,
      elapsed(),
    )
  } finally {
    tunnel?.destroy()
  }
}
