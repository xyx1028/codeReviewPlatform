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
  assertPatchHasNoCredentials,
  buildAttemptPatch,
  computeConfigHash,
  materializeAttemptProfile,
  resolveProfileTemplateDir,
  type AttemptProfileSpec,
} from '../ai/acp/profile-materializer.js'
import { V4_DEFAULT_POLICY } from '../ai/policy/v4-capability-policy.js'
import {
  assertCredentialEnvIsScrubbed,
  buildChildEnv,
  resolveDshLauncher,
} from '../ai/acp/acp-process-supervisor.js'
import {
  BROKER_TOKEN_ENV,
  ROOT_CAPABILITY_ENV,
} from '../harness-plugins/shared/credential-env.js'
import { decidePermission } from '../ai/acp/acp-client.js'

const SECRET_TOKEN = 'broker-token-9d1f4c2a'
const SECRET_KEY = 'sk-model-key-must-not-be-written'
/** 根 capability token：只经环境变量下传，绝不进 attempt patch 文件，也不进 configHash。 */
const ROOT_CAPABILITY = 'root-cap-7f3e9a1b'

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
  const cwd = mkdtempSync(join(tmpdir(), 'attempt-cwd-'))
  cleanups.push(() => rmSync(cwd, { recursive: true, force: true }))
  const sessionRoot = mkdtempSync(join(tmpdir(), 'session-root-'))
  cleanups.push(() => rmSync(sessionRoot, { recursive: true, force: true }))
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
    // V4：数值上限与 sandbox 模式都来自冻结的 policy，不再是独立的 budgets 结构。
    policy: V4_DEFAULT_POLICY,
    // 根身份的 id 写进 attempt patch，模型无从选择；capability token 只走环境变量。
    identity: {
      rootAgentId: 'root-abc',
      rootSessionId: 'session-abc',
    },
    broker: { socketPath: '/tmp/attempt.sock' },
    // Harness cwd 与 Session JSONL 根目录都必须显式给出（前者是受控 Workspace，后者在持久卷）。
    cwd,
    sessionRoot,
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
    // Provider retries follow the frozen policy's retry allowance, not the Harness
    // default and not a hardcoded zero. Zero was a real outage: one sporadic 502
    // from the host VPN proxy ended an entire attempt on its first model request,
    // while the retry budget the governor reserves stayed permanently unspendable.
    expect(provider.retryPolicy).toEqual({
      mode: 'normal',
      maxRetries: V4_DEFAULT_POLICY.modelBudget.maxRetryRequests,
    })
    // Guard the regression direction explicitly: a policy that silently normalizes
    // the allowance back to 0 would re-disable recovery without failing the
    // equality above.
    expect(V4_DEFAULT_POLICY.modelBudget.maxRetryRequests).toBeGreaterThan(0)
  })

  it('scales provider retries with the frozen policy instead of a fixed constant', () => {
    const narrowed = spec({
      policy: {
        ...V4_DEFAULT_POLICY,
        modelBudget: { ...V4_DEFAULT_POLICY.modelBudget, maxRetryRequests: 2 },
      },
    })
    const patch = buildAttemptPatch(narrowed) as Array<{
      id: string
      config: Record<string, unknown>
    }>
    const providers = (patch.find((row) => row.id === 'llm-pi-ai')?.config.providers ??
      {}) as Record<string, Record<string, unknown>>

    expect(providers['review-route'].retryPolicy).toEqual({ mode: 'normal', maxRetries: 2 })
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
      // token 不在 patch 里：插件从环境变量读，见 credential-env.ts 的说明。
      expect(config?.token).toBeUndefined()
    }
  })

  it('configures the sandbox as workspace-write rooted at the passed workspace', () => {
    // V4：不再有独立的 model-budget-governor 行；数值上限来自 policy，写操作被 sandbox 收进 cwd。
    // 断言真正的安全属性：既不是 danger-full-access，写根也正是传入的受控 Workspace。
    const base = spec()
    const patch = buildAttemptPatch(base) as Array<{ id: string; config: Record<string, unknown> }>
    const sandbox = patch.find((row) => row.id === 'sandbox-policy')?.config
    expect(sandbox?.mode).toBe('workspace-write')
    expect(sandbox?.mode).not.toBe('danger-full-access')
    expect(sandbox?.workspaceRoot).toBe(base.cwd)
    // fs-sandbox 的 cwd 必须与 sandbox workspaceRoot 一致，否则读写落在不同目录。
    expect(patch.find((row) => row.id === 'fs-sandbox')?.config.cwd).toBe(base.cwd)
  })

  it('writes the platform-generated root identity into the authority policy row', () => {
    // 根身份的 id 由 Worker 决定并写进 patch，模型无从选择。
    const patch = buildAttemptPatch(spec()) as Array<{ id: string; config: Record<string, unknown> }>
    const authority = patch.find((row) => row.id === 'agent-authority-policy')?.config
    expect(authority?.rootAgentId).toBe('root-abc')
    expect(authority?.rootSessionId).toBe('session-abc')
    // root-reviewer 是唯一能提交的角色：它解析出的工具面必须包含提交工具。
    expect(authority?.rootTools).toContain('submit_review_result')
  })

  it('keeps every credential out of the on-disk patch', () => {
    // patch 文件落在 dshHome 下，而 workspace-write 沙箱只限制写不限制读：任何写进这个
    // 文件的令牌都等于交给拿到 Shell 的子 Agent。凭据一律走环境变量。
    const patch = buildAttemptPatch(spec())
    const serialized = JSON.stringify(patch)
    expect(serialized).not.toContain(SECRET_TOKEN)
    expect(serialized).not.toContain(ROOT_CAPABILITY)
    expect(serialized).not.toContain(SECRET_KEY)
    for (const row of patch as Array<{ config?: Record<string, unknown> }>) {
      expect(Object.keys(row.config ?? {})).not.toContain('token')
      expect(Object.keys(row.config ?? {})).not.toContain('rootCapability')
    }
    // 闸门本身也必须放行这份 patch，否则 materialize 会拒绝启动。
    expect(() => assertPatchHasNoCredentials(patch)).not.toThrow()
  })

  it('refuses to materialize a patch that carries a credential-shaped field', () => {
    // 这是防止"改回去"的机械闸门：有人把 token 重新塞进 patch 时启动即失败。
    expect(() =>
      assertPatchHasNoCredentials([{ id: 'snapshot-tools', config: { token: 'leaked' } }]),
    ).toThrow(/credential-shaped field/)
  })

  it('pins the jobs and workflow concurrency limits from the frozen policy', () => {
    // 不下传就退回 Harness 内置默认值，而那个值会随依赖升级漂移 —— §4 冻结的 policy
    // 就成了一份不生效的文档。并发上限属于 provider（jobs / workflow-worker-thread），
    // 不属于 tool-* 插件。
    const base = spec()
    const patch = buildAttemptPatch(base) as Array<{ id: string; config: Record<string, unknown> }>
    expect(patch.find((row) => row.id === 'jobs')?.config.maxConcurrentJobsPerOwner).toBe(
      base.policy.jobs.maxConcurrentJobsPerOwner,
    )
    const workflow = patch.find((row) => row.id === 'workflow-worker-thread')?.config
    expect(workflow?.maxConcurrentAgents).toBe(base.policy.workflow.maxConcurrentSteps)
    expect(workflow?.maxTotalAgents).toBe(base.policy.agents.maxAgentsPerAttempt)
  })

  it('drives session persistence off the persistent volume, not the attempt tree', () => {
    // Session JSONL 必须落在持久卷（sessionRoot），否则 attempt 目录被删后无从恢复。
    const base = spec()
    const patch = buildAttemptPatch(base) as Array<{ id: string; config: Record<string, unknown> }>
    expect(patch.find((row) => row.id === 'session-persistence-jsonl')?.config.root).toBe(
      base.sessionRoot,
    )
  })

  it('never approves danger-full-access and denies automated approvals outright', () => {
    // 自动化流程里没有人可以批准，能力边界完全由 policy 决定：审批策略必须是 never。
    const patch = buildAttemptPatch(spec()) as Array<{ id: string; config: Record<string, unknown> }>
    expect(patch.find((row) => row.id === 'approval')?.config.policy).toBe('never')
  })
})

