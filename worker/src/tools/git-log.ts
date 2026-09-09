/**
 * gitLog tool: search commit history of a single repository. (Plan §11.3, §11.4)
 *
 * Read-only. Uses `git log --grep` with an argument array. Returns bounded,
 * truncated results.
 */

import { assertRepositoryName } from '../git/repositories.js'
import { runCommand, SpawnError } from '../git/run.js'
import { truncateList } from './truncate.js'
import { TOOL_LIMITS, type CommitSummary, type RepoPathResolver } from './types.js'

export interface GitLogInput {
  repository: string
  query: string
  maxResults?: number
}

export interface GitLogOutput {
  commits: CommitSummary[]
  truncated: boolean
  total: number
}

const RECORD_SEP = '\x1e'
const FIELD_SEP = '\x1f'

export async function gitLog(
  resolvePath: RepoPathResolver,
  input: GitLogInput,
): Promise<GitLogOutput> {
  const repository = assertRepositoryName(input.repository)
  if (typeof input.query !== 'string' || input.query.length === 0) {
    throw new Error('gitLog query must be a non-empty string')
  }
  const root = resolvePath(repository)
  const max = Math.min(
    input.maxResults ?? TOOL_LIMITS.maxGitLogResults,
    TOOL_LIMITS.maxGitLogResults,
  )

  // Note: shallow clones (--depth 1) contain a single commit; --grep still works
  // over the available history. Format: sha<FS>subject<FS>author<FS>date<RS>
  const format = `%H${FIELD_SEP}%s${FIELD_SEP}%an${FIELD_SEP}%aI${RECORD_SEP}`
  const args = [
    'log',
    '--all',
    '--fixed-strings',
    `--grep=${input.query}`,
    '-i',
    `--max-count=${max}`,
    `--format=${format}`,
  ]

  let stdout = ''
  try {
    const res = await runCommand('git', args, { cwd: root, timeoutMs: 30000 })
    stdout = res.stdout
  } catch (err) {
    if (err instanceof SpawnError && err.code === 128) {
      // e.g. no commits / bad object in a shallow tree — treat as empty.
      return { commits: [], truncated: false, total: 0 }
    }
    throw err
  }

  const commits = parseGitLog(stdout)
  const { items, truncated, totalBeforeTruncation } = truncateList(commits, max)
  return { commits: items, truncated, total: totalBeforeTruncation }
}

/** Parse the record-separated git log output. */
export function parseGitLog(stdout: string): CommitSummary[] {
  return stdout
    .split(RECORD_SEP)
    .map((r) => r.trim())
    .filter((r) => r.length > 0)
    .map((r) => {
      const [sha, subject, author, date] = r.split(FIELD_SEP)
      return {
        sha: (sha ?? '').trim(),
        subject: subject ?? '',
        author: author ?? '',
        date: date ?? '',
      }
    })
    .filter((c) => c.sha.length > 0)
}
