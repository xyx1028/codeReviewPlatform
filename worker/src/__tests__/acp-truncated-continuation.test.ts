/**
 * 输出截断（`max_tokens`）不再等于终态失败。
 *
 * 真实故障（2026-09-23 本地全链路实测，Job `3552cc95`）：glm5.3-flash 的一次 attempt 以
 * `max_tokens` 结束、尚未调用 submit_review_result，引擎记成 `AGENT_TURN_INCOMPLETE`，
 * 而 `fail_agent_review` 是 fail-fast —— **一个需求的输出超长就把整个 Job 判失败**
 * （当时 4 个需求里 2 个已提交，Job 仍然 FAILED）。评审结论本身就是长文本，这种截断会反复发生。
 *
 * 规则：有上界地续写（默认 2 次），取消时不续写，其它 stop reason 一律不续写。
 */
import { describe, expect, it } from 'vitest'
import { shouldContinueAfterTruncation } from '../ai/acp/acp-client.js'

describe('max_tokens 截断后的有界续写', () => {
  it('首次截断允许续写', () => {
    expect(shouldContinueAfterTruncation({
      stopReason: 'max_tokens', continuations: 0, maxContinuations: 2, aborted: false,
    })).toBe(true)
  })

  it('续写有上界，到达上界后才判定为未完成', () => {
    expect(shouldContinueAfterTruncation({
      stopReason: 'max_tokens', continuations: 1, maxContinuations: 2, aborted: false,
    })).toBe(true)
    expect(shouldContinueAfterTruncation({
      stopReason: 'max_tokens', continuations: 2, maxContinuations: 2, aborted: false,
    })).toBe(false)
  })

  it('上界为 0 时保持旧行为（完全不续写）', () => {
    expect(shouldContinueAfterTruncation({
      stopReason: 'max_tokens', continuations: 0, maxContinuations: 0, aborted: false,
    })).toBe(false)
  })

  it('已取消的 attempt 不再续写：取消必须立刻收敛', () => {
    expect(shouldContinueAfterTruncation({
      stopReason: 'max_tokens', continuations: 0, maxContinuations: 2, aborted: true,
    })).toBe(false)
  })

  it('其它 stop reason 不触发续写', () => {
    for (const stopReason of ['end_turn', 'cancelled', 'refusal', 'error']) {
      expect(shouldContinueAfterTruncation({
        stopReason, continuations: 0, maxContinuations: 2, aborted: false,
      })).toBe(false)
    }
  })
})
