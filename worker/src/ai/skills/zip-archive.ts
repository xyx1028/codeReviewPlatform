/**
 * 只读、fail-closed 的 ZIP 解析器。
 *
 * 为什么自己写而不装一个库：这段代码的全部价值在于**它拒绝什么**。通用解压库的默认
 * 行为是"尽量把东西解出来"（跟随 symlink、接受重复 entry、忽略奇怪的 mode 位），而
 * 这里需要的恰好相反 —— 任何看不懂的东西都必须让整个归档不可发布。把这个判断交给
 * 一个以兼容性为目标的依赖，等于把安全边界外包给一个目标不同的项目。
 *
 * 解析顺序也是安全设计的一部分：**先读中央目录（Central Directory）**，用它作为
 * entry 的唯一真相来源，再按它记录的偏移去读 local header。反过来（顺序扫 local
 * header）会踩上"local 与 central 不一致"这一类归档歧义 —— 校验方看到的是一份 entry
 * 表，解压方看到的是另一份。
 */

import { crc32, inflateRawSync } from 'node:zlib'
import { canonicalizeEntryPath, assertNoPathConflicts, type PathRuleLimits } from './skill-paths.js'

const SIG_LOCAL_FILE = 0x04034b50
const SIG_CENTRAL_FILE = 0x02014b50
const SIG_EOCD = 0x06054b50
const SIG_ZIP64_EOCD_LOCATOR = 0x07064b50

const METHOD_STORE = 0
const METHOD_DEFLATE = 8

/** Unix `st_mode` 的文件类型位。 */
const S_IFMT = 0o170000
const S_IFREG = 0o100000
const S_IFDIR = 0o040000

export interface ZipReadLimits extends PathRuleLimits {
  /** 归档字节上限。 */
  archiveBytes: number
  /** 展开后的总字节上限。 */
  expandedBytes: number
  /** entry 数量上限（含目录 entry）。 */
  entryCount: number
  /** 单个文件展开字节上限。 */
  fileBytes: number
  /** 整档压缩比上限（展开 / 压缩）。 */
  compressionRatio: number
  /** 解析总时长上限（毫秒）。 */
  validateMs: number
}

export interface ZipFileEntry {
  path: string
  bytes: Buffer
}

export interface ZipReadResult {
  files: ZipFileEntry[]
  expandedSizeBytes: number
}

/** 解析拒绝。调用方把它映射成 `SKILL_BUNDLE_INVALID` 或 `SKILL_BUNDLE_LIMIT_EXCEEDED`。 */
export class ZipRejectedError extends Error {
  readonly kind: 'INVALID' | 'LIMIT'

  constructor(kind: 'INVALID' | 'LIMIT', message: string) {
    super(message)
    this.name = 'ZipRejectedError'
    this.kind = kind
  }
}

function invalid(message: string): never {
  throw new ZipRejectedError('INVALID', message)
}

function limit(message: string): never {
  throw new ZipRejectedError('LIMIT', message)
}

interface CentralEntry {
  rawName: string
  method: number
  gpFlags: number
  crc32: number
  compressedSize: number
  uncompressedSize: number
  externalAttributes: number
  localHeaderOffset: number
}

/**
 * 定位中央目录结尾记录。
 *
 * 从尾部往前扫最多 64 KiB + 22 字节（ZIP comment 的理论上限）。找不到就是"这不是一个
 * 我们认得的 ZIP"，而不是"再猜一下"。
 */
function findEocd(buffer: Buffer): number {
  const maxScan = Math.min(buffer.length, 0xffff + 22)
  for (let offset = buffer.length - 22; offset >= buffer.length - maxScan; offset--) {
    if (offset < 0) break
    if (buffer.readUInt32LE(offset) === SIG_EOCD) return offset
  }
  invalid('the archive has no end-of-central-directory record')
}

