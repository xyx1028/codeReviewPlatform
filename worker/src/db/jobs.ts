/**
 * Typed adapter for the platform's single DeepSeek Harness worker RPC surface.
 * Every RPC is service-role only; claim tokens protect task-scoped operations.
 */

import type { BranchName, RepositoryName } from '../git/repositories.js'
import type {
  DiscoveredCommitEmail,
  MergeRequestEnrichmentStatus,
  RepositoryMergeRequestWire,
} from '../git/gitlab-readonly-client.js'
import type { DbClient } from './client.js'
import type {
  CommittedAttachment,
  LinkyBatchImportClaim,
} from '../linky/batch-import-runner.js'
import type {
  RuntimeEventBatchResult,
  RuntimeEventTarget,
  RuntimeEventWire,
} from '../monitoring/runtime-event-types.js'

export interface ModelSnapshot {
  model_config_id: string
  display_name: string
  base_url: string
  model_name: string
  /**
   * 模型网络类型，随 Job 冻结（V1.7 阶段二）。
   *
   * 可选是为了在途旧 Job：它们的 model_snapshot 里没有这个字段，缺失一律按 `DIRECT`
   * 处理（见 network-mode.ts 的 parseModelNetworkAccessMode）—— 那是改造之前的行为，
   * 也是唯一不会让旧任务突然换网络路径的取值。
   */
  network_access_mode?: string
  max_parallel_tasks?: number
  request_timeout_ms?: number
  context_window?: number
  max_output_tokens?: number
  agent_max_model_requests?: number
  agent_max_retry_requests?: number
  agent_max_compaction_requests?: number
}

export interface JobContext {
  id: string
  batch_id: string
  model_config_id: string
  requested_branch: BranchName
  total_stories: number
  /** V1.11：缺失即历史 v1，绝不能把在途旧 Job 隐式升级。 */
  analysis_context_version?: 1 | 2
  commit_window_days?: 7 | 14 | 21 | 28
  required_worker_scope_version?: 1 | 2
  story_input_catalog_hash?: string | null
  identity_snapshot_hash?: string | null
  repository_manifest_hash?: string | null
  selected_scope_hash?: string | null
  attribution_algorithm_version?: string | null
  ruleset_hash?: string | null
}

export interface FrozenScopeStory {
  task_id: string
  story_id: string
  story_code: string
  story_name: string
  owners_text: string
  normalized_developer_ids: string[]
  project_name: string | null
  application_name: string | null
  release_window: string | null
  requirement_context: Record<string, unknown>
  input_hash: string
}

export interface FrozenScopeIdentity {
  developer_id: string
  display_name: string
  email_fingerprint: string | null
  author_name_aliases: string[]
  verification_status: string
}

export interface FrozenJobScopeInputs {
  story_input_catalog_hash: string
  identity_snapshot_hash: string
  rule_version_id: string
  ruleset_hash: string
  idempotent: boolean
  /**
   * Worker 生成全部 task scope 所需的冻结明细。当前 foundation RPC 若未返回这两项，
   * v2 preparation 会显式失败；不能拿实时 review_story/developer_identity 代替冻结输入。
   */
  stories?: FrozenScopeStory[]
  identities?: FrozenScopeIdentity[]
  previous_repository_heads?: Partial<Record<RepositoryName, string | null>>
}

export interface StoryAnalysisScopeCandidateFile {
  /** Repository-relative path frozen from analysis_repository_commit_file. */
  path: string
  /** Previous path for a rename/copy; it is also in PRIMARY when present. */
  old_path?: string | null
  change_type?: string
  additions?: number
  deletions?: number
  is_binary?: boolean
}

export interface StoryAnalysisScopeCandidate {
  candidate_id: string
  tier: 'STRONG' | 'AI_CANDIDATE' | 'WEAK' | 'EXCLUDED' | 'CONFLICT'
  rank_score: number
  reason_codes: string[]
  /**
   * Trusted DB-proxy authorization fields. get_story_task_analysis_scope must
   * project `repository` plus `files[{path,old_path}]` from the frozen commit
   * rows; they are never accepted from a model request. Older DB proxies may
   * omit `files`, in which case PRIMARY snapshot access fails closed.
   */
  repository: RepositoryName
  files?: StoryAnalysisScopeCandidateFile[]
  /** 仅供 Worker/Broker 解析 Git 对象；正式模型工具永不返回。 */
  commit_sha?: string
  short_sha: string
  subject: string
  author_name: string
  author_email_masked: string | null
  committed_at: string
  files_changed: number
  additions: number
  deletions: number
  effective_status: string
  diff_status: string
  /** Current-run verdict projection. Never inherited from another Attempt. */
  triage_verdict: 'RELATED' | 'UNRELATED' | 'UNCERTAIN' | null
  /** Database-generated final PRIMARY membership. Missing values fail closed. */
  selected: boolean
  selection_level: 'PRIMARY' | null
}

export interface StoryAnalysisScope {
  task_id: string
  generation: number
  scope_mode: string
  status: string
  current_scope_level: 'PRIMARY' | 'RELATED' | 'GLOBAL'
  algorithm_version: string
  ruleset_hash: string
  candidate_manifest_hash: string
  scope_error_code: string | null
  degradation_reasons: string[]
  candidate_count: number
  strong_count: number
  ai_candidate_count: number
  triage_revision: number
  triage_required_count: number
  triage_completed_count: number
  triage_complete: boolean
  story_input_hash?: string | null
  requirement_context?: Record<string, unknown>
  candidates: StoryAnalysisScopeCandidate[]
}

export interface RepositorySnapshot {
  repository_name: RepositoryName
  requested_branch: BranchName
  commit_sha: string
  commit_subject: string | null
}

export interface RepositorySnapshotInput {
  repository_name: RepositoryName
  requested_branch: BranchName
  commit_sha: string
  commit_subject: string | null
}

export interface StoryFields {
  story_id: string
  story_code: string
  story_name: string
  description: string | null
  acceptance_criteria: string | null
  project_name: string | null
  application_name: string | null
  source_data: Record<string, unknown>
}

/** One atomically claimed Agent task. The plaintext claim token exists only in memory. */
export interface StoryTask {
  id: string
  job_id: string
  worker_id: string
  lease_expires_at: string | null
  agent_status: string
  agent_attempt: number
  claim_token: string
  /** V4 冻结的能力策略 snapshot。在途旧 Job 可能为空对象。 */
  capability_policy: Record<string, unknown>
  policy_version: number
  policy_hash: string | null
  /** Job 创建时冻结的 Harness 版本与完整 manifest 哈希。 */
  harness_version?: string | null
  capability_contract_hash?: string | null
  agent_run_id: string | null
  /** fencing token：按 task 全局单调。 */
  session_revision: number
  job: JobContext
  model: ModelSnapshot
  snapshots: RepositorySnapshot[]
  story: StoryFields
  story_id: string
  story_code: string
  story_name: string
  description: string | null
  acceptance_criteria: string | null
  project_name: string | null
  application_name: string | null
  source_data: Record<string, unknown>
}

export interface ModelConnectivityTestClaim {
  id: string
  model_config_id: string
  base_url_snapshot: string
  model_name_snapshot: string
  request_timeout_ms_snapshot: number
  /** 入队时冻结的网络类型。与 base_url 同源：测试期间改配置不影响这一次。 */
  network_access_mode_snapshot?: string
  claim_token: string
}

/**
 * V1.13：一条"用 GitLab 用户名反查提交邮箱"的任务。
 *
 * 注意这里**没有请求人**：Worker 不需要知道是谁在查，数据库也不给它。
 */
export interface GitEmailDiscoveryClaim {
  id: string
  gitlab_username: string
  lookback_days: number
  attempt: number
  claim_token: string
}

/**
 * V1.19：一条"按历史评审证据优化技能内容"的任务。
 *
 * 这里**必须**有请求人（`requested_by`）：AI 的产出要走与人工上传完全相同的校验 RPC，
 * 而那些 RPC 的第一句是 `assert_actor_is_admin(p_actor_id)`。Worker 是代管理员按按钮的，
 * 不是一个独立的身份。缺请求人时数据库在认领阶段就把任务打成终态失败，Worker 拿不到它。
 */
