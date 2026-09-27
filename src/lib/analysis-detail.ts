/**
 * AI 分析详情的浏览器端展示模型。
 *
 * 这些字段是历史上就存在的自由文本，不能把模型输出当作可信 Markdown/HTML。
 * 本模块只识别稳定的自然语言边界并返回 React 可安全插值的字符串，绝不执行或
 * 注入模型提供的内容。识别不出结构时保留原段落，这是比“猜错后重写原意”更安全的降级。
 */
export interface AnalysisDetailItem {
  label: string | null
  content: string
}

export type AnalysisDetailBlock =
  | { kind: 'paragraph'; content: string }
  | { kind: 'list'; items: AnalysisDetailItem[] }

const listMarker = /^\s*(?:[-*+•●▪◦]|[（(]?\d+[）).、]|[一二三四五六七八九十]+[、.)）])\s+(.+?)\s*$/u
const displayMarker = /^\s*(?:[-*+•●▪◦]|[（(]?\d+[）).、]|[一二三四五六七八九十]+[、.)）])\s*/u
const labelPrefix = /^\s*([^：:\n]{1,20})[：:]\s*(.+?)\s*$/u

function normalize(text: string): string {
  return text.replace(/[\u200b-\u200d\ufeff]/gu, '').replace(/\r\n?/g, '\n').replace(/[^\S\r\n]+/gu, ' ').trim()
}

/**
 * 结构化数组不做文本断句或层级猜测；仅防御性去除不应由 Agent 提供的列表装饰。
 */
export function displayStructuredAnalysisDetailItem(value: string): string {
  return value.replace(/[\u200b-\u200d\ufeff]/gu, '').replace(displayMarker, '').trim()
}

function itemFromText(text: string): AnalysisDetailItem {
  const normalized = normalize(text)
  const contentWithoutMarker = normalized.replace(listMarker, '$1').trim()
  const labelMatch = contentWithoutMarker.match(labelPrefix)
  if (!labelMatch) return { label: null, content: contentWithoutMarker }

  const [, candidate, content] = labelMatch
  // URL、路径及类似 `http://` 的技术文本不是自然语言标签，保留完整原文。
  if (/^(?:https?|file)$/iu.test(candidate) || candidate.includes('/') || candidate.includes('\\')) {
    return { label: null, content: normalized }
  }

  return { label: candidate.trim(), content: content.trim() }
}

function splitCompleteSentences(text: string): string[] {
  return normalize(text)
    // 中文句末和分号无论后面是否有空格都可安全分隔；英文句点仅在下一个单词以大写开头时分隔，
    // 避免把版本号、文件扩展名、浮点数和 URL 误切开。
    .split(/(?<=[。！？!?；;])\s*|(?<=\.)\s+(?=[A-Z])/u)
    .map(normalize)
    .filter(Boolean)
}

/**
 * 将一段分析详情拆为可扫描的段落或要点组。
 *
 * 优先级：显式项目符号/编号 > 多行分段 > 完整句末分隔 > 原文段落。
 */
export function parseAnalysisDetail(value: string | null | undefined): AnalysisDetailBlock[] {
  const source = normalize(value ?? '')
  if (!source) return []

  const blocks: AnalysisDetailBlock[] = []
  const paragraphs = source.split(/\n\s*\n/u).map(normalize).filter(Boolean)

  for (const paragraph of paragraphs) {
    const lines = paragraph.split('\n').map(normalize).filter(Boolean)
    const explicitItems = lines.map((line) => line.match(listMarker)?.[1] ?? null)

    if (explicitItems.some((item) => item !== null)) {
      const items = lines.map((line, index) => itemFromText(explicitItems[index] ?? line))
      blocks.push({ kind: 'list', items })
      continue
    }

    // 一行一个事项（常见于人工 Excel 导入）同样应易于扫描；只有一行时再尝试按句末拆分。
    if (lines.length > 1) {
      blocks.push({ kind: 'list', items: lines.map(itemFromText) })
      continue
    }

    const sentences = splitCompleteSentences(paragraph)
    if (sentences.length > 1) {
      blocks.push({ kind: 'list', items: sentences.map(itemFromText) })
    } else {
      blocks.push({ kind: 'paragraph', content: paragraph })
    }
  }

  return blocks
}
