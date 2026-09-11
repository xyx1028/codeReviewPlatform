import { describe, expect, it } from 'vitest'
import { SlotPool } from '../coordination/concurrency.js'
import type { DbClient } from '../db/client.js'
import { JobsDb, type AgentRunUsage, type StoryTask } from '../db/jobs.js'

const SHA = 'a'.repeat(40)
const USAGE: AgentRunUsage = {
  tool_calls: 0,
  evidence_shown: 0,
  searches_run: 0,
  retry_requests: 0,
  compaction_requests: 0,
}

type AgentStatus = 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED'

interface FakeRow {
  id: string
  agent_status: AgentStatus
  agent_attempt: number
  agent_output: Record<string, unknown> | null
  worker_id: string | null
  claim_token: string | null
  lease_expires_at: number | null
}

/**
 * In-memory model of the canonical Agent RPCs. Tokens are kept in plaintext in
 * this test double; production stores only their digest. Time is injectable so
 * lease expiry and takeover are deterministic.
 */
class FakeCluster implements DbClient {
  readonly rows: FakeRow[]
  now = 1_000
  jobStatus: 'PROCESSING' | 'FAILED' = 'PROCESSING'
  private tokenSequence = 0
  private receiptSequence = 0

  constructor(count: number, private readonly maxParallel = 100) {
    this.rows = Array.from({ length: count }, (_, index) => ({
      id: `task-${index}`,
      agent_status: 'PENDING',
      agent_attempt: 0,
      agent_output: null,
      worker_id: null,
      claim_token: null,
      lease_expires_at: null,
    }))
  }

  private activeLeases(): number {
    return this.rows.filter(
      (row) => row.lease_expires_at !== null && row.lease_expires_at >= this.now,
    ).length
  }

  private claimedTask(row: FakeRow): Record<string, unknown> {
    return {
      id: row.id,
      job_id: 'job-1',
      worker_id: row.worker_id,
      lease_expires_at:
        row.lease_expires_at === null ? null : new Date(row.lease_expires_at).toISOString(),
      agent_status: row.agent_status,
      agent_attempt: row.agent_attempt,
      claim_token: row.claim_token,
      job: {
        id: 'job-1',
        batch_id: 'batch-1',
        model_config_id: 'model-1',
        requested_branch: 'feature_dev',
        total_stories: this.rows.length,
      },
      model: {
        model_config_id: 'model-1',
        display_name: 'DeepSeek',
        base_url: 'https://model.invalid/v1',
        model_name: 'deepseek-chat',
        max_parallel_tasks: this.maxParallel,
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
        story_id: row.id,
        story_code: row.id,
        story_name: 'story',
        description: null,
        acceptance_criteria: null,
        project_name: null,
        application_name: null,
        source_data: {},
      },
    }
  }

  async rpc<T = unknown>(fn: string, params: Record<string, unknown>): Promise<T> {
    switch (fn) {
      case 'claim_next_story_task': {
        if (this.jobStatus !== 'PROCESSING' || this.activeLeases() >= this.maxParallel) {
          return null as T
        }
        const row = this.rows.find(
          (candidate) =>
            candidate.agent_status !== 'SUCCEEDED' &&
            candidate.agent_status !== 'FAILED' &&
            (candidate.lease_expires_at === null || candidate.lease_expires_at < this.now),
        )
        if (!row) return null as T

        row.worker_id = String(params.p_worker_id)
        row.lease_expires_at = this.now + Number(params.p_lease_seconds) * 1_000
        row.agent_status = 'RUNNING'
        row.agent_attempt += 1
        row.claim_token = `claim-${++this.tokenSequence}`
        return this.claimedTask(row) as T
      }

      case 'heartbeat_story_task': {
        const row = this.rows.find((candidate) => candidate.id === params.p_task_id)
        const valid =
          this.jobStatus === 'PROCESSING' &&
          row !== undefined &&
          row.worker_id === params.p_worker_id &&
          row.claim_token === params.p_claim_token &&
          row.lease_expires_at !== null &&
          row.lease_expires_at >= this.now
        if (!valid || !row) return false as T

        row.lease_expires_at = this.now + Number(params.p_lease_seconds) * 1_000
        return true as T
      }

      case 'save_agent_review_result': {
        const row = this.rows.find((candidate) => candidate.id === params.p_task_id)
        if (!row) throw new Error('task not found')
        if (this.jobStatus !== 'PROCESSING') throw new Error('job is not processing')
        if (
          row.worker_id !== params.p_worker_id ||
          row.lease_expires_at === null ||
          row.lease_expires_at < this.now
        ) {
          throw new Error('TASK_LEASE_LOST')
        }
        if (
          row.claim_token !== params.p_claim_token ||
          row.agent_attempt !== params.p_agent_attempt
        ) {
          throw new Error('AGENT_CLAIM_INVALID')
        }

        row.agent_status = 'SUCCEEDED'
        row.agent_output = params.p_result as Record<string, unknown>
        row.worker_id = null
        row.claim_token = null
        row.lease_expires_at = null
        return {
          run_id: `run-${++this.receiptSequence}`,
          committed_at: '2026-01-01T00:00:00.000Z',
        } as T
      }

      case 'fail_agent_review': {
        const row = this.rows.find((candidate) => candidate.id === params.p_task_id)
        const ownsClaim =
          row !== undefined &&
          row.worker_id === params.p_worker_id &&
          row.claim_token === params.p_claim_token &&
          row.lease_expires_at !== null &&
          row.lease_expires_at >= this.now
        if (!ownsClaim || !row) throw new Error('TASK_LEASE_LOST')

        for (const candidate of this.rows) {
          if (candidate.id === row.id) candidate.agent_status = 'FAILED'
          else if (candidate.agent_status === 'RUNNING') candidate.agent_status = 'PENDING'
          candidate.worker_id = null
          candidate.claim_token = null
          candidate.lease_expires_at = null
        }
        this.jobStatus = 'FAILED'
        return null as T
      }

      default:
        return null as T
    }
  }

