import type {
  AgentNodeStatus,
  AgentProvider,
  AgentRole,
  AgentRunStatus,
  AiVerdict,
  ArtifactType,
  ArtifactVerificationStatus,
  BatchStatus,
  EvidenceOrigin,
  HumanReviewResult,
  ToolPermissionVerdict,
} from '../types'

export const batchStatusLabels: Record<BatchStatus, string> = {
  DRAFT: '草稿',
  WAITING_AI_RESULT: '等待 AI 结果',
  REVIEWING: '核对中',
  COMPLETED: '已完成',
}

export const aiVerdictLabels: Record<AiVerdict, string> = {
  IMPLEMENTED: '已实现',
  PARTIAL: '部分实现',
  NOT_IMPLEMENTED: '未实现',
  UNCERTAIN: '无法判断',
}

export const humanReviewLabels: Record<HumanReviewResult, string> = {
  CORRECT: 'AI分析正确',
  PARTIALLY_CORRECT: 'AI分析部分正确',
  INCORRECT: 'AI分析错误',
  NEED_DISCUSSION: '需要进一步确认',
}

export const aiVerdictOptions = Object.entries(aiVerdictLabels).map(([value, label]) => ({ value, label }))
export const humanReviewOptions = Object.entries(humanReviewLabels).map(([value, label]) => ({ value, label }))

// ---------------------------------------------------------------------------
// AI 自动化 MVP：任务状态 / 错误码文案（见方案第 7.3 / 19 节）
// ---------------------------------------------------------------------------

export const analysisJobStatusLabels: Record<string, string> = {
  QUEUED: '排队中',
  PREPARING_CODE: '准备代码',
  PROCESSING: '分析中',
  FINALIZING: '汇总结果',
  SUCCEEDED: '已完成',
  FAILED: '失败',
}

export const storyTaskStatusLabels: Record<string, string> = {
  PENDING: '待处理',
  RUNNING: '处理中',
  SUCCEEDED: '已完成',
  FAILED: '失败',
}

export interface AnalysisErrorMeta {
  title: string
  reason: string
  suggestion: string
  /** 完成 suggestion 后，是否允许复用当前 Job 的冻结 Commit 再试一次。 */
  retryable: boolean
}

/**
 * 分析错误目录：页面只展示用户能理解的原因和处理动作，原始异常放进折叠技术详情。
 * retryable 表示“处理根因后可重试原 Job”，不表示应该不做处理就立刻重复执行。
 */
