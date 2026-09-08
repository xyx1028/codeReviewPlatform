import type { Session } from '@supabase/supabase-js'
import { requireSupabase } from './supabase'
import type { FieldMapping } from './excel'
import type {
  AdminUserListItem,
  AiCodeEvidence,
  AiEvidenceInput,
  AiImportRecord,
  AiReviewResult,
  BatchOperationLog,
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
