/**
 * Read-only view over the repositories pinned at one job's exact commits.
 *
 * This is the only way repository content reaches the model. It enforces the
 * repository whitelist, the blocked-path policy and hard output limits, and it
 * resolves every read against a commit object rather than a checkout.
 */

import { createHash } from 'node:crypto'
import { assertRepositoryName, type RepositoryName } from '../../git/repositories.js'
import { runCommand } from '../../git/run.js'
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

export const STORY_DIFF_LIMITS = {
  maxArchiveBytes: 10 * 1024 * 1024,
  maxPageBytes: 36 * 1024,
  maxPageLines: 200,
  maxFilesReturned: 20,
  maxPathsPerDiff: 500,
} as const

export interface StoryCommitDiffFile {
  path: string
  additions: number | null
  deletions: number | null
  binary: boolean
}

export interface StoryCommitDiffResult {
  repository: RepositoryName
  commitSha: string
  status: 'AVAILABLE' | 'BINARY' | 'DIFF_TOO_LARGE'
  files: StoryCommitDiffFile[]
  filesTotal: number
  filesTruncated: boolean
  blockedFileCount: number
  content: string
  diffLines: number
  bytesReturned: number
  truncated: boolean
  nextOffset: number | null
  archiveSha256: string | null
}

export class SnapshotStore {
  private readonly repos = new Map<RepositoryName, SnapshotRepoRef>()

  constructor(refs: readonly SnapshotRepoRef[], private readonly timeoutMs = 60000) {
    for (const ref of refs) {
      const name = assertRepositoryName(ref.name)
      this.repos.set(name, { ...ref, name, commitSha: assertCommitSha(ref.commitSha) })
    }
  }

