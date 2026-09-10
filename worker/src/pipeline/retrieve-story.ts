/**
 * retrieve-story: run stage one for a single story task. (Plan §11)
 *
 * Builds the read-only RetrievalTools bound to the complete cached repository
 * snapshots and enforces the tool-call limit. Candidate code is frozen only
 * after it has been copied into the isolated task workspace.
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

/** Build the four read-only tools bound to the prepared cache snapshots. */
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

/** Run retrieval against complete immutable cache snapshots. */
export async function retrieveStory(
  harness: ReviewHarness,
  ctx: RetrieveStoryContext,
  task: StoryTask,
): Promise<RetrievalResult> {
  const repoPaths = new Map<RepositoryName, string>(
    ctx.repositories.map((r) => [r.name, r.path]),
  )
  const tools = buildRetrievalTools(repoPaths)

  return harness.retrieve(
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
}

/**
 * Read snippets only from the supplied repository roots. Stage two passes task
 * workspace roots here, never the complete cache snapshots.
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
  }
  return snippets
}
