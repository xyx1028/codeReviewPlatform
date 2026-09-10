import { describe, it, expect } from 'vitest'
import { JobsDb, unwrapMaybeObject, unwrapArray } from '../db/jobs.js'
import type { DbClient } from '../db/client.js'
import { normalizeDbErrorCode } from '../db/client.js'

/** Records every rpc(fn, params) call and returns a scripted response. */
class RecordingDb implements DbClient {
  calls: Array<{ fn: string; params: Record<string, unknown> }> = []
  private responses: Record<string, unknown>
  constructor(responses: Record<string, unknown> = {}) {
    this.responses = responses
  }
  async rpc<T = unknown>(fn: string, params: Record<string, unknown>): Promise<T> {
    this.calls.push({ fn, params })
    return (this.responses[fn] ?? null) as T
  }
  last(): { fn: string; params: Record<string, unknown> } {
    return this.calls[this.calls.length - 1]
  }
}

const SHA = 'a'.repeat(40)

function enrichedTask(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'task-1',
    job_id: 'job-1',
    worker_id: 'w1',
    retrieval_attempt: 2,
    analysis_attempt: 1,
    retrieval_status: 'PENDING',
    analysis_status: 'PENDING',
    lease_expires_at: null,
    retrieval_output: null,
    job: {
      id: 'job-1',
      batch_id: 'batch-1',
      model_config_id: 'model-1',
      requested_branch: 'feature_dev',
      total_stories: 3,
    },
    model: {
      model_config_id: 'model-1',
      display_name: 'D',
      provider: 'openai-compatible',
      base_url: 'https://m/v1',
      model_name: 'gpt',
      retrieval_prompt_version: 'retrieval-v1',
      analysis_prompt_version: 'analysis-v1',
      request_timeout_ms: 123456,
    },
    snapshots: [
      { repository_name: 'kdmanage-backend', requested_branch: 'feature_dev', commit_sha: SHA, commit_subject: 's' },
    ],
    story: {
      story_id: 'story-1',
      story_code: 'PRJ-001',
      story_name: 'demo',
      description: 'd',
      acceptance_criteria: 'ac',
      project_name: 'p',
      application_name: 'app',
      source_data: { a: 1 },
    },
    ...overrides,
  }
}

describe('unwrap helpers (jsonb object/array tolerant)', () => {
  it('unwrapMaybeObject accepts object, single-element array, empty, null', () => {
    expect(unwrapMaybeObject<{ x: number }>({ x: 1 })).toEqual({ x: 1 })
    expect(unwrapMaybeObject<{ x: number }>([{ x: 2 }])).toEqual({ x: 2 })
    expect(unwrapMaybeObject([])).toBeNull()
    expect(unwrapMaybeObject(null)).toBeNull()
  })
  it('unwrapArray accepts array, single object, null', () => {
    expect(unwrapArray<number>([1, 2])).toEqual([1, 2])
    expect(unwrapArray<{ x: number }>({ x: 1 })).toEqual([{ x: 1 }])
    expect(unwrapArray(null)).toEqual([])
  })
})

