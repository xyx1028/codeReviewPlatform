/**
 * 评审列表「项目组」列（V1.62）。
 *
 * 三条断言都对着实测数据写（本地库 2026-10-20）：
 *   · Linky 导入的批次：`review_story.linky_workspace_name` 有值（工具开发组、平台开发组）
 *   · 那个 26 条需求的历史批次：`linky_workspace_name` 全为 null，也没有导入单
 *   · 空批次：只有导入单的 `workspace_name`（RPC 会退到它）
 */

import { describe, expect, it } from 'vitest'

import {
  NO_WORKSPACE_FILTER,
  NO_WORKSPACE_LABEL,
  buildWorkspaceFilters,
  matchesWorkspaceFilter,
  normalizeWorkspaceNames,
} from '../workspace-column'

describe('normalizeWorkspaceNames', () => {
  it('去空白、去空值、去重，并按中文排序', () => {
    // zh-CN 是**拼音**序，不是笔画也不是码点序：gong(工) < qian(前)。
    // 看起来"反了"的时候请先确认这一点，不要把实现改成码点序。
    expect(normalizeWorkspaceNames([' 工具开发组 ', '工具开发组', '', '  ', '前端开发组'])).toEqual([
      '工具开发组',
      '前端开发组',
    ])
  })

  it('null / undefined / 非数组都当成"没有项目组"', () => {
    expect(normalizeWorkspaceNames(null)).toEqual([])
    expect(normalizeWorkspaceNames(undefined)).toEqual([])
    // RPC 在历史批次上返回空数组，不是 null —— 两种都要能处理。
    expect(normalizeWorkspaceNames([])).toEqual([])
  })
})

describe('buildWorkspaceFilters', () => {
  it('汇总全部项目组并按中文排序', () => {
    const filters = buildWorkspaceFilters([
      { workspace_names: ['工具开发组'] },
      { workspace_names: ['前端开发组', '工具开发组'] },
      { workspace_names: ['灵基Foundation'] },
    ])
    // 拼音序：gong(工) < ling(灵) < qian(前)
    expect(filters.map((item) => item.value)).toEqual([
      '工具开发组',
      '灵基Foundation',
      '前端开发组',
    ])
  })

  it('存在没有项目组的批次时，补一个显式的「未关联项目组」', () => {
    const filters = buildWorkspaceFilters([
      { workspace_names: ['工具开发组'] },
      { workspace_names: [] },
    ])
    expect(filters.at(-1)).toEqual({ text: NO_WORKSPACE_LABEL, value: NO_WORKSPACE_FILTER })
  })

  it('没有空项目组的批次时不加那个选项（否则是个永远筛不出东西的下拉项）', () => {
    const filters = buildWorkspaceFilters([{ workspace_names: ['工具开发组'] }])
    expect(filters.map((item) => item.value)).toEqual(['工具开发组'])
  })

  it('空列表不产生任何筛选项', () => {
    expect(buildWorkspaceFilters([])).toEqual([])
  })
})

describe('matchesWorkspaceFilter', () => {
  it('跨多个项目组的批次按"包含"命中，不是相等', () => {
    const row = { workspace_names: ['前端开发组', '工具开发组'] }
    // 写成相等的话，这个批次在任何单组筛选下都会消失 —— 这是这条测试要守住的点。
    expect(matchesWorkspaceFilter(row, '工具开发组')).toBe(true)
    expect(matchesWorkspaceFilter(row, '前端开发组')).toBe(true)
    expect(matchesWorkspaceFilter(row, '灵基Foundation')).toBe(false)
  })

  it('「未关联项目组」只命中确实没有项目组的批次', () => {
    expect(matchesWorkspaceFilter({ workspace_names: [] }, NO_WORKSPACE_FILTER)).toBe(true)
    expect(matchesWorkspaceFilter({ workspace_names: null }, NO_WORKSPACE_FILTER)).toBe(true)
    expect(matchesWorkspaceFilter({ workspace_names: ['工具开发组'] }, NO_WORKSPACE_FILTER)).toBe(
      false,
    )
  })

  it('没有项目组的批次不会被任何具体项目组筛中', () => {
    expect(matchesWorkspaceFilter({ workspace_names: [] }, '工具开发组')).toBe(false)
  })

  it('筛选值带空白时仍按规范化后的名称比对', () => {
    expect(matchesWorkspaceFilter({ workspace_names: [' 工具开发组 '] }, '工具开发组')).toBe(true)
  })
})
