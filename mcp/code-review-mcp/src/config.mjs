/**
 * 环境配置解析。
 *
 * 刻意在启动时一次性校验完：MCP 的 HTTP 通道上，配置错误表现为"工具调用时回一句模型
 * 看不懂的话"，而不是进程启动失败。宁可启动就拒。
 */

export const SUPPORTED_BRANCHES = ['feature_dev', 'feature_sit', 'release']
export const SUPPORTED_COMMIT_WINDOWS = [7, 14, 21, 28]
/** 平台使用者所在时区。发布周期编码按它生成，必须与批次列表里的「创建时间」对得上。 */
export const DEFAULT_TIME_ZONE = 'Asia/Shanghai'
/** 公司 Linky 取数接口。与 Worker 的 LINKY_API_BASE_URL 默认值保持一致。 */
export const DEFAULT_LINKY_BASE_URL =
  'https://feature.kingdee.com:2055/quality-platform/api/linky'

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

/**
 * 校验时区名。
 *
 * 启动时就拒：一个拼错的时区（`Asia/Shanghia`）在运行时表现为 `Intl` 抛错，而那发生在
 * 一次真实提交的中途 —— 批次已经建了一半。
 */
export function resolveTimeZone(raw) {
  const value = String(raw ?? '').trim()
  if (value === '') return DEFAULT_TIME_ZONE
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: value }).format(new Date())
  } catch {
    throw new ConfigError(
      `CRP_TIMEZONE 不是合法的 IANA 时区名：${value}（例如 Asia/Shanghai、UTC）`,
    )
  }
  return value
}

/**
 * 端点路径归一化。
 *
 * 必须有：同事在客户端里粘 `https://host/mcp/` 和 `https://host/mcp` 的概率各一半，
 * 反向代理也常把两者互相改写。两种写法指向同一个端点，差一个斜杠就 404 是纯粹的坑。
 */
export function normalizePath(raw) {
  const value = String(raw ?? '').trim()
  if (value === '' || value === '/') return '/'
  const withLeading = value.startsWith('/') ? value : `/${value}`
  return withLeading.replace(/\/+$/, '') === '' ? '/' : withLeading.replace(/\/+$/, '')
}

/**
 * 解析允许的浏览器来源。
 *
 * 只影响 CORS 响应头，不替代鉴权：这台服务的鉴权靠 `Authorization` 头而不是 cookie，
 * 所以放开 CORS 不会让别的站点"带着你的身份"调用它 —— 它拿不到凭证。默认 `*` 是为了
 * 让 IDE 内嵌的 WebView 客户端能完成预检；需要收紧时显式列出来源。
 */
