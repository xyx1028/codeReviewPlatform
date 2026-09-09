/**
 * Strict schema and evidence validation for the two AI stages. (Plan §11.6, §12.3, §12.4)
 *
 * These validators do not trust model output. All structural checks are
 * enforced here. Commit SHAs are supplied by the Worker, never by the model.
 */

import { isBranchName, isRepositoryName, type RepositoryName } from '../git/repositories.js'

/** Full 40-hex SHA, optionally the 64-hex SHA-256 form. (Plan §7.4) */
export const SHA_REGEX = /^[0-9A-Fa-f]{40}([0-9A-Fa-f]{24})?$/

export const VERDICTS = [
  'IMPLEMENTED',
  'PARTIAL',
  'NOT_IMPLEMENTED',
  'UNCERTAIN',
] as const
export type Verdict = (typeof VERDICTS)[number]

export const EVIDENCE_TYPES = ['现有实现', '缺失依据', '风险依据'] as const
export type EvidenceType = (typeof EVIDENCE_TYPES)[number]

export interface RetrievalCandidate {
  repository: RepositoryName
  filePath: string
  startLine: number
  endLine: number
  symbolName?: string
  reason: string
}

export interface RetrievalResult {
  storyCode: string
  summary: string
  queries: Array<{ repository: RepositoryName; query: string; hitCount: number }>
  searchedRepositories: RepositoryName[]
  candidates: RetrievalCandidate[]
  insufficientEvidence: boolean
}

export interface AnalysisEvidence {
  repository: RepositoryName
  filePath: string
  symbolName?: string
  startLine: number
  endLine: number
  evidenceType: EvidenceType
  description: string
}

export interface AnalysisResult {
  storyCode: string
  verdict: Verdict
  confidence: number
  summary: string
  implementedContent: string | null
  missingContent: string | null
  risks: string | null
  testPoints: string | null
  aiRemark: string | null
  evidence: AnalysisEvidence[]
}

export class SchemaError extends Error {
  code: string
  constructor(message: string, code: string) {
    super(message)
    this.name = 'SchemaError'
    this.code = code
  }
}

export function isValidSha(value: unknown): value is string {
  return typeof value === 'string' && SHA_REGEX.test(value)
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0
}

function isPositiveInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1
}

function isNullableString(v: unknown): v is string | null {
  return v === null || typeof v === 'string'
}

/** Limits per plan §11.6. */
export const RETRIEVAL_LIMITS = {
  maxCandidates: 12,
  maxSnippetLines: 200,
  maxContextChars: 60000,
  maxToolCalls: 12,
} as const

/**
 * Canonical repository-relative path used at every AI stage.
 * Leading "./" and Windows separators are normalized, while absolute paths,
 * traversal, empty segments and null bytes remain invalid.
 */
export function normalizeRepositoryPath(value: string, code: string): string {
  const posix = value.replace(/\\/g, '/')
  if (posix.includes('\0') || posix.startsWith('/')) {
    throw new SchemaError(`invalid repository-relative path: ${value}`, code)
  }

  const withoutPrefix = posix.replace(/^(?:\.\/)+/, '')
  const segments = withoutPrefix.split('/')
  if (
    segments.length === 0 ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new SchemaError(`invalid repository-relative path: ${value}`, code)
  }
  return segments.join('/')
}

/**
 * Validate stage-one (retrieval) model output against the strict schema.
 * @param expectedStoryCode the story code the task is for; storyCode must match.
 * @throws SchemaError(RETRIEVAL_SCHEMA_INVALID)
 */
