/**
 * The read-only repository tools offered to a review agent.
 *
 * These are profile-local Harness tools rather than a separate MCP server
 * process. The security boundary is unchanged and it is the broker, not the
 * tool: this plugin holds only a Unix socket path and a per-attempt token, and
 * every read is resolved by the worker against an exact commit object. Keeping
 * them in-process removes one child process, one transport and one cleanup path
 * per attempt.
 *
 * `read_snapshot_code` returns an `evidenceId`. That id is the only thing the
 * final submission may cite, which is what ties a claim to a range the platform
 * actually showed.
 */

import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { resolveCallerIdentity } from '../shared/agent-identity.js'
import { brokerPost, BrokerChannelError, withIdentity } from '../shared/broker-client.js'
import { BROKER_TOKEN_ENV, readCredentialFromEnv } from '../shared/credential-env.js'

export const name = 'snapshot-tools'

export const inject = ['tools']

export interface SnapshotToolsConfig {
  socketPath: string
  taskId: string
  agentAttempt: number
  requestTimeoutMs?: number
  /** Repository names the job pinned, used for the tool descriptions. */
  repositories?: string[]
}

export const Config: z<SnapshotToolsConfig> = z.object({
  socketPath: z.string().required(),
  taskId: z.string().required(),
  agentAttempt: z.number().required(),
  requestTimeoutMs: z.number(),
  repositories: z.array(z.string()),
})

interface BrokerRejection {
  accepted?: false
  code?: string
  reason?: string
}