export const analysisErrorCodeMeta: Record<string, AnalysisErrorMeta> = {
  LEGACY_ENGINE_RETIRED: {
    title: '历史分析引擎已停用',
    reason: '该任务来自已经退役的旧执行链路，当前 Worker 不再支持。',
    suggestion: '重新发起一次当前版本的 Harness 分析任务。',
    retryable: false,
  },
  GIT_AUTH_FAILED: {
    title: 'GitLab 凭据无效',
    reason: 'Worker 无法通过鉴权读取代码仓库。',
    suggestion: '更新 Worker 的 GitLab 凭据，确认仓库访问权限后重试。',
    retryable: true,
  },
  GIT_BRANCH_MISSING: {
    title: '代码分支不存在',
    reason: '至少一个必需仓库中找不到批次选择的分支。',
    suggestion: '确认四个仓库均已创建该分支，或修正批次分支后重新发起分析。',
    retryable: false,
  },
  GIT_FETCH_FAILED: {
    title: '代码拉取失败',
    reason: 'Worker 拉取仓库时遇到网络、GitLab 服务或临时仓库错误。',
    suggestion: '确认 GitLab 和网络恢复后，按原 Commit 重试。',
    retryable: true,
  },
  GIT_SHA_MISMATCH: {
    title: '代码版本校验不一致',
    reason: '拉取到的代码与任务冻结的 Commit 不一致。',
    suggestion: '检查 Git 缓存和仓库状态，清理异常缓存后重试。',
    retryable: true,
  },
  GIT_SNAPSHOT_MISSING: {
    title: '本地代码快照缺失',
    reason: 'Worker 找不到已经冻结的仓库快照目录。',
    suggestion: '检查 Worker 缓存卷和磁盘状态，恢复后重试。',
    retryable: true,
  },
  SNAPSHOT_COMMIT_MISSING: {
    title: '冻结 Commit 缺失',
    reason: '本地快照中不存在任务固定的 Commit。',
    suggestion: '恢复代码缓存或 GitLab 连接后，按原 Commit 重试。',
    retryable: true,
  },
  MODEL_AUTH_FAILED: {
    title: '模型密钥无效',
    reason: '模型服务拒绝了当前 API Key。',
    suggestion: '在模型管理中更新并测试 API Key，然后重试。',
    retryable: true,
  },
  MODEL_CONFIG_DISABLED: {
    title: '分析模型已停用',
    reason: '该批次绑定的模型配置当前处于停用状态。',
    suggestion: '在模型管理中重新启用同一模型，确认连接正常后重试。',
    retryable: true,
  },
  MODEL_SECRET_MISSING: {
    title: '模型密钥缺失',
    reason: 'Vault 中找不到该模型配置对应的 API Key。',
    suggestion: '重新保存模型密钥并通过连接测试，然后重试。',
    retryable: true,
  },
  MODEL_RATE_LIMITED: {
    title: '模型服务限流',
    reason: '模型服务暂时拒绝了过多请求。',
    suggestion: '等待限流窗口恢复，或降低并发后重试。',
    retryable: true,
  },
  MODEL_TIMEOUT: {
    title: '模型响应超时',
    reason: '模型未在配置的超时时间内返回结果。',
    suggestion: '检查模型服务状态和网络，必要时调整超时后重试。',
    retryable: true,
  },
  MODEL_PROVIDER_ERROR: {
    title: '模型服务异常',
    reason: '模型提供方返回了无法继续执行的错误。',
    suggestion: '查看模型服务状态和技术详情，服务恢复后重试。',
    retryable: true,
  },
  MODEL_BUDGET_EXHAUSTED: {
    title: '模型请求预算已用尽',
    reason: '本任务冻结的模型请求次数已经全部消耗。',
    suggestion: '缩小需求范围或提高默认预算后，创建新任务；原 Job 重试仍会使用旧预算。',
    retryable: false,
  },
  RETRIEVAL_SCHEMA_INVALID: {
    title: '代码检索结果格式错误',
    reason: '检索阶段没有生成平台可以解析的数据。',
    suggestion: '检查模型输出和 Prompt 配置，修复后重试。',
    retryable: true,
  },
  ANALYSIS_SCHEMA_INVALID: {
    title: '分析结果格式错误',
    reason: '分析阶段没有生成平台要求的结构化结果。',
    suggestion: '检查模型输出和 Prompt 配置，修复后重试。',
    retryable: true,
  },
  ANALYSIS_OUTPUT_EMPTY: {
    title: '没有可汇总的分析结果',
    reason: '逐需求任务没有留下可供最终汇总的有效结果。',
    suggestion: '查看逐需求运行详情，处理失败原因后重试。',
    retryable: true,
  },
  EVIDENCE_PATH_INVALID: {
    title: '代码证据路径无效',
    reason: 'Agent 提交的证据不属于任务冻结的代码快照。',
    suggestion: '检查 Harness 证据工具和快照一致性，修复后重试。',
    retryable: true,
  },
  EVIDENCE_LINE_INVALID: {
    title: '代码证据行号无效',
    reason: 'Agent 提交的代码行范围超出了对应文件。',
    suggestion: '检查证据生成逻辑，修复后重试。',
    retryable: true,
  },
  EVIDENCE_AGENT_INVALID: {
    title: '代码证据不属于当前 Agent',
    reason: '提交的证据来自当前任务 Agent 树之外。',
    suggestion: '检查 Agent 身份和证据传递链路，修复 Worker 后重试。',
    retryable: true,
  },
  EVIDENCE_ORIGIN_INVALID: {
    title: '代码证据来源不可信',
    reason: '提交的证据不是来自任务冻结的代码快照。',
    suggestion: '检查证据工具配置，确保使用冻结快照取证后重试。',
    retryable: true,
  },
  BATCH_BRANCH_CHANGED: {
    title: '批次分支已变化',
    reason: '当前批次分支与任务开始时冻结的分支不一致。',
    suggestion: '确认要评审的分支后重新创建分析任务。',
    retryable: false,
  },
  RESULT_ALREADY_EXISTS: {
    title: '批次已经存在 AI 结果',
    reason: '平台检测到该批次已有结果，拒绝重复写入。',
    suggestion: '直接查看现有结果；如需重跑，请先按业务流程处理旧结果。',
    retryable: false,
  },
  TASK_LEASE_LOST: {
    title: '需求任务已被其他 Worker 接管',
    reason: '当前 Worker 的任务租约已过期或失效。',
    suggestion: '等待接管任务完成；若任务最终失败，再按原 Commit 重试。',
    retryable: true,
  },
  JOB_LEASE_LOST: {
    title: '分析任务已被其他 Worker 接管',
    reason: '当前 Worker 不再持有代码准备或汇总阶段的租约。',
    suggestion: '等待接管 Worker 完成；若任务失败，再重试。',
    retryable: true,
  },
  WORKER_LOST: {
    title: 'Worker 已离线',
    reason: '执行任务的 Worker 心跳超时，平台已中止本次尝试。',
    suggestion: '确认 Worker 恢复在线后重试。',
    retryable: true,
  },
  JOB_INTERNAL_ERROR: {
    title: '平台内部执行异常',
    reason: '分析流程遇到了尚未分类的内部错误。',
    suggestion: '展开技术详情并联系管理员；确认服务恢复后可重试。',
    retryable: true,
  },
  P0001: {
    title: '数据库返回未分类错误',
    reason: '数据库拒绝了本次操作，但旧版本未保留具体业务错误码。',
    suggestion: '展开技术详情并联系管理员确认根因，不要盲目重复执行。',
    retryable: false,
  },
  ENGINE_NOT_SUPPORTED: {
    title: '历史执行引擎不受支持',
    reason: '该任务属于已经下线的旧执行引擎。',
    suggestion: '重新创建当前 Harness 分析任务。',
    retryable: false,
  },
  EXECUTION_ENGINE_UNSUPPORTED: {
    title: 'Worker 不支持任务执行引擎',
    reason: '任务要求的执行引擎与当前 Worker 镜像不一致。',
    suggestion: '部署匹配版本的 Worker 后重新创建或重试任务。',
    retryable: false,
  },
  EXECUTION_ENGINE_UNAVAILABLE: {
    title: '执行引擎不可用',
    reason: 'Worker 缺少启动该执行引擎所需的配置或依赖。',
    suggestion: '补齐 Worker 配置和依赖，验证启动后重试。',
    retryable: true,
  },
  AGENT_CLAIM_INVALID: {
    title: 'Agent 任务凭据已失效',
    reason: '本次提交使用的领取凭据已经被接管或撤销。',
    suggestion: '等待当前有效尝试完成；若失败，再重试。',
    retryable: true,
  },
  AGENT_IDENTITY_INVALID: {
    title: 'Agent 身份或策略校验失败',
    reason: 'Worker 上报的 Agent、策略或运行身份与任务冻结记录不一致。',
    suggestion: '检查 Worker 版本、策略 hash 和运行记录，修复一致性后重试。',
    retryable: true,
  },
  AGENT_ROLE_DENIED: {
    title: 'Agent 角色权限不足',
    reason: '当前 Agent 角色无权执行请求的工具或操作。',
    suggestion: '检查角色工具权限和 Harness 配置，修复后重试。',
    retryable: true,
  },
  SUBMIT_ROOT_ONLY: {
    title: '非根 Agent 尝试提交最终结果',
    reason: '只有根评审 Agent 可以提交本次需求的最终结论。',
    suggestion: '检查 Agent 权限和提交路由，修复 Harness 后重试。',
    retryable: true,
  },
  AGENT_TREE_LIMIT_EXCEEDED: {
    title: '子 Agent 数量或深度超限',
    reason: '本次任务创建的 Agent 超过策略允许的数量或委派深度。',
    suggestion: '减少子任务拆分，或调整默认策略后创建新任务。',
    retryable: false,
  },
  AGENT_TREE_CANCELLED: {
    title: 'Agent 任务已取消',
    reason: '本次 Agent 树被用户、Worker 关停或租约接管取消。',
    suggestion: '确认取消原因已经解除后，按原 Commit 重试。',
    retryable: true,
  },
  AGENT_RESULT_ALREADY_COMMITTED: {
    title: 'Agent 结果已经提交',
    reason: '平台拒绝了同一需求的重复结果提交。',
    suggestion: '无需重复提交；查看当前已保存结果或有效运行记录。',
    retryable: false,
  },
  AGENT_NO_SUBMISSION: {
    title: 'Agent 未提交分析结论',
    reason: '模型结束了会话，但没有调用最终结果提交工具。',
    suggestion: '查看 Agent 运行详情和模型输出，确认原因后重试。',
    retryable: true,
  },
  AGENT_TURN_INCOMPLETE: {
    title: 'Agent 会话异常中断',
    reason: '模型会话在提交结论前被中断。',
    suggestion: '检查模型服务和 Harness 日志，服务恢复后重试。',
    retryable: true,
  },
  AGENT_ATTEMPT_FAILED: {
    title: 'Agent 执行失败',
    reason: '本次 Agent 尝试遇到了无法继续的运行错误。',
    suggestion: '查看运行详情和技术信息，处理根因后重试。',
    retryable: true,
  },
  ATTEMPT_ALREADY_SEALED: {
    title: 'Agent 尝试已经封存',
    reason: '一个已经结束或被接管的旧尝试仍在写入结果。',
    suggestion: '确认当前有效尝试状态；若任务已失败，再重试。',
    retryable: true,
  },
  TOOL_BUDGET_EXHAUSTED: {
    title: '工具调用额度已用尽',
    reason: '本次任务已经达到策略允许的工具调用上限。',
    suggestion: '缩小任务范围或调整默认策略后创建新任务。',
    retryable: false,
  },
  WORKSPACE_POLICY_DENIED: {
    title: '工作区操作被安全策略拒绝',
    reason: 'Agent 尝试访问或修改工作区允许范围之外的内容。',
    suggestion: '检查工具参数和工作区策略，不要通过放宽安全边界绕过问题。',
    retryable: false,
  },
  WEB_EGRESS_DENIED: {
    title: '外网访问被安全策略拒绝',
    reason: '目标域名、端口或网络地址不在允许范围内。',
    suggestion: '确认访问确有必要后配置域名白名单，再创建新任务。',
    retryable: false,
  },
  SESSION_FENCED: {
    title: '会话已被新的尝试接管',
    reason: '当前会话 revision 已过期，继续写入可能覆盖新结果。',
    suggestion: '等待当前有效尝试完成；若任务失败，再重试。',
    retryable: true,
  },
  SESSION_FORMAT_UNSUPPORTED: {
    title: 'Worker 与任务能力版本不一致',
    reason: '任务冻结的 Harness manifest 或会话格式与执行它的 Worker 不匹配。',
    suggestion: '重新部署与 active manifest 匹配的 Worker，确认 heartbeat hash 一致后重试。',
    retryable: true,
  },
  SESSION_RECOVERY_FAILED: {
    title: '历史 Agent 会话无法安全恢复',
    reason: 'Worker 检测到会话日志不完整、损坏或不满足恢复条件。',
    suggestion: '保留旧会话用于审计，并以新的尝试按原 Commit 重试。',
    retryable: true,
  },
  PROCESS_TREE_CLEANUP_FAILED: {
    title: 'Worker 子进程清理失败',
    reason: 'Agent 结束后仍有构建或工具进程没有被完全回收。',
    suggestion: '检查并重启异常 Worker，确认进程资源恢复后重试。',
    retryable: true,
  },
  CAPABILITY_CONTRACT_MISSING: {
    title: 'Harness 能力配置缺失',
    reason: 'Worker 镜像中找不到 V4 capability manifest。',
    suggestion: '重新构建并部署包含 manifest 的 Worker 镜像。',
    retryable: true,
  },
  CAPABILITY_CONTRACT_MALFORMED: {
    title: 'Harness 能力配置损坏',
    reason: 'Worker 无法解析或校验 capability manifest。',
    suggestion: '修复 manifest 并通过一致性检查后重新部署 Worker。',
    retryable: true,
  },
  CAPABILITY_CONTRACT_UNKNOWN_TOOL: {
    title: 'Harness 出现未登记工具',
    reason: '实际工具清单包含 manifest 未登记的工具。',
    suggestion: '审核新工具权限并更新 manifest，生成迁移后重新部署。',
    retryable: true,
  },
  CAPABILITY_CONTRACT_MISSING_TOOL: {
    title: 'Harness 缺少必需工具',
    reason: 'manifest 要求的工具没有出现在实际 Harness profile 中。',
    suggestion: '检查插件和 profile 配置，修复镜像后重试。',
    retryable: true,
  },
  CAPABILITY_CONTRACT_VIOLATION: {
    title: 'Harness 能力契约不一致',
    reason: 'Worker 实际能力、角色权限或插件配置违反了 manifest。',
    suggestion: '运行 manifest 检查并重新构建匹配的 Worker 镜像。',
    retryable: true,
  },
}

