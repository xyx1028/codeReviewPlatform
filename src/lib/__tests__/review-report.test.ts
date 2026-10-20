/**
 * 评审报告下载（V1.69）。
 *
 * 只测纯逻辑：报告组装、范围文案、文件名净化、Markdown 与 Sheet 的内容。
 * 两个下载入口（写文件）不在这里测 —— 它们只是把下面这些产物交给浏览器。
 *
 * 这一组盯住的是"报告会不会骗人"：
 *   · 未分析、未确认必须如实写出来，不能留空（空白会被读成"没问题"）；
 *   · 出处（批次/基线/模型/时间）必须在报告里；
 *   · 结构化验收报告与历史自由文本是两种形态，后者必须标明是历史格式；
 *   · 按钮上的范围文案必须和实际导出的范围一致。
 */

import { describe, expect, it } from 'vitest'
import {
  buildReportMeta,
  buildReviewReportSheets,
  buildReviewReports,
  renderReviewReportMarkdown,
  renderReviewSummaryMarkdown,
  reportScopeLabel,
  safeFileSegment,
  storyFileName,
  workbookFileName,
} from '../review-report'
import type { AiCodeEvidence, AiImportRecord, AiReviewResult, HumanReview, ReviewBatch, ReviewStory } from '../../types'
import type { AcceptanceReviewReport } from '../../../worker/src/ai/review-workflow-types'

function story(overrides: Partial<ReviewStory> = {}): ReviewStory {
  return {
    id: 'story-1',
    batch_id: 'batch-1',
    story_code: 'US-2026-042424',
    story_name: '【内置连接器】给前端增加 nacos 标识',
    description: null,
    acceptance_criteria: null,
    owners_text: '王鹏程',
    requirement_handlers: '武晨曦',
    test_handlers: '秦亚惊',
    project_name: '工具开发组',
    cloud_name: null,
    application_name: null,
    iteration_name: null,
    release_window: 'R20261106',
    source_status: '提测完成',
    ...overrides,
  } as ReviewStory
}

function result(overrides: Partial<AiReviewResult> = {}): AiReviewResult {
  return {
    id: 'result-1',
    story_id: 'story-1',
    ai_import_record_id: 'import-1',
    verdict: 'PARTIAL',
    confidence: 80,
    summary: '核心链路已实现，缺少异常分支。',
    implemented_content: '已实现 A',
    missing_content: '缺少 B',
    risks: '风险 C',
    test_points: '测试点 D',
    ai_remark: null,
    analysis_detail_items: null,
    acceptance_review: null,
    created_at: '2026-10-20T10:00:00.000Z',
    updated_at: '2026-10-20T10:00:00.000Z',
    ...overrides,
  }
}

function evidence(overrides: Partial<AiCodeEvidence> = {}): AiCodeEvidence {
  return {
    id: 'ev-1',
    evidence_id: 'E1',
    ai_review_result_id: 'result-1',
    repository_name: 'kdmanage-backend',
    commit_sha: 'abc123',
    file_path: 'src/main/java/Nacos.java',
    symbol_name: 'NacosService#flag',
    start_line: 10,
    end_line: 24,
    evidence_type: '现有实现',
    evidence_summary: '写入 nacos 标识',
    description: '在保存连接器时写入内置标识。',
    created_at: '2026-10-20T10:00:00.000Z',
    updated_at: '2026-10-20T10:00:00.000Z',
    ...overrides,
  }
}

function acceptanceReport(): AcceptanceReviewReport {
  return {
    version: 1,
    criteria: [
      { id: 'AC-1', description: '前端展示内置标识', needsClarification: false, sources: [] },
      { id: 'AC-2', description: '异常分支提示', needsClarification: true, sources: [] },
    ],
    findings: [
      { criterionId: 'AC-1', verdict: 'IMPLEMENTED', reason: '已在列表渲染标识。', evidenceIds: ['E1'] },
      {
        criterionId: 'AC-2',
        verdict: 'UNCERTAIN',
        reason: '没有找到异常分支处理。',
        evidenceIds: [],
        disagreement: {
          investigationVerdict: 'NOT_IMPLEMENTED',
          investigationReason: '调查没找到代码。',
          investigationEvidenceIds: [],
          reviewVerdict: 'UNCERTAIN',
          reviewReason: '复核认为需求本身不清楚。',
          reviewEvidenceIds: [],
        },
      },
    ],
    risks: [
      {
        id: 'R-1',
        criterionIds: ['AC-2'],
        title: '异常分支缺失可能导致脏数据',
        trigger: '保存失败时重试',
        impact: '连接器状态不一致',
        certainty: 'SUSPECTED',
        origin: 'MISSING_SCENARIO',
        evidenceIds: ['E1'],
        reviewNote: '建议补充回滚',
      },
    ],
    sources: [{ id: 'S1', label: '需求正文' }],
    supplementRounds: 1,
    verification: {
      status: 'DISAGREEMENT',
      investigationAgentId: 'a1',
      verificationAgentId: 'a2',
      disagreementIds: ['AC-2'],
      riskDisagreementIds: [],
    },
  }
}

