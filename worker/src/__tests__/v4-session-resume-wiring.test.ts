/**
 * WP6 接线验收：Session 恢复真的被引擎调用了。
 *
 * 这套测试存在的理由很具体：`evaluateResume` 和 `loadResumableAttempt` 各自都有完备的
 * 单测，但"构件正确"不等于"编排接上了"。一次独立审核发现它们在生产代码里零调用点 ——
 * checkpoint 一直在写，却从来没有读回，于是"Worker 重启后可继续同一未提交 Session"这条
 * 完成标准在生产上并不成立。
 *
 * 所以这里断言的不是判定规则（那已经测过了），而是引擎的行为：
 *   * 没有 checkpoint 时走新建会话；
 *   * 有可恢复 checkpoint 时把 sessionId 传给 ACP，走 resume 而不是 session/new；
 *   * 格式不兼容 / 日志 torn / 被别的写者改过时终止本次 attempt 并报稳定错误码，
 *     而不是静默降级成新会话。
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DeepSeekHarnessAcpEngine,
  MAX_SESSION_RESUMES,
} from '../ai/runtime/deepseek-harness-acp-engine.js'
import { sessionDirectoryName } from '../ai/session/session-registry.js'
import { sessionCompatibilityKey } from '../ai/session/session-recovery.js'
import { loadCapabilityContract } from '../ai/policy/v4-capability-policy.js'
import { V4_DEFAULT_POLICY, policyHash as hashPolicy } from '../ai/policy/v4-capability-policy.js'
import { V4_ERROR_CODES } from '../ai/policy/v4-errors.js'
import { hashContent } from '../ai/snapshot/git-object-reader.js'
import { rootLogger } from '../logger.js'
import type { AcpProcessHandle } from '../ai/acp/acp-process-supervisor.js'
import type { AcpSessionOptions, AcpTurnResult } from '../ai/acp/acp-client.js'
import type { SnapshotStore } from '../ai/snapshot/snapshot-store.js'
import type { AttemptEndReason } from '../ai/control/attempt-tree-controller.js'

const logger = rootLogger.child({ test: 'v4-session-resume-wiring' })
const TASK_ID = 'resume-task'
const ATTEMPT = 2
/**
 * checkpoint 里记录的兼容键。
 *
 * 必须用生产代码的同一个函数构造，且包版本从契约读，而不是在测试里手写一个裸版本号。
 * 之前这里是裸的 '0.1.5-rc.1'，而引擎写入的是 '0.1.5-rc.1/v3'，于是"能恢复"这条用例
 * 在测试里成立、在生产里必然失败 —— 测试桩绕过了真实的写入格式。
 */
const HARNESS = sessionCompatibilityKey({
  harnessVersion: loadCapabilityContract().harnessVersion,
  // seedSessionLog 写的是 session.v3.jsonl。
  sessionFormatVersion: 'v3',
})

const cleanups: string[] = []
afterEach(() => {
  while (cleanups.length > 0) {
    rmSync(cleanups.pop()!, { recursive: true, force: true })
  }
})

function tempRoot(prefix: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  cleanups.push(root)
  return root
}

const RANGE_CONTENT = 'class Order {}'

function fakeSnapshots(): SnapshotStore {
  return {
    pins: () => [
      { repository: 'kdmanage-backend', commitSha: 'a'.repeat(40), gitDir: '/nonexistent' },
    ],
    verifyPins: async () => undefined,
    search: async () => ({ hits: [], truncated: false, total: 0 }),
    findFiles: async () => ({ repository: 'kdmanage-backend', paths: [], truncated: false, total: 0 }),
    commits: async () => [],
    readRange: async () => ({
      repository: 'kdmanage-backend',
      commitSha: 'a'.repeat(40),
      filePath: 'src/Order.java',
      blobSha: 'b'.repeat(40),
      startLine: 1,
      endLine: 10,
      totalLines: 100,
      truncated: false,
      content: RANGE_CONTENT,
      contentHash: hashContent(RANGE_CONTENT),
    }),
    reread: async () => ({
      repository: 'kdmanage-backend',
      commitSha: 'a'.repeat(40),
      filePath: 'src/Order.java',
      blobSha: 'b'.repeat(40),
      startLine: 1,
      endLine: 10,
      content: RANGE_CONTENT,
      contentHash: hashContent(RANGE_CONTENT),
    }),
  } as unknown as SnapshotStore
}

