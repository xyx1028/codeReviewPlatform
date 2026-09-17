/**
 * 把 Job 冻结的技能目录变成本地可用的只读 cache 条目。
 *
 * 这一步跑在 **spawn dsh 之前**。方案 §12 说得很直接：恢复不能先启动 dsh、再异步补技能。
 * 原因不是性能 —— 是正确性。dsh 在第一次 `list` 时就把"有哪些技能"投影给了模型，那之后
 * 补进来的技能对本轮不存在，而对下一轮存在；同一个 attempt 里技能面会变，配置身份
 * （catalog hash）就无法定义。
 *
 * 失败一律 fail closed：不回退到空技能、不改用当前已发布版本。一个"少了三个技能但跑完了"
 * 的评审结论，比一个明确失败的 attempt 危险得多 —— 它看起来是有效结果。
 */

import {
  catalogHashFromBundles,
  canonicalManifest,
  computeBundleHash,
  sha256Prefixed,
  type FrozenCatalogLimits,
  type FrozenSkillBundle,
  type FrozenSkillCatalog,
  type SkillBundleManifest,
} from './skill-manifest.js'
import {
  SKILL_BUNDLE_LIMITS,
  SKILL_CATALOG_LIMITS,
  type SkillBundleLimits,
  type SkillCatalogLimits,
} from './skill-limits.js'
import { SKILL_ERROR_CODES, SkillGovernanceError } from './skill-errors.js'
import {
  SkillBundleInvalidError,
  SkillBundleLimitError,
  validateSkillArchive,
} from './bundle-validator.js'
import { SkillCache, SkillCacheCorruptError, type SkillCacheEntry } from './skill-cache.js'
import { SKILL_BUNDLE_BUCKET, type SkillStorageClient } from './skill-storage.js'

export interface ProvisionedSkill {
  bundle: FrozenSkillBundle
  cache: SkillCacheEntry
}

export interface SkillProvisionOutcome {
  /** Worker 独立重算出来的 catalog hash。与 Job 冻结值不等即拒绝。 */
  catalogHash: string
  bundles: ProvisionedSkill[]
  downloadBytes: number
  cacheHits: number
  cacheMisses: number
  expandedBytes: number
}

/**
 * 解析 claim-fenced RPC 返回的冻结目录。
 *
 * 解析而不是强转：这份 JSON 来自数据库，但字段缺失意味着"迁移没跑全"或"RPC 变了形状"，
 * 都必须在启动前就炸掉，而不是等到 `bundle.archiveObjectKey` 变成 `undefined` 再去下载。
 */
export function parseFrozenSkillCatalog(raw: unknown): FrozenSkillCatalog {
  if (raw === null || raw === undefined || typeof raw !== 'object') {
    // 没有任何返回 = 该 Job 没有技能目录（历史 Job）。空目录是合法状态，不是错误。
    return { snapshotVersion: 0, catalogHash: catalogHashFromBundles([]), bundles: [] }
  }
  const row = raw as Record<string, unknown>
  const rawBundles = Array.isArray(row.bundles) ? row.bundles : []
  const bundles: FrozenSkillBundle[] = rawBundles.map((item) => {
    const entry = item as Record<string, unknown>
    const bucket = String(entry.archive_bucket ?? '')
    if (bucket !== SKILL_BUNDLE_BUCKET) {
      throw new SkillGovernanceError(
        SKILL_ERROR_CODES.SKILL_BUNDLE_INVALID,
        'frozen skill snapshot names a bucket other than skill-bundles',
      )
    }
    const manifest = entry.bundle_manifest
    if (manifest === null || typeof manifest !== 'object') {
      throw new SkillGovernanceError(
        SKILL_ERROR_CODES.SKILL_BUNDLE_INVALID,
        'frozen skill snapshot carries no bundle manifest',
      )
    }
    return {
      snapshotId: String(entry.snapshot_id ?? ''),
      name: String(entry.name ?? ''),
      description: String(entry.description ?? ''),
      whenToUse:
        entry.when_to_use === null || entry.when_to_use === undefined
          ? undefined
          : String(entry.when_to_use),
      version: Number(entry.version ?? 0),
      archiveBucket: SKILL_BUNDLE_BUCKET,
      archiveObjectKey: String(entry.archive_object_key ?? ''),
      archiveSha256: String(entry.archive_sha256 ?? ''),
      archiveSizeBytes: Number(entry.archive_size_bytes ?? 0),
      bundleHash: String(entry.bundle_hash ?? ''),
      bundleManifest: canonicalManifest(manifest as SkillBundleManifest),
      expandedSizeBytes: Number(entry.expanded_size_bytes ?? 0),
      containsScripts: entry.contains_scripts === true,
    }
  })

  return {
    snapshotVersion: Number(row.snapshot_version ?? 0),
    catalogHash: String(row.catalog_hash ?? ''),
    bundles,
    catalogLimits: parseCatalogLimits(row.catalog_limits),
  }
}

