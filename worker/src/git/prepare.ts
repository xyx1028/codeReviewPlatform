/**
 * Repository preparation: shallow fetch at an EXACT commit SHA, verify the
 * fetched SHA, and publish an immutable read-only cache directory keyed by full
 * SHA. (Plan §6.2, §6.3, §13.2)
 *
 * Cache layout: <cacheRoot>/<repository>/<commit-sha>/
 *
 * Two entry points:
 *  - prepareRepository(): resolve a branch head, then fetch — used only by the
 *    preparation stage that freezes the four SHAs for a QUEUED job.
 *  - prepareRepositoryAtSnapshot(): fetch a KNOWN, already-frozen SHA — used by
 *    every replica when it claims a story task. It never resolves the branch
 *    head and never silently falls back to the latest branch; if the exact SHA
 *    cannot be obtained it fails.
 */

import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
} from 'node:fs'
import { join } from 'node:path'
import { directorySize, relaxTree } from '../fs/cache-tree.js'
import {
  getRepositoryUrl,
  type BranchName,
  type RepositoryName,
} from './repositories.js'
import {
  GitError,
  isValidSha,
  readCommitSubject,
  resolveRemoteHead,
  revParseHead,
  shaBelongsToBranch,
} from './verify.js'
import { runCommand, SpawnError } from './run.js'

export interface PrepareOptions {
  cacheRoot: string
  authMode: 'local' | 'token'
  gitlabBaseUrl?: string
  deployUser?: string | null
  deployToken?: string | null
  timeoutMs?: number
}

export interface PreparedRepository {
  repository: RepositoryName
  branch: BranchName
  commitSha: string
  commitSubject: string
  /** Absolute path to the read-only cached working tree. */
  path: string
  /** True if this SHA was already cached and reused. */
  cached: boolean
}

/** Path to the published cache dir for a repo+sha. */
export function cachePathFor(cacheRoot: string, repo: RepositoryName, sha: string): string {
  return join(cacheRoot, repo, sha)
}

/** V1.11 历史裸仓库的目录名：`<cacheRoot>/<repository>/.v111-history/<head-sha>`。 */
export const HISTORY_DIR = '.v111-history'

/** 在用保护窗口的默认值：15 分钟，与 `STORY_TASK_LEASE_SECONDS` 的默认值一致。 */
export const DEFAULT_IN_USE_GRACE_MS = 15 * 60 * 1000

/**
 * 标记一个缓存目录"刚刚被用过"。
 *
 * 只读目录在某些文件系统上拒绝 utimes，失败退化为按 mtime 排序，仍可用。
 *
 * 这不只是让 LRU 更准 —— `reclaimRepoCache` 用"最近是否被标记过"作为**正在使用中**的
 * 唯一跨进程信号。所有持续读这个目录的地方（attempt 的心跳、prepare-job 的历史枚举）
 * 都必须周期性调用它，否则一个跑了半小时的 attempt 会被另一个 replica 当成冷数据删掉。
 */
export function markCacheEntryInUse(root: string): void {
  const now = new Date()
  try {
    utimesSync(root, now, now)
  } catch {
    // best effort。
  }
}

export interface RepoCacheReclaimResult {
  removed: number
  bytes: number
  /** 因"仍在保护窗口内"而跳过的条目数。>0 且 removed 没把总量压下来即容量上限不可达。 */
  skippedInUse: number
  /** 回收后的估算总量。与 maxBytes 比较即可判断上限是否真的达成。 */
  totalBytes: number
}

/**
 * 已发布的快照目录是不可变的（内容寻址 + 原子 rename + 只读），所以体积只需要算一次。
 *
 * 不缓存的代价是实测级别的：上限 20 GiB 的 cache 里 stat 一遍是百万次系统调用，而回收
 * 发生在**每个** Story Task 领到任务时，8 个并发 slot 会把同一份遍历重复八遍。
 *
 * 只记忆快照目录。历史裸仓库会被 deepen 写入，体积随时间变化，而它的顶层 mtime 不一定
 * 跟着变（写入落在 `objects/` 里），没有可靠的失效信号 —— 宁可每次重算。
 */
