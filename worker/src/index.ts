/**
 * Worker entrypoint — global, multi-replica scheduler. (Plan §4, §13, §17)
 *
 * Every replica runs the same loop and cooperates on one batch:
 *
 *  1. Report capacity via heartbeat_analysis_worker (slots / current in use).
 *  2. Opportunistically prepare ONE QUEUED job (freeze 4 SHAs → PROCESSING).
 *     Preparation is decoupled from processing; a prepared job's stories are
 *     then claimable by ANY replica.
 *  3. While there is a free slot, globally claim the next processable story
 *     task from ANY job in PROCESSING (bounded by this worker's SlotPool and,
 *     server-side, by the model's max_parallel_tasks). Each claim is enriched
 *     with the job/model/snapshots/story, so a replica can process a task it
 *     never prepared. Repos are prepared locally at the frozen SHAs.
 *  4. When no task is claimable, try to claim a job for finalization. Idle
 *     workers polling for finalization means the LAST worker standing can
 *     always finish a job whose original owner crashed.
 *
 * The worker holds no long-lived per-job state; harnesses are built on demand
 * and released when a job is no longer being processed. On restart it recovers
 * from the DB and prepared cache. Claim-owned task workspaces are cleaned only
 * by the claim that created them, so replicas sharing WORKSPACE_ROOT cannot
 * recursively delete each other's active files.
 */

import { loadConfig, type WorkerConfig } from './config.js'
import { SupabaseDbClient } from './db/client.js'
import {
  JobsDb,
  type StoryTask,
  type ModelSnapshot,
} from './db/jobs.js'
import { OpenAICompatibleClient } from './ai/openai-compatible.js'
import { OpenAICompatibleHarness } from './ai/openai-compatible-harness.js'
import { prepareJob } from './pipeline/prepare-job.js'
import {
  processStoryTask,
  type PreparedRepoRef,
} from './pipeline/process-story-task.js'
import { finalizeJob } from './pipeline/finalize-job.js'
import { prepareRepositoryAtSnapshot } from './git/prepare.js'
import type { BranchName, RepositoryName } from './git/repositories.js'
import { SlotPool } from './coordination/concurrency.js'
import { rootLogger, type Logger } from './logger.js'
import { redactError } from './security/redaction.js'

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export interface WorkerRuntime {
  stop(): void
  ranOnce: Promise<void>
}

/**
 * Build a ReviewHarness for a job by reading its Vault-stored API key into
 * worker memory. The key is scoped to processing this task and is not logged.
 * The per-model request timeout comes from the model snapshot.
 */
export async function buildHarnessForJob(
  jobsDb: JobsDb,
  jobId: string,
  workerId: string,
  model: ModelSnapshot,
): Promise<OpenAICompatibleHarness> {
  const apiKey = await jobsDb.getModelSecretForJob(jobId, workerId)
  const client = new OpenAICompatibleClient({
    baseUrl: model.base_url,
    modelName: model.model_name,
    apiKey,
    timeoutMs: model.request_timeout_ms ?? 180000,
  })
  return new OpenAICompatibleHarness({ client })
}

/**
 * Prepare the four repositories for a claimed task at their frozen SHAs. Never
 * resolves the latest branch head; uses the exact snapshot SHAs.
 */
export async function prepareTaskRepositories(
  task: StoryTask,
  config: WorkerConfig,
): Promise<PreparedRepoRef[]> {
  const branch = task.job.requested_branch as BranchName
  const timeoutMs = task.model.request_timeout_ms
  const refs: PreparedRepoRef[] = []
  for (const snap of task.snapshots) {
    const prepared = await prepareRepositoryAtSnapshot(
      snap.repository_name as RepositoryName,
      branch,
      snap.commit_sha,
      {
        cacheRoot: config.codeCacheRoot,
        authMode: config.gitAuthMode,
        gitlabBaseUrl: config.gitlabBaseUrl,
        deployUser: config.gitlabDeployUser,
        deployToken: config.gitlabDeployToken,
        timeoutMs,
      },
    )
    refs.push({ name: prepared.repository, commitSha: prepared.commitSha, path: prepared.path })
  }
  return refs
}

