/**
 * Linky 校验的时间预算与健康探针（V1.59）。
 *
 * 全部对着 2026-10-20 对**新域名** `linky.kingdee.com` 的实测写：
 *
 *   · `GET /stories/{code}` 命中        → 200，5.84 秒
 *   · `GET /stories/{code}` 未命中      → 404，**31.80 秒**（遍历完所有工作区才确认找不到）
 *   · `GET /stories?workspace_name=工具开发组&page_size=1` → 200，0.45～0.60 秒
 *   · `GET /stories?page_size=1`（跨组）→ 200，**15.06 秒**（先汇总再分页）
 *
 * 这些数字直接决定两件事：详情与探针必须分开计时；探针绝不能用跨组查询。
 */

import { strict as assert } from 'node:assert'
import test from 'node:test'

import { LinkyReadOnlyClient } from '../src/linky.mjs'
import { loadConfig } from '../src/config.mjs'

const BASE = 'https://linky.example.com/quality-platform/api/linky'

const BASE_ENV = {
  CRP_SUPABASE_URL: 'https://proj.supabase.co',
  CRP_SUPABASE_ANON_KEY: 'anon-key',
  CRP_EMAIL: 'mcp@example.com',
  CRP_PASSWORD: 'secret',
  CRP_PLATFORM_WEB_URL: 'https://review.example.com',
  CRP_MCP_TOKENS: 'alice:0123456789abcdef0123',
}

/** 记录每次请求的 URL 与超时预算。 */
function recordingFetch(handler) {
  const calls = []
  return {
    calls,
    fetchImpl: async (url, init) => {
      // AbortSignal.timeout 不暴露时长，所以从 init 里拿不到；这里只记 URL。
      calls.push(url)
      return handler(url, init)
    },
  }
}

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, async text() { return JSON.stringify(body) } }
}

test('健康探针按真实项目组查，绝不用跨组查询（跨组实测 15 秒）', async () => {
  const { calls, fetchImpl } = recordingFetch(() => jsonResponse({ items: [{ id: 'x' }], total: 273 }))
  const client = new LinkyReadOnlyClient({ baseUrl: BASE, fetchImpl, healthWorkspace: '工具开发组' })
  const health = await client.probeHealth()
  assert.equal(health.healthy, true)
  assert.equal(calls.length, 1)
  const url = new URL(calls[0])
  assert.equal(
    url.searchParams.get('workspace_name'),
    '工具开发组',
    '探针必须带 workspace_name，否则走的是 15 秒的跨组聚合',
  )
  assert.equal(url.searchParams.get('page_size'), '1', '探针只需要一条，不要拉整页')
})

test('探针项目组解析不到时报"探针配错了"，不冒充健康', async () => {
  // 这是最隐蔽的失效方式：探一个**不存在**的组名时，上游在本地短路返回
  // 200 + 空列表，压根不会去调 Linky。于是探针永远报"健康"，
  // 它要防的那个误判（拿上游故障去否认一条真实需求）照样发生。
  const { fetchImpl } = recordingFetch(() => jsonResponse({ items: [], total: 0 }))
  const client = new LinkyReadOnlyClient({ baseUrl: BASE, fetchImpl, healthWorkspace: '工具组' })
  const health = await client.probeHealth()
  assert.equal(health.healthy, false)
  assert.equal(health.error.code, 'LINKY_HEALTH_PROBE_MISCONFIGURED')
  assert.match(health.error.message, /CRP_LINKY_HEALTH_WORKSPACE/)
})

test('探针识别上游凭据失效（外层 400 + 内层 invalid token）', async () => {
  const { fetchImpl } = recordingFetch(() =>
    jsonResponse({ detail: 'Linky 返回错误（401）：invalid token' }, 400),
  )
  const client = new LinkyReadOnlyClient({ baseUrl: BASE, fetchImpl })
  const health = await client.probeHealth()
  assert.equal(health.healthy, false)
  assert.equal(health.error.code, 'LINKY_UPSTREAM_AUTH_FAILED')
})

