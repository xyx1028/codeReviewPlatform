/**
 * 浏览器端 Bundle 预览：从 ZIP 规范根目录（含单层外部目录）的 `SKILL.md` 里取出 frontmatter 的
 * `name` / `description` / `whenToUse`，用来预填「新增技能」表单。
 *
 * ## 这里**不是**校验器
 *
 * 归档的合法性由 Edge Function（`supabase/functions/skill-bundle-admin/bundle.ts`）
 * 与数据库各自独立判定，本文件的结果只用于**预填输入框**。所以它刻意不实现任何拒绝
 * 规则：读得出来就填上，读不出来就留空让管理员自己敲。
 *
 * 之所以要写死这条边界：仓库里已经有两份等价的严格校验实现（Edge Function 与 Worker），
 * 并且有一个 parity 测试盯着它们不许分叉。再加一份"浏览器也校验一遍"就是第三个会
 * 分叉的地方，而它偏偏是最没有权威性的那个 —— 前端拦不住任何人直接调 API。
 * 判定权只能有一处，前端只负责让人少打几个字。
 *
 * 因此：**任何"看起来该拒绝"的情况，这里都只返回空值，绝不抛错、绝不阻止提交。**
 * 真正的拒绝发生在服务端校验那一步，错误信息也来自那里。
 *
 * ## 为什么用 fflate 而不是 `DecompressionStream`
 *
 * 曾经这里用 `new DecompressionStream('deflate-raw')` 解压入口文件。它的代价是：
 * `deflate-raw` 要 Chrome/Edge ≥103、Firefox ≥113、Safari ≥16.4，低于此版本构造器直接抛
 * `TypeError`，被下面的 `catch` 吞掉后表现为"这个 ZIP 里没有 SKILL.md" —— 同一个包在一台
 * 电脑上能自动填名字、在另一台上不能，而错误信息完全指不到浏览器。
 *
 * 换成纯 JS 的 `inflateSync` 后解析结果只由字节决定，不再由浏览器版本决定。fflate 已经是
 * `read-excel-file` / `write-excel-file` 的传递依赖（同一个 0.8.3），提成直接依赖不增加
 * 安装面。
 *
 * ## `issue` 存在的理由
 *
 * 读不出来时仍然只是"留空让人手敲"，但**必须说清是哪一种读不出来**：不是 ZIP、SKILL.md
 * 被多包了多层目录、还是入口解压失败。一层唯一外部目录自动兼容。原来四种情况共用一句话，远程排查时无法区分。
 */

import { inflateSync } from 'fflate'

/** 预填失败的原因。仅用于措辞，不参与任何拒绝。 */
export type SkillBundlePreviewIssue =
  /** 连中央目录都读不出来：不是 ZIP、被截断，或加了密。 */
  | 'archive-unreadable'
  /** 是 ZIP，但根目录和任何子目录里都没有 SKILL.md。 */
  | 'entry-missing'
  /** SKILL.md 的目录结构不满足根目录或唯一一层外部目录要求。 */
  | 'entry-nested'
  /** 根部有 SKILL.md，但解压或 UTF-8 解码失败。 */
  | 'entry-unreadable'

export interface SkillBundlePreview {
  /** ZIP 规范根部 SKILL.md 的 frontmatter `name`，取不到则为 null。 */
  name: string | null
  description: string | null
  whenToUse: string | null
  /** 归档里是否存在 `scripts/` 下的文件。仅用于提前提示，权威判定在服务端。 */
  containsScripts: boolean
  /** 规范根部是否存在 SKILL.md。false 时上面几项必然为空。 */
  hasEntry: boolean
  /** null 表示 frontmatter 读取正常（字段仍可能为空）。 */
  issue: SkillBundlePreviewIssue | null
  /** 仅 `entry-nested` 时非空：SKILL.md 实际所在的归档内路径。 */
  nestedEntryPath: string | null
  /** 远程排查用的可读证据，见 SkillBundleDiagnostics。 */
  diagnostics: SkillBundleDiagnostics
}

