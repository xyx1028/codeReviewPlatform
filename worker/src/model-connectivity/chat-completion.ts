/**
 * 一次性 `chat/completions` 文本请求（V1.19）。
 *
 * 与 `probe.ts` 的关系：那个只发 `ping` + `max_tokens: 1` 并**丢弃响应体**，因为它要回答的
 * 问题是"这条链路通不通"。这里需要响应体本身，所以不能复用它 —— 一个"顺手让 probe 也能
 * 返回正文"的改动会让连接测试链路开始把模型输出读进内存，而那条链路的安全约束正是"不读
 * 正文、不记正文"。
 *
 * 传输层同样用 node:http / node:https 而不是 fetch：公司内网模型必须经 Mac 宿主机代理，
 * 而这里需要**只让这一条请求**走代理。全局 fetch 代理会把 Supabase、GitLab 与 Harness 的
 * 流量一起改道，故障域比要解决的问题大得多。
 *
 * 安全约束：不记录 URL、Key、请求体或响应体；错误只回稳定错误码与一行原因。
 */

import http from 'node:http'
import https from 'node:https'
import type { ClientRequest, IncomingMessage } from 'node:http'
import type { Socket } from 'node:net'

import {
  ProxyHttpError,
  isProxyHopErrorCode,
  openProxyTunnel,
  proxyAuthHeader,
  tunneledHttpsRequest,
  urlPort as defaultPort,
} from '../net/proxy-http.js'
import type { ModelProxySettings } from './probe.js'

export interface ChatCompletionRequest {
  baseUrl: string
  modelName: string
  apiKey: string
  systemPrompt: string
  userPrompt: string
  timeoutMs: number
  /** 输出上限。技能正文最多 64 KiB，给一个宽裕但有界的值。 */
  maxTokens: number
  proxy?: ModelProxySettings | null
  signal?: AbortSignal
}

export interface ChatCompletionResult {
  /** 第一条 choice 的 message.content。调用方负责解析它。 */
  content: string
  latencyMs: number
  promptTokens: number | null
  completionTokens: number | null
}

export class ChatCompletionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode: number | null = null,
  ) {
    super(message)
    this.name = 'ChatCompletionError'
  }
}

/** 响应体上限。模型端点故障时可能返回一个巨大的 HTML 错误页，不能无界读进内存。 */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024

/**
 * 经代理建立 CONNECT 隧道，TLS 仍在 Worker 与模型端点之间端到端建立。
 *
 * 隧道、代理认证与默认端口都来自 `net/proxy-http.ts`（V1.20 起共用），这里只把共享原语的
 * 错误码翻译成模型侧错误码 —— 之前这里是第三份拷贝，漂移的代价是 CONNECT 成功之后请求
 * 根本没写进隧道。
 */
async function openTunnel(
  proxy: ModelProxySettings,
  target: URL,
  timeoutMs: number,
): Promise<Socket> {
  try {
    return await openProxyTunnel(proxy, target, timeoutMs)
  } catch (error) {
    if (error instanceof ProxyHttpError) {
      if (error.code === 'PROXY_TUNNEL_TIMEOUT') {
        throw new ChatCompletionError('MODEL_TIMEOUT', '模型请求超时')
      }
      if (error.code === 'PROXY_UNREACHABLE') {
        throw new ChatCompletionError(
          'MODEL_PROXY_UNREACHABLE',
          'Mac 宿主机代理不可用，请确认代理已启动',
        )
      }
      if (error.code === 'NETWORK_ERROR') {
        throw new ChatCompletionError(
          'MODEL_NETWORK_ERROR',
          '无法连接模型端点，请确认 Mac 已连接公司网络或 VPN',
        )
      }
      throw new ChatCompletionError(
        `MODEL_PROXY_HTTP_${error.statusCode ?? 0}`,
        `Mac 代理拒绝建立隧道（HTTP ${error.statusCode ?? 0}）`,
      )
    }
    throw error
  }
}

/**
 * 从 OpenAI 兼容响应里取出正文。形状不对就是"模型端点不兼容"，不是"内容不合规"。
 *
 * `finish_reason` 必须读（V1.22b）。线上踩过：模型配置 `max_output_tokens = 8192`，而调用方
 * 硬编码 `max_tokens: 60000`，端点按自己的上限截断，返回的 JSON 停在字符串中间。旧实现把
 * 这段残缺正文原样交给解析器，于是错误码是"输出里没有 JSON 对象"——运维据此去查模型会不会
 * 写 JSON，方向完全错了。截断是**容量问题**，必须有自己的错误码。
 */
export function readCompletionContent(payload: unknown): string {
  if (payload === null || typeof payload !== 'object') {
    throw new ChatCompletionError('MODEL_RESPONSE_INVALID', '模型响应不是 JSON 对象')
  }
  const choices = (payload as { choices?: unknown }).choices
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new ChatCompletionError('MODEL_RESPONSE_INVALID', '模型响应没有 choices')
  }
  const choice = choices[0] as { message?: unknown; finish_reason?: unknown }
  const message = choice.message
  const content = (message as { content?: unknown } | undefined)?.content
  const finishReason =
    typeof choice.finish_reason === 'string' ? choice.finish_reason.toLowerCase() : null
  if (finishReason === 'length' || finishReason === 'max_tokens') {
    const completion = readUsage(payload).completion
    throw new ChatCompletionError(
      'MODEL_OUTPUT_TRUNCATED',
      `模型输出达到 token 上限被截断（finish_reason=${finishReason}`
        + `${completion === null ? '' : `, completion_tokens=${completion}`}）`,
    )
  }
  if (typeof content !== 'string' || content.trim() === '') {
    throw new ChatCompletionError('MODEL_RESPONSE_INVALID', '模型响应的正文为空')
  }
  return content
}

