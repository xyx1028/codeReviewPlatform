/**
 * 远程 MCP 端点的加固行为。
 *
 * 这一组全部对着**真实的 HTTP 端点**断言，而不是对函数返回值：这些缺陷的共同点是
 * 单元层面看不出来 —— 预检被鉴权挡掉、少一个斜杠、会话不回收，都只在"别人的客户端
 * 连过来"的时候才暴露。
 */

import { strict as assert } from 'node:assert'
import test from 'node:test'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

import { createHttpApp, corsHeaders } from '../src/http.mjs'
import { normalizePath, parseAllowedOrigins } from '../src/config.mjs'
import { TOOL_DEFINITION, TOOL_NAME } from '../src/tools.mjs'

const TOKEN = 'token-0123456789abcdef'

function buildConfig(port, overrides = {}) {
  return {
    transport: 'http',
    http: {
      host: '127.0.0.1',
      port,
      path: '/mcp',
      tokens: [{ name: 'alice', token: TOKEN }],
      allowAnonymous: false,
      allowedOrigins: ['*'],
      sessionTtlMs: 30 * 60_000,
      maxSessions: 256,
      ...overrides,
    },
  }
}

const registry = {
  definitions: [TOOL_DEFINITION],
  async call(name, args, context) {
    return { content: [{ type: 'text', text: `ok:${context?.caller ?? 'none'}` }], isError: false }
  },
}

async function withServer(run, { overrides = {}, now } = {}) {
  const app = createHttpApp({ config: buildConfig(0, overrides), registry, now })
  const address = await app.listen()
  try {
    await run({ baseUrl: `http://127.0.0.1:${address.port}`, app })
  } finally {
    await app.close()
  }
}

async function connect(baseUrl, { token = TOKEN, path = '/mcp' } = {}) {
  const client = new Client({ name: 'test-client', version: '1.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}${path}`), {
    requestInit: token === null ? undefined : { headers: { Authorization: `Bearer ${token}` } },
  })
  await client.connect(transport)
  return { client, transport }
}

test('路径归一化：尾斜杠与缺失前导斜杠都指向同一个端点', () => {
  assert.equal(normalizePath('/mcp/'), '/mcp')
  assert.equal(normalizePath('mcp'), '/mcp')
  assert.equal(normalizePath('/mcp//'), '/mcp')
  assert.equal(normalizePath('/'), '/')
  assert.equal(normalizePath(''), '/')
})

test('带尾斜杠的地址也能完成 initialize（粘贴 URL 多一个斜杠不该 404）', async () => {
  await withServer(async ({ baseUrl }) => {
    const { client, transport } = await connect(baseUrl, { path: '/mcp/' })
    try {
      const tools = await client.listTools()
      assert.equal(tools.tools[0].name, TOOL_NAME)
    } finally {
      await transport.close()
      await client.close()
    }
  })
})

test('OPTIONS 预检不需要凭证，且暴露 Mcp-Session-Id', async () => {
  await withServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://ide.example.com',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization,content-type',
      },
    })
    assert.equal(response.status, 204, '预检被鉴权挡掉时客户端只会显示"连不上"')
    assert.equal(response.headers.get('access-control-allow-origin'), '*')
    assert.match(response.headers.get('access-control-allow-methods') ?? '', /POST/)
    assert.match(response.headers.get('access-control-allow-headers') ?? '', /Authorization/i)
    assert.match(
      response.headers.get('access-control-expose-headers') ?? '',
      /Mcp-Session-Id/i,
      '不暴露会话 id，浏览器侧客户端第二个请求就会被当成缺少会话',
    )
  })
})

test('401 与 404 响应同样带 CORS 头：否则浏览器侧看到的是"网络错误"而不是原因', async () => {
  await withServer(async ({ baseUrl }) => {
    const unauthorized = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://ide.example.com' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    })
    assert.equal(unauthorized.status, 401)
    assert.equal(unauthorized.headers.get('access-control-allow-origin'), '*')

    const notFound = await fetch(`${baseUrl}/nope`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, Origin: 'https://ide.example.com' },
    })
    assert.equal(notFound.status, 404)
    assert.equal(notFound.headers.get('access-control-allow-origin'), '*')
  })
})

test('来源白名单：没登记的来源不回 Allow-Origin，登记的原样回显', () => {
  assert.deepEqual(parseAllowedOrigins(''), ['*'])
  assert.deepEqual(parseAllowedOrigins('https://a.example.com, https://b.example.com'), [
    'https://a.example.com',
    'https://b.example.com',
  ])
  assert.deepEqual(parseAllowedOrigins('https://a.example.com,*'), ['*'])

  const allowed = corsHeaders('https://a.example.com', ['https://a.example.com'])
  assert.equal(allowed['Access-Control-Allow-Origin'], 'https://a.example.com')
  assert.equal(allowed.Vary, 'Origin')

  const rejected = corsHeaders('https://evil.example.com', ['https://a.example.com'])
  assert.equal(rejected['Access-Control-Allow-Origin'], undefined)

  // 鉴权不靠 cookie，所以这里绝不能回 Allow-Credentials。
  assert.equal(corsHeaders('https://a.example.com', ['*'])['Access-Control-Allow-Credentials'], undefined)
})

