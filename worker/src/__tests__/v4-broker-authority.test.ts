/**
 * WP1 / WP8 集成验收：Broker 的身份边界与 root-only 提交，走真实 Unix socket。
 *
 * 单测已经证明了 ledger 的判定规则；这一套证明的是"从 Harness 子进程的角度看，这些规则
 * 真的生效了"—— 请求经过真实 HTTP over UDS、真实 attempt token、真实 capability token。
 *
 * 最关键的两条：
 *   * 子 Agent 直接请求 `/attempt/submit-review` 得到 SUBMIT_ROOT_ONLY，即使它在请求体里
 *     把 agentId 写成 root 的（伪造 id 无效，因为身份只按令牌查）；
 *   * root 汇总 child 产生的 Evidence 是合法的，且 producer 归属正确落到 child 身上。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  startAttemptControlBroker,
  type AttemptControlHandle,
  type CommitReviewInput,
  type PermissionDecisionEntry,
  type ToolAuditEntry,
} from '../ai/control/attempt-control-broker.js'
import {
  AgentAuthorityLedger,
  mintRootIdentity,
} from '../ai/control/agent-authority-ledger.js'
import { HierarchicalBudgetLedger } from '../ai/control/hierarchical-budget-ledger.js'
import {
  normalizeCapabilityPolicy,
  policyHash as hashPolicy,
} from '../ai/policy/v4-capability-policy.js'
import { V4_ERROR_CODES } from '../ai/policy/v4-errors.js'
import { rootLogger } from '../logger.js'
import { hashContent } from '../ai/snapshot/git-object-reader.js'
import type { SnapshotStore } from '../ai/snapshot/snapshot-store.js'

const logger = rootLogger.child({ test: 'v4-broker-authority' })
const TASK_ID = 'task-broker-1'
const ATTEMPT = 1

/**
 * 最小 SnapshotStore 替身。
 *
 * 这套测试的对象是身份与授权，不是快照读取，所以只需要 `readRange` 返回一个可引用的范围。
 * 用真实 SnapshotStore 会把 git 对象读取的失败混进结果，掩盖被测的边界。
 */
const RANGE_CONTENT = 'class Order {}'
// 内容 hash 必须真的等于内容的 hash：deterministic verifier 会重算一次，
// 用一个假值会让所有提交都以 EVIDENCE_HASH_UNSTABLE 被拒。
const RANGE_HASH = hashContent(RANGE_CONTENT)

function fakeSnapshots(): SnapshotStore {
  return {
    pins: () => [
      { repository: 'kdmanage-backend', commitSha: 'a'.repeat(40), gitDir: '/nonexistent' },
    ],
    verifyPins: async () => undefined,
    search: async () => ({ hits: [], truncated: false, total: 0 }),
    findFiles: async () => ({ repository: 'kdmanage-backend', paths: [], truncated: false, total: 0 }),
    commits: async () => [],
    readRange: async (input: { path?: string; startLine?: number; endLine?: number }) => ({
      repository: 'kdmanage-backend',
      commitSha: 'a'.repeat(40),
      filePath: String(input.path ?? 'src/Order.java'),
      blobSha: 'b'.repeat(40),
      startLine: input.startLine ?? 1,
      endLine: input.endLine ?? 10,
      totalLines: 100,
      truncated: false,
      content: RANGE_CONTENT,
      contentHash: RANGE_HASH,
    }),
    reread: async () => ({
      repository: 'kdmanage-backend',
      commitSha: 'a'.repeat(40),
      filePath: 'src/Order.java',
      blobSha: 'b'.repeat(40),
      startLine: 1,
      endLine: 10,
      content: RANGE_CONTENT,
      contentHash: RANGE_HASH,
    }),
  } as unknown as SnapshotStore
}

