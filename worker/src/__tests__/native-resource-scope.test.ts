import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { StoryAnalysisScopeCandidate } from '../db/jobs.js'
import {
  evaluateNativeResourceScope,
  normalizeNativeResourcePath,
} from '../ai/control/native-resource-scope.js'

const REPOSITORIES = [
  'kdmanage-backend',
  'kdmanage-frontend',
  'tmanage-backend',
  'tmanage-frontend',
] as const

function candidate(
  repository: (typeof REPOSITORIES)[number],
  tier: StoryAnalysisScopeCandidate['tier'],
  selected: boolean,
  files: string[],
): StoryAnalysisScopeCandidate {
  return {
    candidate_id: `${repository}-${tier}`,
    tier,
    rank_score: 900,
    reason_codes: [],
    repository,
    files: files.map((path) => ({ path, old_path: null })),
    short_sha: 'abcdef123456',
    subject: 'fixture',
    author_name: 'Fixture',
    author_email_masked: null,
    committed_at: '2026-09-19T00:00:00.000Z',
    files_changed: files.length,
    additions: 1,
    deletions: 0,
    effective_status: 'EFFECTIVE',
    diff_status: 'AVAILABLE',
    triage_verdict: null,
    selected,
    selection_level: selected ? 'PRIMARY' : null,
  }
}

describe('Harness native resource scope decision', () => {
  let root = ''
  let workspaceDir = ''
  let reposDir = ''
  let selectedPath = ''
  let outsidePath = ''
  let artifactPath = ''
  const candidates = [
    candidate('kdmanage-backend', 'STRONG', true, ['src/selected.ts']),
    candidate('tmanage-backend', 'AI_CANDIDATE', false, ['src/related.ts']),
  ]

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'native-scope-'))
    workspaceDir = join(root, 'workspace')
    reposDir = join(workspaceDir, 'repos')
    mkdirSync(join(workspaceDir, 'artifacts'), { recursive: true })
    for (const repository of REPOSITORIES) mkdirSync(join(reposDir, repository, 'src'), { recursive: true })
    selectedPath = join(reposDir, 'kdmanage-backend', 'src', 'selected.ts')
    outsidePath = join(reposDir, 'tmanage-backend', 'src', 'related.ts')
    artifactPath = join(workspaceDir, 'artifacts', 'result.txt')
    writeFileSync(selectedPath, 'selected')
    mkdirSync(join(reposDir, 'kdmanage-backend', '%73rc'), { recursive: true })
    writeFileSync(join(reposDir, 'kdmanage-backend', '%73rc', 'selected.ts'), 'unselected encoded literal')
    writeFileSync(join(reposDir, 'kdmanage-backend', 'src', 'other.ts'), 'other')
    writeFileSync(outsidePath, 'related')
    writeFileSync(join(reposDir, 'kdmanage-frontend', 'src', 'outside.ts'), 'outside')
    writeFileSync(artifactPath, 'artifact')
    symlinkSync(outsidePath, join(workspaceDir, 'artifacts', 'repo-link.ts'))
  })

  afterEach(() => rmSync(root, { recursive: true, force: true }))

  const decide = (
    toolName: string,
    args: unknown,
    scopeLevel: 'PRIMARY' | 'RELATED' | 'GLOBAL' = 'PRIMARY',
  ) => evaluateNativeResourceScope({
    toolName,
    args,
    scopeLevel,
    triageComplete: false,
    workspaceDir,
    reposDir,
    repositories: REPOSITORIES,
    candidates,
  })

  it('preserves the exact Harness path spelling instead of decoding or stripping wrappers', () => {
    expect(normalizeNativeResourcePath('repos/kdmanage-backend/%73rc/selected.ts'))
      .toBe('repos/kdmanage-backend/%73rc/selected.ts')
    expect(normalizeNativeResourcePath("'repos/kdmanage-backend/src/selected.ts'"))
      .toBe("'repos/kdmanage-backend/src/selected.ts'")
    expect(normalizeNativeResourcePath('%E0%A4%A')).toBe('%E0%A4%A')
    expect(normalizeNativeResourcePath('')).toBeNull()
  })

  it('allows only DB-selected PRIMARY files across relative, absolute and traversal forms', () => {
    for (const file_path of [
      'repos/kdmanage-backend/src/selected.ts',
      selectedPath,
      'artifacts/../repos/kdmanage-backend/src/selected.ts',
    ]) {
      expect(decide('read', { file_path })).toEqual({ allowed: true })
    }
    expect(decide('read', { file_path: 'repos/kdmanage-backend/%73rc/selected.ts' }))
      .toMatchObject({ allowed: false, code: 'SNAPSHOT_SCOPE_DENIED' })
    expect(decide('read_image', { file_path: 'repos/kdmanage-backend/src/other.ts' }))
      .toMatchObject({ allowed: false, code: 'SNAPSHOT_SCOPE_DENIED' })
    expect(decide('read', { file_path: 'repos/tmanage-backend/src/related.ts' }))
      .toMatchObject({ allowed: false, code: 'SNAPSHOT_SCOPE_DENIED' })
  })

  it('uses realpath so an artifact symlink cannot disguise an out-of-scope repository file', () => {
    expect(decide('read', { file_path: 'artifacts/repo-link.ts' }))
      .toMatchObject({ allowed: false, code: 'SNAPSHOT_SCOPE_DENIED' })
    expect(decide('read', { file_path: 'artifacts/result.txt' })).toEqual({ allowed: true })
    expect(decide('read', { file_path: 'artifacts/missing.txt' }))
      .toMatchObject({ allowed: false, code: 'SNAPSHOT_SCOPE_DENIED' })
  })

  it('allows any file in a RELATED candidate repository but no uncandidated repository', () => {
    expect(decide('read', { file_path: 'repos/tmanage-backend/src/related.ts' }, 'RELATED'))
      .toEqual({ allowed: true })
    expect(decide('read', { file_path: 'repos/kdmanage-frontend/src/outside.ts' }, 'RELATED'))
      .toMatchObject({ allowed: false, code: 'SNAPSHOT_SCOPE_DENIED' })
  })

  it('denies bash and repo-wide grep/glob under PRIMARY or RELATED with snapshot-tool guidance', () => {
    for (const level of ['PRIMARY', 'RELATED'] as const) {
      expect(decide('bash', { command: `cat ${outsidePath}` }, level))
        .toMatchObject({ allowed: false, code: 'SNAPSHOT_SCOPE_DENIED' })
      for (const toolName of ['grep', 'glob']) {
        const result = decide(toolName, { pattern: 'x', path: 'repos/tmanage-backend' }, level)
        expect(result).toMatchObject({ allowed: false, code: 'SNAPSHOT_SCOPE_DENIED' })
        expect(result.reason).toContain('search_snapshot_code or find_snapshot_files')
      }
      expect(decide('grep', { pattern: 'x' }, level))
        .toMatchObject({ allowed: false, code: 'SNAPSHOT_SCOPE_DENIED' })
      expect(decide('glob', { pattern: '*.txt', path: 'artifacts' }, level)).toEqual({ allowed: true })
    }
  })

  it('allows native tools after GLOBAL expansion while leaving sandbox enforcement to Harness', () => {
    expect(decide('bash', { command: `cat ${outsidePath}` }, 'GLOBAL')).toEqual({ allowed: true })
    expect(decide('read', { file_path: 'repos/kdmanage-frontend/src/outside.ts' }, 'GLOBAL'))
      .toEqual({ allowed: true })
    expect(decide('read', null, 'GLOBAL')).toEqual({ allowed: true })
  })
})
