import type { Session } from '@supabase/supabase-js'
import { requireSupabase } from './supabase'
import type { FieldMapping } from './excel'
import type {
  AdminUserListItem,
  AiCodeEvidence,
  AiEvidenceInput,
  AiImportRecord,
  AiModelConfigSummary,
  AiReviewResult,
  AnalysisJob,
  AnalysisRepositorySnapshot,
  AnalysisStoryTaskWithStory,
  AnalysisWorkerStatus,
  ModelConcurrencyStatus,
  BatchOperationLog,
  BatchOperationLogWithBatch,
  BatchWorkspace,
  DefaultBranch,
  HumanReview,
  HumanReviewResult,
  ImportFileRecord,
  ImportFileType,
  ReviewBatch,
  ReviewStory,
  SourceStoryInput,
  UserProfile,
  UserRole,
} from '../types'

export interface CreateBatchInput {
  name: string
  week_code: string
  default_branch: DefaultBranch
  ai_model_config_id: string
  remark?: string | null
}

export interface ConfirmAiImportInput {
  batchId: string
  fileName: string
  storagePath: string
  fileHash: string
  templateVersion: string
  baselineBranch: string
  baselineCommit: string
  aiModel: string
  analyzedAt: string
  results: unknown[]
  evidence: AiEvidenceInput[]
}

function unwrap<T>({ data, error }: { data: T | null; error: { message: string } | null }) {
  if (error) throw new Error(error.message)
  return data as T
}

export async function getSession() {
  const client = requireSupabase()
  const { data, error } = await client.auth.getSession()
  if (error) throw error
  return data.session
}

export function onAuthChange(callback: (session: Session | null) => void) {
  const client = requireSupabase()
  return client.auth.onAuthStateChange((_event, session) => callback(session)).data.subscription
}

export async function signIn(email: string, password: string) {
  const client = requireSupabase()
  const { error } = await client.auth.signInWithPassword({ email, password })
  if (error) throw error
}

export async function signUp(email: string, password: string) {
  const client = requireSupabase()
  const { error } = await client.auth.signUp({ email, password })
  if (error) throw error
}

export async function signOut() {
  const client = requireSupabase()
  const { error } = await client.auth.signOut()
  if (error) throw error
}

export async function getMyProfile() {
  const client = requireSupabase()
  const { data: sessionData, error: sessionError } = await client.auth.getUser()
  if (sessionError) throw sessionError
  const user = sessionData.user
  if (!user) return null

  const { data, error } = await client.from('user_profile').select('*').eq('id', user.id).maybeSingle()
  if (error) throw error
  return data as UserProfile | null
}

export async function claimInitialAdmin() {
  const client = requireSupabase()
  const { data, error } = await client.rpc('claim_initial_admin')
  return unwrap<UserProfile>({ data, error })
}

export async function adminListUsers() {
  const client = requireSupabase()
  const { data, error } = await client.rpc('admin_list_users')
  return unwrap<AdminUserListItem[]>({ data, error })
}

export async function adminUpdateUserRole(userId: string, role: UserRole) {
  const client = requireSupabase()
  const { data, error } = await client.rpc('admin_update_user_role', { p_user_id: userId, p_role: role })
  return unwrap<AdminUserListItem[]>({ data, error })
}

export async function createBatch(input: CreateBatchInput) {
  const client = requireSupabase()
  const { data: userData, error: userError } = await client.auth.getUser()
  if (userError) throw userError
  if (!userData.user) throw new Error('未登录')

  const { data, error } = await client
    .from('review_batch')
    .insert({ ...input, created_by: userData.user.id })
    .select('*')
    .single()
  return unwrap<ReviewBatch>({ data, error })
}

export async function setBatchDefaultBranch(batchId: string, defaultBranch: DefaultBranch) {
  const client = requireSupabase()
  const { data, error } = await client.rpc('set_review_batch_default_branch', {
    p_batch_id: batchId,
    p_default_branch: defaultBranch,
  })
  return unwrap<string>({ data, error })
}

export async function listBatches() {
  const client = requireSupabase()
  const { data, error } = await client.from('review_batch').select('*').order('created_at', { ascending: false })
  return unwrap<ReviewBatch[]>({ data, error })
}

export async function getBatch(batchId: string) {
  const client = requireSupabase()
  const { data, error } = await client.from('review_batch').select('*').eq('id', batchId).single()
  return unwrap<ReviewBatch>({ data, error })
}

async function listStorageFilesRecursive(prefix: string): Promise<string[]> {
  const client = requireSupabase()
  const { data, error } = await client.storage.from('review-files').list(prefix)
  if (error) throw error

  const paths: string[] = []
  for (const entry of data ?? []) {
    const fullPath = `${prefix}/${entry.name}`
    if (entry.id === null) {
      paths.push(...(await listStorageFilesRecursive(fullPath)))
    } else {
      paths.push(fullPath)
    }
  }
  return paths
}

