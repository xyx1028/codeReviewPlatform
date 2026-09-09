/**
 * Git branch verification and SHA parsing. (Plan §6.2, §6.3)
 *
 * All git invocations use spawn(command, args). No shell string interpolation.
 */

import { isValidSha } from '../ai/schemas.js'
import { assertBranch, type BranchName } from './repositories.js'
import { runCommand, SpawnError } from './run.js'

export class GitError extends Error {
  code: string
  constructor(message: string, code: string) {
    super(message)
    this.name = 'GitError'
    this.code = code
  }
}

/**
 * Resolve the remote HEAD SHA of refs/heads/<branch> for a repository URL.
 * Uses `git ls-remote --exit-code --heads`. In token mode the caller passes
 * the http.extraHeader auth args so the credential never appears in the URL.
 * @throws GitError(GIT_BRANCH_MISSING) if the branch is absent.
 * @throws GitError(GIT_AUTH_FAILED) on auth failure.
 */
export async function resolveRemoteHead(
  repoUrl: string,
  branch: BranchName,
  authArgs: string[] = [],
): Promise<string> {
  assertBranch(branch)
  const ref = `refs/heads/${branch}`
  try {
    const { stdout } = await runCommand(
      'git',
      [...authArgs, 'ls-remote', '--exit-code', '--heads', repoUrl, ref],
      { timeoutMs: 60000 },
    )
    return parseLsRemote(stdout, ref)
  } catch (err) {
    if (err instanceof SpawnError) {
      // git ls-remote --exit-code returns 2 when no matching refs are found.
      if (err.code === 2) {
        throw new GitError(`branch missing: ${branch}`, 'GIT_BRANCH_MISSING')
      }
      if (isAuthFailure(err.stderr)) {
        throw new GitError('gitlab authentication failed', 'GIT_AUTH_FAILED')
      }
      throw new GitError(`git fetch failed: ls-remote`, 'GIT_FETCH_FAILED')
    }
    throw err
  }
}

/** Parse `<sha>\t<ref>` lines and return the SHA for the exact ref. */
export function parseLsRemote(stdout: string, ref: string): string {
  const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean)
  for (const line of lines) {
    const [sha, refName] = line.split(/\s+/)
    if (refName === ref && isValidSha(sha)) {
      return sha
    }
  }
  // Fall back: single line without ref match but valid sha.
  const first = lines[0]?.split(/\s+/)[0]
  if (first && isValidSha(first) && lines.length === 1) {
    return first
  }
  throw new GitError(`could not parse ls-remote output for ${ref}`, 'GIT_BRANCH_MISSING')
}

function isAuthFailure(stderr: string): boolean {
  return /authentication failed|could not read username|403 forbidden|access denied|401 unauthorized|permission denied/i.test(
    stderr,
  )
}

/** Read the current HEAD SHA of a prepared working tree via `git rev-parse HEAD`. */
export async function revParseHead(workdir: string): Promise<string> {
  const { stdout } = await runCommand('git', ['rev-parse', 'HEAD'], {
    cwd: workdir,
    timeoutMs: 30000,
  })
  const sha = stdout.trim()
  if (!isValidSha(sha)) {
    throw new GitError(`rev-parse produced invalid sha`, 'GIT_SHA_MISMATCH')
  }
  return sha
}

/** Read the subject line of a commit via `git log -1 --format=%s`. */
export async function readCommitSubject(
  workdir: string,
  sha: string,
): Promise<string> {
  if (!isValidSha(sha)) {
    throw new GitError('invalid sha for subject lookup', 'GIT_SHA_MISMATCH')
  }
  const { stdout } = await runCommand(
    'git',
    ['log', '-1', '--format=%s', sha],
    { cwd: workdir, timeoutMs: 30000 },
  )
  return stdout.trim()
}

/**
 * Confirm the given SHA is reachable from refs/heads/<branch> on the remote.
 * Used after a fetch to re-verify the snapshot belongs to the target branch
 * when ls-remote and fetch disagree. (Plan §6.3)
 */
export function shaBelongsToBranch(
  fetchHeadSha: string,
  resolvedHeadSha: string,
): boolean {
  return (
    isValidSha(fetchHeadSha) &&
    isValidSha(resolvedHeadSha) &&
    fetchHeadSha.toLowerCase() === resolvedHeadSha.toLowerCase()
  )
}
