/**
 * Environment variable validation. (Plan §15.1)
 *
 * The worker refuses to start unless required variables are present and valid.
 * Model Base URL / Model / API Key are NOT read from the environment — they are
 * resolved per-batch from ai_model_config + Vault. (Plan §15.1)
 */

import { DEFAULT_GITLAB_BASE_URL, normalizeGitLabBaseUrl } from './git/repositories.js'

export type GitAuthMode = 'local' | 'token'

export interface WorkerConfig {
  supabaseUrl: string
  supabaseServiceRoleKey: string

  gitAuthMode: GitAuthMode
  gitlabBaseUrl: string
  gitlabDeployUser: string | null
  gitlabDeployToken: string | null

  workerId: string
  workspaceRoot: string
  codeCacheRoot: string
  pollIntervalMs: number
  storyTaskLeaseSeconds: number
  heartbeatIntervalMs: number
  workerStoryConcurrency: number
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

export type Env = Record<string, string | undefined>

function requireStr(env: Env, key: string): string {
  const v = env[key]
  if (v === undefined || v.trim() === '') {
    throw new ConfigError(`missing required environment variable: ${key}`)
  }
  return v.trim()
}

function optStr(env: Env, key: string, fallback: string | null = null): string | null {
  const v = env[key]
  return v === undefined || v.trim() === '' ? fallback : v.trim()
}

function intInRange(
  env: Env,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[key]
  if (raw === undefined || raw.trim() === '') return fallback
  const n = Number(raw)
  if (!Number.isInteger(n)) {
    throw new ConfigError(`environment variable ${key} must be an integer, got: ${raw}`)
  }
  if (n < min || n > max) {
    throw new ConfigError(
      `environment variable ${key} must be between ${min} and ${max}, got: ${n}`,
    )
  }
  return n
}

function validUrl(value: string, key: string): string {
  try {
    // eslint-disable-next-line no-new
    new URL(value)
  } catch {
    throw new ConfigError(`environment variable ${key} must be a valid URL: ${value}`)
  }
  return value
}

function validGitLabBaseUrl(value: string): string {
  try {
    return normalizeGitLabBaseUrl(value)
  } catch {
    throw new ConfigError(
      'environment variable GITLAB_BASE_URL must be an HTTP(S) origin without credentials, path, query or hash',
    )
  }
}

/**
 * Validate and parse worker configuration from an environment map.
 * Exposed with an explicit `env` argument for testability.
 */
export function loadConfig(env: Env = process.env): WorkerConfig {
  const supabaseUrl = validUrl(requireStr(env, 'SUPABASE_URL'), 'SUPABASE_URL')
  const supabaseServiceRoleKey = requireStr(env, 'SUPABASE_SERVICE_ROLE_KEY')

  const rawAuthMode = optStr(env, 'GIT_AUTH_MODE', 'local')!
  if (rawAuthMode !== 'local' && rawAuthMode !== 'token') {
    throw new ConfigError(`GIT_AUTH_MODE must be 'local' or 'token', got: ${rawAuthMode}`)
  }
  const gitAuthMode = rawAuthMode as GitAuthMode

  const gitlabBaseUrl = validGitLabBaseUrl(
    optStr(env, 'GITLAB_BASE_URL', DEFAULT_GITLAB_BASE_URL)!,
  )

  const gitlabDeployUser = optStr(env, 'GITLAB_DEPLOY_USER')
  const gitlabDeployToken = optStr(env, 'GITLAB_DEPLOY_TOKEN')

  if (gitAuthMode === 'token') {
    if (!gitlabDeployUser || !gitlabDeployToken) {
      throw new ConfigError(
        "GIT_AUTH_MODE=token requires GITLAB_DEPLOY_USER and GITLAB_DEPLOY_TOKEN",
      )
    }
  }

  const workerId = requireStr(env, 'WORKER_ID')
  const workspaceRoot = optStr(env, 'WORKSPACE_ROOT', '/workspace/jobs')!
  const codeCacheRoot = optStr(env, 'CODE_CACHE_ROOT', '/workspace/cache')!

  const pollIntervalMs = intInRange(env, 'POLL_INTERVAL_MS', 5000, 500, 600000)
  const storyTaskLeaseSeconds = intInRange(
    env,
    'STORY_TASK_LEASE_SECONDS',
    900,
    30,
    7200,
  )
  const heartbeatIntervalMs = intInRange(
    env,
    'HEARTBEAT_INTERVAL_MS',
    30000,
    5000,
    300000,
  )
  const workerStoryConcurrency = intInRange(
    env,
    'WORKER_STORY_CONCURRENCY',
    2,
    1,
    20,
  )

  if (heartbeatIntervalMs >= storyTaskLeaseSeconds * 1000) {
    throw new ConfigError(
      'HEARTBEAT_INTERVAL_MS must be smaller than STORY_TASK_LEASE_SECONDS',
    )
  }

  return {
    supabaseUrl,
    supabaseServiceRoleKey,
    gitAuthMode,
    gitlabBaseUrl,
    gitlabDeployUser,
    gitlabDeployToken,
    workerId,
    workspaceRoot,
    codeCacheRoot,
    pollIntervalMs,
    storyTaskLeaseSeconds,
    heartbeatIntervalMs,
    workerStoryConcurrency,
  }
}
