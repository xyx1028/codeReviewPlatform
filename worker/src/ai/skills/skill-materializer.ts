/**
 * 把 cache 里的只读 Bundle 复制到**本次 attempt 私有**的 `DSH_HOME/skills/<name>/`。
 *
 * 位置的选择不是风格问题（方案 §11.1）：
 *
 *   * `Workspace/.dsh/skills` —— Agent 可写且优先级更高，等于让模型自己改自己的技能；
 *   * `Workspace/repos` —— 污染"固定 commit"的语义，评审证据会指向不属于该 commit 的文件；
 *   * `Workspace/artifacts` —— 会被 artifact 扫描当成 Agent 产物入库；
 *   * `SessionRoot` —— 那是会话日志的持久卷，技能包不是会话日志，而且它的保留期完全不同。
 *
 * 所以技能包属于 **dsh 运行配置**，生命周期跟随 per-attempt DSH_HOME：正常收敛随 Profile
 * 一起删，崩溃残留由 attempt orphan cleaner 回收。
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { SKILL_ERROR_CODES, SkillGovernanceError } from './skill-errors.js'
import { assertContained } from './skill-paths.js'
import { sha256Prefixed, SKILL_ENTRY_FILE } from './skill-manifest.js'
import type { ProvisionedSkill } from './skill-provisioner.js'

export const SKILLS_DIR_NAME = 'skills'

export interface MaterializedSkillTree {
  /** `<dshHome>/skills` 的绝对路径。空目录时同样存在，只是没有子目录。 */
  skillsDir: string
  /** 每个技能的绝对目录，供审计与日志使用。 */
  skills: Array<{ name: string; dir: string; bundleHash: string; containsScripts: boolean }>
  fileCount: number
  bytes: number
}

/**
 * 复制一棵技能树。
 *
 * 复制而不是 hardlink / symlink，这一点是硬约束：
 *
 *   * **hardlink** 让 attempt 与共享 cache 指向同一个 inode。attempt 里任何一次写入
 *     （即使是被沙箱允许的意外写）都会改掉所有其他 attempt 看到的内容。cache 是"不可变
 *     的共享事实"，一个能被单个 attempt 改掉的共享事实不是事实。
 *   * **symlink** 让 DSH 的路径解析穿出 per-attempt 树。`watchFollowSymlinks: false` 只管
 *     监听，不管读取。
 *
 * 代价是磁盘与 IO：每个 attempt 复制一份，上限 256 MiB。这个代价换来的是"attempt 之间
 * 完全不共享可写状态"，值得。
 */
export function materializeSkillTree(input: {
  dshHome: string
  bundles: readonly ProvisionedSkill[]
}): MaterializedSkillTree {
  const skillsDir = join(input.dshHome, SKILLS_DIR_NAME)
  mkdirSync(skillsDir, { recursive: true, mode: 0o700 })

  const skills: MaterializedSkillTree['skills'] = []
  let fileCount = 0
  let bytes = 0

  for (const provisioned of input.bundles) {
    const skillDir = join(skillsDir, provisioned.bundle.name)
    // 技能名已经在 provisioner 里被限制成 kebab-case，这一步是独立的第二道 containment。
    assertContained(skillsDir, provisioned.bundle.name)
    mkdirSync(skillDir, { recursive: true, mode: 0o700 })

    for (const file of provisioned.cache.manifest.files) {
      const source = assertContained(provisioned.cache.filesDir, file.path)
      const target = assertContained(skillDir, file.path)
      copyRegularFile(source, target, file.sizeBytes)
      fileCount += 1
      bytes += file.sizeBytes
    }

    // 入口必须存在且内容正确：模型第一次 `skill(name)` 读的就是它。缺了它这个技能对 DSH
    // 等于不存在，而"技能静默消失"是最难诊断的失败形态。
    const entry = join(skillDir, SKILL_ENTRY_FILE)
    if (!existsSync(entry)) {
      throw new SkillGovernanceError(
        SKILL_ERROR_CODES.SKILL_CACHE_CORRUPT,
        `materialized skill ${provisioned.bundle.name} has no ${SKILL_ENTRY_FILE}`,
      )
    }
    const expectedEntry = provisioned.cache.manifest.files.find(
      (file) => file.path === SKILL_ENTRY_FILE,
    )
    if (expectedEntry === undefined || sha256Prefixed(readFileSync(entry)) !== expectedEntry.sha256) {
      throw new SkillGovernanceError(
        SKILL_ERROR_CODES.SKILL_CACHE_CORRUPT,
        `materialized ${SKILL_ENTRY_FILE} does not match the frozen manifest`,
      )
    }

    lockTree(skillDir)
    skills.push({
      name: provisioned.bundle.name,
      dir: skillDir,
      bundleHash: provisioned.bundle.bundleHash,
      containsScripts: provisioned.bundle.containsScripts,
    })
  }

  // skills 根保持 0700：dsh 需要遍历它，而它的父目录（attemptRoot）已经是 0700 私有树。
  return { skillsDir, skills, fileCount, bytes }
}

