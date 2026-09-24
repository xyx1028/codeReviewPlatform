/**
 * 技能 AI 优化的 Prompt 组装与模型输出解析。
 *
 * 这个模块刻意**不发任何网络请求**、不碰数据库、不碰文件系统：它只做"文本进、结构出"，
 * 于是它的全部行为都能用单测覆盖。真正危险的那一半（模型返回了什么、能不能信）在这里
 * 被收敛成一个 fail-closed 的解析函数。
 *
 * 为什么解析必须比"JSON.parse 成功"严格得多：
 *
 *   * 模型可以返回一个合法 JSON，却把 `files` 的 key 写成 `scripts/pwn.sh` —— 那会在下一步
 *     变成一个带可执行脚本的新版本，而管理员看到的 diff 只会多一个文件名。
 *   * 模型可以"顺手"把 frontmatter 的 `name` 改成别的技能名。发布链路会用 frontmatter 的
 *     name 做校验，但 dsh 侧的注册名与平台目录名分叉是最难诊断的一类故障，所以在这里就拒。
 *   * 模型可以返回一份与原文完全相同的正文。那种"优化"没有发布价值，把它当成成功会让
 *     管理员对着一个空 diff 猜哪里变了。
 *
 * 所以这里的规则是：**只接受白名单路径上的、真的变了的、仍然合法的文本**，其余一律
 * `SKILL_OPTIMIZATION_MODEL_OUTPUT_INVALID`。
 */

import { parseSkillEntryFrontmatter, SkillFrontmatterError } from './skill-frontmatter.js'
import { SKILL_ENTRY_FILE } from './skill-manifest.js'

/** 首版白名单：只允许改入口文件本体。 */
export const OPTIMIZABLE_PATHS: readonly string[] = [SKILL_ENTRY_FILE]

export const SKILL_OPTIMIZATION_OUTPUT_INVALID = 'SKILL_OPTIMIZATION_MODEL_OUTPUT_INVALID'

export interface SkillEvidenceSample {
  story_code: string
  verdict: string
  summary: string
  human_review_result: string | null
  human_review_comment: string | null
}

export interface SkillReviewEvidenceSnapshot {
  referenced_job_count: number
  verdict_counts: Record<string, number>
  human_review_counts: Record<string, number>
  sample_findings: SkillEvidenceSample[]
}

export interface SkillOptimizationPromptInput {
  skillName: string
  /** 当前已发布版本里各白名单文件的正文。 */
  currentFiles: ReadonlyMap<string, string>
  evidence: SkillReviewEvidenceSnapshot
  /** `SKILL.md` 的字节上限，原样告诉模型，避免它写出一份必然被拒的长文。 */
  entryFileBytes: number
}

export interface SkillOptimizationPrompt {
  system: string
  user: string
}

export class SkillOptimizationOutputError extends Error {
  readonly code = SKILL_OPTIMIZATION_OUTPUT_INVALID

  constructor(message: string) {
    super(message)
    this.name = 'SkillOptimizationOutputError'
  }
}

function reject(message: string): never {
  throw new SkillOptimizationOutputError(message)
}

/**
 * 把证据摘要渲染成模型能用的文本。
 *
 * 只渲染统计与抽样文本，不渲染 story_id / job_id / 仓库路径：模型这一次的任务是改一份
 * markdown，给它主键除了增加提示词长度没有任何用处。
 */
