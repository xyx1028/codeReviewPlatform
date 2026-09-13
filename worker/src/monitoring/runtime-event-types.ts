/**
 * 运行监控事件契约（方案 §6.3 / §6.5 / §7.1）。
 *
 * 三条硬规则：
 *   1. 每个事件类型只允许它自己那几个 payload 字段。禁止 `Record<string, unknown>`
 *      直通 —— 那等于把 allowlist 交给调用方自觉。
 *   2. payload 里只有稳定机器码与标量：没有 Prompt、没有工具参数/返回、没有命令、
 *      没有 stdout/stderr、没有 URL、没有绝对路径、没有任何 token。
 *      唯一的路径类字段是 `repository_name`，它是四仓枚举。
 *   3. `errorCode` / `reason_code` 是稳定码，不是异常 message。数据库侧还会再校验一次
 *      并丢弃不合规的值，但正确的做法是在这里就不产生它们。
 *
 * 事件类型必须与 `analysis_runtime_event_catalog()`（0032 迁移）逐字一致：目录里没有的
 * 类型会被数据库拒绝并计入 `dropped_invalid`。Workflow / Harness Job 的类型故意不存在，
 * 因为 Phase 3 之前平台没有它们的真实生命周期边界。
 */

import type { RepositoryName } from '../git/repositories.js'
import type { ModelRequestKind } from '../ai/control/hierarchical-budget-ledger.js'

/** 事件作用域。与数据库 `analysis_runtime_event.scope` 的 CHECK 一致。 */
export type RuntimeEventScope = 'JOB' | 'TASK' | 'ATTEMPT' | 'AGENT' | 'MODEL' | 'TOOL'

/**
 * 生命周期相位。`STARTED` 表示该 correlation 尚未闭合 —— 这是"正在调用"的唯一判据。
 * 点事件（`PINS_VERIFIED` 等）没有相位。
 */
export type RuntimeEventPhase = 'STARTED' | 'TERMINAL'

/** Agent 角色。与数据库 `analysis_agent_node.agent_role` 的 CHECK 一致。 */
export type RuntimeAgentRole =
  | 'root-reviewer'
  | 'research-child'
  | 'implementation-child'
  | 'critic-child'
  | 'workflow-child'

/** Agent 产生方式。与 `analysis_agent_node.provider` 的 CHECK 一致。 */
export type RuntimeAgentProvider = 'root' | 'spawn' | 'fork' | 'workflow' | 'ralph'

// ---------------------------------------------------------------------------
// Payload 形状：逐个事件类型定义，字段与数据库 allowlist 一一对应
// ---------------------------------------------------------------------------

export interface RepositoryPreparePayload {
  repository_name: RepositoryName
  duration_ms?: number
}

export interface TaskRepositoriesPayload {
  duration_ms?: number
}

export interface AttemptPhasePayload {
  attempt_number?: number
  session_revision?: number
  duration_ms?: number
  resumed?: boolean
}

export interface AttemptReasonPayload {
  reason_code?: string
}

export interface InstrumentationHealthPayload {
  events_reported: number
  events_dropped: number
}

export interface ToolStartedPayload {
  tool_name: string
  agent_role?: RuntimeAgentRole
  provider?: RuntimeAgentProvider
  request_bytes?: number
}

export interface ToolTerminalPayload {
  tool_name: string
  agent_role?: RuntimeAgentRole
  duration_ms?: number
  /** §7.3 的 1 秒折叠产物：这条 TERMINAL 没有独立的 STARTED 行。 */
  collapsed?: boolean
  /** bash 退出码。整数，不含命令与输出。 */
  exit_code?: number
  /** 只是字节数，用来定位"读了个巨大文件"这类浪费。 */
  output_bytes?: number
  response_bytes?: number
  /** 截断意味着 Agent 拿到的是残缺上下文，常是返工根因。 */
  truncated?: boolean
  /** 0 命中的检索是纯浪费；命中过多说明查询太宽。 */
  hit_count?: number
  /** 行数，不含路径与内容。 */
  line_span?: number
}

export interface ToolDeniedPayload {
  tool_name: string
  agent_role?: RuntimeAgentRole
  permission_verdict: 'DENY'
  reason_code: string
}

export interface ModelStartedPayload {
  model_request_kind: ModelRequestKind
  agent_role?: RuntimeAgentRole
  retry_index?: number
  request_bytes?: number
}

export interface ModelTerminalPayload {
  model_request_kind: ModelRequestKind
  agent_role?: RuntimeAgentRole
  retry_index?: number
  /** provider 不上报时保持 null：null 与 0 是两件不同的事。 */
  input_tokens?: number | null
  output_tokens?: number | null
  duration_ms?: number
  collapsed?: boolean
}

export interface ModelDeniedPayload {
  model_request_kind: ModelRequestKind
  agent_role?: RuntimeAgentRole
  reason_code: string
  permission_verdict?: 'DENY'
}

// ---------------------------------------------------------------------------
// 事件联合类型：按 event type 判别
// ---------------------------------------------------------------------------

