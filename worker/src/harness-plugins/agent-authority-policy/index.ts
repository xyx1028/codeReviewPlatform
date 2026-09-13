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
})

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

      // 平台工具的最终判定在 Broker（它持有令牌表）。这里仍然先拦一次：能在进入模型
      // 上下文之前拒绝的，就不要浪费一次往返和一次 tool result。
      if (!identity.tools.includes(toolName)) {
        reportDenial({
          agentCapability: identity.agentCapability,
          agentId: identity.agentId,
          sessionId: identity.sessionId,
          toolName,
          reasonCode: toolName === 'submit_review_result' ? 'SUBMIT_ROOT_ONLY' : 'AGENT_ROLE_DENIED',
        })
        return {
          decision: 'deny',
          reason: denialMessage(toolName, identity.role),
        } as never
      }

      if (DELEGATION_TOOLS[toolName]) {
        // 委派开始：下一个出现的新 Agent 归这个父节点。串行 mutation 保证这里不会歧义。
        registry.beginDelegation(
          identity.agentId,
          toolName,
          requestedRoleFrom(exec.arguments),
        )
      }

      return next()
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
