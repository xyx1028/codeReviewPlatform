/**
 * Real-process POC for the Harness ACP runtime.
 *
 * This test boots the actual `dsh` launcher with the hardened profile, speaks
 * ACP over the child's stdio, and drives it with a mock OpenAI-compatible
 * endpoint. It proves the properties the design depends on and that cannot be
 * checked with unit tests:
 *
 *  1. the generated profile and per-attempt overlay boot,
 *  2. `submit_review_result` is registered as a profile-local tool,
 *  3. a rejected submission is model-correctable and does NOT end the turn,
 *  4. an accepted submission ends the turn through `concludeTurn()`,
 *  5. no session log or repository content is written to disk,
 *  6. the child process is reclaimed.
 *
 * It is opt-in because it spawns processes and needs `npm run worker:build`
 * first: RUN_ACP_INTEGRATION=1 npm run test:worker
 */

import { describe, it, expect } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runSingleAcpTurn } from '../ai/acp/acp-client.js'
import { startAcpProcess } from '../ai/acp/acp-process-supervisor.js'
import { materializeAttemptProfile } from '../ai/acp/profile-materializer.js'
import { V4_DEFAULT_POLICY } from '../ai/policy/v4-capability-policy.js'
import { DeepSeekHarnessAcpEngine } from '../ai/runtime/deepseek-harness-acp-engine.js'
import { SnapshotStore } from '../ai/snapshot/snapshot-store.js'
import type { CommitReviewInput } from '../ai/control/attempt-control-broker.js'
import { runCommand } from '../git/run.js'
import { Logger } from '../logger.js'
import { startMockModelServer } from './helpers/acp-mock-model.js'

const ENABLED = process.env.RUN_ACP_INTEGRATION === '1'

interface BrokerCall {
  taskId: string
  agentAttempt: number
  submission: { verdict?: string; evidence?: unknown[] }
}

/**
 * Attempt broker stand-in: rejects the first submission, accepts the second.
 *
 * V4 起同一个 socket 服务 13 条路由，不再只有提交一条 —— 预算预留、usage 上报和工具审计
 * 都走它。所以这个替身必须按路由分发：以前"任何请求都按提交处理"会让 usage-reporter 的
 * 第一次预算预留拿到提交拒绝的响应，从而在第一次模型请求前就把整个 turn 判死。
 *
 * `calls` 仍然只记录提交，好让下面的断言继续说明"提交了几次、每次带什么证据"。
 */
function startMockBroker(socketPath: string, expectedToken: string): Promise<{
  calls: BrokerCall[]
  unauthorized: () => number
  routes: () => string[]
  close: () => Promise<void>
}> {
  const calls: BrokerCall[] = []
  const routes: string[] = []
  let unauthorized = 0
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      if (req.headers.authorization !== `Bearer ${expectedToken}`) {
        unauthorized++
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ accepted: false, reason: 'unauthorized' }))
        return
      }
      const route = req.url ?? ''
      routes.push(route)
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as BrokerCall
      const reply = (payload: unknown): void => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(payload))
      }

      if (route === '/attempt/reserve-model-request') {
        // 预算在真实 Broker 里是有限的；这个替身只需要不挡住 turn。
        reply({ allowed: true, reserved: 1 })
        return
      }
      if (route === '/attempt/report-usage' || route === '/attempt/tool-audit') {
        reply({ accepted: true })
        return
      }
      if (route !== '/attempt/submit-review') {
        // 其余路由（注册子 Agent、Web 出口等）本用例不涉及；明确拒绝比静默接受更诚实。
        reply({ accepted: false, code: 'BROKER_UNKNOWN_ROUTE', reason: `unused route ${route}` })
        return
      }

      calls.push(body)
      if (calls.length === 1) {
        reply({
          accepted: false,
          code: 'EVIDENCE_UNVERIFIED',
          reason:
            'evidence item 1 references evidenceId "made-up-id", which was never returned by a snapshot tool. Re-read the range and submit the id you were given.',
        })
        return
      }
      reply({ accepted: true, runId: 'run-poc-1', committedAt: new Date().toISOString() })
    })
  })

  return new Promise((resolveServer) => {
    server.listen(socketPath, () => {
      resolveServer({
        calls,
        unauthorized: () => unauthorized,
        routes: () => [...routes],
        close: () => closeServer(server),
      })
    })
  })
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolveClose) => server.close(() => resolveClose()))
}