function readCentralDirectory(buffer: Buffer, limits: ZipReadLimits): CentralEntry[] {
  const eocd = findEocd(buffer)

  // ZIP64 一律拒绝。上限是 10 MiB，不可能需要 ZIP64；接受它只会多一条几乎不被走到、
  // 因而必然长期未被验证的解析分支。
  if (eocd >= 20 && buffer.readUInt32LE(eocd - 20) === SIG_ZIP64_EOCD_LOCATOR) {
    invalid('ZIP64 archives are not accepted')
  }
  const diskNumber = buffer.readUInt16LE(eocd + 4)
  const centralDirDisk = buffer.readUInt16LE(eocd + 6)
  if (diskNumber !== 0 || centralDirDisk !== 0) {
    invalid('multi-disk archives are not accepted')
  }
  const entryCount = buffer.readUInt16LE(eocd + 10)
  const totalEntries = buffer.readUInt16LE(eocd + 8)
  if (entryCount !== totalEntries) {
    invalid('the archive central directory entry counts disagree')
  }
  if (entryCount === 0xffff) {
    invalid('ZIP64 archives are not accepted')
  }
  if (entryCount > limits.entryCount) {
    limit(`the archive declares more than ${limits.entryCount} entries`)
  }
  const centralSize = buffer.readUInt32LE(eocd + 12)
  const centralOffset = buffer.readUInt32LE(eocd + 16)
  if (centralOffset === 0xffffffff || centralSize === 0xffffffff) {
    invalid('ZIP64 archives are not accepted')
  }
  if (centralOffset + centralSize > buffer.length) {
    invalid('the archive central directory extends past the end of the file')
  }

  const entries: CentralEntry[] = []
  let cursor = centralOffset
  for (let index = 0; index < entryCount; index++) {
    if (cursor + 46 > buffer.length) invalid('truncated central directory entry')
    if (buffer.readUInt32LE(cursor) !== SIG_CENTRAL_FILE) {
      invalid('malformed central directory entry signature')
    }
    const gpFlags = buffer.readUInt16LE(cursor + 8)
    const method = buffer.readUInt16LE(cursor + 10)
    const entryCrc = buffer.readUInt32LE(cursor + 16)
    const compressedSize = buffer.readUInt32LE(cursor + 20)
    const uncompressedSize = buffer.readUInt32LE(cursor + 24)
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    const externalAttributes = buffer.readUInt32LE(cursor + 38)
    const localHeaderOffset = buffer.readUInt32LE(cursor + 42)
    const nameStart = cursor + 46
    if (nameStart + nameLength > buffer.length) invalid('truncated central directory name')
    const rawName = buffer.subarray(nameStart, nameStart + nameLength).toString('utf8')

    entries.push({
      rawName,
      method,
      gpFlags,
      crc32: entryCrc,
      compressedSize,
      uncompressedSize,
      externalAttributes,
      localHeaderOffset,
    })
    cursor = nameStart + nameLength + extraLength + commentLength
  }
  return entries
}

/**
 * 校验文件类型位。
 *
 * `externalAttributes` 的高 16 位是 Unix `st_mode`（当 versionMadeBy 指示 Unix 时）。
 * symlink（`S_IFLNK`）、设备、FIFO、socket 全部拒绝。**没有 mode 位时**（例如
 * Windows 打的包）按普通文件处理 —— 那种归档表达不了 symlink，所以也不构成风险。
 *
 * hardlink 在 ZIP 里没有表示形式：它只能通过重复 entry 或路径冲突出现，两者都在
 * `assertNoPathConflicts` 被拒。
 */
function assertRegularFileOrDirectory(entry: CentralEntry, isDirectoryName: boolean): void {
  const unixMode = (entry.externalAttributes >>> 16) & 0xffff
  if (unixMode === 0) return
  const fileType = unixMode & S_IFMT
  if (fileType === 0) return
  if (isDirectoryName) {
    if (fileType !== S_IFDIR) invalid('a directory entry declares a non-directory file type')
    return
  }
  if (fileType !== S_IFREG) {
    invalid('the archive contains a symlink, device, FIFO or socket entry')
  }
}

/**
 * 解析并展开一个 Skill Bundle 归档。
 *
 * 只在内存里展开，不落盘：调用方拿到的是路径 + 字节，落盘由 cache 层在**校验通过之后**
 * 做。这是"禁止先解压后检查"的结构性保证 —— 这个函数根本没有写文件的能力。
 */
