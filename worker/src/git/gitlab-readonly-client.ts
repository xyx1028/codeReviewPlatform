import { createHash } from 'node:crypto'
import { parseStructuredStoryIds } from '../analysis/story-commit-attribution.js'
import {
  REPOSITORIES,
  assertRepositoryName,
  normalizeGitLabBaseUrl,
  type RepositoryName,
} from './repositories.js'

export type MergeRequestEnrichmentStatus = 'UNAVAILABLE' | 'COMPLETE' | 'PARTIAL' | 'FAILED'
export type MergeRequestMembershipType = 'COMMIT' | 'MERGE_COMMIT' | 'SQUASH_COMMIT'

export interface MergeRequestCommitWire {
  sha: string
  membership_type: MergeRequestMembershipType
}

export interface RepositoryMergeRequestWire {
  provider_project_id: string
  merge_request_iid: number
  title: string
  description: string | null
  source_branch: string
  target_branch: string
  author_username: string
  author_provider_id: string
  author_display_name: string | null
  provider_created_at: string
  provider_updated_at: string
  merged_at: string | null
  merge_commit_sha: string | null
  squash_commit_sha: string | null
  structured_story_ids: string[]
  metadata_hash: string
  collected_at: string
  commits: MergeRequestCommitWire[]
}

export interface RepositoryMergeRequestEnrichment {
  repository: RepositoryName
  status: MergeRequestEnrichmentStatus
  errorCode: string | null
  mergeRequests: RepositoryMergeRequestWire[]
}

export interface CollectRepositoryMergeRequestsInput {
  repository: RepositoryName
  targetBranch: string
  rangeStartAt: string
  rangeEndAt: string
  storyCodes: readonly string[]
}

export interface GitLabReadonlyClientOptions {
  baseUrl: string
  apiToken: string | null
  timeoutMs?: number
  maxPages?: number
  perPage?: number
  fetchImpl?: typeof fetch
  now?: () => Date
}

export class GitLabReadonlyError extends Error {
  readonly code: string
  readonly httpStatus: number | null

  constructor(code: string, message: string, httpStatus: number | null = null) {
    super(message)
    this.name = 'GitLabReadonlyError'
    this.code = code
    this.httpStatus = httpStatus
  }
}

interface GitLabMergeRequestJson {
  iid?: unknown
  title?: unknown
  description?: unknown
  source_branch?: unknown
  target_branch?: unknown
  author?: unknown
  created_at?: unknown
  updated_at?: unknown
  merged_at?: unknown
  merge_commit_sha?: unknown
  squash_commit_sha?: unknown
}

const SHA_PATTERN = /^[0-9a-f]{40}([0-9a-f]{24})?$/
const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_MAX_PAGES = 20
const DEFAULT_PER_PAGE = 100
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024
const MAX_MERGE_REQUESTS = 2_000

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function requiredString(value: unknown, field: string, maxLength = 10_000): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > maxLength) {
    throw new GitLabReadonlyError('MR_METADATA_INVALID_RESPONSE', `GitLab response has invalid ${field}`)
  }
  return value
}

function optionalString(value: unknown, field: string, maxLength = 100_000): string | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'string' || value.length > maxLength) {
    throw new GitLabReadonlyError('MR_METADATA_INVALID_RESPONSE', `GitLab response has invalid ${field}`)
  }
  return value
}

function timestamp(value: unknown, field: string, nullable = false): string | null {
  if (nullable && (value === null || value === undefined || value === '')) return null
  const raw = requiredString(value, field, 128)
  if (!Number.isFinite(Date.parse(raw))) {
    throw new GitLabReadonlyError('MR_METADATA_INVALID_RESPONSE', `GitLab response has invalid ${field}`)
  }
  return new Date(raw).toISOString()
}

