#!/usr/bin/env node
/**
 * macOS / Windows 宿主机代理（模型与 Linky 共用）。
 *
 * 只做一件事：把 Docker Worker 的模型请求，转发到宿主机当前生效的公司网络/VPN。
 * 必须运行在 macOS / Windows 宿主机上，不能放进 Docker —— 放进容器就还是拿不到 VPN 路由。
 *
 * 阶段二取消了目标域名白名单。原因不是"放宽"，而是那层判断放错了地方：
 * "这个模型在哪张网上"是模型自己的属性（数据库 `ai_model_config.network_access_mode`），
 * 由 Worker 在发请求前决定走不走代理。让代理再按域名判一次的实际后果是：新增一个内网
 * 模型要改代理的环境变量并重启 launchd 服务，而公网模型一旦误走代理就被拒成 HTTP 403，
 * 用户看到的却是"模型返回 403"。
 *
 * 白名单去掉之后，这里保留的边界是：
 *   - 必须携带 Proxy-Authorization，凭据由安装脚本随机生成，timingSafeEqual 比较；
 *   - 只监听 127.0.0.1，容器经 host.docker.internal 抵达；
 *   - 只允许合法的 HTTP/HTTPS 端口；
 *   - 拒绝 loopback、链路本地/云元数据、Docker 管理地址与通配地址（SSRF 防护）；
 *   - 日志只记录事件、主机名与状态码，绝不记录 Authorization、API Key 或请求正文。
 */
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import crypto from 'node:crypto'
import { lookup as dnsLookup } from 'node:dns/promises'
import { pathToFileURL } from 'node:url'
import { realpathSync } from 'node:fs'
import { DEFAULT_PROXY_PORTS } from './model-vpn-proxy-config.mjs'

const bindHost = process.env.MODEL_VPN_PROXY_BIND ?? '127.0.0.1'
const port = Number(process.env.MODEL_VPN_PROXY_PORT ?? '17890')
const username = process.env.MODEL_VPN_PROXY_USERNAME ?? ''
const password = process.env.MODEL_VPN_PROXY_PASSWORD ?? ''
const allowedPorts = new Set(
  (process.env.MODEL_VPN_PROXY_ALLOWED_PORTS ?? DEFAULT_PROXY_PORTS)
    .split(',')
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value) && value > 0 && value < 65536),
)

/**
 * 启动前校验。
 *
 * 刻意**不在模块顶层**执行：`isDeniedTarget` 是这份文件里唯一值得单测的纯函数，而顶层
 * `process.exit()` 会让 `import()` 直接把测试进程杀掉。校验只在真正要监听端口时做。
 */
function assertStartupConfig() {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    console.error('MODEL_VPN_PROXY_PORT must be an integer between 1024 and 65535')
    process.exit(1)
  }
  if (username === '' || password === '') {
    console.error('MODEL_VPN_PROXY_USERNAME and MODEL_VPN_PROXY_PASSWORD are required')
    process.exit(1)
  }
  if (allowedPorts.size === 0) {
    console.error('MODEL_VPN_PROXY_ALLOWED_PORTS must list at least one valid port')
    process.exit(1)
  }
}

