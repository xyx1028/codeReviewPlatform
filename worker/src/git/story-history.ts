import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  canonicalizeCommitManifest,
  type CanonicalCommitManifest,
  type CommitIdentityMatchStatus,
  type CommitManifestEntry,
  type CommitManifestFile,
} from './commit-manifest.js'
import {
  ancestryCheckArgs,
  deriveTimeBasedBase,
  evaluateHistoryRange,
  historyEnumerationArgs,
  type HistoryEnumerationStatus,
} from './history-range.js'
import { authArgs, type PrepareOptions, type PreparedRepository } from './prepare.js'
import { getRepositoryUrl } from './repositories.js'
import { runCommand, SpawnError } from './run.js'

export interface RepositoryHistoryManifestWire {
  schema_version: 1
  repository: string
  base_sha: string | null
  head_sha: string
  head_subject: string | null
  range_source: 'TIME_DERIVED' | 'PREVIOUS_SUCCESSFUL_JOB' | 'UNAVAILABLE'
  range_fallback_reason: 'PREVIOUS_BASE_INVALID' | 'PREVIOUS_BASE_MISSING' | 'PREVIOUS_BASE_NOT_ANCESTOR' | null
  range_start_at: string
  range_end_at: string
  head_resolved_at: string
  ancestry_status: 'VERIFIED' | 'BASE_UNREACHABLE' | 'HEAD_MISSING' | 'UNKNOWN'
  enumeration_status: 'COMPLETE' | 'SHALLOW_INCOMPLETE' | 'RANGE_TOO_LARGE' | 'BASELINE_REQUIRED' | 'FAILED'
  commit_count: number
  commits: Array<Record<string, unknown>>
}

export interface CollectedRepositoryHistory {
  manifest: RepositoryHistoryManifestWire
  manifestHash: string
  canonicalManifest: CanonicalCommitManifest | null
  historyPath: string
  deepenCount: number
}

export interface GitIdentityLookupInput {
  inputId: string
  email: string
  provider?: 'git' | 'gitlab'
}

export interface GitIdentityLookupResult {
  input_id: string
  email_fingerprint: string
  masked_email: string
  match_status: Exclude<CommitIdentityMatchStatus, 'UNAVAILABLE'>
  developer_id: string | null
}

export type GitIdentityMatcher = (
  authors: readonly GitIdentityLookupInput[],
) => Promise<readonly GitIdentityLookupResult[]>

export interface CollectRepositoryHistoryInput {
  prepared: PreparedRepository
  cacheRoot: string
  branch: string
  headResolvedAt: string
  windowDays: number
  prepareOptions: PrepareOptions
  identityMatcher?: GitIdentityMatcher
  previousBaseSha?: string | null
  commitLimit?: number
  deepenStep?: number
  deepenLimit?: number
  remoteUrl?: string
}

interface RawCommitMetadata {
  topologyIndex: number
  sha: string
  parentShas: string[]
  treeSha: string
  authorName: string
  authorEmail: string
  authoredAt: string
  committerName: string
  committerEmail: string
  committedAt: string
  subject: string
  body: string
  trailers: Record<string, readonly string[]>
  isMerge: boolean
  isRevert: boolean
  revertedSha: string | null
  files: CommitManifestFile[]
}

interface ResolvedIdentity {
  status: CommitIdentityMatchStatus
  fingerprint: string | null
  maskedEmail: string | null
  developerId: string | null
}

const GIT_FORMAT_SEPARATOR = '%x00'
const PARSE_SEPARATOR = '\u0000'

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function parseTrailers(body: string): Record<string, readonly string[]> {
  const result: Record<string, string[]> = {}
  for (const line of body.split(/\r?\n/)) {
    const match = /^([A-Za-z][A-Za-z0-9-]{0,63}):\s*(.{1,1000})$/.exec(line)
    if (!match) continue
    const key = match[1]!
    ;(result[key] ??= []).push(match[2]!)
  }
  return result
}

function parseRevertedSha(subject: string, body: string): string | null {
  if (!/^revert\b/i.test(subject)) return null
  return /\b(?:reverts? commit|revert(?:ed)?)[ :]+([0-9a-f]{40})\b/i.exec(body)?.[1]?.toLowerCase() ?? null
}

