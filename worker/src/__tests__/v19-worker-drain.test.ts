/**
 * V1.9 §3：Worker drain（不中断在途任务的发布）。
 *
 * 这套测试守的是一次真实的、每次发布都会重演的损失：
 * `docker compose up -d --force-recreate` 会销毁正在跑 attempt 的容器，平台随后只能
 * `agent_attempt+1` 从零重跑（2026-09-17 19:59 的事故里 8 个在途 attempt 变成
 * WORKER_LOST，浪费 47.9 分钟模型时间）。drain 是"发布前把在途任务跑完"的唯一机制，
 * 所以它的每一条语义都必须可断言：
 *
 *   1. 没有 drain 时正常领取任务；
 *   2. sentinel 文件出现后**不再领取任何东西**（Story 任务、Job 准备、Job 收尾、
 *      模型连接测试全部停），但在途任务不被打断；
 *   3. 在途归零后写出 `DRAINED.<worker-id>` 标记 —— 发布脚本只信这个文件；
 *   4. 删除 sentinel 后恢复领取，并删掉标记；
 *   5. 心跳里带 draining/active_attempts，调度中心能区分"忙"和"正在排空"；
 *   6. 进程启动时清掉上一条命残留的 DRAINED 标记（否则脚本会误判可以重建）。
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkerConfig } from '../config.js'
import type { DbClient } from '../db/client.js'
import { JobsDb } from '../db/jobs.js'
import {
  DRAIN_SENTINEL,
  startWorker,
  workerDrainedMarker,
  workerDrainSentinel,
  type WorkerRuntime,
} from '../index.js'
import { DISABLED_LINKY_CONFIG } from './helpers/worker-config.js'

const SHA = 'c'.repeat(40)

/**
 * 只回答 drain 需要的那几个 RPC。
 *
 * claim_next_story_task 每次返回一个新任务，直到 `claimsAllowed` 用完 —— 这样"drain 之后
 * 还在领取"会立刻表现为计数增长，而不是靠时间窗猜。
 */
class FakeDb implements DbClient {
  readonly calls: string[] = []
  readonly heartbeats: Array<Record<string, unknown>> = []
  claimsAllowed = 0
  claimed = 0
  released = 0

  async rpc<T = unknown>(fn: string, params: Record<string, unknown>): Promise<T> {
    this.calls.push(fn)
    switch (fn) {
      case 'heartbeat_analysis_worker':
        this.heartbeats.push(params)
        return undefined as T
      case 'claim_next_story_task': {
        if (this.claimsAllowed <= 0) return null as T
        this.claimsAllowed -= 1
        this.claimed += 1
        return this.task(`task-${this.claimed}`) as T
      }
      case 'release_story_task_claim':
        this.released += 1
        return true as T
      case 'reclaim_stale_story_task_leases':
        return 0 as T
      case 'fail_agent_review':
      case 'commit_analysis_agent_usage':
        return true as T
      default:
        // 其它 claim 类 RPC 一律返回"没活"，让轮询循环空转。
        return null as T
    }
  }