export interface SkillAiOptimizationClaim {
  request_id: string
  claim_token: string
  skill_id: string
  skill_name: string
  requested_by: string
  source_version_id: string
  source_version: number
  archive_bucket: string
  archive_object_key: string
  archive_sha256: string
  /** 入队时冻结的模型端点。中途改模型配置不影响在途任务。 */
  base_url_snapshot: string
  model_name_snapshot: string
  request_timeout_ms_snapshot: number
  network_access_mode_snapshot?: string
  /**
   * 入队时冻结的模型输出上限（V1.22b）。
   *
   * 必须用它当 `max_tokens`，也必须把它当作"这次能写多少"告诉模型。线上踩过：三个模型
   * 配置都是 8192，Worker 按 60000 发请求，端点静默截断，错误表现成"输出里没有 JSON"。
   * `undefined` / null = 升级前的历史行，回退到编译默认。
   */
  max_output_tokens_snapshot?: number | null
}

/** claim 四要素里 Worker 每次都要带的那三个。 */
export interface SkillAiOptimizationClaimRef {
  requestId: string
  workerId: string
  claimToken: string
}

export interface SkillEvidenceSampleRow {
  story_code: string
  verdict: string
  summary: string
  human_review_result: string | null
  human_review_comment: string | null
}

/**
 * 引用过这个技能的一个 Job 及其所属批次。
 *
 * 给模型与管理员的都是**批次身份**（名称 + 周次），不是 Job id：后者对人没有意义，
 * 而管理员记得的是"第 39 周那个批次评得不准"。
 */
export interface SkillEvidenceBatchRow {
  batch_id: string
  batch_name: string
  week_code: string | null
  job_id: string
  job_status: string | null
  job_created_at: string | null
  skill_version: number | null
  result_count: number
}

export interface SkillReviewEvidenceSnapshot {
  referenced_job_count: number
  verdict_counts: Record<string, number>
  human_review_counts: Record<string, number>
  sample_findings: SkillEvidenceSampleRow[]
  referenced_batches: SkillEvidenceBatchRow[]
}

export interface PreparationClaim {
  job: JobContext
  model: ModelSnapshot
}
export interface FinalizationClaim {
  job: JobContext
  model: ModelSnapshot
  snapshots: RepositorySnapshot[]
}

export interface VerifiedEvidenceRecord {
  evidence_id: string
  repository_name: RepositoryName
  commit_sha: string
  file_path: string
  start_line: number
  end_line: number
  evidence_type: string
  description: string
}

export interface CompletedStoryTask {
  id: string
  job_id: string
  story_id: string
  story_code: string
  agent_status: string
  output: Record<string, unknown> | null
  verified_evidence: VerifiedEvidenceRecord[]
}

/**
 * Worker 观测到的 attempt 元数据：真实用量 + V4 身份。
 *
 * 身份字段和用量放在同一个 envelope 里，是因为它们的可信来源相同 —— 都由 Worker 观测，
 * 都不来自模型自报。`save_agent_review_result` 用它们做 root-only 与 fencing 校验。
 */
export interface AgentRunUsage {
  tool_calls: number
  evidence_shown: number
  searches_run: number
  retry_requests: number
  compaction_requests: number
  /** 真实模型请求数（governor 在调用 provider 之前预留的计数）。 */
  model_requests?: number
  root_model_requests?: number
  child_model_requests?: number
  web_requests?: number
  web_bytes?: number
  input_tokens?: number | null
  output_tokens?: number | null
  root_agent_id?: string
  root_session_id?: string
  tree_digest?: string
  session_revision?: number
  policy_hash?: string
}

/** 一次工具调用的安全元数据。不含 prompt、源码和工具正文。 */
export interface ToolAuditRow {
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
   * V1.6 技能字段（方案 §16）。
   *
   * 只有三个键 + 一个安全的规范相对路径，**不含** SKILL.md 正文、资源正文、脚本正文
   * 和完整命令行。它们通过现有 `/attempt/tool-audit` 通道上报，所以没有新增 Broker
   * 路由，`v4-capability-contract.json` 的 manifest 哈希不变 —— 新旧 Worker 可以混跑
   * 同一批次。
   */
  skillName?: string | null
  skillBundleHash?: string | null
  resourceRelativePath?: string | null
}

export interface PermissionDecisionRow {
  agentId: string
  agentRole: string
  toolName: string
  policyLayer: string
  decision: 'ALLOW' | 'DENY'
  reasonCode: string
}

/** 一次 attempt 的租约与取消状态。心跳一次往返同时拿到两者。 */
export interface AttemptControlState {
  leaseHeld: boolean
  cancelRequested: boolean
  cancelReason: string | null
  sealed: boolean
  sessionRevision: number
}

/** claim 凭据。V4 的每个治理 RPC 都要出示它。 */
interface AttemptClaim {
  taskId: string
  workerId: string
  claimToken: string
  agentAttempt: number
}

export interface AgentReviewCommitReceipt {
  run_id: string
  committed_at: string
}

export function unwrapMaybeObject<T>(data: unknown): T | null {
  if (data === null || data === undefined) return null
  if (Array.isArray(data)) return data.length > 0 ? (data[0] as T) : null
  return data as T
}

export function unwrapArray<T>(data: unknown): T[] {
  if (data === null || data === undefined) return []
  if (Array.isArray(data)) return data as T[]
  return [data as T]
}

function toStoryTask(raw: Record<string, unknown>): StoryTask {
  const story = (raw.story ?? {}) as Partial<StoryFields>
  const job = raw.job as JobContext | undefined
  const claimToken = raw.claim_token
  if (typeof claimToken !== 'string' || claimToken.length === 0) {
    throw new Error('claim_next_story_task returned no claim token')
  }

  return {
    id: String(raw.id),
    job_id: String(raw.job_id ?? job?.id ?? ''),
    worker_id: String(raw.worker_id ?? ''),
    lease_expires_at: (raw.lease_expires_at as string | null) ?? null,
    agent_status: String(raw.agent_status ?? 'PENDING'),
    agent_attempt: Number(raw.agent_attempt ?? 0),
    claim_token: claimToken,
    capability_policy: (raw.capability_policy as Record<string, unknown>) ?? {},
    policy_version: Number(raw.policy_version ?? 4),
    policy_hash: (raw.policy_hash as string | null) ?? null,
    harness_version: (raw.harness_version as string | null) ?? null,
    capability_contract_hash: (raw.capability_contract_hash as string | null) ?? null,
    agent_run_id: (raw.agent_run_id as string | null) ?? null,
    session_revision: Number(raw.session_revision ?? 1),
    job: raw.job as JobContext,
    model: raw.model as ModelSnapshot,
    snapshots: unwrapArray<RepositorySnapshot>(raw.snapshots),
    story: story as StoryFields,
    story_id: String(story.story_id ?? raw.story_id ?? ''),
    story_code: String(story.story_code ?? raw.story_code ?? ''),
    story_name: String(story.story_name ?? raw.story_name ?? ''),
    description: story.description ?? (raw.description as string | null) ?? null,
    acceptance_criteria:
      story.acceptance_criteria ?? (raw.acceptance_criteria as string | null) ?? null,
    project_name: story.project_name ?? (raw.project_name as string | null) ?? null,
    application_name:
      story.application_name ?? (raw.application_name as string | null) ?? null,
    source_data: story.source_data ?? (raw.source_data as Record<string, unknown>) ?? {},
  }
}

export interface GitIdentityMatchInput {
  inputId: string
  email: string
  provider?: 'git' | 'gitlab'
}

export type GitIdentityMatchStatus = 'MATCHED' | 'UNMATCHED' | 'CONFLICT'

export interface GitIdentityMatchResult {
  input_id: string
  provider: 'git' | 'gitlab'
  email_fingerprint: string
  masked_email: string
  match_status: GitIdentityMatchStatus
  developer_id: string | null
  display_name: string | null
  verification_status: string | null
  author_name_aliases: string[]
}

export class JobsDb {
  constructor(private db: DbClient) {}

