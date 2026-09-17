/**
 * V1.6 技能容量上限在四处的一致性。
 *
 * 方案 §8 的限制点是四个：上传校验服务（Edge Function）、发布/冻结事务（SQL）、
 * Worker cache miss 路径、以及前端展示的水位条。四处各写一份数字的后果是具体的：
 * **上传通过了、Job 建成了，Worker 下载到第 51 个包才失败** —— 治理成本被推到运行时，
 * 而运行时没有人在看。
 *
 * 为什么读源码文本而不是 import：`tsconfig.app.json` 只包含 `src`，从前端 import
 * `worker/**` 或 `supabase/functions/**` 会让 `tsc -b` 失败。代价是要写几个正则，
 * 收益是"某一处改了上限却忘了另三处"会直接把测试跑红。
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const MIGRATION = join(
  process.cwd(),
  'supabase/migrations/20260917100000_managed_dsh_skill_bundles.sql',
)
// V1.8：skill_bundle_limits() 的目录四项改为从 skill_catalog_limits_config 读取，
// 出厂默认写在这张表的列默认值里。单包上限仍是 skill_bundle_limits() 里的字面量。
const CONFIG_MIGRATION = join(
  process.cwd(),
  'supabase/migrations/20260917143802_configurable_skill_catalog_limits.sql',
)
const WORKER_LIMITS = join(process.cwd(), 'worker/src/ai/skills/skill-limits.ts')
const EDGE_BUNDLE = join(process.cwd(), 'supabase/functions/skill-bundle-admin/bundle.ts')
const WORKER_MANIFEST = join(process.cwd(), 'worker/src/ai/skills/skill-manifest.ts')

/** 把 `10 * 1024 * 1024` 这类算式求值。只接受数字、`*` 和空格。 */
function evaluateNumeric(expression: string): number {
  const cleaned = expression.trim()
  expect(cleaned).toMatch(/^[0-9\s*]+$/)
  return cleaned
    .split('*')
    .map((part) => Number(part.trim()))
    .reduce((total, part) => total * part, 1)
}

/** 从迁移里解析 `skill_bundle_limits()` 的 `jsonb_build_object` 键值。 */
function sqlLimits(): Record<string, number> {
  const sql = readFileSync(MIGRATION, 'utf8')
  const anchor = sql.indexOf('create or replace function public.skill_bundle_limits()')
  expect(anchor).toBeGreaterThan(-1)
  const open = sql.indexOf('jsonb_build_object(', anchor)
  const close = sql.indexOf('$$;', open)
  const body = sql.slice(open, close)
  const out: Record<string, number> = {}
  for (const match of body.matchAll(/'([A-Za-z]+)',\s*([0-9*\s]+?)\s*[,)]/g)) {
    out[match[1]!] = evaluateNumeric(match[2]!)
  }
  return out
}

/** 从一份 TypeScript 源码里解析 `key: <numeric expression>,`。 */
function tsLimits(path: string, anchorText: string): Record<string, number> {
  const source = readFileSync(path, 'utf8')
  const anchor = source.indexOf(anchorText)
  expect(anchor).toBeGreaterThan(-1)
  const open = source.indexOf('{', anchor)
  const close = source.indexOf('\n}', open)
  const body = source.slice(open, close)
  const out: Record<string, number> = {}
  for (const match of body.matchAll(/^\s{2}([A-Za-z]+):\s*([0-9*\s]+?),\s*$/gm)) {
    out[match[1]!] = evaluateNumeric(match[2]!)
  }
  return out
}

/**
 * V1.8：从配置迁移里解析 skill_catalog_limits_config 各列的 DEFAULT，映射到目录四项键。
 *
 * 这是「出厂默认」的权威来源——skill_bundle_limits() 运行时就是从这张表读这几项。
 */
function configTableDefaults(): Record<string, number> {
  const sql = readFileSync(CONFIG_MIGRATION, 'utf8')
  const anchor = sql.indexOf('create table if not exists public.skill_catalog_limits_config')
  expect(anchor).toBeGreaterThan(-1)
  const close = sql.indexOf(');', anchor)
  const body = sql.slice(anchor, close)
  const columnToKey: Record<string, string> = {
    catalog_bundles: 'catalogBundles',
    catalog_render_bytes: 'catalogRenderBytes',
    catalog_archive_bytes: 'catalogArchiveBytes',
    catalog_expanded_bytes: 'catalogExpandedBytes',
  }
  const out: Record<string, number> = {}
  for (const [column, key] of Object.entries(columnToKey)) {
    // 形如：  catalog_render_bytes bigint not null default 32 * 1024
    const re = new RegExp(`${column}\\s+\\w+\\s+not null\\s+default\\s+([0-9*\\s]+?)\\n`, 'i')
    const match = body.match(re)
    expect(match, `default for ${column}`).not.toBeNull()
    out[key] = evaluateNumeric(match![1]!)
  }
  return out
}

/** §8.1 单包上限：Worker、Edge Function 与 SQL 必须逐项相等。 */
const BUNDLE_KEYS = [
  'archiveBytes',
  'expandedBytes',
  'entryCount',
  'fileBytes',
  'entryFileBytes',
  'pathDepth',
  'pathBytes',
  'compressionRatio',
  'validateMs',
] as const

/**
 * §8.2 目录容量四项：V1.8 起可配置，运行时从 skill_catalog_limits_config 读取。
 * 一致性链条变成「配置表出厂默认 == Worker 编译默认 == 文档现值」。
 */
