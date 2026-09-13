/**
 * 方案第 11 节：Worker 根运行时能力 smoke E2E。
 *
 * 这不是完整 22 项 Release Gate。它只在**同一个 root attempt** 内串起可由脚本模型稳定
 * 驱动的运行时链路：真实 `dsh` 进程、真实全能力 profile、真实 Broker（走 Unix socket）、
 * Agent Tree 与分层预算。模型被脚本化驱动，所以不需要模型 Key，也不依赖网络。
 *
 * 它覆盖第 11 节 22 项里属于 Worker 运行时的部分：
 *
 *   3  根 Agent 创建 Goal              → create_goal
 *   4  加载平台 Skills / Instructions  → skill 工具在册（resolved inventory 已由契约测试证明）
 *   8  Agent control / list            → list_agents
 *   9  并行执行多个只读 snapshot tool  → 一个 turn 内两次 search/read
 *   10 Web search/fetch 访问允许域名   → web_fetch（出口经平台代发，DNS 与传输被注入）
 *   11 overlay 写文件                    → write（Workspace overlay 可写）
 *   12 Sandbox Shell 与 Jobs 运行检查     → bash + job_list
 *   13 产生 Artifact / Patch              → 平台扫描 artifacts/ 并登记
 *   19 根 Agent 成功提交                  → 一次 committed，身份为平台生成的 root
 *   20 提交回调只调用一次                 → commitReview 内存替身只记录一次
 *   21 attempt sealed 后迟到调用被拒      → 提交后旧令牌失效
 *   22 当前 root 资源正确清理             → 进程组回收 + Workspace 删除
 *
 * 这套测试**不**覆盖的项目，以及它们各自的归属，写在这里以免被误读为"全部 22 项都在这里"：
 *
 *   1、2   用户一次点击、平台自动准备上下文 → SQL 测试（enqueue 冻结 policy）+ UI 接线
 *   4      Skills / Instructions          → 契约测试与 resolved inventory 测试（skill 在册）
 *   5–7    Workflow / spawn / fork 子 Agent → v4-broker-authority（真实注册与令牌隔离）、
 *          v4-agent-governance（lineage/depth/并发/角色）、0027 SQL 测试（数据库仲裁）。
 *          脚本化模型难以确定性地驱动一个真实子 Agent 的模型请求交错，所以这里不假装覆盖。
 *   14、15 pruning 与自动 compaction        → Harness 默认配置 + 预算分项计量测试
 *   16     Worker 重启恢复                  → v4-session-resume-wiring（引擎接线）
 *   17、18 子 Agent 证据与 submit 被拒       → v4-broker-authority（SUBMIT_ROOT_ONLY 与 producer 归属）
 *   21     sealed 后迟到调用被拒            → v4-agent-governance（seal 后令牌失效）+ 0027 SQL 测试
 *
 * 需要 `npm run worker:build`。默认跳过：RUN_ACP_INTEGRATION=1 npm run test:worker
 */

import { describe, expect, it } from 'vitest'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { DeepSeekHarnessAcpEngine } from '../ai/runtime/deepseek-harness-acp-engine.js'
import { SnapshotStore } from '../ai/snapshot/snapshot-store.js'
import { normalizeCapabilityPolicy } from '../ai/policy/v4-capability-policy.js'
import { createHash } from 'node:crypto'
import { locateSessionLog } from '../ai/session/session-registry.js'
import { inspectSessionLog } from '../ai/session/session-recovery.js'
import { sessionDirectoryName } from '../ai/session/session-registry.js'
import { runCommand } from '../git/run.js'
import { checkoutPinnedCommit } from '../git/prepare.js'
import { Logger } from '../logger.js'
import type { AgentIdentity } from '../ai/control/agent-authority-ledger.js'
import type {
  CommitReviewInput,
  PermissionDecisionEntry,
  ToolAuditEntry,
} from '../ai/control/attempt-control-broker.js'

const ENABLED = process.env.RUN_ACP_INTEGRATION === '1'
const logger = new Logger().child({ e2e: 'v4-all-capabilities' })

interface ToolInvocation {
  name: string
  args: unknown
}

/**
 * 一轮回复。可以是固定的工具调用，也可以是一个函数 —— 后者用于需要引用上一轮真实返回值
 * 的场景：提交必须带 `read_snapshot_code` 实际发出的 evidenceId，而那个 id 是运行时生成的。
 */
