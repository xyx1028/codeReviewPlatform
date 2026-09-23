/**
 * 分析范围提交明细的分页契约（纯逻辑，沿用本目录既有的 node 环境约定）。
 *
 * 这一块内容最长（单需求最多 200 条候选），此前是「无限加载 + 一张长表」，看第 8 页要先把
 * 前 7 页全拉下来。现在一页一次 RPC：`p_cursor` 是十进制字符串形式的 offset，跳页只是换算。
 */
import { describe, expect, it } from 'vitest'
import {
  nextRuntimeScopePagination,
  runtimeScopeCommitCursor,
  RUNTIME_SCOPE_DEFAULT_PAGE_SIZE,
  RUNTIME_SCOPE_PAGE_SIZES,
} from '../../hooks/useRuntimeAnalysisScope'

describe('分析范围提交明细分页', () => {
  it('默认每页 10 条，可选值都在服务端 1~100 的夹取范围内', () => {
    expect(RUNTIME_SCOPE_DEFAULT_PAGE_SIZE).toBe(10)
    expect([...RUNTIME_SCOPE_PAGE_SIZES]).toEqual([10, 20, 50, 100])
    expect(RUNTIME_SCOPE_PAGE_SIZES.every((size) => size >= 1 && size <= 100)).toBe(true)
  })

  it('页码换算成 offset cursor，首页传 null', () => {
    expect(runtimeScopeCommitCursor(1, 10)).toBeNull()
    expect(runtimeScopeCommitCursor(2, 10)).toBe('10')
    expect(runtimeScopeCommitCursor(8, 10)).toBe('70')
    expect(runtimeScopeCommitCursor(3, 50)).toBe('100')
  })

  it('非法页码不会算出负 offset 或小数 offset', () => {
    expect(runtimeScopeCommitCursor(0, 10)).toBeNull()
    expect(runtimeScopeCommitCursor(-5, 10)).toBeNull()
    expect(runtimeScopeCommitCursor(2.7, 10)).toBe('10')
  })

  it('改每页条数时回到第 1 页，只翻页时保持每页条数', () => {
    expect(nextRuntimeScopePagination({ page: 8, pageSize: 10 }, { page: 8, pageSize: 100 }))
      .toEqual({ page: 1, pageSize: 100 })
    expect(nextRuntimeScopePagination({ page: 1, pageSize: 10 }, { page: 4, pageSize: 10 }))
      .toEqual({ page: 4, pageSize: 10 })
  })
})
