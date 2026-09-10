/**
 * Process one enriched story task end to end.
 *
 * Stage one searches complete immutable commit snapshots from CODE_CACHE_ROOT.
 * Its candidate files are then physically copied into a claim-specific task
 * workspace. Stage two snippets and final evidence checks resolve exclusively
 * against that workspace; the complete cache is never an analysis root.
 */

import type { ReviewHarness } from '../ai/harness.js'
import type { JobsDb, StoryTask } from '../db/jobs.js'
import type { RepositoryName, BranchName } from '../git/repositories.js'
import { validateRetrievalResult, type RetrievalResult } from '../ai/schemas.js'
import { Heartbeat } from '../coordination/heartbeat.js'
import { TaskLeaseLostError } from '../coordination/lease.js'
import { retrieveStory, freezeSnippets, type RetrieveStoryContext } from './retrieve-story.js'
import { analyzeStory } from './analyze-story.js'
import { RETRIEVAL_PROMPT_VERSION } from '../ai/prompts/retrieval-v1.js'
import { ANALYSIS_PROMPT_VERSION } from '../ai/prompts/analysis-v1.js'
import { listTopLevelEntries } from '../git/prepare.js'
import { rootLogger, type Logger } from '../logger.js'
import { redactError } from '../security/redaction.js'
import {
  cleanupTaskWorkspace,
  prepareTaskWorkspace,
  type PreparedTaskWorkspace,
} from './task-workspace.js'

/** A repository already prepared on disk at its frozen SHA. */
export interface PreparedRepoRef {
  name: RepositoryName
  commitSha: string
  path: string
}

export interface ProcessContext {
  workerId: string
  workspaceRoot: string
  branch: BranchName
  modelName: string
  heartbeatIntervalMs: number
  /** Lease length (seconds) passed to heartbeat renewals. */
  leaseSeconds: number
  /** Complete immutable cache snapshots used only by stage one. */
  repositories: PreparedRepoRef[]
}

export interface ProcessOutcome {
  taskId: string
  storyCode: string
  ok: boolean
  errorCode?: string
  errorMessage?: string
}

