export type BatchStatus = 'DRAFT' | 'WAITING_AI_RESULT' | 'REVIEWING' | 'COMPLETED'

export type AiVerdict = 'IMPLEMENTED' | 'PARTIAL' | 'NOT_IMPLEMENTED' | 'UNCERTAIN'

export type HumanReviewResult = 'CORRECT' | 'PARTIALLY_CORRECT' | 'INCORRECT' | 'NEED_DISCUSSION'

export type UserRole = 'ADMIN' | 'REVIEWER' | 'VIEWER'

export type ImportFileType = 'SOURCE' | 'AI_RESULT' | 'TEMPLATE'

export type EvidenceType = '现有实现' | '缺失依据' | '风险依据'

export type DefaultBranch = 'feature_dev' | 'feature_sit' | 'release'

export interface BaselineCommitEntry {
  repository: string
  sha: string
  subject?: string
}

export interface BaselineCommit {
  actual_branch: string
  commits: BaselineCommitEntry[]
}

export interface UserProfile {
  id: string
  display_name: string | null
  role: UserRole
}

export interface AdminUserListItem {
  id: string
  email: string
  display_name: string | null
  role: UserRole
  /**
   * 邮箱验证时间，null 表示注册后一直没点验证邮件、当前无法登录。
   * 注意 user_profile 行在注册瞬间就由触发器建好了，所以「列表里有这个人」不代表能登录。
   */
  email_confirmed_at: string | null
  /** 最近一次登录时间，null 表示从未成功登录过。 */
  last_sign_in_at: string | null
  created_at: string
  updated_at: string
}

export interface ReviewBatch {
  id: string
  name: string
  week_code: string
  status: BatchStatus
  default_branch: string | null
  remark: string | null
  created_by: string | null
  completed_at: string | null
  ai_model_config_id: string | null
  ai_model_snapshot: AiModelSnapshot | null
  created_at: string
  updated_at: string
}

export interface ReviewBatchListItem extends ReviewBatch {
  creator_name: string | null
  /**
   * V1.62：这批需求来自哪些项目组。由列表 RPC 聚合得到，不是 review_batch 的列。
   * 可能为多个（同一批次可以发起多次导入），也可能为空数组
   * （Excel 时代导入的历史批次没有项目组，如实留空而不是编一个）。
   */
  workspace_names: string[]
}

// ---------------------------------------------------------------------------
// AI 自动化 MVP：模型配置与分析任务（前端仅使用无密钥类型）
// ---------------------------------------------------------------------------

/** 模型配置摘要：前端唯一可见的模型信息，绝不包含 API Key 或 secret UUID。 */
/**
 * 模型的网络类型（V1.7 阶段二）。
 *
 * `DIRECT` 公网模型：Worker 直接请求。
 * `HOST_PROXY` 内网模型：Worker 经宿主机本机代理请求。
 *
 * 它取代了原先"在代理侧维护目标域名白名单"的做法——那层判断放错了地方，既误伤公网模型
 * （被代理拒成 403），又漏掉了正式评审链路。
 */
export type ModelNetworkAccessMode = 'DIRECT' | 'HOST_PROXY'

export interface AiModelConfigSummary {
  id: string
  display_name: string
  base_url: string
  model_name: string
  enabled: boolean
  has_api_key: boolean
  max_parallel_tasks: number
  request_timeout_ms: number
  /** 缺省视为 `DIRECT`：既有配置在本次改造前后行为一致。 */
  network_access_mode?: ModelNetworkAccessMode
  /** 仅 admin_list_model_configs 返回。 */
  context_window?: number
  max_output_tokens?: number
  /**
   * 请求次数预算，模型页只读不写。
   *
   * 写入口只有「默认能力策略」页（admin_update_v4_capability_policy）：retry / compaction
   * 两列是 build_v4_capability_policy 的取值来源，agent_max_model_requests 只剩兜底用途
   * （0027 之前创建、仍在途的 Job 没有 policy snapshot 时用它拼最小预算）。
   */
  agent_max_model_requests?: number
  agent_max_retry_requests?: number
  agent_max_compaction_requests?: number
  /** 仅 admin_list_model_configs 返回；true 表示已被批次或分析任务引用。 */
  is_referenced?: boolean
  created_by?: string | null
  created_at: string
  updated_at: string
}

export type ModelConnectivityTestStatus = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED'

/** Worker 执行的模型连接测试安全结果，不含 URL、密钥、租约或 claim token。 */
export interface ModelConnectivityTest {
  id: string
  model_config_id: string
  status: ModelConnectivityTestStatus
  attempt: number
  status_code: number | null
  latency_ms: number | null
  error_code: string | null
  error_message: string | null
  started_at: string | null
  finished_at: string | null
  created_at: string
  updated_at: string
}

/** 模型当前展示名称：历史页面只读取这两个非敏感字段。 */
export interface AiModelDisplayName {
  id: string
  display_name: string
}

/** 批次/任务保存的模型快照，不含密钥。 */
export interface AiModelSnapshot {
  model_config_id: string
  display_name: string
  base_url: string
  model_name: string
  max_parallel_tasks?: number
  request_timeout_ms?: number
  context_window?: number
  max_output_tokens?: number
  agent_max_model_requests?: number
  agent_max_retry_requests?: number
  agent_max_compaction_requests?: number
}

export type AnalysisJobStatus =
  | 'QUEUED'
  | 'PREPARING_CODE'
  | 'PREPARING_SCOPE'
  | 'PROCESSING'
  | 'FINALIZING'
  | 'SUCCEEDED'
  | 'FAILED'

export interface AnalysisJob {
  id: string
  batch_id: string
  model_config_id: string
  model_snapshot: AiModelSnapshot | null
  requested_branch: DefaultBranch
  status: AnalysisJobStatus
  /** 仅用于读取历史任务来源；新任务恒为 deepseek-harness-acp。 */
  execution_engine: 'legacy-openai' | 'deepseek-harness-acp'
  requested_by: string
  worker_id: string | null
  finalizer_worker_id?: string | null
  attempt: number
  total_stories: number
  analysis_context_version?: 1 | 2
  commit_window_days?: 7 | 14 | 21 | 28
  scope_status?: 'LEGACY' | 'PREPARING' | 'READY' | 'DEGRADED' | 'FAILED'
  error_code: string | null
  error_message: string | null
  locked_at: string | null
  started_at: string | null
  finished_at: string | null
  created_at: string
  updated_at: string
}

export interface AnalysisRepositorySnapshot {
  id: string
  job_id: string
  repository_name: string
  requested_branch: DefaultBranch
  commit_sha: string
  commit_subject: string | null
  prepared_at: string
}

export type StoryTaskStatus = 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED'

