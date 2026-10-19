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
 *
 *   # 只跑"提交前核对"这一步，看那张确认卡片；不会创建评审
 *   node scripts/live-check.mjs --url ... --token ... --submit \
 *     --story US-2026-017341 --branch feature_dev --window 7
 *
 *   # 看过卡片、确认无误之后，再加 --confirm 才真的提交
 *   node scripts/live-check.mjs --url ... --token ... --submit --confirm \
 *     --story US-2026-017341 --branch feature_dev --window 7
 *
 * --workspace 是可选的：项目组由平台按需求编号反查。
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

function parseArgs(argv) {
  const args = { submit: false, confirm: false }
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    const next = () => argv[(index += 1)]
    if (key === '--url') args.url = next()
    else if (key === '--token') args.token = next()
    else if (key === '--submit') args.submit = true
    else if (key === '--confirm') args.confirm = true
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
  if (!args.story || !args.branch || !args.window) {
    console.error('--submit 需要同时给出 --story --branch --window（--workspace 可选）')
    process.exit(2)
  }

  // 第一步：核对。不带 confirmation_token，所以**不会**创建任何评审。
  console.log(`\n→ 第一步（只核对，不提交）：${args.story}`)
  const preflight = await client.callTool({
    name: 'start_requirement_review',
    arguments: {
      story_code: args.story,
      branch: args.branch,
      commit_window_days: args.window,
      ...(args.workspace ? { workspace_name: args.workspace } : {}),
    },
  })
  const preflightText = (preflight.content ?? [])
    .filter((item) => item.type === 'text')
    .map((item) => item.text)
    .join('\n')
  console.log(preflightText)

  if (preflight.isError) {
    console.error('\n✘ 核对未通过，已停止（平台上没有创建任何评审）。')
    await finish()
    process.exit(1)
  }

  const token = /confirmation_token:\s*(\S+)/.exec(preflightText)?.[1]
  if (token === undefined || !token.startsWith('v1.')) {
    console.error('\n✘ 第一步没有返回可用的 confirmation_token，已停止。')
    await finish()
    process.exit(1)
  }

  if (!args.confirm) {
    console.log(
      '\n⏸ 到此为止。上面就是"提交前让用户确认"的那张卡片。' +
        '确认无误后再加 --confirm 重跑，才会真的提交并消耗模型额度。',
    )
    await finish()
    process.exit(0)
  }

  // 第二步：带令牌真正提交。
  console.log('\n→ 第二步（已确认，真实提交并消耗模型额度）')
  const result = await client.callTool({
    name: 'start_requirement_review',
    arguments: {
      story_code: args.story,
      branch: args.branch,
      commit_window_days: args.window,
      ...(args.workspace ? { workspace_name: args.workspace } : {}),
      confirmation_token: token,
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
