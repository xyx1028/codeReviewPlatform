/**
 * 批量提交需求评审（V1.66）。
 *
 * 这一组盯住的是"一次调用多条需求"里真正会出事的地方，而不是把单条用例抄一遍：
 *
 *   · 多条必须落进**一个**批次、**一张**导入单（否则就等于没改，只是换了个写法）；
 *   · 项目组不一致、编号不存在时必须在**建批次之前**拒绝，并说清是哪几条；
 *   · 核对有总预算，预算用完的那几条要如实标成"没核对"，不许假装核对过；
 *   · 令牌绑定的是编号集合：少一条、多一条都得重新确认，顺序变了不算改。
 */

import { strict as assert } from 'node:assert'
import test from 'node:test'

import {
  buildBatchName,
  normalizeStoryCodes,
  submitRequirementReview,
} from '../src/review.mjs'
import {
  PREFLIGHT_BUDGET_EXCEEDED,
  PREFLIGHT_REJECTED,
  PREFLIGHT_UNVERIFIED,
  PREFLIGHT_VERIFIED,
  preflightRequirements,
} from '../src/preflight.mjs'
import { ConfirmationError, ConfirmationSigner } from '../src/confirm.mjs'
import { LinkyLookupError } from '../src/linky.mjs'
import { TOOL_NAME, createToolRegistry } from '../src/tools.mjs'
import { MAX_STORIES_PER_SUBMIT } from '../src/config.mjs'

const CONFIG = {
  platform: { webUrl: 'https://review.example.com' },
  linky: { preflightBudgetMs: 45_000 },
  defaults: {
    modelLabel: 'glm5.3-flash',
    batchNamePrefix: 'MCP 评审',
    branch: 'release',
    commitWindowDays: 14,
    timeZone: 'Asia/Shanghai',
  },
}

function storyDetail(code, { workspace = '工具开发组', body = '正文', attachments = [] } = {}) {
  return {
    id: `issue-${code}`,
    code,
    workspace_id: '22222222-2222-4222-8222-222222222222',
    workspace_name: workspace,
    status_label: '开发中',
    field_values: { gf_name: `${code} 的标题`, gf_description: body },
    attachments,
    team: { req: [{ id: 'u1', name: '张三' }], dev: [], test: [] },
  }
}

/** 假 Linky：按编号给详情，记录调用次数（用来证明列表查询被复用了）。 */
function fakeLinky({ details = {}, list = null, delays = {} } = {}) {
  const calls = { getStory: [], listStories: [], probeHealth: 0 }
  return {
    calls,
    async getStory(code) {
      calls.getStory.push(code)
      if (delays[code]) await new Promise((resolve) => setTimeout(resolve, delays[code]))
      const detail = details[code]
      if (detail === undefined) {
        throw new LinkyLookupError(`找不到 ${code}`, { code: 'LINKY_STORY_NOT_FOUND', status: 404 })
      }
      return detail
    },
    async listStories({ workspaceName }) {
      calls.listStories.push(workspaceName)
      return list ?? { items: [], total: 0, pages: 1, complete: false }
    },
    async probeHealth() {
      calls.probeHealth += 1
      return { healthy: true, error: null }
    },
  }
}

function fakeClient(overrides = {}) {
  const calls = []
  return {
    calls,
    email: 'mcp@example.com',
    userId: 'user-1',
    async rpc(name, args) {
      calls.push({ kind: 'rpc', name, args })
      if (overrides.rpc) return overrides.rpc(name, args)
      if (name === 'list_enabled_model_configs') {
        return [{ id: 'model-1', display_name: 'glm5.3-flash', has_api_key: true }]
      }
      if (name === 'request_linky_batch_import_for_analysis') return 'import-1'
      if (name === 'delete_review_batch') return true
      throw new Error(`unexpected rpc ${name}`)
    },
    async insert(table, row) {
      calls.push({ kind: 'insert', table, row })
      return { id: 'batch-1', name: row.name, week_code: row.week_code }
    },
  }
}

// ------------------------------------------------------------------ 入参归一

