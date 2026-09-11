/**
 * Read-only view over the four repositories pinned at one job's exact commits.
 *
 * This is the only way repository content reaches the model. It enforces the
 * repository whitelist, the blocked-path policy and hard output limits, and it
 * resolves every read against a commit object rather than a checkout.
 */

import { assertRepositoryName, type RepositoryName } from '../../git/repositories.js'
import {
  assertSafePathGlob,
  containsTraversal,
  isBlockedPath,
} from '../../security/path-policy.js'
import { clampLineRange, truncateList } from '../../tools/truncate.js'
import {
  SnapshotError,
  assertCommitPresent,
  assertCommitSha,
  blobSize,
  grepTree,
  hashContent,
  listTreePaths,
  logCommits,
  readBlobText,
  resolveBlobSha,
  type CommitRecord,
  type GitObjectContext,
} from './git-object-reader.js'

export const SNAPSHOT_LIMITS = {
  maxSearchHits: 50,
  maxFindResults: 200,
  maxReadLines: 200,
  maxBlobBytes: 1024 * 1024,
  maxCommitResults: 50,
  maxQueryLength: 512,
} as const

export interface SnapshotRepoRef {
  name: RepositoryName
  commitSha: string
  /** Absolute path of a clone containing the commit. */
  gitDir: string
}

export interface SnapshotSearchHit {
  repository: RepositoryName
  filePath: string
  lineNumber: number
  lineText: string
}

export interface SnapshotSearchResult {
  hits: SnapshotSearchHit[]
  truncated: boolean
  total: number
}

export interface SnapshotReadResult {
  repository: RepositoryName
  commitSha: string
  filePath: string
  blobSha: string
  startLine: number
  endLine: number
  /** Total line count of the blob, so callers can tell a clipped range apart. */
  totalLines: number
  content: string
  truncated: boolean
  contentHash: string
}

export interface SnapshotFindResult {
  repository: RepositoryName
  paths: string[]
  truncated: boolean
  total: number
}

export class SnapshotStore {
  private readonly repos = new Map<RepositoryName, SnapshotRepoRef>()

  constructor(refs: readonly SnapshotRepoRef[], private readonly timeoutMs = 60000) {
    for (const ref of refs) {
      const name = assertRepositoryName(ref.name)
      this.repos.set(name, { ...ref, name, commitSha: assertCommitSha(ref.commitSha) })
    }
  }

  /** Repository/commit pairs this store exposes. */
  pins(): Array<{ repository: RepositoryName; commitSha: string }> {
    return [...this.repos.values()].map((ref) => ({
      repository: ref.name,
      commitSha: ref.commitSha,
    }))
  }

  /** Fail closed before any tool call if a pinned commit is missing locally. */
  async verifyPins(): Promise<void> {
    for (const ref of this.repos.values()) {
      await assertCommitPresent(this.ctx(ref))
    }
  }

  async search(input: {
    repository: string
    query: string
    pathGlob?: string
    maxResults?: number
  }): Promise<SnapshotSearchResult> {
    const ref = this.ref(input.repository)
    const query = this.assertQuery(input.query)
    const max = Math.min(
      input.maxResults ?? SNAPSHOT_LIMITS.maxSearchHits,
      SNAPSHOT_LIMITS.maxSearchHits,
    )
    const pathSpecs = this.buildPathSpecs(input.pathGlob)

    const raw = await grepTree(this.ctx(ref), query, pathSpecs, max)
    const allowed = raw.filter((hit) => !isBlockedPath(hit.filePath))
    const { items, truncated, totalBeforeTruncation } = truncateList(allowed, max)
    return {
      hits: items.map((hit) => ({
        repository: ref.name,
        filePath: hit.filePath,
        lineNumber: hit.lineNumber,
        lineText: hit.lineText.slice(0, 400),
      })),
      truncated,
      total: totalBeforeTruncation,
    }
  }

  async findFiles(input: {
    repository: string
    pattern: string
    maxResults?: number
  }): Promise<SnapshotFindResult> {
    const ref = this.ref(input.repository)
    const pattern = assertSafePathGlob(input.pattern)
    const max = Math.min(
      input.maxResults ?? SNAPSHOT_LIMITS.maxFindResults,
      SNAPSHOT_LIMITS.maxFindResults,
    )

    const matcher = globToRegExp(pattern)
    const paths = (await listTreePaths(this.ctx(ref))).filter(
      (path) => !isBlockedPath(path) && matcher.test(path),
    )
    const { items, truncated, totalBeforeTruncation } = truncateList(paths, max)
    return {
      repository: ref.name,
      paths: items,
      truncated,
      total: totalBeforeTruncation,
    }
  }

