import { ALLOWED_BRANCHES, REPOSITORIES, REPOSITORY_NAMES } from '../git/repositories.js'
import { describe, expect, it, vi } from 'vitest'
import {
  ConnectivityConfigError,
  loadConnectivityConfig,
  runConnectivityCheck,
  type ConnectivityEnvironment,
} from '../connectivity-check.js'
import { GitError } from '../git/verify.js'

const MODEL_ID = '10000000-0000-4000-8000-000000000001'
const SERVICE_KEY = 'service-role-private-test-value'
const MODEL_KEY = 'model-private-test-value'
const DEPLOY_TOKEN = 'deploy-private-test-value'
const SHA = 'a'.repeat(40)

function fullEnv(overrides: ConnectivityEnvironment = {}): ConnectivityEnvironment {
  return {
    CONNECTIVITY_COMPONENTS: 'git,supabase,model',
    CONNECTIVITY_MODEL_CONFIG_ID: MODEL_ID,
    CONNECTIVITY_TIMEOUT_MS: '5000',
    SUPABASE_URL: 'https://project.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
    GIT_AUTH_MODE: 'token',
    GITLAB_DEPLOY_USER: 'deploy-user',
    GITLAB_DEPLOY_TOKEN: DEPLOY_TOKEN,
    ...overrides,
  }
}