/**
 * 解析过程留下的证据。
 *
 * 为什么要它：`archive-unreadable` 这一个 issue 覆盖了三种**处置动作完全不同**的现实情况 ——
 * 浏览器连字节都读不到（文件是云盘占位符 / 选中后被移动）、字节读到了但不是 ZIP、
 * 以及字节被截断导致中央目录读一半崩掉（IM 传输、下载中断的典型形态）。
 * 2026-09-24 就撞上一次：同一个包在一台机器上正常、在同事那里报这条，
 * 而提示里除了"请重新打包"没有任何可对账的信息，只能来回问。
 *
 * 所以这里记下**能对账的客观量**：字节数、sha256、文件头签名、EOCD 的位置与声明值、
 * 解析到第几条中央目录记录才失败。有了 sha256 就能一句话判定"是不是同一份文件"。
 *
 * 不记内容：只记条目数量与失败位置的偏移，不记文件正文，也不记条目路径以外的东西。
 */
export interface SkillBundleDiagnostics {
  fileName: string | null
  fileBytes: number | null
  lastModified: string | null
  /** `file.arrayBuffer()` 抛出的错误（云盘占位符、选中后文件被移动时出现）。 */
  readError: string | null
  /** 文件头 4 字节。正常 ZIP 是 504b0304。 */
  headSignature: string | null
  /** 整份文件的 sha256，用于跟"已知正确的那一份"对账。算不出来时为 null。 */
  sha256: string | null
  eocdOffset: number | null
  declaredEntryCount: number | null
  centralDirOffset: number | null
  centralDirSize: number | null
  commentLength: number | null
  /** 是否出现 ZIP64 结构（本解析器只读 32 位字段，遇到它会读不出来）。 */
  zip64: boolean
  /** 成功读出的中央目录条目数。 */
  parsedEntryCount: number
  /** 失败发生的环节。null 表示解析全程正常。 */
  failureStage:
    | 'file-read'
    | 'eocd-not-found'
    | 'central-directory'
    | 'entry-not-found'
    | 'entry-decode'
    | null
  /** 一句可读的失败位置，例如 `entry #4 at 0x1a2b: bad signature 0x08074b50`。 */
  failureDetail: string | null
}

function emptyDiagnostics(): SkillBundleDiagnostics {
  return {
    fileName: null,
    fileBytes: null,
    lastModified: null,
    readError: null,
    headSignature: null,
    sha256: null,
    eocdOffset: null,
    declaredEntryCount: null,
    centralDirOffset: null,
    centralDirSize: null,
    commentLength: null,
    zip64: false,
    parsedEntryCount: 0,
    failureStage: null,
    failureDetail: null,
  }
}

const EMPTY: Omit<SkillBundlePreview, 'diagnostics'> = {
  name: null,
  description: null,
  whenToUse: null,
  containsScripts: false,
  hasEntry: false,
  issue: null,
  nestedEntryPath: null,
}

/** Packaging metadata is never materialized. Unsafe paths cannot be hidden by this filter. */
function isPackagingMetadataPath(rawName: string): boolean {
  if (rawName.includes('\\') || rawName.includes('\0') || rawName.normalize('NFC') !== rawName) return false
  const parts = rawName.replace(/\/$/, '').split('/')
  if (parts.some((part) => part === '.' || part === '..' || !/^[A-Za-z0-9._-]+$/.test(part))) return false
  return parts.some((part) =>
    part === '__MACOSX' || part === '.DS_Store' || part.startsWith('._') ||
    /^(Thumbs\.db|desktop\.ini)$/i.test(part),
  )
}

/** Strip exactly one common folder, never search recursively for an arbitrary SKILL.md. */
function skillArchiveRootPrefix(paths: readonly string[]): string {
  if (paths.includes('SKILL.md')) return ''
  const candidate = paths.find((path) => /^[^/]+\/SKILL\.md$/.test(path))
  if (candidate === undefined) return ''
  const prefix = candidate.slice(0, -'SKILL.md'.length)
  return paths.every((path) => path === prefix || path.startsWith(prefix)) ? prefix : ''
}

