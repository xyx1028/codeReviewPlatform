/**
 * 产品代码问答的只读能力策略（V1.23）。
 *
 * 问答复用的是评审那条路上的**中间层**（profile 物化 + ACP 会话 + 只读快照工具），
 * 但它的能力面必须比评审窄得多。理由不是"保守一点比较好"，而是三条具体的：
 *
 *   1. **问答没有产出物。** 它不提交评审结论、不写文件、不开子 Agent。任何写工具留在
 *      工具面里都只可能被误用，不可能被正当使用。
 *   2. **成本必须可预期。** 一个产品经理在对话框里敲一句话，期待的是几十秒的回答。
 *      放开 subagent / workflow / ralph 会让单次提问的开销变成不可预测的一棵树。
 *   3. **故事相关工具在问答里没有语义。** `list_story_commits` / `read_story_commit_diff`
 *      需要一个 `review_story`，而问答没有故事。留着它们等于给模型一个调用就会失败的
 *      工具 —— 模型会重试，然后把轮次拖死在一个无解的循环里。
 *
 * **这份策略不改 `v4-capability-contract.json`。** 它只是把契约里已有的能力面收窄；
 * 契约哈希与 manifest revision（3）一字不动，所以新旧 Worker 可以混跑同一套数据库。
 */

import {
  CapabilityContractError,
  resolveToolsForRole,
  V4_DEFAULT_POLICY,
  isMutatingTool,
  type V4CapabilityPolicy,
} from '../policy/v4-capability-policy.js'

/**
 * 问答用的 Agent 角色。
 *
 * 选 `research-child` 而不是 `root-reviewer`：契约里前者的工具面**本来就是只读的**
 * （没有 bash / write / edit / submit_review_result）。从一个只读角色出发再收窄，
 * 比从全能力角色出发逐个关掉要安全——后者漏掉一个就是一个写口子。
 */
export const CODE_QA_AGENT_ROLE = 'research-child' as const

/**
 * 即使角色里有、也一律不给问答的工具。
 *
 * 前两个需要 `review_story`（问答没有故事）；后两个是多 Agent 协作的观测面，
 * 而问答只有一个 Agent，列出来只会让模型以为还有别人可以问。
 */
export const CODE_QA_DENIED_TOOLS: readonly string[] = [
  'list_story_commits',
  'read_story_commit_diff',
  'list_agents',
  'expand_analysis_scope',
]

/**
 * 从平台默认策略推导出问答策略。
 *
 * 只做减法。每一个 `false` 都对应上面三条理由之一，不是随手关的。
 */
export function buildCodeQaPolicy(
  base: V4CapabilityPolicy = V4_DEFAULT_POLICY,
): V4CapabilityPolicy {
  return {
    ...base,
    capabilities: {
      ...base.capabilities,

      // —— 保留：问答要靠它们工作 ——
      // instructions：AGENTS.md 之类的项目约定，帮模型理解代码组织方式
      instructions: true,
      // skills：产品问的就是"某个模块的逻辑"，模块技能正是这一层知识
      skills: true,
      // filesystem：read / grep / glob。模型自己检索代码的主力
      filesystem: true,
      // autoCompaction：多轮对话必然增长，不压缩会在第几轮突然撞上下文上限
      autoCompaction: true,
      // sessionPersistence + sessionResume：多轮对话的全部意义所在
      sessionPersistence: true,
      sessionResume: true,
      // todo：允许模型给自己列检索步骤，长问题的回答质量明显更稳
      todo: true,
      plan: true,

      // —— 关掉：会产生写、会开枝散叶、或者没有语义 ——
      // shell：read-only 沙箱下 bash 本来就会被 resolveToolsForRole 摘掉，
      // 这里再显式关一次，免得以后有人把沙箱模式改了却忘了这一层
      shell: false,
      // 单个提问不开子 Agent：成本与延迟必须可预期
      subagentSpawn: false,
      subagentFork: false,
      subagentControl: false,
      workflow: false,
      jobs: false,
      ralph: false,
      // 问代码不需要出网。关掉它同时去掉了一整类"模型去网上找答案然后当成本仓库实现"的风险
      webSearch: false,
      webFetch: false,
      // 问答不产出 artifact
      artifacts: false,
      // goal 是评审编排用的，问答的"目标"就是回答这一个问题
      goal: false,
      // 一次一个工具，答案的可复核性比速度重要
      parallelTools: false,
    },
    sandbox: {
      ...base.sandbox,
      // 只读。这一行同时让 resolveToolsForRole 摘掉 write/edit/bash/job_*。
      defaultMode: 'read-only',
      dangerFullAccess: false,
    },
    agents: {
      ...base.agents,
      // 只允许一个 Agent，深度 0 —— 配合 delegationDepth 让委派工具彻底不出现。
      maxAgentsPerAttempt: 1,
      maxDelegationDepth: 0,
      maxConcurrentChildren: 0,
      allowOutOfProcessProviders: false,
    },
    parallelTools: {
      ...base.parallelTools,
      maxPerStep: 1,
      mutationToolsSerial: true,
    },
    web: {
      ...base.web,
      // 出网能力已经关了；预算一起归零，避免"能力关了但预算还写着 200 次"这种
      // 自相矛盾的策略被后人当成可以放开的信号。
      maxRequestsPerAttempt: 0,
      maxResponseBytes: 0,
      maxTotalBytes: 0,
      allowedDomains: [],
    },
  }
}

