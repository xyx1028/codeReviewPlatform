import { describe, it, expect } from 'vitest'
import {
  isValidSha,
  validateRetrievalResult,
  validateAnalysisResult,
  validateEvidence,
  validateBaselineCommits,
  SchemaError,
  RETRIEVAL_LIMITS,
  type RetrievalResult,
  type AnalysisResult,
  type FileLineProvider,
} from '../ai/schemas.js'

const SHA = 'a'.repeat(40)
const SHA64 = 'a'.repeat(64)

function baseRetrieval(overrides: Partial<RetrievalResult> = {}): unknown {
  return {
    storyCode: 'PRJ-001',
    summary: 'found relevant code',
    queries: [{ repository: 'kdmanage-backend', query: 'PRJ-001', hitCount: 3 }],
    searchedRepositories: ['kdmanage-backend'],
    candidates: [
      {
        repository: 'kdmanage-backend',
        filePath: 'src/A.java',
        startLine: 1,
        endLine: 20,
        reason: 'entry point',
      },
    ],
    insufficientEvidence: false,
    ...overrides,
  }
}

describe('SHA format validation', () => {
  it('accepts 40-hex and 64-hex shas', () => {
    expect(isValidSha(SHA)).toBe(true)
    expect(isValidSha(SHA64)).toBe(true)
  })
  it('rejects invalid shas', () => {
    expect(isValidSha('abc')).toBe(false)
    expect(isValidSha('z'.repeat(40))).toBe(false)
    expect(isValidSha('a'.repeat(41))).toBe(false)
    expect(isValidSha(123 as unknown)).toBe(false)
  })
})

describe('retrieval schema', () => {
  it('accepts a valid retrieval result', () => {
    const r = validateRetrievalResult(baseRetrieval(), 'PRJ-001')
    expect(r.candidates).toHaveLength(1)
  })

  it('rejects storyCode mismatch', () => {
    expect(() => validateRetrievalResult(baseRetrieval(), 'PRJ-999')).toThrow(SchemaError)
  })

  it('rejects unknown repositories in candidates', () => {
    const bad = baseRetrieval({
      candidates: [
        { repository: 'evil' as never, filePath: 'x', startLine: 1, endLine: 2, reason: 'r' },
      ],
    })
    expect(() => validateRetrievalResult(bad, 'PRJ-001')).toThrow(/repository/)
  })

  it('rejects candidate ranges over the line limit', () => {
    const bad = baseRetrieval({
      candidates: [
        {
          repository: 'kdmanage-backend',
          filePath: 'x',
          startLine: 1,
          endLine: RETRIEVAL_LIMITS.maxSnippetLines + 5,
          reason: 'r',
        },
      ],
    })
    expect(() => validateRetrievalResult(bad, 'PRJ-001')).toThrow(/lines/)
  })

  it('rejects more than max candidates', () => {
    const many = Array.from({ length: RETRIEVAL_LIMITS.maxCandidates + 1 }, () => ({
      repository: 'kdmanage-backend',
      filePath: 'x',
      startLine: 1,
      endLine: 2,
      reason: 'r',
    }))
    expect(() => validateRetrievalResult(baseRetrieval({ candidates: many as never }), 'PRJ-001')).toThrow(
      /exceeds limit/,
    )
  })
})

function baseAnalysis(overrides: Partial<AnalysisResult> = {}): unknown {
  return {
    storyCode: 'PRJ-001',
    verdict: 'IMPLEMENTED',
    confidence: 80,
    summary: 'implemented',
    implementedContent: 'yes',
    missingContent: null,
    risks: null,
    testPoints: null,
    aiRemark: null,
    evidence: [
      {
        repository: 'kdmanage-backend',
        filePath: 'src/A.java',
        startLine: 1,
        endLine: 10,
        evidenceType: '现有实现',
        description: 'impl here',
      },
    ],
    ...overrides,
  }
}

