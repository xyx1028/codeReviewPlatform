/**
 * Skill Bundle 的 service-role 下载通道。
 *
 * 与 `SupabaseDbClient` 分开，是因为它们的信任模型不同：那个只发 RPC，这个会把
 * **对象字节**拉进 Worker 内存。所以这里有两条硬约束，写在类型上而不是注释里：
 *
 *   1. bucket 固定为 `skill-bundles`。函数签名不接受 bucket 参数，于是"下载了别的
 *      bucket"在结构上不可能发生。
 *   2. key 只能来自 claim-fenced 的 Job snapshot。这个模块不提供任何"列出对象"的
 *      能力 —— 没有枚举，就没有"下载到一个没被冻结的对象"这条路径。
 *
 * Worker **不使用 signed URL**：那是给 ADMIN 下载准备的短期凭据，不是冻结 locator。
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { WorkerConfig } from '../../config.js'

export const SKILL_BUNDLE_BUCKET = 'skill-bundles' as const

export interface SkillStorageClient {
  /** 按冻结 locator 下载归档字节。失败必须抛错，绝不返回空 Buffer。 */
  downloadArchive(objectKey: string): Promise<Buffer>
}

/**
 * V1.19：AI 优化需要**写** staging 对象。
 *
 * 单独一个接口而不是加进 `SkillStorageClient`，是因为评审链路只需要读 —— 让它拿到一个带
 * 上传能力的客户端等于扩大那条链路的权限面。key 形态另有闸门（`assertStagingObjectKey`）：
 * staging 前缀之外的 key 一律拒绝，于是"把归档写到正式对象上"在结构上不可能发生。
 */
export interface SkillStagingWriter {
  uploadStagingArchive(objectKey: string, bytes: Buffer): Promise<void>
}

export class SkillStorageDownloadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SkillStorageDownloadError'
  }
}

/**
 * key 形态闸门。
 *
 * 正式对象 key 由服务端按 `<skill-id>/versions/<version>/<archive-sha256>.zip` 生成。
 * 这里再校验一次形状：一个能让 key 里出现 `..` 或绝对路径的调用方，等于可以把下载
 * 目标指到 bucket 里的任意位置。冻结值本该是可信的 —— 但"本该可信"不是不检查的理由。
 */
export function assertFrozenObjectKey(objectKey: string): string {
  const pattern = /^[0-9a-f-]{36}\/versions\/[1-9][0-9]{0,8}\/[0-9a-f]{64}\.zip$/
  if (!pattern.test(objectKey)) {
    throw new SkillStorageDownloadError('frozen skill archive key has an unexpected shape')
  }
  return objectKey
}

/**
 * staging key 形态闸门（V1.19）。
 *
 * 形状与 `admin_register_skill_upload` 里那条校验**必须**一致：
 * `staging/<actor-uuid>/<upload-uuid>.zip`。数据库那一条是准入闸门，这一条是"Worker 连
 * 试都不会试"—— 两者一起保证一个能影响 objectKey 的 bug 也不会把字节写到
 * `<skill-id>/versions/...` 上，也就是覆盖一个已发布的不可变对象。
 */
export function assertStagingObjectKey(objectKey: string): string {
  const pattern = /^staging\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.zip$/
  if (!pattern.test(objectKey)) {
    throw new SkillStorageDownloadError('staging skill archive key has an unexpected shape')
  }
  return objectKey
}

export class SupabaseSkillStorageClient implements SkillStorageClient, SkillStagingWriter {
  private client: SupabaseClient

  constructor(config: Pick<WorkerConfig, 'supabaseUrl' | 'supabaseServiceRoleKey'>) {
    this.client = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
  }

  async downloadArchive(objectKey: string): Promise<Buffer> {
    assertFrozenObjectKey(objectKey)
    const { data, error } = await this.client.storage
      .from(SKILL_BUNDLE_BUCKET)
      .download(objectKey)
    if (error) {
      // 只带上稳定原因，不回显 key 之外的任何东西，也绝不回显 signed URL。
      throw new SkillStorageDownloadError(`skill archive download failed: ${error.message}`)
    }
    if (data === null) {
      throw new SkillStorageDownloadError('skill archive download returned no body')
    }
    const bytes = Buffer.from(await data.arrayBuffer())
    if (bytes.length === 0) {
      throw new SkillStorageDownloadError('skill archive download returned zero bytes')
    }
    return bytes
  }

  /**
   * 写一份 staging 归档。
   *
   * `upsert: false`：staging key 由 Worker 现生成（含一个新 uuid），撞名只可能意味着
   * 有别的东西在往同一个 key 写 —— 让它失败比互相覆盖安全。
   */
  async uploadStagingArchive(objectKey: string, bytes: Buffer): Promise<void> {
    assertStagingObjectKey(objectKey)
    if (bytes.length === 0) {
      throw new SkillStorageDownloadError('refusing to upload a zero-byte skill archive')
    }
    const { error } = await this.client.storage
      .from(SKILL_BUNDLE_BUCKET)
      .upload(objectKey, bytes, { contentType: 'application/zip', upsert: false })
    if (error) {
      throw new SkillStorageDownloadError(`skill staging upload failed: ${error.message}`)
    }
  }
}
