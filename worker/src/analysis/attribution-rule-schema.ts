import { createHash } from 'node:crypto'

export const ATTRIBUTION_RULE_SCHEMA_VERSION = 1 as const
export const ATTRIBUTION_RULESET_SCHEMA_VERSION = 1 as const

export const ATTRIBUTION_RULE_FIELDS = [
  'commit.structured_story_ids',
  'commit.unstructured_story_ids',
  'commit.sha',
  'commit.parent_shas',
  'commit.reachability',
  'commit.author_identity',
  'commit.committed_at',
  'commit.file_paths',
  'commit.modules',
  'commit.is_revert',
  'commit.reverted_sha',
  'commit.is_bot',
  'commit.is_generated',
  'mr.structured_story_ids',
  'mr.commit_ids',
  'mr.source_branch',
  'mr.target_branch',
  'mr.capability_status',
  'repository.enumeration_status',
  'repository.ancestry_status',
  'repository.manifest_status',
  'scope.candidate_count',
  'scope.rule_conflict',
] as const

export const ATTRIBUTION_RULE_OPERATORS = [
  'EXACT_CURRENT_STORY_TOKEN',
  'EXACT_OTHER_STORY_TOKEN',
  'EQUALS',
  'IN_ENUM',
  'VERIFIED_IDENTITY_MATCH',
  'WITHIN_FROZEN_WINDOW',
  'MODULE_OVERLAP',
  'BELONGS_TO_EXPLICIT_MR',
  'REVERTS_RELATED_COMMIT',
  'IS_TRUE',
  'IS_FALSE',
] as const

export const ATTRIBUTION_RULE_ACTIONS = [
  'SELECT_STRONG',
  'ADD_AI_CANDIDATE',
  'EXCLUDE_CURRENT_STORY',
  'MARK_EFFECTIVE_REVERTED',
  'DOWNRANK_CANDIDATE',
  'FLAG_CONFLICT',
  'GLOBAL_FALLBACK',
] as const

export const ATTRIBUTION_RULE_CAPABILITIES = ['GIT_BASE', 'MR_ENHANCED'] as const
export const ATTRIBUTION_RULE_GROUPS = ['all', 'any'] as const

export type AttributionRuleField = (typeof ATTRIBUTION_RULE_FIELDS)[number]
export type AttributionRuleOperator = (typeof ATTRIBUTION_RULE_OPERATORS)[number]
export type AttributionRuleActionType = (typeof ATTRIBUTION_RULE_ACTIONS)[number]
export type AttributionRuleCapability = (typeof ATTRIBUTION_RULE_CAPABILITIES)[number]
export type AttributionRuleGroup = (typeof ATTRIBUTION_RULE_GROUPS)[number]
export type AttributionRuleValue = string | number | boolean | readonly string[]

export interface AttributionRuleCondition {
  field: AttributionRuleField
  operator: AttributionRuleOperator
  value?: AttributionRuleValue
}

export type AttributionRuleClause = AttributionRuleCondition | AttributionRuleWhen
export type AttributionRuleWhen =
  | { all: readonly AttributionRuleClause[] }
  | { any: readonly AttributionRuleClause[] }

export interface AttributionRuleAction {
  type: AttributionRuleActionType
  reasonCode: string
}

export interface AttributionRule {
  schemaVersion: 1
  ruleCode: string
  displayName: string
  description: string
  priority: number
  enabled: boolean
  capability: AttributionRuleCapability
  systemLocked: boolean
  when: AttributionRuleWhen
  action: AttributionRuleAction
}

export interface AttributionRuleSet {
  schemaVersion: 1
  version: number
  rules: readonly AttributionRule[]
}

export interface CompiledAttributionRuleSet {
  schemaVersion: 1
  version: number
  rules: readonly AttributionRule[]
  canonicalJson: string
  rulesetHash: string
}

export class AttributionRuleSchemaError extends Error {
  readonly issues: readonly string[]

  constructor(issues: readonly string[]) {
    super(`invalid attribution rules: ${issues.join('; ')}`)
    this.name = 'AttributionRuleSchemaError'
    this.issues = issues
  }
}

