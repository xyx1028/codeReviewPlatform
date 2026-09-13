/**
 * Materialize a private, per-attempt DSH_HOME containing the `code-review-acp`
 * V4 profile.
 *
 * Nothing is shared between attempts: each one gets its own 0700 tree, its own
 * generated route overlay, and its own broker socket path. The model API key is
 * never written to any file — the route names an environment variable, and the
 * supervisor passes that variable only to this attempt's child process.
 *
 * V4 相对 V3 多做四件事：
 *
 *   1. 把根身份（rootAgentId / rootSessionId / rootCapability）和根工具集写进 attempt patch，
 *      于是"谁是根 Agent"由平台决定，模型无从选择；
 *   2. 显式配置 Agent Tree 上限、并行工具数、Ralph 轮次、Jobs 并发和 sandbox 模式；
 *   3. 把 Session JSONL 根目录指向持久卷（不随 attempt 临时目录删除），并对齐 checkpoint 频率；
 *   4. cwd 指向受控 Workspace，而不是一个空的临时目录。
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
import {
  contractHash,
  loadCapabilityContract,
  resolveToolsForRole,
  type V4CapabilityPolicy,
} from '../policy/v4-capability-policy.js'

export const ACP_PROFILE_NAME = 'code-review-acp'

/** Plugin packages the profile patch references by name. */
export const HARNESS_PLUGIN_PACKAGES = {
  '@codereview/harness-agent-authority-policy': 'agent-authority-policy',
  '@codereview/harness-usage-reporter': 'usage-reporter',
  '@codereview/harness-platform-web': 'platform-web',
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

/** V4 的根身份。id 写进 attempt patch；capability token 只走环境变量，不落盘。 */
export interface RootIdentitySpec {
  rootAgentId: string
  rootSessionId: string
}

export interface AttemptProfileSpec {
  taskId: string
  agentAttempt: number
  /** Directory that will hold every per-attempt tree. */
  attemptsRoot: string
  route: ModelRouteSpec
  /** 冻结的 V4 能力策略。数值上限与 sandbox 模式都从这里取。 */
  policy: V4CapabilityPolicy
  identity: RootIdentitySpec
  broker: {
    socketPath: string
    requestTimeoutMs?: number
  }
  /** Harness cwd：受控的可写 Workspace。 */
  cwd: string
  /** Session JSONL 的根目录。必须位于持久卷，不随 attempt 目录删除。 */
  sessionRoot: string
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
  /** 冻结契约的摘要，与 profile hash 一起入库用于追溯。 */
  contractHash: string
  /** 根 Agent 解析出来的工具面，启动后与 resolved inventory 比对。 */
  rootTools: readonly string[]
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
 * 子 Agent 在 Harness 侧可见的工具面。
 *
 * 取所有 child 角色在深度 1 上各自允许工具的**并集**：`toolFilter` 是 per-tool-plugin 配置，
 * 一份过滤器服务全部 spawn 子 Agent，没法按角色分别给。所以这里只做"任何 child 都不可能用到
 * 的工具一律不出现"这一层收窄 —— 最关键的是 `submit_review_result` 必然被排除，因为它只属于
 * `root-reviewer`。
 *
 * 精确到角色的收窄仍由 `agent-authority-policy` 的 `tools/pre-execute` 承担（按注册身份的
 * `tools` 列表默认 deny）。两层的分工是：这里决定"模型看得见什么"，那里决定"模型调得动什么"。
 */
export function childToolSurface(policy: V4CapabilityPolicy): readonly string[] {
  const roles: Array<'research-child' | 'implementation-child' | 'critic-child' | 'workflow-child'> =
    ['research-child', 'implementation-child', 'critic-child', 'workflow-child']
  const union = new Set<string>()
  for (const role of roles) {
    for (const tool of resolveToolsForRole({ role, policy, delegationDepth: 1 })) {
      union.add(tool)
    }
  }
  return [...union].sort()
}

/**
 * Build the per-attempt overlay. It is emitted as JSON, which is valid YAML,
 * so no hand-rolled escaping can corrupt a path or a token.
 *
 * 这份 patch **不含任何凭据**。Broker bearer token 与根 capability token 走环境变量
 * （见 `harness-plugins/shared/credential-env.ts`）：patch 文件落在 dshHome 下，而
 * `workspace-write` 沙箱只限制写不限制读，凭据写进这个文件等于交给任何拿到 Shell 的
 * 子 Agent。
 */
export function buildAttemptPatch(spec: AttemptProfileSpec): unknown[] {
  const brokerConfig = {
    socketPath: spec.broker.socketPath,
    taskId: spec.taskId,
    agentAttempt: spec.agentAttempt,
    requestTimeoutMs: spec.broker.requestTimeoutMs ?? 30000,
  }
  const rootTools = resolveToolsForRole({
    role: 'root-reviewer',
    policy: spec.policy,
    delegationDepth: 0,
  })

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

    // ---- 全能力的显式数值配置 -------------------------------------------
    //
    // 这些行不能靠默认值：默认值是 Harness 的部署选择，而 V4 的上限来自冻结的 policy。
    // 不显式写就意味着"上限随依赖升级漂移"，那样 Release Gate 里的预算结论会失效。
    {
      id: 'agent-loop',
      config: {
        agents: [],
        // 只读、无副作用的工具允许并行；mutation 与 submit 由契约标成不可并行。
        maxParallelToolCalls: spec.policy.capabilities.parallelTools
          ? spec.policy.parallelTools.maxPerStep
          : 1,
      },
    },
    {
      id: 'sandbox-policy',
      config: {
        // 永远不是 danger-full-access。写操作只发生在这个 workspaceRoot 之内。
        mode: spec.policy.sandbox.defaultMode,
        workspaceRoot: spec.cwd,
      },
    },
    {
      id: 'bash-sandbox',
      config: { timeoutMs: spec.policy.sandbox.commandTimeoutMs },
    },
    {
      id: 'fs-sandbox',
      config: { cwd: spec.cwd },
    },
    {
      // 自动化流程里没有人可以批准，所以 approval 必须是 never；但沙箱仍然是
      // workspace-write，不是 danger-full-access。
      //
      // 这一对组合在 base bundle 的 preset 表里不存在（它只有 workspace-write+ask 和
      // danger-full-access+never），而 permission-presets 要求组合出来的默认值必须命中
      // 某个 preset —— 命不中就在启动时抛
      // "composed sandbox and approval defaults match no preset"。所以这里必须显式声明
      // 这个 preset 并把它设成 defaultPreset，否则整个 profile 根本起不来。
      id: 'permission',
      config: {
        defaultPreset:
          spec.policy.sandbox.defaultMode === 'read-only'
            ? 'automation-read-only'
            : 'automation-workspace-write',
        presets: {
          'automation-workspace-write': {
            sandbox: 'workspace-write',
            approval: 'never',
            name: 'automation-workspace-write',
            description:
              'Write inside the attempt workspace with no interactive approval; the platform policy, not a human, decides what is allowed.',
          },
          'automation-read-only': {
            sandbox: 'read-only',
            approval: 'never',
            name: 'automation-read-only',
            description:
              'Read-only automation used while the shell-write emergency breaker is engaged.',
          },
        },
      },
    },
    {
      id: 'approval',
      config: { policy: 'never' },
    },
    {
      id: 'tool-subagent',
      config: {
        provider: 'spawn',
        toolName: 'subagent',
        // **必须是 one-shot，不能是 continuable。** 实测（v4-subagent-diagnosis）：配成
        // continuable 时 `subagent` 立即返回 `started subagent <id>`，子 Agent 停在 `[ready]`
        // 状态**永不执行** —— 8 轮 list_agents 状态不变，显式 send_message 也不动，
        // authority ledger 记到的 Agent 数始终是 1，分层预算的 child 计数始终是 0。
        //
        // 原因是语义不匹配：continuable 的设计是"父 Agent 在**后续 turn** 收到子 Agent 的完成
        // 通知"，而本平台一次 attempt 只驱动一个 root turn（`runSingleAcpTurn`），压根没有
        // 后续 turn。turn 一结束引擎就收敛，子 Agent 连一次模型请求都发不出去。
        //
        // 改成 one-shot 后同一诊断：ledger Agent 数 2、child 模型请求 9 —— 子 Agent 真的跑。
        // 需要后台并行时仍可用（模型传 `run_in_background: true` 换 job id，用 job_output 在
        // **同一个 turn 内**收集），所以并行能力没有丢。
        //
        // 这与方案 §3.1 "支持 continuable background" 的字面表述有偏差，取的是可运行的语义。
        backgroundMode: 'one-shot',
        // 后台模式（`run_in_background: true`）**曾经是坏的**，现在可用，历史值得留在这里：
        //
        // 早先实测它必然失败 —— job 状态 running → failed，子 Agent 一次模型请求都没发，
        // `job_output` 只回 `[status: failed, error]`。根因不在 Harness，而在平台的身份归属：
        // 子 Agent 的父是靠"当前正在执行委派工具的那个 Agent"推断的，而后台委派**立即返回**，
        // post-execute 清掉标记之后子 Agent 才异步启动，那一刻栈上已无委派 →
        // `IDENTITY_UNRESOLVED` → 模型请求被 fail closed 拒绝 → job failed。
        //
        // 修复是把 lineage 的第一来源换成 Harness 写在子会话头部的 `parentSession` /
        // `delegationDepth`（见 harness-plugins/shared/agent-identity.ts），它与同步或异步无关。
        // 修复后实测：两个后台子 Agent 并行，ledger Agent 数 3、register-agent 2 次、
        // 两个 job 都 `[status: completed]` 并带回各自结论。
        //
        // 因此这里保持开启：默认仍是阻塞（`backgroundMode: 'one-shot'`），模型需要并行时可以
        // 显式传 `run_in_background: true` 换 job id，用 `job_output` 在同一个 turn 内收集。
        enableRunInBackground: true,
        maxDepth: spec.policy.agents.maxDelegationDepth,
        // 方案 §7.3-5 要求"每 attempt 生成 role policy 和 **child toolFilter**"，§7.3 完成标准
        // 是"每类 child 只看到角色允许的工具"。此前这里没有 toolFilter，实测子 Agent 拿到了
        // 与根 Agent 完全相同的 30 个工具，**其中包含 `submit_review_result`** —— 正是方案
        // §2.2 第 1 条警告的"子 Agent 默认继承父 composition，可能看到提交工具"。
        //
        // Broker 与 authority 插件仍会按角色拒绝越权调用，所以 root-only 提交没有被突破；
        // 但让模型看见一个它必定被拒的工具，只会换来无效调用和被浪费的预算。
        toolFilter: { allow: [...childToolSurface(spec.policy)] },
      },
    },
    {
      id: 'tool-subagent-fork',
      config: {
        provider: 'fork',
        toolName: 'subagent_fork',
        backgroundMode: 'one-shot',
        // 与 spawn 一致：默认阻塞，需要并行时可显式转后台。后台路径依赖的身份归属修复对
        // fork 同样生效（lineage 来自会话头部，不区分 provider）。
        enableRunInBackground: true,
        maxDepth: spec.policy.agents.maxDelegationDepth,
        toolFilter: { allow: [...childToolSurface(spec.policy)] },
      },
    },
    {
      id: 'tool-ralph',
      config: {
        subagentProvider: 'spawn',
        maxRounds: spec.policy.modelBudget.maxRalphRounds,
      },
    },
    {
      // Jobs 的并发上限属于 provider（`id: jobs` → `@deepseek-ai/dsh-jobs-local`），不是
      // `tool-jobs`（后者只配 wait 超时）。不显式下传就退回 Harness 内置默认值，而那个值
      // 会随依赖升级漂移 —— §4 冻结的 policy 就成了一份不生效的文档。
      //
      // `jobs.maxRuntimeMs` 在 Harness 侧没有对应字段：Job 跑的是 Shell 命令，单条命令的
      // 时限由 bash-sandbox 的 commandTimeoutMs 施加，这里不发明一个会被 schema 拒绝的键。
      id: 'jobs',
      config: {
        maxConcurrentJobsPerOwner: spec.policy.jobs.maxConcurrentJobsPerOwner,
      },
    },
    {
      // Workflow 的并发同理属于 holder（`workflow-worker-thread`），`tool-workflow` 只配
      // 工具名与结果长度。maxTotalAgents 与 Agent Tree 总数上限对齐，避免两处各说一套。
      id: 'workflow-worker-thread',
      config: {
        provider: 'spawn',
        maxConcurrentAgents: spec.policy.workflow.maxConcurrentSteps,
        maxTotalAgents: spec.policy.agents.maxAgentsPerAttempt,
      },
    },
    {
      id: 'session-persistence-jsonl',
      config: {
        // 持久卷，不在 attempt 临时目录里 —— 否则 Worker 重启后无从恢复。
        root: spec.sessionRoot,
        // 明文换行分隔，而不是默认的 zstd 帧。
        //
        // 两条理由，都与恢复和事故处置直接相关：
        //
        //  1. **平台能自己验证已提交前缀的完整性。** 压缩日志只能通过 backend 读，平台侧
        //     无从判断"committed 部分是否损坏"，只能在 resume 真的失败时才发现。明文之下
        //     这是一次逐行 JSON 解析就能回答的问题（见 session-recovery 的 inspectSessionLog）。
        //  2. **运维能直接读它。** Session corruption runbook 需要人能看一眼日志尾部判断
        //     发生了什么；压缩形态下这一步要先解码，事故期间多一个环节就多一次失败机会。
        //
        // 代价是磁盘：会话日志带真实源码，明文更大。这由 Session 卷的保留期与容量水位治理
        // （AGENT_SESSION_VOLUME_MAX_BYTES + enforceSessionRetention）兜住，而不是靠压缩。
        compression: 'none',
      },
    },
    {
      id: 'session-projection-cache',
      config: {
        writeEveryEvents: spec.policy.session.checkpointEveryEvents,
        writeIntervalMs: 5000,
      },
    },

    // ---- 平台治理插件 ---------------------------------------------------
    {
      id: 'agent-authority-policy',
      config: {
        ...brokerConfig,
        rootAgentId: spec.identity.rootAgentId,
        rootSessionId: spec.identity.rootSessionId,
        rootTools: [...rootTools],
        // 子 Agent 的工具面：插件在 `agent/created` 时用它对子 Agent 的 scoped context 调
        // `tools.restrict()`。这是唯一覆盖全部委派路径的收窄点，`tool-subagent` 的 toolFilter
        // 只管经那个工具创建的子 Agent。
        childTools: [...childToolSurface(spec.policy)],
      },
    },
    {
      id: 'usage-reporter',
      config: { ...brokerConfig, rootAgentId: spec.identity.rootAgentId },
    },
    {
      id: 'platform-web',
      config: { ...brokerConfig, allowedDomains: [...spec.policy.web.allowedDomains] },
    },
    {
      id: 'snapshot-tools',
      config: { ...brokerConfig, repositories: spec.repositories ?? [] },
    },
    {
      id: 'review-control-tool',
      config: brokerConfig,
    },
  ]
}

/**
 * Hash the resolved configuration.
 *
 * patch 里已经没有凭据（见 `buildAttemptPatch`），只剩 per-attempt 的 socket 路径需要
 * 归一化 —— 否则每个 attempt 的 profile hash 都不一样，"生产 Job 能追溯到唯一
 * Harness/profile/policy 组合"这条就无从成立。
 */
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
    if (!row.config) continue
    if (typeof row.config.socketPath === 'string') {
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

/**
 * 启动前的落盘闸门：patch 里出现任何形似凭据的键就拒绝启动。
 *
 * 这不是洁癖。patch 文件与 Sandbox Shell 同属一个 OS 用户，且 `workspace-write` 沙箱
 * 允许读整个文件系统，所以"凭据不进 patch"是一条安全不变量，需要在每次 materialize 时
 * 机械检查，而不是靠 review 记住。
 */
export function assertPatchHasNoCredentials(patch: unknown[]): void {
  const CREDENTIAL_KEY = /token|secret|password|capability|apikey/i
  const rows = patch as Array<{ id?: string; config?: Record<string, unknown> }>
  for (const row of rows) {
    if (!row.config) continue
    for (const [key, value] of Object.entries(row.config)) {
      // `apiKeyEnv` 之类"只是变量名"的字段是允许的：值本身不是凭据。
      if (typeof value === 'string' && CREDENTIAL_KEY.test(key) && !/Env$/.test(key)) {
        throw new Error(
          `attempt patch plugin "${row.id ?? 'unknown'}" carries a credential-shaped field "${key}"; ` +
            'broker credentials must travel through the process environment, not the patch file',
        )
      }
    }
  }
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
    assertPatchHasNoCredentials(patch)
    const patchPath = join(dshHome, 'attempt-route.patch.yml')
    writeFileSync(patchPath, `${JSON.stringify(patch, null, 2)}\n`, { mode: 0o600 })

    return {
      attemptRoot,
      dshHome,
      profileName: ACP_PROFILE_NAME,
      profileDir,
      patchPath,
      configHash: computeConfigHash(templateDir, patch, pluginEntries),
      contractHash: contractHash(loadCapabilityContract()),
      rootTools: resolveToolsForRole({
        role: 'root-reviewer',
        policy: spec.policy,
        delegationDepth: 0,
      }),
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