  /**
   * Normalize and match raw Git emails in PostgreSQL, where the Vault-backed identity pepper lives.
   * Raw emails are present only in this RPC request and are never copied into returned objects.
   */
  async matchAnalysisGitIdentities(
    authors: readonly GitIdentityMatchInput[],
  ): Promise<GitIdentityMatchResult[]> {
    if (authors.length === 0) return []
    const inputIds = new Set<string>()
    for (const author of authors) {
      if (author.inputId.trim() === '' || inputIds.has(author.inputId)) {
        throw new Error('identity matcher input ids must be non-empty and unique')
      }
      inputIds.add(author.inputId)
    }

    const matched: GitIdentityMatchResult[] = []
    for (let offset = 0; offset < authors.length; offset += 1000) {
      const chunk = authors.slice(offset, offset + 1000)
      const data = await this.db.rpc<unknown>('match_analysis_git_identities', {
        p_authors: chunk.map((author) => ({
          input_id: author.inputId,
          provider: author.provider ?? 'gitlab',
          email: author.email,
        })),
      })
      for (const raw of unwrapArray<Record<string, unknown>>(data)) {
        const status = raw.match_status
        const provider = raw.provider
        const fingerprint = raw.email_fingerprint
        const masked = raw.masked_email
        if (
          (status !== 'MATCHED' && status !== 'UNMATCHED' && status !== 'CONFLICT')
          || (provider !== 'git' && provider !== 'gitlab')
          || typeof fingerprint !== 'string'
          || !/^[0-9a-f]{64}$/.test(fingerprint)
          || typeof masked !== 'string'
        ) {
          throw new Error('match_analysis_git_identities returned an invalid result')
        }
        matched.push({
          input_id: String(raw.input_id ?? ''),
          provider,
          email_fingerprint: fingerprint,
          masked_email: masked,
          match_status: status,
          developer_id: typeof raw.developer_id === 'string' ? raw.developer_id : null,
          display_name: typeof raw.display_name === 'string' ? raw.display_name : null,
          verification_status:
            typeof raw.verification_status === 'string' ? raw.verification_status : null,
          author_name_aliases: Array.isArray(raw.author_name_aliases)
            ? raw.author_name_aliases.filter((value): value is string => typeof value === 'string')
            : [],
        })
      }
    }
    const matchedIds = new Set(matched.map((result) => result.input_id))
    if (
      matched.length !== authors.length
      || matchedIds.size !== authors.length
      || matched.some((result) => !inputIds.has(result.input_id))
    ) {
      throw new Error('match_analysis_git_identities returned an incomplete result set')
    }
    return matched
  }

  async claimJobForPreparation(workerId: string): Promise<PreparationClaim | null> {
    const data = await this.db.rpc<unknown>('claim_job_for_preparation', {
      p_worker_id: workerId,
    })
    const obj = unwrapMaybeObject<Record<string, unknown>>(data)
    if (!obj?.job) return null
    return { job: obj.job as JobContext, model: obj.model as ModelSnapshot }
  }

  saveRepositorySnapshots(
    jobId: string,
    workerId: string,
    snapshots: RepositorySnapshotInput[],
  ): Promise<void> {
    return this.db.rpc<void>('save_repository_snapshots', {
      p_job_id: jobId,
      p_worker_id: workerId,
      p_snapshots: snapshots,
    })
  }

  async freezeAnalysisJobScopeInputs(jobId: string, workerId: string): Promise<FrozenJobScopeInputs> {
    const data = await this.db.rpc<unknown>('freeze_analysis_job_scope_inputs', {
      p_job_id: jobId,
      p_worker_id: workerId,
    })
    const row = unwrapMaybeObject<FrozenJobScopeInputs>(data)
    if (!row?.story_input_catalog_hash || !row.identity_snapshot_hash || !row.ruleset_hash) {
      throw Object.assign(new Error('freeze_analysis_job_scope_inputs returned an incomplete identity'), {
        code: 'ANALYSIS_SCOPE_INPUTS_MISSING',
      })
    }
    return row
  }

  async saveAnalysisRepositoryCommitManifest(input: {
    jobId: string
    workerId: string
    repositoryName: RepositoryName
    manifest: Record<string, unknown>
    manifestHash: string
  }): Promise<Record<string, unknown>> {
    const data = await this.db.rpc<unknown>('save_analysis_repository_commit_manifest', {
      p_job_id: input.jobId,
      p_worker_id: input.workerId,
      p_repository_name: input.repositoryName,
      p_manifest: input.manifest,
      p_manifest_hash: input.manifestHash,
    })
    return unwrapMaybeObject<Record<string, unknown>>(data) ?? {}
  }

  async saveAnalysisRepositoryMergeRequests(input: {
    jobId: string
    workerId: string
    repositoryName: RepositoryName
    status: MergeRequestEnrichmentStatus
    errorCode: string | null
    mergeRequests: RepositoryMergeRequestWire[]
  }): Promise<Record<string, unknown>> {
    const data = await this.db.rpc<unknown>('save_analysis_repository_merge_requests', {
      p_job_id: input.jobId,
      p_worker_id: input.workerId,
      p_repository_name: input.repositoryName,
      p_status: input.status,
      p_error_code: input.errorCode,
      p_merge_requests: input.mergeRequests,
    })
    return unwrapMaybeObject<Record<string, unknown>>(data) ?? {}
  }

  async saveAnalysisStoryScopes(input: {
    jobId: string
    workerId: string
    algorithmVersion: string
    scopes: Array<Record<string, unknown>>
    scopeCatalogHash: string
  }): Promise<Record<string, unknown>> {
    const data = await this.db.rpc<unknown>('save_analysis_story_scopes', {
      p_job_id: input.jobId,
      p_worker_id: input.workerId,
      p_algorithm_version: input.algorithmVersion,
      p_scopes: input.scopes,
      p_scope_catalog_hash: input.scopeCatalogHash,
    })
    return unwrapMaybeObject<Record<string, unknown>>(data) ?? {}
  }

  async finalizeAnalysisStoryScope(jobId: string, workerId: string, generation = 1): Promise<Record<string, unknown>> {
    const data = await this.db.rpc<unknown>('finalize_analysis_story_scope', {
      p_job_id: jobId,
      p_worker_id: workerId,
      p_expected_generation: generation,
    })
    return unwrapMaybeObject<Record<string, unknown>>(data) ?? {}
  }

  async getStoryTaskAnalysisScope(input: { taskId: string; workerId: string; claimToken: string }): Promise<StoryAnalysisScope> {
    const data = await this.db.rpc<unknown>('get_story_task_analysis_scope', {
      p_task_id: input.taskId,
      p_worker_id: input.workerId,
      p_claim_token: input.claimToken,
    })
    const row = unwrapMaybeObject<StoryAnalysisScope>(data)
    if (!row?.candidate_manifest_hash || !row.ruleset_hash) {
      throw Object.assign(new Error('get_story_task_analysis_scope returned no frozen scope'), {
        code: 'ANALYSIS_SCOPE_NOT_FROZEN',
      })
    }
    return { ...row, candidates: unwrapArray<StoryAnalysisScopeCandidate>(row.candidates) }
  }

  async getStoryCommitDiffArchiveMetadata(input: {
    taskId: string
    workerId: string
    claimToken: string
    candidateId: string
  }): Promise<{
    candidate_id: string
    repository_name: RepositoryName
    commit_sha: string
    status: string
    archive_sha256: string | null
  }> {
    const data = await this.db.rpc<unknown>('get_story_commit_diff_archive_metadata', {
      p_task_id: input.taskId,
      p_worker_id: input.workerId,
      p_claim_token: input.claimToken,
      p_candidate_id: input.candidateId,
    })
    const row = unwrapMaybeObject<{
      candidate_id: string
      repository_name: RepositoryName
      commit_sha: string
      status: string
      archive_sha256: string | null
    }>(data)
    if (!row?.candidate_id || !row.commit_sha) {
      throw Object.assign(new Error('get_story_commit_diff_archive_metadata returned no frozen candidate'), {
        code: 'STORY_CANDIDATE_INVALID',
      })
    }
    return row
  }

  async recordStoryCommitAccess(input: {
    taskId: string
    workerId: string
    claimToken: string
    agentRunId: string
    agentNodeId: string | null
    candidateId: string
    toolCallId: string
    accessKind: 'DIFF'
    filePath: string | null
    cursorValue: string | null
    bytesReturned: number
    diffLines: number
    truncated: boolean
    archiveSha256: string | null
  }): Promise<string> {
    return this.db.rpc<string>('record_story_commit_access', {
      p_task_id: input.taskId,
      p_worker_id: input.workerId,
      p_claim_token: input.claimToken,
      p_agent_run_id: input.agentRunId,
      p_agent_node_id: input.agentNodeId,
      p_candidate_id: input.candidateId,
      p_tool_audit_id: null,
      p_tool_call_id: input.toolCallId,
      p_access_kind: input.accessKind,
      p_file_path: input.filePath,
      p_cursor_value: input.cursorValue,
      p_bytes_returned: input.bytesReturned,
      p_diff_lines: input.diffLines,
      p_truncated: input.truncated,
      p_archive_sha256: input.archiveSha256,
    })
  }