interface Harness {
  broker: AttemptControlHandle
  authority: AgentAuthorityLedger
  budget: HierarchicalBudgetLedger
  commits: CommitReviewInput[]
  audit: ToolAuditEntry[]
  decisions: PermissionDecisionEntry[]
  post(
    route: string,
    body: Record<string, unknown>,
  ): Promise<{ status: number; body: Record<string, unknown> }>
}

let socketRoot = ''
let active: Harness | null = null

async function boot(
  options: {
    leaseValid?: () => boolean
    policyOverrides?: Record<string, unknown>
    sessionRevision?: number
    /** 注入落库失败，用来验证审计不会被静默丢弃。 */
    failFlush?: () => boolean
  } = {},
): Promise<Harness> {
  const policy = normalizeCapabilityPolicy({
    agents: { maxAgentsPerAttempt: 8, maxDelegationDepth: 2, maxConcurrentChildren: 4 },
    modelBudget: { maxTotalRequests: 20, maxRootRequests: 10, maxChildRequests: 4 },
    web: { allowedDomains: ['docs.example.com'] },
    ...options.policyOverrides,
  })
  const identity = mintRootIdentity(TASK_ID, ATTEMPT)
  const authority = new AgentAuthorityLedger({
    taskId: TASK_ID,
    agentAttempt: ATTEMPT,
    policy,
    rootAgentId: identity.rootAgentId,
    rootSessionId: identity.rootSessionId,
  })
  const budget = new HierarchicalBudgetLedger({ policy })
  const commits: CommitReviewInput[] = []
  const audit: ToolAuditEntry[] = []
  const decisions: PermissionDecisionEntry[] = []

  const broker = await startAttemptControlBroker({
    taskId: TASK_ID,
    agentAttempt: ATTEMPT,
    sessionRevision: options.sessionRevision ?? 1,
    snapshots: fakeSnapshots(),
    coveragePolicy: { requiredRepositories: ['kdmanage-backend'], minQueriesPerRepository: 0 },
    socketRoot,
    logger,
    policy,
    policyHash: hashPolicy(policy),
    authority,
    budget,
    commitReview: async (input) => {
      commits.push(input)
      return { runId: 'run-1', committedAt: new Date().toISOString() }
    },
    isLeaseValid: options.leaseValid ?? (() => true),
    flushAudit: async (entries, verdicts) => {
      if (options.failFlush?.()) throw new Error('database unreachable')
      audit.push(...entries)
      decisions.push(...verdicts)
    },
  })

  const post: Harness['post'] = (route, body) =>
    new Promise((resolve, reject) => {
      const payload = Buffer.from(JSON.stringify(body), 'utf8')
      const req = request(
        {
          socketPath: broker.socketPath,
          path: route,
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': String(payload.byteLength),
            authorization: `Bearer ${broker.token}`,
          },
        },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (chunk: Buffer) => chunks.push(chunk))
          res.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8')
            resolve({
              status: res.statusCode ?? 0,
              body: raw.length > 0 ? (JSON.parse(raw) as Record<string, unknown>) : {},
            })
          })
        },
      )
      req.on('error', reject)
      req.end(payload)
    })

  const harness: Harness = { broker, authority, budget, commits, audit, decisions, post }
  active = harness
  return harness
}

/** 给一个 Agent 组装带身份的请求体。 */
function envelope(
  input: { capability: string; agentId: string; sessionId: string; toolName?: string },
  payload: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...payload,
    taskId: TASK_ID,
    agentAttempt: ATTEMPT,
    agentCapability: input.capability,
    agentId: input.agentId,
    sessionId: input.sessionId,
    toolName: input.toolName ?? null,
  }
}

function rootEnvelope(h: Harness, payload: Record<string, unknown> = {}, toolName?: string) {
  return envelope(
    {
      capability: h.authority.rootCapabilityToken,
      agentId: h.authority.root.agentId,
      sessionId: h.authority.root.sessionId,
      toolName,
    },
    payload,
  )
}

