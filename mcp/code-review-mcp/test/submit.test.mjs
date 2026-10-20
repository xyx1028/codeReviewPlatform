import { strict as assert } from 'node:assert'
import test from 'node:test'

import { PlatformError } from '../src/platform.mjs'
import {
  assertBranch,
  assertCommitWindow,
  buildBatchUrl,
  buildWeekCode,
  normalizeStoryCode,
  normalizeWorkspaceName,
  resolveConfiguredModel,
  submitRequirementReview,
} from '../src/review.mjs'
import {
  SUBMITTED_NOTICE,
  describePlatformError,
  formatSubmissionFailure,
  formatSubmissionReceipt,
} from '../src/format.mjs'
import { TOOL_DEFINITION, TOOL_NAME, createToolRegistry } from '../src/tools.mjs'
import { ConfirmationSigner } from '../src/confirm.mjs'

const CONFIG = {
  platform: { webUrl: 'https://review.example.com' },
  defaults: { modelLabel: 'kimi-k3', batchNamePrefix: 'MCP 评审', branch: 'release', commitWindowDays: 14 },
}

const VALID_ARGS = {
  workspace_name: '灵基Foundation',
  story_code: 'F-123456',
  branch: 'feature_dev',
  commit_window_days: 21,
}

/**
 * 签一张对应 VALID_ARGS 的确认令牌。
 *
 * 测试里 `linky` 为 null（校验关闭），所以结论是 UNVERIFIED —— 这正是"MCP 不在内网"
 * 的真实形态：仍然要求确认，只是卡片上写明没核对过。
 */
function confirmedToken(confirmations, overrides = {}) {
  return confirmations.issue({
    story_code: VALID_ARGS.story_code,
    workspace_name: VALID_ARGS.workspace_name,
    branch: VALID_ARGS.branch,
    commit_window_days: VALID_ARGS.commit_window_days,
    verification: 'UNVERIFIED',
    ...overrides,
  })
}

/** 最小假客户端：记录调用序列，便于断言"失败时有没有把空批次删掉"。 */
function createFakeClient(overrides = {}) {
  const calls = []
  return {
    calls,
    email: 'mcp@example.com',
    userId: 'user-1',
    async rpc(name, args) {
      calls.push({ kind: 'rpc', name, args })
      if (overrides.rpc) return overrides.rpc(name, args)
      if (name === 'list_enabled_model_configs') {
        return [
          { id: 'model-1', display_name: 'kimi-k3', has_api_key: true },
          { id: 'model-2', display_name: 'glm5.3-flash', has_api_key: true },
        ]
      }
      if (name === 'request_linky_batch_import_for_analysis') return 'import-request-1'
      if (name === 'delete_review_batch') return true
      throw new Error(`unexpected rpc ${name}`)
    },
    async insert(table, row) {
      calls.push({ kind: 'insert', table, row })
      if (overrides.insert) return overrides.insert(table, row)
      return { id: 'batch-1', name: row.name, week_code: row.week_code }
    },
    async select() {
      return []
    },
  }
}

test('参数校验：需求编号、项目组、分支、提交窗口都必须有效', () => {
  assert.equal(normalizeStoryCode('  F-1  '), 'F-1')
  assert.throws(() => normalizeStoryCode(''), /STORY_CODE_REQUIRED|需求编号/)
  assert.equal(normalizeWorkspaceName(' 灵基 '), '灵基')
  assert.throws(() => normalizeWorkspaceName('   '), /项目组/)
  assert.equal(assertBranch('release'), 'release')
  assert.throws(() => assertBranch('main'), /feature_dev \/ feature_sit \/ release/)
  assert.equal(assertCommitWindow('14'), 14)
  assert.throws(() => assertCommitWindow(30), /7 \/ 14 \/ 21 \/ 28/)
})

test('发布周期编码与平台页面同构：干净的 YYYYMMDD', () => {
  // 页面上「发布周期」是年/月/日三个下拉拼出来的 8 位数字，MCP 必须给同一种东西，
  // 否则批次列表那一列里 MCP 批次和人工批次不是一类值，没法比对。
  assert.equal(buildWeekCode(new Date('2026-10-13T12:35:42Z'), { timeZone: 'Asia/Shanghai' }), '20261013')
})

test('批次链接指向平台的 AI 结果页', () => {
  assert.equal(
    buildBatchUrl('https://review.example.com/', 'abc'),
    'https://review.example.com/batches/abc/ai-result',
  )
})

