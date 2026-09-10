import { describe, it, expect } from 'vitest'
import { JobsDb, type StoryTask } from '../db/jobs.js'
import type { DbClient } from '../db/client.js'

const SHA = 'a'.repeat(40)

interface FakeRow {
  id: string
  retrieval_status: 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED'
  analysis_status: 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED'
  retrieval_output: unknown | null
  analysis_output: unknown | null
  worker_id: string | null
  lease_expires_at: number | null // epoch ms
}

/**
 * In-memory fake of the analysis RPCs that models the lease semantics of
 * claim_next_story_task / heartbeat / save / fail. `now` is injectable so tests
 * can expire leases deterministically. One shared job in PROCESSING.
 */
class FakeCluster implements DbClient {
  rows: FakeRow[]
  now = 0
  jobStatus: 'PROCESSING' | 'FAILED' = 'PROCESSING'
  private maxParallel: number

  constructor(count: number, maxParallel = 100) {
    this.maxParallel = maxParallel
    this.rows = Array.from({ length: count }, (_, i) => ({
      id: `task-${i}`,
      retrieval_status: 'PENDING',
      analysis_status: 'PENDING',
      retrieval_output: null,
      analysis_output: null,
      worker_id: null,
      lease_expires_at: null,
    }))
  }

  private activeLeases(): number {
    return this.rows.filter(
      (r) =>
        r.lease_expires_at !== null &&
        r.lease_expires_at >= this.now &&
        !(r.retrieval_status === 'SUCCEEDED' && r.analysis_status === 'SUCCEEDED') &&
        r.retrieval_status !== 'FAILED' &&
        r.analysis_status !== 'FAILED',
    ).length
  }

  private enrich(row: FakeRow): Record<string, unknown> {
    return {
      id: row.id,
      job_id: 'job-1',
      retrieval_status: row.retrieval_status,
      analysis_status: row.analysis_status,
      lease_expires_at: row.lease_expires_at ? String(row.lease_expires_at) : null,
      retrieval_output: row.retrieval_output,
      job: { id: 'job-1', batch_id: 'b', model_config_id: 'm', requested_branch: 'feature_dev', total_stories: this.rows.length },
      model: { model_config_id: 'm', base_url: 'u', model_name: 'x', request_timeout_ms: 1000 },
      snapshots: [{ repository_name: 'kdmanage-backend', requested_branch: 'feature_dev', commit_sha: SHA, commit_subject: null }],
      story: { story_id: row.id, story_code: row.id, story_name: 'n', description: null, acceptance_criteria: null, project_name: null, application_name: null, source_data: {} },
    }
  }