export async function deleteBatch(batchId: string) {
  const client = requireSupabase()
  const filePaths = await listStorageFilesRecursive(batchId)
  if (filePaths.length) {
    const { error: removeError } = await client.storage.from('review-files').remove(filePaths)
    if (removeError) throw removeError
  }

  const { error } = await client.rpc('delete_review_batch', { p_batch_id: batchId })
  if (error) throw new Error(error.message)
}

export async function listStories(batchId: string) {
  const client = requireSupabase()
  const { data, error } = await client.from('review_story').select('*').eq('batch_id', batchId).order('story_code')
  return unwrap<ReviewStory[]>({ data, error })
}

export async function listImportFiles(batchId: string, fileType?: ImportFileType) {
  const client = requireSupabase()
  let query = client.from('import_file').select('*').eq('batch_id', batchId).order('created_at', { ascending: false })
  if (fileType) query = query.eq('file_type', fileType)
  const { data, error } = await query
  return unwrap<ImportFileRecord[]>({ data, error })
}

export async function findImportFileByHash(batchId: string, fileType: ImportFileType, fileHash: string) {
  const client = requireSupabase()
  const { data, error } = await client
    .from('import_file')
    .select('*')
    .eq('batch_id', batchId)
    .eq('file_type', fileType)
    .eq('file_hash', fileHash)
    .maybeSingle()
  if (error) throw error
  return data
}

export async function listAiImports(batchId: string) {
  const client = requireSupabase()
  const { data, error } = await client
    .from('ai_import_record')
    .select('*, import_file(file_name, storage_path)')
    .eq('batch_id', batchId)
    .order('version', { ascending: false })
  return unwrap<(AiImportRecord & { import_file: { file_name: string; storage_path: string } | null })[]>({ data, error })
}

export async function getFileDownloadUrl(storagePath: string) {
  const client = requireSupabase()
  const { data, error } = await client.storage.from('review-files').createSignedUrl(storagePath, 60)
  if (error) throw error
  return data.signedUrl
}

export async function getBatchWorkspace(batchId: string): Promise<BatchWorkspace> {
  const [batch, stories, imports] = await Promise.all([getBatch(batchId), listStories(batchId), listAiImports(batchId)])
  const activeImport = imports.find((item) => item.is_active) ?? null

  if (!activeImport || stories.length === 0) {
    return { batch, stories, activeImport, results: [], evidence: [], humanReviews: [] }
  }

  const client = requireSupabase()
  const { data: resultsData, error: resultsError } = await client
    .from('ai_review_result')
    .select('*')
    .eq('ai_import_record_id', activeImport.id)
  if (resultsError) throw resultsError

  const results = (resultsData ?? []) as AiReviewResult[]
  const resultIds = results.map((result) => result.id)
  const evidencePromise = resultIds.length
    ? client.from('ai_code_evidence').select('*').in('ai_review_result_id', resultIds)
    : Promise.resolve({ data: [], error: null })
  const reviewPromise = resultIds.length
    ? client.from('human_review').select('*').in('ai_review_result_id', resultIds)
    : Promise.resolve({ data: [], error: null })

  const [evidenceResponse, reviewResponse] = await Promise.all([evidencePromise, reviewPromise])
  if (evidenceResponse.error) throw evidenceResponse.error
  if (reviewResponse.error) throw reviewResponse.error

  return {
    batch,
    stories,
    activeImport,
    results,
    evidence: (evidenceResponse.data ?? []) as AiCodeEvidence[],
    humanReviews: (reviewResponse.data ?? []) as HumanReview[],
  }
}

export async function uploadBatchFile(batchId: string, type: ImportFileType, file: File) {
  const client = requireSupabase()
  const folder = type === 'SOURCE' ? 'source' : type === 'AI_RESULT' ? 'ai-result' : 'template'
  const extensionMatch = file.name.match(/\.[^./\\]+$/)
  const extension = extensionMatch ? extensionMatch[0].toLowerCase() : ''
  const storagePath = `${batchId}/${folder}/${Date.now()}${extension}`
  const { error } = await client.storage.from('review-files').upload(storagePath, file, { upsert: false })
  if (error) throw error
  return storagePath
}

export async function confirmSourceImport(input: {
  batchId: string
  fileName: string
  storagePath: string
  fileHash: string
  templateVersion?: string | null
  stories: SourceStoryInput[]
  fieldMapping: FieldMapping
}) {
  const client = requireSupabase()
  const { data, error } = await client.rpc('confirm_source_import', {
    p_batch_id: input.batchId,
    p_file_name: input.fileName,
    p_storage_path: input.storagePath,
    p_file_hash: input.fileHash,
    p_template_version: input.templateVersion ?? null,
    p_stories: input.stories,
    p_field_mapping: input.fieldMapping,
  })
  return unwrap<string>({ data, error })
}

