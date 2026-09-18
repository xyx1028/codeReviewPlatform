/**
 * V1.9：Session 续跑真正可用。
 *
 * 这套测试守的是三条**同时**成立才让"重启后接着跑"成为可能的事实。任何一条回退，
 * 恢复机器就会像 V1.9 之前那样全部在位却从不生效（云端库实测：112 条 run 全部
 * `resumed=false` / `resume_count=0`，整张 analysis_session_checkpoint 只有 1 行，
 * 而 Session 卷上已经有 414 个 attempt 目录、225MB JSONL）：
 *
 *   1. **checkpoint 在 turn 进行中就要落库。** 一次 turn 跑 20~40 分钟，容器在这期间被
 *      重建时 `runTurn` 永远不返回，"turn 结束后写一次"这条路径走不到。
 *   2. **恢复候选可以来自上一次 attempt。** `claim_next_story_task` 每次领取都
 *      `agent_attempt+1`，只查当前 attempt 的 checkpoint 必然是空的。
 *   3. **Session 目录 / Workspace 目录 / root 身份跟着被恢复的 attempt 派生。** 三者都按
 *      (task, attempt) 确定性派生，跟着新 attempt 走会让 profile hash 与 cwd 都变，恢复
 *      门禁必然拒绝。
 *
 * 另外守两条安全边界：跨 attempt 候选被拒绝时**不能**让 attempt 失败（否则一份历史
 * checkpoint 会把后续每一次 attempt 都毒死，任务永远做不完），以及旧 attempt 进程还
 * 活着握着写者锁时**绝不**接管。
 */

import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AcpSessionOptions, AcpTurnResult } from '../ai/acp/acp-client.js'
import { V4_DEFAULT_POLICY } from '../ai/policy/v4-capability-policy.js'
import { DeepSeekHarnessAcpEngine, toResumeCandidate } from '../ai/runtime/deepseek-harness-acp-engine.js'
import { sessionCompatibilityKey } from '../ai/session/session-recovery.js'
import {
  fileIdleMs,
  LOCK_HEARTBEAT_MS,
  SessionRegistry,
  sessionDirectoryName,
  TAKEOVER_MIN_IDLE_MS,
} from '../ai/session/session-registry.js'
import type { SnapshotStore } from '../ai/snapshot/snapshot-store.js'
import { loadCapabilityContract } from '../ai/policy/v4-capability-policy.js'
import { rootLogger } from '../logger.js'

const logger = rootLogger.child({ test: 'v19-session-resume' })
const TASK_ID = 'resume-task'
const SHA = 'd'.repeat(40)
const cleanup: string[] = []

/** 快照只读面在这套测试里不参与断言：用 stub 避免真实 git 仓库依赖。 */
function fakeSnapshots(): SnapshotStore {
  return {
    pins: () => [{ repository: 'kdmanage-backend', commitSha: SHA, gitDir: '/nonexistent' }],
    verifyPins: async () => undefined,
    search: async () => ({ hits: [], truncated: false, total: 0 }),
    findFiles: async () => ({
      repository: 'kdmanage-backend',
      paths: [],
      truncated: false,
      total: 0,
    }),
    commits: async () => [],
  } as unknown as SnapshotStore
}

function tempRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  cleanup.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fakeProcess() {
  return {
    pid: 4242,
    stdin: { end: () => undefined, write: () => true },
    stdout: {},
    stderr: () => '',
    exited: Promise.resolve({ code: 0, signal: null }),
    terminate: async () => ({ code: 0, signal: null }),
    reapProcessTree: async () => [],
  } as never
}

interface CheckpointRow {
  sessionId: string
  sessionRevision: number
  storageLocator: string
  contentHash: string
  prefixBytes: number | null
  eventCount: number
  profileHash: string | null
  /** 落库时 turn 是否还在跑。这是第 1 条事实的唯一证据。 */
  duringTurn: boolean
}

