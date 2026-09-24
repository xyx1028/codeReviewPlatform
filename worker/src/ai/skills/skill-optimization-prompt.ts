/**
 * 技能 AI 优化的 Prompt 组装与模型输出解析。
 *
 * 这个模块刻意**不发任何网络请求**、不碰数据库、不碰文件系统：它只做"文本进、结构出"，
 * 于是它的全部行为都能用单测覆盖。真正危险的那一半（模型返回了什么、能不能信）在这里
 * 被收敛成一个 fail-closed 的解析函数。
 *
 * ## 范围：整个技能包，不只是 SKILL.md
 *
 * 模型可以改写、新增、删除**任何文本文件**（`SKILL.md`、`references/`、`templates/`、
 * `scripts/` 以及根目录下的普通文本文件）。放开到整包是产品决定：技能的知识不只写在入口
 * 文件里，只让 AI 改一个文件等于让它把所有内容硬塞进 `SKILL.md`。
 *
 * 唯一不能被模型改动的是**图片资源**（`assets/` 下的 ASSET 角色）：它们是二进制，没法用
 * 一个 JSON 字符串表达。它们的字节在重新打包时原样保留；模型只能**删除**它们。
 *
 * ## 为什么解析必须比"JSON.parse 成功"严格得多
 *
 *   * 路径是模型给的，所以 `../../etc/cron.d/x`、`a\b`、`.`/`..`、超深路径必须在**还只有
 *     一个字符串**的时候被拒 —— 这里直接复用 `canonicalizeEntryPath`，不自己写一套。
 *   * 角色与扩展名必须相符（一个躺在根目录的 `.sh` 会被归为 OTHER，然后被扩展名允许表拒掉）。
 *     这保证"脚本必须显式放进 `scripts/`"这条既有约定不会被 AI 绕过，从而必然带上
 *     `contains_scripts=true` 与发布页的额外确认。
 *   * 模型可以"顺手"把 frontmatter 的 `name` 改成别的技能名。dsh 侧注册名与平台目录名分叉
 *     是最难诊断的一类故障，所以在这里就拒。
 *   * 模型可以返回一份与原文完全相同的正文。那种"优化"没有发布价值，把它当成成功会让
 *     管理员对着一个空 diff 猜哪里变了。
 *   * 删除 `SKILL.md` 等于删掉整个技能的入口，dsh 会静默忽略它 —— 一律拒。
 */

import { canonicalizeEntryPath } from './skill-paths.js'
import { parseSkillEntryFrontmatter, SkillFrontmatterError } from './skill-frontmatter.js'
import {
  isExtensionAllowedForRole,
  mediaTypeForPath,
  requiresUtf8,
  roleForPath,
  SKILL_ENTRY_FILE,
  SKILL_ROLE_EXTENSIONS,
  type SkillFileRole,
} from './skill-manifest.js'
import type { SkillBundleLimits } from './skill-limits.js'

export const SKILL_OPTIMIZATION_OUTPUT_INVALID = 'SKILL_OPTIMIZATION_MODEL_OUTPUT_INVALID'

/**
 * 模型明确判断"不需要改"时的终态码（V1.22）。
 *
 * 它存在的理由是一个真实发生过的自相矛盾：系统提示词要求"证据不足时宁可少改"，而解析器
 * 把"没有改动"判成输出不合规，于是回灌原因重试 —— 同一份证据重试三次，答案当然一样。
 * 线上那次失败（`the model changed nothing`，model_attempts=3）就是这么来的。
 *
 * 现在"不需要改"是一条**合法出口**：不重试、不产草稿，但如实把模型给的理由写回给管理员。
 */
export const SKILL_OPTIMIZATION_NO_CHANGE_NEEDED = 'SKILL_OPTIMIZATION_NO_CHANGE_NEEDED'

/**
 * 模型可以写的文件 = 一切"要求严格 UTF-8"的角色。
 *
 * 等价于"除图片以外的全部"。用角色判定而不是维护一张路径白名单：新增一个
 * `references/x.md` 也必须落在同一套规则里，而路径白名单管不到还不存在的文件。
 */
export function isModelWritablePath(path: string): boolean {
  const role = roleForPath(path)
  return requiresUtf8(role)
}

export interface SkillEvidenceSample {
  story_code: string
  verdict: string
  summary: string
  human_review_result: string | null
  human_review_comment: string | null
}

