/**
 * ReviewHarness interface. (Plan §10)
 *
 * The pipeline depends only on this interface, never on a concrete model SDK.
 * A future DeepSeekHarness implements the same contract. (Plan §24)
 */

import type { RepositoryName } from '../git/repositories.js'
import type {
  AnalysisResult,
  RetrievalResult,
} from './schemas.js'
import type { RetrievalPromptStory } from './prompts/retrieval-v1.js'

export interface RetrievalInput {
  jobId: string
  story: RetrievalPromptStory & {
    sourceData: Record<string, unknown>
  }
  branch: 'feature_dev' | 'feature_sit' | 'release'
  repositories: Array<{
    name: RepositoryName
    commitSha: string
    topLevelEntries: string[]
  }>
}

export interface SearchHitResult {
  repository: RepositoryName
  filePath: string
  lineNumber: number
  lineText: string
}

export interface CodeSnippetResult {
  repository: RepositoryName
  filePath: string
  startLine: number
  endLine: number
  content: string
  truncated: boolean
  contentHash: string
}

export interface CommitSummaryResult {
  sha: string
  subject: string
  author: string
  date: string
}

export interface RetrievalTools {
  searchCode(input: {
    repository: RepositoryName
    query: string
    pathGlob?: string
    maxResults?: number
  }): Promise<SearchHitResult[]>

  findFiles(input: {
    repository: RepositoryName
    pattern: string
    maxResults?: number
  }): Promise<string[]>

  readCode(input: {
    repository: RepositoryName
    path: string
    startLine: number
    endLine: number
  }): Promise<CodeSnippetResult>

  gitLog(input: {
    repository: RepositoryName
    query: string
    maxResults?: number
  }): Promise<CommitSummaryResult[]>
}

export interface AnalysisInput {
  story: RetrievalPromptStory & { sourceData?: Record<string, unknown> }
  branch: string
  repositorySnapshots: Array<{ name: RepositoryName; commitSha: string }>
  retrieval: RetrievalResult
  snippets: Array<{
    repository: RepositoryName
    commitSha: string
    filePath: string
    startLine: number
    endLine: number
    content: string
  }>
}

export interface ReviewHarness {
  retrieve(input: RetrievalInput, tools: RetrievalTools): Promise<RetrievalResult>
  analyze(input: AnalysisInput): Promise<AnalysisResult>
}

export type { AnalysisResult, RetrievalResult }
