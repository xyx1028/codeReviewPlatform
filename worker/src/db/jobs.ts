/**
 * Jobs DB adapter. Wraps the analysis RPCs. (Plan §7.6)
 *
 * All of these RPCs are authorized to service_role only. The adapter is a thin,
 * typed layer over DbClient.rpc so the pipeline is decoupled from Supabase and
 * unit tests can inject a fake DbClient.
 *
 * Multi-replica model (this refactor):
 *  - Any worker globally claims individual story tasks from ANY job in
 *    PROCESSING (bounded by its own SlotPool + the model's max_parallel_tasks).
 *  - `claim_next_story_task` returns an ENRICHED payload: the task plus its
 *    job, model snapshot, the four repository snapshots (frozen SHAs) and the
 *    story fields. This lets a replica process a task without ever having
 *    prepared the job itself.
 *  - Finalization is a separate claim (`claim_job_for_finalization`) that any
 *    idle replica may win once every task is fully analyzed, so the last worker
 *    standing can always finish (and take over after a crash).
 *
 * IMPORTANT: These RPCs return jsonb (object or array) — NOT a PostgREST
 * composite/set. Do not assume an array wrapper; `unwrapMaybeArray` tolerates
 * both an object and a single-element array defensively.
 */

import type { DbClient } from './client.js'
import type { BranchName, RepositoryName } from '../git/repositories.js'
import type { RetrievalResult, AnalysisResult } from '../ai/schemas.js'

export interface ModelSnapshot {
  model_config_id: string
  display_name: string
  provider: string
  base_url: string
  model_name: string
  retrieval_prompt_version: string
  analysis_prompt_version: string
  /** Per-model request timeout, resolved from ai_model_config. */
  request_timeout_ms?: number
}

/** The job context carried inside an enriched claim payload. */
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

/** The story fields carried inside an enriched claim payload. */
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

/**
 * Enriched story-task claim. `claim_next_story_task` returns everything a
 * replica needs to process this task in isolation: the task row, its job, the
 * model snapshot (incl. request_timeout_ms), the four repository snapshots, and
 * the story text. `retrieval_output` is present when stage one already
 * succeeded (recovery / takeover case).
 */
export interface StoryTask {
  id: string
  job_id: string
  retrieval_status: string
  analysis_status: string
  lease_expires_at: string | null
  /** Present when stage one already succeeded (recover and skip retrieval). */
  retrieval_output: RetrievalResult | null

  job: JobContext
  model: ModelSnapshot
  snapshots: RepositorySnapshot[]
  story: StoryFields

  // Flattened story convenience fields (kept for prompt building callers).
  story_id: string
  story_code: string
  story_name: string
  description: string | null
  acceptance_criteria: string | null
  project_name: string | null
  application_name: string | null
  source_data: Record<string, unknown>
}

/** Enriched job claim for finalization. */
export interface FinalizationClaim {
  job: JobContext
  model: ModelSnapshot
  snapshots: RepositorySnapshot[]
}

/** A story task as returned by list_analysis_story_tasks_for_worker. */
export interface StoryTaskSummary {
  id: string
  job_id: string
  story_id: string
  story_code: string
  retrieval_status: string
  analysis_status: string
  analysis_output: Record<string, unknown> | null
}

/**
 * Normalize a jsonb RPC result that may arrive as a single object, a
 * single-element array, an empty array, or null. Returns the object or null.
 * PostgREST does NOT always wrap jsonb in an array, so we must not assume it.
 */
export function unwrapMaybeObject<T>(data: unknown): T | null {
  if (data === null || data === undefined) return null
  if (Array.isArray(data)) {
    return (data.length > 0 ? (data[0] as T) : null)
  }
  return data as T
}

/** Normalize a jsonb RPC result into an array (object/array/null tolerant). */
export function unwrapArray<T>(data: unknown): T[] {
  if (data === null || data === undefined) return []
  if (Array.isArray(data)) return data as T[]
  return [data as T]
}

/** Flatten an enriched claim payload into the StoryTask shape. */
function toStoryTask(raw: Record<string, unknown>): StoryTask {
  const story = (raw.story ?? {}) as Partial<StoryFields>
  return {
    id: String(raw.id),
    job_id: String(raw.job_id ?? (raw.job as JobContext | undefined)?.id ?? ''),
    retrieval_status: String(raw.retrieval_status ?? 'PENDING'),
    analysis_status: String(raw.analysis_status ?? 'PENDING'),
    lease_expires_at: (raw.lease_expires_at as string | null) ?? null,
    retrieval_output: (raw.retrieval_output as RetrievalResult | null) ?? null,
    job: raw.job as JobContext,
    model: raw.model as ModelSnapshot,
    snapshots: unwrapArray<RepositorySnapshot>(raw.snapshots),
    story: story as StoryFields,
    story_id: String(story.story_id ?? raw.story_id ?? ''),
    story_code: String(story.story_code ?? raw.story_code ?? ''),
    story_name: String(story.story_name ?? raw.story_name ?? ''),
    description: (story.description ?? (raw.description as string | null) ?? null),
    acceptance_criteria:
      (story.acceptance_criteria ?? (raw.acceptance_criteria as string | null) ?? null),
    project_name: (story.project_name ?? (raw.project_name as string | null) ?? null),
    application_name:
      (story.application_name ?? (raw.application_name as string | null) ?? null),
    source_data: (story.source_data ?? (raw.source_data as Record<string, unknown>) ?? {}),
  }
}

/** Enriched preparation claim: a QUEUED job needing its four repos prepared. */
export interface PreparationClaim {
  job: JobContext
  model: ModelSnapshot
}

