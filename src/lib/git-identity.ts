import type { DeveloperIdentityStatus, GitEmailDiscovery } from '../types'

/**
 * Git 身份状态的展示元数据。
 *
 * 与数据库的 4 个取值一一对应：多一个前端自造的状态，界面上就会出现数据库里不存在的说法。
 */
export const GIT_IDENTITY_STATUS_META: Record<DeveloperIdentityStatus, { label: string; color?: string }> = {
  VERIFIED: { label: '生效中', color: 'green' },
  UNVERIFIED: { label: '待确认', color: 'orange' },
  CONFLICT: { label: '冲突', color: 'red' },
  DISABLED: { label: '已停用' },
}

/**
 * 把自助 Git 身份 RPC 的稳定错误码翻成人话。
 *
 * 前端不重新判断"能不能保存"：邮箱唯一性、身份锁定、乐观锁全部由 RPC 判定。
 * 前端自行推断的结果只会让同一个原因在界面上有两种说法。
 */
export function describeGitIdentityError(message: string): string {
  if (message.includes('IDENTITY_PEPPER_MISSING')) {
    return '平台还没有配置身份加密密钥（Vault 里的 analysis_identity_pepper），请联系管理员配置后再试。'
  }
  if (message.includes('GIT_EMAIL_ALREADY_BOUND')) {
    return '这个 Git 邮箱已经绑定在另一个成员名下。请确认邮箱，或联系管理员处理冲突。'
  }
  if (message.includes('DEVELOPER_EMPLOYEE_CODE_CONFLICT')) {
    return '这个员工号已被另一条开发人员身份占用，请联系管理员核对。'
  }
  if (message.includes('DEVELOPER_IDENTITY_LOCKED')) {
    return '你的开发人员身份被标记为冲突或已停用，需要管理员先处理。'
  }
  if (message.includes('DEVELOPER_DISPLAY_NAME_REQUIRED')) return '请填写与需求一致的开发人员姓名。'
  if (message.includes('DEVELOPER_DISPLAY_NAME_TOO_LONG')) return '用户名不能超过 32 个字符。'
  if (message.includes('DEVELOPER_DISPLAY_NAME_INVALID')) return '用户名不能包含控制字符。'
  if (message.includes('DEVELOPER_EMPLOYEE_CODE_INVALID')) return '员工号不能超过 32 个字符，也不能包含控制字符。'
  if (message.includes('USER_PROFILE_NOT_FOUND')) return '找不到你的账号资料，请重新登录后再试。'
  if (message.includes('IDENTITY_EMAIL_INVALID')) return '邮箱格式不正确。'
  if (message.includes('REVISION_CONFLICT')) return '记录已被其他地方更新，请刷新页面后重试。'
  if (message.includes('GIT_IDENTITY_NOT_FOUND')) return '这条记录不存在或不属于你。'
  // V1.13 表格里的编辑 / 删除
  if (message.includes('GIT_IDENTITY_IN_USE')) {
    return '这条邮箱已经被历史分析引用，删除会切断那些结论的追溯链。请改用「停用」。'
  }
  if (message.includes('GIT_IDENTITY_DISABLED')) {
    return '这条记录已停用，不能再编辑。需要重新使用请新增一条。'
  }
  if (message.includes('GIT_IDENTITY_WOULD_MATCH_NOTHING')) {
    return '这条记录没有邮箱，清空别名和 GitLab 用户名后就匹配不到任何提交了。请至少保留一项。'
  }
  if (message.includes('AUTHOR_ALIAS_LIMIT_EXCEEDED')
    || message.includes('GIT_IDENTITY_TOO_MANY_ALIASES')) return '作者别名最多 10 个（去重后计算）。'
  if (message.includes('GIT_IDENTITY_ALIAS_INVALID')) {
    return '作者别名不能超过 64 个字符，也不能包含控制字符。'
  }
  if (message.includes('DEVELOPER_IDENTITY_NOT_FOUND')) return '你还没有配置过 Git 身份。'
  if (message.includes('AUTH_REQUIRED')) return '登录状态已失效，请重新登录。'
  // V1.13 反查链路
  if (message.includes('GITLAB_USERNAME_INVALID')) {
    return 'GitLab 用户名只能包含字母、数字、下划线、点和短横线。'
  }
  if (message.includes('GITLAB_USER_NOT_FOUND')) {
    return 'GitLab 上找不到这个用户名，请到 GitLab 个人设置里核对 Path 那一栏。'
  }
  if (message.includes('GITLAB_API_TOKEN_MISSING')) {
    return 'Worker 还没有配置 GitLab 只读 token（GITLAB_API_TOKEN），无法查询，请联系管理员。'
  }
  if (message.includes('MR_METADATA_PERMISSION_DENIED')) {
    return 'GitLab 拒绝了这次查询（token 权限不足或已过期），请联系管理员。'
  }
  if (message.includes('MR_METADATA_TIMEOUT') || message.includes('MR_METADATA_REQUEST_FAILED')) {
    return '连不上 GitLab（超时或网络不可达）。确认 Worker 所在机器能访问 GitLab 后重试。'
  }
  if (message.includes('GIT_EMAIL_DISCOVERY_RATE_LIMITED')) {
    return '查询太频繁了，请过几分钟再试。'
  }
  if (message.includes('GIT_EMAIL_DISCOVERY_ATTEMPTS_EXHAUSTED')) {
    return '多次尝试都没成功，请稍后重试或联系管理员查看 Worker 日志。'
  }
  if (message.includes('GIT_EMAIL_DISCOVERY_EXPIRED')) {
    return '这次查询结果已经过期（超过 2 小时），请重新查找后再保存。'
  }
  if (message.includes('GIT_EMAIL_DISCOVERY_NOT_READY')) return '查询还没完成，请等它结束。'
  if (message.includes('GIT_EMAIL_CANDIDATE_NOT_FOUND')) {
    return '这个候选不存在或不属于你，请重新查找。'
  }
  if (message.includes('GIT_EMAIL_DISCOVERY_NOT_FOUND')) return '找不到这次查询记录。'
  if (message.includes('GIT_EMAIL_DISCOVERY_FAILED')) return '查找提交邮箱失败，请重试。'
  return message
}

