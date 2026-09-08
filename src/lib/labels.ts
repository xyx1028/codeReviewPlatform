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
