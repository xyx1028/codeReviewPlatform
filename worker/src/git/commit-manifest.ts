import { createHash } from 'node:crypto'
import { assertFullCommitSha, type HistoryEnumerationStatus } from './history-range.js'

export type CommitEffectiveStatus = 'EFFECTIVE' | 'REVERTED' | 'PARTIAL' | 'UNKNOWN'
export type CommitFileChangeType = 'ADDED' | 'MODIFIED' | 'DELETED' | 'RENAMED' | 'COPIED' | 'TYPE_CHANGED'

export interface CommitManifestFile {
  path: string
  oldPath: string | null
  changeType: CommitFileChangeType
  additions: number
  deletions: number
  binary: boolean
}

export type CommitIdentityMatchStatus = 'MATCHED' | 'UNMATCHED' | 'CONFLICT' | 'UNAVAILABLE'

export interface CommitManifestEntry {
  topologyIndex: number
  sha: string
  parentShas: readonly string[]
  treeSha: string
  authorName: string
  authorEmailFingerprint: string | null
  authorIdentityStatus: CommitIdentityMatchStatus
  authoredAt: string
  committerName: string
  committerEmailFingerprint: string | null
  committerIdentityStatus: CommitIdentityMatchStatus
  committedAt: string
  subject: string
  body: string
  trailers: Readonly<Record<string, readonly string[]>>
  isMerge: boolean
  isRevert: boolean
  revertedSha: string | null
  patchId: string | null
  effectiveStatus: CommitEffectiveStatus
  files: readonly CommitManifestFile[]
}

export interface CommitManifestInput {
  schemaVersion: 1
  repository: string
  baseSha: string
  headSha: string
  enumerationStatus: HistoryEnumerationStatus
  commits: readonly CommitManifestEntry[]
}

export interface CanonicalCommitManifest extends Omit<CommitManifestInput, 'enumerationStatus' | 'commits'> {
  enumerationStatus: 'COMPLETE'
  commits: readonly CommitManifestEntry[]
  commitCount: number
  manifestHash: string
}

export class CommitManifestError extends Error {
  readonly code: 'COMMIT_MANIFEST_INVALID' | 'COMMIT_MANIFEST_INCOMPLETE'

  constructor(code: 'COMMIT_MANIFEST_INVALID' | 'COMMIT_MANIFEST_INCOMPLETE', message: string) {
    super(message)
    this.name = 'CommitManifestError'
    this.code = code
  }
}

const REPOSITORY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const FINGERPRINT_PATTERN = /^(?:sha256:)?[0-9a-f]{64}$/
const PATCH_ID_PATTERN = /^[0-9a-f]{40,64}$/
const SAFE_PATH_PATTERN = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\\)(?!.*\0).{1,1024}$/
const MAX_BODY_CHARS = 20_000

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function assertInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new CommitManifestError('COMMIT_MANIFEST_INVALID', `${label} must be a non-negative integer`)
}

function assertTimestamp(value: string, label: string): void {
  if (!Number.isFinite(Date.parse(value))) throw new CommitManifestError('COMMIT_MANIFEST_INVALID', `${label} must be an ISO timestamp`)
}

function canonicalFile(file: CommitManifestFile): CommitManifestFile {
  if (!SAFE_PATH_PATTERN.test(file.path)) throw new CommitManifestError('COMMIT_MANIFEST_INVALID', `unsafe file path ${file.path}`)
  if (file.oldPath !== null && !SAFE_PATH_PATTERN.test(file.oldPath)) throw new CommitManifestError('COMMIT_MANIFEST_INVALID', `unsafe old path ${file.oldPath}`)
  if (!['ADDED', 'MODIFIED', 'DELETED', 'RENAMED', 'COPIED', 'TYPE_CHANGED'].includes(file.changeType)) throw new CommitManifestError('COMMIT_MANIFEST_INVALID', `invalid change type ${file.changeType}`)
  assertInteger(file.additions, 'file additions')
  assertInteger(file.deletions, 'file deletions')
  if (typeof file.binary !== 'boolean') throw new CommitManifestError('COMMIT_MANIFEST_INVALID', 'file binary must be boolean')
  return {
    path: file.path,
    oldPath: file.oldPath,
    changeType: file.changeType,
    additions: file.additions,
    deletions: file.deletions,
    binary: file.binary,
  }
}

function canonicalTrailers(trailers: Readonly<Record<string, readonly string[]>>): Record<string, readonly string[]> {
  const result: Record<string, readonly string[]> = {}
  for (const key of Object.keys(trailers).sort(compareText)) {
    if (!/^[A-Za-z][A-Za-z0-9-]{0,63}$/.test(key)) throw new CommitManifestError('COMMIT_MANIFEST_INVALID', `invalid trailer key ${key}`)
    const values = trailers[key]
    if (!Array.isArray(values) || values.some((value) => typeof value !== 'string' || value.length > 1_000)) {
      throw new CommitManifestError('COMMIT_MANIFEST_INVALID', `invalid trailer values for ${key}`)
    }
    result[key] = [...values].sort(compareText)
  }
  return result
}

