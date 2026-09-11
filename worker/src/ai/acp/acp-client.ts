/**
 * ACP control plane for one review attempt.
 *
 * One attempt is one child process, one ACP session, and one prompt turn. The
 * turn ends when the review-control tool commits a result and concludes the
 * turn, when the budget governor denies a request, or when the worker cancels.
 *
 * Update payloads are deliberately not logged: they carry prompt text, model
 * output and tool results, which include repository source.
 */

import { Readable, Writable } from 'node:stream'
import { client, methods, ndJsonStream } from '@agentclientprotocol/sdk'
import type { AcpProcessHandle } from './acp-process-supervisor.js'

export interface AcpSessionOptions {
  process: AcpProcessHandle
  /** Working directory reported to the agent. */
  cwd: string
  /** MCP servers exposed to the session (snapshot tools). */
  mcpServers?: Array<Record<string, unknown>>
  clientName?: string
  /**
   * Tool names this client will approve if the agent asks for permission.
   * Anything else is rejected. Defaults to the review submission tool.
   */
  permittedTools?: string[]
  /**
   * 每次观测到 agent 发起工具调用时回调（同一工具会重复回调）。
   *
   * 之所以用回调而不是只靠返回值：turn 抛错时返回值拿不到，而"模型是否调用过
   * 提交工具"恰恰是那种场景下最需要的信息。
   */
  onToolCall?: (toolName: string) => void
}

const DEFAULT_PERMITTED_TOOLS = ['submit_review_result']

/** Names a permission request may carry for the tool being approved. */
function permissionSubject(toolCall: { title?: string | null }): string {
  return toolCall.title ?? ''
}

export interface PermissionOptionLike {
  optionId: string
  kind: string
}

export type PermissionDecision =
  | { outcome: 'cancelled' }
  | { outcome: 'selected'; optionId: string }

/**
 * Decide one permission request.
 *
 * Deny by default: only a tool on the allowlist may be approved, and a request
 * whose options offer no usable choice is cancelled rather than guessed at.
 * Leaving this to the agent's own defaults would make the approved surface
 * depend on the profile rather than on the worker.
 */
/**
 * 把 JSON-RPC 风格的错误压成一行可读文本。
 *
 * ACP 的错误对象常见形态是 `{ code, message, data }`，直接 String() 会得到
 * "[object Object]"，等于没有信息。
 */
export function describeProtocolError(err: unknown): string {
  if (err === null || err === undefined) return 'unknown error'
  if (typeof err === 'string') return err
  if (typeof err !== 'object') return String(err)

  const record = err as { code?: unknown; message?: unknown; data?: unknown }
  const parts: string[] = []
  if (record.code !== undefined) parts.push(`code=${String(record.code)}`)
  if (typeof record.message === 'string' && record.message !== '') parts.push(record.message)
  else if (err instanceof Error && err.message !== '') parts.push(err.message)
  if (record.data !== undefined) {
    try {
      parts.push(`data=${JSON.stringify(record.data)}`)
    } catch {
      parts.push('data=<unserializable>')
    }
  }
  if (parts.length === 0) {
    try {
      return JSON.stringify(err)
    } catch {
      return String(err)
    }
  }
  return parts.join(' ')
}

export function decidePermission(
  subject: string,
  options: readonly PermissionOptionLike[],
  permitted: ReadonlySet<string>,
): PermissionDecision {
  const wanted = permitted.has(subject)
    ? ['allow_once', 'allow_always']
    : ['reject_once', 'reject_always']
  const option = options.find((candidate) => wanted.includes(candidate.kind))
  if (!option) {
    return { outcome: 'cancelled' }
  }
  return { outcome: 'selected', optionId: option.optionId }
}

