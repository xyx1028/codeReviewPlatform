/**
 * 从归档字节推导规范 manifest。
 *
 * 这是"平台生成 manifest"的实现：管理员不手写可信 manifest，Worker 也不采信数据库里
 * 那一份。两侧都跑这段代码，各自算出 manifest 与 bundle hash，再互相比对 —— 只有这样
 * "三层 hash"才是三次**独立**的判断，而不是同一个声明被抄了三遍。
 */

import {
  canonicalManifest,
  computeBundleHash,
  isEntryPath,
  isExtensionAllowedForRole,
  mediaTypeForPath,
  requiresUtf8,
  roleForPath,
  sha256Prefixed,
  SKILL_ENTRY_FILE,
  type SkillBundleFile,
  type SkillBundleManifest,
} from './skill-manifest.js'
import { SKILL_BUNDLE_LIMITS, type SkillBundleLimits } from './skill-limits.js'
import { readSkillArchive, ZipRejectedError } from './zip-archive.js'
import {
  parseSkillEntryFrontmatter,
  SkillFrontmatterError,
  type SkillEntryFrontmatter,
} from './skill-frontmatter.js'

export interface ValidatedSkillBundle {
  manifest: SkillBundleManifest
  bundleHash: string
  archiveSha256: string
  archiveSizeBytes: number
  expandedSizeBytes: number
  fileCount: number
  containsScripts: boolean
  files: Array<{ path: string; bytes: Buffer }>
  /**
   * 入口文件的 frontmatter。
   *
   * 它是 name / description / whenToUse 的**唯一可信来源**：dsh 读的就是这里，所以
   * 数据库里的那份只能是它的投影，不能是管理员另外敲的一段文字。两处各说一套的后果是
   * 目录页显示 A、模型看到 B。
   */
  frontmatter: SkillEntryFrontmatter
}

/** 图片 magic。扩展名只是产品允许列表，真实类型必须由字节说话。 */
const IMAGE_MAGIC: Array<{ mediaType: string; test: (bytes: Buffer) => boolean }> = [
  {
    mediaType: 'image/png',
    test: (b) => b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  {
    mediaType: 'image/jpeg',
    test: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    mediaType: 'image/webp',
    test: (b) =>
      b.length >= 12 &&
      b.subarray(0, 4).toString('latin1') === 'RIFF' &&
      b.subarray(8, 12).toString('latin1') === 'WEBP',
  },
  {
    mediaType: 'image/gif',
    test: (b) => b.length >= 6 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString('latin1')),
  },
]

/**
 * 严格 UTF-8 校验。
 *
 * `Buffer#toString('utf8')` 会把非法序列替换成 U+FFFD 而不是报错，所以必须用
 * `TextDecoder({ fatal: true })`。另外显式拒绝 NUL：一个内嵌 NUL 的"文本"文件在
 * 任何下游消费者（`read`、`grep`、shell）里都是意外，而且是典型的截断攻击载荷。
 */
function assertStrictUtf8(bytes: Buffer, path: string): void {
  if (bytes.includes(0)) {
    throw new SkillBundleInvalidError(`text resource contains a NUL byte: ${path}`)
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new SkillBundleInvalidError(`text resource is not valid UTF-8: ${path}`)
  }
}

export class SkillBundleInvalidError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SkillBundleInvalidError'
  }
}

export class SkillBundleLimitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SkillBundleLimitError'
  }
}

/**
 * 校验归档并生成规范 manifest。
 *
 * `expectedSkillName` 是必需的：归档根**必须**直接放 `SKILL.md`，而技能名来自平台
 * （目录名由 `<DSH_HOME>/skills/<name>/` 决定）。归档自带一层同名外层目录会让 DSH
 * 找不到入口 —— 这是 §6.2 明确不接受的形态，在这里被 "根没有 SKILL.md" 一条拒掉。
 */
