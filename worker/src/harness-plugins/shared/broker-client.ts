/**
 * Authenticated local IPC client used by profile-local Harness plugins to
 * reach the Worker's per-attempt control broker.
 *
 * The channel is a Unix domain socket inside a per-attempt 0700 directory.
 * Plugins never hold Supabase credentials, model API keys or snapshot roots;
 * every privileged decision stays in the Worker process behind this channel.
 *
 * V4 增加了一层身份：每个请求体除了 attempt 信息，还带调用者的 agent capability。
 * attempt token 走 HTTP header，agent capability 走请求体 —— 两者是不同的东西，混在一起
 * 会让"整个子进程"和"子进程里某个 Agent"变得不可区分。
 */

import { request } from 'node:http'

export interface BrokerChannelOptions {
  /** Absolute path of the per-attempt Unix domain socket. */
  socketPath: string
  /** Per-attempt bearer token minted by the Worker. */
  token: string
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number
}

export interface BrokerResponse<T> {
  status: number
  body: T
}

/** 一次调用的 Agent 身份。由插件从 Harness 的执行上下文取得，不由模型提供。 */
export interface AgentCallIdentity {
  /** 调用者的 capability token。Broker 只按它查身份。 */
  agentCapability: string
  agentId: string
  sessionId: string
  toolCallId?: string
  toolName?: string
}

export class BrokerChannelError extends Error {
  readonly code: string
  readonly status?: number

  constructor(message: string, code: string, status?: number) {
    super(message)
    this.name = 'BrokerChannelError'
    this.code = code
    this.status = status
  }
}

/**
 * POST one JSON envelope to the broker. Rejects on transport failure,
 * timeout, or a non-JSON body; HTTP status is returned to the caller so
 * policy denials can be turned into model-correctable tool errors.
 */
export function brokerPost<T = unknown>(
  options: BrokerChannelOptions,
  path: string,
  payload: unknown,
): Promise<BrokerResponse<T>> {
  const timeoutMs = options.timeoutMs ?? 30000
  const body = Buffer.from(JSON.stringify(payload ?? {}), 'utf8')

  return new Promise<BrokerResponse<T>>((resolve, reject) => {
    const req = request(
      {
        socketPath: options.socketPath,
        path,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': String(body.byteLength),
          authorization: `Bearer ${options.token}`,
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8')
          let parsed: unknown
          try {
            parsed = raw.length > 0 ? JSON.parse(raw) : {}
          } catch {
            reject(
              new BrokerChannelError(
                'broker returned a non-JSON body',
                'BROKER_PROTOCOL_ERROR',
                res.statusCode,
              ),
            )
            return
          }
          resolve({ status: res.statusCode ?? 0, body: parsed as T })
        })
      },
    )

    req.setTimeout(timeoutMs, () => {
      req.destroy(
        new BrokerChannelError(
          `broker request timed out after ${timeoutMs}ms`,
          'BROKER_TIMEOUT',
        ),
      )
    })
    req.on('error', (err) => {
      reject(
        err instanceof BrokerChannelError
          ? err
          : new BrokerChannelError(
              `broker channel failed: ${(err as Error).message}`,
              'BROKER_UNAVAILABLE',
            ),
      )
    })
    req.end(body)
  })
}

/** 组装一个带身份的请求体。 */
export function withIdentity(
  base: { taskId: string; agentAttempt: number },
  identity: AgentCallIdentity,
  payload: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...payload,
    taskId: base.taskId,
    agentAttempt: base.agentAttempt,
    agentCapability: identity.agentCapability,
    agentId: identity.agentId,
    sessionId: identity.sessionId,
    toolCallId: identity.toolCallId ?? null,
    toolName: identity.toolName ?? null,
  }
}
