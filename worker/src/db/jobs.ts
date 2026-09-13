/**
 * Typed adapter for the platform's single DeepSeek Harness worker RPC surface.
 * Every RPC is service-role only; claim tokens protect task-scoped operations.
 */

import type { BranchName, RepositoryName } from '../git/repositories.js'
import type { DbClient } from './client.js'
import type {
  RuntimeEventBatchResult,
  RuntimeEventTarget,
  RuntimeEventWire,
} from '../monitoring/runtime-event-types.js'

export interface ModelSnapshot {
  model_config_id: string
  display_name: string
  base_url: string
  model_name: string
  max_parallel_tasks?: number
  request_timeout_ms?: number
  context_window?: number
  max_output_tokens?: number
  agent_max_model_requests?: number
  agent_max_retry_requests?: number
  agent_max_compaction_requests?: number
}

export interface JobContext {
  id: string
  batch_id: string
  model_config_id: string
  requested_branch: BranchName
  total_stories: number
}

export interface RepositorySnapshot {
  repository_name: RepositoryName
  requested_branch: BranchName
  commit_sha: string
  commit_subject: string | null
}

export interface RepositorySnapshotInput {
  repository_name: RepositoryName
  requested_branch: BranchName
  commit_sha: string
  commit_subject: string | null
}

export interface StoryFields {
  story_id: string
  story_code: string
  story_name: string
  description: string | null
  acceptance_criteria: string | null
  project_name: string | null
  application_name: string | null
  source_data: Record<string, unknown>
}

/** One atomically claimed Agent task. The plaintext claim token exists only in memory. */
export interface StoryTask {
  id: string
  job_id: string
  worker_id: string
  lease_expires_at: string | null
  agent_status: string
  agent_attempt: number
  claim_token: string
  /** V4 冻结的能力策略 snapshot。在途旧 Job 可能为空对象。 */
  capability_policy: Record<string, unknown>
  policy_version: number
  policy_hash: string | null
  /** Job 创建时冻结的 Harness 版本与完整 manifest 哈希。 */
  harness_version?: string | null
  capability_contract_hash?: string | null
  agent_run_id: string | null
  /** fencing token：按 task 全局单调。 */
  session_revision: number
  job: JobContext
  model: ModelSnapshot
  snapshots: RepositorySnapshot[]
  story: StoryFields
  story_id: string
  story_code: string
  story_name: string
  description: string | null
  acceptance_criteria: string | null
  project_name: string | null
  application_name: string | null
  source_data: Record<string, unknown>
}

export interface PreparationClaim {
  job: JobContext
  model: ModelSnapshot
}

export interface FinalizationClaim {
  job: JobContext
  model: ModelSnapshot
  snapshots: RepositorySnapshot[]
}

export interface VerifiedEvidenceRecord {
  evidence_id: string
  repository_name: RepositoryName
  commit_sha: string
  file_path: string
  start_line: number
  end_line: number
  evidence_type: string
  description: string
}

export interface CompletedStoryTask {
  id: string
  job_id: string
  story_id: string
  story_code: string
  agent_status: string
  output: Record<string, unknown> | null
  verified_evidence: VerifiedEvidenceRecord[]
}

/**
 * Worker 观测到的 attempt 元数据：真实用量 + V4 身份。
 *
 * 身份字段和用量放在同一个 envelope 里，是因为它们的可信来源相同 —— 都由 Worker 观测，
 * 都不来自模型自报。`save_agent_review_result` 用它们做 root-only 与 fencing 校验。
 */
export interface AgentRunUsage {
  tool_calls: number
  evidence_shown: number
  searches_run: number
  retry_requests: number
  compaction_requests: number
  /** 真实模型请求数（governor 在调用 provider 之前预留的计数）。 */
  model_requests?: number
  root_model_requests?: number
  child_model_requests?: number
  web_requests?: number
  web_bytes?: number
  input_tokens?: number | null
  output_tokens?: number | null
  root_agent_id?: string
  root_session_id?: string
  tree_digest?: string
  session_revision?: number
  policy_hash?: string
}

