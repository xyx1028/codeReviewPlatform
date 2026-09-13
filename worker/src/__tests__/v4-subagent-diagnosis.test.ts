/**
 * 诊断：`subagent` 在 V4 全能力 Profile 下究竟能不能真的派出子 Agent。
 *
 * 为什么需要这个测试：真实模型 E2E 里 deepseek-v4-pro 确实调用了 `subagent`、`list_agents`、
 * `send_message`，但 attempt 结束时 `agent_count = 1`、`child_model_requests = 0` —— 也就是
 * **authority ledger 从没见过任何子 Agent，预算账本也没记到任何 child 请求**。两种解释，
 * 后果完全不同：
 *
 *   1. subagent 调用失败了 → "多 Agent 并行编排"在生产上根本不成立，架构文档第 3 节的
 *      核心卖点是空的；
 *   2. subagent 成功了但绕过了 Broker 注册 → 存在一个未受治理的 Agent 在跑，
 *      root-only 提交与分层预算都被绕过，是安全漏洞。
 *
 * 真实模型看不出是哪一种（它拿到错误就换策略继续干，不会告诉我们）。所以这里用脚本模型
 * 精确复现，并且用一个巧妙的判别器：**请求里的 tools 数组**。根 Agent 的工具面含
 * `submit_review_result`，子 Agent 按角色收窄后一定不含它 —— 于是 mock 端点只看 tools 就能
 * 判断这一次请求来自根还是子，顺便直接验证了工具收窄。
 *
 * 默认跳过（要起真实 dsh 进程）：
 *   RUN_ACP_INTEGRATION=1 npx vitest run worker/src/__tests__/v4-subagent-diagnosis.test.ts
 */

import { describe, expect, it } from 'vitest'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DeepSeekHarnessAcpEngine } from '../ai/runtime/deepseek-harness-acp-engine.js'
import { SnapshotStore } from '../ai/snapshot/snapshot-store.js'
import { V4_DEFAULT_POLICY } from '../ai/policy/v4-capability-policy.js'
import { checkoutPinnedCommit } from '../git/prepare.js'
import { runCommand } from '../git/run.js'
import { Logger } from '../logger.js'
import type { CommitReviewInput } from '../ai/control/attempt-control-broker.js'

const ENABLED = process.env.RUN_ACP_INTEGRATION === '1'

/** 一次到达 mock 端点的模型请求的摘要。 */
interface ObservedRequest {
  index: number
  /** 工具面里是否有提交工具 —— 有则是根 Agent，没有则是子 Agent。 */
  hasSubmitTool: boolean
  toolCount: number
  toolNames: string[]
  /** 最后一条消息的角色，用来看是不是工具结果回灌。 */
  lastRole: string
  /** 整个请求体里出现过的错误码，用来发现 subagent 失败原因。 */
  errorCodes: string[]
  bodyBytes: number
  /** 最后一条 role=tool 消息的正文 —— subagent 到底返回了什么，答案在这里。 */
  lastToolContent: string | null
  /** system 提示的指纹。根 Agent 与子 Agent 的系统提示不同，用它可靠区分二者。 */
  systemFingerprint: string
  /** 是否出现了根 Agent 专有的需求文本 —— 另一个判别信号。 */
  carriesStoryPrompt: boolean
}

const ERROR_CODE_PATTERN =
  /(AGENT_IDENTITY_INVALID|AGENT_ROLE_DENIED|SUBMIT_ROOT_ONLY|AGENT_TREE_LIMIT_EXCEEDED|AGENT_TREE_CANCELLED|MODEL_BUDGET_EXHAUSTED|TOOL_BUDGET_EXHAUSTED|BROKER_UNAVAILABLE|BROKER_PROTOCOL_ERROR|BROKER_TIMEOUT|WORKSPACE_POLICY_DENIED|WEB_EGRESS_DENIED)/g

/**
 * 一个会自己判断"来者是根还是子"的 mock 端点。
 *
 * 根 Agent：按脚本走 —— 先 subagent，然后提交。
 * 子 Agent：直接返回一段纯文本结论并结束 turn（子 Agent 不需要调工具就能证明它跑起来了）。
 */
