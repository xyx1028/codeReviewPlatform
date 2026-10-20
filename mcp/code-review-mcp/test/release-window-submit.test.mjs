/**
 * 按发布窗口批量评审（V1.68）。
 *
 * 这一组盯住的是"替使用者枚举要花钱的那批需求"里最容易出事的地方：
 *
 *   · 枚举出来的东西必须**逐条列给使用者看**，并且条数要和"这个窗口有多少条"一致；
 *   · 枚举不出来（取不到数、没翻完整组）时必须**拒绝**，不能降级成"未核对照常提交"——
 *     编号本身就来自这次枚举，枚举不成就没有可提交的东西；
 *   · 令牌锁定的是**枚举出来的那一组编号**，不是"这个窗口"这个条件（Linky 是实时的）；
 *   · 卡片不许印出它没有核对过的东西（正文字数、附件数、三类负责人）。
 */

import { strict as assert } from 'node:assert'
import test from 'node:test'

import { buildBatchName, submitRequirementReview } from '../src/review.mjs'
import {
  PREFLIGHT_LISTED,
  PREFLIGHT_REJECTED,
  preflightReleaseWindow,
} from '../src/preflight.mjs'
import { ConfirmationError, ConfirmationSigner } from '../src/confirm.mjs'
import { TOOL_NAME, createToolRegistry } from '../src/tools.mjs'
import { MAX_STORIES_PER_WINDOW } from '../src/config.mjs'
import { SEARCH_MAX_PAGES } from '../src/query-tools.mjs'

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

const WINDOWS = ['R20261106', 'R20261030', null]

function listItem(index) {
  return {
    id: `issue-${index}`,
    code: `US-2026-0424${String(index).padStart(2, '0')}`,
    title: `【console】需求 ${index}`,
    status: '需求编写完成',
    assignee: index % 2 === 0 ? '何翃楚' : '张烨',
    iteration: '202610-1（0928-1016）',
    release_window: WINDOWS[index % WINDOWS.length],
    subject: null,
    workspace_name: '工具开发组',
  }
}

const ITEMS = Array.from({ length: 9 }, (_item, index) => listItem(index))

/** 假 Linky：只提供列表端点；`getStory` 一被调用就让测试失败（窗口模式不该逐条查详情）。 */
function fakeLinky({ items = ITEMS, total = null, complete = true, error = null } = {}) {
  const calls = { listStories: [], getStory: [] }
  return {
    calls,
    async listStories(options) {
      calls.listStories.push(options)
      if (error !== null) throw error
      return { items, total: total ?? items.length, pages: 1, complete }
    },
    async getStory(code) {
      calls.getStory.push(code)
      throw new Error('按发布窗口提交不该逐条打开需求详情')
    },
    async probeHealth() {
      return { healthy: true, error: null }
    },
  }
}

