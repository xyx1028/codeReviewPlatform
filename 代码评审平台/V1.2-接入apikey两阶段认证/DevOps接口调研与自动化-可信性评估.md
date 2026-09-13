# DevOps 用户故事接口调研与自动化可信性评估

> 调研日期：2026-09-08  
> 调研对象：金蝶云 DevOps DMP 用户故事管理  
> 目标入口：`https://devops.kingdee.com:8000/?formId=home_page&code=1788849398aabd3b22dc8f41df94e1bd`  
> 调研方式：复用用户当前已登录的 Chrome 会话，通过浏览器 UI 和 DevTools 网络事件进行只读验证。  
> 数据保护：本文不记录 Cookie 值、CSRF Token、动态签名、下载票据、用户 ID 或完整业务数据。

## 1. 结论摘要

DevOps 用户故事取数自动化具有较高可行性，但推荐方式不是由后端服务直接仿造 HTTP 请求，而是使用运行在用户电脑或内网机器上的浏览器 Runner，通过真实登录会话驱动页面并拦截结构化响应。

本次已经现场验证：

- 能从目标入口进入 DMP 用户故事列表。
- 用户故事列表直接返回结构化 JSON，不需要先导出 Excel 才能获取数据。
- Scrum 团队可以通过项目组选择器查询并得到稳定的团队 ID。
- 发布窗口可以通过列表列筛选准确查询。
- Scrum 团队与发布窗口可以组合生效。
- 列表支持分页，可通过接口逐页获取全部记录。
- 用户故事详情能够通过结构化接口读取。
- Excel 导出是异步任务，具备进度查询和最终附件下载地址。
- 登录依赖浏览器会话 Cookie、CSRF Token 和动态请求签名。
- 页面 `pageId` 每次打开都会重新生成，接口不是普通的无状态 REST API。
- 本次检查的用户故事列表和详情均未发现仓库、Git 分支或 Commit 字段。

因此：

1. “输入 Scrum 团队和发布窗口，自动获得需求数据”可以实现，可信度高。
2. “绕过浏览器，由普通后端直接调用这些内部接口”短期不推荐，维护风险较高。
3. “只输入两个条件后自动拉取正确代码分支并完成 AI 分析”目前还缺少需求到仓库、分支的映射来源，不能仅靠已调研的用户故事接口闭环。

## 2. 可信度评分

以下评分是基于现场验证范围给出的工程判断，不是统计意义上的可用性承诺。

| 能力 | 可信度 | 结论 |
|---|---:|---|
| 自动进入用户故事管理 | 95% | 已在当前登录会话中验证 |
| 自动查询 Scrum 团队 | 95% | 已验证团队选择器、团队编码和内部 ID |
| 自动按发布窗口筛选 | 95% | 已验证字段和精确匹配参数 |
| Scrum 团队 + 发布窗口组合查询 | 95% | 已现场得到正确组合结果 |
| 自动处理分页 | 95% | 已验证第二页请求和分页元数据 |
| 直接解析结构化需求数据 | 95% | 返回字段索引和行数组，数据完整度高 |
| 自动读取需求详情 | 90% | 已验证一条实际需求详情 |
| 自动导出 Excel | 90% | 已验证异步进度和附件下载流程 |
| 复用用户浏览器登录态 | 85% | 当前会话可用；尚未验证过期、SSO 二次认证和跨设备场景 |
| 后端无浏览器直接重放接口 | 45% | 动态签名、CSRF、会话 Cookie 和动态 pageId 使其较脆弱 |
| 自动确定代码仓库和分支 | 30% | 已检查的列表及详情没有仓库、分支、Commit 字段 |
| 只输入两个条件完成需求取数 | 90% | 推荐浏览器 Runner 方案 |
| 只输入两个条件完成全链路 AI 评审 | 60% | 需求取数已具备，代码定位仍需补充映射机制 |
| 增加仓库映射和分支规则后的全链路方案 | 85% | 主要技术障碍可控，但仍需处理登录过期和分支歧义 |

