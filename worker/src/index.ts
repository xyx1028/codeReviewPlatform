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
import { SkillCache } from './ai/skills/skill-cache.js'
import { SupabaseSkillStorageClient, type SkillStorageClient } from './ai/skills/skill-storage.js'
import { cleanOrphanedOverlays } from './ai/workspace/overlay-cleaner.js'
import { loadConfig, type WorkerConfig } from './config.js'
import { SlotPool } from './coordination/concurrency.js'
import { Heartbeat } from './coordination/heartbeat.js'
import {
  acquireInstanceLock,
  WorkerAlreadyRunningError,
} from './coordination/instance-lock.js'
import { SupabaseDbClient } from './db/client.js'
import { JobsDb, type ModelConnectivityTestClaim, type StoryTask } from './db/jobs.js'
import {
  prepareRepositoryAtSnapshot,
  type PreparedRepository,
} from './git/prepare.js'
import type { BranchName, RepositoryName } from './git/repositories.js'
import { rootLogger, type Logger } from './logger.js'
import { finalizeJob } from './pipeline/finalize-job.js'
import { prepareJob } from './pipeline/prepare-job.js'
import { redactError } from './security/redaction.js'
import {
  ModelConnectivityProbeError,
  probeModelConnectivity,
} from './model-connectivity/probe.js'
import {
  ModelNetworkRouteError,
  resolveModelNetworkRoute,
} from './model-connectivity/network-mode.js'
import {
  buildRuntimeEventReporter,
  type RuntimeEventReporterLike,
} from './monitoring/runtime-event-reporter.js'

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
  /** 运行监控事件（TASK scope）。缺省不上报。 */
  runtimeEvents?: RuntimeEventReporterLike,
): Promise<PreparedRepository[]> {
  const branch = task.job.requested_branch as BranchName
  const timeoutMs = task.model.request_timeout_ms
  const repositories: PreparedRepository[] = []
  const startedMs = Date.now()
  // 本地准备完成不含绝对路径：payload 只有耗时。
  runtimeEvents?.report({ type: 'TASK_REPOSITORIES_STARTED', payload: {} })

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
  runtimeEvents?.report({
    type: 'TASK_REPOSITORIES_READY',
    durationMs: Date.now() - startedMs,
    payload: { duration_ms: Date.now() - startedMs },
  })
  return repositories
}

