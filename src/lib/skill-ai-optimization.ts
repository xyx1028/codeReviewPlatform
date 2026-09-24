/**
 * 技能 AI 优化的前端纯逻辑（V1.19）。
 *
 * 放在 `lib/` 而不是页面里，是因为这三件事都值得单测，而单测一个 antd Modal 只能测到
 * "它渲染了"：
 *
 *   1. 逐行 diff 的行模型（哪些行算新增、删除、未变，行号怎么排）；
 *   2. 任务状态 → 三段进度的映射；
 *   3. 错误码 → 管理员看得懂的处置说明。
 *
 * 第 3 条是这个模块存在的主要理由。错误码直接显示给管理员等于让他去猜该做什么，而这些
 * 码的处置完全不同：换模型配置、等 Worker 上线、重试一次、或者"这个技能本来就没有证据
 * 可用，别优化它"。
 */

import { diffLines } from 'diff'

import type {
  SkillAiOptimizationStatus,
  SkillReviewEvidence,
  SkillVerdictKey,
} from '../types'

export type DiffLineKind = 'ADDED' | 'REMOVED' | 'CONTEXT'

/** 一个被改动文件的性质。渲染层据此给标签，而不是让人从 +/- 数字里推断。 */
export type FileChangeKind = 'ADDED' | 'DELETED' | 'MODIFIED' | 'BINARY'

export function fileChangeKind(file: {
  before: string | null
  after: string | null
  binary?: boolean
}): FileChangeKind {
  if (file.binary === true) return 'BINARY'
  if (file.before === null) return 'ADDED'
  if (file.after === null) return 'DELETED'
  return 'MODIFIED'
}

export const FILE_CHANGE_LABELS: Record<FileChangeKind, string> = {
  ADDED: '新增文件',
  DELETED: '删除文件',
  MODIFIED: '修改',
  BINARY: '二进制文件（无逐行 diff）',
}

export interface DiffLine {
  kind: DiffLineKind
  /** 旧文件里的行号；新增行为 null。 */
  beforeLineNumber: number | null
  /** 新文件里的行号；删除行为 null。 */
  afterLineNumber: number | null
  text: string
}

export interface DiffStats {
  added: number
  removed: number
}

export interface RenderedFileDiff {
  path: string
  lines: DiffLine[]
  stats: DiffStats
  /**
   * 两侧只有行尾符不同（CRLF ↔ LF）。
   *
   * 逐行比较前会把 CRLF 归一化成 LF，否则一个用 Windows 编辑器存过的 SKILL.md 会整份
   * 显示成"全删全增"，真正改了哪句话反而看不见。但归一化会藏起一个**真实的字节改动**，
   * 所以把它显式报出来：`stats` 全 0 而这一项为 true 时，渲染层必须说明"只有行尾符变了"，
   * 而不是让管理员对着一个空 diff 猜。
   */
  lineEndingChanged: boolean
}

/**
 * 把一段文本切成行。
 *
 * 末尾换行**不**产生一个空行：`"a\n"` 是一行而不是两行。不这么做的话，几乎每份
 * markdown 的 diff 末尾都会多出一条看不出内容的"未变行"。
 */
function toLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

function normalizeEol(text: string): string {
  return text.replace(/\r\n/g, '\n')
}

/**
 * 计算一个文件的逐行 diff。
 *
 * 用 jsdiff 的 `diffLines` 而不是自己写 LCS：它是这件事的通用解，而自写版本在
 * "移动一大段 + 局部改词"这类真实改动上会退化成"整块删、整块加"，让管理员看不出
 * 到底改了什么。
 */
export function renderFileDiff(input: {
  path: string
  before: string | null
  after: string | null
}): RenderedFileDiff {
  const beforeRaw = input.before ?? ''
  const afterRaw = input.after ?? ''
  const beforeText = normalizeEol(beforeRaw)
  const afterText = normalizeEol(afterRaw)
  const changes = diffLines(beforeText, afterText)

  const lines: DiffLine[] = []
  let beforeLine = 0
  let afterLine = 0
  let added = 0
  let removed = 0

  for (const change of changes) {
    for (const text of toLines(change.value)) {
      if (change.added === true) {
        afterLine += 1
        added += 1
        lines.push({ kind: 'ADDED', beforeLineNumber: null, afterLineNumber: afterLine, text })
      } else if (change.removed === true) {
        beforeLine += 1
        removed += 1
        lines.push({ kind: 'REMOVED', beforeLineNumber: beforeLine, afterLineNumber: null, text })
      } else {
        beforeLine += 1
        afterLine += 1
        lines.push({
          kind: 'CONTEXT',
          beforeLineNumber: beforeLine,
          afterLineNumber: afterLine,
          text,
        })
      }
    }
  }

  return {
    path: input.path,
    lines,
    stats: { added, removed },
    lineEndingChanged: beforeRaw !== afterRaw && beforeText === afterText,
  }
}

