import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Col,
  Descriptions,
  Empty,
  Input,
  Modal,
  Progress,
  Row,
  Select,
  Space,
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
  adminCreateSkillDownloadUrl,
  adminDeleteReviewSkill,
  adminGetReviewSkill,
  adminListReviewSkills,
  adminPublishSkillVersion,
  adminSetReviewSkillEnabled,
  adminUploadSkillBundle,
} from '../lib/api'
import { SkillCreateWizard } from './SkillCreateWizard'
import { getSkillBundleDownloadUrl } from '../lib/skill-download-url'
import { formatSkillVersion } from '../lib/skill-version'
import type {
  ReviewSkillListItem,
  ReviewSkillStatus,
  ReviewSkillVersionDetail,
  SkillBundleFile,
  SkillFileRole,
  SkillValidationResult,
} from '../types'

const { Text } = Typography

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

const SKILL_MODAL_STYLE = {
  height: 'min(660px, calc(100vh - 80px))',
  maxHeight: 'calc(100vh - 80px)',
} as const

const SKILL_MODAL_STYLES = {
  container: { height: '100%', display: 'flex', flexDirection: 'column' },
  body: {
    flex: '1 1 auto',
    minHeight: 0,
    overflow: 'auto',
    overscrollBehavior: 'contain',
    scrollbarGutter: 'stable',
  },
} as const

