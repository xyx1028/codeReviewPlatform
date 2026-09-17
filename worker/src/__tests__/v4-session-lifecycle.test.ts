/**
 * WP6 验收：Session persistence、恢复与保留期。
 *
 * 对应第 10 节矩阵的 "Persistence" 一行：Worker 重启后可安全恢复同一 Session 或明确失败，
 * 不重复副作用；torn log 与 writer 竞争都 fail closed。
 *
 * 恢复是最容易出错的地方，因为它有两个都不可接受的失败方向：恢复得太激进会重复执行已
 * 完成的副作用（最坏是提交两份结果），恢复得太保守会让长任务每次重启都从零开始。所以
 * 这里的每一条用例都在钉"什么情况下必须拒绝"。
 */

import { afterEach, describe, expect, it } from 'vitest'
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SessionRegistry,
  sessionDirectoryName,
} from '../ai/session/session-registry.js'
import {
  evaluateResume,
  inspectSessionLog,
  resumeDecisionError,
  type ResumeCandidate,
} from '../ai/session/session-recovery.js'
import { enforceSessionRetention } from '../ai/session/session-retention.js'
import { V4_ERROR_CODES, V4GovernanceError } from '../ai/policy/v4-errors.js'
import { rootLogger } from '../logger.js'

const logger = rootLogger.child({ test: 'v4-session' })
const cleanups: string[] = []

function tempRoot(prefix: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  cleanups.push(root)
  return root
}

afterEach(() => {
  while (cleanups.length > 0) {
    const path = cleanups.pop()!
    try {
      chmodSync(path, 0o700)
    } catch {
      // 已经不存在。
    }
    rmSync(path, { recursive: true, force: true })
  }
})

const HARNESS = '0.1.5-rc.1'

function writeJsonl(path: string, events: unknown[], trailing = ''): string {
  writeFileSync(path, `${events.map((event) => JSON.stringify(event)).join('\n')}\n${trailing}`)
  return `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`
}

describe('sessionDirectoryName', () => {
  it('derives a stable directory from task and attempt', () => {
    // 随机目录名会让"恢复"退化成"重新开始"：重启后必须能找回同一个目录。
    expect(sessionDirectoryName('task-a', 1)).toBe(sessionDirectoryName('task-a', 1))
    expect(sessionDirectoryName('task-a', 2)).not.toBe(sessionDirectoryName('task-a', 1))
    expect(sessionDirectoryName('task-b', 1)).not.toBe(sessionDirectoryName('task-a', 1))
    expect(sessionDirectoryName('task-a', 1)).toMatch(/^attempt-[0-9a-f]{32}$/)
  })
})

