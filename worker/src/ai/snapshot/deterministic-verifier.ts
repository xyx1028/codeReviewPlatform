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

/**
 * 允许的证据类型。
 *
 * 必须与数据库 `analysis_agent_evidence_evidence_type_check` 的取值集合逐字一致。
 * 之前 Worker 侧**完全不校验**这个字段，后果在本地全链路实测里很具体（2026-09-23，
 * Job `0d4a6a37`）：模型编了一个不在词表里的类型，deterministic verifier 放过，
 * 到 `save_agent_review_result` 才被数据库 CHECK 拒绝，模型收到的是
 *
 *   rpc save_agent_review_result failed: new row for relation "analysis_agent_evidence"
 *   violates check constraint "analysis_agent_evidence_evidence_type_check"
 *
 * 它既没有稳定错误码、也没说清"应该填什么"，模型只能靠猜重试，反复烧预算。
 */
export const ALLOWED_EVIDENCE_TYPES = ['现有实现', '缺失依据', '风险依据'] as const

export interface StructuredAnalysisDetailItems {
  implemented_content: string[]
  missing_content: string[]
  risks: string[]
  test_points: string[]
  ai_remark: string[]
}

export interface ReviewSubmission {
  acceptanceReview?: import('../review-workflow.js').AcceptanceReviewReport
  verdict: ReviewVerdict
  confidence: number
  summary: string
  implementedContent?: string | null
  missingContent?: string | null
  risks?: string | null
  testPoints?: string | null
  aiRemark?: string | null
  implementedItems?: unknown
  missingItems?: unknown
  riskItems?: unknown
  testPointItems?: unknown
  remarkItems?: unknown
  evidence: Array<EvidenceClaim & { evidenceType: string; evidenceSummary: string; description: string }>
}

const DETAIL_ITEM_LIMIT = 12
const DETAIL_ITEM_MAX_LENGTH = 500
const detailItemFields = [
  ['implementedItems', 'implemented_content'],
  ['missingItems', 'missing_content'],
  ['riskItems', 'risks'],
  ['testPointItems', 'test_points'],
  ['remarkItems', 'ai_remark'],
] as const

function validateStructuredDetailItems(submission: ReviewSubmission):
  | { ok: true; details: StructuredAnalysisDetailItems }
  | { ok: false; reason: string } {
  const details: StructuredAnalysisDetailItems = {
    implemented_content: [],
    missing_content: [],
    risks: [],
    test_points: [],
    ai_remark: [],
  }

  for (const [inputKey, storageKey] of detailItemFields) {
    const value = submission[inputKey]
    if (!Array.isArray(value) || value.length > DETAIL_ITEM_LIMIT) {
      return {
        ok: false,
        reason: `${inputKey} must be an array with at most ${DETAIL_ITEM_LIMIT} items`,
      }
    }

    const normalized: string[] = []
    for (const [index, raw] of value.entries()) {
      if (typeof raw !== 'string') {
        return { ok: false, reason: `${inputKey}[${index}] must be a string` }
      }
      const item = raw.trim()
      if (
        item.length === 0 ||
        item.length > DETAIL_ITEM_MAX_LENGTH ||
        item !== raw ||
        /[\r\n]/.test(item) ||
        /^\s*(?:[-*+•●▪◦]|[（(]?\d+[）).、]|[一二三四五六七八九十]+[、.)）])\s*/u.test(item)
      ) {
        return {
          ok: false,
          reason: `${inputKey}[${index}] must be a trimmed, single-line 1–${DETAIL_ITEM_MAX_LENGTH} character point without a list marker or number prefix`,
        }
      }
      if (normalized.includes(item)) {
        return { ok: false, reason: `${inputKey} must not contain duplicate items` }
      }
      normalized.push(item)
    }
    details[storageKey] = normalized
  }

  return { ok: true, details }
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
  evidenceSummary: string
  description: string
  contentHash: string
}

export type VerificationResult =
  | { ok: true; evidence: VerifiedEvidence[]; details: StructuredAnalysisDetailItems }
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
  const detailValidation = validateStructuredDetailItems(submission)
  if (!detailValidation.ok) {
    return {
      ok: false,
      code: 'ANALYSIS_DETAIL_ITEMS_INVALID',
      reason: detailValidation.reason,
    }
  }
  if (!Array.isArray(submission.evidence)) {
    return { ok: false, code: 'EVIDENCE_MISSING', reason: 'evidence must be an array' }
  }

  const verified: VerifiedEvidence[] = []
  for (const [index, claim] of submission.evidence.entries()) {
    // 类型先校验：数据库那条 CHECK 是最终边界，但把它留给数据库意味着模型收到的是一条
    // 原始约束违规文本，而不是"应该填这三个值之一"。
    if (!(ALLOWED_EVIDENCE_TYPES as readonly string[]).includes(claim.evidenceType)) {
      return {
        ok: false,
        code: 'EVIDENCE_TYPE_INVALID',
        reason: `evidence[${index}]: evidenceType must be one of ${ALLOWED_EVIDENCE_TYPES.join(' / ')}`,
      }
    }
    const evidenceSummary = typeof claim.evidenceSummary === 'string' ? claim.evidenceSummary.trim() : ''
    if (
      evidenceSummary.length < 8 ||
      evidenceSummary.length > 80 ||
      /[\r\n]/.test(evidenceSummary)
    ) {
      return {
        ok: false,
        code: 'EVIDENCE_SUMMARY_INVALID',
        reason: `evidence[${index}]: evidenceSummary must be a single-line 8–80 character statement of what this code proves`,
      }
    }
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
      evidenceSummary,
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

  return { ok: true, evidence: verified, details: detailValidation.details }
}
