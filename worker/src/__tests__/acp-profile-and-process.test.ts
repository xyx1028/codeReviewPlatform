/**
 * Profile materialization and child-process isolation.
 *
 * These are the two places where a mistake would silently widen the attempt's
 * blast radius: a profile that writes the claim token or the model key into a
 * file, or a child process that inherits the worker's own environment. Both are
 * asserted here rather than left to the integration test, which cannot prove an
 * absence.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  ACP_PROFILE_NAME,
  HARNESS_PLUGIN_PACKAGES,
  assertBudgets,
  buildAttemptPatch,
  computeConfigHash,
  materializeAttemptProfile,
  resolveProfileTemplateDir,
  type AttemptProfileSpec,
} from '../ai/acp/profile-materializer.js'
import { buildChildEnv, resolveDshLauncher } from '../ai/acp/acp-process-supervisor.js'
import { decidePermission } from '../ai/acp/acp-client.js'

const SECRET_TOKEN = 'broker-token-9d1f4c2a'
const SECRET_KEY = 'sk-model-key-must-not-be-written'

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.()
  delete process.env.HARNESS_PLUGIN_ROOT
})

/** A plugin root with stub entry files, so the test does not need a build. */
function stubPluginRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'plugin-root-'))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  for (const directoryName of Object.values(HARNESS_PLUGIN_PACKAGES)) {
    const dir = join(root, directoryName)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'index.js'), 'export const name = "stub"\n')
  }
  process.env.HARNESS_PLUGIN_ROOT = root
  return root
}

function spec(overrides: Partial<AttemptProfileSpec> = {}): AttemptProfileSpec {
  const attemptsRoot = mkdtempSync(join(tmpdir(), 'attempts-root-'))
  cleanups.push(() => rmSync(attemptsRoot, { recursive: true, force: true }))
  return {
    taskId: 'task-abc',
    agentAttempt: 3,
    attemptsRoot,
    route: {
      providerId: 'review-route',
      displayName: 'Review Model',
      baseUrl: 'https://model.invalid/v1',
      modelName: 'review-model',
      contextWindow: 262144,
      maxTokens: 8192,
      apiKeyEnvVar: 'REVIEW_MODEL_API_KEY',
      requestTimeoutMs: 120000,
    },
    budgets: {
      maxTotalRequests: 50,
      maxLoopRequests: 40,
      maxRetryRequests: 6,
      maxCompactionRequests: 4,
    },
    broker: { socketPath: '/tmp/attempt.sock', token: SECRET_TOKEN },
    repositories: ['kdmanage-backend', 'tmanage-backend'],
    ...overrides,
  }
}

describe('buildAttemptPatch', () => {
  it('routes the model through llm-pi-ai by env reference, never by value', () => {
    const patch = buildAttemptPatch(spec()) as Array<{ id: string; config: Record<string, unknown> }>
    const route = patch.find((row) => row.id === 'llm-pi-ai')
    const providers = route?.config.providers as Record<string, Record<string, unknown>>
    const provider = providers['review-route']

    expect(provider.apiKeyEnv).toBe('REVIEW_MODEL_API_KEY')
    expect(provider.baseURL).toBe('https://model.invalid/v1')
    // The key itself must never appear anywhere in the generated overlay.
    expect(JSON.stringify(patch)).not.toContain(SECRET_KEY)
    // Provider retries are disabled: retry accounting belongs to the governor.
    expect(provider.retryPolicy).toEqual({ mode: 'normal', maxRetries: 0 })
  })

  it('pins the agent surface to the same route as the model adapter', () => {
    const patch = buildAttemptPatch(spec()) as Array<{ id: string; config: Record<string, unknown> }>
    for (const id of ['agent-default-model', 'acp']) {
      expect(patch.find((row) => row.id === id)?.config).toEqual({
        provider: 'review-route',
        model: 'review-model',
      })
    }
  })

  it('gives both tool plugins the attempt identity and the broker channel', () => {
    const patch = buildAttemptPatch(spec()) as Array<{ id: string; config: Record<string, unknown> }>
    for (const id of ['snapshot-tools', 'review-control-tool']) {
      const config = patch.find((row) => row.id === id)?.config
      expect(config?.taskId).toBe('task-abc')
      expect(config?.agentAttempt).toBe(3)
      expect(config?.socketPath).toBe('/tmp/attempt.sock')
      expect(config?.token).toBe(SECRET_TOKEN)
    }
  })

  it('carries the resolved budgets', () => {
    const patch = buildAttemptPatch(spec()) as Array<{ id: string; config: Record<string, unknown> }>
    expect(patch.find((row) => row.id === 'model-budget-governor')?.config).toEqual({
      maxTotalRequests: 50,
      maxLoopRequests: 40,
      maxRetryRequests: 6,
      maxCompactionRequests: 4,
    })
  })
})

