/**
 * 测试用的 Worker 配置片段。
 *
 * V1.20 给 `WorkerConfig` 加了必填的 `linky` 段。五个测试文件各自手写一份配置字面量，
 * 把默认值集中在这里，是为了下一次加字段时只改一处 —— 而不是让"某个测试忘了加字段"
 * 变成一次类型检查失败的例行公事。
 */
import type { WorkerConfig } from '../../config.js'

/** 未配置 Linky 的默认段：同步循环不启动，与升级前行为一致。 */
export const DISABLED_LINKY_CONFIG: WorkerConfig['linky'] = {
  baseUrl: null,
  webBaseUrl: null,
  networkAccessMode: 'DIRECT',
  httpTimeoutMs: 15000,
  syncLeaseSeconds: 600,
  configId: null,
  attachmentMaxBytes: 10 * 1024 * 1024,
  storyAttachmentMaxBytes: 30 * 1024 * 1024,
  maxDetailsPerSync: 300,
  catalogAttachmentRetentionDays: 30,
}
