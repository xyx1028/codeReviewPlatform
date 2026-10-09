import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync, existsSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HISTORY_DIR, reclaimRepoCache } from '../git/prepare.js'

function tempRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)
const SHA_C = 'c'.repeat(40)

/** 造一个 <cacheRoot>/<repo>/<sha>/ 目录，内容为 size 字节，mtime/atime 可指定。 */
function makeCacheEntry(cacheRoot: string, repo: string, sha: string, size: number, at: Date): string {
  const dir = join(cacheRoot, repo, sha)
  mkdirSync(dir, { recursive: true })
  if (size > 0) writeFileSync(join(dir, 'blob.bin'), Buffer.alloc(size, 0x41))
  utimesSync(dir, at, at)
  return dir
}

/** 造一个 V1.11 历史裸仓库目录 <cacheRoot>/<repo>/.v111-history/<sha>/。 */
function makeHistoryEntry(cacheRoot: string, repo: string, sha: string, size: number, at: Date): string {
  const dir = join(cacheRoot, repo, HISTORY_DIR, sha)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'HEAD'), 'ref: refs/heads/main\n')
  if (size > 0) writeFileSync(join(dir, 'pack.bin'), Buffer.alloc(size, 0x42))
  utimesSync(dir, at, at)
  return dir
}

/** 远到一定在保护窗口之外。 */
const COLD = new Date('2020-01-01T00:00:00Z')

describe('reclaimRepoCache', () => {
  it('is a no-op when total size is within the ceiling', () => {
    const root = tempRoot('crp-repo-cache-under-')
    try {
      makeCacheEntry(root, 'repo1', SHA_A, 100, COLD)
      const result = reclaimRepoCache({ cacheRoot: root, maxBytes: 1000 })
      expect(result.removed).toBe(0)
      expect(result.bytes).toBe(0)
      expect(result.totalBytes).toBe(100)
      expect(existsSync(join(root, 'repo1', SHA_A))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('evicts the least recently used entries first, honoring keep', () => {
    const root = tempRoot('crp-repo-cache-lru-')
    try {
      const oldest = makeCacheEntry(root, 'repo1', SHA_A, 100, new Date('2020-01-01'))
      const middle = makeCacheEntry(root, 'repo1', SHA_B, 100, new Date('2020-02-01'))
      const newest = makeCacheEntry(root, 'repo2', SHA_C, 100, new Date('2020-03-01'))

      // 总量 300，上限 150：得删两个。最旧的被 keep 保护 → 跳过它删中间和最新之外的逻辑
      // 这里 keep 最旧，应删 middle（次旧），再需要就轮到 newest。
      const result = reclaimRepoCache({
        cacheRoot: root,
        maxBytes: 150,
        keep: new Set([`repo1/${SHA_A}`, `repo2/${SHA_C}`]),
      })
      expect(result.removed).toBe(1)
      expect(result.skippedInUse).toBe(2)
      expect(existsSync(oldest)).toBe(true)
      expect(existsSync(middle)).toBe(false)
      expect(existsSync(newest)).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('never evicts an entry marked in use inside the grace window', () => {
    const root = tempRoot('crp-repo-cache-inuse-')
    try {
      const nowMs = Date.UTC(2026, 0, 10, 12, 0, 0)
      // 另一个 attempt 五分钟前刷新过它 —— 保护窗口 15 分钟内，绝不能删。
      const hot = makeCacheEntry(root, 'repo1', SHA_A, 100, new Date(nowMs - 5 * 60 * 1000))
      const cold = makeCacheEntry(root, 'repo1', SHA_B, 100, new Date(nowMs - 60 * 60 * 1000))

      const result = reclaimRepoCache({
        cacheRoot: root,
        maxBytes: 50,
        inUseGraceMs: 15 * 60 * 1000,
        nowMs,
      })
      // 只能删冷的那个，删完仍然超限 —— 这必须如实报出来，而不是去删在用的目录。
      expect(result.removed).toBe(1)
      expect(result.skippedInUse).toBe(1)
      expect(result.totalBytes).toBe(100)
      expect(result.totalBytes).toBeGreaterThan(50)
      expect(existsSync(hot)).toBe(true)
      expect(existsSync(cold)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('accounts for and evicts V1.11 history bare repositories', () => {
    const root = tempRoot('crp-repo-cache-history-')
    try {
      const snapshot = makeCacheEntry(root, 'repo1', SHA_A, 100, new Date('2020-03-01'))
      const history = makeHistoryEntry(root, 'repo1', SHA_B, 300, new Date('2020-01-01'))

      // 历史裸仓库是卷里增长最快的部分：把它排除在计量之外，等于上限根本不生效。
      const measured = reclaimRepoCache({ cacheRoot: root, maxBytes: 10 * 1024 })
      expect(measured.totalBytes).toBeGreaterThanOrEqual(400)

      const result = reclaimRepoCache({ cacheRoot: root, maxBytes: 150 })
      expect(result.removed).toBe(1)
      expect(existsSync(history)).toBe(false)
      expect(existsSync(snapshot)).toBe(true)
      // 历史目录本身（`.v111-history`）保留，只删它下面那一代。
      expect(existsSync(join(root, 'repo1', HISTORY_DIR))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('skips .tmp- staging dirs and unrelated dot directories', () => {
    const root = tempRoot('crp-repo-cache-skip-')
    try {
      makeCacheEntry(root, 'repo1', SHA_A, 100, COLD)
      const other = join(root, 'repo1', '.something-else', SHA_A)
      mkdirSync(other, { recursive: true })
      writeFileSync(join(other, 'meta.json'), '{}')
      const staging = join(root, 'repo1', `${SHA_B}.tmp-1-1`)
      mkdirSync(staging, { recursive: true })
      writeFileSync(join(staging, 'partial'), 'x')

      const result = reclaimRepoCache({ cacheRoot: root, maxBytes: 1 })
      expect(result.removed).toBe(1)
      expect(existsSync(join(root, 'repo1', '.something-else'))).toBe(true)
      expect(existsSync(staging)).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('deletes read-only published trees (0o444/0o555)', () => {
    const root = tempRoot('crp-repo-cache-ro-')
    try {
      const dir = makeCacheEntry(root, 'repo1', SHA_A, 100, COLD)
      // 模拟 fetchExactSha 发布后的只读快照。
      chmodSync(join(dir, 'blob.bin'), 0o444)
      chmodSync(dir, 0o555)

      const result = reclaimRepoCache({ cacheRoot: root, maxBytes: 1 })
      expect(result.removed).toBe(1)
      expect(existsSync(dir)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