export interface SkillEvidenceBatch {
  batch_id: string
  batch_name: string
  week_code: string | null
  job_id: string
  job_status: string | null
  job_created_at: string | null
  result_count: number
}

export interface SkillReviewEvidenceSnapshot {
  referenced_job_count: number
  /**
   * 可学习的评审结论条数（V1.22）。
   *
   * 与 `verdict_counts` 同源。`undefined` = 数据库还没升到 V1.22，调用方回退到结论分布求和。
   * 这是"能不能优化"的真实判据：`referenced_job_count` 只说明技能被冻结进过某个 Job。
   */
  review_result_count?: number
  verdict_counts: Record<string, number>
  human_review_counts: Record<string, number>
  sample_findings: SkillEvidenceSample[]
  /** 引用过这个技能的 Job 属于哪些批次。空数组 = 升级前的历史数据或确实没有引用。 */
  referenced_batches?: SkillEvidenceBatch[]
}

/** 当前包里的一个文件。文本文件带正文，图片只带元信息。 */
export interface SkillBundleFileView {
  path: string
  /** 文本文件的正文；图片为 null。 */
  text: string | null
  sizeBytes: number
  role: string
}

export interface SkillOptimizationPromptInput {
  skillName: string
  /** 当前已发布版本的全部文件。 */
  files: readonly SkillBundleFileView[]
  evidence: SkillReviewEvidenceSnapshot
  limits: SkillBundleLimits
  /**
   * 上一轮自检失败的原因。
   *
   * 它的存在就是"AI 改完必须自检、不过要继续改"的实现方式：把拒绝原因原样回灌给模型，
   * 让它自己修，而不是让管理员看着一个失败弹窗手动重试。
   */
  previousRejection?: string | null
  attempt?: number
  maxAttempts?: number
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

/**
 * 模型走了"不需要改"出口。
 *
 * 刻意**不是** `SkillOptimizationOutputError` 的子类：调用方必须能区分"输出不合规、
 * 值得回灌原因重写"与"模型看完证据后认为不该改、重试没有意义"。
 */
export class SkillOptimizationNoChangeError extends Error {
  readonly code = SKILL_OPTIMIZATION_NO_CHANGE_NEEDED

