/**
 * 环境配置解析。
 *
 * 刻意在启动时一次性校验完：MCP 的 HTTP 通道上，配置错误表现为"工具调用时回一句模型
 * 看不懂的话"，而不是进程启动失败。宁可启动就拒。
 */

export const SUPPORTED_BRANCHES = ['feature_dev', 'feature_sit', 'release']
export const SUPPORTED_COMMIT_WINDOWS = [7, 14, 21, 28]

export class ConfigError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ConfigError'
  }
}

function required(env, key) {
  const value = (env[key] ?? '').trim()
  if (value === '') throw new ConfigError(`缺少必需的环境变量 ${key}`)
  return value
}

function optional(env, key, fallback = null) {
  const value = (env[key] ?? '').trim()
  return value === '' ? fallback : value
}

function integer(env, key, fallback) {
  const raw = optional(env, key)
  if (raw === null) return fallback
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isInteger(parsed)) throw new ConfigError(`${key} 必须是整数，当前是 ${raw}`)
  return parsed
}

function bool(env, key, fallback = false) {
  const raw = optional(env, key)
  if (raw === null) return fallback
  return raw.toLowerCase() === 'true' || raw === '1'
}

/**
 * 解析访问凭证清单。
 *
 * 形式是 `名字:令牌`，逗号分隔；只写令牌时名字取 `client-N`。名字只用于 stderr 日志 ——
 * 全部调用方共用同一个平台账号，日志里不记名字的话，事后无从区分是谁提交的。
 */
export function parseAccessTokens(raw) {
  const entries = []
  const chunks = String(raw ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '')
  for (const [index, chunk] of chunks.entries()) {
    const separator = chunk.indexOf(':')
    const name = separator > 0 ? chunk.slice(0, separator).trim() : `client-${index + 1}`
    const token = separator > 0 ? chunk.slice(separator + 1).trim() : chunk
    if (token.length < 16) throw new ConfigError(`访问凭证 ${name} 太短（至少 16 个字符）`)
    if (entries.some((entry) => entry.token === token)) {
      throw new ConfigError(`访问凭证重复：${name}`)
    }
    entries.push({ name, token })
  }
  return entries
}

export function loadConfig(env = process.env) {
  const transport = (optional(env, 'CRP_MCP_TRANSPORT', 'http') ?? 'http').toLowerCase()
  if (transport !== 'http' && transport !== 'stdio') {
    throw new ConfigError(`CRP_MCP_TRANSPORT 只能是 http 或 stdio，当前是 ${transport}`)
  }

  const allowAnonymous = bool(env, 'CRP_MCP_ALLOW_NO_AUTH', false)
  const tokens = parseAccessTokens(optional(env, 'CRP_MCP_TOKENS'))
  if (transport === 'http' && tokens.length === 0 && !allowAnonymous) {
    throw new ConfigError(
      'HTTP 模式必须配置 CRP_MCP_TOKENS（形如 "张三:至少16位随机串,李四:另一串"）。' +
        '确实要开放无鉴权端点时必须显式设置 CRP_MCP_ALLOW_NO_AUTH=true。',
    )
  }

  const platformWebUrl = required(env, 'CRP_PLATFORM_WEB_URL').replace(/\/+$/, '')

  return {
    transport,
    http: {
      host: optional(env, 'CRP_MCP_HOST', '0.0.0.0'),
      port: integer(env, 'CRP_MCP_PORT', 8848),
      path: optional(env, 'CRP_MCP_PATH', '/mcp'),
      tokens,
      allowAnonymous,
    },
    platform: {
      url: required(env, 'CRP_SUPABASE_URL').replace(/\/+$/, ''),
      anonKey: required(env, 'CRP_SUPABASE_ANON_KEY'),
      email: required(env, 'CRP_EMAIL'),
      password: required(env, 'CRP_PASSWORD'),
      webUrl: platformWebUrl,
      /**
       * 单次平台请求超时。
       *
       * 必须有上限：一次挂住的连接会让工具调用永远不返回，客户端那边表现为"卡住"。
       * 超时按"结果不明"处理（见 platform.mjs），不会误删可能已受理的批次。
       */
      timeoutMs: integer(env, 'CRP_PLATFORM_TIMEOUT_MS', 30_000),
    },
    defaults: {
      /** 服务端配置好的默认模型（展示名或 id）。留空时平台只有一个可用模型才能自动确定。 */
      modelLabel: optional(env, 'CRP_DEFAULT_MODEL'),
      batchNamePrefix: optional(env, 'CRP_BATCH_NAME_PREFIX', 'MCP 评审'),
    },
  }
}