  async submitStoryCommitRelevanceVerdict(input: {
    taskId: string
    workerId: string
    claimToken: string
    agentRunId: string
    candidateId: string
    triageRevision: number
    verdict: string
    reasonCodes: readonly string[]
    confidence: number
    diffAccessIds: readonly string[]
    summary: string
  }): Promise<{ completed_count: number; required_count: number; triage_complete: boolean }> {
    const data = await this.db.rpc<unknown>('submit_story_commit_relevance_verdict', {
      p_task_id: input.taskId,
      p_worker_id: input.workerId,
      p_claim_token: input.claimToken,
      p_agent_run_id: input.agentRunId,
      p_candidate_id: input.candidateId,
      p_triage_revision: input.triageRevision,
      p_verdict: input.verdict,
      p_reason_codes: input.reasonCodes,
      p_confidence: input.confidence,
      p_diff_access_ids: input.diffAccessIds,
      p_summary: input.summary,
    })
    const row = unwrapMaybeObject<{ completed_count: number; required_count: number; triage_complete: boolean }>(data)
    return {
      completed_count: Number(row?.completed_count ?? 0),
      required_count: Number(row?.required_count ?? 0),
      triage_complete: row?.triage_complete === true,
    }
  }

  async expandAnalysisScope(input: {
    taskId: string
    workerId: string
    claimToken: string
    agentRunId: string
    agentNodeId: string | null
    fromLevel: string
    toLevel: string
    reasonCode: string
  }): Promise<string> {
    return this.db.rpc<string>('record_analysis_scope_expansion', {
      p_task_id: input.taskId,
      p_worker_id: input.workerId,
      p_claim_token: input.claimToken,
      p_agent_run_id: input.agentRunId,
      p_agent_node_id: input.agentNodeId,
      p_from_level: input.fromLevel,
      p_to_level: input.toLevel,
      p_reason_code: input.reasonCode,
    })
  }

  /** Requeue Agent leases whose owner has missed the Worker heartbeat window. */
  async reclaimStaleStoryTaskLeases(): Promise<number> {
    const data = await this.db.rpc<number>('reclaim_stale_story_task_leases', {})
    return typeof data === 'number' ? data : 0
  }

  async claimNextStoryTask(workerId: string, leaseSeconds: number): Promise<StoryTask | null> {
    const data = await this.db.rpc<unknown>('claim_next_story_task', {
      p_worker_id: workerId,
      p_lease_seconds: leaseSeconds,
    })
    const obj = unwrapMaybeObject<Record<string, unknown>>(data)
    if (!obj?.id) return null
    return toStoryTask(obj)
  }

  async claimNextModelConnectivityTest(
    workerId: string,
    leaseSeconds: number,
  ): Promise<ModelConnectivityTestClaim | null> {
    const data = await this.db.rpc<unknown>('claim_next_model_connectivity_test', {
      p_worker_id: workerId,
      p_lease_seconds: leaseSeconds,
    })
    const row = unwrapMaybeObject<Record<string, unknown>>(data)
    if (!row?.id) return null
    const claimToken = row.claim_token
    if (typeof claimToken !== 'string' || claimToken.length === 0) {
      throw new Error('claim_next_model_connectivity_test returned no claim token')
    }
    return {
      id: String(row.id),
      model_config_id: String(row.model_config_id),
      base_url_snapshot: String(row.base_url_snapshot),
      model_name_snapshot: String(row.model_name_snapshot),
      request_timeout_ms_snapshot: Number(row.request_timeout_ms_snapshot ?? 30000),
      /*
       * 这一行是端到端测出来的缺口：只给类型加字段不够，这个 mapper 逐字段构造对象，
       * 漏映射的字段永远是 undefined，于是内网模型被当成公网模型直连。
       *
       * 单测发现不了它 —— 它们直接调 resolveModelNetworkRoute，数据根本没经过这里。
       */
      network_access_mode_snapshot:
        typeof row.network_access_mode_snapshot === 'string'
          ? row.network_access_mode_snapshot
          : undefined,
      claim_token: claimToken,
    }
  }

  heartbeatModelConnectivityTest(input: {
    testId: string; workerId: string; claimToken: string; leaseSeconds: number
  }): Promise<boolean> {
    return this.db.rpc<boolean>('heartbeat_model_connectivity_test', {
      p_test_id: input.testId,
      p_worker_id: input.workerId,
      p_claim_token: input.claimToken,
      p_lease_seconds: input.leaseSeconds,
    })
  }

  getModelSecretForConnectivityTest(input: {
    testId: string; workerId: string; claimToken: string
  }): Promise<string> {
    return this.db.rpc<string>('get_model_secret_for_connectivity_test', {
      p_test_id: input.testId,
      p_worker_id: input.workerId,
      p_claim_token: input.claimToken,
    })
  }

  completeModelConnectivityTest(input: {
    testId: string; workerId: string; claimToken: string; statusCode: number; latencyMs: number
  }): Promise<boolean> {
    return this.db.rpc<boolean>('complete_model_connectivity_test', {
      p_test_id: input.testId,
      p_worker_id: input.workerId,
      p_claim_token: input.claimToken,
      p_status_code: input.statusCode,
      p_latency_ms: input.latencyMs,
    })
  }

  failModelConnectivityTest(input: {
    testId: string; workerId: string; claimToken: string; code: string; message: string
    statusCode?: number | null; latencyMs?: number | null
  }): Promise<boolean> {
    return this.db.rpc<boolean>('fail_model_connectivity_test', {
      p_test_id: input.testId,
      p_worker_id: input.workerId,
      p_claim_token: input.claimToken,
      p_error_code: input.code,
      p_error_message: input.message,
      p_status_code: input.statusCode ?? null,
      p_latency_ms: input.latencyMs ?? null,
    })
  }

  releaseModelConnectivityTestClaim(input: {
    testId: string; workerId: string; claimToken: string
  }): Promise<boolean> {
    return this.db.rpc<boolean>('release_model_connectivity_test_claim', {
      p_test_id: input.testId,
      p_worker_id: input.workerId,
      p_claim_token: input.claimToken,
    })
  }

  // -------------------------------------------------------------------------
  // V1.13 Git 提交邮箱反查队列
  // -------------------------------------------------------------------------

  async claimNextGitEmailDiscovery(
    workerId: string,
    leaseSeconds: number,
  ): Promise<GitEmailDiscoveryClaim | null> {
    const data = await this.db.rpc<unknown>('claim_next_git_email_discovery', {
      p_worker_id: workerId,
      p_lease_seconds: leaseSeconds,
    })
    const row = unwrapMaybeObject<Record<string, unknown>>(data)
    if (!row?.id) return null
    const claimToken = row.claim_token
    const username = row.gitlab_username
    if (typeof claimToken !== 'string' || claimToken.length === 0) {
      throw new Error('claim_next_git_email_discovery returned no claim token')
    }
    if (typeof username !== 'string' || username.length === 0) {
      throw new Error('claim_next_git_email_discovery returned no gitlab username')
    }
    return {
      id: String(row.id),
      gitlab_username: username,
      lookback_days: Number(row.lookback_days ?? 365),
      attempt: Number(row.attempt ?? 1),
      claim_token: claimToken,
    }
  }

  heartbeatGitEmailDiscovery(input: {
    discoveryId: string; workerId: string; claimToken: string; leaseSeconds: number
  }): Promise<boolean> {
    return this.db.rpc<boolean>('heartbeat_git_email_discovery', {
      p_discovery_id: input.discoveryId,
      p_worker_id: input.workerId,
      p_claim_token: input.claimToken,
      p_lease_seconds: input.leaseSeconds,
    })
  }

  /**
   * 回填候选。`candidates[].email` 是明文 —— 数据库在函数内部算 HMAC 后只落指纹与脱敏值。
   * 这与既有的 match_analysis_git_identities 是同一条既定边界：pepper 只在库里。
   */
  async completeGitEmailDiscovery(input: {
    discoveryId: string
    workerId: string
    claimToken: string
    gitlabUserId: string | null
    gitlabDisplayName: string | null
    mergeRequestCount: number
    partial: boolean
    candidates: readonly DiscoveredCommitEmail[]
    /** 读到了但归属于别人的邮箱个数（集成 MR 里别人的提交）。 */
    excludedCandidateCount: number
  }): Promise<{ candidateCount: number }> {
    const data = await this.db.rpc<unknown>('complete_git_email_discovery', {
      p_discovery_id: input.discoveryId,
      p_worker_id: input.workerId,
      p_claim_token: input.claimToken,
      p_gitlab_user_id: input.gitlabUserId,
      p_gitlab_display_name: input.gitlabDisplayName,
      p_merge_request_count: input.mergeRequestCount,
      p_partial: input.partial,
      p_candidates: input.candidates,
      p_excluded_candidate_count: input.excludedCandidateCount,
    })
    const row = unwrapMaybeObject<Record<string, unknown>>(data)
    return { candidateCount: Number(row?.candidate_count ?? 0) }
  }

