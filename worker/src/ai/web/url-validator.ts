/**
 * Web 目的地校验。
 *
 * Harness 自带的 web-fetch 只做"公网地址"的基础检查，这不能替代生产出口策略：它不知道
 * 平台的 Supabase、Vault、GitLab 管理面和 Broker socket 在哪，也不知道哪些域名被授权。
 *
 * 这个模块只做纯判定，不发请求，所以可以对每一种绕过手法单测：
 *
 *   * scheme（只允许 https，除非显式打开 allowHttp 做本地测试）；
 *   * 端口白名单；
 *   * 域名白名单（精确匹配或 `.example.com` 后缀匹配，不做通配符前缀）；
 *   * IP 字面量直接拒绝（域名白名单对 IP 没有意义）；
 *   * 私网 / loopback / link-local / metadata / CGNAT / IPv6 特殊段；
 *   * 平台自有基础设施主机名。
 *
 * DNS rebinding 的防线不在这里 —— 域名解析出来的 IP 必须在 **每次连接前** 再校验一次，
 * 那部分在 egress-policy.ts 里，因为它需要真实解析结果。
 */

import { isIP } from 'node:net'
import { V4_ERROR_CODES, V4GovernanceError } from '../policy/v4-errors.js'
import type { V4WebPolicy } from '../policy/v4-capability-policy.js'

export interface UrlValidationInput {
  url: string
  policy: V4WebPolicy
  /** 平台自有基础设施的主机名，任何情况下都不可达。 */
  blockedHosts?: readonly string[]
}

export interface ValidatedUrl {
  href: string
  origin: string
  hostname: string
  port: number
  /** 只有 origin + path 进日志；query 和 fragment 会带上业务参数甚至凭据。 */
  auditPath: string
}

function denied(reason: string): never {
  throw new V4GovernanceError(V4_ERROR_CODES.WEB_EGRESS_DENIED, reason, true)
}

/** 私网/保留网段判定（IPv4）。 */
export function isPrivateIPv4(address: string): boolean {
  const parts = address.split('.').map((part) => Number(part))
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true // 解析不出来的东西按最危险处理
  }
  const [a, b] = parts as [number, number, number, number]
  if (a === 0) return true // 0.0.0.0/8
  if (a === 10) return true // 10/8
  if (a === 127) return true // loopback
  if (a === 169 && b === 254) return true // link-local，含 169.254.169.254 metadata
  if (a === 172 && b >= 16 && b <= 31) return true // 172.16/12
  if (a === 192 && b === 168) return true // 192.168/16
  if (a === 192 && b === 0) return true // 192.0.0/24 与 192.0.2/24
  if (a === 198 && (b === 18 || b === 19)) return true // 基准测试网段
  if (a === 198 && b === 51) return true // 198.51.100/24
  if (a === 203 && b === 0) return true // 203.0.113/24
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT 100.64/10
  if (a >= 224) return true // 组播与保留
  return false
}

/** 私网/保留判定（IPv6）。 */
export function isPrivateIPv6(address: string): boolean {
  const lower = address.toLowerCase().replace(/^\[|\]$/g, '')
  if (lower === '::' || lower === '::1') return true
  // IPv4-mapped：::ffff:169.254.169.254 是绕过 IPv4 检查的经典手法。
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower)
  if (mapped) return isPrivateIPv4(mapped[1]!)
  if (lower.startsWith('fe80')) return true // link-local
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true // unique local fc00::/7
  if (lower.startsWith('ff')) return true // 组播
  if (lower.startsWith('2001:db8')) return true // 文档网段
  if (lower.startsWith('64:ff9b')) return true // NAT64，可用于映射内网
  return false
}

/** 一个 IP 字面量是否属于被拒绝的网段。 */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return isPrivateIPv4(address)
  if (family === 6) return isPrivateIPv6(address)
  return true
}

/** 域名是否命中白名单。精确匹配，或者是白名单项的子域。 */
export function matchesAllowedDomain(
  hostname: string,
  allowedDomains: readonly string[],
): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  return allowedDomains.some((entry) => {
    const domain = entry.toLowerCase().replace(/^\.+/, '').replace(/\.$/, '')
    if (domain.length === 0) return false
    return host === domain || host.endsWith(`.${domain}`)
  })
}

/**
 * 校验一个模型提供的 URL。
 *
 * 拒绝时抛 `WEB_EGRESS_DENIED` 且消息里不回显完整 URL（query 可能含凭据），只说原因。
 */
export function validateEgressUrl(input: UrlValidationInput): ValidatedUrl {
  let parsed: URL
  try {
    parsed = new URL(input.url)
  } catch {
    denied('the destination is not a valid absolute URL')
  }

  if (parsed.username !== '' || parsed.password !== '') {
    // URL 内嵌凭据既是泄露渠道，也是 SSRF 混淆手法。
    denied('URL credentials are not allowed')
  }

  const scheme = parsed.protocol.replace(/:$/, '').toLowerCase()
  if (scheme === 'http') {
    if (!input.policy.allowHttp) {
      denied('plaintext HTTP is not allowed; use HTTPS')
    }
  } else if (scheme !== 'https') {
    denied(`scheme ${scheme} is not allowed; only HTTPS destinations are reachable`)
  }

  const port = parsed.port === '' ? (scheme === 'https' ? 443 : 80) : Number(parsed.port)
  if (!input.policy.allowedPorts.includes(port)) {
    denied(`port ${port} is not on the egress allowlist`)
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (hostname.length === 0) denied('the destination has no host')

  // IP 字面量：域名白名单无从判断它属于谁，一律拒绝。
  if (isIP(hostname) !== 0) {
    denied('numeric IP destinations are not allowed; use an allowlisted domain name')
  }
  if (input.policy.denyPrivateNetworks && isInternalHostname(hostname)) {
    denied('internal hostnames are not reachable from an attempt')
  }
  for (const blocked of input.blockedHosts ?? []) {
    const needle = blocked.toLowerCase()
    if (needle.length > 0 && (hostname === needle || hostname.endsWith(`.${needle}`))) {
      denied('platform infrastructure hostnames are not reachable from an attempt')
    }
  }
  if (input.policy.allowedDomains.length === 0) {
    denied('the web egress allowlist is empty; no destination is currently reachable')
  }
  if (!matchesAllowedDomain(hostname, input.policy.allowedDomains)) {
    denied(`${hostname} is not on the web egress allowlist`)
  }

  return {
    href: parsed.toString(),
    origin: parsed.origin,
    hostname,
    port,
    // 审计只留 origin + path。query 与 fragment 明确丢弃。
    auditPath: `${parsed.origin}${parsed.pathname}`,
  }
}

/**
 * 明显属于内网的主机名形态。
 *
 * 这不是"完整的内网清单"（那不可能），而是拦掉那些 **一定不是** 公网可解析域名的写法：
 * 没有点的裸主机名、`.local`/`.internal`/`.cluster.local` 之类的内部后缀。真正的兜底是
 * 域名白名单和解析后 IP 复查。
 */
export function isInternalHostname(hostname: string): boolean {
  if (hostname === 'localhost') return true
  if (!hostname.includes('.')) return true
  const internalSuffixes = [
    '.local',
    '.localhost',
    '.internal',
    '.intranet',
    '.lan',
    '.home',
    '.corp',
    '.svc',
    '.cluster.local',
    '.localdomain',
  ]
  return internalSuffixes.some((suffix) => hostname.endsWith(suffix))
}