const immutableSizeCache = new Map<string, number>()

function snapshotDirectorySize(path: string): number {
  const hit = immutableSizeCache.get(path)
  if (hit !== undefined) return hit
  const bytes = directorySize(path)
  immutableSizeCache.set(path, bytes)
  return bytes
}

/** 回收候选：`<repo>/<sha>` 与 `<repo>/.v111-history/<sha>` 两类目录。 */
function collectReclaimEntries(
  cacheRoot: string,
): Array<{ key: string; path: string; bytes: number; lastUsedMs: number }> {
  const entries: Array<{ key: string; path: string; bytes: number; lastUsedMs: number }> = []
  const push = (key: string, path: string, immutable: boolean): void => {
    let stats
    try {
      stats = statSync(path)
    } catch {
      return
    }
    if (!stats.isDirectory()) return
    entries.push({
      key,
      path,
      bytes: immutable ? snapshotDirectorySize(path) : directorySize(path),
      // atime 与 mtime 取较新的那个：noatime 挂载下 atime 不会随读更新，而
      // markCacheEntryInUse 同时写两者，于是"被标记过"在两种挂载参数下都成立。
      lastUsedMs: Math.max(stats.atimeMs || 0, stats.mtimeMs || 0),
    })
  }
  for (const repo of readdirSync(cacheRoot)) {
    const repoDir = join(cacheRoot, repo)
    let repoStat
    try {
      repoStat = statSync(repoDir)
    } catch {
      continue
    }
    if (!repoStat.isDirectory()) continue
    for (const name of readdirSync(repoDir)) {
      // `<sha>.tmp-<pid>-<ts>`：别的进程正在 fetch 的 staging 目录，它自己会清理。
      if (name.includes('.tmp-')) continue
      if (name === HISTORY_DIR) {
        // V1.11 的历史用裸仓库，一个 Job head 一个。它和快照一样可以重新 fetch，
        // 所以同样参与回收 —— 把它排除在外的话，上限号称管住了 /workspace/cache，
        // 实际上卷里增长最快的那部分完全没人管。
        const historyRoot = join(repoDir, HISTORY_DIR)
        let children: string[]
        try {
          children = readdirSync(historyRoot)
        } catch {
          continue
        }
        for (const sha of children) {
          if (sha.startsWith('.') || sha.includes('.tmp-')) continue
          push(`${repo}/${HISTORY_DIR}/${sha}`, join(historyRoot, sha), false)
        }
        continue
      }
      if (name.startsWith('.')) continue
      push(`${repo}/${name}`, join(repoDir, name), true)
    }
  }
  return entries
}

/**
 * 仓库缓存的容量回收：超过 maxBytes 时按最后使用时间从旧到新删。
 *
 * 回收无损 —— 删掉的 SHA 需要时可以重新 fetch，缓存不是权威副本。但"无损"只对**没人
 * 正在读它**的目录成立：`SnapshotStore` 在整个 attempt 期间直接对缓存目录执行 git
 * 命令，问答会话还会把它 symlink 进轮次工作目录。删掉一个在用的目录不会得到一个干净的
 * 报错 —— `resolveBlobSha` 这类探测会把失败当成"路径不存在"，于是模型看到的是一个空
 * 仓库，可能据此判定"未实现"。这是整个平台最不能接受的失败形态。
 *
 * 所以有两层保护，缺一不可：
 *
 *   `keep`         本次任务要用的 `<repository>/<sha>`（相对 cacheRoot 的键）。
 *   `inUseGraceMs` 最近被 `markCacheEntryInUse` 标记过的目录一律不动。默认一个任务
 *                  租约的长度；在用方每个心跳刷新一次，所以在用期间永远落在窗口内，
 *                  而崩掉的 Worker 留下的目录会在一个租约后自然变成可回收。
 *
 * 单靠 `keep` 不够：`worker-cache` 是 4 个 replica × 2 个 slot 共享的命名卷，`keep`
 * 只知道本进程本次任务。
 */
