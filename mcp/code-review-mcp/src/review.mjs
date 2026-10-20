/**
 * 「指定一条需求 → 平台受理一次评审」的提交编排。
 *
 * 这里不做任何评审判断，也不等结果，全部复用平台既有链路（与前端「AI 结果管理 →
 * 开始分析」走同一组 RPC）：
 *
 *   建批次(review_batch) → request_linky_batch_import_for_analysis   ← MCP 到这里就返回
 *   → Worker 在内网取 Linky 正文+附件并冻结进 review_story
 *   → 冻结完成后数据库自动建 analysis_job
 *   → Worker 逐需求跑 Agent → 结论落 ai_review_result(+ai_code_evidence)
 *
 * 两个刻意的选择：
 *
 * 1. **一次调用 = 一个独立批次 = 一张导入单。** 可以带多条需求（V1.66），但它们共享
 *    同一个批次：批次是平台里唯一能同时框住"需求集合 + 代码快照 + 模型"的东西，一次
 *    提交里的几条需求本来就应该在同一个边界里比对。反过来，把**多次**提交塞进同一个
 *    批次仍然不做 —— 那会让"这次评审的结论"没有边界。
 *    多条需求必须属于同一个项目组：导入单只有一个 `workspace_name`，Worker 也只在那个
 *    组的列表里找需求。跨组的拒绝发生在提交之前（见 preflight.mjs）。
 * 2. **受理编号用导入单 id，不伪造分析任务 id。** 分析 Job 是需求冻结完成后由数据库
 *    自动创建的，提交那一刻它还不存在。回一个"看起来像 job id"的东西只会让使用者
 *    拿着查不到的编号去平台里找。
 */

import { PlatformError } from './platform.mjs'
import {
  DEFAULT_TIME_ZONE,
  MAX_STORIES_PER_SUBMIT,
  SUPPORTED_BRANCHES,
  SUPPORTED_COMMIT_WINDOWS,
} from './config.mjs'

/** 核对之间的等待。留出注入点，免得单测真的睡几秒。 */
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 把一个时刻拆成指定时区的年月日时分秒。
 *
 * 用 `Intl` 而不是手工加 8 小时：偏移量不是常数（别的时区有夏令时），而写死 `+8`
 * 会在换一个部署地点时变成一个没人记得的坑。`en-CA` 的 `formatToParts` 给的是补零后的
 * 两位数字，直接可用。
 */
export function zonedParts(date, timeZone = DEFAULT_TIME_ZONE) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
  const parts = {}
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== 'literal') parts[part.type] = part.value
  }
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    // 某些 ICU 版本在 hour12:false 下把午夜给成 "24"，统一压回 "00"。
    hour: parts.hour === '24' ? '00' : parts.hour,
    minute: parts.minute,
    second: parts.second,
  }
}

/**
 * 发布周期编码。
 *
 * 与平台「创建评审批次」弹窗里那三个下拉拼出来的格式**完全一致**：8 位 `YYYYMMDD`。
 * 这一点此前是错的 —— MCP 生成的是 `20261019-MCP174949-20be86`，在批次列表的「发布周期」
 * 那一列里和旁边的 `20261016` 根本不是一类东西，既难读也无法和人工批次比对。
 *
 * **按指定时区格式化，不用运行环境的本地时间。** MCP 容器的 TZ 通常是 UTC，而批次列表里
 * 的「创建时间」是按使用者所在时区渲染的。用容器本地时间的后果实测如下：16:54 提交，
 * 编码里写的是 `085407` —— 差 8 小时；更糟的是北京时间每天 08:00 之前提交，UTC 还在前一天，
 * 日期前缀会整体错一天，于是这个批次在列表里排到昨天去。
 */
export function buildWeekCode(date = new Date(), { timeZone = DEFAULT_TIME_ZONE } = {}) {
  const { year, month, day } = zonedParts(date, timeZone)
  return `${year}${month}${day}`
}

