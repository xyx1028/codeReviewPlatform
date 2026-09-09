import { describe, it, expect, vi } from 'vitest'
import {
  OpenAICompatibleClient,
  ModelError,
  extractJsonObject,
} from '../ai/openai-compatible.js'
import { OpenAICompatibleHarness } from '../ai/openai-compatible-harness.js'
import type { RetrievalTools } from '../ai/harness.js'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function assistant(content: string): unknown {
  return { choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] }
}

const noopTools: RetrievalTools = {
  searchCode: async () => [],
  findFiles: async () => [],
  readCode: async () => ({
    repository: 'kdmanage-backend',
    filePath: 'x',
    startLine: 1,
    endLine: 1,
    content: '',
    truncated: false,
    contentHash: 'h',
  }),
  gitLog: async () => [],
}

describe('extractJsonObject', () => {
  it('parses fenced json', () => {
    expect(extractJsonObject('```json\n{"a":1}\n```')).toEqual({ a: 1 })
  })
  it('parses json embedded in prose', () => {
    expect(extractJsonObject('here it is {"a":2} done')).toEqual({ a: 2 })
  })
  it('throws on non-json', () => {
    expect(() => extractJsonObject('no json here')).toThrow(ModelError)
  })
})

describe('OpenAICompatibleClient retry behavior', () => {
  it('retries on 429 then succeeds', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ error: 'rate' }, 429))
      .mockResolvedValueOnce(jsonResponse(assistant('{"ok":true}')))
    const client = new OpenAICompatibleClient({
      baseUrl: 'https://model.example/v1',
      modelName: 'm',
      apiKey: 'sk-secret',
      timeoutMs: 1000,
      fetchImpl,
      sleepImpl: async () => {},
    })
    const res = await client.createChatCompletion({ messages: [{ role: 'user', content: 'hi' }] })
    expect(res.message.content).toBe('{"ok":true}')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('does not retry on 401 and maps to MODEL_AUTH_FAILED', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => jsonResponse({}, 401))
    const client = new OpenAICompatibleClient({
      baseUrl: 'https://model.example/v1',
      modelName: 'm',
      apiKey: 'sk-secret',
      timeoutMs: 1000,
      fetchImpl,
      sleepImpl: async () => {},
    })
    await expect(
      client.createChatCompletion({ messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toMatchObject({ code: 'MODEL_AUTH_FAILED' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('retries 5xx up to the limit then throws', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => jsonResponse({}, 503))
    const client = new OpenAICompatibleClient({
      baseUrl: 'https://model.example/v1',
      modelName: 'm',
      apiKey: 'sk-secret',
      timeoutMs: 1000,
      maxRetries: 2,
      fetchImpl,
      sleepImpl: async () => {},
    })
    await expect(
      client.createChatCompletion({ messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toBeInstanceOf(ModelError)
    expect(fetchImpl).toHaveBeenCalledTimes(3) // 1 + 2 retries
  })

  it('never leaks the api key in errors', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error('network down'))
    const client = new OpenAICompatibleClient({
      baseUrl: 'https://model.example/v1',
      modelName: 'm',
      apiKey: 'sk-topsecretkey',
      timeoutMs: 1000,
      maxRetries: 0,
      fetchImpl,
      sleepImpl: async () => {},
    })
    try {
      await client.createChatCompletion({ messages: [{ role: 'user', content: 'hi' }] })
    } catch (e) {
      expect(String((e as Error).message)).not.toContain('sk-topsecretkey')
    }
  })
})

describe('OpenAICompatibleHarness contract', () => {
  const story = {
    code: 'PRJ-001',
    name: 'demo',
    description: null,
    acceptanceCriteria: null,
    projectName: null,
    applicationName: null,
    sourceData: {},
  }

  it('retrieve returns a validated result with no tool calls', async () => {
    const retrievalJson = JSON.stringify({
      storyCode: 'PRJ-001',
      summary: 's',
      queries: [],
      searchedRepositories: ['kdmanage-backend'],
      candidates: [],
      insufficientEvidence: true,
    })
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(assistant(retrievalJson)))
    const client = new OpenAICompatibleClient({
      baseUrl: 'https://model.example/v1',
      modelName: 'm',
      apiKey: 'sk-x',
      timeoutMs: 1000,
      fetchImpl,
      sleepImpl: async () => {},
    })
    const harness = new OpenAICompatibleHarness({ client })
    const result = await harness.retrieve(
      {
        jobId: 'job1',
        story,
        branch: 'feature_dev',
        repositories: [{ name: 'kdmanage-backend', commitSha: 'a'.repeat(40), topLevelEntries: [] }],
      },
      noopTools,
    )
    expect(result.storyCode).toBe('PRJ-001')
    expect(result.insufficientEvidence).toBe(true)
  })

  it('analyze repairs invalid JSON once then succeeds', async () => {
    const good = JSON.stringify({
      storyCode: 'PRJ-001',
      verdict: 'UNCERTAIN',
      confidence: 10,
      summary: 's',
      implementedContent: null,
      missingContent: null,
      risks: null,
      testPoints: null,
      aiRemark: null,
      evidence: [],
    })
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(assistant('not json at all')))
      .mockResolvedValueOnce(jsonResponse(assistant(good)))
    const client = new OpenAICompatibleClient({
      baseUrl: 'https://model.example/v1',
      modelName: 'm',
      apiKey: 'sk-x',
      timeoutMs: 1000,
      fetchImpl,
      sleepImpl: async () => {},
    })
    const harness = new OpenAICompatibleHarness({ client })
    const res = await harness.analyze({
      story,
      branch: 'feature_dev',
      repositorySnapshots: [{ name: 'kdmanage-backend', commitSha: 'a'.repeat(40) }],
      retrieval: {
        storyCode: 'PRJ-001',
        summary: 's',
        queries: [],
        searchedRepositories: [],
        candidates: [],
        insufficientEvidence: true,
      },
      snippets: [],
    })
    expect(res.verdict).toBe('UNCERTAIN')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('analyze fails after a second invalid response', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => jsonResponse(assistant('still not json')))
    const client = new OpenAICompatibleClient({
      baseUrl: 'https://model.example/v1',
      modelName: 'm',
      apiKey: 'sk-x',
      timeoutMs: 1000,
      fetchImpl,
      sleepImpl: async () => {},
    })
    const harness = new OpenAICompatibleHarness({ client })
    await expect(
      harness.analyze({
        story,
        branch: 'feature_dev',
        repositorySnapshots: [],
        retrieval: {
          storyCode: 'PRJ-001',
          summary: 's',
          queries: [],
          searchedRepositories: [],
          candidates: [],
          insufficientEvidence: true,
        },
        snippets: [],
      }),
    ).rejects.toMatchObject({ code: 'ANALYSIS_SCHEMA_INVALID' })
  })
})
