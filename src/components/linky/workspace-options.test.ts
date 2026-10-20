import { describe, expect, it } from 'vitest'
import { workspaceOptions } from './workspace-options'

describe('workspaceOptions', () => {
  it('全量候选未返回时仍可用完整项目组名称直接查询', () => {
    expect(workspaceOptions([], ' 工具开发组 ')).toEqual([
      { value: '工具开发组', label: '工具开发组（按完整名称查询）' },
    ])
  })

  it('保留已选项目组，不重复已有候选，也不生成空名称', () => {
    expect(workspaceOptions(['工具开发组', '工具开发组'], '工具开发组', '前端组')).toEqual([
      { value: '工具开发组', label: '工具开发组' },
      { value: '前端组', label: '前端组' },
    ])
    expect(workspaceOptions([], '   ')).toEqual([])
  })
})
