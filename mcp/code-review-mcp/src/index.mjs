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
import { EnvFileError, loadEnvFileIfPresent } from './env.mjs'
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
  try {
    const file = loadEnvFileIfPresent()
    if (file !== null) logger('env_file_loaded', { file })
  } catch (error) {
    if (error instanceof EnvFileError) {
      process.stderr.write(`[配置错误] ${error.message}\n`)
      process.exit(2)
    }
    throw error
  }

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
  const registry = createToolRegistry({ client, config, logger, settle: config.settle })

  if (config.transport === 'stdio') {
    const server = createMcpServer(registry)
    await server.connect(new StdioServerTransport())
    logger('stdio_started', { platform: config.platform.url })
    return
  }

  const app = createHttpApp({ config, registry, logger })
  let address
  try {
    address = await app.listen()
  } catch (error) {
    if (error?.code === 'EADDRINUSE') {
      process.stderr.write(
        `[启动失败] 端口 ${config.http.port} 已被占用。先停掉占用它的进程` +
          `（macOS/Linux：lsof -nP -iTCP:${config.http.port} -sTCP:LISTEN），` +
          '或改 CRP_MCP_PORT 换一个端口。\n',
      )
      process.exit(2)
    }
    if (error?.code === 'EACCES') {
      process.stderr.write(
        `[启动失败] 没有权限监听端口 ${config.http.port}（1024 以下的端口需要特权）。` +
          '请改 CRP_MCP_PORT，或由反向代理把 443 转发到这个端口。\n',
      )
      process.exit(2)
    }
    if (error?.code === 'EADDRNOTAVAIL') {
      process.stderr.write(
        `[启动失败] 本机没有地址 ${config.http.host}，无法监听。请检查 CRP_MCP_HOST。\n`,
      )
      process.exit(2)
    }
    throw error
  }
  logger('http_started', {
    url: `http://${config.http.host}:${config.http.port}${config.http.path}`,
    bound: typeof address === 'object' ? `${address.address}:${address.port}` : String(address),
    platform: config.platform.url,
    platform_account: config.platform.email,
    tokens: config.http.tokens.map((entry) => entry.name),
    anonymous_allowed: config.http.allowAnonymous,
    session_ttl_ms: config.http.sessionTtlMs,
    max_sessions: config.http.maxSessions,
    allowed_origins: config.http.allowedOrigins,
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
