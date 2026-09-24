/**
 * 确定性 ZIP 写入器，专门用来**重新打包一个已经存在的 Skill Bundle**。
 *
 * 它只在一个地方被用到：AI 优化把改过的文本文件换掉、其余文件保持原字节之后，需要一份
 * 新归档去走既有的上传校验管线。
 *
 * 三条设计约束，每一条都对应一个真实的失败模式：
 *
 *   1. **输出必须能被 `readSkillArchive` 接受。** 那个解析器是 fail-closed 的：ZIP64、
 *      多盘、加密、CRC 不符、声明大小不符、symlink mode 位、压缩比超 20:1 全拒。所以这里
 *      只写它认得的最小子集 —— 单盘、无 comment、store 或 deflate、真实 CRC、Unix 普通
 *      文件 mode。用一个通用打包库反而要去猜它会不会写 ZIP64 头或数据描述符。
 *
 *   2. **确定性。** 相同的文件集合必须产出逐字节相同的归档。mtime 固定、entry 按路径
 *      码元序排序、不写 extra 字段。否则同一份内容重复优化两次会得到不同的
 *      `archive_sha256`，而正式对象 key 是内容寻址的（`<sha>.zip`）—— 不确定的归档意味着
 *      "同样的内容发布两次会占两个 key"。
 *
 *   3. **压缩比自我约束。** 逐 entry 判断：deflate 后的比值超过上限就退回 store。
 *      `sum(raw) <= ratio * sum(compressed)` 由每一项 `raw_i <= ratio * comp_i` 推出，
 *      于是整档一定通不过闸门这件事不可能发生 —— 不然我们会打出一个连自己都拒收的包。
 */

import { crc32, deflateRawSync } from 'node:zlib'

const SIG_LOCAL_FILE = 0x04034b50
const SIG_CENTRAL_FILE = 0x02014b50
const SIG_EOCD = 0x06054b50

/** version made by = 3 (Unix) << 8 | 20，于是 external attributes 的高 16 位被当作 st_mode。 */
const VERSION_MADE_BY_UNIX = 0x0314
const VERSION_NEEDED = 20
const METHOD_STORE = 0
const METHOD_DEFLATE = 8
/** 普通文件 0644。绝不写 symlink / 设备位 —— 解析器会拒，而且那不是我们想表达的东西。 */
const UNIX_MODE_REGULAR_FILE = 0o100644

/**
 * 固定的 DOS 时间戳：1980-01-01 00:00:00（DOS 纪元）。
 *
 * 用当前时间会让同一份内容每次打包都得到不同的字节，`archive_sha256` 随之变化。
 * mtime 不参与 `bundle_hash`（它只看逻辑文件集合），但它参与归档字节，而正式对象 key
 * 是按归档 sha256 内容寻址的。
 */
const DOS_EPOCH_TIME = 0
const DOS_EPOCH_DATE = 0x0021

export interface ZipWriteEntry {
  /** 规范相对路径，`/` 分隔、无前导 `/`。调用方保证它已经过 `canonicalizeEntryPath`。 */
  path: string
  bytes: Buffer
}

export interface ZipWriteOptions {
  /** 整档压缩比上限（展开 / 压缩）。超过它的 entry 退回 store。 */
  compressionRatio: number
}

/** 排序键：UTF-16 码元序，与 manifest / SQL 的 `collate "C"` 对齐。 */
function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function chooseMethod(
  raw: Buffer,
  options: ZipWriteOptions,
): { method: number; data: Buffer } {
  if (raw.length === 0) return { method: METHOD_STORE, data: Buffer.alloc(0) }
  const deflated = deflateRawSync(raw, { level: 9 })
  // store 更小时也用 store：这对已经压缩过的资源（PNG/JPEG）是常态。
  if (deflated.length >= raw.length) return { method: METHOD_STORE, data: raw }
  // 单 entry 的压缩比越界就退回 store，于是整档比值必然在闸门之内。
  if (raw.length > deflated.length * options.compressionRatio) {
    return { method: METHOD_STORE, data: raw }
  }
  return { method: METHOD_DEFLATE, data: deflated }
}