function canonicalEntry(entry: CommitManifestEntry): CommitManifestEntry {
  assertInteger(entry.topologyIndex, 'topologyIndex')
  assertFullCommitSha(entry.sha)
  entry.parentShas.forEach((sha) => assertFullCommitSha(sha, 'parent sha'))
  assertFullCommitSha(entry.treeSha, 'tree sha')
  if (
    (entry.authorEmailFingerprint !== null && !FINGERPRINT_PATTERN.test(entry.authorEmailFingerprint))
    || (entry.committerEmailFingerprint !== null && !FINGERPRINT_PATTERN.test(entry.committerEmailFingerprint))
  ) {
    throw new CommitManifestError('COMMIT_MANIFEST_INVALID', 'email fingerprints must be null or SHA-256 values')
  }
  const identityStatuses: readonly CommitIdentityMatchStatus[] = ['MATCHED', 'UNMATCHED', 'CONFLICT', 'UNAVAILABLE']
  if (!identityStatuses.includes(entry.authorIdentityStatus) || !identityStatuses.includes(entry.committerIdentityStatus)) {
    throw new CommitManifestError('COMMIT_MANIFEST_INVALID', 'identity match status is invalid')
  }
  if (
    (entry.authorIdentityStatus === 'UNAVAILABLE') !== (entry.authorEmailFingerprint === null)
    || (entry.committerIdentityStatus === 'UNAVAILABLE') !== (entry.committerEmailFingerprint === null)
  ) {
    throw new CommitManifestError('COMMIT_MANIFEST_INVALID', 'unavailable identities must not contain a fingerprint')
  }
  assertTimestamp(entry.authoredAt, 'authoredAt')
  assertTimestamp(entry.committedAt, 'committedAt')
  if (entry.subject.length > 1_000 || [...entry.body].length > MAX_BODY_CHARS) throw new CommitManifestError('COMMIT_MANIFEST_INVALID', 'commit message exceeds limits')
  if (entry.revertedSha !== null) assertFullCommitSha(entry.revertedSha, 'reverted sha')
  if (entry.patchId !== null && !PATCH_ID_PATTERN.test(entry.patchId)) throw new CommitManifestError('COMMIT_MANIFEST_INVALID', 'patchId is invalid')
  if (entry.isMerge !== (entry.parentShas.length > 1)) throw new CommitManifestError('COMMIT_MANIFEST_INVALID', 'isMerge disagrees with parent count')
  const files = entry.files.map(canonicalFile).sort((left, right) => compareText(left.path, right.path) || compareText(left.oldPath ?? '', right.oldPath ?? ''))
  return {
    topologyIndex: entry.topologyIndex,
    sha: entry.sha,
    parentShas: [...entry.parentShas],
    treeSha: entry.treeSha,
    authorName: entry.authorName,
    authorEmailFingerprint: entry.authorEmailFingerprint,
    authorIdentityStatus: entry.authorIdentityStatus,
    authoredAt: new Date(entry.authoredAt).toISOString(),
    committerName: entry.committerName,
    committerEmailFingerprint: entry.committerEmailFingerprint,
    committerIdentityStatus: entry.committerIdentityStatus,
    committedAt: new Date(entry.committedAt).toISOString(),
    subject: entry.subject,
    body: entry.body,
    trailers: canonicalTrailers(entry.trailers),
    isMerge: entry.isMerge,
    isRevert: entry.isRevert,
    revertedSha: entry.revertedSha,
    patchId: entry.patchId,
    effectiveStatus: entry.effectiveStatus,
    files,
  }
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  return `{${Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([left], [right]) => compareText(left, right)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`
}

export function canonicalizeCommitManifest(input: CommitManifestInput): CanonicalCommitManifest {
  if (input.enumerationStatus !== 'COMPLETE') {
    throw new CommitManifestError('COMMIT_MANIFEST_INCOMPLETE', `cannot freeze manifest with ${input.enumerationStatus} history`)
  }
  if (!REPOSITORY_PATTERN.test(input.repository)) throw new CommitManifestError('COMMIT_MANIFEST_INVALID', 'repository is invalid')
  assertFullCommitSha(input.baseSha, 'baseSha')
  assertFullCommitSha(input.headSha, 'headSha')
  const commits = input.commits.map(canonicalEntry).sort((left, right) => left.topologyIndex - right.topologyIndex || compareText(left.sha, right.sha))
  const shas = new Set<string>()
  const indexes = new Set<number>()
  for (const commit of commits) {
    if (shas.has(commit.sha)) throw new CommitManifestError('COMMIT_MANIFEST_INVALID', `duplicate commit ${commit.sha}`)
    if (indexes.has(commit.topologyIndex)) throw new CommitManifestError('COMMIT_MANIFEST_INVALID', `duplicate topologyIndex ${commit.topologyIndex}`)
    shas.add(commit.sha)
    indexes.add(commit.topologyIndex)
  }
  const identity = {
    schemaVersion: 1 as const,
    repository: input.repository,
    baseSha: input.baseSha,
    headSha: input.headSha,
    enumerationStatus: 'COMPLETE' as const,
    commits,
    commitCount: commits.length,
  }
  const hash = createHash('sha256').update(`commit-manifest-v1\n${stableJson(identity)}\n`, 'utf8').digest('hex')
  return { ...identity, manifestHash: `sha256:${hash}` }
}

export function sortRepositoryManifests(manifests: readonly CanonicalCommitManifest[]): CanonicalCommitManifest[] {
  return [...manifests].sort((left, right) => compareText(left.repository, right.repository))
}

export function computeRepositoryCatalogHash(manifests: readonly CanonicalCommitManifest[]): string {
  const lines = sortRepositoryManifests(manifests).map((manifest) => `${manifest.repository}\t${manifest.baseSha}\t${manifest.headSha}\t${manifest.manifestHash}`)
  return `sha256:${createHash('sha256').update(`repository-commit-catalog-v1\n${lines.join('\n')}\n`, 'utf8').digest('hex')}`
}
