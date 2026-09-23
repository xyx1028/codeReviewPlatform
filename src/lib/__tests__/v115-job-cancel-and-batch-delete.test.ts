/**
 * V1.15：停止分析任务 + 删除批次的前端契约。
 *
 * 锁定两件容易回归的事：
 *  1. 停止走 Job 级 RPC，参数与返回原样传给页面（cancelled_attempts 决定提示文案）；
 *  2. `deleteBatch` 必须**先调 RPC、后清 Storage**。反过来的话，数据库那条
 *     BATCH_HAS_ACTIVE_ANALYSIS_JOB 守卫一旦拒绝，附件已经被删掉而批次还在。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const rpcMock = vi.hoisted(() => vi.fn())
const listMock = vi.hoisted(() => vi.fn())
const removeMock = vi.hoisted(() => vi.fn())

vi.mock('../supabase', () => ({
  requireSupabase: () => ({
    rpc: rpcMock,
    storage: { from: () => ({ list: listMock, remove: removeMock }) },
  }),
}))

import { batchDeleteErrorMessage, deleteBatch, requestJobCancel } from '../api'
import { resolveAnalysisError } from '../labels'

describe('V1.15 停止分析任务', () => {
  beforeEach(() => {
    rpcMock.mockReset()
    listMock.mockReset()
    removeMock.mockReset()
  })

  it('调用 Job 级 RPC 并透传取消结果', async () => {
    rpcMock.mockResolvedValue({
      data: { job_id: 'job-1', job_status: 'FAILED', already_terminal: false, cancelled_attempts: 3 },
      error: null,
    })

    await expect(requestJobCancel('job-1')).resolves.toMatchObject({
      already_terminal: false,
      cancelled_attempts: 3,
    })
    expect(rpcMock).toHaveBeenCalledWith('request_analysis_job_cancel', {
      p_job_id: 'job-1',
      p_reason: 'USER_CANCELLED',
    })
  })

  it('权限不足时把数据库错误原样抛给页面', async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: 'batch management permission required' } })
    await expect(requestJobCancel('job-1')).rejects.toThrow('batch management permission required')
  })

  it('停止后的任务在 AI 结果页显示成「已被停止」而不是未知错误', () => {
    const resolved = resolveAnalysisError('JOB_CANCELLED', '分析任务已被用户停止')
    expect(resolved.code).toBe('JOB_CANCELLED')
    expect(resolved.meta.title).toBe('分析任务已被停止')
    expect(resolved.meta.retryable).toBe(true)
  })
})

describe('V1.15 删除批次', () => {
  beforeEach(() => {
    rpcMock.mockReset()
    listMock.mockReset()
    removeMock.mockReset()
  })

  it('活动分析任务导致删除被拒时，不碰 Storage 附件', async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: 'BATCH_HAS_ACTIVE_ANALYSIS_JOB' } })

    await expect(deleteBatch('batch-1')).rejects.toThrow('停止分析')
    expect(listMock).not.toHaveBeenCalled()
    expect(removeMock).not.toHaveBeenCalled()
  })

  it('删除成功后才清理 Storage 附件', async () => {
    rpcMock.mockResolvedValue({ data: null, error: null })
    listMock.mockResolvedValue({ data: [{ name: 'a.xlsx', id: 'file-1' }], error: null })
    removeMock.mockResolvedValue({ error: null })

    await expect(deleteBatch('batch-1')).resolves.toBeUndefined()
    expect(rpcMock).toHaveBeenCalledWith('delete_review_batch', { p_batch_id: 'batch-1' })
    expect(removeMock).toHaveBeenCalledWith(['batch-1/a.xlsx'])
  })

  it('其他数据库错误保持原文，不被吞掉', () => {
    expect(batchDeleteErrorMessage('batch management permission required'))
      .toBe('batch management permission required')
    expect(batchDeleteErrorMessage('BATCH_HAS_ACTIVE_ANALYSIS_JOB')).toContain('停止分析')
  })
})
