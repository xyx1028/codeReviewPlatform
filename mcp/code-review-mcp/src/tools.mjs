/**
 * 工具清单与实现。
 *
 * 工具描述是写给**对方客户端里的模型**看的，所以每一条都写清：会不会花钱、要多久、
 * 成功之后该做什么、不该做什么。描述含糊的后果不是报错，而是模型拿错参数反复重试，
 * 每次重试都真的在平台上建一个批次、排一次评审。
 *
 * V1.56 的两个变化，都是为了修一个真实事故（使用者把项目组说成「工具组」，真名是
 * 「工具开发组」，于是批次建好了、回执说"已成功受理"、几十秒后导入全失败）：
 *
 *   1. `workspace_name` 从必填改为可选 —— 项目组可以由需求编号反查，不该要求使用者背名字。
 *   2. 提交加了**确认门禁**：没有确认令牌时不建批次，只回"将要评审的需求"卡片与令牌。
 *      门禁做在服务端而不是写在描述里，因为描述约束不了模型的实际行为。
 */

import { PlatformError } from './platform.mjs'
import {
  SubmissionStateUnknownError,
  assertBranch,
  assertCommitWindow,
  normalizeStoryCodes,
  submitRequirementReview,
} from './review.mjs'
import {
  formatConfirmationCard,
  formatPreflightRejection,
  formatSubmissionFailure,
  formatSubmissionReceipt,
  formatSubmissionUnknown,
} from './format.mjs'
import {
  PREFLIGHT_REJECTED,
  PREFLIGHT_VERIFIED,
  preflightReleaseWindow,
  preflightRequirement,
  preflightRequirements,
} from './preflight.mjs'
import { ConfirmationError } from './confirm.mjs'
import { formatSchemaViolations, validateAgainstSchema } from './schema.mjs'
import {
  DESCRIBE_OPTIONS_DEFINITION,
  DESCRIBE_OPTIONS_TOOL,
  LIST_WORKSPACES_DEFINITION,
  LIST_WORKSPACES_TOOL,
  SEARCH_MAX_PAGES,
  SEARCH_REQUIREMENTS_DEFINITION,
  SEARCH_REQUIREMENTS_TOOL,
  filterByReleaseWindow,
  filterRequirements,
  formatRequirementList,
  formatSubmitOptions,
  formatWorkspaceList,
  releaseWindowFacet,
  toRequirementRow,
} from './query-tools.mjs'
import { filterWorkspaces } from './workspaces.mjs'
import {
  DEFAULT_BRANCH,
  DEFAULT_COMMIT_WINDOW_DAYS,
  MAX_STORIES_PER_SUBMIT,
  MAX_STORIES_PER_WINDOW,
  PREFLIGHT_CONCURRENCY,
  SUPPORTED_BRANCHES,
  SUPPORTED_COMMIT_WINDOWS,
} from './config.mjs'

export const TOOL_NAME = 'start_requirement_review'
export const LOOKUP_TOOL_NAME = 'lookup_requirement'

const STORY_CODE_DESCRIPTION =
  '需求编号，例如 US-2026-017341 或 F-123456。平台会按它反查需求所属项目组。' +
  '也接受 issue UUID 与 PREFIX-NUMBER 形式。不要填需求标题或中文名。'

const STORY_CODES_DESCRIPTION =
  `一次要评审的需求编号列表（1~${MAX_STORIES_PER_SUBMIT} 条），例如 ` +
  '["US-2026-042423","US-2026-042424"]。**要同时评审多条需求就用这个参数**，' +
  '它们会进入同一个批次、共享同一份代码快照，只需要确认一次。\n\n' +
  '只有一条时用 story_code 更简单（两个参数给任意一个即可，都给就取并集）。\n\n' +
  '这些需求必须属于**同一个项目组**：一张需求导入单只有一个项目组，平台页面上的导入' +
  '也是这个规则。编号分属不同组时平台会拒绝提交，并告诉你每一条实际属于哪个组。'

/**
 * 需求编号的形状约束。
 *
 * 上游接受三种写法（issue UUID / PREFIX-NUMBER / 格式化编码 US-2026-0042），它们的共同点
 * 是只含字母数字和连字符。卡在这一层的价值很实际：模型有时会把**需求标题**填进 story_code，
 * 那种值带空格和中文，上游只会回一个 404「未找到用户故事」，而真正的问题是参数填错了位置。
 */
