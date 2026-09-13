/**
 * 真实模型用量上报，以及"在调用 provider 之前"的跨 Agent 预算裁决。
 *
 * V3 的问题不是计数不准，而是计数错位：库里的 `modelRequests` 存的是 Broker 的工具调用数。
 * 一次模型请求可能触发零次或多次工具调用，两者没有换算关系，所以那个字段一直是错的。
 *
 * V4 的做法：
 *
 *   * `llm/stream` 是 Harness 里每一次流式模型调用的唯一入口 —— agent-loop 的轮次、
 *     `dsh-llm-retry` 重发的重试、自动压缩、会话标题，全都经过它；
 *   * 在这里先向 Broker **预留** 一次额度。Broker 持有整个 attempt 的账本，因此并行子 Agent
 *     之间的总量 hard cap 是原子的 —— 这件事进程内 governor 做不到，因为多个 Agent 共享
 *     同一份预算，而预算的权威副本在 Worker 侧；
 *   * 预留被拒时 **不调用 next()**，provider 永远不会被联系上；
 *   * 流结束后把 provider 报出来的 token 用量上报。provider 不报就不报，保持 null。
 */

import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import { isAgentLoopRequest, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { agentIdentityRegistry } from '../shared/agent-identity.js'
import { brokerPost } from '../shared/broker-client.js'
import { BROKER_TOKEN_ENV, readCredentialFromEnv } from '../shared/credential-env.js'

export const name = 'usage-reporter'

export const inject = ['llm']

export interface UsageReporterConfig {
  socketPath: string
  taskId: string
  agentAttempt: number
  requestTimeoutMs?: number
  rootAgentId: string
}

export const Config: z<UsageReporterConfig> = z.object({
  socketPath: z.string().required(),
  taskId: z.string().required(),
  agentAttempt: z.number().required(),
  requestTimeoutMs: z.number(),
  rootAgentId: z.string().required(),
})

export type ModelRequestKind = 'loop' | 'retry' | 'compaction' | 'session-title' | 'ralph' | 'other'

/**
 * 分类一次模型请求。
 *
 * retry 不是请求上的一个字段：retry 插件重发的是一次普通 loop 请求。识别方式是"同一个
 * session 的上一次 loop 流以失败结束"，这正是触发重试的条件。
 */
export class RequestClassifier {
  private readonly failedSessions = new Set<string>()

  classify(input: {
    isLoopRequest: boolean
    purpose?: string
    sessionId?: string
  }): ModelRequestKind {
    if (input.purpose === 'compaction') return 'compaction'
    if (input.purpose === 'session-title') return 'session-title'
    if (!input.isLoopRequest) return 'other'
    if (input.sessionId !== undefined && this.failedSessions.has(input.sessionId)) return 'retry'
    return 'loop'
  }

  observeFinish(sessionId: string | undefined, failed: boolean): void {
    if (sessionId === undefined) return
    if (failed) this.failedSessions.add(sessionId)
    else this.failedSessions.delete(sessionId)
  }
}

/** 预算被拒时用来短路整条流的终止 chunk。 */
export function denialChunk(code: string, reason: string): StreamChunk {
  return {
    type: 'finish',
    reason: { kind: 'error', failure: { message: reason, code } },
  } as StreamChunk
}

function isFailureFinish(chunk: StreamChunk): boolean {
  if (chunk.type !== 'finish') return false
  const kind = (chunk as { reason?: { kind?: string } }).reason?.kind
  return kind === 'error' || kind === 'aborted'
}

/**
 * 从 chunk 里读 provider 报出来的 token 用量。没有就是 null。
 *
 * token 走的是**独立的 `usage` chunk**（`{ type: 'usage', usage: TokenUsage }`），不是挂在
 * finish chunk 上。这一点必须按实际类型来：早先的实现从 finish 上读，结果 token 永远是
 * null，而 null 在库里的含义是"这个 provider 不报 token" —— 于是一个会报 token 的 provider
 * 被记成了不报，UI 上的用量永远空着。
 */
export function tokensFromChunk(chunk: StreamChunk): {
  inputTokens: number | null
  outputTokens: number | null
} {
  if (chunk.type !== 'usage') return { inputTokens: null, outputTokens: null }
  const usage = (chunk as { usage?: { inputTokens?: unknown; outputTokens?: unknown } }).usage
  const read = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
  return {
    inputTokens: read(usage?.inputTokens),
    outputTokens: read(usage?.outputTokens),
  }
}

/**
 * 诊断只写 stderr：stdout 属于 ACP 流。
 * 预算拒绝无条件输出 —— 它会终止整个 attempt，是排查"预算花在哪"的唯一线索。
 */
function always(message: string): void {
  try {
    process.stderr.write(`[usage-reporter] ${message}\n`)
  } catch {
    // 诊断绝不能反过来搞坏 attempt。
  }
}

export function apply(ctx: Context, config: UsageReporterConfig): void {
  const channel = {
    socketPath: config.socketPath,
    token: readCredentialFromEnv(BROKER_TOKEN_ENV),
    timeoutMs: config.requestTimeoutMs ?? 30000,
  }
  const classifier = new RequestClassifier()

  ctx.on(
    'llm/stream',
    function (options: GenerateOptions, next: () => AsyncIterable<StreamChunk>) {
      const sessionId = (options as { sessionId?: string }).sessionId
      const kind = classifier.classify({
        isLoopRequest: isAgentLoopRequest(options),
        purpose: (options as { purpose?: string }).purpose,
        sessionId,
      })

      // 预留必须在 next() 之前完成，所以这里必然是一次 await。llm/stream 返回
      // AsyncIterable，于是把预留放进生成器的第一步 —— 这仍然早于任何 provider 调用。
      return (async function* metered() {
        // 解析失败的**原因**必须留痕。此前这里是 `.catch(() => null)`，只写一行
        // `IDENTITY_UNRESOLVED` 就把错误扔了 —— 于是"后台委派为什么静默失败"完全无法诊断，
        // 排查时只能靠猜。身份解析失败是结构性问题，不是噪声。
        let identityError: string | null = null
        const identity = await agentIdentityRegistry()
          .resolve(sessionId ?? config.rootAgentId)
          .catch((err: unknown) => {
            const code = (err as { code?: string })?.code ?? 'UNKNOWN'
            const message = (err as { message?: string })?.message ?? String(err)
            identityError = `${code}: ${message}`
            return null
          })
        if (!identity) {
          always(
            `IDENTITY_UNRESOLVED ${JSON.stringify({
              kind,
              hasSession: sessionId !== undefined,
              cause: identityError,
            })}`,
          )
          yield denialChunk(
            'AGENT_IDENTITY_INVALID',
            'this model request has no verifiable agent identity',
          )
          return
        }

        let verdict: {
          allowed?: boolean
          code?: string
          reason?: string
          scope?: string
        } | null = null
        try {
          const response = await brokerPost<typeof verdict>(
            channel,
            '/attempt/reserve-model-request',
            {
              taskId: config.taskId,
              agentAttempt: config.agentAttempt,
              agentCapability: identity.agentCapability,
              agentId: identity.agentId,
              sessionId: identity.sessionId,
              kind,
              count: 1,
            },
          )
          verdict = response.status === 200 ? response.body : { allowed: false, code: 'BROKER_DENIED' }
        } catch (err) {
          // Broker 不可达时 fail closed：允许无限制调用 provider 是最坏的失败方式。
          verdict = {
            allowed: false,
            code: 'BROKER_UNAVAILABLE',
            reason: `the budget ledger is unreachable (${(err as Error).message})`,
          }
        }

        if (verdict?.allowed !== true) {
          always(
            `BUDGET_DENIED ${JSON.stringify({
              kind,
              code: verdict?.code,
              scope: verdict?.scope,
              agentRole: identity.role,
            })}`,
          )
          yield denialChunk(
            verdict?.code ?? 'MODEL_BUDGET_EXHAUSTED',
            verdict?.reason ?? 'model request denied by the attempt budget',
          )
          return
        }

        let failed = false
        let inputTokens: number | null = null
        let outputTokens: number | null = null
        try {
          for await (const chunk of next()) {
            if (chunk.type === 'usage') {
              const tokens = tokensFromChunk(chunk)
              // 一次流里可能有多个 usage chunk（例如流式续报）：累加而不是覆盖。
              if (tokens.inputTokens !== null) {
                inputTokens = (inputTokens ?? 0) + tokens.inputTokens
              }
              if (tokens.outputTokens !== null) {
                outputTokens = (outputTokens ?? 0) + tokens.outputTokens
              }
            }
            if (isFailureFinish(chunk)) failed = true
            yield chunk
          }
        } finally {
          classifier.observeFinish(sessionId, failed)
          if (inputTokens !== null || outputTokens !== null) {
            void brokerPost(channel, '/attempt/report-usage', {
              taskId: config.taskId,
              agentAttempt: config.agentAttempt,
              agentCapability: identity.agentCapability,
              agentId: identity.agentId,
              sessionId: identity.sessionId,
              inputTokens,
              outputTokens,
            }).catch((err: unknown) => {
              // token 用量上报失败会让库里的 usage 偏小，成本核对随之失真。留痕而不是吞掉。
              always(
                `USAGE_REPORT_FAILED ${JSON.stringify({
                  cause: (err as { code?: string })?.code ?? 'UNKNOWN',
                })}`,
              )
            })
          }
        }
      })()
    },
    { global: true, prepend: true },
  )
}
