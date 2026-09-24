/**
 * V1.19 技能 AI 优化的 Worker 侧契约。
 *
 * 这个链路的危险不在"跑通一次"，而在**它拒不拒该拒的东西**。所以断言分四组：
 *
 *   1. `zip-writer` 的产物必须能被既有的 fail-closed 解析器原样读回来，而且是确定性的；
 *   2. 模型输出解析：整包可改（改写/新增/删除），但路径、角色、扩展名、容量、frontmatter
 *      一律 fail closed；二进制只能删不能写；入口文件不能删；
 *   3. **结构自检 + 自动重写**：第一次输出不合规时把原因回灌给模型让它自己改；用尽次数
 *      仍不合规就终态失败，且不产出任何草稿；
 *   4. 主流程：成功路径产出一条走过**真实校验 RPC 形状**的 upload，未改动文件字节不变。
 *
 * 第 4 组用假的 JobsDb/storage，但**不**假装校验通过：`validateSkillArchive` 是真的跑的，
 * 所以"重新打包出一份自己都不接受的归档"这类回归会在这里暴露。
 */

import { describe, expect, it } from 'vitest'

import {
  classifySkillOptimizationError,
  repackBundle,
  runSkillAiOptimization,
  SKILL_OPTIMIZATION_ERROR_CODES,
  toBundleFileViews,
} from '../ai/skills/skill-ai-optimizer.js'
import {
  buildSkillOptimizationPrompt,
  extractJsonObject,
  isModelWritablePath,
  parseSkillOptimizationOutput,
  renderBundleInventory,
  renderEvidenceDigest,
  SkillOptimizationOutputError,
  type SkillBundleFileView,
  type SkillReviewEvidenceSnapshot,
} from '../ai/skills/skill-optimization-prompt.js'
import { writeSkillArchive, ZipWriteError } from '../ai/skills/zip-writer.js'
import { readSkillArchive } from '../ai/skills/zip-archive.js'
import { validateSkillArchive } from '../ai/skills/bundle-validator.js'
import { SKILL_BUNDLE_LIMITS } from '../ai/skills/skill-limits.js'
import { assertStagingObjectKey } from '../ai/skills/skill-storage.js'
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
    'whenToUse: 评审 BOS 单据相关需求时',
    '---',
    '',
    body,
    '',
  ].join('\n')
}

function silentLogger(): Logger {
  const logger = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
    child: () => logger,
  }
  return logger as unknown as Logger
}

function evidence(): SkillReviewEvidenceSnapshot {
  return {
    referenced_job_count: 3,
    verdict_counts: { IMPLEMENTED: 4, PARTIAL: 2, NOT_IMPLEMENTED: 1, UNCERTAIN: 5 },
    human_review_counts: { CORRECT: 3, PARTIALLY_CORRECT: 1, INCORRECT: 2, NEED_DISCUSSION: 0 },
    referenced_batches: [
      {
        batch_id: 'b1',
        batch_name: '第 39 周评审',
        week_code: '2026-W39',
        job_id: 'j1',
        job_status: 'SUCCEEDED',
        job_created_at: '2026-09-20T02:00:00.000Z',
        result_count: 12,
      },
    ],
    sample_findings: [
      {
        story_code: 'S-2',
        verdict: 'IMPLEMENTED',
        summary: '认为权限校验已实现',
        human_review_result: 'INCORRECT',
        human_review_comment: '实际只校验了登录，没校验数据权限',
      },
      {
        story_code: 'S-1',
        verdict: 'UNCERTAIN',
        summary: '无法确定单据状态流转是否完整',
        human_review_result: null,
        human_review_comment: null,
      },
    ],
  }
}

/** 当前包：入口 + 一份参考资料 + 一张图片。 */
function currentViews(): SkillBundleFileView[] {
  return [
    {
      path: 'SKILL.md',
      text: entryMarkdown('# 原正文\n\n1. 确认字段校验存在。'),
      sizeBytes: 120,
      role: 'ENTRY',
    },
    { path: 'references/domain-model.md', text: '# 领域模型\n\n单据主子表。\n', sizeBytes: 40, role: 'REFERENCE' },
    { path: 'assets/flow.png', text: null, sizeBytes: 200, role: 'ASSET' },
  ]
}