export interface AnalysisStoryTask {
  id: string
  job_id: string
  story_id: string
  agent_status: StoryTaskStatus
  agent_attempt: number
  agent_model: string | null
  agent_prompt_version: string | null
  worker_id: string | null
  lease_expires_at: string | null
  heartbeat_at: string | null
  error_code: string | null
  error_message: string | null
  started_at: string | null
  finished_at: string | null
  created_at: string
  updated_at: string
}

/** join review_story 后带需求编号/名称的任务视图（用于前端展示编号）。 */
export interface AnalysisStoryTaskWithStory extends AnalysisStoryTask {
  review_story: { story_code: string; story_name: string } | null
}

export type AnalysisWorkerPhase = 'PREPARING' | 'AGENT' | 'FINALIZING'

export interface AnalysisWorkerAssignment {
  phase: AnalysisWorkerPhase
  batch_id: string
  batch_name: string
  week_code: string
  batch_status: BatchStatus
  job_id: string
  job_status: AnalysisJobStatus
  requested_branch: DefaultBranch
  job_started_at: string | null
  task_id: string | null
  story_id: string | null
  story_code: string | null
  story_name: string | null
  heartbeat_at: string | null
  lease_expires_at: string | null
}

/** A valid task lease that belongs to a Worker without a current heartbeat. */
export interface AnalysisRecoveryLease extends AnalysisWorkerAssignment {
  worker_id: string
}

export interface AnalysisWorkerDetail {
  worker_id: string
  slots: number
  reported_current_tasks: number
  last_seen_at: string
  online: boolean
  working: boolean
  assignments: AnalysisWorkerAssignment[]
}

export interface AnalysisWorkerOverview {
  generated_at: string
  online_count: number
  working_count: number
  idle_count: number
  total_slots: number
  reported_current_tasks: number
  workers: AnalysisWorkerDetail[]
}

export interface ReviewStory {
  id: string
  batch_id: string
  story_code: string
  story_name: string
  description: string | null
  acceptance_criteria: string | null
  /** 负责人。新版导出映射自「开发人员」，旧版导出映射自「负责人」。 */
  owners_text: string
  /** 需求人员。新版导出（tf_req_handlers）才有，历史批次为 null。 */
  requirement_handlers: string | null
  /** 测试人员。新版导出（tf_test_handlers）才有，历史批次为 null。 */
  test_handlers: string | null
  project_name: string | null
  /**
   * @deprecated 需求平台已没有云维度，导入不再写入、前端不再展示。列仅为历史批次保留，
   * 详见 supabase/migrations/0040_retire_story_cloud_name.sql。
   */
  cloud_name: string | null
  /**
   * @deprecated 新版导出没有应用维度，导入不再写入、前端不再展示。列仅为历史批次保留。
   * 详见 supabase/migrations/0038_story_requirement_test_handlers.sql。
   */
  application_name: string | null
  /**
   * @deprecated 只关注发布窗口，迭代阶段维度已下线：导入不再写入、前端不再展示。
   * 列仅为历史批次保留，详见 supabase/migrations/0039_retire_story_iteration_name.sql。
   */
  iteration_name: string | null
  release_window: string | null
  /** 需求在源系统里的状态，例如「提测完成」「基线测试完成」。看板按它分组。 */
  source_status: string | null
  source_data: Record<string, unknown>
  /** V1.20：需求来源通道。EXCEL 为历史批次，LINKY 为直连接口导入。 */
  source_system: 'EXCEL' | 'LINKY'
  /** V1.20：需求正文（Linky field_values.gf_description）。历史批次为 null。 */
  requirement_detail: string | null
  /** V1.20：关联特性。 */
  subject_name: string | null
  linky_issue_id: string | null
  linky_workspace_id: string | null
  /** V1.20：项目组（Linky 工作区名）。 */
  linky_workspace_name: string | null
  /** V1.20：回到 Linky 看原文的链接；未配置 LINKY_WEB_BASE_URL 时为 null。 */
  story_url: string | null
  synced_at: string | null
  created_at: string
  updated_at: string
}

/** V1.20：批次内冻结的需求附件。字节存在 story-attachments bucket。 */
export interface ReviewStoryAttachment {
  id: string
  story_id: string
  linky_attachment_id: string
  filename: string
  content_type: string | null
  size_bytes: number | null
  storage_path: string
  content_sha256: string
  created_at: string
}

export type LinkyBatchImportStatus = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED'
export type LinkyBatchImportAnalysisStatus = 'NOT_REQUESTED' | 'PENDING' | 'QUEUED' | 'FAILED'

/**
 * V1.20：按批次的需求导入单。
 *
 * 前端只提交「项目组 + 发布窗口 + 勾选的编号」；正文与附件由内网侧的 Worker 取，
 * 在确认那一刻冻结进 review_story(+_attachment)。这张单子是进度与失败原因的唯一来源。
 */
export interface LinkyBatchImportRequest {
  id: string
  batch_id: string
  workspace_id: string | null
  workspace_name: string
  release_window: string | null
  story_codes: string[]
  status: LinkyBatchImportStatus
  attempt: number
  worker_id: string | null
  stories_total: number
  stories_committed: number
  attachments_stored: number
  attachments_failed: number
  bytes_downloaded: number
  stories_failed: Array<{ story_code: string; code: string; message: string }>
  error_code: string | null
  error_message: string | null
  /** V1.31：需求冻结完成后自动创建分析 Job 的服务端编排状态。 */
  analysis_context_version: 1 | 2 | null
  commit_window_days: 7 | 14 | 21 | 28 | null
  analysis_status: LinkyBatchImportAnalysisStatus
  analysis_job_id: string | null
  analysis_error_code: string | null
  analysis_error_message: string | null
  created_at: string
  started_at: string | null
  finished_at: string | null
}

export interface ImportFileRecord {
  id: string
  batch_id: string
  file_type: ImportFileType
  file_name: string
  storage_path: string
  file_hash: string
  template_version: string | null
  field_mapping: Record<string, string> | null
  uploaded_by: string | null
  created_at: string
  updated_at: string
}

export interface AiImportRecord {
  id: string
  batch_id: string
  import_file_id: string | null
  version: number
  baseline_branch: string | null
  baseline_commit: string | null
  ai_model: string | null
  ai_model_config_id: string | null
  analyzed_at: string | null
  imported_by: string | null
  is_active: boolean
  created_at: string
  updated_at: string
}

export interface AnalysisDetailItems {
  implemented_content: string[]
  missing_content: string[]
  risks: string[]
  test_points: string[]
  ai_remark: string[]
}

