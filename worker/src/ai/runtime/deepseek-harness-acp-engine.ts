/**
 * 一次评审 attempt：一棵受控的 DeepSeek Harness Agent Tree，走 ACP。
 *
 * V3 的形状是"一个进程、一个 Session、一个根 Agent、五个工具、一次提交"。V4 的形状是：
 *
 * ```
 * 一个 Task
 *   → 一个私有 DSH 进程（单独进程组）
 *   → 一个持久化的根 Session（JSONL 在持久卷上）
 *   → 一个根 Agent + 若干受控子 Agent（spawn / fork / workflow / ralph）
 *   → 全能力工具面，按角色收窄
 *   → 根 Agent 唯一一次 submit_review_result
 * ```
 *
 * Worker 仍然持有全部特权：lease、凭据、快照根、Workspace、Web 出口、预算、验证与数据库写入。
 * 子进程持有的东西只有一个 socket 路径、一个 attempt token 和自己那份 capability token。
 *
 * 这个类负责编排顺序，而顺序在这里都是安全属性：
 *
 *   1. 先起 Broker（它要先存在，profile 才能引用它的 socket）；
 *   2. 再建 Workspace（cwd 必须在起进程之前就位）；
 *   3. 再物化 profile（把根身份、角色工具集、预算、session 根写进 attempt patch）；
 *   4. 再起进程并跑 turn；
 *   5. 无论怎么结束，都通过 AttemptTreeController 收敛：关 admission → child-first 撤令牌
 *      → 取消 Workflow/Jobs → 回收进程组 → 关 Broker → 清 Workspace → 数据库 fencing。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Logger } from '../../logger.js'
import { redactError } from '../../security/redaction.js'
import type { RepositoryName } from '../../git/repositories.js'
import { runSingleAcpTurn } from '../acp/acp-client.js'
import { startAcpProcess, type AcpProcessHandle } from '../acp/acp-process-supervisor.js'
import {
  materializeAttemptProfile,
  type MaterializedAttemptProfile,
  type ModelRouteSpec,
} from '../acp/profile-materializer.js'
import {
  startAttemptControlBroker,
  type AttemptControlHandle,
  type BrokerUsageSnapshot,
  type CommitReviewInput,
  type CommitReviewResult,
  type PermissionDecisionEntry,
  type ToolAuditEntry,
} from '../control/attempt-control-broker.js'
import {
  AgentAuthorityLedger,
  mintRootIdentity,
  type AgentIdentity,
} from '../control/agent-authority-ledger.js'
import { AttemptTreeController, type AttemptEndReason } from '../control/attempt-tree-controller.js'
import { HierarchicalBudgetLedger } from '../control/hierarchical-budget-ledger.js'
import { EgressPolicy, platformBlockedHosts } from '../web/egress-policy.js'
import { AttemptWorkspace } from '../workspace/attempt-workspace.js'
import { SessionRegistry, sessionFormatVersionFromPath } from '../session/session-registry.js'
import {
  evaluateResume,
  sessionCompatibilityKey,
  type ResumeCandidate,
  type ResumeDecision,
} from '../session/session-recovery.js'
import {
  assertResolvedInventory,
  contractHash,
  loadCapabilityContract,
  resolveToolsForRole,
  policyHash as hashPolicy,
  type V4CapabilityPolicy,
} from '../policy/v4-capability-policy.js'
import { V4_ERROR_CODES, V4GovernanceError } from '../policy/v4-errors.js'
import type { SnapshotStore } from '../snapshot/snapshot-store.js'
import type { CoveragePolicy } from '../snapshot/search-coverage-ledger.js'
import {
  AGENT_REVIEW_PROMPT_VERSION,
  AGENT_REVIEW_SYSTEM_PROMPT,
  buildAgentReviewPrompt,
  type AgentReviewStory,
} from '../prompts/agent-review-v1.js'
import type {
  ReviewRunner,
  ReviewRunInput,
  ReviewRunResult,
  ReviewUsage,
} from './contracts.js'
import { ReviewExecutionAbortedError, ReviewExecutionError } from './errors.js'
import {
  NullRuntimeEventReporter,
  type RuntimeEventReporterLike,
} from '../../monitoring/runtime-event-reporter.js'
import type { RuntimeEvent } from '../../monitoring/runtime-event-types.js'
import { AttemptAttributionTracker } from '../../monitoring/runtime-attribution.js'

/**
 * 平台自有工具的名字。
 *
 * V3 这里是"模型可见工具的全集"。V4 不是了：完整工具面来自角色策略，这个常量只用于
 * 区分"平台工具"和"Harness 原生工具"。
 */
export const PLATFORM_TOOL_NAMES = [
  'search_snapshot_code',
  'find_snapshot_files',
  'read_snapshot_code',
  'list_snapshot_commits',
  'submit_review_result',
] as const

/** V3 名字保留为别名：外部代码与测试仍在引用它。 */
export const AGENT_TOOL_NAMES = PLATFORM_TOOL_NAMES

/**
 * 单次 attempt 允许的恢复次数上限。
 *
 * 存在的理由是"崩溃—恢复"死循环：一个每次恢复后立刻又崩的 Session 会无限重启 Worker，
 * 而每次恢复都会重放一段历史并花掉模型预算。到达上限后按 SESSION_RECOVERY_FAILED 收场，
 * 由平台开一个干净的新 attempt。
 */
export const MAX_SESSION_RESUMES = 3