function parseNumstat(output: string): CommitManifestFile[] {
  const files: CommitManifestFile[] = []
  for (const line of output.split(/\r?\n/)) {
    if (line.trim() === '') continue
    const [rawAdditions, rawDeletions, ...pathParts] = line.split('\t')
    const path = pathParts.join('\t')
    if (!rawAdditions || !rawDeletions || path === '') continue
    const binary = rawAdditions === '-' || rawDeletions === '-'
    files.push({
      path,
      oldPath: null,
      changeType: 'MODIFIED',
      additions: binary ? 0 : Number(rawAdditions),
      deletions: binary ? 0 : Number(rawDeletions),
      binary,
    })
  }
  return files
}

async function gitObjectExists(historyPath: string, sha: string): Promise<boolean> {
  try {
    await runCommand('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd: historyPath, timeoutMs: 30_000 })
    return true
  } catch {
    return false
  }
}

async function firstParent(historyPath: string, headSha: string): Promise<Array<{ sha: string; committedAt: string }>> {
  const { stdout } = await runCommand(
    'git',
    ['log', '--first-parent', `--format=%H${GIT_FORMAT_SEPARATOR}%cI`, headSha],
    { cwd: historyPath, timeoutMs: 60_000 },
  )
  return stdout.split(/\r?\n/).filter(Boolean).map((line) => {
    const [sha, committedAt] = line.split(PARSE_SEPARATOR)
    return { sha: sha!, committedAt: committedAt! }
  })
}

async function isAncestor(historyPath: string, baseSha: string, headSha: string): Promise<boolean> {
  try {
    await runCommand('git', [...ancestryCheckArgs(baseSha, headSha)], { cwd: historyPath, timeoutMs: 30_000 })
    return true
  } catch {
    return false
  }
}

type PreviousFallbackReason = RepositoryHistoryManifestWire['range_fallback_reason']

async function fetchHistory(
  input: CollectRepositoryHistoryInput,
  historyPath: string,
  rangeStart: string,
): Promise<{
  baseSha: string | null
  deepenCount: number
  usedPrevious: boolean
  previousFallbackReason: PreviousFallbackReason
}> {
  const auth = authArgs(input.prepareOptions)
  const timeoutMs = input.prepareOptions.timeoutMs ?? 180_000
  const remoteUrl = input.remoteUrl ?? getRepositoryUrl(input.prepared.repository, input.prepareOptions.gitlabBaseUrl)
  if (!existsSync(join(historyPath, 'HEAD'))) {
    mkdirSync(historyPath, { recursive: true })
    await runCommand('git', ['init', '--bare', historyPath], { timeoutMs })
    await runCommand('git', ['remote', 'add', 'origin', remoteUrl], { cwd: historyPath, timeoutMs })
  }
  if (!(await gitObjectExists(historyPath, input.prepared.commitSha))) {
    try {
      await runCommand('git', [...auth, 'fetch', '--depth', '1', 'origin', input.prepared.commitSha], { cwd: historyPath, timeoutMs })
    } catch {
      await runCommand('git', [...auth, 'fetch', '--depth', '1', 'origin', `refs/heads/${input.branch}`], { cwd: historyPath, timeoutMs })
    }
  }

  const step = input.deepenStep ?? 256
  const limit = input.deepenLimit ?? 5_000
  let deepenCount = 0
  let previousFallbackReason: PreviousFallbackReason = null
  const previous = input.previousBaseSha?.toLowerCase() ?? null
  if (previous !== null) {
    if (!/^[0-9a-f]{40}$/.test(previous)) {
      previousFallbackReason = 'PREVIOUS_BASE_INVALID'
    } else {
      let exactFetchFailed = false
      if (!(await gitObjectExists(historyPath, previous))) {
        try {
          // Every head has its own bare repository. Fetch the frozen previous
          // head explicitly instead of assuming another per-head cache owns it.
          await runCommand('git', [...auth, 'fetch', '--depth', '1', 'origin', previous], { cwd: historyPath, timeoutMs })
        } catch {
          exactFetchFailed = true
        }
      }
      while (true) {
        if (await gitObjectExists(historyPath, previous)
          && await isAncestor(historyPath, previous, input.prepared.commitSha)) {
          return {
            baseSha: previous,
            deepenCount,
            usedPrevious: true,
            previousFallbackReason: null,
          }
        }
        const shallowFile = join(historyPath, 'shallow')
        if (!existsSync(shallowFile)
          || readFileSync(shallowFile, 'utf8').trim() === ''
          || deepenCount >= limit) break
        const amount = Math.min(step, limit - deepenCount)
        try {
          await runCommand('git', [...auth, 'fetch', `--deepen=${amount}`, 'origin', `refs/heads/${input.branch}`], {
            cwd: historyPath,
            timeoutMs,
          })
        } catch {
          break
        }
        deepenCount += amount
      }
      previousFallbackReason = !(await gitObjectExists(historyPath, previous)) && exactFetchFailed
        ? 'PREVIOUS_BASE_MISSING'
        : 'PREVIOUS_BASE_NOT_ANCESTOR'
    }
  }

  // A missing or force-pushed previous baseline never becomes authoritative.
  // After recording the stable reason, derive the same deterministic time
  // baseline as before from whatever history has safely been fetched.
  while (true) {
    const commits = await firstParent(historyPath, input.prepared.commitSha)
    const baseSha = deriveTimeBasedBase(commits, rangeStart)
    if (baseSha !== null) {
      return { baseSha, deepenCount, usedPrevious: false, previousFallbackReason }
    }
    const shallowFile = join(historyPath, 'shallow')
    if (!existsSync(shallowFile) || readFileSync(shallowFile, 'utf8').trim() === '' || deepenCount >= limit) {
      return { baseSha: null, deepenCount, usedPrevious: false, previousFallbackReason }
    }
    const amount = Math.min(step, limit - deepenCount)
    await runCommand('git', [...auth, 'fetch', `--deepen=${amount}`, 'origin', `refs/heads/${input.branch}`], {
      cwd: historyPath,
      timeoutMs,
    })
    deepenCount += amount
  }
}

async function readCommit(historyPath: string, sha: string, topologyIndex: number): Promise<RawCommitMetadata> {
  const format = ['%H', '%P', '%T', '%an', '%ae', '%aI', '%cn', '%ce', '%cI', '%s', '%b'].join(GIT_FORMAT_SEPARATOR)
  const { stdout } = await runCommand('git', ['show', '-s', `--format=${format}`, sha], {
    cwd: historyPath,
    timeoutMs: 30_000,
  })
  const fields = stdout.replace(/\n$/, '').split(PARSE_SEPARATOR)
  if (fields.length < 11) throw new Error(`invalid local git metadata for ${sha}`)
  const [commitSha, parents, treeSha, authorName, authorEmail, authoredAt, committerName, committerEmail, committedAt, subject, ...bodyParts] = fields
  const body = bodyParts.join(PARSE_SEPARATOR)
  const { stdout: numstat } = await runCommand(
    'git',
    ['diff-tree', '--root', '--no-commit-id', '--numstat', '-r', '--no-renames', sha],
    { cwd: historyPath, timeoutMs: 30_000 },
  )
  const parentShas = parents ? parents.split(' ').filter(Boolean) : []
  const revertedSha = parseRevertedSha(subject!, body)
  return {
    topologyIndex,
    sha: commitSha!,
    parentShas,
    treeSha: treeSha!,
    authorName: authorName!,
    authorEmail: authorEmail!,
    authoredAt: authoredAt!,
    committerName: committerName!,
    committerEmail: committerEmail!,
    committedAt: committedAt!,
    subject: subject!,
    body,
    trailers: parseTrailers(body),
    isMerge: parentShas.length > 1,
    isRevert: revertedSha !== null,
    revertedSha,
    files: parseNumstat(numstat),
  }
}

function unavailableIdentity(): ResolvedIdentity {
  return { status: 'UNAVAILABLE', fingerprint: null, maskedEmail: null, developerId: null }
}

async function matchCommitIdentities(
  commits: readonly RawCommitMetadata[],
  matcher: GitIdentityMatcher | undefined,
): Promise<Map<string, ResolvedIdentity>> {
  const requests = commits.flatMap((commit) => [
    { inputId: `${commit.sha}:author`, provider: 'gitlab' as const, email: commit.authorEmail },
    { inputId: `${commit.sha}:committer`, provider: 'gitlab' as const, email: commit.committerEmail },
  ])
  if (requests.length === 0 || matcher === undefined) return new Map()
  try {
    const response = await matcher(requests)
    const resolved = new Map<string, ResolvedIdentity>()
    for (const result of response) {
      if (
        !requests.some((request) => request.inputId === result.input_id)
        || !/^[0-9a-f]{64}$/.test(result.email_fingerprint)
        || !['MATCHED', 'UNMATCHED', 'CONFLICT'].includes(result.match_status)
      ) continue
      resolved.set(result.input_id, {
        status: result.match_status,
        fingerprint: result.email_fingerprint,
        maskedEmail: result.masked_email,
        developerId: result.match_status === 'MATCHED' ? result.developer_id : null,
      })
    }
    return resolved
  } catch {
    // Identity enrichment is auxiliary. In particular IDENTITY_PEPPER_MISSING must never
    // be replaced with a job-local HMAC that looks MATCHED. Callers receive UNAVAILABLE.
    return new Map()
  }
}

function materializeCommit(
  raw: RawCommitMetadata,
  identities: ReadonlyMap<string, ResolvedIdentity>,
): { canonical: CommitManifestEntry; wire: Record<string, unknown> } {
  const author = identities.get(`${raw.sha}:author`) ?? unavailableIdentity()
  const committer = identities.get(`${raw.sha}:committer`) ?? unavailableIdentity()
  const canonical: CommitManifestEntry = {
    topologyIndex: raw.topologyIndex,
    sha: raw.sha,
    parentShas: raw.parentShas,
    treeSha: raw.treeSha,
    authorName: raw.authorName,
    authorEmailFingerprint: author.fingerprint,
    authorIdentityStatus: author.status,
    authoredAt: raw.authoredAt,
    committerName: raw.committerName,
    committerEmailFingerprint: committer.fingerprint,
    committerIdentityStatus: committer.status,
    committedAt: raw.committedAt,
    subject: raw.subject,
    body: raw.body,
    trailers: raw.trailers,
    isMerge: raw.isMerge,
    isRevert: raw.isRevert,
    revertedSha: raw.revertedSha,
    patchId: null,
    effectiveStatus: 'UNKNOWN',
    files: raw.files,
  }
  const structuredStoryIds = Object.entries(raw.trailers)
    .filter(([key]) => key.toLowerCase() === 'story-id')
    .flatMap(([, values]) => values)
  return {
    canonical,
    wire: {
      sha: canonical.sha,
      sequence_no: raw.topologyIndex,
      parent_shas: canonical.parentShas,
      tree_sha: canonical.treeSha,
      author_name: canonical.authorName,
      author_email_fingerprint: canonical.authorEmailFingerprint,
      author_email_masked: author.maskedEmail,
      author_identity_status: author.status,
      author_developer_id: author.developerId,
      authored_at: canonical.authoredAt,
      committer_name: canonical.committerName,
      committer_email_fingerprint: canonical.committerEmailFingerprint,
      committer_email_masked: committer.maskedEmail,
      committer_identity_status: committer.status,
      committer_developer_id: committer.developerId,
      committed_at: canonical.committedAt,
      subject: canonical.subject,
      message_body: canonical.body,
      trailers: canonical.trailers,
      structured_story_ids: structuredStoryIds,
      coauthor_email_fingerprints: [],
      is_merge: canonical.isMerge,
      is_revert: canonical.isRevert,
      reverted_sha: canonical.revertedSha,
      patch_id: canonical.patchId,
      files_changed: raw.files.length,
      additions: raw.files.reduce((sum, file) => sum + file.additions, 0),
      deletions: raw.files.reduce((sum, file) => sum + file.deletions, 0),
      binary_files: raw.files.filter((file) => file.binary).length,
      effective_status: canonical.effectiveStatus,
      files: raw.files.map((file, fileOrder) => ({
        file_order: fileOrder,
        path: file.path,
        old_path: file.oldPath,
        change_type: file.changeType,
        additions: file.additions,
        deletions: file.deletions,
        binary: file.binary,
      })),
    },
  }
}

function databaseStatus(status: HistoryEnumerationStatus): RepositoryHistoryManifestWire['enumeration_status'] {
  if (status === 'COMPLETE' || status === 'RANGE_TOO_LARGE' || status === 'BASELINE_REQUIRED' || status === 'SHALLOW_INCOMPLETE') return status
  return 'FAILED'
}

export async function collectRepositoryHistory(input: CollectRepositoryHistoryInput): Promise<CollectedRepositoryHistory> {
  if (!Number.isInteger(input.windowDays) || input.windowDays < 1) throw new Error('windowDays must be positive')
  const endMs = Date.parse(input.headResolvedAt)
  if (!Number.isFinite(endMs)) throw new Error('headResolvedAt must be an ISO timestamp')
  const rangeEnd = new Date(endMs).toISOString()
  const rangeStart = new Date(endMs - input.windowDays * 86_400_000).toISOString()
  const historyPath = join(input.cacheRoot, input.prepared.repository, '.v111-history', input.prepared.commitSha)
  const fetched = await fetchHistory(input, historyPath, rangeStart)
  let ancestorVerified = false
  let revListOutput = ''
  if (fetched.baseSha !== null) {
    try {
      await runCommand('git', [...ancestryCheckArgs(fetched.baseSha, input.prepared.commitSha)], { cwd: historyPath, timeoutMs: 30_000 })
      ancestorVerified = true
      revListOutput = (await runCommand('git', [...historyEnumerationArgs(fetched.baseSha, input.prepared.commitSha)], { cwd: historyPath, timeoutMs: 60_000 })).stdout
    } catch (error) {
      if (!(error instanceof SpawnError)) throw error
    }
  }
  const shallowBoundaryShas = existsSync(join(historyPath, 'shallow'))
    ? readFileSync(join(historyPath, 'shallow'), 'utf8').split(/\r?\n/).filter(Boolean)
    : []
  const range = evaluateHistoryRange({
    baseSha: fetched.baseSha,
    headSha: input.prepared.commitSha,
    ancestorVerified,
    revListOutput,
    shallowBoundaryShas,
    repositoryCommitLimit: input.commitLimit,
  })

  const canonicalEntries: CommitManifestEntry[] = []
  const wireEntries: Array<Record<string, unknown>> = []
  if (range.status === 'COMPLETE') {
    const rawEntries: RawCommitMetadata[] = []
    for (const [index, sha] of range.commitShas.entries()) rawEntries.push(await readCommit(historyPath, sha, index))
    const identities = await matchCommitIdentities(rawEntries, input.identityMatcher)
    for (const raw of rawEntries) {
      const entry = materializeCommit(raw, identities)
      canonicalEntries.push(entry.canonical)
      wireEntries.push(entry.wire)
    }
  }
  const canonicalManifest = range.status === 'COMPLETE'
    ? canonicalizeCommitManifest({
        schemaVersion: 1,
        repository: input.prepared.repository,
        baseSha: range.baseSha,
        headSha: range.headSha,
        enumerationStatus: 'COMPLETE',
        commits: canonicalEntries,
      })
    : null
  const enumerationStatus = databaseStatus(range.status)
  const wire: RepositoryHistoryManifestWire = {
    schema_version: 1,
    repository: input.prepared.repository,
    base_sha: range.baseSha,
    head_sha: input.prepared.commitSha,
    head_subject: input.prepared.commitSubject || null,
    range_source: fetched.usedPrevious ? 'PREVIOUS_SUCCESSFUL_JOB' : fetched.baseSha ? 'TIME_DERIVED' : 'UNAVAILABLE',
    range_fallback_reason: fetched.previousFallbackReason,
    range_start_at: rangeStart,
    range_end_at: rangeEnd,
    head_resolved_at: rangeEnd,
    ancestry_status: ancestorVerified ? 'VERIFIED' : fetched.baseSha ? 'BASE_UNREACHABLE' : 'UNKNOWN',
    enumeration_status: enumerationStatus,
    commit_count: wireEntries.length,
    commits: wireEntries,
  }
  const manifestHash = canonicalManifest?.manifestHash
    ?? `sha256:${sha256(`incomplete-story-history-v1\n${JSON.stringify(wire)}\n`)}`
  return { manifest: wire, manifestHash, canonicalManifest, historyPath, deepenCount: fetched.deepenCount }
}
