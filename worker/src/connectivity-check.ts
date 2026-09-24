/**
 * Deployment connectivity acceptance for the AI automation Worker.
 *
 * Checks, without cloning code or sending requirements/source to the model:
 *   1. GitLab: every whitelisted repository x 3 allowed branches via ls-remote.
 *   2. Supabase: PostgREST service-role access, model metadata and Vault secret RPC.
 *   3. Model API: one OpenAI-compatible `ping` request with max_tokens=1.
 *
 * Secrets are used only in request headers/process arguments and are never
 * included in returned results or structured output.
 */

import { pathToFileURL } from 'node:url'
import { authArgs } from './git/prepare.js'
import {
  ALLOWED_BRANCHES,
  DEFAULT_GITLAB_BASE_URL,
  REPOSITORIES,
  getRepositoryUrl,
  normalizeGitLabBaseUrl,
  type BranchName,
} from './git/repositories.js'
import { resolveRemoteHead } from './git/verify.js'

const ALL_COMPONENTS = ['git', 'supabase', 'model'] as const
export type ConnectivityComponent = (typeof ALL_COMPONENTS)[number]

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>

type GitRefProbe = (
  repositoryUrl: string,
  branch: BranchName,
  gitAuthArgs: string[],
) => Promise<string>

export interface ConnectivityEnvironment {
  [key: string]: string | undefined
}

interface ConnectivityConfig {
  components: ConnectivityComponent[]
  gitAuthMode: 'local' | 'token'
  gitlabBaseUrl: string
  gitlabDeployUser: string | null
  gitlabDeployToken: string | null
  supabaseUrl: string | null
  supabaseServiceRoleKey: string | null
  modelConfigId: string | null
  timeoutMs: number
}

interface ModelAccess {
  baseUrl: string
  modelName: string
  timeoutMs: number
  apiKey: string
}

export interface ConnectivityCheckResult {
  component: ConnectivityComponent
  target: string
  ok: boolean
  duration_ms: number
  error_code?: string
  commit_sha?: string
  status_code?: number
}

export interface ConnectivitySummary {
  ok: boolean
  selected_components: ConnectivityComponent[]
  total: number
  passed: number
  failed: number
  by_component: Record<ConnectivityComponent, { total: number; passed: number; failed: number }>
  checks: ConnectivityCheckResult[]
}

export interface ConnectivityDependencies {
  env?: ConnectivityEnvironment
  fetchImpl?: FetchLike
  gitRefProbe?: GitRefProbe
  writeLine?: (line: string) => void
  now?: () => number
}

export class ConnectivityConfigError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'ConnectivityConfigError'
    this.code = code
  }
}

class ConnectivityProbeError extends Error {
  readonly code: string
  readonly statusCode?: number

  constructor(code: string, statusCode?: number) {
    super(code)
    this.name = 'ConnectivityProbeError'
    this.code = code
    this.statusCode = statusCode
  }
}

function requireValue(env: ConnectivityEnvironment, name: string): string {
  const value = env[name]?.trim()
  if (!value) {
    throw new ConnectivityConfigError(
      'CONNECTIVITY_CONFIG_MISSING',
      `missing required environment variable: ${name}`,
    )
  }
  return value
}

function parseUrl(value: string, name: string): string {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('unsupported protocol')
    return url.toString().replace(/\/+$/, '')
  } catch {
    throw new ConnectivityConfigError(
      'CONNECTIVITY_CONFIG_INVALID',
      `${name} must be an HTTP(S) URL`,
    )
  }
}

function parseGitLabBaseUrl(value: string): string {
  try {
    return normalizeGitLabBaseUrl(value)
  } catch {
    throw new ConnectivityConfigError(
      'CONNECTIVITY_CONFIG_INVALID',
      'GITLAB_BASE_URL must be an HTTP(S) origin without credentials, path, query or hash',
    )
  }
}

function parseTimeout(env: ConnectivityEnvironment): number {
  const raw = env.CONNECTIVITY_TIMEOUT_MS?.trim()
  if (!raw) return 30000
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1000 || value > 120000) {
    throw new ConnectivityConfigError(
      'CONNECTIVITY_CONFIG_INVALID',
      'CONNECTIVITY_TIMEOUT_MS must be an integer between 1000 and 120000',
    )
  }
  return value
}