/**
 * Broker stand-in that accepts the first submission.
 *
 * Separate from `startMockBroker` on purpose: that one rejects the first
 * submission to exercise model self-correction, which would confound a test whose
 * whole subject is how many model requests the transport failure costs.
 */
function startMockBrokerAlwaysAccepting(
  socketPath: string,
  expectedToken: string,
): Promise<{ calls: BrokerCall[]; close: () => Promise<void> }> {
  const calls: BrokerCall[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const reply = (payload: unknown): void => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(payload))
      }
      if (req.headers.authorization !== `Bearer ${expectedToken}`) {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ accepted: false, reason: 'unauthorized' }))
        return
      }
      const route = req.url ?? ''
      if (route === '/attempt/reserve-model-request') {
        // The ledger's own denial path is not under test here; the retry ceiling
        // being measured is the provider-side one written into the profile.
        reply({ allowed: true, reserved: 1 })
        return
      }
      if (route === '/attempt/report-usage' || route === '/attempt/tool-audit') {
        reply({ accepted: true })
        return
      }
      if (route === '/attempt/submit-review') {
        calls.push(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as BrokerCall)
        reply({ accepted: true, runId: 'run-transient-1', committedAt: new Date().toISOString() })
        return
      }
      reply({ accepted: false, code: 'BROKER_UNKNOWN_ROUTE', reason: `unused route ${route}` })
    })
  })

  return new Promise((resolveServer) => {
    server.listen(socketPath, () => {
      resolveServer({ calls, close: () => closeServer(server) })
    })
  })
}

/** Recursively collect files that look like a persisted session log. */
function findSessionArtifacts(root: string): string[] {
  const found: string[] = []
  const walk = (dir: string) => {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry)
      let isDir = false
      try {
        isDir = statSync(full).isDirectory()
      } catch {
        continue
      }
      if (isDir) {
        walk(full)
      } else if (entry.endsWith('.jsonl')) {
        found.push(full)
      }
    }
  }
  walk(root)
  return found
}

const VALID_EVIDENCE = [
  {
    evidenceId: 'ev-1',
    repository: 'kdmanage-backend',
    filePath: 'src/A.java',
    startLine: 1,
    endLine: 5,
    evidenceType: '现有实现',
    description: 'implements the story',
  },
]