const genericAnalysisErrorCodes = new Set(['P0001', 'JOB_INTERNAL_ERROR'])
const unknownAnalysisErrorMeta: AnalysisErrorMeta = {
  title: '分析任务发生未知错误',
  reason: '平台收到了尚未归类的错误，无法安全判断具体原因。',
  suggestion: '展开技术详情并将错误码提供给管理员，确认根因后再决定是否重试。',
  retryable: false,
}

export function resolveAnalysisError(
  errorCode: string | null | undefined,
  errorMessage: string | null | undefined,
): { code: string; originalCode: string | null; meta: AnalysisErrorMeta } {
  const originalCode = errorCode?.trim() || null
  const message = errorMessage ?? ''
  const embeddedCode = Object.keys(analysisErrorCodeMeta).find((code) =>
    new RegExp(`\\b${code}\\b`).test(message),
  )
  const shouldRecoverEmbedded =
    embeddedCode !== undefined &&
    (originalCode === null ||
      genericAnalysisErrorCodes.has(originalCode) ||
      analysisErrorCodeMeta[originalCode] === undefined)
  const code = shouldRecoverEmbedded
    ? embeddedCode
    : originalCode ?? embeddedCode ?? 'UNKNOWN_ERROR'
  return {
    code,
    originalCode,
    meta: analysisErrorCodeMeta[code] ?? unknownAnalysisErrorMeta,
  }
}