/**
 * 校验调用方给的发布周期。
 *
 * 只卡 8 位数字是不够的：`20260230` 和 `20261332` 都能过正则，却不是真实日期，
 * 落进 `week_code` 之后没有任何地方会再发现它。年份窗口与页面上的下拉保持一致
 * （当前年份的前 2 年到后 3 年），避免 `19700101` 这种明显手滑的值。
 */
export function assertReleaseCycle(input, { now = new Date(), timeZone = DEFAULT_TIME_ZONE } = {}) {
  const raw = String(input ?? '').trim()
  if (raw === '') return null
  if (!/^\d{8}$/.test(raw)) {
    throw new PlatformError(
      `release_cycle 必须是 8 位 YYYYMMDD（例如 20261020），当前是「${raw}」。`,
      { code: 'RELEASE_CYCLE_INVALID' },
    )
  }
  const year = Number(raw.slice(0, 4))
  const month = Number(raw.slice(4, 6))
  const day = Number(raw.slice(6, 8))
  // 用 UTC 构造再比对回去：只要月/日被"滚动"过（2 月 30 日 → 3 月 2 日），就说明日期不存在。
  const probe = new Date(Date.UTC(year, month - 1, day))
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    throw new PlatformError(`release_cycle「${raw}」不是真实存在的日期。`, {
      code: 'RELEASE_CYCLE_INVALID',
    })
  }
  const currentYear = Number(zonedParts(now, timeZone).year)
  if (year < currentYear - 2 || year > currentYear + 3) {
    throw new PlatformError(
      `release_cycle「${raw}」的年份超出允许范围（${currentYear - 2} ~ ${currentYear + 3}）。` +
        '平台页面上的发布周期下拉也是这个范围。',
      { code: 'RELEASE_CYCLE_OUT_OF_RANGE' },
    )
  }
  return raw
}

export function normalizeStoryCode(input) {
  const code = String(input ?? '').trim()
  if (code === '') {
    throw new PlatformError('缺少需求编号（story_code）。', { code: 'STORY_CODE_REQUIRED' })
  }
  if (code.length > 64) {
    throw new PlatformError(`需求编号过长（${code.length} 字符），请确认是否填错。`, {
      code: 'STORY_CODE_INVALID',
    })
  }
  return code
}

/**
 * 归一化这次要评审的编号集合（V1.66）。
 *
 * 两个入口的并集：`story_codes`（多条）与 `story_code`（单条简写）。同时给出不算错 ——
 * 客户端把第一次的入参原样回传、再补一个数组，是很常见的行为；判它参数冲突只会让一次
 * 本来说得通的调用失败。
 *
 * 去重保留**首次出现的顺序**：卡片、日志和回执按使用者给的顺序读起来才对得上。
 * 落库时顺序无关紧要 —— `request_linky_batch_import` 自己会 `distinct … order by code`。
 */
export function normalizeStoryCodes(input, { max = MAX_STORIES_PER_SUBMIT } = {}) {
  const raw = []
  if (Array.isArray(input?.story_codes)) raw.push(...input.story_codes)
  else if (input?.story_codes !== undefined && input?.story_codes !== null) {
    throw new PlatformError('story_codes 必须是数组，例如 ["US-2026-000001","US-2026-000002"]。', {
      code: 'STORY_CODES_INVALID',
    })
  }
  if (input?.story_code !== undefined && input?.story_code !== null) raw.push(input.story_code)

  const codes = []
  const seen = new Set()
  for (const entry of raw) {
    const code = String(entry ?? '').trim()
    if (code === '') continue
    const normalized = normalizeStoryCode(code)
    if (seen.has(normalized)) continue
    seen.add(normalized)
    codes.push(normalized)
  }

  if (codes.length === 0) {
    throw new PlatformError(
      '缺少需求编号。给 story_code（一条）或 story_codes（多条，例如 ' +
        '["US-2026-000001","US-2026-000002"]）其中之一即可。',
      { code: 'STORY_CODE_REQUIRED' },
    )
  }
  if (codes.length > max) {
    throw new PlatformError(
      `一次最多提交 ${max} 条需求，这次给了 ${codes.length} 条。` +
        '限制来自提交前逐条核对的耗时（再多会超过调用方客户端的超时）。' +
        '更大批量请用平台页面的「原始需求导入」勾选导入。',
      { code: 'STORY_CODES_TOO_MANY' },
    )
  }
  return codes
}

