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
  RuntimeFreshness,
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
  PREPARING_SCOPE: '准备分析范围',
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
  COMMIT_MANIFEST_INVALID: {
    title: '提交清单校验失败',
    reason: 'Worker 从 Git 读出的提交/文件清单不满足规范化要求（最常见是文件路径被 Git 转义或含不安全字符）。',
    suggestion: '展开技术详情看被拒绝的具体路径；若为非 ASCII 文件名，需升级到修复了路径读取的 Worker 后重试。',
    retryable: false,
  },
  COMMIT_MANIFEST_INCOMPLETE: {
    title: '提交历史枚举不完整',
    reason: '在允许的加深范围内没能取到完整的评审区间历史，平台拒绝冻结部分清单。',
    suggestion: '检查仓库可达性与 Worker 的 deepen 上限，必要时提高上限后创建新任务。',
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
  MODEL_ENDPOINT_UNREACHABLE: {
    title: '模型服务暂时不可达',
    reason: 'Worker 已连到本机代理，但 Mac 当时无法连到模型端点。',
    suggestion: '确认 VPN 和模型服务恢复后，可按原 Commit 重试。',
    retryable: true,
  },
  MODEL_STREAM_TRUNCATED: {
    title: '模型响应流被中断',
    reason: '模型的流式响应在正常结束前连接被切断（常见于经代理访问的长响应，属传输层瞬时故障）。',
    suggestion: '这是可重试的瞬时故障；反复出现时，降低批次并发或让该模型直连（避开中间代理对长连接的切断），再重试。',
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
  // Mac 本机代理在无法建立上游连接时返回 502；Harness 将其包成
  // JSON-RPC `-32603`，所以页面需要从脱敏错误文本恢复可操作的错误类别。
  const endpointUnreachable =
    /\b502\b.*\bmodel endpoint unreachable from this Mac\b/i.test(message) ||
    /\bmodel endpoint unreachable from this Mac\b/i.test(message)
  if (endpointUnreachable && (originalCode === null || analysisErrorCodeMeta[originalCode] === undefined)) {
    return {
      code: 'MODEL_ENDPOINT_UNREACHABLE',
      originalCode,
      meta: analysisErrorCodeMeta.MODEL_ENDPOINT_UNREACHABLE!,
    }
  }
  // 传输层截断：Harness 把「流在收到 finish_reason 前关闭」统一抛成 `-32603` +
  // 文本 `Stream ended without finish_reason`（code 在 Harness 内部是 TRANSPORT，
  // 但冒泡到平台时只剩 -32603，分类信息丢失）。这类是瞬时可重试故障，不该显示成
  // 「未知错误 / 不建议重试」。用消息特征识别，因为文本里没有任何平台已登记的错误码单词。
  const transportTruncation =
    /stream ended (?:before|without)\b/i.test(message) ||
    /\bTRANSPORT\b/.test(message) ||
    /\b(?:other side closed|premature close|ECONNRESET|socket hang ?up)\b/i.test(message)
  if (transportTruncation && (originalCode === null || analysisErrorCodeMeta[originalCode] === undefined)) {
    return {
      code: 'MODEL_STREAM_TRUNCATED',
      originalCode,
      meta: analysisErrorCodeMeta.MODEL_STREAM_TRUNCATED!,
    }
  }
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

/**
 * Agent 运行整体状态文案 + 配色（配色沿用 antd Tag 语义色）。
 *
 * 只有三态：数据库没有 run 级 CANCELLED，取消落成 FAILED + AGENT_TREE_CANCELLED。
 */
export const agentRunStatusMeta: Record<AgentRunStatus, { label: string; color: string }> = {
  RUNNING: { label: '运行中', color: 'processing' },
  COMMITTED: { label: '已提交', color: 'green' },
  FAILED: { label: '失败', color: 'red' },
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

// ---------------------------------------------------------------------------
// V1.5 真实运行监控台：activity_code / event_type / error_code 三张中文映射表
//
// 数据库与 RPC 永不返回展示文案（V1.5 方案 §1.2）：中文只存在于这里。这既是 i18n
// 要求，也是 AI 可解析的前提 —— 同一个机器码，人看中文、AI 看码。
//
// 未知码一律显示原始码而不是空白：上线后 Worker 可能先发布新事件类型，前端晚一步。
// 空白会让运维以为「什么都没发生」，而真实情况是「发生了我们还没翻译的事」。
// ---------------------------------------------------------------------------

/** activity_code → 中文。这是任务矩阵与 Agent 卡片上「正在……」那一句的唯一来源。 */
export const runtimeActivityLabels: Record<string, string> = {
  JOB_PREPARING_CODE: '正在准备代码',
  REPOSITORY_PREPARING: '正在拉取仓库',
  JOB_PROCESSING: '正在分析需求',
  JOB_FINALIZING: '正在汇总结果',
  JOB_QUEUED: '排队中',
  JOB_SUCCEEDED: '已完成',
  JOB_FAILED: '已失败',
  TASK_RUNNING: '需求任务运行中',
  TASK_REPOSITORIES_PREPARING: '正在准备本地仓库',
  TASK_REPOSITORIES_READY: '本地仓库已就绪',
  TASK_RELEASED: '任务已释放',
  ATTEMPT_STARTING: '尝试启动中',
  VERIFYING_PINS: '正在校验固定 Commit',
  SESSION_PREPARING: '正在准备会话槽位',
  WORKSPACE_PREPARING: '正在准备 Workspace',
  BROKER_STARTING: '正在启动控制面',
  PROFILE_FREEZING: '正在冻结 Profile',
  HARNESS_STARTING: '正在启动 Harness 进程',
  SESSION_RESUMING: '正在恢复会话',
  MODEL_ORCHESTRATION: '模型编排中',
  AGENT_RUNNING: 'Agent 运行中',
  AGENT_FINISHED: 'Agent 已完成',
  AGENT_FAILED: 'Agent 失败',
  AGENT_CANCELLED: 'Agent 已取消',
  MODEL_REQUESTING: '正在请求模型',
  TOOL_RUNNING: '正在调用工具',
  ATTEMPT_CONVERGING: '正在收敛',
  RESULT_COMMITTED: '结论已提交',
  ATTEMPT_FAILED: '尝试失败',
  ATTEMPT_CANCELLING: '正在取消',
  ATTEMPT_LEASE_LOST: '租约已丢失',
}

/** event_type → 中文。时间线默认显示中文，技术码可展开。 */
export const runtimeEventTypeLabels: Record<string, string> = {
  JOB_PREPARATION_STARTED: '批次开始准备代码',
  REPOSITORY_PREPARE_STARTED: '开始拉取仓库',
  REPOSITORY_PREPARE_COMPLETED: '仓库准备完成',
  REPOSITORY_PREPARE_FAILED: '仓库准备失败',
  JOB_SNAPSHOTS_FROZEN: '四仓快照已冻结',
  JOB_FINALIZATION_STARTED: '批次开始汇总',
  JOB_RETRIED: '批次已重试',
  JOB_SUCCEEDED: '批次成功',
  JOB_FAILED: '批次失败',
  TASK_CLAIMED: '需求任务已被领取',
  TASK_REPOSITORIES_STARTED: '开始准备本地仓库',
  TASK_REPOSITORIES_READY: '本地仓库已就绪',
  TASK_RELEASED_FOR_SHUTDOWN: 'Worker 关停释放了任务',
  ATTEMPT_STARTED: '尝试已开始',
  RUNTIME_CONTRACT_VERIFIED: '能力契约校验通过',
  RUNTIME_CONTRACT_REJECTED: '能力契约校验拒绝',
  PINS_VERIFIED: '固定 Commit 已校验',
  SESSION_SLOT_ACQUIRED: '会话槽位已获取',
  WORKSPACE_READY: 'Workspace 已就绪',
  BROKER_READY: '控制面已就绪',
  PROFILE_FROZEN: 'Profile 已冻结',
  HARNESS_PROCESS_STARTED: 'Harness 进程已启动',
  SESSION_RESUMED: '会话已恢复',
  ACP_TURN_STARTED: '模型回合已开始',
  ATTEMPT_INSTRUMENTATION_REPORTED: '插桩自检已上报',
  PROCESS_TREE_CLEANUP_FAILED: '进程树回收失败',
  ATTEMPT_COMMITTED: '结论已提交',
  ATTEMPT_FAILED: '尝试失败',
  CANCEL_REQUESTED: '已请求取消',
  LEASE_LOST: '租约丢失',
  ROOT_AGENT_REGISTERED: '根 Agent 已登记',
  AGENT_REGISTERED: '子 Agent 已登记',
  AGENT_FINISHED: 'Agent 已完成',
  AGENT_FAILED: 'Agent 失败',
  AGENT_CANCELLED: 'Agent 已取消',
  MODEL_REQUEST_STARTED: '模型请求开始',
  MODEL_REQUEST_COMPLETED: '模型请求结束',
  MODEL_REQUEST_FAILED: '模型请求失败',
  MODEL_REQUEST_DENIED: '模型请求被拒',
  TOOL_CALL_STARTED: '工具调用开始',
  TOOL_CALL_COMPLETED: '工具调用完成',
  TOOL_CALL_FAILED: '工具调用失败',
  TOOL_CALL_DENIED: '工具调用被拒',
  TOOL_CALL_CANCELLED: '工具调用被取消',
}

/**
 * error_code / reason_code → 中文。
 *
 * 只收平台自己定义的稳定码。provider 原文错误不会到这里（数据库侧就把不合规的码
 * 归一成 UNKNOWN_ERROR），所以这张表不需要兜底任何自由文本。
 */
export const runtimeErrorCodeLabels: Record<string, string> = {
  AGENT_TREE_CANCELLED: 'Agent Tree 已取消',
  AGENT_IDENTITY_INVALID: 'Agent 身份无效',
  AGENT_ROLE_DENIED: '角色策略拒绝',
  AGENT_NO_SUBMISSION: '未提交结论',
  AGENT_TURN_INCOMPLETE: '模型回合未完成',
  AGENT_ATTEMPT_FAILED: '尝试失败',
  AGENT_TREE_LIMIT_EXCEEDED: '超出 Agent Tree 上限',
  SUBMIT_ROOT_ONLY: '仅根 Agent 可提交',
  MODEL_BUDGET_EXHAUSTED: '模型预算耗尽',
  TOOL_BUDGET_EXHAUSTED: '工具预算耗尽',
  TOOL_EXECUTION_FAILED: '工具执行失败',
  WORKSPACE_POLICY_DENIED: 'Workspace 策略拒绝',
  WEB_EGRESS_DENIED: 'Web 出口拒绝',
  SESSION_FENCED: '会话已被接管',
  SESSION_FORMAT_UNSUPPORTED: '会话格式不受支持',
  SESSION_RECOVERY_FAILED: '会话恢复失败',
  ATTEMPT_ALREADY_SEALED: '尝试已封存',
  ATTEMPT_SEALED: '尝试收敛时被闭合',
  ATTEMPT_COMMITTED: '提交时被闭合',
  PROCESS_TREE_CLEANUP_FAILED: '进程树回收失败',
  WORKER_LOST: 'Worker 心跳丢失',
  WORKER_SHUTDOWN: 'Worker 关停',
  USER_CANCELLED: '用户取消',
  LEASE_LOST: '租约丢失',
  BUDGET_EXHAUSTED: '预算耗尽',
  SESSION_UNRECOVERABLE: '会话不可恢复',
  JOB_INTERNAL_ERROR: '批次内部错误',
  REPOSITORY_PREPARE_FAILED: '仓库准备失败',
  RUNTIME_EVENT_FENCE_REJECTED: '监控事件被 fencing 拒绝',
  UNKNOWN_ERROR: '未知错误',
}

/** 未知码显示原始码，绝不显示空白。 */
export function runtimeActivityLabel(code: string | null | undefined): string {
  if (code === null || code === undefined || code === '') return '—'
  return runtimeActivityLabels[code] ?? code
}

export function runtimeEventTypeLabel(code: string | null | undefined): string {
  if (code === null || code === undefined || code === '') return '—'
  return runtimeEventTypeLabels[code] ?? code
}

export function runtimeErrorCodeLabel(code: string | null | undefined): string | null {
  if (code === null || code === undefined || code === '') return null
  return runtimeErrorCodeLabels[code] ?? code
}

/** 模型请求分类文案。`retry` / `compaction` 是「非有效推进」的两个桶。 */
export const modelRequestKindLabels: Record<string, string> = {
  loop: 'Agent 轮次',
  retry: '重试',
  compaction: '上下文压缩',
  'session-title': '会话标题',
  ralph: 'Ralph 循环',
  other: '其它',
}

/** 数据新鲜度五档。三种故障分别展示，不合并。 */
export const runtimeFreshnessMeta: Record<
  RuntimeFreshness,
  { label: string; color: string; hint: string }
> = {
  LIVE: { label: '实时', color: 'green', hint: '最近事件在 5 秒内到达。' },
  DELAYED: { label: '延迟', color: 'orange', hint: '事件链路拥塞：5~15 秒。' },
  STALE: {
    label: '陈旧',
    color: 'red',
    hint: '任务仍在运行但超过 15 秒没有事件：事件链路异常。',
  },
  AWAITING_COMMIT: {
    label: '确认延迟',
    color: 'gold',
    hint: '有长事务未提交：事件已到但尚未过提交水位，游标不会越过它。',
  },
  WORKER_OFFLINE: {
    label: 'Worker 离线',
    color: 'volcano',
    hint: 'Worker 心跳超过 20 秒：这是 Worker 侧问题，不是监控链路问题。',
  },
}

/** 分析任务状态文案 + 配色（监控台的批次列表用）。 */
export const analysisJobStatusMeta: Record<string, { label: string; color: string }> = {
  QUEUED: { label: '排队中', color: 'default' },
  PREPARING_CODE: { label: '准备代码', color: 'cyan' },
  PREPARING_SCOPE: { label: '准备分析范围', color: 'purple' },
  PROCESSING: { label: '分析中', color: 'processing' },
  FINALIZING: { label: '汇总结果', color: 'geekblue' },
  SUCCEEDED: { label: '已完成', color: 'green' },
  FAILED: { label: '失败', color: 'red' },
}

/** 需求任务状态文案 + 配色。监控台只认 agent_status，不认另两套历史状态列。 */
export const storyTaskStatusMeta: Record<string, { label: string; color: string }> = {
  PENDING: { label: '等待', color: 'default' },
  RUNNING: { label: '运行中', color: 'processing' },
  SUCCEEDED: { label: '成功', color: 'green' },
  FAILED: { label: '失败', color: 'red' },
}
