/**
 * 工具清单与实现。首版只有一个工具：start_requirement_review。
 *
 * 工具描述是写给**对方客户端里的模型**看的，所以每一条都写清：会不会花钱、要等多久、
 * 成功之后该做什么、不该做什么。描述含糊的后果不是报错，而是模型拿错参数反复重试，
 * 每次重试都真的在平台上建一个批次、排一次评审。
 */

import { PlatformError } from './platform.mjs'
import { SubmissionStateUnknownError, submitRequirementReview } from './review.mjs'
import {
  formatSubmissionFailure,
  formatSubmissionReceipt,
  formatSubmissionUnknown,
} from './format.mjs'
import { SUPPORTED_BRANCHES, SUPPORTED_COMMIT_WINDOWS } from './config.mjs'

export const TOOL_NAME = 'start_requirement_review'

export const TOOL_DEFINITION = {
  name: TOOL_NAME,
  title: '提交指定需求的代码评审',
  description:
    '把公司内任意一条需求提交到「需求开发评审一致性平台」做"需求 ↔ 代码一致性"评审。' +
    '不限制需求负责人，任何需求编号都可以提交。\n\n' +
    '平台受理后会在内网侧冻结需求正文与附件、按目标分支冻结各仓库代码快照，再由评审 Agent ' +
    '读代码给出结论（已实现/部分实现/未实现、缺失内容、风险、测试要点、代码证据）。' +
    '评审模型由服务端配置，调用方不需要也不能指定。\n\n' +
    '**这是异步提交，会真实消耗模型额度。** 本工具在平台受理并落库后立刻返回，不等待导入与评审完成。\n\n' +
    '成功后请把返回的批次编号、受理编号和平台详情链接完整转述给用户，提示他去平台查看进度与结果，' +
    '然后结束本次提交流程：本服务不提供进度查询、结果查询或轮询，不要再次调用本工具查状态，' +
    '也不要为同一条需求重复提交。失败时返回明确原因，此时平台上没有创建任何评审，不要告诉用户已提交。',
  inputSchema: {
    type: 'object',
    properties: {
      workspace_name: {
        type: 'string',
        minLength: 1,
        description:
          '需求所在的项目组名称（Linky 的 workspace_name），例如「灵基Foundation」。必填，决定在哪个范围里找这条需求。',
      },
      story_code: {
        type: 'string',
        minLength: 1,
        description: '需求编号，例如 F-123456。必填，一次提交一条需求。',
      },
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
      workspace_id: {
        type: 'string',
        description: '项目组 UUID。可选，不确定时不要填，只给 workspace_name。',
      },
    },
    required: ['workspace_name', 'story_code', 'branch', 'commit_window_days'],
    additionalProperties: false,
  },
}

function textResult(text, { isError = false } = {}) {
  return { content: [{ type: 'text', text }], isError }
}

export function createToolRegistry({ client, config, logger = () => {}, settle } = {}) {
  return {
    definitions: [TOOL_DEFINITION],

    /**
     * 统一出口。
     *
     * 工具级失败一律以 isError 文本回给模型，而不是抛协议错误：模型能读懂"项目组填错了"
     * 并自己改参数，而协议层错误在多数客户端里只会显示一句 "tool call failed"。
     */
    async call(name, args = {}, context = {}) {
      if (name !== TOOL_NAME) return textResult(`未知工具：${name}`, { isError: true })
      try {
        const receipt = await submitRequirementReview(
          client,
          config,
          { ...(args ?? {}), caller: context.caller ?? null },
          { settle },
        )
        logger('review_submitted', {
          caller: context.caller ?? null,
          batch_id: receipt.batch_id,
          import_request_id: receipt.import_request_id,
          story_code: receipt.story_code,
          branch: receipt.branch,
          commit_window_days: receipt.commit_window_days,
          recovered: receipt.recovered === true,
        })
        return textResult(formatSubmissionReceipt(receipt))
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
