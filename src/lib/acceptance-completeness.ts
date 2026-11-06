/**
 * 验收点完成度（V1.71）。
 *
 * 为什么需要它：需求级的 `ai_review_result.verdict` 是从验收点结论一票否决派生出来的
 * （`worker/src/ai/review-workflow.ts` 的 `overallVerdict`：11 个验收点里有 1 个
 * UNCERTAIN，整条需求就是「无法判断」）。于是列表把"7/11 已实现"和"0/11 已实现"
 * 显示成同一个标签，评审的人无法据此分流。完成度把逐点结论重新聚合成一个可比的数。
 *
 * 三条规矩：
 *
 * 1. **口径只有一份。** 列表、详情页、Markdown 报告都调这里，不允许各自再算一遍 ——
 *    同一条需求在两个页面显示不同的百分比，比没有这个数更糟。
 * 2. **分母是验收点清单，不是结论条数。** `findings` 可能漏掉某个验收点；漏掉的那个
 *    按「不确定」计入，分母不缩小。缩小分母会把"漏了结论"算成"完成度更高"。
 * 3. **不确定不等于未实现。** 两者权重都是 0（没有证据就不能算做到），但调用方拿得到
 *    `counts.UNCERTAIN` 和 `potentialPercent`，必须让人看见"这 n 项只是待确认"。
 *
 * 不落库：全部从已经加载到浏览器的 `acceptance_review` jsonb 派生，不新增查询、
 * 不新增迁移、不改 Worker。
 */

import type { AiReviewResult } from '../types'
import type { AcceptanceReviewReport, ReviewVerdict } from '../../worker/src/ai/review-workflow-types'

/**
 * 验收点结论权重。
 *
 * 已实现记满分；部分实现记 0.6（做了主要部分，但不该当成完整交付）；不确定记 0.25
 * —— 它和「未实现」不是一回事，未实现是查清了没做，不确定是还没查清，给一点分表示
 * "不按最坏情况算"，但远低于已实现，免得把待确认当成做完了。未实现记 0。
 *
 * 想调口径只改这张表：百分比、Tooltip 文案、报告输出三处都从这里派生。
 */
export const COMPLETENESS_WEIGHTS: Record<ReviewVerdict, number> = {
  IMPLEMENTED: 1,
  PARTIAL: 0.6,
  NOT_IMPLEMENTED: 0,
  UNCERTAIN: 0.25,
}

const VERDICT_ORDER: readonly ReviewVerdict[] = ['IMPLEMENTED', 'PARTIAL', 'NOT_IMPLEMENTED', 'UNCERTAIN']
const VERDICT_TEXT: Record<ReviewVerdict, string> = {
  IMPLEMENTED: '已实现',
  PARTIAL: '部分实现',
  NOT_IMPLEMENTED: '未实现',
  UNCERTAIN: '不确定',
}

export interface AcceptanceCompleteness {
  /** 0–100 整数。 */
  percent: number
  /** 不确定项全部按已实现算得到的上限，用来说明"还有多少是待确认而不是没做"。 */
  potentialPercent: number
  /** 验收点总数，也就是分母。 */
  total: number
  counts: Record<ReviewVerdict, number>
}

/** jsonb 里的 verdict 是模型产物，可能是没见过的字符串；按"不确定"兜底，不抛错。 */
function normalizeVerdict(value: unknown): ReviewVerdict {
  return VERDICT_ORDER.includes(value as ReviewVerdict) ? value as ReviewVerdict : 'UNCERTAIN'
}

/**
 * 从结构化验收报告算完成度。只认 `version === 1`；别的版本当作没有（不猜新格式）。
 * 没有验收点可算时返回 null，调用方据此显示「未分析 / 历史报告」而不是 0%。
 */
export function acceptanceCompletenessOf(
  report: AcceptanceReviewReport | null | undefined,
): AcceptanceCompleteness | null {
  if (!report || report.version !== 1) return null
  const findingByCriterion = new Map((report.findings ?? []).map((finding) => [finding.criterionId, finding]))
  // 分母优先用固定验收点清单；只有清单为空（理论上不该出现）才退回结论条数。
  const verdicts = report.criteria?.length
    ? report.criteria.map((point) => normalizeVerdict(findingByCriterion.get(point.id)?.verdict))
    : (report.findings ?? []).map((finding) => normalizeVerdict(finding.verdict))
  const total = verdicts.length
  if (total === 0) return null

  const counts: Record<ReviewVerdict, number> = { IMPLEMENTED: 0, PARTIAL: 0, NOT_IMPLEMENTED: 0, UNCERTAIN: 0 }
  let weighted = 0
  for (const verdict of verdicts) {
    counts[verdict] += 1
    weighted += COMPLETENESS_WEIGHTS[verdict]
  }
  // 上限 = 把每个不确定项从它当前的权重补到满分。写成差额而不是直接加 1，这样
  // 调整不确定的权重时上限会自动跟着对，不需要记得改第二处。
  const uncertainHeadroom = counts.UNCERTAIN * (1 - COMPLETENESS_WEIGHTS.UNCERTAIN)
  return {
    percent: Math.round((weighted / total) * 100),
    potentialPercent: Math.round(((weighted + uncertainHeadroom) / total) * 100),
    total,
    counts,
  }
}