export function validateRetrievalResult(
  raw: unknown,
  expectedStoryCode: string,
): RetrievalResult {
  const code = 'RETRIEVAL_SCHEMA_INVALID'
  if (!isPlainObject(raw)) {
    throw new SchemaError('retrieval result is not an object', code)
  }
  if (!isNonEmptyString(raw.storyCode)) {
    throw new SchemaError('retrieval.storyCode missing', code)
  }
  if (raw.storyCode !== expectedStoryCode) {
    throw new SchemaError(
      `retrieval.storyCode mismatch: expected ${expectedStoryCode}`,
      code,
    )
  }
  if (typeof raw.summary !== 'string') {
    throw new SchemaError('retrieval.summary must be a string', code)
  }
  if (typeof raw.insufficientEvidence !== 'boolean') {
    throw new SchemaError('retrieval.insufficientEvidence must be boolean', code)
  }
  if (!Array.isArray(raw.queries)) {
    throw new SchemaError('retrieval.queries must be an array', code)
  }
  const queries = raw.queries.map((q, i) => {
    if (!isPlainObject(q)) throw new SchemaError(`queries[${i}] not object`, code)
    if (!isRepositoryName(q.repository)) {
      throw new SchemaError(`queries[${i}].repository invalid`, code)
    }
    if (typeof q.query !== 'string') {
      throw new SchemaError(`queries[${i}].query invalid`, code)
    }
    if (typeof q.hitCount !== 'number' || !Number.isInteger(q.hitCount) || q.hitCount < 0) {
      throw new SchemaError(`queries[${i}].hitCount invalid`, code)
    }
    return { repository: q.repository, query: q.query, hitCount: q.hitCount }
  })

  if (!Array.isArray(raw.searchedRepositories)) {
    throw new SchemaError('retrieval.searchedRepositories must be an array', code)
  }
  const searchedRepositories = raw.searchedRepositories.map((r, i) => {
    if (!isRepositoryName(r)) {
      throw new SchemaError(`searchedRepositories[${i}] invalid`, code)
    }
    return r
  })

  if (!Array.isArray(raw.candidates)) {
    throw new SchemaError('retrieval.candidates must be an array', code)
  }
  if (raw.candidates.length > RETRIEVAL_LIMITS.maxCandidates) {
    throw new SchemaError(
      `retrieval.candidates exceeds limit ${RETRIEVAL_LIMITS.maxCandidates}`,
      code,
    )
  }
  const candidates = raw.candidates.map((c, i) =>
    validateCandidate(c, i, code),
  )

  return {
    storyCode: raw.storyCode,
    summary: raw.summary,
    queries,
    searchedRepositories,
    candidates,
    insufficientEvidence: raw.insufficientEvidence,
  }
}

function validateCandidate(
  c: unknown,
  i: number,
  code: string,
): RetrievalCandidate {
  if (!isPlainObject(c)) throw new SchemaError(`candidates[${i}] not object`, code)
  if (!isRepositoryName(c.repository)) {
    throw new SchemaError(`candidates[${i}].repository invalid`, code)
  }
  if (!isNonEmptyString(c.filePath)) {
    throw new SchemaError(`candidates[${i}].filePath invalid`, code)
  }
  if (!isPositiveInt(c.startLine)) {
    throw new SchemaError(`candidates[${i}].startLine invalid`, code)
  }
  if (!isPositiveInt(c.endLine)) {
    throw new SchemaError(`candidates[${i}].endLine invalid`, code)
  }
  if (c.endLine < c.startLine) {
    throw new SchemaError(`candidates[${i}] endLine < startLine`, code)
  }
  if (c.endLine - c.startLine + 1 > RETRIEVAL_LIMITS.maxSnippetLines) {
    throw new SchemaError(
      `candidates[${i}] exceeds ${RETRIEVAL_LIMITS.maxSnippetLines} lines`,
      code,
    )
  }
  if (typeof c.reason !== 'string') {
    throw new SchemaError(`candidates[${i}].reason invalid`, code)
  }
  const out: RetrievalCandidate = {
    repository: c.repository,
    filePath: normalizeRepositoryPath(c.filePath, code),
    startLine: c.startLine,
    endLine: c.endLine,
    reason: c.reason,
  }
  if (c.symbolName !== undefined) {
    if (typeof c.symbolName !== 'string') {
      throw new SchemaError(`candidates[${i}].symbolName invalid`, code)
    }
    out.symbolName = c.symbolName
  }
  return out
}

/**
 * Validate stage-two (analysis) model output structure. (Plan §12.3, §12.4)
 * Evidence cross-checks against retrieval candidates and file contents are done
 * separately by validateEvidence.
 * @throws SchemaError(ANALYSIS_SCHEMA_INVALID)
 */
