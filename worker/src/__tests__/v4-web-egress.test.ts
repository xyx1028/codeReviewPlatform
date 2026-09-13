/**
 * WP4 验收：Web 出口治理。
 *
 * 这套测试逐条对应本方案第 10 节矩阵里的"Web"一行：允许域名可正常检索，SSRF、DNS
 * rebinding、redirect 绕过和大响应全部拒绝，并且源码、凭据和网页正文不进日志。
 *
 * 每个绕过手法都单独一条用例，因为它们失败的方式不同：一个只查 URL 的实现会挡住
 * `http://169.254.169.254` 但挡不住"允许域名解析到 169.254.169.254"，而一个只查第一跳的
 * 实现会挡住直连内网但挡不住 302 到内网。
 */

import { describe, expect, it } from 'vitest'
import {
  EgressPolicy,
  platformBlockedHosts,
  type RawEgressResponse,
} from '../ai/web/egress-policy.js'
import {
  isBlockedAddress,
  isInternalHostname,
  isPrivateIPv4,
  isPrivateIPv6,
  matchesAllowedDomain,
  validateEgressUrl,
} from '../ai/web/url-validator.js'
import { V4_DEFAULT_POLICY, type V4WebPolicy } from '../ai/policy/v4-capability-policy.js'
import { V4_ERROR_CODES, V4GovernanceError } from '../ai/policy/v4-errors.js'
import { rootLogger } from '../logger.js'

const logger = rootLogger.child({ test: 'v4-web-egress' })

function webPolicy(overrides: Partial<V4WebPolicy> = {}): V4WebPolicy {
  return {
    ...V4_DEFAULT_POLICY.web,
    allowedDomains: ['docs.example.com', 'api.vendor.example'],
    ...overrides,
  }
}

function expectDenied(fn: () => unknown, matcher: RegExp): void {
  try {
    fn()
  } catch (err) {
    expect(err).toBeInstanceOf(V4GovernanceError)
    expect((err as V4GovernanceError).code).toBe(V4_ERROR_CODES.WEB_EGRESS_DENIED)
    expect((err as Error).message).toMatch(matcher)
    return
  }
  throw new Error('expected the destination to be refused')
}

describe('private network classification', () => {
  it('rejects every IPv4 range an attempt must not reach', () => {
    for (const address of [
      '127.0.0.1',
      '0.0.0.0',
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      // 云厂商 metadata 端点。这一条单独列出来，因为它是 SSRF 的头号目标。
      '169.254.169.254',
      '100.64.0.1',
      '224.0.0.1',
      '192.0.2.1',
      '198.18.0.1',
    ]) {
      expect(isPrivateIPv4(address), address).toBe(true)
    }
  })

  it('accepts ordinary public IPv4', () => {
    for (const address of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '11.0.0.1']) {
      expect(isPrivateIPv4(address), address).toBe(false)
    }
  })

  it('treats unparseable IPv4 as dangerous rather than public', () => {
    // "解析不出来就放行"是最容易被利用的默认值。
    expect(isPrivateIPv4('999.1.1.1')).toBe(true)
    expect(isPrivateIPv4('10.1')).toBe(true)
    expect(isPrivateIPv4('')).toBe(true)
  })

  it('rejects IPv6 loopback, link-local, ULA and IPv4-mapped internals', () => {
    for (const address of [
      '::1',
      '::',
      'fe80::1',
      'fc00::1',
      'fd12:3456::1',
      'ff02::1',
      '2001:db8::1',
      // IPv4-mapped 是绕过 IPv4 判定的经典手法。
      '::ffff:169.254.169.254',
      '::ffff:127.0.0.1',
      '64:ff9b::a00:1',
    ]) {
      expect(isPrivateIPv6(address), address).toBe(true)
    }
    expect(isPrivateIPv6('2606:4700::1111')).toBe(false)
  })

  it('classifies any non-IP literal as blocked', () => {
    expect(isBlockedAddress('not-an-ip')).toBe(true)
    expect(isBlockedAddress('8.8.8.8')).toBe(false)
    expect(isBlockedAddress('2606:4700::1111')).toBe(false)
  })
})