  /**
   * 一个 snapshots 为空的任务。
   *
   * 故意为空：`prepareTaskRepositories` 于是不做任何 git 操作，
   * `buildDeepSeekHarnessReview` 立刻以"requires prepared repositories"失败，
   * attempt 在毫秒级收敛。这套测试要断言的是调度器的 drain 语义，不是引擎。
   */
  private task(id: string): Record<string, unknown> {
    return {
      id,
      job_id: 'job-1',
      worker_id: 'worker-drain-test',
      lease_expires_at: new Date(Date.now() + 900_000).toISOString(),
      agent_status: 'RUNNING',
      agent_attempt: 1,
      claim_token: 'token-1',
      capability_policy: {},
      policy_version: 4,
      policy_hash: null,
      agent_run_id: null,
      session_revision: 1,
      job: {
        id: 'job-1',
        batch_id: 'batch-1',
        model_config_id: 'model-1',
        requested_branch: 'feature_dev',
        total_stories: 1,
      },
      model: {
        model_config_id: 'model-1',
        display_name: 'Fake',
        base_url: 'https://model.invalid/v1',
        model_name: 'fake-model',
        max_parallel_tasks: 8,
      },
      snapshots: [],
      story: {
        story_id: 'story-1',
        story_code: 'US-DRAIN-1',
        story_name: 'drain',
        description: null,
        acceptance_criteria: null,
        project_name: null,
        application_name: null,
        source_data: {},
      },
      story_id: 'story-1',
      story_code: 'US-DRAIN-1',
      story_name: 'drain',
      description: null,
      acceptance_criteria: null,
      project_name: null,
      application_name: null,
      source_data: {},
      commit_sha: SHA,
    }
  }
}

