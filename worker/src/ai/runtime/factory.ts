import type { JobsDb, StoryTask } from '../../db/jobs.js'
import type { PreparedRepository } from '../../git/prepare.js'
import type { BranchName, RepositoryName } from '../../git/repositories.js'
import type { Logger } from '../../logger.js'
import type { CommitReviewInput, CommitReviewResult } from '../control/attempt-control-broker.js'
import type { AttemptEndReason } from '../control/attempt-tree-controller.js'
import {
  applyEmergencyBreakers,
  contractHash,
  loadCapabilityContract,
  normalizeCapabilityPolicy,
  policyHash as hashCapabilityPolicy,
  type V4CapabilityPolicy,
} from '../policy/v4-capability-policy.js'
import { V4_ERROR_CODES, V4GovernanceError } from '../policy/v4-errors.js'
import { SnapshotStore } from '../snapshot/snapshot-store.js'
import type { CoveragePolicy } from '../snapshot/search-coverage-ledger.js'
import { checkoutPinnedCommit } from '../../git/prepare.js'
import { DeepSeekHarnessAcpEngine } from './deepseek-harness-acp-engine.js'
import {
  parseFrozenSkillCatalog,
  provisionSkillCatalog,
  resolveCatalogLimits,
  type ProvisionedSkill,
} from '../skills/skill-provisioner.js'
import { SkillCache } from '../skills/skill-cache.js'
import { bundleHashDirName, emptyCatalogHash } from '../skills/skill-manifest.js'
import type { SkillStorageClient } from '../skills/skill-storage.js'
import {
  hostProxyChildEnv,
  resolveModelNetworkRoute,
  type HostProxySettings,
} from '../../model-connectivity/network-mode.js'
import {
  NullRuntimeEventReporter,
  type RuntimeEventReporterLike,
} from '../../monitoring/runtime-event-reporter.js'

/** Environment variable through which one attempt receives its model key. */
import type { StoryAttachmentStorage } from '../../linky/attachment-storage.js'
import { parseFrozenRequirementAttachments } from '../requirements/attachment-materializer.js'
import {
  buildRequirementAcceptanceCriteria,
  buildRequirementBody,
  buildRequirementPromptFields,
} from '../requirements/requirement-snapshot.js'

export const AGENT_MODEL_API_KEY_ENV = 'REVIEW_MODEL_API_KEY'

export interface BuildDeepSeekHarnessReviewInput {
  jobsDb: JobsDb
  task: StoryTask
  workerId: string
  branch: BranchName
  repositories: PreparedRepository[]
  agentAttemptsRoot: string
  /** Session JSONL 持久卷根目录。 */
  sessionRoot: string
  /** 不可从 Workspace 触及的平台目录（cache root、workspace root 等）。 */
  forbiddenRoots: readonly string[]
  infrastructure: { supabaseUrl?: string; gitlabBaseUrl?: string }
  logger: Logger
  isLeaseValid(): boolean
  isCancelRequested?(): boolean
  /** 本次 abort 的真实原因；由调度侧提供，供收敛审计区分取消来源。 */
  abortReason?(): AttemptEndReason
  commitReview(input: CommitReviewInput): Promise<CommitReviewResult>
  /**
   * 运行监控事件上报。缺省等价于关闭（`RUNTIME_EVENTS_ENABLED=false` 或旧接线），
   * 此时全部插桩点走 NullRuntimeEventReporter，现有分析流程一字不改。
   */
  runtimeEvents?: RuntimeEventReporterLike
  /**
   * V1.6：共享只读 Skill Cache 与 service-role 下载通道。
   *
   * 两者都缺省时，本次 attempt 使用**空技能目录** —— 这是单测与"该部署没有启用技能"
   * 的路径。注意它不等于"跳过隔离"：`skill-filesystem` 的 `includeDefaultRoots: false`
   * 永远生效，所以 Workspace 里的同名技能在任何配置下都无法被发现。
   */
  skills?: {
    cache: SkillCache
    storage: SkillStorageClient
    /** cache 容量上限，attempt 启动后按 LRU 回收。 */
    cacheMaxBytes?: number
  }
  /**
   * 模型端点是否接受图片输入。默认 false（只声明 `text`）。
   *
   * 它决定 Bundle 里的 `assets/*.png` 能不能被 `read_image` 读到 —— 关掉时那些字节对
   * 模型不可见。见 worker/src/config.ts 里 `modelImageInputEnabled` 的取舍说明。
   */
  modelImageInputEnabled?: boolean
  /**
   * 本机内网代理配置（V1.7 阶段二）。
   *
   * 它回答的是"这台 Worker 有没有通往内网的路"；模型的 `network_access_mode` 回答的是
   * "这个模型在哪张网上"。只有两者都成立才走代理，两者的组合判定在
   * `resolveModelNetworkRoute` 里，与连接测试链路共用。
   */
  hostProxy?: HostProxySettings | null
  /**
   * V1.20：需求附件的 service-role 对象通道。
   *
   * 缺省时附件不物化，提示词里也不会出现附件段 —— 单测与"这台 Worker 还没接 Linky"
   * 走的就是这条路。附件清单本身来自**冻结的** requirement_context，不在这里查库。
   */
  requirementAttachmentStorage?: StoryAttachmentStorage
}

