// supabase/functions/skill-bundle-admin/bundle.ts
//
// 服务端归档校验与规范 manifest 生成（方案 §6.3、§7、§8.1）。
//
// 这份实现与 `worker/src/ai/skills/*` 是**故意重复**的，不是漏抽公共模块：
//
//   * 方案 §7.1 要求"Worker 必须独立重算，不能相信数据库或上传方自报"。两侧共用一份
//     代码就只有一次判断 —— 那时"三层 hash"只是同一个声明被抄了三遍。
//   * 两侧的运行时也不同：Worker 在 Node 上用 `zlib.inflateRawSync`（同步），这里在 Deno
//     上只有 `DecompressionStream`（异步 Web Streams）。硬抽一层适配只会让两边都更难读。
//
// 代价是"改一处要改两处"。规范格式因此被写成显式的行式文本（见 `bundleHashInput`），
// 任何一侧改错都会立刻在 hash 上暴露，而不是悄悄接受一个非法 Bundle。

export type SkillFileRole = 'ENTRY' | 'REFERENCE' | 'ASSET' | 'TEMPLATE' | 'SCRIPT' | 'OTHER'

export interface SkillBundleFile {
  path: string
  sha256: string
  sizeBytes: number
  mediaType: string
  role: SkillFileRole
}

export interface SkillBundleManifest {
  schemaVersion: 1
  skillName: string
  entry: 'SKILL.md'
  archiveSha256: string
  archiveSizeBytes: number
  expandedSizeBytes: number
  containsScripts: boolean
  files: SkillBundleFile[]
}

export interface ValidatedBundle {
  manifest: SkillBundleManifest
  bundleHash: string
  archiveSha256: string
  archiveSizeBytes: number
  expandedSizeBytes: number
  fileCount: number
  containsScripts: boolean
  /** 供 UI 展示的文件树。不含任何文件正文。 */
  tree: SkillBundleFile[]
  /** 入口 frontmatter：name / description / whenToUse 的唯一可信来源。 */
  frontmatter: SkillEntryFrontmatter
}

export const LIMITS = {
  archiveBytes: 10 * 1024 * 1024,
  expandedBytes: 50 * 1024 * 1024,
  entryCount: 200,
  fileBytes: 10 * 1024 * 1024,
  entryFileBytes: 64 * 1024,
  pathDepth: 8,
  pathBytes: 240,
  compressionRatio: 20,
  validateMs: 30000,
} as const

export const SKILL_ENTRY_FILE = 'SKILL.md'

/** 稳定错误码。与 Worker 侧同名，运维按码处置，不按文案。 */
export type BundleErrorCode = 'SKILL_BUNDLE_INVALID' | 'SKILL_BUNDLE_LIMIT_EXCEEDED'

export class BundleError extends Error {
  readonly code: BundleErrorCode
  constructor(code: BundleErrorCode, message: string) {
    super(message)
    this.name = 'BundleError'
    this.code = code
  }
}

function invalid(message: string): never {
  throw new BundleError('SKILL_BUNDLE_INVALID', message)
}

function overLimit(message: string): never {
  throw new BundleError('SKILL_BUNDLE_LIMIT_EXCEEDED', message)
}

// ---------------------------------------------------------------------------
// 路径规则（§7.2）
// ---------------------------------------------------------------------------

const SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export function canonicalizeEntryPath(rawName: string): { path: string; isDirectory: boolean } {
  if (rawName.includes('\0')) invalid('entry path contains a NUL byte')
  // 反斜杠一律拒绝而不是"统一成 /"：把 `a\b` 当一层还是两层是解压器的自由，于是同一个
  // 归档在不同实现下可以指向不同位置。那正是路径歧义攻击的入口。
  if (rawName.includes('\\')) invalid('entry path contains a backslash')
  if (rawName.normalize('NFC') !== rawName) invalid('entry path is not Unicode NFC normalized')
  if (rawName.startsWith('/')) invalid('entry path is absolute')
  if (/^[A-Za-z]:/.test(rawName)) invalid('entry path carries a Windows drive letter')
  if (rawName.startsWith('//')) invalid('entry path looks like a UNC path')

  const isDirectory = rawName.endsWith('/')
  const trimmed = isDirectory ? rawName.slice(0, -1) : rawName
  if (trimmed === '') invalid('entry path is empty')

  const segments = trimmed.split('/')
  if (segments.length > LIMITS.pathDepth) {
    overLimit(`entry path is deeper than ${LIMITS.pathDepth} levels`)
  }
  for (const segment of segments) {
    if (segment === '') invalid('entry path contains an empty segment')
    if (segment === '.' || segment === '..') invalid('entry path contains a relative segment')
    if (!SEGMENT_PATTERN.test(segment)) {
      invalid('entry path contains characters outside the allowed set')
    }
  }
  const path = segments.join('/')
  if (new TextEncoder().encode(path).byteLength > LIMITS.pathBytes) {
    overLimit(`entry path is longer than ${LIMITS.pathBytes} bytes`)
  }
  return { path, isDirectory }
}

// ---------------------------------------------------------------------------
// 类型与角色（§7.3）
// ---------------------------------------------------------------------------

const MEDIA_TYPES: Record<string, string> = {
  md: 'text/markdown',
  txt: 'text/plain',
  json: 'application/json',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  csv: 'text/csv',
  xml: 'application/xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  sh: 'application/x-sh',
  js: 'text/javascript',
  mjs: 'text/javascript',
  cjs: 'text/javascript',
}

const TEXTUAL = ['md', 'txt', 'json', 'yaml', 'yml', 'csv', 'xml']
const ROLE_EXTENSIONS: Record<SkillFileRole, readonly string[]> = {
  ENTRY: ['md'],
  REFERENCE: TEXTUAL,
  TEMPLATE: TEXTUAL,
  OTHER: TEXTUAL,
  ASSET: ['png', 'jpg', 'jpeg', 'webp', 'gif'],
  SCRIPT: ['sh', 'js', 'mjs', 'cjs'],
}

export function roleForPath(path: string): SkillFileRole {
  if (path === SKILL_ENTRY_FILE) return 'ENTRY'
  if (path.startsWith('references/')) return 'REFERENCE'
  if (path.startsWith('assets/')) return 'ASSET'
  if (path.startsWith('templates/')) return 'TEMPLATE'
  if (path.startsWith('scripts/')) return 'SCRIPT'
  return 'OTHER'
}

function extensionOf(path: string): string {
  const dot = path.lastIndexOf('.')
  const slash = path.lastIndexOf('/')
  if (dot <= slash + 1) return ''
  return path.slice(dot + 1).toLowerCase()
}

const IMAGE_MAGIC: Array<{ mediaType: string; test: (bytes: Uint8Array) => boolean }> = [
  {
    mediaType: 'image/png',
    test: (b) =>
      b.length >= 8 &&
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, index) => b[index] === byte),
  },
  {
    mediaType: 'image/jpeg',
    test: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    mediaType: 'image/webp',
    test: (b) =>
      b.length >= 12 &&
      latin1(b.subarray(0, 4)) === 'RIFF' &&
      latin1(b.subarray(8, 12)) === 'WEBP',
  },
  {
    mediaType: 'image/gif',
    test: (b) => b.length >= 6 && /^GIF8[79]a$/.test(latin1(b.subarray(0, 6))),
  },
]

function latin1(bytes: Uint8Array): string {
  let out = ''
  for (const byte of bytes) out += String.fromCharCode(byte)
  return out
}

/**
 * 严格 UTF-8。
 *
 * `TextDecoder` 默认把非法序列替换成 U+FFFD 而不是报错，所以必须显式 `fatal: true`。
 * 另外拒绝内嵌 NUL：一个带 NUL 的"文本"文件在任何下游消费者里都是意外，而且是典型的
 * 截断攻击载荷。
 */