describe.skipIf(!ENABLED)('ACP runtime POC (real dsh process)', () => {
  it(
    'corrects a rejected submission and ends the turn only after a committed one',
    async () => {
      const socketDir = mkdtempSync(join(tmpdir(), 'acp-b-'))
      const socketPath = join(socketDir, 's.sock')
      const cwd = mkdtempSync(join(tmpdir(), 'acp-cwd-'))
      const attemptsRoot = mkdtempSync(join(tmpdir(), 'acp-att-'))
      const token = 'poc-claim-token'

      const model = await startMockModelServer([
        {
          name: 'submit_review_result',
          args: {
            verdict: 'IMPLEMENTED',
            confidence: 90,
            summary: 'first attempt with unverifiable evidence',
            evidence: [{ ...VALID_EVIDENCE[0], evidenceId: 'made-up-id' }],
          },
        },
        {
          name: 'submit_review_result',
          args: {
            verdict: 'IMPLEMENTED',
            confidence: 90,
            summary: 'corrected submission',
            evidence: VALID_EVIDENCE,
          },
        },
      ])
      const broker = await startMockBroker(socketPath, token)

      const profile = materializeAttemptProfile({
        taskId: 'poc-task',
        agentAttempt: 1,
        attemptsRoot,
        route: {
          providerId: 'review-route',
          displayName: 'Review Route',
          baseUrl: model.baseUrl,
          modelName: 'poc-model',
          contextWindow: 131072,
          maxTokens: 4096,
          apiKeyEnvVar: 'REVIEW_MODEL_API_KEY',
          requestTimeoutMs: 60000,
        },
        // V4：预算随 policy 一起冻结，attempt patch 不再单独接收 budgets。根身份由 Worker 生成；
        // cwd 是受控 Workspace，sessionRoot 在持久卷上（与 attempt 目录分开，才能恢复）。
        policy: V4_DEFAULT_POLICY,
        identity: {
          rootAgentId: 'root-poc',
          rootSessionId: 'session-poc',
        },
        cwd,
        sessionRoot: mkdtempSync(join(tmpdir(), 'acp-sess-')),
        broker: { socketPath },
      })

      const child = startAcpProcess({
        dshHome: profile.dshHome,
        profileName: profile.profileName,
        patchPath: profile.patchPath,
        cwd,
        apiKeyEnvVar: 'REVIEW_MODEL_API_KEY',
        apiKey: 'poc-not-a-real-key',
        // 凭据经环境变量下传，不写进 attempt patch 文件。
        brokerToken: token,
        rootCapability: 'root-cap-poc',
        killGraceMs: 3000,
      })

      const controller = new AbortController()
      try {
        const turn = await runSingleAcpTurn(
          // V4：权限面来自角色策略。root 的工具集由 profile 解析出来，不再是固定五个。
          { process: child, cwd, permittedTools: [...profile.rootTools] },
          'Review story PRJ-001 and submit the result.',
          controller.signal,
        )

        // The turn ended because the tool concluded it, not because it failed.
        expect(turn.stopReason, `stderr: ${child.stderr()}`).toBe('end_turn')
        expect(turn.toolNames).toContain('submit_review_result')

        // One rejected submission, then one accepted: the model corrected itself
        // inside the same session.
        expect(broker.calls).toHaveLength(2)
        expect(broker.unauthorized()).toBe(0)
        expect(broker.calls[0]?.taskId).toBe('poc-task')
        expect(broker.calls[0]?.agentAttempt).toBe(1)
        const evidenceIdOf = (call: BrokerCall | undefined): unknown =>
          (call?.submission.evidence?.[0] as { evidenceId?: unknown } | undefined)?.evidenceId
        expect(evidenceIdOf(broker.calls[0])).toBe('made-up-id')
        expect(evidenceIdOf(broker.calls[1])).toBe('ev-1')

        // Two model requests: the first turn plus the correction turn.
        expect(model.requestCount()).toBeGreaterThanOrEqual(2)

        // V4 把 Session JSONL 写在持久卷上（恢复的前提），但 DSH_HOME 里仍然不应当出现
        // 会话日志：attempt 目录会被清理，任何落在那里的会话内容都会随之丢失，
        // 而"能恢复"这件事就不成立了。
        expect(findSessionArtifacts(profile.dshHome)).toEqual([])

        // 预算预留确实发生在模型请求之前：这是 V4 用量计数为真值的前提。
        expect(broker.routes()).toContain('/attempt/reserve-model-request')
      } finally {
        controller.abort()
        const exit = await child.terminate()
        expect(exit.signal === 'SIGKILL').toBe(false)
        await broker.close()
        await model.close()
        profile.cleanup()
        rmSync(socketDir, { recursive: true, force: true })
        rmSync(cwd, { recursive: true, force: true })
        rmSync(attemptsRoot, { recursive: true, force: true })
      }
    },
    180000,
  )
})

/**
 * The transient-502 regression, reproduced against a real dsh process.
 *
 * Production evidence (2026-09-17, batch 032bea72): the intranet model endpoint
 * reached through `scripts/model-vpn-proxy.mjs` dropped roughly 0.5% of sockets,
 * and the proxy answered `502 model endpoint unreachable from this Mac`. Because
 * the attempt profile pinned `retryPolicy.maxRetries` to 0, `dsh-llm-retry`
 * delegated that `SERVER` failure instead of retrying, so a single blip ended the
 * whole attempt on its first model request — `ATTEMPT_FAILED`, `wall_ms` 3002,
 * zero evidence, while the governor's retry allowance sat unspent.
 *
 * Both directions are asserted here on purpose. "Recovers when the policy allows
 * retries" alone would still pass if the retry executor were unmounted and the
 * 502 simply never reached it; pinning that `maxRetries: 0` still dies proves the
 * profile field is what decides the outcome.
 */