// ---------------------------------------------------------------------------
// 1. 确定性 ZIP 写入器
// ---------------------------------------------------------------------------

describe('writeSkillArchive', () => {
  it('产物能被 fail-closed 解析器原样读回来（含二进制资源与脚本）', () => {
    const entries = [
      { path: 'SKILL.md', bytes: Buffer.from(entryMarkdown('# 正文\n\n规则一'), 'utf8') },
      { path: 'references/domain-model.md', bytes: Buffer.from('# domain\n', 'utf8') },
      { path: 'assets/flow.png', bytes: pngBytes() },
      { path: 'scripts/inspect.sh', bytes: Buffer.from('#!/bin/sh\necho ok\n', 'utf8') },
    ]
    const archive = writeSkillArchive(entries, { compressionRatio: LIMITS.compressionRatio })
    const read = readSkillArchive(archive, LIMITS)
    expect(read.files.map((file) => file.path)).toEqual([
      'SKILL.md',
      'assets/flow.png',
      'references/domain-model.md',
      'scripts/inspect.sh',
    ])
    for (const entry of entries) {
      const round = read.files.find((file) => file.path === entry.path)
      // 字节级相等：未改动文件在重新打包后不能被任何再编码碰过。
      expect(round?.bytes.equals(entry.bytes)).toBe(true)
    }
  })

  it('同一份内容重复打包得到逐字节相同的归档', () => {
    const entries = [
      { path: 'SKILL.md', bytes: Buffer.from(entryMarkdown('# 正文'), 'utf8') },
      { path: 'references/a.md', bytes: Buffer.from('a\n', 'utf8') },
    ]
    const options = { compressionRatio: LIMITS.compressionRatio }
    const first = writeSkillArchive(entries, options)
    // 顺序不同也必须得到同一串字节：正式对象 key 是按归档 sha256 内容寻址的。
    const second = writeSkillArchive([...entries].reverse(), options)
    expect(first.equals(second)).toBe(true)
  })

  it('高度可压缩的内容退回 store，于是整档压缩比不会撞上 20:1 闸门', () => {
    const repetitive = Buffer.from('A'.repeat(200000), 'utf8')
    const archive = writeSkillArchive(
      [
        { path: 'SKILL.md', bytes: Buffer.from(entryMarkdown('# 正文'), 'utf8') },
        { path: 'references/repeat.txt', bytes: repetitive },
      ],
      { compressionRatio: LIMITS.compressionRatio },
    )
    const read = readSkillArchive(archive, LIMITS)
    expect(read.files.find((file) => file.path === 'references/repeat.txt')?.bytes.length).toBe(
      repetitive.length,
    )
  })

  it('拒绝重复路径与非规范路径', () => {
    const bytes = Buffer.from('x', 'utf8')
    expect(() =>
      writeSkillArchive([{ path: 'a.md', bytes }, { path: 'a.md', bytes }], {
        compressionRatio: 20,
      }),
    ).toThrow(ZipWriteError)
    expect(() =>
      writeSkillArchive([{ path: '/a.md', bytes }], { compressionRatio: 20 }),
    ).toThrow(ZipWriteError)
    expect(() =>
      writeSkillArchive([{ path: 'a\\b.md', bytes }], { compressionRatio: 20 }),
    ).toThrow(ZipWriteError)
  })
})

// ---------------------------------------------------------------------------
// 2. Prompt 与输出解析（整包可改）
// ---------------------------------------------------------------------------

