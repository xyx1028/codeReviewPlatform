/**
 * resolveAnalysisError 的传输截断分类回归。
 *
 * 背景（2026-09-17 kimi-k3 生产排查）：Harness 把「流在收到 finish_reason 前关闭」
 * 统一抛成 JSON-RPC `-32603` + 文本 `Stream ended without finish_reason`，分类
 * （TRANSPORT）在冒泡到平台时丢失，导致前端显示「未知错误 / 不建议重试」。
 * 本测试锁定：这类消息被识别为 MODEL_STREAM_TRUNCATED 且可重试。
 */
import { describe, expect, it } from 'vitest'
import { resolveAnalysisError } from '../labels'

describe('resolveAnalysisError transport truncation', () => {
  it('classifies host-proxy 502 as retryable endpoint unavailability', () => {
    const r = resolveAnalysisError(
      '-32603',
      'Internal error: turn failed: 502 model endpoint unreachable from this Mac',
    )
    expect(r.code).toBe('MODEL_ENDPOINT_UNREACHABLE')
    expect(r.meta.title).toBe('模型服务暂时不可达')
    expect(r.meta.retryable).toBe(true)
    expect(r.originalCode).toBe('-32603')
  })

  it('classifies "Stream ended without finish_reason" as retryable stream truncation', () => {
    const r = resolveAnalysisError('-32603', 'Internal error: turn failed: Stream ended without finish_reason')
    expect(r.code).toBe('MODEL_STREAM_TRUNCATED')
    expect(r.meta.retryable).toBe(true)
    expect(r.originalCode).toBe('-32603')
  })

  it('classifies bare TRANSPORT code text as stream truncation', () => {
    const r = resolveAnalysisError(null, 'stream ended before a terminal response event (TRANSPORT)')
    expect(r.code).toBe('MODEL_STREAM_TRUNCATED')
    expect(r.meta.retryable).toBe(true)
  })

  it('classifies undici socket drop wording as stream truncation', () => {
    const r = resolveAnalysisError('-32603', 'turn failed: other side closed')
    expect(r.code).toBe('MODEL_STREAM_TRUNCATED')
    expect(r.meta.retryable).toBe(true)
  })

  it('classifies the openai SDK "Connection error." as a connect-stage failure', () => {
    // 2026-09-22 线上：HOST_PROXY 模型的 21 次请求（1 + 20 retry）全部在毫秒级失败、
    // input_tokens=0，Mac 代理日志里一条请求都没有 —— 请求没离开 Worker。
    const r = resolveAnalysisError('-32603', 'Internal error: turn failed: Connection error.')
    expect(r.code).toBe('MODEL_CONNECT_FAILED')
    expect(r.meta.retryable).toBe(true)
    expect(r.originalCode).toBe('-32603')
  })

  it('classifies raw socket-level connect errors as connect-stage failures', () => {
    for (const message of [
      'turn failed: connect ECONNREFUSED 192.168.65.254:17890',
      'turn failed: getaddrinfo ENOTFOUND host.docker.internal',
    ]) {
      const r = resolveAnalysisError('-32603', message)
      expect(r.code).toBe('MODEL_CONNECT_FAILED')
      expect(r.meta.retryable).toBe(true)
    }
  })

  it('keeps mid-stream drops separate from connect failures', () => {
    // ECONNRESET 是流已经建立后被切断，处置与"连不上"不同，不能合并成一类。
    const r = resolveAnalysisError('-32603', 'turn failed: ECONNRESET')
    expect(r.code).toBe('MODEL_STREAM_TRUNCATED')
  })

  it('keeps the host-proxy 502 case separate from connect failures', () => {
    const r = resolveAnalysisError(
      '-32603',
      'Internal error: turn failed: 502 model endpoint unreachable from this Mac',
    )
    expect(r.code).toBe('MODEL_ENDPOINT_UNREACHABLE')
  })

  it('classifies a provider 401 invalid_api_key as an auth failure, not an unknown error', () => {
    // 2026-09-23 线上：通义千问（DashScope）返回 401 invalid_api_key，页面原来显示
    // 「未知错误 / 不建议重试」，而处置其实很明确：换密钥并重新做连接测试。
    const r = resolveAnalysisError(
      '-32603',
      'Internal error: turn failed: 401: {"message":"Incorrect API key provided. For details, see: '
        + 'https://help.aliyun.com/zh/model-studio/error-code","type":"invalid_request_error","param":null,"code":"invalid_api_key"}',
    )
    expect(r.code).toBe('MODEL_AUTH_FAILED')
    expect(r.meta.title).toBe('模型密钥无效')
    expect(r.meta.retryable).toBe(true)
    expect(r.originalCode).toBe('-32603')
  })

  it('classifies other OpenAI-compatible auth rejections the same way', () => {
    for (const message of [
      'turn failed: 401 Unauthorized',
      'turn failed: 403 InvalidApiKey: the api key is revoked',
      'turn failed: Incorrect API key provided: sk-***',
    ]) {
      expect(resolveAnalysisError('-32603', message).code).toBe('MODEL_AUTH_FAILED')
    }
  })

  it('does not confuse an auth rejection with a connect failure', () => {
    // 两者的处置完全不同：一个换密钥，一个查网络。
    expect(resolveAnalysisError('-32603', 'turn failed: Connection error.').code).toBe('MODEL_CONNECT_FAILED')
    expect(resolveAnalysisError('-32603', 'turn failed: 401 invalid_api_key').code).toBe('MODEL_AUTH_FAILED')
  })

  it('does not hijack a known platform error code embedded in the message', () => {
    // 已登记错误码优先，传输兜底不应抢占（这里消息含 MODEL_RATE_LIMITED）。
    const r = resolveAnalysisError('MODEL_RATE_LIMITED', 'MODEL_RATE_LIMITED: too many requests')
    expect(r.code).toBe('MODEL_RATE_LIMITED')
  })

  it('still falls back to unknown for genuinely unclassified errors', () => {
    const r = resolveAnalysisError('-32603', 'Internal error: something totally unrecognized')
    // 原始码原样保留，meta 落到「未知错误 / 不建议重试」。
    expect(r.code).toBe('-32603')
    expect(r.meta.title).toBe('分析任务发生未知错误')
    expect(r.meta.retryable).toBe(false)
  })
})