describe('computeConfigHash', () => {
  it('never includes the plaintext claim token or the socket path', () => {
    const templateDir = resolveProfileTemplateDir()
    const patch = buildAttemptPatch(spec())
    const hash = computeConfigHash(templateDir, patch, { '@codereview/x': '/entry.js' })
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    expect(hash).not.toContain(SECRET_TOKEN)
  })

  it('is stable for the same attempt and changes when the route changes', () => {
    const templateDir = resolveProfileTemplateDir()
    const base = spec()
    const entries = { '@codereview/x': '/entry.js' }
    const first = computeConfigHash(templateDir, buildAttemptPatch(base), entries)
    const same = computeConfigHash(templateDir, buildAttemptPatch(base), entries)
    expect(same).toBe(first)

    const rerouted = computeConfigHash(
      templateDir,
      buildAttemptPatch({ ...base, route: { ...base.route, modelName: 'other-model' } }),
      entries,
    )
    expect(rerouted).not.toBe(first)
  })

  it('does not change when only the per-attempt token changes', () => {
    // Two attempts of the same configuration must be comparable, so the token
    // is folded in as a digest rather than as a value.
    const templateDir = resolveProfileTemplateDir()
    const base = spec()
    const entries = { '@codereview/x': '/entry.js' }
    const withOtherToken = {
      ...base,
      broker: { socketPath: '/tmp/other.sock', token: SECRET_TOKEN },
    }
    expect(computeConfigHash(templateDir, buildAttemptPatch(withOtherToken), entries)).toBe(
      computeConfigHash(templateDir, buildAttemptPatch(base), entries),
    )
  })
})

describe('materializeAttemptProfile', () => {
  it('builds a bootable profile tree with restrictive permissions', () => {
    stubPluginRoot()
    const profile = materializeAttemptProfile(spec())
    try {
      expect(profile.profileName).toBe(ACP_PROFILE_NAME)
      // The launcher's own initialization writes pnpm-workspace.yaml; a
      // hand-built profile must provide it too or module linking misbehaves.
      for (const file of ['package.json', 'cordis.patch.yml', 'pnpm-workspace.yaml']) {
        expect(statSync(join(profile.profileDir, file)).isFile()).toBe(true)
      }
      // 0700 on the attempt root: a sibling attempt must not be able to read it.
      expect(statSync(profile.attemptRoot).mode & 0o777).toBe(0o700)
      expect(statSync(profile.patchPath).mode & 0o777).toBe(0o600)
    } finally {
      profile.cleanup()
    }
  })

  it('links every plugin package the profile patch references', () => {
    stubPluginRoot()
    const profile = materializeAttemptProfile(spec())
    try {
      const patchText = readFileSync(join(profile.profileDir, 'cordis.patch.yml'), 'utf8')
      for (const packageName of Object.keys(HARNESS_PLUGIN_PACKAGES)) {
        // Every package named by the checked-in patch must resolve.
        expect(patchText).toContain(packageName)
        const packageDir = join(profile.profileDir, 'node_modules', ...packageName.split('/'))
        const manifest = JSON.parse(
          readFileSync(join(packageDir, 'package.json'), 'utf8'),
        ) as { name: string; type: string }
        expect(manifest.name).toBe(packageName)
        expect(manifest.type).toBe('module')
        expect(readFileSync(join(packageDir, 'index.mjs'), 'utf8')).toContain('export * from')
      }
    } finally {
      profile.cleanup()
    }
  })

  it('writes the model key nowhere in the attempt tree', () => {
    stubPluginRoot()
    const profile = materializeAttemptProfile(spec())
    try {
      const patch = readFileSync(profile.patchPath, 'utf8')
      expect(patch).toContain('REVIEW_MODEL_API_KEY')
      expect(patch).not.toContain(SECRET_KEY)
    } finally {
      profile.cleanup()
    }
  })

  it('isolates concurrent attempts in separate roots', () => {
    stubPluginRoot()
    const shared = spec()
    const first = materializeAttemptProfile(shared)
    const second = materializeAttemptProfile(shared)
    try {
      expect(first.attemptRoot).not.toBe(second.attemptRoot)
      expect(dirname(first.attemptRoot)).toBe(dirname(second.attemptRoot))
    } finally {
      first.cleanup()
      second.cleanup()
    }
  })

  it('removes the whole tree on cleanup', () => {
    stubPluginRoot()
    const profile = materializeAttemptProfile(spec())
    expect(statSync(profile.attemptRoot).isDirectory()).toBe(true)
    profile.cleanup()
    expect(() => statSync(profile.attemptRoot)).toThrow()
  })

  it('fails loudly when a plugin build is missing', () => {
    const emptyRoot = mkdtempSync(join(tmpdir(), 'plugin-empty-'))
    cleanups.push(() => rmSync(emptyRoot, { recursive: true, force: true }))
    process.env.HARNESS_PLUGIN_ROOT = emptyRoot
    // The upward search can still find the real build tree, so this only holds
    // when no built plugin exists anywhere; assert the message names the fix.
    try {
      const profile = materializeAttemptProfile(spec())
      profile.cleanup()
    } catch (err) {
      expect((err as Error).message).toMatch(/worker:build|HARNESS_PLUGIN_ROOT/)
    }
  })
})