function assertStrictUtf8(bytes: Uint8Array, path: string): void {
  if (bytes.includes(0)) invalid(`text resource contains a NUL byte: ${path}`)
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    invalid(`text resource is not valid UTF-8: ${path}`)
  }
}

// ---------------------------------------------------------------------------
// ZIP 解析（§7.2、§8.1）
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index++) {
    let value = index
    for (let bit = 0; bit < 8; bit++) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

async function inflateRaw(bytes: Uint8Array, expectedSize: number): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  const chunks: Uint8Array[] = []
  let total = 0
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength
    // 声明值 + 1 作为硬上限：即使中央目录谎报了 uncompressedSize，也不会把函数吃掉内存。
    if (total > expectedSize + 1) overLimit('entry inflates beyond its declared size')
    chunks.push(chunk)
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

interface CentralEntry {
  rawName: string
  method: number
  flags: number
  crc: number
  compressedSize: number
  uncompressedSize: number
  unixMode: number
  localOffset: number
}

const S_IFMT = 0o170000
const S_IFREG = 0o100000
const S_IFDIR = 0o040000

function readCentralDirectory(view: DataView, bytes: Uint8Array): CentralEntry[] {
  let eocd = -1
  const scanStart = Math.max(0, bytes.length - (0xffff + 22))
  for (let offset = bytes.length - 22; offset >= scanStart; offset--) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      eocd = offset
      break
    }
  }
  if (eocd < 0) invalid('the archive has no end-of-central-directory record')
  if (eocd >= 20 && view.getUint32(eocd - 20, true) === 0x07064b50) {
    invalid('ZIP64 archives are not accepted')
  }
  if (view.getUint16(eocd + 4, true) !== 0 || view.getUint16(eocd + 6, true) !== 0) {
    invalid('multi-disk archives are not accepted')
  }
  const entriesOnDisk = view.getUint16(eocd + 8, true)
  const totalEntries = view.getUint16(eocd + 10, true)
  if (entriesOnDisk !== totalEntries) invalid('central directory entry counts disagree')
  if (totalEntries === 0xffff) invalid('ZIP64 archives are not accepted')
  if (totalEntries > LIMITS.entryCount) {
    overLimit(`the archive declares more than ${LIMITS.entryCount} entries`)
  }
  const centralSize = view.getUint32(eocd + 12, true)
  const centralOffset = view.getUint32(eocd + 16, true)
  if (centralOffset === 0xffffffff || centralSize === 0xffffffff) {
    invalid('ZIP64 archives are not accepted')
  }
  if (centralOffset + centralSize > bytes.length) {
    invalid('the central directory extends past the end of the archive')
  }

  const entries: CentralEntry[] = []
  let cursor = centralOffset
  const decoder = new TextDecoder('utf-8', { fatal: false })
  for (let index = 0; index < totalEntries; index++) {
    if (cursor + 46 > bytes.length) invalid('truncated central directory entry')
    if (view.getUint32(cursor, true) !== 0x02014b50) {
      invalid('malformed central directory entry signature')
    }
    const nameLength = view.getUint16(cursor + 28, true)
    const extraLength = view.getUint16(cursor + 30, true)
    const commentLength = view.getUint16(cursor + 32, true)
    const nameStart = cursor + 46
    if (nameStart + nameLength > bytes.length) invalid('truncated central directory name')
    entries.push({
      rawName: decoder.decode(bytes.subarray(nameStart, nameStart + nameLength)),
      flags: view.getUint16(cursor + 8, true),
      method: view.getUint16(cursor + 10, true),
      crc: view.getUint32(cursor + 16, true),
      compressedSize: view.getUint32(cursor + 20, true),
      uncompressedSize: view.getUint32(cursor + 24, true),
      unixMode: (view.getUint32(cursor + 38, true) >>> 16) & 0xffff,
      localOffset: view.getUint32(cursor + 42, true),
    })
    cursor = nameStart + nameLength + extraLength + commentLength
  }
  return entries
}

