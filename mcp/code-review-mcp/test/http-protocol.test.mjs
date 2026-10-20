import { strict as assert } from 'node:assert'
import test from 'node:test'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

import { createHttpApp } from '../src/http.mjs'
import { LOOKUP_TOOL_DEFINITION, TOOL_DEFINITION, TOOL_NAME } from '../src/tools.mjs'

const TOKEN = 'token-0123456789abcdef'
const OTHER_TOKEN = 'token-fedcba9876543210'

function buildConfig(port) {
  return {
    transport: 'http',
    http: {
      host: '127.0.0.1',
      port,
      path: '/mcp',
      tokens: [
        { name: 'alice', token: TOKEN },
        { name: 'bob', token: OTHER_TOKEN },
      ],
      allowAnonymous: false,
    },
  }
}

/** 记录每次工具调用的 registry 替身，用来断言调用方身份是从 HTTP 层传下去的。 */
function createStubRegistry() {
  const calls = []
  return {
    calls,
    definitions: [LOOKUP_TOOL_DEFINITION, TOOL_DEFINITION],
    async call(name, args, context) {
      calls.push({ name, args, context })
      return { content: [{ type: 'text', text: `ok:${context?.caller ?? 'none'}` }], isError: false }
    },
  }
}

async function withServer(run) {
  const registry = createStubRegistry()
  const app = createHttpApp({ config: buildConfig(0), registry })
  const address = await app.listen()
  const baseUrl = `http://127.0.0.1:${address.port}`
  try {
    await run({ baseUrl, registry, app })
  } finally {
    await app.close()
  }
}

async function connect(baseUrl, token) {
  const client = new Client({ name: 'test-client', version: '1.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  })
  await client.connect(transport)
  return { client, transport }
}

test('healthz 不需要凭证', async () => {
  await withServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/healthz`)
    assert.equal(response.status, 200)
    assert.equal((await response.json()).status, 'ok')
  })
})

test('没有凭证时连 initialize 都不处理，并回 401 + WWW-Authenticate', async () => {
  await withServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } },
      }),
    })
    assert.equal(response.status, 401)
    assert.match(response.headers.get('www-authenticate') ?? '', /Bearer/)
    const body = await response.json()
    assert.equal(body.error.code, -32001)
  })
})

test('凭证错误时同样拒绝', async () => {
  await withServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: 'Bearer nope',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    })
    assert.equal(response.status, 401)
  })
})

test('带凭证可以 initialize、列工具、调用工具', async () => {
  await withServer(async ({ baseUrl, registry }) => {
    const { client, transport } = await connect(baseUrl, TOKEN)
    try {
      const tools = await client.listTools()
      assert.equal(tools.tools.length, 2, '只读查询工具 + 提交工具')
      const submit = tools.tools.find((tool) => tool.name === TOOL_NAME)
      assert.ok(submit, '提交工具必须在清单里')
      // V1.66：story_code 与 story_codes 二选一，所以 required 为空；
      // "至少给一个编号"由服务端判（schema 表达不了 anyOf，见 tools.mjs 注释）。
      assert.deepEqual(submit.inputSchema.required, [])
      assert.ok('story_codes' in submit.inputSchema.properties, '多条编号参数必须对外可见')

      const result = await client.callTool({
        name: TOOL_NAME,
        arguments: {
          workspace_name: '灵基Foundation',
          story_code: 'F-123456',
          branch: 'feature_dev',
          commit_window_days: 21,
        },
      })
      assert.equal(result.content[0].text, 'ok:alice', '调用方身份必须来自校验过的凭证')
      assert.equal(registry.calls.length, 1)
      assert.equal(registry.calls[0].args.story_code, 'F-123456')
    } finally {
      await transport.close()
      await client.close()
    }
  })
})

test('会话与凭证绑定：换一个凭证复用 session id 会被拒', async () => {
  await withServer(async ({ baseUrl }) => {
    const { client, transport } = await connect(baseUrl, TOKEN)
    const sessionId = transport.sessionId
    assert.ok(sessionId, 'initialize 必须返回会话 id')
    try {
      const response = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          Authorization: `Bearer ${OTHER_TOKEN}`,
          'mcp-session-id': sessionId,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list', params: {} }),
      })
      assert.equal(response.status, 403)
    } finally {
      await transport.close()
      await client.close()
    }
  })
})

test('非 initialize 请求缺少会话 id 时明确报错', async () => {
  await withServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    })
    assert.equal(response.status, 400)
    assert.match((await response.json()).error.message, /Mcp-Session-Id/)
  })
})

test('未知路径回 404', async () => {
  await withServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/nope`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
    })
    assert.equal(response.status, 404)
  })
})
