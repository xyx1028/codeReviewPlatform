/**
 * Web 出口策略：模型可见 `web_search` / `web_fetch`，但每一次真实请求都由平台代发。
 *
 * "模型可以调用 Web 工具"和"模型可以访问任意网络"是两件事。V4 让前者默认开启，后者从不
 * 成立：Harness 侧的 web provider 被换成平台插件，插件把请求交给 Broker，Broker 走这里。
 *
 * 这个模块负责三件 url-validator 做不到的事：
 *
 *   1. **解析后复查**：域名过了白名单，解析出来的 IP 仍然可能指向内网。DNS rebinding 的
 *      整个攻击面就在"校验时解析"和"连接时解析"之间的那个窗口里。这里把解析结果 pin 住，
 *      并且用 pin 到的 IP 直连、通过 Host 头保留 TLS SNI 与证书校验。
 *   2. **每次 redirect 重新校验**：允许的域名 302 到 `169.254.169.254` 是最省事的绕过。
 *   3. **配额**：请求数、单响应字节、总字节、超时，全部按 attempt 计。
 *
 * 审计只记 origin + path、状态码和字节数。query、fragment 和网页正文一律不记 —— 前者可能
 * 带凭据，后者是不可信数据。
 */

import { lookup } from 'node:dns/promises'
import { request as httpsRequest } from 'node:https'
import { request as httpRequest } from 'node:http'
import type { Logger } from '../../logger.js'
import { V4_ERROR_CODES, V4GovernanceError } from '../policy/v4-errors.js'
import type { V4WebPolicy } from '../policy/v4-capability-policy.js'
import { isBlockedAddress, validateEgressUrl, type ValidatedUrl } from './url-validator.js'

export interface EgressFetchInput {
  url: string
  kind: 'fetch' | 'search'
  agentId: string
}

export interface EgressFetchResult {
  accepted: true
  status: number
  contentType: string | null
  /** 响应正文。调用方必须把它当作不可信数据，绝不能当指令。 */
  body: string
  bytes: number
  truncated: boolean
  /** 最终 URL 的 origin + path，供模型判断自己拿到了什么。 */
  finalUrl: string
  /** 明确告知模型：这是外部内容，不是平台指令。 */
  untrusted: true
}

export interface EgressCounters {
  requests: number
  bytes: number
  denied: number
}

/** 允许的响应 MIME 前缀。二进制没有意义，且会把预算烧在 base64 上。 */
const ALLOWED_MIME_PREFIXES = [
  'text/',
  'application/json',
  'application/xml',
  'application/xhtml+xml',
  'application/rss+xml',
  'application/atom+xml',
  'application/javascript',
]

export interface EgressPolicyOptions {
  policy: V4WebPolicy
  logger: Logger
  /** 平台自有基础设施主机名，任何情况下不可达。 */
  blockedHosts: readonly string[]
  /** 注入以便单测：默认使用真实 DNS 与 HTTPS。 */
  resolve?(hostname: string): Promise<string[]>
  transport?(input: {
    url: ValidatedUrl
    address: string
    timeoutMs: number
    maxBytes: number
  }): Promise<RawEgressResponse>
}

export interface RawEgressResponse {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: string
  bytes: number
  truncated: boolean
}

export class EgressPolicy {
  private readonly tally: EgressCounters = { requests: 0, bytes: 0, denied: 0 }
  /**
   * 已分配给在途响应、尚未按实际字节结算的额度。Node 是单线程的，因此同步修改这个值
   * 就是 attempt 内的原子 reservation；并行 Tool 不会同时看到同一份剩余额度。
   */
  private bytesReserved = 0

  constructor(private readonly options: EgressPolicyOptions) {}

  counters(): EgressCounters {
    return { ...this.tally }
  }

