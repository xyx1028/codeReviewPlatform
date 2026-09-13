/**
 * 方案第 11 节第 16 项：真实 dsh 进程的会话恢复。
 *
 * 单测（`v4-session-resume-wiring`）覆盖的是**判定逻辑**：兼容键是否一致、日志是否被改过、
 * 恢复次数是否超限。它证明不了最关键的一件事 —— **真实 dsh 到底认不认 `session/resume`**。
 * 那条路径上有两个只有真实进程能回答的问题：
 *
 *   1. agent 有没有在 initialize 里声明 `session/resume` 或 `session/load` 能力？没声明的话
 *      `runResumedTurn` 会抛 SessionResumeUnsupportedError，而平台的设计是**不静默降级**为
 *      新建会话 —— 于是每次重启都会失败，长任务永远做不完；
 *   2. 上一次 attempt 真的把 JSONL 写到持久卷了吗？写的路径能不能被 `locate()` 找到？
 *
 * 所以这套测试分两阶段跑同一个 taskId/attempt：
 *
 *   阶段一：起一次真实 attempt，让它落一份真实的 JSONL 会话日志（模拟"跑到一半被打断"）。
 *   阶段二：用阶段一写下的 checkpoint 再起一次，断言 ACP 层真的走了 resume 而不是新建，
 *          并且 dsh 接受了它。
 *
 * 两阶段共用一个内存 DB 替身与同一个 Session 持久卷根目录 —— 这正是生产里"Worker 重启、
 * Session 卷还在"的形态。
 *
 * 默认跳过（要起真实 dsh 进程）：
 *   RUN_ACP_INTEGRATION=1 npx vitest run worker/src/__tests__/v4-session-resume-real.test.ts
 */

import { describe, expect, it } from 'vitest'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DeepSeekHarnessAcpEngine } from '../ai/runtime/deepseek-harness-acp-engine.js'
import { SnapshotStore } from '../ai/snapshot/snapshot-store.js'
import { V4_DEFAULT_POLICY, policyHash as hashPolicy } from '../ai/policy/v4-capability-policy.js'
import { V4_ERROR_CODES } from '../ai/policy/v4-errors.js'
import { checkoutPinnedCommit } from '../git/prepare.js'
import { runCommand } from '../git/run.js'
import { Logger } from '../logger.js'
import type { CommitReviewInput } from '../ai/control/attempt-control-broker.js'

const ENABLED = process.env.RUN_ACP_INTEGRATION === '1'
const TASK_ID = 'resume-real-task'
const ATTEMPT = 1

/** 一次运行的观测结果。 */
interface RunResult {
  ok: boolean
  errorCode?: string
  errorMessage?: string
  events: Array<Record<string, unknown>>
  /** 引擎写出的 checkpoint，阶段二要原样喂回去。 */
  checkpoint: {
    sessionId: string
    sessionRevision: number
    storageLocator: string
    contentHash: string
    harnessVersion: string
    profileHash: string | null
  } | null
}

/**
 * 只调一次只读工具然后结束 turn 的脚本模型。
 *
 * 刻意不提交：提交会让 attempt 封存，而封存的 attempt 按设计**不可恢复**
 * （`load_resumable_analysis_attempt` 对已提交的返回 null）。要测恢复就必须留一个未提交的会话。
 */
function startScriptedModel(): Promise<{ baseUrl: string; requests: () => number; close: () => Promise<void> }> {
  let count = 0
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      if (!req.url?.includes('/chat/completions')) {
        res.writeHead(404).end('{}')
        return
      }
      const index = count++
      const base = {
        id: `chatcmpl-${index}`,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'resume-model',
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
      if (index === 0) {
        send({
          ...base,
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_read',
                    type: 'function',
                    function: {
                      name: 'read_snapshot_code',
                      arguments: JSON.stringify({
                        repository: 'kdmanage-backend',
                        path: 'src/OrderService.java',
                        startLine: 1,
                        endLine: 6,
                      }),
                    },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        })
        send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
      } else {
        send({
          ...base,
          choices: [{ index: 0, delta: { content: '本轮先停在这里。' }, finish_reason: null }],
        })
        send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
      }
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
        requests: () => count,
        close: () => new Promise<void>((done) => server.close(() => done())),
      })
    })
  })
}

