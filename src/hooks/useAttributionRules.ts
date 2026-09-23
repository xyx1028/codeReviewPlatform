import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

export type AttributionRuleCapability = 'GIT_BASE' | 'MR_ENHANCED' | 'RANGE_GATE'
export type AttributionRuleMatch = 'ALL' | 'ANY'
export type AttributionRuleActionType =
  | 'SELECT_STRONG'
  | 'ADD_AI_CANDIDATE'
  | 'EXCLUDE_CURRENT_STORY'
  | 'MARK_EFFECTIVE_REVERTED'
  | 'DOWNRANK_CANDIDATE'
  | 'FLAG_CONFLICT'
  | 'GLOBAL_FALLBACK'

export type AttributionRuleField =
  | 'story.current_code'
  | 'story.other_codes'
  | 'commit.structured_story_ids'
  | 'commit.story_tokens'
  | 'commit.support_signal'
  | 'commit.body_story_tokens'
  | 'commit.sha'
  | 'commit.parent_shas'
  | 'commit.reachability'
  | 'commit.author_identity'
  | 'commit.committed_at'
  | 'commit.files'
  | 'commit.is_revert'
  | 'commit.reverted_sha'
  | 'commit.is_bot'
  | 'commit.is_generated'
  | 'commit.mr_membership'
  | 'mr.capability_status'
  | 'mr.structured_story_ids'
  | 'repository.enumeration_status'
  | 'identity.status'
  | 'scope.candidate_count'
  | 'scope.rule_conflict'

export type AttributionRuleOperator =
  | 'EXACT_CURRENT_STORY_TOKEN'
  | 'EXACT_OTHER_STORY_TOKEN'
  | 'EQUALS'
  | 'IN_ENUM'
  | 'VERIFIED_IDENTITY_MATCH'
  | 'WITHIN_FROZEN_WINDOW'
  | 'MODULE_OVERLAP'
  | 'BELONGS_TO_EXPLICIT_MR'
  | 'REVERTS_RELATED_COMMIT'
  | 'IS_TRUE'
  | 'IS_FALSE'

export interface AttributionRuleCondition {
  id: string
  field: AttributionRuleField
  operator: AttributionRuleOperator
  value?: string | string[] | number | boolean | null
}

export interface AttributionRuleDefinition {
  id: string
  rule_code: string
  display_name: string
  description: string
  priority: number
  enabled: boolean
  capability: AttributionRuleCapability
  match: AttributionRuleMatch
  conditions: AttributionRuleCondition[]
  action: {
    type: AttributionRuleActionType
    reason_code: string
  }
  /** 系统安全门禁和强动作规则只能展示，不能由管理员改写。 */
  system_locked: boolean
}

export type AttributionRuleVersionStatus =
  | 'DRAFT'
  | 'VALIDATED'
  | 'PUBLISHED'
  | 'ARCHIVED'

export interface AttributionRuleValidationIssue {
  code: string
  message: string
  rule_id?: string | null
  severity: 'ERROR' | 'WARNING'
}

export interface AttributionRuleValidationResult {
  passed: boolean
  validated_revision: number
  issues: AttributionRuleValidationIssue[]
  validated_at: string
}

export interface AttributionRuleSimulationResult {
  passed: boolean
  evaluation_kind: 'SYSTEM_SAFETY_CONTRACT'
  contract_version: string
  assessment_note: string
  sample_set_id: string
  sample_set_label: string
  simulated_revision: number
  simulated_ruleset_hash: string | null
  simulated_at: string
  metrics: {
    /** false 表示本次不包含效果、准确率或召回率指标。 */
    effect_metrics_available: boolean
    gold_strong_false_positive_count: number
    strong_selected_delta: number
    ai_candidate_delta: number
    excluded_delta: number
    conflict_delta: number
    global_fallback_delta: number
  }
  contract_checks: {
    system_rule_expected_count: number
    system_rule_count: number
    custom_rule_count: number
    condition_count: number
    failed_check_count: number
  }
  blocking_reasons: string[]
}