## 3. 已验证的页面与数据规模

现场进入了：

```text
研发管理（DMP）
└── 用户故事管理
    └── 用户故事列表
```

初始列表现场返回：

- 总记录数：96 条。
- 每页：50 条。
- 总页数：2 页。
- 第二页返回：46 条。
- 列表控件声明的最大页容量：1000。
- 页面提供“引出数据（最大 10000 条）”功能。

以上数字是调研当时当前账号和默认过滤方案下的快照，不应写死在程序中。程序必须读取响应里的 `datacount`、`pagerows`、`pagecount` 和 `pageindex`。

## 4. 接口协议总体特征

绝大多数业务动作都进入同一个入口：

```http
POST /form/batchInvokeAction.do?appId={appId}&f={formId}&ac={action}
Content-Type: application/x-www-form-urlencoded;charset=utf-8
```

请求体大致为：

```text
pageId=<当前页面实例 ID>
&appId=dmp
&params=<URL 编码后的 JSON 动作数组>
```

`params` 中包含：

```json
[
  {
    "key": "控件标识",
    "methodName": "动作名称",
    "args": [],
    "postData": [{}, []]
  }
]
```

响应不是传统业务 REST DTO，而是页面动作数组。常见动作包括：

- `showForm`：打开子页面或选择窗口。
- `setVisible`：调整控件显示状态。
- `updateControlMetadata`：返回表格和表单元数据。
- `InvokeControlMethod`：让前端控件执行动作。
- `u`：更新控件值和数据。
- `sendDynamicFormAction`：在子页面和父页面间传递动作。
- `download`：触发附件下载。

这说明 DevOps DMP 使用的是有状态动态表单协议，而不是稳定公开 REST API。

## 5. 核心接口清单

### 5.1 打开用户故事列表

用户点击首页的“用户故事管理”后，涉及：

```http
POST /form/batchInvokeAction.do?appId=bos&f=bos_card_quicklaunch&ac=customEvent
POST /form/batchInvokeAction.do?appId=dmp&f=dmp_apphome&ac=loadData
POST /form/batchInvokeAction.do?appId=dmp&f=dmp_require_org&ac=loadData
```

最后一个 `loadData` 响应包含：

- 查询面板元数据。
- 表格列定义。
- `dataindex` 字段到数组下标的映射。
- `rows` 数据数组。
- 分页信息。
- `postcols` 主键及回传字段。

不要在程序中按固定数组下标解析，应先读取 `dataindex`。

### 5.2 Scrum 团队选择器

点击 Scrum 团队的 F7 选择按钮：

```http
POST /form/batchInvokeAction.do?appId=dmp&f=dmp_require_org&ac=f7Click
```

关键参数：

```text
目标基础资料：dmp_project_team_org
目标字段：team.name
```

团队列表加载：

```http
POST /form/batchInvokeAction.do?appId=dmp&f=dmp_project_team_org&ac=loadData
```

团队列表返回了：

- `number`：团队编码，例如 `LINGEE-04`。
- `name`：团队名称。
- `dmp_project_team_org_id`：内部稳定 ID。
- 产品、领域、团队类型、负责人等扩展字段。

选择团队时页面调用：

```http
POST ...&f=dmp_project_team_org&ac=entryRowClick
POST ...&f=dmp_project_team_org&ac=click
POST ...&f=dmp_project_team_org&ac=release
```

父页面最终收到：

```json
{
  "fieldName": "team.name",
  "id": ["<team-id>"],
  "value": ["<team-name>"]
}
```

正式实现应保存团队内部 ID，同时展示团队编码和名称，不能只按名称匹配。

### 5.3 查询面板组合查询

点击顶部“查询”调用：

```http
POST /form/batchInvokeAction.do?appId=dmp&f=dmp_require_org&ac=schemeSearch
```

Scrum 团队条件现场表现为：

```json
{
  "FieldName": ["team.name"],
  "Compare": ["17"],
  "Value": ["<team-name>"],
  "Id": ["<team-id>"],
  "Logic": [0]
}
```