async function buildRepo(): Promise<{ gitDir: string; commitSha: string }> {
  const gitDir = mkdtempSync(join(tmpdir(), 'resume-real-repo-'))
  await runCommand('git', ['init', '--quiet', '--initial-branch=main'], { cwd: gitDir })
  await runCommand('git', ['config', 'user.email', 'r@example.invalid'], { cwd: gitDir })
  await runCommand('git', ['config', 'user.name', 'Resume Real'], { cwd: gitDir })
  mkdirSync(join(gitDir, 'src'), { recursive: true })
  writeFileSync(
    join(gitDir, 'src', 'OrderService.java'),
    [
      'package main;',
      '',
      'public class OrderService {',
      '  public void createOrder() {}',
      '}',
      '',
    ].join('\n'),
  )
  await runCommand('git', ['add', '--all'], { cwd: gitDir })
  await runCommand('git', ['commit', '--quiet', '-m', 'seed'], { cwd: gitDir })
  const head = await runCommand('git', ['rev-parse', 'HEAD'], { cwd: gitDir })
  return { gitDir, commitSha: head.stdout.trim() }
}

describe.skipIf(!ENABLED)('real session resume (real dsh process)', () => {
  it(
    'resumes the same JSONL session through a real dsh process after a restart',
    async () => {
      const repo = await buildRepo()
      // Session 卷在两阶段之间**必须存活** —— 这正是生产里 attempt 目录被删、Session 卷保留的形态。
      const sessionRoot = mkdtempSync(join(tmpdir(), 'resume-real-sess-'))
      const model = await startScriptedModel()
      const cleanup = [repo.gitDir, sessionRoot]

      /** 跑一次 attempt。`resumable` 为阶段二喂回的 checkpoint 行。 */
      // attemptsRoot 在两阶段之间**共用**：生产里它是固定卷路径（AGENT_ATTEMPTS_ROOT），
      // 重启后仍在。用两个随机根等于人为破坏 cwd 一致性，而 Harness 的 session/resume 会校验
      // `sameDirectory(persisted.cwd, params.cwd)`。
      const attemptsRoot = mkdtempSync(join(tmpdir(), 'resume-real-att-'))
      cleanup.push(attemptsRoot)

      const runOnce = async (resumable: Record<string, unknown> | null): Promise<RunResult> => {
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
        let checkpoint: RunResult['checkpoint'] = null
        const commits: CommitReviewInput[] = []
        const engine = new DeepSeekHarnessAcpEngine({
          taskId: TASK_ID,
          agentAttempt: ATTEMPT,
          branch: 'feature_dev',
          story: {
            code: 'PRJ-RESUME',
            name: '恢复验证',
            description: '读取 OrderService 即可。',
            acceptanceCriteria: 'OrderService 提供 createOrder。',
          },
          snapshots: new SnapshotStore([
            { name: 'kdmanage-backend', commitSha: repo.commitSha, gitDir: repo.gitDir },
          ]),
          route: {
            providerId: 'review-route',
            displayName: 'Resume Route',
            baseUrl: model.baseUrl,
            modelName: 'resume-model',
            contextWindow: 131072,
            maxTokens: 4096,
            apiKeyEnvVar: 'REVIEW_MODEL_API_KEY',
            requestTimeoutMs: 60000,
          },
          policy: V4_DEFAULT_POLICY,
          coveragePolicy: {
            requiredRepositories: ['kdmanage-backend'],
            minQueriesPerRepository: 0,
          },
          apiKey: 'resume-not-a-real-key',
          attemptsRoot,
          sessionRoot,
          workerId: 'w-resume-real',
          infrastructure: {},
          forbiddenRoots: [],
          logger,
          isLeaseValid: () => true,
          checkoutPinned: checkoutPinnedCommit,
          commitReview: async (input) => {
            commits.push(input)
            return { runId: 'run-resume', committedAt: new Date().toISOString() }
          },
          db: {
            registerAgentNode: async () => undefined,
            markAgentTerminal: async () => undefined,
            flushAudit: async () => undefined,
            saveArtifact: async () => ({ artifactId: 'a-1' }),
            saveSessionCheckpoint: async (row) => {
              checkpoint = { ...row }
            },
            recordProfile: async () => undefined,
            reserveBudget: async () => ({ allowed: true, scope: null }),
            commitUsage: async () => true,
            requestAttemptCancel: async () => true,
            loadResumableAttempt: async () => resumable,
          },
        })
        const result = await engine.runReview({
          signal: new AbortController().signal,
          logger,
        })
        return {
          ok: result.ok,
          errorCode: result.errorCode,
          errorMessage: result.errorMessage,
          events,
          checkpoint,
        }
      }

      try {
        // ---- 阶段一：跑一次，留下一个未提交的真实会话 ----------------------
        const first = await runOnce(null)
        expect(first.checkpoint, '阶段一必须落下 checkpoint，否则没有可恢复的东西').not.toBeNull()
        const cp = first.checkpoint!
        // 会话日志必须真的在持久卷上，而不是在被删掉的 attempt 目录里。
        expect(cp.storageLocator.startsWith(sessionRoot)).toBe(true)
        expect(readdirSync(sessionRoot).length).toBeGreaterThan(0)

        // ---- 阶段二：用阶段一的 checkpoint 恢复 ----------------------------
        const second = await runOnce({
          agent_run_id: 'run-resume',
          root_agent_id: null,
          root_session_id: cp.sessionId,
          session_id: cp.sessionId,
          session_revision: cp.sessionRevision + 1,
          storage_locator: cp.storageLocator,
          content_hash: cp.contentHash,
          // 原样喂回引擎自己写的兼容键：两侧任何一处自己拼字符串，这条就会失败。
          harness_version: cp.harnessVersion,
          profile_hash: cp.profileHash,
          policy_hash: hashPolicy(V4_DEFAULT_POLICY),
          resume_count: 0,
        })

        const declined = second.events.find((e) => e.event === 'agent_attempt_resume_declined')
        expect(
          declined,
          `恢复被拒：${String(declined?.error_code)} ${String(declined?.reason)}`,
        ).toBeUndefined()

        const started = second.events.find((e) => e.event === 'agent_attempt_started')
        const finished = second.events.find((e) => e.event === 'agent_attempt_finished')
        // eslint-disable-next-line no-console
        console.log(
          [
            '',
            '========= 真实进程会话恢复 =========',
            `阶段一 session:   ${cp.sessionId}`,
            `阶段一兼容键:     ${cp.harnessVersion}`,
            `日志落点:         ${cp.storageLocator.replace(sessionRoot, '<sessionRoot>')}`,
            `阶段二 resumed:   ${String(finished?.resumed)}`,
            `阶段二 revision:  ${String(started?.session_revision ?? '(未记录)')}`,
            `阶段二结果:       ${second.ok ? 'ok' : `失败 ${second.errorCode}`}`,
            `阶段二错误详情:   ${String(second.errorMessage ?? '(无)')}`,
            `恢复相关事件:     ${JSON.stringify(
              second.events
                .filter((e) => String(e.event).includes('resume') || String(e.event).includes('session'))
                .map((e) => ({ event: e.event, code: e.error_code, reason: e.reason })),
            )}`,
            '===================================',
            '',
          ].join('\n'),
        )

        // 核心断言：真实 dsh 接受了 resume，引擎据此报告"这次是恢复"。
        expect(finished?.resumed).toBe(true)

        // ---- 阶段三：恢复被拒时，绝不篡改会话日志（方案 §12.3）-------------
        //
        // §12.3 明确要求"Session 格式不兼容时标记 SESSION_FORMAT_UNSUPPORTED，创建新 attempt，
        // 不篡改 JSONL"。日志里可能是一次跑了很久的长任务，被拒的一方擅自截断或删除它，就等于
        // 把唯一的取证材料销毁了。这里用一个必然被拒的 policy_hash 触发拒绝，然后逐字节核对。
        const beforeBytes = readFileSync(cp.storageLocator)
        const beforeHash = createHash('sha256').update(beforeBytes).digest('hex')
        const beforeSize = statSync(cp.storageLocator).size

        const refused = await runOnce({
          agent_run_id: 'run-resume',
          root_agent_id: null,
          root_session_id: cp.sessionId,
          session_id: cp.sessionId,
          session_revision: cp.sessionRevision + 2,
          storage_locator: cp.storageLocator,
          content_hash: cp.contentHash,
          harness_version: cp.harnessVersion,
          profile_hash: cp.profileHash,
          // 故意给一个不匹配的 policy hash：恢复必须被拒。
          policy_hash: 'deadbeef'.repeat(8),
          resume_count: 0,
        })
        const refusal = refused.events.find((e) => e.event === 'agent_attempt_resume_declined')
        expect(refusal, '这一轮必须是"恢复被拒"').toBeDefined()
        expect(refusal?.error_code).toBe(V4_ERROR_CODES.SESSION_FORMAT_UNSUPPORTED)

        const afterBytes = readFileSync(cp.storageLocator)
        expect(statSync(cp.storageLocator).size, '日志大小不得变化').toBe(beforeSize)
        expect(
          createHash('sha256').update(afterBytes).digest('hex'),
          '日志内容必须逐字节不变',
        ).toBe(beforeHash)
        // 不是静默新建：恢复失败时引擎会抛错而不是把 resumed 记成 false 继续跑。
        expect(second.errorCode).not.toBe('SESSION_RECOVERY_FAILED')
        expect(second.errorCode).not.toBe('SESSION_FORMAT_UNSUPPORTED')
        expect(second.errorCode).not.toBe('SESSION_FENCED')
      } finally {
        await model.close()
        for (const dir of cleanup) rmSync(dir, { recursive: true, force: true })
      }
    },
    300_000,
  )
})