const RULE_CODE_PATTERN = /^ATTR_[A-Z0-9_]{1,96}$/
const REASON_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,96}$/
const VALUELESS_OPERATORS: ReadonlySet<AttributionRuleOperator> = new Set([
  'EXACT_CURRENT_STORY_TOKEN',
  'EXACT_OTHER_STORY_TOKEN',
  'VERIFIED_IDENTITY_MATCH',
  'WITHIN_FROZEN_WINDOW',
  'MODULE_OVERLAP',
  'BELONGS_TO_EXPLICIT_MR',
  'REVERTS_RELATED_COMMIT',
  'IS_TRUE',
  'IS_FALSE',
])

const SYSTEM_RULE_CODES: ReadonlySet<string> = new Set([
  'ATTR_EXPLICIT_COMMIT_STORY_ID',
  'ATTR_EXPLICIT_MR_STORY_ID',
  'ATTR_SAME_EXPLICIT_MR_COMMIT',
  'ATTR_STORY_CODE_WITH_SUPPORT',
  'ATTR_OWNER_WINDOW_MODULE_CANDIDATE',
  'ATTR_STORY_TEXT_CANDIDATE',
  'ATTR_OTHER_STORY_EXCLUSION',
  'ATTR_REVERT_CHAIN',
  'ATTR_BOT_GENERATED_DOWNRANK',
  'ATTR_IDENTITY_AMBIGUOUS',
  'ATTR_RANGE_INCOMPLETE_FALLBACK',
  'ATTR_NO_CANDIDATE_FALLBACK',
  'ATTR_RULE_CONFLICT_FALLBACK',
])

function operatorAllowedForField(field: AttributionRuleField, operator: AttributionRuleOperator): boolean {
  switch (field) {
    case 'commit.structured_story_ids':
    case 'commit.unstructured_story_ids':
    case 'mr.structured_story_ids':
    case 'mr.source_branch':
      return operator === 'EXACT_CURRENT_STORY_TOKEN' || operator === 'EXACT_OTHER_STORY_TOKEN'
    case 'commit.author_identity':
      return operator === 'VERIFIED_IDENTITY_MATCH' || operator === 'EQUALS'
    case 'commit.committed_at':
      return operator === 'WITHIN_FROZEN_WINDOW' || operator === 'EQUALS'
    case 'commit.file_paths':
    case 'commit.modules':
      return operator === 'MODULE_OVERLAP' || operator === 'EQUALS' || operator === 'IN_ENUM'
    case 'mr.commit_ids':
      return operator === 'BELONGS_TO_EXPLICIT_MR'
    case 'commit.reverted_sha':
      return operator === 'REVERTS_RELATED_COMMIT' || operator === 'EQUALS'
    case 'commit.is_revert':
    case 'commit.is_bot':
    case 'commit.is_generated':
    case 'scope.rule_conflict':
      return operator === 'IS_TRUE' || operator === 'IS_FALSE'
    case 'repository.enumeration_status':
    case 'repository.ancestry_status':
    case 'repository.manifest_status':
      return operator === 'EQUALS' || operator === 'IN_ENUM'
    case 'commit.sha':
    case 'commit.parent_shas':
    case 'commit.reachability':
    case 'mr.target_branch':
    case 'mr.capability_status':
    case 'scope.candidate_count':
      return operator === 'EQUALS' || operator === 'IN_ENUM'
  }
}
const CUSTOM_ALLOWED_ACTIONS: ReadonlySet<AttributionRuleActionType> = new Set([
  'ADD_AI_CANDIDATE',
  'DOWNRANK_CANDIDATE',
])
const MAX_RULES = 128
const MAX_CONDITIONS = 16
const MAX_TEXT_LENGTH = 500

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const set = new Set(allowed)
  return Object.keys(value).every((key) => set.has(key))
}

function isEnumValue<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && values.some((candidate) => candidate === value)
}

function isRuleValue(value: unknown): value is AttributionRuleValue {
  if (typeof value === 'string') return value.length <= MAX_TEXT_LENGTH
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value === 'boolean') return true
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 64 &&
    value.every((item) => typeof item === 'string' && item.length <= MAX_TEXT_LENGTH)
  )
}

