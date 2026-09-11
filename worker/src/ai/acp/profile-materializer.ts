/**
 * Materialize a private, per-attempt DSH_HOME containing the hardened
 * `code-review-acp` profile.
 *
 * Nothing is shared between attempts: each one gets its own 0700 tree, its own
 * generated route overlay, and its own broker socket path. The model API key is
 * never written to any file — the route names an environment variable, and the
 * supervisor passes that variable only to this attempt's child process.
 */

import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ACP_PROFILE_NAME = 'code-review-acp'

/** Plugin packages the profile patch references by name. */
export const HARNESS_PLUGIN_PACKAGES = {
  '@codereview/harness-volatile-session-persistence': 'volatile-session-persistence',
  '@codereview/harness-model-budget-governor': 'model-budget-governor',
  '@codereview/harness-snapshot-tools': 'snapshot-tools',
  '@codereview/harness-review-control-tool': 'review-control-tool',
} as const

export interface ModelRouteSpec {
  /** Route key used by llm-pi-ai and referenced by the ACP surface. */
  providerId: string
  displayName: string
  baseUrl: string
  modelName: string
  contextWindow: number
  maxTokens: number
  /** Name of the environment variable holding the key. Never the key itself. */
  apiKeyEnvVar: string
  requestTimeoutMs: number
}

export interface BudgetSpec {
  maxTotalRequests: number
  maxLoopRequests: number
  maxRetryRequests: number
  maxCompactionRequests: number
}

/**
 * 在 spawn 之前校验预算，缺一个键就直接失败。
 *
 * 这一步存在的理由：预算不完整时，Harness 侧的表现是 agent fiber 在第一次模型请求
 * 被拒时销毁，turn 返回 `cancelled`、stderr 全空、零个 update —— 平台侧完全查不出
 * 原因。dsh 内部的失败在诊断上是黑箱，所以这类配置错误必须挡在 worker 侧，
 * 由带日志和错误落库的一侧报出来。
 */
export function assertBudgets(budgets: BudgetSpec): BudgetSpec {
  const required: Array<[keyof BudgetSpec, number]> = [
    ['maxTotalRequests', 1],
    ['maxLoopRequests', 1],
    // retry / compaction 允许为 0：不给重试或压缩预算是合理配置。
    ['maxRetryRequests', 0],
    ['maxCompactionRequests', 0],
  ]
  const problems: string[] = []
  for (const [key, min] of required) {
    const value = budgets?.[key]
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min) {
      problems.push(`${key} must be an integer >= ${min}, got ${JSON.stringify(value)}`)
    }
  }
  if (budgets && budgets.maxTotalRequests < budgets.maxLoopRequests) {
    problems.push(
      `maxTotalRequests (${budgets.maxTotalRequests}) must be at least maxLoopRequests (${budgets.maxLoopRequests})`,
    )
  }
  if (problems.length > 0) {
    throw new Error(`invalid Harness model budget: ${problems.join('; ')}`)
  }
  return { ...budgets }
}

export interface AttemptProfileSpec {
  taskId: string
  agentAttempt: number
  /** Directory that will hold every per-attempt tree. */
  attemptsRoot: string
  route: ModelRouteSpec
  budgets: BudgetSpec
  broker: {
    socketPath: string
    token: string
    requestTimeoutMs?: number
  }
  /** Repository names pinned for this job, surfaced in tool descriptions. */
  repositories?: string[]
}

export interface MaterializedAttemptProfile {
  attemptRoot: string
  dshHome: string
  profileName: string
  profileDir: string
  /** Absolute path passed to `dsh --patch`. */
  patchPath: string
  /** Stable hash of the resolved configuration, excluding all secrets. */
  configHash: string
  cleanup(): void
}

function moduleDir(): string {
  return dirname(fileURLToPath(import.meta.url))
}