describe.skipIf(!ENABLED)('transient upstream 502 (real dsh process)', () => {
  interface TransientRunResult {
    stopReason: string
    error: string | null
    submissions: number
    failedRequests: number
    stderr: string
  }

  async function runWithTransient502(input: {
    retryAllowance: number
    failures: number
  }): Promise<TransientRunResult> {
    const socketDir = mkdtempSync(join(tmpdir(), 'acp-502-b-'))
    const socketPath = join(socketDir, 's.sock')
    const cwd = mkdtempSync(join(tmpdir(), 'acp-502-cwd-'))
    const attemptsRoot = mkdtempSync(join(tmpdir(), 'acp-502-att-'))
    const sessionRoot = mkdtempSync(join(tmpdir(), 'acp-502-sess-'))
    const token = 'transient-claim-token'

    const model = await startMockModelServer(
      [
        {
          name: 'submit_review_result',
          args: {
            verdict: 'IMPLEMENTED',
            confidence: 90,
            summary: 'submitted after the upstream recovered',
            evidence: VALID_EVIDENCE,
          },
        },
      ],
      input.failures,
    )
    const broker = await startMockBrokerAlwaysAccepting(socketPath, token)

    const profile = materializeAttemptProfile({
      taskId: 'transient-502-task',
      agentAttempt: 1,
      attemptsRoot,
      route: {
        providerId: 'review-route',
        displayName: 'Review Route',
        baseUrl: model.baseUrl,
        modelName: 'poc-model',
        contextWindow: 131072,
        maxTokens: 4096,
        apiKeyEnvVar: 'REVIEW_MODEL_API_KEY',
        requestTimeoutMs: 60000,
      },
      // The single variable under test: the frozen policy's retry allowance,
      // which the profile hands to the provider as `retryPolicy.maxRetries`.
      policy: {
        ...V4_DEFAULT_POLICY,
        modelBudget: {
          ...V4_DEFAULT_POLICY.modelBudget,
          maxRetryRequests: input.retryAllowance,
        },
      },
      identity: { rootAgentId: 'root-transient', rootSessionId: 'session-transient' },
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
      apiKey: 'transient-not-a-real-key',
      brokerToken: token,
      rootCapability: 'root-cap-transient',
      killGraceMs: 3000,
    })

    const controller = new AbortController()
    try {
      const turn = await runSingleAcpTurn(
        { process: child, cwd, permittedTools: [...profile.rootTools] },
        'Review story PRJ-001 and submit the result.',
        controller.signal,
      ).catch((err: unknown) => ({
        // An unrecovered transport failure rejects the ACP request rather than
        // returning a stop reason; the message is the one the Worker logs as
        // `agent_attempt_failed`, so it is the assertable artifact.
        stopReason: 'threw',
        toolNames: [] as string[],
        error: (err as Error).message,
      }))
      return {
        stopReason: turn.stopReason,
        error: 'error' in turn ? turn.error : null,
        submissions: broker.calls.length,
        failedRequests: model.failedCount(),
        stderr: child.stderr(),
      }
    } finally {
      controller.abort()
      await child.terminate()
      await broker.close()
      await model.close()
      profile.cleanup()
      for (const dir of [socketDir, cwd, attemptsRoot, sessionRoot]) {
        rmSync(dir, { recursive: true, force: true })
      }
    }
  }

  it(
    'recovers from a single 502 and still commits when the policy allows retries',
    async () => {
      const result = await runWithTransient502({ retryAllowance: 12, failures: 1 })

      // The 502 really was served — otherwise this test proves nothing.
      expect(result.failedRequests).toBe(1)
      // ...and the turn still reached its normal end through the tool.
      expect(result.stopReason, `stderr: ${result.stderr}`).toBe('end_turn')
      expect(result.submissions).toBe(1)
    },
    180000,
  )

  it(
    'still survives a burst of consecutive 502s within the allowance',
    async () => {
      const result = await runWithTransient502({ retryAllowance: 12, failures: 3 })

      expect(result.failedRequests).toBe(3)
      expect(result.stopReason, `stderr: ${result.stderr}`).toBe('end_turn')
      expect(result.submissions).toBe(1)
    },
    180000,
  )

  it(
    'dies on the same single 502 when the retry allowance is zero (the shipped regression)',
    async () => {
      const result = await runWithTransient502({ retryAllowance: 0, failures: 1 })

      expect(result.failedRequests).toBe(1)
      // The turn never reaches the submission tool; it fails outright with the
      // exact message production logged for batch 032bea72's US-2026-008708.
      expect(result.stopReason).not.toBe('end_turn')
      expect(result.error).toContain('turn failed: 502 model endpoint unreachable from this Mac')
      expect(result.submissions).toBe(0)
    },
    180000,
  )
})

