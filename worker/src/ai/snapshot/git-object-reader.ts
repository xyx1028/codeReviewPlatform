/**
 * Read repository content straight out of Git objects at an exact commit.
 *
 * Every read is addressed as `<commit>:<path>`, so nothing here depends on a
 * working tree. A checkout that was modified, truncated, or replaced with a
 * symlink cannot change what these functions return, and there is no filesystem
 * path to escape from — which is why the snapshot layer does not need realpath
 * containment the way the legacy working-tree tools do.
 */

import { createHash } from 'node:crypto'
import { runCommand, SpawnError } from '../../git/run.js'

export class SnapshotError extends Error {
  readonly code: string

  constructor(message: string, code: string) {
    super(message)
    this.name = 'SnapshotError'
    this.code = code
  }
}

const SHA_PATTERN = /^[0-9a-f]{40}$/

/** Reject anything that is not a full lowercase 40-hex commit id. */
export function assertCommitSha(value: unknown): string {
  if (typeof value !== 'string' || !SHA_PATTERN.test(value)) {
    throw new SnapshotError(
      `expected a full 40-hex commit sha, got: ${String(value).slice(0, 64)}`,
      'SNAPSHOT_SHA_INVALID',
    )
  }
  return value
}

export interface GitObjectContext {
  /** Absolute path of a repository clone that contains the commit. */
  gitDir: string
  commitSha: string
  timeoutMs?: number
}

/** Confirm the commit object exists locally. Never resolves a branch head. */
export async function assertCommitPresent(ctx: GitObjectContext): Promise<void> {
  const sha = assertCommitSha(ctx.commitSha)
  try {
    const res = await runCommand('git', ['cat-file', '-t', sha], {
      cwd: ctx.gitDir,
      timeoutMs: ctx.timeoutMs ?? 30000,
    })
    if (res.stdout.trim() !== 'commit') {
      throw new SnapshotError(`${sha} is not a commit object`, 'SNAPSHOT_COMMIT_MISSING')
    }
  } catch (err) {
    if (err instanceof SnapshotError) throw err
    throw new SnapshotError(
      `commit ${sha} is not present in the local snapshot`,
      'SNAPSHOT_COMMIT_MISSING',
    )
  }
}

/** Resolve the blob id of one path at the commit, or null when absent. */
export async function resolveBlobSha(
  ctx: GitObjectContext,
  path: string,
): Promise<string | null> {
  const sha = assertCommitSha(ctx.commitSha)
  try {
    const res = await runCommand('git', ['rev-parse', `${sha}:${path}`], {
      cwd: ctx.gitDir,
      timeoutMs: ctx.timeoutMs ?? 30000,
    })
    const blob = res.stdout.trim()
    return SHA_PATTERN.test(blob) ? blob : null
  } catch {
    return null
  }
}

/** Byte size of one blob at the commit, or null when the path is absent. */
export async function blobSize(ctx: GitObjectContext, path: string): Promise<number | null> {
  const sha = assertCommitSha(ctx.commitSha)
  try {
    const res = await runCommand('git', ['cat-file', '-s', `${sha}:${path}`], {
      cwd: ctx.gitDir,
      timeoutMs: ctx.timeoutMs ?? 30000,
    })
    const size = Number(res.stdout.trim())
    return Number.isFinite(size) ? size : null
  } catch {
    return null
  }
}

/** Read one blob's full text at the commit. */
export async function readBlobText(ctx: GitObjectContext, path: string): Promise<string> {
  const sha = assertCommitSha(ctx.commitSha)
  try {
    const res = await runCommand('git', ['cat-file', 'blob', `${sha}:${path}`], {
      cwd: ctx.gitDir,
      timeoutMs: ctx.timeoutMs ?? 60000,
    })
    return res.stdout
  } catch {
    throw new SnapshotError(
      `path not readable at ${sha.slice(0, 12)}: ${path}`,
      'SNAPSHOT_PATH_MISSING',
    )
  }
}