export interface AcpTurnObservation {
  /** Number of session/update notifications observed. */
  updates: number
  /** Tool names the agent invoked, in first-call order. */
  toolNames: string[]
  stopReason: string
  /**
   * `session/prompt` 的失败原因（若失败）。
   *
   * 这个字段存在的理由是一次真实故障：prompt 的 rejection 曾被直接丢弃，turn 只留下
   * 一个 `cancelled`，而 Harness 侧 stderr 是空的（错误走的是 JSON-RPC 而不是 stderr），
   * 于是失败完全无法诊断。协议错误必须带出来。
   */
  promptError: string | null
}

export interface AcpTurnResult extends AcpTurnObservation {
  ok: boolean
}

/**
 * Run exactly one prompt turn against a freshly started ACP process.
 *
 * The returned promise settles when the turn stops. Cancellation via `signal`
 * sends `session/cancel` and then closes the session, matching the protocol's
 * requirement that late updates remain acceptable.
 */
export async function runSingleAcpTurn(
  options: AcpSessionOptions,
  prompt: string,
  signal: AbortSignal,
): Promise<AcpTurnResult> {
  const permitted = new Set(options.permittedTools ?? DEFAULT_PERMITTED_TOOLS)

  // Deny by default. Without a handler the agent's permission request fails and
  // the turn silently reports "cancelled", which is indistinguishable from a
  // real cancellation, so the decision is made here explicitly.
  const app = client({ name: options.clientName ?? 'code-review-worker' }).onRequest(
    methods.client.session.requestPermission,
    ({ params }) => ({
      outcome: decidePermission(
        permissionSubject(params.toolCall),
        params.options,
        permitted,
      ) as never,
    }),
  )

  const stream = ndJsonStream(
    Writable.toWeb(options.process.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(options.process.stdout) as ReadableStream<Uint8Array>,
  )

  return app.connectWith(stream, async (ctx) => {
    await ctx.request(methods.agent.initialize, {
      protocolVersion: 1,
      clientCapabilities: {
        // The agent gets no filesystem and no terminal from this client.
        fs: { readTextFile: false, writeTextFile: false },
      },
    })

    let builder = ctx.buildSession(options.cwd)
    for (const server of options.mcpServers ?? []) {
      builder = builder.withMcpServer(server as never)
    }

    return builder.withSession(async (session) => {
      const toolNames: string[] = []
      let updates = 0

      const onCancel = () => {
        void ctx
          .notify(methods.agent.session.cancel, { sessionId: session.sessionId })
          .catch(() => undefined)
      }
      if (signal.aborted) onCancel()
      signal.addEventListener('abort', onCancel, { once: true })

      // prompt 与 update 循环必须并行推进（prompt 在 turn 结束前不会 settle），
      // 但它的失败原因不能丢：记下来，随 turn 结果一起返回。
      let promptError: string | null = null
      const promptSettled = session.prompt(prompt).then(
        () => undefined,
        (err: unknown) => {
          promptError = describeProtocolError(err)
        },
      )

      try {
        for (;;) {
          const message = await session.nextUpdate()
          if (message.kind === 'stop') {
            // 让已经 settle 的 prompt 有机会把错误写进 promptError，
            // 但不等待未完成的 prompt，避免在这里挂住。
            await Promise.race([promptSettled, Promise.resolve()])
            return {
              ok: message.stopReason === 'end_turn',
              stopReason: message.stopReason,
              updates,
              toolNames,
              promptError,
            }
          }
          updates++
          const update = message.update as { sessionUpdate?: string; title?: string; toolName?: string }
          if (update.sessionUpdate === 'tool_call') {
            const name = update.toolName ?? update.title
            if (name) {
              // 逐次上报，而不是只在 turn 正常结束时返回：turn 抛错（例如预算耗尽）
              // 时这份观测同样需要，否则无法区分"模型没调用提交工具"和
              // "调用了但没到达 Worker"。
              options.onToolCall?.(name)
              if (!toolNames.includes(name)) toolNames.push(name)
            }
          }
        }
      } finally {
        signal.removeEventListener('abort', onCancel)
        await ctx
          .request(methods.agent.session.close, { sessionId: session.sessionId })
          .catch(() => undefined)
      }
    })
  })
}
