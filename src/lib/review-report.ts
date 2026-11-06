/**
 * 评审报告下载（V1.69）。
 *
 * 一句话：把评审列表页**已经加载在浏览器里**的结论导出成可以发给人、可以留档的文件。
 * 这里不新增任何接口 —— `getBatchWorkspace` 已经把 stories / results / evidence /
 * humanReviews 全量取回，报告完全从那份数据组装。没有新的读通道，也就没有新的权限面。
 *
 * **只有一种形态：一个 ZIP，每条需求一个 Markdown 报告，另附一份汇总。**
 * 评审结论的主体是长文本（验收点理由、风险描述、证据说明），Markdown 适合直接发给
 * 负责那条需求的人看；而把同样的内容塞进 Excel 单元格，读的人要先拉宽列、再展开换行。
 * 曾经同时提供过 Excel 汇总，按使用者要求去掉了 —— 留一个不用的导出格式，只会让每次
 * 下载都多一次无意义的选择。
 *
 * 三条贯穿全文件的规矩：
 *
 * 1. **不编没有的结论。** 没有 AI 结果就写「未分析」，没有人工确认就写「待确认」，
 *    批次还没导入过结果就把模型/基线写成「未导入」。空白会被读成"没问题"。
 * 2. **报告必须带出处。** 批次、发布周期、代码基线分支与基线 Commit、模型、分析完成时间、
 *    导出时间 —— 一份不知道"是哪次分析、基于哪个 commit"的报告，过两周就没人敢用。
 * 3. **不执行、不渲染模型输出。** Markdown 只是文本拼接；自由文本只做换行归一。
 *    模型输出是数据，不是代码，也不是可信标记。
 */

import { zipSync, strToU8 } from 'fflate'
import { aiVerdictLabels, humanReviewLabels } from './labels'
// V1.71：完成度与页面共用同一份口径，报告里的百分比不允许自己再算一遍。
import { acceptanceCompletenessOf, averageCompleteness, completenessBreakdown } from './acceptance-completeness'
import type {
  AiCodeEvidence,
  AiImportRecord,
  AiReviewResult,
  HumanReview,
  ReviewBatch,
  ReviewStory,
} from '../types'
import type {
  AcceptanceReviewReport,
  ReviewVerdict,
} from '../../worker/src/ai/review-workflow-types'

/** 一条需求的全部评审事实。全部来自已加载数据，不含任何推断。 */
export interface ReviewReport {
  story: ReviewStory
  result: AiReviewResult | null
  review: HumanReview | null
  evidence: AiCodeEvidence[]
  /** 结构化验收报告；历史批次为 null，此时只能用自由文本字段。 */
  acceptance: AcceptanceReviewReport | null
}

/** 报告出处。没有它，报告过两周就没人敢用。 */
export interface ReviewReportMeta {
  batchName: string
  weekCode: string
  baselineBranch: string
  baselineCommit: string
  model: string
  analyzedAt: string
  exportedAt: string
  /** 本次导出的范围说明（"已勾选 3 条" / "当前筛选结果 12 条"）。 */
  scopeLabel: string
}

export interface BuildReviewReportsInput {
  stories: ReviewStory[]
  results: AiReviewResult[]
  evidence: AiCodeEvidence[]
  humanReviews: HumanReview[]
  /** 要导出的需求 id；不传表示全部。顺序按 stories 的顺序，和页面一致。 */
  storyIds?: readonly string[]
}

const EMPTY = '—'
const NOT_ANALYZED = '未分析'
const NOT_REVIEWED = '待确认'
const NOT_IMPORTED = '未导入'

const originLabels: Record<string, string> = {
  INTRODUCED: '本次引入',
  MISSING_SCENARIO: '遗漏场景',
  EXISTING: '已有隐患',
  UNKNOWN: '归因待确认',
}
const certaintyLabels: Record<string, string> = { CONFIRMED: '已确认', SUSPECTED: '疑似' }

function text(value: string | null | undefined, fallback = EMPTY): string {
  if (value === null || value === undefined) return fallback
  // 自由文本里的 \r\n 与行末空白会在 Markdown 里留下看不见的脏东西。
  const normalized = value.replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').trim()
  return normalized === '' ? fallback : normalized
}