/** 从一条 AI 结果算完成度；没有结果或历史格式报告都返回 null。 */
export function acceptanceCompleteness(
  result: Pick<AiReviewResult, 'acceptance_review'> | null | undefined,
): AcceptanceCompleteness | null {
  return acceptanceCompletenessOf(result?.acceptance_review ?? null)
}

/** 「已实现 7 / 部分实现 0 / 未实现 0 / 不确定 4」。报告与 Tooltip 共用。 */
export function completenessBreakdown(value: AcceptanceCompleteness): string {
  return VERDICT_ORDER.map((verdict) => `${VERDICT_TEXT[verdict]} ${value.counts[verdict]}`).join(' / ')
}

/**
 * 悬浮说明。
 *
 * 分数必须从权重表派生，不能写死在文案里：权重调了而文案没跟着改，页面就会一边显示
 * 73% 一边解释说"不确定按 0 分计入"，比不写解释更糟。
 *
 * 有不确定项时一定要给出上限。否则 73% 会被读成"27% 做错了"，而实际情况可能是
 * 27% 还没核实清楚。
 */
export function completenessTooltip(value: AcceptanceCompleteness): string {
  const score = (verdict: ReviewVerdict) => `${VERDICT_TEXT[verdict]}记 ${COMPLETENESS_WEIGHTS[verdict]} 分`
  const base = `共 ${value.total} 个验收点：${completenessBreakdown(value)}。`
  const rule = `${score('IMPLEMENTED')}、${score('PARTIAL')}、${score('NOT_IMPLEMENTED')}`
  if (value.counts.UNCERTAIN === 0) return `${base}${rule}，加权后为 ${value.percent}%。`
  return `${base}${rule}、${score('UNCERTAIN')}，当前 ${value.percent}%；若这 ${value.counts.UNCERTAIN} 项不确定都确认为已实现，完成度可达 ${value.potentialPercent}%。`
}

/** antd Tag 的预设色；和看板的绿/橙/红同一套语义。 */
export function completenessTagColor(percent: number): 'green' | 'orange' | 'red' {
  if (percent >= 100) return 'green'
  if (percent >= 60) return 'orange'
  return 'red'
}

/** 进度条填充色，和 `completenessTagColor` 的分档一致。 */
export function completenessTone(percent: number): string {
  if (percent >= 100) return '#16a34a'
  if (percent >= 60) return '#f59e0b'
  return '#ef4444'
}

/** 列表列筛选用的完成度区间。NONE 表示没有验收点结论（未分析或历史报告）。 */
export type CompletenessBand = 'FULL' | 'HIGH' | 'LOW' | 'ZERO' | 'NONE'

export const completenessBandOptions: ReadonlyArray<{ value: CompletenessBand; label: string }> = [
  { value: 'FULL', label: '100%' },
  { value: 'HIGH', label: '60–99%' },
  { value: 'LOW', label: '1–59%' },
  { value: 'ZERO', label: '0%' },
  { value: 'NONE', label: '无完成度数据' },
]

export function completenessBand(percent: number | null | undefined): CompletenessBand {
  if (percent === null || percent === undefined) return 'NONE'
  if (percent >= 100) return 'FULL'
  if (percent >= 60) return 'HIGH'
  if (percent > 0) return 'LOW'
  return 'ZERO'
}

/** 汇总报告用：只统计算得出完成度的需求，分母写清楚，避免把"未分析"算成 0%。 */
export function averageCompleteness(
  values: ReadonlyArray<AcceptanceCompleteness | null>,
): { percent: number; counted: number } {
  const present = values.filter((value): value is AcceptanceCompleteness => value !== null)
  if (present.length === 0) return { percent: 0, counted: 0 }
  const sum = present.reduce((total, value) => total + value.percent, 0)
  return { percent: Math.round(sum / present.length), counted: present.length }
}
