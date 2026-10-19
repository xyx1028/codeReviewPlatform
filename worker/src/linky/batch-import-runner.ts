/**
 * 一次「批次需求导入」的执行体（V1.20 修订）。
 *
 * 触发点是用户在批次页点「确认导入」，不是定时同步：看板是实时的，批次是冻结的。
 * 这里做的事就是把冻结这一刻的真实内容取下来 ——
 *
 *   1. 按项目组拉一次列表（**可读的迭代 / 发布窗口 / 状态 / 关联特性只有列表端点给**，
 *      详情里只有 tf_* 的 UUID，这是实测结论）；
 *   2. 对勾选的每个编号取详情（正文在 `field_values.gf_description`，`description` 恒空）；
 *   3. 取附件清单并下载字节，写进 story-attachments，sha256 由平台算；
 *   4. 逐条提交给数据库。
 *
 * 为什么逐条提交：一次导入可能几十条，逐条落库让进度是真的，也让"第 7 条取不到"
 * 不至于把前 6 条一起回滚。单条失败记进 `stories_failed`，人能看见是哪几条、为什么。
 */
import { createHash } from 'node:crypto'
import type { Logger } from '../logger.js'
import type { LinkyClient } from './client.js'
import { LinkyApiError, type LinkyErrorCode } from './client.js'
import type { StoryAttachmentStorage } from './attachment-storage.js'
import {
  type CatalogItemPayload,
  batchAttachmentObjectKey,
  isAllowedAttachment,
  toAttachmentPayloads,
  toCatalogDetailPayload,
  toCatalogItemPayload,
} from './mapping.js'

export interface LinkyBatchImportClaim {
  id: string
  batch_id: string
  workspace_id: string | null
  workspace_name: string
  release_window: string | null
  story_codes: string[]
  claim_token: string
  attempt: number
}

export interface CommittedAttachment {
  linky_attachment_id: string
  filename: string
  content_type: string | null
  size_bytes: number
  storage_path: string
  sha256: string
}

export interface LinkyBatchImportDb {
  heartbeatLinkyBatchImport(input: {
    requestId: string
    workerId: string
    claimToken: string
    leaseSeconds: number
  }): Promise<boolean>
  commitLinkyBatchStory(input: {
    requestId: string
    workerId: string
    claimToken: string
    story: Record<string, unknown>
    attachments: CommittedAttachment[]
  }): Promise<string>
  recordLinkyBatchStoryFailure(input: {
    requestId: string
    workerId: string
    claimToken: string
    storyCode: string
    errorCode: string
    errorMessage: string
    attachmentsFailed: number
  }): Promise<boolean>
}

export interface LinkyBatchImportLimits {
  attachmentMaxBytes: number
  storyAttachmentMaxBytes: number
  leaseSeconds: number
}

export interface LinkyBatchImportOutcome {
  storiesCommitted: number
  storiesFailed: number
  attachmentsStored: number
  attachmentsFailed: number
  attachmentsSkipped: number
  bytesDownloaded: number
}

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function errorInfo(error: unknown): { code: string; message: string } {
  if (error instanceof LinkyApiError) return { code: error.code, message: error.message }
  if (error instanceof Error) {
    return { code: 'LINKY_IMPORT_STORY_FAILED', message: error.message.slice(0, 200) }
  }
  return { code: 'LINKY_IMPORT_STORY_FAILED', message: 'unknown error' }
}