function buildConfig(root: string): WorkerConfig {
  return {
    supabaseUrl: 'https://supabase.invalid',
    supabaseServiceRoleKey: 'test-key',
    gitAuthMode: 'local',
    gitlabBaseUrl: 'https://gitlab.invalid',
    gitlabDeployUser: null,
    gitlabDeployToken: null,
    gitlabApiToken: null,
    workerId: 'worker-drain-test',
    workspaceRoot: root,
    codeCacheRoot: join(root, 'cache'),
    codeCacheMaxBytes: 1024 * 1024 * 1024,
    pollIntervalMs: 500,
    storyTaskLeaseSeconds: 900,
    heartbeatIntervalMs: 30000,
    workerStoryConcurrency: 2,
    modelConnectivityTestLeaseSeconds: 90,
    gitEmailDiscoveryLeaseSeconds: 90,
    modelConnectivityProxy: null,
    linky: DISABLED_LINKY_CONFIG,
    agentAttemptsRoot: join(root, 'attempts'),
    skillCacheRoot: join(root, 'skill-cache'),
    skillCacheMaxBytes: 256 * 1024 * 1024,
    modelImageInputEnabled: false,
    sessionRoot: join(root, 'sessions'),
    sessionRetentionDays: 7,
    sessionVolumeMaxBytes: 64 * 1024 * 1024,
    orphanWorkspaceMaxAgeMs: 60_000,
    // V1.23：问答轮询开关。测试里关掉 —— 这些用例验证的是评审链路。
    codeQa: { enabled: false, leaseSeconds: 600, turnTimeoutMs: 900000 },
    runtimeEvents: {
      enabled: false,
      flushMs: 800,
      queueMax: 512,
      batchMax: 64,
      retentionDays: 30,
    },
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** 等一个条件成立，最长 `timeoutMs`；超时即失败并带上最后一次观测。 */
async function waitFor(
  predicate: () => boolean,
  describeFailure: () => string,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await sleep(25)
  }
  throw new Error(`timed out waiting: ${describeFailure()}`)
}

describe('worker drain（发布前排空，不中断在途任务）', () => {
  const started: WorkerRuntime[] = []
  const roots: string[] = []

  afterEach(async () => {
    for (const runtime of started.splice(0)) await runtime.stop()
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  const boot = (db: FakeDb): { runtime: WorkerRuntime; root: string; config: WorkerConfig } => {
    const root = mkdtempSync(join(tmpdir(), 'worker-drain-'))
    roots.push(root)
    const config = buildConfig(root)
    const runtime = startWorker(config, { jobsDb: new JobsDb(db) })
    started.push(runtime)
    return { runtime, root, config }
  }

  it('sentinel 文件出现后停止领取，在途归零则写出 DRAINED 标记；删除后恢复领取', async () => {    const db = new FakeDb()
    db.claimsAllowed = 1
    const { runtime, root, config } = boot(db)

    // 1) 正常状态下会领取。
    await waitFor(() => db.claimed === 1, () => `claimed=${db.claimed}`)
    expect(runtime.drainStatus().draining).toBe(false)

    // 2) 写 sentinel：不再领取任何任务。
    writeFileSync(join(root, DRAIN_SENTINEL), '')
    await waitFor(
      () => runtime.drainStatus().draining,
      () => `drainStatus=${JSON.stringify(runtime.drainStatus())}`,
    )

    db.claimsAllowed = 5
    const claimedAtDrain = db.claimed
    const callsAtDrain = db.calls.length
    await sleep(1500)
    expect(db.claimed).toBe(claimedAtDrain)
    // 连 claim 类 RPC 都不该再发出：drained 必须等价于"手上没有任何 claim"。
    const claimCallsAfterDrain = db.calls
      .slice(callsAtDrain)
      .filter((call) => call.startsWith('claim_') || call === 'reclaim_stale_story_task_leases')
    expect(claimCallsAfterDrain).toEqual([])

    // 3) 在途归零 → DRAINED 标记出现（发布脚本的唯一判据）。
    const marker = join(root, workerDrainedMarker(config.workerId))
    await waitFor(() => existsSync(marker), () => `marker ${marker} missing`)
    expect(runtime.drainStatus()).toEqual({ draining: true, active: 0, drained: true })

    // 4) 心跳里能看出正在排空（可用性心跳每 5 秒一次，所以这里要等下一拍）。
    await waitFor(
      () =>
        db.heartbeats.some(
          (heartbeat) =>
            (heartbeat.p_capabilities as Record<string, unknown> | undefined)?.draining === true,
        ),
      () => `heartbeats=${JSON.stringify(db.heartbeats.map((h) => h.p_capabilities))}`,
      8000,
    )

    // 5) 删除 sentinel → 恢复领取并清掉标记。
    rmSync(join(root, DRAIN_SENTINEL))
    await waitFor(() => db.claimed > claimedAtDrain, () => `claimed=${db.claimed}`)
    expect(existsSync(marker)).toBe(false)
    expect(runtime.drainStatus().draining).toBe(false)
    // 可用性心跳每 5 秒一拍，所以这条用例要比默认 5 秒超时宽。
  }, 30000)

  it('单副本 sentinel（DRAIN.<worker-id>）同样生效', async () => {
    const db = new FakeDb()
    db.claimsAllowed = 0
    const { runtime, root, config } = boot(db)
    await waitFor(
      () => db.calls.includes('claim_next_story_task'),
      () => 'worker never polled for tasks',
    )

    writeFileSync(join(root, workerDrainSentinel(config.workerId)), '')
    await waitFor(
      () => runtime.drainStatus().drained,
      () => `drainStatus=${JSON.stringify(runtime.drainStatus())}`,
    )
    expect(existsSync(join(root, workerDrainedMarker(config.workerId)))).toBe(true)
  })

  it('drain() / undrain() 可编程调用，且启动时清掉上一条命残留的 DRAINED 标记', async () => {
    const root = mkdtempSync(join(tmpdir(), 'worker-drain-stale-'))
    roots.push(root)
    const config = buildConfig(root)
    // 上一条命留下的标记：同一个 WORKER_ID 会随容器重启复用，残留标记会让发布脚本
    // 以为"这个副本已经空了"，于是又一次在途 attempt 被摧毁。
    const marker = join(root, workerDrainedMarker(config.workerId))
    writeFileSync(marker, 'stale')

    const db = new FakeDb()
    const runtime = startWorker(config, { jobsDb: new JobsDb(db) })
    started.push(runtime)
    expect(existsSync(marker)).toBe(false)

    runtime.drain('API')
    expect(runtime.drainStatus().draining).toBe(true)
    await waitFor(() => existsSync(marker), () => 'programmatic drain wrote no marker')

    runtime.undrain()
    expect(runtime.drainStatus().draining).toBe(false)
    expect(existsSync(marker)).toBe(false)
  })
})