export function renderEvidenceDigest(evidence: SkillReviewEvidenceSnapshot): string {
  const lines: string[] = []
  lines.push(`引用过本技能的 Analysis Job 数量：${evidence.referenced_job_count}`)
  lines.push('')
  lines.push('AI 评审结论分布：')
  for (const key of ['IMPLEMENTED', 'PARTIAL', 'NOT_IMPLEMENTED', 'UNCERTAIN']) {
    lines.push(`  - ${key}: ${evidence.verdict_counts[key] ?? 0}`)
  }
  lines.push('')
  lines.push('人工复核分布：')
  for (const key of ['CORRECT', 'PARTIALLY_CORRECT', 'INCORRECT', 'NEED_DISCUSSION']) {
    lines.push(`  - ${key}: ${evidence.human_review_counts[key] ?? 0}`)
  }
  lines.push('')
  if (evidence.sample_findings.length === 0) {
    lines.push('抽样结论：无。')
    return lines.join('\n')
  }
  lines.push('抽样结论（人工标为「错 / 部分对 / 需讨论」的排在前面，它们是最有用的信号）：')
  for (const sample of evidence.sample_findings) {
    lines.push('')
    lines.push(`  需求 ${sample.story_code} · AI 结论 ${sample.verdict}`)
    lines.push(`    AI 摘要：${sample.summary.replace(/\s+/g, ' ').trim()}`)
    if (sample.human_review_result !== null) {
      lines.push(`    人工复核：${sample.human_review_result}`)
    }
    if (sample.human_review_comment !== null && sample.human_review_comment.trim() !== '') {
      lines.push(`    人工意见：${sample.human_review_comment.replace(/\s+/g, ' ').trim()}`)
    }
  }
  return lines.join('\n')
}

/**
 * 组装一次性优化请求。
 *
 * 这是一次 `chat/completions`，不是一棵 Agent 树：任务是"读一份 markdown 与一份统计，
 * 写回一份 markdown"，没有工具调用、没有代码检索，也就没有理由付多 Agent 编排的代价。
 */
export function buildSkillOptimizationPrompt(
  input: SkillOptimizationPromptInput,
): SkillOptimizationPrompt {
  const allowed = OPTIMIZABLE_PATHS.filter((path) => input.currentFiles.has(path))
  if (allowed.length === 0) {
    // 白名单里一个文件都没拿到 = 上游解包出了问题，不该把这种输入送去模型。
    reject('no optimizable file content was supplied')
  }

  const system = [
    '你是代码评审平台的技能维护助手。',
    '你的任务是根据一个技能在历史评审中的真实表现，改写它的 SKILL.md 正文，让后续评审少出错。',
    '',
    '硬性规则：',
    `1. 只输出一个 JSON 对象，不要加 markdown 代码块以外的任何解释性文字。`,
    '2. JSON 形状固定为 {"summary": string, "files": {"<路径>": "<新正文>"}}。',
    `3. files 的 key 只能出现在这个白名单里：${allowed.join(', ')}。不得新增、删除或重命名任何文件。`,
    '4. 必须保留 YAML frontmatter，并且 frontmatter 的 name 字段必须与原文完全一致。',
    '5. description 与 whenToUse 可以改写，但要保持一句话可读、不要写成清单。',
    '6. summary 用中文写清楚你改了什么、依据哪些评审证据，不要复述规则本身。',
    '7. 不要编造证据里没有的业务事实；证据不足时宁可少改。',
  ].join('\n')

  const fileSections = allowed
    .map((path) => `### ${path}\n\n\`\`\`markdown\n${input.currentFiles.get(path) ?? ''}\n\`\`\``)
    .join('\n\n')

  const user = [
    `技能名（frontmatter 的 name 必须保持这个值）：${input.skillName}`,
    `SKILL.md 的字节上限：${input.entryFileBytes}`,
    '',
    '## 当前内容',
    '',
    fileSections,
    '',
    '## 历史评审证据',
    '',
    renderEvidenceDigest(input.evidence),
    '',
    '## 输出',
    '',
    '只输出 JSON。files 里只放你确实改过的文件；没改的文件不要出现在 files 里。',
  ].join('\n')

  return { system, user }
}

export interface ParsedSkillOptimization {
  summary: string
  /** 路径 → 新正文。只含真的变了的文件。 */
  files: Map<string, string>
}

export interface ParseSkillOptimizationInput {
  raw: string
  skillName: string
  currentFiles: ReadonlyMap<string, string>
  entryFileBytes: number
}