export class ZipWriteError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ZipWriteError'
  }
}

/**
 * 打包一份新的 Skill Bundle 归档。
 *
 * 不做内容校验：调用方在打包**之后**必须用 `validateSkillArchive` 把产物当成一份陌生的
 * 上传重新校验一遍。这个顺序是刻意的 —— 校验的对象必须是最终要发布的那一串字节，而不是
 * 打包前的内存结构。
 */
export function writeSkillArchive(
  entries: readonly ZipWriteEntry[],
  options: ZipWriteOptions,
): Buffer {
  if (entries.length === 0) {
    throw new ZipWriteError('a skill archive must contain at least one file')
  }
  const seen = new Set<string>()
  for (const entry of entries) {
    if (entry.path === '' || entry.path.startsWith('/') || entry.path.includes('\\')) {
      throw new ZipWriteError(`refusing to write a non-canonical entry path: ${entry.path}`)
    }
    if (seen.has(entry.path)) {
      throw new ZipWriteError(`refusing to write a duplicate entry path: ${entry.path}`)
    }
    seen.add(entry.path)
  }

  const sorted = [...entries].sort((a, b) => byCodeUnit(a.path, b.path))
  const chunks: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0

  for (const entry of sorted) {
    const name = Buffer.from(entry.path, 'utf8')
    const { method, data } = chooseMethod(entry.bytes, options)
    const entryCrc = crc32(entry.bytes) >>> 0

    const local = Buffer.alloc(30)
    local.writeUInt32LE(SIG_LOCAL_FILE, 0)
    local.writeUInt16LE(VERSION_NEEDED, 4)
    // general purpose flags = 0：不用数据描述符（bit 3），大小写在头里，解析器直接可读。
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(DOS_EPOCH_TIME, 10)
    local.writeUInt16LE(DOS_EPOCH_DATE, 12)
    local.writeUInt32LE(entryCrc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(entry.bytes.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    chunks.push(local, name, data)

    const header = Buffer.alloc(46)
    header.writeUInt32LE(SIG_CENTRAL_FILE, 0)
    header.writeUInt16LE(VERSION_MADE_BY_UNIX, 4)
    header.writeUInt16LE(VERSION_NEEDED, 6)
    header.writeUInt16LE(0, 8)
    header.writeUInt16LE(method, 10)
    header.writeUInt16LE(DOS_EPOCH_TIME, 12)
    header.writeUInt16LE(DOS_EPOCH_DATE, 14)
    header.writeUInt32LE(entryCrc, 16)
    header.writeUInt32LE(data.length, 20)
    header.writeUInt32LE(entry.bytes.length, 24)
    header.writeUInt16LE(name.length, 28)
    header.writeUInt16LE(0, 30)
    header.writeUInt16LE(0, 32)
    header.writeUInt16LE(0, 34)
    header.writeUInt16LE(0, 36)
    header.writeUInt32LE((UNIX_MODE_REGULAR_FILE << 16) >>> 0, 38)
    header.writeUInt32LE(offset, 42)
    central.push(header, name)

    offset += local.length + name.length + data.length
  }

  const centralStart = offset
  const centralSize = central.reduce((total, part) => total + part.length, 0)

  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(SIG_EOCD, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(sorted.length, 8)
  eocd.writeUInt16LE(sorted.length, 10)
  eocd.writeUInt32LE(centralSize, 12)
  eocd.writeUInt32LE(centralStart, 16)
  // comment 长度 0：留 comment 会让 EOCD 的反向扫描多一条不必要的分支。
  eocd.writeUInt16LE(0, 20)

  if (sorted.length > 0xffff) {
    throw new ZipWriteError('refusing to write more entries than a non-ZIP64 archive can declare')
  }
  return Buffer.concat([...chunks, ...central, eocd])
}
