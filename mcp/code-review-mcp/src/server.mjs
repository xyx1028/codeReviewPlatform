/**
 * MCP Server 实例。
 *
 * 用低层 Server 而不是 McpServer：工具入参是手写 JSON Schema，少一个 zod 依赖，
 * 也少一处"SDK 换了校验库"的牵连。
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

export const SERVER_INFO = { name: 'codereview-mcp', version: '0.1.0' }

const INSTRUCTIONS = [
  '这台服务连接的是「需求开发评审一致性平台」，只能做一件事：把指定的一条需求提交去做代码评审。',
  '用户说"帮我评审某个需求"时，收集四个参数（项目组、需求编号、目标分支、提交时间窗口）后调用',
  'start_requirement_review。提交会真实消耗模型额度且耗时较长；受理成功后把平台链接转述给用户并结束，',
  '不要轮询、不要重复提交 —— 本服务不提供进度与结果查询。',
].join('')

export function createMcpServer(registry) {
  const server = new Server(SERVER_INFO, {
    capabilities: { tools: {} },
    instructions: INSTRUCTIONS,
  })

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: registry.definitions }))
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) =>
    registry.call(request.params.name, request.params.arguments ?? {}, {
      // 调用方身份来自 HTTP 层校验过的访问凭证；模型无法伪造。
      caller: extra?.authInfo?.clientId ?? null,
    }),
  )

  return server
}