function parseComponents(raw: string | undefined): ConnectivityComponent[] {
  if (!raw?.trim()) return [...ALL_COMPONENTS]
  const requested = Array.from(
    new Set(raw.split(',').map((part) => part.trim().toLowerCase()).filter(Boolean)),
  )
  if (requested.length === 0) {
    throw new ConnectivityConfigError(
      'CONNECTIVITY_CONFIG_INVALID',
      'CONNECTIVITY_COMPONENTS cannot be empty',
    )
  }
  for (const component of requested) {
    if (!(ALL_COMPONENTS as readonly string[]).includes(component)) {
      throw new ConnectivityConfigError(
        'CONNECTIVITY_CONFIG_INVALID',
        `unsupported connectivity component: ${component}`,
      )
    }
  }
  // A model probe obtains its endpoint/key through Supabase + Vault, so that
  // prerequisite is always explicitly checked and reported as well.
  if (requested.includes('model') && !requested.includes('supabase')) {
    requested.unshift('supabase')
  }
  return ALL_COMPONENTS.filter((component) => requested.includes(component))
}

export function loadConnectivityConfig(
  env: ConnectivityEnvironment = process.env,
): ConnectivityConfig {
  const components = parseComponents(env.CONNECTIVITY_COMPONENTS)
  const checksGit = components.includes('git')
  const checksSupabase = components.includes('supabase')

  const rawAuthMode = env.GIT_AUTH_MODE?.trim() || 'local'
  if (rawAuthMode !== 'local' && rawAuthMode !== 'token') {
    throw new ConnectivityConfigError(
      'CONNECTIVITY_CONFIG_INVALID',
      "GIT_AUTH_MODE must be 'local' or 'token'",
    )
  }
  const gitAuthMode = rawAuthMode
  const gitlabBaseUrl = checksGit
    ? parseGitLabBaseUrl(env.GITLAB_BASE_URL?.trim() || DEFAULT_GITLAB_BASE_URL)
    : DEFAULT_GITLAB_BASE_URL
  const gitlabDeployUser = env.GITLAB_DEPLOY_USER?.trim() || null
  const gitlabDeployToken = env.GITLAB_DEPLOY_TOKEN?.trim() || null
  if (checksGit && gitAuthMode === 'token' && (!gitlabDeployUser || !gitlabDeployToken)) {
    throw new ConnectivityConfigError(
      'CONNECTIVITY_CONFIG_MISSING',
      'GIT_AUTH_MODE=token requires GITLAB_DEPLOY_USER and GITLAB_DEPLOY_TOKEN',
    )
  }

  let supabaseUrl: string | null = null
  let supabaseServiceRoleKey: string | null = null
  let modelConfigId: string | null = null
  if (checksSupabase) {
    supabaseUrl = parseUrl(requireValue(env, 'SUPABASE_URL'), 'SUPABASE_URL')
    supabaseServiceRoleKey = requireValue(env, 'SUPABASE_SERVICE_ROLE_KEY')
    modelConfigId = requireValue(env, 'CONNECTIVITY_MODEL_CONFIG_ID')
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(modelConfigId)) {
      throw new ConnectivityConfigError(
        'CONNECTIVITY_CONFIG_INVALID',
        'CONNECTIVITY_MODEL_CONFIG_ID must be a UUID',
      )
    }
  }

  return {
    components,
    gitAuthMode,
    gitlabBaseUrl,
    gitlabDeployUser,
    gitlabDeployToken,
    supabaseUrl,
    supabaseServiceRoleKey,
    modelConfigId,
    timeoutMs: parseTimeout(env),
  }
}

function safeErrorCode(error: unknown, fallback: string): string {
  if (error instanceof ConnectivityProbeError || error instanceof ConnectivityConfigError) {
    return error.code
  }
  const code = (error as { code?: unknown } | null)?.code
  if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/.test(code)) return code
  return fallback
}