/** 一次工具调用的安全元数据。不含 prompt、源码和工具正文。 */
export interface ToolAuditRow {
  agentId: string
  sessionId: string | null
  toolCallId: string | null
  toolName: string
  permissionVerdict: 'ALLOW' | 'DENY' | 'CANCELLED'
  errorCode: string | null
  startedAt: string
  finishedAt: string
  durationMs: number
  requestBytes: number
  responseBytes: number
}

export interface PermissionDecisionRow {
  agentId: string
  agentRole: string
  toolName: string
  policyLayer: string
  decision: 'ALLOW' | 'DENY'
  reasonCode: string
}

/** 一次 attempt 的租约与取消状态。心跳一次往返同时拿到两者。 */
export interface AttemptControlState {
  leaseHeld: boolean
  cancelRequested: boolean
  cancelReason: string | null
  sealed: boolean
  sessionRevision: number
}

/** claim 凭据。V4 的每个治理 RPC 都要出示它。 */
interface AttemptClaim {
  taskId: string
  workerId: string
  claimToken: string
  agentAttempt: number
}

export interface AgentReviewCommitReceipt {
  run_id: string
  committed_at: string
}

export function unwrapMaybeObject<T>(data: unknown): T | null {
  if (data === null || data === undefined) return null
  if (Array.isArray(data)) return data.length > 0 ? (data[0] as T) : null
  return data as T
}

export function unwrapArray<T>(data: unknown): T[] {
  if (data === null || data === undefined) return []
  if (Array.isArray(data)) return data as T[]
  return [data as T]
}

function toStoryTask(raw: Record<string, unknown>): StoryTask {
  const story = (raw.story ?? {}) as Partial<StoryFields>
  const job = raw.job as JobContext | undefined
  const claimToken = raw.claim_token
  if (typeof claimToken !== 'string' || claimToken.length === 0) {
    throw new Error('claim_next_story_task returned no claim token')
  }

  return {
    id: String(raw.id),
    job_id: String(raw.job_id ?? job?.id ?? ''),
    worker_id: String(raw.worker_id ?? ''),
    lease_expires_at: (raw.lease_expires_at as string | null) ?? null,
    agent_status: String(raw.agent_status ?? 'PENDING'),
    agent_attempt: Number(raw.agent_attempt ?? 0),
    claim_token: claimToken,
    capability_policy: (raw.capability_policy as Record<string, unknown>) ?? {},
    policy_version: Number(raw.policy_version ?? 4),
    policy_hash: (raw.policy_hash as string | null) ?? null,
    harness_version: (raw.harness_version as string | null) ?? null,
    capability_contract_hash: (raw.capability_contract_hash as string | null) ?? null,
    agent_run_id: (raw.agent_run_id as string | null) ?? null,
    session_revision: Number(raw.session_revision ?? 1),
    job: raw.job as JobContext,
    model: raw.model as ModelSnapshot,
    snapshots: unwrapArray<RepositorySnapshot>(raw.snapshots),
    story: story as StoryFields,
    story_id: String(story.story_id ?? raw.story_id ?? ''),
    story_code: String(story.story_code ?? raw.story_code ?? ''),
    story_name: String(story.story_name ?? raw.story_name ?? ''),
    description: story.description ?? (raw.description as string | null) ?? null,
    acceptance_criteria:
      story.acceptance_criteria ?? (raw.acceptance_criteria as string | null) ?? null,
    project_name: story.project_name ?? (raw.project_name as string | null) ?? null,
    application_name:
      story.application_name ?? (raw.application_name as string | null) ?? null,
    source_data: story.source_data ?? (raw.source_data as Record<string, unknown>) ?? {},
  }
}

export class JobsDb {
  constructor(private db: DbClient) {}

  async claimJobForPreparation(workerId: string): Promise<PreparationClaim | null> {
    const data = await this.db.rpc<unknown>('claim_job_for_preparation', {
      p_worker_id: workerId,
    })
    const obj = unwrapMaybeObject<Record<string, unknown>>(data)
    if (!obj?.job) return null
    return { job: obj.job as JobContext, model: obj.model as ModelSnapshot }
  }

  saveRepositorySnapshots(
    jobId: string,
    workerId: string,
    snapshots: RepositorySnapshotInput[],
  ): Promise<void> {
    return this.db.rpc<void>('save_repository_snapshots', {
      p_job_id: jobId,
      p_worker_id: workerId,
      p_snapshots: snapshots,
    })
  }