async function readEntryBytes(
  view: DataView,
  bytes: Uint8Array,
  entry: CentralEntry,
): Promise<Uint8Array> {
  const offset = entry.localOffset
  if (offset + 30 > bytes.length) invalid('truncated local file header')
  if (view.getUint32(offset, true) !== 0x04034b50) invalid('malformed local file header signature')
  const nameLength = view.getUint16(offset + 26, true)
  const extraLength = view.getUint16(offset + 28, true)
  const dataStart = offset + 30 + nameLength + extraLength
  const dataEnd = dataStart + entry.compressedSize
  if (dataEnd > bytes.length) invalid('entry data extends past the end of the archive')
  const raw = bytes.subarray(dataStart, dataEnd)
  if (entry.method === 0) return raw
  return await inflateRaw(raw, entry.uncompressedSize)
}

// ---------------------------------------------------------------------------
// 规范 hash（必须与 SQL 的 skill_bundle_hash_input 逐字节一致）
// ---------------------------------------------------------------------------

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function sha256Prefixed(bytes: Uint8Array): Promise<string> {
  return `sha256:${await sha256Hex(bytes)}`
}

function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

export function bundleHashInput(manifest: SkillBundleManifest): string {
  let text = [
    'skill-bundle-v1',
    `schemaVersion=${manifest.schemaVersion}`,
    `skillName=${manifest.skillName}`,
    `entry=${manifest.entry}`,
  ].join('\n')
  text += '\n'
  for (const file of [...manifest.files].sort((a, b) => byCodeUnit(a.path, b.path))) {
    text += `${file.path}\t${file.sha256}\t${file.sizeBytes}\t${file.mediaType}\t${file.role}\n`
  }
  return text
}

export async function computeBundleHash(manifest: SkillBundleManifest): Promise<string> {
  return `sha256:${await sha256Hex(new TextEncoder().encode(bundleHashInput(manifest)))}`
}

// ---------------------------------------------------------------------------
// SKILL.md frontmatter（§19.2「非法 frontmatter 均拒绝发布」）
//
// dsh 的 `skill-filesystem` 要求入口带 YAML frontmatter，且其中必须有非空的 `name` 与
// `description`。缺了它，`parseSkillFile` 只写一行 `logger.warn` 就 return —— 技能对模型
// 等于不存在，而平台侧**没有任何错误码**。所以这一层必须在发布时把关。
//
// 刻意只接受一个很窄的 YAML 子集（平铺 `key: value`）：我们接受的集合必须是 dsh 接受
// 集合的子集。一个"尽量宽容"的自制解析器会放过 dsh 会拒的东西，把问题推回运行时。
// 与 `worker/src/ai/skills/skill-frontmatter.ts` 保持等价，由
// `worker/src/__tests__/v16-skill-validator-parity.test.ts` 机械守住。
// ---------------------------------------------------------------------------

const DSH_SKILL_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/
const LEGACY_INVOCATION_KEYS = ['disableModelInvocation', 'modelInvocable', 'userInvocable']
const FRONTMATTER_LINE = /^([A-Za-z][A-Za-z0-9_-]*):[ \t]*(.*)$/
const BOOLEANISH = ['true', 'false', 'yes', 'no', 'on', 'off', '0', '1']
const TRUTHY = ['true', 'yes', 'on', '1']

export interface SkillEntryFrontmatter {
  name: string
  description: string
  whenToUse?: string
}

function unquote(raw: string): string {
  const value = raw.trim()
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1)
    }
  }
  return value
}

