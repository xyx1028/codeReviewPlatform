import { useMemo, useState } from 'react'
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Descriptions,
  Empty,
  Input,
  Modal,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd'
import { RuleSimulation } from '../components/attribution-rules/RuleSimulation'
import { RuleVisualEditor } from '../components/attribution-rules/RuleVisualEditor'
import {
  isAttributionRulePublishable,
  useAttributionRules,
  validateEditableRules,
  type AttributionRuleDefinition,
  type AttributionRulesApi,
  type AttributionRuleVersion,
} from '../hooks/useAttributionRules'

const { Title, Text } = Typography

function shortHash(hash: string | null): string {
  if (hash === null) return '—'
  return hash.replace(/^sha256:/, '').slice(0, 12)
}

function versionLabel(version: AttributionRuleVersion): string {
  if (version.version === null) return `草稿 r${version.revision}`
  return `v${version.version} · ${version.status === 'PUBLISHED' ? '已发布' : '历史版本'}`
}

export function AttributionRuleManagementPage({
  isAdmin,
  api = null,
}: {
  isAdmin: boolean
  /** 未注入时页面不会请求或伪造数据；正式路由注入数据库可信 API。 */
  api?: AttributionRulesApi | null
}) {
  const { message, modal } = AntApp.useApp()
  const rulesState = useAttributionRules(api, isAdmin)
  const catalog = rulesState.catalogQuery.data
  const [pickedVersionId, setPickedVersionId] = useState<string | null>(null)
  const selectedVersion = useMemo(() => {
    if (catalog === undefined) return null
    const effectiveId = pickedVersionId ?? catalog.current_published_version_id
    return catalog.versions.find((version) => version.id === effectiveId) ?? catalog.versions[0] ?? null
  }, [catalog, pickedVersionId])
  const [editorState, setEditorState] = useState<{
    versionId: string
    rules: AttributionRuleDefinition[]
    validation: AttributionRuleVersion['validation']
    simulation: AttributionRuleVersion['latest_simulation']
  } | null>(null)
  const selectedEditorState = editorState?.versionId === selectedVersion?.id ? editorState : null
  const stateMatchesSelection = selectedEditorState !== null
  const editedRules = selectedEditorState?.rules ?? selectedVersion?.rules ?? []
  const validation = selectedEditorState?.validation ?? selectedVersion?.validation ?? null
  const simulation = selectedEditorState?.simulation ?? selectedVersion?.latest_simulation ?? null
  const [pickedSampleSetId, setPickedSampleSetId] = useState<string | null>(null)
  const sampleSetId = pickedSampleSetId ?? catalog?.sample_sets[0]?.id ?? null
  const [publishOpen, setPublishOpen] = useState(false)
  const [publishReason, setPublishReason] = useState('')

  const updateEditorState = (update: Partial<Omit<NonNullable<typeof editorState>, 'versionId'>>) => {
    if (selectedVersion === null) return
    const base = stateMatchesSelection && editorState !== null
      ? editorState
      : {
          versionId: selectedVersion.id,
          rules: selectedVersion.rules,
          validation: selectedVersion.validation,
          simulation: selectedVersion.latest_simulation,
        }
    setEditorState({ ...base, ...update })
  }

  if (!isAdmin) {
    return <Alert type="error" showIcon title="无权限访问" description="只有管理员可以维护归属规则；服务端 RPC 仍需独立执行 ADMIN 校验。" />
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

  const handleError = (error: unknown) => message.error(error instanceof Error ? error.message : String(error))
  const canManageDrafts = api?.draftManagementAvailable === true
  const canRunTrustedSimulation = api?.trustedSimulationAvailable === true
  const isDraft = selectedVersion?.status === 'DRAFT' || selectedVersion?.status === 'VALIDATED'
  const localIssues = validateEditableRules(editedRules)
  const publishable = selectedVersion !== null && isAttributionRulePublishable(validation, simulation, selectedVersion.revision)
  const save = async () => {
    if (selectedVersion === null || !isDraft) return
    if (localIssues.some((issue) => issue.severity === 'ERROR')) {
      message.error('请先修复本地检查问题')
      return
    }
    try {
      const result = await rulesState.saveDraft.mutateAsync({
        draftVersionId: selectedVersion.id,
        expectedRevision: selectedVersion.revision,
        rules: editedRules,
      })
      setPickedVersionId(result.id)
      setEditorState({
        versionId: result.id,
        rules: result.rules,
        validation: null,
        simulation: null,
      })
      message.success(`草稿已保存为 revision ${String(result.revision)}，需重新校验与模拟`)
    } catch (error) { handleError(error) }
  }

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Space direction="vertical" size={4} style={{ width: '100%' }}>
        <Title level={4} style={{ marginBottom: 0 }}>归属规则</Title>
        <Text type="secondary">规则只决定提交是否进入需求分析上下文，不代表代码所有权或个人绩效。发布只影响之后创建的 Job。</Text>
      </Space>
      {!canManageDrafts || !canRunTrustedSimulation ? (
        <Alert
          type="warning"
          showIcon
          title="当前后端仅支持安全查看，规则变更暂不可发布"
          description={api?.unavailableReason ?? '可信模拟服务尚未接入。模拟必须由服务端执行并写回，浏览器不能自报 passed。'}
        />
      ) : null}
      {rulesState.catalogQuery.isError ? (
        <Alert type="error" showIcon title="读取归属规则失败" description={rulesState.catalogQuery.error instanceof Error ? rulesState.catalogQuery.error.message : '未知错误'} />
      ) : null}
      {rulesState.catalogQuery.isLoading ? <Card loading /> : null}
      {catalog === undefined ? null : (
        <>
          <Card title="当前版本与能力">
            <Descriptions column={{ xs: 1, md: 3 }}>
              <Descriptions.Item label="规则集">{catalog.rule_set_name}</Descriptions.Item>
              <Descriptions.Item label="当前生效版本">{catalog.versions.find((item) => item.id === catalog.current_published_version_id)?.version ?? '尚未发布'}</Descriptions.Item>
              <Descriptions.Item label="MR 增强">{catalog.mr_enhanced_available === true ? <Tag color="green">可用</Tag> : catalog.mr_enhanced_available === false ? <Tag>未配置，相关规则自动跳过</Tag> : <Tag>Foundation API 未披露</Tag>}</Descriptions.Item>
            </Descriptions>
            <Space wrap>
              <Select
                style={{ minWidth: 260 }}
                value={selectedVersion?.id}
                placeholder="选择版本"
                options={catalog.versions.map((version) => ({ value: version.id, label: versionLabel(version) }))}
                onChange={setPickedVersionId}
              />
              <Button
                type="primary"
                disabled={!canManageDrafts || selectedVersion === null || selectedVersion.status === 'DRAFT' || selectedVersion.status === 'VALIDATED'}
                title={!canManageDrafts ? '需要服务端补齐草稿、历史和样本读模型' : undefined}
                loading={rulesState.createDraft.isPending}
                onClick={() => {
                  if (selectedVersion === null) return
                  void rulesState.createDraft.mutateAsync(selectedVersion.id).then((draft) => {
                    setPickedVersionId(draft.id)
                    message.success('已从所选发布版本复制草稿；发布版本仍保持只读')
                  }).catch(handleError)
                }}
              >编辑（创建草稿）</Button>
            </Space>
          </Card>

          {selectedVersion === null ? <Empty description="没有规则版本" /> : (
            <>
              <Card
                title={versionLabel(selectedVersion)}
                extra={<Space><Tag>{shortHash(selectedVersion.ruleset_hash)}</Tag><Tag color={isDraft ? 'blue' : 'green'}>{isDraft ? '可编辑草稿' : '不可变快照'}</Tag></Space>}
              >
                <Descriptions size="small" column={{ xs: 1, md: 3 }}>
                  <Descriptions.Item label="创建人 / 时间">{selectedVersion.created_by_name ?? '—'} · {selectedVersion.created_at === null ? '服务未返回' : new Date(selectedVersion.created_at).toLocaleString()}</Descriptions.Item>
                  <Descriptions.Item label="发布人 / 时间">{selectedVersion.published_by_name ?? '—'} · {selectedVersion.published_at === null ? '—' : new Date(selectedVersion.published_at).toLocaleString()}</Descriptions.Item>
                  <Descriptions.Item label="使用 Job 数">{selectedVersion.referenced_job_count ?? '服务未返回'}</Descriptions.Item>
                  <Descriptions.Item label="发布原因" span={3}>{selectedVersion.publish_reason ?? '—'}</Descriptions.Item>
                </Descriptions>
                {isDraft ? (
                  <Space wrap style={{ marginTop: 12 }}>
                    <Button type="primary" loading={rulesState.saveDraft.isPending} onClick={() => void save()}>保存草稿</Button>
                    <Button
                      loading={rulesState.validateDraft.isPending}
                      onClick={() => void rulesState.validateDraft.mutateAsync({ draftVersionId: selectedVersion.id, expectedRevision: selectedVersion.revision }).then((result) => { updateEditorState({ validation: result }); message.success(result.passed ? '数据库校验通过' : '数据库校验未通过') }).catch(handleError)}
                    >数据库校验</Button>
                    <Select
                      style={{ minWidth: 220 }}
                      value={sampleSetId}
                      placeholder="选择冻结样本"
                      options={catalog.sample_sets.map((sample) => ({ value: sample.id, label: sample.label }))}
                      onChange={setPickedSampleSetId}
                    />
                    <Button
                      disabled={!canRunTrustedSimulation || sampleSetId === null}
                      title={!canRunTrustedSimulation ? '需要由数据库执行安全契约检查并写回结果' : undefined}
                      loading={rulesState.simulateDraft.isPending}
                      onClick={() => {
                        if (sampleSetId === null) return
                        void rulesState.simulateDraft.mutateAsync({ draftVersionId: selectedVersion.id, expectedRevision: selectedVersion.revision, sampleSetId }).then((result) => { updateEditorState({ simulation: result }); message.success(result.passed ? '数据库安全契约检查通过' : '数据库安全契约检查未通过') }).catch(handleError)
                      }}
                    >运行数据库安全契约检查</Button>
                    <Button type="primary" disabled={!publishable} onClick={() => setPublishOpen(true)}>发布</Button>
                  </Space>
                ) : selectedVersion.id !== catalog.current_published_version_id ? (
                  <Button
                    style={{ marginTop: 12 }}
                    onClick={() => modal.confirm({
                      title: `恢复 ${versionLabel(selectedVersion)}？`,
                      content: '恢复不会修改历史版本，而是复制该快照并发布为一个新版本；只影响之后的新 Job。',
                      okText: '创建恢复版本',
                      onOk: () => rulesState.restoreVersion.mutateAsync({ sourceVersionId: selectedVersion.id, reason: `恢复自 ${versionLabel(selectedVersion)}` }).then((restored) => { setPickedVersionId(restored.id); message.success('已创建并发布新的恢复版本') }).catch(handleError),
                    })}
                  >恢复为新版本</Button>
                ) : null}
              </Card>
              <RuleVisualEditor rules={editedRules} readOnly={!isDraft || !canManageDrafts} mrEnhancedAvailable={catalog.mr_enhanced_available === true} onChange={(next) => updateEditorState({ rules: next, validation: null, simulation: null })} />
              {isDraft ? <RuleSimulation validation={validation} simulation={simulation} revision={selectedVersion.revision} /> : null}
            </>
          )}

          <Card title="发布记录与审计快照">
            <Table<AttributionRuleVersion>
              size="small"
              rowKey="id"
              dataSource={catalog.versions.filter((version) => version.version !== null)}
              pagination={false}
              columns={[
                { title: '版本', render: (_value, row) => versionLabel(row) },
                { title: 'Hash', dataIndex: 'ruleset_hash', render: (value: string | null) => <Text code>{shortHash(value)}</Text> },
                { title: '发布人', dataIndex: 'published_by_name', render: (value: string | null) => value ?? '—' },
                { title: '发布时间', dataIndex: 'published_at', render: (value: string | null) => value === null ? '—' : new Date(value).toLocaleString() },
                { title: '发布原因', dataIndex: 'publish_reason', ellipsis: true },
                { title: '使用 Job', dataIndex: 'referenced_job_count', render: (value: number | null) => value ?? '服务未返回' },
              ]}
            />
          </Card>
        </>
      )}
      <Modal
        open={publishOpen}
        title="发布归属规则版本"
        okText="确认发布"
        cancelText="取消"
        confirmLoading={rulesState.publishVersion.isPending}
        okButtonProps={{ disabled: publishReason.trim().length < 3 || !publishable }}
        onCancel={() => setPublishOpen(false)}
        onOk={() => {
          if (selectedVersion === null) return
          void rulesState.publishVersion.mutateAsync({ draftVersionId: selectedVersion.id, expectedRevision: selectedVersion.revision, reason: publishReason.trim() }).then((published) => {
            setPublishOpen(false)
            setPublishReason('')
            setPickedVersionId(published.id)
            message.success('已发布不可变新版本；只影响之后创建的 Job')
          }).catch(handleError)
        }}
      >
        <Alert type="warning" showIcon title="发布只影响新 Job" description="在途任务、历史 Attempt 和已经冻结规则版本的 Job 不会重算或漂移。" />
        <Input.TextArea style={{ marginTop: 12 }} value={publishReason} onChange={(event) => setPublishReason(event.target.value)} placeholder="填写发布原因（至少 3 个字符）" autoSize={{ minRows: 3, maxRows: 6 }} />
      </Modal>
    </Space>
  )
}