  failGitEmailDiscovery(input: {
    discoveryId: string; workerId: string; claimToken: string; code: string; message: string
  }): Promise<boolean> {
    return this.db.rpc<boolean>('fail_git_email_discovery', {
      p_discovery_id: input.discoveryId,
      p_worker_id: input.workerId,
      p_claim_token: input.claimToken,
      p_error_code: input.code,
      p_error_message: input.message,
    })
  }

  releaseGitEmailDiscoveryClaim(input: {
    discoveryId: string; workerId: string; claimToken: string
  }): Promise<boolean> {
    return this.db.rpc<boolean>('release_git_email_discovery_claim', {
      p_discovery_id: input.discoveryId,
      p_worker_id: input.workerId,
      p_claim_token: input.claimToken,
    })
  }

  async claimJobForFinalization(workerId: string): Promise<FinalizationClaim | null> {
    const data = await this.db.rpc<unknown>('claim_job_for_finalization', {
      p_worker_id: workerId,
    })
    const obj = unwrapMaybeObject<Record<string, unknown>>(data)
    if (!obj?.job) return null
    return {
      job: obj.job as JobContext,
      model: obj.model as ModelSnapshot,
      snapshots: unwrapArray<RepositorySnapshot>(obj.snapshots),
    }
  }

  /**
   * 续租并读取取消状态。
   *
   * 走 `heartbeat_analysis_attempt` 而不是 V3 的 boolean 版本：用户取消必须在同一次往返里
   * 到达 Worker，否则级联停止要等到下一个轮询周期。
   */
  async heartbeatAttempt(input: {
    taskId: string
    workerId: string
    claimToken: string
    leaseSeconds: number
  }): Promise<AttemptControlState> {
    const data = await this.db.rpc<unknown>('heartbeat_analysis_attempt', {
      p_task_id: input.taskId,
      p_worker_id: input.workerId,
      p_claim_token: input.claimToken,
      p_lease_seconds: input.leaseSeconds,
    })
    const state = unwrapMaybeObject<Record<string, unknown>>(data)
    return {
      leaseHeld: state?.lease_held === true,
      cancelRequested: state?.cancel_requested === true,
      cancelReason: (state?.cancel_reason as string | null) ?? null,
      sealed: state?.sealed === true,
      sessionRevision: Number(state?.session_revision ?? 0),
    }
  }

  async heartbeatStoryTask(input: {
    taskId: string
    workerId: string
    claimToken: string
    leaseSeconds: number
  }): Promise<boolean> {
    const state = await this.heartbeatAttempt(input)
    return state.leaseHeld
  }

  /** 注册一个 Agent Tree 节点。数据库是可信 lineage 的最终仲裁。 */
  async registerAgentNode(
    input: AttemptClaim & {
      agentId: string
      sessionId: string
      parentAgentId: string | null
      agentRole: string
      provider: string
      toolPolicyHash: string
    },
  ): Promise<string> {
    const data = await this.db.rpc<unknown>('register_analysis_agent_node', {
      p_task_id: input.taskId,
      p_worker_id: input.workerId,
      p_claim_token: input.claimToken,
      p_agent_attempt: input.agentAttempt,
      p_agent_id: input.agentId,
      p_session_id: input.sessionId,
      p_parent_agent_id: input.parentAgentId,
      p_agent_role: input.agentRole,
      p_provider: input.provider,
      p_tool_policy_hash: input.toolPolicyHash,
    })
    const row = unwrapMaybeObject<{ node_id?: string }>(data)
    if (!row?.node_id) throw new Error('register_analysis_agent_node returned no node_id')
    return row.node_id
  }

  async markAgentNodeTerminal(
    input: AttemptClaim & { agentId: string; status: string; errorCode?: string },
  ): Promise<void> {
    await this.db.rpc<boolean>('mark_analysis_agent_node_terminal', {
      p_task_id: input.taskId,
      p_worker_id: input.workerId,
      p_claim_token: input.claimToken,
      p_agent_attempt: input.agentAttempt,
      p_agent_id: input.agentId,
      p_status: input.status,
      p_error_code: input.errorCode ?? null,
    })
  }

  async appendToolAudit(
    input: AttemptClaim & {
      entries: ToolAuditRow[]
      decisions: PermissionDecisionRow[]
    },
  ): Promise<void> {
    if (input.entries.length === 0 && input.decisions.length === 0) return
    await this.db.rpc<number>('append_analysis_tool_audit', {
      p_task_id: input.taskId,
      p_worker_id: input.workerId,
      p_claim_token: input.claimToken,
      p_agent_attempt: input.agentAttempt,
      p_entries: input.entries.map((entry) => ({
        agent_id: entry.agentId,
        session_id: entry.sessionId,
        tool_call_id: entry.toolCallId,
        tool_name: entry.toolName,
        permission_verdict: entry.permissionVerdict,
        error_code: entry.errorCode,
        started_at: entry.startedAt,
        finished_at: entry.finishedAt,
        duration_ms: entry.durationMs,
        request_bytes: entry.requestBytes,
        response_bytes: entry.responseBytes,
        skill_name: entry.skillName ?? null,
        skill_bundle_hash: entry.skillBundleHash ?? null,
        resource_relative_path: entry.resourceRelativePath ?? null,
      })),
      p_decisions: input.decisions.map((decision) => ({
        agent_id: decision.agentId,
        agent_role: decision.agentRole,
        tool_name: decision.toolName,
        policy_layer: decision.policyLayer,
        decision: decision.decision,
        reason_code: decision.reasonCode,
      })),
    })
  }

  async saveArtifact(
    input: AttemptClaim & {
      producerAgentId: string
      artifactType: string
      workspacePath: string
      contentHash: string
      sizeBytes: number
    },
  ): Promise<{ artifactId: string }> {
    const data = await this.db.rpc<unknown>('save_analysis_artifact', {
      p_task_id: input.taskId,
      p_worker_id: input.workerId,
      p_claim_token: input.claimToken,
      p_agent_attempt: input.agentAttempt,
      p_producer_agent_id: input.producerAgentId,
      p_artifact_type: input.artifactType,
      p_workspace_path: input.workspacePath,
      p_content_hash: input.contentHash,
      p_size_bytes: input.sizeBytes,
      p_storage_locator: null,
    })
    const row = unwrapMaybeObject<{ artifact_id: string }>(data)
    return { artifactId: row?.artifact_id ?? '' }
  }

  async saveSessionCheckpoint(
    input: AttemptClaim & {
      sessionId: string
      sessionRevision: number
      storageLocator: string
      contentHash: string
      eventCount: number
      harnessVersion: string
      profileHash: string | null
      /** V1.6：本次 attempt 实际物化的技能目录身份。恢复门禁按它比对。 */
      skillCatalogHash?: string | null
      /** V1.11：Worker profile 中的完整 scope continuity identity。 */
      analysisScopeHash?: string | null
      /** V1.11：当前 Attempt 冻结的归因规则身份。 */
      attributionRulesetHash?: string | null
      /**
       * V1.9：`contentHash` 覆盖的前缀字节数。
       *
       * 在途 checkpoint 每分钟写一次，而日志同时还在被追加。不带这个值时恢复侧只能拿
       * 整文件哈希比对，而它必然不等 —— 那就是"恢复机器全在、但没有一次恢复能通过"。
       */
      prefixBytes?: number | null
    },
  ): Promise<void> {
    await this.db.rpc<unknown>('save_analysis_session_checkpoint', {
      p_task_id: input.taskId,
      p_worker_id: input.workerId,
      p_claim_token: input.claimToken,
      p_agent_attempt: input.agentAttempt,
      p_session_id: input.sessionId,
      p_session_revision: input.sessionRevision,
      p_storage_locator: input.storageLocator,
      p_content_hash: input.contentHash,
      p_event_count: input.eventCount,
      p_harness_version: input.harnessVersion,
      p_profile_hash: input.profileHash,
      p_status: 'OPEN',
      p_skill_catalog_hash: input.skillCatalogHash ?? null,
      p_prefix_bytes: input.prefixBytes ?? null,
      p_analysis_scope_hash: input.analysisScopeHash ?? null,
      p_attribution_ruleset_hash: input.attributionRulesetHash ?? null,
    })
  }