export function validateAnalysisResult(
  raw: unknown,
  expectedStoryCode: string,
): AnalysisResult {
  const code = 'ANALYSIS_SCHEMA_INVALID'
  if (!isPlainObject(raw)) {
    throw new SchemaError('analysis result is not an object', code)
  }
  if (raw.storyCode !== expectedStoryCode) {
    throw new SchemaError(
      `analysis.storyCode mismatch: expected ${expectedStoryCode}`,
      code,
    )
  }
  if (typeof raw.verdict !== 'string' || !VERDICTS.includes(raw.verdict as Verdict)) {
    throw new SchemaError('analysis.verdict not in enum', code)
  }
  if (
    typeof raw.confidence !== 'number' ||
    !Number.isInteger(raw.confidence) ||
    raw.confidence < 0 ||
    raw.confidence > 100
  ) {
    throw new SchemaError('analysis.confidence must be integer 0..100', code)
  }
  if (typeof raw.summary !== 'string') {
    throw new SchemaError('analysis.summary must be string', code)
  }
  for (const key of ['implementedContent', 'missingContent', 'risks', 'testPoints', 'aiRemark'] as const) {
    if (!isNullableString(raw[key])) {
      throw new SchemaError(`analysis.${key} must be string or null`, code)
    }
  }
  if (!Array.isArray(raw.evidence)) {
    throw new SchemaError('analysis.evidence must be an array', code)
  }
  const verdict = raw.verdict as Verdict
  const evidence = raw.evidence.map((e, i) => validateEvidenceShape(e, i, code))

  // IMPLEMENTED / PARTIAL require at least one "现有实现" evidence. (Plan §12.4)
  if (verdict === 'IMPLEMENTED' || verdict === 'PARTIAL') {
    const hasImpl = evidence.some((e) => e.evidenceType === '现有实现')
    if (!hasImpl) {
      throw new SchemaError(
        `verdict ${verdict} requires at least one 现有实现 evidence`,
        code,
      )
    }
  }

  return {
    storyCode: raw.storyCode as string,
    verdict,
    confidence: raw.confidence,
    summary: raw.summary,
    implementedContent: raw.implementedContent as string | null,
    missingContent: raw.missingContent as string | null,
    risks: raw.risks as string | null,
    testPoints: raw.testPoints as string | null,
    aiRemark: raw.aiRemark as string | null,
    evidence,
  }
}

function validateEvidenceShape(
  e: unknown,
  i: number,
  code: string,
): AnalysisEvidence {
  if (!isPlainObject(e)) throw new SchemaError(`evidence[${i}] not object`, code)
  if (!isRepositoryName(e.repository)) {
    throw new SchemaError(`evidence[${i}].repository invalid`, code)
  }
  if (!isNonEmptyString(e.filePath)) {
    throw new SchemaError(`evidence[${i}].filePath invalid`, code)
  }
  if (!isPositiveInt(e.startLine)) {
    throw new SchemaError(`evidence[${i}].startLine invalid`, code)
  }
  if (!isPositiveInt(e.endLine)) {
    throw new SchemaError(`evidence[${i}].endLine invalid`, code)
  }
  if (e.endLine < e.startLine) {
    throw new SchemaError(`evidence[${i}] endLine < startLine`, code)
  }
  if (
    typeof e.evidenceType !== 'string' ||
    !EVIDENCE_TYPES.includes(e.evidenceType as EvidenceType)
  ) {
    throw new SchemaError(`evidence[${i}].evidenceType not in enum`, code)
  }
  if (typeof e.description !== 'string') {
    throw new SchemaError(`evidence[${i}].description invalid`, code)
  }
  const out: AnalysisEvidence = {
    repository: e.repository,
    filePath: normalizeRepositoryPath(e.filePath, code),
    startLine: e.startLine,
    endLine: e.endLine,
    evidenceType: e.evidenceType as EvidenceType,
    description: e.description,
  }
  if (e.symbolName !== undefined) {
    if (typeof e.symbolName !== 'string') {
      throw new SchemaError(`evidence[${i}].symbolName invalid`, code)
    }
    out.symbolName = e.symbolName
  }
  return out
}

export interface AllowedEvidenceRange {
  repository: RepositoryName
  filePath: string
  startLine: number
  endLine: number
}

/**
 * Restrict model evidence to code ranges that were actually frozen and sent to
 * stage two. This validator is pure so the harness can include failures in its
 * single repair round before the pipeline performs final filesystem checks.
 */
