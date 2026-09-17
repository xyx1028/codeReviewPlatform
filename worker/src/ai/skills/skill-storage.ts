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

export class SupabaseSkillStorageClient implements SkillStorageClient {
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
}
