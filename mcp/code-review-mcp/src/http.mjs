/**
 * 标准 Streamable HTTP 远程 MCP 端点。
 *
 * 别人在 Qoder / Codex 里填的就是这里的 URL 加一个 Bearer 访问凭证。
 *
 * 安全边界（逐条都是刻意的）：
 *
 * - **凭证在 HTTP 层校验，先于任何 MCP 语义。** 没过就 401，连 initialize 都不处理。
 * - **会话与凭证绑定。** 同一个 Mcp-Session-Id 换一个凭证继续用会被拒，否则拿到
 *   session id 就等于绕过了鉴权。
 * - **调用方身份不来自模型。** 它来自校验过的凭证名，写进日志和批次备注；模型无法伪造。
 * - **客户端永远拿不到平台密钥。** service-role key、模型 API Key、Linky 凭证都只在
 *   服务端/Worker 侧，MCP 回给客户端的只有编号、参数和链接。
 */

import { createServer } from 'node:http'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import { createMcpServer } from './server.mjs'
import { normalizePath } from './config.mjs'

const MAX_BODY_BYTES = 1024 * 1024
const DEFAULT_SESSION_TTL_MS = 30 * 60_000
const DEFAULT_MAX_SESSIONS = 256
/** 清扫间隔：取 TTL 的 1/6，并夹在 10 秒到 5 分钟之间。 */
function sweepIntervalMs(ttlMs) {
  return Math.min(Math.max(Math.floor(ttlMs / 6), 10_000), 5 * 60_000)
}

function constantTimeEquals(a, b) {
  const left = Buffer.from(String(a), 'utf8')
  const right = Buffer.from(String(b), 'utf8')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/** 从 Authorization / X-Api-Key 取 token。两个都支持是因为部分客户端只允许自定义头。 */
export function extractToken(headers) {
  const authorization = headers.authorization ?? headers.Authorization
  if (typeof authorization === 'string') {
    const match = /^Bearer\s+(.+)$/i.exec(authorization.trim())
    if (match) return match[1].trim()
  }
  const apiKey = headers['x-api-key']
  if (typeof apiKey === 'string' && apiKey.trim() !== '') return apiKey.trim()
  return null
}

/**
 * 校验访问凭证。
 *
 * 返回调用方名字（日志与批次备注用）。允许匿名时名字固定为 `anonymous`，
 * 这样日志里能看出这台服务当时是开着无鉴权的。
 *
 * 匿名模式下**带了凭证也放行**：这台服务此刻根本没有凭证清单，拿"凭证不在清单里"
 * 去拒绝一个本来就不需要凭证的请求，只会让人对着一个开着无鉴权的端点查 401。
 */
export function authenticate(headers, { tokens, allowAnonymous }) {
  const token = extractToken(headers)
  if (token === null) {
    if (allowAnonymous) return { ok: true, caller: 'anonymous' }
    return { ok: false, reason: 'MISSING_TOKEN' }
  }
  const hit = (tokens ?? []).find((entry) => constantTimeEquals(entry.token, token))
  if (!hit) {
    if (allowAnonymous) return { ok: true, caller: 'anonymous' }
    return { ok: false, reason: 'INVALID_TOKEN' }
  }
  return { ok: true, caller: hit.name }
}

/**
 * 解析这次响应该带的 CORS 头。
 *
 * 为什么需要：在 IDE 的 WebView / 浏览器里跑的 MCP 客户端会先发一次 `OPTIONS` 预检，
 * 预检请求**不带** `Authorization`。按业务流程先鉴权就会把预检打成 401，客户端那边
 * 看到的是"连不上"，而服务端日志里是一行 auth_rejected —— 两边都查不到真正原因。
 *
 * 为什么放开 CORS 不等于放开鉴权：鉴权凭证走 `Authorization` 头，不是 cookie，
 * 跨站脚本拿不到它，所以 `Access-Control-Allow-Origin` 不会把身份借给别的站点。
 * 这里也刻意**不**回 `Access-Control-Allow-Credentials`。
 */
export function corsHeaders(requestOrigin, allowedOrigins = ['*']) {
  const headers = {
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers':
      'Authorization, X-Api-Key, Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID',
    // 不暴露这个头，浏览器侧客户端读不到会话 id，第二个请求就会被当成"缺少会话"。
    'Access-Control-Expose-Headers': 'Mcp-Session-Id, WWW-Authenticate',
    'Access-Control-Max-Age': '600',
  }
  const list = allowedOrigins ?? ['*']
  if (list.includes('*')) {
    headers['Access-Control-Allow-Origin'] = '*'
    return headers
  }
  if (typeof requestOrigin === 'string' && list.includes(requestOrigin)) {
    headers['Access-Control-Allow-Origin'] = requestOrigin
    headers.Vary = 'Origin'
  }
  return headers
}

function sendJson(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    ...extraHeaders,
  })
  res.end(body)
}

