import { describe, expect, it } from 'vitest'
import { ReviewWorkflowCoordinator } from '../ai/control/review-workflow-coordinator.js'
import { AgentAuthorityLedger } from '../ai/control/agent-authority-ledger.js'
import { normalizeCapabilityPolicy } from '../ai/policy/v4-capability-policy.js'
import {
  differingCriteria, finalizeAcceptanceReview, overallVerdict, parseAcceptancePoints, parseCriterionReport,
  type AcceptancePoint, type CriterionReport, type RequirementSource,
} from '../ai/review-workflow.js'

const sources: RequirementSource[] = [{ id: 'body', label: '需求正文', text: '取消订单后释放库存。已支付订单必须发起退款。' }]
const points: AcceptancePoint[] = [
  { id: 'C1', description: '取消订单释放库存', needsClarification: false, sources: [{ sourceId: 'body', quote: '取消订单后释放库存' }] },
  { id: 'C2', description: '已支付订单退款', needsClarification: false, sources: [{ sourceId: 'body', quote: '已支付订单必须发起退款' }] },
]
const evidence = new Set(['e-stock', 'e-refund'])
function report(): { criterionReviews: unknown[]; reviewRisks: unknown[] } {
  return { criterionReviews: [
    { criterionId: 'C1', verdict: 'IMPLEMENTED', reason: '取消入口调用释放库存', evidenceIds: ['e-stock'] },
    { criterionId: 'C2', verdict: 'UNCERTAIN', reason: '支付服务无法读取', evidenceIds: [] },
  ], reviewRisks: [] }
}
const parse = (value: unknown) => parseCriterionReport(value, points, evidence, evidence)

