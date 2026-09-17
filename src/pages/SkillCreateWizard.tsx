import {
  Alert,
  App as AntApp,
  Checkbox,
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
import type { SkillValidationResult } from '../types'
import { BundleFileTree, formatBytes } from './SkillManagementPage'

const { Text } = Typography

interface FormValues {
  name: string
  display_name: string
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
  const [acknowledgeScripts, setAcknowledgeScripts] = useState(false)
  const [busy, setBusy] = useState(false)

  const reset = () => {
    form.resetFields()
    setStep(0)
    setFile(null)
    setPreview(null)
    setSkillId(null)
    setValidation(null)
    setAcknowledgeScripts(false)
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
    if (!parsed.hasEntry) {
      message.warning('没能在 ZIP 根目录读到 SKILL.md，请手动填写技能名称；服务端仍会独立校验')
    }
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
      // 回滚草稿：留着它只会让重试撞上名字唯一约束。
      if (createdId !== null) {
        try {
          await adminDeleteReviewSkill(createdId)
          setSkillId(null)
          onDraftChanged()
        } catch {
          message.warning('技能草稿未能自动清理，请在列表里手动删除后重试')
        }
      }
      message.error(reason)
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
        acknowledgeScripts,
      })
      message.success(`已发布 V${result.version}`)
      reset()
      onDone()
    } catch (error) {
      message.error(error instanceof Error ? error.message : '发布失败')
    } finally {
      setBusy(false)
    }
  }

  const scriptsBlocked = validation?.contains_scripts === true && !acknowledgeScripts

  return (
    <Modal
      title="新增技能"
      open={open}
      width={960}
      onCancel={() => {
        if (step === 1 && skillId !== null) {
          message.info('已保留为草稿，可稍后在列表里发布或删除')
        }
        closeAndReset()
      }}
      okText={step === 0 ? '下一步' : '确定'}
      onOk={() => void (step === 0 ? goToValidation() : publish())}
      okButtonProps={{ disabled: step === 1 && (validation === null || scriptsBlocked) }}
      cancelText={step === 0 ? '取消' : '稍后再发布'}
      confirmLoading={busy}
      destroyOnHidden
    >
      <Steps
        className="mb-4"
        current={step}
        size="small"
        items={[{ title: '基本信息' }, { title: '内容检测' }]}
      />

      {step === 0 ? (
        <Row gutter={24}>
          <Col xs={24} md={9}>
            <Form.Item label="上传技能包" required className="mb-0">
              <Upload.Dragger
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
                <p className="ant-upload-drag-icon" aria-hidden="true">
                  ⬆
                </p>
                <p>点击或拖拽上传</p>
                <p className="ant-upload-hint">
                  支持 .zip 格式，根目录需直接包含 <Text code>SKILL.md</Text>
                </p>
              </Upload.Dragger>
            </Form.Item>
            {file !== null ? (
              <Alert
                className="mt-2"
                type="success"
                showIcon
                message={file.name}
                description={formatBytes(file.size)}
              />
            ) : null}
          </Col>

          <Col xs={24} md={15}>
            <Form form={form} layout="vertical" requiredMark>
              <Form.Item
                name="name"
                label="技能名称（kebab-case）"
                tooltip="从 SKILL.md 的 frontmatter 自动解析。它同时是 Agent 运行时 DSH_HOME/skills/<name>/ 的目录名，创建后不可修改。"
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
                  placeholder="从 SKILL.md 中自动解析"
                  readOnly={preview?.name !== null && preview?.name !== undefined}
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

              {preview !== null && preview.containsScripts ? (
                <Alert
                  type="warning"
                  showIcon
                  message="这个包里有 scripts/ 目录"
                  description="下一步需要额外确认。Skill 加载不会自动执行脚本，但拥有 bash 的 Agent 可以显式运行。"
                />
              ) : null}
            </Form>
          </Col>
        </Row>
      ) : null}

      {step === 1 ? (
        <Space direction="vertical" size="middle" className="full-width">
          {busy ? <Progress percent={100} status="active" showInfo={false} /> : null}

          {validation !== null ? (
            <>
              <Alert
                type="success"
                showIcon
                message="服务端校验通过"
                description="以下结果由服务端独立解析归档得出，与浏览器的预读无关。"
              />
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

              {validation.contains_scripts ? (
                <Alert
                  type="warning"
                  showIcon
                  message="此版本包含可执行指令资源（scripts/）"
                  description={
                    <Space direction="vertical" size="small">
                      <span>
                        Skill 加载<Text strong>不会</Text>自动执行任何脚本。但拥有{' '}
                        <Text code>bash</Text> 的 Agent 可以按绝对路径显式运行它们。脚本不得包含
                        任何秘密；当前 Shell 的网络请求不等价于平台 Web 白名单。
                      </span>
                      <Checkbox
                        checked={acknowledgeScripts}
                        onChange={(event) => setAcknowledgeScripts(event.target.checked)}
                      >
                        我已确认脚本内容，并承担上述风险
                      </Checkbox>
                    </Space>
                  }
                />
              ) : null}

              <BundleFileTree files={validation.tree} />
            </>
          ) : null}
        </Space>
      ) : null}
    </Modal>
  )
}
