import { describe, expect, it } from 'vitest'
import { mergeRuntimeScopeCommitPages, type RuntimeAnalysisScopeCommit, type RuntimeAnalysisScopeCommitPage } from '../../hooks/useRuntimeAnalysisScope'

function commit(id: string, generation = 2, readCount = 0): RuntimeAnalysisScopeCommit {
  return {
    candidate_id: id,
    generation,
    view: 'SELECTED',
    relation_status: 'AUTO_SELECTED',
    effective_status: 'EFFECTIVE',
    repository_name: 'fin',
    short_sha: id.padEnd(8, '0'),
    committed_at: '2026-09-19T00:00:00Z',
    author_display_name: '开发人员',
    author_email_masked: 'd***@example.com',
    subject: `提交 ${id}`,
    files_changed: 1,
    additions: 2,
    deletions: 1,
    reason_codes: ['EXPLICIT_STORY_ID'],
    actually_read: readCount > 0,
    read_count: readCount,
  }
}

function page(generation: number, items: RuntimeAnalysisScopeCommit[]): RuntimeAnalysisScopeCommitPage {
  return { task_id: 'task-1', generation, items, next_cursor: null, total: items.length }
}

describe('分析范围提交分页合并', () => {
  it('按 candidate_id 去重并保留后页较新的投影', () => {
    const merged = mergeRuntimeScopeCommitPages([
      page(2, [commit('a'), commit('b')]),
      page(2, [commit('b', 2, 1), commit('c')]),
    ], 2)
    expect(merged.map((item) => item.candidate_id)).toEqual(['a', 'b', 'c'])
    expect(merged.find((item) => item.candidate_id === 'b')?.read_count).toBe(1)
  })

  it('generation 切换时不混入旧快照页', () => {
    const merged = mergeRuntimeScopeCommitPages([
      page(1, [commit('old', 1)]),
      page(2, [commit('current', 2)]),
    ], 2)
    expect(merged.map((item) => item.candidate_id)).toEqual(['current'])
  })

  it('即使服务端页 generation 正确，也丢弃内部 generation 不一致的行', () => {
    expect(mergeRuntimeScopeCommitPages([page(2, [commit('stale', 1)])], 2)).toEqual([])
  })
})