/**
 * 解析快照里的 `catalog_limits`（V1.8）。
 *
 * 历史快照没有这个字段 → 返回 `undefined`，由 `resolveCatalogLimits` 回退编译默认。
 * 只要四项里任意一项缺失或非有限数，就整体视为不可信并回退默认——半份 limits 比没有更危险。
 */
function parseCatalogLimits(raw: unknown): FrozenCatalogLimits | undefined {
  if (raw === null || raw === undefined || typeof raw !== 'object') return undefined
  const row = raw as Record<string, unknown>
  const bundles = Number(row.catalogBundles)
  const render = Number(row.catalogRenderBytes)
  const archive = Number(row.catalogArchiveBytes)
  const expanded = Number(row.catalogExpandedBytes)
  if (![bundles, render, archive, expanded].every((n) => Number.isFinite(n) && n > 0)) {
    return undefined
  }
  return {
    catalogBundles: bundles,
    catalogRenderBytes: render,
    catalogArchiveBytes: archive,
    catalogExpandedBytes: expanded,
  }
}

/**
 * 把快照里冻结的四项容量上限合并到完整的 `SkillCatalogLimits` 上：四项用冻结值，
 * `descriptionChars` 未随 Job 冻结，取编译默认。快照缺失时整体回退编译默认。
 */
export function resolveCatalogLimits(catalog: FrozenSkillCatalog): SkillCatalogLimits {
  if (catalog.catalogLimits === undefined) return SKILL_CATALOG_LIMITS
  return {
    ...SKILL_CATALOG_LIMITS,
    catalogBundles: catalog.catalogLimits.catalogBundles,
    catalogRenderBytes: catalog.catalogLimits.catalogRenderBytes,
    catalogArchiveBytes: catalog.catalogLimits.catalogArchiveBytes,
    catalogExpandedBytes: catalog.catalogLimits.catalogExpandedBytes,
  }
}

/**
 * 全目录容量闸门。
 *
 * 数据库在 `freeze_analysis_job_skill_catalog` 里已经算过一遍。这里**再算一遍**不是冗余：
 * Worker 拿到的是快照，而快照理论上可能来自一个上限更宽松的旧版本函数。上限属于运行时
 * 资源，必须由要花掉这些资源的一方自己确认。
 */
function assertCatalogWithinLimits(
  catalog: FrozenSkillCatalog,
  limits: SkillCatalogLimits,
): void {
  if (catalog.bundles.length > limits.catalogBundles) {
    throw new SkillGovernanceError(
      SKILL_ERROR_CODES.SKILL_BUNDLE_LIMIT_EXCEEDED,
      `the frozen catalog holds more than ${limits.catalogBundles} bundles`,
    )
  }
  let archiveBytes = 0
  let expandedBytes = 0
  let renderBytes = 0
  for (const bundle of catalog.bundles) {
    if (bundle.description.length > limits.descriptionChars) {
      throw new SkillGovernanceError(
        SKILL_ERROR_CODES.SKILL_BUNDLE_LIMIT_EXCEEDED,
        'a frozen skill description exceeds the per-item character limit',
      )
    }
    archiveBytes += bundle.archiveSizeBytes
    expandedBytes += bundle.expandedSizeBytes
    renderBytes +=
      Buffer.byteLength(bundle.name, 'utf8') +
      Buffer.byteLength(bundle.description, 'utf8') +
      Buffer.byteLength(bundle.whenToUse ?? '', 'utf8')
  }
  if (archiveBytes > limits.catalogArchiveBytes) {
    throw new SkillGovernanceError(
      SKILL_ERROR_CODES.SKILL_BUNDLE_LIMIT_EXCEEDED,
      'the frozen catalog exceeds the total archive download limit',
    )
  }
  if (expandedBytes > limits.catalogExpandedBytes) {
    throw new SkillGovernanceError(
      SKILL_ERROR_CODES.SKILL_BUNDLE_LIMIT_EXCEEDED,
      'the frozen catalog exceeds the total expanded size limit',
    )
  }
  if (renderBytes > limits.catalogRenderBytes) {
    throw new SkillGovernanceError(
      SKILL_ERROR_CODES.SKILL_BUNDLE_LIMIT_EXCEEDED,
      'the frozen catalog exceeds the first-turn directory rendering limit',
    )
  }
}

