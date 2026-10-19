/**
 * 启动配置：`.env` 加载与超时/会话预算。
 *
 * 为什么单独测 `.env`：根 README 的部署步骤是"填好 mcp/code-review-mcp/.env →
 * npm run mcp:start"，而 `node src/index.mjs` 本身不读任何文件。这个缺口不会被任何
 * 既有测试碰到 —— 它只在第一次真的照文档启动时出现，表现为"配置都填了却说缺变量"。
 */

import { strict as assert } from 'node:assert'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

import { EnvFileError, loadEnvFileIfPresent } from '../src/env.mjs'
import { ConfigError, loadConfig } from '../src/config.mjs'

function tempEnvFile(contents, name = '.env') {
  const dir = mkdtempSync(join(tmpdir(), 'crp-mcp-env-'))
  const file = join(dir, name)
  writeFileSync(file, contents, 'utf8')
  return { dir, file }
}

/** 替身：只记录被要求加载哪个文件，不真的改当前进程的环境。 */
function recordingLoader() {
  const loaded = []
  return { loaded, load: (file) => loaded.push(file) }
}

test('默认加载包目录下的 .env：照着 README 填完就能启动', () => {
  const { dir, file } = tempEnvFile('CRP_SUPABASE_URL=https://x.supabase.co\n')
  const loader = recordingLoader()
  const result = loadEnvFileIfPresent({
    env: {},
    packageRoot: dir,
    loadEnvFile: loader.load,
  })
  assert.equal(result, file)
  assert.deepEqual(loader.loaded, [file])
})

test('没有 .env 时不报错：容器里本来就该用真实环境变量注入', () => {
  const loader = recordingLoader()
  const result = loadEnvFileIfPresent({
    env: {},
    packageRoot: join(tmpdir(), 'crp-mcp-no-such-dir'),
    loadEnvFile: loader.load,
  })
  assert.equal(result, null)
  assert.deepEqual(loader.loaded, [])
})

test('CRP_MCP_ENV_FILE 指定的文件不存在必须硬失败，不能静默少一半配置', () => {
  assert.throws(
    () =>
      loadEnvFileIfPresent({
        env: { CRP_MCP_ENV_FILE: './not-there.env' },
        cwd: tmpdir(),
        loadEnvFile: () => undefined,
      }),
    (error) => {
      assert.ok(error instanceof EnvFileError)
      assert.match(error.message, /不存在/)
      return true
    },
  )
})

test('CRP_MCP_ENV_FILE 支持相对路径（相对当前工作目录）与绝对路径', () => {
  const { dir, file } = tempEnvFile('CRP_EMAIL=a@b.c\n', 'custom.env')
  const relative = recordingLoader()
  assert.equal(
    loadEnvFileIfPresent({
      env: { CRP_MCP_ENV_FILE: 'custom.env' },
      cwd: dir,
      loadEnvFile: relative.load,
    }),
    file,
  )
  const absolute = recordingLoader()
  assert.equal(
    loadEnvFileIfPresent({
      env: { CRP_MCP_ENV_FILE: file },
      cwd: '/',
      loadEnvFile: absolute.load,
    }),
    file,
  )
})

test('真实环境变量优先于 .env：容器注入的配置不会被仓库里过期的那份盖掉', () => {
  const { file } = tempEnvFile('CRP_PROBE_PRECEDENCE=from-file\n')
  const previous = process.env.CRP_PROBE_PRECEDENCE
  process.env.CRP_PROBE_PRECEDENCE = 'from-environment'
  try {
    loadEnvFileIfPresent({ env: { CRP_MCP_ENV_FILE: file }, cwd: '/' })
    assert.equal(
      process.env.CRP_PROBE_PRECEDENCE,
      'from-environment',
      'process.loadEnvFile 的语义是不覆盖已有值，这条测试守住它',
    )
  } finally {
    if (previous === undefined) delete process.env.CRP_PROBE_PRECEDENCE
    else process.env.CRP_PROBE_PRECEDENCE = previous
  }
})

test('.env 里带引号的值要被正确剥离（.env.example 就是带引号的写法）', () => {
  const { file } = tempEnvFile('CRP_PROBE_QUOTED="/mcp"\nCRP_PROBE_PORT="8848"\n')
  const previousPath = process.env.CRP_PROBE_QUOTED
  const previousPort = process.env.CRP_PROBE_PORT
  delete process.env.CRP_PROBE_QUOTED
  delete process.env.CRP_PROBE_PORT
  try {
    loadEnvFileIfPresent({ env: { CRP_MCP_ENV_FILE: file }, cwd: '/' })
    assert.equal(process.env.CRP_PROBE_QUOTED, '/mcp')
    assert.equal(process.env.CRP_PROBE_PORT, '8848')
  } finally {
    if (previousPath === undefined) delete process.env.CRP_PROBE_QUOTED
    else process.env.CRP_PROBE_QUOTED = previousPath
    if (previousPort === undefined) delete process.env.CRP_PROBE_PORT
    else process.env.CRP_PROBE_PORT = previousPort
  }
})

