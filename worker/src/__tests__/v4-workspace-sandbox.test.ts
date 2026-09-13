/**
 * WP3 验收：Workspace、Filesystem 与 Sandbox Shell。
 *
 * 对应第 10 节矩阵的 "Filesystem" 与 "Shell" 两行：Agent 能读写 Workspace、能运行构建和
 * 测试，但不能修改固定 Commit、不能读取密钥、不能逃逸到宿主文件系统，attempt 结束后
 * overlay 可确定性清理。
 *
 * 逃逸手法逐个单测，因为它们绕过的是不同的检查：`../..` 绕的是词法检查，symlink 绕的是
 * realpath 检查，hardlink 绕的是"目标在 Workspace 里"这个判断本身。
 */

import { afterEach, describe, expect, it } from 'vitest'
import {
  chmodSync,
  cpSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  describeRelative,
  isInside,
  measureTree,
  WorkspacePolicy,
} from '../ai/workspace/workspace-policy.js'
import { AttemptWorkspace } from '../ai/workspace/attempt-workspace.js'
import { cleanOrphanedOverlays } from '../ai/workspace/overlay-cleaner.js'
import { V4_DEFAULT_POLICY } from '../ai/policy/v4-capability-policy.js'
import { V4_ERROR_CODES, V4GovernanceError } from '../ai/policy/v4-errors.js'
import { rootLogger } from '../logger.js'

const logger = rootLogger.child({ test: 'v4-workspace' })
const cleanups: string[] = []

/**
 * 临时根目录。realpath 一次：macOS 的 tmpdir 是 `/var/...` → `/private/var/...` 的符号链接，
 * 不解析的话测试断言会拿链接路径去比对生产代码返回的真实路径。
 */
function tempRoot(prefix: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  cleanups.push(root)
  return root
}

/** 递归放开权限。只读目录会让 rm 报 ENOTEMPTY，而被测代码会刻意把 repos/ 设成 0500。 */
function chmodTreeWritable(root: string): void {
  let stat
  try {
    stat = lstatSync(root)
  } catch {
    return
  }
  if (stat.isDirectory()) {
    try {
      chmodSync(root, 0o700)
    } catch {
      // 继续尝试子项。
    }
    let entries: string[] = []
    try {
      entries = readdirSync(root)
    } catch {
      entries = []
    }
    for (const entry of entries) chmodTreeWritable(join(root, entry))
    return
  }
  try {
    chmodSync(root, 0o600)
  } catch {
    // 不可改也无妨：rm -f 仍然可能成功。
  }
}

afterEach(() => {
  while (cleanups.length > 0) {
    const path = cleanups.pop()!
    chmodTreeWritable(path)
    rmSync(path, { recursive: true, force: true })
  }
})

function expectDenied(fn: () => unknown, matcher: RegExp): void {
  try {
    fn()
  } catch (err) {
    expect(err).toBeInstanceOf(V4GovernanceError)
    expect((err as V4GovernanceError).code).toBe(V4_ERROR_CODES.WORKSPACE_POLICY_DENIED)
    expect((err as Error).message).toMatch(matcher)
    return
  }
  throw new Error('expected the path to be refused')
}

describe('isInside', () => {
  it('accepts the root itself and anything beneath it', () => {
    expect(isInside('/a/b', '/a/b')).toBe(true)
    expect(isInside('/a/b', '/a/b/c/d')).toBe(true)
  })

  it('rejects siblings whose name shares a prefix', () => {
    // `/a/bc` 不在 `/a/b` 之内。纯字符串 startsWith 会在这里出错。
    expect(isInside('/a/b', '/a/bc')).toBe(false)
    expect(isInside('/a/b', '/a')).toBe(false)
  })
})

