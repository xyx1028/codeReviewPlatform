/**
 * Final gate before a review result may be committed.
 *
 * Every cited range is checked twice: structurally against the evidence ledger
 * (was this range actually shown, in this attempt, for this file), and
 * deterministically against the commit object (does re-reading it now produce
 * the same blob and the same bytes). A verdict that asserts absence is checked
 * against the search coverage ledger instead.
 */

import type { RepositoryName } from '../../git/repositories.js'
import { hashContent } from './git-object-reader.js'
import type { EvidenceClaim, EvidenceLedger, EvidenceReceipt } from './evidence-ledger.js'
import type { CoveragePolicy, SearchCoverageLedger } from './search-coverage-ledger.js'
import type { SnapshotStore } from './snapshot-store.js'

export type ReviewVerdict = 'IMPLEMENTED' | 'PARTIAL' | 'NOT_IMPLEMENTED' | 'UNCERTAIN'

export const EXISTING_IMPLEMENTATION_EVIDENCE = '现有实现'

export interface ReviewSubmission {
  verdict: ReviewVerdict
  confidence: number
  summary: string
  implementedContent?: string | null
  missingContent?: string | null
  risks?: string | null
  testPoints?: string | null
  aiRemark?: string | null
  evidence: Array<EvidenceClaim & { evidenceType: string; description: string }>
}

export interface VerifiedEvidence {
  /** The receipt id this claim cited, kept for audit and idempotency. */
  evidenceId: string
  repository: RepositoryName
  commitSha: string
  filePath: string
  blobSha: string
  startLine: number
  endLine: number
  evidenceType: string
  description: string
  contentHash: string
}

export type VerificationResult =
  | { ok: true; evidence: VerifiedEvidence[] }
  | { ok: false; code: string; reason: string }

export interface VerifyOptions {
  submission: ReviewSubmission
  evidenceLedger: EvidenceLedger
  coverageLedger: SearchCoverageLedger
  snapshots: SnapshotStore
  coveragePolicy: CoveragePolicy
}

const VERDICTS: readonly ReviewVerdict[] = [
  'IMPLEMENTED',
  'PARTIAL',
  'NOT_IMPLEMENTED',
  'UNCERTAIN',
]

/**
 * Validate one submission completely. The returned reason is written for the
 * model: it must say what was wrong and what to do next.
 */
export async function verifyReviewSubmission(
  options: VerifyOptions,
): Promise<VerificationResult> {
  const { submission } = options

  if (!VERDICTS.includes(submission.verdict)) {
    return {
      ok: false,
      code: 'VERDICT_INVALID',
      reason: `verdict must be one of ${VERDICTS.join(', ')}`,
    }
  }
  if (
    !Number.isInteger(submission.confidence) ||
    submission.confidence < 0 ||
    submission.confidence > 100
  ) {
    return {
      ok: false,
      code: 'CONFIDENCE_INVALID',
      reason: 'confidence must be an integer between 0 and 100',
    }
  }
  if (typeof submission.summary !== 'string' || submission.summary.trim().length === 0) {
    return { ok: false, code: 'SUMMARY_MISSING', reason: 'summary must be a non-empty string' }
  }
  if (!Array.isArray(submission.evidence)) {
    return { ok: false, code: 'EVIDENCE_MISSING', reason: 'evidence must be an array' }
  }

  const verified: VerifiedEvidence[] = []
  for (const [index, claim] of submission.evidence.entries()) {
    const structural = options.evidenceLedger.check(claim)
    if (!structural.ok) {
      return {
        ok: false,
        code: structural.rejection.code,
        reason: `evidence[${index}]: ${structural.rejection.reason}`,
      }
    }
    const receipt: EvidenceReceipt = structural.receipt

    // Deterministic half: re-read the cited range from the same commit object.
    const reread = await options.snapshots.reread({
      repository: receipt.repository,
      path: receipt.filePath,
      startLine: claim.startLine,
      endLine: claim.endLine,
    })
    if (!reread) {
      return {
        ok: false,
        code: 'EVIDENCE_UNREADABLE',
        reason: `evidence[${index}]: ${receipt.filePath} could not be re-read at the pinned commit`,
      }
    }
    if (reread.blobSha !== receipt.blobSha) {
      return {
        ok: false,
        code: 'EVIDENCE_BLOB_CHANGED',
        reason: `evidence[${index}]: ${receipt.filePath} no longer resolves to the blob that was shown`,
      }
    }
    if (reread.commitSha !== receipt.commitSha) {
      return {
        ok: false,
        code: 'EVIDENCE_COMMIT_CHANGED',
        reason: `evidence[${index}]: ${receipt.filePath} was shown at a different commit`,
      }
    }
    if (hashContent(reread.content) !== reread.contentHash) {
      return {
        ok: false,
        code: 'EVIDENCE_HASH_UNSTABLE',
        reason: `evidence[${index}]: content hash for ${receipt.filePath} is not reproducible`,
      }
    }

    verified.push({
      evidenceId: receipt.evidenceId,
      repository: receipt.repository,
      commitSha: receipt.commitSha,
      filePath: receipt.filePath,
      blobSha: receipt.blobSha,
      startLine: reread.startLine,
      endLine: reread.endLine,
      evidenceType: claim.evidenceType,
      description: claim.description,
      contentHash: reread.contentHash,
    })
  }

  if (submission.verdict === 'IMPLEMENTED' || submission.verdict === 'PARTIAL') {
    const hasImplementation = verified.some(
      (item) => item.evidenceType === EXISTING_IMPLEMENTATION_EVIDENCE,
    )
    if (!hasImplementation) {
      return {
        ok: false,
        code: 'EVIDENCE_IMPLEMENTATION_REQUIRED',
        reason: `${submission.verdict} requires at least one evidence item of type "${EXISTING_IMPLEMENTATION_EVIDENCE}" pointing at the code that implements the story`,
      }
    }
  }

  if (submission.verdict === 'NOT_IMPLEMENTED') {
    const coverage = options.coverageLedger.evaluate(options.coveragePolicy)
    if (!coverage.sufficient) {
      return {
        ok: false,
        code: 'COVERAGE_INSUFFICIENT',
        reason: coverage.reason ?? 'search coverage is insufficient to claim absence',
      }
    }
  }

  return { ok: true, evidence: verified }
}
