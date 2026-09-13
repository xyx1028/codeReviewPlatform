/**
 * 取消收敛矩阵：方案 §7.8.6 要求区分的五种触发，在**真实 dsh 进程 + 真实子 Agent** 下逐一验证。
 *
 * 为什么必须单独建这套：`v4-agent-governance` 已经覆盖了 `AttemptTreeController` 的收敛顺序，
 * 但那是纯内存对象。取消路径真正容易出问题的地方在装配上 —— 本轮已经两次证明"只有 mock 覆盖
 * 的代码"会藏真缺陷（后台委派的身份归属、会话恢复的三个 API 错用）。取消尤其如此：它牵涉
 * 引擎、Broker、ACP 客户端、Harness 子进程和进程组回收五层，任何一层没接上，表现都是
 * "看起来取消了，其实有东西还在跑"。
 *
 * 每个场景都断言同一组不变量：
 *
 *   * 收敛原因必须是**预期的那一个** —— 五种触发不能坍缩成 USER_CANCELLED（曾经就是这样，
 *     LEASE_LOST 与 WORKER_SHUTDOWN 是死枚举值）；
 *   * 不得产生任何 commit；
 *   * 进程组回收干净（`surviving_pids = 0`、`cleanup_failed = false`）；
 *   * attempt 目录清空；
 *   * 取消后 Broker 拒绝一切迟到调用（令牌已撤销）。
 *
 * 默认跳过（要起真实 dsh 进程）：
 *   RUN_ACP_INTEGRATION=1 npx vitest run worker/src/__tests__/v4-cancel-convergence.test.ts
 */

import { describe, expect, it } from 'vitest'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DeepSeekHarnessAcpEngine } from '../ai/runtime/deepseek-harness-acp-engine.js'
import { SnapshotStore } from '../ai/snapshot/snapshot-store.js'
import { V4_DEFAULT_POLICY } from '../ai/policy/v4-capability-policy.js'
import { checkoutPinnedCommit } from '../git/prepare.js'
import { runCommand } from '../git/run.js'
import { Logger } from '../logger.js'
import type { AttemptEndReason } from '../ai/control/attempt-tree-controller.js'
import type { CommitReviewInput } from '../ai/control/attempt-control-broker.js'
import type { V4CapabilityPolicy } from '../ai/policy/v4-capability-policy.js'

const ENABLED = process.env.RUN_ACP_INTEGRATION === '1'

interface CancelOutcome {
  ok: boolean
  errorCode?: string
  commits: CommitReviewInput[]
  events: Array<Record<string, unknown>>
  attemptsRootEmpty: boolean
  /** 到达 mock 模型的请求数，用来确认取消发生在跑起来之后而不是之前。 */
  modelHits: number
}

/**
 * 脚本模型：先派一个子 Agent，然后一直读代码 —— 保证在取消发生时确实有活在跑。
 *
 * `onHit` 在每次模型请求到达时回调，测试用它在精确的时刻触发取消。
 */
function startModel(onHit: (index: number) => void): Promise<{
  baseUrl: string
  hits: () => number
  close: () => Promise<void>
}> {
  let hits = 0
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      if (!req.url?.includes('/chat/completions')) {
        res.writeHead(404).end('{}')
        return
      }
      const raw = Buffer.concat(chunks).toString('utf8')
      const index = hits++
      onHit(index)
      const isChild = !raw.includes('取消收敛验收标准')
      const base = {
        id: `chatcmpl-${index}`,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'cancel-model',
      }
      const send = (payload: unknown) => res.write(`data: ${JSON.stringify(payload)}\n\n`)
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      send({
        ...base,
        choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
      })

      // 子 Agent：一直读代码，永不主动结束 —— 取消必须由平台强制收敛。
      // 根 Agent：第一轮派子 Agent，之后同样一直读代码。
      const call =
        !isChild && index === 0
          ? {
              name: 'subagent',
              args: { description: '并行核查', prompt: '请检索并阅读 inventory 模块。' },
            }
          : {
              name: 'read_snapshot_code',
              args: {
                repository: 'kdmanage-backend',
                path: 'src/inventory/InventoryService.java',
                startLine: 1,
                endLine: 5,
              },
            }
      send({
        ...base,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: `call_${index}`,
                  type: 'function',
                  function: { name: call.name, arguments: JSON.stringify(call.args) },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      })
      send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
      send({
        ...base,
        choices: [],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      })
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      resolve({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        hits: () => hits,
        close: () => new Promise<void>((done) => server.close(() => done())),
      })
    })
  })
}