/**
 * 批次名。
 *
 * 尽量把全部编号写进去 —— 评审列表里那一列是使用者唯一能分辨"这个批次装了什么"的地方。
 * `review_batch.name` 的上限是 120 字符，装不下时退化成「首条 等 N 条」而不是硬截断：
 * 截断会在列表里留下一个残缺编号，看起来像数据坏了。
 *
 * 按发布窗口提交时（V1.68）直接写窗口 + 条数：那才是使用者心里这个批次的名字，
 * 而 30 多个编号在列表那一列里无论如何也放不下。
 */
export function buildBatchName(prefix, codes, { maxLength = 120, releaseWindow = null } = {}) {
  const base = `${prefix}：`
  const window = String(releaseWindow ?? '').trim()
  if (window !== '') {
    const named = `${base}${window} 共 ${codes.length} 条需求`
    return named.length <= maxLength ? named : named.slice(0, maxLength)
  }
  const full = `${base}${codes.join('、')}`
  if (full.length <= maxLength) return full
  const summary = `${base}${codes[0]} 等 ${codes.length} 条`
  return summary.length <= maxLength ? summary : summary.slice(0, maxLength)
}

export function normalizeWorkspaceName(input) {
  const name = String(input ?? '').trim()
  if (name === '') {
    throw new PlatformError(
      '提交时缺少项目组（workspace_name）。它决定在 Linky 的哪个范围里找这条需求。' +
        '正常流程下它由平台按需求编号反查得到 —— 出现这条报错说明校验环节被跳过了，' +
        '请先调用 lookup_requirement 查一次。',
      { code: 'WORKSPACE_NAME_REQUIRED' },
    )
  }
  return name
}

export function assertBranch(branch) {
  const value = String(branch ?? '').trim()
  if (!SUPPORTED_BRANCHES.includes(value)) {
    throw new PlatformError(
      `branch 只能是 ${SUPPORTED_BRANCHES.join(' / ')}，当前是 ${value === '' ? '（空）' : value}。`,
      { code: 'BRANCH_INVALID' },
    )
  }
  return value
}

export function assertCommitWindow(days) {
  const value = Number(days)
  if (!SUPPORTED_COMMIT_WINDOWS.includes(value)) {
    throw new PlatformError(
      `commit_window_days 只能是 ${SUPPORTED_COMMIT_WINDOWS.join(' / ')}，当前是 ${
        days === undefined || days === null || days === '' ? '（空）' : days
      }。`,
      { code: 'COMMIT_WINDOW_DAYS_INVALID' },
    )
  }
  return value
}

/**
 * 确定本次使用的模型。
 *
 * 模型由**服务端配置**，不开放给调用方 —— 它决定成本与结论质量，而远程调用方看不到
 * 平台的模型配置。配错或停用时必须明确失败，绝不静默换一个模型顶上：那会让两次
 * 评审结果不可比，而使用者不知道换过。
 */