test('编号集合：数组与单值取并集、去重、保留首次顺序', () => {
  assert.deepEqual(normalizeStoryCodes({ story_codes: ['US-2', 'US-1'] }), ['US-2', 'US-1'])
  assert.deepEqual(normalizeStoryCodes({ story_code: 'US-1' }), ['US-1'])
  // 客户端把第一次的入参原样回传、又补了数组，是很常见的行为，不该判成参数冲突。
  assert.deepEqual(
    normalizeStoryCodes({ story_code: 'US-1', story_codes: ['US-2', 'US-1'] }),
    ['US-2', 'US-1'],
  )
  assert.deepEqual(normalizeStoryCodes({ story_codes: [' US-1 ', 'US-1', ''] }), ['US-1'])
})

test('编号集合：一个都没有、超过上限都明确失败', () => {
  assert.throws(() => normalizeStoryCodes({}), /story_codes/)
  assert.throws(() => normalizeStoryCodes({ story_codes: [] }), /story_codes/)
  assert.throws(() => normalizeStoryCodes({ story_codes: 'US-1' }), /必须是数组/)
  const tooMany = Array.from({ length: MAX_STORIES_PER_SUBMIT + 1 }, (_, i) => `US-${i}`)
  assert.throws(
    () => normalizeStoryCodes({ story_codes: tooMany }),
    new RegExp(`最多提交 ${MAX_STORIES_PER_SUBMIT} 条`),
  )
})

test('批次名列出全部编号；装不下时退化成「首条 等 N 条」而不是截断', () => {
  assert.equal(buildBatchName('MCP 评审', ['US-1']), 'MCP 评审：US-1')
  assert.equal(buildBatchName('MCP 评审', ['US-1', 'US-2']), 'MCP 评审：US-1、US-2')
  const many = Array.from({ length: 20 }, (_, i) => `US-2026-04240${i}`)
  const name = buildBatchName('MCP 评审', many)
  assert.ok(name.length <= 120, `批次名不能超过 120 字符，实际 ${name.length}`)
  assert.equal(name, 'MCP 评审：US-2026-042400 等 20 条')
})

// ------------------------------------------------------------------ 提交落库

test('多条需求落进同一个批次、同一张导入单', async () => {
  const client = fakeClient()
  const receipt = await submitRequirementReview(client, CONFIG, {
    story_codes: ['US-2026-042423', 'US-2026-042424'],
    workspace_name: '工具开发组',
    branch: 'release',
    commit_window_days: 14,
  })

  const inserts = client.calls.filter((call) => call.kind === 'insert')
  const imports = client.calls.filter(
    (call) => call.name === 'request_linky_batch_import_for_analysis',
  )
  assert.equal(inserts.length, 1, '一次调用只能建一个批次')
  assert.equal(imports.length, 1, '一次调用只能下一张导入单')
  assert.deepEqual(imports[0].args.p_story_codes, ['US-2026-042423', 'US-2026-042424'])
  assert.equal(inserts[0].row.name, 'MCP 评审：US-2026-042423、US-2026-042424')
  assert.deepEqual(receipt.story_codes, ['US-2026-042423', 'US-2026-042424'])
  assert.equal(receipt.story_code, null, '多条时不该伪装成某一条')
})

test('发布周期按调用方指定的值落库（此前这个参数被丢掉了）', async () => {
  const client = fakeClient()
  const receipt = await submitRequirementReview(client, CONFIG, {
    story_codes: ['US-1'],
    workspace_name: '工具开发组',
    branch: 'release',
    commit_window_days: 14,
    release_cycle: '20261231',
  })
  assert.equal(receipt.week_code, '20261231')
})

// ------------------------------------------------------------------ 多条核对

test('同组多条：逐条核对，但该组的需求列表只查一次', async () => {
  const linky = fakeLinky({
    details: { 'US-1': storyDetail('US-1'), 'US-2': storyDetail('US-2') },
    list: {
      items: [
        { code: 'US-1', iteration: '202610-1', release_window: 'R20261106', status: '需求编写完成' },
        { code: 'US-2', iteration: '202610-1', release_window: 'R20261106', status: '计划' },
      ],
      total: 2,
      pages: 1,
      complete: true,
    },
  })
  const outcome = await preflightRequirements(linky, { story_codes: ['US-1', 'US-2'] })
  assert.equal(outcome.status, PREFLIGHT_VERIFIED)
  assert.equal(outcome.workspaceName, '工具开发组')
  assert.deepEqual(outcome.entries.map((entry) => entry.story_code), ['US-1', 'US-2'])
  assert.equal(outcome.entries[0].story.release_window, 'R20261106')
  assert.deepEqual(linky.calls.listStories, ['工具开发组'], '同一个组不许查两遍')
})