function verdictLabel(verdict: ReviewVerdict | null | undefined): string {
  if (verdict === null || verdict === undefined) return NOT_ANALYZED
  return aiVerdictLabels[verdict] ?? verdict
}

function localTime(value: string | null | undefined, fallback = EMPTY): string {
  if (!value) return fallback
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  // 用使用者本地时区渲染：报告是给人看的，裸 ISO 字符串没人愿意换算。
  return date.toLocaleString('zh-CN', { hour12: false })
}

/** 结构化验收报告只认 version === 1；别的版本当作没有，退回自由文本（不猜新格式）。 */
function acceptanceOf(result: AiReviewResult | null): AcceptanceReviewReport | null {
  const report = result?.acceptance_review ?? null
  return report && report.version === 1 ? report : null
}

export function buildReviewReports(input: BuildReviewReportsInput): ReviewReport[] {
  const resultByStory = new Map(input.results.map((result) => [result.story_id, result]))
  /** 同一条需求可能有多次人工确认，报告只取最后一次 —— 和列表页的口径一致。 */
  const latestReviewByStory = new Map<string, HumanReview>()
  for (const review of input.humanReviews) {
    const current = latestReviewByStory.get(review.story_id)
    if (!current || new Date(review.reviewed_at).getTime() > new Date(current.reviewed_at).getTime()) {
      latestReviewByStory.set(review.story_id, review)
    }
  }
  const evidenceByResult = new Map<string, AiCodeEvidence[]>()
  for (const item of input.evidence) {
    const list = evidenceByResult.get(item.ai_review_result_id)
    if (list) list.push(item)
    else evidenceByResult.set(item.ai_review_result_id, [item])
  }

  const wanted = input.storyIds === undefined ? null : new Set(input.storyIds)
  return input.stories
    .filter((story) => wanted === null || wanted.has(story.id))
    .map((story) => {
      const result = resultByStory.get(story.id) ?? null
      return {
        story,
        result,
        review: latestReviewByStory.get(story.id) ?? null,
        evidence: result ? evidenceByResult.get(result.id) ?? [] : [],
        acceptance: acceptanceOf(result),
      }
    })
}

export function buildReportMeta(
  batch: ReviewBatch,
  activeImport: AiImportRecord | null,
  scopeLabel: string,
  now: Date = new Date(),
): ReviewReportMeta {
  return {
    batchName: text(batch.name),
    weekCode: text(batch.week_code),
    // 分支优先取导入记录里冻结的那个：批次上的 default_branch 之后可能被改过，
    // 而报告要说的是"这次分析用的是哪个分支"。
    baselineBranch: text(activeImport?.baseline_branch ?? batch.default_branch, NOT_IMPORTED),
    baselineCommit: text(activeImport?.baseline_commit, NOT_IMPORTED),
    model: text(activeImport?.ai_model ?? batch.ai_model_snapshot?.display_name ?? null, NOT_IMPORTED),
    analyzedAt: localTime(activeImport?.analyzed_at, NOT_IMPORTED),
    exportedAt: localTime(now.toISOString()),
    scopeLabel,
  }
}

/**
 * 下载按钮的范围文案与可用性。
 *
 * 为什么要把它做成一个函数并单独测：按钮上那句话是使用者判断"我下载的是哪些"的唯一依据。
 * 写成"下载全部"而实际导出的是筛选结果（或反过来），人就会拿着一份不完整的报告去开会。
 */
export function reportScopeLabel(input: {
  selectedCount: number
  filteredCount: number
  filterActive: boolean
}): { label: string; scope: 'SELECTED' | 'FILTERED'; disabled: boolean; count: number } {
  if (input.selectedCount > 0) {
    return {
      label: `下载评审报告（已勾选 ${input.selectedCount} 条）`,
      scope: 'SELECTED',
      disabled: false,
      count: input.selectedCount,
    }
  }
  return {
    label: input.filterActive
      ? `下载评审报告（当前筛选 ${input.filteredCount} 条）`
      : `下载评审报告（全部 ${input.filteredCount} 条）`,
    scope: 'FILTERED',
    disabled: input.filteredCount === 0,
    count: input.filteredCount,
  }
}