export function resolveConfiguredModel(models, configuredLabel) {
  const usable = models.filter((model) => model.has_api_key !== false)
  if (usable.length === 0) {
    throw new PlatformError(
      '平台当前没有可用模型（需要启用且已配置 API Key），无法受理评审。请联系平台管理员。',
      { code: 'MODEL_CONFIG_NOT_FOUND' },
    )
  }
  const wanted = String(configuredLabel ?? '').trim()
  if (wanted === '') {
    if (usable.length === 1) return usable[0]
    throw new PlatformError(
      'MCP 服务端没有配置默认模型（CRP_DEFAULT_MODEL），而平台有多个可用模型：' +
        `${usable.map((model) => model.display_name).join(' / ')}。请联系 MCP 服务端维护者补上配置。`,
      { code: 'MCP_DEFAULT_MODEL_NOT_CONFIGURED' },
    )
  }
  const hit =
    usable.find((model) => model.id === wanted) ??
    usable.find((model) => String(model.display_name ?? '').toLowerCase() === wanted.toLowerCase())
  if (!hit) {
    throw new PlatformError(
      `MCP 服务端配置的默认模型「${wanted}」在平台上不可用。当前可用：` +
        `${usable.map((model) => model.display_name).join(' / ')}。请联系 MCP 服务端维护者。`,
      { code: 'MCP_DEFAULT_MODEL_UNAVAILABLE' },
    )
  }
  return hit
}

/** 可用模型清单：先按"能创建批次"的口径取，权限不够时退回只读展示名。 */
export async function listModels(client) {
  try {
    const rows = await client.rpc('list_enabled_model_configs')
    return (rows ?? []).map((row) => ({
      id: row.id,
      display_name: row.display_name,
      has_api_key: row.has_api_key !== false,
    }))
  } catch (error) {
    if (error instanceof PlatformError && /permission/i.test(String(error.message))) {
      const rows = await client.rpc('list_model_display_names')
      // 这条通道不回"有没有密钥"，不能假装知道。
      return (rows ?? []).map((row) => ({
        id: row.id,
        display_name: row.display_name,
        has_api_key: undefined,
      }))
    }
    throw error
  }
}

/** 批次详情链接。平台的进度与结论都在批次下的「AI 结果」页。 */
export function buildBatchUrl(webUrl, batchId) {
  return `${String(webUrl).replace(/\/+$/, '')}/batches/${batchId}/ai-result`
}

/**
 * 提交结果无法确定。
 *
 * 它既不是成功也不是失败：后台可能已经受理。携带批次编号与链接，让使用者去平台看一眼，
 * 而不是让他在"已提交"和"没提交"之间猜。
 */
export class SubmissionStateUnknownError extends Error {
  constructor({ batchId, batchUrl, storyCodes, cause }) {
    super(`提交结果无法确认（批次 ${batchId}）`)
    this.name = 'SubmissionStateUnknownError'
    this.batchId = batchId
    this.batchUrl = batchUrl
    this.storyCodes = Array.isArray(storyCodes) ? storyCodes : [storyCodes].filter(Boolean)
    this.cause = cause
  }
}

/**
 * 核对这次写操作的真实结果。
 *
 * 为什么必须核对：`request_linky_batch_import_for_analysis` 的响应丢失（网关超时、
 * 连接被掐、502）可能发生在**事务已经提交之后**。此时盲目删批次，删掉的是平台已经
 * 受理的任务；回一句"没有创建任何评审"也是假话。
 *
 * 为什么"查不到"**不能**当成"没受理"：客户端超时只说明我们不再等了，服务端那笔事务
 * 可能**还在跑**（慢查询、等锁、Worker 抢同一批次的 advisory lock）。此刻去查当然查不到
 * 导入单，但几秒后它就提交了。按"查不到＝没受理"去删批次，删掉的正是一个马上就会成立的
 * 任务，而且删除与提交交错还会留下指向已删批次的导入单。
 *
 * 所以这里只在**服务端明确拒绝**时才回 `NOT_ACCEPTED`（4xx 业务错误＝事务已回滚）。
 * 结果不明时，给那笔可能在飞的事务留出 `settleProbes × settleDelayMs` 的落地时间，
 * 期间反复核对：查到就是 ACCEPTED，始终查不到就是 UNKNOWN —— 宁可在平台上留一个
 * 可见、可手工删除的空批次，也不删一个可能已经受理的任务。
 *
 * 返回：
 *   - `ACCEPTED`     查到导入单 → 这次提交其实成功了，按成功回执返回；
 *   - `NOT_ACCEPTED` 仅限服务端明确拒绝 → 可以安全回收空批次，并如实报失败；
 *   - `UNKNOWN`      结果不明（查不到或查不了）→ 什么都不删，告诉使用者去平台确认。
 */
