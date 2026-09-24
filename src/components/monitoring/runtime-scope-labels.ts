/**
 * 分析范围卡片上的码表与口径解释。
 *
 * 单独成文件不是洁癖：这些常量原来和组件放在一起，Fast Refresh 会因为"文件里既有组件又有
 * 常量导出"而整页重载（oxlint 的 react/only-export-components）。而漂移守卫测试需要导入它们。
 */
// 归因规则可由管理员在「归因规则」页自定义 reason_code，这里只翻译系统预置的规则；
// 未命中的自定义代码原样展示，不猜测含义——鼠标悬停可以看到原始代码。
export const REASON_CODE_LABELS: Record<string, string> = {
  EXPLICIT_STORY_ID: '提交说明明确标注需求号',
  EXPLICIT_MR_STORY_ID: '合并请求明确标注需求号',
  SAME_EXPLICIT_MR: '同一明确合并请求内的提交',
  STORY_CODE_WITH_SUPPORT: '标题/分支命中需求号且有辅助线索',
  OWNER_WINDOW_MODULE: '开发人员 + 时间窗 + 模块重合',
  UNSTRUCTURED_STORY_MENTION: '正文提及需求号',
  OTHER_STORY_EXPLICIT: '明确属于其它需求',
  REVERT_OF_RELATED_COMMIT: '回滚了关联提交',
  BOT_OR_GENERATED: '机器人或生成文件',
  IDENTITY_AMBIGUOUS: '开发人员身份冲突',
  RANGE_INCOMPLETE: '范围不完整降级',
  NO_CANDIDATE: '无候选降级',
  RULE_CONFLICT: '规则冲突降级',
  // 线上占比最高的两个码，之前没翻译，界面上就是一串英文（实测 355 / 45 次）。
  WEAK_ATTRIBUTION_SIGNAL: '仅弱线索（作者或模块）',
  VERIFIED_OWNER: '作者是已验证的需求负责人',
  MODULE_OVERLAP: '改动模块与需求重合',
  OUTSIDE_FROZEN_HEAD: '不在冻结版本的历史里',
  RANGE_TOO_LARGE: '提交范围过大',
  STRONG_SIGNAL_CONFLICT: '强信号互相冲突',
  EFFECTIVE_REVERTED: '最终已被回滚',
  EFFECTIVE_SUPERSEDED: '已被后续提交取代',
}

/*
 * 范围降级/失败原因。
 *
 * 这些码原来是原样显示的（界面上就是一行 `WEAK_CANDIDATES_CAPPED`），使用者无法从字面
 * 知道发生了什么，也不知道该怎么办。每条都给一句"发生了什么 + 意味着什么 + 怎么改善"，
 * 原始码仍然在标题旁的浅色文字里保留，便于对着日志和这里的文档检索。
 */
export const SCOPE_ERROR_META: Record<string, { label: string; hint: string }> = {
  WEAK_CANDIDATES_CAPPED: {
    label: '弱线索候选过多，已截断到上限',
    hint: '没有提交写明该需求号，平台只能按「作者是需求负责人」这类弱线索挑候选；符合条件的提交超过 30 条上限，只保留了排序靠前的 30 条交给 AI 核实，其余不进入本次分析。'
      + '想彻底解决：在提交说明标题里写上需求号（负责人提交时即构成强关联），或缩短时间窗。',
  },
  STORY_CANDIDATE_LIMIT_TRUNCATED: {
    label: '候选总数超过上限，已按优先级截断',
    hint: '候选提交超过 200 条（数据库硬上限），按「强关联 → AI 候选 → 弱线索」的顺序保留信息量最高的一批，其余不进入本次分析。',
  },
  NO_CANDIDATE: {
    label: '没有找到任何候选提交',
    hint: '冻结范围内没有一条提交与该需求产生关联（既没写需求号，作者也不是已验证的需求负责人），因此退化为全仓分析：AI 会在四个仓库的冻结版本里直接检索实现。',
  },
  NO_STRONG_SCOPE: {
    label: '没有能收窄范围的候选',
    hint: '有一些弱线索提交，但都不足以把分析范围收窄（例如作者身份没有映射到已验证的 Git 邮箱），因此退化为全仓分析。到「用户管理 → Git 身份」把负责人的 Git 邮箱配好可以改善。',
  },
  RANGE_INCOMPLETE: {
    label: '仓库提交范围不完整',
    hint: '浅克隆没能回溯到范围起点、范围过大或枚举失败。此时平台拒绝伪装成精准分析，直接退化为全仓分析。',
  },
  RANGE_TOO_LARGE: {
    label: '提交范围过大',
    hint: '范围内的提交数超过单次枚举上限，无法冻结完整清单，因此退化为全仓分析。可以缩短时间窗后重跑。',
  },
  RULE_CONFLICT: {
    label: '归属规则冲突',
    hint: '同优先级的规则得出互斥结论，平台不做猜测，直接退化为全仓分析。',
  },
  IDENTITY_AMBIGUOUS: {
    label: '开发人员身份冲突',
    hint: '同一个姓名或邮箱指纹映射到多个开发人员，无法确定归属，因此忽略身份强度并标记冲突。',
  },
  // V1.16 之前的旧码：那时候一超上限就整条降级成全仓分析，连已命中的强关联证据一起丢掉。
  // 历史任务的范围卡片仍会显示它，所以文案要留着。
  STORY_CANDIDATE_LIMIT_EXCEEDED: {
    label: '候选超过上限（旧策略：整体降级）',
    hint: '这是 V1.16 之前的行为：候选一旦超过上限就把整个需求降级为全仓分析。现在改为按优先级截断并保留强关联证据，新任务不会再出现这个码。',
  },
  PARTIAL_SCOPE_DEGRADED: {
    label: '本批次有部分需求降级',
    hint: '同一个分析任务里至少有一个需求的范围被降级，具体原因看各需求自己的范围卡片。',
  },
}

/** 六个统计口径的解释。数字全部来自后端冻结事实，不由前端推算。 */
export const SCOPE_METRIC_HINTS = {
  candidate: '平台冻结下来、需要 AI 逐条核实的提交数。已经过上限截断，不一定是范围内的全部提交。',
  strong: '证据已足够确定属于该需求的提交数（例如提交说明或合并请求明确写了需求号），不需要 AI 再判。',
  aiRelated: 'AI 读过 diff 后判定「与该需求相关」的提交数。',
  aiUncertain: 'AI 读过 diff 但无法确定是否相关的提交数。数字偏大通常说明候选是靠弱线索挑出来的。',
  read: 'AI 真正调用工具读过 diff 的候选提交数（按提交去重）。小于候选数说明还没裁完或被跳过。',
  reverted: '这些候选提交后来被回滚，最终代码里不生效；AI 判定时会看到这个状态。',
} as const
