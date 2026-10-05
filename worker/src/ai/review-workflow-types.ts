/** JSON contract shared by Worker and browser; no runtime dependencies. */
export type ReviewVerdict = 'IMPLEMENTED' | 'PARTIAL' | 'NOT_IMPLEMENTED' | 'UNCERTAIN'

export type ReviewPhase = 'EXTRACT' | 'INVESTIGATE' | 'VERIFY'

export interface RequirementSource {
  id: string
  label: string
  text: string
  /** Platform-observed incomplete input; extraction must retain a clarification point. */
  requiresClarification?: boolean
}
export interface AcceptancePoint {
  id: string
  description: string
  needsClarification: boolean
  sources: Array<{ sourceId: string; quote: string }>
}
export interface CriterionFinding {
  criterionId: string
  verdict: ReviewVerdict
  reason: string
  evidenceIds: string[]
  disagreement?: {
    investigationVerdict: ReviewVerdict
    investigationReason: string
    investigationEvidenceIds: string[]
    reviewVerdict: ReviewVerdict
    reviewReason: string
    reviewEvidenceIds: string[]
  }
}
export interface ReviewRisk {
  id: string
  criterionIds: string[]
  title: string
  trigger: string
  impact: string
  certainty: 'CONFIRMED' | 'SUSPECTED'
  origin: 'INTRODUCED' | 'MISSING_SCENARIO' | 'EXISTING' | 'UNKNOWN'
  evidenceIds: string[]
  reviewNote?: string
}
export interface CriterionReport {
  findings: CriterionFinding[]
  risks: ReviewRisk[]
}
export interface AcceptanceReviewReport extends CriterionReport {
  version: 1
  criteria: AcceptancePoint[]
  sources: Array<{ id: string; label: string }>
  supplementRounds: number
  verification: {
    status: 'CONFIRMED' | 'DISAGREEMENT'
    investigationAgentId: string
    verificationAgentId: string
    disagreementIds: string[]
    riskDisagreementIds: string[]
  }
}
