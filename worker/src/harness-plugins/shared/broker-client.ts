/**
 * Authenticated local IPC client used by profile-local Harness plugins to
 * reach the Worker's per-attempt control broker.
 *
 * The channel is a Unix domain socket inside a per-attempt 0700 directory.
 * Plugins never hold Supabase credentials, model API keys or snapshot roots;
 * every privileged decision stays in the Worker process behind this channel.
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
