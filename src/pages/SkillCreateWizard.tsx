import {
  App as AntApp,
  Col,
  Descriptions,
  Form,
  Input,
  Modal,
  Progress,
  Row,
  Space,
  Steps,
  Typography,
  Upload,
} from 'antd'
import type { UploadFile } from 'antd/es/upload/interface'
import { useState } from 'react'
import {
  adminCreateReviewSkill,
  adminDeleteReviewSkill,
  adminPublishSkillVersion,
  adminUploadSkillBundle,
} from '../lib/api'
import { readSkillBundlePreview, type SkillBundlePreview } from '../lib/skill-bundle-preview'
import { formatSkillVersion } from '../lib/skill-version'
import type { SkillValidationResult } from '../types'
import { BundleFileTree, formatBytes } from './SkillManagementPage'

const { Text } = Typography

interface FormValues {
  name: string
  display_name: string
}

const MANUAL_FALLBACK = '请手动填写技能编码；服务端仍会独立校验'

/**
 * 把预填失败的原因翻成一句能照着改的话。返回 null 表示读取正常，不提示。
 *
 * 分四句而不是一句"没读到 SKILL.md"：这几种情况的下一步动作完全不同（换包 / 重新压缩 /
 * 手敲名字），合成一句话时远程排查只能靠猜 —— 线上真的因此耽误过一次。
 */
function previewIssueHint(preview: SkillBundlePreview): string | null {
  switch (preview.issue) {
    case 'archive-unreadable':
      return '这个文件不是有效的 ZIP，或已损坏 / 被加密，读不出归档目录。请重新打包后再上传。'
    case 'entry-nested':
      return `SKILL.md 在子目录 ${preview.nestedEntryPath} 里。平台要求它在 ZIP 根目录：请进入技能目录内部打包（zip -r ../<name>.zip .），不要压缩外层文件夹。`
    case 'entry-missing':
      return `ZIP 根目录没有 SKILL.md。${MANUAL_FALLBACK}`
    case 'entry-unreadable':
      return `读到了 SKILL.md 但解不开（压缩方式不支持或不是 UTF-8 文本）。${MANUAL_FALLBACK}`
    default:
      return null
  }
}

/**
 * 「新增技能」向导：上传 ZIP → 服务端检测 → 发布。
 *
 * ## 为什么把上传并进创建里
 *
 * 原来是两步独立操作（先建一个空技能，再回列表点「上传新版本」）。它有一个真实的失败
 * 模式：技能名由管理员手敲，而服务端要求 `SKILL.md` 的 frontmatter `name` **必须等于**
 * 平台技能名。两者不一致时，技能行已经建好了，上传却过不了校验 —— 留下一个永远发不出来
 * 的空壳，而且名字还占着唯一约束。
 *
 * 现在名称从 ZIP 里读出来预填，这个不一致从入口消失。
 *
 * ## 浏览器解析的地位
 *
 * `readSkillBundlePreview` 只用于**预填输入框**，不是校验。权威判定在第二步的服务端
 * 检测里（Edge Function 独立解析归档并重算三层 hash）。所以浏览器读不出来不阻止提交，
 * 读出来也不代表能通过。
 *
 * ## 中途失败怎么办
 *
 * 「下一步」实际做三件事：创建技能 → 上传到 staging → 服务端校验。后两步失败时草稿已经
 * 建出来了，此时**自动删掉它**（`adminDeleteReviewSkill`），让重试不会撞名字唯一约束。
 * 这也是删除能力存在的一个直接理由。
 *
 * 第二步取消则**保留草稿**：那份上传是刚花时间传上去的，悄悄删掉比留着更让人意外。
 * 草稿在列表里可见，可以稍后发布，也可以手动删除。
 */