  /** Requeue Agent leases whose owner has missed the Worker heartbeat window. */
  async reclaimStaleStoryTaskLeases(): Promise<number> {
    const data = await this.db.rpc<number>('reclaim_stale_story_task_leases', {})
    return typeof data === 'number' ? data : 0
  }

  async claimNextStoryTask(workerId: string, leaseSeconds: number): Promise<StoryTask | null> {
    const data = await this.db.rpc<unknown>('claim_next_story_task', {
      p_worker_id: workerId,
      p_lease_seconds: leaseSeconds,
    })
    const obj = unwrapMaybeObject<Record<string, unknown>>(data)
    if (!obj?.id) return null
    return toStoryTask(obj)
  }

  async claimJobForFinalization(workerId: string): Promise<FinalizationClaim | null> {
    const data = await this.db.rpc<unknown>('claim_job_for_finalization', {
      p_worker_id: workerId,
    })
    const obj = unwrapMaybeObject<Record<string, unknown>>(data)
    if (!obj?.job) return null
    return {
      job: obj.job as JobContext,
      model: obj.model as ModelSnapshot,
      snapshots: unwrapArray<RepositorySnapshot>(obj.snapshots),
    }
  }

  /**
   * 续租并读取取消状态。
   *
   * 走 `heartbeat_analysis_attempt` 而不是 V3 的 boolean 版本：用户取消必须在同一次往返里
   * 到达 Worker，否则级联停止要等到下一个轮询周期。
   */
  async heartbeatAttempt(input: {
    taskId: string
    workerId: string
    claimToken: string
    leaseSeconds: number
  }): Promise<AttemptControlState> {
    const data = await this.db.rpc<unknown>('heartbeat_analysis_attempt', {
      p_task_id: input.taskId,
      p_worker_id: input.workerId,
      p_claim_token: input.claimToken,
      p_lease_seconds: input.leaseSeconds,
    })
    const state = unwrapMaybeObject<Record<string, unknown>>(data)
    return {
      leaseHeld: state?.lease_held === true,
      cancelRequested: state?.cancel_requested === true,
      cancelReason: (state?.cancel_reason as string | null) ?? null,
      sealed: state?.sealed === true,
      sessionRevision: Number(state?.session_revision ?? 0),
    }
  }

  async heartbeatStoryTask(input: {
    taskId: string
    workerId: string
    claimToken: string
    leaseSeconds: number
  }): Promise<boolean> {
    const state = await this.heartbeatAttempt(input)
    return state.leaseHeld
  }

  /** 注册一个 Agent Tree 节点。数据库是可信 lineage 的最终仲裁。 */
  async registerAgentNode(
    input: AttemptClaim & {
      agentId: string
      sessionId: string
      parentAgentId: string | null
      agentRole: string
      provider: string
      toolPolicyHash: string
    },
  ): Promise<void> {
    await this.db.rpc<unknown>('register_analysis_agent_node', {
      p_task_id: input.taskId,
      p_worker_id: input.workerId,
      p_claim_token: input.claimToken,
      p_agent_attempt: input.agentAttempt,
      p_agent_id: input.agentId,
      p_session_id: input.sessionId,
      p_parent_agent_id: input.parentAgentId,
      p_agent_role: input.agentRole,
      p_provider: input.provider,
      p_tool_policy_hash: input.toolPolicyHash,
    })
  }

  async markAgentNodeTerminal(
    input: AttemptClaim & { agentId: string; status: string; errorCode?: string },
  ): Promise<void> {
    await this.db.rpc<boolean>('mark_analysis_agent_node_terminal', {
      p_task_id: input.taskId,
      p_worker_id: input.workerId,
      p_claim_token: input.claimToken,
      p_agent_attempt: input.agentAttempt,
      p_agent_id: input.agentId,
      p_status: input.status,
      p_error_code: input.errorCode ?? null,
    })
  }

