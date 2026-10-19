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
  it('V1.56：项目组解析不到时说清是项目组的事，不说成网络问题', () => {
    const text = describeLinkyError(
      new Error('LINKY_WORKSPACE_NOT_FOUND 项目组「工具组」在 Linky 里没有任何需求'),
    )
    expect(text).toContain('精确匹配')
    expect(text).toContain('用户故事')
    expect(text).not.toContain('网络')
  })

  it('V1.56：上游 token 失效要说明重试无用、该找谁', () => {
    const text = describeLinkyError(new Error('LINKY_UPSTREAM_AUTH_FAILED invalid token'))
    expect(text).toContain('不是你的网络问题')
    expect(text).toContain('Linky 工作区')
  })

  it('V1.56：代理端口没放开与代理不可用是两回事', () => {
    expect(describeLinkyError(new Error('LINKY_PROXY_PORT_BLOCKED'))).toContain('2055')
    expect(describeLinkyError(new Error('LINKY_PROXY_UNREACHABLE'))).toContain('代理服务')
  })
})

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

  it('代理恢复后可按提示重试失败的需求准备', () => {
    expect(describeLinkyError(new Error('LINKY_PROXY_UNREACHABLE'))).toContain('重试准备')
    expect(describeLinkyError(new Error('LINKY_IMPORT_RETRY_ACTIVE'))).toContain('正在进行')
    expect(describeLinkyError(new Error('LINKY_IMPORT_RETRY_NOT_FAILED'))).toContain('刷新')
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
