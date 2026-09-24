/**
 * V1.22：技能 AI 优化"一次写对"的契约。
 *
 * 这个文件盯的是线上那次失败的三条根因，每条都有断言：
 *
 *   1. **证据口径**：引用数 > 0 但结论数为 0 时不许调模型。线上那条请求
 *      （`the model changed nothing`，model_attempts=3）就是拿一份全 0 的统计
 *      连问了模型三遍。
 *   2. **「不需要改」是合法出口**：模型说不该改时终态记录，不重试 —— 同一份证据重试
 *      只会得到同一个答案，纯烧 token。
 *   3. **规范写进提示词**：目录/扩展名表由校验器常量生成，附 frontmatter 原文行、
 *      容量现状、输出样例与自检清单。提示词与校验器分叉时这里会红。
 */

import { describe, expect, it } from 'vitest'

import {
  classifySkillOptimizationError,
  runSkillAiOptimization,
  SKILL_OPTIMIZATION_ERROR_CODES,
} from '../ai/skills/skill-ai-optimizer.js'
import {
  buildSkillOptimizationPrompt,
  findFrontmatterNameLine,
  parseSkillOptimizationOutput,
  renderBudget,
  renderPathSpec,
  SkillOptimizationNoChangeError,
  SkillOptimizationOutputError,
  type SkillBundleFileView,
  type SkillReviewEvidenceSnapshot,
} from '../ai/skills/skill-optimization-prompt.js'
import { SKILL_BUNDLE_LIMITS } from '../ai/skills/skill-limits.js'
import { SKILL_ROLE_EXTENSIONS } from '../ai/skills/skill-manifest.js'
import type { JobsDb, SkillAiOptimizationClaim } from '../db/jobs.js'
import type { Logger } from '../logger.js'
import type { ChatCompletionResult } from '../model-connectivity/chat-completion.js'
import { buildZip, pngBytes, validEntryMarkdown } from './helpers/zip-builder.js'

const SKILL_NAME = 'bos-bill-review'
const LIMITS = SKILL_BUNDLE_LIMITS

function entryMarkdown(body: string, name = SKILL_NAME): string {
  return [
    '---',
    `name: ${name}`,
    'description: BOS 单据领域的评审要点与操作规则',
    '---',
    '',
    body,
    '',
  ].join('\n')
}

function views(): SkillBundleFileView[] {
  return [
    { path: 'SKILL.md', text: entryMarkdown('# 原正文'), sizeBytes: 137, role: 'ENTRY' },
    { path: 'references/domain-model.md', text: '# 领域模型\n', sizeBytes: 40, role: 'REFERENCE' },
    { path: 'assets/flow.png', text: null, sizeBytes: 200, role: 'ASSET' },
  ]
}

function evidence(overrides: Partial<SkillReviewEvidenceSnapshot> = {}): SkillReviewEvidenceSnapshot {
  return {
    referenced_job_count: 2,
    review_result_count: 6,
    verdict_counts: { IMPLEMENTED: 4, PARTIAL: 1, NOT_IMPLEMENTED: 0, UNCERTAIN: 1 },
    human_review_counts: { CORRECT: 3, PARTIALLY_CORRECT: 1, INCORRECT: 2, NEED_DISCUSSION: 0 },
    sample_findings: [],
    ...overrides,
  }
}

function prompt(): { system: string; user: string } {
  return buildSkillOptimizationPrompt({
    skillName: SKILL_NAME,
    files: views(),
    evidence: evidence(),
    limits: LIMITS,
  })
}

