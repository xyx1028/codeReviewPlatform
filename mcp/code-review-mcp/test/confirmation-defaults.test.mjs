/**
 * 默认代码基线与提交时间窗口（V1.63）。
 *
 * 这一版改掉了一条此前刻意反着做的决定：分支与窗口原本**没有**默认值，理由是它们直接
 * 改变评审结论，静默替人选一个比报错更糟。
 *
 * 那条理由没有被推翻，而是换了方式满足 —— **默认值绝不沉默**：
 *
 *   · 卡片上用 `← 默认值` 标出哪些值不是使用者自己定的；
 *   · 把全部替代项连同人话含义列出来；
 *   · 明确告诉模型"用户要改就重新调一次"。
 *
 * 于是"确认"是一次真正的选择，而不是对一个他不知道存在的选项的默认接受。
 * 下面每条测试守的都是这三件事之一 —— 少任何一件，默认值就退化成了"替你偷偷决定"。
 */

import { strict as assert } from 'node:assert'
import test from 'node:test'

import { formatConfirmationCard } from '../src/format.mjs'
import {
  DEFAULT_BRANCH,
  DEFAULT_COMMIT_WINDOW_DAYS,
  SUPPORTED_BRANCHES,
  SUPPORTED_COMMIT_WINDOWS,
  loadConfig,
} from '../src/config.mjs'
import { BRANCH_LABELS } from '../src/query-tools.mjs'
import { LOOKUP_TOOL_NAME, TOOL_NAME, createToolRegistry } from '../src/tools.mjs'
import { ConfirmationSigner } from '../src/confirm.mjs'

const BASE_ENV = {
  CRP_SUPABASE_URL: 'https://proj.supabase.co',
  CRP_SUPABASE_ANON_KEY: 'anon-key',
  CRP_EMAIL: 'mcp@example.com',
  CRP_PASSWORD: 'secret',
  CRP_PLATFORM_WEB_URL: 'https://review.example.com',
  CRP_MCP_TOKENS: 'alice:0123456789abcdef0123',
}

const STORY = {
  id: '3707fd6f-3264-45cb-9299-a43d24e9a292',
  code: 'US-2026-017341',
  title: '【server】【技能】技能加载优化',
  workspace_name: '工具开发组',
  status_label: '需求编写完成',
  field_values: { gf_description: '正文' },
  attachments: null,
  team: null,
}

function registry(overrides = {}) {
  const calls = []
  return {
    calls,
    reg: createToolRegistry({
      client: {
        email: 'mcp@example.com',
        userId: 'u1',
        async rpc(name) {
          calls.push(name)
          if (name === 'list_enabled_model_configs') {
            return [{ id: 'm1', display_name: 'glm5.3-flash', has_api_key: true }]
          }
          if (name === 'request_linky_batch_import_for_analysis') return 'import-1'
          return true
        },
        async insert(table, row) {
          calls.push(`insert:${table}`)
          return { id: 'b1', name: row.name, week_code: row.week_code }
        },
      },
      config: {
        platform: { webUrl: 'https://review.example.com' },
        defaults: {
          modelLabel: 'glm5.3-flash',
          batchNamePrefix: 'MCP 评审',
          timeZone: 'Asia/Shanghai',
          branch: 'release',
          commitWindowDays: 14,
        },
      },
      linky: {
        async getStory() {
          return STORY
        },
        async probeHealth() {
          return { healthy: true, error: null }
        },
      },
      confirmations: new ConfirmationSigner(),
      ...overrides,
    }),
  }
}

// ---------------------------------------------------------------- 默认值本身

test('默认值是 release + 14 天', () => {
  assert.equal(DEFAULT_BRANCH, 'release')
  assert.equal(DEFAULT_COMMIT_WINDOW_DAYS, 14)
  const config = loadConfig({ ...BASE_ENV })
  assert.equal(config.defaults.branch, 'release')
  assert.equal(config.defaults.commitWindowDays, 14)
})

test('默认值可配置，但配成非法值启动即失败', () => {
  const config = loadConfig({
    ...BASE_ENV,
    CRP_DEFAULT_BRANCH: 'feature_sit',
    CRP_DEFAULT_COMMIT_WINDOW_DAYS: '21',
  })
  assert.equal(config.defaults.branch, 'feature_sit')
  assert.equal(config.defaults.commitWindowDays, 21)

  assert.throws(
    () => loadConfig({ ...BASE_ENV, CRP_DEFAULT_BRANCH: 'main' }),
    /CRP_DEFAULT_BRANCH 只能是/,
  )
  assert.throws(
    () => loadConfig({ ...BASE_ENV, CRP_DEFAULT_COMMIT_WINDOW_DAYS: '30' }),
    /CRP_DEFAULT_COMMIT_WINDOW_DAYS 只能是/,
  )
})

