import { createHash } from 'node:crypto'
import { stableJson } from './attribution-rule-schema.js'

export const STORY_TOKEN_PARSER_VERSION = 'story-token-v1' as const
export const ATTRIBUTION_ALGORITHM_VERSION = 'story-attribution-v2' as const

export type StoryTokenLocation = 'STRUCTURED_COMMIT' | 'SUBJECT' | 'BODY' | 'SOURCE_BRANCH' | 'STRUCTURED_MR'
export type AttributionDecision = 'AUTO_SELECTED_EXPLICIT' | 'AUTO_SELECTED_STRONG' | 'AI_RELEVANCE_REQUIRED' | 'WEAK_FALLBACK' | 'CONFLICT' | 'EXCLUDED' | 'GLOBAL_FALLBACK'
export type ScopeRecommendation = 'EXACT_STORY_COMMITS' | 'HYBRID_CANDIDATES' | 'DEVELOPER_WINDOW' | 'REQUIREMENT_REF_ONLY' | 'GLOBAL_FALLBACK'
export type EffectiveStatus = 'EFFECTIVE' | 'REVERTED' | 'PARTIAL' | 'UNKNOWN'
export type IdentityMatchStatus = 'VERIFIED' | 'WEAK_NAME' | 'UNRESOLVED' | 'AMBIGUOUS'
export type RangeCompleteness = 'COMPLETE' | 'SHALLOW_INCOMPLETE' | 'RANGE_TOO_LARGE' | 'BASE_UNREACHABLE' | 'BASELINE_REQUIRED' | 'OBJECT_MISSING' | 'MANIFEST_MISMATCH'
export type RevertEffect = 'NONE' | 'FULL' | 'PARTIAL' | 'UNKNOWN'

export interface StoryTokenMatch {
  normalizedCode: string
  location: StoryTokenLocation
  start: number
  end: number
  structured: boolean
}

export interface ParsedStoryTokens {
  parserVersion: typeof STORY_TOKEN_PARSER_VERSION
  matches: readonly StoryTokenMatch[]
}

export interface StoryCommitAttributionInput {
  candidateId: string
  repository: string
  sha: string
  currentStoryCode: string
  batchStoryCodes: readonly string[]
  subject: string
  body: string
  sourceBranch?: string | null
  mrStructuredText?: string | null
  reachableFromFrozenHead: boolean
  rangeCompleteness: RangeCompleteness
  identityStatus: IdentityMatchStatus
  withinFrozenWindow: boolean
  moduleOverlap: boolean
  sameExplicitMr: boolean
  sharedStoryRelationship?: boolean
  bot: boolean
  generated: boolean
  revertEffect: RevertEffect
  revertsRelatedCommit: boolean
  strongSignalConflict?: boolean
  ruleConflict?: boolean
}

export interface StoryCommitAttributionResult {
  candidateId: string
  repository: string
  sha: string
  decision: AttributionDecision
  scopeRecommendation: ScopeRecommendation
  effectiveStatus: EffectiveStatus
  selected: boolean
  rankScore: number
  reasonCodes: readonly string[]
  storyMatches: readonly StoryTokenMatch[]
  parserVersion: typeof STORY_TOKEN_PARSER_VERSION
  algorithmVersion: typeof ATTRIBUTION_ALGORITHM_VERSION
}

export interface StoryCandidateManifest {
  schemaVersion: 1
  algorithmVersion: typeof ATTRIBUTION_ALGORITHM_VERSION
  storyCode: string
  generation: number
  candidates: readonly StoryCommitAttributionResult[]
  manifestHash: string
}

export class StoryAttributionError extends Error {
  readonly code: 'STORY_ATTRIBUTION_INVALID'

  constructor(message: string) {
    super(message)
    this.name = 'StoryAttributionError'
    this.code = 'STORY_ATTRIBUTION_INVALID'
  }
}

const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/
const STORY_CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{0,127}$/
const STRUCTURED_LINE_PATTERN = /^\s*Story-Id\s*:\s*(.*?)\s*$/i

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

export function normalizeStoryCode(code: string): string {
  const normalized = code.trim().toUpperCase()
  if (!STORY_CODE_PATTERN.test(normalized)) throw new StoryAttributionError(`invalid story code: ${code}`)
  return normalized
}

function isTokenContinuation(character: string | undefined): boolean {
  return character !== undefined && /[\p{L}\p{N}_-]/u.test(character)
}

