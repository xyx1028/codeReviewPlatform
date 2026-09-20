import { createHash } from 'node:crypto'
import { parseStructuredStoryIds } from '../analysis/story-commit-attribution.js'
import {
  REPOSITORIES,
  REPOSITORY_NAMES,
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

/** V1.13：从某个人自己提的 MR 里反查出来的一个提交邮箱候选（明文只存在于 Worker 内存）。 */
export interface DiscoveredCommitEmail {
  email: string
  author_names: string[]
  commit_count: number
  last_committed_at: string | null
  repositories: Record<string, number>
  merge_request_refs: string[]
}

export interface DiscoverAuthorCommitEmailsInput {
  gitlabUsername: string
  lookbackDays: number
  maxMergeRequests?: number
}

export interface DiscoverAuthorCommitEmailsResult {
  gitlabUserId: string
  gitlabDisplayName: string | null
  mergeRequestCount: number
  /** 有仓库读失败、MR 或候选被截断时为 true —— 界面必须照实说"结果可能不全"。 */
  partial: boolean
  candidates: DiscoveredCommitEmail[]
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
const MAX_DISCOVERED_EMAILS = 50
const GITLAB_USERNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,48}$/
const EMAIL_SHAPE_PATTERN = /^[^@\s]{1,64}@[^@\s]{1,255}$/

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

  /**
   * 按 GitLab 用户名反查"这个人自己提的 MR 里，提交作者用的是哪些邮箱"。
   *
   * 为什么走 MR 而不是全仓 git log：`git log` 拿到的是**所有人**的提交，还要克隆几百兆；
   * 而 `author_id` 过滤出来的 MR 天然只属于这个人，一次 API 往返就能定位到他的提交。
   *
   * 注意边界：MR 是他提的，不代表 MR 里每条提交都是他写的（cherry-pick、代提）。所以这里
   * 返回的是**候选**，最终由本人点选；数据库侧还有"同一邮箱不能被两个人绑定"的唯一约束，
   * 以及把真实作者名一并展示出来供人肉核对。这个方法不做任何"这一定是你"的断言。
   */
  async discoverAuthorCommitEmails(
    input: DiscoverAuthorCommitEmailsInput,
  ): Promise<DiscoverAuthorCommitEmailsResult> {
    if (this.apiToken === null) {
      throw new GitLabReadonlyError('GITLAB_API_TOKEN_MISSING', 'GitLab API token is not configured')
    }
    const username = input.gitlabUsername.trim()
    if (!GITLAB_USERNAME_PATTERN.test(username)) {
      throw new GitLabReadonlyError('GITLAB_USERNAME_INVALID', 'GitLab username is invalid')
    }
    const lookbackDays = Math.min(Math.max(Math.trunc(input.lookbackDays), 30), 730)
    const maxMergeRequests = Math.min(Math.max(Math.trunc(input.maxMergeRequests ?? 40), 1), 100)

    const users = await this.paginate('/api/v4/users', { username })
    const user = users.find((raw) => {
      if (raw === null || typeof raw !== 'object') return false
      const candidate = (raw as Record<string, unknown>).username
      return typeof candidate === 'string' && candidate.toLowerCase() === username.toLowerCase()
    }) as Record<string, unknown> | undefined
    if (user === undefined) {
      throw new GitLabReadonlyError('GITLAB_USER_NOT_FOUND', 'GitLab user not found')
    }
    const userId = Number(user.id)
    if (!Number.isSafeInteger(userId) || userId <= 0) {
      throw new GitLabReadonlyError('MR_METADATA_INVALID_RESPONSE', 'GitLab user id is invalid')
    }
    const displayName = optionalString(user.name, 'user.name', 255)

    const updatedAfter = new Date(
      this.now().getTime() - lookbackDays * 24 * 60 * 60 * 1000,
    ).toISOString()

    interface AuthoredMergeRequest {
      repository: RepositoryName
      iid: number
      updatedAt: string
    }
    const authored: AuthoredMergeRequest[] = []
    let partial = false

    for (const repository of REPOSITORY_NAMES) {
      try {
        const rows = await this.paginate(
          `/api/v4/projects/${encodeURIComponent(projectPath(repository))}/merge_requests`,
          {
            author_id: String(userId),
            scope: 'all',
            state: 'all',
            updated_after: updatedAfter,
            order_by: 'updated_at',
            sort: 'desc',
          },
        )
        for (const raw of rows) {
          if (raw === null || typeof raw !== 'object') continue
          const row = raw as Record<string, unknown>
          const iid = Number(row.iid)
          if (!Number.isSafeInteger(iid) || iid <= 0) continue
          authored.push({
            repository,
            iid,
            updatedAt: typeof row.updated_at === 'string' ? row.updated_at : '',
          })
        }
      } catch {
        // 单个仓库读不到（没权限、超时）不该让整次查找失败：其余仓库仍然有价值，
        // 只是结果标成 partial，界面上明确写"部分仓库没查到"。
        partial = true
      }
    }

    authored.sort((left, right) => compareText(right.updatedAt, left.updatedAt))
    const selected = authored.slice(0, maxMergeRequests)
    if (authored.length > selected.length) partial = true

    interface Aggregate {
      email: string
      authorNames: Set<string>
      shas: Set<string>
      lastCommittedAt: string | null
      repositories: Map<RepositoryName, Set<string>>
      mergeRequestRefs: Set<string>
    }
    const byEmail = new Map<string, Aggregate>()

    for (const mergeRequest of selected) {
      let commits: unknown[]
      try {
        commits = await this.paginate(
          `/api/v4/projects/${encodeURIComponent(projectPath(mergeRequest.repository))}`
          + `/merge_requests/${mergeRequest.iid}/commits`,
        )
      } catch {
        partial = true
        continue
      }
      for (const raw of commits) {
        if (raw === null || typeof raw !== 'object') continue
        const commit = raw as Record<string, unknown>
        const email = typeof commit.author_email === 'string'
          ? commit.author_email.trim().toLowerCase()
          : ''
        if (email === '' || email.length > 320 || !EMAIL_SHAPE_PATTERN.test(email)) continue
        const commitSha = sha(commit.id ?? commit.sha, 'commit sha') ?? ''
        if (commitSha === '') continue
        const committedAt = typeof commit.committed_date === 'string' ? commit.committed_date : null

        let aggregate = byEmail.get(email)
        if (aggregate === undefined) {
          aggregate = {
            email,
            authorNames: new Set<string>(),
            shas: new Set<string>(),
            lastCommittedAt: null,
            repositories: new Map<RepositoryName, Set<string>>(),
            mergeRequestRefs: new Set<string>(),
          }
          byEmail.set(email, aggregate)
        }
        const authorName = typeof commit.author_name === 'string' ? commit.author_name.trim() : ''
        if (authorName !== '' && aggregate.authorNames.size < 10) {
          aggregate.authorNames.add(authorName.slice(0, 64))
        }
        aggregate.shas.add(commitSha)
        if (committedAt !== null
          && (aggregate.lastCommittedAt === null || committedAt > aggregate.lastCommittedAt)) {
          aggregate.lastCommittedAt = committedAt
        }
        const perRepo = aggregate.repositories.get(mergeRequest.repository) ?? new Set<string>()
        perRepo.add(commitSha)
        aggregate.repositories.set(mergeRequest.repository, perRepo)
        if (aggregate.mergeRequestRefs.size < 5) {
          aggregate.mergeRequestRefs.add(`${mergeRequest.repository}!${mergeRequest.iid}`)
        }
      }
    }

    const candidates: DiscoveredCommitEmail[] = [...byEmail.values()]
      .map((aggregate) => ({
        email: aggregate.email,
        author_names: [...aggregate.authorNames].sort(compareText),
        commit_count: aggregate.shas.size,
        last_committed_at: aggregate.lastCommittedAt,
        repositories: Object.fromEntries(
          [...aggregate.repositories.entries()]
            .map(([repository, shas]) => [repository, shas.size] as const)
            .sort((left, right) => compareText(left[0], right[0])),
        ),
        merge_request_refs: [...aggregate.mergeRequestRefs].sort(compareText),
      }))
      .sort((left, right) => right.commit_count - left.commit_count || compareText(left.email, right.email))
    // 数据库侧一次最多接收 50 条候选；超出的都是尾部低频邮箱，截断并标 partial。
    if (candidates.length > MAX_DISCOVERED_EMAILS) partial = true

    return {
      gitlabUserId: String(userId),
      gitlabDisplayName: displayName,
      mergeRequestCount: selected.length,
      partial,
      candidates: candidates.slice(0, MAX_DISCOVERED_EMAILS),
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