export interface AttributionRuleVersion {
  id: string
  version: number | null
  status: AttributionRuleVersionStatus
  revision: number
  ruleset_hash: string | null
  source_version_id: string | null
  rules: AttributionRuleDefinition[]
  validation: AttributionRuleValidationResult | null
  latest_simulation: AttributionRuleSimulationResult | null
  created_by_name: string | null
  created_at: string | null
  published_by_name: string | null
  published_at: string | null
  publish_reason: string | null
  referenced_job_count: number | null
}

export interface AttributionRuleSampleSet {
  id: string
  label: string
  frozen_at: string
  story_count: number
  commit_count: number
  evaluation_kind: 'SYSTEM_SAFETY_CONTRACT'
  description: string
}

export interface AttributionRuleCatalog {
  rule_set_id: string
  rule_set_name: string
  current_published_version_id: string | null
  versions: AttributionRuleVersion[]
  sample_sets: AttributionRuleSampleSet[]
  /** null 表示 foundation RPC 没有披露该部署能力，不能解释为“未配置”。 */
  mr_enhanced_available: boolean | null
}

export interface AttributionRulesApi {
  /** 浏览器是否有完整草稿/历史读模型。Foundation RPC 目前只返回当前发布版。 */
  draftManagementAvailable: boolean
  /** 是否存在由受信任服务执行、浏览器只能读取结果的模拟入口。 */
  trustedSimulationAvailable: boolean
  unavailableReason: string | null
  listRuleSets(): Promise<AttributionRuleCatalog>
  createDraft(sourceVersionId: string): Promise<AttributionRuleVersion>
  saveDraft(input: {
    draftVersionId: string
    expectedRevision: number
    rules: AttributionRuleDefinition[]
  }): Promise<AttributionRuleVersion>
  validateDraft(input: {
    draftVersionId: string
    expectedRevision: number
  }): Promise<AttributionRuleValidationResult>
  simulateDraft(input: {
    draftVersionId: string
    expectedRevision: number
    sampleSetId: string
  }): Promise<AttributionRuleSimulationResult>
  publishVersion(input: {
    draftVersionId: string
    expectedRevision: number
    reason: string
  }): Promise<AttributionRuleVersion>
  restoreVersion(input: {
    sourceVersionId: string
    reason: string
  }): Promise<AttributionRuleVersion>
}

export const ATTRIBUTION_RULE_FIELD_OPTIONS: ReadonlyArray<{
  value: AttributionRuleField
  label: string
  capability: AttributionRuleCapability
}> = [
  { value: 'story.current_code', label: '当前需求编码', capability: 'GIT_BASE' },
  { value: 'story.other_codes', label: '其它需求编码', capability: 'GIT_BASE' },
  { value: 'commit.structured_story_ids', label: '提交说明的结构化需求号', capability: 'GIT_BASE' },
  { value: 'commit.story_tokens', label: '提交标题或分支中的需求号', capability: 'GIT_BASE' },
  { value: 'commit.support_signal', label: '独立支持线索', capability: 'GIT_BASE' },
  { value: 'commit.body_story_tokens', label: '提交正文提及的需求号', capability: 'GIT_BASE' },
  { value: 'commit.sha', label: '提交 SHA', capability: 'GIT_BASE' },
  { value: 'commit.parent_shas', label: '父提交 SHA', capability: 'GIT_BASE' },
  { value: 'commit.reachability', label: '提交是否可达冻结 HEAD', capability: 'GIT_BASE' },
  { value: 'commit.author_identity', label: '提交人身份', capability: 'GIT_BASE' },
  { value: 'commit.committed_at', label: '提交时间', capability: 'GIT_BASE' },
  { value: 'commit.files', label: '变更文件模块', capability: 'GIT_BASE' },
  { value: 'commit.is_revert', label: '是否回滚提交', capability: 'GIT_BASE' },
  { value: 'commit.reverted_sha', label: '被回滚提交', capability: 'GIT_BASE' },
  { value: 'commit.is_bot', label: '机器人提交特征', capability: 'GIT_BASE' },
  { value: 'commit.is_generated', label: '生成文件特征', capability: 'GIT_BASE' },
  { value: 'commit.mr_membership', label: '同一明确合并申请', capability: 'MR_ENHANCED' },
  { value: 'mr.structured_story_ids', label: '合并申请的结构化需求号', capability: 'MR_ENHANCED' },
  { value: 'mr.capability_status', label: 'MR 增强能力状态', capability: 'MR_ENHANCED' },
  { value: 'repository.enumeration_status', label: '仓库范围完整性', capability: 'RANGE_GATE' },
  { value: 'identity.status', label: '身份映射状态', capability: 'RANGE_GATE' },
  { value: 'scope.candidate_count', label: '候选提交数量', capability: 'RANGE_GATE' },
  { value: 'scope.rule_conflict', label: '规则是否冲突', capability: 'RANGE_GATE' },
]

