/**
 * V1.20 本地端到端验证（一次性脚本，不进产品代码路径）。
 *
 * 真实链路：真的调 Linky 取数接口 → 写本地 Supabase 镜像 → 附件字节进 story-attachments
 * → 再按 sha256 物化到一个临时 workspace。跑完打印每一步的真实数字。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { JobsDb } from '../worker/src/db/jobs.js'
import { SupabaseDbClient } from '../worker/src/db/client.js'
import { LinkyClient } from '../worker/src/linky/client.js'
import { SupabaseStoryAttachmentStorage } from '../worker/src/linky/attachment-storage.js'
import { runLinkySync } from '../worker/src/linky/sync-runner.js'
import { materializeRequirementAttachments } from '../worker/src/ai/requirements/attachment-materializer.js'
import { sanitizeAttachmentFileName } from '../worker/src/linky/mapping.js'
import { Logger } from '../worker/src/logger.js'

const SUPABASE_URL = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321'
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''
const LINKY_BASE =
  process.env.LINKY_API_BASE_URL ?? 'https://feature.kingdee.com:2055/quality-platform/api/linky'
const WORKSPACE_NAME = process.env.E2E_WORKSPACE ?? '工具开发组'
const RELEASE_WINDOW = process.env.E2E_RELEASE_WINDOW ?? 'R20261016'
const WORKER_ID = 'v120-e2e-local'

if (SERVICE_KEY === '') {
  console.error('SUPABASE_SERVICE_ROLE_KEY is required')
  process.exit(1)
}

const logger = new Logger({
  sink: (entry) => console.log(JSON.stringify(entry)),
  minLevel: 'info',
})
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

const SKIP_SYNC = process.env.E2E_SKIP_SYNC === '1'

async function main(): Promise<void> {
  if (SKIP_SYNC) {
    console.log('[skip] reusing the mirror from a previous run')
    await verifyMirrorAndMaterialize()
    return
  }
  // 1. 直接下一张 FULL 同步单（service-role；enqueue RPC 需要登录用户，这里不模拟浏览器）。
  const scopeKey = `e2e-${randomUUID()}`
  const inserted = await service
    .from('linky_sync_request')
    .insert({
      depth: 'FULL',
      workspace_name: WORKSPACE_NAME,
      release_window: RELEASE_WINDOW,
      scope_key: scopeKey,
    })
    .select('id')
    .single()
  if (inserted.error) throw inserted.error
  console.log(`[1] queued sync ${inserted.data.id} scope=${WORKSPACE_NAME}/${RELEASE_WINDOW}`)

  // 2. 认领并真实执行。
  const claim = await jobsDb.claimNextLinkySync(WORKER_ID, 600)
  if (claim === null || claim.id !== inserted.data.id) {
    throw new Error(`claim mismatch: ${JSON.stringify(claim)}`)
  }
  console.log(`[2] claimed depth=${claim.depth} workspace=${claim.workspace_name}`)

  const outcome = await runLinkySync({
    claim,
    workerId: WORKER_ID,
    client,
    db: jobsDb,
    storage,
    limits: {
      attachmentMaxBytes: 10 * 1024 * 1024,
      storyAttachmentMaxBytes: 30 * 1024 * 1024,
      maxDetailsPerSync: 50,
      leaseSeconds: 600,
    },
    logger,
  })
  console.log(`[3] sync outcome ${JSON.stringify(outcome)}`)
  const completed = await jobsDb.completeLinkySync({
    syncId: claim.id,
    workerId: WORKER_ID,
    claimToken: claim.claim_token,
    storiesSynced: outcome.storiesSynced,
    detailsSynced: outcome.detailsSynced,
    attachmentsStored: outcome.attachmentsStored,
    attachmentsFailed: outcome.attachmentsFailed,
    bytesDownloaded: outcome.bytesDownloaded,
  })
  console.log(`[4] completed=${completed}`)

  await verifyMirrorAndMaterialize()
}

async function verifyMirrorAndMaterialize(): Promise<void> {
  // 5. 镜像核对：上游 total 与镜像条数。
  const upstream = await client.listStories({ workspaceName: WORKSPACE_NAME, pageSize: 1 })
  const mirrored = await service
    .from('linky_story_catalog')
    .select('issue_id', { count: 'exact', head: true })
    .eq('workspace_name', WORKSPACE_NAME)
  console.log(
    `[5] upstream_total=${upstream.total} mirrored_rows=${mirrored.count} (workspace=${WORKSPACE_NAME})`,
  )

  const withDetail = await service
    .from('linky_story_catalog')
    .select('issue_id', { count: 'exact', head: true })
    .eq('workspace_name', WORKSPACE_NAME)
    .eq('release_window', RELEASE_WINDOW)
    .not('detail_synced_at', 'is', null)
  console.log(`[6] detail_synced in window=${withDetail.count}`)

  const sample = await service
    .from('linky_story_catalog')
    .select('issue_id,story_code,title,iteration,release_window,subject_name,status_label,team,requirement_detail,attachment_count')
    .eq('release_window', RELEASE_WINDOW)
    .not('requirement_detail', 'is', null)
    .order('attachment_count', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (sample.error) throw sample.error
  if (sample.data === null) throw new Error('no mirrored story with requirement text')
  const story = sample.data as Record<string, unknown>
  console.log(
    `[7] sample story ${story.story_code} iteration=${story.iteration} window=${story.release_window} `
      + `status=${story.status_label} subject=${story.subject_name} attachments=${story.attachment_count} `
      + `detail_len=${String(story.requirement_detail ?? '').length} team=${JSON.stringify(story.team)}`,
  )

  // 8. 附件：DB 记录 vs Storage 对象 vs sha256。
  const attachments = await service
    .from('linky_story_catalog_attachment')
    .select('*')
    .eq('fetch_status', 'STORED')
    .limit(3)
  if (attachments.error) throw attachments.error
  console.log(`[8] stored attachments sampled=${attachments.data?.length ?? 0}`)
  for (const row of attachments.data ?? []) {
    const bytes = await storage.download(row.storage_path as string)
    const digest = createHash('sha256').update(bytes).digest('hex')
    console.log(
      `    ${row.filename} bytes=${bytes.length} declared=${row.size_bytes} `
        + `sha_match=${digest === row.content_sha256}`,
    )
  }

  // 9. 物化到临时 workspace，验证 Agent 真的能在 requirements/ 下读到文件。
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
    const frozen = (attachments.data ?? []).map((row) => ({
      filename: row.filename as string,
      contentType: (row.content_type as string | null) ?? null,
      sizeBytes: (row.size_bytes as number | null) ?? null,
      sha256: row.content_sha256 as string,
      storagePath: row.storage_path as string,
    }))
    const result = await materializeRequirementAttachments({
      workspace: fakeWorkspace as never,
      storyCode: 'E2E-STORY',
      attachments: frozen,
      storage,
      logger,
    })
    console.log(
      `[9] materialized=${result.materialized.length} failed=${result.failures.length} `
        + `paths=${result.materialized.map((entry) => entry.relativePath).join(', ')}`,
    )
    for (const entry of written) {
      const size = readFileSync(entry).length
      console.log(`    on disk ${entry.replace(tmpRoot, '<tmp>')} size=${size}`)
    }
    console.log(`[10] sanitize sample: ${sanitizeAttachmentFileName('方案 一二三.docx')}`)
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error('E2E FAILED', error)
  process.exit(1)
})
