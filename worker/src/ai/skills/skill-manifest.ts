/**
 * Skill Bundle 的规范 manifest、三层 hash 与文件分类规则。
 *
 * 这个模块是"平台与 Worker 对同一个 Bundle 算出同一个身份"的唯一定义处。它必须与
 * `supabase/migrations/*_managed_dsh_skill_bundles.sql` 里的
 * `skill_bundle_hash_input` / `skill_catalog_hash` 逐字节一致。
 *
 * 为什么规范格式是**行式文本**而不是 JSON：
 *
 *   * Postgres 的 `jsonb::text` 渲染成 `{"a": 1}`（键按长度排序、冒号后带空格），
 *     JS 的 `JSON.stringify` 渲染成 `{"a":1}`。两侧各自序列化必然对不上。
 *   * 行式格式的每一个字节都是我们显式写出来的，没有任何"实现自己决定"的空间。
 *
 * 排序一律按 **UTF-16 码元序**（JS 的 `<`），SQL 侧对应 `collate "C"`。路径字符集被
 * 限制在 ASCII 安全子集内（见 `skill-paths.ts`），所以两者等价。
 */

import { createHash } from 'node:crypto'

export type SkillFileRole = 'ENTRY' | 'REFERENCE' | 'ASSET' | 'TEMPLATE' | 'SCRIPT' | 'OTHER'

