/**
 * OpenAICompatibleHarness: the MVP ReviewHarness backed by an OpenAI-compatible
 * chat API with tool calling. (Plan §10, §11, §12, §12.4)
 *
 * Stage one exposes the four read-only tools and iterates up to a tool-call
 * limit. Stage two uses only frozen snippets. Both stages validate structured
 * JSON and allow ONE in-stage repair before failing.
 */

import {
  OpenAICompatibleClient,
  ModelError,
  extractJsonObject,
  type ChatMessage,
  type ToolDef,
} from './openai-compatible.js'
import {
  validateRetrievalResult,
  validateAnalysisResult,
  validateEvidenceAgainstAllowedRanges,
  SchemaError,
  RETRIEVAL_LIMITS,
  type RetrievalResult,
  type AnalysisResult,
} from './schemas.js'
import {
  RETRIEVAL_SYSTEM_PROMPT,
  buildRetrievalUserPrompt,
} from './prompts/retrieval-v1.js'
import {
  ANALYSIS_SYSTEM_PROMPT,
  buildAnalysisUserPrompt,
} from './prompts/analysis-v1.js'
import type {
  AnalysisInput,
  ReviewHarness,
  RetrievalInput,
  RetrievalTools,
} from './harness.js'

const RETRIEVAL_TOOLS: ToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'searchCode',
      description: 'Search code text in one whitelisted repository (ripgrep, fixed strings).',
      parameters: {
        type: 'object',
        properties: {
          repository: { type: 'string' },
          query: { type: 'string' },
          pathGlob: { type: 'string' },
          maxResults: { type: 'number' },
        },
        required: ['repository', 'query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'findFiles',
      description: 'List files matching a glob in one whitelisted repository.',
      parameters: {
        type: 'object',
        properties: {
          repository: { type: 'string' },
          pattern: { type: 'string' },
          maxResults: { type: 'number' },
        },
        required: ['repository', 'pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'readCode',
      description: 'Read a bounded line range from a file in one whitelisted repository.',
      parameters: {
        type: 'object',
        properties: {
          repository: { type: 'string' },
          path: { type: 'string' },
          startLine: { type: 'number' },
          endLine: { type: 'number' },
        },
        required: ['repository', 'path', 'startLine', 'endLine'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'gitLog',
      description: 'Search commit history of one whitelisted repository.',
      parameters: {
        type: 'object',
        properties: {
          repository: { type: 'string' },
          query: { type: 'string' },
          maxResults: { type: 'number' },
        },
        required: ['repository', 'query'],
      },
    },
  },
]

export interface HarnessDeps {
  client: OpenAICompatibleClient
}

export class OpenAICompatibleHarness implements ReviewHarness {
  private client: OpenAICompatibleClient

  constructor(deps: HarnessDeps) {
    this.client = deps.client
  }

  async retrieve(input: RetrievalInput, tools: RetrievalTools): Promise<RetrievalResult> {
    const messages: ChatMessage[] = [
      { role: 'system', content: RETRIEVAL_SYSTEM_PROMPT },
      {
        role: 'user',
        content: buildRetrievalUserPrompt({
          story: input.story,
          branch: input.branch,
          repositories: input.repositories,
        }),
      },
    ]

    let toolCalls = 0
    // Iterate: model may call tools until it produces a final message.
    for (let step = 0; step <= RETRIEVAL_LIMITS.maxToolCalls + 1; step++) {
      const result = await this.client.createChatCompletion({
        messages,
        tools: RETRIEVAL_TOOLS,
      })
      const msg = result.message
      messages.push({ role: 'assistant', content: msg.content, tool_calls: msg.tool_calls })

      if (msg.tool_calls && msg.tool_calls.length > 0) {
        for (const call of msg.tool_calls) {
          toolCalls++
          const output =
            toolCalls > RETRIEVAL_LIMITS.maxToolCalls
              ? { error: 'tool call limit reached; produce final JSON now' }
              : await this.dispatchTool(call.function.name, call.function.arguments, tools)
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            name: call.function.name,
            content: JSON.stringify(output),
          })
        }
        continue
      }

      // Final message — parse and validate, allow one repair.
      return this.parseWithRepair(
        msg.content,
        messages,
        (raw) => validateRetrievalResult(raw, input.story.code),
        'RETRIEVAL_SCHEMA_INVALID',
      )
    }
    throw new ModelError('retrieval did not converge', 'RETRIEVAL_SCHEMA_INVALID', false)
  }

  async analyze(input: AnalysisInput): Promise<AnalysisResult> {
    const messages: ChatMessage[] = [
      { role: 'system', content: ANALYSIS_SYSTEM_PROMPT },
      {
        role: 'user',
        content: buildAnalysisUserPrompt({
          story: input.story,
          branch: input.branch,
          repositorySnapshots: input.repositorySnapshots,
          retrieval: input.retrieval,
          snippets: input.snippets,
        }),
      },
    ]
    const result = await this.client.createChatCompletion({
      messages,
      responseFormatJson: true,
    })
    messages.push({ role: 'assistant', content: result.message.content })
    return this.parseWithRepair(
      result.message.content,
      messages,
      (raw) => {
        const analysis = validateAnalysisResult(raw, input.story.code)
        validateEvidenceAgainstAllowedRanges(analysis, input.snippets)
        return analysis
      },
      'ANALYSIS_SCHEMA_INVALID',
    )
  }

  /**
   * Parse+validate JSON; on failure ask the model to fix once, then re-validate.
   * (Plan §12.4: schema failure may be repaired once, otherwise the task fails.)
   */
  private async parseWithRepair<T>(
    content: string | null,
    messages: ChatMessage[],
    validate: (raw: unknown) => T,
    code: string,
  ): Promise<T> {
    try {
      return validate(extractJsonObject(content))
    } catch (firstErr) {
      const reason = firstErr instanceof SchemaError ? firstErr.message : String((firstErr as Error)?.message)
      messages.push({
        role: 'user',
        content: `你上一次的输出不符合要求：${reason}。请仅返回符合规定结构的 JSON，不要包含其他文字。`,
      })
      const repair = await this.client.createChatCompletion({
        messages,
        responseFormatJson: true,
      })
      try {
        return validate(extractJsonObject(repair.message.content))
      } catch (secondErr) {
        const msg = secondErr instanceof SchemaError ? secondErr.message : String((secondErr as Error)?.message)
        const finalCode = secondErr instanceof SchemaError ? secondErr.code : code
        throw new SchemaError(`output still invalid after one repair: ${msg}`, finalCode)
      }
    }
  }

  private async dispatchTool(
    name: string,
    argsJson: string,
    tools: RetrievalTools,
  ): Promise<unknown> {
    let args: Record<string, unknown>
    try {
      args = JSON.parse(argsJson || '{}')
    } catch {
      return { error: 'invalid tool arguments JSON' }
    }
    try {
      switch (name) {
        case 'searchCode':
          return await tools.searchCode(args as never)
        case 'findFiles':
          return await tools.findFiles(args as never)
        case 'readCode':
          return await tools.readCode(args as never)
        case 'gitLog':
          return await tools.gitLog(args as never)
        default:
          return { error: `unknown tool: ${name}` }
      }
    } catch (err) {
      // Tool errors (path policy, whitelist) are returned to the model, not fatal.
      return { error: (err as Error)?.message ?? 'tool failed' }
    }
  }
}
