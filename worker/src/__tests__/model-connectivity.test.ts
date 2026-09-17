import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { ConfigError, loadConfig, type Env } from '../config.js'
import type { DbClient, RpcOptions } from '../db/client.js'
import { JobsDb } from '../db/jobs.js'
import {
  ModelConnectivityProbeError,
  probeModelConnectivity,
} from '../model-connectivity/probe.js'

interface RpcCall {
  fn: string
  params: Record<string, unknown>
}

class RecordingDb implements DbClient {
  readonly calls: RpcCall[] = []

  constructor(private readonly responses: Record<string, unknown> = {}) {}

  async rpc<T = unknown>(fn: string, params: Record<string, unknown>, _options?: RpcOptions): Promise<T> {
    this.calls.push({ fn, params })
    return (this.responses[fn] ?? null) as T
  }

  last(): RpcCall {
    return this.calls[this.calls.length - 1]
  }
}

function baseEnv(overrides: Env = {}): Env {
  return {
    SUPABASE_URL: 'https://project.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'srk-value',
    WORKER_ID: 'worker-1',
    GIT_AUTH_MODE: 'local',
    ...overrides,
  }
}

const CLAIM_TOKEN = '33333333-4444-4555-8666-777777777777'
const servers: http.Server[] = []

/** 启动一个一次性本地端点，返回 origin 与收到的请求记录。 */
async function startServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ origin: string; port: number }> {
  const server = http.createServer(handler)
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return { origin: `http://127.0.0.1:${port}`, port }
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  )
})

describe('model connectivity proxy configuration', () => {
  it('defaults to a direct connection with a 90 second lease', () => {
    const config = loadConfig(baseEnv())
    expect(config.modelConnectivityProxy).toBeNull()
    expect(config.modelConnectivityTestLeaseSeconds).toBe(90)
  })

  it('accepts an origin proxy with credentials and normalizes it', () => {
    const config = loadConfig(
      baseEnv({
        MODEL_CONNECTIVITY_PROXY_URL: 'http://host.docker.internal:17890/',
        MODEL_CONNECTIVITY_PROXY_USERNAME: ' worker ',
        MODEL_CONNECTIVITY_PROXY_PASSWORD: ' secret ',
        MODEL_CONNECTIVITY_TEST_LEASE_SECONDS: '120',
      }),
    )
    expect(config.modelConnectivityProxy).toEqual({
      url: 'http://host.docker.internal:17890',
      username: 'worker',
      password: 'secret',
    })
    expect(config.modelConnectivityTestLeaseSeconds).toBe(120)
  })

  it('rejects unsafe proxy URLs and half-configured credentials', () => {
    for (const url of [
      'not-a-url',
      'ftp://host:17890',
      'http://user:pass@host:17890',
      'http://host:17890/path',
      'http://host:17890?query=1',
    ]) {
      expect(() => loadConfig(baseEnv({ MODEL_CONNECTIVITY_PROXY_URL: url }))).toThrow(ConfigError)
    }

    expect(() =>
      loadConfig(
        baseEnv({
          MODEL_CONNECTIVITY_PROXY_URL: 'http://host:17890',
          MODEL_CONNECTIVITY_PROXY_USERNAME: 'worker',
        }),
      ),
    ).toThrow(/must be set together/)
    expect(() =>
      loadConfig(baseEnv({ MODEL_CONNECTIVITY_PROXY_USERNAME: 'worker' })),
    ).toThrow(/require MODEL_CONNECTIVITY_PROXY_URL/)
  })

  it('keeps the lease within a range that outlives the 30 second probe timeout', () => {
    expect(() =>
      loadConfig(baseEnv({ MODEL_CONNECTIVITY_TEST_LEASE_SECONDS: '30' })),
    ).toThrow(/between/)
  })
})