  async appendToolAudit(
    input: AttemptClaim & {
      entries: ToolAuditRow[]
      decisions: PermissionDecisionRow[]
    },
  ): Promise<void> {
    if (input.entries.length === 0 && input.decisions.length === 0) return
    await this.db.rpc<number>('append_analysis_tool_audit', {
      p_task_id: input.taskId,
      p_worker_id: input.workerId,
      p_claim_token: input.claimToken,
      p_agent_attempt: input.agentAttempt,
      p_entries: input.entries.map((entry) => ({
        agent_id: entry.agentId,
        session_id: entry.sessionId,
        tool_call_id: entry.toolCallId,
        tool_name: entry.toolName,
        permission_verdict: entry.permissionVerdict,
        error_code: entry.errorCode,
        started_at: entry.startedAt,
        finished_at: entry.finishedAt,
        duration_ms: entry.durationMs,
        request_bytes: entry.requestBytes,
        response_bytes: entry.responseBytes,
      })),
      p_decisions: input.decisions.map((decision) => ({
        agent_id: decision.agentId,
        agent_role: decision.agentRole,
        tool_name: decision.toolName,
        policy_layer: decision.policyLayer,
        decision: decision.decision,
        reason_code: decision.reasonCode,
      })),
    })
  }

  async saveArtifact(
    input: AttemptClaim & {
      producerAgentId: string
      artifactType: string
      workspacePath: string
      contentHash: string
      sizeBytes: number
    },
  ): Promise<{ artifactId: string }> {
    const data = await this.db.rpc<unknown>('save_analysis_artifact', {
      p_task_id: input.taskId,
      p_worker_id: input.workerId,
      p_claim_token: input.claimToken,
      p_agent_attempt: input.agentAttempt,
      p_producer_agent_id: input.producerAgentId,
      p_artifact_type: input.artifactType,
      p_workspace_path: input.workspacePath,
      p_content_hash: input.contentHash,
      p_size_bytes: input.sizeBytes,
      p_storage_locator: null,
    })
    const row = unwrapMaybeObject<{ artifact_id: string }>(data)
    return { artifactId: row?.artifact_id ?? '' }
  }

  async saveSessionCheckpoint(
    input: AttemptClaim & {
      sessionId: string
      sessionRevision: number
      storageLocator: string
      contentHash: string
      eventCount: number
      harnessVersion: string
      profileHash: string | null
    },
  ): Promise<void> {
    await this.db.rpc<unknown>('save_analysis_session_checkpoint', {
      p_task_id: input.taskId,
      p_worker_id: input.workerId,
      p_claim_token: input.claimToken,
      p_agent_attempt: input.agentAttempt,
      p_session_id: input.sessionId,
      p_session_revision: input.sessionRevision,
      p_storage_locator: input.storageLocator,
      p_content_hash: input.contentHash,
      p_event_count: input.eventCount,
      p_harness_version: input.harnessVersion,
      p_profile_hash: input.profileHash,
      p_status: 'OPEN',
    })
  }

  /** 找回一个可恢复的 attempt。返回 null 表示不可恢复（已提交、已封存或无 checkpoint）。 */
  async loadResumableAttempt(input: {
    taskId: string
    workerId: string
    claimToken: string
  }): Promise<Record<string, unknown> | null> {
    const data = await this.db.rpc<unknown>('load_resumable_analysis_attempt', {
      p_task_id: input.taskId,
      p_worker_id: input.workerId,
      p_claim_token: input.claimToken,
    })
    return unwrapMaybeObject<Record<string, unknown>>(data)
  }

  async recordAttemptProfile(
    input: AttemptClaim & {
      harnessVersion: string
      capabilityContractHash: string
      profileHash: string
      policyHash: string
      rootAgentId: string
      rootSessionId: string
      treeDigest: string
    },
  ): Promise<void> {
    await this.db.rpc<boolean>('record_analysis_attempt_profile', {
      p_task_id: input.taskId,
      p_worker_id: input.workerId,
      p_claim_token: input.claimToken,
      p_agent_attempt: input.agentAttempt,
      p_harness_version: input.harnessVersion,
      p_capability_contract_hash: input.capabilityContractHash,
      p_profile_hash: input.profileHash,
      p_policy_hash: input.policyHash,
      p_root_agent_id: input.rootAgentId,
      p_root_session_id: input.rootSessionId,
      p_tree_digest: input.treeDigest,
    })
  }

  /** 请求取消一个 attempt（运维熔断路径；用户取消由前端调用同一个 RPC）。 */
  async requestAttemptCancel(taskId: string, reason: string): Promise<boolean> {
    const ok = await this.db.rpc<boolean>('request_analysis_attempt_cancel', {
      p_task_id: taskId,
      p_reason: reason,
    })
    return ok === true
  }