export function apply(ctx: Context, config: SnapshotToolsConfig): void {
  const repoHint =
    config.repositories && config.repositories.length > 0
      ? ` Allowed repositories: ${config.repositories.join(', ')}.`
      : ''

  /**
   * One broker round trip, with model-correctable failures thrown as errors.
   *
   * V4 起每次调用都带调用者身份：Broker 用 capability token 判定这个 Agent 是否有
   * snapshotRead 能力，并把读取到的范围归属到它名下（root 汇总时才能证明证据的生产者
   * 属于当前 Agent Tree）。
   */
  async function call<T>(
    route: string,
    payload: Record<string, unknown>,
    context: { harnessAgentId: string | undefined; toolName: string; toolCallId: string },
  ): Promise<T> {
    // 失败带原因往上走，不再吞掉：见 resolveCallerIdentity 的说明。
    const identity = await resolveCallerIdentity(context.harnessAgentId, 'this snapshot call')
    if (!identity) {
      throw new Error(
        'this call has no verifiable agent identity; the snapshot service refused it',
      )
    }
    let response
    try {
      response = await brokerPost<T & BrokerRejection>(
        {
          socketPath: config.socketPath,
          token: readCredentialFromEnv(BROKER_TOKEN_ENV),
          timeoutMs: config.requestTimeoutMs ?? 30000,
        },
        route,
        withIdentity(
          { taskId: config.taskId, agentAttempt: config.agentAttempt },
          {
            agentCapability: identity.agentCapability,
            agentId: identity.agentId,
            sessionId: identity.sessionId,
            toolCallId: context.toolCallId,
            toolName: context.toolName,
          },
          payload,
        ),
      )
    } catch (err) {
      const code = err instanceof BrokerChannelError ? err.code : 'BROKER_UNAVAILABLE'
      throw new Error(`snapshot service unreachable (${code}); this attempt cannot continue`)
    }

    if (response.status !== 200) {
      const rejection = response.body as BrokerRejection | undefined
      throw new Error(
        rejection?.reason ?? `snapshot service refused the call (status ${response.status})`,
      )
    }
    return response.body as T
  }

  ctx.tools.register(
    defineTool({
      name: 'search_snapshot_code',
      description: `Search one repository at the commit pinned for this job, using fixed-string matching (not a regex).${repoHint} Results are capped; a truncated result set cannot prove that something is absent.`,
      parameters: {
        repository: { type: 'string', required: true, description: 'Repository name.' },
        query: {
          type: 'string',
          required: true,
          description: 'Literal text to find, for example a class, endpoint or column name.',
        },
        pathGlob: {
          type: 'string',
          description: 'Optional path filter, for example "src/**/*.java".',
        },
        maxResults: { type: 'integer', description: 'Maximum hits to return (default 50).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            hits: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  repository: { type: 'string', required: true },
                  filePath: { type: 'string', required: true },
                  lineNumber: { type: 'integer', required: true },
                  lineText: { type: 'string', required: true },
                },
              },
            },
            truncated: { type: 'boolean', required: true },
            total: { type: 'integer', required: true },
          },
        },
        render: (_args, value) => {
          const result = value as {
            hits: Array<{ filePath: string; lineNumber: number; lineText: string }>
            truncated: boolean
            total: number
          }
          if (result.hits.length === 0) {
            return [{ type: 'text', text: 'No matches at the pinned commit.' }]
          }
          const lines = result.hits.map(
            (hit) => `${hit.filePath}:${hit.lineNumber}: ${hit.lineText}`,
          )
          const suffix = result.truncated
            ? `\n(truncated: ${result.total} matches found, narrow the query before concluding anything)`
            : ''
          return [{ type: 'text', text: lines.join('\n') + suffix }]
        },
      },
      async execute(args, exec) {
        exec.signal.throwIfAborted()
        return call('/attempt/search-code', args as Record<string, unknown>, {
          harnessAgentId: exec.agent?.id,
          toolName: 'search_snapshot_code',
          toolCallId: String(exec.callId),
        })
      },
      presentCall: (args) => ({
        card: 'generic',
        title: 'Search snapshot',
        kind: 'search',
        rawInput: args,
      }),
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'find_snapshot_files',
      description: `List files in one repository at the pinned commit whose path matches a glob.${repoHint}`,
      parameters: {
        repository: { type: 'string', required: true, description: 'Repository name.' },
        pattern: {
          type: 'string',
          required: true,
          description: 'Path glob, for example "**/OrderService.java".',
        },
        maxResults: { type: 'integer', description: 'Maximum paths to return (default 200).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            repository: { type: 'string', required: true },
            paths: { type: 'array', required: true, items: { type: 'string' } },
            truncated: { type: 'boolean', required: true },
            total: { type: 'integer', required: true },
          },
        },
        render: (_args, value) => {
          const result = value as { paths: string[]; truncated: boolean; total: number }
          if (result.paths.length === 0) {
            return [{ type: 'text', text: 'No matching paths at the pinned commit.' }]
          }
          const suffix = result.truncated ? `\n(truncated: ${result.total} paths matched)` : ''
          return [{ type: 'text', text: result.paths.join('\n') + suffix }]
        },
      },
      async execute(args, exec) {
        exec.signal.throwIfAborted()
        return call('/attempt/find-files', args as Record<string, unknown>, {
          harnessAgentId: exec.agent?.id,
          toolName: 'find_snapshot_files',
          toolCallId: String(exec.callId),
        })
      },
      presentCall: (args) => ({
        card: 'generic',
        title: 'Find snapshot files',
        kind: 'search',
        rawInput: args,
      }),
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'read_snapshot_code',
      description: `Read a bounded line range from one file at the pinned commit.${repoHint} The returned evidenceId is the ONLY value submit_review_result accepts as evidence, so read every range you intend to cite.`,
      parameters: {
        repository: { type: 'string', required: true, description: 'Repository name.' },
        path: {
          type: 'string',
          required: true,
          description: 'Repository-relative file path.',
        },
        startLine: { type: 'integer', required: true, description: 'First line, 1-based.' },
        endLine: {
          type: 'integer',
          required: true,
          description: 'Last line, inclusive. At most 200 lines are returned.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            evidenceId: { type: 'string', required: true },
            repository: { type: 'string', required: true },
            filePath: { type: 'string', required: true },
            startLine: { type: 'integer', required: true },
            endLine: { type: 'integer', required: true },
            totalLines: { type: 'integer', required: true },
            truncated: { type: 'boolean', required: true },
            content: { type: 'string', required: true },
          },
        },
        render: (_args, value) => {
          const result = value as {
            evidenceId: string
            filePath: string
            startLine: number
            endLine: number
            totalLines: number
            truncated: boolean
            content: string
          }
          const header = `${result.filePath} lines ${result.startLine}-${result.endLine} of ${result.totalLines} (evidenceId: ${result.evidenceId}${result.truncated ? ', truncated' : ''})`
          return [{ type: 'text', text: `${header}\n${result.content}` }]
        },
      },
      async execute(args, exec) {
        exec.signal.throwIfAborted()
        return call('/attempt/read-code', args as Record<string, unknown>, {
          harnessAgentId: exec.agent?.id,
          toolName: 'read_snapshot_code',
          toolCallId: String(exec.callId),
        })
      },
      presentCall: (args) => ({
        card: 'generic',
        title: 'Read snapshot range',
        kind: 'read',
        rawInput: args,
      }),
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'list_snapshot_commits',
      description: `List commits reachable from the pinned commit, optionally filtered by message text or path.${repoHint} Useful for finding when a feature landed.`,
      parameters: {
        repository: { type: 'string', required: true, description: 'Repository name.' },
        query: { type: 'string', description: 'Literal text to match in commit messages.' },
        pathGlob: { type: 'string', description: 'Optional path filter.' },
        maxResults: { type: 'integer', description: 'Maximum commits to return (default 50).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            commits: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  sha: { type: 'string', required: true },
                  subject: { type: 'string', required: true },
                  author: { type: 'string', required: true },
                  date: { type: 'string', required: true },
                },
              },
            },
          },
        },
        render: (_args, value) => {
          const result = value as {
            commits: Array<{ sha: string; subject: string; author: string; date: string }>
          }
          if (result.commits.length === 0) {
            return [{ type: 'text', text: 'No matching commits.' }]
          }
          return [
            {
              type: 'text',
              text: result.commits
                .map(
                  (commit) =>
                    `${commit.sha.slice(0, 12)} ${commit.date} ${commit.author}: ${commit.subject}`,
                )
                .join('\n'),
            },
          ]
        },
      },
      async execute(args, exec) {
        exec.signal.throwIfAborted()
        return call('/attempt/list-commits', args as Record<string, unknown>, {
          harnessAgentId: exec.agent?.id,
          toolName: 'list_snapshot_commits',
          toolCallId: String(exec.callId),
        })
      },
      presentCall: (args) => ({
        card: 'generic',
        title: 'List snapshot commits',
        kind: 'search',
        rawInput: args,
      }),
    }),
  )
}