export interface DeepSeekHarnessAcpEngineOptions {
  taskId: string
  agentAttempt: number
  branch: string
  story: AgentReviewStory
  snapshots: SnapshotStore
  route: ModelRouteSpec
  /** 运维熔断前、数据库冻结快照的规范哈希；身份校验不能使用熔断后的有效策略哈希。 */
  frozenPolicyHash?: string
  /** 冻结策略经过安全归一和运维熔断后，本次 attempt 实际执行的策略。 */
  policy: V4CapabilityPolicy
  coveragePolicy: CoveragePolicy
  /** Model key, read from the vault by the worker and never written to disk. */
  apiKey: string
  /** Directory that holds per-attempt profile trees. */
  attemptsRoot: string
  /** Session JSONL 的持久卷根目录。 */
  sessionRoot: string
  workerId: string
  /** claim 时数据库给出的 fencing revision。 */
  sessionRevision?: number
  logger: Logger
  /** Web 出口需要屏蔽的平台基础设施地址。 */
  infrastructure: { supabaseUrl?: string; gitlabBaseUrl?: string }
  /** 代码缓存根与其他不可从 Workspace 触及的目录。 */
  forbiddenRoots: readonly string[]
  isLeaseValid(): boolean
  /** heartbeat 报告的取消请求。true 表示必须立即级联停止。 */
  isCancelRequested?(): boolean
  /**
   * 本次 abort 的真实原因。
   *
   * `input.signal` 只能表达"被取消了"，表达不了"为什么"。而 §7.8.6 要求把用户取消、
   * Lease 丢失和 Worker 关停区分开 —— 三者的运维含义完全不同（前者是产品行为，第二个是
   * 被别的 Worker 接管，第三个是滚动重启）。由调度侧在 abort 之前设置。
   */
  abortReason?(): AttemptEndReason
  commitReview(input: CommitReviewInput): Promise<CommitReviewResult>
  /** V4 治理面的数据库钩子。缺省时只在内存中治理（用于单测）。 */
  db?: {
    registerAgentNode(identity: AgentIdentity): Promise<void>
    markAgentTerminal(
      agentId: string,
      status: 'FINISHED' | 'FAILED' | 'CANCELLED',
      errorCode?: string,
    ): Promise<void>
    flushAudit(
      entries: ToolAuditEntry[],
      decisions: PermissionDecisionEntry[],
    ): Promise<void>
    saveArtifact(input: {
      producerAgentId: string
      artifactType: string
      workspacePath: string
      contentHash: string
      sizeBytes: number
    }): Promise<{ artifactId: string }>
    saveSessionCheckpoint(input: {
      sessionId: string
      sessionRevision: number
      storageLocator: string
      contentHash: string
      eventCount: number
      harnessVersion: string
      profileHash: string | null
    }): Promise<void>
    recordProfile(input: {
      harnessVersion: string
      capabilityContractHash: string
      profileHash: string
      policyHash: string
      rootAgentId: string
      rootSessionId: string
      treeDigest: string
    }): Promise<void>
    /**
     * 找回一个可恢复的 attempt。
     *
     * 返回 null 表示"没有可恢复的东西"（新 attempt、已提交、已封存），这是正常路径而不是
     * 故障。RPC 内部会把 session_revision 推进一格，所以返回值里的 revision 已经是
     * 本次恢复应当使用的那个。
     */
    loadResumableAttempt(): Promise<Record<string, unknown> | null>
    /**
     * 数据库侧的分层预算预留。内存账本是权威闸门，这一步是租约校验过的第二道，
     * 同时把分层计数落成可查询的真实值。
     */
    reserveBudget(
      agentId: string,
      kind: string,
      count: number,
    ): Promise<{ allowed: boolean; scope: string | null }>
    /**
     * 落真实 usage。每条终态路径都会调用，包括失败与取消 —— 那些 attempt 同样烧了模型
     * 请求，只在提交成功时记会让成本核对失真。
     */
    commitUsage(
      usage: Record<string, number | null>,
      perAgent: Array<Record<string, string | number | null>>,
    ): Promise<boolean>
    /**
     * DB fencing：把取消请求与原因落到 run 上。
     *
     * 收敛时调用，让迟到的工具调用、usage 上报和提交在 RPC 层被拒。对已提交或已封存的
     * attempt 是 no-op。
     */
    requestAttemptCancel(reason: string): Promise<boolean>
  }
  /** 检出固定 Commit 到只读视图。缺省时跳过物化（单测）。 */
  checkoutPinned?(input: { gitDir: string; commitSha: string; targetDir: string }): void
  /** Injected in tests to avoid spawning a real Harness process. */
  startProcess?: typeof startAcpProcess
  runTurn?: typeof runSingleAcpTurn
  /**
   * 运行监控事件上报（V1.5）。缺省等价于关闭：所有插桩点走 NullRuntimeEventReporter，
   * 现有分析流程一字不改。
   */
  runtimeEvents?: RuntimeEventReporterLike
  /** attempt 归因日志需要的 Job 上下文。缺省时日志里这些字段为 null。 */
  runtimeContext?: {
    jobId?: string | null
    batchId?: string | null
    agentRunId?: string | null
    harnessVersionFrozen?: string | null
    capabilityContractHashFrozen?: string | null
    policyVersion?: number | null
  }
}

export class DeepSeekHarnessAcpEngine implements ReviewRunner {
  constructor(private readonly options: DeepSeekHarnessAcpEngineOptions) {}