function literalMatches(text: string, normalizedCode: string): Array<{ start: number; end: number }> {
  const haystack = text.toUpperCase()
  const matches: Array<{ start: number; end: number }> = []
  let from = 0
  while (from <= haystack.length - normalizedCode.length) {
    const start = haystack.indexOf(normalizedCode, from)
    if (start < 0) break
    const end = start + normalizedCode.length
    if (!isTokenContinuation(text[start - 1]) && !isTokenContinuation(text[end])) matches.push({ start, end })
    from = start + Math.max(1, normalizedCode.length)
  }
  return matches
}

function canonicalCodes(codes: readonly string[]): string[] {
  return [...new Set(codes.map(normalizeStoryCode))].sort((left, right) => right.length - left.length || compareText(left, right))
}

export function matchStoryTokens(text: string, storyCodes: readonly string[], location: StoryTokenLocation, structured = false): StoryTokenMatch[] {
  const matches: StoryTokenMatch[] = []
  for (const code of canonicalCodes(storyCodes)) {
    for (const match of literalMatches(text, code)) {
      matches.push({ normalizedCode: code, location, start: match.start, end: match.end, structured })
    }
  }
  return matches.sort((left, right) => left.start - right.start || right.normalizedCode.length - left.normalizedCode.length || compareText(left.normalizedCode, right.normalizedCode))
}

/** Extract independent Story-Id lines; ordinary body references are deliberately not promoted. */
export function parseStructuredStoryIds(message: string, storyCodes: readonly string[], location: 'STRUCTURED_COMMIT' | 'STRUCTURED_MR' = 'STRUCTURED_COMMIT'): StoryTokenMatch[] {
  const matches: StoryTokenMatch[] = []
  let offset = 0
  for (const line of message.split(/\r?\n/)) {
    const parsed = STRUCTURED_LINE_PATTERN.exec(line)
    if (parsed !== null) {
      const captured = parsed[1] ?? ''
      const normalizedValue = captured.trim().toUpperCase()
      const matchedCode = canonicalCodes(storyCodes).find((code) => code === normalizedValue)
      if (matchedCode !== undefined) {
        const valueOffset = line.toUpperCase().indexOf(matchedCode)
        matches.push({
          normalizedCode: matchedCode,
          location,
          start: offset + valueOffset,
          end: offset + valueOffset + matchedCode.length,
          structured: true,
        })
      }
    }
    offset += line.length + 1
  }
  return matches
}

export function parseCommitStoryTokens(input: {
  subject: string
  body: string
  sourceBranch?: string | null
  mrStructuredText?: string | null
  storyCodes: readonly string[]
}): ParsedStoryTokens {
  const structuredCommit = parseStructuredStoryIds(`${input.subject}\n${input.body}`, input.storyCodes)
  const structuredSubject = parseStructuredStoryIds(input.subject, input.storyCodes)
  const structuredBody = parseStructuredStoryIds(input.body, input.storyCodes)
  const subjectRanges = structuredSubject.map((match) => ({ start: match.start, end: match.end }))
  const bodyRanges = structuredBody.map((match) => ({ start: match.start, end: match.end }))
  const subjectMatches = matchStoryTokens(input.subject, input.storyCodes, 'SUBJECT').filter((match) => !subjectRanges.some((range) => match.start >= range.start && match.end <= range.end))
  const bodyMatches = matchStoryTokens(input.body, input.storyCodes, 'BODY').filter((match) => !bodyRanges.some((range) => match.start >= range.start && match.end <= range.end))
  const matches = [
    ...structuredCommit,
    ...subjectMatches,
    ...bodyMatches,
    ...(input.sourceBranch ? matchStoryTokens(input.sourceBranch, input.storyCodes, 'SOURCE_BRANCH') : []),
    ...(input.mrStructuredText ? parseStructuredStoryIds(input.mrStructuredText, input.storyCodes, 'STRUCTURED_MR') : []),
  ]
  const unique = new Map(matches.map((match) => [`${match.location}:${match.start}:${match.end}:${match.normalizedCode}:${match.structured}`, match]))
  return {
    parserVersion: STORY_TOKEN_PARSER_VERSION,
    matches: [...unique.values()].sort((left, right) => compareText(left.location, right.location) || left.start - right.start || compareText(left.normalizedCode, right.normalizedCode)),
  }
}