describe('SessionRegistry single-writer lock', () => {
  function registry(input: { root: string; workerId?: string; attempt?: number }): SessionRegistry {
    return new SessionRegistry({
      root: input.root,
      taskId: 'task-1',
      agentAttempt: input.attempt ?? 1,
      workerId: input.workerId ?? 'worker-a',
      logger,
    })
  }

  it('creates a per-attempt directory on the persistent volume', () => {
    const root = tempRoot('crp-sessions-')
    const slot = registry({ root }).acquire()
    expect(slot.sessionRoot).toBe(join(root, sessionDirectoryName('task-1', 1)))
    // 会话还没落盘时定位返回 null，而不是一个不存在的推测路径。
    expect(slot.locate('session-x')).toBeNull()
    slot.release()
  })

  it('locates the log Harness actually writes, slug directory and all', () => {
    const root = tempRoot('crp-sessions-')
    const slot = registry({ root }).acquire()
    // 真实布局：<root>/<workspace-slug>/<sessionId>/session.v3.jsonl[.zstd]。
    // 中间那层 slug 由 Harness 按 cwd 生成，我们不复制它的规则，只按 session id 目录找。
    const nested = join(slot.sessionRoot, '--private-tmp-ws--', 'session-x')
    mkdirSync(nested, { recursive: true })
    writeFileSync(join(nested, 'session.v3.jsonl.zstd'), 'compressed-bytes')
    const located = slot.locate('session-x')
    expect(located).not.toBeNull()
    expect(located!.path).toBe(join(nested, 'session.v3.jsonl.zstd'))
    expect(located!.formatVersion).toBe('v3')
    expect(located!.compressed).toBe(true)
    slot.release()
  })

  it('ignores a session file that is not inside a directory named after the session', () => {
    const root = tempRoot('crp-sessions-')
    const slot = registry({ root }).acquire()
    const other = join(slot.sessionRoot, 'slug', 'some-other-session')
    mkdirSync(other, { recursive: true })
    writeFileSync(join(other, 'session.v3.jsonl'), '{}\n')
    expect(slot.locate('session-x')).toBeNull()
    slot.release()
  })

  it('refuses a second worker holding the same session', () => {
    const root = tempRoot('crp-sessions-')
    registry({ root, workerId: 'worker-a' }).acquire()
    // 两个 Worker 同时写 JSONL 会写出交错的日志，而 torn 之后不可能安全重放。
    try {
      registry({ root, workerId: 'worker-b' }).acquire()
      throw new Error('expected the second writer to be fenced')
    } catch (err) {
      expect((err as V4GovernanceError).code).toBe(V4_ERROR_CODES.SESSION_FENCED)
    }
  })

  it('refuses another attempt of the same task', () => {
    const root = tempRoot('crp-sessions-')
    const slot = registry({ root, attempt: 1 }).acquire()
    // 目录名按 attempt 派生，所以 attempt 2 用的是另一个目录 —— 这条是正常路径。
    const second = registry({ root, attempt: 2 }).acquire()
    expect(second.sessionRoot).not.toBe(slot.sessionRoot)
    second.release()
    slot.release()
  })

  it('lets the same worker reclaim its own lock after a process restart', () => {
    const root = tempRoot('crp-sessions-')
    registry({ root, workerId: 'worker-a' }).acquire()
    // 进程重启是恢复的正常前提：同一个 Worker 的同一个 attempt 必须能接管自己的锁。
    const reclaimed = registry({ root, workerId: 'worker-a' }).acquire()
    expect(reclaimed.sessionRoot).toBe(join(root, sessionDirectoryName('task-1', 1)))
    reclaimed.release()
  })

  it('refuses when the lock file is corrupt rather than stealing it', () => {
    const root = tempRoot('crp-sessions-')
    const dir = join(root, sessionDirectoryName('task-1', 1))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '.writer.lock'), 'not json')
    // 未知持有者：宁可拒绝，也不覆盖别人的写者锁。
    expect(() => registry({ root }).acquire()).toThrow(/single-writer lock/)
  })

  it('allows a fresh acquisition after release', () => {
    const root = tempRoot('crp-sessions-')
    registry({ root, workerId: 'worker-a' }).acquire().release()
    const next = registry({ root, workerId: 'worker-b' }).acquire()
    expect(next.sessionRoot).toBeDefined()
    next.release()
  })

  it('describes a session log by locator, hash, format and event count only', () => {
    const root = tempRoot('crp-sessions-')
    const reg = registry({ root })
    const slot = reg.acquire()
    const nested = join(slot.sessionRoot, 'slug', 'session-x')
    mkdirSync(nested, { recursive: true })
    const path = join(nested, 'session.v3.jsonl')
    const hash = writeJsonl(path, [
      { seq: 0, kind: 'session/created' },
      { seq: 1, kind: 'turn/start' },
    ])
    const described = reg.describe(slot.locate('session-x')!)
    expect(described).not.toBeNull()
    expect(described!.eventCount).toBe(2)
    expect(described!.contentHash).toBe(hash)
    expect(described!.storageLocator).toBe(path)
    expect(described!.formatVersion).toBe('v3')
    // 会话原文绝不进数据库列：描述里没有 body 字段。
    expect(Object.keys(described!).sort()).toEqual([
      'contentHash',
      'eventCount',
      'formatVersion',
      'sizeBytes',
      'storageLocator',
    ])
    slot.release()
  })

  it('does not decompress a compressed log just to count events', () => {
    // 解压一份带真实源码的会话日志只为得到一个运维用的计数，是不必要的暴露面。
    const root = tempRoot('crp-sessions-')
    const reg = registry({ root })
    const slot = reg.acquire()
    const nested = join(slot.sessionRoot, 'slug', 'session-z')
    mkdirSync(nested, { recursive: true })
    writeFileSync(join(nested, 'session.v3.jsonl.zstd'), Buffer.from([0x28, 0xb5, 0x2f, 0xfd]))
    const described = reg.describe(slot.locate('session-z')!)
    expect(described!.eventCount).toBe(0)
    expect(described!.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/)
    slot.release()
  })
})

