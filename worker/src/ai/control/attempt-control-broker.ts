/**
 * 一次评审 attempt 的 Worker 侧控制平面。
 *
 * 所有特权都留在 socket 的这一侧：快照根目录、数据库凭据、证据台账、预算账本、Web 出口
 * 和提交决定。Harness 子进程只持有一个 socket 路径、一个 attempt token，以及每个 Agent
 * 各自的 capability token。
 *
 * V4 相对 V3 的关键变化：Broker 不再只知道"某个 attempt 在调用我"，而是知道"哪个 Agent
 * 在调用我"。
 *
 *   * attempt token（HTTP header）证明请求来自本次 attempt 的子进程；
 *   * agent capability（请求体）证明请求来自这棵 Agent Tree 里某个已注册的节点；
 *   * 路由 → 能力映射来自冻结的契约，未知路由一律拒绝；
 *   * 请求体里自报的 agentId 只用于比对，从不用于查找身份。
 *
 * 于是"子 Agent 伪造 root id 直接请求 Broker"这件事在结构上就不成立：它拿不到 root 的
 * capability token，而 Broker 只按令牌查身份。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { chmodSync, mkdirSync, rmSync } from 'node:fs'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { join } from 'node:path'
import type { Logger } from '../../logger.js'
import { redactError } from '../../security/redaction.js'
import type { RepositoryName } from '../../git/repositories.js'
import { SnapshotError } from '../snapshot/git-object-reader.js'
import type { SnapshotStore } from '../snapshot/snapshot-store.js'
import { EvidenceLedger } from '../snapshot/evidence-ledger.js'
import { SearchCoverageLedger } from '../snapshot/search-coverage-ledger.js'
import {
  verifyReviewSubmission,
  type ReviewSubmission,
  type VerifiedEvidence,
} from '../snapshot/deterministic-verifier.js'
import type { CoveragePolicy } from '../snapshot/search-coverage-ledger.js'
import {
  brokerRouteCapability,
  loadCapabilityContract,
  type AgentProvider,
  type V4CapabilityPolicy,
} from '../policy/v4-capability-policy.js'
import { V4_ERROR_CODES, V4GovernanceError } from '../policy/v4-errors.js'
import type { AgentAuthorityLedger, AgentIdentity } from './agent-authority-ledger.js'
import type { HierarchicalBudgetLedger, ModelRequestKind } from './hierarchical-budget-ledger.js'
import type { EgressPolicy, EgressFetchResult } from '../web/egress-policy.js'
import type { AttemptWorkspace } from '../workspace/attempt-workspace.js'
import type {
  RuntimeAgentProvider,
  RuntimeAgentRole,
  RuntimeEvent,
} from '../../monitoring/runtime-event-types.js'

/** 一条已验证证据，附带它的生产者。 */
export interface AttributedEvidence extends VerifiedEvidence {
  /**
   * 实际被展示这段代码的 Agent。
   *
   * 不是提交者：root 汇总 child 的调查结果时引用 child 的 evidenceId 是合法的，而
   * "这条证据由谁产生"必须能追溯到 Agent Tree 里的具体节点。
   */
  producer: { agentId: string; sessionId: string; toolCallId: string | null }
}

export interface CommitReviewInput {
  submission: ReviewSubmission
  evidence: AttributedEvidence[]
  usage: BrokerUsageSnapshot
  /**
   * Hash of the resolved Harness configuration for this attempt. Recorded with
   * the run so a result can be traced back to the exact profile that produced
   * it. Absent until the profile has been materialized.
   */
  configHash: string | null
  /** V4 身份：root Agent、root Session、tree digest、session revision、policy hash。 */
  identity: AttemptCommitIdentity
}

export interface AttemptCommitIdentity {
  rootAgentId: string
  rootSessionId: string
  treeDigest: string
  sessionRevision: number
  policyHash: string
}

export interface CommitReviewResult {
  runId: string
  committedAt: string
}

export interface BrokerUsageSnapshot {
  /**
   * 真实模型请求数，来自进程内 governor 在调用 provider 之前的原子预留。
   *
   * V3 曾经把 Broker 的 tool call 数当成 modelRequests 上报，这是错的：一次模型请求可能
   * 触发零次或多次工具调用，两者没有任何换算关系。UI 上看到的"模型请求数"因此完全失真。
   */
  modelRequests: number
  rootModelRequests: number
  childModelRequests: number
  retryRequests: number
  compactionRequests: number
  ralphRounds: number
  inputTokens: number | null
  outputTokens: number | null
  toolCalls: number
  evidenceShown: number
  searchesRun: number
  webRequests: number
  webBytes: number
  /**
   * 每个工具各被调用了多少次，以及提交被拒的错误码序列。
   *
   * 这两项是回答"一次 attempt 的预算花在哪"的关键：预算打满时，需要区分
   * "都花在检索阅读上"和"都花在反复提交被拒上"。后者是 prompt 要求模型
   * 修正后重试造成的，只看总次数看不出来。
   */
  toolCallsByName: Record<string, number>
  rejectedSubmissions: string[]
  /**
   * 因预算被拒的模型请求数。
   *
   * 账本里三处 `denied++` 全部返回 `MODEL_BUDGET_EXHAUSTED`，所以这个数 > 0 就等于
   * "至少有一次模型请求因为预算被挡住了"。引擎据此把"没提交"这个笼统失败还原成
   * `MODEL_BUDGET_EXHAUSTED` —— 否则运维看到的是"Agent 没提交"，而真实原因是撞了上限。
   */
  deniedModelRequests: number
  /**
   * 被拒提交的**真实总数**。`rejectedSubmissions` 有上界，这个没有 —— 运维需要知道
   * "冲撞了多少次"，而日志里不需要看到几百条重复字符串。
   */
  rejectedSubmissionTotal: number
  /** 分 Agent usage，供 UI 展示"预算花在哪个子 Agent 上"。 */
  perAgent: Array<{
    agentId: string
    role: string
    provider: string
    delegationDepth: number
    status: string
    modelRequests: number
    toolCalls: number
    evidenceProduced: number
  }>
}

