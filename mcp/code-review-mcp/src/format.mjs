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

/** 固定提示语。首版的全部语义都压在这一句上，不允许各处改写。 */
export const SUBMITTED_NOTICE =
  '评审任务已提交，执行需要较长时间，请前往代码评审平台查看进度和结果。'

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
  if (/duplicate key value|week_code/i.test(raw)) {
    return `创建批次时与既有批次的发布周期编码相撞，请原样重试一次。（原始报错：${raw}）`
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
    '',
    `批次编号（review_batch.id）：${receipt.batch_id}`,
    `批次名称：${receipt.batch_name}`,
    `发布周期编码：${receipt.week_code}`,
    `任务受理编号（需求导入单 linky_batch_import_request.id）：${receipt.import_request_id}`,
    '',
    `需求编号：${receipt.story_code}`,
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
