/**
 * 共享只读 Skill Cache。
 *
 * 没有它，每个 Story Task 都要把全部技能重新下载一遍：容量上限是 100 MiB 归档、
 * 256 MiB 展开，乘以 4 个 replica × 2 个 slot，一次批次能打出上百 GiB 的无谓流量。
 *
 * 布局（`SKILL_CACHE_ROOT/<bundle-hash-hex>/`）：
 *
 *   bundle.zip     原始字节，保留下来是为了让"重新校验"不需要再下载一次
 *   manifest.json  规范 manifest；它的 bundle hash 必须等于目录名
 *   files/         展开后的完整文件树
 *
 * 并发模型与 Git commit cache 一致：**临时目录 + 原子 rename**。多个 Worker 同时
 * miss 同一个 bundle 时，每个都在自己的临时目录里完整校验并落盘，然后尝试 rename；
 * 只有一个会成功，失败者删掉临时目录并复用胜出者的结果。这里刻意不用文件锁 ——
 * 锁需要持有者活着，而 Worker 可能在任何时刻被 kill，留下一把永远不释放的锁。
 */

import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import {
  bundleHashDirName,
  canonicalManifest,
  computeBundleHash,
  sha256Prefixed,
  SKILL_ENTRY_FILE,
  type SkillBundleManifest,
} from './skill-manifest.js'
import { assertContained } from './skill-paths.js'

export interface SkillCacheEntry {
  bundleHash: string
  /** `<root>/<hash>` */
  root: string
  /** `<root>/<hash>/files` —— 物化时的复制源。 */
  filesDir: string
  manifest: SkillBundleManifest
  /** 本次是否命中缓存。用于 §16 的 `skill_cache_hits/misses`。 */
  hit: boolean
}

export class SkillCacheCorruptError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SkillCacheCorruptError'
  }
}

const MANIFEST_FILE = 'manifest.json'
const ARCHIVE_FILE = 'bundle.zip'
const FILES_DIR = 'files'

function writeReadOnlyFile(path: string, bytes: Buffer | string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, bytes, { mode: 0o400 })
}

/**
 * 复核一个已存在的 cache 目录。
 *
 * 校验的范围是刻意选择的，不是偷懒：
 *
 *   * `manifest.json` 完整解析，且**由它重算出的 bundle hash 必须等于目录名**。
 *     这一条覆盖了"文件集合、大小、类型、角色"的全部身份 —— 任何一处被改过，
 *     重算结果就会变。
 *   * 每个文件必须存在且**字节数精确相等**。
 *   * `SKILL.md` 与全部 `scripts/` 文件**逐字节重算 sha256**。
 *
 * 为什么不重算全部文件的 hash：单个 bundle 上限 50 MiB、目录上限 256 MiB，每个
 * attempt 都全量重算等于每次启动读几百兆磁盘。而"能改内容却保持字节数不变"的攻击面
 * 已经被 manifest hash + 尺寸校验压得很薄；真正需要逐字节确认的是**会被执行的东西**
 * （scripts）和**必然被模型读到的入口**（SKILL.md）。这是一个明说出来的取舍，而不是
 * 一个被默认的假设。
 */
function verifyCacheEntry(root: string, bundleHash: string): SkillBundleManifest {
  const manifestPath = join(root, MANIFEST_FILE)
  if (!existsSync(manifestPath)) {
    throw new SkillCacheCorruptError('cached bundle has no manifest')
  }
  let manifest: SkillBundleManifest
  try {
    manifest = canonicalManifest(JSON.parse(readFileSync(manifestPath, 'utf8')) as SkillBundleManifest)
  } catch {
    throw new SkillCacheCorruptError('cached bundle manifest could not be parsed')
  }
  if (computeBundleHash(manifest) !== bundleHash) {
    throw new SkillCacheCorruptError('cached bundle manifest does not match its bundle hash')
  }

  const filesDir = join(root, FILES_DIR)
  for (const file of manifest.files) {
    const absolute = assertContained(filesDir, file.path)
    let stats
    try {
      stats = statSync(absolute)
    } catch {
      throw new SkillCacheCorruptError('cached bundle is missing a manifest file')
    }
    if (!stats.isFile()) {
      throw new SkillCacheCorruptError('cached bundle path is not a regular file')
    }
    if (stats.size !== file.sizeBytes) {
      throw new SkillCacheCorruptError('cached bundle file size does not match the manifest')
    }
    if (file.path === SKILL_ENTRY_FILE || file.role === 'SCRIPT') {
      if (sha256Prefixed(readFileSync(absolute)) !== file.sha256) {
        throw new SkillCacheCorruptError('cached bundle critical file hash does not match')
      }
    }
  }
  return manifest
}

