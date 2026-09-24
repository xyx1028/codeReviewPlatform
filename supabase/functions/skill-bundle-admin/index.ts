// supabase/functions/skill-bundle-admin/index.ts
//
// 受管 Skill Bundle 的上传、校验、发布与下载服务（方案 §6.1、§14、§15）。
//
// 五个动作：
//
//   create-upload         校验 ADMIN → 返回 staging 的短期 signed upload 信息
//   validate              service-role 下载 staging ZIP → 校验 → 落库校验结果
//   publish               把校验结果提升为不可变版本 + 写不可变正式对象 + 清理 staging
//   create-download-url   ADMIN 请求已发布 Bundle 的短期 signed URL
//   optimization-diff     V1.19：取 AI 优化草稿与当前版本的逐文件正文，供前端渲染 diff
//
// 安全约束（每一条都对应 §15 的一行）：
//
//   * 只接受已登录且 role='ADMIN' 的调用者。角色由 service-role 直查 user_profile 判定，
//     不依赖 RLS 细节，也不相信 JWT 里的任何自定义 claim。
//   * **绝不接受浏览器自报的正式 bucket / key / hash / manifest。** 正式 key 由服务端按
//     `<skill-id>/versions/<version>/<archive-sha256>.zip` 生成，manifest 与三层 hash 由
//     服务端解析归档得出，数据库还会用 `skill_bundle_hash()` 再算一次。
//   * 正式对象 `upsert: false`。已发布对象永不覆盖。
//   * 日志不含 ZIP 正文、脚本正文、signed URL 或 Authorization 头。
//
// 依赖的数据库函数（20260917100000 迁移，仅授权 service_role）：
//   admin_create_review_skill / admin_register_skill_upload /
//   admin_record_skill_upload_validation / admin_record_skill_upload_failure /
//   admin_publish_review_skill_version / admin_set_review_skill_enabled /
//   admin_get_skill_upload / admin_get_skill_version_locator
// V1.19 追加（20260924034553 迁移，仅授权 service_role）：
//   admin_get_skill_optimization_diff_sources

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4'
import { BundleError, LIMITS, readArchiveTextEntries, validateSkillArchive } from './bundle.ts'
import { toSkillBundleSignedPath } from './download-url.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const BUCKET = 'skill-bundles'
/** staging 上传令牌的有效期。短到足以完成一次上传，长到容忍一次慢网络。 */
const UPLOAD_URL_TTL_SECONDS = 600
/** ADMIN 下载已发布 Bundle 的 signed URL 有效期。 */
const DOWNLOAD_URL_TTL_SECONDS = 120

const LOCAL_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
]

function allowedOrigins(): string[] {
  const raw = Deno.env.get('ALLOWED_ORIGINS') ?? ''
  const configured = raw
    .split(',')
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .filter((origin) => origin.length > 0)
  return Array.from(new Set([...configured, ...LOCAL_ORIGINS]))
}

function corsHeaders(req: Request): Record<string, string> {
  const origin = (req.headers.get('Origin') ?? '').replace(/\/+$/, '')
  const headers: Record<string, string> = {
    Vary: 'Origin',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  }
  // 绝不通配 '*'：这个端点能签发对私有 bucket 的写令牌。
  if (origin && allowedOrigins().includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin
  }
  return headers
}

let CURRENT_CORS: Record<string, string> = {}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CURRENT_CORS, 'Content-Type': 'application/json' },
  })
}

/** 只回一行原因，且只回 message —— 不带 details/hint，避免把 SQL 片段或行数据带出去。 */
function reason(error: unknown): string | undefined {
  const message =
    error && typeof error === 'object' && 'message' in error
      ? String((error as { message?: unknown }).message ?? '')
      : typeof error === 'string'
        ? error
        : ''
  const single = message.replace(/\s+/g, ' ').trim()
  if (single === '') return undefined
  return single.length > 300 ? `${single.slice(0, 300)}…` : single
}