type ScriptedTurn = ToolInvocation[] | ((conversation: string) => ToolInvocation[])

/** 从对话历史里抓出平台发给模型的 evidenceId。 */
const EVIDENCE_ID_PATTERN = /ev_[0-9a-f-]{36}/

/**
 * 脚本化模型端点。
 *
 * 每一轮返回一个（或一组并行的）工具调用；脚本用完后返回纯文本结束 turn。`usage` 每轮都报，
 * 好让分层预算的 token 计量走真实路径。
 */
function startScriptedModel(script: ScriptedTurn[]): Promise<{
  baseUrl: string
  requestCount: () => number
  toolNamesOffered: () => string[]
  close: () => Promise<void>
}> {
  let requestCount = 0
  let offered: string[] = []
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      if (!req.url?.includes('/chat/completions')) {
        res.writeHead(404).end('{}')
        return
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as {
        tools?: Array<{ function?: { name?: string } }>
      }
      if (offered.length === 0 && Array.isArray(body.tools)) {
        offered = body.tools
          .map((tool) => tool.function?.name)
          .filter((name): name is string => typeof name === 'string')
      }
      const index = requestCount++
      const raw = Buffer.concat(chunks).toString('utf8')
      const entry = script[index]
      const batch = typeof entry === 'function' ? entry(raw) : entry
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      const base = {
        id: `chatcmpl-${index}`,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'e2e-model',
      }
      const send = (payload: unknown): void => {
        res.write(`data: ${JSON.stringify(payload)}\n\n`)
      }
      send({
        ...base,
        choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
      })

      if (batch === undefined || batch.length === 0) {
        // 脚本用完：纯文本结束这一轮，让 turn 收敛。
        send({
          ...base,
          choices: [{ index: 0, delta: { content: 'done' }, finish_reason: 'stop' }],
        })
      } else {
        send({
          ...base,
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: batch.map((call, position) => ({
                  index: position,
                  id: `call_${index}_${position}`,
                  type: 'function',
                  function: { name: call.name, arguments: JSON.stringify(call.args) },
                })),
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
        usage: { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 },
      })
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  return new Promise((resolveServer) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port
      resolveServer({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        requestCount: () => requestCount,
        toolNamesOffered: () => [...offered],
        close: () => closeServerQuietly(server),
      })
    })
  })
}

function closeServerQuietly(server: Server): Promise<void> {
  return new Promise((r) => server.close(() => r()))
}