  async runReview(input: ReviewRunInput): Promise<ReviewRunResult> {
    const policy = this.options.policy
    const effectivePolicyHash = hashPolicy(policy)
    const policyHash = this.options.frozenPolicyHash ?? effectivePolicyHash
    const log = input.logger.child({
      engine: 'deepseek-harness-acp',
      prompt_version: AGENT_REVIEW_PROMPT_VERSION,
      policy_version: policy.version,
    })

    if (input.signal.aborted) throw new ReviewExecutionAbortedError()

    // ---- 运行监控插桩 ------------------------------------------------------
    //
    // 事件同时进两条通道：Reporter（落数据库，供人的监控台增量拉取）与 Tracker
    // （进程内独立算归因，随终态落一行 attempt_rollup 日志，作为数据库汇总失败时的
    // 备份通道）。两条通道共用同一份事实，所以不会出现"界面说正常、日志说有问题"。
    const events = this.options.runtimeEvents ?? new NullRuntimeEventReporter()
    const attribution = new AttemptAttributionTracker()
    const attemptStartedMs = Date.now()
    attribution.observeAttemptStarted(attemptStartedMs)
    /** 观测 fail open：插桩绝不改变业务结果。 */
    const emit = (event: RuntimeEvent): void => {
      try {
        attribution.observe(event)
        events.report(event)
      } catch {
        // 监控失败不能放宽权限、预算、root-only、证据或 lease 校验。
      }
    }

    // Fail before spawning anything if a pinned commit is not present locally.
    const pinsStartedMs = Date.now()
    await this.options.snapshots.verifyPins()
    emit({
      type: 'PINS_VERIFIED',
      payload: { duration_ms: Date.now() - pinsStartedMs },
      durationMs: Date.now() - pinsStartedMs,
    })

    const identity = mintRootIdentity(this.options.taskId, this.options.agentAttempt)
    const authority = new AgentAuthorityLedger({
      taskId: this.options.taskId,
      agentAttempt: this.options.agentAttempt,
      policy,
      rootAgentId: identity.rootAgentId,
      rootSessionId: identity.rootSessionId,
      persistNode: this.options.db
        ? (node) => {
            // Agent 注册成功的时刻就是 agent_idle_ms 窗口的起点。用 persistNode 而不是
            // 事件流：AGENT_REGISTERED 由数据库触发器原子写（数据库是 lineage 的唯一
            // 仲裁），Worker 侧看不到那条事件。
            attribution.observeAgentRegistered(node.agentId)
            return this.options.db!.registerAgentNode(node)
          }
        : undefined,
    })
    const budget = new HierarchicalBudgetLedger({
      policy,
      // 数据库侧的第二道预算闸门。内存账本仍是权威（同步、无往返，能在 provider 调用前
      // 原子拦截）；这一步按 claim token 与租约校验调用方，所以一个已被接管的旧 Worker 的
      // 预留会失败，正是"迟到的 usage 不能算进新 attempt"所需的 fencing。
      onReserved: this.options.db
        ? (reserved) => {
            void this.options.db!.reserveBudget(reserved.agentId, reserved.kind, reserved.count)
              .then((verdict) => {
                if (!verdict.allowed) {
                  this.options.logger.info('agent_budget_reserve_rejected_by_db', {
                    event: 'agent_budget_reserve_rejected_by_db',
                    agent_id: reserved.agentId,
                    kind: reserved.kind,
                    scope: verdict.scope,
                  })
                }
              })
              .catch(() => undefined)
          }
        : undefined,
    })

    let broker: AttemptControlHandle | null = null
    let profile: MaterializedAttemptProfile | null = null
    let child: AcpProcessHandle | null = null
    let workspace: AttemptWorkspace | null = null
    let sessionSlot: ReturnType<SessionRegistry['acquire']> | null = null
    let controller: AttemptTreeController | null = null
    const socketRoot = mkdtempSync(join(tmpdir(), 'crp-broker-'))
    // Harness 侧的取消入口。abort 它会让 ACP 客户端发 session/cancel，Harness 据此取消当前
    // turn，连带它的 Workflow 步骤、子 Agent 和 Jobs。调度侧的 input.signal 会转发到这里，
    // controller 的 cancelWorkflows 也用它 —— 两条路径共用同一个入口，不会各喊各的。
    const harnessAbort = new AbortController()
    // Agent 侧观测到的工具调用（含未到达 Broker 的），turn 抛错时也可用。
    const agentToolCalls: Record<string, number> = {}
    let endReason: AttemptEndReason = 'ATTEMPT_FAILED'
    /** 终态稳定错误码。attempt_rollup 日志与数据库汇总用同一个值。 */
    let terminalErrorCode: string | null = null
    // fencing revision。恢复时由数据库推进，否则是本次 attempt claim 时的初值。
    let sessionRevision = this.options.sessionRevision ?? 1

    try {
      const sessionRegistry = new SessionRegistry({
        root: this.options.sessionRoot,
        taskId: this.options.taskId,
        agentAttempt: this.options.agentAttempt,
        workerId: this.options.workerId,
        logger: log,
      })
      sessionSlot = sessionRegistry.acquire()
      emit({ type: 'SESSION_SLOT_ACQUIRED', payload: {} })

      const workspaceStartedMs = Date.now()
      workspace = AttemptWorkspace.create({
        attemptsRoot: this.options.attemptsRoot,
        // 目录名按 task+attempt 确定性派生：Harness 的 session/resume 校验 cwd 一致性。
        taskId: this.options.taskId,
        agentAttempt: this.options.agentAttempt,
        policy,
        logger: log,
        pinnedRepositories: this.options.snapshots.pins(),
        forbiddenRoots: [
          ...this.options.forbiddenRoots,
          socketRoot,
          this.options.sessionRoot,
        ],
      })

      // 固定 Commit 物化成只读视图。Agent 需要工作树才能跑构建；只读保证它无法污染证据源。
      if (this.options.checkoutPinned) {
        for (const pin of this.options.snapshots.pins()) {
          workspace.materializeReadOnly(pin.repository, this.options.checkoutPinned)
        }
      }
      // 同步调用，没有 await 间隙可插"开始"，所以只报完成（方案 §6.3）。
      emit({
        type: 'WORKSPACE_READY',
        payload: { duration_ms: Date.now() - workspaceStartedMs },
        durationMs: Date.now() - workspaceStartedMs,
      })

      const persistCollectedArtifacts = async (): Promise<void> => {
        if (!this.options.db || !workspace) return
        for (const artifact of workspace.collectArtifacts()) {
          await this.options.db
            .saveArtifact({
              producerAgentId: identity.rootAgentId,
              artifactType: inferArtifactType(artifact.relativePath),
              workspacePath: artifact.relativePath,
              contentHash: artifact.contentHash,
              sizeBytes: artifact.sizeBytes,
            })
            .catch((err) =>
              log.error('save_artifact_failed', {
                event: 'save_artifact_failed',
                workspace_path: artifact.relativePath,
                error_message: redactError(err),
              }),
            )
        }
      }

      const egress = new EgressPolicy({
        policy: policy.web,
        logger: log,
        blockedHosts: platformBlockedHosts({
          supabaseUrl: this.options.infrastructure.supabaseUrl,
          gitlabBaseUrl: this.options.infrastructure.gitlabBaseUrl,
        }),
      })

      broker = await startAttemptControlBroker({
        taskId: this.options.taskId,
        agentAttempt: this.options.agentAttempt,
        snapshots: this.options.snapshots,
        coveragePolicy: this.options.coveragePolicy,
        socketRoot,
        logger: log,
        policy,
        policyHash,
        authority,
        budget,
        egress,
        workspace,
        commitReview: async (review) => {
          // save_agent_review_result 会烧毁 task claim。usage、分 Agent 计量和自动扫描到的
          // Artifact 都依赖该 claim，必须在正式提交前完成；失败/取消路径仍由 finally 兜底。
          if (this.options.db) {
            const usageCommitted = await this.options.db.commitUsage(
              usageForDatabase(review.usage),
              perAgentUsageForDatabase(review.usage),
            )
            if (!usageCommitted) {
              const error = new Error('task lease was lost before review submission')
              Object.assign(error, { code: 'TASK_LEASE_LOST' })
              throw error
            }
          }
          await persistCollectedArtifacts()
          return this.options.commitReview(review)
        },
        isLeaseValid: this.options.isLeaseValid,
        // 子节点落库由 ledger 的 persistNode 唯一负责（先落库、再铸令牌）。这里不再重复
        // 传一遍：同一次注册写两次 register_analysis_agent_node，虽然 RPC 幂等，但等于把
        // "谁是 lineage 的唯一仲裁者"这件事说成了两个人。
        markAgentTerminal: this.options.db
          ? (agentId, status, errorCode) =>
              this.options.db!.markAgentTerminal(agentId, status, errorCode)
          : undefined,
        flushAudit: this.options.db
          ? (entries, decisions) => this.options.db!.flushAudit(entries, decisions)
          : undefined,
        saveArtifact: this.options.db
          ? (artifact) => this.options.db!.saveArtifact(artifact)
          : undefined,
        // 插件侧的工具/模型生命周期经现有路由的请求体扩展抵达这里，再转投 Reporter。
        reportRuntimeEvent: emit,
      })
      // Unix socket 已在监听：这是明确的 await 边界。
      emit({ type: 'BROKER_READY', payload: {} })

      profile = materializeAttemptProfile({
        taskId: this.options.taskId,
        agentAttempt: this.options.agentAttempt,
        attemptsRoot: this.options.attemptsRoot,
        route: this.options.route,
        policy,
        identity: {
          rootAgentId: identity.rootAgentId,
          rootSessionId: identity.rootSessionId,
        },
        cwd: workspace.cwd,
        sessionRoot: sessionSlot.sessionRoot,
        broker: {
          socketPath: broker.socketPath,
          requestTimeoutMs: this.options.route.requestTimeoutMs,
        },
        repositories: this.options.snapshots
          .pins()
          .map((pin) => pin.repository as RepositoryName),
      })

      // 契约校验：root 的工具面必须正好等于 policy 规定的集合。多一个是 Harness 悄悄加了
      // 东西，少一个是 profile 被改坏；两者都 fail closed，而不是让它进模型上下文。
      const rootTools = resolveToolsForRole({
        role: 'root-reviewer',
        policy,
        delegationDepth: 0,
      })
      assertResolvedInventory({
        role: 'root-reviewer',
        resolved: profile.rootTools,
        policy,
        delegationDepth: 0,
        contract: loadCapabilityContract(),
      })

      broker.setConfigHash(profile.configHash)
      // Profile/contract 身份是提交链路的数据库锚点，记录失败必须 fail closed。继续运行会让
      // 最终提交只能依赖 Broker，绕过 DB 的 root-only 与契约漂移校验。
      await this.options.db?.recordProfile({
        harnessVersion: loadCapabilityContract().harnessVersion,
        capabilityContractHash: contractHash(loadCapabilityContract()),
        profileHash: profile.configHash,
        policyHash,
        rootAgentId: identity.rootAgentId,
        rootSessionId: identity.rootSessionId,
        treeDigest: authority.treeDigest(),
      })
      // 落库成功才算冻结：recordProfile 失败时上面已经抛出，不会走到这里。
      emit({ type: 'PROFILE_FROZEN', payload: {} })
      // 根节点由平台创建，不经过模型的 register_agent 路由，因此必须在启动 Harness 前
      // 显式持久化。只有数据库确认 root identity 后，进程才获得执行机会。
      await this.options.db?.registerAgentNode(authority.root)
      attribution.observeAgentRegistered(authority.root.agentId)

      log.info('agent_attempt_started', {
        event: 'agent_attempt_started',
        config_hash: profile.configHash,
        contract_hash: profile.contractHash,
        policy_hash: policyHash,
        effective_policy_hash: effectivePolicyHash,
        root_agent_id: identity.rootAgentId,
        root_tools: rootTools.length,
        max_agents: policy.agents.maxAgentsPerAttempt,
        max_depth: policy.agents.maxDelegationDepth,
        max_parallel_tools: policy.parallelTools.maxPerStep,
        session_root: sessionSlot.sessionRoot,
      })

      const startProcess = this.options.startProcess ?? startAcpProcess
      child = startProcess({
        dshHome: profile.dshHome,
        profileName: profile.profileName,
        patchPath: profile.patchPath,
        cwd: workspace.cwd,
        apiKeyEnvVar: this.options.route.apiKeyEnvVar,
        apiKey: this.options.apiKey,
        // Broker 凭据只经环境变量下传，attempt patch 文件里没有它们：patch 与 Sandbox
        // Shell 同属一个 OS 用户，而 workspace-write 沙箱只限制写不限制读。变量名命中
        // Harness 的凭据剥离规则，所以模型可见的 Shell 拿不到它们。
        brokerToken: broker.token,
        rootCapability: authority.rootCapabilityToken,
        // dsh 进程的非机密环境；Harness 在 spawn Shell 前会重建环境并剥掉凭据类变量名。
        extraEnv: workspace.shellSpec().env,
        // rlimit 由后代继承，所以设在 dsh 上就等于设在 Shell 与 Jobs 起的每个进程上。
        ulimits: workspace.shellSpec().limits,
      })
      // 同步 spawn：只报完成。它同时是 setup_ms 的右边界（方案 §6.9.2）。
      emit({ type: 'HARNESS_PROCESS_STARTED', payload: {} })

      // ---- Session 恢复判定 -------------------------------------------------
      //
      // 必须在起 turn 之前决定，因为"新建会话"和"继续会话"是两条不同的 ACP 调用。
      //
      // 判定失败时**不静默降级为新建会话**：那会让 Worker 重启后看起来恢复了，其实从零
      // 开始 —— 长任务的 Todo、Goal 和已完成的取证全部白做，而且平台无从察觉。所以格式
      // 不兼容、日志 torn、被别的写者改过这三种情况都终止本次 attempt，由平台开新 attempt。
      let resumeSessionId: string | undefined
      const resume = await this.resolveResume(profile.configHash, policyHash, log)
      if (resume.decision.code !== null) {
        throw new V4GovernanceError(
          resume.decision.code as never,
          `session recovery refused: ${resume.decision.reason}`,
        )
      }
      if (resume.decision.resume && resume.decision.session) {
        resumeSessionId = resume.decision.session.sessionId
        sessionRevision = resume.decision.session.sessionRevision
        broker.setSessionRevision(sessionRevision)
        emit({
          type: 'SESSION_RESUMED',
          payload: { session_revision: sessionRevision, resumed: true },
        })
        log.info('agent_attempt_resuming_session', {
          event: 'agent_attempt_resuming_session',
          session_revision: sessionRevision,
          resume_count: resume.candidate?.resumeCount ?? 0,
        })
      }

      const spawnedChild = child
      controller = new AttemptTreeController({
        ledger: authority,
        logger: log,
        markNodeTerminal: this.options.db
          ? (agentId, status, errorCode) => {
              attribution.observeAgentTerminal(agentId)
              return this.options.db!.markAgentTerminal(agentId, status, errorCode)
            }
          : null,
        // Workflow / 子 Agent / Jobs 都由 Harness 在进程内持有，平台唯一的合作式取消入口
        // 是让 ACP 客户端发 session/cancel —— abort 这个 controller 正是这个动作。
        cancelWorkflows: async () => {
          harnessAbort.abort()
        },
        // 平台没有 Harness Job 清单可枚举，见 AttemptTreeControllerOptions.jobs 的说明：
        // Job 进程由下面的 reaper 按进程组兜底回收。
        jobs: null,
        reaper: { reap: () => spawnedChild.reapProcessTree() },
        // 真正的 DB fencing：把 cancel_requested_at 与 cancel_reason 落到 run 上，之后所有
        // 迟到的工具调用、usage 上报和提交在 RPC 层就被拒。对已提交/已封存的 attempt 是
        // no-op（RPC 只更新 status='RUNNING' and sealed_at is null 的行）。
        fence: this.options.db
          ? async (reason) => {
              await this.options.db!.requestAttemptCancel(reason)
            }
          : null,
      })

      const revokeOnAbort = () => {
        broker?.revoke('the attempt was cancelled')
        // 先直接告诉 Harness 停：session/cancel 必须立刻发出，不能等 drain 走完令牌撤销和
        // 数据库写入 —— 那几步是网络往返，期间模型还在烧预算。drain 里的 cancelWorkflows
        // 服务的是"不是由这个 signal 触发"的收敛（提交成功、attempt 失败）。abort 幂等。
        harnessAbort.abort()
        // 取消原因由调度侧在 abort 之前告知（lease 丢失 / Worker 关停 / 用户取消），
        // 三者在审计里必须分得开：文档 §7.8.6 要求区分这些触发条件。
        void controller?.drain(this.options.abortReason?.() ?? 'USER_CANCELLED')
      }
      input.signal.addEventListener('abort', revokeOnAbort, { once: true })

      const runTurn = this.options.runTurn ?? runSingleAcpTurn
      let turn
      try {
        emit({ type: 'ACP_TURN_STARTED', payload: {} })
        turn = await runTurn(
          {
            process: child,
            cwd: workspace.cwd,
            // 权限面来自角色策略，不再是固定五个工具。
            permittedTools: [...rootTools],
            onToolCall: (name) => {
              agentToolCalls[name] = (agentToolCalls[name] ?? 0) + 1
            },
            onPermissionDecision: (decision) => {
              if (!decision.allowed) {
                log.info('acp_permission_denied', {
                  event: 'acp_permission_denied',
                  tool_name: decision.toolName,
                  outcome: decision.outcome,
                })
              }
            },
            resumeSessionId,
          },
          this.prompt(rootTools.length),
          // 用 harnessAbort 而不是 input.signal：controller 的 cancelWorkflows 也要能触发
          // session/cancel，所以取消入口必须是引擎自己持有的那一个。
          harnessAbort.signal,
        )
      } finally {
        input.signal.removeEventListener('abort', revokeOnAbort)
      }

      const committed = broker.committed()

      // 提交路径已在 commitReview wrapper 中、claim 仍有效时登记 Artifact；未提交路径
      // 仍在 turn 结束后扫描，保留失败 attempt 产生的补丁和构建日志。
      if (committed === null) await persistCollectedArtifacts()

      // Session checkpoint 只服务于“未提交 attempt 的重启恢复”。成功提交已经烧毁 claim，
      // 再写必然 TASK_LEASE_LOST，而且已提交会话永远不应恢复。
      if (committed === null && sessionSlot && this.options.db) {
        // 路径由 registry 在持久卷上实际找到，不是拼出来的。
        const location = sessionSlot.locate(turn.sessionId)
        const described = location === null ? null : sessionRegistry.describe(location)
        if (described === null) {
          // 会话没落盘就没有可恢复的东西。这不是故障（例如 turn 在第一次持久化之前就结束），
          // 但必须记下来：它同时意味着“这次 attempt 重启后只能从零开始”。
          log.info('session_checkpoint_skipped', {
            event: 'session_checkpoint_skipped',
            session_id: turn.sessionId,
            reason: 'no session log found on the persistent volume',
          })
        }
        if (described) {
          await this.options.db
            .saveSessionCheckpoint({
              sessionId: turn.sessionId,
              sessionRevision,
              storageLocator: described.storageLocator,
              contentHash: described.contentHash,
              eventCount: described.eventCount,
              // 兼容键 = Harness 包版本 + 会话格式版本，由 sessionCompatibilityKey 统一
              // 构造。恢复判定用的是同一个函数，两侧不可能再拼出不同形状。
              harnessVersion: sessionCompatibilityKey({
                harnessVersion: loadCapabilityContract().harnessVersion,
                sessionFormatVersion: described.formatVersion,
              }),
              profileHash: profile.configHash,
            })
            .catch((err) =>
              log.error('session_checkpoint_failed', {
                event: 'session_checkpoint_failed',
                error_message: redactError(err),
              }),
            )
        }
      }

      const usage = this.usage(broker)
      const brokerUsage = broker.usage()

      log.info('agent_attempt_finished', {
        event: 'agent_attempt_finished',
        stop_reason: turn.stopReason,
        tool_names: turn.toolNames,
        committed: committed !== null,
        resumed: turn.resumed,
        model_requests: brokerUsage.modelRequests,
        root_model_requests: brokerUsage.rootModelRequests,
        child_model_requests: brokerUsage.childModelRequests,
        // 分项计量必须出现在这条日志里，否则"compaction usage 纳入预算和审计"（§7.6-8）
        // 在运维视角是不可验证的：总数看不出预算是花在评审上还是花在反复压缩上。
        retry_requests: brokerUsage.retryRequests,
        compaction_requests: brokerUsage.compactionRequests,
        ralph_rounds: brokerUsage.ralphRounds,
        input_tokens: brokerUsage.inputTokens,
        output_tokens: brokerUsage.outputTokens,
        agent_count: authority.totalCount(),
        max_depth_reached: authority.maxDepthReached(),
        tree_digest: authority.treeDigest(),
        // 预算去向的分解：按工具分桶 + 提交被拒的错误码序列。
        tool_calls_by_name: brokerUsage.toolCallsByName,
        rejected_submissions: brokerUsage.rejectedSubmissions,
        // 列表有上界，总数没有：只看列表会低估一个反复冲撞提交权的子 Agent。
        rejected_submission_total: brokerUsage.rejectedSubmissionTotal,
        evidence_shown: brokerUsage.evidenceShown,
        searches_run: brokerUsage.searchesRun,
        web_requests: brokerUsage.webRequests,
        workspace_bytes: workspace.usage().bytes,
      })

      if (!committed) {
        // 这条分支同样需要子进程 stderr：turn 以 cancelled/end_turn 收场却没有提交时，
        // 原因几乎只存在于 Harness 侧（插件加载失败、provider 解析不到、权限被拒），
        // 而它不是异常，不会走下面的 catch。缺了这行日志，这类失败在平台侧无迹可寻。
        const stderr = child.stderr()
        log.error('agent_attempt_no_submission', {
          event: 'agent_attempt_no_submission',
          stop_reason: turn.stopReason,
          tool_names: turn.toolNames,
          model_requests: brokerUsage.modelRequests,
          tool_calls_by_name: brokerUsage.toolCallsByName,
          rejected_submissions: brokerUsage.rejectedSubmissions,
          // 列表有上界，总数没有：只看列表会低估一个反复冲撞提交权的子 Agent。
          rejected_submission_total: brokerUsage.rejectedSubmissionTotal,
          evidence_shown: brokerUsage.evidenceShown,
          searches_run: brokerUsage.searchesRun,
          agent_count: authority.totalCount(),
          // 协议层错误走 JSON-RPC 不走 stderr，两者都要记。
          prompt_error: turn.promptError,
          child_stderr_bytes: stderr.length,
          child_stderr_tail: stderr === '' ? null : redactError(tailOf(stderr, 4000)),
        })

        // 预算耗尽必须报成自己：`usage-reporter` 是把拒绝作为 chunk 交给模型的（这样模型能
        // 看懂并停下），所以引擎这边收到的只是"turn 结束了但没提交"。若就这么报出去，
        // 运维看到的是 AGENT_NO_SUBMISSION，而真实原因是撞了预算上限 —— 方案 §7.6-9 要求
        // "预算耗尽…返回稳定错误码"，§7.8.6 也把它列为独立的收敛触发。
        const budgetDenied = brokerUsage.deniedModelRequests > 0
        endReason = budgetDenied ? 'BUDGET_EXHAUSTED' : 'ATTEMPT_FAILED'
        terminalErrorCode = budgetDenied
          ? V4_ERROR_CODES.MODEL_BUDGET_EXHAUSTED
          : turn.stopReason === 'end_turn'
            ? 'AGENT_NO_SUBMISSION'
            : 'AGENT_TURN_INCOMPLETE'
        return {
          taskId: this.options.taskId,
          storyCode: this.options.story.code,
          ok: false,
          errorCode: budgetDenied
            ? V4_ERROR_CODES.MODEL_BUDGET_EXHAUSTED
            : turn.stopReason === 'end_turn'
              ? 'AGENT_NO_SUBMISSION'
              : 'AGENT_TURN_INCOMPLETE',
          errorMessage: budgetDenied
            ? `the model-request budget was exhausted after ${String(brokerUsage.modelRequests)} requests; ` +
              `${String(brokerUsage.deniedModelRequests)} further request(s) were refused before reaching the provider`
            : `agent turn ended as ${turn.stopReason} without committing a review result`,
          usage,
        }
      }

      endReason = 'COMMITTED'
      terminalErrorCode = null
      return {
        taskId: this.options.taskId,
        storyCode: this.options.story.code,
        ok: true,
        usage,
      }
    } catch (err) {
      const rawCode =
        err instanceof V4GovernanceError
          ? err.code
          : err instanceof ReviewExecutionError
            ? err.code
            : ((err as { code?: string })?.code ?? 'AGENT_ATTEMPT_FAILED')
      // 预算耗尽会以各种面目抛出来。
      //
      // `usage-reporter` 把预算拒绝作为 chunk 交给模型（这样模型能看懂并停下），Harness 随后
      // 可能把它变成一个 JSON-RPC 内部错误 —— 实测拿到的 code 是 `-32603`，和"预算"两个字
      // 毫无关系。若照原样报出去，运维看到的是一个匿名协议错误，而真实原因是撞了模型预算上限。
      //
      // 所以只要账本记到过因预算被拒的请求，就以 `MODEL_BUDGET_EXHAUSTED` 为准 —— 账本里三处
      // `denied++` 全部返回这个码，信号是干净的。方案 §7.6-9 要求"预算耗尽…返回稳定错误码"，
      // §7.8.6 也把它列为独立的收敛触发。
      const budgetDenied = (broker?.usage().deniedModelRequests ?? 0) > 0
      // 取消也必须报成自己。
      //
      // 三种取消触发（用户取消 / 租约丢失 / Worker 关停）此前都落到 `AGENT_ATTEMPT_FAILED`，
      // 于是**数据库与界面上取消和崩溃长得一模一样**。方案 §9 为此定义了稳定码
      // `AGENT_TREE_CANCELLED`；具体是哪一种触发由 `attempt_drained` 的 reason 和数据库里的
      // `cancel_reason` 区分，错误码只需要说清"这是被取消的，不是挂了"。
      const cancelled =
        !budgetDenied &&
        (rawCode === V4_ERROR_CODES.AGENT_TREE_CANCELLED || input.signal.aborted)
      const code = budgetDenied
        ? V4_ERROR_CODES.MODEL_BUDGET_EXHAUSTED
        : cancelled
          ? V4_ERROR_CODES.AGENT_TREE_CANCELLED
          : rawCode
      const message = budgetDenied
        ? `the model-request budget was exhausted; ${String(
            broker?.usage().deniedModelRequests ?? 0,
          )} request(s) were refused before reaching the provider (underlying error: ${redactError(err)})`
        : cancelled
          ? `the attempt was cancelled (${this.options.abortReason?.() ?? 'USER_CANCELLED'}): ${redactError(err)}`
          : redactError(err)
      // 取消类失败的真实原因来自调度侧：用户取消、Lease 被别的 Worker 接管、Worker 关停，
      // 三者都会 abort 同一个 signal，但运维含义完全不同。abortReason 没给才回落到
      // USER_CANCELLED。
      endReason =
        code === V4_ERROR_CODES.MODEL_BUDGET_EXHAUSTED
          ? 'BUDGET_EXHAUSTED'
          : code === V4_ERROR_CODES.AGENT_TREE_CANCELLED
            ? (this.options.abortReason?.() ?? 'USER_CANCELLED')
            : code === V4_ERROR_CODES.SESSION_FENCED ||
                code === V4_ERROR_CODES.SESSION_RECOVERY_FAILED ||
                code === V4_ERROR_CODES.SESSION_FORMAT_UNSUPPORTED
              ? 'SESSION_UNRECOVERABLE'
              : input.signal.aborted
                ? (this.options.abortReason?.() ?? 'USER_CANCELLED')
                : 'ATTEMPT_FAILED'
      terminalErrorCode = code

      // 子进程 stderr 是唯一能说明"模型/适配器到底报了什么"的来源。以前这里只记
      // 字节数，等于把它扔了：一次 attempt 失败在平台侧完全不可诊断。这里记录经过
      // 脱敏的尾部内容，并同时带上已发生的工具调用，好区分"模型没调工具"和
      // "工具一直失败"。
      const stderr = child?.stderr() ?? ''
      const failureUsage = broker?.usage() ?? null
      log.error('agent_attempt_failed', {
        event: 'agent_attempt_failed',
        error_code: code,
        error_message: message,
        child_stderr_bytes: stderr.length,
        child_stderr_tail: stderr === '' ? null : redactError(tailOf(stderr, 4000)),
        broker_tool_calls: failureUsage?.toolCalls ?? 0,
        broker_evidence_shown: failureUsage?.evidenceShown ?? 0,
        // 预算耗尽走的正是这条路径，分解必须在这里也有。
        model_requests: failureUsage?.modelRequests ?? 0,
        tool_calls_by_name: failureUsage?.toolCallsByName ?? {},
        rejected_submissions: failureUsage?.rejectedSubmissions ?? [],
        rejected_submission_total: failureUsage?.rejectedSubmissionTotal ?? 0,
        searches_run: failureUsage?.searchesRun ?? 0,
        agent_count: authority.totalCount(),
        // Agent 侧计数与 Broker 侧对不上，说明有工具调用没走到 Worker。
        agent_tool_calls: { ...agentToolCalls },
      })
      return {
        taskId: this.options.taskId,
        storyCode: this.options.story.code,
        ok: false,
        errorCode: code,
        errorMessage: message,
        usage: broker ? this.usage(broker) : undefined,
      }
    } finally {
      // 成功路径在 submit_review_result 烧毁 claim 前已经落 usage；失败、取消、预算耗尽
      // 没有提交入口，仍由这里记录真实消耗。RPC 单调更新，重试安全。
      if (broker && this.options.db && broker.committed() === null) {
        const finalUsage = broker.usage()
        await this.options.db
          .commitUsage(usageForDatabase(finalUsage), perAgentUsageForDatabase(finalUsage))
          .catch((err) =>
            log.error('commit_agent_usage_failed', {
              event: 'commit_agent_usage_failed',
              error_message: redactError(err),
            }),
          )
      }

      // 收敛顺序在 controller 里，这里只负责把它跑完并处理"进程没回收干净"这一种情况。
      const drained = controller
        ? await controller.drain(endReason).catch(() => null)
        : null
      if (drained?.cleanupFailed) {
        log.error('process_tree_cleanup_failed', {
          event: 'process_tree_cleanup_failed',
          error_code: V4_ERROR_CODES.PROCESS_TREE_CLEANUP_FAILED,
          surviving_pids: drained.survivingPids.length,
        })
        emit({
          type: 'PROCESS_TREE_CLEANUP_FAILED',
          errorCode: V4_ERROR_CODES.PROCESS_TREE_CLEANUP_FAILED,
          payload: { reason_code: 'PROCESS_TREE_CLEANUP_FAILED' },
        })
      }

      // ---- 观测收敛 ---------------------------------------------------------
      //
      // 必须在返回之前完成：调用方随后会走 save_agent_review_result / fail_agent_review，
      // 后者会推进 session_revision，之后本 attempt 的任何事件写入都会被 §6.4.1 的
      // fencing 正确拒绝。所以"尽力 flush 一次"的时机就是这里。
      const reporterStats = events.snapshot()
      emit({
        type: 'ATTEMPT_INSTRUMENTATION_REPORTED',
        payload: {
          events_reported: reporterStats.reported,
          events_dropped: reporterStats.dropped,
        },
      })
      await events.flush().catch(() => undefined)

      const finalReporterStats = events.snapshot()
      const finalBrokerUsage = broker?.usage() ?? null
      const committedAtEnd = broker?.committed() ?? null
      const contract = loadCapabilityContract()
      // 自包含的归因日志。它不依赖数据库汇总成功、不依赖事件还没被 30 天保留期清掉，
      // 字段名与 analysis_agent_run_rollup 的列名逐字一致（方案 §13.1）。
      const rollup = attribution.summarize({
        agent_run_id: this.options.runtimeContext?.agentRunId ?? null,
        task_id: this.options.taskId,
        job_id: this.options.runtimeContext?.jobId ?? null,
        batch_id: this.options.runtimeContext?.batchId ?? null,
        agent_attempt: this.options.agentAttempt,
        worker_id: this.options.workerId,
        terminal_status: committedAtEnd !== null ? 'COMMITTED' : 'FAILED',
        terminal_error_code: terminalErrorCode,
        end_reason: endReason === 'COMMITTED' ? null : endReason,
        resumed: sessionRevision > (this.options.sessionRevision ?? 1),
        resume_count: Math.max(0, sessionRevision - (this.options.sessionRevision ?? 1)),
        fingerprint: {
          model_label: this.options.route.displayName,
          policy_hash: policyHash,
          profile_config_hash: profile?.configHash ?? null,
          harness_version: contract.harnessVersion,
          capability_contract_hash: contractHash(contract),
          prompt_version: AGENT_REVIEW_PROMPT_VERSION,
          policy_version: policy.version,
        },
        agent_count: authority.totalCount(),
        max_depth: authority.maxDepthReached(),
        input_tokens: finalBrokerUsage?.inputTokens ?? null,
        output_tokens: finalBrokerUsage?.outputTokens ?? null,
        evidence_count: null,
        artifact_count: workspace?.collectArtifacts().length ?? 0,
        rejected_submissions: finalBrokerUsage?.rejectedSubmissionTotal ?? 0,
        reporter: finalReporterStats,
        finishedAtMs: Date.now(),
      })
      log.info('attempt_rollup', {
        ...rollup,
        job_id: rollup.job_id ?? undefined,
        batch_id: rollup.batch_id ?? undefined,
        open_correlations_at_end: attribution.openCorrelationCount(),
      })

      // 交叉校验：Agent 侧观测到的工具调用与插件上报的生命周期数对不上，说明
      // tools/pre-execute 漏了、或者上报被丢。只用它发现问题，不用它补数据（§7.7）。
      for (const [toolName, observed] of Object.entries(agentToolCalls)) {
        const reported = rollup.tool_calls_by_name[toolName] ?? 0
        if (reported < observed) {
          log.warn('runtime_event_tool_drift', {
            event: 'runtime_event_tool_drift',
            tool_name: toolName,
            observed,
            reported,
          })
        }
      }

      broker?.revoke('the attempt has finished')
      if (child) {
        await child.terminate().catch(() => undefined)
      }
      await broker?.close().catch(() => undefined)
      profile?.cleanup()
      // Workspace 在 Session 之后清：Session 在持久卷上，由保留期回收，不在这里删。
      workspace?.dispose()
      sessionSlot?.release()
      rmSync(socketRoot, { recursive: true, force: true })
    }
  }