/** 安全日志：只记事件与非敏感字段。绝不含归档正文、脚本正文、signed URL 或凭据。 */
function logEvent(event: string, meta: Record<string, unknown> = {}): void {
  const safe: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(meta)) {
    if (/key|secret|token|authorization|password|url/i.test(key)) continue
    safe[key] = value
  }
  console.log(
    JSON.stringify({ ts: new Date().toISOString(), fn: 'skill-bundle-admin', event, ...safe }),
  )
}

function serviceClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

async function requireAdmin(req: Request): Promise<{ userId: string } | Response> {
  const authHeader = req.headers.get('Authorization') ?? ''
  if (!authHeader.startsWith('Bearer ')) return json({ error: 'missing bearer token' }, 401)

  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const { data: userData, error: userError } = await userClient.auth.getUser()
  if (userError || !userData?.user) return json({ error: 'invalid session' }, 401)

  const { data: profile, error: profileError } = await serviceClient()
    .from('user_profile')
    .select('role')
    .eq('id', userData.user.id)
    .maybeSingle()
  if (profileError || !profile || profile.role !== 'ADMIN') {
    return json({ error: 'ADMIN role required' }, 403)
  }
  return { userId: userData.user.id }
}

interface CreateSkillPayload {
  action: 'create-skill'
  name: string
  display_name: string
}

interface CreateUploadPayload {
  action: 'create-upload'
  skill_id: string
}

interface ValidatePayload {
  action: 'validate'
  upload_id: string
}

interface PublishPayload {
  action: 'publish'
  upload_id: string
  /**
   * 含脚本的版本必须显式确认（§7.4）。缺失时数据库会拒。
   *
   * 刻意**没有** description / when_to_use：它们只能来自 `SKILL.md` 的 frontmatter。
   * 让调用方另给一段文字等于制造两个真相 —— dsh 在首轮目录里渲染的是 frontmatter 那份，
   * 库里存另一份的话，管理页、审计和模型看到的会是三份不同的文本。
   */
  acknowledge_scripts?: boolean
}

interface SetEnabledPayload {
  action: 'set-enabled'
  skill_id: string
  enabled: boolean
}

interface DeleteSkillPayload {
  action: 'delete-skill'
  skill_id: string
}

interface CreateDownloadUrlPayload {
  action: 'create-download-url'
  version_id: string
}

/**
 * V1.19：取一次 AI 优化草稿与当前已发布版本的逐文件正文，供前端渲染 diff。
 *
 * 为什么必须走服务端：两侧正文都不在数据库里（新表刻意不存正文），而 `skill-bundles`
 * bucket **没有任何 authenticated 策略** —— 浏览器读不到任何一侧的字节。让它读就等于给
 * 浏览器开一条读取全部技能归档的通道。
 */
interface OptimizationDiffPayload {
  action: 'optimization-diff'
  request_id: string
}

type Payload =
  | CreateSkillPayload
  | CreateUploadPayload
  | ValidatePayload
  | PublishPayload
  | SetEnabledPayload
  | DeleteSkillPayload
  | CreateDownloadUrlPayload
  | OptimizationDiffPayload

async function handleCreateSkill(userId: string, payload: CreateSkillPayload): Promise<Response> {
  const svc = serviceClient()
  const { data, error } = await svc.rpc('admin_create_review_skill', {
    p_actor_id: userId,
    p_name: payload.name,
    p_display_name: payload.display_name,
  })
  if (error) {
    logEvent('create_skill_failed', { userId, reason: reason(error) })
    return json({ error: reason(error) ?? 'failed to create skill' }, 400)
  }
  logEvent('skill_created', { userId, skill_id: data })
  return json({ skill_id: data })
}

