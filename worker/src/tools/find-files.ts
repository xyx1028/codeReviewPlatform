/**
 * findFiles tool: list files matching a glob pattern inside one repository.
 * Implemented with ripgrep --files (respects the same excludes) to avoid shell
 * globbing. (Plan §11.3, §11.4)
 */

import { assertRepositoryName } from '../git/repositories.js'
import { isBlockedPath, assertSafePathGlob } from '../security/path-policy.js'
import { runCommand, SpawnError } from '../git/run.js'
import { BLOCKED_DIRECTORIES } from '../security/path-policy.js'
import { truncateList } from './truncate.js'
import { TOOL_LIMITS, type RepoPathResolver } from './types.js'

export interface FindFilesInput {
  repository: string
  pattern: string
  maxResults?: number
}

export interface FindFilesOutput {
  files: string[]
  truncated: boolean
  total: number
}

function globExcludes(): string[] {
  const args: string[] = []
  for (const dir of BLOCKED_DIRECTORIES) {
    args.push('-g', `!**/${dir}/**`)
  }
  return args
}

export async function findFiles(
  resolvePath: RepoPathResolver,
  input: FindFilesInput,
): Promise<FindFilesOutput> {
  const repository = assertRepositoryName(input.repository)
  if (typeof input.pattern !== 'string' || input.pattern.length === 0) {
    throw new Error('findFiles pattern must be a non-empty string')
  }
  assertSafePathGlob(input.pattern)
  const root = resolvePath(repository)
  const max = Math.min(input.maxResults ?? TOOL_LIMITS.maxFindResults, TOOL_LIMITS.maxFindResults)

  const args = ['--files', '--color', 'never', ...globExcludes(), '-g', input.pattern]

  let stdout = ''
  try {
    const res = await runCommand('rg', args, { cwd: root, timeoutMs: 30000 })
    stdout = res.stdout
  } catch (err) {
    if (err instanceof SpawnError && err.code === 1) {
      return { files: [], truncated: false, total: 0 }
    }
    throw err
  }

  const all = stdout
    .split('\n')
    .map((l) => l.replace(/^\.\//, '').trim())
    .filter((l) => l.length > 0)
    .filter((p) => !isBlockedPath(p))

  const { items, truncated, totalBeforeTruncation } = truncateList(all, max)
  return { files: items, truncated, total: totalBeforeTruncation }
}
