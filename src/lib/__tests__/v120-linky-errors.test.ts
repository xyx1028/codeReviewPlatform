/**
 * V1.20：导入链路的稳定错误码 → 人话。
 *
 * 值得单测的原因很具体：这些码是**唯一**告诉用户"为什么这批需求没进来"的东西。
 * 漏一个分支，用户看到的就是一行 SQL 异常文本，而正确的下一步动作无从得知。
 */
import { describe, expect, it } from 'vitest'
import { describeLinkyError } from '../api'
import { LinkyLiveError, describeLinkyLiveError, linkyApiBase } from '../linky-live'

describe('describeLinkyError', () => {
  it('没选项目组时点明它定义了需求来源', () => {
    expect(describeLinkyError(new Error('rpc failed: LINKY_IMPORT_WORKSPACE_REQUIRED'))).toContain(
      '项目组',
    )
  })

  it('没勾选、超量各自有明确说法', () => {
    expect(describeLinkyError(new Error('LINKY_IMPORT_EMPTY_SELECTION'))).toContain('勾选')
    expect(describeLinkyError(new Error('LINKY_IMPORT_TOO_MANY_STORIES'))).toContain('500')
  })

  it('旧版门禁留下的失败行仍然能解释清楚', () => {
    const text = describeLinkyError(new Error('LINKY_IMPORT_STORY_NO_REQUIREMENT_SOURCE'))
    expect(text).toContain('正文')
    expect(text).toContain('附件')
  })

  it('批次只读与在途任务分开提示', () => {
    expect(describeLinkyError(new Error('BATCH_READ_ONLY'))).toContain('已完成')
    expect(describeLinkyError(new Error('ACTIVE_JOB_EXISTS'))).toContain('停止')
  })

  it('认不出的错误原样返回，不吞掉信息', () => {
    expect(describeLinkyError(new Error('some unexpected failure'))).toBe('some unexpected failure')
  })
})

describe('linky-live', () => {
  it('默认 base 指向 Linky 取数接口', () => {
    expect(linkyApiBase()).toMatch(/\/quality-platform\/api\/linky$/)
    expect(linkyApiBase().endsWith('/')).toBe(false)
  })

  it('网络不可达的错误message 直接告诉用户要连内网，而不是"暂无数据"', () => {
    const error = new LinkyLiveError('Linky 取数接口连不上。它只在公司内网可达', 'NETWORK')
    expect(error.kind).toBe('NETWORK')
    expect(describeLinkyLiveError(error)).toContain('内网')
  })
})
