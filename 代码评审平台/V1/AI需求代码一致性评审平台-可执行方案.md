# AI 需求—代码一致性评审平台（轻量版）可执行方案

> 文档版本：V1.0  
> 目标形态：独立 Web 应用  
> 推荐技术栈：React + Vite + TypeScript + Supabase + SheetJS  
> 核心边界：平台不拉取代码、不调用 AI，只接收人工准备并由 AI 填写完成的 Excel，再组织负责人核对和结果统计。

---

## 1. 项目定位

本项目用于把当前每周需求核对流程产品化。

当前人工流程：

~~~text
从公司运行平台按星期导出部门需求
→ 手工拉取各项目最新基线代码
→ 把需求表和代码交给 AI 分析
→ AI 按要求填写分析结果
→ 将结果发给对应负责人核对
→ 人工收集和汇总结论
~~~

平台化后的流程：

~~~text
上传原始需求 Excel
→ 平台校验并创建周评审批次
→ 平台生成标准 AI 填写模板
→ 操作者在线下完成代码准备和 AI 分析
→ 上传 AI 填写后的 Excel
→ 平台校验并结构化入库
→ 负责人逐条确认
→ 自动生成进度和统计结果
~~~

### 1.1 核心价值

1. 固定 AI 输出格式，避免每周重新整理 Prompt 和结果。
2. 把需求、AI 结论、代码证据、人工确认关联起来。
3. 负责人只看与自己相关的需求，并逐条核对。
4. 自动计算完成率、AI 判断分布和人工准确率。
5. 保留历史批次，能够追溯当时分析的代码基线和结果文件。

### 1.2 V1 明确不做

- 不连接公司需求平台 API，继续人工导出 Excel。
- 不自动执行 Git clone、Git fetch 或创建 worktree。
- 不在平台内调用 Codex、Claude、DeepSeek 等模型。
- 不自动修改代码或创建 Pull Request。
- 不做向量数据库、代码索引和多 Agent 编排。
- 不做企业微信、邮件或消息中心通知。
- 不做复杂组织架构和企业级审批流。

---

## 2. 用户和角色

### 2.1 管理员/评审发起人

- 创建每周评审批次。
- 上传原始需求 Excel。
- 确认字段映射和数据预览。
- 下载 AI 填写模板。
- 手工完成代码准备和 AI 分析。
- 上传 AI 填写完成的 Excel。
- 处理导入错误和警告。
- 查看整个部门的评审进度与统计。
- 结束或重新打开评审批次。

### 2.2 需求负责人

- 查看分配给自己的需求。
- 查看需求原文、AI 判断、代码证据、风险和测试建议。
- 确认 AI 分析是否正确。
- 填写补充意见。
- 修改自己尚未最终提交的确认结果。

### 2.3 查看者（V1 可选）

- 查看已完成批次和汇总结果。
- 不允许修改需求、AI 报告和人工结论。

---

## 3. 总体技术方案

~~~text
┌──────────────────────────────────────┐
│ React + Vite + TypeScript            │
│                                      │
│ 批次 / Excel / 评审 / 看板           │
│ SheetJS 负责 Excel 解析和生成         │
└──────────────────┬───────────────────┘
                   │ Supabase JS SDK
                   ▼
┌──────────────────────────────────────┐
│ Supabase                             │
│                                      │
│ Auth       用户登录                   │
│ PostgreSQL 业务数据                   │
│ Storage    原始表和 AI 结果表         │
│ RLS        数据访问控制               │
│ RPC        多表事务写入               │
└──────────────────────────────────────┘
~~~

### 3.1 技术选型

| 领域 | 选择 | 说明 |
|---|---|---|
| 前端 | React 18 + Vite + TypeScript | 适合表格和管理页面 |
| UI | Ant Design | 表格、步骤条、表单和统计卡片齐全 |
| 请求缓存 | TanStack Query | 管理 Supabase 请求、缓存和刷新 |
| Excel | SheetJS/xlsx | 浏览器内解析和生成 xlsx |
| 后端能力 | Supabase | 提供数据库、登录、存储和权限 |
| 文件 | Supabase Storage | 保存原始 Excel、模板和 AI 结果文件 |
| 部署 | 静态前端 + Supabase | V1 低运维 |

