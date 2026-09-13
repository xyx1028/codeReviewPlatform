import type { Session } from '@supabase/supabase-js'
import { requireSupabase } from './supabase'
import type { FieldMapping } from './excel'
import type {
  ActiveAnalysisBatchList,
  AdminUserListItem,
  AgentRunDetail,
  AnalysisRuntimeConsoleResponse,
  AiCodeEvidence,
  AiEvidenceInput,
  AiImportRecord,
  AiModelConfigSummary,
  AiModelDisplayName,
  AiReviewResult,
  AnalysisJob,
  AnalysisRecoveryLease,
  AnalysisRepositorySnapshot,
  AnalysisStoryTaskWithStory,
  AnalysisWorkerOverview,
  BatchOperationLog,
  BatchOperationLogWithBatch,
  BatchWorkspace,
  DefaultBranch,
  HumanReview,
  HumanReviewResult,
  ImportFileRecord,
  ImportFileType,
  ReviewBatch,
  ReviewBatchListItem,
  ReviewStory,
  SourceStoryInput,
  UserProfile,
  UserRole,
  V4CapabilityPolicy,
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

export const wechatLoginEnabled = import.meta.env.VITE_WECHAT_LOGIN_ENABLED === 'true'

let pendingWechatAuthError: string | null = null

function clearWechatLoginFragment(): void {
  if (typeof window === 'undefined') return
  const params = new URLSearchParams(window.location.hash.slice(1))
  params.delete('wechat_handoff')
  params.delete('wechat_error')
  const hash = params.toString()
  window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${hash ? `#${hash}` : ''}`)
}

async function completeWechatLogin(): Promise<void> {
  if (typeof window === 'undefined') return
  const params = new URLSearchParams(window.location.hash.slice(1))
  const handoff = params.get('wechat_handoff')
  const callbackError = params.get('wechat_error')
  if (!handoff && !callbackError) return

  const clientNonce = window.sessionStorage.getItem('wechat_login_nonce')
  window.sessionStorage.removeItem('wechat_login_nonce')
  clearWechatLoginFragment()
  if (callbackError) throw new Error(callbackError)
  if (!clientNonce) throw new Error('微信登录状态已丢失，请重试')

  const result = await invokeWechatAuth<{ token_hash: string }>({
    action: 'exchange_login',
    ticket: handoff,
    client_nonce: clientNonce,
  })
  const client = requireSupabase()
  const { error } = await client.auth.verifyOtp({ token_hash: result.token_hash, type: 'email' })
  if (error) throw error
}

export function consumeWechatAuthError(): string | null {
  const error = pendingWechatAuthError
  pendingWechatAuthError = null
  return error
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function startWechatSignIn(): Promise<void> {
  if (!wechatLoginEnabled) throw new Error('微信登录未启用')
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined
  if (!supabaseUrl || typeof window === 'undefined') throw new Error('Supabase 未配置')

  const randomBytes = crypto.getRandomValues(new Uint8Array(32))
  const clientNonce = Array.from(randomBytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  window.sessionStorage.setItem('wechat_login_nonce', clientNonce)

  const redirectTo = new URL(window.location.href)
  redirectTo.hash = ''
  const endpoint = new URL('/functions/v1/wechat-auth/start', supabaseUrl)
  endpoint.searchParams.set('redirect_to', redirectTo.toString())
  endpoint.searchParams.set('client_nonce_hash', await sha256Hex(clientNonce))
  window.location.assign(endpoint.toString())
}

export async function getSession() {
  const client = requireSupabase()
  try {
    await completeWechatLogin()
  } catch (error) {
    pendingWechatAuthError = error instanceof Error ? error.message : '微信登录失败，请重试'
  }
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

export interface WechatBindingStatus {
  configured: boolean
  bound: boolean
  nickname: string | null
  avatar_url: string | null
  can_unbind: boolean
}

async function invokeWechatAuth<T>(body: Record<string, unknown>): Promise<T> {
  const client = requireSupabase()
  const { data, error } = await client.functions.invoke('wechat-auth', { body })
  if (error) {
    const context = (error as { context?: unknown }).context
    let message: string | undefined
    if (context instanceof Response) {
      try {
        const responseBody = await context.clone().json() as { error?: string }
        message = responseBody.error
      } catch {
        // 非 JSON 错误响应使用 SDK 默认错误信息。
      }
    }
    throw new Error(message ?? error.message)
  }
  const result = data as T & { error?: string }
  if (result?.error) throw new Error(result.error)
  return result
}

export function getWechatBindingStatus() {
  return invokeWechatAuth<WechatBindingStatus>({ action: 'status' })
}

export async function startWechatBinding(): Promise<void> {
  if (typeof window === 'undefined') return
  const redirectTo = new URL('/profile', window.location.origin)
  const result = await invokeWechatAuth<{ authorization_url: string }>({
    action: 'begin_binding',
    redirect_to: redirectTo.toString(),
  })
  window.location.assign(result.authorization_url)
}

export async function confirmWechatBinding(ticket: string): Promise<void> {
  await invokeWechatAuth<{ ok: boolean }>({ action: 'confirm_binding', ticket })
}

export async function unbindWechat(password: string): Promise<void> {
  await invokeWechatAuth<{ ok: boolean }>({ action: 'unbind', password })
}

export async function getMyProfile() {
  const client = requireSupabase()
  const { data: sessionData, error: sessionError } = await client.auth.getUser()
  if (sessionError) throw sessionError
  const user = sessionData.user
  if (!user) return null

  const { data, error } = await client
    .from('user_profile')
    .select('id, display_name, role')
    .eq('id', user.id)
    .maybeSingle()
  if (error) throw error
  return data as UserProfile | null
}

export async function updateMyDisplayName(displayName: string) {
  const client = requireSupabase()
  const { data, error } = await client.rpc('update_my_display_name', {
    p_display_name: displayName,
  })
  return unwrap<UserProfile>({ data, error })
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
  const { data, error } = await client.rpc('list_review_batches_with_creator')
  return unwrap<ReviewBatchListItem[]>({ data, error })
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
  base_url: string
  model_name: string
  max_parallel_tasks: number
  request_timeout_ms: number
  /** DeepSeek Harness Agent 的上下文与请求预算。 */
  context_window?: number
  max_output_tokens?: number
  agent_max_model_requests?: number
  agent_max_retry_requests?: number
  agent_max_compaction_requests?: number
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
    // Edge Function 的业务错误信息必须透传：supabase-js 的 FunctionsHttpError
    // 只带一句通用的 non-2xx 文案，真正的原因在响应体里。context 是 Response，
    // 不是已解析对象，必须显式读取（与 invokeWechatAuth 保持一致）。
    const context = (error as { context?: unknown }).context
    let message: string | undefined
    if (context instanceof Response) {
      try {
        const responseBody = await context.clone().json() as { error?: string; message?: string }
        message = responseBody.error ?? responseBody.message
      } catch {
        // 非 JSON 错误响应使用 SDK 默认错误信息。
      }
    }
    throw new Error(message ?? error.message)
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

/** 登录用户：读取全部模型（含停用模型）的当前展示名称，不返回任何密钥或连接信息。 */
export async function listModelDisplayNames() {
  const client = requireSupabase()
  const { data, error } = await client.rpc('list_model_display_names')
  return unwrap<AiModelDisplayName[]>({ data, error })
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

/** ADMIN：删除未被批次或分析任务引用的模型，并清理其 Vault 密钥。 */
export async function adminDeleteModelConfig(id: string) {
  return invokeAdminModelConfig<{ id: string }>('delete', { id })
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

/** 管理员只读：当前在线 Worker、容量及其正在处理的评审批次。 */
export async function adminListAnalysisWorkers() {
  const client = requireSupabase()
  const { data, error } = await client.rpc('admin_list_analysis_workers')
  return unwrap<AnalysisWorkerOverview>({ data, error })
}

/** 管理员只读：仍被离线 Worker 持有、等待释放或到期回收的 Agent 租约。 */
export async function adminListRecoveryStoryLeases() {
  const client = requireSupabase()
  const { data, error } = await client.rpc('admin_list_recovery_story_leases')
  return unwrap<AnalysisRecoveryLease[]>({ data, error })
}

/** 批次管理者：只允许 FAILED 任务按原快照重试（复用原 Commit SHA）。返回 job id。 */
export async function retryAnalysisJob(jobId: string) {
  const client = requireSupabase()
  const { data, error } = await client.rpc('retry_analysis_job', { p_job_id: jobId })
  return unwrap<string>({ data, error })
}

// ---------------------------------------------------------------------------
// V4 DeepSeek Harness：Agent 运行详情 / 取消 / 默认能力策略（见方案第 7.10 节）
//
// 安全约束：这三个 RPC 只返回安全元数据。get_analysis_agent_run_detail 与
// request_analysis_attempt_cancel 授权给 authenticated，RPC 内部按批次权限校验
// （VIEWER 取消会报 'batch management permission required'）；
// admin_get_v4_capability_policy 仅 ADMIN。前端全程不接触源码正文、Session JSONL、
// storage locator、API Key、claim/broker token。
// ---------------------------------------------------------------------------

/** 读取某 story task 最新一次 Agent 运行的安全详情；无运行记录时返回 null。 */
export async function getAgentRunDetail(taskId: string) {
  const client = requireSupabase()
  const { data, error } = await client.rpc('get_analysis_agent_run_detail', { p_task_id: taskId })
  if (error) throw new Error(error.message)
  // RPC 返回 jsonb；无 run 时是 SQL NULL，这里统一成 null 让页面显示空态。
  return (data ?? null) as AgentRunDetail | null
}

/**
 * 请求取消某 story task 正在运行的 Agent 尝试。
 * 需要批次管理权限；VIEWER 调用会抛出 'batch management permission required'。
 */
export async function requestAttemptCancel(taskId: string, reason = 'USER_CANCELLED') {
  const client = requireSupabase()
  const { data, error } = await client.rpc('request_analysis_attempt_cancel', {
    p_task_id: taskId,
    p_reason: reason,
  })
  return unwrap<boolean>({ data, error })
}

/** ADMIN 只读：读取平台统一的默认能力策略（普通启动流程不展示任何开关）。 */
export async function adminGetV4CapabilityPolicy() {
  const client = requireSupabase()
  const { data, error } = await client.rpc('admin_get_v4_capability_policy')
  return unwrap<V4CapabilityPolicy>({ data, error })
}

// ---------------------------------------------------------------------------
// V1.5 真实运行监控台（见 V1.5 方案 §6.7 / §8.1）
//
// 权限边界：
//   * admin_list_active_analysis_batches 内部 ensure_admin()；
//   * get_analysis_runtime_console 内部 ensure_manage_review_batch(batch)，
//     **不是** ensure_view_review_batch —— 后者只校验角色不校验归属（§6.7）。
//
// 三个 AI 诊断 RPC 故意没有前端封装：它们不授予 authenticated，浏览器根本拿不到。
// 归因与趋势走数据库与结构化日志，取数通道是 scripts/runtime-report.mjs（§1.2 / §8.5）。
// ---------------------------------------------------------------------------

/** ADMIN 只读：正在准备代码、分析需求或汇总结果的批次，含事件链路健康度。 */
export async function adminListActiveAnalysisBatches() {
  const client = requireSupabase()
  const { data, error } = await client.rpc('admin_list_active_analysis_batches')
  return unwrap<ActiveAnalysisBatchList>({ data, error })
}

/**
 * 批次运行监控台。
 *
 * `sinceEventId` 为空时返回完整快照（batch/job/task/attempt/agent 投影 + 最近 200 条事件）；
 * 非空时只返回 `id > cursor` 且**已过提交水位**的最多 500 条事件与受影响的 task 投影。
 *
 * 调用方必须按 `cursor.next_event_id` 推进，绝不能自己取 `max(event_id)`：
 * 后者会永久跳过那些 id 更小、提交更晚的事件（§6.1.3）。
 */
export async function getAnalysisRuntimeConsole(batchId: string, sinceEventId: number | null) {
  const client = requireSupabase()
  const { data, error } = await client.rpc('get_analysis_runtime_console', {
    p_batch_id: batchId,
    p_since_event_id: sinceEventId,
  })
  return unwrap<AnalysisRuntimeConsoleResponse>({ data, error })
}
