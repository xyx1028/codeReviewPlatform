import { describe, expect, it } from 'vitest'
import {
  KNOWN_DB_ERROR_CODES,
  normalizeDbErrorCode,
  type DbClient,
  type RpcOptions,
} from '../db/client.js'
import { JobsDb, unwrapArray, unwrapMaybeObject } from '../db/jobs.js'

interface RpcCall {
  fn: string
  params: Record<string, unknown>
  options?: RpcOptions
}

/** Records every RPC call and returns a response scripted by function name. */
class RecordingDb implements DbClient {
  readonly calls: RpcCall[] = []

  constructor(private readonly responses: Record<string, unknown> = {}) {}

  async rpc<T = unknown>(
    fn: string,
    params: Record<string, unknown>,
    options?: RpcOptions,
  ): Promise<T> {
    this.calls.push({ fn, params, options })
    return (this.responses[fn] ?? null) as T
  }

  last(): RpcCall {
    return this.calls[this.calls.length - 1]
  }
}

const SHA = 'a'.repeat(40)
const CLAIM_TOKEN = '11111111-2222-4333-8444-555555555555'

function claimedTask(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'task-1',
    job_id: 'job-1',
    worker_id: 'worker-1',
    lease_expires_at: '2026-01-01T00:15:00.000Z',
    agent_status: 'RUNNING',
    agent_attempt: 2,
    claim_token: CLAIM_TOKEN,
    job: {
      id: 'job-1',
      batch_id: 'batch-1',
      model_config_id: 'model-1',
      requested_branch: 'feature_dev',
      total_stories: 3,
    },
    model: {
      model_config_id: 'model-1',
      display_name: 'Review model',
      base_url: 'https://model.example.com/v1',
      model_name: 'review-model',
      request_timeout_ms: 123456,
      agent_max_model_requests: 20,
    },
    snapshots: [
      {
        repository_name: 'kdmanage-backend',
        requested_branch: 'feature_dev',
        commit_sha: SHA,
        commit_subject: 'snapshot subject',
      },
    ],
    story: {
      story_id: 'story-1',
      story_code: 'PRJ-001',
      story_name: 'Demo story',
      description: 'description',
      acceptance_criteria: 'acceptance criteria',
      project_name: 'Project',
      application_name: 'Application',
      source_data: { source: 'import' },
    },
    ...overrides,
  }
}

function reviewCommitInput() {
  return {
    taskId: 'task-1',
    workerId: 'worker-1',
    claimToken: CLAIM_TOKEN,
    agentAttempt: 2,
    result: { verdict: 'IMPLEMENTED' },
    evidence: [{ evidence_id: 'ev-1' }],
    usage: {
      tool_calls: 9,
      evidence_shown: 2,
      searches_run: 4,
      retry_requests: 1,
      compaction_requests: 0,
    },
    configHash: 'config-hash',
    promptVersion: 'agent-review-v1',
    modelLabel: 'Review model / review-model',
  }
}

describe('JSONB wrapper helpers', () => {
  it('unwrapMaybeObject accepts an object or first array item and handles empty values', () => {
    expect(unwrapMaybeObject<{ value: number }>({ value: 1 })).toEqual({ value: 1 })
    expect(unwrapMaybeObject<{ value: number }>([{ value: 2 }])).toEqual({ value: 2 })
    expect(unwrapMaybeObject([])).toBeNull()
    expect(unwrapMaybeObject(null)).toBeNull()
    expect(unwrapMaybeObject(undefined)).toBeNull()
  })

  it('unwrapArray accepts arrays, single objects, and empty values', () => {
    expect(unwrapArray<number>([1, 2])).toEqual([1, 2])
    expect(unwrapArray<{ value: number }>({ value: 1 })).toEqual([{ value: 1 }])
    expect(unwrapArray(null)).toEqual([])
    expect(unwrapArray(undefined)).toEqual([])
  })
})

