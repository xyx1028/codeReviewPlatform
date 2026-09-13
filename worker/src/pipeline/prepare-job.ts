/**
 * prepare-job pipeline: freeze the four repository SHAs for a QUEUED job and
 * save their snapshots, flipping the job to PROCESSING. (Plan §6.2, §13.2)
 *
 * This stage is decoupled from story processing: once snapshots are saved, ANY
 * replica may claim and process the job's story tasks using the frozen SHAs.
 * The worker that prepares a job does not process all of its stories.
 */

import { REPOSITORIES, type BranchName } from '../git/repositories.js'
import { prepareRepository } from '../git/prepare.js'
import type { JobsDb, PreparationClaim } from '../db/jobs.js'
import type { WorkerConfig } from '../config.js'
import { rootLogger, type Logger } from '../logger.js'
import { redactError } from '../security/redaction.js'
import {
  NullRuntimeEventReporter,
  type RuntimeEventReporterLike,
} from '../monitoring/runtime-event-reporter.js'

/**
 * Freeze all four repositories for a job's requested branch and persist the
 * snapshots. The commit SHAs become the single source of truth for the job.
 * Any failure is persisted by the current claim owner before it is rethrown.
 */
export async function prepareJob(
  jobsDb: JobsDb,
  config: WorkerConfig,
  claim: PreparationClaim,
  logger: Logger = rootLogger,
  repositoryPreparer: typeof prepareRepository = prepareRepository,
  /**
   * 运行监控事件（JOB scope）。这一阶段没有 task claim，fencing 令牌是
   * `analysis_job.worker_id` + `status = 'PREPARING_CODE'`（方案 §6.4）。
   */
  runtimeEvents: RuntimeEventReporterLike = new NullRuntimeEventReporter(),
): Promise<void> {
  const jobId = claim.job.id
  const branch = claim.job.requested_branch as BranchName
  const timeoutMs = claim.model.request_timeout_ms
  const log = logger.child({ job_id: jobId, batch_id: claim.job.batch_id, stage: 'PREPARING_CODE' })

  const snapshots: Array<{
    repository_name: (typeof REPOSITORIES)[number]['name']
    requested_branch: BranchName
    commit_sha: string
    commit_subject: string | null
  }> = []

  try {
    for (const repo of REPOSITORIES) {
      const start = Date.now()
      // payload 仅 repository_name（四仓枚举）：不含路径，也不含远程 URL。
      runtimeEvents.report({
        type: 'REPOSITORY_PREPARE_STARTED',
        payload: { repository_name: repo.name },
      })
      let prepared
      try {
        prepared = await repositoryPreparer(repo.name, branch, {
          cacheRoot: config.codeCacheRoot,
          authMode: config.gitAuthMode,
          gitlabBaseUrl: config.gitlabBaseUrl,
          deployUser: config.gitlabDeployUser,
          deployToken: config.gitlabDeployToken,
          timeoutMs,
        })
      } catch (err) {
        runtimeEvents.report({
          type: 'REPOSITORY_PREPARE_FAILED',
          durationMs: Date.now() - start,
          errorCode: (err as { code?: string })?.code ?? 'REPOSITORY_PREPARE_FAILED',
          payload: { repository_name: repo.name, duration_ms: Date.now() - start },
        })
        throw err
      }
      runtimeEvents.report({
        type: 'REPOSITORY_PREPARE_COMPLETED',
        durationMs: Date.now() - start,
        payload: { repository_name: repo.name, duration_ms: Date.now() - start },
      })
      snapshots.push({
        repository_name: prepared.repository,
        requested_branch: branch,
        commit_sha: prepared.commitSha,
        commit_subject: prepared.commitSubject || null,
      })
      log.info('repository_prepared', {
        event: 'repository_prepared',
        repository: repo.name,
        commit_sha: prepared.commitSha,
        cached: prepared.cached,
        duration_ms: Date.now() - start,
      })
    }

    // saveRepositorySnapshots 会把 Job 从 PREPARING_CODE 推进到 PROCESSING；JOB scope
    // fencing 只在 PREPARING_CODE 期间接受仓库事件，所以必须先 flush。否则最后一个仓库
    // 的 COMPLETED 会在状态切换后被 RUNTIME_EVENT_FENCE_REJECTED 丢掉。
    await runtimeEvents.flush().catch(() => undefined)
    await jobsDb.saveRepositorySnapshots(jobId, config.workerId, snapshots)

    log.info('repositories_snapshots_saved', {
      event: 'repositories_snapshots_saved',
      count: snapshots.length,
    })
  } catch (err) {
    const code = (err as { code?: string })?.code ?? 'JOB_INTERNAL_ERROR'
    const message = redactError(err)
    log.error('repository_preparation_failed', {
      event: 'repository_preparation_failed',
      error_code: code,
      error_message: message,
    })

    // failClaimedAnalysisJob 同样会让 PREPARING_CODE fencing 失效；先保住失败事实。
    await runtimeEvents.flush().catch(() => undefined)
    await jobsDb
      .failClaimedAnalysisJob({
        jobId,
        workerId: config.workerId,
        code,
        message,
      })
      .catch((failErr) =>
        log.error('fail_preparation_job_error', {
          event: 'fail_preparation_job_error',
          error_message: redactError(failErr),
        }),
      )
    throw err
  } finally {
    // 兜底处理 flush 期间新入队的事件；正常路径在状态切换前队列已经为空。
    await runtimeEvents.flush().catch(() => undefined)
  }
}