describe('JobsDb RPC exact names and params', () => {
  it('claim_next_story_task passes worker + lease and flattens enriched jsonb', async () => {
    const db = new RecordingDb({ claim_next_story_task: enrichedTask() })
    const jobs = new JobsDb(db)
    const task = await jobs.claimNextStoryTask('w1', 900)
    expect(db.last().fn).toBe('claim_next_story_task')
    expect(db.last().params).toEqual({ p_worker_id: 'w1', p_lease_seconds: 900 })
    expect(task?.story_code).toBe('PRJ-001')
    expect(task?.model.request_timeout_ms).toBe(123456)
    expect(task?.snapshots).toHaveLength(1)
    expect(task?.job.requested_branch).toBe('feature_dev')
  })

  it('claim_next_story_task tolerates a single-element array wrapper', async () => {
    const db = new RecordingDb({ claim_next_story_task: [enrichedTask()] })
    const jobs = new JobsDb(db)
    const task = await jobs.claimNextStoryTask('w1', 900)
    expect(task?.story_code).toBe('PRJ-001')
  })

  it('claim_next_story_task returns null on empty/no id', async () => {
    const jobs1 = new JobsDb(new RecordingDb({ claim_next_story_task: null }))
    expect(await jobs1.claimNextStoryTask('w1', 900)).toBeNull()
    const jobs2 = new JobsDb(new RecordingDb({ claim_next_story_task: {} }))
    expect(await jobs2.claimNextStoryTask('w1', 900)).toBeNull()
  })

  it('claim_job_for_preparation returns enriched job/model', async () => {
    const db = new RecordingDb({
      claim_job_for_preparation: {
        job: { id: 'j', batch_id: 'b', model_config_id: 'm', requested_branch: 'release', total_stories: 1 },
        model: { model_config_id: 'm', base_url: 'u', model_name: 'x', request_timeout_ms: 5000 },
      },
    })
    const jobs = new JobsDb(db)
    const claim = await jobs.claimJobForPreparation('w1')
    expect(db.last().params).toEqual({ p_worker_id: 'w1' })
    expect(claim?.job.requested_branch).toBe('release')
    expect(claim?.model.request_timeout_ms).toBe(5000)
  })

  it('claim_job_for_finalization returns job/model/snapshots or null', async () => {
    const db = new RecordingDb({
      claim_job_for_finalization: {
        job: { id: 'j', batch_id: 'b', model_config_id: 'm', requested_branch: 'feature_dev', total_stories: 2 },
        model: { model_config_id: 'm' },
        snapshots: [{ repository_name: 'tmanage-backend', requested_branch: 'feature_dev', commit_sha: SHA, commit_subject: null }],
      },
    })
    const jobs = new JobsDb(db)
    const claim = await jobs.claimJobForFinalization('w1')
    expect(db.last().fn).toBe('claim_job_for_finalization')
    expect(claim?.snapshots).toHaveLength(1)
    const none = new JobsDb(new RecordingDb({ claim_job_for_finalization: null }))
    expect(await none.claimJobForFinalization('w1')).toBeNull()
  })

  it('save_repository_snapshots passes job/worker/snapshots', async () => {
    const db = new RecordingDb()
    const jobs = new JobsDb(db)
    await jobs.saveRepositorySnapshots('j', 'w1', [
      { repository_name: 'kdmanage-backend', requested_branch: 'feature_dev', commit_sha: SHA, commit_subject: null },
    ])
    expect(db.last().fn).toBe('save_repository_snapshots')
    expect(db.last().params.p_job_id).toBe('j')
    expect(db.last().params.p_worker_id).toBe('w1')
    expect(Array.isArray(db.last().params.p_snapshots)).toBe(true)
  })

  it('heartbeat_story_task passes lease seconds and returns boolean', async () => {
    const db = new RecordingDb({ heartbeat_story_task: true })
    const jobs = new JobsDb(db)
    const ok = await jobs.heartbeatStoryTask('t', 'w1', 900)
    expect(db.last().params).toEqual({ p_task_id: 't', p_worker_id: 'w1', p_lease_seconds: 900 })
    expect(ok).toBe(true)
  })

  it('heartbeat_analysis_worker reports slots and current', async () => {
    const db = new RecordingDb()
    const jobs = new JobsDb(db)
    await jobs.heartbeatAnalysisWorker('w1', 4, 2)
    expect(db.last().fn).toBe('heartbeat_analysis_worker')
    expect(db.last().params).toEqual({ p_worker_id: 'w1', p_slots: 4, p_current: 2 })
  })

  it('save_retrieval_result passes explicit model + prompt columns', async () => {
    const db = new RecordingDb()
    const jobs = new JobsDb(db)
    await jobs.saveRetrievalResult('t', 'w1', { storyCode: 'PRJ-001' } as never, 'gpt', 'retrieval-v1')
    expect(db.last().fn).toBe('save_retrieval_result')
    expect(db.last().params).toMatchObject({
      p_task_id: 't',
      p_worker_id: 'w1',
      p_retrieval_model: 'gpt',
      p_prompt_version: 'retrieval-v1',
    })
    expect(db.last().params.p_result).toBeDefined()
  })

  it('save_analysis_result passes explicit model + prompt columns', async () => {
    const db = new RecordingDb()
    const jobs = new JobsDb(db)
    await jobs.saveAnalysisResult('t', 'w1', { evidence: [] } as never, 'gpt', 'analysis-v1')
    expect(db.last().fn).toBe('save_analysis_result')
    expect(db.last().params).toMatchObject({
      p_analysis_model: 'gpt',
      p_prompt_version: 'analysis-v1',
    })
  })

  it('fail_story_task uses p_error_code / p_error_message + stage', async () => {
    const db = new RecordingDb()
    const jobs = new JobsDb(db)
    await jobs.failStoryTask({ taskId: 't', workerId: 'w1', stage: 'analysis', code: 'X', message: 'boom' })
    expect(db.last().fn).toBe('fail_story_task')
    expect(db.last().params).toEqual({
      p_task_id: 't',
      p_worker_id: 'w1',
      p_stage: 'analysis',
      p_error_code: 'X',
      p_error_message: 'boom',
    })
  })

  it('fail_claimed_analysis_job passes owner and displayable error', async () => {
    const db = new RecordingDb()
    const jobs = new JobsDb(db)
    await jobs.failClaimedAnalysisJob({
      jobId: 'j',
      workerId: 'w1',
      code: 'CODE',
      message: 'msg',
    })
    expect(db.last().fn).toBe('fail_claimed_analysis_job')
    expect(db.last().params).toEqual({
      p_job_id: 'j',
      p_worker_id: 'w1',
      p_error_code: 'CODE',
      p_error_message: 'msg',
    })
  })

  it('get_model_secret_for_job passes worker id', async () => {
    const db = new RecordingDb({ get_model_secret_for_job: 'sk-secret' })
    const jobs = new JobsDb(db)
    const secret = await jobs.getModelSecretForJob('j', 'w1')
    expect(db.last().params).toEqual({ p_job_id: 'j', p_worker_id: 'w1' })
    expect(secret).toBe('sk-secret')
  })

  it('complete_analysis_job passes worker id and NOT p_model', async () => {
    const db = new RecordingDb()
    const jobs = new JobsDb(db)
    await jobs.completeAnalysisJob({ jobId: 'j', workerId: 'w1', results: [{ story_code: 'x' }], evidence: [] })
    expect(db.last().fn).toBe('complete_analysis_job')
    expect(db.last().params).toEqual({
      p_job_id: 'j',
      p_worker_id: 'w1',
      p_results: [{ story_code: 'x' }],
      p_evidence: [],
    })
    expect('p_model' in db.last().params).toBe(false)
  })

  it('list_analysis_story_tasks_for_worker returns an array (object tolerant)', async () => {
    const db = new RecordingDb({
      list_analysis_story_tasks_for_worker: [
        { id: 't1', job_id: 'j', story_id: 's', story_code: 'PRJ-001', retrieval_status: 'SUCCEEDED', analysis_status: 'SUCCEEDED', analysis_output: {} },
      ],
    })
    const jobs = new JobsDb(db)
    const tasks = await jobs.listStoryTasks('j')
    expect(db.last().params).toEqual({ p_job_id: 'j' })
    expect(tasks).toHaveLength(1)
  })
})

describe('normalizeDbErrorCode', () => {
  it('extracts known domain markers from the message', () => {
    expect(normalizeDbErrorCode('rpc save failed: TASK_LEASE_LOST')).toBe('TASK_LEASE_LOST')
    expect(normalizeDbErrorCode('boom MODEL_SECRET_MISSING here')).toBe('MODEL_SECRET_MISSING')
    expect(normalizeDbErrorCode('RESULT_ALREADY_EXISTS')).toBe('RESULT_ALREADY_EXISTS')
  })
  it('falls back to SQLSTATE when no marker present', () => {
    expect(normalizeDbErrorCode('some other error', 'P0001')).toBe('P0001')
  })
  it('returns undefined when nothing recognizable', () => {
    expect(normalizeDbErrorCode('random failure')).toBeUndefined()
    expect(normalizeDbErrorCode(null)).toBeUndefined()
  })
})