// ---------------------------------------------------------------- 卡片：不沉默

test('用了默认值必须标出来，用户给的值不标', () => {
  const withDefaults = formatConfirmationCard({
    status: 'VERIFIED',
    story: null,
    corrections: [],
    reason: null,
    request: {
      branch: 'release',
      commit_window_days: 14,
      workspace_name: '工具开发组',
      branch_is_default: true,
      window_is_default: true,
    },
    token: { value: 'v1.x.y', ttlMs: 900_000 },
  })
  assert.match(withDefaults, /release.*← 默认值/)
  assert.match(withDefaults, /14 天.*← 默认值/)

  const explicit = formatConfirmationCard({
    status: 'VERIFIED',
    story: null,
    corrections: [],
    reason: null,
    request: {
      branch: 'feature_dev',
      commit_window_days: 7,
      workspace_name: '工具开发组',
      branch_is_default: false,
      window_is_default: false,
    },
    token: { value: 'v1.x.y', ttlMs: 900_000 },
  })
  assert.ok(
    !/← 默认值/.test(explicit),
    '用户自己指定的值不该被标成默认值，否则他会以为平台没听他的',
  )
})

test('卡片必须列出全部替代分支（含人话含义），且不重复当前值', () => {
  const card = formatConfirmationCard({
    status: 'VERIFIED',
    story: null,
    corrections: [],
    reason: null,
    request: {
      branch: 'release',
      commit_window_days: 14,
      workspace_name: 'w',
      branch_is_default: true,
      window_is_default: true,
    },
    token: { value: 'v1.x.y', ttlMs: 900_000 },
  })
  for (const branch of SUPPORTED_BRANCHES) {
    assert.match(card, new RegExp(branch), `卡片必须提到 ${branch}`)
    assert.match(
      card,
      new RegExp(BRANCH_LABELS[branch].slice(0, 4)),
      `${branch} 必须带人话含义，光给分支名用户无从判断`,
    )
  }
  // 当前值不应出现在"还可以选"那一段里。
  const alternatives = card.slice(card.indexOf('代码基线还可以选'))
  assert.ok(!alternatives.includes('release'), '当前值不该重复列进替代项')
})

test('卡片必须列出全部替代时间窗口，且不重复当前值', () => {
  const card = formatConfirmationCard({
    status: 'VERIFIED',
    story: null,
    corrections: [],
    reason: null,
    request: {
      branch: 'release',
      commit_window_days: 14,
      workspace_name: 'w',
      branch_is_default: true,
      window_is_default: true,
    },
    token: { value: 'v1.x.y', ttlMs: 900_000 },
  })
  for (const days of SUPPORTED_COMMIT_WINDOWS.filter((item) => item !== 14)) {
    assert.match(card, new RegExp(`${days} 天`), `卡片必须提到 ${days} 天`)
  }
  const alternatives = card.slice(card.indexOf('提交时间窗口还可以选'))
  assert.ok(!alternatives.includes('14 天'), '当前值不该重复列进替代项')
})

test('卡片必须告诉模型"用户要改就重新调一次"', () => {
  const card = formatConfirmationCard({
    status: 'VERIFIED',
    story: null,
    corrections: [],
    reason: null,
    request: { branch: 'release', commit_window_days: 14, workspace_name: 'w' },
    token: { value: 'v1.x.y', ttlMs: 900_000 },
  })
  assert.match(card, /要改.*重新调用一次/)
  assert.match(card, /旧令牌.*失效/)
})

test('format 与 query-tools 的分支说明必须同值（两处定义，靠这条守一致）', () => {
  const card = formatConfirmationCard({
    status: 'VERIFIED',
    story: null,
    corrections: [],
    reason: null,
    request: { branch: 'feature_dev', commit_window_days: 7, workspace_name: 'w' },
    token: { value: 'v1.x.y', ttlMs: 900_000 },
  })
  assert.ok(
    card.includes(BRANCH_LABELS.feature_dev),
    'format.mjs 里的分支说明必须与 query-tools.mjs 的 BRANCH_LABELS 一字不差',
  )
})

// ---------------------------------------------------------------- 端到端

test('只给需求编号就能拿到确认卡片与可用令牌', async () => {
  const { reg, calls } = registry()
  const result = await reg.call(TOOL_NAME, { story_code: 'US-2026-017341' }, { caller: 'alice' })
  const text = result.content[0].text
  assert.equal(result.isError, false ?? false)
  assert.match(text, /还没有提交/)
  assert.match(text, /release.*← 默认值/)
  assert.match(text, /14 天.*← 默认值/)
  assert.match(text, /confirmation_token: v1\./)
  assert.equal(
    calls.filter((call) => call.startsWith('insert')).length,
    0,
    '第一步仍然不许建批次',
  )
})

