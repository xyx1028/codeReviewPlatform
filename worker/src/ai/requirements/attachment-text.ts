import { unzipSync } from 'fflate'
import mammoth from 'mammoth'
import readXlsxFile from 'read-excel-file/node'

const MAX_SOURCE_BYTES = 8 * 1024 * 1024
const MAX_EXPANDED_BYTES = 24 * 1024 * 1024
const MAX_ZIP_ENTRIES = 2_000
const MAX_TEXT_CHARS = 100_000
const MAX_PDF_PAGES = 100

class AttachmentSizeLimitError extends Error {}

export type AttachmentTextResult =
  | { status: 'readable'; text: string; truncated: boolean }
  | { status: 'unsupported' | 'too_large' | 'no_text' | 'parse_failed' | 'limit_exceeded' }

function preflightZip(bytes: Buffer): void {
  let expandedBytes = 0
  let entries = 0
  // filter=false 只扫描 ZIP 目录，不解压；解析器拿到输入前先挡住压缩炸弹。
  unzipSync(bytes, {
    filter: (entry) => {
      entries += 1
      expandedBytes += entry.originalSize
      if (entries > MAX_ZIP_ENTRIES || expandedBytes > MAX_EXPANDED_BYTES) {
        throw new AttachmentSizeLimitError('attachment ZIP expansion limit exceeded')
      }
      return false
    },
  })
}

function boundedText(value: string): AttachmentTextResult {
  const normalized = value.replace(/\u0000/g, '').trim()
  if (normalized === '') return { status: 'no_text' }
  return {
    status: 'readable',
    text: normalized.slice(0, MAX_TEXT_CHARS),
    truncated: normalized.length > MAX_TEXT_CHARS,
  }
}

function decodeXmlText(value: string): string {
  return value.replace(/&(?:amp|lt|gt|quot|apos|#(?:x[0-9a-fA-F]+|[0-9]+));/g, (entity) => {
    const named: Record<string, string> = {
      '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'",
    }
    if (named[entity]) return named[entity]
    const codePoint = entity.startsWith('&#x')
      ? Number.parseInt(entity.slice(3, -1), 16)
      : Number.parseInt(entity.slice(2, -1), 10)
    return Number.isInteger(codePoint) && codePoint > 0 && codePoint <= 0x10ffff
      ? String.fromCodePoint(codePoint)
      : entity
  })
}

function extractSlides(bytes: Buffer): string {
  const slides = unzipSync(bytes, {
    filter: ({ name }) => /^ppt\/slides\/slide\d+\.xml$/.test(name),
  })
  return Object.entries(slides)
    .sort(([a], [b]) => Number(a.match(/slide(\d+)/)?.[1] ?? 0) - Number(b.match(/slide(\d+)/)?.[1] ?? 0))
    .map(([name, xml]) => {
      const tokens = [...Buffer.from(xml).toString('utf8').matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)]
      const text = tokens.map((token) => decodeXmlText(token[1] ?? '')).join('\n').trim()
      return text === '' ? '' : `# ${name}\n${text}`
    })
    .filter(Boolean).join('\n\n')
}

async function extractPdf(bytes: Buffer): Promise<AttachmentTextResult> {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const task = getDocument({ data: new Uint8Array(bytes), useSystemFonts: false })
  try {
    const document = await task.promise
    const pages: string[] = []
    const count = Math.min(document.numPages, MAX_PDF_PAGES)
    for (let number = 1; number <= count; number += 1) {
      const page = await document.getPage(number)
      const content = await page.getTextContent()
      const text = content.items.map((item) => 'str' in item ? item.str : '').join(' ').trim()
      if (text !== '') pages.push(`# 第 ${number} 页\n${text}`)
      page.cleanup()
      if (pages.join('\n').length > MAX_TEXT_CHARS) break
    }
    const result = boundedText(pages.join('\n\n'))
    if (result.status === 'no_text' && document.numPages > count) return { status: 'limit_exceeded' }
    return result.status === 'readable'
      ? { ...result, truncated: result.truncated || document.numPages > count }
      : result
  } finally {
    await task.destroy()
  }
}

/** 仅从冻结并通过 SHA 校验的原件提取文本；任何异常都转成显式不可读状态。 */
export async function extractAttachmentText(filename: string, bytes: Buffer): Promise<AttachmentTextResult> {
  const extension = filename.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1]
  if (!extension || !['pdf', 'docx', 'xlsx', 'pptx'].includes(extension)) return { status: 'unsupported' }
  if (bytes.length > MAX_SOURCE_BYTES) return { status: 'too_large' }
  try {
    if (extension !== 'pdf') preflightZip(bytes)
    if (extension === 'pdf') return await extractPdf(bytes)
    if (extension === 'docx') return boundedText((await mammoth.extractRawText({ buffer: bytes })).value)
    if (extension === 'xlsx') {
      const sheets = await readXlsxFile(bytes)
      return boundedText(sheets.map(({ sheet, data }) => {
        const text = data.map((row) => row.map((cell) => cell == null ? '' : String(cell)).join('\t')).join('\n').trim()
        return text === '' ? '' : `# 工作表：${sheet}\n${text}`
      }).filter(Boolean).join('\n\n'))
    }
    return boundedText(extractSlides(bytes))
  } catch (error) {
    return { status: error instanceof AttachmentSizeLimitError ? 'too_large' : 'parse_failed' }
  }
}