export class JobsDb {
  constructor(private db: DbClient) {}

  /**
   * Claim a QUEUED job for code preparation (FOR UPDATE SKIP LOCKED). Returns an
   * enriched jsonb object (job + model) or null. Preparation is decoupled from
   * story processing: once snapshots are saved the job flips to PROCESSING and
   * any replica may pick up its tasks.
   */
  async claimJobForPreparation(workerId: string): Promise<PreparationClaim | null> {
    const data = await this.db.rpc<unknown>('claim_job_for_preparation', {
      p_worker_id: workerId,
    })
    const obj = unwrapMaybeObject<Record<string, unknown>>(data)
    if (!obj || obj.job === undefined || obj.job === null) return null
    return { job: obj.job as JobContext, model: obj.model as ModelSnapshot }
  }

  /** Atomically save the four repository snapshots for a job (flips PROCESSING). */
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

  /**
   * Globally claim the next processable story task with a lease. Returns an
   * enriched payload (job/model/snapshots/story) or null when nothing is
   * claimable for this worker right now. The RPC returns a jsonb object.
   */
  async claimNextStoryTask(
    workerId: string,
    leaseSeconds: number,
  ): Promise<StoryTask | null> {
    const data = await this.db.rpc<unknown>('claim_next_story_task', {
      p_worker_id: workerId,
      p_lease_seconds: leaseSeconds,
    })
    const obj = unwrapMaybeObject<Record<string, unknown>>(data)
    if (!obj || obj.id === undefined || obj.id === null) return null
    return toStoryTask(obj)
  }

  /**
   * Claim a fully-analyzed job for finalization. Any idle replica may win this;
   * the DB enforces a single winner and returns null otherwise. Returns a jsonb
   * object with job/model/snapshots.
   */
  async claimJobForFinalization(workerId: string): Promise<FinalizationClaim | null> {
    const data = await this.db.rpc<unknown>('claim_job_for_finalization', {
      p_worker_id: workerId,
    })
    const obj = unwrapMaybeObject<Record<string, unknown>>(data)
    if (!obj || obj.job === undefined || obj.job === null) return null
    return {
      job: obj.job as JobContext,
      model: obj.model as ModelSnapshot,
      snapshots: unwrapArray<RepositorySnapshot>(obj.snapshots),
    }
  }

  /** Renew the lease for a story task; returns false when the lease is lost. */
  async heartbeatStoryTask(
    taskId: string,
    workerId: string,
    leaseSeconds: number,
  ): Promise<boolean> {
    const ok = await this.db.rpc<boolean>('heartbeat_story_task', {
      p_task_id: taskId,
      p_worker_id: workerId,
      p_lease_seconds: leaseSeconds,
    })
    return ok === true
  }

  /**
   * Report this worker's slot utilization to the coordination table so the
   * dashboard/scheduler can see live capacity. Called once per poll cycle.
   */
  heartbeatAnalysisWorker(
    workerId: string,
    slots: number,
    current: number,
  ): Promise<void> {
    return this.db.rpc<void>('heartbeat_analysis_worker', {
      p_worker_id: workerId,
      p_slots: slots,
      p_current: current,
    })
  }

  /** Persist stage-one retrieval result and progress. */
  saveRetrievalResult(
    taskId: string,
    workerId: string,
    result: RetrievalResult,
    model: string,
    promptVersion: string,
  ): Promise<void> {
    return this.db.rpc<void>('save_retrieval_result', {
      p_task_id: taskId,
      p_worker_id: workerId,
      p_result: result,
      p_retrieval_model: model,
      p_prompt_version: promptVersion,
    })
  }

  /** Persist stage-two analysis result awaiting finalization. */
  saveAnalysisResult(
    taskId: string,
    workerId: string,
    result: AnalysisResult & { evidence: unknown[] },
    model: string,
    promptVersion: string,
  ): Promise<void> {
    return this.db.rpc<void>('save_analysis_result', {
      p_task_id: taskId,
      p_worker_id: workerId,
      p_result: result,
      p_analysis_model: model,
      p_prompt_version: promptVersion,
    })
  }

  /**
   * Mark a story task failed at its current stage. This persists the failure to
   * the DB (never just a log) so the job can surface it and other workers stop
   * retrying the task. `stage` records which phase failed.
   */
  failStoryTask(input: {
    taskId: string
    workerId: string
    stage: 'retrieval' | 'analysis'
    code: string
    message: string
  }): Promise<void> {
    return this.db.rpc<void>('fail_story_task', {
      p_task_id: input.taskId,
      p_worker_id: input.workerId,
      p_stage: input.stage,
      p_error_code: input.code,
      p_error_message: input.message,
    })
  }

  /** Read this job's model API key from Vault (worker memory only). */
  getModelSecretForJob(jobId: string, workerId: string): Promise<string> {
    return this.db.rpc<string>('get_model_secret_for_job', {
      p_job_id: jobId,
      p_worker_id: workerId,
    })
  }

  /** Atomically write AI results + evidence into the existing tables. */
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

  /** Mark a worker-claimed preparation/finalization job failed. */
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
   * List story tasks for a job (used by finalize aggregation). The RPC returns
   * a jsonb array; tolerate a single object defensively.
   */
  async listStoryTasks(jobId: string): Promise<StoryTaskSummary[]> {
    const data = await this.db.rpc<unknown>('list_analysis_story_tasks_for_worker', {
      p_job_id: jobId,
    })
    return unwrapArray<StoryTaskSummary>(data)
  }
}
