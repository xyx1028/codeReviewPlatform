/**
 * 分层模型预算。
 *
 * V3 只有一个 attempt 级 hard cap，而且真实计数在 Harness 子进程里、库里存的是 Broker 的
 * 工具调用数。V4 需要同时满足两件事：
 *
 *   1. root + 并行 children + retry + compaction + Ralph 永不突破总 hard cap；
 *   2. 库里的 usage 是真值，不是工具调用数冒充的。
 *
 * 做法：预留（reserve）发生在调用 provider **之前**，并且是原子的 —— 并行子 Agent 同时
 * 请求时，谁先拿到谁用，超出即拒绝。这一点必须在 Worker 侧完成：governor 在子进程里，
 * 而多个子 Agent 共享同一份总预算，只有跨进程的单点才能给出一致答案。
 *
 * 这个类是纯状态机，可以脱离 Harness 单测。
 */

import type { V4CapabilityPolicy } from '../policy/v4-capability-policy.js'
import { V4_ERROR_CODES } from '../policy/v4-errors.js'

/**
 * 模型请求的类型。
 *
 * `loop` 是普通 agent-loop 请求；`retry` 是 provider 重试；`compaction` 是自动压缩；
 * `session-title` 是会话标题；`ralph` 是 Ralph 轮次。分开计量的理由很实际：预算打满时，
 * "都花在检索"和"都花在反复压缩"是两种完全不同的故障，合并计数看不出来。
 */
export type ModelRequestKind = 'loop' | 'retry' | 'compaction' | 'session-title' | 'ralph' | 'other'

export interface BudgetVerdict {
  allowed: boolean
  code?: string
  reason?: string
  scope?: 'total' | 'root' | 'child' | 'retry' | 'compaction' | 'ralph'
  remaining?: number
}

export interface BudgetCounters {
  total: number
  root: number
  child: number
  retry: number
  compaction: number
  sessionTitle: number
  ralph: number
  other: number
  denied: number
  inputTokens: number | null
  outputTokens: number | null
  byAgent: Record<string, number>
}

export interface ReserveInput {
  agentId: string
  isRoot: boolean
  kind: ModelRequestKind
  count?: number
}

export interface HierarchicalBudgetLedgerOptions {
  policy: V4CapabilityPolicy
  /**
   * 同步落库钩子。预留成功后异步推进数据库计数，失败不回滚内存计数 —— 内存是本 attempt
   * 的权威值，数据库只是可观测副本。反过来（以数据库为权威）会让每次模型请求都等一次
   * 网络往返，把预算检查变成延迟来源。
   */
  onReserved?(input: ReserveInput & { count: number }): void
}

export class HierarchicalBudgetLedger {
  private readonly counters: BudgetCounters = {
    total: 0,
    root: 0,
    child: 0,
    retry: 0,
    compaction: 0,
    sessionTitle: 0,
    ralph: 0,
    other: 0,
    denied: 0,
    inputTokens: null,
    outputTokens: null,
    byAgent: {},
  }

  constructor(private readonly options: HierarchicalBudgetLedgerOptions) {}

  snapshot(): BudgetCounters {
    return { ...this.counters, byAgent: { ...this.counters.byAgent } }
  }

