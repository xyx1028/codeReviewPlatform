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
  utimesSync,
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
  /**
   * 恢复时接管**另一个 attempt** 的 Session 目录（V1.9）。
   *
   * 为什么需要它：目录名按 (task, attempt) 派生，而 `claim_next_story_task` 每次领取都
   * `agent_attempt+1`。也就是说"Worker 重启后回到同一个目录"这句话在真实链路里从来
   * 不成立 —— 新 attempt 拿到的是一个空目录，恢复无从发生。数据库把可恢复
   * checkpoint 所属的 attempt（`source_agent_attempt`）告诉 Worker，Worker 用它来定位
   * 目录，这才让"继续上一次的会话"成为可能。
   *
   * 缺省 undefined = 用本次 attempt 自己的目录（全新会话）。
   */
  sessionAttempt?: number
  /**
   * 允许接管别的持有者留下的单写者锁。
   *
   * 只有数据库已经发过恢复许可（`load_resumable_analysis_attempt` 返回了候选并推进了
   * `session_revision`）时才允许，因为那一步已经完成跨机裁决。即使如此，锁**存在且
   * 属于活着的进程**仍然要拒绝：那说明旧 attempt 还在写，两个 dsh 同时追加同一份
   * JSONL 会写出无法重放的交错日志。
   */
  allowTakeover?: boolean
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

/**
 * 写者锁的存活心跳间隔。持有者每这么久 touch 一次锁文件。
 *
 * 存在的理由：跨容器判活**不能**靠 PID —— 不同容器的 PID 不可比。锁文件的 mtime 是一个
 * 跨容器、跨 Worker 版本都成立的存活信号（卷是同一台宿主机上的同一个 inode）。
 */
export const LOCK_HEARTBEAT_MS = 10_000

/**
 * 接管别人的写者锁之前，要求这个 Session 至少安静这么久。
 *
 * 判据有两条，任一条命中就拒绝接管：
 *
 *   1. 锁文件最近被 touch 过 → 持有者（V1.9+ 的 Worker）活着；
 *   2. 目录里的 `session.v*.jsonl` 最近被写过 → **有人正在追加**。第二条不依赖持有者是哪
 *      个版本的 Worker，因为写日志的是 dsh 自己 —— 这正是"旧容器与 Supabase 断网、但
 *      进程还活着还在写"这种最危险情况下唯一可信的信号。
 *
 * 45 秒 = 锁心跳的 4.5 倍。取这么松是因为误拒的代价只是"这次不续跑"（退回新会话，等于
 * 改造前的行为），而误接管的代价是两个 dsh 交错追加同一份 JSONL —— 那份日志再也不能安全
 * 重放，属于不可逆损坏。
 */
export const TAKEOVER_MIN_IDLE_MS = 45_000

export class SessionRegistry {
  constructor(private readonly options: SessionRegistryOptions) {}

