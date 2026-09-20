import { createHash } from 'node:crypto'
import { stableJson } from './attribution-rule-schema.js'

export const COMMIT_RELEVANCE_SCHEMA_VERSION = 1 as const
export const COMMIT_RELEVANCE_VERDICTS = ['RELATED', 'UNRELATED', 'UNCERTAIN'] as const
export const COMMIT_RELEVANCE_REASON_CODES = [
  'CODE_SEMANTIC_MATCH',
  'MODULE_MATCH',
  'CALL_CHAIN_MATCH',
  'TEST_CHANGE_MATCH',
  'CONFIG_SCHEMA_MATCH',
  'DIFFERENT_FEATURE',
  'INSUFFICIENT_CONTEXT',
  'DIFF_UNAVAILABLE',
  'REVERT_OR_REPLACEMENT_UNCLEAR',
] as const
export const COMMIT_DIFF_STATUSES = ['AVAILABLE', 'UNAVAILABLE', 'BINARY', 'DIFF_TOO_LARGE'] as const
export const ANALYSIS_SCOPE_LEVELS = ['RELATED', 'GLOBAL'] as const
export const ANALYSIS_EXPANSION_REASON_CODES = [
  'DEPENDENCY_LOOKUP',
  'CALLER_CALLEE_TRACE',
  'CONFIG_OR_SCHEMA_TRACE',
  'TEST_COVERAGE_TRACE',
  'CANDIDATES_INSUFFICIENT',
  'CROSS_REPOSITORY_CONTRACT',
  'VERIFY_REVERT_OR_REPLACEMENT',
] as const

export type CommitRelevanceVerdict = (typeof COMMIT_RELEVANCE_VERDICTS)[number]
export type CommitRelevanceReasonCode = (typeof COMMIT_RELEVANCE_REASON_CODES)[number]
export type CommitDiffStatus = (typeof COMMIT_DIFF_STATUSES)[number]
export type AnalysisScopeLevel = (typeof ANALYSIS_SCOPE_LEVELS)[number]
export type AnalysisExpansionReasonCode = (typeof ANALYSIS_EXPANSION_REASON_CODES)[number]

export interface CommitRelevanceEnvelope {
  schemaVersion: 1
  phase: 'COMMIT_RELEVANCE_TRIAGE'
  taskId: string
  story: {
    code: string
    name: string
    allowedContext: string
  }
  scope: {
    generation: number
    candidateManifestHash: string
    rulesetHash: string
    requiredCandidateIds: readonly string[]
  }
  candidate: {
    candidateId: string
    repository: string
    shortSha: string
    subject: string
    reasonCodes: readonly string[]
    diffStatus: CommitDiffStatus
  }
}

export interface CommitRelevanceOutput {
  schemaVersion: 1
  candidateId: string
  verdict: CommitRelevanceVerdict
  reasonCodes: readonly CommitRelevanceReasonCode[]
  confidence: number
  diffAccessIds: readonly string[]
  summary: string
  requestedExpansion: null | {
    targetLevel: AnalysisScopeLevel
    reasonCode: AnalysisExpansionReasonCode
  }
}

export interface CommitDiffAccessFact {
  accessId: string
  taskId: string
  candidateId: string
  attemptId: string
  succeeded: boolean
}

export interface ValidatedCommitRelevanceVerdict {
  envelope: CommitRelevanceEnvelope
  output: CommitRelevanceOutput
  payloadHash: string
}

export interface TriageCompletion {
  complete: boolean
  requiredCount: number
  completedCount: number
  missingCandidateIds: readonly string[]
  duplicateCandidateIds: readonly string[]
  unexpectedCandidateIds: readonly string[]
}

export class CommitRelevanceContractError extends Error {
  readonly code: string
  readonly issues: readonly string[]

  constructor(code: string, issues: readonly string[]) {
    super(`${code}: ${issues.join('; ')}`)
    this.name = 'CommitRelevanceContractError'
    this.code = code
    this.issues = issues
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const HASH_PATTERN = /^(?:sha256:)?[0-9a-f]{64}$/
const SHORT_SHA_PATTERN = /^[0-9a-f]{7,40}$/
const REPOSITORY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const STORY_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const REASON_PATTERN = /^[A-Z][A-Z0-9_]{1,96}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const sortedExpected = [...expected].sort()
  return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index])
}

function enumValue<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && values.some((candidate) => candidate === value)
}

function stringArray(value: unknown, predicate: (item: string) => boolean, max = 200): value is string[] {
  return Array.isArray(value) && value.length <= max && value.every((item) => typeof item === 'string' && predicate(item))
}

function requireUuid(value: unknown, path: string, issues: string[]): value is string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    issues.push(`${path} must be a UUID`)
    return false
  }
  return true
}