describe('WorkspacePolicy path resolution', () => {
  function setup(): { root: string; forbidden: string; policy: WorkspacePolicy } {
    const base = tempRoot('crp-ws-policy-')
    const root = join(base, 'workspace')
    const forbidden = join(root, 'repos')
    mkdirSync(forbidden, { recursive: true })
    mkdirSync(join(root, 'overlay'), { recursive: true })
    return {
      root,
      forbidden,
      policy: new WorkspacePolicy({
        workspaceRoot: root,
        forbiddenRoots: [forbidden],
        sandbox: V4_DEFAULT_POLICY.sandbox,
      }),
    }
  }

  it('resolves an ordinary relative path for writing', () => {
    const { root, policy } = setup()
    expect(policy.resolvePath('overlay/app/New.java', 'write')).toBe(
      join(root, 'overlay/app/New.java'),
    )
  })

  it('refuses parent traversal', () => {
    const { policy } = setup()
    for (const path of ['../escape', 'overlay/../../escape', './../../etc/passwd']) {
      expectDenied(() => policy.resolvePath(path, 'write'), /escapes the attempt workspace/)
    }
  })

  it('refuses absolute paths', () => {
    const { policy } = setup()
    expectDenied(() => policy.resolvePath('/etc/passwd', 'read'), /absolute paths/)
  })

  it('refuses a NUL byte', () => {
    const { policy } = setup()
    // NUL 截断是经典的路径检查绕过：检查看到的字符串和系统调用看到的不是同一个。
    expectDenied(() => policy.resolvePath('overlay/x\0.txt', 'write'), /NUL byte/)
  })

  it('refuses an empty path', () => {
    const { policy } = setup()
    expectDenied(() => policy.resolvePath('   ', 'read'), /workspace-relative path is required/)
  })

  it('refuses a path that resolves through a symlink out of the workspace', () => {
    const { root, policy } = setup()
    // 词法上完全合法：`overlay/link/passwd` 里没有 `..`，也不是绝对路径。
    symlinkSync('/etc', join(root, 'overlay', 'link'))
    expectDenied(
      () => policy.resolvePath('overlay/link/passwd', 'read'),
      /leaves the attempt workspace/,
    )
  })

  it('refuses writing through a symlink even when the target is inside', () => {
    const { root, policy } = setup()
    writeFileSync(join(root, 'overlay', 'real.txt'), 'x')
    symlinkSync(join(root, 'overlay', 'real.txt'), join(root, 'overlay', 'alias.txt'))
    expectDenied(
      () => policy.resolvePath('overlay/alias.txt', 'write'),
      /symbolic link is not allowed/,
    )
  })

  it('refuses a hard link that may be visible outside the workspace', () => {
    const base = tempRoot('crp-ws-hardlink-')
    const root = join(base, 'workspace')
    mkdirSync(join(root, 'overlay'), { recursive: true })
    const outside = join(base, 'outside.txt')
    writeFileSync(outside, 'secret')
    // 同一个 inode 在 Workspace 外还有一个名字：写它等于写外面那个文件。
    linkSync(outside, join(root, 'overlay', 'linked.txt'))
    const policy = new WorkspacePolicy({
      workspaceRoot: root,
      forbiddenRoots: [],
      sandbox: V4_DEFAULT_POLICY.sandbox,
    })
    expectDenied(() => policy.resolvePath('overlay/linked.txt', 'write'), /hard link/)
  })

  it('refuses writing into the read-only pinned snapshot view', () => {
    const { forbidden, policy } = setup()
    writeFileSync(join(forbidden, 'Existing.java'), 'code')
    // 写 pinned 快照会让"证据来自固定 Commit"这句话失效。
    expectDenied(
      () => policy.resolvePath('repos/Existing.java', 'write'),
      /protected platform directory/,
    )
  })

  it('refuses writing over a directory', () => {
    const { root, policy } = setup()
    mkdirSync(join(root, 'overlay', 'adir'))
    expectDenied(() => policy.resolvePath('overlay/adir', 'write'), /is a directory/)
  })

  it('refuses reading a path that does not exist', () => {
    const { policy } = setup()
    expectDenied(() => policy.resolvePath('overlay/missing.txt', 'read'), /does not exist/)
  })

  it('allows reading a real file inside the workspace', () => {
    const { root, policy } = setup()
    writeFileSync(join(root, 'overlay', 'report.txt'), 'ok')
    expect(policy.resolvePath('overlay/report.txt', 'read')).toBe(
      join(root, 'overlay', 'report.txt'),
    )
  })
})