function parseCondition(value: unknown, path: string, issues: string[]): AttributionRuleCondition | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ['field', 'operator', 'value'])) {
    issues.push(`${path} must be an object containing only field/operator/value`)
    return null
  }
  if (!isEnumValue(ATTRIBUTION_RULE_FIELDS, value.field)) {
    issues.push(`${path}.field is not allowed`)
    return null
  }
  if (!isEnumValue(ATTRIBUTION_RULE_OPERATORS, value.operator)) {
    issues.push(`${path}.operator is not allowed`)
    return null
  }
  if (!operatorAllowedForField(value.field, value.operator)) {
    issues.push(`${path}.operator ${value.operator} is incompatible with ${value.field}`)
  }
  const hasValue = Object.prototype.hasOwnProperty.call(value, 'value')
  if (VALUELESS_OPERATORS.has(value.operator) && hasValue) {
    issues.push(`${path}.value is forbidden for ${value.operator}`)
  }
  if (!VALUELESS_OPERATORS.has(value.operator) && !hasValue) {
    issues.push(`${path}.value is required for ${value.operator}`)
  }
  if (hasValue && !isRuleValue(value.value)) {
    issues.push(`${path}.value has an invalid type or size`)
  }
  return {
    field: value.field,
    operator: value.operator,
    ...(hasValue && isRuleValue(value.value) ? { value: value.value } : {}),
  }
}

function parseClause(value: unknown, path: string, issues: string[], depth: number): AttributionRuleClause | null {
  if (depth > 4) {
    issues.push(`${path} exceeds maximum condition nesting depth`)
    return null
  }
  if (isRecord(value) && Object.prototype.hasOwnProperty.call(value, 'field')) {
    return parseCondition(value, path, issues)
  }
  return parseWhen(value, path, issues, depth)
}

function parseWhen(value: unknown, path: string, issues: string[], depth = 0): AttributionRuleWhen | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ATTRIBUTION_RULE_GROUPS)) {
    issues.push(`${path} must contain exactly one of all/any`)
    return null
  }
  const groups = ATTRIBUTION_RULE_GROUPS.filter((group) => Object.prototype.hasOwnProperty.call(value, group))
  if (groups.length !== 1) {
    issues.push(`${path} must contain exactly one of all/any`)
    return null
  }
  const group = groups[0]!
  const rawConditions = value[group]
  if (!Array.isArray(rawConditions) || rawConditions.length === 0 || rawConditions.length > MAX_CONDITIONS) {
    issues.push(`${path}.${group} must contain 1-${MAX_CONDITIONS} conditions`)
    return null
  }
  const conditions: AttributionRuleClause[] = []
  rawConditions.forEach((condition, index) => {
    const parsed = parseClause(condition, `${path}.${group}[${index}]`, issues, depth + 1)
    if (parsed !== null) conditions.push(parsed)
  })
  return group === 'all' ? { all: conditions } : { any: conditions }
}