function fakeClient() {
  const calls = []
  return {
    calls,
    email: 'mcp@example.com',
    userId: 'user-1',
    async rpc(name, args) {
      calls.push({ kind: 'rpc', name, args })
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

function makeRegistry({ linky = fakeLinky(), client = fakeClient() } = {}) {
  return {
    linky,
    client,
    reg: createToolRegistry({
      client,
      config: CONFIG,
      linky,
      confirmations: new ConfirmationSigner({ secret: 'z'.repeat(32) }),
    }),
  }
}

function tokenOf(text) {
  return /confirmation_token:\s*(\S+)/.exec(text)?.[1]
}

// ------------------------------------------------------------------ 枚举本身

test('枚举：只回该窗口的需求，字段取自列表项', async () => {
  const linky = fakeLinky()
  const outcome = await preflightReleaseWindow(linky, {
    workspace_name: '工具开发组',
    release_window: 'R20261106',
  })
  assert.equal(outcome.status, PREFLIGHT_LISTED)
  assert.deepEqual(
    outcome.entries.map((entry) => entry.story_code),
    ['US-2026-042400', 'US-2026-042403', 'US-2026-042406'],
  )
  assert.equal(outcome.entries[0].story.title, '【console】需求 0')
  assert.equal(outcome.entries[0].story.iteration, '202610-1（0928-1016）')
  assert.equal(outcome.entries[0].story.workspace_name, '工具开发组')
  assert.equal(linky.calls.getStory.length, 0, '不该逐条打开详情')
})

test('枚举：窗口匹配忽略首尾空白与大小写', async () => {
  const outcome = await preflightReleaseWindow(fakeLinky(), {
    workspace_name: '工具开发组',
    release_window: ' r20261106 ',
  })
  assert.equal(outcome.status, PREFLIGHT_LISTED)
  assert.equal(outcome.entries.length, 3)
})

test('枚举：窗口不存在时拒绝，并带上该组真实的窗口分布', async () => {
  const outcome = await preflightReleaseWindow(fakeLinky(), {
    workspace_name: '工具开发组',
    release_window: 'R20261201',
  })
  assert.equal(outcome.status, PREFLIGHT_REJECTED)
  assert.equal(outcome.reason.code, 'RELEASE_WINDOW_NOT_FOUND')
  assert.deepEqual(outcome.facet.windows, [
    { window: 'R20261106', count: 3 },
    { window: 'R20261030', count: 3 },
  ])
  assert.equal(outcome.facet.missing, 3)
})

test('枚举：缺项目组、取不到数、没翻完整组都拒绝（不降级成"未核对"）', async () => {
  const noWorkspace = await preflightReleaseWindow(fakeLinky(), {
    workspace_name: null,
    release_window: 'R20261106',
  })
  assert.equal(noWorkspace.status, PREFLIGHT_REJECTED)
  assert.equal(noWorkspace.reason.code, 'WORKSPACE_NAME_REQUIRED')

  // 没配 Linky：按编号提交可以标成"未核对"照常提交，按窗口提交不行 ——
  // 编号本身来自枚举，枚举不出来就没有可提交的需求。
  const disabled = await preflightReleaseWindow(null, {
    workspace_name: '工具开发组',
    release_window: 'R20261106',
  })
  assert.equal(disabled.status, PREFLIGHT_REJECTED)
  assert.equal(disabled.reason.code, 'PREFLIGHT_DISABLED')

  const unreachable = await preflightReleaseWindow(
    fakeLinky({ error: Object.assign(new Error('连不上'), { code: 'LINKY_UNREACHABLE' }) }),
    { workspace_name: '工具开发组', release_window: 'R20261106' },
  )
  assert.equal(unreachable.status, PREFLIGHT_REJECTED)
  assert.equal(unreachable.reason.code, 'LINKY_UNREACHABLE')

  // 没翻完整组时"这个窗口有几条"不可信，而那正是要确认的东西。
  const partial = await preflightReleaseWindow(
    fakeLinky({ total: 2000, complete: false }),
    { workspace_name: '工具开发组', release_window: 'R20261106' },
  )
  assert.equal(partial.status, PREFLIGHT_REJECTED)
  assert.equal(partial.reason.code, 'WORKSPACE_LIST_INCOMPLETE')
  assert.match(partial.reason.message, /2000 条/)
})

// ------------------------------------------------------------------ 批次命名

test('批次名按窗口写：窗口 + 条数（30 多个编号在列表那一列里放不下）', () => {
  assert.equal(
    buildBatchName('MCP 评审', ['US-1', 'US-2', 'US-3'], { releaseWindow: 'R20261106' }),
    'MCP 评审：R20261106 共 3 条需求',
  )
  // 不给窗口时沿用 V1.66 的形态。
  assert.equal(buildBatchName('MCP 评审', ['US-1', 'US-2']), 'MCP 评审：US-1、US-2')
})

// ------------------------------------------------------------------ 端到端

test('两步提交：卡片列出窗口下全部需求，第二次只带令牌即可落库', async () => {
  const { reg, client, linky } = makeRegistry()

  const first = await reg.call(TOOL_NAME, {
    workspace_name: '工具开发组',
    release_window: 'R20261106',
  })
  assert.equal(first.isError, false)
  const card = first.content[0].text
  assert.match(card, /还没有提交/)
  assert.match(card, /发布窗口 R20261106 下共 \*\*3 条\*\*需求/)
  assert.match(card, /1\. US-2026-042400/)
  assert.match(card, /2\. US-2026-042403/)
  assert.match(card, /3\. US-2026-042406/)
  assert.match(card, /发布窗口（筛选条件）：R20261106 —— 该窗口下全部 3 条需求/)
  assert.match(card, /这次是 3 条需求的量/)
  assert.match(card, /只需要带 confirmation_token/)
  // 不许印出没核对过的东西。
  assert.ok(!card.includes('需求正文：'), '没打开详情就不该显示正文字数')
  assert.ok(!card.includes('附件：'), '没打开详情就不该显示附件数')
  assert.ok(!card.includes('开发负责人'), '列表端点给不出三类负责人')
  assert.match(card, /没有逐条打开需求详情/)
  assert.equal(client.calls.length, 0, '第一步不许碰平台')
  assert.equal(linky.calls.listStories.length, 1)
  assert.equal(linky.calls.listStories[0].maxPages, SEARCH_MAX_PAGES)

  // 第二步：只带令牌，不回传编号、不回传窗口。
  const second = await reg.call(
    TOOL_NAME,
    { confirmation_token: tokenOf(card) },
    { caller: 'alice' },
  )
  assert.equal(second.isError, false)
  const receipt = second.content[0].text
  assert.match(receipt, /已成功受理/)
  assert.match(receipt, /发布窗口：R20261106（提交的是确认时该窗口下的全部 3 条需求）/)
  assert.match(receipt, /需求（3 条，同一个批次）/)
  assert.match(receipt, /核对方式：这些需求来自该项目组的需求列表/)

  const inserts = client.calls.filter((call) => call.kind === 'insert')
  const imports = client.calls.filter(
    (call) => call.name === 'request_linky_batch_import_for_analysis',
  )
  assert.equal(inserts.length, 1, '一次调用只建一个批次')
  assert.equal(inserts[0].row.name, 'MCP 评审：R20261106 共 3 条需求')
  assert.deepEqual(imports[0].args.p_story_codes, [
    'US-2026-042400',
    'US-2026-042403',
    'US-2026-042406',
  ])
  assert.equal(imports[0].args.p_release_window, 'R20261106')
  // 第二步不该再枚举：Linky 是实时的，重新枚举可能提交一份没人确认过的集合。
  assert.equal(linky.calls.listStories.length, 1, '确认后不许重新枚举')
})

test('第二次调用回传编号也可以，但集合必须和确认过的一致', async () => {
  const { reg } = makeRegistry()
  const card = (
    await reg.call(TOOL_NAME, { workspace_name: '工具开发组', release_window: 'R20261106' })
  ).content[0].text
  const token = tokenOf(card)

  const ok = await reg.call(TOOL_NAME, {
    confirmation_token: token,
    story_codes: ['US-2026-042406', 'US-2026-042400', 'US-2026-042403'],
  })
  assert.equal(ok.isError, false, '顺序不同不算改')

  const tampered = await reg.call(TOOL_NAME, {
    confirmation_token: token,
    story_codes: ['US-2026-042400'],
  })
  assert.equal(tampered.isError, true)
  assert.match(tampered.content[0].text, /没有创建任何评审/)
  assert.match(tampered.content[0].text, /需求条数/)
})

test('令牌绑定窗口：回传另一个窗口要重新确认', () => {
  const signer = new ConfirmationSigner({ secret: 'y'.repeat(32) })
  const token = signer.issue({
    story_codes: ['US-1'],
    workspace_name: '工具开发组',
    release_window: 'R20261106',
    branch: 'release',
    commit_window_days: 14,
    verification: 'LISTED',
  })
  const base = { workspace_name: '工具开发组', branch: 'release', commit_window_days: 14 }
  assert.equal(signer.verify(token, base).release_window, 'R20261106', '没回传窗口时不比对')
  assert.equal(signer.verify(token, { ...base, release_window: 'R20261106' }).verification, 'LISTED')
  assert.throws(
    () => signer.verify(token, { ...base, release_window: 'R20261030' }),
    /发布窗口/,
  )
  assert.throws(
    () => signer.verify(token, { ...base, release_window: 'R20261030' }),
    ConfirmationError,
  )
})

test('窗口写错：拒绝提交，并把这个组真实的窗口和条数列出来', async () => {
  const { reg, client } = makeRegistry()
  const result = await reg.call(TOOL_NAME, {
    workspace_name: '工具开发组',
    release_window: 'R20261201',
  })
  assert.equal(result.isError, true)
  const text = result.content[0].text
  assert.match(text, /没有创建任何评审/)
  assert.match(text, /RELEASE_WINDOW_NOT_FOUND/)
  assert.match(text, /R20261106（3 条）/)
  assert.match(text, /R20261030（3 条）/)
  assert.match(text, /3 条需求没有填发布窗口/)
  assert.match(text, /发布窗口 R20261201/)
  assert.equal(client.calls.length, 0)
})

test('窗口里需求太多：拒绝，不悄悄只提交前 N 条', async () => {
  const many = Array.from({ length: MAX_STORIES_PER_WINDOW + 3 }, (_item, index) => ({
    ...listItem(index),
    code: `US-2026-05${String(index).padStart(3, '0')}`,
    release_window: 'R20261106',
  }))
  const { reg, client } = makeRegistry({ linky: fakeLinky({ items: many }) })
  const result = await reg.call(TOOL_NAME, {
    workspace_name: '工具开发组',
    release_window: 'R20261106',
  })
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /RELEASE_WINDOW_TOO_MANY_STORIES/)
  assert.match(result.content[0].text, new RegExp(`有 ${MAX_STORIES_PER_WINDOW + 3} 条需求`))
  assert.match(result.content[0].text, /原始需求导入/)
  assert.equal(client.calls.length, 0)
})

test('同时给窗口和编号：拒绝，不猜是交集还是并集', async () => {
  const { reg, client, linky } = makeRegistry()
  const result = await reg.call(TOOL_NAME, {
    workspace_name: '工具开发组',
    release_window: 'R20261106',
    story_codes: ['US-2026-042400'],
  })
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /STORY_CODES_AND_WINDOW_CONFLICT/)
  assert.equal(linky.calls.listStories.length, 0, '参数矛盾时连上游都不该碰')
  assert.equal(client.calls.length, 0)
})

test('按窗口提交缺项目组：拒绝并指向 list_workspaces', async () => {
  const { reg, client } = makeRegistry()
  const result = await reg.call(TOOL_NAME, { release_window: 'R20261106' })
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /WORKSPACE_NAME_REQUIRED/)
  assert.match(result.content[0].text, /list_workspaces/)
  assert.equal(client.calls.length, 0)
})