const BATCH: ReviewBatch = {
  id: 'batch-1',
  name: 'MCP 评审：US-2026-042424',
  week_code: '20261020',
  status: 'REVIEWING',
  default_branch: 'release',
  remark: null,
  created_by: 'u1',
  completed_at: null,
  ai_model_config_id: 'm1',
  ai_model_snapshot: null,
  created_at: '2026-10-20T10:00:00.000Z',
  updated_at: '2026-10-20T10:00:00.000Z',
}

const IMPORT: AiImportRecord = {
  id: 'import-1',
  batch_id: 'batch-1',
  import_file_id: null,
  version: 1,
  baseline_branch: 'release',
  baseline_commit: '{"actual_branch":"release"}',
  ai_model: 'glm5.3-flash',
  ai_model_config_id: 'm1',
  analyzed_at: '2026-10-20T11:00:00.000Z',
  imported_by: 'u1',
  is_active: true,
  created_at: '2026-10-20T11:00:00.000Z',
  updated_at: '2026-10-20T11:00:00.000Z',
}

const review: HumanReview = {
  id: 'hr-1',
  story_id: 'story-1',
  ai_review_result_id: 'result-1',
  reviewer_id: 'u1',
  result: 'PARTIALLY_CORRECT',
  comment: '需要补充异常分支',
  reviewed_at: '2026-10-20T12:00:00.000Z',
  created_at: '2026-10-20T12:00:00.000Z',
  updated_at: '2026-10-20T12:00:00.000Z',
}

const META = buildReportMeta(BATCH, IMPORT, '已勾选 1 条', new Date('2026-10-20T13:00:00.000Z'))

describe('评审报告组装', () => {
  it('按选中的需求组装，并关联结果、最新人工确认与证据', () => {
    const second = story({ id: 'story-2', story_code: 'US-2' })
    const older: HumanReview = { ...review, id: 'hr-0', result: 'CORRECT', reviewed_at: '2026-10-19T12:00:00.000Z' }
    const reports = buildReviewReports({
      stories: [story(), second],
      results: [result()],
      evidence: [evidence()],
      // 同一条需求有两次确认，报告必须取最后那次（和列表页口径一致）。
      humanReviews: [older, review],
      storyIds: ['story-1'],
    })
    expect(reports).toHaveLength(1)
    expect(reports[0].story.story_code).toBe('US-2026-042424')
    expect(reports[0].review?.result).toBe('PARTIALLY_CORRECT')
    expect(reports[0].evidence).toHaveLength(1)
  })

  it('不传 storyIds 就是全部；没有 AI 结果的需求照样进报告', () => {
    const reports = buildReviewReports({
      stories: [story(), story({ id: 'story-2', story_code: 'US-2' })],
      results: [],
      evidence: [],
      humanReviews: [],
    })
    expect(reports).toHaveLength(2)
    expect(reports[0].result).toBeNull()
    expect(reports[0].acceptance).toBeNull()
  })

  it('只认 version === 1 的结构化验收报告，别的版本退回自由文本', () => {
    const unknownVersion = { ...acceptanceReport(), version: 2 } as unknown as AcceptanceReviewReport
    const reports = buildReviewReports({
      stories: [story()],
      results: [result({ acceptance_review: unknownVersion })],
      evidence: [],
      humanReviews: [],
    })
    expect(reports[0].acceptance).toBeNull()
  })
})

describe('报告出处', () => {
  it('批次、基线、模型、时间都要在 meta 里', () => {
    expect(META.batchName).toBe('MCP 评审：US-2026-042424')
    expect(META.weekCode).toBe('20261020')
    expect(META.baselineBranch).toBe('release')
    expect(META.baselineCommit).toContain('actual_branch')
    expect(META.model).toBe('glm5.3-flash')
    expect(META.analyzedAt).not.toBe('未导入')
    expect(META.scopeLabel).toBe('已勾选 1 条')
  })

  it('批次还没有导入记录时写"未导入"，不编一个模型出来', () => {
    const meta = buildReportMeta({ ...BATCH, default_branch: null }, null, '全部 2 条')
    expect(meta.model).toBe('未导入')
    expect(meta.baselineCommit).toBe('未导入')
    expect(meta.analyzedAt).toBe('未导入')
    expect(meta.baselineBranch).toBe('未导入')
  })
})

