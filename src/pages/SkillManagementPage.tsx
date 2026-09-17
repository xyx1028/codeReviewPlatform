import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Checkbox,
  Col,
  Descriptions,
  Empty,
  Form,
  Input,
  Modal,
  Progress,
  Row,
  Space,
  Statistic,
  Table,
  Tag,
  Tooltip,
  Typography,
  Upload,
} from 'antd'
import type { UploadFile } from 'antd/es/upload/interface'
import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  adminCreateReviewSkill,
  adminCreateSkillDownloadUrl,
  adminGetReviewSkill,
  adminListReviewSkills,
  adminPublishSkillVersion,
  adminSetReviewSkillEnabled,
  adminUploadSkillBundle,
} from '../lib/api'
import type {
  ReviewSkillListItem,
  ReviewSkillStatus,
  ReviewSkillVersionDetail,
  SkillBundleFile,
  SkillFileRole,
  SkillValidationResult,
} from '../types'

const { Title, Text, Paragraph } = Typography

const STATUS_LABELS: Record<ReviewSkillStatus, { text: string; color: string }> = {
  DRAFT: { text: '草稿', color: 'default' },
  VALIDATING: { text: '校验中', color: 'processing' },
  PUBLISHED: { text: '已发布', color: 'green' },
  DISABLED: { text: '已停用', color: 'orange' },
  VALIDATION_FAILED: { text: '校验失败', color: 'red' },
}

const ROLE_LABELS: Record<SkillFileRole, string> = {
  ENTRY: '入口',
  REFERENCE: '参考资料',
  ASSET: '图片资源',
  TEMPLATE: '模板',
  SCRIPT: '脚本',
  OTHER: '其他',
}

function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

/**
 * 容量水位。
 *
 * 用百分比条而不是只显示数字，是因为 §8.2 的上限是**硬**上限：超了 `enqueue_analysis_job`
 * 直接失败，创建批次的人会看到一个与技能毫无关系的报错。让管理员在这一页就看见"快满了"
 * 比让他在别人建批次失败时才知道要好。
 */
function CapacityBar({
  title,
  used,
  limit,
  formatter,
}: {
  title: string
  used: number
  limit: number
  formatter?: (value: number) => string
}) {
  const format = formatter ?? ((value: number) => String(value))
  const percent = limit === 0 ? 0 : Math.min(100, Math.round((used / limit) * 100))
  return (
    <div>
      <Text type="secondary">{title}</Text>
      <div>
        <Text strong>{format(used)}</Text>
        <Text type="secondary"> / {format(limit)}</Text>
      </div>
      <Progress
        percent={percent}
        size="small"
        status={percent >= 100 ? 'exception' : percent >= 80 ? 'active' : 'normal'}
        showInfo={false}
      />
    </div>
  )
}

/** 服务端解析出来的文件树。展示 hash / MIME / 角色 / 大小，不展示任何文件正文。 */
function BundleFileTree({ files }: { files: SkillBundleFile[] }) {
  return (
    <Table<SkillBundleFile>
      dataSource={files}
      rowKey="path"
      size="small"
      pagination={files.length > 20 ? { pageSize: 20 } : false}
      columns={[
        { title: '路径', dataIndex: 'path', ellipsis: true },
        {
          title: '角色',
          dataIndex: 'role',
          width: 110,
          render: (role: SkillFileRole) => (
            <Tag color={role === 'SCRIPT' ? 'red' : role === 'ENTRY' ? 'blue' : 'default'}>
              {ROLE_LABELS[role]}
            </Tag>
          ),
        },
        { title: 'MIME', dataIndex: 'mediaType', width: 150 },
        {
          title: '大小',
          dataIndex: 'sizeBytes',
          width: 100,
          render: (value: number) => formatBytes(value),
        },
        {
          title: 'SHA-256',
          dataIndex: 'sha256',
          width: 160,
          render: (value: string) => (
            <Tooltip title={value}>
              <Text code>{value.replace('sha256:', '').slice(0, 12)}…</Text>
            </Tooltip>
          ),
        },
      ]}
    />
  )
}

interface PublishFormValues {
  acknowledge_scripts?: boolean
}