export async function runLinkyBatchImport(input: {
  claim: LinkyBatchImportClaim
  workerId: string
  client: LinkyClient
  db: LinkyBatchImportDb
  storage: StoryAttachmentStorage
  limits: LinkyBatchImportLimits
  logger: Logger
  signal?: AbortSignal
  webBaseUrl?: string | null
}): Promise<LinkyBatchImportOutcome> {
  const { claim, client, db, storage, limits, logger } = input
  const outcome: LinkyBatchImportOutcome = {
    storiesCommitted: 0,
    storiesFailed: 0,
    attachmentsStored: 0,
    attachmentsFailed: 0,
    attachmentsSkipped: 0,
    bytesDownloaded: 0,
  }

  const heartbeat = async () => {
    const ok = await db.heartbeatLinkyBatchImport({
      requestId: claim.id,
      workerId: input.workerId,
      claimToken: claim.claim_token,
      leaseSeconds: limits.leaseSeconds,
    })
    if (!ok) {
      const error = new Error('LINKY_IMPORT_LEASE_LOST')
      error.name = 'LinkyImportLeaseLost'
      throw error
    }
  }

  // 1. 列表：可读的迭代 / 发布窗口 / 状态 / 关联特性只能从这里拿。
  //    拿不到就是整单失败 —— 缺了这些字段的需求落进批次，统计看板与提示词都会变哑。
  const listed = await client.listAllStories(
    { workspaceId: claim.workspace_id, workspaceName: claim.workspace_name },
    { signal: input.signal },
  )
  const byCode = new Map<string, CatalogItemPayload>()
  for (const raw of listed.items) {
    const item = toCatalogItemPayload(raw, { webBaseUrl: input.webBaseUrl ?? null })
    if (item !== null) byCode.set(item.story_code, item)
  }
  logger.info('linky_import_listed', {
    event: 'linky_import_listed',
    request_id: claim.id,
    batch_id: claim.batch_id,
    workspace_name: claim.workspace_name,
    upstream_total: listed.total,
    usable: byCode.size,
    requested: claim.story_codes.length,
  })

  /**
   * 项目组压根没解析到。
   *
   * 上游的契约是「指定的工作区不存在时返回空列表（total=0）」，而且 `workspace_name`
   * 是**精确匹配**。所以一个写错的项目组名不会报错，它会安静地回 0 条 —— 接着每条需求
   * 都「不在该项目组的列表里」，最后整单以 `LINKY_NETWORK_ERROR` 收场。
   *
   * 那个结论是假的：网络是好的，代理是好的，VPN 是好的。使用者照着"网络错误"去查，
   * 查到的全是正常的东西，而真正要改的是那个名字。所以这里提前失败，并把名字还给他。
   */
  if (listed.total === 0 && byCode.size === 0) {
    throw new LinkyApiError(
      'LINKY_WORKSPACE_NOT_FOUND',
      `项目组「${claim.workspace_name}」在 Linky 里没有任何需求：它要么不存在，要么名称不完全一致` +
        '（上游按名称精确匹配，不做模糊）。请在平台的「用户故事」看板上复制项目组名后重新提交。',
    )
  }

  /**
   * 逐条失败的原因分布。
   *
   * 整单失败时要报**真实的**主导原因，而不是一个固定的网络错误码。一条都没成功的时候，
   * 原因几乎总是同一个（项目组不对、凭据失效、代理没放开），把它原样报出来，页面上那句话
   * 才是可操作的。
   */
  const failureCodes = new Map<string, number>()

  for (const storyCode of claim.story_codes) {
    if (input.signal?.aborted) break
    await heartbeat()
    let attachmentsFailedForStory = 0
    // 本条故事已经上传的对象。故事提交失败时要把它们删掉：
    // 提交失败意味着没有任何 review_story_attachment 行指向它们，留着就是孤儿字节。
    const uploadedKeys: string[] = []
    try {
      const listItem = byCode.get(storyCode)
      if (listItem === undefined) {
        // 勾选之后上游删了它，或者它已不在这个工作区。如实失败，不去猜。
        throw new LinkyApiError('LINKY_NOT_FOUND', `${storyCode} 不在该项目组的列表里`, 404)
      }
      const detail = toCatalogDetailPayload(await client.getStory(storyCode, input.signal), {
        webBaseUrl: input.webBaseUrl ?? null,
      })
      const attachments = toAttachmentPayloads(
        await client.listAttachments(storyCode, input.signal),
      )

      const committed: CommittedAttachment[] = []
      let storyBytes = 0
      for (const item of attachments) {
        if (input.signal?.aborted) break
        const declared = item.size_bytes === null ? 0 : Number(item.size_bytes)
        if (!isAllowedAttachment(item.filename)) {
          outcome.attachmentsSkipped += 1
          continue
        }
        if (declared > limits.attachmentMaxBytes) {
          outcome.attachmentsSkipped += 1
          continue
        }
        if (storyBytes + declared > limits.storyAttachmentMaxBytes) {
          outcome.attachmentsSkipped += 1
          continue
        }
        try {
          const download = await client.downloadAttachment(storyCode, item.linky_attachment_id, {
            maxBytes: limits.attachmentMaxBytes,
            signal: input.signal,
          })
          const objectKey = batchAttachmentObjectKey(
            claim.batch_id,
            item.linky_attachment_id,
            item.filename,
          )
          // content_type 以**下载响应头**为准：附件列表里 .docx 会写成 application/zip。
          await storage.upload(objectKey, download.body, download.contentType ?? item.content_type)
          committed.push({
            linky_attachment_id: item.linky_attachment_id,
            filename: item.filename,
            content_type: download.contentType ?? item.content_type,
            size_bytes: download.body.length,
            storage_path: objectKey,
            sha256: sha256Hex(download.body),
          })
          uploadedKeys.push(objectKey)
          storyBytes += download.body.length
          outcome.bytesDownloaded += download.body.length
          outcome.attachmentsStored += 1
        } catch (error) {
          attachmentsFailedForStory += 1
          outcome.attachmentsFailed += 1
          logger.warn('linky_import_attachment_failed', {
            event: 'linky_import_attachment_failed',
            request_id: claim.id,
            story_code: storyCode,
            error_code: errorInfo(error).code,
          })
        }
      }

      await db.commitLinkyBatchStory({
        requestId: claim.id,
        workerId: input.workerId,
        claimToken: claim.claim_token,
        story: {
          story_code: storyCode,
          issue_id: listItem.issue_id,
          title: listItem.title,
          workspace_id: listItem.workspace_id,
          workspace_name: listItem.workspace_name,
          status_label: listItem.status_label,
          assignee_name: listItem.assignee_name,
          iteration: listItem.iteration,
          release_window: listItem.release_window,
          subject_name: listItem.subject_name,
          story_url: detail.story_url ?? listItem.story_url,
          requirement_detail: detail.requirement_detail,
          team: detail.team,
          team_resolve_error: detail.team_resolve_error,
          field_values: detail.field_values,
          list_item: listItem.list_item,
        },
        attachments: committed,
      })
      outcome.storiesCommitted += 1
    } catch (error) {
      if (error instanceof Error && error.name === 'LinkyImportLeaseLost') throw error
      const info = errorInfo(error)
      outcome.storiesFailed += 1
      failureCodes.set(info.code, (failureCodes.get(info.code) ?? 0) + 1)
      if (uploadedKeys.length > 0) {
        // 回滚这条故事的字节。删不掉只记一行日志：孤儿对象不影响正确性，
        // 而在这里抛错会把"一条需求没导进来"升级成"整单失败"。
        outcome.attachmentsStored = Math.max(outcome.attachmentsStored - uploadedKeys.length, 0)
        await storage.remove(uploadedKeys).catch((removeError) => {
          logger.warn('linky_import_attachment_rollback_failed', {
            event: 'linky_import_attachment_rollback_failed',
            request_id: claim.id,
            story_code: storyCode,
            objects: uploadedKeys.length,
            error_message: removeError instanceof Error ? removeError.message : 'unknown',
          })
        })
      }
      await db
        .recordLinkyBatchStoryFailure({
          requestId: claim.id,
          workerId: input.workerId,
          claimToken: claim.claim_token,
          storyCode,
          errorCode: info.code,
          errorMessage: info.message,
          attachmentsFailed: attachmentsFailedForStory,
        })
        .catch(() => false)
      logger.warn('linky_import_story_failed', {
        event: 'linky_import_story_failed',
        request_id: claim.id,
        story_code: storyCode,
        error_code: info.code,
      })
    }
  }

  // 一条都没成功：整单失败。否则页面会显示"导入完成"而批次里一条需求都没有。
  if (outcome.storiesCommitted === 0) {
    // 报主导原因码，不要一律 LINKY_NETWORK_ERROR：那会把"项目组名写错了"、"平台侧 token
    // 失效"、"代理没放开端口"统统说成网络问题，而这三件事的处置完全不同。
    const [dominant] = [...failureCodes.entries()].sort((a, b) => b[1] - a[1])
    const code = (dominant?.[0] ?? 'LINKY_NETWORK_ERROR') as LinkyErrorCode
    const total = claim.story_codes.length
    throw new LinkyApiError(
      code,
      code === 'LINKY_NOT_FOUND'
        ? `勾选的 ${total} 条需求都不在项目组「${claim.workspace_name}」的列表里：` +
          '确认项目组是否选对，以及这些需求是否已被移动或删除。'
        : `勾选的 ${total} 条需求全部导入失败`,
    )
  }
  return outcome
}