function effectiveStatus(input: StoryCommitAttributionInput): EffectiveStatus {
  if (!input.revertsRelatedCommit) return 'EFFECTIVE'
  if (input.revertEffect === 'FULL') return 'REVERTED'
  if (input.revertEffect === 'PARTIAL') return 'PARTIAL'
  return 'UNKNOWN'
}

function result(input: StoryCommitAttributionInput, tokens: ParsedStoryTokens, decision: AttributionDecision, scopeRecommendation: ScopeRecommendation, reasons: readonly string[], score: number): StoryCommitAttributionResult {
  const reasonCodes = [...new Set(reasons)].sort(compareText)
  return {
    candidateId: input.candidateId,
    repository: input.repository,
    sha: input.sha,
    decision,
    scopeRecommendation,
    effectiveStatus: effectiveStatus(input),
    selected: decision === 'AUTO_SELECTED_EXPLICIT' || decision === 'AUTO_SELECTED_STRONG',
    rankScore: Math.max(0, score),
    reasonCodes,
    storyMatches: tokens.matches,
    parserVersion: STORY_TOKEN_PARSER_VERSION,
    algorithmVersion: ATTRIBUTION_ALGORITHM_VERSION,
  }
}

export function attributeStoryCommit(input: StoryCommitAttributionInput): StoryCommitAttributionResult {
  if (!FULL_SHA_PATTERN.test(input.sha)) throw new StoryAttributionError('sha must be lowercase full 40-hex')
  const current = normalizeStoryCode(input.currentStoryCode)
  const allCodes = canonicalCodes([...input.batchStoryCodes, current])
  const tokens = parseCommitStoryTokens({
    subject: input.subject,
    body: input.body,
    sourceBranch: input.sourceBranch,
    mrStructuredText: input.mrStructuredText,
    storyCodes: allCodes,
  })
  const currentMatches = tokens.matches.filter((match) => match.normalizedCode === current)
  const otherMatches = tokens.matches.filter((match) => match.normalizedCode !== current)
  const currentStructured = currentMatches.some((match) => match.structured)
  const currentUnstructured = currentMatches.some((match) => !match.structured)
  const hasOtherStructured = otherMatches.some((match) => match.structured)
  const status = effectiveStatus(input)

  if (input.rangeCompleteness !== 'COMPLETE') {
    return result(input, tokens, 'GLOBAL_FALLBACK', 'GLOBAL_FALLBACK', [input.rangeCompleteness === 'RANGE_TOO_LARGE' ? 'RANGE_TOO_LARGE' : 'RANGE_INCOMPLETE'], 0)
  }
  if (!input.reachableFromFrozenHead) {
    return result(input, tokens, 'EXCLUDED', 'GLOBAL_FALLBACK', ['OUTSIDE_FROZEN_HEAD'], 0)
  }
  if (input.ruleConflict === true || input.strongSignalConflict === true) {
    return result(input, tokens, 'CONFLICT', 'GLOBAL_FALLBACK', [input.ruleConflict === true ? 'RULE_CONFLICT' : 'STRONG_SIGNAL_CONFLICT'], 0)
  }

  const commonReasons: string[] = []
  if (input.bot || input.generated) commonReasons.push('BOT_OR_GENERATED')
  if (input.identityStatus === 'AMBIGUOUS') commonReasons.push('IDENTITY_AMBIGUOUS')
  if (input.revertsRelatedCommit) commonReasons.push('REVERT_OF_RELATED_COMMIT')

  if (currentStructured) {
    const reason = currentMatches.some((match) => match.location === 'STRUCTURED_MR') ? 'EXPLICIT_MR_STORY_ID' : 'EXPLICIT_STORY_ID'
    return result(input, tokens, 'AUTO_SELECTED_EXPLICIT', 'EXACT_STORY_COMMITS', [...commonReasons, reason, ...(status !== 'EFFECTIVE' ? [`EFFECTIVE_${status}`] : [])], 900 - (input.bot || input.generated ? 25 : 0))
  }
  if (input.sameExplicitMr) {
    return result(input, tokens, 'AUTO_SELECTED_STRONG', 'EXACT_STORY_COMMITS', [...commonReasons, 'SAME_EXPLICIT_MR'], 850)
  }
  if (input.revertsRelatedCommit) {
    return result(input, tokens, 'AUTO_SELECTED_STRONG', 'EXACT_STORY_COMMITS', [...commonReasons, `EFFECTIVE_${status}`], 850)
  }
  if (hasOtherStructured && !input.sharedStoryRelationship) {
    return result(input, tokens, 'EXCLUDED', 'GLOBAL_FALLBACK', [...commonReasons, 'OTHER_STORY_EXPLICIT'], 0)
  }

  const verifiedIdentity = input.identityStatus === 'VERIFIED'
  const supportSignals = [verifiedIdentity, input.sameExplicitMr, input.moduleOverlap].filter(Boolean).length
  if (currentUnstructured && supportSignals > 0) {
    return result(input, tokens, 'AUTO_SELECTED_STRONG', 'EXACT_STORY_COMMITS', [...commonReasons, 'STORY_CODE_WITH_SUPPORT', ...(verifiedIdentity ? ['VERIFIED_OWNER'] : []), ...(input.moduleOverlap ? ['MODULE_OVERLAP'] : [])], 700 - (input.bot || input.generated ? 25 : 0))
  }

  if (currentUnstructured || (verifiedIdentity && input.withinFrozenWindow && input.moduleOverlap)) {
    const reasons = [...commonReasons]
    if (currentUnstructured) reasons.push('UNSTRUCTURED_STORY_MENTION')
    if (verifiedIdentity && input.withinFrozenWindow && input.moduleOverlap) reasons.push('OWNER_WINDOW_MODULE')
    return result(input, tokens, 'AI_RELEVANCE_REQUIRED', currentUnstructured ? 'REQUIREMENT_REF_ONLY' : 'DEVELOPER_WINDOW', reasons, 500 - (input.bot || input.generated ? 100 : 0))
  }

  const weakSignals = [input.identityStatus === 'WEAK_NAME', verifiedIdentity, input.withinFrozenWindow, input.moduleOverlap].filter(Boolean).length
  if (weakSignals > 0 && input.identityStatus !== 'AMBIGUOUS') {
    return result(input, tokens, 'WEAK_FALLBACK', verifiedIdentity ? 'DEVELOPER_WINDOW' : 'GLOBAL_FALLBACK', [...commonReasons, 'WEAK_ATTRIBUTION_SIGNAL'], 100 - (input.bot || input.generated ? 50 : 0))
  }
  return result(input, tokens, 'GLOBAL_FALLBACK', currentMatches.length > 0 ? 'REQUIREMENT_REF_ONLY' : 'GLOBAL_FALLBACK', [...commonReasons, input.identityStatus === 'AMBIGUOUS' ? 'IDENTITY_AMBIGUOUS' : 'NO_CANDIDATE'], 0)
}

