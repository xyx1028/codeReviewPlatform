import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')
const hasCompose = spawnSync('docker', ['compose', 'version'], { stdio: 'ignore' }).status === 0
const release = readFileSync(join(root, 'deploy/supabase-selfhost/scripts/release.sh'), 'utf8')
const preflight = release.slice(release.indexOf('mcp_compose() {'), release.indexOf('\nsync_release() {'))

function checkPreflight(config) {
  const dir = mkdtempSync(join(tmpdir(), 'crp-mcp-preflight-'))
  try {
    const envFile = join(dir, 'mcp.env')
    writeFileSync(envFile, config)
    return spawnSync('bash', ['-c', `set -euo pipefail
image=example.invalid/crp:release-test
mcp_config_file="$MCP_TEST_FILE"
worker_env_file="$MCP_TEST_FILE"
worker_replicas=4
docker() { if [[ "$1" == network ]]; then return 0; fi; command docker "$@"; }
web_compose() { :; }
worker_compose() { :; }
${preflight}
validate_compose
`], {
      cwd: root,
      env: { ...process.env, MCP_TEST_FILE: envFile },
      encoding: 'utf8',
      timeout: 10000,
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const validConfig = [
  'CRP_SUPABASE_ANON_KEY=local-test-anon',
  'CRP_EMAIL=reviewer@example.invalid',
  "CRP_PASSWORD='local-test-$password'",
  'CRP_PLATFORM_WEB_URL="http://review.example.invalid"',
  'CRP_MCP_TOKENS=test-client:0123456789abcdef0123',
].join('\n')

it.skipIf(!hasCompose)('release preflight accepts Compose-quoted credentials without printing their values', () => {
  const result = checkPreflight(validConfig)
  expect(result.status).toBe(0)
  expect(result.stdout + result.stderr).not.toContain('local-test-$password')
})

it.skipIf(!hasCompose)('release preflight rejects an empty caller token before updating services', () => {
  const result = checkPreflight(validConfig.replace('test-client:0123456789abcdef0123', ''))
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('MCP 配置缺少必填项：CRP_MCP_TOKENS')
  expect(result.stdout + result.stderr).not.toContain('local-test-$password')
})

it.skipIf(!hasCompose)('MCP runs from the release image on the existing Supabase network with a loopback-only host port', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crp-mcp-compose-'))
  try {
    const envFile = join(dir, 'mcp.env')
    writeFileSync(envFile, [
      'CRP_SUPABASE_ANON_KEY=local-test-anon',
      'CRP_EMAIL=reviewer@example.invalid',
      'CRP_PASSWORD=local-test-password',
      'CRP_PLATFORM_WEB_URL=http://review.example.invalid',
      'CRP_MCP_TOKENS=test-client:0123456789abcdef0123',
      'CRP_MCP_ALLOW_NO_AUTH=true',
      'CRP_SUPABASE_URL=http://incorrect.example.invalid',
      'CRP_MCP_HOST=127.0.0.1',
    ].join('\n'))
    const config = JSON.parse(execFileSync('docker', [
      'compose', '-p', 'crp-mcp-check',
      '-f', join(root, 'deploy/supabase-selfhost/docker-compose.mcp.yml'),
      'config', '--format', 'json',
    ], {
      env: {
        ...process.env,
        CRP_APP_IMAGE: 'example.invalid/crp:release-test',
        CRP_MCP_CONFIG_FILE: envFile,
      },
      encoding: 'utf8',
    }))

    const service = config.services.mcp
    expect(service.image).toBe('example.invalid/crp:release-test')
    expect(service.command).toEqual(['node', '/app/mcp/code-review-mcp/src/index.mjs'])
    expect(service.environment.CRP_SUPABASE_URL).toBe('http://crp-supabase-api:8000')
    expect(service.environment.CRP_MCP_HOST).toBe('0.0.0.0')
    expect(service.environment.CRP_MCP_ALLOW_NO_AUTH).toBe('false')
    expect(service.ports).toEqual([expect.objectContaining({
      host_ip: '127.0.0.1',
      published: '8848',
      target: 8848,
    })])
    expect(Object.keys(service.networks)).toEqual(['supabase'])
    expect(config.networks.supabase).toEqual(expect.objectContaining({
      external: true,
      name: 'crp-selfhost-net',
    }))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
