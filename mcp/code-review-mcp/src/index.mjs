#!/usr/bin/env node
/**
 * 入口。
 *
 * 默认起 Streamable HTTP（远程 MCP）；`CRP_MCP_TRANSPORT=stdio` 时退化成本机 stdio，
 * 便于在自己机器上先把链路跑通再暴露给别人。
 *
 * 日志一律走 stderr：stdio 模式下 stdout 是 MCP 协议通道，往里写一个字节就会让客户端
 * 解析失败。两种模式共用同一个 logger，避免"HTTP 模式能打日志、stdio 模式悄悄污染协议"。
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ConfigError, loadConfig } from './config.mjs'
import { PlatformClient } from './platform.mjs'
import { createToolRegistry } from './tools.mjs'
import { createMcpServer } from './server.mjs'
import { createHttpApp } from './http.mjs'

/** 结构化日志。只记编号、参数与调用方名字；不记凭证、不记需求正文。 */
function createLogger() {
  return (event, fields = {}) => {
    process.stderr.write(
      `${JSON.stringify({ ts: new Date().toISOString(), event, ...fields })}\n`,
    )
  }
}

async function main() {
  const logger = createLogger()

  let config
  try {
    config = loadConfig(process.env)
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`[配置错误] ${error.message}\n`)
      process.exit(2)
    }
    throw error
  }

  const client = new PlatformClient(config.platform)
  const registry = createToolRegistry({ client, config, logger })

  if (config.transport === 'stdio') {
    const server = createMcpServer(registry)
    await server.connect(new StdioServerTransport())
    logger('stdio_started', { platform: config.platform.url })
    return
  }

  const app = createHttpApp({ config, registry, logger })
  const address = await app.listen()
  logger('http_started', {
    url: `http://${config.http.host}:${config.http.port}${config.http.path}`,
    bound: typeof address === 'object' ? `${address.address}:${address.port}` : String(address),
    platform: config.platform.url,
    platform_account: config.platform.email,
    tokens: config.http.tokens.map((entry) => entry.name),
    anonymous_allowed: config.http.allowAnonymous,
  })
  if (config.http.allowAnonymous) {
    process.stderr.write(
      '[警告] CRP_MCP_ALLOW_NO_AUTH=true：任何能访问这个端口的人都可以提交评审任务并消耗模型额度。\n',
    )
  }

  const shutdown = async (signal) => {
    logger('shutdown', { signal })
    await app.close().catch(() => undefined)
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

main().catch((error) => {
  process.stderr.write(`[启动失败] ${String(error?.stack ?? error)}\n`)
  process.exit(1)
})