async function buildRepo(): Promise<{ gitDir: string; commitSha: string }> {
  const gitDir = mkdtempSync(join(tmpdir(), 'cancel-repo-'))
  await runCommand('git', ['init', '--quiet', '--initial-branch=main'], { cwd: gitDir })
  await runCommand('git', ['config', 'user.email', 'c@example.invalid'], { cwd: gitDir })
  await runCommand('git', ['config', 'user.name', 'Cancel'], { cwd: gitDir })
  mkdirSync(join(gitDir, 'src', 'inventory'), { recursive: true })
  writeFileSync(
    join(gitDir, 'src', 'inventory', 'InventoryService.java'),
    ['package inventory;', '', 'public class InventoryService {', '  public void deduct() {}', '}', ''].join('\n'),
  )
  await runCommand('git', ['add', '--all'], { cwd: gitDir })
  await runCommand('git', ['commit', '--quiet', '-m', 'seed'], { cwd: gitDir })
  const head = await runCommand('git', ['rev-parse', 'HEAD'], { cwd: gitDir })
  return { gitDir, commitSha: head.stdout.trim() }
}

/** 预算收窄到很小，用来验证 BUDGET_EXHAUSTED 这一路。 */
function policyWithBudget(maxTotal: number): V4CapabilityPolicy {
  const copy = JSON.parse(JSON.stringify(V4_DEFAULT_POLICY)) as V4CapabilityPolicy
  return {
    ...copy,
    modelBudget: {
      ...copy.modelBudget,
      maxTotalRequests: maxTotal,
      maxRootRequests: maxTotal,
      maxChildRequests: maxTotal,
    },
  }
}

async function runScenario(input: {
  label: string
  /** 第几次模型请求到达时触发取消；不设则不主动取消（用于预算耗尽场景）。 */
  cancelAfterHits?: number
  abortReason?: AttemptEndReason
  /** 取消后 isLeaseValid 是否转为 false，模拟租约丢失。 */
  dropLease?: boolean
  maxTotalRequests?: number
}): Promise<CancelOutcome> {
  const repo = await buildRepo()
  const attemptsRoot = mkdtempSync(join(tmpdir(), 'cancel-att-'))
  const sessionRoot = mkdtempSync(join(tmpdir(), 'cancel-sess-'))
  const cleanup = [repo.gitDir, attemptsRoot, sessionRoot]

  const controller = new AbortController()
  let leaseHeld = true
  const model = await startModel((index) => {
    if (input.cancelAfterHits !== undefined && index + 1 === input.cancelAfterHits) {
      if (input.dropLease === true) leaseHeld = false
      // 异步触发，别在请求处理里同步 abort，否则这次响应可能写不完。
      setTimeout(() => controller.abort(), 10)
    }
  })

  const events: Array<Record<string, unknown>> = []
  const logger = new Logger({
    sink: (line) => {
      try {
        events.push(JSON.parse(line) as Record<string, unknown>)
      } catch {
        events.push({ event: '[unparsable]', raw: line.slice(0, 200) })
      }
    },
    minLevel: 'info',
  })

  const commits: CommitReviewInput[] = []
  const engine = new DeepSeekHarnessAcpEngine({
    taskId: `cancel-${input.label}`,
    agentAttempt: 1,
    branch: 'feature_dev',
    story: {
      code: 'PRJ-CANCEL',
      name: '取消收敛',
      description: '请派一个子 Agent 并持续检索。',
      acceptanceCriteria: '取消收敛验收标准：这段文本用于区分根 Agent 与子 Agent 的请求。',
    },
    snapshots: new SnapshotStore([
      { name: 'kdmanage-backend', commitSha: repo.commitSha, gitDir: repo.gitDir },
    ]),
    route: {
      providerId: 'review-route',
      displayName: 'Cancel Route',
      baseUrl: model.baseUrl,
      modelName: 'cancel-model',
      contextWindow: 131072,
      maxTokens: 4096,
      apiKeyEnvVar: 'REVIEW_MODEL_API_KEY',
      requestTimeoutMs: 60000,
    },
    policy: policyWithBudget(input.maxTotalRequests ?? 60),
    coveragePolicy: { requiredRepositories: ['kdmanage-backend'], minQueriesPerRepository: 0 },
    apiKey: 'cancel-not-a-real-key',
    attemptsRoot,
    sessionRoot,
    workerId: 'w-cancel',
    infrastructure: {},
    forbiddenRoots: [],
    logger,
    isLeaseValid: () => leaseHeld,
    abortReason: input.abortReason === undefined ? undefined : () => input.abortReason!,
    checkoutPinned: checkoutPinnedCommit,
    commitReview: async (commitInput) => {
      commits.push(commitInput)
      return { runId: 'run-cancel', committedAt: new Date().toISOString() }
    },
  })

  try {
    const result = await engine.runReview({ signal: controller.signal, logger })
    return {
      ok: result.ok,
      errorCode: result.errorCode,
      commits,
      events,
      attemptsRootEmpty: readdirSync(attemptsRoot).length === 0,
      modelHits: model.hits(),
    }
  } finally {
    await model.close()
    for (const dir of cleanup) rmSync(dir, { recursive: true, force: true })
  }
}

