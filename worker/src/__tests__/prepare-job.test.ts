import { describe, expect, it, vi } from 'vitest'
import type { WorkerConfig } from '../config.js'
import type { JobsDb, PreparationClaim, RepositorySnapshotInput } from '../db/jobs.js'
import { prepareRepository } from '../git/prepare.js'
import { GitError } from '../git/verify.js'
import { Logger } from '../logger.js'
import { prepareJob } from '../pipeline/prepare-job.js'

const config: WorkerConfig = {
  supabaseUrl: 'https://project.supabase.co',
  supabaseServiceRoleKey: 'service-role-test-value',
  gitAuthMode: 'local',
  gitlabBaseUrl: 'https://git.example.com',
  gitlabDeployUser: null,
  gitlabDeployToken: null,
  workerId: 'worker-preparation',
  workspaceRoot: '/tmp/jobs',
  codeCacheRoot: '/tmp/cache',
  pollIntervalMs: 1000,
  storyTaskLeaseSeconds: 900,
  heartbeatIntervalMs: 30000,
  workerStoryConcurrency: 2,
  agentAttemptsRoot: '/tmp/agent-attempts',
  // V4：Session 卷必须与 attempt 临时目录分开，恢复才成立；容量与孤儿回收也随之进 config。
  sessionRoot: '/tmp/agent-sessions',
  sessionRetentionDays: 7,
  sessionVolumeMaxBytes: 20 * 1024 * 1024 * 1024,
  orphanWorkspaceMaxAgeMs: 6 * 60 * 60 * 1000,
}

const claim: PreparationClaim = {
  job: {
    id: 'job-preparation',
    batch_id: 'batch-preparation',
    model_config_id: 'model-preparation',
    requested_branch: 'feature_dev',
    total_stories: 20,
  },
  model: {
    model_config_id: 'model-preparation',
    display_name: 'Review model',
    base_url: 'https://model.example.com/v1',
    model_name: 'review-model',
    request_timeout_ms: 1000,
  },
}

function makeJobsDb() {
  const saveRepositorySnapshots = vi.fn().mockResolvedValue(undefined)
  const failClaimedAnalysisJob = vi.fn().mockResolvedValue(undefined)
  const jobsDb = {
    saveRepositorySnapshots,
    failClaimedAnalysisJob,
  } as unknown as JobsDb

  return { jobsDb, saveRepositorySnapshots, failClaimedAnalysisJob }
}

function silentLogger(): Logger {
  return new Logger({ sink: () => undefined, minLevel: 'error' })
}

describe('prepareJob single Harness workflow', () => {
  it('prepares every repository and saves canonical snapshots', async () => {
    const db = makeJobsDb()
    const repositoryPreparer = vi.fn(async (repository) => ({
      repository,
      commitSha: 'a'.repeat(40),
      commitSubject: `subject for ${repository}`,
      cached: true,
      path: `/tmp/cache/${repository}`,
    })) as unknown as typeof prepareRepository

    await prepareJob(db.jobsDb, config, claim, silentLogger(), repositoryPreparer)

    expect(repositoryPreparer).toHaveBeenCalledTimes(4)
    expect(repositoryPreparer).toHaveBeenNthCalledWith(1, 'kdmanage-backend', 'feature_dev', {
      cacheRoot: '/tmp/cache',
      authMode: 'local',
      gitlabBaseUrl: 'https://git.example.com',
      deployUser: null,
      deployToken: null,
      timeoutMs: 1000,
    })
    expect(db.saveRepositorySnapshots).toHaveBeenCalledTimes(1)
    expect(db.failClaimedAnalysisJob).not.toHaveBeenCalled()

    const call = db.saveRepositorySnapshots.mock.calls[0]
    expect(call?.[0]).toBe('job-preparation')
    expect(call?.[1]).toBe('worker-preparation')
    const snapshots = call?.[2] as RepositorySnapshotInput[]
    expect(snapshots.map((snapshot) => snapshot.repository_name)).toEqual([
      'kdmanage-backend',
      'kdmanage-frontend',
      'tmanage-backend',
      'tmanage-frontend',
    ])
    expect(snapshots.every((snapshot) => snapshot.requested_branch === 'feature_dev')).toBe(true)
    expect(snapshots.every((snapshot) => snapshot.commit_sha === 'a'.repeat(40))).toBe(true)
    expect(snapshots.map((snapshot) => snapshot.commit_subject)).toEqual([
      'subject for kdmanage-backend',
      'subject for kdmanage-frontend',
      'subject for tmanage-backend',
      'subject for tmanage-frontend',
    ])
  })

  it('stops at the first repository failure and records it on the claimed job', async () => {
    const db = makeJobsDb()
    const repositoryPreparer = vi.fn(async () => {
      throw new GitError('branch missing: feature_dev', 'GIT_BRANCH_MISSING')
    }) as unknown as typeof prepareRepository

    await expect(
      prepareJob(db.jobsDb, config, claim, silentLogger(), repositoryPreparer),
    ).rejects.toMatchObject({ code: 'GIT_BRANCH_MISSING' })

    expect(repositoryPreparer).toHaveBeenCalledTimes(1)
    expect(db.saveRepositorySnapshots).not.toHaveBeenCalled()
    expect(db.failClaimedAnalysisJob).toHaveBeenCalledWith({
      jobId: 'job-preparation',
      workerId: 'worker-preparation',
      code: 'GIT_BRANCH_MISSING',
      message: 'branch missing: feature_dev',
    })
  })

  it('does not hide the original repository error when failure persistence also fails', async () => {
    const db = makeJobsDb()
    db.failClaimedAnalysisJob.mockRejectedValue(new Error('database unavailable'))
    const originalError = new GitError('authentication failed', 'GIT_AUTH_FAILED')
    const repositoryPreparer = vi.fn(async () => {
      throw originalError
    }) as unknown as typeof prepareRepository

    await expect(
      prepareJob(db.jobsDb, config, claim, silentLogger(), repositoryPreparer),
    ).rejects.toBe(originalError)

    expect(db.failClaimedAnalysisJob).toHaveBeenCalledWith({
      jobId: 'job-preparation',
      workerId: 'worker-preparation',
      code: 'GIT_AUTH_FAILED',
      message: 'authentication failed',
    })
  })
})
