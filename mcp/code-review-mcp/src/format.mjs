/**
 * 回给模型的文本。
 *
 * 两条硬规矩：
 *
 * 1. **只有真的受理成功才出现"已提交"。** 失败路径一律是错误文本，且不带链接 ——
 *    链接会让使用者以为平台上有东西可看。
 * 2. **不描述没有事实支撑的进度。** 首版不查进度，所以这里连"正在导入"都不说，
 *    只说"已受理，去平台看"。
 */

import { SUPPORTED_BRANCHES, SUPPORTED_COMMIT_WINDOWS } from './config.mjs'

/**
 * 代码基线的人话说明。
 *
 * 与 `query-tools.mjs` 的 BRANCH_LABELS 同源同值；此处就近定义而不是跨文件 import，
 * 是为了避免 format ↔ query-tools 的循环依赖（query-tools 已经依赖 review，review 依赖 config）。
 * 一致性由测试 `confirmation-defaults.test.mjs` 断言。
 */
const BRANCH_LABELS = {
  feature_dev: '开发分支（最新，可能还没测过）',
  feature_sit: '集成测试分支',
  release: '发布分支（最接近线上）',
}

/** 固定提示语。首版的全部语义都压在这一句上，不允许各处改写。 */
export const SUBMITTED_NOTICE =
  '评审任务已提交，执行需要较长时间，请前往代码评审平台查看进度和结果。'

function labelOrDash(value) {
  return value === null || value === undefined || value === '' ? '（空）' : String(value)
}

function peopleOrDash(names) {
  return Array.isArray(names) && names.length > 0 ? names.join('、') : '（未填写）'
}

/**
 * 提交前的确认卡片。
 *
 * 三条硬规矩：
 *
 * 1. **开头必须说清"还没提交"。** 这是整段文本里最容易被误读的一点 —— 使用者看到一大片
 *    需求信息，很容易以为已经在跑了。
 * 2. **纠正过的字段必须逐条写出"你给的"和"实际是"。** 不沉默纠正：他可能本来就想评审
 *    另一个组的需求，沉默改掉等于替他做了决定。
 * 3. **没核对成就不许写得像核对过。** `UNVERIFIED` 的卡片要明说哪一项没核对、为什么。
 */