/**
 * Process a single enriched task: prepare repos at frozen SHAs, build a harness,
 * run the two stages, then release memory references. Failures are persisted by
 * processStoryTask; unexpected errors here are recorded on the task too.
 */
export async function runStoryTask(
  config: WorkerConfig,
  jobsDb: JobsDb,
  task: StoryTask,
  logger: Logger,
): Promise<void> {
  const log = logger.child({ job_id: task.job_id, story_code: task.story_code })
  let repos: PreparedRepoRef[] | null = null
  let harness: OpenAICompatibleHarness | null = null
  try {
    repos = await prepareTaskRepositories(task, config)
    harness = await buildHarnessForJob(jobsDb, task.job_id, config.workerId, task.model)

    await processStoryTask(
      harness,
      jobsDb,
      {
        workerId: config.workerId,
        workspaceRoot: config.workspaceRoot,
        branch: task.job.requested_branch as BranchName,
        modelName: task.model.model_name,
        heartbeatIntervalMs: config.heartbeatIntervalMs,
        leaseSeconds: config.storyTaskLeaseSeconds,
        repositories: repos,
      },
      task,
      log,
    )
  } catch (err) {
    const code = (err as { code?: string })?.code ?? 'JOB_INTERNAL_ERROR'
    const message = redactError(err)
    log.error('story_task_setup_failed', {
      event: 'story_task_setup_failed',
      error_code: code,
      error_message: message,
    })
    // Setup failure (repo prep / secret / harness) — record it on the task.
    await jobsDb
      .failStoryTask({
        taskId: task.id,
        workerId: config.workerId,
        stage: task.retrieval_status === 'SUCCEEDED' ? 'analysis' : 'retrieval',
        code,
        message,
      })
      .catch(() => undefined)
  } finally {
    // Release memory references so a long-lived replica does not accumulate
    // prepared trees / API keys across tasks.
    repos = null
    harness = null
  }
}