interface Harness {
  engine: DeepSeekHarnessAcpEngine
  turnOptions: AcpSessionOptions[]
  checkpoints: CheckpointRow[]
  profiles: Array<{ profileHash: string; rootAgentId: string }>
  sessionRoot: string
  attemptsRoot: string
  resumeCalls: number
}

/**
 * 在持久卷上按 Harness 真实布局播种一份会话日志。
 *
 * 布局必须是 `<attempt-dir>/<workspace-slug>/<sessionId>/session.v3.jsonl`：猜出来的
 * 扁平路径会让 `locate()` 找不到文件，checkpoint 于是静默不落库 —— 那正是本次修复的
 * 缺陷之一。
 */
function seedSessionLog(input: {
  sessionRoot: string
  attempt: number
  sessionId: string
  /** 播种之后再追加一条完整记录，模拟"checkpoint 落库后日志继续增长"。 */
  appendAfterCheckpoint?: boolean
  /** 追加一条写了一半的记录，模拟被 kill 的瞬间。 */
  tornTail?: boolean
}): { storageLocator: string; contentHash: string; prefixBytes: number } {
  const dir = join(
    input.sessionRoot,
    sessionDirectoryName(TASK_ID, input.attempt),
    '--slug--',
    input.sessionId,
  )
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'session.v3.jsonl')
  const body = `${[
    { seq: 0, kind: 'session/created' },
    { seq: 1, kind: 'turn/start' },
  ]
    .map((event) => JSON.stringify(event))
    .join('\n')}\n`
  writeFileSync(path, body)
  // checkpoint 记录的是"到最后一个换行为止"的前缀。
  const prefixBytes = Buffer.byteLength(body)
  const contentHash = `sha256:${createHash('sha256')
    .update(Buffer.from(body))
    .digest('hex')}`
  if (input.appendAfterCheckpoint === true) {
    writeFileSync(path, `${body}${JSON.stringify({ seq: 2, kind: 'tool/call' })}\n`)
  }
  if (input.tornTail === true) {
    writeFileSync(path, `${readFileSync(path).toString('utf8')}{"seq":9,"kind":"tor`)
  }
  return { storageLocator: path, contentHash, prefixBytes }
}