export function formatConfirmationCard({ status, story, corrections, reason, request, token }) {
  const lines = []

  if (status === 'VERIFIED') {
    lines.push('🔎 **还没有提交。** 以下是平台从 Linky 查到的需求，请让用户确认后再提交。')
  } else {
    lines.push('⚠️ **还没有提交，而且这次没能核对成功。** 请把下面的情况告诉用户，由他决定是否继续。')
  }
  lines.push('')

  if (reason !== null && reason !== undefined) {
    lines.push(`未能核对的原因（${reason.code}）：${reason.message}`)
    lines.push('')
  }

  if (story !== null && story !== undefined) {
    lines.push('将要评审的需求：')
    lines.push(`  需求编号：${labelOrDash(story.story_code)}`)
    lines.push(`  需求名称：${labelOrDash(story.title)}`)
    lines.push(`  所属项目组：${labelOrDash(story.workspace_name)}`)
    lines.push(`  当前状态：${labelOrDash(story.status_label)}`)
    lines.push(`  迭代：${labelOrDash(story.iteration)}`)
    lines.push(`  发布窗口：${labelOrDash(story.release_window)}`)
    lines.push(`  关联特性：${labelOrDash(story.subject_name)}`)
    lines.push(`  需求负责人：${peopleOrDash(story.req_owners)}`)
    lines.push(`  开发负责人：${peopleOrDash(story.dev_owners)}`)
    lines.push(`  测试负责人：${peopleOrDash(story.test_owners)}`)
    lines.push(
      `  需求正文：${story.body_chars > 0 ? `${story.body_chars} 字` : '空'}` +
        `；附件：${story.attachment_count} 个`,
    )
    if (story.team_resolve_error !== null && story.team_resolve_error !== undefined) {
      lines.push(`  ⚠️ 负责人解析降级：${story.team_resolve_error}（上面的人名可能不全）`)
    }
    lines.push('')
  }

  lines.push('本次评审参数：')
  lines.push(
    `  代码基线（目标分支）：${labelOrDash(request.branch)}` +
      `${BRANCH_LABELS[request.branch] ? ` —— ${BRANCH_LABELS[request.branch]}` : ''}` +
      `${request.branch_is_default === true ? '  ← 默认值' : ''}`,
  )
  lines.push(
    `  提交时间窗口：${labelOrDash(request.commit_window_days)} 天` +
      `${request.window_is_default === true ? '  ← 默认值' : ''}`,
  )
  lines.push(`  项目组（提交时实际使用）：${labelOrDash(request.workspace_name)}`)
  lines.push('')

  /**
   * 把替代项摊开。
   *
   * 这一段是默认值能够成立的前提。此前这两个参数刻意没有默认值，理由是它们直接改变评审
   * 结论，静默替人选一个比报错更糟 —— 那条理由没有被推翻，只是换了方式满足：**默认值
   * 不沉默**。使用者在花钱之前就看到"用的是默认值"和"还能选什么"，于是"确认"是一次
   * 真正的选择，而不是对一个他不知道存在的选项的默认接受。
   */
  const otherBranches = SUPPORTED_BRANCHES.filter((item) => item !== request.branch)
  const otherWindows = SUPPORTED_COMMIT_WINDOWS.filter(
    (item) => Number(item) !== Number(request.commit_window_days),
  )
  if (otherBranches.length > 0 || otherWindows.length > 0) {
    lines.push('也可以换成其它取值（告诉我就行，不改就按上面的提交）：')
    if (otherBranches.length > 0) {
      lines.push('  代码基线还可以选：')
      for (const branch of otherBranches) {
        lines.push(`    · ${branch}${BRANCH_LABELS[branch] ? ` —— ${BRANCH_LABELS[branch]}` : ''}`)
      }
    }
    if (otherWindows.length > 0) {
      lines.push(`  提交时间窗口还可以选：${otherWindows.map((item) => `${item} 天`).join(' / ')}`)
    }
    lines.push('')
  }

  if (Array.isArray(corrections) && corrections.length > 0) {
    lines.push('⚠️ 平台更正/提醒了以下内容，请一并告诉用户：')
    for (const item of corrections) {
      if (item.field === 'requirement_content') {
        lines.push(`  · ${item.resolved}。${item.note}`)
        continue
      }
      // 「没填」和「填错了」要分开说：前者是正常用法，用"你给的是（未填）"描述它
      // 会让使用者以为自己做错了什么。
      lines.push(
        item.given === null || item.given === undefined || item.given === ''
          ? `  · ${item.field}：已自动填为「${item.resolved}」。${item.note}`
          : `  · ${item.field}：你给的是「${item.given}」，实际是「${item.resolved}」。${item.note}`,
      )
    }
    lines.push('')
  }

  lines.push('确认无误后，用下面这个令牌再调用一次 start_requirement_review 即可提交')
  lines.push(`（其余参数保持不变，令牌 ${Math.round((token.ttlMs ?? 0) / 60000)} 分钟内有效）：`)
  lines.push('')
  lines.push(`confirmation_token: ${token.value}`)
  lines.push('')
  lines.push('提交会真实消耗模型额度。用户没有明确同意之前，不要自行带上令牌提交。')
  lines.push(
    '用户要改代码基线或时间窗口的话，带上他指定的值重新调用一次（不带令牌）—— ' +
      '参数变了旧令牌就失效，需要重新确认一遍。',
  )

  return lines.join('\n')
}

/** 校验明确判定参数是错的 —— 拒绝提交，平台上不会留下任何批次。 */
export function formatPreflightRejection({ reason, request }) {
  return [
    '❌ 没有提交，平台上没有创建任何评审。',
    '',
    `原因（${reason.code}）：${reason.message}`,
    '',
    `你给的参数：需求编号 ${labelOrDash(request.story_code)}` +
      `，项目组 ${labelOrDash(request.workspace_name)}` +
      `，分支 ${labelOrDash(request.branch)}` +
      `，窗口 ${labelOrDash(request.commit_window_days)} 天`,
    '',
    '请和用户核对需求编号后重试。只给需求编号也可以 —— 项目组可以由平台反查，不必自己填。',
  ].join('\n')
}

/** 错误码 → 处置建议。缺席的码原样透出，绝不吞掉。 */
const ERROR_HINTS = {
  STORY_CODE_REQUIRED: '需要需求编号（story_code）。',
  STORY_CODE_INVALID: '需求编号不合法。',
  WORKSPACE_NAME_REQUIRED: '需要需求所在的项目组（workspace_name）。',
  WORKSPACE_ID_INVALID: 'workspace_id 不是合法 UUID；不确定时不要填。',
  BRANCH_INVALID: '目标分支只能是 feature_dev / feature_sit / release。',
  COMMIT_WINDOW_DAYS_INVALID: '提交时间窗口只能是 7 / 14 / 21 / 28 天。',
  MODEL_CONFIG_NOT_FOUND: '平台当前没有可用模型，无法受理评审，请联系平台管理员。',
  MODEL_CONFIG_DISABLED: '服务端配置的默认模型已被停用，请联系平台管理员。',
  MODEL_SECRET_MISSING: '服务端配置的默认模型缺少可用的 API Key，请联系平台管理员。',
  MCP_DEFAULT_MODEL_NOT_CONFIGURED: 'MCP 服务端没有配置默认模型，请联系 MCP 维护者。',
  MCP_DEFAULT_MODEL_UNAVAILABLE: 'MCP 服务端配置的默认模型在平台上不可用，请联系 MCP 维护者。',
  ACTIVE_JOB_EXISTS: '这个批次已有分析任务在跑。',
  BATCH_READ_ONLY: '这个批次已有结果或已归档，不能再发起分析。',
  IMPORT_REQUEST_ID_MISSING: '平台没有返回受理编号，无法确认提交是否已持久化。',
  PLATFORM_UNREACHABLE: 'MCP 服务端连不上平台接口（网络中断或超时）。',
  AUTH_REQUIRED: 'MCP 使用的平台账号登录状态失效，请联系 MCP 维护者检查服务端配置。',
  PLATFORM_SIGN_IN_FAILED: 'MCP 使用的平台账号登录失败，请联系 MCP 维护者检查服务端配置。',
}