/**
 * 签发 staging 上传令牌。
 *
 * key 由服务端拼装并落库（`admin_register_skill_upload` 会再校验一次形状）：
 * `staging/<admin-user-id>/<upload-uuid>.zip`。让浏览器决定 key 等于允许它把上传目标指到
 * `<skill-id>/versions/...`，也就是覆盖一个已发布的正式对象。
 */
async function handleCreateUpload(userId: string, payload: CreateUploadPayload): Promise<Response> {
  const svc = serviceClient()
  const objectKey = `staging/${userId}/${crypto.randomUUID()}.zip`
  const { data: uploadId, error: registerError } = await svc.rpc('admin_register_skill_upload', {
    p_actor_id: userId,
    p_skill_id: payload.skill_id,
    p_staging_object_key: objectKey,
  })
  if (registerError) {
    logEvent('create_upload_failed', { userId, reason: reason(registerError) })
    return json({ error: reason(registerError) ?? 'failed to register upload' }, 400)
  }

  const { data: signed, error: signError } = await svc.storage
    .from(BUCKET)
    .createSignedUploadUrl(objectKey, { upsert: false })
  if (signError || !signed) {
    await svc.rpc('admin_record_skill_upload_failure', {
      p_actor_id: userId,
      p_upload_id: uploadId,
      p_error_code: 'SKILL_UPLOAD_SIGN_FAILED',
      p_error_message: reason(signError) ?? 'failed to sign upload',
    })
    logEvent('sign_upload_failed', { userId, upload_id: uploadId })
    return json({ error: 'failed to create the upload URL' }, 500)
  }

  logEvent('upload_registered', { userId, upload_id: uploadId, skill_id: payload.skill_id })
  return json({
    upload_id: uploadId,
    bucket: BUCKET,
    path: signed.path,
    // 这两个值是短期写令牌。它们只走响应体，不进日志。
    token: signed.token,
    expires_in_seconds: UPLOAD_URL_TTL_SECONDS,
    limits: LIMITS,
  })
}

/**
 * 下载 staging ZIP、校验、落校验结果。
 *
 * 失败也要落库（`admin_record_skill_upload_failure`）：一个只在 HTTP 响应里出现的失败原因
 * 在管理员刷新页面后就消失了，而"为什么这个包发不出去"是他唯一需要的信息。
 */