/** Build a one-commit repository and return its exact commit id. */
async function buildSnapshotRepo(): Promise<{ gitDir: string; commitSha: string }> {
  const gitDir = mkdtempSync(join(tmpdir(), 'acp-repo-'))
  await runCommand('git', ['init', '--quiet', '--initial-branch=main'], { cwd: gitDir })
  await runCommand('git', ['config', 'user.email', 'test@example.invalid'], { cwd: gitDir })
  await runCommand('git', ['config', 'user.name', 'ACP Test'], { cwd: gitDir })
  mkdirSync(join(gitDir, 'src'), { recursive: true })
  writeFileSync(
    join(gitDir, 'src', 'OrderService.java'),
    [
      'package main;',
      '',
      'public class OrderService {',
      '  public void createOrder() {',
      '    // implements PRJ-001',
      '  }',
      '}',
      '',
    ].join('\n'),
  )
  await runCommand('git', ['add', '--all'], { cwd: gitDir })
  await runCommand('git', ['commit', '--quiet', '-m', 'feat: createOrder for PRJ-001'], {
    cwd: gitDir,
  })
  const head = await runCommand('git', ['rev-parse', 'HEAD'], { cwd: gitDir })
  return { gitDir, commitSha: head.stdout.trim() }
}

const EVIDENCE_ID_PATTERN = /ev_[0-9a-f-]{36}/

describe.skipIf(!ENABLED)('resolved tool inventory contract (real dsh process)', () => {
  it(
    'offers the model exactly the tool surface the V4 contract prescribes for the root',
    async () => {
      const cwd = mkdtempSync(join(tmpdir(), 'inv-cwd-'))
      const attemptsRoot = mkdtempSync(join(tmpdir(), 'inv-att-'))
      const sessionRoot = mkdtempSync(join(tmpdir(), 'inv-sess-'))
      const socketDir = mkdtempSync(join(tmpdir(), 'inv-sock-'))
      const socketPath = join(socketDir, 's.sock')

      // 这个用例是整套 contract 机制的兜底：单测比对的是我们自己写下的期望，只有真实
      // 进程能回答"模型实际看到了哪些工具"。Harness 升级悄悄改掉一个工具名时，只有这里
      // 会失败 —— 而失败正是我们想要的，因为它意味着 attempt 会 fail closed。
      const inventory = await captureModelToolInventory({
        cwd,
        attemptsRoot,
        sessionRoot,
        socketPath,
      })

      const expected = [...inventory.expectedRootTools].sort()
      expect(inventory.resolved).not.toBeNull()
      expect(inventory.resolved!.sort()).toEqual(expected)

      // 全能力确实到达了模型，而不只是"契约里写着开启"。
      for (const tool of [
        'bash',
        'skill',
        'todo_write',
        'create_goal',
        'ralph',
        'subagent',
        'subagent_fork',
        'workflow',
        'job_list',
        'read',
        'write',
        'edit',
        'grep',
        'glob',
        'web_search',
        'web_fetch',
        'submit_review_result',
      ]) {
        expect(inventory.resolved, `${tool} must reach the model`).toContain(tool)
      }

      rmSync(cwd, { recursive: true, force: true })
      rmSync(attemptsRoot, { recursive: true, force: true })
      rmSync(sessionRoot, { recursive: true, force: true })
      rmSync(socketDir, { recursive: true, force: true })
    },
    180000,
  )
})

