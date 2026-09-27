/** Aggregate committed Agent reviews and persist one batch AI result version. */

import type { CompletedStoryTask, FinalizationClaim, JobsDb } from '../db/jobs.js'
import { rootLogger, type Logger } from '../logger.js'
import { redactError } from '../security/redaction.js'

export interface FinalizeResult {
  finalized: boolean
  reason?: string
}

export class EmptyAnalysisError extends Error {
  code = 'ANALYSIS_OUTPUT_EMPTY'

  constructor(message = 'no Agent output to finalize') {
    super(message)
    this.name = 'EmptyAnalysisError'
  }
}

export async function finalizeJob(
  jobsDb: JobsDb,
  claim: FinalizationClaim,
  workerId: string,
  logger: Logger = rootLogger,
): Promise<FinalizeResult> {
  const jobId = claim.job.id
  const log = logger.child({ job_id: jobId, worker_id: workerId, stage: 'FINALIZING' })

  try {
    const tasks = await jobsDb.listCompletedStoryTasks(jobId)
    const { results, evidence } = aggregateCompletedResults(tasks)
    if (results.length === 0) throw new EmptyAnalysisError()

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

interface AgentOutput {
  verdict?: string
  confidence?: number
  summary?: string
  implementedContent?: string | null
  missingContent?: string | null
  risks?: string | null
  testPoints?: string | null
  aiRemark?: string | null
  evidenceSummaries?: Record<string, string>
}

/**
 * Verdict fields come from the committed Agent output. Evidence comes only from
 * the platform-verified ledger; model-submitted unverified paths are never used.
 */
export function aggregateCompletedResults(tasks: CompletedStoryTask[]): {
  results: unknown[]
  evidence: unknown[]
} {
  const results: unknown[] = []
  const evidence: unknown[] = []

  for (const task of tasks) {
    const output = task.output as AgentOutput | null
    if (!output) continue

    results.push({
      story_code: task.story_code,
      verdict: output.verdict ?? null,
      confidence: output.confidence ?? null,
      summary: output.summary ?? null,
      implemented_content: output.implementedContent ?? null,
      missing_content: output.missingContent ?? null,
      risks: output.risks ?? null,
      test_points: output.testPoints ?? null,
      ai_remark: output.aiRemark ?? null,
    })

    for (const item of task.verified_evidence ?? []) {
      evidence.push({
        story_code: task.story_code,
        repository_name: item.repository_name,
        commit_sha: item.commit_sha,
        file_path: item.file_path,
        symbol_name: null,
        start_line: item.start_line,
        end_line: item.end_line,
        evidence_type: item.evidence_type,
        evidence_summary: output.evidenceSummaries?.[item.evidence_id] ?? null,
        description: item.description,
      })
    }
  }

  return { results, evidence }
}
