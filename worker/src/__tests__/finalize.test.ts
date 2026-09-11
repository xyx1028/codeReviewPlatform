import { describe, expect, it } from 'vitest'
import type { DbClient } from '../db/client.js'
import { JobsDb, type CompletedStoryTask, type FinalizationClaim } from '../db/jobs.js'
import { Logger } from '../logger.js'
import {
  aggregateCompletedResults,
  EmptyAnalysisError,
  finalizeJob,
} from '../pipeline/finalize-job.js'

const SHA = 'a'.repeat(40)

function silentLogger(): Logger {
  return new Logger({ sink: () => undefined, minLevel: 'error' })
}

function completedTask(overrides: Partial<CompletedStoryTask> = {}): CompletedStoryTask {
  return {
    id: 'task-1',
    job_id: 'job-1',
    story_id: 'story-1',
    story_code: 'PRJ-001',
    agent_status: 'SUCCEEDED',
    output: {
      verdict: 'IMPLEMENTED',
      confidence: 88,
      summary: 'implemented',
      implementedContent: 'implementation details',
      missingContent: null,
      risks: 'low risk',
      testPoints: 'exercise the endpoint',
      aiRemark: 'reviewed',
      evidence: [
        {
          repository: 'unverified-repository',
          filePath: 'unverified/path.ts',
          startLine: 1,
          endLine: 2,
        },
      ],
    },
    verified_evidence: [
      {
        evidence_id: 'evidence-1',
        repository_name: 'kdmanage-backend',
        commit_sha: SHA,
        file_path: 'src/OrderService.java',
        start_line: 10,
        end_line: 20,
        evidence_type: 'existing implementation',
        description: 'verified by the platform',
      },
    ],
    ...overrides,
  }
}

describe('aggregateCompletedResults', () => {
  it('maps committed output and platform-verified evidence to database fields', () => {
    const { results, evidence } = aggregateCompletedResults([completedTask()])

    expect(results).toEqual([
      {
        story_code: 'PRJ-001',
        verdict: 'IMPLEMENTED',
        confidence: 88,
        summary: 'implemented',
        implemented_content: 'implementation details',
        missing_content: null,
        risks: 'low risk',
        test_points: 'exercise the endpoint',
        ai_remark: 'reviewed',
      },
    ])
    expect(evidence).toEqual([
      {
        story_code: 'PRJ-001',
        repository_name: 'kdmanage-backend',
        commit_sha: SHA,
        file_path: 'src/OrderService.java',
        symbol_name: null,
        start_line: 10,
        end_line: 20,
        evidence_type: 'existing implementation',
        description: 'verified by the platform',
      },
    ])
  })

  it('never promotes model-authored evidence when the verified ledger is empty', () => {
    const { results, evidence } = aggregateCompletedResults([
      completedTask({ verified_evidence: [] }),
    ])

    expect(results).toHaveLength(1)
    expect(evidence).toEqual([])
  })

  it('skips tasks without committed Agent output', () => {
    const { results, evidence } = aggregateCompletedResults([completedTask({ output: null })])

    expect(results).toEqual([])
    expect(evidence).toEqual([])
  })
})

interface RpcCall {
  fn: string
  params: Record<string, unknown>
}

class FakeFinalizeDb implements DbClient {
  readonly calls: RpcCall[] = []

  constructor(private readonly tasks: CompletedStoryTask[]) {}

  async rpc<T = unknown>(fn: string, params: Record<string, unknown>): Promise<T> {
    this.calls.push({ fn, params })
    if (fn === 'list_completed_story_tasks') return this.tasks as T
    return undefined as T
  }
}

const claim: FinalizationClaim = {
  job: {
    id: 'job-1',
    batch_id: 'batch-1',
    model_config_id: 'model-1',
    requested_branch: 'feature_dev',
    total_stories: 1,
  },
  model: {
    model_config_id: 'model-1',
    display_name: 'Review model',
    base_url: 'https://model.example.com/v1',
    model_name: 'review-model',
  },
  snapshots: [],
}

describe('finalizeJob single Harness workflow', () => {
  it('loads completed tasks and commits their aggregate with worker ownership', async () => {
    const task = completedTask()
    const db = new FakeFinalizeDb([task])
    const jobs = new JobsDb(db)

    await expect(finalizeJob(jobs, claim, 'worker-1', silentLogger())).resolves.toEqual({
      finalized: true,
    })

    expect(db.calls[0]).toEqual({
      fn: 'list_completed_story_tasks',
      params: { p_job_id: 'job-1' },
    })
    expect(db.calls[1]).toEqual({
      fn: 'complete_analysis_job',
      params: {
        p_job_id: 'job-1',
        p_worker_id: 'worker-1',
        p_results: [
          {
            story_code: 'PRJ-001',
            verdict: 'IMPLEMENTED',
            confidence: 88,
            summary: 'implemented',
            implemented_content: 'implementation details',
            missing_content: null,
            risks: 'low risk',
            test_points: 'exercise the endpoint',
            ai_remark: 'reviewed',
          },
        ],
        p_evidence: [
          {
            story_code: 'PRJ-001',
            repository_name: 'kdmanage-backend',
            commit_sha: SHA,
            file_path: 'src/OrderService.java',
            symbol_name: null,
            start_line: 10,
            end_line: 20,
            evidence_type: 'existing implementation',
            description: 'verified by the platform',
          },
        ],
      },
    })
    expect(db.calls).toHaveLength(2)
  })

  it('throws when no completed task has committed output', async () => {
    const db = new FakeFinalizeDb([completedTask({ output: null })])
    const jobs = new JobsDb(db)

    await expect(finalizeJob(jobs, claim, 'worker-1', silentLogger())).rejects.toMatchObject({
      name: 'EmptyAnalysisError',
      code: 'ANALYSIS_OUTPUT_EMPTY',
    } satisfies Partial<EmptyAnalysisError>)
    expect(db.calls).toEqual([
      { fn: 'list_completed_story_tasks', params: { p_job_id: 'job-1' } },
    ])
  })
})
