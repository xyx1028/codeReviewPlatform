import { describe, expect, it } from 'vitest'
import {
  AttributionRuleSchemaError,
  PRESET_ATTRIBUTION_RULES,
  compileAttributionRuleSet,
  defaultAttributionRuleSet,
} from '../analysis/attribution-rule-schema.js'
import {
  CommitRelevanceContractError,
  assertTriageComplete,
  parseCommitRelevanceEnvelope,
  parseCommitRelevanceOutput,
  triageCompletion,
  validateCommitRelevanceVerdict,
  type CommitRelevanceOutput,
} from '../analysis/commit-relevance-contract.js'

const TASK = '11111111-1111-4111-8111-111111111111'
const ATTEMPT = '22222222-2222-4222-8222-222222222222'
const CANDIDATE = '33333333-3333-4333-8333-333333333333'
const ACCESS = '44444444-4444-4444-8444-444444444444'
const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)

function envelope(diffStatus: 'AVAILABLE' | 'UNAVAILABLE' | 'BINARY' | 'DIFF_TOO_LARGE' = 'AVAILABLE') {
  return {
    schemaVersion: 1,
    phase: 'COMMIT_RELEVANCE_TRIAGE',
    taskId: TASK,
    story: { code: 'REQ-001', name: '批量关闭', allowedContext: '受控摘要' },
    scope: {
      generation: 1,
      candidateManifestHash: `sha256:${HASH_A}`,
      rulesetHash: HASH_B,
      requiredCandidateIds: [CANDIDATE],
    },
    candidate: {
      candidateId: CANDIDATE,
      repository: 'demo-backend',
      shortSha: 'a83c19f',
      subject: '优化订单日志',
      reasonCodes: ['OWNER_WINDOW_MODULE'],
      diffStatus,
    },
  }
}

function verdict(overrides: Partial<CommitRelevanceOutput> = {}): CommitRelevanceOutput {
  return {
    schemaVersion: 1,
    candidateId: CANDIDATE,
    verdict: 'RELATED',
    reasonCodes: ['CODE_SEMANTIC_MATCH', 'MODULE_MATCH'],
    confidence: 0.86,
    diffAccessIds: [ACCESS],
    summary: '新增批量关闭接口日志',
    requestedExpansion: null,
    ...overrides,
  }
}