/** 更新最后访问时间：LRU 回收的依据。失败不致命 —— 回收晚一轮不影响正确性。 */
function touch(root: string): void {
  const now = new Date()
  try {
    utimesSync(root, now, now)
  } catch {
    // 只读目录在某些文件系统上拒绝 utimes。回收会退化成按 mtime，仍然可用。
  }
}

export interface SkillCacheOptions {
  /** `SKILL_CACHE_ROOT`。 */
  cacheRoot: string
}

export class SkillCache {
  constructor(private readonly options: SkillCacheOptions) {}

  /** cache 中是否已有这个 bundle（不做完整复核，只看目录）。 */
  has(bundleHash: string): boolean {
    return existsSync(join(this.options.cacheRoot, bundleHashDirName(bundleHash)))
  }

  /**
   * cache hit 路径：复核并返回。目录不存在或复核失败时返回 null，由调用方走下载路径。
   *
   * 复核失败时**删掉**那个目录再返回 null：留着它只会让下一个 attempt 再失败一次。
   * 删除是安全的 —— cache 的全部内容都可以从对象存储重新下载，它不是权威副本。
   */
  lookup(bundleHash: string): SkillCacheEntry | null {
    const root = join(this.options.cacheRoot, bundleHashDirName(bundleHash))
    if (!existsSync(root)) return null
    try {
      const manifest = verifyCacheEntry(root, bundleHash)
      touch(root)
      return {
        bundleHash,
        root,
        filesDir: join(root, FILES_DIR),
        manifest,
        hit: true,
      }
    } catch (err) {
      if (err instanceof SkillCacheCorruptError) {
        rmSync(root, { recursive: true, force: true })
        return null
      }
      throw err
    }
  }

  /**
   * 原子发布一个校验过的 bundle。
   *
   * 竞争的胜负由文件系统裁定：`renameSync` 到一个已存在的**非空**目录会失败，失败者
   * 清理自己的临时目录并复核胜出者的结果。这条路径也覆盖"同一个 Worker 的两个 slot
   * 同时 miss"，不需要额外的进程内互斥。
   */
  publish(input: {
    bundleHash: string
    manifest: SkillBundleManifest
    archive: Buffer
    files: ReadonlyArray<{ path: string; bytes: Buffer }>
  }): SkillCacheEntry {
    const dirName = bundleHashDirName(input.bundleHash)
    const finalRoot = join(this.options.cacheRoot, dirName)
    mkdirSync(this.options.cacheRoot, { recursive: true, mode: 0o700 })

    const staging = mkdtempSync(join(this.options.cacheRoot, `.staging-${dirName.slice(0, 12)}-`))
    try {
      const filesDir = join(staging, FILES_DIR)
      mkdirSync(filesDir, { recursive: true, mode: 0o700 })
      for (const file of input.files) {
        // 落盘前再做一次 containment：解析阶段已经拒了 `..`，这一步防的是"解析与落盘
        // 之间有人改了路径"这类代码演化事故。
        const absolute = assertContained(filesDir, file.path)
        writeReadOnlyFile(absolute, file.bytes)
      }
      writeReadOnlyFile(
        join(staging, MANIFEST_FILE),
        `${JSON.stringify(canonicalManifest(input.manifest), null, 2)}\n`,
      )
      writeReadOnlyFile(join(staging, ARCHIVE_FILE), input.archive)
      chmodSync(staging, 0o500)

      try {
        renameSync(staging, finalRoot)
      } catch {
        // 竞争失败或目标已存在：复用胜出者。它自己的复核仍然要过。
        //
        // 先放宽权限再删：staging 在 rename 之前已经被设成 0500，而删除一个目录里的
        // 条目需要**目录**的写权限。不放宽的 `rmSync` 会抛 ENOTEMPTY，于是"竞争失败"
        // 这条正常路径变成一次异常 —— 而这条路径在多 Worker 部署下每天都会走到。
        relaxTree(staging)
        rmSync(staging, { recursive: true, force: true, maxRetries: 3 })
        const existing = this.lookup(input.bundleHash)
        if (existing !== null) return existing
        throw new SkillCacheCorruptError(
          'another worker published this bundle but the result failed verification',
        )
      }
    } catch (err) {
      relaxTree(staging)
      rmSync(staging, { recursive: true, force: true })
      throw err
    }

    touch(finalRoot)
    return {
      bundleHash: input.bundleHash,
      root: finalRoot,
      filesDir: join(finalRoot, FILES_DIR),
      manifest: canonicalManifest(input.manifest),
      hit: false,
    }
  }

