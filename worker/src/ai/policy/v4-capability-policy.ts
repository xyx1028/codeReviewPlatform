/**
 * V4 能力契约的运行时形态。
 *
 * 这个模块回答三个问题，而且只在 Worker 侧回答（Harness 子进程不参与决策）：
 *
 *  1. 这次 attempt 的 capability policy 是什么？——来自数据库冻结的 snapshot，缺字段用
 *     本文件的默认值补齐；capability 布尔值默认全开。
 *  2. 某个 Agent role 能看到哪些工具？——契约里的 `roleTools`，与全局 policy 求交集。
 *  3. 解析出来的工具面是否合法？——出现契约外的工具名立即 fail closed，而不是让它悄悄
 *     进入模型上下文。
 *
 * “全能力”被固定成 `v4-capability-contract.json`，不随依赖升级自动扩张：Harness 新增
 * 一个工具，契约校验就会失败，必须有人显式接受它。
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const V4_POLICY_VERSION = 4

/** Agent 角色。root 唯一拥有最终提交权。 */
export type AgentRole =
  | 'root-reviewer'
  | 'research-child'
  | 'implementation-child'
  | 'critic-child'
  | 'workflow-child'

export const AGENT_ROLES: readonly AgentRole[] = [
  'root-reviewer',
  'research-child',
  'implementation-child',
  'critic-child',
  'workflow-child',
]

/** 子 Agent 的产生方式。 */
export type AgentProvider = 'root' | 'spawn' | 'fork' | 'workflow' | 'ralph'

/** Broker 路由要求的能力。 */
export type BrokerCapability =
  | 'snapshotRead'
  | 'agentRegister'
  | 'usageReport'
  | 'webEgress'
  | 'artifactWrite'
  | 'submitReview'

export interface ToolContractEntry {
  origin: 'platform' | 'harness'
  mutating: boolean
  parallelSafe: boolean
}

export interface BrokerRouteEntry {
  capability: BrokerCapability
  mutating: boolean
}

export interface V4CapabilityContract {
  manifestRevision: number
  contractVersion: number
  harnessVersion: string
  bundles: string[]
  defaultPolicy: V4CapabilityPolicy
  enabledPlugins: string[]
  disabledPlugins: string[]
  platformPlugins: string[]
  modelTools: Record<string, ToolContractEntry>
  roleTools: Record<AgentRole, string[]>
  brokerRoutes: Record<string, BrokerRouteEntry>
  errorCodes: string[]
}

// ---------------------------------------------------------------------------
// Policy shape
// ---------------------------------------------------------------------------

export interface V4Capabilities {
  instructions: boolean
  skills: boolean
  goal: boolean
  plan: boolean
  todo: boolean
  ralph: boolean
  subagentSpawn: boolean
  subagentFork: boolean
  subagentControl: boolean
  workflow: boolean
  jobs: boolean
  shell: boolean
  filesystem: boolean
  webSearch: boolean
  webFetch: boolean
  parallelTools: boolean
  autoCompaction: boolean
  sessionPersistence: boolean
  sessionResume: boolean
  artifacts: boolean
}

export interface V4SandboxPolicy {
  defaultMode: 'read-only' | 'workspace-write'
  dangerFullAccess: false
  commandTimeoutMs: number
  maxProcessesPerAttempt: number
  maxWorkspaceBytes: number
  maxWorkspaceFiles: number
}

export interface V4AgentsPolicy {
  maxAgentsPerAttempt: number
  maxDelegationDepth: number
  maxConcurrentChildren: number
  allowOutOfProcessProviders: false
}

export interface V4WorkflowPolicy {
  maxConcurrentSteps: number
  maxRuntimeMs: number
}

export interface V4JobsPolicy {
  maxConcurrentJobsPerOwner: number
  maxRuntimeMs: number
}

export interface V4ParallelToolsPolicy {
  maxPerStep: number
  mutationToolsSerial: boolean
}

