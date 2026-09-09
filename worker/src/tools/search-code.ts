/**
 * searchCode tool: ripgrep over a single whitelisted repository. (Plan §11.3, §11.4)
 *
 * - Repository must be one of the four fixed names.
 * - rg is invoked with an argument array; never a shell string.
 * - At most 50 results; results are truncated with a flag.
 * - Blocked directories and secret files are excluded.
 */

import { assertRepositoryName } from '../git/repositories.js'
import { BLOCKED_DIRECTORIES, assertSafePathGlob } from '../security/path-policy.js'
import { runCommand, SpawnError } from '../git/run.js'
import { truncateList } from './truncate.js'
import { TOOL_LIMITS, type RepoPathResolver, type SearchHit } from './types.js'

export interface SearchCodeInput {
  repository: string
  query: string
  pathGlob?: string
  maxResults?: number
}

export interface SearchCodeOutput {
  hits: SearchHit[]
  truncated: boolean
  total: number
}

function globExcludes(): string[] {
  const args: string[] = []
  for (const dir of BLOCKED_DIRECTORIES) {
    args.push('-g', `!**/${dir}/**`)
  }
  // Exclude secret-ish files from search output.
  for (const g of ['!**/.env', '!**/.env.*', '!**/*.pem', '!**/*.key', '!**/id_rsa*']) {
    args.push('-g', g)
  }
  return args
}

/**
 * Run ripgrep. Uses --fixed-strings by default so model queries are not treated
 * as regex, reducing injection/ReDoS surface.
 */
export async function searchCode(
  resolvePath: RepoPathResolver,
  input: SearchCodeInput,
): Promise<SearchCodeOutput> {
  const repository = assertRepositoryName(input.repository)
  if (typeof input.query !== 'string' || input.query.length === 0) {
    throw new Error('searchCode query must be a non-empty string')
  }
  const root = resolvePath(repository)
  const max = Math.min(input.maxResults ?? TOOL_LIMITS.maxSearchResults, TOOL_LIMITS.maxSearchResults)

  const args = [
    '--line-number',
    '--no-heading',
    '--color',
    'never',
    '--fixed-strings',
    '--max-count',
    String(max),
    '--max-columns',
    '400',
    ...globExcludes(),
  ]
    if (input.pathGlob) {
      args.push('-g', assertSafePathGlob(input.pathGlob))
    }
  // Terminate options; query and path passed positionally.
  args.push('--', input.query, '.')

  let stdout = ''
  try {
    const res = await runCommand('rg', args, { cwd: root, timeoutMs: 30000 })
    stdout = res.stdout
  } catch (err) {
    // rg exits 1 when there are no matches — that is not an error for us.
    if (err instanceof SpawnError && err.code === 1) {
      return { hits: [], truncated: false, total: 0 }
    }
    throw err
  }

  const allHits: SearchHit[] = []
  for (const line of stdout.split('\n')) {
    if (!line) continue
    const parsed = parseRgLine(line, repository)
    if (parsed) allHits.push(parsed)
  }
  const { items, truncated, totalBeforeTruncation } = truncateList(allHits, max)
  return { hits: items, truncated, total: totalBeforeTruncation }
}

/** Parse an rg line of form `./path:line:text` (relative to cwd). */
export function parseRgLine(line: string, repository: SearchHit['repository']): SearchHit | null {
  // rg output: path:lineNumber:text  (path may contain ':' rarely, but line num is numeric)
  const m = line.match(/^(.*?):(\d+):(.*)$/)
  if (!m) return null
  const filePath = m[1].replace(/^\.\//, '')
  const lineNumber = Number(m[2])
  if (!Number.isInteger(lineNumber)) return null
  return {
    repository,
    filePath,
    lineNumber,
    lineText: m[3],
  }
}