其中比较符 `17` 表示选择器场景下的匹配方式。实现时不应推测比较符语义，应复用页面真实行为。

### 5.4 发布窗口列筛选

发布窗口列的数据字段为：

```text
publishperiod_name
```

现场使用“等于”条件后调用：

```http
POST /form/batchInvokeAction.do?appId=dmp&f=dmp_require_org&ac=getGridDataByFilter
```

请求参数：

```json
[
  {
    "FieldName": ["publishperiod_name"],
    "Value": ["<release-window>"],
    "Compare": ["67"]
  }
]
```

其中 `67` 已现场确认对应“等于”。

本次以一个实际发布窗口测试后，Scrum 团队和发布窗口组合返回 3 条匹配记录，页面显示结果与响应一致。

### 5.5 分页

翻到第二页调用：

```http
POST /form/batchInvokeAction.do?appId=dmp&f=dmp_require_org&ac=setPageIndex
```

请求动作：

```json
{
  "key": "billlistap",
  "methodName": "setPageIndex",
  "args": [2]
}
```

返回分页信息示例：

```json
{
  "pageindex": 2,
  "pagerows": 50,
  "rowcount": 46,
  "pagecount": 2,
  "datacount": 96
}
```

Runner 应循环到 `pageindex == pagecount`，不要假定只有一页。

### 5.6 用户故事详情

点击需求编码后涉及：

```http
POST /form/batchInvokeAction.do?appId=dmp&f=dmp_require_org&ac=entryRowClick
POST /form/batchInvokeAction.do?appId=dmp&f=dmp_require_details&ac=loadData
```

现场详情页面可获得：

- 用户故事编码、名称和类型。
- 优先级和当前状态。
- 计划完成时间。
- 所属云、所属应用、产品组、Scrum 团队。
- 负责人、所属项目、版本、迭代阶段。
- 发布窗口、迭代目标、父级特性。
- KSM 或 BUG 编号、计划人天、客户名称。
- 需求描述、验收标准、处理说明、附件状态。

对详情响应全文和字段名进行关键词检查，没有发现：

```text
repository / repo / branch / commit / git
仓库 / 分支 / 提交 / 代码 / 合并
```

因此目前没有证据表明可以从这个详情接口直接得到代码仓库和分支。

### 5.7 Excel 导出

页面提供：

- 导出数据（按列表）。
- 引出数据（最大 10000 条）。

选中筛选结果后，现场验证的流程为：

```http
POST ...&f=dmp_require_org&ac=exportlist
POST ...&f=bos_exportdataprogress&ac=loadData
POST ...&f=bos_exportdataprogress&ac=getPercent
GET  /attachment/download.do?attachId=<id>&fId=dmp_require_org&appId=dmp&kd_cs_ticket=<ticket>
POST ...&f=bos_exportdataprogress&ac=release
```

导出属于异步任务：

1. 创建导出进度窗口。
2. 周期查询完成数量和百分比。
3. 达到 100% 后获取附件地址。
4. 下载地址额外携带短期下载票据。

自动化平台没有必要依赖这个 Excel。直接解析用户故事列表响应更快、更稳定；Excel 可作为审计附件和接口解析失败时的备用方案。

## 6. 可用字段映射

列表响应至少包含以下与评审平台直接相关的字段：

| DevOps 字段 | 平台建议字段 | 含义 |
|---|---|---|
| `number` | `story_code` | 用户故事编码 |
| `name` | `story_name` | 用户故事名称 |
| `description` | `description` | 需求描述 |
| `acceptstandard` | `acceptance_criteria` | 验收标准 |
| `leader` | `owners_text` | 负责人显示文本 |
| `team_name` | `scrum_team_name` | Scrum 团队 |
| `proteam_name` | `product_team_name` | 产品组 |
| `iteration_name` | `iteration_name` | 迭代阶段 |
| `iterationgoal_name` | `iteration_goal` | 迭代目标 |
| `subject_publishplan_name` | `release_plan` | 发布计划 |
| `publishperiod_name` | `release_window` | 发布窗口 |
| `processstatus_name` | `source_status` | 用户故事状态 |
| `project_name` | `project_name` | 所属项目 |
| `cloud_name` | `cloud_name` | 所属云 |
| `function_name` | `application_name` | 所属应用/功能 |
| `type_name` | `story_type` | 需求类型 |
| `dmp_require_org_id` | `source_record_id` | DevOps 内部主键 |