export interface AiReviewResult {
  acceptance_review?: import('../worker/src/ai/review-workflow-types').AcceptanceReviewReport | null
  id: string
  story_id: string
  ai_import_record_id: string
  verdict: AiVerdict | null
  confidence: number | null
  summary: string | null
  implemented_content: string | null
  missing_content: string | null
  risks: string | null
  test_points: string | null
  ai_remark: string | null
  analysis_detail_items: AnalysisDetailItems | null
  created_at: string
  updated_at: string
}

export interface AiCodeEvidence {
  evidence_id?: string | null
  id: string
  ai_review_result_id: string
  repository_name: string
  commit_sha: string | null
  file_path: string
  symbol_name: string | null
  start_line: number | null
  end_line: number | null
  evidence_type: EvidenceType
  evidence_summary: string | null
  description: string
  created_at: string
  updated_at: string
}

export interface HumanReview {
  id: string
  story_id: string
  ai_review_result_id: string
  reviewer_id: string
  result: HumanReviewResult
  comment: string | null
  reviewed_at: string
  created_at: string
  updated_at: string
}

export type BatchOperationAction =
  | 'BATCH_CREATED'
  | 'BATCH_DELETED'
  | 'COMPLETE'
  | 'REOPEN'
  | 'MODEL_DISPLAY_NAME_UPDATED'
  | 'MODEL_CONFIG_CREATED'
  | 'MODEL_CONFIG_UPDATED'
  | 'MODEL_CONFIG_DELETED'

export interface BatchOperationLog {
  id: string
  batch_id: string | null
  action: BatchOperationAction
  pending_count: number | null
  forced: boolean
  performed_by: string | null
  performed_by_display_name: string | null
  batch_name_snapshot: string | null
  batch_week_code_snapshot: string | null
  model_config_id: string | null
  model_display_name_snapshot: string | null
  old_model_display_name: string | null
  new_model_display_name: string | null
  changed_fields: string[] | null
  old_values: Record<string, unknown> | null
  new_values: Record<string, unknown> | null
  api_key_changed: boolean
  created_at: string
}

export interface BatchOperationLogWithBatch extends BatchOperationLog {
  review_batch: Pick<ReviewBatch, 'id' | 'name' | 'week_code'> | null
}

/**
 * 导入时从 Excel 解析出的原始需求。字段集合同时驱动映射 UI（见 excel.ts 的 SourceFieldKey），
 * 所以这里刻意不再包含 application_name / cloud_name —— 应用和云这两个维度都已下线，
 * 映射界面也不该给出这些项。
 */
export interface AiResultInput {
  story_code: string
  verdict: AiVerdict | null
  confidence: number | null
  summary: string | null
  implemented_content: string | null
  missing_content: string | null
  risks: string | null
  test_points: string | null
  ai_remark: string | null
}

export interface AiEvidenceInput {
  story_code: string
  repository_name: string
  commit_sha: string | null
  file_path: string
  symbol_name: string | null
  start_line: number | null
  end_line: number | null
  evidence_type: EvidenceType
  description: string
}

export interface ValidationIssue {
  level: 'error' | 'warning' | 'info'
  row?: number
  message: string
}

export interface BatchWorkspace {
  batch: ReviewBatch
  stories: ReviewStory[]
  activeImport: AiImportRecord | null
  results: AiReviewResult[]
  evidence: AiCodeEvidence[]
  humanReviews: HumanReview[]
}

// ---------------------------------------------------------------------------
// V4 DeepSeek Harness：Agent 运行详情与默认能力策略（见方案第 7.10 节）
//
// 安全约束：这些类型只映射 get_analysis_agent_run_detail /
// admin_get_v4_capability_policy 返回的安全元数据。浏览器绝不会拿到源码工具正文、
// Session JSONL、storage locator、API Key、claim/broker token —— 所以下面刻意
// 不声明任何 locator/token/payload 字段，避免误以为这些数据前端可用。
// ---------------------------------------------------------------------------

/**
 * Agent 运行整体状态。逐字对应 `analysis_agent_run.status` 的 CHECK 约束。
 *
 * 注意：数据库里**没有** `CANCELLED`。用户取消落成 `FAILED` +
 * `error_code = 'AGENT_TREE_CANCELLED'`，租约丢失落成 `FAILED` +
 * `error_code = 'WORKER_LOST'`。`FINISHED` 只属于
 * `analysis_agent_node.status`（见 {@link AgentNodeStatus}），不是 run 状态。
 * 事件流有自己的词表（`ATTEMPT_CANCELLED` 等），不要试图写进 run 状态。
 */
export type AgentRunStatus = 'RUNNING' | 'COMMITTED' | 'FAILED'

/** Agent Tree 单个节点状态。 */
export type AgentNodeStatus = 'RUNNING' | 'FINISHED' | 'FAILED' | 'CANCELLED'

/** Agent 角色：一个 root-reviewer 委派若干子 Agent。 */
export type AgentRole =
  | 'root-reviewer'
  | 'research-child'
  | 'implementation-child'
  | 'critic-child'
  | 'workflow-child'

/** Agent 的产生方式：root 自身、spawn/fork 子 Agent、workflow 步骤或 ralph 循环。 */
export type AgentProvider = 'root' | 'spawn' | 'fork' | 'workflow' | 'ralph'

/** 工具调用的权限判定结果，用于展示每类工具被放行/拒绝/取消的次数。 */
export type ToolPermissionVerdict = 'ALLOW' | 'DENY' | 'CANCELLED'

/** Evidence 来源：只有 PINNED_SNAPSHOT 能证明代码已存在；GENERATED_ARTIFACT 仅支撑建议。 */
export type EvidenceOrigin = 'PINNED_SNAPSHOT' | 'GENERATED_ARTIFACT'

/** Artifact 类型：候选 Patch、测试/构建报告、静态分析或说明。 */
export type ArtifactType = 'PATCH' | 'TEST_REPORT' | 'BUILD_LOG' | 'STATIC_ANALYSIS' | 'NOTE'

/** Artifact 校验状态。 */
export type ArtifactVerificationStatus = 'UNVERIFIED' | 'VERIFIED' | 'REJECTED'

/** 整次尝试的真实用量汇总（对应 usage 子对象）。 */
export interface AgentRunUsage {
  model_requests: number
  root_model_requests: number
  child_model_requests: number
  retry_requests: number
  compaction_requests: number
  ralph_rounds: number
  tool_calls: number
  evidence_shown: number
  searches_run: number
  web_requests: number
  web_bytes: number
  /**
   * provider 上报的真实 token。**可为 null**：`commit_analysis_agent_usage` 是唯一
   * 落库点，provider 不上报时它保持 null。界面必须显示“未上报”，不能显示 0 ——
   * 0 与“没量到”是两件不同的事。
   */
  input_tokens: number | null
  output_tokens: number | null
  agent_count: number
  max_depth_reached: number
}

