/**
 * 只读查询工具（V1.60）。
 *
 * 这几个工具存在的理由是一次真实事故：调用方的模型**看不到平台页面上的下拉框**，
 * 不知道有哪些项目组、代码基线只有三个值、时间窗口只能取 7/14/21/28，于是只能猜 ——
 * 使用者说「工具组」（真名「工具开发组」），批次建好了、回执说"已受理"，几十秒后全失败。
 *
 * 实测依据（2026-10-20，新域名 linky.kingdee.com）：
 *   · 按组列需求 page_size=200 → 1.05 秒，工具开发组共 275 条
 *   · 跨组列表 → 15.06 秒（所以查询工具一律要求指定项目组）
 *   · assignee_name 过滤有效：张烨 35 条、武晨曦 19 条，约 0.4 秒
 *   · 列表端点是唯一给出可读迭代/发布窗口/关联特性的地方（详情端点这几项是 null）
 */

import { strict as assert } from 'node:assert'
import test from 'node:test'

import {
  BRANCH_LABELS,
  DESCRIBE_OPTIONS_TOOL,
  LIST_WORKSPACES_TOOL,
  SEARCH_REQUIREMENTS_TOOL,
  filterRequirements,
  formatSubmitOptions,
  toRequirementRow,
} from '../src/query-tools.mjs'
import { LINKY_WORKSPACE_PRESETS, filterWorkspaces } from '../src/workspaces.mjs'
import { TOOL_NAME, createToolRegistry } from '../src/tools.mjs'
import { ConfirmationSigner } from '../src/confirm.mjs'
import { SUPPORTED_BRANCHES, SUPPORTED_COMMIT_WINDOWS } from '../src/config.mjs'

const CONFIG = {
  platform: { webUrl: 'https://review.example.com' },
  defaults: { modelLabel: 'glm5.3-flash', batchNamePrefix: 'MCP 评审', timeZone: 'Asia/Shanghai' },
}

/** 真实形状的列表项（字段取自 2026-10-20 实测响应）。 */
const LIST_ITEMS = [
  {
    id: '3707fd6f-3264-45cb-9299-a43d24e9a292',
    code: 'US-2026-017341',
    title: '【server】【技能】技能加载优化',
    status: '需求编写完成',
    assignee: '张烨',
    iteration: '202610-1（0928-1016）',
    release_window: 'R20261030',
    subject: '技能、智能体、工具功能优化 (FT-2026-001466)',
    workspace_id: '3bb2fffc-1b01-49a5-8e01-f1890d687894',
    workspace_name: '工具开发组',
  },
  {
    id: '0c867ada-08d2-4f08-9db7-b1c6f337da38',
    code: 'US-2026-042424',
    title: '【内置连接器】给前端增加 nacos 标识',
    status: '计划',
    assignee: '武晨曦',
    iteration: '202610-1（0928-1016）',
    release_window: 'R20261018',
    subject: null,
    workspace_name: '工具开发组',
  },
]

function linkyStub({ items = LIST_ITEMS, total = items.length, complete = true, error = null } = {}) {
  const calls = []
  return {
    calls,
    async listStories(options) {
      calls.push(options)
      if (error !== null) throw error
      return { items, total, pages: 1, complete }
    },
    async getStory() {
      return { code: 'US-2026-017341', workspace_name: '工具开发组', field_values: {} }
    },
    async probeHealth() {
      return { healthy: true, error: null }
    },
  }
}

function registry({ linky = linkyStub() } = {}) {
  const platformCalls = []
  return {
    linky,
    platformCalls,
    reg: createToolRegistry({
      client: {
        email: 'mcp@example.com',
        userId: 'u1',
        async rpc(name) {
          platformCalls.push(name)
          return []
        },
        async insert(table, row) {
          platformCalls.push(`insert:${table}`)
          return { id: 'b1', name: row.name, week_code: row.week_code }
        },
      },
      config: CONFIG,
      linky,
      confirmations: new ConfirmationSigner(),
    }),
  }
}

// ---------------------------------------------------------------- 项目组清单

test('项目组模糊匹配：「工具组」要把真名「工具开发组」排在最前', () => {
  const hits = filterWorkspaces('工具组')
  assert.equal(hits[0], '工具开发组', '这正是那次事故需要的能力')
  assert.ok(hits.length < LINKY_WORKSPACE_PRESETS.length, '应该是筛选而不是全量返回')
})

