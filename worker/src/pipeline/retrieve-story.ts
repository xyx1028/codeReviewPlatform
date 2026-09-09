/**
 * retrieve-story: run stage one for a single story task. (Plan §11)
 *
 * Builds the read-only RetrievalTools bound to the job's prepared repositories,
 * enforces the tool-call limit, and returns a validated RetrievalResult plus the
 * frozen snippets used as stage-two context.
 */

import type { ReviewHarness, RetrievalTools } from '../ai/harness.js'
import type { RetrievalResult } from '../ai/schemas.js'
import { RETRIEVAL_LIMITS } from '../ai/schemas.js'
import type { RepositoryName } from '../git/repositories.js'
import { searchCode } from '../tools/search-code.js'
import { findFiles } from '../tools/find-files.js'
import { readCode } from '../tools/read-code.js'
import { gitLog } from '../tools/git-log.js'
import type { RepoPathResolver } from '../tools/types.js'
import type { StoryTask } from '../db/jobs.js'

export interface FrozenSnippet {
  repository: RepositoryName
  commitSha: string
  filePath: string
  startLine: number
  endLine: number
  content: string
}

export interface RetrieveStoryContext {
  jobId: string
  branch: 'feature_dev' | 'feature_sit' | 'release'
  repositories: Array<{
    name: RepositoryName
    commitSha: string
    topLevelEntries: string[]
    path: string
  }>
}

/** Build the four read-only tools bound to the prepared repositories. */
export function buildRetrievalTools(
  repoPaths: Map<RepositoryName, string>,
): RetrievalTools {
  const resolve: RepoPathResolver = (repo) => {
    const p = repoPaths.get(repo)
    if (!p) throw new Error(`repository not prepared: ${repo}`)
    return p
  }
  return {
    async searchCode(input) {
      const out = await searchCode(resolve, input)
      return out.hits
    },
    async findFiles(input) {
      const out = await findFiles(resolve, input)
      return out.files
    },
    async readCode(input) {
      return readCode(resolve, input)
    },
    async gitLog(input) {
      const out = await gitLog(resolve, input)
      return out.commits
    },
  }
}

function toStory(task: StoryTask) {
  return {
    code: task.story_code,
    name: task.story_name,
    description: task.description,
    acceptanceCriteria: task.acceptance_criteria,
    projectName: task.project_name,
    applicationName: task.application_name,
    sourceData: task.source_data ?? {},
  }
}

export async function retrieveStory(
  harness: ReviewHarness,
  ctx: RetrieveStoryContext,
  task: StoryTask,
): Promise<{ result: RetrievalResult; snippets: FrozenSnippet[] }> {
  const repoPaths = new Map<RepositoryName, string>(
    ctx.repositories.map((r) => [r.name, r.path]),
  )
  const tools = buildRetrievalTools(repoPaths)

  const result = await harness.retrieve(
    {
      jobId: ctx.jobId,
      story: toStory(task),
      branch: ctx.branch,
      repositories: ctx.repositories.map((r) => ({
        name: r.name,
        commitSha: r.commitSha,
        topLevelEntries: r.topLevelEntries,
      })),
    },
    tools,
  )

  const snippets = await freezeSnippets(result, ctx, repoPaths)
  return { result, snippets }
}

/**
 * Read the actual code for each candidate from the prepared repositories at the
 * frozen SHA, bounded by the plan limits (max 12 snippets, 200 lines each,
 * ~60k chars total).
 */
export async function freezeSnippets(
  result: RetrievalResult,
  ctx: RetrieveStoryContext,
  repoPaths: Map<RepositoryName, string>,
): Promise<FrozenSnippet[]> {
  const resolve: RepoPathResolver = (repo) => {
    const p = repoPaths.get(repo)
    if (!p) throw new Error(`repository not prepared: ${repo}`)
    return p
  }
  const shaByRepo = new Map<RepositoryName, string>(
    ctx.repositories.map((r) => [r.name, r.commitSha]),
  )

  const snippets: FrozenSnippet[] = []
  let totalChars = 0
  for (const c of result.candidates.slice(0, RETRIEVAL_LIMITS.maxCandidates)) {
    try {
      const snippet = await readCode(resolve, {
        repository: c.repository,
        path: c.filePath,
        startLine: c.startLine,
        endLine: c.endLine,
      })
      if (totalChars + snippet.content.length > RETRIEVAL_LIMITS.maxContextChars) {
        break
      }
      totalChars += snippet.content.length
      snippets.push({
        repository: c.repository,
        commitSha: shaByRepo.get(c.repository) ?? '',
        filePath: snippet.filePath,
        startLine: snippet.startLine,
        endLine: snippet.endLine,
        content: snippet.content,
      })
    } catch {
      // Skip unreadable candidates; evidence validation will catch invalid refs.
    }
  }
  return snippets
}
