/**
 * 浏览器端 Bundle 预览：从 ZIP 根目录的 `SKILL.md` 里取出 frontmatter 的
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
 * 被多包了一层目录、还是入口解压失败。原来四种情况共用一句话，远程排查时无法区分。
 */

import { inflateSync } from 'fflate'

/** 预填失败的原因。仅用于措辞，不参与任何拒绝。 */
export type SkillBundlePreviewIssue =
  /** 连中央目录都读不出来：不是 ZIP、被截断，或加了密。 */
  | 'archive-unreadable'
  /** 是 ZIP，但根目录和任何子目录里都没有 SKILL.md。 */
  | 'entry-missing'
  /** SKILL.md 在子目录里 —— 通常是"压缩了外层文件夹"这个经典错误。 */
  | 'entry-nested'
  /** 根部有 SKILL.md，但解压或 UTF-8 解码失败。 */
  | 'entry-unreadable'

export interface SkillBundlePreview {
  /** ZIP 根部 SKILL.md 的 frontmatter `name`，取不到则为 null。 */
  name: string | null
  description: string | null
  whenToUse: string | null
  /** 归档里是否存在 `scripts/` 下的文件。仅用于提前提示，权威判定在服务端。 */
  containsScripts: boolean
  /** 根部是否存在 SKILL.md。false 时上面几项必然为空。 */
  hasEntry: boolean
  /** null 表示 frontmatter 读取正常（字段仍可能为空）。 */
  issue: SkillBundlePreviewIssue | null
  /** 仅 `entry-nested` 时非空：SKILL.md 实际所在的归档内路径。 */
  nestedEntryPath: string | null
}

const EMPTY: SkillBundlePreview = {
  name: null,
  description: null,
  whenToUse: null,
  containsScripts: false,
  hasEntry: false,
  issue: null,
  nestedEntryPath: null,
}

const ENTRY_PATH = 'SKILL.md'
const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
/** 只为读一个入口文件，没必要把大归档整块解压。 */
const MAX_ENTRY_BYTES = 1024 * 1024

/**
 * 读取 ZIP 中央目录，找到根部 `SKILL.md` 并解析出 frontmatter。
 *
 * 失败一律返回空预览 + `issue`（见文件头说明），永不抛错。
 */
export async function readSkillBundlePreview(file: Blob): Promise<SkillBundlePreview> {
  // 提到 try 外面：入口解压失败时这条提示仍然有效，不该跟着一起丢。
  let containsScripts = false
  let reachedEntry = false
  try {
    const buffer = await file.arrayBuffer()
    const view = new DataView(buffer)
    const entries = readCentralDirectory(view)
    if (entries === null) return { ...EMPTY, issue: 'archive-unreadable' }

    containsScripts = entries.some(
      (entry) => entry.path.startsWith('scripts/') && !entry.path.endsWith('/'),
    )
    const entry = entries.find((candidate) => candidate.path === ENTRY_PATH)
    if (entry === undefined) {
      const nested = entries.find((candidate) => candidate.path.endsWith(`/${ENTRY_PATH}`))
      return {
        ...EMPTY,
        containsScripts,
        issue: nested === undefined ? 'entry-missing' : 'entry-nested',
        nestedEntryPath: nested?.path ?? null,
      }
    }

    reachedEntry = true
    const text = readEntryText(buffer, view, entry)
    if (text === null) {
      return { ...EMPTY, containsScripts, hasEntry: true, issue: 'entry-unreadable' }
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
    }
  } catch {
    return {
      ...EMPTY,
      containsScripts,
      hasEntry: reachedEntry,
      issue: reachedEntry ? 'entry-unreadable' : 'archive-unreadable',
    }
  }
}

interface CentralEntry {
  path: string
  compressionMethod: number
  compressedSize: number
  uncompressedSize: number
  localHeaderOffset: number
}

function readCentralDirectory(view: DataView): CentralEntry[] | null {
  const eocd = findEndOfCentralDirectory(view)
  if (eocd === null) return null

  const count = view.getUint16(eocd + 10, true)
  let offset = view.getUint32(eocd + 16, true)
  const entries: CentralEntry[] = []

  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > view.byteLength) return null
    if (view.getUint32(offset, true) !== CENTRAL_SIGNATURE) return null

    const compressionMethod = view.getUint16(offset + 10, true)
    const compressedSize = view.getUint32(offset + 20, true)
    const uncompressedSize = view.getUint32(offset + 24, true)
    const nameLength = view.getUint16(offset + 28, true)
    const extraLength = view.getUint16(offset + 30, true)
    const commentLength = view.getUint16(offset + 32, true)
    const localHeaderOffset = view.getUint32(offset + 42, true)

    const path = decodeUtf8(view.buffer, offset + 46, nameLength)
    if (path === null) return null

    entries.push({ path, compressionMethod, compressedSize, uncompressedSize, localHeaderOffset })
    offset += 46 + nameLength + extraLength + commentLength
  }
  return entries
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
