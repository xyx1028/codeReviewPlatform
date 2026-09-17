/**
 * 容量与解压资源边界（方案 §8）。
 *
 * 这些数字在三个地方生效：上传校验服务（Edge Function）、`enqueue_analysis_job` 的冻结
 * 事务（SQL `skill_bundle_limits()`），以及这里的 Worker cache miss 路径。三处必须是
 * **同一组数字**；各写一份的后果是"上传通过了、Job 建成了，Worker 下载到第 51 个包才
 * 失败"—— 治理成本被推到运行时，而运行时没有人在看。
 *
 * 任何超限一律 fail closed 并返回稳定错误码，不静默截断。
 */

import type { ZipReadLimits } from './zip-archive.js'

export interface SkillBundleLimits extends ZipReadLimits {
  /** `SKILL.md` 自身的字节上限。 */
  entryFileBytes: number
}

export interface SkillCatalogLimits {
  /** 已发布且启用的技能数量上限。 */
  catalogBundles: number
  /** 单个 description 的字符上限。 */
  descriptionChars: number
  /** 首轮目录渲染结果的字节上限。 */
  catalogRenderBytes: number
  /** 全部归档下载总量上限。 */
  catalogArchiveBytes: number
  /** 全部展开后总量上限。 */
  catalogExpandedBytes: number
}

export const SKILL_BUNDLE_LIMITS: SkillBundleLimits = {
  archiveBytes: 10 * 1024 * 1024,
  expandedBytes: 50 * 1024 * 1024,
  entryCount: 200,
  fileBytes: 10 * 1024 * 1024,
  entryFileBytes: 64 * 1024,
  pathDepth: 8,
  pathBytes: 240,
  compressionRatio: 20,
  validateMs: 30000,
}

export const SKILL_CATALOG_LIMITS: SkillCatalogLimits = {
  catalogBundles: 50,
  descriptionChars: 500,
  catalogRenderBytes: 32 * 1024,
  catalogArchiveBytes: 100 * 1024 * 1024,
  catalogExpandedBytes: 256 * 1024 * 1024,
}
