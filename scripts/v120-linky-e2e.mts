/**
 * V1.20 修订：本地端到端验证（一次性脚本，不进产品代码路径）。
 *
 * 验的是新链路：真的调 Linky 取列表 → 下一张批次导入单 → Worker 执行体逐条取正文与附件
 * 并冻结进 review_story(+_attachment) 与 story-attachments → 校验 sha256 → 再物化到一个
 * 临时 workspace。跑完会**清理自己建的批次与对象**。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { JobsDb } from '../worker/src/db/jobs.js'
import { SupabaseDbClient } from '../worker/src/db/client.js'
import { LinkyClient } from '../worker/src/linky/client.js'
import { SupabaseStoryAttachmentStorage } from '../worker/src/linky/attachment-storage.js'
import { runLinkyBatchImport } from '../worker/src/linky/batch-import-runner.js'
import { materializeRequirementAttachments } from '../worker/src/ai/requirements/attachment-materializer.js'
import { Logger } from '../worker/src/logger.js'

const SUPABASE_URL = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321'
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''
const LINKY_BASE =
  process.env.LINKY_API_BASE_URL ?? 'https://feature.kingdee.com:2055/quality-platform/api/linky'
const WORKSPACE_NAME = process.env.E2E_WORKSPACE ?? '工具开发组'
const WORKER_ID = 'v120-e2e-local'
const KEEP = process.env.E2E_KEEP === '1'

if (SERVICE_KEY === '') {
  console.error('SUPABASE_SERVICE_ROLE_KEY is required')
  process.exit(1)
}

const logger = new Logger({ sink: (entry) => console.log(JSON.stringify(entry)), minLevel: 'info' })
const config = { supabaseUrl: SUPABASE_URL, supabaseServiceRoleKey: SERVICE_KEY }
const service = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
})
const jobsDb = new JobsDb(new SupabaseDbClient(config as never))
const storage = new SupabaseStoryAttachmentStorage(config as never)
const client = new LinkyClient({
  baseUrl: LINKY_BASE,
  proxy: null,
  timeoutMs: 20000,
  configId: null,
})

async function main(): Promise<void> {
  // 1. 真的调 Linky：挑几条**有附件**的故事，模拟用户在页面上的勾选。
  const listed = await client.listAllStories({ workspaceName: WORKSPACE_NAME })
  console.log(`[1] upstream stories in ${WORKSPACE_NAME}: ${listed.total}`)
  const candidates: string[] = []
  for (const raw of listed.items) {
    if (candidates.length >= 2) break
    const code = typeof raw.code === 'string' ? raw.code : null
    if (code === null) continue
    const attachments = await client.listAttachments(code)
    if (attachments.length > 0) candidates.push(code)
  }
  if (candidates.length === 0) throw new Error('no upstream story with attachments found')
  console.log(`[2] selected stories with attachments: ${candidates.join(', ')}`)

  // 2. 建一个临时批次并下一张导入单（页面上这两步是「新建批次」+「确认导入」）。
  const batch = await service
    .from('review_batch')
    .insert({
      name: 'V1.20 E2E 临时批次',
      week_code: `V120-E2E-${Date.now()}`,
      status: 'DRAFT',
      default_branch: 'feature_dev',
    })
    .select('id')
    .single()
  if (batch.error) throw batch.error
  const batchId = batch.data.id as string
  const request = await service
    .from('linky_batch_import_request')
    .insert({
      batch_id: batchId,
      workspace_name: WORKSPACE_NAME,
      story_codes: candidates,
      stories_total: candidates.length,
    })
    .select('id')
    .single()
  if (request.error) throw request.error
  console.log(`[3] queued import ${request.data.id} for batch ${batchId}`)

  try {
    // 3. Worker 认领并执行。
    const claim = await jobsDb.claimNextLinkyBatchImport(WORKER_ID, 900)
    if (claim === null || claim.id !== request.data.id) {
      throw new Error(`claim mismatch: ${JSON.stringify(claim)}`)
    }
    const outcome = await runLinkyBatchImport({
      claim,
      workerId: WORKER_ID,
      client,
      db: jobsDb,
      storage,
      limits: {
        attachmentMaxBytes: 10 * 1024 * 1024,
        storyAttachmentMaxBytes: 30 * 1024 * 1024,
        leaseSeconds: 900,
      },
      logger,
    })
    console.log(`[4] import outcome ${JSON.stringify(outcome)}`)
    console.log(
      `[5] completed=${await jobsDb.completeLinkyBatchImport({
        requestId: claim.id,
        workerId: WORKER_ID,
        claimToken: claim.claim_token,
      })}`,
    )

    // 4. 落库核对。
    const stories = await service
      .from('review_story')
      .select(
        'id,story_code,story_name,owners_text,requirement_handlers,test_handlers,project_name,iteration_name,release_window,source_status,subject_name,source_system,requirement_detail',
      )
      .eq('batch_id', batchId)
      .order('story_code')
    if (stories.error) throw stories.error
    for (const story of stories.data ?? []) {
      const row = story as Record<string, unknown>
      console.log(
        `[6] ${row.story_code} source=${row.source_system} detail_len=${String(row.requirement_detail ?? '').length} `
          + `dev=${row.owners_text} req=${row.requirement_handlers} test=${row.test_handlers ?? '(null)'} `
          + `project=${row.project_name} iteration=${row.iteration_name} window=${row.release_window} `
          + `status=${row.source_status} subject=${String(row.subject_name ?? '').slice(0, 20)}`,
      )
    }
    const batchState = await service
      .from('review_batch')
      .select('status')
      .eq('id', batchId)
      .single()
    console.log(`[7] batch status -> ${batchState.data?.status}`)

    // 5. 附件：DB 记录 vs Storage 对象 vs sha256，再物化到临时 workspace。
    const storyIds = (stories.data ?? []).map((row) => (row as Record<string, unknown>).id as string)
    const attachments = await service
      .from('review_story_attachment')
      .select('*')
      .in('story_id', storyIds)
    if (attachments.error) throw attachments.error
    console.log(`[8] frozen attachments: ${attachments.data?.length ?? 0}`)
    const frozen = (attachments.data ?? []).map((row) => {
      const entry = row as Record<string, unknown>
      return {
        filename: entry.filename as string,
        contentType: (entry.content_type as string | null) ?? null,
        sizeBytes: (entry.size_bytes as number | null) ?? null,
        sha256: entry.content_sha256 as string,
        storagePath: entry.storage_path as string,
      }
    })
    for (const item of frozen) {
      const bytes = await storage.download(item.storagePath)
      const digest = createHash('sha256').update(bytes).digest('hex')
      console.log(
        `    ${item.filename} key=${item.storagePath} bytes=${bytes.length} sha_match=${digest === item.sha256}`,
      )
    }

    const tmpRoot = mkdtempSync(join(tmpdir(), 'v120-e2e-'))
    try {
      const written: string[] = []
      const fakeWorkspace = {
        materializeRequirementAttachment: (storyCode: string, fileName: string, bytes: Buffer) => {
          const dir = join(tmpRoot, 'requirements', storyCode)
          mkdirSync(dir, { recursive: true })
          const target = join(dir, fileName)
          writeFileSync(target, bytes)
          written.push(target)
          return `requirements/${storyCode}/${fileName}`
        },
      }
      const result = await materializeRequirementAttachments({
        workspace: fakeWorkspace as never,
        storyCode: candidates[0],
        attachments: frozen,
        storage,
        logger,
      })
      console.log(
        `[9] materialized=${result.materialized.length} failed=${result.failures.length} `
          + `paths=${result.materialized.map((entry) => entry.relativePath).join(', ')}`,
      )
      for (const entry of written) {
        console.log(`    on disk ${entry.replace(tmpRoot, '<tmp>')} size=${readFileSync(entry).length}`)
      }
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true })
    }

    // 6. 清理：先删库里的引用行（否则对象删除保护会拦），再删对象与批次。
    if (!KEEP) {
      const paths = frozen.map((item) => item.storagePath)
      await service.from('review_batch').delete().eq('id', batchId)
      if (paths.length > 0) await storage.remove(paths)
      console.log(`[10] cleaned up batch ${batchId} and ${paths.length} objects`)
    } else {
      console.log(`[10] E2E_KEEP=1 → 保留批次 ${batchId}`)
    }
  } catch (error) {
    if (!KEEP) await service.from('review_batch').delete().eq('id', batchId)
    throw error
  }
}

main().catch((error) => {
  console.error('E2E FAILED', error)
  process.exit(1)
})