/** Walk up from `start` until `relative` exists. */
function findUpwards(start: string, relative: string): string | null {
  let current = start
  for (let depth = 0; depth < 8; depth++) {
    if (existsSync(join(current, relative))) {
      return join(current, relative)
    }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return null
}

/**
 * Locate the checked-in profile template. Explicit configuration wins so a
 * container image can place the template anywhere.
 */
export function resolveProfileTemplateDir(): string {
  const override = process.env.HARNESS_PROFILE_TEMPLATE_DIR
  if (override) {
    const templatePackage = join(override, 'package.json')
    if (!existsSync(templatePackage)) {
      throw new Error(
        `HARNESS_PROFILE_TEMPLATE_DIR does not contain a profile package.json: ${override}`,
      )
    }
    return resolve(override)
  }
  const found = findUpwards(
    moduleDir(),
    join('worker', 'harness', ACP_PROFILE_NAME, 'package.json'),
  )
  if (!found) {
    throw new Error(
      `unable to locate the ${ACP_PROFILE_NAME} profile template; set HARNESS_PROFILE_TEMPLATE_DIR`,
    )
  }
  return dirname(found)
}

/**
 * Locate a built plugin entry. The Harness child process is a separate Node
 * process, so it can only load compiled JavaScript.
 */
export function resolvePluginEntry(directoryName: string): string {
  const override = process.env.HARNESS_PLUGIN_ROOT
  const candidates = [
    ...(override ? [join(override, directoryName, 'index.js')] : []),
    join(moduleDir(), '..', '..', 'harness-plugins', directoryName, 'index.js'),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return resolve(candidate)
  }
  const built = findUpwards(
    moduleDir(),
    join('dist-worker', 'harness-plugins', directoryName, 'index.js'),
  )
  if (built) return built
  throw new Error(
    `built Harness plugin not found: ${directoryName}. Run "npm run worker:build" or set HARNESS_PLUGIN_ROOT`,
  )
}

/**
 * Build the per-attempt overlay. It is emitted as JSON, which is valid YAML,
 * so no hand-rolled escaping can corrupt a path or a token.
 */
export function buildAttemptPatch(spec: AttemptProfileSpec): unknown[] {
  return [
    {
      id: 'llm-pi-ai',
      config: {
        providers: {
          [spec.route.providerId]: {
            displayName: spec.route.displayName,
            apiKeyEnv: spec.route.apiKeyEnvVar,
            api: 'openai-completions',
            baseURL: spec.route.baseUrl,
            retryPolicy: { mode: 'normal', maxRetries: 0 },
            models: [
              {
                id: spec.route.modelName,
                name: spec.route.modelName,
                contextWindow: spec.route.contextWindow,
                maxTokens: spec.route.maxTokens,
              },
            ],
          },
        },
      },
    },
    {
      id: 'agent-default-model',
      config: { provider: spec.route.providerId, model: spec.route.modelName },
    },
    {
      id: 'acp',
      config: { provider: spec.route.providerId, model: spec.route.modelName },
    },
    { id: 'model-budget-governor', config: assertBudgets(spec.budgets) },
    {
      id: 'snapshot-tools',
      config: {
        socketPath: spec.broker.socketPath,
        token: spec.broker.token,
        taskId: spec.taskId,
        agentAttempt: spec.agentAttempt,
        requestTimeoutMs: spec.broker.requestTimeoutMs ?? 30000,
        repositories: spec.repositories ?? [],
      },
    },
    {
      id: 'review-control-tool',
      config: {
        socketPath: spec.broker.socketPath,
        token: spec.broker.token,
        taskId: spec.taskId,
        agentAttempt: spec.agentAttempt,
        requestTimeoutMs: spec.broker.requestTimeoutMs ?? 30000,
      },
    },
  ]
}

/** Hash the resolved configuration with every secret replaced by its shape. */
export function computeConfigHash(
  templateDir: string,
  patch: unknown[],
  pluginEntries: Record<string, string>,
): string {
  const redactedPatch = JSON.parse(JSON.stringify(patch)) as Array<{
    id?: string
    config?: Record<string, unknown>
  }>
  for (const row of redactedPatch) {
    if ((row.id === 'review-control-tool' || row.id === 'snapshot-tools') && row.config) {
      row.config.token = `sha256:${createHash('sha256')
        .update(String(row.config.token))
        .digest('hex')}`
      row.config.socketPath = '[per-attempt-socket]'
    }
  }
  const hash = createHash('sha256')
  hash.update(readFileSync(join(templateDir, 'package.json')))
  hash.update(readFileSync(join(templateDir, 'cordis.patch.yml')))
  hash.update(JSON.stringify(redactedPatch))
  hash.update(JSON.stringify(Object.keys(pluginEntries).sort()))
  return hash.digest('hex')
}

export function materializeAttemptProfile(
  spec: AttemptProfileSpec,
): MaterializedAttemptProfile {
  const templateDir = resolveProfileTemplateDir()
  mkdirSync(spec.attemptsRoot, { recursive: true, mode: 0o700 })
  const attemptRoot = mkdtempSync(join(spec.attemptsRoot, 'attempt-'))
  chmodSync(attemptRoot, 0o700)

  try {
    const dshHome = join(attemptRoot, 'dsh-home')
    const profileDir = join(dshHome, 'profiles', ACP_PROFILE_NAME)
    mkdirSync(profileDir, { recursive: true, mode: 0o700 })
    cpSync(join(templateDir, 'package.json'), join(profileDir, 'package.json'))
    cpSync(join(templateDir, 'cordis.patch.yml'), join(profileDir, 'cordis.patch.yml'))
    // The launcher's own profile initialization writes this; a hand-built
    // profile directory must provide it too or module linking misbehaves.
    cpSync(join(templateDir, 'pnpm-workspace.yaml'), join(profileDir, 'pnpm-workspace.yaml'))

    // Link the platform's plugin packages into the profile's own node_modules.
    // A generated re-export shim keeps the real implementation in the worker
    // build tree, so both processes share one module instance graph.
    const pluginEntries: Record<string, string> = {}
    for (const [packageName, directoryName] of Object.entries(HARNESS_PLUGIN_PACKAGES)) {
      const entry = resolvePluginEntry(directoryName)
      pluginEntries[packageName] = entry
      const packageDir = join(profileDir, 'node_modules', ...packageName.split('/'))
      mkdirSync(packageDir, { recursive: true, mode: 0o700 })
      writeFileSync(
        join(packageDir, 'package.json'),
        `${JSON.stringify(
          {
            name: packageName,
            version: '0.0.0',
            private: true,
            type: 'module',
            main: './index.mjs',
            exports: { '.': './index.mjs' },
          },
          null,
          2,
        )}\n`,
        { mode: 0o600 },
      )
      writeFileSync(
        join(packageDir, 'index.mjs'),
        `export * from ${JSON.stringify(pathToImportUrl(entry))}\n`,
        { mode: 0o600 },
      )
    }

    const patch = buildAttemptPatch(spec)
    const patchPath = join(dshHome, 'attempt-route.patch.yml')
    writeFileSync(patchPath, `${JSON.stringify(patch, null, 2)}\n`, { mode: 0o600 })

    return {
      attemptRoot,
      dshHome,
      profileName: ACP_PROFILE_NAME,
      profileDir,
      patchPath,
      configHash: computeConfigHash(templateDir, patch, pluginEntries),
      cleanup: () => {
        rmSync(attemptRoot, { recursive: true, force: true })
      },
    }
  } catch (err) {
    rmSync(attemptRoot, { recursive: true, force: true })
    throw err
  }
}

function pathToImportUrl(absolutePath: string): string {
  return new URL(`file://${absolutePath}`).href
}
