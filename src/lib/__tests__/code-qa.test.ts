/**
 * 产品代码问答的前端纯逻辑（V1.23）。
 *
 * 这些用例盯住的是"写错了不会报错、只会让产品看到一句误导的话"的地方：
 * 阶段文案必须对应真实上报的 stage、错误码不能被收敛成一句无用的"请重试"、
 * 轮询必须在终态停下、证据缺席时不能把页面搞崩。
 */

import { describe, expect, it } from 'vitest'

import {
  CODE_QA_QUESTION_MAX_CHARS,
  codeQaPollInterval,
  describeCodeQaError,
  describeCodeQaStage,
  hasInFlightTurn,
  isCodeQaTurnTerminal,
  shouldWarnContextReset,
  summarizeCodeQaEvidence,
  validateCodeQaQuestion,
} from '../code-qa'
import type { CodeQaConversationDetail, CodeQaTurn } from '../../types'

function turn(overrides: Partial<CodeQaTurn> = {}): CodeQaTurn {
  return {
    id: 'turn-1',
    question: '这个功能怎么实现的？',
    status: 'SUCCEEDED',
    stage: 'DONE',
    answer: '见 src/a.java',
    evidence: null,
    error_code: null,
    error_message: null,
    model_label: 'deepseek',
    created_at: '2026-09-24T10:00:00Z',
    started_at: '2026-09-24T10:00:01Z',
    finished_at: '2026-09-24T10:00:40Z',
    ...overrides,
  }
}

function detail(turns: CodeQaTurn[]): CodeQaConversationDetail {
  return {
    id: 'conv-1',
    title: '问答',
    repositories: ['kdmanage-backend'],
    branch: 'release',
    commit_shas: { 'kdmanage-backend': 'a'.repeat(40) },
    has_session: true,
    created_at: '2026-09-24T10:00:00Z',
    updated_at: '2026-09-24T10:00:00Z',
    last_turn_at: '2026-09-24T10:00:40Z',
    turns,
  }
}

describe('describeCodeQaStage', () => {
  it('每个阶段都有一句对应真实上报事实的文案', () => {
    expect(describeCodeQaStage('QUEUED')).toContain('排队')
    expect(describeCodeQaStage('PREPARING_CODE')).toContain('代码快照')
    expect(describeCodeQaStage('EXPLORING')).toContain('检索代码')
    expect(describeCodeQaStage('GENERATING')).toContain('组织回答')
    expect(describeCodeQaStage('DONE')).toContain('完成')
  })

  it('文案里不出现没有事实支撑的进度承诺', () => {
    // "即将完成"/"剩余"这类话需要一个后端没有提供的预估，写出来就是编的。
    for (const stage of ['QUEUED', 'PREPARING_CODE', 'EXPLORING', 'GENERATING', 'DONE'] as const) {
      const label = describeCodeQaStage(stage)
      expect(label).not.toMatch(/即将|剩余|预计|马上就好/)
    }
  })
})

describe('describeCodeQaError', () => {
  it('把不同失败翻成不同处置，而不是统一"请重试"', () => {
    const noModel = describeCodeQaError('MODEL_CONFIG_NOT_FOUND', null)
    const proxyDown = describeCodeQaError('MODEL_PROXY_UNREACHABLE', null)
    const snapshot = describeCodeQaError('CODE_QA_SNAPSHOT_FAILED', null)
    expect(noModel).toContain('管理员')
    expect(proxyDown).toContain('代理')
    expect(snapshot).toContain('分支')
    // 三种处置必须互不相同，否则用户无从判断该做什么。
    expect(new Set([noModel, proxyDown, snapshot]).size).toBe(3)
  })

  it('会话无法恢复时明确让用户新建会话', () => {
    expect(describeCodeQaError('CODE_QA_SESSION_RESUME_FAILED', null)).toContain('新建')
  })

  it('未登记的错误码原样透出原因，不吞掉', () => {
    expect(describeCodeQaError('SOME_NEW_CODE', 'upstream exploded')).toBe('upstream exploded')
  })

  it('既没有登记也没有原因时至少带上错误码', () => {
    expect(describeCodeQaError('SOME_NEW_CODE', '   ')).toContain('SOME_NEW_CODE')
  })

  it('完全没有信息时给一句兜底而不是空字符串', () => {
    expect(describeCodeQaError(null, null)).toBe('回答失败')
  })
})