export function parseAttributionRule(value: unknown, options: { allowCustom?: boolean } = {}): AttributionRule {
  const issues: string[] = []
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'schemaVersion',
    'ruleCode',
    'displayName',
    'description',
    'priority',
    'enabled',
    'capability',
    'systemLocked',
    'when',
    'action',
  ])) {
    throw new AttributionRuleSchemaError(['rule must be an object with no unknown fields'])
  }
  if (value.schemaVersion !== ATTRIBUTION_RULE_SCHEMA_VERSION) issues.push('schemaVersion must be 1')
  if (typeof value.ruleCode !== 'string' || !RULE_CODE_PATTERN.test(value.ruleCode)) issues.push('ruleCode is invalid')
  if (typeof value.displayName !== 'string' || value.displayName.length < 1 || value.displayName.length > 120) issues.push('displayName is invalid')
  if (typeof value.description !== 'string' || value.description.length < 1 || value.description.length > MAX_TEXT_LENGTH) issues.push('description is invalid')
  if (!Number.isSafeInteger(value.priority) || (value.priority as number) < 0 || (value.priority as number) > 1000) issues.push('priority must be an integer from 0 to 1000')
  if (typeof value.enabled !== 'boolean') issues.push('enabled must be boolean')
  if (!isEnumValue(ATTRIBUTION_RULE_CAPABILITIES, value.capability)) issues.push('capability is invalid')
  if (typeof value.systemLocked !== 'boolean') issues.push('systemLocked must be boolean')
  const when = parseWhen(value.when, 'when', issues)
  let action: AttributionRuleAction | null = null
  if (!isRecord(value.action) || !hasOnlyKeys(value.action, ['type', 'reasonCode'])) {
    issues.push('action must contain only type/reasonCode')
  } else if (!isEnumValue(ATTRIBUTION_RULE_ACTIONS, value.action.type)) {
    issues.push('action.type is invalid')
  } else if (typeof value.action.reasonCode !== 'string' || !REASON_CODE_PATTERN.test(value.action.reasonCode)) {
    issues.push('action.reasonCode is invalid')
  } else {
    action = { type: value.action.type, reasonCode: value.action.reasonCode }
  }
  const allowCustom = options.allowCustom === true
  if (allowCustom && value.systemLocked === true && (typeof value.ruleCode !== 'string' || !SYSTEM_RULE_CODES.has(value.ruleCode))) {
    issues.push('custom rules cannot declare systemLocked')
  }
  if (allowCustom && value.systemLocked !== true && action !== null && !CUSTOM_ALLOWED_ACTIONS.has(action.type)) {
    issues.push('custom rules may only add or downrank AI candidates')
  }
  if (value.systemLocked !== true && Number(value.priority) > 599) {
    issues.push('custom rules cannot exceed priority 599')
  }
  if (issues.length > 0 || when === null || action === null) throw new AttributionRuleSchemaError(issues)
  return {
    schemaVersion: 1,
    ruleCode: value.ruleCode as string,
    displayName: value.displayName as string,
    description: value.description as string,
    priority: value.priority as number,
    enabled: value.enabled as boolean,
    capability: value.capability as AttributionRuleCapability,
    systemLocked: value.systemLocked as boolean,
    when,
    action,
  }
}

function condition(field: AttributionRuleField, operator: AttributionRuleOperator, value?: AttributionRuleValue): AttributionRuleCondition {
  return value === undefined ? { field, operator } : { field, operator, value }
}

function preset(
  ruleCode: string,
  displayName: string,
  description: string,
  priority: number,
  capability: AttributionRuleCapability,
  when: AttributionRuleWhen,
  type: AttributionRuleActionType,
  reasonCode: string,
): AttributionRule {
  return {
    schemaVersion: 1,
    ruleCode,
    displayName,
    description,
    priority,
    enabled: true,
    capability,
    systemLocked: true,
    when,
    action: { type, reasonCode },
  }
}

