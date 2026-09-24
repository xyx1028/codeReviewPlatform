import { Alert, Button, Card, Collapse, Empty, Input, InputNumber, List, Select, Space, Switch, Tag, Typography } from 'antd'
import type { AttributionRuleCondition, AttributionRuleDefinition } from '../../hooks/useAttributionRules'
import {
  ADMIN_EDITABLE_ACTIONS,
  ATTRIBUTION_RULE_FIELD_OPTIONS,
  ATTRIBUTION_RULE_OPERATOR_OPTIONS,
  attributionRuleActionLabel,
  attributionRuleFieldLabel,
  attributionRuleOperatorLabel,
  attributionRuleReasonCodeLabel,
  validateEditableRules,
} from '../../hooks/useAttributionRules'

const { Text, Paragraph } = Typography

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

/**
 * 查看模式：只读，不复用带一堆禁用输入框的编辑表单。
 *
 * 之前查看已发布/已锁定版本时直接把编辑表单整套禁用态渲染出来——每条规则都是一屏的
 * 输入框、下拉框和灰色开关，字段名和运算符还是英文代码（如 commit.author_identity /
 * VERIFIED_IDENTITY_MATCH），没人看得懂在说什么，页面也被撑得很长。查看不需要"能编辑
 * 但被禁用"的控件，只需要一句话能读懂这条规则在干什么——用带分页的列表而不是无限堆卡片，
 * 规则一多也不会把整页拖得很长。
 */
function RuleReadOnlyList({
  rules,
  mrEnhancedAvailable,
}: {
  rules: AttributionRuleDefinition[]
  mrEnhancedAvailable: boolean
}) {
  if (rules.length === 0) return <Empty description="这个版本没有规则" />
  return (
    <List<AttributionRuleDefinition>
      className="attribution-rule-list"
      bordered
      dataSource={rules}
      // 与「技能」页保持一致：右下角「共 N 条 + 页码 + 每页条数」。
      pagination={{
        pageSize: 10,
        showSizeChanger: true,
        showTotal: (total) => `共 ${String(total)} 条`,
        align: 'end',
      }}
      renderItem={(rule) => (
        <List.Item
          key={rule.id}
          className={`attribution-rule-list-item ${rule.system_locked ? 'attribution-rule-list-item--locked' : 'attribution-rule-list-item--candidate'}`}
        >
          {/* 折叠：一行看清"这条规则叫什么、命中会怎样"，条件明细点开再看。
              用 antd Collapse 而不是自己写一个可点的 div —— 键盘操作与 aria-expanded 都由它负责。 */}
          <Collapse
            ghost
            className="attribution-rule-collapse"
            items={[{
              key: rule.id,
              label: (
                <div className="attribution-rule-list-item__header">
                  <Text strong className="attribution-rule-list-item__title">{rule.display_name}</Text>
                  <Space wrap size={6}>
                    {rule.system_locked ? <Tag color="gold">安全底线 · 不可改</Tag> : <Tag color="blue">管理员候选规则</Tag>}
                    <Tag color={rule.enabled ? 'green' : 'default'}>{rule.enabled ? '启用中' : '已停用'}</Tag>
                    {rule.capability === 'MR_ENHANCED' ? (
                      <Tag color={mrEnhancedAvailable ? 'purple' : 'default'}>
                        {mrEnhancedAvailable ? '依赖 MR 增强' : 'MR 增强未配置 · 会跳过'}
                      </Tag>
                    ) : null}
                    <Tag bordered={false} className="attribution-rule-list-item__priority-tag">优先级 {rule.priority}</Tag>
                    {/* 命中后的动作是这条规则最关键的一句，收起时也要能看见。 */}
                    <Text type="secondary" className="attribution-rule-list-item__action-summary">
                      命中后：{attributionRuleActionLabel(rule.action.type)}
                    </Text>
                  </Space>
                </div>
              ),
              children: (
                <>
                  {rule.description.trim() === '' ? null : (
                    <Paragraph type="secondary" className="attribution-rule-list-item__description">
                      {rule.description}
                    </Paragraph>
                  )}
                  <div className="attribution-rule-list-item__body">
                    <Text type="secondary">满足{rule.match === 'ALL' ? '下列全部条件' : '下列任一条件'}：</Text>
                    <ul className="attribution-rule-list-item__conditions">
                      {rule.conditions.map((condition) => (
                        <li key={condition.id}>
                          {attributionRuleFieldLabel(condition.field)} · {attributionRuleOperatorLabel(condition.operator)}
                          {condition.value === undefined || condition.value === null || condition.value === ''
                            ? ''
                            : `「${String(condition.value)}」`}
                        </li>
                      ))}
                    </ul>
                    <Text>
                      命中后：<Text strong>{attributionRuleActionLabel(rule.action.type)}</Text>
                      <Text type="secondary">（原因：{attributionRuleReasonCodeLabel(rule.action.reason_code)}）</Text>
                    </Text>
                  </div>
                </>
              ),
            }]}
          />
        </List.Item>
      )}
    />
  )
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
  if (readOnly) {
    return <RuleReadOnlyList rules={rules} mrEnhancedAvailable={mrEnhancedAvailable} />
  }

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
                  <Tag color="gold">{attributionRuleActionLabel(rule.action.type)}</Tag>
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
