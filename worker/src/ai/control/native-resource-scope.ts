import { realpathSync } from 'node:fs'
import { isAbsolute, posix, relative, resolve, sep } from 'node:path'
import type { StoryAnalysisScopeCandidate } from '../../db/jobs.js'

export const SNAPSHOT_SCOPE_DENIED = 'SNAPSHOT_SCOPE_DENIED'

export interface NativeResourceScopeInput {
  toolName: string
  args: unknown
  scopeLevel: 'PRIMARY' | 'RELATED' | 'GLOBAL'
  triageComplete: boolean
  workspaceDir: string
  reposDir: string
  repositories: readonly string[]
  candidates: readonly StoryAnalysisScopeCandidate[]
}

export interface NativeResourceScopeDecision {
  allowed: boolean
  code?: typeof SNAPSHOT_SCOPE_DENIED
  reason?: string
}

const ALLOWED_RESOURCE_TOOLS = new Set(['read', 'read_image', 'grep', 'glob', 'bash'])
const READ_RESOURCE_TOOLS = new Set(['read', 'read_image'])
const SEARCH_RESOURCE_TOOLS = new Set(['grep', 'glob'])

function denied(reason: string): NativeResourceScopeDecision {
  return { allowed: false, code: SNAPSHOT_SCOPE_DENIED, reason }
}

function inside(parent: string, child: string): boolean {
  const value = relative(parent, child)
  return value === '' || (!value.startsWith(`..${sep}`) && value !== '..' && !isAbsolute(value))
}

/**
 * Preserve the exact path spelling that the Harness filesystem tools execute.
 * Authorization must never decode URL escapes or strip quotes: `%73rc` and
 * `src` are different legal filesystem names, and approving one while the
 * tool opens the other would break the scope boundary.
 */
export function normalizeNativeResourcePath(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) return null
  return value
}

function realTarget(workspaceDir: string, value: unknown): string | null {
  const normalized = normalizeNativeResourcePath(value)
  if (normalized === null) return null
  try {
    return realpathSync(resolve(workspaceDir, normalized))
  } catch {
    return null
  }
}

function canonicalCandidatePath(value: unknown): string | null {
  if (typeof value !== 'string' || value === '' || value.includes('\\') || value.includes('\0')) return null
  const normalized = posix.normalize(value.replace(/^\.\//, ''))
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../') || posix.isAbsolute(normalized)) return null
  return normalized
}

function scopedCandidates(candidates: readonly StoryAnalysisScopeCandidate[]): StoryAnalysisScopeCandidate[] {
  return candidates.filter((candidate) => candidate.tier !== 'EXCLUDED' && candidate.tier !== 'CONFLICT')
}

function candidateRepositoryAllowed(
  repository: string,
  candidates: readonly StoryAnalysisScopeCandidate[],
): boolean {
  return scopedCandidates(candidates).some((candidate) => candidate.repository === repository)
}

function primaryPaths(
  repository: string,
  candidates: readonly StoryAnalysisScopeCandidate[],
  triageComplete: boolean,
): Set<string> {
  const result = new Set<string>()
  for (const candidate of scopedCandidates(candidates)) {
    if (candidate.repository !== repository) continue
    const selectedStrong = candidate.tier === 'STRONG'
      && candidate.selected === true && candidate.selection_level === 'PRIMARY'
    const selectedTriaged = triageComplete
      && (candidate.tier === 'AI_CANDIDATE' || candidate.tier === 'WEAK')
      && candidate.selected === true && candidate.selection_level === 'PRIMARY'
    if (!selectedStrong && !selectedTriaged) continue
    for (const file of candidate.files ?? []) {
      const path = canonicalCandidatePath(file.path)
      const oldPath = canonicalCandidatePath(file.old_path)
      if (path !== null) result.add(path)
      if (oldPath !== null) result.add(oldPath)
    }
  }
  return result
}

function repositoryTarget(input: NativeResourceScopeInput, target: string): {
  repository: string
  relativePath: string
} | null {
  let reposRoot: string
  try {
    reposRoot = realpathSync(input.reposDir)
  } catch {
    return null
  }
  if (!inside(reposRoot, target)) return null
  for (const repository of input.repositories) {
    try {
      const root = realpathSync(resolve(reposRoot, repository))
      if (!inside(root, target)) continue
      return {
        repository,
        relativePath: relative(root, target).split(sep).join('/'),
      }
    } catch {
      // A missing materialized repository cannot authorize a target.
    }
  }
  return { repository: '', relativePath: '' }
}

function searchOverlapsRepositories(input: NativeResourceScopeInput, target: string): boolean | null {
  try {
    const reposRoot = realpathSync(input.reposDir)
    return inside(reposRoot, target) || inside(target, reposRoot)
  } catch {
    return null
  }
}

/**
 * Broker-side authorization for Harness-native resource tools. The caller must bypass this only
 * for legacy V1 jobs; GLOBAL is allowed here and remains constrained by the Harness sandbox.
 */
export function evaluateNativeResourceScope(
  input: NativeResourceScopeInput,
): NativeResourceScopeDecision {
  if (input.scopeLevel === 'GLOBAL') return { allowed: true }
  if (!ALLOWED_RESOURCE_TOOLS.has(input.toolName)) {
    return denied('resource tool scope could not be determined')
  }
  if (input.toolName === 'bash') {
    return denied(
      'bash is disabled while analysis scope is PRIMARY or RELATED because shell commands cannot be parsed safely; use snapshot tools or expand the analysis scope',
    )
  }
  if (input.args === null || typeof input.args !== 'object') {
    return denied('resource path could not be determined')
  }
  const args = input.args as Record<string, unknown>
  const rawPath = READ_RESOURCE_TOOLS.has(input.toolName)
    ? args.file_path
    : SEARCH_RESOURCE_TOOLS.has(input.toolName)
      ? (args.path ?? '.')
      : undefined
  const target = realTarget(input.workspaceDir, rawPath)
  if (target === null) return denied('resource path could not be determined')

  if (SEARCH_RESOURCE_TOOLS.has(input.toolName)) {
    const overlaps = searchOverlapsRepositories(input, target)
    if (overlaps === null) return denied('resource path could not be determined')
    if (overlaps) {
      return denied(
        `${input.toolName} cannot search workspace code repositories while analysis scope is PRIMARY or RELATED; use search_snapshot_code or find_snapshot_files`,
      )
    }
    return { allowed: true }
  }

  const repository = repositoryTarget(input, target)
  if (repository === null) return { allowed: true }
  if (repository.repository === '') {
    return denied('repository path could not be mapped to a pinned repository')
  }
  if (!candidateRepositoryAllowed(repository.repository, input.candidates)) {
    return denied('repository is outside the current frozen analysis scope')
  }
  if (input.scopeLevel === 'RELATED') return { allowed: true }
  if (!primaryPaths(repository.repository, input.candidates, input.triageComplete).has(repository.relativePath)) {
    return denied('path is outside the PRIMARY frozen candidate file set')
  }
  return { allowed: true }
}
