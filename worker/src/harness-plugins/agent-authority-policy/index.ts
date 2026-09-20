/**
 * Harness 进程内的角色策略与身份注册。
 *
 * 这是 root-only submit 的**第一层**（另两层在 Broker 与数据库）。它在 `tools/pre-execute`
 * 上拦截每一次调用，做三件事：
 *
 *   1. 解析调用者身份（必要时向 Broker 注册子 Agent 并领取 capability token）；
 *   2. 按角色允许的工具集合放行或拒绝 —— 默认 deny，只有策略明确允许才 allow；
 *   3. 记录委派工具的进出，为下一个新 Agent 确定父节点。
 *
 * 为什么在这里也要拦一次：Harness 的 child toolFilter 能把工具从子 Agent 的上下文里摘掉，
 * 但摘掉不等于不可调用 —— 一个知道工具名的模型仍然可以直接构造调用。所以工具面收窄和
 * 调用面拒绝必须都做。
 *
 * 拒绝的返回方式很关键：非根 Agent 调用 submit 时返回一个可读的错误，**不 conclude turn**，
 * 于是子 Agent 会把结论交回父 Agent 而不是原地卡死。
 */

import z from '@deepseek-ai/schemastery'
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { installAgentIdentityRegistry, DELEGATION_TOOLS } from '../shared/agent-identity.js'
import { brokerPost, BrokerChannelError } from '../shared/broker-client.js'
import {
  BROKER_TOKEN_ENV,
  ROOT_CAPABILITY_ENV,
  readCredentialFromEnv,
} from '../shared/credential-env.js'

export const name = 'agent-authority-policy'

export const inject = ['tools']

export interface AgentAuthorityConfig {
  socketPath: string
  taskId: string
  agentAttempt: number
  requestTimeoutMs?: number
  /** Worker 生成的稳定根身份。id 不是秘密，capability token 才是，后者只走环境变量。 */
  rootAgentId: string
  rootSessionId: string
  /** 根 Agent 可见的工具集合，由 Worker 按 policy 解析后传入。 */
  rootTools: string[]
  /**
   * 子 Agent 可见的工具集合（各 child 角色的并集）。
   *
   * 用于在 `agent/created` 时对子 Agent 的 scoped context 调 `tools.restrict()` —— 这是**唯一**
   * 能覆盖全部委派路径的收窄点。`tool-subagent` 的 `toolFilter` 配置只作用于经那个工具创建的
   * 子 Agent；workflow 走 `workflow-worker-thread` 直连 provider，其 `startAgent()` 只转发
   * prompt/schema/provider/model，**不转发 toolFilter**，所以实测 workflow 子 Agent 拿到的是
   * 与根 Agent 相同的 30 个工具，其中包含 `submit_review_result`。
   */
  childTools: string[]
  /**
   * 本次 attempt 物化的技能目录（`<DSH_HOME>/skills`）。
   *
   * 只用于**审计归因**：判断一次 `read` / `read_image` / `grep` / `glob` / `bash` 是不是在
   * 读技能资源，从而把安全的相对路径记进审计。它不是权限边界 —— 权限边界是沙箱与角色
   * 工具面。空字符串表示这个 attempt 没有技能目录。
   */
  skillsDir?: string
  /**
   * 冻结技能的 `name → bundleHash`。
   *
   * 插件不解析 Bundle、也不信任模型自报的 hash：它只把模型传给 `skill(name)` 的那个
   * name 在这张表里查一次。查不到就什么都不带 —— Broker 侧还会用自己的冻结目录再核一次，
   * 数据库还会按 `(job, name, bundle_hash)` 反查 snapshot id。三层都不采信上报值本身。
   */
  skills?: Array<{ name: string; bundleHash: string }>
}

