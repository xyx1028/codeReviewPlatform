/**
 * 事件目录在三处的一致性（V1.5 方案 Phase 0 完成标准）。
 *
 * Phase 0 的完成标准是「同一个状态、事件、字段在 SQL、Worker TypeScript、前端
 * TypeScript、`attempt_rollup` 日志四处名称一致」。四处里的最后一处由
 * `worker/src/__tests__/runtime-event-reporter.test.ts` 对照迁移文件的列名断言；
 * 这里守前三处的事件类型与 activity code。
 *
 * 为什么读文件而不是 import：`tsconfig.app.json` 只包含 `src`，从前端 import
 * `worker/**` 会让 `tsc -b` 失败。所以 SQL 目录与 Worker 契约都按文本解析 ——
 * 代价是要写解析器，收益是"某一处加了事件类型却忘了另两处"会直接把测试跑红，
 * 而不是等上线后前端显示一串看不懂的机器码。
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runtimeActivityLabels, runtimeEventTypeLabels } from '../labels'

const MIGRATION = join(
  process.cwd(),
  'supabase/migrations/0032_analysis_runtime_monitoring.sql',
)
const WORKER_TYPES = join(process.cwd(), 'worker/src/monitoring/runtime-event-types.ts')

interface CatalogEntry {
  scope: string
  phase?: string
  activity_code?: string
  status?: string
  keys: string[]
}

/** 从 0032 里解析 `analysis_runtime_event_catalog()` 返回的那段 JSON 字面量。 */
function sqlCatalog(): Record<string, CatalogEntry> {
  const sql = readFileSync(MIGRATION, 'utf8')
  const anchor = sql.indexOf('create or replace function public.analysis_runtime_event_catalog()')
  expect(anchor).toBeGreaterThan(-1)
  const open = sql.indexOf("select '", anchor) + "select '".length
  const close = sql.indexOf("'::jsonb", open)
  expect(close).toBeGreaterThan(open)
  return JSON.parse(sql.slice(open, close)) as Record<string, CatalogEntry>
}

/** 从 Worker 的事件契约里解析 `EVENT_SHAPE` 的键与 scope/phase。 */
function workerShape(): Record<string, { scope: string; phase: string | null }> {
  const source = readFileSync(WORKER_TYPES, 'utf8')
  const anchor = source.indexOf('const EVENT_SHAPE')
  expect(anchor).toBeGreaterThan(-1)
  const open = source.indexOf('= {', anchor) + 2
  const close = source.indexOf('\n}', open)
  const body = source.slice(open, close)
  const out: Record<string, { scope: string; phase: string | null }> = {}
  const entry = /([A-Z_]+):\s*\{\s*scope:\s*'([A-Z_]+)',\s*phase:\s*(null|'[A-Z]+')\s*\}/g
  let match = entry.exec(body)
  while (match !== null) {
    out[match[1]!] = {
      scope: match[2]!,
      phase: match[3] === 'null' ? null : match[3]!.replaceAll("'", ''),
    }
    match = entry.exec(body)
  }
  return out
}