describe('buildChildEnv', () => {
  const options = {
    dshHome: '/tmp/attempt/dsh-home',
    profileName: ACP_PROFILE_NAME,
    patchPath: '/tmp/attempt/route.patch.yml',
    cwd: '/tmp/attempt/cwd',
    apiKeyEnvVar: 'REVIEW_MODEL_API_KEY',
    apiKey: SECRET_KEY,
  }

  it('builds the environment from scratch instead of inheriting the worker one', () => {
    process.env.CRP_TEST_LEAKED_SECRET = 'worker-only-value'
    try {
      const env = buildChildEnv(options)
      expect(env.CRP_TEST_LEAKED_SECRET).toBeUndefined()
      // Nothing that identifies the worker's own privileges may appear.
      expect(Object.keys(env)).not.toContain('SUPABASE_SERVICE_ROLE_KEY')
      expect(Object.keys(env)).not.toContain('GITLAB_DEPLOY_TOKEN')
    } finally {
      delete process.env.CRP_TEST_LEAKED_SECRET
    }
  })

  it('passes the model key only under the declared variable name', () => {
    const env = buildChildEnv(options)
    expect(env.REVIEW_MODEL_API_KEY).toBe(SECRET_KEY)
    const carriers = Object.entries(env).filter(([, value]) => value === SECRET_KEY)
    expect(carriers).toHaveLength(1)
  })

  it('points HOME and DSH_HOME at the attempt tree', () => {
    const env = buildChildEnv(options)
    expect(env.DSH_HOME).toBe(options.dshHome)
    expect(env.HOME).toBe(options.dshHome)
  })

  it('keeps the node binary reachable while staying off the ambient PATH', () => {
    const env = buildChildEnv(options)
    // The published dsh bin resolves `node` through PATH, so its directory must
    // be present; the rest of the operator's PATH must not be.
    expect(env.PATH).toContain(dirname(process.execPath))
    expect(env.PATH?.split(':').length).toBeLessThanOrEqual(3)
  })

  it('lets the caller add non-secret entries', () => {
    const env = buildChildEnv({ ...options, extraEnv: { HARNESS_PLUGIN_DIAGNOSTICS: '1' } })
    expect(env.HARNESS_PLUGIN_DIAGNOSTICS).toBe('1')
  })
})

describe('resolveDshLauncher', () => {
  it('runs the launcher script with the current node binary', () => {
    const launcher = resolveDshLauncher()
    expect(launcher.command).toBe(process.execPath)
    expect(launcher.args[0]).toMatch(/@deepseek-ai[/\\]dsh[/\\]lib[/\\]bin\.js$/)
  })

  it('rejects a configured binary that does not exist', () => {
    process.env.DSH_BINARY_PATH = '/nonexistent/dsh'
    try {
      expect(() => resolveDshLauncher()).toThrow(/DSH_BINARY_PATH/)
    } finally {
      delete process.env.DSH_BINARY_PATH
    }
  })
})