export function SkillCreateWizard({
  open,
  onCancel,
  onDone,
  onDraftChanged,
}: {
  open: boolean
  onCancel: () => void
  /** 发布成功。 */
  onDone: () => void
  /** 草稿被创建或删除 —— 列表需要刷新，即使还没发布。 */
  onDraftChanged: () => void
}) {
  const { message } = AntApp.useApp()
  const [form] = Form.useForm<FormValues>()
  const [step, setStep] = useState(0)
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<SkillBundlePreview | null>(null)
  const [skillId, setSkillId] = useState<string | null>(null)
  const [validation, setValidation] = useState<SkillValidationResult | null>(null)
  const [busy, setBusy] = useState(false)

  const reset = () => {
    form.resetFields()
    setStep(0)
    setFile(null)
    setPreview(null)
    setSkillId(null)
    setValidation(null)
    setBusy(false)
  }

  const closeAndReset = () => {
    reset()
    onCancel()
  }

  const handleFile = async (picked: File) => {
    setFile(picked)
    setValidation(null)
    const parsed = await readSkillBundlePreview(picked)
    setPreview(parsed)
    // 只填空着的字段，不覆盖管理员已经改过的显示名称。
    form.setFieldsValue({
      name: parsed.name ?? form.getFieldValue('name') ?? '',
      display_name: form.getFieldValue('display_name') || parsed.name || '',
    })
    const hint = previewIssueHint(parsed)
    if (hint !== null) message.warning(hint)
  }

  /** 第一步的「下一步」：建技能 → 传 staging → 服务端校验。失败则回滚草稿。 */
  const goToValidation = async () => {
    let values: FormValues
    try {
      values = await form.validateFields()
    } catch {
      return
    }
    if (file === null) {
      message.error('请先上传技能包 ZIP')
      return
    }

    setBusy(true)
    let createdId = skillId
    try {
      if (createdId === null) {
        const created = await adminCreateReviewSkill({
          name: values.name.trim(),
          displayName: values.display_name.trim(),
        })
        createdId = created.skill_id
        setSkillId(createdId)
        onDraftChanged()
      }
      const result = await adminUploadSkillBundle(createdId, file)
      setValidation(result)
      setStep(1)
      onDraftChanged()
    } catch (error) {
      const reason = error instanceof Error ? error.message : '未知错误'
      const userMessage =
        reason.includes('review_skill_name_key') || reason.includes('duplicate key')
          ? `技能编码「${values.name.trim()}」已存在，请在技能列表中上传新版本。`
          : reason
      // 回滚草稿：留着它只会让重试撞名字唯一约束。
      if (createdId !== null) {
        try {
          await adminDeleteReviewSkill(createdId)
          setSkillId(null)
          onDraftChanged()
        } catch {
          message.warning('技能草稿未能自动清理，请在列表里手动删除后重试')
        }
      }
      message.error(userMessage)
    } finally {
      setBusy(false)
    }
  }

  const publish = async () => {
    if (validation === null) return
    setBusy(true)
    try {
      const result = await adminPublishSkillVersion({
        uploadId: validation.upload_id,
        acknowledgeScripts: true,
      })
      message.success(`已发布 ${formatSkillVersion(result.version)}`)
      reset()
      onDone()
    } catch (error) {
      message.error(error instanceof Error ? error.message : '发布失败')
    } finally {
      setBusy(false)
    }
  }

  const skillCodeReadOnly = preview?.name !== null && preview?.name !== undefined

  return (
    <Modal
      title={
        <div className="skill-create-modal__title">
          <span>新增技能</span>
          <Text type="secondary">导入、校验并发布 Skill Bundle</Text>
        </div>
      }
      open={open}
      width={960}
      centered
      className="skill-create-modal"
      onCancel={() => {
        if (step === 1 && skillId !== null) {
          message.info('已保留为草稿，可稍后在列表里发布或删除')
        }
        closeAndReset()
      }}
      okText={step === 0 ? '下一步' : '确定'}
      onOk={() => void (step === 0 ? goToValidation() : publish())}
      okButtonProps={{
        disabled: step === 1 && validation === null,
        className: 'skill-create-modal__primary-action',
      }}
      cancelText={step === 0 ? '取消' : '稍后再发布'}
      confirmLoading={busy}
      destroyOnHidden
    >
      <Steps
        className="skill-create-modal__steps"
        current={step}
        size="small"
        items={[{ title: '基本信息' }, { title: '内容检测' }]}
      />

      {step === 0 ? (
        <Row gutter={[24, 24]} className="skill-create-modal__content">
          <Col xs={24} md={9} className="skill-create-modal__upload-column">
            <Form.Item label="上传技能包" required className="mb-0">
              <Upload.Dragger
                className={`skill-upload-dragger${file !== null ? ' skill-upload-dragger--imported' : ''}`}
                accept=".zip"
                maxCount={1}
                multiple={false}
                fileList={[] as UploadFile[]}
                beforeUpload={(picked) => {
                  void handleFile(picked as unknown as File)
                  // 走平台自己的 signed upload 链路，不让 antd 发请求。
                  return false
                }}
                disabled={busy}
              >
                {file === null ? (
                  <>
                    <p className="ant-upload-drag-icon" aria-hidden="true">
                      ⬆
                    </p>
                    <p className="skill-upload-dragger__title">点击或拖拽上传</p>
                    <p className="ant-upload-hint skill-upload-dragger__hint">
                      支持 .zip 格式，根目录需直接包含 <Text code>SKILL.md</Text>
                    </p>
                  </>
                ) : (
                  <>
                    <span className="skill-upload-dragger__status-icon" aria-hidden="true">
                      ✓
                    </span>
                    <p className="skill-upload-dragger__title">技能包已导入</p>
                    <p className="skill-upload-dragger__file-name" title={file.name}>
                      {file.name}
                    </p>
                    <p className="skill-upload-dragger__hint">
                      {formatBytes(file.size)} · 点击或拖拽 ZIP 以替换
                    </p>
                  </>
                )}
              </Upload.Dragger>
            </Form.Item>
          </Col>

          <Col xs={24} md={15} className="skill-create-modal__details-column">
            <Form form={form} layout="vertical" requiredMark className="skill-create-modal__form">
              <Form.Item
                name="name"
                label="技能编码（kebab-case）"
                tooltip="由 SKILL.md 的 frontmatter 自动解析。它同时是 Agent 运行时 DSH_HOME/skills/<name>/ 的目录名，创建后不可修改。"
                rules={[
                  { required: true, message: '请上传含 SKILL.md 的 ZIP，或手动填写' },
                  {
                    pattern: /^[a-z0-9]+(-[a-z0-9]+)*$/,
                    message: '只允许小写字母、数字和连字符，例如 bos-bill-review',
                  },
                  { min: 2, max: 64, message: '长度需在 2 到 64 之间' },
                ]}
              >
                <Input
                  className={skillCodeReadOnly ? 'skill-create-modal__code-input--readonly' : undefined}
                  placeholder="从 SKILL.md 中自动解析"
                  readOnly={skillCodeReadOnly}
                  aria-readonly={skillCodeReadOnly}
                  tabIndex={skillCodeReadOnly ? -1 : 0}
                />
              </Form.Item>

              <Form.Item
                name="display_name"
                label="显示名称"
                rules={[{ required: true, message: '请输入显示名称' }]}
              >
                <Input placeholder="例：BOS 单据评审" />
              </Form.Item>

              <Form.Item
                label="技能描述"
                tooltip="只来自 SKILL.md frontmatter 的 description，不在这里编辑：库里那份是它的投影，两处分开填会与 dsh 渲染给模型的文本分叉。"
              >
                <Input.TextArea
                  rows={4}
                  readOnly
                  value={preview?.description ?? ''}
                  placeholder="从 SKILL.md 中自动解析"
                />
              </Form.Item>

            </Form>
          </Col>
        </Row>
      ) : null}

      {step === 1 ? (
        <Space direction="vertical" size="middle" className="full-width">
          {busy ? <Progress percent={100} status="active" showInfo={false} /> : null}

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

              <Descriptions
                size="small"
                column={1}
                bordered
                title="来自 SKILL.md frontmatter（唯一来源）"
              >
                <Descriptions.Item label="name">
                  <Text code>{validation.frontmatter.name}</Text>
                </Descriptions.Item>
                <Descriptions.Item label="description">
                  {validation.frontmatter.description}
                </Descriptions.Item>
                {validation.frontmatter.whenToUse !== null &&
                validation.frontmatter.whenToUse !== undefined ? (
                  <Descriptions.Item label="whenToUse">
                    {validation.frontmatter.whenToUse}
                  </Descriptions.Item>
                ) : null}
              </Descriptions>

              <BundleFileTree files={validation.tree} />
            </>
          ) : null}
        </Space>
      ) : null}
    </Modal>
  )
}