export interface V4ModelBudgetPolicy {
  maxTotalRequests: number
  maxRootRequests: number
  maxChildRequests: number
  maxRetryRequests: number
  maxCompactionRequests: number
  maxRalphRounds: number
}

export interface V4WebPolicy {
  maxRequestsPerAttempt: number
  maxResponseBytes: number
  maxTotalBytes: number
  allowHttp: boolean
  allowedPorts: number[]
  allowedDomains: string[]
  denyPrivateNetworks: boolean
  maxRedirects: number
  requestTimeoutMs: number
}

export interface V4SessionPolicy {
  checkpointEveryEvents: number
  retentionDays: number
  encryptAtRest: boolean
  resumeOnWorkerRestart: boolean
}

export interface V4CapabilityPolicy {
  version: number
  capabilities: V4Capabilities
  sandbox: V4SandboxPolicy
  agents: V4AgentsPolicy
  workflow: V4WorkflowPolicy
  jobs: V4JobsPolicy
  parallelTools: V4ParallelToolsPolicy
  modelBudget: V4ModelBudgetPolicy
  web: V4WebPolicy
  session: V4SessionPolicy
}

// 默认策略不在 TypeScript 中重复定义；由下方 manifest loader 从契约文件读取。

// ---------------------------------------------------------------------------
// Contract loading
// ---------------------------------------------------------------------------

export class CapabilityContractError extends Error {
  readonly code: string
  constructor(message: string, code = 'CAPABILITY_CONTRACT_VIOLATION') {
    super(message)
    this.name = 'CapabilityContractError'
    this.code = code
  }
}

function moduleDir(): string {
  return dirname(fileURLToPath(import.meta.url))
}

function findUpwards(start: string, relative: string): string | null {
  let current = start
  for (let depth = 0; depth < 10; depth++) {
    const candidate = join(current, relative)
    if (existsSync(candidate)) return candidate
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return null
}

/** 定位契约文件。容器镜像可以用环境变量把它放在别处。 */
export function resolveContractPath(): string {
  const override = process.env.HARNESS_CAPABILITY_CONTRACT
  if (override) {
    if (!existsSync(override)) {
      throw new CapabilityContractError(
        `HARNESS_CAPABILITY_CONTRACT does not exist: ${override}`,
        'CAPABILITY_CONTRACT_MISSING',
      )
    }
    return override
  }
  const found = findUpwards(
    moduleDir(),
    join('worker', 'harness', 'code-review-acp', 'v4-capability-contract.json'),
  )
  if (!found) {
    throw new CapabilityContractError(
      'unable to locate v4-capability-contract.json; set HARNESS_CAPABILITY_CONTRACT',
      'CAPABILITY_CONTRACT_MISSING',
    )
  }
  return found
}

let cachedContract: V4CapabilityContract | null = null

/**
 * 读取并固定进程级 manifest。运行中的 Worker 不热切换契约：热切换会造成工具契约已更新、
 * 默认策略仍属于旧版本的混合状态。升级通过部署新 Worker 完成。
 */
export function loadCapabilityContract(): V4CapabilityContract {
  if (cachedContract) return cachedContract
  const path = resolveContractPath()
  const raw = readFileSync(path, 'utf8')
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new CapabilityContractError(
      `v4-capability-contract.json is not valid JSON: ${(err as Error).message}`,
      'CAPABILITY_CONTRACT_MALFORMED',
    )
  }
  const contract = parsed as V4CapabilityContract
  assertContractShape(contract)
  cachedContract = contract
  return contract
}