### 3.2 安全原则

- 前端只使用 Supabase anon key，禁止出现 service_role key。
- 所有业务表启用 Row Level Security。
- 文件桶设为私有，通过登录身份访问。
- 原始 Excel 和 AI 结果可能包含公司内部需求，部署前必须确认是否允许存储在托管 Supabase。
- 如不允许使用公有云，可自托管 Supabase，或改用公司内部 PostgreSQL 和对象存储。

---

## 4. 核心业务流程

### 4.1 创建评审批次

管理员填写：

- 批次名称，例如“2026 年第 36 周需求评审”。
- 周标识，例如 2026-W36。
- 需求来源说明。
- 默认代码基线名称，例如 master 或 feature_dev。
- 备注。

初始状态为 DRAFT。同一组织的周标识不能重复；重开一轮时使用修订批次，例如 2026-W36-R2。

### 4.2 上传原始需求 Excel

操作步骤：

1. 选择原始 Excel。
2. 前端使用 SheetJS 读取表头和数据。
3. 用户确认公司表头与平台字段的映射。
4. 平台展示解析预览和校验结果。
5. 用户点击“确认导入”。
6. 原始 Excel 上传到 Storage。
7. 通过 Supabase RPC 在一个事务中写入导入记录和需求数据。

建议平台字段：

| 平台字段 | 必填 | 可能对应的原始列 |
|---|---:|---|
| story_code | 是 | 用户故事编码、需求编号 |
| story_name | 是 | 用户故事名称、需求标题 |
| description | 否 | 用户故事描述、需求内容 |
| acceptance_criteria | 否 | 验收标准 |
| owners_text | 是 | 负责人 |
| project_name | 否 | 所属项目 |
| cloud_name | 否 | 所属云 |
| application_name | 否 | 所属应用 |
| iteration_name | 否 | 迭代阶段 |
| release_window | 否 | 发布窗口 |
| source_status | 否 | 原始需求状态 |

校验规则：

| 规则 | 级别 | 处理方式 |
|---|---|---|
| 用户故事编码为空 | 错误 | 禁止导入 |
| 用户故事名称为空 | 错误 | 禁止导入 |
| 当前批次编码重复 | 错误 | 禁止导入 |
| 负责人为空 | 警告 | 可确认后导入 |
| 应用或项目为空 | 警告 | 可确认后导入 |
| 空白行 | 信息 | 自动忽略 |
| 同一需求在历史批次出现 | 信息 | 正常保留，本批次是独立快照 |

导入完成后，批次进入 WAITING_AI_RESULT。

### 4.3 生成 AI 填写模板

平台基于已导入的需求生成新 Excel，不直接让 AI 修改公司原始表。模板包含三个 Sheet。

#### Sheet 1：批次信息

| 字段 | 示例 | 说明 |
|---|---|---|
| template_version | 1.0 | 用于识别模板结构 |
| batch_id | UUID | 防止上传错批次 |
| batch_name | 2026 年第 36 周需求评审 | 展示字段 |
| week_code | 2026-W36 | 展示字段 |
| baseline_branch | master | 操作者填写 |
| baseline_commit | 8b139cb9 | 操作者填写 |
| ai_model | Codex | 实际使用的模型或工具 |
| analyzed_at | 2026-09-07 18:00 | 分析时间 |

template_version、batch_id 和 story_code 不允许 AI 修改。

#### Sheet 2：需求评审