export function parseSkillEntryFrontmatter(
  text: string,
  expectedName: string,
): SkillEntryFrontmatter {
  const firstLineEnd = text.indexOf('\n')
  if (firstLineEnd < 0) {
    invalid('SKILL.md must open with a YAML frontmatter block delimited by "---"')
  }
  if (text.slice(0, firstLineEnd).replace(/\r$/, '') !== '---') {
    invalid('SKILL.md must start with "---" on its very first line')
  }

  const lines = text.slice(firstLineEnd + 1).split('\n')
  const fields = new Map<string, string>()
  let closed = false
  let bodyStart = lines.length
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!.replace(/\r$/, '')
    if (line === '---') {
      closed = true
      bodyStart = index + 1
      break
    }
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    if (/^[ \t]/.test(line)) {
      invalid('SKILL.md frontmatter only accepts flat "key: value" fields')
    }
    const match = FRONTMATTER_LINE.exec(line)
    if (match === null) invalid('SKILL.md frontmatter contains a line that is not "key: value"')
    const key = match[1]!
    if (fields.has(key)) invalid(`SKILL.md frontmatter repeats the field "${key}"`)
    fields.set(key, unquote(match[2]!))
  }
  if (!closed) invalid('SKILL.md frontmatter is not closed by a "---" line')
  if (lines.slice(bodyStart).join('\n').trim() === '') {
    invalid('SKILL.md has no content after its frontmatter')
  }
  for (const legacy of LEGACY_INVOCATION_KEYS) {
    if (fields.has(legacy)) {
      invalid(`SKILL.md frontmatter field "${legacy}" is unsupported by dsh`)
    }
  }

  const name = fields.get('name') ?? ''
  const description = fields.get('description') ?? ''
  if (name === '' || description === '') {
    invalid('SKILL.md frontmatter requires a non-empty name and description')
  }
  if (!DSH_SKILL_NAME.test(name)) invalid('SKILL.md frontmatter name is not a valid dsh skill name')
  if (name !== expectedName) {
    invalid(
      'SKILL.md frontmatter name must equal the platform skill name; a mismatch would register ' +
        'the skill under a different name than the frozen catalog',
    )
  }

  const disableModelInvocation = fields.get('disable-model-invocation')
  if (disableModelInvocation !== undefined) {
    const normalized = disableModelInvocation.toLowerCase()
    if (!BOOLEANISH.includes(normalized)) {
      invalid('SKILL.md frontmatter field "disable-model-invocation" must be a boolean')
    }
    if (TRUTHY.includes(normalized)) {
      invalid('a bundle with "disable-model-invocation: true" can never be used by this platform')
    }
  }
  const userInvocable = fields.get('user-invocable')
  if (userInvocable !== undefined && !BOOLEANISH.includes(userInvocable.toLowerCase())) {
    invalid('SKILL.md frontmatter field "user-invocable" must be a boolean')
  }

  const whenToUse = fields.get('whenToUse')
  return {
    name,
    description,
    ...(whenToUse !== undefined && whenToUse !== '' ? { whenToUse } : {}),
  }
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

/**
 * 校验归档并生成规范 manifest。
 *
 * `expectedSkillName` 必需：归档根必须直接放 `SKILL.md`，技能名由平台决定（它是
 * `<DSH_HOME>/skills/<name>/` 的目录名）。归档自带一层同名外层目录会让 DSH 找不到入口，
 * 这里由"根没有 SKILL.md"一条拒掉。
 */