  /**
   * 代发一次请求。
   *
   * 配额先扣、再校验、再解析、再连接。先扣配额是刻意的：被拒绝的请求同样占用一次配额，
   * 否则模型可以用无限次"被拒绝的尝试"来做 URL 探测。
   */
  async fetch(input: EgressFetchInput): Promise<EgressFetchResult> {
    if (this.tally.requests >= this.options.policy.maxRequestsPerAttempt) {
      this.tally.denied++
      throw new V4GovernanceError(
        V4_ERROR_CODES.TOOL_BUDGET_EXHAUSTED,
        `web request budget exhausted for this attempt (limit ${this.options.policy.maxRequestsPerAttempt})`,
        true,
      )
    }
    if (this.tally.bytes + this.bytesReserved >= this.options.policy.maxTotalBytes) {
      this.tally.denied++
      throw new V4GovernanceError(
        V4_ERROR_CODES.TOOL_BUDGET_EXHAUSTED,
        'web byte budget exhausted for this attempt',
        true,
      )
    }
    this.tally.requests++

    let current = validateEgressUrl({
      url: input.url,
      policy: this.options.policy,
      blockedHosts: this.options.blockedHosts,
    })

    let hops = 0
    for (;;) {
      const address = await this.resolvePinned(current)
      const reservation = this.reserveByteBudget()
      let raw: RawEgressResponse
      try {
        raw = await this.send(current, address, reservation)
      } catch (err) {
        this.bytesReserved -= reservation
        throw err
      }
      // 每一跳都立即结算，包括 redirect 和最终被 MIME 策略拒绝的响应。网络已经读取的
      // 字节必须消耗预算，不能因为正文没有返回给模型就被忽略。
      this.commitByteReservation(reservation, raw.bytes)

      const location = headerOf(raw.headers, 'location')
      const isRedirect = raw.status >= 300 && raw.status < 400 && location !== null
      if (isRedirect) {
        if (hops >= this.options.policy.maxRedirects) {
          this.tally.denied++
          throw new V4GovernanceError(
            V4_ERROR_CODES.WEB_EGRESS_DENIED,
            `too many redirects (limit ${this.options.policy.maxRedirects})`,
            true,
          )
        }
        hops++
        // 每一跳都重新走完整校验链。只检查第一跳等于没有检查。
        const next = new URL(location, current.href).toString()
        current = validateEgressUrl({
          url: next,
          policy: this.options.policy,
          blockedHosts: this.options.blockedHosts,
        })
        this.options.logger.info('web_egress_redirect', {
          event: 'web_egress_redirect',
          agent_id: input.agentId,
          hop: hops,
          // 只记 origin + path。
          to: current.auditPath,
        })
        continue
      }

      const contentType = headerOf(raw.headers, 'content-type')
      if (contentType !== null && !isAllowedMime(contentType)) {
        this.tally.denied++
        throw new V4GovernanceError(
          V4_ERROR_CODES.WEB_EGRESS_DENIED,
          `response content type ${contentType.split(';')[0]} is not readable as text`,
          true,
        )
      }

      this.options.logger.info('web_egress_completed', {
        event: 'web_egress_completed',
        agent_id: input.agentId,
        kind: input.kind,
        // URL 只记 origin + path；query 与 fragment 已被丢弃。
        url: current.auditPath,
        status: raw.status,
        bytes: raw.bytes,
        truncated: raw.truncated,
        redirects: hops,
      })

      return {
        accepted: true,
        status: raw.status,
        contentType: contentType === null ? null : contentType.split(';')[0]!.trim(),
        body: raw.body,
        bytes: raw.bytes,
        truncated: raw.truncated,
        finalUrl: current.auditPath,
        untrusted: true,
      }
    }
  }

  /**
   * 解析域名并 pin 一个地址。
   *
   * 解析结果里只要有一个属于内网就整体拒绝，而不是"挑一个公网的用"。DNS 返回混合结果
   * 本身就说明这个域名不可信。
   */
  private async resolvePinned(url: ValidatedUrl): Promise<string> {
    const resolver = this.options.resolve ?? defaultResolve
    let addresses: string[]
    try {
      addresses = await resolver(url.hostname)
    } catch {
      this.tally.denied++
      throw new V4GovernanceError(
        V4_ERROR_CODES.WEB_EGRESS_DENIED,
        'the destination host could not be resolved',
        true,
      )
    }
    if (addresses.length === 0) {
      this.tally.denied++
      throw new V4GovernanceError(
        V4_ERROR_CODES.WEB_EGRESS_DENIED,
        'the destination host resolved to no address',
        true,
      )
    }
    if (this.options.policy.denyPrivateNetworks) {
      const blocked = addresses.filter((address) => isBlockedAddress(address))
      if (blocked.length > 0) {
        this.tally.denied++
        throw new V4GovernanceError(
          V4_ERROR_CODES.WEB_EGRESS_DENIED,
          // 不回显解析到的 IP：那本身就是内网拓扑信息。
          'the destination resolves to a non-public address',
          true,
        )
      }
    }
    return addresses[0]!
  }

  private reserveByteBudget(): number {
    const remaining =
      this.options.policy.maxTotalBytes - this.tally.bytes - this.bytesReserved
    if (remaining <= 0) {
      this.tally.denied++
      throw new V4GovernanceError(
        V4_ERROR_CODES.TOOL_BUDGET_EXHAUSTED,
        'web byte budget exhausted for this attempt',
        true,
      )
    }
    const reservation = Math.min(this.options.policy.maxResponseBytes, remaining)
    this.bytesReserved += reservation
    return reservation
  }