test('模型由服务端决定：配错、停用、多选未配置都必须明确失败', () => {
  const models = [
    { id: 'm1', display_name: 'kimi-k3', has_api_key: true },
    { id: 'm2', display_name: 'glm5.3-flash', has_api_key: true },
  ]
  assert.equal(resolveConfiguredModel(models, 'KIMI-K3').id, 'm1')
  assert.equal(resolveConfiguredModel(models, 'm2').id, 'm2')
  assert.equal(resolveConfiguredModel([models[0]], null).id, 'm1')
  assert.throws(() => resolveConfiguredModel(models, null), /CRP_DEFAULT_MODEL/)
  assert.throws(() => resolveConfiguredModel(models, 'ds-v9'), /不可用/)
  assert.throws(
    () => resolveConfiguredModel([{ id: 'm3', display_name: 'x', has_api_key: false }], 'x'),
    /没有可用模型/,
  )
})

test('提交成功：返回真实导入单编号，不伪造分析任务编号', async () => {
  const client = createFakeClient()
  const receipt = await submitRequirementReview(client, CONFIG, VALID_ARGS)
  assert.equal(receipt.batch_id, 'batch-1')
  assert.equal(receipt.import_request_id, 'import-request-1')
  assert.equal(receipt.story_code, 'F-123456')
  assert.equal(receipt.branch, 'feature_dev')
  assert.equal(receipt.commit_window_days, 21)
  assert.equal(receipt.model, 'kimi-k3')
  assert.equal(receipt.batch_url, 'https://review.example.com/batches/batch-1/ai-result')
  assert.ok(!('analysis_job_id' in receipt), '首版不该出现分析任务编号')

  const importCall = client.calls.find(
    (call) => call.name === 'request_linky_batch_import_for_analysis',
  )
  assert.deepEqual(importCall.args, {
    p_batch_id: 'batch-1',
    p_workspace_name: '灵基Foundation',
    p_story_codes: ['F-123456'],
    p_workspace_id: null,
    p_release_window: null,
    p_commit_window_days: 21,
  })
  const insertCall = client.calls.find((call) => call.kind === 'insert')
  assert.equal(insertCall.row.default_branch, 'feature_dev')
  assert.equal(insertCall.row.ai_model_config_id, 'model-1')
})

test('提交失败：把刚建的空批次删掉并把原因抛出去', async () => {
  const client = createFakeClient({
    rpc(name) {
      if (name === 'list_enabled_model_configs') {
        return [{ id: 'model-1', display_name: 'kimi-k3', has_api_key: true }]
      }
      if (name === 'request_linky_batch_import_for_analysis') {
        throw new PlatformError('MODEL_SECRET_MISSING', { code: 'MODEL_SECRET_MISSING' })
      }
      if (name === 'delete_review_batch') return true
      throw new Error(`unexpected rpc ${name}`)
    },
  })
  await assert.rejects(() => submitRequirementReview(client, CONFIG, VALID_ARGS), /MODEL_SECRET_MISSING/)
  assert.ok(
    client.calls.some((call) => call.name === 'delete_review_batch'),
    '失败路径必须回收空批次',
  )
})

test('平台没回受理编号时不算受理成功（核对不到 → 保留批次并报"结果不明"）', async () => {
  const client = createFakeClient({
    rpc(name) {
      if (name === 'list_enabled_model_configs') {
        return [{ id: 'model-1', display_name: 'kimi-k3', has_api_key: true }]
      }
      if (name === 'request_linky_batch_import_for_analysis') return null
      // V1.48：受理编号缺失属于"状态不明"，必须先向平台核对。
      if (name === 'get_latest_linky_batch_import') return null
      if (name === 'delete_review_batch') return true
      throw new Error(`unexpected rpc ${name}`)
    },
  })
  await assert.rejects(
    () =>
      submitRequirementReview(client, CONFIG, VALID_ARGS, {
        settle: { settleProbes: 2, settleDelayMs: 0, sleep: async () => {} },
      }),
    /无法确认/,
  )
  assert.ok(
    client.calls.some((call) => call.name === 'get_latest_linky_batch_import'),
    '下结论之前必须核对',
  )
  assert.ok(
    !client.calls.some((call) => call.name === 'delete_review_batch'),
    '核对不到不等于没受理：那笔写操作可能还在飞，不许删',
  )
})