test('详情超时必须大于未命中耗时（实测 31.8 秒），否则"编号写错"永远表现为超时', () => {
  const config = loadConfig({ ...BASE_ENV })
  assert.ok(
    config.linky.timeoutMs > 32_000,
    `CRP_LINKY_TIMEOUT_MS 当前 ${config.linky.timeoutMs}ms，必须大于实测的 31.8 秒未命中耗时`,
  )
})

test('探针超时与详情分开，且最坏路径留在客户端 60 秒上限之内', () => {
  const config = loadConfig({ ...BASE_ENV })
  assert.ok(
    config.linky.healthTimeoutMs < config.linky.timeoutMs,
    '探针是 0.5 秒级的按组查询，不该沿用详情那条 35 秒的预算',
  )
  // 第一步（核对）最坏 = 一次详情 + 一次探针。
  const worstPreflight = config.linky.timeoutMs + config.linky.healthTimeoutMs
  assert.ok(
    worstPreflight <= 55_000,
    `核对最坏耗时 ${worstPreflight}ms 必须小于客户端默认的 60 秒，否则使用者看到的是 "tool call failed"`,
  )
  // 第二步（提交）最坏 = 平台写操作 + 结果不明核对。
  const worstSubmit =
    config.platform.timeoutMs +
    config.settle.settleProbes * config.settle.probeTimeoutMs +
    (config.settle.settleProbes - 1) * config.settle.settleDelayMs
  assert.ok(worstSubmit <= 55_000, `提交最坏耗时 ${worstSubmit}ms 超出预算`)
})

test('探针项目组与超时都可配置', () => {
  const config = loadConfig({
    ...BASE_ENV,
    CRP_LINKY_HEALTH_WORKSPACE: '前端开发组',
    CRP_LINKY_HEALTH_TIMEOUT_MS: '5000',
    CRP_LINKY_TIMEOUT_MS: '40000',
  })
  assert.equal(config.linky.healthWorkspace, '前端开发组')
  assert.equal(config.linky.healthTimeoutMs, 5000)
  assert.equal(config.linky.timeoutMs, 40_000)
})

test('默认 Linky 地址是新域名（旧的 feature.kingdee.com:2055 已不可用）', () => {
  const config = loadConfig({ ...BASE_ENV })
  assert.match(config.linky.baseUrl, /^https:\/\/linky\.kingdee\.com\//)
  assert.ok(!config.linky.baseUrl.includes(':2055'), '旧域名带端口，且实测已返回 invalid token')
})

test('详情响应里 attachments 为 null（无附件时上游就这么给）不该崩', async () => {
  const { fetchImpl } = recordingFetch(() =>
    jsonResponse({
      id: '3707fd6f-3264-45cb-9299-a43d24e9a292',
      code: 'US-2026-017341',
      title: '【server】【技能】技能加载优化',
      workspace_name: '工具开发组',
      status_label: '需求编写完成',
      status: 'te3L3uJF',
      attachments: null,
      field_values: { gf_description: 'x'.repeat(114) },
      team: { req: [{ name: '张烨' }], dev: [{ name: '薛宇轩' }], test: [{ name: '王麒达' }] },
    }),
  )
  const client = new LinkyReadOnlyClient({ baseUrl: BASE, fetchImpl })
  const { describeStory } = await import('../src/preflight.mjs')
  const story = describeStory(await client.getStory('US-2026-017341'))
  assert.equal(story.attachment_count, 0)
  assert.equal(story.workspace_name, '工具开发组')
  // 详情的 status 是内部码，可读值在 status_label。
  assert.equal(story.status_label, '需求编写完成')
  assert.equal(story.body_chars, 114)
  assert.deepEqual(story.test_owners, ['王麒达'])
})

test('需求编号经 encodeURIComponent，不拼出可控路径', async () => {
  const { calls, fetchImpl } = recordingFetch(() => jsonResponse({ code: 'x' }))
  const client = new LinkyReadOnlyClient({ baseUrl: BASE, fetchImpl })
  await client.getStory('US-1/../../admin')
  assert.ok(!calls[0].includes('/../'), `URL 里不该出现路径穿越：${calls[0]}`)
  assert.match(calls[0], /%2F|%2E/, '分隔符必须被转义')
})