/** Agent Tree 节点：按 delegation_depth 缩进展示层级与分 Agent 用量。 */
export interface AgentTreeNode {
  node_id: string
  agent_id: string
  parent_node_id: string | null
  agent_role: AgentRole
  provider: AgentProvider
  delegation_depth: number
  status: AgentNodeStatus
  model_requests: number
  tool_calls: number
  evidence_produced: number
  input_tokens?: number | null
  output_tokens?: number | null
  error_code: string | null
  started_at: string | null
  finished_at: string | null
  /**
   * V1.5 当前活动投影（0032 起返回）。并发 Agent 各自一行，互不覆盖。
   * `current_activity_status = 'RUNNING'` 且有 `current_tool_name` 才叫"正在调用工具"。
   */
  current_activity_scope?: RuntimeEventScope | null
  current_activity_code?: string | null
  current_activity_status?: string | null
  current_tool_name?: string | null
  current_activity_started_at?: string | null
  current_activity_updated_at?: string | null
}

/** 按工具名 + 权限判定聚合的调用计数（不含任何工具正文）。 */
export interface ToolSummaryRow {
  tool_name: string
  permission_verdict: ToolPermissionVerdict
  call_count: number
  total_duration_ms: number
}

/** Artifact 摘要：只暴露安全元数据，storage_locator 不返回给浏览器。 */
export interface ArtifactSummary {
  artifact_id: string
  artifact_type: ArtifactType
  workspace_path: string
  content_hash: string
  size_bytes: number
  verification_status: ArtifactVerificationStatus
  created_at: string
}

/** Evidence 摘要：区分 PINNED_SNAPSHOT 与 GENERATED_ARTIFACT。 */
export interface EvidenceSummary {
  evidence_id: string
  repository_name: string
  file_path: string
  start_line: number | null
  end_line: number | null
  evidence_type: EvidenceType
  evidence_origin: EvidenceOrigin
  description: string
  producer_agent_node_id: string | null
}

// ---------------------------------------------------------------------------
// V1.5 真实运行监控台（见 V1.5 方案 §6.7 / §8.6）
//
// 安全约束：这些类型只映射 admin_list_active_analysis_batches /
// get_analysis_runtime_console 返回的脱敏事实事件与投影。数据库永不返回展示文案 ——
// 中文只存在于 src/lib/labels.ts。payload 只有白名单里的机器码与标量：没有 Prompt、
// 没有工具参数/返回、没有命令、没有 stdout/stderr、没有 URL、没有绝对路径、没有 token。
// 唯一的路径类字段是 repository_name，它是仓库白名单枚举。
//
// 三个 AI 诊断 RPC 故意**没有**对应的前端类型：它们不授予 authenticated，浏览器拿不到
// （方案 §1.2 / §6.10）。归因数据走数据库与结构化日志，取数通道是 scripts/runtime-report.mjs。
// ---------------------------------------------------------------------------

/** 事件作用域。逐字对应 analysis_runtime_event.scope 的 CHECK。 */
export type RuntimeEventScope =
  | 'JOB'
  | 'TASK'
  | 'ATTEMPT'
  | 'AGENT'
  | 'MODEL'
  | 'TOOL'
  | 'WORKFLOW'
  | 'HARNESS_JOB'

/**
 * 生命周期相位。
 *
 * `STARTED` 表示该 correlation 尚未闭合 —— 这是「正在调用」的唯一判据，
 * 不是从计数增长、工具名称或超时猜出来的。`null` 属于无生命周期的点事件。
 */
export type RuntimeEventPhase = 'STARTED' | 'TERMINAL'

/** 事件 payload。只有白名单里的标量，不提供通用 JSON viewer 渲染。 */
export interface RuntimeEventPayload {
  agent_role?: AgentRole
  provider?: AgentProvider
  delegation_depth?: number
  tool_name?: string
  permission_verdict?: ToolPermissionVerdict
  reason_code?: string
  model_request_kind?: ModelRequestKind
  repository_name?: string
  attempt_number?: number
  session_revision?: number
  request_bytes?: number
  response_bytes?: number
  input_tokens?: number | null
  output_tokens?: number | null
  agent_count?: number
  active_children?: number
  duration_ms?: number
  /** 这条 TERMINAL 由 800ms 折叠产生，没有独立的 STARTED 行。 */
  collapsed?: boolean
  exit_code?: number
  output_bytes?: number
  truncated?: boolean
  hit_count?: number
  line_span?: number
  retry_index?: number
  events_reported?: number
  events_dropped?: number
  resumed?: boolean
}

/** 模型请求分类。与 analysis_runtime_event payload 的 model_request_kind 同源。 */
export type ModelRequestKind =
  | 'loop'
  | 'retry'
  | 'compaction'
  | 'session-title'
  | 'ralph'
  | 'other'

/** 一条运行事实事件。按 scope 判别，不用 Record<string, unknown> 直接渲染。 */
export interface RuntimeEvent {
  event_id: number
  /** 前端去重键。按它而不是按 event_id 去重，配合提交水位裁剪。 */
  event_uuid: string
  batch_id: string
  job_id: string
  task_id: string | null
  agent_run_id: string | null
  agent_node_id: string | null
  worker_id: string | null
  scope: RuntimeEventScope
  event_type: string
  activity_code: string | null
  phase: RuntimeEventPhase | null
  status: string | null
  correlation_id: string | null
  parent_correlation_id: string | null
  error_code: string | null
  duration_ms: number | null
  payload: RuntimeEventPayload
  occurred_at: string
  received_at: string
  /** occurred_at 超出容许偏差时为真；事件被保留并钳制，而不是丢弃。 */
  clock_skewed: boolean
}

/** 一个 Agent 当前未闭合的工具/模型请求。这是「卡在哪」的直接答案。 */
export interface RuntimeOpenCorrelation {
  correlation_id: string
  scope: RuntimeEventScope
  event_type: string
  activity_code: string | null
  tool_name: string | null
  model_request_kind: ModelRequestKind | null
  started_at: string
}

/** Agent Tree 节点 + 当前活动投影。并发 Agent 各自独立，不互相覆盖。 */
export interface RuntimeAgentSnapshot {
  agent_node_id: string
  agent_id: string
  agent_role: AgentRole
  provider: AgentProvider
  delegation_depth: number
  status: AgentNodeStatus
  model_requests: number
  tool_calls: number
  evidence_produced: number
  input_tokens: number | null
  output_tokens: number | null
  error_code: string | null
  started_at: string | null
  finished_at: string | null
  current_activity_scope: RuntimeEventScope | null
  current_activity_code: string | null
  current_activity_status: string | null
  current_correlation_id: string | null
  current_tool_name: string | null
  current_activity_started_at: string | null
  current_activity_updated_at: string | null
  open_correlations: RuntimeOpenCorrelation[]
}

