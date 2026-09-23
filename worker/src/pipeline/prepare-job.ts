/**
 * prepare-job pipeline: freeze the four repository SHAs for a QUEUED job and
 * save their snapshots, flipping the job to PROCESSING. (Plan §6.2, §13.2)
 *
 * This stage is decoupled from story processing: once snapshots are saved, ANY
 * replica may claim and process the job's story tasks using the frozen SHAs.
 * The worker that prepares a job does not process all of its stories.
 */

import { REPOSITORIES, type BranchName } from '../git/repositories.js'
import { prepareRepository, type PreparedRepository } from '../git/prepare.js'
import { collectRepositoryHistory } from '../git/story-history.js'
import {
  GitLabReadonlyClient,
  type RepositoryMergeRequestEnrichment,
} from '../git/gitlab-readonly-client.js'
import { buildStoryScopes } from './story-scope.js'
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
  historyCollector: typeof collectRepositoryHistory = collectRepositoryHistory,
  gitlabClient?: Pick<GitLabReadonlyClient, 'collectRepositoryMergeRequests'>,
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
  const preparedRepositories: PreparedRepository[] = []
  const headResolvedAt = new Map<string, string>()
  const persistedMergeRequests: RepositoryMergeRequestEnrichment[] = []
  const mrClient = gitlabClient ?? new GitLabReadonlyClient({
    baseUrl: config.gitlabBaseUrl,
    apiToken: config.gitlabApiToken,
  })

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
      preparedRepositories.push(prepared)
      headResolvedAt.set(repo.name, new Date().toISOString())
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

    // v1 完全保持旧路径：一次 RPC 保存四仓快照并推进 PROCESSING。
    if ((claim.job.analysis_context_version ?? 1) === 1) {
      await runtimeEvents.flush().catch(() => undefined)
      await jobsDb.saveRepositorySnapshots(jobId, config.workerId, snapshots)
      log.info('repositories_snapshots_saved', {
        event: 'repositories_snapshots_saved',
        count: snapshots.length,
      })
      return
    }

    // V2 的顺序不可交换：四仓 HEAD 全部固定 → 保存 snapshots（数据库进入
    // PREPARING_SCOPE 并冻结第一代输入）→ 读取同一冻结输入 → 本地 Git 历史/身份匹配
    // → 全部 manifest → 全部 Story scope → 原子 finalize。中途任何失败都不能把 Job
    // 推进 PROCESSING，也不能退化成 v1。
    await runtimeEvents.flush().catch(() => undefined)
    await jobsDb.saveRepositorySnapshots(jobId, config.workerId, snapshots)
    const frozen = await jobsDb.freezeAnalysisJobScopeInputs(jobId, config.workerId)
    if (!Array.isArray(frozen.stories) || frozen.stories.length !== claim.job.total_stories) {
      throw Object.assign(
        new Error('frozen scope input payload does not contain every story task'),
        { code: 'ANALYSIS_SCOPE_INPUTS_MISSING' },
      )
    }
    const histories = []
    for (const prepared of preparedRepositories) {
      const history = await historyCollector({
        prepared,
        cacheRoot: config.codeCacheRoot,
        branch,
        headResolvedAt: headResolvedAt.get(prepared.repository)!,
        windowDays: claim.job.commit_window_days ?? 21,
        identityMatcher: (authors) => jobsDb.matchAnalysisGitIdentities(authors),
        prepareOptions: {
          cacheRoot: config.codeCacheRoot,
          authMode: config.gitAuthMode,
          gitlabBaseUrl: config.gitlabBaseUrl,
          deployUser: config.gitlabDeployUser,
          deployToken: config.gitlabDeployToken,
          timeoutMs,
        },
        previousBaseSha: frozen.previous_repository_heads?.[prepared.repository] ?? null,
      })
      histories.push(history)
      await jobsDb.saveAnalysisRepositoryCommitManifest({
        jobId,
        workerId: config.workerId,
        repositoryName: prepared.repository,
        manifest: history.manifest as unknown as Record<string, unknown>,
        manifestHash: history.manifestHash,
      })
      log.info('repository_history_manifest_saved', {
        event: 'repository_history_manifest_saved',
        repository: prepared.repository,
        enumeration_status: history.manifest.enumeration_status,
        range_source: history.manifest.range_source,
        range_fallback_reason: history.manifest.range_fallback_reason,
        commit_count: history.manifest.commit_count,
        deepen_count: history.deepenCount,
      })

      // MR metadata is an optional enhancement. API and persistence failures never invalidate
      // the already-frozen Git manifest, and no credential is copied into logs or Workspace.
      let enrichment: RepositoryMergeRequestEnrichment
      try {
        enrichment = await mrClient.collectRepositoryMergeRequests({
          repository: prepared.repository,
          targetBranch: branch,
          rangeStartAt: history.manifest.range_start_at,
          rangeEndAt: history.manifest.range_end_at,
          storyCodes: frozen.stories.map((story) => story.story_code),
        })
      } catch {
        enrichment = {
          repository: prepared.repository,
          status: 'FAILED',
          errorCode: 'MR_METADATA_REQUEST_FAILED',
          mergeRequests: [],
        }
      }
      try {
        await jobsDb.saveAnalysisRepositoryMergeRequests({
          jobId,
          workerId: config.workerId,
          repositoryName: prepared.repository,
          status: enrichment.status,
          errorCode: enrichment.errorCode,
          mergeRequests: enrichment.mergeRequests,
        })
        persistedMergeRequests.push(enrichment)
        log.info('repository_mr_enrichment_saved', {
          event: 'repository_mr_enrichment_saved',
          repository: prepared.repository,
          status: enrichment.status,
          error_code: enrichment.errorCode,
          merge_request_count: enrichment.mergeRequests.length,
        })
      } catch (mrPersistenceError) {
        log.warn('repository_mr_enrichment_persistence_failed', {
          event: 'repository_mr_enrichment_persistence_failed',
          repository: prepared.repository,
          error_code: (mrPersistenceError as { code?: string })?.code ?? 'MR_METADATA_PERSISTENCE_FAILED',
        })
      }
    }
    /*
     * 四个仓库的冻结范围全空 = 这个 Job 的每个需求都只能全仓降级。
     * 它以前是无声的：范围卡片上只是一排 0，没有任何日志或错误码说"这一批精准分析已经失效"。
     * 这里留一行 warn，让运维在模型开始烧钱之前就能看到。
     */
    const totalFrozenCommits = histories.reduce((sum, item) => sum + item.manifest.commit_count, 0)
    if (histories.length > 0 && totalFrozenCommits === 0) {
      log.warn('analysis_range_empty_all_repositories', {
        event: 'analysis_range_empty_all_repositories',
        repositories: histories.map((item) => ({
          repository: item.manifest.repository,
          range_source: item.manifest.range_source,
          range_fallback_reason: item.manifest.range_fallback_reason,
          base_equals_head: item.manifest.base_sha === item.manifest.head_sha,
        })),
      })
    }
    const built = buildStoryScopes({
      stories: frozen.stories,
      identities: frozen.identities ?? [],
      histories,
      mergeRequests: persistedMergeRequests,
      rulesetHash: frozen.ruleset_hash,
      generation: 1,
    })
    await jobsDb.saveAnalysisStoryScopes({
      jobId,
      workerId: config.workerId,
      algorithmVersion: built.algorithmVersion,
      scopes: built.scopes as unknown as Array<Record<string, unknown>>,
      scopeCatalogHash: built.scopeCatalogHash,
    })
    await jobsDb.finalizeAnalysisStoryScope(jobId, config.workerId, 1)
    log.info('analysis_story_scopes_finalized', {
      event: 'analysis_story_scopes_finalized',
      scope_count: built.scopes.length,
      degraded_count: built.scopes.filter((scope) => scope.status === 'DEGRADED').length,
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
