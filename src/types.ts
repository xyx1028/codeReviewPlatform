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
}

// ---------------------------------------------------------------------------
// AI 自动化 MVP：模型配置与分析任务（前端仅使用无密钥类型）
// ---------------------------------------------------------------------------

/** 模型配置摘要：前端唯一可见的模型信息，绝不包含 API Key 或 secret UUID。 */
export interface AiModelConfigSummary {
  id: string
  display_name: string
  base_url: string
  model_name: string
  enabled: boolean
  has_api_key: boolean
  max_parallel_tasks: number
  request_timeout_ms: number
  /** 仅 admin_list_model_configs 返回。 */
  context_window?: number
  max_output_tokens?: number
  agent_max_model_requests?: number
  agent_max_retry_requests?: number
  agent_max_compaction_requests?: number
  /** 仅 admin_list_model_configs 返回；true 表示已被批次或分析任务引用。 */
  is_referenced?: boolean
  created_by?: string | null
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
  owners_text: string
  project_name: string | null
  cloud_name: string | null
  application_name: string | null
  iteration_name: string | null
  release_window: string | null
  source_status: string | null
  source_data: Record<string, unknown>
  created_at: string
  updated_at: string
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

export interface AiReviewResult {
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
  created_at: string
  updated_at: string
}

export interface AiCodeEvidence {
  id: string
  ai_review_result_id: string
  repository_name: string
  commit_sha: string | null
  file_path: string
  symbol_name: string | null
  start_line: number | null
  end_line: number | null
  evidence_type: EvidenceType
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

export interface SourceStoryInput {
  story_code: string
  story_name: string
  owners_text: string
  project_name: string | null
  cloud_name: string | null
  application_name: string | null
  iteration_name: string | null
  release_window: string | null
  source_status: string | null
  source_data: Record<string, unknown>
}

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