| 列 | 来源 | 说明 |
|---|---|---|
| 用户故事编码 | 平台生成 | 唯一关联键，不允许修改 |
| 用户故事名称 | 平台生成 | 原始需求快照 |
| 需求描述 | 平台生成 | 原始需求快照 |
| 验收标准 | 平台生成 | 原始需求快照 |
| 负责人 | 平台生成 | 原始需求快照 |
| 所属项目 | 平台生成 | 原始需求快照 |
| 所属应用 | 平台生成 | 原始需求快照 |
| AI判断 | AI填写 | 已实现/部分实现/未实现/无法判断 |
| 置信度 | AI填写 | 0～100 |
| 分析摘要 | AI填写 | 简要总体结论 |
| 已实现内容 | AI填写 | 多条内容使用单元格内换行 |
| 缺失内容 | AI填写 | 多条内容使用单元格内换行 |
| 风险 | AI填写 | 多条内容使用单元格内换行 |
| 建议测试点 | AI填写 | 多条内容使用单元格内换行 |
| AI备注 | AI填写 | 假设、无法判断原因等 |

#### Sheet 3：代码证据

一条需求可以对应多条证据，每条证据占一行：

| 列 | 必填 | 说明 |
|---|---:|---|
| 用户故事编码 | 是 | 必须存在于需求评审 Sheet |
| 仓库 | 是 | 代码仓库名称 |
| Commit | 建议 | 对应分析基线 |
| 文件路径 | 是 | 仓库相对路径 |
| 类/方法 | 否 | 类名、方法名或前端组件名 |
| 开始行 | 否 | 起始行号 |
| 结束行 | 否 | 结束行号 |
| 证据类型 | 是 | 现有实现/缺失依据/风险依据 |
| 证据说明 | 是 | 该代码与需求的关系 |

### 4.4 上传 AI 填写结果

上传必须分成“解析预览”和“确认入库”两步。

校验项目：

1. batch_id 与当前批次一致。
2. template_version 是平台支持的版本。
3. 所有用户故事编码都属于当前批次。
4. 不允许重复用户故事编码。
5. 不允许修改需求名称、负责人等原始字段。
6. AI判断必须是固定枚举。
7. 置信度必须在 0～100。
8. 代码证据引用的用户故事必须存在。
9. “已实现”或“部分实现”没有代码证据时给出警告。
10. 缺少AI结果的需求显示为“未分析”，不能静默丢失。

确认后：

- AI结果文件保存到 Storage。
- 创建一条 ai_import_record。
- 每条需求创建新版本 ai_review_result。
- 创建对应 ai_code_evidence。
- 不覆盖历史上传结果。
- 批次进入 REVIEWING。

### 4.5 负责人核对

负责人查看原始需求、基线、AI判断、代码证据、风险和测试建议，并选择：

~~~text
CORRECT             AI分析正确
PARTIALLY_CORRECT   AI分析部分正确
INCORRECT           AI分析错误
NEED_DISCUSSION     需要进一步确认
~~~

同时保存补充意见、确认人和确认时间。

人工结论必须引用具体 ai_review_result_id。重新上传AI结果后，旧的人工确认仍然指向旧报告。

### 4.6 完成评审

当所有需要核对的需求都有人工作出结论后，管理员完成批次。

如仍有未确认项，页面必须展示数量并二次确认。完成后默认只读；重新打开时记录操作日志。

---

## 5. 页面设计

### 5.1 批次列表 /batches

展示批次名称、周标识、状态、需求总数、AI完成数、人工确认数、创建人和创建时间。

### 5.2 原始需求导入 /batches/:id/import

采用步骤条：

~~~text
选择文件 → 字段映射 → 数据校验 → 确认导入
~~~

必须展示错误、警告、有效数据数量和部分数据预览。

### 5.3 AI结果管理 /batches/:id/ai-result

- 下载AI填写模板。
- 上传AI结果。
- 查看解析校验结果。
- 查看历次上传记录。
- 设置当前生效的AI报告版本。

### 5.4 评审列表 /batches/:id/reviews

支持按负责人、应用、项目、AI判断、人工状态和是否存在证据筛选。

### 5.5 单条评审 /batches/:id/reviews/:storyId

~~~text
左侧：需求信息
中间：AI分析和代码证据
右侧：人工结论和补充意见
底部：上一条 / 保存 / 保存并下一条
~~~