  allDone(): boolean {
    return this.rows.every((row) => row.agent_status === 'SUCCEEDED')
  }
}

async function saveResult(task: StoryTask, jobs: JobsDb, workerId: string): Promise<void> {
  await jobs.saveAgentReviewResult({
    taskId: task.id,
    workerId,
    claimToken: task.claim_token,
    agentAttempt: task.agent_attempt,
    result: { verdict: 'PASS', summary: `reviewed ${task.story_code}` },
    evidence: [],
    usage: USAGE,
    configHash: null,
    promptVersion: 'agent-review-v1',
    modelLabel: 'DeepSeek / deepseek-chat',
  })
}

/** Mirrors the production claim loop while using the production SlotPool. */
async function runWorker(
  workerId: string,
  jobs: JobsDb,
  slots: number,
  processTask: (task: StoryTask, jobs: JobsDb, workerId: string) => Promise<void>,
): Promise<{ processed: string[] }> {
  const pool = new SlotPool(slots)
  const processed: string[] = []
  const inFlight = new Set<Promise<void>>()

  const launch = async (task: StoryTask): Promise<void> => {
    const release = await pool.acquire()
    const run = processTask(task, jobs, workerId)
      .then(() => {
        processed.push(task.id)
      })
      .catch(() => undefined)
      .finally(() => {
        release()
        inFlight.delete(run)
      })
    inFlight.add(run)
  }

  for (;;) {
    while (pool.availableSlots > 0) {
      const task = await jobs.claimNextStoryTask(workerId, 900)
      if (!task) break
      await launch(task)
    }

    if (inFlight.size === 0) break
    await Promise.race(inFlight)
  }

  await Promise.allSettled(inFlight)
  return { processed }
}