  async rpc<T = unknown>(fn: string, params: Record<string, unknown>): Promise<T> {
    switch (fn) {
      case 'claim_next_story_task': {
        if (this.jobStatus !== 'PROCESSING') return null as T
        if (this.activeLeases() >= this.maxParallel) return null as T
        const row = this.rows.find(
          (r) =>
            r.retrieval_status !== 'FAILED' &&
            r.analysis_status !== 'FAILED' &&
            !(r.retrieval_status === 'SUCCEEDED' && r.analysis_status === 'SUCCEEDED') &&
            (r.lease_expires_at === null || r.lease_expires_at < this.now),
        )
        if (!row) return null as T
        row.worker_id = params.p_worker_id as string
        row.lease_expires_at = this.now + (params.p_lease_seconds as number) * 1000
        if (row.retrieval_status !== 'SUCCEEDED') row.retrieval_status = 'RUNNING'
        else if (row.analysis_status !== 'SUCCEEDED') row.analysis_status = 'RUNNING'
        return this.enrich(row) as T
      }
      case 'heartbeat_story_task': {
        const row = this.rows.find((r) => r.id === params.p_task_id)
        if (!row || row.worker_id !== params.p_worker_id) return false as T
        if (row.lease_expires_at === null || row.lease_expires_at < this.now) return false as T
        row.lease_expires_at = this.now + (params.p_lease_seconds as number) * 1000
        return true as T
      }
      case 'save_retrieval_result': {
        const row = this.rows.find((r) => r.id === params.p_task_id)
        if (
          !row ||
          row.worker_id !== params.p_worker_id ||
          row.lease_expires_at === null ||
          row.lease_expires_at < this.now
        ) {
          throw new Error('TASK_LEASE_LOST')
        }
        row.retrieval_status = 'SUCCEEDED'
        row.retrieval_output = params.p_result
        return null as T
      }
      case 'save_analysis_result': {
        const row = this.rows.find((r) => r.id === params.p_task_id)
        if (
          !row ||
          row.worker_id !== params.p_worker_id ||
          row.lease_expires_at === null ||
          row.lease_expires_at < this.now
        ) {
          throw new Error('TASK_LEASE_LOST')
        }
        row.analysis_status = 'SUCCEEDED'
        row.analysis_output = params.p_result
        return null as T
      }
      case 'fail_story_task': {
        const row = this.rows.find((r) => r.id === params.p_task_id)
        if (
          !row ||
          row.worker_id !== params.p_worker_id ||
          row.lease_expires_at === null ||
          row.lease_expires_at < this.now
        ) {
          throw new Error('TASK_LEASE_LOST')
        }
        if (params.p_stage === 'retrieval') row.retrieval_status = 'FAILED'
        else row.analysis_status = 'FAILED'
        for (const sibling of this.rows) {
          if (sibling.retrieval_status === 'RUNNING') sibling.retrieval_status = 'PENDING'
          if (sibling.analysis_status === 'RUNNING') sibling.analysis_status = 'PENDING'
          sibling.lease_expires_at = null
          sibling.worker_id = null
        }
        this.jobStatus = 'FAILED'
        return null as T
      }
      case 'heartbeat_analysis_worker':
        return null as T
      default:
        return null as T
    }
  }

  allDone(): boolean {
    return this.rows.every((r) => r.retrieval_status === 'SUCCEEDED' && r.analysis_status === 'SUCCEEDED')
  }
}

/**
 * A minimal worker mirroring index.ts's global claim loop: claim up to the slot
 * capacity, process each task (save both stages), release the slot. `process`
 * is injectable so we can simulate a crash mid-task.
 */
async function runWorker(
  workerId: string,
  jobs: JobsDb,
  slots: number,
  processFn: (task: StoryTask, jobs: JobsDb, workerId: string) => Promise<void>,
): Promise<{ processed: string[] }> {
  const processed: string[] = []
  const inFlight = new Set<Promise<void>>()

  const launch = (task: StoryTask): void => {
    const p = processFn(task, jobs, workerId)
      .then(() => {
        processed.push(task.id)
      })
      .catch(() => undefined)
      .finally(() => {
        inFlight.delete(p)
      })
    inFlight.add(p)
  }

  for (;;) {
    if (inFlight.size >= slots) {
      await Promise.race(inFlight)
      continue
    }
    const task = await jobs.claimNextStoryTask(workerId, 900)
    if (!task) {
      if (inFlight.size > 0) {
        // Let outstanding tasks finish; they may free nothing more to claim.
        await Promise.race(inFlight)
        continue
      }
      break
    }
    launch(task)
  }
  await Promise.allSettled(inFlight)
  return { processed }
}

async function normalProcess(task: StoryTask, jobs: JobsDb, workerId: string): Promise<void> {
  await jobs.saveRetrievalResult(task.id, workerId, {} as never, 'm', 'r')
  await jobs.saveAnalysisResult(task.id, workerId, { evidence: [] } as never, 'm', 'a')
}