### 5.6 统计看板 /batches/:id/dashboard

- 需求总数。
- AI已分析和未分析数量。
- 已实现、部分实现、未实现、无法判断分布。
- 人工已确认和待确认数量。
- AI正确、部分正确、错误、待讨论分布。
- 按负责人和应用统计进度。

---

## 6. 数据模型

所有表包含 id UUID、created_at 和 updated_at。

### 6.1 review_batch

| 字段 | 类型 | 说明 |
|---|---|---|
| name | text | 批次名称 |
| week_code | text | 2026-W36 |
| status | text | 批次状态 |
| default_branch | text | 默认基线分支 |
| remark | text | 备注 |
| created_by | uuid | 创建人 |
| completed_at | timestamptz | 完成时间 |

唯一约束：week_code。支持多组织后改为 organization_id + week_code。

### 6.2 import_file

| 字段 | 类型 | 说明 |
|---|---|---|
| batch_id | uuid | 所属批次 |
| file_type | text | SOURCE/AI_RESULT/TEMPLATE |
| file_name | text | 原始文件名 |
| storage_path | text | Storage路径 |
| file_hash | text | SHA-256 |
| template_version | text | 模板版本 |
| uploaded_by | uuid | 上传人 |

### 6.3 review_story

| 字段 | 类型 | 说明 |
|---|---|---|
| batch_id | uuid | 所属批次 |
| story_code | text | 用户故事编码 |
| story_name | text | 用户故事名称 |
| description | text | 需求描述 |
| acceptance_criteria | text | 验收标准 |
| owners_text | text | 原始负责人文本 |
| project_name | text | 所属项目 |
| cloud_name | text | 所属云 |
| application_name | text | 所属应用 |
| iteration_name | text | 迭代阶段 |
| release_window | text | 发布窗口 |
| source_status | text | 来源状态 |
| source_data | jsonb | 未标准化的原始列 |

唯一约束：batch_id + story_code。

### 6.4 ai_import_record

| 字段 | 类型 | 说明 |
|---|---|---|
| batch_id | uuid | 所属批次 |
| import_file_id | uuid | AI结果文件 |
| version | integer | 本批次第几次上传 |
| baseline_branch | text | 分析分支 |
| baseline_commit | text | 分析Commit |
| ai_model | text | 使用的模型/工具 |
| analyzed_at | timestamptz | 分析时间 |
| imported_by | uuid | 导入人 |
| is_active | boolean | 是否当前生效 |

唯一约束：batch_id + version。

### 6.5 ai_review_result

| 字段 | 类型 | 说明 |
|---|---|---|
| story_id | uuid | 需求 |
| ai_import_record_id | uuid | 所属导入版本 |
| verdict | text | AI判断 |
| confidence | integer | 0～100 |
| summary | text | 分析摘要 |
| implemented_content | text | 已实现内容 |
| missing_content | text | 缺失内容 |
| risks | text | 风险 |
| test_points | text | 建议测试点 |
| ai_remark | text | AI备注 |

唯一约束：story_id + ai_import_record_id。

### 6.6 ai_code_evidence

| 字段 | 类型 | 说明 |
|---|---|---|
| ai_review_result_id | uuid | 所属AI报告 |
| repository_name | text | 仓库 |
| commit_sha | text | Commit |
| file_path | text | 文件路径 |
| symbol_name | text | 类、方法或组件 |
| start_line | integer | 开始行 |
| end_line | integer | 结束行 |
| evidence_type | text | 证据类型 |
| description | text | 证据说明 |

### 6.7 human_review

| 字段 | 类型 | 说明 |
|---|---|---|
| story_id | uuid | 需求 |
| ai_review_result_id | uuid | 被确认的AI报告 |
| reviewer_id | uuid | 确认人 |
| result | text | 人工结论 |
| comment | text | 补充意见 |
| reviewed_at | timestamptz | 确认时间 |

唯一约束：story_id + ai_review_result_id + reviewer_id。