/** Coverage required before an attempt may claim a story is not implemented. */
export function buildCoveragePolicy(repositories: readonly RepositoryName[]): CoveragePolicy {
  return { requiredRepositories: repositories, minQueriesPerRepository: 2 }
}

/**
 * 解析这次 attempt 的能力策略。
 *
 * 顺序固定：数据库冻结的 snapshot → 归一（补齐缺失字段、强制 danger-full-access 为假）
 * → 运维熔断（仅在事故期间由环境变量收窄）。
 *
 * 模型配置里的旧预算字段（agent_max_model_requests 等）只在 snapshot 缺失时兜底：0027
 * 之后新建的 Job 一定带完整 snapshot，兜底只服务在途的旧 Job。
 */
export function resolveAttemptPolicy(
  task: StoryTask,
  env: Record<string, string | undefined> = process.env,
): { policy: V4CapabilityPolicy; frozenPolicyHash: string; breakers: string[] } {
  const snapshot = task.capability_policy ?? {}
  const frozenPolicy = normalizeCapabilityPolicy(
    Object.keys(snapshot).length > 0 ? snapshot : fallbackPolicyFromModel(task),
  )
  const { policy, breakers } = applyEmergencyBreakers(frozenPolicy, env)
  return { policy, frozenPolicyHash: hashCapabilityPolicy(frozenPolicy), breakers }
}

/** 在途旧 Job 没有 snapshot 时，用模型配置里的预算字段拼一份最小 policy。 */
function fallbackPolicyFromModel(task: StoryTask): Record<string, unknown> {
  const model = task.model
  const root = model.agent_max_model_requests ?? 120
  const retry = model.agent_max_retry_requests ?? 6
  const compaction = model.agent_max_compaction_requests ?? 4
  return {
    modelBudget: {
      maxTotalRequests: root + retry + compaction,
      maxRootRequests: root,
      // 旧 Job 没有子 Agent 概念：把子预算设成一个保守值，而不是让它等于 root。
      maxChildRequests: Math.max(1, Math.floor(root / 4)),
      maxRetryRequests: retry,
      maxCompactionRequests: compaction,
    },
  }
}

