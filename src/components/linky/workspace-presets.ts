/**
 * Linky 项目组临时人工目录。2026-10-20 从只读 stories 接口遍历 48 页，
 * 确认 29 个不同项目组。接口 scopes=33，但其他范围未从故事列表取得名称，未编造补齐。
 * 新增／删除组：修改下方完整名称，提交、构建，再运行 Linux 统一发布脚本。
 * 未收录的组仍可在下拉中输入完整名称查询；这不是权限或成员范围配置。
 */
export const LINKY_WORKSPACE_PRESETS: readonly string[] = [
  "AI工程协作小组",
  "AI评测组",
  "CEO组",
  "CFO组",
  "DC数据研发组",
  "DC数据运营",
  "DC知识与记忆组",
  "Manage AI组织组",
  "Manage审批中心组",
  "Manage工作台组",
  "Manage知识",
  "Manage驾驶舱组",
  "harness工程架构组",
  "harness算法组",
  "前端开发组",
  "基础服务组",
  "多模态算法组",
  "安全合规组",
  "工具开发组",
  "平台开发组",
  "平台质量组",
  "渠道云",
  "灵基AIOS",
  "灵基Data Cloud",
  "灵基Foundation",
  "灵基Manage",
  "灵基知识记忆组",
  "灵基质量执行平台quality-platform",
  "灵基运营组",
]