export function parseCommitRelevanceEnvelope(value: unknown): CommitRelevanceEnvelope {
  const issues: string[] = []
  if (!isRecord(value) || !exactKeys(value, ['schemaVersion', 'phase', 'taskId', 'story', 'scope', 'candidate'])) {
    throw new CommitRelevanceContractError('TRIAGE_INPUT_INVALID', ['input envelope has missing or unknown fields'])
  }
  if (value.schemaVersion !== 1) issues.push('schemaVersion must be 1')
  if (value.phase !== 'COMMIT_RELEVANCE_TRIAGE') issues.push('phase must be COMMIT_RELEVANCE_TRIAGE')
  requireUuid(value.taskId, 'taskId', issues)

  const story = value.story
  if (!isRecord(story) || !exactKeys(story, ['code', 'name', 'allowedContext'])) {
    issues.push('story has missing or unknown fields')
  } else {
    if (typeof story.code !== 'string' || !STORY_CODE_PATTERN.test(story.code)) issues.push('story.code is invalid')
    if (typeof story.name !== 'string' || story.name.length < 1 || story.name.length > 300) issues.push('story.name is invalid')
    if (typeof story.allowedContext !== 'string' || story.allowedContext.length > 20_000) issues.push('story.allowedContext is invalid')
  }

  const scope = value.scope
  if (!isRecord(scope) || !exactKeys(scope, ['generation', 'candidateManifestHash', 'rulesetHash', 'requiredCandidateIds'])) {
    issues.push('scope has missing or unknown fields')
  } else {
    if (!Number.isSafeInteger(scope.generation) || (scope.generation as number) < 1) issues.push('scope.generation must be positive')
    if (typeof scope.candidateManifestHash !== 'string' || !HASH_PATTERN.test(scope.candidateManifestHash)) issues.push('scope.candidateManifestHash is invalid')
    if (typeof scope.rulesetHash !== 'string' || !HASH_PATTERN.test(scope.rulesetHash)) issues.push('scope.rulesetHash is invalid')
    if (!stringArray(scope.requiredCandidateIds, (item) => UUID_PATTERN.test(item)) || scope.requiredCandidateIds.length === 0) {
      issues.push('scope.requiredCandidateIds must contain UUIDs')
    } else if (new Set(scope.requiredCandidateIds).size !== scope.requiredCandidateIds.length) {
      issues.push('scope.requiredCandidateIds contains duplicates')
    }
  }

  const candidate = value.candidate
  if (!isRecord(candidate) || !exactKeys(candidate, ['candidateId', 'repository', 'shortSha', 'subject', 'reasonCodes', 'diffStatus'])) {
    issues.push('candidate has missing or unknown fields')
  } else {
    requireUuid(candidate.candidateId, 'candidate.candidateId', issues)
    if (typeof candidate.repository !== 'string' || !REPOSITORY_PATTERN.test(candidate.repository)) issues.push('candidate.repository is invalid')
    if (typeof candidate.shortSha !== 'string' || !SHORT_SHA_PATTERN.test(candidate.shortSha)) issues.push('candidate.shortSha is invalid')
    if (typeof candidate.subject !== 'string' || candidate.subject.length > 500) issues.push('candidate.subject is invalid')
    if (!stringArray(candidate.reasonCodes, (item) => REASON_PATTERN.test(item), 64)) issues.push('candidate.reasonCodes is invalid')
    if (!enumValue(COMMIT_DIFF_STATUSES, candidate.diffStatus)) issues.push('candidate.diffStatus is invalid')
  }

  if (isRecord(scope) && isRecord(candidate) && typeof candidate.candidateId === 'string' && Array.isArray(scope.requiredCandidateIds) && !scope.requiredCandidateIds.includes(candidate.candidateId)) {
    issues.push('candidate.candidateId is not in requiredCandidateIds')
  }
  if (issues.length > 0) throw new CommitRelevanceContractError('TRIAGE_INPUT_INVALID', issues)
  return value as unknown as CommitRelevanceEnvelope
}

export function parseCommitRelevanceOutput(value: unknown): CommitRelevanceOutput {
  const issues: string[] = []
  if (!isRecord(value) || !exactKeys(value, ['schemaVersion', 'candidateId', 'verdict', 'reasonCodes', 'confidence', 'diffAccessIds', 'summary', 'requestedExpansion'])) {
    throw new CommitRelevanceContractError('TRIAGE_OUTPUT_INVALID', ['output has missing or unknown fields'])
  }
  if (value.schemaVersion !== 1) issues.push('schemaVersion must be 1')
  requireUuid(value.candidateId, 'candidateId', issues)
  if (!enumValue(COMMIT_RELEVANCE_VERDICTS, value.verdict)) issues.push('verdict is invalid')
  if (!stringArray(value.reasonCodes, (item) => enumValue(COMMIT_RELEVANCE_REASON_CODES, item), 16) || value.reasonCodes.length === 0) {
    issues.push('reasonCodes must contain allowed values')
  } else if (new Set(value.reasonCodes).size !== value.reasonCodes.length) {
    issues.push('reasonCodes contains duplicates')
  }
  if (typeof value.confidence !== 'number' || !Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1) issues.push('confidence must be from 0 to 1')
  if (!stringArray(value.diffAccessIds, (item) => UUID_PATTERN.test(item), 64)) issues.push('diffAccessIds must contain UUIDs')
  else if (new Set(value.diffAccessIds).size !== value.diffAccessIds.length) issues.push('diffAccessIds contains duplicates')
  if (typeof value.summary !== 'string' || [...value.summary].length > 500) issues.push('summary must be at most 500 characters')

  if (value.requestedExpansion !== null) {
    if (!isRecord(value.requestedExpansion) || !exactKeys(value.requestedExpansion, ['targetLevel', 'reasonCode'])) {
      issues.push('requestedExpansion is invalid')
    } else {
      if (!enumValue(ANALYSIS_SCOPE_LEVELS, value.requestedExpansion.targetLevel)) issues.push('requestedExpansion.targetLevel is invalid')
      if (!enumValue(ANALYSIS_EXPANSION_REASON_CODES, value.requestedExpansion.reasonCode)) issues.push('requestedExpansion.reasonCode is invalid')
    }
  }
  if (issues.length > 0) throw new CommitRelevanceContractError('TRIAGE_OUTPUT_INVALID', issues)
  return value as unknown as CommitRelevanceOutput
}