export function reclaimRepoCache(input: {
  cacheRoot: string
  maxBytes: number
  keep?: ReadonlySet<string>
  /** 默认 15 分钟（与默认 STORY_TASK_LEASE_SECONDS 一致）。 */
  inUseGraceMs?: number
  /** 注入用：判定保护窗口的"现在"。 */
  nowMs?: number
}): RepoCacheReclaimResult {
  if (!existsSync(input.cacheRoot)) {
    return { removed: 0, bytes: 0, skippedInUse: 0, totalBytes: 0 }
  }
  const keep = input.keep ?? new Set<string>()
  const graceMs = input.inUseGraceMs ?? DEFAULT_IN_USE_GRACE_MS
  const nowMs = input.nowMs ?? Date.now()
  const entries = collectReclaimEntries(input.cacheRoot)
  const total = entries.reduce((sum, entry) => sum + entry.bytes, 0)
  if (total <= input.maxBytes) {
    return { removed: 0, bytes: 0, skippedInUse: 0, totalBytes: total }
  }

  entries.sort((a, b) => a.lastUsedMs - b.lastUsedMs)
  let removed = 0
  let freed = 0
  let skippedInUse = 0
  for (const entry of entries) {
    if (total - freed <= input.maxBytes) break
    if (keep.has(entry.key)) {
      skippedInUse += 1
      continue
    }
    if (nowMs - entry.lastUsedMs < graceMs) {
      skippedInUse += 1
      continue
    }
    // 发布的快照是只读树（0o444/0o555），不先解锁 rm 会失败。
    relaxTree(entry.path)
    rmSync(entry.path, { recursive: true, force: true })
    immutableSizeCache.delete(entry.path)
    removed += 1
    freed += entry.bytes
  }
  return { removed, bytes: freed, skippedInUse, totalBytes: total - freed }
}

/**
 * Build the git auth args. In `token` mode the credential is injected via the
 * http.extraHeader git config (NOT the URL) so tokens never appear in a URL
 * that could be logged. Used for BOTH ls-remote and fetch.
 */
export function authArgs(opts: PrepareOptions): string[] {
  if (opts.authMode === 'token' && opts.deployToken) {
    const basic = Buffer.from(
      `${opts.deployUser ?? 'oauth2'}:${opts.deployToken}`,
    ).toString('base64')
    return ['-c', `http.extraHeader=Authorization: Basic ${basic}`]
  }
  return []
}

/**
 * Recursively make a directory tree read-only (dirs 0o555, files 0o444). Called
 * after an atomic publish so a shared cache snapshot cannot be mutated by any
 * worker. Failures are swallowed per-entry: an unwritable subtree is fine.
 */
export function chmodReadOnlyRecursive(root: string): void {
  const walk = (p: string): void => {
    let st
    try {
      st = statSync(p)
    } catch {
      return
    }
    if (st.isDirectory()) {
      let entries: string[] = []
      try {
        entries = readdirSync(p)
      } catch {
        entries = []
      }
      for (const name of entries) {
        walk(join(p, name))
      }
      try {
        chmodSync(p, 0o555)
      } catch {
        /* best effort */
      }
    } else {
      try {
        chmodSync(p, 0o444)
      } catch {
        /* best effort */
      }
    }
  }
  walk(root)
}

/**
 * Prepare a single repository for a branch by resolving the remote head, then
 * fetching that SHA. Used by the preparation stage to freeze the job's SHAs.
 */
export async function prepareRepository(
  repository: RepositoryName,
  branch: BranchName,
  opts: PrepareOptions,
): Promise<PreparedRepository> {
  const url = getRepositoryUrl(repository, opts.gitlabBaseUrl)
  const auth = authArgs(opts)

  // Resolve the remote HEAD SHA for the target branch (auth via extraHeader).
  const resolvedSha = await resolveRemoteHead(url, branch, auth)

  return fetchExactSha(repository, branch, resolvedSha, opts)
}