function validSubmission(evidenceId: string): Record<string, unknown> {
  return {
    verdict: 'IMPLEMENTED',
    confidence: 90,
    summary: 'the requirement is implemented',
    evidence: [
      {
        evidenceId,
        repository: 'kdmanage-backend',
        filePath: 'src/Order.java',
        startLine: 1,
        endLine: 10,
        evidenceType: '现有实现',
        description: 'the order service implements it',
      },
    ],
  }
}

beforeEach(() => {
  socketRoot = mkdtempSync(join(tmpdir(), 'crp-broker-auth-'))
})

afterEach(async () => {
  await active?.broker.close().catch(() => undefined)
  active = null
  rmSync(socketRoot, { recursive: true, force: true })
})

describe('broker attempt envelope', () => {
  it('refuses a request without the attempt token', async () => {
    const h = await boot()
    const denied = await new Promise<number>((resolve, reject) => {
      const payload = Buffer.from(JSON.stringify(rootEnvelope(h)), 'utf8')
      const req = request(
        {
          socketPath: h.broker.socketPath,
          path: '/attempt/snapshot-pins',
          method: 'POST',
          headers: { 'content-type': 'application/json', 'content-length': String(payload.byteLength) },
        },
        (res) => resolve(res.statusCode ?? 0),
      )
      req.on('error', reject)
      req.end(payload)
    })
    expect(denied).toBe(401)
  })

  it('refuses a request naming a different attempt', async () => {
    const h = await boot()
    const response = await h.post('/attempt/snapshot-pins', {
      ...rootEnvelope(h),
      agentAttempt: 99,
    })
    expect(response.status).toBe(403)
    expect(response.body.code).toBe('ATTEMPT_MISMATCH')
  })

  it('refuses an unknown route so a new route cannot bypass role policy', async () => {
    const h = await boot()
    const response = await h.post('/attempt/exfiltrate', rootEnvelope(h))
    expect(response.status).toBe(404)
    expect(response.body.code).toBe('BROKER_UNKNOWN_ROUTE')
  })

  it('refuses every request once the lease is lost', async () => {
    let held = true
    const h = await boot({ leaseValid: () => held })
    expect((await h.post('/attempt/snapshot-pins', rootEnvelope(h))).status).toBe(200)
    held = false
    const response = await h.post('/attempt/snapshot-pins', rootEnvelope(h))
    expect(response.status).toBe(409)
    expect(response.body.code).toBe('TASK_LEASE_LOST')
  })

  it('refuses every request after revocation', async () => {
    const h = await boot()
    h.broker.revoke('the attempt was cancelled')
    const response = await h.post('/attempt/snapshot-pins', rootEnvelope(h))
    expect(response.status).toBe(409)
    expect(response.body.code).toBe('ATTEMPT_REVOKED')
  })
})