// 上游连接的**空闲**超时(两次数据之间的最大间隔),不是请求总时长上限。
//
// 关键:reasoning 类模型(如 kimi-k3)在流式响应里会有较长的"思考"停顿——服务端在算,
// 期间不往回吐任何字节。如果这个值小于该停顿,代理会在流正常结束前 destroy 掉上游连接,
// 下游 pi-ai 收到的就是"流在没有 finish_reason 时结束"(Stream ended without finish_reason,
// 分类为 TRANSPORT),连带耗尽 attempt 的重试预算导致评审整批失败。
//
// 因此这里必须 >= 模型端点侧的思考停顿上限,并与 ai_model_config.request_timeout_ms 对齐,
// 让平台侧的超时来兜底,而不是代理抢先掐断。300s 覆盖实测 kimi 评审场景;如仍不足,
// 与模型超时一并上调。可用 MODEL_VPN_PROXY_UPSTREAM_TIMEOUT_MS 覆盖。
const UPSTREAM_TIMEOUT_MS = Number(process.env.MODEL_VPN_PROXY_UPSTREAM_TIMEOUT_MS ?? '300000')
const expectedAuth = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`

/** 事件日志。刻意只允许固定字段，避免顺手把 Header 或正文写进日志。 */
function logEvent(event, meta = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), proxy: 'model-vpn-proxy', event, ...meta }))
}

/**
 * 上游失败的**原因**，按允许列表提取。
 *
 * 之前 `upstream.on('error', () => ...)` 把 error 整个丢掉，只记 host。后果是排查时
 * 一次连接被重置、一次 DNS 解析失败、一次 300 秒空闲超时（`upstream.destroy(new
 * Error('upstream timeout'))` 走的也是同一个 handler）在日志里长得一模一样，只能靠
 * 请求时间差去猜是哪一种 —— 而这三种的处置完全不同：重置要看内网端点，DNS 要看 VPN
 * 路由，超时要调 `MODEL_VPN_PROXY_UPSTREAM_TIMEOUT_MS` 与模型超时。
 *
 * 只取 `code`/`syscall` 与固定的超时标记：这些是 Node 自己产生的枚举值，不含地址、
 * Header 或正文。刻意不记 `error.message` 原文，避免上游把响应内容塞进 message 时
 * 顺带写进日志。
 */
export function upstreamErrorMeta(error) {
  const code = typeof error?.code === 'string' ? error.code : undefined
  const syscall = typeof error?.syscall === 'string' ? error.syscall : undefined
  const timedOut = error?.message === 'upstream timeout'
  return {
    reason: timedOut ? 'idle_timeout' : (code ?? 'UNKNOWN'),
    ...(syscall === undefined ? {} : { syscall }),
    ...(timedOut ? { idle_timeout_ms: UPSTREAM_TIMEOUT_MS } : {}),
  }
}

function isAuthorized(headers) {
  const provided = Buffer.from(String(headers['proxy-authorization'] ?? ''))
  const expected = Buffer.from(expectedAuth)
  // 长度不同时 timingSafeEqual 会抛，所以先比长度；两者都不泄露具体差异位置。
  return provided.length === expected.length && crypto.timingSafeEqual(provided, expected)
}

/**
 * 明确拒绝的主机名。
 *
 * 这是白名单去掉之后剩下的那层防护，防的不是"访问了不该访问的模型"，而是**把这个代理
 * 当跳板去打本机与基础设施**：Agent 的 Shell 会继承代理环境（实测确认），所以代理必须
 * 自己挡住 loopback、云元数据和 Docker 管理地址。
 *
 * 抽成纯函数并单测，是为了让"哪些目标被拒"有一份可执行的定义，而不是散落在 HTTP 与
 * CONNECT 两条分支里各写一遍。
 */
export function isDeniedTarget(hostname) {
  if (typeof hostname !== 'string') return true
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '')
  if (host === '') return true
  // 主机名形态必须合法：IPv4/IPv6 字面量，或点分的 DNS 名。其余（含空格、下划线、
  // 用户信息残留）一律拒绝，而不是交给下游解析器去猜。
  if (!/^[a-z0-9._:-]+$/.test(host)) return true

  // 通配与未指定地址。
  if (host === '0.0.0.0' || host === '::' || host === '::0') return true
  // loopback：主机名与 IPv4/IPv6 字面量都要挡。
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host === '::1') return true
  if (/^127\./.test(host)) return true
  // IPv4-mapped IPv6 的 loopback 写法。
  if (/^::ffff:127\./.test(host)) return true
  // 链路本地与云元数据（AWS/GCP/Azure 都用 169.254.169.254；IMDSv6 用 fd00:ec2::254）。
  if (/^169\.254\./.test(host)) return true
  if (host === 'fd00:ec2::254') return true
  if (host === 'metadata' || host === 'metadata.google.internal') return true
  // Docker Desktop 的宿主机管理地址。让容器经代理回连宿主机是纯粹的跳板行为。
  if (host === 'host.docker.internal' || host === 'gateway.docker.internal') return true
  if (host.endsWith('.docker.internal') || host.startsWith('docker.for.mac')) return true
  if (host === '172.17.0.1') return true
  return false
}

/** DNS 名称先解析全部候选，再固定到其中一个已校验的地址，避免检查后重解析。 */
export async function resolveAllowedTarget(hostname, lookup = dnsLookup) {
  if (isDeniedTarget(hostname)) return null
  const host = hostname.replace(/^\[|\]$/g, '')
  const literalFamily = net.isIP(host)
  const addresses = literalFamily
    ? [{ address: host, family: literalFamily }]
    : await lookup(host, { all: true, verbatim: true })
  if (addresses.length === 0 || addresses.some(({ address }) => isDeniedAddress(address))) return null
  return addresses[0]
}

/** 内网 10.x/172.16.x/192.168.x 是公司模型的合法目标，不能一概禁止。 */
export function isDeniedAddress(address) {
  const normalized = String(address).toLowerCase().split('%')[0]
  // IPv4-mapped、IPv4-translated 与 well-known NAT64 前缀都可能把受禁 IPv4
  // 包在 IPv6 里；正常转换地址仍需允许（MacPacket 会返回 ::ffff:0:a.b.c.d）。
  if (normalized.startsWith('::ffff:') && net.isIP(normalized.slice(7)) === 4) {
    return isDeniedAddress(normalized.slice(7))
  }
  const embedded = normalized.match(/^(?:::ffff:(?:0:)?|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  if (embedded) {
    const high = Number.parseInt(embedded[1], 16)
    const low = Number.parseInt(embedded[2], 16)
    return isDeniedAddress(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`)
  }
  if (net.isIP(normalized) === 4) {
    const octets = normalized.split('.').map(Number)
    return octets[0] === 0 || octets[0] === 127
      || (octets[0] === 169 && octets[1] === 254)
      || (octets[0] === 172 && octets[1] === 17)
      || (octets[0] === 192 && octets[1] === 168 && octets[2] === 65)
      || (octets[0] === 100 && octets[1] === 100 && octets[2] === 100 && octets[3] === 200)
      || octets[0] >= 224
  }
  if (net.isIP(normalized) === 6) {
    return normalized === '::' || normalized === '::1' || normalized === 'fd00:ec2::254'
      || /^fe[89ab]/.test(normalized) || /^ff/.test(normalized)
  }
  return true
}

