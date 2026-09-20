import { useInfiniteQuery, useQuery } from '@tanstack/react-query'

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

export function useRuntimeAnalysisScope({
  taskId,
  view,
  api,
}: {
  taskId: string | null
  view: RuntimeScopeCommitView
  api: RuntimeAnalysisScopeApi | null
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
  const commitsQuery = useInfiniteQuery({
    queryKey: ['runtime-analysis-scope-commits', taskId, generation, view],
    enabled: taskId !== null && generation !== null && api !== null,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      if (taskId === null || generation === null || api === null) return Promise.reject(summaryUnavailable())
      return api.listCommits({ taskId, generation, view, cursor: pageParam, limit: 20 })
    },
    getNextPageParam: (lastPage) => lastPage.next_cursor ?? undefined,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  })
  const pages = commitsQuery.data?.pages ?? []
  const commits = generation === null ? [] : mergeRuntimeScopeCommitPages(pages, generation)
  return {
    apiAvailable: api !== null,
    summaryQuery,
    commitsQuery,
    commits,
    totalCommits: commitsQuery.data?.pages[0]?.total ?? 0,
  }
}
