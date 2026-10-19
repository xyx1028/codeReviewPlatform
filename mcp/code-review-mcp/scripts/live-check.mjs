#!/usr/bin/env node
/**
 * 远程 MCP 自检。
 *
 * 用真正的 MCP 客户端连一次已经跑起来的服务，确认"别人在 Qoder/Codex 里填这个地址 +
 * 凭证"这条链路通。默认**只读**（initialize + tools/list）；加 --submit 才会真的提交一次
 * 评审 —— 那会在平台上建一个批次并消耗模型额度，所以必须显式要求。
 *
 * 用法：
 *   node scripts/live-check.mjs --url http://127.0.0.1:8848/mcp --token <凭证>
 *   node scripts/live-check.mjs --url ... --token ... --submit \
 *     --workspace "灵基Foundation" --story F-123456 --branch feature_dev --window 21
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

function parseArgs(argv) {
  const args = { submit: false }
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    const next = () => argv[(index += 1)]
    if (key === '--url') args.url = next()
    else if (key === '--token') args.token = next()
    else if (key === '--submit') args.submit = true
    else if (key === '--workspace') args.workspace = next()
    else if (key === '--story') args.story = next()
    else if (key === '--branch') args.branch = next()
    else if (key === '--window') args.window = Number(next())
  }
  return args
}

const args = parseArgs(process.argv.slice(2))
if (!args.url) {
  console.error('缺少 --url，例如 --url http://127.0.0.1:8848/mcp')
  process.exit(2)
}

const client = new Client({ name: 'codereview-mcp-live-check', version: '0.1.0' })
const transport = new StreamableHTTPClientTransport(new URL(args.url), {
  requestInit: args.token ? { headers: { Authorization: `Bearer ${args.token}` } } : undefined,
})

await client.connect(transport)
console.log('✔ initialize 成功')
console.log('  服务端信息：', JSON.stringify(client.getServerVersion()))
console.log('  会话 id：', transport.sessionId ?? '(无)')

const tools = await client.listTools()
console.log(`✔ tools/list 成功，共 ${tools.tools.length} 个工具`)
for (const tool of tools.tools) {
  console.log(`  - ${tool.name}：必填参数 ${JSON.stringify(tool.inputSchema?.required ?? [])}`)
}

/**
 * 收尾。
 *
 * 必须显式 `terminateSession()`（协议上就是一个 `DELETE`）：只 `close()` 不发 DELETE 的话，
 * 服务端那个会话会一直留到空闲超时。自检本身不该在服务端堆东西。
 */
async function finish() {
  await transport.terminateSession().catch(() => undefined)
  await transport.close().catch(() => undefined)
  await client.close().catch(() => undefined)
}

if (args.submit) {
  if (!args.workspace || !args.story || !args.branch || !args.window) {
    console.error('--submit 需要同时给出 --workspace --story --branch --window')
    process.exit(2)
  }
  console.log(`\n→ 真实提交一次评审：${args.story}（${args.workspace}）`)
  const result = await client.callTool({
    name: 'start_requirement_review',
    arguments: {
      workspace_name: args.workspace,
      story_code: args.story,
      branch: args.branch,
      commit_window_days: args.window,
    },
  })
  console.log(result.isError ? '✘ 提交失败：' : '✔ 提交成功：')
  for (const item of result.content ?? []) {
    if (item.type === 'text') console.log(item.text)
  }
  if (result.isError) {
    await finish()
    process.exit(1)
  }
}

await finish()
