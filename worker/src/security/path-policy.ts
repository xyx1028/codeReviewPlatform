/**
 * Path policy: constrain all file access to inside a single repository root.
 * (Plan §11.4)
 *
 * - Every resolved path must remain within the repository root after realpath.
 * - `..` traversal is rejected.
 * - Sensitive / generated directories and files are blocked.
 */

import { realpathSync } from 'node:fs'
import { isAbsolute, resolve, sep } from 'node:path'

/** Directories that must never be read by the AI tools. */
export const BLOCKED_DIRECTORIES = [
  '.git',
  'node_modules',
  'target',
  'dist',
  'build',
  'out',
  '.next',
  'coverage',
  '.gradle',
  '.idea',
]

/**
 * Filename / extension patterns considered secret or credential material.
 * Matched case-insensitively against the basename and full relative path.
 */
export const BLOCKED_FILE_PATTERNS: RegExp[] = [
  /(^|\/)\.env($|\.)/i,
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /\.keystore$/i,
  /\.jks$/i,
  /\.crt$/i,
  /\.cer$/i,
  /id_rsa/i,
  /id_dsa/i,
  /id_ecdsa/i,
  /id_ed25519/i,
  /credentials?(\.|$)/i,
  /secret[s]?(\.|$)/i,
  /\.der$/i,
]

export class PathPolicyError extends Error {
  code: string
  constructor(message: string, code = 'EVIDENCE_PATH_INVALID') {
    super(message)
    this.name = 'PathPolicyError'
    this.code = code
  }
}

/** Normalize a relative path separator to POSIX for pattern checks. */
function toPosix(p: string): string {
  return p.split(sep).join('/')
}

/**
 * Return true if the relative path traverses into a blocked directory.
 */
export function isBlockedPath(relativePath: string): boolean {
  const posix = toPosix(relativePath).replace(/^\/+/, '')
  const segments = posix.split('/').filter(Boolean)
  if (segments.some((s) => BLOCKED_DIRECTORIES.includes(s))) {
    return true
  }
  const basename = segments[segments.length - 1] ?? ''
  return BLOCKED_FILE_PATTERNS.some((re) => re.test(basename) || re.test(posix))
}

/** True if the raw path string contains an obvious traversal attempt. */
export function containsTraversal(relativePath: string): boolean {
  const posix = toPosix(relativePath)
  if (posix.includes('\0')) return true
  const segments = posix.split('/')
  return segments.includes('..')
}

/**
 * Resolve a repository-relative path to an absolute path, enforcing that the
 * result stays inside `repoRoot` even after symlink resolution.
 *
 * @throws PathPolicyError on traversal, blocked path, or escaping the root.
 */
export function resolveSafePath(repoRoot: string, relativePath: string): string {
  if (typeof relativePath !== 'string' || relativePath.length === 0) {
    throw new PathPolicyError('empty path')
  }
  if (isAbsolute(relativePath)) {
    throw new PathPolicyError(`absolute paths are not allowed: ${relativePath}`)
  }
  if (containsTraversal(relativePath)) {
    throw new PathPolicyError(`path traversal rejected: ${relativePath}`)
  }
  if (isBlockedPath(relativePath)) {
    throw new PathPolicyError(`blocked path: ${relativePath}`)
  }

  const rootReal = realpathSyncSafe(repoRoot)
  const candidate = resolve(rootReal, relativePath)
  if (!isInside(rootReal, candidate)) {
    throw new PathPolicyError(`path escapes repository root: ${relativePath}`)
  }

  // After the file exists, its realpath must still be inside root (symlink guard).
  const real = realpathSyncSafe(candidate)
  if (!isInside(rootReal, real)) {
    throw new PathPolicyError(
      `resolved path escapes repository root: ${relativePath}`,
    )
  }
  return real
}

/** True when `child` is equal to or nested within `parent`. */
export function isInside(parent: string, child: string): boolean {
  const p = parent.endsWith(sep) ? parent : parent + sep
  return child === parent || child.startsWith(p)
}

/** Maximum accepted length for a caller-supplied path glob. */
export const MAX_PATH_GLOB_LENGTH = 256

/**
 * Validate a caller-supplied path glob used by searchCode/findFiles. Rejects
 * overly long globs (DoS / ReDoS surface), absolute globs, and `..` traversal.
 * Returns the glob unchanged when valid.
 *
 * @throws PathPolicyError on violation.
 */
export function assertSafePathGlob(glob: string): string {
  if (typeof glob !== 'string' || glob.length === 0) {
    throw new PathPolicyError('empty path glob', 'PATH_GLOB_INVALID')
  }
  if (glob.length > MAX_PATH_GLOB_LENGTH) {
    throw new PathPolicyError(
      `path glob exceeds ${MAX_PATH_GLOB_LENGTH} chars`,
      'PATH_GLOB_INVALID',
    )
  }
  if (glob.includes('\0')) {
    throw new PathPolicyError('path glob contains null byte', 'PATH_GLOB_INVALID')
  }
  const posix = toPosix(glob)
  if (isAbsolute(glob) || posix.startsWith('/')) {
    throw new PathPolicyError('absolute path globs are not allowed', 'PATH_GLOB_INVALID')
  }
  if (posix.split('/').includes('..')) {
    throw new PathPolicyError('path glob must not contain traversal', 'PATH_GLOB_INVALID')
  }
  return glob
}

function realpathSyncSafe(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    // If the target does not exist yet, resolve lexically. Callers that require
    // existence (readCode) will fail later on fs access.
    return resolve(p)
  }
}