/** 一条工具审计记录。只存安全元数据。 */
export interface ToolAuditEntry {
  agentId: string
  sessionId: string | null
  toolCallId: string | null
  toolName: string
  permissionVerdict: 'ALLOW' | 'DENY' | 'CANCELLED'
  errorCode: string | null
  startedAt: string
  finishedAt: string
  durationMs: number
  requestBytes: number
  responseBytes: number
}

export interface PermissionDecisionEntry {
  agentId: string
  agentRole: string
  toolName: string
  policyLayer: 'global' | 'role' | 'child-filter' | 'broker' | 'lease' | 'budget'
  decision: 'ALLOW' | 'DENY'
  reasonCode: string
}

export interface AttemptControlBrokerOptions {
  taskId: string
  agentAttempt: number
  snapshots: SnapshotStore
  coveragePolicy: CoveragePolicy
  /** Root directory that will hold the per-attempt socket. */
  socketRoot: string
  logger: Logger
  policy: V4CapabilityPolicy
  policyHash: string
  /** Agent 身份台账。Broker 的每一次授权都过它。 */
  authority: AgentAuthorityLedger
  /** 分层预算账本。 */
  budget: HierarchicalBudgetLedger
  /** Web 出口策略。缺省表示 Web 能力未装配，请求一律拒绝。 */
  egress?: EgressPolicy
  /** 隔离 Workspace。缺省表示 Artifact 能力未装配。 */
  workspace?: AttemptWorkspace
  /**
   * Persist a verified review atomically. Returning a receipt is what allows
   * the terminal tool to conclude the agent's turn; throwing keeps the attempt
   * running and surfaces a non-correctable failure.
   */
  commitReview(input: CommitReviewInput): Promise<CommitReviewResult>
  /** True while this worker still holds the task lease. */
  isLeaseValid(): boolean
  /** 注册子 Agent 时同步写库。 */
  registerAgentNode?(identity: AgentIdentity): Promise<void>
  /** 标记 Agent 终态。errorCode 承载取消原因，落到 analysis_agent_node。 */
  markAgentTerminal?(
    agentId: string,
    status: 'FINISHED' | 'FAILED' | 'CANCELLED',
    errorCode?: string,
  ): Promise<void>
  /** 批量落工具审计。 */
  flushAudit?(entries: ToolAuditEntry[], decisions: PermissionDecisionEntry[]): Promise<void>
  /**
   * 转投一条运行监控事实事件（V1.5，方案 §7.2）。
   *
   * 缺省表示 Reporter 未装配（`RUNTIME_EVENTS_ENABLED=false` 或旧接线），此时插件
   * 请求体里的 `lifecycle` / `correlationId` 字段被静默忽略，现有审计行为完全不变。
   * 观测通道 fail open：这个回调抛出的异常不得影响工具执行或模型调用。
   */
  reportRuntimeEvent?(event: RuntimeEvent): void
  /** 保存 Artifact 元数据。 */
  saveArtifact?(input: {
    producerAgentId: string
    artifactType: string
    workspacePath: string
    contentHash: string
    sizeBytes: number
  }): Promise<{ artifactId: string }>
}

export interface AttemptControlHandle {
  socketPath: string
  token: string
  usage(): BrokerUsageSnapshot
  committed(): CommitReviewResult | null
  /**
   * Record the resolved profile hash once the attempt's profile exists. The
   * broker must be listening before the profile is materialized (the profile
   * needs the socket path), so the hash arrives afterwards.
   */
  setConfigHash(hash: string): void
  /** 推进 session revision（checkpoint 与 resume 之后）。 */
  setSessionRevision(revision: number): void
  /** 已累积但还没落库的审计记录。 */
  pendingAudit(): { entries: ToolAuditEntry[]; decisions: PermissionDecisionEntry[] }
  /** 把累积的审计记录落库并清空。 */
  flushAudit(): Promise<void>
  /** Reject every further request; used on lease loss and teardown. */
  revoke(reason: string): void
  close(): Promise<void>
}

interface AttemptEnvelope {
  taskId?: unknown
  agentAttempt?: unknown
  agentCapability?: unknown
  agentId?: unknown
  sessionId?: unknown
  toolCallId?: unknown
  toolName?: unknown
}

/** 一次审计批量落库的阈值。避免每次工具调用一次数据库往返。 */
const AUDIT_FLUSH_THRESHOLD = 32

/**
 * 落库失败时审计队列的上界。
 *
 * 数据库整场不可用时，重排队不能无界增长把内存吃光；但上界必须远大于阈值，否则一次抖动就
 * 开始丢数据。超出上界的丢弃会显式记进 `tool_audit_flush_failed`。
 */
const AUDIT_QUEUE_CAP = 2048

