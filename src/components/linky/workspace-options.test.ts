import { describe, expect, it } from 'vitest'
import { workspaceOptions } from './workspace-options'

describe('workspaceOptions', () => {
  it('未请求故事时提供预置组，也允许新增组按完整名称查询', () => {
    expect(workspaceOptions([], '')).toContainEqual({ value: '工具开发组', label: '工具开发组' })
    expect(workspaceOptions([], ' 新增测试项目组 ')).toContainEqual(
      { value: '新增测试项目组', label: '新增测试项目组（按完整名称查询）' },
    )
  })

  it('保留已选项目组，不重复已有候选，也不生成空名称', () => {
    const options = workspaceOptions([' 工具开发组 ', '工具开发组'], '工具开发组', '新增前端组')
    expect(options.filter((option) => option.value === '工具开发组')).toEqual([
      { value: '工具开发组', label: '工具开发组' },
    ])
    expect(options).toContainEqual({ value: '新增前端组', label: '新增前端组' })
    expect(workspaceOptions([], '   ').some((option) => option.value.trim() === '')).toBe(false)
  })
})
