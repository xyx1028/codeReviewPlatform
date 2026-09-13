/**
 * 真实模型 E2E：把方案第 11 节里"依赖模型自主决策"的那几项跑出来。
 *
 * 与 `v4-all-capabilities-e2e.test.ts` 的区别只有一处，但决定性：**模型不是脚本，是真的**。
 *
 * 脚本模型能证明"平台侧的管道是通的"，证明不了"模型真的会去派子 Agent、真的会触发压缩"。
 * 方案第 11 节的 5–7（Workflow / spawn / fork）、14（工具结果裁剪）、15（自动压缩）、
 * 17（子 Agent 贡献证据）、18（子 Agent 提交被拒）全部落在这一类：它们不是平台能"驱动"出来
 * 的，只能由模型自己决定，平台只能观测和治理。
 *
 * 本测试的断言策略因此分成两层，这个区分很重要：
 *
 *   * **硬断言**：无论模型做什么都必须成立的安全不变量 —— 最多提交一次、非根 Agent 不可能
 *     提交成功、入库 Evidence 必须绑定固定 Commit 与真实 blob、结束后不留进程和目录。
 *     这些失败就是缺陷。
 *   * **观测报告**：模型这一次究竟用了哪些能力（有没有派子 Agent、有没有触发压缩）。
 *     这些**不能**做成硬断言 —— 模型有权判断"这个任务不需要子 Agent"，那不是缺陷。
 *     所以它们以报告形式输出，由人判断第 11 节的覆盖情况。
 *
 * 不需要的东西：不连数据库（commitReview 与 db 钩子都是内存替身），不连 GitLab（仓库是本地
 * 现造的真实 git 仓库），不碰任何生产配置。唯一的外部依赖是模型端点。
 *
 * 默认跳过，需要三个环境变量：
 *   RUN_REAL_MODEL_E2E=1 REVIEW_MODEL_API_KEY=... E2E_MODEL_BASE_URL=... E2E_MODEL_NAME=... \
 *     npx vitest run worker/src/__tests__/v4-real-model-e2e.test.ts
 */

import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DeepSeekHarnessAcpEngine } from '../ai/runtime/deepseek-harness-acp-engine.js'
import { SnapshotStore } from '../ai/snapshot/snapshot-store.js'
import { V4_DEFAULT_POLICY } from '../ai/policy/v4-capability-policy.js'
import { checkoutPinnedCommit } from '../git/prepare.js'
import { runCommand } from '../git/run.js'
import { Logger } from '../logger.js'
import type { CommitReviewInput } from '../ai/control/attempt-control-broker.js'
import type { V4CapabilityPolicy } from '../ai/policy/v4-capability-policy.js'
import type { RepositoryName } from '../git/repositories.js'

const ENABLED =
  process.env.RUN_REAL_MODEL_E2E === '1' &&
  (process.env.REVIEW_MODEL_API_KEY ?? '') !== '' &&
  (process.env.E2E_MODEL_BASE_URL ?? '') !== '' &&
  (process.env.E2E_MODEL_NAME ?? '') !== ''

/**
 * 这一次试跑的预算。
 *
 * 刻意比 §4 默认的 160 小：真实模型跑多 Agent 编排时请求数是发散的，先用一个能跑完一轮
 * 完整评审、又不会失控的额度。跑完会报实际用量，再决定要不要放开。
 */
const TRIAL_MAX_REQUESTS = Number(process.env.E2E_MAX_MODEL_REQUESTS ?? 60)

/** 收窄预算后的 policy。其余能力保持默认全开 —— 这正是要验证的对象。 */
function trialPolicy(maxRequests: number = TRIAL_MAX_REQUESTS): V4CapabilityPolicy {
  const copy = JSON.parse(JSON.stringify(V4_DEFAULT_POLICY)) as V4CapabilityPolicy
  return {
    ...copy,
    modelBudget: {
      ...copy.modelBudget,
      maxTotalRequests: maxRequests,
      maxRootRequests: Math.ceil(maxRequests * 0.6),
      maxChildRequests: Math.ceil(maxRequests * 0.35),
    },
  }
}

