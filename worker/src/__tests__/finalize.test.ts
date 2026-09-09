import { describe, it, expect } from 'vitest'
import { aggregateResults, finalizeJob, EmptyAnalysisError } from '../pipeline/finalize-job.js'
import type { StoryTaskSummary, FinalizationClaim } from '../db/jobs.js'
import { JobsDb } from '../db/jobs.js'
import type { DbClient } from '../db/client.js'
import { Logger } from '../logger.js'

const SHA = 'a'.repeat(40)

function silentLogger(): Logger {
  return new Logger({ sink: () => {}, minLevel: 'error' })
}

function task(overrides: Partial<StoryTaskSummary> = {}): StoryTaskSummary {
  return {
    id: 't1',
    job_id: 'j',
    story_id: 's',
    story_code: 'PRJ-001',
    retrieval_status: 'SUCCEEDED',
    analysis_status: 'SUCCEEDED',
    analysis_output: {
      verdict: 'IMPLEMENTED',
      confidence: 88,
      summary: 'done',
      implementedContent: 'impl',
      missingContent: null,
      risks: null,
      testPoints: 'tp',
      aiRemark: null,
      evidence: [
        {
          repository: 'kdmanage-backend',
          filePath: 'src/A.java',
          symbolName: 'foo',
          startLine: 1,
          endLine: 10,
          evidenceType: '现有实现',
          description: 'here',
          commitSha: SHA,
        },
      ],
    },
    ...overrides,
  }
}

describe('aggregateResults camelCase -> snake_case mapping', () => {
  it('maps result and evidence keys to DB snake_case', () => {
    const { results, evidence } = aggregateResults([task()])
    expect(results).toHaveLength(1)
    expect(results[0]).toEqual({
      story_code: 'PRJ-001',
      verdict: 'IMPLEMENTED',
      confidence: 88,
      summary: 'done',
      implemented_content: 'impl',
      missing_content: null,
      risks: null,
      test_points: 'tp',
      ai_remark: null,
    })
    expect(evidence).toHaveLength(1)
    expect(evidence[0]).toEqual({
      story_code: 'PRJ-001',
      repository_name: 'kdmanage-backend',
      commit_sha: SHA,
      file_path: 'src/A.java',
      symbol_name: 'foo',
      start_line: 1,
      end_line: 10,
      evidence_type: '现有实现',
      description: 'here',
    })
  })

  it('skips tasks without analysis_output', () => {
    const { results } = aggregateResults([task({ analysis_output: null })])
    expect(results).toHaveLength(0)
  })
})

class FakeFinalizeDb implements DbClient {
  calls: Array<{ fn: string; params: Record<string, unknown> }> = []
  constructor(private tasks: StoryTaskSummary[]) {}
  async rpc<T = unknown>(fn: string, params: Record<string, unknown>): Promise<T> {
    this.calls.push({ fn, params })
    if (fn === 'list_analysis_story_tasks_for_worker') return this.tasks as unknown as T
    return null as T
  }
}

const claim: FinalizationClaim = {
  job: { id: 'j', batch_id: 'b', model_config_id: 'm', requested_branch: 'feature_dev', total_stories: 1 },
  model: { model_config_id: 'm', display_name: 'D', provider: 'openai-compatible', base_url: 'u', model_name: 'x', retrieval_prompt_version: 'r', analysis_prompt_version: 'a' },
  snapshots: [],
}

describe('finalizeJob', () => {
  it('completes with worker id and mapped results', async () => {
    const db = new FakeFinalizeDb([task()])
    const jobs = new JobsDb(db)
    const res = await finalizeJob(jobs, claim, 'w1', silentLogger())
    expect(res.finalized).toBe(true)
    const complete = db.calls.find((c) => c.fn === 'complete_analysis_job')
    expect(complete?.params.p_worker_id).toBe('w1')
    expect('p_model' in (complete?.params ?? {})).toBe(false)
  })

  it('fails (throws) when there is no analysis output', async () => {
    const db = new FakeFinalizeDb([task({ analysis_output: null })])
    const jobs = new JobsDb(db)
    await expect(finalizeJob(jobs, claim, 'w1', silentLogger())).rejects.toBeInstanceOf(
      EmptyAnalysisError,
    )
    expect(db.calls.find((c) => c.fn === 'complete_analysis_job')).toBeUndefined()
  })
})
