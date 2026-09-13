/**
 * 一次 attempt 的收敛控制器。
 *
 * "任务结束必须收敛"这条边界需要一个明确的负责人：成功、失败、取消、Lease 丢失、
 * Worker 关机，五条路径最终都要走到同一个终点 —— 没有活着的 child、Job、进程、Socket，
 * 也没有还能写入的旧 capability。
 *
 * 这个控制器只做编排，不做策略：策略在 policy 模块，身份在 ledger，进程在 supervisor。
 * 它保证的是顺序，而顺序在这里是安全属性而不是风格问题：
 *
 *   1. 关闭 admission（不再接受新 Agent / 新 Job / 新工具调用）；
 *   2. child-first 撤销令牌并取消 Agent Tree；
 *   3. 取消 Workflow holder 与 Jobs；
 *   4. 终止进程树（用真实 process group，兜底 SIGKILL）；
 *   5. 关闭 Broker、删除 Socket、清理 Workspace；
 *   6. 数据库 fencing，让任何迟到的写入失败。
 *
 * 反过来做（先杀进程再撤令牌）会留下一个窗口：进程还没死透，令牌仍然有效，迟到的工具
 * 调用可以继续写入。
 */

import type { Logger } from '../../logger.js'
import { redactError } from '../../security/redaction.js'
import type { AgentAuthorityLedger, AgentIdentity } from './agent-authority-ledger.js'

export type AttemptEndReason =
  | 'COMMITTED'
  | 'USER_CANCELLED'
  | 'LEASE_LOST'
  | 'BUDGET_EXHAUSTED'
  | 'WORKER_SHUTDOWN'
  | 'ATTEMPT_FAILED'
  | 'SESSION_UNRECOVERABLE'

export interface DrainableJobs {
  /** 取消并等待某个 owner 的全部 Job；返回被取消的数量。 */
  cancelJobsOf(ownerSessionId: string): Promise<number>
}

export interface ProcessTreeReaper {
  /** 回收全部后代进程；返回仍然存活的 pid（应当为空）。 */
  reap(): Promise<number[]>
}

/**
 * 收敛依赖。
 *
 * 这些字段刻意是**必填且可为 null**，而不是可选：可选字段允许调用方"忘记传"，而忘记传
 * 的后果是 drain 静默跳过一整个收敛步骤。曾经就是这样 —— 引擎只传了 ledger/logger/
 * markNodeTerminal/reaper，Workflow 取消、Jobs drain 和 DB fencing 三步在生产路径上全程
 * 空转，而测试因为手工注入了这三项而全绿。必填 + 可为 null 让每个构造点都必须显式表态，
 * 测试也就必须与生产装配同形。
 */
export interface AttemptTreeControllerOptions {
  ledger: AgentAuthorityLedger
  logger: Logger
  /** 标记数据库中的节点终态；失败不阻塞收敛。 */
  markNodeTerminal:
    | ((
        agentId: string,
        status: 'FINISHED' | 'FAILED' | 'CANCELLED',
        errorCode?: string,
      ) => Promise<void>)
    | null
  /**
   * 取消 Harness 侧的 Workflow holder。
   *
   * 实现方式是让 ACP 客户端发 `session/cancel`：Workflow 步骤、子 Agent 和 Jobs 都由
   * Harness 在进程内持有，平台唯一的合作式取消入口就是取消当前 turn。
   */
  cancelWorkflows: (() => Promise<void>) | null
  /**
   * 按 owner session 逐个 drain Jobs。
   *
   * 目前为 null：`tool-jobs` 完全在 Harness 进程内，平台没有 Job 清单可枚举。Job 进程本身
   * 由 `reaper` 的进程组回收兜底，而合作式取消由 `cancelWorkflows` 的 `session/cancel`
   * 覆盖。要做到文档 §7.8.5 那种"按 exact owner session 精确取消"，需要 Broker 侧新增
   * Job 登记路由，属于独立工作项。
   */
  jobs: DrainableJobs | null
  reaper: ProcessTreeReaper | null
  /** 数据库 fencing：让迟到的工具、usage 和提交立即失效。 */
  fence: ((reason: AttemptEndReason) => Promise<void>) | null
}