响应中存在 100 个以上字段。平台只应保存业务需要的标准字段，同时将其余内容放入 `source_data` JSON 快照，避免后续新增字段时重新取数。

## 7. 登录和认证分析

### 7.1 已确认的登录依赖

当前登录会话存在以下 Cookie 名称：

```text
KERPSESSIONIDdevops
acplatform_sid
acplatform_stk
XSRF-TOKEN
IsolatorSpandevops
devops_kdshareflag
```

其中多个会话 Cookie 为：

- `HttpOnly=true`
- `Secure=true`
- 会话级 Cookie

业务请求还包含以下头：

```text
ajax
cqappid
kd-csrf-token
signature
traceId
userId
client-start-time
```

现场对两个请求进行了比较：

- CSRF Token 存在，并且在当前会话内保持一致。
- `signature` 存在，长度固定，但不同请求的值不同。
- `traceId` 每次请求变化。

### 7.2 pageId 是动态的

在同一浏览器会话中新开一个相同入口页面，生成了不同的根 `pageId`。因此：

- 不能将调研时的 `pageId` 写入配置。
- 不能从任务中间随意更换页面实例。
- 必须按“打开首页 → 打开 DMP → 打开用户故事列表 → 设置条件 → 读取数据”的顺序运行。
- DevOps 取数步骤失败后，建议整体重建页面会话并重新执行，而不是重放最后一次请求。

### 7.3 登录过期尚未验证

本次使用的是有效登录态，没有主动退出账号，因此以下行为仍需在开发 PoC 中补测：

- Cookie 的实际失效时间。
- SSO 是否能够无感续期。
- VPN 重连后会话是否仍有效。
- 是否存在短信、扫码、MFA 或验证码。
- 同一账号并发运行多个浏览器页面是否互相影响。

## 8. 为什么不推荐普通后端直接调用

如果由中央后端直接调用 `batchInvokeAction.do`，需要同时解决：

1. 获取并维护用户的公司 SSO 登录 Cookie。
2. 获取 CSRF Token。
3. 生成每次变化的 `signature`。
4. 创建并维护服务端页面实例和动态 `pageId`。
5. 复现父子页面之间的 `sendDynamicFormAction`。
6. 按正确顺序执行 F7 选择、筛选、分页等有状态动作。
7. 处理 DevOps 前端版本升级导致的动作协议变化。

直接重放方案并非完全不能做，但相当于重新实现一部分 DevOps 动态表单客户端，长期维护成本较高。

只有在 DevOps 团队能够提供以下任一条件时，才建议改为中央后端直连：

- 正式开放 API。
- 服务账号和稳定 Token。
- 签名算法及调用协议文档。
- 允许使用的内部 SDK。

## 9. 推荐实现：本地浏览器 Runner

### 9.1 部署形态

```text
代码评审平台 Web
        │
        │ 创建取数任务
        ▼
平台编排服务 / Supabase
        │
        │ 任务领取、状态回报
        ▼
值班人员电脑上的 Local Runner
        ├── Playwright/Chromium
        ├── DevOps 登录会话
        ├── DevOps 响应解析器
        ├── Git 凭证和仓库缓存
        └── AI 分析执行器
```

公司登录 Cookie 和 Git 凭证只保存在本机 Runner，不上传到平台。

### 9.2 推荐取数流程