export const ATTRIBUTION_RULE_OPERATOR_OPTIONS: ReadonlyArray<{
  value: AttributionRuleOperator
  label: string
}> = [
  { value: 'EXACT_CURRENT_STORY_TOKEN', label: '完整匹配当前需求编码' },
  { value: 'EXACT_OTHER_STORY_TOKEN', label: '完整匹配其它需求编码' },
  { value: 'EQUALS', label: '等于' },
  { value: 'IN_ENUM', label: '属于枚举值' },
  { value: 'VERIFIED_IDENTITY_MATCH', label: '已验证身份匹配' },
  { value: 'WITHIN_FROZEN_WINDOW', label: '位于冻结时间窗' },
  { value: 'MODULE_OVERLAP', label: '模块有重合' },
  { value: 'BELONGS_TO_EXPLICIT_MR', label: '属于已明确关联的 MR' },
  { value: 'REVERTS_RELATED_COMMIT', label: '回滚已关联提交' },
  { value: 'IS_TRUE', label: '为是' },
  { value: 'IS_FALSE', label: '为否' },
]

export const ADMIN_EDITABLE_ACTIONS: ReadonlyArray<{
  value: Extract<AttributionRuleActionType, 'ADD_AI_CANDIDATE' | 'DOWNRANK_CANDIDATE'>
  label: string
}> = [
  { value: 'ADD_AI_CANDIDATE', label: '加入 AI 待判候选' },
  { value: 'DOWNRANK_CANDIDATE', label: '降低候选优先级' },
]

/** 全部动作类型的中文说明，包含系统安全底线规则专用的动作（管理员规则只能用上面两种）。 */
export const ATTRIBUTION_RULE_ACTION_LABELS: Record<AttributionRuleActionType, string> = {
  SELECT_STRONG: '加入强关联主集',
  ADD_AI_CANDIDATE: '加入 AI 待判候选',
  EXCLUDE_CURRENT_STORY: '排除出当前需求',
  MARK_EFFECTIVE_REVERTED: '标记为已被回滚',
  DOWNRANK_CANDIDATE: '降低候选优先级',
  FLAG_CONFLICT: '标记身份冲突',
  GLOBAL_FALLBACK: '降级为全仓分析',
}

const FIELD_LABEL_MAP: Record<string, string> = Object.fromEntries(
  ATTRIBUTION_RULE_FIELD_OPTIONS.map((option) => [option.value, option.label]),
)
const OPERATOR_LABEL_MAP: Record<string, string> = Object.fromEntries(
  ATTRIBUTION_RULE_OPERATOR_OPTIONS.map((option) => [option.value, option.label]),
)
// 系统预置规则固定使用的原因码；管理员自定义规则的原因码是自由文本，未命中时原样显示。
const SYSTEM_REASON_CODE_LABELS: Record<string, string> = {
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
}

export function attributionRuleFieldLabel(field: string): string {
  return FIELD_LABEL_MAP[field] ?? field
}
export function attributionRuleOperatorLabel(operator: string): string {
  return OPERATOR_LABEL_MAP[operator] ?? operator
}
export function attributionRuleActionLabel(action: AttributionRuleActionType): string {
  return ATTRIBUTION_RULE_ACTION_LABELS[action] ?? action
}
export function attributionRuleReasonCodeLabel(reasonCode: string): string {
  return SYSTEM_REASON_CODE_LABELS[reasonCode] ?? reasonCode
}

