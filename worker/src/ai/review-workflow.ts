import type { ReviewSubmission, ReviewVerdict } from './snapshot/deterministic-verifier.js'

export const REVIEW_WORKFLOW_VERSION = 1
export const MAX_SUPPLEMENT_ROUNDS = 1
import type { AcceptancePoint, AcceptanceReviewReport, CriterionFinding, CriterionReport, RequirementSource, ReviewRisk } from './review-workflow-types.js'
export type { AcceptancePoint, AcceptanceReviewReport, CriterionFinding, CriterionReport, RequirementSource, ReviewPhase, ReviewRisk } from './review-workflow-types.js'

export class ReviewWorkflowError extends Error {
  readonly code = 'REVIEW_WORKFLOW_INVALID'
  constructor(message: string) { super(message); this.name = 'ReviewWorkflowError' }
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ReviewWorkflowError(`${field} must be an object`)
  return value as Record<string, unknown>
}
function text(value: unknown, field: string, limit = 2000): string {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > limit) {
    throw new ReviewWorkflowError(`${field} must be non-empty trimmed text of at most ${limit} characters`)
  }
  return value
}
function array(value: unknown, field: string, limit: number): unknown[] {
  if (!Array.isArray(value) || value.length > limit) throw new ReviewWorkflowError(`${field} must be an array of at most ${limit} items`)
  return value
}
function ids(value: unknown, field: string, allowed: ReadonlySet<string>, limit = 64): string[] {
  const result = array(value, field, limit).map((id) => text(id, field, 128))
  if (new Set(result).size !== result.length || result.some((id) => !allowed.has(id))) {
    throw new ReviewWorkflowError(`${field} contains duplicate or unknown IDs`)
  }
  return result
}
function normalized(value: string): string { return value.replace(/\s+/g, ' ').trim() }
const verdicts: ReviewVerdict[] = ['IMPLEMENTED', 'PARTIAL', 'NOT_IMPLEMENTED', 'UNCERTAIN']

/** IDs and source quotes are verified before the list can become the investigation contract. */
export function parseAcceptancePoints(value: unknown, sources: readonly RequirementSource[]): AcceptancePoint[] {
  const entries = array(value, 'acceptancePoints', 64)
  if (!entries.length) throw new ReviewWorkflowError('acceptancePoints must not be empty; ambiguous inputs require a needsClarification point')
  const catalog = new Map(sources.map((source) => [source.id, source]))
  const points = entries.map((entry, index) => {
    const point = record(entry, `acceptancePoints[${index}]`)
    const id = text(point.id, 'point.id', 32)
    if (id !== `C${index + 1}`) throw new ReviewWorkflowError('acceptance point IDs must be C1, C2, ... in source order')
    if (typeof point.needsClarification !== 'boolean') throw new ReviewWorkflowError('needsClarification must be boolean')
    const refs = array(point.sources, 'point.sources', 16)
    if (!refs.length) throw new ReviewWorkflowError(`${id} has no requirement source`)
    const parsed = refs.map((ref) => {
      const item = record(ref, 'point.source')
      const sourceId = text(item.sourceId, 'sourceId', 256)
      const quote = text(item.quote, 'quote')
      const source = catalog.get(sourceId)
      if (!source || !normalized(source.text).includes(normalized(quote))) {
        throw new ReviewWorkflowError(`${id} cites a quote absent from frozen source ${sourceId}`)
      }
      if (source.requiresClarification && point.needsClarification !== true) {
        throw new ReviewWorkflowError(`${id}: incomplete source ${sourceId} requires clarification`)
      }
      return { sourceId, quote }
    })
    return { id, description: text(point.description, 'description', 1000), needsClarification: point.needsClarification, sources: parsed }
  })
  for (const source of sources.filter((entry) => entry.requiresClarification)) {
    if (!points.some((point) => point.needsClarification && point.sources.some((ref) => ref.sourceId === source.id))) {
      throw new ReviewWorkflowError(`incomplete source ${source.id} must have a clarification point`)
    }
  }
  return points
}