  /**
   * 在数据库侧预留一次模型请求。
   *
   * 内存里的 `HierarchicalBudgetLedger` 是本 attempt 的权威闸门（同步、无往返，能在 provider
   * 调用前原子拦截）；这个 RPC 是第二道：它按 claim token 与租约校验调用方，所以一个已经
   * 被接管的旧 Worker 的预留会失败 —— 这正是"迟到的 usage 不能算进新 attempt"所需的
   * fencing，同时把分层计数落成可查询的真实值。
   */
  async reserveAgentBudget(
    input: AttemptClaim & { agentId: string; kind: string; count?: number },
  ): Promise<{ allowed: boolean; scope: string | null }> {
    const row = await this.db.rpc<{ allowed?: boolean; scope?: string } | null>(
      'reserve_analysis_agent_budget',
      {
        p_task_id: input.taskId,
        p_worker_id: input.workerId,
        p_claim_token: input.claimToken,
        p_agent_attempt: input.agentAttempt,
        p_agent_id: input.agentId,
        p_kind: input.kind,
        p_count: input.count ?? 1,
      },
    )
    return { allowed: row?.allowed === true, scope: row?.scope ?? null }
  }

  /**
   * 落真实 usage。
   *
   * 在**每条**终态路径上调用，不只是提交成功那条：失败、取消、预算耗尽的 attempt 同样烧了
   * 模型请求和 token，如果只在 `save_agent_review_result` 里带 usage，这些花费在库里就是 0，
   * 成本告警和配额核对都会失真。RPC 用 `greatest(...)` 单调更新，重复调用安全。
   */
  async commitAgentUsage(
    input: AttemptClaim & {
      usage: Record<string, number | null>
      perAgent: Array<Record<string, string | number | null>>
    },
  ): Promise<boolean> {
    const ok = await this.db.rpc<boolean>('commit_analysis_agent_usage', {
      p_task_id: input.taskId,
      p_worker_id: input.workerId,
      p_claim_token: input.claimToken,
      p_agent_attempt: input.agentAttempt,
      p_usage: input.usage,
      p_per_agent: input.perAgent,
    })
    return ok === true
  }

  heartbeatAnalysisWorker(input: {
    workerId: string
    slots: number
    current: number
    capabilities?: Record<string, unknown>
    signal?: AbortSignal
  }): Promise<void> {
    return this.db.rpc<void>(
      'heartbeat_analysis_worker',
      {
        p_worker_id: input.workerId,
        p_slots: input.slots,
        p_current: input.current,
        p_capabilities: input.capabilities ?? {},
      },
      { signal: input.signal },
    )
  }

  async releaseStoryTaskClaim(input: {
    taskId: string
    workerId: string
    claimToken: string
  }): Promise<boolean> {
    const released = await this.db.rpc<boolean>('release_story_task_claim', {
      p_task_id: input.taskId,
      p_worker_id: input.workerId,
      p_claim_token: input.claimToken,
    })
    return released === true
  }

  getModelSecretForStoryTask(input: {
    taskId: string
    workerId: string
    claimToken: string
  }): Promise<string> {
    return this.db.rpc<string>('get_model_secret_for_story_task', {
      p_task_id: input.taskId,
      p_worker_id: input.workerId,
      p_claim_token: input.claimToken,
    })
  }

  async saveAgentReviewResult(input: {
    taskId: string
    workerId: string
    claimToken: string
    agentAttempt: number
    result: Record<string, unknown>
    evidence: unknown[]
    usage: AgentRunUsage
    configHash: string | null
    promptVersion: string | null
    modelLabel: string | null
  }): Promise<AgentReviewCommitReceipt> {
    const data = await this.db.rpc<unknown>('save_agent_review_result', {
      p_task_id: input.taskId,
      p_worker_id: input.workerId,
      p_claim_token: input.claimToken,
      p_agent_attempt: input.agentAttempt,
      p_result: input.result,
      p_evidence: input.evidence,
      p_usage: input.usage,
      p_config_hash: input.configHash,
      p_prompt_version: input.promptVersion,
      p_model_label: input.modelLabel,
    })
    const receipt = unwrapMaybeObject<AgentReviewCommitReceipt>(data)
    if (!receipt?.run_id) throw new Error('save_agent_review_result returned no receipt')
    return receipt
  }