```text
1. Runner 接收 Scrum 团队和发布窗口
2. 打开目标 DevOps 入口
3. 检查是否已登录
4. 未登录：打开可见窗口，等待用户完成公司登录
5. 进入“用户故事管理”
6. 打开 Scrum 团队 F7 选择器
7. 按团队编码或名称检索
8. 读取并确认唯一 team-id
9. 回填 Scrum 团队
10. 对 publishperiod_name 设置等于条件
11. 等待列表请求完成
12. 解析 dataindex 和 rows
13. 按 pagecount 逐页读取
14. 去重并校验筛选条件
15. 保存结构化需求和原始响应摘要
16. 进入后续仓库解析与 AI 分析
```

### 9.3 不建议只操作 DOM 表格

最佳实践是：

- 用浏览器操作完成登录和有状态筛选。
- 监听 `batchInvokeAction.do` 网络响应。
- 从结构化响应解析需求数据。
- DOM 表格文本仅用于结果数量和关键条件的二次校验。

这样可以避免：

- 横向滚动造成列缺失。
- 只读取当前可见行。
- 富文本内容被截断。
- 虚拟表格尚未渲染全部数据。
- 页面列顺序被用户个性化设置修改。

## 10. 稳定性保护措施

### 10.1 页面健康检查

Runner 启动后必须确认：

- 页面标题为 DevOps 平台。
- 已显示研发管理 DMP。
- 能进入用户故事列表。
- 列表响应 MIME 类型为 JSON。
- 响应中包含 `dataindex`、`rows` 和 `datacount`。

若出现登录页、无权限提示或 HTML 错误页，立即暂停，不继续解析。

### 10.2 字段契约检查

每次取数至少验证以下字段存在：

```text
number
name
team_name 或 proteam_name
publishperiod_name
leader
processstatus_name
dmp_require_org_id
```

字段缺失时将批次标记为 `DEVOPS_SCHEMA_CHANGED`，保留脱敏响应样本并通知管理员，不允许以空值继续 AI 分析。

### 10.3 筛选结果二次校验

即使服务器已经筛选，Runner 仍应逐行校验：

```text
row.team_name / row.proteam_name == 用户选择团队
row.publishperiod_name == 用户选择发布窗口
```

不符合条件的行不得进入批次，并记录异常。

### 10.4 重试边界

DevOps 取数作为一个完整阶段重试：

```text
OPEN_SESSION
→ OPEN_DMP
→ OPEN_STORY_LIST
→ SELECT_TEAM
→ APPLY_RELEASE_WINDOW
→ FETCH_ALL_PAGES
→ VALIDATE
→ COMMIT_SNAPSHOT
```

由于 pageId 和页面状态相关，不建议从单个 HTTP 请求继续重放。

### 10.5 数据留存

建议保存：

- 取数时间。
- 目标入口标识。
- Scrum 团队 ID、编码、名称。
- 发布窗口。
- DevOps 表单版本。
- 需求标准字段。
- 原始结构化响应的哈希。
- 总页数、总条数和解析条数。
- Runner 版本。

禁止保存：

- Cookie 值。
- CSRF Token。
- 请求签名。
- 下载票据。
- 登录账号密码。

## 11. 当前最大缺口：仓库与分支

本次用户故事列表返回了项目、云、应用、需求编码等字段，但没有代码仓库、分支或 Commit。

用户故事详情同样没有这些字段。因此仅凭：

```text
Scrum 团队 + 发布窗口
```

只能可靠得到需求集合，不能保证得到每条需求应该分析的代码分支。

建议增加以下机制：

### 方案 A：需求编码匹配 Git 分支

为每个 Scrum 团队配置候选仓库，然后在远程分支中搜索需求编码：

```text
PRJ-00774030
feature/PRJ-00774030-*
dev/PRJ-00774030-*
```

匹配到唯一分支则自动使用；没有匹配或匹配多个时转人工确认。

### 方案 B：应用/项目到仓库的配置映射

```text
所属应用 + 所属项目 + 产品组
→ 候选仓库列表
→ 默认基线分支
→ 功能分支命名规则
```

这种方式最适合作为 MVP。

### 方案 C：继续调研任务或代码管理模块

