/**
 * 提交结果不确定时的行为（V1.48 修复）。
 *
 * 要守住的性质只有一条：**平台可能已经受理、或可能稍后才受理成功的时候，既不许删批次，
 * 也不许说"没有创建"。** 这类缺陷不会报错，只会表现为"同事说提交过了，平台上却查不到"
 * 或者"同一条需求被评审两次"。
 *
 * 关键判据：只有服务端**明确拒绝**（4xx 业务错误＝事务已回滚）才允许回收空批次。
 * "查不到导入单"不是拒绝的证据 —— 客户端超时之后，服务端那笔事务可能还在跑。
 */

import { strict as assert } from 'node:assert'
import test from 'node:test'

import { PlatformError, isIndeterminateStatus } from '../src/platform.mjs'
import {
  SubmissionStateUnknownError,
  resolveSubmissionOutcome,
  submitRequirementReview,
} from '../src/review.mjs'
import { formatSubmissionUnknown } from '../src/format.mjs'
import { TOOL_NAME, createToolRegistry } from '../src/tools.mjs'
import { ConfirmationSigner } from '../src/confirm.mjs'

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

/** 不真的等待；同时记录等了几次，用来断言"确实给在飞的事务留了时间"。 */
function fastSettle() {
  const waits = []
  return { settleProbes: 3, settleDelayMs: 2000, sleep: async (ms) => void waits.push(ms), waits }
}

/**
 * @param {object} options
 * @param {Error}  [options.submitError]  提交 RPC 抛出的错误
 * @param {Array<'row'|'null'|'throw'>} options.probe 每次核对的行为（按顺序消费，末项重复）
 */
function createClient({ submitError, probe }) {
  const calls = []
  let probeIndex = 0
  return {
    calls,
    email: 'mcp@example.com',
    userId: 'user-1',
    async rpc(name, args) {
      calls.push({ name, args })
      if (name === 'list_enabled_model_configs') {
        return [{ id: 'model-1', display_name: 'kimi-k3', has_api_key: true }]
      }
      if (name === 'request_linky_batch_import_for_analysis') {
        if (submitError) throw submitError
        return 'import-request-1'
      }
      if (name === 'get_latest_linky_batch_import') {
        const behaviour = probe[Math.min(probeIndex, probe.length - 1)]
        probeIndex += 1
        if (behaviour === 'throw') {
          throw new PlatformError('连不上平台接口：fetch failed', {
            code: 'PLATFORM_UNREACHABLE',
            indeterminate: true,
          })
        }
        return behaviour === 'row' ? { id: 'import-request-recovered', status: 'QUEUED' } : null
      }
      if (name === 'delete_review_batch') return true
      throw new Error(`unexpected rpc ${name}`)
    },
    async insert() {
      calls.push({ name: 'insert review_batch' })
      return { id: 'batch-1', name: 'MCP 评审：F-123456', week_code: '20261014-MCP100000-001' }
    },
    async select() {
      return []
    },
  }
}

const deleted = (client) => client.calls.some((call) => call.name === 'delete_review_batch')
const probeCount = (client) =>
  client.calls.filter((call) => call.name === 'get_latest_linky_batch_import').length

const TIMEOUT = new PlatformError('连不上平台接口：timeout', {
  code: 'PLATFORM_UNREACHABLE',
  indeterminate: true,
})

test('状态码分类：5xx/408/429 算结果不明，4xx 业务错误算明确拒绝', () => {
  for (const status of [500, 502, 503, 504, 408, 425, 429]) {
    assert.equal(isIndeterminateStatus(status), true, `${status} 应当算结果不明`)
  }
  for (const status of [400, 401, 403, 404, 409, 422]) {
    assert.equal(isIndeterminateStatus(status), false, `${status} 应当算明确拒绝`)
  }
})

test('网络中断但平台其实已受理：按成功返回真实受理编号，绝不删批次', async () => {
  const client = createClient({ submitError: TIMEOUT, probe: ['row'] })
  const receipt = await submitRequirementReview(client, CONFIG, VALID_ARGS, { settle: fastSettle() })
  assert.equal(receipt.import_request_id, 'import-request-recovered')
  assert.equal(receipt.recovered, true)
  assert.equal(probeCount(client), 1, '第一次就查到了，不该再等')
  assert.equal(deleted(client), false)
})

test('超时后第一次查不到、稍后才提交成功：等出来后按成功返回，不删批次', async () => {
  // 这正是"原提交仍在执行，稍后才提交成功"的那条竞态。
  const settle = fastSettle()
  const client = createClient({ submitError: TIMEOUT, probe: ['null', 'null', 'row'] })
  const receipt = await submitRequirementReview(client, CONFIG, VALID_ARGS, { settle })
  assert.equal(receipt.import_request_id, 'import-request-recovered')
  assert.equal(receipt.recovered, true)
  assert.equal(probeCount(client), 3)
  assert.deepEqual(settle.waits, [2000, 2000], '每次重查之前都要给事务留落地时间')
  assert.equal(deleted(client), false)
})