test('匿名模式下客户端带了凭证也放行（服务端此刻没有凭证清单可比对）', async () => {
  await withServer(
    async ({ baseUrl }) => {
      const { client, transport } = await connect(baseUrl, { token: 'leftover-token-from-other-server' })
      try {
        const result = await client.callTool({ name: TOOL_NAME, arguments: {} })
        assert.equal(result.content[0].text, 'ok:anonymous')
      } finally {
        await transport.close()
        await client.close()
      }
    },
    { overrides: { tokens: [], allowAnonymous: true } },
  )
})

test('空闲会话会被回收：客户端不发 DELETE 就走掉不该让会话永久堆积', async () => {
  let clock = 1_000_000
  await withServer(
    async ({ baseUrl, app }) => {
      for (let index = 0; index < 3; index += 1) {
        const { client, transport } = await connect(baseUrl)
        await client.listTools()
        // 刻意不调 terminateSession()：模拟客户端进程退出 / 网络断开。
        await transport.close()
        await client.close()
      }
      assert.equal(app.sessions.size, 3, '断开连接本身不会关闭服务端会话（协议如此）')

      clock += 61_000
      await app.sweepIdleSessions()
      assert.equal(app.sessions.size, 0, '超过 TTL 的会话必须被回收')
      const health = await (await fetch(`${baseUrl}/healthz`)).json()
      assert.equal(health.sessions, 0)
    },
    { overrides: { sessionTtlMs: 60_000 }, now: () => clock },
  )
})

test('会话数到上限时挤掉最久没活动的那个，而不是拒绝新来的使用者', async () => {
  let clock = 2_000_000
  await withServer(
    async ({ baseUrl, app }) => {
      const first = await connect(baseUrl)
      const firstSessionId = first.transport.sessionId
      assert.ok(firstSessionId)

      clock += 1_000
      const second = await connect(baseUrl)
      assert.equal(app.sessions.size, 1, '上限是 1，开第二个会话必须挤掉第一个')
      assert.equal(app.sessions.has(firstSessionId), false)

      // 被挤掉的会话再用，服务端必须明确说"没有这个会话"，而不是静默当成新会话。
      const response = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          Authorization: `Bearer ${TOKEN}`,
          'mcp-session-id': firstSessionId,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list', params: {} }),
      })
      assert.equal(response.status, 400)

      // 新会话照常可用。
      const tools = await second.client.listTools()
      assert.equal(tools.tools.length, 1)

      await second.transport.close()
      await second.client.close()
      await first.transport.close().catch(() => undefined)
      await first.client.close().catch(() => undefined)
    },
    { overrides: { maxSessions: 1 }, now: () => clock },
  )
})

test('活动中的会话不会被 TTL 误杀：每次请求都刷新最后活动时间', async () => {
  let clock = 3_000_000
  await withServer(
    async ({ baseUrl, app }) => {
      const { client, transport } = await connect(baseUrl)
      try {
        clock += 50_000
        await client.listTools() // 刷新活动时间
        clock += 50_000 // 距 initialize 已 100 秒，但距上一次请求只有 50 秒
        await app.sweepIdleSessions()
        assert.equal(app.sessions.size, 1, 'TTL 要按最后一次活动算，不是按会话创建时间')

        clock += 61_000
        await app.sweepIdleSessions()
        assert.equal(app.sessions.size, 0)
      } finally {
        await transport.close().catch(() => undefined)
        await client.close().catch(() => undefined)
      }
    },
    { overrides: { sessionTtlMs: 60_000 }, now: () => clock },
  )
})

test('端口被占用时 listen() 必须 reject，而不是永不返回', async () => {
  const first = createHttpApp({ config: buildConfig(0), registry })
  const address = await first.listen()
  const second = createHttpApp({ config: buildConfig(address.port), registry })
  try {
    await assert.rejects(
      () => second.listen(),
      (error) => {
        assert.equal(error.code, 'EADDRINUSE')
        return true
      },
    )
  } finally {
    await second.close().catch(() => undefined)
    await first.close()
  }
})

test('healthz 仍不需要凭证，并如实报当前会话数', async () => {
  await withServer(async ({ baseUrl }) => {
    const { client, transport } = await connect(baseUrl)
    try {
      const health = await (await fetch(`${baseUrl}/healthz`)).json()
      assert.equal(health.status, 'ok')
      assert.equal(health.sessions, 1)
    } finally {
      await transport.close()
      await client.close()
    }
  })
})

test('工具带 annotations：客户端据此在花模型额度之前先问用户', () => {
  assert.equal(TOOL_DEFINITION.annotations?.readOnlyHint, false)
  assert.equal(TOOL_DEFINITION.annotations?.idempotentHint, false)
  assert.equal(TOOL_DEFINITION.annotations?.openWorldHint, true)
})
