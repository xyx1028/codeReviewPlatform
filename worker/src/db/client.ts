/**
 * Supabase service-role client. (Plan §7.8, §15.3)
 *
 * Uses the service role key. This client must only run inside the worker; the
 * key never reaches the browser. The client exposes a thin `rpc` wrapper so the
 * db adapters and tests can share one code path.
 *
 * Postgres RAISE EXCEPTION messages arrive on `error.message`; the DB functions
 * raise domain codes as bare strings (e.g. `TASK_LEASE_LOST`). We normalize
 * those known markers into a stable `code` on DbError so the pipeline can react
 * (e.g. abort on a lost lease) without string matching everywhere.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { WorkerConfig } from '../config.js'

export interface RpcOptions {
  signal?: AbortSignal
}

export interface DbClient {
  rpc<T = unknown>(fn: string, params: Record<string, unknown>, options?: RpcOptions): Promise<T>
}

/** Known domain error markers raised by the analysis RPCs. */
export const KNOWN_DB_ERROR_CODES = [
  'TASK_LEASE_LOST',
  'MODEL_SECRET_MISSING',
  'MODEL_CONFIG_DISABLED',
  'RESULT_ALREADY_EXISTS',
  'BATCH_BRANCH_CHANGED',
] as const

export type KnownDbErrorCode = (typeof KNOWN_DB_ERROR_CODES)[number]

/**
 * Extract a normalized error code from a Postgres error. Prefers the SQLSTATE
 * `code` when present; otherwise scans the message text for a known domain
 * marker (the DB functions raise these as the exception message). Returns
 * undefined when nothing recognizable is found.
 */
export function normalizeDbErrorCode(
  message: string | null | undefined,
  sqlState?: string | null,
): string | undefined {
  const text = message ?? ''
  for (const code of KNOWN_DB_ERROR_CODES) {
    // Match as a whole word to avoid accidental substring hits.
    const re = new RegExp(`\\b${code}\\b`)
    if (re.test(text)) return code
  }
  if (sqlState && sqlState.trim() !== '') return sqlState
  return undefined
}

export class SupabaseDbClient implements DbClient {
  private client: SupabaseClient

  constructor(config: Pick<WorkerConfig, 'supabaseUrl' | 'supabaseServiceRoleKey'>) {
    this.client = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
  }

  async rpc<T = unknown>(fn: string, params: Record<string, unknown>, options?: RpcOptions): Promise<T> {
    const request = this.client.rpc(fn, params)
    const { data, error } = await (options?.signal ? request.abortSignal(options.signal) : request)
    if (error) {
      const code = normalizeDbErrorCode(error.message, error.code)
      throw new DbError(`rpc ${fn} failed: ${error.message}`, code)
    }
    return data as T
  }
}

export class DbError extends Error {
  code?: string
  constructor(message: string, code?: string) {
    super(message)
    this.name = 'DbError'
    this.code = code
  }
}
