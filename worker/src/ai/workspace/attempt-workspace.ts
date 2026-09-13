/**
 * 一次 attempt 的隔离 Workspace。
 *
 * 布局刻意分成三块，因为它们的信任级别不同：
 *
 * ```
 * <attemptRoot>/workspace/          Harness cwd，Agent 可读写
 *   ├── repos/<repository>/         固定 Commit 的只读物化视图
 *   ├── overlay/<repository>/       implementation child 的可写副本
 *   ├── artifacts/                  Patch、测试报告等产物
 *   └── .tmp/                       Shell 的 TMPDIR
 * ```
 *
 * `repos/` 是只读的：写它等于污染证据来源，所以文件模式设为 0500/0400，并且 workspace
 * policy 把它列进 forbiddenRoots —— 两道防线，一道靠内核，一道靠策略。
 *
 * `overlay/` 才是可写的。implementation child 在这里改代码、跑构建；产物登记为 Artifact，
 * 只能支持"建议这样改"，永远不能证明"代码已经这样写了"。
 */

import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { join, relative, resolve, sep } from 'node:path'
import type { Logger } from '../../logger.js'
import { redactError } from '../../security/redaction.js'
import { V4_ERROR_CODES, V4GovernanceError } from '../policy/v4-errors.js'
import type { V4CapabilityPolicy } from '../policy/v4-capability-policy.js'
import { measureTree, WorkspacePolicy } from './workspace-policy.js'

export interface AttemptWorkspaceOptions {
  attemptsRoot: string
  /**
   * 用于派生**确定性**目录名的 attempt 标识。
   *
   * 不是可选的美化项：Harness 的 `session/resume` 会校验
   * `sameDirectory(persisted.cwd, params.cwd)`，cwd 不一致直接拒绝
   * （`session cwd does not match`）。此前这里用 `mkdtempSync` 生成随机路径，于是 Worker
   * 重启后 cwd 必然不同，**会话恢复永远不可能成功** —— 而这是实测出来的，不是推理。
   */
  taskId: string
  agentAttempt: number
  policy: V4CapabilityPolicy
  logger: Logger
  /** 固定 Commit 的裸仓库路径，按仓库名。只读来源。 */
  pinnedRepositories: ReadonlyArray<{ repository: string; gitDir: string; commitSha: string }>
  /** 平台特权目录，绝不可从 Workspace 触及。 */
  forbiddenRoots: readonly string[]
}

export interface ArtifactDescription {
  relativePath: string
  contentHash: string
  sizeBytes: number
}

export interface WorkspaceUsage {
  bytes: number
  files: number
  maxBytes: number
  maxFiles: number
}

export class AttemptWorkspace {
  readonly root: string
  readonly workspaceDir: string
  readonly reposDir: string
  readonly overlayDir: string
  readonly artifactsDir: string
  readonly policy: WorkspacePolicy

  private disposed = false

  private constructor(
    root: string,
    private readonly options: AttemptWorkspaceOptions,
  ) {
    this.root = root
    this.workspaceDir = join(root, 'workspace')
    this.reposDir = join(this.workspaceDir, 'repos')
    this.overlayDir = join(this.workspaceDir, 'overlay')
    this.artifactsDir = join(this.workspaceDir, 'artifacts')
    this.policy = new WorkspacePolicy({
      workspaceRoot: this.workspaceDir,
      // 只读物化视图与平台特权目录都进 forbiddenRoots：策略层拒绝，内核层再兜一次。
      forbiddenRoots: [this.reposDir, ...options.forbiddenRoots],
      sandbox: options.policy.sandbox,
    })
  }

  /**
   * 创建 Workspace。
   *
   * 目录模式全部 0700：同一台机器上的其他用户读不到源码，也读不到 Artifact。
   */
  static create(options: AttemptWorkspaceOptions): AttemptWorkspace {
    mkdirSync(options.attemptsRoot, { recursive: true, mode: 0o700 })
    // realpath 一次并全程使用解析后的形式。
    //
    // attemptsRoot 常常经过符号链接（容器里指向数据卷的 /workspace，macOS 的 /var）。
    // 混用链接路径和真实路径会让 `relative(workspaceDir, absolute)` 算出
    // `../../private/var/...` 这种结果，于是 Artifact 的 workspace-relative 路径入库就是错的。
    // 确定性目录名：同一个 (taskId, agentAttempt) 在重启后必须解析到同一个 cwd，否则
    // `session/resume` 会以 `session cwd does not match` 拒绝，恢复无从成立。
    //
    // 复用已存在的目录而不是清空重建：overlay 里可能有上一次 attempt 已经写出的候选补丁与
    // Artifact，清掉等于让"恢复"退化成"从零开始"。只读仓库视图的物化是幂等的。
    const dirName = `ws-${createHash('sha256')
      .update(`${options.taskId}:${options.agentAttempt}`)
      .digest('hex')
      .slice(0, 32)}`
    const target = join(options.attemptsRoot, dirName)
    mkdirSync(target, { recursive: true, mode: 0o700 })
    const root = realpathSync(target)
    chmodSync(root, 0o700)
    const workspace = new AttemptWorkspace(root, options)
    try {
      for (const dir of [
        workspace.workspaceDir,
        workspace.reposDir,
        workspace.overlayDir,
        workspace.artifactsDir,
        join(workspace.workspaceDir, '.tmp'),
      ]) {
        mkdirSync(dir, { recursive: true, mode: 0o700 })
      }
      // Harness 的 fs-sandbox 会把 cwd 当作 workspaceRoot，所以 cwd 必须正好是这一层。
      return workspace
    } catch (err) {
      rmSync(root, { recursive: true, force: true })
      throw err
    }
  }

