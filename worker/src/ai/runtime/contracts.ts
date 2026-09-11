import type { Logger } from '../../logger.js'

/** Inputs shared by the single Harness review runner. */
export interface ReviewRunInput {
  signal: AbortSignal
  logger: Logger
}

/** Request accounting observed by the Harness governor and broker. */
export interface ReviewUsage {
  source: 'harness-governor'
  modelRequests: number
  retryRequests: number
  compactionRequests: number
  inputTokens: number | null
  outputTokens: number | null
}

export interface ReviewRunResult {
  taskId: string
  storyCode: string
  ok: boolean
  errorCode?: string
  errorMessage?: string
  usage?: ReviewUsage
}

/** One DeepSeek Harness ACP attempt. There is no alternate execution engine. */
export interface ReviewRunner {
  runReview(input: ReviewRunInput): Promise<ReviewRunResult>
}
