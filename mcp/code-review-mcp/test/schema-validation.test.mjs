/**
 * 服务端入参校验（V1.56）。
 *
 * 这一组存在的前提是一个容易被忽略的事实：MCP SDK 的**低层** `Server` 不校验
 * `tools/call` 的实参，它只把 `inputSchema` 转发给客户端。所以"声明了 schema"
 * 和"服务端会按 schema 拒"是两件事 —— 这里断言的是后者。
 *
 * 另一条贯穿全组的要求：报错必须让模型**能照着改**。只回一句"参数错误"的话，
 * 客户端里的模型只能换个姿势重试，而每次重试都是一轮真实往返。
 */

import { strict as assert } from 'node:assert'
import test from 'node:test'

import {
  formatSchemaViolations,
  validateAgainstSchema,
} from '../src/schema.mjs'
import {
  LOOKUP_TOOL_DEFINITION,
  LOOKUP_TOOL_NAME,
  TOOL_DEFINITION,
  TOOL_NAME,
  createToolRegistry,
} from '../src/tools.mjs'
import { ConfirmationSigner } from '../src/confirm.mjs'

const CONFIG = {
  platform: { webUrl: 'https://review.example.com' },
  defaults: { modelLabel: 'kimi-k3', batchNamePrefix: 'MCP 评审', timeZone: 'Asia/Shanghai' },
}

const STORY_DETAIL = {
  id: '11111111-1111-4111-8111-111111111111',
  code: 'US-2026-017341',
  workspace_id: '22222222-2222-4222-8222-222222222222',
  workspace_name: '工具开发组',
  status_label: '开发中',
  field_values: { gf_name: '需求标题', gf_description: '正文' },
  attachments: [],
  team: null,
}

function registry({ linky = { async getStory() { return STORY_DETAIL }, async probeHealth() { return { healthy: true, error: null } } } } = {}) {
  const calls = []
  const client = {
    calls,
    email: 'mcp@example.com',
    userId: 'user-1',
    async rpc(name) {
      calls.push({ kind: 'rpc', name })
      if (name === 'list_enabled_model_configs') {
        return [{ id: 'model-1', display_name: 'kimi-k3', has_api_key: true }]
      }
      if (name === 'request_linky_batch_import_for_analysis') return 'import-1'
      return true
    },
    async insert(table, row) {
      calls.push({ kind: 'insert', table, row })
      return { id: 'batch-1', name: row.name, week_code: row.week_code }
    },
  }
  return {
    client,
    reg: createToolRegistry({
      client,
      config: CONFIG,
      linky,
      confirmations: new ConfirmationSigner(),
    }),
  }
}

function touchedPlatform(client) {
  return client.calls.length > 0
}

// ---------------------------------------------------------------- 校验器本身

test('必填缺失逐条报出，并带上该填什么', () => {
  const violations = validateAgainstSchema(TOOL_DEFINITION.inputSchema, {})
  const paths = violations.map((item) => item.path)
  assert.deepEqual(paths.sort(), ['branch', 'commit_window_days', 'story_code'])
  const branch = violations.find((item) => item.path === 'branch')
  assert.match(branch.message, /必填/)
  assert.match(branch.expected, /feature_dev/, '要告诉模型允许的取值，否则它只能猜')
})

test('一次把全部问题说清，不是只报第一条', () => {
  const violations = validateAgainstSchema(TOOL_DEFINITION.inputSchema, {
    story_code: '需求标题带空格',
    branch: 'dev',
    commit_window_days: 30,
  })
  assert.ok(violations.length >= 3, `应同时报出 3 处，实际 ${violations.length}`)
})

test('枚举违规要回显允许的取值（代码基线）', () => {
  const [violation] = validateAgainstSchema(TOOL_DEFINITION.inputSchema, {
    story_code: 'US-1',
    branch: 'main',
    commit_window_days: 7,
  })
  assert.equal(violation.path, 'branch')
  assert.match(violation.message, /feature_dev \/ feature_sit \/ release/)
  assert.match(violation.received, /main/)
})

test('提交时间窗口只接受 7/14/21/28，且不接受字符串数字', () => {
  const enumViolation = validateAgainstSchema(TOOL_DEFINITION.inputSchema, {
    story_code: 'US-1',
    branch: 'release',
    commit_window_days: 30,
  })
  assert.match(enumViolation[0].message, /7 \/ 14 \/ 21 \/ 28/)

  // "7" 不自动转成 7：模型传字符串往往说明它没看懂参数，悄悄转换就把
  // "它其实不确定"变成了一次真实提交。
  const typeViolation = validateAgainstSchema(TOOL_DEFINITION.inputSchema, {
    story_code: 'US-1',
    branch: 'release',
    commit_window_days: '7',
  })
  assert.equal(typeViolation[0].path, 'commit_window_days')
  assert.match(typeViolation[0].message, /整数/)

  const unitViolation = validateAgainstSchema(TOOL_DEFINITION.inputSchema, {
    story_code: 'US-1',
    branch: 'release',
    commit_window_days: '7天',
  })
  assert.match(unitViolation[0].message, /整数/)
})

test('多余参数要报错而不是静默忽略（模型常把参数名拼错）', () => {
  const violations = validateAgainstSchema(TOOL_DEFINITION.inputSchema, {
    story_code: 'US-1',
    branch: 'release',
    commit_window_days: 7,
    workspace_names: '工具开发组', // 多了一个 s
  })
  assert.equal(violations.length, 1)
  assert.equal(violations[0].path, 'workspace_names')
  assert.match(violations[0].message, /不是这个工具的参数/)
  assert.match(violations[0].expected, /workspace_name/, '要列出可用参数名')
})