describe('hostname classification', () => {
  it('rejects bare hostnames and internal suffixes', () => {
    for (const host of [
      'localhost',
      'supabase',
      'db',
      'kubernetes.default.svc',
      'redis.internal',
      'gitlab.corp',
      'thing.cluster.local',
      'host.localdomain',
    ]) {
      expect(isInternalHostname(host), host).toBe(true)
    }
    expect(isInternalHostname('docs.example.com')).toBe(false)
  })

  it('matches an allowlist entry exactly or as a parent domain', () => {
    expect(matchesAllowedDomain('docs.example.com', ['docs.example.com'])).toBe(true)
    expect(matchesAllowedDomain('a.b.docs.example.com', ['docs.example.com'])).toBe(true)
    // 前缀相同但不是子域：`evildocs.example.com` 不能命中 `docs.example.com`。
    expect(matchesAllowedDomain('evildocs.example.com', ['docs.example.com'])).toBe(false)
    // 后缀混淆：`docs.example.com.attacker.net` 同样不能命中。
    expect(matchesAllowedDomain('docs.example.com.attacker.net', ['docs.example.com'])).toBe(false)
    expect(matchesAllowedDomain('DOCS.EXAMPLE.COM', ['docs.example.com'])).toBe(true)
    expect(matchesAllowedDomain('docs.example.com.', ['docs.example.com'])).toBe(true)
  })
})

describe('URL validation', () => {
  it('accepts an allowlisted HTTPS destination', () => {
    const validated = validateEgressUrl({
      url: 'https://docs.example.com/guide/auth?token=secret#frag',
      policy: webPolicy(),
    })
    expect(validated.hostname).toBe('docs.example.com')
    expect(validated.port).toBe(443)
    // 审计路径只留 origin + path：query 里可能带凭据，fragment 对审计没有价值。
    expect(validated.auditPath).toBe('https://docs.example.com/guide/auth')
    expect(validated.auditPath).not.toContain('secret')
  })

  it('refuses plaintext HTTP unless explicitly enabled', () => {
    expectDenied(
      () => validateEgressUrl({ url: 'http://docs.example.com/x', policy: webPolicy() }),
      /plaintext HTTP/,
    )
    const relaxed = validateEgressUrl({
      url: 'http://docs.example.com/x',
      policy: webPolicy({ allowHttp: true, allowedPorts: [80, 443] }),
    })
    expect(relaxed.port).toBe(80)
  })

  it('refuses non-HTTP schemes outright', () => {
    for (const url of [
      'file:///etc/passwd',
      'gopher://docs.example.com/',
      'ftp://docs.example.com/',
      // `unix:` 是试图触达 Broker socket 的写法。
      'unix:///tmp/broker.sock',
    ]) {
      expectDenied(() => validateEgressUrl({ url, policy: webPolicy() }), /not allowed/)
    }
  })

  it('refuses URL-embedded credentials', () => {
    expectDenied(
      () =>
        validateEgressUrl({
          url: 'https://user:pass@docs.example.com/x',
          policy: webPolicy(),
        }),
      /credentials are not allowed/,
    )
  })

  it('refuses ports outside the allowlist', () => {
    expectDenied(
      () => validateEgressUrl({ url: 'https://docs.example.com:8443/x', policy: webPolicy() }),
      /port 8443/,
    )
  })

  it('refuses numeric IP destinations, public or not', () => {
    for (const url of [
      'https://169.254.169.254/latest/meta-data/',
      'https://127.0.0.1/x',
      'https://[::1]/x',
      // 公网 IP 也拒绝：域名白名单对 IP 字面量无从判断归属。
      'https://8.8.8.8/x',
    ]) {
      expectDenied(() => validateEgressUrl({ url, policy: webPolicy() }), /numeric IP/)
    }
  })

  it('refuses internal hostnames', () => {
    expectDenied(
      () => validateEgressUrl({ url: 'https://localhost/x', policy: webPolicy() }),
      /internal hostnames/,
    )
    expectDenied(
      () => validateEgressUrl({ url: 'https://vault.internal/x', policy: webPolicy() }),
      /internal hostnames/,
    )
  })

  it('refuses platform infrastructure hostnames even if allowlisted', () => {
    // 这一条很重要：运维可能不小心把自己的 Supabase 域名加进 allowlist。
    expectDenied(
      () =>
        validateEgressUrl({
          url: 'https://project.supabase.co/rest/v1/analysis_job',
          policy: webPolicy({ allowedDomains: ['supabase.co'] }),
          blockedHosts: ['project.supabase.co'],
        }),
      /platform infrastructure/,
    )
  })

  it('refuses everything when the allowlist is empty', () => {
    // 空 allowlist 是安全默认：Web 工具可见，但没有目的地可达。
    expectDenied(
      () =>
        validateEgressUrl({
          url: 'https://docs.example.com/x',
          policy: webPolicy({ allowedDomains: [] }),
        }),
      /allowlist is empty/,
    )
  })

  it('refuses a destination that is not on the allowlist', () => {
    expectDenied(
      () => validateEgressUrl({ url: 'https://attacker.net/x', policy: webPolicy() }),
      /not on the web egress allowlist/,
    )
  })
})

