/**
 * Session JSONL 的落盘位置与单写者约束。
 *
 * V3 用 memory persistence，所以"Worker 重启后继续同一个未提交 Session"这件事根本不存在。
 * V4 换成 JSONL 之后，出现了两个必须回答的新问题：
 *
 *   1. **JSONL 放哪**：不能放 attempt 临时目录（会被 cleanup 删掉），必须放持久卷。同时
 *      工具结果里带真实源码，所以目录权限 0700、按 attempt 隔离、有保留期。
 *   2. **谁能写**：两个 Worker 同时恢复同一个 Session 会写出交错的日志，而 JSONL 一旦
 *      torn 就不可能安全重放。防线是双层的 —— 本地 O_EXCL 锁文件挡同机竞争，数据库
 *      session_revision 挡跨机竞争。缺任何一层都不够：锁文件在容器重启后可能残留，
 *      而数据库 fencing 无法阻止同一个 Worker 内部的并发。
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, join } from 'node:path'
import type { Logger } from '../../logger.js'
import { redactError } from '../../security/redaction.js'
import { V4_ERROR_CODES, V4GovernanceError } from '../policy/v4-errors.js'

export interface SessionRegistryOptions {
  /** 持久卷上的 Session 根目录。 */
  root: string
  taskId: string
  agentAttempt: number
  workerId: string
  logger: Logger
}

export interface SessionSlot {
  /** 传给 Harness 的 `session-persistence-jsonl` 根目录。 */
  sessionRoot: string
  /**
   * 定位某个 Session 的日志文件。
   *
   * 路径**不能**靠推测。Harness 实际写的是
   * `<root>/<workspace-slug>/<sessionId>/session.v3.jsonl.zstd` —— 中间有一层按 cwd 生成的
   * slug，文件名带格式版本，而且默认 zstd 压缩。早先按 `<root>/<sessionId>.jsonl` 拼路径的
   * 实现永远找不到文件，于是 checkpoint 静默不落库、恢复也就无从发生。
   *
   * 找不到返回 null（Session 还没落盘是正常的）。
   */
  locate(sessionId: string): SessionLogLocation | null
  /** 释放单写者锁。 */
  release(): void
}

/** 一个已落盘的 Session 日志。 */
export interface SessionLogLocation {
  path: string
  /** 文件名里的格式版本，例如 `v3`。恢复时必须一致，否则不能重放。 */
  formatVersion: string
  /** 是否压缩存储。压缩日志无法按行做完整性检查。 */
  compressed: boolean
}

/** 锁文件内容：谁持有、什么时候拿到的。用于诊断残留锁。 */
interface LockPayload {
  workerId: string
  taskId: string
  agentAttempt: number
  pid: number
  acquiredAt: string
}

/**
 * attempt 的 Session 目录名。
 *
 * 用 task + attempt 派生而不是随机名：Worker 重启后必须能重新找到同一个目录，随机名会
 * 让"恢复"退化成"重新开始"。
 */
export function sessionDirectoryName(taskId: string, agentAttempt: number): string {
  const digest = createHash('sha256').update(`${taskId}:${agentAttempt}`).digest('hex')
  return `attempt-${digest.slice(0, 32)}`
}

export class SessionRegistry {
  constructor(private readonly options: SessionRegistryOptions) {}

  /**
   * 取得这次 attempt 的 Session 目录并拿到单写者锁。
   *
   * 锁用 `O_EXCL` 创建：这是文件系统层面的原子操作，不存在"检查后创建"的竞争窗口。
   * 已存在且持有者是本 Worker 的同一个 attempt 时接管（进程重启的正常情况）；否则拒绝。
   */
  acquire(): SessionSlot {
    const dir = join(this.options.root, sessionDirectoryName(this.options.taskId, this.options.agentAttempt))
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const lockPath = join(dir, '.writer.lock')
    const payload: LockPayload = {
      workerId: this.options.workerId,
      taskId: this.options.taskId,
      agentAttempt: this.options.agentAttempt,
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
    }

    try {
      const fd = openSync(lockPath, 'wx', 0o600)
      writeFileSync(fd, JSON.stringify(payload))
      closeSync(fd)
    } catch (err) {
      if ((err as { code?: string }).code !== 'EEXIST') throw err
      const holder = readLock(lockPath)
      if (
        holder === null ||
        holder.workerId !== this.options.workerId ||
        holder.taskId !== this.options.taskId ||
        holder.agentAttempt !== this.options.agentAttempt
      ) {
        // 别的 Worker（或别的 attempt）在写这个 Session。绝不并发写 JSONL。
        throw new V4GovernanceError(
          V4_ERROR_CODES.SESSION_FENCED,
          'another worker holds the single-writer lock for this session',
        )
      }
      // 同一个 Worker 的同一个 attempt：进程重启，接管自己的锁。
      writeFileSync(lockPath, JSON.stringify(payload), { mode: 0o600 })
      this.options.logger.info('session_writer_lock_reclaimed', {
        event: 'session_writer_lock_reclaimed',
        previous_pid: holder.pid,
      })
    }

    return {
      sessionRoot: dir,
      locate: (sessionId: string) => locateSessionLog(dir, sessionId),
      release: () => {
        try {
          rmSync(lockPath, { force: true })
        } catch (releaseError) {
          this.options.logger.info('session_writer_lock_release_failed', {
            event: 'session_writer_lock_release_failed',
            error_message: redactError(releaseError),
          })
        }
      },
    }
  }

