import { keepPreviousData, useQuery } from '@tanstack/react-query'

export type RuntimeScopeStatus = 'PREPARING' | 'READY' | 'DEGRADED' | 'FAILED' | 'LEGACY'
export type RuntimeScopeMode =
  | 'EXACT_STORY_COMMITS'
  | 'HYBRID_CANDIDATES'
  | 'DEVELOPER_WINDOW'
  | 'REQUIREMENT_REF_ONLY'
  | 'NO_CODE_EXPECTED'
  | 'GLOBAL_FALLBACK'
export type RuntimeScopeLevel = 'PRIMARY' | 'RELATED' | 'GLOBAL'
export type RuntimeScopeCommitView = 'SELECTED' | 'CANDIDATE' | 'EXCLUDED'

export interface RuntimeRepositoryScope {
  repository_name: string
  base_sha: string | null
  head_sha: string
  range_source: string
  commit_count: number | null
  enumeration_status: string
  range_start_at: string
  range_end_at: string
  resolved_at: string
}

export interface RuntimeScopeExpansion {
  id: string
  attempt: number
  agent_label: string
  from_level: RuntimeScopeLevel
  to_level: RuntimeScopeLevel
  reason_code: string
  occurred_at: string
}

export interface RuntimeAnalysisScopeSummary {
  task_id: string
  generation: number
  status: RuntimeScopeStatus
  mode: RuntimeScopeMode
  error_code: string | null
  window_days: number | null
  candidate_count: number
  strong_count: number
  ai_candidate_count: number
  ai_related_count: number
  ai_uncertain_count: number
  read_count: number
  reverted_count: number
  current_scope_level: RuntimeScopeLevel
  algorithm_version: string
  manifest_hash: string | null
  degradation_reasons: string[]
  frozen_at: string | null
  repositories: RuntimeRepositoryScope[]
  expansions: RuntimeScopeExpansion[]
}

export interface RuntimeAnalysisScopeCommit {
  candidate_id: string
  generation: number
  view: RuntimeScopeCommitView
  relation_status: 'AUTO_SELECTED' | 'AI_RELATED' | 'AI_UNRELATED' | 'AI_UNCERTAIN' | 'EXCLUDED'
  effective_status: 'EFFECTIVE' | 'REVERTED' | 'PARTIAL' | 'UNKNOWN'
  repository_name: string
  short_sha: string
  committed_at: string
  author_display_name: string
  author_email_masked: string | null
  subject: string
  files_changed: number
  additions: number
  deletions: number
  reason_codes: string[]
  actually_read: boolean
  read_count: number
}

export interface RuntimeAnalysisScopeCommitPage {
  task_id: string
  generation: number
  items: RuntimeAnalysisScopeCommit[]
  next_cursor: string | null
  total: number
}

export interface RuntimeAnalysisScopeApi {
  getSummary(taskId: string): Promise<RuntimeAnalysisScopeSummary | null>
  listCommits(input: {
    taskId: string
    generation: number
    view: RuntimeScopeCommitView
    cursor: string | null
    limit: number
  }): Promise<RuntimeAnalysisScopeCommitPage>
}

export function mergeRuntimeScopeCommitPages(
  pages: RuntimeAnalysisScopeCommitPage[],
  expectedGeneration: number,
): RuntimeAnalysisScopeCommit[] {
  const byId = new Map<string, RuntimeAnalysisScopeCommit>()
  for (const page of pages) {
    if (page.generation !== expectedGeneration) continue
    for (const item of page.items) {
      if (item.generation === expectedGeneration) byId.set(item.candidate_id, item)
    }
  }
  return [...byId.values()]
}

const summaryUnavailable = (): never => {
  throw new Error('分析范围数据库 API 尚未接入')
}

/** 提交明细每页条数的可选值。上界 100 是 `get_analysis_story_scope_commits` 的服务端夹取值。 */
export const RUNTIME_SCOPE_PAGE_SIZES = [10, 20, 50, 100] as const
export const RUNTIME_SCOPE_DEFAULT_PAGE_SIZE = 10

/**
 * 页码 → 服务端 cursor。
 *
 * `get_analysis_story_scope_commits` 的 `p_cursor` 是十进制字符串形式的 offset
 * （服务端 `p_cursor ~ '^[0-9]+$'` 后转 integer），所以跳页只是一次换算，不需要先把
 * 前面几页都拉下来。第 1 页传 null 而不是 `'0'`，让"首页"在 queryKey 和服务端日志里
 * 都是同一种形态。
 */
export function runtimeScopeCommitCursor(page: number, pageSize: number): string | null {
  const offset = Math.max(0, (Math.max(1, Math.trunc(page)) - 1) * pageSize)
  return offset === 0 ? null : String(offset)
}

/**
 * 分页器交互的归一化。
 *
 * 改每页条数时必须回到第 1 页：留在原页码上等于跳到一个与用户预期无关的位置（把每页 10
 * 的第 8 页换成每页 100，第 8 页已经越过总数）。
 */
export function nextRuntimeScopePagination(
  current: { page: number; pageSize: number },
  next: { page: number; pageSize: number },
): { page: number; pageSize: number } {
  if (next.pageSize !== current.pageSize) return { page: 1, pageSize: next.pageSize }
  return { page: Math.max(1, Math.trunc(next.page)), pageSize: current.pageSize }
}

export function useRuntimeAnalysisScope({
  taskId,
  view,
  api,
  page = 1,
  pageSize = RUNTIME_SCOPE_DEFAULT_PAGE_SIZE,
}: {
  taskId: string | null
  view: RuntimeScopeCommitView
  api: RuntimeAnalysisScopeApi | null
  page?: number
  pageSize?: number
}) {
  const summaryQuery = useQuery({
    queryKey: ['runtime-analysis-scope-summary', taskId],
    enabled: taskId !== null && api !== null,
    queryFn: () => taskId === null ? summaryUnavailable() : (api?.getSummary(taskId) ?? Promise.reject(summaryUnavailable())),
    refetchInterval: 12_000,
    refetchIntervalInBackground: false,
    staleTime: 5_000,
  })
  const generation = summaryQuery.data?.generation ?? null
  // 一页一次 RPC，而不是"无限加载 + 前端切片"：`total` 也由服务端给，分页器总数不是前端估的。
  const cursor = runtimeScopeCommitCursor(page, pageSize)
  const commitsQuery = useQuery({
    queryKey: ['runtime-analysis-scope-commits', taskId, generation, view, cursor, pageSize],
    enabled: taskId !== null && generation !== null && api !== null,
    queryFn: () => {
      if (taskId === null || generation === null || api === null) return Promise.reject(summaryUnavailable())
      return api.listCommits({ taskId, generation, view, cursor, limit: pageSize })
    },
    // 翻页时保留上一页内容，避免表格在请求往返期间闪成空态。
    placeholderData: keepPreviousData,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  })
  const currentPage = commitsQuery.data
  const commits = generation === null || currentPage === undefined
    ? []
    : mergeRuntimeScopeCommitPages([currentPage], generation)
  return {
    apiAvailable: api !== null,
    summaryQuery,
    commitsQuery,
    commits,
    totalCommits: currentPage?.total ?? 0,
  }
}