test('已经用 node --env-file 指过文件时不再叠加 .env（两份配置混合比报错更难查）', () => {
  const { dir } = tempEnvFile('CRP_EMAIL=from-dot-env\n')
  const loader = recordingLoader()
  assert.equal(
    loadEnvFileIfPresent({
      env: {},
      packageRoot: dir,
      execArgv: ['--env-file=.env.selfhost.local'],
      loadEnvFile: loader.load,
    }),
    null,
  )
  assert.deepEqual(loader.loaded, [])

  // 显式写了 CRP_MCP_ENV_FILE 就以它为准，不受 --env-file 影响。
  const { file } = tempEnvFile('CRP_EMAIL=explicit\n', 'explicit.env')
  const explicit = recordingLoader()
  assert.equal(
    loadEnvFileIfPresent({
      env: { CRP_MCP_ENV_FILE: file },
      cwd: '/',
      execArgv: ['--env-file=.env.other'],
      loadEnvFile: explicit.load,
    }),
    file,
  )
})

const BASE_ENV = {
  CRP_SUPABASE_URL: 'https://proj.supabase.co',
  CRP_SUPABASE_ANON_KEY: 'anon-key',
  CRP_EMAIL: 'mcp@example.com',
  CRP_PASSWORD: 'secret',
  CRP_PLATFORM_WEB_URL: 'https://review.example.com/',
  CRP_MCP_TOKENS: 'alice:0123456789abcdef0123',
}

test('超时预算默认值要让最坏路径留在客户端 60 秒上限之内', () => {
  const config = loadConfig({ ...BASE_ENV })
  const worstCase =
    config.platform.timeoutMs +
    config.settle.settleProbes * config.settle.probeTimeoutMs +
    (config.settle.settleProbes - 1) * config.settle.settleDelayMs
  assert.ok(
    worstCase <= 55_000,
    `最坏路径 ${worstCase}ms 必须明显小于客户端默认的 60s，否则使用者看到的是 "tool call failed" 而不是批次编号`,
  )
  assert.equal(config.platform.timeoutMs, 20_000)
  assert.equal(config.settle.probeTimeoutMs, 8_000)
})

test('会话回收与来源白名单有默认值，且非法值启动即拒', () => {
  const config = loadConfig({ ...BASE_ENV })
  assert.equal(config.http.sessionTtlMs, 30 * 60_000)
  assert.equal(config.http.maxSessions, 256)
  assert.deepEqual(config.http.allowedOrigins, ['*'])
  assert.equal(config.http.path, '/mcp')

  assert.throws(
    () => loadConfig({ ...BASE_ENV, CRP_MCP_SESSION_TTL_MS: '5000' }),
    (error) => error instanceof ConfigError && /CRP_MCP_SESSION_TTL_MS/.test(error.message),
  )
  assert.throws(
    () => loadConfig({ ...BASE_ENV, CRP_MCP_MAX_SESSIONS: '0' }),
    (error) => error instanceof ConfigError && /CRP_MCP_MAX_SESSIONS/.test(error.message),
  )
  assert.throws(
    () => loadConfig({ ...BASE_ENV, CRP_PLATFORM_TIMEOUT_MS: '0' }),
    (error) => error instanceof ConfigError && /CRP_PLATFORM_TIMEOUT_MS/.test(error.message),
  )
  assert.throws(
    () => loadConfig({ ...BASE_ENV, CRP_SETTLE_PROBES: '0' }),
    (error) => error instanceof ConfigError && /CRP_SETTLE_PROBES/.test(error.message),
  )
})

test('CRP_MCP_PATH 写成带尾斜杠也归一化，不至于让客户端 404', () => {
  assert.equal(loadConfig({ ...BASE_ENV, CRP_MCP_PATH: '/mcp/' }).http.path, '/mcp')
  assert.equal(loadConfig({ ...BASE_ENV, CRP_MCP_PATH: 'review-mcp' }).http.path, '/review-mcp')
})

test('来源白名单可收紧，逗号分隔', () => {
  assert.deepEqual(
    loadConfig({ ...BASE_ENV, CRP_MCP_ALLOWED_ORIGINS: 'https://a.example.com, https://b.example.com' })
      .http.allowedOrigins,
    ['https://a.example.com', 'https://b.example.com'],
  )
})

test('.env.example 列出的键与 loadConfig 真正读的键一致', async () => {
  const { readFileSync } = await import('node:fs')
  // 注释掉的可选项也算"已登记"：它在文件里、有说明，照着改就行。
  const exampleKeys = new Set(
    readFileSync(resolve(import.meta.dirname, '../.env.example'), 'utf8')
      .split('\n')
      .map((line) => /^#?\s*([A-Z][A-Z0-9_]*)=/.exec(line.trim())?.[1])
      .filter((key) => key !== undefined),
  )
  const source = readFileSync(resolve(import.meta.dirname, '../src/config.mjs'), 'utf8')
  const readKeys = new Set(
    [...source.matchAll(/'(CRP_[A-Z0-9_]+)'/g)].map((match) => match[1]),
  )
  const missing = [...readKeys].filter((key) => !exampleKeys.has(key))
  assert.deepEqual(missing, [], `.env.example 缺少这些已被读取的变量：${missing.join(', ')}`)
})
