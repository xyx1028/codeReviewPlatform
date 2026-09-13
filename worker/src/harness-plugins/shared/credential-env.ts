/**
 * 平台插件读取 Broker 凭据的唯一入口。
 *
 * 为什么不走 attempt patch 文件：
 *
 * patch 文件写在 `DSH_HOME`（`AGENT_ATTEMPTS_ROOT/attempt-*`）下，权限 0600、属主是运行
 * Worker 的同一个用户。而 Sandbox Shell 也以这个用户运行，且 `workspace-write` 沙箱
 * **只限制写、不限制读** —— `@deepseek-ai/dsh-sandbox-local` 的三档 profile 分别是
 * bwrap `--ro-bind / /`、Landlock `readOnly: ["/"]`、Seatbelt `(allow default)`
 * + `(deny file-write*)`。加上 `buildChildEnv` 把 `HOME` 设成 dshHome，一个拿到 Shell 的
 * 子 Agent 只要 `cat "$HOME"/attempt-route.patch.yml` 就能读到根 Agent 的 capability
 * token，再经 Broker socket 冒充根 Agent 提交 —— 直接击穿"根 Agent 唯一提交"这条边界。
 *
 * 为什么环境变量反而安全：
 *
 * Harness 自己的子进程层在 spawn 模型可见的 Shell 之前会重建环境
 * （`@deepseek-ai/dsh-subprocess` 的 `scrubbedParentEnv()`），按**变量名**丢掉所有匹配
 * `/KEY|PASSWORD|SECRET|TOKEN/i` 以及所有 `DSH_*` 的条目。所以只要凭据的变量名命中这个
 * 规则，它就存在于 DSH 进程内（插件可读）而不存在于 Shell 子进程内（模型不可读）。
 *
 * 下面两个名字都含 `TOKEN`，这不是命名偏好而是安全前提：改名必须同时保证仍然命中
 * 上述规则，`v4-broker-credentials.test.ts` 会对此断言。
 */

/** 每 attempt 的 Broker bearer token 所在的环境变量名。 */
export const BROKER_TOKEN_ENV = 'REVIEW_BROKER_ACCESS_TOKEN'

/** 根 Agent capability token 所在的环境变量名。 */
export const ROOT_CAPABILITY_ENV = 'REVIEW_ROOT_CAPABILITY_TOKEN'

/**
 * 读取一个必需的凭据。
 *
 * 缺失时抛错而不是回退到空字符串：空 token 会让 Broker 以 401 拒绝每一次调用，表现成
 * "模型一直调不动工具"，排查成本远高于启动即失败。
 */
export function readCredentialFromEnv(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const value = env[name]
  if (value === undefined || value === '') {
    throw new Error(
      `${name} is not set in the Harness process environment; ` +
        'the worker must inject the broker credentials when it spawns the Harness',
    )
  }
  return value
}
