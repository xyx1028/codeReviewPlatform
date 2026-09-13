/**
 * 真实仓库 E2E：方案第 11 节要求的"真实固定 Commit 的小 Job"。
 *
 * 与 `v4-real-model-e2e.test.ts` 的区别只有一处，但正是方案第 11 节字面要求的那一处：
 * **仓库不是本地现造的，而是从 GitLab 按精确 SHA 浅取的真实仓库**。这条路径此前从未验证过，
 * 而它覆盖的东西是本地造仓库覆盖不到的：
 *
 *   1. `prepareRepositoryAtSnapshot()` 的真实取回、SHA 校验与只读缓存发布；
 *   2. 真实工程规模下的检索（文件数、目录深度、非 ASCII 路径与内容）；
 *   3. Evidence 绑定的是**真实 commit 的真实 blob**，而不是测试夹具造出来的；
 *   4. 固定 Commit 只读物化到 Workspace 之后，Shell / Filesystem 看到的是真实源码树。
 *
 * 默认跳过，需要三样：GitLab 可达 + 凭据（读 `.docker/worker.env`）+ 模型 Key（读 `.env.local`）。
 *
 *   set -a; . ./.docker/worker.env; . ./.env.local; set +a
 *   RUN_REAL_REPO_E2E=1 npx vitest run worker/src/__tests__/v4-real-repo-e2e.test.ts
 *
 * 仓库与 commit 可覆盖：`E2E_REPO`（默认 kdmanage-backend）、`E2E_BRANCH`（默认 feature_dev）、
 * `E2E_COMMIT`（默认取该分支当前 HEAD）。
 */

import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DeepSeekHarnessAcpEngine } from '../ai/runtime/deepseek-harness-acp-engine.js'
import { SnapshotStore } from '../ai/snapshot/snapshot-store.js'
import { V4_DEFAULT_POLICY } from '../ai/policy/v4-capability-policy.js'
import {
  checkoutPinnedCommit,
  prepareRepository,
  prepareRepositoryAtSnapshot,
  type PrepareOptions,
} from '../git/prepare.js'
import { Logger } from '../logger.js'
import type { BranchName, RepositoryName } from '../git/repositories.js'
import type { CommitReviewInput } from '../ai/control/attempt-control-broker.js'
import type { V4CapabilityPolicy } from '../ai/policy/v4-capability-policy.js'

const ENABLED =
  process.env.RUN_REAL_REPO_E2E === '1' &&
  (process.env.REVIEW_MODEL_API_KEY ?? '') !== '' &&
  (process.env.E2E_MODEL_BASE_URL ?? '') !== '' &&
  (process.env.E2E_MODEL_NAME ?? '') !== '' &&
  (process.env.GITLAB_BASE_URL ?? '') !== ''

const REPO = (process.env.E2E_REPO ?? 'kdmanage-backend') as RepositoryName
const BRANCH = (process.env.E2E_BRANCH ?? 'feature_dev') as BranchName
const MAX_REQUESTS = Number(process.env.E2E_MAX_MODEL_REQUESTS ?? 40)

function prepareOptions(cacheRoot: string): PrepareOptions {
  const mode = (process.env.GIT_AUTH_MODE ?? 'local') === 'token' ? 'token' : 'local'
  return {
    cacheRoot,
    authMode: mode,
    gitlabBaseUrl: process.env.GITLAB_BASE_URL,
    deployUser: process.env.GITLAB_DEPLOY_USER ?? null,
    deployToken: process.env.GITLAB_DEPLOY_TOKEN ?? null,
    timeoutMs: 300000,
  }
}

/** 收窄预算：真实仓库检索面更大，请求数发散得更快。 */
function trialPolicy(): V4CapabilityPolicy {
  const copy = JSON.parse(JSON.stringify(V4_DEFAULT_POLICY)) as V4CapabilityPolicy
  return {
    ...copy,
    modelBudget: {
      ...copy.modelBudget,
      maxTotalRequests: MAX_REQUESTS,
      maxRootRequests: Math.ceil(MAX_REQUESTS * 0.7),
      maxChildRequests: Math.ceil(MAX_REQUESTS * 0.35),
    },
  }
}

/**
 * 连通性预检。
 *
 * 这个环境到 GitLab 的连通性**反复中断**：同一条命令可能一次 52 秒跑通、下一次 68 毫秒报
 * `git fetch failed: ls-remote`（实测 `curl` 同时返回 http_code=000）。网络断了却报成红色失败，
 * 会让人误以为是产品缺陷 —— 本轮已经误判过一次。所以先探一次，不通就明确跳过并说明原因。
 */
