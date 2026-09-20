import { Alert, Card, Col, Descriptions, Empty, Row, Statistic, Tag, Typography } from 'antd'
import { isAttributionRulePublishable, type AttributionRuleSimulationResult, type AttributionRuleValidationResult } from '../../hooks/useAttributionRules'

const { Text } = Typography

export function RuleSimulation({
  validation,
  simulation,
  revision,
}: {
  validation: AttributionRuleValidationResult | null
  simulation: AttributionRuleSimulationResult | null
  revision: number
}) {
  const publishable = isAttributionRulePublishable(validation, simulation, revision)
  return (
    <Card
      title="数据库安全契约检查与发布门禁"
      extra={<Tag color={publishable ? 'green' : 'orange'}>{publishable ? '允许发布' : '尚不可发布'}</Tag>}
    >
      <Alert
        type="info"
        showIcon
        title="这不是效果、准确率或召回率评估"
        description="SYSTEM_SAFETY_CONTRACT_V1 只检查系统强动作规则完整性，以及管理员规则的动作、字段、算子、优先级、revision 和 hash。"
      />
      <Descriptions size="small" column={{ xs: 1, md: 3 }} style={{ marginTop: 12 }}>
        <Descriptions.Item label="当前草稿 revision">{revision}</Descriptions.Item>
        <Descriptions.Item label="数据库校验">
          {validation === null ? '未执行' : validation.passed ? `已通过 · r${validation.validated_revision}` : '未通过'}
        </Descriptions.Item>
        <Descriptions.Item label="安全契约">
          {simulation === null ? '未执行' : `${simulation.sample_set_label} · r${simulation.simulated_revision}`}
        </Descriptions.Item>
      </Descriptions>
      {validation !== null && validation.issues.length > 0 ? (
        <Alert
          style={{ marginTop: 12 }}
          type={validation.passed ? 'warning' : 'error'}
          showIcon
          title={`校验发现 ${String(validation.issues.length)} 项`}
          description={validation.issues.map((issue) => issue.message).join('；')}
        />
      ) : null}
      {simulation === null ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="请选择固定安全契约并运行数据库检查" />
      ) : (
        <>
          <Row gutter={[12, 12]} style={{ marginTop: 12 }}>
            <Col xs={12} md={4}><Statistic title="系统规则应有" value={simulation.contract_checks.system_rule_expected_count} /></Col>
            <Col xs={12} md={4}><Statistic title="系统规则实际" value={simulation.contract_checks.system_rule_count} /></Col>
            <Col xs={12} md={4}><Statistic title="管理员规则" value={simulation.contract_checks.custom_rule_count} /></Col>
            <Col xs={12} md={4}><Statistic title="受检条件" value={simulation.contract_checks.condition_count} /></Col>
            <Col xs={12} md={4}><Statistic title="失败检查" value={simulation.contract_checks.failed_check_count} valueStyle={{ color: simulation.contract_checks.failed_check_count > 0 ? '#cf1322' : undefined }} /></Col>
            <Col xs={12} md={4}><Statistic title="效果指标" value={simulation.metrics.effect_metrics_available ? '有' : '未评估'} /></Col>
          </Row>
          {simulation.blocking_reasons.length > 0 ? (
            <Alert style={{ marginTop: 12 }} type="error" showIcon title="安全契约未通过" description={simulation.blocking_reasons.join('；')} />
          ) : (
            <Text type="secondary">{simulation.assessment_note}</Text>
          )}
        </>
      )}
    </Card>
  )
}