function assertContractShape(contract: V4CapabilityContract): void {
  const problems: string[] = []
  if (!Number.isInteger(contract.manifestRevision) || contract.manifestRevision < 1) {
    problems.push('manifestRevision must be a positive integer')
  }
  if (contract.contractVersion !== V4_POLICY_VERSION) {
    problems.push(`contractVersion must be ${V4_POLICY_VERSION}, got ${contract.contractVersion}`)
  }
  if (typeof contract.harnessVersion !== 'string' || contract.harnessVersion === '') {
    problems.push('harnessVersion is required')
  }
  if (!Array.isArray(contract.bundles) || contract.bundles.length === 0) {
    problems.push('bundles must be a non-empty array')
  }
  assertDefaultPolicyShape(contract.defaultPolicy, problems)
  for (const key of ['enabledPlugins', 'disabledPlugins', 'platformPlugins', 'errorCodes'] as const) {
    if (!Array.isArray(contract[key])) problems.push(`${key} must be an array`)
  }
  if (typeof contract.modelTools !== 'object' || contract.modelTools === null) {
    problems.push('modelTools must be an object')
  }
  if (typeof contract.roleTools !== 'object' || contract.roleTools === null) {
    problems.push('roleTools must be an object')
  } else {
    for (const role of AGENT_ROLES) {
      if (!Array.isArray(contract.roleTools[role])) {
        problems.push(`roleTools.${role} must be an array`)
        continue
      }
      for (const tool of contract.roleTools[role]) {
        if (!(tool in contract.modelTools)) {
          problems.push(`roleTools.${role} names ${tool}, which is not in modelTools`)
        }
      }
    }
    // 唯一提交权：契约本身必须表达它，而不是只靠代码里的一个 if。
    for (const role of AGENT_ROLES) {
      if (role === 'root-reviewer') continue
      if ((contract.roleTools[role] ?? []).includes(SUBMIT_TOOL_NAME)) {
        problems.push(`roleTools.${role} must not include ${SUBMIT_TOOL_NAME}`)
      }
    }
    if (!(contract.roleTools['root-reviewer'] ?? []).includes(SUBMIT_TOOL_NAME)) {
      problems.push(`roleTools.root-reviewer must include ${SUBMIT_TOOL_NAME}`)
    }
  }
  const overlap = (contract.enabledPlugins ?? []).filter((id) =>
    (contract.disabledPlugins ?? []).includes(id),
  )
  if (overlap.length > 0) {
    problems.push(`plugins listed both enabled and disabled: ${overlap.join(', ')}`)
  }
  if (problems.length > 0) {
    throw new CapabilityContractError(
      `v4 capability contract is invalid: ${problems.join('; ')}`,
      'CAPABILITY_CONTRACT_MALFORMED',
    )
  }
}

