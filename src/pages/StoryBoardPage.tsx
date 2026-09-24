/**
 * 用户故事看板（V1.20 修订）。
 *
 * 只做一件事：**实时**看 Linky 上的需求 —— 按项目组与发布窗口筛，看正文，下载附件。
 * 这里没有「导入到批次」：一个批次要分析哪些需求，是在批次自己的「原始需求导入」页
 * 定义的（选项目组 + 发布窗口 + 勾选，确认那一刻才冻结）。把两件事混在一个页面上，
 * 会让"我只是来看看"和"我要定一批需求去跑分析"用同一个按钮，那是两种完全不同的意图。
 */
import { Alert, Space, Typography } from 'antd'
import { LinkyStoryPicker } from '../components/linky/LinkyStoryPicker'
import { linkyApiBase } from '../lib/linky-live'

const { Text, Title } = Typography

export function StoryBoardPage() {
  return (
    <Space direction="vertical" size="large" className="page-stack">
      <div>
        <Title level={3}>用户故事</Title>
        <Text type="secondary">
          直接读 Linky，打开即是当前状态；正文与附件都是实时的。要把某一批需求送去 AI 分析，
          请到对应批次的「原始需求导入」页选项目组与发布窗口。
        </Text>
      </div>
      <Alert
        type="info"
        showIcon
        title="需要连着公司内网/VPN"
        description={`页面本身从公网加载，但取数接口（${linkyApiBase()}）只在内网可达。不在内网时下面会明确报错，而不是显示一个空列表。`}
      />
      <LinkyStoryPicker />
    </Space>
  )
}
