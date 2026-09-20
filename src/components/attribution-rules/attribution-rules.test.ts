import { describe, expect, it } from 'vitest'
import { isAttributionRulePublishable, validateEditableRules, type AttributionRuleDefinition, type AttributionRuleSimulationResult, type AttributionRuleValidationResult } from '../../hooks/useAttributionRules'

function candidateRule(overrides: Partial<AttributionRuleDefinition> = {}): AttributionRuleDefinition {
  return {
    id: 'rule-1',
    rule_code: 'CUSTOM_OWNER_MODULE',
    display_name: '人员与模块候选',
    description: '交给 AI 判断',
    priority: 500,
    enabled: true,
    capability: 'GIT_BASE',
    match: 'ALL',
    conditions: [{ id: 'condition-1', field: 'commit.author_identity', operator: 'VERIFIED_IDENTITY_MATCH' }],
    action: { type: 'ADD_AI_CANDIDATE', reason_code: 'CUSTOM_OWNER_MODULE' },
    system_locked: false,
    ...overrides,
  }
}

describe('归属规则前端安全约束', () => {
  it('管理员规则不能直接强关联或全仓降级', () => {
    const issues = validateEditableRules([candidateRule({ action: { type: 'SELECT_STRONG', reason_code: 'UNSAFE' } })])
    expect(issues.map((issue) => issue.code)).toContain('UNSAFE_CUSTOM_ACTION')
  })

  it('管理员优先级不能越过候选分组', () => {
    const issues = validateEditableRules([candidateRule({ priority: 900 })])
    expect(issues.map((issue) => issue.code)).toContain('CUSTOM_PRIORITY_OUT_OF_RANGE')
  })

  it('重复 rule code 与空条件会阻止保存提示', () => {
    const issues = validateEditableRules([
      candidateRule({ id: 'a', conditions: [] }),
      candidateRule({ id: 'b' }),
    ])
    expect(issues.map((issue) => issue.code)).toEqual(expect.arrayContaining(['CONDITION_REQUIRED', 'DUPLICATE_RULE_CODE']))
  })
})

describe('发布门禁', () => {
  const validation: AttributionRuleValidationResult = { passed: true, validated_revision: 4, issues: [], validated_at: '2026-09-19T00:00:00Z' }
  const simulation: AttributionRuleSimulationResult = {
    passed: true,
    evaluation_kind: 'SYSTEM_SAFETY_CONTRACT',
    contract_version: 'SYSTEM_SAFETY_CONTRACT_V1',
    assessment_note: '仅检查数据库安全契约，不评估效果。',
    sample_set_id: 'SYSTEM_SAFETY_CONTRACT_V1',
    sample_set_label: '系统安全契约 V1',
    simulated_revision: 4,
    simulated_ruleset_hash: 'hash-v4',
    simulated_at: '2026-09-19T00:00:01Z',
    metrics: {
      effect_metrics_available: false,
      gold_strong_false_positive_count: 0,
      strong_selected_delta: 0,
      ai_candidate_delta: 0,
      excluded_delta: 0,
      conflict_delta: 0,
      global_fallback_delta: 0,
    },
    contract_checks: {
      system_rule_expected_count: 13,
      system_rule_count: 13,
      custom_rule_count: 1,
      condition_count: 14,
      failed_check_count: 0,
    },
    blocking_reasons: [],
  }

  it('同一 revision 校验和固定数据库安全契约均通过才允许发布', () => {
    expect(isAttributionRulePublishable(validation, simulation, 4)).toBe(true)
  })

  it('草稿变更后旧校验和模拟自动失效', () => {
    expect(isAttributionRulePublishable(validation, simulation, 5)).toBe(false)
  })

  it('安全契约存在失败检查时禁止发布', () => {
    expect(isAttributionRulePublishable(validation, { ...simulation, contract_checks: { ...simulation.contract_checks, failed_check_count: 1 } }, 4)).toBe(false)
  })
})
