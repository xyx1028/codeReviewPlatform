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

import { chmodSync, mkdirSync, existsSync, renameSync, rmSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  getRepositoryUrl,
  type BranchName,
  type RepositoryName,
} from './repositories.js'
import {
  GitError,
  readCommitSubject,
  resolveRemoteHead,
  revParseHead,
  shaBelongsToBranch,
} from './verify.js'
import { isValidSha } from '../ai/schemas.js'
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