async function handleValidate(userId: string, payload: ValidatePayload): Promise<Response> {
  const svc = serviceClient()
  const { data: upload, error: uploadError } = await svc.rpc('admin_get_skill_upload', {
    p_actor_id: userId,
    p_upload_id: payload.upload_id,
  })
  if (uploadError || !upload) {
    return json({ error: reason(uploadError) ?? 'upload not found' }, 404)
  }
  const row = upload as {
    skill_name: string
    staging_object_key: string
    status: string
  }
  if (row.status === 'CONSUMED') {
    return json({ error: 'this upload was already published' }, 409)
  }

  const { data: blob, error: downloadError } = await svc.storage
    .from(BUCKET)
    .download(row.staging_object_key)
  if (downloadError || !blob) {
    await svc.rpc('admin_record_skill_upload_failure', {
      p_actor_id: userId,
      p_upload_id: payload.upload_id,
      p_error_code: 'SKILL_UPLOAD_MISSING',
      p_error_message: 'the staging object could not be read; upload it again',
    })
    return json({ error: 'the staging object could not be read; upload it again' }, 400)
  }

  const archive = new Uint8Array(await blob.arrayBuffer())
  let validated
  try {
    validated = await validateSkillArchive(archive, row.skill_name)
  } catch (err) {
    const code = err instanceof BundleError ? err.code : 'SKILL_BUNDLE_INVALID'
    const message = reason(err) ?? 'the archive was rejected'
    await svc.rpc('admin_record_skill_upload_failure', {
      p_actor_id: userId,
      p_upload_id: payload.upload_id,
      p_error_code: code,
      p_error_message: message,
    })
    logEvent('validation_rejected', {
      userId,
      upload_id: payload.upload_id,
      error_code: code,
      archive_bytes: archive.length,
    })
    return json({ error: message, error_code: code }, 400)
  }

  const { data: recorded, error: recordError } = await svc.rpc(
    'admin_record_skill_upload_validation',
    {
      p_actor_id: userId,
      p_upload_id: payload.upload_id,
      p_archive_sha256: validated.archiveSha256,
      p_archive_size_bytes: validated.archiveSizeBytes,
      p_bundle_manifest: validated.manifest,
      p_expanded_size_bytes: validated.expandedSizeBytes,
      p_file_count: validated.fileCount,
      p_contains_scripts: validated.containsScripts,
      // frontmatter 是 description / whenToUse 的唯一来源，发布时由 RPC 从这里取。
      p_entry_frontmatter: validated.frontmatter,
    },
  )
  if (recordError) {
    logEvent('validation_record_failed', { userId, upload_id: payload.upload_id })
    return json({ error: reason(recordError) ?? 'failed to record validation' }, 400)
  }

  logEvent('validated', {
    userId,
    upload_id: payload.upload_id,
    file_count: validated.fileCount,
    archive_bytes: validated.archiveSizeBytes,
    expanded_bytes: validated.expandedSizeBytes,
    contains_scripts: validated.containsScripts,
  })
  return json({
    upload_id: payload.upload_id,
    bundle_hash: (recorded as { bundle_hash?: string } | null)?.bundle_hash ?? validated.bundleHash,
    archive_sha256: validated.archiveSha256,
    archive_size_bytes: validated.archiveSizeBytes,
    expanded_size_bytes: validated.expandedSizeBytes,
    file_count: validated.fileCount,
    contains_scripts: validated.containsScripts,
    // 文件树只含路径、大小、hash、MIME 和角色 —— 没有任何文件正文。
    tree: validated.tree,
    // 解析出来的 frontmatter：发布页展示它，而不是让管理员再敲一遍。
    frontmatter: validated.frontmatter,
    limits: LIMITS,
  })
}

/**
 * 发布。
 *
 * 顺序是刻意的：**先写不可变正式对象，再写数据库行**。
 *
 *   * 反过来的话，一个"数据库说已发布、对象存储里没有字节"的版本会被冻结进新 Job，
 *     Worker 下载时才失败 —— 而那时 Job 已经建了。
 *   * 现在这个顺序的失败模式是"对象写了、行没写"，代价只是一个孤儿 staging/正式对象，
 *     由保留期任务清理；没有任何 Job 会引用它。
 *
 * 正式 key 由**数据库**决定（`admin_publish_review_skill_version` 会用
 * `<skill-id>/versions/<next-version>/<archive-sha>.zip` 严格比对入参），所以这里先向
 * 数据库问一次下一个版本号 —— 不能让这个函数自己猜，两个并发发布会猜出同一个 key。
 */