async function fetchWithTimeout(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  timeoutCode: string,
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal })
  } catch (error) {
    if ((error as { name?: string } | null)?.name === 'AbortError') {
      throw new ConnectivityProbeError(timeoutCode)
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

function serviceHeaders(serviceRoleKey: string): Record<string, string> {
  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    Accept: 'application/json',
  }
}

async function checkSupabaseAndVault(
  config: ConnectivityConfig,
  fetchImpl: FetchLike,
): Promise<ModelAccess> {
  const supabaseUrl = config.supabaseUrl!
  const serviceRoleKey = config.supabaseServiceRoleKey!
  const modelConfigId = config.modelConfigId!

  const metadataUrl = new URL(`${supabaseUrl}/rest/v1/ai_model_config`)
  metadataUrl.searchParams.set('id', `eq.${modelConfigId}`)
  metadataUrl.searchParams.set(
    'select',
    'id,base_url,model_name,enabled,request_timeout_ms',
  )
  metadataUrl.searchParams.set('limit', '1')

  const metadataResponse = await fetchWithTimeout(
    fetchImpl,
    metadataUrl.toString(),
    { method: 'GET', headers: serviceHeaders(serviceRoleKey) },
    config.timeoutMs,
    'SUPABASE_TIMEOUT',
  )
  if (!metadataResponse.ok) {
    await metadataResponse.text().catch(() => '')
    throw new ConnectivityProbeError(
      `SUPABASE_HTTP_${metadataResponse.status}`,
      metadataResponse.status,
    )
  }

  const metadata = await metadataResponse.json() as unknown
  const row = Array.isArray(metadata) ? metadata[0] : null
  if (!row || typeof row !== 'object') {
    throw new ConnectivityProbeError('MODEL_CONFIG_NOT_FOUND')
  }
  const record = row as Record<string, unknown>
  if (record.enabled !== true) {
    throw new ConnectivityProbeError('MODEL_CONFIG_DISABLED')
  }
  if (
    typeof record.base_url !== 'string' ||
    typeof record.model_name !== 'string'
  ) {
    throw new ConnectivityProbeError('MODEL_CONFIG_INVALID')
  }

  const secretResponse = await fetchWithTimeout(
    fetchImpl,
    `${supabaseUrl}/rest/v1/rpc/admin_get_model_secret_by_config`,
    {
      method: 'POST',
      headers: { ...serviceHeaders(serviceRoleKey), 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_id: modelConfigId }),
    },
    config.timeoutMs,
    'SUPABASE_TIMEOUT',
  )
  if (!secretResponse.ok) {
    await secretResponse.text().catch(() => '')
    throw new ConnectivityProbeError(
      `VAULT_RPC_HTTP_${secretResponse.status}`,
      secretResponse.status,
    )
  }
  const secretPayload = await secretResponse.json() as unknown
  if (typeof secretPayload !== 'string' || secretPayload.length === 0) {
    throw new ConnectivityProbeError('MODEL_SECRET_MISSING')
  }

  const configuredTimeout = typeof record.request_timeout_ms === 'number'
    ? record.request_timeout_ms
    : config.timeoutMs
  return {
    baseUrl: parseUrl(record.base_url, 'model base_url'),
    modelName: record.model_name,
    timeoutMs: Math.min(config.timeoutMs, Math.max(1000, configuredTimeout)),
    apiKey: secretPayload,
  }
}

/**
 * Probe the model endpoint.
 *
 * Both engines ultimately speak the OpenAI-compatible completions API — the
 * agent engine reaches it through the Harness pi-ai adapter — so the same
 * minimal probe is meaningful for both. What the probe cannot tell us is
 * whether the Harness runtime itself boots; that is covered by the ACP
 * integration test, not by a network check.
 */