export function startAttemptControlBroker(
  options: AttemptControlBrokerOptions,
): Promise<AttemptControlHandle> {
  const token = randomUUID()
  const contract = loadCapabilityContract()
  const evidenceLedger = new EvidenceLedger(options.taskId, options.agentAttempt)
  const coverageLedger = new SearchCoverageLedger()

  mkdirSync(options.socketRoot, { recursive: true, mode: 0o700 })
  chmodSync(options.socketRoot, 0o700)
  // Short random name: a Unix socket path has a hard length limit.
  const socketPath = join(options.socketRoot, `${randomUUID().slice(0, 8)}.sock`)

  let revokedReason: string | null = null
  let committed: CommitReviewResult | null = null
  let toolCalls = 0
  let configHash: string | null = null
  let sessionRevision = 1
  const toolCallsByName: Record<string, number> = {}
  /** lifecycle 上报可能因 IPC 重试重复；同一 correlation 只计一次模型工具调用。 */
  const countedToolCorrelations = new Set<string>()
  /** 只有这五条路由直接代表 modelTools 中的 platform 工具。其余都是内部控制/观测。 */
  const platformToolByRoute: Readonly<Record<string, string>> = {
    '/attempt/search-code': 'search_snapshot_code',
    '/attempt/find-files': 'find_snapshot_files',
    '/attempt/read-code': 'read_snapshot_code',
    '/attempt/list-commits': 'list_snapshot_commits',
    '/attempt/submit-review': 'submit_review_result',
  }
  /**
   * 被拒的提交码。**有上界**：一个反复冲撞提交权的子 Agent 能在一次 attempt 里累计上百次
   * （实测脚本化子 Agent 一轮就 64 次），而这个数组会进 `agent_attempt_finished` 日志。
   * 无界数组等于把日志交给模型行为控制。超出上界后只累加计数，不再追加元素。
   */
  const rejectedSubmissions: string[] = []
  const REJECTED_SUBMISSION_CAP = 20
  let rejectedSubmissionTotal = 0
  const recordRejectedSubmission = (code: string): void => {
    rejectedSubmissionTotal++
    if (rejectedSubmissions.length < REJECTED_SUBMISSION_CAP) rejectedSubmissions.push(code)
  }
  const auditEntries: ToolAuditEntry[] = []
  const auditDecisions: PermissionDecisionEntry[] = []
  /** 每个 Agent 产出的 Evidence 数，用于分 Agent usage。 */
  const evidenceByAgent = new Map<string, number>()
  const toolCallsByAgent = new Map<string, number>()
  /** evidenceId → 生产它的 Agent，提交时用于 producer 归属校验。 */
  const evidenceProducer = new Map<string, { agentId: string; sessionId: string; toolCallId: string | null }>()

  const usage = (): BrokerUsageSnapshot => {
    const counters = options.budget.snapshot()
    return {
      modelRequests: counters.total,
      rootModelRequests: counters.root,
      childModelRequests: counters.child,
      retryRequests: counters.retry,
      compactionRequests: counters.compaction,
      ralphRounds: counters.ralph,
      deniedModelRequests: counters.denied,
      inputTokens: counters.inputTokens,
      outputTokens: counters.outputTokens,
      toolCalls,
      evidenceShown: evidenceLedger.size(),
      searchesRun: coverageLedger.size(),
      webRequests: options.egress?.counters().requests ?? 0,
      webBytes: options.egress?.counters().bytes ?? 0,
      toolCallsByName: { ...toolCallsByName },
      rejectedSubmissions: [...rejectedSubmissions],
      rejectedSubmissionTotal,
      perAgent: options.authority.all().map((identity) => ({
        agentId: identity.agentId,
        role: identity.role,
        provider: identity.provider,
        delegationDepth: identity.delegationDepth,
        status: identity.status,
        modelRequests: counters.byAgent[identity.agentId] ?? 0,
        toolCalls: toolCallsByAgent.get(identity.agentId) ?? 0,
        evidenceProduced: evidenceByAgent.get(identity.agentId) ?? 0,
      })),
    }
  }

  function recordToolCall(identity: AgentIdentity, toolName: string): void {
    toolCalls++
    toolCallsByAgent.set(identity.agentId, (toolCallsByAgent.get(identity.agentId) ?? 0) + 1)
    toolCallsByName[toolName] = (toolCallsByName[toolName] ?? 0) + 1
  }

  function recordAudit(entry: ToolAuditEntry): void {
    auditEntries.push(entry)
    if (auditEntries.length >= AUDIT_FLUSH_THRESHOLD) {
      void flushAudit().catch(() => undefined)
    }
  }

  function recordDecision(entry: PermissionDecisionEntry): void {
    auditDecisions.push(entry)
  }

  /**
   * 审计落库。失败**不丢数据**。
   *
   * 之前这里先 `splice` 取走再落库，失败时只记一条 `tool_audit_flush_failed` 就把那批记录
   * 扔了 —— 数据库抖一下，这段时间的工具审计与 permission decision 就永久消失，而 §7.11
   * 要求这些是可审计的。现在失败后把记录放回队首，由后续 flush（含 close 时那一次）重试。
   *
   * 重排队有上界：数据库整场不可用时不能把内存吃光。超出上界只保留最早的部分并记录丢弃量 ——
   * 丢弃是最后手段，而且必须显式可见，不能装作没发生。
   */
  async function flushAudit(): Promise<void> {
    if (auditEntries.length === 0 && auditDecisions.length === 0) return
    // 没有落库钩子时不要先 splice：那等于在单测里静默丢弃，也让"钩子后来才接上"的路径丢数据。
    if (!options.flushAudit) return
    const entries = auditEntries.splice(0, auditEntries.length)
    const decisions = auditDecisions.splice(0, auditDecisions.length)
    await options.flushAudit(entries, decisions).catch((err) => {
      const beforeEntries = auditEntries.length
      const beforeDecisions = auditDecisions.length
      auditEntries.unshift(...entries)
      auditDecisions.unshift(...decisions)
      const droppedEntries = Math.max(auditEntries.length - AUDIT_QUEUE_CAP, 0)
      const droppedDecisions = Math.max(auditDecisions.length - AUDIT_QUEUE_CAP, 0)
      if (droppedEntries > 0) auditEntries.length = AUDIT_QUEUE_CAP
      if (droppedDecisions > 0) auditDecisions.length = AUDIT_QUEUE_CAP
      options.logger.error('tool_audit_flush_failed', {
        event: 'tool_audit_flush_failed',
        requeued_entries: entries.length,
        requeued_decisions: decisions.length,
        queued_entries: beforeEntries + entries.length - droppedEntries,
        queued_decisions: beforeDecisions + decisions.length - droppedDecisions,
        // 只有真的超过上界才会有丢弃；非零就是需要人介入的信号。
        dropped_entries: droppedEntries,
        dropped_decisions: droppedDecisions,
        error_message: redactError(err),
      })
    })
  }

  const server: Server = createServer((req, res) => {
    void handle(req, res).catch((err) => {
      options.logger.error('broker_request_failed', {
        event: 'broker_request_failed',
        error_message: redactError(err),
      })
      respond(res, 500, { accepted: false, code: 'BROKER_INTERNAL', reason: 'broker failure' })
    })
  })

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const requestBytes = Number(req.headers['content-length'] ?? 0)
    const body = await readJsonBody(req)
    const startedAt = new Date()

    if (!isAuthorized(req, token)) {
      respond(res, 401, { accepted: false, code: 'BROKER_UNAUTHORIZED', reason: 'unauthorized' })
      return
    }
    if (revokedReason) {
      respond(res, 409, {
        accepted: false,
        code: 'ATTEMPT_REVOKED',
        reason: revokedReason,
      })
      return
    }
    if (!options.isLeaseValid()) {
      revokedReason = 'the task lease is no longer held by this worker'
      respond(res, 409, { accepted: false, code: 'TASK_LEASE_LOST', reason: revokedReason })
      return
    }
    if (!matchesAttempt(body, options)) {
      respond(res, 403, {
        accepted: false,
        code: 'ATTEMPT_MISMATCH',
        reason: 'request does not name this task attempt',
      })
      return
    }

    const route = req.url ?? ''
    const routeEntry = brokerRouteCapability(route, contract)
    if (!routeEntry) {
      // 未知路由 fail closed。新增一条路由必须先进契约，否则它绕过了角色策略。
      respond(res, 404, {
        accepted: false,
        code: 'BROKER_UNKNOWN_ROUTE',
        reason: `unknown route: ${route}`,
      })
      return
    }

    const envelope = body as AttemptEnvelope
    const toolName = typeof envelope.toolName === 'string' ? envelope.toolName : undefined

    // 注册路由是唯一一个"调用者还没有自己的令牌"的场景：它出示的是父 Agent 的令牌。
    //
    // 审计路由则是另一种特殊情况：它的 `toolName` 是**被审计对象**，不是"我正在调用的工具"。
    // 之前这里对所有非注册路由一律拿 envelope.toolName 去做权限校验，于是"上报我调用
    // submit_review_result 被拒了"会被当成"我要调用 submit_review_result"来判定，必然
    // SUBMIT_ROOT_ONLY → 403 —— 一个 catch-22：被拒的 Agent 恰恰没有权限上报自己被拒。
    //
    // 后果是治理审计凭空消失：实测 workflow 子 Agent 被正确拒绝 30 多次，
    // analysis_permission_decision 与 rejected_submissions 里一条记录都没有。路由自身的
    // capability（`usageReport`）仍然照常校验，所以放开 toolName 不会放宽任何写入权限。
    const toolNameIsSubject = route === '/attempt/register-agent' || route === '/attempt/tool-audit'

    let authorized
    try {
      authorized = options.authority.authorize({
        token: typeof envelope.agentCapability === 'string' ? envelope.agentCapability : undefined,
        capability: routeEntry.capability,
        claimedAgentId: route === '/attempt/register-agent' ? undefined : envelope.agentId,
        toolName: toolNameIsSubject ? undefined : toolName,
      })
    } catch (err) {
      const code = err instanceof V4GovernanceError ? err.code : V4_ERROR_CODES.AGENT_IDENTITY_INVALID
      recordDecision({
        agentId: String(envelope.agentId ?? 'unknown'),
        agentRole: 'unknown',
        toolName: toolName ?? route,
        policyLayer: 'broker',
        decision: 'DENY',
        reasonCode: code,
      })
      recordAudit({
        agentId: String(envelope.agentId ?? 'unknown'),
        sessionId: typeof envelope.sessionId === 'string' ? envelope.sessionId : null,
        toolCallId: typeof envelope.toolCallId === 'string' ? envelope.toolCallId : null,
        toolName: toolName ?? route,
        permissionVerdict: 'DENY',
        errorCode: code,
        startedAt: startedAt.toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt.getTime(),
        requestBytes,
        responseBytes: 0,
      })
      options.logger.info('broker_authorization_denied', {
        event: 'broker_authorization_denied',
        route,
        tool_name: toolName ?? null,
        error_code: code,
      })
      // 身份解析失败也必须留下模型请求终态：provider 没被联系，但"这次请求被拒了"
      // 是归因里最有价值的一类事实。没有 identity，所以不带 agentId ——
      // 事件仍然挂在 attempt 上。
      if (route === '/attempt/reserve-model-request') {
        const deniedCorrelation = readCorrelationId(body)
        if (deniedCorrelation !== undefined) {
          emitRuntimeEvent({
            type: 'MODEL_REQUEST_DENIED',
            correlationId: deniedCorrelation,
            errorCode: code,
            payload: {
              model_request_kind: String(body.kind ?? 'other') as ModelRequestKind,
              reason_code: code,
              permission_verdict: 'DENY',
            },
          })
        }
      }
      respond(res, 403, {
        accepted: false,
        code,
        reason: (err as Error).message,
      })
      return
    }

    const identity = authorized.identity
    // toolCalls 的口径是“模型实际调用了多少工具”，不是“Broker 收了多少请求”。
    // 五个 platform 工具在各自执行路由计数；Harness-origin 工具不经过执行路由，稍后由
    // tool-audit lifecycle STARTED 计数。register/finish、预算、观测、Artifact 与 web egress
    // 都是内部路由，不能污染 usage（web_fetch 自身也由 lifecycle 计数，避免双计）。
    const platformToolName = platformToolByRoute[route]
    if (platformToolName !== undefined) recordToolCall(identity, platformToolName)

    let responsePayload: unknown
    let status = 200
    let errorCode: string | null = null
    try {
      switch (route) {
        case '/attempt/search-code':
          responsePayload = await searchCode(body)
          break
        case '/attempt/find-files':
          responsePayload = await options.snapshots.findFiles(body as never)
          break
        case '/attempt/read-code':
          responsePayload = await readCode(body, identity)
          break
        case '/attempt/list-commits':
          responsePayload = { commits: await options.snapshots.commits(body as never) }
          break
        case '/attempt/snapshot-pins':
          responsePayload = { pins: options.snapshots.pins() }
          break
        case '/attempt/register-agent':
          responsePayload = await registerAgent(body, envelope)
          break
        case '/attempt/finish-agent':
          responsePayload = await finishAgent(identity, body)
          break
        case '/attempt/reserve-model-request':
          responsePayload = reserveModelRequest(identity, body)
          break
        case '/attempt/report-usage':
          responsePayload = reportUsage(identity, body)
          break
        case '/attempt/tool-audit':
          responsePayload = ingestAudit(identity, body)
          break
        case '/attempt/web-egress':
          responsePayload = await webEgress(identity, body)
          break
        case '/attempt/save-artifact':
          responsePayload = await saveArtifact(identity, body)
          break
        case '/attempt/submit-review':
          responsePayload = await submitReview(body, identity)
          break
        default:
          status = 404
          responsePayload = {
            accepted: false,
            code: 'BROKER_UNKNOWN_ROUTE',
            reason: `unknown route: ${route}`,
          }
      }
    } catch (err) {
      // Tool-level faults are returned to the model so it can adapt; they are
      // not attempt-fatal.
      if (err instanceof V4GovernanceError) {
        errorCode = err.code
        status = 403
        responsePayload = { accepted: false, code: err.code, reason: err.message }
      } else {
        errorCode = err instanceof SnapshotError ? err.code : 'TOOL_FAILED'
        status = 422
        responsePayload = {
          accepted: false,
          code: errorCode,
          reason: (err as Error)?.message ?? 'tool failed',
        }
      }
    }

    const serialized = JSON.stringify(responsePayload)
    recordAudit({
      agentId: identity.agentId,
      sessionId: identity.sessionId,
      toolCallId: typeof envelope.toolCallId === 'string' ? envelope.toolCallId : null,
      toolName: (toolName ?? route.replace(/^\/attempt\//, '')) || 'unknown',
      permissionVerdict: errorCode === null ? 'ALLOW' : 'DENY',
      errorCode,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt.getTime(),
      requestBytes,
      responseBytes: Buffer.byteLength(serialized),
    })
    respondRaw(res, status, serialized)
  }

  async function searchCode(body: Record<string, unknown>): Promise<unknown> {
    const result = await options.snapshots.search(body as never)
    coverageLedger.record({
      repository: body.repository as RepositoryName,
      query: String(body.query ?? ''),
      pathGlob: typeof body.pathGlob === 'string' ? body.pathGlob : undefined,
      hits: result.hits.length,
      truncated: result.truncated,
    })
    return result
  }

  async function readCode(
    body: Record<string, unknown>,
    identity: AgentIdentity,
  ): Promise<unknown> {
    const read = await options.snapshots.readRange(body as never)
    const receipt = evidenceLedger.record({
      repository: read.repository,
      commitSha: read.commitSha,
      filePath: read.filePath,
      blobSha: read.blobSha,
      startLine: read.startLine,
      endLine: read.endLine,
      contentHash: read.contentHash,
    })
    // Evidence 的生产者是"实际被展示这段代码的那个 Agent"，不是提交者。root 汇总时
    // 引用 child 的 evidenceId 是合法的；引用别的 tree 的 id 不是。
    evidenceProducer.set(receipt.evidenceId, {
      agentId: identity.agentId,
      sessionId: identity.sessionId,
      toolCallId: typeof body.toolCallId === 'string' ? body.toolCallId : null,
    })
    evidenceByAgent.set(identity.agentId, (evidenceByAgent.get(identity.agentId) ?? 0) + 1)
    // The model never sees blob ids or hashes; it only needs the citable id.
    return {
      evidenceId: receipt.evidenceId,
      repository: read.repository,
      filePath: read.filePath,
      startLine: read.startLine,
      endLine: read.endLine,
      totalLines: read.totalLines,
      truncated: read.truncated,
      content: read.content,
    }
  }

  async function registerAgent(
    body: Record<string, unknown>,
    envelope: AttemptEnvelope,
  ): Promise<unknown> {
    const provider = String(body.provider ?? '') as AgentProvider
    if (provider === 'root' || provider.length === 0) {
      throw new V4GovernanceError(
        V4_ERROR_CODES.AGENT_IDENTITY_INVALID,
        'the root agent identity is created by the platform and cannot be registered by a model',
      )
    }
    const registered = await options.authority.registerChild({
      parentToken: String(envelope.agentCapability),
      agentId: String(body.childAgentId ?? ''),
      sessionId: String(body.childSessionId ?? ''),
      provider: provider as Exclude<AgentProvider, 'root'>,
      requestedRole: typeof body.requestedRole === 'string' ? body.requestedRole : undefined,
      delegationDepth:
        typeof body.delegationDepth === 'number' ? body.delegationDepth : undefined,
    })
    await options.registerAgentNode?.(registered.identity)
    recordDecision({
      agentId: registered.identity.agentId,
      agentRole: registered.identity.role,
      toolName: 'register_agent',
      policyLayer: 'role',
      decision: 'ALLOW',
      reasonCode: 'AGENT_REGISTERED',
    })
    return {
      accepted: true,
      agentCapability: registered.token,
      agentId: registered.identity.agentId,
      role: registered.identity.role,
      delegationDepth: registered.identity.delegationDepth,
      tools: registered.identity.tools,
    }
  }

  async function finishAgent(
    identity: AgentIdentity,
    body: Record<string, unknown>,
  ): Promise<unknown> {
    const raw = String(body.status ?? 'FINISHED')
    const status: 'FINISHED' | 'FAILED' | 'CANCELLED' =
      raw === 'FAILED' || raw === 'CANCELLED' ? raw : 'FINISHED'
    // 一个 Agent 只能给自己收尾。让别人代为收尾就等于给了它一个取消同级 Agent 的原语。
    options.authority.finish(identity.agentId, status)
    options.authority.revoke(identity.agentId)
    await options.markAgentTerminal?.(identity.agentId, status)
    return { accepted: true, status }
  }

  function reserveModelRequest(
    identity: AgentIdentity,
    body: Record<string, unknown>,
  ): unknown {
    const kind = String(body.kind ?? 'loop') as ModelRequestKind
    const verdict = options.budget.reserve({
      agentId: identity.agentId,
      isRoot: identity.provider === 'root',
      kind,
      count: typeof body.count === 'number' ? body.count : 1,
    })
    const correlationId = readCorrelationId(body)
    const retryIndex = typeof body.retryIndex === 'number' ? body.retryIndex : undefined
    if (!verdict.allowed) {
      recordDecision({
        agentId: identity.agentId,
        agentRole: identity.role,
        toolName: `model:${kind}`,
        policyLayer: 'budget',
        decision: 'DENY',
        reasonCode: verdict.code ?? V4_ERROR_CODES.MODEL_BUDGET_EXHAUSTED,
      })
      // provider 确实没有被联系过：这一点由插件"不调用 next()"保证。
      if (correlationId !== undefined) {
        emitRuntimeEvent({
          type: 'MODEL_REQUEST_DENIED',
          agentId: identity.agentId,
          correlationId,
          errorCode: verdict.code ?? V4_ERROR_CODES.MODEL_BUDGET_EXHAUSTED,
          payload: {
            model_request_kind: kind,
            agent_role: toRuntimeAgentRole(identity.role),
            reason_code: verdict.code ?? V4_ERROR_CODES.MODEL_BUDGET_EXHAUSTED,
            permission_verdict: 'DENY',
          },
        })
      }
      return verdict
    }
    if (correlationId !== undefined) {
      emitRuntimeEvent({
        type: 'MODEL_REQUEST_STARTED',
        agentId: identity.agentId,
        correlationId,
        payload: {
          model_request_kind: kind,
          agent_role: toRuntimeAgentRole(identity.role),
          retry_index: retryIndex,
        },
      })
    }
    return verdict
  }

  function reportUsage(identity: AgentIdentity, body: Record<string, unknown>): unknown {
    options.budget.observeTokens({
      agentId: identity.agentId,
      inputTokens: typeof body.inputTokens === 'number' ? body.inputTokens : null,
      outputTokens: typeof body.outputTokens === 'number' ? body.outputTokens : null,
    })

    // 模型请求终态。插件在 metered() 的 finally 里无条件上报，即使 provider 不报 token ——
    // 否则"模型请求已结束"就永远不可见。token 保持 null，不折成 0。
    const correlationId = readCorrelationId(body)
    if (correlationId !== undefined && body.phase === 'TERMINAL') {
      const failed = body.failed === true
      emitRuntimeEvent({
        type: failed ? 'MODEL_REQUEST_FAILED' : 'MODEL_REQUEST_COMPLETED',
        agentId: identity.agentId,
        correlationId,
        durationMs: typeof body.durationMs === 'number' ? body.durationMs : undefined,
        errorCode: typeof body.errorCode === 'string' ? body.errorCode : undefined,
        payload: {
          model_request_kind: String(body.kind ?? 'other') as ModelRequestKind,
          agent_role: toRuntimeAgentRole(identity.role),
          retry_index: typeof body.retryIndex === 'number' ? body.retryIndex : undefined,
          input_tokens: typeof body.inputTokens === 'number' ? body.inputTokens : null,
          output_tokens: typeof body.outputTokens === 'number' ? body.outputTokens : null,
          duration_ms: typeof body.durationMs === 'number' ? body.durationMs : undefined,
        },
      })
    }
    return { accepted: true }
  }

  function ingestAudit(identity: AgentIdentity, body: Record<string, unknown>): unknown {
    const entries = Array.isArray(body.entries) ? body.entries : []

    // 工具生命周期：`lifecycle` 是 V1.5 对这条现有路由的请求体扩展（方案 §7.2）。
    // 不新增 Broker 路由是硬约束 —— scripts/v4-harness-manifest.mjs 把 brokerRoutes 纳入
    // semanticManifest，新增一条路由就会改变 manifest 哈希，而 factory.ts 会让新 Worker
    // 拒绝所有旧哈希的在途任务，也就是必须排空所有活动批次才能部署。
    // semanticManifest 完全不涉及请求体形状，所以扩展 payload 是零代价的。
    // `entries` 数组的现有审计行为不变。
    ingestToolLifecycle(identity, body.lifecycle)

    let accepted = 0
    for (const raw of entries) {
      const entry = raw as Record<string, unknown>
      recordAudit({
        // 归属由令牌决定，不由上报内容决定。
        agentId: identity.agentId,
        sessionId: identity.sessionId,
        toolCallId: typeof entry.toolCallId === 'string' ? entry.toolCallId : null,
        toolName: String(entry.toolName ?? 'unknown'),
        permissionVerdict:
          entry.permissionVerdict === 'DENY'
            ? 'DENY'
            : entry.permissionVerdict === 'CANCELLED'
              ? 'CANCELLED'
              : 'ALLOW',
        errorCode: typeof entry.errorCode === 'string' ? entry.errorCode : null,
        startedAt: typeof entry.startedAt === 'string' ? entry.startedAt : new Date().toISOString(),
        finishedAt:
          typeof entry.finishedAt === 'string' ? entry.finishedAt : new Date().toISOString(),
        durationMs: typeof entry.durationMs === 'number' ? Math.max(entry.durationMs, 0) : 0,
        requestBytes: typeof entry.requestBytes === 'number' ? Math.max(entry.requestBytes, 0) : 0,
        responseBytes:
          typeof entry.responseBytes === 'number' ? Math.max(entry.responseBytes, 0) : 0,
      })
      accepted++
    }
    if (entry_isDenied(body)) {
      const deniedTool = String(body.toolName ?? 'unknown')
      const reasonCode = String(body.reasonCode ?? 'UNSPECIFIED')
      recordDecision({
        agentId: identity.agentId,
        agentRole: identity.role,
        toolName: deniedTool,
        policyLayer: 'child-filter',
        decision: 'DENY',
        reasonCode,
      })
      // 非根 Agent 试图调用提交工具，必须像"被拒的提交"一样可见。
      //
      // 此前它只落在 analysis_permission_decision 里：`rejectedSubmissions` 只在 Broker 的
      // submit 路由做完校验后追加，而子 Agent 在 Tool 层（agent-authority-policy 的
      // tools/pre-execute）就被拒了，压根到不了那条路由。结果是运维在
      // `agent_attempt_finished` 的 rejected_submissions 里看到空数组，完全不知道刚才有
      // 子 Agent 反复尝试越权提交 —— 实测 workflow 子 Agent 因为无法被 toolFilter 收窄
      // （Harness 的 workflow agent() 不转发 toolFilter），确实看得见并会去调这个工具。
      //
      // 提交权是这个平台最强的不变量，任何一次冲撞都必须留痕且可计数。
      if (deniedTool === 'submit_review_result' && identity.provider !== 'root') {
        recordRejectedSubmission(reasonCode)
        // 只在前若干次告警：一个循环重试的子 Agent 不该把日志刷满，但头几次必须可见。
        if (rejectedSubmissionTotal <= REJECTED_SUBMISSION_CAP) {
          options.logger.warn('child_submit_attempt_denied', {
            event: 'child_submit_attempt_denied',
            error_code: reasonCode,
            agent_id: identity.agentId,
            agent_role: identity.role,
            provider: identity.provider,
            delegation_depth: identity.delegationDepth,
            rejected_so_far: rejectedSubmissionTotal,
          })
        }
      }
    }
    return { accepted: true, count: accepted }
  }

  /**
   * 观测事件转投。fail open：Reporter 未装配或抛出时静默忽略，绝不影响工具执行、
   * 模型调用、预算、租约或提交校验。
   */
  function emitRuntimeEvent(event: RuntimeEvent): void {
    if (options.reportRuntimeEvent === undefined) return
    try {
      options.reportRuntimeEvent(event)
    } catch {
      // 监控失败不能放宽权限，也不能让业务失败。
    }
  }

  /** correlation id 只接受非空字符串；它必须由产生方随机生成，不含命令、URL 或路径。 */
  function readCorrelationId(body: Record<string, unknown>): string | undefined {
    const raw = body.correlationId
    if (typeof raw !== 'string') return undefined
    const trimmed = raw.trim()
    return trimmed === '' ? undefined : trimmed
  }

  function toRuntimeAgentRole(role: string): RuntimeAgentRole | undefined {
    switch (role) {
      case 'root-reviewer':
      case 'research-child':
      case 'implementation-child':
      case 'critic-child':
      case 'workflow-child':
        return role
      default:
        return undefined
    }
  }

  function toRuntimeAgentProvider(provider: string): RuntimeAgentProvider | undefined {
    switch (provider) {
      case 'root':
      case 'spawn':
      case 'fork':
      case 'workflow':
      case 'ralph':
        return provider
      default:
        return undefined
    }
  }

  function optionalNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined
  }

  /**
   * 把 `/attempt/tool-audit` 请求体里的 `lifecycle` 字段翻译成工具生命周期事件。
   *
   * 插桩点在 `agent-authority-policy` 的 `tools/pre-execute`（覆盖全部 30 个模型工具，
   * 包括 25 个根本不经过 Broker 的 harness origin 工具）。这里只做翻译，不做判定：
   * 归属永远由 capability 令牌决定的 `identity` 说了算，不由上报内容决定。
   */
  function ingestToolLifecycle(identity: AgentIdentity, raw: unknown): void {
    if (raw === null || typeof raw !== 'object') return
    const lifecycle = raw as Record<string, unknown>
    const correlationId =
      typeof lifecycle.correlationId === 'string' && lifecycle.correlationId.trim() !== ''
        ? lifecycle.correlationId.trim()
        : undefined
    if (correlationId === undefined) return

    const toolName = String(lifecycle.toolName ?? '').trim()
    if (toolName === '') return
    const agentRole = toRuntimeAgentRole(identity.role)
    const occurredAt =
      typeof lifecycle.occurredAt === 'string' && !Number.isNaN(Date.parse(lifecycle.occurredAt))
        ? new Date(lifecycle.occurredAt)
        : undefined
    const durationMs = optionalNumber(lifecycle.durationMs)
    const errorCode =
      typeof lifecycle.errorCode === 'string' && lifecycle.errorCode.trim() !== ''
        ? lifecycle.errorCode.trim()
        : undefined
    const phase = String(lifecycle.phase ?? '')

    if (phase === 'STARTED') {
      // platform 工具已由它们的执行路由计数；其余 25 个 Harness-origin 工具只有这里能看到。
      // 以 lifecycle correlation 去重，避免 IPC 重试把同一次调用重复写入 usage。
      if (
        contract.modelTools[toolName]?.origin === 'harness' &&
        !countedToolCorrelations.has(correlationId)
      ) {
        countedToolCorrelations.add(correlationId)
        recordToolCall(identity, toolName)
      }
      emitRuntimeEvent({
        type: 'TOOL_CALL_STARTED',
        agentId: identity.agentId,
        correlationId,
        occurredAt,
        payload: {
          tool_name: toolName,
          agent_role: agentRole,
          provider: toRuntimeAgentProvider(identity.provider),
          request_bytes: optionalNumber(lifecycle.requestBytes),
        },
      })
      return
    }
    if (phase !== 'TERMINAL') return

    const outcome = String(lifecycle.outcome ?? 'COMPLETED')
    if (outcome === 'DENIED') {
      emitRuntimeEvent({
        type: 'TOOL_CALL_DENIED',
        agentId: identity.agentId,
        correlationId,
        occurredAt,
        errorCode,
        payload: {
          tool_name: toolName,
          agent_role: agentRole,
          permission_verdict: 'DENY',
          reason_code: String(lifecycle.reasonCode ?? errorCode ?? 'UNSPECIFIED'),
        },
      })
      return
    }

    const terminalPayload = {
      tool_name: toolName,
      agent_role: agentRole,
      duration_ms: durationMs,
      exit_code: optionalNumber(lifecycle.exitCode),
      output_bytes: optionalNumber(lifecycle.outputBytes),
      response_bytes: optionalNumber(lifecycle.responseBytes),
      truncated: typeof lifecycle.truncated === 'boolean' ? lifecycle.truncated : undefined,
      hit_count: optionalNumber(lifecycle.hitCount),
      line_span: optionalNumber(lifecycle.lineSpan),
    }
    if (outcome === 'FAILED') {
      emitRuntimeEvent({
        type: 'TOOL_CALL_FAILED',
        agentId: identity.agentId,
        correlationId,
        occurredAt,
        durationMs,
        errorCode,
        payload: terminalPayload,
      })
      return
    }
    if (outcome === 'CANCELLED') {
      emitRuntimeEvent({
        type: 'TOOL_CALL_CANCELLED',
        agentId: identity.agentId,
        correlationId,
        occurredAt,
        durationMs,
        errorCode,
        payload: terminalPayload,
      })
      return
    }
    emitRuntimeEvent({
      type: 'TOOL_CALL_COMPLETED',
      agentId: identity.agentId,
      correlationId,
      occurredAt,
      durationMs,
      payload: terminalPayload,
    })
  }

  async function webEgress(
    identity: AgentIdentity,
    body: Record<string, unknown>,
  ): Promise<EgressFetchResult> {
    if (!options.egress) {
      throw new V4GovernanceError(
        V4_ERROR_CODES.WEB_EGRESS_DENIED,
        'web egress is not available for this attempt',
      )
    }
    return options.egress.fetch({
      url: String(body.url ?? ''),
      kind: body.kind === 'search' ? 'search' : 'fetch',
      agentId: identity.agentId,
    })
  }

  async function saveArtifact(
    identity: AgentIdentity,
    body: Record<string, unknown>,
  ): Promise<unknown> {
    if (!options.workspace) {
      throw new V4GovernanceError(
        V4_ERROR_CODES.WORKSPACE_POLICY_DENIED,
        'no writable workspace is available for this attempt',
      )
    }
    const described = await options.workspace.describeArtifact(String(body.workspacePath ?? ''))
    const receipt = await options.saveArtifact?.({
      producerAgentId: identity.agentId,
      artifactType: String(body.artifactType ?? 'NOTE'),
      workspacePath: described.relativePath,
      contentHash: described.contentHash,
      sizeBytes: described.sizeBytes,
    })
    return {
      accepted: true,
      artifactId: receipt?.artifactId ?? null,
      workspacePath: described.relativePath,
      contentHash: described.contentHash,
      sizeBytes: described.sizeBytes,
    }
  }

  async function submitReview(
    body: Record<string, unknown>,
    identity: AgentIdentity,
  ): Promise<unknown> {
    if (committed) {
      // Idempotent: a retried submission must not create a second result.
      return { accepted: true, runId: committed.runId, committedAt: committed.committedAt }
    }
    // 第二层 root-only 校验（第一层在工具注册面，第三层在数据库）。
    if (identity.provider !== 'root') {
      throw new V4GovernanceError(
        V4_ERROR_CODES.SUBMIT_ROOT_ONLY,
        'only the root reviewer may submit; return your findings to your parent instead',
      )
    }

    const submission = body.submission as ReviewSubmission | undefined
    if (!submission || typeof submission !== 'object') {
      return { accepted: false, code: 'SUBMISSION_INVALID', reason: 'submission is required' }
    }

    const verification = await verifyReviewSubmission({
      submission,
      evidenceLedger,
      coverageLedger,
      snapshots: options.snapshots,
      coveragePolicy: options.coveragePolicy,
    })
    if (!verification.ok) {
      recordRejectedSubmission(verification.code)
      options.logger.info('review_submission_rejected', {
        event: 'review_submission_rejected',
        error_code: verification.code,
        // 拒绝原因要带出来：模型只有看懂原因才能一次改对，反复猜就是在烧预算。
        reason: verification.reason,
        rejected_so_far: rejectedSubmissionTotal,
      })
      return { accepted: false, code: verification.code, reason: verification.reason }
    }

    // Evidence producer 归属：每条证据都必须是这棵树里某个 Agent 实际被展示过的范围。
    const attributed = verification.evidence.map((item) => {
      const producer = evidenceProducer.get(item.evidenceId)
      if (!producer) {
        throw new V4GovernanceError(
          V4_ERROR_CODES.EVIDENCE_AGENT_INVALID,
          `evidence ${item.evidenceId} has no recorded producer in this agent tree`,
        )
      }
      if (!options.authority.get(producer.agentId)) {
        throw new V4GovernanceError(
          V4_ERROR_CODES.EVIDENCE_AGENT_INVALID,
          `evidence ${item.evidenceId} was produced outside this agent tree`,
        )
      }
      return { ...item, producer }
    })

    const receipt = await options.commitReview({
      submission,
      evidence: attributed,
      usage: usage(),
      configHash,
      identity: {
        rootAgentId: identity.agentId,
        rootSessionId: identity.sessionId,
        treeDigest: options.authority.treeDigest(),
        sessionRevision,
        policyHash: options.policyHash,
      },
    })
    committed = receipt
    options.logger.info('review_submission_committed', {
      event: 'review_submission_committed',
      evidence_count: attributed.length,
      agent_count: options.authority.totalCount(),
      max_depth: options.authority.maxDepthReached(),
    })
    return { accepted: true, runId: receipt.runId, committedAt: receipt.committedAt }
  }

  return new Promise<AttemptControlHandle>((resolveHandle, rejectHandle) => {
    server.once('error', rejectHandle)
    server.listen(socketPath, () => {
      server.removeListener('error', rejectHandle)
      try {
        chmodSync(socketPath, 0o600)
      } catch {
        // Some platforms do not allow chmod on sockets; the 0700 directory is
        // the primary control.
      }
      resolveHandle({
        socketPath,
        token,
        usage,
        committed: () => committed,
        setConfigHash: (hash: string) => {
          configHash = hash
        },
        setSessionRevision: (revision: number) => {
          sessionRevision = Math.max(sessionRevision, revision)
        },
        pendingAudit: () => ({ entries: [...auditEntries], decisions: [...auditDecisions] }),
        flushAudit,
        revoke: (reason: string) => {
          revokedReason = reason
        },
        close: async () => {
          revokedReason = revokedReason ?? 'attempt finished'
          await flushAudit().catch(() => undefined)
          await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
          rmSync(socketPath, { force: true })
        },
      })
    })
  })
}

/** 上报体是否描述了一次被拒绝的调用。 */
function entry_isDenied(body: Record<string, unknown>): boolean {
  return body.decision === 'DENY' && typeof body.toolName === 'string'
}

function matchesAttempt(
  body: Record<string, unknown>,
  options: AttemptControlBrokerOptions,
): boolean {
  const envelope = body as AttemptEnvelope
  return (
    envelope.taskId === options.taskId && envelope.agentAttempt === options.agentAttempt
  )
}

function isAuthorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false
  const provided = Buffer.from(header.slice('Bearer '.length))
  const expected = Buffer.from(token)
  if (provided.length !== expected.length) return false
  return timingSafeEqual(provided, expected)
}

const MAX_BODY_BYTES = 1024 * 1024

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    total += buffer.byteLength
    if (total > MAX_BODY_BYTES) {
      throw new Error('broker request body exceeds 1 MiB')
    }
    chunks.push(buffer)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  if (raw.length === 0) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

function respond(res: ServerResponse, status: number, payload: unknown): void {
  respondRaw(res, status, JSON.stringify(payload))
}

function respondRaw(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(body)),
  })
  res.end(body)
}
