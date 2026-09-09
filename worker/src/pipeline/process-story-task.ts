/**
 * process-story-task: process ONE enriched story task end to end. (Plan §13)
 *
 * A replica receives an enriched task (job/model/snapshots/story) via
 * `claim_next_story_task`. It does NOT rely on having prepared the job itself:
 *
 *  1. Prepare each of the four repositories AT THEIR FROZEN SHA locally
 *     (prepareRepositoryAtSnapshot) — cache hit is reused, otherwise an exact
 *     shallow fetch is verified. It never silently uses the latest branch.
 *  2. Build a per-job Harness (API key resolved for this worker only) using the
 *     model snapshot's request_timeout_ms.
 *  3. If stage one (retrieval) already SUCCEEDED, parse the stored output and
 *     re-freeze snippets from the candidate paths, then jump straight to stage
 *     two. Otherwise run stage one and persist it.
 *  4. Run stage two and persist it.
 *
 * Any failure is written to the DB via failStoryTask (never only logged) with
 * the stage that failed. The lease is renewed on an interval; a lost lease
 * aborts before writing stale results. Memory references to prepared repos and
 * the harness are released by the caller after the task returns.
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

/** A repository already prepared on disk at its frozen SHA. */
export interface PreparedRepoRef {
  name: RepositoryName
  commitSha: string
  path: string
}

export interface ProcessContext {
  workerId: string
  branch: BranchName
  modelName: string
  heartbeatIntervalMs: number
  /** Lease length (seconds) passed to heartbeat renewals. */
  leaseSeconds: number
  /** The four repositories already prepared at the job's frozen SHAs. */
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

  const repoPaths = new Map<RepositoryName, string>(
    ctx.repositories.map((r) => [r.name, r.path]),
  )
  const snapshots = ctx.repositories.map((r) => ({
    name: r.name,
    commitSha: r.commitSha,
  }))
  const retrieveCtx: RetrieveStoryContext = {
    jobId: task.job_id,
    branch: ctx.branch,
    repositories: ctx.repositories.map((r) => ({
      name: r.name,
      commitSha: r.commitSha,
      topLevelEntries: listTopLevelEntries(r.path),
      path: r.path,
    })),
  }

  // `stage` tracks which phase we are in so a failure is recorded accurately.
  let stage: 'retrieval' | 'analysis' = 'retrieval'

  try {
    let retrieval: RetrievalResult
    let snippets

    const recovered = tryRecoverRetrieval(task, log)
    if (recovered) {
      // Stage one already succeeded — re-freeze snippets from candidate paths.
      retrieval = recovered
      snippets = await freezeSnippets(retrieval, retrieveCtx, repoPaths)
      log.info('retrieval_recovered', {
        event: 'retrieval_recovered',
        stage: 'retrieval',
        candidates: retrieval.candidates.length,
      })
    } else {
      const retrievalStart = Date.now()
      const out = await retrieveStory(harness, retrieveCtx, task)
      retrieval = out.result
      snippets = out.snippets
      if (leaseLost) throw new TaskLeaseLostError()
      await jobsDb.saveRetrievalResult(
        task.id,
        ctx.workerId,
        retrieval,
        ctx.modelName,
        RETRIEVAL_PROMPT_VERSION,
      )
      log.info('retrieval_done', {
        event: 'retrieval_done',
        stage: 'retrieval',
        candidates: retrieval.candidates.length,
        duration_ms: Date.now() - retrievalStart,
      })
    }

    // Stage two: analysis.
    stage = 'analysis'
    const analysisStart = Date.now()
    const { result: analysis, evidenceWithSha } = await analyzeStory(
      harness,
      { branch: ctx.branch, repositorySnapshots: snapshots, repoPaths },
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
    // Persist the failure to the DB at the current stage (never only log it).
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
  }
}

/**
 * If the task already has a SUCCEEDED retrieval_output, strictly parse it so we
 * can skip stage one on takeover/recovery. Returns null when there is nothing
 * usable to recover (a fresh retrieval will run instead).
 */
function tryRecoverRetrieval(task: StoryTask, log: Logger): RetrievalResult | null {
  if (task.retrieval_status !== 'SUCCEEDED' || !task.retrieval_output) {
    return null
  }
  try {
    return validateRetrievalResult(task.retrieval_output, task.story_code)
  } catch (err) {
    // Stored retrieval is malformed — re-run stage one rather than trust it.
    log.warn('retrieval_recover_invalid', {
      event: 'retrieval_recover_invalid',
      error_message: redactError(err),
    })
    return null
  }
}