/**
 * ADMIN 维护多文件 Skill Bundle。
 *
 * 页面的核心约束来自方案 §14：
 *
 *   * `name` 创建后不可改 —— 它是 `<DSH_HOME>/skills/<name>/` 的目录名，改它等于换一个技能；
 *   * 上传只到 staging，**校验成功后才能发布**；
 *   * 文件树、每文件 hash/MIME/角色/大小全部来自服务端解析，前端不自己解 ZIP；
 *   * 含脚本的版本必须额外确认；
 *   * 发布后不可替换 ZIP，只能创建下一版本。
 *
 * 导航只对 ADMIN 显示，但那不是安全边界：`ensure_admin()` 与 Edge Function 的
 * `requireAdmin` 才是。
 */
export function SkillManagementPage({ isAdmin }: { isAdmin: boolean }) {
  const { message, modal } = AntApp.useApp()
  const queryClient = useQueryClient()
  const [createOpen, setCreateOpen] = useState(false)
  const [publishSkill, setPublishSkill] = useState<ReviewSkillListItem | null>(null)
  const [validation, setValidation] = useState<SkillValidationResult | null>(null)
  const [historySkillId, setHistorySkillId] = useState<string | null>(null)
  const [createForm] = Form.useForm<{ name: string; display_name: string }>()
  const [publishForm] = Form.useForm<PublishFormValues>()

  const catalogQuery = useQuery({
    queryKey: ['admin-review-skills'],
    enabled: isAdmin,
    queryFn: adminListReviewSkills,
  })
  const historyQuery = useQuery({
    queryKey: ['admin-review-skill', historySkillId],
    enabled: historySkillId !== null,
    queryFn: () => adminGetReviewSkill(historySkillId!),
  })

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['admin-review-skills'] })
    if (historySkillId !== null) {
      queryClient.invalidateQueries({ queryKey: ['admin-review-skill', historySkillId] })
    }
  }

  const createMutation = useMutation({
    mutationFn: (values: { name: string; display_name: string }) =>
      adminCreateReviewSkill({ name: values.name.trim(), displayName: values.display_name.trim() }),
    onSuccess: () => {
      message.success('技能已创建，接下来上传 Bundle ZIP')
      setCreateOpen(false)
      createForm.resetFields()
      invalidate()
    },
    onError: (error: Error) => message.error(error.message),
  })

  const uploadMutation = useMutation({
    mutationFn: (input: { skillId: string; file: File }) =>
      adminUploadSkillBundle(input.skillId, input.file),
    onSuccess: (result) => {
      setValidation(result)
      message.success(`校验通过：${result.file_count} 个文件`)
      invalidate()
    },
    onError: (error: Error) => {
      setValidation(null)
      // 校验失败的原因已经落库，刷新后仍然可见 —— 这里只是让它立刻出现。
      message.error(error.message)
      invalidate()
    },
  })

  const publishMutation = useMutation({
    mutationFn: (values: PublishFormValues) => {
      if (validation === null) throw new Error('请先上传并通过校验')
      // description / whenToUse 不在这里传：它们由服务端从 SKILL.md 的 frontmatter 取。
      return adminPublishSkillVersion({
        uploadId: validation.upload_id,
        acknowledgeScripts: values.acknowledge_scripts ?? false,
      })
    },
    onSuccess: (result) => {
      message.success(`已发布 V${result.version}`)
      setPublishSkill(null)
      setValidation(null)
      publishForm.resetFields()
      invalidate()
    },
    onError: (error: Error) => message.error(error.message),
  })

  const enabledMutation = useMutation({
    mutationFn: (input: { skillId: string; enabled: boolean }) =>
      adminSetReviewSkillEnabled(input.skillId, input.enabled),
    onSuccess: () => {
      message.success('技能状态已更新；只影响之后新建的 Job')
      invalidate()
    },
    onError: (error: Error) => message.error(error.message),
  })

  const downloadMutation = useMutation({
    mutationFn: (versionId: string) => adminCreateSkillDownloadUrl(versionId),
    onSuccess: (result) => {
      // 短期凭据：立即使用，不保存、不展示。
      window.open(result.signed_url, '_blank', 'noopener,noreferrer')
    },
    onError: (error: Error) => message.error(error.message),
  })

  const limits = catalogQuery.data?.limits
  const capacity = catalogQuery.data?.capacity
  const skills = useMemo(() => catalogQuery.data?.skills ?? [], [catalogQuery.data])

  if (!isAdmin) {
    return <Alert type="warning" showIcon message="仅管理员可以维护评审技能" />
  }

  const columns = [
    {
      title: '技能名称',
      dataIndex: 'name',
      render: (name: string) => <Text code>{name}</Text>,
    },
    { title: '显示名称', dataIndex: 'display_name' },
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (status: ReviewSkillStatus) => (
        <Tag color={STATUS_LABELS[status].color}>{STATUS_LABELS[status].text}</Tag>
      ),
    },
    {
      title: '当前版本',
      dataIndex: 'current_version',
      width: 100,
      render: (version: number | null) => (version === null ? '—' : `V${version}`),
    },
    { title: '文件数', dataIndex: 'file_count', width: 90, render: (v: number | null) => v ?? '—' },
    {
      title: 'ZIP / 展开',
      key: 'size',
      width: 150,
      render: (_unused: unknown, row: ReviewSkillListItem) =>
        `${formatBytes(row.archive_size_bytes)} / ${formatBytes(row.expanded_size_bytes)}`,
    },
    {
      title: '脚本',
      dataIndex: 'contains_scripts',
      width: 90,
      render: (containsScripts: boolean) =>
        containsScripts ? (
          <Tooltip title="此版本含 scripts/ 目录。Skill 加载不会自动执行它们，但拥有 bash 的 Agent 可以显式运行。">
            <Tag color="red">含脚本</Tag>
          </Tooltip>
        ) : (
          <Tag>无</Tag>
        ),
    },
    {
      title: 'description（首轮目录摘要）',
      dataIndex: 'description',
      ellipsis: true,
      render: (description: string | null) => description ?? <Text type="secondary">未发布</Text>,
    },
    {
      title: '更新人 / 时间',
      key: 'audit',
      width: 190,
      render: (_unused: unknown, row: ReviewSkillListItem) => (
        <Space direction="vertical" size={0}>
          <Text>{row.published_by_name ?? '—'}</Text>
          <Text type="secondary">
            {row.published_at === null ? '—' : new Date(row.published_at).toLocaleString()}
          </Text>
        </Space>
      ),
    },
    {
      title: '操作',
      key: 'actions',
      width: 280,
      render: (_unused: unknown, row: ReviewSkillListItem) => (
        <Space size={4} wrap>
          <Button
            size="small"
            onClick={() => {
              setPublishSkill(row)
              setValidation(null)
              publishForm.resetFields()
            }}
          >
            上传新版本
          </Button>
          <Button size="small" onClick={() => setHistorySkillId(row.id)}>
            版本历史
          </Button>
          {row.current_version_id !== null ? (
            <Button
              size="small"
              loading={downloadMutation.isPending}
              onClick={() => downloadMutation.mutate(row.current_version_id!)}
            >
              下载
            </Button>
          ) : null}
          {row.status === 'PUBLISHED' ? (
            <Button
              size="small"
              danger
              onClick={() =>
                modal.confirm({
                  title: `停用 ${row.name}？`,
                  content: '停用只影响之后新建的 Job；已在运行的 Job 继续使用它冻结的版本。',
                  onOk: () => enabledMutation.mutateAsync({ skillId: row.id, enabled: false }),
                })
              }
            >
              停用
            </Button>
          ) : row.current_version_id !== null ? (
            <Button
              size="small"
              onClick={() => enabledMutation.mutate({ skillId: row.id, enabled: true })}
            >
              启用
            </Button>
          ) : null}
        </Space>
      ),
    },
  ]

  return (
    <Space direction="vertical" size="large" className="full-width">
      <Card>
        <Space direction="vertical" size="small" className="full-width">
          <Space align="baseline" wrap>
            <Title level={4} className="mb-0">
              评审技能（DSH Skills）
            </Title>
            <Button type="primary" onClick={() => setCreateOpen(true)}>
              新增技能
            </Button>
          </Space>
          <Paragraph type="secondary" className="mb-0">
            这里维护的是**全量技能目录**：创建 Analysis Job 时，全部「已发布且启用」的版本会被
            整体冻结进那个 Job，所有需求任务共用同一份目录与同一个 catalog hash。发布 V2 或停用
            技能只影响之后新建的 Job，正在运行的 Job 继续使用它冻结的版本。
          </Paragraph>
          <Paragraph type="secondary" className="mb-0">
            dsh 首轮只看到技能的 name 与 description；Agent 调用 <Text code>skill(name)</Text> 之后
            才会读到 <Text code>SKILL.md</Text> 正文，再按 resourceBase 按需读取 references /
            assets / templates。<Text strong>脚本不会因为加载技能而被执行</Text>。
          </Paragraph>
        </Space>
      </Card>

      {capacity && limits ? (
        <Card title="全局目录容量">
          <Row gutter={[16, 16]}>
            <Col xs={24} sm={12} lg={5}>
              <CapacityBar
                title="已启用技能"
                used={capacity.enabled_bundles}
                limit={limits.catalogBundles}
              />
            </Col>
            <Col xs={24} sm={12} lg={5}>
              <CapacityBar
                title="首轮目录渲染"
                used={capacity.catalog_render_bytes}
                limit={limits.catalogRenderBytes}
                formatter={formatBytes}
              />
            </Col>
            <Col xs={24} sm={12} lg={5}>
              <CapacityBar
                title="归档总量"
                used={capacity.archive_bytes}
                limit={limits.catalogArchiveBytes}
                formatter={formatBytes}
              />
            </Col>
            <Col xs={24} sm={12} lg={5}>
              <CapacityBar
                title="展开总量"
                used={capacity.expanded_bytes}
                limit={limits.catalogExpandedBytes}
                formatter={formatBytes}
              />
            </Col>
            <Col xs={24} sm={12} lg={4}>
              <Statistic title="含脚本技能" value={capacity.script_bundles} />
            </Col>
          </Row>
          <Paragraph type="secondary" className="mt-2 mb-0">
            当前目录 catalog hash：<Text code>{capacity.catalog_hash.slice(0, 16)}…</Text>
            。它是「这套技能集合」的身份；新建 Job 会把它冻结下来，Worker 独立重算后必须一致才会启动。
          </Paragraph>
        </Card>
      ) : null}

      <Card>
        <Table<ReviewSkillListItem>
          dataSource={skills}
          rowKey="id"
          loading={catalogQuery.isLoading}
          columns={columns}
          scroll={{ x: 1500 }}
          locale={{ emptyText: <Empty description="还没有技能。新增一个并上传 Bundle ZIP。" /> }}
          expandable={{
            rowExpandable: (row) => row.latest_upload !== null,
            expandedRowRender: (row) =>
              row.latest_upload === null ? null : (
                <Space direction="vertical" className="full-width">
                  <Text strong>最近一次上传（尚未发布）</Text>
                  <Descriptions size="small" column={4}>
                    <Descriptions.Item label="状态">{row.latest_upload.status}</Descriptions.Item>
                    <Descriptions.Item label="文件数">
                      {row.latest_upload.file_count ?? '—'}
                    </Descriptions.Item>
                    <Descriptions.Item label="ZIP">
                      {formatBytes(row.latest_upload.archive_size_bytes)}
                    </Descriptions.Item>
                    <Descriptions.Item label="含脚本">
                      {row.latest_upload.contains_scripts ? '是' : '否'}
                    </Descriptions.Item>
                  </Descriptions>
                  {row.latest_upload.error_code !== null ? (
                    <Alert
                      type="error"
                      showIcon
                      message={`校验失败：${row.latest_upload.error_code}`}
                      description={row.latest_upload.error_message}
                    />
                  ) : null}
                  {row.latest_upload.bundle_manifest !== null ? (
                    <BundleFileTree files={row.latest_upload.bundle_manifest.files} />
                  ) : null}
                </Space>
              ),
          }}
        />
      </Card>

      <Modal
        title="新增技能"
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        onOk={() => createForm.submit()}
        confirmLoading={createMutation.isPending}
        destroyOnHidden
      >
        <Form form={createForm} layout="vertical" onFinish={(values) => createMutation.mutate(values)}>
          <Alert
            className="mb-3"
            type="info"
            showIcon
            message="技能名称创建后不可修改"
            description="它同时是 Agent 运行时 DSH_HOME/skills/<name>/ 的目录名，改名等于换一个技能。"
          />
          <Form.Item
            name="name"
            label="技能名称（kebab-case）"
            rules={[
              { required: true, message: '请输入技能名称' },
              {
                pattern: /^[a-z0-9]+(-[a-z0-9]+)*$/,
                message: '只允许小写字母、数字和连字符，例如 bos-bill-review',
              },
              { min: 2, max: 64, message: '长度需在 2 到 64 之间' },
            ]}
          >
            <Input placeholder="bos-bill-review" />
          </Form.Item>
          <Form.Item name="display_name" label="显示名称" rules={[{ required: true, message: '请输入显示名称' }]}>
            <Input placeholder="BOS 单据评审" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={publishSkill === null ? '发布新版本' : `发布新版本：${publishSkill.name}`}
        open={publishSkill !== null}
        width={900}
        onCancel={() => {
          setPublishSkill(null)
          setValidation(null)
        }}
        onOk={() => publishForm.submit()}
        okText="发布"
        okButtonProps={{ disabled: validation === null }}
        confirmLoading={publishMutation.isPending}
        destroyOnHidden
      >
        <Space direction="vertical" size="middle" className="full-width">
          <Alert
            type="info"
            showIcon
            message="ZIP 根目录必须直接包含带 YAML frontmatter 的 SKILL.md"
            description={
              <>
                <p>
                  <Text code>SKILL.md</Text> 必须以 <Text code>---</Text> 开头，frontmatter 里给出
                  与技能名相同的 <Text code>name</Text> 和非空的 <Text code>description</Text>。
                  <Text strong>缺了 frontmatter，dsh 会静默忽略整个技能</Text>
                  —— 文件在磁盘上、Job 也建成了，但模型的目录里就是没有它。所以这里在发布时就拒。
                </p>
                <p className="mb-0">
                  不接受额外的外层目录（例如 <Text code>bos-bill-review/SKILL.md</Text>）：平台物化时
                  已经创建 <Text code>skills/&lt;name&gt;/</Text>，再带一层 dsh 就找不到入口。可选目录：
                  <Text code>references/</Text> <Text code>assets/</Text> <Text code>templates/</Text>{' '}
                  <Text code>scripts/</Text>。发布后 ZIP 不可替换，只能创建下一个版本。
                </p>
              </>
            }
          />

          <Upload.Dragger
            accept=".zip"
            maxCount={1}
            multiple={false}
            fileList={[] as UploadFile[]}
            beforeUpload={(file) => {
              if (publishSkill !== null) {
                setValidation(null)
                uploadMutation.mutate({ skillId: publishSkill.id, file: file as unknown as File })
              }
              // 交给我们自己的上传链路（signed upload URL），不让 antd 发请求。
              return false
            }}
            disabled={uploadMutation.isPending}
          >
            <p>点击或拖拽 Bundle ZIP 到这里</p>
            <p className="ant-upload-hint">
              上传后服务端会解析归档并展示文件树；只有校验通过才能发布。
            </p>
          </Upload.Dragger>

          {uploadMutation.isPending ? <Progress percent={100} status="active" showInfo={false} /> : null}

          {uploadMutation.isError ? (
            <Alert type="error" showIcon message="校验未通过" description={uploadMutation.error.message} />
          ) : null}

          {validation !== null ? (
            <>
              <Descriptions size="small" column={3} bordered>
                <Descriptions.Item label="文件数">{validation.file_count}</Descriptions.Item>
                <Descriptions.Item label="ZIP 大小">
                  {formatBytes(validation.archive_size_bytes)}
                </Descriptions.Item>
                <Descriptions.Item label="展开大小">
                  {formatBytes(validation.expanded_size_bytes)}
                </Descriptions.Item>
                <Descriptions.Item label="archive SHA-256" span={3}>
                  <Text code>{validation.archive_sha256}</Text>
                </Descriptions.Item>
                <Descriptions.Item label="bundle hash" span={3}>
                  <Text code>{validation.bundle_hash}</Text>
                </Descriptions.Item>
              </Descriptions>

              {validation.tree.some((file) => file.role === 'ASSET') ? (
                <Alert
                  type="info"
                  showIcon
                  message="此版本包含图片资源"
                  description={
                    <>
                      模型用 <Text code>read_image</Text> 读图片，而它的准入检查看的是**模型路由
                      声明的输入模态**。只有部署侧打开 <Text code>MODEL_IMAGE_INPUT_ENABLED</Text>
                      （且模型端点确实接受图片）时，这些图片才对模型可见；否则它们仍会被完整
                      冻结与物化，只是模型读不到。详见 worker/OPERATIONS.md 第 17.9 节。
                    </>
                  }
                />
              ) : null}

              {validation.contains_scripts ? (
                <Alert
                  type="warning"
                  showIcon
                  message="此版本包含可执行指令资源（scripts/）"
                  description={
                    <>
                      Skill 加载**不会**自动执行任何脚本。但拥有 <Text code>bash</Text> 的 Agent 可以
                      按绝对路径显式运行它们，受 Sandbox、超时与容器资源限制约束。脚本不得包含任何
                      秘密；当前 Shell 的网络请求不等价于平台 Web 白名单，发布者需要承担这一风险。
                    </>
                  }
                />
              ) : null}

              <BundleFileTree files={validation.tree} />
            </>
          ) : null}

          {validation !== null ? (
            <Descriptions
              size="small"
              column={1}
              bordered
              title="来自 SKILL.md frontmatter（唯一来源，不在这里编辑）"
            >
              <Descriptions.Item label="name">
                <Text code>{validation.frontmatter.name}</Text>
              </Descriptions.Item>
              <Descriptions.Item label="description（进入首轮目录，模型据此决定是否加载）">
                {validation.frontmatter.description}
              </Descriptions.Item>
              <Descriptions.Item label="whenToUse">
                {validation.frontmatter.whenToUse ?? <Text type="secondary">未提供</Text>}
              </Descriptions.Item>
            </Descriptions>
          ) : null}

          <Form
            form={publishForm}
            layout="vertical"
            onFinish={(values) => publishMutation.mutate(values)}
          >
            {validation?.contains_scripts ? (
              <Form.Item
                name="acknowledge_scripts"
                valuePropName="checked"
                rules={[
                  {
                    validator: (_rule, value) =>
                      value === true
                        ? Promise.resolve()
                        : Promise.reject(new Error('含脚本的版本必须显式确认')),
                  },
                ]}
              >
                <Checkbox>我确认此版本包含可执行指令资源，且其中不含任何秘密</Checkbox>
              </Form.Item>
            ) : null}
          </Form>
        </Space>
      </Modal>

      <Modal
        title="版本历史"
        open={historySkillId !== null}
        width={900}
        footer={null}
        onCancel={() => setHistorySkillId(null)}
        destroyOnHidden
      >
        {historyQuery.isLoading ? (
          <Text type="secondary">加载中…</Text>
        ) : (
          <Table<ReviewSkillVersionDetail>
            dataSource={historyQuery.data?.versions ?? []}
            rowKey="id"
            size="small"
            pagination={false}
            columns={[
              { title: '版本', dataIndex: 'version', width: 80, render: (v: number) => `V${v}` },
              { title: 'description', dataIndex: 'description', ellipsis: true },
              {
                title: '文件数',
                dataIndex: 'file_count',
                width: 90,
              },
              {
                title: 'ZIP / 展开',
                key: 'size',
                width: 150,
                render: (_unused: unknown, row: ReviewSkillVersionDetail) =>
                  `${formatBytes(row.archive_size_bytes)} / ${formatBytes(row.expanded_size_bytes)}`,
              },
              {
                title: '脚本',
                dataIndex: 'contains_scripts',
                width: 80,
                render: (value: boolean) => (value ? <Tag color="red">含</Tag> : <Tag>无</Tag>),
              },
              {
                title: 'bundle hash',
                dataIndex: 'bundle_hash',
                width: 160,
                render: (value: string) => (
                  <Tooltip title={value}>
                    <Text code>{value.replace('sha256:', '').slice(0, 12)}…</Text>
                  </Tooltip>
                ),
              },
              {
                title: '发布时间',
                dataIndex: 'published_at',
                width: 180,
                render: (value: string) => new Date(value).toLocaleString(),
              },
              {
                title: '操作',
                key: 'actions',
                width: 100,
                render: (_unused: unknown, row: ReviewSkillVersionDetail) => (
                  <Button
                    size="small"
                    loading={downloadMutation.isPending}
                    onClick={() => downloadMutation.mutate(row.id)}
                  >
                    下载
                  </Button>
                ),
              },
            ]}
          />
        )}
      </Modal>
    </Space>
  )
}