test('结果不明且始终查不到导入单：保留批次，报"结果不明"而不是失败', async () => {
  // 以前这里会删批次 —— 那是在删一个可能马上就成立的任务。
  const client = createClient({ submitError: TIMEOUT, probe: ['null'] })
  await assert.rejects(
    () => submitRequirementReview(client, CONFIG, VALID_ARGS, { settle: fastSettle() }),
    (error) => {
      assert.ok(error instanceof SubmissionStateUnknownError)
      assert.equal(error.batchId, 'batch-1')
      assert.equal(error.batchUrl, 'https://review.example.com/batches/batch-1/ai-result')
      return true
    },
  )
  assert.equal(probeCount(client), 3, '必须反复核对过才下"不明"的结论')
  assert.equal(deleted(client), false, '查不到不等于没受理，绝不能删')
})

test('网关 502 且始终查不到：同样保留批次', async () => {
  const client = createClient({
    submitError: new PlatformError('HTTP 502：<html>Bad Gateway</html>', {
      status: 502,
      indeterminate: true,
    }),
    probe: ['null'],
  })
  await assert.rejects(
    () => submitRequirementReview(client, CONFIG, VALID_ARGS, { settle: fastSettle() }),
    SubmissionStateUnknownError,
  )
  assert.equal(deleted(client), false)
})

test('连核对都做不到：保留批次，抛出"结果不明"', async () => {
  const client = createClient({ submitError: TIMEOUT, probe: ['throw'] })
  await assert.rejects(
    () => submitRequirementReview(client, CONFIG, VALID_ARGS, { settle: fastSettle() }),
    (error) => {
      assert.ok(error instanceof SubmissionStateUnknownError)
      assert.equal(error.storyCode, 'F-123456')
      return true
    },
  )
  assert.equal(deleted(client), false)
})

test('明确的业务拒绝才回收空批次，且不必核对', async () => {
  const client = createClient({
    submitError: new PlatformError('MODEL_SECRET_MISSING', { code: 'MODEL_SECRET_MISSING' }),
    probe: ['null'],
  })
  await assert.rejects(
    () => submitRequirementReview(client, CONFIG, VALID_ARGS, { settle: fastSettle() }),
    /MODEL_SECRET_MISSING/,
  )
  assert.equal(probeCount(client), 0, '4xx 业务错误意味着事务已回滚，不需要核对')
  assert.equal(deleted(client), true)
})

test('resolveSubmissionOutcome 的契约：结果不明永不返回 NOT_ACCEPTED', async () => {
  const client = createClient({ probe: ['null'] })
  const unknown = await resolveSubmissionOutcome(client, 'batch-1', TIMEOUT, fastSettle())
  assert.equal(unknown.kind, 'UNKNOWN')

  const rejected = await resolveSubmissionOutcome(
    client,
    'batch-1',
    new PlatformError('BATCH_READ_ONLY', { code: 'BATCH_READ_ONLY' }),
    fastSettle(),
  )
  assert.equal(rejected.kind, 'NOT_ACCEPTED')
})

test('200 但没给受理编号：先核对，查到就按成功返回', async () => {
  const client = createClient({ submitError: null, probe: ['row'] })
  const original = client.rpc.bind(client)
  client.rpc = async (name, args) => {
    if (name === 'request_linky_batch_import_for_analysis') {
      client.calls.push({ name, args })
      return null
    }
    return original(name, args)
  }
  const receipt = await submitRequirementReview(client, CONFIG, VALID_ARGS, { settle: fastSettle() })
  assert.equal(receipt.import_request_id, 'import-request-recovered')
  assert.equal(deleted(client), false)
})

test('结果不明的文本：说清"可能稍后才受理"，带编号与链接，劝阻重提', () => {
  const text = formatSubmissionUnknown(
    new SubmissionStateUnknownError({
      batchId: 'batch-1',
      batchUrl: 'https://review.example.com/batches/batch-1/ai-result',
      storyCode: 'F-123456',
      cause: TIMEOUT,
    }),
  )
  assert.ok(text.includes('无法确认'))
  assert.ok(text.includes('不要立即重复提交'))
  assert.ok(text.includes('稍后才受理成功'))
  assert.ok(text.includes('没有删除'))
  assert.ok(text.includes('batch-1'))
  assert.ok(text.includes('https://review.example.com/batches/batch-1/ai-result'))
  assert.ok(!text.includes('已成功受理'))
  assert.ok(!text.includes('平台上没有创建任何评审'))
})

test('工具层把"结果不明"作为 isError 文本回出，并保留链接', async () => {
  const client = createClient({ submitError: TIMEOUT, probe: ['throw'] })
  const events = []
  const confirmations = new ConfirmationSigner()
  const registry = createToolRegistry({
    client,
    config: CONFIG,
    logger: (event, fields) => events.push({ event, fields }),
    // 工具层默认会真的等 2 秒 ×2；测试里换成不等待。
    settle: fastSettle(),
    confirmations,
  })
  const token = confirmations.issue({
    story_code: VALID_ARGS.story_code,
    workspace_name: VALID_ARGS.workspace_name,
    branch: VALID_ARGS.branch,
    commit_window_days: VALID_ARGS.commit_window_days,
    verification: 'UNVERIFIED',
  })
  const result = await registry.call(
    TOOL_NAME,
    { ...VALID_ARGS, confirmation_token: token },
    { caller: 'alice' },
  )
  assert.equal(result.isError, true)
  assert.ok(result.content[0].text.includes('无法确认'))
  assert.ok(result.content[0].text.includes('batches/batch-1/ai-result'))
  assert.ok(events.some((entry) => entry.event === 'review_submit_state_unknown'))
  assert.equal(deleted(client), false)
})
