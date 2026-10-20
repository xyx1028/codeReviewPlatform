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
import { filterByReleaseWindow, releaseWindowFacet, toRequirementRow } from './query-tools.mjs'

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

/** 本批次里"这一条根本没来得及核对"的原因码。不与上游错误码混用。 */
export const PREFLIGHT_BUDGET_EXCEEDED = 'PREFLIGHT_BUDGET_EXCEEDED'

/**
 * 按发布窗口枚举出来的结论（V1.68）。
 *
 * 和 `VERIFIED` 分开是因为**核对方式不同**：这些需求是从该项目组的需求列表里筛出来的，
 * 字段也只有列表给的那些 —— 没有逐条打开需求详情，所以不知道每条有没有正文、几个附件。
 * 用 `VERIFIED` 顶替会让回执看起来像逐条核对过。
 *
 * 在"编号是否存在、是否属于这个组"这一点上它反而比 `VERIFIED` 更强：需求就是从那份列表里
 * 来的，而 Worker 导入时要求的恰好是"出现在该组列表里"。
 */
export const PREFLIGHT_LISTED = 'LISTED'

/**
 * 枚举一个发布窗口下的全部需求（V1.68）。
 *
 * 三个刻意的选择：
 *
 * 1. **枚举不出来就拒绝，不降级。** 按编号提交时"核对不可用"可以标成未核对照常提交 ——
 *    编号是调用方给的，照样提交得上去。按窗口提交时编号**本身**来自这次枚举：取不到数
 *    就没有任何可提交的东西，此时唯一诚实的回答是失败。
 * 2. **没翻完整组也拒绝。** 这种情况下"这个窗口有 N 条"这句话不可信，而它正是使用者
 *    要确认的东西。宁可让他知道查不全，也不给一个看起来完整的残缺清单。
 * 3. **窗口 0 命中时回窗口分布。** 窗口写错和"这个窗口真的没需求"在返回里长得一样。
 */
export async function preflightReleaseWindow(
  client,
  { workspace_name: workspaceName, release_window: releaseWindow },
  { maxPages = 5 } = {},
) {
  const workspace = text(workspaceName)
  const window = text(releaseWindow)
  const reject = (code, message) => ({
    status: PREFLIGHT_REJECTED,
    entries: [],
    facet: null,
    workspaceName: workspace,
    releaseWindow: window,
    reason: { code, message },
  })

  if (workspace === null) {
    return reject(
      'WORKSPACE_NAME_REQUIRED',
      '按发布窗口提交必须指定项目组（workspace_name）：平台要先列出这个组的需求才能知道' +
        '这个窗口下有哪些。不知道项目组全名就先调 list_workspaces。',
    )
  }
  if (window === null) {
    return reject('RELEASE_WINDOW_REQUIRED', '缺少发布窗口（release_window）。')
  }
  if (client === null) {
    return reject(
      'PREFLIGHT_DISABLED',
      'MCP 服务端没有配置 Linky 取数地址（CRP_LINKY_API_BASE_URL），无法列出这个窗口下的需求。' +
        '按发布窗口提交依赖这一步 —— 枚举不出来就没有可提交的需求。' +
        '可以改为直接给 story_codes（编号列表）提交。',
    )
  }

  let outcome
  try {
    outcome = await client.listStories({ workspaceName: workspace, maxPages })
  } catch (error) {
    return reject(
      error?.code ?? 'LINKY_UNREACHABLE',
      `列不出项目组「${workspace}」的需求（${String(error?.message ?? error)}）。` +
        (error?.code === 'LINKY_UPSTREAM_AUTH_FAILED'
          ? '这不是你的网络问题：需要质量执行平台的维护者在「配置 › Linky 工作区」更新 token。'
          : 'MCP 服务端此刻取不到 Linky 数据（它可能不在公司内网）。') +
        '按发布窗口提交依赖这一步，所以没有提交任何需求。',
    )
  }

  const rows = outcome.items.map(toRequirementRow).filter((row) => row !== null)
  const facet = releaseWindowFacet(rows)

  if (outcome.complete !== true) {
    return {
      ...reject(
        'WORKSPACE_LIST_INCOMPLETE',
        `项目组「${workspace}」上游报总数 ${outcome.total} 条，这次没有翻完全部分页，` +
          '所以"这个窗口有几条需求"这句话现在不可信 —— 而它正是要你确认的东西。' +
          '没有提交任何需求。请改用平台页面的「原始需求导入」勾选，或先用 ' +
          'search_requirements 缩小范围确认编号后按 story_codes 提交。',
      ),
      facet,
    }
  }

  const matched = filterByReleaseWindow(rows, window)
  if (matched.length === 0) {
    return {
      ...reject(
        'RELEASE_WINDOW_NOT_FOUND',
        `项目组「${workspace}」里没有发布窗口为「${window}」的需求（已翻完 ${outcome.total} 条）。` +
          '没有提交任何评审。请按返回里列出的真实窗口取值重试。',
      ),
      facet,
    }
  }

  return {
    status: PREFLIGHT_LISTED,
    entries: matched.map((row) => ({
      story_code: row.code,
      status: PREFLIGHT_LISTED,
      corrections: [],
      reason: null,
      story: {
        story_code: row.code,
        title: row.title,
        workspace_name: workspace,
        status_label: row.status,
        iteration: row.iteration,
        release_window: row.release_window,
        subject_name: row.subject,
        assignee_name: row.assignee,
      },
    })),
    facet,
    workspaceName: workspace,
    releaseWindow: window,
    corrections: [],
    reason: null,
    /** 这一组是在这个时刻枚举出来的；令牌绑定的是它，而不是"这个窗口"这个条件。 */
    total: outcome.total,
  }
}

