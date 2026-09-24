import { readSheet } from 'read-excel-file/browser'
import writeXlsxFile from 'write-excel-file/browser'
import type { Cell, Sheet } from 'write-excel-file/browser'
import { parseBaselineCommit } from './baseline'
import type {
  AiEvidenceInput,
  AiResultInput,
  AiVerdict,
  BaselineCommit,
  EvidenceType,
  ReviewBatch,
  ReviewStory,
  ValidationIssue,
} from '../types'


/**
 * 1.2 起「需求评审」sheet 去掉了「所属应用」列（新版导出没有应用维度），
 * 而且「负责人」列的口径从需求人员改成开发人员。两者都会让 1.1 模板回读时
 * 撞上「原始需求字段被修改」这种误导性报错，所以必须 bump，让用户直接看到
 * 「不支持的模板版本」并重新下载。
 */
export const templateVersion = '1.2'

const reviewSheetName = '需求评审'
const evidenceSheetName = '代码证据'
const batchSheetName = '批次信息'

const reviewColumns = [
  '用户故事编码',
  '用户故事名称',
  '负责人',
  '所属项目',
  'AI判断',
  '置信度',
  '分析摘要',
  '已实现内容',
  '缺失内容',
  '风险',
  '建议测试点',
  'AI备注',
]

const evidenceColumns = [
  '用户故事编码',
  '仓库',
  'Commit',
  '文件路径',
  '类/方法',
  '开始行',
  '结束行',
  '证据类型',
  '证据说明',
]

const verdictByLabel: Record<string, AiVerdict> = {
  已实现: 'IMPLEMENTED',
  部分实现: 'PARTIAL',
  未实现: 'NOT_IMPLEMENTED',
  无法判断: 'UNCERTAIN',
  IMPLEMENTED: 'IMPLEMENTED',
  PARTIAL: 'PARTIAL',
  NOT_IMPLEMENTED: 'NOT_IMPLEMENTED',
  UNCERTAIN: 'UNCERTAIN',
}

const evidenceTypes = new Set<EvidenceType>(['现有实现', '缺失依据', '风险依据'])

type SheetData = CellValue[][]
type CellValue = string | number | boolean | Date | null
type ExportCell = Exclude<Cell, undefined>

export interface AiParseResult {
  batchInfo: Record<string, string>
  baselineCommit: BaselineCommit | null
  analyzedAt: string | null
  results: AiResultInput[]
  evidence: AiEvidenceInput[]
  issues: ValidationIssue[]
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (value instanceof Date) return value.toISOString()
  return String(value).trim()
}

function nullableText(value: unknown) {
  const valueText = cellText(value)
  return valueText ? valueText : null
}

function numeric(value: unknown) {
  const valueText = cellText(value)
  if (!valueText) return null
  const parsed = Number(valueText)
  return Number.isFinite(parsed) ? parsed : null
}

function confidenceNumber(value: unknown) {
  const valueText = cellText(value)
  if (!valueText) return null
  const normalizedText = valueText.endsWith('%') ? valueText.slice(0, -1).trim() : valueText
  const parsed = Number(normalizedText)
  if (!Number.isFinite(parsed)) return null
  return !valueText.endsWith('%') && parsed > 0 && parsed <= 1 ? Math.round(parsed * 100) : parsed
}

function rowsToObjects(rows: SheetData, headerRowIndex = 0): Record<string, unknown>[] {
  const headers = rows[headerRowIndex]?.map((value) => cellText(value)) ?? []
  return rows.slice(headerRowIndex + 1).map((row) => {
    const item: Record<string, unknown> = {}
    headers.forEach((header, index) => {
      if (header) item[header] = row[index] ?? ''
    })
    return item
  })
}

function textCell(value: CellValue, bold = false): ExportCell {
  const cellValue = value ?? ''
  return bold ? { value: cellValue, fontWeight: 'bold' } : { value: cellValue }
}