describe('V1.11 attribution rule schema', () => {
  it('ships exactly the 13 locked preset rules from the execution plan', () => {
    expect(PRESET_ATTRIBUTION_RULES).toHaveLength(13)
    expect(new Set(PRESET_ATTRIBUTION_RULES.map((rule) => rule.ruleCode)).size).toBe(13)
    expect(PRESET_ATTRIBUTION_RULES.every((rule) => rule.systemLocked)).toBe(true)
    expect(defaultAttributionRuleSet().rules).toHaveLength(13)
  })

  it('produces the same canonical order and hash for equivalent rule ordering', () => {
    const forward = compileAttributionRuleSet({ schemaVersion: 1, version: 7, rules: PRESET_ATTRIBUTION_RULES })
    const reverse = compileAttributionRuleSet({ schemaVersion: 1, version: 7, rules: [...PRESET_ATTRIBUTION_RULES].reverse() })
    expect(reverse.rules).toEqual(forward.rules)
    expect(reverse.canonicalJson).toBe(forward.canonicalJson)
    expect(reverse.rulesetHash).toBe(forward.rulesetHash)
    expect(forward.rulesetHash).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it('rejects unknown fields and prevents custom rules from selecting strong', () => {
    const unknown = { ...PRESET_ATTRIBUTION_RULES[0], surprise: true }
    expect(() => compileAttributionRuleSet({ schemaVersion: 1, version: 1, rules: [unknown] })).toThrow(AttributionRuleSchemaError)

    const unsafeCustom = {
      ...PRESET_ATTRIBUTION_RULES[0],
      ruleCode: 'ATTR_CUSTOM_UNSAFE',
      priority: 500,
      systemLocked: false,
    }
    expect(() => compileAttributionRuleSet({ schemaVersion: 1, version: 1, rules: [unsafeCustom] })).toThrow(/custom rules may only/)

    const spoofedLocked = {
      ...unsafeCustom,
      ruleCode: 'ATTR_CUSTOM_SPOOFED_LOCK',
      systemLocked: true,
    }
    expect(() => compileAttributionRuleSet({ schemaVersion: 1, version: 1, rules: [spoofedLocked] })).toThrow(/cannot declare systemLocked/)

    const incompatible = structuredClone(PRESET_ATTRIBUTION_RULES[0]) as unknown as Record<string, unknown>
    const incompatibleWhen = incompatible.when as { all: Array<Record<string, unknown>> }
    incompatibleWhen.all[0]!.operator = 'IS_TRUE'
    expect(() => compileAttributionRuleSet({ schemaVersion: 1, version: 1, rules: [incompatible] })).toThrow(/incompatible/)
  })

  it('rejects duplicate rule codes and values on valueless operators', () => {
    expect(() => compileAttributionRuleSet({ schemaVersion: 1, version: 1, rules: [PRESET_ATTRIBUTION_RULES[0], PRESET_ATTRIBUTION_RULES[0]] })).toThrow(/duplicate ruleCode/)
    const invalid = structuredClone(PRESET_ATTRIBUTION_RULES[0]) as unknown as Record<string, unknown>
    const when = invalid.when as { all: Array<Record<string, unknown>> }
    when.all[0]!.value = 'REQ-001'
    expect(() => compileAttributionRuleSet({ schemaVersion: 1, version: 1, rules: [invalid] })).toThrow(/value is forbidden/)
  })
})

describe('V1.11 commit relevance machine contract', () => {
  it('strictly parses the fixed envelope and rejects candidate injection/unknown fields', () => {
    expect(parseCommitRelevanceEnvelope(envelope()).candidate.candidateId).toBe(CANDIDATE)
    expect(() => parseCommitRelevanceEnvelope({ ...envelope(), promptCanOverride: true })).toThrow(CommitRelevanceContractError)
    const crossCandidate = envelope()
    crossCandidate.candidate.candidateId = '55555555-5555-4555-8555-555555555555'
    expect(() => parseCommitRelevanceEnvelope(crossCandidate)).toThrow(/not in requiredCandidateIds/)
  })

  it('requires a successful current-attempt diff access for a readable diff', () => {
    const valid = validateCommitRelevanceVerdict({
      envelope: envelope(),
      output: verdict(),
      attemptId: ATTEMPT,
      accessFacts: [{ accessId: ACCESS, taskId: TASK, candidateId: CANDIDATE, attemptId: ATTEMPT, succeeded: true }],
    })
    expect(valid.payloadHash).toMatch(/^sha256:[0-9a-f]{64}$/)

    expect(() => validateCommitRelevanceVerdict({ envelope: envelope(), output: verdict(), attemptId: ATTEMPT, accessFacts: [] })).toThrow(/not a successful access/)
    expect(() => validateCommitRelevanceVerdict({
      envelope: envelope(),
      output: verdict(),
      attemptId: ATTEMPT,
      accessFacts: [{ accessId: ACCESS, taskId: TASK, candidateId: CANDIDATE, attemptId: '55555555-5555-4555-8555-555555555555', succeeded: true }],
    })).toThrow(/not a successful access/)
  })

  it('only permits an empty access list for unreadable diffs with UNCERTAIN', () => {
    const output = verdict({
      verdict: 'UNCERTAIN',
      reasonCodes: ['DIFF_UNAVAILABLE'],
      diffAccessIds: [],
      requestedExpansion: { targetLevel: 'GLOBAL', reasonCode: 'VERIFY_REVERT_OR_REPLACEMENT' },
    })
    expect(validateCommitRelevanceVerdict({ envelope: envelope('BINARY'), output, attemptId: ATTEMPT, accessFacts: [] }).output.verdict).toBe('UNCERTAIN')
    const probed = validateCommitRelevanceVerdict({
      envelope: envelope('DIFF_TOO_LARGE'),
      output: { ...output, diffAccessIds: [ACCESS] },
      attemptId: ATTEMPT,
      accessFacts: [{ accessId: ACCESS, taskId: TASK, candidateId: CANDIDATE, attemptId: ATTEMPT, succeeded: true }],
    })
    expect(probed.output.verdict).toBe('UNCERTAIN')
    expect(() => validateCommitRelevanceVerdict({ envelope: envelope(), output, attemptId: ATTEMPT, accessFacts: [] })).toThrow(/AVAILABLE diff requires/)
    expect(() => validateCommitRelevanceVerdict({ envelope: envelope('UNAVAILABLE'), output: verdict({ diffAccessIds: [] }), attemptId: ATTEMPT, accessFacts: [] })).toThrow(/must be UNCERTAIN/)
  })

  it('rejects illegal enums, duplicate reasons and summaries over 500 Unicode characters', () => {
    expect(() => parseCommitRelevanceOutput({ ...verdict(), verdict: 'YES' })).toThrow(/verdict is invalid/)
    expect(() => parseCommitRelevanceOutput(verdict({ reasonCodes: ['MODULE_MATCH', 'MODULE_MATCH'] }))).toThrow(/duplicates/)
    expect(() => parseCommitRelevanceOutput(verdict({ summary: '测'.repeat(501) }))).toThrow(/500/)
  })

  it('only reports N/N complete for exactly one terminal output per required candidate', () => {
    const OTHER = '55555555-5555-4555-8555-555555555555'
    expect(triageCompletion([CANDIDATE, OTHER], [verdict()])).toMatchObject({ complete: false, completedCount: 1, missingCandidateIds: [OTHER] })
    expect(triageCompletion([CANDIDATE], [verdict(), verdict()])).toMatchObject({ complete: false, duplicateCandidateIds: [CANDIDATE] })
    expect(() => assertTriageComplete([CANDIDATE, OTHER], [verdict()])).toThrow(/completed 1\/2/)
    expect(assertTriageComplete([CANDIDATE], [verdict()]).complete).toBe(true)
  })
})