/**
 * 核对一次提交里的**全部**需求（V1.66）。
 *
 * 三件事是这一层独有的，单条核对里不存在：
 *
 * 1. **并发 + 总预算。** 按编号取详情实测命中 5.84 秒、未命中 31.80 秒。串行 20 条会把
 *    一次工具调用拖到两分钟以上，而调用方客户端通常 60 秒就放弃 —— 使用者看到的只是
 *    "tool call failed"，连哪几条有问题都不知道。所以并发跑，并且**整体**有预算：
 *    预算用完时剩下的编号标成"没来得及核对"，如实写在卡片上，不假装核对过、也不挂死。
 * 2. **项目组一致性。** 一张导入单只有一个 workspace。编号分属不同组时必须在建批次之前
 *    拒绝，并把"哪条属于哪个组"逐条说清 —— 否则导入会以这几条逐个 LINKY_NOT_FOUND 收场。
 * 3. **缺失即整次拒绝。** 有编号被确定判为不存在时不做"替你剔掉那条照常提交"：
 *    那会让使用者以为 5 条都在跑，实际只有 4 条，而回执里看不出差别。
 *
 * @returns {Promise<{status:string, entries:object[], workspaceName:string|null,
 *   corrections:object[], reason:object|null}>}
 */
export async function preflightRequirements(
  client,
  { story_codes: storyCodes, workspace_name: workspaceName = null },
  {
    budgetMs = 45_000,
    concurrency = 4,
    now = () => Date.now(),
  } = {},
) {
  const codes = [...storyCodes]
  const listCache = new Map()
  const results = new Map()
  const deadline = now() + Math.max(budgetMs, 1)

  let cursor = 0
  const worker = async () => {
    while (cursor < codes.length) {
      const index = cursor
      cursor += 1
      const code = codes[index]
      if (now() >= deadline) {
        results.set(code, {
          status: PREFLIGHT_UNVERIFIED,
          story: null,
          corrections: [],
          reason: {
            code: PREFLIGHT_BUDGET_EXCEEDED,
            message:
              '这一条没有核对 —— 本次核对的总时间预算已经用完（前面有编号在上游查了很久，' +
              '通常意味着那些编号不存在）。它的项目组与内容都没有被确认。',
          },
        })
        continue
      }
      results.set(
        code,
        await preflightRequirement(client, { story_code: code, workspace_name: workspaceName }, { listCache }),
      )
    }
  }
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, codes.length)) }, () => worker()),
  )

  const entries = codes.map((code) => ({ story_code: code, ...results.get(code) }))

  // 一条都没核对成（最常见：MCP 不在内网）→ 整体未校验，原因取第一条的真实原因。
  const verified = entries.filter((entry) => entry.status === PREFLIGHT_VERIFIED)
  const rejected = entries.filter((entry) => entry.status === PREFLIGHT_REJECTED)

  if (rejected.length > 0) {
    return {
      status: PREFLIGHT_REJECTED,
      entries,
      workspaceName: null,
      corrections: [],
      reason: {
        code: 'STORY_NOT_FOUND',
        message:
          `这 ${rejected.length} 条需求在 Linky 里找不到（已遍历全部启用的工作区）：` +
          `${rejected.map((entry) => entry.story_code).join('、')}。` +
          '整次提交已取消，平台上没有创建任何评审 —— 不替你剔掉它们照常提交，' +
          '否则你会以为全部需求都在评审。请核对编号后重新提交。',
      },
    }
  }

  // 项目组必须唯一。只看核对成功的那些 —— 没核对成的本来就不知道归属。
  const workspaces = [...new Set(verified.map((entry) => entry.story.workspace_name))]
  if (workspaces.length > 1) {
    return {
      status: PREFLIGHT_REJECTED,
      entries,
      workspaceName: null,
      corrections: [],
      reason: {
        code: 'WORKSPACE_MIXED',
        message:
          '这些需求不属于同一个项目组，不能放进同一个批次（一张需求导入单只有一个项目组，' +
          '平台页面上的导入也是这个规则）。实际归属：' +
          verified
            .map((entry) => `${entry.story_code} → ${entry.story.workspace_name}`)
            .join('；') +
          '。请按项目组分成多次提交。',
      },
    }
  }

  const resolvedWorkspace = workspaces[0] ?? null
  const corrections = []

  if (resolvedWorkspace !== null) {
    const given = text(workspaceName)
    if (given !== null && given !== resolvedWorkspace) {
      corrections.push({
        field: 'workspace_name',
        given,
        resolved: resolvedWorkspace,
        note:
          '上游按名称**精确匹配**，而且不存在的项目组返回的是空列表而不是报错 —— ' +
          '所以这个名字如果不改，导入会以"全部导入失败"收场。已按实际值提交。',
      })
    } else if (given === null) {
      corrections.push({
        field: 'workspace_name',
        given: null,
        resolved: resolvedWorkspace,
        note: '你没有指定项目组，已按需求编号反查到的实际项目组填入。',
      })
    }
  }

  // 逐条的提醒（正文为空、不在列表里）按编号前缀合并上来，卡片上才能指明是哪一条。
  for (const entry of entries) {
    for (const item of entry.corrections) {
      if (item.field === 'workspace_name') continue
      corrections.push({ ...item, story_code: entry.story_code })
    }
  }

  if (verified.length === 0) {
    return {
      status: PREFLIGHT_UNVERIFIED,
      entries,
      workspaceName: text(workspaceName),
      corrections,
      reason: entries[0]?.reason ?? {
        code: 'PREFLIGHT_DISABLED',
        message: '没能核对任何一条需求。',
      },
    }
  }

  return {
    status: verified.length === entries.length ? PREFLIGHT_VERIFIED : PREFLIGHT_UNVERIFIED,
    entries,
    workspaceName: resolvedWorkspace,
    corrections,
    reason:
      verified.length === entries.length
        ? null
        : {
            code: 'PREFLIGHT_PARTIAL',
            message:
              `${entries.length} 条里有 ${entries.length - verified.length} 条没有核对成功（逐条原因见下）。` +
              '它们仍会被提交到同一个批次，但如果其中某条其实不属于' +
              `「${resolvedWorkspace}」，平台导入时会单独报这一条失败。`,
          },
  }
}