describe('probeModelConnectivity', () => {
  it('sends the minimal OpenAI-compatible probe and reports latency', async () => {
    let received: { url?: string; auth?: string; body?: string } = {}
    const { origin } = await startServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        received = {
          url: req.url,
          auth: req.headers.authorization,
          body: Buffer.concat(chunks).toString('utf8'),
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end('{"choices":[]}')
      })
    })

    const result = await probeModelConnectivity({
      baseUrl: `${origin}/v1/`,
      modelName: 'kimi-k3',
      apiKey: 'secret-key',
      timeoutMs: 5000,
    })

    expect(result.statusCode).toBe(200)
    expect(result.latencyMs).toBeGreaterThanOrEqual(0)
    expect(received.url).toBe('/v1/chat/completions')
    expect(received.auth).toBe('Bearer secret-key')
    expect(JSON.parse(received.body ?? '{}')).toEqual({
      model: 'kimi-k3',
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 1,
    })
  })

  it('maps a non-2xx response onto a stable HTTP error code', async () => {
    const { origin } = await startServer((_req, res) => {
      res.writeHead(403, { 'Content-Type': 'application/json' })
      res.end('{"error":{"message":"权限不足"}}')
    })

    const error = await probeModelConnectivity({
      baseUrl: origin,
      modelName: 'glm5.3-flash',
      apiKey: 'secret-key',
      timeoutMs: 5000,
    }).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(ModelConnectivityProbeError)
    const probeError = error as ModelConnectivityProbeError
    expect(probeError.code).toBe('MODEL_HTTP_403')
    expect(probeError.statusCode).toBe(403)
    // 上游正文绝不透传给管理员，只暴露状态码。
    expect(probeError.message).not.toContain('权限不足')
  })

  it('routes the probe through the configured proxy using an absolute URL', async () => {
    let proxied: { url?: string; proxyAuth?: string; host?: string } = {}
    const { origin: proxyOrigin } = await startServer((req, res) => {
      proxied = {
        url: req.url,
        proxyAuth: req.headers['proxy-authorization'] as string | undefined,
        host: req.headers.host,
      }
      req.resume()
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end('{}')
      })
    })

    const result = await probeModelConnectivity({
      baseUrl: 'http://ai.zenithal.ai/sz1/inference/usr-x/inf-y/',
      modelName: 'kimi-k3',
      apiKey: 'secret-key',
      timeoutMs: 5000,
      proxy: { url: proxyOrigin, username: 'worker', password: 'secret' },
    })

    expect(result.statusCode).toBe(200)
    expect(proxied.url).toBe('http://ai.zenithal.ai/sz1/inference/usr-x/inf-y/chat/completions')
    expect(proxied.host).toBe('ai.zenithal.ai')
    expect(proxied.proxyAuth).toBe(`Basic ${Buffer.from('worker:secret').toString('base64')}`)
  })

  it('reports an unreachable proxy distinctly from an unreachable model', async () => {
    const { origin } = await startServer((_req, res) => res.end())
    const closedProxy = origin
    await new Promise<void>((resolve) => servers.splice(0)[0].close(() => resolve()))

    const caughtError = await probeModelConnectivity({
      baseUrl: 'http://ai.zenithal.ai/v1',
      modelName: 'kimi-k3',
      apiKey: 'secret-key',
      timeoutMs: 3000,
      proxy: { url: closedProxy, username: 'worker', password: 'secret' },
    }).catch((caught: unknown) => caught)

    expect(caughtError).toBeInstanceOf(ModelConnectivityProbeError)
    const error = caughtError as ModelConnectivityProbeError
    expect(error.code).toBe('MODEL_PROXY_UNREACHABLE')
    expect(error.latencyMs).not.toBeNull()
  })

  it('rejects a base URL that is not a valid HTTP endpoint', async () => {
    await expect(
      probeModelConnectivity({
        baseUrl: 'ai.zenithal.ai',
        modelName: 'kimi-k3',
        apiKey: 'secret-key',
        timeoutMs: 3000,
      }),
    ).rejects.toMatchObject({ code: 'MODEL_BASE_URL_INVALID' })
  })
})

describe('JobsDb model connectivity test RPCs', () => {
  it('claims a test and requires a claim token', async () => {
    const db = new RecordingDb({
      claim_next_model_connectivity_test: {
        id: 'test-1',
        model_config_id: 'model-1',
        base_url_snapshot: 'http://ai.zenithal.ai/v1',
        model_name_snapshot: 'kimi-k3',
        request_timeout_ms_snapshot: 30000,
        claim_token: CLAIM_TOKEN,
      },
    })
    const jobs = new JobsDb(db)

    const claim = await jobs.claimNextModelConnectivityTest('worker-1', 90)

    expect(db.last()).toMatchObject({
      fn: 'claim_next_model_connectivity_test',
      params: { p_worker_id: 'worker-1', p_lease_seconds: 90 },
    })
    expect(claim).toEqual({
      id: 'test-1',
      model_config_id: 'model-1',
      base_url_snapshot: 'http://ai.zenithal.ai/v1',
      model_name_snapshot: 'kimi-k3',
      request_timeout_ms_snapshot: 30000,
      claim_token: CLAIM_TOKEN,
    })

    const tokenless = new JobsDb(
      new RecordingDb({ claim_next_model_connectivity_test: { id: 'test-1' } }),
    )
    await expect(tokenless.claimNextModelConnectivityTest('worker-1', 90)).rejects.toThrow(
      'claim_next_model_connectivity_test returned no claim token',
    )
    const empty = new JobsDb(new RecordingDb({ claim_next_model_connectivity_test: null }))
    await expect(empty.claimNextModelConnectivityTest('worker-1', 90)).resolves.toBeNull()
  })

  it('passes the claim credentials on every terminal and lease RPC', async () => {
    const db = new RecordingDb()
    const jobs = new JobsDb(db)
    const claim = { testId: 'test-1', workerId: 'worker-1', claimToken: CLAIM_TOKEN }

    await jobs.heartbeatModelConnectivityTest({ ...claim, leaseSeconds: 90 })
    expect(db.last().params).toEqual({
      p_test_id: 'test-1',
      p_worker_id: 'worker-1',
      p_claim_token: CLAIM_TOKEN,
      p_lease_seconds: 90,
    })

    await jobs.getModelSecretForConnectivityTest(claim)
    expect(db.last()).toMatchObject({ fn: 'get_model_secret_for_connectivity_test' })

    await jobs.completeModelConnectivityTest({ ...claim, statusCode: 200, latencyMs: 42 })
    expect(db.last().params).toMatchObject({ p_status_code: 200, p_latency_ms: 42 })

    await jobs.failModelConnectivityTest({
      ...claim,
      code: 'MODEL_TIMEOUT',
      message: '模型连接测试超时',
    })
    expect(db.last().params).toMatchObject({
      p_error_code: 'MODEL_TIMEOUT',
      p_status_code: null,
      p_latency_ms: null,
    })

    await jobs.releaseModelConnectivityTestClaim(claim)
    expect(db.last()).toMatchObject({ fn: 'release_model_connectivity_test_claim' })
  })
})
