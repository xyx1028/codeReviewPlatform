/**
 * 只读查询工具（V1.60）。
 *
 * 为什么要有这几个：提交一次评审需要填 4 个参数，而调用方的模型**看不到平台页面上的下拉框**。
 * 它不知道有哪些项目组（上游压根没有"列出工作区"的端点）、不知道代码基线只有三个值、
 * 也不知道提交时间窗口只能取 7/14/21/28。不给它查的途径，它就只能猜 —— 那次把
 * 「工具开发组」说成「工具组」的事故，根子就在这里。
 *
 * 三个工具都**只读**：不建批次、不消耗模型额度、不写任何表。
 */

import {
  DEFAULT_BRANCH,
  DEFAULT_COMMIT_WINDOW_DAYS,
  DEFAULT_TIME_ZONE,
  MAX_STORIES_PER_SUBMIT,
  SUPPORTED_BRANCHES,
  SUPPORTED_COMMIT_WINDOWS,
} from './config.mjs'
import { LINKY_WORKSPACE_PRESETS, filterWorkspaces } from './workspaces.mjs'
import { buildWeekCode } from './review.mjs'

export const LIST_WORKSPACES_TOOL = 'list_workspaces'
export const SEARCH_REQUIREMENTS_TOOL = 'search_requirements'
export const DESCRIBE_OPTIONS_TOOL = 'describe_submit_options'

/**
 * 需求查询翻多少页上游列表（每页 200，V1.67）。
 *
 * 5 页＝1000 条。为什么不是默认的 2 页：发布窗口与关键字的过滤都在**本地**做
 * （上游 `GET /stories` 只认 workspace_name / assignee_name / page / page_size），
 * 只取回 400 条就意味着第 3 页之后的需求永远筛不出来，而返回看起来是正常的"0 条"。
 *
 * 代价是最坏多翻 3 页（每页实测约 1.05 秒，即约 3 秒）。实际只在组真的很大时才会翻满 ——
 * `listStories` 收集满 `total` 就停。
 */
export const SEARCH_MAX_PAGES = 5

/** 代码基线的人话说明。与平台「代码问答」页上的用词保持一致。 */
export const BRANCH_LABELS = {
  feature_dev: '开发分支（最新，可能还没测过）',
  feature_sit: '集成测试分支',
  release: '发布分支（最接近线上）',
}