/** 假的子进程：不真的 spawn，只满足引擎的接口。 */
function fakeProcess(): AcpProcessHandle {
  return {
    pid: 4242,
    stdin: { end: () => undefined, write: () => true } as never,
    stdout: {} as never,
    stderr: () => '',
    exited: Promise.resolve({ code: 0, signal: null }),
    terminate: async () => ({ code: 0, signal: null }),
    reapProcessTree: async () => [],
  } as unknown as AcpProcessHandle
}

interface Harness {
  engine: DeepSeekHarnessAcpEngine
  /** runTurn 实际收到的 options，用来断言"是否走了 resume"。 */
  turnOptions: AcpSessionOptions[]
  /** 引擎写出的 checkpoint 原样记录，含兼容键 —— resume 往返测试要用它。 */
  checkpoints: Array<{
    sessionId: string
    sessionRevision: number
    harnessVersion: string
    storageLocator: string
    contentHash: string
  }>
  sessionRoot: string
  processStarts: { count: number }
  persistedNodes: string[]
  /** fence 钩子实际收到的原因，用来断言收敛真的落到了数据库。 */
  cancels: string[]
  /** 每条终态路径都必须落一次真实 usage。 */
  usageCommits: Array<Record<string, number | null>>
  /** spawn 参数：断言凭据与资源限额真的传下去了。 */
  spawnOptions: Array<Record<string, unknown>>
}

/**
 * 在持久卷上放一个 checkpoint 文件，返回它的 locator 与 hash。
 *
 * 布局必须与 Harness 实际写的一致：`<attempt-dir>/<workspace-slug>/<sessionId>/session.v3.jsonl`。
 * 用 `<attempt-dir>/<sessionId>.jsonl` 这种猜出来的路径会让 `locate()` 找不到文件，于是
 * checkpoint 静默不落库 —— 而这正是本次修复的那个缺陷。
 */
function seedSessionLog(
  sessionRoot: string,
  sessionId: string,
  input: { torn?: boolean; corruptCommitted?: boolean } = {},
): { storageLocator: string; contentHash: string } {
  const dir = join(sessionRoot, sessionDirectoryName(TASK_ID, ATTEMPT), '--slug--', sessionId)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'session.v3.jsonl')
  const events = [
    { seq: 0, kind: 'session/created' },
    { seq: 1, kind: 'turn/start' },
  ]
  const body = `${events.map((event) => JSON.stringify(event)).join('\n')}\n`
  if (input.corruptCommitted === true) {
    // 中间行残缺：不是崩溃残尾，而是文件被破坏过。
    writeFileSync(
      path,
      [JSON.stringify(events[0]), '{"seq":1,"broken', JSON.stringify({ seq: 2 })].join('\n'),
    )
  } else {
    writeFileSync(path, input.torn ? `${body}{"seq":2,"kind":"tool/ca` : body)
  }
  return {
    storageLocator: path,
    contentHash: `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`,
  }
}