describe('buildSkillOptimizationPrompt', () => {
  it('把整包结构、全部文本正文、上限与证据（含批次）都写进提示词', () => {
    const prompt = buildSkillOptimizationPrompt({
      skillName: SKILL_NAME,
      files: currentViews(),
      evidence: evidence(),
      limits: LIMITS,
    })
    expect(prompt.system).toContain('改写、新增、删除')
    expect(prompt.system).toContain('图片资源只能删除')
    expect(prompt.user).toContain(SKILL_NAME)
    expect(prompt.user).toContain('references/domain-model.md')
    // 图片列进结构但不给正文。
    expect(prompt.user).toContain('assets/flow.png')
    expect(prompt.user).toContain('只能删除、不能改写')
    // 容量上限写在 system 里（它属于"规则"，不属于"这次的数据"）。
    expect(prompt.system).toContain(String(LIMITS.entryFileBytes))
    expect(prompt.system).toContain(String(LIMITS.entryCount))
    // 人工标错的那条与所属批次必须进提示词：它们是这次优化唯一的真实信号来源。
    expect(prompt.user).toContain('实际只校验了登录，没校验数据权限')
    expect(prompt.user).toContain('第 39 周评审')
  })

  it('拿不到入口正文时拒绝组装（上游解包坏了，不该送去模型）', () => {
    expect(() =>
      buildSkillOptimizationPrompt({
        skillName: SKILL_NAME,
        files: [{ path: 'references/a.md', text: 'a', sizeBytes: 1, role: 'REFERENCE' }],
        evidence: evidence(),
        limits: LIMITS,
      }),
    ).toThrow(SkillOptimizationOutputError)
  })

  it('自检不通过时把拒绝原因原样回灌给模型', () => {
    const prompt = buildSkillOptimizationPrompt({
      skillName: SKILL_NAME,
      files: currentViews(),
      evidence: evidence(),
      limits: LIMITS,
      previousRejection: 'file type is not allowed for its role (SCRIPT): scripts/x.md',
      attempt: 2,
      maxAttempts: 3,
    })
    expect(prompt.user).toContain('上一次的输出被结构检查拒绝了')
    expect(prompt.user).toContain('scripts/x.md')
    expect(prompt.user).toContain('第 2 次尝试，最多 3 次')
  })

  it('证据摘要把缺失的计数渲染成 0，而不是 undefined', () => {
    const digest = renderEvidenceDigest({
      referenced_job_count: 1,
      verdict_counts: {},
      human_review_counts: {},
      sample_findings: [],
    })
    expect(digest).toContain('IMPLEMENTED: 0')
    expect(digest).toContain('NEED_DISCUSSION: 0')
    expect(digest).toContain('抽样结论：无。')
    expect(digest).not.toContain('undefined')
  })

  it('结构清单区分可改写与只能删除', () => {
    const inventory = renderBundleInventory(currentViews())
    expect(inventory).toContain('SKILL.md（ENTRY，120 字节，可改写）')
    expect(inventory).toContain('assets/flow.png（ASSET，二进制，200 字节，只能删除、不能改写）')
  })
})

describe('isModelWritablePath', () => {
  it('文本类全部可写，图片不可写', () => {
    expect(isModelWritablePath('SKILL.md')).toBe(true)
    expect(isModelWritablePath('references/a.md')).toBe(true)
    expect(isModelWritablePath('templates/a.md')).toBe(true)
    expect(isModelWritablePath('scripts/a.sh')).toBe(true)
    expect(isModelWritablePath('notes.txt')).toBe(true)
    expect(isModelWritablePath('assets/a.png')).toBe(false)
  })
})

