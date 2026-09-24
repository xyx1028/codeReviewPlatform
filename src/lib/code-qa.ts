/**
 * 产品代码问答的前端纯逻辑（V1.23）。
 *
 * 放在这里而不是页面组件里的理由是可测：阶段文案、错误码文案、发送前校验和证据整理
 * 这四件事都有"写错了不会报错，只会让产品看到一句误导的话"的性质。它们不碰 React，
 * 也不碰 Supabase。
 */

import type {
  CodeQaConversationDetail,
  CodeQaEvidence,
  CodeQaStage,
  CodeQaTurn,
  CodeQaTurnStatus,
} from '../types'

/** 问题长度上限，与数据库 CHECK 一致（超过就是被库拒，不如前端先说）。 */
export const CODE_QA_QUESTION_MAX_CHARS = 4000

/**
 * 阶段文案。
 *
 * 每一句都对应 Worker 在**真实转换点**上报的 stage，不是按时间猜的。所以这里不能出现
 * "即将完成"这类没有事实支撑的措辞 —— 页面上每一句"正在……"都必须有后端事实，这是
 * V1.5 监控台立下的规矩，问答沿用。
 */
const STAGE_LABELS: Record<CodeQaStage, string> = {
  QUEUED: '排队中，等待分析服务领取',
  PREPARING_CODE: '正在拉取该分支的代码快照',
  EXPLORING: '正在检索代码',
  GENERATING: '正在组织回答',
  DONE: '已完成',
}

export function describeCodeQaStage(stage: CodeQaStage): string {
  return STAGE_LABELS[stage] ?? '进行中'
}

/**
 * 错误码 → 给产品看的一句话 + 该怎么办。
 *
 * 刻意逐条写而不是收敛成"回答失败，请重试"：这几种失败的处置完全不同 —— 等 Worker 上线、
 * 找管理员配模型、连内网、还是重开会话。把它们混成一句话，用户唯一能做的就是无意义地重试。
 */
const ERROR_HINTS: Record<string, string> = {
  MODEL_CONFIG_NOT_FOUND: '平台还没有启用任何模型配置，请联系管理员在「模型管理」里配置。',
  MODEL_SECRET_MISSING: '模型配置缺少可用的 API Key，请联系管理员补齐。',
  MODEL_TIMEOUT: '模型响应超时。问题较大时可以拆成几个小问题分别问。',
  MODEL_PROXY_UNREACHABLE: '模型要经宿主机代理访问，但代理当前不可用，请联系管理员。',
  MODEL_NETWORK_ERROR: '连不上模型端点，请确认运行环境已接入公司网络或 VPN。',
  MODEL_OUTPUT_TRUNCATED: '回答超出了模型的输出上限被截断，请把问题问得更具体一些。',
  CODE_QA_SNAPSHOT_FAILED: '拉取该分支代码失败。请确认分支存在，且分析服务能访问代码仓库。',
  CODE_QA_SESSION_RESUME_FAILED:
    '这个会话的上下文已经无法恢复（历史记录可能已被清理）。请新建一个会话继续提问。',
  CODE_QA_ANSWER_EMPTY: '模型没有产出任何回答，请换个说法再问一次。',
  CODE_QA_TURN_IN_FLIGHT: '这个会话还有一个问题正在回答，请等它结束。',
  CODE_QA_TIMEOUT: '这一轮超过了允许的时长被终止。请把问题拆小一些。',
  TASK_LEASE_LOST: '处理这一轮的分析服务失联了，问题已重新排队。',
}

export function describeCodeQaError(
  errorCode: string | null | undefined,
  errorMessage: string | null | undefined,
): string {
  const hint = errorCode ? ERROR_HINTS[errorCode] : undefined
  if (hint) return hint
  // 没有登记的错误码：原样透出原因，绝不吞掉。运维要靠它定位，用户也至少知道不是自己的问题。
  const detail = (errorMessage ?? '').trim()
  if (detail !== '') return detail
  return errorCode ? `回答失败（${errorCode}）` : '回答失败'
}

