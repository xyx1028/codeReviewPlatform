import type { AiVerdict, BatchStatus, HumanReviewResult } from '../types'

export const batchStatusLabels: Record<BatchStatus, string> = {
  DRAFT: '草稿',
  WAITING_AI_RESULT: '等待 AI 结果',
  REVIEWING: '核对中',
  COMPLETED: '已完成',
}

export const aiVerdictLabels: Record<AiVerdict, string> = {
  IMPLEMENTED: '已实现',
  PARTIAL: '部分实现',
  NOT_IMPLEMENTED: '未实现',
  UNCERTAIN: '无法判断',
}

export const humanReviewLabels: Record<HumanReviewResult, string> = {
  CORRECT: 'AI分析正确',
  PARTIALLY_CORRECT: 'AI分析部分正确',
  INCORRECT: 'AI分析错误',
  NEED_DISCUSSION: '需要进一步确认',
}

export const aiVerdictOptions = Object.entries(aiVerdictLabels).map(([value, label]) => ({ value, label }))
export const humanReviewOptions = Object.entries(humanReviewLabels).map(([value, label]) => ({ value, label }))

// ---------------------------------------------------------------------------
// AI 自动化 MVP：任务状态 / 错误码文案（见方案第 7.3 / 19 节）
// ---------------------------------------------------------------------------

export const analysisJobStatusLabels: Record<string, string> = {
  QUEUED: '排队中',
  PREPARING_CODE: '准备代码',
  PROCESSING: '分析中',
  FINALIZING: '汇总结果',
  SUCCEEDED: '已完成',
  FAILED: '失败',
}

export const storyTaskStatusLabels: Record<string, string> = {
  PENDING: '待处理',
  RUNNING: '处理中',
  SUCCEEDED: '已完成',
  FAILED: '失败',
}

/** 错误码 -> [可读说明, 是否可自动重试] */
export const analysisErrorCodeMeta: Record<string, { message: string; retryable: boolean }> = {
  GIT_AUTH_FAILED: { message: 'GitLab 鉴权失败，请更新 Worker 凭据后重试。', retryable: false },
  GIT_BRANCH_MISSING: { message: '某仓库缺少所选分支，任务失败且不会回退。请确认分支选择。', retryable: false },
  GIT_FETCH_FAILED: { message: 'Git 获取失败，可按原 Commit 重试。', retryable: true },
  GIT_SHA_MISMATCH: { message: '分支快照校验失败，将重新解析一次。', retryable: true },
  MODEL_AUTH_FAILED: { message: '模型 API Key 无效，请在模型管理中轮换密钥后重试。', retryable: false },
  MODEL_CONFIG_DISABLED: { message: '入队前所选模型已停用，请重新选择已启用的模型。', retryable: false },
  MODEL_SECRET_MISSING: { message: 'Vault 中找不到对应 API Key，请重新配置模型密钥。', retryable: false },
  MODEL_RATE_LIMITED: { message: '模型限流，可按原 Commit 重试。', retryable: true },
  MODEL_TIMEOUT: { message: '模型超时，可按原 Commit 重试。', retryable: true },
  RETRIEVAL_SCHEMA_INVALID: { message: '阶段一输出格式错误，可修复后重试。', retryable: true },
  ANALYSIS_SCHEMA_INVALID: { message: '阶段二输出格式错误，可修复后重试。', retryable: true },
  EVIDENCE_PATH_INVALID: { message: '证据路径越界或不存在，任务失败。', retryable: false },
  EVIDENCE_LINE_INVALID: { message: '证据行号无效，任务失败。', retryable: false },
  BATCH_BRANCH_CHANGED: { message: '批次分支与任务不一致，任务失败。', retryable: false },
  RESULT_ALREADY_EXISTS: { message: '批次已有 AI 结果，无法重复分析。', retryable: false },
  TASK_LEASE_LOST: { message: 'Worker 已失去需求任务租约，将由其他 Worker 接管。', retryable: true },
  JOB_INTERNAL_ERROR: { message: '未分类内部错误，请人工判断后重试。', retryable: true },
}