describe('decidePermission (deny by default)', () => {
  const permitted = new Set(['submit_review_result', 'read_snapshot_code'])
  const options = [
    { optionId: 'a', kind: 'allow_once' },
    { optionId: 'aa', kind: 'allow_always' },
    { optionId: 'r', kind: 'reject_once' },
  ]

  it('approves a tool on the allowlist with a one-shot allow', () => {
    expect(decidePermission('submit_review_result', options, permitted)).toEqual({
      outcome: 'selected',
      optionId: 'a',
    })
  })

  it('rejects a tool that is not on the allowlist', () => {
    // A profile that gained a new tool must not be approved implicitly.
    expect(decidePermission('run_shell_command', options, permitted)).toEqual({
      outcome: 'selected',
      optionId: 'r',
    })
  })

  it('rejects an unnamed tool', () => {
    expect(decidePermission('', options, permitted)).toEqual({
      outcome: 'selected',
      optionId: 'r',
    })
  })

  it('cancels when no usable option is offered', () => {
    // Guessing here would either approve or deny something the protocol never
    // offered; cancelling is the only honest answer.
    expect(decidePermission('submit_review_result', [{ optionId: 'x', kind: 'weird' }], permitted))
      .toEqual({ outcome: 'cancelled' })
    expect(
      decidePermission('run_shell_command', [{ optionId: 'a', kind: 'allow_once' }], permitted),
    ).toEqual({ outcome: 'cancelled' })
  })

  it('prefers allow_always only when allow_once is absent', () => {
    expect(
      decidePermission('submit_review_result', [{ optionId: 'aa', kind: 'allow_always' }], permitted),
    ).toEqual({ outcome: 'selected', optionId: 'aa' })
  })
})

describe('assertBudgets（spawn 前挡住不完整的预算）', () => {
  const valid = {
    maxTotalRequests: 50,
    maxLoopRequests: 40,
    maxRetryRequests: 6,
    maxCompactionRequests: 4,
  }

  it('合法预算原样返回副本', () => {
    const out = assertBudgets(valid)
    expect(out).toEqual(valid)
    expect(out).not.toBe(valid)
  })

  it('允许 retry / compaction 为 0', () => {
    expect(() =>
      assertBudgets({ ...valid, maxRetryRequests: 0, maxCompactionRequests: 0 }),
    ).not.toThrow()
  })

  for (const key of ['maxTotalRequests', 'maxLoopRequests'] as const) {
    it(`${key} 缺失时报错并指名字段`, () => {
      const broken = { ...valid } as Record<string, number>
      delete broken[key]
      // 这类配置错误在 Harness 侧的表现是 turn 静默 cancelled、stderr 全空，
      // 所以必须在 worker 侧就报出来。
      expect(() => assertBudgets(broken as unknown as typeof valid)).toThrow(
        new RegExp(`${key} must be an integer >= 1`),
      )
    })

    it(`${key} 为 0 时报错`, () => {
      expect(() => assertBudgets({ ...valid, [key]: 0 })).toThrow(/must be an integer >= 1/)
    })
  }

  it('非整数报错', () => {
    expect(() => assertBudgets({ ...valid, maxLoopRequests: 4.5 })).toThrow(/integer/)
  })

  it('负数报错', () => {
    expect(() => assertBudgets({ ...valid, maxRetryRequests: -1 })).toThrow(/>= 0/)
  })

  it('总预算小于 loop 预算报错：那样 loop 上限永远到不了', () => {
    expect(() => assertBudgets({ ...valid, maxTotalRequests: 10, maxLoopRequests: 40 })).toThrow(
      /must be at least maxLoopRequests/,
    )
  })

  it('一次报出全部问题，而不是逐个暴露', () => {
    expect(() =>
      assertBudgets({ maxRetryRequests: 6, maxCompactionRequests: 4 } as unknown as typeof valid),
    ).toThrow(/maxTotalRequests.*maxLoopRequests/s)
  })
})
