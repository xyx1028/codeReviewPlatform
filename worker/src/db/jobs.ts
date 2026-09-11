/**
 * Typed adapter for the platform's single DeepSeek Harness worker RPC surface.
 * Every RPC is service-role only; claim tokens protect task-scoped operations.
 */

import type { BranchName, RepositoryName } from '../git/repositories.js'
import type { DbClient } from './client.js'

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

export interface AgentRunUsage {
  tool_calls: number
  evidence_shown: number
  searches_run: number
  retry_requests: number
  compaction_requests: number
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

  async heartbeatStoryTask(input: {
    taskId: string
    workerId: string
    claimToken: string
    leaseSeconds: number
  }): Promise<boolean> {
    const ok = await this.db.rpc<boolean>('heartbeat_story_task', {
      p_task_id: input.taskId,
      p_worker_id: input.workerId,
      p_claim_token: input.claimToken,
      p_lease_seconds: input.leaseSeconds,
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
}
