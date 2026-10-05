import {
  MAX_SUPPLEMENT_ROUNDS, ReviewWorkflowError, differingCriteria, differingRisks, finalizeAcceptanceReview,
  parseAcceptancePoints, parseCriterionReport, submissionForReport,
  type AcceptancePoint, type AcceptanceReviewReport, type CriterionReport, type RequirementSource, type ReviewPhase,
} from '../review-workflow.js'
import type { ReviewSubmission, VerificationResult } from '../snapshot/deterministic-verifier.js'
import type { AgentIdentity } from './agent-authority-ledger.js'

interface PhaseResult {
  report: CriterionReport
  evidence: ReviewSubmission['evidence']
  agentId: string
}

/** A platform state machine, not a tool the model can use to switch or skip phases. */
export class ReviewWorkflowCoordinator {
  private current: ReviewPhase = 'EXTRACT'
  private rootId = ''
  private accepted = false
  private capturing = false
  private points: AcceptancePoint[] = []
  private rounds = 0
  private investigation: PhaseResult | null = null
  private verification: PhaseResult | null = null
  private final: ReviewSubmission | null = null

  constructor(readonly sources: RequirementSource[], private readonly persist?: (input: {
    phase: ReviewPhase; round: number; agentId: string; result: unknown
  }) => Promise<void>) {}

  phase = (): ReviewPhase => this.current
  activeRootId = (): string => this.rootId
  get criteria(): AcceptancePoint[] { return structuredClone(this.points) }
  get supplementRounds(): number { return this.rounds }
  get submitted(): boolean { return this.accepted }
  get phaseKey(): string { return `${this.current.toLowerCase()}-${this.rounds}` }
  get draft(): CriterionReport | null { return this.investigation ? structuredClone(this.investigation.report) : null }
  get feedback(): CriterionReport | null { return this.verification ? structuredClone(this.verification.report) : null }

  begin(rootId: string): void {
    if (!rootId) throw new ReviewWorkflowError('phase root must be assigned by the platform')
    if (this.current === 'VERIFY' && rootId === this.investigation?.agentId) throw new ReviewWorkflowError('verification needs an independent Agent')
    this.rootId = rootId
    this.accepted = false
  }

  capture = async (raw: Record<string, unknown>, context: {
    identity: AgentIdentity
    phaseEvidenceIds: Set<string>
    verify(submission: ReviewSubmission): Promise<VerificationResult>
  }): Promise<unknown> => {
    if (this.capturing) throw new ReviewWorkflowError('phase submission is already being recorded')
    this.capturing = true
    try {
      return await this.capturePhase(raw, context)
    } finally {
      this.capturing = false
    }
  }

  private async capturePhase(raw: Record<string, unknown>, context: {
    identity: AgentIdentity
    phaseEvidenceIds: Set<string>
    verify(submission: ReviewSubmission): Promise<VerificationResult>
  }): Promise<unknown> {
    if (this.accepted) throw new ReviewWorkflowError('phase already submitted')
    if (!raw || context.identity.agentId !== this.rootId) throw new ReviewWorkflowError('invalid phase submission identity')
    let result: unknown
    if (this.current === 'EXTRACT') {
      result = parseAcceptancePoints(raw.acceptancePoints, this.sources)
    } else {
      if (!Array.isArray(raw.evidence)) throw new ReviewWorkflowError('evidence must be an array')
      const evidence = raw.evidence as ReviewSubmission['evidence']
      // The phase first proves every submitted code range through the existing deterministic verifier.
      const provisional: ReviewSubmission = { verdict: 'UNCERTAIN', confidence: 0, summary: '阶段证据核验', implementedItems: [], missingItems: [], riskItems: [], testPointItems: [], remarkItems: [], evidence }
      const verified = await context.verify(provisional)
      if (!verified.ok) throw new ReviewWorkflowError(`${verified.code}: ${verified.reason}`)
      const verifiedIds = new Set(verified.evidence.map((item) => item.evidenceId))
      const ownIds = new Set([...context.phaseEvidenceIds].filter((id) => verifiedIds.has(id)))
      const implementationIds = new Set(verified.evidence.filter((item) => item.evidenceType === '现有实现').map((item) => item.evidenceId))
      const report = parseCriterionReport(raw, this.points, ownIds, implementationIds)
      // Apply absence coverage per point as well as to the aggregate verdict.
      for (const finding of report.findings.filter((item) => item.verdict === 'NOT_IMPLEMENTED')) {
        const checked = await context.verify({ ...provisional, verdict: 'NOT_IMPLEMENTED', summary: finding.reason })
        if (!checked.ok) throw new ReviewWorkflowError(`${finding.criterionId}: ${checked.code}: ${checked.reason}`)
      }
      result = { report, evidence, agentId: this.rootId }
    }
    // Acknowledgement only follows durable phase recording; failures never publish a partial result.
    await this.persist?.({ phase: this.current, round: this.rounds, agentId: this.rootId, result })
    if (this.current === 'EXTRACT') this.points = structuredClone(result as AcceptancePoint[])
    else if (this.current === 'INVESTIGATE') this.investigation = structuredClone(result as PhaseResult)
    else this.verification = structuredClone(result as PhaseResult)
    this.accepted = true
    return { accepted: true, stageAccepted: true, runId: this.phaseKey, committedAt: new Date().toISOString() }
  }

  /** Returns the next phase, or null when all mandatory gates have completed. */
  advance(): ReviewPhase | null {
    if (!this.accepted) throw new ReviewWorkflowError('cannot advance without a validated phase result')
    if (this.current === 'EXTRACT') this.current = 'INVESTIGATE'
    else if (this.current === 'INVESTIGATE') this.current = 'VERIFY'
    else {
      if (!this.investigation || !this.verification) throw new ReviewWorkflowError('missing investigation or independent verification')
      const differing = differingCriteria(this.investigation.report, this.verification.report)
      const riskDisagreements = differingRisks(this.investigation.report, this.verification.report)
      if ((differing.length || riskDisagreements.length) && this.rounds < MAX_SUPPLEMENT_ROUNDS) {
        this.rounds++
        this.current = 'INVESTIGATE'
      } else {
        const report = finalizeAcceptanceReview({
          criteria: this.points, sources: this.sources,
          investigation: this.investigation.report, verification: this.verification.report,
          investigationAgentId: this.investigation.agentId, verificationAgentId: this.verification.agentId, supplementRounds: this.rounds,
        })
        const refs = new Set([...report.findings.flatMap((finding) => finding.evidenceIds), ...report.risks.flatMap((risk) => risk.evidenceIds)])
        const evidence = new Map([...this.investigation.evidence, ...this.verification.evidence].map((item) => [item.evidenceId, item]))
        this.final = { ...submissionForReport(report, [...refs].map((id) => evidence.get(id)!)), acceptanceReview: report }
        return null
      }
    }
    this.accepted = false
    return this.current
  }

  finalSubmission = (): ReviewSubmission => {
    if (!this.final?.acceptanceReview) throw new ReviewWorkflowError('mandatory independent verification has not completed')
    return structuredClone(this.final)
  }

  finalReport(): AcceptanceReviewReport { return this.finalSubmission().acceptanceReview! }
}
