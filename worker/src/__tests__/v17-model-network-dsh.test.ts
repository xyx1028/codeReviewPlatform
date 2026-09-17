/**
 * V1.7 阶段二：正式评审链路按网络类型走代理（真实 dsh 进程）。
 *
 * 为什么必须用真实进程：阶段一的缺陷恰恰是"正式链路根本没接代理"——那种缺陷在单测里
 * 看不见，因为单测断言的是我们自己写下的期望。这里让真实 dsh 子进程执行一次 `bash`，
 * 把它**实际看到的环境**报回来，于是"代理到底有没有到达模型请求路径"由进程本身回答。
 *
 * 顺带把一个已知代价也钉成事实：这些变量会被 Agent 的 Shell 继承（`scrubbedParentEnv()`
 * 只按 /KEY|PASSWORD|SECRET|TOKEN/i 与 DSH_* 过滤名字）。与其在文档里写一句"据说会继承"，
 * 不如让测试逐次证明它，这样哪天 Harness 改了过滤规则，我们会立刻知道。
 *
 * 用 `RUN_ACP_INTEGRATION=1` 打开，与仓库其余真实进程用例一致。
 */

import { describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runSingleAcpTurn } from '../ai/acp/acp-client.js'
import { startAcpProcess } from '../ai/acp/acp-process-supervisor.js'
import { materializeAttemptProfile } from '../ai/acp/profile-materializer.js'
import { V4_DEFAULT_POLICY } from '../ai/policy/v4-capability-policy.js'
import {
  hostProxyChildEnv,
  resolveModelNetworkRoute,
  type HostProxySettings,
} from '../model-connectivity/network-mode.js'
import { relaxSkillTree } from '../ai/skills/skill-materializer.js'

const ENABLED = process.env.RUN_ACP_INTEGRATION === '1'

const PROXY: HostProxySettings = {
  url: 'http://host.docker.internal:17890',
  username: 'worker',
  password: 'probe-secret',
}

/** 让 Agent 报出它实际看到的代理环境。`|| echo NONE` 保证没有变量时也有可断言的输出。 */
const ENV_PROBE = 'env | grep -iE "^(https?_proxy|node_use_env_proxy)=" | sort || echo NONE'

interface Probe {
  /** dsh 子进程里 `bash` 看到的环境快照。 */
  shellEnv: string
  exchanges: number
}