/**
 * 启动一个真实 dsh 进程，抓取它发给模型的第一个请求里声明的工具面。
 *
 * 工具面只在模型请求里出现，所以必须真的走到一次 `session/prompt`。Broker 替身按路由应答，
 * 模型替身立刻结束这一轮，于是整个过程是秒级的。
 */
async function captureModelToolInventory(input: {
  cwd: string
  attemptsRoot: string
  sessionRoot: string
  socketPath: string
}): Promise<{ resolved: string[] | null; expectedRootTools: readonly string[] }> {
  let resolved: string[] | null = null
  const model = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as {
        tools?: Array<{ function?: { name?: string }; name?: string }>
      }
      if (resolved === null && Array.isArray(body.tools)) {
        resolved = body.tools
          .map((tool) => tool.function?.name ?? tool.name)
          .filter((name): name is string => typeof name === 'string')
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(
        `data: ${JSON.stringify({
          id: '1',
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }],
        })}\n\n`,
      )
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  await new Promise<void>((r) => model.listen(0, '127.0.0.1', () => r()))
  const port = (model.address() as { port: number }).port

  const broker = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify(
          req.url === '/attempt/reserve-model-request' ? { allowed: true } : { accepted: true },
        ),
      )
    })
  })
  await new Promise<void>((r) => broker.listen(input.socketPath, () => r()))

  const profile = materializeAttemptProfile({
    taskId: 'inventory-task',
    agentAttempt: 1,
    attemptsRoot: input.attemptsRoot,
    route: {
      providerId: 'review-route',
      displayName: 'Inventory Route',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      modelName: 'inventory-model',
      contextWindow: 131072,
      maxTokens: 4096,
      apiKeyEnvVar: 'REVIEW_MODEL_API_KEY',
      requestTimeoutMs: 30000,
    },
    policy: V4_DEFAULT_POLICY,
    identity: {
      rootAgentId: 'root-inv',
      rootSessionId: 'session-inv',
    },
    cwd: input.cwd,
    sessionRoot: input.sessionRoot,
    broker: { socketPath: input.socketPath },
    repositories: ['kdmanage-backend'],
  })

  const child = startAcpProcess({
    dshHome: profile.dshHome,
    profileName: profile.profileName,
    patchPath: profile.patchPath,
    cwd: input.cwd,
    apiKeyEnvVar: 'REVIEW_MODEL_API_KEY',
    apiKey: 'inventory-not-a-real-key',
    brokerToken: 'inv-token',
    rootCapability: 'cap-inv',
    killGraceMs: 3000,
  })

  try {
    const turn = await runSingleAcpTurn(
      { process: child, cwd: input.cwd, permittedTools: [...profile.rootTools] },
      'Say ok.',
      new AbortController().signal,
    )
    expect(turn.stopReason, `stderr: ${child.stderr()}`).toBe('end_turn')
    return { resolved, expectedRootTools: profile.rootTools }
  } finally {
    await child.terminate()
    await new Promise<void>((r) => broker.close(() => r()))
    await new Promise<void>((r) => model.close(() => r()))
    profile.cleanup()
  }
}