test('需求编号不接受标题/中文/空格这类明显填错位置的值', () => {
  for (const bad of ['需求标题', 'US 2026 017341', 'a/b', '']) {
    const violations = validateAgainstSchema(TOOL_DEFINITION.inputSchema, {
      story_code: bad,
      branch: 'release',
      commit_window_days: 7,
    })
    assert.ok(
      violations.some((item) => item.path === 'story_code'),
      `${JSON.stringify(bad)} 应被判为非法需求编号`,
    )
  }
  // 真实存在的三种写法都必须通过。
  for (const good of [
    'US-2026-017341',
    'F-123456',
    'STORY-42',
    '3677a47f-94ef-45ce-b279-c3ee8e97be13',
  ]) {
    const violations = validateAgainstSchema(TOOL_DEFINITION.inputSchema, {
      story_code: good,
      branch: 'release',
      commit_window_days: 7,
    })
    assert.deepEqual(violations, [], `${good} 应通过`)
  }
})

test('发布周期必须是 8 位数字（与页面三个下拉拼出来的一致）', () => {
  const violations = validateAgainstSchema(TOOL_DEFINITION.inputSchema, {
    story_code: 'US-1',
    branch: 'release',
    commit_window_days: 7,
    release_cycle: '2026-10-20',
  })
  assert.equal(violations[0].path, 'release_cycle')
  assert.match(violations[0].message, /格式不符合要求/)

  assert.deepEqual(
    validateAgainstSchema(TOOL_DEFINITION.inputSchema, {
      story_code: 'US-1',
      branch: 'release',
      commit_window_days: 7,
      release_cycle: '20261020',
    }),
    [],
  )
})

test('workspace_id 必须是 UUID', () => {
  const violations = validateAgainstSchema(TOOL_DEFINITION.inputSchema, {
    story_code: 'US-1',
    branch: 'release',
    commit_window_days: 7,
    workspace_id: '工具开发组',
  })
  assert.equal(violations[0].path, 'workspace_id')
})

test('遇到没实现的 schema 关键字必须抛错，不许静默放过', () => {
  assert.throws(
    () => validateAgainstSchema({ type: 'object', properties: { a: { type: 'string', format: 'email' } } }, { a: 'x' }),
    /不支持关键字 "format"/,
    '悄悄忽略一条约束，等于对外承诺了一件服务端并不执行的事',
  )
})

test('校验文本带字段路径、期望值与实收值', () => {
  const text = formatSchemaViolations(
    TOOL_NAME,
    validateAgainstSchema(TOOL_DEFINITION.inputSchema, { branch: 'main', commit_window_days: '7' }),
  )
  assert.match(text, /没有执行任何操作/)
  assert.match(text, /平台上没有创建任何评审/)
  assert.match(text, /branch/)
  assert.match(text, /commit_window_days/)
  assert.match(text, /实际收到/)
  assert.match(text, /不要凭猜测重试/)
})

// ---------------------------------------------------------------- 工具层门禁

test('schema 不过时，工具层在做任何事之前就拒（不查 Linky、不碰平台）', async () => {
  let lookups = 0
  const { client, reg } = registry({
    linky: {
      async getStory() {
        lookups += 1
        return STORY_DETAIL
      },
      async probeHealth() {
        return { healthy: true, error: null }
      },
    },
  })
  const result = await reg.call(TOOL_NAME, {
    story_code: 'US-2026-017341',
    branch: 'main',
    commit_window_days: 30,
  })
  assert.equal(result.isError, true)
  assert.equal(lookups, 0, 'schema 都不过就不该去查上游')
  assert.equal(touchedPlatform(client), false, '更不该碰平台接口')
  assert.match(result.content[0].text, /branch/)
  assert.match(result.content[0].text, /commit_window_days/)
})

test('只读查询工具同样走 schema 校验', async () => {
  const { reg } = registry()
  const result = await reg.call(LOOKUP_TOOL_NAME, { story_code: '带 空格' })
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /story_code/)
})

test('未知工具名要列出真实可用的工具，便于模型自我纠正', async () => {
  const { reg } = registry()
  const result = await reg.call('submit_review', { story_code: 'US-1' })
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, new RegExp(LOOKUP_TOOL_NAME))
  assert.match(result.content[0].text, new RegExp(TOOL_NAME))
})

test('合法参数照常通过门禁', async () => {
  const { reg } = registry()
  const result = await reg.call(
    TOOL_NAME,
    { story_code: 'US-2026-017341', branch: 'feature_dev', commit_window_days: 7 },
    { caller: 'alice' },
  )
  assert.equal(result.isError, false ?? false)
  assert.match(result.content[0].text, /还没有提交/, '第一步仍然是确认，不是直接提交')
})

test('两个工具的 schema 都被校验器完全支持（不存在未实现的关键字）', () => {
  // 这条是防回归的：以后给 schema 加新关键字时，必须同时在校验器里实现它。
  for (const definition of [LOOKUP_TOOL_DEFINITION, TOOL_DEFINITION]) {
    assert.doesNotThrow(
      () => validateAgainstSchema(definition.inputSchema, {}),
      `${definition.name} 的 schema 含校验器未实现的关键字`,
    )
  }
})

test('schema 公布的约束与服务端实际执行的一致：enum 不是摆设', () => {
  // 对外公布什么，服务端就按什么拒 —— 校验器直接读那份 schema，不另写一遍判断。
  assert.deepEqual(TOOL_DEFINITION.inputSchema.properties.branch.enum, [
    'feature_dev',
    'feature_sit',
    'release',
  ])
  const violations = validateAgainstSchema(TOOL_DEFINITION.inputSchema, {
    story_code: 'US-1',
    branch: 'feature_prod',
    commit_window_days: 7,
  })
  assert.equal(violations.length, 1)
  assert.equal(violations[0].expected, 'feature_dev / feature_sit / release')
})
