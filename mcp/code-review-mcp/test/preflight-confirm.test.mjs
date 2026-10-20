/**
 * 提交前校验与确认门禁（V1.56）。
 *
 * 这一组盯的是一个真实事故：使用者把项目组说成「工具组」（真名「工具开发组」），
 * MCP 照常受理、建了批次、回了"✅ 已成功受理"，几十秒后 Worker 整单失败。
 * 所以这里的每条断言都在问同一个问题 —— **在真的建批次之前，平台有没有把话说准。**
 *
 * 上游事实（2026-10-19 实测，V1.56 方案 §10.1）：
 *   · 不存在的工作区返回 200 + 空列表，**不报错**；
 *   · 工作区存在但凭据失效返回 400 {"detail":"Linky 返回错误（401）：invalid token"}；
 *   · 详情端点不带 config_id 会遍历所有启用工作区，并回可读的 workspace_name。
 */

import { strict as assert } from 'node:assert'
import test from 'node:test'

import {
  PREFLIGHT_REJECTED,
  PREFLIGHT_UNVERIFIED,
  PREFLIGHT_VERIFIED,
  describeStory,
  preflightRequirement,
} from '../src/preflight.mjs'
import { ConfirmationError, ConfirmationSigner } from '../src/confirm.mjs'
import { LinkyLookupError, extractDetail, isUpstreamAuthFailure } from '../src/linky.mjs'
import { TOOL_NAME, LOOKUP_TOOL_NAME, createToolRegistry } from '../src/tools.mjs'

const CONFIG = {
  platform: { webUrl: 'https://review.example.com' },
  defaults: { modelLabel: 'kimi-k3', batchNamePrefix: 'MCP 评审', timeZone: 'Asia/Shanghai', branch: 'release', commitWindowDays: 14 },
}

/** 一条真实形状的详情响应（字段名取自 /stories/help 与 worker mapping.ts）。 */
const STORY_DETAIL = {
  id: '11111111-1111-4111-8111-111111111111',
  code: 'US-2026-017341',
  title: 'MCP 提交评审时校验需求',
  workspace_id: '22222222-2222-4222-8222-222222222222',
  workspace_name: '工具开发组',
  status_label: '开发中',
  iteration: '202610-3（1013-1017）',
  release_window: 'R20261017',
  subject: '【MCP】能力增强与体验优化',
  description: '',
  field_values: { gf_description: '验收标准：提交前必须核对项目组。'.repeat(3) },
  attachments: [{ id: 'att-1', filename: 'prd.docx' }],
  team: {
    req: [{ id: 'u1', name: '张三' }],
    dev: [{ id: 'u2', name: '李四' }],
    test: [{ id: 'u3', name: '王五' }],
  },
  team_resolve_error: null,
}

function linkyStub({ story = STORY_DETAIL, error = null, healthy = true } = {}) {
  return {
    async getStory() {
      if (error !== null) throw error
      return story
    },
    // 只在"按编号查不到"的那条路径上被调用，用来判断那个 404 可不可信。
    async probeHealth() {
      return healthy
        ? { healthy: true, error: null }
        : {
            healthy: false,
            error: new LinkyLookupError(
              'Linky 取数接口拒绝了平台侧凭据（HTTP 400：invalid token）',
              { code: 'LINKY_UPSTREAM_AUTH_FAILED', unverifiable: true },
            ),
          }
    },
  }
}

