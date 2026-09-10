import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { processStoryTask, type ProcessContext } from '../pipeline/process-story-task.js'
import type { ReviewHarness, AnalysisInput, RetrievalInput, RetrievalTools } from '../ai/harness.js'
import type { AnalysisResult, RetrievalResult } from '../ai/schemas.js'
import type { JobsDb, StoryTask } from '../db/jobs.js'
import { Logger } from '../logger.js'

const SHA = 'a'.repeat(40)
const JOB_ID = '11111111-2222-4333-8444-555555555555'
const TASK_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

function silentLogger(): Logger {
  return new Logger({ sink: () => {}, minLevel: 'error' })
}

/** A fake JobsDb capturing which RPC-equivalent methods were called. */
function fakeJobsDb() {
  const calls: string[] = []
  const saved: Record<string, unknown> = {}
  const db = {
    heartbeatStoryTask: async () => true,
    saveRetrievalResult: async (_t: string, _w: string, r: RetrievalResult) => {
      calls.push('saveRetrievalResult')
      saved.retrieval = r
    },
    saveAnalysisResult: async (_t: string, _w: string, r: unknown) => {
      calls.push('saveAnalysisResult')
      saved.analysis = r
    },
    failStoryTask: async (input: { stage: string; code: string }) => {
      calls.push(`failStoryTask:${input.stage}:${input.code}`)
    },
  } as unknown as JobsDb
  return { db, calls, saved }
}

const RETRIEVAL: RetrievalResult = {
  storyCode: 'PRJ-001',
  summary: 's',
  queries: [],
  searchedRepositories: ['kdmanage-backend'],
  candidates: [
    { repository: 'kdmanage-backend', filePath: 'src/A.java', startLine: 1, endLine: 5, reason: 'r' },
  ],
  insufficientEvidence: false,
}

const MIXED_RETRIEVAL: RetrievalResult = {
  ...RETRIEVAL,
  candidates: [
    ...RETRIEVAL.candidates,
    {
      repository: 'kdmanage-backend',
      filePath: 'tmanage-backend',
      startLine: 1,
      endLine: 1,
      reason: 'model returned a repository-like path that is not a file',
    },
  ],
}

const ANALYSIS: AnalysisResult = {
  storyCode: 'PRJ-001',
  verdict: 'IMPLEMENTED',
  confidence: 90,
  summary: 's',
  implementedContent: 'x',
  missingContent: null,
  risks: null,
  testPoints: null,
  aiRemark: null,
  evidence: [
    {
      repository: 'kdmanage-backend',
      filePath: 'src/A.java',
      startLine: 1,
      endLine: 5,
      evidenceType: '现有实现',
      description: 'impl',
    },
  ],
}

class RecordingHarness implements ReviewHarness {
  retrieveCalls = 0
  analyzeCalls = 0
  analysisInputs: AnalysisInput[] = []
  constructor(
    private analysisResult: AnalysisResult = ANALYSIS,
    private retrievalResult: RetrievalResult = RETRIEVAL,
  ) {}
  async retrieve(_i: RetrievalInput, _t: RetrievalTools): Promise<RetrievalResult> {
    this.retrieveCalls++
    return this.retrievalResult
  }
  async analyze(input: AnalysisInput): Promise<AnalysisResult> {
    this.analyzeCalls++
    this.analysisInputs.push(input)
    return this.analysisResult
  }
}

class ThrowingHarness implements ReviewHarness {
  async retrieve(): Promise<RetrievalResult> {
    const e = new Error('model down') as Error & { code: string }
    e.code = 'MODEL_NETWORK_ERROR'
    throw e
  }
  async analyze(): Promise<AnalysisResult> {
    throw new Error('unused')
  }
}

let root: string
let workspaceRoot: string
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'proc-cache-'))
  workspaceRoot = mkdtempSync(join(tmpdir(), 'proc-workspace-'))
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'A.java'), 'l1\nl2\nl3\nl4\nl5\nl6\n')
})
afterAll(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(workspaceRoot, { recursive: true, force: true })
})

function ctx(): ProcessContext {
  return {
    workerId: 'w1',
    workspaceRoot,
    branch: 'feature_dev',
    modelName: 'gpt',
    heartbeatIntervalMs: 60000,
    leaseSeconds: 900,
    repositories: [{ name: 'kdmanage-backend', commitSha: SHA, path: root }],
  }
}