function assertDefaultPolicyShape(policy: V4CapabilityPolicy, problems: string[]): void {
  if (typeof policy !== 'object' || policy === null) {
    problems.push('defaultPolicy must be an object')
    return
  }
  if (policy.version !== V4_POLICY_VERSION) {
    problems.push(`defaultPolicy.version must be ${V4_POLICY_VERSION}`)
  }

  const capabilityKeys: Array<keyof V4Capabilities> = [
    'instructions', 'skills', 'goal', 'plan', 'todo', 'ralph', 'subagentSpawn',
    'subagentFork', 'subagentControl', 'workflow', 'jobs', 'shell', 'filesystem',
    'webSearch', 'webFetch', 'parallelTools', 'autoCompaction', 'sessionPersistence',
    'sessionResume', 'artifacts',
  ]
  if (typeof policy.capabilities !== 'object' || policy.capabilities === null) {
    problems.push('defaultPolicy.capabilities must be an object')
  } else {
    const actualKeys = Object.keys(policy.capabilities).sort()
    const expectedKeys = [...capabilityKeys].sort()
    if (actualKeys.join(',') !== expectedKeys.join(',')) {
      problems.push('defaultPolicy.capabilities must contain exactly the V4 capability keys')
    }
    for (const key of capabilityKeys) {
      if (policy.capabilities[key] !== true) {
        problems.push(`defaultPolicy.capabilities.${key} must be true`)
      }
    }
  }

  for (const section of [
    'sandbox', 'agents', 'workflow', 'jobs', 'parallelTools', 'modelBudget', 'web', 'session',
  ] as const) {
    if (typeof policy[section] !== 'object' || policy[section] === null) {
      problems.push(`defaultPolicy.${section} must be an object`)
    }
  }
  if (policy.sandbox?.dangerFullAccess !== false) {
    problems.push('defaultPolicy.sandbox.dangerFullAccess must be false')
  }
  if (policy.agents?.allowOutOfProcessProviders !== false) {
    problems.push('defaultPolicy.agents.allowOutOfProcessProviders must be false')
  }
  if (policy.parallelTools?.mutationToolsSerial !== true) {
    problems.push('defaultPolicy.parallelTools.mutationToolsSerial must be true')
  }
  if (!Array.isArray(policy.web?.allowedPorts) || !Array.isArray(policy.web?.allowedDomains)) {
    problems.push('defaultPolicy.web allowlists must be arrays')
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  return Object.freeze(value)
}

export const SUBMIT_TOOL_NAME = 'submit_review_result'

/** 平台统一默认策略，唯一来源是 v4-capability-contract.json 的 defaultPolicy。 */
export const V4_DEFAULT_POLICY: V4CapabilityPolicy = deepFreeze(
  loadCapabilityContract().defaultPolicy,
)

/** 契约内容的稳定摘要，写进 attempt 记录用于追溯。 */
export function contractHash(contract: V4CapabilityContract = loadCapabilityContract()): string {
  return createHash('sha256')
    .update(
      stableStringify({
        manifestRevision: contract.manifestRevision,
        contractVersion: contract.contractVersion,
        harnessVersion: contract.harnessVersion,
        bundles: [...contract.bundles].sort(),
        defaultPolicy: contract.defaultPolicy,
        enabledPlugins: [...contract.enabledPlugins].sort(),
        disabledPlugins: [...contract.disabledPlugins].sort(),
        platformPlugins: [...contract.platformPlugins].sort(),
        modelTools: sortedRecord(contract.modelTools),
        roleTools: Object.fromEntries(
          Object.entries(contract.roleTools).map(([role, tools]) => [role, [...tools].sort()]),
        ),
        brokerRoutes: sortedRecord(contract.brokerRoutes),
        errorCodes: [...contract.errorCodes].sort(),
      }),
    )
    .digest('hex')
}

function compareCanonicalText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function sortedRecord<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => compareCanonicalText(a, b)))
}

// ---------------------------------------------------------------------------
// Policy normalization
// ---------------------------------------------------------------------------