  /**
   * 容量回收：超过上限时按最后访问时间从旧到新删。
   *
   * 有活动 attempt 或 Job snapshot 引用**不要求**本地 cache 永久保留 —— 那只要求
   * 对象存储必须保留。删掉一个正在被别的 attempt 复制的目录会让那次复制失败，
   * 所以 `keep` 让调用方把本次要用的 hash 排除在外。
   */
  reclaim(input: { maxBytes: number; keep?: ReadonlySet<string> }): { removed: number; bytes: number } {
    if (!existsSync(this.options.cacheRoot)) return { removed: 0, bytes: 0 }
    const keep = input.keep ?? new Set<string>()
    const entries: Array<{ name: string; path: string; bytes: number; atimeMs: number }> = []
    let total = 0
    for (const name of readdirSync(this.options.cacheRoot)) {
      if (name.startsWith('.staging-')) continue
      const path = join(this.options.cacheRoot, name)
      let stats
      try {
        stats = statSync(path)
      } catch {
        continue
      }
      if (!stats.isDirectory()) continue
      const bytes = directorySize(path)
      total += bytes
      entries.push({ name, path, bytes, atimeMs: stats.atimeMs || stats.mtimeMs })
    }
    if (total <= input.maxBytes) return { removed: 0, bytes: 0 }

    entries.sort((a, b) => a.atimeMs - b.atimeMs)
    let removed = 0
    let freed = 0
    for (const entry of entries) {
      if (total - freed <= input.maxBytes) break
      if (keep.has(entry.name)) continue
      relaxTree(entry.path)
      rmSync(entry.path, { recursive: true, force: true })
      removed += 1
      freed += entry.bytes
    }
    return { removed, bytes: freed }
  }
}

function directorySize(root: string): number {
  let total = 0
  const stack = [root]
  while (stack.length > 0) {
    const current = stack.pop()!
    let names: string[]
    try {
      names = readdirSync(current)
    } catch {
      continue
    }
    for (const name of names) {
      const path = join(current, name)
      let stats
      try {
        stats = statSync(path)
      } catch {
        continue
      }
      if (stats.isDirectory()) stack.push(path)
      else total += stats.size
    }
  }
  return total
}

/**
 * 恢复可写权限，让 `rm -r` 能删掉一棵只读树。
 *
 * cache 目录发布后是 0500/0400。删除一个目录里的条目需要**目录**的写权限，所以不先
 * 放宽权限的 `rmSync` 会在只读子目录上失败 —— 而"回收静默失败"的表现是磁盘慢慢满，
 * 一个月后才有人发现。
 */
export function relaxTree(root: string): void {
  if (!existsSync(root)) return
  const stack = [root]
  const dirs: string[] = []
  while (stack.length > 0) {
    const current = stack.pop()!
    dirs.push(current)
    let names: string[]
    try {
      chmodSync(current, 0o700)
      names = readdirSync(current)
    } catch {
      continue
    }
    for (const name of names) {
      const path = join(current, name)
      try {
        const stats = statSync(path)
        if (stats.isDirectory()) stack.push(path)
        else chmodSync(path, 0o600)
      } catch {
        continue
      }
    }
  }
  for (const dir of dirs.reverse()) {
    try {
      chmodSync(dir, 0o700)
    } catch {
      continue
    }
  }
}

/** 供测试与运维检查：cache 目录是否可读。 */
export function assertCacheRootUsable(cacheRoot: string): void {
  mkdirSync(cacheRoot, { recursive: true, mode: 0o700 })
  const probe = join(cacheRoot, '.probe')
  const fd = openSync(probe, 'w', 0o600)
  closeSync(fd)
  rmSync(probe, { force: true })
}
