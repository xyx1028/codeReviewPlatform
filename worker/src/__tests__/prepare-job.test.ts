import { describe, expect, it, vi } from 'vitest'
import type { WorkerConfig } from '../config.js'
import type { JobsDb, PreparationClaim } from '../db/jobs.js'
import { GitError } from '../git/verify.js'
import { prepareRepository } from '../git/prepare.js'
import { Logger } from '../logger.js'
import { prepareJob } from '../pipeline/prepare-job.js'

const config: WorkerConfig = {
  supabaseUrl: 'https://project.supabase.co',
  supabaseServiceRoleKey: 'service-role-test-value',
  gitAuthMode: 'local',
  gitlabBaseUrl: 'https://git.example.com',
  gitlabDeployUser: null,
  gitlabDeployToken: null,
  workerId: 'w-prep',
  workspaceRoot: '/tmp/jobs',
  codeCacheRoot: '/tmp/cache',
  pollIntervalMs: 1000,
  storyTaskLeaseSeconds: 900,
  heartbeatIntervalMs: 30000,
  workerStoryConcurrency: 2,
}

const claim: PreparationClaim = {
  job: {
    id: 'job-prep',
    batch_id: 'batch-prep',
    model_config_id: 'model-prep',
    requested_branch: 'feature_dev',
    total_stories: 20,
  },
  model: {
    model_config_id: 'model-prep',
    display_name: 'test model',
    provider: 'openai-compatible',
    base_url: 'https://model.example.com',
    model_name: 'model-test',
    retrieval_prompt_version: 'retrieval-v1',
    analysis_prompt_version: 'analysis-v1',
    request_timeout_ms: 1000,
  },
}

describe('prepareJob failure persistence', () => {
  it('records a missing branch on the claimed job instead of leaving PREPARING_CODE', async () => {
    const failClaimedAnalysisJob = vi.fn().mockResolvedValue(undefined)
    const saveRepositorySnapshots = vi.fn().mockResolvedValue(undefined)
    const jobsDb = {
      failClaimedAnalysisJob,
      saveRepositorySnapshots,
    } as unknown as JobsDb
    const repositoryPreparer: typeof prepareRepository = vi.fn(async () => {
      throw new GitError('branch missing: feature_dev', 'GIT_BRANCH_MISSING')
    })
    const logger = new Logger({ sink: () => undefined })

    await expect(
      prepareJob(jobsDb, config, claim, logger, repositoryPreparer),
    ).rejects.toMatchObject({ code: 'GIT_BRANCH_MISSING' })

    expect(repositoryPreparer).toHaveBeenCalledTimes(1)
    expect(repositoryPreparer).toHaveBeenCalledWith(
      'kdmanage-backend',
      'feature_dev',
      expect.objectContaining({ gitlabBaseUrl: 'https://git.example.com' }),
    )
    expect(saveRepositorySnapshots).not.toHaveBeenCalled()
    expect(failClaimedAnalysisJob).toHaveBeenCalledWith({
      jobId: 'job-prep',
      workerId: 'w-prep',
      code: 'GIT_BRANCH_MISSING',
      message: 'branch missing: feature_dev',
    })
  })
})