export function validateSkillArchive(input: {
  archive: Buffer
  expectedSkillName: string
  limits?: SkillBundleLimits
}): ValidatedSkillBundle {
  const limits = input.limits ?? SKILL_BUNDLE_LIMITS
  let read
  try {
    read = readSkillArchive(input.archive, limits)
  } catch (err) {
    if (err instanceof ZipRejectedError) {
      throw err.kind === 'LIMIT'
        ? new SkillBundleLimitError(err.message)
        : new SkillBundleInvalidError(err.message)
    }
    throw err
  }

  const entry = read.files.find((file) => isEntryPath(file.path))
  if (entry === undefined) {
    throw new SkillBundleInvalidError(
      `the archive root must contain ${SKILL_ENTRY_FILE}; an extra outer directory is not accepted`,
    )
  }
  if (entry.bytes.length === 0) {
    throw new SkillBundleInvalidError(`${SKILL_ENTRY_FILE} is empty`)
  }
  if (entry.bytes.length > limits.entryFileBytes) {
    throw new SkillBundleLimitError(
      `${SKILL_ENTRY_FILE} exceeds the ${limits.entryFileBytes} byte limit`,
    )
  }

  /*
   * frontmatter 必须在**发布时**校验，不能留给运行时。
   *
   * dsh 的 `parseSkillFile` 对缺失或非法 frontmatter 只写一行 `logger.warn` 然后 return ——
   * 于是 Bundle 发布成功、Job 冻结成功、Worker 物化成功、磁盘上文件都在，而模型的首轮
   * 目录里就是没有这个技能，平台侧没有任何错误码。那是最难诊断的一类失败。
   */
  let frontmatter: SkillEntryFrontmatter
  try {
    frontmatter = parseSkillEntryFrontmatter(
      entry.bytes.toString('utf8'),
      input.expectedSkillName,
    )
  } catch (err) {
    if (err instanceof SkillFrontmatterError) throw new SkillBundleInvalidError(err.message)
    throw err
  }

  const files: SkillBundleFile[] = []
  let containsScripts = false
  for (const file of read.files) {
    const role = roleForPath(file.path)
    if (!isExtensionAllowedForRole(file.path, role)) {
      throw new SkillBundleInvalidError(
        `file type is not allowed for its role (${role}): ${file.path}`,
      )
    }
    const mediaType = mediaTypeForPath(file.path)
    if (mediaType === null) {
      throw new SkillBundleInvalidError(`unknown media type: ${file.path}`)
    }
    if (role === 'ASSET') {
      const magic = IMAGE_MAGIC.find((candidate) => candidate.test(file.bytes))
      if (magic === undefined || magic.mediaType !== mediaType) {
        // 扩展名说是图片、字节说不是（或者说的是另一种图片）。两种都拒：一个 `.png`
        // 里装着 HTML 是最经典的类型混淆。
        throw new SkillBundleInvalidError(
          `asset content does not match its declared image type: ${file.path}`,
        )
      }
    } else if (requiresUtf8(role)) {
      assertStrictUtf8(file.bytes, file.path)
    }
    if (role === 'SCRIPT') containsScripts = true

    files.push({
      path: file.path,
      sha256: sha256Prefixed(file.bytes),
      sizeBytes: file.bytes.length,
      mediaType,
      role,
    })
  }

  const manifest = canonicalManifest({
    schemaVersion: 1,
    skillName: input.expectedSkillName,
    entry: SKILL_ENTRY_FILE,
    archiveSha256: sha256Prefixed(input.archive),
    archiveSizeBytes: input.archive.length,
    expandedSizeBytes: read.expandedSizeBytes,
    containsScripts,
    files,
  })

  return {
    manifest,
    bundleHash: computeBundleHash(manifest),
    archiveSha256: manifest.archiveSha256,
    archiveSizeBytes: manifest.archiveSizeBytes,
    expandedSizeBytes: manifest.expandedSizeBytes,
    fileCount: files.length,
    containsScripts,
    files: read.files,
    frontmatter,
  }
}
