/**
 * 同一 `worker_id` 的单实例保护。
 *
 * 为什么需要：两个进程用同一个 `worker_id` 启动时，数据库不会写坏数据（任务领取
 * 有行级锁和一次性 claim token），但 `analysis_worker_heartbeat` 只有一行，两个
 * 进程会每隔几秒互相覆盖对方上报的 `current_tasks`。表现是管理页并发容量被低估
 * （显示 0/4，实际 0/8），并可能超出模型的 `max_parallel_tasks`。这类重复启动很难
 * 靠肉眼发现，所以在进程入口就挡掉。
 *
 * 实现取舍：用 `open(..., 'wx')` 的原子独占创建，而不是引入文件锁依赖。崩溃留下的
 * 陈旧锁按持有者 PID 是否存活来判定并接管，避免"崩过一次就再也起不来"。
 */

import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

/** 已有同名 Worker 在运行。调用方应当直接退出，而不是继续启动。 */
export class WorkerAlreadyRunningError extends Error {
  readonly code = 'WORKER_ALREADY_RUNNING'
  constructor(
    readonly workerId: string,
    readonly holderPid: number,
    readonly lockPath: string,
  ) {
    super(
      `worker_id "${workerId}" is already running as pid ${holderPid}. ` +
        `Stop that process, or start this replica with a different WORKER_ID. ` +
        `If you are certain the process is gone, remove ${lockPath}.`,
    )
    this.name = 'WorkerAlreadyRunningError'
  }
}

export interface InstanceLock {
  /** 锁文件绝对路径。 */
  readonly path: string
  /** 释放锁。可重复调用；只删除仍属于本进程的锁文件。 */
  release(): void
}

interface LockPayload {
  workerId: string
  pid: number
  startedAt: string
}

/**
 * 锁文件名。
 *
 * `worker_id` 可能含有不适合做文件名的字符（容器里由 hostname 生成），因此做净化；
 * 但净化会让不同 id 映射到同名文件，所以再追加原始 id 的短摘要保证唯一。
 */
export function lockFileName(workerId: string): string {
  const safe = workerId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64)
  const digest = createHash('sha256').update(workerId).digest('hex').slice(0, 8)
  return `worker-${safe}-${digest}.lock`
}

/** 进程是否存活。EPERM 表示存在但不属于当前用户，同样算存活。 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    const code = (err as { code?: string }).code
    if (code === 'EPERM') return true
    return false
  }
}

function readHolder(lockPath: string): LockPayload | null {
  try {
    const raw = readFileSync(lockPath, 'utf8')
    const parsed = JSON.parse(raw) as Partial<LockPayload>
    if (typeof parsed.pid !== 'number' || typeof parsed.workerId !== 'string') return null
    return {
      workerId: parsed.workerId,
      pid: parsed.pid,
      startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : '',
    }
  } catch {
    // 不存在、截断、非 JSON：一律当作陈旧锁处理。
    return null
  }
}

export interface AcquireInstanceLockOptions {
  workerId: string
  /** 锁文件所在目录，通常是 `WORKSPACE_ROOT`。 */
  lockDir: string
  /** 仅测试注入。 */
  pid?: number
  /** 仅测试注入。 */
  isAlive?: (pid: number) => boolean
}

export function acquireInstanceLock(options: AcquireInstanceLockOptions): InstanceLock {
  const { workerId, lockDir } = options
  const pid = options.pid ?? process.pid
  const isAlive = options.isAlive ?? isProcessAlive

  if (workerId.trim() === '') {
    throw new Error('acquireInstanceLock requires a non-empty workerId')
  }

  mkdirSync(lockDir, { recursive: true })
  const lockPath = join(lockDir, lockFileName(workerId))

  // 最多两轮：第一轮可能撞上陈旧锁，清理后重试一次。再撞就说明有进程正在竞争，
  // 此时按"已在运行"处理，宁可拒绝启动也不要两个副本同时上线。
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let fd: number
    try {
      fd = openSync(lockPath, 'wx', 0o600)
    } catch (err) {
      if ((err as { code?: string }).code !== 'EEXIST') throw err

      const holder = readHolder(lockPath)
      if (holder && holder.pid !== pid && isAlive(holder.pid)) {
        throw new WorkerAlreadyRunningError(workerId, holder.pid, lockPath)
      }
      // 陈旧锁（进程已退出/文件损坏），或本进程自己的残留：清理后重试。
      try {
        unlinkSync(lockPath)
      } catch {
        // 与另一个进程同时清理时可能已被删除，交给下一轮重试判定。
      }
      continue
    }

    const payload: LockPayload = { workerId, pid, startedAt: new Date().toISOString() }
    try {
      writeSync(fd, `${JSON.stringify(payload)}\n`)
    } finally {
      closeSync(fd)
    }

    let released = false
    return {
      path: lockPath,
      release() {
        if (released) return
        released = true
        // 只删自己的锁：万一锁已被其他进程接管，不能把它的锁删掉。
        const holder = readHolder(lockPath)
        if (holder && holder.pid !== pid) return
        try {
          unlinkSync(lockPath)
        } catch {
          // 已被清理即视为释放成功。
        }
      },
    }
  }

  const holder = readHolder(lockPath)
  throw new WorkerAlreadyRunningError(workerId, holder?.pid ?? 0, lockPath)
}
