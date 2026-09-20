import { Alert, Button, Card, Input, InputNumber, Select, Space, Switch, Tag, Typography } from 'antd'
import type { AttributionRuleCondition, AttributionRuleDefinition } from '../../hooks/useAttributionRules'
import {
  ADMIN_EDITABLE_ACTIONS,
  ATTRIBUTION_RULE_FIELD_OPTIONS,
  ATTRIBUTION_RULE_OPERATOR_OPTIONS,
  validateEditableRules,
} from '../../hooks/useAttributionRules'

const { Text } = Typography

function nextId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function blankCondition(): AttributionRuleCondition {
  return {
    id: nextId('condition'),
    field: 'commit.author_identity',
    operator: 'VERIFIED_IDENTITY_MATCH',
  }
}

function createCandidateRule(): AttributionRuleDefinition {
  const suffix = Date.now().toString(36).toUpperCase()
  return {
    id: nextId('rule'),
    rule_code: `ATTR_CUSTOM_CANDIDATE_${suffix}`,
    display_name: '新的候选规则',
    description: '满足受控条件时交给 AI 判断相关性，不直接确认提交归属。',
    priority: 500,
    enabled: true,
    capability: 'GIT_BASE',
    match: 'ALL',
    conditions: [blankCondition()],
    action: { type: 'ADD_AI_CANDIDATE', reason_code: `ATTR_CUSTOM_CANDIDATE_${suffix}` },
    system_locked: false,
  }
}

function cloneRule(rule: AttributionRuleDefinition): AttributionRuleDefinition {
  const suffix = Date.now().toString(36).toUpperCase()
  return {
    ...rule,
    id: nextId('rule'),
    rule_code: `ATTR_CUSTOM_COPY_${suffix}`,
    display_name: `${rule.display_name}（副本）`,
    priority: Math.min(500, Math.max(300, rule.priority)),
    conditions: rule.conditions.map((condition) => ({ ...condition, id: nextId('condition') })),
    action: { type: 'ADD_AI_CANDIDATE', reason_code: `ATTR_CUSTOM_COPY_${suffix}` },
    system_locked: false,
  }
}

