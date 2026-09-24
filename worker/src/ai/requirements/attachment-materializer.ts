/**
 * 把**冻结的**需求附件物化进 attempt workspace（V1.20）。
 *
 * 数据来源只有一处：`analysis_story_scope.requirement_context.attachments`，也就是创建
 * 分析作业时冻结下来的那一份清单。Worker 不在这里连 Linky、也不查镜像表 —— 一次分析
 * 期间需求内容必须是不变的，否则"AI 当时看到的需求"就无法复现。
 *
 * sha256 由平台在导入时记下、在这里重算比对。不符就是 fail closed：宁可让这次 attempt
 * 明确失败，也不要让模型读一份内容已经变了的附件，然后据此下"已实现/未实现"的判定。
 */
import { createHash } from 'node:crypto'
import type { Logger } from '../../logger.js'
import type { StoryAttachmentStorage } from '../../linky/attachment-storage.js'
import { sanitizeAttachmentFileName } from '../../linky/mapping.js'
import type { AttemptWorkspace } from '../workspace/attempt-workspace.js'

export interface FrozenRequirementAttachment {
  filename: string
  contentType: string | null
  sizeBytes: number | null
  sha256: string
  storagePath: string
}

export interface MaterializedRequirementAttachment {
  relativePath: string
  filename: string
  sizeBytes: number
}

export interface RequirementAttachmentFailure {
  filename: string
  code: string
}

export interface MaterializeRequirementAttachmentsResult {
  materialized: MaterializedRequirementAttachment[]
  failures: RequirementAttachmentFailure[]
}

export class RequirementAttachmentDigestMismatch extends Error {
  constructor(public readonly filename: string) {
    super(`REQUIREMENT_ATTACHMENT_DIGEST_MISMATCH: ${filename}`)
    this.name = 'RequirementAttachmentDigestMismatch'
  }
}

/** 从冻结的 requirement_context 里解析附件清单。形状不对的条目直接丢掉，不猜。 */
export function parseFrozenRequirementAttachments(
  context: Record<string, unknown> | null | undefined,
): FrozenRequirementAttachment[] {
  const raw = context?.attachments
  if (!Array.isArray(raw)) return []
  const result: FrozenRequirementAttachment[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    const filename = typeof record.filename === 'string' ? record.filename.trim() : ''
    const storagePath = typeof record.storage_path === 'string' ? record.storage_path.trim() : ''
    const sha256 = typeof record.sha256 === 'string' ? record.sha256.trim().toLowerCase() : ''
    if (filename === '' || storagePath === '' || !/^[0-9a-f]{64}$/.test(sha256)) continue
    result.push({
      filename,
      contentType: typeof record.content_type === 'string' ? record.content_type : null,
      sizeBytes:
        typeof record.size_bytes === 'number'
          ? record.size_bytes
          : typeof record.size_bytes === 'string' && record.size_bytes !== ''
            ? Number(record.size_bytes)
            : null,
      sha256,
      storagePath,
    })
  }
  return result
}

export async function materializeRequirementAttachments(input: {
  workspace: Pick<AttemptWorkspace, 'materializeRequirementAttachment'>
  storyCode: string
  attachments: readonly FrozenRequirementAttachment[]
  storage: StoryAttachmentStorage
  logger: Logger
}): Promise<MaterializeRequirementAttachmentsResult> {
  const materialized: MaterializedRequirementAttachment[] = []
  const failures: RequirementAttachmentFailure[] = []
  const usedNames = new Set<string>()

  for (const attachment of input.attachments) {
    try {
      const bytes = await input.storage.download(attachment.storagePath)
      const digest = createHash('sha256').update(bytes).digest('hex')
      if (digest !== attachment.sha256) {
        throw new RequirementAttachmentDigestMismatch(attachment.filename)
      }
      let name = sanitizeAttachmentFileName(attachment.filename)
      if (usedNames.has(name)) {
        // 同一条故事里两个附件清洗后同名：加序号而不是互相覆盖。
        const dot = name.lastIndexOf('.')
        const stem = dot > 0 ? name.slice(0, dot) : name
        const ext = dot > 0 ? name.slice(dot) : ''
        let index = 2
        while (usedNames.has(`${stem}-${index}${ext}`)) index += 1
        name = `${stem}-${index}${ext}`
      }
      usedNames.add(name)
      const relativePath = input.workspace.materializeRequirementAttachment(
        input.storyCode,
        name,
        bytes,
      )
      materialized.push({ relativePath, filename: name, sizeBytes: bytes.length })
    } catch (error) {
      const code =
        error instanceof RequirementAttachmentDigestMismatch
          ? 'REQUIREMENT_ATTACHMENT_DIGEST_MISMATCH'
          : error instanceof Error && error.message.startsWith('LINKY_ATTACHMENT')
            ? error.message
            : 'REQUIREMENT_ATTACHMENT_UNAVAILABLE'
      failures.push({ filename: attachment.filename, code })
      input.logger.warn('requirement_attachment_unavailable', {
        event: 'requirement_attachment_unavailable',
        story_code: input.storyCode,
        error_code: code,
      })
    }
  }

  input.logger.info('requirement_attachments_materialized', {
    event: 'requirement_attachments_materialized',
    story_code: input.storyCode,
    materialized: materialized.length,
    failed: failures.length,
  })
  return { materialized, failures }
}