describe('JobsDb canonical RPC contract', () => {
  it('claims a job for preparation', async () => {
    const response = {
      job: {
        id: 'job-1',
        batch_id: 'batch-1',
        model_config_id: 'model-1',
        requested_branch: 'release',
        total_stories: 1,
      },
      model: {
        model_config_id: 'model-1',
        display_name: 'Review model',
        base_url: 'https://model.example.com/v1',
        model_name: 'review-model',
        request_timeout_ms: 5000,
      },
    }
    const db = new RecordingDb({ claim_job_for_preparation: [response] })
    const jobs = new JobsDb(db)

    await expect(jobs.claimJobForPreparation('worker-1')).resolves.toEqual(response)
    expect(db.last()).toMatchObject({
      fn: 'claim_job_for_preparation',
      params: { p_worker_id: 'worker-1' },
    })

    const none = new JobsDb(new RecordingDb({ claim_job_for_preparation: [] }))
    await expect(none.claimJobForPreparation('worker-1')).resolves.toBeNull()
  })

  it('saves repository snapshots with job ownership', async () => {
    const snapshots = [
      {
        repository_name: 'kdmanage-backend' as const,
        requested_branch: 'feature_dev' as const,
        commit_sha: SHA,
        commit_subject: null,
      },
    ]
    const db = new RecordingDb()
    const jobs = new JobsDb(db)

    await jobs.saveRepositorySnapshots('job-1', 'worker-1', snapshots)

    expect(db.last()).toMatchObject({
      fn: 'save_repository_snapshots',
      params: {
        p_job_id: 'job-1',
        p_worker_id: 'worker-1',
        p_snapshots: snapshots,
      },
    })
  })

  it('reclaims stale story task leases through the service RPC', async () => {
    const db = new RecordingDb({ reclaim_stale_story_task_leases: 2 })
    const jobs = new JobsDb(db)

    await expect(jobs.reclaimStaleStoryTaskLeases()).resolves.toBe(2)
    expect(db.last()).toMatchObject({
      fn: 'reclaim_stale_story_task_leases',
      params: {},
    })
  })

  it('claims a story task and exposes its required claim token and Agent fields', async () => {
    const db = new RecordingDb({ claim_next_story_task: [claimedTask()] })
    const jobs = new JobsDb(db)

    const task = await jobs.claimNextStoryTask('worker-1', 900)

    expect(db.last()).toMatchObject({
      fn: 'claim_next_story_task',
      params: { p_worker_id: 'worker-1', p_lease_seconds: 900 },
    })
    expect(task).toMatchObject({
      id: 'task-1',
      job_id: 'job-1',
      worker_id: 'worker-1',
      agent_status: 'RUNNING',
      agent_attempt: 2,
      claim_token: CLAIM_TOKEN,
      story_id: 'story-1',
      story_code: 'PRJ-001',
      story_name: 'Demo story',
      description: 'description',
      acceptance_criteria: 'acceptance criteria',
      project_name: 'Project',
      application_name: 'Application',
      source_data: { source: 'import' },
    })
    expect(task?.job.requested_branch).toBe('feature_dev')
    expect(task?.model.request_timeout_ms).toBe(123456)
    expect(task?.snapshots).toHaveLength(1)
  })

  it('returns null when no story task is claimable', async () => {
    const absent = new JobsDb(new RecordingDb({ claim_next_story_task: null }))
    const missingId = new JobsDb(new RecordingDb({ claim_next_story_task: {} }))

    await expect(absent.claimNextStoryTask('worker-1', 900)).resolves.toBeNull()
    await expect(missingId.claimNextStoryTask('worker-1', 900)).resolves.toBeNull()
  })

  it('rejects a claimed story task without a non-empty claim token', async () => {
    for (const claimToken of [undefined, '']) {
      const jobs = new JobsDb(
        new RecordingDb({ claim_next_story_task: claimedTask({ claim_token: claimToken }) }),
      )
      await expect(jobs.claimNextStoryTask('worker-1', 900)).rejects.toThrow(
        'claim_next_story_task returned no claim token',
      )
    }
  })

  it('claims a job for finalization and normalizes its snapshots', async () => {
    const snapshot = {
      repository_name: 'tmanage-backend',
      requested_branch: 'feature_dev',
      commit_sha: SHA,
      commit_subject: null,
    }
    const response = {
      job: {
        id: 'job-1',
        batch_id: 'batch-1',
        model_config_id: 'model-1',
        requested_branch: 'feature_dev',
        total_stories: 2,
      },
      model: { model_config_id: 'model-1' },
      snapshots: snapshot,
    }
    const db = new RecordingDb({ claim_job_for_finalization: response })
    const jobs = new JobsDb(db)

    const claim = await jobs.claimJobForFinalization('worker-1')

    expect(db.last()).toMatchObject({
      fn: 'claim_job_for_finalization',
      params: { p_worker_id: 'worker-1' },
    })
    expect(claim).toEqual({ ...response, snapshots: [snapshot] })

    const none = new JobsDb(new RecordingDb({ claim_job_for_finalization: null }))
    await expect(none.claimJobForFinalization('worker-1')).resolves.toBeNull()
  })

  it('heartbeats a claimed story task through the attempt-control RPC and reads lease_held', async () => {
    // V4：心跳合并进 attempt 控制面 RPC（heartbeat_analysis_attempt），一次往返同时带回
    // lease/cancel/sealed/session_revision。heartbeatStoryTask 只暴露其中的 leaseHeld 布尔，
    // 且必须严格来自返回对象的 `lease_held === true`，而不是把整个响应当真值。
    const db = new RecordingDb({ heartbeat_analysis_attempt: { lease_held: true } })
    const jobs = new JobsDb(db)

    await expect(
      jobs.heartbeatStoryTask({
        taskId: 'task-1',
        workerId: 'worker-1',
        claimToken: CLAIM_TOKEN,
        leaseSeconds: 900,
      }),
    ).resolves.toBe(true)
    expect(db.last()).toMatchObject({
      fn: 'heartbeat_analysis_attempt',
      params: {
        p_task_id: 'task-1',
        p_worker_id: 'worker-1',
        p_claim_token: CLAIM_TOKEN,
        p_lease_seconds: 900,
      },
    })

    // lease_held 缺失或不为严格 true → 视为未持有租约（false），而不是含糊地放行。
    const lost = new JobsDb(new RecordingDb({ heartbeat_analysis_attempt: { lease_held: false } }))
    await expect(
      lost.heartbeatStoryTask({
        taskId: 'task-1',
        workerId: 'worker-1',
        claimToken: CLAIM_TOKEN,
        leaseSeconds: 900,
      }),
    ).resolves.toBe(false)
  })

  it('releases only the current task claim during graceful Worker shutdown', async () => {
    const db = new RecordingDb({ release_story_task_claim: true })
    const jobs = new JobsDb(db)

    await expect(
      jobs.releaseStoryTaskClaim({
        taskId: 'task-1',
        workerId: 'worker-1',
        claimToken: CLAIM_TOKEN,
      }),
    ).resolves.toBe(true)

    expect(db.last()).toEqual({
      fn: 'release_story_task_claim',
      params: {
        p_task_id: 'task-1',
        p_worker_id: 'worker-1',
        p_claim_token: CLAIM_TOKEN,
      },
      options: undefined,
    })
  })

  it('heartbeats worker capacity, capabilities, and cancellation signal', async () => {
    const controller = new AbortController()
    const db = new RecordingDb()
    const jobs = new JobsDb(db)

    await jobs.heartbeatAnalysisWorker({
      workerId: 'worker-1',
      slots: 4,
      current: 2,
      capabilities: { agent_profile: 'code-review-acp' },
      signal: controller.signal,
    })

    expect(db.last()).toEqual({
      fn: 'heartbeat_analysis_worker',
      params: {
        p_worker_id: 'worker-1',
        p_slots: 4,
        p_current: 2,
        p_capabilities: { agent_profile: 'code-review-acp' },
      },
      options: { signal: controller.signal },
    })
  })

  it('uses empty worker capabilities by default', async () => {
    const db = new RecordingDb()
    const jobs = new JobsDb(db)

    await jobs.heartbeatAnalysisWorker({ workerId: 'worker-1', slots: 2, current: 0 })

    expect(db.last().params.p_capabilities).toEqual({})
  })

  it('reads the model secret for a claimed story task', async () => {
    const db = new RecordingDb({ get_model_secret_for_story_task: 'sk-secret' })
    const jobs = new JobsDb(db)

    await expect(
      jobs.getModelSecretForStoryTask({
        taskId: 'task-1',
        workerId: 'worker-1',
        claimToken: CLAIM_TOKEN,
      }),
    ).resolves.toBe('sk-secret')
    expect(db.last()).toMatchObject({
      fn: 'get_model_secret_for_story_task',
      params: {
        p_task_id: 'task-1',
        p_worker_id: 'worker-1',
        p_claim_token: CLAIM_TOKEN,
      },
    })
  })

  it('commits an Agent review and returns its receipt', async () => {
    const receipt = { run_id: 'run-1', committed_at: '2026-01-01T00:00:00.000Z' }
    const db = new RecordingDb({ save_agent_review_result: [receipt] })
    const jobs = new JobsDb(db)
    const input = reviewCommitInput()

    await expect(jobs.saveAgentReviewResult(input)).resolves.toEqual(receipt)
    expect(db.last()).toMatchObject({
      fn: 'save_agent_review_result',
      params: {
        p_task_id: 'task-1',
        p_worker_id: 'worker-1',
        p_claim_token: CLAIM_TOKEN,
        p_agent_attempt: 2,
        p_result: { verdict: 'IMPLEMENTED' },
        p_evidence: [{ evidence_id: 'ev-1' }],
        p_usage: input.usage,
        p_config_hash: 'config-hash',
        p_prompt_version: 'agent-review-v1',
        p_model_label: 'Review model / review-model',
      },
    })
  })

  it('rejects a commit response without a receipt', async () => {
    for (const response of [null, {}, []]) {
      const jobs = new JobsDb(new RecordingDb({ save_agent_review_result: response }))
      await expect(jobs.saveAgentReviewResult(reviewCommitInput())).rejects.toThrow(
        'save_agent_review_result returned no receipt',
      )
    }
  })

  it('records an Agent review failure with its claim token and business error code', async () => {
    const db = new RecordingDb()
    const jobs = new JobsDb(db)

    await jobs.failAgentReview({
      taskId: 'task-1',
      workerId: 'worker-1',
      claimToken: CLAIM_TOKEN,
      code: 'AGENT_NO_SUBMISSION',
      message: 'no review was submitted',
    })

    expect(db.last()).toMatchObject({
      fn: 'fail_agent_review',
      params: {
        p_task_id: 'task-1',
        p_worker_id: 'worker-1',
        p_claim_token: CLAIM_TOKEN,
        p_error_code: 'AGENT_NO_SUBMISSION',
        p_error_message: 'no review was submitted',
      },
    })
  })

  it('lists completed story tasks with committed output and verified evidence', async () => {
    const completedTask = {
      id: 'task-1',
      job_id: 'job-1',
      story_id: 'story-1',
      story_code: 'PRJ-001',
      agent_status: 'SUCCEEDED',
      output: { verdict: 'PARTIAL', summary: 'partially implemented' },
      verified_evidence: [
        {
          evidence_id: 'ev-1',
          repository_name: 'kdmanage-backend',
          commit_sha: SHA,
          file_path: 'src/OrderService.java',
          start_line: 10,
          end_line: 20,
          evidence_type: 'existing implementation',
          description: 'verified range',
        },
      ],
    }
    const db = new RecordingDb({ list_completed_story_tasks: completedTask })
    const jobs = new JobsDb(db)

    await expect(jobs.listCompletedStoryTasks('job-1')).resolves.toEqual([completedTask])
    expect(db.last()).toMatchObject({
      fn: 'list_completed_story_tasks',
      params: { p_job_id: 'job-1' },
    })

    const empty = new JobsDb(new RecordingDb({ list_completed_story_tasks: null }))
    await expect(empty.listCompletedStoryTasks('job-1')).resolves.toEqual([])
  })

  it('completes an analysis job with aggregate results and evidence', async () => {
    const results = [{ story_code: 'PRJ-001', verdict: 'IMPLEMENTED' }]
    const evidence = [{ story_code: 'PRJ-001', evidence_id: 'ev-1' }]
    const db = new RecordingDb()
    const jobs = new JobsDb(db)

    await jobs.completeAnalysisJob({
      jobId: 'job-1',
      workerId: 'worker-1',
      results,
      evidence,
    })

    expect(db.last()).toMatchObject({
      fn: 'complete_analysis_job',
      params: {
        p_job_id: 'job-1',
        p_worker_id: 'worker-1',
        p_results: results,
        p_evidence: evidence,
      },
    })
  })

  it('records a claimed job failure with its business error code', async () => {
    const db = new RecordingDb()
    const jobs = new JobsDb(db)

    await jobs.failClaimedAnalysisJob({
      jobId: 'job-1',
      workerId: 'worker-1',
      code: 'JOB_INTERNAL_ERROR',
      message: 'repository preparation failed',
    })

    expect(db.last()).toMatchObject({
      fn: 'fail_claimed_analysis_job',
      params: {
        p_job_id: 'job-1',
        p_worker_id: 'worker-1',
        p_error_code: 'JOB_INTERNAL_ERROR',
        p_error_message: 'repository preparation failed',
      },
    })
  })
})

