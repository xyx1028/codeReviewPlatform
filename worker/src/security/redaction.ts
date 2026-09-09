/**
 * Redaction utilities for logs and error messages. (Plan §18, §15.3)
 *
 * Never log: model API keys, Supabase service role key, Git tokens,
 * Authorization headers (Bearer AND Basic), or large source code blocks.
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
]

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
]

/** Redact secrets found inside an arbitrary string. */
export function redactString(input: string): string {
  let out = input
  for (const { re, replace } of SECRET_PATTERNS) {
    out = out.replace(re, replace)
  }
  return out
}

function isSensitiveKey(key: string): boolean {
  // Normalize separators so camelCase and snake/kebab variants match the same
  // fragments (e.g. serviceRoleKey, service_role_key, service-role-key).
  const lower = key.toLowerCase().replace(/[_-]/g, '')
  return SENSITIVE_KEY_SUBSTRINGS.some((frag) => lower.includes(frag))
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
    if (isSensitiveKey(k)) {
      out[k] = REDACTED
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