export function describePlatformError(error) {
  const code = error?.code ?? null
  const raw = String(error?.message ?? error ?? '').trim()
  const hint = code ? ERROR_HINTS[code] : undefined
  if (hint) return `${hint}（错误码 ${code}）`
  if (
    /batch creation permission|batch management permission/i.test(raw) ||
    /row-level security policy for table "review_batch"/i.test(raw) ||
    code === '42501'
  ) {
    return (
      'MCP 使用的平台账号没有创建/管理评审批次的权限（平台权限照常生效，MCP 不绕过它）。' +
      `请让平台管理员把该账号的角色提到 ADMIN 或 REVIEWER。（原始报错：${raw}）`
    )
  }
  return raw === '' ? '提交失败，但平台没有给出原因。' : raw
}

/** 受理成功的回执。字段顺序固定，便于使用者和平台页面逐项对照。 */
export function formatSubmissionReceipt(receipt) {
  return [
    '✅ 评审任务已成功受理并落库。',
    receipt.recovered
      ? '（提交过程中出现过一次网络异常，已向平台核对：这一条确实已经受理，没有重复提交。）'
      : null,
    receipt.verification === 'UNVERIFIED'
      ? '⚠️ 注意：这次**没有**在提交前核对需求（原因见上一步的提示）。如果需求编号或项目组不对，' +
        '平台侧取需求会失败，批次会停在"需求准备失败"。'
      : null,
    '',
    `批次编号（review_batch.id）：${receipt.batch_id}`,
    `批次名称：${receipt.batch_name}`,
    `发布周期编码：${receipt.week_code}`,
    `任务受理编号（需求导入单 linky_batch_import_request.id）：${receipt.import_request_id}`,
    '',
    `需求编号：${receipt.story_code}`,
    receipt.story_title ? `需求名称：${receipt.story_title}` : null,
    `项目组：${receipt.workspace_name}`,
    `目标分支：${receipt.branch}`,
    `提交时间窗口：${receipt.commit_window_days} 天`,
    `评审模型（服务端配置）：${receipt.model}`,
    '',
    `平台详情链接：${receipt.batch_url}`,
    '',
    SUBMITTED_NOTICE,
    '',
    '说明：受理编号是**需求导入单**的编号，不是分析任务编号 —— 分析任务由平台在需求快照',
    '冻结完成后自动创建，提交这一刻它还不存在。本服务不提供进度与结果查询，请打开上面的链接。',
  ]
    .filter((line) => line !== null)
    .join('\n')
}

/** 失败回执。刻意不带链接、不带"已提交"。 */
export function formatSubmissionFailure(error) {
  return ['❌ 评审任务提交失败，平台上没有创建任何评审。', '', `原因：${describePlatformError(error)}`].join(
    '\n',
  )
}

/**
 * 结果不明的回执。
 *
 * 既不说成功也不说失败，因为两种说法都可能是假的：响应丢失可能发生在平台已经受理之后。
 * 必须给出批次编号和链接 —— 这是使用者唯一能自己把状态查清楚的东西；并且明确劝阻
 * 立即重提，否则同一条需求会被评审两次、花两份额度。
 */
export function formatSubmissionUnknown(error) {
  return [
    '⚠️ 无法确认这次提交的结果，请不要立即重复提交。',
    '',
    `需求编号：${error.storyCode}`,
    `批次编号（review_batch.id）：${error.batchId}`,
    `平台详情链接：${error.batchUrl}`,
    '',
    `原因：${describePlatformError(error.cause)}`,
    '',
    '平台可能已经受理这条需求，也可能稍后才受理成功（请求超时只说明这边不再等了，',
    '服务端那笔写操作可能仍在进行）。因此这个批次被原样保留、没有删除 —— 删掉一个随后',
    '才成立的任务是不可逆的。请过一两分钟打开上面的链接确认：',
    '  · 页面上已有这条需求或分析任务 → 说明已经受理，等平台跑完即可；',
    '  · 稍后仍是一个没有需求的空批次 → 说明没有受理，可在平台删除该批次后重新提交。',
  ].join('\n')
}