describe('事件目录：SQL / Worker / 前端三处一致', () => {
  const catalog = sqlCatalog()
  const shape = workerShape()

  it('解析器确实拿到了目录（避免测试因为解析失败而空跑通过）', () => {
    expect(Object.keys(catalog).length).toBeGreaterThan(30)
    expect(Object.keys(shape).length).toBeGreaterThan(20)
  })

  it('Worker 能产生的每个事件类型都在 SQL 目录里（否则会被数据库当非法丢弃）', () => {
    const missing = Object.keys(shape).filter((type) => !(type in catalog))
    expect(missing).toEqual([])
  })

  it('Worker 与 SQL 对 scope / phase 的判断完全一致', () => {
    for (const [type, workerEntry] of Object.entries(shape)) {
      const sqlEntry = catalog[type]!
      expect(workerEntry.scope, `${type} 的 scope`).toBe(sqlEntry.scope)
      expect(workerEntry.phase, `${type} 的 phase`).toBe(sqlEntry.phase ?? null)
    }
  })

  it('SQL 目录里每个事件类型都有前端中文文案（未知码会退化成机器码）', () => {
    const missing = Object.keys(catalog).filter((type) => !(type in runtimeEventTypeLabels))
    expect(missing).toEqual([])
  })

  it('前端不给不存在的事件类型编文案', () => {
    const extra = Object.keys(runtimeEventTypeLabels).filter((type) => !(type in catalog))
    expect(extra).toEqual([])
  })

  it('SQL 目录里每个 activity_code 都有前端中文文案', () => {
    const codes = new Set(
      Object.values(catalog)
        .map((entry) => entry.activity_code)
        .filter((code): code is string => code !== undefined),
    )
    const missing = [...codes].filter((code) => !(code in runtimeActivityLabels))
    expect(missing).toEqual([])
  })

  it('Workflow / Harness Job 事件类型在三处都不存在（Phase 3 之前不许伪造步骤树）', () => {
    const forbidden = [
      'WORKFLOW_STARTED',
      'WORKFLOW_STEP_STARTED',
      'WORKFLOW_STEP_COMPLETED',
      'WORKFLOW_COMPLETED',
      'HARNESS_JOB_STARTED',
      'HARNESS_JOB_RUNNING',
      'HARNESS_JOB_COMPLETED',
    ]
    for (const type of forbidden) {
      expect(catalog, `SQL 目录不该有 ${type}`).not.toHaveProperty(type)
      expect(shape, `Worker 契约不该有 ${type}`).not.toHaveProperty(type)
      expect(runtimeEventTypeLabels, `前端文案不该有 ${type}`).not.toHaveProperty(type)
    }
  })

  it('生命周期事件必须成对：每个 STARTED 都有至少一个同 scope 的 TERMINAL', () => {
    const started = Object.entries(catalog).filter(([, entry]) => entry.phase === 'STARTED')
    expect(started.length).toBeGreaterThan(0)
    for (const [, entry] of started) {
      const terminals = Object.values(catalog).filter(
        (candidate) => candidate.scope === entry.scope && candidate.phase === 'TERMINAL',
      )
      expect(terminals.length, `${entry.scope} 缺少 TERMINAL 事件`).toBeGreaterThan(0)
    }
  })

  it('MODEL / TOOL scope 的事件一定带相位：它们是"正在调用"的唯一判据', () => {
    for (const [type, entry] of Object.entries(catalog)) {
      if (entry.scope !== 'MODEL' && entry.scope !== 'TOOL') continue
      expect(entry.phase, `${type} 必须声明 phase`).toBeDefined()
      expect(['STARTED', 'TERMINAL']).toContain(entry.phase)
    }
  })

  it('payload allowlist 里不出现任何内容正文类字段名', () => {
    const forbiddenKeys = [
      'prompt',
      'command',
      'stdout',
      'stderr',
      'api_key',
      'file_path',
      'storage_locator',
      'url',
      'query',
      'arguments',
      'response',
    ]
    for (const [type, entry] of Object.entries(catalog)) {
      for (const key of entry.keys) {
        expect(forbiddenKeys, `${type} 的 payload 键 ${key}`).not.toContain(key)
      }
    }
  })

  it('repository_name 是唯一允许出现的路径类字段（它是四仓枚举）', () => {
    const pathLike = new Set<string>()
    for (const entry of Object.values(catalog)) {
      for (const key of entry.keys) {
        // 按下划线分段匹配，不是裸子串：`events_reported` 里的 "repo" 不是路径。
        if (/(^|_)(path|dir|locator|file|repository|url)(_|$)/i.test(key)) pathLike.add(key)
      }
    }
    expect([...pathLike]).toEqual(['repository_name'])
  })
})