function boolOr(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function intOr(value: unknown, fallback: number, min: number, max: number): number {
  const num = typeof value === 'string' ? Number(value) : value
  if (typeof num !== 'number' || !Number.isInteger(num) || num < min || num > max) return fallback
  return num
}

/**
 * 把数据库冻结的 snapshot 归一成完整 Policy。
 *
 * 三条硬规则在这里落地，snapshot 无法突破：
 *  - `dangerFullAccess` 永远 false；
 *  - `allowOutOfProcessProviders` 永远 false；
 *  - 缺失字段用默认值补齐，而不是变成 undefined 让下游各自猜。
 */
export function normalizeCapabilityPolicy(snapshot: unknown): V4CapabilityPolicy {
  const raw = (snapshot ?? {}) as Record<string, unknown>
  const caps = (raw.capabilities ?? {}) as Record<string, unknown>
  const sandbox = (raw.sandbox ?? {}) as Record<string, unknown>
  const agents = (raw.agents ?? {}) as Record<string, unknown>
  const workflow = (raw.workflow ?? {}) as Record<string, unknown>
  const jobs = (raw.jobs ?? {}) as Record<string, unknown>
  const parallel = (raw.parallelTools ?? {}) as Record<string, unknown>
  const budget = (raw.modelBudget ?? {}) as Record<string, unknown>
  const web = (raw.web ?? {}) as Record<string, unknown>
  const session = (raw.session ?? {}) as Record<string, unknown>
  const d = V4_DEFAULT_POLICY

  const capabilities = Object.fromEntries(
    (Object.keys(d.capabilities) as Array<keyof V4Capabilities>).map((key) => [
      key,
      boolOr(caps[key], d.capabilities[key]),
    ]),
  ) as unknown as V4Capabilities

  const maxTotalRequests = intOr(budget.maxTotalRequests, d.modelBudget.maxTotalRequests, 1, 10000)

  return {
    version: V4_POLICY_VERSION,
    capabilities,
    sandbox: {
      // 只有 read-only 与 workspace-write 两种；任何其他值都退回默认。
      defaultMode: sandbox.defaultMode === 'read-only' ? 'read-only' : 'workspace-write',
      dangerFullAccess: false,
      commandTimeoutMs: intOr(sandbox.commandTimeoutMs, d.sandbox.commandTimeoutMs, 1000, 600000),
      maxProcessesPerAttempt: intOr(
        sandbox.maxProcessesPerAttempt,
        d.sandbox.maxProcessesPerAttempt,
        1,
        4096,
      ),
      maxWorkspaceBytes: intOr(
        sandbox.maxWorkspaceBytes,
        d.sandbox.maxWorkspaceBytes,
        1024 * 1024,
        1024 ** 4,
      ),
      maxWorkspaceFiles: intOr(sandbox.maxWorkspaceFiles, d.sandbox.maxWorkspaceFiles, 100, 10 ** 7),
    },
    agents: {
      maxAgentsPerAttempt: intOr(agents.maxAgentsPerAttempt, d.agents.maxAgentsPerAttempt, 1, 64),
      maxDelegationDepth: intOr(agents.maxDelegationDepth, d.agents.maxDelegationDepth, 0, 8),
      maxConcurrentChildren: intOr(
        agents.maxConcurrentChildren,
        d.agents.maxConcurrentChildren,
        1,
        32,
      ),
      allowOutOfProcessProviders: false,
    },
    workflow: {
      maxConcurrentSteps: intOr(workflow.maxConcurrentSteps, d.workflow.maxConcurrentSteps, 1, 32),
      maxRuntimeMs: intOr(workflow.maxRuntimeMs, d.workflow.maxRuntimeMs, 1000, 86400000),
    },
    jobs: {
      maxConcurrentJobsPerOwner: intOr(
        jobs.maxConcurrentJobsPerOwner,
        d.jobs.maxConcurrentJobsPerOwner,
        1,
        64,
      ),
      maxRuntimeMs: intOr(jobs.maxRuntimeMs, d.jobs.maxRuntimeMs, 1000, 86400000),
    },
    parallelTools: {
      maxPerStep: intOr(parallel.maxPerStep, d.parallelTools.maxPerStep, 1, 64),
      // mutation 串行是安全属性，不接受被关掉。
      mutationToolsSerial: true,
    },
    modelBudget: {
      maxTotalRequests,
      maxRootRequests: Math.min(
        intOr(budget.maxRootRequests, d.modelBudget.maxRootRequests, 1, 10000),
        maxTotalRequests,
      ),
      maxChildRequests: Math.min(
        intOr(budget.maxChildRequests, d.modelBudget.maxChildRequests, 1, 10000),
        maxTotalRequests,
      ),
      maxRetryRequests: Math.min(
        intOr(budget.maxRetryRequests, d.modelBudget.maxRetryRequests, 0, 10000),
        maxTotalRequests,
      ),
      maxCompactionRequests: Math.min(
        intOr(budget.maxCompactionRequests, d.modelBudget.maxCompactionRequests, 0, 10000),
        maxTotalRequests,
      ),
      maxRalphRounds: intOr(budget.maxRalphRounds, d.modelBudget.maxRalphRounds, 0, 256),
    },
    web: {
      maxRequestsPerAttempt: intOr(
        web.maxRequestsPerAttempt,
        d.web.maxRequestsPerAttempt,
        0,
        10000,
      ),
      maxResponseBytes: intOr(web.maxResponseBytes, d.web.maxResponseBytes, 1024, 1024 ** 3),
      maxTotalBytes: intOr(web.maxTotalBytes, d.web.maxTotalBytes, 1024, 1024 ** 4),
      // HTTP 明文永远不开：allowHttp 只保留给本地测试的显式 true，生产 snapshot 不写它。
      allowHttp: boolOr(web.allowHttp, d.web.allowHttp),
      allowedPorts: normalizePorts(web.allowedPorts, d.web.allowedPorts),
      allowedDomains: normalizeDomains(web.allowedDomains),
      denyPrivateNetworks: boolOr(web.denyPrivateNetworks, d.web.denyPrivateNetworks),
      maxRedirects: intOr(web.maxRedirects, d.web.maxRedirects, 0, 10),
      requestTimeoutMs: intOr(web.requestTimeoutMs, d.web.requestTimeoutMs, 1000, 120000),
    },
    session: {
      checkpointEveryEvents: intOr(
        session.checkpointEveryEvents,
        d.session.checkpointEveryEvents,
        1,
        100000,
      ),
      retentionDays: intOr(session.retentionDays, d.session.retentionDays, 1, 365),
      encryptAtRest: boolOr(session.encryptAtRest, d.session.encryptAtRest),
      resumeOnWorkerRestart: boolOr(
        session.resumeOnWorkerRestart,
        d.session.resumeOnWorkerRestart,
      ),
    },
  }
}

function normalizePorts(value: unknown, fallback: number[]): number[] {
  if (!Array.isArray(value)) return [...fallback]
  const ports = value
    .map((entry) => (typeof entry === 'string' ? Number(entry) : entry))
    .filter(
      (entry): entry is number =>
        typeof entry === 'number' && Number.isInteger(entry) && entry > 0 && entry <= 65535,
    )
  return ports.length > 0 ? [...new Set(ports)].sort((a, b) => a - b) : [...fallback]
}

function normalizeDomains(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [
    ...new Set(
      value
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => entry.trim().toLowerCase())
        .filter(
          (entry) =>
            entry.length > 0 &&
            !entry.includes('/') &&
            !entry.includes(' ') &&
            /^[a-z0-9.-]+$/.test(entry),
        ),
    ),
  ].sort(compareCanonicalText)
}

