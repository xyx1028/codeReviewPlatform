import type { StoryAnalysisScope } from '../../db/jobs.js'
import { AGENT_REVIEW_SYSTEM_PROMPT, buildAgentReviewPrompt, type AgentReviewContext } from './agent-review-v1.js'

export const AGENT_REVIEW_V2_PROMPT_VERSION = 'agent-review-v2'

export interface AgentReviewV2Context extends AgentReviewContext {
  scope: StoryAnalysisScope
}

export function buildAgentReviewV2Prompt(context: AgentReviewV2Context): string {
  const required = context.scope.candidates.filter((candidate) => candidate.tier === 'AI_CANDIDATE' || candidate.tier === 'WEAK')
  const candidates = context.scope.candidates.map((candidate) =>
    `- ${candidate.candidate_id} | ${candidate.tier} | ${candidate.repository}@${candidate.short_sha} | ${candidate.committed_at} | ${candidate.author_name} | ${candidate.subject} | reasons=${candidate.reason_codes.join(',')} | diff=${candidate.diff_status}`,
  ).join('\n') || '- 无候选；当前范围已显式降级，不能仅凭“无候选”判定未实现。'

  return `${AGENT_REVIEW_SYSTEM_PROMPT}

V1.11 范围规则（由平台强制，不是建议）：
- 当前 scope=${context.scope.scope_mode}/${context.scope.current_scope_level}，状态=${context.scope.status}，generation=${context.scope.generation}。
- 算法=${context.scope.algorithm_version}，ruleset=${context.scope.ruleset_hash}，candidateManifest=${context.scope.candidate_manifest_hash}。
- strong=${context.scope.strong_count}，AI候选=${context.scope.ai_candidate_count}。候选只是待核实线索，不是归属事实。
- 先核实候选，再检查冻结 HEAD 的最终状态；Commit diff 不能替代 read_snapshot_code 返回的最终证据。
- 有 ${required.length} 个 AI/WEAK 候选时，先调用 list_story_commits；对每个 candidateId 调用 read_story_commit_diff，再逐条调用 submit_commit_relevance_verdict。漏判、重复判或跨候选都会被 Broker/数据库拒绝。
- diff_status 不是 AVAILABLE、BINARY 或 DIFF_TOO_LARGE 时，不得伪称已读正文；应提交 UNCERTAIN，并带 DIFF_UNAVAILABLE 或 INSUFFICIENT_CONTEXT。
- 候选不足或依赖不清时必须调用 expand_analysis_scope，以枚举原因单调扩展 PRIMARY → RELATED → GLOBAL；模型文字不能扩大权限。
- triage 未被数据库确认 N/N 完成前，Broker 会拒绝 submit_review_result。

冻结候选：
${candidates}

---

${buildAgentReviewPrompt(context)}`
}
