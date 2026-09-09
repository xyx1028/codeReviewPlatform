/**
 * analyze-story: run stage two for a single story task. (Plan §12)
 *
 * Uses only the frozen snippets, validates the structured result, then
 * cross-validates evidence against candidates, snapshots and real file lines.
 * Commit SHAs are injected by the worker, never trusted from the model.
 */

import type { ReviewHarness } from '../ai/harness.js'
import {
  validateEvidence,
  validateEvidenceAgainstAllowedRanges,
  type AnalysisResult,
  type RetrievalResult,
  type FileLineProvider,
} from '../ai/schemas.js'
import type { RepositoryName } from '../git/repositories.js'
import { countFileLines } from '../tools/read-code.js'
import type { RepoPathResolver } from '../tools/types.js'
import type { StoryTask } from '../db/jobs.js'
import type { FrozenSnippet } from './retrieve-story.js'

export interface AnalyzeStoryContext {
  branch: string
  repositorySnapshots: Array<{ name: RepositoryName; commitSha: string }>
  repoPaths: Map<RepositoryName, string>
}

function toStory(task: StoryTask) {
  return {
    code: task.story_code,
    name: task.story_name,
    description: task.description,
    acceptanceCriteria: task.acceptance_criteria,
    projectName: task.project_name,
    applicationName: task.application_name,
  }
}

/** An analysis result with Worker-injected commit SHAs on each evidence entry. */
export interface AnalyzedStory {
  result: AnalysisResult
  /** Evidence with commit SHA attached, ready to persist. */
  evidenceWithSha: Array<
    AnalysisResult['evidence'][number] & { commitSha: string }
  >
}

export async function analyzeStory(
  harness: ReviewHarness,
  ctx: AnalyzeStoryContext,
  task: StoryTask,
  retrieval: RetrievalResult,
  snippets: FrozenSnippet[],
): Promise<AnalyzedStory> {
  const result = await harness.analyze({
    story: toStory(task),
    branch: ctx.branch,
    repositorySnapshots: ctx.repositorySnapshots,
    retrieval,
    snippets,
  })

  // Defense in depth for all harness implementations: evidence may only cite
  // ranges that were actually frozen and supplied to stage two.
  validateEvidenceAgainstAllowedRanges(result, snippets)

  // Cross-validate evidence against candidates, snapshots and real file lines.
  const resolvePath: RepoPathResolver = (repo) => {
    const p = ctx.repoPaths.get(repo)
    if (!p) throw new Error(`repository not prepared: ${repo}`)
    return p
  }
  const fileProvider: FileLineProvider = {
    countLines: (repository, filePath) =>
      countFileLines(resolvePath, repository, filePath),
  }
  const snapshotRefs = ctx.repositorySnapshots.map((s) => ({
    repository: s.name,
    commitSha: s.commitSha,
  }))
  validateEvidence(result, retrieval, snapshotRefs, fileProvider)

  // Inject Worker-known SHAs; do not trust any SHA the model may have produced.
  const shaByRepo = new Map<RepositoryName, string>(
    ctx.repositorySnapshots.map((s) => [s.name, s.commitSha]),
  )
  const evidenceWithSha = result.evidence.map((e) => ({
    ...e,
    commitSha: shaByRepo.get(e.repository) ?? '',
  }))

  return { result, evidenceWithSha }
}