  /**
   * 取 Job 冻结的技能目录（V1.6）。
   *
   * claim-fenced：RPC 校验四要素后才返回 locator。Worker 从不接受浏览器、模型或 Story
   * 自报的 bucket/key —— 这是唯一入口。
   */
  async getStoryTaskSkillSnapshot(input: {
    taskId: string
    workerId: string
    claimToken: string
  }): Promise<Record<string, unknown> | null> {
    const data = await this.db.rpc<unknown>('get_story_task_skill_snapshot', {
      p_task_id: input.taskId,
      p_worker_id: input.workerId,
      p_claim_token: input.claimToken,
    })
    return unwrapMaybeObject<Record<string, unknown>>(data)
  }

  /** 找回一个可恢复的 attempt。返回 null 表示不可恢复（已提交、已封存或无 checkpoint）。 */
  async loadResumableAttempt(input: {
    taskId: string
    workerId: string
    claimToken: string
  }): Promise<Record<string, unknown> | null> {
    const data = await this.db.rpc<unknown>('load_resumable_analysis_attempt', {
      p_task_id: input.taskId,
      p_worker_id: input.workerId,
      p_claim_token: input.claimToken,
      /*
       * V1.9：显式开启跨 attempt 恢复。
       *
       * 默认 false 是给**还没升级的 Worker** 留的安全网：它们不认识
       * `source_agent_attempt`，会按自己的 attempt 号派生路径，于是 profile hash 必然
       * 不匹配，而它们的拒绝路径是 fail closed —— 一份历史 checkpoint 会把这个 task 的
       * 每一次新 attempt 都毒死。这个 Worker 认识它，所以显式传 true。
       */
      p_allow_cross_attempt: true,
    })
    return unwrapMaybeObject<Record<string, unknown>>(data)
  }

  async recordAttemptProfile(
    input: AttemptClaim & {
      harnessVersion: string
      capabilityContractHash: string
      profileHash: string
      policyHash: string
      rootAgentId: string
      rootSessionId: string
      treeDigest: string
      /**
       * V1.6：Worker 独立重算出来的技能目录身份。
       *
       * RPC 会把它与 `analysis_job.skill_catalog_hash` 比对，不等即抛
       * `SESSION_SKILL_SET_MISMATCH`。这是"Worker 不能相信数据库自报的 hash"这条要求
       * 的兑现点 —— 两边各算一次，然后在数据库里对账。
       */
      skillCatalogHash?: string | null
    },
  ): Promise<void> {
    await this.db.rpc<boolean>('record_analysis_attempt_profile', {
      p_task_id: input.taskId,
      p_worker_id: input.workerId,
      p_claim_token: input.claimToken,
      p_agent_attempt: input.agentAttempt,
      p_harness_version: input.harnessVersion,
      p_capability_contract_hash: input.capabilityContractHash,
      p_profile_hash: input.profileHash,
      p_policy_hash: input.policyHash,
      p_root_agent_id: input.rootAgentId,
      p_root_session_id: input.rootSessionId,
      p_tree_digest: input.treeDigest,
      p_skill_catalog_hash: input.skillCatalogHash ?? null,
    })
  }

  /** 请求取消一个 attempt（运维熔断路径；用户取消由前端调用同一个 RPC）。 */
  async requestAttemptCancel(taskId: string, reason: string): Promise<boolean> {
    const ok = await this.db.rpc<boolean>('request_analysis_attempt_cancel', {
      p_task_id: taskId,
      p_reason: reason,
    })
    return ok === true
  }

  /**
   * 在数据库侧预留一次模型请求。
   *
   * 内存里的 `HierarchicalBudgetLedger` 是本 attempt 的权威闸门（同步、无往返，能在 provider
   * 调用前原子拦截）；这个 RPC 是第二道：它按 claim token 与租约校验调用方，所以一个已经
   * 被接管的旧 Worker 的预留会失败 —— 这正是"迟到的 usage 不能算进新 attempt"所需的
   * fencing，同时把分层计数落成可查询的真实值。
   */
  async reserveAgentBudget(
    input: AttemptClaim & { agentId: string; kind: string; count?: number },
  ): Promise<{ allowed: boolean; scope: string | null }> {
    const row = await this.db.rpc<{ allowed?: boolean; scope?: string } | null>(
      'reserve_analysis_agent_budget',
      {
        p_task_id: input.taskId,
        p_worker_id: input.workerId,
        p_claim_token: input.claimToken,
        p_agent_attempt: input.agentAttempt,
        p_agent_id: input.agentId,
        p_kind: input.kind,
        p_count: input.count ?? 1,
      },
    )
    return { allowed: row?.allowed === true, scope: row?.scope ?? null }
  }

  /**
   * 落真实 usage。
   *
   * 在**每条**终态路径上调用，不只是提交成功那条：失败、取消、预算耗尽的 attempt 同样烧了
   * 模型请求和 token，如果只在 `save_agent_review_result` 里带 usage，这些花费在库里就是 0，
   * 成本告警和配额核对都会失真。RPC 用 `greatest(...)` 单调更新，重复调用安全。
   */
  async commitAgentUsage(
    input: AttemptClaim & {
      usage: Record<string, number | null>
      perAgent: Array<Record<string, string | number | null>>
    },
  ): Promise<boolean> {
    const ok = await this.db.rpc<boolean>('commit_analysis_agent_usage', {
      p_task_id: input.taskId,
      p_worker_id: input.workerId,
      p_claim_token: input.claimToken,
      p_agent_attempt: input.agentAttempt,
      p_usage: input.usage,
      p_per_agent: input.perAgent,
    })
    return ok === true
  }

  heartbeatAnalysisWorker(input: {
    workerId: string
    slots: number
    current: number
    capabilities?: Record<string, unknown>
    signal?: AbortSignal
  }): Promise<void> {
    return this.db.rpc<void>(
      'heartbeat_analysis_worker',
      {
        p_worker_id: input.workerId,
        p_slots: input.slots,
        p_current: input.current,
        p_capabilities: input.capabilities ?? {},
      },
      { signal: input.signal },
    )
  }

  async releaseStoryTaskClaim(input: {
    taskId: string
    workerId: string
    claimToken: string
  }): Promise<boolean> {
    const released = await this.db.rpc<boolean>('release_story_task_claim', {
      p_task_id: input.taskId,
      p_worker_id: input.workerId,
      p_claim_token: input.claimToken,
    })
    return released === true
  }

  getModelSecretForStoryTask(input: {
    taskId: string
    workerId: string
    claimToken: string
  }): Promise<string> {
    return this.db.rpc<string>('get_model_secret_for_story_task', {
      p_task_id: input.taskId,
      p_worker_id: input.workerId,
      p_claim_token: input.claimToken,
    })
  }

  async saveAgentReviewResult(input: {
    taskId: string
    workerId: string
    claimToken: string
    agentAttempt: number
    result: Record<string, unknown>
    evidence: unknown[]
    usage: AgentRunUsage
    configHash: string | null
    promptVersion: string | null
    modelLabel: string | null
    scopeGeneration?: number | null
    triageRevision?: number | null
    candidateManifestHash?: string | null
    analysisScopeHash?: string | null
    attributionRulesetHash?: string | null
  }): Promise<AgentReviewCommitReceipt> {
    const data = await this.db.rpc<unknown>('save_agent_review_result', {
      p_task_id: input.taskId,
      p_worker_id: input.workerId,
      p_claim_token: input.claimToken,
      p_agent_attempt: input.agentAttempt,
      p_result: input.result,
      p_evidence: input.evidence,
      p_usage: input.usage,
      p_config_hash: input.configHash,
      p_prompt_version: input.promptVersion,
      p_model_label: input.modelLabel,
      p_scope_generation: input.scopeGeneration ?? null,
      p_triage_revision: input.triageRevision ?? null,
      p_candidate_manifest_hash: input.candidateManifestHash ?? null,
      p_analysis_scope_hash: input.analysisScopeHash ?? null,
      p_attribution_ruleset_hash: input.attributionRulesetHash ?? null,
    })
    const receipt = unwrapMaybeObject<AgentReviewCommitReceipt>(data)
    if (!receipt?.run_id) throw new Error('save_agent_review_result returned no receipt')
    return receipt
  }

  failAgentReview(input: {
    taskId: string
    workerId: string
    claimToken: string
    code: string
    message: string
  }): Promise<void> {
    return this.db.rpc<void>('fail_agent_review', {
      p_task_id: input.taskId,
      p_worker_id: input.workerId,
      p_claim_token: input.claimToken,
      p_error_code: input.code,
      p_error_message: input.message,
    })
  }