/** Evidence IDs must belong to reads made by THIS phase, not just copied from its input draft. */
export function parseCriterionReport(
  value: unknown,
  criteria: readonly AcceptancePoint[],
  phaseEvidenceIds: ReadonlySet<string>,
  implementationEvidenceIds: ReadonlySet<string>,
): CriterionReport {
  const data = record(value, 'report')
  const allowed = new Set(criteria.map((point) => point.id))
  const entries = array(data.criterionReviews, 'criterionReviews', 64)
  const found = new Set<string>()
  const findings = entries.map((entry) => {
    const item = record(entry, 'finding')
    const criterionId = text(item.criterionId, 'criterionId', 32)
    if (!allowed.has(criterionId) || found.has(criterionId)) throw new ReviewWorkflowError(`duplicate or unknown criterionId ${criterionId}`)
    found.add(criterionId)
    if (!verdicts.includes(item.verdict as ReviewVerdict)) throw new ReviewWorkflowError(`${criterionId} has invalid verdict`)
    const verdict = item.verdict as ReviewVerdict
    const evidenceIds = ids(item.evidenceIds, 'finding.evidenceIds', phaseEvidenceIds, 32)
    if ((verdict === 'IMPLEMENTED' || verdict === 'PARTIAL') && !evidenceIds.some((id) => implementationEvidenceIds.has(id))) {
      throw new ReviewWorkflowError(`${criterionId}: ${verdict} requires independently read existing-implementation evidence`)
    }
    if (criteria.find((point) => point.id === criterionId)?.needsClarification && verdict !== 'UNCERTAIN') {
      throw new ReviewWorkflowError(`${criterionId} requires clarification and must remain UNCERTAIN`)
    }
    return { criterionId, verdict, reason: text(item.reason, 'finding.reason'), evidenceIds }
  })
  if (found.size !== allowed.size) throw new ReviewWorkflowError(`unreviewed criteria: ${[...allowed].filter((id) => !found.has(id)).join(', ')}`)
  const riskIds = new Set<string>()
  const risks = array(data.reviewRisks, 'reviewRisks', 64).map((entry) => {
    const item = record(entry, 'risk')
    const id = text(item.id, 'risk.id', 64)
    if (riskIds.has(id)) throw new ReviewWorkflowError(`duplicate risk ID ${id}`)
    riskIds.add(id)
    if (!['CONFIRMED', 'SUSPECTED'].includes(item.certainty as string)) throw new ReviewWorkflowError(`${id}: invalid certainty`)
    if (!['INTRODUCED', 'MISSING_SCENARIO', 'EXISTING', 'UNKNOWN'].includes(item.origin as string)) throw new ReviewWorkflowError(`${id}: invalid origin`)
    const evidenceIds = ids(item.evidenceIds, 'risk.evidenceIds', phaseEvidenceIds, 32)
    if (item.certainty === 'CONFIRMED' && !evidenceIds.length) throw new ReviewWorkflowError(`${id}: a confirmed risk needs code evidence`)
    return {
      id, criterionIds: ids(item.criterionIds, 'risk.criterionIds', allowed),
      title: text(item.title, 'risk.title', 500), trigger: text(item.trigger, 'risk.trigger'), impact: text(item.impact, 'risk.impact'),
      certainty: item.certainty as ReviewRisk['certainty'], origin: item.origin as ReviewRisk['origin'], evidenceIds,
    }
  })
  return { findings: criteria.map((point) => findings.find((finding) => finding.criterionId === point.id)!), risks }
}

export function differingCriteria(investigation: CriterionReport, verification: CriterionReport): string[] {
  return investigation.findings.filter((finding) => verification.findings.find((other) => other.criterionId === finding.criterionId)?.verdict !== finding.verdict).map((finding) => finding.criterionId)
}

/** A paraphrased description is not a disagreement, but a dropped or reclassified risk is. */
export function differingRisks(investigation: CriterionReport, verification: CriterionReport): string[] {
  const ids = new Set([...investigation.risks, ...verification.risks].map((risk) => risk.id))
  return [...ids].filter((id) => {
    const first = investigation.risks.find((risk) => risk.id === id)
    const second = verification.risks.find((risk) => risk.id === id)
    return !first || !second || first.certainty !== second.certainty || first.origin !== second.origin ||
      [...first.criterionIds].sort().join(',') !== [...second.criterionIds].sort().join(',')
  })
}