export function validateCommitRelevanceVerdict(input: {
  envelope: unknown
  output: unknown
  attemptId: string
  accessFacts: readonly CommitDiffAccessFact[]
}): ValidatedCommitRelevanceVerdict {
  const envelope = parseCommitRelevanceEnvelope(input.envelope)
  const output = parseCommitRelevanceOutput(input.output)
  const issues: string[] = []
  if (!UUID_PATTERN.test(input.attemptId)) issues.push('attemptId must be a UUID')
  if (output.candidateId !== envelope.candidate.candidateId) issues.push('candidateId does not match the Broker envelope')

  const factsById = new Map(input.accessFacts.map((fact) => [fact.accessId, fact]))
  for (const accessId of output.diffAccessIds) {
    const fact = factsById.get(accessId)
    if (fact === undefined || !fact.succeeded || fact.taskId !== envelope.taskId || fact.candidateId !== envelope.candidate.candidateId || fact.attemptId !== input.attemptId) {
      issues.push(`diffAccessId ${accessId} is not a successful access for this attempt and candidate`)
    }
  }

  const unavailable = envelope.candidate.diffStatus !== 'AVAILABLE'
  if (output.diffAccessIds.length === 0) {
    if (!unavailable) issues.push('an AVAILABLE diff requires a successful diff access')
    if (!output.reasonCodes.includes('DIFF_UNAVAILABLE')) issues.push('an empty diffAccessIds requires DIFF_UNAVAILABLE')
    if (output.verdict !== 'UNCERTAIN') issues.push('a verdict without readable diff must be UNCERTAIN')
  }
  if (unavailable) {
    if (!output.reasonCodes.includes('DIFF_UNAVAILABLE')) issues.push('an unavailable diff requires DIFF_UNAVAILABLE')
    if (output.verdict !== 'UNCERTAIN') issues.push('an unavailable diff verdict must be UNCERTAIN')
  }
  if (!unavailable && output.reasonCodes.includes('DIFF_UNAVAILABLE')) {
    issues.push('DIFF_UNAVAILABLE is invalid for an AVAILABLE diff')
  }
  if (issues.length > 0) throw new CommitRelevanceContractError('TRIAGE_VERDICT_REJECTED', issues)
  const canonical = stableJson(output)
  return {
    envelope,
    output,
    payloadHash: `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`,
  }
}

export function triageCompletion(requiredCandidateIds: readonly string[], outputs: readonly CommitRelevanceOutput[]): TriageCompletion {
  const required = new Set(requiredCandidateIds)
  const counts = new Map<string, number>()
  const unexpected = new Set<string>()
  for (const output of outputs) {
    counts.set(output.candidateId, (counts.get(output.candidateId) ?? 0) + 1)
    if (!required.has(output.candidateId)) unexpected.add(output.candidateId)
  }
  const missing = requiredCandidateIds.filter((id) => !counts.has(id))
  const duplicate = [...counts.entries()].filter(([, count]) => count > 1).map(([id]) => id).sort()
  const unexpectedCandidateIds = [...unexpected].sort()
  const completedCount = requiredCandidateIds.filter((id) => counts.get(id) === 1).length
  return {
    complete: missing.length === 0 && duplicate.length === 0 && unexpectedCandidateIds.length === 0,
    requiredCount: requiredCandidateIds.length,
    completedCount,
    missingCandidateIds: missing,
    duplicateCandidateIds: duplicate,
    unexpectedCandidateIds,
  }
}

export function assertTriageComplete(requiredCandidateIds: readonly string[], outputs: readonly CommitRelevanceOutput[]): TriageCompletion {
  const completion = triageCompletion(requiredCandidateIds, outputs)
  if (!completion.complete) {
    throw new CommitRelevanceContractError('TRIAGE_INCOMPLETE', [
      `completed ${completion.completedCount}/${completion.requiredCount}`,
      `missing=${completion.missingCandidateIds.join(',')}`,
      `duplicate=${completion.duplicateCandidateIds.join(',')}`,
      `unexpected=${completion.unexpectedCandidateIds.join(',')}`,
    ])
  }
  return completion
}
