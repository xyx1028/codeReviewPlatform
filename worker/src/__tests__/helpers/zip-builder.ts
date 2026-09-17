/**
 * 最小 ZIP 写入器，专门用来构造**恶意**归档。
 *
 * 为什么不用现成的打包库：现成库的目标是产出合法归档，它们会主动拒绝或修正
 * `../../etc/passwd` 这种 entry 名，也不会让你伪造 CRC、伪造 symlink mode 位或者
 * 声明一个与实际数据不符的 uncompressedSize。而这些正是要测的输入。
 *
 * 这个写入器刻意**不做任何校验**：调用方说什么就写什么。
 */

import { crc32, deflateRawSync, deflateSync } from 'node:zlib'

export interface ZipEntrySpec {
  /** 原样写进归档的 entry 名，不做任何归一化。 */
  name: string
  content?: Buffer | string
  /** 0 = store，8 = deflate。默认按内容大小自动选 store。 */
  method?: 0 | 8
  /** Unix `st_mode`。默认 0o100644（普通文件）。传 0 表示"不带 mode 位"（Windows 风格）。 */
  unixMode?: number
  /** 覆盖 CRC，用来测"CRC 与内容不符"。 */
  crcOverride?: number
  /** 覆盖声明的解压后大小，用来测"声明与实际不符"。 */
  uncompressedSizeOverride?: number
  /** general purpose flags，例如 0x1 表示加密。 */
  flags?: number
}

const S_IFREG = 0o100000
const S_IFDIR = 0o040000
const S_IFLNK = 0o120000

export const UNIX_MODE = {
  file: S_IFREG | 0o644,
  directory: S_IFDIR | 0o755,
  symlink: S_IFLNK | 0o777,
  fifo: 0o010000 | 0o644,
  device: 0o020000 | 0o644,
  socket: 0o140000 | 0o644,
} as const

interface Prepared {
  name: Buffer
  data: Buffer
  method: number
  crc: number
  compressedSize: number
  uncompressedSize: number
  unixMode: number
  flags: number
  localOffset: number
}

export function buildZip(entries: readonly ZipEntrySpec[]): Buffer {
  const prepared: Prepared[] = []
  const chunks: Buffer[] = []
  let offset = 0

  for (const spec of entries) {
    const raw =
      spec.content === undefined
        ? Buffer.alloc(0)
        : Buffer.isBuffer(spec.content)
          ? spec.content
          : Buffer.from(spec.content, 'utf8')
    const method = spec.method ?? 0
    const data = method === 8 ? deflateRawSync(raw) : raw
    const name = Buffer.from(spec.name, 'utf8')
    const entry: Prepared = {
      name,
      data,
      method,
      crc: spec.crcOverride ?? (crc32(raw) >>> 0),
      compressedSize: data.length,
      uncompressedSize: spec.uncompressedSizeOverride ?? raw.length,
      unixMode: spec.unixMode ?? (spec.name.endsWith('/') ? UNIX_MODE.directory : UNIX_MODE.file),
      flags: spec.flags ?? 0,
      localOffset: offset,
    }
    prepared.push(entry)

    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(entry.flags, 6)
    header.writeUInt16LE(entry.method, 8)
    header.writeUInt16LE(0, 10)
    header.writeUInt16LE(0x2100, 12)
    header.writeUInt32LE(entry.crc, 14)
    header.writeUInt32LE(entry.compressedSize, 18)
    header.writeUInt32LE(entry.uncompressedSize, 22)
    header.writeUInt16LE(name.length, 26)
    header.writeUInt16LE(0, 28)
    chunks.push(header, name, entry.data)
    offset += header.length + name.length + entry.data.length
  }

  const centralStart = offset
  for (const entry of prepared) {
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    // high byte 3 = Unix，于是 external attributes 的高 16 位被当作 st_mode。
    central.writeUInt16LE(0x0314, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(entry.flags, 8)
    central.writeUInt16LE(entry.method, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0x2100, 14)
    central.writeUInt32LE(entry.crc, 16)
    central.writeUInt32LE(entry.compressedSize, 20)
    central.writeUInt32LE(entry.uncompressedSize, 24)
    central.writeUInt16LE(entry.name.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE((entry.unixMode << 16) >>> 0, 38)
    central.writeUInt32LE(entry.localOffset, 42)
    chunks.push(central, entry.name)
    offset += central.length + entry.name.length
  }
  const centralSize = offset - centralStart

  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(prepared.length, 8)
  eocd.writeUInt16LE(prepared.length, 10)
  eocd.writeUInt32LE(centralSize, 12)
  eocd.writeUInt32LE(centralStart, 16)
  eocd.writeUInt16LE(0, 20)
  chunks.push(eocd)

  return Buffer.concat(chunks)
}

/**
 * 一个合法的 `SKILL.md`。
 *
 * frontmatter **不是可选装饰**：dsh 的 `skill-filesystem` 缺了它只写一行 warn 就忽略整个
 * 技能。所以"合法 fixture"必须带它，否则测试会在一个 dsh 根本看不见的 Bundle 上做断言。
 */
export function validEntryMarkdown(name = 'bos-bill-review'): string {
  return [
    '---',
    `name: ${name}`,
    'description: BOS 单据领域的评审要点与操作规则',
    'whenToUse: 评审 BOS 单据相关需求时',
    '---',
    '',
    '# bos bill review',
    '',
    '需要时读取 references/domain-model.md',
    '',
  ].join('\n')
}

/** 一个合法的多文件 Bundle，供"正常路径"与"改一处就应当被拒"的对照使用。 */
export function validBundleEntries(): ZipEntrySpec[] {
  return [
    { name: 'SKILL.md', content: validEntryMarkdown() },
    { name: 'references/', content: '' },
    { name: 'references/domain-model.md', content: '# domain\n' },
    { name: 'references/rules.yaml', content: 'rules:\n  - a\n' },
    { name: 'templates/checklist.md', content: '- [ ] item\n' },
    { name: 'assets/flow.png', content: pngBytes() },
    { name: 'scripts/inspect.sh', content: '#!/bin/sh\necho ok\n' },
  ]
}

/**
 * 一个**真正可解码**的 1×1 灰度 PNG。
 *
 * 不能只写 magic 字节：`read_image` 会把字节交给真实的图片校验/缩放链路，一个只有
 * 文件头的"PNG"会被拒成 `Unsupported or malformed image data`。那种 fixture 会让
 * "图片资源可读"这条断言变成一句空话 —— 它测到的只是"我们的 magic 检查通过了"。
 */
export function pngBytes(): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length, 0)
    const typeAndData = Buffer.concat([Buffer.from(type, 'latin1'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(typeAndData) >>> 0, 0)
    return Buffer.concat([length, typeAndData, crc])
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(1, 0) // width
  ihdr.writeUInt32BE(1, 4) // height
  ihdr.writeUInt8(8, 8) // bit depth
  ihdr.writeUInt8(0, 9) // colour type: grayscale
  ihdr.writeUInt8(0, 10) // compression: deflate
  ihdr.writeUInt8(0, 11) // filter: adaptive
  ihdr.writeUInt8(0, 12) // interlace: none

  // 一行扫描线：过滤字节 0 + 一个灰度像素。IDAT 用 zlib 容器（不是 raw deflate）。
  const idat = deflateSync(Buffer.from([0x00, 0x00]))

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
