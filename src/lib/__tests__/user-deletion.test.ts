/**
 * V1.10 删除用户：弹窗展示逻辑。
 *
 * 这套测试守的是三件容易在 JSX 里写错、且错了会造成真实后果的事：
 *
 *   1. **加载中不能显示结论。** 影响评估还没回来时若默认"可以删除"，管理员可能在数据
 *      到达前就点掉确认；若默认"不能删除"，又会看到一句会自己消失的假拒绝理由。
 *   2. **`USER_HAS_REFERENCES` 必须给出逐条清单**，而不是一句笼统的"不能删除" ——
 *      管理员真正需要的是"到底是哪些东西挡着"。
 *   3. **表名到中文的映射由数据库给**：数据库以后新增一张引用表时，界面要能直接显示它
 *      返回的标签，而不是变成"未知原因不能删"。
 */

import { describe, expect, it } from 'vitest'
import {
  buildUserDeletionView,
  describeUserDeletionError,
  type UserDeletionImpact,
} from '../user-deletion'

function impact(overrides: Partial<UserDeletionImpact> = {}): UserDeletionImpact {
  return {
    can_delete: true,
    code: null,
    user: {
      id: 'u-1',
      email: 'someone@test.local',
      display_name: 'someone',
      role: 'REVIEWER',
      created_at: '2026-09-01T00:00:00Z',
    },
    blocking_references: [],
    cascade_counts: {},
    nullify_counts: {},
    ...overrides,
  }
}

describe('buildUserDeletionView', () => {
  it('加载中（impact 为 null）既不能确认也不给结论', () => {
    const view = buildUserDeletionView(null)
    expect(view.canConfirm).toBe(false)
    expect(view.refusalReason).toBeNull()
    expect(view.blocking).toEqual([])
  })

  it('干净账号可以确认删除', () => {
    const view = buildUserDeletionView(impact())
    expect(view.canConfirm).toBe(true)
    expect(view.refusalReason).toBeNull()
  })

  it('有业务引用时禁止确认，并逐条列出阻止原因', () => {
    const view = buildUserDeletionView(
      impact({
        can_delete: false,
        code: 'USER_HAS_REFERENCES',
        blocking_references: [
          { table: 'review_batch', label: '创建的评审批次', count: 3 },
          { table: 'analysis_job', label: '发起的 AI 分析任务', count: 12 },
        ],
      }),
    )
    expect(view.canConfirm).toBe(false)
    expect(view.blocking).toEqual([
      { label: '创建的评审批次', count: 3 },
      { label: '发起的 AI 分析任务', count: 12 },
    ])
    // 笼统的一句话不能替代清单，但也要有，用于解释"为什么这些会挡住删除"。
    expect(view.refusalReason).toContain('工作记录')
  })

  it('数据库新增的引用表也能显示：标签直接来自数据库', () => {
    const view = buildUserDeletionView(
      impact({
        can_delete: false,
        code: 'USER_HAS_REFERENCES',
        blocking_references: [
          { table: 'some_future_table', label: '将来才有的某种记录', count: 1 },
        ],
      }),
    )
    expect(view.blocking).toEqual([{ label: '将来才有的某种记录', count: 1 }])
  })

  it.each([
    ['CANNOT_DELETE_SELF', '自己'],
    ['CANNOT_DELETE_LAST_ADMIN', '最后一个管理员'],
    ['USER_NOT_FOUND', '已经不存在'],
  ])('拒绝码 %s 有专门的说明', (code, expected) => {
    const view = buildUserDeletionView(impact({ can_delete: false, code }))
    expect(view.canConfirm).toBe(false)
    expect(view.refusalReason).toContain(expected)
  })

  it('未知拒绝码有兜底文案，不显示裸错误码', () => {
    const view = buildUserDeletionView(impact({ can_delete: false, code: 'SOMETHING_NEW' }))
    expect(view.refusalReason).toBe('这个账号当前不能删除。')
  })

  it('只显示计数大于 0 的附属数据与置空项', () => {
    const view = buildUserDeletionView(
      impact({
        cascade_counts: { wechat_identity: 1, auth_sessions: 0, auth_identities: 2 },
        nullify_counts: { review_skill: 2, review_skill_version: 0, review_skill_upload: 0 },
      }),
    )
    expect(view.cascade).toEqual([
      { label: '微信绑定', count: 1 },
      { label: '登录身份（邮箱/第三方）', count: 2 },
    ])
    expect(view.nullify).toEqual([{ label: '技能（作者将置空）', count: 2 }])
  })

  it('V1.12：Git 身份与归属审计的置空项有中文标签', () => {
    const view = buildUserDeletionView(
      impact({
        nullify_counts: { developer_identity: 1, analysis_scope_decision_audit: 3 },
      }),
    )
    expect(view.nullify).toEqual([
      { label: 'Git 身份（将退回未认领，历史分析不受影响）', count: 1 },
      { label: '归属决策审计（操作人将置空，记录本身保留）', count: 3 },
    ])
  })

  it('缺字段时不炸（旧后端 / 部分返回）', () => {
    const view = buildUserDeletionView({
      can_delete: true,
      code: null,
      user: { id: 'u', email: null, display_name: null, role: null, created_at: null },
      blocking_references: undefined as never,
      cascade_counts: undefined as never,
      nullify_counts: undefined as never,
    })
    expect(view.canConfirm).toBe(true)
    expect(view.blocking).toEqual([])
    expect(view.cascade).toEqual([])
  })
})

describe('describeUserDeletionError', () => {
  it('把数据库错误码翻成与弹窗一致的说法', () => {
    // 同一个原因在"弹窗里"和"点了确认之后"必须是同一句话，否则界面自相矛盾。
    const view = buildUserDeletionView(impact({ can_delete: false, code: 'CANNOT_DELETE_SELF' }))
    expect(describeUserDeletionError('CANNOT_DELETE_SELF')).toBe(view.refusalReason)
  })

  it('权限错误有专门说明', () => {
    expect(describeUserDeletionError('ADMIN role required')).toBe('只有管理员可以删除账号。')
  })

  it('认不出来的错误原样带出，不吞掉信息', () => {
    expect(describeUserDeletionError('connection reset')).toBe('connection reset')
  })
})
