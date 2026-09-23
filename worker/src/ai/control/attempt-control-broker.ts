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
import type { StoryAnalysisScope } from '../../db/jobs.js'
import {
  ANALYSIS_EXPANSION_REASON_CODES,
  validateCommitRelevanceVerdict,
  type AnalysisExpansionReasonCode,
  type CommitDiffAccessFact,
  type CommitRelevanceEnvelope,
  type CommitRelevanceOutput,
} from '../../analysis/commit-relevance-contract.js'
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
import {
  evaluateNativeResourceScope,
  SNAPSHOT_SCOPE_DENIED,
  type NativeResourceScopeDecision,
} from './native-resource-scope.js'
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
  /** V1.11 DB-frozen scope identity; null for legacy V1 jobs. */
  scopeIdentity: AttemptScopeCommitIdentity | null
}

export interface AttemptScopeCommitIdentity {
  generation: number
  triageRevision: number
  candidateManifestHash: string
  rulesetHash: string
  analysisScopeHash: string
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
  /**
   * V1.6 技能归因（方案 §16）。
   *
   * 三个键 + 一个安全的规范相对路径，**没有** SKILL.md 正文、资源正文、脚本正文或完整
   * 命令行。它们随现有 `/attempt/tool-audit` 请求体抵达，所以没有新增 Broker 路由 ——
   * `brokerRoutes` 进 semanticManifest，加一条就会换掉 manifest 哈希并让在途 Job 全部失败。
   */
  skillName?: string | null
  skillBundleHash?: string | null
  resourceRelativePath?: string | null
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
  /**
   * Database-issued fencing revision for this attempt.
   *
   * Retries start above revision 1, so the broker must receive the claimed
   * revision before the model can call any tool. Defaulting here would make a
   * completed retry impossible to commit: save_agent_review_result would
   * reject the stale revision with SESSION_FENCED.
   */
  sessionRevision: number
  snapshots: SnapshotStore
  coveragePolicy: CoveragePolicy
  /** Root directory that will hold the per-attempt socket. */
  socketRoot: string
  logger: Logger
  policy: V4CapabilityPolicy
  policyHash: string
  /**
   * 本次 attempt 冻结的技能目录（`name → bundleHash`）。
   *
   * Broker 用它**独立核对**插件上报的技能名，而不是转发上报值：一个能自报 bundle hash 的
   * 上游等于可以把审计指向一个不存在的版本。目录之外的名字一律丢弃字段（不是丢弃整条
   * 审计 —— 工具调用确实发生了，只是它与技能无关）。
   */
  skillBundleHashes?: ReadonlyMap<string, string>
  /** Agent 身份台账。Broker 的每一次授权都过它。 */
  authority: AgentAuthorityLedger
  /** 分层预算账本。 */
  budget: HierarchicalBudgetLedger
  /** Web 出口策略。缺省表示 Web 能力未装配，请求一律拒绝。 */
  egress?: EgressPolicy
  /** 隔离 Workspace。缺省表示 Artifact 能力未装配。 */
  workspace?: AttemptWorkspace
  /** V1.11 冻结 scope；缺省表示 legacy v1。 */
  analysisScope?: StoryAnalysisScope
  /** Canonical profile/session scope identity assembled from all frozen inputs. */
  analysisScopeHash?: string
  analysisStory?: { code: string; name: string; allowedContext: string }
  agentRunId?: string | null
  getStoryCommitDiffMetadata?(candidateId: string): Promise<{
    candidate_id: string
    repository_name: RepositoryName
    commit_sha: string
    status: string
    archive_sha256: string | null
  }>
  recordStoryCommitAccess?(input: {
    agentNodeId: string
    candidateId: string
    toolCallId: string
    accessKind: 'DIFF'
    filePath: string | null
    cursorValue: string | null
    bytesReturned: number
    diffLines: number
    truncated: boolean
    archiveSha256: string | null
  }): Promise<string>
  submitCommitRelevanceVerdict?(input: CommitRelevanceOutput & {
    scopeGeneration: number
    triageRevision: number
    candidateManifestHash: string
    rulesetHash: string
  }): Promise<{
    completed_count: number
    required_count: number
    triage_complete: boolean
  }>
  expandAnalysisScope?(input: {
    agentNodeId: string
    fromLevel: 'PRIMARY' | 'RELATED' | 'GLOBAL'
    toLevel: 'RELATED' | 'GLOBAL'
    reasonCode: string
  }): Promise<void>
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
  if (options.analysisScope !== undefined) {
    if (options.analysisScope.triage_revision !== options.agentAttempt) {
      throw new Error('TRIAGE_CONTEXT_MISMATCH: frozen scope revision does not match this Attempt')
    }
    if (!options.analysisScopeHash) {
      throw new Error('ANALYSIS_SCOPE_IDENTITY_MISSING: V2 Broker requires the canonical scope hash')
    }
  }
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
  let sessionRevision = options.sessionRevision
  let scopeLevel = options.analysisScope?.current_scope_level ?? 'GLOBAL'
  let triageComplete = options.analysisScope?.triage_complete ?? true
  const toolCallsByName: Record<string, number> = {}
  /** lifecycle 上报可能因 IPC 重试重复；同一 correlation 只计一次模型工具调用。 */
  const countedToolCorrelations = new Set<string>()
  /** 只有这五条路由直接代表 modelTools 中的 platform 工具。其余都是内部控制/观测。 */
  const platformToolByRoute: Readonly<Record<string, string>> = {
    '/attempt/search-code': 'search_snapshot_code',
    '/attempt/find-files': 'find_snapshot_files',
    '/attempt/read-code': 'read_snapshot_code',
    '/attempt/list-commits': 'list_snapshot_commits',
    '/attempt/list-story-commits': 'list_story_commits',
    '/attempt/read-story-commit-diff': 'read_story_commit_diff',
    '/attempt/submit-commit-relevance': 'submit_commit_relevance_verdict',
    '/attempt/expand-analysis-scope': 'expand_analysis_scope',
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
  /** 只有 access RPC 成功返回后才进入账本；模型自报 UUID 永远不会被采信。 */
  const commitDiffAccesses = new Map<string, CommitDiffAccessFact>()
  const scopeExpansions: Array<{
    targetLevel: 'RELATED' | 'GLOBAL'
    reasonCode: AnalysisExpansionReasonCode
  }> = []

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

    // scopeCheck is a synchronous authorization query piggybacking on the existing route. Its
    // model-controlled arguments must never enter audit rows, logs, lifecycle events, or usage.
    // A later denial report contains only tool name + stable reason code.
    if (route === '/attempt/tool-audit' && body.scopeCheck !== undefined) {
      const serialized = JSON.stringify(checkNativeResourceScope(body.scopeCheck))
      respondRaw(res, 200, serialized)
      return
    }

    // toolCalls 的口径是“模型实际调用了多少工具”，不是“Broker 收了多少请求”。
    // 九个 platform 工具在各自执行路由计数；Harness-origin 工具不经过执行路由，稍后由
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
          responsePayload = await findFiles(body)
          break
        case '/attempt/read-code':
          responsePayload = await readCode(body, identity)
          break
        case '/attempt/list-commits':
          responsePayload = { commits: await options.snapshots.commits(body as never) }
          break
        case '/attempt/list-story-commits':
          responsePayload = await listStoryCommits(body)
          break
        case '/attempt/read-story-commit-diff':
          responsePayload = await readStoryCommitDiff(body, identity)
          break
        case '/attempt/submit-commit-relevance':
          responsePayload = await submitCommitRelevance(body, identity)
          break
        case '/attempt/expand-analysis-scope':
          responsePayload = await expandStoryAnalysisScope(body, identity)
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
        /*
         * 稳定错误码优先，`TOOL_FAILED` 只当最后兜底。
         *
         * 之前这里只认 `SnapshotError`，于是数据库侧的工具级门禁（`DIFF_ACCESS_REQUIRED`、
         * `ANALYSIS_SCOPE_TRIAGE_INCOMPLETE`、`TRIAGE_VERDICT_INVALID` …）全部被抹成
         * `TOOL_FAILED`：审计行、运行事件和返回给模型的 `code` 里都看不出到底哪里不对
         * （2026-09-23 本地全链路实测，Job `e55681b7` 有 8 条这样的审计行）。
         * `DbError.code` 已经由 `normalizeDbErrorCode` 归一化过，直接用它。
         */
        const stableCode = (err as { code?: unknown }).code
        const message = (err as Error)?.message ?? ''
        // 一部分内部门禁抛的是普通 Error，稳定码写在消息前缀里（`TRIAGE_INCOMPLETE: …`、
        // `SCOPE_EXPANSION_UNAVAILABLE: …`）。前缀也算稳定码，否则同样退化成匿名失败。
        const prefixCode = /^([A-Z][A-Z0-9_]{2,63}):/.exec(message)?.[1]
        errorCode = err instanceof SnapshotError
          ? err.code
          : typeof stableCode === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/.test(stableCode)
            ? stableCode
            : prefixCode ?? 'TOOL_FAILED'
        status = errorCode === 'SNAPSHOT_SCOPE_DENIED' ? 403 : 422
        responsePayload = {
          accepted: false,
          code: errorCode,
          reason: message === '' ? 'tool failed' : message,
        }
        if (errorCode === 'TOOL_FAILED') {
          /*
           * 分不出类的工具失败必须留一行日志。
           *
           * 否则审计表里只有一个匿名的 `TOOL_FAILED`，而这正是"平台哪里坏了"最需要线索的
           * 一格（2026-09-23 本地实测里 submit_review_result 上就有这样的行）。只记错误类名
           * 与截断后的消息，不记请求体。
           */
          options.logger.info('broker_tool_failed_unclassified', {
            event: 'broker_tool_failed_unclassified',
            route,
            error_name: (err as Error)?.name ?? 'Error',
            error_message: message.slice(0, 300),
          })
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

  function checkNativeResourceScope(raw: unknown): NativeResourceScopeDecision {
    // Legacy V1 has no analysisScope and must retain its exact native-tool behavior.
    if (options.analysisScope === undefined) return { allowed: true }
    if (scopeLevel === 'GLOBAL') return { allowed: true }
    if (raw === null || typeof raw !== 'object' || options.workspace === undefined) {
      return {
        allowed: false,
        code: SNAPSHOT_SCOPE_DENIED,
        reason: 'resource path could not be determined',
      }
    }
    const check = raw as Record<string, unknown>
    return evaluateNativeResourceScope({
      toolName: typeof check.toolName === 'string' ? check.toolName : '',
      args: check.arguments,
      scopeLevel,
      triageComplete,
      workspaceDir: options.workspace.cwd,
      reposDir: options.workspace.reposDir,
      repositories: options.snapshots.pins().map((pin) => pin.repository),
      candidates: options.analysisScope.candidates,
    })
  }

  function scopedCandidates(): StoryAnalysisScope['candidates'] {
    return options.analysisScope?.candidates.filter(
      (candidate) => candidate.tier !== 'EXCLUDED' && candidate.tier !== 'CONFLICT',
    ) ?? []
  }

  function scopedRepositories(): ReadonlySet<RepositoryName> {
    return new Set(scopedCandidates().map((candidate) => candidate.repository))
  }

  function primaryPaths(repository: string): string[] {
    const paths = new Set<string>()
    for (const candidate of scopedCandidates()) {
      if (candidate.repository !== repository) continue
      // The DB projection is the authority. AI candidates only join PRIMARY
      // after the current run has reached N/N; absent selected fields fail closed.
      const isStrongSelected = candidate.tier === 'STRONG'
        && candidate.selected === true && candidate.selection_level === 'PRIMARY'
      const isTriagedSelected = triageComplete
        && (candidate.tier === 'AI_CANDIDATE' || candidate.tier === 'WEAK')
        && candidate.selected === true && candidate.selection_level === 'PRIMARY'
      if (!isStrongSelected && !isTriagedSelected) continue
      // `files` is a trusted get_story_task_analysis_scope projection. Missing
      // data is deliberately an empty set: an old DB proxy must fail closed,
      // not silently turn PRIMARY into repository-wide access.
      for (const file of candidate.files ?? []) {
        if (typeof file.path === 'string' && file.path !== '') paths.add(file.path)
        if (typeof file.old_path === 'string' && file.old_path !== '') paths.add(file.old_path)
      }
    }
    return [...paths]
  }

  function assertSnapshotScope(repository: string, path?: string): readonly string[] | undefined {
    // analysisScope is only installed for V2. Legacy V1 retains its exact
    // repository-wide snapshot behavior.
    if (options.analysisScope === undefined || scopeLevel === 'GLOBAL') return undefined
    if (!scopedRepositories().has(repository as RepositoryName)) {
      throw new SnapshotError(
        'repository is outside the current frozen analysis scope',
        'SNAPSHOT_SCOPE_DENIED',
      )
    }
    if (scopeLevel === 'RELATED') return undefined
    const allowed = primaryPaths(repository)
    if (path !== undefined) {
      const normalized = path.replace(/^\.\//, '')
      if (!allowed.includes(normalized)) {
        throw new SnapshotError(
          'path is outside the PRIMARY frozen candidate file set',
          'SNAPSHOT_SCOPE_DENIED',
        )
      }
    }
    return allowed
  }

  async function searchCode(body: Record<string, unknown>): Promise<unknown> {
    const repository = String(body.repository ?? '')
    const allowedPaths = assertSnapshotScope(repository)
    const result = await options.snapshots.search({
      repository,
      query: String(body.query ?? ''),
      pathGlob: typeof body.pathGlob === 'string' ? body.pathGlob : undefined,
      maxResults: typeof body.maxResults === 'number' ? body.maxResults : undefined,
      allowedPaths,
    })
    coverageLedger.record({
      repository: repository as RepositoryName,
      query: String(body.query ?? ''),
      pathGlob: typeof body.pathGlob === 'string' ? body.pathGlob : undefined,
      hits: result.hits.length,
      truncated: result.truncated,
    })
    return result
  }

  async function findFiles(body: Record<string, unknown>): Promise<unknown> {
    const repository = String(body.repository ?? '')
    const allowedPaths = assertSnapshotScope(repository)
    return options.snapshots.findFiles({
      repository,
      pattern: String(body.pattern ?? ''),
      maxResults: typeof body.maxResults === 'number' ? body.maxResults : undefined,
      allowedPaths,
    })
  }

  async function readCode(
    body: Record<string, unknown>,
    identity: AgentIdentity,
  ): Promise<unknown> {
    const repository = String(body.repository ?? '')
    const path = String(body.path ?? '')
    assertSnapshotScope(repository, path)
    const read = await options.snapshots.readRange({
      repository,
      path,
      startLine: Number(body.startLine),
      endLine: Number(body.endLine),
    })
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

  async function listStoryCommits(body: Record<string, unknown>): Promise<unknown> {
    assertV111ToolKeys(body, ['tier', 'repository', 'cursor', 'limit'])
    const scope = requireAnalysisScope(options.analysisScope)
    const tier = body.tier === undefined ? 'ALL' : String(body.tier)
    if (!['STRONG', 'AI_CANDIDATE', 'ALL'].includes(tier)) {
      throw new SnapshotError('tier must be STRONG, AI_CANDIDATE, or ALL', 'STORY_COMMIT_TIER_INVALID')
    }
    const repository = body.repository === undefined ? null : String(body.repository)
    if (repository !== null && !options.snapshots.pins().some((pin) => pin.repository === repository)) {
      throw new SnapshotError('repository is not pinned for this job', 'SNAPSHOT_REPO_NOT_PINNED')
    }
    const limit = body.limit === undefined ? 50 : Number(body.limit)
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new SnapshotError('limit must be an integer from 1 to 100', 'STORY_COMMIT_PAGE_INVALID')
    }
    const offset = decodeStoryCursor(body.cursor, scope.candidate_manifest_hash, 'list')
    const candidates = scope.candidates.filter((candidate) => {
      if (candidate.tier === 'EXCLUDED' || candidate.tier === 'CONFLICT') return false
      if (repository !== null && candidate.repository !== repository) return false
      if (tier === 'STRONG') return candidate.tier === 'STRONG'
      if (tier === 'AI_CANDIDATE') return candidate.tier === 'AI_CANDIDATE' || candidate.tier === 'WEAK'
      return true
    })
    const items = candidates.slice(offset, offset + limit).map((candidate) => ({
      candidateId: candidate.candidate_id,
      tier: candidate.tier,
      repository: candidate.repository,
      shortSha: candidate.short_sha,
      subject: candidate.subject,
      authorName: candidate.author_name,
      committedAt: candidate.committed_at,
      filesChanged: candidate.files_changed,
      additions: candidate.additions,
      deletions: candidate.deletions,
      reasonCodes: candidate.reason_codes,
      effectiveStatus: candidate.effective_status,
      diffStatus: candidate.diff_status,
      triageVerdict: candidate.triage_verdict,
      selected: candidate.selected,
      selectionLevel: candidate.selection_level,
    }))
    const nextOffset = offset + items.length
    return {
      generation: scope.generation,
      manifestHash: scope.candidate_manifest_hash,
      total: candidates.length,
      items,
      hasMore: nextOffset < candidates.length,
      nextCursor: nextOffset < candidates.length
        ? encodeStoryCursor(nextOffset, scope.candidate_manifest_hash, 'list')
        : null,
      truncated: false,
    }
  }

  async function readStoryCommitDiff(
    body: Record<string, unknown>,
    identity: AgentIdentity,
  ): Promise<unknown> {
    assertV111ToolKeys(body, ['candidateId', 'filePath', 'cursor'])
    const scope = requireAnalysisScope(options.analysisScope)
    const candidateId = String(body.candidateId ?? '')
    const candidate = scope.candidates.find((item) => item.candidate_id === candidateId)
    if (!candidate || candidate.tier === 'EXCLUDED' || candidate.tier === 'CONFLICT') {
      throw new SnapshotError('candidateId is not an allowed candidate in this frozen task scope', 'STORY_CANDIDATE_INVALID')
    }
    const filePath = body.filePath === undefined ? undefined : String(body.filePath)
    const cursorBinding = `diff:${candidateId}:${filePath ?? ''}`
    const offset = decodeStoryCursor(body.cursor, scope.candidate_manifest_hash, cursorBinding)
    if (!options.getStoryCommitDiffMetadata) {
      throw new Error('DIFF_METADATA_UNAVAILABLE: v2 diff reads require a claim-fenced metadata hook')
    }
    const metadata = await options.getStoryCommitDiffMetadata(candidateId)
    if (metadata.candidate_id !== candidateId || metadata.repository_name !== candidate.repository) {
      throw new SnapshotError('candidate metadata does not match the frozen scope', 'STORY_CANDIDATE_INVALID')
    }
    const result = await options.snapshots.readStoryCommitDiff({
      repository: candidate.repository,
      candidateCommit: metadata.commit_sha,
      filePath,
      offset,
    })
    if (!options.recordStoryCommitAccess || !options.agentRunId) {
      throw new Error('DIFF_ACCESS_PERSISTENCE_UNAVAILABLE: v2 diff reads require a claim-fenced access hook')
    }
    const toolCallId = typeof body.toolCallId === 'string' && body.toolCallId !== ''
      ? body.toolCallId
      : randomUUID()
    const accessId = await options.recordStoryCommitAccess({
      agentNodeId: identity.agentId,
      candidateId,
      toolCallId,
      accessKind: 'DIFF',
      filePath: filePath ?? null,
      cursorValue: typeof body.cursor === 'string' ? body.cursor : null,
      bytesReturned: result.bytesReturned,
      diffLines: result.diffLines,
      truncated: result.truncated,
      archiveSha256: result.archiveSha256,
    })
    commitDiffAccesses.set(accessId, {
      accessId,
      taskId: options.taskId,
      candidateId,
      attemptId: options.agentRunId,
      succeeded: true,
    })
    candidate.diff_status = result.status
    return {
      accessId,
      candidateId,
      repository: candidate.repository,
      shortSha: candidate.short_sha,
      subject: candidate.subject,
      status: result.status,
      files: result.files,
      filesTotal: result.filesTotal,
      filesTruncated: result.filesTruncated,
      blockedFileCount: result.blockedFileCount,
      diff: result.content,
      diffLines: result.diffLines,
      bytesReturned: result.bytesReturned,
      archiveHash: result.archiveSha256,
      truncated: result.truncated,
      nextCursor: result.nextOffset === null
        ? null
        : encodeStoryCursor(result.nextOffset, scope.candidate_manifest_hash, cursorBinding),
    }
  }

  async function submitCommitRelevance(
    body: Record<string, unknown>,
    identity: AgentIdentity,
  ): Promise<unknown> {
    assertV111ToolKeys(body, [
      'candidateId', 'verdict', 'reasonCodes', 'confidence', 'diffAccessIds', 'summary',
      'requestedExpansion',
    ])
    if (identity.provider !== 'root') {
      throw new V4GovernanceError(V4_ERROR_CODES.SUBMIT_ROOT_ONLY, 'only the root reviewer may submit commit relevance')
    }
    const scope = requireAnalysisScope(options.analysisScope)
    const candidateId = String(body.candidateId ?? '')
    const candidate = scope.candidates.find((item) => item.candidate_id === candidateId)
    if (!candidate || (candidate.tier !== 'AI_CANDIDATE' && candidate.tier !== 'WEAK')) {
      throw new SnapshotError('candidateId is not an AI triage candidate in this frozen scope', 'STORY_CANDIDATE_INVALID')
    }
    if (!options.submitCommitRelevanceVerdict || !options.agentRunId || !options.analysisStory) {
      throw new Error('TRIAGE_PERSISTENCE_UNAVAILABLE: v2 triage requires claim-fenced database hooks')
    }
    const requestedExpansion = body.requestedExpansion === undefined ? null : body.requestedExpansion
    const output = {
      schemaVersion: 1,
      candidateId,
      verdict: body.verdict,
      reasonCodes: body.reasonCodes,
      confidence: body.confidence,
      diffAccessIds: body.diffAccessIds,
      summary: body.summary,
      requestedExpansion,
    }
    const diffStatus = candidate.diff_status === 'AVAILABLE'
      ? 'AVAILABLE'
      : candidate.diff_status === 'BINARY'
        ? 'BINARY'
        : candidate.diff_status === 'TOO_LARGE' || candidate.diff_status === 'DIFF_TOO_LARGE'
          ? 'DIFF_TOO_LARGE'
          : 'UNAVAILABLE'
    const envelope: CommitRelevanceEnvelope = {
      schemaVersion: 1,
      phase: 'COMMIT_RELEVANCE_TRIAGE',
      taskId: options.taskId,
      story: options.analysisStory,
      scope: {
        generation: scope.generation,
        candidateManifestHash: scope.candidate_manifest_hash,
        rulesetHash: scope.ruleset_hash,
        requiredCandidateIds: scope.candidates
          .filter((item) => item.tier === 'AI_CANDIDATE' || item.tier === 'WEAK')
          .map((item) => item.candidate_id),
      },
      candidate: {
        candidateId,
        repository: candidate.repository,
        shortSha: candidate.short_sha,
        subject: candidate.subject,
        reasonCodes: candidate.reason_codes,
        diffStatus,
      },
    }
    const validated = validateCommitRelevanceVerdict({
      envelope,
      output,
      attemptId: options.agentRunId,
      accessFacts: [...commitDiffAccesses.values()],
    })
    if (validated.output.requestedExpansion !== null) {
      const requested = validated.output.requestedExpansion
      if (!scopeExpansions.some((fact) =>
        fact.targetLevel === requested.targetLevel && fact.reasonCode === requested.reasonCode)) {
        throw new Error('SCOPE_EXPANSION_NOT_RECORDED: call expand_analysis_scope before citing requestedExpansion')
      }
    }
    const persisted = await options.submitCommitRelevanceVerdict({
      ...validated.output,
      scopeGeneration: scope.generation,
      triageRevision: scope.triage_revision,
      candidateManifestHash: scope.candidate_manifest_hash,
      rulesetHash: scope.ruleset_hash,
    })
    triageComplete = persisted.triage_complete
    candidate.triage_verdict = validated.output.verdict
    candidate.selected = validated.output.verdict === 'RELATED' || validated.output.verdict === 'UNCERTAIN'
    candidate.selection_level = candidate.selected ? 'PRIMARY' : null
    return {
      accepted: true,
      candidateId,
      completedCount: persisted.completed_count,
      requiredCount: persisted.required_count,
      triageComplete: persisted.triage_complete,
    }
  }

  async function expandStoryAnalysisScope(
    body: Record<string, unknown>,
    identity: AgentIdentity,
  ): Promise<unknown> {
    assertV111ToolKeys(body, ['targetLevel', 'reasonCode'])
    if (identity.provider !== 'root') {
      throw new V4GovernanceError(V4_ERROR_CODES.SUBMIT_ROOT_ONLY, 'only the root reviewer may expand analysis scope')
    }
    requireAnalysisScope(options.analysisScope)
    const targetLevel = String(body.targetLevel ?? '') as 'RELATED' | 'GLOBAL'
    const reasonCode = String(body.reasonCode ?? '') as AnalysisExpansionReasonCode
    if (!['RELATED', 'GLOBAL'].includes(targetLevel) || !ANALYSIS_EXPANSION_REASON_CODES.includes(reasonCode)) {
      throw new SnapshotError('scope expansion target or reason is invalid', 'SCOPE_EXPANSION_INVALID')
    }
    /*
     * 已经到（或超过）目标层级时是**成功的空操作**，不是错误。
     *
     * 降级任务里 25/26 个需求的范围本来就是 GLOBAL（2026-09-23 本地实测 Job `e55681b7`），
     * Agent 按提示去扩展范围，旧实现一律抛 `SCOPE_EXPANSION_INVALID`——请求的意图（能读到
     * 全仓）其实已经满足，却回一个硬错误，模型只能再猜一轮，审计里还多出一堆 tool_calls_denied。
     * 层级只会变宽这条约束没有被放宽：这里不记新的扩展事实，也不改层级。
     */
    const widening: Readonly<Record<'PRIMARY' | 'RELATED' | 'GLOBAL', number>> = {
      PRIMARY: 0,
      RELATED: 1,
      GLOBAL: 2,
    }
    if (widening[targetLevel] <= widening[scopeLevel]) {
      return {
        expanded: false,
        fromLevel: scopeLevel,
        currentLevel: scopeLevel,
        reasonCode: 'ALREADY_AT_OR_ABOVE_TARGET_LEVEL',
      }
    }
    if (!options.expandAnalysisScope) {
      throw new Error('SCOPE_EXPANSION_UNAVAILABLE: v2 expansion hook is not configured')
    }
    const fromLevel = scopeLevel
    await options.expandAnalysisScope({
      agentNodeId: identity.agentId,
      fromLevel,
      toLevel: targetLevel,
      reasonCode,
    })
    scopeLevel = targetLevel
    scopeExpansions.push({ targetLevel, reasonCode })
    return { expanded: true, fromLevel, currentLevel: scopeLevel, reasonCode }
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
      const skill = resolveSkillAttribution(entry)
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
        skillName: skill?.skillName ?? null,
        skillBundleHash: skill?.skillBundleHash ?? null,
        resourceRelativePath: skill?.resourceRelativePath ?? null,
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
        policyLayer: reasonCode === SNAPSHOT_SCOPE_DENIED ? 'broker' : 'child-filter',
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
   * 核对上报的技能归因。
   *
   * 三条规则，每条都对应一个具体的滥用：
   *
   *   1. **技能名必须在冻结目录里。** 否则审计会指向一个这个 Job 根本没有的技能。
   *   2. **bundle hash 由 Broker 自己填，不用上报值。** 上报值只要能进库，审计就可以被
   *      指向另一个版本。
   *   3. **相对路径必须是安全规范路径。** 带 `..`、绝对路径、反斜杠或空白的一律丢弃 ——
   *      审计表不是攻击载荷的转运站。
   *
   * 校验失败只丢弃这三个字段，不丢弃整条审计：工具调用确实发生了。
   */
  function resolveSkillAttribution(
    entry: Record<string, unknown>,
  ): { skillName: string; skillBundleHash: string; resourceRelativePath: string | null } | undefined {
    const reported = entry.skillName
    if (typeof reported !== 'string' || reported === '') return undefined
    const bundleHash = options.skillBundleHashes?.get(reported)
    if (bundleHash === undefined) return undefined
    const rawPath = entry.resourceRelativePath
    let relativePath: string | null = null
    if (typeof rawPath === 'string' && rawPath !== '' && rawPath.length <= 240) {
      relativePath = /(^\/)|(\\)|(^[A-Za-z]:)|(\.\.)|(^\s)|(\s$)/.test(rawPath) ? null : rawPath
    }
    return { skillName: reported, skillBundleHash: bundleHash, resourceRelativePath: relativePath }
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

  async function completeCommitTriage(): Promise<void> {
    const scope = options.analysisScope
    if (!scope) return
    const requiredCount = scope.candidates.filter(
      (candidate) => candidate.tier === 'AI_CANDIDATE' || candidate.tier === 'WEAK',
    ).length
    if (requiredCount === 0) {
      triageComplete = true
      return
    }
    if (!triageComplete) {
      throw new Error(
        `TRIAGE_INCOMPLETE: submit every frozen AI candidate through submit_commit_relevance_verdict (${requiredCount} required)`,
      )
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

    try {
      await completeCommitTriage()
    } catch (error) {
      recordRejectedSubmission('TRIAGE_INCOMPLETE')
      return {
        accepted: false,
        code: 'TRIAGE_INCOMPLETE',
        reason: (error as Error).message,
      }
    }
    if (!triageComplete) {
      recordRejectedSubmission('TRIAGE_INCOMPLETE')
      return {
        accepted: false,
        code: 'TRIAGE_INCOMPLETE',
        reason: 'database triage completion is required before final review submission',
      }
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
      scopeIdentity: options.analysisScope
        ? {
            generation: options.analysisScope.generation,
            triageRevision: options.analysisScope.triage_revision,
            candidateManifestHash: options.analysisScope.candidate_manifest_hash,
            rulesetHash: options.analysisScope.ruleset_hash,
            analysisScopeHash: options.analysisScopeHash!,
          }
        : null,
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

const V111_ENVELOPE_KEYS = new Set([
  'taskId', 'agentAttempt', 'agentCapability', 'agentId', 'sessionId', 'toolCallId', 'toolName',
])

function assertV111ToolKeys(body: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedKeys = new Set([...V111_ENVELOPE_KEYS, ...allowed])
  const unknown = Object.keys(body).filter((key) => !allowedKeys.has(key))
  if (unknown.length > 0) {
    throw new SnapshotError(
      `unknown fields are not allowed: ${unknown.join(', ')}`,
      'STORY_TOOL_ARGUMENT_INVALID',
    )
  }
}

function requireAnalysisScope(scope: StoryAnalysisScope | undefined): StoryAnalysisScope {
  if (!scope) {
    throw new SnapshotError('story commit tools are unavailable for a legacy v1 task', 'ANALYSIS_SCOPE_UNAVAILABLE')
  }
  return scope
}

function encodeStoryCursor(offset: number, manifestHash: string, binding: string): string {
  return Buffer.from(JSON.stringify({ v: 1, o: offset, m: manifestHash, b: binding }), 'utf8').toString('base64url')
}

function decodeStoryCursor(value: unknown, manifestHash: string, binding: string): number {
  if (value === undefined || value === null || value === '') return 0
  if (typeof value !== 'string' || value.length > 512) {
    throw new SnapshotError('story tool cursor is invalid', 'STORY_DIFF_CURSOR_INVALID')
  }
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<string, unknown>
    if (
      parsed.v !== 1 || parsed.m !== manifestHash || parsed.b !== binding ||
      !Number.isSafeInteger(parsed.o) || Number(parsed.o) < 0
    ) throw new Error('cursor binding mismatch')
    return Number(parsed.o)
  } catch {
    throw new SnapshotError('story tool cursor is invalid or belongs to another frozen scope', 'STORY_DIFF_CURSOR_INVALID')
  }
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
