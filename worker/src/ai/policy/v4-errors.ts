/**
 * V4 稳定错误码。
 *
 * 稳定的意思是：UI 分类、运维告警、回滚判定都按码走，消息随时可以改。所以码集合本身
 * 冻结在能力契约里，本模块与它对齐，contract test 会比对两边。
 *
 * 消息一律脱敏：不含源码、Prompt、路径外的秘密和凭据。构造错误时只写"发生了什么"和
 * "下一步该怎么办"，不回显被拒绝的输入内容。
 */

export const V4_ERROR_CODES = {
  AGENT_IDENTITY_INVALID: 'AGENT_IDENTITY_INVALID',
  AGENT_ROLE_DENIED: 'AGENT_ROLE_DENIED',
  SUBMIT_ROOT_ONLY: 'SUBMIT_ROOT_ONLY',
  AGENT_TREE_LIMIT_EXCEEDED: 'AGENT_TREE_LIMIT_EXCEEDED',
  AGENT_TREE_CANCELLED: 'AGENT_TREE_CANCELLED',
  MODEL_BUDGET_EXHAUSTED: 'MODEL_BUDGET_EXHAUSTED',
  TOOL_BUDGET_EXHAUSTED: 'TOOL_BUDGET_EXHAUSTED',
  WORKSPACE_POLICY_DENIED: 'WORKSPACE_POLICY_DENIED',
  WEB_EGRESS_DENIED: 'WEB_EGRESS_DENIED',
  SESSION_FENCED: 'SESSION_FENCED',
  SESSION_FORMAT_UNSUPPORTED: 'SESSION_FORMAT_UNSUPPORTED',
  SESSION_RECOVERY_FAILED: 'SESSION_RECOVERY_FAILED',
  EVIDENCE_AGENT_INVALID: 'EVIDENCE_AGENT_INVALID',
  EVIDENCE_ORIGIN_INVALID: 'EVIDENCE_ORIGIN_INVALID',
  ATTEMPT_ALREADY_SEALED: 'ATTEMPT_ALREADY_SEALED',
  PROCESS_TREE_CLEANUP_FAILED: 'PROCESS_TREE_CLEANUP_FAILED',
} as const

export type V4ErrorCode = (typeof V4_ERROR_CODES)[keyof typeof V4_ERROR_CODES]

/** 治理层拒绝。`modelCorrectable` 决定模型是否值得改一改再试。 */
export class V4GovernanceError extends Error {
  readonly code: V4ErrorCode
  readonly modelCorrectable: boolean

  constructor(code: V4ErrorCode, message: string, modelCorrectable = false) {
    super(message)
    this.name = 'V4GovernanceError'
    this.code = code
    this.modelCorrectable = modelCorrectable
  }
}

/**
 * 哪些码代表"attempt 已经不可能成功"，Worker 应当立即收敛而不是让模型继续烧预算。
 */
const TERMINAL_CODES: ReadonlySet<string> = new Set<string>([
  V4_ERROR_CODES.AGENT_TREE_CANCELLED,
  V4_ERROR_CODES.MODEL_BUDGET_EXHAUSTED,
  V4_ERROR_CODES.SESSION_FENCED,
  V4_ERROR_CODES.SESSION_FORMAT_UNSUPPORTED,
  V4_ERROR_CODES.SESSION_RECOVERY_FAILED,
  V4_ERROR_CODES.ATTEMPT_ALREADY_SEALED,
  V4_ERROR_CODES.PROCESS_TREE_CLEANUP_FAILED,
])

export function isTerminalV4Error(code: string): boolean {
  return TERMINAL_CODES.has(code)
}

/**
 * 哪些码是模型可以自己纠正的：换个工具、换个 URL、换条证据再来一次。
 * 这类拒绝不终止 turn。
 */
const MODEL_CORRECTABLE_CODES: ReadonlySet<string> = new Set<string>([
  V4_ERROR_CODES.AGENT_ROLE_DENIED,
  V4_ERROR_CODES.SUBMIT_ROOT_ONLY,
  V4_ERROR_CODES.AGENT_TREE_LIMIT_EXCEEDED,
  V4_ERROR_CODES.TOOL_BUDGET_EXHAUSTED,
  V4_ERROR_CODES.WORKSPACE_POLICY_DENIED,
  V4_ERROR_CODES.WEB_EGRESS_DENIED,
  V4_ERROR_CODES.EVIDENCE_AGENT_INVALID,
  V4_ERROR_CODES.EVIDENCE_ORIGIN_INVALID,
])

export function isModelCorrectableV4Error(code: string): boolean {
  return MODEL_CORRECTABLE_CODES.has(code)
}