describe('提示词把结构规范写成契约', () => {
  it('目录/扩展名表由校验器常量生成，不会与校验器分叉', () => {
    const spec = renderPathSpec()
    for (const [role, extensions] of Object.entries(SKILL_ROLE_EXTENSIONS)) {
      expect(spec).toContain(`角色 ${role}`)
      for (const extension of extensions) {
        expect(spec).toContain(extension)
      }
    }
    expect(spec).toContain('scripts/<名>.<扩展名> → 角色 SCRIPT')
    expect(spec).toContain('只能删除，不能改写或新增')
  })

  it('贴出 frontmatter 的 name 行原文，要求逐字保留', () => {
    expect(findFrontmatterNameLine(entryMarkdown('x'))).toBe(`name: ${SKILL_NAME}`)
    expect(findFrontmatterNameLine('# 没有 frontmatter')).toBeNull()
    expect(prompt().system).toContain(`必须**逐字保留**：\`name: ${SKILL_NAME}\``)
  })

  it('容量给当前值而不只给上限（模型数不出字节）', () => {
    const budget = renderBudget(views(), LIMITS)
    expect(budget).toContain(`当前 137 字节，上限 ${LIMITS.entryFileBytes} 字节`)
    expect(budget).toContain('1 字 ≈ 3 字节')
    expect(prompt().system).toContain('## 容量')
  })

  it('给出输出样例、完整全文要求与「不需要改」出口', () => {
    const system = prompt().system
    expect(system).toContain('## 输出样例')
    expect(system).toContain('"noChangeNeeded": true')
    expect(system).toContain('不允许出现"…（省略）…"这类占位')
    expect(system).toContain('没动的文件不要出现')
  })

  it('用户提示词末尾带逐条自检清单', () => {
    const user = prompt().user
    expect(user).toContain('## 输出前逐条自检')
    expect(user).toContain('至少有一个改动；否则改用「不需要改」出口')
  })
})

describe('「不需要改」出口', () => {
  it('解析成专属错误类型，带模型给的理由', () => {
    try {
      parseSkillOptimizationOutput({
        raw: JSON.stringify({ noChangeNeeded: true, summary: '证据里没有人工复核意见' }),
        skillName: SKILL_NAME,
        currentFiles: views(),
        limits: LIMITS,
      })
      throw new Error('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(SkillOptimizationNoChangeError)
      expect((error as Error).message).toBe('证据里没有人工复核意见')
      // 不能是"输出不合规"：那会触发回灌重写。
      expect(error).not.toBeInstanceOf(SkillOptimizationOutputError)
    }
  })

  it('映射到 SKILL_OPTIMIZATION_NO_CHANGE_NEEDED', () => {
    expect(classifySkillOptimizationError(new SkillOptimizationNoChangeError('x'))).toBe(
      SKILL_OPTIMIZATION_ERROR_CODES.NO_CHANGE_NEEDED,
    )
  })

  it('空改动集的拒绝原因会告诉模型该走哪个出口', () => {
    expect(() =>
      parseSkillOptimizationOutput({
        raw: JSON.stringify({ summary: 's', files: {} }),
        skillName: SKILL_NAME,
        currentFiles: views(),
        limits: LIMITS,
      }),
    ).toThrow(/noChangeNeeded/)
  })
})

interface FakeCalls {
  prompts: string[]
  failures: Array<Record<string, unknown>>
  uploads: number
}

function fakeDeps(options: {
  completions: string[]
  evidenceOverride?: SkillReviewEvidenceSnapshot
}): { calls: FakeCalls; deps: Parameters<typeof runSkillAiOptimization>[1] } {
  const calls: FakeCalls = { prompts: [], failures: [], uploads: 0 }
  const logger = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
    child: () => logger,
  } as unknown as Logger
  const jobsDb = {
    getSkillReviewEvidenceForOptimization: async () => options.evidenceOverride ?? evidence(),
    getModelSecretForSkillAiOptimization: async () => 'not-a-real-key',
    registerSkillUpload: async () => {
      calls.uploads += 1
      return 'upload-1'
    },
    recordSkillUploadValidation: async () => 'sha256:deadbeef',
    recordSkillUploadFailure: async () => undefined,
    submitSkillAiOptimizationResult: async () => ({}),
    submitSkillAiOptimizationFailure: async (input: Record<string, unknown>) => {
      calls.failures.push(input)
      return {}
    },
  } as unknown as JobsDb
  let index = 0
  return {
    calls,
    deps: {
      jobsDb,
      storage: {
        downloadArchive: async () =>
          buildZip([
            { name: 'SKILL.md', content: validEntryMarkdown(SKILL_NAME) },
            { name: 'references/domain-model.md', content: '# domain\n' },
            { name: 'assets/flow.png', content: pngBytes() },
          ]),
        uploadStagingArchive: async () => undefined,
      } as never,
      workerId: 'worker-test',
      modelProxy: null,
      logger,
      callModel: (async (input: { userPrompt: string }): Promise<ChatCompletionResult> => {
        calls.prompts.push(input.userPrompt)
        const next = options.completions[Math.min(index, options.completions.length - 1)]!
        index += 1
        return { content: next, latencyMs: 1, promptTokens: 1, completionTokens: 1 }
      }) as never,
    },
  }
}

