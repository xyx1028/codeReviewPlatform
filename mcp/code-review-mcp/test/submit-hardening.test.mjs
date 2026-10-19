/**
 * 提交路径的加固行为。
 *
 * 这一组盯的是"在真实并发与真实故障下才暴露"的三件事：唯一键碰撞、登录态缺用户 id、
 * 以及核对探针的时间预算。它们都不改变成功路径的语义，但错一个就会让使用者看到
 * 一句无从追查的失败。
 */

import { strict as assert } from 'node:assert'
import test from 'node:test'

import { PlatformError } from '../src/platform.mjs'
import {
  buildWeekCode,
  randomWeekCodeSuffix,
  resolveSubmissionOutcome,
  submitRequirementReview,
} from '../src/review.mjs'

const CONFIG = {
  platform: { webUrl: 'https://review.example.com' },
  defaults: { modelLabel: 'kimi-k3', batchNamePrefix: 'MCP 评审' },
}

const VALID_ARGS = {
  workspace_name: '灵基Foundation',
  story_code: 'F-123456',
  branch: 'feature_dev',
  commit_window_days: 21,
}

function createFakeClient(overrides = {}) {
  const calls = []
  return {
    calls,
    email: 'mcp@example.com',
    userId: overrides.userId === undefined ? 'user-1' : overrides.userId,
    async rpc(name, args, options) {
      calls.push({ kind: 'rpc', name, args, options })
      if (overrides.rpc) return overrides.rpc(name, args, options)
      if (name === 'list_enabled_model_configs') {
        return [{ id: 'model-1', display_name: 'kimi-k3', has_api_key: true }]
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
  }
}

test('发布周期编码后缀用随机串而不是毫秒：同毫秒并发不该撞唯一键', () => {
  const suffix = randomWeekCodeSuffix()
  assert.match(suffix, /^-[0-9a-f]{6}$/)
  const many = new Set(Array.from({ length: 2000 }, () => randomWeekCodeSuffix()))
  assert.ok(many.size > 1990, `2000 次抽样只拿到 ${many.size} 个不同后缀，随机性不足`)

  // 真正写进批次的 week_code：日期前缀仍在，排序行为不变。
  const code = buildWeekCode(new Date(2026, 9, 13, 20, 35, 42), { suffix: randomWeekCodeSuffix() })
  assert.match(code, /^20261013-MCP203542-[0-9a-f]{6}$/)
})

test('同一毫秒内连续两次提交必须拿到不同的 week_code', async () => {
  const codes = []
  const client = createFakeClient({
    insert: (_table, row) => {
      codes.push(row.week_code)
      return { id: `batch-${codes.length}`, name: row.name, week_code: row.week_code }
    },
  })
  const frozenNow = Date.now()
  const realNow = Date.now
  Date.now = () => frozenNow // 冻住时钟：旧实现的后缀是 Date.now() % 1000，此刻必然相同
  try {
    await submitRequirementReview(client, CONFIG, { ...VALID_ARGS, caller: 'alice' })
    await submitRequirementReview(client, CONFIG, { ...VALID_ARGS, caller: 'alice' })
  } finally {
    Date.now = realNow
  }
  assert.equal(codes.length, 2)
  assert.notEqual(codes[0], codes[1], '时钟冻住时两次提交的发布周期编码仍必须不同')
})

test('登录了但没拿到用户 id 时，报的是登录问题而不是"账号权限不够"', async () => {
  const client = createFakeClient({ userId: null })
  await assert.rejects(
    () => submitRequirementReview(client, CONFIG, { ...VALID_ARGS, caller: 'alice' }),
    (error) => {
      assert.ok(error instanceof PlatformError)
      assert.equal(error.code, 'PLATFORM_SIGN_IN_FAILED')
      assert.match(error.message, /没有拿到用户 id/)
      return true
    },
  )
  // 关键：不能已经建了批次再失败，否则平台上留一个空批次。
  assert.equal(
    client.calls.some((call) => call.kind === 'insert'),
    false,
    '用户 id 缺失必须在建批次之前就拦住',
  )
})

test('核对探针用独立的短超时，不沿用平台写操作的超时', async () => {
  const seen = []
  const client = {
    async rpc(name, args, options) {
      seen.push({ name, options })
      return null // 始终查不到导入单
    },
  }
  const outcome = await resolveSubmissionOutcome(
    client,
    'batch-1',
    new PlatformError('超时', { indeterminate: true }),
    { settleProbes: 3, settleDelayMs: 0, probeTimeoutMs: 8000, sleep: async () => undefined },
  )
  assert.equal(outcome.kind, 'UNKNOWN')
  assert.equal(seen.length, 3)
  for (const call of seen) {
    assert.equal(call.name, 'get_latest_linky_batch_import')
    assert.equal(call.options?.timeoutMs, 8000, '探针必须带自己的超时预算')
  }
})

test('settle 预算可由配置透传到探针（否则 .env 里调了也不生效）', async () => {
  const seen = []
  const client = createFakeClient({
    rpc: (name, _args, options) => {
      seen.push({ name, options })
      if (name === 'list_enabled_model_configs') {
        return [{ id: 'model-1', display_name: 'kimi-k3', has_api_key: true }]
      }
      if (name === 'request_linky_batch_import_for_analysis') {
        throw new PlatformError('网关超时', { status: 504, indeterminate: true })
      }
      if (name === 'get_latest_linky_batch_import') return { id: 'import-recovered-1' }
      throw new Error(`unexpected rpc ${name}`)
    },
  })
  const receipt = await submitRequirementReview(
    client,
    CONFIG,
    { ...VALID_ARGS, caller: 'alice' },
    { settle: { settleProbes: 2, settleDelayMs: 0, probeTimeoutMs: 1234, sleep: async () => undefined } },
  )
  assert.equal(receipt.import_request_id, 'import-recovered-1')
  assert.equal(receipt.recovered, true)
  const probe = seen.find((call) => call.name === 'get_latest_linky_batch_import')
  assert.equal(probe?.options?.timeoutMs, 1234)
})