export async function confirmAiResultImport(input: ConfirmAiImportInput) {
  const client = requireSupabase()
  const { data, error } = await client.rpc('confirm_ai_result_import', {
    p_batch_id: input.batchId,
    p_file_name: input.fileName,
    p_storage_path: input.storagePath,
    p_file_hash: input.fileHash,
    p_template_version: input.templateVersion,
    p_baseline_branch: input.baselineBranch,
    p_baseline_commit: input.baselineCommit,
    p_ai_model: input.aiModel,
    p_analyzed_at: input.analyzedAt,
    p_results: input.results,
    p_evidence: input.evidence,
  })
  return unwrap<string>({ data, error })
}

export async function saveHumanReview(storyId: string, aiReviewResultId: string, result: HumanReviewResult, comment: string | null) {
  const client = requireSupabase()
  const { data: userData, error: userError } = await client.auth.getUser()
  if (userError) throw userError
  if (!userData.user) throw new Error('未登录')

  const { data, error } = await client
    .from('human_review')
    .upsert(
      {
        story_id: storyId,
        ai_review_result_id: aiReviewResultId,
        reviewer_id: userData.user.id,
        result,
        comment,
        reviewed_at: new Date().toISOString(),
      },
      { onConflict: 'story_id,ai_review_result_id,reviewer_id' },
    )
    .select('*')
    .single()
  return unwrap<HumanReview>({ data, error })
}

export async function completeBatch(batchId: string, force: boolean) {
  const client = requireSupabase()
  const { data, error } = await client.rpc('complete_review_batch', { p_batch_id: batchId, p_force: force })
  return unwrap<number>({ data, error })
}

export async function reopenBatch(batchId: string) {
  const client = requireSupabase()
  const { data, error } = await client.rpc('reopen_review_batch', { p_batch_id: batchId })
  return unwrap<string>({ data, error })
}

export async function listBatchOperationLogs(batchId: string) {
  const client = requireSupabase()
  const { data, error } = await client
    .from('batch_operation_log')
    .select('*')
    .eq('batch_id', batchId)
    .order('created_at', { ascending: false })
  return unwrap<BatchOperationLog[]>({ data, error })
}

export async function listOperationLogs() {
  const client = requireSupabase()
  const { data, error } = await client
    .from('batch_operation_log')
    .select('*, review_batch(id, name, week_code)')
    .order('created_at', { ascending: false })
  return unwrap<BatchOperationLogWithBatch[]>({ data, error })
}

// ---------------------------------------------------------------------------
// AI 自动化 MVP：模型管理 + 分析任务 API
//
// 安全约束（见方案第 7.8 / 9.2 / 14.2 节）：
// - 前端只使用无密钥类型 AiModelConfigSummary。
// - 模型的创建/更新（含 API Key 写入）只能通过 admin-model-config Edge Function，
//   由服务端再次校验 ADMIN 身份并写入 Supabase Vault；前端绝不接触密钥或 secret UUID。
// - API Key 仅密码输入；编辑时永不回显，留空表示不轮换。
// ---------------------------------------------------------------------------

/** 模型元数据写入输入（不含密钥）。API Key 单独字段传入 Edge Function。 */
export interface ModelConfigInput {
  display_name: string
  provider: string
  base_url: string
  model_name: string
  max_parallel_tasks: number
  request_timeout_ms: number
  /** 明文 API Key。仅在新增或轮换时提供；留空表示不修改现有密钥。 */
  api_key?: string | null
}

/** 通过 admin-model-config Edge Function 执行受限的模型密钥操作。 */
async function invokeAdminModelConfig<T>(action: string, payload: Record<string, unknown>) {
  const client = requireSupabase()
  const { data, error } = await client.functions.invoke('admin-model-config', {
    body: { action, ...payload },
  })
  if (error) {
    // Edge Function 返回的业务错误信息尽量透传给前端
    const context = (error as { context?: { body?: unknown } }).context
    const bodyMessage =
      context && typeof context.body === 'object' && context.body
        ? (context.body as { message?: string; error?: string }).message ??
          (context.body as { message?: string; error?: string }).error
        : undefined
    throw new Error(bodyMessage ?? error.message)
  }
  const result = data as { data?: T; error?: string } | T
  if (result && typeof result === 'object' && 'error' in result && (result as { error?: string }).error) {
    throw new Error((result as { error: string }).error)
  }
  if (result && typeof result === 'object' && 'data' in result) {
    return (result as { data: T }).data
  }
  return result as T
}