async function runAttempt(modelProxyEnv: Record<string, string> | undefined): Promise<Probe> {
  const cwd = mkdtempSync(join(tmpdir(), 'v17-cwd-'))
  const attemptsRoot = mkdtempSync(join(tmpdir(), 'v17-att-'))
  const sessionRoot = mkdtempSync(join(tmpdir(), 'v17-sess-'))
  const socketDir = mkdtempSync(join(tmpdir(), 'v17-sock-'))
  const socketPath = join(socketDir, 's.sock')
  const bodies: string[] = []

  const model = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const index = bodies.length
      bodies.push(Buffer.concat(chunks).toString('utf8'))
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const base = { id: `c${index}`, object: 'chat.completion.chunk', model: 'probe' }
      if (index === 0) {
        res.write(
          `data: ${JSON.stringify({
            ...base,
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_0',
                      type: 'function',
                      function: {
                        name: 'bash',
                        arguments: JSON.stringify({
                          command: ENV_PROBE,
                          description: 'report proxy environment',
                        }),
                      },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          })}\n\n`,
        )
        res.write(
          `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`,
        )
      } else {
        res.write(
          `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: 'done' }, finish_reason: 'stop' }] })}\n\n`,
        )
      }
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', () => resolve()))
  const port = (model.address() as { port: number }).port

  const broker = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify(
        req.url === '/attempt/reserve-model-request' ? { allowed: true, reserved: 1 } : { accepted: true },
      ),
    )
  })
  await new Promise<void>((resolve) => broker.listen(socketPath, () => resolve()))

  const profile = materializeAttemptProfile({
    taskId: 'v17-probe',
    agentAttempt: 1,
    attemptsRoot,
    route: {
      providerId: 'review-route',
      displayName: 'probe',
      // 模型端点必须是 127.0.0.1：Harness 自己注入 NO_PROXY=localhost,127.0.0.1，
      // 所以即使设了代理，这一条请求仍然直连 —— 否则测试会因为连不上代理而挂掉，
      // 而我们要测的是"环境有没有到达子进程"，不是"代理通不通"。
      baseUrl: `http://127.0.0.1:${port}/v1`,
      modelName: 'probe',
      contextWindow: 131072,
      maxTokens: 4096,
      apiKeyEnvVar: 'REVIEW_MODEL_API_KEY',
      requestTimeoutMs: 60000,
    },
    policy: V4_DEFAULT_POLICY,
    identity: { rootAgentId: 'root-v17', rootSessionId: 'session-v17' },
    cwd,
    sessionRoot,
    broker: { socketPath },
  })

  const child = startAcpProcess({
    dshHome: profile.dshHome,
    profileName: profile.profileName,
    patchPath: profile.patchPath,
    cwd,
    apiKeyEnvVar: 'REVIEW_MODEL_API_KEY',
    apiKey: 'not-a-real-key',
    brokerToken: 'broker-token',
    rootCapability: 'root-capability',
    // 这一行就是被测装配点：engine 把 modelProxyEnv 合进 extraEnv。
    extraEnv: modelProxyEnv,
    killGraceMs: 3000,
  })

  const controller = new AbortController()
  try {
    await runSingleAcpTurn(
      { process: child, cwd, permittedTools: [...profile.rootTools] },
      'report your proxy environment',
      controller.signal,
    )
    let shellEnv = ''
    for (const body of bodies) {
      try {
        const parsed = JSON.parse(body) as { messages?: Array<{ role?: string; content?: unknown }> }
        const tool = (parsed.messages ?? []).find((m) => m.role === 'tool')
        if (tool !== undefined && typeof tool.content === 'string') {
          shellEnv = tool.content
          break
        }
      } catch {
        continue
      }
    }
    return { shellEnv, exchanges: bodies.length }
  } finally {
    controller.abort()
    await child.terminate()
    await new Promise<void>((resolve) => broker.close(() => resolve()))
    await new Promise<void>((resolve) => model.close(() => resolve()))
    relaxSkillTree(profile.dshHome)
    profile.cleanup()
    for (const dir of [cwd, attemptsRoot, sessionRoot, socketDir]) {
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

describe.skipIf(!ENABLED)('V1.7 model network route (real dsh process)', () => {
  it('leaves a public model attempt completely unproxied', async () => {
    // DIRECT 的 attempt 里根本不该出现代理环境 —— 这是"公网模型不受影响"的运行时证据。
    const route = resolveModelNetworkRoute({ mode: 'DIRECT', configuredProxy: PROXY })
    expect(route.proxy).toBeNull()

    const probe = await runAttempt(undefined)
    expect(probe.exchanges).toBeGreaterThanOrEqual(2)
    expect(probe.shellEnv).not.toMatch(/HTTPS?_PROXY=/i)
    expect(probe.shellEnv).not.toContain('NODE_USE_ENV_PROXY')
  }, 180000)

  it('delivers the proxy environment into the dsh child for an intranet model', async () => {
    const route = resolveModelNetworkRoute({ mode: 'HOST_PROXY', configuredProxy: PROXY })
    expect(route.proxy).toEqual(PROXY)

    const probe = await runAttempt(hostProxyChildEnv(route.proxy!))
    expect(probe.exchanges).toBeGreaterThanOrEqual(2)
    // 到达子进程 = 到达 llm-pi-ai 的 fetch。这是正式评审链路真的走代理的证据。
    expect(probe.shellEnv).toMatch(/HTTPS_PROXY=/i)
    expect(probe.shellEnv).toContain('host.docker.internal:17890')
    expect(probe.shellEnv).toContain('NODE_USE_ENV_PROXY=1')
  }, 180000)

  it('documents that the agent shell inherits the proxy (known exposure)', async () => {
    /*
     * 这条用例断言的是一个**代价**，不是一个特性。
     *
     * `scrubbedParentEnv()` 只按 /KEY|PASSWORD|SECRET|TOKEN/i 与 DSH_* 过滤变量名，所以
     * 代理环境会被 Agent 的 Shell 继承：选了内网模型的 attempt，Agent 的 bash 也能经这条
     * 代理访问公司内网。缓解措施是"只有 HOST_PROXY 的 attempt 才下传" + 代理侧的认证与
     * SSRF 防护（见 scripts/model-vpn-proxy.mjs 的 isDeniedTarget）。
     *
     * 把它写成断言而不是注释，是为了让 Harness 哪天改了过滤规则时我们立刻知道 —— 无论
     * 是变严（这条会红，说明代价消失了，好事）还是变松。
     */
    const probe = await runAttempt(hostProxyChildEnv(PROXY))
    expect(probe.shellEnv, 'the shell inherits the proxy; mitigations live in the proxy itself')
      .toMatch(/HTTP_PROXY=/i)
    // 凭据确实在 URL 里 —— 这也是为什么代理必须只监听 127.0.0.1 且要求认证。
    expect(probe.shellEnv).toContain('worker:')
  }, 180000)
})