async function handlePublish(userId: string, payload: PublishPayload): Promise<Response> {
  const svc = serviceClient()
  const { data: upload, error: uploadError } = await svc.rpc('admin_get_skill_upload', {
    p_actor_id: userId,
    p_upload_id: payload.upload_id,
  })
  if (uploadError || !upload) {
    return json({ error: reason(uploadError) ?? 'upload not found' }, 404)
  }
  const row = upload as {
    skill_id: string
    staging_object_key: string
    status: string
    archive_sha256: string | null
    contains_scripts: boolean
  }
  if (row.status !== 'VALIDATED') {
    return json({ error: 'validate this upload before publishing it', error_code: 'SKILL_UPLOAD_NOT_VALIDATED' }, 409)
  }
  if (row.contains_scripts && payload.acknowledge_scripts !== true) {
    return json(
      {
        error: '此版本包含可执行指令资源（scripts/），必须显式确认后才能发布',
        error_code: 'SKILL_SCRIPTS_NOT_ACKNOWLEDGED',
      },
      409,
    )
  }

  const { data: versions, error: versionError } = await svc
    .from('review_skill_version')
    .select('version')
    .eq('skill_id', row.skill_id)
    .order('version', { ascending: false })
    .limit(1)
  if (versionError) {
    return json({ error: reason(versionError) ?? 'failed to resolve the next version' }, 400)
  }
  const nextVersion = ((versions?.[0]?.version as number | undefined) ?? 0) + 1
  const digest = (row.archive_sha256 ?? '').replace('sha256:', '')
  if (!/^[0-9a-f]{64}$/.test(digest)) {
    return json({ error: 'the validated upload carries no archive digest' }, 409)
  }
  const objectKey = `${row.skill_id}/versions/${nextVersion}/${digest}.zip`

  const { data: blob, error: downloadError } = await svc.storage
    .from(BUCKET)
    .download(row.staging_object_key)
  if (downloadError || !blob) {
    return json({ error: 'the staging object could not be read; upload it again' }, 400)
  }

  // upsert: false —— 已发布对象永不覆盖（§5.1）。同一个 key 已存在意味着有人在并发发布
  // 同一个版本号，让它失败比让它互相覆盖安全。
  const { error: uploadObjectError } = await svc.storage.from(BUCKET).upload(objectKey, blob, {
    contentType: 'application/zip',
    upsert: false,
  })
  if (uploadObjectError) {
    logEvent('publish_object_failed', { userId, upload_id: payload.upload_id })
    return json({ error: reason(uploadObjectError) ?? 'failed to write the published object' }, 409)
  }

  const { data: published, error: publishError } = await svc.rpc(
    'admin_publish_review_skill_version',
    {
      p_actor_id: userId,
      p_upload_id: payload.upload_id,
      p_archive_object_key: objectKey,
      p_acknowledge_scripts: payload.acknowledge_scripts ?? false,
    },
  )
  if (publishError) {
    // 数据库拒绝了：正式对象成了孤儿。它没有任何 Job 引用，可以安全删除 —— 留着它反而
    // 会占住那个 key，让下一次同版本号的发布因为 upsert:false 永久失败。
    await svc.storage.from(BUCKET).remove([objectKey])
    logEvent('publish_rejected', { userId, upload_id: payload.upload_id, reason: reason(publishError) })
    return json({ error: reason(publishError) ?? 'failed to publish' }, 400)
  }

  // staging 清理是尽力而为：失败只留一个会被保留期任务收走的对象，不影响发布已成事实。
  const { error: cleanupError } = await svc.storage.from(BUCKET).remove([row.staging_object_key])
  if (cleanupError) {
    logEvent('staging_cleanup_failed', { userId, upload_id: payload.upload_id })
  }

  logEvent('published', {
    userId,
    upload_id: payload.upload_id,
    skill_id: row.skill_id,
    version: nextVersion,
    contains_scripts: row.contains_scripts,
  })
  return json(published)
}

async function handleSetEnabled(userId: string, payload: SetEnabledPayload): Promise<Response> {
  const svc = serviceClient()
  const { error } = await svc.rpc('admin_set_review_skill_enabled', {
    p_actor_id: userId,
    p_skill_id: payload.skill_id,
    p_enabled: payload.enabled,
  })
  if (error) return json({ error: reason(error) ?? 'failed to change the skill state' }, 400)
  logEvent('enabled_changed', { userId, skill_id: payload.skill_id, enabled: payload.enabled })
  return json({ ok: true })
}

/**
 * 删除技能及其全部版本。
 *
 * 顺序是**先库后对象**，不能反过来：数据库那一步会因为 `SKILL_REFERENCED_BY_JOB` 拒绝，
 * 而先删对象就已经把归档毁了 —— 那份归档正是历史 Job 快照要用的东西。所以让数据库先
 * 表态，它成功之后返回的 key 才允许删。
 *
 * 对象删除失败不回滚：库行已经没了，重新插回去只会造出一个指向不存在归档的技能。留下
 * 孤儿对象由容量水位体现，比数据库与存储互相矛盾要好。
 */