  /**
   * 描述一个 Session 文件，用于 checkpoint 落库。
   *
   * 只返回 locator、hash、格式版本、事件条数和字节数 —— 会话原文绝不进数据库列。
   *
   * `eventCount` 只在日志是明文 JSONL 时有意义。压缩日志返回 0 而不是解压去数：
   * 解压一份带真实源码的会话日志只为得到一个计数，是不必要的暴露面，而这个字段的用途
   * 只是运维观测。
   */
  describe(location: SessionLogLocation): {
    storageLocator: string
    contentHash: string
    formatVersion: string
    eventCount: number
    sizeBytes: number
  } | null {
    if (!existsSync(location.path)) return null
    const raw = readFileSync(location.path)
    return {
      storageLocator: location.path,
      contentHash: `sha256:${createHash('sha256').update(raw).digest('hex')}`,
      formatVersion: location.formatVersion,
      eventCount: location.compressed ? 0 : countJsonlEvents(raw),
      sizeBytes: statSync(location.path).size,
    }
  }
}

/** JSONL 事件条数。末尾可能没有换行，所以过滤空行而不是直接数 \n。 */
export function countJsonlEvents(raw: Buffer): number {
  return raw
    .toString('utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0).length
}

/** Harness 的 Session 日志文件名，例如 `session.v3.jsonl` / `session.v3.jsonl.zstd`。 */
const SESSION_FILE_PATTERN = /^session\.(v\d+)\.jsonl(\.[A-Za-z0-9]+)?$/

/**
 * 从日志路径的文件名里取会话格式版本，例如 `.../session.v3.jsonl` → `v3`。
 *
 * 恢复判定需要它：checkpoint 行里只存了 locator，而"能不能重放"取决于格式版本，
 * 不能靠猜。认不出来就返回 null，由调用方 fail closed。
 */
export function sessionFormatVersionFromPath(path: string): string | null {
  const match = SESSION_FILE_PATTERN.exec(basename(path))
  return match ? match[1]! : null
}

/**
 * 在 Session 根目录下按 session id 找到日志文件。
 *
 * 递归而不是拼路径：中间那层目录名是 Harness 按 cwd 生成的 slug，我们既不应当复制它的
 * 生成规则（它会变），也不需要 —— session id 本身就是唯一的目录名。
 */
export function locateSessionLog(root: string, sessionId: string): SessionLogLocation | null {
  if (sessionId === '' || !existsSync(root)) return null
  const stack: string[] = [root]
  for (let guard = 0; stack.length > 0 && guard < 10000; guard++) {
    const dir = stack.pop()!
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        stack.push(path)
        continue
      }
      const match = SESSION_FILE_PATTERN.exec(entry.name)
      // 只认落在名为 session id 的目录里的文件：同名文件出现在别处不代表它属于这个会话。
      if (match && basename(dir) === sessionId) {
        return {
          path,
          formatVersion: match[1]!,
          compressed: match[2] !== undefined,
        }
      }
    }
  }
  return null
}

function readLock(lockPath: string): LockPayload | null {
  try {
    return JSON.parse(readFileSync(lockPath, 'utf8')) as LockPayload
  } catch {
    // 锁文件损坏等同于"未知持有者"：宁可拒绝，也不覆盖别人的写者锁。
    return null
  }
}