describe('WorkspacePolicy quotas and shell limits', () => {
  function policyWith(sandbox: Partial<typeof V4_DEFAULT_POLICY.sandbox>): WorkspacePolicy {
    const root = tempRoot('crp-ws-quota-')
    return new WorkspacePolicy({
      workspaceRoot: root,
      forbiddenRoots: [],
      sandbox: { ...V4_DEFAULT_POLICY.sandbox, ...sandbox },
    })
  }

  it('denies once the byte quota would be exceeded', () => {
    const policy = policyWith({ maxWorkspaceBytes: 1024 * 1024 })
    expect(() => policy.assertQuota({ bytes: 100, files: 1 }, 200)).not.toThrow()
    try {
      policy.assertQuota({ bytes: 1024 * 1024, files: 1 }, 1)
      throw new Error('expected the quota to be enforced')
    } catch (err) {
      expect((err as V4GovernanceError).code).toBe(V4_ERROR_CODES.TOOL_BUDGET_EXHAUSTED)
    }
  })

  it('denies once the file-count quota would be exceeded', () => {
    const policy = policyWith({ maxWorkspaceFiles: 100 })
    try {
      policy.assertQuota({ bytes: 0, files: 100 }, 0, 1)
      throw new Error('expected the quota to be enforced')
    } catch (err) {
      expect((err as V4GovernanceError).code).toBe(V4_ERROR_CODES.TOOL_BUDGET_EXHAUSTED)
    }
  })

  it('builds inheritable process limits and leaves the unsafe ones out', () => {
    const policy = policyWith({ commandTimeoutMs: 60000, maxProcessesPerAttempt: 64 })
    const limits = policy.processLimits().join('; ')
    expect(limits).toContain('ulimit -n 1024')
    // core dump 可能含内存里的密钥。
    expect(limits).toContain('ulimit -c 0')
    expect(limits).toMatch(/ulimit -f \d+/)

    // 下面两项**必须不在**里面，都是实测踩过的坑：
    //
    //   * `-t` 是 CPU 时间，设在长驻的 Harness 进程上会在累计耗时到点后杀掉整个 attempt，
    //     而不是那条跑飞的命令；
    //   * `-u` 是 RLIMIT_NPROC，按 UID 全局计数而不是按进程树计数。容器默认共享宿主 user
    //     namespace，同一个 worker UID 的所有副本会合并计数，设成 maxProcessesPerAttempt
    //     会让正常构建随机报 `fork: Resource temporarily unavailable`（开发机上该 UID 已有
    //     数百个进程，一设即挂）。fork bomb 的正确原语是 cgroup 的 pids_limit。
    expect(limits).not.toContain('ulimit -t')
    expect(limits).not.toContain('ulimit -u')
  })

  it('derives a container pid limit that leaves room for every slot', () => {
    // pids_limit 调得比这个值小会让正常构建随机失败，所以建议值必须可核对。
    const policy = policyWith({ maxProcessesPerAttempt: 64 })
    expect(policy.recommendedContainerPidLimit(2)).toBe(64 * 2 + 32)
    // 至少按一个 slot 算，传 0 不能得出比单 attempt 预算还小的值。
    expect(policy.recommendedContainerPidLimit(0)).toBe(64 + 32)
  })

  it('gives the shell an allowlisted environment with no platform secrets', () => {
    const policy = policyWith({})
    const env = policy.shellEnv()
    expect(Object.keys(env).sort()).toEqual([
      'CI',
      'GIT_CONFIG_NOSYSTEM',
      'GIT_TERMINAL_PROMPT',
      'HOME',
      'LANG',
      'LC_ALL',
      'PATH',
      'PWD',
      'TMPDIR',
    ])
    // 白名单而不是黑名单：新增一个 Secret 不会因为忘记加黑名单而泄露。
    for (const forbidden of [
      'SUPABASE_SERVICE_ROLE_KEY',
      'GITLAB_DEPLOY_TOKEN',
      'REVIEW_MODEL_API_KEY',
      'DEEPSEEK_API_KEY',
    ]) {
      expect(env[forbidden]).toBeUndefined()
    }
    expect(env.GIT_TERMINAL_PROMPT).toBe('0')
  })
})