test('项目组模糊匹配支持子串与英文', () => {
  assert.deepEqual(filterWorkspaces('工具'), ['工具开发组'])
  assert.deepEqual(filterWorkspaces('前端'), ['前端开发组'])
  assert.deepEqual(filterWorkspaces('quality'), ['灵基质量执行平台quality-platform'])
  assert.deepEqual(filterWorkspaces('QUALITY'), ['灵基质量执行平台quality-platform'], '不区分大小写')
})

test('关键字为空时返回全部；完全不相关时返回空', () => {
  assert.equal(filterWorkspaces('').length, LINKY_WORKSPACE_PRESETS.length)
  assert.deepEqual(filterWorkspaces('zzzzzz'), [])
})

test('清单是冻结的，调用方拿不到可变引用', () => {
  assert.throws(() => {
    LINKY_WORKSPACE_PRESETS.push('伪造组')
  })
  // filterWorkspaces 返回副本，改它不该污染原清单。
  const copy = filterWorkspaces('')
  copy.push('伪造组')
  assert.equal(LINKY_WORKSPACE_PRESETS.includes('伪造组'), false)
})

test('list_workspaces 只读：不碰平台、不碰上游', async () => {
  const { reg, linky, platformCalls } = registry()
  const result = await reg.call(LIST_WORKSPACES_TOOL, { keyword: '工具组' }, { caller: 'alice' })
  assert.equal(result.isError, false ?? false)
  assert.match(result.content[0].text, /工具开发组/)
  assert.match(result.content[0].text, /精确匹配/)
  assert.equal(platformCalls.length, 0)
  assert.equal(linky.calls.length, 0, '项目组清单是本地的，不需要请求上游')
})

test('list_workspaces 没命中时回全量清单，并说明清单外也能用', async () => {
  const { reg } = registry()
  const result = await reg.call(LIST_WORKSPACES_TOOL, { keyword: 'zzzzzz' })
  assert.match(result.content[0].text, /没有项目组匹配/)
  assert.match(result.content[0].text, /灵基Foundation/, '要把全量清单给出来')
  assert.match(result.content[0].text, /即使不在上面这份清单里也可以直接使用/)
})

// ---------------------------------------------------------------- 需求列表

test('search_requirements 必须指定项目组（跨组查询实测 15 秒）', async () => {
  const { reg } = registry()
  const result = await reg.call(SEARCH_REQUIREMENTS_TOOL, {})
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /workspace_name/)
})

test('search_requirements 返回编号、标题与列表端点独有的迭代/发布窗口', async () => {
  const { reg, linky } = registry()
  const result = await reg.call(SEARCH_REQUIREMENTS_TOOL, { workspace_name: '工具开发组' })
  const text = result.content[0].text
  assert.match(text, /US-2026-017341/)
  assert.match(text, /【server】【技能】技能加载优化/)
  assert.match(text, /迭代 202610-1（0928-1016）/)
  assert.match(text, /发布窗口 R20261030/)
  assert.match(text, /关联特性 技能、智能体、工具功能优化/)
  assert.match(text, /start_requirement_review/, '要告诉模型下一步做什么')
  assert.equal(linky.calls[0].workspaceName, '工具开发组')
})

test('search_requirements 的关键字按编号或标题子串过滤', () => {
  const rows = LIST_ITEMS.map(toRequirementRow)
  assert.equal(filterRequirements(rows, '技能').length, 1)
  assert.equal(filterRequirements(rows, '017341').length, 1, '编号也要能匹配')
  assert.equal(filterRequirements(rows, 'NACOS').length, 1, '不区分大小写')
  assert.equal(filterRequirements(rows, '').length, 2)
  assert.equal(filterRequirements(rows, '不存在的词').length, 0)
})

test('search_requirements 截断时如实说还有多少条', async () => {
  const many = Array.from({ length: 40 }, (_item, index) => ({
    code: `US-2026-00${String(index).padStart(4, '0')}`,
    title: `需求 ${index}`,
    status: '计划',
  }))
  const { reg } = registry({ linky: linkyStub({ items: many, total: 40 }) })
  const result = await reg.call(SEARCH_REQUIREMENTS_TOOL, { workspace_name: '工具开发组', limit: 5 })
  assert.match(result.content[0].text, /共 40 条需求，下面列出前 5 条/)
  assert.match(result.content[0].text, /还有 35 条未显示/)
})