describe('下载范围文案', () => {
  it('勾选优先，并写明条数', () => {
    const scope = reportScopeLabel({ selectedCount: 3, filteredCount: 12, filterActive: true })
    expect(scope.scope).toBe('SELECTED')
    expect(scope.count).toBe(3)
    expect(scope.label).toContain('已勾选 3 条')
    expect(scope.disabled).toBe(false)
  })

  it('没勾选时区分"当前筛选"和"全部"——两者混用会让人拿错报告', () => {
    expect(reportScopeLabel({ selectedCount: 0, filteredCount: 12, filterActive: true }).label).toContain('当前筛选 12 条')
    expect(reportScopeLabel({ selectedCount: 0, filteredCount: 12, filterActive: false }).label).toContain('全部 12 条')
  })

  it('一条都没有时禁用，不生成空文件', () => {
    const scope = reportScopeLabel({ selectedCount: 0, filteredCount: 0, filterActive: true })
    expect(scope.disabled).toBe(true)
  })
})

describe('文件名', () => {
  it('路径分隔符与非法字符被替换，不会多出一层目录', () => {
    expect(safeFileSegment('a/b:c*d?e"f<g>h|i')).toBe('a_b_c_d_e_f_g_h_i')
    expect(safeFileSegment('   ')).toBe('未命名')
    expect(safeFileSegment('.hidden.')).toBe('hidden')
    expect(safeFileSegment('x'.repeat(100), 10)).toHaveLength(10)
  })

  it('工作簿与单条文件名都带编码/批次，便于归档', () => {
    expect(workbookFileName(META, 3)).toBe('20261020-MCP 评审：US-2026-042424-评审报告3条.xlsx')
    const name = storyFileName({ story: story({ story_name: 'a/b' }), result: null, review: null, evidence: [], acceptance: null })
    expect(name).toBe('US-2026-042424-a_b.md')
  })
})

describe('Markdown 报告', () => {
  const reports = buildReviewReports({
    stories: [story()],
    results: [result({ acceptance_review: acceptanceReport() })],
    evidence: [evidence()],
    humanReviews: [review],
  })
  const text = renderReviewReportMarkdown(reports[0], META)

  it('含需求信息、出处与 AI 结论', () => {
    expect(text).toContain('# US-2026-042424 【内置连接器】给前端增加 nacos 标识')
    expect(text).toContain('- 分析模型：glm5.3-flash')
    expect(text).toContain('- 总体判断：部分实现')
    expect(text).toContain('- 置信度：80%')
    expect(text).toContain('核心链路已实现，缺少异常分支。')
  })

  it('逐项列出验收点、风险与代码证据', () => {
    expect(text).toContain('#### AC-1 前端展示内置标识')
    expect(text).toContain('#### AC-2 异常分支提示（需求待澄清）')
    expect(text).toContain('- 结论：已实现')
    expect(text).toContain('kdmanage-backend / src/main/java/Nacos.java：10-24 行')
    expect(text).toContain('#### R-1 异常分支缺失可能导致脏数据')
    expect(text).toContain('归因：遗漏场景')
    expect(text).toContain('- 复核备注：建议补充回滚')
  })

  it('独立复核的分歧必须写出来——它是"这条结论不能直接采信"的唯一信号', () => {
    expect(text).toContain('⚠️ 独立复核存在分歧')
    expect(text).toContain('调查判定 未实现')
    expect(text).toContain('复核判定 无法判断')
    expect(text).toContain('- 状态：存在分歧')
    expect(text).toContain('- 分歧验收点：AC-2')
  })

  it('人工结论与意见进报告', () => {
    expect(text).toContain('- 结论：AI分析部分正确')
    expect(text).toContain('- 补充意见：需要补充异常分支')
  })

  it('未分析、未确认如实写出来，不留空', () => {
    const plain = buildReviewReports({ stories: [story()], results: [], evidence: [], humanReviews: [] })
    const output = renderReviewReportMarkdown(plain[0], META)
    expect(output).toContain('- 总体判断：未分析')
    expect(output).toContain('（未分析）')
    expect(output).toContain('- 结论：待确认')
    expect(output).toContain('- （无代码证据）')
  })

  it('历史格式的报告必须标明是历史格式，不能被当成"这次没做验收点"', () => {
    const legacy = buildReviewReports({
      stories: [story()],
      results: [result()],
      evidence: [],
      humanReviews: [],
    })
    const output = renderReviewReportMarkdown(legacy[0], META)
    expect(output).toContain('这是历史格式的报告')
    expect(output).toContain('#### 已实现内容')
    expect(output).toContain('已实现 A')
    // 没有结构化报告就不该出现「独立复核」这一节（说明句里提到它是另一回事）。
    expect(output).not.toContain('### 独立复核')
    expect(output).not.toContain('### 验收点')
  })

  it('汇总表给出结论分布，并转义需求名里的竖线', () => {
    const summary = renderReviewSummaryMarkdown(
      buildReviewReports({
        stories: [story({ story_name: 'a|b' }), story({ id: 'story-2', story_code: 'US-2' })],
        results: [result()],
        evidence: [],
        humanReviews: [],
      }),
      META,
    )
    expect(summary).toContain('# 评审报告汇总（2 条需求）')
    expect(summary).toContain('- 部分实现：1 条')
    expect(summary).toContain('- 未分析：1 条')
    expect(summary).toContain('- 人工待确认：2 条')
    expect(summary).toContain('a\\|b')
  })
})