/**
 * 复制一个普通文件。
 *
 * 用 `lstat` 而不是 `stat`：`stat` 会跟随 symlink，于是"源是 symlink"这件事被隐藏起来。
 * cache 里不该有 symlink（解析阶段就拒了），所以出现即视为 cache 损坏而不是"跟随一下"。
 *
 * 不用 `cpSync`：它的 `dereference` 默认值随 Node 版本演化过，而这条路径的安全性不该
 * 依赖一个默认值。
 */
function copyRegularFile(source: string, target: string, expectedSize: number): void {
  const stats = statSync(source, { throwIfNoEntry: true, bigint: false })
  if (!stats.isFile()) {
    throw new SkillGovernanceError(
      SKILL_ERROR_CODES.SKILL_CACHE_CORRUPT,
      'cached skill path is not a regular file',
    )
  }
  if (stats.size !== expectedSize) {
    throw new SkillGovernanceError(
      SKILL_ERROR_CODES.SKILL_CACHE_CORRUPT,
      'cached skill file size does not match the manifest',
    )
  }
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
  // 显式 0o400：**不继承** ZIP 的 executable bit。方案 §7.4 的"物化后统一只读"就是这一行。
  // 注意这不代表脚本不能被执行 —— `bash scripts/x.sh` 不需要 +x。执行的闸门是角色权限、
  // Sandbox 与容器资源限制，不是 mode 位。把 mode 位当成执行闸门是危险的误解。
  writeFileSync(target, readFileSync(source), { mode: 0o400 })
}

/** 把一棵已经写完的技能树设成只读（目录不可增删条目）。 */
function lockTree(root: string): void {
  const stack = [root]
  const dirs: string[] = []
  while (stack.length > 0) {
    const current = stack.pop()!
    dirs.push(current)
    for (const name of readdirSync(current)) {
      const path = join(current, name)
      const stats = statSync(path)
      if (stats.isDirectory()) stack.push(path)
      else chmodSync(path, 0o400)
    }
  }
  // 由深到浅设置：先把子目录设成不可写，再设父目录，否则设完父目录就进不去子目录了。
  for (const dir of dirs.reverse()) {
    chmodSync(dir, 0o500)
  }
}

/**
 * 让一棵只读技能树可以被 `rm -r` 删掉。
 *
 * 物化后目录是 0500：删除目录里的条目需要**目录**的写权限，所以不先放宽权限的
 * `rmSync(attemptRoot, { recursive: true })` 会在技能目录上失败。而 attempt 的 cleanup
 * 静默失败的表现是磁盘慢慢满 —— 那是几周后才会被发现的故障。
 */
export function relaxSkillTree(dshHome: string): void {
  const skillsDir = join(dshHome, SKILLS_DIR_NAME)
  if (!existsSync(skillsDir)) return
  const stack = [skillsDir]
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