export async function downloadAiTemplate(batch: ReviewBatch, stories: ReviewStory[]) {
  const metadataRows = [
    ['字段', '值', '说明'],
    ['template_version', templateVersion, '模板版本，不允许修改'],
    ['batch_id', batch.id, '批次ID，不允许修改'],
    ['batch_name', batch.name, '批次名称'],
    ['week_code', batch.week_code, '周标识'],
    ['baseline_branch', batch.default_branch ?? '', '系统生成，禁止修改'],
    ['baseline_commit', '', 'AI必填：格式化JSON，包含 actual_branch 和 commits（repository、完整sha、可选subject）'],
    ['ai_model', '', 'AI必填：实际使用的模型或工具'],
    ['analyzed_at', '', 'AI必填：带时区ISO时间，例如 2026-09-07T18:00:00+08:00'],
  ].map((row, rowIndex) => row.map((value) => textCell(value, rowIndex === 0)))

  const reviewRows = [
    reviewColumns,
    ...stories.map((story) => [
      story.story_code,
      story.story_name,
      story.owners_text,
      story.project_name ?? '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
    ]),
  ].map((row, rowIndex) => row.map((value) => textCell(value, rowIndex === 0)))

  const evidenceRows = [evidenceColumns, ['', '', '', '', '', '', '', '', '']].map((row, rowIndex) => row.map((value) => textCell(value, rowIndex === 0)))

  const sheets: Sheet<Blob>[] = [
    { sheet: batchSheetName, data: metadataRows },
    { sheet: reviewSheetName, data: reviewRows },
    { sheet: evidenceSheetName, data: evidenceRows },
  ]

  await writeXlsxFile(sheets).toFile(`${batch.week_code}-AI需求代码一致性评审模板.xlsx`)
}

