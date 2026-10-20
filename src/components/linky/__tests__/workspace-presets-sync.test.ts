/**
 * 项目组清单的跨包一致性（V1.60）。
 *
 * 清单有两份副本：前端用的 TS（页面下拉）和 MCP 用的 .mjs（`list_workspaces` 工具）。
 * 两份是刻意的 —— 前端是构建期打包的 TS，MCP 是独立的 .mjs 包、运行期从磁盘加载，
 * 没有共同的模块系统；跨目录 import 会把 MCP 的可打包性绑死在前端的目录结构上。
 *
 * 代价是漂移风险，而这条测试就是用来兜住它的：**两份不一致时这里失败**。
 * 新增/删除项目组时请同时改两个文件。
 */

import { describe, expect, it } from 'vitest'

import { LINKY_WORKSPACE_PRESETS } from '../workspace-presets'
// MCP 包是纯 ESM 的 .mjs，vitest 可以直接解析。
import { LINKY_WORKSPACE_PRESETS as MCP_PRESETS } from '../../../../mcp/code-review-mcp/src/workspaces.mjs'

describe('Linky 项目组清单：前端与 MCP 必须完全一致', () => {
  it('两份清单的内容与顺序都相同', () => {
    expect([...MCP_PRESETS]).toEqual([...LINKY_WORKSPACE_PRESETS])
  })

  it('清单里没有空值、没有首尾空格、没有重复', () => {
    for (const name of LINKY_WORKSPACE_PRESETS) {
      expect(name).toBe(name.trim())
      expect(name.length).toBeGreaterThan(0)
    }
    expect(new Set(LINKY_WORKSPACE_PRESETS).size).toBe(LINKY_WORKSPACE_PRESETS.length)
  })

  it('包含那次事故里涉及的真实项目组名', () => {
    // 使用者当时说的是「工具组」，真名是「工具开发组」。
    expect(LINKY_WORKSPACE_PRESETS).toContain('工具开发组')
    expect(LINKY_WORKSPACE_PRESETS).not.toContain('工具组')
  })
})
