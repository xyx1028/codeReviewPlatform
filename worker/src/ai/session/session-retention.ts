/**
 * Session JSONL 的保留期与容量治理。
 *
 * Session 日志里带真实源码，所以"永久保留"不是一个选项 —— 它既是数据泄露面，也是磁盘
 * 写满的直接原因，而磁盘写满会让所有在跑的 attempt 一起失败。
 *
 * 两条独立的回收依据：
 *
 *   1. **保留期**：超过 policy 的 retentionDays 就删。以目录 mtime 为准，正在写入的
 *      attempt 目录 mtime 持续更新，不会被误删。
 *   2. **容量水位**：即使都没到保留期，占用超过阈值也要从最旧的开始删。没有这一条，
 *      一次任务洪峰就能把卷填满。
 *
 * 单写者锁文件的存在会阻止回收：还有人在写的目录绝不删。
 */

import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Logger } from '../../logger.js'
import { redactError } from '../../security/redaction.js'
import { measureTree } from '../workspace/workspace-policy.js'

export interface SessionRetentionOptions {
  root: string
  retentionDays: number
  /** 占用超过这个字节数时按最旧优先回收，即使还没到保留期。 */
  maxTotalBytes: number
  logger: Logger
  now?: () => number
}

export interface RetentionReport {
  scanned: number
  removedExpired: number
  removedForCapacity: number
  skippedLocked: number
  failed: number
  totalBytesBefore: number
  totalBytesAfter: number
}

const DIRECTORY_PREFIX = 'attempt-'

interface Candidate {
  name: string
  path: string
  mtimeMs: number
  bytes: number
  locked: boolean
}

export function enforceSessionRetention(options: SessionRetentionOptions): RetentionReport {
  const report: RetentionReport = {
    scanned: 0,
    removedExpired: 0,
    removedForCapacity: 0,
    skippedLocked: 0,
    failed: 0,
    totalBytesBefore: 0,
    totalBytesAfter: 0,
  }
  if (!existsSync(options.root)) return report

  const now = options.now?.() ?? Date.now()
  const maxAgeMs = options.retentionDays * 24 * 60 * 60 * 1000

  let names: string[]
  try {
    names = readdirSync(options.root)
  } catch (err) {
    options.logger.error('session_retention_scan_failed', {
      event: 'session_retention_scan_failed',
      error_message: redactError(err),
    })
    return report
  }

  const candidates: Candidate[] = []
  for (const name of names) {
    if (!name.startsWith(DIRECTORY_PREFIX)) continue
    const path = join(options.root, name)
    let stat
    try {
      stat = statSync(path)
    } catch {
      continue
    }
    if (!stat.isDirectory()) continue
    report.scanned++
    const measured = measureTree(path)
    report.totalBytesBefore += measured.bytes
    candidates.push({
      name,
      path,
      mtimeMs: stat.mtimeMs,
      bytes: measured.bytes,
      locked: isLocked(path),
    })
  }

  const remove = (candidate: Candidate, kind: 'expired' | 'capacity'): boolean => {
    if (candidate.locked) {
      report.skippedLocked++
      return false
    }
    try {
      rmSync(candidate.path, { recursive: true, force: true, maxRetries: 3 })
      if (kind === 'expired') report.removedExpired++
      else report.removedForCapacity++
      return true
    } catch (err) {
      report.failed++
      options.logger.error('session_retention_delete_failed', {
        event: 'session_retention_delete_failed',
        // 目录名是 task+attempt 的摘要，不含源码，可以记。
        directory: candidate.name,
        reason: kind,
        error_message: redactError(err),
      })
      return false
    }
  }

  let retained: Candidate[] = []
  for (const candidate of candidates) {
    if (now - candidate.mtimeMs >= maxAgeMs) {
      if (!remove(candidate, 'expired')) retained.push(candidate)
      continue
    }
    retained.push(candidate)
  }

  // 容量水位：最旧优先。
  let currentBytes = retained.reduce((sum, candidate) => sum + candidate.bytes, 0)
  if (currentBytes > options.maxTotalBytes) {
    retained = retained.sort((a, b) => a.mtimeMs - b.mtimeMs)
    const survivors: Candidate[] = []
    for (const candidate of retained) {
      if (currentBytes <= options.maxTotalBytes) {
        survivors.push(candidate)
        continue
      }
      if (remove(candidate, 'capacity')) {
        currentBytes -= candidate.bytes
      } else {
        survivors.push(candidate)
      }
    }
    retained = survivors
  }

  report.totalBytesAfter = retained.reduce((sum, candidate) => sum + candidate.bytes, 0)

  if (report.removedExpired > 0 || report.removedForCapacity > 0 || report.failed > 0) {
    options.logger.info('session_retention_completed', {
      event: 'session_retention_completed',
      scanned: report.scanned,
      removed_expired: report.removedExpired,
      removed_for_capacity: report.removedForCapacity,
      skipped_locked: report.skippedLocked,
      failed: report.failed,
      bytes_before: report.totalBytesBefore,
      bytes_after: report.totalBytesAfter,
    })
  }

  // 水位告警：删完还超阈值说明容量配置本身不够，运维必须知道。
  if (report.totalBytesAfter > options.maxTotalBytes) {
    options.logger.error('session_volume_over_capacity', {
      event: 'session_volume_over_capacity',
      bytes: report.totalBytesAfter,
      limit: options.maxTotalBytes,
      locked_directories: report.skippedLocked,
    })
  }

  return report
}

/** 还有活写者的目录不回收。 */
function isLocked(directory: string): boolean {
  const lockPath = join(directory, '.writer.lock')
  if (!existsSync(lockPath)) return false
  try {
    // 锁文件存在即视为被占用。内容只用于诊断，不参与判定 —— 解析失败时同样保守处理。
    readFileSync(lockPath, 'utf8')
    return true
  } catch {
    return true
  }
}
