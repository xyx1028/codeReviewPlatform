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
  /** 每一次 permission 判定的观测点，用于审计与诊断。 */
  onPermissionDecision?: (decision: {
    toolName: string
    allowed: boolean
    outcome: string
  }) => void
  /**
   * Session 一建立（或一恢复）就回调，**在 turn 结束之前**。
   *
   * 这个回调存在的理由很具体：checkpoint 原来只在 `session/prompt` 返回之后才写，而一次
   * turn 要跑 20~40 分钟。容器在这期间被重建时那次 turn 永远不返回，于是 checkpoint 永远
   * 不写 —— 云端库里整张 analysis_session_checkpoint 只有 1 行就是这么来的，而 Session 卷
   * 上已经有 400 多个 attempt 目录。拿到 session id 才能定位磁盘上的 JSONL 并周期落盘。
   */
  onSessionCreated?: (sessionId: string, resumed: boolean) => void
  /**
   * 复用一个已存在的 Session 而不是新建。
   *
   * V3 每次只 `session/new`，所以 Worker 重启后必然从零开始。给定 sessionId 时改走
   * reopen/resume，Harness 从持久卷上的 JSONL 恢复历史。
   */
  resumeSessionId?: string
}

const DEFAULT_PERMITTED_TOOLS = ['submit_review_result']

/**
 * Names a permission request may carry for the tool being approved.
 *
 * ACP 的 permission 请求可能带 `toolName`（工具的注册名）或只带 `title`（给人看的标题）。
 * V3 只看 title，于是"固定五个工具"能对上；V4 的工具面来自角色策略，标题和注册名未必一致，
 * 所以优先用 `toolName`，title 只作回退。看错字段的后果是静默拒绝一个本该允许的工具，
 * 而那在 turn 里表现为无来由的 cancelled。
 */