export interface ProvisionSkillCatalogInput {
  catalog: FrozenSkillCatalog
  cache: SkillCache
  storage: SkillStorageClient
  bundleLimits?: SkillBundleLimits
  catalogLimits?: SkillCatalogLimits
  /** 观测钩子。缺省不记录。 */
  onEvent?: (event: {
    kind: 'CACHE_HIT' | 'CACHE_MISS' | 'DOWNLOADED' | 'PUBLISHED'
    name: string
    bundleHash: string
    bytes?: number
  }) => void
}

/**
 * 逐个 bundle 走 cache hit / miss 两条路，返回可用的 cache 条目与重算出来的 catalog hash。
 */
export async function provisionSkillCatalog(
  input: ProvisionSkillCatalogInput,
): Promise<SkillProvisionOutcome> {
  const bundleLimits = input.bundleLimits ?? SKILL_BUNDLE_LIMITS
  const catalogLimits = input.catalogLimits ?? SKILL_CATALOG_LIMITS
  assertCatalogWithinLimits(input.catalog, catalogLimits)

  const provisioned: ProvisionedSkill[] = []
  let downloadBytes = 0
  let cacheHits = 0
  let cacheMisses = 0
  let expandedBytes = 0

  for (const bundle of input.catalog.bundles) {
    assertBundleShape(bundle)

    let entry = lookupCache(input.cache, bundle)
    if (entry !== null) {
      cacheHits += 1
      input.onEvent?.({ kind: 'CACHE_HIT', name: bundle.name, bundleHash: bundle.bundleHash })
    } else {
      cacheMisses += 1
      input.onEvent?.({ kind: 'CACHE_MISS', name: bundle.name, bundleHash: bundle.bundleHash })
      const archive = await downloadArchive(input.storage, bundle)
      downloadBytes += archive.length
      input.onEvent?.({
        kind: 'DOWNLOADED',
        name: bundle.name,
        bundleHash: bundle.bundleHash,
        bytes: archive.length,
      })

      const validated = validateArchive(archive, bundle, bundleLimits)
      entry = publishToCache(input.cache, bundle, archive, validated.manifest, validated.files)
      input.onEvent?.({ kind: 'PUBLISHED', name: bundle.name, bundleHash: bundle.bundleHash })
    }

    expandedBytes += entry.manifest.expandedSizeBytes
    provisioned.push({ bundle, cache: entry })
  }

  return {
    catalogHash: catalogHashFromBundles(input.catalog.bundles),
    bundles: provisioned,
    downloadBytes,
    cacheHits,
    cacheMisses,
    expandedBytes,
  }
}

function assertBundleShape(bundle: FrozenSkillBundle): void {
  if (!/^sha256:[0-9a-f]{64}$/.test(bundle.archiveSha256)) {
    throw new SkillGovernanceError(
      SKILL_ERROR_CODES.SKILL_BUNDLE_INVALID,
      'frozen skill snapshot carries a malformed archive digest',
    )
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(bundle.bundleHash)) {
    throw new SkillGovernanceError(
      SKILL_ERROR_CODES.SKILL_BUNDLE_INVALID,
      'frozen skill snapshot carries a malformed bundle hash',
    )
  }
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(bundle.name)) {
    throw new SkillGovernanceError(
      SKILL_ERROR_CODES.SKILL_BUNDLE_INVALID,
      'frozen skill snapshot carries a name that is not a safe directory name',
    )
  }
  // 数据库自报的 bundle hash 必须与它自报的 manifest 自洽。这一条抓的是"库里的 hash
  // 与 manifest 被分别改过"这种情况 —— 单看任何一个都合法，合起来矛盾。
  if (computeBundleHash(bundle.bundleManifest) !== bundle.bundleHash) {
    throw new SkillGovernanceError(
      SKILL_ERROR_CODES.SKILL_BUNDLE_INVALID,
      'frozen skill manifest does not hash to the frozen bundle hash',
    )
  }
  if (bundle.bundleManifest.skillName !== bundle.name) {
    throw new SkillGovernanceError(
      SKILL_ERROR_CODES.SKILL_BUNDLE_INVALID,
      'frozen skill manifest names a different skill',
    )
  }
}

