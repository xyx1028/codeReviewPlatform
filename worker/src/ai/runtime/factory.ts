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

/** Environment variable through which one attempt receives its model key. */
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

  const manifest = loadCapabilityContract()
  const currentContractHash = contractHash(manifest)
  if (input.task.capability_contract_hash === null) {
    throw new V4GovernanceError(
      V4_ERROR_CODES.SESSION_FORMAT_UNSUPPORTED,
      'claimed V4 task has no frozen Harness manifest hash',
    )
  }
  if (
    input.task.capability_contract_hash !== undefined &&
    input.task.capability_contract_hash !== currentContractHash
  ) {
    throw new V4GovernanceError(
      V4_ERROR_CODES.SESSION_FORMAT_UNSUPPORTED,
      `task requires Harness manifest ${input.task.capability_contract_hash}, worker has ${currentContractHash}`,
    )
  }
  if (input.task.harness_version === null) {
    throw new V4GovernanceError(
      V4_ERROR_CODES.SESSION_FORMAT_UNSUPPORTED,
      'claimed V4 task has no frozen Harness version',
    )
  }
  if (
    input.task.harness_version !== undefined &&
    input.task.harness_version !== manifest.harnessVersion
  ) {
    throw new V4GovernanceError(
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
    throw new V4GovernanceError(
      V4_ERROR_CODES.AGENT_IDENTITY_INVALID,
      'claimed V4 task has no frozen policy hash',
    )
  }
  if (
    input.task.policy_hash !== undefined &&
    input.task.policy_hash !== frozenPolicyHash
  ) {
    throw new V4GovernanceError(
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

  const claim = {
    taskId: input.task.id,
    workerId: input.workerId,
    claimToken: input.task.claim_token,
    agentAttempt: input.task.agent_attempt,
  }

  return new DeepSeekHarnessAcpEngine({
    taskId: input.task.id,
    agentAttempt: input.task.agent_attempt,
    branch: input.branch,
    story: {
      code: input.task.story_code,
      name: input.task.story_name,
      description: buildStoryDescription(input.task),
      acceptanceCriteria: input.task.acceptance_criteria,
      projectName: input.task.project_name,
      applicationName: input.task.application_name,
    },
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
    },
    policy,
    frozenPolicyHash,
    coveragePolicy: buildCoveragePolicy(
      input.repositories.map((repo) => repo.repository),
    ),
    apiKey,
    attemptsRoot: input.agentAttemptsRoot,
    sessionRoot: input.sessionRoot,
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
    },
  })
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