export async function validateSkillArchive(
  archive: Uint8Array,
  expectedSkillName: string,
): Promise<ValidatedBundle> {
  const startedAt = Date.now()
  const deadline = () => {
    if (Date.now() - startedAt > LIMITS.validateMs) {
      overLimit(`archive validation exceeded ${LIMITS.validateMs}ms`)
    }
  }

  if (archive.length === 0) invalid('the archive is empty')
  if (archive.length > LIMITS.archiveBytes) {
    overLimit(`the archive is larger than ${LIMITS.archiveBytes} bytes`)
  }

  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength)
  const central = readCentralDirectory(view, archive)
  if (central.length === 0) invalid('the archive contains no entries')

  const seenExact = new Set<string>()
  const seenFolded = new Set<string>()
  const files: SkillBundleFile[] = []
  let expanded = 0
  let compressedTotal = 0
  let containsScripts = false
  let entryBytes = -1
  let entryText = ''

  for (const entry of central) {
    deadline()
    if ((entry.flags & 0x1) !== 0) invalid('encrypted archives are not accepted')
    if (entry.method !== 0 && entry.method !== 8) {
      invalid('only stored and deflated entries are accepted')
    }
    const canonical = canonicalizeEntryPath(entry.rawName)
    // 文件类型位：symlink / 设备 / FIFO / socket 一律拒绝。没有 mode 位（Windows 打的包）
    // 按普通文件处理 —— 那种归档表达不了 symlink，所以不构成风险。
    if (entry.unixMode !== 0 && (entry.unixMode & S_IFMT) !== 0) {
      const fileType = entry.unixMode & S_IFMT
      if (canonical.isDirectory) {
        if (fileType !== S_IFDIR) invalid('a directory entry declares a non-directory file type')
      } else if (fileType !== S_IFREG) {
        invalid('the archive contains a symlink, device, FIFO or socket entry')
      }
    }
    if (canonical.isDirectory) continue

    if (seenExact.has(canonical.path)) invalid('archive contains a duplicate entry path')
    seenExact.add(canonical.path)
    const folded = canonical.path.toLowerCase()
    if (seenFolded.has(folded)) {
      invalid('archive contains paths that collide when case is normalized')
    }
    seenFolded.add(folded)

    if (entry.uncompressedSize > LIMITS.fileBytes) {
      overLimit(`entry exceeds the ${LIMITS.fileBytes} byte per-file limit`)
    }
    expanded += entry.uncompressedSize
    if (expanded > LIMITS.expandedBytes) {
      overLimit(`the expanded archive exceeds ${LIMITS.expandedBytes} bytes`)
    }
    compressedTotal += entry.compressedSize

    const bytes = await readEntryBytes(view, archive, entry)
    if (bytes.length !== entry.uncompressedSize) {
      invalid('entry size does not match the central directory')
    }
    if (crc32(bytes) !== (entry.crc >>> 0)) {
      invalid('entry CRC32 does not match the archive header')
    }

    const role = roleForPath(canonical.path)
    const extension = extensionOf(canonical.path)
    if (extension === '' || !ROLE_EXTENSIONS[role].includes(extension)) {
      invalid(`file type is not allowed for its role (${role}): ${canonical.path}`)
    }
    const mediaType = MEDIA_TYPES[extension]
    if (mediaType === undefined) invalid(`unknown media type: ${canonical.path}`)
    if (role === 'ASSET') {
      const magic = IMAGE_MAGIC.find((candidate) => candidate.test(bytes))
      if (magic === undefined || magic.mediaType !== mediaType) {
        invalid(`asset content does not match its declared image type: ${canonical.path}`)
      }
    } else {
      assertStrictUtf8(bytes, canonical.path)
    }
    if (role === 'SCRIPT') containsScripts = true
    if (canonical.path === SKILL_ENTRY_FILE) {
      entryBytes = bytes.length
      entryText = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    }

    files.push({
      path: canonical.path,
      sha256: await sha256Prefixed(bytes),
      sizeBytes: bytes.length,
      mediaType,
      role,
    })
  }

  if (files.length === 0) invalid('the archive contains no files')
  if (files.length > LIMITS.entryCount) {
    overLimit(`the archive contains more than ${LIMITS.entryCount} files`)
  }
  if (entryBytes < 0) {
    invalid(`the archive root must contain ${SKILL_ENTRY_FILE}; an extra outer directory is not accepted`)
  }
  if (entryBytes === 0) invalid(`${SKILL_ENTRY_FILE} is empty`)
  if (entryBytes > LIMITS.entryFileBytes) {
    overLimit(`${SKILL_ENTRY_FILE} exceeds the ${LIMITS.entryFileBytes} byte limit`)
  }
  if (compressedTotal > 0 && expanded / compressedTotal > LIMITS.compressionRatio) {
    overLimit(`the archive compression ratio exceeds ${LIMITS.compressionRatio}:1`)
  }
  // frontmatter 在容量与类型都过关之后校验：先便宜的检查，再解析文本。
  const frontmatter = parseSkillEntryFrontmatter(entryText, expectedSkillName)
  deadline()

  const sorted = [...files].sort((a, b) => byCodeUnit(a.path, b.path))
  const manifest: SkillBundleManifest = {
    schemaVersion: 1,
    skillName: expectedSkillName,
    entry: SKILL_ENTRY_FILE,
    archiveSha256: await sha256Prefixed(archive),
    archiveSizeBytes: archive.length,
    expandedSizeBytes: expanded,
    containsScripts,
    files: sorted,
  }

  return {
    manifest,
    bundleHash: await computeBundleHash(manifest),
    archiveSha256: manifest.archiveSha256,
    archiveSizeBytes: manifest.archiveSizeBytes,
    expandedSizeBytes: expanded,
    fileCount: sorted.length,
    containsScripts,
    tree: sorted,
    frontmatter,
  }
}

