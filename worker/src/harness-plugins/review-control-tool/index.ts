/**
 * The profile-local terminal tool for a code-review attempt.
 *
 * A plain MCP tool cannot end an agent turn: only a tool registered inside the
 * Harness process can call `exec.concludeTurn()`. That is why submission lives
 * here instead of in the snapshot MCP server.
 *
 * Ordering is the whole point of this tool:
 *   1. forward the submission to the Worker's attempt broker,
 *   2. the Worker validates evidence, lease and claim token and commits to the
 *      database inside one transaction,
 *   3. only a committed receipt calls concludeTurn().
 *
 * A rejected submission throws, which the tool registry turns into an error
 * result the model can read and correct. It never concludes the turn, so the
 * agent keeps working in the same session.
 */

import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { resolveCallerIdentity } from '../shared/agent-identity.js'
import { brokerPost, BrokerChannelError, withIdentity } from '../shared/broker-client.js'
import { BROKER_TOKEN_ENV, readCredentialFromEnv } from '../shared/credential-env.js'

export const name = 'review-control-tool'

export const inject = ['tools']

export interface ReviewControlConfig {
  socketPath: string
  taskId: string
  agentAttempt: number
  requestTimeoutMs?: number
}

export const Config: z<ReviewControlConfig> = z.object({
  socketPath: z.string().required(),
  taskId: z.string().required(),
  agentAttempt: z.number().required(),
  requestTimeoutMs: z.number(),
})

interface SubmitAccepted {
  accepted: true
  committedAt: string
  runId: string
}

interface SubmitRejected {
  accepted: false
  reason: string
  code?: string
}

type SubmitResponse = SubmitAccepted | SubmitRejected

const VERDICTS = ['IMPLEMENTED', 'PARTIAL', 'NOT_IMPLEMENTED', 'UNCERTAIN'] as const
const COMMIT_RELEVANCE_VERDICTS = ['RELATED', 'UNRELATED', 'UNCERTAIN'] as const
const COMMIT_RELEVANCE_REASONS = [
  'CODE_SEMANTIC_MATCH', 'MODULE_MATCH', 'CALL_CHAIN_MATCH', 'TEST_CHANGE_MATCH',
  'CONFIG_SCHEMA_MATCH', 'DIFFERENT_FEATURE', 'INSUFFICIENT_CONTEXT', 'DIFF_UNAVAILABLE',
  'REVERT_OR_REPLACEMENT_UNCLEAR',
] as const
const EXPANSION_REASONS = [
  'DEPENDENCY_LOOKUP', 'CALLER_CALLEE_TRACE', 'CONFIG_OR_SCHEMA_TRACE',
  'TEST_COVERAGE_TRACE', 'CANDIDATES_INSUFFICIENT', 'CROSS_REPOSITORY_CONTRACT',
  'VERIFY_REVERT_OR_REPLACEMENT',
] as const