/** Start the polling worker. Returns a handle to stop it. */
export function startWorker(config: WorkerConfig): WorkerRuntime {
  const logger = rootLogger.child({ worker_id: config.workerId })
  const dbClient = new SupabaseDbClient(config)
  const jobsDb = new JobsDb(dbClient)

  let stopped = false

  const pool = new SlotPool(config.workerStoryConcurrency)
  const inFlight = new Set<Promise<void>>()

  let resolveRanOnce: () => void
  const ranOnce = new Promise<void>((r) => {
    resolveRanOnce = r
  })

  /** Try to prepare one QUEUED job. Non-fatal; logged and continues. */
  const tryPrepareOneJob = async (): Promise<void> => {
    try {
      const claim = await jobsDb.claimJobForPreparation(config.workerId)
      if (!claim) return
      logger.info('job_claimed_for_preparation', {
        event: 'job_claimed_for_preparation',
        job_id: claim.job.id,
        batch_id: claim.job.batch_id,
      })
      await prepareJob(jobsDb, config, claim, logger)
    } catch (err) {
      logger.error('prepare_job_error', {
        event: 'prepare_job_error',
        error_message: redactError(err),
      })
    }
  }

  /** Try to claim and run a job finalization. Returns true if it did work. */
  const tryFinalize = async (): Promise<boolean> => {
    try {
      const claim = await jobsDb.claimJobForFinalization(config.workerId)
      if (!claim) return false
      logger.info('job_claimed_for_finalization', {
        event: 'job_claimed_for_finalization',
        job_id: claim.job.id,
      })
      await finalizeJob(jobsDb, claim, config.workerId, logger).catch(async (err) => {
        const code = (err as { code?: string })?.code ?? 'JOB_INTERNAL_ERROR'
        await jobsDb
          .failClaimedAnalysisJob({
            jobId: claim.job.id,
            workerId: config.workerId,
            code,
            message: redactError(err),
          })
          .catch(() => undefined)
      })
      return true
    } catch (err) {
      logger.error('finalize_claim_error', {
        event: 'finalize_claim_error',
        error_message: redactError(err),
      })
      return false
    }
  }

  let availabilityHeartbeatInFlight = false
  const reportAvailability = async () => {
    if (stopped || availabilityHeartbeatInFlight) return
    availabilityHeartbeatInFlight = true
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10000)
    try {
      await jobsDb.heartbeatAnalysisWorker(
        config.workerId,
        config.workerStoryConcurrency,
        pool.activeCount,
        controller.signal,
      )
    } catch {
      // 心跳失败或超时不应中断任务处理，下一个周期继续上报。
    } finally {
      clearTimeout(timeout)
      availabilityHeartbeatInFlight = false
    }
  }
  void reportAvailability()
  const availabilityHeartbeat = setInterval(() => {
    void reportAvailability()
  }, 5000)

  const loop = async (): Promise<void> => {
    logger.info('worker_started', { event: 'worker_started' })
    let first = true
    while (!stopped) {
      try {
        // 1. Opportunistically prepare a QUEUED job.
        await tryPrepareOneJob()

        // 2. Fill free slots with globally-claimed story tasks.
        let claimedAny = false
        while (!stopped && pool.availableSlots > 0) {
          const task = await jobsDb.claimNextStoryTask(
            config.workerId,
            config.storyTaskLeaseSeconds,
          )
          if (!task) break
          claimedAny = true
          // Acquire a slot synchronously, then run in the background.
          const release = await pool.acquire()
          const run = runStoryTask(config, jobsDb, task, logger)
            .catch((err) =>
              logger.error('slot_run_error', {
                event: 'slot_run_error',
                error_message: redactError(err),
              }),
            )
            .finally(() => {
              release()
              inFlight.delete(run)
            })
          inFlight.add(run)
        }

        // 4. If nothing to claim, try finalization (any idle replica can win).
        if (!claimedAny) {
          const finalized = await tryFinalize()
          if (!finalized) {
            // Nothing to do — wait, but yield if tasks are still in flight.
            if (inFlight.size > 0) {
              await Promise.race([...inFlight, sleep(config.pollIntervalMs)])
            } else {
              await sleep(config.pollIntervalMs)
            }
          }
        } else if (pool.availableSlots <= 0 && inFlight.size > 0) {
          // Saturated: wait for a slot to free before the next claim round.
          await Promise.race([...inFlight])
        }
      } catch (err) {
        logger.error('poll_loop_error', {
          event: 'poll_loop_error',
          error_message: redactError(err),
        })
        await sleep(config.pollIntervalMs)
      }
      if (first) {
        first = false
        resolveRanOnce()
      }
    }
    // Drain in-flight tasks before declaring stopped.
    await Promise.allSettled([...inFlight])
    logger.info('worker_stopped', { event: 'worker_stopped' })
  }

  void loop()

  return {
    stop() {
      stopped = true
      clearInterval(availabilityHeartbeat)
    },
    ranOnce,
  }
}

// Bootstrap when executed directly.
const isMain = (() => {
  try {
    return process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`
  } catch {
    return false
  }
})()

if (isMain) {
  try {
    const config = loadConfig()
    const runtime = startWorker(config)
    const shutdown = () => {
      runtime.stop()
      setTimeout(() => process.exit(0), 500)
    }
    process.on('SIGTERM', shutdown)
    process.on('SIGINT', shutdown)
  } catch (err) {
    rootLogger.error('worker_boot_failed', { event: 'worker_boot_failed', error_message: redactError(err) })
    process.exit(1)
  }
}