test('回执包含批次编号、受理编号、参数、链接与固定提示语', () => {
  const text = formatSubmissionReceipt({
    batch_id: 'batch-1',
    batch_name: 'MCP 评审：F-1',
    week_code: '20261013-MCP203542-007',
    import_request_id: 'import-1',
    story_code: 'F-1',
    workspace_name: '灵基',
    branch: 'release',
    commit_window_days: 28,
    model: 'kimi-k3',
    batch_url: 'https://review.example.com/batches/batch-1/ai-result',
  })
  for (const fragment of [
    'batch-1',
    'import-1',
    'F-1',
    '灵基',
    'release',
    '28 天',
    'kimi-k3',
    'https://review.example.com/batches/batch-1/ai-result',
    SUBMITTED_NOTICE,
  ]) {
    assert.ok(text.includes(fragment), `回执缺少 ${fragment}`)
  }
})

test('失败文本不出现"已提交"，也不带链接', () => {
  const text = formatSubmissionFailure(
    new PlatformError('BRANCH_INVALID', { code: 'BRANCH_INVALID' }),
  )
  assert.ok(text.includes('提交失败'))
  assert.ok(!text.includes('已提交'))
  assert.ok(!text.includes('http'))
  assert.ok(text.includes('feature_dev / feature_sit / release'))
})

test('权限不足时给出可照着做的提示', () => {
  assert.match(
    describePlatformError(new Error('batch creation permission required')),
    /ADMIN 或 REVIEWER/,
  )
  // 实测 VIEWER 账号拿到的是 RLS 原文 + 42501，不能让它原样糊到用户脸上。
  assert.match(
    describePlatformError(
      new PlatformError('new row violates row-level security policy for table "review_batch"', {
        code: '42501',
      }),
    ),
    /没有创建\/管理评审批次的权限.*ADMIN 或 REVIEWER/s,
  )
})

test('工具定义：只有需求编号必填 + 枚举约束 + 不开放模型参数', () => {
  assert.equal(TOOL_NAME, 'start_requirement_review')
  // V1.56：workspace_name 改可选（可按编号反查）。
  // V1.63：branch 与 commit_window_days 也改可选（默认 release + 14 天）——
  // 默认值不沉默，确认卡片会写明用了默认并列出替代项，所以"可选"不等于"替你偷偷决定"。
  assert.deepEqual(TOOL_DEFINITION.inputSchema.required, ['story_code'])
  assert.ok('workspace_name' in TOOL_DEFINITION.inputSchema.properties)
  assert.ok('confirmation_token' in TOOL_DEFINITION.inputSchema.properties)
  assert.deepEqual(TOOL_DEFINITION.inputSchema.properties.branch.enum, [
    'feature_dev',
    'feature_sit',
    'release',
  ])
  assert.deepEqual(TOOL_DEFINITION.inputSchema.properties.commit_window_days.enum, [7, 14, 21, 28])
  assert.equal(TOOL_DEFINITION.inputSchema.additionalProperties, false)
  assert.ok(!('model' in TOOL_DEFINITION.inputSchema.properties))
  assert.match(TOOL_DEFINITION.description, /不提供进度查询/)
  // 可选，但描述里必须写明默认值是什么，否则模型无从告知用户。
  assert.match(TOOL_DEFINITION.inputSchema.properties.branch.description, /默认 release/)
  assert.match(
    TOOL_DEFINITION.inputSchema.properties.commit_window_days.description,
    /默认 14 天/,
  )
})

test('registry 对未知工具与失败调用都回 isError，不回成功文案', async () => {
  const client = createFakeClient()
  const confirmations = new ConfirmationSigner()
  const registry = createToolRegistry({ client, config: CONFIG, confirmations })
  assert.equal(registry.definitions.length, 5, '3 个查询 + 1 个核对 + 1 个提交')

  const unknown = await registry.call('get_requirement_review', {})
  assert.equal(unknown.isError, true)

  const bad = await registry.call(TOOL_NAME, { ...VALID_ARGS, branch: 'main' })
  assert.equal(bad.isError, true)
  assert.ok(!bad.content[0].text.includes('已提交'))

  const ok = await registry.call(
    TOOL_NAME,
    { ...VALID_ARGS, confirmation_token: confirmedToken(confirmations) },
    { caller: 'alice' },
  )
  assert.equal(ok.isError, false)
  assert.ok(ok.content[0].text.includes(SUBMITTED_NOTICE))
  const insertCall = client.calls.find((call) => call.kind === 'insert')
  assert.match(insertCall.row.remark, /alice/)
})