/** Build the platform's only review runner: one DeepSeek Harness ACP attempt. */
export async function buildDeepSeekHarnessReview(
  input: BuildDeepSeekHarnessReviewInput,
): Promise<DeepSeekHarnessAcpEngine> {
  if (input.repositories.length === 0) {
    throw new Error('DeepSeek Harness review requires prepared repositories')
  }

  const runtimeEvents = input.runtimeEvents ?? new NullRuntimeEventReporter()
  /**
   * 契约校验失败只上报稳定错误码，绝不上报 secret 或 config 内容（方案 §7.6）。
   * 这条事件是"新 Worker 拒绝执行旧哈希在途任务"在监控台唯一可见的证据。
   */
  const rejectContract = (code: string, message: string): never => {
    runtimeEvents.report({
      type: 'RUNTIME_CONTRACT_REJECTED',
      errorCode: code,
      payload: { reason_code: code },
    })
    throw new V4GovernanceError(code as never, message)
  }

  const manifest = loadCapabilityContract()
  const currentContractHash = contractHash(manifest)
  if (input.task.capability_contract_hash === null) {
    rejectContract(
      V4_ERROR_CODES.SESSION_FORMAT_UNSUPPORTED,
      'claimed V4 task has no frozen Harness manifest hash',
    )
  }
  if (
    input.task.capability_contract_hash !== undefined &&
    input.task.capability_contract_hash !== currentContractHash
  ) {
    rejectContract(
      V4_ERROR_CODES.SESSION_FORMAT_UNSUPPORTED,
      `task requires Harness manifest ${input.task.capability_contract_hash}, worker has ${currentContractHash}`,
    )
  }
  if (input.task.harness_version === null) {
    rejectContract(
      V4_ERROR_CODES.SESSION_FORMAT_UNSUPPORTED,
      'claimed V4 task has no frozen Harness version',
    )
  }
  if (
    input.task.harness_version !== undefined &&
    input.task.harness_version !== manifest.harnessVersion
  ) {
    rejectContract(
      V4_ERROR_CODES.SESSION_FORMAT_UNSUPPORTED,
      `task requires Harness ${input.task.harness_version}, worker has ${manifest.harnessVersion}`,
    )
  }

  const snapshots = new SnapshotStore(
    input.repositories.map((repo) => ({
      name: repo.repository,
      commitSha: repo.commitSha,
      gitDir: repo.path,
    })),
  )
  const model = input.task.model
  const apiKey = await input.jobsDb.getModelSecretForStoryTask({
    taskId: input.task.id,
    workerId: input.workerId,
    claimToken: input.task.claim_token,
  })
  const { policy, frozenPolicyHash, breakers } = resolveAttemptPolicy(input.task)
  if (input.task.policy_hash === null) {
    rejectContract(
      V4_ERROR_CODES.AGENT_IDENTITY_INVALID,
      'claimed V4 task has no frozen policy hash',
    )
  }
  if (
    input.task.policy_hash !== undefined &&
    input.task.policy_hash !== frozenPolicyHash
  ) {
    rejectContract(
      V4_ERROR_CODES.AGENT_IDENTITY_INVALID,
      `frozen policy hash ${input.task.policy_hash} does not match Worker canonical hash ${frozenPolicyHash}`,
    )
  }
  if (breakers.length > 0) {
    input.logger.info('v4_emergency_breakers_active', {
      event: 'v4_emergency_breakers_active',
      breakers,
    })
  }

  // manifest / contract / policy 三个哈希全部对上。这是启动 Harness 之前最后一道
  // 结构性校验，通过之后才允许 spawn。
  runtimeEvents.report({ type: 'RUNTIME_CONTRACT_VERIFIED', payload: {} })

  const claim = {
    taskId: input.task.id,
    workerId: input.workerId,
    claimToken: input.task.claim_token,
    agentAttempt: input.task.agent_attempt,
  }

  /*
   * V1.6：下载并校验 Job 冻结的技能目录。
   *
   * 位置很关键 —— 在 `new DeepSeekHarnessAcpEngine` **之前**。理由：这一步会因为下载失败、
   * hash 不符、归档非法或超限而抛错，而方案 §12 要求这些失败发生在 spawn dsh 之前。
   * 放到引擎内部去做也能满足这一点，但那会让"技能不可用"与"Harness 起不来"混在同一段
   * 错误处理里，运维分不清是哪一层坏了。
   */
  const skills = await resolveFrozenSkills(input)
  const analysisScope = (input.task.job.analysis_context_version ?? 1) === 2
    ? await input.jobsDb.getStoryTaskAnalysisScope({
        taskId: input.task.id,
        workerId: input.workerId,
        claimToken: input.task.claim_token,
      })
    : undefined
  if (analysisScope && !input.task.agent_run_id) {
    rejectContract(
      V4_ERROR_CODES.AGENT_IDENTITY_INVALID,
      'claimed v2 task has no database-issued agent run id',
    )
  }
  const analysisScopeIdentity = analysisScope
    ? [
        input.task.job.story_input_catalog_hash,
        input.task.job.identity_snapshot_hash,
        input.task.job.repository_manifest_hash,
        input.task.job.selected_scope_hash,
        input.task.job.attribution_algorithm_version,
        input.task.job.ruleset_hash,
        analysisScope.story_input_hash,
        analysisScope.candidate_manifest_hash,
        String(analysisScope.generation),
      ]
    : undefined
  if (analysisScopeIdentity?.some((value) => typeof value !== 'string' || value.length === 0)) {
    throw Object.assign(new Error('claimed v2 task is missing frozen scope continuity hashes'), {
      code: 'ANALYSIS_SCOPE_IDENTITY_MISSING',
    })
  }

  /*
   * V1.7 阶段二：按**冻结快照**里的网络类型决定模型请求走不走本机代理。
   *
   * 读的是 `input.task.model`（即 `analysis_job.model_snapshot`），不是当前的模型配置 ——
   * 任务执行期间管理员改了网络类型，不能把一个在跑的 attempt 搬到另一张网上。
   *
   * `HOST_PROXY` 但这台 Worker 没配代理时，`resolveModelNetworkRoute` 会抛
   * `MODEL_PROXY_NOT_CONFIGURED`，attempt 明确失败 —— 绝不静默直连：那会把内网模型的
   * 请求（连带 API Key）发到公网 DNS 解析出来的某个同名主机上。
   */
  const networkRoute = resolveModelNetworkRoute({
    mode: model.network_access_mode,
    configuredProxy: input.hostProxy ?? null,
  })
  input.logger.info('model_network_route_resolved', {
    event: 'model_network_route_resolved',
    network_access_mode: networkRoute.mode,
    via_host_proxy: networkRoute.proxy !== null,
  })

  /*
   * 需求附件（V1.20）。
   *
   * 只认冻结 scope 里的那一份清单：一次分析期间需求内容必须不变，否则"AI 当时看到的
   * 需求"无法复现。没有 scope（legacy v1）就没有附件 —— 那条路径本来也没有冻结语义。
   */
  const frozenRequirementAttachments = analysisScope
    ? parseFrozenRequirementAttachments(analysisScope.requirement_context ?? null)
    : []

  return new DeepSeekHarnessAcpEngine({
    taskId: input.task.id,
    requirementAttachments:
      input.requirementAttachmentStorage && frozenRequirementAttachments.length > 0
        ? {
            items: frozenRequirementAttachments,
            storage: input.requirementAttachmentStorage,
          }
        : undefined,
    agentAttempt: input.task.agent_attempt,
    branch: input.branch,
    story: {
      code: input.task.story_code,
      name: input.task.story_name,
      description: analysisScope
        ? buildScopedStoryDescription(input.task, analysisScope)
        : buildStoryDescription(input.task),
      /*
       * 验收标准（V1.21）。
       *
       * 优先用冻结快照里的值。`task.acceptance_criteria` 是 claim RPC 恒返回 null 的
       * 遗留字段（review_story 在 0005 就删掉了这一列），保留它只是为了不改 legacy v1 路径。
       */
      acceptanceCriteria: analysisScope
        ? buildRequirementAcceptanceCriteria(analysisScope.requirement_context ?? null)
          ?? input.task.acceptance_criteria
        : input.task.acceptance_criteria,
      requirementFields: analysisScope
        ? buildRequirementPromptFields(analysisScope.requirement_context ?? null)
        : undefined,
      projectName: input.task.project_name,
      applicationName: input.task.application_name,
    },
    analysisScope,
    analysisScopeIdentity: analysisScopeIdentity?.join(':'),
    snapshots,
    route: {
      providerId: 'review-route',
      displayName: model.display_name,
      baseUrl: model.base_url,
      modelName: model.model_name,
      contextWindow: model.context_window ?? 131072,
      maxTokens: model.max_output_tokens ?? 8192,
      apiKeyEnvVar: AGENT_MODEL_API_KEY_ENV,
      requestTimeoutMs: model.request_timeout_ms ?? 180000,
      inputModalities: input.modelImageInputEnabled === true ? ['text', 'image'] : ['text'],
    },
    policy,
    frozenPolicyHash,
    coveragePolicy: buildCoveragePolicy(
      input.repositories.map((repo) => repo.repository),
    ),
    apiKey,
    modelProxyEnv:
      networkRoute.proxy === null ? undefined : hostProxyChildEnv(networkRoute.proxy),
    attemptsRoot: input.agentAttemptsRoot,
    sessionRoot: input.sessionRoot,
    skills,
    workerId: input.workerId,
    // claim 返回的 fencing revision：恢复时数据库会在此基础上再推进一格。
    sessionRevision: input.task.session_revision,
    logger: input.logger,
    infrastructure: input.infrastructure,
    forbiddenRoots: input.forbiddenRoots,
    isLeaseValid: input.isLeaseValid,
    isCancelRequested: input.isCancelRequested,
    abortReason: input.abortReason,
    commitReview: input.commitReview,
    checkoutPinned: checkoutPinnedCommit,
    runtimeEvents,
    runtimeContext: {
      jobId: input.task.job_id,
      batchId: input.task.job.batch_id,
      agentRunId: input.task.agent_run_id,
      harnessVersionFrozen: input.task.harness_version ?? null,
      capabilityContractHashFrozen: input.task.capability_contract_hash ?? null,
      policyVersion: input.task.policy_version,
    },
    db: {
      registerAgentNode: (identity) =>
        input.jobsDb.registerAgentNode({
          ...claim,
          agentId: identity.agentId,
          sessionId: identity.sessionId,
          parentAgentId: identity.parentAgentId,
          agentRole: identity.role,
          provider: identity.provider,
          toolPolicyHash: identity.toolPolicyHash,
        }),
      markAgentTerminal: (agentId, status, errorCode) =>
        input.jobsDb.markAgentNodeTerminal({ ...claim, agentId, status, errorCode }),
      flushAudit: (entries, decisions) =>
        input.jobsDb.appendToolAudit({ ...claim, entries, decisions }),
      saveArtifact: (artifact) => input.jobsDb.saveArtifact({ ...claim, ...artifact }),
      saveSessionCheckpoint: (checkpoint) =>
        input.jobsDb.saveSessionCheckpoint({ ...claim, ...checkpoint }),
      recordProfile: (profile) => input.jobsDb.recordAttemptProfile({ ...claim, ...profile }),
      reserveBudget: (agentId, kind, count) =>
        input.jobsDb.reserveAgentBudget({ ...claim, agentId, kind, count }),
      commitUsage: (usage, perAgent) =>
        input.jobsDb.commitAgentUsage({ ...claim, usage, perAgent }),
      loadResumableAttempt: () =>
        input.jobsDb.loadResumableAttempt({
          taskId: input.task.id,
          workerId: input.workerId,
          claimToken: input.task.claim_token,
        }),
      requestAttemptCancel: (reason) => input.jobsDb.requestAttemptCancel(input.task.id, reason),
      getStoryCommitDiffMetadata: analysisScope
        ? (candidateId) => input.jobsDb.getStoryCommitDiffArchiveMetadata({
            taskId: input.task.id,
            workerId: input.workerId,
            claimToken: input.task.claim_token,
            candidateId,
          })
        : undefined,
      recordStoryCommitAccess: analysisScope
        ? (access) => input.jobsDb.recordStoryCommitAccess({
            taskId: input.task.id,
            workerId: input.workerId,
            claimToken: input.task.claim_token,
            agentRunId: input.task.agent_run_id!,
            ...access,
          })
        : undefined,
      submitCommitRelevanceVerdict: analysisScope
        ? (output) => input.jobsDb.submitStoryCommitRelevanceVerdict({
            taskId: input.task.id,
            workerId: input.workerId,
            claimToken: input.task.claim_token,
            agentRunId: input.task.agent_run_id!,
            candidateId: output.candidateId,
            triageRevision: output.triageRevision,
            verdict: output.verdict,
            reasonCodes: output.reasonCodes,
            confidence: output.confidence,
            diffAccessIds: output.diffAccessIds,
            summary: output.summary,
          })
        : undefined,
      expandAnalysisScope: analysisScope
        ? async (expansion) => {
            await input.jobsDb.expandAnalysisScope({
              taskId: input.task.id,
              workerId: input.workerId,
              claimToken: input.task.claim_token,
              agentRunId: input.task.agent_run_id!,
              agentNodeId: expansion.agentNodeId,
              fromLevel: expansion.fromLevel,
              toLevel: expansion.toLevel,
              reasonCode: expansion.reasonCode,
            })
          }
        : undefined,
    },
  })
}