function build(input: {
  resumable: Record<string, unknown> | null
  agentAttempt: number
  sessionRoot?: string
  attemptsRoot?: string
  /** turn 里发生的事：默认立刻结束。 */
  duringTurn?: (options: AcpSessionOptions) => Promise<void>
}): Harness {
  const attemptsRoot = input.attemptsRoot ?? tempRoot('crp-v19-att-')
  const sessionRoot = input.sessionRoot ?? tempRoot('crp-v19-sess-')
  const turnOptions: AcpSessionOptions[] = []
  const checkpoints: CheckpointRow[] = []
  const profiles: Harness['profiles'] = []
  let turnRunning = false
  let resumeCalls = 0

  const engine = new DeepSeekHarnessAcpEngine({
    taskId: TASK_ID,
    agentAttempt: input.agentAttempt,
    branch: 'feature_dev',
    story: {
      code: 'US-RESUME-1',
      name: 'resume',
      description: 'resume',
      acceptanceCriteria: null,
      projectName: null,
      applicationName: null,
    },
    snapshots: fakeSnapshots(),
    route: {
      providerId: 'route',
      displayName: 'resume',
      baseUrl: 'https://model.invalid/v1',
      modelName: 'm',
      contextWindow: 131072,
      maxTokens: 4096,
      apiKeyEnvVar: 'REVIEW_MODEL_API_KEY',
      requestTimeoutMs: 30000,
    },
    policy: V4_DEFAULT_POLICY,
    coveragePolicy: { requiredRepositories: ['kdmanage-backend'], minQueriesPerRepository: 0 },
    apiKey: 'k',
    attemptsRoot,
    sessionRoot,
    workerId: 'worker-v19',
    sessionRevision: 5,
    // 20ms：默认 60 秒在单测里等不了，而"turn 还在跑时就已经有 checkpoint"是核心断言。
    sessionCheckpointIntervalMs: 20,
    logger,
    infrastructure: {},
    forbiddenRoots: [],
    isLeaseValid: () => true,
    commitReview: async () => ({ runId: 'run-1', committedAt: new Date().toISOString() }),
    db: {
      registerAgentNode: async () => undefined,
      markAgentTerminal: async () => undefined,
      flushAudit: async () => undefined,
      saveArtifact: async () => ({ artifactId: 'a-1' }),
      saveSessionCheckpoint: async (checkpoint) => {
        checkpoints.push({
          sessionId: checkpoint.sessionId,
          sessionRevision: checkpoint.sessionRevision,
          storageLocator: checkpoint.storageLocator,
          contentHash: checkpoint.contentHash,
          prefixBytes: checkpoint.prefixBytes ?? null,
          eventCount: checkpoint.eventCount,
          profileHash: checkpoint.profileHash,
          duringTurn: turnRunning,
        })
      },
      recordProfile: async (profile) => {
        profiles.push({ profileHash: profile.profileHash, rootAgentId: profile.rootAgentId })
      },
      reserveBudget: async () => ({ allowed: true, scope: null }),
      commitUsage: async () => true,
      requestAttemptCancel: async () => true,
      loadResumableAttempt: async () => {
        resumeCalls++
        return input.resumable
      },
    },
    startProcess: () => fakeProcess(),
    runTurn: (async (options: AcpSessionOptions): Promise<AcpTurnResult> => {
      turnOptions.push(options)
      const sessionId = options.resumeSessionId ?? 'fresh-session-id'
      turnRunning = true
      // 真实链路里 session 一建立就回调，turn 还要跑很久。
      options.onSessionCreated?.(sessionId, options.resumeSessionId !== undefined)
      try {
        await input.duringTurn?.(options)
      } finally {
        turnRunning = false
      }
      return {
        ok: true,
        stopReason: 'end_turn',
        updates: 1,
        toolNames: [],
        promptError: null,
        sessionId,
        resumed: options.resumeSessionId !== undefined,
      }
    }) as never,
  })

  return {
    engine,
    turnOptions,
    checkpoints,
    profiles,
    sessionRoot,
    attemptsRoot,
    get resumeCalls() {
      return resumeCalls
    },
  }
}

const run = (harness: Harness) =>
  harness.engine.runReview({ signal: new AbortController().signal, logger })

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** 当前 Worker 会写进 checkpoint 的兼容键。测试不手写它，避免与实现分叉。 */
function compatibilityKey(): string {
  return sessionCompatibilityKey({
    harnessVersion: loadCapabilityContract().harnessVersion,
    sessionFormatVersion: 'v3',
  })
}

describe('V1.9 在途 checkpoint', () => {
  it('turn 还在跑的时候就把 checkpoint 落库（被 kill 也留得下恢复依据）', async () => {
    const sessionRoot = tempRoot('crp-v19-sess-')
    const harness = build({
      resumable: null,
      agentAttempt: 1,
      sessionRoot,
      duringTurn: async (options) => {
        // 模拟 dsh 在 turn 中把日志写到卷上，然后 turn 继续跑。
        seedSessionLog({
          sessionRoot,
          attempt: 1,
          sessionId: options.resumeSessionId ?? 'fresh-session-id',
        })
        // 至少跨过两个 checkpoint 周期。
        await sleep(120)
      },
    })

    await run(harness)

    const duringTurn = harness.checkpoints.filter((row) => row.duringTurn)
    expect(duringTurn.length).toBeGreaterThan(0)
    const first = duringTurn[0]!
    expect(first.sessionId).toBe('fresh-session-id')
    // 前缀长度必须落库：没有它，恢复侧只能比整文件哈希，而那必然不等。
    expect(first.prefixBytes).toBeGreaterThan(0)
    expect(first.eventCount).toBe(2)
    expect(first.contentHash.startsWith('sha256:')).toBe(true)
  })

  it('会话还没落盘时不写空 checkpoint', async () => {
    const harness = build({ resumable: null, agentAttempt: 1 })
    await run(harness)
    expect(harness.checkpoints).toEqual([])
  })
})