function startDiscriminatingModel(): Promise<{
  baseUrl: string
  observed: ObservedRequest[]
  close: () => Promise<void>
}> {
  const observed: ObservedRequest[] = []
  let rootTurn = 0

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      if (!req.url?.includes('/chat/completions')) {
        res.writeHead(404).end('{}')
        return
      }
      const raw = Buffer.concat(chunks).toString('utf8')
      let parsed: {
        tools?: Array<{ function?: { name?: string } }>
        messages?: Array<{ role?: string; content?: unknown }>
      } = {}
      try {
        parsed = JSON.parse(raw) as typeof parsed
      } catch {
        // 解析不了也要留痕，不能让诊断静默失败。
      }
      const toolNames = (parsed.tools ?? [])
        .map((t) => t.function?.name ?? '')
        .filter((n) => n !== '')
      const hasSubmitTool = toolNames.includes('submit_review_result')
      const messages = parsed.messages ?? []
      observed.push({
        index: observed.length,
        hasSubmitTool,
        toolCount: toolNames.length,
        toolNames,
        lastRole: String(messages[messages.length - 1]?.role ?? '?'),
        systemFingerprint: (() => {
          const sys = messages.find((m) => m.role === 'system')
          const c = sys?.content
          const text = typeof c === 'string' ? c : JSON.stringify(c ?? '')
          return text.replace(/\s+/g, ' ').slice(0, 70)
        })(),
        carriesStoryPrompt: raw.includes('inventory 模块具备完整业务规则'),
        lastToolContent: (() => {
          for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i]?.role === 'tool') {
              const c = messages[i]!.content
              return typeof c === 'string' ? c : JSON.stringify(c)
            }
          }
          return null
        })(),
        errorCodes: [...new Set(raw.match(ERROR_CODE_PATTERN) ?? [])],
        bodyBytes: raw.length,
      })

      const base = {
        id: `chatcmpl-${observed.length}`,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'diag-model',
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

      // 判别子 Agent：请求里不带需求文本即为子 Agent（根 Agent 的 prompt 含验收标准）。
      const isChild = !raw.includes('inventory 模块具备完整业务规则')
      if (isChild && process.env.DIAG_CHILD_SUBMIT === '1' && hasSubmitTool) {
        // **安全底线测试**：workflow 子 Agent 在 Harness 侧无法被 toolFilter 收窄，所以它
        // 看得见 `submit_review_result`。让它真的调用一次 —— 平台必须拒绝（SUBMIT_ROOT_ONLY），
        // 且不得产生第二次 commit。这是方案 §11 第 18 项，也是"根 Agent 唯一提交"的底线。
        send({
          ...base,
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: `call_child_${observed.length}`,
                    type: 'function',
                    function: {
                      name: 'submit_review_result',
                      arguments: JSON.stringify({
                        verdict: 'IMPLEMENTED',
                        confidence: 99,
                        summary: 'child agent attempting to submit',
                        implementedContent: 'child bypass attempt',
                        evidence: [],
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
        send({
          ...base,
          choices: [],
          usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
        })
        res.write('data: [DONE]\n\n')
        res.end()
        return
      }
      if (!hasSubmitTool || isChild) {
        // 子 Agent：返回纯文本结论并结束。它能走到这里就说明子 Agent 真的跑起来了。
        send({
          ...base,
          choices: [
            {
              index: 0,
              delta: { content: 'inventory 模块已实现全部业务规则，无缺口。' },
              finish_reason: null,
            },
          ],
        })
        send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
      } else {
        // 根 Agent：第一轮派子 Agent，之后提交（不带 evidence，被拒也不影响诊断结论）。
        const turn = rootTurn++
        // DIAG_TOOL 选择被诊断的委派工具：subagent（默认）/ subagent_fork / workflow /
        // job（后台进程回收）/ bigread（结果裁剪与自动压缩）。
        const diagTool = process.env.DIAG_TOOL ?? 'subagent'
        // bigread 需要更多轮次把上下文撑到压缩阈值。
        const POLL_ROUNDS = diagTool === 'bigread' ? 24 : 8
        // `subagent` 是 backgroundMode: 'continuable'（见 profile-materializer），调用后
        // **立即返回** `started subagent <id>`，子 Agent 在后台跑。所以根 Agent 必须继续
        // 轮询才能等到结果 —— 上一版脚本派完就结束 turn，子 Agent 直接被收敛掉了，看起来
        // 像"委派无效"，其实是脚本没给它机会。这里改成派完连续 list_agents 若干轮。
        if (turn > POLL_ROUNDS) {
          send({
            ...base,
            choices: [{ index: 0, delta: { content: '诊断结束。' }, finish_reason: null }],
          })
          send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
          send({
            ...base,
            choices: [],
            usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
          })
          res.write('data: [DONE]\n\n')
          res.end()
          return
        }
        // 工具描述称 continuable 模式下 `send_message` 会在子 Agent 空闲时启动一个 turn。
        // 从上一轮的工具结果里抓 subagent id，第 1 轮显式 send_message，其余轮次轮询。
        const idMatch = raw.match(/started subagent ([0-9a-f-]{36})/)
        const subagentId = idMatch?.[1]
        // DIAG_TOOL=job：起一个明显活过 attempt 的后台进程，验证收敛是否真的不留孤儿。
        // 这是判断"Jobs 按 owner session 精确取消"到底是不是缺口的直接证据 —— 平台侧没有
        // Job 清单可枚举，兜底靠 session/cancel 加进程组回收，能不能兜住只能实测。
        // DIAG_TOOL=bigread：反复读一个很大的范围。配合下面把 contextWindow 调小，
        // 用来验证方案 §11 的第 14（工具结果裁剪）与第 15（自动上下文压缩）项。
        const bigReadCall = {
          name: 'read_snapshot_code',
          args: {
            repository: 'kdmanage-backend',
            path: 'src/inventory/BulkRules.java',
            startLine: 1,
            endLine: 8000,
          },
        }
        const jobCall = {
          name: 'bash',
          args: {
            command:
              process.env.DIAG_ESCAPE === '1'
                ? // setsid 会让子进程脱离进程组 —— 这是 kill(-pgid) 兜不住的真实孤儿风险。
                  'setsid sleep 31338 >/dev/null 2>&1 < /dev/null & echo escaped $!'
                : 'nohup sleep 31337 >/dev/null 2>&1 & echo started $!',
            description: '起一个活过 attempt 的后台进程',
          },
        }
        const forkCall = {
          name: 'subagent_fork',
          args: {
            description: '交叉审查 inventory 模块',
            prompt: '请基于已有上下文交叉审查 inventory 模块的结论。',
          },
        }
        // workflow 的入参是 { script, meta }：script 是纯 JS 体，用 agent() 派子 Agent。
        const workflowCall = {
          name: 'workflow',
          args: {
            meta: {
              name: 'module-audit',
              description: '并行核查 inventory 与 payment 两个模块',
            },
            script: [
              'const results = await Promise.all([',
              '  agent("请核查 inventory 模块并回报结论。"),',
              '  agent("请核查 payment 模块并回报结论。"),',
              ']);',
              'return { results: results.map((r) => String(r).slice(0, 200)) };',
            ].join('\n'),
          },
        }
        // 后台模式下连续派两个：真正要验证的是"多个后台子 Agent 能否并行注册并各自跑完"。
        const parallelBackground =
          process.env.DIAG_BACKGROUND === '1' && diagTool === 'subagent' && turn <= 1
        const call =
          parallelBackground
            ? {
                name: 'subagent',
                args: {
                  description: `核查模块 ${turn}`,
                  prompt: `请核查模块 ${turn} 并回报结论。`,
                  run_in_background: true,
                },
              }
            : diagTool === 'bigread'
            ? bigReadCall
            : turn === 0 && diagTool === 'job'
            ? jobCall
            : turn === 0 && diagTool === 'subagent_fork'
            ? forkCall
            : turn === 0 && diagTool === 'workflow'
              ? workflowCall
              : turn === 0
            ? {
                name: 'subagent',
                args: {
                  description: '核查 inventory 模块',
                  prompt:
                    '请检索并阅读 inventory 模块的实现，回报是否具备完整业务规则。',
                  // 真实模型（deepseek-v4-pro）实际就是这么调的：它为了"并行"选了后台模式，
                  // 拿到 job id 后用 job_output 收。这里复现该路径，确认它是否真的执行子 Agent。
                  ...(process.env.DIAG_BACKGROUND === '1' ? { run_in_background: true } : {}),
                },
              }
            : turn === 1 && subagentId !== undefined
              ? {
                  name: 'send_message',
                  args: {
                    agent_id: subagentId,
                    message: '请现在开始核查 inventory 模块并回报结论。',
                  },
                }
              : process.env.DIAG_BACKGROUND === '1'
                ? (() => {
                    const jobMatch = raw.match(/started background subagent job ([\w-]+)/)
                    return jobMatch
                      ? { name: 'job_output', args: { job_id: jobMatch[1] } }
                      : { name: 'job_list', args: {} }
                  })()
                : { name: 'list_agents', args: {} }
        send({
          ...base,
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: `call_${observed.length}`,
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

  return new Promise((resolveServer) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      resolveServer({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        observed,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done())
          }),
      })
    })
  })
}

async function buildRepo(): Promise<{ gitDir: string; commitSha: string }> {
  const gitDir = mkdtempSync(join(tmpdir(), 'diag-repo-'))
  await runCommand('git', ['init', '--quiet', '--initial-branch=main'], { cwd: gitDir })
  await runCommand('git', ['config', 'user.email', 'diag@example.invalid'], { cwd: gitDir })
  await runCommand('git', ['config', 'user.name', 'Diag'], { cwd: gitDir })
  mkdirSync(join(gitDir, 'src', 'inventory'), { recursive: true })
  writeFileSync(
    join(gitDir, 'src', 'inventory', 'InventoryService.java'),
    ['package inventory;', '', 'public class InventoryService {', '  public void deduct() {}', '}', ''].join('\n'),
  )
  // 一个足够大的文件：用来把单次工具结果和整体上下文撑起来，验证结果裁剪与自动压缩。
  const bulk: string[] = ['package inventory;', '', 'public class BulkRules {']
  for (let i = 0; i < 4000; i++) {
    bulk.push(`  /** 规则 ${i} 的详细说明，用于把上下文撑大到触发压缩阈值。 */`)
    bulk.push(`  public String rule${i}(String input) { return "BulkRules.rule${i}:" + input; }`)
  }
  bulk.push('}', '')
  writeFileSync(join(gitDir, 'src', 'inventory', 'BulkRules.java'), bulk.join('\n'))
  await runCommand('git', ['add', '--all'], { cwd: gitDir })
  await runCommand('git', ['commit', '--quiet', '-m', 'seed'], { cwd: gitDir })
  const head = await runCommand('git', ['rev-parse', 'HEAD'], { cwd: gitDir })
  return { gitDir, commitSha: head.stdout.trim() }
}

describe.skipIf(!ENABLED)('subagent diagnosis (real dsh process, scripted model)', () => {
  it(
    'reveals whether a scripted subagent call actually creates a governed child agent',
    async () => {
      const repo = await buildRepo()
      const attemptsRoot = mkdtempSync(join(tmpdir(), 'diag-att-'))
      const sessionRoot = mkdtempSync(join(tmpdir(), 'diag-sess-'))
      const model = await startDiscriminatingModel()
      const cleanup = [repo.gitDir, attemptsRoot, sessionRoot]

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
        taskId: 'diag-subagent',
        agentAttempt: 1,
        branch: 'feature_dev',
        story: {
          code: 'DIAG-1',
          name: 'subagent 诊断',
          description: '请派一个子 Agent 核查 inventory 模块。',
          acceptanceCriteria: 'inventory 模块具备完整业务规则。',
        },
        snapshots: new SnapshotStore([
          { name: 'kdmanage-backend', commitSha: repo.commitSha, gitDir: repo.gitDir },
        ]),
        route: {
          providerId: 'review-route',
          displayName: 'Diag Route',
          baseUrl: model.baseUrl,
          modelName: 'diag-model',
          contextWindow: Number(process.env.DIAG_CONTEXT_WINDOW ?? 131072),
          maxTokens: 4096,
          apiKeyEnvVar: 'REVIEW_MODEL_API_KEY',
          requestTimeoutMs: 60000,
        },
        policy: V4_DEFAULT_POLICY,
        coveragePolicy: {
          requiredRepositories: ['kdmanage-backend'],
          minQueriesPerRepository: 0,
        },
        apiKey: 'diag-not-a-real-key',
        attemptsRoot,
        sessionRoot,
        workerId: 'w-diag',
        infrastructure: {},
        forbiddenRoots: [],
        logger,
        isLeaseValid: () => true,
        checkoutPinned: checkoutPinnedCommit,
        commitReview: async (input) => {
          commits.push(input)
          return { runId: 'run-diag', committedAt: new Date().toISOString() }
        },
      })

      try {
        const result = await engine.runReview({
          signal: new AbortController().signal,
          logger,
        })

        const finished = events.find((e) => e.event === 'agent_attempt_finished')
        const failed = events.find((e) => e.event === 'agent_attempt_failed')
        const drained = events.find((e) => e.event === 'attempt_drained')
        // 用系统提示指纹分组：根 Agent 与子 Agent 的 system prompt 不同。只看 submit 工具
        // 会在"子 Agent 也拿到了提交工具"时把子请求误判成根请求 —— 而那恰恰是要查的问题。
        const fingerprints = [...new Set(model.observed.map((r) => r.systemFingerprint))]
        const rootFingerprint = model.observed.find((r) => r.carriesStoryPrompt)?.systemFingerprint
        const rootRequests = model.observed.filter((r) => r.systemFingerprint === rootFingerprint)
        const childRequests = model.observed.filter((r) => r.systemFingerprint !== rootFingerprint)
        const allErrorCodes = [...new Set(model.observed.flatMap((r) => r.errorCodes))]

        // eslint-disable-next-line no-console
        console.log(
          [
            '',
            '============ subagent 诊断 ============',
            `attempt 结果:        ${result.ok ? 'ok' : `失败 ${result.errorCode}`}`,
            `到达模型的请求总数:  ${model.observed.length}`,
            `  其中根 Agent:      ${rootRequests.length}（工具面含 submit_review_result）`,
            `  其中子 Agent:      ${childRequests.length}（工具面不含提交工具）`,
            `不同 system 指纹数:  ${String(fingerprints.length)}（>1 说明确实出现了子 Agent）`,
            `根工具面大小:        ${String(rootRequests[0]?.toolCount ?? '?')}`,
            `子 Agent 是否拿到提交工具: ${childRequests.length === 0 ? '(无子请求)' : childRequests.some((r) => r.hasSubmitTool) ? '**是 —— 工具面收窄失效**' : '否（已收窄）'}`,
            `子工具面大小:        ${String(childRequests[0]?.toolCount ?? '(无子请求)')}`,
            `子 Agent 工具清单:   ${childRequests[0]?.toolNames.sort().join(', ') ?? '(无)'}`,
            `ledger 记录 Agent 数: ${String(finished?.agent_count ?? failed?.agent_count ?? '?')}`,
            `预算账本 child 请求:  ${String(finished?.child_model_requests ?? 0)}`,
            `请求体里出现的错误码: ${allErrorCodes.length > 0 ? allErrorCodes.join(', ') : '(无)'}`,
            `commitReview 调用次数: ${String(commits.length)}`,
            `被拒的提交:           ${JSON.stringify(finished?.rejected_submissions ?? failed?.rejected_submissions ?? [])}`,
            `模型调用过的工具:     ${JSON.stringify(finished?.tool_names ?? failed?.tool_names ?? [])}`,
            `Broker 路由计数:      ${JSON.stringify(finished?.tool_calls_by_name ?? failed?.tool_calls_by_name ?? {})}`,
            `压缩请求数:           ${String(finished?.compaction_requests ?? failed?.compaction_requests ?? '(未记录)')}`,
            `重试请求数:           ${String(finished?.retry_requests ?? '(未记录)')}`,
            `请求体最大字节:       ${String(Math.max(...model.observed.map((r) => r.bodyBytes), 0))}`,
            `请求体末次字节:       ${String(model.observed[model.observed.length - 1]?.bodyBytes ?? 0)}`,
            `收敛 reason:          ${String(drained?.reason ?? '(无)')}`,
            `存活进程数:           ${String(drained?.surviving_pids ?? '(无)')}`,
            `清理失败:             ${String(drained?.cleanup_failed ?? '(无)')}`,
            `失败事件 error_code:  ${String(failed?.error_code ?? '(无)')}`,
            `失败事件 error_msg:   ${String(failed?.error_message ?? '(无)')}`,
            `子进程 stderr 字节:   ${String(failed?.child_stderr_bytes ?? 0)}`,
            '======================================',
            '',
          ].join('\n'),
        )
        const stderrTail = failed?.child_stderr_tail
        if (typeof stderrTail === 'string' && stderrTail.length > 0) {
          // eslint-disable-next-line no-console
          console.log('---- 子进程 stderr 尾部 ----')
          // eslint-disable-next-line no-console
          console.log(stderrTail.slice(-3000))
          // eslint-disable-next-line no-console
          console.log('---- stderr 结束 ----')
        }
        const noSubmission = events.find((e) => e.event === 'agent_attempt_no_submission')
        if (noSubmission) {
          // eslint-disable-next-line no-console
          console.log('prompt_error:', JSON.stringify(noSubmission.prompt_error))
          // Harness 子进程的 stderr 被 supervisor 缓冲，只在这个事件里带出来。平台插件写到
          // stderr 的诊断信息（例如审计上报失败）只能从这里看到。
          const tail = noSubmission.child_stderr_tail
          // eslint-disable-next-line no-console
          console.log('child_stderr_bytes:', String(noSubmission.child_stderr_bytes ?? 0))
          if (typeof tail === 'string' && tail.length > 0) {
            // eslint-disable-next-line no-console
            console.log('---- 子进程 stderr 尾部 ----')
            // eslint-disable-next-line no-console
            console.log(tail.slice(-4000))
            // eslint-disable-next-line no-console
            console.log('---- stderr 结束 ----')
          }
        }
        // subagent 与 list_agents 的返回是本次诊断的核心证据。
        for (const r of model.observed) {
          if (r.lastToolContent !== null) {
            // eslint-disable-next-line no-console
            console.log(`---- 请求 #${r.index} 携带的最后一条 tool 结果 ----`)
            // eslint-disable-next-line no-console
            console.log(r.lastToolContent.slice(0, 2000))
            // eslint-disable-next-line no-console
            console.log('---- tool 结果结束 ----')
          }
        }
        // 每一次请求的细节，用来看子 Agent 到底有没有出现、以及它拿到了什么。
        for (const r of model.observed) {
          // eslint-disable-next-line no-console
          console.log(
            `  #${String(r.index).padStart(2)} submitTool=${r.hasSubmitTool ? 'YES' : 'no '}` +
              ` tools=${String(r.toolCount).padStart(2)} story=${r.carriesStoryPrompt ? 'Y' : 'n'}` +
              ` lastRole=${r.lastRole.padEnd(6)} bytes=${r.bodyBytes}` +
              (r.errorCodes.length > 0 ? ` errors=${r.errorCodes.join(',')}` : '') +
              `\n      sys="${r.systemFingerprint}"`,
          )
        }

        // 硬断言：任何子 Agent 请求的工具面都不得含提交工具。
        //
        // 这一条现在对**全部**委派路径成立（subagent / subagent_fork / workflow / 后台 job），
        // 因为收窄点从 `tool-subagent` 的 toolFilter 换成了 `agent/created` 时对子 Agent scoped
        // context 调 `tools.restrict()`。此前 workflow 子 Agent 拿的是与根相同的 30 个工具。
        //
        // 判据不看 hasSubmitTool 的分组（那个分组本身就依赖工具面），而是遍历所有"不带需求
        // 文本"的请求 —— 那些一定是子 Agent。
        const childByStory = model.observed.filter((r) => !r.carriesStoryPrompt)
        for (const child of childByStory) {
          expect(
            child.toolNames,
            `子 Agent 请求 #${child.index} 的工具面里出现了提交工具`,
          ).not.toContain('submit_review_result')
        }
        // 至少根 Agent 要跑起来，否则这次诊断本身没跑成。
        expect(rootRequests.length).toBeGreaterThan(0)
      } finally {
        await model.close()
        for (const dir of cleanup) rmSync(dir, { recursive: true, force: true })
      }
    },
    300_000,
  )
})