export interface ResolvedFrozenSkills {
  catalogHash: string
  frozenCatalogHash: string
  snapshotVersion: number
  bundles: readonly ProvisionedSkill[]
  downloadBytes: number
  cacheHits: number
  cacheMisses: number
}

/**
 * 取 Job 冻结目录 → 下载/复用 cache → 重算 catalog hash。
 *
 * 未接线 cache/storage 时返回一个显式的空目录，而不是 `undefined`：调用方拿到的永远是
 * 一个"我确实处理过技能"的结构，于是"忘了传参"和"这个 Job 真的没有技能"在日志里长得
 * 不一样。
 */
export async function resolveFrozenSkills(
  input: BuildDeepSeekHarnessReviewInput,
): Promise<ResolvedFrozenSkills> {
  const empty: ResolvedFrozenSkills = {
    catalogHash: emptyCatalogHash(),
    frozenCatalogHash: '',
    snapshotVersion: 0,
    bundles: [],
    downloadBytes: 0,
    cacheHits: 0,
    cacheMisses: 0,
  }
  if (input.skills === undefined) return empty

  const raw = await input.jobsDb.getStoryTaskSkillSnapshot({
    taskId: input.task.id,
    workerId: input.workerId,
    claimToken: input.task.claim_token,
  })
  const catalog = parseFrozenSkillCatalog(raw)
  if (catalog.bundles.length === 0) {
    return {
      ...empty,
      frozenCatalogHash: catalog.catalogHash,
      snapshotVersion: catalog.snapshotVersion,
    }
  }

  const outcome = await provisionSkillCatalog({
    catalog,
    cache: input.skills.cache,
    storage: input.skills.storage,
    // V1.8：用 Job 冻结时的目录上限重算校验，而不是编译常量；历史快照回退默认。
    catalogLimits: resolveCatalogLimits(catalog),
    onEvent: (event) =>
      input.logger.info('skill_bundle_provisioned', {
        event: 'skill_bundle_provisioned',
        kind: event.kind,
        skill_name: event.name,
        // hash 是内容寻址标识，不是秘密；日志里绝不出现 Bundle 正文或 signed URL。
        skill_bundle_hash: event.bundleHash,
        bytes: event.bytes ?? null,
      }),
  })

  // 回收在**物化之前**做：本次要用的 bundle 全部排除在外，所以不会删掉马上要复制的目录。
  // 放在 attempt 结束时做反而更糟 —— 那时进程可能已经因为异常退出了。
  const reclaimed = input.skills.cache.reclaim({
    maxBytes: input.skills.cacheMaxBytes ?? 4 * 1024 * 1024 * 1024,
    keep: new Set(catalog.bundles.map((bundle) => bundleHashDirName(bundle.bundleHash))),
  })
  if (reclaimed.removed > 0) {
    input.logger.info('skill_cache_reclaimed', {
      event: 'skill_cache_reclaimed',
      removed: reclaimed.removed,
      bytes: reclaimed.bytes,
    })
  }

  return {
    catalogHash: outcome.catalogHash,
    frozenCatalogHash: catalog.catalogHash,
    snapshotVersion: catalog.snapshotVersion,
    bundles: outcome.bundles,
    downloadBytes: outcome.downloadBytes,
    cacheHits: outcome.cacheHits,
    cacheMisses: outcome.cacheMisses,
  }
}

