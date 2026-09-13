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
import type { AttemptEndReason } from './ai/control/attempt-tree-controller.js'
import {
  contractHash,
  loadCapabilityContract,
  V4_POLICY_VERSION,
} from './ai/policy/v4-capability-policy.js'
import { AGENT_REVIEW_PROMPT_VERSION } from './ai/prompts/agent-review-v1.js'
import type { ReviewRunner } from './ai/runtime/contracts.js'
import { buildDeepSeekHarnessReview } from './ai/runtime/factory.js'
import { enforceSessionRetention } from './ai/session/session-retention.js'
import { cleanOrphanedOverlays } from './ai/workspace/overlay-cleaner.js'
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
  /** Stop claiming work, cancel active attempts, and release their leases. */
  stop(): Promise<void>
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
  options: { signal?: AbortSignal } = {},
): Promise<void> {
  const log = logger.child({
    job_id: task.job_id,
    story_code: task.story_code,
    engine: 'deepseek-harness-acp',
  })
  let repositories: PreparedRepository[] | null = null
  let runner: ReviewRunner | null = null
  const attempt = new AbortController()
  const abortAttempt = () => attempt.abort()
  if (options.signal?.aborted) abortAttempt()
  options.signal?.addEventListener('abort', abortAttempt, { once: true })
  let releaseAttempted = false
  const releaseForShutdown = async (): Promise<void> => {
    if (releaseAttempted) return
    releaseAttempted = true
    const released = await jobsDb.releaseStoryTaskClaim({
      taskId: task.id,
      workerId: config.workerId,
      claimToken: task.claim_token,
    })
    if (released) {
      log.info('story_task_released_for_shutdown', {
        event: 'story_task_released_for_shutdown',
      })
    }
  }
  // 取消状态与租约在同一次心跳往返里拿到。分成两次轮询的代价是"用户点了取消，
  // Agent Tree 还在跑一整个周期"，那在多 Agent 下意味着继续烧预算。
  let cancelRequested = false
  let leaseStarted = false
  const lease = new Heartbeat({
    taskId: task.id,
    workerId: config.workerId,
    intervalMs: config.heartbeatIntervalMs,
    send: async (taskId, workerId) => {
      const state = await jobsDb.heartbeatAttempt({
        taskId,
        workerId,
        claimToken: task.claim_token,
        leaseSeconds: config.storyTaskLeaseSeconds,
      })
      if (state.cancelRequested && !cancelRequested) {
        cancelRequested = true
        log.info('attempt_cancel_requested', {
          event: 'attempt_cancel_requested',
          cancel_reason: state.cancelReason,
        })
        // 立即中止：engine 的 finally 会走完整的 child-first 收敛。
        attempt.abort()
      }
      return state.leaseHeld
    },
    logger: log,
  })

  /**
   * 本次收敛的真实原因。
   *
   * 三条路径都 abort 同一个 signal，但运维含义不同：用户取消是产品行为，Lease 丢失说明
   * 任务已被别的 Worker 接管，Worker 关停是滚动重启。§7.8.6 要求把它们分开记，否则
   * cancel_reason 一律显示 USER_CANCELLED，事故复盘时无从判断到底发生了什么。
   *
   * 优先级：显式取消 > 租约丢失 > 关停。用户先点了取消、随后租约才过期，真正的原因仍是
   * 用户取消。
   */
  const attemptEndReason = (): AttemptEndReason => {
    if (cancelRequested) return 'USER_CANCELLED'
    if (leaseStarted && !lease.leaseHeld()) return 'LEASE_LOST'
    if (options.signal?.aborted) return 'WORKER_SHUTDOWN'
    return 'USER_CANCELLED'
  }

  try {
    repositories = await prepareTaskRepositories(task, config)
    if (options.signal?.aborted) {
      await releaseForShutdown()
      return
    }
    lease.start()
    leaseStarted = true

    runner = await buildDeepSeekHarnessReview({
      jobsDb,
      task,
      workerId: config.workerId,
      branch: task.job.requested_branch as BranchName,
      repositories,
      agentAttemptsRoot: config.agentAttemptsRoot,
      sessionRoot: config.sessionRoot,
      // Workspace 绝不能触及这些：pinned 快照缓存（写它会污染证据源）、attempt 树根、
      // Session 卷、Worker 自己的工作目录。
      forbiddenRoots: [
        config.codeCacheRoot,
        config.agentAttemptsRoot,
        config.sessionRoot,
        config.workspaceRoot,
      ],
      infrastructure: {
        supabaseUrl: config.supabaseUrl,
        gitlabBaseUrl: config.gitlabBaseUrl,
      },
      logger: log,
      isLeaseValid: () => lease.leaseHeld() && !cancelRequested,
      isCancelRequested: () => cancelRequested,
      abortReason: attemptEndReason,
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
              // 生产者归属：root 汇总 child 证据时，数据库据此确认它属于当前 Agent Tree。
              producer_agent_id: item.producer?.agentId ?? null,
              producer_session_id: item.producer?.sessionId ?? null,
              tool_call_id: item.producer?.toolCallId ?? null,
              // 固定快照证据。Workspace 生成物走 analysis_artifact，不能冒充现有实现。
              evidence_origin: 'PINNED_SNAPSHOT',
            })),
            usage: {
              tool_calls: input.usage.toolCalls,
              evidence_shown: input.usage.evidenceShown,
              searches_run: input.usage.searchesRun,
              retry_requests: input.usage.retryRequests,
              compaction_requests: input.usage.compactionRequests,
              // 真实模型请求数。V3 这里传的是 Broker 的工具调用数，那是错的映射。
              model_requests: input.usage.modelRequests,
              root_model_requests: input.usage.rootModelRequests,
              child_model_requests: input.usage.childModelRequests,
              web_requests: input.usage.webRequests,
              web_bytes: input.usage.webBytes,
              input_tokens: input.usage.inputTokens,
              output_tokens: input.usage.outputTokens,
              // V4 身份：数据库据此做 root-only 与 fencing 校验。
              root_agent_id: input.identity.rootAgentId,
              root_session_id: input.identity.rootSessionId,
              tree_digest: input.identity.treeDigest,
              session_revision: input.identity.sessionRevision,
              policy_hash: input.identity.policyHash,
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
    if (options.signal?.aborted) {
      await releaseForShutdown()
      return
    }
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
    if (options.signal?.aborted) {
      await releaseForShutdown().catch((releaseError) =>
        log.error('story_task_release_for_shutdown_failed', {
          event: 'story_task_release_for_shutdown_failed',
          error_message: redactError(releaseError),
        }),
      )
      return
    }
    const code = (error as { code?: string })?.code ?? 'JOB_INTERNAL_ERROR'
    const message = redactError(error)
    log.error('story_task_setup_failed', {
      event: 'story_task_setup_failed',
      error_code: code,
      error_message: message,
    })
    await recordSetupFailure(jobsDb, config, task, code, message).catch(() => undefined)
  } finally {
    options.signal?.removeEventListener('abort', abortAttempt)
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
  const shutdownController = new AbortController()
  let stopPromise: Promise<void> | null = null

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
          // 运维需要能一眼看出某个副本跑的是哪一代能力面和哪个 Harness 版本。
          policy_version: V4_POLICY_VERSION,
          harness_version: loadCapabilityContract().harnessVersion,
          capability_contract_hash: contractHash(),
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

  /** 每 10 分钟最多跑一次，避免每个轮询周期都去遍历整个卷。 */
  let lastCleanupAt = 0
  const runPeriodicCleanup = (): void => {
    const now = Date.now()
    if (now - lastCleanupAt < 10 * 60 * 1000) return
    lastCleanupAt = now
    try {
      cleanOrphanedOverlays({
        attemptsRoot: config.agentAttemptsRoot,
        maxAgeMs: config.orphanWorkspaceMaxAgeMs,
        logger,
      })
      enforceSessionRetention({
        root: config.sessionRoot,
        // 卷级回收是跨所有 Job 的动作，所以用可运维的全局保留期，而不是某一个 Job 冻结的
        // policy；单个 Job 的 session.retentionDays 只决定它自己 checkpoint 的
        // retention_until。
        retentionDays: config.sessionRetentionDays,
        maxTotalBytes: config.sessionVolumeMaxBytes,
        logger,
      })
    } catch (error) {
      logger.error('periodic_cleanup_failed', {
        event: 'periodic_cleanup_failed',
        error_message: redactError(error),
      })
    }
  }

  const loop = async (): Promise<void> => {
    logger.info('worker_started', { event: 'worker_started' })
    let first = true
    while (!stopped) {
      try {
        await tryPrepareOneJob()

        await jobsDb.reclaimStaleStoryTaskLeases()

        // 孤儿回收与保留期。放在轮询里而不是靠外部 cron：被 SIGKILL 的 attempt 留下的
        // Workspace 里有源码，而 Session 卷写满会让所有在跑的 attempt 一起失败。
        runPeriodicCleanup()

        let claimedAny = false
        while (!stopped && pool.availableSlots > 0) {
          const task = await jobsDb.claimNextStoryTask(
            config.workerId,
            config.storyTaskLeaseSeconds,
          )
          if (!task) break
          if (stopped) {
            await jobsDb.releaseStoryTaskClaim({
              taskId: task.id,
              workerId: config.workerId,
              claimToken: task.claim_token,
            })
            break
          }
          claimedAny = true
          const release = await pool.acquire()
          const run = runStoryTask(config, jobsDb, task, logger, {
            signal: shutdownController.signal,
          })
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
    stop(): Promise<void> {
      if (stopPromise) return stopPromise
      stopped = true
      clearInterval(availabilityHeartbeat)
      shutdownController.abort()
      stopPromise = Promise.allSettled([...inFlight]).then(() => undefined)
      return stopPromise
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
    let stopping = false
    const shutdown = () => {
      if (stopping) return
      stopping = true
      rootLogger.info('worker_shutdown_requested', { event: 'worker_shutdown_requested' })
      void runtime
        .stop()
        .catch((error) =>
          rootLogger.error('worker_shutdown_failed', {
            event: 'worker_shutdown_failed',
            error_message: redactError(error),
          }),
        )
        .finally(() => {
          instanceLock.release()
          rootLogger.info('worker_stopped', { event: 'worker_stopped' })
          process.exitCode = 0
        })
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