  /** Harness 子进程的 cwd。 */
  get cwd(): string {
    return this.workspaceDir
  }

  /**
   * 把一个仓库在固定 Commit 上的内容物化成只读视图。
   *
   * 用 `git --work-tree` 检出而不是拷贝裸仓库：Agent 需要看到工作树，而裸仓库对它没有意义。
   * 检出完成后整棵树设成只读，`.git` 目录不放进去 —— Agent 不需要它，而它可能含 remote 配置。
   */
  materializeReadOnly(
    repository: string,
    checkout: (input: { gitDir: string; commitSha: string; targetDir: string }) => void,
  ): string {
    const target = join(this.reposDir, repository)
    const pin = this.options.pinnedRepositories.find((entry) => entry.repository === repository)
    if (!pin) {
      throw new V4GovernanceError(
        V4_ERROR_CODES.WORKSPACE_POLICY_DENIED,
        `repository ${repository} is not pinned for this job`,
      )
    }
    mkdirSync(target, { recursive: true, mode: 0o700 })
    checkout({ gitDir: pin.gitDir, commitSha: pin.commitSha, targetDir: target })
    // 只读：写 pinned 快照会让"证据来自固定 Commit"这句话失效。
    makeTreeReadOnly(target)
    return target
  }

  /**
   * 为一个仓库创建可写 overlay。
   *
   * 拷贝而不是 hardlink/reflink：hardlink 会让 overlay 的写入回流到只读视图，那正是这里
   * 要避免的。代价是磁盘，配额由 policy 控制。
   */
  createOverlay(repository: string): string {
    const source = join(this.reposDir, repository)
    if (!existsSync(source)) {
      throw new V4GovernanceError(
        V4_ERROR_CODES.WORKSPACE_POLICY_DENIED,
        `repository ${repository} has not been materialized for this attempt`,
      )
    }
    const target = join(this.overlayDir, repository)
    if (existsSync(target)) return target
    const usage = this.usage()
    this.policy.assertQuota(usage)
    mkdirSync(target, { recursive: true, mode: 0o700 })
    cpSync(source, target, { recursive: true, dereference: false, force: true })
    makeTreeWritable(target)
    return target
  }

  /** 当前占用与配额。 */
  usage(): WorkspaceUsage {
    const measured = measureTree(this.workspaceDir)
    return {
      bytes: measured.bytes,
      files: measured.files,
      maxBytes: this.options.policy.sandbox.maxWorkspaceBytes,
      maxFiles: this.options.policy.sandbox.maxWorkspaceFiles,
    }
  }

  /**
   * 描述一个 Artifact：路径校验 + 内容 hash + 字节数。
   *
   * hash 由平台算，不接受模型自报：Artifact 的意义就在于"这份内容确实是这样"。
   */
  async describeArtifact(relativePath: string): Promise<ArtifactDescription> {
    const absolute = this.policy.resolvePath(relativePath, 'read')
    const stat = statSync(absolute)
    if (!stat.isFile()) {
      throw new V4GovernanceError(
        V4_ERROR_CODES.WORKSPACE_POLICY_DENIED,
        'only regular files can be registered as artifacts',
        true,
      )
    }
    if (stat.size > this.options.policy.sandbox.maxWorkspaceBytes) {
      throw new V4GovernanceError(
        V4_ERROR_CODES.TOOL_BUDGET_EXHAUSTED,
        'the artifact exceeds the attempt workspace byte quota',
        true,
      )
    }
    const content = readFileSync(absolute)
    return {
      relativePath: toPosix(relative(this.workspaceDir, absolute)),
      contentHash: `sha256:${createHash('sha256').update(content).digest('hex')}`,
      sizeBytes: stat.size,
    }
  }

