import type { Session } from '@supabase/supabase-js'
import { requireSupabase } from './supabase'
import { runtimeConfig } from './runtime-config'
import type { UserDeletionImpact } from './user-deletion'
import type {
  AttributionRuleCatalog,
  AttributionRuleCondition,
  AttributionRuleDefinition,
  AttributionRulesApi,
  AttributionRuleVersion,
} from '../hooks/useAttributionRules'
import type {
  RuntimeAnalysisScopeApi,
  RuntimeAnalysisScopeCommit,
  RuntimeAnalysisScopeCommitPage,
  RuntimeAnalysisScopeSummary,
  RuntimeRepositoryScope,
  RuntimeScopeCommitView,
  RuntimeScopeExpansion,
} from '../hooks/useRuntimeAnalysisScope'
import type {
  ActiveAnalysisBatchList,
  AdminUserListItem,
  AgentRunDetail,
  AnalysisRuntimeConsoleResponse,
  RuntimeTaskEventHistoryResponse,
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
  CodeQaCatalog,
  CodeQaConversationDetail,
  CodeQaConversationSummary,
  CodeQaTurnQueued,
  DefaultBranch,
  DeveloperGitIdentityRecord,
  DeveloperIdentityStatus,
  SaveDeveloperGitIdentityInput,
  GitEmailDiscovery,
  MyGitIdentityProfile,
  SaveMyGitIdentityFromCandidateInput,
  HumanReview,
  HumanReviewResult,
  ImportFileRecord,
  ImportFileType,
  LinkyBatchImportRequest,
  ModelConnectivityTest,
  ModelNetworkAccessMode,
  ReviewBatch,
  ReviewBatchListItem,
  ReviewSkillCatalog,
  ReviewSkillDetail,
  ReviewStory,
  ReviewStoryAttachment,
  SkillAiOptimizationTask,
  SkillCatalogLimitsConfig,
  SkillOptimizationDiff,
  SkillReviewEvidence,
  SkillUploadTicket,
  SkillValidationResult,
  UserProfile,
  UserRole,
  V4CapabilityPolicy,
  V4CapabilityPolicyEditable,
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

export const wechatLoginEnabled = runtimeConfig.wechatLoginEnabled

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
  const supabaseUrl = runtimeConfig.supabaseUrl
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

/**
 * Supabase Auth 抛的是英文原文（例如 `email rate limit exceeded`），直接弹给用户既看不懂、
 * 也不知道下一步该干什么。按 GoTrue 的错误码翻译成可行动的中文，未收录的错误码保留原文。
 */
const authErrorMessages: Record<string, string> = {
  // 内置邮件服务是全项目 2 封/小时，注册高峰期第三个人开始就会撞上，得配自定义 SMTP 才能放开。
  over_email_send_rate_limit: '验证邮件发送已达上限（Supabase 内置邮件服务每小时只允许 2 封），请稍后重试或联系管理员配置自定义 SMTP。',
  over_request_rate_limit: '操作过于频繁，请稍后再试。',
  user_already_exists: '该邮箱已注册，请直接登录或找回密码。',
  email_exists: '该邮箱已注册，请直接登录或找回密码。',
  invalid_credentials: '邮箱或密码不正确。',
  email_not_confirmed: '邮箱还没验证，请先点开验证邮件里的链接。',
  weak_password: '密码强度不够，请换一个更复杂的密码。',
  signup_disabled: '当前未开放注册，请联系管理员创建账号。',
  email_address_invalid: '邮箱地址无效，请检查后重试。',
  email_address_not_authorized: '该邮箱不在允许注册的范围内，请联系管理员。',
  email_address_already_confirmed: '该邮箱已完成验证，直接登录即可。',
}

/**
 * 带错误码的认证异常。
 *
 * 登录页要靠 `code === 'email_not_confirmed'` 决定是否亮出「重新发送验证邮件」，
 * 所以不能只把翻译后的文案抛出去 —— 那样调用方只能去匹配中文字符串。
 */
export class AuthActionError extends Error {
  readonly code: string

  constructor(message: string, code: string) {
    super(message)
    this.name = 'AuthActionError'
    this.code = code
  }
}

function toAuthError(error: unknown): AuthActionError {
  const fallback = error instanceof Error ? error.message : '操作失败，请稍后重试'
  const rawCode = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code ?? '')
    : ''
  const normalized = fallback.toLowerCase()
  // 老版本 GoTrue 只给英文文案、不给错误码，按关键词兜底。
  const code = rawCode || (
    normalized.includes('email rate limit exceeded') ? 'over_email_send_rate_limit'
      : normalized.includes('already registered') ? 'user_already_exists'
        : normalized.includes('invalid login credentials') ? 'invalid_credentials'
          : normalized.includes('email not confirmed') ? 'email_not_confirmed'
            : normalized.includes('already confirmed') ? 'email_address_already_confirmed'
              : ''
  )
  // 重发冷却和「额度用完」共用 over_email_send_rate_limit，但处置方式完全不同（等几十秒 vs 等一小时），
  // GoTrue 只在文案里给出剩余秒数，所以这里优先按秒数还原提示。
  const cooldown = /after (\d+) seconds?/.exec(normalized)
  if (cooldown) return new AuthActionError(`操作过于频繁，请 ${cooldown[1]} 秒后再试。`, code)
  return new AuthActionError(authErrorMessages[code] ?? fallback, code)
}

export interface SignUpResult {
  /**
   * 该邮箱之前就注册过。
   *
   * GoTrue 为了防账号枚举，对已存在的邮箱不报错、照常返回成功，只把 identities 清空作为区分，
   * 所以这里只能靠 identities 判断。注意它无法区分「注册过但没验证」和「注册过且已验证」，
   * 前者 signUp 本身会重发验证邮件，后者什么都不发 —— 文案必须同时覆盖这两种可能。
   */
  alreadyRegistered: boolean
  /** 还需要点验证邮件才能登录（关掉邮箱验证时 signUp 直接给 session，这里就是 false）。 */
  needsEmailConfirmation: boolean
}

export async function signIn(email: string, password: string) {
  const client = requireSupabase()
  const { error } = await client.auth.signInWithPassword({ email, password })
  if (error) throw toAuthError(error)
}

export async function signUp(email: string, password: string): Promise<SignUpResult> {
  const client = requireSupabase()
  const { data, error } = await client.auth.signUp({ email, password })
  if (error) throw toAuthError(error)
  return {
    alreadyRegistered: (data.user?.identities?.length ?? 0) === 0,
    needsEmailConfirmation: !data.session,
  }
}

/** 重发注册验证邮件。GoTrue 侧有 60 秒冷却，超过会抛 over_email_send_rate_limit。 */
export async function resendSignUpEmail(email: string) {
  const client = requireSupabase()
  const { error } = await client.auth.resend({ type: 'signup', email })
  if (error) throw toAuthError(error)
}

export async function signOut() {
  const client = requireSupabase()
  const { error } = await client.auth.signOut()
  if (error) throw error
}

/**
 * 关闭当前浏览器的会话，不影响服务器侧账号或其他设备会话。
 *
 * 邮箱确认关闭时 GoTrue 会在注册响应里直接创建 session；注册页需要先清掉它，
 * 才能按产品流程回到登录页让用户手动登录，而不是被 App 的认证状态直接带进工作台。
 */
export async function clearLocalAuthSession() {
  const client = requireSupabase()
  const { error } = await client.auth.signOut({ scope: 'local' })
  if (error) throw error
}

/**
 * 修改当前登录账号的密码。
 *
 * GoTrue 的 updateUser 只看会话有效性、不校验原密码，所以这里先用原密码重新登录做一次二次验证，
 * 避免别人捡到未锁屏的浏览器就能直接改密码。微信-only 账号没有可用的邮箱密码，直接拦掉。
 */
