/**
 * 用户故事看板（V1.20 修订）。
 *
 * 只做一件事：**实时**看 Linky 上的需求 —— 按项目组与发布窗口筛，看正文，下载附件。
 * 这里没有「导入到批次」：一个批次要分析哪些需求，是在批次自己的「原始需求导入」页
 * 定义的（选项目组 + 发布窗口 + 勾选，确认那一刻才冻结）。把两件事混在一个页面上，
 * 会让"我只是来看看"和"我要定一批需求去跑分析"用同一个按钮，那是两种完全不同的意图。
 *
 * 页头不放静态说明，也不放「需要连内网/VPN」的常驻提示：不在内网时 LinkyStoryPicker
 * 会就地弹出真实的取数错误（带接口地址与「重试」），那比一句永远挂在上面的提醒更准确 ——
 * 去掉它不会让失败变得沉默。
 */
import { Space, Typography } from 'antd'
import { LinkyStoryPicker } from '../components/linky/LinkyStoryPicker'

const { Title } = Typography

export function StoryBoardPage() {
  return (
    <Space direction="vertical" size="large" className="page-stack">
      <Title level={3}>用户故事</Title>
      <LinkyStoryPicker />
    </Space>
  )
}
