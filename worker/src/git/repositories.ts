/**
 * Fixed repository whitelist. The MVP does not accept arbitrary Git URLs from
 * users or from the model. Only these repositories may ever be prepared or
 * searched. (Plan §8.1, §6.2, §11.4)
 *
 * **Adding a repository touches two sources of truth.** This list, and the SQL
 * function `public.analysis_repository_catalog()`. They are asserted to agree by
 * `worker/src/__tests__/repository-whitelist-parity.test.ts` (needs the local
 * Supabase) plus literal expectations in this file's unit test and in
 * `supabase/tests/*_reviewed_repository_whitelist_*_test.sql`.
 *
 * Note the paths are not uniform: `kwork-server` lives directly under `kwork/`,
 * the other four under `kwork/manage/`. Never derive a path from a name.
 */

export const DEFAULT_GITLAB_BASE_URL = 'https://git.kingdee.com'

export const REPOSITORIES = [
  {
    name: 'kdmanage-backend',
    path: '/kwork/manage/kdmanage-backend.git',
    url: `${DEFAULT_GITLAB_BASE_URL}/kwork/manage/kdmanage-backend.git`,
  },
  {
    name: 'kdmanage-frontend',
    path: '/kwork/manage/kdmanage-frontend.git',
    url: `${DEFAULT_GITLAB_BASE_URL}/kwork/manage/kdmanage-frontend.git`,
  },
  {
    name: 'kwork-server',
    path: '/kwork/kwork-server.git',
    url: `${DEFAULT_GITLAB_BASE_URL}/kwork/kwork-server.git`,
  },
  {
    name: 'tmanage-backend',
    path: '/kwork/manage/tmanage-backend.git',
    url: `${DEFAULT_GITLAB_BASE_URL}/kwork/manage/tmanage-backend.git`,
  },
  {
    name: 'tmanage-frontend',
    path: '/kwork/manage/tmanage-frontend.git',
    url: `${DEFAULT_GITLAB_BASE_URL}/kwork/manage/tmanage-frontend.git`,
  },
] as const

export type RepositoryName = (typeof REPOSITORIES)[number]['name']

export const REPOSITORY_NAMES: readonly RepositoryName[] = REPOSITORIES.map(
  (r) => r.name,
) as RepositoryName[]

export const ALLOWED_BRANCHES = ['feature_dev', 'feature_sit', 'release'] as const
export type BranchName = (typeof ALLOWED_BRANCHES)[number]

/** True if the given string is one of the whitelisted repository names. */
export function isRepositoryName(value: unknown): value is RepositoryName {
  return (
    typeof value === 'string' &&
    REPOSITORY_NAMES.includes(value as RepositoryName)
  )
}

/** True if the given string is one of the three allowed branch names. */
export function isBranchName(value: unknown): value is BranchName {
  return (
    typeof value === 'string' &&
    (ALLOWED_BRANCHES as readonly string[]).includes(value)
  )
}

/**
 * Validate a trusted deployment GitLab origin. Repository paths are never
 * accepted from this value: only scheme + host + optional port may vary.
 */
export function normalizeGitLabBaseUrl(value: string): string {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('protocol')
    if (url.username || url.password || url.search || url.hash) throw new Error('credentials/query')
    if (url.pathname !== '/' && url.pathname !== '') throw new Error('path')
    return url.origin
  } catch {
    throw new Error('invalid GITLAB_BASE_URL: expected an HTTP(S) origin without credentials, path, query or hash')
  }
}

/**
 * Resolve a repository name to its whitelisted clone URL on the configured
 * trusted GitLab origin. The repository path always comes from REPOSITORIES.
 */
export function getRepositoryUrl(
  name: string,
  baseUrl: string = DEFAULT_GITLAB_BASE_URL,
): string {
  const repo = REPOSITORIES.find((r) => r.name === name)
  if (!repo) {
    throw new Error(`repository not in whitelist: ${redactRepoName(name)}`)
  }
  return `${normalizeGitLabBaseUrl(baseUrl)}${repo.path}`
}

/** Assert the branch is one of the allowed enum values. */
export function assertBranch(value: unknown): BranchName {
  if (!isBranchName(value)) {
    throw new Error(`branch not allowed: ${String(value)}`)
  }
  return value
}

/** Assert the repository name is whitelisted. */
export function assertRepositoryName(value: unknown): RepositoryName {
  if (!isRepositoryName(value)) {
    throw new Error(`repository not in whitelist: ${redactRepoName(value)}`)
  }
  return value
}

function redactRepoName(value: unknown): string {
  const s = String(value)
  return s.length > 64 ? `${s.slice(0, 64)}…` : s
}
