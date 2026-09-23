/**
 * V1.16：候选爆炸导致「精准提交分析」全量降级的回归。
 *
 * 2026-09-23 线上：一个 26 需求的 V1.11 任务，四仓共冻结 1482 条提交，**每一个**需求的
 * 分析范围都是 `scope_error_code=STORY_CANDIDATE_LIMIT_EXCEEDED` + `GLOBAL_FALLBACK`，
 * 候选数 0。根因有三条，本文件逐条锁定：
 *
 *  1. `withinFrozenWindow` 被 story-scope 对每条提交硬编码成 true，却被当作弱信号 ——
 *     于是窗口内每条提交都拿到 WEAK 档，必然越过 200 上限；
 *  2. 模块重合把需求项目名里的仓库名（`kdmanage`）当模块线索，而这些仓库的路径以仓库名
 *     开头，于是模块重合恒真；
 *  3. 越过上限时整条降级成全仓，把已经命中的 STRONG 证据一起扔掉。
 */
import { describe, expect, it } from 'vitest'
import { attributeStoryCommit, type StoryCommitAttributionInput } from '../analysis/story-commit-attribution.js'
import { buildStoryScopes } from '../pipeline/story-scope.js'
import type { CollectedRepositoryHistory } from '../git/story-history.js'

const CANDIDATE = '11111111-1111-4111-8111-111111111111'