describe('Excel 报告', () => {
  const reports = buildReviewReports({
    stories: [story()],
    results: [result({ acceptance_review: acceptanceReport() })],
    evidence: [evidence()],
    humanReviews: [review],
  })
  const sheets = buildReviewReportSheets(reports, META)
  const byName = new Map(sheets.map((sheet) => [sheet.sheet, sheet.rows]))

  it('五个 Sheet：批次信息 / 需求评审 / 验收点 / 风险 / 代码证据', () => {
    expect(sheets.map((sheet) => sheet.sheet)).toEqual(['批次信息', '需求评审', '验收点', '风险', '代码证据'])
  })

  it('批次信息带出处与条数统计', () => {
    const rows = byName.get('批次信息') ?? []
    const map = new Map(rows.map((row) => [String(row[0]), row[1]]))
    expect(map.get('分析模型')).toBe('glm5.3-flash')
    expect(map.get('导出范围')).toBe('已勾选 1 条')
    expect(map.get('导出需求数')).toBe(1)
    expect(map.get('其中有 AI 结果')).toBe(1)
    expect(map.get('其中已人工确认')).toBe(1)
  })

  it('需求评审一行一条，含判断、统计与人工结论', () => {
    const rows = byName.get('需求评审') ?? []
    expect(rows).toHaveLength(2)
    const row = rows[1]
    expect(row[0]).toBe('US-2026-042424')
    expect(row[8]).toBe('部分实现')
    expect(row[9]).toBe(80)
    expect(row[10]).toBe(2) // 验收点数
    expect(row[11]).toBe(1) // 未确认验收点数（UNCERTAIN）
    expect(row[12]).toBe(1) // 风险数
    expect(row[13]).toBe(1) // 证据数
    expect(row[14]).toBe('存在分歧')
    expect(row[15]).toBe('AI分析部分正确')
  })

  it('验收点/风险/证据是一对多，各自一行', () => {
    expect((byName.get('验收点') ?? []).slice(1)).toHaveLength(2)
    expect((byName.get('风险') ?? []).slice(1)).toHaveLength(1)
    expect((byName.get('代码证据') ?? []).slice(1)).toHaveLength(1)
    const criterion = (byName.get('验收点') ?? [])[2]
    expect(criterion[1]).toBe('AC-2')
    expect(criterion[3]).toBe('是') // 需求待澄清
    expect(criterion[7]).toBe('是') // 复核分歧
    const evidenceRow = (byName.get('代码证据') ?? [])[1]
    expect(evidenceRow[3]).toBe('src/main/java/Nacos.java')
    expect(evidenceRow[5]).toBe(10)
  })

  it('没有结构化报告时统计列写占位，不写 0（0 会被当成"确实是 0 个验收点"）', () => {
    const legacy = buildReviewReportSheets(
      buildReviewReports({ stories: [story()], results: [result()], evidence: [], humanReviews: [] }),
      META,
    )
    const row = (new Map(legacy.map((sheet) => [sheet.sheet, sheet.rows])).get('需求评审') ?? [])[1]
    expect(row[10]).toBe('—')
    expect(row[12]).toBe('—')
    expect(row[14]).toBe('—')
  })
})
