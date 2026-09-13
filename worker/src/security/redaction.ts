/**
 * Redaction utilities for logs and error messages. (Plan §18, §15.3, V4 §7.11)
 *
 * Never log: model API keys, Supabase service role key, Git tokens,
 * Authorization headers (Bearer AND Basic), or large source code blocks.
 *
 * V4 additions:
 *  - Agent capability tokens (`randomBytes(32).toString('base64url')`, a long
 *    base64url string) minted by the AgentAuthorityLedger and carried on Broker
 *    requests. They must never reach a log line.
 *  - Web URL query and fragment: only `origin + path` may be audited, matching
 *    the egress policy's own `auditPath`. Query/fragment can carry secrets or
 *    the requested content.
 *  - Session JSONL content: session logs contain real source code and prompts.
 *    Only locator/hash/counters are auditable, never the transcript body.
 *  - Storage locator host paths: the absolute on-disk path of a session/artifact
 *    reveals the session root layout; only the basename is kept.
 */

const REDACTED = '[REDACTED]'

/**
 * Sensitive key SUBSTRINGS. A key is masked when its lowercased name contains
 * any of these fragments, so variants like `gitlab_deploy_token`,
 * `x-api-key`, `apiKeySecretId`, `serviceRoleKey` are all caught without an
 * exhaustive list.
 */
const SENSITIVE_KEY_SUBSTRINGS = [
  'authorization',
  'apikey',
  'secret',
  'token',
  'password',
  'passwd',
  'credential',
  'privatekey',
  'servicerole',
  'rolekey',
  // V4: agent capability tokens carried on Broker requests. Covers
  // `capabilityToken`, `rootCapabilityToken`, `agentCapability`,
  // `parentCapability`, `capability_token`.
  'capability',
  // V4: session transcript bodies (JSONL). Covers `sessionContent`,
  // `session_jsonl`, `sessionTranscript`, `jsonlContent`, `transcript`.
  'sessioncontent',
  'sessionjsonl',
  'sessiontranscript',
  'jsonlcontent',
  'transcript',
  // V4: raw prompt / requirement / tool result bodies must never be logged.
  'promptbody',
  'requirementtext',
  'toolresultbody',
  // 方案 §7.11 还明确禁止记录**源码**与**网页正文**。此前这两类没有对应条目：实测
  // `{ sourceCode: ... }` 与 `{ pageBody: ... }` 会原样写进日志。当时没有活跃泄漏点，但键名
  // 黑名单的意义恰恰是防住后加的代码 —— 缺项就等于这道防线对源码和网页正文不存在。
  //
  // 子串选得很窄，因为 `contentHash` / `responseBytes` / `requestBytes` 这些是**必须能记**的
  // 安全字段（全仓 53 处引用），不能被误伤。
  'sourcecode',
  'codecontent',
  'filecontent',
  'rangecontent',
  'codesnippet',
  'snippet',
  'pagebody',
  'pagecontent',
  'responsebody',
  'htmlbody',
  'bodytext',
]

/**
 * 名字过于通用、但值几乎必然是正文的键。按**完整键名**匹配，不做子串匹配。
 *
 * 为什么必须精确匹配：快照读取结果的字段就叫 `content`（见 SnapshotStore 的 readRange），
 * 网页抓取结果的正文字段常叫 `body`。但把 `content` 当子串会连带打掉 `contentHash` ——
 * 那是安全且必须可记的字段。`code` 刻意不在列内：`{ code: 'AGENT_IDENTITY_INVALID' }`
 * 这种错误码是排查的主要依据。
 */
const SENSITIVE_EXACT_KEYS = new Set(['content', 'body'])

/**
 * Keys whose VALUE is a filesystem storage locator (absolute host path such as
 * `/workspace/agent-sessions/<attempt>/<session>.jsonl`). The full host path
 * leaks the session-root layout, so only the basename is kept.
 */
const STORAGE_LOCATOR_KEY_SUBSTRINGS = ['storagelocator', 'locator', 'sessionpath', 'dshhome']

/**
 * Keys whose VALUE is a URL. Query and fragment are stripped so only
 * `origin + path` survives, matching the egress policy's `auditPath`.
 */
const URL_KEY_SUBSTRINGS = ['url', 'href', 'endpoint', 'uri', 'location']

