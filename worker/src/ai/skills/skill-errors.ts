/**
 * V1.6 Skill Bundle 的稳定错误码。
 *
 * **刻意不进 `V4_ERROR_CODES`。** 那个集合被 `v4-capability-contract.json` 冻结，
 * `v4-capability-contract.test.ts` 会断言两者逐项相等，而契约摘要又写进了数据库迁移里
 * 冻结的 manifest。往里加码 = 换一个 contract hash = 所有在途 Job 的
 * `record_analysis_attempt_profile` 立刻抛 `SESSION_FORMAT_UNSUPPORTED`，新旧 Worker
 * 再也不能混跑同一批次。技能注入是**独立于模型工具面**的一层供给链，没有理由为它付
 * 这个代价。
 *
 * 唯一的例外是 `SESSION_SKILL_SET_MISMATCH`：它是恢复门禁的判定结果，与
 * `SESSION_FORMAT_UNSUPPORTED` 同族。它同样定义在这里，由 Session 恢复路径以
 * `SkillGovernanceError` 的形式抛出，Worker 的终态映射按字符串码处理，不需要它出现在
 * 模型工具契约里。
 */

export const SKILL_ERROR_CODES = {
  /** 对象存储下载失败（网络、404、权限、字节数不符）。 */
  SKILL_BUNDLE_DOWNLOAD_FAILED: 'SKILL_BUNDLE_DOWNLOAD_FAILED',
  /** 下载字节的 SHA-256 与冻结 snapshot 不符。 */
  SKILL_ARCHIVE_HASH_MISMATCH: 'SKILL_ARCHIVE_HASH_MISMATCH',
  /** 归档结构非法：缺 SKILL.md、Zip Slip、symlink、重复路径、未知类型…… */
  SKILL_BUNDLE_INVALID: 'SKILL_BUNDLE_INVALID',
  /** 超出单包或全目录的容量、数量、压缩比、时间上限。 */
  SKILL_BUNDLE_LIMIT_EXCEEDED: 'SKILL_BUNDLE_LIMIT_EXCEEDED',
  /** 共享 cache 里的内容与它的 bundle hash 不再一致。 */
  SKILL_CACHE_CORRUPT: 'SKILL_CACHE_CORRUPT',
  /** 恢复时 Job 冻结目录、checkpoint 记录与 Worker 重算结果三方不一致。 */
  SESSION_SKILL_SET_MISMATCH: 'SESSION_SKILL_SET_MISMATCH',
} as const

export type SkillErrorCode = (typeof SKILL_ERROR_CODES)[keyof typeof SKILL_ERROR_CODES]

/**
 * 技能供给链的拒绝。
 *
 * 全部是终态：方案 §12 明确要求"不回退到空技能、不改用当前版本、不静默新建 Session"。
 * 所以这个类没有 `modelCorrectable` —— 模型没有任何办法纠正它，它甚至还没被启动。
 */
export class SkillGovernanceError extends Error {
  readonly code: SkillErrorCode

  constructor(code: SkillErrorCode, message: string) {
    super(message)
    this.name = 'SkillGovernanceError'
    this.code = code
  }
}

/** 所有技能错误都终止 attempt。写成函数是为了让调用点读起来和 V4 那套一致。 */
export function isTerminalSkillError(code: string): code is SkillErrorCode {
  return Object.prototype.hasOwnProperty.call(SKILL_ERROR_CODES, code)
}