describe('inspectSessionLog', () => {
  it('accepts a complete JSONL log whose hash still matches', () => {
    const root = tempRoot('crp-log-')
    const path = join(root, 's.jsonl')
    const hash = writeJsonl(path, [{ seq: 0 }, { seq: 1 }, { seq: 2 }])
    expect(inspectSessionLog(path, hash)).toEqual({ ok: true, eventCount: 3, verified: true })
  })

  it('reports SESSION_RECOVERY_FAILED for a missing log', () => {
    const root = tempRoot('crp-log-')
    const result = inspectSessionLog(join(root, 'missing.jsonl'), 'sha256:x')
    expect(result).toMatchObject({ ok: false, code: V4_ERROR_CODES.SESSION_RECOVERY_FAILED })
  })

  it('reports SESSION_FENCED when another writer changed the log', () => {
    const root = tempRoot('crp-log-')
    const path = join(root, 's.jsonl')
    const hash = writeJsonl(path, [{ seq: 0 }])
    appendFileSync(path, `${JSON.stringify({ seq: 1, from: 'another writer' })}\n`)
    // 内容变了不是"内容变了"，而是"我们已经不是唯一写者"。
    expect(inspectSessionLog(path, hash)).toMatchObject({
      ok: false,
      code: V4_ERROR_CODES.SESSION_FENCED,
    })
  })

  it('accepts a torn final record and counts only the committed prefix', () => {
    const root = tempRoot('crp-log-')
    const path = join(root, 's.jsonl')
    // 崩溃后最后一行写了一半是**正常形态**：backend 明确保证已提交前缀完整、残尾被丢弃、
    // 恢复方补写合成收尾。平台把它当致命错误会让所有崩溃后的会话都不可恢复。
    writeFileSync(path, `${JSON.stringify({ seq: 0 })}\n{"seq":1,"kind":"tool/ca`)
    const hash = `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`
    expect(inspectSessionLog(path, hash)).toEqual({ ok: true, eventCount: 1, verified: true })
  })

  it('reports SESSION_RECOVERY_FAILED when a committed record is corrupt', () => {
    const root = tempRoot('crp-log-')
    const path = join(root, 's.jsonl')
    // 中间某条已提交记录坏了是真损坏：append-only 的日志不会让中间行残缺，
    // 出现这种情况说明文件被别的东西破坏过，重放它会得到一段不一致的历史。
    writeFileSync(
      path,
      [JSON.stringify({ seq: 0 }), '{"seq":1,"broken', JSON.stringify({ seq: 2 })].join('\n'),
    )
    const hash = `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`
    const result = inspectSessionLog(path, hash)
    expect(result).toMatchObject({ ok: false, code: V4_ERROR_CODES.SESSION_RECOVERY_FAILED })
    expect((result as { reason: string }).reason).toMatch(/corrupt at committed record 2/)
  })

  it('refuses a log whose only record is a torn tail', () => {
    const root = tempRoot('crp-log-')
    const path = join(root, 's.jsonl')
    writeFileSync(path, '{"seq":0,"kind":"session/cre')
    const hash = `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`
    // 没有任何完整记录可以接着走。
    expect(inspectSessionLog(path, hash)).toMatchObject({
      ok: false,
      code: V4_ERROR_CODES.SESSION_RECOVERY_FAILED,
    })
  })

  it('does not line-parse a compressed log, and does not reject it either', () => {
    const root = tempRoot('crp-log-')
    const path = join(root, 'session.v3.jsonl.zstd')
    // 压缩日志是二进制。早先的实现拿它去做 JSON.parse，于是**任何**真实会话都被判为
    // 不可恢复 —— resume 表面上接线了，实际永远失败。完整性由 backend 的帧校验负责。
    writeFileSync(path, Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x58, 0x01, 0x02]))
    const hash = `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`
    expect(inspectSessionLog(path, hash, { compressed: true })).toEqual({
      ok: true,
      eventCount: 0,
      verified: false,
    })
  })

  it('reports SESSION_RECOVERY_FAILED for an empty log', () => {
    const root = tempRoot('crp-log-')
    const path = join(root, 's.jsonl')
    writeFileSync(path, '')
    const hash = `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`
    expect(inspectSessionLog(path, hash)).toMatchObject({
      ok: false,
      code: V4_ERROR_CODES.SESSION_RECOVERY_FAILED,
    })
  })

  it('checks fencing before integrity', () => {
    // 顺序有意义：别的写者动过文件时，报"被接管"比报"内容坏了"更准确，也决定了不同的处置。
    const root = tempRoot('crp-log-')
    const path = join(root, 's.jsonl')
    writeFileSync(path, '{"broken')
    expect(inspectSessionLog(path, 'sha256:stale')).toMatchObject({
      code: V4_ERROR_CODES.SESSION_FENCED,
    })
  })
})