describe.skipIf(!ENABLED)('DeepSeekHarnessAcpEngine (real dsh process, real snapshot)', () => {
  it(
    'searches, reads, is refused for fabricated evidence, then commits a verified result',
    async () => {
      const { gitDir, commitSha } = await buildSnapshotRepo()
      const attemptsRoot = mkdtempSync(join(tmpdir(), 'acp-eng-'))
      const repository = 'kdmanage-backend'

      // The submission turn needs the evidenceId the read tool handed out, so
      // the last two turns are derived from the conversation itself.
      const submission = (evidenceId: string, summary: string) => ({
        name: 'submit_review_result',
        args: {
          verdict: 'IMPLEMENTED',
          confidence: 92,
          summary,
          implementedContent: 'OrderService.createOrder implements the story',
          evidence: [
            {
              evidenceId,
              repository,
              filePath: 'src/OrderService.java',
              startLine: 3,
              endLine: 6,
              evidenceType: '现有实现',
              description: 'createOrder',
            },
          ],
        },
      })

      const model = await startMockModelServer([
        { name: 'search_snapshot_code', args: { repository, query: 'createOrder' } },
        {
          name: 'read_snapshot_code',
          args: { repository, path: 'src/OrderService.java', startLine: 1, endLine: 20 },
        },
        // Fabricated id: the broker must refuse this without committing.
        submission('ev_00000000-0000-4000-8000-000000000000', 'fabricated evidence'),
        (body) => {
          const found = body.match(EVIDENCE_ID_PATTERN)
          return submission(found?.[0] ?? 'ev_still-missing', 'corrected evidence')
        },
      ])

      const commits: CommitReviewInput[] = []
      const engine = new DeepSeekHarnessAcpEngine({
        taskId: 'engine-task',
        agentAttempt: 1,
        branch: 'feature_dev',
        story: {
          code: 'PRJ-001',
          name: '下单接口',
          description: '实现 createOrder 下单接口。',
          acceptanceCriteria: '可以创建订单。',
        },
        snapshots: new SnapshotStore([{ name: repository, commitSha, gitDir }]),
        route: {
          providerId: 'review-route',
          displayName: 'Review Route',
          baseUrl: model.baseUrl,
          modelName: 'poc-model',
          contextWindow: 131072,
          maxTokens: 4096,
          apiKeyEnvVar: 'REVIEW_MODEL_API_KEY',
          requestTimeoutMs: 60000,
        },
        // V4：数值上限来自冻结的 policy。引擎还需要 Session 持久卷、workerId、要屏蔽的基础设施
        // 地址，以及不可从 Workspace 触及的平台目录。
        policy: V4_DEFAULT_POLICY,
        coveragePolicy: { requiredRepositories: [repository], minQueriesPerRepository: 1 },
        apiKey: 'engine-not-a-real-key',
        attemptsRoot,
        sessionRoot: mkdtempSync(join(tmpdir(), 'acp-eng-sess-')),
        workerId: 'w-poc',
        infrastructure: {},
        forbiddenRoots: [],
        logger: new Logger({ sink: () => {}, minLevel: 'error' }),
        isLeaseValid: () => true,
        commitReview: async (input) => {
          commits.push(input)
          return { runId: 'run-engine-1', committedAt: new Date().toISOString() }
        },
      })

      try {
        const result = await engine.runReview({
          signal: new AbortController().signal,
          logger: new Logger({ sink: () => {}, minLevel: 'error' }),
        })

        expect(result.ok, `engine failed: ${result.errorCode} ${result.errorMessage}`).toBe(true)
        expect(result.taskId).toBe('engine-task')
        expect(result.storyCode).toBe('PRJ-001')

        // Exactly one commit: the fabricated submission was refused.
        expect(commits).toHaveLength(1)
        const committed = commits[0]
        expect(committed?.submission.verdict).toBe('IMPLEMENTED')
        expect(committed?.submission.summary).toBe('corrected evidence')

        // The stored evidence is what the platform verified, not what the model
        // asserted: it carries the commit and blob it was re-read from.
        expect(committed?.evidence).toHaveLength(1)
        expect(committed?.evidence[0]?.commitSha).toBe(commitSha)
        expect(committed?.evidence[0]?.blobSha).toMatch(/^[0-9a-f]{40}$/)
        expect(committed?.evidence[0]?.filePath).toBe('src/OrderService.java')
        expect(committed?.evidence[0]?.evidenceType).toBe('现有实现')

        // Search, read, two submissions.
        expect(committed?.usage.searchesRun).toBeGreaterThanOrEqual(1)
        expect(committed?.usage.evidenceShown).toBeGreaterThanOrEqual(1)
        expect(model.requestCount()).toBeGreaterThanOrEqual(4)
      } finally {
        await model.close()
        rmSync(attemptsRoot, { recursive: true, force: true })
        rmSync(gitDir, { recursive: true, force: true })
      }
    },
    180000,
  )
})