/**
 * 解析问答会话实际暴露给模型的工具面。
 *
 * `delegationDepth` 传 0 且策略里 `maxDelegationDepth` 也是 0，所以
 * `resolveToolsForRole` 会把 subagent / workflow / ralph 一并摘掉。
 */
export function resolveCodeQaTools(policy: V4CapabilityPolicy = buildCodeQaPolicy()): string[] {
  const denied = new Set(CODE_QA_DENIED_TOOLS)
  return resolveToolsForRole({
    role: CODE_QA_AGENT_ROLE,
    policy,
    delegationDepth: 0,
  }).filter((tool) => !denied.has(tool))
}

/**
 * 契约标了 mutating、但只改 **Agent 自己的内存状态** 的工具。
 *
 * 契约里的 `mutating` 标记服务于两件事：并行安全判定，和"这个工具会改东西吗"。
 * `todo_write` 命中的是前者 —— 它写的是 Agent 自己的待办清单，碰不到快照、碰不到
 * 数据库、碰不到任何平台记录。问答保留它是因为实测长问题下模型先列检索步骤再执行，
 * 答案的稳定性明显更好。
 *
 * 这个名单**必须逐项列举**，不能改成按前缀或按类别放行：下面那条断言存在的全部意义
 * 就是"以后有人动了契约、角色或能力映射时能炸出来"，而一个宽松的规则会让它炸不出来。
 */
export const CODE_QA_ALLOWED_AGENT_LOCAL_MUTATIONS: readonly string[] = ['todo_write']

/**
 * fail closed：工具面里出现任何能改代码、改仓库或改平台记录的工具就拒绝启动会话。
 *
 * 这不是重复检查。`buildCodeQaPolicy` 里那些 `false` 是**意图**，而这里断言的是
 * **结果** —— 契约文件、角色定义或 `CAPABILITY_TOOLS` 任何一处以后被改动，都可能让一个
 * 写工具重新漏进来，而那种漏不会有任何症状：问答照样工作，只是模型手里多了一把能改
 * 代码的工具。
 */
export function assertCodeQaToolsReadOnly(tools: readonly string[]): void {
  const agentLocal = new Set(CODE_QA_ALLOWED_AGENT_LOCAL_MUTATIONS)
  const offenders = tools.filter((tool) => isMutatingTool(tool) && !agentLocal.has(tool))
  if (offenders.length > 0) {
    throw new CapabilityContractError(
      `code QA tool surface must be read-only, but got mutating tools: ${offenders.join(', ')}`,
      'CODE_QA_TOOL_SURFACE_NOT_READ_ONLY',
    )
  }
  if (tools.includes('submit_review_result')) {
    throw new CapabilityContractError(
      'code QA must not expose the review submission tool',
      'CODE_QA_TOOL_SURFACE_NOT_READ_ONLY',
    )
  }
}

/**
 * 问答会话批准的工具白名单（传给 `runSingleAcpTurn` 的 `permittedTools`）。
 *
 * **必须显式传**，不能省略：`acp-client.ts` 的 `DEFAULT_PERMITTED_TOOLS` 是
 * `['submit_review_result']`，省略参数等于在问答会话里批准评审提交工具。
 * 空数组的语义是"不批准任何需要审批的工具"——只读工具本身不触发 permission 请求。
 */
export const CODE_QA_PERMITTED_TOOLS: readonly string[] = []
