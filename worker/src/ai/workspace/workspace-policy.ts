/**
 * Workspace 路径与资源策略。
 *
 * V3 的 Agent cwd 是一个空的临时目录，所以"打开 Filesystem 会发生什么"从来没被回答过。
 * V4 需要一个真实、可写、但逃不出去的 Workspace，于是要先把"越界"定义清楚。
 *
 * 这个模块是纯判定，不碰文件系统状态（除了 realpath 需要的那一次解析），因此每一种逃逸
 * 手法都能单测：
 *
 *   * `..` 穿越与绝对路径注入；
 *   * symlink / hardlink 指向 Workspace 之外；
 *   * 设备节点、FIFO、socket；
 *   * 指向固定 Commit 快照、cache root、DSH_HOME、Broker socket 的路径；
 *   * 超出字节数 / 文件数配额。
 *
 * 判定统一返回 `WORKSPACE_POLICY_DENIED`，消息里只说违反了哪条规则，不回显宿主绝对路径。
 */

import { lstatSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { V4_ERROR_CODES, V4GovernanceError } from '../policy/v4-errors.js'
import type { V4SandboxPolicy } from '../policy/v4-capability-policy.js'

export interface WorkspacePolicyOptions {
  /** 可写 overlay 的根目录（已 realpath）。 */
  workspaceRoot: string
  /**
   * 任何情况下都不可访问的目录（已 realpath）。
   *
   * 这里放的不是"敏感目录清单"，而是"这次 attempt 的特权面"：固定 Commit 快照（只读源，
   * 写入会污染证据）、代码缓存根、DSH_HOME（含 profile 与 credentials）、Broker socket 目录。
   */
  forbiddenRoots: readonly string[]
  sandbox: V4SandboxPolicy
}

export type WorkspaceAccess = 'read' | 'write'

function denied(reason: string): never {
  throw new V4GovernanceError(V4_ERROR_CODES.WORKSPACE_POLICY_DENIED, reason, true)
}

/**
 * 解析符号链接；路径还不存在时返回原值。
 *
 * forbiddenRoots 里可能有还没创建的目录（例如 Session 卷首次启动前），那种情况下用词法
 * 路径比抛错更有用：等它出现之后 realpath 自然生效。
 */
function realpathOrSelf(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/** 一个路径是否位于某个根目录之内（含根目录本身）。 */
export function isInside(root: string, candidate: string): boolean {
  if (candidate === root) return true
  const rel = relative(root, candidate)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

export class WorkspacePolicy {
  private readonly root: string
  private readonly forbidden: string[]

  constructor(private readonly options: WorkspacePolicyOptions) {
    // 根目录本身必须先 realpath。
    //
    // 这不是防御性代码：挂载点经常就是符号链接（macOS 的 `/var` → `/private/var`，容器里
    // 一个指向数据卷的 `/workspace`）。不解析根目录的后果是每一次 realpath 检查都失败 ——
    // `realpathSync(root/x)` 返回真实路径，而 `root` 还是链接路径，`isInside` 判定为逃逸。
    // 表现是"Agent 连自己的 Workspace 都读不了"，而且只在部署环境出现。
    this.root = realpathOrSelf(resolve(options.workspaceRoot))
    this.forbidden = options.forbiddenRoots.map((entry) => realpathOrSelf(resolve(entry)))
  }

  get workspaceRoot(): string {
    return this.root
  }

  /**
   * 解析一个 Workspace 相对路径为绝对路径，并确认它没有逃出去。
   *
   * 两次检查都必要：
   *  - 词法检查挡住 `../..` 和绝对路径；
   *  - realpath 检查挡住 symlink。只做词法检查时，`link -> /etc` 会被判为合法。
   */
  resolvePath(relativePath: string, access: WorkspaceAccess): string {
    if (typeof relativePath !== 'string' || relativePath.trim() === '') {
      denied('a workspace-relative path is required')
    }
    if (relativePath.includes('\0')) {
      denied('the path contains a NUL byte')
    }
    if (isAbsolute(relativePath)) {
      denied('absolute paths are not accepted; use a workspace-relative path')
    }
    const absolute = resolve(this.root, relativePath)
    if (!isInside(this.root, absolute)) {
      denied('the path escapes the attempt workspace')
    }


    // realpath 只对已存在的路径有意义。写入新文件时检查它的父目录。
    const probe = this.existingAncestor(absolute)
    let real: string
    try {
      real = realpathSync(probe)
    } catch {
      denied('the path could not be resolved inside the workspace')
    }
    if (!isInside(this.root, real)) {
      denied('the path resolves through a link that leaves the attempt workspace')
    }
    for (const forbiddenRoot of this.forbidden) {
      if (isInside(forbiddenRoot, real)) {
        denied('the path targets a protected platform directory')
      }
    }

    if (access === 'write') {
      this.assertWritableTarget(absolute)
    } else {
      this.assertReadableTarget(absolute)
    }
    return absolute
  }

  /** 已存在的最近祖先。写新文件时用它做 realpath 的探测点。 */
  private existingAncestor(absolute: string): string {
    let current = absolute
    for (let depth = 0; depth < 64; depth++) {
      try {
        lstatSync(current)
        return current
      } catch {
        const parent = resolve(current, '..')
        if (parent === current) return this.root
        current = parent
      }
    }
    return this.root
  }

  /**
   * 写目标必须是普通文件或还不存在。
   *
   * 拒绝 symlink 是因为"写 symlink"等价于写它指向的东西；拒绝 hardlink（nlink > 1）是因为
   * 同一个 inode 可能在 Workspace 外还有一个名字；拒绝设备/FIFO/socket 是因为它们根本不是
   * Artifact，写进去只会挂住或者影响宿主。
   */
  private assertWritableTarget(absolute: string): void {
    let stat
    try {
      stat = lstatSync(absolute)
    } catch {
      return // 还不存在，父目录已经校验过
    }
    if (stat.isSymbolicLink()) {
      denied('writing through a symbolic link is not allowed')
    }
    if (stat.isDirectory()) {
      denied('the target is a directory')
    }
    if (!stat.isFile()) {
      denied('the target is not a regular file')
    }
    if (stat.nlink > 1) {
      denied('the target has more than one hard link and may be visible outside the workspace')
    }
  }

  private assertReadableTarget(absolute: string): void {
    let stat
    try {
      stat = lstatSync(absolute)
    } catch {
      denied('the path does not exist in the attempt workspace')
    }
    if (stat.isSymbolicLink()) {
      // symlink 的目标已经在 realpath 阶段验过；这里拒绝的是"读一个链接本身"这种
      // 会让后续逻辑对实际读到什么产生误解的形态。
      denied('reading through a symbolic link is not allowed')
    }
    if (!stat.isFile() && !stat.isDirectory()) {
      denied('the path is not a regular file or directory')
    }
  }

  /** 配额检查：字节数与文件数。 */
  assertQuota(current: { bytes: number; files: number }, addBytes = 0, addFiles = 0): void {
    if (current.bytes + addBytes > this.options.sandbox.maxWorkspaceBytes) {
      throw new V4GovernanceError(
        V4_ERROR_CODES.TOOL_BUDGET_EXHAUSTED,
        `the attempt workspace byte quota is exhausted (limit ${this.options.sandbox.maxWorkspaceBytes} bytes)`,
        true,
      )
    }
    if (current.files + addFiles > this.options.sandbox.maxWorkspaceFiles) {
      throw new V4GovernanceError(
        V4_ERROR_CODES.TOOL_BUDGET_EXHAUSTED,
        `the attempt workspace file quota is exhausted (limit ${this.options.sandbox.maxWorkspaceFiles} files)`,
        true,
      )
    }
  }

  /**
   * 施加在 Harness 进程上的 `ulimit` 语句，由所有后代继承。
   *
   * 为什么设在 Harness 进程而不是每条 Shell 命令上：平台不接管 Harness 的 spawn 路径，
   * 拿不到"每条命令"这个注入点。而 rlimit 是**继承**的 —— 设在 dsh 上，Sandbox Shell 和
   * Jobs 起的每一个构建、测试、静态检查进程都被同一组上限约束。
   *
   * 刻意**不含**两项，都是实测踩过的坑：
   *
   *   * `ulimit -t`（CPU 时间）：设在长驻的 Harness 进程上会在累计耗时到点后杀掉整个
   *     attempt，而不是那条跑飞的命令。单条命令的时限由 bash-sandbox 的
   *     `commandTimeoutMs` 负责。
   *   * `ulimit -u`（RLIMIT_NPROC）：它按 **UID 全局计数**，不是按进程树计数，而容器默认
   *     共享宿主 user namespace —— 同一个 `worker` UID 的所有副本（以及宿主上同号 UID 的
   *     进程）会合并计到一个上限里。设成 `maxProcessesPerAttempt` 会让正常构建随机报
   *     `fork: Resource temporarily unavailable`。fork bomb 的正确原语是 cgroup：见
   *     `docker-compose.worker.yml` 的 `pids_limit`，它按容器计数且不依赖进程自律。
   *
   * RSS 同理由容器内存上限负责：Linux 的 `RLIMIT_RSS` 早已不生效，`ulimit -v` 会限制虚拟
   * 地址空间而 Node 需要大量 VA，设了直接起不来。
   */
  processLimits(): readonly string[] {
    const kbytes = Math.ceil(this.options.sandbox.maxWorkspaceBytes / 1024)
    return [
      // 打开文件数：句柄泄漏的上限，按进程计，可安全继承。
      'ulimit -n 1024',
      // 单文件大小，同时限制"写一个巨型文件填满卷"。
      `ulimit -f ${kbytes}`,
      // core dump 不需要，而且可能含内存里的密钥。
      'ulimit -c 0',
    ]
  }

  /**
   * 容器 PID 上限的建议值，供运维核对 compose 的 `pids_limit`。
   *
   * 语义是"这个容器最多允许多少进程"：每个 story slot 一个 attempt，每个 attempt 的进程
   * 预算是 `maxProcessesPerAttempt`，再加 Worker 自身与 init 的开销。调得比这个值小会让
   * 正常构建随机失败。
   */
  recommendedContainerPidLimit(storySlots: number): number {
    const slots = Math.max(1, Math.floor(storySlots))
    return this.options.sandbox.maxProcessesPerAttempt * slots + 32
  }

  /**
   * 交给 Shell 的最小环境变量集合。
   *
   * 白名单而不是黑名单：黑名单每加一个新 Secret 就会漏一次。service role、Git token、
   * 模型 Key、Broker token 全都不在这里。
   */
  shellEnv(extra: Record<string, string> = {}): Record<string, string> {
    return {
      PATH: '/usr/local/bin:/usr/bin:/bin',
      HOME: this.root,
      TMPDIR: resolve(this.root, '.tmp'),
      PWD: this.root,
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      // 明确告知工具链这是隔离环境，避免它们去找用户级配置。
      CI: '1',
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_NOSYSTEM: '1',
      ...extra,
    }
  }
}

/** 目录树的字节数与文件数。用于配额与清理确认。 */
export function measureTree(root: string): { bytes: number; files: number } {
  let bytes = 0
  let files = 0
  const stack = [root]
  while (stack.length > 0) {
    const current = stack.pop()!
    let stat
    try {
      stat = lstatSync(current)
    } catch {
      continue
    }
    if (stat.isSymbolicLink()) {
      // 不跟随：跟随会把外部体积算进来，也可能陷入环。
      files++
      continue
    }
    if (stat.isDirectory()) {
      let entries: string[] = []
      try {
        entries = readdirSync(current)
      } catch {
        continue
      }
      for (const entry of entries) stack.push(resolve(current, entry))
      continue
    }
    files++
    bytes += stat.size
  }
  return { bytes, files }
}

/** 一个绝对路径是否明显位于 Workspace 之外（用于日志脱敏前的判断）。 */
export function describeRelative(root: string, absolute: string): string {
  const rel = relative(root, absolute)
  return rel === '' ? '.' : rel.split(sep).join('/')
}

/** 一个路径当前是否存在且是目录。 */
export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}