---

## 7. 状态和枚举

批次状态：

~~~text
DRAFT
→ WAITING_AI_RESULT
→ REVIEWING
→ COMPLETED
~~~

AI判断：

~~~text
IMPLEMENTED
PARTIAL
NOT_IMPLEMENTED
UNCERTAIN
~~~

人工判断：

~~~text
CORRECT
PARTIALLY_CORRECT
INCORRECT
NEED_DISCUSSION
~~~

数据库存英文枚举，前端显示中文，避免修改文案时影响历史数据。

---

## 8. Supabase实现要点

### 8.1 Storage目录

创建私有Bucket：review-files。

~~~text
{batch_id}/source/{timestamp}-{filename}
{batch_id}/template/{timestamp}-{filename}
{batch_id}/ai-result/{timestamp}-{filename}
~~~

### 8.2 RLS原则

- 登录用户可以读取批次和评审数据。
- 只有管理员可以创建批次、导入文件和完成批次。
- 用户只能写自己的 human_review。
- 用户不能修改 review_story 和 ai_review_result。
- Storage文件只能由登录用户读取，管理员上传。

角色可以先保存在 user_profile.role：

~~~text
ADMIN
REVIEWER
VIEWER
~~~

RLS必须依据 auth.uid() 查询角色，不能相信前端传来的角色字段。

### 8.3 RPC事务

至少提供两个数据库函数：

~~~text
confirm_source_import(...)
confirm_ai_result_import(...)
~~~

每次确认都涉及多表写入，必须保证全部成功或全部失败。不要让前端逐条插入。

### 8.4 文件幂等

前端读取文件后计算SHA-256。相同批次、类型和Hash的文件重复上传时，提示已导入并阻止重复写入。

---

## 9. AI填写规范

平台下载模板时，同时提供固定Prompt：

~~~text
你需要根据指定代码基线分析“需求评审”Sheet中的每条用户故事，并填写本工作簿。

要求：
1. 不得修改批次信息和原始需求字段。
2. AI判断只能填写：已实现、部分实现、未实现、无法判断。
3. 必须逐条核对需求中的规则和验收标准。
4. 已实现或部分实现必须在“代码证据”Sheet中提供证据。
5. 文件路径必须使用仓库相对路径。
6. 尽量填写类名、方法名和准确行号。
7. 不得把“没有搜索到”直接等同于“未实现”；搜索范围不足时填写“无法判断”。
8. 只填写Excel，不修改源代码。
9. 保存时保持Sheet名称和列名不变。
~~~

交给AI的内容：

- AI填写模板。
- 当前代码目录。
- 明确的基线分支和Commit。
- 本次允许分析的仓库范围。
- 固定填写规范。

---

## 10. 开发任务拆分

### 阶段一：项目骨架和Supabase（1～2天）

- [ ] 创建 React + Vite + TypeScript 项目。
- [ ] 接入 Ant Design、TanStack Query、Supabase JS、SheetJS。
- [ ] 创建 Supabase 项目并配置登录。
- [ ] 创建业务表、索引和约束。
- [ ] 创建私有Storage Bucket。
- [ ] 配置基础RLS。

交付：用户可以登录并打开批次列表。

### 阶段二：批次和原始Excel导入（2～3天）

- [ ] 创建批次页面。
- [ ] Excel文件选择和Sheet识别。
- [ ] 表头字段映射。
- [ ] 数据标准化和校验。
- [ ] 错误、警告和预览。
- [ ] 上传原始文件。
- [ ] 实现 confirm_source_import RPC。
- [ ] 批次详情和需求列表。

交付：真实公司Excel能够创建完整批次。

### 阶段三：AI模板和结果上传（2～3天）

- [ ] 生成三个Sheet的标准模板。
- [ ] 锁定模板版本、批次ID和原始字段。
- [ ] 上传并解析AI结果。
- [ ] 校验模板一致性和代码证据。
- [ ] 展示错误和警告。
- [ ] 实现 confirm_ai_result_import RPC。
- [ ] 保存AI结果文件和上传历史。

