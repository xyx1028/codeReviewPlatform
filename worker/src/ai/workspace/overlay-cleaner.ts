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
}

/** attempt 树的目录名前缀。只清理我们自己创建的形态，不碰同目录下的其他东西。 */
const MANAGED_PREFIXES = ['ws-', 'attempt-']

export function cleanOrphanedOverlays(options: OverlayCleanerOptions): CleanupReport {
  const report: CleanupReport = { scanned: 0, removed: 0, failed: 0, reclaimedBytes: 0 }
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
    } catch (err) {
      report.failed++
      options.logger.error('overlay_cleanup_failed', {
        event: 'overlay_cleanup_failed',
        // 目录名不含源码，可以记；绝对路径不记，避免暴露宿主布局。
        entry,
        error_message: redactError(err),
      })
    }
  }

  if (report.removed > 0 || report.failed > 0) {
    options.logger.info('overlay_cleanup_completed', {
      event: 'overlay_cleanup_completed',
      scanned: report.scanned,
      removed: report.removed,
      failed: report.failed,
    })
  }
  return report
}
