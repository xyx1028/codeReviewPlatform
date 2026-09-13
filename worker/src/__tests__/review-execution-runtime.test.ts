import { describe, expect, it } from 'vitest'
import {
  buildCoveragePolicy,
  buildDeepSeekHarnessReview,
  buildStoryDescription,
} from '../ai/runtime/factory.js'
import {
  DeepSeekHarnessAcpEngine,
  tailOf,
} from '../ai/runtime/deepseek-harness-acp-engine.js'
import { ReviewExecutionAbortedError } from '../ai/runtime/errors.js'
import {
  contractHash,
  loadCapabilityContract,
  policyHash,
  V4_DEFAULT_POLICY,
} from '../ai/policy/v4-capability-policy.js'
import type { JobsDb, StoryTask } from '../db/jobs.js'
import type { PreparedRepository } from '../git/prepare.js'
import { Logger } from '../logger.js'

const SHA = 'a'.repeat(40)
const JOB_ID = '11111111-2222-4333-8444-555555555555'
const TASK_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const CLAIM_TOKEN = '99999999-8888-4777-8666-555555555555'
const MANIFEST = loadCapabilityContract()
const MANIFEST_HASH = contractHash(MANIFEST)
const DEFAULT_POLICY_HASH = policyHash(V4_DEFAULT_POLICY)

function silentLogger(): Logger {
  return new Logger({ sink: () => {}, minLevel: 'error' })
}

function baseTask(overrides: Partial<StoryTask> = {}): StoryTask {
  const base: StoryTask = {
    id: TASK_ID,
    job_id: JOB_ID,
    worker_id: 'w1',
    lease_expires_at: '2026-01-01T00:15:00.000Z',
    agent_status: 'RUNNING',
    agent_attempt: 1,
    claim_token: CLAIM_TOKEN,
    // V4：完整策略与 Harness manifest 身份由数据库在 enqueue 时冻结并随 claim 下发。
    capability_policy: V4_DEFAULT_POLICY as unknown as Record<string, unknown>,
    policy_version: 4,
    policy_hash: DEFAULT_POLICY_HASH,
    harness_version: MANIFEST.harnessVersion,
    capability_contract_hash: MANIFEST_HASH,
    agent_run_id: null,
    session_revision: 1,
    job: {
      id: JOB_ID,
      batch_id: 'b',
      model_config_id: 'm',
      requested_branch: 'feature_dev',
      total_stories: 1,
    },
    model: {
      model_config_id: 'm',
      display_name: 'DeepSeek',
      base_url: 'https://model.invalid/v1',
      model_name: 'deepseek-chat',
      request_timeout_ms: 4242,
    },
    snapshots: [
      {
        repository_name: 'kdmanage-backend',
        requested_branch: 'feature_dev',
        commit_sha: SHA,
        commit_subject: null,
      },
    ],
    story: {
      story_id: 's',
      story_code: 'PRJ-001',
      story_name: 'demo',
      description: 'd',
      acceptance_criteria: null,
      project_name: null,
      application_name: null,
      source_data: {},
    },
    story_id: 's',
    story_code: 'PRJ-001',
    story_name: 'demo',
    description: 'd',
    acceptance_criteria: null,
    project_name: null,
    application_name: null,
    source_data: {},
  }
  return { ...base, ...overrides }
}

function preparedRepository(overrides: Partial<PreparedRepository> = {}): PreparedRepository {
  return {
    repository: 'kdmanage-backend',
    branch: 'feature_dev',
    commitSha: SHA,
    commitSubject: 'snapshot',
    path: '/tmp/nonexistent-review-snapshot',
    cached: true,
    ...overrides,
  }
}

function fakeJobsDb(secret = 'unit-test-secret') {
  const calls: Array<{ taskId: string; workerId: string; claimToken: string }> = []
  const db = {
    getModelSecretForStoryTask: async (input: {
      taskId: string
      workerId: string
      claimToken: string
    }) => {
      calls.push(input)
      return secret
    },
  } as unknown as JobsDb
  return { db, calls }
}