  private commitByteReservation(reservation: number, actualBytes: number): void {
    this.bytesReserved -= reservation
    if (
      !Number.isSafeInteger(actualBytes) ||
      actualBytes < 0 ||
      actualBytes > reservation
    ) {
      // 默认 transport 永远遵守 maxBytes。自定义 provider 若违约则立即耗尽已分配额度并
      // fail closed，避免一个错误的 provider 破坏 attempt 级 hard cap。
      this.tally.bytes += reservation
      this.tally.denied++
      throw new V4GovernanceError(
        V4_ERROR_CODES.TOOL_BUDGET_EXHAUSTED,
        'web transport exceeded its reserved byte budget',
        true,
      )
    }
    this.tally.bytes += actualBytes
  }

  private send(url: ValidatedUrl, address: string, maxBytes: number): Promise<RawEgressResponse> {
    const transport = this.options.transport ?? defaultTransport
    return transport({
      url,
      address,
      timeoutMs: this.options.policy.requestTimeoutMs,
      maxBytes,
    })
  }
}

function headerOf(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | null {
  const raw = headers[name] ?? headers[name.toLowerCase()]
  if (raw === undefined) return null
  return Array.isArray(raw) ? (raw[0] ?? null) : raw
}

function isAllowedMime(contentType: string): boolean {
  const mime = contentType.split(';')[0]!.trim().toLowerCase()
  return ALLOWED_MIME_PREFIXES.some((prefix) => mime.startsWith(prefix))
}

async function defaultResolve(hostname: string): Promise<string[]> {
  const records = await lookup(hostname, { all: true, verbatim: true })
  return records.map((record) => record.address)
}

/**
 * 用 pin 到的 IP 直连，同时保留 Host 头和 TLS servername。
 *
 * 这是消除 rebinding 窗口的关键：如果这里再用主机名连接，操作系统会重新解析一次，
 * 上面校验过的地址就白校验了。
 */
function defaultTransport(input: {
  url: ValidatedUrl
  address: string
  timeoutMs: number
  maxBytes: number
}): Promise<RawEgressResponse> {
  const isHttps = input.url.href.startsWith('https:')
  const send = isHttps ? httpsRequest : httpRequest
  const parsed = new URL(input.url.href)

  return new Promise<RawEgressResponse>((resolve, reject) => {
    const req = send(
      {
        host: input.address,
        port: input.url.port,
        path: `${parsed.pathname}${parsed.search}`,
        method: 'GET',
        // TLS 证书仍然按域名校验；只是连接目标固定成已核准的 IP。
        servername: isHttps ? input.url.hostname : undefined,
        headers: {
          host: input.url.hostname,
          accept: 'text/html,application/json;q=0.9,text/plain;q=0.8,*/*;q=0.1',
          'accept-encoding': 'identity',
          'user-agent': 'code-review-platform-v4-egress',
        },
        // 重定向由上层逐跳校验，传输层不自动跟随。
      } as never,
      (res) => {
        const chunks: Buffer[] = []
        let bytes = 0
        let truncated = false
        res.on('data', (chunk: Buffer) => {
          if (truncated) return
          bytes += chunk.byteLength
          if (bytes > input.maxBytes) {
            truncated = true
            chunks.push(chunk.subarray(0, Math.max(input.maxBytes - (bytes - chunk.byteLength), 0)))
            res.destroy()
            return
          }
          chunks.push(chunk)
        })
        res.on('close', () => {
          const body = Buffer.concat(chunks).toString('utf8')
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers as Record<string, string | string[] | undefined>,
            body,
            bytes: Buffer.byteLength(body),
            truncated,
          })
        })
        res.on('error', reject)
      },
    )
    req.setTimeout(input.timeoutMs, () => {
      req.destroy(
        new V4GovernanceError(
          V4_ERROR_CODES.WEB_EGRESS_DENIED,
          `the destination did not respond within ${input.timeoutMs}ms`,
          true,
        ),
      )
    })
    req.on('error', (err) => reject(err))
    req.end()
  })
}

/**
 * 平台自有基础设施主机名。
 *
 * 从实际配置里推导，而不是硬编码一份清单：Supabase URL、GitLab base URL 都是运行时配置，
 * 写死会在换环境后静默失效。
 */
export function platformBlockedHosts(input: {
  supabaseUrl?: string
  gitlabBaseUrl?: string
  extra?: readonly string[]
}): string[] {
  const hosts = new Set<string>()
  for (const candidate of [input.supabaseUrl, input.gitlabBaseUrl]) {
    if (candidate === undefined || candidate.trim() === '') continue
    try {
      hosts.add(new URL(candidate).hostname.toLowerCase())
    } catch {
      // 配置本身不合法时不静默吞掉：调用方的配置校验会先报出来。
    }
  }
  for (const extra of input.extra ?? []) {
    const trimmed = extra.trim().toLowerCase()
    if (trimmed.length > 0) hosts.add(trimmed)
  }
  // 云厂商 metadata 端点的常见域名形态。IP 形态由 url-validator 的网段判定覆盖。
  hosts.add('metadata.google.internal')
  hosts.add('metadata.goog')
  return [...hosts].sort()
}