export const PRESET_ATTRIBUTION_RULES: readonly AttributionRule[] = Object.freeze([
  preset('ATTR_EXPLICIT_COMMIT_STORY_ID', '提交说明独立字段精确写明当前需求编码', '精确相等并可达冻结最终版本时加入强关联主集', 900, 'GIT_BASE', { all: [condition('commit.structured_story_ids', 'EXACT_CURRENT_STORY_TOKEN'), condition('commit.reachability', 'EQUALS', 'REACHABLE_FROM_FROZEN_HEAD')] }, 'SELECT_STRONG', 'EXPLICIT_STORY_ID'),
  preset('ATTR_EXPLICIT_MR_STORY_ID', '合并申请独立字段精确写明当前需求编码', 'MR 增强可用时把明确关联 MR 的可达提交加入强关联主集', 900, 'MR_ENHANCED', { all: [condition('mr.structured_story_ids', 'EXACT_CURRENT_STORY_TOKEN'), condition('mr.capability_status', 'EQUALS', 'AVAILABLE')] }, 'SELECT_STRONG', 'EXPLICIT_MR_STORY_ID'),
  preset('ATTR_SAME_EXPLICIT_MR_COMMIT', '已明确需求的合并申请内其它可达提交一并分析', '同一明确 MR 内的可达提交继承 MR 关系', 900, 'MR_ENHANCED', { all: [condition('mr.commit_ids', 'BELONGS_TO_EXPLICIT_MR'), condition('commit.reachability', 'EQUALS', 'REACHABLE_FROM_FROZEN_HEAD')] }, 'SELECT_STRONG', 'SAME_EXPLICIT_MR'),
  preset('ATTR_STORY_CODE_WITH_SUPPORT', '标题或分支命中需求号时需要另一条独立线索', '完整 token 命中并具备独立支持信号时加入强关联主集', 700, 'GIT_BASE', { all: [condition('commit.unstructured_story_ids', 'EXACT_CURRENT_STORY_TOKEN'), { any: [condition('commit.author_identity', 'VERIFIED_IDENTITY_MATCH'), condition('mr.commit_ids', 'BELONGS_TO_EXPLICIT_MR'), condition('commit.modules', 'MODULE_OVERLAP')] }] }, 'SELECT_STRONG', 'STORY_CODE_WITH_SUPPORT'),
  preset('ATTR_OWNER_WINDOW_MODULE_CANDIDATE', '开发人员、辅助时间窗和变更模块共同接近时交给 AI 判断', '已验证身份、时间窗和模块共同命中时加入 AI 候选', 500, 'GIT_BASE', { all: [condition('commit.author_identity', 'VERIFIED_IDENTITY_MATCH'), condition('commit.committed_at', 'WITHIN_FROZEN_WINDOW'), condition('commit.modules', 'MODULE_OVERLAP')] }, 'ADD_AI_CANDIDATE', 'OWNER_WINDOW_MODULE'),
  preset('ATTR_STORY_TEXT_CANDIDATE', '正文自然语言提到需求号时不能直接确认', '普通正文完整 token 命中只加入 AI 候选', 500, 'GIT_BASE', { all: [condition('commit.unstructured_story_ids', 'EXACT_CURRENT_STORY_TOKEN')] }, 'ADD_AI_CANDIDATE', 'UNSTRUCTURED_STORY_MENTION'),
  preset('ATTR_OTHER_STORY_EXCLUSION', '明确只属于其它需求的提交不进入当前需求主集', '仅精确命中其它需求且无当前需求关系时排除', 800, 'GIT_BASE', { all: [condition('commit.structured_story_ids', 'EXACT_OTHER_STORY_TOKEN')] }, 'EXCLUDE_CURRENT_STORY', 'OTHER_STORY_EXPLICIT'),
  preset('ATTR_REVERT_CHAIN', '回滚提交仍与需求相关但标记最终效果可能已撤销', '回滚已关联提交时保留关系并标记效果', 850, 'GIT_BASE', { all: [condition('commit.is_revert', 'IS_TRUE'), condition('commit.reverted_sha', 'REVERTS_RELATED_COMMIT')] }, 'MARK_EFFECTIVE_REVERTED', 'REVERT_OF_RELATED_COMMIT'),
  preset('ATTR_BOT_GENERATED_DOWNRANK', '机器人或生成文件提交不能一律排除', '没有更强关系时只降低机器人或生成文件候选排序', 300, 'GIT_BASE', { any: [condition('commit.is_bot', 'IS_TRUE'), condition('commit.is_generated', 'IS_TRUE')] }, 'DOWNRANK_CANDIDATE', 'BOT_OR_GENERATED'),
  preset('ATTR_IDENTITY_AMBIGUOUS', '身份映射冲突时平台不猜开发人员', '身份指纹冲突时忽略身份强度并标记冲突', 1000, 'GIT_BASE', { all: [condition('commit.author_identity', 'EQUALS', 'AMBIGUOUS')] }, 'FLAG_CONFLICT', 'IDENTITY_AMBIGUOUS'),
  preset('ATTR_RANGE_INCOMPLETE_FALLBACK', 'Git 范围不完整时不能伪装成精准分析', '枚举、祖先或 manifest 任一不完整时全仓降级', 1000, 'GIT_BASE', { any: [condition('repository.enumeration_status', 'IN_ENUM', ['SHALLOW_INCOMPLETE', 'RANGE_TOO_LARGE', 'FAILED']), condition('repository.ancestry_status', 'EQUALS', 'BASE_UNREACHABLE'), condition('repository.manifest_status', 'EQUALS', 'MISMATCH')] }, 'GLOBAL_FALLBACK', 'RANGE_INCOMPLETE'),
  preset('ATTR_NO_CANDIDATE_FALLBACK', '没找到候选不能直接判断需求未实现', '强关联和 AI 候选均为空时转为全仓分析', 100, 'GIT_BASE', { all: [condition('scope.candidate_count', 'EQUALS', 0)] }, 'GLOBAL_FALLBACK', 'NO_CANDIDATE'),
  preset('ATTR_RULE_CONFLICT_FALLBACK', '规则产生互斥终态时不猜测', '同优先级互斥动作触发冲突与全仓降级', 1000, 'GIT_BASE', { all: [condition('scope.rule_conflict', 'IS_TRUE')] }, 'GLOBAL_FALLBACK', 'RULE_CONFLICT'),
])

