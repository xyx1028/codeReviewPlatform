import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AcceptanceReviewCard } from '../AcceptanceReviewCard'
import type { AiCodeEvidence, AiReviewResult } from '../../types'

function fixture(): AiReviewResult {
  return { id: 'result', story_id: 'story', ai_import_record_id: 'import', verdict: 'UNCERTAIN', confidence: 0, summary: '一个验收点待确认', implemented_content: null, missing_content: null, risks: null, test_points: null, ai_remark: null, analysis_detail_items: null, created_at: '', updated_at: '',
    acceptance_review: { version: 1, criteria: [{ id: 'C1', description: '取消订单释放库存', needsClarification: false, sources: [{ sourceId: 'body', quote: '取消后释放占用库存' }] }], sources: [{ id: 'body', label: '需求正文' }], supplementRounds: 1,
      findings: [{ criterionId: 'C1', verdict: 'UNCERTAIN', reason: '调查与复核存在分歧', evidenceIds: ['ev-1'], disagreement: { investigationVerdict: 'IMPLEMENTED', investigationReason: '发现释放方法', investigationEvidenceIds: ['ev-1'], reviewVerdict: 'NOT_IMPLEMENTED', reviewReason: '取消入口未调用该方法', reviewEvidenceIds: [] } }],
      risks: [{ id: 'R1', criterionIds: ['C1'], title: '重复取消导致多次释放', trigger: '重复调用取消接口', impact: '库存重复增加', certainty: 'SUSPECTED', origin: 'MISSING_SCENARIO', evidenceIds: ['ev-1'], reviewNote: '该风险尚有分歧' }],
      verification: { status: 'DISAGREEMENT', investigationAgentId: 'a', verificationAgentId: 'b', disagreementIds: ['C1'], riskDisagreementIds: ['R1'] } } }
}
const evidence: AiCodeEvidence[] = [{ id: 'code-1', evidence_id: 'ev-1', ai_review_result_id: 'result', repository_name: 'kdmanage-backend', file_path: 'src/Order.java', start_line: 10, end_line: 20, commit_sha: 'a'.repeat(40), evidence_summary: '取消订单释放库存调用链', evidence_type: '现有实现', description: '代码尚未接入取消入口', symbol_name: null, created_at: '', updated_at: '' }]
const render = (result: AiReviewResult | null, items = evidence) => renderToStaticMarkup(createElement(AcceptanceReviewCard, { result, evidence: items }))

function pagedFixture() {
  const result = fixture()
  result.acceptance_review!.findings[0].evidenceIds = ['ev-1', 'ev-2', 'ev-3']
  return result
}

const pagedEvidence = ['1', '2', '3'].map((suffix) => ({
  ...evidence[0],
  id: `code-${suffix}`,
  evidence_id: `ev-${suffix}`,
  evidence_summary: `第 ${suffix} 条证据`,
  description: `第 ${suffix} 条证据说明`,
}))

describe('acceptance review presentation', () => {
  it('shows requirement, verdict, original source, bound evidence, disagreement and risk together', () => {
    const html = render(fixture())
    for (const text of ['验收点', '评审结论', '依据', '取消订单释放库存', '需求正文', '取消后释放占用库存', 'src/Order.java', '10–20 行', '发现释放方法', '取消入口未调用该方法', '重复调用取消接口', '库存重复增加', '该风险尚有分歧']) expect(html).toContain(text)
    expect(html).toContain('acceptance-evidence-row')
    expect(html).not.toContain('切换页签')
    expect(html).not.toContain('AI 备注')
  })
  it('renders evidence in a full-width row and paginates bound evidence two at a time', () => {
    const html = render(pagedFixture(), pagedEvidence)
    expect(html).toContain('colSpan="3"')
    expect(html).toContain('显示 1–2 / 3 条')
    expect(html).toContain('第 1 条证据')
    expect(html).toContain('第 2 条证据')
    expect(html).not.toContain('第 3 条证据')
  })
  it('does not fabricate per-point judgements for historical reports', () => {
    const old = fixture()
    old.acceptance_review = null
    old.implemented_content = '历史实现记录'
    const html = render(old)
    expect(html).toContain('历史报告尚无逐项验收结论')
    expect(html).toContain('历史实现记录')
    expect(html).not.toContain('acceptance-table')
  })
  it('makes missing evidence visible instead of replacing it with unrelated code', () => {
    const html = render(fixture(), [{ ...evidence[0], evidence_id: 'unrelated-id' }])
    expect(html).toContain('该证据未加载')
    expect(html).not.toContain('src/Order.java')
  })
})