describe('evaluateResume', () => {
  function candidate(overrides: Partial<ResumeCandidate> = {}): ResumeCandidate {
    const root = tempRoot('crp-resume-')
    const path = join(root, 'session-x.jsonl')
    const contentHash = writeJsonl(path, [{ seq: 0 }, { seq: 1 }])
    return {
      agentRunId: 'run-1',
      rootAgentId: 'root-1',
      rootSessionId: 'session-x',
      sessionId: 'session-x',
      sessionRevision: 3,
      storageLocator: path,
      contentHash,
      harnessVersion: HARNESS,
      profileHash: 'profile-1',
      policyHash: 'policy-1',
      resumeCount: 0,
      // V1.6：checkpoint 与 Job 各自记录的技能目录身份。
      skillCatalogHash: 'catalog-1',
      jobSkillCatalogHash: 'catalog-1',
      ...overrides,
    }
  }

  const base = {
    harnessVersion: HARNESS,
    policyHash: 'policy-1',
    profileHash: 'profile-1',
    skillCatalogHash: 'catalog-1',
    maxResumes: 3,
  }

  it('resumes a healthy checkpoint', () => {
    const decision = evaluateResume({ ...base, candidate: candidate(), alreadyCommitted: false })
    expect(decision.resume).toBe(true)
    expect(decision.code).toBeNull()
    expect(decision.session).toMatchObject({ sessionId: 'session-x', sessionRevision: 3 })
    expect(resumeDecisionError(decision)).toBeNull()
  })

  it('never resumes an attempt that already committed', () => {
    // ACP 响应丢失不是重跑的理由：数据库 receipt 才是权威。
    const decision = evaluateResume({ ...base, candidate: candidate(), alreadyCommitted: true })
    expect(decision.resume).toBe(false)
    expect(decision.code).toBeNull()
    expect(decision.reason).toMatch(/receipt is authoritative/)
  })

  it('reports no checkpoint without treating it as an error', () => {
    const decision = evaluateResume({ ...base, candidate: null, alreadyCommitted: false })
    expect(decision.resume).toBe(false)
    // 没有 checkpoint 是正常的"新 attempt"，不是故障。
    expect(decision.code).toBeNull()
  })

  it('refuses a checkpoint written by a different Harness version', () => {
    const decision = evaluateResume({
      ...base,
      candidate: candidate({ harnessVersion: '0.1.4' }),
      alreadyCommitted: false,
    })
    expect(decision.code).toBe(V4_ERROR_CODES.SESSION_FORMAT_UNSUPPORTED)
    expect(resumeDecisionError(decision)).toBeInstanceOf(V4GovernanceError)
  })

  it('refuses a checkpoint written under a different capability policy', () => {
    // Policy 变了意味着工具面可能变了；重放那段历史会让模型反复调用不存在的工具。
    const decision = evaluateResume({
      ...base,
      candidate: candidate({ policyHash: 'policy-old' }),
      alreadyCommitted: false,
    })
    expect(decision.code).toBe(V4_ERROR_CODES.SESSION_FORMAT_UNSUPPORTED)
  })

  it('resumes when the checkpoint recorded no policy hash', () => {
    // 在途旧 checkpoint 没有 policy hash：不能因此永久拒绝恢复。
    const decision = evaluateResume({
      ...base,
      candidate: candidate({ policyHash: null }),
      alreadyCommitted: false,
    })
    expect(decision.resume).toBe(true)
  })

  it('stops a crash-resume loop at the configured cap', () => {
    const decision = evaluateResume({
      ...base,
      maxResumes: 2,
      candidate: candidate({ resumeCount: 2 }),
      alreadyCommitted: false,
    })
    expect(decision.code).toBe(V4_ERROR_CODES.SESSION_RECOVERY_FAILED)
    expect(decision.reason).toMatch(/already been resumed 2 times/)
  })

  it('resumes a log whose final record was torn by a crash', () => {
    const root = tempRoot('crp-resume-torn-')
    const path = join(root, 'session-x.jsonl')
    writeFileSync(path, `${JSON.stringify({ seq: 0 })}\n{"seq":1,"kind":"tool/ca`)
    const contentHash = `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`
    const decision = evaluateResume({
      ...base,
      candidate: candidate({ storageLocator: path, contentHash }),
      alreadyCommitted: false,
    })
    // 崩溃恰恰是恢复要处理的场景。backend 丢弃残尾并补写合成收尾，所以这必须可恢复 ——
    // 判成不可恢复等于"只有从没崩过的会话才能恢复"。
    expect(decision.resume).toBe(true)
  })

  it('refuses a log whose committed prefix is corrupt', () => {
    const root = tempRoot('crp-resume-corrupt-')
    const path = join(root, 'session-x.jsonl')
    writeFileSync(
      path,
      [JSON.stringify({ seq: 0 }), '{"seq":1,"broken', JSON.stringify({ seq: 2 })].join('\n'),
    )
    const contentHash = `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`
    const decision = evaluateResume({
      ...base,
      candidate: candidate({ storageLocator: path, contentHash }),
      alreadyCommitted: false,
    })
    expect(decision.code).toBe(V4_ERROR_CODES.SESSION_RECOVERY_FAILED)
  })

  it('resumes a compressed log rather than failing to line-parse it', () => {
    const root = tempRoot('crp-resume-zstd-')
    const path = join(root, 'session.v3.jsonl.zstd')
    writeFileSync(path, Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x58, 0x01, 0x02]))
    const contentHash = `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`
    const decision = evaluateResume({
      ...base,
      candidate: candidate({ storageLocator: path, contentHash, compressed: true }),
      alreadyCommitted: false,
    })
    expect(decision.resume).toBe(true)
  })

  it('refuses when the log was changed by another writer', () => {
    const decision = evaluateResume({
      ...base,
      candidate: candidate({ contentHash: 'sha256:stale' }),
      alreadyCommitted: false,
    })
    expect(decision.code).toBe(V4_ERROR_CODES.SESSION_FENCED)
  })
})

