/**
 * 一次 Linky 同步的执行体（V1.20）。
 *
 * 深度两档，区别是成本：
 *   LIST —— 只抓列表并 upsert 镜像。一个工作区一两次往返，用来刷新组/窗口分面。
 *   FULL —— 在 LIST 之上，对**限定范围内**的故事逐条取详情与附件清单，并把附件字节
 *           下载进 story-attachments。范围由 release_window 收窄；不收窄就是把整个
 *           工作区几百条详情拉一遍，那不是刷新，那是压测（enqueue 侧已经拒绝无范围的 FULL）。
 *
 * 容错原则：**单条故事失败不拖垮整次同步**。列表拿不到才算整体失败 —— 那说明网络或
 * 上游不可用，继续往下做只会把半截数据写进镜像。附件失败逐条记录状态与原因，
 * 导入 RPC 会按 fetch_status 决定放不放行，而不是让 AI 拿着"以为有附件"的上下文去评审。
 */
import { createHash } from 'node:crypto'
import type { Logger } from '../logger.js'
import type { LinkyClient } from './client.js'
import { LinkyApiError } from './client.js'
import type { StoryAttachmentStorage } from './attachment-storage.js'
import {
  type CatalogAttachmentPayload,
  type CatalogItemPayload,
  catalogAttachmentObjectKey,
  isAllowedAttachment,
  toAttachmentPayloads,
  toCatalogDetailPayload,
  toCatalogItemPayload,
} from './mapping.js'

export interface LinkySyncClaim {
  id: string
  depth: 'LIST' | 'FULL'
  workspace_id: string | null
  workspace_name: string | null
  release_window: string | null
  claim_token: string
  attempt: number
}

export interface LinkySyncPendingAttachment {
  id: string
  linky_attachment_id: string
  filename: string
  content_type: string | null
  size_bytes: number | null
}

export interface LinkySyncDb {
  heartbeatLinkySync(input: {
    syncId: string
    workerId: string
    claimToken: string
    leaseSeconds: number
  }): Promise<boolean>
  upsertLinkyStoryCatalog(input: {
    syncId: string
    workerId: string
    claimToken: string
    items: CatalogItemPayload[]
  }): Promise<number>
  upsertLinkyStoryDetail(input: {
    syncId: string
    workerId: string
    claimToken: string
    issueId: string
    detail: Record<string, unknown>
    attachments: CatalogAttachmentPayload[]
  }): Promise<LinkySyncPendingAttachment[]>
  recordLinkyCatalogAttachment(input: {
    syncId: string
    workerId: string
    claimToken: string
    attachmentId: string
    status: 'STORED' | 'SKIPPED' | 'FAILED'
    storagePath?: string | null
    sha256?: string | null
    sizeBytes?: number | null
    error?: string | null
  }): Promise<boolean>
}

export interface LinkySyncLimits {
  /** 单附件上限，超限直接 SKIPPED。 */
  attachmentMaxBytes: number
  /** 单故事附件总量上限，超限后续附件 SKIPPED。 */
  storyAttachmentMaxBytes: number
  /** 一次 FULL 同步最多处理多少条详情，安全阀。 */
  maxDetailsPerSync: number
  leaseSeconds: number
}

export interface LinkySyncOutcome {
  storiesSynced: number
  detailsSynced: number
  attachmentsStored: number
  attachmentsFailed: number
  attachmentsSkipped: number
  bytesDownloaded: number
  storyFailures: Array<{ storyCode: string; code: string; message: string }>
}

const CATALOG_CHUNK = 200

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function errorInfo(error: unknown): { code: string; message: string } {
  if (error instanceof LinkyApiError) return { code: error.code, message: error.message }
  if (error instanceof Error) {
    return { code: 'LINKY_SYNC_STORY_FAILED', message: error.message.slice(0, 200) }
  }
  return { code: 'LINKY_SYNC_STORY_FAILED', message: 'unknown error' }
}

