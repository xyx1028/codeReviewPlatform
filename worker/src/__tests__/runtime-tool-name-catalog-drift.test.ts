/**
 * 运行监控工具名词表的漂移守卫。
 *
 * 真实缺口（2026-09-23 本地全链路实测，Job `e55681b7`）：V1.11 往 capability contract 里
 * 加了四个 Story 提交工具，但数据库的 `analysis_runtime_known_tool_names()` 没跟着加。
 * `analysis_runtime_event_payload()` 对 `tool_name` 做词表校验、不在表里就**静默丢弃**，
 * 于是 723 条 TOOL_CALL_COMPLETED 里有 33 条没有工具名，监控台显示「—」，
 * `tool_calls_by_name` 把它们计成 `unknown`。同样的道理，`platform_tool_names` 少了这四个，
 * 「慢是平台侧还是 Harness 侧」就会把它们算到 Harness 侧。
 *
 * 这个缺口没有任何错误码 —— 只能靠守卫。守卫直接读**迁移文件文本**与 contract JSON，
 * 与仓库里既有的目录一致性守卫同一套做法。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PLATFORM_TOOL_NAMES } from '../monitoring/runtime-attribution.js'

const root = join(import.meta.dirname, '../../..')
const migrationsDir = join(root, 'supabase/migrations')

/** 取某个 SQL 函数最后一次定义（按迁移文件名字典序 = 应用顺序）里的字符串字面量集合。 */
function latestSqlStringArray(functionName: string): string[] {
  const files = readdirSync(migrationsDir).filter((name) => name.endsWith('.sql')).sort()
  let body: string | null = null
  for (const file of files) {
    const text = readFileSync(join(migrationsDir, file), 'utf8')
    const marker = `create or replace function public.${functionName}()`
    let index = text.indexOf(marker)
    while (index !== -1) {
      const end = text.indexOf('$$;', index)
      body = text.slice(index, end === -1 ? undefined : end)
      index = text.indexOf(marker, index + marker.length)
    }
  }
  if (body === null) throw new Error(`未在迁移里找到 ${functionName} 的定义`)
  return [...body.matchAll(/'([^']+)'/g)].map((match) => match[1]!)
}

function contractModelTools(): string[] {
  const contract = JSON.parse(
    readFileSync(join(root, 'worker/harness/code-review-acp/v4-capability-contract.json'), 'utf8'),
  ) as { modelTools: Record<string, { origin: string }> }
  return Object.keys(contract.modelTools)
}

function brokerPlatformToolNames(): string[] {
  const source = readFileSync(join(root, 'worker/src/ai/control/attempt-control-broker.ts'), 'utf8')
  const block = /platformToolByRoute: Readonly<Record<string, string>> = \{([\s\S]*?)\n  \}/.exec(source)
  if (block === null) throw new Error('未在 Broker 里找到 platformToolByRoute')
  return [...block[1]!.matchAll(/'\/attempt\/[a-z-]+': '([a-z_]+)'/g)].map((match) => match[1]!)
}

function brokerPlatformRoutes(): string[] {
  const source = readFileSync(join(root, 'worker/src/ai/control/attempt-control-broker.ts'), 'utf8')
  const block = /platformToolByRoute: Readonly<Record<string, string>> = \{([\s\S]*?)\n  \}/.exec(source)
  if (block === null) throw new Error('未在 Broker 里找到 platformToolByRoute')
  return [...block[1]!.matchAll(/'\/attempt\/([a-z-]+)'/g)].map((match) => match[1]!)
}

describe('运行监控工具名词表不得漂移', () => {
  it('capability contract 里的每个模型工具都在数据库词表里', () => {
    const known = new Set(latestSqlStringArray('analysis_runtime_known_tool_names'))
    const missing = contractModelTools().filter((tool) => !known.has(tool))
    expect(missing).toEqual([])
  })

  it('Broker 的每条平台工具路由名都在数据库词表里', () => {
    const known = new Set(latestSqlStringArray('analysis_runtime_known_tool_names'))
    const missing = brokerPlatformRoutes().filter((route) => !known.has(route))
    expect(missing).toEqual([])
  })

  it('平台 origin 工具在数据库、Worker 归因、Broker 路由三处一致', () => {
    const sqlPlatform = [...latestSqlStringArray('analysis_runtime_platform_tool_names')].sort()
    const workerPlatform = [...PLATFORM_TOOL_NAMES].sort()
    const brokerPlatform = [...new Set(brokerPlatformToolNames())].sort()
    expect(workerPlatform).toEqual(sqlPlatform)
    expect(brokerPlatform).toEqual(sqlPlatform)
  })

  it('平台工具必须在 contract 里标成 platform origin', () => {
    const contract = JSON.parse(
      readFileSync(join(root, 'worker/harness/code-review-acp/v4-capability-contract.json'), 'utf8'),
    ) as { modelTools: Record<string, { origin: string }> }
    for (const tool of PLATFORM_TOOL_NAMES) {
      expect(contract.modelTools[tool]?.origin).toBe('platform')
    }
  })
})
