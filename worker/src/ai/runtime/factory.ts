import type { JobsDb, StoryTask } from '../../db/jobs.js'
import type { PreparedRepository } from '../../git/prepare.js'
import type { BranchName, RepositoryName } from '../../git/repositories.js'
import type { Logger } from '../../logger.js'
import type { CommitReviewInput, CommitReviewResult } from '../control/attempt-control-broker.js'
import { SnapshotStore } from '../snapshot/snapshot-store.js'
import type { CoveragePolicy } from '../snapshot/search-coverage-ledger.js'
import { DeepSeekHarnessAcpEngine } from './deepseek-harness-acp-engine.js'

/** Environment variable through which one attempt receives its model key. */
export const AGENT_MODEL_API_KEY_ENV = 'REVIEW_MODEL_API_KEY'

export interface BuildDeepSeekHarnessReviewInput {
  jobsDb: JobsDb
  task: StoryTask
  workerId: string
  branch: BranchName
  repositories: PreparedRepository[]
  agentAttemptsRoot: string
  logger: Logger
  isLeaseValid(): boolean
  commitReview(input: CommitReviewInput): Promise<CommitReviewResult>
}

/** Coverage required before an attempt may claim a story is not implemented. */
export function buildCoveragePolicy(repositories: readonly RepositoryName[]): CoveragePolicy {
  return { requiredRepositories: repositories, minQueriesPerRepository: 2 }
}

/** Build the platform's only review runner: one DeepSeek Harness ACP attempt. */
export async function buildDeepSeekHarnessReview(
  input: BuildDeepSeekHarnessReviewInput,
): Promise<DeepSeekHarnessAcpEngine> {
  if (input.repositories.length === 0) {
    throw new Error('DeepSeek Harness review requires prepared repositories')
  }

  const snapshots = new SnapshotStore(
    input.repositories.map((repo) => ({
      name: repo.repository,
      commitSha: repo.commitSha,
      gitDir: repo.path,
    })),
  )
  const model = input.task.model
  const apiKey = await input.jobsDb.getModelSecretForStoryTask({
    taskId: input.task.id,
    workerId: input.workerId,
    claimToken: input.task.claim_token,
  })

  return new DeepSeekHarnessAcpEngine({
    taskId: input.task.id,
    agentAttempt: input.task.agent_attempt,
    branch: input.branch,
    story: {
      code: input.task.story_code,
      name: input.task.story_name,
      description: buildStoryDescription(input.task),
      acceptanceCriteria: input.task.acceptance_criteria,
      projectName: input.task.project_name,
      applicationName: input.task.application_name,
    },
    snapshots,
    route: {
      providerId: 'review-route',
      displayName: model.display_name,
      baseUrl: model.base_url,
      modelName: model.model_name,
      contextWindow: model.context_window ?? 131072,
      maxTokens: model.max_output_tokens ?? 8192,
      apiKeyEnvVar: AGENT_MODEL_API_KEY_ENV,
      requestTimeoutMs: model.request_timeout_ms ?? 180000,
    },
    budgets: {
      maxTotalRequests:
        (model.agent_max_model_requests ?? 120) +
        (model.agent_max_retry_requests ?? 6) +
        (model.agent_max_compaction_requests ?? 4),
      maxLoopRequests: model.agent_max_model_requests ?? 120,
      maxRetryRequests: model.agent_max_retry_requests ?? 6,
      maxCompactionRequests: model.agent_max_compaction_requests ?? 4,
    },
    coveragePolicy: buildCoveragePolicy(
      input.repositories.map((repo) => repo.repository),
    ),
    apiKey,
    attemptsRoot: input.agentAttemptsRoot,
    logger: input.logger,
    isLeaseValid: input.isLeaseValid,
    commitReview: input.commitReview,
  })
}

/** Assemble requirement text from the imported row when legacy columns are absent. */
export function buildStoryDescription(task: StoryTask): string {
  if (task.description && task.description.trim().length > 0) {
    return task.description
  }
  const source = task.source_data ?? {}
  const lines = Object.entries(source)
    .filter(([, value]) => value !== null && value !== undefined && String(value).trim() !== '')
    .map(([key, value]) => `${key}: ${String(value)}`)
  return lines.length > 0 ? lines.join('\n') : task.story_name
}