/** Assemble requirement text from the imported row when legacy columns are absent. */
export function buildStoryDescription(task: StoryTask): string {
  if (task.description && task.description.trim().length > 0) {
    return task.description
  }
  const source = task.source_data ?? {}
  const lines = Object.entries(source)
    .filter(([, value]) => value !== null && value !== undefined && String(value).trim() !== '')
    .map(([key, value]) => `${key}: ${String(value)}`)
  return lines.length > 0 ? lines.join('\n') : task.story_name
}

/**
 * V1.21：需求正文。
 *
 * 只使用冻结 scope 明确返回的 `requirement_context`，不读原始 source_data —— 这条边界
 * 与 V1.11 一致。变化在于"正文"和"字段"分开了：这里只产出正文，其余结构化字段由
 * `buildRequirementPromptFields` 带中文标签单独渲染，全量原文进 `需求快照.md`。
 *
 * 旧实现把 `detailed_description` / `related_features` / `release_window` 三个键拼成
 * `key: value` 塞进正文，其中 `release_window` 从来不存在于 requirement_context（死代码），
 * 而 `source_status`、`iteration` 明明冻结了却被白名单丢掉。
 */
export function buildScopedStoryDescription(
  task: StoryTask,
  scope: { requirement_context?: Record<string, unknown> },
): string {
  return buildRequirementBody(scope.requirement_context ?? {}, {
    storyName: task.story_name,
    projectName: task.project_name,
    applicationName: task.application_name,
  })
}