/**
 * 折叠大段未改动内容。
 *
 * 一份 SKILL.md 可能有几百行而只改了三处；全量渲染会让管理员在"确认发布"之前滚很久，
 * 而滚动本身不构成审阅。保留每个改动块前后 `context` 行，中间用一条折叠标记代替。
 *
 * 返回值里 `null` 表示"这里省略了若干未改动行"，由渲染层显示成一条分隔线。
 */
export function collapseUnchanged(
  lines: readonly DiffLine[],
  context = 3,
): Array<DiffLine | null> {
  const keep = new Set<number>()
  lines.forEach((line, index) => {
    if (line.kind === 'CONTEXT') return
    for (let offset = -context; offset <= context; offset++) {
      const target = index + offset
      if (target >= 0 && target < lines.length) keep.add(target)
    }
  })

  const out: Array<DiffLine | null> = []
  let skipping = false
  lines.forEach((line, index) => {
    if (keep.has(index)) {
      out.push(line)
      skipping = false
      return
    }
    if (!skipping) {
      out.push(null)
      skipping = true
    }
  })
  return out
}

/** `Steps` 的当前段：排队中 → AI 生成中 → 等待确认。 */
export function optimizationStepIndex(status: SkillAiOptimizationStatus | null): number {
  switch (status) {
    case 'QUEUED':
      return 0
    case 'RUNNING':
      return 1
    case 'SUCCEEDED':
      return 2
    case 'FAILED':
      // 失败停在"AI 生成中"这一段并由调用方把它标成 error —— 跳到第三段会让人以为
      // 还有一份草稿等着确认。
      return 1
    default:
      return 0
  }
}

export function isOptimizationInFlight(status: SkillAiOptimizationStatus | null): boolean {
  return status === 'QUEUED' || status === 'RUNNING'
}

/**
 * 错误码 → 管理员看得懂的一句话 + 该做什么。
 *
 * 未登记的码不编故事：原样显示码本身，并提示这是需要运维看日志的情况。猜一个友好文案
 * 比显示码更糟 —— 它会把一个未知问题伪装成一个已知问题。
 */
const OPTIMIZATION_ERROR_TEXT: Record<string, string> = {
  SKILL_OPTIMIZATION_NO_EVIDENCE:
    '这个技能还没有被任何分析任务引用过，没有可依据的历史评审证据。先让它参与几次评审，再来优化。',
  SKILL_OPTIMIZATION_MODEL_OUTPUT_INVALID:
    'AI 连续几次写出的技能包都没通过结构检查（路径不合规、放错目录、frontmatter 的 name 被改、文件或整包超出容量上限之类）。没有产出任何草稿，可以直接重试。',
  SKILL_OPTIMIZATION_SOURCE_UNREADABLE:
    '当前已发布版本的技能包读不出可优化的 SKILL.md 正文。请先确认这个版本能正常下载。',
  SKILL_OPTIMIZATION_REPACK_REJECTED:
    '重新打包后的技能包没有通过与人工上传完全相同的校验，已拒绝产出草稿。这通常意味着 AI 写出的内容触碰了容量或格式上限。',
  SKILL_OPTIMIZATION_UPLOAD_INVALID:
    '优化产出的待发布包没有通过服务端校验，不能作为结果提交。',
  SKILL_OPTIMIZATION_ACTOR_MISSING:
    '发起这次优化的账号已不存在，任务无法继续（产出物必须以一个管理员身份走上传校验）。请重新发起。',
  MODEL_CONFIG_NOT_FOUND:
    '没有可用的模型配置。请先在「模型配置」里启用一个模型，再重新发起优化。',
  MODEL_SECRET_MISSING: '模型配置缺少 API Key。请在「模型配置」里补齐后重新发起。',
  MODEL_TIMEOUT: '模型请求超时。可以重试；持续超时请检查模型端点与网络。',
  MODEL_PROXY_NOT_CONFIGURED:
    '这个模型是内网模型，但执行任务的 Worker 没有配置宿主机代理。需要运维在 Worker 上配置代理，或把模型改为公网模型。',
  MODEL_PROXY_UNREACHABLE: '宿主机代理不可用，请确认代理已启动。',
  MODEL_NETWORK_ERROR: '连不上模型端点，请确认运行 Worker 的机器已接入公司网络或 VPN。',
  MODEL_RESPONSE_INVALID: '模型端点返回的响应不是预期的 chat/completions 结构。',
  MODEL_RESPONSE_TOO_LARGE: '模型响应超出可接受大小，已拒绝处理。',
  TASK_LEASE_LOST: '任务租约已失效（执行它的 Worker 失联）。稍后会自动重新排队，也可以直接重试。',
  SKILL_NOT_PUBLISHED: '这个技能还没有已发布版本，无法优化。',
  SKILL_NOT_FOUND: '技能已不存在。',
  SKILL_OPTIMIZATION_FAILED: '优化过程中出现未归类的失败，需要查看 Worker 日志。',
}

