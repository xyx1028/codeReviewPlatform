/**
 * 提交前校验（V1.56）。
 *
 * 存在的理由很具体：2026-10-19 一次真实提交里，使用者把项目组说成「工具组」（真名是
 * 「工具开发组」）。上游对不存在的工作区返回空列表而不是报错，于是 MCP 照常受理、建了
 * 批次、回了一张"✅ 已成功受理"，几十秒后 Worker 以 `LINKY_NETWORK_ERROR` 整单失败。
 * 使用者拿到的三句话里有两句是假的：不是网络问题，也没有真的"受理成功"。
 *
 * 所以这一层做三件事，全部发生在**建批次之前**：
 *
 *   1. **反查**：只凭需求编号定位它真正属于哪个项目组（上游详情端点不带 config_id 时
 *      会遍历所有启用工作区，并回可读的 workspace_name）。使用者不必自己拼对名字。
 *   2. **纠正**：使用者给的名字与实际不一致时，如实写出"你给的"与"实际是"，并按实际值提交。
 *      不沉默纠正 —— 他可能本来就想评审另一个组的同名需求。
 *   3. **如实报告校验能力**：校验不可用（MCP 不在内网、上游凭据失效）时**不**伪装成
 *      校验通过，也不阻断链路，而是标成"未校验"交给使用者确认。
 */

import { LinkyLookupError } from './linky.mjs'

/** 校验结论。`VERIFIED` 之外的两种都必须在卡片上写清楚，不许含糊成"已检查"。 */
export const PREFLIGHT_VERIFIED = 'VERIFIED'
export const PREFLIGHT_UNVERIFIED = 'UNVERIFIED'
export const PREFLIGHT_REJECTED = 'REJECTED'