export async function runLinkySync(input: {
  claim: LinkySyncClaim
  workerId: string
  client: LinkyClient
  db: LinkySyncDb
  storage: StoryAttachmentStorage
  limits: LinkySyncLimits
  logger: Logger
  signal?: AbortSignal
  webBaseUrl?: string | null
}): Promise<LinkySyncOutcome> {
  const { claim, client, db, storage, limits, logger } = input
  const outcome: LinkySyncOutcome = {
    storiesSynced: 0,
    detailsSynced: 0,
    attachmentsStored: 0,
    attachmentsFailed: 0,
    attachmentsSkipped: 0,
    bytesDownloaded: 0,
    storyFailures: [],
  }

  const heartbeat = async () => {
    const ok = await db.heartbeatLinkySync({
      syncId: claim.id,
      workerId: input.workerId,
      claimToken: claim.claim_token,
      leaseSeconds: limits.leaseSeconds,
    })
    if (!ok) {
      const error = new Error('LINKY_SYNC_LEASE_LOST')
      error.name = 'LinkySyncLeaseLost'
      throw error
    }
  }

  // 1. 列表。拿不到就是整体失败 —— 不把半截数据写进镜像。
  const listed = await client.listAllStories(
    { workspaceId: claim.workspace_id, workspaceName: claim.workspace_name },
    { signal: input.signal },
  )
  const mapped = listed.items
    .map((item) => toCatalogItemPayload(item, { webBaseUrl: input.webBaseUrl ?? null }))
    .filter((item): item is CatalogItemPayload => item !== null)

  logger.info('linky_sync_listed', {
    event: 'linky_sync_listed',
    sync_id: claim.id,
    depth: claim.depth,
    returned: listed.items.length,
    usable: mapped.length,
    upstream_total: listed.total,
    scopes: listed.scopes,
    pages: listed.pages,
  })

  for (let offset = 0; offset < mapped.length; offset += CATALOG_CHUNK) {
    await heartbeat()
    outcome.storiesSynced += await db.upsertLinkyStoryCatalog({
      syncId: claim.id,
      workerId: input.workerId,
      claimToken: claim.claim_token,
      items: mapped.slice(offset, offset + CATALOG_CHUNK),
    })
  }

  if (claim.depth === 'LIST') return outcome

  // 2. FULL：按发布窗口收窄范围后逐条取详情与附件。
  const window = claim.release_window
  const targets = (window === null
    ? mapped
    : mapped.filter((item) => item.release_window === window)
  ).slice(0, limits.maxDetailsPerSync)

  logger.info('linky_sync_detail_scope', {
    event: 'linky_sync_detail_scope',
    sync_id: claim.id,
    release_window: window,
    targets: targets.length,
  })

  for (const target of targets) {
    if (input.signal?.aborted) break
    await heartbeat()
    try {
      const detail = await client.getStory(target.story_code, input.signal)
      const detailPayload = toCatalogDetailPayload(detail, { webBaseUrl: input.webBaseUrl ?? null })
      const attachments = toAttachmentPayloads(
        await client.listAttachments(target.story_code, input.signal),
      )
      const pending = await db.upsertLinkyStoryDetail({
        syncId: claim.id,
        workerId: input.workerId,
        claimToken: claim.claim_token,
        issueId: target.issue_id,
        detail: {
          requirement_detail: detailPayload.requirement_detail,
          team: detailPayload.team,
          team_resolve_error: detailPayload.team_resolve_error,
          field_values: detailPayload.field_values,
          story_url: detailPayload.story_url ?? target.story_url,
        },
        attachments,
      })
      outcome.detailsSynced += 1

      let storyBytes = 0
      for (const item of pending) {
        if (input.signal?.aborted) break
        const declared = item.size_bytes ?? 0
        if (!isAllowedAttachment(item.filename)) {
          await db.recordLinkyCatalogAttachment({
            syncId: claim.id,
            workerId: input.workerId,
            claimToken: claim.claim_token,
            attachmentId: item.id,
            status: 'SKIPPED',
            error: '附件类型不在允许列表内',
          })
          outcome.attachmentsSkipped += 1
          continue
        }
        if (declared > limits.attachmentMaxBytes) {
          await db.recordLinkyCatalogAttachment({
            syncId: claim.id,
            workerId: input.workerId,
            claimToken: claim.claim_token,
            attachmentId: item.id,
            status: 'SKIPPED',
            error: `附件 ${declared} 字节超过单文件上限 ${limits.attachmentMaxBytes}`,
          })
          outcome.attachmentsSkipped += 1
          continue
        }
        if (storyBytes + declared > limits.storyAttachmentMaxBytes) {
          await db.recordLinkyCatalogAttachment({
            syncId: claim.id,
            workerId: input.workerId,
            claimToken: claim.claim_token,
            attachmentId: item.id,
            status: 'SKIPPED',
            error: `已达单故事附件总量上限 ${limits.storyAttachmentMaxBytes} 字节`,
          })
          outcome.attachmentsSkipped += 1
          continue
        }

        try {
          const download = await client.downloadAttachment(target.story_code, item.linky_attachment_id, {
            maxBytes: limits.attachmentMaxBytes,
            signal: input.signal,
          })
          const objectKey = catalogAttachmentObjectKey(
            target.workspace_id,
            item.linky_attachment_id,
            item.filename,
          )
          // content_type 以**下载响应头**为准：附件列表里 .docx 会写成 application/zip。
          await storage.upload(objectKey, download.body, download.contentType ?? item.content_type)
          await db.recordLinkyCatalogAttachment({
            syncId: claim.id,
            workerId: input.workerId,
            claimToken: claim.claim_token,
            attachmentId: item.id,
            status: 'STORED',
            storagePath: objectKey,
            sha256: sha256Hex(download.body),
            sizeBytes: download.body.length,
          })
          storyBytes += download.body.length
          outcome.bytesDownloaded += download.body.length
          outcome.attachmentsStored += 1
        } catch (error) {
          const info = errorInfo(error)
          await db.recordLinkyCatalogAttachment({
            syncId: claim.id,
            workerId: input.workerId,
            claimToken: claim.claim_token,
            attachmentId: item.id,
            status: 'FAILED',
            error: `${info.code}: ${info.message}`,
          })
          outcome.attachmentsFailed += 1
          logger.warn('linky_attachment_failed', {
            event: 'linky_attachment_failed',
            sync_id: claim.id,
            story_code: target.story_code,
            error_code: info.code,
          })
        }
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'LinkySyncLeaseLost') throw error
      const info = errorInfo(error)
      outcome.storyFailures.push({ storyCode: target.story_code, ...info })
      logger.warn('linky_story_failed', {
        event: 'linky_story_failed',
        sync_id: claim.id,
        story_code: target.story_code,
        error_code: info.code,
      })
    }
  }

  // 全部目标故事都失败，说明不是个别脏数据而是链路问题：让整次同步失败，
  // 否则页面会显示"同步成功"而镜像里一条正文都没有。
  if (targets.length > 0 && outcome.detailsSynced === 0) {
    const first = outcome.storyFailures[0]
    const error = new LinkyApiError(
      (first?.code as never) ?? 'LINKY_NETWORK_ERROR',
      first?.message ?? '全部故事详情同步失败',
    )
    throw error
  }

  return outcome
}