/** 供有创建批次权限的用户读取：仅返回已启用且已配置密钥的模型（无密钥字段）。 */
export async function listEnabledModelConfigs() {
  const client = requireSupabase()
  const { data, error } = await client.rpc('list_enabled_model_configs')
  return unwrap<AiModelConfigSummary[]>({ data, error })
}

/** ADMIN：返回全部模型配置的无密钥摘要及“是否已配置密钥”。 */
export async function adminListModelConfigs() {
  const client = requireSupabase()
  const { data, error } = await client.rpc('admin_list_model_configs')
  return unwrap<AiModelConfigSummary[]>({ data, error })
}

/** ADMIN：创建模型配置，密钥写入 Vault，经 Edge Function 完成。返回新建配置 id。 */
export async function adminCreateModelConfig(input: ModelConfigInput) {
  return invokeAdminModelConfig<{ id: string }>('create', { input })
}

/** ADMIN：更新模型配置。api_key 留空时保留原密钥，绝不回显旧值。返回配置 id。 */
export async function adminUpdateModelConfig(id: string, input: ModelConfigInput) {
  return invokeAdminModelConfig<{ id: string }>('update', { id, input })
}

/** ADMIN：启用/停用模型（不物理删除，保留历史引用）。返回配置 id。 */
export async function adminSetModelEnabled(id: string, enabled: boolean) {
  const client = requireSupabase()
  const { data, error } = await client.rpc('admin_set_model_enabled', {
    p_id: id,
    p_enabled: enabled,
  })
  return unwrap<string>({ data, error })
}

/** ADMIN：连接测试（仅最小测试请求，不携带代码或需求），经 Edge Function 完成。 */
export async function adminTestModelConfig(id: string) {
  return invokeAdminModelConfig<{ ok: boolean; message?: string; latency_ms?: number }>('test', { id })
}

/** 批次管理者：为未开始任务的批次选择已启用模型（历史批次补选）。返回批次 id。 */
export async function setBatchModel(batchId: string, modelConfigId: string) {
  const client = requireSupabase()
  const { data, error } = await client.rpc('set_batch_model', {
    p_batch_id: batchId,
    p_model_config_id: modelConfigId,
  })
  return unwrap<string>({ data, error })
}

/** 登录用户：校验权限与前置条件，复制批次分支，建立任务与 story task。返回 job id。 */
export async function enqueueAnalysisJob(batchId: string) {
  const client = requireSupabase()
  const { data, error } = await client.rpc('enqueue_analysis_job', { p_batch_id: batchId })
  return unwrap<string>({ data, error })
}

/** 读取批次最新的一个分析任务；无任务时返回 null。 */
export async function getLatestAnalysisJob(batchId: string) {
  const client = requireSupabase()
  const { data, error } = await client
    .from('analysis_job')
    .select('*')
    .eq('batch_id', batchId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw new Error(error.message)
  return (data ?? null) as AnalysisJob | null
}

/** 读取某任务的 4 个仓库快照。 */
export async function listRepositorySnapshots(jobId: string) {
  const client = requireSupabase()
  const { data, error } = await client
    .from('analysis_repository_snapshot')
    .select('*')
    .eq('job_id', jobId)
    .order('repository_name')
  return unwrap<AnalysisRepositorySnapshot[]>({ data, error })
}

/** 读取某任务的逐需求任务（含检索/分析状态、处理中 Worker、错误码），并 join 需求编号。 */
export async function listAnalysisStoryTasks(jobId: string) {
  const client = requireSupabase()
  const { data, error } = await client
    .from('analysis_story_task')
    .select('*, review_story(story_code, story_name)')
    .eq('job_id', jobId)
    .order('created_at')
  return unwrap<AnalysisStoryTaskWithStory[]>({ data, error })
}

/** 只读：近 15 秒在线 Worker 汇总（在线数 / 处理中数 / 总槽位）。 */
export async function getActiveAnalysisWorkers() {
  const client = requireSupabase()
  const { data, error } = await client.rpc('list_active_analysis_workers')
  return unwrap<AnalysisWorkerStatus>({ data, error })
}

/** 只读：某模型配置当前并发状态（最大并发 / 活跃 / 空闲槽位）。 */
export async function getModelConcurrencyStatus(modelConfigId: string) {
  const client = requireSupabase()
  const { data, error } = await client.rpc('get_model_concurrency_status', {
    p_model_config_id: modelConfigId,
  })
  return unwrap<ModelConcurrencyStatus>({ data, error })
}

/** 批次管理者：只允许 FAILED 任务按原快照重试（复用原 Commit SHA）。返回 job id。 */
export async function retryAnalysisJob(jobId: string) {
  const client = requireSupabase()
  const { data, error } = await client.rpc('retry_analysis_job', { p_job_id: jobId })
  return unwrap<string>({ data, error })
}