/**
 * Prepare a repository at an EXACT, already-frozen SHA. Never resolves the
 * branch head; if the SHA is not obtainable it throws. This is what replicas
 * call for each claimed story task using the job's frozen snapshots.
 */
export async function prepareRepositoryAtSnapshot(
  repository: RepositoryName,
  branch: BranchName,
  commitSha: string,
  opts: PrepareOptions,
): Promise<PreparedRepository> {
  if (!isValidSha(commitSha)) {
    throw new GitError(
      `refusing to prepare ${repository} at invalid SHA`,
      'GIT_SHA_MISMATCH',
    )
  }
  return fetchExactSha(repository, branch, commitSha, opts)
}

/**
 * Core fetch: reuse the cache when the exact SHA is present, otherwise shallow
 * fetch the exact SHA into a temp dir, verify it, and atomically publish a
 * read-only snapshot. Verification NEVER falls back to a branch head.
 */
async function fetchExactSha(
  repository: RepositoryName,
  branch: BranchName,
  wantSha: string,
  opts: PrepareOptions,
): Promise<PreparedRepository> {
  const url = getRepositoryUrl(repository, opts.gitlabBaseUrl)
  const timeoutMs = opts.timeoutMs ?? 180000
  const auth = authArgs(opts)

  const finalPath = cachePathFor(opts.cacheRoot, repository, wantSha)
  if (existsSync(join(finalPath, '.git'))) {
    // Cache hit — verify the cached tree really is at the wanted SHA.
    const cachedSha = await safeRevParse(finalPath)
    if (cachedSha && shaBelongsToBranch(cachedSha, wantSha)) {
      // 命中即标记在用：reclaimRepoCache 既靠它排 LRU，也靠它判断"这个目录有人正在
      // 用"。不标记的话，一个每周都在用的热目录会被当成冷数据删掉。
      markCacheEntryInUse(finalPath)
      const subject = await safeSubject(finalPath, wantSha)
      return {
        repository,
        branch,
        commitSha: cachedSha,
        commitSubject: subject,
        path: finalPath,
        cached: true,
      }
    }
    // Cache is corrupt / wrong SHA — refuse to use it silently; re-fetch fresh.
  }

  const tmpPath = `${finalPath}.tmp-${process.pid}-${Date.now()}`
  mkdirSync(tmpPath, { recursive: true })
  try {
    await runCommand('git', [...auth, 'init', tmpPath], { timeoutMs })
    await runCommand('git', ['-C', tmpPath, 'remote', 'add', 'origin', url], { timeoutMs })
    // Fetch the exact SHA (not the branch ref). GitLab supports fetching a SHA
    // when uploadpack.allowReachableSHA1InWant is enabled; fall back to the
    // branch ref only to obtain the object, then verify the checkout matches.
    await fetchExactWithRetry(tmpPath, wantSha, branch, auth, timeoutMs)
    await runCommand('git', ['-C', tmpPath, 'checkout', '--detach', wantSha], {
      timeoutMs,
    }).catch(async () => {
      // If direct checkout of the SHA failed, checkout FETCH_HEAD then verify.
      await runCommand('git', ['-C', tmpPath, 'checkout', '--detach', 'FETCH_HEAD'], {
        timeoutMs,
      })
    })
    const fetchedSha = await revParseHead(tmpPath)

    // Strict verification: the checked-out SHA MUST equal the wanted SHA.
    if (!shaBelongsToBranch(fetchedSha, wantSha)) {
      throw new GitError(
        `fetched sha ${fetchedSha} does not match requested snapshot for ${repository}`,
        'GIT_SHA_MISMATCH',
      )
    }

    const subject = await safeSubject(tmpPath, fetchedSha)
    const publishPath = cachePathFor(opts.cacheRoot, repository, fetchedSha)

    mkdirSync(join(opts.cacheRoot, repository), { recursive: true })
    if (existsSync(join(publishPath, '.git'))) {
      rmSync(tmpPath, { recursive: true, force: true })
    } else {
      try {
        renameSync(tmpPath, publishPath)
        // Atomic publish complete → make the shared snapshot read-only.
        chmodReadOnlyRecursive(publishPath)
      } catch {
        // Lost the race; another worker published. Clean our temp.
        rmSync(tmpPath, { recursive: true, force: true })
      }
    }

    return {
      repository,
      branch,
      commitSha: fetchedSha,
      commitSubject: subject,
      path: publishPath,
      cached: false,
    }
  } catch (err) {
    rmSync(tmpPath, { recursive: true, force: true })
    throw err
  }
}