/**
 * 造两个真实的 git 仓库，各一个 commit。
 *
 * 用两个而不是一个：跨仓库是这个平台的真实形态，也是模型可能选择派子 Agent 的最自然的
 * 理由。但**不强迫**它这么做 —— 用不用子 Agent 是模型的判断。
 *
 * 故意留一个"缺口"：tmanage 侧只有查询没有取消，于是这个需求的正确结论是"部分实现"。
 * 这样模型必须真的去读两个仓库才能得出结论，而不是看一眼就交差。
 */
async function buildRepo(
  name: RepositoryName,
  files: Record<string, string>,
): Promise<{ name: RepositoryName; gitDir: string; commitSha: string }> {
  const gitDir = mkdtempSync(join(tmpdir(), `rm-e2e-${name}-`))
  await runCommand('git', ['init', '--quiet', '--initial-branch=main'], { cwd: gitDir })
  await runCommand('git', ['config', 'user.email', 'e2e@example.invalid'], { cwd: gitDir })
  await runCommand('git', ['config', 'user.name', 'Real Model E2E'], { cwd: gitDir })
  for (const [path, content] of Object.entries(files)) {
    const full = join(gitDir, path)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, content)
  }
  await runCommand('git', ['add', '--all'], { cwd: gitDir })
  await runCommand('git', ['commit', '--quiet', '-m', `feat: seed ${name}`], { cwd: gitDir })
  const head = await runCommand('git', ['rev-parse', 'HEAD'], { cwd: gitDir })
  return { name, gitDir, commitSha: head.stdout.trim() }
}

/**
 * 生成一个"值得并行调查"规模的仓库。
 *
 * 为什么规模是这个测试的关键变量：第一次试跑只放了 4 个文件，模型用 7 次请求直接读完就
 * 提交了，一个子 Agent 都没派 —— 而这是**正确行为**，因为平台 Prompt 明确要求"不要无节制
 * 地创建子 Agent，每个子 Agent 都在花同一份预算"。委派只有在任务真的宽到读不完时才理性。
 *
 * 所以要验证 5–7（Workflow/spawn/fork）、14（结果裁剪）、15（自动压缩），场景必须真的宽：
 * 多个模块、多个仓库、验收标准覆盖互不相邻的领域，且单文件足够长以产生大工具结果。
 */
function generateModule(pkg: string, klass: string, lines: number): string {
  const body: string[] = [`package ${pkg};`, '', `/** ${klass}。由 E2E 夹具生成，用于构造真实规模的检索面。 */`, `public class ${klass} {`]
  for (let i = 0; i < lines; i++) {
    body.push(`  /** 业务规则 ${i + 1}。 */`)
    body.push(`  public String rule${i + 1}(String input) {`)
    body.push(`    if (input == null || input.isEmpty()) {`)
    body.push(`      throw new IllegalArgumentException("input required for rule${i + 1}");`)
    body.push(`    }`)
    body.push(`    return "${klass}.rule${i + 1}:" + input;`)
    body.push('  }')
    body.push('')
  }
  body.push('}', '')
  return body.join('\n')
}