  /**
   * Repository/commit pairs this store exposes.
   *
   * `gitDir` 只给 Worker 侧用（把固定 Commit 物化成只读工作树），绝不进入模型上下文 ——
   * `buildAttemptPatch` 传给 snapshot-tools 的只有仓库名。V4 之前这里不返回 gitDir，
   * 于是 Workspace 无从知道去哪里检出，只读视图永远是空的。
   */
  pins(): Array<{ repository: RepositoryName; commitSha: string; gitDir: string }> {
    return [...this.repos.values()].map((ref) => ({
      repository: ref.name,
      commitSha: ref.commitSha,
      gitDir: ref.gitDir,
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
    /** Trusted Broker-only restriction; never copy this field from a request body. */
    allowedPaths?: readonly string[]
  }): Promise<SnapshotSearchResult> {
    const ref = this.ref(input.repository)
    const query = this.assertQuery(input.query)
    const max = Math.min(
      input.maxResults ?? SNAPSHOT_LIMITS.maxSearchHits,
      SNAPSHOT_LIMITS.maxSearchHits,
    )
    const requestedMatcher = input.pathGlob === undefined
      ? null
      : globToRegExp(assertSafePathGlob(input.pathGlob))
    const scopedPaths = input.allowedPaths?.map((path) => this.assertPath(path))
    // Literal pathspecs prevent glob metacharacters in a frozen filename from
    // widening PRIMARY access. An empty trusted set intentionally matches none.
    if (scopedPaths?.length === 0) return { hits: [], truncated: false, total: 0 }
    const pathSpecs = scopedPaths === undefined
      ? this.buildPathSpecs(input.pathGlob)
      : scopedPaths.map((path) => `:(literal)${path}`)

    const raw = await grepTree(this.ctx(ref), query, pathSpecs, max)
    const allowed = raw.filter((hit) =>
      !isBlockedPath(hit.filePath) && (requestedMatcher === null || requestedMatcher.test(hit.filePath)),
    )
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
    /** Trusted Broker-only restriction; never copy this field from a request body. */
    allowedPaths?: readonly string[]
  }): Promise<SnapshotFindResult> {
    const ref = this.ref(input.repository)
    const pattern = assertSafePathGlob(input.pattern)
    const max = Math.min(
      input.maxResults ?? SNAPSHOT_LIMITS.maxFindResults,
      SNAPSHOT_LIMITS.maxFindResults,
    )

    const matcher = globToRegExp(pattern)
    const scopedPaths = input.allowedPaths === undefined
      ? null
      : new Set(input.allowedPaths.map((path) => this.assertPath(path)))
    const paths = (await listTreePaths(this.ctx(ref))).filter(
      (path) => !isBlockedPath(path) && matcher.test(path) && (scopedPaths === null || scopedPaths.has(path)),
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

  /**
   * Read a real Git diff for a frozen story candidate.
   *
   * `candidateCommit` is supplied only by the Broker from the frozen scope. The
   * model never controls a revision argument. The resolved object must also be
   * reachable from the repository HEAD pinned for this job.
   */
  async readStoryCommitDiff(input: {
    repository: string
    candidateCommit: string
    filePath?: string
    offset?: number
  }): Promise<StoryCommitDiffResult> {
    const ref = this.ref(input.repository)
    if (!/^[0-9a-f]{7,40}$/.test(input.candidateCommit)) {
      throw new SnapshotError('the frozen candidate has an invalid commit id', 'STORY_CANDIDATE_INVALID')
    }
    const offset = input.offset ?? 0
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new SnapshotError('diff cursor is invalid', 'STORY_DIFF_CURSOR_INVALID')
    }

    let commitSha: string
    try {
      const resolved = await runCommand('git', ['rev-parse', '--verify', `${input.candidateCommit}^{commit}`], {
        cwd: ref.gitDir,
        timeoutMs: this.timeoutMs,
      })
      commitSha = assertCommitSha(resolved.stdout.trim())
      if (!commitSha.startsWith(input.candidateCommit)) throw new Error('candidate prefix mismatch')
      await runCommand('git', ['merge-base', '--is-ancestor', commitSha, ref.commitSha], {
        cwd: ref.gitDir,
        timeoutMs: this.timeoutMs,
      })
    } catch {
      throw new SnapshotError(
        'the frozen candidate commit is missing or not reachable from the pinned repository head',
        'STORY_CANDIDATE_NOT_REACHABLE',
      )
    }

    const stats = await runCommand(
      'git',
      ['diff-tree', '--root', '--no-commit-id', '--numstat', '-r', '--no-renames', '-z', commitSha],
      { cwd: ref.gitDir, timeoutMs: this.timeoutMs, maxBuffer: 2 * 1024 * 1024 },
    )
    if (stats.stdoutTruncated) {
      return storyDiffTooLarge(ref.name, commitSha)
    }
    const allFiles = parseStoryDiffNumstat(stats.stdout)
    const blockedFileCount = allFiles.filter((file) => isBlockedPath(file.path)).length
    const allowedFiles = allFiles.filter((file) => !isBlockedPath(file.path))

    let selectedFiles = allowedFiles
    if (input.filePath !== undefined) {
      const path = assertStoryDiffPath(input.filePath)
      if (isBlockedPath(path)) {
        throw new SnapshotError(`blocked path: ${path}`, 'SNAPSHOT_PATH_BLOCKED')
      }
      selectedFiles = allowedFiles.filter((file) => file.path === path)
      if (selectedFiles.length === 0) {
        throw new SnapshotError(
          `path is not changed by this frozen candidate: ${path}`,
          'STORY_DIFF_PATH_NOT_CHANGED',
        )
      }
    }

    if (selectedFiles.length > STORY_DIFF_LIMITS.maxPathsPerDiff) {
      return {
        ...storyDiffTooLarge(ref.name, commitSha),
        files: selectedFiles.slice(0, STORY_DIFF_LIMITS.maxFilesReturned),
        filesTotal: selectedFiles.length,
        filesTruncated: true,
        blockedFileCount,
      }
    }
    if (selectedFiles.length === 0) {
      return {
        repository: ref.name,
        commitSha,
        status: 'AVAILABLE',
        files: [],
        filesTotal: 0,
        filesTruncated: false,
        blockedFileCount,
        content: '',
        diffLines: 0,
        bytesReturned: 0,
        truncated: false,
        nextOffset: null,
        archiveSha256: `sha256:${createHash('sha256').update('').digest('hex')}`,
      }
    }

    const diff = await runCommand(
      'git',
      [
        // core.quotepath=false keeps non-ASCII paths readable in the patch headers.
        // Otherwise the agent reads `"a/docs/ERP\347\247\237....md"` and copies that
        // escaped form into evidence, which no longer matches the numstat path.
        '-c', 'core.quotepath=false',
        'show', '--format=', '--no-ext-diff', '--no-textconv', '--unified=3', '--no-renames',
        commitSha, '--', ...selectedFiles.map((file) => file.path),
      ],
      {
        cwd: ref.gitDir,
        timeoutMs: this.timeoutMs,
        maxBuffer: STORY_DIFF_LIMITS.maxArchiveBytes,
      },
    )
    if (diff.stdoutTruncated || diff.stdoutBytes > STORY_DIFF_LIMITS.maxArchiveBytes) {
      return {
        ...storyDiffTooLarge(ref.name, commitSha),
        files: selectedFiles.slice(0, STORY_DIFF_LIMITS.maxFilesReturned),
        filesTotal: selectedFiles.length,
        filesTruncated: selectedFiles.length > STORY_DIFF_LIMITS.maxFilesReturned,
        blockedFileCount,
      }
    }

    const archive = Buffer.from(diff.stdout, 'utf8')
    if (offset > archive.byteLength) {
      throw new SnapshotError('diff cursor is past the end of the archive', 'STORY_DIFF_CURSOR_INVALID')
    }
    const page = sliceStoryDiffPage(archive, offset)
    const allBinary = selectedFiles.length > 0 && selectedFiles.every((file) => file.binary)
    return {
      repository: ref.name,
      commitSha,
      status: allBinary ? 'BINARY' : 'AVAILABLE',
      files: selectedFiles.slice(0, STORY_DIFF_LIMITS.maxFilesReturned),
      filesTotal: selectedFiles.length,
      filesTruncated: selectedFiles.length > STORY_DIFF_LIMITS.maxFilesReturned,
      blockedFileCount,
      content: page.content,
      diffLines: page.lines,
      bytesReturned: page.bytes,
      truncated: page.nextOffset !== null,
      nextOffset: page.nextOffset,
      archiveSha256: `sha256:${createHash('sha256').update(archive).digest('hex')}`,
    }
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

function parseStoryDiffNumstat(raw: string): StoryCommitDiffFile[] {
  const files: StoryCommitDiffFile[] = []
  for (const record of raw.split('\0')) {
    if (record === '') continue
    const firstTab = record.indexOf('\t')
    const secondTab = firstTab < 0 ? -1 : record.indexOf('\t', firstTab + 1)
    if (firstTab < 0 || secondTab < 0) continue
    const additionsRaw = record.slice(0, firstTab)
    const deletionsRaw = record.slice(firstTab + 1, secondTab)
    const path = record.slice(secondTab + 1)
    if (path === '' || path.length > 1024 || containsTraversal(path) || path.startsWith('/') || path.includes('\\')) continue
    const binary = additionsRaw === '-' || deletionsRaw === '-'
    files.push({
      path,
      additions: binary ? null : Number(additionsRaw),
      deletions: binary ? null : Number(deletionsRaw),
      binary,
    })
  }
  return files
}

function assertStoryDiffPath(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024) {
    throw new SnapshotError('diff path must be a non-empty repository-relative path', 'SNAPSHOT_PATH_INVALID')
  }
  const path = value.replace(/^\.\//, '')
  if (path.startsWith('/') || path.includes('\\') || containsTraversal(path)) {
    throw new SnapshotError('unsafe diff path rejected', 'SNAPSHOT_PATH_INVALID')
  }
  return path
}

function storyDiffTooLarge(repository: RepositoryName, commitSha: string): StoryCommitDiffResult {
  return {
    repository,
    commitSha,
    status: 'DIFF_TOO_LARGE',
    files: [],
    filesTotal: 0,
    filesTruncated: false,
    blockedFileCount: 0,
    content: '',
    diffLines: 0,
    bytesReturned: 0,
    truncated: false,
    nextOffset: null,
    archiveSha256: null,
  }
}

function sliceStoryDiffPage(
  archive: Buffer,
  offset: number,
): { content: string; lines: number; bytes: number; nextOffset: number | null } {
  if (offset === archive.byteLength) return { content: '', lines: 0, bytes: 0, nextOffset: null }
  const hardEnd = Math.min(offset + STORY_DIFF_LIMITS.maxPageBytes, archive.byteLength)
  let end = hardEnd
  let newlines = 0
  for (let index = offset; index < hardEnd; index++) {
    if (archive[index] === 0x0a) {
      newlines++
      if (newlines >= STORY_DIFF_LIMITS.maxPageLines) {
        end = index + 1
        break
      }
    }
  }
  // Never split a UTF-8 continuation sequence between pages.
  while (end > offset && end < archive.byteLength && (archive[end]! & 0xc0) === 0x80) end--
  if (end === offset) end = hardEnd
  const bytes = end - offset
  const content = archive.subarray(offset, end).toString('utf8')
  const lines = content === '' ? 0 : Math.min(content.split('\n').length, STORY_DIFF_LIMITS.maxPageLines)
  return { content, lines, bytes, nextOffset: end < archive.byteLength ? end : null }
}