test('默认值签出的令牌可以直接提交，且落库用的就是默认值', async () => {
  const { reg, calls } = registry()
  const first = await reg.call(TOOL_NAME, { story_code: 'US-2026-017341' }, { caller: 'alice' })
  const token = /confirmation_token: (\S+)/.exec(first.content[0].text)[1]

  const second = await reg.call(
    TOOL_NAME,
    { story_code: 'US-2026-017341', confirmation_token: token },
    { caller: 'alice' },
  )
  assert.equal(second.isError, false ?? false)
  assert.match(second.content[0].text, /已成功受理/)
  assert.match(second.content[0].text, /目标分支：release/)
  assert.match(second.content[0].text, /提交时间窗口：14 天/)
  assert.equal(calls.filter((call) => call.startsWith('insert')).length, 1)
})

test('用户改了分支之后，旧令牌必须失效（防止按确认过的旧参数提交）', async () => {
  const { reg, calls } = registry()
  const first = await reg.call(TOOL_NAME, { story_code: 'US-2026-017341' }, { caller: 'alice' })
  const token = /confirmation_token: (\S+)/.exec(first.content[0].text)[1]

  // 用户说"改成 feature_dev"，模型带着**旧**令牌提交 —— 必须被拒。
  const changed = await reg.call(
    TOOL_NAME,
    { story_code: 'US-2026-017341', branch: 'feature_dev', confirmation_token: token },
    { caller: 'alice' },
  )
  assert.equal(changed.isError, true)
  assert.match(changed.content[0].text, /CONFIRMATION_PARAM_MISMATCH/)
  assert.equal(calls.filter((call) => call.startsWith('insert')).length, 0)
})

test('用户指定的值要盖掉默认值，并在卡片上不再标"默认"', async () => {
  const { reg } = registry()
  const result = await reg.call(
    TOOL_NAME,
    { story_code: 'US-2026-017341', branch: 'feature_sit', commit_window_days: 21 },
    { caller: 'alice' },
  )
  const text = result.content[0].text
  assert.match(text, /代码基线（目标分支）：feature_sit/)
  assert.match(text, /提交时间窗口：21 天/)
  assert.ok(!/← 默认值/.test(text))
  // 替代项里现在应该出现 release 与 14 天。
  assert.match(text, /release/)
  assert.match(text, /14 天/)
})

test('只改其中一个时，另一个仍标为默认值', async () => {
  const { reg } = registry()
  const result = await reg.call(
    TOOL_NAME,
    { story_code: 'US-2026-017341', branch: 'feature_dev' },
    { caller: 'alice' },
  )
  const text = result.content[0].text
  assert.match(text, /代码基线（目标分支）：feature_dev/)
  assert.ok(!/feature_dev.*← 默认值/.test(text), '用户指定的分支不该标默认')
  assert.match(text, /14 天.*← 默认值/, '没指定的窗口仍要标默认')
})

test('lookup_requirement 不给分支/窗口也按默认值给出完整卡片', async () => {
  const { reg } = registry()
  const result = await reg.call(LOOKUP_TOOL_NAME, { story_code: 'US-2026-017341' })
  const text = result.content[0].text
  assert.match(text, /release.*← 默认值/)
  assert.match(text, /14 天.*← 默认值/)
  assert.match(text, /confirmation_token: v1\./)
})

test('配置缺默认值时退到模块常量，不产出"（空）"', async () => {
  const { reg } = registry({
    config: {
      platform: { webUrl: 'https://review.example.com' },
      // 刻意不给 branch / commitWindowDays
      defaults: { modelLabel: 'glm5.3-flash', batchNamePrefix: 'MCP 评审', timeZone: 'Asia/Shanghai' },
    },
  })
  const result = await reg.call(TOOL_NAME, { story_code: 'US-2026-017341' })
  const text = result.content[0].text
  assert.match(text, /代码基线（目标分支）：release/)
  assert.match(text, /提交时间窗口：14 天/)
  // 只看「本次评审参数」那一段：需求字段里的"（空）"是真实的（这条需求确实没有迭代），
  // 而参数段里出现"（空）"才说明默认值没套上。
  const paramsSection = text.slice(text.indexOf('本次评审参数'), text.indexOf('也可以换成'))
  assert.ok(
    !paramsSection.includes('（空）'),
    `undefined 会在参数段显示成"（空）"，那是一处静默失败。实际：\n${paramsSection}`,
  )
})
