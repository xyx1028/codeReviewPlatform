/**
 * Linky 项目组人工目录（MCP 侧副本，V1.60）。
 *
 * **这份清单必须与 `src/components/linky/workspace-presets.ts` 完全一致。**
 * 一致性由前端测试 `src/components/linky/__tests__/workspace-presets-sync.test.ts`
 * 强制 —— 两边不一样时那条测试会失败。
 *
 * 为什么是两份文件而不是一份：前端是 TS、构建期打包；MCP 是独立的 .mjs 包，运行期从磁盘
 * 加载，两者没有共同的模块系统，跨目录 import 会把 MCP 的可打包性绑死在前端目录结构上。
 * 与其为了"物理上一份"引入打包步骤，不如让漂移变成一条**失败的测试**。
 *
 * 为什么需要人工目录：上游取数接口**没有"列出工作区"的端点**。这 29 个名字是
 * 2026-10-20 遍历 stories 接口 48 页得到的（接口报 `scopes=33`，但其余范围未从故事列表里
 * 出现过名字，所以不编造补齐）。未收录的组仍可按完整名称直接使用 —— 这份清单只是
 * 为了让调用方的模型**不用猜名字**，它不是权限或成员范围配置。
 */

export const LINKY_WORKSPACE_PRESETS = Object.freeze([
  'AI工程协作小组',
  'AI评测组',
  'CEO组',
  'CFO组',
  'DC数据研发组',
  'DC数据运营',
  'DC知识与记忆组',
  'Manage AI组织组',
  'Manage审批中心组',
  'Manage工作台组',
  'Manage知识',
  'Manage驾驶舱组',
  'harness工程架构组',
  'harness算法组',
  '前端开发组',
  '基础服务组',
  '多模态算法组',
  '安全合规组',
  '工具开发组',
  '平台开发组',
  '平台质量组',
  '渠道云',
  '灵基AIOS',
  '灵基Data Cloud',
  '灵基Foundation',
  '灵基Manage',
  '灵基知识记忆组',
  '灵基质量执行平台quality-platform',
  '灵基运营组',
])

/**
 * 按关键字筛项目组。
 *
 * 这正是那次事故需要的东西：使用者说「工具组」，关键字匹配能直接给出「工具开发组」。
 * 匹配不区分大小写，并且**子串命中即算**（而不是前缀）—— 简称往往落在名字中间。
 */
export function filterWorkspaces(keyword, presets = LINKY_WORKSPACE_PRESETS) {
  const needle = String(keyword ?? '').trim().toLowerCase()
  if (needle === '') return [...presets]
  const hits = presets.filter((name) => name.toLowerCase().includes(needle))
  if (hits.length > 0) return hits
  // 子串没命中就退一步：把关键字拆成单字，命中任意一个字的都算候选。
  // 「工具组」这种"缩写"在清单里是「工具开发组」—— 子串匹配不到，但逐字匹配能捞回来。
  const chars = [...new Set([...needle])].filter((char) => char.trim() !== '')
  if (chars.length === 0) return []
  const scored = presets
    .map((name) => ({
      name,
      score: chars.filter((char) => name.toLowerCase().includes(char)).length,
    }))
    .filter((entry) => entry.score >= Math.min(2, chars.length))
    .sort((a, b) => b.score - a.score || a.name.length - b.name.length)
  return scored.map((entry) => entry.name)
}