  /**
   * 枚举 Agent 在本次 attempt 里生成的 Artifact。
   *
   * 由平台在 turn 结束后扫描，而不是给模型一个"登记 Artifact"的工具。理由有两条：
   *
   *   1. Artifact 的意义在于"这份内容确实是这样"，所以路径、大小和 hash 都必须由平台观测，
   *      不能接受模型自报；
   *   2. 少一个模型可见的写工具，就少一条需要治理的路径。
   *
   * 只扫 `artifacts/`：overlay 里的改动是"工作中间态"，把整棵 overlay 都登记成 Artifact 会
   * 把构建产物和依赖目录一起算进去。Prompt 明确要求把要留存的东西写进 `artifacts/`。
   */
  collectArtifacts(): ArtifactDescription[] {
    const collected: ArtifactDescription[] = []
    const walk = (dir: string): void => {
      let entries: string[]
      try {
        entries = readdirSync(dir)
      } catch {
        return
      }
      for (const entry of entries) {
        const absolute = join(dir, entry)
        let stat
        try {
          stat = statSync(absolute)
        } catch {
          continue
        }
        if (stat.isDirectory()) {
          walk(absolute)
          continue
        }
        if (!stat.isFile() || stat.size === 0) continue
        // 单个 Artifact 超过 Workspace 配额时跳过而不是让整次收集失败：一个巨大的
        // 构建日志不应当把其他有效产物一起拖没。
        if (stat.size > this.options.policy.sandbox.maxWorkspaceBytes) continue
        try {
          const content = readFileSync(absolute)
          collected.push({
            relativePath: toPosix(relative(this.workspaceDir, absolute)),
            contentHash: `sha256:${createHash('sha256').update(content).digest('hex')}`,
            sizeBytes: stat.size,
          })
        } catch {
          // 读不到就不登记：Artifact 元数据必须对应真实内容。
        }
      }
    }
    walk(this.artifactsDir)
    return collected
  }

  /**
   * 交给 Harness 进程的资源限额与最小环境。
   *
   * `limits` 施加在 dsh 进程上并由 Shell / Jobs 的后代继承；`env` 是 dsh 进程的非机密
   * 环境（Harness 在 spawn 模型可见的 Shell 前会自行剥掉凭据类变量名）。
   */
  shellSpec(): { limits: readonly string[]; env: Record<string, string> } {
    return {
      limits: this.policy.processLimits(),
      env: this.policy.shellEnv(),
    }
  }

  /**
   * 确定性清理。
   *
   * 先把整棵树改成可写再删：只读目录会让 rm 失败，而"清理失败"在这里等于把源码留在磁盘上。
   * 返回是否真的删干净了，调用方据此决定是否报 PROCESS_TREE_CLEANUP_FAILED 级别的问题。
   */
  dispose(): boolean {
    if (this.disposed) return true
    this.disposed = true
    try {
      makeTreeWritable(this.root)
    } catch (err) {
      this.options.logger.info('workspace_chmod_before_cleanup_failed', {
        event: 'workspace_chmod_before_cleanup_failed',
        error_message: redactError(err),
      })
    }
    try {
      rmSync(this.root, { recursive: true, force: true, maxRetries: 3 })
    } catch (err) {
      this.options.logger.error('workspace_cleanup_failed', {
        event: 'workspace_cleanup_failed',
        error_message: redactError(err),
      })
      return false
    }
    return !existsSync(this.root)
  }
}

function toPosix(path: string): string {
  return path.split(sep).join('/')
}

/** 递归设成只读。目录保留 x 位，否则无法遍历。 */
function makeTreeReadOnly(root: string): void {
  walk(root, (path, isDir) => {
    try {
      chmodSync(path, isDir ? 0o500 : 0o400)
    } catch {
      // 个别项改不动不影响整体判断：策略层仍然拒绝写 repos/。
    }
  })
}

function makeTreeWritable(root: string): void {
  walk(root, (path, isDir) => {
    try {
      chmodSync(path, isDir ? 0o700 : 0o600)
    } catch {
      // 同上。
    }
  })
}

/** 后序遍历。改权限必须自底向上，否则先锁住目录就进不去了。 */
function walk(root: string, visit: (path: string, isDir: boolean) => void): void {
  let stat
  try {
    stat = statSync(root)
  } catch {
    return
  }
  if (stat.isDirectory()) {
    let entries: string[] = []
    try {
      entries = readdirSync(root)
    } catch {
      entries = []
    }
    for (const entry of entries) walk(resolve(root, entry), visit)
    visit(root, true)
    return
  }
  visit(root, false)
}