export function validateEvidenceAgainstAllowedRanges(
  analysis: AnalysisResult,
  allowedRanges: AllowedEvidenceRange[],
): void {
  const rangesByFile = new Map<string, AllowedEvidenceRange[]>()
  for (const range of allowedRanges) {
    const filePath = normalizeRepositoryPath(range.filePath, 'EVIDENCE_PATH_INVALID')
    const key = `${range.repository}::${filePath}`
    const ranges = rangesByFile.get(key) ?? []
    ranges.push({ ...range, filePath })
    rangesByFile.set(key, ranges)
  }

  for (const [i, evidence] of analysis.evidence.entries()) {
    const key = `${evidence.repository}::${evidence.filePath}`
    const ranges = rangesByFile.get(key)
    if (!ranges?.length) {
      throw new SchemaError(
        `evidence[${i}] file is not in the allowed evidence list: ${key}`,
        'EVIDENCE_PATH_INVALID',
      )
    }
    if (!ranges.some((range) =>
      evidence.startLine >= range.startLine && evidence.endLine <= range.endLine
    )) {
      const allowed = ranges
        .map((range) => `${range.startLine}-${range.endLine}`)
        .join(', ')
      throw new SchemaError(
        `evidence[${i}] line range ${evidence.startLine}-${evidence.endLine} is outside allowed ranges ${allowed} for ${key}`,
        'EVIDENCE_LINE_INVALID',
      )
    }
  }
}

export interface SnapshotRef {
  repository: RepositoryName
  commitSha: string
  branch?: string
}

export interface FileLineProvider {
  /** Return total number of lines in the file, or null if the file is absent. */
  countLines(repository: RepositoryName, filePath: string): number | null
}

/**
 * Cross-validate analysis evidence against stage-one candidates, repository
 * snapshots, and actual file line counts. (Plan §12.4)
 *
 * Rules:
 *  - Every evidence file must come from a stage-one candidate file. (same repo+path)
 *  - The evidence repository must have a snapshot with a valid SHA.
 *  - Line numbers must lie within the file's real line count.
 *  - Files must exist in the snapshot working tree.
 *
 * @throws SchemaError with EVIDENCE_PATH_INVALID or EVIDENCE_LINE_INVALID.
 */
export function validateEvidence(
  analysis: AnalysisResult,
  retrieval: RetrievalResult,
  snapshots: SnapshotRef[],
  files: FileLineProvider,
): void {
  const candidateSet = new Set(
    retrieval.candidates.map((c) => `${c.repository}::${c.filePath}`),
  )
  const snapshotMap = new Map<RepositoryName, SnapshotRef>()
  for (const s of snapshots) {
    if (!isValidSha(s.commitSha)) {
      throw new SchemaError(
        `snapshot for ${s.repository} has invalid SHA`,
        'GIT_SHA_MISMATCH',
      )
    }
    snapshotMap.set(s.repository, s)
  }

  for (const [i, e] of analysis.evidence.entries()) {
    const key = `${e.repository}::${e.filePath}`
    if (!candidateSet.has(key)) {
      throw new SchemaError(
        `evidence[${i}] file not among stage-one candidates: ${key}`,
        'EVIDENCE_PATH_INVALID',
      )
    }
    if (!snapshotMap.has(e.repository)) {
      throw new SchemaError(
        `evidence[${i}] repository has no snapshot: ${e.repository}`,
        'EVIDENCE_PATH_INVALID',
      )
    }
    const lineCount = files.countLines(e.repository, e.filePath)
    if (lineCount === null) {
      throw new SchemaError(
        `evidence[${i}] file not found in snapshot: ${key}`,
        'EVIDENCE_PATH_INVALID',
      )
    }
    if (e.startLine < 1 || e.endLine > lineCount) {
      throw new SchemaError(
        `evidence[${i}] line range ${e.startLine}-${e.endLine} outside file (1-${lineCount})`,
        'EVIDENCE_LINE_INVALID',
      )
    }
  }
}

/** Validate the baseline commit structure written to ai_import_record. (Plan §6.4) */
export function validateBaselineCommits(
  branch: string,
  commits: Array<{ repository: string; sha: string; subject?: string }>,
): void {
  if (!isBranchName(branch)) {
    throw new SchemaError(`baseline actual_branch invalid: ${branch}`, 'BATCH_BRANCH_CHANGED')
  }
  for (const c of commits) {
    if (!isRepositoryName(c.repository)) {
      throw new SchemaError(`baseline repository invalid: ${c.repository}`, 'EVIDENCE_PATH_INVALID')
    }
    if (!isValidSha(c.sha)) {
      throw new SchemaError(`baseline sha invalid for ${c.repository}`, 'GIT_SHA_MISMATCH')
    }
  }
}