  constructor(message: string) {
    super(message)
    this.name = 'SkillOptimizationNoChangeError'
  }
}

function reject(message: string): never {
  throw new SkillOptimizationOutputError(message)
}

/**
 * 把证据摘要渲染成模型能用的文本。
 *
 * 只渲染统计、批次身份与抽样文本，不渲染 story_id / job_id / 仓库路径：模型这一次的任务是
 * 改一份技能包，给它主键除了增加提示词长度没有任何用处。
 */
export function renderEvidenceDigest(evidence: SkillReviewEvidenceSnapshot): string {
  const lines: string[] = []
  lines.push(`引用过本技能的 Analysis Job 数量：${evidence.referenced_job_count}`)
  if (typeof evidence.review_result_count === 'number') {
    lines.push(`可依据的评审结论条数：${evidence.review_result_count}`)
  }
  const batches = evidence.referenced_batches ?? []
  if (batches.length > 0) {
    lines.push('')
    lines.push('这些 Job 属于以下评审批次：')
    for (const batch of batches) {
      const week = batch.week_code === null ? '' : `（${batch.week_code}）`
      lines.push(`  - ${batch.batch_name}${week}：${batch.result_count} 条评审结论`)
    }
  }
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

/** 给模型看的当前包结构。图片只列身份，不列正文。 */
export function renderBundleInventory(files: readonly SkillBundleFileView[]): string {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return sorted
    .map((file) =>
      file.text === null
        ? `- ${file.path}（${file.role}，二进制，${file.sizeBytes} 字节，只能删除、不能改写）`
        : `- ${file.path}（${file.role}，${file.sizeBytes} 字节，可改写）`,
    )
    .join('\n')
}

function languageFence(path: string): string {
  const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  if (extension === 'md') return 'markdown'
  if (extension === 'json') return 'json'
  if (extension === 'yaml' || extension === 'yml') return 'yaml'
  if (extension === 'sh') return 'bash'
  if (extension === 'js' || extension === 'mjs' || extension === 'cjs') return 'javascript'
  return 'text'
}

/**
 * 目录 → 角色 → 允许扩展名。
 *
 * 表从 `SKILL_ROLE_EXTENSIONS` 生成，不手写：手写的那一份会和校验器慢慢分叉，而分叉的
 * 表现是"提示词说可以、结构检查说不行"，也就是让模型按一份过期的规范去写。
 */
export function renderPathSpec(): string {
  const rows: Array<[string, SkillFileRole, string]> = [
    [`${SKILL_ENTRY_FILE}（根目录，唯一入口，必须存在）`, 'ENTRY', ''],
    ['references/<名>.<扩展名>', 'REFERENCE', ''],
    ['templates/<名>.<扩展名>', 'TEMPLATE', ''],
    ['scripts/<名>.<扩展名>', 'SCRIPT', ''],
    ['assets/<名>.<扩展名>', 'ASSET', ''],
    ['根目录下的其它文件 <名>.<扩展名>', 'OTHER', ''],
  ]
  return rows
    .map(([location, role]) => {
      const extensions = SKILL_ROLE_EXTENSIONS[role].join(' / ')
      const note = role === 'ASSET' ? '（二进制，只能删除，不能改写或新增）' : ''
      return `- ${location} → 角色 ${role}，只允许扩展名：${extensions}${note}`
    })
    .join('\n')
}

/**
 * 每个可改写文件的当前大小与剩余额度。
 *
 * 给"当前多少字节"而不只给上限：模型数不出字节数，但能判断"现在 4.2 KB、上限 64 KB，
 * 我加两段没问题"。中文按最坏情况 1 字 ≈ 3 字节提示，避免它用字符数去套字节上限。
 */
export function renderBudget(
  files: readonly SkillBundleFileView[],
  limits: SkillBundleLimits,
): string {
  const expanded = files.reduce((sum, file) => sum + file.sizeBytes, 0)
  const entry = files.find((file) => file.path === SKILL_ENTRY_FILE)
  return [
    `- ${SKILL_ENTRY_FILE}：当前 ${entry?.sizeBytes ?? 0} 字节，上限 ${limits.entryFileBytes} 字节`,
    `- 单个其它文件：上限 ${limits.fileBytes} 字节`,
    `- 整包展开后：当前 ${expanded} 字节，上限 ${limits.expandedBytes} 字节`,
    `- 文件总数：当前 ${files.length} 个，上限 ${limits.entryCount} 个`,
    '- 估算方式：中文按 1 字 ≈ 3 字节、英文按 1 字符 ≈ 1 字节；不要贴近上限写。',
  ].join('\n')
}

/** 入口文件 frontmatter 里那一行 `name:` 的原文。找不到就返回 null。 */
export function findFrontmatterNameLine(entryText: string): string | null {
  const lines = entryText.split('\n')
  if (lines[0]?.trim() !== '---') return null
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (line.trim() === '---') break
    if (/^name\s*:/.test(line)) return line
  }
  return null
}

/**
 * 组装一次优化请求。
 *
 * 这是一次 `chat/completions`，不是一棵 Agent 树：任务是"读一份技能包与一份统计，写回
 * 改动后的文件"，没有工具调用、没有代码检索，也就没有理由付多 Agent 编排的代价。
 *
 * V1.22 起提示词把结构要求写成**可机械核对的契约**：目录/扩展名表由校验器的常量生成、
 * 容量给当前值与上限、给一份完整输出样例、末尾附逐条自检清单。之前的版本只用散文描述
 * 规则，然后靠"写错了再回灌原因重写"收敛 —— 那是把校验器当提示词用，既慢又烧 token。
 */
export function buildSkillOptimizationPrompt(
  input: SkillOptimizationPromptInput,
): SkillOptimizationPrompt {
  const entry = input.files.find((file) => file.path === SKILL_ENTRY_FILE)
  if (entry === undefined || entry.text === null) {
    // 拿不到入口正文 = 上游解包出了问题，不该把这种输入送去模型。
    reject(`no readable ${SKILL_ENTRY_FILE} content was supplied`)
  }
  const nameLine = findFrontmatterNameLine(entry.text)

  const example = JSON.stringify(
    {
      summary: '依据 2 条人工标为「错」的结论，在 SKILL.md 里补充了判定口径，并新增一份检查清单。',
      files: {
        [SKILL_ENTRY_FILE]: `---\nname: ${input.skillName}\ndescription: …保持或改进这句描述…\n---\n\n# …完整正文…\n`,
        'references/checklist.md': '# 检查清单\n\n- …\n',
      },
      deletedFiles: [],
    },
    null,
    2,
  )

  const system = [
    '你是代码评审平台的技能维护助手。',
    '你的任务是根据一个技能在历史评审中的真实表现，改写它的技能包内容，让后续评审少出错。',
    '',
    '你可以改写、新增、删除技能包里的任何**文本**文件；图片资源只能删除，不能改写。',
    '',
    '## 输出契约（平台按这份契约机械校验，任何一条不满足整次输出都会被拒）',
    '',
    '1. 只输出一个 JSON 对象。JSON 之外不要写任何解释、前言或 Markdown 标题。',
    '2. 形状：{"summary": string, "files": {"<路径>": "<该文件的完整新正文>"}, "deletedFiles": ["<路径>"]}',
    '   - `files` 只放你**改写或新增**的文件；没动的文件不要出现（放进去会被判为"未改动"而拒绝）。',
    '   - 每份正文必须是**整个文件的全文**，不是片段、不是 diff，不允许出现"…（省略）…"这类占位。',
    '   - `deletedFiles` 可以省略；里面只能是当前包里真实存在的路径。',
    '3. 至少要有一个改动。确实不该改时走下面的「不需要改」出口，不要返回空的 files。',
    '4. `summary` 用中文写清楚改了什么、依据哪几条评审证据，不要复述这些规则。',
    '',
    '## 路径与文件类型（这张表由校验器生成，不是建议）',
    '',
    renderPathSpec(),
    '',
    `- 路径只能是 \`/\` 分隔的相对路径，每段只允许字母、数字、\`.\`、\`_\`、\`-\`，层数不超过 ${input.limits.pathDepth}。`,
    '- 不得出现 `..`、前导 `/`、反斜杠、`./`、空目录段，也不要写成 `references//a.md` 这类非规范形式。',
    `- ${SKILL_ENTRY_FILE} 必须保留，不能删除、不能改名（删掉它 dsh 会静默忽略整个技能）。`,
    nameLine === null
      ? `- ${SKILL_ENTRY_FILE} 必须以 \`---\` 开头，YAML frontmatter 里 name 必须等于 ${input.skillName}，description 非空。`
      : `- ${SKILL_ENTRY_FILE} 必须以 \`---\` 开头，frontmatter 里这一行必须**逐字保留**：\`${nameLine}\`；description 必须非空。`,
    '- 新增 scripts/ 下的文件会让这个版本被标记为「含可执行脚本」，管理员发布时必须额外确认；',
    '  只有确实需要可执行步骤时才这么做。',
    '',
    '## 容量',
    '',
    renderBudget(input.files, input.limits),
    '',
    '## 「不需要改」出口',
    '',
    '当证据不足以支撑任何具体修改时（例如没有人工复核意见、结论里看不出技能内容的问题），',
    '输出这个形状，而不是返回空的 files：',
    '{"noChangeNeeded": true, "summary": "<中文说明为什么现在不该改，以及需要什么证据才能改>"}',
    '平台会把它作为一次明确的「本次不产出草稿」终态记录下来，不算失败重试。',
    '',
    '## 内容要求',
    '',
    '- 不要编造证据里没有的业务事实；改动必须能对应到某一条结论或人工意见。',
    '- 改 SKILL.md 时保持它仍然是一份给 Agent 看的操作说明：什么时候用、怎么判断、怎么取证。',
    '- 描述（frontmatter 的 description）决定 dsh 首轮是否会披露这个技能，可以改进，但不能写空。',
    '',
    '## 输出样例（形状示例，不要照抄内容）',
    '',
    example,
  ].join('\n')

  const textSections = input.files
    .filter((file) => file.text !== null)
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map(
      (file) =>
        `### ${file.path}\n\n\`\`\`${languageFence(file.path)}\n${file.text ?? ''}\n\`\`\``,
    )
    .join('\n\n')

  const rejectionSection =
    input.previousRejection === undefined ||
    input.previousRejection === null ||
    input.previousRejection === ''
      ? ''
      : [
          '',
          '## 上一次的输出被结构检查拒绝了，请修正后重新输出完整结果',
          '',
          `拒绝原因：${input.previousRejection}`,
          '',
          '不要只解释原因，直接给出修正后的 JSON。',
          `这是第 ${input.attempt ?? 2} 次尝试，最多 ${input.maxAttempts ?? 3} 次。`,
        ].join('\n')

  const checklist = [
    '',
    '## 输出前逐条自检（不满足就先改，再输出）',
    '',
    '1. 只有一个 JSON 对象，它之外没有任何文字。',
    '2. files 里每个路径都能在上面那张目录/扩展名表里找到对应行。',
    '3. files 里每份正文都是完整全文，没有省略号占位，没有只给改动片段。',
    '4. 没有把未改动的文件放进 files；deletedFiles 里的路径都真实存在。',
    `5. 如果改了 ${SKILL_ENTRY_FILE}：第一行是 \`---\`，name 行逐字未变，description 非空。`,
    '6. 至少有一个改动；否则改用「不需要改」出口。',
  ].join('\n')

  const user = [
    `技能名（${SKILL_ENTRY_FILE} 的 frontmatter name 必须保持这个值）：${input.skillName}`,
    '',
    '## 当前技能包结构',
    '',
    renderBundleInventory(input.files),
    '',
    '## 当前文本内容',
    '',
    textSections,
    '',
    '## 历史评审证据',
    '',
    renderEvidenceDigest(input.evidence),
    rejectionSection,
    checklist,
    '',
    '## 输出',
    '',
    '只输出 JSON。',
  ].join('\n')

  return { system, user }
}

export interface ParsedSkillOptimization {
  summary: string
  /** 路径 → 新正文。含改写与新增。 */
  files: Map<string, string>
  /** 要从包里移除的路径。 */
  deletedPaths: string[]
  /** 改动路径的并集（改写 + 新增 + 删除），排序后用于写回 `changed_paths`。 */
  changedPaths: string[]
}

export interface ParseSkillOptimizationInput {
  raw: string
  skillName: string
  /** 当前包的全部文件（含图片）。 */
  currentFiles: readonly SkillBundleFileView[]
  limits: SkillBundleLimits
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

function assertWritablePath(path: string, limits: SkillBundleLimits): void {
  let canonical: { path: string; isDirectory: boolean }
  try {
    canonical = canonicalizeEntryPath(path, limits)
  } catch (error) {
    reject(`the model used an unacceptable file path "${path}": ${(error as Error).message}`)
  }
  if (canonical.isDirectory) {
    reject(`the model wrote to a directory path: ${path}`)
  }
  if (canonical.path !== path) {
    // 归一化后不等于原样 = 模型给了一个"看起来一样但不是"的路径。不静默采用归一化结果：
    // 那会让 diff 里显示的路径与它声明的路径不同。
    reject(`the model used a non-canonical file path: ${path}`)
  }
  const role = roleForPath(path)
  if (!requiresUtf8(role)) {
    reject(`the model cannot write binary content; refusing ${path} (role ${role})`)
  }
  if (!isExtensionAllowedForRole(path, role)) {
    reject(`file type is not allowed for its role (${role}): ${path}`)
  }
  if (mediaTypeForPath(path) === null) {
    reject(`unknown media type: ${path}`)
  }
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

  /*
   * 「不需要改」出口（V1.22）。
   *
   * 在校验 files 之前判断：走这条出口时 files 本来就该缺席或为空，先去查 files 只会把它
   * 判成"没有 files 对象"，把一个明确的产品结论报成格式错误。
   */
  if (record.noChangeNeeded === true || record.no_change_needed === true) {
    throw new SkillOptimizationNoChangeError(summaryRaw.trim().slice(0, 1000))
  }

  const filesRaw = record.files
  if (filesRaw === null || typeof filesRaw !== 'object' || Array.isArray(filesRaw)) {
    reject('the model output has no files object')
  }

  const current = new Map(input.currentFiles.map((file) => [file.path, file]))
  const files = new Map<string, string>()

  for (const [path, value] of Object.entries(filesRaw as Record<string, unknown>)) {
    assertWritablePath(path, input.limits)
    if (typeof value !== 'string') {
      reject(`the model wrote a non-string body for ${path}`)
    }
    if (value.trim() === '') {
      reject(`the model wrote an empty body for ${path}`)
    }
    if (value.includes('\u0000')) {
      reject(`the model wrote a NUL byte into ${path}`)
    }
    // 孤立代理项会被 Buffer 静默替换成 U+FFFD，于是落盘内容与模型说的不一致。
    if (/[\uD800-\uDFFF]/.test(value.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ''))) {
      reject(`the model wrote an unpaired surrogate into ${path}`)
    }
    const bytes = Buffer.byteLength(value, 'utf8')
    if (bytes > input.limits.fileBytes) {
      reject(`the model wrote ${bytes} bytes into ${path}, over the per-file limit`)
    }
    if (path === SKILL_ENTRY_FILE && bytes > input.limits.entryFileBytes) {
      reject(
        `the model wrote ${bytes} bytes into ${path}, over the ${input.limits.entryFileBytes} byte limit`,
      )
    }
    const existing = current.get(path)
    if (existing !== undefined && existing.text === value) {
      // 逐字节相同 = 什么都没改。当成改动会让管理员对着一个空 diff 找不同。
      reject(`the model returned ${path} unchanged; omit unchanged files from "files"`)
    }
    files.set(path, value)
  }