/**
 * 只取指定路径的文本正文（V1.19，diff 视图用）。
 *
 * 与 `validateSkillArchive` 的分工是刻意的：那个函数回答"这份归档能不能发布"，所以它必须
 * 走完全部校验；这个函数回答"这两份归档的某个文件正文差在哪"，输入的两侧**都已经是被
 * 服务端校验过的归档**（一侧是已发布版本，一侧是 VALIDATED 的 staging upload）。
 *
 * 即便如此仍然保留三道闸门，因为"已经校验过"是一个关于过去的判断，而字节是现在读的：
 * 路径规范化、严格 UTF-8、以及只读白名单请求的那几个路径。绝不遍历整档解码 —— 一个
 * 带 200 个文件的包不该因为要看一行 diff 就被全解一遍。
 */
export async function readArchiveTextEntries(
  archive: Uint8Array,
  wantedPaths: readonly string[],
): Promise<Map<string, string>> {
  if (archive.length === 0) invalid('the archive is empty')
  if (archive.length > LIMITS.archiveBytes) {
    overLimit(`the archive is larger than ${LIMITS.archiveBytes} bytes`)
  }
  const wanted = new Set(wantedPaths)
  if (wanted.size === 0) return new Map()

  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength)
  const central = readCentralDirectory(view, archive)
  const texts = new Map<string, string>()

  for (const entry of central) {
    if ((entry.flags & 0x1) !== 0) invalid('encrypted archives are not accepted')
    if (entry.method !== 0 && entry.method !== 8) {
      invalid('only stored and deflated entries are accepted')
    }
    const canonical = canonicalizeEntryPath(entry.rawName)
    if (canonical.isDirectory) continue
    if (!wanted.has(canonical.path)) continue
    if (entry.uncompressedSize > LIMITS.fileBytes) {
      overLimit(`entry exceeds the ${LIMITS.fileBytes} byte per-file limit`)
    }
    const bytes = await readEntryBytes(view, archive, entry)
    if (crc32(bytes) !== (entry.crc >>> 0)) {
      invalid('entry CRC32 does not match the archive header')
    }
    const role = roleForPath(canonical.path)
    if (role === 'ASSET') {
      // 图片没有"逐行 diff"这回事，请求它只能是调用方传错了路径。
      invalid(`refusing to render a binary asset as text: ${canonical.path}`)
    }
    assertStrictUtf8(bytes, canonical.path)
    texts.set(canonical.path, new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  }

  return texts
}