/** 轮询多久还没有 Worker 领取，就认定"没有可用 Worker"而不是继续转圈。 */
export const GIT_EMAIL_DISCOVERY_CLAIM_TIMEOUT_MS = 180_000

export type GitEmailDiscoveryPhase =
  // IDLE 也带 hint（空串）：让整个联合类型都有这个字段，调用方不必先做类型收窄。
  | { kind: 'IDLE'; hint: string }
  | { kind: 'WAITING_WORKER'; hint: string }
  | { kind: 'RUNNING'; hint: string }
  | { kind: 'NO_WORKER'; hint: string }
  | { kind: 'DONE_EMPTY'; hint: string }
  | { kind: 'DONE'; hint: string }
  | { kind: 'FAILED'; hint: string }

/**
 * 把一次反查的状态翻成界面要显示的一句话。
 *
 * 判据只有后端事实：`claimed` 说明有 Worker 真的领了这个任务。排队超时不假装"正在查找"，
 * 而是明确告诉用户"当前没有可用的 Worker"——否则用户会一直等一个不会发生的结果。
 */
export function describeGitEmailDiscoveryPhase(
  discovery: Pick<GitEmailDiscovery, 'status' | 'claimed' | 'candidate_count' | 'merge_request_count'
    | 'partial' | 'error_code' | 'error_message' | 'gitlab_username' | 'lookback_days'> | null,
  elapsedMs: number,
): GitEmailDiscoveryPhase {
  if (discovery === null) return { kind: 'IDLE', hint: '' }
  if (discovery.status === 'FAILED') {
    return {
      kind: 'FAILED',
      hint: describeGitIdentityError(discovery.error_code ?? discovery.error_message ?? 'GIT_EMAIL_DISCOVERY_FAILED'),
    }
  }
  if (discovery.status === 'SUCCEEDED') {
    const partialHint = discovery.partial ? '；部分仓库或较早的记录没能全部读到，结果可能不全' : ''
    if (discovery.candidate_count === 0) {
      return {
        kind: 'DONE_EMPTY',
        hint: `在四个仓库近 ${discovery.lookback_days} 天里没有找到 ${discovery.gitlab_username} 提的合并申请`
          + `，所以查不到提交邮箱${partialHint}。`,
      }
    }
    return {
      kind: 'DONE',
      hint: `从 ${discovery.merge_request_count} 个合并申请里找到 ${discovery.candidate_count} 个候选邮箱${partialHint}。`,
    }
  }
  if (discovery.status === 'RUNNING' || discovery.claimed) {
    return { kind: 'RUNNING', hint: '正在读取 GitLab 上你提的合并申请…' }
  }
  if (elapsedMs > GIT_EMAIL_DISCOVERY_CLAIM_TIMEOUT_MS) {
    return {
      kind: 'NO_WORKER',
      hint: '排队超过 3 分钟都没有 Worker 领取。请确认本地 Worker 正在运行且版本已更新，然后重试。',
    }
  }
  return { kind: 'WAITING_WORKER', hint: '已排队，等待本地 Worker 领取…' }
}


