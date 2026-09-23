import { useMemo } from 'react'
import { Alert, Card, Empty, Space, Typography } from 'antd'
import { RuleVisualEditor } from '../components/attribution-rules/RuleVisualEditor'
import {
  useAttributionRules,
  type AttributionRulesApi,
} from '../hooks/useAttributionRules'

const { Title, Text } = Typography

/**
 * 归属规则：只读展示。
 *
 * 规则目前**只能由平台预置**（`analysis_attribution_rule_version` 里的系统基线），
 * 界面的职责就是让人看清"平台凭什么把某个提交算进某个需求"，不提供草稿、模拟与发布入口。
 * 草稿/校验/模拟/发布这套读写链路在数据库与 hook 里仍然存在（`useAttributionRules` 暴露着
 * createDraft / saveDraft / validateDraft / simulateDraft / publishVersion），
 * 将来要放开编辑时把入口接回来即可，不需要重写数据层。
 */
export function AttributionRuleManagementPage({
  isAdmin,
  api = null,
}: {
  isAdmin: boolean
  /** 未注入时页面不会请求或伪造数据；正式路由注入数据库可信 API。 */
  api?: AttributionRulesApi | null
}) {
  const rulesState = useAttributionRules(api, isAdmin)
  const catalog = rulesState.catalogQuery.data
  const publishedVersion = useMemo(() => {
    if (catalog === undefined) return null
    return catalog.versions.find((version) => version.id === catalog.current_published_version_id)
      ?? catalog.versions[0]
      ?? null
  }, [catalog])

  if (!isAdmin) {
    return <Alert type="error" showIcon title="无权限访问" description="只有管理员可以查看归属规则；服务端 RPC 仍需独立执行 ADMIN 校验。" />
  }

  if (!rulesState.apiAvailable) {
    return (
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <Title level={4} style={{ marginBottom: 0 }}>归属规则</Title>
        <Alert
          type="info"
          showIcon
          title="页面模块已就绪，待数据库 API 接入"
          description="当前未注入 AttributionRulesApi，因此不会展示示例规则或发出网络请求。"
        />
      </Space>
    )
  }

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Space direction="vertical" size={4} style={{ width: '100%' }}>
        <Title level={4} style={{ marginBottom: 0 }}>归属规则</Title>
        <Text type="secondary">规则由平台预置，决定提交是否进入需求分析上下文，不代表代码所有权或个人绩效。</Text>
      </Space>
      {rulesState.catalogQuery.isError ? (
        <Alert type="error" showIcon title="读取归属规则失败" description={rulesState.catalogQuery.error instanceof Error ? rulesState.catalogQuery.error.message : '未知错误'} />
      ) : null}
      {rulesState.catalogQuery.isLoading ? <Card loading /> : null}
      {catalog === undefined ? null : publishedVersion === null ? (
        <Empty description="没有规则版本" />
      ) : (
        <RuleVisualEditor
          rules={publishedVersion.rules}
          readOnly
          mrEnhancedAvailable={catalog.mr_enhanced_available === true}
          // 只读视图不会回调；保留这个参数是为了不改动编辑器组件的签名。
          onChange={() => undefined}
        />
      )}
    </Space>
  )
}