/**
 * 核对一次提交里的单条需求。
 *
 * 绝不抛错：三种结论都以返回值表达，由上层决定"拒绝提交"还是"要求确认"。
 * 让它抛错会把"校验连不上"和"参数确实错了"混成同一条失败路径，而这两件事的处置相反。
 *
 * @param {object} input 调用方给的原始参数（`story_code` 必有，`workspace_name` 可空）
 * @param {object} [options]
 * @param {Map<string, Promise<object|null>>} [options.listCache]
 *   项目组 → 列表查询 Promise 的缓存。多条需求一起核对时必须传：按组查询实测
 *   1.05 秒/200 条，不共享的话 N 条需求就是 N 次**完全相同**的查询。
 * @returns {Promise<{status:string, story:object|null, corrections:object[], reason:object|null}>}
 */
export async function preflightRequirement(client, input, { listCache = null } = {}) {
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

  /**
   * 用列表端点补齐详情端点给不出来的字段，并顺手验一件要紧的事。
   *
   * 两个目的：
   *
   * 1. **补字段。** 可读的「迭代 / 发布窗口 / 关联特性 / 负责人」只有列表端点给，
   *    详情端点这几项是 null（实测 US-2026-017341：详情 iteration=null，
   *    列表 iteration='202610-1（0928-1016）'、release_window='R20261030'）。
   *    不补的话确认卡片上这几行只能显示"空"，而它们在上游明明有值 —— 那是在误导使用者。
   *
   * 2. **验导入前提。** Worker 导入时要求需求**出现在该项目组的列表里**
   *    （可读字段只能从列表取，取不到就整条失败）。所以"详情查得到、列表里没有"
   *    这种情况会让一次看起来核对通过的提交照样导入失败。只有在**确实翻完整个范围**
   *    （`complete === true`）时，"列表里没有"才等于"不在这个组里"，才值得预警。
   *
   * 这一步失败不影响结论：补充字段拿不到就不补，不把一次成功的核对降级成失败。
   */
  let listedItem = null
  let listOutcome = null
  if (typeof client.listStories === 'function') {
    /*
     * 缓存里放的是 **Promise** 而不是结果。
     *
     * 多条需求是并发核对的：如果等拿到结果再写缓存，几条需求会在同一瞬间都看到"缓存里
     * 没有"，于是同一个项目组的列表被查好几遍 —— 那正是这个缓存要避免的事。
     * 失败的 Promise 也留在缓存里（下面 catch 成 null），否则每条需求都会重试一次
     * 同一个失败的查询。
     */
    if (listCache !== null && listCache.has(actualWorkspace)) {
      listOutcome = await listCache.get(actualWorkspace)
    } else {
      const pending = Promise.resolve()
        .then(() => client.listStories({ workspaceName: actualWorkspace }))
        // 列表取不到就只用详情的字段。核对结论不因为"补充信息缺失"而变化。
        .catch(() => null)
      listCache?.set(actualWorkspace, pending)
      listOutcome = await pending
    }
  }
  if (listOutcome !== null) {
    listedItem =
      listOutcome.items.find(
        (item) => typeof item === 'object' && item !== null && text(item.code) === story.story_code,
      ) ?? null
  }
  if (listedItem !== null) {
    story.iteration = text(listedItem.iteration) ?? story.iteration
    story.release_window = text(listedItem.release_window) ?? story.release_window
    story.subject_name = text(listedItem.subject) ?? story.subject_name
    story.assignee_name = text(listedItem.assignee) ?? story.assignee_name
    story.status_label = text(listedItem.status) ?? story.status_label
  } else if (listOutcome !== null && listOutcome.complete === true) {
    corrections.push({
      field: 'story_in_workspace',
      given: null,
      resolved: `不在「${actualWorkspace}」的需求列表里`,
      note:
        `Linky 的详情接口说这条需求属于「${actualWorkspace}」，但它没有出现在该项目组的` +
        `需求列表里（已翻完 ${listOutcome.total} 条）。平台导入时要求需求出现在列表里` +
        '（可读的迭代/发布窗口只能从列表取），所以这次提交很可能以"全部导入失败"收场。' +
        '建议先在平台「用户故事」看板上确认这条需求的归属。',
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