const CATALOG_CONFIGURABLE_KEYS = [
  'catalogBundles',
  'catalogRenderBytes',
  'catalogArchiveBytes',
  'catalogExpandedBytes',
] as const

/** descriptionChars 未放开，仍是 SQL 与 Worker 两处的字面量常量。 */
const CATALOG_CONSTANT_KEYS = ['descriptionChars'] as const

describe('V1.6/V1.8 skill limits agree everywhere they are enforced', () => {
  const sql = sqlLimits()
  const workerBundle = tsLimits(WORKER_LIMITS, 'export const SKILL_BUNDLE_LIMITS')
  const workerCatalog = tsLimits(WORKER_LIMITS, 'export const SKILL_CATALOG_LIMITS')
  const edge = tsLimits(EDGE_BUNDLE, 'export const LIMITS =')
  const configDefaults = configTableDefaults()

  it('parses a non-empty limit table from each source', () => {
    // 解析器自身的守卫：一个匹配不到任何键的正则会让下面每条断言都"通过"。
    expect(Object.keys(sql).length).toBeGreaterThanOrEqual(BUNDLE_KEYS.length)
    expect(Object.keys(workerBundle).length).toBeGreaterThanOrEqual(BUNDLE_KEYS.length)
    expect(Object.keys(edge).length).toBeGreaterThanOrEqual(BUNDLE_KEYS.length)
    expect(Object.keys(configDefaults).length).toBe(CATALOG_CONFIGURABLE_KEYS.length)
  })

  it.each(BUNDLE_KEYS)('per-bundle limit %s is the same in SQL, Worker and Edge Function', (key) => {
    expect(workerBundle[key]).toBe(sql[key])
    expect(edge[key]).toBe(sql[key])
  })

  it.each(CATALOG_CONSTANT_KEYS)('non-configurable catalog limit %s is the same in SQL and Worker', (key) => {
    expect(workerCatalog[key]).toBe(sql[key])
  })

  it.each(CATALOG_CONFIGURABLE_KEYS)(
    'configurable catalog limit %s: config-table factory default == Worker compiled default',
    (key) => {
      // V1.8：SQL 运行时从配置表读，所以不再比对 SQL 字面量；改为比对「出厂默认」与 Worker 默认。
      expect(configDefaults[key]).toBe(workerCatalog[key])
    },
  )

  it('keeps the documented numbers, not just internally consistent ones', () => {
    // 单包上限（§8.1）：钉住绝对值。
    expect(sql.archiveBytes).toBe(10 * 1024 * 1024)
    expect(sql.expandedBytes).toBe(50 * 1024 * 1024)
    expect(sql.entryCount).toBe(200)
    expect(sql.fileBytes).toBe(10 * 1024 * 1024)
    expect(sql.entryFileBytes).toBe(64 * 1024)
    expect(sql.pathDepth).toBe(8)
    expect(sql.pathBytes).toBe(240)
    expect(sql.compressionRatio).toBe(20)
    expect(sql.validateMs).toBe(30000)
    expect(sql.descriptionChars).toBe(500)
    // 目录四项（§8.2）：出厂默认必须等于 V1.6 现值，保证升级零行为变化。
    expect(configDefaults.catalogBundles).toBe(50)
    expect(configDefaults.catalogRenderBytes).toBe(32 * 1024)
    expect(configDefaults.catalogArchiveBytes).toBe(100 * 1024 * 1024)
    expect(configDefaults.catalogExpandedBytes).toBe(256 * 1024 * 1024)
  })
})

describe('V1.6 canonical hash format agrees between SQL and TypeScript', () => {
  const sql = readFileSync(MIGRATION, 'utf8')
  const workerManifest = readFileSync(WORKER_MANIFEST, 'utf8')
  const edge = readFileSync(EDGE_BUNDLE, 'utf8')

  it('uses the same version tags on both sides', () => {
    // 版本标签是规范格式的第一行。它在一侧改了另一侧没改，两侧算出的 hash 会静默分叉，
    // 而分叉的表现是"每个 Job 一启动就 SESSION_SKILL_SET_MISMATCH"。
    expect(sql).toContain('skill-bundle-v1')
    expect(sql).toContain('skill-catalog-v1')
    expect(workerManifest).toContain('skill-bundle-v1')
    expect(workerManifest).toContain('skill-catalog-v1')
    expect(edge).toContain('skill-bundle-v1')
  })

  it('sorts bytewise on the SQL side so it matches JavaScript code-unit order', () => {
    // Postgres 的默认 locale 排序会把 `SKILL.md` 排到 `assets/` 之后，而 JS 的 `<`
    // 不会。没有 `collate "C"` 的话两侧 bundle hash 必然不同。
    expect(sql).toContain(`order by (file->>'path') collate "C"`)
    expect(sql).toContain(`order by (entry->>'name') collate "C"`)
  })

  it('never serializes the canonical input as JSON', () => {
    // `jsonb::text` 渲染成 `{"a": 1}`，`JSON.stringify` 渲染成 `{"a":1}`。任何一侧改用
    // JSON 序列化都会让两侧永久不一致，所以这里明确禁止。
    const bundleHashInput = sql.slice(
      sql.indexOf('create or replace function public.skill_bundle_hash_input'),
      sql.indexOf('create or replace function public.skill_bundle_hash('),
    )
    expect(bundleHashInput).not.toContain('::text')
    expect(bundleHashInput).toContain(E_TAB)
  })
})

/** SQL 里制表符分隔符的字面写法。单独提出来避免测试源码里出现真实制表符。 */
const E_TAB = String.raw`E'\t'`