  const deletedRaw = record.deletedFiles ?? record.deleted_files ?? []
  if (!Array.isArray(deletedRaw)) {
    reject('the model output has a non-array deletedFiles')
  }
  const deletedPaths: string[] = []
  for (const entry of deletedRaw) {
    if (typeof entry !== 'string') {
      reject('the model listed a non-string path in deletedFiles')
    }
    if (entry === SKILL_ENTRY_FILE) {
      // 删掉入口 = dsh 静默忽略整个技能，磁盘上文件都在但模型看不见它。
      reject(`refusing to delete ${SKILL_ENTRY_FILE}; it is the skill entry point`)
    }
    if (!current.has(entry)) {
      reject(`the model tried to delete a file the bundle does not contain: ${entry}`)
    }
    if (files.has(entry)) {
      reject(`the model both rewrote and deleted ${entry}`)
    }
    if (deletedPaths.includes(entry)) {
      reject(`the model listed ${entry} twice in deletedFiles`)
    }
    deletedPaths.push(entry)
  }

  if (files.size === 0 && deletedPaths.length === 0) {
    // 提示里带上出口写法：这条拒绝原因会被回灌给模型，光说"你什么都没改"它只会再猜一次。
    reject(
      'the model changed nothing; if no change is warranted, return '
        + '{"noChangeNeeded": true, "summary": "<why>"} instead of an empty files object',
    )
  }