export function RuleVisualEditor({
  rules,
  readOnly,
  mrEnhancedAvailable,
  onChange,
}: {
  rules: AttributionRuleDefinition[]
  readOnly: boolean
  mrEnhancedAvailable: boolean
  onChange(rules: AttributionRuleDefinition[]): void
}) {
  const issues = validateEditableRules(rules)
  const updateRule = (ruleId: string, update: (rule: AttributionRuleDefinition) => AttributionRuleDefinition) => {
    onChange(rules.map((rule) => (rule.id === ruleId ? update(rule) : rule)))
  }
  const move = (index: number, delta: number) => {
    const destination = index + delta
    if (destination < 0 || destination >= rules.length) return
    const next = [...rules]
    ;[next[index], next[destination]] = [next[destination]!, next[index]!]
    onChange(next)
  }

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      {issues.length > 0 ? (
        <Alert
          type="warning"
          showIcon
          title={`本地发现 ${String(issues.length)} 个问题`}
          description="本地检查只用于提前提示；发布仍以数据库校验与冻结样本模拟为准。"
        />
      ) : null}
      {!readOnly ? (
        <Button type="dashed" block onClick={() => onChange([...rules, createCandidateRule()])}>
          新增 AI 候选规则
        </Button>
      ) : null}
      {rules.map((rule, index) => {
        const locked = readOnly || rule.system_locked
        const ruleIssues = issues.filter((issue) => issue.rule_id === rule.id)
        return (
          <Card
            key={rule.id}
            size="small"
            title={
              <Space wrap>
                <Text strong>{rule.display_name}</Text>
                <Tag>{rule.rule_code}</Tag>
                {rule.system_locked ? <Tag color="gold">安全底线 · 已锁定</Tag> : <Tag color="blue">管理员候选规则</Tag>}
                {rule.capability === 'MR_ENHANCED' ? (
                  <Tag color={mrEnhancedAvailable ? 'purple' : 'default'}>
                    {mrEnhancedAvailable ? '依赖 MR 增强' : 'MR 条件不可用，将跳过'}
                  </Tag>
                ) : null}
              </Space>
            }
            extra={
              readOnly ? null : (
                <Space size={4}>
                  <Button size="small" disabled={index === 0 || rule.system_locked} onClick={() => move(index, -1)}>上移</Button>
                  <Button size="small" disabled={index === rules.length - 1 || rule.system_locked} onClick={() => move(index, 1)}>下移</Button>
                  <Button size="small" onClick={() => onChange([...rules, cloneRule(rule)])}>复制</Button>
                  <Button danger size="small" disabled={rule.system_locked} onClick={() => onChange(rules.filter((item) => item.id !== rule.id))}>删除</Button>
                </Space>
              )
            }
          >
            <Space direction="vertical" size={10} style={{ width: '100%' }}>
              <Space wrap style={{ width: '100%' }}>
                <Input
                  aria-label="规则名称"
                  style={{ width: 260 }}
                  value={rule.display_name}
                  disabled={locked}
                  onChange={(event) => updateRule(rule.id, (current) => ({ ...current, display_name: event.target.value }))}
                />
                <Switch
                  checked={rule.enabled}
                  disabled={locked}
                  checkedChildren="启用"
                  unCheckedChildren="停用"
                  onChange={(enabled) => updateRule(rule.id, (current) => ({ ...current, enabled }))}
                />
                <Text type="secondary">优先级</Text>
                <InputNumber
                  min={rule.system_locked ? 0 : 300}
                  max={rule.system_locked ? 1000 : 500}
                  value={rule.priority}
                  disabled={locked}
                  onChange={(priority) => updateRule(rule.id, (current) => ({ ...current, priority: priority ?? current.priority }))}
                />
              </Space>
              <Input.TextArea
                aria-label="规则说明"
                autoSize={{ minRows: 2, maxRows: 4 }}
                value={rule.description}
                disabled={locked}
                onChange={(event) => updateRule(rule.id, (current) => ({ ...current, description: event.target.value }))}
              />
              <Space wrap>
                <Text strong>条件组</Text>
                <Select
                  style={{ width: 140 }}
                  value={rule.match}
                  disabled={locked}
                  options={[{ value: 'ALL', label: '全部满足' }, { value: 'ANY', label: '任一满足' }]}
                  onChange={(match) => updateRule(rule.id, (current) => ({ ...current, match }))}
                />
              </Space>
              {rule.conditions.map((condition) => (
                <Space key={condition.id} wrap align="start">
                  <Select
                    aria-label="条件字段"
                    style={{ width: 250 }}
                    value={condition.field}
                    disabled={locked}
                    options={ATTRIBUTION_RULE_FIELD_OPTIONS.map((option) => ({ value: option.value, label: option.label }))}
                    onChange={(field) => updateRule(rule.id, (current) => ({
                      ...current,
                      conditions: current.conditions.map((item) => item.id === condition.id ? { ...item, field } : item),
                    }))}
                  />
                  <Select
                    aria-label="条件运算符"
                    style={{ width: 210 }}
                    value={condition.operator}
                    disabled={locked}
                    options={[...ATTRIBUTION_RULE_OPERATOR_OPTIONS]}
                    onChange={(operator) => updateRule(rule.id, (current) => ({
                      ...current,
                      conditions: current.conditions.map((item) => item.id === condition.id ? { ...item, operator } : item),
                    }))}
                  />
                  <Input
                    aria-label="条件值"
                    style={{ width: 220 }}
                    value={typeof condition.value === 'string' ? condition.value : ''}
                    placeholder="仅需要参数的条件填写"
                    disabled={locked}
                    onChange={(event) => updateRule(rule.id, (current) => ({
                      ...current,
                      conditions: current.conditions.map((item) => item.id === condition.id ? { ...item, value: event.target.value } : item),
                    }))}
                  />
                  {!locked ? (
                    <Button danger size="small" onClick={() => updateRule(rule.id, (current) => ({
                      ...current,
                      conditions: current.conditions.filter((item) => item.id !== condition.id),
                    }))}>删除条件</Button>
                  ) : null}
                </Space>
              ))}
              {!locked ? (
                <Button size="small" onClick={() => updateRule(rule.id, (current) => ({
                  ...current,
                  conditions: [...current.conditions, blankCondition()],
                }))}>添加条件</Button>
              ) : null}
              <Space wrap>
                <Text strong>动作</Text>
                {rule.system_locked ? (
                  <Tag color="gold">{rule.action.type}</Tag>
                ) : (
                  <Select
                    aria-label="规则动作"
                    style={{ width: 220 }}
                    value={rule.action.type}
                    disabled={readOnly}
                    options={[...ADMIN_EDITABLE_ACTIONS]}
                    onChange={(type) => updateRule(rule.id, (current) => ({ ...current, action: { ...current.action, type } }))}
                  />
                )}
                <Text type="secondary">原因码</Text>
                <Input
                  aria-label="原因码"
                  style={{ width: 240 }}
                  value={rule.action.reason_code}
                  disabled={locked}
                  onChange={(event) => updateRule(rule.id, (current) => ({
                    ...current,
                    action: { ...current.action, reason_code: event.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '') },
                  }))}
                />
              </Space>
              {ruleIssues.map((issue) => <Alert key={issue.code} type="error" showIcon message={issue.message} />)}
            </Space>
          </Card>
        )
      })}
    </Space>
  )
}