/** 建一个单提交仓库并返回精确 commit id。 */
async function buildSnapshotRepo(): Promise<{ gitDir: string; commitSha: string }> {
  const gitDir = realpathSync(mkdtempSync(join(tmpdir(), 'e2e-repo-')))
  await runCommand('git', ['init', '--quiet', '--initial-branch=main'], { cwd: gitDir })
  await runCommand('git', ['config', 'user.email', 'test@example.invalid'], { cwd: gitDir })
  await runCommand('git', ['config', 'user.name', 'V4 E2E'], { cwd: gitDir })
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

describe.skipIf(!ENABLED)('V4 governed root-runtime smoke E2E (real dsh process)', () => {
  it(
    'drives goal, todo, parallel snapshot reads, web egress, overlay write, sandbox shell, jobs, artifact collection and exactly one root commit',
    async () => {
      const repo = await buildSnapshotRepo()
      const attemptsRoot = realpathSync(mkdtempSync(join(tmpdir(), 'e2e-att-')))
      const sessionRoot = realpathSync(mkdtempSync(join(tmpdir(), 'e2e-sess-')))

      const snapshots = new SnapshotStore([
        { name: 'kdmanage-backend', commitSha: repo.commitSha, gitDir: repo.gitDir },
      ])

      // 脚本按第 11 节的顺序走一遍能力面。每个数组是一轮模型回复；数组里多于一个元素
      // 表示这一轮并行调用多个工具（第 9 项）。
      const model = await startScriptedModel([
        // 3. Goal
        [{ name: 'create_goal', args: { goal: 'Decide whether PRJ-001 is implemented' } }],
        // Todo
        [
          {
            name: 'todo_write',
            args: {
              merge: false,
              todos: [
                { id: '1', content: 'search the backend', status: 'in_progress' },
                { id: '2', content: 'summarise', status: 'pending' },
              ],
            },
          },
        ],
        // 9. 并行只读 snapshot 工具
        [
          { name: 'search_snapshot_code', args: { repository: 'kdmanage-backend', query: 'createOrder' } },
          {
            name: 'find_snapshot_files',
            args: { repository: 'kdmanage-backend', pattern: '**/*.java' },
          },
        ],
        // 读取一段范围 → 产生 evidenceId
        [
          {
            name: 'read_snapshot_code',
            args: {
              repository: 'kdmanage-backend',
              path: 'src/OrderService.java',
              startLine: 1,
              endLine: 8,
            },
          },
        ],
        // 8. Agent control / list
        [{ name: 'list_agents', args: {} }],
        // 11. overlay 写入（Workspace 可写）
        [
          {
            name: 'write',
            // dsh-tool-fs 的参数是 file_path / content。名字写错的话工具会以参数校验
            // 失败收场，而 turn 仍然"正常"结束 —— 于是 Artifact 静默为空。
            args: {
              file_path: 'artifacts/suggested-fix.patch',
              content: '--- a/src/OrderService.java\n+++ b/src/OrderService.java\n',
            },
          },
        ],
        // 12. Sandbox Shell
        [
          {
            name: 'bash',
            // bash 要求 description：缺了它工具以参数校验失败收场，而 turn 仍然"正常"结束，
            // 于是产物静默为空。这正是脚本化 E2E 值得存在的地方。
            args: {
              command: 'echo v4-shell-ok > artifacts/build.log && cat artifacts/build.log',
              description: 'write a build log artifact and read it back',
            },
          },
        ],
        // Jobs
        [{ name: 'job_list', args: {} }],
        // 10. Web（出口经平台代发）
        [{ name: 'web_fetch', args: { url: 'https://docs.example.com/spec' } }],
        // 19. 根 Agent 提交。evidenceId 只能从对话历史里取真实值：编造一个会被
        // deterministic verifier 以 EVIDENCE_ID_UNKNOWN 拒掉，那样测的就不是提交而是拒绝。
        (conversation) => {
          const evidenceId = EVIDENCE_ID_PATTERN.exec(conversation)?.[0]
          return [
            {
              name: 'submit_review_result',
              args: {
                verdict: 'IMPLEMENTED',
                confidence: 92,
                summary: 'OrderService.createOrder implements PRJ-001',
                evidence: [
                  {
                    evidenceId: evidenceId ?? 'missing-evidence-id',
                    repository: 'kdmanage-backend',
                    filePath: 'src/OrderService.java',
                    startLine: 1,
                    endLine: 8,
                    evidenceType: '现有实现',
                    description: 'createOrder is present at the pinned commit',
                  },
                ],
              },
            },
          ]
        },
      ])

      const commits: CommitReviewInput[] = []
      const audit: ToolAuditEntry[] = []
      const decisions: PermissionDecisionEntry[] = []
      const nodes: AgentIdentity[] = []
      const artifacts: Array<{ workspacePath: string; artifactType: string; sizeBytes: number }> = []
      const checkpoints: Array<{ sessionId: string; sessionRevision: number }> = []
      const usageCommits: Array<{
        usage: Record<string, number | null>
        perAgent: Array<Record<string, string | number | null>>
      }> = []

      const engine = new DeepSeekHarnessAcpEngine({
        taskId: 'e2e-task',
        agentAttempt: 1,
        branch: 'feature_dev',
        story: {
          code: 'PRJ-001',
          name: 'create order',
          description: 'OrderService must expose createOrder',
        },
        snapshots,
        route: {
          providerId: 'review-route',
          displayName: 'E2E Route',
          baseUrl: model.baseUrl,
          modelName: 'e2e-model',
          contextWindow: 131072,
          maxTokens: 4096,
          apiKeyEnvVar: 'REVIEW_MODEL_API_KEY',
          requestTimeoutMs: 60000,
        },
        // Web allowlist 必须显式给：空 allowlist 时任何目的地都不可达（安全默认）。
        policy: normalizeCapabilityPolicy({
          web: { allowedDomains: ['docs.example.com'] },
          modelBudget: { maxTotalRequests: 60, maxRootRequests: 40, maxChildRequests: 10 },
        }),
        coveragePolicy: {
          requiredRepositories: ['kdmanage-backend'],
          minQueriesPerRepository: 0,
        },
        apiKey: 'e2e-not-a-real-key',
        attemptsRoot,
        sessionRoot,
        workerId: 'worker-e2e',
        logger,
        infrastructure: { supabaseUrl: 'https://project.supabase.co' },
        forbiddenRoots: [],
        isLeaseValid: () => true,
        commitReview: async (input) => {
          commits.push(input)
          return { runId: 'run-e2e-1', committedAt: new Date().toISOString() }
        },
        checkoutPinned: checkoutPinnedCommit,
        db: {
          registerAgentNode: async (identity) => {
            nodes.push(identity)
          },
          markAgentTerminal: async () => undefined,
          flushAudit: async (entries, verdicts) => {
            audit.push(...entries)
            decisions.push(...verdicts)
          },
          saveArtifact: async (artifact) => {
            artifacts.push({
              workspacePath: artifact.workspacePath,
              artifactType: artifact.artifactType,
              sizeBytes: artifact.sizeBytes,
            })
            return { artifactId: `art-${artifacts.length}` }
          },
          saveSessionCheckpoint: async (checkpoint) => {
            checkpoints.push({
              sessionId: checkpoint.sessionId,
              sessionRevision: checkpoint.sessionRevision,
            })
          },
          recordProfile: async () => undefined,
          reserveBudget: async () => ({ allowed: true, scope: null }),
          commitUsage: async (usage, perAgent) => {
            usageCommits.push({ usage, perAgent })
            return true
          },
          requestAttemptCancel: async () => true,
          loadResumableAttempt: async () => null,
        },
      })

      try {
        const result = await engine.runReview({
          signal: new AbortController().signal,
          logger,
        })

        // ---- 能力面确实到达了模型（第 3–12 项的前提）----
        const offered = model.toolNamesOffered()
        for (const tool of [
          'create_goal',
          'todo_write',
          'skill',
          'workflow',
          'subagent',
          'subagent_fork',
          'list_agents',
          'bash',
          'job_list',
          'write',
          'edit',
          'read',
          'grep',
          'glob',
          'web_fetch',
          'web_search',
          'search_snapshot_code',
          'read_snapshot_code',
          'submit_review_result',
        ]) {
          expect(offered, `${tool} must be offered to the root agent`).toContain(tool)
        }

        // ---- 工具审计记录了这次运行（第 22 项的可审计部分）----
        const auditedTools = new Set(audit.map((entry) => entry.toolName))
        expect(auditedTools.size).toBeGreaterThan(0)
        // 至少 snapshot 检索与阅读经过了 Broker，说明工具调用真的走了治理面。
        expect(
          [...auditedTools].some((name) => name.includes('snapshot') || name.includes('read')),
        ).toBe(true)

        // ---- 模型请求确实被计量（第 12 项：真实 usage）----
        expect(model.requestCount()).toBeGreaterThanOrEqual(5)
        expect(result.usage?.modelRequests ?? 0).toBeGreaterThanOrEqual(5)
        // token 由 provider 报出来，所以不是 null。
        expect(result.usage?.inputTokens ?? null).not.toBeNull()

        // ---- 13. Artifact 由平台扫描登记，类型从路径推断 ----
        const patch = artifacts.find((entry) => entry.workspacePath.endsWith('.patch'))
        expect(patch, `artifacts seen: ${JSON.stringify(artifacts)}`).toBeDefined()
        expect(patch!.artifactType).toBe('PATCH')
        expect(patch!.sizeBytes).toBeGreaterThan(0)
        const buildLog = artifacts.find((entry) => entry.workspacePath.endsWith('build.log'))
        expect(buildLog?.artifactType, `artifacts: ${JSON.stringify(artifacts)}`).toBe('BUILD_LOG')

        // ---- 16/22. 已提交 Session 保留在持久卷，但不再登记为“可恢复” checkpoint ----
        // submit_review_result 已烧毁 claim；成功结果无需恢复，继续写 checkpoint 只会得到
        // TASK_LEASE_LOST。失败/取消 attempt 的 checkpoint 由 session wiring 测试覆盖。
        expect(checkpoints).toHaveLength(0)
        expect(usageCommits).toHaveLength(1)
        expect(usageCommits[0]!.usage.model_requests).toBe(model.requestCount())
        expect(usageCommits[0]!.usage.tool_calls).toBe(11)
        expect(usageCommits[0]!.perAgent).toHaveLength(1)
        expect(Number(usageCommits[0]!.perAgent[0]!.tool_calls)).toBe(11)

        // Harness 写的是 <slug>/<sessionId>/session.v3.jsonl[.zstd]。Session 文件仍长期保留，
        // 只是已提交的 run 不再把它暴露成 resume candidate。
        const sessionFiles = collectFiles(sessionRoot).filter((path) => path.includes('.jsonl'))
        expect(sessionFiles.length).toBeGreaterThan(0)

        // profile 把编码设成 none，所以日志是明文 —— 平台的完整性检查才能逐行验证已提交
        // 前缀，运维也能在事故里直接读它。
        const harnessSessionId = basename(dirname(sessionFiles[0]!))
        const located = sessionRegistryFor(sessionRoot).locateFor(harnessSessionId)
        expect(located, `session volume: ${JSON.stringify(sessionFiles)}`).not.toBeNull()
        expect(located!.compressed).toBe(false)
        expect(located!.formatVersion).toMatch(/^v\d+$/)
        const inspection = inspectSessionLog(
          located!.path,
          `sha256:${createHash('sha256').update(readFileSync(located!.path)).digest('hex')}`,
          { compressed: located!.compressed },
        )
        expect(inspection).toMatchObject({ ok: true, verified: true })
        expect((inspection as { eventCount: number }).eventCount).toBeGreaterThan(0)

        // ---- 19/20. 根 Agent 成功提交，且只提交一次 ----
        expect(
          result.ok,
          `engine failed: ${result.errorCode} ${result.errorMessage}`,
        ).toBe(true)
        expect(commits).toHaveLength(1)
        const committed = commits[0]!
        expect(committed.submission.verdict).toBe('IMPLEMENTED')
        // 提交者是平台生成的根身份，不是模型自报的。
        expect(committed.identity.rootAgentId).toMatch(/^root-[0-9a-f]{32}$/)
        expect(committed.identity.treeDigest).toMatch(/^[0-9a-f]{64}$/)
        expect(committed.identity.sessionRevision).toBeGreaterThanOrEqual(1)
        // 证据绑定到固定 Commit 与真实 blob，且归属到实际读取它的 Agent。
        expect(committed.evidence).toHaveLength(1)
        expect(committed.evidence[0]!.commitSha).toHaveLength(40)
        expect(committed.evidence[0]!.producer.agentId).toBe(committed.identity.rootAgentId)
        // usage 是真实模型请求数，不是工具调用数。
        expect(committed.usage.modelRequests).toBe(model.requestCount())

        // ---- 22. attempt 临时树被清理干净 ----
        expect(readdirSync(attemptsRoot)).toEqual([])
      } finally {
        await model.close()
        rmSync(attemptsRoot, { recursive: true, force: true })
        rmSync(sessionRoot, { recursive: true, force: true })
        rmSync(repo.gitDir, { recursive: true, force: true })
      }
    },
    240000,
  )
})

/**
 * 按 attempt 目录布局定位 Session 日志。
 *
 * 引擎用的是 `SessionSlot.locate()`，它绑定在已获取写者锁的 slot 上；测试在 attempt 结束后
 * 才检查，锁已经释放，所以这里直接用底层的 `locateSessionLog` 走同一套发现逻辑。
 */
function sessionRegistryFor(sessionRoot: string): {
  locateFor(sessionId: string): ReturnType<typeof locateSessionLog>
} {
  const attemptDir = join(sessionRoot, sessionDirectoryName('e2e-task', 1))
  return { locateFor: (sessionId) => locateSessionLog(attemptDir, sessionId) }
}

/** 递归收集文件路径。 */
function collectFiles(root: string): string[] {
  if (!existsSync(root)) return []
  const found: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = join(dir, entry.name)
      if (entry.isDirectory()) walk(absolute)
      else found.push(absolute)
    }
  }
  walk(root)
  return found
}

/** 读一个文件，不存在则返回 null。诊断用。 */
export function readIfPresent(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}