const CLAIM: SkillAiOptimizationClaim = {
  request_id: '11111111-1111-4111-8111-111111111111',
  claim_token: '22222222-2222-4222-8222-222222222222',
  skill_id: '33333333-3333-4333-8333-333333333333',
  skill_name: SKILL_NAME,
  requested_by: '44444444-4444-4444-8444-444444444444',
  source_version_id: '55555555-5555-4555-8555-555555555555',
  source_version: 1,
  archive_bucket: 'skill-bundles',
  archive_object_key: `33333333-3333-4333-8333-333333333333/versions/1/${'a'.repeat(64)}.zip`,
  archive_sha256: `sha256:${'a'.repeat(64)}`,
  base_url_snapshot: 'https://model.example/v1',
  model_name_snapshot: 'model-x',
  request_timeout_ms_snapshot: 120000,
  network_access_mode_snapshot: 'DIRECT',
}

describe('runSkillAiOptimization 的证据门禁与终态', () => {
  it('被引用过但 0 条结论：不调模型，终态 NO_EVIDENCE（线上那次失败的根因）', async () => {
    const { calls, deps } = fakeDeps({
      completions: ['{}'],
      evidenceOverride: evidence({
        referenced_job_count: 1,
        review_result_count: 0,
        verdict_counts: { IMPLEMENTED: 0, PARTIAL: 0, NOT_IMPLEMENTED: 0, UNCERTAIN: 0 },
        human_review_counts: {},
      }),
    })
    const outcome = await runSkillAiOptimization(CLAIM, deps)
    expect(calls.prompts).toHaveLength(0)
    expect(outcome.modelAttempts).toBe(0)
    expect(outcome.errorCode).toBe(SKILL_OPTIMIZATION_ERROR_CODES.NO_EVIDENCE)
    expect(String(calls.failures[0]!.errorMessage)).toContain('还没有任何评审结论')
  })

  it('数据库还没升到 V1.22（没有 review_result_count）时按结论分布求和判定', async () => {
    const withoutCount = evidence({
      referenced_job_count: 1,
      verdict_counts: { IMPLEMENTED: 0, PARTIAL: 0, NOT_IMPLEMENTED: 0, UNCERTAIN: 0 },
    })
    delete withoutCount.review_result_count
    const { calls, deps } = fakeDeps({ completions: ['{}'], evidenceOverride: withoutCount })
    const outcome = await runSkillAiOptimization(CLAIM, deps)
    expect(calls.prompts).toHaveLength(0)
    expect(outcome.errorCode).toBe(SKILL_OPTIMIZATION_ERROR_CODES.NO_EVIDENCE)
  })

  it('模型走「不需要改」出口：只调一次，不重试，不产草稿，理由如实写回', async () => {
    const { calls, deps } = fakeDeps({
      completions: [
        JSON.stringify({
          noChangeNeeded: true,
          summary: '6 条结论里没有指向技能内容的问题，缺少人工复核意见，暂不改。',
        }),
      ],
    })
    const outcome = await runSkillAiOptimization(CLAIM, deps)
    expect(calls.prompts).toHaveLength(1)
    expect(outcome.modelAttempts).toBe(1)
    expect(outcome.errorCode).toBe(SKILL_OPTIMIZATION_ERROR_CODES.NO_CHANGE_NEEDED)
    expect(calls.uploads).toBe(0)
    expect(String(calls.failures[0]!.errorMessage)).toContain('缺少人工复核意见')
  })
})