export function formatBytes(bytes: number | null | undefined): string {
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
export function BundleFileTree({ files }: { files: SkillBundleFile[] }) {
  return (
    <Table<SkillBundleFile>
      dataSource={files}
      rowKey="path"
      size="small"
      pagination={
        files.length > 10
          ? {
              size: 'small',
              defaultPageSize: 10,
              showSizeChanger: true,
              pageSizeOptions: [10, 20, 50],
              showTotal: (total, range) => `第 ${range[0]}-${range[1]} 条 / 共 ${total} 个文件`,
            }
          : false
      }
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

/**
 * ADMIN 维护多文件 Skill Bundle。
 *
 * 页面的核心约束来自方案 §14：
 *
 *   * `name` 创建后不可改 —— 它是 `<DSH_HOME>/skills/<name>/` 的目录名，改它等于换一个技能；
 *   * 上传只到 staging，**校验成功后才能发布**；
 *   * 文件树、每文件 hash/MIME/角色/大小全部来自服务端解析，前端不自己解 ZIP；
 *   * 发布后不可替换 ZIP，只能创建下一版本。
 *
 * 导航只对 ADMIN 显示，但那不是安全边界：`ensure_admin()` 与 Edge Function 的
 * `requireAdmin` 才是。
 */
export function SkillManagementPage({ isAdmin }: { isAdmin: boolean }) {
  const { message, modal } = AntApp.useApp()
  const queryClient = useQueryClient()
  const [createOpen, setCreateOpen] = useState(false)
  const [statusFilter, setStatusFilter] = useState<ReviewSkillStatus | 'ALL'>('ALL')
  const [keyword, setKeyword] = useState('')
  const [publishSkill, setPublishSkill] = useState<ReviewSkillListItem | null>(null)
  const [validation, setValidation] = useState<SkillValidationResult | null>(null)
  const [uploadedBundleName, setUploadedBundleName] = useState<string | null>(null)
  const [detailSkill, setDetailSkill] = useState<ReviewSkillListItem | null>(null)
  const [historySkillId, setHistorySkillId] = useState<string | null>(null)

  const catalogQuery = useQuery({
    queryKey: ['admin-review-skills'],
    enabled: isAdmin,
    queryFn: adminListReviewSkills,
  })
  const detailQuery = useQuery({
    queryKey: ['admin-review-skill', detailSkill?.id],
    enabled: detailSkill !== null,
    queryFn: () => adminGetReviewSkill(detailSkill!.id),
  })
  const historyQuery = useQuery({
    queryKey: ['admin-review-skill', historySkillId],
    enabled: historySkillId !== null,
    queryFn: () => adminGetReviewSkill(historySkillId!),
  })

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['admin-review-skills'] })
    if (detailSkill !== null) {
      queryClient.invalidateQueries({ queryKey: ['admin-review-skill', detailSkill.id] })
    }
    if (historySkillId !== null) {
      queryClient.invalidateQueries({ queryKey: ['admin-review-skill', historySkillId] })
    }
  }

  const uploadMutation = useMutation({
    mutationFn: (input: { skillId: string; file: File }) =>
      adminUploadSkillBundle(input.skillId, input.file),
    onSuccess: (result, input) => {
      setValidation(result)
      setUploadedBundleName(input.file.name)
      message.success(`校验通过：${result.file_count} 个文件`)
      invalidate()
    },
    onError: (error: Error) => {
      setValidation(null)
      setUploadedBundleName(null)
      // 校验失败的原因已经落库，刷新后仍然可见 —— 这里只是让它立刻出现。
      message.error(error.message)
      invalidate()
    },
  })

  const publishMutation = useMutation({
    mutationFn: () => {
      if (validation === null) throw new Error('请先上传并通过校验')
      // description / whenToUse 不在这里传：它们由服务端从 SKILL.md 的 frontmatter 取。
      return adminPublishSkillVersion({
        uploadId: validation.upload_id,
        acknowledgeScripts: true,
      })
    },
    onSuccess: (result) => {
      message.success(`已发布 ${formatSkillVersion(result.version)}`)
      setPublishSkill(null)
      setValidation(null)
      setUploadedBundleName(null)
      invalidate()
    },
    onError: (error: Error) => message.error(error.message),
  })

  const deleteMutation = useMutation({
    mutationFn: (skillId: string) => adminDeleteReviewSkill(skillId),
    onSuccess: (result) => {
      if (result.orphaned_objects > 0) {
        // 库行已经删了，重试删除没有意义（技能已不存在）。孤儿对象只影响容量水位。
        message.warning(
          `已删除 ${result.skill_name}，但有 ${result.orphaned_objects} 个归档对象未能从存储清理，需要运维介入`,
        )
      } else {
        message.success(`已删除 ${result.skill_name}`)
      }
      invalidate()
    },
    onError: (error: Error) => message.error(error.message),
  })

  const enabledMutation = useMutation({    mutationFn: (input: { skillId: string; enabled: boolean }) =>
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
      // 短期凭据：用浏览器可访问的 Supabase origin 补全后立即使用，不保存、不展示。
      window.open(getSkillBundleDownloadUrl(result.signed_path), '_blank', 'noopener,noreferrer')
    },
    onError: (error: Error) => message.error(error.message),
  })

  const limits = catalogQuery.data?.limits
  const capacity = catalogQuery.data?.capacity
  const skills = useMemo(() => catalogQuery.data?.skills ?? [], [catalogQuery.data])
  const filteredSkills = useMemo(() => {
    const kw = keyword.trim().toLowerCase()
    return skills.filter((skill) => {
      if (statusFilter !== 'ALL' && skill.status !== statusFilter) return false
      if (kw.length === 0) return true
      return (
        skill.name.toLowerCase().includes(kw) ||
        skill.display_name.toLowerCase().includes(kw)
      )
    })
  }, [skills, statusFilter, keyword])

  if (!isAdmin) {
    return <Alert type="warning" showIcon message="仅管理员可以维护技能" />
  }

  const handleSkillRowAction = (key: string, row: ReviewSkillListItem) => {
    if (key === 'download' && row.current_version_id !== null) {
      downloadMutation.mutate(row.current_version_id)
      return
    }
    if (key === 'enable') {
      enabledMutation.mutate({ skillId: row.id, enabled: true })
      return
    }
    if (key === 'disable') {
      modal.confirm({
        title: `停用 ${row.name}？`,
        content: '停用只影响之后新建的 Job；已在运行的 Job 继续使用它冻结的版本。',
        onOk: () => enabledMutation.mutateAsync({ skillId: row.id, enabled: false }),
      })
      return
    }
    if (key === 'delete') {
      modal.confirm({
        title: `删除 ${row.name}？`,
        content:
          row.version_count > 0
            ? `将连同 ${row.version_count} 个已发布版本与其归档一起永久删除，不可恢复。` +
              '技能名会被释放，之后可以重新创建同名技能。'
            : '这是一个还没有任何版本的草稿，删除后技能名会被释放。',
        okText: '删除',
        okButtonProps: { danger: true },
        onOk: () => deleteMutation.mutateAsync(row.id),
      })
    }
  }

  const columns = [
    {
      title: '技能名称',
      dataIndex: 'name',
      width: 220,
      /*
       * 技能名是模型侧的唯一标识（`skill(name)` 就是按它调用），所以必须完整可读。
       * 早先没给宽度，被右边 8 个列挤成两行、code 背景断成两截，反而最难认。
       * 这里给固定宽度 + 不换行 + 溢出时 Tooltip 显示全名。
       */
      render: (name: string, row: ReviewSkillListItem) => (
        <Tooltip title="点击查看技能详情">
          <Button type="link" className="skill-name-link" onClick={() => setDetailSkill(row)}>
            <Text code className="skill-name-code">
              {name}
            </Text>
          </Button>
        </Tooltip>
      ),
    },
    { title: '显示名称', dataIndex: 'display_name', width: 180, ellipsis: true },
    {
      title: '状态',
      dataIndex: 'status',
      width: 96,
      render: (status: ReviewSkillStatus) => (
        <Tag color={STATUS_LABELS[status].color}>{STATUS_LABELS[status].text}</Tag>
      ),
    },
    {
      title: '当前版本',
      dataIndex: 'current_version',
      width: 96,
      align: 'center' as const,
      render: (version: number | null) => (version === null ? '—' : formatSkillVersion(version)),
    },
    {
      title: '文件数',
      dataIndex: 'file_count',
      width: 88,
      align: 'center' as const,
      render: (v: number | null) => v ?? '—',
    },
    {
      title: '文件大小',
      key: 'size',
      width: 120,
      render: (_unused: unknown, row: ReviewSkillListItem) => (
        <Tooltip
          title={
            <Space direction="vertical" size={0}>
              <span>压缩包大小：{formatBytes(row.archive_size_bytes)}</span>
              <span>解压后大小：{formatBytes(row.expanded_size_bytes)}</span>
            </Space>
          }
        >
          <Text>{formatBytes(row.archive_size_bytes)}</Text>
        </Tooltip>
      ),
    },
    {
      title: '更新人 / 时间',
      key: 'audit',
      width: 180,
      render: (_unused: unknown, row: ReviewSkillListItem) => (
        <Space direction="vertical" size={0}>
          <Text>{row.published_by_name ?? '—'}</Text>
          <Text type="secondary" className="skill-size-secondary">
            {row.published_at === null ? '—' : new Date(row.published_at).toLocaleString()}
          </Text>
        </Space>
      ),
    },
    {
      title: '操作',
      key: 'actions',
      width: 360,
      // 固定在右侧：这张表有 10 列、横向要滚，操作跟着滚出屏幕就得来回拖。
      fixed: 'right' as const,
      render: (_unused: unknown, row: ReviewSkillListItem) => (
        <Space size={4}>
          <Button
            size="small"
            type="link"
            className="table-action-link"
            onClick={() => {
              setPublishSkill(row)
              setValidation(null)
              setUploadedBundleName(null)
            }}
          >
            上传新版本
          </Button>
          <Button
            size="small"
            type="link"
            className="table-action-link"
            onClick={() => setHistorySkillId(row.id)}
          >
            版本历史
          </Button>
          {row.current_version_id !== null ? (
            <Button
              size="small"
              type="link"
              className="table-action-link"
              onClick={() => handleSkillRowAction('download', row)}
            >
              下载当前版本
            </Button>
          ) : null}
          {row.current_version_id !== null ? (
            <Button
              size="small"
              type="link"
              className="table-action-link"
              onClick={() => handleSkillRowAction(row.status === 'PUBLISHED' ? 'disable' : 'enable', row)}
            >
              {row.status === 'PUBLISHED' ? '停用' : '启用'}
            </Button>
          ) : null}
          <Tooltip
            title={
              row.referenced_by_job
                ? '这个技能已被至少一个 Analysis Job 冻结，不能删除。' +
                  'Job 的技能快照是「那次评审到底给了模型哪些技能」的唯一证据，' +
                  '删掉源技能等于让历史评审结果失去依据。改用「停用」：它只影响之后新建的 Job。'
                : undefined
            }
          >
            <span>
              <Button
                danger
                disabled={row.referenced_by_job}
                size="small"
                type="link"
                className="table-action-link"
                onClick={() => handleSkillRowAction('delete', row)}
              >
                删除
              </Button>
            </span>
          </Tooltip>
        </Space>
      ),
    },
  ]

  return (
    <Space direction="vertical" size="large" className="full-width">
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
          </Row>
        </Card>
      ) : null}

      {/*
        标题与主按钮交给 Card 的 title / extra，而不是自己在 body 里摆一行 flex：
        Card 头部有自己的分隔线与内边距，手写的那一行会和下面的筛选栏挤在一起，
        视觉上分不出「这是卡片标题」还是「这是筛选条件的一部分」。
      */}
      <Card
        title="技能"
        extra={
          <Button type="primary" onClick={() => setCreateOpen(true)}>
            新增技能
          </Button>
        }
      >
        <Space direction="vertical" size="middle" className="full-width">
          <div className="skill-filter-bar">
            <Space size="middle" wrap>
              <Space size="small">
                <Text type="secondary">技能状态</Text>
                <Select
                  value={statusFilter}
                  onChange={setStatusFilter}
                  style={{ width: 140 }}
                  options={[
                    { value: 'ALL', label: '全部' },
                    ...Object.entries(STATUS_LABELS).map(([value, meta]) => ({
                      value,
                      label: meta.text,
                    })),
                  ]}
                />
              </Space>
              <Input.Search
                allowClear
                placeholder="搜索技能名称或显示名称"
                value={keyword}
                onChange={(event) => setKeyword(event.target.value)}
                style={{ width: 260 }}
              />
            </Space>
            {/* 条数只在分页处显示一次：筛选栏右侧原来还有一个「共 N 条」，同一个数字
                在同一屏出现两遍，看的人会先怀疑两者是不是不同口径。 */}
          </div>

          <Table<ReviewSkillListItem>
            dataSource={filteredSkills}
            rowKey="id"
            size="middle"
            loading={catalogQuery.isLoading}
            columns={columns}
            // 固定列宽之和为 1340；隐藏不常用的脚本与描述列后，保留少量余量避免窄屏挤压。
            scroll={{ x: 1360 }}
            pagination={{
              pageSize: 10,
              showSizeChanger: true,
              showTotal: (total) => `共 ${total} 条`,
            }}
            locale={{ emptyText: <Empty description="还没有技能。新增一个并上传 Bundle ZIP。" /> }}
          />
        </Space>
      </Card>

      <SkillCreateWizard
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        onDone={() => {
          setCreateOpen(false)
          invalidate()
        }}
        onDraftChanged={invalidate}
      />

      <Modal
        title={detailSkill === null ? '技能详情' : `技能详情：${detailSkill.name}`}
        open={detailSkill !== null}
        width={960}
        className="skill-detail-modal"
        style={SKILL_MODAL_STYLE}
        styles={SKILL_MODAL_STYLES}
        footer={null}
        onCancel={() => setDetailSkill(null)}
        destroyOnHidden
      >
        {detailQuery.isLoading ? (
          <Text type="secondary">加载中…</Text>
        ) : detailSkill === null ? null : (
          <Space direction="vertical" size="middle" className="full-width">
            <Descriptions size="small" column={3} bordered>
              <Descriptions.Item label="技能编码">
                <Text code>{detailSkill.name}</Text>
              </Descriptions.Item>
              <Descriptions.Item label="显示名称">{detailSkill.display_name}</Descriptions.Item>
              <Descriptions.Item label="状态">
                <Tag color={STATUS_LABELS[detailSkill.status].color}>
                  {STATUS_LABELS[detailSkill.status].text}
                </Tag>
              </Descriptions.Item>
              <Descriptions.Item label="当前版本">
                {detailSkill.current_version === null ? '—' : formatSkillVersion(detailSkill.current_version)}
              </Descriptions.Item>
              <Descriptions.Item label="文件数">{detailSkill.file_count ?? '—'}</Descriptions.Item>
              <Descriptions.Item label="文件大小">
                {formatBytes(detailSkill.archive_size_bytes)}
              </Descriptions.Item>
            </Descriptions>

            {detailSkill.latest_upload !== null ? (
              <>
                <Text strong>待发布的技能包</Text>
                <Descriptions size="small" column={3} bordered>
                  <Descriptions.Item label="状态">{detailSkill.latest_upload.status}</Descriptions.Item>
                  <Descriptions.Item label="文件数">
                    {detailSkill.latest_upload.file_count ?? '—'}
                  </Descriptions.Item>
                  <Descriptions.Item label="文件大小">
                    {formatBytes(detailSkill.latest_upload.archive_size_bytes)}
                  </Descriptions.Item>
                </Descriptions>
                {detailSkill.latest_upload.error_code !== null ? (
                  <Alert
                    type="error"
                    showIcon
                    message="校验未通过"
                    description={detailSkill.latest_upload.error_message}
                  />
                ) : null}
                {detailSkill.latest_upload.bundle_manifest !== null ? (
                  <BundleFileTree files={detailSkill.latest_upload.bundle_manifest.files} />
                ) : null}
              </>
            ) : detailQuery.data?.versions[0] !== undefined ? (
              <>
                <Text strong>当前版本文件</Text>
                <Descriptions size="small" column={3} bordered>
                  <Descriptions.Item label="版本">
                    {formatSkillVersion(detailQuery.data.versions[0].version)}
                  </Descriptions.Item>
                  <Descriptions.Item label="文件数">
                    {detailQuery.data.versions[0].file_count}
                  </Descriptions.Item>
                  <Descriptions.Item label="文件大小">
                    {formatBytes(detailQuery.data.versions[0].archive_size_bytes)}
                  </Descriptions.Item>
                </Descriptions>
                <BundleFileTree files={detailQuery.data.versions[0].bundle_manifest.files} />
              </>
            ) : (
              <Empty description="暂未上传技能包" />
            )}
          </Space>
        )}
      </Modal>

      <Modal
        title={publishSkill === null ? '发布新版本' : `发布新版本：${publishSkill.name}`}
        open={publishSkill !== null}
        width={960}
        className="skill-publish-modal"
        style={SKILL_MODAL_STYLE}
        styles={SKILL_MODAL_STYLES}
        onCancel={() => {
          setPublishSkill(null)
          setValidation(null)
          setUploadedBundleName(null)
        }}
        onOk={() => publishMutation.mutate()}
        okText="发布"
        okButtonProps={{ disabled: validation === null }}
        confirmLoading={publishMutation.isPending}
        destroyOnHidden
      >
        <Space direction="vertical" size="middle" className="full-width">
          <Upload.Dragger
            className={`skill-upload-dragger${validation !== null ? ' skill-upload-dragger--imported' : ''}`}
            accept=".zip"
            maxCount={1}
            multiple={false}
            fileList={[] as UploadFile[]}
            beforeUpload={(file) => {
              if (publishSkill !== null) {
                setValidation(null)
                setUploadedBundleName(null)
                uploadMutation.mutate({ skillId: publishSkill.id, file: file as unknown as File })
              }
              // 交给我们自己的上传链路（signed upload URL），不让 antd 发请求。
              return false
            }}
            disabled={uploadMutation.isPending}
          >
            {validation === null ? (
              <>
                <p className="skill-upload-dragger__title">点击或拖拽上传 ZIP 技能包</p>
                <p className="ant-upload-hint skill-upload-dragger__hint">系统自动校验，校验通过后即可发布。</p>
              </>
            ) : (
              <>
                <span className="skill-upload-dragger__status-icon" aria-hidden="true">
                  ✓
                </span>
                <p className="skill-upload-dragger__title">技能包已上传</p>
                <p className="skill-upload-dragger__file-name" title={uploadedBundleName ?? undefined}>
                  {uploadedBundleName ?? 'ZIP 技能包'}
                </p>
                <p className="skill-upload-dragger__hint">
                  {validation.file_count} 个文件 · 点击或拖拽 ZIP 以替换
                </p>
              </>
            )}
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

        </Space>
      </Modal>

      <Modal
        title="版本历史"
        open={historySkillId !== null}
        width={960}
        className="skill-history-modal"
        style={SKILL_MODAL_STYLE}
        styles={SKILL_MODAL_STYLES}
        footer={null}
        onCancel={() => setHistorySkillId(null)}
        destroyOnHidden
      >
        {historyQuery.isLoading ? (
          <Text type="secondary">加载中…</Text>
        ) : (
          <Table<ReviewSkillVersionDetail>
            className="skill-history-table"
            dataSource={historyQuery.data?.versions ?? []}
            rowKey="id"
            size="small"
            pagination={{
              size: 'small',
              defaultPageSize: 10,
              showSizeChanger: true,
              pageSizeOptions: [10, 20, 50],
              showTotal: (total, range) => `第 ${range[0]}-${range[1]} 条 / 共 ${total} 个版本`,
            }}
            tableLayout="fixed"
            columns={[
              { title: '版本', dataIndex: 'version', width: 80, render: (v: number) => formatSkillVersion(v) },
              { title: '描述', dataIndex: 'description', width: 160, ellipsis: true },
              {
                title: '文件数',
                dataIndex: 'file_count',
                width: 72,
              },
              {
                title: '文件大小',
                key: 'size',
                width: 96,
                render: (_unused: unknown, row: ReviewSkillVersionDetail) => (
                  <Tooltip
                    title={
                      <Space direction="vertical" size={0}>
                        <span>压缩包大小：{formatBytes(row.archive_size_bytes)}</span>
                        <span>解压后大小：{formatBytes(row.expanded_size_bytes)}</span>
                      </Space>
                    }
                  >
                    <Text>{formatBytes(row.archive_size_bytes)}</Text>
                  </Tooltip>
                ),
              },
              {
                title: '脚本',
                dataIndex: 'contains_scripts',
                width: 64,
                render: (value: boolean) => (value ? <Tag color="red">含</Tag> : <Tag>无</Tag>),
              },
              {
                title: 'bundle hash',
                dataIndex: 'bundle_hash',
                width: 120,
                render: (value: string) => (
                  <Tooltip title={value}>
                    <Text code>{value.replace('sha256:', '').slice(0, 12)}…</Text>
                  </Tooltip>
                ),
              },
              {
                title: '发布时间',
                dataIndex: 'published_at',
                width: 148,
                ellipsis: true,
                render: (value: string) => new Date(value).toLocaleString(),
              },
              {
                title: '操作',
                key: 'actions',
                width: 72,
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