  /**
   * 判定这次 attempt 是否应当继续一个既有 Session。
   *
   * 数据库先回答"有没有一个可恢复的 checkpoint"（它同时负责 fencing：已提交、已封存、
   * 已请求取消的 attempt 一律返回 null），然后本地纯函数回答"这个 checkpoint 现在还能安全
   * 重放吗"。两步分开是因为它们的依据不同：前者是租约与提交状态，后者是磁盘上的字节。
   */
  private async resolveResume(
    profileHash: string,
    policyHash: string,
    log: Logger,
  ): Promise<{ decision: ResumeDecision; candidate: ResumeCandidate | null }> {
    if (!this.options.db || !this.options.policy.capabilities.sessionResume) {
      return {
        decision: { resume: false, code: null, reason: 'session resume is not enabled' },
        candidate: null,
      }
    }
    const row = await this.options.db.loadResumableAttempt().catch((err) => {
      // 查询失败不等于"不可恢复"，但也不能因此拒绝启动：按新会话继续，并把原因记下来。
      log.error('load_resumable_attempt_failed', {
        event: 'load_resumable_attempt_failed',
        error_message: redactError(err),
      })
      return null
    })
    if (row === null) {
      return {
        decision: { resume: false, code: null, reason: 'no resumable checkpoint for this attempt' },
        candidate: null,
      }
    }

    const candidate: ResumeCandidate = {
      agentRunId: String(row.agent_run_id ?? ''),
      rootAgentId: (row.root_agent_id as string | null) ?? null,
      rootSessionId: (row.root_session_id as string | null) ?? null,
      sessionId: String(row.session_id ?? ''),
      sessionRevision: Number(row.session_revision ?? 1),
      storageLocator: String(row.storage_locator ?? ''),
      contentHash: String(row.content_hash ?? ''),
      harnessVersion: String(row.harness_version ?? ''),
      profileHash: (row.profile_hash as string | null) ?? null,
      policyHash: (row.policy_hash as string | null) ?? null,
      resumeCount: Number(row.resume_count ?? 0),
      // checkpoint 里记的 harness_version 是兼容键，形如 `0.1.5-rc.1/v3`；压缩形态从
      // locator 后缀判断。
      compressed: String(row.storage_locator ?? '').endsWith('.zstd'),
    }
    // 当前 Worker 的兼容键：包版本来自契约，格式版本来自这份日志的文件名。认不出文件名
    // 时给出一个不可能匹配的值，让 evaluateResume 走 SESSION_FORMAT_UNSUPPORTED。
    const candidateFormat = sessionFormatVersionFromPath(candidate.storageLocator)
    const decision = evaluateResume({
      candidate,
      harnessVersion:
        candidateFormat === null
          ? 'unrecognized-session-log'
          : sessionCompatibilityKey({
              harnessVersion: loadCapabilityContract().harnessVersion,
              sessionFormatVersion: candidateFormat,
            }),
      policyHash,
      // 走到这里说明数据库没有 receipt：它对已提交的 attempt 返回 null。
      alreadyCommitted: false,
      maxResumes: MAX_SESSION_RESUMES,
    })
    if (!decision.resume) {
      log.info('agent_attempt_resume_declined', {
        event: 'agent_attempt_resume_declined',
        error_code: decision.code,
        reason: decision.reason,
        candidate_profile_hash: candidate.profileHash,
        current_profile_hash: profileHash,
      })
    }
    return { decision, candidate }
  }