test('没翻完全部分页时必须声明"没找到不等于不存在"', async () => {
  const { reg } = registry({ linky: linkyStub({ items: LIST_ITEMS, total: 999, complete: false }) })
  const result = await reg.call(SEARCH_REQUIREMENTS_TOOL, { workspace_name: '工具开发组' })
  assert.match(result.content[0].text, /没有翻完全部分页/)
  assert.match(result.content[0].text, /不等于"不存在"/)
})

test('项目组查不到任何需求时，提示可能是名字不完整', async () => {
  const { reg } = registry({ linky: linkyStub({ items: [], total: 0 }) })
  const result = await reg.call(SEARCH_REQUIREMENTS_TOOL, { workspace_name: '工具组' })
  assert.match(result.content[0].text, /名称可能不完全一致/)
  assert.match(result.content[0].text, /list_workspaces/)
})

test('上游凭据失效时说清"不是你的网络问题、该找谁"', async () => {
  const error = Object.assign(new Error('Linky 取数接口拒绝了平台侧凭据'), {
    code: 'LINKY_UPSTREAM_AUTH_FAILED',
  })
  const { reg } = registry({ linky: linkyStub({ error }) })
  const result = await reg.call(SEARCH_REQUIREMENTS_TOOL, { workspace_name: '工具开发组' })
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /不是你的网络问题/)
  assert.match(result.content[0].text, /配置 › Linky 工作区/)
})

test('limit 超出 schema 范围时被门禁拦住（不是悄悄截断）', async () => {
  const { reg } = registry()
  const result = await reg.call(SEARCH_REQUIREMENTS_TOOL, {
    workspace_name: '工具开发组',
    limit: 500,
  })
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /limit/)
})

// ---------------------------------------------------------------- 参数说明

test('describe_submit_options 列出三个代码基线及人话含义', async () => {
  const { reg, platformCalls } = registry()
  const result = await reg.call(DESCRIBE_OPTIONS_TOOL, {})
  const text = result.content[0].text
  for (const branch of SUPPORTED_BRANCHES) {
    assert.match(text, new RegExp(branch), `缺少 ${branch}`)
    assert.match(text, new RegExp(BRANCH_LABELS[branch].slice(0, 4)), `缺少 ${branch} 的说明`)
  }
  assert.match(text, new RegExp(SUPPORTED_COMMIT_WINDOWS.join(' / ')))
  assert.equal(platformCalls.length, 0, '纯本地信息，不该调平台')
})

test('describe_submit_options 给出发布周期格式、默认值与年份范围', () => {
  const text = formatSubmitOptions({ modelLabel: 'glm5.3-flash', timeZone: 'Asia/Shanghai' })
  assert.match(text, /8 位 YYYYMMDD/)
  assert.match(text, /默认当天（\d{8}）/)
  assert.match(text, /年份需在 \d{4} ~ \d{4} 之间/)
})

test('describe_submit_options 必须写明模型由服务端决定、调用方不能指定', () => {
  const text = formatSubmitOptions({ modelLabel: 'glm5.3-flash' })
  assert.match(text, /glm5\.3-flash/)
  assert.match(text, /调用方不能指定/)
})

test('服务端没配默认模型时不编一个出来', () => {
  const text = formatSubmitOptions({ modelLabel: null })
  assert.match(text, /服务端未指定/)
})

// ---------------------------------------------------------------- 工具清单

test('工具清单：3 个查询 + 1 个核对 + 1 个提交，只有提交不是只读', () => {
  const { reg } = registry()
  assert.equal(reg.definitions.length, 5)
  const readOnly = reg.definitions.filter((tool) => tool.annotations.readOnlyHint === true)
  assert.equal(readOnly.length, 4)
  const submit = reg.definitions.find((tool) => tool.name === TOOL_NAME)
  assert.equal(submit.annotations.readOnlyHint, false)
  // 顺序是给模型看的：先"怎么查"，最后才是唯一会花钱的那个。
  assert.equal(reg.definitions[reg.definitions.length - 1].name, TOOL_NAME)
})

test('三个查询工具都不需要确认令牌，也不会建批次', async () => {
  const { reg, platformCalls } = registry()
  await reg.call(LIST_WORKSPACES_TOOL, {})
  await reg.call(SEARCH_REQUIREMENTS_TOOL, { workspace_name: '工具开发组' })
  await reg.call(DESCRIBE_OPTIONS_TOOL, {})
  assert.equal(
    platformCalls.filter((call) => call.startsWith('insert')).length,
    0,
    '只读工具绝不该在平台上建任何东西',
  )
})