  async listCompletedStoryTasks(jobId: string): Promise<CompletedStoryTask[]> {
    const data = await this.db.rpc<unknown>('list_completed_story_tasks', {
      p_job_id: jobId,
    })
    return unwrapArray<CompletedStoryTask>(data)
  }

  completeAnalysisJob(input: {
    jobId: string
    workerId: string
    results: unknown[]
    evidence: unknown[]
  }): Promise<void> {
    return this.db.rpc<void>('complete_analysis_job', {
      p_job_id: input.jobId,
      p_worker_id: input.workerId,
      p_results: input.results,
      p_evidence: input.evidence,
    })
  }

  failClaimedAnalysisJob(input: {
    jobId: string
    workerId: string
    code: string
    message: string
  }): Promise<void> {
    return this.db.rpc<void>('fail_claimed_analysis_job', {
      p_job_id: input.jobId,
      p_worker_id: input.workerId,
      p_error_code: input.code,
      p_error_message: input.message,
    })
  }

  /**
   * 一次往返写多条运行监控事件（0032 §6.6）。
   *
   * fencing 分层由数据库负责：无 task 的 JOB 阶段看 `analysis_job.worker_id` /
   * `finalizer_worker_id` + lease，task 及以下看四要素，收敛路径（claim 已被清空）
   * 看 `session_revision`。这里只负责把上下文原样传过去 —— 客户端不做任何"校验不了
   * 就放行"的兜底。
   */
  async reportRuntimeEventBatch(
    input: RuntimeEventTarget & { events: RuntimeEventWire[] },
  ): Promise<RuntimeEventBatchResult> {
    const data = await this.db.rpc<unknown>('report_analysis_runtime_event_batch', {
      p_worker_id: input.workerId,
      p_job_id: input.jobId,
      p_task_id: input.taskId ?? null,
      p_claim_token: input.claimToken ?? null,
      p_agent_attempt: input.agentAttempt ?? null,
      p_events: input.events,
      p_session_revision: input.sessionRevision ?? null,
    })
    const row = unwrapMaybeObject<Partial<RuntimeEventBatchResult>>(data)
    return {
      accepted: Number(row?.accepted ?? 0),
      duplicated: Number(row?.duplicated ?? 0),
      dropped_unresolved_agent: Number(row?.dropped_unresolved_agent ?? 0),
      dropped_invalid: Number(row?.dropped_invalid ?? 0),
      max_event_id:
        row?.max_event_id === null || row?.max_event_id === undefined
          ? null
          : Number(row.max_event_id),
    }
  }

  /**
   * 保留期清理。按批限量：一次删太多会持有长事务，把 §6.1.3 的游标水位卡住。
   * 汇总表 `analysis_agent_run_rollup` 不参与清理。
   */
  async purgeRuntimeEvents(limit = 50000): Promise<number> {
    const data = await this.db.rpc<number>('purge_analysis_runtime_events', {
      p_limit: limit,
    })
    return typeof data === 'number' ? data : 0
  }


  /** Attempt 事件已经收敛后，按 run 精确重算长期 rollup。 */
  async computeRunRollup(agentRunId: string): Promise<void> {
    await this.db.rpc<unknown>('compute_analysis_run_rollup', {
      p_agent_run_id: agentRunId,
    })
  }
  /** 补算终态但汇总缺失（或 `rollup_version = 0`）的 attempt。 */
  async backfillRunRollups(limit = 200): Promise<{ computed: number; failed: number }> {
    const data = await this.db.rpc<unknown>('backfill_analysis_run_rollups', {
      p_limit: limit,
    })
    const row = unwrapMaybeObject<{ computed?: number; failed?: number }>(data)
    return { computed: Number(row?.computed ?? 0), failed: Number(row?.failed ?? 0) }
  }

  // -------------------------------------------------------------------------
  // V1.19 技能 AI 优化
  // -------------------------------------------------------------------------

  /**
   * 认领一条技能 AI 优化任务。
   *
   * 逐字段构造返回对象而不是 `data as Claim`：这个 mapper 漏一个字段的后果是运行时
   * `undefined`（例如 base_url 变成 undefined，请求发到 `undefined/chat/completions`），
   * 而类型检查看不见它。V1.7 的连接测试链路真实踩过同一个坑。
   */
  async claimNextSkillAiOptimization(workerId: string): Promise<SkillAiOptimizationClaim | null> {
    const data = await this.db.rpc<unknown>('claim_next_skill_ai_optimization_task', {
      p_worker_id: workerId,
    })
    const row = unwrapMaybeObject<Record<string, unknown>>(data)
    if (!row?.request_id) return null
    const claimToken = row.claim_token
    if (typeof claimToken !== 'string' || claimToken.length === 0) {
      throw new Error('claim_next_skill_ai_optimization_task returned no claim token')
    }
    return {
      request_id: String(row.request_id),
      claim_token: claimToken,
      skill_id: String(row.skill_id),
      skill_name: String(row.skill_name),
      requested_by: String(row.requested_by),
      source_version_id: String(row.source_version_id),
      source_version: Number(row.source_version ?? 0),
      archive_bucket: String(row.archive_bucket),
      archive_object_key: String(row.archive_object_key),
      archive_sha256: String(row.archive_sha256),
      base_url_snapshot: String(row.base_url_snapshot),
      model_name_snapshot: String(row.model_name_snapshot),
      request_timeout_ms_snapshot: Number(row.request_timeout_ms_snapshot ?? 180000),
      network_access_mode_snapshot:
        typeof row.network_access_mode_snapshot === 'string'
          ? row.network_access_mode_snapshot
          : undefined,
    }
  }

  heartbeatSkillAiOptimization(input: SkillAiOptimizationClaimRef): Promise<boolean> {
    return this.db.rpc<boolean>('heartbeat_skill_ai_optimization_task', {
      p_request_id: input.requestId,
      p_worker_id: input.workerId,
      p_claim_token: input.claimToken,
    })
  }

  getModelSecretForSkillAiOptimization(input: SkillAiOptimizationClaimRef): Promise<string> {
    return this.db.rpc<string>('get_model_secret_for_skill_ai_optimization', {
      p_request_id: input.requestId,
      p_worker_id: input.workerId,
      p_claim_token: input.claimToken,
    })
  }

  /** 与管理员侧 `admin_get_skill_review_evidence` 同口径，门禁换成 claim_token。 */
  async getSkillReviewEvidenceForOptimization(
    input: SkillAiOptimizationClaimRef,
  ): Promise<SkillReviewEvidenceSnapshot> {
    const data = await this.db.rpc<unknown>('get_skill_review_evidence_for_optimization', {
      p_request_id: input.requestId,
      p_worker_id: input.workerId,
      p_claim_token: input.claimToken,
    })
    const row = unwrapMaybeObject<Record<string, unknown>>(data)
    const samples = Array.isArray(row?.sample_findings) ? row.sample_findings : []
    const batches = Array.isArray(row?.referenced_batches) ? row.referenced_batches : []
    return {
      referenced_job_count: Number(row?.referenced_job_count ?? 0),
      verdict_counts: (row?.verdict_counts ?? {}) as Record<string, number>,
      human_review_counts: (row?.human_review_counts ?? {}) as Record<string, number>,
      referenced_batches: batches.map((batch) => {
        const entry = batch as Record<string, unknown>
        return {
          batch_id: String(entry.batch_id ?? ''),
          batch_name: String(entry.batch_name ?? ''),
          week_code: typeof entry.week_code === 'string' ? entry.week_code : null,
          job_id: String(entry.job_id ?? ''),
          job_status: typeof entry.job_status === 'string' ? entry.job_status : null,
          job_created_at: typeof entry.job_created_at === 'string' ? entry.job_created_at : null,
          skill_version:
            typeof entry.skill_version === 'number' ? entry.skill_version : null,
          result_count: Number(entry.result_count ?? 0),
        }
      }),
      sample_findings: samples.map((sample) => {
        const entry = sample as Record<string, unknown>
        return {
          story_code: String(entry.story_code ?? ''),
          verdict: String(entry.verdict ?? ''),
          summary: String(entry.summary ?? ''),
          human_review_result:
            typeof entry.human_review_result === 'string' ? entry.human_review_result : null,
          human_review_comment:
            typeof entry.human_review_comment === 'string' ? entry.human_review_comment : null,
        }
      }),
    }
  }

