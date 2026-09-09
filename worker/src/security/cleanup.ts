/**
 * Safe workspace cleanup. (Plan §17.3)
 *
 * Only directories whose name parses as a database job UUID may be removed, and
 * only when they are strictly inside the configured workspace root. Never run a
 * recursive delete against /workspace itself or an unresolved path.
 */

import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { isInside } from '../security/path-policy.js'

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isJobDirName(name: string): boolean {
  return UUID_RE.test(name)
}

/**
 * Remove the working directory for a specific job id. Refuses if the id is not
 * a UUID or the resolved path escapes the workspace root.
 */
export function cleanupJobDir(workspaceRoot: string, jobId: string): boolean {
  if (!isJobDirName(jobId)) {
    throw new Error(`refusing to clean non-UUID job dir: ${jobId}`)
  }
  const root = resolve(workspaceRoot)
  const target = resolve(join(root, jobId))
  if (!isInside(root, target) || target === root) {
    throw new Error(`refusing to clean path outside workspace: ${jobId}`)
  }
  if (!existsSync(target)) return false
  rmSync(target, { recursive: true, force: true })
  return true
}

/**
 * On startup, scan the workspace root for leftover job directories and clean
 * those whose names are valid UUIDs. Returns the list of cleaned ids.
 */
export function cleanupOrphanedJobDirs(
  workspaceRoot: string,
  isActive: (jobId: string) => boolean = () => false,
): string[] {
  const root = resolve(workspaceRoot)
  if (!existsSync(root)) return []
  const cleaned: string[] = []
  for (const name of readdirSync(root)) {
    const p = join(root, name)
    try {
      if (!statSync(p).isDirectory()) continue
    } catch {
      continue
    }
    if (!isJobDirName(name)) continue // never touch unexpected dirs
    if (isActive(name)) continue
    try {
      if (cleanupJobDir(root, name)) cleaned.push(name)
    } catch {
      // ignore individual failures; do not abort startup
    }
  }
  return cleaned
}