function isAllowedPort(value) {
  return Number.isInteger(value) && allowedPorts.has(value)
}

const server = http.createServer(async (req, res) => {
  if (!isAuthorized(req.headers)) {
    logEvent('proxy_auth_rejected')
    res.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="model-vpn-proxy"' })
    res.end('proxy authentication required')
    return
  }

  let target
  try {
    target = new URL(req.url ?? '')
  } catch {
    res.writeHead(400)
    res.end('absolute proxy URL required')
    return
  }

  const targetPort = target.port === '' ? (target.protocol === 'https:' ? 443 : 80) : Number(target.port)
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    logEvent('proxy_target_denied', { host: target.hostname, reason: 'scheme' })
    res.writeHead(403)
    res.end('proxy target denied')
    return
  }
  if (isDeniedTarget(target.hostname) || !isAllowedPort(targetPort)) {
    logEvent('proxy_target_denied', { host: target.hostname, port: targetPort })
    res.writeHead(403)
    res.end('proxy target denied')
    return
  }

  let resolved
  try { resolved = await resolveAllowedTarget(target.hostname) }
  catch (error) {
    logEvent('proxy_upstream_error', { host: target.hostname, ...upstreamErrorMeta(error) })
    res.writeHead(502)
    res.end('model endpoint unreachable from this Mac')
    return
  }
  if (!resolved) {
    logEvent('proxy_target_denied', { host: target.hostname, port: targetPort, reason: 'dns_address' })
    res.writeHead(403)
    res.end('proxy target denied')
    return
  }

  const headers = { ...req.headers, host: target.host }
  // 代理自身的凭据不转发给上游模型端点。
  delete headers['proxy-authorization']
  delete headers['proxy-connection']

  const transport = target.protocol === 'https:' ? https : http
  const upstream = transport.request(
    {
      hostname: target.hostname,
      lookup: (_host, _options, callback) => callback(null, resolved.address, resolved.family),
      port: targetPort,
      method: req.method,
      path: `${target.pathname}${target.search}`,
      headers,
    },
    (upstreamResponse) => {
      logEvent('proxy_forwarded', {
        host: target.hostname,
        status_code: upstreamResponse.statusCode ?? 0,
      })
      res.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers)
      upstreamResponse.pipe(res)
    },
  )

  upstream.setTimeout(UPSTREAM_TIMEOUT_MS, () => upstream.destroy(new Error('upstream timeout')))
  upstream.on('error', (error) => {
    logEvent('proxy_upstream_error', { host: target.hostname, ...upstreamErrorMeta(error) })
    if (!res.headersSent) res.writeHead(502)
    res.end('model endpoint unreachable from this Mac')
  })
  req.pipe(upstream)
})

