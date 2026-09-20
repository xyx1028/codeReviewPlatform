import { describe, expect, it } from 'vitest'
import {
  HistoryRangeError,
  deriveTimeBasedBase,
  evaluateHistoryRange,
  historyEnumerationArgs,
  parseRevList,
} from '../git/history-range.js'
import {
  CommitManifestError,
  canonicalizeCommitManifest,
  computeRepositoryCatalogHash,
  type CommitManifestEntry,
} from '../git/commit-manifest.js'

const BASE = 'a'.repeat(40)
const HEAD = 'b'.repeat(40)
const C1 = 'c'.repeat(40)
const C2 = 'd'.repeat(40)
const TREE = 'e'.repeat(40)
const FP = 'f'.repeat(64)

function entry(overrides: Partial<CommitManifestEntry> = {}): CommitManifestEntry {
  return {
    topologyIndex: 0,
    sha: C1,
    parentShas: [BASE],
    treeSha: TREE,
    authorName: 'Alice',
    authorEmailFingerprint: FP,
    authorIdentityStatus: 'MATCHED',
    authoredAt: '2026-09-01T00:00:00+08:00',
    committerName: 'Alice',
    committerEmailFingerprint: FP,
    committerIdentityStatus: 'MATCHED',
    committedAt: '2026-09-01T01:00:00+08:00',
    subject: 'Story-Id: REQ-001',
    body: '',
    trailers: { 'Story-Id': ['REQ-001'] },
    isMerge: false,
    isRevert: false,
    revertedSha: null,
    patchId: null,
    effectiveStatus: 'EFFECTIVE',
    files: [{ path: 'src/b.ts', oldPath: null, changeType: 'MODIFIED', additions: 2, deletions: 1, binary: false }],
    ...overrides,
  }
}

describe('V1.11 pure Git history range', () => {
  it('preserves reverse topological rev-list order and rejects duplicate/invalid SHAs', () => {
    expect(parseRevList(`${C1}\n${C2}\n`)).toEqual([C1, C2])
    expect(() => parseRevList(`${C1}\n${C1}\n`)).toThrow(HistoryRangeError)
    expect(() => parseRevList('not-a-sha')).toThrow(HistoryRangeError)
    expect(historyEnumerationArgs(BASE, HEAD)).toEqual(['rev-list', '--topo-order', '--reverse', `${BASE}..${HEAD}`])
  })

  it('only calls a range complete when base ancestry and shallow boundaries are safe', () => {
    expect(evaluateHistoryRange({ baseSha: BASE, headSha: HEAD, ancestorVerified: true, revListOutput: `${C1}\n${C2}\n` })).toMatchObject({
      status: 'COMPLETE',
      commitShas: [C1, C2],
      commitCount: 2,
    })
    expect(evaluateHistoryRange({ baseSha: BASE, headSha: HEAD, ancestorVerified: false, revListOutput: C1 })).toMatchObject({ status: 'BASE_UNREACHABLE' })
    expect(evaluateHistoryRange({ baseSha: BASE, headSha: HEAD, ancestorVerified: true, revListOutput: C1, shallowBoundaryShas: [C1] })).toMatchObject({ status: 'SHALLOW_INCOMPLETE' })
    expect(evaluateHistoryRange({ baseSha: null, headSha: HEAD, ancestorVerified: false, revListOutput: '' })).toMatchObject({ status: 'BASELINE_REQUIRED' })
  })

  it('reports over-limit and missing-object histories instead of truncating them', () => {
    expect(evaluateHistoryRange({ baseSha: BASE, headSha: HEAD, ancestorVerified: true, revListOutput: `${C1}\n${C2}`, repositoryCommitLimit: 1 })).toMatchObject({ status: 'RANGE_TOO_LARGE', commitCount: 2 })
    expect(evaluateHistoryRange({ baseSha: BASE, headSha: HEAD, ancestorVerified: true, revListOutput: C1, missingObjectShas: [C2] })).toMatchObject({ status: 'OBJECT_MISSING' })
  })

  it('uses a strict-before comparison for the half-open window base', () => {
    expect(deriveTimeBasedBase([
      { sha: HEAD, committedAt: '2026-09-19T00:00:01Z' },
      { sha: C2, committedAt: '2026-09-01T00:00:00Z' },
      { sha: C1, committedAt: '2026-08-31T23:59:59Z' },
    ], '2026-09-01T00:00:00Z')).toBe(C1)
  })
})

describe('V1.11 canonical commit manifest', () => {
  it('sorts commits/files/trailers and computes a stable content hash', () => {
    const firstEntry = entry({
      files: [
        { path: 'src/z.ts', oldPath: null, changeType: 'ADDED', additions: 1, deletions: 0, binary: false },
        { path: 'src/a.ts', oldPath: null, changeType: 'MODIFIED', additions: 2, deletions: 1, binary: false },
      ],
      trailers: { Zed: ['b', 'a'], 'Story-Id': ['REQ-001'] },
    })
    const secondEntry = entry({ topologyIndex: 1, sha: C2, parentShas: [C1], committedAt: '2026-09-02T00:00:00Z' })
    const one = canonicalizeCommitManifest({ schemaVersion: 1, repository: 'demo-backend', baseSha: BASE, headSha: HEAD, enumerationStatus: 'COMPLETE', commits: [secondEntry, firstEntry] })
    const two = canonicalizeCommitManifest({ schemaVersion: 1, repository: 'demo-backend', baseSha: BASE, headSha: HEAD, enumerationStatus: 'COMPLETE', commits: [firstEntry, secondEntry] })
    expect(one.commits.map((commit) => commit.sha)).toEqual([C1, C2])
    expect(one.commits[0]!.files.map((file) => file.path)).toEqual(['src/a.ts', 'src/z.ts'])
    expect(one.commits[0]!.trailers.Zed).toEqual(['a', 'b'])
    expect(one.manifestHash).toBe(two.manifestHash)
    expect(one.manifestHash).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it('refuses to freeze an incomplete range or inconsistent merge metadata', () => {
    expect(() => canonicalizeCommitManifest({ schemaVersion: 1, repository: 'demo-backend', baseSha: BASE, headSha: HEAD, enumerationStatus: 'SHALLOW_INCOMPLETE', commits: [] })).toThrow(CommitManifestError)
    expect(() => canonicalizeCommitManifest({ schemaVersion: 1, repository: 'demo-backend', baseSha: BASE, headSha: HEAD, enumerationStatus: 'COMPLETE', commits: [entry({ isMerge: true })] })).toThrow(/isMerge disagrees/)
  })

  it('computes repository catalog hash independent of repository enumeration order', () => {
    const backend = canonicalizeCommitManifest({ schemaVersion: 1, repository: 'b-backend', baseSha: BASE, headSha: HEAD, enumerationStatus: 'COMPLETE', commits: [entry()] })
    const frontend = canonicalizeCommitManifest({ schemaVersion: 1, repository: 'a-frontend', baseSha: BASE, headSha: HEAD, enumerationStatus: 'COMPLETE', commits: [entry()] })
    expect(computeRepositoryCatalogHash([backend, frontend])).toBe(computeRepositoryCatalogHash([frontend, backend]))
  })
})