export const Config: z<AgentAuthorityConfig> = z.object({
  socketPath: z.string().required(),
  taskId: z.string().required(),
  agentAttempt: z.number().required(),
  requestTimeoutMs: z.number(),
  rootAgentId: z.string().required(),
  rootSessionId: z.string().required(),
  rootTools: z.array(z.string()).required(),
  childTools: z.array(z.string()).required(),
  skillsDir: z.string(),
  skills: z.array(z.object({ name: z.string().required(), bundleHash: z.string().required() })),
})

/**
 * 会消费技能资源的工具。
 *
 * 这张表决定"要不要去参数里找路径"。它刻意只含**已有**的工具 —— V1.6 不新增任何模型工具，
 * 技能资源就是用这些工具读的（方案 §3.3）。
 */
const RESOURCE_TOOLS: ReadonlySet<string> = new Set([
  'read',
  'read_image',
  'grep',
  'glob',
  'bash',
])

/** 审计里允许出现的规范相对路径。带 `..`、绝对路径、反斜杠或空白的一律丢弃。 */
function safeRelativePath(value: string): string | undefined {
  if (value === '' || value.length > 240) return undefined
  if (/(^\/)|(\\)|(^[A-Za-z]:)|(\.\.)|(^\s)|(\s$)/.test(value)) return undefined
  return value
}

/**
 * 从工具参数里推导 `(skillName, relativePath)`。
 *
 * 只看**字符串型**参数，且只在它以物化目录为前缀时才认。不递归遍历任意对象：那会把
 * 命令正文和查询串也扫进来，而审计明确不存这些东西（方案 §16）。
 */