export function apply(ctx: Context, config: ReviewControlConfig): void {
  async function callControl<T>(
    route: string,
    payload: Record<string, unknown>,
    execution: { harnessAgentId: string | undefined; toolCallId: string; toolName: string },
  ): Promise<T> {
    const identity = await resolveCallerIdentity(execution.harnessAgentId, `this ${execution.toolName} call`)
    if (!identity) throw new Error(`${execution.toolName} has no verifiable agent identity`)
    let response
    try {
      response = await brokerPost<(T & { accepted?: boolean; reason?: string; code?: string })>(
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
            toolCallId: execution.toolCallId,
            toolName: execution.toolName,
          },
          payload,
        ),
      )
    } catch (err) {
      const code = err instanceof BrokerChannelError ? err.code : 'BROKER_UNAVAILABLE'
      throw new Error(`${execution.toolName} could not reach the review broker (${code})`)
    }
    if (response.status !== 200 || response.body?.accepted === false) {
      throw new Error(response.body?.reason ?? `broker refused ${execution.toolName} (status ${response.status})`)
    }
    return response.body as T
  }

  ctx.tools.register(
    defineTool({
      name: 'submit_commit_relevance_verdict',
      description:
        'Submit one machine-readable relevance verdict for a frozen AI candidate. candidateId and diffAccessIds must come from list_story_commits/read_story_commit_diff; task ids, generations, hashes, and commit SHAs are intentionally not accepted.',
      parameters: {
        candidateId: { type: 'string', required: true },
        verdict: { type: 'string', required: true, enum: [...COMMIT_RELEVANCE_VERDICTS] },
        reasonCodes: { type: 'array', required: true, items: { type: 'string', enum: [...COMMIT_RELEVANCE_REASONS] } },
        confidence: { type: 'number', required: true, description: 'Number from 0 to 1.' },
        diffAccessIds: { type: 'array', required: true, items: { type: 'string' } },
        summary: { type: 'string', required: true, description: 'At most 500 characters.' },
        requestedExpansion: {
          type: 'object',
          description: 'Optional expansion already recorded through expand_analysis_scope.',
          additionalProperties: false,
          properties: {
            targetLevel: { type: 'string', required: true, enum: ['RELATED', 'GLOBAL'] },
            reasonCode: { type: 'string', required: true, enum: [...EXPANSION_REASONS] },
          },
        },
      },
      output: {
        schema: {
          type: 'object', additionalProperties: false,
          properties: {
            accepted: { type: 'boolean', required: true },
            candidateId: { type: 'string', required: true },
            completedCount: { type: 'integer', required: true },
            requiredCount: { type: 'integer', required: true },
            triageComplete: { type: 'boolean', required: true },
          },
        },
        render: (_args, value) => {
          const result = value as { candidateId: string; completedCount: number; requiredCount: number; triageComplete: boolean }
          return [{ type: 'text', text: `Recorded ${result.candidateId}: ${result.completedCount}/${result.requiredCount}; triageComplete=${result.triageComplete}` }]
        },
      },
      async execute(args, exec) {
        exec.signal.throwIfAborted()
        return callControl('/attempt/submit-commit-relevance', args as Record<string, unknown>, {
          harnessAgentId: exec.agent?.id,
          toolCallId: String(exec.callId),
          toolName: 'submit_commit_relevance_verdict',
        })
      },
      presentCall: (args) => ({ card: 'generic', title: 'Submit commit relevance', kind: 'other', rawInput: args }),
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'expand_analysis_scope',
      description:
        'Monotonically expand this story analysis from PRIMARY to RELATED/GLOBAL, or RELATED to GLOBAL, with an auditable reason. It cannot narrow scope.',
      parameters: {
        targetLevel: { type: 'string', required: true, enum: ['RELATED', 'GLOBAL'] },
        reasonCode: { type: 'string', required: true, enum: [...EXPANSION_REASONS] },
      },
      output: {
        schema: {
          type: 'object', additionalProperties: false,
          properties: {
            expanded: { type: 'boolean', required: true },
            fromLevel: { type: 'string', required: true },
            currentLevel: { type: 'string', required: true },
            reasonCode: { type: 'string', required: true },
          },
        },
        render: (_args, value) => {
          const result = value as { fromLevel: string; currentLevel: string; reasonCode: string }
          return [{ type: 'text', text: `Scope expanded ${result.fromLevel} -> ${result.currentLevel} (${result.reasonCode}).` }]
        },
      },
      async execute(args, exec) {
        exec.signal.throwIfAborted()
        return callControl('/attempt/expand-analysis-scope', args as Record<string, unknown>, {
          harnessAgentId: exec.agent?.id,
          toolCallId: String(exec.callId),
          toolName: 'expand_analysis_scope',
        })
      },
      presentCall: (args) => ({ card: 'generic', title: 'Expand analysis scope', kind: 'other', rawInput: args }),
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'submit_review_result',
      description:
        'Submit the final review verdict for this story. Call it exactly once, after you have gathered evidence from the repository snapshots. Every evidence item must reference a range you actually read. If the submission is rejected, read the reason, fix the problem, and call this tool again.',
      parameters: {
        verdict: {
          type: 'string',
          required: true,
          enum: [...VERDICTS],
          description:
            'IMPLEMENTED / PARTIAL require at least one existing-implementation evidence item. NOT_IMPLEMENTED requires complete search coverage; use UNCERTAIN when coverage is incomplete.',
        },
        confidence: {
          type: 'integer',
          required: true,
          description: 'Confidence from 0 to 100.',
        },
        summary: { type: 'string', required: true, description: 'Short conclusion.' },
        implementedItems: { type: 'array', required: true, description: 'Implemented findings as single-line points. Use [] if none; do not include numbers, bullets, or line breaks.', items: { type: 'string' } },
        missingItems: { type: 'array', required: true, description: 'Missing findings as single-line points. Use [] if none; do not include numbers, bullets, or line breaks.', items: { type: 'string' } },
        riskItems: { type: 'array', required: true, description: 'Risk findings as single-line points. Use [] if none; do not include numbers, bullets, or line breaks.', items: { type: 'string' } },
        testPointItems: { type: 'array', required: true, description: 'Test suggestions as single-line points. Use [] if none; do not include numbers, bullets, or line breaks.', items: { type: 'string' } },
        remarkItems: { type: 'array', required: true, description: 'Additional remarks as single-line points. Use [] if none; do not include numbers, bullets, or line breaks.', items: { type: 'string' } },
        evidence: {
          type: 'array',
          required: true,
          description: 'Evidence items, each referencing a range you actually read.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              evidenceId: {
                type: 'string',
                required: true,
                description: 'The id returned by the tool call that showed you this range.',
              },
              repository: { type: 'string', required: true },
              filePath: { type: 'string', required: true },
              startLine: { type: 'integer', required: true },
              endLine: { type: 'integer', required: true },
              evidenceType: { type: 'string', required: true },
              evidenceSummary: {
                type: 'string',
                required: true,
                description: 'A single-line 8–80 character statement of what this code evidence proves. Do not repeat the repository, path, symbol, or line numbers.',
              },
              description: { type: 'string', required: true },
            },
          },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            committed: { type: 'boolean', required: true },
            runId: { type: 'string', required: true },
            committedAt: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [
          {
            type: 'text',
            text: `Review committed (run ${(value as { runId: string }).runId}). Stop now; the task is complete.`,
          },
        ],
      },
      async execute(args, exec) {
        exec.signal.throwIfAborted()

        // 第一层 root-only：工具本身要求出示身份。子 Agent 即使知道工具名，也只能出示
        // 自己的 capability，而它不含 submitReview 能力，Broker 会拒。
        // 失败带原因往上走：提交路径上"身份为什么解析不出来"是必须留痕的。
        const identity = await resolveCallerIdentity(exec.agent?.id, 'this submission')
        if (!identity) {
          throw new Error(
            'this submission has no verifiable agent identity and cannot be committed',
          )
        }

        let response
        try {
          response = await brokerPost<SubmitResponse>(
            {
              socketPath: config.socketPath,
              token: readCredentialFromEnv(BROKER_TOKEN_ENV),
              timeoutMs: config.requestTimeoutMs ?? 30000,
            },
            '/attempt/submit-review',
            withIdentity(
              { taskId: config.taskId, agentAttempt: config.agentAttempt },
              {
                agentCapability: identity.agentCapability,
                agentId: identity.agentId,
                sessionId: identity.sessionId,
                toolCallId: String(exec.callId),
                toolName: 'submit_review_result',
              },
              {
                submission: args as Record<string, unknown>,
              },
            ),
          )
        } catch (err) {
          // Transport/lease failures are not model-correctable: surface the
          // stable code and let the Worker fail the attempt.
          const code = err instanceof BrokerChannelError ? err.code : 'BROKER_UNAVAILABLE'
          throw new Error(
            `submission could not reach the review broker (${code}); this attempt cannot be committed`,
          )
        }

        const body = response.body
        if (response.status !== 200 || !body?.accepted) {
          const rejection = body as SubmitRejected | undefined
          const reason = rejection?.reason ?? `broker rejected the submission (status ${response.status})`
          // Model-correctable: no concludeTurn, so the agent keeps working.
          throw new Error(reason)
        }

        // Committed in the database. Only now may the turn end.
        exec.concludeTurn()
        return {
          committed: true,
          runId: body.runId,
          committedAt: body.committedAt,
        }
      },
      presentCall: (args) => ({
        card: 'generic',
        title: 'Submit review result',
        kind: 'other',
        rawInput: args,
      }),
    }),
  )
}