export async function changeMyPassword(currentPassword: string, newPassword: string) {
  const client = requireSupabase()
  const { data: userData, error: userError } = await client.auth.getUser()
  if (userError) throw userError
  const email = userData.user?.email
  if (!email) throw new Error('未登录')
  if (email.endsWith('@wechat.invalid')) throw new Error('微信账号没有邮箱密码，请先绑定邮箱后再设置密码')

  const { error: verifyError } = await client.auth.signInWithPassword({ email, password: currentPassword })
  if (verifyError) {
    const authError = toAuthError(verifyError)
    // 这里的凭据错误只可能是原密码填错，邮箱是从会话里取的。
    throw authError.code === 'invalid_credentials' ? new AuthActionError('当前密码不正确', authError.code) : authError
  }

  const { error } = await client.auth.updateUser({ password: newPassword })
  if (error) throw toAuthError(error)

  // 改完密码 GoTrue 不会主动踢掉别的设备，旧密码泄露的场景下那些会话还能继续用，
  // 所以显式吊销「除当前设备外」的全部 refresh token。这一步失败不影响密码已改成功的事实，
  // 只把结果回传给界面，让提示文案跟实际状态一致。
  const { error: revokeError } = await client.auth.signOut({ scope: 'others' })
  return { otherSessionsRevoked: !revokeError }
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

/**
 * 仅 ADMIN 可将仍待验证的邮箱标记为已验证。
 *
 * 邮箱状态、权限判定和审计均由数据库完成；客户端只传目标用户 ID。
 */
export async function adminConfirmUserEmail(userId: string) {
  const client = requireSupabase()
  const { data, error } = await client.rpc('admin_confirm_user_email', { p_user_id: userId })
  return unwrap<AdminUserListItem[]>({ data, error })
}

/**
 * 删除前的影响评估（只读）。
 *
 * 单独一个 RPC 而不是让前端自己查引用：判定规则必须只有一份，且必须在数据库侧 ——
 * 前端算出来的"可以删"在并发下随时会变成错的，而删除的后果不可逆。
 */
export async function adminGetUserDeletionImpact(userId: string) {
  const client = requireSupabase()
  const { data, error } = await client.rpc('admin_get_user_deletion_impact', { p_user_id: userId })
  return unwrap<UserDeletionImpact>({ data, error })
}

/**
 * 删除用户。
 *
 * 数据库会重新做一遍全部门禁（不能删自己、不能删最后一个管理员、有业务引用则拒绝），
 * 所以即使前端状态过期也不会误删。
 */
export async function adminDeleteUser(userId: string) {
  const client = requireSupabase()
  const { data, error } = await client.rpc('admin_delete_user', { p_user_id: userId })
  return unwrap<{ deleted: boolean; user: UserDeletionImpact['user'] }>({ data, error })
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

/**
 * 删除批次。
 *
 * 顺序是**先删数据库行、再清 Storage**。反过来的代价是：V1.15 给 `delete_review_batch`
 * 加了"仍有分析任务在运行则拒绝"的守卫，如果先清 Storage，守卫一旦拒绝，附件已经没了
 * 而批次还在。
 */
export async function deleteBatch(batchId: string) {
  const client = requireSupabase()
  const { error } = await client.rpc('delete_review_batch', { p_batch_id: batchId })
  if (error) throw new Error(batchDeleteErrorMessage(error.message))

  const filePaths = await listStorageFilesRecursive(batchId)
  if (filePaths.length) {
    const { error: removeError } = await client.storage.from('review-files').remove(filePaths)
    if (removeError) throw removeError
  }
}

/** 把数据库的稳定错误码翻成用户能照着做的提示。 */
export function batchDeleteErrorMessage(raw: string): string {
  if (raw.includes('BATCH_HAS_ACTIVE_ANALYSIS_JOB')) {
    return '该批次仍有分析任务在运行。请先在「AI 结果」页点「停止分析」，任务停止后再删除批次。'
  }
  return raw
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
  /**
   * 网络类型。决定 Worker 直连还是经宿主机代理访问该模型。
   *
   * 只在这里选一次，不需要再改代理配置——这正是它取代域名白名单的原因。
   */
  network_access_mode?: ModelNetworkAccessMode
  /**
   * DeepSeek Harness Agent 的 token 窗口。
   *
   * 请求次数预算（总量 / 根 / 子 Agent / 重试 / 压缩 / Ralph）不在这里：
   * 它们由 admin_update_v4_capability_policy 维护（「默认能力策略」页），
   * 和这里写同一张表的同一行，两个入口会互相覆盖。
   */
  context_window?: number
  max_output_tokens?: number
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

/** ADMIN：创建异步连接测试，由本地 Worker 领取执行。返回测试任务 id。 */
export async function enqueueModelConnectivityTest(modelConfigId: string) {
  const client = requireSupabase()
  const { data, error } = await client.rpc('enqueue_model_connectivity_test', {
    p_model_config_id: modelConfigId,
  })
  return unwrap<string>({ data, error })
}

/** ADMIN：读取连接测试的安全状态与结果。 */
export async function getModelConnectivityTest(testId: string) {
  const client = requireSupabase()
  const { data, error } = await client.rpc('get_model_connectivity_test', {
    p_test_id: testId,
  })
  return unwrap<ModelConnectivityTest>({ data, error })
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

export type AnalysisContextVersion = 1 | 2
export type CommitWindowDays = 7 | 14 | 21 | 28

/**
 * 登录用户：创建分析任务。未传 options 时保持历史 V1 行为；V1.11 页面显式传 version=2。
 */
export async function enqueueAnalysisJob(
  batchId: string,
  options?: { analysisContextVersion: AnalysisContextVersion; commitWindowDays: CommitWindowDays },
) {
  const client = requireSupabase()
  if (options === undefined || options.analysisContextVersion === 1) {
    const { data, error } = await client.rpc('enqueue_analysis_job', { p_batch_id: batchId })
    return unwrap<string>({ data, error })
  }
  const { data, error } = await client.rpc('enqueue_analysis_job_with_context', {
    p_batch_id: batchId,
    p_analysis_context_version: 2,
    p_commit_window_days: options.commitWindowDays,
  })
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

export interface JobCancelResult {
  job_id: string
  job_status: string
  already_terminal: boolean
  cancelled_attempts: number
}

/**
 * 停止整个分析任务（V1.15）。
 *
 * 需要批次管理权限。停止后 Job 立刻变成终态（`FAILED` + `error_code='JOB_CANCELLED'`），
 * 未开始的需求不会再被 Worker 领取；在跑的 attempt 收到取消意图，一个心跳周期内收敛。
 * 已经提交的需求结果保留。
 */
export async function requestJobCancel(jobId: string, reason = 'USER_CANCELLED') {
  const client = requireSupabase()
  const { data, error } = await client.rpc('request_analysis_job_cancel', {
    p_job_id: jobId,
    p_reason: reason,
  })
  return unwrap<JobCancelResult>({ data, error })
}

/** ADMIN：读取所选模型的新 Job 将冻结的完整 V4 策略。 */export async function adminGetV4CapabilityPolicy(modelConfigId: string) {
  const client = requireSupabase()
  const { data, error } = await client.rpc('admin_get_v4_capability_policy', {
    p_model_config_id: modelConfigId,
  })
  return unwrap<V4CapabilityPolicy>({ data, error })
}

/** ADMIN：更新所选模型的 V4 运行资源限额；安全能力字段不在 RPC 入参中。 */
export async function adminUpdateV4CapabilityPolicy(
  modelConfigId: string,
  policy: V4CapabilityPolicyEditable,
) {
  const client = requireSupabase()
  const { data, error } = await client.rpc('admin_update_v4_capability_policy', {
    p_model_config_id: modelConfigId,
    p_sandbox_command_timeout_ms: policy.sandbox.commandTimeoutMs,
    p_sandbox_max_processes: policy.sandbox.maxProcessesPerAttempt,
    p_workspace_max_bytes: policy.sandbox.maxWorkspaceBytes,
    p_workspace_max_files: policy.sandbox.maxWorkspaceFiles,
    p_max_agents_per_attempt: policy.agents.maxAgentsPerAttempt,
    p_max_delegation_depth: policy.agents.maxDelegationDepth,
    p_max_concurrent_children: policy.agents.maxConcurrentChildren,
    p_workflow_max_concurrent_steps: policy.workflow.maxConcurrentSteps,
    p_workflow_max_runtime_ms: policy.workflow.maxRuntimeMs,
    p_max_concurrent_jobs_per_owner: policy.jobs.maxConcurrentJobsPerOwner,
    p_jobs_max_runtime_ms: policy.jobs.maxRuntimeMs,
    p_max_parallel_tool_calls: policy.parallelTools.maxPerStep,
    p_agent_max_total_requests: policy.modelBudget.maxTotalRequests,
    p_agent_max_root_requests: policy.modelBudget.maxRootRequests,
    p_agent_max_child_requests: policy.modelBudget.maxChildRequests,
    p_agent_max_retry_requests: policy.modelBudget.maxRetryRequests,
    p_agent_max_compaction_requests: policy.modelBudget.maxCompactionRequests,
    p_agent_max_ralph_rounds: policy.modelBudget.maxRalphRounds,
    p_web_max_requests_per_attempt: policy.web.maxRequestsPerAttempt,
    p_web_max_response_bytes: policy.web.maxResponseBytes,
    p_web_max_total_bytes: policy.web.maxTotalBytes,
    p_web_allowed_domains: policy.web.allowedDomains,
    p_session_checkpoint_every_events: policy.session.checkpointEveryEvents,
    p_session_retention_days: policy.session.retentionDays,
  })
  return unwrap<V4CapabilityPolicy>({ data, error })
}

// ---------------------------------------------------------------------------
// V1.8 平台级技能目录容量上限（可配置）
// ---------------------------------------------------------------------------

/** ADMIN：读取当前平台级技能目录四项容量上限。 */
export async function adminGetSkillCatalogLimits() {
  const client = requireSupabase()
  const { data, error } = await client.rpc('admin_get_skill_catalog_limits')
  return unwrap<SkillCatalogLimitsConfig>({ data, error })
}

/** ADMIN：更新平台级技能目录四项容量上限；越界由 RPC 以稳定错误码拒绝。仅影响之后新建的批次。 */
export async function adminUpdateSkillCatalogLimits(input: {
  catalogBundles: number
  catalogRenderBytes: number
  catalogArchiveBytes: number
  catalogExpandedBytes: number
}) {
  const client = requireSupabase()
  const { data, error } = await client.rpc('admin_update_skill_catalog_limits', {
    p_catalog_bundles: input.catalogBundles,
    p_catalog_render_bytes: input.catalogRenderBytes,
    p_catalog_archive_bytes: input.catalogArchiveBytes,
    p_catalog_expanded_bytes: input.catalogExpandedBytes,
  })
  return unwrap<SkillCatalogLimitsConfig>({ data, error })
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

/**
 * 当前需求的历史事件页。
 *
 * `beforeEventId` 为空时取最新一页；翻页时使用服务端返回的
 * `cursor.next_before_event_id`，不要自行从 occurred_at 推导游标。
 */
export async function getAnalysisRuntimeTaskEvents(
  taskId: string,
  beforeEventId: number | null,
  limit: number,
) {
  const client = requireSupabase()
  const { data, error } = await client.rpc('get_analysis_runtime_task_events', {
    p_task_id: taskId,
    p_before_event_id: beforeEventId,
    p_limit: limit,
  })
  return unwrap<RuntimeTaskEventHistoryResponse>({ data, error })
}

// ---------------------------------------------------------------------------
// V1.11 需求提交归属与精准变更分析（foundation RPC 适配）
// ---------------------------------------------------------------------------

export async function adminListDeveloperGitIdentities(): Promise<DeveloperGitIdentityRecord[]> {
  const client = requireSupabase()
  const { data, error } = await client.rpc('admin_list_developer_git_identities')
  return unwrap<DeveloperGitIdentityRecord[]>({ data, error })
}

export async function adminSaveDeveloperGitIdentity(
  input: SaveDeveloperGitIdentityInput,
): Promise<{ developer_id: string; git_identity_id: string; masked_email: string; author_email: string }> {
  const client = requireSupabase()
  const { data, error } = await client.rpc('admin_upsert_developer_git_identity_from_email', {
    p_developer_id: input.developerId ?? null,
    p_git_identity_id: input.gitIdentityId ?? null,
    p_display_name: input.displayName,
    p_employee_code: input.employeeCode ?? null,
    p_email: input.email,
    p_author_name_aliases: input.authorNameAliases,
    p_gitlab_username: input.gitlabUsername ?? null,
    p_gitlab_user_id: input.gitlabUserId ?? null,
    p_developer_status: input.developerStatus,
    p_verification_status: input.verificationStatus,
    p_expected_revision: input.expectedRevision ?? null,
  })
  return unwrap<{ developer_id: string; git_identity_id: string; masked_email: string; author_email: string }>({ data, error })
}

// ---------------------------------------------------------------------------
// V1.12 Git 身份自助维护（个人中心）
// ---------------------------------------------------------------------------

/** 只返回调用者自己的身份；数据库侧以 auth.uid() 为边界，前端拿不到别人的记录。 */
export async function getMyGitIdentity(): Promise<MyGitIdentityProfile> {
  const client = requireSupabase()
  const { data, error } = await client.rpc('get_my_git_identity')
  return unwrap<MyGitIdentityProfile>({ data, error })
}

/** 移除是停用而不是删除：已冻结的 Job 身份快照以 restrict 引用历史行。 */
export async function disableMyGitIdentity(
  gitIdentityId: string,
  expectedRevision?: number | null,
): Promise<{ git_identity_id: string; verification_status: DeveloperIdentityStatus }> {
  const client = requireSupabase()
  const { data, error } = await client.rpc('disable_my_git_identity', {
    p_git_identity_id: gitIdentityId,
    p_expected_revision: expectedRevision ?? null,
  })
  return unwrap<{ git_identity_id: string; verification_status: DeveloperIdentityStatus }>({ data, error })
}

/**
 * 编辑一行 Git 身份里**自己填的那两列**：作者别名与 GitLab 用户名。
 *
 * 邮箱不在其中 —— 它只能由 GitLab 反查落库，所以想换邮箱是"新增一条 + 停用旧的"，
 * 而不是在这里改。
 */
export async function updateMyGitIdentityDetails(input: {
  gitIdentityId: string
  authorNameAliases: string[]
  gitlabUsername?: string | null
  expectedRevision?: number | null
}): Promise<{
  git_identity_id: string
  git_revision: number
  author_name_aliases: string[] | null
  gitlab_username: string | null
}> {
  const client = requireSupabase()
  const { data, error } = await client.rpc('update_my_git_identity_details', {
    p_git_identity_id: input.gitIdentityId,
    p_author_name_aliases: input.authorNameAliases,
    p_gitlab_username: input.gitlabUsername ?? null,
    p_expected_revision: input.expectedRevision ?? null,
  })
  return unwrap<{
    git_identity_id: string
    git_revision: number
    author_name_aliases: string[] | null
    gitlab_username: string | null
  }>({ data, error })
}

/**
 * 真删一行 Git 身份。只有从没被分析快照冻结过的行才删得掉，
 * 否则数据库会以 GIT_IDENTITY_IN_USE 拒绝并要求改用停用 —— 硬删会切断历史结论的追溯链。
 */
export async function deleteMyGitIdentity(
  gitIdentityId: string,
  expectedRevision?: number | null,
): Promise<{ git_identity_id: string; deleted: boolean }> {
  const client = requireSupabase()
  const { data, error } = await client.rpc('delete_my_git_identity', {
    p_git_identity_id: gitIdentityId,
    p_expected_revision: expectedRevision ?? null,
  })
  return unwrap<{ git_identity_id: string; deleted: boolean }>({ data, error })
}

/**
 * 「我是谁」的唯一入口：同时写账号用户名和（若已存在的）开发人员身份。
 *
 * 这两者指的是同一件事 —— 需求表里「开发人员」那一栏（真实格式是「向俊杰（41865）」）。
 * 分两处维护只会让它们悄悄不一致，而不一致时归属规则对不上人却不会报错。
 */
export async function updateMyIdentityProfile(
  displayName: string,
  employeeCode?: string | null,
): Promise<{
  profile: UserProfile
  developer_id: string | null
  employee_code: string | null
}> {
  const client = requireSupabase()
  const { data, error } = await client.rpc('update_my_identity_profile', {
    p_display_name: displayName,
    p_employee_code: employeeCode ?? null,
  })
  return unwrap<{
    profile: UserProfile
    developer_id: string | null
    employee_code: string | null
  }>({ data, error })
}

// ---------------------------------------------------------------------------
// V1.13 用 GitLab 用户名反查提交邮箱（本地 Worker 执行，前端轮询）
// ---------------------------------------------------------------------------

export async function enqueueMyGitEmailDiscovery(
  gitlabUsername: string,
  lookbackDays = 365,
): Promise<string> {
  const client = requireSupabase()
  const { data, error } = await client.rpc('enqueue_my_git_email_discovery', {
    p_gitlab_username: gitlabUsername,
    p_lookback_days: lookbackDays,
  })
  return unwrap<string>({ data, error })
}

export async function getMyGitEmailDiscovery(discoveryId: string): Promise<GitEmailDiscovery> {
  const client = requireSupabase()
  const { data, error } = await client.rpc('get_my_git_email_discovery', {
    p_discovery_id: discoveryId,
  })
  return unwrap<GitEmailDiscovery>({ data, error })
}

/**
 * 按候选保存。提交的是 candidate_id 而不是邮箱：指纹取自候选行，
 * 所以前端没有任何办法伪造一个"已验证"的 Git 身份。
 */
export async function saveMyGitIdentityFromCandidate(
  input: SaveMyGitIdentityFromCandidateInput,
): Promise<{
  developer_id: string
  git_identity_id: string
  git_revision: number
  masked_email: string
  verification_status: DeveloperIdentityStatus
  claimed_existing_developer: boolean
}> {
  const client = requireSupabase()
  const { data, error } = await client.rpc('upsert_my_git_identity_from_candidate', {
    p_candidate_id: input.candidateId,
    p_display_name: input.displayName,
    p_employee_code: input.employeeCode ?? null,
    p_author_name_aliases: input.authorNameAliases ?? null,
    p_gitlab_username: input.gitlabUsername ?? null,
    p_gitlab_user_id: input.gitlabUserId ?? null,
    p_git_identity_id: input.gitIdentityId ?? null,
    p_expected_revision: input.expectedRevision ?? null,
  })
  return unwrap<{
    developer_id: string
    git_identity_id: string
    git_revision: number
    masked_email: string
    verification_status: DeveloperIdentityStatus
    claimed_existing_developer: boolean
  }>({ data, error })
}

type V111JsonObject = Record<string, unknown>

function v111Object(value: unknown): V111JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  return value as V111JsonObject
}

function v111String(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function v111NullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function v111Number(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function v111StringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function adaptAttributionCondition(
  value: unknown,
  ruleCode: string,
  index: number,
): AttributionRuleCondition {
  const condition = v111Object(value)
  const hasValue = Object.prototype.hasOwnProperty.call(condition, 'value')
  const rawValue = condition.value
  const parsedValue = typeof rawValue === 'string' || typeof rawValue === 'boolean' || typeof rawValue === 'number' || rawValue === null
    ? rawValue
    : v111StringArray(rawValue)
  return {
    id: v111String(condition.id, `${ruleCode}:condition:${String(index)}`),
    field: v111String(condition.field) as AttributionRuleCondition['field'],
    operator: v111String(condition.operator) as AttributionRuleCondition['operator'],
    ...(hasValue ? { value: parsedValue } : {}),
  }
}

function adaptAttributionRule(value: unknown): AttributionRuleDefinition {
  const rule = v111Object(value)
  if (typeof rule.rule_code === 'string') {
    const ruleCode = v111String(rule.rule_code)
    const action = v111Object(rule.action)
    return {
      id: v111String(rule.id, ruleCode),
      rule_code: ruleCode,
      display_name: v111String(rule.display_name),
      description: v111String(rule.description),
      priority: v111Number(rule.priority),
      enabled: rule.enabled === true,
      capability: v111String(rule.capability) as AttributionRuleDefinition['capability'],
      match: v111String(rule.match, 'ALL') as AttributionRuleDefinition['match'],
      conditions: (Array.isArray(rule.conditions) ? rule.conditions : []).map((item, index) =>
        adaptAttributionCondition(item, ruleCode, index),
      ),
      action: {
        type: v111String(action.type) as AttributionRuleDefinition['action']['type'],
        reason_code: v111String(action.reason_code),
      },
      system_locked: rule.system_locked === true,
    }
  }

  const ruleCode = v111String(rule.ruleCode)
  const when = v111Object(rule.when)
  const match = Array.isArray(when.any) ? 'ANY' : 'ALL'
  const clauses = (match === 'ANY' ? when.any : when.all) ?? []
  const rawCapability = v111String(rule.capability)
  const capability = rawCapability === 'MR_OPTIONAL'
    ? 'MR_ENHANCED'
    : rawCapability === 'SYSTEM'
      ? 'RANGE_GATE'
      : 'GIT_BASE'
  const action = v111Object(rule.action)
  return {
    id: ruleCode,
    rule_code: ruleCode,
    display_name: v111String(rule.displayName),
    description: v111String(rule.description),
    priority: v111Number(rule.priority),
    enabled: rule.enabled === true,
    capability,
    match,
    conditions: (Array.isArray(clauses) ? clauses : []).map((item, index) =>
      adaptAttributionCondition(item, ruleCode, index),
    ),
    action: {
      type: v111String(action.type) as AttributionRuleDefinition['action']['type'],
      reason_code: v111String(action.reasonCode),
    },
    system_locked: rule.systemLocked === true,
  }
}

function adaptAttributionValidation(value: unknown) {
  if (value === null || value === undefined) return null
  const validation = v111Object(value)
  return {
    passed: validation.passed === true || validation.valid === true,
    validated_revision: v111Number(validation.validated_revision, v111Number(validation.revision)),
    issues: (Array.isArray(validation.issues) ? validation.issues : []).map((rawIssue) => {
      const issue = v111Object(rawIssue)
      return {
        code: v111String(issue.code),
        message: v111String(issue.message, v111String(issue.code)),
        rule_id: v111NullableString(issue.rule_id),
        severity: v111String(issue.severity, 'ERROR') === 'WARNING' ? 'WARNING' as const : 'ERROR' as const,
      }
    }),
    validated_at: v111String(validation.validated_at),
  }
}

function adaptAttributionSimulation(value: unknown) {
  if (value === null || value === undefined) return null
  const simulation = v111Object(value)
  const metrics = v111Object(simulation.metrics)
  const contractChecks = v111Object(simulation.contract_checks)
  return {
    passed: simulation.passed === true,
    evaluation_kind: v111String(simulation.evaluation_kind, 'SYSTEM_SAFETY_CONTRACT') as 'SYSTEM_SAFETY_CONTRACT',
    contract_version: v111String(simulation.contract_version, 'SYSTEM_SAFETY_CONTRACT_V1'),
    assessment_note: v111String(simulation.assessment_note, '仅检查数据库安全契约，不评估规则效果、准确率或召回率。'),
    sample_set_id: v111String(simulation.sample_set_id),
    sample_set_label: v111String(simulation.sample_set_label, v111String(simulation.sample_set_id)),
    simulated_revision: v111Number(simulation.simulated_revision),
    simulated_ruleset_hash: v111NullableString(simulation.simulated_ruleset_hash),
    simulated_at: v111String(simulation.simulated_at),
    metrics: {
      effect_metrics_available: metrics.effect_metrics_available === true,
      gold_strong_false_positive_count: v111Number(metrics.gold_strong_false_positive_count),
      strong_selected_delta: v111Number(metrics.strong_selected_delta),
      ai_candidate_delta: v111Number(metrics.ai_candidate_delta),
      excluded_delta: v111Number(metrics.excluded_delta),
      conflict_delta: v111Number(metrics.conflict_delta),
      global_fallback_delta: v111Number(metrics.global_fallback_delta),
    },
    contract_checks: {
      system_rule_expected_count: v111Number(contractChecks.system_rule_expected_count, v111Number(metrics.system_rule_expected_count, 13)),
      system_rule_count: v111Number(contractChecks.system_rule_count, v111Number(metrics.system_rule_count)),
      custom_rule_count: v111Number(contractChecks.custom_rule_count, v111Number(metrics.custom_rule_count)),
      condition_count: v111Number(contractChecks.condition_count, v111Number(metrics.condition_count)),
      failed_check_count: v111Number(contractChecks.failed_check_count, v111Number(metrics.failed_check_count)),
    },
    blocking_reasons: v111StringArray(simulation.blocking_reasons),
  }
}

function adaptAttributionVersion(value: unknown): AttributionRuleVersion {
  const version = v111Object(value)
  return {
    id: v111String(version.id),
    version: typeof version.version === 'number' ? version.version : null,
    status: v111String(version.status) as AttributionRuleVersion['status'],
    revision: v111Number(version.revision),
    ruleset_hash: v111NullableString(version.ruleset_hash),
    source_version_id: v111NullableString(version.source_version_id),
    rules: (Array.isArray(version.rules) ? version.rules : []).map(adaptAttributionRule),
    validation: adaptAttributionValidation(version.validation),
    latest_simulation: adaptAttributionSimulation(version.latest_simulation),
    created_by_name: v111NullableString(version.created_by_name),
    created_at: v111NullableString(version.created_at),
    published_by_name: v111NullableString(version.published_by_name),
    published_at: v111NullableString(version.published_at),
    publish_reason: v111NullableString(version.publish_reason),
    referenced_job_count: typeof version.referenced_job_count === 'number' ? version.referenced_job_count : null,
  }
}

/** 适配 V1.11 完整 catalog；数组分支仅保留旧 foundation 部署的只读兼容。 */
export function adaptAttributionRuleCatalog(value: unknown): AttributionRuleCatalog {
  if (Array.isArray(value)) {
    const row = v111Object(value[0])
    const ruleSetId = v111String(row.id)
    if (ruleSetId === '') throw new Error('归属规则服务未返回规则集')
    const currentVersionId = v111NullableString(row.current_version_id)
    const publishedAt = v111NullableString(row.published_at)
    const currentVersion: AttributionRuleVersion | null = currentVersionId === null ? null : {
      id: currentVersionId,
      version: typeof row.current_version === 'number' ? row.current_version : null,
      status: 'PUBLISHED',
      revision: 0,
      ruleset_hash: v111NullableString(row.ruleset_hash),
      source_version_id: null,
      rules: (Array.isArray(row.rules) ? row.rules : []).map(adaptAttributionRule),
      validation: null,
      latest_simulation: null,
      created_by_name: null,
      created_at: publishedAt,
      published_by_name: null,
      published_at: publishedAt,
      publish_reason: null,
      referenced_job_count: null,
    }
    return {
      rule_set_id: ruleSetId,
      rule_set_name: v111String(row.display_name, '需求提交归属规则'),
      current_published_version_id: currentVersionId,
      versions: currentVersion === null ? [] : [currentVersion],
      sample_sets: [],
      mr_enhanced_available: null,
    }
  }

  const catalog = v111Object(value)
  const ruleSetId = v111String(catalog.rule_set_id)
  if (ruleSetId === '') throw new Error('归属规则服务未返回规则集')
  return {
    rule_set_id: ruleSetId,
    rule_set_name: v111String(catalog.rule_set_name, '需求提交归属规则'),
    current_published_version_id: v111NullableString(catalog.current_published_version_id),
    versions: (Array.isArray(catalog.versions) ? catalog.versions : []).map(adaptAttributionVersion),
    sample_sets: (Array.isArray(catalog.sample_sets) ? catalog.sample_sets : []).map((rawSample) => {
      const sample = v111Object(rawSample)
      return {
        id: v111String(sample.id),
        label: v111String(sample.label),
        frozen_at: v111String(sample.frozen_at),
        story_count: v111Number(sample.story_count),
        commit_count: v111Number(sample.commit_count),
        evaluation_kind: v111String(sample.evaluation_kind, 'SYSTEM_SAFETY_CONTRACT') as 'SYSTEM_SAFETY_CONTRACT',
        description: v111String(sample.description),
      }
    }),
    mr_enhanced_available: typeof catalog.mr_enhanced_available === 'boolean' ? catalog.mr_enhanced_available : null,
  }
}

function attributionRulesForRpc(rules: AttributionRuleDefinition[]): V111JsonObject[] {
  return rules.map((rule, index) => ({
    ruleCode: rule.rule_code,
    displayName: rule.display_name,
    description: rule.description,
    priority: rule.priority,
    enabled: rule.enabled,
    capability: rule.capability === 'MR_ENHANCED' ? 'MR_OPTIONAL' : rule.capability === 'RANGE_GATE' ? 'SYSTEM' : 'GIT_BASE',
    when: {
      [rule.match === 'ANY' ? 'any' : 'all']: rule.conditions.map((condition) => ({
        field: condition.field,
        operator: condition.operator,
        ...(condition.value === undefined ? {} : { value: condition.value }),
      })),
    },
    action: { type: rule.action.type, reasonCode: rule.action.reason_code },
    systemLocked: rule.system_locked,
    sortOrder: index,
  }))
}

export async function adminListAttributionRuleSets(): Promise<AttributionRuleCatalog> {
  const client = requireSupabase()
  const { data, error } = await client.rpc('admin_get_attribution_rule_catalog')
  return adaptAttributionRuleCatalog(unwrap<unknown>({ data, error }))
}

async function requireAttributionRuleVersion(versionId: string): Promise<AttributionRuleVersion> {
  const catalog = await adminListAttributionRuleSets()
  const version = catalog.versions.find((item) => item.id === versionId)
  if (version === undefined) throw new Error('归属规则服务未返回操作后的版本，请刷新后重试')
  return version
}

async function adminCreateAttributionRuleDraft(sourceVersionId: string): Promise<AttributionRuleVersion> {
  const client = requireSupabase()
  const { data, error } = await client.rpc('admin_create_attribution_rule_draft', {
    p_source_version_id: sourceVersionId,
  })
  return requireAttributionRuleVersion(unwrap<string>({ data, error }))
}

async function adminSaveAttributionRuleDraft(input: {
  draftVersionId: string
  expectedRevision: number
  rules: AttributionRuleDefinition[]
}): Promise<AttributionRuleVersion> {
  const client = requireSupabase()
  const { data, error } = await client.rpc('admin_save_attribution_rule_draft', {
    p_draft_version_id: input.draftVersionId,
    p_expected_revision: input.expectedRevision,
    p_rules: attributionRulesForRpc(input.rules),
  })
  unwrap<number>({ data, error })
  return requireAttributionRuleVersion(input.draftVersionId)
}

async function adminValidateAttributionRuleDraft(input: {
  draftVersionId: string
  expectedRevision: number
}) {
  const client = requireSupabase()
  const { data, error } = await client.rpc('admin_validate_attribution_rule_draft', {
    p_draft_version_id: input.draftVersionId,
  })
  const validation = adaptAttributionValidation(unwrap<unknown>({ data, error }))
  if (validation === null) throw new Error('数据库未返回归属规则校验结果')
  if (validation.validated_revision !== input.expectedRevision) throw new Error('归属规则 revision 已变化，请刷新后重试')
  return validation
}

async function adminSimulateAttributionRuleDraft(input: {
  draftVersionId: string
  expectedRevision: number
  sampleSetId: string
}) {
  const client = requireSupabase()
  const { data, error } = await client.rpc('admin_simulate_attribution_rule_draft', {
    p_draft_version_id: input.draftVersionId,
    p_expected_revision: input.expectedRevision,
    p_sample_set_id: input.sampleSetId,
  })
  const simulation = adaptAttributionSimulation(unwrap<unknown>({ data, error }))
  if (simulation === null) throw new Error('数据库未返回可信安全契约检查结果')
  return simulation
}

async function adminPublishAttributionRuleVersion(input: {
  draftVersionId: string
  expectedRevision: number
  reason: string
}): Promise<AttributionRuleVersion> {
  const client = requireSupabase()
  const { data, error } = await client.rpc('admin_publish_attribution_rule_version', {
    p_draft_version_id: input.draftVersionId,
    p_expected_revision: input.expectedRevision,
    p_reason: input.reason,
  })
  const result = v111Object(unwrap<unknown>({ data, error }))
  return requireAttributionRuleVersion(v111String(result.version_id))
}

async function adminRestoreAttributionRuleVersion(input: {
  sourceVersionId: string
  reason: string
}): Promise<AttributionRuleVersion> {
  const client = requireSupabase()
  const { data, error } = await client.rpc('admin_restore_attribution_rule_version', {
    p_source_version_id: input.sourceVersionId,
    p_reason: input.reason,
  })
  const result = v111Object(unwrap<unknown>({ data, error }))
  return requireAttributionRuleVersion(v111String(result.version_id))
}

export const attributionRulesApi: AttributionRulesApi = {
  draftManagementAvailable: true,
  trustedSimulationAvailable: true,
  unavailableReason: null,
  listRuleSets: adminListAttributionRuleSets,
  createDraft: adminCreateAttributionRuleDraft,
  saveDraft: adminSaveAttributionRuleDraft,
  validateDraft: adminValidateAttributionRuleDraft,
  simulateDraft: adminSimulateAttributionRuleDraft,
  publishVersion: adminPublishAttributionRuleVersion,
  restoreVersion: adminRestoreAttributionRuleVersion,
}

/** 将最终 scope summary RPC 返回值转换为共享卡片模型。 */
export function adaptRuntimeAnalysisScopeSummary(value: unknown): RuntimeAnalysisScopeSummary | null {
  if (value === null) return null
  const summary = v111Object(value)
  if (v111String(summary.task_id) === '') return null
  const repositories: RuntimeRepositoryScope[] = (Array.isArray(summary.repositories) ? summary.repositories : []).map((value) => {
    const repository = v111Object(value)
    return {
      repository_name: v111String(repository.repository_name),
      base_sha: v111NullableString(repository.base_sha),
      head_sha: v111String(repository.head_sha),
      range_source: v111String(repository.range_source),
      commit_count: typeof repository.commit_count === 'number' ? repository.commit_count : null,
      enumeration_status: v111String(repository.enumeration_status),
      range_start_at: v111String(repository.range_start_at),
      range_end_at: v111String(repository.range_end_at),
      resolved_at: v111String(repository.resolved_at),
    }
  })
  const expansions: RuntimeScopeExpansion[] = (Array.isArray(summary.expansions) ? summary.expansions : []).map((value) => {
    const expansion = v111Object(value)
    return {
      id: v111String(expansion.id),
      attempt: v111Number(expansion.attempt),
      agent_label: v111String(expansion.agent_label),
      from_level: v111String(expansion.from_level) as RuntimeScopeExpansion['from_level'],
      to_level: v111String(expansion.to_level) as RuntimeScopeExpansion['to_level'],
      reason_code: v111String(expansion.reason_code),
      occurred_at: v111String(expansion.occurred_at),
    }
  })
  return {
    task_id: v111String(summary.task_id),
    generation: v111Number(summary.generation),
    status: v111String(summary.status) as RuntimeAnalysisScopeSummary['status'],
    mode: v111String(summary.mode) as RuntimeAnalysisScopeSummary['mode'],
    error_code: v111NullableString(summary.error_code),
    window_days: typeof summary.window_days === 'number' ? summary.window_days : null,
    candidate_count: v111Number(summary.candidate_count),
    strong_count: v111Number(summary.strong_count),
    ai_candidate_count: v111Number(summary.ai_candidate_count),
    ai_related_count: v111Number(summary.ai_related_count),
    ai_uncertain_count: v111Number(summary.ai_uncertain_count),
    read_count: v111Number(summary.read_count),
    reverted_count: v111Number(summary.reverted_count),
    current_scope_level: v111String(summary.current_scope_level) as RuntimeAnalysisScopeSummary['current_scope_level'],
    algorithm_version: v111String(summary.algorithm_version),
    manifest_hash: v111NullableString(summary.manifest_hash),
    degradation_reasons: v111StringArray(summary.degradation_reasons),
    frozen_at: v111NullableString(summary.frozen_at),
    repositories,
    expansions,
  }
}

function adaptRuntimeScopeCommit(value: unknown): RuntimeAnalysisScopeCommit {
  const item = v111Object(value)
  return {
    candidate_id: v111String(item.candidate_id),
    generation: v111Number(item.generation),
    view: v111String(item.view) as RuntimeAnalysisScopeCommit['view'],
    relation_status: v111String(item.relation_status) as RuntimeAnalysisScopeCommit['relation_status'],
    effective_status: v111String(item.effective_status) as RuntimeAnalysisScopeCommit['effective_status'],
    repository_name: v111String(item.repository_name),
    short_sha: v111String(item.short_sha),
    committed_at: v111String(item.committed_at),
    author_display_name: v111String(item.author_display_name),
    author_email_masked: v111NullableString(item.author_email_masked),
    subject: v111String(item.subject),
    files_changed: v111Number(item.files_changed),
    additions: v111Number(item.additions),
    deletions: v111Number(item.deletions),
    reason_codes: v111StringArray(item.reason_codes),
    actually_read: item.actually_read === true,
    read_count: v111Number(item.read_count),
  }
}

/** 适配已由服务端按 generation、view 和 cursor 过滤的提交页。 */
export function adaptRuntimeAnalysisScopeCommitPage(value: unknown): RuntimeAnalysisScopeCommitPage {
  const page = v111Object(value)
  return {
    task_id: v111String(page.task_id),
    generation: v111Number(page.generation),
    items: (Array.isArray(page.items) ? page.items : []).map(adaptRuntimeScopeCommit),
    next_cursor: page.next_cursor === null || page.next_cursor === undefined
      ? null
      : v111String(page.next_cursor),
    total: v111Number(page.total),
  }
}

export async function getAnalysisStoryScopeSummary(taskId: string) {
  const client = requireSupabase()
  const { data, error } = await client.rpc('get_analysis_story_scope_summary', {
    p_task_id: taskId,
  })
  return adaptRuntimeAnalysisScopeSummary(unwrap<unknown>({ data, error }))
}

export async function getAnalysisStoryScopeCommits(input: {
  taskId: string
  generation: number
  view: RuntimeScopeCommitView
  cursor: string | null
  limit: number
}) {
  const client = requireSupabase()
  const { data, error } = await client.rpc('get_analysis_story_scope_commits', {
    p_task_id: input.taskId,
    p_generation: input.generation,
    p_view: input.view,
    p_cursor: input.cursor,
    p_limit: input.limit,
  })
  return adaptRuntimeAnalysisScopeCommitPage(unwrap<unknown>({ data, error }))
}

export const runtimeAnalysisScopeApi: RuntimeAnalysisScopeApi = {
  getSummary: getAnalysisStoryScopeSummary,
  listCommits: getAnalysisStoryScopeCommits,
}

// ---------------------------------------------------------------------------
// V1.6 受管 DSH Skill Bundle
// ---------------------------------------------------------------------------

/**
 * 调用 `skill-bundle-admin` Edge Function。
 *
 * 写操作一律走它，而不是直接 `client.from('review_skill_version').insert(...)`：
 * 浏览器能直接写版本表就意味着它能自报 locator 与 hash，而 §15 明确禁止这一点。
 */
async function invokeSkillBundleAdmin<T>(body: Record<string, unknown>): Promise<T> {
  const client = requireSupabase()
  const { data, error } = await client.functions.invoke('skill-bundle-admin', { body })
  if (error) {
    const context = (error as { context?: unknown }).context
    let message: string | undefined
    if (context instanceof Response) {
      try {
        const responseBody = (await context.clone().json()) as { error?: string }
        message = responseBody.error
      } catch {
        // 非 JSON 错误响应退回 SDK 默认信息。
      }
    }
    throw new Error(message ?? error.message)
  }
  const result = data as T & { error?: string }
  if (result && typeof result === 'object' && 'error' in result && result.error) {
    throw new Error(String(result.error))
  }
  return result
}

/** 技能列表 + 全局容量水位。只读，函数体第一句是 ensure_admin()。 */
export async function adminListReviewSkills() {
  const client = requireSupabase()
  const { data, error } = await client.rpc('admin_list_review_skills')
  return unwrap<ReviewSkillCatalog>({ data, error })
}

export async function adminGetReviewSkill(skillId: string) {
  const client = requireSupabase()
  const { data, error } = await client.rpc('admin_get_review_skill', { p_skill_id: skillId })
  return unwrap<ReviewSkillDetail>({ data, error })
}

export function adminCreateReviewSkill(input: { name: string; displayName: string }) {
  return invokeSkillBundleAdmin<{ skill_id: string }>({
    action: 'create-skill',
    name: input.name,
    display_name: input.displayName,
  })
}

export function adminSetReviewSkillEnabled(skillId: string, enabled: boolean) {
  return invokeSkillBundleAdmin<{ ok: boolean }>({
    action: 'set-enabled',
    skill_id: skillId,
    enabled,
  })
}

/**
 * 删除技能及其全部版本。
 *
 * 服务端会拒绝删除任何**被 Analysis Job 冻结过**的技能（`SKILL_REFERENCED_BY_JOB`）：
 * `analysis_job_skill_snapshot` 是"那次评审到底给了模型哪些技能"的唯一证据。
 *
 * `orphaned_objects > 0` 表示库行已删除但归档对象没删掉。这不是失败——它只影响容量
 * 水位，不影响正确性，所以调用方提示一下即可，不要重试删除（技能已经不存在了）。
 */
export function adminDeleteReviewSkill(skillId: string) {
  return invokeSkillBundleAdmin<{
    ok: boolean
    skill_name: string
    orphaned_objects: number
  }>({
    action: 'delete-skill',
    skill_id: skillId,
  })
}

/**
 * 上传一个 Skill Bundle ZIP 到 staging 并请求服务端校验。
 *
 * 三步都必须按顺序发生，而且 key 与 token 都来自服务端：
 *
 *   1. `create-upload` —— 服务端拼 `staging/<admin>/<uuid>.zip` 并签发短期写令牌；
 *   2. 浏览器用该令牌直传（大文件不经 Edge Function，省一次 10 MiB 的转发）；
 *   3. `validate` —— 服务端用 service-role 把字节读回来解析。
 *
 * 浏览器全程不知道正式 key，也不参与任何 hash 计算。
 */
export async function adminUploadSkillBundle(skillId: string, file: File) {
  const client = requireSupabase()
  const ticket = await invokeSkillBundleAdmin<SkillUploadTicket>({
    action: 'create-upload',
    skill_id: skillId,
  })
  const { error } = await client.storage
    .from(ticket.bucket)
    .uploadToSignedUrl(ticket.path, ticket.token, file, {
      contentType: 'application/zip',
    })
  if (error) throw new Error(error.message)
  return adminValidateSkillUpload(ticket.upload_id)
}

export function adminValidateSkillUpload(uploadId: string) {
  return invokeSkillBundleAdmin<SkillValidationResult>({ action: 'validate', upload_id: uploadId })
}

/**
 * 发布已校验的上传。
 *
 * 刻意**不接受** description / whenToUse：它们由服务端从 `SKILL.md` 的 frontmatter 取。
 * 前端能自定义 description 的话，库里存的文本就会与 dsh 渲染给模型的文本分叉。
 */
export function adminPublishSkillVersion(input: {
  uploadId: string
  acknowledgeScripts?: boolean
}) {
  return invokeSkillBundleAdmin<{
    skill_id: string
    version_id: string
    version: number
    bundle_hash: string
    contains_scripts: boolean
  }>({
    action: 'publish',
    upload_id: input.uploadId,
    acknowledge_scripts: input.acknowledgeScripts ?? false,
  })
}

/**
 * 请求已发布 Bundle 的短期下载路径。
 *
 * 只有 ADMIN 能调用。返回的相对路径包含**短期访问凭据**：不落库、不进日志，也永远不作为
 * 冻结 locator。浏览器用公开 Supabase URL 补全 origin；Worker 走 service-role +
 * 冻结 bucket/key 那条路。
 */
export function adminCreateSkillDownloadUrl(versionId: string) {
  return invokeSkillBundleAdmin<{ signed_path: string; expires_in_seconds: number }>({
    action: 'create-download-url',
    version_id: versionId,
  })
}

// ---------------------------------------------------------------------------
// V1.19 技能 AI 优化
// ---------------------------------------------------------------------------

/**
 * 技能的历史评审证据聚合。
 *
 * 纯只读，函数体第一句是 `ensure_admin()`。`referenced_job_count === 0` 不是错误，
 * 是"这个技能还没被任何 Job 引用"这一事实 —— 页面据此提前禁用 AI 优化入口，而不是等
 * Worker 跑完才报错。
 */
export async function adminGetSkillReviewEvidence(skillId: string) {
  const client = requireSupabase()
  const { data, error } = await client.rpc('admin_get_skill_review_evidence', {
    p_skill_id: skillId,
  })
  return unwrap<SkillReviewEvidence>({ data, error })
}

/**
 * 发起一次 AI 优化。
 *
 * **幂等**：同一技能已有进行中任务时返回那一条，不创建第二条（数据库侧还有一个部分唯一
 * 索引兜底）。所以重复点击、或者关闭再打开弹窗，看到的都是同一条任务。
 */
export async function adminEnqueueSkillAiOptimization(skillId: string) {
  const client = requireSupabase()
  const { data, error } = await client.rpc('admin_enqueue_skill_ai_optimization', {
    p_skill_id: skillId,
  })
  return unwrap<SkillAiOptimizationTask>({ data, error })
}

/**
 * 按技能查最近一条优化任务，供轮询与"刷新后恢复状态"用。
 *
 * 从未优化过的技能返回 null —— 页面显示"还没有优化过"，而不是报错。
 */
export async function adminGetSkillAiOptimizationTask(skillId: string) {
  const client = requireSupabase()
  const { data, error } = await client.rpc('admin_get_skill_ai_optimization_task', {
    p_skill_id: skillId,
  })
  return unwrap<SkillAiOptimizationTask | null>({ data, error })
}

/**
 * 取优化草稿与当前已发布版本的逐文件正文。
 *
 * 走 Edge Function 而不是直接读 Storage：两侧正文都不在数据库里（任务表刻意不存正文），
 * 而 `skill-bundles` bucket 对 `authenticated` **没有任何策略** —— 浏览器读不到字节，
 * 这是设计而不是遗漏。
 */
export function adminGetSkillOptimizationDiff(requestId: string) {
  return invokeSkillBundleAdmin<SkillOptimizationDiff>({
    action: 'optimization-diff',
    request_id: requestId,
  })
}

// ---------------------------------------------------------------------------
// V1.20 Linky 用户故事直连（修订：看板实时直连，批次在确认时冻结）。
//
// 看板的取数**不在这里** —— 它由浏览器直接请求 Linky（见 src/lib/linky-live.ts）。
// 这里只有两件事：下一张导入单，和查这张单子的进度。
//
// 为什么导入要绕一圈 Worker：让浏览器把抓到的正文直接写库，等于让前端提供"需求正文"
// 这一评审输入，平台无从判断它是否真的来自 Linky；而 Linky 只在内网可达，Worker 正好在
// 那张网上。于是前端只提交「组 + 窗口 + 勾选的编号」，内容由服务端取。
// ---------------------------------------------------------------------------

/** 下一张导入单。同一批次已有在途单子时返回那一张（幂等）。 */
export async function requestLinkyBatchImport(input: {
  batchId: string
  workspaceName: string
  storyCodes: string[]
  workspaceId?: string | null
  releaseWindow?: string | null
}) {
  const client = requireSupabase()
  const { data, error } = await client.rpc('request_linky_batch_import', {
    p_batch_id: input.batchId,
    p_workspace_name: input.workspaceName,
    p_story_codes: input.storyCodes,
    p_workspace_id: input.workspaceId ?? null,
    p_release_window: input.releaseWindow ?? null,
  })
  return unwrap<string>({ data, error })
}

/**
 * V1.31：开始分析的第一道工序。此 RPC 只创建并冻结「导入后自动分析」意图；
 * 需求正文/附件仍由 Worker 取，完成 RPC 才会创建实际 Job。
 */
export async function requestLinkyBatchImportForAnalysis(input: {
  batchId: string
  workspaceName: string
  storyCodes: string[]
  workspaceId?: string | null
  releaseWindow?: string | null
  commitWindowDays: CommitWindowDays
}) {
  const client = requireSupabase()
  const { data, error } = await client.rpc('request_linky_batch_import_for_analysis', {
    p_batch_id: input.batchId,
    p_workspace_name: input.workspaceName,
    p_story_codes: input.storyCodes,
    p_workspace_id: input.workspaceId ?? null,
    p_release_window: input.releaseWindow ?? null,
    p_commit_window_days: input.commitWindowDays,
  })
  return unwrap<string>({ data, error })
}

/** V1.32：复用失败自动导入单的冻结范围，在代理/网络恢复后重新排队。 */
export async function retryLinkyBatchImportForAnalysis(requestId: string) {
  const client = requireSupabase()
  const { data, error } = await client.rpc('retry_linky_batch_import_for_analysis', {
    p_request_id: requestId,
  })
  return unwrap<string>({ data, error })
}

export async function getLinkyBatchImport(requestId: string) {
  const client = requireSupabase()
  const { data, error } = await client.rpc('get_linky_batch_import', { p_request_id: requestId })
  return unwrap<LinkyBatchImportRequest>({ data, error })
}

/** 批次页要显示「上一次导入是什么范围、成功几条」。没有导入过返回 null。 */
export async function getLatestLinkyBatchImport(batchId: string) {
  const client = requireSupabase()
  const { data, error } = await client.rpc('get_latest_linky_batch_import', {
    p_batch_id: batchId,
  })
  if (error) throw error
  return (data ?? null) as LinkyBatchImportRequest | null
}

/** 批次内已冻结的需求附件。 */
export async function listReviewStoryAttachments(storyIds: string[]) {
  if (storyIds.length === 0) return [] as ReviewStoryAttachment[]
  const client = requireSupabase()
  const { data, error } = await client
    .from('review_story_attachment')
    .select('*')
    .in('story_id', storyIds)
    .order('filename')
  return unwrap<ReviewStoryAttachment[]>({ data, error })
}

/** 冻结附件的下载：60 秒 signed URL，与 review-files 同一套做法。 */
export async function createStoryAttachmentSignedUrl(storagePath: string) {
  const client = requireSupabase()
  const { data, error } = await client.storage
    .from('story-attachments')
    .createSignedUrl(storagePath, 60)
  if (error) throw error
  return data.signedUrl
}

/** 把导入链路的稳定错误码翻译成人话。 */
export function describeLinkyError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  if (raw.includes('LINKY_IMPORT_EMPTY_SELECTION')) return '请先勾选要导入的需求。'
  if (raw.includes('LINKY_IMPORT_WORKSPACE_REQUIRED')) return '请先选定项目组，它定义了这批需求的来源。'
  if (raw.includes('LINKY_IMPORT_TOO_MANY_STORIES')) return '一次最多导入 500 条需求，请拆成多个批次。'
  if (raw.includes('LINKY_IMPORT_STORY_NO_REQUIREMENT_SOURCE')) {
    // 2026-09-24 起不再拒绝空需求，这条只为解释历史导入记录里已有的失败行。
    return '这条失败来自旧版门禁（需求既无正文也无附件），现在同类需求会正常导入，重新导入一次即可。'
  }
  if (raw.includes('LINKY_IMPORT_STORY_NOT_REQUESTED')) return '导入单与提交的需求不匹配，请重新发起导入。'
  if (raw.includes('LINKY_IMPORT_LEASE_LOST')) return '这张导入单已被另一个 Worker 接管，请刷新查看进度。'
  if (raw.includes('LINKY_IMPORT_NOT_FOUND')) return '找不到这张导入单。'
  if (raw.includes('LINKY_WORKSPACE_NOT_FOUND')) {
    // 上游按名称精确匹配，且"工作区不存在"返回的是空列表而不是报错 —— 所以这条
    // 以前会伪装成网络错误，让人去查代理和 VPN（那两样都是好的）。
    return '项目组在 Linky 里没有任何需求：它要么不存在，要么名称不完全一致（上游按名称精确匹配）。请在「用户故事」看板上复制项目组名后重新提交。'
  }
  if (raw.includes('LINKY_UPSTREAM_AUTH_FAILED')) {
    return 'Linky 取数接口拒绝了平台侧凭据（token 失效或过期）。这不是你的网络问题，重试和连 VPN 都没用，需要质量执行平台的维护者在「配置 › Linky 工作区」更新 token。'
  }
  if (raw.includes('LINKY_PROXY_PORT_BLOCKED')) {
    return '宿主机代理拒绝了到 Linky 的隧道：代理需要放开 Linky 的端口（2055/90）。'
  }
  if (raw.includes('LINKY_PROXY_UNREACHABLE')) return '无法连接宿主机代理。请确认代理服务已恢复后，点击“重试准备”。'
  if (raw.includes('LINKY_IMPORT_RETRY_NOT_FAILED')) return '当前需求准备不是失败状态，请刷新后再操作。'
  if (raw.includes('LINKY_IMPORT_RETRY_NOT_AUTOMATIC')) return '这不是可重试的自动需求准备单，请重新选择需求后开始分析。'
  if (raw.includes('LINKY_IMPORT_RETRY_ACTIVE')) return '当前批次已有另一项需求准备正在进行，请等待其完成后再试。'
  if (raw.includes('ACTIVE_JOB_EXISTS')) return '该批次有分析任务在运行，先停止后再导入需求。'
  if (raw.includes('BATCH_READ_ONLY')) return '该批次已完成或已有 AI 结果，不能再导入需求。'
  return raw
}

/* ---------------------------------------------------------------------------
 * V1.23 产品代码问答
 *
 * 这七个 RPC 是浏览器能碰到的全部。Worker 侧那十个（claim / heartbeat / stage /
 * bind / secret / submit / reclaim）对 authenticated **没有** execute 权限，
 * 所以这里连封装都不存在 —— 缺席是设计，不是遗漏。
 * ------------------------------------------------------------------------- */

/** 仓库、分支、可用技能三份清单。产品在新建会话时用它选仓库与分支。 */
export async function getCodeQaCatalog() {
  const client = requireSupabase()
  const { data, error } = await client.rpc('code_qa_catalog')
  return unwrap<CodeQaCatalog>({ data, error })
}

/**
 * 新建会话。仓库集合与分支在这里定下，之后不能改。
 *
 * 可以一次选多个仓库（产品的问题经常跨前后端）。不能事后改是刻意的：DSH 会话的历史是
 * 连续的，中途加减仓库会让已经给出的回答对应不上现在挂着的代码。要换就开新会话。
 */
export async function createCodeQaConversation(input: {
  repositories: string[]
  branch: DefaultBranch
  /** 新建会话必须单选一个启用且密钥可用的模型；服务端会再次校验。 */
  modelConfigId: string
  title?: string | null
}) {
  const client = requireSupabase()
  const { data, error } = await client.rpc('create_code_qa_conversation', {
    p_repositories: input.repositories,
    p_branch: input.branch,
    p_model_config_id: input.modelConfigId,
    p_title: input.title ?? null,
  })
  return unwrap<CodeQaConversationSummary>({ data, error })
}

export async function listCodeQaConversations() {
  const client = requireSupabase()
  const { data, error } = await client.rpc('list_code_qa_conversations')
  return unwrap<CodeQaConversationSummary[]>({ data, error })
}

/** 会话 + 全部轮次。页面在有在飞轮次时每 2 秒调一次。 */
export async function getCodeQaConversation(conversationId: string) {
  const client = requireSupabase()
  const { data, error } = await client.rpc('get_code_qa_conversation', {
    p_conversation_id: conversationId,
  })
  return unwrap<CodeQaConversationDetail>({ data, error })
}

export async function renameCodeQaConversation(input: { conversationId: string; title: string }) {
  const client = requireSupabase()
  const { data, error } = await client.rpc('rename_code_qa_conversation', {
    p_conversation_id: input.conversationId,
    p_title: input.title,
  })
  return unwrap<CodeQaConversationSummary>({ data, error })
}

export async function deleteCodeQaConversation(conversationId: string) {
  const client = requireSupabase()
  const { data, error } = await client.rpc('delete_code_qa_conversation', {
    p_conversation_id: conversationId,
  })
  return unwrap<boolean>({ data, error })
}

/** 置顶状态仅由服务端按会话 owner 持久化；浏览器不能直接更新会话表。 */
export async function setCodeQaConversationPinned(input: {
  conversationId: string
  isPinned: boolean
}) {
  const client = requireSupabase()
  const { data, error } = await client.rpc('set_code_qa_conversation_pinned', {
    p_conversation_id: input.conversationId,
    p_is_pinned: input.isPinned,
  })
  return unwrap<CodeQaConversationSummary>({ data, error })
}

/**
 * 提一个问题。
 *
 * 新会话的模型在创建时已锁定；每轮只从该会话模型冻结调用快照。所选模型停用或缺 Key 时
 * 入队即失败（抛错），不会偷偷回退到其它模型或留下永远排队的轮次。
 */
export async function requestCodeQaTurn(input: { conversationId: string; question: string }) {
  const client = requireSupabase()
  const { data, error } = await client.rpc('request_code_qa_turn', {
    p_conversation_id: input.conversationId,
    p_question: input.question,
  })
  return unwrap<CodeQaTurnQueued>({ data, error })
}

/** 把 RPC 抛出的稳定错误码翻成一句中文。页面只显示这一句。 */
export function describeCodeQaRpcError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  if (raw.includes('CODE_QA_CONVERSATION_NOT_FOUND')) return '找不到这个会话，或它不属于你。'
  if (raw.includes('CODE_QA_TURN_IN_FLIGHT')) return '这个会话还有一个问题正在回答，请等它结束。'
  if (raw.includes('CODE_QA_QUESTION_REQUIRED')) return '请先输入问题。'
  if (raw.includes('CODE_QA_REPOSITORY_REQUIRED')) return '请至少选择一个代码仓库。'
  if (raw.includes('CODE_QA_REPOSITORY_NOT_IN_CONVERSATION')) {
    return '这个仓库不在当前会话的范围内。'
  }
  if (raw.includes('code_qa_conversation_repositories_valid')) {
    return '选择的仓库不合法：至少一个、不能重复，且必须在平台支持的仓库列表内。'
  }
  if (raw.includes('CODE_QA_TITLE_REQUIRED')) return '标题不能为空。'
  if (raw.includes('MODEL_CONFIG_REQUIRED')) return '请在新建对话时选择一个模型。'
  if (raw.includes('MODEL_CONFIG_NOT_FOUND')) {
    return '所选模型不存在，请刷新后重新选择。'
  }
  if (raw.includes('MODEL_CONFIG_DISABLED')) {
    return '所选模型已停用，请选择其他启用模型。'
  }
  if (raw.includes('MODEL_SECRET_MISSING')) {
    return '所选模型配置缺少可用的 API Key，请联系管理员补齐。'
  }
  if (raw.includes('AUTH_REQUIRED')) return '登录状态已失效，请重新登录。'
  return raw
}
