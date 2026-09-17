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
 */

export interface SkillBundlePreview {
  /** ZIP 根部 SKILL.md 的 frontmatter `name`，取不到则为 null。 */
  name: string | null
  description: string | null
  whenToUse: string | null
  /** 归档里是否存在 `scripts/` 下的文件。仅用于提前提示，权威判定在服务端。 */
  containsScripts: boolean
  /** 根部是否存在 SKILL.md。false 时上面几项必然为空。 */
  hasEntry: boolean
}

const EMPTY: SkillBundlePreview = {
  name: null,
  description: null,
  whenToUse: null,
  containsScripts: false,
  hasEntry: false,
}

const ENTRY_PATH = 'SKILL.md'
const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
/** 只为读一个入口文件，没必要把大归档整块解压。 */
const MAX_ENTRY_BYTES = 1024 * 1024

/**
 * 读取 ZIP 中央目录，找到根部 `SKILL.md` 并解析出 frontmatter。
 *
 * 失败一律返回空预览（见文件头说明）。
 */
export async function readSkillBundlePreview(file: Blob): Promise<SkillBundlePreview> {
  try {
    const buffer = await file.arrayBuffer()
    const view = new DataView(buffer)
    const entries = readCentralDirectory(view)
    if (entries === null) return EMPTY

    const containsScripts = entries.some(
      (entry) => entry.path.startsWith('scripts/') && !entry.path.endsWith('/'),
    )
    const entry = entries.find((candidate) => candidate.path === ENTRY_PATH)
    if (entry === undefined) return { ...EMPTY, containsScripts }

    const text = await readEntryText(buffer, view, entry)
    if (text === null) return { ...EMPTY, containsScripts, hasEntry: true }

    const fields = readFrontmatterFields(text)
    return {
      name: fields.get('name') ?? null,
      description: fields.get('description') ?? null,
      whenToUse: fields.get('whenToUse') ?? fields.get('when-to-use') ?? null,
      containsScripts,
      hasEntry: true,
    }
  } catch {
    return EMPTY
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

async function readEntryText(
  buffer: ArrayBuffer,
  view: DataView,
  entry: CentralEntry,
): Promise<string | null> {
  if (entry.uncompressedSize > MAX_ENTRY_BYTES) return null

  const header = entry.localHeaderOffset
  if (header + 30 > view.byteLength) return null
  const nameLength = view.getUint16(header + 26, true)
  const extraLength = view.getUint16(header + 28, true)
  const start = header + 30 + nameLength + extraLength
  const end = start + entry.compressedSize
  if (end > view.byteLength) return null

  const raw = buffer.slice(start, end)
  if (entry.compressionMethod === 0) return decodeUtf8(raw, 0, raw.byteLength)
  if (entry.compressionMethod !== 8) return null

  // deflate-raw：ZIP 的 method 8 是裸 deflate 流，没有 zlib 头。
  const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  const inflated = await new Response(stream).arrayBuffer()
  return decodeUtf8(inflated, 0, inflated.byteLength)
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
