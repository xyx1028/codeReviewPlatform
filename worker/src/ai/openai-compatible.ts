/**
 * Minimal OpenAI-compatible chat client. (Plan §10, §12.4, §13.4, §19)
 *
 * - Calls POST {baseUrl}/chat/completions with tools support.
 * - Retries on 429 / 5xx / timeout with exponential backoff (2 retries).
 * - Never logs Authorization headers or the API key.
 * - Maps failures to plan error codes.
 */

import { redactString } from '../security/redaction.js'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: ToolCall[]
  tool_call_id?: string
  name?: string
}

export interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface ToolDef {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export interface ChatChoiceMessage {
  role: 'assistant'
  content: string | null
  tool_calls?: ToolCall[]
}

export interface ChatCompletionResult {
  message: ChatChoiceMessage
  finishReason: string | null
}

export class ModelError extends Error {
  code: string
  retriable: boolean
  constructor(message: string, code: string, retriable: boolean) {
    super(message)
    this.name = 'ModelError'
    this.code = code
    this.retriable = retriable
  }
}

export interface OpenAICompatibleOptions {
  baseUrl: string
  modelName: string
  apiKey: string
  timeoutMs: number
  maxRetries?: number
  /** Injected for testing. Defaults to global fetch. */
  fetchImpl?: typeof fetch
  /** Injected for testing. Defaults to real setTimeout-based sleep. */
  sleepImpl?: (ms: number) => Promise<void>
}

export interface CreateChatParams {
  messages: ChatMessage[]
  tools?: ToolDef[]
  temperature?: number
  responseFormatJson?: boolean
}

export class OpenAICompatibleClient {
  private baseUrl: string
  private modelName: string
  private apiKey: string
  private timeoutMs: number
  private maxRetries: number
  private fetchImpl: typeof fetch
  private sleepImpl: (ms: number) => Promise<void>

  constructor(opts: OpenAICompatibleOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '')
    this.modelName = opts.modelName
    this.apiKey = opts.apiKey
    this.timeoutMs = opts.timeoutMs
    this.maxRetries = opts.maxRetries ?? 2
    this.fetchImpl = opts.fetchImpl ?? fetch
    this.sleepImpl = opts.sleepImpl ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  }

  /**
   * Perform one chat completion with retry on transient failures.
   */
  async createChatCompletion(params: CreateChatParams): Promise<ChatCompletionResult> {
    const url = `${this.baseUrl}/chat/completions`
    const body: Record<string, unknown> = {
      model: this.modelName,
      messages: params.messages,
      temperature: params.temperature ?? 0,
    }
    if (params.tools && params.tools.length > 0) {
      body.tools = params.tools
      body.tool_choice = 'auto'
    }
    if (params.responseFormatJson) {
      body.response_format = { type: 'json_object' }
    }

    let attempt = 0
    // total tries = maxRetries + 1
    for (;;) {
      try {
        return await this.doRequest(url, body)
      } catch (err) {
        const modelErr =
          err instanceof ModelError
            ? err
            : new ModelError(redactString(String((err as Error)?.message ?? err)), 'JOB_INTERNAL_ERROR', false)
        if (!modelErr.retriable || attempt >= this.maxRetries) {
          throw modelErr
        }
        attempt++
        // Exponential backoff: 1s, 2s.
        await this.sleepImpl(1000 * Math.pow(2, attempt - 1))
      }
    }
  }

  private async doRequest(
    url: string,
    body: Record<string, unknown>,
  ): Promise<ChatCompletionResult> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    let resp: Response
    try {
      resp = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } catch (err) {
      const isAbort = (err as Error)?.name === 'AbortError'
      if (isAbort) {
        throw new ModelError(
          `model request timed out after ${this.timeoutMs}ms`,
          'MODEL_TIMEOUT',
          true,
        )
      }
      // Genuine network failures (DNS, connection reset, TLS) are transient.
      throw new ModelError(
        redactString(`model network error: ${String((err as Error)?.message ?? err)}`),
        'MODEL_NETWORK_ERROR',
        true,
      )
    } finally {
      clearTimeout(timer)
    }

    if (resp.status === 401 || resp.status === 403) {
      throw new ModelError('model authentication failed', 'MODEL_AUTH_FAILED', false)
    }
    if (resp.status === 429) {
      throw new ModelError('model rate limited', 'MODEL_RATE_LIMITED', true)
    }
    if (resp.status >= 500) {
      throw new ModelError(`model server error ${resp.status}`, 'MODEL_RATE_LIMITED', true)
    }
    if (!resp.ok) {
      throw new ModelError(`model request failed with status ${resp.status}`, 'JOB_INTERNAL_ERROR', false)
    }

    const json = (await resp.json()) as {
      choices?: Array<{ message?: ChatChoiceMessage; finish_reason?: string }>
    }
    const choice = json.choices?.[0]
    if (!choice?.message) {
      throw new ModelError('model response missing choices', 'JOB_INTERNAL_ERROR', false)
    }
    return {
      message: {
        role: 'assistant',
        content: choice.message.content ?? null,
        tool_calls: choice.message.tool_calls,
      },
      finishReason: choice.finish_reason ?? null,
    }
  }
}

/**
 * Extract a JSON object from an assistant message content, tolerating markdown
 * code fences and leading/trailing prose.
 */
export function extractJsonObject(content: string | null): unknown {
  if (!content) throw new ModelError('empty model content', 'JOB_INTERNAL_ERROR', false)
  const fenceStripped = content
    .replace(/```(?:json)?/gi, '')
    .replace(/```/g, '')
    .trim()
  // Try direct parse first.
  try {
    return JSON.parse(fenceStripped)
  } catch {
    // Fall back to first {...} block.
    const start = fenceStripped.indexOf('{')
    const end = fenceStripped.lastIndexOf('}')
    if (start >= 0 && end > start) {
      return JSON.parse(fenceStripped.slice(start, end + 1))
    }
    throw new ModelError('model did not return valid JSON', 'JOB_INTERNAL_ERROR', false)
  }
}