const ENTRY_PATH = 'SKILL.md'
const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const ZIP64_EOCD_SIGNATURE = 0x06064b50
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50
/** 只为读一个入口文件，没必要把大归档整块解压。 */
const MAX_ENTRY_BYTES = 1024 * 1024

/** 一行可复制的摘要，给「把截图发过来」这种排查路径用。 */
export function formatBundleDiagnostics(diagnostics: SkillBundleDiagnostics): string {
  const parts = [
    `bytes=${diagnostics.fileBytes ?? '?'}`,
    `sha256=${diagnostics.sha256 === null ? '?' : diagnostics.sha256.slice(0, 16)}`,
    `head=${diagnostics.headSignature ?? '?'}`,
    `eocd=${diagnostics.eocdOffset ?? 'none'}`,
    `entries=${diagnostics.parsedEntryCount}/${diagnostics.declaredEntryCount ?? '?'}`,
  ]
  if (diagnostics.zip64) parts.push('zip64=yes')
  if (diagnostics.failureStage !== null) parts.push(`stage=${diagnostics.failureStage}`)
  if (diagnostics.readError !== null) parts.push(`readError=${diagnostics.readError}`)
  if (diagnostics.failureDetail !== null) parts.push(`detail=${diagnostics.failureDetail}`)
  return parts.join(' · ')
}

async function digestSha256(buffer: ArrayBuffer): Promise<string | null> {
  try {
    const subtle = globalThis.crypto?.subtle
    // 非安全上下文（http:// 且非 localhost）下 subtle 不存在 —— 这不是错误，只是少一项证据。
    if (subtle === undefined) return null
    const digest = await subtle.digest('SHA-256', buffer)
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  } catch {
    return null
  }
}

/**
 * 读取 ZIP 中央目录，找到根部 `SKILL.md` 并解析出 frontmatter。
 *
 * 失败一律返回空预览 + `issue` + `diagnostics`（见文件头说明），永不抛错。
 */