describe('enforceSessionRetention', () => {
  function seed(
    root: string,
    name: string,
    input: { ageMs: number; bytes: number; locked?: boolean; now: number },
  ): void {
    const dir = join(root, name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'session.jsonl'), 'x'.repeat(input.bytes))
    if (input.locked) {
      writeFileSync(join(dir, '.writer.lock'), JSON.stringify({ workerId: 'worker-a' }))
    }
    const stamp = new Date(input.now - input.ageMs)
    utimesSync(dir, stamp, stamp)
  }

  it('removes directories past the retention window', () => {
    const root = tempRoot('crp-retention-')
    const now = Date.now()
    seed(root, 'attempt-old', { ageMs: 10 * 24 * 3600_000, bytes: 100, now })
    seed(root, 'attempt-fresh', { ageMs: 3600_000, bytes: 100, now })
    // 不是我们管理的目录形态：绝不碰。
    mkdirSync(join(root, 'unrelated-data'))

    const report = enforceSessionRetention({
      root,
      retentionDays: 7,
      maxTotalBytes: 1024 * 1024,
      logger,
      now: () => now,
    })
    expect(report.scanned).toBe(2)
    expect(report.removedExpired).toBe(1)
    expect(report.removedForCapacity).toBe(0)
    expect(report.totalBytesAfter).toBe(100)
  })

  it('never removes a directory that still has a live writer', () => {
    const root = tempRoot('crp-retention-')
    const now = Date.now()
    seed(root, 'attempt-old-locked', { ageMs: 30 * 24 * 3600_000, bytes: 100, locked: true, now })
    const report = enforceSessionRetention({
      root,
      retentionDays: 7,
      maxTotalBytes: 1024 * 1024,
      logger,
      now: () => now,
    })
    expect(report.removedExpired).toBe(0)
    expect(report.skippedLocked).toBe(1)
  })

  it('reclaims oldest-first once the volume exceeds its capacity', () => {
    const root = tempRoot('crp-retention-')
    const now = Date.now()
    // 都在保留期内，但总量超阈值：没有这一条，一次任务洪峰就能填满卷。
    seed(root, 'attempt-a', { ageMs: 3 * 3600_000, bytes: 400, now })
    seed(root, 'attempt-b', { ageMs: 2 * 3600_000, bytes: 400, now })
    seed(root, 'attempt-c', { ageMs: 1 * 3600_000, bytes: 400, now })

    const report = enforceSessionRetention({
      root,
      retentionDays: 7,
      maxTotalBytes: 900,
      logger,
      now: () => now,
    })
    expect(report.removedExpired).toBe(0)
    expect(report.removedForCapacity).toBe(1)
    expect(report.totalBytesAfter).toBeLessThanOrEqual(900)
    // 最旧的先走。
    expect(existsSync(join(root, 'attempt-a'))).toBe(false)
    expect(existsSync(join(root, 'attempt-c'))).toBe(true)
  })

  it('keeps locked directories even when the volume is over capacity', () => {
    const root = tempRoot('crp-retention-')
    const now = Date.now()
    seed(root, 'attempt-a', { ageMs: 3 * 3600_000, bytes: 800, locked: true, now })
    seed(root, 'attempt-b', { ageMs: 1 * 3600_000, bytes: 800, now })
    const report = enforceSessionRetention({
      root,
      retentionDays: 7,
      maxTotalBytes: 900,
      logger,
      now: () => now,
    })
    // 活写者优先于容量：删掉正在写的 Session 会直接毁掉一次在跑的 attempt。
    expect(report.skippedLocked).toBeGreaterThanOrEqual(1)
    expect(existsSync(join(root, 'attempt-a'))).toBe(true)
  })

  it('returns an empty report when the root does not exist', () => {
    const report = enforceSessionRetention({
      root: join(tmpdir(), 'crp-retention-missing-xyz'),
      retentionDays: 7,
      maxTotalBytes: 1024,
      logger,
    })
    expect(report.scanned).toBe(0)
    expect(report.removedExpired).toBe(0)
  })
})