describe('parseSkillOptimizationOutput', () => {
  const base = { skillName: SKILL_NAME, currentFiles: currentViews(), limits: LIMITS }

  it('接受改写入口 + 改写参考资料 + 新增文件 + 删除文件', () => {
    const rewritten = entryMarkdown('# 新正文\n\n1. 确认数据权限校验。')
    const parsed = parseSkillOptimizationOutput({
      ...base,
      raw: `好的：\n\`\`\`json\n${JSON.stringify({
        summary: '补充了数据权限核对要点，并拆出一份检查清单',
        files: {
          'SKILL.md': rewritten,
          'references/domain-model.md': '# 领域模型\n\n单据主子表 + 数据权限维度。\n',
          'templates/checklist.md': '- [ ] 数据权限\n',
        },
        deletedFiles: ['assets/flow.png'],
      })}\n\`\`\``,
    })
    expect(parsed.files.get('SKILL.md')).toBe(rewritten)
    expect(parsed.files.has('templates/checklist.md')).toBe(true)
    expect(parsed.deletedPaths).toEqual(['assets/flow.png'])
    expect(parsed.changedPaths).toEqual([
      'SKILL.md',
      'assets/flow.png',
      'references/domain-model.md',
      'templates/checklist.md',
    ])
  })

  it('只删不改也算一次有效改动', () => {
    const parsed = parseSkillOptimizationOutput({
      ...base,
      raw: JSON.stringify({ summary: '删掉过时的领域模型', files: {}, deletedFiles: ['references/domain-model.md'] }),
    })
    expect(parsed.files.size).toBe(0)
    expect(parsed.changedPaths).toEqual(['references/domain-model.md'])
  })

  it('拒绝把二进制当文本写', () => {
    expect(() =>
      parseSkillOptimizationOutput({
        ...base,
        raw: JSON.stringify({ summary: 's', files: { 'assets/flow.png': 'not really a png' } }),
      }),
    ).toThrow(/cannot write binary content/)
  })

  it('拒绝路径逃逸、反斜杠、绝对路径与非规范路径', () => {
    for (const path of ['../../etc/passwd', 'a\\b.md', '/abs.md', './a.md', 'a//b.md']) {
      expect(() =>
        parseSkillOptimizationOutput({
          ...base,
          raw: JSON.stringify({ summary: 's', files: { [path]: 'x' } }),
        }),
        `path must be rejected: ${path}`,
      ).toThrow(SkillOptimizationOutputError)
    }
  })

  it('拒绝放错目录的扩展名（脚本必须在 scripts/，那条约定不能被 AI 绕过）', () => {
    expect(() =>
      parseSkillOptimizationOutput({
        ...base,
        raw: JSON.stringify({ summary: 's', files: { 'inspect.sh': '#!/bin/sh\n' } }),
      }),
    ).toThrow(/not allowed for its role/)
    expect(() =>
      parseSkillOptimizationOutput({
        ...base,
        raw: JSON.stringify({ summary: 's', files: { 'scripts/readme.md': '# x\n' } }),
      }),
    ).toThrow(/not allowed for its role/)
  })

  it('允许新增 scripts/ 下的脚本（发布时另有 acknowledge 门禁）', () => {
    const parsed = parseSkillOptimizationOutput({
      ...base,
      raw: JSON.stringify({
        summary: '加一个检查脚本',
        files: { 'scripts/check.sh': '#!/bin/sh\necho ok\n' },
      }),
    })
    expect(parsed.files.has('scripts/check.sh')).toBe(true)
  })

  it('拒绝删除 SKILL.md、删除不存在的文件、同时改又删', () => {
    expect(() =>
      parseSkillOptimizationOutput({
        ...base,
        raw: JSON.stringify({ summary: 's', files: {}, deletedFiles: ['SKILL.md'] }),
      }),
    ).toThrow(/refusing to delete SKILL.md/)
    expect(() =>
      parseSkillOptimizationOutput({
        ...base,
        raw: JSON.stringify({ summary: 's', files: {}, deletedFiles: ['references/nope.md'] }),
      }),
    ).toThrow(/does not contain/)
    expect(() =>
      parseSkillOptimizationOutput({
        ...base,
        raw: JSON.stringify({
          summary: 's',
          files: { 'references/domain-model.md': '# x\n' },
          deletedFiles: ['references/domain-model.md'],
        }),
      }),
    ).toThrow(/both rewrote and deleted/)
  })

  it('拒绝改 frontmatter 的 name 与去掉 frontmatter', () => {
    expect(() =>
      parseSkillOptimizationOutput({
        ...base,
        raw: JSON.stringify({
          summary: 's',
          files: { 'SKILL.md': entryMarkdown('# 新正文', 'another-skill') },
        }),
      }),
    ).toThrow(/frontmatter is invalid/)
    expect(() =>
      parseSkillOptimizationOutput({
        ...base,
        raw: JSON.stringify({ summary: 's', files: { 'SKILL.md': '# 只有正文\n' } }),
      }),
    ).toThrow(/frontmatter is invalid/)
  })

  it('拒绝逐字节未改动的文件（否则管理员会对着空 diff 找不同）', () => {
    expect(() =>
      parseSkillOptimizationOutput({
        ...base,
        raw: JSON.stringify({
          summary: 's',
          files: { 'SKILL.md': entryMarkdown('# 原正文\n\n1. 确认字段校验存在。') },
        }),
      }),
    ).toThrow(/unchanged/)
  })

  it('拒绝空 files+空 deletedFiles、空 summary、空正文与 NUL 字节', () => {
    expect(() =>
      parseSkillOptimizationOutput({ ...base, raw: JSON.stringify({ summary: 's', files: {} }) }),
    ).toThrow(/changed nothing/)
    expect(() =>
      parseSkillOptimizationOutput({
        ...base,
        raw: JSON.stringify({ summary: '  ', files: { 'SKILL.md': entryMarkdown('# x') } }),
      }),
    ).toThrow(/summary/)
    expect(() =>
      parseSkillOptimizationOutput({
        ...base,
        raw: JSON.stringify({ summary: 's', files: { 'SKILL.md': '   ' } }),
      }),
    ).toThrow(/empty body/)
    expect(() =>
      parseSkillOptimizationOutput({
        ...base,
        raw: JSON.stringify({
          summary: 's',
          files: { 'SKILL.md': `${entryMarkdown('# x')}\u0000` },
        }),
      }),
    ).toThrow(/NUL/)
  })

  it('按改动后的最终集合判断容量，而不是只看单个文件', () => {
    expect(() =>
      parseSkillOptimizationOutput({
        ...base,
        limits: { ...LIMITS, entryCount: 3 },
        raw: JSON.stringify({
          summary: 's',
          files: { 'references/a.md': 'a\n', 'references/b.md': 'b\n' },
        }),
      }),
    ).toThrow(/would contain 5 files/)
    expect(() =>
      parseSkillOptimizationOutput({
        ...base,
        limits: { ...LIMITS, expandedBytes: 300 },
        raw: JSON.stringify({ summary: 's', files: { 'references/big.md': 'x'.repeat(500) } }),
      }),
    ).toThrow(/would expand to/)
  })

  it('拒绝超出 SKILL.md 字节上限的正文', () => {
    expect(() =>
      parseSkillOptimizationOutput({
        ...base,
        limits: { ...LIMITS, entryFileBytes: 200 },
        raw: JSON.stringify({
          summary: 's',
          files: { 'SKILL.md': entryMarkdown('# 新正文\n\n'.concat('长'.repeat(500))) },
        }),
      }),
    ).toThrow(/over the 200 byte limit/)
  })

  it('拒绝非 JSON 与 JSON 数组', () => {
    expect(() => parseSkillOptimizationOutput({ ...base, raw: '抱歉，我做不到。' })).toThrow(
      /no JSON object/,
    )
    expect(() => parseSkillOptimizationOutput({ ...base, raw: '{ not json }' })).toThrow(
      /not parseable JSON/,
    )
    expect(() => parseSkillOptimizationOutput({ ...base, raw: '' })).toThrow(/empty completion/)
  })

  it('extractJsonObject 只剥壳、不修补', () => {
    expect(extractJsonObject('前言 {"a":1} 后记')).toBe('{"a":1}')
    expect(() => extractJsonObject('没有大括号')).toThrow(SkillOptimizationOutputError)
  })
})