export async function resolveSubmissionOutcome(
  client,
  batchId,
  cause,
  { settleProbes = 3, settleDelayMs = 2000, probeTimeoutMs = 8000, sleep = defaultSleep } = {},
) {
  if (cause instanceof PlatformError && cause.indeterminate !== true) {
    // 服务端明确拒绝（4xx 业务错误）＝ 事务已回滚，不可能再冒出导入单。
    return { kind: 'NOT_ACCEPTED' }
  }

  let lastProbeError = null
  for (let attempt = 1; attempt <= Math.max(settleProbes, 1); attempt += 1) {
    try {
      const request = await client.rpc(
        'get_latest_linky_batch_import',
        { p_batch_id: batchId },
        { timeoutMs: probeTimeoutMs },
      )
      const importRequestId = typeof request?.id === 'string' ? request.id : null
      if (importRequestId !== null) return { kind: 'ACCEPTED', importRequestId, request }
      lastProbeError = null
    } catch (probeError) {
      lastProbeError = probeError
    }
    if (attempt < Math.max(settleProbes, 1)) await sleep(settleDelayMs)
  }

  // 多次核对都没看到导入单。这**不等于**没受理：那笔事务可能仍未提交。
  return { kind: 'UNKNOWN', probeError: lastProbeError }
}

/**
 * 提交一次需求评审。成功返回受理事实，失败一律抛错 —— 绝不在失败路径上回成功文案。
 *
 * 回收空批次只发生在**服务端明确拒绝**时。结果不明时一律保留批次：代价是平台上多出一个
 * 空批次（看得见、可手工删），而反过来的代价是删掉一个可能已经受理的任务（看不见、删不回）。
 * 两种代价不对称，所以这里不对称地选。
 *
 * @param {object} [options]
 * @param {object} [options.settle] 透传给 `resolveSubmissionOutcome`，测试用来跳过真实等待。
 */