function text(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

function countAttachments(detail) {
  const list = detail?.attachments
  return Array.isArray(list) ? list.length : 0
}

function peopleNames(team, role) {
  const list = team?.[role]
  if (!Array.isArray(list)) return []
  return list
    .map((entry) => (typeof entry === 'object' && entry !== null ? text(entry.name) : null))
    .filter((name) => name !== null)
}

/**
 * 从详情响应里抽出用于**确认展示**的字段。
 *
 * 刻意只取标量与人名：这份数据只会出现在回给使用者的确认卡片上，不写进任何表。
 * 需求正文只判断"有没有"和长度，不回正文内容本身 —— 评审用的正文由 Worker 在内网取。
 */
export function describeStory(detail) {
  const fieldValues =
    typeof detail?.field_values === 'object' && detail.field_values !== null
      ? detail.field_values
      : {}
  const team =
    typeof detail?.team === 'object' && detail.team !== null && !Array.isArray(detail.team)
      ? detail.team
      : null
  // 实测 description 恒空，正文在 field_values.gf_description（见 worker mapping.ts）。
  const body = text(fieldValues.gf_description) ?? text(detail?.description)
  return {
    story_code: text(detail?.code),
    issue_id: text(detail?.id),
    title: text(fieldValues.gf_name) ?? text(detail?.title),
    workspace_name: text(detail?.workspace_name),
    workspace_id: text(detail?.workspace_id),
    // 详情的 status 是内部码，可读值在 status_label（见 worker mapping.ts 规则 3）。
    status_label: text(detail?.status_label) ?? text(detail?.status),
    iteration: text(detail?.iteration),
    release_window: text(detail?.release_window),
    subject_name: text(detail?.subject),
    body_chars: body === null ? 0 : body.length,
    attachment_count: countAttachments(detail),
    req_owners: peopleNames(team, 'req'),
    dev_owners: peopleNames(team, 'dev'),
    test_owners: peopleNames(team, 'test'),
    team_resolve_error: text(detail?.team_resolve_error),
  }
}

/**
 * 核对一次提交的参数。
 *
 * 绝不抛错：三种结论都以返回值表达，由上层决定"拒绝提交"还是"要求确认"。
 * 让它抛错会把"校验连不上"和"参数确实错了"混成同一条失败路径，而这两件事的处置相反。
 *
 * @param {object} input 调用方给的原始参数（`story_code` 必有，`workspace_name` 可空）
 * @returns {Promise<{status:string, story:object|null, corrections:object[], reason:object|null}>}
 */
export async function preflightRequirement(client, input) {
  const storyCode = String(input.story_code ?? '').trim()
  const givenWorkspace = text(input.workspace_name)

  if (client === null) {
    // 服务端没配 Linky 地址 —— 校验能力整体关闭。如实说，不假装查过。
    return {
      status: PREFLIGHT_UNVERIFIED,
      story: null,
      corrections: [],
      reason: {
        code: 'PREFLIGHT_DISABLED',
        message:
          'MCP 服务端没有配置 Linky 取数地址（CRP_LINKY_API_BASE_URL），无法在提交前核对需求。',
      },
    }
  }

  let detail
  try {
    detail = await client.getStory(storyCode)
  } catch (error) {
    if (error instanceof LinkyLookupError && error.code === 'LINKY_STORY_NOT_FOUND') {
      /**
       * 「查不到」要先问一句：这个 404 可信吗？
       *
       * 上游按编号查询时会遍历所有启用工作区。凭据失效时那条遍历可能根本没走完，
       * 而它仍然回 404。此刻把"查不到"当成"需求不存在"去拒绝提交，等于拿上游的故障
       * 去否认一条真实需求 —— 使用者会被告知"编号写错了"，然后对着一个正确的编号发呆。
       *
       * 所以多打一次健康探针（只在这条罕见路径上）。上游不健康就降级成"没校验成"，
       * 把两件事都说出来，由使用者决定是否继续。
       */
      const health = await client.probeHealth()
      if (!health.healthy) {
        const upstream = health.error
        return {
          status: PREFLIGHT_UNVERIFIED,
          story: null,
          corrections: [],
          reason: {
            code: upstream?.code ?? 'LINKY_UNHEALTHY',
            message:
              `Linky 按编号查不到「${storyCode}」，但上游取数接口当前本身不正常` +
              `（${upstream?.message ?? '健康探测失败'}），所以这个"查不到"并不可信 —— ` +
              '可能是编号写错了，也可能是上游故障导致查询没走完。' +
              (upstream?.code === 'LINKY_UPSTREAM_AUTH_FAILED'
                ? '凭据失效需要质量执行平台的维护者在「配置 › Linky 工作区」更新 token；' +
                  '在那之前提交的话，平台侧取需求同样会失败。'
                : '请稍后重试，或先确认编号。'),
          },
        }
      }
      // 上游是健康的，那这个 404 就是**确定的**坏参数。拒绝提交。
      return {
        status: PREFLIGHT_REJECTED,
        story: null,
        corrections: [],
        reason: {
          code: 'STORY_NOT_FOUND',
          message:
            `Linky 里找不到需求「${storyCode}」（已遍历全部启用的工作区）。` +
            '请确认编号是否写错，或这条需求是否已被删除/移出可见范围。',
        },
      }
    }
    if (error instanceof LinkyLookupError && error.unverifiable) {
      // 校验做不到。不阻断链路，但必须让使用者知道这次没核对过。
      return {
        status: PREFLIGHT_UNVERIFIED,
        story: null,
        corrections: [],
        reason: {
          code: error.code,
          message:
            error.code === 'LINKY_UPSTREAM_AUTH_FAILED'
              ? `${error.message}。这不是你的网络问题，重试和连 VPN 都没用：` +
                '需要质量执行平台的维护者在「配置 › Linky 工作区」更新 token。' +
                '现在提交的话，平台侧取需求同样会失败。'
              : `${error.message}。MCP 服务端此刻无法核对需求（它可能不在公司内网）。`,
        },
      }
    }
    throw error
  }

  const story = describeStory(detail)
  const corrections = []

  const actualWorkspace = story.workspace_name
  if (actualWorkspace === null) {
    // 详情没给项目组名。能查到需求但说不出它属于哪个组 —— 不编一个出来。
    return {
      status: PREFLIGHT_UNVERIFIED,
      story,
      corrections: [],
      reason: {
        code: 'WORKSPACE_NAME_MISSING',
        message:
          'Linky 能查到这条需求，但没有返回它所属的项目组名称，无法核对你给的项目组。',
      },
    }
  }

  if (givenWorkspace !== null && givenWorkspace !== actualWorkspace) {
    corrections.push({
      field: 'workspace_name',
      given: givenWorkspace,
      resolved: actualWorkspace,
      note:
        '上游按名称**精确匹配**，而且不存在的项目组返回的是空列表而不是报错 —— ' +
        '所以这个名字如果不改，导入会以"全部导入失败"收场。已按实际值提交。',
    })
  }
  if (givenWorkspace === null) {
    corrections.push({
      field: 'workspace_name',
      given: null,
      resolved: actualWorkspace,
      note: '你没有指定项目组，已按需求编号反查到的实际项目组填入。',
    })
  }

  // 存在但正文与附件都空：平台允许导入（V1.20 起不设内容门禁），但结论会更弱，要说明白。
  if (story.body_chars === 0 && story.attachment_count === 0) {
    corrections.push({
      field: 'requirement_content',
      given: null,
      resolved: '正文为空且没有附件',
      note:
        '这条需求在 Linky 里既没有正文也没有附件。平台会照常导入，但"需求↔代码一致性"' +
        '的结论会很弱（没有可比对的验收口径）。确认要继续吗？',
    })
  }

  return {
    status: PREFLIGHT_VERIFIED,
    story,
    corrections,
    reason: null,
    /** 提交时真正使用的值 —— 已经过纠正，不是调用方原样给的。 */
    resolved: {
      workspace_name: actualWorkspace,
      workspace_id: story.workspace_id,
      story_code: story.story_code ?? storyCode,
    },
  }
}