  /**
   * 取得这次 attempt 的 Session 目录并拿到单写者锁。
   *
   * 锁用 `O_EXCL` 创建：这是文件系统层面的原子操作，不存在"检查后创建"的竞争窗口。
   * 已存在且持有者是本 Worker 的同一个 attempt 时接管（进程重启的正常情况）；
   * `allowTakeover` 打开时也接受"另一个 attempt / 另一个 Worker 留下的锁"，但仅当那个
   * 持有者进程**已经不在**（V1.9 跨 attempt 恢复）；否则一律拒绝。
   */
  acquire(): SessionSlot {
    const dir = join(
      this.options.root,
      sessionDirectoryName(
        this.options.taskId,
        this.options.sessionAttempt ?? this.options.agentAttempt,
      ),
    )
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
      const sameHolder =
        holder !== null &&
        holder.workerId === this.options.workerId &&
        holder.taskId === this.options.taskId &&
        holder.agentAttempt === this.options.agentAttempt

      /*
       * 跨 attempt / 跨容器接管的判活。
       *
       * **不能只看 PID。** 不同容器的 PID 空间不可比，早先的写法在 workerId 不同时会
       * 短路成"持有者已死"，于是一个只是与 Supabase 断了网、进程仍在向共享卷追加 JSONL
       * 的旧容器会被判成死的，新副本接管同一份日志 —— 两个 dsh 交错 append 出的 JSONL
       * 不可能安全重放，而这是不可逆损坏。数据库 fencing 拦不住它：DB 只能拒绝数据库写入，
       * 拦不住一个还活着的进程继续写文件字节。
       *
       * 所以判活用三条**与容器无关**的证据：
       *   1. 同 Worker 时的 PID 存活（最直接，但只在同容器内有意义）；
       *   2. 锁文件 mtime（V1.9+ 的持有者每 10 秒 touch 一次）；
       *   3. Session 日志自己的 mtime（写它的是 dsh，与 Worker 版本无关）。
       */
      const holderPidAlive =
        holder !== null && holder.workerId === this.options.workerId && isProcessAlive(holder.pid)
      const lockIdleMs = fileIdleMs(lockPath)
      const lockRecentlyTouched = lockIdleMs !== null && lockIdleMs < TAKEOVER_MIN_IDLE_MS
      const logIdleMs = latestSessionWriteIdleMs(dir)
      const logRecentlyWritten = logIdleMs !== null && logIdleMs < TAKEOVER_MIN_IDLE_MS
      const holderAlive = holderPidAlive || lockRecentlyTouched || logRecentlyWritten
      const takeover =
        this.options.allowTakeover === true && holder !== null && !holderAlive
      if (!sameHolder && !takeover) {
        // 别的 Worker（或别的 attempt）在写这个 Session。绝不并发写 JSONL。
        this.options.logger.info('session_writer_lock_takeover_refused', {
          event: 'session_writer_lock_takeover_refused',
          allow_takeover: this.options.allowTakeover === true,
          holder_pid_alive: holderPidAlive,
          lock_idle_ms: lockIdleMs,
          session_log_idle_ms: logIdleMs,
        })
        throw new V4GovernanceError(
          V4_ERROR_CODES.SESSION_FENCED,
          'another worker holds the single-writer lock for this session',
        )
      }
      // 同一个 Worker 的同一个 attempt：进程重启，接管自己的锁。
      // 或者：数据库已批准跨 attempt 恢复，且没有任何证据表明还有人在写。
      writeFileSync(lockPath, JSON.stringify(payload), { mode: 0o600 })
      this.options.logger.info('session_writer_lock_reclaimed', {
        event: 'session_writer_lock_reclaimed',
        previous_pid: holder?.pid ?? null,
        previous_agent_attempt: holder?.agentAttempt ?? null,
        takeover: takeover && !sameHolder,
        lock_idle_ms: lockIdleMs,
        session_log_idle_ms: logIdleMs,
      })
    }

    /*
     * 锁存活心跳。
     *
     * 这是上面第 2 条判据的生产者：不 touch 的话，一个跑了 40 分钟的健康 attempt 在别人
     * 眼里就是"锁文件 40 分钟没动"，于是会被误接管。`unref()` 保证它不拖住进程退出。
     */
    const heartbeat = setInterval(() => {
      try {
        const now = new Date()
        utimesSync(lockPath, now, now)
      } catch {
        // 锁文件被人删了或卷不可写：不在这里升级成错误，写 JSONL 的路径会先失败。
      }
    }, LOCK_HEARTBEAT_MS)
    if (typeof (heartbeat as { unref?: () => void }).unref === 'function') {
      ;(heartbeat as { unref: () => void }).unref()
    }

