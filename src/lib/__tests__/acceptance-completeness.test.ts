import { describe, expect, it } from 'vitest'
import {
  acceptanceCompleteness,
  acceptanceCompletenessOf,
  averageCompleteness,
  completenessBand,
  completenessBreakdown,
  completenessTagColor,
  completenessTooltip,
} from '../acceptance-completeness'
import type { AcceptanceReviewReport, CriterionFinding, ReviewVerdict } from '../../../worker/src/ai/review-workflow-types'

function report(
  verdicts: ReadonlyArray<ReviewVerdict | null>,
  overrides: Partial<AcceptanceReviewReport> = {},
): AcceptanceReviewReport {
  const findings: CriterionFinding[] = []
  verdicts.forEach((verdict, index) => {
    if (verdict === null) return
    findings.push({ criterionId: `C${index + 1}`, verdict, reason: '理由', evidenceIds: [] })
  })
  return {
    version: 1,
    criteria: verdicts.map((_verdict, index) => ({
      id: `C${index + 1}`,
      description: `验收点 ${index + 1}`,
      needsClarification: false,
      sources: [],
    })),
    findings,
    risks: [],
    sources: [],
    supplementRounds: 0,
    verification: {
      status: 'CONFIRMED',
      investigationAgentId: 'a',
      verificationAgentId: 'b',
      disagreementIds: [],
      riskDisagreementIds: [],
    },
    ...overrides,
  }
}

describe('验收点完成度', () => {
  it('按权重加权：已实现 1、部分实现 0.6、未实现 0、不确定 0.25', () => {
    const value = acceptanceCompletenessOf(report(['IMPLEMENTED', 'IMPLEMENTED', 'PARTIAL', 'NOT_IMPLEMENTED']))
    expect(value).not.toBeNull()
    // (1 + 1 + 0.6 + 0) / 4 = 65
    expect(value!.percent).toBe(65)
    expect(value!.total).toBe(4)
    expect(value!.counts).toEqual({ IMPLEMENTED: 2, PARTIAL: 1, NOT_IMPLEMENTED: 1, UNCERTAIN: 0 })
  })

  it('复现页面上那条需求：11 个验收点、已实现 7、不确定 4 得到 73%', () => {
    const value = acceptanceCompletenessOf(report([
      'IMPLEMENTED', 'IMPLEMENTED', 'IMPLEMENTED', 'IMPLEMENTED', 'IMPLEMENTED', 'IMPLEMENTED', 'IMPLEMENTED',
      'UNCERTAIN', 'UNCERTAIN', 'UNCERTAIN', 'UNCERTAIN',
    ]))
    // 需求级 verdict 会因为这 4 个不确定被派生成「无法判断」，完成度给出 (7 + 4×0.25)/11。
    expect(value!.percent).toBe(73)
    // 把 4 个不确定从 0.25 补到满分即为上限。
    expect(value!.potentialPercent).toBe(100)
  })

  it('缺结论的验收点按不确定计入，分母不缩小', () => {
    // 2 个验收点只有 1 条结论；若按 findings 当分母会算出 100%。
    const value = acceptanceCompletenessOf(report(['IMPLEMENTED', null]))
    expect(value!.total).toBe(2)
    // (1 + 0.25) / 2 = 62.5 → 63
    expect(value!.percent).toBe(63)
    expect(value!.counts.UNCERTAIN).toBe(1)
  })

  it('未知 verdict 字符串按不确定兜底，不产生 NaN', () => {
    const malformed = report(['IMPLEMENTED'])
    malformed.findings[0] = { ...malformed.findings[0], verdict: 'SOMETHING_NEW' as ReviewVerdict }
    const value = acceptanceCompletenessOf(malformed)
    expect(value!.percent).toBe(25)
    expect(Number.isNaN(value!.percent)).toBe(false)
    expect(value!.counts.UNCERTAIN).toBe(1)
  })

  it('没有报告、非 version 1、没有验收点时返回 null，而不是 0%', () => {
    expect(acceptanceCompletenessOf(null)).toBeNull()
    expect(acceptanceCompletenessOf({ ...report(['IMPLEMENTED']), version: 2 as 1 })).toBeNull()
    expect(acceptanceCompletenessOf(report([]))).toBeNull()
    expect(acceptanceCompleteness(null)).toBeNull()
    expect(acceptanceCompleteness({ acceptance_review: null })).toBeNull()
  })

  it('criteria 为空但有结论时退回按结论统计', () => {
    const value = acceptanceCompletenessOf({ ...report(['IMPLEMENTED', 'NOT_IMPLEMENTED']), criteria: [] })
    expect(value!.total).toBe(2)
    expect(value!.percent).toBe(50)
  })

  it('说明文字必须从权重表派生，并写出不确定的计入方式与上限', () => {
    const value = acceptanceCompletenessOf(report(['IMPLEMENTED', 'UNCERTAIN']))!
    expect(value.percent).toBe(63)
    expect(completenessBreakdown(value)).toBe('已实现 1 / 部分实现 0 / 未实现 0 / 不确定 1')
    const tooltip = completenessTooltip(value)
    expect(tooltip).toContain('共 2 个验收点')
    expect(tooltip).toContain('已实现记 1 分、部分实现记 0.6 分、未实现记 0 分、不确定记 0.25 分')
    expect(tooltip).toContain('完成度可达 100%')
  })

  it('没有不确定项时不提上限，免得读起来像还有悬念', () => {
    const value = acceptanceCompletenessOf(report(['IMPLEMENTED', 'PARTIAL']))!
    // (1 + 0.6) / 2 = 80
    expect(value.percent).toBe(80)
    expect(completenessTooltip(value)).not.toContain('可达')
  })

  it('0% 只在全部未实现时出现：全是不确定给 25%，不和"查清了没做"混为一谈', () => {
    const allUncertain = acceptanceCompletenessOf(report(['UNCERTAIN', 'UNCERTAIN', 'UNCERTAIN', 'UNCERTAIN']))!
    expect(allUncertain.percent).toBe(25)
    expect(completenessBand(allUncertain.percent)).toBe('LOW')
    const allMissing = acceptanceCompletenessOf(report(['NOT_IMPLEMENTED', 'NOT_IMPLEMENTED']))!
    expect(allMissing.percent).toBe(0)
    expect(completenessBand(allMissing.percent)).toBe('ZERO')
  })

  it('配色与区间按 100 / 60 / 其余分档', () => {
    expect(completenessTagColor(100)).toBe('green')
    expect(completenessTagColor(99)).toBe('orange')
    expect(completenessTagColor(59)).toBe('red')
    expect(completenessBand(100)).toBe('FULL')
    expect(completenessBand(60)).toBe('HIGH')
    expect(completenessBand(1)).toBe('LOW')
    expect(completenessBand(0)).toBe('ZERO')
    expect(completenessBand(null)).toBe('NONE')
  })

  it('平均完成度只算有验收点结论的需求，并给出分母', () => {
    const a = acceptanceCompletenessOf(report(['IMPLEMENTED', 'IMPLEMENTED']))
    const b = acceptanceCompletenessOf(report(['NOT_IMPLEMENTED', 'NOT_IMPLEMENTED']))
    expect(averageCompleteness([a, b, null])).toEqual({ percent: 50, counted: 2 })
    expect(averageCompleteness([null, null])).toEqual({ percent: 0, counted: 0 })
  })
})