export async function readSkillBundlePreview(file: Blob): Promise<SkillBundlePreview> {
  // 提到 try 外面：入口解压失败时这条提示仍然有效，不该跟着一起丢。
  let containsScripts = false
  let reachedEntry = false
  const diagnostics = emptyDiagnostics()
  diagnostics.fileBytes = file.size
  if (file instanceof File) {
    diagnostics.fileName = file.name
    diagnostics.lastModified = new Date(file.lastModified).toISOString()
  }

  let buffer: ArrayBuffer
  try {
    buffer = await file.arrayBuffer()
  } catch (error) {
    // 这里失败与"不是 ZIP"是两回事：文件是云盘占位符、或选中后被移动/删除都走这条。
    diagnostics.failureStage = 'file-read'
    diagnostics.readError = describeError(error)
    return { ...EMPTY, issue: 'archive-unreadable', diagnostics }
  }

  diagnostics.fileBytes = buffer.byteLength
  diagnostics.headSignature = readHeadSignature(buffer)
  diagnostics.sha256 = await digestSha256(buffer)

  try {
    const view = new DataView(buffer)
    const entries = readCentralDirectory(view, diagnostics)
    if (entries === null) return { ...EMPTY, issue: 'archive-unreadable', diagnostics }

    const effective = entries.filter((entry) => !isPackagingMetadataPath(entry.path))
    const prefix = skillArchiveRootPrefix(effective.map((entry) => entry.path))
    containsScripts = effective.some(
      (entry) => entry.path.slice(prefix.length).startsWith('scripts/') && !entry.path.endsWith('/'),
    )
    const entry = effective.find((candidate) => candidate.path === prefix + ENTRY_PATH)
    if (entry === undefined) {
      const nested = effective.find((candidate) => candidate.path.endsWith(`/${ENTRY_PATH}`))
      diagnostics.failureStage = 'entry-not-found'
      diagnostics.failureDetail =
        nested === undefined ? 'no SKILL.md in archive' : `SKILL.md nested at ${nested.path}`
      return {
        ...EMPTY,
        containsScripts,
        issue: nested === undefined ? 'entry-missing' : 'entry-nested',
        nestedEntryPath: nested?.path ?? null,
        diagnostics,
      }
    }

    reachedEntry = true
    const text = readEntryText(buffer, view, entry)
    if (text === null) {
      diagnostics.failureStage = 'entry-decode'
      diagnostics.failureDetail = `SKILL.md method=${entry.compressionMethod} compressed=${entry.compressedSize} uncompressed=${entry.uncompressedSize}`
      return { ...EMPTY, containsScripts, hasEntry: true, issue: 'entry-unreadable', diagnostics }
    }

    const fields = readFrontmatterFields(text)
    return {
      name: fields.get('name') ?? null,
      description: fields.get('description') ?? null,
      whenToUse: fields.get('whenToUse') ?? fields.get('when-to-use') ?? null,
      containsScripts,
      hasEntry: true,
      issue: null,
      nestedEntryPath: null,
      diagnostics,
    }
  } catch (error) {
    if (diagnostics.failureStage === null) {
      diagnostics.failureStage = reachedEntry ? 'entry-decode' : 'central-directory'
    }
    diagnostics.failureDetail = diagnostics.failureDetail ?? describeError(error)
    return {
      ...EMPTY,
      containsScripts,
      hasEntry: reachedEntry,
      issue: reachedEntry ? 'entry-unreadable' : 'archive-unreadable',
      diagnostics,
    }
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`.slice(0, 200)
  return String(error).slice(0, 200)
}

function readHeadSignature(buffer: ArrayBuffer): string | null {
  const head = new Uint8Array(buffer, 0, Math.min(4, buffer.byteLength))
  if (head.length === 0) return null
  return [...head].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

interface CentralEntry {
  path: string
  compressionMethod: number
  compressedSize: number
  uncompressedSize: number
  localHeaderOffset: number
}

function readCentralDirectory(
  view: DataView,
  diagnostics: SkillBundleDiagnostics,
): CentralEntry[] | null {
  const eocd = findEndOfCentralDirectory(view)
  if (eocd === null) {
    diagnostics.failureStage = 'eocd-not-found'
    diagnostics.failureDetail = 'no end-of-central-directory signature in the last 64 KiB'
    return null
  }

  diagnostics.eocdOffset = eocd
  const count = view.getUint16(eocd + 10, true)
  let offset = view.getUint32(eocd + 16, true)
  diagnostics.declaredEntryCount = count
  diagnostics.centralDirOffset = offset
  diagnostics.centralDirSize = view.getUint32(eocd + 12, true)
  diagnostics.commentLength = view.getUint16(eocd + 20, true)
  diagnostics.zip64 = hasZip64Structures(view, eocd)
  const entries: CentralEntry[] = []

  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > view.byteLength) {
      diagnostics.failureStage = 'central-directory'
      diagnostics.failureDetail = `entry #${index + 1} at ${offset} runs past end of file (${view.byteLength})`
      return null
    }
    const signature = view.getUint32(offset, true)
    if (signature !== CENTRAL_SIGNATURE) {
      diagnostics.failureStage = 'central-directory'
      diagnostics.failureDetail = `entry #${index + 1} at ${offset}: signature 0x${signature.toString(16)} is not 0x2014b50`
      return null
    }

    const compressionMethod = view.getUint16(offset + 10, true)
    const compressedSize = view.getUint32(offset + 20, true)
    const uncompressedSize = view.getUint32(offset + 24, true)
    const nameLength = view.getUint16(offset + 28, true)
    const extraLength = view.getUint16(offset + 30, true)
    const commentLength = view.getUint16(offset + 32, true)
    const localHeaderOffset = view.getUint32(offset + 42, true)

    const path = decodeUtf8(view.buffer, offset + 46, nameLength)
    if (path === null) {
      // 典型成因：在中文 Windows 上用系统「发送到压缩文件夹」打的包，文件名是 GBK 而不是 UTF-8。
      diagnostics.failureStage = 'central-directory'
      diagnostics.failureDetail = `entry #${index + 1} at ${offset}: file name is not valid UTF-8 (length ${nameLength})`
      return null
    }

    entries.push({ path, compressionMethod, compressedSize, uncompressedSize, localHeaderOffset })
    offset += 46 + nameLength + extraLength + commentLength
    diagnostics.parsedEntryCount = entries.length
  }
  return entries
}