  async readRange(input: {
    repository: string
    path: string
    startLine: number
    endLine: number
  }): Promise<SnapshotReadResult> {
    const ref = this.ref(input.repository)
    const path = this.assertPath(input.path)
    const ctx = this.ctx(ref)

    const blobSha = await resolveBlobSha(ctx, path)
    if (!blobSha) {
      throw new SnapshotError(
        `path does not exist at the pinned commit: ${path}`,
        'SNAPSHOT_PATH_MISSING',
      )
    }
    const size = await blobSize(ctx, path)
    if (size !== null && size > SNAPSHOT_LIMITS.maxBlobBytes) {
      throw new SnapshotError(
        `file exceeds ${SNAPSHOT_LIMITS.maxBlobBytes} bytes: ${path}`,
        'SNAPSHOT_FILE_TOO_LARGE',
      )
    }

    const text = await readBlobText(ctx, path)
    const lines = text.split('\n')
    const clamped = clampLineRange(input.startLine, input.endLine, SNAPSHOT_LIMITS.maxReadLines)
    if (clamped.startLine > lines.length) {
      throw new SnapshotError(
        `startLine ${clamped.startLine} is past the end of ${path} (${lines.length} lines)`,
        'SNAPSHOT_RANGE_INVALID',
      )
    }
    const endLine = Math.min(clamped.endLine, lines.length)
    const content = lines.slice(clamped.startLine - 1, endLine).join('\n')

    return {
      repository: ref.name,
      commitSha: ref.commitSha,
      filePath: path,
      blobSha,
      startLine: clamped.startLine,
      endLine,
      totalLines: lines.length,
      content,
      truncated: clamped.truncated || endLine < clamped.endLine,
      contentHash: hashContent(content),
    }
  }

  async commits(input: {
    repository: string
    query?: string
    pathGlob?: string
    maxResults?: number
  }): Promise<CommitRecord[]> {
    const ref = this.ref(input.repository)
    const max = Math.min(
      input.maxResults ?? SNAPSHOT_LIMITS.maxCommitResults,
      SNAPSHOT_LIMITS.maxCommitResults,
    )
    return logCommits(this.ctx(ref), {
      grep: input.query ? this.assertQuery(input.query) : undefined,
      maxResults: max,
      pathSpecs: this.buildPathSpecs(input.pathGlob),
    })
  }

  /** Re-read a range for verification. Returns null when it cannot be proven. */
  async reread(input: {
    repository: string
    path: string
    startLine: number
    endLine: number
  }): Promise<SnapshotReadResult | null> {
    try {
      return await this.readRange(input)
    } catch {
      return null
    }
  }

  private ref(repository: string): SnapshotRepoRef {
    const name = assertRepositoryName(repository)
    const ref = this.repos.get(name)
    if (!ref) {
      throw new SnapshotError(
        `repository is not pinned for this job: ${name}`,
        'SNAPSHOT_REPO_NOT_PINNED',
      )
    }
    return ref
  }

  private ctx(ref: SnapshotRepoRef): GitObjectContext {
    return { gitDir: ref.gitDir, commitSha: ref.commitSha, timeoutMs: this.timeoutMs }
  }

  private assertQuery(query: unknown): string {
    if (typeof query !== 'string' || query.trim().length === 0) {
      throw new SnapshotError('query must be a non-empty string', 'SNAPSHOT_QUERY_INVALID')
    }
    if (query.length > SNAPSHOT_LIMITS.maxQueryLength) {
      throw new SnapshotError(
        `query exceeds ${SNAPSHOT_LIMITS.maxQueryLength} characters`,
        'SNAPSHOT_QUERY_INVALID',
      )
    }
    if (query.includes('\0')) {
      throw new SnapshotError('query contains a null byte', 'SNAPSHOT_QUERY_INVALID')
    }
    return query
  }

  private assertPath(path: unknown): string {
    if (typeof path !== 'string' || path.length === 0) {
      throw new SnapshotError('path must be a non-empty string', 'SNAPSHOT_PATH_INVALID')
    }
    const normalized = path.replace(/^\.\//, '')
    if (normalized.startsWith('/')) {
      throw new SnapshotError('absolute paths are not allowed', 'SNAPSHOT_PATH_INVALID')
    }
    if (containsTraversal(normalized)) {
      throw new SnapshotError('path traversal rejected', 'SNAPSHOT_PATH_INVALID')
    }
    if (isBlockedPath(normalized)) {
      throw new SnapshotError(`blocked path: ${normalized}`, 'SNAPSHOT_PATH_BLOCKED')
    }
    return normalized
  }

  /** Translate a validated glob into git pathspecs. */
  private buildPathSpecs(pathGlob?: string): string[] {
    if (!pathGlob) return []
    return [`:(glob)${assertSafePathGlob(pathGlob)}`]
  }
}

/**
 * Convert a validated glob into an anchored regular expression.
 * `**` crosses directories, `*` and `?` do not.
 */
export function globToRegExp(glob: string): RegExp {
  let out = ''
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i]
    if (char === '*') {
      if (glob[i + 1] === '*') {
        out += '.*'
        i++
        if (glob[i + 1] === '/') i++
      } else {
        out += '[^/]*'
      }
      continue
    }
    if (char === '?') {
      out += '[^/]'
      continue
    }
    out += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${out}$`)
}