export interface DrainOutcome {
  reason: AttemptEndReason
  cancelledAgents: number
  cancelledJobs: number
  survivingPids: number[]
  /** 进程树没回收干净时置位；对应 PROCESS_TREE_CLEANUP_FAILED。 */
  cleanupFailed: boolean
}

export class AttemptTreeController {
  private admissionOpen = true
  private draining: Promise<DrainOutcome> | null = null

  constructor(private readonly options: AttemptTreeControllerOptions) {}

  /** 新 Agent / 新 Job / 新工具调用是否还被接受。 */
  get admits(): boolean {
    return this.admissionOpen
  }

  /**
   * 关闭 admission，但不立刻杀掉正在跑的东西。
   *
   * 提交成功时用它：root 已经拿到 receipt，正在跑的 child 没必要被强杀，但它们再也不能
   * 影响结果。
   */
  closeAdmission(reason: AttemptEndReason): void {
    if (!this.admissionOpen) return
    this.admissionOpen = false
    this.options.logger.info('attempt_admission_closed', {
      event: 'attempt_admission_closed',
      reason,
    })
  }

  /**
   * 收敛。可以重复调用；后续调用等同一个结果。
   */
  drain(reason: AttemptEndReason): Promise<DrainOutcome> {
    if (this.draining) return this.draining
    this.draining = this.performDrain(reason)
    return this.draining
  }

  private async performDrain(reason: AttemptEndReason): Promise<DrainOutcome> {
    this.closeAdmission(reason)
    const log = this.options.logger

    // 1. child-first 撤销令牌。这一步之后，任何迟到的工具调用都拿不到授权。
    let cancelled: AgentIdentity[] = []
    if (reason === 'COMMITTED') {
      this.options.ledger.seal()
    } else {
      cancelled = this.options.ledger.cancelTree(reason)
    }

    // 2. 同步数据库节点终态。失败只记日志：收敛不能因为一次网络抖动停下来。
    for (const identity of cancelled) {
      await this.options.markNodeTerminal?.(identity.agentId, 'CANCELLED', reason).catch((err) =>
        log.error('agent_node_terminal_failed', {
          event: 'agent_node_terminal_failed',
          agent_id: identity.agentId,
          error_message: redactError(err),
        }),
      )
    }

    // 3. Workflow holder 与 Jobs。Jobs 按 owner session 逐个 drain，避免误杀别的 attempt。
    await this.options.cancelWorkflows?.().catch((err) =>
      log.error('workflow_cancel_failed', {
        event: 'workflow_cancel_failed',
        error_message: redactError(err),
      }),
    )

    let cancelledJobs = 0
    if (this.options.jobs) {
      for (const identity of this.options.ledger.all()) {
        cancelledJobs += await this.options.jobs
          .cancelJobsOf(identity.sessionId)
          .catch((err) => {
            log.error('jobs_cancel_failed', {
              event: 'jobs_cancel_failed',
              session_id: identity.sessionId,
              error_message: redactError(err),
            })
            return 0
          })
      }
    }

    // 4. 进程树。supervisor 用真实 process group 兜底，这里只负责确认结果。
    let survivingPids: number[] = []
    if (this.options.reaper) {
      survivingPids = await this.options.reaper.reap().catch((err) => {
        log.error('process_tree_reap_failed', {
          event: 'process_tree_reap_failed',
          error_message: redactError(err),
        })
        // 回收本身失败时不能报告"干净"：宁可让上层按 PROCESS_TREE_CLEANUP_FAILED 处理。
        return [-1]
      })
    }

    // 5. 数据库 fencing。
    await this.options.fence?.(reason).catch((err) =>
      log.error('attempt_fence_failed', {
        event: 'attempt_fence_failed',
        error_message: redactError(err),
      }),
    )

    const outcome: DrainOutcome = {
      reason,
      cancelledAgents: cancelled.length,
      cancelledJobs,
      survivingPids,
      cleanupFailed: survivingPids.length > 0,
    }

    log.info('attempt_drained', {
      event: 'attempt_drained',
      reason,
      cancelled_agents: outcome.cancelledAgents,
      cancelled_jobs: outcome.cancelledJobs,
      surviving_pids: outcome.survivingPids.length,
      cleanup_failed: outcome.cleanupFailed,
      tree_digest: this.options.ledger.treeDigest(),
    })
    return outcome
  }
}
