/**
 * Worker entrypoint — global, multi-replica DeepSeek Harness scheduler.
 *
 * Every replica reports capacity, prepares queued jobs, claims individual Agent
 * tasks at frozen repository SHAs, and finalizes completed jobs. Database
 * leases, claim tokens and advisory locks coordinate replicas; the worker keeps
 * no long-lived per-job state.
 */

import { ACP_PROFILE_NAME } from './ai/acp/profile-materializer.js'
import type { CommitReviewInput } from './ai/control/attempt-control-broker.js'
import { AGENT_REVIEW_PROMPT_VERSION } from './ai/prompts/agent-review-v1.js'
import type { ReviewRunner } from './ai/runtime/contracts.js'
import { buildDeepSeekHarnessReview } from './ai/runtime/factory.js'
import { loadConfig, type WorkerConfig } from './config.js'
import { SlotPool } from './coordination/concurrency.js'
import { Heartbeat } from './coordination/heartbeat.js'
import {
  acquireInstanceLock,
  WorkerAlreadyRunningError,
} from './coordination/instance-lock.js'
import { SupabaseDbClient } from './db/client.js'
import { JobsDb, type StoryTask } from './db/jobs.js'
import {
  prepareRepositoryAtSnapshot,
  type PreparedRepository,
} from './git/prepare.js'
import type { BranchName, RepositoryName } from './git/repositories.js'
import { rootLogger, type Logger } from './logger.js'
import { finalizeJob } from './pipeline/finalize-job.js'
import { prepareJob } from './pipeline/prepare-job.js'
import { redactError } from './security/redaction.js'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export interface WorkerRuntime {
  stop(): void
  ranOnce: Promise<void>
}

/** Prepare all repositories at the exact SHAs frozen on the claimed job. */
export async function prepareTaskRepositories(
  task: StoryTask,
  config: WorkerConfig,
): Promise<PreparedRepository[]> {
  const branch = task.job.requested_branch as BranchName
  const timeoutMs = task.model.request_timeout_ms
  const repositories: PreparedRepository[] = []

  for (const snapshot of task.snapshots) {
    repositories.push(
      await prepareRepositoryAtSnapshot(
        snapshot.repository_name as RepositoryName,
        branch,
        snapshot.commit_sha,
        {
          cacheRoot: config.codeCacheRoot,
          authMode: config.gitAuthMode,
          gitlabBaseUrl: config.gitlabBaseUrl,
          deployUser: config.gitlabDeployUser,
          deployToken: config.gitlabDeployToken,
          timeoutMs,
        },
      ),
    )
  }
  return repositories
}

/** Run one claimed story as one DeepSeek Harness ACP attempt. */
export async function runStoryTask(
  config: WorkerConfig,
  jobsDb: JobsDb,
  task: StoryTask,
  logger: Logger,
): Promise<void> {
  const log = logger.child({
    job_id: task.job_id,
    story_code: task.story_code,
    engine: 'deepseek-harness-acp',
  })
  let repositories: PreparedRepository[] | null = null
  let runner: ReviewRunner | null = null
  const attempt = new AbortController()
  const lease = new Heartbeat({
    taskId: task.id,
    workerId: config.workerId,
    intervalMs: config.heartbeatIntervalMs,
    send: (taskId, workerId) =>
      jobsDb.heartbeatStoryTask({
        taskId,
        workerId,
        claimToken: task.claim_token,
        leaseSeconds: config.storyTaskLeaseSeconds,
      }),
    logger: log,
  })

  try {
    repositories = await prepareTaskRepositories(task, config)
    lease.start()

    runner = await buildDeepSeekHarnessReview({
      jobsDb,
      task,
      workerId: config.workerId,
      branch: task.job.requested_branch as BranchName,
      repositories,
      agentAttemptsRoot: config.agentAttemptsRoot,
      logger: log,
      isLeaseValid: () => lease.leaseHeld(),
      commitReview: (input) =>
        jobsDb
          .saveAgentReviewResult({
            taskId: task.id,
            workerId: config.workerId,
            claimToken: task.claim_token,
            agentAttempt: task.agent_attempt,
            result: toAgentResultRow(input),
            evidence: input.evidence.map((item) => ({
              evidence_id: item.evidenceId ?? null,
              repository_name: item.repository,
              commit_sha: item.commitSha,
              file_path: item.filePath,
              blob_sha: item.blobSha,
              start_line: item.startLine,
              end_line: item.endLine,
              content_hash: item.contentHash,
              evidence_type: item.evidenceType,
              description: item.description,
            })),
            usage: {
              tool_calls: input.usage.toolCalls,
              evidence_shown: input.usage.evidenceShown,
              searches_run: input.usage.searchesRun,
              retry_requests: input.usage.retryRequests,
              compaction_requests: input.usage.compactionRequests,
            },
            configHash: input.configHash ?? null,
            promptVersion: AGENT_REVIEW_PROMPT_VERSION,
            modelLabel: `${task.model.display_name} / ${task.model.model_name}`,
          })
          .then((receipt) => ({
            runId: receipt.run_id,
            committedAt: receipt.committed_at,
          })),
    })

    const outcome = await runner.runReview({ signal: attempt.signal, logger: log })
    if (!outcome.ok) {
      await jobsDb
        .failAgentReview({
          taskId: task.id,
          workerId: config.workerId,
          claimToken: task.claim_token,
          code: outcome.errorCode ?? 'AGENT_ATTEMPT_FAILED',
          message: outcome.errorMessage ?? 'agent attempt failed',
        })
        .catch((failError) =>
          log.error('fail_agent_review_error', {
            event: 'fail_agent_review_error',
            error_message: redactError(failError),
          }),
        )
    }
  } catch (error) {
    const code = (error as { code?: string })?.code ?? 'JOB_INTERNAL_ERROR'
    const message = redactError(error)
    log.error('story_task_setup_failed', {
      event: 'story_task_setup_failed',
      error_code: code,
      error_message: message,
    })
    await recordSetupFailure(jobsDb, config, task, code, message).catch(() => undefined)
  } finally {
    attempt.abort()
    lease.stop()
    repositories = null
    runner = null
  }
}