function jsonRpcError(res, status, code, message, extraHeaders = {}) {
  sendJson(res, status, { jsonrpc: '2.0', error: { code, message }, id: null }, extraHeaders)
}

async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) {
      const error = new Error('PAYLOAD_TOO_LARGE')
      error.code = 'PAYLOAD_TOO_LARGE'
      throw error
    }
    chunks.push(chunk)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  if (raw.trim() === '') return null
  return JSON.parse(raw)
}

export function createHttpApp({ config, registry, logger = () => {}, now = () => Date.now() }) {
  /** sessionId → { transport, server, caller, lastSeenAt } */
  const sessions = new Map()
  const endpointPath = normalizePath(config.http.path)
  const allowedOrigins = config.http.allowedOrigins ?? ['*']
  const sessionTtlMs = config.http.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS
  const maxSessions = config.http.maxSessions ?? DEFAULT_MAX_SESSIONS

  /**
   * 回收会话。
   *
   * `reason` 只进日志：运维需要能区分"客户端自己关的"（session_closed）、"空闲超时"
   * 和"会话数到上限被挤掉"，否则会话消失看起来都一样。
   */
  async function dropSession(sessionId, reason) {
    const session = sessions.get(sessionId)
    if (session === undefined) return
    sessions.delete(sessionId)
    logger('session_evicted', { sessionId, caller: session.caller, reason })
    await session.transport.close().catch(() => undefined)
  }

  async function sweepIdleSessions() {
    const deadline = now() - sessionTtlMs
    for (const [sessionId, session] of [...sessions]) {
      if (session.lastSeenAt <= deadline) await dropSession(sessionId, 'IDLE_TIMEOUT')
    }
  }

  /** 到上限时挤掉最久没活动的那个，而不是拒绝新连接：新来的请求是真实使用者。 */
  async function enforceSessionLimit() {
    while (sessions.size > maxSessions) {
      let oldestId = null
      let oldestSeenAt = Infinity
      for (const [sessionId, session] of sessions) {
        if (session.lastSeenAt < oldestSeenAt) {
          oldestSeenAt = session.lastSeenAt
          oldestId = sessionId
        }
      }
      if (oldestId === null) return
      await dropSession(oldestId, 'MAX_SESSIONS')
    }
  }

  async function handle(req, res) {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const cors = corsHeaders(req.headers.origin, allowedOrigins)
    const pathname = normalizePath(url.pathname)

    if (pathname === '/healthz') {
      sendJson(
        res,
        200,
        { status: 'ok', server: 'codereview-mcp', sessions: sessions.size },
        cors,
      )
      return
    }

    if (pathname !== endpointPath) {
      jsonRpcError(res, 404, -32601, `未知路径 ${url.pathname}，MCP 端点是 ${endpointPath}`, cors)
      return
    }

    // 预检必须在鉴权之前答复：浏览器不会给预检请求带 Authorization。
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { ...cors, 'Content-Length': '0' })
      res.end()
      return
    }

    const auth = authenticate(req.headers, config.http)
    if (!auth.ok) {
      logger('auth_rejected', { reason: auth.reason, method: req.method })
      jsonRpcError(res, 401, -32001, '访问凭证缺失或无效。请在客户端为这台 MCP 配置 Bearer 访问凭证。', {
        'WWW-Authenticate': 'Bearer realm="codereview-mcp"',
        ...cors,
      })
      return
    }

    const sessionId = req.headers['mcp-session-id']
    const existing = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined

    // 会话必须始终属于同一个凭证：拿到 session id 不等于通过鉴权。
    if (existing && existing.caller !== auth.caller) {
      logger('session_caller_mismatch', { sessionId, caller: auth.caller })
      jsonRpcError(res, 403, -32002, '这个会话属于另一个访问凭证。', cors)
      return
    }
    if (existing) existing.lastSeenAt = now()

    // 校验过的身份交给 MCP 层：工具实现读 extra.authInfo.clientId，模型改不了它。
    req.auth = { token: 'redacted', clientId: auth.caller, scopes: [], extra: {} }
    for (const [key, value] of Object.entries(cors)) res.setHeader(key, value)

    if (req.method === 'POST') {
      let body
      try {
        body = await readBody(req)
      } catch (error) {
        const tooLarge = error?.code === 'PAYLOAD_TOO_LARGE'
        jsonRpcError(
          res,
          tooLarge ? 413 : 400,
          -32700,
          tooLarge ? '请求体过大。' : '请求体不是合法 JSON。',
        )
        return
      }

      if (existing) {
        await existing.transport.handleRequest(req, res, body)
        return
      }

      if (!isInitializeRequest(body)) {
        jsonRpcError(
          res,
          400,
          -32000,
          '缺少有效的 Mcp-Session-Id：非 initialize 请求必须带上 initialize 时返回的会话 id。',
        )
        return
      }

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: async (id) => {
          sessions.set(id, { transport, server, caller: auth.caller, lastSeenAt: now() })
          logger('session_opened', { sessionId: id, caller: auth.caller, sessions: sessions.size })
          // SDK 会 await 这个回调，所以上限在 initialize 响应发出之前就已经生效。
          await enforceSessionLimit()
        },
        onsessionclosed: (id) => {
          sessions.delete(id)
          logger('session_closed', { sessionId: id, caller: auth.caller })
        },
      })
      const server = createMcpServer(registry)
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId)
      }
      await server.connect(transport)
      await transport.handleRequest(req, res, body)
      return
    }

    if (req.method === 'GET' || req.method === 'DELETE') {
      if (!existing) {
        jsonRpcError(res, 400, -32000, '缺少有效的 Mcp-Session-Id。')
        return
      }
      await existing.transport.handleRequest(req, res)
      return
    }

    jsonRpcError(res, 405, -32000, `不支持的方法 ${req.method}`)
  }

  const httpServer = createServer((req, res) => {
    handle(req, res).catch((error) => {
      logger('http_error', { message: String(error?.message ?? error) })
      if (!res.headersSent) jsonRpcError(res, 500, -32603, '服务端内部错误。')
      else res.end()
    })
  })

  let sweeper = null

  return {
    httpServer,
    sessions,
    /** 测试用：不等真实 TTL 也能驱动一次清扫。 */
    sweepIdleSessions,
    async listen() {
      await new Promise((resolve, reject) => {
        // listen 失败是通过 'error' 事件报的。不接这个事件的话，端口被占用时
        // Promise 永不 settle，进程最后以一条未捕获异常的栈退出 —— 运维看不出
        // "端口被别的进程占了"这件事。
        const onError = (error) => {
          httpServer.removeListener('listening', onListening)
          reject(error)
        }
        const onListening = () => {
          httpServer.removeListener('error', onError)
          resolve()
        }
        httpServer.once('error', onError)
        httpServer.once('listening', onListening)
        httpServer.listen(config.http.port, config.http.host)
      })
      sweeper = setInterval(() => {
        void sweepIdleSessions()
      }, sweepIntervalMs(sessionTtlMs))
      sweeper.unref?.()
      return httpServer.address()
    },
    async close() {
      if (sweeper !== null) {
        clearInterval(sweeper)
        sweeper = null
      }
      for (const [, session] of sessions) await session.transport.close().catch(() => undefined)
      sessions.clear()
      await new Promise((resolve) => httpServer.close(resolve))
    },
  }
}
