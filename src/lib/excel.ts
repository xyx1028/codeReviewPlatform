import { readSheet } from 'read-excel-file/browser'
import writeXlsxFile from 'write-excel-file/browser'
import type { Cell, Sheet } from 'write-excel-file/browser'
import type {
  AiEvidenceInput,
  AiResultInput,
  AiVerdict,
  EvidenceType,
  ReviewBatch,
  ReviewStory,
  SourceStoryInput,
  ValidationIssue,
} from '../types'

export const templateVersion = '1.0'

export const sourceFieldLabels: Record<SourceFieldKey, string> = {
  story_code: '用户故事编码',
  story_name: '用户故事名称',
  owners_text: '负责人',
  project_name: '所属项目',
  cloud_name: '所属云',
  application_name: '所属应用',
  iteration_name: '迭代阶段',
  release_window: '发布窗口',
  source_status: '原始需求状态',
}

const sourceAliases: Record<SourceFieldKey, string[]> = {
  story_code: ['用户故事编码', '需求编号', '故事编码', 'story_code', 'story code'],
  story_name: ['用户故事名称', '需求标题', '需求名称', '故事名称', 'story_name', 'title'],
  owners_text: ['负责人', '责任人', '需求负责人', 'owner', 'owners'],
  project_name: ['所属项目', '项目', '项目名称', 'project'],
  cloud_name: ['所属云', '云', 'cloud'],
  application_name: ['所属应用', '应用', '应用名称', 'application'],
  iteration_name: ['迭代阶段', '迭代', 'iteration'],
  release_window: ['发布窗口', '发布时间', 'release'],
  source_status: ['原始需求状态', '状态', '需求状态', 'status'],
}

const reviewSheetName = '需求评审'
const evidenceSheetName = '代码证据'
const batchSheetName = '批次信息'

const reviewColumns = [
  '用户故事编码',
  '用户故事名称',
  '负责人',
  '所属项目',
  '所属应用',
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

export type SourceFieldKey = keyof Omit<SourceStoryInput, 'source_data'>
export type FieldMapping = Partial<Record<SourceFieldKey, string>>

type CellValue = string | number | boolean | Date | null

type SheetData = CellValue[][]
type ExportCell = Exclude<Cell, undefined>

export interface WorkbookRows {
  headers: string[]
  rows: Record<string, unknown>[]
}

export interface SourceParseResult {
  stories: SourceStoryInput[]
  issues: ValidationIssue[]
}

export interface AiParseResult {
  batchInfo: Record<string, string>
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

function rowsToObjects(rows: SheetData): Record<string, unknown>[] {
  const headers = rows[0]?.map((value) => cellText(value)) ?? []
  return rows.slice(1).map((row) => {
    const item: Record<string, unknown> = {}
    headers.forEach((header, index) => {
      if (header) item[header] = row[index] ?? ''
    })
    return item
  })
}

export async function readFirstSheet(file: File): Promise<WorkbookRows> {
  const rows = await readSheet(file) as unknown as SheetData
  const headers = rows[0]?.map((value) => cellText(value)).filter(Boolean) ?? []
  return { headers, rows: rowsToObjects(rows) }
}

export function inferFieldMapping(headers: string[]): FieldMapping {
  const mapping: FieldMapping = {}
  for (const [field, aliases] of Object.entries(sourceAliases) as [SourceFieldKey, string[]][]) {
    const matched = headers.find((header) => aliases.some((alias) => alias.toLowerCase() === header.toLowerCase()))
    if (matched) mapping[field] = matched
  }
  return mapping
}

export function parseSourceRows(rows: Record<string, unknown>[], mapping: FieldMapping): SourceParseResult {
  const issues: ValidationIssue[] = []
  const stories: SourceStoryInput[] = []
  const seen = new Set<string>()

  rows.forEach((row, index) => {
    const rowNumber = index + 2
    const hasValue = Object.values(row).some((value) => cellText(value))
    if (!hasValue) {
      issues.push({ level: 'info', row: rowNumber, message: '空白行已忽略' })
      return
    }

    const mapped = (field: SourceFieldKey) => (mapping[field] ? row[mapping[field]!] : undefined)
    const storyCode = cellText(mapped('story_code'))
    const storyName = cellText(mapped('story_name'))
    const ownersText = cellText(mapped('owners_text'))

    if (!storyCode) issues.push({ level: 'error', row: rowNumber, message: '用户故事编码为空' })
    if (!storyName) issues.push({ level: 'error', row: rowNumber, message: '用户故事名称为空' })
    if (storyCode && seen.has(storyCode)) issues.push({ level: 'error', row: rowNumber, message: `当前文件内重复需求编码：${storyCode}` })
    if (!ownersText) issues.push({ level: 'warning', row: rowNumber, message: '负责人为空' })
    if (!cellText(mapped('project_name')) && !cellText(mapped('application_name'))) {
      issues.push({ level: 'warning', row: rowNumber, message: '项目和应用均为空' })
    }

    if (!storyCode || !storyName) return
    seen.add(storyCode)

    stories.push({
      story_code: storyCode,
      story_name: storyName,
      owners_text: ownersText,
      project_name: nullableText(mapped('project_name')),
      cloud_name: nullableText(mapped('cloud_name')),
      application_name: nullableText(mapped('application_name')),
      iteration_name: nullableText(mapped('iteration_name')),
      release_window: nullableText(mapped('release_window')),
      source_status: nullableText(mapped('source_status')),
      source_data: row,
    })
  })

  return { stories, issues }
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
    ['baseline_branch', batch.default_branch ?? '', '操作者填写'],
    ['baseline_commit', '', '操作者填写'],
    ['ai_model', '', '实际使用的模型或工具'],
    ['analyzed_at', '', '分析时间，例如 2026-09-07 18:00'],
  ].map((row, rowIndex) => row.map((value) => textCell(value, rowIndex === 0)))

  const reviewRows = [
    reviewColumns,
    ...stories.map((story) => [
      story.story_code,
      story.story_name,
      story.description ?? '',
      story.acceptance_criteria ?? '',
      story.owners_text,
      story.project_name ?? '',
      story.application_name ?? '',
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
    return { batchInfo: {}, results: [], evidence: [], issues: [{ level: 'error', message: '缺少必需 Sheet：批次信息、需求评审或代码证据' }] }
  }

  const batchInfo = Object.fromEntries(metadataRows.map((row) => [cellText(row['字段']), cellText(row['值'])]).filter(([key]) => key))

  if (batchInfo.template_version !== templateVersion) issues.push({ level: 'error', message: `不支持的模板版本：${batchInfo.template_version || '空'}` })
  if (batchInfo.batch_id !== batch.id) issues.push({ level: 'error', message: '模板 batch_id 与当前批次不一致' })

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

  return { batchInfo, results, evidence, issues }
}