/**
 * 从模型输出里剥出 JSON。
 *
 * 模型经常把 JSON 包在 ```json 围栏里，也经常在前面加一句"好的，下面是结果"。这里接受
 * 这两种形态，但**不做任何修补**（不补引号、不删尾逗号）：修补等于猜模型想说什么，而猜错
 * 的代价是把一份没校验过的内容当成合法产出。
 */
export function extractJsonObject(raw: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw)
  const candidate = (fenced?.[1] ?? raw).trim()
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start < 0 || end <= start) {
    reject('the model output contains no JSON object')
  }
  return candidate.slice(start, end + 1)
}

export function parseSkillOptimizationOutput(
  input: ParseSkillOptimizationInput,
): ParsedSkillOptimization {
  if (typeof input.raw !== 'string' || input.raw.trim() === '') {
    reject('the model returned an empty completion')
  }

  /*
   * 剥壳与解析分成两步，`try` 只包住 `JSON.parse`。
   *
   * 写成一句 `JSON.parse(extractJsonObject(raw))` 时，`catch` 会把剥壳阶段那个更具体的
   * "输出里根本没有 JSON 对象"吞掉，统一报成"不是合法 JSON" —— 而这两种情况对运维是
   * 两回事：前者通常是模型在拒绝任务，后者是它写坏了。
   */
  const jsonText = extractJsonObject(input.raw)
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch {
    reject('the model output is not parseable JSON')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    reject('the model output is not a JSON object')
  }

  const record = parsed as Record<string, unknown>
  const summaryRaw = record.summary
  if (typeof summaryRaw !== 'string' || summaryRaw.trim() === '') {
    reject('the model output has no non-empty summary')
  }
  const filesRaw = record.files
  if (filesRaw === null || typeof filesRaw !== 'object' || Array.isArray(filesRaw)) {
    reject('the model output has no files object')
  }

  const files = new Map<string, string>()
  for (const [path, value] of Object.entries(filesRaw as Record<string, unknown>)) {
    if (!OPTIMIZABLE_PATHS.includes(path)) {
      reject(`the model tried to write a file outside the allow list: ${path}`)
    }
    if (!input.currentFiles.has(path)) {
      reject(`the model tried to write a file that the bundle does not contain: ${path}`)
    }
    if (typeof value !== 'string') {
      reject(`the model wrote a non-string body for ${path}`)
    }
    if (value.trim() === '') {
      reject(`the model wrote an empty body for ${path}`)
    }
    if (value.includes('\u0000')) {
      reject(`the model wrote a NUL byte into ${path}`)
    }
    const bytes = Buffer.byteLength(value, 'utf8')
    if (path === SKILL_ENTRY_FILE && bytes > input.entryFileBytes) {
      reject(
        `the model wrote ${bytes} bytes into ${path}, over the ${input.entryFileBytes} byte limit`,
      )
    }
    if (value === input.currentFiles.get(path)) {
      // 逐字节相同 = 什么都没改。当成成功会让管理员对着一个空 diff 找不同。
      reject(`the model returned ${path} unchanged`)
    }
    files.set(path, value)
  }

  if (files.size === 0) {
    reject('the model changed nothing')
  }

  /*
   * 入口文件的 frontmatter 在这里就校验，而不是等打包后的归档校验。
   *
   * 两处都会校验（归档校验是最终闸门），但先在这里拒能给出一条明确的错误码 ——
   * "模型输出不合规"与"归档结构不合规"是两种完全不同的处置：前者重试也许有用，
   * 后者说明我们的打包器坏了。
   */
  const entry = files.get(SKILL_ENTRY_FILE)
  if (entry !== undefined) {
    try {
      parseSkillEntryFrontmatter(entry, input.skillName)
    } catch (error) {
      if (error instanceof SkillFrontmatterError) {
        reject(`the rewritten ${SKILL_ENTRY_FILE} frontmatter is invalid: ${error.message}`)
      }
      throw error
    }
  }

  return { summary: summaryRaw.trim().slice(0, 4000), files }
}