  /**
   * 注册一次 staging 上传。
   *
   * `p_actor_id` 是**请求这次优化的管理员**，不是 Worker：`admin_register_skill_upload` 的
   * 第一句是 `assert_actor_is_admin`，而 service_role 调用时 `auth.uid()` 是 null。
   * 换句话说 AI 产出走的是与人工上传完全相同的那一条 RPC，只是替管理员按了按钮。
   */
  async registerSkillUpload(input: {
    actorId: string
    skillId: string
    stagingObjectKey: string
  }): Promise<string> {
    const data = await this.db.rpc<string>('admin_register_skill_upload', {
      p_actor_id: input.actorId,
      p_skill_id: input.skillId,
      p_staging_object_key: input.stagingObjectKey,
    })
    if (typeof data !== 'string' || data.length === 0) {
      throw new Error('admin_register_skill_upload returned no upload id')
    }
    return data
  }

  /** 与人工上传共用的校验落库 RPC。数据库会用 `skill_bundle_hash()` 重算 bundle hash。 */
  async recordSkillUploadValidation(input: {
    actorId: string
    uploadId: string
    archiveSha256: string
    archiveSizeBytes: number
    bundleManifest: unknown
    expandedSizeBytes: number
    fileCount: number
    containsScripts: boolean
    entryFrontmatter: unknown
  }): Promise<string> {
    const data = await this.db.rpc<unknown>('admin_record_skill_upload_validation', {
      p_actor_id: input.actorId,
      p_upload_id: input.uploadId,
      p_archive_sha256: input.archiveSha256,
      p_archive_size_bytes: input.archiveSizeBytes,
      p_bundle_manifest: input.bundleManifest,
      p_expanded_size_bytes: input.expandedSizeBytes,
      p_file_count: input.fileCount,
      p_contains_scripts: input.containsScripts,
      p_entry_frontmatter: input.entryFrontmatter,
    })
    const row = unwrapMaybeObject<{ bundle_hash?: string }>(data)
    return String(row?.bundle_hash ?? '')
  }

  /** 校验失败也落库：只在 HTTP 响应里出现的原因，管理员刷新页面后就看不到了。 */
  async recordSkillUploadFailure(input: {
    actorId: string
    uploadId: string
    errorCode: string
    errorMessage: string
  }): Promise<void> {
    await this.db.rpc<boolean>('admin_record_skill_upload_failure', {
      p_actor_id: input.actorId,
      p_upload_id: input.uploadId,
      p_error_code: input.errorCode,
      p_error_message: input.errorMessage,
    })
  }

  submitSkillAiOptimizationResult(
    input: SkillAiOptimizationClaimRef & {
      uploadId: string
      changedPaths: string[]
      aiSummary: string
      /** 调用模型的次数（含自检不通过后的重写）。 */
      modelAttempts: number
    },
  ): Promise<unknown> {
    return this.db.rpc<unknown>('submit_skill_ai_optimization_result', {
      p_request_id: input.requestId,
      p_worker_id: input.workerId,
      p_claim_token: input.claimToken,
      p_upload_id: input.uploadId,
      p_changed_paths: input.changedPaths,
      p_ai_summary: input.aiSummary,
      p_model_attempts: input.modelAttempts,
    })
  }

  submitSkillAiOptimizationFailure(
    input: SkillAiOptimizationClaimRef & {
      errorCode: string
      errorMessage: string
      modelAttempts: number
    },
  ): Promise<unknown> {
    return this.db.rpc<unknown>('submit_skill_ai_optimization_failure', {
      p_request_id: input.requestId,
      p_worker_id: input.workerId,
      p_claim_token: input.claimToken,
      p_error_code: input.errorCode,
      p_error_message: input.errorMessage,
      p_model_attempts: input.modelAttempts,
    })
  }

  async reclaimStaleSkillAiOptimizationLeases(): Promise<number> {
    const data = await this.db.rpc<number>('reclaim_stale_skill_ai_optimization_leases', {})
    return typeof data === 'number' ? data : 0
  }

  // --------------------------------------------------------------------------
  // V1.20 Linky 批次需求导入队列。
  //
  // 与模型连接测试队列同一套形状：claim 拿到一次性 token，之后每一次写入都带 token 过
  // fencing。逐条提交而不是整批提交，所以进度条是真的，中途失败也不会把已落库的需求回滚。
  // --------------------------------------------------------------------------

  async claimNextLinkyBatchImport(
    workerId: string,
    leaseSeconds: number,
  ): Promise<LinkyBatchImportClaim | null> {
    const data = await this.db.rpc<unknown>('claim_next_linky_batch_import', {
      p_worker_id: workerId,
      p_lease_seconds: leaseSeconds,
    })
    const row = unwrapMaybeObject<Record<string, unknown>>(data)
    if (!row?.id) return null
    const claimToken = row.claim_token
    if (typeof claimToken !== 'string' || claimToken.length === 0) {
      throw new Error('claim_next_linky_batch_import returned no claim token')
    }
    const codes = Array.isArray(row.story_codes)
      ? row.story_codes.filter((code): code is string => typeof code === 'string')
      : []
    return {
      id: String(row.id),
      batch_id: String(row.batch_id),
      workspace_id: typeof row.workspace_id === 'string' ? row.workspace_id : null,
      workspace_name: typeof row.workspace_name === 'string' ? row.workspace_name : '',
      release_window: typeof row.release_window === 'string' ? row.release_window : null,
      story_codes: codes,
      claim_token: claimToken,
      attempt: typeof row.attempt === 'number' ? row.attempt : 0,
    }
  }

  async heartbeatLinkyBatchImport(input: {
    requestId: string
    workerId: string
    claimToken: string
    leaseSeconds: number
  }): Promise<boolean> {
    const data = await this.db.rpc<unknown>('heartbeat_linky_batch_import', {
      p_request_id: input.requestId,
      p_worker_id: input.workerId,
      p_claim_token: input.claimToken,
      p_lease_seconds: input.leaseSeconds,
    })
    return data === true
  }

  async commitLinkyBatchStory(input: {
    requestId: string
    workerId: string
    claimToken: string
    story: Record<string, unknown>
    attachments: CommittedAttachment[]
  }): Promise<string> {
    const data = await this.db.rpc<unknown>('commit_linky_batch_story', {
      p_request_id: input.requestId,
      p_worker_id: input.workerId,
      p_claim_token: input.claimToken,
      p_story: input.story,
      p_attachments: input.attachments,
    })
    return typeof data === 'string' ? data : ''
  }

  async recordLinkyBatchStoryFailure(input: {
    requestId: string
    workerId: string
    claimToken: string
    storyCode: string
    errorCode: string
    errorMessage: string
    attachmentsFailed: number
  }): Promise<boolean> {
    const data = await this.db.rpc<unknown>('record_linky_batch_story_failure', {
      p_request_id: input.requestId,
      p_worker_id: input.workerId,
      p_claim_token: input.claimToken,
      p_story_code: input.storyCode,
      p_error_code: input.errorCode,
      p_error_message: input.errorMessage,
      p_attachments_failed: input.attachmentsFailed,
    })
    return data === true
  }

  async completeLinkyBatchImport(input: {
    requestId: string
    workerId: string
    claimToken: string
  }): Promise<boolean> {
    const data = await this.db.rpc<unknown>('complete_linky_batch_import', {
      p_request_id: input.requestId,
      p_worker_id: input.workerId,
      p_claim_token: input.claimToken,
    })
    return data === true
  }

  async failLinkyBatchImport(input: {
    requestId: string
    workerId: string
    claimToken: string
    errorCode: string
    errorMessage: string
  }): Promise<boolean> {
    const data = await this.db.rpc<unknown>('fail_linky_batch_import', {
      p_request_id: input.requestId,
      p_worker_id: input.workerId,
      p_claim_token: input.claimToken,
      p_error_code: input.errorCode,
      p_error_message: input.errorMessage,
    })
    return data === true
  }

  async releaseLinkyBatchImportClaim(input: {
    requestId: string
    workerId: string
    claimToken: string
  }): Promise<boolean> {
    const data = await this.db.rpc<unknown>('release_linky_batch_import_claim', {
      p_request_id: input.requestId,
      p_worker_id: input.workerId,
      p_claim_token: input.claimToken,
    })
    return data === true
  }

  /** 附件对象的孤儿判定：批次删除会级联掉引用行，Storage 对象需要另行回收。 */
  async unreferencedStoryAttachmentPaths(paths: string[]): Promise<string[]> {
    if (paths.length === 0) return []
    const data = await this.db.rpc<unknown>('unreferenced_story_attachment_paths', {
      p_paths: paths,
    })
    return Array.isArray(data) ? data.filter((path): path is string => typeof path === 'string') : []
  }
}