/** Run one claimed story as one DeepSeek Harness ACP attempt. */
export async function runStoryTask(
  config: WorkerConfig,
  jobsDb: JobsDb,
  task: StoryTask,
  logger: Logger,
  options: {
    signal?: AbortSignal
    /**
     * 共享 Skill Cache 与下载通道（V1.6）。
     *
     * 从调用方传进来而不是在这里 new：它们必须跨 attempt 共享，而这个函数每个 Story
     * 都跑一次。缺省时本次 attempt 使用空技能目录 —— 单测走的就是这条路。
     */
    skills?: { cache: SkillCache; storage: SkillStorageClient }
  } = {},
): Promise<void> {
  const log = logger.child({
    job_id: task.job_id,
    story_code: task.story_code,
    engine: 'deepseek-harness-acp',
  })
  let repositories: PreparedRepository[] | null = null
  let runner: ReviewRunner | null = null
  // 每个 attempt 一个 Reporter：fencing 上下文（claim token + attempt + revision）随它走。
  const runtimeEvents = buildRuntimeEventReporter({
    settings: config.runtimeEvents,
    sink: jobsDb,
    logger: log,
    target: {
      workerId: config.workerId,
      jobId: task.job_id,
      taskId: task.id,
      claimToken: task.claim_token,
      agentAttempt: task.agent_attempt,
      sessionRevision: task.session_revision,
    },
  })
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
    repositories = await prepareTaskRepositories(task, config, runtimeEvents)
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
      // Session 卷、Worker 自己的工作目录、共享 Skill Cache（写它会污染其他 attempt 的
      // 不可变技能包）。
      forbiddenRoots: [
        config.codeCacheRoot,
        config.agentAttemptsRoot,
        config.sessionRoot,
        config.workspaceRoot,
        config.skillCacheRoot,
      ],
      infrastructure: {
        supabaseUrl: config.supabaseUrl,
        gitlabBaseUrl: config.gitlabBaseUrl,
      },
      modelImageInputEnabled: config.modelImageInputEnabled,
      // 内网模型的代理配置。与连接测试用的是同一份 Worker 配置，于是"测得通"与"跑得通"
      // 不可能因为配置来源不同而分叉 —— 阶段一正是在这一点上出的问题。
      hostProxy: config.modelConnectivityProxy,
      skills:
        options.skills === undefined
          ? undefined
          : {
              cache: options.skills.cache,
              storage: options.skills.storage,
              cacheMaxBytes: config.skillCacheMaxBytes,
            },
      logger: log,
      isLeaseValid: () => lease.leaseHeld() && !cancelRequested,
      isCancelRequested: () => cancelRequested,
      abortReason: attemptEndReason,
      runtimeEvents,
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
    // 尽力 flush 一次后停止。close() 不会无限阻塞收敛；已封存的 run 拒绝写入是预期结果。
    await runtimeEvents.close().catch(() => undefined)
    if (task.agent_run_id) {
      await jobsDb.computeRunRollup(task.agent_run_id).catch((error) =>
        log.error('run_rollup_compute_failed', {
          event: 'run_rollup_compute_failed',
          error_message: redactError(error),
        }),
      )
    }
    const stats = runtimeEvents.snapshot()
    if (stats.dropped > 0 || stats.silenced || stats.flushFailures > 0) {
      log.warn('runtime_event_attempt_summary', {
        event: 'runtime_event_attempt_summary',
        reported: stats.reported,
        dropped: stats.dropped,
        dropped_unresolved_agent: stats.droppedUnresolvedAgent,
        dropped_invalid: stats.droppedInvalid,
        collapsed: stats.collapsed,
        flush_failures: stats.flushFailures,
        silenced: stats.silenced,
      })
    }
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

export async function runModelConnectivityTest(
  config: WorkerConfig,
  jobsDb: JobsDb,
  claim: ModelConnectivityTestClaim,
  logger: Logger,
  signal: AbortSignal,
): Promise<void> {
  const log = logger.child({ model_connectivity_test_id: claim.id })
  let apiKey: string | null = null
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal.addEventListener('abort', abort, { once: true })
  const lease = new Heartbeat({
    taskId: claim.id,
    workerId: config.workerId,
    intervalMs: Math.min(config.heartbeatIntervalMs, 15000),
    send: (testId, workerId) => jobsDb.heartbeatModelConnectivityTest({
      testId,
      workerId,
      claimToken: claim.claim_token,
      leaseSeconds: config.modelConnectivityTestLeaseSeconds,
    }),
    onLeaseLost: abort,
    logger: log,
  })
  lease.start()
  try {
    apiKey = await jobsDb.getModelSecretForConnectivityTest({
      testId: claim.id,
      workerId: config.workerId,
      claimToken: claim.claim_token,
    })
    /*
     * 按**冻结的**网络类型决定走不走代理。
     *
     * 阶段一在这里无条件传了 `config.modelConnectivityProxy`，于是公网模型的请求也被送进
     * 代理，被代理的域名白名单拒成 HTTP 403 —— 用户看到"模型返回 403"，而真正的拒绝方
     * 是我们自己。判定统一交给 resolveModelNetworkRoute，与正式评审链路共用一套规则。
     */
    const route = resolveModelNetworkRoute({
      mode: claim.network_access_mode_snapshot,
      configuredProxy: config.modelConnectivityProxy,
    })
    log.info('model_connectivity_test_route_resolved', {
      event: 'model_connectivity_test_route_resolved',
      network_access_mode: route.mode,
      via_host_proxy: route.proxy !== null,
    })
    const result = await probeModelConnectivity({
      baseUrl: claim.base_url_snapshot,
      modelName: claim.model_name_snapshot,
      apiKey,
      timeoutMs: claim.request_timeout_ms_snapshot,
      proxy: route.proxy,
      signal: controller.signal,
    })
    const completed = await jobsDb.completeModelConnectivityTest({
      testId: claim.id,
      workerId: config.workerId,
      claimToken: claim.claim_token,
      statusCode: result.statusCode,
      latencyMs: result.latencyMs,
    })
    if (completed) log.info('model_connectivity_test_succeeded', {
      event: 'model_connectivity_test_succeeded', latency_ms: result.latencyMs,
    })
  } catch (error) {
    if (signal.aborted) {
      await jobsDb.releaseModelConnectivityTestClaim({
        testId: claim.id,
        workerId: config.workerId,
        claimToken: claim.claim_token,
      }).catch(() => false)
      return
    }
    // 未配置代理却选了内网模型：以稳定错误码明确失败，绝不静默直连。
    const routeError = error instanceof ModelNetworkRouteError ? error : null
    const probeError = error instanceof ModelConnectivityProbeError ? error : null
    await jobsDb.failModelConnectivityTest({
      testId: claim.id,
      workerId: config.workerId,
      claimToken: claim.claim_token,
      // 路由错误优先：它的原因（这台 Worker 没配代理）与模型端点无关，混进
      // MODEL_TEST_FAILED 会让管理员去查模型，而该查的是 Worker 的配置。
      code: routeError?.code ?? probeError?.code ?? 'MODEL_TEST_FAILED',
      message: routeError?.message ?? probeError?.message ?? '模型连接测试失败',
      statusCode: probeError?.statusCode,
      latencyMs: probeError?.latencyMs,
    }).catch(() => false)
    log.warn('model_connectivity_test_failed', {
      event: 'model_connectivity_test_failed',
      error_code: routeError?.code ?? probeError?.code ?? 'MODEL_TEST_FAILED',
    })
  } finally {
    apiKey = null
    lease.stop()
    signal.removeEventListener('abort', abort)
    controller.abort()
  }
}

/** Start the polling worker. */
export function startWorker(config: WorkerConfig): WorkerRuntime {
  const logger = rootLogger.child({ worker_id: config.workerId })
  const jobsDb = new JobsDb(new SupabaseDbClient(config))
  /*
   * 共享只读 Skill Cache 与 service-role 下载通道（V1.6）。
   *
   * 每个 Worker 进程一份，而不是每个 attempt 一份：cache 的全部价值来自跨 attempt 复用。
   * `SkillCache` 本身无状态（所有判定都读文件系统），所以同一个实例可以被并发 slot 共用；
   * 并发发布靠临时目录 + 原子 rename 裁决，不靠进程内互斥。
   */
  const skillCache = new SkillCache({ cacheRoot: config.skillCacheRoot })
  const skillStorage = new SupabaseSkillStorageClient(config)
  let stopped = false
  const shutdownController = new AbortController()
  let stopPromise: Promise<void> | null = null

  const pool = new SlotPool(config.workerStoryConcurrency)
  const inFlight = new Set<Promise<void>>()
  let modelTestLoopPromise: Promise<void> | null = null
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
      // JOB scope 的 fencing 令牌是 analysis_job.worker_id + status = 'PREPARING_CODE'，
      // 不是 task 四要素（方案 §6.4）：这一阶段还没有任何 task claim。
      const jobEvents = buildRuntimeEventReporter({
        settings: config.runtimeEvents,
        sink: jobsDb,
        logger,
        target: { workerId: config.workerId, jobId: claim.job.id },
      })
      try {
        await prepareJob(jobsDb, config, claim, logger, undefined, jobEvents)
      } finally {
        await jobEvents.close().catch(() => undefined)
      }
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
      // 运行监控事件的保留期清理与汇总补算。仓库没有 pg_cron，所以调度挂在这里
      // （已有 10 分钟节流）。按批限量：一次删太多会持有长事务，把游标水位卡住。
      // purge 绝不触及 analysis_agent_run_rollup —— 事件是可丢的细节，汇总是不可丢的基线。
      if (config.runtimeEvents.enabled) {
        void jobsDb
          .purgeRuntimeEvents(50000)
          .then((deleted) => {
            if (deleted > 0) {
              logger.info('runtime_event_purged', {
                event: 'runtime_event_purged',
                deleted,
              })
            }
          })
          .catch((error) =>
            logger.error('runtime_event_purge_failed', {
              event: 'runtime_event_purge_failed',
              error_message: redactError(error),
            }),
          )
        void jobsDb
          .backfillRunRollups(200)
          .then((result) => {
            if (result.computed > 0 || result.failed > 0) {
              logger.info('run_rollup_backfilled', {
                event: 'run_rollup_backfilled',
                computed: result.computed,
                failed: result.failed,
              })
            }
          })
          .catch((error) =>
            logger.error('run_rollup_backfill_failed', {
              event: 'run_rollup_backfill_failed',
              error_message: redactError(error),
            }),
          )
      }
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
            skills: { cache: skillCache, storage: skillStorage },
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

  const modelTestLoop = async (): Promise<void> => {
    while (!stopped) {
      try {
        const claim = await jobsDb.claimNextModelConnectivityTest(
          config.workerId,
          config.modelConnectivityTestLeaseSeconds,
        )
        if (!claim) {
          await sleep(config.pollIntervalMs)
          continue
        }
        if (stopped) {
          await jobsDb.releaseModelConnectivityTestClaim({
            testId: claim.id,
            workerId: config.workerId,
            claimToken: claim.claim_token,
          })
          break
        }
        await runModelConnectivityTest(
          config,
          jobsDb,
          claim,
          logger,
          shutdownController.signal,
        )
      } catch (error) {
        logger.error('model_connectivity_test_loop_error', {
          event: 'model_connectivity_test_loop_error',
          error_message: redactError(error),
        })
        await sleep(config.pollIntervalMs)
      }
    }
  }

  void loop()
  modelTestLoopPromise = modelTestLoop()

  return {
    stop(): Promise<void> {
      if (stopPromise) return stopPromise
      stopped = true
      clearInterval(availabilityHeartbeat)
      shutdownController.abort()
      stopPromise = Promise.allSettled([
        ...inFlight,
        ...(modelTestLoopPromise ? [modelTestLoopPromise] : []),
      ]).then(() => undefined)
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