// ---------------------------------------------------------------------------
// V4 DeepSeek Harness：Agent 运行详情展示文案（见方案第 7.10 节）
// 只服务于只读展示，不影响“开始 AI 分析”单按钮启动流程。
// ---------------------------------------------------------------------------

/** Agent 运行整体状态文案 + 配色（配色沿用 antd Tag 语义色）。 */
export const agentRunStatusMeta: Record<AgentRunStatus, { label: string; color: string }> = {
  RUNNING: { label: '运行中', color: 'processing' },
  FINISHED: { label: '已完成', color: 'green' },
  FAILED: { label: '失败', color: 'red' },
  CANCELLED: { label: '已取消', color: 'default' },
}

/** Agent Tree 节点状态文案 + 配色。 */
export const agentNodeStatusMeta: Record<AgentNodeStatus, { label: string; color: string }> = {
  RUNNING: { label: '运行中', color: 'processing' },
  FINISHED: { label: '已完成', color: 'green' },
  FAILED: { label: '失败', color: 'red' },
  CANCELLED: { label: '已取消', color: 'default' },
}

/** Agent 角色文案。 */
export const agentRoleLabels: Record<AgentRole, string> = {
  'root-reviewer': '根评审 Agent',
  'research-child': '检索子 Agent',
  'implementation-child': '实现子 Agent',
  'critic-child': '批判子 Agent',
  'workflow-child': '工作流子 Agent',
}