export function parseAllowedOrigins(raw) {
  const chunks = String(raw ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '')
  if (chunks.length === 0) return ['*']
  return chunks.includes('*') ? ['*'] : chunks
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

  /**
   * 单次平台请求超时与"结果不明"核对预算，必须一起看。
   *
   * 远程 MCP 的调用方是别人的客户端，它有自己的超时（多数实现默认 60 秒）。一旦工具调用
   * 超过那个上限，使用者看到的是一句 "tool call failed" —— 连批次编号都没有，而平台可能
   * 已经受理了。所以最坏路径的总耗时必须压在 60 秒以内：
   *
   *   平台写操作超时 20s ＋ 核对 3 次 × 8s ＋ 间隔 2 × 2s ＝ 48s
   *
   * 下调写操作超时不会让"可能已受理"的任务被误删：超时一律归入"结果不明"，批次原样保留。
   */
  const platformTimeoutMs = integer(env, 'CRP_PLATFORM_TIMEOUT_MS', 20_000)
  const settleProbeTimeoutMs = integer(env, 'CRP_SETTLE_PROBE_TIMEOUT_MS', 8_000)
  const settleProbes = integer(env, 'CRP_SETTLE_PROBES', 3)
  const settleDelayMs = integer(env, 'CRP_SETTLE_DELAY_MS', 2_000)
  for (const [key, value] of [
    ['CRP_PLATFORM_TIMEOUT_MS', platformTimeoutMs],
    ['CRP_SETTLE_PROBE_TIMEOUT_MS', settleProbeTimeoutMs],
    ['CRP_SETTLE_DELAY_MS', settleDelayMs],
  ]) {
    if (value <= 0) throw new ConfigError(`${key} 必须大于 0，当前是 ${value}`)
  }
  if (settleProbes < 1) throw new ConfigError(`CRP_SETTLE_PROBES 至少为 1，当前是 ${settleProbes}`)

  const sessionTtlMs = integer(env, 'CRP_MCP_SESSION_TTL_MS', 30 * 60_000)
  if (sessionTtlMs < 60_000) {
    throw new ConfigError(`CRP_MCP_SESSION_TTL_MS 至少 60000（1 分钟），当前是 ${sessionTtlMs}`)
  }
  const maxSessions = integer(env, 'CRP_MCP_MAX_SESSIONS', 256)
  if (maxSessions < 1) throw new ConfigError(`CRP_MCP_MAX_SESSIONS 至少为 1，当前是 ${maxSessions}`)

  /**
   * 提交前校验用的 Linky 取数地址。
   *
   * 未设置时取公司默认地址（与 Worker 的 `LINKY_API_BASE_URL` 同一个），显式设成空字符串
   * 才关闭校验。默认开启是刻意的：这项校验存在的全部意义就是拦住"参数写错了还照样建批次"，
   * 而需要它的人恰好最不会去翻文档打开它。
   */
  const rawLinkyBase = env.CRP_LINKY_API_BASE_URL
  const linkyBaseUrl =
    rawLinkyBase === undefined
      ? DEFAULT_LINKY_BASE_URL
      : String(rawLinkyBase).trim() === ''
        ? null
        : String(rawLinkyBase).trim().replace(/\/+$/, '')
  if (linkyBaseUrl !== null && !/^https?:\/\//i.test(linkyBaseUrl)) {
    throw new ConfigError(`CRP_LINKY_API_BASE_URL 必须是 http(s) 地址，当前是 ${linkyBaseUrl}`)
  }

  const confirmTtlMs = integer(env, 'CRP_CONFIRM_TTL_MS', 15 * 60_000)
  if (confirmTtlMs < 60_000) {
    throw new ConfigError(`CRP_CONFIRM_TTL_MS 至少 60000（1 分钟），当前是 ${confirmTtlMs}`)
  }

  return {
    transport,
    http: {
      host: optional(env, 'CRP_MCP_HOST', '0.0.0.0'),
      port: integer(env, 'CRP_MCP_PORT', 8848),
      path: normalizePath(optional(env, 'CRP_MCP_PATH', '/mcp')),
      tokens,
      allowAnonymous,
      allowedOrigins: parseAllowedOrigins(optional(env, 'CRP_MCP_ALLOWED_ORIGINS')),
      /**
       * 空闲会话回收。
       *
       * 必须有：Streamable HTTP 的会话只在客户端显式发 `DELETE` 时才关闭，而 Codex /
       * Claude Code / Qoder 这类客户端进程退出时通常直接走掉。不回收的话，一个常驻服务
       * 会按"客户端启动次数"无上限地堆积 transport 与 Server 实例。
       */
      sessionTtlMs,
      maxSessions,
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
      timeoutMs: platformTimeoutMs,
    },
    settle: {
      settleProbes,
      settleDelayMs,
      probeTimeoutMs: settleProbeTimeoutMs,
    },
    /**
     * 提交前校验。
     *
     * `CRP_LINKY_API_BASE_URL` 显式设成空字符串即关闭校验（MCP 部署在取不到 Linky 的
     * 地方时的退路）。关闭后提交仍然要走确认步骤，只是卡片上会写明"没核对过"——
     * 少一道校验可以接受，静默提交一个注定失败的批次不可以。
     */
    linky: {
      baseUrl: linkyBaseUrl,
      timeoutMs: integer(env, 'CRP_LINKY_TIMEOUT_MS', 8_000),
    },
    confirm: {
      ttlMs: confirmTtlMs,
      /** 多实例部署必须显式配置，否则 A 实例签的令牌到 B 实例会被拒。 */
      secret: optional(env, 'CRP_CONFIRM_SECRET'),
    },
    defaults: {
      /** 服务端配置好的默认模型（展示名或 id）。留空时平台只有一个可用模型才能自动确定。 */
      modelLabel: optional(env, 'CRP_DEFAULT_MODEL'),
      batchNamePrefix: optional(env, 'CRP_BATCH_NAME_PREFIX', 'MCP 评审'),
      /**
       * 生成发布周期编码用的时区。
       *
       * 必须显式配置而不是用容器本地时间：MCP 容器通常是 UTC，而批次列表里的「创建时间」
       * 按使用者时区渲染，两者不一致时发布周期编码会比创建时间差几个小时，
       * 北京时间 08:00 之前提交还会整体错一天。
       */
      timeZone: resolveTimeZone(optional(env, 'CRP_TIMEZONE', DEFAULT_TIME_ZONE)),
    },
  }
}