function attribution(overrides: Partial<StoryCommitAttributionInput> = {}): StoryCommitAttributionInput {
  return {
    candidateId: CANDIDATE,
    repository: 'kdmanage-backend',
    sha: 'a'.repeat(40),
    currentStoryCode: 'US-2026-000001',
    batchStoryCodes: ['US-2026-000001'],
    subject: '常规重构',
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

function history(repository: string, commits: Array<Record<string, unknown>>): CollectedRepositoryHistory {
  return {
    manifest: {
      schema_version: 1,
      repository,
      base_sha: 'b'.repeat(40),
      head_sha: 'c'.repeat(40),
      head_subject: null,
      range_source: 'TIME_DERIVED',
      range_fallback_reason: null,
      range_start_at: '2026-09-01T00:00:00.000Z',
      range_end_at: '2026-09-22T00:00:00.000Z',
      head_resolved_at: '2026-09-22T00:00:00.000Z',
      ancestry_status: 'VERIFIED',
      enumeration_status: 'COMPLETE',
      commit_count: commits.length,
      commits,
    },
    manifestHash: `sha256:${'d'.repeat(64)}`,
    canonicalManifest: null,
    historyPath: '/tmp/none',
    deepenCount: 0,
  }
}

function commit(index: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sha: index.toString(16).padStart(40, '0'),
    sequence_no: index,
    subject: `无关提交 ${String(index)}`,
    message_body: '',
    author_name: '别人',
    author_identity_status: 'UNMATCHED',
    author_developer_id: null,
    author_email_fingerprint: '9'.repeat(64),
    committed_at: '2026-09-10T00:00:00.000Z',
    structured_story_ids: [],
    is_revert: false,
    reverted_sha: null,
    effective_status: 'EFFECTIVE',
    files: [{ path: 'kdmanage-backend/src/unrelated/File.java' }],
    ...overrides,
  }
}

describe('V1.16 弱信号不再包含「在时间窗内」', () => {
  it('窗口内但与需求毫无关系的提交不再成为候选', () => {
    const result = attributeStoryCommit(attribution())
    expect(result.decision).toBe('GLOBAL_FALLBACK')
    expect(result.reasonCodes).toContain('NO_CANDIDATE')
  })

  it('真正的弱信号（姓名别名 / 已验证作者 / 模块重合）仍然产生 WEAK 候选', () => {
    expect(attributeStoryCommit(attribution({ identityStatus: 'WEAK_NAME' })).decision).toBe('WEAK_FALLBACK')
    expect(attributeStoryCommit(attribution({ identityStatus: 'VERIFIED' })).decision).toBe('WEAK_FALLBACK')
    expect(attributeStoryCommit(attribution({ moduleOverlap: true })).decision).toBe('WEAK_FALLBACK')
  })
})

describe('V1.16 模块重合不把仓库名当模块线索', () => {
  const story = {
    task_id: '22222222-2222-4222-8222-222222222222',
    story_id: '33333333-3333-4333-8333-333333333333',
    story_code: 'US-2026-000001',
    story_name: '下架智能体导出租户清单',
    owners_text: '张三',
    normalized_developer_ids: [],
    // 线上真实形态：项目名里带着仓库名。
    project_name: 'kdmanage下架智能体提供租户影响范围（FT-2026-001591）',
    application_name: null,
    release_window: null,
    requirement_context: {},
    input_hash: '7'.repeat(64),
  }

  it('仓库名开头的路径不再让每条提交都算模块重合', () => {
    const built = buildStoryScopes({
      stories: [story],
      identities: [],
      // 这些提交的路径都以仓库名开头，且与需求无任何其它关系。
      histories: [history('kdmanage-backend', Array.from({ length: 5 }, (_, index) => commit(index)))],
      rulesetHash: '6'.repeat(64),
    })
    const scope = built.scopes[0]!
    expect(scope.candidates).toHaveLength(0)
    expect(scope.scope_error_code).toBe('NO_CANDIDATE')
  })
})

describe('V1.16 超过候选上限时截断而不是整条降级成全仓', () => {
  it('保留 STRONG 证据，按上限截断，并如实记录截断原因', () => {
    const story = {
      task_id: '44444444-4444-4444-8444-444444444444',
      story_id: '55555555-5555-4555-8555-555555555555',
      story_code: 'US-2026-000001',
      story_name: '订单接口调整',
      owners_text: '张三',
      normalized_developer_ids: ['66666666-6666-4666-8666-666666666666'],
      project_name: null,
      application_name: null,
      release_window: null,
      requirement_context: {},
      input_hash: '7'.repeat(64),
    }
    // 1 条显式命中需求号（STRONG）+ 300 条同一已验证作者的无关提交（WEAK）。
    const commits = [
      commit(0, {
        subject: '实现订单接口',
        message_body: 'Story-Id: US-2026-000001',
        author_identity_status: 'MATCHED',
        author_developer_id: '66666666-6666-4666-8666-666666666666',
      }),
      ...Array.from({ length: 300 }, (_, index) => commit(index + 1, {
        author_identity_status: 'MATCHED',
        author_developer_id: '66666666-6666-4666-8666-666666666666',
      })),
    ]
    const built = buildStoryScopes({
      stories: [story],
      identities: [{
        developer_id: '66666666-6666-4666-8666-666666666666',
        display_name: '张三',
        email_fingerprint: '9'.repeat(64),
        author_name_aliases: ['别人'],
        verification_status: 'VERIFIED',
      }],
      histories: [history('kdmanage-backend', commits)],
      rulesetHash: '6'.repeat(64),
    })
    const scope = built.scopes[0]!

    expect(scope.candidates).toHaveLength(200)
    expect(scope.candidates.filter((candidate) => candidate.tier === 'STRONG')).toHaveLength(1)
    // 关键：不再是 GLOBAL_FALLBACK —— STRONG 证据必须留在范围里。
    expect(scope.scope_mode).not.toBe('GLOBAL_FALLBACK')
    expect(scope.current_scope_level).toBe('PRIMARY')
    expect(scope.status).toBe('DEGRADED')
    expect(scope.degradation_reasons).toContain('STORY_CANDIDATE_LIMIT_TRUNCATED')
    // 上限内的集合决定 manifest 身份；截断后仍必须是稳定 hash。
    expect(scope.candidate_manifest_hash).toMatch(/^sha256:[0-9a-f]{64}$/)
  })
})