async function checkModel(
  access: ModelAccess,
  fetchImpl: FetchLike,
): Promise<number> {
  const response = await fetchWithTimeout(
    fetchImpl,
    `${access.baseUrl}/chat/completions`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${access.apiKey}`,
      },
      body: JSON.stringify({
        model: access.modelName,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
      }),
    },
    access.timeoutMs,
    'MODEL_TIMEOUT',
  )
  const status = response.status
  await response.text().catch(() => '')
  if (!response.ok) {
    throw new ConnectivityProbeError(`MODEL_HTTP_${status}`, status)
  }
  return status
}

function emptyComponentCounts(): ConnectivitySummary['by_component'] {
  return {
    git: { total: 0, passed: 0, failed: 0 },
    supabase: { total: 0, passed: 0, failed: 0 },
    model: { total: 0, passed: 0, failed: 0 },
  }
}

export async function runConnectivityCheck(
  dependencies: ConnectivityDependencies = {},
): Promise<ConnectivitySummary> {
  const config = loadConnectivityConfig(dependencies.env ?? process.env)
  const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch
  const gitRefProbe = dependencies.gitRefProbe ?? resolveRemoteHead
  const writeLine = dependencies.writeLine ?? ((line: string) => process.stdout.write(`${line}\n`))
  const now = dependencies.now ?? Date.now
  const checks: ConnectivityCheckResult[] = []

  const emit = (result: ConnectivityCheckResult): void => {
    checks.push(result)
    writeLine(JSON.stringify({ event: 'connectivity_check', ...result }))
  }

  if (config.components.includes('git')) {
    const gitArgs = authArgs({
      cacheRoot: '/tmp/connectivity-check-unused',
      authMode: config.gitAuthMode,
      deployUser: config.gitlabDeployUser,
      deployToken: config.gitlabDeployToken,
    })
    for (const repository of REPOSITORIES) {
      for (const branch of ALLOWED_BRANCHES) {
        const started = now()
        try {
          const repositoryUrl = getRepositoryUrl(repository.name, config.gitlabBaseUrl)
          const commitSha = await gitRefProbe(repositoryUrl, branch, gitArgs)
          emit({
            component: 'git',
            target: `${repository.name}/${branch}`,
            ok: true,
            duration_ms: Math.max(0, now() - started),
            commit_sha: commitSha,
          })
        } catch (error) {
          emit({
            component: 'git',
            target: `${repository.name}/${branch}`,
            ok: false,
            duration_ms: Math.max(0, now() - started),
            error_code: safeErrorCode(error, 'GIT_CHECK_FAILED'),
          })
        }
      }
    }
  }

  let modelAccess: ModelAccess | null = null
  if (config.components.includes('supabase')) {
    const started = now()
    try {
      modelAccess = await checkSupabaseAndVault(config, fetchImpl)
      emit({
        component: 'supabase',
        target: 'postgrest+model-config+vault',
        ok: true,
        duration_ms: Math.max(0, now() - started),
      })
    } catch (error) {
      emit({
        component: 'supabase',
        target: 'postgrest+model-config+vault',
        ok: false,
        duration_ms: Math.max(0, now() - started),
        error_code: safeErrorCode(error, 'SUPABASE_CHECK_FAILED'),
        status_code: error instanceof ConnectivityProbeError ? error.statusCode : undefined,
      })
    }
  }

  if (config.components.includes('model')) {
    const started = now()
    if (!modelAccess) {
      emit({
        component: 'model',
        target: 'configured-model-minimal-ping',
        ok: false,
        duration_ms: Math.max(0, now() - started),
        error_code: 'MODEL_CHECK_BLOCKED_BY_SUPABASE',
      })
    } else {
      const target = 'configured-model-minimal-ping'
      try {
        const statusCode = await checkModel(modelAccess, fetchImpl)
        emit({
          component: 'model',
          target,
          ok: true,
          duration_ms: Math.max(0, now() - started),
          status_code: statusCode,
        })
      } catch (error) {
        emit({
          component: 'model',
          target,
          ok: false,
          duration_ms: Math.max(0, now() - started),
          error_code: safeErrorCode(error, 'MODEL_CHECK_FAILED'),
          status_code: error instanceof ConnectivityProbeError ? error.statusCode : undefined,
        })
      } finally {
        modelAccess.apiKey = ''
        modelAccess = null
      }
    }
  } else if (modelAccess) {
    modelAccess.apiKey = ''
    modelAccess = null
  }

  const byComponent = emptyComponentCounts()
  for (const check of checks) {
    const counts = byComponent[check.component]
    counts.total += 1
    if (check.ok) counts.passed += 1
    else counts.failed += 1
  }
  const passed = checks.filter((check) => check.ok).length
  const summary: ConnectivitySummary = {
    ok: checks.length > 0 && passed === checks.length,
    selected_components: config.components,
    total: checks.length,
    passed,
    failed: checks.length - passed,
    by_component: byComponent,
    checks,
  }
  writeLine(JSON.stringify({
    event: 'connectivity_summary',
    ok: summary.ok,
    selected_components: summary.selected_components,
    total: summary.total,
    passed: summary.passed,
    failed: summary.failed,
    by_component: summary.by_component,
  }))
  return summary
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  runConnectivityCheck()
    .then((summary) => {
      process.exitCode = summary.ok ? 0 : 1
    })
    .catch((error) => {
      process.stdout.write(`${JSON.stringify({
        event: 'connectivity_fatal',
        ok: false,
        error_code: safeErrorCode(error, 'CONNECTIVITY_FATAL'),
      })}\n`)
      process.exitCode = 2
    })
}
