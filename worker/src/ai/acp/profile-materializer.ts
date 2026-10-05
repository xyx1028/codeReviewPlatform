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
  type AgentRole,
  type V4CapabilityPolicy,
} from '../policy/v4-capability-policy.js'
import {
  materializeSkillTree,
  relaxSkillTree,
  SKILLS_DIR_NAME,
  type MaterializedSkillTree,
} from '../skills/skill-materializer.js'
import type { ProvisionedSkill } from '../skills/skill-provisioner.js'
import { emptyCatalogHash } from '../skills/skill-manifest.js'

export const ACP_PROFILE_NAME = 'code-review-acp'

/**
 * 没有真实 attempt 树时使用的占位 DSH_HOME。
 *
 * 只出现在 `buildAttemptPatch` 被单独调用的场景（单测、hash 稳定性检查）。真实路径
 * 由 `materializeAttemptProfile` 传入，而两者在 configHash 里都被归一化成同一个占位符，
 * 所以"用了占位路径"不会让 profile 身份漂移。
 */
const PLACEHOLDER_DSH_HOME = '/attempt/dsh-home'

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
  /**
   * 这条路由接受的请求模态。
   *
   * **必须显式声明，不能靠 llm-pi-ai 的默认值。** 那个默认值是 `['text']`，而
   * `read_image` 的准入检查读的正是 `resolveModelInfo(...).inputModalities` —— 不声明
   * 就意味着 Bundle 里的 `assets/*.png` 永远读不出来，报错还是
   * "model does not declare image input"，看起来像模型的问题而不是配置的问题。
   * 这是实测出来的（见 v16-skill-dsh-runtime.test.ts）。
   *
   * 反过来**过度声明同样危险**：dsh 的注释说得很直白 —— under-claiming 在图片发出去
   * 之前就拒绝它，over-claiming 会把图片发给一个处理不了它的 provider。两个错误的代价
   * 不一样。所以默认只声明 `text`，由运维在确认模型端点真的接受图片后显式打开。
   */
  inputModalities?: readonly ('text' | 'image')[]
}

/** V4 的根身份。id 写进 attempt patch；capability token 只走环境变量，不落盘。 */
export interface RootIdentitySpec {
  rootAgentId: string
  rootSessionId: string
}