function permissionSubject(toolCall: { title?: string | null; toolName?: string | null }): string {
  return toolCall.toolName ?? toolCall.title ?? ''
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
  /** 本次 turn 使用的 Session id。恢复场景下等于传入的 resumeSessionId。 */
  sessionId: string
  /** 是否走了 resume/load 而不是 session/new。 */
  resumed: boolean
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
 *
 * V4 增加了 resume：给定 `resumeSessionId` 时先尝试 `session/resume`（不重放历史）或
 * `session/load`（重放历史），只有 agent 声明了对应能力才走这条路。声明缺失时不静默降级到
 * `session/new` —— 那会让 Worker 重启后"看起来恢复了"其实从零开始，比明确失败更糟。
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
    ({ params }) => {
      const subject = permissionSubject(params.toolCall)
      const decision = decidePermission(subject, params.options, permitted)
      // 每一次判定都上报：默认 deny 的策略下，"为什么这个工具没被调用"是最常见的问题，
      // 而没有这条记录就只能靠猜。工具名和判定结果都不含源码，可以安全记录。
      options.onPermissionDecision?.({
        toolName: subject,
        allowed: permitted.has(subject),
        outcome: decision.outcome,
      })
      return { outcome: decision as never }
    },
  )

  // 恢复路径要自己消费 `session/update`：它不走 SDK 的 buildSession，没人替它收通知。
  // 只在恢复时注册，避免与 builder 内部的通知消费打架。
  const resumeCollected = { updates: 0, toolNames: [] as string[] }
  const appWithHandlers =
    options.resumeSessionId === undefined
      ? app
      : app.onNotification(methods.client.session.update, ({ params }) => {
          const notification = params as {
            sessionId?: string
            update?: { sessionUpdate?: string; title?: string; toolName?: string }
          }
          if (notification.sessionId !== options.resumeSessionId) return
          resumeCollected.updates++
          const update = notification.update ?? {}
          if (update.sessionUpdate === 'tool_call') {
            const name = update.toolName ?? update.title
            if (name) {
              options.onToolCall?.(name)
              if (!resumeCollected.toolNames.includes(name)) resumeCollected.toolNames.push(name)
            }
          }
        })

  const stream = ndJsonStream(
    Writable.toWeb(options.process.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(options.process.stdout) as ReadableStream<Uint8Array>,
  )

  return appWithHandlers.connectWith(stream, async (ctx) => {
    const initialized = (await ctx.request(methods.agent.initialize, {
      protocolVersion: 1,
      clientCapabilities: {
        // The agent gets no filesystem and no terminal from this client: every
        // file effect happens inside the agent's own sandboxed workspace.
        fs: { readTextFile: false, writeTextFile: false },
      },
    })) as { agentCapabilities?: Record<string, unknown> }

    if (options.resumeSessionId !== undefined) {
      return runResumedTurn(
        ctx as unknown as AcpLowLevelContext,
        options,
        prompt,
        signal,
        initialized.agentCapabilities ?? {},
        resumeCollected,
      )
    }

    let builder = ctx.buildSession(options.cwd)
    for (const server of options.mcpServers ?? []) {
      builder = builder.withMcpServer(server as never)
    }

    return builder.withSession(async (session) => {
      const toolNames: string[] = []
      let updates = 0

      // Session id 在 turn 开始前就已知：checkpoint 循环靠它定位磁盘上的 JSONL。
      // 放在这里而不是 turn 结束后，正是"被 kill 时也有 checkpoint"的前提。
      try {
        options.onSessionCreated?.(session.sessionId, false)
      } catch {
        // 观测回调绝不影响 turn。
      }

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
              sessionId: session.sessionId,
              resumed: false,
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

/**
 * 在一个已存在的 Session 上继续。
 *
 * 用低层 `onNotification` + 原始 `session/prompt` 而不是 `buildSession`：builder 只会发
 * `session/new`，而这里的整个目的就是不新建。
 */
async function runResumedTurn(
  // 低层 ClientContext。这里刻意用结构类型而不是 SDK 的 ClientContext：resume 走的是
  // 原始方法名，SDK 的重载签名对动态方法名不友好，而这三个能力就是我们全部需要的。
  ctx: AcpLowLevelContext,
  options: AcpSessionOptions,
  prompt: string,
  signal: AbortSignal,
  agentCapabilities: Record<string, unknown>,
  collected: { updates: number; toolNames: string[] },
): Promise<AcpTurnResult> {
  const sessionId = options.resumeSessionId!
  // ACP 的能力约定是**键存在即支持**，值是该能力的选项对象。dsh 实际声明的是
  // `sessionCapabilities: { close: {}, list: {}, resume: {} }` —— 三个都是空对象。
  //
  // 这里曾经写成 `?.resume === true`，于是 `{} === true` 恒为假，平台一直判定"agent 不支持
  // resume"并抛 SessionResumeUnsupportedError。后果是**每一次 Worker 重启都恢复失败**：
  // §7.7 的完成标准"重启后可继续同一未提交 Session"从未成立，整套 JSONL 持久卷、checkpoint、
  // session_revision、fencing 机器从来没有真正恢复过任何会话。实测报错原文：
  //
  //   the agent advertises neither session/resume nor session/load
  //
  // 判定改为"键存在且不是 false/null"：既接受 `{}`（dsh 的写法），也接受 `true`（布尔写法），
  // 而显式 `false` 仍然视为不支持。
  const sessionCapabilities = agentCapabilities.sessionCapabilities as
    | Record<string, unknown>
    | undefined
  const resumeCapability = sessionCapabilities?.resume
  const supportsResume = resumeCapability !== undefined && resumeCapability !== null && resumeCapability !== false
  // `loadSession` 在 ACP 规范里是布尔字段，保持严格判定。
  const supportsLoad = agentCapabilities.loadSession === true
  if (!supportsResume && !supportsLoad) {
    // 明确失败，而不是悄悄新建一个 Session。
    throw new SessionResumeUnsupportedError(
      'the agent advertises neither session/resume nor session/load; this session cannot be continued',
    )
  }

  // `session/update` 的订阅必须发生在 **app 层**、且在 connectWith 之前。
  //
  // 这里原本调的是 `ctx.onNotification(...)` —— 而 SDK 的 ClientContext 只有
  // `buildSession / attachSession / request / notify`，没有 onNotification。恢复路径从来没有
  // 真实跑过，所以这个 API 不存在的错误一直没被发现：实测报 `ctx.onNotification is not a
  // function`。正常路径不受影响是因为它走 `buildSession().withSession()`，由 SDK 内部消费通知。
  //
  // 收集器由调用方在注册 handler 时创建并传进来，见 runSingleAcpTurn。
  let stopReason: string | null = null
  let resolveStop: () => void = () => undefined
  const stopped = new Promise<void>((resolve) => {
    resolveStop = resolve
  })

  const resumeParams = {
    sessionId,
    cwd: options.cwd,
    ...(options.mcpServers ? { mcpServers: options.mcpServers } : {}),
  }
  // resume 优先：它不重放历史，因此不会重复触发已经发生过的副作用。
  await ctx.request(
    (supportsResume ? methods.agent.session.resume : methods.agent.session.load) as never,
    resumeParams as never,
  )

  const onCancel = () => {
    void ctx.notify(methods.agent.session.cancel as never, { sessionId } as never).catch(() => undefined)
  }
  if (signal.aborted) onCancel()
  signal.addEventListener('abort', onCancel, { once: true })

  // 恢复成功：同样在 turn 之前把 session id 交给调用方，让 checkpoint 循环接着写。
  try {
    options.onSessionCreated?.(sessionId, true)
  } catch {
    // 观测回调绝不影响 turn。
  }

  let promptError: string | null = null
  try {
    const response = (await ctx.request(methods.agent.session.prompt as never, {
      sessionId,
      prompt: [{ type: 'text', text: prompt }],
    } as never)) as { stopReason?: string }
    stopReason = response.stopReason ?? 'end_turn'
    resolveStop()
  } catch (err) {
    promptError = describeProtocolError(err)
    stopReason = 'cancelled'
    resolveStop()
  } finally {
    signal.removeEventListener('abort', onCancel)
    await Promise.race([stopped, Promise.resolve()])
    await ctx
      .request(methods.agent.session.close as never, { sessionId } as never)
      .catch(() => undefined)
  }

  return {
    ok: stopReason === 'end_turn',
    stopReason: stopReason ?? 'cancelled',
    updates: collected.updates,
    toolNames: collected.toolNames,
    promptError,
    sessionId,
    resumed: true,
  }
}

/** resume 路径需要的最小 ClientContext 能力面。 */
interface AcpLowLevelContext {
  request(method: never, params: never): Promise<unknown>
  notify(method: never, params: never): Promise<unknown>
}

/** Agent 不支持继续既有 Session。映射到 SESSION_RECOVERY_FAILED。 */
export class SessionResumeUnsupportedError extends Error {
  readonly code = 'SESSION_RECOVERY_FAILED'
  constructor(message: string) {
    super(message)
    this.name = 'SessionResumeUnsupportedError'
  }
}