/** kdmanage-backend：下单域。取消订单**已实现**。 */
function kdFiles(): Record<string, string> {
  const files: Record<string, string> = {}
  const modules: Array<[string, number]> = [
    ['inventory', 12],
    ['payment', 14],
    ['coupon', 10],
    ['shipping', 11],
    ['audit', 9],
    ['notify', 8],
  ]
  for (const [mod, n] of modules) {
    files[`src/main/java/${mod}/${cap(mod)}Service.java`] = generateModule(mod, `${cap(mod)}Service`, n)
    files[`src/main/java/${mod}/${cap(mod)}Repository.java`] = generateModule(mod, `${cap(mod)}Repository`, Math.max(4, n - 5))
    files[`src/main/java/${mod}/${cap(mod)}Validator.java`] = generateModule(mod, `${cap(mod)}Validator`, 6)
  }
  // 与验收标准直接相关的三个文件，写成可读的真实实现。
  files['src/main/java/order/OrderController.java'] = [
    'package order;',
    '',
    '/** 下单入口。PRJ-2001 的主实现。 */',
    'public class OrderController {',
    '  private final OrderService service;',
    '',
    '  public OrderController(OrderService service) {',
    '    this.service = service;',
    '  }',
    '',
    '  /** 验收标准 1：创建订单，数量非法时拒绝。 */',
    '  public String createOrder(String skuId, int quantity) {',
    '    if (quantity <= 0) {',
    '      throw new IllegalArgumentException("quantity must be positive");',
    '    }',
    '    return service.place(skuId, quantity);',
    '  }',
    '',
    '  /** 验收标准 2：取消订单，只允许取消未发货的单。 */',
    '  public void cancelOrder(String orderId) {',
    '    service.cancel(orderId);',
    '  }',
    '}',
    '',
  ].join('\n')
  files['src/main/java/order/OrderService.java'] = [
    'package order;',
    '',
    'import inventory.InventoryService;',
    'import coupon.CouponService;',
    '',
    'public class OrderService {',
    '  private final InventoryService inventory = new InventoryService();',
    '  private final CouponService coupon = new CouponService();',
    '',
    '  /** 验收标准 3：下单时扣减库存。 */',
    '  public String place(String skuId, int quantity) {',
    '    inventory.rule1(skuId);',
    '    return "ORD-" + skuId + "-" + quantity;',
    '  }',
    '',
    '  /** 验收标准 4：下单时核销优惠券。 */',
    '  public String placeWithCoupon(String skuId, int quantity, String couponId) {',
    '    coupon.rule1(couponId);',
    '    return place(skuId, quantity);',
    '  }',
    '',
    '  public void cancel(String orderId) {',
    '    // 标记为已取消并释放库存',
    '    inventory.rule2(orderId);',
    '  }',
    '}',
    '',
  ].join('\n')
  files['src/main/java/payment/PaymentCallback.java'] = [
    'package payment;',
    '',
    '/** 验收标准 5：支付回调幂等处理。 */',
    'public class PaymentCallback {',
    '  public boolean handle(String orderId, String txnId) {',
    '    if (txnId == null) {',
    '      return false;',
    '    }',
    '    return true;',
    '  }',
    '}',
    '',
  ].join('\n')
  return files
}

/** tmanage-backend：查询域。**故意缺**取消状态同步 —— 正确结论应为"部分实现"。 */
function tmFiles(): Record<string, string> {
  const files: Record<string, string> = {}
  const modules: Array<[string, number]> = [
    ['report', 13],
    ['dashboard', 11],
    ['export', 9],
    ['schedule', 10],
    ['permission', 8],
  ]
  for (const [mod, n] of modules) {
    files[`src/main/java/${mod}/${cap(mod)}Service.java`] = generateModule(mod, `${cap(mod)}Service`, n)
    files[`src/main/java/${mod}/${cap(mod)}Repository.java`] = generateModule(mod, `${cap(mod)}Repository`, Math.max(4, n - 4))
  }
  files['src/main/java/query/OrderQueryApi.java'] = [
    'package query;',
    '',
    '/** 验收标准 6 只做了一半：能查询订单，但没有订单取消后的状态同步。 */',
    'public class OrderQueryApi {',
    '  public String findOrder(String orderId) {',
    '    return "order:" + orderId;',
    '  }',
    '',
    '  public String listOrders(String userId) {',
    '    return "orders:" + userId;',
    '  }',
    '}',
    '',
  ].join('\n')
  return files
}