/** 一次 Attempt 的运行摘要。run 级当前活动由 node 投影聚合，不落列。 */
export interface RuntimeAttemptSnapshot {
  agent_run_id: string
  agent_attempt: number
  status: AgentRunStatus
  worker_id: string | null
  model_label: string | null
  error_code: string | null
  started_at: string | null
  committed_at: string | null
  finished_at: string | null
  cancel_requested_at: string | null
  cancel_reason: string | null
  sealed_at: string | null
  session_revision: number | null
  attempt_phase_code: string | null
  attempt_phase_started_at: string | null
  agent_count: number
  max_depth_reached: number
  model_requests: number
  tool_calls: number
  input_tokens: number | null
  output_tokens: number | null
  resume_count: number
  agents: RuntimeAgentSnapshot[]
}

/**
 * 一个需求任务的运行快照。
 *
 * 只有 `agent_status`：`retrieval_status` 与 `analysis_status` 是 0010 留下的另两套状态，
 * DTO 刻意不返回它们，避免再次出现「界面显示 PENDING 其实在跑」。
 */
export interface RuntimeTaskSnapshot {
  task_id: string
  story_id: string
  story_code: string
  story_name: string
  project_name: string | null
  application_name: string | null
  agent_status: StoryTaskStatus
  agent_attempt: number
  worker_id: string | null
  lease_expires_at: string | null
  heartbeat_at: string | null
  error_code: string | null
  started_at: string | null
  finished_at: string | null
  last_event_at: string | null
  attempts: RuntimeAttemptSnapshot[]
}

/** get_analysis_runtime_console 的游标。 */
export interface RuntimeConsoleCursor {
  requested_after: number | null
  /** 只推进到本次返回中已过提交水位的最大 id，不是表内 max(id)。 */
  next_event_id: number | null
  has_more: boolean
  /** 游标早于保留期时为真：前端必须丢弃本地状态重新做全量快照。 */
  requires_full_snapshot: boolean
  server_time: string
  /** 最老未过水位事件的滞后毫秒数；> 3000 时提示「确认延迟」。 */
  watermark_lag_ms: number
}

export interface AnalysisRuntimeConsoleResponse {
  batch: {
    batch_id: string
    batch_name: string
    job_id: string | null
    job_status: AnalysisJobStatus | null
    total_stories: number
    pending_stories: number
    running_stories: number
    succeeded_stories: number
    failed_stories: number
    last_event_id: number | null
    last_event_at: string | null
  }
  tasks: RuntimeTaskSnapshot[]
  events: RuntimeEvent[]
  cursor: RuntimeConsoleCursor
}

/** 当前需求的历史事件页。与批次实时游标分离，避免被其它需求的新事件挤掉。 */
export interface RuntimeTaskEventHistoryResponse {
  task_id: string
  batch_id: string
  total_events: number
  events: RuntimeEvent[]
  cursor: {
    requested_before: number | null
    next_before_event_id: number | null
    has_more: boolean
    page_size: number
    server_time: string
  }
}

/** admin_list_active_analysis_batches 的单个批次条目。 */
export interface ActiveAnalysisBatch {
  batch_id: string
  batch_name: string
  week_code: string | null
  job_id: string
  job_status: AnalysisJobStatus
  requested_branch: string
  worker_id: string | null
  finalizer_worker_id: string | null
  job_started_at: string | null
  total_stories: number
  pending_stories: number
  running_stories: number
  succeeded_stories: number
  failed_stories: number
  last_event_id: number | null
  last_event_at: string | null
  watermark_lag_ms: number
}

export interface ActiveAnalysisBatchList {
  server_time: string
  batches: ActiveAnalysisBatch[]
}

/**
 * 数据新鲜度。五种故障**分别**展示，不合并成一个「异常」——
 * 链路拥塞、长事务未提交和 Worker 掉线要采取的动作完全不同。
 */
export type RuntimeFreshness =
  | 'LIVE'
  | 'DELAYED'
  | 'STALE'
  | 'AWAITING_COMMIT'
  | 'WORKER_OFFLINE'

/** get_analysis_agent_run_detail 顶层返回。无运行记录时 RPC 返回 null。 */
export interface AgentRunDetail {
  run_id: string
  task_id: string
  job_id: string
  agent_attempt: number
  status: AgentRunStatus
  policy_hash: string | null
  tree_digest: string | null
  session_revision: number | null
  resume_count: number | null
  cancel_requested_at: string | null
  cancel_reason: string | null
  sealed_at: string | null
  error_code: string | null
  /** V1.5 ATTEMPT 阶段投影（0032 起返回）。 */
  attempt_phase_code?: string | null
  attempt_phase_started_at?: string | null
  started_at: string | null
  committed_at: string | null
  finished_at: string | null
  usage: AgentRunUsage
  agents: AgentTreeNode[]
  tool_summary: ToolSummaryRow[]
  artifacts: ArtifactSummary[]
  evidence: EvidenceSummary[]
}

// --- 默认能力策略（ADMIN 按模型配置资源限额；安全能力保持只读） ---

/** 20 个能力开关由 Harness contract 固定为开启，不允许通过运营配置修改。 */
export interface V4Capabilities {
  instructions: boolean
  skills: boolean
  goal: boolean
  plan: boolean
  todo: boolean
  ralph: boolean
  subagentSpawn: boolean
  subagentFork: boolean
  subagentControl: boolean
  workflow: boolean
  jobs: boolean
  shell: boolean
  filesystem: boolean
  webSearch: boolean
  webFetch: boolean
  parallelTools: boolean
  autoCompaction: boolean
  sessionPersistence: boolean
  sessionResume: boolean
  artifacts: boolean
}

export interface V4SandboxPolicy {
  defaultMode: string
  dangerFullAccess: boolean
  commandTimeoutMs: number
  maxProcessesPerAttempt: number
  maxWorkspaceBytes: number
  maxWorkspaceFiles: number
}

export interface V4AgentsPolicy {
  maxAgentsPerAttempt: number
  maxDelegationDepth: number
  maxConcurrentChildren: number
  allowOutOfProcessProviders: boolean
}

export interface V4WorkflowPolicy {
  maxConcurrentSteps: number
  maxRuntimeMs: number
}

export interface V4JobsPolicy {
  maxConcurrentJobsPerOwner: number
  maxRuntimeMs: number
}

export interface V4ParallelToolsPolicy {
  maxPerStep: number
  mutationToolsSerial: boolean
}

export interface V4ModelBudgetPolicy {
  maxTotalRequests: number
  maxRootRequests: number
  maxChildRequests: number
  maxRetryRequests: number
  maxCompactionRequests: number
  maxRalphRounds: number
}

