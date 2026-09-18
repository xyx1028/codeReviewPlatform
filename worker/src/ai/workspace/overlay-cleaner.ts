/**
 * Overlay 与 Session 的过期清理。
 *
 * attempt 正常结束时 `AttemptWorkspace.dispose()` 会删掉自己的树。这个模块负责另一半：
 * 进程被 SIGKILL、容器被强杀、磁盘写满导致 dispose 失败时留下的孤儿目录。
 *
 * 判定标准是"目录名里的 mtime 已经超过保留期"而不是"目录里没有活进程"：后者需要跨进程
 * 探测，在容器重启后不可靠。保留期取 policy 的 session retention，同一个数值同时约束
 * Session JSONL 与 Workspace，运维只需要盯一个配额。
 */

import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Logger } from '../../logger.js'
import { redactError } from '../../security/redaction.js'
import { makeTreeWritable } from './attempt-workspace.js'

export interface OverlayCleanerOptions {
  /** 存放 per-attempt 树的根目录。 */
  attemptsRoot: string
  /** 超过这个时长仍未被回收的目录视为孤儿。 */
  maxAgeMs: number
  logger: Logger
  /** 注入以便单测。 */
  now?: () => number
}

export interface CleanupReport {
  scanned: number
  removed: number
  failed: number
  reclaimedBytes: number
  /** 需要先放宽权限才删掉的目录数。>0 说明这些孤儿是被强杀的 attempt 留下的。 */
  relaxed: number
}

/** attempt 树的目录名前缀。只清理我们自己创建的形态，不碰同目录下的其他东西。 */
const MANAGED_PREFIXES = ['ws-', 'attempt-']

export function cleanOrphanedOverlays(options: OverlayCleanerOptions): CleanupReport {
  const report: CleanupReport = {
    scanned: 0,
    removed: 0,
    failed: 0,
    reclaimedBytes: 0,
    relaxed: 0,
  }
  if (!existsSync(options.attemptsRoot)) return report

  const now = options.now?.() ?? Date.now()
  let entries: string[]
  try {
    entries = readdirSync(options.attemptsRoot)
  } catch (err) {
    options.logger.error('overlay_scan_failed', {
      event: 'overlay_scan_failed',
      error_message: redactError(err),
    })
    return report
  }

  for (const entry of entries) {
    if (!MANAGED_PREFIXES.some((prefix) => entry.startsWith(prefix))) continue
    const path = join(options.attemptsRoot, entry)
    let stat
    try {
      stat = statSync(path)
    } catch {
      continue
    }
    if (!stat.isDirectory()) continue
    report.scanned++
    // mtime 而不是 ctime：一个仍在被写入的 attempt 树 mtime 会持续更新，不会被误删。
    if (now - stat.mtimeMs < options.maxAgeMs) continue

    try {
      rmSync(path, { recursive: true, force: true, maxRetries: 3 })
      report.removed++
    } catch (firstError) {
      /*
       * 第一次删失败，最常见的原因只有一个：这棵树里有**只读**目录。
       *
       *   * 技能目录被 `skill-materializer` 设成 0500/0400（防止 Agent 改自己的技能）；
       *   * 固定 Commit 的只读检出被 `attempt-workspace` 设成 0500/0400（防止污染证据源）。
       *
       * 正常结束的 attempt 会先 `relaxSkillTree` / `makeTreeWritable` 再删，所以没事；
       * 而孤儿目录**恰恰**来自被 SIGKILL 的 attempt —— 那条路径上没人放宽过权限。结果是
       * 清理器每 10 分钟扫一遍、每次都 EACCES、一个都删不掉，磁盘只增不减。
       *
       * 线上实测：22 个孤儿目录、821MB，`removed:0 failed:22` 反复刷。
       *
       * 所以失败之后放宽权限再试一次。只在失败路径上做，正常路径不必为此遍历整棵树。
       */
      let relaxed = false
      try {
        makeTreeWritable(path)
        relaxed = true
      } catch (relaxError) {
        options.logger.info('overlay_relax_failed', {
          event: 'overlay_relax_failed',
          entry,
          error_message: redactError(relaxError),
        })
      }
      let removed = false
      if (relaxed) {
        try {
          rmSync(path, { recursive: true, force: true, maxRetries: 3 })
          removed = true
        } catch {
          removed = false
        }
      }
      if (removed) {
        report.removed++
        report.relaxed++
      } else {
        report.failed++
        options.logger.error('overlay_cleanup_failed', {
          event: 'overlay_cleanup_failed',
          // 目录名不含源码，可以记；绝对路径不记，避免暴露宿主布局。
          entry,
          error_message: redactError(firstError),
        })
      }
    }
  }

  if (report.removed > 0 || report.failed > 0) {
    options.logger.info('overlay_cleanup_completed', {
      event: 'overlay_cleanup_completed',
      scanned: report.scanned,
      removed: report.removed,
      failed: report.failed,
      // 这个数字就是"有多少孤儿是被强杀留下的"，运维据此判断是否发生过非优雅关停。
      relaxed: report.relaxed,
    })
  }
  return report
}