/**
 * 运维紧急熔断。
 *
 * 这不是面向用户的功能开关：用户配置仍然是 V4 默认全开语义，熔断只在事故期间由运维
 * 通过环境变量收窄，事故解除后移除环境变量即恢复。
 */
export function applyEmergencyBreakers(
  policy: V4CapabilityPolicy,
  env: Record<string, string | undefined> = process.env,
): { policy: V4CapabilityPolicy; breakers: string[] } {
  const breakers: string[] = []
  const next: V4CapabilityPolicy = {
    ...policy,
    capabilities: { ...policy.capabilities },
    agents: { ...policy.agents },
  }
  const on = (key: string): boolean => {
    const raw = env[key]
    return raw !== undefined && raw.trim() !== '' && raw.trim() !== '0' && raw.trim() !== 'false'
  }
  if (on('V4_BREAKER_DISABLE_WEB')) {
    next.capabilities.webSearch = false
    next.capabilities.webFetch = false
    breakers.push('web')
  }
  if (on('V4_BREAKER_DISABLE_SHELL_WRITE')) {
    next.capabilities.shell = false
    next.sandbox = { ...next.sandbox, defaultMode: 'read-only' }
    breakers.push('shell-write')
  }
  if (on('V4_BREAKER_DISABLE_SUBAGENTS')) {
    next.capabilities.subagentSpawn = false
    next.capabilities.subagentFork = false
    next.capabilities.subagentControl = false
    next.capabilities.ralph = false
    next.agents = { ...next.agents, maxDelegationDepth: 0, maxAgentsPerAttempt: 1 }
    breakers.push('subagents')
  }
  if (on('V4_BREAKER_DISABLE_WORKFLOW')) {
    next.capabilities.workflow = false
    breakers.push('workflow')
  }
  return { policy: next, breakers }
}