/** Map a verified broker submission onto the Agent output stored by the DB. */
export function toAgentResultRow(input: CommitReviewInput): Record<string, unknown> {
  const submission = input.submission
  return {
    verdict: submission.verdict,
    confidence: submission.confidence,
    summary: submission.summary,
    implementedContent: submission.implementedContent ?? null,
    missingContent: submission.missingContent ?? null,
    risks: submission.risks ?? null,
    testPoints: submission.testPoints ?? null,
    aiRemark: submission.aiRemark ?? null,
  }
}

/** Persist repository/secret/runner setup failures on the claimed Agent task. */
export function recordSetupFailure(
  jobsDb: JobsDb,
  config: WorkerConfig,
  task: StoryTask,
  code: string,
  message: string,
): Promise<void> {
  return jobsDb.failAgentReview({
    taskId: task.id,
    workerId: config.workerId,
    claimToken: task.claim_token,
    code,
    message,
  })
}

/** Start the polling worker. */
export function startWorker(config: WorkerConfig): WorkerRuntime {
  const logger = rootLogger.child({ worker_id: config.workerId })
  const jobsDb = new JobsDb(new SupabaseDbClient(config))
  let stopped = false

  const pool = new SlotPool(config.workerStoryConcurrency)
  const inFlight = new Set<Promise<void>>()
  let resolveRanOnce: () => void
  const ranOnce = new Promise<void>((resolve) => {
    resolveRanOnce = resolve
  })

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
    } catch (error) {
      logger.error('prepare_job_error', {
        event: 'prepare_job_error',
        error_message: redactError(error),
      })
    }
  }

  const tryFinalize = async (): Promise<boolean> => {
    try {
      const claim = await jobsDb.claimJobForFinalization(config.workerId)
      if (!claim) return false
      logger.info('job_claimed_for_finalization', {
        event: 'job_claimed_for_finalization',
        job_id: claim.job.id,
      })
      await finalizeJob(jobsDb, claim, config.workerId, logger).catch(async (error) => {
        const code = (error as { code?: string })?.code ?? 'JOB_INTERNAL_ERROR'
        await jobsDb
          .failClaimedAnalysisJob({
            jobId: claim.job.id,
            workerId: config.workerId,
            code,
            message: redactError(error),
          })
          .catch(() => undefined)
      })
      return true
    } catch (error) {
      logger.error('finalize_claim_error', {
        event: 'finalize_claim_error',
        error_message: redactError(error),
      })
      return false
    }
  }

  let availabilityHeartbeatInFlight = false
  const reportAvailability = async (): Promise<void> => {
    if (stopped || availabilityHeartbeatInFlight) return
    availabilityHeartbeatInFlight = true
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10000)
    try {
      await jobsDb.heartbeatAnalysisWorker({
        workerId: config.workerId,
        slots: config.workerStoryConcurrency,
        current: pool.activeCount,
        capabilities: {
          worker_story_concurrency: config.workerStoryConcurrency,
          agent_profile: ACP_PROFILE_NAME,
        },
        signal: controller.signal,
      })
    } catch {
      // Availability heartbeat failure is non-fatal; the next interval retries.
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
        await tryPrepareOneJob()

        let claimedAny = false
        while (!stopped && pool.availableSlots > 0) {
          const task = await jobsDb.claimNextStoryTask(
            config.workerId,
            config.storyTaskLeaseSeconds,
          )
          if (!task) break
          claimedAny = true
          const release = await pool.acquire()
          const run = runStoryTask(config, jobsDb, task, logger)
            .catch((error) =>
              logger.error('slot_run_error', {
                event: 'slot_run_error',
                error_message: redactError(error),
              }),
            )
            .finally(() => {
              release()
              inFlight.delete(run)
            })
          inFlight.add(run)
        }

        if (!claimedAny) {
          const finalized = await tryFinalize()
          if (!finalized) {
            if (inFlight.size > 0) {
              await Promise.race([...inFlight, sleep(config.pollIntervalMs)])
            } else {
              await sleep(config.pollIntervalMs)
            }
          }
        } else if (pool.availableSlots <= 0 && inFlight.size > 0) {
          await Promise.race([...inFlight])
        }
      } catch (error) {
        logger.error('poll_loop_error', {
          event: 'poll_loop_error',
          error_message: redactError(error),
        })
        await sleep(config.pollIntervalMs)
      }

      if (first) {
        first = false
        resolveRanOnce()
      }
    }

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
    const instanceLock = acquireInstanceLock({
      workerId: config.workerId,
      lockDir: config.workspaceRoot,
    })
    process.on('exit', () => instanceLock.release())
    const runtime = startWorker(config)
    const shutdown = () => {
      runtime.stop()
      setTimeout(() => process.exit(0), 500)
    }
    process.on('SIGTERM', shutdown)
    process.on('SIGINT', shutdown)
  } catch (error) {
    if (error instanceof WorkerAlreadyRunningError) {
      rootLogger.error('worker_already_running', {
        event: 'worker_already_running',
        worker_id: error.workerId,
        holder_pid: error.holderPid,
        error_message: error.message,
      })
      process.exit(1)
    }
    rootLogger.error('worker_boot_failed', {
      event: 'worker_boot_failed',
      error_message: redactError(error),
    })
    process.exit(1)
  }
}
