import { describe, expect, it } from 'vitest'
import { ConfigError, loadConfig, type Env } from '../config.js'

function baseEnv(overrides: Env = {}): Env {
  return {
    SUPABASE_URL: 'https://project.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'srk-value',
    WORKER_ID: 'worker-1',
    GIT_AUTH_MODE: 'local',
    ...overrides,
  }
}

describe('loadConfig', () => {
  it('loads defaults for a minimal valid environment', () => {
    const config = loadConfig(baseEnv())

    expect(config).toMatchObject({
      supabaseUrl: 'https://project.supabase.co',
      supabaseServiceRoleKey: 'srk-value',
      gitAuthMode: 'local',
      gitlabDeployUser: null,
      gitlabDeployToken: null,
      workerId: 'worker-1',
      workspaceRoot: '/workspace/jobs',
      codeCacheRoot: '/workspace/cache',
      pollIntervalMs: 5000,
      storyTaskLeaseSeconds: 900,
      heartbeatIntervalMs: 30000,
      workerStoryConcurrency: 2,
      agentAttemptsRoot: '/workspace/agent-attempts',
    })
  })

  it('trims required strings and optional path overrides', () => {
    const config = loadConfig(
      baseEnv({
        SUPABASE_URL: '  https://project.supabase.co  ',
        SUPABASE_SERVICE_ROLE_KEY: '  secret  ',
        WORKER_ID: '  worker-trimmed  ',
        WORKSPACE_ROOT: '  /tmp/jobs  ',
        CODE_CACHE_ROOT: '  /tmp/cache  ',
      }),
    )

    expect(config.supabaseUrl).toBe('https://project.supabase.co')
    expect(config.supabaseServiceRoleKey).toBe('secret')
    expect(config.workerId).toBe('worker-trimmed')
    expect(config.workspaceRoot).toBe('/tmp/jobs')
    expect(config.codeCacheRoot).toBe('/tmp/cache')
  })

  it('requires the Supabase URL and service-role key', () => {
    expect(() => loadConfig(baseEnv({ SUPABASE_URL: undefined }))).toThrow(ConfigError)
    expect(() => loadConfig(baseEnv({ SUPABASE_SERVICE_ROLE_KEY: '  ' }))).toThrow(ConfigError)
  })

  it('requires a worker id', () => {
    expect(() => loadConfig(baseEnv({ WORKER_ID: undefined }))).toThrow(/WORKER_ID/)
  })

  it('validates the Supabase URL', () => {
    expect(() => loadConfig(baseEnv({ SUPABASE_URL: 'not-a-url' }))).toThrow(/valid URL/)
  })

  it('requires deploy credentials in token mode', () => {
    expect(() => loadConfig(baseEnv({ GIT_AUTH_MODE: 'token' }))).toThrow(/token/)

    const config = loadConfig(
      baseEnv({
        GIT_AUTH_MODE: 'token',
        GITLAB_DEPLOY_USER: ' deploy-user ',
        GITLAB_DEPLOY_TOKEN: ' deploy-token ',
      }),
    )
    expect(config.gitAuthMode).toBe('token')
    expect(config.gitlabDeployUser).toBe('deploy-user')
    expect(config.gitlabDeployToken).toBe('deploy-token')
  })

  it('rejects an unsupported git authentication mode', () => {
    expect(() => loadConfig(baseEnv({ GIT_AUTH_MODE: 'ssh' }))).toThrow(/GIT_AUTH_MODE/)
  })

  it('normalizes a trusted GitLab origin and rejects unsafe base URLs', () => {
    expect(loadConfig(baseEnv({ GITLAB_BASE_URL: 'http://git-mock:8080/' })).gitlabBaseUrl).toBe(
      'http://git-mock:8080',
    )

    for (const value of [
      'ftp://git.example.com',
      'https://user:password@git.example.com',
      'https://git.example.com/other/path',
      'https://git.example.com?token=value',
      'https://git.example.com#fragment',
    ]) {
      expect(() => loadConfig(baseEnv({ GITLAB_BASE_URL: value }))).toThrow(ConfigError)
    }
  })

  it('loads valid integer overrides', () => {
    const config = loadConfig(
      baseEnv({
        POLL_INTERVAL_MS: '750',
        STORY_TASK_LEASE_SECONDS: '120',
        HEARTBEAT_INTERVAL_MS: '5000',
        WORKER_STORY_CONCURRENCY: '4',
      }),
    )

    expect(config.pollIntervalMs).toBe(750)
    expect(config.storyTaskLeaseSeconds).toBe(120)
    expect(config.heartbeatIntervalMs).toBe(5000)
    expect(config.workerStoryConcurrency).toBe(4)
  })

  it('rejects non-integer and out-of-range numeric settings', () => {
    expect(() => loadConfig(baseEnv({ POLL_INTERVAL_MS: 'abc' }))).toThrow(/integer/)
    expect(() => loadConfig(baseEnv({ STORY_TASK_LEASE_SECONDS: '29' }))).toThrow(/between/)
    expect(() => loadConfig(baseEnv({ HEARTBEAT_INTERVAL_MS: '300001' }))).toThrow(/between/)
    expect(() => loadConfig(baseEnv({ WORKER_STORY_CONCURRENCY: '21' }))).toThrow(/between/)
  })

  it('requires the heartbeat interval to be shorter than the task lease', () => {
    expect(() =>
      loadConfig(
        baseEnv({ STORY_TASK_LEASE_SECONDS: '30', HEARTBEAT_INTERVAL_MS: '30000' }),
      ),
    ).toThrow(/HEARTBEAT_INTERVAL_MS/)
  })

  it('loads the Harness attempts root default, trimmed override, and blank fallback', () => {
    expect(loadConfig(baseEnv()).agentAttemptsRoot).toBe('/workspace/agent-attempts')
    expect(
      loadConfig(baseEnv({ AGENT_ATTEMPTS_ROOT: '  /data/attempts  ' })).agentAttemptsRoot,
    ).toBe('/data/attempts')
    expect(loadConfig(baseEnv({ AGENT_ATTEMPTS_ROOT: '  ' })).agentAttemptsRoot).toBe(
      '/workspace/agent-attempts',
    )
  })

  it('loads the V1.6 skill cache root and capacity ceiling', () => {
    // 默认必须落在 /workspace 下的命名卷上：cache 的全部价值来自跨 attempt、跨 Job 复用。
    expect(loadConfig(baseEnv()).skillCacheRoot).toBe('/workspace/skill-cache')
    expect(loadConfig(baseEnv({ SKILL_CACHE_ROOT: '  /data/skills  ' })).skillCacheRoot).toBe(
      '/data/skills',
    )
    expect(loadConfig(baseEnv()).skillCacheMaxBytes).toBe(4 * 1024 * 1024 * 1024)
    expect(
      loadConfig(baseEnv({ SKILL_CACHE_MAX_BYTES: String(512 * 1024 * 1024) })).skillCacheMaxBytes,
    ).toBe(512 * 1024 * 1024)
    // 下限存在的理由：小于全目录展开上限（256 MiB）的 cache 会让每个 attempt 必然 miss，
    // 那时 cache 只剩开销没有收益。
    expect(() => loadConfig(baseEnv({ SKILL_CACHE_MAX_BYTES: '1024' }))).toThrow(
      /SKILL_CACHE_MAX_BYTES/,
    )
  })

  it('defaults the model image-input declaration to off and rejects a typo', () => {
    // 默认必须是 false：声明了 image 而模型其实不支持，图片会被发给一个处理不了它的
    // provider —— 那比"读不到图片"严重得多。
    expect(loadConfig(baseEnv()).modelImageInputEnabled).toBe(false)
    expect(loadConfig(baseEnv({ MODEL_IMAGE_INPUT_ENABLED: 'true' })).modelImageInputEnabled).toBe(
      true,
    )
    // 一个拼错的 `ture` 必须报错，而不是被当成 false 静默关掉。
    expect(() => loadConfig(baseEnv({ MODEL_IMAGE_INPUT_ENABLED: 'ture' }))).toThrow(
      /MODEL_IMAGE_INPUT_ENABLED/,
    )
  })
})
