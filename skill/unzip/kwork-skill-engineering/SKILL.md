---
name: kwork-skill-engineering
description: Use when analyzing, implementing, testing, or debugging Skill features in KWork's tmanage and kdmanage frontends or backends, including skill ZIP packages, import, review, versioning, vendor sync, visibility, duplicate-name behavior, APIs, and UI integration.
whenToUse: 处理 KWork 技能模块需求、代码定位、接口联调、数据排查或 ZIP 包问题时
---

# KWork 技能工程助手

本技能用于处理 KWork 中的技能（Skill）领域需求。核心原则是：**先定位当前调用链，再基于代码与数据给结论；先列影响面，再实施改动；修改后用对应测试或可复现检查验证。**

## 适用范围

- `tmanage-backend`、`tmanage-frontend`：租户侧技能上传、导入、审核、版本、可见性、启停与展示。
- `kdmanage-backend`、`kdmanage-frontend`：平台/原厂技能维护、包校验、审核与向 tmanage 同步。
- 技能 ZIP、`SKILL.md`、`references`、`templates`、`assets/`、`../../../scripts` 的格式与发布问题。

不把 `kwork-server` 当作本技能的主改造范围；只有排查安装/通知等集成问题时，才沿调用链继续追踪。

## 快速路由

| 用户问题 | 先读 | 再定位 |
|---|---|---|
| 不知道代码在哪、前后端怎么联动 | [工程地图](references/01-engineering-map.md) | Controller / 页面 → Service → Mapper / API |
| 原厂、租户、草稿、版本记录混淆 | [领域模型](references/02-domain-model.md) | `tenant_id`、`source_skill_id`、`pending_source_skill_id` |
| 上传、审核、同步、启停行为不符合预期 | [关键流程](references/03-workflows.md) | 入口日志与状态转换 |
| ZIP 被拒、`SKILL.md` 不生效、脚本确认 | [ZIP 契约](references/04-zip-contract.md) | 具体上传/校验入口 |
| 找接口、页面、鉴权通道 | [接口与 UI 地图](references/05-api-and-ui-map.md) | 路由、API 封装、Controller |
| 排查线上/测试问题 | [排障 Runbook](references/06-troubleshooting.md) | 证据、日志、数据库只读查询 |
| 评估改动文件与验证范围 | [改造 Playbook](references/07-change-playbooks.md) | 受影响模块、迁移与测试 |

## 工作流

### 1. 先分类，再读取最小必要上下文

将任务归为以下一种或多种：ZIP、导入、原厂同步、审核/版本、可见性/启停、同名/归属、接口/UI、数据不一致。

1. 先读取上表相应参考资料。
2. 在当前代码中确认 Controller、Service、Mapper/SQL、实体/DTO、前端页面/API 的实际符号。
3. 对跨端结论至少给出一个请求入口和一个最终写入/查询点。
4. 运行时行为、环境配置或数据库现状无法从代码确认时，明确标记“按环境核实”，不要猜测。

### 2. 需求实现前输出影响面

在写代码前，使用 [需求分析模板](templates/requirement-analysis.md) 说明：

- 业务语义与不变量；
- 四端受影响的入口、接口、实体、迁移、前端页面和测试；
- 原厂/租户、主行/草稿行、审核前/审核后是否行为不同；
- API 兼容性、权限与敏感数据影响；
- 需用户确认的破坏性决定。

先搜索并复用已有实现、DTO、组件、Mapper 和测试；不能因为名称相近就假定逻辑相同。

### 3. 排障时坚持证据链

使用 [诊断报告模板](templates/diagnostic-report.md)。按顺序收集：

1. 请求通道、用户/租户上下文、技能名、时间范围与可复现步骤；
2. Controller 入口、Service 分支和带有 `skillId`/`tenantId` 的日志；
3. 相关主行、草稿行、审核/版本/可见性记录的只读数据；
4. 前端请求参数、响应体和 UI 显示条件；
5. 根因、修复点、回归测试与残余风险。

不要把“可能并发”“可能上下文污染”直接写成根因。必须用日志、代码路径或数据记录支持。

### 4. 实施和验证

- 生产代码变更后，用 [实现检查表](templates/implementation-checklist.md) 检查契约、测试、迁移和文档。
- 新增 Controller 方法时，遵循当前项目规则：确认调用方并在方法注解前标注调用方；除流式/SSE/下载或明确约定外，不要跳过统一 `Result<T>` 包装。
- 新增 Flyway 脚本前，扫描目标目录最大版本号并用真实当前时间生成 14 位时间戳；只用 PostgreSQL 语法，不修改已发布迁移。
- 涉及手机号、邮箱、证件、密钥等字段时，优先使用 `manage-sensitive` 的现有能力；不要在业务代码自造脱敏或加密工具。
- 本 ZIP 的上传预检、直接导入和历史兼容路径可能不同。确认具体入口后再判断是否读取流、Base64 或文件服务器转发。

## 高风险边界

- `tenant_id = 0` 是原厂通道/共享记录的关键边界；租户侧同名判断必须看查询是否显式锁定当前 `tenant_id`，不能只看租户拦截器的默认语义。
- `pending_source_skill_id` 非空通常表示已发布主行的待审草稿。判断“存在”或“当前生效”时，先确认查询是否需要排除草稿。
- 原厂与租户同名可以同时存在；不要以名称唯一性替代来源和租户维度判断。
- ZIP 的网络传输使用 `multipart/form-data` 不等于每个业务路径都完全流式。检查是否调用 `getInputStream()`、`getResource()`、`getBytes()` 或旧的 Base64 兼容路径。
- 审核、同步和运行时通知是不同副作用。修改 upsert 内核时，先确认通知责任在入口层还是审核通过事件。

## 常见误判

| 误判 | 正确做法 |
|---|---|
| `exists=false` 表示全局不存在同名技能 | 明确该接口的租户、原厂和草稿语义，再解释结果。 |
| 看到租户拦截器就假定最终 SQL 包含共享数据 | 同时检查 Wrapper 是否显式约束 `tenant_id`。 |
| 测试批量导入能证明正式投稿行为 | 分别核对 `origin`、审核、草稿和通知分支。 |
| “可能并发”可以直接作为根因或立即加锁 | 先用请求时间、日志、数据和唯一约束现状证实竞态。 |
| ZIP 走 multipart 就断言所有路径不使用 Base64 | 从当前 Controller 和 Service 调用链确认具体入口。 |

## 可选环境检查

若当前环境可运行 Node.js，可执行：

```bash
node scripts/check-skill-module-layout.mjs /path/to/kwork
```

脚本只检查预期工程与关键文件是否存在，不读取业务数据、不改动工作区。脚本通过不代表业务逻辑一定正确；仍需按本技能的证据链排查。

## 交付标准

完成时应给出：修改或核查的文件、关键结论的代码证据、执行过的验证、未验证的环境前提，以及仍需用户决定的事项。不要把临时推断表述为已验证事实。