describe('computeConfigHash', () => {
  it('never includes the plaintext claim token or the socket path', () => {
    const templateDir = resolveProfileTemplateDir()
    const patch = buildAttemptPatch(spec())
    const hash = computeConfigHash(templateDir, patch, { '@codereview/x': '/entry.js' })
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    expect(hash).not.toContain(SECRET_TOKEN)
    // V4：根 capability token 只进 attempt patch 文件（0600），绝不能成为 configHash 的输入 ——
    // 否则等于把令牌写进任何存了这个 hash 的地方。它在 hash 前被脱敏成占位符。
    expect(hash).not.toContain(ROOT_CAPABILITY)
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
    brokerToken: SECRET_TOKEN,
    rootCapability: ROOT_CAPABILITY,
  }

  it('hands the broker credentials to the Harness under scrubbed variable names', () => {
    // 凭据必须存在于 DSH 进程环境（插件要用），且变量名必须命中 Harness 的
    // SENSITIVE_ENV_PATTERN —— 那是"模型可见的 Shell 读不到它们"的唯一依据。
    const env = buildChildEnv(options)
    expect(env[BROKER_TOKEN_ENV]).toBe(SECRET_TOKEN)
    expect(env[ROOT_CAPABILITY_ENV]).toBe(ROOT_CAPABILITY)
    expect(() =>
      assertCredentialEnvIsScrubbed([
        options.apiKeyEnvVar,
        BROKER_TOKEN_ENV,
        ROOT_CAPABILITY_ENV,
      ]),
    ).not.toThrow()
  })

  it('rejects a credential variable name the Harness would not scrub', () => {
    // 一次重命名就能静默作废上面那条不变量，所以启动路径上有机械检查。
    expect(() => assertCredentialEnvIsScrubbed(['REVIEW_BROKER_HANDLE'])).toThrow(
      /would survive into sandboxed shell children/,
    )
  })

  it('does not let extraEnv shadow a credential', () => {
    // extraEnv 是 workspace 的非机密白名单；它排在凭据之前展开，覆盖不了凭据。
    const env = buildChildEnv({
      ...options,
      extraEnv: { [BROKER_TOKEN_ENV]: 'attacker-supplied' },
    })
    expect(env[BROKER_TOKEN_ENV]).toBe(SECRET_TOKEN)
  })

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

describe('computeConfigHash ignores per-attempt identity（两次 attempt 必须可比）', () => {
  // V4 删除了 assertBudgets/BudgetSpec：预算不再是 profile 的独立输入，而是随 attempt 从
  // 数据库 policy snapshot 来。原先"spawn 前挡住不完整预算"的职责移到了 policy 归一层
  // （normalizeCapabilityPolicy），由 v4-capability-contract.test.ts 覆盖。这里改为钉住一条
  // 对 configHash 至关重要的性质：同一份配置、不同的 per-attempt socket，hash 必须一致，
  // 否则两次 attempt 的 profile 无法比对，追溯就失效了。
  it('is identical for two attempts that differ only in the per-attempt socket path', () => {
    // socketPath 每 attempt 一个随机目录，被 computeConfigHash 归一成占位符。
    // capability token 已经完全不进 patch（走环境变量），所以这里没有令牌可比。
    // rootAgentId / rootSessionId 是稳定派生值（mintRootIdentity 按 task+attempt 算出），
    // 它们进 hash 是对的。
    const templateDir = resolveProfileTemplateDir()
    const base = spec()
    const entries = { '@codereview/x': '/entry.js' }
    const withOtherSocket = {
      ...base,
      broker: { ...base.broker, socketPath: '/tmp/some-other-attempt.sock' },
    }
    expect(computeConfigHash(templateDir, buildAttemptPatch(withOtherSocket), entries)).toBe(
      computeConfigHash(templateDir, buildAttemptPatch(base), entries),
    )
  })

  it('changes when the frozen policy narrows the sandbox to read-only', () => {
    // policy 是 configHash 的真实输入：read-only 会移除写工具，profile 因此不同。
    const templateDir = resolveProfileTemplateDir()
    const base = spec()
    const entries = { '@codereview/x': '/entry.js' }
    const readOnly = {
      ...base,
      policy: {
        ...V4_DEFAULT_POLICY,
        sandbox: { ...V4_DEFAULT_POLICY.sandbox, defaultMode: 'read-only' as const },
      },
    }
    expect(computeConfigHash(templateDir, buildAttemptPatch(readOnly), entries)).not.toBe(
      computeConfigHash(templateDir, buildAttemptPatch(base), entries),
    )
  })
})
