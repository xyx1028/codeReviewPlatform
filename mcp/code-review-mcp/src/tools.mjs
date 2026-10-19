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
  normalizeStoryCode,
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
  preflightRequirement,
} from './preflight.mjs'
import { ConfirmationError } from './confirm.mjs'
import { SUPPORTED_BRANCHES, SUPPORTED_COMMIT_WINDOWS } from './config.mjs'

export const TOOL_NAME = 'start_requirement_review'
export const LOOKUP_TOOL_NAME = 'lookup_requirement'

const STORY_CODE_DESCRIPTION =
  '需求编号，例如 US-2026-017341 或 F-123456。必填，一次一条。平台会按它反查需求所属项目组。'

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
      story_code: { type: 'string', minLength: 1, description: STORY_CODE_DESCRIPTION },
      workspace_name: {
        type: 'string',
        description:
          '用户说的项目组名称，可选。填了会和实际值核对并在不一致时指出；不确定时不要填。',
      },
      branch: {
        type: 'string',
        enum: SUPPORTED_BRANCHES,
        description:
          '目标分支，可选。填了才会在返回里签出可直接用于提交的 confirmation_token。',
      },
      commit_window_days: {
        type: 'integer',
        enum: SUPPORTED_COMMIT_WINDOWS,
        description: '提交时间窗口（天），可选。与 branch 同时填才会签出 confirmation_token。',
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
    '它返回平台从 Linky 查到的真实需求信息和一个 confirmation_token。你必须把那些信息' +
    '告诉用户、等他确认，再带上 confirmation_token 调用第二次才真正提交。' +
    '用户没有明确同意之前不要自行带令牌提交。\n\n' +
    '**这是异步提交，会真实消耗模型额度。** 受理并落库后立刻返回，不等待导入与评审完成。\n\n' +
    '成功后请把返回的批次编号、受理编号和平台详情链接完整转述给用户，提示他去平台查看进度与结果，' +
    '然后结束本次提交流程：本服务不提供进度查询、结果查询或轮询，不要再次调用本工具查状态，' +
    '也不要为同一条需求重复提交。失败时返回明确原因，此时平台上没有创建任何评审，不要告诉用户已提交。',
  inputSchema: {
    type: 'object',
    properties: {
      story_code: { type: 'string', minLength: 1, description: STORY_CODE_DESCRIPTION },
      branch: {
        type: 'string',
        enum: SUPPORTED_BRANCHES,
        description: '目标分支：评审哪一条分支上的代码。必填，没有默认值。',
      },
      commit_window_days: {
        type: 'integer',
        enum: SUPPORTED_COMMIT_WINDOWS,
        description: '提交时间窗口（天）：向前追溯多少天的提交作为该需求的精准提交范围。必填。',
      },
      workspace_name: {
        type: 'string',
        description:
          '需求所在的项目组名称（Linky 的 workspace_name）。**可选** —— 平台会按需求编号反查，' +
          '不确定时不要填、也不要猜。填了会被核对，与实际不一致时按实际值提交并在回执里指出。',
      },
      workspace_id: {
        type: 'string',
        description: '项目组 UUID。可选，不确定时不要填。',
      },
      confirmation_token: {
        type: 'string',
        description:
          '确认令牌：由第一次调用（或 lookup_requirement）返回。' +
          '只有用户确认过需求信息之后才带上它 —— 带上它这次就会真的创建评审并消耗模型额度。',
      },
    },
    required: ['story_code', 'branch', 'commit_window_days'],
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

  function issueToken({
    storyCode,
    workspaceName,
    givenWorkspace,
    branch,
    commitWindowDays,
    verification,
  }) {
    if (confirmations === null) return null
    return {
      value: confirmations.issue({
        story_code: storyCode,
        workspace_name: workspaceName,
        given_workspace: givenWorkspace ?? null,
        branch,
        commit_window_days: commitWindowDays,
        verification,
      }),
      ttlMs: confirmations.ttlMs,
    }
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

    // 分支与窗口齐全才签令牌：令牌和这两个参数绑定，缺一个就签不出可用的令牌。
    const branch = SUPPORTED_BRANCHES.includes(String(args.branch ?? '')) ? args.branch : null
    const window = SUPPORTED_COMMIT_WINDOWS.includes(Number(args.commit_window_days))
      ? Number(args.commit_window_days)
      : null
    const token =
      branch === null || window === null
        ? null
        : issueToken({
            storyCode: outcome.story?.story_code ?? storyCode,
            workspaceName,
            givenWorkspace: args.workspace_name ?? null,
            branch,
            commitWindowDays: window,
            verification: outcome.status,
          })

    if (token === null) {
      return textResult(
        formatConfirmationCard({
          status: outcome.status,
          story: outcome.story,
          corrections: outcome.corrections,
          reason: outcome.reason,
          request: {
            branch: branch ?? '（还没确定，提交时必填）',
            commit_window_days: window ?? '（还没确定，提交时必填）',
            workspace_name: workspaceName,
            story_code: storyCode,
          },
          token: { value: '（还没有：需要先确定目标分支与提交时间窗口）', ttlMs: 0 },
        }),
      )
    }

    return textResult(
      formatConfirmationCard({
        status: outcome.status,
        story: outcome.story,
        corrections: outcome.corrections,
        reason: outcome.reason,
        request: {
          branch,
          commit_window_days: window,
          workspace_name: workspaceName,
          story_code: storyCode,
        },
        token,
      }),
    )
  }

  async function handleSubmit(args, context) {
    // 形状校验必须在最前面。分支/窗口非法时还去查 Linky、还签一张令牌出来，等于把一个
    // 注定失败的参数组合"确认"给使用者看 —— 门禁要拦在更早的地方。
    const storyCode = normalizeStoryCode(args.story_code)
    const branch = assertBranch(args.branch)
    const commitWindowDays = assertCommitWindow(args.commit_window_days)

    // 第一步：没有令牌 —— 核对、回卡片、签令牌，**不建批次**。
    if (String(args.confirmation_token ?? '').trim() === '') {
      const { outcome, workspaceName } = await runPreflight({
        story_code: storyCode,
        workspace_name: args.workspace_name ?? null,
      })
      logger('review_submit_preflight', {
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
              branch,
              commit_window_days: args.commit_window_days,
            },
          }),
          { isError: true },
        )
      }

      const token = issueToken({
        storyCode: outcome.story?.story_code ?? storyCode,
        workspaceName,
        givenWorkspace: args.workspace_name ?? null,
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
          story: outcome.story,
          corrections: outcome.corrections,
          reason: outcome.reason,
          request: {
            branch,
            commit_window_days: args.commit_window_days,
            workspace_name: workspaceName,
            story_code: storyCode,
          },
          token,
        }),
      )
    }

    // 第二步：带了令牌 —— 校验它签的就是这次的参数，然后真正提交。
    let claim
    try {
      claim = confirmations.verify(args.confirmation_token, {
        story_code: storyCode,
        workspace_name: args.workspace_name ?? null,
        branch,
        commit_window_days: commitWindowDays,
      })
    } catch (error) {
      if (error instanceof ConfirmationError) {
        logger('review_submit_confirmation_rejected', {
          caller: context.caller ?? null,
          story_code: storyCode,
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
        story_code: storyCode,
        // 用令牌里签过的项目组名：它是核对/纠正之后的值，而不是调用方原样给的。
        workspace_name: claim.workspace_name,
        workspace_id: args.workspace_id ?? null,
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
      story_code: receipt.story_code,
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
    definitions: [LOOKUP_TOOL_DEFINITION, TOOL_DEFINITION],

    /**
     * 统一出口。
     *
     * 工具级失败一律以 isError 文本回给模型，而不是抛协议错误：模型能读懂"项目组填错了"
     * 并自己改参数，而协议层错误在多数客户端里只会显示一句 "tool call failed"。
     */
    async call(name, args = {}, context = {}) {
      try {
        if (name === LOOKUP_TOOL_NAME) return await handleLookup(args ?? {}, context)
        if (name === TOOL_NAME) return await handleSubmit(args ?? {}, context)
        return textResult(`未知工具：${name}`, { isError: true })
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