interface RuntimeEventCommon {
  /**
   * 执行边界实际发生的时间。省略时由 Reporter 取入队时刻。
   * 重试必须复用首次的值，否则 `event_day` 会漂移。
   */
  occurredAt?: Date
  /** 已闭合生命周期的耗时。 */
  durationMs?: number
  /** 稳定错误码。绝不传异常 message。 */
  errorCode?: string
}

interface AgentScopedEvent extends RuntimeEventCommon {
  /**
   * 事件所属 Agent 的 `agent_id`。数据库按 `(agent_run_id, agent_id)` 解析 node；
   * 解析不到就丢弃并计数（子 Agent 注册与首次工具调用之间存在窗口）。
   */
  agentId?: string
}

interface CorrelatedEvent extends AgentScopedEvent {
  /** 一次工具 / 模型请求生命周期的稳定随机 ID。不得用命令、URL 或路径。 */
  correlationId: string
  parentCorrelationId?: string
}

export type RuntimeEvent =
  // ── JOB scope（无 task claim 的准备阶段）──
  | (RuntimeEventCommon & {
      type: 'REPOSITORY_PREPARE_STARTED'
      payload: RepositoryPreparePayload
    })
  | (RuntimeEventCommon & {
      type: 'REPOSITORY_PREPARE_COMPLETED'
      payload: RepositoryPreparePayload
    })
  | (RuntimeEventCommon & {
      type: 'REPOSITORY_PREPARE_FAILED'
      payload: RepositoryPreparePayload
    })
  // ── TASK scope ──
  | (RuntimeEventCommon & {
      type: 'TASK_REPOSITORIES_STARTED'
      payload?: TaskRepositoriesPayload
    })
  | (RuntimeEventCommon & {
      type: 'TASK_REPOSITORIES_READY'
      payload?: TaskRepositoriesPayload
    })
  // ── ATTEMPT scope：引擎的确定性阶段边界 ──
  | (RuntimeEventCommon & { type: 'RUNTIME_CONTRACT_VERIFIED'; payload?: AttemptPhasePayload })
  | (RuntimeEventCommon & { type: 'RUNTIME_CONTRACT_REJECTED'; payload?: AttemptReasonPayload })
  | (RuntimeEventCommon & { type: 'PINS_VERIFIED'; payload?: AttemptPhasePayload })
  | (RuntimeEventCommon & { type: 'SESSION_SLOT_ACQUIRED'; payload?: AttemptPhasePayload })
  | (RuntimeEventCommon & { type: 'WORKSPACE_READY'; payload?: AttemptPhasePayload })
  | (RuntimeEventCommon & { type: 'BROKER_READY'; payload?: AttemptPhasePayload })
  | (RuntimeEventCommon & { type: 'PROFILE_FROZEN'; payload?: AttemptPhasePayload })
  | (RuntimeEventCommon & { type: 'HARNESS_PROCESS_STARTED'; payload?: AttemptPhasePayload })
  | (RuntimeEventCommon & { type: 'SESSION_RESUMED'; payload?: AttemptPhasePayload })
  | (RuntimeEventCommon & { type: 'ACP_TURN_STARTED'; payload?: AttemptPhasePayload })
  | (RuntimeEventCommon & {
      type: 'ATTEMPT_INSTRUMENTATION_REPORTED'
      payload: InstrumentationHealthPayload
    })
  | (RuntimeEventCommon & {
      type: 'PROCESS_TREE_CLEANUP_FAILED'
      payload?: AttemptReasonPayload
    })
  // ── MODEL scope ──
  | (CorrelatedEvent & { type: 'MODEL_REQUEST_STARTED'; payload: ModelStartedPayload })
  | (CorrelatedEvent & { type: 'MODEL_REQUEST_COMPLETED'; payload: ModelTerminalPayload })
  | (CorrelatedEvent & { type: 'MODEL_REQUEST_FAILED'; payload: ModelTerminalPayload })
  | (CorrelatedEvent & { type: 'MODEL_REQUEST_DENIED'; payload: ModelDeniedPayload })
  // ── TOOL scope（覆盖全部 30 个模型工具）──
  | (CorrelatedEvent & { type: 'TOOL_CALL_STARTED'; payload: ToolStartedPayload })
  | (CorrelatedEvent & { type: 'TOOL_CALL_COMPLETED'; payload: ToolTerminalPayload })
  | (CorrelatedEvent & { type: 'TOOL_CALL_FAILED'; payload: ToolTerminalPayload })
  | (CorrelatedEvent & { type: 'TOOL_CALL_DENIED'; payload: ToolDeniedPayload })
  | (CorrelatedEvent & { type: 'TOOL_CALL_CANCELLED'; payload: ToolTerminalPayload })

export type RuntimeEventType = RuntimeEvent['type']

/** 事件类型 → scope / phase。与 0032 的目录逐字一致。 */
const EVENT_SHAPE: Record<
  RuntimeEventType,
  { scope: RuntimeEventScope; phase: RuntimeEventPhase | null }
