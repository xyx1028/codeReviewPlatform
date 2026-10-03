import { describe, expect, it } from 'vitest'
import { zipSync } from 'fflate'
import writeXlsxFile from 'write-excel-file/node'
import { extractAttachmentText } from '../ai/requirements/attachment-text.js'

function simplePdf(text: string): Buffer {
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  for (const [index, body] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf))
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`
  }
  const xref = Buffer.byteLength(pdf)
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
  return Buffer.from(pdf)
}

describe('frozen attachment text extraction', () => {
  it('extracts a PDF text layer and keeps a scanned PDF without text unavailable', async () => {
    expect(await extractAttachmentText('prd.pdf', simplePdf('Acceptance criteria'))).toMatchObject({
      status: 'readable', text: expect.stringContaining('Acceptance criteria'),
    })
    const scanned = simplePdf('')
    expect(await extractAttachmentText('scan.pdf', scanned)).toEqual({ status: 'no_text' })
  })

  it('extracts workbook cells and slide text', async () => {
    const workbook = await writeXlsxFile([[{ value: '验收口径' }], [{ value: '必须支持导出' }]]).toBuffer()
    expect(await extractAttachmentText('需求.xlsx', workbook)).toMatchObject({
      status: 'readable', text: expect.stringContaining('必须支持导出'),
    })
    const slides = Buffer.from(zipSync({
      'ppt/slides/slide1.xml': Buffer.from('<p:sld xmlns:p="x" xmlns:a="y"><a:t>登录 &amp; 审核</a:t></p:sld>'),
    }))
    expect(await extractAttachmentText('评审.pptx', slides)).toMatchObject({
      status: 'readable', text: expect.stringContaining('登录 & 审核'),
    })
  })

  it('extracts DOCX paragraphs from a valid Office package', async () => {
    const document = Buffer.from(zipSync({
      '[Content_Types].xml': Buffer.from('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
      '_rels/.rels': Buffer.from('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
      'word/document.xml': Buffer.from('<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>验收必须通过</w:t></w:r></w:p></w:body></w:document>'),
    }))
    expect(await extractAttachmentText('prd.docx', document)).toMatchObject({
      status: 'readable', text: expect.stringContaining('验收必须通过'),
    })
  })

  it('reports unsupported, broken and oversized inputs without pretending they were read', async () => {
    expect(await extractAttachmentText('old.doc', Buffer.from('binary'))).toEqual({ status: 'unsupported' })
    expect(await extractAttachmentText('bad.docx', Buffer.from('not a zip'))).toEqual({ status: 'parse_failed' })
    expect(await extractAttachmentText('huge.pdf', Buffer.alloc(8 * 1024 * 1024 + 1))).toEqual({ status: 'too_large' })
    const zipBomb = Buffer.from(zipSync({
      'word/document.xml': Buffer.alloc(25 * 1024 * 1024, 65),
    }))
    expect(await extractAttachmentText('compressed.docx', zipBomb)).toEqual({ status: 'too_large' })
  })
})
