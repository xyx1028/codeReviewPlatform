/**
 * Session 恢复的安全判定。
 *
 * 恢复是这套系统里最容易出错的地方，因为它有两个都不可接受的失败方向：
 *
 *   * 恢复得太激进 → 重复执行已完成的副作用（最坏情况是提交两份结果）；
 *   * 恢复得太保守 → 长任务每次 Worker 重启都从零开始，Compaction 和 Todo 全部白做。
 *
 * 所以这里的规则是"能证明安全才恢复"，而不是"没发现问题就恢复"：
 *
 *   1. 已提交（DB 有 receipt）→ 不恢复，直接以 receipt 为准。ACP 响应丢失不是重跑的理由。
 *   2. Harness / Session 格式版本不匹配 → `SESSION_FORMAT_UNSUPPORTED`，创建新 attempt，
 *      绝不篡改已有 JSONL。
 *   3. JSONL torn（最后一行不是完整 JSON）→ `SESSION_RECOVERY_FAILED`。不做"截断到上一行
 *      然后继续"这种修复：被截断的那一行可能正是一次已经发出的工具调用，丢掉它就等于
 *      让模型重做一次副作用。
 *   4. content hash 与 checkpoint 记录不一致 → 有别的写者动过，`SESSION_FENCED`。
 */

import { existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { V4_ERROR_CODES, V4GovernanceError } from '../policy/v4-errors.js'

export interface ResumeCandidate {
  agentRunId: string
  rootAgentId: string | null
  rootSessionId: string | null
  sessionId: string
  sessionRevision: number
  storageLocator: string
  contentHash: string
  harnessVersion: string
  profileHash: string | null
  policyHash: string | null
  resumeCount: number
  /** 日志是否压缩存储。压缩形态下平台无法逐行验证已提交前缀。 */
  compressed?: boolean
}

export interface ResumeDecision {
  resume: boolean
  /** 不恢复时的稳定错误码；可恢复时为 null。 */
  code: string | null
  reason: string
  /** 可恢复时给出应当继续使用的 session 与 revision。 */
  session?: { sessionId: string; sessionRevision: number; storageLocator: string }
}

export interface EvaluateResumeInput {
  candidate: ResumeCandidate | null
  /**
   * 当前 Worker 的 Session 兼容键。**必须**用 `sessionCompatibilityKey()` 构造，与
   * checkpoint 落库时用的是同一个函数 —— 两侧各自拼字符串曾经导致写入 `0.1.5-rc.1/v3`、
   * 判定却拿 `0.1.5-rc.1` 去比，于是任何真实重启都被判 SESSION_FORMAT_UNSUPPORTED。
   */
  harnessVersion: string
  /** 当前 attempt 的 policy hash。 */
  policyHash: string
  /** 已提交的 receipt。存在即不恢复。 */
  alreadyCommitted: boolean
  /** 单次 attempt 允许的最大恢复次数，防止"崩溃—恢复"死循环。 */
  maxResumes: number
}

/**
 * Session 兼容键：`<Harness 包版本>/<会话格式版本>`。
 *
 * 恢复要求两者都一致。格式版本决定字节能不能被解析；包版本决定同一格式下的语义
 * （工具名、事件字段）是否还成立。宁可在补丁版本变化时开新 attempt，也不要把一段
 * "当时能做、现在不能做"的历史重放给模型 —— 这与 §12.3 "Session 格式不兼容时标记
 * SESSION_FORMAT_UNSUPPORTED，创建新 attempt" 的取向一致。
 *
 * 写入侧与判定侧都只能经这个函数构造，禁止手写模板字符串。
 */
export function sessionCompatibilityKey(input: {
  harnessVersion: string
  sessionFormatVersion: string
}): string {
  return `${input.harnessVersion}/${input.sessionFormatVersion}`
}

/**
 * 判定一个 checkpoint 是否可以安全恢复。
 *
 * 纯函数：不读文件系统之外的任何状态，因此每一条规则都能单测。torn log 的检测需要读文件，
 * 所以单独放在 `inspectSessionLog`。
 */
export function evaluateResume(input: EvaluateResumeInput): ResumeDecision {
  if (input.alreadyCommitted) {
    return {
      resume: false,
      code: null,
      reason: 'the attempt already has a committed result; the database receipt is authoritative',
    }
  }
  const candidate = input.candidate
  if (candidate === null) {
    return { resume: false, code: null, reason: 'no resumable checkpoint exists for this attempt' }
  }
  if (candidate.harnessVersion === '') {
    // 兼容键缺失就无法判断"这份日志能不能重放"。不判断而重放等于赌运气。
    return {
      resume: false,
      code: V4_ERROR_CODES.SESSION_FORMAT_UNSUPPORTED,
      reason: 'the checkpoint does not record which Harness and session format wrote it',
    }
  }
  if (candidate.harnessVersion !== input.harnessVersion) {
    return {
      resume: false,
      code: V4_ERROR_CODES.SESSION_FORMAT_UNSUPPORTED,
      reason: `the checkpoint was written by Harness ${candidate.harnessVersion}, this worker runs ${input.harnessVersion}`,
    }
  }
  if (candidate.policyHash !== null && candidate.policyHash !== input.policyHash) {
    // Policy 变了意味着工具面可能变了。重放一段"模型当时能做、现在不能做"的历史会让
    // 它反复调用不存在的工具。
    return {
      resume: false,
      code: V4_ERROR_CODES.SESSION_FORMAT_UNSUPPORTED,
      reason: 'the checkpoint was written under a different capability policy',
    }
  }
  if (candidate.resumeCount >= input.maxResumes) {
    return {
      resume: false,
      code: V4_ERROR_CODES.SESSION_RECOVERY_FAILED,
      reason: `this attempt has already been resumed ${candidate.resumeCount} times`,
    }
  }

  const inspection = inspectSessionLog(candidate.storageLocator, candidate.contentHash, {
    compressed: candidate.compressed,
  })
  if (!inspection.ok) {
    return { resume: false, code: inspection.code, reason: inspection.reason }
  }

  return {
    resume: true,
    code: null,
    reason: `resuming session at revision ${candidate.sessionRevision}`,
    session: {
      sessionId: candidate.sessionId,
      sessionRevision: candidate.sessionRevision,
      storageLocator: candidate.storageLocator,
    },
  }
}

export type LogInspection =
  | { ok: true; eventCount: number; verified: boolean }
  | { ok: false; code: string; reason: string }

/**
 * 检查 Session 日志的完整性，以及内容是否还是 checkpoint 记下的那份。
 *
 * 职责边界要说清楚，因为这里很容易做多也很容易做错：
 *
 *   * **backend 负责崩溃尾部。** `dsh-session-persistence-jsonl` 明确保证"已提交前缀的每条
 *     记录都存活，未写完的最后一行被丢弃，恢复方补写合成收尾"。所以最后一行不完整是崩溃
 *     后的**正常形态**，不是损坏 —— 平台把它当致命错误会让所有崩溃后的会话都不可恢复，
 *     那正是这段代码早先的毛病。
 *   * **平台负责已提交前缀和 fencing。** committed 部分出现无法解析的行是真损坏（backend
 *     的说法是"complete committed frame 的结构失败按 corruption 拒绝"）；内容 hash 变了则
 *     说明我们已经不是唯一写者。这两件事平台自己能判、也应该判。
 *
 * 压缩日志（`.zstd`）无法逐行验证。profile 把编码设成 `none` 正是为了让上面这条检查有效；
 * 万一遇到压缩形态，这里只做存在性与 fencing 检查并把 `verified` 置为 false，而不是拿二进制
 * 去做 JSON 解析然后一律判失败。
 */
export function inspectSessionLog(
  path: string,
  expectedHash: string,
  options: { compressed?: boolean } = {},
): LogInspection {
  if (!existsSync(path)) {
    return {
      ok: false,
      code: V4_ERROR_CODES.SESSION_RECOVERY_FAILED,
      reason: 'the checkpointed session log is missing from the persistent volume',
    }
  }
  let raw: Buffer
  try {
    raw = readFileSync(path)
  } catch {
    return {
      ok: false,
      code: V4_ERROR_CODES.SESSION_RECOVERY_FAILED,
      reason: 'the session log could not be read',
    }
  }

  const actualHash = `sha256:${createHash('sha256').update(raw).digest('hex')}`
  if (actualHash !== expectedHash) {
    // 有别的写者动过它。不是"内容变了"，而是"我们已经不是唯一写者"。
    return {
      ok: false,
      code: V4_ERROR_CODES.SESSION_FENCED,
      reason: 'the session log changed since the checkpoint was recorded',
    }
  }
  if (raw.byteLength === 0) {
    return {
      ok: false,
      code: V4_ERROR_CODES.SESSION_RECOVERY_FAILED,
      reason: 'the session log is empty',
    }
  }

  if (options.compressed === true) {
    // 完整性由 backend 的帧校验负责；这里不假装验过。
    return { ok: true, eventCount: 0, verified: false }
  }

  const lines = raw.toString('utf8').split('\n').filter((line) => line.trim().length > 0)
  if (lines.length === 0) {
    return {
      ok: false,
      code: V4_ERROR_CODES.SESSION_RECOVERY_FAILED,
      reason: 'the session log contains no records',
    }
  }
  // 已提交前缀 = 除最后一行以外的全部。最后一行可能是崩溃时写了一半的记录，backend 会丢弃它。
  for (let index = 0; index < lines.length - 1; index++) {
    try {
      JSON.parse(lines[index]!)
    } catch {
      return {
        ok: false,
        code: V4_ERROR_CODES.SESSION_RECOVERY_FAILED,
        reason: `the session log is corrupt at committed record ${index + 1}; it cannot be replayed safely`,
      }
    }
  }
  // 最后一行能解析就算一条完整记录，否则它是会被丢弃的残尾。
  let eventCount = lines.length
  try {
    JSON.parse(lines[lines.length - 1]!)
  } catch {
    eventCount = lines.length - 1
  }
  if (eventCount === 0) {
    // 只有一行且它是残尾：没有任何已提交记录可以接着走。
    return {
      ok: false,
      code: V4_ERROR_CODES.SESSION_RECOVERY_FAILED,
      reason: 'the session log holds no complete record; there is nothing to resume from',
    }
  }
  return { ok: true, eventCount, verified: true }
}

/** 把判定结果转成一个错误，供上层直接抛出。 */
export function resumeDecisionError(decision: ResumeDecision): V4GovernanceError | null {
  if (decision.resume || decision.code === null) return null
  return new V4GovernanceError(decision.code as never, decision.reason)
}
