/**
 * Worker environment validation.
 * Model route and credentials are resolved per job from the database and Vault.
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
  /** 独立模型连接测试队列租约，不占用故事任务槽位。 */
  modelConnectivityTestLeaseSeconds: number
  /**
   * 模型请求的 Mac 宿主机代理。
   *
   * 只作用于模型端点：公司内网模型只能经宿主机的公司网络/VPN 访问，而 Docker 拿不到那条
   * 路由。刻意不设全局 HTTP(S)_PROXY —— 那会把 Supabase 与 GitLab 一起改道。
   * null 表示直连（公网模型）。
   */
  modelConnectivityProxy: {
    url: string
    username: string | null
    password: string | null
  } | null
  /** Per-attempt Harness profile trees live here. */
  agentAttemptsRoot: string
  /**
   * 共享只读 Skill Cache 的根目录（V1.6）。
   *
   * 必须是**命名卷**，与 attempt 临时目录分开：cache 的价值全部来自跨 attempt、跨
   * Job 复用，放在 attempt 树里等于每次都重新下载全部技能包。
   */
  skillCacheRoot: string
  /**
   * Skill Cache 的容量上限，超过即按最后访问时间从旧到新回收。
   *
   * 与 Session 卷不同，这里的回收是**无损**的：cache 里的每一个 bundle 都能按冻结
   * locator 重新下载。所以上限可以设得比较紧，宁可多下载一次也不要让卷满。
   */
  skillCacheMaxBytes: number
  /**
   * 模型端点是否接受图片输入（V1.6）。
   *
   * 决定 attempt patch 给路由声明的模态。默认 **false**，也就是只声明 `text`：
   *
   *   * 不声明 image 时，`read_image` 在图片发出去**之前**就被拒，错误可读；
   *   * 声明了但模型其实不支持时，图片会被发给一个处理不了它的 provider —— 那是一次
   *     可能拖垮整个 attempt 的上游错误。
   *
   * 两个错误的代价不一样，所以默认取保守的那个，由运维在确认端点真的接受图片后打开。
   * 关掉时技能包里的 `assets/*.png` 仍然可以发布（它们对人和脚本仍有价值），只是模型
   * 读不到 —— 这一点写在 OPERATIONS §17.10 里，不让它成为一个需要现场猜的行为。
   */
  modelImageInputEnabled: boolean
  /**
   * Session JSONL 的持久卷根目录。
   *
   * 必须与 attempt 临时目录分开：attempt 结束会删掉自己的树，而恢复恰恰需要 Session 活过
   * 那次删除。放在同一个目录下等于"支持恢复"这句话不成立。
   */
  sessionRoot: string
  /** 卷级 Session 回收的保留期（天）。可由 AGENT_SESSION_RETENTION_DAYS 覆盖。 */
  sessionRetentionDays: number
  /** Session 卷的容量上限，超过即按最旧优先回收并告警。 */
  sessionVolumeMaxBytes: number
  /** 孤儿 Workspace 的最大存活时长。 */
  orphanWorkspaceMaxAgeMs: number
  /**
   * 运行监控事件上报（方案 §7.9）。
   *
   * `enabled = false` 时 Worker 完全不上报，现有分析流程不受任何影响 —— 这是三级停写
   * 手段里的第二级（第一级是前端不访问 /monitoring，第三级是数据库 revoke execute）。
   */
  runtimeEvents: {
    enabled: boolean
    /** 定时 flush 间隔（毫秒）。同时是 §7.3 工具折叠的窗口。 */
    flushMs: number
    /** 单 Attempt 队列上限。溢出按优先级丢弃并计数。 */
    queueMax: number
    /** 单批最大事件数。 */
    batchMax: number
    /** 事件保留天数。与数据库 retention_until 默认值保持一致。 */
    retentionDays: number
  }
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

export type Env = Record<string, string | undefined>

function requireStr(env: Env, key: string): string {
  const value = env[key]
  if (value === undefined || value.trim() === '') {
    throw new ConfigError(`missing required environment variable: ${key}`)
  }
  return value.trim()
}

function optStr(env: Env, key: string, fallback: string | null = null): string | null {
  const value = env[key]
  return value === undefined || value.trim() === '' ? fallback : value.trim()
}

function intInRange(env: Env, key: string, fallback: number, min: number, max: number): number {
  const raw = env[key]
  if (raw === undefined || raw.trim() === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value)) {
    throw new ConfigError(`environment variable ${key} must be an integer, got: ${raw}`)
  }
  if (value < min || value > max) {
    throw new ConfigError(
      `environment variable ${key} must be between ${min} and ${max}, got: ${value}`,
    )
  }
  return value
}

/**
 * 布尔开关。只接受明确的真假值：一个拼错的 `RUNTIME_EVENTS_ENABLED=ture` 必须报错，
 * 而不是被当成 false 静默关掉监控。
 */
function boolFlag(env: Env, key: string, fallback: boolean): boolean {
  const raw = env[key]
  if (raw === undefined || raw.trim() === '') return fallback
  const value = raw.trim().toLowerCase()
  if (value === 'true' || value === '1' || value === 'yes') return true
  if (value === 'false' || value === '0' || value === 'no') return false
  throw new ConfigError(
    `environment variable ${key} must be true or false, got: ${raw}`,
  )
}

function validUrl(value: string, key: string): string {  try {
    new URL(value)
  } catch {
    throw new ConfigError(`environment variable ${key} must be a valid URL: ${value}`)
  }
  return value
}