  /**
   * 预留 N 次模型请求，或者在调用 provider 之前拒绝。
   *
   * 检查顺序是先总量后分项：总量是硬边界（关系到成本），分项是治理边界。总量先撞上时
   * 报 `total`，运维一看就知道是"整体预算不够"而不是"某个子 Agent 太贪"。
   */
  reserve(input: ReserveInput): BudgetVerdict {
    const requestedCount = input.count ?? 1
    const budget = this.options.policy.modelBudget

    // 计数来自跨进程 Broker 请求，必须在进入任何算术前收紧为安全正整数。
    // 否则 NaN 会污染全部 counter，小数也会让“模型请求次数”失去离散计数语义。
    if (!Number.isSafeInteger(requestedCount) || requestedCount < 1) {
      this.counters.denied++
      return {
        allowed: false,
        code: V4_ERROR_CODES.MODEL_BUDGET_EXHAUSTED,
        scope: 'total',
        reason: 'model-request reservation count must be a positive safe integer',
        remaining: Math.max(budget.maxTotalRequests - this.counters.total, 0),
      }
    }
    const count = requestedCount

    if (this.counters.total + count > budget.maxTotalRequests) {
      this.counters.denied++
      return {
        allowed: false,
        code: V4_ERROR_CODES.MODEL_BUDGET_EXHAUSTED,
        scope: 'total',
        reason: `attempt model-request budget exhausted (limit ${budget.maxTotalRequests})`,
        remaining: Math.max(budget.maxTotalRequests - this.counters.total, 0),
      }
    }

    if (input.kind === 'retry') {
      if (this.counters.retry + count > budget.maxRetryRequests) {
        return this.deny('retry', budget.maxRetryRequests, this.counters.retry)
      }
    } else if (input.kind === 'compaction') {
      if (this.counters.compaction + count > budget.maxCompactionRequests) {
        return this.deny('compaction', budget.maxCompactionRequests, this.counters.compaction)
      }
    } else if (input.kind === 'ralph') {
      if (this.counters.ralph + count > budget.maxRalphRounds) {
        return this.deny('ralph', budget.maxRalphRounds, this.counters.ralph)
      }
    } else if (input.isRoot) {
      if (this.counters.root + count > budget.maxRootRequests) {
        return this.deny('root', budget.maxRootRequests, this.counters.root)
      }
    } else {
      // 子 Agent 预算按 **每个 Agent** 计，而不是所有 child 共享一份：共享会让第一个
      // 子 Agent 把兄弟的额度用光，破坏并行分析。
      const used = this.counters.byAgent[input.agentId] ?? 0
      if (used + count > budget.maxChildRequests) {
        return this.deny('child', budget.maxChildRequests, used)
      }
    }

    this.counters.total += count
    this.counters.byAgent[input.agentId] = (this.counters.byAgent[input.agentId] ?? 0) + count
    switch (input.kind) {
      case 'retry':
        this.counters.retry += count
        break
      case 'compaction':
        this.counters.compaction += count
        break
      case 'session-title':
        this.counters.sessionTitle += count
        break
      case 'ralph':
        this.counters.ralph += count
        if (input.isRoot) this.counters.root += count
        else this.counters.child += count
        break
      case 'loop':
        if (input.isRoot) this.counters.root += count
        else this.counters.child += count
        break
      default:
        this.counters.other += count
    }

    this.options.onReserved?.({ ...input, count })
    return { allowed: true, remaining: budget.maxTotalRequests - this.counters.total }
  }

  /**
   * 记录 provider 报出来的 token 用量。
   *
   * provider 没报就保持 null，不臆造。库里 `input_tokens is null` 表示"这个 provider 不报
   * token"，和"用了 0 个 token"是两件不同的事，UI 需要能区分。
   */
  observeTokens(input: {
    agentId: string
    inputTokens: number | null
    outputTokens: number | null
  }): void {
    if (typeof input.inputTokens === 'number' && Number.isFinite(input.inputTokens)) {
      this.counters.inputTokens = (this.counters.inputTokens ?? 0) + Math.max(input.inputTokens, 0)
    }
    if (typeof input.outputTokens === 'number' && Number.isFinite(input.outputTokens)) {
      this.counters.outputTokens =
        (this.counters.outputTokens ?? 0) + Math.max(input.outputTokens, 0)
    }
  }

  /** 剩余总额度。 */
  remainingTotal(): number {
    return Math.max(this.options.policy.modelBudget.maxTotalRequests - this.counters.total, 0)
  }

  private deny(
    scope: NonNullable<BudgetVerdict['scope']>,
    limit: number,
    used: number,
  ): BudgetVerdict {
    this.counters.denied++
    return {
      allowed: false,
      code: V4_ERROR_CODES.MODEL_BUDGET_EXHAUSTED,
      scope,
      reason: `attempt ${scope} request budget exhausted (limit ${limit})`,
      remaining: Math.max(limit - used, 0),
    }
  }
}