function sha(value: unknown, field: string): string | null {
  if (value === null || value === undefined || value === '') return null
  const normalized = requiredString(value, field, 64).toLowerCase()
  if (!SHA_PATTERN.test(normalized)) {
    throw new GitLabReadonlyError('MR_METADATA_INVALID_RESPONSE', `GitLab response has invalid ${field}`)
  }
  return normalized
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => compareText(left, right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(',')}}`
}

function projectPath(repository: RepositoryName): string {
  const entry = REPOSITORIES.find((candidate) => candidate.name === repository)!
  return entry.path.replace(/^\//, '').replace(/\.git$/, '')
}

function normalizeCommitMemberships(
  commits: readonly string[],
  mergeCommitSha: string | null,
  squashCommitSha: string | null,
): MergeRequestCommitWire[] {
  const values: MergeRequestCommitWire[] = commits.map((commitSha) => ({
    sha: commitSha,
    membership_type: 'COMMIT',
  }))
  if (mergeCommitSha !== null) values.push({ sha: mergeCommitSha, membership_type: 'MERGE_COMMIT' })
  if (squashCommitSha !== null) values.push({ sha: squashCommitSha, membership_type: 'SQUASH_COMMIT' })
  const unique = new Map(values.map((value) => [`${value.membership_type}:${value.sha}`, value]))
  return [...unique.values()].sort(
    (left, right) => compareText(left.sha, right.sha) || compareText(left.membership_type, right.membership_type),
  )
}

export class GitLabReadonlyClient {
  private readonly baseUrl: string
  private readonly apiToken: string | null
  private readonly timeoutMs: number
  private readonly maxPages: number
  private readonly perPage: number
  private readonly fetchImpl: typeof fetch
  private readonly now: () => Date

  constructor(options: GitLabReadonlyClientOptions) {
    this.baseUrl = normalizeGitLabBaseUrl(options.baseUrl)
    this.apiToken = options.apiToken?.trim() || null
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.maxPages = options.maxPages ?? DEFAULT_MAX_PAGES
    this.perPage = options.perPage ?? DEFAULT_PER_PAGE
    this.fetchImpl = options.fetchImpl ?? fetch
    this.now = options.now ?? (() => new Date())
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 100 || this.timeoutMs > 120_000) {
      throw new GitLabReadonlyError('MR_METADATA_CONFIG_INVALID', 'GitLab API timeout is invalid')
    }
    if (!Number.isInteger(this.maxPages) || this.maxPages < 1 || this.maxPages > 100) {
      throw new GitLabReadonlyError('MR_METADATA_CONFIG_INVALID', 'GitLab API page limit is invalid')
    }
    if (!Number.isInteger(this.perPage) || this.perPage < 1 || this.perPage > 100) {
      throw new GitLabReadonlyError('MR_METADATA_CONFIG_INVALID', 'GitLab API page size is invalid')
    }
  }

  async collectRepositoryMergeRequests(
    input: CollectRepositoryMergeRequestsInput,
  ): Promise<RepositoryMergeRequestEnrichment> {
    const repository = assertRepositoryName(input.repository)
    if (this.apiToken === null) {
      return {
        repository,
        status: 'UNAVAILABLE',
        errorCode: 'MR_METADATA_UNAVAILABLE',
        mergeRequests: [],
      }
    }

    const providerProjectId = projectPath(repository)
    let rawMergeRequests: unknown[]
    try {
      rawMergeRequests = await this.paginate(
        `/api/v4/projects/${encodeURIComponent(providerProjectId)}/merge_requests`,
        {
          scope: 'all',
          state: 'all',
          target_branch: input.targetBranch,
          updated_after: new Date(input.rangeStartAt).toISOString(),
          updated_before: new Date(input.rangeEndAt).toISOString(),
          order_by: 'updated_at',
          sort: 'asc',
        },
      )
      if (rawMergeRequests.length > MAX_MERGE_REQUESTS) {
        throw new GitLabReadonlyError('MR_METADATA_PAGE_LIMIT', 'GitLab MR result limit exceeded')
      }
    } catch (error) {
      return {
        repository,
        status: 'FAILED',
        errorCode: this.errorCode(error),
        mergeRequests: [],
      }
    }

    const collectedAt = this.now().toISOString()
    const mergeRequests: RepositoryMergeRequestWire[] = []
    let partial = false
    let partialErrorCode: string | null = null

    for (const raw of rawMergeRequests) {
      try {
        const parsed = this.parseMergeRequest(raw, providerProjectId, input, collectedAt)
        let commitRows: unknown[] = []
        try {
          commitRows = await this.paginate(
            `/api/v4/projects/${encodeURIComponent(providerProjectId)}/merge_requests/${parsed.merge_request_iid}/commits`,
          )
        } catch (error) {
          partial = true
          partialErrorCode ??= this.errorCode(error)
        }
        const commitShas = commitRows.map((commit) => {
          if (commit === null || typeof commit !== 'object') {
            throw new GitLabReadonlyError('MR_METADATA_INVALID_RESPONSE', 'GitLab MR commit is invalid')
          }
          const value = sha(
            (commit as Record<string, unknown>).id ?? (commit as Record<string, unknown>).sha,
            'commit sha',
          )
          if (value === null) {
            throw new GitLabReadonlyError('MR_METADATA_INVALID_RESPONSE', 'GitLab MR commit has no sha')
          }
          return value
        })
        parsed.commits = normalizeCommitMemberships(
          commitShas,
          parsed.merge_commit_sha,
          parsed.squash_commit_sha,
        )
        const { metadata_hash: _metadataHash, collected_at: _collectedAt, ...metadataIdentity } = parsed
        parsed.metadata_hash = `sha256:${createHash('sha256')
          .update(`gitlab-mr-metadata-v1\n${stableJson(metadataIdentity)}\n`, 'utf8')
          .digest('hex')}`
        mergeRequests.push(parsed)
      } catch (error) {
        partial = true
        partialErrorCode ??= this.errorCode(error)
      }
    }

    mergeRequests.sort((left, right) => left.merge_request_iid - right.merge_request_iid)
    return {
      repository,
      status: partial ? 'PARTIAL' : 'COMPLETE',
      errorCode: partial ? partialErrorCode ?? 'MR_METADATA_PARTIAL' : null,
      mergeRequests,
    }
  }

  private parseMergeRequest(
    raw: unknown,
    providerProjectId: string,
    input: CollectRepositoryMergeRequestsInput,
    collectedAt: string,
  ): RepositoryMergeRequestWire {
    if (raw === null || typeof raw !== 'object') {
      throw new GitLabReadonlyError('MR_METADATA_INVALID_RESPONSE', 'GitLab MR response item is invalid')
    }
    const mr = raw as GitLabMergeRequestJson
    const iid = Number(mr.iid)
    if (!Number.isSafeInteger(iid) || iid < 1) {
      throw new GitLabReadonlyError('MR_METADATA_INVALID_RESPONSE', 'GitLab MR iid is invalid')
    }
    const targetBranch = requiredString(mr.target_branch, 'target_branch', 255)
    if (targetBranch !== input.targetBranch) {
      throw new GitLabReadonlyError('MR_METADATA_INVALID_RESPONSE', 'GitLab MR target branch is outside the request')
    }
    if (mr.author === null || typeof mr.author !== 'object') {
      throw new GitLabReadonlyError('MR_METADATA_INVALID_RESPONSE', 'GitLab MR author is invalid')
    }
    const author = mr.author as Record<string, unknown>
    const title = requiredString(mr.title, 'title', 1_000)
    const description = optionalString(mr.description, 'description')
    const structuredStoryIds = [
      ...new Set(
        parseStructuredStoryIds(`${title}\n${description ?? ''}`, input.storyCodes, 'STRUCTURED_MR')
          .map((match) => match.normalizedCode),
      ),
    ].sort(compareText)

    return {
      provider_project_id: providerProjectId,
      merge_request_iid: iid,
      title,
      description,
      source_branch: requiredString(mr.source_branch, 'source_branch', 255),
      target_branch: targetBranch,
      author_username: requiredString(author.username, 'author.username', 255),
      author_provider_id: requiredString(String(author.id ?? ''), 'author.id', 255),
      author_display_name: optionalString(author.name, 'author.name', 255),
      provider_created_at: timestamp(mr.created_at, 'created_at')!,
      provider_updated_at: timestamp(mr.updated_at, 'updated_at')!,
      merged_at: timestamp(mr.merged_at, 'merged_at', true),
      merge_commit_sha: sha(mr.merge_commit_sha, 'merge_commit_sha'),
      squash_commit_sha: sha(mr.squash_commit_sha, 'squash_commit_sha'),
      structured_story_ids: structuredStoryIds,
      metadata_hash: '',
      collected_at: collectedAt,
      commits: [],
    }
  }

  private async paginate(path: string, query: Record<string, string> = {}): Promise<unknown[]> {
    const values: unknown[] = []
    let page = 1
    while (true) {
      const url = new URL(path, this.baseUrl)
      for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
      url.searchParams.set('per_page', String(this.perPage))
      url.searchParams.set('page', String(page))
      const response = await this.request(url)
      const payload = await this.readJsonArray(response)
      values.push(...payload)
      const rawNext = response.headers.get('x-next-page')?.trim() ?? ''
      if (rawNext === '') return values
      const next = Number(rawNext)
      if (!Number.isSafeInteger(next) || next <= page) {
        throw new GitLabReadonlyError('MR_METADATA_INVALID_RESPONSE', 'GitLab pagination header is invalid')
      }
      if (page >= this.maxPages || next > this.maxPages) {
        throw new GitLabReadonlyError('MR_METADATA_PAGE_LIMIT', 'GitLab pagination limit exceeded')
      }
      page = next
    }
  }

  private async request(url: URL): Promise<Response> {
    if (url.origin !== this.baseUrl) {
      throw new GitLabReadonlyError('MR_METADATA_ORIGIN_DENIED', 'GitLab request origin is not allowed')
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await this.fetchImpl(url, {
        method: 'GET',
        headers: { 'PRIVATE-TOKEN': this.apiToken! },
        redirect: 'error',
        signal: controller.signal,
      })
      if (!response.ok) {
        throw new GitLabReadonlyError(
          response.status === 401 || response.status === 403
            ? 'MR_METADATA_PERMISSION_DENIED'
            : 'MR_METADATA_HTTP_ERROR',
          `GitLab API returned HTTP ${response.status}`,
          response.status,
        )
      }
      return response
    } catch (error) {
      if (controller.signal.aborted) {
        throw new GitLabReadonlyError('MR_METADATA_TIMEOUT', 'GitLab API request timed out')
      }
      if (error instanceof GitLabReadonlyError) throw error
      throw new GitLabReadonlyError('MR_METADATA_REQUEST_FAILED', 'GitLab API request failed')
    } finally {
      clearTimeout(timer)
    }
  }

  private async readJsonArray(response: Response): Promise<unknown[]> {
    const declaredLength = Number(response.headers.get('content-length') ?? 0)
    if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
      throw new GitLabReadonlyError('MR_METADATA_RESPONSE_TOO_LARGE', 'GitLab API response is too large')
    }
    const body = await response.text()
    if (new TextEncoder().encode(body).byteLength > MAX_RESPONSE_BYTES) {
      throw new GitLabReadonlyError('MR_METADATA_RESPONSE_TOO_LARGE', 'GitLab API response is too large')
    }
    let value: unknown
    try {
      value = JSON.parse(body)
    } catch {
      throw new GitLabReadonlyError('MR_METADATA_INVALID_RESPONSE', 'GitLab API response is not valid JSON')
    }
    if (!Array.isArray(value)) {
      throw new GitLabReadonlyError('MR_METADATA_INVALID_RESPONSE', 'GitLab API response must be an array')
    }
    return value
  }

  private errorCode(error: unknown): string {
    return error instanceof GitLabReadonlyError ? error.code : 'MR_METADATA_REQUEST_FAILED'
  }
}