export interface V4WebPolicy {
  maxRequestsPerAttempt: number
  maxResponseBytes: number
  maxTotalBytes: number
  allowHttp: boolean
  allowedPorts: number[]
  allowedDomains: string[]
  denyPrivateNetworks: boolean
  maxRedirects: number
  requestTimeoutMs: number
}

export interface V4SessionPolicy {
  checkpointEveryEvents: number
  retentionDays: number
  encryptAtRest: boolean
  resumeOnWorkerRestart: boolean
}

/** 完整默认能力策略快照。 */
export interface V4CapabilityPolicy {
  version: number
  capabilities: V4Capabilities
  sandbox: V4SandboxPolicy
  agents: V4AgentsPolicy
  workflow: V4WorkflowPolicy
  jobs: V4JobsPolicy
  parallelTools: V4ParallelToolsPolicy
  modelBudget: V4ModelBudgetPolicy
  web: V4WebPolicy
  session: V4SessionPolicy
}


/** ADMIN 可编辑的运行资源限额；不包含 Harness contract 锁定的能力与安全字段。 */
export interface V4CapabilityPolicyEditable {
  sandbox: Pick<
    V4SandboxPolicy,
    'commandTimeoutMs' | 'maxProcessesPerAttempt' | 'maxWorkspaceBytes' | 'maxWorkspaceFiles'
  >
  agents: Pick<
    V4AgentsPolicy,
    'maxAgentsPerAttempt' | 'maxDelegationDepth' | 'maxConcurrentChildren'
  >
  workflow: V4WorkflowPolicy
  jobs: V4JobsPolicy
  parallelTools: Pick<V4ParallelToolsPolicy, 'maxPerStep'>
  modelBudget: V4ModelBudgetPolicy
  web: Pick<
    V4WebPolicy,
    'maxRequestsPerAttempt' | 'maxResponseBytes' | 'maxTotalBytes' | 'allowedDomains'
  >
  session: Pick<V4SessionPolicy, 'checkpointEveryEvents' | 'retentionDays'>
}

// ---------------------------------------------------------------------------
// V1.6 受管 DSH Skill Bundle
// ---------------------------------------------------------------------------

/** 技能生命周期。`PUBLISHED` 且有 current_version 才会被新 Job 冻结。 */
export type ReviewSkillStatus =
  | 'DRAFT'
  | 'VALIDATING'
  | 'PUBLISHED'
  | 'DISABLED'
  | 'VALIDATION_FAILED'

export type SkillFileRole = 'ENTRY' | 'REFERENCE' | 'ASSET' | 'TEMPLATE' | 'SCRIPT' | 'OTHER'

/**
 * manifest 里的一个文件。
 *
 * 只有身份信息 —— 路径、hash、大小、MIME、角色。**没有文件正文**：manifest 会随 Job
 * 冻结并进入数据库，把正文放进来等于把内部规则和脚本写进普通数据库备份。
 */
export interface SkillBundleFile {
  path: string
  sha256: string
  sizeBytes: number
  mediaType: string
  role: SkillFileRole
}

export interface SkillBundleManifest {
  schemaVersion: number
  skillName: string
  entry: string
  archiveSha256: string
  archiveSizeBytes: number
  expandedSizeBytes: number
  containsScripts: boolean
  files: SkillBundleFile[]
}

/** 一次尚未发布的 staging 上传及其服务端校验结果。 */
export interface ReviewSkillUpload {
  id: string
  status: 'PENDING' | 'VALIDATED' | 'FAILED' | 'CONSUMED' | 'EXPIRED'
  error_code: string | null
  error_message: string | null
  file_count: number | null
  archive_size_bytes: number | null
  expanded_size_bytes: number | null
  contains_scripts: boolean
  bundle_manifest: SkillBundleManifest | null
  entry_frontmatter: SkillEntryFrontmatter | null
  created_at: string
}

export interface ReviewSkillListItem {
  id: string
  name: string
  display_name: string
  status: ReviewSkillStatus
  current_version_id: string | null
  current_version: number | null
  description: string | null
  when_to_use: string | null
  file_count: number | null
  archive_size_bytes: number | null
  expanded_size_bytes: number | null
  contains_scripts: boolean
  bundle_hash: string | null
  published_at: string | null
  published_by_name: string | null
  updated_at: string
  /**
   * 是否被任何 Analysis Job 冻结过。为 true 时不能删除：
   * `analysis_job_skill_snapshot` 是那次评审给了模型哪些技能的唯一证据。
   */
  referenced_by_job: boolean
  version_count: number
  latest_upload: ReviewSkillUpload | null
}

/** 单个 Bundle 与全技能目录的上限（方案 §8）。由数据库返回，前端不写死。 */
export interface SkillBundleLimits {
  archiveBytes: number
  expandedBytes: number
  entryCount: number
  fileBytes: number
  entryFileBytes: number
  pathDepth: number
  pathBytes: number
  compressionRatio: number
  validateMs: number
  catalogBundles: number
  descriptionChars: number
  catalogRenderBytes: number
  catalogArchiveBytes: number
  catalogExpandedBytes: number
}

/**
 * 平台级技能目录容量上限（V1.8，可配置）。
 *
 * 由 `admin_get_skill_catalog_limits` 返回、`admin_update_skill_catalog_limits` 写入。
 * 只含目录四项；单包上限仍是数据库常量（不可配）。
 */
export interface SkillCatalogLimitsConfig {
  catalogBundles: number
  catalogRenderBytes: number
  catalogArchiveBytes: number
  catalogExpandedBytes: number
  updatedAt: string
}

/** 全局目录容量水位（§14.1 页面顶部那五行）。 */
export interface SkillCatalogCapacity {
  enabled_bundles: number
  archive_bytes: number
  expanded_bytes: number
  catalog_render_bytes: number
  script_bundles: number
  catalog_hash: string
}

export interface ReviewSkillCatalog {
  limits: SkillBundleLimits
  skills: ReviewSkillListItem[]
  capacity: SkillCatalogCapacity
}

export interface ReviewSkillVersionDetail {
  id: string
  version: number
  description: string
  when_to_use: string | null
  archive_object_key: string
  archive_sha256: string
  archive_size_bytes: number
  bundle_hash: string
  bundle_manifest: SkillBundleManifest
  expanded_size_bytes: number
  file_count: number
  contains_scripts: boolean
  published_at: string
}

export interface ReviewSkillDetail {
  id: string
  name: string
  display_name: string
  status: ReviewSkillStatus
  current_version_id: string | null
  versions: ReviewSkillVersionDetail[]
}

/** `create-upload` 返回的短期写令牌。绝不落库、不进日志。 */
export interface SkillUploadTicket {
  upload_id: string
  bucket: string
  path: string
  token: string
  expires_in_seconds: number
}