function successfulSupabaseFetch(modelStatus = 200, modelBody = '{"ok":true}') {
  const modelRequests: Array<{ url: string; headers: Headers; body: unknown }> = []
  const fetchImpl = vi.fn(async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = String(input)
    const headers = new Headers(init?.headers)
    if (url.includes('/rest/v1/ai_model_config?')) {
      expect(headers.get('apikey')).toBe(SERVICE_KEY)
      expect(headers.get('Authorization')).toBe(`Bearer ${SERVICE_KEY}`)
      return new Response(JSON.stringify([{
        id: MODEL_ID,
        base_url: 'https://model.example.com/v1/',
        model_name: 'approved-model',
        enabled: true,
        request_timeout_ms: 10000,
      }]), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    if (url.endsWith('/rest/v1/rpc/admin_get_model_secret_by_config')) {
      expect(init?.method).toBe('POST')
      expect(JSON.parse(String(init?.body))).toEqual({ p_id: MODEL_ID })
      return new Response(JSON.stringify(MODEL_KEY), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    if (url === 'https://model.example.com/v1/chat/completions') {
      const body = JSON.parse(String(init?.body)) as unknown
      modelRequests.push({ url, headers, body })
      return new Response(modelBody, { status: modelStatus })
    }
    throw new Error('unexpected test URL')
  })
  return { fetchImpl, modelRequests }
}

describe('loadConnectivityConfig', () => {
  it('allows a local git-only check without Supabase credentials', () => {
    const config = loadConnectivityConfig({
      CONNECTIVITY_COMPONENTS: 'git',
      GIT_AUTH_MODE: 'local',
    })
    expect(config.components).toEqual(['git'])
    expect(config.supabaseUrl).toBeNull()
  })

  it('automatically includes the Supabase/Vault prerequisite for model checks', () => {
    const config = loadConnectivityConfig(fullEnv({ CONNECTIVITY_COMPONENTS: 'model' }))
    expect(config.components).toEqual(['supabase', 'model'])
  })

  it('rejects missing credentials without embedding their values in the error', () => {
    expect(() => loadConnectivityConfig({
      CONNECTIVITY_COMPONENTS: 'git',
      GIT_AUTH_MODE: 'token',
      GITLAB_DEPLOY_USER: 'deploy-user',
    })).toThrowError(ConnectivityConfigError)
  })
})

describe('runConnectivityCheck', () => {
  it('checks every whitelisted repository x 3 allowed branches and sends only a minimal model ping', async () => {
    const output: string[] = []
    const expectedRepositoryUrls = REPOSITORIES.map(
      (repository) => `http://git-mock:8080${repository.path}`,
    )
    const gitRefProbe = vi.fn(async (
      repositoryUrl: string,
      _branch: 'feature_dev' | 'feature_sit' | 'release',
      args: string[],
    ) => {
      expect(expectedRepositoryUrls).toContain(repositoryUrl)
      expect(args.join(' ')).not.toContain(DEPLOY_TOKEN)
      expect(args).toHaveLength(2)
      expect(args[0]).toBe('-c')
      expect(args[1]).toMatch(/^http\.extraHeader=Authorization: Basic /)
      return SHA
    })
    const { fetchImpl, modelRequests } = successfulSupabaseFetch()

    const summary = await runConnectivityCheck({
      env: fullEnv({ GITLAB_BASE_URL: 'http://git-mock:8080' }),
      fetchImpl,
      gitRefProbe,
      writeLine: (line) => output.push(line),
    })

    expect(summary.ok).toBe(true)
    expect(summary.total).toBe(REPOSITORY_NAMES.length * ALLOWED_BRANCHES.length + 2)
    // 期望值由白名单推导：写死 12 的那一版在加第 5 个仓时会失败，而失败信息只说
    // "expected 12 got 15"，看不出该改的是清单还是断言。
    const gitProbeCount = REPOSITORY_NAMES.length * ALLOWED_BRANCHES.length
    expect(summary.by_component.git).toEqual({ total: gitProbeCount, passed: gitProbeCount, failed: 0 })
    expect(summary.by_component.supabase).toEqual({ total: 1, passed: 1, failed: 0 })
    expect(summary.by_component.model).toEqual({ total: 1, passed: 1, failed: 0 })
    expect(gitRefProbe).toHaveBeenCalledTimes(gitProbeCount)
    expect(new Set(summary.checks.filter((c) => c.component === 'git').map((c) => c.target)).size).toBe(gitProbeCount)

    expect(modelRequests).toHaveLength(1)
    expect(modelRequests[0]?.headers.get('Authorization')).toBe(`Bearer ${MODEL_KEY}`)
    expect(modelRequests[0]?.body).toEqual({
      model: 'approved-model',
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 1,
    })

    const emitted = output.join('\n')
    expect(emitted).not.toContain(SERVICE_KEY)
    expect(emitted).not.toContain(MODEL_KEY)
    expect(emitted).not.toContain(DEPLOY_TOKEN)
    expect(emitted).not.toContain('Authorization')
    expect(emitted).not.toContain('model.example.com')
    expect(emitted).not.toContain('project.supabase.co')
  })

  it('reports a missing Git branch by safe error code and continues all refs', async () => {
    const output: string[] = []
    let calls = 0
    const summary = await runConnectivityCheck({
      env: { CONNECTIVITY_COMPONENTS: 'git', GIT_AUTH_MODE: 'local' },
      gitRefProbe: vi.fn(async () => {
        calls += 1
        if (calls === 2) throw new GitError('sensitive remote error body', 'GIT_BRANCH_MISSING')
        return SHA
      }),
      writeLine: (line) => output.push(line),
    })

    expect(summary.ok).toBe(false)
    expect(summary.total).toBe(REPOSITORY_NAMES.length * ALLOWED_BRANCHES.length)
    expect(summary.failed).toBe(1)
    expect(summary.checks[1]?.error_code).toBe('GIT_BRANCH_MISSING')
    expect(output.join('\n')).not.toContain('sensitive remote error body')
  })

  it('blocks the model probe when Supabase fails and never emits its response body', async () => {
    const output: string[] = []
    const upstreamBody = 'upstream-body-containing-private-data'
    const fetchImpl = vi.fn(async (): Promise<Response> =>
      new Response(upstreamBody, { status: 401 }))

    const summary = await runConnectivityCheck({
      env: fullEnv({ CONNECTIVITY_COMPONENTS: 'supabase,model' }),
      fetchImpl,
      writeLine: (line) => output.push(line),
    })

    expect(summary.ok).toBe(false)
    expect(summary.checks).toHaveLength(2)
    expect(summary.checks[0]).toMatchObject({
      component: 'supabase',
      error_code: 'SUPABASE_HTTP_401',
      status_code: 401,
    })
    expect(summary.checks[1]).toMatchObject({
      component: 'model',
      error_code: 'MODEL_CHECK_BLOCKED_BY_SUPABASE',
    })
    const emitted = output.join('\n')
    expect(emitted).not.toContain(upstreamBody)
    expect(emitted).not.toContain(SERVICE_KEY)
  })

  it('reports model HTTP failure without logging the model response or key', async () => {
    const output: string[] = []
    const modelBody = 'model-response-containing-private-data'
    const { fetchImpl } = successfulSupabaseFetch(403, modelBody)

    const summary = await runConnectivityCheck({
      env: fullEnv({ CONNECTIVITY_COMPONENTS: 'model' }),
      fetchImpl,
      writeLine: (line) => output.push(line),
    })

    expect(summary.ok).toBe(false)
    expect(summary.checks[0]?.component).toBe('supabase')
    expect(summary.checks[1]).toMatchObject({
      component: 'model',
      error_code: 'MODEL_HTTP_403',
      status_code: 403,
    })
    const emitted = output.join('\n')
    expect(emitted).not.toContain(modelBody)
    expect(emitted).not.toContain(MODEL_KEY)
  })
})