function buildInput(jobsDb: JobsDb, task = baseTask(), repositories = [preparedRepository()]) {
  return {
    jobsDb,
    task,
    workerId: 'w1',
    branch: 'feature_dev' as const,
    repositories,
    agentAttemptsRoot: '/tmp/review-attempts',
    // V4：Session 持久卷、禁止 Workspace 触及的平台目录、以及要被 Web 出口屏蔽的基础设施地址。
    sessionRoot: '/tmp/review-sessions',
    forbiddenRoots: ['/tmp/cache', '/tmp/jobs'],
    infrastructure: {
      supabaseUrl: 'https://project.supabase.co',
      gitlabBaseUrl: 'https://git.example.com',
    },
    logger: silentLogger(),
    isLeaseValid: () => true,
    commitReview: async () => ({ runId: 'run-1', committedAt: '2026-01-01T00:00:00Z' }),
  }
}

describe('buildDeepSeekHarnessReview', () => {
  it('builds the sole review runner and reads the key through the task claim', async () => {
    const { db, calls } = fakeJobsDb()

    const runner = await buildDeepSeekHarnessReview(buildInput(db))

    expect(runner).toBeInstanceOf(DeepSeekHarnessAcpEngine)
    expect(calls).toEqual([
      { taskId: TASK_ID, workerId: 'w1', claimToken: CLAIM_TOKEN },
    ])
  })

  it('rejects an empty repository set before reading credentials', async () => {
    const { db, calls } = fakeJobsDb()

    await expect(buildDeepSeekHarnessReview(buildInput(db, baseTask(), []))).rejects.toThrow(
      'DeepSeek Harness review requires prepared repositories',
    )
    expect(calls).toEqual([])
  })

  it('rejects a non-pinned commit id before reading credentials', async () => {
    const { db, calls } = fakeJobsDb()

    await expect(
      buildDeepSeekHarnessReview(
        buildInput(db, baseTask(), [preparedRepository({ commitSha: 'HEAD' })]),
      ),
    ).rejects.toThrow(/40-hex commit sha/)
    expect(calls).toEqual([])
  })
})

describe('buildStoryDescription', () => {
  it('uses a non-empty description verbatim', () => {
    expect(buildStoryDescription(baseTask({ description: '真实需求描述' }))).toBe(
      '真实需求描述',
    )
  })

  it('assembles source_data while ignoring empty values', () => {
    const text = buildStoryDescription(
      baseTask({
        description: null,
        source_data: {
          需求描述: '支持批量导出',
          验收标准: '可导出 CSV',
          空字段: '',
          空值: null,
        },
      }),
    )

    expect(text).toContain('需求描述: 支持批量导出')
    expect(text).toContain('验收标准: 可导出 CSV')
    expect(text).not.toContain('空字段')
    expect(text).not.toContain('空值')
  })

  it('falls back to the story name when no description data exists', () => {
    expect(buildStoryDescription(baseTask({ description: null, source_data: {} }))).toBe('demo')
  })
})

describe('coverage policy', () => {
  it('requires two complete searches for every pinned repository', () => {
    expect(buildCoveragePolicy(['kdmanage-backend', 'tmanage-backend'])).toEqual({
      requiredRepositories: ['kdmanage-backend', 'tmanage-backend'],
      minQueriesPerRepository: 2,
    })
  })
})

describe('tailOf', () => {
  it('returns text at or below the limit unchanged', () => {
    expect(tailOf('short', 100)).toBe('short')
    expect(tailOf('12345', 5)).toBe('12345')
  })

  it('keeps the diagnostic tail and reports the omitted character count', () => {
    const value = `${'noise'.repeat(100)}REAL_FAILURE_REASON`
    const tail = tailOf(value, 30)

    expect(tail).toContain(`truncated ${value.length - 30} chars`)
    expect(tail.endsWith('REAL_FAILURE_REASON')).toBe(true)
  })

  it('returns an empty string for a non-positive limit', () => {
    expect(tailOf('anything', 0)).toBe('')
    expect(tailOf('anything', -5)).toBe('')
  })
})

describe('abort', () => {
  it('does not inspect snapshots or start the runner when already aborted', async () => {
    const { db } = fakeJobsDb()
    const runner = await buildDeepSeekHarnessReview(buildInput(db))
    const controller = new AbortController()
    controller.abort()

    await expect(
      runner.runReview({ signal: controller.signal, logger: silentLogger() }),
    ).rejects.toBeInstanceOf(ReviewExecutionAbortedError)
  })
})