describe('broker agent identity', () => {
  it('refuses a request carrying no agent capability', async () => {
    const h = await boot()
    const response = await h.post('/attempt/snapshot-pins', {
      taskId: TASK_ID,
      agentAttempt: ATTEMPT,
    })
    expect(response.status).toBe(403)
    expect(response.body.code).toBe(V4_ERROR_CODES.AGENT_IDENTITY_INVALID)
  })

  it('refuses a forged capability token', async () => {
    const h = await boot()
    const response = await h.post(
      '/attempt/snapshot-pins',
      envelope({ capability: 'x'.repeat(43), agentId: 'whoever', sessionId: 'whatever' }),
    )
    expect(response.status).toBe(403)
    expect(response.body.code).toBe(V4_ERROR_CODES.AGENT_IDENTITY_INVALID)
  })

  it('registers a child and hands it a distinct capability', async () => {
    const h = await boot()
    const response = await h.post(
      '/attempt/register-agent',
      rootEnvelope(h, {
        provider: 'spawn',
        childAgentId: 'child-1',
        childSessionId: 'child-1',
        delegationDepth: 1,
      }),
    )
    expect(response.status).toBe(200)
    expect(response.body.accepted).toBe(true)
    expect(response.body.role).toBe('research-child')
    expect(response.body.agentCapability).not.toBe(h.authority.rootCapabilityToken)
    expect(response.body.tools).not.toContain('submit_review_result')
  })

  it('refuses an attempt to register a second root identity', async () => {
    const h = await boot()
    // 根身份由平台生成；让模型注册一个 root 等于让它自选权限。
    const response = await h.post(
      '/attempt/register-agent',
      rootEnvelope(h, { provider: 'root', childAgentId: 'fake-root', childSessionId: 'fake-root' }),
    )
    expect(response.status).toBe(403)
    expect(response.body.code).toBe(V4_ERROR_CODES.AGENT_IDENTITY_INVALID)
  })

  it('refuses a child that presents another agent id with its own capability', async () => {
    const h = await boot()
    const registered = await h.post(
      '/attempt/register-agent',
      rootEnvelope(h, {
        provider: 'spawn',
        childAgentId: 'child-1',
        childSessionId: 'child-1',
        delegationDepth: 1,
      }),
    )
    const childCapability = String(registered.body.agentCapability)
    const response = await h.post(
      '/attempt/read-code',
      envelope({
        capability: childCapability,
        // 伪造 root 的 agentId：令牌不匹配，直接拒绝。
        agentId: h.authority.root.agentId,
        sessionId: h.authority.root.sessionId,
      }),
    )
    expect(response.status).toBe(403)
    expect(response.body.code).toBe(V4_ERROR_CODES.AGENT_IDENTITY_INVALID)
  })
})