    return {
      sessionRoot: dir,
      locate: (sessionId: string) => locateSessionLog(dir, sessionId),
      release: () => {
        clearInterval(heartbeat)
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
  describe(location: SessionLogLocation): SessionLogDescription | null {
    return describeSessionLog(location)
  }
}

/** {@link SessionRegistry.describe} 的返回形状。 */
export interface SessionLogDescription {
  storageLocator: string
  contentHash: string
  formatVersion: string
  eventCount: number
  sizeBytes: number
  /**
   * `contentHash` 覆盖的前缀字节数（到最后一个完整记录的换行为止）。
   *
   * V1.9 起 checkpoint 每分钟写一次，而文件同时还在被追加：把整文件哈希记进
   * checkpoint 的话，恢复时磁盘上的文件必然更长、哈希必然不等，于是每一次真实恢复
   * 都会被判成 `SESSION_FENCED`。改成"前缀哈希 + 前缀长度"之后，判定变成
   * "磁盘上的文件是否仍以这段已验证前缀开头"，追加是允许的，篡改不是。
   *
   * 压缩日志返回 0（无法按行找边界），恢复侧回退到整文件比对。
   */
  prefixBytes: number
}

/**
 * 描述一个 Session 文件，用于 checkpoint 落库。
 *
 * 独立函数而不是只有类方法：在途 checkpoint 每分钟就要算一次，而那条路径上没有
 * `SessionRegistry` 实例（Session 目录可能属于**另一个** attempt）。
 *
 * 只返回 locator、hash、格式版本、事件条数和字节数 —— 会话原文绝不进数据库列。
 */
export function describeSessionLog(location: SessionLogLocation): SessionLogDescription | null {
  if (!existsSync(location.path)) return null
  let raw: Buffer
  try {
    raw = readFileSync(location.path)
  } catch {
    return null
  }
  if (location.compressed) {
    return {
      storageLocator: location.path,
      contentHash: `sha256:${createHash('sha256').update(raw).digest('hex')}`,
      formatVersion: location.formatVersion,
      eventCount: 0,
      sizeBytes: raw.byteLength,
      prefixBytes: 0,
    }
  }
  // 前缀 = 到最后一个换行为止的字节。最后一行没有换行说明它还没写完（或者进程正
  // 好在这里被杀），把它排除在已验证前缀之外是这套判定成立的前提。
  const lastNewline = raw.lastIndexOf(0x0a)
  const prefix = lastNewline >= 0 ? raw.subarray(0, lastNewline + 1) : raw.subarray(0, 0)
  return {
    storageLocator: location.path,
    contentHash: `sha256:${createHash('sha256').update(prefix).digest('hex')}`,
    formatVersion: location.formatVersion,
    eventCount: countJsonlEvents(prefix),
    sizeBytes: raw.byteLength,
    prefixBytes: prefix.byteLength,
  }
}

/** JSONL 事件条数。末尾可能没有换行，所以过滤空行而不是直接数 \n。 */
export function countJsonlEvents(raw: Buffer): number {
  return raw
    .toString('utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0).length
}

/**
 * 一个文件距最后一次修改过了多久（毫秒）。文件不存在返回 null。
 *
 * 用 mtime 而不是 PID：跨容器判活唯一可用的信号就是文件系统时间，而卷在同一台宿主机上，
 * mtime 由同一个内核写入，不存在时钟分叉。
 */
export function fileIdleMs(path: string, now: number = Date.now()): number | null {
  try {
    return Math.max(0, now - statSync(path).mtimeMs)
  } catch {
    return null
  }
}

/**
 * 这个 Session 目录里最近一次被写入的 JSONL 距今多久（毫秒）。没有日志文件返回 null。
 *
 * 这是接管判活里**与 Worker 版本无关**的那一条：写日志的是 dsh 自己。一个旧版 Worker
 * 不会 touch 锁文件，但只要它的 dsh 还在跑，日志的 mtime 就一直在动。
 */
export function latestSessionWriteIdleMs(dir: string, now: number = Date.now()): number | null {
  let newest: number | null = null
  const stack: string[] = [dir]
  for (let guard = 0; stack.length > 0 && guard < 10000; guard++) {
    const current = stack.pop()!
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(path)
        continue
      }
      if (!SESSION_FILE_PATTERN.test(entry.name)) continue
      try {
        const mtime = statSync(path).mtimeMs
        if (newest === null || mtime > newest) newest = mtime
      } catch {
        // 文件刚被换代（generation 切换）时可能瞬时消失，忽略。
      }
    }
  }
  return newest === null ? null : Math.max(0, now - newest)
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

/**
 * 这个 PID 还活着吗。
 *
 * 只在"锁的持有者是本 Worker（同一个容器 / 同一个 PID 名字空间）"时才有意义 ——
 * 跨容器的 PID 不可比，所以调用方先比 workerId。`kill(pid, 0)` 不发信号，只做存在性
 * 与权限检查；EPERM 说明进程存在但不属于我们，同样按"活着"处理（宁可不接管）。
 */
function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as { code?: string }).code === 'EPERM'
  }
}