  // 容量：按改动后的最终集合算，而不是只看单个文件。
  let expanded = 0
  let count = 0
  for (const file of input.currentFiles) {
    if (deletedPaths.includes(file.path)) continue
    if (files.has(file.path)) continue
    expanded += file.sizeBytes
    count += 1
  }
  for (const [, value] of files) {
    expanded += Buffer.byteLength(value, 'utf8')
    count += 1
  }
  if (count > input.limits.entryCount) {
    reject(`the resulting bundle would contain ${count} files, over the limit`)
  }
  if (expanded > input.limits.expandedBytes) {
    reject(`the resulting bundle would expand to ${expanded} bytes, over the limit`)
  }

  /*
   * 入口文件的 frontmatter 在这里就校验，而不是等打包后的归档校验。
   *
   * 两处都会校验（归档校验是最终闸门），但先在这里拒能给出一条明确的错误码 ——
   * "模型输出不合规"与"归档结构不合规"是两种完全不同的处置：前者回灌原因让模型自己修，
   * 后者说明我们的打包器坏了。
   */
  const entryText = files.get(SKILL_ENTRY_FILE) ?? current.get(SKILL_ENTRY_FILE)?.text ?? null
  if (entryText === null) {
    reject(`the resulting bundle has no ${SKILL_ENTRY_FILE}`)
  }
  try {
    parseSkillEntryFrontmatter(entryText, input.skillName)
  } catch (error) {
    if (error instanceof SkillFrontmatterError) {
      reject(`the rewritten ${SKILL_ENTRY_FILE} frontmatter is invalid: ${error.message}`)
    }
    throw error
  }

  const changedPaths = [...new Set([...files.keys(), ...deletedPaths])].sort()
  return { summary: summaryRaw.trim().slice(0, 4000), files, deletedPaths, changedPaths }
}
