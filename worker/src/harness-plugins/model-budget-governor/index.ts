/**
 * Authoritative model-request accounting and hard budgets for one attempt.
 *
 * Every streaming model call inside the Harness passes through the
 * `llm/stream` waterfall: agent-loop turns, provider retries re-issued by
 * `@deepseek-ai/dsh-llm-retry`, automatic compaction, and session titling.
 * Counting here — rather than trusting ACP usage updates — is what makes the
 * budget enforceable, because a denial happens before `next()` is called and
 * therefore before the provider is ever contacted.
 *
 * Retries are not distinguishable from a field on the request: the retry
 * plugin re-issues an ordinary loop request. They are classified by observing
 * that the previous loop stream for the same session ended in a failure
 * finish, which is exactly the condition that triggers a retry.
 */

import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import { isAgentLoopRequest, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'

export const name = 'model-budget-governor'

export const inject = ['llm']

export interface GovernorConfig {
  maxTotalRequests: number
  maxLoopRequests: number
  maxRetryRequests: number
  maxCompactionRequests: number
  /** Optional Unix socket used to report usage back to the Worker. */
  brokerSocketPath?: string
  brokerToken?: string
}

export const Config: z<GovernorConfig> = z.object({
  maxTotalRequests: z.number().required(),
  maxLoopRequests: z.number().required(),
  maxRetryRequests: z.number().required(),
  maxCompactionRequests: z.number().required(),
  brokerSocketPath: z.string(),
  brokerToken: z.string(),
})

export type ModelRequestKind = 'loop' | 'retry' | 'compaction' | 'session-title' | 'other'

export interface GovernorCounters {
  total: number
  loop: number
  retry: number
  compaction: number
  sessionTitle: number
  other: number
  denied: number
}

export interface BudgetVerdict {
  allowed: boolean
  reason?: string
  code?: string
}

/** Pure budget state machine, unit-testable without a Harness process. */
export class ModelBudgetGovernor {
  readonly counters: GovernorCounters = {
    total: 0,
    loop: 0,
    retry: 0,
    compaction: 0,
    sessionTitle: 0,
    other: 0,
    denied: 0,
  }

  /** Sessions whose most recent loop stream ended in a failure finish. */
  private readonly failedSessions = new Set<string>()

  constructor(private readonly limits: GovernorConfig) {}

  classify(options: {
    isLoopRequest: boolean
    purpose?: string
    sessionId?: string
  }): ModelRequestKind {
    if (options.purpose === 'compaction') return 'compaction'
    if (options.purpose === 'session-title') return 'session-title'
    if (!options.isLoopRequest) return 'other'
    if (options.sessionId !== undefined && this.failedSessions.has(options.sessionId)) {
      return 'retry'
    }
    return 'loop'
  }

  /** Reserve one request against the budget, or deny it before the provider. */
  admit(kind: ModelRequestKind): BudgetVerdict {
    const projectedTotal = this.counters.total + 1
    if (projectedTotal > this.limits.maxTotalRequests) {
      this.counters.denied++
      return {
        allowed: false,
        code: 'MODEL_BUDGET_EXHAUSTED',
        reason: `attempt model-request budget exhausted (limit ${this.limits.maxTotalRequests})`,
      }
    }
    const perKind = this.perKindLimit(kind)
    if (perKind !== null && this.countOf(kind) + 1 > perKind) {
      this.counters.denied++
      return {
        allowed: false,
        code: 'MODEL_BUDGET_EXHAUSTED',
        reason: `attempt ${kind} request budget exhausted (limit ${perKind})`,
      }
    }

    this.counters.total = projectedTotal
    switch (kind) {
      case 'loop':
        this.counters.loop++
        break
      case 'retry':
        this.counters.retry++
        break
      case 'compaction':
        this.counters.compaction++
        break
      case 'session-title':
        this.counters.sessionTitle++
        break
      default:
        this.counters.other++
    }
    return { allowed: true }
  }

  /** Record how a stream terminated so the next request can be classified. */
  observeFinish(sessionId: string | undefined, failed: boolean): void {
    if (sessionId === undefined) return
    if (failed) {
      this.failedSessions.add(sessionId)
    } else {
      this.failedSessions.delete(sessionId)
    }
  }

  private countOf(kind: ModelRequestKind): number {
    switch (kind) {
      case 'loop':
        return this.counters.loop
      case 'retry':
        return this.counters.retry
      case 'compaction':
        return this.counters.compaction
      case 'session-title':
        return this.counters.sessionTitle
      default:
        return this.counters.other
    }
  }

  private perKindLimit(kind: ModelRequestKind): number | null {
    switch (kind) {
      case 'loop':
        return this.limits.maxLoopRequests
      case 'retry':
        return this.limits.maxRetryRequests
      case 'compaction':
        return this.limits.maxCompactionRequests
      default:
        return null
    }
  }
}

/** Terminal chunk shape used to short-circuit a denied request. */
export function denialChunk(verdict: BudgetVerdict): StreamChunk {
  return {
    type: 'finish',
    reason: {
      kind: 'error',
      failure: {
        message: verdict.reason ?? 'model request denied by attempt budget',
        code: verdict.code ?? 'MODEL_BUDGET_EXHAUSTED',
      },
    },
  } as StreamChunk
}

function isFailureFinish(chunk: StreamChunk): boolean {
  if (chunk.type !== 'finish') return false
  const kind = (chunk as { reason?: { kind?: string } }).reason?.kind
  return kind === 'error' || kind === 'aborted'
}

/**
 * Diagnostics go to stderr only: stdout belongs to the ACP stream. Chunk types
 * and finish reasons are logged; model content never is.
 */
function diagnostic(message: string): void {
  if (process.env.HARNESS_PLUGIN_DIAGNOSTICS !== '1') return
  always(message)
}

/**
 * 无条件写入 stderr，用于 attempt 级的终止性事件。
 *
 * stdout 属于 ACP 流，绝不能写；stderr 由 Worker 有界收集并在失败时落日志。
 */
function always(message: string): void {
  try {
    process.stderr.write(`[model-budget-governor] ${message}\n`)
  } catch {
    // Diagnostics must never break the attempt.
  }
}

function describeFinish(chunk: StreamChunk): string {
  const reason = (chunk as { reason?: { kind?: string; failure?: { code?: string; message?: string } } })
    .reason
  if (!reason) return 'finish(unknown)'
  const failure = reason.failure
  return failure
    ? `finish(${reason.kind}, code=${failure.code}, message=${failure.message})`
    : `finish(${reason.kind})`
}

export function apply(ctx: Context, config: GovernorConfig): void {
  const governor = new ModelBudgetGovernor(config)

  ctx.on(
    'llm/stream',
    function (options: GenerateOptions, next: () => AsyncIterable<StreamChunk>) {
      const sessionId = (options as { sessionId?: string }).sessionId
      const kind = governor.classify({
        isLoopRequest: isAgentLoopRequest(options),
        purpose: (options as { purpose?: string }).purpose,
        sessionId,
      })
      const verdict = governor.admit(kind)

      if (!verdict.allowed) {
        // The provider is never reached: next() is not called.
        //
        // 拒绝会终止整个 attempt，所以这一条不受 HARNESS_PLUGIN_DIAGNOSTICS 控制：
        // 它是排查"预算花在哪"的唯一线索，而 Worker 会把子进程 stderr 收进失败日志。
        // 只输出计数，不含任何模型内容。
        always(
          `BUDGET_DENIED ${JSON.stringify({
            kind,
            code: verdict.code,
            reason: verdict.reason,
            limits: {
              total: config.maxTotalRequests,
              loop: config.maxLoopRequests,
              retry: config.maxRetryRequests,
              compaction: config.maxCompactionRequests,
            },
            counters: { ...governor.counters },
          })}`,
        )
        diagnostic(`denied ${kind}: ${verdict.code}`)
        return (async function* denied() {
          yield denialChunk(verdict)
        })()
      }

      diagnostic(`admitted ${kind} (total=${governor.counters.total})`)
      return (async function* metered() {
        diagnostic('iteration started')
        let failed = false
        const seen = new Map<string, number>()
        try {
          for await (const chunk of next()) {
            seen.set(chunk.type, (seen.get(chunk.type) ?? 0) + 1)
            if (chunk.type === 'finish') {
              diagnostic(describeFinish(chunk))
            }
            if (isFailureFinish(chunk)) failed = true
            yield chunk
          }
          diagnostic(
            `stream complete: ${[...seen].map(([type, count]) => `${type}x${count}`).join(' ')}`,
          )
        } catch (err) {
          diagnostic(`stream threw: ${(err as Error)?.message ?? err}`)
          throw err
        } finally {
          governor.observeFinish(sessionId, failed)
        }
      })()
    },
    { global: true, prepend: true },
  )

  ctx.effect(() => () => {
    // Counters die with the attempt process; the Worker's broker keeps the
    // durable copy for the review run record.
  })
}