// ---------------------------------------------------------------------------
// Capability → tool projection
// ---------------------------------------------------------------------------

/** capability 布尔值关掉时，随之从模型上下文移除的工具。 */
const CAPABILITY_TOOLS: Partial<Record<keyof V4Capabilities, readonly string[]>> = {
  skills: ['skill'],
  // 工具名取自真实 resolved inventory，不是从能力名推测的。Harness 注册的是
  // create_goal/update_goal/get_goal、read/write/edit、job_list/job_output/job_kill，
  // 而不是 goal_write/read_file/jobs 这类看起来合理的名字。猜错的后果是 contract test
  // 报 "missing V4 default tools"，attempt 在启动时 fail closed。
  goal: ['create_goal', 'update_goal', 'get_goal'],
  plan: ['exit_plan_mode'],
  todo: ['todo_write'],
  ralph: ['ralph'],
  subagentSpawn: ['subagent'],
  subagentFork: ['subagent_fork'],
  subagentControl: ['send_message', 'interrupt_agent', 'list_agents'],
  workflow: ['workflow'],
  jobs: ['job_list', 'job_output', 'job_kill'],
  shell: ['bash'],
  filesystem: ['read', 'read_image', 'write', 'edit', 'grep', 'glob'],
  webSearch: ['web_search'],
  webFetch: ['web_fetch'],
}

export interface ResolveToolsInput {
  role: AgentRole
  policy: V4CapabilityPolicy
  /** 当前委派深度；到达 maxDelegationDepth 后不再暴露委派工具。 */
  delegationDepth: number
  contract?: V4CapabilityContract
}

/**
 * 计算一个 Agent 实际可见的工具集合。
 *
 * 顺序固定：role 集合 → 减去被 capability 关掉的 → 减去深度不允许的委派工具 →
 * 减去写能力被 sandbox 收窄掉的。任何一层只能缩小，不能扩大。
 */
export function resolveToolsForRole(input: ResolveToolsInput): string[] {
  const contract = input.contract ?? loadCapabilityContract()
  const roleTools = contract.roleTools[input.role]
  if (!roleTools) {
    throw new CapabilityContractError(
      `unknown agent role: ${input.role}`,
      'AGENT_ROLE_DENIED',
    )
  }
  const denied = new Set<string>()
  for (const [capability, tools] of Object.entries(CAPABILITY_TOOLS) as Array<
    [keyof V4Capabilities, readonly string[]]
  >) {
    if (!input.policy.capabilities[capability]) {
      for (const tool of tools) denied.add(tool)
    }
  }
  // 深度到顶：不再暴露任何能再造 Agent 的工具，否则 depth 限制只能靠事后拒绝。
  if (input.delegationDepth >= input.policy.agents.maxDelegationDepth) {
    for (const tool of ['subagent', 'subagent_fork', 'workflow', 'ralph']) denied.add(tool)
  }
  // read-only 沙箱下没有写工具可言。
  if (input.policy.sandbox.defaultMode === 'read-only') {
    for (const tool of ['write', 'edit', 'bash', 'job_list', 'job_output', 'job_kill']) {
      denied.add(tool)
    }
  }
  return roleTools.filter((tool) => !denied.has(tool))
}

/**
 * 校验解析出来的工具面。
 *
 * 两个方向都要查：出现契约外的工具（Harness 升级偷偷加了东西）→ fail closed；
 * root 缺少 policy 要求的工具（profile 被改坏）→ 同样 fail closed。
 */