export function readSkillArchive(archive: Buffer, limits: ZipReadLimits): ZipReadResult {
  const startedAt = Date.now()
  const deadline = () => {
    if (Date.now() - startedAt > limits.validateMs) {
      limit(`archive validation exceeded ${limits.validateMs}ms`)
    }
  }

  if (archive.length === 0) invalid('the archive is empty')
  if (archive.length > limits.archiveBytes) {
    limit(`the archive is larger than ${limits.archiveBytes} bytes`)
  }

  const central = readCentralDirectory(archive, limits)
  if (central.length === 0) invalid('the archive contains no entries')

  const files: ZipFileEntry[] = []
  const paths: string[] = []
  let expanded = 0
  let compressedTotal = 0

  for (const entry of central) {
    deadline()
    if ((entry.gpFlags & 0x1) !== 0) {
      invalid('encrypted archives are not accepted')
    }
    if (entry.method !== METHOD_STORE && entry.method !== METHOD_DEFLATE) {
      invalid('only stored and deflated entries are accepted')
    }

    const canonical = canonicalizeEntryPathOrReject(entry.rawName, limits)
    assertRegularFileOrDirectory(entry, canonical.isDirectory)
    if (canonical.isDirectory) {
      // 目录 entry 不携带内容，也不参与 manifest：目录由文件路径隐含创建。
      continue
    }
    if (entry.uncompressedSize > limits.fileBytes) {
      limit(`entry exceeds the ${limits.fileBytes} byte per-file limit`)
    }
    expanded += entry.uncompressedSize
    if (expanded > limits.expandedBytes) {
      limit(`the expanded archive exceeds ${limits.expandedBytes} bytes`)
    }
    compressedTotal += entry.compressedSize

    const bytes = readEntryBytes(archive, entry)
    if (bytes.length !== entry.uncompressedSize) {
      invalid('entry size does not match the central directory')
    }
    // CRC 是归档自带的完整性声明。它对不上意味着字节在传输或打包中损坏，
    // 而我们即将用这些字节算 bundle hash —— 先信 CRC，再算 hash。
    if ((crc32(bytes) >>> 0) !== (entry.crc32 >>> 0)) {
      invalid('entry CRC32 does not match the archive header')
    }

    paths.push(canonical.path)
    files.push({ path: canonical.path, bytes })
  }

  assertNoPathConflicts(paths)
  if (files.length === 0) invalid('the archive contains no files')
  if (files.length > limits.entryCount) {
    limit(`the archive contains more than ${limits.entryCount} files`)
  }
  // 压缩比闸门（Zip Bomb）。`compressedTotal === 0` 只可能出现在全部 entry 都是空文件
  // 的归档上，那种归档的展开量也是 0，不构成炸弹。
  if (compressedTotal > 0 && expanded / compressedTotal > limits.compressionRatio) {
    limit(`the archive compression ratio exceeds ${limits.compressionRatio}:1`)
  }
  deadline()

  return { files, expandedSizeBytes: expanded }
}

function canonicalizeEntryPathOrReject(
  rawName: string,
  limits: ZipReadLimits,
): { path: string; isDirectory: boolean } {
  try {
    return canonicalizeEntryPath(rawName, limits)
  } catch (err) {
    invalid(err instanceof Error ? err.message : 'entry path rejected')
  }
}

function readEntryBytes(archive: Buffer, entry: CentralEntry): Buffer {
  const offset = entry.localHeaderOffset
  if (offset + 30 > archive.length) invalid('truncated local file header')
  if (archive.readUInt32LE(offset) !== SIG_LOCAL_FILE) {
    invalid('malformed local file header signature')
  }
  const nameLength = archive.readUInt16LE(offset + 26)
  const extraLength = archive.readUInt16LE(offset + 28)
  const dataStart = offset + 30 + nameLength + extraLength
  const dataEnd = dataStart + entry.compressedSize
  if (dataEnd > archive.length) invalid('entry data extends past the end of the archive')

  const raw = archive.subarray(dataStart, dataEnd)
  if (entry.method === METHOD_STORE) {
    return Buffer.from(raw)
  }
  try {
    // `maxOutputLength` 是内存层面的第二道闸：即使中央目录谎报了 uncompressedSize，
    // inflate 也不会把进程吃掉。第一道是上面按声明值做的容量累加。
    return inflateRawSync(raw, { maxOutputLength: entry.uncompressedSize + 1 })
  } catch {
    invalid('entry could not be inflated')
  }
}