describe('V1.43 fixed acceptance and independent verification contract', () => {
  it('verifies each criterion quote against the frozen source', () => {
    expect(parseAcceptancePoints(points, sources)).toEqual(points)
    const fabricated = structuredClone(points)
    fabricated[0].sources[0].quote = '订单取消必须发送短信'
    expect(() => parseAcceptancePoints(fabricated, sources)).toThrow('absent from frozen source')
  })
  it('rejects empty criteria, unknown sources and unstable IDs', () => {
    expect(() => parseAcceptancePoints([], sources)).toThrow('must not be empty')
    expect(() => parseAcceptancePoints([{ ...points[0], id: 'C9' }], sources)).toThrow('C1, C2')
    expect(() => parseAcceptancePoints([{ ...points[0], sources: [{ sourceId: 'code', quote: '库存' }] }], sources)).toThrow('absent')
  })
  it('cannot silently omit an unreadable or truncated attachment from acceptance coverage', () => {
    const gap = { id: 'input-gap:image', label: '附件图片', text: '图片附件尚未核实', requiresClarification: true }
    const catalog = [...sources, gap]
    expect(() => parseAcceptancePoints(points, catalog)).toThrow('must have a clarification point')
    const clarification = { id: 'C3', description: '补充图片中的验收要求', needsClarification: true, sources: [{ sourceId: gap.id, quote: gap.text }] }
    expect(parseAcceptancePoints([...points, clarification], catalog)).toHaveLength(3)
    expect(() => parseAcceptancePoints([...points, { ...clarification, needsClarification: false }], catalog)).toThrow('requires clarification')
    const clarifiedPoints = parseAcceptancePoints([...points, clarification], catalog)
    expect(() => parseCriterionReport({ ...report(), criterionReviews: [...report().criterionReviews,
      { criterionId: 'C3', verdict: 'IMPLEMENTED', reason: '忽略未读图片', evidenceIds: ['e-stock'] },
    ] }, clarifiedPoints, evidence, evidence)).toThrow('requires clarification')
  })
  it('rejects an omitted acceptance point rather than accepting a plausible summary', () => {
    const value = report()
    value.criterionReviews.pop()
    expect(() => parse(value)).toThrow('unreviewed criteria: C2')
  })
  it('rejects duplicates and invented acceptance IDs', () => {
    const value = report()
    value.criterionReviews.push(value.criterionReviews[0])
    expect(() => parse(value)).toThrow('duplicate')
    value.criterionReviews = [{ criterionId: 'C99', verdict: 'UNCERTAIN', reason: '无', evidenceIds: [] }]
    expect(() => parse(value)).toThrow('unknown')
  })
  it('requires the verification phase to read its own supporting evidence', () => {
    expect(() => parseCriterionReport(report(), points, new Set(), evidence)).toThrow('unknown IDs')
    expect(() => parseCriterionReport(report(), points, evidence, new Set())).toThrow('independently read')
    expect(parse(report()).findings).toHaveLength(2)
  })
  it('keeps ambiguous requirements uncertain', () => {
    const ambiguous = points.map((point) => ({ ...point, needsClarification: true }))
    expect(() => parseCriterionReport(report(), ambiguous, evidence, evidence)).toThrow('requires clarification')
  })
  it('requires confirmed risks to have evidence and valid criterion bindings', () => {
    const value = report()
    const risk = { id: 'R1', criterionIds: ['C1'], title: '重复释放', trigger: '重复取消', impact: '库存增加', certainty: 'CONFIRMED', origin: 'MISSING_SCENARIO', evidenceIds: [] }
    value.reviewRisks = [risk]
    expect(() => parse(value)).toThrow('confirmed risk needs code evidence')
    value.reviewRisks = [{ ...risk, evidenceIds: ['e-stock'], criterionIds: ['C9'] }]
    expect(() => parse(value)).toThrow('unknown IDs')
  })
  it('preserves both judgements after bounded supplementation and marks the point UNCERTAIN', () => {
    const investigation = parse(report())
    const verification: CriterionReport = { ...investigation, findings: investigation.findings.map((finding) => ({ ...finding, ...(finding.criterionId === 'C1' ? { verdict: 'NOT_IMPLEMENTED' as const, reason: '方法存在但入口未调用' } : {}) })) }
    expect(differingCriteria(investigation, verification)).toEqual(['C1'])
    const final = finalizeAcceptanceReview({ criteria: points, sources, investigation, verification, investigationAgentId: 'investigator', verificationAgentId: 'verifier', supplementRounds: 1 })
    expect(final.findings[0].verdict).toBe('UNCERTAIN')
    expect(final.findings[0].disagreement?.investigationVerdict).toBe('IMPLEMENTED')
    expect(final.findings[0].disagreement?.reviewVerdict).toBe('NOT_IMPLEMENTED')
    expect(final.verification.status).toBe('DISAGREEMENT')
    expect(overallVerdict(final.findings)).toBe('UNCERTAIN')
  })
  it('rejects self-review and rounds beyond the limit', () => {
    const input = { criteria: points, sources, investigation: parse(report()), verification: parse(report()), investigationAgentId: 'same', verificationAgentId: 'same', supplementRounds: 0 }
    expect(() => finalizeAcceptanceReview(input)).toThrow('independent platform root')
    expect(() => finalizeAcceptanceReview({ ...input, verificationAgentId: 'other', supplementRounds: 2 })).toThrow('round limit')
  })
  it('does not silently discard a risk omitted by the second reviewer', () => {
    const investigation = parse(report())
    investigation.risks.push({ id: 'R1', criterionIds: ['C1'], title: '重复释放', trigger: '重复取消', impact: '库存增加', certainty: 'CONFIRMED', origin: 'UNKNOWN', evidenceIds: ['e-stock'] })
    const final = finalizeAcceptanceReview({ criteria: points, sources, investigation, verification: parse(report()), investigationAgentId: 'a', verificationAgentId: 'b', supplementRounds: 0 })
    expect(final.risks[0].certainty).toBe('SUSPECTED')
    expect(final.risks[0].reviewNote).toContain('未确认')
    expect(final.verification.status).toBe('DISAGREEMENT')
    expect(final.verification.riskDisagreementIds).toEqual(['R1'])
  })
  it('preserves risk classification disagreements instead of presenting a confirmed risk', () => {
    const investigation = parse(report())
    investigation.risks.push({ id: 'R1', criterionIds: ['C1'], title: '重复释放', trigger: '重复取消', impact: '库存增加', certainty: 'CONFIRMED', origin: 'INTRODUCED', evidenceIds: ['e-stock'] })
    const verification = structuredClone(investigation)
    verification.risks[0].certainty = 'SUSPECTED'
    verification.risks[0].origin = 'EXISTING'
    const final = finalizeAcceptanceReview({ criteria: points, sources, investigation, verification, investigationAgentId: 'a', verificationAgentId: 'b', supplementRounds: 1 })
    expect(final.risks[0].certainty).toBe('SUSPECTED')
    expect(final.risks[0].reviewNote).toContain('调查与复核')
    expect(final.verification.status).toBe('DISAGREEMENT')
  })
})

