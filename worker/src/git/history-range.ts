export const FULL_COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/
export const DEFAULT_REPOSITORY_COMMIT_LIMIT = 2_000
export const DEFAULT_HISTORY_DEEPEN_LIMIT = 5_000

export type HistoryEnumerationStatus =
  | 'COMPLETE'
  | 'SHALLOW_INCOMPLETE'
  | 'RANGE_TOO_LARGE'
  | 'BASE_UNREACHABLE'
  | 'BASELINE_REQUIRED'
  | 'OBJECT_MISSING'
  | 'INVALID_HISTORY'

export interface FirstParentCommit {
  sha: string
  committedAt: string
}

export interface HistoryRangeInput {
  baseSha: string | null
  headSha: string
  ancestorVerified: boolean
  revListOutput: string
  shallowBoundaryShas?: readonly string[]
  missingObjectShas?: readonly string[]
  repositoryCommitLimit?: number
}

export interface CompleteHistoryRange {
  status: 'COMPLETE'
  baseSha: string
  headSha: string
  commitShas: readonly string[]
  commitCount: number
}

export interface IncompleteHistoryRange {
  status: Exclude<HistoryEnumerationStatus, 'COMPLETE'>
  baseSha: string | null
  headSha: string
  observedCommitShas: readonly string[]
  commitCount: number
  reasonCode: Exclude<HistoryEnumerationStatus, 'COMPLETE'>
}

export type HistoryRangeResult = CompleteHistoryRange | IncompleteHistoryRange

export class HistoryRangeError extends Error {
  readonly code: 'INVALID_HISTORY_INPUT'

  constructor(message: string) {
    super(message)
    this.name = 'HistoryRangeError'
    this.code = 'INVALID_HISTORY_INPUT'
  }
}

export function assertFullCommitSha(value: string, label = 'sha'): string {
  if (!FULL_COMMIT_SHA_PATTERN.test(value)) throw new HistoryRangeError(`${label} must be a lowercase 40-hex SHA`)
  return value
}

export function parseRevList(output: string): string[] {
  const commits: string[] = []
  const seen = new Set<string>()
  for (const raw of output.split(/\r?\n/)) {
    const sha = raw.trim()
    if (sha.length === 0) continue
    assertFullCommitSha(sha, 'rev-list entry')
    if (seen.has(sha)) throw new HistoryRangeError(`duplicate rev-list entry ${sha}`)
    seen.add(sha)
    commits.push(sha)
  }
  return commits
}

function incomplete(status: Exclude<HistoryEnumerationStatus, 'COMPLETE'>, input: HistoryRangeInput, commits: readonly string[]): IncompleteHistoryRange {
  return {
    status,
    baseSha: input.baseSha,
    headSha: input.headSha,
    observedCommitShas: commits,
    commitCount: commits.length,
    reasonCode: status,
  }
}

export function evaluateHistoryRange(input: HistoryRangeInput): HistoryRangeResult {
  assertFullCommitSha(input.headSha, 'headSha')
  if (input.baseSha === null) return incomplete('BASELINE_REQUIRED', input, [])
  assertFullCommitSha(input.baseSha, 'baseSha')
  let commits: string[]
  try {
    commits = parseRevList(input.revListOutput)
  } catch (error) {
    if (error instanceof HistoryRangeError) return incomplete('INVALID_HISTORY', input, [])
    throw error
  }
  if (!input.ancestorVerified) return incomplete('BASE_UNREACHABLE', input, commits)
  const missing = input.missingObjectShas ?? []
  if (missing.length > 0) {
    missing.forEach((sha) => assertFullCommitSha(sha, 'missing object sha'))
    return incomplete('OBJECT_MISSING', input, commits)
  }
  const commitSet = new Set(commits)
  const shallow = input.shallowBoundaryShas ?? []
  shallow.forEach((sha) => assertFullCommitSha(sha, 'shallow boundary sha'))
  if (shallow.some((sha) => commitSet.has(sha))) return incomplete('SHALLOW_INCOMPLETE', input, commits)
  const limit = input.repositoryCommitLimit ?? DEFAULT_REPOSITORY_COMMIT_LIMIT
  if (!Number.isSafeInteger(limit) || limit < 1) throw new HistoryRangeError('repositoryCommitLimit must be positive')
  if (commits.length > limit) return incomplete('RANGE_TOO_LARGE', input, commits)
  return {
    status: 'COMPLETE',
    baseSha: input.baseSha,
    headSha: input.headSha,
    commitShas: commits,
    commitCount: commits.length,
  }
}

/**
 * Select the nearest first-parent ancestor strictly before rangeStart.
 * Commits exactly at rangeStart remain inside the half-open analysis window.
 */
export function deriveTimeBasedBase(firstParentNewestFirst: readonly FirstParentCommit[], rangeStart: string): string | null {
  const startMs = Date.parse(rangeStart)
  if (!Number.isFinite(startMs)) throw new HistoryRangeError('rangeStart must be an ISO timestamp')
  for (const commit of firstParentNewestFirst) {
    assertFullCommitSha(commit.sha)
    const committedMs = Date.parse(commit.committedAt)
    if (!Number.isFinite(committedMs)) throw new HistoryRangeError(`invalid committedAt for ${commit.sha}`)
    if (committedMs < startMs) return commit.sha
  }
  return null
}

/** Pure command specification: callers may execute it only against an already-frozen local Git object store. */
export function historyEnumerationArgs(baseSha: string, headSha: string): readonly string[] {
  assertFullCommitSha(baseSha, 'baseSha')
  assertFullCommitSha(headSha, 'headSha')
  return ['rev-list', '--topo-order', '--reverse', `${baseSha}..${headSha}`]
}

export function ancestryCheckArgs(baseSha: string, headSha: string): readonly string[] {
  assertFullCommitSha(baseSha, 'baseSha')
  assertFullCommitSha(headSha, 'headSha')
  return ['merge-base', '--is-ancestor', baseSha, headSha]
}