async function fetchExactWithRetry(
  workdir: string,
  wantSha: string,
  branch: BranchName,
  auth: string[],
  timeoutMs: number,
): Promise<void> {
  const ref = `refs/heads/${branch}`
  let lastErr: unknown
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // Prefer fetching the exact SHA; if the server rejects it, fetch the
      // branch ref so the object graph contains the SHA (verified on checkout).
      try {
        await runCommand(
          'git',
          [...auth, '-C', workdir, 'fetch', '--depth', '1', 'origin', wantSha],
          { timeoutMs },
        )
      } catch {
        await runCommand(
          'git',
          [...auth, '-C', workdir, 'fetch', '--depth', '1', 'origin', ref],
          { timeoutMs },
        )
      }
      return
    } catch (err) {
      lastErr = err
      if (err instanceof SpawnError && /authentication|403|401|denied/i.test(err.stderr)) {
        throw new GitError('gitlab authentication failed', 'GIT_AUTH_FAILED')
      }
      if (attempt < 2) await sleep(500 * Math.pow(2, attempt))
    }
  }
  throw new GitError(
    `git fetch failed after retries: ${(lastErr as Error)?.message ?? 'unknown'}`,
    'GIT_FETCH_FAILED',
  )
}

async function safeSubject(workdir: string, sha: string): Promise<string> {
  try {
    return await readCommitSubject(workdir, sha)
  } catch {
    return ''
  }
}

async function safeRevParse(workdir: string): Promise<string | null> {
  try {
    return await revParseHead(workdir)
  } catch {
    return null
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * Return the top-level entries of a prepared repository (files/dirs), excluding
 * the .git directory. Used to seed the retrieval prompt with repo structure.
 */
export function listTopLevelEntries(repoPath: string): string[] {
  try {
    return readdirSync(repoPath)
      .filter((n) => n !== '.git')
      .map((n) => {
        try {
          return statSync(join(repoPath, n)).isDirectory() ? `${n}/` : n
        } catch {
          return n
        }
      })
      .sort()
  } catch {
    return []
  }
}

/**
 * 把一个已冻结的缓存快照物化成 attempt Workspace 里的只读视图。
 *
 * 缓存目录本身是共享的、只读的，多个 attempt 会同时读它，所以不能让 Agent 直接把 cwd
 * 指过去 —— Harness 的 fs-sandbox 会把 cwd 当作可写 workspaceRoot。这里把内容拷进
 * attempt 自己的 `repos/<repository>/`，随后由 AttemptWorkspace 设成 0500/0400。
 *
 * `.git` 不拷：Agent 不需要它，而它包含 remote 配置（token 模式下曾经出现过凭据）。
 * 顺带满足"`.git/config` 不含凭据"这条要求 —— Workspace 里根本没有 `.git/config`。
 */
export function checkoutPinnedCommit(input: {
  gitDir: string
  commitSha: string
  targetDir: string
}): void {
  if (!existsSync(input.gitDir)) {
    throw new GitError(
      `pinned snapshot for ${input.commitSha} is not present in the cache`,
      'GIT_SNAPSHOT_MISSING',
    )
  }
  for (const entry of readdirSync(input.gitDir)) {
    if (entry === '.git') continue
    cpSync(join(input.gitDir, entry), join(input.targetDir, entry), {
      recursive: true,
      // symlink 保持为 symlink 而不是跟随：跟随会把缓存外的内容拷进 Workspace。
      dereference: false,
      force: true,
    })
  }
}