async function gitlabReachable(): Promise<boolean> {
  const base = process.env.GITLAB_BASE_URL
  if (base === undefined || base === '') return false
  try {
    const res = await fetch(base, {
      method: 'HEAD',
      redirect: 'manual',
      signal: AbortSignal.timeout(8000),
    })
    // 302/200 都算通；关键是 TLS 握手与 HTTP 响应真的发生了。
    return res.status > 0
  } catch {
    return false
  }
}

describe.skipIf(!ENABLED)('V4 real-repo E2E (real GitLab commit, real model)', () => {
  it(
    'freezes a real commit, reads real code and binds evidence to real blobs',
    async (context) => {
      if (!(await gitlabReachable())) {
        // eslint-disable-next-line no-console
        console.log(
          `[跳过] ${process.env.GITLAB_BASE_URL} 当前不可达 —— 这是环境问题，不是产品缺陷。` +
            ' 用 curl -sS -o /dev/null -w "%{http_code}\n" "$GITLAB_BASE_URL" 复核后重试。',
        )
        context.skip()
        return
      }
      const cacheRoot = mkdtempSync(join(tmpdir(), 'real-repo-cache-'))
      const attemptsRoot = mkdtempSync(join(tmpdir(), 'real-repo-att-'))
      const sessionRoot = mkdtempSync(join(tmpdir(), 'real-repo-sess-'))
      const cleanup = [cacheRoot, attemptsRoot, sessionRoot]
      const opts = prepareOptions(cacheRoot)

      try {
        // ---- 1. 冻结一个真实 commit -----------------------------------------
        //
        // 没指定 commit 时走 `prepareRepository()`（准备阶段用的那条：解析分支头再取回）；
        // 指定了就走 `prepareRepositoryAtSnapshot()`（Worker 用的那条：按已冻结 SHA 取回）。
        // 两条都是生产代码路径，各覆盖一次。
        const pinned = process.env.E2E_COMMIT
        const prepared =
          pinned === undefined
            ? await prepareRepository(REPO, BRANCH, opts)
            : await prepareRepositoryAtSnapshot(REPO, BRANCH, pinned, opts)
        const commitSha = prepared.commitSha
        expect(commitSha, '必须冻结出一个真实 commit SHA').toMatch(/^[0-9a-f]{40}$/)
        // 指定了 SHA 时，取回的必须正好是它：平台绝不允许回退到分支头。
        if (pinned !== undefined) expect(prepared.commitSha).toBe(pinned)
        expect(prepared.path.startsWith(cacheRoot)).toBe(true)

        // eslint-disable-next-line no-console
        console.log(
          [
            '',
            '========= 真实仓库冻结 =========',
            `仓库:      ${prepared.repository}`,
            `分支:      ${prepared.branch}`,
            `commit:    ${prepared.commitSha.slice(0, 12)}`,
            `提交主题:  ${prepared.commitSubject.slice(0, 60)}`,
            `缓存复用:  ${String(prepared.cached)}`,
            `缓存目录:  <cacheRoot>/${prepared.repository}/${prepared.commitSha.slice(0, 8)}…`,
            '================================',
            '',
          ].join('\n'),
        )

        // ---- 2. 用真实模型跑一次受治理的评审 --------------------------------
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
          taskId: 'real-repo-e2e',
          agentAttempt: 1,
          branch: BRANCH,
          story: {
            code: 'PRJ-REAL-1',
            name: '真实仓库检索能力核验',
            description: [
              `请在 ${REPO} 中确认代码库的实际结构与主要入口。`,
              '这是一次能力核验，不追求评审结论的业务准确性：',
              '只要求你真的检索并读取了这个仓库里的代码，并引用真实的 evidenceId 提交结论。',
            ].join('\n'),
            acceptanceCriteria: [
              '1. 仓库中存在可识别的源码文件；',
              '2. 能读取到至少一个源码文件的具体内容。',
            ].join('\n'),
          },
          snapshots: new SnapshotStore([
            { name: REPO, commitSha: prepared.commitSha, gitDir: prepared.path },
          ]),
          route: {
            providerId: 'review-route',
            displayName: 'Real Repo Route',
            baseUrl: process.env.E2E_MODEL_BASE_URL!,
            modelName: process.env.E2E_MODEL_NAME!,
            contextWindow: Number(process.env.E2E_MODEL_CONTEXT_WINDOW ?? 131072),
            maxTokens: Number(process.env.E2E_MODEL_MAX_TOKENS ?? 8192),
            apiKeyEnvVar: 'REVIEW_MODEL_API_KEY',
            requestTimeoutMs: 180000,
          },
          policy: trialPolicy(),
          coveragePolicy: { requiredRepositories: [REPO], minQueriesPerRepository: 1 },
          apiKey: process.env.REVIEW_MODEL_API_KEY!,
          attemptsRoot,
          sessionRoot,
          workerId: 'w-real-repo-e2e',
          infrastructure: {},
          forbiddenRoots: [cacheRoot],
          logger,
          isLeaseValid: () => true,
          checkoutPinned: checkoutPinnedCommit,
          commitReview: async (input) => {
            commits.push(input)
            return { runId: 'run-real-repo', committedAt: new Date().toISOString() }
          },
        })

        const result = await engine.runReview({
          signal: new AbortController().signal,
          logger,
        })

        const finished = events.find((e) => e.event === 'agent_attempt_finished')
        const failed = events.find((e) => e.event === 'agent_attempt_failed')
        const drained = events.find((e) => e.event === 'attempt_drained')
        // eslint-disable-next-line no-console
        console.log(
          [
            '',
            '========= 真实仓库 E2E =========',
            `模型:            ${process.env.E2E_MODEL_NAME}`,
            `结果:            ${result.ok ? 'committed' : `失败 ${result.errorCode}`}`,
            `模型请求:        ${String(finished?.model_requests ?? failed?.model_requests ?? 0)}` +
              ` / 上限 ${MAX_REQUESTS}`,
            `真实 token:      输入 ${String(result.usage?.inputTokens ?? 'null')}` +
              ` / 输出 ${String(result.usage?.outputTokens ?? 'null')}`,
            `模型调用的工具:  ${JSON.stringify(finished?.tool_names ?? failed?.tool_names ?? [])}`,
            `Evidence:        ${String(finished?.evidence_shown ?? failed?.broker_evidence_shown ?? 0)}`,
            `Workspace 字节:  ${String(finished?.workspace_bytes ?? 0)}`,
            `收敛:            reason=${String(drained?.reason)} 存活进程=${String(drained?.surviving_pids)}`,
            '================================',
            '',
          ].join('\n'),
        )
        if (!result.ok) {
          // eslint-disable-next-line no-console
          console.log('失败详情:', result.errorCode, result.errorMessage)
        }

        // ---- 3. 硬断言：与模型行为无关的安全不变量 --------------------------
        expect(commits.length).toBeLessThanOrEqual(1)
        if (commits.length === 1) {
          const committed = commits[0]!
          expect(committed.identity.rootAgentId).toMatch(/^root-/)
          // **本测试的核心**：入库 Evidence 必须绑定真实 commit 与真实 blob，
          // 由平台从固定快照重新读出，而不是模型断言的。
          expect(committed.evidence.length).toBeGreaterThan(0)
          for (const item of committed.evidence) {
            expect(item.commitSha).toBe(prepared.commitSha)
            expect(item.blobSha).toMatch(/^[0-9a-f]{40}$/)
          }
        }
        expect(drained?.cleanup_failed).toBe(false)
        expect(drained?.surviving_pids).toBe(0)
        expect(readdirSync(attemptsRoot)).toEqual([])
        const requests = Number(finished?.model_requests ?? failed?.model_requests ?? 0)
        expect(requests).toBeGreaterThan(0)
        expect(requests).toBeLessThanOrEqual(MAX_REQUESTS)
      } finally {
        // 快照缓存被 `chmodReadOnlyRecursive()` 设成 0500/0400，直接 rm 会 ENOTEMPTY。
        // 先恢复可写再删 —— 这与 `AttemptWorkspace.dispose()` 的做法一致。生产上代码缓存
        // 是按 SHA 长期复用的，不需要删，所以这只是测试清理的需要。
        for (const dir of cleanup) {
          try {
            execFileSync('chmod', ['-R', 'u+rwX', dir], { stdio: 'ignore' })
          } catch {
            // chmod 失败也要继续尝试删除，别把清理失败变成测试失败。
          }
          rmSync(dir, { recursive: true, force: true })
        }
      }
    },
    1_800_000,
  )
})