function lookupCache(cache: SkillCache, bundle: FrozenSkillBundle): SkillCacheEntry | null {
  const entry = cache.lookup(bundle.bundleHash)
  if (entry === null) return null
  if (entry.manifest.skillName !== bundle.name) {
    // 同一个 bundle hash 对应两个技能名在结构上不可能（skillName 进 hash 输入），
    // 出现即说明 cache 目录被人手工动过。
    throw new SkillGovernanceError(
      SKILL_ERROR_CODES.SKILL_CACHE_CORRUPT,
      'cached bundle belongs to a different skill than the frozen snapshot',
    )
  }
  return entry
}

async function downloadArchive(
  storage: SkillStorageClient,
  bundle: FrozenSkillBundle,
): Promise<Buffer> {
  let archive: Buffer
  try {
    archive = await storage.downloadArchive(bundle.archiveObjectKey)
  } catch (err) {
    throw new SkillGovernanceError(
      SKILL_ERROR_CODES.SKILL_BUNDLE_DOWNLOAD_FAILED,
      err instanceof Error ? err.message : 'skill archive download failed',
    )
  }
  if (archive.length !== bundle.archiveSizeBytes) {
    throw new SkillGovernanceError(
      SKILL_ERROR_CODES.SKILL_BUNDLE_DOWNLOAD_FAILED,
      'downloaded skill archive size differs from the frozen snapshot',
    )
  }
  if (sha256Prefixed(archive) !== bundle.archiveSha256) {
    throw new SkillGovernanceError(
      SKILL_ERROR_CODES.SKILL_ARCHIVE_HASH_MISMATCH,
      'downloaded skill archive digest differs from the frozen snapshot',
    )
  }
  return archive
}

function validateArchive(
  archive: Buffer,
  bundle: FrozenSkillBundle,
  limits: SkillBundleLimits,
): { manifest: SkillBundleManifest; files: Array<{ path: string; bytes: Buffer }> } {
  let validated
  try {
    validated = validateSkillArchive({
      archive,
      expectedSkillName: bundle.name,
      limits,
    })
  } catch (err) {
    if (err instanceof SkillBundleLimitError) {
      throw new SkillGovernanceError(SKILL_ERROR_CODES.SKILL_BUNDLE_LIMIT_EXCEEDED, err.message)
    }
    if (err instanceof SkillBundleInvalidError) {
      throw new SkillGovernanceError(SKILL_ERROR_CODES.SKILL_BUNDLE_INVALID, err.message)
    }
    throw err
  }
  // Worker 独立重算的 bundle hash 必须等于冻结值。这是三层 hash 的第二层，也是
  // "对象被换过"的唯一检测手段 —— archive hash 只能证明字节没坏，证明不了它是同一份
  // 逻辑内容（例如同一个 ZIP 用不同工具重打包）。
  if (validated.bundleHash !== bundle.bundleHash) {
    throw new SkillGovernanceError(
      SKILL_ERROR_CODES.SKILL_BUNDLE_INVALID,
      'recomputed bundle hash differs from the frozen snapshot',
    )
  }
  if (validated.expandedSizeBytes !== bundle.expandedSizeBytes) {
    throw new SkillGovernanceError(
      SKILL_ERROR_CODES.SKILL_BUNDLE_INVALID,
      'recomputed expanded size differs from the frozen snapshot',
    )
  }
  if (validated.containsScripts !== bundle.containsScripts) {
    throw new SkillGovernanceError(
      SKILL_ERROR_CODES.SKILL_BUNDLE_INVALID,
      'recomputed script marker differs from the frozen snapshot',
    )
  }
  return { manifest: validated.manifest, files: validated.files }
}

function publishToCache(
  cache: SkillCache,
  bundle: FrozenSkillBundle,
  archive: Buffer,
  manifest: SkillBundleManifest,
  files: ReadonlyArray<{ path: string; bytes: Buffer }>,
): SkillCacheEntry {
  try {
    return cache.publish({ bundleHash: bundle.bundleHash, manifest, archive, files })
  } catch (err) {
    if (err instanceof SkillCacheCorruptError) {
      throw new SkillGovernanceError(SKILL_ERROR_CODES.SKILL_CACHE_CORRUPT, err.message)
    }
    throw err
  }
}