function cap(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

interface AttemptOutcome {
  ok: boolean
  errorCode?: string
  errorMessage?: string
  commits: CommitReviewInput[]
  events: Array<Record<string, unknown>>
  usage: { inputTokens: number | null; outputTokens: number | null } | null
  pinnedShas: string[]
  attemptsRootEmpty: boolean
}

/**
 * 跑一次完整 attempt 并把观测面收集齐。
 *
 * 抽成函数是因为要跑两个场景：默认场景（模型自己判断，实测不会委派）和强制委派场景
 * （需求文本明确要求按模块派子 Agent）。后者是唯一能把子 Agent 治理路径真正走一遍的办法 ——
 * 那些路径此前只有 mock 覆盖，而本轮已经证明"只有 mock 覆盖"的代码会藏真缺陷。
 */
async function runAttempt(input: {
  label: string
  story: {
    code: string
    name: string
    description: string
    acceptanceCriteria: string
  }
  maxRequests: number
}): Promise<AttemptOutcome> {
  const kd = await buildRepo('kdmanage-backend', kdFiles())
  const tm = await buildRepo('tmanage-backend', tmFiles())
  const attemptsRoot = mkdtempSync(join(tmpdir(), 'rm-e2e-att-'))
  const sessionRoot = mkdtempSync(join(tmpdir(), 'rm-e2e-sess-'))
  const cleanup = [kd.gitDir, tm.gitDir, attemptsRoot, sessionRoot]

  // sink 收到的是**已序列化的 JSON 字符串**（见 logger.ts 的 `sink: (line: string)`），
  // 不是对象。直接当对象存会让每一次字段查找都得到 undefined，观测报告全是 0 —— 而 attempt
  // 其实跑得好好的。这个坑本轮踩过一次。
  const events: Array<Record<string, unknown>> = []
  const logger = new Logger({
    sink: (line) => {
      try {
        events.push(JSON.parse(line) as Record<string, unknown>)
      } catch {
        events.push({ event: '[unparsable log line]', raw: line.slice(0, 200) })
      }
    },
    minLevel: 'info',
  })

  const commits: CommitReviewInput[] = []
  const engine = new DeepSeekHarnessAcpEngine({
    taskId: `real-model-${input.label}`,
    agentAttempt: 1,
    branch: 'feature_dev',
    story: input.story,
    snapshots: new SnapshotStore([
      { name: kd.name, commitSha: kd.commitSha, gitDir: kd.gitDir },
      { name: tm.name, commitSha: tm.commitSha, gitDir: tm.gitDir },
    ]),
    route: {
      providerId: 'review-route',
      displayName: 'Real Model Route',
      baseUrl: process.env.E2E_MODEL_BASE_URL!,
      modelName: process.env.E2E_MODEL_NAME!,
      contextWindow: Number(process.env.E2E_MODEL_CONTEXT_WINDOW ?? 131072),
      maxTokens: Number(process.env.E2E_MODEL_MAX_TOKENS ?? 8192),
      apiKeyEnvVar: 'REVIEW_MODEL_API_KEY',
      requestTimeoutMs: 180000,
    },
    policy: trialPolicy(input.maxRequests),
    coveragePolicy: {
      requiredRepositories: [kd.name, tm.name],
      minQueriesPerRepository: 1,
    },
    apiKey: process.env.REVIEW_MODEL_API_KEY!,
    attemptsRoot,
    sessionRoot,
    workerId: 'w-real-model-e2e',
    infrastructure: {},
    forbiddenRoots: [],
    logger,
    isLeaseValid: () => true,
    checkoutPinned: checkoutPinnedCommit,
    commitReview: async (commitInput) => {
      commits.push(commitInput)
      return { runId: `run-${input.label}`, committedAt: new Date().toISOString() }
    },
  })

  try {
    const result = await engine.runReview({
      signal: new AbortController().signal,
      logger,
    })
    return {
      ok: result.ok,
      errorCode: result.errorCode,
      errorMessage: result.errorMessage,
      commits,
      events,
      usage: result.usage
        ? { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens }
        : null,
      pinnedShas: [kd.commitSha, tm.commitSha],
      attemptsRootEmpty: readdirSync(attemptsRoot).length === 0,
    }
  } finally {
    for (const dir of cleanup) rmSync(dir, { recursive: true, force: true })
  }
}

/** 打观测报告，并返回后续断言要用的解析结果。 */
function report(label: string, outcome: AttemptOutcome) {
  const ev = outcome.events
  const started = ev.find((e) => e.event === 'agent_attempt_started')
  const finished = ev.find((e) => e.event === 'agent_attempt_finished')
  const failed = ev.find((e) => e.event === 'agent_attempt_failed')
  const drained = ev.find((e) => e.event === 'attempt_drained')

  // 两个不同的观测面：
  //   * tool_calls_by_name 是 Broker 汇总的**完整模型工具计数**：platform 工具来自执行路由，
  //     Harness-origin 工具来自 tool lifecycle；内部控制路由不计入。
  //   * tool_names 来自 ACP 通告，是本次运行实际出现过的工具名集合，不含次数。
  const meteredTools = Object.keys(
    (finished?.tool_calls_by_name ?? failed?.tool_calls_by_name ?? {}) as Record<string, number>,
  ).sort()
  const modelTools = ((finished?.tool_names ?? []) as string[]).slice().sort()
  const DELEGATION = ['subagent', 'subagent_fork', 'workflow', 'ralph']
  const delegationTools = modelTools.filter((n) => DELEGATION.includes(n))
  const agentCount = Number(finished?.agent_count ?? failed?.agent_count ?? 1)
  const rejected = (finished?.rejected_submissions ??
    failed?.rejected_submissions ??
    []) as string[]

  // "真的派出了子 Agent"的硬证据是 agent_count（来自 authority ledger）与 child_model_requests
  // （来自分层预算账本），不是某个自造的事件名 —— 平台并没有 agent_child_registered 这个事件，
  // 早先按它统计只会永远得到 0，把"委派成功"误报成"没委派"。
  const roleDenials = ev.filter(
    (e) => e.event === 'acp_permission_denied' || e.error_code === 'AGENT_ROLE_DENIED',
  )

  // eslint-disable-next-line no-console
  console.log(
    [
      '',
      `============ 真实模型 E2E [${label}] ============`,
      `模型:            ${process.env.E2E_MODEL_NAME}`,
      `结果:            ${outcome.ok ? 'committed' : `失败 ${outcome.errorCode}`}`,
      `模型请求:        ${String(finished?.model_requests ?? failed?.model_requests ?? 0)}` +
        ` (root ${String(finished?.root_model_requests ?? 0)}, child ${String(finished?.child_model_requests ?? 0)})`,
      `真实 token:      输入 ${String(outcome.usage?.inputTokens ?? 'null')} / 输出 ${String(outcome.usage?.outputTokens ?? 'null')}`,
      `Agent 总数:      ${String(agentCount)}`,
      `最大委派深度:    ${String(finished?.max_depth_reached ?? 0)}`,
      `根工具面:        ${String(started?.root_tools ?? '?')} 个`,
      `模型调用的工具:  ${modelTools.length > 0 ? modelTools.join(', ') : '(ACP 未通告)'}`,
      `委派类工具:      ${delegationTools.length > 0 ? delegationTools.join(', ') : '(未使用)'}`,
      `计量工具:        ${meteredTools.length > 0 ? meteredTools.join(', ') : '(无)'}`,
      `Evidence:        ${String(finished?.evidence_shown ?? failed?.broker_evidence_shown ?? 0)}`,
      `被拒的提交:      ${JSON.stringify(rejected)}`,
      `权限拒绝事件:    ${String(roleDenials.length)} 次`,
      `收敛:            reason=${String(drained?.reason)} 存活进程=${String(drained?.surviving_pids)} 清理失败=${String(drained?.cleanup_failed)}`,
      '==============================================',
      '',
    ].join('\n'),
  )
  if (!outcome.ok) {
    // eslint-disable-next-line no-console
    console.log('失败详情:', outcome.errorCode, outcome.errorMessage)
  }
  return { finished, failed, drained, modelTools, delegationTools, agentCount, rejected }
}

/** 与模型行为无关、必须永远成立的安全不变量。 */
function assertSafetyInvariants(outcome: AttemptOutcome, parsed: ReturnType<typeof report>) {
  // 1. 绝不可能提交两次。模型可以反复尝试，平台只接受一次。
  expect(outcome.commits.length).toBeLessThanOrEqual(1)

  // 2. 提交主体必须是平台生成的根身份，不是模型自报的任何东西。
  if (outcome.commits.length === 1) {
    const committed = outcome.commits[0]!
    expect(committed.identity.rootAgentId).toMatch(/^root-/)
    expect(committed.identity.treeDigest).toMatch(/^[0-9a-f]{64}$/)

    // 3. 入库 Evidence 必须绑定固定 Commit 与真实 blob —— 平台重新读出来的，
    //    不是模型断言的。这是"证据可验证"的全部含义。
    for (const item of committed.evidence) {
      expect(outcome.pinnedShas).toContain(item.commitSha)
      expect(item.blobSha).toMatch(/^[0-9a-f]{40}$/)
    }
  }

  // 4. 收敛必须干净。
  expect(parsed.drained?.cleanup_failed).toBe(false)
  expect(parsed.drained?.surviving_pids).toBe(0)

  // 5. attempt 目录必须删干净。
  expect(outcome.attemptsRootEmpty).toBe(true)

  // 6. 不管有多少子 Agent，成功提交的只能是根 Agent —— 子 Agent 的提交尝试必须落在
  //    rejected_submissions 里，而不是变成第二次 commit。
  const childSubmitAttempts = parsed.rejected.filter((code) => code === 'SUBMIT_ROOT_ONLY')
  if (childSubmitAttempts.length > 0) {
    expect(outcome.commits.length).toBeLessThanOrEqual(1)
  }
}

describe.skipIf(!ENABLED)('V4 real-model E2E (real dsh process, real model)', () => {
  it(
    '场景一：模型自主判断 —— 安全不变量必须成立',
    async () => {
      const outcome = await runAttempt({
        label: 'autonomous',
        maxRequests: Number(process.env.E2E_MAX_MODEL_REQUESTS ?? 60),
        story: {
          code: 'PRJ-2001',
          name: '订单创建、取消与查询同步',
          description: [
            '下单域需要支持创建订单、取消订单、库存扣减、优惠券核销与支付回调幂等；',
            '查询域需要能查询订单，并且在订单被取消后同步取消状态。',
            '两个仓库都还有大量与本需求无关的模块，请只针对验收标准取证。',
          ].join('\n'),
          acceptanceCriteria: [
            '1. kdmanage-backend 提供创建订单接口，数量非法时拒绝；',
            '2. kdmanage-backend 提供取消订单接口，且只允许取消未发货的单；',
            '3. kdmanage-backend 下单时扣减库存；',
            '4. kdmanage-backend 下单时支持核销优惠券；',
            '5. kdmanage-backend 支付回调具备幂等处理；',
            '6. tmanage-backend 提供订单查询接口，并在订单取消后同步取消状态。',
          ].join('\n'),
        },
      })
      const parsed = report('自主判断', outcome)
      assertSafetyInvariants(outcome, parsed)

      // 硬断言：真的调用过模型和工具，否则这次跑的不是"真实模型 E2E"。
      const requests = Number(parsed.finished?.model_requests ?? parsed.failed?.model_requests ?? 0)
      expect(requests).toBeGreaterThan(0)
      expect(parsed.modelTools.length).toBeGreaterThan(0)
    },
    900_000,
  )

  it(
    '场景二：需求明确要求按模块并行核查 —— 子 Agent 治理路径必须成立',
    async () => {
      // 为什么要造这个场景：默认场景下模型（qwen3.6-flash 与 deepseek-v4-pro 都试过）
      // 一次都不派子 Agent，而那是**正确判断** —— 平台 Prompt 明确要求"不要无节制地创建
      // 子 Agent，每个都在花同一份预算"，任务一个上下文读得完就不该委派。
      //
      // 但这意味着子 Agent 的注册、工具收窄、分层预算、root-only 提交这几条路径在真实模型
      // 下从未被走过，只有 mock 覆盖。所以这里用**需求文本**（属于合法的平台输入）明确要求
      // 并行核查，把这些路径逼出来。
      const outcome = await runAttempt({
        label: 'delegated',
        maxRequests: Number(process.env.E2E_DELEGATED_MAX_REQUESTS ?? 120),
        story: {
          code: 'PRJ-2002',
          name: '订单域六模块一致性专项核查',
          description: [
            '本需求涉及六个相互独立的模块：库存、支付、优惠券、发货、审计、查询。',
            '每个模块的实现分散在不同包中，单个上下文难以同时容纳全部细节。',
            '',
            '调查要求：请使用 subagent 为每个模块分别派出一个研究型子 Agent 并行核查，',
            '由各子 Agent 分别检索并读取自己负责模块的代码、返回结论与 evidenceId，',
            '最后由你汇总全部子 Agent 的结论后提交一次最终结果。',
          ].join('\n'),
          acceptanceCriteria: [
            '1. 库存模块 inventory 具备完整业务规则；',
            '2. 支付模块 payment 具备完整业务规则与回调幂等；',
            '3. 优惠券模块 coupon 具备完整业务规则；',
            '4. 发货模块 shipping 具备完整业务规则；',
            '5. 审计模块 audit 具备完整业务规则；',
            '6. tmanage-backend 查询模块支持订单取消后的状态同步。',
          ].join('\n'),
        },
      })
      const parsed = report('强制委派', outcome)

      // 安全不变量在有子 Agent 的情况下同样必须成立 —— 这才是这个场景的重点。
      assertSafetyInvariants(outcome, parsed)

      // 观测性断言：委派**是否发生**不做硬要求（模型仍有判断权），但如果发生了，
      // 治理结果必须自洽 —— Agent 数与深度要对得上，且提交仍然只有一次。
      if (parsed.agentCount > 1) {
        expect(Number(parsed.finished?.max_depth_reached ?? 0)).toBeGreaterThan(0)
        expect(Number(parsed.finished?.child_model_requests ?? 0)).toBeGreaterThan(0)
      }
    },
    1_200_000,
  )
})