export function assertResolvedInventory(input: {
  role: AgentRole
  resolved: readonly string[]
  policy: V4CapabilityPolicy
  delegationDepth?: number
  contract?: V4CapabilityContract
}): void {
  const contract = input.contract ?? loadCapabilityContract()
  const unknown = input.resolved.filter((tool) => !(tool in contract.modelTools))
  if (unknown.length > 0) {
    throw new CapabilityContractError(
      `resolved tool inventory contains tools outside the V4 contract: ${unknown.sort().join(', ')}`,
      'CAPABILITY_CONTRACT_UNKNOWN_TOOL',
    )
  }
  const expected = new Set(
    resolveToolsForRole({
      role: input.role,
      policy: input.policy,
      delegationDepth: input.delegationDepth ?? 0,
      contract,
    }),
  )
  const extra = input.resolved.filter((tool) => !expected.has(tool))
  if (extra.length > 0) {
    throw new CapabilityContractError(
      `role ${input.role} resolved tools it must not see: ${extra.sort().join(', ')}`,
      'AGENT_ROLE_DENIED',
    )
  }
  const missing = [...expected].filter((tool) => !input.resolved.includes(tool))
  if (missing.length > 0) {
    throw new CapabilityContractError(
      `role ${input.role} is missing V4 default tools: ${missing.sort().join(', ')}`,
      'CAPABILITY_CONTRACT_MISSING_TOOL',
    )
  }
}

/** Broker 路由 → 需要的能力。未知路由一律拒绝。 */
export function brokerRouteCapability(
  route: string,
  contract: V4CapabilityContract = loadCapabilityContract(),
): BrokerRouteEntry | null {
  return contract.brokerRoutes[route] ?? null
}

/** 一个 role 拥有哪些 Broker 能力。 */
export function brokerCapabilitiesForRole(input: {
  role: AgentRole
  policy: V4CapabilityPolicy
  delegationDepth: number
  contract?: V4CapabilityContract
}): Set<BrokerCapability> {
  const tools = new Set(resolveToolsForRole(input))
  const capabilities = new Set<BrokerCapability>()
  // 每个 Agent 都要能注册子节点与上报用量，否则治理面自己就断了。
  capabilities.add('agentRegister')
  capabilities.add('usageReport')
  if (
    tools.has('search_snapshot_code') ||
    tools.has('find_snapshot_files') ||
    tools.has('read_snapshot_code') ||
    tools.has('list_snapshot_commits')
  ) {
    capabilities.add('snapshotRead')
  }
  if (tools.has('web_search') || tools.has('web_fetch')) capabilities.add('webEgress')
  if (tools.has('write') || tools.has('edit') || tools.has('bash')) {
    if (input.policy.capabilities.artifacts) capabilities.add('artifactWrite')
  }
  if (tools.has(SUBMIT_TOOL_NAME)) capabilities.add('submitReview')
  return capabilities
}

/** 该工具是否可以与其他工具并行调用。 */
export function isParallelSafeTool(
  tool: string,
  contract: V4CapabilityContract = loadCapabilityContract(),
): boolean {
  return contract.modelTools[tool]?.parallelSafe === true
}

/** 该工具是否有副作用（mutation/submit 必须串行）。 */
export function isMutatingTool(
  tool: string,
  contract: V4CapabilityContract = loadCapabilityContract(),
): boolean {
  return contract.modelTools[tool]?.mutating === true
}

/** Policy 的稳定摘要，与结果一起入库用于追溯。 */
export function policyHash(policy: V4CapabilityPolicy): string {
  return createHash('sha256').update(stableStringify(policy)).digest('hex')
}

/** 键序无关的 JSON 序列化：hash 不能随对象字面量的书写顺序变化。 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    compareCanonicalText(a, b),
  )
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`
}