// HTTPS 模型端点走 CONNECT 隧道：代理不解密，只转发字节。
server.on('connect', async (req, clientSocket, head) => {
  if (!isAuthorized(req.headers)) {
    logEvent('proxy_auth_rejected')
    clientSocket.end(
      'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="model-vpn-proxy"\r\n\r\n',
    )
    return
  }

  // IPv6 字面量形如 `[::1]:443`：从**最后**一个冒号切，否则会把地址本身切碎。
  const authority = String(req.url ?? '')
  const separator = authority.lastIndexOf(':')
  const targetHost = separator > 0 ? authority.slice(0, separator) : authority
  const targetPort = Number(separator > 0 ? authority.slice(separator + 1) : '443')
  if (isDeniedTarget(targetHost) || !isAllowedPort(targetPort)) {
    logEvent('proxy_target_denied', { host: targetHost, port: targetPort })
    clientSocket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
    return
  }

  let resolved
  try { resolved = await resolveAllowedTarget(targetHost) }
  catch (error) {
    logEvent('proxy_upstream_error', { host: targetHost, ...upstreamErrorMeta(error) })
    clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')
    return
  }
  if (!resolved) {
    logEvent('proxy_target_denied', { host: targetHost, port: targetPort, reason: 'dns_address' })
    clientSocket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
    return
  }

  const upstream = net.connect({ port: targetPort, host: resolved.address }, () => {
    logEvent('proxy_tunnel_established', { host: targetHost, port: targetPort })
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    if (head.length > 0) upstream.write(head)
    upstream.pipe(clientSocket)
    clientSocket.pipe(upstream)
  })
  // 与 HTTP 分支一致地带上原因 destroy：不带 error 的 destroy 不会触发 'error'，
  // 隧道就会静默断开，日志里连一条 proxy_upstream_error 都没有。
  upstream.setTimeout(UPSTREAM_TIMEOUT_MS, () => upstream.destroy(new Error('upstream timeout')))
  upstream.on('error', (error) => {
    logEvent('proxy_upstream_error', { host: targetHost, ...upstreamErrorMeta(error) })
    clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')
  })
  clientSocket.on('error', () => upstream.destroy())
})

server.on('clientError', (_error, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
})

// 作为模块被单测 import 时不监听端口；只有直接运行才起服务。
export function startProxy() {
  assertStartupConfig()
  server.listen(port, bindHost, () => {
    logEvent('proxy_started', { bind: bindHost, port, allowed_ports: [...allowedPorts] })
  })

  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      logEvent('proxy_stopping', { signal })
      server.close(() => process.exit(0))
    })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  startProxy()
}