function baseTask(overrides: Partial<StoryTask> = {}): StoryTask {
  return {
    id: TASK_ID,
    job_id: JOB_ID,
    worker_id: 'w1',
    retrieval_attempt: 1,
    analysis_attempt: 0,
    retrieval_status: 'PENDING',
    analysis_status: 'PENDING',
    lease_expires_at: null,
    retrieval_output: null,
    job: { id: JOB_ID, batch_id: 'b', model_config_id: 'm', requested_branch: 'feature_dev', total_stories: 1 },
    model: { model_config_id: 'm', display_name: 'D', provider: 'openai-compatible', base_url: 'u', model_name: 'gpt', retrieval_prompt_version: 'r', analysis_prompt_version: 'a' },
    snapshots: [{ repository_name: 'kdmanage-backend', requested_branch: 'feature_dev', commit_sha: SHA, commit_subject: null }],
    story: { story_id: 's', story_code: 'PRJ-001', story_name: 'demo', description: 'd', acceptance_criteria: null, project_name: null, application_name: null, source_data: {} },
    story_id: 's',
    story_code: 'PRJ-001',
    story_name: 'demo',
    description: 'd',
    acceptance_criteria: null,
    project_name: null,
    application_name: null,
    source_data: {},
    ...overrides,
  }
}

describe('processStoryTask', () => {
  it('runs both stages and saves only materialized candidates for a fresh task', async () => {
    const { db, calls, saved } = fakeJobsDb()
    const harness = new RecordingHarness(ANALYSIS, MIXED_RETRIEVAL)
    const outcome = await processStoryTask(harness, db, ctx(), baseTask(), silentLogger())
    expect(outcome.ok).toBe(true)
    expect(harness.retrieveCalls).toBe(1)
    expect(harness.analyzeCalls).toBe(1)
    expect(calls).toContain('saveRetrievalResult')
    expect(calls).toContain('saveAnalysisResult')
    expect(saved.retrieval).toEqual(RETRIEVAL)
    expect(harness.analysisInputs[0]?.retrieval).toEqual(RETRIEVAL)
    expect(harness.analysisInputs[0]?.snippets).toHaveLength(1)
    expect(harness.analysisInputs[0]?.snippets[0]?.filePath).toBe('src/A.java')
  })

  it('recovers a saved SUCCEEDED retrieval and skips stage one', async () => {
    const { db, calls } = fakeJobsDb()
    const harness = new RecordingHarness()
    const task = baseTask({ retrieval_status: 'SUCCEEDED', retrieval_output: RETRIEVAL })
    const outcome = await processStoryTask(harness, db, ctx(), task, silentLogger())
    expect(outcome.ok).toBe(true)
    // Stage one skipped and an unchanged recovered result is not saved again.
    expect(harness.retrieveCalls).toBe(0)
    expect(harness.analyzeCalls).toBe(1)
    expect(calls).not.toContain('saveRetrievalResult')
    expect(calls).toContain('saveAnalysisResult')
  })

  it('cleans unavailable candidates from a recovered retrieval before analysis', async () => {
    const { db, calls, saved } = fakeJobsDb()
    const harness = new RecordingHarness()
    const task = baseTask({
      retrieval_status: 'SUCCEEDED',
      retrieval_output: MIXED_RETRIEVAL,
    })
    const outcome = await processStoryTask(harness, db, ctx(), task, silentLogger())
    expect(outcome.ok).toBe(true)
    expect(harness.retrieveCalls).toBe(0)
    expect(calls).toContain('saveRetrievalResult')
    expect(saved.retrieval).toEqual(RETRIEVAL)
    expect(harness.analysisInputs[0]?.retrieval).toEqual(RETRIEVAL)
  })

  it('re-runs stage one when the stored retrieval is malformed', async () => {
    const { db } = fakeJobsDb()
    const harness = new RecordingHarness()
    const task = baseTask({
      retrieval_status: 'SUCCEEDED',
      retrieval_output: { storyCode: 'WRONG' } as unknown as RetrievalResult,
    })
    await processStoryTask(harness, db, ctx(), task, silentLogger())
    expect(harness.retrieveCalls).toBe(1)
  })

  it('calls failStoryTask (with stage) when a stage fails — never only logs', async () => {
    const { db, calls } = fakeJobsDb()
    const harness = new ThrowingHarness()
    const outcome = await processStoryTask(harness, db, ctx(), baseTask(), silentLogger())
    expect(outcome.ok).toBe(false)
    expect(outcome.errorCode).toBe('MODEL_NETWORK_ERROR')
    expect(calls.some((c) => c.startsWith('failStoryTask:retrieval:'))).toBe(true)
  })
})
