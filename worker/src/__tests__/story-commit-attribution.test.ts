import { describe, expect, it } from 'vitest'
import {
  attributeStoryCommit,
  createStoryCandidateManifest,
  matchStoryTokens,
  parseCommitStoryTokens,
  type StoryCommitAttributionInput,
} from '../analysis/story-commit-attribution.js'

const SHA = 'a'.repeat(40)
const CANDIDATE = '11111111-1111-4111-8111-111111111111'

function candidate(overrides: Partial<StoryCommitAttributionInput> = {}): StoryCommitAttributionInput {
  return {
    candidateId: CANDIDATE,
    repository: 'demo-backend',
    sha: SHA,
    currentStoryCode: 'REQ-001',
    batchStoryCodes: ['REQ-001', 'REQ-0010', 'REQ-002'],
    subject: '订单调整',
    body: '',
    sourceBranch: null,
    mrStructuredText: null,
    reachableFromFrozenHead: true,
    rangeCompleteness: 'COMPLETE',
    identityStatus: 'UNRESOLVED',
    withinFrozenWindow: true,
    moduleOverlap: false,
    sameExplicitMr: false,
    bot: false,
    generated: false,
    revertEffect: 'NONE',
    revertsRelatedCommit: false,
    ...overrides,
  }
}

describe('V1.11 story code parser boundaries', () => {
  it('does not match REQ-001 inside REQ-0010 or a longer identifier', () => {
    const matches = matchStoryTokens('REQ-0010 XREQ-001 REQ-001_suffix 中文REQ-001中文 REQ-001.', ['REQ-001', 'REQ-0010'], 'SUBJECT')
    expect(matches.map((match) => match.normalizedCode)).toEqual(['REQ-0010', 'REQ-001'])
    expect(matches[1]).toMatchObject({ start: 45, end: 52 })
  })

  it('uses longest-first matching while preserving multiple valid story codes', () => {
    const parsed = parseCommitStoryTokens({
      subject: '[REQ-0010] and REQ-001',
      body: '',
      storyCodes: ['REQ-001', 'REQ-0010'],
    })
    expect(parsed.matches.map((match) => match.normalizedCode)).toEqual(['REQ-0010', 'REQ-001'])
  })

  it('does not promote prose after Story-Id into a structured direct link', () => {
    const parsed = parseCommitStoryTokens({
      subject: '普通提交',
      body: 'Story-Id: this mentions REQ-001 but is not a token field',
      storyCodes: ['REQ-001'],
    })
    expect(parsed.matches).toEqual([
      expect.objectContaining({ normalizedCode: 'REQ-001', location: 'BODY', structured: false }),
    ])
  })

  it('separates an independent Story-Id field from ordinary body mentions', () => {
    const parsed = parseCommitStoryTokens({
      subject: '普通提交',
      body: '文档中提到 REQ-002\n\nStory-Id: REQ-001',
      storyCodes: ['REQ-001', 'REQ-002'],
    })
    expect(parsed.matches).toEqual(expect.arrayContaining([
      expect.objectContaining({ normalizedCode: 'REQ-001', location: 'STRUCTURED_COMMIT', structured: true }),
      expect.objectContaining({ normalizedCode: 'REQ-002', location: 'BODY', structured: false }),
    ]))
    expect(parsed.matches.filter((match) => match.normalizedCode === 'REQ-001')).toHaveLength(1)
  })
})