const DECISION_ORDER: Readonly<Record<AttributionDecision, number>> = {
  AUTO_SELECTED_EXPLICIT: 0,
  AUTO_SELECTED_STRONG: 1,
  AI_RELEVANCE_REQUIRED: 2,
  WEAK_FALLBACK: 3,
  CONFLICT: 4,
  EXCLUDED: 5,
  GLOBAL_FALLBACK: 6,
}

export function sortStoryCandidates(candidates: readonly StoryCommitAttributionResult[]): StoryCommitAttributionResult[] {
  return [...candidates].sort((left, right) => DECISION_ORDER[left.decision] - DECISION_ORDER[right.decision] || right.rankScore - left.rankScore || compareText(left.repository, right.repository) || compareText(left.sha, right.sha) || compareText(left.candidateId, right.candidateId))
}

export function createStoryCandidateManifest(storyCode: string, generation: number, candidates: readonly StoryCommitAttributionResult[]): StoryCandidateManifest {
  if (!Number.isSafeInteger(generation) || generation < 1) throw new StoryAttributionError('generation must be positive')
  const normalizedStoryCode = normalizeStoryCode(storyCode)
  const sorted = sortStoryCandidates(candidates).map((candidate) => ({
    ...candidate,
    reasonCodes: [...candidate.reasonCodes].sort(compareText),
    storyMatches: [...candidate.storyMatches].sort((left, right) => compareText(left.location, right.location) || left.start - right.start || compareText(left.normalizedCode, right.normalizedCode)),
  }))
  const identity = {
    schemaVersion: 1 as const,
    algorithmVersion: ATTRIBUTION_ALGORITHM_VERSION,
    storyCode: normalizedStoryCode,
    generation,
    candidates: sorted,
  }
  return {
    ...identity,
    manifestHash: `sha256:${createHash('sha256').update(`story-candidate-manifest-v1\n${stableJson(identity)}\n`, 'utf8').digest('hex')}`,
  }
}