describe('global multi-worker scheduling', () => {
  it('multiple replicas cooperate on one batch; every task processed exactly once', async () => {
    const cluster = new FakeCluster(12)
    const jobs = new JobsDb(cluster)
    const workers = await Promise.all([
      runWorker('w1', jobs, 2, normalProcess),
      runWorker('w2', jobs, 2, normalProcess),
      runWorker('w3', jobs, 3, normalProcess),
    ])
    const all = workers.flatMap((w) => w.processed).sort()
    // No task processed twice (a valid lease blocks a second claim).
    expect(new Set(all).size).toBe(all.length)
    expect(cluster.allDone()).toBe(true)
    expect(all).toHaveLength(12)
  })

  it('a replica bounded by SlotPool never exceeds its local capacity', async () => {
    const cluster = new FakeCluster(20)
    const jobs = new JobsDb(cluster)
    let maxActive = 0
    let active = 0
    await runWorker('w1', jobs, 2, async (task, j, w) => {
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise((r) => setTimeout(r, 5))
      await j.saveRetrievalResult(task.id, w, {} as never, 'm', 'r')
      await j.saveAnalysisResult(task.id, w, { evidence: [] } as never, 'm', 'a')
      active--
    })
    expect(maxActive).toBeLessThanOrEqual(2)
    expect(cluster.allDone()).toBe(true)
  })

  it('a crashed worker\'s lease expires and a surviving worker takes over', async () => {
    const cluster = new FakeCluster(3)
    const jobs = new JobsDb(cluster)

    // Worker A claims all 3 then "crashes" (never saves results).
    for (let i = 0; i < 3; i++) {
      const t = await jobs.claimNextStoryTask('crashed', 900)
      expect(t).not.toBeNull()
    }
    // Nothing claimable while A holds valid leases.
    expect(await jobs.claimNextStoryTask('survivor', 900)).toBeNull()

    // Time passes beyond the lease; A's leases expire.
    cluster.now += 901 * 1000

    // Survivor now takes over and finishes everything.
    const res = await runWorker('survivor', jobs, 2, normalProcess)
    expect(cluster.allDone()).toBe(true)
    expect(res.processed.sort()).toEqual(['task-0', 'task-1', 'task-2'])
  })

  it('respects model-level max_parallel_tasks enforced server-side', async () => {
    // Server allows only 1 active lease at a time across the cluster.
    const cluster = new FakeCluster(4, 1)
    const jobs = new JobsDb(cluster)
    const t1 = await jobs.claimNextStoryTask('w1', 900)
    expect(t1).not.toBeNull()
    // Second claim blocked by max_parallel even from a different worker.
    expect(await jobs.claimNextStoryTask('w2', 900)).toBeNull()
    // Finish t1, then next becomes claimable.
    await normalProcess(t1 as StoryTask, jobs, 'w1')
    expect(await jobs.claimNextStoryTask('w2', 900)).not.toBeNull()
  })

  it('revokes sibling leases and rejects late writes when one task fails', async () => {
    const cluster = new FakeCluster(3)
    const jobs = new JobsDb(cluster)
    const completed = await jobs.claimNextStoryTask('w1', 900)
    const failed = await jobs.claimNextStoryTask('w2', 900)
    const sibling = await jobs.claimNextStoryTask('w3', 900)
    expect(completed && failed && sibling).toBeTruthy()

    await jobs.saveRetrievalResult(
      (completed as StoryTask).id,
      'w1',
      { done: 'retrieval' } as never,
      'm',
      'r',
    )
    await jobs.saveAnalysisResult(
      (completed as StoryTask).id,
      'w1',
      { done: 'analysis', evidence: [] } as never,
      'm',
      'a',
    )
    await jobs.failStoryTask({
      taskId: (failed as StoryTask).id,
      workerId: 'w2',
      stage: 'retrieval',
      code: 'E_TEST',
      message: 'boom',
    })

    expect(cluster.jobStatus).toBe('FAILED')
    expect(cluster.rows.every((row) => row.worker_id === null)).toBe(true)
    expect(cluster.rows.every((row) => row.lease_expires_at === null)).toBe(true)
    expect(cluster.rows[0]?.retrieval_status).toBe('SUCCEEDED')
    expect(cluster.rows[0]?.analysis_status).toBe('SUCCEEDED')
    expect(cluster.rows[0]?.retrieval_output).toEqual({ done: 'retrieval' })
    expect(cluster.rows[1]?.retrieval_status).toBe('FAILED')
    expect(cluster.rows[2]?.retrieval_status).toBe('PENDING')
    expect(await jobs.heartbeatStoryTask((sibling as StoryTask).id, 'w3', 900)).toBe(false)
    await expect(jobs.saveRetrievalResult(
      (sibling as StoryTask).id,
      'w3',
      {} as never,
      'm',
      'r',
    )).rejects.toThrow('TASK_LEASE_LOST')
    expect(await jobs.claimNextStoryTask('w4', 900)).toBeNull()
  })
})