/**
 * `SKILL.md` 的 YAML frontmatter。
 *
 * 它是 name / description / whenToUse 的**唯一来源**：dsh 的 `skill-filesystem` 在首轮
 * 目录里渲染的就是这里的 description。发布页只展示它，不让管理员另敲一份 —— 两份文本
 * 会让管理页显示的、审计里记的和模型实际看到的分叉，而且没有任何机制会发现。
 */
export interface SkillEntryFrontmatter {
  name: string
  description: string
  whenToUse?: string
}

/** `validate` 返回的服务端解析结果，供发布页展示文件树与风险提示。 */
export interface SkillValidationResult {
  upload_id: string
  bundle_hash: string
  archive_sha256: string
  archive_size_bytes: number
  expanded_size_bytes: number
  file_count: number
  contains_scripts: boolean
  tree: SkillBundleFile[]
  frontmatter: SkillEntryFrontmatter
}

// ---------------------------------------------------------------------------
// V1.19 技能 AI 优化
// ---------------------------------------------------------------------------

export type SkillVerdictKey = 'IMPLEMENTED' | 'PARTIAL' | 'NOT_IMPLEMENTED' | 'UNCERTAIN'
export type SkillHumanReviewKey =
  | 'CORRECT'
  | 'PARTIALLY_CORRECT'
  | 'INCORRECT'
  | 'NEED_DISCUSSION'

/**
 * 一条抽样证据。
 *
 * `summary` / `human_review_comment` 都是服务端截断过的（500 / 300 字符）。前端不再截断：
 * 再截一次会让"我在页面上看到的"和"模型看到的"不是同一段文本。
 */
export interface SkillReviewEvidenceSample {
  story_code: string
  verdict: string
  summary: string
  human_review_result: string | null
  human_review_comment: string | null
}

/**
 * 引用过这个技能的一个 Job 及其所属批次。
 *
 * 展示的是**批次身份**（名称 + 周次）而不是 Job id：后者对管理员没有意义，他记得的是
 * "第 39 周那个批次评得不准"。同一批次可能因为重跑出现多条。
 */
export interface SkillEvidenceBatch {
  batch_id: string
  batch_name: string
  week_code: string | null
  job_id: string
  job_status: string | null
  job_created_at: string | null
  /** 这个 Job 冻结的是技能的哪一版。 */
  skill_version: number | null
  result_count: number
}

/**
 * 技能的历史评审证据聚合（`admin_get_skill_review_evidence`）。
 *
 * `referenced_job_count === 0` 是一个**功能状态**，不是错误：它意味着这个技能还没被任何
 * Job 冻结过，没有可依据的证据，AI 优化入口应当禁用并说明原因。
 */
export interface SkillReviewEvidence {
  skill_id: string
  referenced_job_count: number
  /**
   * 可依据的评审结论条数（V1.22）。
   *
   * 「能不能优化」的真实判据。缺席 = 后端还没升到 V1.22，前端回退到结论分布求和。
   */
  review_result_count?: number
  /** 引用过它的 Job 属于哪些评审批次。升级前的历史数据可能缺这个字段。 */
  referenced_batches?: SkillEvidenceBatch[]
  verdict_counts: Record<SkillVerdictKey, number>
  human_review_counts: Record<SkillHumanReviewKey, number>
  sample_findings: SkillReviewEvidenceSample[]
}

export type SkillAiOptimizationStatus = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED'

/**
 * 一次 AI 优化任务的浏览器可见投影。
 *
 * 刻意**没有** worker_id / lease_expires_at / claim_token_digest：浏览器拿到它们就能伪造
 * 心跳或抢结果。写回只能由 service-role 的 Worker 完成。
 */
export interface SkillAiOptimizationTask {
  id: string
  skill_id: string
  source_version_id: string
  status: SkillAiOptimizationStatus
  result_upload_id: string | null
  changed_paths: string[]
  ai_summary: string | null
  /** 调用模型的次数。>1 表示结构自检没过、AI 自己重写过。 */
  model_attempts: number
  error_code: string | null
  error_message: string | null
  created_at: string
  started_at: string | null
  finished_at: string | null
}

/** 一个被改动文件的两侧正文。`before === null` 新增，`after === null` 删除。 */
export interface SkillFileDiff {
  path: string
  before: string | null
  after: string | null
  /** 图片等二进制文件：只可能被新增/删除，没有逐行 diff。 */
  binary?: boolean
}

export interface SkillOptimizationDiff {
  request_id: string
  skill_name: string
  ai_summary: string | null
  model_attempts: number
  /** 这份草稿含 `scripts/` 下的可执行资源，发布时必须额外确认。 */
  contains_scripts: boolean
  file_count: number | null
  files: SkillFileDiff[]
}


export type DeveloperIdentityStatus = 'VERIFIED' | 'UNVERIFIED' | 'CONFLICT' | 'DISABLED'

export interface DeveloperGitIdentityRecord {
  developer_id: string
  display_name: string
  employee_code: string | null
  status: DeveloperIdentityStatus
  revision: number
  /** 该开发人员身份是否已由本人账号在个人中心认领维护。 */
  auth_bound?: boolean
  git_identity_id: string
  provider: 'gitlab' | 'git'
  /** 明文邮箱，仅用于显示与编辑回显；归属匹配一律用数据库里的 HMAC 指纹。改造前建的历史行为 null。 */
  author_email: string | null
  masked_email: string | null
  email_domain: string | null
  author_name_aliases: string[]
  gitlab_username: string | null
  gitlab_user_id: string | null
  verification_status: DeveloperIdentityStatus
  git_revision: number
  updated_at: string
}

export interface SaveDeveloperGitIdentityInput {
  developerId?: string | null
  gitIdentityId?: string | null
  displayName: string
  employeeCode?: string | null
  email: string
  authorNameAliases: string[]
  gitlabUsername?: string | null
  gitlabUserId?: string | null
  developerStatus: DeveloperIdentityStatus
  verificationStatus: DeveloperIdentityStatus
  expectedRevision?: number | null
}

/** 个人中心自助维护的一条 Git 邮箱。 */
export interface MyGitIdentityRecord {
  git_identity_id: string
  provider: 'gitlab' | 'git'
  /** 明文邮箱；改造前建的历史行可能为 null，此时只有掩码。 */
  author_email: string | null
  masked_email: string | null
  email_domain: string | null
  author_name_aliases: string[]
  gitlab_username: string | null
  gitlab_user_id: string | null
  verification_status: DeveloperIdentityStatus
  git_revision: number
  valid_until: string | null
  updated_at: string
}

