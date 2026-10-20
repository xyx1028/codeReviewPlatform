import test from 'node:test'
import assert from 'node:assert/strict'
import { ConfirmationError, ConfirmationSigner } from '../src/confirm.mjs'

const base = {
  story_codes: ['US-1', 'US-2'], workspace_name: '工具开发组', given_workspace: '工具组',
  release_window: 'R20261018', branch: 'release', commit_window_days: 14,
  verification: 'LISTED', caller: 'alice',
}
const rejected = (code) => (error) => error instanceof ConfirmationError && error.code === code

test('1 至 50 条需求均只回传 35 字符的随机确认编号', () => {
  const store = new ConfirmationSigner()
  const tokens = new Set()
  for (let count = 1; count <= 50; count++) {
    const story_codes = Array.from({ length: count }, (_, i) => `US-${i}`)
    const token = store.issue({ ...base, story_codes })
    assert.match(token, /^v2\.[A-Za-z0-9_-]{32}$/)
    tokens.add(token)
    assert.deepEqual(store.verify(token, { ...base, story_codes }).story_codes, story_codes)
  }
  assert.equal(tokens.size, 50)
})

test('修改原数组或校验返回值不会改变确认快照', () => {
  const store = new ConfirmationSigner()
  const input = { ...base, story_codes: [...base.story_codes] }
  const token = store.issue(input)
  input.story_codes.push('US-evil')
  const claim = store.verify(token, base)
  claim.story_codes.push('US-evil')
  claim.release_window = 'changed'
  assert.deepEqual(store.verify(token, base).story_codes, base.story_codes)
  assert.equal(store.verify(token, base).release_window, base.release_window)
})

test('截断、改写、随机伪造和旧版令牌均拒绝', () => {
  const store = new ConfirmationSigner()
  const token = store.issue(base)
  for (const bad of [token.slice(0, -1), 'v1.eyJ9.signature', 'nonsense']) {
    assert.throws(() => store.verify(bad, base), rejected('CONFIRMATION_MALFORMED'))
  }
  const changed = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A')
  assert.throws(() => store.verify(changed, base), rejected('CONFIRMATION_INVALID'))
  assert.throws(() => store.verify('v2.' + 'A'.repeat(32), base), rejected('CONFIRMATION_INVALID'))
})

test('跨调用身份或跨实例不能使用确认编号，即使配置了相同旧密钥', () => {
  const store = new ConfirmationSigner({ secret: 'legacy-secret' })
  const token = store.issue(base)
  assert.throws(() => store.verify(token, { ...base, caller: 'bob' }), rejected('CONFIRMATION_INVALID'))
  assert.throws(() => store.verify(token, { ...base, caller: null }), rejected('CONFIRMATION_INVALID'))
  assert.throws(
    () => new ConfirmationSigner({ secret: 'legacy-secret' }).verify(token, base),
    rejected('CONFIRMATION_INVALID'),
  )
  assert.doesNotThrow(() => store.verify(token, base))
})

test('篡改编号集合、窗口或评审参数仍拒绝；省略编号和窗口时使用原快照', () => {
  const store = new ConfirmationSigner()
  const token = store.issue(base)
  for (const changes of [
    { story_codes: ['US-1'] }, { workspace_name: '其他组' }, { branch: 'feature_dev' },
    { release_window: 'R20261019' }, { commit_window_days: 7 },
  ]) {
    assert.throws(() => store.verify(token, { ...base, ...changes }), rejected('CONFIRMATION_PARAM_MISMATCH'))
  }
  const claim = store.verify(token, { caller: 'alice', branch: 'release', commit_window_days: 14 })
  assert.deepEqual(claim.story_codes, base.story_codes)
  assert.equal(claim.release_window, base.release_window)
})

test('过期拒绝，容量耗尽不驱逐有效确认，过期记录释放容量', () => {
  let now = 1000
  const store = new ConfirmationSigner({ ttlMs: 100, maxPending: 2, now: () => now })
  const first = store.issue(base)
  const second = store.issue(base)
  assert.throws(() => store.issue(base), rejected('CONFIRMATION_CAPACITY'))
  assert.doesNotThrow(() => store.verify(first, base))
  now = 1100
  assert.throws(() => store.verify(first, base), rejected('CONFIRMATION_EXPIRED'))
  const fresh = store.issue(base)
  assert.throws(() => store.verify(second, base), rejected('CONFIRMATION_INVALID'))
  assert.doesNotThrow(() => store.verify(fresh, base))
})