export interface SkillBundleFile {
  /** 规范相对路径，`/` 分隔，无前导 `/`。 */
  path: string
  /** `sha256:<64 hex>`。 */
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

/** Job 冻结的单个不可变技能版本。Worker 只接受它，不接受任何自报 locator。 */
export interface FrozenSkillBundle {
  snapshotId: string
  name: string
  description: string
  whenToUse?: string
  version: number
  archiveBucket: 'skill-bundles'
  archiveObjectKey: string
  archiveSha256: string
  archiveSizeBytes: number
  bundleHash: string
  bundleManifest: SkillBundleManifest
  expandedSizeBytes: number
  containsScripts: boolean
}

export interface FrozenSkillCatalog {
  snapshotVersion: number
  catalogHash: string
  bundles: FrozenSkillBundle[]
  /**
   * Job 冻结时生效的目录四项容量上限（V1.8）。
   *
   * `undefined` = 历史快照（升级前建的 Job，快照里没有这个字段）。此时 Worker 回退到
   * 编译默认 `SKILL_CATALOG_LIMITS` —— 而出厂默认恰等于历史常量，所以历史 Job 行为不变。
   */
  catalogLimits?: FrozenCatalogLimits
}

/** 只含四项容量上限；`descriptionChars` 未随 Job 冻结，仍取编译默认。 */
export interface FrozenCatalogLimits {
  catalogBundles: number
  catalogRenderBytes: number
  catalogArchiveBytes: number
  catalogExpandedBytes: number
}

export const SKILL_ENTRY_FILE = 'SKILL.md'

/**
 * DSH 唯一自动发现的入口。放在常量里而不是散落字面量：物化目录、manifest 校验和
 * `skill-filesystem` 的期望必须说同一件事。
 */
export function isEntryPath(path: string): boolean {
  return path === SKILL_ENTRY_FILE
}

const MEDIA_TYPES: Readonly<Record<string, string>> = {
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

/**
 * 每个角色允许的扩展名。
 *
 * `OTHER`（不在四个约定目录下的普通文件）只允许文本类：一个躺在根目录的 `.sh`
 * 会被归到 OTHER，于是被这张表拒绝。这正是想要的效果 —— 脚本必须显式放进
 * `scripts/`，从而必然带上 `contains_scripts=true` 标记和发布页的额外确认。
 *
 * SVG、HTML、Office、可执行二进制、动态库、未知格式全部落在"不在表里"，默认拒绝。
 */
const TEXTUAL_EXTENSIONS = ['md', 'txt', 'json', 'yaml', 'yml', 'csv', 'xml'] as const
export const SKILL_ROLE_EXTENSIONS: Readonly<Record<SkillFileRole, readonly string[]>> = {
  ENTRY: ['md'],
  REFERENCE: TEXTUAL_EXTENSIONS,
  TEMPLATE: TEXTUAL_EXTENSIONS,
  OTHER: TEXTUAL_EXTENSIONS,
  ASSET: ['png', 'jpg', 'jpeg', 'webp', 'gif'],
  SCRIPT: ['sh', 'js', 'mjs', 'cjs'],
}

/** 需要严格 UTF-8 校验的角色。图片不做，其余全做。 */
export function requiresUtf8(role: SkillFileRole): boolean {
  return role !== 'ASSET'
}

export function fileExtension(path: string): string {
  const dot = path.lastIndexOf('.')
  const slash = path.lastIndexOf('/')
  if (dot <= slash + 1) return ''
  return path.slice(dot + 1).toLowerCase()
}

/**
 * 角色只由规范路径决定，绝不由上传方声明。
 *
 * 四个约定目录是**平台的分类约定**，DSH 不赋予它们任何特殊能力（它只自动发现
 * `SKILL.md`）。这里把约定变成可机械判定的规则，于是"这个版本含脚本吗"有唯一答案。
 */
export function roleForPath(path: string): SkillFileRole {
  if (isEntryPath(path)) return 'ENTRY'
  if (path.startsWith('references/')) return 'REFERENCE'
  if (path.startsWith('assets/')) return 'ASSET'
  if (path.startsWith('templates/')) return 'TEMPLATE'
  if (path.startsWith('scripts/')) return 'SCRIPT'
  return 'OTHER'
}

export function mediaTypeForPath(path: string): string | null {
  const extension = fileExtension(path)
  if (extension === '') return null
  return MEDIA_TYPES[extension] ?? null
}

/** 扩展名是否被该角色允许。扩展名只用于产品允许列表，安全判断另有 magic/UTF-8 检查。 */
export function isExtensionAllowedForRole(path: string, role: SkillFileRole): boolean {
  const extension = fileExtension(path)
  if (extension === '') return false
  return SKILL_ROLE_EXTENSIONS[role].includes(extension)
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export function sha256Prefixed(bytes: Uint8Array): string {
  return `sha256:${sha256Hex(bytes)}`
}

/** 排序键：UTF-16 码元序，与 SQL 的 `collate "C"` 对齐（路径已限制为 ASCII）。 */
function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

export function sortBundleFiles(files: readonly SkillBundleFile[]): SkillBundleFile[] {
  return [...files].sort((a, b) => byCodeUnit(a.path, b.path))
}

/**
 * bundle hash 的规范输入。
 *
 * 只包含内容身份：schema 版本、技能名、入口，以及按路径排序的
 * `(path, sha256, sizeBytes, mediaType, role)`。刻意不含 ZIP entry 顺序、mtime、
 * Unix mode 和压缩参数 —— 同一份逻辑文件集合用不同压缩级别打两次包，bundle hash 必须
 * 相同，否则 Worker 的共享 cache 会被打包器的随机性打成永远 miss。
 */
export function bundleHashInput(manifest: SkillBundleManifest): string {
  const lines = [
    'skill-bundle-v1',
    `schemaVersion=${manifest.schemaVersion}`,
    `skillName=${manifest.skillName}`,
    `entry=${manifest.entry}`,
  ]
  let text = `${lines.join('\n')}\n`
  for (const file of sortBundleFiles(manifest.files)) {
    text += `${file.path}\t${file.sha256}\t${file.sizeBytes}\t${file.mediaType}\t${file.role}\n`
  }
  return text
}

export function computeBundleHash(manifest: SkillBundleManifest): string {
  return `sha256:${createHash('sha256').update(bundleHashInput(manifest), 'utf8').digest('hex')}`
}

export interface SkillCatalogHashEntry {
  name: string
  version: number
  bundleHash: string
  archiveSha256: string
}

/**
 * 全技能目录的 hash。
 *
 * 输入集合先按 name 排序再拼接：同一集合无论以什么顺序枚举都必须得到同一个值，否则
 * "所有 Story Task 共用同一个 catalog hash"这条根本无法验证。
 */
export function computeCatalogHash(entries: readonly SkillCatalogHashEntry[]): string {
  const sorted = [...entries].sort((a, b) => byCodeUnit(a.name, b.name))
  let text = 'skill-catalog-v1\n'
  for (const entry of sorted) {
    text += `${entry.name}\t${entry.version}\t${entry.bundleHash}\t${entry.archiveSha256}\n`
  }
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** 空目录的 hash。历史 Job 与"当前没有已发布技能"共用这一个值。 */
export function emptyCatalogHash(): string {
  return computeCatalogHash([])
}

/** 从冻结 snapshot 重算 catalog hash（Worker 侧的独立复算）。 */
export function catalogHashFromBundles(bundles: readonly FrozenSkillBundle[]): string {
  return computeCatalogHash(
    bundles.map((bundle) => ({
      name: bundle.name,
      version: bundle.version,
      bundleHash: bundle.bundleHash,
      archiveSha256: bundle.archiveSha256,
    })),
  )
}

/**
 * 规范化 manifest 的字段顺序与取值，供落盘（cache 的 `manifest.json`）使用。
 *
 * 落盘形态必须稳定：cache 命中时要用它重算 bundle hash，如果落盘顺序会变，重算结果
 * 就会随机失败，而失败的表现是"缓存永远损坏"。
 */
export function canonicalManifest(manifest: SkillBundleManifest): SkillBundleManifest {
  return {
    schemaVersion: 1,
    skillName: manifest.skillName,
    entry: SKILL_ENTRY_FILE,
    archiveSha256: manifest.archiveSha256,
    archiveSizeBytes: manifest.archiveSizeBytes,
    expandedSizeBytes: manifest.expandedSizeBytes,
    containsScripts: manifest.containsScripts,
    files: sortBundleFiles(manifest.files).map((file) => ({
      path: file.path,
      sha256: file.sha256,
      sizeBytes: file.sizeBytes,
      mediaType: file.mediaType,
      role: file.role,
    })),
  }
}

/** cache 目录名：bundle hash 的裸 hex。`sha256:` 前缀里的冒号不适合做目录名。 */
export function bundleHashDirName(bundleHash: string): string {
  const match = /^sha256:([0-9a-f]{64})$/.exec(bundleHash)
  if (match === null) {
    throw new Error('bundle hash must be sha256:<64 hex>')
  }
  return match[1]!
}