test('跨项目组：拒绝提交，并逐条说明各自属于哪个组', async () => {
  const linky = fakeLinky({
    details: {
      'US-1': storyDetail('US-1', { workspace: '工具开发组' }),
      'US-2': storyDetail('US-2', { workspace: '平台开发组' }),
    },
  })
  const outcome = await preflightRequirements(linky, { story_codes: ['US-1', 'US-2'] })
  assert.equal(outcome.status, PREFLIGHT_REJECTED)
  assert.equal(outcome.reason.code, 'WORKSPACE_MIXED')
  assert.match(outcome.reason.message, /US-1 → 工具开发组/)
  assert.match(outcome.reason.message, /US-2 → 平台开发组/)
})

test('有编号确实不存在：整次拒绝，不替使用者剔掉那条照常提交', async () => {
  const linky = fakeLinky({ details: { 'US-1': storyDetail('US-1') } })
  const outcome = await preflightRequirements(linky, { story_codes: ['US-1', 'US-404'] })
  assert.equal(outcome.status, PREFLIGHT_REJECTED)
  assert.equal(outcome.reason.code, 'STORY_NOT_FOUND')
  assert.match(outcome.reason.message, /US-404/)
  assert.ok(!outcome.reason.message.includes('US-1、'), '不该把能查到的那条也算成缺失')
})

test('核对总预算用完：剩下的如实标成"没核对"，不假装核对过', async () => {
  const linky = fakeLinky({
    details: { 'US-1': storyDetail('US-1'), 'US-2': storyDetail('US-2') },
  })
  // 第一条就把预算吃光 —— 真实形态是前面有错编号在上游花掉了 32 秒。
  let clock = 0
  const getStory = linky.getStory.bind(linky)
  linky.getStory = async (code) => {
    clock += 40_000
    return getStory(code)
  }
  const outcome = await preflightRequirements(
    linky,
    { story_codes: ['US-1', 'US-2'] },
    { budgetMs: 10_000, concurrency: 1, now: () => clock },
  )
  assert.equal(outcome.status, PREFLIGHT_UNVERIFIED)
  assert.equal(outcome.entries[0].status, PREFLIGHT_VERIFIED)
  assert.equal(outcome.entries[1].status, PREFLIGHT_UNVERIFIED)
  assert.equal(outcome.entries[1].reason.code, PREFLIGHT_BUDGET_EXCEEDED)
  assert.equal(linky.calls.getStory.length, 1, '预算用完之后不该再打上游')
  // 没核对成的那条不能把整次提交变成"核对过"，但也不该阻断 —— 项目组仍取自核对成功的那条。
  assert.equal(outcome.workspaceName, '工具开发组')
  assert.equal(outcome.reason.code, 'PREFLIGHT_PARTIAL')
})

test('核对不可用（没配 Linky）：全部未核对，但仍可确认后提交', async () => {
  const outcome = await preflightRequirements(null, { story_codes: ['US-1', 'US-2'] })
  assert.equal(outcome.status, PREFLIGHT_UNVERIFIED)
  assert.equal(outcome.reason.code, 'PREFLIGHT_DISABLED')
  assert.equal(outcome.entries.length, 2)
})

// ------------------------------------------------------------------ 确认令牌

test('令牌绑定编号集合：顺序无关，增删一条即拒收', () => {
  const signer = new ConfirmationSigner({ secret: 'x'.repeat(32) })
  const token = signer.issue({
    story_codes: ['US-1', 'US-2'],
    workspace_name: '工具开发组',
    branch: 'release',
    commit_window_days: 14,
    verification: 'VERIFIED',
  })
  const expected = { workspace_name: '工具开发组', branch: 'release', commit_window_days: 14 }

  // 顺序不同不算改：导入单自己也会 distinct … order by code。
  assert.deepEqual(
    signer.verify(token, { ...expected, story_codes: ['US-2', 'US-1'] }).story_codes,
    ['US-1', 'US-2'],
  )
  assert.throws(
    () => signer.verify(token, { ...expected, story_codes: ['US-1'] }),
    ConfirmationError,
  )
  assert.throws(
    () => signer.verify(token, { ...expected, story_codes: ['US-1', 'US-2', 'US-3'] }),
    /需求条数/,
  )
  assert.throws(
    () => signer.verify(token, { ...expected, story_codes: ['US-1', 'US-9'] }),
    /需求编号/,
  )
})