export async function submitRequirementReview(client, config, input, { settle } = {}) {
  const storyCodes = normalizeStoryCodes(input)
  const workspaceName = normalizeWorkspaceName(input.workspace_name)
  /** 按发布窗口提交时带上它；按编号提交时为 null。只做记录，不参与筛选。 */
  const releaseWindow = (() => {
    const raw = String(input.release_window ?? '').trim()
    return raw === '' ? null : raw
  })()
  const branch = assertBranch(input.branch)
  const commitWindowDays = assertCommitWindow(input.commit_window_days)
  const workspaceId = (() => {
    const raw = String(input.workspace_id ?? '').trim()
    if (raw === '') return null
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) {
      throw new PlatformError('workspace_id 必须是 UUID；不确定时不要填，只给 workspace_name。', {
        code: 'WORKSPACE_ID_INVALID',
      })
    }
    return raw
  })()

  const model = resolveConfiguredModel(await listModels(client), config.defaults.modelLabel)

  /**
   * 必须有已登录用户 id：`review_batch` 的插入策略要求 `created_by = auth.uid()`。
   * 不先检查的话，`created_by: null` 会被 RLS 拒绝，而那条报错长得像"账号角色不够"——
   * 维护者会去给账号升权限，真正的原因（登录响应里没有 user）却一直在那里。
   */
  if (typeof client.userId !== 'string' || client.userId === '') {
    throw new PlatformError(
      'MCP 服务端已登录平台账号，但没有拿到用户 id，无法创建批次（批次必须归属到一个真实账号）。' +
        '请让 MCP 维护者检查 CRP_SUPABASE_URL / CRP_SUPABASE_ANON_KEY 与账号登录是否正常。',
      { code: 'PLATFORM_SIGN_IN_FAILED' },
    )
  }

  const timeZone = config.defaults.timeZone ?? DEFAULT_TIME_ZONE
  const now = new Date()
  // 调用方指定了发布周期就用它（已校验是真实日期），否则用当天 —— 与页面默认值一致。
  // V1.61 起 week_code 不再唯一，所以这里不需要候补编码，也不需要为唯一键冲突重试：
  // 同一天提交多次就是同一个发布周期，这在产品上本来就是允许的。
  const requestedCycle = assertReleaseCycle(input.release_cycle, { now, timeZone })
  const weekCode = requestedCycle ?? buildWeekCode(now, { timeZone })

  const batch = await client.insert('review_batch', {
    name: buildBatchName(config.defaults.batchNamePrefix, storyCodes, { releaseWindow }),
    week_code: weekCode,
    default_branch: branch,
    ai_model_config_id: model.id,
    remark: `由远程 MCP 提交（调用方 ${input.caller ?? '未命名'}，平台账号 ${client.email}）`,
    created_by: client.userId,
  })
  const batchUrl = buildBatchUrl(config.platform.webUrl, batch.id)

  let importRequestId = null
  let recovered = false
  try {
    const result = await client.rpc('request_linky_batch_import_for_analysis', {
      p_batch_id: batch.id,
      p_workspace_name: workspaceName,
      p_story_codes: storyCodes,
      p_workspace_id: workspaceId,
      /*
       * 按发布窗口提交时如实记下那个窗口（与平台页面上的那次选择落同一列）。
       *
       * Worker 不用它过滤 —— 它逐条在该项目组的列表里找 `story_codes`；这一列只在
       * 某条需求自身窗口为空时作为兜底（见 complete_linky_batch_import）。
       */
      p_release_window: releaseWindow,
      p_commit_window_days: commitWindowDays,
    })
    importRequestId = typeof result === 'string' && result !== '' ? result : null
    if (importRequestId === null) {
      // 200 却没有受理编号：状态同样不明（函数正常路径一定返回 id），走同一条核对逻辑。
      throw new PlatformError('平台没有返回导入单编号。', {
        code: 'IMPORT_REQUEST_ID_MISSING',
        indeterminate: true,
      })
    }
  } catch (error) {
    const outcome = await resolveSubmissionOutcome(client, batch.id, error, settle)
    if (outcome.kind === 'ACCEPTED') {
      importRequestId = outcome.importRequestId
      recovered = true
    } else if (outcome.kind === 'NOT_ACCEPTED') {
      // 只有服务端明确拒绝才走到这里（事务已回滚，不会再冒出导入单）。
      await client.rpc('delete_review_batch', { p_batch_id: batch.id }).catch(() => undefined)
      throw error
    } else {
      throw new SubmissionStateUnknownError({
        batchId: batch.id,
        batchUrl,
        storyCodes,
        cause: error,
      })
    }
  }

  return {
    batch_id: batch.id,
    batch_name: batch.name,
    week_code: batch.week_code,
    import_request_id: importRequestId,
    story_codes: storyCodes,
    /** 单条提交时沿用这个字段，回执与日志的既有形态不变。 */
    story_code: storyCodes.length === 1 ? storyCodes[0] : null,
    story_title: input.story_title ?? null,
    workspace_name: workspaceName,
    release_window: releaseWindow,
    branch,
    commit_window_days: commitWindowDays,
    model: model.display_name,
    batch_url: batchUrl,
    /** true 表示提交过程中出过异常，但核对后确认平台确实已经受理。 */
    recovered,
  }
}
