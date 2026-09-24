/**
 * 需求附件的 service-role 对象通道（V1.20）。
 *
 * 与 `SupabaseDbClient` 分开的理由和 Skill Bundle 那条一样：这个会把**对象字节**
 * 拉进 Worker 内存。两条硬约束写在类型上：
 *
 *   1. bucket 固定为 `story-attachments`，签名不接受 bucket 参数；
 *   2. key 必须过 `assertCatalogAttachmentKey` 的形状闸门，且这里不提供任何
 *      "列出对象"的能力 —— 没有枚举，就没有"读到一个没被冻结的对象"这条路径。
 *
 * Worker 不用 signed URL：那是给浏览器下载准备的短期凭据，不是冻结 locator。
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { WorkerConfig } from '../config.js'
import { assertCatalogAttachmentKey } from './mapping.js'

export const STORY_ATTACHMENT_BUCKET = 'story-attachments' as const

export class StoryAttachmentStorageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StoryAttachmentStorageError'
  }
}

export interface StoryAttachmentStorage {
  upload(objectKey: string, bytes: Buffer, contentType: string | null): Promise<void>
  download(objectKey: string): Promise<Buffer>
  remove(objectKeys: string[]): Promise<void>
}

export class SupabaseStoryAttachmentStorage implements StoryAttachmentStorage {
  private client: SupabaseClient

  constructor(config: Pick<WorkerConfig, 'supabaseUrl' | 'supabaseServiceRoleKey'>) {
    this.client = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
  }

  /**
   * `upsert: true`：同一个附件 id 重新下载时覆盖自己那一份是正确行为
   * （上游可能替换了同名附件的内容）。key 里带 attachment id，不会踩到别人。
   */
  async upload(objectKey: string, bytes: Buffer, contentType: string | null): Promise<void> {
    assertCatalogAttachmentKey(objectKey)
    if (bytes.length === 0) {
      throw new StoryAttachmentStorageError('refusing to upload a zero-byte attachment')
    }
    const { error } = await this.client.storage.from(STORY_ATTACHMENT_BUCKET).upload(objectKey, bytes, {
      contentType: contentType ?? 'application/octet-stream',
      upsert: true,
    })
    if (error) {
      throw new StoryAttachmentStorageError(`attachment upload failed: ${error.message}`)
    }
  }

  async download(objectKey: string): Promise<Buffer> {
    assertCatalogAttachmentKey(objectKey)
    const { data, error } = await this.client.storage
      .from(STORY_ATTACHMENT_BUCKET)
      .download(objectKey)
    if (error) {
      throw new StoryAttachmentStorageError(`attachment download failed: ${error.message}`)
    }
    if (data === null) {
      throw new StoryAttachmentStorageError('attachment download returned no body')
    }
    return Buffer.from(await data.arrayBuffer())
  }

  async remove(objectKeys: string[]): Promise<void> {
    if (objectKeys.length === 0) return
    for (const key of objectKeys) assertCatalogAttachmentKey(key)
    const { error } = await this.client.storage.from(STORY_ATTACHMENT_BUCKET).remove(objectKeys)
    if (error) {
      throw new StoryAttachmentStorageError(`attachment cleanup failed: ${error.message}`)
    }
  }
}
