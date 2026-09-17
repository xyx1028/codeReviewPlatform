/**
 * Skill Bundle 内部路径的准入规则（方案 §7.2）。
 *
 * 一条硬约束贯穿整个模块：**禁止"先解压、后检查"**。所有判定都在还只有 entry 名字、
 * 一个字节都没落盘的时候完成。原因很直白 —— `../../etc/cron.d/x` 一旦落盘，再删掉它
 * 也已经晚了。
 *
 * 字符集刻意收得很窄（ASCII 字母数字 + `.` `_` `-`）。这不是洁癖：
 *
 *   * 它让 Unicode 归一化冲突（NFC/NFD）在结构上不可能发生；
 *   * 它让"大小写归一后冲突"只需要一次 `toLowerCase()` 就能穷尽；
 *   * 它让 SQL 的 `collate "C"` 排序与 JS 的码元序等价，于是 bundle hash 两侧可复现。
 */

export interface PathRejection {
  path: string
  reason: string
}

export interface PathRuleLimits {
  /** 规范相对路径的最大字节数。 */
  pathBytes: number
  /** 目录层数上限（`a/b/c.md` 深度为 3）。 */
  pathDepth: number
}

const SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/**
 * 归一化并校验一个 ZIP entry 名。
 *
 * 返回 `null` 表示"这是一个目录 entry"，调用方应当跳过它（目录由文件路径隐含创建，
 * 不需要单独记录）。抛错表示这个归档不可接受。
 */
export function canonicalizeEntryPath(
  rawName: string,
  limits: PathRuleLimits,
): { path: string; isDirectory: boolean } {
  if (rawName.includes('\0')) {
    throw new Error('entry path contains a NUL byte')
  }
  // 反斜杠一律拒绝，而不是"统一成 /"。把 `a\b` 当成一层还是两层是解压器的自由，
  // 于是同一个归档在不同实现下可以指向不同位置 —— 那正是路径歧义攻击的入口。
  if (rawName.includes('\\')) {
    throw new Error('entry path contains a backslash; path separators must be "/" only')
  }
  if (rawName.normalize('NFC') !== rawName) {
    throw new Error('entry path is not Unicode NFC normalized')
  }
  if (rawName.startsWith('/')) {
    throw new Error('entry path is absolute')
  }
  if (/^[A-Za-z]:/.test(rawName)) {
    throw new Error('entry path carries a Windows drive letter')
  }
  if (rawName.startsWith('//')) {
    throw new Error('entry path looks like a UNC path')
  }

  const isDirectory = rawName.endsWith('/')
  const trimmed = isDirectory ? rawName.slice(0, -1) : rawName
  if (trimmed === '') {
    throw new Error('entry path is empty')
  }

  const segments = trimmed.split('/')
  if (segments.length > limits.pathDepth) {
    throw new Error(`entry path is deeper than ${limits.pathDepth} levels`)
  }
  for (const segment of segments) {
    if (segment === '') {
      throw new Error('entry path contains an empty segment')
    }
    if (segment === '.' || segment === '..') {
      throw new Error('entry path contains a relative segment')
    }
    if (!SEGMENT_PATTERN.test(segment)) {
      throw new Error('entry path contains characters outside the allowed set')
    }
  }

  const path = segments.join('/')
  if (Buffer.byteLength(path, 'utf8') > limits.pathBytes) {
    throw new Error(`entry path is longer than ${limits.pathBytes} bytes`)
  }
  return { path, isDirectory }
}

/**
 * 冲突检测：完全重复、以及大小写归一后重复。
 *
 * 大小写那一条是给大小写不敏感的文件系统（macOS 默认、Windows）准备的：`SKILL.md` 与
 * `skill.md` 在 Linux 容器里是两份文件，物化到开发者的 Mac 上就变成一份，于是
 * "bundle hash 一致但磁盘内容不一致"。宁可在发布时拒收。
 */
export function assertNoPathConflicts(paths: readonly string[]): void {
  const exact = new Set<string>()
  const folded = new Map<string, string>()
  for (const path of paths) {
    if (exact.has(path)) {
      throw new Error('archive contains a duplicate entry path')
    }
    exact.add(path)
    const key = path.toLowerCase()
    const previous = folded.get(key)
    if (previous !== undefined) {
      throw new Error('archive contains paths that collide when case is normalized')
    }
    folded.set(key, path)
  }
}

/**
 * 最终 containment 检查。
 *
 * 前面的字符级规则已经排除了 `..` 与绝对路径，这一步是**独立的第二道**：它用真实的
 * 路径解析器回答"拼出来的目标还在 root 里吗"。两道都做的理由是它们的失效方式不同 ——
 * 字符规则可能漏掉某种表示形式，而路径解析器不会。
 */
export function assertContained(root: string, relativePath: string): string {
  const normalizedRoot = root.endsWith('/') ? root.slice(0, -1) : root
  const target = `${normalizedRoot}/${relativePath}`
  // 只做字符串层面的解析：不 stat、不 realpath。cache 与物化目录里都不允许存在
  // symlink（解析阶段就拒了），所以字符串解析已经是完整答案，而 realpath 会引入
  // 一次可被 TOCTOU 利用的往返。
  const parts: string[] = []
  for (const segment of target.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      parts.pop()
      continue
    }
    parts.push(segment)
  }
  const resolved = `/${parts.join('/')}`
  const rootParts: string[] = []
  for (const segment of normalizedRoot.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      rootParts.pop()
      continue
    }
    rootParts.push(segment)
  }
  const resolvedRoot = `/${rootParts.join('/')}`
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}/`)) {
    throw new Error('resolved target escapes the skill bundle root')
  }
  return resolved
}