describe('analysis schema', () => {
  it('accepts a valid analysis result', () => {
    const a = validateAnalysisResult(baseAnalysis(), 'PRJ-001')
    expect(a.verdict).toBe('IMPLEMENTED')
  })

  it('rejects verdict outside the enum', () => {
    expect(() => validateAnalysisResult(baseAnalysis({ verdict: 'MAYBE' as never }), 'PRJ-001')).toThrow(
      /verdict/,
    )
  })

  it('rejects confidence out of 0..100', () => {
    expect(() => validateAnalysisResult(baseAnalysis({ confidence: 150 }), 'PRJ-001')).toThrow(
      /confidence/,
    )
    expect(() => validateAnalysisResult(baseAnalysis({ confidence: 50.5 }), 'PRJ-001')).toThrow(
      /confidence/,
    )
  })

  it('requires 现有实现 evidence for IMPLEMENTED/PARTIAL', () => {
    const bad = baseAnalysis({
      verdict: 'IMPLEMENTED',
      evidence: [
        {
          repository: 'kdmanage-backend',
          filePath: 'src/A.java',
          startLine: 1,
          endLine: 10,
          evidenceType: '风险依据',
          description: 'risk',
        },
      ],
    })
    expect(() => validateAnalysisResult(bad, 'PRJ-001')).toThrow(/现有实现/)
  })

  it('allows UNCERTAIN without 现有实现 evidence', () => {
    const ok = baseAnalysis({ verdict: 'UNCERTAIN', evidence: [] })
    expect(validateAnalysisResult(ok, 'PRJ-001').verdict).toBe('UNCERTAIN')
  })
})

describe('evidence cross-validation', () => {
  const retrieval = validateRetrievalResult(baseRetrieval(), 'PRJ-001')
  const snapshots = [{ repository: 'kdmanage-backend' as const, commitSha: SHA }]
  const files: FileLineProvider = {
    countLines: (_repo, path) => (path === 'src/A.java' ? 100 : null),
  }

  it('accepts evidence that matches candidates and file lines', () => {
    const analysis = validateAnalysisResult(baseAnalysis(), 'PRJ-001')
    expect(() => validateEvidence(analysis, retrieval, snapshots, files)).not.toThrow()
  })

  it('rejects evidence for a file not among candidates', () => {
    const analysis = validateAnalysisResult(
      baseAnalysis({
        evidence: [
          {
            repository: 'kdmanage-backend',
            filePath: 'src/NotCandidate.java',
            startLine: 1,
            endLine: 5,
            evidenceType: '现有实现',
            description: 'x',
          },
        ],
      }),
      'PRJ-001',
    )
    expect(() => validateEvidence(analysis, retrieval, snapshots, files)).toThrow(
      /EVIDENCE_PATH_INVALID|candidates/,
    )
  })

  it('rejects evidence line numbers outside the file', () => {
    const analysis = validateAnalysisResult(
      baseAnalysis({
        evidence: [
          {
            repository: 'kdmanage-backend',
            filePath: 'src/A.java',
            startLine: 1,
            endLine: 500,
            evidenceType: '现有实现',
            description: 'x',
          },
        ],
      }),
      'PRJ-001',
    )
    let code = ''
    try {
      validateEvidence(analysis, retrieval, snapshots, files)
    } catch (e) {
      code = (e as SchemaError).code
    }
    expect(code).toBe('EVIDENCE_LINE_INVALID')
  })

  it('rejects when snapshot sha is invalid', () => {
    const analysis = validateAnalysisResult(baseAnalysis(), 'PRJ-001')
    expect(() =>
      validateEvidence(analysis, retrieval, [{ repository: 'kdmanage-backend', commitSha: 'bad' }], files),
    ).toThrow(/GIT_SHA_MISMATCH|SHA/)
  })
})

describe('baseline commit validation', () => {
  it('accepts valid baseline commits', () => {
    expect(() =>
      validateBaselineCommits('feature_dev', [
        { repository: 'kdmanage-backend', sha: SHA, subject: 's' },
      ]),
    ).not.toThrow()
  })
  it('rejects invalid branch and sha', () => {
    expect(() => validateBaselineCommits('main', [])).toThrow(SchemaError)
    expect(() =>
      validateBaselineCommits('feature_dev', [{ repository: 'kdmanage-backend', sha: 'bad' }]),
    ).toThrow(/sha/)
  })
})