// ---------------------------------------------------------------------------
// 文件名
// ---------------------------------------------------------------------------

/**
 * 文件名片段净化。
 *
 * 批次名和需求名是人填的，里面出现 `/`、`:`、`?` 很常见（例如「【console】mcp服务/类型」）。
 * 不处理的话，浏览器下载会把路径截断，或者 ZIP 里出现一层意料之外的目录。
 */
export function safeFileSegment(value: string, maxLength = 60): string {
  const cleaned = value
    .replace(/[\\/:*?"<>|]/g, '_')
    // 控制字符与首尾的点会让部分系统把文件视为隐藏或非法。
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+|\.+$/g, '')
  const trimmed = cleaned.slice(0, maxLength).trim()
  return trimmed === '' ? '未命名' : trimmed
}

export function archiveFileName(meta: ReviewReportMeta, count: number): string {
  return `${safeFileSegment(meta.weekCode, 20)}-${safeFileSegment(meta.batchName, 40)}-评审报告${count}条.zip`
}

export function storyFileName(report: ReviewReport): string {
  return `${safeFileSegment(report.story.story_code, 40)}-${safeFileSegment(report.story.story_name, 40)}.md`
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

function metaLines(meta: ReviewReportMeta): string[] {
  return [
    `- 批次：${meta.batchName}`,
    `- 发布周期：${meta.weekCode}`,
    `- 代码基线分支：${meta.baselineBranch}`,
    `- 基线 Commit：${meta.baselineCommit}`,
    `- 分析模型：${meta.model}`,
    `- 分析完成时间：${meta.analyzedAt}`,
    `- 导出时间：${meta.exportedAt}（导出范围：${meta.scopeLabel}）`,
  ]
}

function evidenceLines(items: AiCodeEvidence[], indent = ''): string[] {
  if (items.length === 0) return [`${indent}- （无代码证据）`]
  return items.map((item) => {
    const lines =
      item.start_line === null
        ? ''
        : `：${item.start_line}${item.end_line && item.end_line !== item.start_line ? `-${item.end_line}` : ''} 行`
    const where = `${item.repository_name} / ${item.file_path}${lines}`
    const title = text(item.evidence_summary ?? item.description)
    const detail = item.evidence_summary ? text(item.description, '') : ''
    return [
      `${indent}- [${item.evidence_type}] ${title}`,
      `${indent}  - 位置：${where}`,
      item.commit_sha ? `${indent}  - 代码版本：${item.commit_sha}` : null,
      detail === '' ? null : `${indent}  - 说明：${detail}`,
    ]
      .filter((line): line is string => line !== null)
      .join('\n')
  })
}

/** 一条需求的 Markdown 报告。 */
export function renderReviewReportMarkdown(report: ReviewReport, meta: ReviewReportMeta): string {
  const { story, result, review, acceptance } = report
  const completeness = acceptanceCompletenessOf(acceptance)
  const evidenceById = new Map(report.evidence.map((item) => [item.evidence_id || item.id, item]))
  const pick = (ids: readonly string[]) =>
    ids.map((id) => evidenceById.get(id)).filter((item): item is AiCodeEvidence => item !== undefined)

  const lines: string[] = [
    `# ${story.story_code} ${story.story_name}`,
    '',
    ...metaLines(meta),
    '',
    '## 需求信息',
    '',
    `- 所属项目组：${text(story.project_name)}`,
    `- 发布窗口：${text(story.release_window)}`,
    `- 需求状态：${text(story.source_status)}`,
    `- 开发人员：${text(story.owners_text)}`,
    `- 需求人员：${text(story.requirement_handlers)}`,
    `- 测试人员：${text(story.test_handlers)}`,
    '',
    '## AI 评审结论',
    '',
    `- 总体判断：${verdictLabel(result?.verdict ?? null)}`,
    // 完成度与置信度二选一：V1.43 之后的批次置信度一律为 NULL（平台不再要求模型自评），
    // 写一行恒为空的「置信度：—」只会让人以为数据丢了。
    ...(completeness
      ? [`- 完成度：${completeness.percent}%（${completenessBreakdown(completeness)}）`]
      : [`- 置信度：${result?.confidence === null || result?.confidence === undefined ? EMPTY : `${result.confidence}%`}`]),
    `- 代码证据：${report.evidence.length} 条`,
    '',
    `### 分析摘要\n\n${result ? text(result.summary, '（无摘要）') : `（${NOT_ANALYZED}）`}`,
    '',
  ]

  if (acceptance !== null) {
    const findingByCriterion = new Map(acceptance.findings.map((finding) => [finding.criterionId, finding]))
    lines.push(`### 验收点（${acceptance.criteria.length} 项）`, '')
    for (const point of acceptance.criteria) {
      const finding = findingByCriterion.get(point.id)
      lines.push(
        `#### ${point.id} ${point.description}${point.needsClarification ? '（需求待澄清）' : ''}`,
        '',
        `- 结论：${verdictLabel(finding?.verdict ?? null)}`,
        `- 理由：${text(finding?.reason, '（该验收点缺少结论，需进一步确认）')}`,
      )
      if (finding?.disagreement) {
        // 分歧必须写出来：它是"这一条结论不能直接采信"的唯一信号。
        lines.push(
          `- ⚠️ 独立复核存在分歧：调查判定 ${verdictLabel(finding.disagreement.investigationVerdict)}，` +
            `复核判定 ${verdictLabel(finding.disagreement.reviewVerdict)}`,
          `  - 调查理由：${text(finding.disagreement.investigationReason)}`,
          `  - 复核理由：${text(finding.disagreement.reviewReason)}`,
        )
      }
      lines.push('- 依据：', ...evidenceLines(pick(finding?.evidenceIds ?? []), '  '), '')
    }

    lines.push(`### 风险（${acceptance.risks.length} 项）`, '')
    if (acceptance.risks.length === 0) lines.push('（未发现风险）', '')
    for (const risk of acceptance.risks) {
      const riskLines: Array<string | null> = [
        `#### ${risk.id} ${risk.title}`,
        '',
        `- 确定性：${certaintyLabels[risk.certainty] ?? risk.certainty}　归因：${originLabels[risk.origin] ?? risk.origin}`,
        `- 触发条件：${text(risk.trigger)}`,
        `- 影响：${text(risk.impact)}`,
        `- 关联验收点：${risk.criterionIds.length > 0 ? risk.criterionIds.join('、') : EMPTY}`,
        risk.reviewNote ? `- 复核备注：${text(risk.reviewNote)}` : null,
        '- 依据：',
        ...evidenceLines(pick(risk.evidenceIds), '  '),
        '',
      ]
      lines.push(...riskLines.filter((line): line is string => line !== null))
    }

    lines.push(
      `### 独立复核`,
      '',
      `- 状态：${acceptance.verification.status === 'DISAGREEMENT' ? '存在分歧' : '已确认'}`,
      `- 分歧验收点：${acceptance.verification.disagreementIds.length > 0 ? acceptance.verification.disagreementIds.join('、') : '无'}`,
      `- 分歧风险：${acceptance.verification.riskDisagreementIds.length > 0 ? acceptance.verification.riskDisagreementIds.join('、') : '无'}`,
      `- 补查轮次：${acceptance.supplementRounds}`,
      '',
    )
  } else if (result !== null) {
    // 历史批次没有逐项验收结论。必须说明是历史格式，否则会被当成"这次分析没做验收点"。
    lines.push(
      '### 逐项验收结论',
      '',
      '（这是历史格式的报告，没有逐项验收点与独立复核；以下为当时的自由文本结论）',
      '',
      `#### 已实现内容\n\n${text(result.implemented_content, '（未填写）')}`,
      '',
      `#### 缺失内容\n\n${text(result.missing_content, '（未填写）')}`,
      '',
      `#### 风险\n\n${text(result.risks, '（未填写）')}`,
      '',
      `#### 建议测试点\n\n${text(result.test_points, '（未填写）')}`,
      '',
      `#### AI 备注\n\n${text(result.ai_remark, '（无）')}`,
      '',
    )
  }

  lines.push(
    `## 代码证据（${report.evidence.length} 条）`,
    '',
    ...evidenceLines(report.evidence),
    '',
    '## 人工结论',
    '',
    `- 结论：${review ? humanReviewLabels[review.result] ?? review.result : NOT_REVIEWED}`,
    `- 补充意见：${review ? text(review.comment, '（无）') : EMPTY}`,
    `- 确认时间：${review ? localTime(review.reviewed_at) : EMPTY}`,
    '',
  )

  return lines.filter((line): line is string => line !== null && line !== undefined).join('\n')
}

/** ZIP 里的汇总文件：一眼看完这批需求的结论分布。 */
export function renderReviewSummaryMarkdown(reports: ReviewReport[], meta: ReviewReportMeta): string {
  const counts = new Map<string, number>()
  for (const report of reports) {
    const label = verdictLabel(report.result?.verdict ?? null)
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }
  const completenessByReport = new Map(reports.map((report) => [report, acceptanceCompletenessOf(report.acceptance)]))
  // 平均值只算有逐项验收结论的需求，并把分母写出来：把"未分析"当 0% 平均进去，
  // 会得到一个越拖越低、谁也不认的数。
  const average = averageCompleteness([...completenessByReport.values()])
  const pending = reports.filter((report) => report.review === null).length
  return [
    `# 评审报告汇总（${reports.length} 条需求）`,
    '',
    ...metaLines(meta),
    '',
    '## 结论分布',
    '',
    ...[...counts.entries()].map(([label, count]) => `- ${label}：${count} 条`),
    ...(average.counted > 0 ? [`- 平均完成度：${average.percent}%（基于 ${average.counted} 条有逐项验收结论的需求）`] : []),
    `- 人工待确认：${pending} 条`,
    '',
    '## 需求清单',
    '',
    '| 编码 | 需求名称 | 完成度 | AI 判断 | 证据 | 人工结论 |',
    '| --- | --- | --- | --- | --- | --- |',
    ...reports.map((report) => {
      const completeness = completenessByReport.get(report) ?? null
      const completenessText = completeness === null ? EMPTY : `${completeness.percent}%`
      const human = report.review
        ? humanReviewLabels[report.review.result] ?? report.review.result
        : NOT_REVIEWED
      // 需求名称里的 | 会把 Markdown 表格列切错。
      const name = report.story.story_name.replace(/\|/g, '\\|')
      return `| ${report.story.story_code} | ${name} | ${completenessText} | ${verdictLabel(report.result?.verdict ?? null)} | ${report.evidence.length} 条 | ${human} |`
    }),
    '',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// 下载入口（本文件里唯一有副作用的两个函数）
// ---------------------------------------------------------------------------

/** 浏览器下载一个 Blob。 */
function saveBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  // 立刻 revoke 会让部分浏览器的下载拿不到数据，留一拍再回收。
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

export function downloadReviewReportsZip(reports: ReviewReport[], meta: ReviewReportMeta) {
  const files: Record<string, Uint8Array> = {
    '00-汇总.md': strToU8(renderReviewSummaryMarkdown(reports, meta)),
  }
  const used = new Set(Object.keys(files))
  for (const report of reports) {
    let name = storyFileName(report)
    // 同名文件会在 ZIP 里互相覆盖。编码在一个批次内唯一，但不靠这个假设。
    if (used.has(name)) {
      let index = 2
      const base = name.replace(/\.md$/, '')
      while (used.has(`${base}-${index}.md`)) index += 1
      name = `${base}-${index}.md`
    }
    used.add(name)
    files[name] = strToU8(renderReviewReportMarkdown(report, meta))
  }
  const zipped = zipSync(files, { level: 6 })
  // Uint8Array -> Blob：用 slice 保证底层 buffer 刚好是这段数据。
  saveBlob(new Blob([zipped.slice()], { type: 'application/zip' }), archiveFileName(meta, reports.length))
}