  failAgentReview(input: {
    taskId: string
    workerId: string
    claimToken: string
    code: string
    message: string
  }): Promise<void> {
    return this.db.rpc<void>('fail_agent_review', {
      p_task_id: input.taskId,
      p_worker_id: input.workerId,
      p_claim_token: input.claimToken,
      p_error_code: input.code,
      p_error_message: input.message,
    })
  }

  async listCompletedStoryTasks(jobId: string): Promise<CompletedStoryTask[]> {
    const data = await this.db.rpc<unknown>('list_completed_story_tasks', {
      p_job_id: jobId,
    })
    return unwrapArray<CompletedStoryTask>(data)
  }

  completeAnalysisJob(input: {
    jobId: string
    workerId: string
    results: unknown[]
    evidence: unknown[]
  }): Promise<void> {
    return this.db.rpc<void>('complete_analysis_job', {
      p_job_id: input.jobId,
      p_worker_id: input.workerId,
      p_results: input.results,
      p_evidence: input.evidence,
    })
  }

  failClaimedAnalysisJob(input: {
    jobId: string
    workerId: string
    code: string
    message: string
  }): Promise<void> {
    return this.db.rpc<void>('fail_claimed_analysis_job', {
      p_job_id: input.jobId,
      p_worker_id: input.workerId,
      p_error_code: input.code,
      p_error_message: input.message,
    })
  }

  /**
   * 一次往返写多条运行监控事件（0032 §6.6）。
   *
   * fencing 分层由数据库负责：无 task 的 JOB 阶段看 `analysis_job.worker_id` /
   * `finalizer_worker_id` + lease，task 及以下看四要素，收敛路径（claim 已被清空）
   * 看 `session_revision`。这里只负责把上下文原样传过去 —— 客户端不做任何"校验不了
   * 就放行"的兜底。
   */
  async reportRuntimeEventBatch(
    input: RuntimeEventTarget & { events: RuntimeEventWire[] },
  ): Promise<RuntimeEventBatchResult> {
    const data = await this.db.rpc<unknown>('report_analysis_runtime_event_batch', {
      p_worker_id: input.workerId,
      p_job_id: input.jobId,
      p_task_id: input.taskId ?? null,
      p_claim_token: input.claimToken ?? null,
      p_agent_attempt: input.agentAttempt ?? null,
      p_events: input.events,
      p_session_revision: input.sessionRevision ?? null,
    })
    const row = unwrapMaybeObject<Partial<RuntimeEventBatchResult>>(data)
    return {
      accepted: Number(row?.accepted ?? 0),
      duplicated: Number(row?.duplicated ?? 0),
      dropped_unresolved_agent: Number(row?.dropped_unresolved_agent ?? 0),
      dropped_invalid: Number(row?.dropped_invalid ?? 0),
      max_event_id:
        row?.max_event_id === null || row?.max_event_id === undefined
          ? null
          : Number(row.max_event_id),
    }
  }

  /**
   * 保留期清理。按批限量：一次删太多会持有长事务，把 §6.1.3 的游标水位卡住。
   * 汇总表 `analysis_agent_run_rollup` 不参与清理。
   */
  async purgeRuntimeEvents(limit = 50000): Promise<number> {
    const data = await this.db.rpc<number>('purge_analysis_runtime_events', {
      p_limit: limit,
    })
    return typeof data === 'number' ? data : 0
  }


  /** Attempt 事件已经收敛后，按 run 精确重算长期 rollup。 */
  async computeRunRollup(agentRunId: string): Promise<void> {
    await this.db.rpc<unknown>('compute_analysis_run_rollup', {
      p_agent_run_id: agentRunId,
    })
  }
  /** 补算终态但汇总缺失（或 `rollup_version = 0`）的 attempt。 */
  async backfillRunRollups(limit = 200): Promise<{ computed: number; failed: number }> {
    const data = await this.db.rpc<unknown>('backfill_analysis_run_rollups', {
      p_limit: limit,
    })
    const row = unwrapMaybeObject<{ computed?: number; failed?: number }>(data)
    return { computed: Number(row?.computed ?? 0), failed: Number(row?.failed ?? 0) }
  }
}