describe('platform workflow stage gates and durability', () => {
  const identity = new AgentAuthorityLedger({ taskId: 'workflow-task', agentAttempt: 1, policy: normalizeCapabilityPolicy({}), rootAgentId: 'investigator', rootSessionId: 'investigator-session' }).root
  const context = (agentId: string) => ({ identity: { ...identity, agentId }, phaseEvidenceIds: new Set<string>(), verify: async () => ({ ok: true as const, evidence: [], details: { implemented_content: [], missing_content: [], risks: [], test_points: [], ai_remark: [] } }) })
  const uncertain = (verdict: 'UNCERTAIN' | 'NOT_IMPLEMENTED' = 'UNCERTAIN') => ({ criterionReviews: points.map((point) => ({ criterionId: point.id, verdict, reason: '缺少足够实现依据', evidenceIds: [] })), reviewRisks: [], evidence: [] })

  it('reserves root slots so investigation children cannot prevent mandatory verification', async () => {
    const ledger = new AgentAuthorityLedger({ taskId: 'reserved-roots', agentAttempt: 1, policy: normalizeCapabilityPolicy({ agents: { maxAgentsPerAttempt: 3 } }), rootAgentId: 'root', rootSessionId: 'root-session', reservedPlatformRootSlots: 2 })
    await expect(ledger.registerChild({ parentToken: ledger.rootCapabilityToken, agentId: 'child', sessionId: 'child', provider: 'spawn' })).rejects.toThrow('reserved for platform verification')
    const first = await ledger.registerPlatformRoot('verify-0', 'verify-session-0')
    expect(first.identity.parentAgentId).toBeNull()
    await expect(ledger.registerChild({ parentToken: first.token, agentId: 'child', sessionId: 'child', provider: 'spawn' })).rejects.toThrow('reserved for platform verification')
    await ledger.registerPlatformRoot('verify-1', 'verify-session-1')
    expect(ledger.totalCount()).toBe(3)
  })

  it('does not freeze or acknowledge criteria until durable persistence succeeds', async () => {
    let failed = true
    const workflow = new ReviewWorkflowCoordinator(sources, async () => { if (failed) throw new Error('database unavailable') })
    workflow.begin('investigator')
    await expect(workflow.capture({ acceptancePoints: points }, context('investigator'))).rejects.toThrow('database unavailable')
    expect(workflow.criteria).toEqual([])
    expect(workflow.submitted).toBe(false)
    expect(() => workflow.advance()).toThrow('validated phase result')
    failed = false
    await workflow.capture({ acceptancePoints: points }, context('investigator'))
    expect(workflow.criteria).toEqual(points)
    expect(workflow.advance()).toBe('INVESTIGATE')
  })

  it('rejects overlapping submissions while a phase record is still pending', async () => {
    let release!: () => void
    const pending = new Promise<void>((resolve) => { release = resolve })
    const workflow = new ReviewWorkflowCoordinator(sources, () => pending)
    workflow.begin('investigator')
    const first = workflow.capture({ acceptancePoints: points }, context('investigator'))
    await expect(workflow.capture({ acceptancePoints: points }, context('investigator'))).rejects.toThrow('already being recorded')
    expect(workflow.submitted).toBe(false)
    release()
    await first
    expect(workflow.submitted).toBe(true)
  })

  it('forces independent verification after each investigation and stops after one supplement', async () => {
    const phases: string[] = []
    const workflow = new ReviewWorkflowCoordinator(sources, async ({ phase, round }) => { phases.push(`${phase}:${round}`) })
    workflow.begin('investigator')
    await workflow.capture({ acceptancePoints: points }, context('investigator'))
    workflow.advance()
    for (let round = 0; round <= 1; round++) {
      workflow.begin('investigator')
      await workflow.capture(uncertain('NOT_IMPLEMENTED'), context('investigator'))
      expect(workflow.advance()).toBe('VERIFY')
      expect(() => workflow.begin('investigator')).toThrow('independent Agent')
      const verifier = `verifier-${round}`
      workflow.begin(verifier)
      await workflow.capture(uncertain(), context(verifier))
      expect(workflow.advance()).toBe(round === 0 ? 'INVESTIGATE' : null)
    }
    expect(phases).toEqual(['EXTRACT:0', 'INVESTIGATE:0', 'VERIFY:0', 'INVESTIGATE:1', 'VERIFY:1'])
    const final = workflow.finalReport()
    expect(final.supplementRounds).toBe(1)
    expect(final.findings.every((finding) => finding.verdict === 'UNCERTAIN' && finding.disagreement)).toBe(true)
    expect(final.verification.verificationAgentId).toBe('verifier-1')
  })
})