export interface AttemptProfileSpec {
  reviewWorkflow?: boolean
  /** Platform phase filter; only narrows the already policy-approved root tools. */
  rootToolsOverride?: readonly string[]
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
  /**
   * V1.6：本次 attempt 要物化的冻结技能目录。
   *
   * 缺省（`undefined`）等价于**空目录**，不等价于"不隔离"：`skill-filesystem` 的
   * `includeDefaultRoots: false` 与显式 `bundledSkillDir` 永远都会写进 patch。否则
   * Workspace 里的 `.dsh/skills` 或宿主用户目录里的同名技能就能覆盖平台 Bundle ——
   * 那正是 §19 第 13 条要排除的情况。
   */
  skills?: {
    /** 冻结目录的身份。进 configHash，于是"技能集合变了"必然导致 profile hash 变。 */
    catalogHash: string
    bundles: readonly ProvisionedSkill[]
  }
  /** V1.11：冻结 Story scope 的连续性身份；v1 缺省为 legacy。 */
  analysisScopeHash?: string
  /**
   * 根 Agent 的角色。缺省 `root-reviewer`（评审链路，行为与 V1.23 之前完全一致）。
   *
   * V1.23 产品代码问答传 `research-child`：契约里那个角色的工具面**本来就是只读的**
   * （没有 bash / write / edit / submit_review_result）。这个参数存在的理由是
   * `rootTools` 会进 `agent-authority-policy` 的配置，是根 Agent 工具面的**唯一**
   * 收窄点 —— 不让它可配就意味着问答的根 Agent 必然拿到评审角色的全部工具，
   * 包括提交评审结论的那个。
   *
   * 角色名必须存在于契约的 `roleTools` 里，否则 `resolveToolsForRole` 直接
   * fail closed（`AGENT_ROLE_DENIED`）。契约本身一字不动。
   */
  rootRole?: AgentRole
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
  /** 本次 attempt 的技能物化结果。空目录时 `skills.skills` 为空数组。 */
  skills: MaterializedSkillTree
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
 * 一次 attempt 的技能挂载点。
 *
 * 路径是 per-attempt 随机的（attemptRoot 用 mkdtemp 生成），所以它在 configHash 里被
 * 归一化成 `[per-attempt-skills]`；真正进 hash 的身份是 `catalogHash`。
 */
export interface AttemptSkillMount {
  /** per-attempt 的 `<dshHome>` 绝对路径。 */
  dshHome: string
  /** `<dshHome>/skills` 的绝对路径。 */
  dir: string
  /** 冻结目录的 catalog hash。空目录用 `emptyCatalogHash()`。 */
  catalogHash: string
}

/**
 * Build the per-attempt overlay. It is emitted as JSON, which is valid YAML,
 * so no hand-rolled escaping can corrupt a path or a token.
 *
 * 这份 patch **不含任何凭据**。Broker bearer token 与根 capability token 走环境变量
 * （见 `harness-plugins/shared/credential-env.ts`）：patch 文件落在 dshHome 下，而
 * `workspace-write` 沙箱只限制写不限制读，凭据写进这个文件等于交给任何拿到 Shell 的
 * 子 Agent。
 *
 * `skills` 可省略：省略时使用一个占位挂载点（空目录 hash + 占位路径），于是**隔离配置
 * 依然存在**。这一点很关键 —— 隔离不能是"传了参数才有"的可选项，否则某条忘记传参的
 * 调用路径就会静默恢复默认 roots，让 Workspace 里的同名技能覆盖平台 Bundle。
 */
export function buildAttemptPatch(
  spec: AttemptProfileSpec,
  skills?: AttemptSkillMount,
): unknown[] {
  const skillMount: AttemptSkillMount = skills ?? {
    // 占位路径。它只出现在没有真实 attempt 树的调用（单测、hash 稳定性检查）里，
    // 而且在 computeConfigHash 里被归一化成 `[per-attempt-skills]`，所以它不影响
    // profile 身份。隔离配置本身仍然照写。
    dshHome: PLACEHOLDER_DSH_HOME,
    dir: join(PLACEHOLDER_DSH_HOME, SKILLS_DIR_NAME),
    catalogHash: spec.skills?.catalogHash ?? emptyCatalogHash(),
  }
  const brokerConfig = {
    socketPath: spec.broker.socketPath,
    taskId: spec.taskId,
    agentAttempt: spec.agentAttempt,
    requestTimeoutMs: spec.broker.requestTimeoutMs ?? 30000,
  }
  const allowedRootTools = resolveToolsForRole({
    // 缺省 root-reviewer：评审链路行为不变。问答传 research-child（只读角色）。
    role: spec.rootRole ?? 'root-reviewer',
    policy: spec.policy,
    delegationDepth: 0,
  })
  const rootTools = spec.rootToolsOverride ? allowedRootTools.filter((tool) => spec.rootToolsOverride!.includes(tool)) : allowedRootTools

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
            // 重试上限来自冻结 policy 的 `maxRetryRequests`，不是硬编码的 0。
            //
            // 曾经写死 0 的后果是实测出来的：内网模型端点（经宿主机 VPN 代理）会以约
            // 0.5% 的比例出现一次性 socket 失败，代理据实回 `502 model endpoint
            // unreachable from this Mac`。`maxRetries: 0` 让 `dsh-llm-retry` 对这个
            // `SERVER` 失败直接放弃，于是**单次**瞬时抖动就把整个 attempt 打成
            // `ATTEMPT_FAILED`（首个 model 请求即失败、wall_ms 三秒、零证据）。一次
            // 评审有几十次 model 请求，逐次 0.5% 累起来就是每批必然有若干需求任务无端失败。
            //
            // 同时 0 让平台侧的重试预算成了永远花不出去的死账：`fallbackPolicyFromModel`
            // 与 policy 快照都留了 `maxRetryRequests`，`RequestClassifier` 会把重发认成
            // `kind:'retry'`，Broker 与 `HierarchicalBudgetLedger` 也按该额度记账并在超额时
            // 拒绝。真正的上限本来就在账本里，provider 侧再写一个 0 只是把上限提前压成零。
            //
            // 取 policy 的额度而不是 Harness 默认的 5：默认值是 Harness 的部署选择，
            // V4 的上限必须来自冻结 policy（与本文件其余显式数值同一条原则）。预算耗尽后
            // 账本回的是 `MODEL_BUDGET_EXHAUSTED` / `BROKER_DENIED`，不在 normal 模式的可重试
            // 码集合（`EMPTY_RESPONSE`/`RATE_LIMIT`/`SERVER`/`TIMEOUT`/`TRANSPORT`）里，
            // 因此额度用尽会立即终止，不会退化成重试风暴。
            retryPolicy: { mode: 'normal', maxRetries: spec.policy.modelBudget.maxRetryRequests },
            models: [
              {
                id: spec.route.modelName,
                name: spec.route.modelName,
                contextWindow: spec.route.contextWindow,
                maxTokens: spec.route.maxTokens,
                // 显式声明模态。缺省是 `['text']` —— 那会让技能包里的图片资源永远不可读。
                input: [...(spec.route.inputModalities ?? ['text'])],
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

    // ---- V1.6 Skills：只允许发现平台物化的冻结目录 ------------------------
    //
    // 三个字段各自挡掉一条真实的覆盖路径，缺一条整条就不成立：
    //
    //   * `includeDefaultRoots: false` —— 去掉 `<project>/.dsh/skills`、
    //     `<project>/.agents/skills`、`<DSH_HOME>/skills`（user 档）和
    //     `~/.agents/skills` 四个默认 root。前两个位于**模型可写的 Workspace 里**，
    //     而且 rank 比 bundled root 更高（100/200 vs 600），也就是说不关掉它们的话，
    //     模型只要在 Workspace 写一个同名 `SKILL.md` 就能顶替平台 Bundle。这正是
    //     §19 第 13 条要排除的情况。
    //   * `bundledSkillDir` —— 显式指向 per-attempt 的 `<dshHome>/skills`。它带
    //     `trustedHost: true`，语义上就是"平台提供的、可信的技能"。
    //   * `watch: false` / `watchFollowSymlinks: false` —— 冻结目录在 attempt 生命周期
    //     内不会变，监听它没有意义；而"跟随 symlink 去监听"会把路径解析引出 attempt 树。
    //     物化时已经保证树内无 symlink，这一行是第二道。
    //
    // `dshHome` / `agentsHome` 也显式指向 attempt 树内部：即使将来某条代码路径在
    // `includeDefaultRoots: false` 下仍然用到它们，也只会落在私有目录里，而不是宿主
    // 用户的 home。
    {
      id: 'skill-filesystem',
      config: {
        providerName: 'filesystem',
        includeDefaultRoots: false,
        dshHome: skillMount.dshHome,
        agentsHome: join(skillMount.dshHome, 'agents-home'),
        customSkillDirs: [],
        bundledSkillDir: skillMount.dir,
        watch: false,
        watchFollowSymlinks: false,
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
        // V1.6 技能审计归因（方案 §16）。只用于把"读了哪个技能的哪个资源"记进现有的
        // tool-audit 通道，不是权限边界 —— 权限边界仍是沙箱与角色工具面。
        skillsDir: skillMount.dir,
        skills: (spec.skills?.bundles ?? []).map((provisioned) => ({
          name: provisioned.bundle.name,
          bundleHash: provisioned.bundle.bundleHash,
        })),
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
      config: { ...brokerConfig, workflowMode: spec.reviewWorkflow ?? false },
    },
  ]
}

/**
 * Hash the resolved configuration.
 *
 * patch 里已经没有凭据（见 `buildAttemptPatch`），只剩 per-attempt 的随机路径需要
 * 归一化 —— 否则每个 attempt 的 profile hash 都不一样，"生产 Job 能追溯到唯一
 * Harness/profile/policy 组合"这条就无从成立。
 *
 * V1.6 追加两件事：
 *
 *   1. `skill-filesystem` 的四个 per-attempt 绝对路径归一化成占位符；
 *   2. **`skillCatalogHash` 作为独立输入进 hash。** 它不在 patch 里 —— 塞进某个插件的
 *      config 会被 schema 拒（那里没有这个键）。但 configHash 必须纳入它：技能集合是
 *      模型能看到的能力面的一部分，集合变了而 profile hash 不变，等于让恢复门禁放过
 *      一个"技能已经换了"的 Session。
 */
export function computeConfigHash(
  templateDir: string,
  patch: unknown[],
  pluginEntries: Record<string, string>,
  skillCatalogHash?: string,
  analysisScopeHash?: string,
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
    // `skillsDir` 出现在 agent-authority-policy 里（审计归因用）。它是 per-attempt 随机
    // 路径，不归一化会让每个 attempt 的 profile hash 都不同 —— 而 profile hash 现在是
    // 恢复门禁的判定项之一，那等于让**所有**恢复都被拒。
    if (typeof row.config.skillsDir === 'string') {
      row.config.skillsDir = '[per-attempt-skills]'
    }
    if (row.id === 'skill-filesystem') {
      for (const key of ['bundledSkillDir', 'dshHome', 'agentsHome'] as const) {
        if (typeof row.config[key] === 'string') {
          row.config[key] = '[per-attempt-skills]'
        }
      }
    }
  }
  const hash = createHash('sha256')
  hash.update(readFileSync(join(templateDir, 'package.json')))
  hash.update(readFileSync(join(templateDir, 'cordis.patch.yml')))
  hash.update(JSON.stringify(redactedPatch))
  hash.update(JSON.stringify(Object.keys(pluginEntries).sort()))
  hash.update(`skill-catalog:${skillCatalogHash ?? emptyCatalogHash()}`)
  hash.update(`analysis-scope:${analysisScopeHash ?? 'legacy-v1'}`)
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

    // ---- V1.6 技能物化 ---------------------------------------------------
    //
    // 必须在写 patch **之前**完成：patch 里的 `bundledSkillDir` 指向这棵树，而
    // configHash 又要纳入 catalog hash。顺序颠倒的后果是 profile hash 记录的是一份
    // 与磁盘不一致的配置。
    //
    // 空目录（`spec.skills` 缺省或 bundles 为空）同样会创建 `<dshHome>/skills`：
    // 一个不存在的 root 与一个空 root 对 DSH 是同一个结果，但对运维不是 ——
    // 目录存在意味着"平台确实处理过技能这件事"，而不是"这段代码没跑到"。
    const skillTree = materializeSkillTree({
      dshHome,
      bundles: spec.skills?.bundles ?? [],
    })
    const skillCatalogHash = spec.skills?.catalogHash ?? emptyCatalogHash()

    const patch = buildAttemptPatch(spec, {
      dshHome,
      dir: skillTree.skillsDir,
      catalogHash: skillCatalogHash,
    })
    assertPatchHasNoCredentials(patch)
    const patchPath = join(dshHome, 'attempt-route.patch.yml')
    writeFileSync(patchPath, `${JSON.stringify(patch, null, 2)}\n`, { mode: 0o600 })

    return {
      attemptRoot,
      dshHome,
      profileName: ACP_PROFILE_NAME,
      profileDir,
      patchPath,
      configHash: computeConfigHash(templateDir, patch, pluginEntries, skillCatalogHash, spec.analysisScopeHash),
      contractHash: contractHash(loadCapabilityContract()),
      rootTools: resolveToolsForRole({
        role: spec.rootRole ?? 'root-reviewer',
        policy: spec.policy,
        delegationDepth: 0,
      }).filter((tool) => !spec.rootToolsOverride || spec.rootToolsOverride.includes(tool)),
      skills: skillTree,
      cleanup: () => {
        // 技能树是 0500/0400 的只读树：不先放宽权限，`rmSync` 会在它上面失败，而失败
        // 的表现是 attempt 目录残留、磁盘慢慢满。
        relaxSkillTree(dshHome)
        rmSync(attemptRoot, { recursive: true, force: true })
      },
    }
  } catch (err) {
    relaxSkillTree(join(attemptRoot, 'dsh-home'))
    rmSync(attemptRoot, { recursive: true, force: true })
    throw err
  }
}

function pathToImportUrl(absolutePath: string): string {
  return new URL(`file://${absolutePath}`).href
}
