import { describe, expect, it } from 'vitest'
import { readSkillBundlePreview } from '../skill-bundle-preview'

/**
 * 用真实 deflate 压缩流构造一个能被标准解压器读的 ZIP，避免"只有我的解析器认得"的自证。
 */
async function deflateRaw(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

function crc32(bytes: Uint8Array<ArrayBuffer>): number {
  let table = crc32.table
  if (table === undefined) {
    table = new Uint32Array(256)
    for (let index = 0; index < 256; index += 1) {
      let value = index
      for (let bit = 0; bit < 8; bit += 1) {
        value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
      }
      table[index] = value >>> 0
    }
    crc32.table = table
  }
  let crc = 0xffffffff
  for (const byte of bytes) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}
crc32.table = undefined as Uint32Array | undefined

interface PlannedEntry {
  path: string
  content: string
  /** true 时存储为 method 0（stored），否则 method 8（deflate）。 */
  stored?: boolean
}

async function buildZip(entries: PlannedEntry[]): Promise<Blob> {
  const encoder = new TextEncoder()
  const locals: Uint8Array<ArrayBuffer>[] = []
  const centrals: Uint8Array<ArrayBuffer>[] = []
  let offset = 0

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.path)
    const raw = encoder.encode(entry.content)
    const method = entry.stored === true ? 0 : 8
    const payload = method === 0 ? raw : await deflateRaw(raw)
    const checksum = crc32(raw)

    const local = new Uint8Array(30 + nameBytes.length + payload.length)
    const localView = new DataView(local.buffer)
    localView.setUint32(0, 0x04034b50, true)
    localView.setUint16(4, 20, true)
    localView.setUint16(8, method, true)
    localView.setUint32(14, checksum, true)
    localView.setUint32(18, payload.length, true)
    localView.setUint32(22, raw.length, true)
    localView.setUint16(26, nameBytes.length, true)
    local.set(nameBytes, 30)
    local.set(payload, 30 + nameBytes.length)
    locals.push(local)

    const central = new Uint8Array(46 + nameBytes.length)
    const centralView = new DataView(central.buffer)
    centralView.setUint32(0, 0x02014b50, true)
    centralView.setUint16(4, 20, true)
    centralView.setUint16(6, 20, true)
    centralView.setUint16(10, method, true)
    centralView.setUint32(16, checksum, true)
    centralView.setUint32(20, payload.length, true)
    centralView.setUint32(24, raw.length, true)
    centralView.setUint16(28, nameBytes.length, true)
    centralView.setUint32(42, offset, true)
    central.set(nameBytes, 46)
    centrals.push(central)

    offset += local.length
  }

  const centralSize = centrals.reduce((total, part) => total + part.length, 0)
  const eocd = new Uint8Array(22)
  const eocdView = new DataView(eocd.buffer)
  eocdView.setUint32(0, 0x06054b50, true)
  eocdView.setUint16(8, entries.length, true)
  eocdView.setUint16(10, entries.length, true)
  eocdView.setUint32(12, centralSize, true)
  eocdView.setUint32(16, offset, true)

  return new Blob([...locals, ...centrals, eocd])
}

const VALID_ENTRY = `---
name: bos-bill-review
description: BOS 单据领域评审要点
whenToUse: 评审 BOS 单据相关需求时
---

# BOS 单据评审

正文。
`

describe('readSkillBundlePreview', () => {
  it('reads name, description and whenToUse from a deflated SKILL.md at the archive root', async () => {
    const zip = await buildZip([
      { path: 'SKILL.md', content: VALID_ENTRY },
      { path: 'references/rules.md', content: '# 规则\n' },
    ])
    const preview = await readSkillBundlePreview(zip)
    expect(preview.hasEntry).toBe(true)
    expect(preview.name).toBe('bos-bill-review')
    expect(preview.description).toBe('BOS 单据领域评审要点')
    expect(preview.whenToUse).toBe('评审 BOS 单据相关需求时')
    expect(preview.containsScripts).toBe(false)
  })

  it('reads a stored (uncompressed) entry too', async () => {
    const zip = await buildZip([{ path: 'SKILL.md', content: VALID_ENTRY, stored: true }])
    const preview = await readSkillBundlePreview(zip)
    expect(preview.name).toBe('bos-bill-review')
  })

  it('flags scripts/ so the extra confirmation can be shown before upload', async () => {
    const zip = await buildZip([
      { path: 'SKILL.md', content: VALID_ENTRY },
      { path: 'scripts/run.py', content: 'print(1)\n' },
    ])
    const preview = await readSkillBundlePreview(zip)
    expect(preview.containsScripts).toBe(true)
  })

  it('does not treat a nested SKILL.md as the entry: the platform requires it at the root', async () => {
    const zip = await buildZip([{ path: 'bundle/SKILL.md', content: VALID_ENTRY }])
    const preview = await readSkillBundlePreview(zip)
    expect(preview.hasEntry).toBe(false)
    expect(preview.name).toBeNull()
  })

  /*
   * 以下几条锁住"预填器不是校验器"这条边界：非法输入必须**安静地返回空值**，
   * 不能抛错、不能把前端变成第二个判定处。真正的拒绝由服务端给出。
   */
  it('returns an empty preview for a file that is not a ZIP at all', async () => {
    const preview = await readSkillBundlePreview(new Blob([new TextEncoder().encode('not a zip')]))
    expect(preview).toEqual({
      name: null,
      description: null,
      whenToUse: null,
      containsScripts: false,
      hasEntry: false,
    })
  })

  it('returns empty fields, not an error, when the frontmatter block is missing', async () => {
    const zip = await buildZip([{ path: 'SKILL.md', content: '# 没有 frontmatter\n' }])
    const preview = await readSkillBundlePreview(zip)
    expect(preview.hasEntry).toBe(true)
    expect(preview.name).toBeNull()
    expect(preview.description).toBeNull()
  })

  it('does not reject a frontmatter the server would refuse; it just reports what it read', async () => {
    // 服务端会因为 name 非法（含大写与下划线）拒绝发布；预填器只负责把它读出来。
    const zip = await buildZip([
      { path: 'SKILL.md', content: '---\nname: Bad_Name\ndescription: x\n---\n\n正文\n' },
    ])
    const preview = await readSkillBundlePreview(zip)
    expect(preview.name).toBe('Bad_Name')
    expect(preview.description).toBe('x')
  })

  it('ignores an empty value so the form falls back to manual input', async () => {
    const zip = await buildZip([
      { path: 'SKILL.md', content: '---\nname:\ndescription: 有描述\n---\n\n正文\n' },
    ])
    const preview = await readSkillBundlePreview(zip)
    expect(preview.name).toBeNull()
    expect(preview.description).toBe('有描述')
  })

  it('strips surrounding quotes from frontmatter values', async () => {
    const zip = await buildZip([
      { path: 'SKILL.md', content: '---\nname: "quoted-skill"\ndescription: \'带引号\'\n---\n\n正文\n' },
    ])
    const preview = await readSkillBundlePreview(zip)
    expect(preview.name).toBe('quoted-skill')
    expect(preview.description).toBe('带引号')
  })
})