export const LIST_WORKSPACES_DEFINITION = {
  name: LIST_WORKSPACES_TOOL,
  title: '列出可用的项目组（只读）',
  description:
    '列出平台已知的项目组（Linky workspace）名称，可按关键字模糊筛选。\n\n' +
    '**只读，不消耗模型额度。** 用户只说了项目组的简称或说不全时用它，例如用户说"工具组"，' +
    '用它查关键字"工具"会得到真实名称"工具开发组"。上游按名称**精确匹配**，名字差一个字就会' +
    '查不到任何需求，所以**不要凭印象拼名字**。\n\n' +
    '注意：提交评审其实**不需要**项目组 —— start_requirement_review 只要需求编号就能反查出' +
    '它真正属于哪个组。这个工具主要用于 search_requirements（按组找需求）。',
  inputSchema: {
    type: 'object',
    properties: {
      keyword: {
        type: 'string',
        maxLength: 64,
        description: '模糊筛选关键字，可选。留空返回全部。例如「工具」「灵基」「前端」。',
      },
    },
    required: [],
    additionalProperties: false,
  },
  annotations: {
    title: '列出可用的项目组（只读）',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
}

export const SEARCH_REQUIREMENTS_DEFINITION = {
  name: SEARCH_REQUIREMENTS_TOOL,
  title: '按项目组查需求列表（只读）',
  description:
    '列出某个项目组下的需求：编号、标题、状态、负责人、迭代、发布窗口、关联特性。\n\n' +
    '**只读，不消耗模型额度。** 用户只说了需求的名字或大致内容、没给编号时用它找到编号，' +
    '再用 start_requirement_review 提交。\n\n' +
    '**可以按发布窗口筛**（release_window，例如 R20261106）—— 用户说"评审这个窗口的需求"' +
    '时就用它；上游没有这个过滤参数，是平台取回整组后帮你筛的。不知道窗口怎么写就先不填：' +
    '返回里会列出这个组实际有哪些发布窗口、各多少条，再按用户要的那个重查一次。\n\n' +
    '必须指定项目组：上游跨项目组查询会先汇总再分页，很慢（实测 15 秒）；指定组只要 1 秒。' +
    '不知道项目组全名就先用 list_workspaces。\n\n' +
    '拿到编号后可以一次把多条交给 start_requirement_review 的 story_codes（最多 20 条，' +
    '同一个项目组），它们会进入同一个批次。',
  inputSchema: {
    type: 'object',
    properties: {
      workspace_name: {
        type: 'string',
        minLength: 1,
        maxLength: 128,
        description:
          '项目组完整名称（精确匹配）。不确定就先调 list_workspaces，不要凭印象拼。',
      },
      release_window: {
        type: 'string',
        maxLength: 64,
        description:
          '按发布窗口过滤，可选，例如 R20261106。精确匹配（忽略首尾空白与大小写），' +
          '不要填"下周"这类说法。留空则不按窗口筛，并在返回里列出该组实际有哪些窗口。',
      },
      keyword: {
        type: 'string',
        maxLength: 128,
        description: '按编号或标题过滤，可选。不区分大小写的子串匹配（**不**匹配发布窗口）。',
      },
      assignee_name: {
        type: 'string',
        maxLength: 64,
        description: '按需求负责人姓名过滤（上游精确匹配），可选。',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 100,
        description:
          '最多返回多少条，默认 20；指定了 release_window 时默认 100' +
          '（按窗口查本来就是想看那个窗口的全部需求）。过滤后的总条数会一并告知。',
      },
    },
    required: ['workspace_name'],
    additionalProperties: false,
  },
  annotations: {
    title: '按项目组查需求列表（只读）',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
}

export const DESCRIBE_OPTIONS_DEFINITION = {
  name: DESCRIBE_OPTIONS_TOOL,
  title: '查提交评审的可选参数（只读）',
  description:
    '返回提交一次评审时每个参数的合法取值：代码基线（目标分支）有哪几个及各自含义、' +
    '提交时间窗口有哪几个、发布周期的格式与默认值、评审模型（由服务端配置，调用方不能指定）。\n\n' +
    '**只读，不消耗模型额度。** 不确定某个参数该填什么时先调它，不要猜。',
  inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  annotations: {
    title: '查提交评审的可选参数（只读）',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
}

function textOf(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/** 项目组清单的文本。明确区分"清单里的"和"清单外也能用"。 */
export function formatWorkspaceList(keyword, matches) {
  const lines = []
  const needle = String(keyword ?? '').trim()
  if (matches.length === 0) {
    lines.push(`没有项目组匹配「${needle}」。`)
    lines.push('')
    lines.push(`平台已知的项目组共 ${LINKY_WORKSPACE_PRESETS.length} 个：`)
    for (const name of LINKY_WORKSPACE_PRESETS) lines.push(`  · ${name}`)
    lines.push('')
    lines.push('如果用户给的是确切的完整名称，即使不在上面这份清单里也可以直接使用。')
    return lines.join('\n')
  }
  lines.push(
    needle === ''
      ? `平台已知的项目组共 ${matches.length} 个：`
      : `匹配「${needle}」的项目组（共 ${matches.length} 个，最可能的在最前）：`,
  )
  for (const name of matches) lines.push(`  · ${name}`)
  lines.push('')
  lines.push('上游按名称**精确匹配**，请原样使用上面的名称，不要改写或简写。')
  lines.push(
    '这份清单是人工维护的（上游没有"列出工作区"的端点），未收录的组只要名称完整也能直接用。',
  )
  return lines.join('\n')
}

/** 发布窗口分布的文本。最多列 12 个 —— 再多就不是"告诉你有哪些"而是另一张表了。 */
function facetLines(facet, { max = 12 } = {}) {
  const lines = ['这个项目组实际有这些发布窗口（新的在前）：']
  for (const entry of facet.windows.slice(0, max)) {
    lines.push(`  · ${entry.window}（${entry.count} 条）`)
  }
  if (facet.windows.length > max) {
    lines.push(`  …另有 ${facet.windows.length - max} 个更早的窗口未列出`)
  }
  if (facet.missing > 0) {
    // 这一句不能省：它们确实在这个组里，但不属于任何窗口，按窗口筛永远筛不到。
    lines.push(`  （另有 ${facet.missing} 条需求没有填发布窗口，按窗口筛不会出现）`)
  }
  return lines
}

/** 需求列表的文本。条数受限时如实说还有多少没显示。 */
export function formatRequirementList({
  workspaceName,
  keyword,
  assigneeName,
  releaseWindow,
  rows,
  matched,
  limit,
  complete,
  total,
  facet = null,
}) {
  const lines = []
  const window = textOf(releaseWindow)
  const filters = [
    window ? `发布窗口「${window}」` : null,
    keyword ? `标题/编号含「${keyword}」` : null,
    assigneeName ? `负责人「${assigneeName}」` : null,
  ].filter((item) => item !== null)
  lines.push(
    `项目组「${workspaceName}」${filters.length > 0 ? `（${filters.join('，')}）` : ''}` +
      `共 ${matched} 条需求${matched > rows.length ? `，下面列出前 ${rows.length} 条` : ''}：`,
  )
  lines.push('')
  if (rows.length === 0) {
    lines.push('  （没有符合条件的需求）')
    lines.push('')
    if (total === 0) {
      lines.push(
        '这个项目组在上游没有返回任何需求 —— 名称可能不完全一致（上游按名称精确匹配）。' +
          '可以用 list_workspaces 确认真实名称。',
      )
      return lines.join('\n')
    }
    if (window !== null && facet !== null) {
      // 0 命中时最该回答的是"那到底有哪些窗口"，而不是让人再猜一次写法。
      lines.push(`这个项目组里没有发布窗口为「${window}」的需求。`)
      lines.push('')
      lines.push(...facetLines(facet))
      lines.push('')
      lines.push('请和用户确认是哪一个窗口，再用上面列出的原样取值重查。')
      return lines.join('\n')
    }
    lines.push('换个关键字或去掉负责人过滤再试。')
    return lines.join('\n')
  }
  for (const row of rows) {
    lines.push(`  · ${row.code}  ${row.title}`)
    const meta = [
      row.status ? `状态 ${row.status}` : null,
      row.assignee ? `负责人 ${row.assignee}` : null,
      row.iteration ? `迭代 ${row.iteration}` : null,
      row.release_window ? `发布窗口 ${row.release_window}` : null,
    ].filter((item) => item !== null)
    if (meta.length > 0) lines.push(`      ${meta.join(' · ')}`)
    if (row.subject) lines.push(`      关联特性 ${row.subject}`)
  }
  lines.push('')
  if (matched > rows.length) {
    lines.push(`还有 ${matched - rows.length} 条未显示，可以加 keyword 收窄或调大 limit（最多 100）。`)
  }
  if (complete !== true) {
    lines.push(
      `注意：上游报总数 ${total} 条，这次没有翻完全部分页，所以"没找到"不等于"不存在"。`,
    )
  }
  // 没按窗口筛时顺手把窗口分布给出来：使用者下一句常常就是"那某个窗口的呢"。
  if (window === null && facet !== null && facet.windows.length > 0) {
    lines.push('')
    lines.push(...facetLines(facet))
    lines.push('可以带 release_window 再查一次，只看某一个窗口的需求。')
  }
  // 上面几段都是条件性的，一条都没触发时不要再多留一个空行。
  if (lines[lines.length - 1] !== '') lines.push('')
  lines.push(
    '拿到编号后用 start_requirement_review 提交（项目组可以不填，平台会按编号反查）。' +
      '多条可以一次提交：story_codes 传编号列表，最多 20 条，它们会进入同一个批次。',
  )
  return lines.join('\n')
}

/** 提交参数说明。刻意把"模型不开放给调用方"写进来。 */
export function formatSubmitOptions({
  modelLabel,
  timeZone = DEFAULT_TIME_ZONE,
  defaultBranch = DEFAULT_BRANCH,
  defaultCommitWindowDays = DEFAULT_COMMIT_WINDOW_DAYS,
}) {
  const today = buildWeekCode(new Date(), { timeZone })
  const year = Number(today.slice(0, 4))
  return [
    '提交一次评审（start_requirement_review）各参数的合法取值：',
    '',
    'story_code（需求编号）/ story_codes（需求编号列表）二选一，至少给一个',
    '  形如 US-2026-017341 或 F-123456，也接受 issue UUID。不要填需求标题。',
    '  只给编号就够了 —— 平台会按它反查出所属项目组。',
    `  **要同时评审多条就用 story_codes**（数组，最多 ${MAX_STORIES_PER_SUBMIT} 条）：`,
    '  它们会进入同一个批次、共享同一份代码快照，只确认一次、只回一张回执。',
    '  多条必须属于同一个项目组（一张需求导入单只有一个项目组）；跨组会被拒绝并逐条告知归属。',
    '  不知道编号时用 search_requirements 按项目组找（可按发布窗口 release_window 筛，' +
    '不知道窗口怎么写就先不填，返回里会列出该组实际有哪些窗口）。',
    '',
    `branch（代码基线）可选，默认 ${defaultBranch}：`,
    ...SUPPORTED_BRANCHES.map(
      (branch) =>
        `  · ${branch}：${BRANCH_LABELS[branch] ?? ''}${branch === defaultBranch ? '  ← 默认' : ''}`,
    ),
    '',
    `commit_window_days（提交时间窗口，天）可选，默认 ${defaultCommitWindowDays}；` +
      `只能是：${SUPPORTED_COMMIT_WINDOWS.join(' / ')}`,
    '  含义：向前追溯多少天的提交，作为这条需求的精准提交范围。',
    '',
    'release_cycle（发布周期）可选',
    `  8 位 YYYYMMDD，默认当天（${today}）。必须是真实存在的日期，` +
      `年份需在 ${year - 2} ~ ${year + 3} 之间。`,
    '',
    'workspace_name（项目组）可选',
    '  平台按需求编号反查，填错会被纠正。不确定时**不要填、也不要猜**。',
    '',
    `评审模型：由服务端配置为「${modelLabel ?? '（服务端未指定，平台只有一个可用模型时自动选用）'}」，`,
    '  调用方不能指定 —— 它决定成本与结论质量，而远程调用方看不到平台的模型配置。',
    '',
    `代码基线与提交时间窗口有默认值（${defaultBranch} + ${defaultCommitWindowDays} 天），`,
    '  但**不会被静默套用**：第一次调用返回的确认卡片上会标明哪些值用了默认、还能选什么，',
    '  由用户看过之后才可能提交。用户要改就带上他指定的值重新调一次。',
    '提交分两步：第一次调用只核对并返回确认卡片，用户确认后带 confirmation_token 再调一次。',
  ].join('\n')
}

/** 列表项 → 展示行。只取展示需要的标量。 */
export function toRequirementRow(raw) {
  if (typeof raw !== 'object' || raw === null) return null
  const code = textOf(raw.code)
  if (code === null) return null
  return {
    code,
    title: textOf(raw.title) ?? code,
    status: textOf(raw.status),
    assignee: textOf(raw.assignee),
    iteration: textOf(raw.iteration),
    release_window: textOf(raw.release_window),
    subject: textOf(raw.subject),
  }
}

/** 按关键字过滤（编号或标题子串，不区分大小写）。 */
export function filterRequirements(rows, keyword) {
  const needle = String(keyword ?? '').trim().toLowerCase()
  if (needle === '') return rows
  return rows.filter(
    (row) =>
      row.code.toLowerCase().includes(needle) || row.title.toLowerCase().includes(needle),
  )
}

/**
 * 按发布窗口过滤（V1.67）。
 *
 * **精确匹配**，只忽略首尾空白与大小写。不做子串匹配是刻意的：窗口值形如 `R20261106`，
 * 子串会让 `R2026` 命中整年的窗口，而使用者说的是某一个窗口 —— 多匹配出来的那些需求
 * 会被原样提交去评审，每条都是真金白银。
 *
 * 上游没有这个过滤参数（`GET /stories` 只认 workspace_name / assignee_name / page /
 * page_size），所以只能取回整组在本地筛 —— 这也是这条路径要多翻几页的原因。
 */
export function filterByReleaseWindow(rows, releaseWindow) {
  const wanted = String(releaseWindow ?? '').trim().toLowerCase()
  if (wanted === '') return rows
  return rows.filter((row) => String(row.release_window ?? '').trim().toLowerCase() === wanted)
}

/**
 * 发布窗口分布：窗口 → 条数，倒序（新窗口在前）。
 *
 * 必须有：平台页面上那是个下拉框，而 MCP 调用方的模型看不到它。不给它查的途径，
 * 它就只能猜窗口怎么写 —— `R20261106` 猜错一个字符的结果是"0 条"，而那看起来
 * 和"这个窗口确实没有需求"一模一样。
 *
 * 没有发布窗口的需求单独计数，不并进任何窗口：它们确实存在，但不属于任何窗口。
 */
export function releaseWindowFacet(rows) {
  const counts = new Map()
  let missing = 0
  for (const row of rows) {
    const value = textOf(row.release_window)
    if (value === null) {
      missing += 1
      continue
    }
    counts.set(value, (counts.get(value) ?? 0) + 1)
  }
  return {
    windows: [...counts.entries()]
      .map(([window, count]) => ({ window, count }))
      .sort((a, b) => b.window.localeCompare(a.window)),
    missing,
  }
}