describe('measureTree', () => {
  it('counts bytes and files without following symlinks out of the tree', () => {
    const root = tempRoot('crp-ws-measure-')
    writeFileSync(join(root, 'a.txt'), 'abcde')
    mkdirSync(join(root, 'sub'))
    writeFileSync(join(root, 'sub', 'b.txt'), 'xy')
    // 跟随外部 symlink 会把别人的体积算进配额，也可能陷入环。
    symlinkSync('/etc', join(root, 'etclink'))
    const measured = measureTree(root)
    expect(measured.bytes).toBe(7)
    expect(measured.files).toBe(3)
  })

  it('returns zero for a path that does not exist', () => {
    expect(measureTree(join(tmpdir(), 'crp-does-not-exist-xyz'))).toEqual({ bytes: 0, files: 0 })
  })
})

describe('AttemptWorkspace', () => {
  function create(): AttemptWorkspace {
    const attemptsRoot = tempRoot('crp-attempts-')
    const pinnedSource = tempRoot('crp-pinned-')
    mkdirSync(join(pinnedSource, 'src'), { recursive: true })
    writeFileSync(join(pinnedSource, 'src', 'Order.java'), 'class Order {}')
    mkdirSync(join(pinnedSource, '.git'), { recursive: true })
    // 模拟带凭据的 remote 配置：它绝不能出现在 Workspace 里。
    writeFileSync(join(pinnedSource, '.git', 'config'), '[remote "origin"]\n url = https://u:tok@git')

    const workspace = AttemptWorkspace.create({
      attemptsRoot,
      taskId: 'ws-test-task',
      agentAttempt: 1,
      policy: V4_DEFAULT_POLICY,
      logger,
      pinnedRepositories: [
        { repository: 'kdmanage-backend', gitDir: pinnedSource, commitSha: 'a'.repeat(40) },
      ],
      forbiddenRoots: [],
    })
    cleanups.push(workspace.root)
    return workspace
  }

  it('lays out repos, overlay and artifacts under one 0700 tree', () => {
    const workspace = create()
    expect(workspace.cwd).toBe(join(workspace.root, 'workspace'))
    expect(workspace.reposDir.startsWith(workspace.cwd)).toBe(true)
    expect(workspace.overlayDir.startsWith(workspace.cwd)).toBe(true)
    expect(workspace.artifactsDir.startsWith(workspace.cwd)).toBe(true)
  })

  it('materializes a pinned commit read-only and without .git', () => {
    const workspace = create()
    const target = workspace.materializeReadOnly('kdmanage-backend', ({ gitDir, targetDir }) => {
      // 用真实的 checkout 实现：不拷 .git。
      for (const entry of readdirSync(gitDir)) {
        if (entry === '.git') continue
        cpSync(join(gitDir, entry), join(targetDir, entry), { recursive: true, dereference: false })
      }
    })
    // `.git/config` 不在 Workspace 里，所以"`.git/config` 不含凭据"这条要求自动成立。
    expect(() => workspace.policy.resolvePath('repos/kdmanage-backend/.git/config', 'read')).toThrow()
    // 只读视图不可写。
    expectDenied(
      () => workspace.policy.resolvePath('repos/kdmanage-backend/src/Order.java', 'write'),
      /protected platform directory/,
    )
    expect(target).toBe(join(workspace.reposDir, 'kdmanage-backend'))
  })

  it('refuses to materialize a repository that is not pinned for this job', () => {
    const workspace = create()
    expect(() => workspace.materializeReadOnly('tmanage-frontend', () => undefined)).toThrow(
      /is not pinned for this job/,
    )
  })

  it('creates a writable overlay from the read-only view', () => {
    const workspace = create()
    workspace.materializeReadOnly('kdmanage-backend', ({ gitDir, targetDir }) => {
      cpSync(join(gitDir, 'src'), join(targetDir, 'src'), { recursive: true })
    })
    const overlay = workspace.createOverlay('kdmanage-backend')
    expect(overlay).toBe(join(workspace.overlayDir, 'kdmanage-backend'))
    // overlay 可写：implementation child 在这里改代码。
    const resolved = workspace.policy.resolvePath(
      'overlay/kdmanage-backend/src/Order.java',
      'write',
    )
    expect(resolved.startsWith(workspace.overlayDir)).toBe(true)
  })

  it('refuses an overlay for a repository that was never materialized', () => {
    const workspace = create()
    expect(() => workspace.createOverlay('kdmanage-backend')).toThrow(/has not been materialized/)
  })

  it('hashes an artifact itself rather than trusting the model', async () => {
    const workspace = create()
    writeFileSync(join(workspace.artifactsDir, 'fix.patch'), 'diff --git a b\n')
    const described = await workspace.describeArtifact('artifacts/fix.patch')
    expect(described.relativePath).toBe('artifacts/fix.patch')
    expect(described.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(described.sizeBytes).toBe(15)
  })

  it('refuses to register a directory as an artifact', async () => {
    const workspace = create()
    mkdirSync(join(workspace.artifactsDir, 'adir'))
    await expect(workspace.describeArtifact('artifacts/adir')).rejects.toThrow(
      /only regular files/,
    )
  })

  it('refuses an artifact path that escapes the workspace', async () => {
    const workspace = create()
    await expect(workspace.describeArtifact('../../etc/passwd')).rejects.toThrow(
      /escapes the attempt workspace/,
    )
  })

  it('disposes deterministically even after the tree was made read-only', () => {
    const workspace = create()
    workspace.materializeReadOnly('kdmanage-backend', ({ gitDir, targetDir }) => {
      cpSync(join(gitDir, 'src'), join(targetDir, 'src'), { recursive: true })
    })
    // 只读目录会让 rm 失败，而"清理失败"在这里等于把源码留在磁盘上。
    expect(workspace.dispose()).toBe(true)
    expect(workspace.dispose()).toBe(true)
  })

  it('exposes a shell spec with limits and a minimal environment', () => {
    const workspace = create()
    const spec = workspace.shellSpec()
    expect(spec.limits.join('; ')).toContain('ulimit -n')
    expect(spec.env.HOME).toBe(workspace.cwd)
    expect(spec.env.SUPABASE_SERVICE_ROLE_KEY).toBeUndefined()
  })
})

describe('cleanOrphanedOverlays', () => {
  it('removes only managed directories older than the retention window', () => {
    const attemptsRoot = tempRoot('crp-orphan-')
    mkdirSync(join(attemptsRoot, 'ws-old'))
    mkdirSync(join(attemptsRoot, 'attempt-old'))
    mkdirSync(join(attemptsRoot, 'ws-fresh'))
    // 不是我们创建的形态：绝不碰。
    mkdirSync(join(attemptsRoot, 'someone-elses-data'))
    writeFileSync(join(attemptsRoot, 'ws-old', 'source.java'), 'x')

    const now = Date.now()
    const stale = new Date(now - 24 * 60 * 60 * 1000)
    utimesSync(join(attemptsRoot, 'ws-old'), stale, stale)
    utimesSync(join(attemptsRoot, 'attempt-old'), stale, stale)
    utimesSync(join(attemptsRoot, 'someone-elses-data'), stale, stale)

    const report = cleanOrphanedOverlays({
      attemptsRoot,
      maxAgeMs: 60 * 60 * 1000,
      logger,
      now: () => now,
    })
    expect(report.scanned).toBe(3)
    expect(report.removed).toBe(2)
    expect(report.failed).toBe(0)

    expect(existsSync(join(attemptsRoot, 'ws-old'))).toBe(false)
    expect(existsSync(join(attemptsRoot, 'ws-fresh'))).toBe(true)
    // 未被管理的目录仍然在。
    expect(existsSync(join(attemptsRoot, 'someone-elses-data'))).toBe(true)
  })

  it('returns an empty report when the root does not exist', () => {
    const report = cleanOrphanedOverlays({
      attemptsRoot: join(tmpdir(), 'crp-orphan-missing-xyz'),
      maxAgeMs: 1000,
      logger,
    })
    expect(report).toEqual({ scanned: 0, removed: 0, failed: 0, reclaimedBytes: 0 })
  })
})

describe('describeRelative', () => {
  it('reports a posix-style path relative to the workspace root', () => {
    expect(describeRelative('/a/b', '/a/b/c/d.txt')).toBe('c/d.txt')
    expect(describeRelative('/a/b', '/a/b')).toBe('.')
  })
})