describe('database error-code normalization', () => {
  it('recognizes every public domain error marker', () => {
    const expectedCodes = [
      'TASK_LEASE_LOST',
      'JOB_LEASE_LOST',
      'MODEL_SECRET_MISSING',
      'MODEL_CONFIG_DISABLED',
      'RESULT_ALREADY_EXISTS',
      'BATCH_BRANCH_CHANGED',
      'EVIDENCE_PATH_INVALID',
      'EVIDENCE_LINE_INVALID',
      'LEGACY_ENGINE_RETIRED',
      'AGENT_CLAIM_INVALID',
      'AGENT_RESULT_ALREADY_COMMITTED',
    ]

    expect(KNOWN_DB_ERROR_CODES).toEqual(expectedCodes)
    for (const code of expectedCodes) {
      expect(normalizeDbErrorCode(`RPC failed: ${code}`)).toBe(code)
    }
  })

  it('prefers a domain marker in the message over SQLSTATE', () => {
    expect(normalizeDbErrorCode('TASK_LEASE_LOST', 'P0001')).toBe('TASK_LEASE_LOST')
  })

  it('does not match domain markers as substrings', () => {
    expect(normalizeDbErrorCode('XTASK_LEASE_LOSTX', 'P0001')).toBe('P0001')
  })

  it('falls back to a non-empty SQLSTATE', () => {
    expect(normalizeDbErrorCode('unrecognized database failure', 'P0001')).toBe('P0001')
    expect(normalizeDbErrorCode('unrecognized database failure', '  ')).toBeUndefined()
  })

  it('returns undefined without a recognized marker or SQLSTATE', () => {
    expect(normalizeDbErrorCode('random failure')).toBeUndefined()
    expect(normalizeDbErrorCode(null)).toBeUndefined()
  })
})