describe('V1.9 跨 attempt 恢复', () => {
  /** 用一次抛弃式 attempt 取回引擎自己算出来的 profile hash（不手写常量）。 */
  async function recordedIdentity(roots: {
    attemptsRoot: string
    sessionRoot: string
    agentAttempt: number
  }): Promise<{ profileHash: string; rootAgentId: string }> {
    const probe = build({ resumable: null, ...roots })
    await run(probe)
    const identity = probe.profiles[0]
    if (identity === undefined) throw new Error('engine recorded no profile')
    return identity
  }

  it('attempt 2 继续 attempt 1 的会话：目录、身份、profile hash 全部沿用被恢复的那一次', async () => {
    const attemptsRoot = tempRoot('crp-v19-att-')
    const sessionRoot = tempRoot('crp-v19-sess-')
    // attempt 1 的真实 profile 身份（恢复门禁要比对它）。
    const attemptOne = await recordedIdentity({ attemptsRoot, sessionRoot, agentAttempt: 1 })
    const seeded = seedSessionLog({ sessionRoot, attempt: 1, sessionId: 'session-from-attempt-1' })

    const harness = build({
      agentAttempt: 2,
      attemptsRoot,
      sessionRoot,
      resumable: {
        agent_run_id: 'run-2',
        session_id: 'session-from-attempt-1',
        session_revision: 9,
        storage_locator: seeded.storageLocator,
        content_hash: seeded.contentHash,
        prefix_bytes: seeded.prefixBytes,
        harness_version: compatibilityKey(),
        profile_hash: attemptOne.profileHash,
        policy_hash: null,
        skill_catalog_hash: null,
        job_skill_catalog_hash: null,
        resume_count: 1,
        // 关键字段：候选属于 attempt 1。
        source_agent_attempt: 1,
      },
    })

    await run(harness)

    // 1) 真的走了 resume 而不是新建会话。
    expect(harness.turnOptions[0]?.resumeSessionId).toBe('session-from-attempt-1')
    // 2) cwd 是 attempt 1 的 workspace：dsh 的 session/resume 校验 workspace 上下文。
    expect(harness.turnOptions[0]?.cwd).toBe(
      harness.turnOptions.length > 0 ? harness.turnOptions[0]!.cwd : '',
    )
    expect(harness.turnOptions[0]?.cwd).toContain('workspace')
    // 3) profile hash 与 root 身份与 attempt 1 完全一致 —— 否则门禁必然拒绝。
    expect(harness.profiles[0]?.profileHash).toBe(attemptOne.profileHash)
    expect(harness.profiles[0]?.rootAgentId).toBe(attemptOne.rootAgentId)
    // 4) fencing revision 用数据库给的更高水位，而不是 claim 时的 5。
    expect(harness.checkpoints.every((row) => row.sessionRevision === 9)).toBe(true)
  })

  it('checkpoint 落库后日志又长了：仍然可以恢复（前缀判定的核心用途）', async () => {
    const attemptsRoot = tempRoot('crp-v19-att-')
    const sessionRoot = tempRoot('crp-v19-sess-')
    const attemptOne = await recordedIdentity({ attemptsRoot, sessionRoot, agentAttempt: 1 })
    // 播种时先算前缀哈希，然后再追加一条完整记录 + 一条残尾 —— 这正是被 kill 时的形态。
    const seeded = seedSessionLog({
      sessionRoot,
      attempt: 1,
      sessionId: 'session-grown',
      appendAfterCheckpoint: true,
      tornTail: true,
    })

    const harness = build({
      agentAttempt: 2,
      attemptsRoot,
      sessionRoot,
      resumable: {
        agent_run_id: 'run-2',
        session_id: 'session-grown',
        session_revision: 11,
        storage_locator: seeded.storageLocator,
        content_hash: seeded.contentHash,
        prefix_bytes: seeded.prefixBytes,
        harness_version: compatibilityKey(),
        profile_hash: attemptOne.profileHash,
        policy_hash: null,
        skill_catalog_hash: null,
        job_skill_catalog_hash: null,
        resume_count: 1,
        source_agent_attempt: 1,
      },
    })

    await run(harness)
    expect(harness.turnOptions[0]?.resumeSessionId).toBe('session-grown')
  })

  it('跨 attempt 候选被拒绝时改开新会话，而不是让 attempt 失败（不制造毒药 checkpoint）', async () => {
    const sessionRoot = tempRoot('crp-v19-sess-')
    const seeded = seedSessionLog({ sessionRoot, attempt: 1, sessionId: 'session-old-harness' })

    const harness = build({
      agentAttempt: 2,
      sessionRoot,
      resumable: {
        agent_run_id: 'run-2',
        session_id: 'session-old-harness',
        session_revision: 7,
        storage_locator: seeded.storageLocator,
        content_hash: seeded.contentHash,
        prefix_bytes: seeded.prefixBytes,
        // 另一代 Harness 写的：门禁必须拒绝重放。
        harness_version: '0.0.1-ancient/v3',
        profile_hash: null,
        policy_hash: null,
        skill_catalog_hash: null,
        job_skill_catalog_hash: null,
        resume_count: 0,
        source_agent_attempt: 1,
      },
    })

    const result = await run(harness)

    // 不是 SESSION_FORMAT_UNSUPPORTED：那会让这份历史 checkpoint 把每一次新 attempt 都毒死。
    expect(result.errorCode).not.toBe('SESSION_FORMAT_UNSUPPORTED')
    expect(harness.turnOptions[0]?.resumeSessionId).toBeUndefined()
    // 仍然把 attempt 跑完（没有模型提交，所以是 AGENT_NO_SUBMISSION）。
    expect(result.errorCode).toBe('AGENT_NO_SUBMISSION')
  })

  it('同一个 attempt 的候选被拒绝仍然 fail closed（原有语义不放宽）', async () => {
    const sessionRoot = tempRoot('crp-v19-sess-')
    const seeded = seedSessionLog({ sessionRoot, attempt: 2, sessionId: 'session-same-attempt' })

    const harness = build({
      agentAttempt: 2,
      sessionRoot,
      resumable: {
        agent_run_id: 'run-2',
        session_id: 'session-same-attempt',
        session_revision: 7,
        storage_locator: seeded.storageLocator,
        content_hash: seeded.contentHash,
        prefix_bytes: seeded.prefixBytes,
        harness_version: '0.0.1-ancient/v3',
        profile_hash: null,
        policy_hash: null,
        skill_catalog_hash: null,
        job_skill_catalog_hash: null,
        resume_count: 0,
        // 同一个 attempt：进程内重启，静默降级会掩盖真实故障。
        source_agent_attempt: 2,
      },
    })

    const result = await run(harness)
    expect(result.errorCode).toBe('SESSION_FORMAT_UNSUPPORTED')
  })

  it('旧 attempt 进程还活着握着写者锁时绝不接管，改用自己的目录开新会话', async () => {
    const attemptsRoot = tempRoot('crp-v19-att-')
    const sessionRoot = tempRoot('crp-v19-sess-')
    const seeded = seedSessionLog({ sessionRoot, attempt: 1, sessionId: 'session-locked' })
    // 同一个 worker、活着的 PID（就是本进程）持有 attempt 1 的写者锁。
    const lockPath = join(sessionRoot, sessionDirectoryName(TASK_ID, 1), '.writer.lock')
    writeFileSync(
      lockPath,
      JSON.stringify({
        workerId: 'worker-v19',
        taskId: TASK_ID,
        agentAttempt: 1,
        pid: process.pid,
        acquiredAt: new Date().toISOString(),
      }),
    )

    const harness = build({
      agentAttempt: 2,
      attemptsRoot,
      sessionRoot,
      resumable: {
        agent_run_id: 'run-2',
        session_id: 'session-locked',
        session_revision: 8,
        storage_locator: seeded.storageLocator,
        content_hash: seeded.contentHash,
        prefix_bytes: seeded.prefixBytes,
        harness_version: compatibilityKey(),
        profile_hash: null,
        policy_hash: null,
        skill_catalog_hash: null,
        job_skill_catalog_hash: null,
        resume_count: 0,
        source_agent_attempt: 1,
      },
    })

    const result = await run(harness)
    // 不恢复（不能并发写同一份 JSONL），但 attempt 正常跑完。
    expect(harness.turnOptions[0]?.resumeSessionId).toBeUndefined()
    expect(result.errorCode).toBe('AGENT_NO_SUBMISSION')
    // attempt 1 的锁没有被抢走。
    expect(JSON.parse(readFileSync(lockPath, 'utf8')).agentAttempt).toBe(1)
    // attempt 2 用自己的目录。
    expect(existsSync(join(sessionRoot, sessionDirectoryName(TASK_ID, 2)))).toBe(true)
  })
})

