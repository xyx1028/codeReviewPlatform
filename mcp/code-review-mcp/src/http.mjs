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

const MAX_BODY_BYTES = 1024 * 1024

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
 */
export function authenticate(headers, { tokens, allowAnonymous }) {
  const token = extractToken(headers)
  if (token === null) {
    if (allowAnonymous) return { ok: true, caller: 'anonymous' }
    return { ok: false, reason: 'MISSING_TOKEN' }
  }
  const hit = tokens.find((entry) => constantTimeEquals(entry.token, token))
  if (!hit) return { ok: false, reason: 'INVALID_TOKEN' }
  return { ok: true, caller: hit.name }
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

export function createHttpApp({ config, registry, logger = () => {} }) {
  /** sessionId → { transport, server, caller } */
  const sessions = new Map()

  async function handle(req, res) {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)

    if (url.pathname === '/healthz') {
      sendJson(res, 200, { status: 'ok', server: 'codereview-mcp', sessions: sessions.size })
      return
    }

    if (url.pathname !== config.http.path) {
      jsonRpcError(res, 404, -32601, `未知路径 ${url.pathname}，MCP 端点是 ${config.http.path}`)
      return
    }

    const auth = authenticate(req.headers, config.http)
    if (!auth.ok) {
      logger('auth_rejected', { reason: auth.reason, method: req.method })
      jsonRpcError(res, 401, -32001, '访问凭证缺失或无效。请在客户端为这台 MCP 配置 Bearer 访问凭证。', {
        'WWW-Authenticate': 'Bearer realm="codereview-mcp"',
      })
      return
    }

    const sessionId = req.headers['mcp-session-id']
    const existing = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined

    // 会话必须始终属于同一个凭证：拿到 session id 不等于通过鉴权。
    if (existing && existing.caller !== auth.caller) {
      logger('session_caller_mismatch', { sessionId, caller: auth.caller })
      jsonRpcError(res, 403, -32002, '这个会话属于另一个访问凭证。')
      return
    }

    // 校验过的身份交给 MCP 层：工具实现读 extra.authInfo.clientId，模型改不了它。
    req.auth = { token: 'redacted', clientId: auth.caller, scopes: [], extra: {} }

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
        onsessioninitialized: (id) => {
          sessions.set(id, { transport, server, caller: auth.caller })
          logger('session_opened', { sessionId: id, caller: auth.caller })
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

  return {
    httpServer,
    sessions,
    async listen() {
      await new Promise((resolve) => httpServer.listen(config.http.port, config.http.host, resolve))
      return httpServer.address()
    },
    async close() {
      for (const [, session] of sessions) await session.transport.close().catch(() => undefined)
      sessions.clear()
      await new Promise((resolve) => httpServer.close(resolve))
    },
  }
}