> = {
  REPOSITORY_PREPARE_STARTED: { scope: 'JOB', phase: null },
  REPOSITORY_PREPARE_COMPLETED: { scope: 'JOB', phase: null },
  REPOSITORY_PREPARE_FAILED: { scope: 'JOB', phase: null },
  TASK_REPOSITORIES_STARTED: { scope: 'TASK', phase: null },
  TASK_REPOSITORIES_READY: { scope: 'TASK', phase: null },
  RUNTIME_CONTRACT_VERIFIED: { scope: 'ATTEMPT', phase: null },
  RUNTIME_CONTRACT_REJECTED: { scope: 'ATTEMPT', phase: null },
  PINS_VERIFIED: { scope: 'ATTEMPT', phase: null },
  SESSION_SLOT_ACQUIRED: { scope: 'ATTEMPT', phase: null },
  WORKSPACE_READY: { scope: 'ATTEMPT', phase: null },
  BROKER_READY: { scope: 'ATTEMPT', phase: null },
  PROFILE_FROZEN: { scope: 'ATTEMPT', phase: null },
  HARNESS_PROCESS_STARTED: { scope: 'ATTEMPT', phase: null },
  SESSION_RESUMED: { scope: 'ATTEMPT', phase: null },
  ACP_TURN_STARTED: { scope: 'ATTEMPT', phase: null },
  ATTEMPT_INSTRUMENTATION_REPORTED: { scope: 'ATTEMPT', phase: null },
  PROCESS_TREE_CLEANUP_FAILED: { scope: 'ATTEMPT', phase: null },
  MODEL_REQUEST_STARTED: { scope: 'MODEL', phase: 'STARTED' },
  MODEL_REQUEST_COMPLETED: { scope: 'MODEL', phase: 'TERMINAL' },
  MODEL_REQUEST_FAILED: { scope: 'MODEL', phase: 'TERMINAL' },
  MODEL_REQUEST_DENIED: { scope: 'MODEL', phase: 'TERMINAL' },
  TOOL_CALL_STARTED: { scope: 'TOOL', phase: 'STARTED' },
  TOOL_CALL_COMPLETED: { scope: 'TOOL', phase: 'TERMINAL' },
  TOOL_CALL_FAILED: { scope: 'TOOL', phase: 'TERMINAL' },
  TOOL_CALL_DENIED: { scope: 'TOOL', phase: 'TERMINAL' },
  TOOL_CALL_CANCELLED: { scope: 'TOOL', phase: 'TERMINAL' },
}

export function runtimeEventScope(type: RuntimeEventType): RuntimeEventScope {
  return EVENT_SHAPE[type].scope
}

export function runtimeEventPhase(type: RuntimeEventType): RuntimeEventPhase | null {
  return EVENT_SHAPE[type].phase
}

export function isRuntimeEventType(value: string): value is RuntimeEventType {
  return Object.prototype.hasOwnProperty.call(EVENT_SHAPE, value)
}

/**
 * 队列溢出时的丢弃优先级（数字越大越先丢）。
 *
 * `*_DENIED` / `*_FAILED` / 任何 ATTEMPT / AGENT / JOB / TASK scope 事件永不丢弃：
 * 宁可挤掉高频工具事件，也不能丢掉"为什么失败"。
 */
export type RuntimeEventDropPriority = 0 | 1 | 2 | 3

export function runtimeEventDropPriority(
  type: RuntimeEventType,
  collapsed: boolean,
): RuntimeEventDropPriority {
  if (type.endsWith('_DENIED') || type.endsWith('_FAILED')) return 0
  const scope = runtimeEventScope(type)
  if (scope !== 'MODEL' && scope !== 'TOOL') return 0
  if (collapsed) return 3
  if (type === 'MODEL_REQUEST_COMPLETED') return 2
  if (type === 'TOOL_CALL_STARTED' || type === 'MODEL_REQUEST_STARTED') return 1
  return 1
}

/** 一条已经序列化好、可直接进 `report_analysis_runtime_event_batch` 的事件。 */
export interface RuntimeEventWire {
  event_uuid: string
  event_type: RuntimeEventType
  occurred_at: string
  agent_id?: string
  correlation_id?: string
  parent_correlation_id?: string
  error_code?: string
  duration_ms?: number
  payload: Record<string, string | number | boolean | null>
}

/** `report_analysis_runtime_event_batch` 的返回体。 */
export interface RuntimeEventBatchResult {
  accepted: number
  duplicated: number
  dropped_unresolved_agent: number
  dropped_invalid: number
  max_event_id: number | null
}

/** 事件上报的 fencing 上下文。 */
export interface RuntimeEventTarget {
  workerId: string
  jobId: string
  /** JOB scope 上报时为 null。 */
  taskId?: string | null
  claimToken?: string | null
  agentAttempt?: number | null
  /** 收敛路径（claim 已被清空）唯一可用的 fencing 令牌（§6.4.1）。 */
  sessionRevision?: number | null
}

export interface RuntimeEventSink {
  reportRuntimeEventBatch(
    input: RuntimeEventTarget & { events: RuntimeEventWire[] },
  ): Promise<RuntimeEventBatchResult>
}
