#!/usr/bin/env node
/**
 * Mac 宿主机模型代理（V1.7）。
 *
 * 只做一件事：把 Docker Worker 的模型请求，转发到 macOS 当前生效的公司网络/VPN。
 * 必须运行在 macOS 宿主机上，不能放进 Docker —— 放进容器就还是拿不到 VPN 路由。
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

const bindHost = process.env.MODEL_VPN_PROXY_BIND ?? '127.0.0.1'
const port = Number(process.env.MODEL_VPN_PROXY_PORT ?? '17890')
const username = process.env.MODEL_VPN_PROXY_USERNAME ?? ''
const password = process.env.MODEL_VPN_PROXY_PASSWORD ?? ''
const allowedPorts = new Set(
  (process.env.MODEL_VPN_PROXY_ALLOWED_PORTS ?? '80,443')
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

function isAllowedPort(value) {
  return Number.isInteger(value) && allowedPorts.has(value)
}

const server = http.createServer((req, res) => {
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

  const headers = { ...req.headers, host: target.host }
  // 代理自身的凭据不转发给上游模型端点。
  delete headers['proxy-authorization']
  delete headers['proxy-connection']

  const transport = target.protocol === 'https:' ? https : http
  const upstream = transport.request(
    {
      hostname: target.hostname,
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
  upstream.on('error', () => {
    logEvent('proxy_upstream_error', { host: target.hostname })
    if (!res.headersSent) res.writeHead(502)
    res.end('model endpoint unreachable from this Mac')
  })
  req.pipe(upstream)
})

// HTTPS 模型端点走 CONNECT 隧道：代理不解密，只转发字节。
server.on('connect', (req, clientSocket, head) => {
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

  const upstream = net.connect(targetPort, targetHost.replace(/^\[|\]$/g, ''), () => {
    logEvent('proxy_tunnel_established', { host: targetHost, port: targetPort })
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    if (head.length > 0) upstream.write(head)
    upstream.pipe(clientSocket)
    clientSocket.pipe(upstream)
  })
  upstream.setTimeout(UPSTREAM_TIMEOUT_MS, () => upstream.destroy())
  upstream.on('error', () => {
    logEvent('proxy_upstream_error', { host: targetHost })
    clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')
  })
  clientSocket.on('error', () => upstream.destroy())
})

server.on('clientError', (_error, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
})

// 作为模块被单测 import 时不监听端口；只有直接运行才起服务。
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
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