function compareCodeUnit(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

export function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => compareCodeUnit(left, right))
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`
}

function canonicalCondition(item: AttributionRuleCondition): AttributionRuleCondition {
  return item.value === undefined
    ? { field: item.field, operator: item.operator }
    : { field: item.field, operator: item.operator, value: Array.isArray(item.value) ? [...item.value].sort(compareCodeUnit) : item.value }
}

function canonicalClause(item: AttributionRuleClause): AttributionRuleClause {
  if ('field' in item) return canonicalCondition(item)
  const group: AttributionRuleGroup = 'all' in item ? 'all' : 'any'
  const source = 'all' in item ? item.all : item.any
  const clauses = source.map(canonicalClause).sort((left, right) => compareCodeUnit(stableJson(left), stableJson(right)))
  return group === 'all' ? { all: clauses } : { any: clauses }
}

export function canonicalizeAttributionRule(rule: AttributionRule): AttributionRule {
  const group: AttributionRuleGroup = 'all' in rule.when ? 'all' : 'any'
  const source = 'all' in rule.when ? rule.when.all : rule.when.any
  const conditions = source.map(canonicalClause).sort((left, right) => compareCodeUnit(stableJson(left), stableJson(right)))
  return {
    schemaVersion: 1,
    ruleCode: rule.ruleCode,
    displayName: rule.displayName,
    description: rule.description,
    priority: rule.priority,
    enabled: rule.enabled,
    capability: rule.capability,
    systemLocked: rule.systemLocked,
    when: group === 'all' ? { all: conditions } : { any: conditions },
    action: { type: rule.action.type, reasonCode: rule.action.reasonCode },
  }
}

export function compileAttributionRuleSet(value: unknown): CompiledAttributionRuleSet {
  if (!isRecord(value) || !hasOnlyKeys(value, ['schemaVersion', 'version', 'rules'])) {
    throw new AttributionRuleSchemaError(['ruleset must contain only schemaVersion/version/rules'])
  }
  const issues: string[] = []
  if (value.schemaVersion !== 1) issues.push('ruleset schemaVersion must be 1')
  if (!Number.isSafeInteger(value.version) || (value.version as number) < 1) issues.push('ruleset version must be a positive integer')
  if (!Array.isArray(value.rules) || value.rules.length === 0 || value.rules.length > MAX_RULES) {
    issues.push(`ruleset must contain 1-${MAX_RULES} rules`)
  }
  if (issues.length > 0 || !Array.isArray(value.rules)) throw new AttributionRuleSchemaError(issues)
  const parsed: AttributionRule[] = []
  value.rules.forEach((rule, index) => {
    try {
      parsed.push(parseAttributionRule(rule, { allowCustom: true }))
    } catch (error) {
      const detail = error instanceof AttributionRuleSchemaError ? error.issues.join(', ') : 'unknown error'
      issues.push(`rules[${index}]: ${detail}`)
    }
  })
  const seen = new Set<string>()
  for (const rule of parsed) {
    if (seen.has(rule.ruleCode)) issues.push(`duplicate ruleCode ${rule.ruleCode}`)
    seen.add(rule.ruleCode)
  }
  if (issues.length > 0) throw new AttributionRuleSchemaError(issues)
  const rules = parsed
    .map(canonicalizeAttributionRule)
    .sort((left, right) => right.priority - left.priority || compareCodeUnit(left.ruleCode, right.ruleCode))
  const canonical = { schemaVersion: 1 as const, version: value.version as number, rules }
  const canonicalJson = stableJson(canonical)
  return {
    ...canonical,
    canonicalJson,
    rulesetHash: `sha256:${createHash('sha256').update(canonicalJson, 'utf8').digest('hex')}`,
  }
}

export function defaultAttributionRuleSet(version = 1): CompiledAttributionRuleSet {
  return compileAttributionRuleSet({ schemaVersion: 1, version, rules: PRESET_ATTRIBUTION_RULES })
}
