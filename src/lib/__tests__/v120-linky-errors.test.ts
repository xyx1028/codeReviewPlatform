/**
 * V1.20：Linky 稳定错误码 → 人话。
 *
 * 值得单测的原因很具体：这些码是**唯一**告诉用户"为什么不能导入"的东西。
 * 漏一个分支，用户看到的就是一行 `LINKY_DETAIL_NOT_SYNCED` 的 SQL 异常文本，
 * 而正确的下一步动作（先做一次完整同步）无从得知。
 */
import { describe, expect, it } from 'vitest'
import { describeLinkyError } from '../api'

describe('describeLinkyError', () => {
  it('把"正文没同步"翻译成可执行的下一步', () => {
    const text = describeLinkyError(new Error('rpc failed: LINKY_DETAIL_NOT_SYNCED'))
    expect(text).toContain('完整同步')
  })

  it('附件未就绪时说明两条出路', () => {
    const text = describeLinkyError(new Error('LINKY_ATTACHMENTS_NOT_READY'))
    expect(text).toContain('重试同步')
    expect(text).toContain('允许缺少附件')
  })

  it('冷却与权限各自有明确说法', () => {
    expect(describeLinkyError(new Error('LINKY_SYNC_TOO_FREQUENT'))).toContain('30 秒')
    expect(describeLinkyError(new Error('LINKY_SYNC_FORBIDDEN'))).toContain('管理员')
    expect(describeLinkyError(new Error('LINKY_SYNC_SCOPE_REQUIRED'))).toContain('项目组')
  })

  it('批次只读与在途任务分开提示', () => {
    expect(describeLinkyError(new Error('BATCH_READ_ONLY'))).toContain('已完成')
    expect(describeLinkyError(new Error('ACTIVE_JOB_EXISTS'))).toContain('停止')
  })

  it('认不出的错误原样返回，不吞掉信息', () => {
    expect(describeLinkyError(new Error('some unexpected failure'))).toBe('some unexpected failure')
  })
})