export async function processStoryTask(
  harness: ReviewHarness,
  jobsDb: JobsDb,
  ctx: ProcessContext,
  task: StoryTask,
  logger: Logger = rootLogger,
): Promise<ProcessOutcome> {
  const log = logger.child({
    job_id: task.job_id,
    story_code: task.story_code,
    worker_id: ctx.workerId,
  })

  let leaseLost = false
  const heartbeat = new Heartbeat({
    taskId: task.id,
    workerId: ctx.workerId,
    intervalMs: ctx.heartbeatIntervalMs,
    send: (taskId, workerId) =>
      jobsDb.heartbeatStoryTask(taskId, workerId, ctx.leaseSeconds),
    onLeaseLost: () => {
      leaseLost = true
    },
    logger: log,
  })
  heartbeat.start()

  const cacheRetrieveCtx: RetrieveStoryContext = {
    jobId: task.job_id,
    branch: ctx.branch,
    repositories: ctx.repositories.map((repo) => ({
      name: repo.name,
      commitSha: repo.commitSha,
      topLevelEntries: listTopLevelEntries(repo.path),
      path: repo.path,
    })),
  }

  let stage: 'retrieval' | 'analysis' = 'retrieval'
  let taskWorkspace: PreparedTaskWorkspace | null = null

  try {
    if (task.worker_id !== ctx.workerId) {
      throw new TaskLeaseLostError()
    }

    const recovered = tryRecoverRetrieval(task, log)
    let retrieval: RetrievalResult
    if (recovered) {
      retrieval = recovered
      stage = 'analysis'
      log.info('retrieval_recovered', {
        event: 'retrieval_recovered',
        stage: 'retrieval',
        candidates: retrieval.candidates.length,
      })
    } else {
      const retrievalStart = Date.now()
      const rawRetrieval = await retrieveStory(harness, cacheRetrieveCtx, task)
      retrieval = validateRetrievalResult(rawRetrieval, task.story_code)
      log.info('retrieval_done', {
        event: 'retrieval_done',
        stage: 'retrieval',
        candidates: retrieval.candidates.length,
        duration_ms: Date.now() - retrievalStart,
      })
    }

    if (leaseLost) throw new TaskLeaseLostError()

    taskWorkspace = prepareTaskWorkspace({
      workspaceRoot: ctx.workspaceRoot,
      jobId: task.job_id,
      taskId: task.id,
      storyCode: task.story_code,
      workerId: ctx.workerId,
      retrievalAttempt: task.retrieval_attempt,
      analysisAttempt: task.analysis_attempt,
      retrieval,
      repositories: ctx.repositories,
    })

    const workspaceRepoPaths = new Map<RepositoryName, string>(
      taskWorkspace.repositories.map((repo) => [repo.name, repo.path]),
    )
    const workspaceSnapshots = taskWorkspace.repositories.map((repo) => ({
      name: repo.name,
      commitSha: repo.commitSha,
    }))
    const workspaceRetrieveCtx: RetrieveStoryContext = {
      jobId: task.job_id,
      branch: ctx.branch,
      repositories: taskWorkspace.repositories.map((repo) => ({
        name: repo.name,
        commitSha: repo.commitSha,
        topLevelEntries: [],
        path: repo.path,
      })),
    }
    const snippets = await freezeSnippets(
      retrieval,
      workspaceRetrieveCtx,
      workspaceRepoPaths,
    )

    log.info('task_workspace_prepared', {
      event: 'task_workspace_prepared',
      stage,
      files: taskWorkspace.repositories.length === 0
        ? 0
        : new Set(retrieval.candidates.map((candidate) =>
          `${candidate.repository}::${candidate.filePath}`)).size,
      bytes: taskWorkspace.totalBytes,
    })

    if (!recovered) {
      if (leaseLost) throw new TaskLeaseLostError()
      await jobsDb.saveRetrievalResult(
        task.id,
        ctx.workerId,
        retrieval,
        ctx.modelName,
        RETRIEVAL_PROMPT_VERSION,
      )
    }

    stage = 'analysis'
    const analysisStart = Date.now()
    const { result: analysis, evidenceWithSha } = await analyzeStory(
      harness,
      {
        branch: ctx.branch,
        repositorySnapshots: workspaceSnapshots,
        repoPaths: workspaceRepoPaths,
      },
      task,
      retrieval,
      snippets,
    )
    if (leaseLost) throw new TaskLeaseLostError()
    await jobsDb.saveAnalysisResult(
      task.id,
      ctx.workerId,
      { ...analysis, evidence: evidenceWithSha },
      ctx.modelName,
      ANALYSIS_PROMPT_VERSION,
    )
    log.info('analysis_done', {
      event: 'analysis_done',
      stage: 'analysis',
      verdict: analysis.verdict,
      duration_ms: Date.now() - analysisStart,
    })

    return { taskId: task.id, storyCode: task.story_code, ok: true }
  } catch (err) {
    const code = (err as { code?: string })?.code ?? 'JOB_INTERNAL_ERROR'
    const message = redactError(err)
    log.error('story_task_failed', {
      event: 'story_task_failed',
      stage,
      error_code: code,
      error_message: message,
    })
    await jobsDb
      .failStoryTask({ taskId: task.id, workerId: ctx.workerId, stage, code, message })
      .catch((failErr) =>
        log.error('fail_story_task_error', {
          event: 'fail_story_task_error',
          error_message: redactError(failErr),
        }),
      )
    return {
      taskId: task.id,
      storyCode: task.story_code,
      ok: false,
      errorCode: code,
      errorMessage: message,
    }
  } finally {
    heartbeat.stop()
    if (taskWorkspace) {
      try {
        cleanupTaskWorkspace(taskWorkspace)
      } catch (cleanupError) {
        log.warn('task_workspace_cleanup_failed', {
          event: 'task_workspace_cleanup_failed',
          error_message: redactError(cleanupError),
        })
      }
    }
  }
}

/** Recover a strictly validated stage-one result after lease takeover. */
function tryRecoverRetrieval(task: StoryTask, log: Logger): RetrievalResult | null {
  if (task.retrieval_status !== 'SUCCEEDED' || !task.retrieval_output) {
    return null
  }
  try {
    return validateRetrievalResult(task.retrieval_output, task.story_code)
  } catch (err) {
    log.warn('retrieval_recover_invalid', {
      event: 'retrieval_recover_invalid',
      error_message: redactError(err),
    })
    return null
  }
}