const STORY_CODE_PATTERN = '^[A-Za-z0-9][A-Za-z0-9_-]{1,63}$'

export const LOOKUP_TOOL_DEFINITION = {
  name: LOOKUP_TOOL_NAME,
  title: '查询需求信息（只读，不提交、不花钱）',
  description:
    '按需求编号从 Linky 查出这条需求的真实信息：名称、**所属项目组**、状态、迭代、发布窗口、' +
    '需求/开发/测试负责人、有没有正文和附件。\n\n' +
    '**这个工具只读，不会创建评审、不消耗模型额度。** 用户说要评审某条需求时，先用它把信息查准，' +
    '把查到的内容告诉用户、请他确认，再用返回的 confirmation_token 调用 ' +
    'start_requirement_review 提交。\n\n' +
    '不知道项目组叫什么时**不要猜**：只给 story_code 就行，项目组由平台反查。' +
    '如果用户说的项目组名和实际不一致，这个工具会明确指出来。',
  inputSchema: {
    type: 'object',
    properties: {
      story_code: {
        type: 'string',
        minLength: 1,
        maxLength: 64,
        pattern: STORY_CODE_PATTERN,
        description: `${STORY_CODE_DESCRIPTION}必填，一次一条 —— 这个工具只查一条需求；要一次提交多条评审用 start_requirement_review 的 story_codes。`,
      },
      workspace_name: {
        type: 'string',
        description:
          '用户说的项目组名称，可选。填了会和实际值核对并在不一致时指出；不确定时不要填。',
      },
      branch: {
        type: 'string',
        enum: SUPPORTED_BRANCHES,
        description: '代码基线，可选。不填按默认值（release）展示在确认卡片上。',
      },
      commit_window_days: {
        type: 'integer',
        enum: SUPPORTED_COMMIT_WINDOWS,
        description: '提交时间窗口（天），可选。不填按默认值（14）展示在确认卡片上。',
      },
    },
    required: ['story_code'],
    additionalProperties: false,
  },
  annotations: {
    title: '查询需求信息（只读）',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
}

export const TOOL_DEFINITION = {
  name: TOOL_NAME,
  title: '提交指定需求的代码评审',
  description:
    '把公司内任意一条需求提交到「需求开发评审一致性平台」做"需求 ↔ 代码一致性"评审。' +
    '不限制需求负责人，任何需求编号都可以提交。\n\n' +
    '平台受理后会在内网侧冻结需求正文与附件、按目标分支冻结各仓库代码快照，再由评审 Agent ' +
    '读代码给出结论（已实现/部分实现/未实现、缺失内容、风险、测试要点、代码证据）。' +
    '评审模型由服务端配置，调用方不需要也不能指定。\n\n' +
    '**提交分两步，这是强制的。** 第一次调用（不带 confirmation_token）**不会创建任何评审**，' +
    '它返回平台从 Linky 查到的真实需求信息、本次将要使用的参数，以及一个 confirmation_token。' +
    '你必须把那些内容告诉用户、等他确认，再带上 confirmation_token 调用第二次才真正提交。' +
    '用户没有明确同意之前不要自行带令牌提交。\n\n' +
    `**可以一次提交多条需求**：用 story_codes 给编号列表（最多 ${MAX_STORIES_PER_SUBMIT} 条），` +
    '它们会进入**同一个批次**、共享同一份代码快照，只需要确认一次，回执也只有一张。' +
    '不要为了评审多条需求反复调用本工具 —— 那会在平台上建出多个各含一条需求的批次。' +
    '多条需求必须属于同一个项目组，否则平台会拒绝提交并告诉你每条实际属于哪个组。\n\n' +
    '**要评审"某个项目组某个发布窗口的全部需求"**：给 workspace_name + release_window 即可，' +
    `不用自己把编号一个个抄出来（最多 ${MAX_STORIES_PER_WINDOW} 条）。平台会枚举那个窗口下的` +
    '全部需求，第一次调用把它们逐条列在确认卡片上；用户确认后第二次调用**只带 ' +
    'confirmation_token** 就行，不必回传那些编号。令牌锁定的是刚才列出的那一组需求，' +
    '不是"这个窗口"这个条件。\n\n' +
    '**代码基线与提交时间窗口可以不填**：默认 release + 14 天。第一次调用的返回里会写明' +
    '哪些值用了默认、以及还能选什么。用户要改的话，带上他指定的值重新调用第一次' +
    '（旧令牌会失效，需要重新确认）。\n\n' +
    '**这是异步提交，会真实消耗模型额度**（按需求条数计）。受理并落库后立刻返回，' +
    '不等待导入与评审完成。\n\n' +
    '成功后请把返回的批次编号、受理编号和平台详情链接完整转述给用户，提示他去平台查看进度与结果，' +
    '然后结束本次提交流程：本服务不提供进度查询、结果查询或轮询，不要再次调用本工具查状态，' +
    '也不要为同一条需求重复提交。失败时返回明确原因，此时平台上没有创建任何评审，不要告诉用户已提交。',
  inputSchema: {
    type: 'object',
    properties: {
      story_code: {
        type: 'string',
        minLength: 1,
        maxLength: 64,
        pattern: STORY_CODE_PATTERN,
        description: `${STORY_CODE_DESCRIPTION}只评审一条时用它；要同时评审多条用 story_codes。`,
      },
      story_codes: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_STORIES_PER_SUBMIT,
        items: {
          type: 'string',
          minLength: 1,
          maxLength: 64,
          pattern: STORY_CODE_PATTERN,
        },
        description: STORY_CODES_DESCRIPTION,
      },
      release_window: {
        type: 'string',
        maxLength: 64,
        description:
          '发布窗口，例如 R20261106。**给了它就等于"评审这个项目组这个发布窗口下的全部需求"** ——' +
          '平台自己把该窗口下的需求枚举出来，第一次调用会把全部编号与标题列在确认卡片上，' +
          `由用户确认后再提交（最多 ${MAX_STORIES_PER_WINDOW} 条，它们进入同一个批次）。\n\n` +
          '用它时 workspace_name **必填**（枚举需要范围），而且**不要**同时给 story_code /' +
          ' story_codes —— 两种意图只能选一个，同时给会被拒绝。\n\n' +
          '精确匹配，不要填"下周"这类说法。不知道窗口怎么写就先用 search_requirements 看一眼。',
      },
      branch: {
        type: 'string',
        enum: SUPPORTED_BRANCHES,
        description:
          '代码基线：评审哪一条分支上的代码。**可选**，不填默认 release（发布分支，最接近线上）。' +
          '其余可选值：feature_dev（开发分支，最新但可能还没测过）、feature_sit（集成测试分支）。',
      },
      commit_window_days: {
        type: 'integer',
        enum: SUPPORTED_COMMIT_WINDOWS,
        description:
          '提交时间窗口（天）：向前追溯多少天的提交作为该需求的精准提交范围。' +
          '**可选**，不填默认 14 天。其余可选值：7 / 21 / 28。',
      },
      workspace_name: {
        type: 'string',
        description:
          '需求所在的项目组名称（Linky 的 workspace_name）。**可选** —— 平台会按需求编号反查，' +
          '不确定时不要填、也不要猜。填了会被核对，与实际不一致时按实际值提交并在回执里指出。',
      },
      workspace_id: {
        type: 'string',
        pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
        description: '项目组 UUID。可选，不确定时不要填。',
      },
      release_cycle: {
        type: 'string',
        pattern: '^[0-9]{8}$',
        description:
          '发布周期，8 位 `YYYYMMDD`（例如 20261020），与平台「创建评审批次」里那三个下拉拼出来的' +
          '是同一个值。可选，默认当天。必须是真实存在的日期，且在当前年份的前 2 年到后 3 年之内。',
      },
      confirmation_token: {
        type: 'string',
        minLength: 1,
        description:
          '确认令牌：由第一次调用（或 lookup_requirement）返回。' +
          '只有用户确认过需求信息之后才带上它 —— 带上它这次就会真的创建评审并消耗模型额度。',
      },
    },
    /*
     * `required` 为空不等于"什么都不用给"。
     *
     * `story_code` 与 `story_codes` 是二选一（或并用），而 JSON Schema 要表达这件事需要
     * `anyOf`/`oneOf` —— 本仓库的服务端校验器刻意只实现用得到的关键字，声明一个它不执行
     * 的约束等于对外撒谎。所以"至少给一个编号"由服务端在 normalizeStoryCodes 里判，
     * 并回一句能照着改的话（STORY_CODE_REQUIRED）。
     */
    required: [],
    additionalProperties: false,
  },
  /**
   * 标准提示位。多数客户端用它决定"要不要先问用户一句"：没有这些字段时，工具默认
   * 被当成可以自动放行的只读调用 —— 而这一个会真的建批次、排评审、花模型额度。
   */
  annotations: {
    title: '提交指定需求的代码评审',
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
}

function textResult(text, { isError = false } = {}) {
  return { content: [{ type: 'text', text }], isError }
}

export function createToolRegistry({
  client,
  config,
  logger = () => {},
  settle,
  linky = null,
  confirmations = null,
} = {}) {
  /**
   * 核对 + 签令牌。两个工具共用，保证"查"和"提交前自检"看到的是同一份事实。
   */
  async function runPreflight(request) {
    const outcome = await preflightRequirement(linky, request)
    const workspaceName =
      outcome.status === PREFLIGHT_VERIFIED
        ? outcome.resolved.workspace_name
        : (request.workspace_name ?? null)
    return { outcome, workspaceName }
  }

  /** 多条需求的核对。预算与并发见 preflightRequirements 的注释。 */
  async function runBatchPreflight(storyCodes, workspaceName) {
    const outcome = await preflightRequirements(
      linky,
      { story_codes: storyCodes, workspace_name: workspaceName },
      {
        budgetMs: config.linky?.preflightBudgetMs ?? 45_000,
        concurrency: PREFLIGHT_CONCURRENCY,
      },
    )
    return { outcome, workspaceName: outcome.workspaceName }
  }

  function issueToken({
    storyCodes,
    workspaceName,
    givenWorkspace,
    releaseWindow = null,
    branch,
    commitWindowDays,
    verification,
  }) {
    if (confirmations === null) return null
    return {
      value: confirmations.issue({
        story_codes: storyCodes,
        workspace_name: workspaceName,
        given_workspace: givenWorkspace ?? null,
        release_window: releaseWindow,
        branch,
        commit_window_days: commitWindowDays,
        verification,
      }),
      ttlMs: confirmations.ttlMs,
    }
  }

  /**
   * 套用默认的代码基线与提交时间窗口。
   *
   * 同时记下每个值**是调用方给的还是默认来的** —— 确认卡片要靠它区分"你指定的"和
   * "平台默认的"。不记的话，卡片上两种值长得一样，使用者就无从判断哪些是他自己定的。
   *
   * 两个入口（查询与提交）都走这里：如果两处各自套默认，第一步签进令牌的值和第二步
   * 算出来的"期望值"就可能不一致，于是刚确认过的提交会被自己的门禁拒掉。
   */
  function resolveSubmitParams(args) {
    const givenBranch = SUPPORTED_BRANCHES.includes(String(args.branch ?? '')) ? args.branch : null
    const givenWindow = SUPPORTED_COMMIT_WINDOWS.includes(Number(args.commit_window_days))
      ? Number(args.commit_window_days)
      : null
    // 配置里缺这两项时退到模块常量，而不是产出 undefined：undefined 会在卡片上
    // 显示成"（空）"，然后在 assertBranch 那里才炸 —— 一个本可以在此处消失的失败。
    return {
      branch: givenBranch ?? config.defaults.branch ?? DEFAULT_BRANCH,
      commitWindowDays:
        givenWindow ?? config.defaults.commitWindowDays ?? DEFAULT_COMMIT_WINDOW_DAYS,
      branchIsDefault: givenBranch === null,
      windowIsDefault: givenWindow === null,
    }
  }

  function handleListWorkspaces(args, context) {
    const keyword = String(args.keyword ?? '').trim()
    const matches = filterWorkspaces(keyword)
    logger('workspaces_listed', {
      caller: context.caller ?? null,
      keyword: keyword === '' ? null : keyword,
      matches: matches.length,
    })
    return textResult(formatWorkspaceList(keyword, matches))
  }

  function handleDescribeOptions(context) {
    logger('submit_options_described', { caller: context.caller ?? null })
    return textResult(
      formatSubmitOptions({
        modelLabel: config.defaults.modelLabel,
        timeZone: config.defaults.timeZone,
        defaultBranch: config.defaults.branch ?? DEFAULT_BRANCH,
        defaultCommitWindowDays: config.defaults.commitWindowDays ?? DEFAULT_COMMIT_WINDOW_DAYS,
      }),
    )
  }

  async function handleSearch(args, context) {
    if (linky === null) {
      return textResult(
        'MCP 服务端没有配置 Linky 取数地址（CRP_LINKY_API_BASE_URL），无法查询需求列表。' +
          '请联系 MCP 维护者。',
        { isError: true },
      )
    }
    const workspaceName = String(args.workspace_name ?? '').trim()
    const keyword = String(args.keyword ?? '').trim()
    const assigneeName = String(args.assignee_name ?? '').trim()
    const releaseWindow = String(args.release_window ?? '').trim()
    /*
     * 按窗口查时默认把 limit 提到 100。
     *
     * "这个窗口有哪些需求"的意图本来就是"全部"，默认 20 条会给出一份被截断的清单，
     * 而使用者据此以为那就是整个窗口 —— 下一步就是漏提几条需求。
     */
    const limit = Number.isInteger(args.limit)
      ? args.limit
      : releaseWindow === ''
        ? 20
        : 100

    let outcome
    try {
      outcome = await linky.listStories({
        workspaceName,
        assigneeName: assigneeName === '' ? null : assigneeName,
        // 按窗口筛必须覆盖整组才算得准：上游没有窗口过滤参数，筛是在本地做的，
        // 只翻 2 页（400 条）就意味着第 3 页之后的那些需求永远筛不到。
        maxPages: SEARCH_MAX_PAGES,
      })
    } catch (error) {
      // 查询失败如实回出，并把上游原话带上 —— 它可能是"凭据失效"这种只有维护者能处理的事。
      logger('requirements_search_failed', {
        caller: context.caller ?? null,
        workspace_name: workspaceName,
        code: error?.code ?? null,
      })
      return textResult(
        [
          `❌ 查询项目组「${workspaceName}」的需求列表失败。`,
          '',
          `原因（${error?.code ?? '未知'}）：${String(error?.message ?? error)}`,
          '',
          error?.code === 'LINKY_UPSTREAM_AUTH_FAILED'
            ? '这不是你的网络问题：需要质量执行平台的维护者在「配置 › Linky 工作区」更新 token。'
            : '可以先用 list_workspaces 确认项目组名称是否完整正确。',
        ].join('\n'),
        { isError: true },
      )
    }

    const rows = outcome.items.map(toRequirementRow).filter((row) => row !== null)
    // 分布基于**窗口过滤之前**的集合：它要回答"有哪些窗口"，用筛完的集合算等于自问自答。
    const facet = releaseWindowFacet(rows)
    const filtered = filterByReleaseWindow(filterRequirements(rows, keyword), releaseWindow)
    logger('requirements_searched', {
      caller: context.caller ?? null,
      workspace_name: workspaceName,
      keyword: keyword === '' ? null : keyword,
      assignee_name: assigneeName === '' ? null : assigneeName,
      release_window: releaseWindow === '' ? null : releaseWindow,
      upstream_total: outcome.total,
      matched: filtered.length,
    })
    return textResult(
      formatRequirementList({
        workspaceName,
        keyword,
        assigneeName,
        releaseWindow,
        rows: filtered.slice(0, limit),
        matched: filtered.length,
        limit,
        complete: outcome.complete,
        total: outcome.total,
        facet,
      }),
    )
  }

  async function handleLookup(args, context) {
    const storyCode = String(args.story_code ?? '').trim()
    if (storyCode === '') {
      return textResult('缺少需求编号（story_code）。', { isError: true })
    }
    const { outcome, workspaceName } = await runPreflight({
      story_code: storyCode,
      workspace_name: args.workspace_name ?? null,
    })
    logger('requirement_lookup', {
      caller: context.caller ?? null,
      story_code: storyCode,
      status: outcome.status,
      resolved_workspace: workspaceName,
      corrections: outcome.corrections.length,
    })

    if (outcome.status === PREFLIGHT_REJECTED) {
      return textResult(
        formatPreflightRejection({
          reason: outcome.reason,
          request: {
            story_code: storyCode,
            workspace_name: args.workspace_name ?? null,
            branch: args.branch ?? null,
            commit_window_days: args.branch === undefined ? null : args.commit_window_days,
          },
        }),
        { isError: true },
      )
    }

    // 分支与窗口可以不给：按默认值补齐后总能签出一张可直接用于提交的令牌。
    const params = resolveSubmitParams(args)
    const token = issueToken({
      storyCodes: [outcome.story?.story_code ?? storyCode],
      workspaceName,
      givenWorkspace: args.workspace_name ?? null,
      branch: params.branch,
      commitWindowDays: params.commitWindowDays,
      verification: outcome.status,
    })

    return textResult(
      formatConfirmationCard({
        status: outcome.status,
        story: outcome.story,
        corrections: outcome.corrections,
        reason: outcome.reason,
        request: {
          branch: params.branch,
          commit_window_days: params.commitWindowDays,
          workspace_name: workspaceName,
          story_code: storyCode,
          branch_is_default: params.branchIsDefault,
          window_is_default: params.windowIsDefault,
        },
        token,
      }),
    )
  }

  async function handleSubmit(args, context) {
    // 形状校验必须在最前面。分支/窗口非法时还去查 Linky、还签一张令牌出来，等于把一个
    // 注定失败的参数组合"确认"给使用者看 —— 门禁要拦在更早的地方。
    const hasToken = String(args.confirmation_token ?? '').trim() !== ''
    const releaseWindow = String(args.release_window ?? '').trim()
    const windowMode = releaseWindow !== ''
    /*
     * 编号可以不给，但只在两种情形下：
     *   · 按发布窗口提交 —— 编号是平台枚举出来的；
     *   · 带着令牌复用已确认的那一组 —— 要求客户端回传 30 多个编号只是给它一次抄错的机会。
     * 其余情形仍然必须给，报的还是原来那句话。
     */
    let givenCodes = null
    try {
      givenCodes = normalizeStoryCodes(args)
    } catch (error) {
      if (!((windowMode || hasToken) && error?.code === 'STORY_CODE_REQUIRED')) throw error
    }
    // 先套默认值再校验：两者都是可选参数，缺失不是错误。
    const params = resolveSubmitParams(args)
    const branch = assertBranch(params.branch)
    const commitWindowDays = assertCommitWindow(params.commitWindowDays)
    const baseRequest = {
      workspace_name: args.workspace_name ?? null,
      release_window: windowMode ? releaseWindow : null,
      branch,
      commit_window_days: commitWindowDays,
    }

    /*
     * 两种意图同时出现时不猜。
     *
     * 交集？并集？都是对使用者意图的猜测，而猜错的代价是花钱评审一组他没要的需求。
     */
    if (windowMode && givenCodes !== null && !hasToken) {
      return textResult(
        formatPreflightRejection({
          reason: {
            code: 'STORY_CODES_AND_WINDOW_CONFLICT',
            message:
              '同时给了发布窗口和需求编号，这两种意图只能选一个：要么"评审这个窗口的全部需求"' +
              '（只给 release_window），要么"评审我列出的这几条"（只给 story_code/story_codes）。' +
              '平台不替你猜是取交集还是并集。',
          },
          request: { ...baseRequest, story_codes: givenCodes },
        }),
        { isError: true },
      )
    }

    // 第一步：没有令牌 —— 核对、回卡片、签令牌，**不建批次**。
    if (!hasToken) {
      const outcome = windowMode
        ? await preflightReleaseWindow(
            linky,
            { workspace_name: args.workspace_name ?? null, release_window: releaseWindow },
            { maxPages: SEARCH_MAX_PAGES },
          )
        : (await runBatchPreflight(givenCodes, args.workspace_name ?? null)).outcome
      const workspaceName = outcome.workspaceName ?? args.workspace_name ?? null
      const storyCodes = windowMode
        ? outcome.entries.map((entry) => entry.story_code)
        : givenCodes
      logger('review_submit_preflight', {
        caller: context.caller ?? null,
        mode: windowMode ? 'RELEASE_WINDOW' : 'STORY_CODES',
        release_window: windowMode ? releaseWindow : null,
        story_codes: storyCodes,
        stories: storyCodes.length,
        status: outcome.status,
        resolved_workspace: workspaceName,
        corrections: outcome.corrections?.length ?? 0,
      })

      if (outcome.status === PREFLIGHT_REJECTED) {
        return textResult(
          formatPreflightRejection({
            reason: outcome.reason,
            request: { ...baseRequest, story_codes: storyCodes },
            facet: outcome.facet ?? null,
          }),
          { isError: true },
        )
      }

      /*
       * 窗口里的需求太多。
       *
       * 不截断成前 50 条照常提交 —— 使用者要的是"这个窗口的全部需求"，给他一个被悄悄
       * 截断的子集，比直接拒绝糟得多。平台页面的「原始需求导入」是勾选式的，逐条可见。
       */
      if (windowMode && storyCodes.length > MAX_STORIES_PER_WINDOW) {
        return textResult(
          formatPreflightRejection({
            reason: {
              code: 'RELEASE_WINDOW_TOO_MANY_STORIES',
              message:
                `项目组「${workspaceName}」发布窗口「${releaseWindow}」下有 ${storyCodes.length} 条需求，` +
                `超过一次提交的上限 ${MAX_STORIES_PER_WINDOW} 条。平台不会只提交前 ` +
                `${MAX_STORIES_PER_WINDOW} 条 —— 那样你会以为整个窗口都在评审。` +
                '请用平台页面的「原始需求导入」勾选导入，或用 search_requirements 加负责人/' +
                '关键字缩小范围后按 story_codes 分批提交。',
            },
            request: { ...baseRequest, story_codes: storyCodes },
            facet: outcome.facet ?? null,
          }),
          { isError: true },
        )
      }

      const token = issueToken({
        storyCodes,
        workspaceName,
        givenWorkspace: args.workspace_name ?? null,
        releaseWindow: windowMode ? releaseWindow : null,
        branch,
        commitWindowDays,
        verification: outcome.status,
      })
      if (token === null) {
        // 没有签名器 = 门禁不可用。宁可不提交也不绕过确认。
        return textResult(
          '服务端没有启用确认门禁，无法安全地走"确认后提交"流程。请联系 MCP 维护者。',
          { isError: true },
        )
      }
      return textResult(
        formatConfirmationCard({
          status: outcome.status,
          // 单条且非窗口模式时走单条形态，文案与改造前逐字一致。
          story: !windowMode && storyCodes.length === 1 ? (outcome.entries[0]?.story ?? null) : null,
          stories: !windowMode && storyCodes.length === 1 ? null : outcome.entries,
          listedOnly: windowMode,
          corrections: outcome.corrections ?? [],
          reason: outcome.reason,
          request: {
            ...baseRequest,
            workspace_name: workspaceName,
            story_codes: storyCodes,
            branch_is_default: params.branchIsDefault,
            window_is_default: params.windowIsDefault,
          },
          token,
        }),
      )
    }

    // 第二步：带了令牌 —— 校验它签的就是这次的参数，然后真正提交。
    let claim
    try {
      claim = confirmations.verify(args.confirmation_token, {
        // 没回传编号/窗口时不比对（提交用的是令牌里的那份，见 confirm.mjs）。
        story_codes: givenCodes ?? undefined,
        workspace_name: args.workspace_name ?? null,
        release_window: windowMode ? releaseWindow : undefined,
        branch,
        commit_window_days: commitWindowDays,
      })
    } catch (error) {
      if (error instanceof ConfirmationError) {
        logger('review_submit_confirmation_rejected', {
          caller: context.caller ?? null,
          story_codes: givenCodes,
          release_window: windowMode ? releaseWindow : null,
          code: error.code,
        })
        return textResult(
          [
            '❌ 没有提交，平台上没有创建任何评审。',
            '',
            `原因（${error.code}）：${error.message}`,
            '',
            '请重新调用一次 start_requirement_review（不带 confirmation_token）或 ' +
              'lookup_requirement，把需求信息再给用户确认一遍，然后用新令牌提交。',
          ].join('\n'),
          { isError: true },
        )
      }
      throw error
    }

    const receipt = await submitRequirementReview(
      client,
      config,
      {
        /*
         * 用令牌里的编号，而不是这次实参里的。
         *
         * `verify` 已经证明两者是同一个**集合**（调用方没回传时就只有令牌这一个来源），
         * 但顺序可能不同。取令牌里的那份，批次名与回执的顺序就和使用者刚看过的卡片一致 ——
         * 落库的编号顺序无关紧要（导入单自己会 distinct … order by code），
         * 但"确认的是什么，提交的就是什么"这件事应该在代码里只有一个来源。
         */
        story_codes: claim.story_codes,
        // 用令牌里签过的项目组名：它是核对/纠正之后的值，而不是调用方原样给的。
        workspace_name: claim.workspace_name,
        release_window: claim.release_window ?? null,
        workspace_id: args.workspace_id ?? null,
        release_cycle: args.release_cycle ?? null,
        branch,
        commit_window_days: commitWindowDays,
        caller: context.caller ?? null,
      },
      { settle },
    )
    logger('review_submitted', {
      caller: context.caller ?? null,
      batch_id: receipt.batch_id,
      import_request_id: receipt.import_request_id,
      story_codes: receipt.story_codes,
      stories: receipt.story_codes.length,
      release_window: receipt.release_window,
      branch: receipt.branch,
      commit_window_days: receipt.commit_window_days,
      verification: claim.verification,
      recovered: receipt.recovered === true,
    })
    return textResult(
      formatSubmissionReceipt({ ...receipt, verification: claim.verification }),
    )
  }

  return {
    /**
     * 工具清单的顺序是给模型看的：先"怎么查"，再"怎么提交"。
     * 只读查询排在前面，提交排最后 —— 它是唯一会花钱的那个。
     */
    definitions: [
      LIST_WORKSPACES_DEFINITION,
      SEARCH_REQUIREMENTS_DEFINITION,
      DESCRIBE_OPTIONS_DEFINITION,
      LOOKUP_TOOL_DEFINITION,
      TOOL_DEFINITION,
    ],

    /**
     * 统一出口。
     *
     * 第一道门是**按对外公布的 schema 校验实参**。低层 SDK 不做这件事，所以如果这里不做，
     * 那份 schema 对服务端就只是装饰：多传的字段被静默忽略，类型错的参数要一路走到
     * 业务代码才被另一份手写规则拦住。
     *
     * 工具级失败一律以 isError 文本回给模型，而不是抛协议错误：模型能读懂"项目组填错了"
     * 并自己改参数，而协议层错误在多数客户端里只会显示一句 "tool call failed"。
     */
    async call(name, args = {}, context = {}) {
      const definition = this.definitions.find((tool) => tool.name === name)
      if (definition === undefined) {
        return textResult(
          `未知工具：${name}。本服务只有两个工具：${LOOKUP_TOOL_NAME}（只读查需求）、` +
            `${TOOL_NAME}（提交评审）。`,
          { isError: true },
        )
      }

      const violations = validateAgainstSchema(definition.inputSchema, args ?? {})
      if (violations.length > 0) {
        logger('tool_args_rejected', {
          caller: context.caller ?? null,
          tool: name,
          violations: violations.map((item) => `${item.path}:${item.message}`),
        })
        return textResult(formatSchemaViolations(name, violations), { isError: true })
      }

      try {
        if (name === LIST_WORKSPACES_TOOL) return handleListWorkspaces(args ?? {}, context)
        if (name === SEARCH_REQUIREMENTS_TOOL) return await handleSearch(args ?? {}, context)
        if (name === DESCRIBE_OPTIONS_TOOL) return handleDescribeOptions(context)
        if (name === LOOKUP_TOOL_NAME) return await handleLookup(args ?? {}, context)
        return await handleSubmit(args ?? {}, context)
      } catch (error) {
        if (error instanceof SubmissionStateUnknownError) {
          // 结果不明：批次保留，既不报成功也不报"没创建"。运维要靠这条日志去核对。
          logger('review_submit_state_unknown', {
            caller: context.caller ?? null,
            batch_id: error.batchId,
            story_code: error.storyCode,
            cause_code: error.cause instanceof PlatformError ? error.cause.code : null,
            cause_message: String(error.cause?.message ?? error.cause),
          })
          return textResult(formatSubmissionUnknown(error), { isError: true })
        }
        logger('review_submit_failed', {
          caller: context.caller ?? null,
          code: error instanceof PlatformError ? error.code : null,
          message: String(error?.message ?? error),
        })
        return textResult(formatSubmissionFailure(error), { isError: true })
      }
    },
  }
}
