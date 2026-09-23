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

/**
 * Known domain error markers raised by the analysis RPCs.
 *
 * A marker only becomes actionable once it is listed here: normalizeDbErrorCode
 * whole-word matches this list, so a marker the database raises but this array
 * omits degrades into a bare SQLSTATE and the pipeline cannot react to it.
 */
export const KNOWN_DB_ERROR_CODES = [
  'TASK_LEASE_LOST',
  'JOB_LEASE_LOST',
  'MODEL_SECRET_MISSING',
  'MODEL_CONFIG_DISABLED',
  'RESULT_ALREADY_EXISTS',
  'BATCH_BRANCH_CHANGED',
  'EVIDENCE_PATH_INVALID',
  'EVIDENCE_LINE_INVALID',
  'LEGACY_ENGINE_RETIRED',
  'AGENT_CLAIM_INVALID',
  'AGENT_RESULT_ALREADY_COMMITTED',
  'AGENT_IDENTITY_INVALID',
  'AGENT_ROLE_DENIED',
  'SUBMIT_ROOT_ONLY',
  'AGENT_TREE_LIMIT_EXCEEDED',
  'AGENT_TREE_CANCELLED',
  'MODEL_BUDGET_EXHAUSTED',
  'TOOL_BUDGET_EXHAUSTED',
  'WORKSPACE_POLICY_DENIED',
  'WEB_EGRESS_DENIED',
  'SESSION_FENCED',
  'SESSION_FORMAT_UNSUPPORTED',
  'SESSION_RECOVERY_FAILED',
  'EVIDENCE_AGENT_INVALID',
  'EVIDENCE_ORIGIN_INVALID',
  'ATTEMPT_ALREADY_SEALED',
  'PROCESS_TREE_CLEANUP_FAILED',
  // 0032 运行监控台。漏登记会让 Reporter 拿到裸 SQLSTATE，识别不出 fencing 被拒。
  'RUNTIME_EVENT_FENCE_REJECTED',
  'RUNTIME_EVENT_TYPE_UNKNOWN',
  'RUNTIME_EVENT_SCOPE_MISMATCH',
  'RUNTIME_EVENT_PHASE_MISMATCH',
  'RUNTIME_EVENT_CORRELATION_REQUIRED',
  'ROLLUP_RUN_NOT_TERMINAL',
  'TREND_GROUP_BY_REQUIRED',
  'TREND_GROUP_BY_INVALID',
  'TREND_TERMINAL_STATUS_INVALID',
  // 0031 冻结契约。它们由 analysis_job / analysis_agent_run 的 before-insert 触发器抛出，
  // 对 Worker 是"这条写入路径不该走"的明确信号，不是可重试的抖动。
  'V4_HARNESS_MANIFEST_MISSING',
  'V4_CAPABILITY_POLICY_MISSING',
  // V1.6 受管 Skill Bundle。漏登记会让技能供给链的拒绝退化成裸 SQLSTATE，Worker
  // 无从区分"目录超限"（治理问题，需要管理员处理）与"租约丢了"（可重试的接管）。
  'SKILL_CATALOG_LIMIT_EXCEEDED',
  'SKILL_VERSION_IMMUTABLE',
  'SKILL_OBJECT_REFERENCED',
  'SKILL_BUNDLE_INVALID',
  'SKILL_BUNDLE_LIMIT_EXCEEDED',
  'SESSION_SKILL_SET_MISMATCH',
  // V1.11 scope/final/session continuity gates.
  'ANALYSIS_SCOPE_IDENTITY_MISSING',
  'ANALYSIS_SCOPE_IDENTITY_MISMATCH',
  'ANALYSIS_SCOPE_TRIAGE_INCOMPLETE',
  'SESSION_ANALYSIS_SCOPE_MISMATCH',
  'TRIAGE_CONTEXT_MISMATCH',
  // V1.11 **工具级**门禁。这些码由 submit_story_commit_relevance_verdict /
  // record_analysis_scope_expansion / get_story_task_analysis_scope 等 RPC 抛出，
  // 是给模型看的"你这次调用哪里不对"。漏登记的后果在本地全链路实测里很具体
  // （2026-09-23 Job `e55681b7`）：Broker 的 catch 认不出它们，一律记成 `TOOL_FAILED`，
  // 于是审计与监控里"模型没读 diff 就下判定"和"工具崩了"长得一模一样。
  'ANALYSIS_SCOPE_NOT_FROZEN',
  'ANALYSIS_SCOPE_UNAVAILABLE',
  'CANDIDATE_NOT_AI_TRIAGE',
  'CANDIDATE_TASK_MISMATCH',
  'AGENT_RUN_MISMATCH',
  'TRIAGE_VERDICT_INVALID',
  'TRIAGE_VERDICT_CONFLICT',
  'TRIAGE_SUMMARY_INVALID',
  'DIFF_ACCESS_REQUIRED',
  'DIFF_ACCESS_EVIDENCE_INVALID',
  'UNREADABLE_DIFF_REQUIRES_UNCERTAIN',
  'SCOPE_EXPANSION_FROM_MISMATCH',
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