export async function parseAiWorkbook(file: File, batch: ReviewBatch, stories: ReviewStory[]): Promise<AiParseResult> {
  const issues: ValidationIssue[] = []
  const storyByCode = new Map(stories.map((story) => [story.story_code, story]))
  let metadataRows: Record<string, unknown>[] = []
  let reviewRows: Record<string, unknown>[] = []
  let evidenceRows: Record<string, unknown>[] = []

  try {
    metadataRows = rowsToObjects(await readSheet(file, batchSheetName) as unknown as SheetData)
    reviewRows = rowsToObjects(await readSheet(file, reviewSheetName) as unknown as SheetData)
    evidenceRows = rowsToObjects(await readSheet(file, evidenceSheetName) as unknown as SheetData)
  } catch {
    return {
      batchInfo: {},
      baselineCommit: null,
      analyzedAt: null,
      results: [],
      evidence: [],
      issues: [{ level: 'error', message: '缺少必需 Sheet：批次信息、需求评审或代码证据' }],
    }
  }

  const batchInfo = Object.fromEntries(metadataRows.map((row) => [cellText(row['字段']), cellText(row['值'])]).filter(([key]) => key))

  if (batchInfo.template_version !== templateVersion) issues.push({ level: 'error', message: `不支持的模板版本：${batchInfo.template_version || '空'}` })
  if (batchInfo.batch_id !== batch.id) issues.push({ level: 'error', message: '模板 batch_id 与当前批次不一致' })
  if (!batch.default_branch) issues.push({ level: 'error', message: '当前批次未配置默认代码基线分支' })
  if (batch.default_branch && !['feature_dev', 'feature_sit', 'release'].includes(batch.default_branch)) {
    issues.push({ level: 'error', message: '当前批次使用了不受支持的基线分支，请先在 AI 结果管理中重新设置分支' })
  }
  if (batchInfo.baseline_branch !== batch.default_branch) issues.push({ level: 'error', message: 'baseline_branch 与批次配置分支不一致，请重新下载模板' })
  if (!batchInfo.baseline_commit) issues.push({ level: 'error', message: '批次信息缺少必填字段：baseline_commit' })
  if (!batchInfo.ai_model) issues.push({ level: 'error', message: '批次信息缺少必填字段：ai_model' })
  if (!batchInfo.analyzed_at) issues.push({ level: 'error', message: '批次信息缺少必填字段：analyzed_at' })

  const baselineCommit = batchInfo.baseline_commit ? parseBaselineCommit(batchInfo.baseline_commit) : null
  if (baselineCommit) batchInfo.baseline_commit = JSON.stringify(baselineCommit, null, 2)
  else if (batchInfo.baseline_commit) issues.push({ level: 'warning', message: 'baseline_commit 未遵循多仓库 JSON 格式，将按原文导入并在看板中直接显示' })
  const analyzedAt = batchInfo.analyzed_at
    && /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(batchInfo.analyzed_at)
    && !Number.isNaN(Date.parse(batchInfo.analyzed_at))
    ? new Date(batchInfo.analyzed_at).toISOString()
    : null
  if (batchInfo.analyzed_at && !analyzedAt) {
    issues.push({ level: 'error', message: 'analyzed_at 必须是带时区的 ISO-8601 时间，例如 2026-09-07T18:00:00+08:00' })
  }

  const seen = new Set<string>()
  const results: AiResultInput[] = []

  reviewRows.forEach((row, index) => {
    const rowNumber = index + 2
    const storyCode = cellText(row['用户故事编码'])
    if (!storyCode) return
    const story = storyByCode.get(storyCode)
    if (!story) {
      issues.push({ level: 'error', row: rowNumber, message: `未知需求编码：${storyCode}` })
      return
    }
    if (seen.has(storyCode)) issues.push({ level: 'error', row: rowNumber, message: `重复需求编码：${storyCode}` })
    seen.add(storyCode)

    if (cellText(row['用户故事名称']) !== story.story_name || cellText(row['负责人']) !== story.owners_text) {
      issues.push({ level: 'error', row: rowNumber, message: `原始需求字段被修改：${storyCode}` })
    }

    const verdictText = cellText(row['AI判断'])
    const verdict = verdictText ? verdictByLabel[verdictText] : null
    const confidenceText = cellText(row['置信度'])
    const confidence = confidenceNumber(row['置信度'])
    if (verdictText && !verdict) issues.push({ level: 'error', row: rowNumber, message: `非法AI判断：${verdictText}` })
    if (verdict && confidence === null) issues.push({ level: 'error', row: rowNumber, message: `置信度必须填写 0～100 的数值或百分比，例如 80 或 80%；当前值：${confidenceText || '空'}` })
    if (confidence !== null && (confidence < 0 || confidence > 100)) issues.push({ level: 'error', row: rowNumber, message: `置信度超出范围：${confidence}` })

    results.push({
      story_code: storyCode,
      verdict,
      confidence,
      summary: nullableText(row['分析摘要']),
      implemented_content: nullableText(row['已实现内容']),
      missing_content: nullableText(row['缺失内容']),
      risks: nullableText(row['风险']),
      test_points: nullableText(row['建议测试点']),
      ai_remark: nullableText(row['AI备注']),
    })
  })

  const evidence = evidenceRows.flatMap<AiEvidenceInput>((row, index) => {
    const rowNumber = index + 2
    const storyCode = cellText(row['用户故事编码'])
    const repositoryName = cellText(row['仓库'])
    const filePath = cellText(row['文件路径'])
    const evidenceType = cellText(row['证据类型']) as EvidenceType
    const description = cellText(row['证据说明'])

    if (!storyCode && !repositoryName && !filePath && !description) return []
    if (!storyByCode.has(storyCode)) issues.push({ level: 'error', row: rowNumber, message: `代码证据引用未知需求：${storyCode}` })
    if (!repositoryName) issues.push({ level: 'error', row: rowNumber, message: '代码证据缺少仓库' })
    if (!filePath) issues.push({ level: 'error', row: rowNumber, message: '代码证据缺少文件路径' })
    if (!evidenceTypes.has(evidenceType)) issues.push({ level: 'error', row: rowNumber, message: `非法证据类型：${evidenceType}` })
    if (!description) issues.push({ level: 'error', row: rowNumber, message: '代码证据缺少证据说明' })

    return [{
      story_code: storyCode,
      repository_name: repositoryName,
      commit_sha: nullableText(row['Commit']),
      file_path: filePath,
      symbol_name: nullableText(row['类/方法']),
      start_line: numeric(row['开始行']),
      end_line: numeric(row['结束行']),
      evidence_type: evidenceType,
      description,
    }]
  })

  const evidenceCodes = new Set(evidence.map((item) => item.story_code))
  for (const result of results) {
    if ((result.verdict === 'IMPLEMENTED' || result.verdict === 'PARTIAL') && !evidenceCodes.has(result.story_code)) {
      issues.push({ level: 'warning', message: `${result.story_code} 判断为已实现或部分实现，但没有代码证据` })
    }
  }

  for (const story of stories) {
    if (!seen.has(story.story_code)) issues.push({ level: 'warning', message: `${story.story_code} 缺少AI结果，将显示为未分析` })
  }

  return { batchInfo, baselineCommit, analyzedAt, results, evidence, issues }
}
