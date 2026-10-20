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
  SUPPORTED_BRANCHES,
  SUPPORTED_COMMIT_WINDOWS,
} from './config.mjs'
import { LINKY_WORKSPACE_PRESETS, filterWorkspaces } from './workspaces.mjs'
import { buildWeekCode } from './review.mjs'

export const LIST_WORKSPACES_TOOL = 'list_workspaces'
export const SEARCH_REQUIREMENTS_TOOL = 'search_requirements'
export const DESCRIBE_OPTIONS_TOOL = 'describe_submit_options'

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
    '必须指定项目组：上游跨项目组查询会先汇总再分页，很慢（实测 15 秒）；指定组只要 1 秒。' +
    '不知道项目组全名就先用 list_workspaces。',
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
      keyword: {
        type: 'string',
        maxLength: 128,
        description: '按编号或标题过滤，可选。不区分大小写的子串匹配。',
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
        description: '最多返回多少条，默认 20。过滤后的总条数会一并告知。',
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

/** 需求列表的文本。条数受限时如实说还有多少没显示。 */
export function formatRequirementList({ workspaceName, keyword, assigneeName, rows, matched, limit, complete, total }) {
  const lines = []
  const filters = [
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
    lines.push(
      total === 0
        ? '这个项目组在上游没有返回任何需求 —— 名称可能不完全一致（上游按名称精确匹配）。' +
          '可以用 list_workspaces 确认真实名称。'
        : '换个关键字或去掉负责人过滤再试。',
    )
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
  lines.push('拿到编号后用 start_requirement_review 提交（项目组可以不填，平台会按编号反查）。')
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
    'story_code（需求编号）必填',
    '  形如 US-2026-017341 或 F-123456，也接受 issue UUID。不要填需求标题。',
    '  只给编号就够了 —— 平台会按它反查出所属项目组。',
    '  不知道编号时用 search_requirements 按项目组找。',
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