describe('single-Agent scheduling', () => {
  it('lets replicas process every task exactly once', async () => {
    const cluster = new FakeCluster(12)
    const jobs = new JobsDb(cluster)

    const workers = await Promise.all([
      runWorker('w1', jobs, 2, saveResult),
      runWorker('w2', jobs, 2, saveResult),
      runWorker('w3', jobs, 3, saveResult),
    ])
    const processed = workers.flatMap((worker) => worker.processed).sort()

    expect(processed).toHaveLength(12)
    expect(new Set(processed).size).toBe(processed.length)
    expect(cluster.allDone()).toBe(true)
  })

  it('never exceeds a worker local slot limit', async () => {
    const cluster = new FakeCluster(20)
    const jobs = new JobsDb(cluster)
    let active = 0
    let maxActive = 0

    await runWorker('w1', jobs, 2, async (task, db, workerId) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      try {
        await new Promise<void>((resolve) => setTimeout(resolve, 5))
        await saveResult(task, db, workerId)
      } finally {
        active -= 1
      }
    })

    expect(maxActive).toBe(2)
    expect(cluster.allDone()).toBe(true)
  })

  it('enforces model-level concurrency across workers', async () => {
    const cluster = new FakeCluster(4, 1)
    const jobs = new JobsDb(cluster)
    const first = await jobs.claimNextStoryTask('w1', 900)

    expect(first).not.toBeNull()
    expect(await jobs.claimNextStoryTask('w2', 900)).toBeNull()

    await saveResult(first as StoryTask, jobs, 'w1')
    expect(await jobs.claimNextStoryTask('w2', 900)).not.toBeNull()
  })

  it('allows lease takeover with a new token and rejects the previous owner', async () => {
    const cluster = new FakeCluster(1)
    const jobs = new JobsDb(cluster)
    const stale = await jobs.claimNextStoryTask('crashed', 900)

    expect(stale).not.toBeNull()
    expect(await jobs.claimNextStoryTask('survivor', 900)).toBeNull()

    cluster.now += 901_000
    const takeover = await jobs.claimNextStoryTask('survivor', 900)

    expect(takeover).toMatchObject({ id: stale?.id, agent_status: 'RUNNING', agent_attempt: 2 })
    expect(takeover?.claim_token).not.toBe(stale?.claim_token)
    expect(
      await jobs.heartbeatStoryTask({
        taskId: (stale as StoryTask).id,
        workerId: 'crashed',
        claimToken: (stale as StoryTask).claim_token,
        leaseSeconds: 900,
      }),
    ).toBe(false)
    await expect(saveResult(stale as StoryTask, jobs, 'crashed')).rejects.toThrow(
      'TASK_LEASE_LOST',
    )

    await saveResult(takeover as StoryTask, jobs, 'survivor')
    expect(cluster.allDone()).toBe(true)
  })

  it('rejects a stale token and attempt after the same worker reclaims a task', async () => {
    const cluster = new FakeCluster(1)
    const jobs = new JobsDb(cluster)
    const stale = await jobs.claimNextStoryTask('w1', 900)

    cluster.now += 901_000
    const current = await jobs.claimNextStoryTask('w1', 900)

    expect(current?.agent_attempt).toBe(2)
    expect(current?.claim_token).not.toBe(stale?.claim_token)
    await expect(saveResult(stale as StoryTask, jobs, 'w1')).rejects.toThrow(
      'AGENT_CLAIM_INVALID',
    )
    await saveResult(current as StoryTask, jobs, 'w1')
  })

  it('fails one Agent task, revokes siblings, and rejects their late writes', async () => {
    const cluster = new FakeCluster(3)
    const jobs = new JobsDb(cluster)
    const completed = await jobs.claimNextStoryTask('w1', 900)
    const failed = await jobs.claimNextStoryTask('w2', 900)
    const sibling = await jobs.claimNextStoryTask('w3', 900)

    expect(completed && failed && sibling).toBeTruthy()
    await saveResult(completed as StoryTask, jobs, 'w1')
    await jobs.failAgentReview({
      taskId: (failed as StoryTask).id,
      workerId: 'w2',
      claimToken: (failed as StoryTask).claim_token,
      code: 'E_TEST',
      message: 'boom',
    })

    expect(cluster.jobStatus).toBe('FAILED')
    expect(cluster.rows.map((row) => row.agent_status)).toEqual([
      'SUCCEEDED',
      'FAILED',
      'PENDING',
    ])
    expect(cluster.rows.every((row) => row.worker_id === null)).toBe(true)
    expect(cluster.rows.every((row) => row.claim_token === null)).toBe(true)
    expect(cluster.rows.every((row) => row.lease_expires_at === null)).toBe(true)
    expect(cluster.rows[0]?.agent_output).toMatchObject({ verdict: 'PASS' })

    expect(
      await jobs.heartbeatStoryTask({
        taskId: (sibling as StoryTask).id,
        workerId: 'w3',
        claimToken: (sibling as StoryTask).claim_token,
        leaseSeconds: 900,
      }),
    ).toBe(false)
    await expect(
      jobs.failAgentReview({
        taskId: (sibling as StoryTask).id,
        workerId: 'w3',
        claimToken: (sibling as StoryTask).claim_token,
        code: 'LATE_FAILURE',
        message: 'too late',
      }),
    ).rejects.toThrow('TASK_LEASE_LOST')
    await expect(saveResult(sibling as StoryTask, jobs, 'w3')).rejects.toThrow(
      'job is not processing',
    )
    expect(await jobs.claimNextStoryTask('w4', 900)).toBeNull()
  })
})