function platformStub() {
  const calls = []
  return {
    calls,
    email: 'mcp@example.com',
    userId: 'user-1',
    async rpc(name) {
      calls.push({ kind: 'rpc', name })
      if (name === 'list_enabled_model_configs') {
        return [{ id: 'model-1', display_name: 'kimi-k3', has_api_key: true }]
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

const SUBMIT_ARGS = {
  story_code: 'US-2026-017341',
  branch: 'feature_dev',
  commit_window_days: 7,
}

function inserted(client) {
  return client.calls.some((call) => call.kind === 'insert')
}

// ---------------------------------------------------------------- 上游响应解析

test('上游错误响应的 detail 必须保留：那才是可操作的那句话', () => {
  assert.equal(
    extractDetail('{"detail":"Linky 返回错误（401）：invalid token"}'),
    'Linky 返回错误（401）：invalid token',
  )
  assert.equal(extractDetail('{"detail":"未找到用户故事: US-2026-017341"}'), '未找到用户故事: US-2026-017341')
  // 不是 JSON（网关 HTML）时截一段原文，同样比"HTTP 400"有用。
  assert.match(extractDetail('<html><body>502 Bad Gateway</body></html>'), /502 Bad Gateway/)
  assert.equal(extractDetail(''), null)
})

test('凭据失效要和普通 4xx 分开：处置完全不同', () => {
  // 实测形态：外层 400，内层写明 401 invalid token。
  assert.equal(isUpstreamAuthFailure(400, 'Linky 返回错误（401）：invalid token'), true)
  assert.equal(isUpstreamAuthFailure(401, null), true)
  assert.equal(isUpstreamAuthFailure(400, '编号为空'), false)
  assert.equal(isUpstreamAuthFailure(404, '未找到用户故事'), false)
  assert.equal(isUpstreamAuthFailure(500, 'boom'), false)
})

test('详情响应 → 确认卡片字段：正文只报字数，不回正文内容', () => {
  const story = describeStory(STORY_DETAIL)
  assert.equal(story.story_code, 'US-2026-017341')
  assert.equal(story.workspace_name, '工具开发组')
  assert.equal(story.status_label, '开发中')
  assert.equal(story.release_window, 'R20261017')
  assert.equal(story.attachment_count, 1)
  assert.deepEqual(story.dev_owners, ['李四'])
  assert.ok(story.body_chars > 0)
  // 评审用的正文只能由 Worker 在内网取；这里不许把正文本身带出来。
  assert.equal('body' in story, false)
  assert.equal('requirement_detail' in story, false)
})

// ---------------------------------------------------------------- 校验结论

test('只给需求编号就能反查出真实项目组', async () => {
  const outcome = await preflightRequirement(linkyStub(), { story_code: 'US-2026-017341' })
  assert.equal(outcome.status, PREFLIGHT_VERIFIED)
  assert.equal(outcome.resolved.workspace_name, '工具开发组')
  const note = outcome.corrections.find((item) => item.field === 'workspace_name')
  assert.match(note.note, /反查/)
})

test('项目组给错时明确写出"你给的"与"实际是"，并按实际值提交', async () => {
  const outcome = await preflightRequirement(linkyStub(), {
    story_code: 'US-2026-017341',
    workspace_name: '工具组',
  })
  assert.equal(outcome.status, PREFLIGHT_VERIFIED)
  const correction = outcome.corrections.find((item) => item.field === 'workspace_name')
  assert.equal(correction.given, '工具组')
  assert.equal(correction.resolved, '工具开发组')
  assert.equal(outcome.resolved.workspace_name, '工具开发组')
})

test('项目组本来就对时不产生无意义的"更正"噪音', async () => {
  const outcome = await preflightRequirement(linkyStub(), {
    story_code: 'US-2026-017341',
    workspace_name: '工具开发组',
  })
  assert.equal(outcome.status, PREFLIGHT_VERIFIED)
  assert.equal(outcome.corrections.length, 0)
})

test('需求编号不存在 = 确定的坏参数，结论必须是拒绝', async () => {
  const outcome = await preflightRequirement(
    linkyStub({
      error: new LinkyLookupError('未找到用户故事: US-2026-017341', {
        code: 'LINKY_STORY_NOT_FOUND',
        status: 404,
      }),
      healthy: true,
    }),
    { story_code: 'US-2026-017341' },
  )
  assert.equal(outcome.status, PREFLIGHT_REJECTED)
  assert.equal(outcome.reason.code, 'STORY_NOT_FOUND')
  assert.match(outcome.reason.message, /遍历全部启用的工作区/)
})

test('上游本身不正常时，"查不到"不可信 —— 不许把真实需求判成不存在', async () => {
  // 这条是前一条的反面，也是更危险的那一面：上游凭据失效时按编号查询可能回 404，
  // 此刻拒绝提交等于告诉使用者"你的编号写错了"，而他的编号是对的。
  const outcome = await preflightRequirement(
    linkyStub({
      error: new LinkyLookupError('未找到用户故事: US-2026-017341', {
        code: 'LINKY_STORY_NOT_FOUND',
        status: 404,
      }),
      healthy: false,
    }),
    { story_code: 'US-2026-017341' },
  )
  assert.notEqual(outcome.status, PREFLIGHT_REJECTED)
  assert.equal(outcome.status, PREFLIGHT_UNVERIFIED)
  assert.match(outcome.reason.message, /并不可信/)
  assert.match(outcome.reason.message, /配置 › Linky 工作区/)
})

test('上游凭据失效 = 校验做不到，不是坏参数；并且要说清找谁', async () => {
  const outcome = await preflightRequirement(
    linkyStub({
      error: new LinkyLookupError('Linky 取数接口拒绝了平台侧凭据（HTTP 400：invalid token）', {
        code: 'LINKY_UPSTREAM_AUTH_FAILED',
        status: 400,
        unverifiable: true,
      }),
    }),
    { story_code: 'US-2026-017341' },
  )
  assert.equal(outcome.status, PREFLIGHT_UNVERIFIED)
  assert.match(outcome.reason.message, /不是你的网络问题/)
  assert.match(outcome.reason.message, /配置 › Linky 工作区/)
  assert.match(outcome.reason.message, /现在提交的话，平台侧取需求同样会失败/)
})

test('MCP 不在内网（连不上）时不阻断，但如实标成未校验', async () => {
  const outcome = await preflightRequirement(
    linkyStub({ error: new LinkyLookupError('连不上', { code: 'LINKY_UNREACHABLE', unverifiable: true }) }),
    { story_code: 'US-2026-017341' },
  )
  assert.equal(outcome.status, PREFLIGHT_UNVERIFIED)
  assert.match(outcome.reason.message, /无法核对/)
})

test('服务端没配 Linky 地址时校验整体关闭，且不假装查过', async () => {
  const outcome = await preflightRequirement(null, { story_code: 'US-2026-017341' })
  assert.equal(outcome.status, PREFLIGHT_UNVERIFIED)
  assert.equal(outcome.reason.code, 'PREFLIGHT_DISABLED')
})

test('正文与附件都空时提醒结论会弱，但不拦（V1.20 起不设内容门禁）', async () => {
  const outcome = await preflightRequirement(
    linkyStub({
      story: { ...STORY_DETAIL, field_values: {}, description: '', attachments: [] },
    }),
    { story_code: 'US-2026-017341', workspace_name: '工具开发组' },
  )
  assert.equal(outcome.status, PREFLIGHT_VERIFIED)
  const note = outcome.corrections.find((item) => item.field === 'requirement_content')
  assert.match(note.note, /结论会很弱/)
})

// ---------------------------------------------------------------- 确认令牌

test('令牌与四个关键参数绑定：改任何一个都失效', () => {
  const signer = new ConfirmationSigner()
  const base = {
    story_code: 'US-1',
    workspace_name: '工具开发组',
    branch: 'feature_dev',
    commit_window_days: 7,
    verification: 'VERIFIED',
  }
  const token = signer.issue(base)
  assert.doesNotThrow(() => signer.verify(token, base))

  for (const [field, value] of [
    ['story_code', 'US-2'],
    ['workspace_name', '工具组'],
    ['branch', 'release'],
    ['commit_window_days', 21],
  ]) {
    assert.throws(
      () => signer.verify(token, { ...base, [field]: value }),
      (error) => {
        assert.ok(error instanceof ConfirmationError)
        assert.equal(error.code, 'CONFIRMATION_PARAM_MISMATCH')
        return true
      },
      `改了 ${field} 之后令牌必须失效`,
    )
  }
})

test('令牌会过期：十分钟前的确认不代表现在的事实', () => {
  let clock = 1_000_000
  const signer = new ConfirmationSigner({ ttlMs: 60_000, now: () => clock })
  const claim = {
    story_code: 'US-1',
    workspace_name: 'w',
    branch: 'release',
    commit_window_days: 14,
    verification: 'VERIFIED',
  }
  const token = signer.issue(claim)
  clock += 61_000
  assert.throws(
    () => signer.verify(token, claim),
    (error) => error instanceof ConfirmationError && error.code === 'CONFIRMATION_EXPIRED',
  )
})

test('别人签的令牌不认（换了密钥/换了实例）', () => {
  const claim = {
    story_code: 'US-1',
    workspace_name: 'w',
    branch: 'release',
    commit_window_days: 14,
    verification: 'VERIFIED',
  }
  const token = new ConfirmationSigner({ secret: 'secret-a' }).issue(claim)
  assert.throws(
    () => new ConfirmationSigner({ secret: 'secret-b' }).verify(token, claim),
    (error) => error instanceof ConfirmationError && error.code === 'CONFIRMATION_INVALID',
  )
})

test('伪造/残缺的令牌一律拒绝，不做"看着没问题就放过"', () => {
  const signer = new ConfirmationSigner()
  const claim = {
    story_code: 'US-1',
    workspace_name: 'w',
    branch: 'release',
    commit_window_days: 14,
  }
  for (const bad of ['', 'nonsense', 'v1.aaa.bbb', 'v2.aaa.bbb']) {
    assert.throws(() => signer.verify(bad, claim), (error) => error instanceof ConfirmationError)
  }
})

// ---------------------------------------------------------------- 工具层门禁

test('没带令牌的提交绝不建批次，只回确认卡片与令牌', async () => {
  const client = platformStub()
  const registry = createToolRegistry({
    client,
    config: CONFIG,
    linky: linkyStub(),
    confirmations: new ConfirmationSigner(),
  })
  const result = await registry.call(
    TOOL_NAME,
    { ...SUBMIT_ARGS, workspace_name: '工具组' },
    { caller: 'alice' },
  )

  assert.equal(inserted(client), false, '确认之前不许在平台上建任何批次')
  assert.match(result.content[0].text, /还没有提交/)
  assert.match(result.content[0].text, /工具开发组/)
  assert.match(result.content[0].text, /你给的是「工具组」/)
  assert.match(result.content[0].text, /confirmation_token: v1\./)
  assert.match(result.content[0].text, /不要自行带上令牌提交/)
})

test('带上第一步给的令牌才真正提交，且用的是纠正后的项目组', async () => {
  const client = platformStub()
  const registry = createToolRegistry({
    client,
    config: CONFIG,
    linky: linkyStub(),
    confirmations: new ConfirmationSigner(),
  })
  const first = await registry.call(
    TOOL_NAME,
    { ...SUBMIT_ARGS, workspace_name: '工具组' },
    { caller: 'alice' },
  )
  const token = /confirmation_token: (\S+)/.exec(first.content[0].text)[1]

  const second = await registry.call(
    TOOL_NAME,
    { ...SUBMIT_ARGS, workspace_name: '工具组', confirmation_token: token },
    { caller: 'alice' },
  )
  assert.equal(second.isError, false)
  assert.match(second.content[0].text, /已成功受理/)
  assert.equal(inserted(client), true)

  // 提交给平台的项目组必须是纠正后的值，否则 Worker 还是会拿着错名字去导入。
  const importCall = client.calls.find(
    (call) => call.kind === 'rpc' && call.name === 'request_linky_batch_import_for_analysis',
  )
  assert.ok(importCall)
  assert.match(second.content[0].text, /项目组：工具开发组/)
})

test('需求不存在时，提交被拒且平台上没有任何批次', async () => {
  const client = platformStub()
  const registry = createToolRegistry({
    client,
    config: CONFIG,
    linky: linkyStub({
      error: new LinkyLookupError('未找到用户故事', { code: 'LINKY_STORY_NOT_FOUND', status: 404 }),
    }),
    confirmations: new ConfirmationSigner(),
  })
  const result = await registry.call(TOOL_NAME, SUBMIT_ARGS, { caller: 'alice' })
  assert.equal(result.isError, true)
  assert.equal(inserted(client), false)
  assert.match(result.content[0].text, /没有创建任何评审/)
  assert.match(result.content[0].text, /只给需求编号也可以/)
})

test('分支/窗口非法时在查 Linky 之前就拦住，不签出令牌', async () => {
  const client = platformStub()
  let lookups = 0
  const registry = createToolRegistry({
    client,
    config: CONFIG,
    linky: {
      async getStory() {
        lookups += 1
        return STORY_DETAIL
      },
    },
    confirmations: new ConfirmationSigner(),
  })
  const result = await registry.call(TOOL_NAME, { ...SUBMIT_ARGS, branch: 'main' })
  assert.equal(result.isError, true)
  assert.equal(lookups, 0, '形状都不对就不该再去查上游')
  assert.equal(inserted(client), false)
  assert.ok(!result.content[0].text.includes('confirmation_token'))
})

test('令牌与本次参数不符时拒绝提交（防止拿 A 的确认去提交 B）', async () => {
  const client = platformStub()
  const confirmations = new ConfirmationSigner()
  const registry = createToolRegistry({
    client,
    config: CONFIG,
    linky: linkyStub(),
    confirmations,
  })
  const token = confirmations.issue({
    story_code: 'US-2026-000001',
    workspace_name: '工具开发组',
    branch: 'feature_dev',
    commit_window_days: 7,
    verification: 'VERIFIED',
  })
  const result = await registry.call(TOOL_NAME, {
    ...SUBMIT_ARGS,
    workspace_name: '工具开发组',
    confirmation_token: token,
  })
  assert.equal(result.isError, true)
  assert.equal(inserted(client), false)
  assert.match(result.content[0].text, /CONFIRMATION_PARAM_MISMATCH/)
  assert.match(result.content[0].text, /没有创建任何评审/)
})

test('校验没做成时，确认卡片与回执都必须如实写明"没核对过"', async () => {
  const client = platformStub()
  const confirmations = new ConfirmationSigner()
  const registry = createToolRegistry({
    client,
    config: CONFIG,
    linky: linkyStub({
      error: new LinkyLookupError('Linky 取数接口拒绝了平台侧凭据（HTTP 400：invalid token）', {
        code: 'LINKY_UPSTREAM_AUTH_FAILED',
        unverifiable: true,
      }),
    }),
    confirmations,
  })
  const first = await registry.call(TOOL_NAME, { ...SUBMIT_ARGS, workspace_name: '工具开发组' })
  assert.match(first.content[0].text, /没能核对成功/)
  assert.match(first.content[0].text, /invalid token/)

  const token = /confirmation_token: (\S+)/.exec(first.content[0].text)[1]
  const second = await registry.call(TOOL_NAME, {
    ...SUBMIT_ARGS,
    workspace_name: '工具开发组',
    confirmation_token: token,
  })
  assert.equal(second.isError, false)
  assert.match(second.content[0].text, /没有.*核对/, '回执必须保留"这次没核对过"这个事实')
})

// ---------------------------------------------------------------- 只读查询工具

test('lookup_requirement 只读：不建批次、不花额度', async () => {
  const client = platformStub()
  const registry = createToolRegistry({
    client,
    config: CONFIG,
    linky: linkyStub(),
    confirmations: new ConfirmationSigner(),
  })
  const result = await registry.call(
    LOOKUP_TOOL_NAME,
    { story_code: 'US-2026-017341', workspace_name: '工具组' },
    { caller: 'alice' },
  )
  assert.equal(inserted(client), false)
  assert.equal(client.calls.length, 0, '只读查询不该碰平台接口')
  assert.match(result.content[0].text, /工具开发组/)
  assert.match(result.content[0].text, /需求名称：MCP 提交评审时校验需求/)
  assert.match(result.content[0].text, /测试负责人：王五/)
})

test('lookup_requirement 不给分支/窗口时按默认值签令牌（V1.63）', async () => {
  const registry = createToolRegistry({
    client: platformStub(),
    config: CONFIG,
    linky: linkyStub(),
    confirmations: new ConfirmationSigner(),
  })
  const result = await registry.call(LOOKUP_TOOL_NAME, { story_code: 'US-2026-017341' })
  const text = result.content[0].text
  // 默认值必须签得出令牌 —— 否则用户还得先回答两个他未必在意的问题才能开始。
  assert.match(text, /confirmation_token: v1\./)
  // 但默认值绝不沉默：要标出"默认值"，并列出替代项。
  assert.match(text, /release.*← 默认值/)
  assert.match(text, /14 天.*← 默认值/)
  assert.match(text, /feature_dev/)
  assert.match(text, /feature_sit/)
  assert.match(text, /7 天 \/ 21 天 \/ 28 天|7 天 \/ 21 天|21 天/)
})

test('lookup_requirement 带齐分支与窗口时直接签出可提交的令牌', async () => {
  const client = platformStub()
  const registry = createToolRegistry({
    client,
    config: CONFIG,
    linky: linkyStub(),
    confirmations: new ConfirmationSigner(),
  })
  const lookup = await registry.call(LOOKUP_TOOL_NAME, {
    story_code: 'US-2026-017341',
    workspace_name: '工具组',
    branch: 'feature_dev',
    commit_window_days: 7,
  })
  const token = /confirmation_token: (\S+)/.exec(lookup.content[0].text)[1]

  const submitted = await registry.call(TOOL_NAME, {
    ...SUBMIT_ARGS,
    workspace_name: '工具组',
    confirmation_token: token,
  })
  assert.equal(submitted.isError, false, '查询工具签的令牌必须能直接用于提交')
  assert.equal(inserted(client), true)
})

test('工具 annotations：查询是只读，提交不是', () => {
  const registry = createToolRegistry({ client: platformStub(), config: CONFIG })
  const lookup = registry.definitions.find((tool) => tool.name === LOOKUP_TOOL_NAME)
  const submit = registry.definitions.find((tool) => tool.name === TOOL_NAME)
  assert.equal(lookup.annotations.readOnlyHint, true)
  assert.equal(submit.annotations.readOnlyHint, false)
  assert.equal(lookup.inputSchema.required.length, 1, '查询只需要需求编号')
})