DevOps 中可能在“任务管理”“流水线”或独立代码平台中记录了需求与分支的关系，但不在本次用户故事列表和详情中。若公司流程已经维护此关联，应优先找到正式接口，不要重复配置。

### 推荐顺序

1. 先向团队确认开发分支是否统一包含需求编码。
2. 配置 Scrum 团队到候选仓库的映射。
3. 自动搜索远程分支。
4. 对无结果或多结果提供人工确认页面。
5. 保存人工选择，逐步形成可复用规则。

## 12. 对现有代码评审平台的改造建议

现有 React + Supabase 平台可以保留，新增：

### 管理界面

- DevOps 连接状态。
- Runner 在线状态。
- Scrum 团队同步与选择。
- 仓库和分支规则管理。
- 模型管理。
- 自动化批次创建。
- 执行步骤和错误日志。

### 数据表

- `devops_team_cache`
- `devops_fetch_run`
- `runner_instance`
- `repository_config`
- `story_repository_binding`
- `analysis_run`
- `analysis_task`
- `pipeline_event`

### 批次状态

```text
CREATED
→ WAITING_DEVOPS_LOGIN
→ FETCHING_STORIES
→ VALIDATING_STORIES
→ RESOLVING_REPOSITORIES
→ FETCHING_CODE
→ ANALYZING
→ VALIDATING_RESULTS
→ WAITING_HUMAN_REVIEW
→ COMPLETED
```

## 13. PoC 验收标准

建议先完成一个只覆盖 DevOps 取数的 PoC，验收标准如下：

1. 输入 Scrum 团队和发布窗口。
2. 在登录有效时自动打开用户故事列表。
3. 团队名称能解析为唯一内部 ID。
4. 组合筛选结果和人工页面查询完全一致。
5. 能读取所有分页，不漏行、不重复。
6. 能正确解析描述、负责人、状态、项目、应用、迭代和发布窗口。
7. 登录失效时进入等待登录，而不是无限重试。
8. DevOps 字段变化时明确失败，不生成错误批次。
9. 不在日志和数据库中保存 Cookie、Token、签名或下载票据。
10. 连续执行 10 次，取数条数和需求编码集合一致。

建议在 PoC 连续稳定运行后，再接入 Git 和模型分析。

## 14. 实施建议与工作量

### 阶段 1：DevOps Connector PoC，约 3～5 人日

- 登录检测。
- 页面导航。
- 团队选择。
- 发布窗口过滤。
- 网络响应解析。
- 分页和字段校验。
- 错误截图及脱敏日志。

### 阶段 2：平台与 Runner 联调，约 3～5 人日

- Runner 注册和心跳。
- 平台下发取数任务。
- 登录等待和恢复。
- 批次自动落库。
- 实时步骤展示。

### 阶段 3：仓库与分支解析，约 4～7 人日

- 仓库配置。
- Git 凭证隔离。
- 需求编码匹配分支。
- 远程更新和 Commit 固化。
- 歧义人工确认。

### 阶段 4：模型分析自动化，约 5～8 人日

- 模型管理。
- Prompt 版本管理。
- 代码上下文构建。
- 结构化结果校验。
- 重试、限流和成本记录。

完整稳定 MVP 预计约 3～5 周，最大不确定项不是 DevOps 取数，而是需求到仓库、分支的真实关联规则。

## 15. 最终建议

采用以下决策：

```text
DevOps 取数：浏览器 Runner + 网络响应解析
Excel：保留为审计和人工兜底，不作为主数据通道
登录：复用本地登录态，失效时人工重新登录
接口：不在第一版逆向实现动态签名
分页：按服务端 pagecount 全量读取
字段：基于 dataindex 动态映射并进行契约校验
代码定位：新增团队/项目到仓库映射和需求编码分支匹配
AI 分析：待代码分支解析闭环后接入
```

综合结论：

> DevOps 需求自动取数方案可信，可以进入 PoC 开发；但应采用浏览器 Runner，而不是直接后端重放内部表单协议。全链路自动化仍需先解决需求到代码仓库和分支的映射，不能把这一缺口交给 AI 猜测。