/**
 * EOCD 之前是否有 ZIP64 结构。
 *
 * 本解析器只读 32 位字段，所以真正的 ZIP64 归档（条目数或偏移超过 32 位）它读不出来。
 * 记下来是为了让失败原因指向"重新用普通 ZIP 打包"，而不是让人反复重传同一个包。
 */
function hasZip64Structures(view: DataView, eocd: number): boolean {
  const from = Math.max(0, eocd - 40)
  for (let offset = from; offset + 4 <= eocd; offset += 1) {
    const signature = view.getUint32(offset, true)
    if (signature === ZIP64_EOCD_SIGNATURE || signature === ZIP64_LOCATOR_SIGNATURE) return true
  }
  return false
}

/** EOCD 在文件尾部，注释最长 65535 字节，所以从尾部往前扫这个窗口。 */
function findEndOfCentralDirectory(view: DataView): number | null {
  const minimum = Math.max(0, view.byteLength - (22 + 0xffff))
  for (let offset = view.byteLength - 22; offset >= minimum; offset -= 1) {
    if (view.getUint32(offset, true) === EOCD_SIGNATURE) return offset
  }
  return null
}

function readEntryText(
  buffer: ArrayBuffer,
  view: DataView,
  entry: CentralEntry,
): string | null {
  if (entry.uncompressedSize > MAX_ENTRY_BYTES) return null

  const header = entry.localHeaderOffset
  if (header + 30 > view.byteLength) return null
  const nameLength = view.getUint16(header + 26, true)
  const extraLength = view.getUint16(header + 28, true)
  const start = header + 30 + nameLength + extraLength
  const end = start + entry.compressedSize
  if (end > view.byteLength) return null

  const raw = new Uint8Array(buffer, start, entry.compressedSize)
  if (entry.compressionMethod === 0) return decodeUtf8(buffer, start, entry.compressedSize)
  // ZIP 的 method 8 是裸 deflate 流（没有 zlib 头），对应 fflate 的 inflateSync。
  if (entry.compressionMethod !== 8) return null
  // 中央目录里的 uncompressedSize 即使用了 data descriptor 也是真值；拿它预分配输出缓冲，
  // 顺带把浏览器端的 Zip Bomb 上限钉在 MAX_ENTRY_BYTES。
  if (entry.uncompressedSize === 0) return null

  const inflated = inflateSync(raw, { out: new Uint8Array(entry.uncompressedSize) })
  return decodeUtf8(inflated.buffer, inflated.byteOffset, inflated.byteLength)
}

function decodeUtf8(buffer: ArrayBufferLike, offset: number, length: number): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(buffer, offset, length))
  } catch {
    return null
  }
}

/**
 * 取出首个 `---` 块里的扁平 `key: value` 字段。
 *
 * 这是**宽松**读取：不判断字段是否齐全、值是否合法、块是否规范闭合。那些都由服务端说。
 */
function readFrontmatterFields(text: string): Map<string, string> {
  const fields = new Map<string, string>()
  const withoutBom = text.startsWith('\ufeff') ? text.slice(1) : text
  const lines = withoutBom.split(/\r?\n/)
  if (lines[0]?.trim() !== '---') return fields

  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim() === '---') break
    const match = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line)
    if (match === null) continue
    const value = stripQuotes(match[2].trim())
    if (value.length > 0 && !fields.has(match[1])) fields.set(match[1], value)
  }
  return fields
}

function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1)
    }
  }
  return value
}
