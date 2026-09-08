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
  created_at: string
  updated_at: string
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

export type BatchOperationAction = 'COMPLETE' | 'REOPEN'

export interface BatchOperationLog {
  id: string
  batch_id: string
  action: BatchOperationAction
  pending_count: number | null
  forced: boolean
  performed_by: string | null
  created_at: string
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