export function describeSkillResourceAccess(
  args: unknown,
  skillsDir: string,
): { skillName: string; relativePath?: string } | undefined {
  if (skillsDir === '' || args === null || typeof args !== 'object') return undefined
  const prefix = skillsDir.endsWith('/') ? skillsDir : `${skillsDir}/`
  for (const key of ['path', 'file', 'filePath', 'file_path', 'pattern', 'cwd', 'command']) {
    const value = (args as Record<string, unknown>)[key]
    if (typeof value !== 'string') continue
    const at = value.indexOf(prefix)
    if (at < 0) continue
    const tail = value.slice(at + prefix.length)
    // 第一段是技能名，其余是相对路径。用空白截断：`bash` 的 command 里路径后面还有别的。
    const cut = tail.search(/[\s'"]/)
    const cleaned = cut < 0 ? tail : tail.slice(0, cut)
    const slash = cleaned.indexOf('/')
    if (slash < 0) {
      return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(cleaned) ? { skillName: cleaned } : undefined
    }
    const skillName = cleaned.slice(0, slash)
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(skillName)) return undefined
    return { skillName, relativePath: safeRelativePath(cleaned.slice(slash + 1)) }
  }
  return undefined
}

/** 拒绝时给模型的说明。写给模型看：说清楚为什么，以及下一步该做什么。 */
function denialMessage(toolName: string, role: string): string {
  if (toolName === 'submit_review_result') {
    return (
      'submit_review_result is available only to the root reviewer. ' +
      'Return your findings and evidence ids to your parent agent instead; ' +
      'the root agent will consolidate them and submit once.'
    )
  }
  return (
    `${toolName} is not available to a ${role} agent in this attempt. ` +
    'Use the tools you were given, or report back to your parent if you need work done that you cannot do.'
  )
}

export function apply(ctx: Context, config: AgentAuthorityConfig): void {
  const channel = {
    socketPath: config.socketPath,
    token: readCredentialFromEnv(BROKER_TOKEN_ENV),
    timeoutMs: config.requestTimeoutMs ?? 30000,
  }
  const registry = installAgentIdentityRegistry({
    ...channel,
    taskId: config.taskId,
    agentAttempt: config.agentAttempt,
    rootAgentId: config.rootAgentId,
    rootSessionId: config.rootSessionId,
    rootCapability: readCredentialFromEnv(ROOT_CAPABILITY_ENV),
    rootTools: config.rootTools,
    // lineage 的第一来源：Harness 自己写在子会话头部的 parentSession / delegationDepth。
    // 比"当前正在执行委派工具的那个 Agent"这个时序推断可靠 —— 后者对后台委派不成立。
    sessionHeader: (sessionId) => readSessionHeader(sessionId),
  })

  /** 按 session id 读 Harness 权威头部。读不到返回 undefined，由调用方 fail closed。 */
  function readSessionHeader(
    sessionId: string,
  ): { parentSession?: string; delegationDepth?: number; origin?: string } | undefined {
    {
      try {
        const viaGet = (ctx as unknown as { get(name: string): unknown }).get?.('sessions') as
          | { get(id: string): unknown }
          | undefined
        const sessions =
          viaGet ?? (ctx as unknown as { sessions?: { get(id: string): unknown } }).sessions
        const session = sessions?.get(sessionId) as { header?: Record<string, unknown> } | undefined
        const header = session?.header
        if (!header) return undefined
        return {
          parentSession:
            typeof header.parentSession === 'string' ? header.parentSession : undefined,
          delegationDepth:
            typeof header.delegationDepth === 'number' ? header.delegationDepth : undefined,
          origin: typeof header.origin === 'string' ? header.origin : undefined,
        }
      } catch {
        // 读不到头部不是致命错误：回落到时序推断，仍然 fail closed 而不是放宽。
        return undefined
      }
    }
  }

  /**
   * 子 Agent 一出现就收窄它的工具面。
   *
   * `tools.restrict()` 要求 scoped context（`agent.ctx`），而 `agent/created` 的载荷正好给到
   * 新 Agent 本身。这是唯一覆盖**全部**委派路径的收窄点：`tool-subagent` 的 `toolFilter` 只管
   * 经那个工具创建的子 Agent，workflow 的 `startAgent()` 不转发 toolFilter，实测 workflow
   * 子 Agent 因此拿到与根 Agent 相同的 30 个工具（含 `submit_review_result`）。
   *
   * 判据用 Harness 权威的会话头部 `origin === 'subagent'`，不用"当前是否在委派"这种时序推断 ——
   * 后台委派下时序推断不成立。根 Agent 的头部没有这个标记，因此不会被误收窄。
   */
  ctx.on('agent/created', function (payload: { agent?: unknown }) {
    const agent = payload?.agent as
      | {
          id?: string
          ctx?: { tools?: { restrict(filter: { allow?: string[]; deny?: string[] }): unknown } }
        }
      | undefined
    const agentId = agent?.id
    if (agentId === undefined || agentId === '') return
    if (agentId === config.rootAgentId || agentId === config.rootSessionId) return
    if (readSessionHeader(agentId)?.origin !== 'subagent') return

    const restrict = agent?.ctx?.tools?.restrict
    if (typeof restrict !== 'function') return
    try {
      restrict.call(agent!.ctx!.tools, { allow: [...config.childTools] })
    } catch (err) {
      // allow 名单里若出现当前 composition 未注册的工具，restrict 会抛错。那种情况下退到
      // 最低保证：至少不能让子 Agent 看见提交工具。两次都失败才放弃，并且必须留痕 ——
      // 静默失败等于悄悄把工具面还原成根 Agent 的全集。
      try {
        restrict.call(agent!.ctx!.tools, { deny: ['submit_review_result'] })
        process.stderr.write(
          `[agent-authority-policy] child tool allow-list rejected, fell back to deny-submit: ` +
            `${(err as Error)?.message ?? String(err)}\n`,
        )
      } catch (fallbackErr) {
        process.stderr.write(
          `[agent-authority-policy] child tool restriction failed entirely: ` +
            `${(fallbackErr as Error)?.message ?? String(fallbackErr)}\n`,
        )
      }
    }
  })

  /**
   * 把一次拒绝告知 Broker，好让它落进 analysis_permission_decision 与 rejected_submissions。
   *
   * 失败**必须留痕**。此前这里是 `.catch(() => undefined)`：一次上报失败就等于一条治理审计
   * 凭空消失，而运维在 `rejected_submissions` 里只会看到空数组，完全不知道刚才有子 Agent
   * 冲撞过提交权。实测就踩到了这个坑 —— workflow 子 Agent 被正确拒绝了 30 多次，平台侧却
   * 一条记录都没有。
   *
   * 上报走的是本进程内的 Unix socket，正常情况下不会失败；失败说明身份或通道有问题，那是
   * 需要人看的事件，不是可以吞掉的噪声。
   */
  function reportDenial(input: {
    agentCapability: string
    agentId: string
    sessionId: string
    toolName: string
    reasonCode: string
    correlationId: string
  }): void {
    void brokerPost<{ accepted?: boolean }>(channel, '/attempt/tool-audit', {
      taskId: config.taskId,
      agentAttempt: config.agentAttempt,
      agentCapability: input.agentCapability,
      agentId: input.agentId,
      sessionId: input.sessionId,
      toolName: input.toolName,
      decision: 'DENY',
      reasonCode: input.reasonCode,
      // V1.5：同一次 POST 顺带带上生命周期终态，不新增 Broker 路由（方案 §7.2）。
      lifecycle: {
        phase: 'TERMINAL',
        outcome: 'DENIED',
        correlationId: input.correlationId,
        toolName: input.toolName,
        occurredAt: new Date().toISOString(),
        durationMs: 0,
        reasonCode: input.reasonCode,
        errorCode: input.reasonCode,
      },
      entries: [
        {
          toolName: input.toolName,
          permissionVerdict: 'DENY',
          errorCode: input.reasonCode,
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          durationMs: 0,
        },
      ],
    })
      .then((response) => {
        if (response.status >= 200 && response.status < 300) return
        // 走 stderr 而不是只走 ctx.logger：Worker 会捕获子进程 stderr 并脱敏后记录，
        // 而 Harness 内部 logger 的输出不一定进平台日志。
        process.stderr.write(
          `[agent-authority-policy] denial audit refused: status=${response.status} ` +
            `tool=${input.toolName} reason=${input.reasonCode}\n`,
        )
      })
      .catch((err: unknown) => {
        const code = err instanceof BrokerChannelError ? err.code : 'UNKNOWN'
        process.stderr.write(
          `[agent-authority-policy] denial audit failed: code=${code} ` +
            `tool=${input.toolName} reason=${input.reasonCode}\n`,
        )
      })
  }

  /**
   * 一条工具生命周期上报。
   *
   * 复用现有的 `/attempt/tool-audit` 路由（V1.5 硬约束：不新增 Broker 路由，
   * 否则 manifest 哈希改变 → 新 Worker 拒绝所有在途任务 → 必须排空所有活动批次）。
   * `entries` 传空数组，现有审计行为完全不受影响。
   *
   * fail open：监控上报失败只写 stderr，不影响工具执行。
   */
  function postToolLifecycle(
    identity: { agentCapability: string; agentId: string; sessionId: string },
    lifecycle: Record<string, string | number | boolean | undefined>,
    /**
     * V1.6 技能归因（方案 §16）。
     *
     * 只在 TERMINAL 上传一次 `entries`，不在 STARTED 上传：`entries` 是持久审计行，
     * 一次调用应当只落一行。STARTED 的作用是驱动"正在调用"投影，它不需要审计行。
     */
    skill?: { skillName: string; skillBundleHash?: string; resourceRelativePath?: string },
  ): Promise<void> {
    return brokerPost<{ accepted?: boolean }>(channel, '/attempt/tool-audit', {
      taskId: config.taskId,
      agentAttempt: config.agentAttempt,
      agentCapability: identity.agentCapability,
      agentId: identity.agentId,
      sessionId: identity.sessionId,
      toolName: lifecycle.toolName,
      lifecycle,
      entries:
        skill === undefined
          ? []
          : [
              {
                toolName: String(lifecycle.toolName ?? 'unknown'),
                permissionVerdict: 'ALLOW',
                errorCode: lifecycle.errorCode ?? null,
                startedAt: String(lifecycle.occurredAt ?? new Date().toISOString()),
                finishedAt: String(lifecycle.occurredAt ?? new Date().toISOString()),
                durationMs: typeof lifecycle.durationMs === 'number' ? lifecycle.durationMs : 0,
                skillName: skill.skillName,
                skillBundleHash: skill.skillBundleHash,
                resourceRelativePath: skill.resourceRelativePath,
              },
            ],
    })
      .then(() => undefined)
      .catch((err: unknown) => {
        const code = err instanceof BrokerChannelError ? err.code : 'UNKNOWN'
        process.stderr.write(
          `[agent-authority-policy] tool lifecycle report failed: code=${code} ` +
            `tool=${String(lifecycle.toolName)} phase=${String(lifecycle.phase)}\n`,
        )
      })
  }

  /** 把 TERMINAL 挂在 STARTED settle 之后，保证同一 correlation 在 socket 上不乱序。 */
  function chainToolLifecycle(
    started: Promise<void>,
    identity: { agentCapability: string; agentId: string; sessionId: string },
    lifecycle: Record<string, string | number | boolean | undefined>,
    skill?: { skillName: string; skillBundleHash?: string; resourceRelativePath?: string },
  ): void {
    void started.then(() => postToolLifecycle(identity, lifecycle, skill))
  }

  /** 冻结技能的 name → bundleHash。查不到就不带 hash，让 Broker 与数据库各自再核一次。 */
  const skillBundleHashes = new Map(
    (config.skills ?? []).map((skill) => [skill.name, skill.bundleHash] as const),
  )

  /**
   * 一次工具调用的技能归因。
   *
   * 两种来源，都不采信模型自报的 hash：
   *
   *   * `skill(name)` —— name 直接来自参数，是"加载了哪个技能"的权威信号；
   *   * `read/read_image/grep/glob/bash` —— 从参数里的**绝对路径前缀**反推，是"读了哪个
   *     技能的哪个资源"。
   */
  function attributeSkill(
    toolName: string,
    args: unknown,
  ): { skillName: string; skillBundleHash?: string; resourceRelativePath?: string } | undefined {
    if (toolName === 'skill') {
      const name = (args as { name?: unknown } | null)?.name
      if (typeof name !== 'string' || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) return undefined
      return { skillName: name, skillBundleHash: skillBundleHashes.get(name) }
    }
    if (!RESOURCE_TOOLS.has(toolName)) return undefined
    const access = describeSkillResourceAccess(args, config.skillsDir ?? '')
    if (access === undefined) return undefined
    return {
      skillName: access.skillName,
      skillBundleHash: skillBundleHashes.get(access.skillName),
      resourceRelativePath: access.relativePath,
    }
  }

  ctx.on(
    'tools/pre-execute',
    async function (exec, next) {
      const toolName = exec.name
      const harnessAgentId = (exec as { agent?: { id?: string } }).agent?.id

      let identity
      try {
        identity = await registry.resolve(harnessAgentId)
      } catch (err) {
        const code = err instanceof BrokerChannelError ? err.code : 'AGENT_IDENTITY_INVALID'
        // 身份解析失败是结构性问题，不是模型能改的：明确拒绝，不给它一个默认身份。
        return {
          decision: 'deny',
          reason: `this call has no verifiable agent identity (${code})`,
        } as never
      }

      // 一次工具调用生命周期的稳定随机 ID。绝不用命令、URL 或路径当 correlation。
      const correlationId = randomUUID()

      // 平台工具的最终判定在 Broker（它持有令牌表）。这里仍然先拦一次：能在进入模型
      // 上下文之前拒绝的，就不要浪费一次往返和一次 tool result。
      if (!identity.tools.includes(toolName)) {
        reportDenial({
          agentCapability: identity.agentCapability,
          agentId: identity.agentId,
          sessionId: identity.sessionId,
          toolName,
          reasonCode: toolName === 'submit_review_result' ? 'SUBMIT_ROOT_ONLY' : 'AGENT_ROLE_DENIED',
          correlationId,
        })
        return {
          decision: 'deny',
          reason: denialMessage(toolName, identity.role),
        } as never
      }

      const skillAttribution = attributeSkill(toolName, exec.arguments)

      // Harness-native resource tools execute without a Broker dispatch. Before any of them runs,
      // synchronously ask the Broker that owns the dynamic V2 scope and DB-frozen candidates.
      // The query branch never persists these model-controlled arguments. Legacy V1 and GLOBAL
      // return allow; transport/protocol uncertainty fails closed with one stable code.
      if (RESOURCE_TOOLS.has(toolName)) {
        let scopeAllowed = false
        let scopeReason =
          'native resource access could not be authorized; use snapshot tools or expand the analysis scope'
        try {
          const response = await brokerPost<{
            allowed?: boolean
            code?: string
            reason?: string
          }>(channel, '/attempt/tool-audit', {
            taskId: config.taskId,
            agentAttempt: config.agentAttempt,
            agentCapability: identity.agentCapability,
            agentId: identity.agentId,
            sessionId: identity.sessionId,
            toolName,
            scopeCheck: { toolName, arguments: exec.arguments },
          })
          scopeAllowed = response.status >= 200 && response.status < 300 && response.body.allowed === true
          if (
            response.body.code === 'SNAPSHOT_SCOPE_DENIED' &&
            typeof response.body.reason === 'string' &&
            response.body.reason !== ''
          ) {
            scopeReason = response.body.reason
          }
        } catch {
          // Authorization channel uncertainty is not observability failure: never execute the tool.
        }
        if (!scopeAllowed) {
          reportDenial({
            agentCapability: identity.agentCapability,
            agentId: identity.agentId,
            sessionId: identity.sessionId,
            toolName,
            reasonCode: 'SNAPSHOT_SCOPE_DENIED',
            correlationId,
          })
          return {
            decision: 'deny',
            reason: `[SNAPSHOT_SCOPE_DENIED] ${scopeReason}`,
          } as never
        }
      }

      if (DELEGATION_TOOLS[toolName]) {
        // 委派开始：下一个出现的新 Agent 归这个父节点。串行 mutation 保证这里不会歧义。
        registry.beginDelegation(
          identity.agentId,
          toolName,
          requestedRoleFrom(exec.arguments),
        )
      }

      // 这是覆盖全部 30 个模型工具的唯一插桩点：25 个 harness origin 工具
      // （bash / read / write / edit / grep / glob / web_search / workflow / job_* / subagent …）
      // 在 Harness 进程内执行，根本不经过 Broker dispatch。只在 Broker 侧插桩的话，
      // 监控台的"正在调用工具"只能看到 5 个平台快照工具 —— 而实现型 Agent 的绝大部分
      // 时间恰恰花在 bash / edit / read 上。
      //
      // STARTED 不 await：给每次工具调用加一次同步 IPC 往返是不可接受的。但 TERMINAL 必须
      // 挂在 STARTED settle 之后 —— Node 的 http agent 可能用不同连接，纯 fire-and-forget
      // 会让同一个 correlation 的两条上报在 socket 上乱序。
      const startedAt = new Date()
      const startedPost = postToolLifecycle(identity, {
        phase: 'STARTED',
        correlationId,
        toolName,
        occurredAt: startedAt.toISOString(),
      })
      const t0 = Date.now()

      try {
        const result = await next()
        chainToolLifecycle(
          startedPost,
          identity,
          {
            phase: 'TERMINAL',
            outcome: 'COMPLETED',
            correlationId,
            toolName,
            occurredAt: new Date().toISOString(),
            durationMs: Date.now() - t0,
            ...describeToolResult(result),
          },
          skillAttribution,
        )
        return result
      } catch (err) {
        chainToolLifecycle(startedPost, identity, {
          phase: 'TERMINAL',
          outcome: 'FAILED',
          correlationId,
          toolName,
          occurredAt: new Date().toISOString(),
          durationMs: Date.now() - t0,
          errorCode: stableToolErrorCode(err),
        })
        throw err
      }
    },
    { global: true, prepend: true },
  )

  // 委派工具结束后清掉标记。放在 post-execute 而不是 execute 的 finally 里，是因为
  // pre-execute 拒绝掉的调用不会进入 execute，那种情况下 begin 也没发生过。
  ctx.on(
    'tools/post-execute',
    async function (exec, _result, next) {
      const harnessAgentId = (exec as { agent?: { id?: string } }).agent?.id
      if (harnessAgentId !== undefined && DELEGATION_TOOLS[exec.name]) {
        const known = registry.known(harnessAgentId) ?? registry.known(config.rootAgentId)
        registry.endDelegation(known?.agentId ?? harnessAgentId, exec.name)
      }
      return next()
    },
    { global: true },
  )

  ctx.effect(() => () => {
    // 身份表随进程消亡。Broker 侧的令牌在 attempt 收敛时统一撤销，不依赖这里。
  })
}

/**
 * 从工具结果里抽出**安全的**诊断标量（方案 §6.5 的六个诊断扩展字段）。
 *
 * 判断标准是"这个字段能不能反推出源码或凭据"。这里只取整数、布尔和字节数：
 * 命令文本、stdout/stderr 正文、文件路径、查询串一律不取。序列化只用来量长度，
 * 结果本身绝不外传。
 */
function describeToolResult(result: unknown): Record<string, number | boolean | undefined> {
  const out: Record<string, number | boolean | undefined> = {}
  if (result === null || typeof result !== 'object') return out
  const record = result as Record<string, unknown>

  const exitCode = record.exitCode ?? record.exit_code
  if (typeof exitCode === 'number' && Number.isFinite(exitCode)) out.exitCode = exitCode

  if (typeof record.truncated === 'boolean') out.truncated = record.truncated

  const hits = record.hits
  if (Array.isArray(hits)) out.hitCount = hits.length
  else if (typeof record.hitCount === 'number') out.hitCount = record.hitCount
  else if (typeof record.matchCount === 'number') out.hitCount = record.matchCount

  const files = record.files
  if (out.hitCount === undefined && Array.isArray(files)) out.hitCount = files.length

  const startLine = record.startLine ?? record.start_line
  const endLine = record.endLine ?? record.end_line
  if (typeof startLine === 'number' && typeof endLine === 'number' && endLine >= startLine) {
    out.lineSpan = endLine - startLine + 1
  } else if (typeof record.lineCount === 'number') {
    out.lineSpan = record.lineCount
  }

  for (const key of ['output', 'stdout', 'content', 'text'] as const) {
    const value = record[key]
    if (typeof value === 'string') {
      out.outputBytes = Buffer.byteLength(value, 'utf8')
      break
    }
  }

  try {
    out.responseBytes = Buffer.byteLength(JSON.stringify(result) ?? '', 'utf8')
  } catch {
    // 循环引用等无法序列化的结果：不量长度，不影响工具本身。
  }
  return out
}

/**
 * 稳定错误码。绝不把异常 message 当错误码 —— message 里可能带路径、命令和凭据，
 * 而且它不可聚合。
 */
function stableToolErrorCode(err: unknown): string {
  if (err instanceof BrokerChannelError) return err.code
  const raw = (err as { code?: unknown } | null)?.code
  if (typeof raw === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(raw)) return raw
  return 'TOOL_EXECUTION_FAILED'
}

/**
 * 从委派工具参数里读出请求的子 Agent 角色。
 *
 * 只认一个明确的 `role` 字段，并且值必须是契约里的角色名；Broker 还会按 provider 的允许
 * 集合再校验一次。读不到就返回 undefined，由平台给出该 provider 最保守的默认角色。
 */
function requestedRoleFrom(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined
  const raw = (args as { role?: unknown }).role
  if (typeof raw !== 'string') return undefined
  const allowed = [
    'research-child',
    'implementation-child',
    'critic-child',
    'workflow-child',
  ]
  return allowed.includes(raw) ? raw : undefined
}