async function handleDeleteSkill(userId: string, payload: DeleteSkillPayload): Promise<Response> {
  const svc = serviceClient()
  const { data, error } = await svc.rpc('admin_delete_review_skill', {
    p_actor_id: userId,
    p_skill_id: payload.skill_id,
  })
  if (error) return json({ error: reason(error) ?? 'failed to delete the skill' }, 400)

  const result = (data ?? {}) as {
    skill_name?: string
    version_count?: number
    objects?: { bucket: string; object_key: string }[]
  }
  const keys = (result.objects ?? [])
    .filter((entry) => entry.bucket === BUCKET && typeof entry.object_key === 'string')
    .map((entry) => entry.object_key)

  let orphanedObjects = 0
  if (keys.length > 0) {
    const { error: removeError } = await svc.storage.from(BUCKET).remove(keys)
    if (removeError) {
      orphanedObjects = keys.length
      logEvent('skill_deleted_objects_orphaned', {
        userId,
        skill_id: payload.skill_id,
        object_count: keys.length,
        reason: reason(removeError),
      })
    }
  }

  logEvent('skill_deleted', {
    userId,
    skill_id: payload.skill_id,
    skill_name: result.skill_name,
    version_count: result.version_count,
    removed_objects: keys.length - orphanedObjects,
    orphaned_objects: orphanedObjects,
  })
  return json({ ok: true, skill_name: result.skill_name, orphaned_objects: orphanedObjects })
}

/**
 * ADMIN 下载已发布 Bundle。
 *
 * signed URL 是**短期访问凭据**：它不落库、不进日志，也永远不作为冻结 locator（§5.3）。
 * Worker 走另一条路 —— service-role + 冻结 bucket/key。
 */
async function handleCreateDownloadUrl(
  userId: string,
  payload: CreateDownloadUrlPayload,
): Promise<Response> {
  const svc = serviceClient()
  const { data: locator, error: locatorError } = await svc.rpc('admin_get_skill_version_locator', {
    p_actor_id: userId,
    p_version_id: payload.version_id,
  })
  if (locatorError || !locator) {
    return json({ error: reason(locatorError) ?? 'version not found' }, 404)
  }
  const row = locator as { bucket: string; object_key: string }
  if (row.bucket !== BUCKET) {
    return json({ error: 'unexpected bucket for a published skill bundle' }, 500)
  }
  const { data: signed, error: signError } = await svc.storage
    .from(BUCKET)
    .createSignedUrl(row.object_key, DOWNLOAD_URL_TTL_SECONDS)
  if (signError || !signed) {
    return json({ error: 'failed to create the download URL' }, 500)
  }
  const signedPath = toSkillBundleSignedPath(signed.signedUrl)
  logEvent('download_url_issued', { userId, version_id: payload.version_id })
  return json({ signed_path: signedPath, expires_in_seconds: DOWNLOAD_URL_TTL_SECONDS })
}

/**
 * AI 优化草稿的逐文件 diff。
 *
 * 只回 `{ path, before, after }` 三元组，不回 signed URL、不回 manifest、不回未改动文件。
 * 两侧定位来自 `admin_get_skill_optimization_diff_sources`（它只给 bucket/key），字节由
 * service-role 读、在内存里解出文本后立即丢弃。
 *
 * `before` 为 null 表示这个路径在当前已发布版本里不存在 —— 首版白名单只有 `SKILL.md`，
 * 所以它不该发生；真发生了也要如实显示成"新增文件"，而不是显示成空字符串。
 */
