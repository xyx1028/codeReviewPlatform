/**
 * 用户故事看板（V1.20）。
 *
 * 一个页面回答两个问题：
 *   「工具开发组这个发布窗口有哪些需求、正文和附件长什么样」—— 看板本身；
 *   「把其中这几条拉进某个批次，顺手开跑 AI 分析」—— 导入弹窗。
 *
 * 导入前的门禁全部在数据库里（批次可写、需求已做过完整同步、附件已落盘），页面只把
 * 稳定错误码翻译成人话。这样"页面看起来允许但后端拒绝"不会变成两套规则。
 */
import { useMemo, useState } from 'react'
import {
  Alert,
  App as AntApp,
  Button,
  Checkbox,
  Modal,
  Select,
  Space,
  Typography,
} from 'antd'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { LinkyStoryPicker } from '../components/linky/LinkyStoryPicker'
import {
  describeLinkyError,
  enqueueAnalysisJob,
  importLinkyStoriesFromCatalog,
  listBatches,
} from '../lib/api'
import type { UserRole } from '../types'

const { Text, Title } = Typography

export function StoryBoardPage({ role, userId }: { role: UserRole | undefined; userId: string | null }) {
  const { message } = AntApp.useApp()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [selected, setSelected] = useState<string[]>([])
  const [importOpen, setImportOpen] = useState(false)
  const [batchId, setBatchId] = useState<string | null>(null)
  const [allowMissingAttachments, setAllowMissingAttachments] = useState(false)
  const [startAnalysis, setStartAnalysis] = useState(false)

  const canSync = role === 'ADMIN' || role === 'REVIEWER'
  const batchesQuery = useQuery({ queryKey: ['batches'], queryFn: listBatches, enabled: canSync })

  /** 可导入的批次：未完成、且当前用户能管理（ADMIN 全部，REVIEWER 只看自己建的）。 */
  const targetBatches = useMemo(
    () =>
      (batchesQuery.data ?? []).filter(
        (batch) =>
          batch.status !== 'COMPLETED'
          && (role === 'ADMIN' || (batch.created_by !== null && batch.created_by === userId)),
      ),
    [batchesQuery.data, role, userId],
  )

  const importMutation = useMutation({
    mutationFn: async () => {
      if (batchId === null) throw new Error('请先选择目标批次')
      const result = await importLinkyStoriesFromCatalog({
        batchId,
        issueIds: selected,
        allowMissingAttachments,
      })
      if (startAnalysis) {
        await enqueueAnalysisJob(batchId, { analysisContextVersion: 2, commitWindowDays: 21 })
      }
      return result
    },
    onSuccess: (result) => {
      message.success(
        `已导入 ${result.inserted} 条新需求、更新 ${result.updated} 条，附件 ${result.attachments} 个`
          + (startAnalysis ? '，并已提交分析任务' : ''),
      )
      setImportOpen(false)
      setSelected([])
      queryClient.invalidateQueries({ queryKey: ['batches'] })
      queryClient.invalidateQueries({ queryKey: ['stories', batchId] })
      navigate(`/batches/${batchId}/ai-result`)
    },
    onError: (error) => message.error(describeLinkyError(error)),
  })

  return (
    <Space direction="vertical" size="large" className="page-stack">
      <div>
        <Title level={3}>用户故事看板</Title>
        <Text type="secondary">
          数据来自 Linky 取数接口的平台镜像：按项目组与发布窗口筛选，勾选后可直接导入批次并开始 AI 分析。
          不需要上传 Excel，也没有字段映射。
        </Text>
      </div>
      {!canSync ? (
        <Alert
          type="info"
          showIcon
          title="只读视图"
          description="VIEWER 可以浏览已同步的需求与附件；刷新与导入需要管理员或评审人权限。"
        />
      ) : null}

      <LinkyStoryPicker
        canSync={canSync}
        selectable={canSync}
        selectedIssueIds={selected}
        onSelectionChange={setSelected}
        actions={
          canSync ? (
            <Space>
              <Text type="secondary">已选 {selected.length} 条</Text>
              <Button
                type="primary"
                disabled={selected.length === 0}
                onClick={() => setImportOpen(true)}
              >
                导入到批次
              </Button>
            </Space>
          ) : null
        }
      />

      <Modal
        open={importOpen}
        title={`导入 ${selected.length} 条需求到批次`}
        okText="确认导入"
        confirmLoading={importMutation.isPending}
        onOk={() => importMutation.mutate()}
        onCancel={() => setImportOpen(false)}
      >
        <Space direction="vertical" size="middle" className="full-width">
          <div>
            <Text strong>目标批次</Text>
            <Select
              className="full-width select-with-margin"
              placeholder="选择一个未完成的批次"
              loading={batchesQuery.isLoading}
              value={batchId ?? undefined}
              options={targetBatches.map((batch) => ({
                value: batch.id,
                label: `${batch.week_code} ${batch.name}（${batch.status}）`,
              }))}
              onChange={(value) => setBatchId(value)}
            />
            <Text type="secondary">
              批次需要先有模型与目标分支才能开始分析；新建批次请到「代码评审」页。
            </Text>
          </div>
          <Checkbox
            checked={allowMissingAttachments}
            onChange={(event) => setAllowMissingAttachments(event.target.checked)}
          >
            允许缺少附件（附件未取到的需求也导入，提示词里会如实说明缺了几个）
          </Checkbox>
          <Checkbox checked={startAnalysis} onChange={(event) => setStartAnalysis(event.target.checked)}>
            导入后立即开始 AI 分析（按需求提交归属，提交窗口 21 天）
          </Checkbox>
        </Space>
      </Modal>
    </Space>
  )
}
