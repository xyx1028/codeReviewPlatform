import { strict as assert } from 'node:assert'
import test from 'node:test'

import { ConfigError, loadConfig, parseAccessTokens } from '../src/config.mjs'
import { authenticate, extractToken } from '../src/http.mjs'

const BASE_ENV = {
  CRP_SUPABASE_URL: 'https://example.supabase.co/',
  CRP_SUPABASE_ANON_KEY: 'anon-key',
  CRP_EMAIL: 'mcp@example.com',
  CRP_PASSWORD: 'secret',
  CRP_PLATFORM_WEB_URL: 'https://review.example.com/',
  CRP_MCP_TOKENS: 'alice:0123456789abcdef0123',
}

test('parseAccessTokens 解析名字与令牌', () => {
  const tokens = parseAccessTokens('alice:0123456789abcdef,  0123456789abcdefXY')
  assert.deepEqual(tokens, [
    { name: 'alice', token: '0123456789abcdef' },
    { name: 'client-2', token: '0123456789abcdefXY' },
  ])
})

test('parseAccessTokens 拒绝过短与重复的令牌', () => {
  assert.throws(() => parseAccessTokens('alice:short'), ConfigError)
  assert.throws(
    () => parseAccessTokens('alice:0123456789abcdef,bob:0123456789abcdef'),
    /访问凭证重复/,
  )
})

test('loadConfig 归一化 URL 并给出默认值', () => {
  const config = loadConfig({ ...BASE_ENV })
  assert.equal(config.transport, 'http')
  assert.equal(config.platform.url, 'https://example.supabase.co')
  assert.equal(config.platform.webUrl, 'https://review.example.com')
  assert.equal(config.http.path, '/mcp')
  assert.equal(config.http.port, 8848)
  assert.equal(config.defaults.batchNamePrefix, 'MCP 评审')
})

test('loadConfig 缺少必需变量时启动就拒', () => {
  for (const key of [
    'CRP_SUPABASE_URL',
    'CRP_SUPABASE_ANON_KEY',
    'CRP_EMAIL',
    'CRP_PASSWORD',
    'CRP_PLATFORM_WEB_URL',
  ]) {
    const env = { ...BASE_ENV }
    delete env[key]
    assert.throws(() => loadConfig(env), new RegExp(key), `${key} 缺失时应当报错`)
  }
})

test('HTTP 模式没有访问凭证时拒绝启动，除非显式允许匿名', () => {
  const env = { ...BASE_ENV }
  delete env.CRP_MCP_TOKENS
  assert.throws(() => loadConfig(env), /CRP_MCP_TOKENS/)
  const anonymous = loadConfig({ ...env, CRP_MCP_ALLOW_NO_AUTH: 'true' })
  assert.equal(anonymous.http.allowAnonymous, true)
})

test('stdio 模式不要求访问凭证', () => {
  const env = { ...BASE_ENV, CRP_MCP_TRANSPORT: 'stdio' }
  delete env.CRP_MCP_TOKENS
  assert.equal(loadConfig(env).transport, 'stdio')
})

test('extractToken 支持 Bearer 与 X-Api-Key', () => {
  assert.equal(extractToken({ authorization: 'Bearer abc' }), 'abc')
  assert.equal(extractToken({ authorization: 'bearer   abc  ' }), 'abc')
  assert.equal(extractToken({ 'x-api-key': 'abc' }), 'abc')
  assert.equal(extractToken({}), null)
})

test('authenticate 只接受已登记的凭证，并回出调用方名字', () => {
  const options = { tokens: [{ name: 'alice', token: '0123456789abcdef' }], allowAnonymous: false }
  assert.deepEqual(authenticate({ authorization: 'Bearer 0123456789abcdef' }, options), {
    ok: true,
    caller: 'alice',
  })
  assert.deepEqual(authenticate({ authorization: 'Bearer wrong' }, options), {
    ok: false,
    reason: 'INVALID_TOKEN',
  })
  assert.deepEqual(authenticate({}, options), { ok: false, reason: 'MISSING_TOKEN' })
  assert.deepEqual(authenticate({}, { ...options, allowAnonymous: true }), {
    ok: true,
    caller: 'anonymous',
  })
})