export function describeOptimizationError(
  errorCode: string | null,
  errorMessage: string | null,
): string {
  if (errorCode === null || errorCode === '') {
    return errorMessage ?? '优化失败，但没有返回错误码。这需要查看 Worker 日志。'
  }
  const known = OPTIMIZATION_ERROR_TEXT[errorCode]
  if (known !== undefined) return known
  if (/^MODEL_HTTP_\d+$/.test(errorCode)) {
    return `模型端点返回 ${errorCode.replace('MODEL_HTTP_', 'HTTP ')}。请检查模型配置与配额。`
  }
  return `未登记的错误码 ${errorCode}${errorMessage === null ? '' : `：${errorMessage}`}。这需要运维查看 Worker 日志。`
}

const VERDICT_ORDER: SkillVerdictKey[] = [
  'IMPLEMENTED',
  'PARTIAL',
  'NOT_IMPLEMENTED',
  'UNCERTAIN',
]

/**
 * 证据是否足以支撑一次优化。
 *
 * 判据只有一条：有没有被 Job 引用过。刻意**不**要求"必须有人工复核" —— 人工复核率低是
 * 常态，而 AI 结论分布本身（尤其 UNCERTAIN 的比例）已经是有用的信号。
 */
export function canOptimizeFromEvidence(evidence: SkillReviewEvidence | null): boolean {
  return evidence !== null && evidence.referenced_job_count > 0
}

/** 顶部一行摘要。计数用服务端口径，前端不重新加总。 */
export function summarizeEvidence(evidence: SkillReviewEvidence): string {
  const total = VERDICT_ORDER.reduce((sum, key) => sum + (evidence.verdict_counts[key] ?? 0), 0)
  const flagged =
    (evidence.human_review_counts.INCORRECT ?? 0) +
    (evidence.human_review_counts.PARTIALLY_CORRECT ?? 0) +
    (evidence.human_review_counts.NEED_DISCUSSION ?? 0)
  if (evidence.referenced_job_count === 0) {
    return '还没有历史评审证据，暂不建议 AI 优化。'
  }
  const batches = evidence.referenced_batches ?? []
  const batchCount = new Set(batches.map((batch) => batch.batch_id)).size
  const batchText = batchCount === 0 ? '' : `来自 ${batchCount} 个评审批次、`
  return `${batchText}被 ${evidence.referenced_job_count} 个分析任务引用过，共 ${total} 条评审结论，其中 ${flagged} 条被人工标为「错 / 部分对 / 需讨论」。`
}

/**
 * 按批次归并引用记录。
 *
 * 同一批次重跑过就会有多个 Job。表格按批次一行显示，把 Job 次数与最近一次时间折进去 ——
 * 管理员关心的是"哪几轮评审用过它"，不是"哪几个 Job id"。
 */
export interface EvidenceBatchGroup {
  batch_id: string
  batch_name: string
  week_code: string | null
  job_count: number
  latest_job_at: string | null
  result_count: number
  skill_versions: number[]
}

export function groupEvidenceBatches(
  evidence: SkillReviewEvidence | null,
): EvidenceBatchGroup[] {
  const batches = evidence?.referenced_batches ?? []
  const grouped = new Map<string, EvidenceBatchGroup>()
  for (const batch of batches) {
    const existing = grouped.get(batch.batch_id)
    if (existing === undefined) {
      grouped.set(batch.batch_id, {
        batch_id: batch.batch_id,
        batch_name: batch.batch_name,
        week_code: batch.week_code,
        job_count: 1,
        latest_job_at: batch.job_created_at,
        result_count: batch.result_count,
        skill_versions: batch.skill_version === null ? [] : [batch.skill_version],
      })
      continue
    }
    existing.job_count += 1
    if (
      batch.job_created_at !== null &&
      (existing.latest_job_at === null || batch.job_created_at > existing.latest_job_at)
    ) {
      existing.latest_job_at = batch.job_created_at
    }
    if (batch.skill_version !== null && !existing.skill_versions.includes(batch.skill_version)) {
      existing.skill_versions.push(batch.skill_version)
    }
  }
  return [...grouped.values()].sort((a, b) => {
    const left = a.latest_job_at ?? ''
    const right = b.latest_job_at ?? ''
    if (left !== right) return left < right ? 1 : -1
    return a.batch_name < b.batch_name ? -1 : 1
  })
}