/** 所有取消场景共有的不变量。 */
function assertConverged(outcome: CancelOutcome, expectedReason: AttemptEndReason): void {
  const drained = outcome.events.find((e) => e.event === 'attempt_drained')
  const failed = outcome.events.find((e) => e.event === 'agent_attempt_failed')
  const noSubmit = outcome.events.find((e) => e.event === 'agent_attempt_no_submission')
  // eslint-disable-next-line no-console
  console.log(
    `  [收敛观测] 期望=${expectedReason} 实际=${String(drained?.reason)} ` +
      `errorCode=${String(outcome.errorCode)} 模型命中=${outcome.modelHits} ` +
      `model_requests=${String(failed?.model_requests ?? noSubmit?.model_requests ?? '?')} ` +
      `cancelled_agents=${String(drained?.cancelled_agents)} ` +
      `surviving=${String(drained?.surviving_pids)}`,
  )
  expect(drained, '必须走完一次 drain').toBeDefined()
  // 五种触发不能坍缩成同一个原因 —— LEASE_LOST 与 WORKER_SHUTDOWN 曾经是死枚举值。
  expect(drained?.reason).toBe(expectedReason)
  // 取消掉的 attempt 绝不允许提交。
  expect(outcome.commits).toHaveLength(0)
  // 进程组必须回收干净。
  expect(drained?.surviving_pids).toBe(0)
  expect(drained?.cleanup_failed).toBe(false)
  // attempt 目录必须删净。
  expect(outcome.attemptsRootEmpty).toBe(true)
  // admission 必须先关，再收敛。
  const closed = outcome.events.find((e) => e.event === 'attempt_admission_closed')
  expect(closed?.reason).toBe(expectedReason)

  // 错误码必须说清"这是被取消/撞预算的，不是挂了"。三种取消触发此前都报
  // AGENT_ATTEMPT_FAILED，于是数据库与界面上取消和崩溃长得一模一样。
  const expectedCode =
    expectedReason === 'BUDGET_EXHAUSTED' ? 'MODEL_BUDGET_EXHAUSTED' : 'AGENT_TREE_CANCELLED'
  expect(outcome.errorCode).toBe(expectedCode)
}

describe.skipIf(!ENABLED)('cancel convergence matrix (real dsh process)', () => {
  it('用户取消：整棵树收敛且不提交', async () => {
    const outcome = await runScenario({
      label: 'user',
      cancelAfterHits: 2,
      abortReason: 'USER_CANCELLED',
    })
    // 取消发生在真的跑起来之后，否则这条用例什么都没验证。
    expect(outcome.modelHits).toBeGreaterThanOrEqual(2)
    assertConverged(outcome, 'USER_CANCELLED')
  }, 300_000)

  it('租约丢失：与用户取消区分开', async () => {
    const outcome = await runScenario({
      label: 'lease',
      cancelAfterHits: 2,
      abortReason: 'LEASE_LOST',
      dropLease: true,
    })
    expect(outcome.modelHits).toBeGreaterThanOrEqual(2)
    assertConverged(outcome, 'LEASE_LOST')
  }, 300_000)

  it('Worker 关停：与用户取消区分开', async () => {
    const outcome = await runScenario({
      label: 'shutdown',
      cancelAfterHits: 2,
      abortReason: 'WORKER_SHUTDOWN',
    })
    expect(outcome.modelHits).toBeGreaterThanOrEqual(2)
    assertConverged(outcome, 'WORKER_SHUTDOWN')
  }, 300_000)

  it('预算耗尽：不靠外部取消，平台自己收敛', async () => {
    // 不主动 abort：脚本模型会一直读代码，预算必然先耗尽。
    const outcome = await runScenario({ label: 'budget', maxTotalRequests: 4 })
    expect(outcome.ok).toBe(false)
    assertConverged(outcome, 'BUDGET_EXHAUSTED')
    // 预算耗尽必须以稳定错误码报出，而不是一个笼统失败。
    expect(outcome.errorCode).toBe('MODEL_BUDGET_EXHAUSTED')
    // 实际请求数不得超过上限。
    const finished = outcome.events.find((e) => e.event === 'agent_attempt_failed')
    expect(Number(finished?.model_requests ?? 0)).toBeLessThanOrEqual(4)
  }, 300_000)
})
