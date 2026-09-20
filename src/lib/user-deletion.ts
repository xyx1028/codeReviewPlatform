/**
 * 删除用户的展示逻辑（V1.10）。
 *
 * 这些判断刻意放在纯函数里而不是散在组件 JSX 中：它们决定「确认按钮能不能点」和
 * 「管理员看到的拒绝理由是什么」，是这个功能里最容易出错、也最需要能单测的部分。
 *
 * 一条硬规则：**能不能删由数据库说，前端只负责翻译。** 前端不重算引用、不猜原因 ——
 * 数据库以后新增一张引用表时，界面会自动显示它返回的标签，而不是变成"未知原因不能删"。
 */

/** 数据库返回的一条阻止性引用。`label` 由数据库给，前端不维护表名到中文的映射。 */
export interface UserDeletionBlockingReference {
  table: string
  label: string
  count: number
}

/** `admin_get_user_deletion_impact` / `admin_delete_user` 的返回形状。 */
export interface UserDeletionImpact {
  can_delete: boolean
  /** 不可删时的稳定错误码；可删时为 null。 */
  code: string | null
  user: {
    id: string
    email: string | null
    display_name: string | null
    role: string | null
    created_at: string | null
  }
  blocking_references: UserDeletionBlockingReference[]
  /** 会一并删除的附属数据条数。 */
  cascade_counts: Record<string, number>
  /** 会被置空（SET NULL）的引用条数。 */
  nullify_counts: Record<string, number>
}

/**
 * 拒绝码 → 给人看的原因。
 *
 * 不包含 `USER_HAS_REFERENCES`：那一类的原因是**逐条引用清单**，用一句笼统的话代替它
 * 等于把管理员最需要的信息（到底是哪些东西挡着）丢掉。
 */
const REFUSAL_REASONS: Record<string, string> = {
  CANNOT_DELETE_SELF: '不能删除自己的账号。请让另一位管理员来操作。',
  CANNOT_DELETE_LAST_ADMIN:
    '这是最后一个管理员账号。请先把另一个账号设为管理员，再删除这个账号。',
  USER_NOT_FOUND: '这个账号已经不存在了，可能刚被其他管理员删除。请刷新列表。',
}

/** 附属数据的中文标签。这些是账号自身的东西，删账号本来就该带走它们。 */
const CASCADE_LABELS: Record<string, string> = {
  wechat_identity: '微信绑定',
  auth_sessions: '登录会话',
  auth_identities: '登录身份（邮箱/第三方）',
}

/** 会被置空的引用标签。技能版本本身不动，只是作者信息丢失。 */
const NULLIFY_LABELS: Record<string, string> = {
  review_skill: '技能（作者将置空）',
  review_skill_version: '技能版本（发布人将置空）',
  review_skill_upload: '技能上传记录（上传人将置空）',
  developer_identity: 'Git 身份（将退回未认领，历史分析不受影响）',
  analysis_scope_decision_audit: '归属决策审计（操作人将置空，记录本身保留）',
}

/** 把 `{key: count}` 转成 `[{label, count}]`，只保留 count > 0 的项。 */
function toLabeledCounts(
  counts: Record<string, number> | null | undefined,
  labels: Record<string, string>,
): Array<{ label: string; count: number }> {
  if (!counts) return []
  return Object.entries(counts)
    .filter(([, count]) => Number(count) > 0)
    .map(([key, count]) => ({ label: labels[key] ?? key, count: Number(count) }))
}

export interface UserDeletionView {
  /** 确认按钮是否可点。 */
  canConfirm: boolean
  /** 不可删时的一句话原因；可删时为 null。 */
  refusalReason: string | null
  /** 阻止删除的引用清单（`USER_HAS_REFERENCES` 时非空）。 */
  blocking: Array<{ label: string; count: number }>
  /** 会一并删除的附属数据。 */
  cascade: Array<{ label: string; count: number }>
  /** 会被置空的引用。 */
  nullify: Array<{ label: string; count: number }>
}

/**
 * 把数据库的影响评估翻译成弹窗要展示的内容。
 *
 * `impact` 为 null 表示还在加载：此时既不能确认，也不该显示任何拒绝理由 —— 否则弹窗刚
 * 打开的那一瞬间会闪出一句错误的"可以删除"或"不能删除"。
 */
export function buildUserDeletionView(impact: UserDeletionImpact | null): UserDeletionView {
  if (impact === null) {
    return { canConfirm: false, refusalReason: null, blocking: [], cascade: [], nullify: [] }
  }
  const blocking = (impact.blocking_references ?? []).map((item) => ({
    label: item.label,
    count: Number(item.count),
  }))
  const refusalReason = impact.can_delete
    ? null
    : impact.code === 'USER_HAS_REFERENCES'
      ? '这个账号已经在平台里留下了工作记录，删掉会破坏这些记录的归属，所以不能删除。'
      : (REFUSAL_REASONS[impact.code ?? ''] ?? '这个账号当前不能删除。')
  return {
    canConfirm: impact.can_delete === true,
    refusalReason,
    blocking,
    cascade: toLabeledCounts(impact.cascade_counts, CASCADE_LABELS),
    nullify: toLabeledCounts(impact.nullify_counts, NULLIFY_LABELS),
  }
}

/**
 * 删除失败时把数据库错误翻成人话。
 *
 * 走的是同一张码表，所以"弹窗里的拒绝理由"和"点了确认之后的报错"用词一致 —— 两处各写
 * 一份文案的结果是同一个原因在界面上有两种说法。
 */
export function describeUserDeletionError(message: string): string {
  for (const [code, reason] of Object.entries(REFUSAL_REASONS)) {
    if (message.includes(code)) return reason
  }
  if (message.includes('USER_HAS_REFERENCES')) {
    return '这个账号已经在平台里留下了工作记录，不能删除。请刷新后查看具体原因。'
  }
  if (message.includes('ADMIN role required')) {
    return '只有管理员可以删除账号。'
  }
  return message
}
