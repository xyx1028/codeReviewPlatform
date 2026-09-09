/**
 * finalize-job: aggregate all story results and write the single AI version via
 * complete_analysis_job. (Plan §7.7, §13.3, §13.4)
 *
 * Finalization is claimed via `claim_job_for_finalization`: any idle replica may
 * win it once every task is fully analyzed. The DB row lock + unique constraint
 * guarantee only one worker finalizes. Because idle workers also try to claim
 * finalization, the last worker standing can always finish a job even if the
 * worker that prepared it crashed.
 *
 * aggregateResults maps the camelCase AI structures saved per story into the
 * snake_case shape the DB RPC expects (story_code, implemented_content,
 * file_path, commit_sha, ...). It does NOT pass a model label — the DB derives
 * that from the frozen job snapshot.
 */

import type {
  JobsDb,
  StoryTaskSummary,
  FinalizationClaim,
} from '../db/jobs.js'
import { rootLogger, type Logger } from '../logger.js'
import { redactError } from '../security/redaction.js'

export interface FinalizeResult {
  finalized: boolean
  reason?: string
}

export class EmptyAnalysisError extends Error {
  code = 'ANALYSIS_OUTPUT_EMPTY'
  constructor(message = 'no analysis output to finalize') {
    super(message)
    this.name = 'EmptyAnalysisError'
  }
}

/**
 * Attempt to finalize a job that was claimed for finalization. Aggregates the
 * saved per-story analysis outputs and calls complete_analysis_job with the
 * worker id. An empty analysis output set fails the job rather than writing an
 * empty version.
 */
export async function finalizeJob(
  jobsDb: JobsDb,
  claim: FinalizationClaim,
  workerId: string,
  logger: Logger = rootLogger,
): Promise<FinalizeResult> {
  const jobId = claim.job.id
  const log = logger.child({ job_id: jobId, worker_id: workerId, stage: 'FINALIZING' })

  try {
    const tasks = await jobsDb.listStoryTasks(jobId)
    const { results, evidence } = aggregateResults(tasks)

    if (results.length === 0) {
      throw new EmptyAnalysisError()
    }

    await jobsDb.completeAnalysisJob({ jobId, workerId, results, evidence })
    log.info('job_finalized', {
      event: 'job_finalized',
      results: results.length,
      evidence: evidence.length,
    })
    return { finalized: true }
  } catch (err) {
    log.error('finalize_failed', {
      event: 'finalize_failed',
      error_message: redactError(err),
    })
    throw err
  }
}

interface CamelEvidence {
  repository?: string
  filePath?: string
  symbolName?: string
  startLine?: number
  endLine?: number
  evidenceType?: string
  description?: string
  commitSha?: string
}

interface CamelAnalysis {
  verdict?: string
  confidence?: number
  summary?: string
  implementedContent?: string | null
  missingContent?: string | null
  risks?: string | null
  testPoints?: string | null
  aiRemark?: string | null
  evidence?: CamelEvidence[]
}

/**
 * Build the snake_case results + evidence arrays the DB RPC expects from the
 * saved per-story camelCase analysis outputs. Tasks without an analysis_output
 * are skipped (they should not exist once finalization is claimed, but we guard
 * defensively).
 */
export function aggregateResults(tasks: StoryTaskSummary[]): {
  results: unknown[]
  evidence: unknown[]
} {
  const results: unknown[] = []
  const evidence: unknown[] = []

  for (const task of tasks) {
    const analysis = task.analysis_output as CamelAnalysis | null
    if (!analysis) continue

    results.push({
      story_code: task.story_code,
      verdict: analysis.verdict ?? null,
      confidence: analysis.confidence ?? null,
      summary: analysis.summary ?? null,
      implemented_content: analysis.implementedContent ?? null,
      missing_content: analysis.missingContent ?? null,
      risks: analysis.risks ?? null,
      test_points: analysis.testPoints ?? null,
      ai_remark: analysis.aiRemark ?? null,
    })

    for (const e of analysis.evidence ?? []) {
      evidence.push({
        story_code: task.story_code,
        repository_name: e.repository ?? null,
        commit_sha: e.commitSha ?? null,
        file_path: e.filePath ?? null,
        symbol_name: e.symbolName ?? null,
        start_line: e.startLine ?? null,
        end_line: e.endLine ?? null,
        evidence_type: e.evidenceType ?? null,
        description: e.description ?? null,
      })
    }
  }

  return { results, evidence }
}