  private prompt(rootToolCount: number): string {
    return `${AGENT_REVIEW_SYSTEM_PROMPT}\n\n---\n\n${buildAgentReviewPrompt({
      story: this.options.story,
      branch: this.options.branch,
      pins: this.options.snapshots.pins(),
      // 让模型知道自己的硬上限：不告知的实测后果是它一直检索、从不提交。
      maxModelRequests: this.options.policy.modelBudget.maxRootRequests,
      maxAgents: this.options.policy.agents.maxAgentsPerAttempt,
      maxDelegationDepth: this.options.policy.agents.maxDelegationDepth,
      toolCount: rootToolCount,
    })}`
  }

  private usage(broker: AttemptControlHandle): ReviewUsage {
    const snapshot = broker.usage()
    return {
      source: 'harness-governor',
      // V4 起这是真值：governor 在调用 provider 之前预留，Broker 持有账本。
      // V3 曾经把 Broker 的 tool call 数放在这里，那是错的。
      modelRequests: snapshot.modelRequests,
      retryRequests: snapshot.retryRequests,
      compactionRequests: snapshot.compactionRequests,
      inputTokens: snapshot.inputTokens,
      outputTokens: snapshot.outputTokens,
    }
  }
}

function usageForDatabase(usage: BrokerUsageSnapshot): Record<string, number | null> {
  return {
    model_requests: usage.modelRequests,
    retry_requests: usage.retryRequests,
    compaction_requests: usage.compactionRequests,
    tool_calls: usage.toolCalls,
    evidence_shown: usage.evidenceShown,
    searches_run: usage.searchesRun,
    web_requests: usage.webRequests,
    web_bytes: usage.webBytes,
    // provider 没报 token 时保持 null，不臆造 0。
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
  }
}

