import { describe, it, expect } from 'vitest'
import { loadConfig, ConfigError, type Env } from '../config.js'

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
  it('loads defaults for a minimal valid env', () => {
    const cfg = loadConfig(baseEnv())
    expect(cfg.supabaseUrl).toBe('https://project.supabase.co')
    expect(cfg.pollIntervalMs).toBe(5000)
    expect(cfg.storyTaskLeaseSeconds).toBe(900)
    expect(cfg.workerStoryConcurrency).toBe(2)
    expect(cfg.gitAuthMode).toBe('local')
  })

  it('requires SUPABASE_URL and key', () => {
    expect(() => loadConfig(baseEnv({ SUPABASE_URL: undefined }))).toThrow(ConfigError)
    expect(() => loadConfig(baseEnv({ SUPABASE_SERVICE_ROLE_KEY: '' }))).toThrow(ConfigError)
  })

  it('requires WORKER_ID', () => {
    expect(() => loadConfig(baseEnv({ WORKER_ID: undefined }))).toThrow(/WORKER_ID/)
  })

  it('validates URL format', () => {
    expect(() => loadConfig(baseEnv({ SUPABASE_URL: 'not-a-url' }))).toThrow(/valid URL/)
  })

  it('requires deploy credentials in token mode', () => {
    expect(() => loadConfig(baseEnv({ GIT_AUTH_MODE: 'token' }))).toThrow(/token/)
    const cfg = loadConfig(
      baseEnv({ GIT_AUTH_MODE: 'token', GITLAB_DEPLOY_USER: 'u', GITLAB_DEPLOY_TOKEN: 't' }),
    )
    expect(cfg.gitAuthMode).toBe('token')
    expect(cfg.gitlabDeployToken).toBe('t')
  })

  it('rejects out-of-range integers', () => {
    expect(() => loadConfig(baseEnv({ WORKER_STORY_CONCURRENCY: '99' }))).toThrow(/between/)
    expect(() => loadConfig(baseEnv({ POLL_INTERVAL_MS: 'abc' }))).toThrow(/integer/)
  })

  it('rejects heartbeat >= lease', () => {
    expect(() =>
      loadConfig(baseEnv({ STORY_TASK_LEASE_SECONDS: '30', HEARTBEAT_INTERVAL_MS: '60000' })),
    ).toThrow(/HEARTBEAT_INTERVAL_MS/)
  })

  it('normalizes a trusted GitLab origin and rejects unsafe base URLs', () => {
    expect(loadConfig(baseEnv({ GITLAB_BASE_URL: 'http://git-mock:8080/' })).gitlabBaseUrl)
      .toBe('http://git-mock:8080')
    for (const value of [
      'ftp://git.example.com',
      'https://user:password@git.example.com',
      'https://git.example.com/other/path',
      'https://git.example.com?token=value',
    ]) {
      expect(() => loadConfig(baseEnv({ GITLAB_BASE_URL: value }))).toThrow(ConfigError)
    }
  })

  it('rejects invalid GIT_AUTH_MODE', () => {
    expect(() => loadConfig(baseEnv({ GIT_AUTH_MODE: 'ssh' }))).toThrow(/GIT_AUTH_MODE/)
  })
})
