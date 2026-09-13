/**
 * Hermetic unit tests for the Harness plugins' decision logic.
 *
 * The real-process behaviour (profile boot, concludeTurn, zero persistence) is
 * covered by acp-runtime.integration.test.ts; these tests pin the pure rules
 * inside the platform plugins.
 *
 * V4 换了插件：model-budget-governor 与 volatile-session-persistence 被删掉，预算裁决移到了
 * Worker 侧的跨进程账本（HierarchicalBudgetLedger，见 attempt-control-broker），Session 改为
 * 落在持久卷上以支持恢复。留在插件里、值得单测的纯逻辑只剩三件：
 *
 *   1. RequestClassifier —— 把一次 llm/stream 归类成 loop / retry / compaction / session-title；
 *   2. denialChunk —— 预留被拒时用来短路整条流的终止 chunk；
 *   3. tokensFromChunk —— 从独立的 `usage` chunk 读 provider 报出来的 token，不报就是 null。
 *
 * 这些是"预留发生在调用 provider 之前"和"库里 token 是真值不是臆造"两条不变量的落点。
 */

import { describe, it, expect } from 'vitest'
import {
  RequestClassifier,
  denialChunk,
  tokensFromChunk,
} from '../harness-plugins/usage-reporter/index.js'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'

describe('RequestClassifier', () => {
  it('classifies compaction and session-title requests by purpose', () => {
    const classifier = new RequestClassifier()
    expect(classifier.classify({ isLoopRequest: false, purpose: 'compaction' })).toBe('compaction')
    expect(classifier.classify({ isLoopRequest: false, purpose: 'session-title' })).toBe(
      'session-title',
    )
    // purpose 优先于 loop 标记：压缩即使带着 loop 标记也仍是 compaction，分开计量故障才可辨。
    expect(classifier.classify({ isLoopRequest: true, purpose: 'compaction' })).toBe('compaction')
  })

  it('treats a request without a loop marker as other', () => {
    const classifier = new RequestClassifier()
    expect(classifier.classify({ isLoopRequest: false })).toBe('other')
  })

  it('classifies the request after a failed stream on the same session as a retry', () => {
    // retry 不是请求上的字段：retry 插件重发的是一次普通 loop。识别方式是"上一次 loop 流
    // 以失败结束"，这正是触发重试的条件。
    const classifier = new RequestClassifier()
    expect(classifier.classify({ isLoopRequest: true, sessionId: 's1' })).toBe('loop')

    classifier.observeFinish('s1', true)
    expect(classifier.classify({ isLoopRequest: true, sessionId: 's1' })).toBe('retry')
    // 另一个 session 不受 s1 失败的影响。
    expect(classifier.classify({ isLoopRequest: true, sessionId: 's2' })).toBe('loop')

    // s1 一旦成功收尾，下一次又回到普通 loop。
    classifier.observeFinish('s1', false)
    expect(classifier.classify({ isLoopRequest: true, sessionId: 's1' })).toBe('loop')
  })

  it('cannot mark a retry without a session id to hang the failure on', () => {
    // 没有 sessionId 就无从判断"上一次是否失败"，只能当作普通 loop —— 而不是猜成 retry。
    const classifier = new RequestClassifier()
    classifier.observeFinish(undefined, true)
    expect(classifier.classify({ isLoopRequest: true })).toBe('loop')
  })
})

describe('denialChunk', () => {
  it('is a terminal error finish carrying the stable code and reason', () => {
    // 预留被拒时不调用 next()，provider 永远不会被联系上；这个 chunk 就是终止信号。
    const chunk = denialChunk(
      'MODEL_BUDGET_EXHAUSTED',
      'attempt loop request budget exhausted (limit 3)',
    ) as {
      type: string
      reason: { kind: string; failure: { code: string; message: string } }
    }
    expect(chunk.type).toBe('finish')
    expect(chunk.reason.kind).toBe('error')
    expect(chunk.reason.failure.code).toBe('MODEL_BUDGET_EXHAUSTED')
    expect(chunk.reason.failure.message).toContain('budget exhausted')
  })

  it('carries an identity code just as it carries a budget code', () => {
    // 身份无法解析时也用同一个终止形状短路，只是换了一个稳定码。
    const chunk = denialChunk(
      'AGENT_IDENTITY_INVALID',
      'this model request has no verifiable agent identity',
    ) as { reason: { failure: { code: string } } }
    expect(chunk.reason.failure.code).toBe('AGENT_IDENTITY_INVALID')
  })
})

describe('tokensFromChunk', () => {
  it('reads provider-reported token usage from a usage chunk', () => {
    // dsh-llm 的 token 走独立的 `usage` chunk（`{ type: 'usage', usage: TokenUsage }`），
    // 不是挂在 finish 上。这一条按实际类型钉住：从 finish 上读的实现会让 token 永远是 null，
    // 而 null 在库里的含义是"这个 provider 不报 token"，于是用量在 UI 上永远空着。
    const chunk = {
      type: 'usage',
      usage: { inputTokens: 100, outputTokens: 20 },
    } as unknown as StreamChunk
    expect(tokensFromChunk(chunk)).toEqual({ inputTokens: 100, outputTokens: 20 })
  })

  it('ignores a finish chunk even if it happens to carry a usage field', () => {
    const chunk = {
      type: 'finish',
      usage: { inputTokens: 100, outputTokens: 20 },
    } as unknown as StreamChunk
    expect(tokensFromChunk(chunk)).toEqual({ inputTokens: null, outputTokens: null })
  })

  it('returns null when the provider reports no usage', () => {
    // 库里 `input_tokens is null` 表示"这个 provider 不报 token"，和"用了 0 个"是两件事，
    // UI 需要能区分 —— 所以缺失时保持 null，绝不臆造成 0。
    const chunk = { type: 'usage' } as unknown as StreamChunk
    expect(tokensFromChunk(chunk)).toEqual({ inputTokens: null, outputTokens: null })
  })

  it('rejects negative or non-numeric usage as null rather than trusting it', () => {
    const chunk = {
      type: 'usage',
      usage: { inputTokens: -5, outputTokens: 'lots' },
    } as unknown as StreamChunk
    expect(tokensFromChunk(chunk)).toEqual({ inputTokens: null, outputTokens: null })
  })
})