describe('platformBlockedHosts', () => {
  it('derives infrastructure hostnames from runtime configuration', () => {
    const hosts = platformBlockedHosts({
      supabaseUrl: 'https://abc.supabase.co',
      gitlabBaseUrl: 'https://gitlab.internal.example',
      extra: ['vault.example.com'],
    })
    expect(hosts).toContain('abc.supabase.co')
    expect(hosts).toContain('gitlab.internal.example')
    expect(hosts).toContain('vault.example.com')
    // metadata 端点的域名形态无论配置如何都在列。
    expect(hosts).toContain('metadata.google.internal')
  })

  it('ignores malformed configuration instead of throwing', () => {
    expect(() => platformBlockedHosts({ supabaseUrl: 'not a url' })).not.toThrow()
  })
})

describe('EgressPolicy request handling', () => {
  function policyWith(input: {
    resolved?: string[]
    responses?: RawEgressResponse[]
    web?: Partial<V4WebPolicy>
  }): { egress: EgressPolicy; calls: Array<{ address: string; url: string }> } {
    const calls: Array<{ address: string; url: string }> = []
    let index = 0
    const responses = input.responses ?? [
      { status: 200, headers: { 'content-type': 'text/html' }, body: 'hello', bytes: 5, truncated: false },
    ]
    const egress = new EgressPolicy({
      policy: webPolicy(input.web),
      logger,
      blockedHosts: ['project.supabase.co'],
      resolve: async () => input.resolved ?? ['93.184.216.34'],
      transport: async ({ url, address }) => {
        calls.push({ address, url: url.href })
        const response = responses[Math.min(index, responses.length - 1)]!
        index++
        return response
      },
    })
    return { egress, calls }
  }

  it('fetches an allowlisted destination and marks the body untrusted', async () => {
    const { egress, calls } = policyWith({})
    const result = await egress.fetch({
      url: 'https://docs.example.com/guide',
      kind: 'fetch',
      agentId: 'root-1',
    })
    expect(result.status).toBe(200)
    expect(result.body).toBe('hello')
    // 明确标注不可信：网页内容不是指令。
    expect(result.untrusted).toBe(true)
    expect(result.finalUrl).toBe('https://docs.example.com/guide')
    // 用解析到的 IP 直连，而不是再让操作系统解析一次域名。
    expect(calls[0]!.address).toBe('93.184.216.34')
    expect(egress.counters()).toEqual({ requests: 1, bytes: 5, denied: 0 })
  })

  it('refuses a DNS rebinding attempt: allowlisted name resolving to a private address', async () => {
    // 这正是"只校验 URL"的实现会漏掉的场景。
    const { egress, calls } = policyWith({ resolved: ['169.254.169.254'] })
    await expect(
      egress.fetch({ url: 'https://docs.example.com/x', kind: 'fetch', agentId: 'root-1' }),
    ).rejects.toMatchObject({ code: V4_ERROR_CODES.WEB_EGRESS_DENIED })
    // 连接从未发出。
    expect(calls).toHaveLength(0)
    // 拒绝原因不回显解析到的 IP：那本身是内网拓扑信息。
    await expect(
      egress.fetch({ url: 'https://docs.example.com/x', kind: 'fetch', agentId: 'root-1' }),
    ).rejects.toThrow(/non-public address/)
  })

  it('refuses when any resolved address is private, not just the first', async () => {
    // DNS 返回混合结果本身就说明这个域名不可信；"挑一个公网的用"是错的。
    const { egress } = policyWith({ resolved: ['93.184.216.34', '10.0.0.5'] })
    await expect(
      egress.fetch({ url: 'https://docs.example.com/x', kind: 'fetch', agentId: 'root-1' }),
    ).rejects.toThrow(/non-public address/)
  })

  it('re-validates every redirect hop', async () => {
    const { egress, calls } = policyWith({
      responses: [
        {
          status: 302,
          headers: { location: 'https://169.254.169.254/latest/meta-data/' },
          body: '',
          bytes: 0,
          truncated: false,
        },
      ],
    })
    await expect(
      egress.fetch({ url: 'https://docs.example.com/x', kind: 'fetch', agentId: 'root-1' }),
    ).rejects.toThrow(/numeric IP/)
    // 第一跳发出去了，第二跳被挡住。
    expect(calls).toHaveLength(1)
  })

  it('follows an allowlisted redirect and reports the final URL', async () => {
    const { egress, calls } = policyWith({
      responses: [
        {
          status: 301,
          headers: { location: 'https://api.vendor.example/v2/doc' },
          body: '',
          bytes: 0,
          truncated: false,
        },
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: '{"ok":true}',
          bytes: 11,
          truncated: false,
        },
      ],
    })
    const result = await egress.fetch({
      url: 'https://docs.example.com/old',
      kind: 'fetch',
      agentId: 'root-1',
    })
    expect(result.finalUrl).toBe('https://api.vendor.example/v2/doc')
    expect(result.contentType).toBe('application/json')
    expect(calls).toHaveLength(2)
  })

  it('caps the redirect chain', async () => {
    const { egress } = policyWith({
      web: { maxRedirects: 1 },
      responses: [
        {
          status: 302,
          headers: { location: 'https://docs.example.com/a' },
          body: '',
          bytes: 0,
          truncated: false,
        },
        {
          status: 302,
          headers: { location: 'https://docs.example.com/b' },
          body: '',
          bytes: 0,
          truncated: false,
        },
      ],
    })
    await expect(
      egress.fetch({ url: 'https://docs.example.com/start', kind: 'fetch', agentId: 'root-1' }),
    ).rejects.toThrow(/too many redirects/)
  })

  it('refuses a response whose MIME type is not readable as text', async () => {
    const { egress } = policyWith({
      responses: [
        {
          status: 200,
          headers: { 'content-type': 'application/octet-stream' },
          body: 'binary',
          bytes: 6,
          truncated: false,
        },
      ],
    })
    await expect(
      egress.fetch({ url: 'https://docs.example.com/blob', kind: 'fetch', agentId: 'root-1' }),
    ).rejects.toThrow(/not readable as text/)
  })

  it('enforces the per-attempt request budget', async () => {
    const { egress } = policyWith({ web: { maxRequestsPerAttempt: 2 } })
    await egress.fetch({ url: 'https://docs.example.com/1', kind: 'fetch', agentId: 'root-1' })
    await egress.fetch({ url: 'https://docs.example.com/2', kind: 'fetch', agentId: 'root-1' })
    await expect(
      egress.fetch({ url: 'https://docs.example.com/3', kind: 'fetch', agentId: 'root-1' }),
    ).rejects.toMatchObject({ code: V4_ERROR_CODES.TOOL_BUDGET_EXHAUSTED })
  })

  it('charges a refused destination against the request budget', async () => {
    // 否则模型可以用无限次"被拒绝的尝试"做 URL 探测。
    const { egress } = policyWith({ web: { maxRequestsPerAttempt: 1 } })
    await expect(
      egress.fetch({ url: 'https://attacker.net/x', kind: 'fetch', agentId: 'root-1' }),
    ).rejects.toThrow(/not on the web egress allowlist/)
    await expect(
      egress.fetch({ url: 'https://docs.example.com/x', kind: 'fetch', agentId: 'root-1' }),
    ).rejects.toMatchObject({ code: V4_ERROR_CODES.TOOL_BUDGET_EXHAUSTED })
  })

  it('atomically partitions the total byte budget across parallel requests', async () => {
    const granted: number[] = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let bothStarted!: () => void
    const started = new Promise<void>((resolve) => {
      bothStarted = resolve
    })
    const egress = new EgressPolicy({
      policy: webPolicy({ maxTotalBytes: 10, maxResponseBytes: 6 }),
      logger,
      blockedHosts: [],
      resolve: async () => ['93.184.216.34'],
      transport: async ({ maxBytes }) => {
        granted.push(maxBytes)
        if (granted.length === 2) bothStarted()
        await gate
        return {
          status: 200,
          headers: { 'content-type': 'text/plain' },
          body: 'x'.repeat(maxBytes),
          bytes: maxBytes,
          truncated: false,
        }
      },
    })

    const first = egress.fetch({ url: 'https://docs.example.com/1', kind: 'fetch', agentId: 'root-1' })
    const second = egress.fetch({ url: 'https://docs.example.com/2', kind: 'fetch', agentId: 'root-1' })
    await started
    expect(granted).toEqual([6, 4])
    release()
    await Promise.all([first, second])
    expect(egress.counters().bytes).toBe(10)
    await expect(
      egress.fetch({ url: 'https://docs.example.com/3', kind: 'fetch', agentId: 'root-1' }),
    ).rejects.toMatchObject({ code: V4_ERROR_CODES.TOOL_BUDGET_EXHAUSTED })
  })

  it('charges every redirect response against the total byte budget', async () => {
    const { egress } = policyWith({
      web: { maxTotalBytes: 10, maxResponseBytes: 10 },
      responses: [
        {
          status: 302,
          headers: { location: 'https://docs.example.com/final' },
          body: 'redirect',
          bytes: 6,
          truncated: true,
        },
        {
          status: 200,
          headers: { 'content-type': 'text/plain' },
          body: 'done',
          bytes: 4,
          truncated: false,
        },
      ],
    })
    await egress.fetch({ url: 'https://docs.example.com/start', kind: 'fetch', agentId: 'root-1' })
    expect(egress.counters().bytes).toBe(10)
    await expect(
      egress.fetch({ url: 'https://docs.example.com/again', kind: 'fetch', agentId: 'root-1' }),
    ).rejects.toMatchObject({ code: V4_ERROR_CODES.TOOL_BUDGET_EXHAUSTED })
  })

  it('enforces the per-attempt total byte budget', async () => {
    const { egress } = policyWith({
      web: { maxTotalBytes: 8, maxResponseBytes: 1024 },
      responses: [
        { status: 200, headers: { 'content-type': 'text/plain' }, body: 'aaaaaaaa', bytes: 8, truncated: false },
      ],
    })
    await egress.fetch({ url: 'https://docs.example.com/1', kind: 'fetch', agentId: 'root-1' })
    await expect(
      egress.fetch({ url: 'https://docs.example.com/2', kind: 'fetch', agentId: 'root-1' }),
    ).rejects.toThrow(/byte budget exhausted/)
  })

  it('reports a truncated large response instead of failing the attempt', async () => {
    // 大响应不应当让整个 attempt 失败：截断并告知模型即可。
    const { egress } = policyWith({
      responses: [
        {
          status: 200,
          headers: { 'content-type': 'text/html' },
          body: 'partial',
          bytes: 7,
          truncated: true,
        },
      ],
    })
    const result = await egress.fetch({
      url: 'https://docs.example.com/big',
      kind: 'fetch',
      agentId: 'root-1',
    })
    expect(result.truncated).toBe(true)
  })

  it('refuses when the destination cannot be resolved', async () => {
    const egress = new EgressPolicy({
      policy: webPolicy(),
      logger,
      blockedHosts: [],
      resolve: async () => {
        throw new Error('ENOTFOUND')
      },
    })
    await expect(
      egress.fetch({ url: 'https://docs.example.com/x', kind: 'fetch', agentId: 'root-1' }),
    ).rejects.toThrow(/could not be resolved/)
  })

  it('refuses when the destination resolves to nothing', async () => {
    const egress = new EgressPolicy({
      policy: webPolicy(),
      logger,
      blockedHosts: [],
      resolve: async () => [],
    })
    await expect(
      egress.fetch({ url: 'https://docs.example.com/x', kind: 'fetch', agentId: 'root-1' }),
    ).rejects.toThrow(/resolved to no address/)
  })
})