async function handleOptimizationDiff(
  userId: string,
  payload: OptimizationDiffPayload,
): Promise<Response> {
  const svc = serviceClient()
  const { data: sources, error: sourcesError } = await svc.rpc(
    'admin_get_skill_optimization_diff_sources',
    { p_actor_id: userId, p_request_id: payload.request_id },
  )
  if (sourcesError || !sources) {
    return json({ error: reason(sourcesError) ?? 'optimization result not found' }, 404)
  }
  const row = sources as {
    skill_name: string
    changed_paths: string[] | null
    ai_summary: string | null
    before_bucket: string
    before_object_key: string
    after_bucket: string
    after_object_key: string
  }
  if (row.before_bucket !== BUCKET || row.after_bucket !== BUCKET) {
    return json({ error: 'unexpected bucket for a skill bundle' }, 500)
  }
  const changedPaths = (row.changed_paths ?? []).filter((path) => typeof path === 'string')
  if (changedPaths.length === 0) {
    return json({ error: 'this optimization reports no changed files' }, 409)
  }

  const [beforeBlob, afterBlob] = await Promise.all([
    svc.storage.from(BUCKET).download(row.before_object_key),
    svc.storage.from(BUCKET).download(row.after_object_key),
  ])
  if (beforeBlob.error || !beforeBlob.data) {
    return json({ error: 'the published archive could not be read' }, 400)
  }
  if (afterBlob.error || !afterBlob.data) {
    // staging 对象 24h 后被保留期任务清理；那时这份草稿已经等于放弃了。
    return json(
      {
        error: '这份 AI 优化草稿的暂存文件已过期，请重新发起一次优化',
        error_code: 'SKILL_UPLOAD_EXPIRED',
      },
      409,
    )
  }

  let before: Map<string, string>
  let after: Map<string, string>
  try {
    before = await readArchiveTextEntries(
      new Uint8Array(await beforeBlob.data.arrayBuffer()),
      changedPaths,
    )
    after = await readArchiveTextEntries(
      new Uint8Array(await afterBlob.data.arrayBuffer()),
      changedPaths,
    )
  } catch (err) {
    const code = err instanceof BundleError ? err.code : 'SKILL_BUNDLE_INVALID'
    logEvent('optimization_diff_unreadable', {
      userId,
      request_id: payload.request_id,
      error_code: code,
    })
    return json({ error: reason(err) ?? 'the archives could not be read', error_code: code }, 400)
  }

  logEvent('optimization_diff_issued', {
    userId,
    request_id: payload.request_id,
    changed_path_count: changedPaths.length,
  })
  return json({
    request_id: payload.request_id,
    skill_name: row.skill_name,
    ai_summary: row.ai_summary,
    files: changedPaths.map((path) => ({
      path,
      before: before.get(path) ?? null,
      after: after.get(path) ?? null,
    })),
  })
}

Deno.serve(async (req: Request): Promise<Response> => {
  CURRENT_CORS = corsHeaders(req)
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CURRENT_CORS })
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405)

  const admin = await requireAdmin(req)
  if (admin instanceof Response) return admin

  let payload: Payload
  try {
    payload = (await req.json()) as Payload
  } catch {
    return json({ error: 'invalid JSON body' }, 400)
  }

  try {
    switch (payload.action) {
      case 'create-skill':
        return await handleCreateSkill(admin.userId, payload)
      case 'create-upload':
        return await handleCreateUpload(admin.userId, payload)
      case 'validate':
        return await handleValidate(admin.userId, payload)
      case 'publish':
        return await handlePublish(admin.userId, payload)
      case 'set-enabled':
        return await handleSetEnabled(admin.userId, payload)
      case 'delete-skill':
        return await handleDeleteSkill(admin.userId, payload)
      case 'create-download-url':
        return await handleCreateDownloadUrl(admin.userId, payload)
      case 'optimization-diff':
        return await handleOptimizationDiff(admin.userId, payload)
      default:
        return json({ error: 'unknown action' }, 400)
    }
  } catch (err) {
    // 兜底：绝不把栈或归档内容回给调用方。
    logEvent('unhandled_error', { userId: admin.userId, reason: reason(err) })
    return json({ error: 'the request could not be completed' }, 500)
  }
})
