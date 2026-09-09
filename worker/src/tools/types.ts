/**
 * Shared types for the four read-only retrieval tools. (Plan §11.3, §11.4)
 */

import type { RepositoryName } from '../git/repositories.js'

export interface SearchHit {
  repository: RepositoryName
  filePath: string
  lineNumber: number
  lineText: string
}

export interface CodeSnippet {
  repository: RepositoryName
  filePath: string
  startLine: number
  endLine: number
  content: string
  truncated: boolean
  contentHash: string
}

export interface CommitSummary {
  sha: string
  subject: string
  author: string
  date: string
}

/** Maps a whitelisted repository name to its prepared read-only root path. */
export type RepoPathResolver = (repository: RepositoryName) => string

export const TOOL_LIMITS = {
  maxSearchResults: 50,
  maxFindResults: 200,
  maxReadLines: 200,
  maxFileBytes: 1024 * 1024, // 1 MB
  maxGitLogResults: 50,
} as const