/** Agent 产生方式文案。 */
export const agentProviderLabels: Record<AgentProvider, string> = {
  root: '根',
  spawn: '派生',
  fork: '分叉',
  workflow: '工作流',
  ralph: 'Ralph 循环',
}

/** 工具权限判定文案 + 配色。 */
export const toolPermissionVerdictMeta: Record<ToolPermissionVerdict, { label: string; color: string }> = {
  ALLOW: { label: '放行', color: 'green' },
  DENY: { label: '拒绝', color: 'red' },
  CANCELLED: { label: '已取消', color: 'default' },
}

/**
 * Evidence 来源文案 + 配色。
 * 刻意用不同语义色强调：只有 PINNED_SNAPSHOT 能证明代码已存在，
 * GENERATED_ARTIFACT 只能支撑一个“建议”，不能当作既有实现的证据。
 */
export const evidenceOriginMeta: Record<EvidenceOrigin, { label: string; color: string; hint: string }> = {
  PINNED_SNAPSHOT: {
    label: '冻结快照',
    color: 'green',
    hint: '来自任务冻结的精确提交，可证明代码已存在。',
  },
  GENERATED_ARTIFACT: {
    label: '生成产物',
    color: 'orange',
    hint: '来自工作区生成内容，只能支撑建议，不能证明既有实现。',
  },
}

/** Artifact 类型文案。 */
export const artifactTypeLabels: Record<ArtifactType, string> = {
  PATCH: '候选补丁',
  TEST_REPORT: '测试报告',
  BUILD_LOG: '构建日志',
  STATIC_ANALYSIS: '静态分析',
  NOTE: '说明',
}

/** Artifact 校验状态文案 + 配色。 */
export const artifactVerificationMeta: Record<ArtifactVerificationStatus, { label: string; color: string }> = {
  UNVERIFIED: { label: '未校验', color: 'default' },
  VERIFIED: { label: '已校验', color: 'green' },
  REJECTED: { label: '已拒绝', color: 'red' },
}