describe('V1.11 deterministic story-commit attribution', () => {
  it('auto-selects an exact structured current story even for a bot commit', () => {
    const result = attributeStoryCommit(candidate({ body: 'Story-Id: REQ-001', bot: true }))
    expect(result).toMatchObject({ decision: 'AUTO_SELECTED_EXPLICIT', selected: true, effectiveStatus: 'EFFECTIVE' })
    expect(result.reasonCodes).toEqual(expect.arrayContaining(['EXPLICIT_STORY_ID', 'BOT_OR_GENERATED']))
  })

  it('does not auto-select an unstructured story token without independent support', () => {
    const result = attributeStoryCommit(candidate({ body: '修复 REQ-001 的日志' }))
    expect(result.decision).toBe('AI_RELEVANCE_REQUIRED')
    expect(result.reasonCodes).toContain('UNSTRUCTURED_STORY_MENTION')
  })

  it('auto-selects a story token only when an independent identity or module signal exists', () => {
    const result = attributeStoryCommit(candidate({ subject: '[REQ-001] close order', identityStatus: 'VERIFIED' }))
    expect(result.decision).toBe('AUTO_SELECTED_STRONG')
    expect(result.reasonCodes).toContain('STORY_CODE_WITH_SUPPORT')
  })

  it('excludes a commit explicitly linked only to another story', () => {
    const result = attributeStoryCommit(candidate({ body: 'Story-Id: REQ-002' }))
    expect(result).toMatchObject({ decision: 'EXCLUDED', selected: false })
    expect(result.reasonCodes).toContain('OTHER_STORY_EXPLICIT')
  })

  it('keeps full and partial revert chains related while marking their effective state', () => {
    const full = attributeStoryCommit(candidate({ revertsRelatedCommit: true, revertEffect: 'FULL' }))
    const partial = attributeStoryCommit(candidate({ revertsRelatedCommit: true, revertEffect: 'PARTIAL' }))
    expect(full).toMatchObject({ decision: 'AUTO_SELECTED_STRONG', effectiveStatus: 'REVERTED', selected: true })
    expect(partial).toMatchObject({ decision: 'AUTO_SELECTED_STRONG', effectiveStatus: 'PARTIAL', selected: true })
    expect(full.reasonCodes).toContain('REVERT_OF_RELATED_COMMIT')
  })

  it('downranks bot/generated candidates instead of excluding them', () => {
    const normal = attributeStoryCommit(candidate({ identityStatus: 'VERIFIED', moduleOverlap: true }))
    const bot = attributeStoryCommit(candidate({ identityStatus: 'VERIFIED', moduleOverlap: true, generated: true }))
    expect(normal.decision).toBe('AI_RELEVANCE_REQUIRED')
    expect(bot.decision).toBe('AI_RELEVANCE_REQUIRED')
    expect(bot.rankScore).toBeLessThan(normal.rankScore)
    expect(bot.reasonCodes).toContain('BOT_OR_GENERATED')
  })

  it('ignores ambiguous identity strength and falls back instead of guessing', () => {
    const result = attributeStoryCommit(candidate({ identityStatus: 'AMBIGUOUS', moduleOverlap: true }))
    expect(result).toMatchObject({ decision: 'GLOBAL_FALLBACK', scopeRecommendation: 'GLOBAL_FALLBACK' })
    expect(result.reasonCodes).toContain('IDENTITY_AMBIGUOUS')
  })

  it('makes range incompleteness and rule conflicts explicit global fallbacks', () => {
    const incomplete = attributeStoryCommit(candidate({ body: 'Story-Id: REQ-001', rangeCompleteness: 'SHALLOW_INCOMPLETE' }))
    const conflict = attributeStoryCommit(candidate({ body: 'Story-Id: REQ-001', ruleConflict: true }))
    expect(incomplete).toMatchObject({ decision: 'GLOBAL_FALLBACK', selected: false })
    expect(incomplete.reasonCodes).toContain('RANGE_INCOMPLETE')
    expect(conflict).toMatchObject({ decision: 'CONFLICT', selected: false })
    expect(conflict.reasonCodes).toContain('RULE_CONFLICT')
  })

  it('excludes commits that are not reachable from the frozen head', () => {
    expect(attributeStoryCommit(candidate({ body: 'Story-Id: REQ-001', reachableFromFrozenHead: false }))).toMatchObject({
      decision: 'EXCLUDED',
      selected: false,
      reasonCodes: ['OUTSIDE_FROZEN_HEAD'],
    })
  })

  it('creates stable candidate ordering and hash independent of input order', () => {
    const explicit = attributeStoryCommit(candidate({ body: 'Story-Id: REQ-001' }))
    const ai = attributeStoryCommit(candidate({ candidateId: '22222222-2222-4222-8222-222222222222', sha: 'b'.repeat(40), identityStatus: 'VERIFIED', moduleOverlap: true }))
    const first = createStoryCandidateManifest('REQ-001', 1, [ai, explicit])
    const second = createStoryCandidateManifest('req-001', 1, [explicit, ai])
    expect(first.candidates.map((item) => item.candidateId)).toEqual([CANDIDATE, ai.candidateId])
    expect(second.manifestHash).toBe(first.manifestHash)
  })
})