function perAgentUsageForDatabase(
  usage: BrokerUsageSnapshot,
): Array<Record<string, string | number | null>> {
  return usage.perAgent.map((agent) => ({
    agent_id: agent.agentId,
    model_requests: agent.modelRequests,
    tool_calls: agent.toolCalls,
    evidence_produced: agent.evidenceProduced,
  }))
}

/**
 * 从 Artifact 的路径推断类型。
 *
 * 只按扩展名和常见命名判断，判不出来就是 NOTE。这里不猜内容：把一个测试报告误标成补丁
 * 只是分类不准，而读取内容去猜会让平台对不可信数据做语义解析。
 */
export function inferArtifactType(relativePath: string): string {
  const name = relativePath.toLowerCase()
  if (name.endsWith('.patch') || name.endsWith('.diff')) return 'PATCH'
  if (name.includes('test') && (name.endsWith('.xml') || name.endsWith('.json'))) {
    return 'TEST_REPORT'
  }
  if (name.includes('test-report') || name.includes('junit')) return 'TEST_REPORT'
  if (name.includes('build') && name.endsWith('.log')) return 'BUILD_LOG'
  if (name.includes('lint') || name.includes('static-analysis')) return 'STATIC_ANALYSIS'
  return 'NOTE'
}

/**
 * 取字符串尾部若干字符。
 *
 * 取尾而不是取头：Harness 子进程的 stderr 往往以启动噪音开头，真正的失败原因在
 * 最后。截断处加标记，避免把截断后的内容误读成完整日志。
 */
export function tailOf(value: string, maxChars: number): string {
  if (maxChars <= 0) return ''
  if (value.length <= maxChars) return value
  return `…[truncated ${value.length - maxChars} chars]…${value.slice(-maxChars)}`
}
