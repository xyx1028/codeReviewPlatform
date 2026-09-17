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
