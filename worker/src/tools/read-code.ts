/**
 * readCode tool: read a bounded line range from a file inside one repository.
 * (Plan §11.3, §11.4)
 *
 * - Path is resolved via the path policy (no traversal, no blocked files).
 * - Files larger than 1 MB are rejected for full reads.
 * - At most 200 lines are returned; truncation is flagged.
 * - A content hash is returned so the retrieval record can pin the snippet.
 */

import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { assertRepositoryName } from '../git/repositories.js'
import { resolveSafePath, PathPolicyError } from '../security/path-policy.js'
import { clampLineRange } from './truncate.js'
import { TOOL_LIMITS, type CodeSnippet, type RepoPathResolver } from './types.js'

export interface ReadCodeInput {
  repository: string
  path: string
  startLine: number
  endLine: number
}

export async function readCode(
  resolvePath: RepoPathResolver,
  input: ReadCodeInput,
): Promise<CodeSnippet> {
  const repository = assertRepositoryName(input.repository)
  const root = resolvePath(repository)
  const abs = resolveSafePath(root, input.path) // throws PathPolicyError on violation

  const stat = statSync(abs)
  if (!stat.isFile()) {
    throw new PathPolicyError(`not a file: ${input.path}`)
  }
  if (stat.size > TOOL_LIMITS.maxFileBytes) {
    throw new PathPolicyError(
      `file exceeds ${TOOL_LIMITS.maxFileBytes} bytes: ${input.path}`,
    )
  }

  const { startLine, endLine, truncated } = clampLineRange(
    input.startLine,
    input.endLine,
    TOOL_LIMITS.maxReadLines,
  )

  const raw = readFileSync(abs, 'utf8')
  const lines = raw.split('\n')
  const slice = lines.slice(startLine - 1, endLine)
  const content = slice.join('\n')
  const contentHash = createHash('sha256').update(content).digest('hex')

  return {
    repository,
    filePath: input.path.replace(/^\.\//, ''),
    startLine,
    endLine: Math.min(endLine, lines.length),
    content,
    truncated,
    contentHash,
  }
}

/**
 * Return the total number of lines of a file within a repository, or null if it
 * does not exist / is not accessible. Used by evidence validation.
 */
export function countFileLines(
  resolvePath: RepoPathResolver,
  repository: string,
  filePath: string,
): number | null {
  try {
    const repo = assertRepositoryName(repository)
    const root = resolvePath(repo)
    const abs = resolveSafePath(root, filePath)
    const stat = statSync(abs)
    if (!stat.isFile()) return null
    const raw = readFileSync(abs, 'utf8')
    return raw.split('\n').length
  } catch {
    return null
  }
}
