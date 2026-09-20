import { describe, expect, it } from 'vitest'
import {
  GIT_IDENTITY_STATUS_META,
  describeGitEmailDiscoveryPhase,
  describeGitIdentityError,
} from '../git-identity'
import type { GitEmailDiscovery } from '../../types'

describe('describeGitIdentityError', () => {
  it('把数据库的稳定错误码翻成人话', () => {
    expect(describeGitIdentityError('IDENTITY_PEPPER_MISSING')).toContain('analysis_identity_pepper')
    expect(describeGitIdentityError('GIT_EMAIL_ALREADY_BOUND')).toContain('另一个成员')
    expect(describeGitIdentityError('DEVELOPER_EMPLOYEE_CODE_CONFLICT')).toContain('员工号')
    expect(describeGitIdentityError('DEVELOPER_IDENTITY_LOCKED')).toContain('管理员')
    expect(describeGitIdentityError('REVISION_CONFLICT')).toContain('刷新')
    expect(describeGitIdentityError('GIT_IDENTITY_NOT_FOUND')).toContain('不属于你')
  })

  it('PostgREST 的包装文案里也能认出错误码', () => {
    // supabase-js 抛出的是完整报文，不是裸错误码。
    const wrapped = 'new row violates ... GIT_EMAIL_ALREADY_BOUND (code P0001)'
    expect(describeGitIdentityError(wrapped)).toContain('另一个成员')
  })

  it('认不出来的报错原样透出，不伪造一句人话', () => {
    expect(describeGitIdentityError('network error')).toBe('network error')
  })

  it('编辑/删除这两个操作的拒绝理由要说清下一步怎么做', () => {
    // 这几条不是"出错了"，而是产品规则，所以文案必须给出替代动作。
    expect(describeGitIdentityError('GIT_IDENTITY_IN_USE')).toContain('停用')
    expect(describeGitIdentityError('GIT_IDENTITY_DISABLED')).toContain('新增')
    expect(describeGitIdentityError('GIT_IDENTITY_WOULD_MATCH_NOTHING')).toContain('至少保留一项')
    expect(describeGitIdentityError('GIT_IDENTITY_TOO_MANY_ALIASES')).toContain('10')
    expect(describeGitIdentityError('GIT_IDENTITY_ALIAS_INVALID')).toContain('64')
  })

  it('基本资料里那次保存的校验失败也有对应说法', () => {
    expect(describeGitIdentityError('DEVELOPER_DISPLAY_NAME_TOO_LONG')).toContain('32')
    expect(describeGitIdentityError('DEVELOPER_DISPLAY_NAME_INVALID')).toContain('控制字符')
    expect(describeGitIdentityError('DEVELOPER_EMPLOYEE_CODE_INVALID')).toContain('员工号')
    expect(describeGitIdentityError('USER_PROFILE_NOT_FOUND')).toContain('重新登录')
  })

  it('V1.13 反查链路的错误码也有对应说法', () => {
    expect(describeGitIdentityError('GITLAB_USER_NOT_FOUND')).toContain('Path')
    expect(describeGitIdentityError('GITLAB_API_TOKEN_MISSING')).toContain('GITLAB_API_TOKEN')
    expect(describeGitIdentityError('MR_METADATA_TIMEOUT')).toContain('连不上 GitLab')
    expect(describeGitIdentityError('GIT_EMAIL_DISCOVERY_EXPIRED')).toContain('重新查找')
    expect(describeGitIdentityError('GIT_EMAIL_DISCOVERY_RATE_LIMITED')).toContain('频繁')
  })
})


describe('GIT_IDENTITY_STATUS_META', () => {
  it('只覆盖数据库定义的四个状态', () => {
    expect(Object.keys(GIT_IDENTITY_STATUS_META).sort()).toEqual([
      'CONFLICT',
      'DISABLED',
      'UNVERIFIED',
      'VERIFIED',
    ])
    expect(GIT_IDENTITY_STATUS_META.DISABLED.color).toBeUndefined()
  })
})

type PhaseInput = Parameters<typeof describeGitEmailDiscoveryPhase>[0]

function discovery(overrides: Partial<GitEmailDiscovery> = {}): PhaseInput {
  return {
    status: 'QUEUED',
    claimed: false,
    candidate_count: 0,
    merge_request_count: 0,
    partial: false,
    error_code: null,
    error_message: null,
    gitlab_username: 'yuxuan_xue',
    lookback_days: 365,
    ...overrides,
  } as PhaseInput
}

describe('describeGitEmailDiscoveryPhase', () => {
  it('没发起查询时是空闲', () => {
    expect(describeGitEmailDiscoveryPhase(null, 0).kind).toBe('IDLE')
  })

  it('排队中与执行中分开：判据是后端的 claimed，而不是时间', () => {
    expect(describeGitEmailDiscoveryPhase(discovery(), 1000).kind).toBe('WAITING_WORKER')
    expect(describeGitEmailDiscoveryPhase(discovery({ claimed: true }), 1000).kind).toBe('RUNNING')
    expect(describeGitEmailDiscoveryPhase(discovery({ status: 'RUNNING' }), 1000).kind).toBe('RUNNING')
  })

  it('排队超过 3 分钟且没人领 → 明确说没有可用 Worker，不继续假装在查', () => {
    const phase = describeGitEmailDiscoveryPhase(discovery(), 200_000)
    expect(phase.kind).toBe('NO_WORKER')
    expect(phase.hint).toContain('Worker')
  })

  it('已被领取的任务即使超时也算执行中（它确实在跑）', () => {
    expect(describeGitEmailDiscoveryPhase(discovery({ claimed: true }), 999_999).kind).toBe('RUNNING')
  })

  it('成功但没有候选时，说清为什么查不到', () => {
    const phase = describeGitEmailDiscoveryPhase(
      discovery({ status: 'SUCCEEDED', candidate_count: 0 }), 5000,
    )
    expect(phase.kind).toBe('DONE_EMPTY')
    expect(phase.hint).toContain('365')
    expect(phase.hint).toContain('yuxuan_xue')
  })

  it('成功且有候选时报告数量；结果不全时照实说', () => {
    const complete = describeGitEmailDiscoveryPhase(
      discovery({ status: 'SUCCEEDED', candidate_count: 2, merge_request_count: 7 }), 5000,
    )
    expect(complete.kind).toBe('DONE')
    expect(complete.hint).toContain('7')
    expect(complete.hint).toContain('2')
    expect(complete.hint).not.toContain('可能不全')

    const partial = describeGitEmailDiscoveryPhase(
      discovery({ status: 'SUCCEEDED', candidate_count: 1, merge_request_count: 3, partial: true }), 5000,
    )
    expect(partial.hint).toContain('可能不全')
  })

  it('失败时把错误码翻成人话', () => {
    const phase = describeGitEmailDiscoveryPhase(
      discovery({ status: 'FAILED', error_code: 'GITLAB_USER_NOT_FOUND' }), 5000,
    )
    expect(phase.kind).toBe('FAILED')
    expect(phase.hint).toContain('GitLab 上找不到这个用户名')
  })
})