describe('validateCodeQaQuestion', () => {
  it('空白问题被拒', () => {
    expect(validateCodeQaQuestion({ question: '   \n ', hasInFlightTurn: false }).ok).toBe(false)
  })

  it('正常问题通过', () => {
    expect(validateCodeQaQuestion({ question: '转派怎么做的', hasInFlightTurn: false })).toEqual({
      ok: true,
    })
  })

  it('超长问题被拒，并且提示里给出当前长度', () => {
    const result = validateCodeQaQuestion({
      question: 'x'.repeat(CODE_QA_QUESTION_MAX_CHARS + 1),
      hasInFlightTurn: false,
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toContain(String(CODE_QA_QUESTION_MAX_CHARS + 1))
  })

  it('在飞时禁止发送', () => {
    const result = validateCodeQaQuestion({ question: '再问一个', hasInFlightTurn: true })
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('回答中')
  })
})

describe('轮询与在飞判定', () => {
  it('终态判定只认 SUCCEEDED / FAILED', () => {
    expect(isCodeQaTurnTerminal('QUEUED')).toBe(false)
    expect(isCodeQaTurnTerminal('RUNNING')).toBe(false)
    expect(isCodeQaTurnTerminal('SUCCEEDED')).toBe(true)
    expect(isCodeQaTurnTerminal('FAILED')).toBe(true)
  })

  it('有 QUEUED 或 RUNNING 就算在飞', () => {
    expect(hasInFlightTurn([turn(), turn({ id: 't2', status: 'QUEUED' })])).toBe(true)
    expect(hasInFlightTurn([turn(), turn({ id: 't2', status: 'FAILED' })])).toBe(false)
  })

  it('全部终态后停止轮询', () => {
    expect(codeQaPollInterval(detail([turn()]))).toBe(false)
    expect(codeQaPollInterval(detail([turn({ status: 'RUNNING', stage: 'EXPLORING' })]))).toBe(2000)
  })

  it('数据还没到时不轮询', () => {
    expect(codeQaPollInterval(undefined)).toBe(false)
  })
})

describe('summarizeCodeQaEvidence', () => {
  it('整理出 commit、文件、技能与工具次数', () => {
    const summary = summarizeCodeQaEvidence({
      commit_shas: { 'kdmanage-backend': 'abcdef1234567890abcdef1234567890abcdef12' },
      files_read: ['src/a.java', 'src/b.java'],
      skills_used: ['kdmanage-backend-engineering'],
      tool_call_count: 9,
      resumed: true,
    })
    expect(summary.commits).toEqual([
      {
        repository: 'kdmanage-backend',
        commitSha: 'abcdef1234567890abcdef1234567890abcdef12',
        shortSha: 'abcdef12',
      },
    ])
    expect(summary.filesRead).toHaveLength(2)
    expect(summary.skillsUsed).toEqual(['kdmanage-backend-engineering'])
    expect(summary.toolCallCount).toBe(9)
    expect(summary.resumed).toBe(true)
  })

  it('跨仓库时按仓库名排序列出每个 commit（V1.23d）', () => {
    const summary = summarizeCodeQaEvidence({
      commit_shas: {
        'kdmanage-frontend': 'f'.repeat(40),
        'kdmanage-backend': 'b'.repeat(40),
      },
    })
    // 排序固定，否则同一轮刷新两次会看到不同顺序。
    expect(summary.commits.map((entry) => entry.repository)).toEqual([
      'kdmanage-backend',
      'kdmanage-frontend',
    ])
    // repositories 缺席时从 commit 映射推导，页面照样能显示范围。
    expect(summary.repositories).toEqual(['kdmanage-backend', 'kdmanage-frontend'])
  })

  it('repositories 存在时优先用它（包含还没冻结 commit 的仓库）', () => {
    const summary = summarizeCodeQaEvidence({
      repositories: ['kdmanage-backend', 'kdmanage-frontend'],
      commit_shas: { 'kdmanage-backend': 'b'.repeat(40) },
    })
    expect(summary.repositories).toEqual(['kdmanage-backend', 'kdmanage-frontend'])
    expect(summary.commits).toHaveLength(1)
  })

  it('证据整体缺席时返回空结构而不是抛错', () => {
    const summary = summarizeCodeQaEvidence(null)
    expect(summary.commits).toEqual([])
    expect(summary.repositories).toEqual([])
    expect(summary.filesRead).toEqual([])
    expect(summary.skillsUsed).toEqual([])
    expect(summary.toolCallCount).toBeNull()
    expect(summary.resumed).toBeNull()
  })

  it('数组里混进非字符串时过滤掉，不让它渲染成 [object Object]', () => {
    const summary = summarizeCodeQaEvidence({
      files_read: ['ok.java', 42, null] as unknown as string[],
    })
    expect(summary.filesRead).toEqual(['ok.java'])
  })
})

describe('shouldWarnContextReset', () => {
  it('第一轮不是续跑，不提示', () => {
    expect(shouldWarnContextReset([turn({ evidence: { resumed: false } })])).toBe(false)
  })

  it('中途出现 resumed=false 时提示上下文断过', () => {
    const turns = [
      turn({ id: 't1', evidence: { resumed: false } }),
      turn({ id: 't2', evidence: { resumed: false } }),
    ]
    expect(shouldWarnContextReset(turns)).toBe(true)
  })

  it('正常续跑不提示', () => {
    const turns = [
      turn({ id: 't1', evidence: { resumed: false } }),
      turn({ id: 't2', evidence: { resumed: true } }),
    ]
    expect(shouldWarnContextReset(turns)).toBe(false)
  })

  it('最后一轮还没成功时不提示（结论还没定）', () => {
    const turns = [
      turn({ id: 't1', evidence: { resumed: false } }),
      turn({ id: 't2', status: 'RUNNING', evidence: null }),
    ]
    expect(shouldWarnContextReset(turns)).toBe(false)
  })
})