/** List every file path in the commit tree. */
export async function listTreePaths(ctx: GitObjectContext): Promise<string[]> {
  const sha = assertCommitSha(ctx.commitSha)
  const res = await runCommand(
    'git',
    ['ls-tree', '-r', '--name-only', '-z', sha],
    { cwd: ctx.gitDir, timeoutMs: ctx.timeoutMs ?? 120000 },
  )
  return res.stdout.split('\0').filter((entry) => entry.length > 0)
}

export interface GitGrepHit {
  filePath: string
  lineNumber: number
  lineText: string
}

/**
 * Search the commit tree with `git grep`. Fixed-string matching keeps model
 * input out of regex evaluation.
 */
export async function grepTree(
  ctx: GitObjectContext,
  query: string,
  pathSpecs: string[],
  maxHits: number,
): Promise<GitGrepHit[]> {
  const sha = assertCommitSha(ctx.commitSha)
  const args = [
    'grep',
    '--fixed-strings',
    '--line-number',
    '--no-color',
    '-I',
    '--max-count',
    String(Math.max(1, maxHits)),
    '-e',
    query,
    sha,
  ]
  if (pathSpecs.length > 0) {
    args.push('--', ...pathSpecs)
  }

  let stdout: string
  try {
    const res = await runCommand('git', args, {
      cwd: ctx.gitDir,
      timeoutMs: ctx.timeoutMs ?? 60000,
    })
    stdout = res.stdout
  } catch (err) {
    // git grep exits 1 when nothing matched; that is an empty result, not a fault.
    if (err instanceof SpawnError && err.code === 1) return []
    throw err
  }

  const hits: GitGrepHit[] = []
  for (const line of stdout.split('\n')) {
    if (!line) continue
    const parsed = parseGrepLine(line, sha)
    if (parsed) hits.push(parsed)
  }
  return hits
}

/** Parse `<commit>:<path>:<line>:<text>` as produced by `git grep <tree-ish>`. */
export function parseGrepLine(line: string, commitSha: string): GitGrepHit | null {
  const prefix = `${commitSha}:`
  if (!line.startsWith(prefix)) return null
  const rest = line.slice(prefix.length)
  const match = rest.match(/^(.*?):(\d+):(.*)$/)
  if (!match) return null
  const lineNumber = Number(match[2])
  if (!Number.isInteger(lineNumber) || lineNumber < 1) return null
  return { filePath: match[1], lineNumber, lineText: match[3] }
}

export interface CommitRecord {
  sha: string
  subject: string
  author: string
  date: string
}

/** Read commit history reachable from the pinned commit. */
export async function logCommits(
  ctx: GitObjectContext,
  options: { grep?: string; maxResults: number; pathSpecs?: string[] },
): Promise<CommitRecord[]> {
  const sha = assertCommitSha(ctx.commitSha)
  const args = [
    'log',
    `--max-count=${Math.max(1, options.maxResults)}`,
    '--format=%H%x1f%s%x1f%an%x1f%aI',
    '--no-color',
  ]
  if (options.grep) {
    args.push('--fixed-strings', `--grep=${options.grep}`, '--regexp-ignore-case')
  }
  args.push(sha)
  if (options.pathSpecs && options.pathSpecs.length > 0) {
    args.push('--', ...options.pathSpecs)
  }

  const res = await runCommand('git', args, {
    cwd: ctx.gitDir,
    timeoutMs: ctx.timeoutMs ?? 60000,
  })
  const records: CommitRecord[] = []
  for (const line of res.stdout.split('\n')) {
    if (!line) continue
    const [commit, subject, author, date] = line.split('\u001f')
    if (!commit) continue
    records.push({
      sha: commit,
      subject: subject ?? '',
      author: author ?? '',
      date: date ?? '',
    })
  }
  return records
}

/** Stable hash used to pin exactly what was shown to the model. */
export function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}
