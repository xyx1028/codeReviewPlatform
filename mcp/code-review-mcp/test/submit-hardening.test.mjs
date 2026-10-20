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
  assertReleaseCycle,
  buildWeekCode,
  resolveSubmissionOutcome,
  submitRequirementReview,
} from '../src/review.mjs'

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

test('同一天多次提交用同一个发布周期，不再加任何后缀（V1.61 起允许重复）', async () => {
  const codes = []
  const client = createFakeClient({
    insert: (_table, row) => {
      codes.push(row.week_code)
      return { id: `batch-${codes.length}`, name: row.name, week_code: row.week_code }
    },
  })
  await submitRequirementReview(client, CONFIG, { ...VALID_ARGS, caller: 'alice' })
  await submitRequirementReview(client, CONFIG, { ...VALID_ARGS, caller: 'alice' })
  assert.equal(codes.length, 2)
  assert.equal(codes[0], codes[1], '同一天两次提交就该是同一个发布周期')
  assert.match(codes[0], /^\d{8}$/, '干净的 8 位日期，没有时分秒、没有随机后缀')
})

test('调用方指定的发布周期：格式、真实日期与年份范围都要卡', () => {
  const now = new Date('2026-10-20T02:00:00Z')
  const opts = { now, timeZone: 'Asia/Shanghai' }
  assert.equal(assertReleaseCycle('20261020', opts), '20261020')
  assert.equal(assertReleaseCycle('', opts), null, '不填就是用默认（当天）')
  assert.equal(assertReleaseCycle(undefined, opts), null)

  for (const bad of ['2026-10-20', '202610', '20261020x', 'abcdefgh']) {
    assert.throws(
      () => assertReleaseCycle(bad, opts),
      (error) => error.code === 'RELEASE_CYCLE_INVALID',
      `${bad} 应被判为格式错误`,
    )
  }
  // 正则过得去但不是真实日期 —— 这类值落库之后没有任何地方会再发现它。
  for (const bad of ['20260230', '20261332', '20260931']) {
    assert.throws(
      () => assertReleaseCycle(bad, opts),
      (error) => error.code === 'RELEASE_CYCLE_INVALID',
      `${bad} 应被判为不存在的日期`,
    )
  }
  // 年份窗口与页面上的下拉一致：当前年份前 2 后 3。
  assert.doesNotThrow(() => assertReleaseCycle('20240101', opts))
  assert.doesNotThrow(() => assertReleaseCycle('20291231', opts))
  for (const bad of ['19700101', '20230101', '20300101']) {
    assert.throws(
      () => assertReleaseCycle(bad, opts),
      (error) => error.code === 'RELEASE_CYCLE_OUT_OF_RANGE',
      `${bad} 应超出年份范围`,
    )
  }
})

test('指定了发布周期就按它建批次，不悄悄换成当天', async () => {
  const codes = []
  const client = createFakeClient({
    insert: (_table, row) => {
      codes.push(row.week_code)
      return { id: 'batch-1', name: row.name, week_code: row.week_code }
    },
  })
  const receipt = await submitRequirementReview(client, CONFIG, {
    ...VALID_ARGS,
    release_cycle: '20261231',
    caller: 'alice',
  })
  assert.equal(codes[0], '20261231')
  assert.equal(receipt.week_code, '20261231')
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
