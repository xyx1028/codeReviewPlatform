/**
 * 模型网络类型的**唯一**判定处。
 *
 * 存在的理由是一次真实缺陷：阶段一把"走不走代理"分别写在连接测试链路和（本该有的）正式
 * 评审链路上，结果两条路行为分叉 —— 测试无条件走代理（公网模型被代理的域名白名单拒成
 * HTTP 403），而正式评审压根没接代理（内网模型测得通、真跑必失败）。
 *
 * 所以这里只暴露一个函数，两条链路都必须用它。判定只有三种结果，没有第四种：
 *
 *   DIRECT                → 直连
 *   HOST_PROXY + 有代理   → 走代理
 *   HOST_PROXY + 无代理   → 拒绝执行（绝不静默直连）
 *
 * 最后一条是硬要求。静默直连的后果是：内网模型的请求被发到公网 DNS，可能命中一个同名的
 * 外部主机，而 API Key 就跟着发出去了。宁可让任务明确失败。
 */

/** 数据库 `ai_model_config.network_access_mode` 的取值。 */
export type ModelNetworkAccessMode = 'DIRECT' | 'HOST_PROXY'

/** 本机代理设置。三项齐全才算配置过。 */
export interface HostProxySettings {
  url: string
  username: string | null
  password: string | null
}

export const MODEL_PROXY_NOT_CONFIGURED = 'MODEL_PROXY_NOT_CONFIGURED'

export class ModelNetworkRouteError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'ModelNetworkRouteError'
    this.code = code
  }
}

/**
 * 归一化未知取值。
 *
 * 数据库有 check 约束，但快照是 jsonb，而在途的旧 Job 快照里根本没有这个字段。缺失一律
 * 视为 `DIRECT` —— 那是本次改造之前的行为，也是唯一不会让旧任务突然改变网络路径的取值。
 * 出现**无法识别**的值时不猜：抛错，因为那意味着写入侧有 bug，而"猜一个"会把 bug 变成
 * 一次静默的网络路径变更。
 */
export function parseModelNetworkAccessMode(raw: unknown): ModelNetworkAccessMode {
  if (raw === undefined || raw === null || raw === '') return 'DIRECT'
  if (raw === 'DIRECT' || raw === 'HOST_PROXY') return raw
  throw new ModelNetworkRouteError(
    'MODEL_NETWORK_ACCESS_MODE_INVALID',
    'model snapshot carries an unrecognized network access mode',
  )
}

export interface ResolvedModelNetworkRoute {
  mode: ModelNetworkAccessMode
  /** 直连时为 null；走代理时是要用的代理设置。 */
  proxy: HostProxySettings | null
}

/**
 * 解析这次请求该怎么走。
 *
 * `configuredProxy` 是 Worker 侧的运维配置（`MODEL_CONNECTIVITY_PROXY_*`）。它与模型的
 * 网络类型是两件独立的事实：前者说"这台 Worker 有没有通往内网的路"，后者说"这个模型在
 * 哪张网上"。只有两者都成立才走代理。
 */
export function resolveModelNetworkRoute(input: {
  mode: unknown
  configuredProxy: HostProxySettings | null
}): ResolvedModelNetworkRoute {
  const mode = parseModelNetworkAccessMode(input.mode)
  if (mode === 'DIRECT') {
    // 公网模型永远不进代理。阶段一正是在这里无条件传了代理，才让 DashScope 撞上
    // 代理的域名白名单并返回 403。
    return { mode, proxy: null }
  }
  if (input.configuredProxy === null) {
    throw new ModelNetworkRouteError(
      MODEL_PROXY_NOT_CONFIGURED,
      '当前 Worker 未配置内网代理，无法访问内网模型；请在 Worker 上配置 ' +
        'MODEL_CONNECTIVITY_PROXY_URL/USERNAME/PASSWORD，或把该模型改为公网模型',
    )
  }
  return { mode, proxy: input.configuredProxy }
}

/**
 * dsh 子进程的代理环境。
 *
 * `llm-pi-ai` 没有 per-provider 代理配置，底层 `@earendil-works/pi-ai` 也没有自定义 fetch
 * 钩子，所以正式评审链路只能走 Node 的环境代理。实测三组对照确认了必要条件：
 *
 *   不设变量                        → ENOTFOUND（直连 DNS）
 *   只设 HTTPS_PROXY                → 仍 ENOTFOUND（Node 24 必须显式 opt-in）
 *   HTTPS_PROXY + NODE_USE_ENV_PROXY → ECONNREFUSED（确实去连代理了）
 *
 * **已知代价**：`@deepseek-ai/dsh-subprocess` 的 `scrubbedParentEnv()` 只按
 * `/KEY|PASSWORD|SECRET|TOKEN/i` 与 `DSH_*` 过滤变量名，所以这些变量会被 Agent 的 `bash`
 * 继承（用真实 dsh 进程实测过）。也就是说选了内网模型的 attempt，Agent 的 Shell 命令也能
 * 经这条代理访问公司内网。这一点写在方案 §6 与 OPERATIONS 里，不留给现场发现。
 *
 * 凭据放在 URL 的 userinfo 里，是因为 Node 的环境代理只认 URL 形式的凭据。返回值只在
 * spawn 时进入子进程环境，不落盘、不进日志（变量名不含 KEY/TOKEN，所以**不会**被
 * Harness 剥离 —— 这正是上面那条代价的来源）。
 */
export function hostProxyChildEnv(proxy: HostProxySettings): Record<string, string> {
  const target = new URL(proxy.url)
  if (proxy.username !== null && proxy.password !== null) {
    target.username = encodeURIComponent(proxy.username)
    target.password = encodeURIComponent(proxy.password)
  }
  const value = target.toString()
  return {
    // Node 24 的环境代理必须显式打开，否则 HTTP(S)_PROXY 被忽略。
    NODE_USE_ENV_PROXY: '1',
    HTTP_PROXY: value,
    HTTPS_PROXY: value,
    // Broker 走 Unix socket，不受影响；这一行是给"万一有人改成 TCP"留的显式保护。
    NO_PROXY: 'localhost,127.0.0.1,::1',
  }
}
