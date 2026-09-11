/**
 * Hermetic unit tests for the Harness plugins' decision logic.
 *
 * The real-process behaviour (profile boot, concludeTurn, zero persistence) is
 * covered by acp-runtime.integration.test.ts; these tests pin the pure rules
 * that decide whether a model request is allowed and how it is classified.
 */

import { describe, it, expect } from 'vitest'
import {
  ModelBudgetGovernor,
  denialChunk,
  type GovernorConfig,
} from '../harness-plugins/model-budget-governor/index.js'

function limits(overrides: Partial<GovernorConfig> = {}): GovernorConfig {
  return {
    maxTotalRequests: 10,
    maxLoopRequests: 5,
    maxRetryRequests: 2,
    maxCompactionRequests: 1,
    ...overrides,
  }
}

describe('ModelBudgetGovernor classification', () => {
  it('classifies compaction and title requests by purpose', () => {
    const governor = new ModelBudgetGovernor(limits())
    expect(governor.classify({ isLoopRequest: false, purpose: 'compaction' })).toBe('compaction')
    expect(governor.classify({ isLoopRequest: false, purpose: 'session-title' })).toBe(
      'session-title',
    )
    // Purpose wins even when the request also carries the loop marker.
    expect(governor.classify({ isLoopRequest: true, purpose: 'compaction' })).toBe('compaction')
  })

  it('treats a hand-built request without a loop marker as other', () => {
    const governor = new ModelBudgetGovernor(limits())
    expect(governor.classify({ isLoopRequest: false })).toBe('other')
  })

  it('classifies the request after a failed stream as a retry', () => {
    const governor = new ModelBudgetGovernor(limits())
    expect(governor.classify({ isLoopRequest: true, sessionId: 's1' })).toBe('loop')

    governor.observeFinish('s1', true)
    expect(governor.classify({ isLoopRequest: true, sessionId: 's1' })).toBe('retry')
    // A different session is unaffected by s1's failure.
    expect(governor.classify({ isLoopRequest: true, sessionId: 's2' })).toBe('loop')

    governor.observeFinish('s1', false)
    expect(governor.classify({ isLoopRequest: true, sessionId: 's1' })).toBe('loop')
  })
})

describe('ModelBudgetGovernor budgets', () => {
  it('counts every admitted request kind separately and in total', () => {
    const governor = new ModelBudgetGovernor(limits())
    expect(governor.admit('loop').allowed).toBe(true)
    expect(governor.admit('retry').allowed).toBe(true)
    expect(governor.admit('compaction').allowed).toBe(true)
    expect(governor.admit('session-title').allowed).toBe(true)
    expect(governor.admit('other').allowed).toBe(true)

    expect(governor.counters).toMatchObject({
      total: 5,
      loop: 1,
      retry: 1,
      compaction: 1,
      sessionTitle: 1,
      other: 1,
      denied: 0,
    })
  })

  it('denies a kind once its own budget is exhausted, before the provider', () => {
    const governor = new ModelBudgetGovernor(limits({ maxCompactionRequests: 1 }))
    expect(governor.admit('compaction').allowed).toBe(true)

    const denied = governor.admit('compaction')
    expect(denied.allowed).toBe(false)
    expect(denied.code).toBe('MODEL_BUDGET_EXHAUSTED')
    expect(governor.counters.compaction).toBe(1)
    expect(governor.counters.denied).toBe(1)
    // A denial must not consume the shared total budget.
    expect(governor.counters.total).toBe(1)
  })

  it('denies everything once the total budget is exhausted', () => {
    const governor = new ModelBudgetGovernor(
      limits({ maxTotalRequests: 2, maxLoopRequests: 99, maxRetryRequests: 99 }),
    )
    expect(governor.admit('loop').allowed).toBe(true)
    expect(governor.admit('retry').allowed).toBe(true)

    const denied = governor.admit('loop')
    expect(denied.allowed).toBe(false)
    expect(denied.reason).toContain('budget exhausted')
    expect(governor.counters.total).toBe(2)
  })

  it('denies a retry when retries are disabled entirely', () => {
    const governor = new ModelBudgetGovernor(limits({ maxRetryRequests: 0 }))
    expect(governor.admit('retry').allowed).toBe(false)
    expect(governor.counters.retry).toBe(0)
  })
})

describe('denialChunk', () => {
  it('is a terminal error finish carrying the stable budget code', () => {
    const chunk = denialChunk({
      allowed: false,
      code: 'MODEL_BUDGET_EXHAUSTED',
      reason: 'attempt loop request budget exhausted (limit 3)',
    }) as {
      type: string
      reason: { kind: string; failure: { code: string; message: string } }
    }
    expect(chunk.type).toBe('finish')
    expect(chunk.reason.kind).toBe('error')
    expect(chunk.reason.failure.code).toBe('MODEL_BUDGET_EXHAUSTED')
    expect(chunk.reason.failure.message).toContain('budget exhausted')
  })

  it('falls back to a stable code and message when the verdict omits them', () => {
    const chunk = denialChunk({ allowed: false }) as {
      reason: { failure: { code: string; message: string } }
    }
    expect(chunk.reason.failure.code).toBe('MODEL_BUDGET_EXHAUSTED')
    expect(chunk.reason.failure.message).toBeTruthy()
  })
})