/**
 * 模型代理地址。
 *
 * 只接受 http/https origin：带 path/query/hash 的值说明配置者以为这里能写完整端点，
 * 而 URL 里内嵌凭据会把口令带进任何打印了配置的地方，两者都必须直接报错而不是"尽力解析"。
 */
function validModelProxyUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new ConfigError(
      'environment variable MODEL_CONNECTIVITY_PROXY_URL must be a valid URL',
    )
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ConfigError('MODEL_CONNECTIVITY_PROXY_URL must use http or https')
  }
  if (url.username !== '' || url.password !== '') {
    throw new ConfigError(
      'MODEL_CONNECTIVITY_PROXY_URL must not embed credentials; use MODEL_CONNECTIVITY_PROXY_USERNAME/PASSWORD',
    )
  }
  if ((url.pathname !== '' && url.pathname !== '/') || url.search !== '' || url.hash !== '') {
    throw new ConfigError(
      'MODEL_CONNECTIVITY_PROXY_URL must be an origin without path, query or hash',
    )
  }
  return `${url.protocol}//${url.host}`
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

  if (gitAuthMode === 'token' && (!gitlabDeployUser || !gitlabDeployToken)) {
    throw new ConfigError(
      'GIT_AUTH_MODE=token requires GITLAB_DEPLOY_USER and GITLAB_DEPLOY_TOKEN',
    )
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

  const modelConnectivityTestLeaseSeconds = intInRange(
    env,
    'MODEL_CONNECTIVITY_TEST_LEASE_SECONDS',
    90,
    45,
    600,
  )

  const rawProxyUrl = optStr(env, 'MODEL_CONNECTIVITY_PROXY_URL')
  const proxyUsername = optStr(env, 'MODEL_CONNECTIVITY_PROXY_USERNAME')
  const proxyPassword = optStr(env, 'MODEL_CONNECTIVITY_PROXY_PASSWORD')
  if (rawProxyUrl === null && (proxyUsername !== null || proxyPassword !== null)) {
    throw new ConfigError(
      'MODEL_CONNECTIVITY_PROXY_USERNAME/PASSWORD require MODEL_CONNECTIVITY_PROXY_URL',
    )
  }
  // 认证是二元的：只配一半会在运行时变成 407，那种失败看起来像"模型不可用"。
  if (rawProxyUrl !== null && (proxyUsername === null) !== (proxyPassword === null)) {
    throw new ConfigError(
      'MODEL_CONNECTIVITY_PROXY_USERNAME and MODEL_CONNECTIVITY_PROXY_PASSWORD must be set together',
    )
  }
  const modelConnectivityProxy = rawProxyUrl === null
    ? null
    : {
        url: validModelProxyUrl(rawProxyUrl),
        username: proxyUsername,
        password: proxyPassword,
      }

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
    modelConnectivityTestLeaseSeconds,
    modelConnectivityProxy,
    agentAttemptsRoot: optStr(env, 'AGENT_ATTEMPTS_ROOT', '/workspace/agent-attempts')!,
    skillCacheRoot: optStr(env, 'SKILL_CACHE_ROOT', '/workspace/skill-cache')!,
    modelImageInputEnabled: boolFlag(env, 'MODEL_IMAGE_INPUT_ENABLED', false),
    skillCacheMaxBytes: intInRange(
      env,
      'SKILL_CACHE_MAX_BYTES',
      // 4 GiB。全目录展开上限是 256 MiB，所以这个值大约能同时留住 16 代不同的技能目录；
      // 回收是无损的（可重新下载），所以不需要留更多。
      4 * 1024 * 1024 * 1024,
      256 * 1024 * 1024,
      1024 * 1024 * 1024 * 1024,
    ),
    sessionRoot: optStr(env, 'AGENT_SESSION_ROOT', '/workspace/agent-sessions')!,
    sessionVolumeMaxBytes: intInRange(
      env,
      'AGENT_SESSION_VOLUME_MAX_BYTES',
      // 20 GiB。Session 日志带源码，容量必须有上限，否则一次任务洪峰就能填满卷，
      // 而卷满会让所有在跑的 attempt 一起失败。
      20 * 1024 * 1024 * 1024,
      64 * 1024 * 1024,
      4 * 1024 * 1024 * 1024 * 1024,
    ),
    // 卷级回收的保留期。默认与 §4 policy 的 session.retentionDays 一致，但必须可运维覆盖：
    // 回收是跨所有 Job 的卷级动作，不能由某一个 Job 的冻结 policy 决定。
    sessionRetentionDays: intInRange(env, 'AGENT_SESSION_RETENTION_DAYS', 7, 1, 365),
    orphanWorkspaceMaxAgeMs: intInRange(
      env,
      'ORPHAN_WORKSPACE_MAX_AGE_MS',
      6 * 60 * 60 * 1000,
      60 * 1000,
      7 * 24 * 60 * 60 * 1000,
    ),
    runtimeEvents: {
      enabled: boolFlag(env, 'RUNTIME_EVENTS_ENABLED', true),
      // 800ms 默认值来自方案 §7.1：必须 ≤1 秒，否则"正在调用"来不及被看见。
      flushMs: intInRange(env, 'RUNTIME_EVENT_FLUSH_MS', 800, 50, 10000),
      queueMax: intInRange(env, 'RUNTIME_EVENT_QUEUE_MAX', 512, 32, 20000),
      batchMax: intInRange(env, 'RUNTIME_EVENT_BATCH_MAX', 64, 1, 500),
      retentionDays: intInRange(env, 'RUNTIME_EVENT_RETENTION_DAYS', 30, 1, 365),
    },
  }
}