describe('toBundleFileViews / repackBundle', () => {
  it('文本严格解码、图片只留身份；重新打包时删除生效、新增落地、未改动字节不变', () => {
    const source = readSkillArchive(publishedArchive(), LIMITS)
    const views = toBundleFileViews(source.files)
    expect(views.find((file) => file.path === 'assets/flow.png')?.text).toBeNull()
    expect(views.find((file) => file.path === 'SKILL.md')?.text).toContain('name: bos-bill-review')

    const repacked = repackBundle(
      source.files,
      {
        summary: 's',
        files: new Map([['templates/checklist.md', '- [ ] 数据权限\n']]),
        deletedPaths: ['references/domain-model.md'],
        changedPaths: ['references/domain-model.md', 'templates/checklist.md'],
      },
      LIMITS,
    )
    const read = readSkillArchive(repacked, LIMITS)
    expect(read.files.map((file) => file.path)).toEqual([
      'SKILL.md',
      'assets/flow.png',
      'templates/checklist.md',
    ])
    const beforePng = source.files.find((file) => file.path === 'assets/flow.png')!.bytes
    const afterPng = read.files.find((file) => file.path === 'assets/flow.png')!.bytes
    expect(afterPng.equals(beforePng)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 3/4. 主流程：自检重写 + 成功路径
// ---------------------------------------------------------------------------

interface FakeDbCalls {
  registered: Array<{ actorId: string; skillId: string; stagingObjectKey: string }>
  validations: Array<Record<string, unknown>>
  uploadFailures: Array<Record<string, unknown>>
  results: Array<Record<string, unknown>>
  failures: Array<Record<string, unknown>>
  uploads: Array<{ objectKey: string; bytes: Buffer }>
  prompts: string[]
}

function fakeDeps(options: {
  archive: Buffer
  /** 依次返回的模型输出；最后一个会被重复使用。Error 表示这一次调用直接抛错。 */
  completions: Array<string | Error>
  evidenceOverride?: SkillReviewEvidenceSnapshot
  uploadError?: Error
}) {
  const calls: FakeDbCalls = {
    registered: [],
    validations: [],
    uploadFailures: [],
    results: [],
    failures: [],
    uploads: [],
    prompts: [],
  }
  const jobsDb = {
    getSkillReviewEvidenceForOptimization: async () => options.evidenceOverride ?? evidence(),
    getModelSecretForSkillAiOptimization: async () => 'not-a-real-key',
    registerSkillUpload: async (input: {
      actorId: string
      skillId: string
      stagingObjectKey: string
    }) => {
      calls.registered.push(input)
      return 'upload-1'
    },
    recordSkillUploadValidation: async (input: Record<string, unknown>) => {
      calls.validations.push(input)
      return 'sha256:deadbeef'
    },
    recordSkillUploadFailure: async (input: Record<string, unknown>) => {
      calls.uploadFailures.push(input)
    },
    submitSkillAiOptimizationResult: async (input: Record<string, unknown>) => {
      calls.results.push(input)
      return {}
    },
    submitSkillAiOptimizationFailure: async (input: Record<string, unknown>) => {
      calls.failures.push(input)
      return {}
    },
  } as unknown as JobsDb

  const storage = {
    downloadArchive: async () => options.archive,
    uploadStagingArchive: async (objectKey: string, bytes: Buffer) => {
      if (options.uploadError) throw options.uploadError
      assertStagingObjectKey(objectKey)
      calls.uploads.push({ objectKey, bytes })
    },
  }

  let index = 0
  const callModel = async (input: { userPrompt: string }): Promise<ChatCompletionResult> => {
    calls.prompts.push(input.userPrompt)
    const next = options.completions[Math.min(index, options.completions.length - 1)]!
    index += 1
    if (next instanceof Error) throw next
    return { content: next, latencyMs: 12, promptTokens: 100, completionTokens: 200 }
  }

  return {
    calls,
    deps: {
      jobsDb,
      storage: storage as never,
      workerId: 'worker-test',
      modelProxy: null,
      logger: silentLogger(),
      callModel: callModel as never,
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
  archive_object_key: '33333333-3333-4333-8333-333333333333/versions/1/' + 'a'.repeat(64) + '.zip',
  archive_sha256: 'sha256:' + 'a'.repeat(64),
  base_url_snapshot: 'https://model.example/v1',
  model_name_snapshot: 'model-x',
  request_timeout_ms_snapshot: 120000,
  network_access_mode_snapshot: 'DIRECT',
}

function publishedArchive(): Buffer {
  return buildZip([
    { name: 'SKILL.md', content: validEntryMarkdown(SKILL_NAME) },
    { name: 'references/domain-model.md', content: '# domain\n' },
    { name: 'assets/flow.png', content: pngBytes() },
  ])
}

describe('runSkillAiOptimization', () => {
  it('成功路径：整包改动（改写 + 新增 + 删除）走真实校验形状写回 upload', async () => {
    const rewritten = entryMarkdown('# 新正文\n\n补充：数据权限必须逐条核对')
    const { calls, deps } = fakeDeps({
      archive: publishedArchive(),
      completions: [
        JSON.stringify({
          summary: '依据 2 条人工标错的结论补充了数据权限核对要点',
          files: {
            'SKILL.md': rewritten,
            'templates/checklist.md': '- [ ] 数据权限逐条核对\n',
          },
          deletedFiles: ['references/domain-model.md'],
        }),
      ],
    })

    const outcome = await runSkillAiOptimization(CLAIM, deps)

    expect(outcome.status).toBe('SUCCEEDED')
    expect(outcome.modelAttempts).toBe(1)
    expect(outcome.changedPaths).toEqual([
      'SKILL.md',
      'references/domain-model.md',
      'templates/checklist.md',
    ])
    expect(calls.failures).toHaveLength(0)

    // staging key 必须落在请求人自己的前缀下（admin_register_skill_upload 会再校验一次）。
    expect(calls.registered[0]!.actorId).toBe(CLAIM.requested_by)
    expect(calls.registered[0]!.stagingObjectKey.startsWith(`staging/${CLAIM.requested_by}/`)).toBe(
      true,
    )

    // 校验落库的 manifest / frontmatter 是**真的**解析出来的，不是 Worker 自报。
    const validation = calls.validations[0]!
    expect((validation.entryFrontmatter as { name: string }).name).toBe(SKILL_NAME)
    expect((validation.bundleManifest as { skillName: string }).skillName).toBe(SKILL_NAME)
    // 原 3 个文件，删 1 加 1 = 3。
    expect(validation.fileCount).toBe(3)
    expect(validation.containsScripts).toBe(false)

    const repacked = readSkillArchive(calls.uploads[0]!.bytes, LIMITS)
    expect(repacked.files.map((file) => file.path)).toEqual([
      'SKILL.md',
      'assets/flow.png',
      'templates/checklist.md',
    ])
    expect(repacked.files.find((f) => f.path === 'SKILL.md')!.bytes.toString('utf8')).toBe(rewritten)
    // 图片字节不变：模型碰不到二进制。
    const source = readSkillArchive(publishedArchive(), LIMITS)
    expect(
      repacked.files
        .find((f) => f.path === 'assets/flow.png')!
        .bytes.equals(source.files.find((f) => f.path === 'assets/flow.png')!.bytes),
    ).toBe(true)
    // 产物必须能通过与人工上传完全相同的校验。
    expect(() =>
      validateSkillArchive({ archive: calls.uploads[0]!.bytes, expectedSkillName: SKILL_NAME }),
    ).not.toThrow()

    expect(calls.results[0]!.modelAttempts).toBe(1)
  })

  it('新增 scripts/ 时 containsScripts 传真：发布页的额外确认靠它', async () => {
    const { calls, deps } = fakeDeps({
      archive: publishedArchive(),
      completions: [
        JSON.stringify({
          summary: '补一个检查脚本',
          files: { 'scripts/check.sh': '#!/bin/sh\necho ok\n' },
        }),
      ],
    })
    const outcome = await runSkillAiOptimization(CLAIM, deps)
    expect(outcome.status).toBe('SUCCEEDED')
    expect(calls.validations[0]!.containsScripts).toBe(true)
  })

  it('结构自检不通过时把原因回灌给模型，让它自己改，第二次过', async () => {
    const { calls, deps } = fakeDeps({
      archive: publishedArchive(),
      completions: [
        // 第一次：把脚本放到根目录（角色 OTHER 不允许 .sh）。
        JSON.stringify({ summary: 's', files: { 'inspect.sh': '#!/bin/sh\n' } }),
        // 第二次：放对目录。
        JSON.stringify({
          summary: '改到 scripts/ 下了',
          files: { 'scripts/inspect.sh': '#!/bin/sh\necho ok\n' },
        }),
      ],
    })

    const outcome = await runSkillAiOptimization(CLAIM, deps)

    expect(outcome.status).toBe('SUCCEEDED')
    expect(outcome.modelAttempts).toBe(2)
    expect(calls.prompts).toHaveLength(2)
    // 第二次提示词必须带上第一次的拒绝原因，否则模型只是在重新抽一次签。
    expect(calls.prompts[0]).not.toContain('上一次的输出被结构检查拒绝了')
    expect(calls.prompts[1]).toContain('上一次的输出被结构检查拒绝了')
    expect(calls.prompts[1]).toContain('inspect.sh')
    expect(calls.results[0]!.modelAttempts).toBe(2)
  })

  it('用尽重写次数仍不合规：终态失败，且一个 upload 都不注册', async () => {
    const { calls, deps } = fakeDeps({
      archive: publishedArchive(),
      completions: [JSON.stringify({ summary: 's', files: { '../../etc/passwd': 'x' } })],
    })

    const outcome = await runSkillAiOptimization(CLAIM, deps)

    expect(outcome.status).toBe('FAILED')
    expect(outcome.errorCode).toBe(SKILL_OPTIMIZATION_ERROR_CODES.MODEL_OUTPUT_INVALID)
    expect(outcome.modelAttempts).toBe(3)
    expect(calls.prompts).toHaveLength(3)
    // 关键断言：没有产出任何草稿。一份"只是没通过校验"的 upload 会出现在技能详情页上。
    expect(calls.registered).toHaveLength(0)
    expect(calls.uploads).toHaveLength(0)
    expect(calls.failures[0]!.errorCode).toBe(
      SKILL_OPTIMIZATION_ERROR_CODES.MODEL_OUTPUT_INVALID,
    )
    expect(calls.failures[0]!.modelAttempts).toBe(3)
  })

  it('maxAttempts=1 时不重写（成本可控）', async () => {
    const { calls, deps } = fakeDeps({
      archive: publishedArchive(),
      completions: [JSON.stringify({ summary: 's', files: { 'inspect.sh': '#!/bin/sh\n' } })],
    })
    const outcome = await runSkillAiOptimization(CLAIM, { ...deps, maxAttempts: 1 })
    expect(outcome.modelAttempts).toBe(1)
    expect(calls.prompts).toHaveLength(1)
    expect(calls.registered).toHaveLength(0)
  })

  it('证据在排队期间被清空：直接终态失败，不调模型', async () => {
    const { calls, deps } = fakeDeps({
      archive: publishedArchive(),
      completions: [JSON.stringify({ summary: 's', files: {} })],
      evidenceOverride: {
        referenced_job_count: 0,
        verdict_counts: {},
        human_review_counts: {},
        sample_findings: [],
      },
    })
    const outcome = await runSkillAiOptimization(CLAIM, deps)
    expect(calls.prompts).toHaveLength(0)
    expect(outcome.errorCode).toBe(SKILL_OPTIMIZATION_ERROR_CODES.NO_EVIDENCE)
    expect(calls.failures[0]!.errorCode).toBe(SKILL_OPTIMIZATION_ERROR_CODES.NO_EVIDENCE)
  })

  it('staging 上传失败时把原因写在 upload 行上，页面才不会留一条永远 PENDING 的草稿', async () => {
    const { calls, deps } = fakeDeps({
      archive: publishedArchive(),
      completions: [
        JSON.stringify({ summary: 's', files: { 'SKILL.md': entryMarkdown('# 新正文') } }),
      ],
      uploadError: new Error('storage is down'),
    })

    const outcome = await runSkillAiOptimization(CLAIM, deps)

    expect(outcome.status).toBe('FAILED')
    expect(calls.registered).toHaveLength(1)
    expect(calls.uploadFailures[0]!.uploadId).toBe('upload-1')
    expect(calls.failures).toHaveLength(1)
  })

  it('租约丢失时不写回结果：那条任务已经不是我们的了', async () => {
    const { calls, deps } = fakeDeps({
      archive: publishedArchive(),
      completions: [new Error('rpc failed: TASK_LEASE_LOST')],
    })
    const outcome = await runSkillAiOptimization(CLAIM, deps)
    expect(outcome.errorCode).toBe('TASK_LEASE_LOST')
    expect(calls.failures).toHaveLength(0)
  })
})

describe('classifySkillOptimizationError', () => {
  it('把数据库与模型侧的稳定错误码原样透出，不收敛成通用失败', () => {
    expect(classifySkillOptimizationError(new Error('rpc x failed: MODEL_SECRET_MISSING'))).toBe(
      'MODEL_SECRET_MISSING',
    )
    expect(
      classifySkillOptimizationError(new Error('rpc x failed: SKILL_OPTIMIZATION_UPLOAD_INVALID')),
    ).toBe('SKILL_OPTIMIZATION_UPLOAD_INVALID')
    expect(classifySkillOptimizationError(new Error('something odd'))).toBe(
      SKILL_OPTIMIZATION_ERROR_CODES.FAILED,
    )
  })
})