/** 当前账号自己的开发人员身份；从未配置过时 developer_id 为 null，identities 为空。 */
export interface MyGitIdentityProfile {
  developer_id: string | null
  display_name: string | null
  employee_code: string | null
  status: DeveloperIdentityStatus | null
  revision: number | null
  identities: MyGitIdentityRecord[]
}

export type GitEmailDiscoveryStatus = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED'

/**
 * 一个候选邮箱被判定为"属于这个 GitLab 用户"的依据。
 * null 只会出现在 V1.13.1 之前的 Worker 写下的旧候选行上。
 */
export type GitEmailCandidateMatchReason =
  | 'GITLAB_EMAIL_MATCH'
  | 'AUTHOR_NAME_MATCH'
  | 'EMAIL_LOCAL_MATCH'
  | 'SOLE_AUTHOR_IN_OWN_MERGE_REQUEST'

/** 从本人 MR 里反查出来的一个提交邮箱候选。浏览器拿得到自己的明文邮箱，但拿不到指纹。 */
export interface GitEmailDiscoveryCandidate {
  candidate_id: string
  /** 明文邮箱，仅本人可见；被认领后会一并写入正式身份行的 author_email。 */
  email: string | null
  masked_email: string
  email_domain: string
  author_names: string[]
  commit_count: number
  last_committed_at: string | null
  /** { 仓库名: 提交数 } */
  repositories: Record<string, number>
  merge_request_refs: string[]
  /** 已经绑定在某个人名下（可能是你自己，也可能是别人）。 */
  already_bound: boolean
  /** 它为什么被认为是这个 GitLab 用户的邮箱。 */
  match_reason: GitEmailCandidateMatchReason | null
}

export interface GitEmailDiscovery {
  discovery_id: string
  gitlab_username: string
  gitlab_user_id: string | null
  gitlab_display_name: string | null
  status: GitEmailDiscoveryStatus
  attempt: number
  lookback_days: number
  merge_request_count: number
  candidate_count: number
  /**
   * 读到了但归属于别人的提交邮箱个数：他自己提的集成 MR（feature_sit -> release 之类）
   * 里带着全组人的提交，这些邮箱不是他的，界面照实显示剔除了多少。
   */
  excluded_candidate_count: number
  /** 有仓库没查到或结果被截断：界面必须照实说"可能不全"。 */
  partial: boolean
  error_code: string | null
  error_message: string | null
  created_at: string
  started_at: string | null
  finished_at: string | null
  /** 已经被某个 Worker 领取。一直为 false 说明没有可用 Worker。 */
  claimed: boolean
  candidates: GitEmailDiscoveryCandidate[]
}

export interface SaveMyGitIdentityFromCandidateInput {
  candidateId: string
  displayName: string
  employeeCode?: string | null
  authorNameAliases?: string[] | null
  gitlabUsername?: string | null
  gitlabUserId?: string | null
  gitIdentityId?: string | null
  expectedRevision?: number | null
}

/* ---------------------------------------------------------------------------
 * V1.23 产品代码问答
 * ------------------------------------------------------------------------- */

/** 轮次生命周期。与数据库 CHECK 逐字一致。 */
export type CodeQaTurnStatus = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED'

/**
 * 真实阶段。由 Worker 在实际转换点上报，页面照抄。
 *
 * 它与 status 是两个维度：status 回答"这一轮结束了没有"，stage 回答"此刻在做什么"。
 */
export type CodeQaStage = 'QUEUED' | 'PREPARING_CODE' | 'EXPLORING' | 'GENERATING' | 'DONE'

/**
 * 一轮回答的可核对证据。
 *
 * 全部字段可选：它由 Worker 写入，失败的轮次往往只有一部分键。页面必须能渲染缺席。
 */
export interface CodeQaEvidence {
  /** 这一轮实际使用的代码快照 commit，按仓库：`{ "<repo>": "<sha>" }`。 */
  commit_shas?: Record<string, string>
  /** 这一轮挂了哪些仓库。 */
  repositories?: string[]
  /** Agent 真正读过的文件（快照内相对路径）。 */
  files_read?: string[]
  /** Agent 调用过的平台技能名。 */
  skills_used?: string[]
  /** 工具调用次数，用于判断它到底查了多少东西。 */
  tool_call_count?: number
  /** 是否续用了既有 DSH 会话上下文。false = 模型不记得更早的对话。 */
  resumed?: boolean
  /** 观测到的 session/update 条数，诊断用。 */
  update_count?: number
}

export interface CodeQaTurn {
  id: string
  question: string
  status: CodeQaTurnStatus
  stage: CodeQaStage
  answer: string | null
  evidence: CodeQaEvidence | null
  error_code: string | null
  error_message: string | null
  /** 回答这一轮用的模型显示名。 */
  model_label: string | null
  created_at: string
  started_at: string | null
  finished_at: string | null
}

/**
 * 会话列表项。
 *
 * 仓库集合与分支都是**会话级**的：一个会话可以同时挂多个仓库（产品的问题经常跨
 * 前后端），但只钉一个分支 —— 五个仓库共用同一套分支名，而"这个会话在看哪一版代码"
 * 必须是一句话能说清的（见执行方案 §5.4）。
 */
export interface CodeQaConversationSummary {
  id: string
  title: string
  /** 至少一个，已去重并按名字排序。 */
  repositories: string[]
  branch: DefaultBranch
  /** 已冻结的 commit，按仓库。尚未拉取的仓库不在这个映射里。 */
  commit_shas: Record<string, string>
  /** V1.27：新建时单选的模型；null 仅见于升级前的历史会话。 */
  selected_model_config_id: string | null
  /** V1.27：选择当时冻结的安全展示名，不含端点或密钥。 */
  selected_model_display_name: string | null
  /** V1.30：由 owner 持久化的置顶状态；置顶时间不暴露给浏览器。 */
  is_pinned: boolean
  /** 是否已经有 DSH 会话可供续跑。真正的 session id 不出给浏览器。 */
  has_session: boolean
  turn_count: number
  created_at: string
  updated_at: string
  last_turn_at: string | null
}

export interface CodeQaConversationDetail extends Omit<CodeQaConversationSummary, 'turn_count'> {
  turns: CodeQaTurn[]
}

/** 问答页要的三份清单。技能只给人看的元数据，不含归档定位。 */
export interface CodeQaCatalog {
  repositories: Array<{ name: string; gitlab_project: string }>
  branches: DefaultBranch[]
  skills: Array<{
    name: string
    display_name: string | null
    description: string | null
    when_to_use: string | null
  }>
}

/** 入队一轮之后立刻回给前端的那一点信息。 */
export interface CodeQaTurnQueued {
  id: string
  conversation_id: string
  question: string
  status: CodeQaTurnStatus
  stage: CodeQaStage
  created_at: string
}