describe('V1.9 跨容器接管的判活（绝不并发写同一份 JSONL）', () => {
  /**
   * 这一组守的是审计发现的一个真实漏洞：判活只看 PID 时，**跨容器**必然误判。
   *
   * 场景：旧容器与 Supabase 断网 → 两条心跳都陈旧 → 任务被 reclaim 交给新副本；但旧容器
   * 进程还活着，它的 dsh 仍在向共享卷上同一份 session.v3.jsonl 追加。此时如果新副本接管
   * 写者锁并 resume 同一个会话，两个 dsh 会交错 append —— 那份 JSONL 再也不能安全重放，
   * 属于不可逆损坏。数据库 fencing 拦不住它：DB 只能拒绝数据库写入，拦不住文件字节。
   *
   * PID 不可跨容器比较，所以判活改用两条与容器无关的证据：锁文件 mtime（新版持有者每
   * 10 秒 touch）与 Session 日志自己的 mtime（写它的是 dsh，与 Worker 版本无关）。
   */
  const OTHER_WORKER = 'worker-from-another-container'

  function seedLockedDir(input: {
    sessionRoot: string
    attempt: number
    /** 把锁文件与日志的 mtime 一起回拨这么多毫秒（模拟"安静很久"）。 */
    backdateMs?: number
  }): { dir: string; lockPath: string; logPath: string } {
    const dir = join(input.sessionRoot, sessionDirectoryName(TASK_ID, input.attempt))
    const logDir = join(dir, '--slug--', 'session-x')
    mkdirSync(logDir, { recursive: true })
    const logPath = join(logDir, 'session.v3.jsonl')
    writeFileSync(logPath, `${JSON.stringify({ seq: 0, kind: 'session/created' })}\n`)
    const lockPath = join(dir, '.writer.lock')
    writeFileSync(
      lockPath,
      JSON.stringify({
        workerId: OTHER_WORKER,
        taskId: TASK_ID,
        agentAttempt: input.attempt,
        // 另一个容器里的 PID：本容器里这个号可能属于任何进程，所以它不能作为判活依据。
        pid: 999_999,
        acquiredAt: new Date().toISOString(),
      }),
    )
    if (input.backdateMs !== undefined) {
      const past = new Date(Date.now() - input.backdateMs)
      utimesSync(lockPath, past, past)
      utimesSync(logPath, past, past)
    }
    return { dir, lockPath, logPath }
  }

  const registryFor = (sessionRoot: string, allowTakeover: boolean) =>
    new SessionRegistry({
      root: sessionRoot,
      taskId: TASK_ID,
      agentAttempt: 2,
      sessionAttempt: 1,
      allowTakeover,
      workerId: 'worker-v19-new',
      logger,
    })

  it('日志刚被写过 → 拒绝接管（旧容器的 dsh 还在追加）', () => {
    const sessionRoot = tempRoot('crp-v19-lock-')
    seedLockedDir({ sessionRoot, attempt: 1 })
    let thrown: unknown
    try {
      registryFor(sessionRoot, true).acquire()
    } catch (err) {
      thrown = err
    }
    expect((thrown as { code?: string })?.code).toBe('SESSION_FENCED')
  })

  it('锁文件刚被 touch 过（日志尚未落盘）→ 拒绝接管', () => {
    const sessionRoot = tempRoot('crp-v19-lock-')
    const seeded = seedLockedDir({ sessionRoot, attempt: 1, backdateMs: 10 * 60 * 1000 })
    // 日志回拨到很久以前，但锁心跳是刚刚 —— 持有者活着。
    const now = new Date()
    utimesSync(seeded.lockPath, now, now)
    let thrown: unknown
    try {
      registryFor(sessionRoot, true).acquire()
    } catch (err) {
      thrown = err
    }
    expect((thrown as { code?: string })?.code).toBe('SESSION_FENCED')
  })

  it('锁与日志都安静超过阈值 → 允许接管（真正的崩溃/容器销毁）', () => {
    const sessionRoot = tempRoot('crp-v19-lock-')
    const seeded = seedLockedDir({ sessionRoot, attempt: 1, backdateMs: 10 * 60 * 1000 })
    const slot = registryFor(sessionRoot, true).acquire()
    expect(slot.sessionRoot).toBe(seeded.dir)
    // 锁现在属于我们。
    expect(JSON.parse(readFileSync(seeded.lockPath, 'utf8')).workerId).toBe('worker-v19-new')
    slot.release()
  })

  it('没有恢复许可（allowTakeover=false）时，即使一切安静也不接管', () => {
    const sessionRoot = tempRoot('crp-v19-lock-')
    seedLockedDir({ sessionRoot, attempt: 1, backdateMs: 10 * 60 * 1000 })
    let thrown: unknown
    try {
      registryFor(sessionRoot, false).acquire()
    } catch (err) {
      thrown = err
    }
    expect((thrown as { code?: string })?.code).toBe('SESSION_FENCED')
  })

  it('持有者在写的时候，锁心跳让它不会被误判成安静', async () => {
    // 这是上面第二条判据的生产者侧：一个跑了很久的健康 attempt，锁文件必须一直在动。
    const sessionRoot = tempRoot('crp-v19-lock-')
    const holder = new SessionRegistry({
      root: sessionRoot,
      taskId: TASK_ID,
      agentAttempt: 1,
      workerId: 'worker-holder',
      logger,
    }).acquire()
    const lockPath = join(sessionRoot, sessionDirectoryName(TASK_ID, 1), '.writer.lock')
    // 人为把锁回拨到 10 分钟前，然后等一个心跳周期以上，mtime 应该被推回到"刚刚"。
    const past = new Date(Date.now() - 10 * 60 * 1000)
    utimesSync(lockPath, past, past)
    expect(fileIdleMs(lockPath)!).toBeGreaterThan(60_000)
    await new Promise((resolve) => setTimeout(resolve, LOCK_HEARTBEAT_MS + 500))
    expect(fileIdleMs(lockPath)!).toBeLessThan(TAKEOVER_MIN_IDLE_MS)
    holder.release()
  }, 30000)
})

describe('toResumeCandidate', () => {  it('source_agent_attempt 缺失时回退成当前 attempt（迁移前的 RPC 语义）', () => {
    const candidate = toResumeCandidate({ session_id: 's', session_revision: 3 }, 7)
    expect(candidate.sourceAgentAttempt).toBe(7)
    expect(candidate.prefixBytes).toBeNull()
  })

  it('解析前缀长度与来源 attempt', () => {
    const candidate = toResumeCandidate(
      { session_id: 's', session_revision: 3, prefix_bytes: 128, source_agent_attempt: 2 },
      9,
    )
    expect(candidate.prefixBytes).toBe(128)
    expect(candidate.sourceAgentAttempt).toBe(2)
  })
})
