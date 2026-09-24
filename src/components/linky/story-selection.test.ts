import { describe, expect, it } from 'vitest'
import {
  pruneSelectionToScope,
  selectAllState,
  shouldResetSelection,
  toggleSelectAllFiltered,
} from './story-selection'

const scope = new Set(['US-2026-010728', 'US-2026-012147', 'US-2026-011000'])

describe('pruneSelectionToScope', () => {
  it('剔掉不属于当前项目组的编号（实测里正是这些以 LINKY_NOT_FOUND 失败）', () => {
    const kept = pruneSelectionToScope(
      ['US-2026-010728', 'US-2026-000307', 'US-2026-010329', 'US-2026-012147'],
      scope,
    )
    expect(kept).toEqual(['US-2026-010728', 'US-2026-012147'])
  })

  it('保留同一项目组内跨筛选条件的勾选，并按勾选顺序去重', () => {
    const kept = pruneSelectionToScope(
      ['US-2026-012147', 'US-2026-011000', 'US-2026-012147'],
      scope,
    )
    expect(kept).toEqual(['US-2026-012147', 'US-2026-011000'])
  })

  it('范围为空时不保留任何编号', () => {
    expect(pruneSelectionToScope(['US-2026-010728'], new Set())).toEqual([])
  })
})

describe('shouldResetSelection', () => {
  it('切到另一个项目组且手上有勾选时才清空', () => {
    expect(
      shouldResetSelection({
        previousWorkspaceName: null,
        nextWorkspaceName: '工具开发组',
        selectedCount: 43,
      }),
    ).toBe(true)
    expect(
      shouldResetSelection({
        previousWorkspaceName: '工具开发组',
        nextWorkspaceName: '灵基质量执行平台quality-platform',
        selectedCount: 1,
      }),
    ).toBe(true)
  })

  it('项目组没变、或本来没勾选，都不动', () => {
    expect(
      shouldResetSelection({
        previousWorkspaceName: '工具开发组',
        nextWorkspaceName: '工具开发组',
        selectedCount: 43,
      }),
    ).toBe(false)
    expect(
      shouldResetSelection({
        previousWorkspaceName: null,
        nextWorkspaceName: '工具开发组',
        selectedCount: 0,
      }),
    ).toBe(false)
  })
})

describe('selectAllState', () => {
  const filteredCodes = ['A', 'B', 'C']

  it('筛选结果全部勾上才算全选（只勾了当前页的 10 条不算）', () => {
    expect(selectAllState({ filteredCodes, selectedCodes: ['A', 'B', 'C'] })).toEqual({
      checked: true,
      indeterminate: false,
    })
    expect(selectAllState({ filteredCodes, selectedCodes: ['A'] })).toEqual({
      checked: false,
      indeterminate: true,
    })
    expect(selectAllState({ filteredCodes, selectedCodes: [] })).toEqual({
      checked: false,
      indeterminate: false,
    })
  })

  it('筛选之外的勾选不参与判定', () => {
    expect(selectAllState({ filteredCodes, selectedCodes: ['A', 'B', 'C', 'Z'] })).toEqual({
      checked: true,
      indeterminate: false,
    })
  })

  it('筛选结果为空时不显示任何选中态', () => {
    expect(selectAllState({ filteredCodes: [], selectedCodes: ['A'] })).toEqual({
      checked: false,
      indeterminate: false,
    })
  })
})

describe('toggleSelectAllFiltered', () => {
  it('全选覆盖所有页，不是只覆盖当前页', () => {
    const codes = toggleSelectAllFiltered({
      selectedCodes: [],
      filteredCodes: ['A', 'B', 'C', 'D', 'E'],
      select: true,
    })
    expect(codes).toEqual(['A', 'B', 'C', 'D', 'E'])
  })

  it('全选时在已有勾选后面追加且不重复', () => {
    const codes = toggleSelectAllFiltered({
      selectedCodes: ['C', 'Z'],
      filteredCodes: ['A', 'B', 'C'],
      select: true,
    })
    expect(codes).toEqual(['C', 'Z', 'A', 'B'])
  })

  it('取消全选只移除筛选结果里的编号，保留筛选之外的勾选', () => {
    const codes = toggleSelectAllFiltered({
      selectedCodes: ['A', 'B', 'Z'],
      filteredCodes: ['A', 'B'],
      select: false,
    })
    expect(codes).toEqual(['Z'])
  })
})