function build(input: {
  resumable: Record<string, unknown> | null
  /** 复用一个已经播种过 checkpoint 的持久卷。 */
  sessionRoot?: string
  recordProfile?: () => Promise<void>
  registerAgentNode?: (agentId: string) => Promise<void>
  /** 调度侧告知的收敛原因，用来断言 LEASE_LOST / WORKER_SHUTDOWN 不再坍缩成 USER_CANCELLED。 */
  abortReason?: () => AttemptEndReason
  isLeaseValid?: () => boolean
  /** turn 进行中的回调。真实的 lease 丢失与 Worker 关停都发生在这一刻，而不是启动之前。 */
  onTurn?: () => void
}): Harness {
  const attemptsRoot = tempRoot('crp-resume-att-')
  const sessionRoot = input.sessionRoot ?? tempRoot('crp-resume-sess-')
  const turnOptions: AcpSessionOptions[] = []
  const checkpoints: Harness['checkpoints'] = []
  const processStarts = { count: 0 }
  const persistedNodes: string[] = []
  const cancels: string[] = []
  const usageCommits: Array<Record<string, number | null>> = []
  const spawnOptions: Array<Record<string, unknown>> = []

  const engine = new DeepSeekHarnessAcpEngine({
    taskId: TASK_ID,
    agentAttempt: ATTEMPT,
    branch: 'feature_dev',
    story: { code: 'PRJ-001', name: 'resume story', description: 'desc' },
    snapshots: fakeSnapshots(),
    route: {
      providerId: 'review-route',
      displayName: 'resume',
      baseUrl: 'http://127.0.0.1:9/v1',
      modelName: 'resume-model',
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
    workerId: 'worker-a',
    sessionRevision: 5,
    logger,
    infrastructure: {},
    forbiddenRoots: [],
    isLeaseValid: input.isLeaseValid ?? (() => true),
    abortReason: input.abortReason,
    commitReview: async () => ({ runId: 'run-1', committedAt: new Date().toISOString() }),
    db: {
      registerAgentNode: async (identity) => {
        await input.registerAgentNode?.(identity.agentId)
        persistedNodes.push(identity.agentId)
      },
      markAgentTerminal: async () => undefined,
      flushAudit: async () => undefined,
      saveArtifact: async () => ({ artifactId: 'a-1' }),
      saveSessionCheckpoint: async (checkpoint) => {
        checkpoints.push({
          sessionId: checkpoint.sessionId,
          sessionRevision: checkpoint.sessionRevision,
          harnessVersion: checkpoint.harnessVersion,
          storageLocator: checkpoint.storageLocator,
          contentHash: checkpoint.contentHash,
        })
      },
      recordProfile: input.recordProfile ?? (async () => undefined),
      reserveBudget: async () => ({ allowed: true, scope: null }),
      commitUsage: async (usage) => {
        usageCommits.push(usage)
        return true
      },
      requestAttemptCancel: async (reason) => {
        cancels.push(reason)
        return true
      },
      loadResumableAttempt: async () => input.resumable,
    },
    startProcess: (options) => {
      processStarts.count++
      spawnOptions.push(options as unknown as Record<string, unknown>)
      return fakeProcess()
    },
    runTurn: (async (options: AcpSessionOptions): Promise<AcpTurnResult> => {
      turnOptions.push(options)
      input.onTurn?.()
      return {
        ok: true,
        stopReason: 'end_turn',
        updates: 1,
        toolNames: [],
        promptError: null,
        sessionId: options.resumeSessionId ?? 'fresh-session-id',
        resumed: options.resumeSessionId !== undefined,
      }
    }) as never,
  })
  return {
    engine,
    turnOptions,
    checkpoints,
    sessionRoot,
    processStarts,
    persistedNodes,
    cancels,
    usageCommits,
    spawnOptions,
  }
}

async function run(harness: Harness, signal?: AbortSignal) {
  return harness.engine.runReview({ signal: signal ?? new AbortController().signal, logger })
}

describe('engine session resume wiring', () => {
  it('persists the profile and platform root before starting Harness', async () => {
    const harness = build({ resumable: null })
    const result = await run(harness)
    expect(result.errorCode).toBe('AGENT_NO_SUBMISSION')
    expect(harness.persistedNodes).toHaveLength(1)
    expect(harness.persistedNodes[0]).toMatch(/^root-/)
    expect(harness.processStarts.count).toBe(1)
  })

  it('fails closed before process start when profile identity cannot be persisted', async () => {
    const harness = build({
      resumable: null,
      recordProfile: async () => {
        throw new Error('contract drift')
      },
    })
    const result = await run(harness)
    expect(result.ok).toBe(false)
    expect(harness.persistedNodes).toHaveLength(0)
    expect(harness.processStarts.count).toBe(0)
    expect(harness.turnOptions).toHaveLength(0)
  })

  it('fails closed before process start when the root identity cannot be registered', async () => {
    const harness = build({
      resumable: null,
      registerAgentNode: async () => {
        throw new Error('root rejected')
      },
    })
    const result = await run(harness)
    expect(result.ok).toBe(false)
    expect(harness.persistedNodes).toHaveLength(0)
    expect(harness.processStarts.count).toBe(0)
    expect(harness.turnOptions).toHaveLength(0)
  })

  it('starts a fresh session when the database has nothing to resume', async () => {
    const harness = build({ resumable: null })
    const result = await run(harness)
    // 没有 checkpoint 是正常路径，不是故障。
    expect(result.ok).toBe(false)
    expect(result.errorCode).toBe('AGENT_NO_SUBMISSION')
    expect(harness.turnOptions).toHaveLength(1)
    expect(harness.turnOptions[0]!.resumeSessionId).toBeUndefined()
  })

  it('resumes the recorded session instead of opening a new one', async () => {
    // checkpoint 必须落在引擎自己会去读的那个持久卷上，否则测的就不是恢复而是"文件不见了"。
    const sessionRoot = tempRoot('crp-resume-live-')
    const seed = seedSessionLog(sessionRoot, 'session-live')
    const harness = build({
      sessionRoot,
      resumable: {
        agent_run_id: 'run-1',
        root_agent_id: 'root-x',
        root_session_id: 'session-live',
        session_id: 'session-live',
        // RPC 已经把 revision 推进过了，引擎应当直接采用它。
        session_revision: 9,
        storage_locator: seed.storageLocator,
        content_hash: seed.contentHash,
        harness_version: HARNESS,
        profile_hash: 'profile-1',
        policy_hash: hashPolicy(V4_DEFAULT_POLICY),
        resume_count: 1,
      },
    })
    const result = await run(harness)
    expect(result.errorCode).toBe('AGENT_NO_SUBMISSION')
    expect(harness.turnOptions).toHaveLength(1)
    // 关键断言：ACP 层收到了 sessionId，于是走 session/resume 而不是 session/new。
    expect(harness.turnOptions[0]!.resumeSessionId).toBe('session-live')
    // checkpoint 使用恢复后的 revision，而不是硬编码的 1。
    expect(harness.checkpoints[0]?.sessionId).toBe('session-live')
    expect(harness.checkpoints[0]?.sessionRevision).toBe(9)
  })

  it('fails the attempt on a Harness version change instead of silently starting over', async () => {
    const sessionRoot = tempRoot('crp-resume-old-')
    const seed = seedSessionLog(sessionRoot, 'session-old')
    const harness = build({
      sessionRoot,
      resumable: {
        session_id: 'session-old',
        session_revision: 4,
        storage_locator: seed.storageLocator,
        content_hash: seed.contentHash,
        // 用另一个 Harness 版本写的日志：格式可能已经不同。
        harness_version: sessionCompatibilityKey({
          harnessVersion: '0.1.4',
          sessionFormatVersion: 'v3',
        }),
        policy_hash: hashPolicy(V4_DEFAULT_POLICY),
        resume_count: 0,
      },
    })
    const result = await run(harness)
    expect(result.ok).toBe(false)
    expect(result.errorCode).toBe(V4_ERROR_CODES.SESSION_FORMAT_UNSUPPORTED)
    // 从未开始 turn：静默降级成新会话才是最坏的结果。
    expect(harness.turnOptions).toHaveLength(0)
  })

  it('resumes a session whose final record was torn by a crash', async () => {
    const sessionRoot = tempRoot('crp-resume-torn-')
    const seed = seedSessionLog(sessionRoot, 'session-torn', { torn: true })
    const harness = build({
      sessionRoot,
      resumable: {
        session_id: 'session-torn',
        session_revision: 4,
        storage_locator: seed.storageLocator,
        content_hash: seed.contentHash,
        harness_version: HARNESS,
        policy_hash: hashPolicy(V4_DEFAULT_POLICY),
        resume_count: 0,
      },
    })
    const result = await run(harness)
    // 崩溃恰恰是恢复要处理的场景：backend 保证已提交前缀完整、丢弃残尾、补写合成收尾。
    // 把残尾当致命错误等于"只有从没崩过的会话才能恢复"，resume 就形同虚设。
    expect(result.errorCode).toBe('AGENT_NO_SUBMISSION')
    expect(harness.turnOptions[0]!.resumeSessionId).toBe('session-torn')
  })

  it('fails the attempt when a committed record is corrupt', async () => {
    const sessionRoot = tempRoot('crp-resume-corrupt-')
    const seed = seedSessionLog(sessionRoot, 'session-corrupt', { corruptCommitted: true })
    const harness = build({
      sessionRoot,
      resumable: {
        session_id: 'session-corrupt',
        session_revision: 4,
        storage_locator: seed.storageLocator,
        content_hash: seed.contentHash,
        harness_version: HARNESS,
        policy_hash: hashPolicy(V4_DEFAULT_POLICY),
        resume_count: 0,
      },
    })
    const result = await run(harness)
    // 中间某条已提交记录坏了才是真损坏：append-only 日志不会让中间行残缺。
    expect(result.errorCode).toBe(V4_ERROR_CODES.SESSION_RECOVERY_FAILED)
    expect(harness.turnOptions).toHaveLength(0)
  })

  it('fails the attempt when the log changed under us', async () => {
    const sessionRoot = tempRoot('crp-resume-fenced-')
    const seed = seedSessionLog(sessionRoot, 'session-fenced')
    const harness = build({
      sessionRoot,
      resumable: {
        session_id: 'session-fenced',
        session_revision: 4,
        storage_locator: seed.storageLocator,
        // hash 不匹配意味着我们已经不是唯一写者。
        content_hash: 'sha256:stale',
        harness_version: HARNESS,
        policy_hash: hashPolicy(V4_DEFAULT_POLICY),
        resume_count: 0,
      },
    })
    const result = await run(harness)
    expect(result.errorCode).toBe(V4_ERROR_CODES.SESSION_FENCED)
    expect(harness.turnOptions).toHaveLength(0)
  })

  it('fails the attempt on a capability policy change', async () => {
    const sessionRoot = tempRoot('crp-resume-policy-')
    const seed = seedSessionLog(sessionRoot, 'session-policy')
    const harness = build({
      sessionRoot,
      resumable: {
        session_id: 'session-policy',
        session_revision: 4,
        storage_locator: seed.storageLocator,
        content_hash: seed.contentHash,
        harness_version: HARNESS,
        // Policy 变了意味着工具面可能变了：重放会让模型反复调用不存在的工具。
        policy_hash: 'a'.repeat(64),
        resume_count: 0,
      },
    })
    const result = await run(harness)
    expect(result.errorCode).toBe(V4_ERROR_CODES.SESSION_FORMAT_UNSUPPORTED)
    expect(harness.turnOptions).toHaveLength(0)
  })

  it('stops a crash-resume loop at the configured cap', async () => {
    const sessionRoot = tempRoot('crp-resume-loop-')
    const seed = seedSessionLog(sessionRoot, 'session-loop')
    const harness = build({
      sessionRoot,
      resumable: {
        session_id: 'session-loop',
        session_revision: 4,
        storage_locator: seed.storageLocator,
        content_hash: seed.contentHash,
        harness_version: HARNESS,
        policy_hash: hashPolicy(V4_DEFAULT_POLICY),
        resume_count: MAX_SESSION_RESUMES,
      },
    })
    const result = await run(harness)
    expect(result.errorCode).toBe(V4_ERROR_CODES.SESSION_RECOVERY_FAILED)
  })

  it('continues with a fresh session when the resume lookup itself fails', async () => {
    // 查询失败不等于"不可恢复"，但也不能因此拒绝启动 —— 那会让一次数据库抖动阻塞所有分析。
    const attemptsRoot = tempRoot('crp-resume-err-att-')
    const sessionRoot = tempRoot('crp-resume-err-sess-')
    const turnOptions: AcpSessionOptions[] = []
    const engine = new DeepSeekHarnessAcpEngine({
      taskId: TASK_ID,
      agentAttempt: ATTEMPT,
      branch: 'feature_dev',
      story: { code: 'PRJ-001', name: 's', description: 'd' },
      snapshots: fakeSnapshots(),
      route: {
        providerId: 'review-route',
        displayName: 'r',
        baseUrl: 'http://127.0.0.1:9/v1',
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
      workerId: 'worker-a',
      logger,
      infrastructure: {},
      forbiddenRoots: [],
      isLeaseValid: () => true,
      commitReview: async () => ({ runId: 'r', committedAt: new Date().toISOString() }),
      db: {
        registerAgentNode: async () => undefined,
        markAgentTerminal: async () => undefined,
        flushAudit: async () => undefined,
        saveArtifact: async () => ({ artifactId: 'a' }),
        saveSessionCheckpoint: async () => undefined,
        recordProfile: async () => undefined,
        reserveBudget: async () => ({ allowed: true, scope: null }),
        commitUsage: async () => true,
        requestAttemptCancel: async () => true,
        loadResumableAttempt: async () => {
          throw new Error('database unreachable')
        },
      },
      startProcess: () => fakeProcess(),
      runTurn: (async (options: AcpSessionOptions): Promise<AcpTurnResult> => {
        turnOptions.push(options)
        return {
          ok: true,
          stopReason: 'end_turn',
          updates: 0,
          toolNames: [],
          promptError: null,
          sessionId: 'fresh',
          resumed: false,
        }
      }) as never,
    })
    const result = await engine.runReview({ signal: new AbortController().signal, logger })
    expect(result.errorCode).toBe('AGENT_NO_SUBMISSION')
    expect(turnOptions[0]!.resumeSessionId).toBeUndefined()
  })

  it('does not consult the database when session resume is disabled by policy', async () => {
    const attemptsRoot = tempRoot('crp-resume-off-att-')
    const sessionRoot = tempRoot('crp-resume-off-sess-')
    const loadResumableAttempt = vi.fn(async () => null)
    const engine = new DeepSeekHarnessAcpEngine({
      taskId: TASK_ID,
      agentAttempt: ATTEMPT,
      branch: 'feature_dev',
      story: { code: 'PRJ-001', name: 's', description: 'd' },
      snapshots: fakeSnapshots(),
      route: {
        providerId: 'review-route',
        displayName: 'r',
        baseUrl: 'http://127.0.0.1:9/v1',
        modelName: 'm',
        contextWindow: 131072,
        maxTokens: 4096,
        apiKeyEnvVar: 'REVIEW_MODEL_API_KEY',
        requestTimeoutMs: 30000,
      },
      policy: {
        ...V4_DEFAULT_POLICY,
        capabilities: { ...V4_DEFAULT_POLICY.capabilities, sessionResume: false },
      },
      coveragePolicy: { requiredRepositories: ['kdmanage-backend'], minQueriesPerRepository: 0 },
      apiKey: 'k',
      attemptsRoot,
      sessionRoot,
      workerId: 'worker-a',
      logger,
      infrastructure: {},
      forbiddenRoots: [],
      isLeaseValid: () => true,
      commitReview: async () => ({ runId: 'r', committedAt: new Date().toISOString() }),
      db: {
        registerAgentNode: async () => undefined,
        markAgentTerminal: async () => undefined,
        flushAudit: async () => undefined,
        saveArtifact: async () => ({ artifactId: 'a' }),
        saveSessionCheckpoint: async () => undefined,
        recordProfile: async () => undefined,
        reserveBudget: async () => ({ allowed: true, scope: null }),
        commitUsage: async () => true,
        requestAttemptCancel: async () => true,
        loadResumableAttempt,
      },
      startProcess: () => fakeProcess(),
      runTurn: (async (): Promise<AcpTurnResult> => ({
        ok: true,
        stopReason: 'end_turn',
        updates: 0,
        toolNames: [],
        promptError: null,
        sessionId: 'fresh',
        resumed: false,
      })) as never,
    })
    await engine.runReview({ signal: new AbortController().signal, logger })
    expect(loadResumableAttempt).not.toHaveBeenCalled()
  })
})

/**
 * 下面这一组守的是"接线"，不是"逻辑"。
 *
 * 上一轮审查发现的三个缺陷都不是算法错，而是两侧各写一套、或者干脆没接：
 *
 *   * checkpoint 写 `<版本>/<格式>`，恢复判定却拿裸版本号去比 —— 恢复在生产里必然失败，
 *     而测试因为桩里直接塞了裸版本号所以是绿的；
 *   * 引擎构造 AttemptTreeController 时漏传 fence，DB fencing 全程空转，测试因为手工注入了
 *     fence 所以是绿的；
 *   * 真实 usage 只在提交成功时落库，失败与取消的花费在库里是 0。
 *
 * 共同点：单元逻辑正确、装配缺失，而测试桩恰好补上了缺失的那一环。所以这里一律**走引擎
 * 自己的写入路径**取值，再喂回引擎自己的判定路径，不在测试里手写期望形状。
 */
describe('engine convergence and checkpoint wiring', () => {
  it('accepts on resume exactly what it wrote at checkpoint time', async () => {
    // 往返：第一次 attempt 落 checkpoint，把它原样当成 loadResumableAttempt 的返回值喂回去，
    // 第二次 attempt 必须真的恢复。两侧任何一处自己拼字符串，这条就会失败。
    const sessionRoot = tempRoot('crp-resume-roundtrip-')
    // 第一次 attempt 走 session/new，引擎拿到的 sessionId 是桩里的 'fresh-session-id'，
    // 所以日志必须种在那个 id 下，checkpoint 才描述得到它。
    const seed = seedSessionLog(sessionRoot, 'fresh-session-id')
    const first = build({ sessionRoot, resumable: null })
    await run(first)
    const written = first.checkpoints.find((row) => row.sessionId === 'fresh-session-id')
    expect(written).toBeDefined()
    // 引擎写出来的兼容键长这样：`<包版本>/<会话格式版本>`。
    expect(written!.harnessVersion).toContain('/')

    const second = build({
      sessionRoot,
      resumable: {
        agent_run_id: 'run-rt',
        root_agent_id: 'root-rt',
        root_session_id: 'fresh-session-id',
        session_id: 'fresh-session-id',
        session_revision: 11,
        storage_locator: seed.storageLocator,
        content_hash: seed.contentHash,
        // 关键：用引擎自己写出来的值，而不是测试手写的裸版本号。
        harness_version: written!.harnessVersion,
        profile_hash: written!.sessionId,
        policy_hash: hashPolicy(V4_DEFAULT_POLICY),
        resume_count: 0,
      },
    })
    await run(second)
    expect(second.turnOptions[0]!.resumeSessionId).toBe('fresh-session-id')
  })

  it('refuses a checkpoint whose compatibility key is missing', async () => {
    // 兼容键缺失时无从判断能不能重放，必须 fail closed 而不是赌一把。
    const sessionRoot = tempRoot('crp-resume-nokey-')
    const seed = seedSessionLog(sessionRoot, 'session-nokey')
    const harness = build({
      sessionRoot,
      resumable: {
        agent_run_id: 'run-nokey',
        session_id: 'session-nokey',
        session_revision: 3,
        storage_locator: seed.storageLocator,
        content_hash: seed.contentHash,
        harness_version: '',
        policy_hash: hashPolicy(V4_DEFAULT_POLICY),
        resume_count: 0,
      },
    })
    const result = await run(harness)
    expect(result.errorCode).toBe(V4_ERROR_CODES.SESSION_FORMAT_UNSUPPORTED)
  })

  it('fences the attempt in the database on every drain', async () => {
    // fence 钩子以前没接线：drain 里 `this.options.fence?.()` 静默跳过，迟到的工具调用与
    // 提交在数据库层没有任何阻断。
    const harness = build({ resumable: null })
    await run(harness)
    expect(harness.cancels).toHaveLength(1)
    expect(harness.cancels[0]).toBe('ATTEMPT_FAILED')
  })

  it('records the real usage on a non-committed attempt', async () => {
    // 失败与取消的 attempt 一样烧了模型请求；只在提交成功时记 usage 会让成本核对失真。
    const harness = build({ resumable: null })
    await run(harness)
    expect(harness.usageCommits).toHaveLength(1)
    const usage = harness.usageCommits[0]!
    expect(usage.model_requests).toBe(0)
    // provider 没报 token 时保持 null，不臆造 0。
    expect(usage.input_tokens).toBeNull()
    expect(usage.output_tokens).toBeNull()
  })

  it('distinguishes a lost lease from a user cancellation', async () => {
    // 以前 lease 丢失、Worker 关停和用户取消都被记成 USER_CANCELLED，事故复盘时无从区分。
    // 取消必须发生在 turn 进行中：启动之前 abort 的 attempt 还没有任何东西需要收敛。
    const controller = new AbortController()
    const harness = build({
      resumable: null,
      abortReason: () => 'LEASE_LOST',
      onTurn: () => controller.abort(),
    })
    await run(harness, controller.signal)
    expect(harness.cancels).toContain('LEASE_LOST')
    expect(harness.cancels).not.toContain('USER_CANCELLED')
  })

  it('distinguishes a worker shutdown from a user cancellation', async () => {
    const controller = new AbortController()
    const harness = build({
      resumable: null,
      abortReason: () => 'WORKER_SHUTDOWN',
      onTurn: () => controller.abort(),
    })
    await run(harness, controller.signal)
    expect(harness.cancels).toContain('WORKER_SHUTDOWN')
    expect(harness.cancels).not.toContain('USER_CANCELLED')
  })

  it('hands the Harness its credentials and inherited resource limits', async () => {
    // 凭据必须经环境变量下传（patch 文件对沙箱 Shell 可读），资源限额必须真的落到 spawn
    // 参数上 —— 之前 ulimitPrefix 只被测试引用过，生产路径从不消费它。
    const harness = build({ resumable: null })
    await run(harness)
    const spawned = harness.spawnOptions[0]!
    expect(typeof spawned.brokerToken).toBe('string')
    expect((spawned.brokerToken as string).length).toBeGreaterThan(0)
    expect(typeof spawned.rootCapability).toBe('string')
    const limits = (spawned.ulimits as readonly string[]).join('; ')
    expect(limits).toContain('ulimit -n')
    expect(limits).toContain('ulimit -c 0')
    // 这两项不能设在长驻的 Harness 进程上：`-t` 会在累计 CPU 时间到点后杀掉整个 attempt；
    // `-u` 按 UID 全局计数，容器共享宿主 user namespace 时会让正常构建随机 fork 失败。
    expect(limits).not.toContain('ulimit -t')
    expect(limits).not.toContain('ulimit -u')
  })

  it('registers each agent node exactly once', async () => {
    // 以前 ledger 的 persistNode 与 Broker 的 registerAgentNode 都指向同一个 RPC，
    // 一次注册写两次。
    const registered: string[] = []
    const harness = build({
      resumable: null,
      registerAgentNode: async (agentId) => {
        registered.push(agentId)
      },
    })
    await run(harness)
    expect(new Set(registered).size).toBe(registered.length)
  })
})