交付：AI填写结果能够稳定导入，并识别错批次、重复行和非法值。

### 阶段四：人工评审（2～3天）

- [ ] 评审列表和筛选。
- [ ] 单条评审详情。
- [ ] 代码证据展示。
- [ ] 人工结论和补充意见。
- [ ] 上一条、保存、保存并下一条。
- [ ] 我的待核对筛选。
- [ ] 防止修改他人的确认结果。

交付：负责人可以逐条完成核对。

### 阶段五：看板和上线（2天）

- [ ] 批次进度统计。
- [ ] AI判断和人工结论分布。
- [ ] 按负责人、应用统计。
- [ ] 完成和重新打开批次。
- [ ] 使用真实周数据回归。
- [ ] 部署前完成数据合规确认。

整体预计：个人业余开发约2～3周；集中开发约8～12个工作日。

---

## 11. MVP验收标准

### Excel导入

- [ ] 能导入一份真实公司需求Excel。
- [ ] 能处理空白行、多负责人和非固定列顺序。
- [ ] 重复需求编码会被阻止。
- [ ] 导入前一定有预览。
- [ ] 原始文件可追溯和下载。

### AI结果

- [ ] 能生成标准AI填写模板。
- [ ] 上传错批次模板会被阻止。
- [ ] 未知需求编码会被阻止。
- [ ] 非法AI判断和置信度会被阻止。
- [ ] 缺少AI结果的需求会明确显示。
- [ ] 一条需求可以展示多条代码证据。
- [ ] 重复上传不会覆盖历史报告。

### 人工评审

- [ ] 负责人能够筛选自己的需求。
- [ ] 能看到完整原始需求和AI报告。
- [ ] 能提交四种人工结论之一。
- [ ] 能保存补充意见。
- [ ] 人工结论关联具体AI报告版本。

### 统计和安全

- [ ] 看板统计与明细数量一致。
- [ ] 完成批次前提示未确认数量。
- [ ] 未登录用户不能访问数据。
- [ ] 普通用户不能修改导入数据和AI报告。
- [ ] 前端不存在Supabase service_role key。

---

## 12. 上线前需要确认

1. 公司需求内容是否允许存放在托管Supabase。
2. 如不允许，使用公司服务器、自托管Supabase还是内部数据库。
3. 原始Excel的真实表头和示例数据。
4. 负责人字段能否对应登录账号。
5. 每周平均需求数量和最大文件大小。
6. 一条需求是否需要多个负责人共同确认。
7. 批次完成后是否允许修改人工结论。
8. AI分析结果需要保留多长时间。

---

## 13. 后续版本

### V1：轻量闭环

~~~text
需求Excel → AI模板 → 手工AI分析 → 结果上传 → 人工确认 → 看板
~~~

### V1.5：体验优化

- 自动保存字段映射，下周直接复用。
- 根据负责人账号生成“我的待核对”。
- 导出评审周报。
- 比较同一需求不同批次的AI结论。
- 增加评论和问题标记。

### V2：减少需求搬运

- 对接公司需求平台API。
- 关联组织和人员账号。
- 企业微信或邮件提醒。

### V3：按实际价值决定是否自动化AI

- 自动锁定Git Commit。
- 后台代码Agent分析。
- 自动生成结构化结果。
- 重新分析和模型切换。

只有V1证明“AI结果有用、负责人愿意核对”后，才值得投入V3。

---

## 14. 最终实施结论

第一版采用：

~~~text
React + Vite + TypeScript
+ Ant Design
+ SheetJS
+ Supabase Auth/PostgreSQL/Storage/RLS
~~~

平台只完成四件事：

1. 管理每周需求批次。
2. 生成并导入标准AI分析Excel。
3. 组织负责人逐条确认。
4. 汇总和沉淀评审结果。

这是当前投入最低、最容易真正上线使用的方案，也为以后对接需求平台和自动执行代码Agent保留扩展空间。