/** Retain contradictory facts for humans; disagreement never silently becomes an affirmative verdict. */
export function finalizeAcceptanceReview(input: {
  criteria: AcceptancePoint[]
  sources: RequirementSource[]
  investigation: CriterionReport
  verification: CriterionReport
  investigationAgentId: string
  verificationAgentId: string
  supplementRounds: number
}): AcceptanceReviewReport {
  if (input.investigationAgentId === input.verificationAgentId) throw new ReviewWorkflowError('verification requires an independent platform root')
  if (!Number.isInteger(input.supplementRounds) || input.supplementRounds < 0 || input.supplementRounds > MAX_SUPPLEMENT_ROUNDS) throw new ReviewWorkflowError('supplement round limit exceeded')
  const disagreements = differingCriteria(input.investigation, input.verification)
  const riskDisagreements = differingRisks(input.investigation, input.verification)
  const findings = input.verification.findings.map((review) => {
    const investigation = input.investigation.findings.find((finding) => finding.criterionId === review.criterionId)!
    if (!disagreements.includes(review.criterionId)) return { ...review }
    return {
      criterionId: review.criterionId, verdict: 'UNCERTAIN' as const,
      reason: '调查与独立复核仍存在分歧，待人工确认。', evidenceIds: [...new Set([...investigation.evidenceIds, ...review.evidenceIds])],
      disagreement: {
        investigationVerdict: investigation.verdict, investigationReason: investigation.reason, investigationEvidenceIds: investigation.evidenceIds,
        reviewVerdict: review.verdict, reviewReason: review.reason, reviewEvidenceIds: review.evidenceIds,
      },
    }
  })
  const risks = input.verification.risks.map((risk) => ({ ...risk }))
  for (const risk of input.investigation.risks) {
    const reviewed = risks.find((other) => other.id === risk.id)
    if (!reviewed) {
      risks.push({ ...risk, certainty: 'SUSPECTED', reviewNote: '调查提出该风险，独立复核未确认；保留供人工核查。' })
    } else if (riskDisagreements.includes(risk.id)) {
      reviewed.certainty = 'SUSPECTED'
      reviewed.evidenceIds = [...new Set([...risk.evidenceIds, ...reviewed.evidenceIds])]
      reviewed.reviewNote = `调查与复核对风险判断存在分歧，待人工确认。调查：${risk.title}；${risk.trigger}；${risk.impact}（${risk.certainty}/${risk.origin}）。复核：${reviewed.title}；${reviewed.trigger}；${reviewed.impact}。`
    }
  }
  for (const risk of risks) {
    if (riskDisagreements.includes(risk.id) && !input.investigation.risks.some((other) => other.id === risk.id)) {
      risk.certainty = 'SUSPECTED'
      risk.reviewNote = '独立复核新增该风险，调查尚未确认；保留供人工核查。'
    }
  }
  return {
    version: REVIEW_WORKFLOW_VERSION, criteria: input.criteria, sources: input.sources.map(({ id, label }) => ({ id, label })),
    findings, risks, supplementRounds: input.supplementRounds,
    verification: { status: disagreements.length || riskDisagreements.length ? 'DISAGREEMENT' : 'CONFIRMED', investigationAgentId: input.investigationAgentId, verificationAgentId: input.verificationAgentId, disagreementIds: disagreements, riskDisagreementIds: riskDisagreements },
  }
}

export function overallVerdict(findings: readonly CriterionFinding[]): ReviewVerdict {
  if (!findings.length || findings.some((finding) => finding.verdict === 'UNCERTAIN')) return 'UNCERTAIN'
  if (findings.every((finding) => finding.verdict === 'IMPLEMENTED')) return 'IMPLEMENTED'
  if (findings.every((finding) => finding.verdict === 'NOT_IMPLEMENTED')) return 'NOT_IMPLEMENTED'
  return 'PARTIAL'
}

/** The legacy writer fields are derived, never a second competing model judgement. */
export function submissionForReport(report: CriterionReport, evidence: ReviewSubmission['evidence']): ReviewSubmission {
  const oneLine = (value: string) => value.replace(/\s+/g, ' ').trim().slice(0, 500)
  return {
    verdict: overallVerdict(report.findings), confidence: 0,
    summary: `共 ${report.findings.length} 个验收点：${verdicts.map((verdict, index) => `${['已实现', '部分实现', '未实现', '不确定'][index]} ${report.findings.filter((finding) => finding.verdict === verdict).length}`).join('，')}。`,
    implementedItems: report.findings.filter((finding) => finding.verdict === 'IMPLEMENTED' || finding.verdict === 'PARTIAL').slice(0, 12).map((finding) => oneLine(`${finding.criterionId}：${finding.reason}`)),
    missingItems: report.findings.filter((finding) => finding.verdict === 'NOT_IMPLEMENTED' || finding.verdict === 'PARTIAL').slice(0, 12).map((finding) => oneLine(`${finding.criterionId}：${finding.reason}`)),
    riskItems: report.risks.slice(0, 12).map((risk) => oneLine(`${risk.id}：${risk.title}；${risk.trigger}；${risk.impact}`)),
    testPointItems: [], remarkItems: [], evidence,
  }
}
