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
      const prepared = await repositoryPreparer(repo.name, branch, {
        cacheRoot: config.codeCacheRoot,
        authMode: config.gitAuthMode,
        gitlabBaseUrl: config.gitlabBaseUrl,
        deployUser: config.gitlabDeployUser,
        deployToken: config.gitlabDeployToken,
        timeoutMs,
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

    // Persist preparation failures instead of leaving the job indefinitely in
    // PREPARING_CODE. The RPC verifies this worker still owns the claim, so a
    // late failure cannot overwrite a job already taken over by another worker.
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
  }
}