export function validateEditableRules(rules: AttributionRuleDefinition[]): AttributionRuleValidationIssue[] {
  const issues: AttributionRuleValidationIssue[] = []
  const codes = new Set<string>()
  for (const rule of rules) {
    if (codes.has(rule.rule_code)) {
      issues.push({ code: 'DUPLICATE_RULE_CODE', message: `规则编码 ${rule.rule_code} 重复`, rule_id: rule.id, severity: 'ERROR' })
    }
    codes.add(rule.rule_code)
    if (rule.display_name.trim() === '') {
      issues.push({ code: 'DISPLAY_NAME_REQUIRED', message: '规则名称不能为空', rule_id: rule.id, severity: 'ERROR' })
    }
    if (rule.conditions.length === 0) {
      issues.push({ code: 'CONDITION_REQUIRED', message: '每条规则至少需要一个条件', rule_id: rule.id, severity: 'ERROR' })
    }
    if (!rule.system_locked && !ADMIN_EDITABLE_ACTIONS.some((item) => item.value === rule.action.type)) {
      issues.push({ code: 'UNSAFE_CUSTOM_ACTION', message: '管理员规则只能加入 AI 候选或降低候选优先级', rule_id: rule.id, severity: 'ERROR' })
    }
    if (!rule.system_locked && (rule.priority < 300 || rule.priority > 500)) {
      issues.push({ code: 'CUSTOM_PRIORITY_OUT_OF_RANGE', message: '管理员规则优先级只能位于 300–500', rule_id: rule.id, severity: 'ERROR' })
    }
    if (!/^[A-Z][A-Z0-9_]{2,63}$/.test(rule.action.reason_code)) {
      issues.push({ code: 'INVALID_REASON_CODE', message: '原因码只能使用大写字母、数字和下划线', rule_id: rule.id, severity: 'ERROR' })
    }
  }
  return issues
}

export function isAttributionRulePublishable(
  validation: AttributionRuleValidationResult | null,
  simulation: AttributionRuleSimulationResult | null,
  revision: number,
): boolean {
  return validation?.passed === true &&
    validation.validated_revision === revision &&
    simulation?.passed === true &&
    simulation.evaluation_kind === 'SYSTEM_SAFETY_CONTRACT' &&
    simulation.contract_version === 'SYSTEM_SAFETY_CONTRACT_V1' &&
    simulation.simulated_revision === revision &&
    simulation.contract_checks.failed_check_count === 0
}

const unavailable = (): never => {
  throw new Error('归属规则数据库 API 尚未接入')
}

export function useAttributionRules(api: AttributionRulesApi | null, enabled = true) {
  const queryClient = useQueryClient()
  const catalogQuery = useQuery({
    queryKey: ['attribution-rule-catalog'],
    queryFn: api?.listRuleSets ?? unavailable,
    enabled: enabled && api !== null,
    staleTime: 15_000,
  })
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['attribution-rule-catalog'] })

  const createDraft = useMutation({
    mutationFn: (sourceVersionId: string) => api?.createDraft(sourceVersionId) ?? Promise.reject(unavailable()),
    onSuccess: refresh,
  })
  const saveDraft = useMutation({
    mutationFn: (input: Parameters<AttributionRulesApi['saveDraft']>[0]) => api?.saveDraft(input) ?? Promise.reject(unavailable()),
    onSuccess: refresh,
  })
  const validateDraft = useMutation({
    mutationFn: (input: Parameters<AttributionRulesApi['validateDraft']>[0]) => api?.validateDraft(input) ?? Promise.reject(unavailable()),
    onSuccess: refresh,
  })
  const simulateDraft = useMutation({
    mutationFn: (input: Parameters<AttributionRulesApi['simulateDraft']>[0]) => api?.simulateDraft(input) ?? Promise.reject(unavailable()),
    onSuccess: refresh,
  })
  const publishVersion = useMutation({
    mutationFn: (input: Parameters<AttributionRulesApi['publishVersion']>[0]) => api?.publishVersion(input) ?? Promise.reject(unavailable()),
    onSuccess: refresh,
  })
  const restoreVersion = useMutation({
    mutationFn: (input: Parameters<AttributionRulesApi['restoreVersion']>[0]) => api?.restoreVersion(input) ?? Promise.reject(unavailable()),
    onSuccess: refresh,
  })

  return {
    apiAvailable: api !== null,
    catalogQuery,
    createDraft,
    saveDraft,
    validateDraft,
    simulateDraft,
    publishVersion,
    restoreVersion,
  }
}
