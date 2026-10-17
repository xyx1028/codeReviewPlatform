import { describe, expect, it } from 'vitest'
import { formatBundleDiagnostics, readSkillBundlePreview } from '../skill-bundle-preview'

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
  /** true 时头里声明 deflate，实际写入不是 deflate 流的字节 —— 模拟损坏的入口。 */
  corruptPayload?: boolean
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
    const payload =
      entry.corruptPayload === true
        ? encoder.encode('这不是 deflate 流')
        : method === 0
          ? raw
          : await deflateRaw(raw)
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

  it.each(['root', 'bundle'])('previews %s layout with OS metadata', async (folder) => {
    const prefix = folder === 'root' ? '' : `${folder}/`
    const zip = await buildZip([
      { path: `${prefix}SKILL.md`, content: VALID_ENTRY },
      { path: `${prefix}scripts/run.sh`, content: 'echo ok' },
      { path: '__MACOSX/._SKILL.md', content: 'metadata' },
      { path: `${prefix}.DS_Store`, content: 'metadata' },
      { path: 'desktop.ini', content: 'metadata' },
    ])
    const preview = await readSkillBundlePreview(zip)
    expect(preview.issue).toBeNull()
    expect(preview.hasEntry).toBe(true)
    expect(preview.name).toBe('bos-bill-review')
    expect(preview.containsScripts).toBe(true)
  })

  it.each([
    ['nested/bundle/SKILL.md'],
    ['bundle/SKILL.md', 'other/SKILL.md'],
    ['bundle/SKILL.md', 'extra.md'],
  ])('reports an ambiguous or too deeply nested entry: %j', async (...paths) => {
    const zip = await buildZip(paths.map((path) => ({ path, content: VALID_ENTRY })))
    const preview = await readSkillBundlePreview(zip)
    expect(preview.hasEntry).toBe(false)
    expect(preview.issue).toBe('entry-nested')
  })

  /*
   * 这条锁住线上遇到的真实故障：`DecompressionStream('deflate-raw')` 要 Chrome/Edge ≥103、
   * Firefox ≥113、Safari ≥16.4，低于此版本时同一个合规的包在别人电脑上会被提示"读不到
   * SKILL.md"。解压换成纯 JS 后，结果必须只由字节决定。
   */
  it('reads a deflated entry on browsers without the Compression Streams API', async () => {
    const zip = await buildZip([{ path: 'SKILL.md', content: VALID_ENTRY }])
    const stashed = Reflect.get(globalThis, 'DecompressionStream')
    Reflect.deleteProperty(globalThis, 'DecompressionStream')
    try {
      expect(Reflect.get(globalThis, 'DecompressionStream')).toBeUndefined()
      const preview = await readSkillBundlePreview(zip)
      expect(preview.issue).toBeNull()
      expect(preview.hasEntry).toBe(true)
      expect(preview.name).toBe('bos-bill-review')
    } finally {
      Reflect.set(globalThis, 'DecompressionStream', stashed)
    }
  })

  it('still reports scripts/ when the entry itself cannot be inflated', async () => {
    const zip = await buildZip([
      { path: 'SKILL.md', content: VALID_ENTRY, corruptPayload: true },
      { path: 'scripts/run.sh', content: 'echo 1\n' },
    ])
    const preview = await readSkillBundlePreview(zip)
    expect(preview.issue).toBe('entry-unreadable')
    expect(preview.hasEntry).toBe(true)
    expect(preview.name).toBeNull()
    // 解不开入口不该顺手丢掉"这个包里有脚本"这件已经读到的事。
    expect(preview.containsScripts).toBe(true)
  })

  /*
   * 以下几条锁住"预填器不是校验器"这条边界：非法输入必须**安静地返回空值**，
   * 不能抛错、不能把前端变成第二个判定处。真正的拒绝由服务端给出。
   */
  it('returns an empty preview for a file that is not a ZIP at all', async () => {
    const preview = await readSkillBundlePreview(new Blob([new TextEncoder().encode('not a zip')]))
    expect(preview).toMatchObject({
      name: null,
      description: null,
      whenToUse: null,
      containsScripts: false,
      hasEntry: false,
      issue: 'archive-unreadable',
      nestedEntryPath: null,
    })
    // 证据必须指出是"找不到中央目录"，而不是笼统的读不出来 —— 处置动作不同。
    expect(preview.diagnostics.failureStage).toBe('eocd-not-found')
    expect(preview.diagnostics.fileBytes).toBe(9)
  })

  /**
   * 字节被改动/截断是远程排查里最常见的成因（IM 转发、下载中断），它必须能被单独认出来：
   * 界面显示的 KiB 四舍五入之后跟完好文件看不出区别。
   */
  it('points at the central directory when its bytes are damaged', async () => {
    const zip = await buildZip([{ path: 'SKILL.md', content: '---\nname: a\n---\n' }])
    const bytes = new Uint8Array(await zip.arrayBuffer())
    const view = new DataView(bytes.buffer)
    // 无注释的 ZIP，EOCD 就在最后 22 字节；从里面取中央目录起始偏移。
    const centralDirOffset = view.getUint32(bytes.length - 22 + 16, true)
    bytes[centralDirOffset] = 0x00 // 破坏中央目录签名，模拟传输中被改动的字节

    const preview = await readSkillBundlePreview(new Blob([bytes]))
    expect(preview.issue).toBe('archive-unreadable')
    expect(preview.diagnostics.failureStage).toBe('central-directory')
    expect(preview.diagnostics.eocdOffset).toBe(bytes.length - 22)
    expect(preview.diagnostics.failureDetail).toContain('signature')
  })

  it('carries a copyable one-line summary for screenshots', async () => {
    const zip = await buildZip([{ path: 'SKILL.md', content: '---\nname: a\n---\n' }])
    const preview = await readSkillBundlePreview(zip)
    const line = formatBundleDiagnostics(preview.diagnostics)
    expect(line).toContain('bytes=')
    expect(line).toContain('entries=1/1')
    expect(line).toContain('head=504b0304')
  })

  it('separates "no SKILL.md anywhere" from "not a ZIP"', async () => {
    const zip = await buildZip([{ path: 'references/rules.md', content: '# 规则\n' }])
    const preview = await readSkillBundlePreview(zip)
    expect(preview.issue).toBe('entry-missing')
    expect(preview.nestedEntryPath).toBeNull()
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