export interface QuestionValidation {
  ok: boolean
  reason?: string
}

/**
 * 发送前校验。
 *
 * 会话在飞时禁止发送 —— 数据库那边有唯一索引兜底，但让用户点下去再收到一个错误
 * 是没必要的摩擦。
 */
export function validateCodeQaQuestion(input: {
  question: string
  hasInFlightTurn: boolean
}): QuestionValidation {
  const trimmed = input.question.trim()
  if (trimmed === '') return { ok: false, reason: '请先输入问题' }
  if (trimmed.length > CODE_QA_QUESTION_MAX_CHARS) {
    return {
      ok: false,
      reason: `问题最多 ${CODE_QA_QUESTION_MAX_CHARS} 个字符，当前 ${trimmed.length} 个`,
    }
  }
  if (input.hasInFlightTurn) {
    return { ok: false, reason: '上一个问题还在回答中，请稍等' }
  }
  return { ok: true }
}

/** 终态判定。页面靠它决定还要不要继续轮询。 */
export function isCodeQaTurnTerminal(status: CodeQaTurnStatus): boolean {
  return status === 'SUCCEEDED' || status === 'FAILED'
}

export function hasInFlightTurn(turns: readonly CodeQaTurn[]): boolean {
  return turns.some((turn) => !isCodeQaTurnTerminal(turn.status))
}

/**
 * 轮询间隔。
 *
 * 有在飞轮次时 2 秒一次；全部终态后返回 false 让 react-query 停下来。不做指数退避：
 * 一轮问答通常几十秒到两分钟，退避只会让最后那次刷新迟到。
 */
export function codeQaPollInterval(detail: CodeQaConversationDetail | undefined): number | false {
  if (!detail) return false
  return hasInFlightTurn(detail.turns) ? 2000 : false
}

export interface EvidenceSummary {
  commitSha: string | null
  /** 短 SHA，给页面显示。 */
  shortSha: string | null
  filesRead: string[]
  skillsUsed: string[]
  toolCallCount: number | null
  /** 这一轮是否续用了既有会话上下文。false 表示模型不记得更早的对话。 */
  resumed: boolean | null
}

/**
 * 把证据 jsonb 整理成页面直接能渲染的形状。
 *
 * 全部字段都按"可能缺席"处理：证据由 Worker 写入，旧行、失败行都可能只有一部分键。
 * 缺席时返回空而不是抛错 —— 一个历史轮次渲染不出证据，不该让整页崩掉。
 */
export function summarizeCodeQaEvidence(evidence: CodeQaEvidence | null | undefined): EvidenceSummary {
  const sha = typeof evidence?.commit_sha === 'string' ? evidence.commit_sha : null
  return {
    commitSha: sha,
    shortSha: sha ? sha.slice(0, 8) : null,
    filesRead: Array.isArray(evidence?.files_read)
      ? evidence.files_read.filter((item): item is string => typeof item === 'string')
      : [],
    skillsUsed: Array.isArray(evidence?.skills_used)
      ? evidence.skills_used.filter((item): item is string => typeof item === 'string')
      : [],
    toolCallCount:
      typeof evidence?.tool_call_count === 'number' ? evidence.tool_call_count : null,
    resumed: typeof evidence?.resumed === 'boolean' ? evidence.resumed : null,
  }
}

/**
 * 会话是否需要提示"模型已经不记得更早的上文"。
 *
 * 判据是**最后一轮的证据里 resumed === false 且它不是第一轮**。第一轮当然不是续跑，
 * 那不值得提示；而中途出现 resumed=false 意味着上下文断过一次，那是用户需要知道的事实。
 */
export function shouldWarnContextReset(turns: readonly CodeQaTurn[]): boolean {
  if (turns.length < 2) return false
  const last = turns[turns.length - 1]
  if (last.status !== 'SUCCEEDED') return false
  return summarizeCodeQaEvidence(last.evidence).resumed === false
}
