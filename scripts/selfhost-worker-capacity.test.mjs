import { describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const script = readFileSync(join(root, 'deploy/supabase-selfhost/scripts/release.sh'), 'utf8')
const verification = script.slice(script.indexOf('verify_worker() {'), script.indexOf('\nwrite_state() {'))
const replicaAssignment = script.match(/^worker_replicas=\d+$/m)?.[0]

function verify(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'crp-capacity-'))
  try {
    writeFileSync(join(dir, 'docker'), `#!/usr/bin/env bash
case "$1" in
  ps) for ((i=1; i<=\${TEST_REPLICAS:-4}; i++)); do echo "worker-$i"; done ;;
  exec) echo "\${TEST_CONCURRENCY:-2}" ;;
  logs) if [[ "\${@: -1}" != "\${TEST_MISSING_ID:-}" ]]; then echo '{"event":"worker_started"}'; fi ;;
  *) exit 1 ;;
esac
`, { mode: 0o700 })
    return spawnSync('bash', ['-c', `set -euo pipefail\n${replicaAssignment}\nsleep() { :; }\n${verification}\nverify_worker`], {
      encoding: 'utf8',
      env: { ...process.env, PATH: dir + ':' + process.env.PATH, ...overrides },
      timeout: 15000,
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('self-hosted Worker capacity verification', () => {
  it('accepts the four started replicas with concurrency two', () => {
    const result = verify()
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('4 个副本，每个并发 2')
  })
  it.each([
    ['only three replicas', { TEST_REPLICAS: '3' }],
    ['one of four replicas has not started', { TEST_MISSING_ID: 'worker-4' }],
    ['legacy concurrency one', { TEST_CONCURRENCY: '1' }],
    ['no replicas', { TEST_REPLICAS: '0' }],
  ])('rejects %s', (_label, overrides) => {
    const result = verify(overrides)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Worker 检查失败')
  })
})

const hasCompose = spawnSync('docker', ['compose', 'version'], { stdio: 'ignore' }).status === 0
it.skipIf(!hasCompose)('company Compose overrides legacy concurrency and retains only the Supabase network', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crp-compose-'))
  try {
    const envFile = join(dir, 'worker.env')
    writeFileSync(envFile, 'WORKER_STORY_CONCURRENCY=1\nSUPABASE_URL=http://example.invalid\n')
    const config = JSON.parse(execFileSync('docker', [
      'compose', '-p', 'crp-capacity-check',
      '-f', join(root, 'docker-compose.worker.yml'),
      '-f', join(root, 'deploy/supabase-selfhost/worker.override.yml'),
      '-f', join(root, 'deploy/supabase-selfhost/worker.image.yml'),
      'config', '--format', 'json',
    ], { env: { ...process.env, WORKER_ENV_FILE: envFile, CRP_APP_IMAGE: 'example.invalid/crp:test' }, encoding: 'utf8' }))
    expect(config.services.worker.environment.WORKER_STORY_CONCURRENCY).toBe('2')
    expect(Object.keys(config.services.worker.networks)).toEqual(['supabase'])
    expect(config.networks.supabase.external).toBe(true)
    expect(config.networks.supabase.name).toBe('crp-selfhost-net')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

it('hands the selected image and four replicas to the drain restart even with an old exported image', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crp-release-drain-'))
  try {
    const out = join(dir, 'call.txt')
    writeFileSync(join(dir, 'bash'), '#!/bin/sh\nprintf "%s\\n" "$CRP_APP_IMAGE" "$@" > "$CAPACITY_CALL"\n', { mode: 0o700 })
    const start = script.indexOf('CRP_APP_IMAGE="$image" bash scripts/worker-drain-restart.sh')
    expect(start).toBeGreaterThan(0)
    const call = script.slice(start, script.indexOf('\nverify_worker', start))
    const result = spawnSync('/bin/bash', ['-c', `set -euo pipefail\n${replicaAssignment}\nimage=example.invalid/crp:new\nworker_env_file=/tmp/worker.env\nworker_timeout=60\n${call}`], {
      encoding: 'utf8',
      env: { ...process.env, PATH: dir + ':' + process.env.PATH, CAPACITY_CALL: out, CRP_APP_IMAGE: 'example.invalid/crp:old' },
    })
    expect(result.status).toBe(0)
    const args = readFileSync(out, 'utf8').trim().split('\n')
    expect(args[0]).toBe('example.invalid/crp:new')
    expect(args[args.indexOf('--scale') + 1]).toBe('4')
    expect(args).toContain('deploy/supabase-selfhost/worker.override.yml')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