test('窗口里只有一条时也能提交，回执用单条形态', async () => {
  const single = [{ ...listItem(1), release_window: 'R20261015' }]
  const { reg, client } = makeRegistry({ linky: fakeLinky({ items: single }) })
  const card = (
    await reg.call(TOOL_NAME, { workspace_name: '工具开发组', release_window: 'R20261015' })
  ).content[0].text
  const receipt = (await reg.call(TOOL_NAME, { confirmation_token: tokenOf(card) })).content[0].text
  assert.match(receipt, /需求编号：US-2026-042401/)
  assert.match(receipt, /发布窗口：R20261015/)
  assert.equal(
    client.calls.filter((call) => call.kind === 'insert')[0].row.name,
    'MCP 评审：R20261015 共 1 条需求',
  )
})

test('工具定义：release_window 对外可见且写明用法', async () => {
  const { reg } = makeRegistry()
  const submit = reg.definitions.find((tool) => tool.name === TOOL_NAME)
  assert.equal(submit.inputSchema.properties.release_window.type, 'string')
  assert.match(submit.inputSchema.properties.release_window.description, /全部需求/)
  assert.match(submit.inputSchema.properties.release_window.description, /workspace_name \*\*必填\*\*/)
  assert.match(submit.description, /release_window/)
  assert.equal(submit.annotations.readOnlyHint, false, '它仍然会花钱')
})

// ------------------------------------------------------------------ 直接提交

test('submitRequirementReview：窗口只记录、不参与筛选', async () => {
  const client = fakeClient()
  const receipt = await submitRequirementReview(client, CONFIG, {
    story_codes: ['US-1', 'US-2'],
    workspace_name: '工具开发组',
    release_window: 'R20261106',
    branch: 'release',
    commit_window_days: 14,
  })
  assert.equal(receipt.release_window, 'R20261106')
  const importCall = client.calls.find(
    (call) => call.name === 'request_linky_batch_import_for_analysis',
  )
  assert.equal(importCall.args.p_release_window, 'R20261106')
  assert.deepEqual(importCall.args.p_story_codes, ['US-1', 'US-2'])
})