describe('root-only submit at the broker layer', () => {
  async function withChild(h: Harness): Promise<{ capability: string; agentId: string }> {
    const registered = await h.post(
      '/attempt/register-agent',
      rootEnvelope(h, {
        provider: 'spawn',
        childAgentId: 'child-1',
        childSessionId: 'child-1',
        delegationDepth: 1,
      }),
    )
    return { capability: String(registered.body.agentCapability), agentId: 'child-1' }
  }

  it('refuses a child calling submit-review directly', async () => {
    const h = await boot()
    const child = await withChild(h)
    const response = await h.post(
      '/attempt/submit-review',
      envelope(
        {
          capability: child.capability,
          agentId: child.agentId,
          sessionId: 'child-1',
          toolName: 'submit_review_result',
        },
        { submission: validSubmission('ev-anything') },
      ),
    )
    expect(response.status).toBe(403)
    expect(response.body.code).toBe(V4_ERROR_CODES.SUBMIT_ROOT_ONLY)
    // 没有任何结果被提交。
    expect(h.commits).toHaveLength(0)
  })

  it('records the denial as a permission decision for audit', async () => {
    const h = await boot()
    const child = await withChild(h)
    await h.post(
      '/attempt/submit-review',
      envelope(
        {
          capability: child.capability,
          agentId: child.agentId,
          sessionId: 'child-1',
          toolName: 'submit_review_result',
        },
        { submission: validSubmission('ev-anything') },
      ),
    )
    await h.broker.flushAudit()
    expect(
      h.decisions.some((decision) => decision.reasonCode === V4_ERROR_CODES.SUBMIT_ROOT_ONLY),
    ).toBe(true)
    expect(
      h.audit.some(
        (entry) =>
          entry.toolName === 'submit_review_result' && entry.permissionVerdict === 'DENY',
      ),
    ).toBe(true)
  })

  it('lets the root submit and attributes child evidence to its producer', async () => {
    const h = await boot()
    const child = await withChild(h)

    // 子 Agent 读一段代码：evidenceId 归它名下。
    const read = await h.post(
      '/attempt/read-code',
      envelope(
        {
          capability: child.capability,
          agentId: child.agentId,
          sessionId: 'child-1',
          toolName: 'read_snapshot_code',
        },
        { repository: 'kdmanage-backend', path: 'src/Order.java', startLine: 1, endLine: 10 },
      ),
    )
    expect(read.status).toBe(200)
    const evidenceId = String(read.body.evidenceId)
    // 模型永远看不到 blob id 和 hash。
    expect(read.body.blobSha).toBeUndefined()
    expect(read.body.contentHash).toBeUndefined()

    // root 汇总并提交。
    const submitted = await h.post(
      '/attempt/submit-review',
      rootEnvelope(h, { submission: validSubmission(evidenceId) }, 'submit_review_result'),
    )
    expect(submitted.status).toBe(200)
    expect(submitted.body.accepted).toBe(true)
    expect(h.commits).toHaveLength(1)

    const committed = h.commits[0]!
    expect(committed.identity.rootAgentId).toBe(h.authority.root.agentId)
    expect(committed.identity.treeDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(committed.evidence).toHaveLength(1)
    // 生产者是实际被展示这段代码的子 Agent，不是提交者。
    expect(committed.evidence[0]!.producer.agentId).toBe('child-1')
    expect(committed.evidence[0]!.producer.sessionId).toBe('child-1')
    // 真实用量随提交一起上报。
    expect(committed.usage.perAgent.map((row) => row.agentId).sort()).toEqual(
      [h.authority.root.agentId, 'child-1'].sort(),
    )
  })

  it('forwards the database-issued fencing revision on a retried attempt', async () => {
    const h = await boot({ sessionRevision: 5 })
    const read = await h.post(
      '/attempt/read-code',
      rootEnvelope(
        h,
        { repository: 'kdmanage-backend', path: 'src/Order.java', startLine: 1, endLine: 10 },
        'read_snapshot_code',
      ),
    )

    const submitted = await h.post(
      '/attempt/submit-review',
      rootEnvelope(
        h,
        { submission: validSubmission(String(read.body.evidenceId)) },
        'submit_review_result',
      ),
    )

    expect(submitted.status).toBe(200)
    expect(submitted.body.accepted).toBe(true)
    expect(h.commits[0]?.identity.sessionRevision).toBe(5)
  })

  it('is idempotent for a retried submission', async () => {
    const h = await boot()
    const read = await h.post(
      '/attempt/read-code',
      rootEnvelope(
        h,
        { repository: 'kdmanage-backend', path: 'src/Order.java', startLine: 1, endLine: 10 },
        'read_snapshot_code',
      ),
    )
    const submission = validSubmission(String(read.body.evidenceId))
    const first = await h.post(
      '/attempt/submit-review',
      rootEnvelope(h, { submission }, 'submit_review_result'),
    )
    const second = await h.post(
      '/attempt/submit-review',
      rootEnvelope(h, { submission }, 'submit_review_result'),
    )
    expect(first.body.runId).toBe(second.body.runId)
    // 重试绝不产生第二份结果。
    expect(h.commits).toHaveLength(1)
  })

  it('refuses evidence that has no recorded producer in this tree', async () => {
    const h = await boot()
    const response = await h.post(
      '/attempt/submit-review',
      rootEnvelope(h, { submission: validSubmission('ev_forged') }, 'submit_review_result'),
    )
    // 结构校验先挡下：evidenceId 从未被本次 attempt 发出。
    expect(response.status).toBe(200)
    expect(response.body.accepted).toBe(false)
    expect(String(response.body.code)).toMatch(/EVIDENCE_ID_UNKNOWN/)
    expect(h.commits).toHaveLength(0)
  })
})

describe('broker budget and web routes', () => {
  it('reserves model requests through the authenticated route', async () => {
    const h = await boot()
    const first = await h.post('/attempt/reserve-model-request', rootEnvelope(h, { kind: 'loop' }))
    expect(first.body.allowed).toBe(true)
    expect(h.budget.snapshot().root).toBe(1)
  })

  it('denies a child once its own budget is exhausted', async () => {
    const h = await boot()
    const registered = await h.post(
      '/attempt/register-agent',
      rootEnvelope(h, {
        provider: 'spawn',
        childAgentId: 'child-1',
        childSessionId: 'child-1',
        delegationDepth: 1,
      }),
    )
    const capability = String(registered.body.agentCapability)
    const childEnvelope = envelope(
      { capability, agentId: 'child-1', sessionId: 'child-1' },
      { kind: 'loop' },
    )
    // maxChildRequests = 4。
    for (let i = 0; i < 4; i++) {
      const verdict = await h.post('/attempt/reserve-model-request', childEnvelope)
      expect(verdict.body.allowed).toBe(true)
    }
    const denied = await h.post('/attempt/reserve-model-request', childEnvelope)
    expect(denied.body.allowed).toBe(false)
    expect(denied.body.scope).toBe('child')
    expect(denied.body.code).toBe(V4_ERROR_CODES.MODEL_BUDGET_EXHAUSTED)
  })

  it('records provider token usage only when it is reported', async () => {
    const h = await boot()
    await h.post('/attempt/report-usage', rootEnvelope(h, { inputTokens: 120, outputTokens: 30 }))
    expect(h.broker.usage().inputTokens).toBe(120)
    expect(h.broker.usage().outputTokens).toBe(30)
  })

  it('refuses web egress when no gateway is configured for the attempt', async () => {
    const h = await boot()
    const response = await h.post(
      '/attempt/web-egress',
      rootEnvelope(h, { url: 'https://docs.example.com/x', kind: 'fetch' }, 'web_fetch'),
    )
    // 未装配 Web 出口时一律拒绝，而不是退回到 Harness 自带的直连实现。
    expect(response.status).toBe(403)
    expect(response.body.code).toBe(V4_ERROR_CODES.WEB_EGRESS_DENIED)
  })

  it('refuses an artifact when no writable workspace is configured', async () => {
    const h = await boot()
    const response = await h.post(
      '/attempt/save-artifact',
      rootEnvelope(h, { workspacePath: 'artifacts/x.patch', artifactType: 'PATCH' }),
    )
    expect(response.status).toBe(403)
    expect(response.body.code).toBe(V4_ERROR_CODES.WORKSPACE_POLICY_DENIED)
  })

  it('lets an agent finish itself and then refuses its token', async () => {
    const h = await boot()
    const registered = await h.post(
      '/attempt/register-agent',
      rootEnvelope(h, {
        provider: 'spawn',
        childAgentId: 'child-1',
        childSessionId: 'child-1',
        delegationDepth: 1,
      }),
    )
    const capability = String(registered.body.agentCapability)
    const finished = await h.post(
      '/attempt/finish-agent',
      envelope({ capability, agentId: 'child-1', sessionId: 'child-1' }, { status: 'FINISHED' }),
    )
    expect(finished.body.accepted).toBe(true)
    // 收尾之后令牌立即失效：迟到的工具调用无法再写入。
    const late = await h.post(
      '/attempt/read-code',
      envelope(
        { capability, agentId: 'child-1', sessionId: 'child-1', toolName: 'read_snapshot_code' },
        { repository: 'kdmanage-backend', path: 'src/Order.java', startLine: 1, endLine: 10 },
      ),
    )
    expect(late.status).toBe(403)
    expect(late.body.code).toBe(V4_ERROR_CODES.AGENT_IDENTITY_INVALID)
  })

  it('attributes an audit entry to the token holder, not to the reported agent id', async () => {
    const h = await boot()
    const registered = await h.post(
      '/attempt/register-agent',
      rootEnvelope(h, {
        provider: 'spawn',
        childAgentId: 'child-1',
        childSessionId: 'child-1',
        delegationDepth: 1,
      }),
    )
    const capability = String(registered.body.agentCapability)
    await h.post(
      '/attempt/tool-audit',
      envelope(
        { capability, agentId: 'child-1', sessionId: 'child-1' },
        {
          entries: [
            // 上报里自称是 root：归属仍然按令牌算。
            { agentId: h.authority.root.agentId, toolName: 'grep', permissionVerdict: 'ALLOW' },
          ],
        },
      ),
    )
    await h.broker.flushAudit()
    const grepEntry = h.audit.find((entry) => entry.toolName === 'grep')
    expect(grepEntry?.agentId).toBe('child-1')
  })
})

describe('审计与拒绝上报（本轮实测缺陷的回归）', () => {
  it('被拒的 Agent 可以上报自己被拒 —— 上报不需要它没有的那个工具权限', async () => {
    // 曾经的缺陷：授权层对所有非注册路由都拿 envelope.toolName 去校验，于是
    // "上报我调用 submit_review_result 被拒了"被当成"我要调用 submit_review_result"，
    // 必然 SUBMIT_ROOT_ONLY → 403。结果是一个 catch-22：被拒的 Agent 恰恰没有权限上报
    // 自己被拒，治理审计凭空消失（实测 workflow 子 Agent 被拒 30+ 次，库里一条没有）。
    const h = await boot()
    const child = await h.authority.registerChild({
      parentToken: h.authority.rootCapabilityToken,
      agentId: 'child-audit',
      sessionId: 'session-child-audit',
      provider: 'workflow',
    })
    // 前提：workflow 子 Agent 的授权工具集里没有提交工具 —— 所以它调用必然被拒，
    // 而"上报这次被拒"绝不能因此也被拒。
    expect(child.identity.tools).not.toContain('submit_review_result')

    const response = await h.post('/attempt/tool-audit', {
      taskId: TASK_ID,
      agentAttempt: ATTEMPT,
      agentCapability: child.token,
      agentId: 'child-audit',
      sessionId: 'session-child-audit',
      // 这个 toolName 是**被审计对象**，不是"我正在调用的工具"。
      toolName: 'submit_review_result',
      decision: 'DENY',
      reasonCode: V4_ERROR_CODES.SUBMIT_ROOT_ONLY,
      entries: [
        {
          toolName: 'submit_review_result',
          permissionVerdict: 'DENY',
          errorCode: V4_ERROR_CODES.SUBMIT_ROOT_ONLY,
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          durationMs: 0,
        },
      ],
    })
    expect(response.status).toBe(200)

    // 越权提交尝试必须像"被拒的提交"一样可见，而不是只躺在 permission_decision 里。
    const usage = h.broker.usage()
    expect(usage.rejectedSubmissions).toContain(V4_ERROR_CODES.SUBMIT_ROOT_ONLY)
    expect(usage.rejectedSubmissionTotal).toBeGreaterThan(0)

    await h.broker.flushAudit()
    expect(
      h.decisions.some(
        (d: PermissionDecisionEntry) =>
          d.toolName === 'submit_review_result' && d.decision === 'DENY',
      ),
    ).toBe(true)
  })

  it('落库失败时审计记录被重排队，而不是被丢掉', async () => {
    // 曾经的缺陷：flushAudit 先 splice 取走再落库，失败只记一条日志就把那批扔了 ——
    // 数据库抖一下，这段时间的工具审计与 permission decision 永久消失。
    let failing = true
    const h = await boot({ failFlush: () => failing })
    await h.post('/attempt/tool-audit', {
      taskId: TASK_ID,
      agentAttempt: ATTEMPT,
      agentCapability: h.authority.rootCapabilityToken,
      agentId: h.authority.root.agentId,
      sessionId: h.authority.root.sessionId,
      toolName: 'grep',
      entries: [
        {
          toolName: 'grep',
          permissionVerdict: 'ALLOW',
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          durationMs: 1,
        },
      ],
    })

    // 第一次 flush 失败：记录不能消失。
    await h.broker.flushAudit()
    expect(h.audit).toHaveLength(0)
    expect(h.broker.pendingAudit().entries.length).toBeGreaterThan(0)

    // 数据库恢复后同一批记录必须落进去。
    failing = false
    await h.broker.flushAudit()
    expect(h.audit.some((entry: ToolAuditEntry) => entry.toolName === 'grep')).toBe(true)
    expect(h.broker.pendingAudit().entries).toHaveLength(0)
  })
})