/** Regex patterns that detect secrets embedded in free-form strings. */
const SECRET_PATTERNS: Array<{ re: RegExp; replace: string }> = [
  // Bearer tokens
  { re: /Bearer\s+[A-Za-z0-9._-]+/gi, replace: `Bearer ${REDACTED}` },
  // Basic auth tokens (e.g. http.extraHeader=Authorization: Basic <b64>)
  { re: /Basic\s+[A-Za-z0-9+/=._-]+/gi, replace: `Basic ${REDACTED}` },
  // Authorization header assignments
  {
    re: /(authorization["'\s:=]+)[^\s"',}]+/gi,
    replace: `$1${REDACTED}`,
  },
  // Git credentials embedded in URL: https://user:token@host
  {
    re: /(https?:\/\/)([^/\s:@]+):([^/\s@]+)@/gi,
    replace: `$1$2:${REDACTED}@`,
  },
  // sk- style API keys
  { re: /sk-[A-Za-z0-9]{8,}/g, replace: REDACTED },
  // JWT-ish tokens (three base64 segments)
  {
    re: /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
    replace: REDACTED,
  },
  // V4 agent capability tokens: randomBytes(32).toString('base64url') yields a
  // 43-char base64url string. Only mask when a capability/token label precedes
  // it, so ordinary 43-char identifiers are not clobbered.
  {
    re: /((?:capability|capability[_-]?token|agent[_-]?capability|root[_-]?capability|parent[_-]?capability)["'\s:=]+)[A-Za-z0-9_-]{32,}/gi,
    replace: `$1${REDACTED}`,
  },
]

/**
 * Strip the query and fragment from every http(s) URL in a free-form string,
 * keeping only `origin + path`. The egress policy already audits URLs as
 * `origin + pathname`; free-form log/error text must not leak more than that.
 */
function stripUrlQueryFragment(input: string): string {
  return input.replace(/https?:\/\/[^\s"'<>]+/gi, (match) => {
    try {
      const parsed = new URL(match)
      return `${parsed.origin}${parsed.pathname}`
    } catch {
      // Not a parseable URL after all; drop everything from the first ? or #.
      return match.replace(/[?#].*$/, '')
    }
  })
}

/** Redact secrets found inside an arbitrary string. */
export function redactString(input: string): string {
  let out = input
  for (const { re, replace } of SECRET_PATTERNS) {
    out = out.replace(re, replace)
  }
  // Drop URL query/fragment (and any surviving userinfo) so only origin+path
  // is ever emitted, even from free-form error text.
  out = stripUrlQueryFragment(out)
  return out
}

function normalizeKey(key: string): string {
  // Normalize separators so camelCase and snake/kebab variants match the same
  // fragments (e.g. serviceRoleKey, service_role_key, service-role-key).
  return key.toLowerCase().replace(/[_-]/g, '')
}

function isSensitiveKey(key: string): boolean {
  const lower = normalizeKey(key)
  return SENSITIVE_KEY_SUBSTRINGS.some((frag) => lower.includes(frag))
}

function isStorageLocatorKey(key: string): boolean {
  const lower = normalizeKey(key)
  return STORAGE_LOCATOR_KEY_SUBSTRINGS.some((frag) => lower.includes(frag))
}

function isUrlKey(key: string): boolean {
  const lower = normalizeKey(key)
  return URL_KEY_SUBSTRINGS.some((frag) => lower.includes(frag))
}

/**
 * Reduce an absolute storage locator to its basename so the session-root layout
 * (`/workspace/agent-sessions/<attempt>/...`) never appears in a log line.
 * Non-path values are returned unchanged after normal string redaction.
 */
function redactStorageLocator(value: string): string {
  const trimmed = value.trim()
  if (!trimmed.includes('/') && !trimmed.includes('\\')) {
    return redactString(value)
  }
  const parts = trimmed.split(/[\\/]/).filter((p) => p.length > 0)
  const base = parts.length > 0 ? parts[parts.length - 1]! : trimmed
  return `[path:${redactString(base)}]`
}

/**
 * Deep-redact an object for safe logging. Sensitive keys are fully masked and
 * every string value is scanned for embedded secrets. Handles cycles.
 */
export function redact<T>(value: T, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') {
    return redactString(value)
  }
  if (value === null || typeof value !== 'object') {
    return value
  }
  if (seen.has(value as object)) {
    return '[Circular]'
  }
  seen.add(value as object)

  if (Array.isArray(value)) {
    return value.map((v) => redact(v, seen))
  }

  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitiveKey(k) || SENSITIVE_EXACT_KEYS.has(k.toLowerCase())) {
      out[k] = REDACTED
    } else if (isStorageLocatorKey(k) && typeof v === 'string') {
      // Keep only the basename of a host path; strip the session-root layout.
      out[k] = redactStorageLocator(v)
    } else if (isUrlKey(k) && typeof v === 'string') {
      // Keep only origin+path for URL-valued fields.
      out[k] = redactString(v)
    } else {
      out[k] = redact(v, seen)
    }
  }
  return out
}

/** Redact and normalize any thrown value into a safe message string. */
export function redactError(err: unknown): string {
  if (err instanceof Error) {
    return redactString(err.message)
  }
  if (typeof err === 'string') {
    return redactString(err)
  }
  try {
    return redactString(JSON.stringify(redact(err)))
  } catch {
    return REDACTED
  }
}