// ------------------------------------------------------------------ 端到端

test('两步提交：卡片列出两条需求与条数，确认后只建一个批次', async () => {
  const client = fakeClient()
  const linky = fakeLinky({
    details: {
      'US-2026-042423': storyDetail('US-2026-042423'),
      'US-2026-042424': storyDetail('US-2026-042424', { body: '', attachments: [] }),
    },
    list: { items: [], total: 0, pages: 1, complete: false },
  })
  const registry = createToolRegistry({
    client,
    config: CONFIG,
    linky,
    confirmations: new ConfirmationSigner(),
  })

  const first = await registry.call(TOOL_NAME, {
    story_codes: ['US-2026-042423', 'US-2026-042424'],
  })
  assert.equal(first.isError, false)
  const card = first.content[0].text
  assert.match(card, /还没有提交/)
  assert.match(card, /2 条需求/)
  assert.match(card, /US-2026-042423/)
  assert.match(card, /US-2026-042424/)
  // 逐条提醒必须指明是哪一条，否则"正文为空"落在两条上无从判断该补哪一个。
  assert.match(card, /US-2026-042424：正文为空且没有附件/)
  assert.equal(
    client.calls.length,
    0,
    '第一步不许碰平台（不建批次、不查模型）',
  )

  const token = /confirmation_token:\s*(\S+)/.exec(card)?.[1]
  assert.ok(token?.startsWith('v1.'), '第一步必须给出可用令牌')

  const second = await registry.call(
    TOOL_NAME,
    { story_codes: ['US-2026-042424', 'US-2026-042423'], confirmation_token: token },
    { caller: 'alice' },
  )
  assert.equal(second.isError, false)
  const receipt = second.content[0].text
  assert.match(receipt, /已成功受理/)
  assert.match(receipt, /2 条，同一个批次/)
  // 第二次调用把编号顺序反了过来，但落库与回执仍按**确认过的那张卡片**的顺序 ——
  // "确认的是什么，提交的就是什么"只允许有一个来源（令牌）。
  const importCall = client.calls.find(
    (call) => call.name === 'request_linky_batch_import_for_analysis',
  )
  assert.deepEqual(importCall.args.p_story_codes, ['US-2026-042423', 'US-2026-042424'])
  assert.equal(
    client.calls.filter((call) => call.kind === 'insert').length,
    1,
    '确认后只建一个批次',
  )
})

test('跨组提交被工具层拒绝，且平台上没有任何批次', async () => {
  const client = fakeClient()
  const linky = fakeLinky({
    details: {
      'US-1': storyDetail('US-1', { workspace: '工具开发组' }),
      'US-2': storyDetail('US-2', { workspace: '平台开发组' }),
    },
  })
  const registry = createToolRegistry({
    client,
    config: CONFIG,
    linky,
    confirmations: new ConfirmationSigner(),
  })
  const result = await registry.call(TOOL_NAME, { story_codes: ['US-1', 'US-2'] })
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /没有创建任何评审/)
  assert.match(result.content[0].text, /WORKSPACE_MIXED/)
  assert.match(result.content[0].text, /共 2 条/)
  assert.equal(client.calls.length, 0)
})

test('超过上限时在 schema 层就拒，不进业务逻辑', async () => {
  const client = fakeClient()
  const registry = createToolRegistry({
    client,
    config: CONFIG,
    linky: fakeLinky(),
    confirmations: new ConfirmationSigner(),
  })
  const result = await registry.call(TOOL_NAME, {
    story_codes: Array.from({ length: MAX_STORIES_PER_SUBMIT + 1 }, (_, i) => `US-${i}`),
  })
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, new RegExp(`最多 ${MAX_STORIES_PER_SUBMIT} 项`))
  assert.equal(client.calls.length, 0)
})