function readUsage(payload: unknown): { prompt: number | null; completion: number | null } {
  const usage = (payload as { usage?: unknown } | null)?.usage
  if (usage === null || typeof usage !== 'object') return { prompt: null, completion: null }
  const record = usage as Record<string, unknown>
  const prompt = typeof record.prompt_tokens === 'number' ? record.prompt_tokens : null
  const completion = typeof record.completion_tokens === 'number' ? record.completion_tokens : null
  return { prompt, completion }
}

export async function requestChatCompletion(
  input: ChatCompletionRequest,
): Promise<ChatCompletionResult> {
  const timeoutMs = Math.min(Math.max(input.timeoutMs, 5000), 600000)
  let target: URL
  try {
    target = new URL(`${input.baseUrl.replace(/\/+$/, '')}/chat/completions`)
  } catch {
    throw new ChatCompletionError('MODEL_BASE_URL_INVALID', 'Base URL 不是合法的 HTTP(S) 地址')
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new ChatCompletionError('MODEL_BASE_URL_INVALID', 'Base URL 必须是 http 或 https')
  }

  const body = JSON.stringify({
    model: input.modelName,
    messages: [
      { role: 'system', content: input.systemPrompt },
      { role: 'user', content: input.userPrompt },
    ],
    max_tokens: input.maxTokens,
    // 改写技能正文要的是稳定与可复核，不是创造性。
    temperature: 0,
    stream: false,
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
      request = tunneledHttpsRequest({ tunnel, target, method: 'POST', headers, timeoutMs })
    } else if (input.proxy) {
      const proxyUrl = new URL(input.proxy.url)
      request = http.request({
        host: proxyUrl.hostname,
        port: defaultPort(proxyUrl),
        method: 'POST',
        // 明文 HTTP 经代理时用绝对 URL，由代理在 Mac 侧完成 DNS 与 VPN 路由。
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

    const { statusCode, text } = await new Promise<{ statusCode: number; text: string }>(
      (resolve, reject) => {
        const abort = () =>
          request.destroy(new ChatCompletionError('WORKER_SHUTDOWN', 'Worker 正在关闭'))
        if (input.signal?.aborted) abort()
        input.signal?.addEventListener('abort', abort, { once: true })

        request.once('response', (response: IncomingMessage) => {
          const parts: Buffer[] = []
          let total = 0
          response.on('data', (chunk: Buffer) => {
            total += chunk.length
            if (total > MAX_RESPONSE_BYTES) {
              response.destroy()
              reject(
                new ChatCompletionError('MODEL_RESPONSE_TOO_LARGE', '模型响应超出可接受大小'),
              )
              return
            }
            parts.push(chunk)
          })
          response.once('end', () =>
            resolve({
              statusCode: response.statusCode ?? 0,
              text: Buffer.concat(parts).toString('utf8'),
            }),
          )
          response.once('error', reject)
        })
        request.once('timeout', () =>
          request.destroy(new ChatCompletionError('MODEL_TIMEOUT', '模型请求超时')),
        )
        request.once('error', reject)
        request.once('close', () => input.signal?.removeEventListener('abort', abort))
        request.end(body)
      },
    )

    if (statusCode < 200 || statusCode > 299) {
      // 只回状态码，不回响应体：上游错误页可能带账号、配额或内部主机名。
      throw new ChatCompletionError(
        `MODEL_HTTP_${statusCode}`,
        `模型返回 HTTP ${statusCode}`,
        statusCode,
      )
    }

    let payload: unknown
    try {
      payload = JSON.parse(text)
    } catch {
      throw new ChatCompletionError('MODEL_RESPONSE_INVALID', '模型响应不是合法 JSON')
    }
    const usage = readUsage(payload)
    return {
      content: readCompletionContent(payload),
      latencyMs: elapsed(),
      promptTokens: usage.prompt,
      completionTokens: usage.completion,
    }
  } catch (error) {
    if (error instanceof ChatCompletionError) throw error
    const code = (error as { code?: string } | null)?.code
    // 只有"直接连代理"的明文 HTTP 转发路径，ECONNREFUSED 才等于代理不可用；
    // HTTPS 的代理跳已经在 openTunnel 里映射过，隧道之后的错误属于目标或 TLS。
    if (input.proxy && target.protocol === 'http:' && isProxyHopErrorCode(code)) {
      throw new ChatCompletionError(
        'MODEL_PROXY_UNREACHABLE',
        'Mac 宿主机代理不可用，请确认代理已启动',
      )
    }
    throw new ChatCompletionError(
      'MODEL_NETWORK_ERROR',
      '无法连接模型端点，请确认 Mac 已连接公司网络或 VPN',
    )
  } finally {
    tunnel?.destroy()
  }
}
