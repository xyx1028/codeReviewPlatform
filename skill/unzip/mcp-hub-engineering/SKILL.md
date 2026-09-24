---
name: mcp-hub-engineering
description: Use when analyzing, implementing, testing, or debugging MCP Hub features across KWork's kdmanage and tmanage frontends and backends, including auth methods, param providers, catalog sync, tenant instances, credentials, personal authentication, lingee identity JWT, Harness tool catalog bundles, and tool list refresh.
whenToUse: 处理 MCP Hub 需求、代码定位、鉴权方式改动、凭据链路排查、灵基身份或 bundle 字段问题时
---

# MCP Hub 工程助手

本技能用于处理 KWork 中 MCP Hub 领域的需求。核心原则是：**这条链路的失败形态大多是静默的 —— 不报错、只是某个分支不生效，所以先确认一共有几处判据、再确认每处都碰到了；改完用对应测试或可复现检查验证。**

## 适用范围

- `kdmanage-backend`、`kdmanage-frontend`：MCP Hub 运营侧维护、连接测试、版本审核、上下架与向 console 下发。
- `tmanage-backend`、`tmanage-frontend`：console 目录、租户实例与凭证、发布为工具、个人认证页、灵基身份、Harness/build 对外接口。
- 数据库：`t_kdmanage_mcp*`、`t_tmanage_mcp*`、`t_tmanage_mcp_user_*`、`t_user_oauth` 及派生工具两张表。

不把 `kwork-server` 当作本技能的改造范围；它是**只读参考实现**，只在排查个人凭据迁移、安装通知等集成问题时沿调用链继续追踪。

## 快速路由

| 用户问题 | 先读 | 再定位 |
|---|---|---|
| 不知道代码在哪、四端怎么联动 | [工程地图](references/01-engineering-map.md) | Controller / 页面 → Service → Mapper / API |
| 目录、实例、凭证、派生工具分不清 | [领域模型](references/02-domain-model.md) | `tenant_id`、`mcp_code`、`mcp_instance_id`、`source_mcp_code` |
| 下发、启用、发布、刷新行为不符预期 | [关键流程](references/03-workflows.md) | 入口日志与状态转换 |
| 某鉴权方式配得出来但调不通 | [鉴权方式矩阵](references/04-auth-methods.md) | `OPEN_AUTH_METHODS` 与 V2 分支 |
| 找接口、页面、鉴权通道 | [接口与 UI 地图](references/05-api-and-ui-map.md) | 路由、API 封装、Controller |
| 排查线上/测试问题 | [排障 Runbook](references/06-troubleshooting.md) | 证据、日志、数据库只读查询 |
| 评估改动文件与验证范围 | [改造 Playbook](references/07-change-playbooks.md) | 受影响模块、迁移与测试 |

## 工作流

### 1. 先分类，再读取最小必要上下文

将任务归为以下一种或多种：鉴权方式、参数归属、下发同步、租户实例与凭证、个人凭据、灵基身份、bundle 协议字段、工具清单刷新、数据不一致。

1. 先读取上表相应参考资料。
2. 在当前代码中确认 Controller、Service、Mapper/SQL、实体/DTO、前端页面/API 的实际符号。
3. 对跨端结论至少给出一个请求入口和一个最终写入/查询点。
4. 运行时行为、环境配置或数据库现状无法从代码确认时，明确标记「按环境核实」，不要猜测。

### 2. 需求实现前输出影响面

在写代码前，使用 [需求分析模板](templates/requirement-analysis.md) 说明：

- 业务语义与不变量；
- 四端受影响的入口、接口、实体、迁移、前端页面和测试；
- `OFFICIAL` / `ADMIN` / `PERSONAL` 三种归属是否行为不同；平台行与租户行是否行为不同；
- 老链路（`mcp-published-tool`）与 Harness V2 是否都要改；
- API 兼容性、权限与敏感数据影响；
- 需用户确认的破坏性决定。

先搜索并复用已有判定方法（如 `McpAuthMethods.isOAuthFamily`、`requiresLingeeIdentitySelection`），**不要在别处重写同一判据**。

### 3. 排障时坚持证据链

使用 [诊断报告模板](templates/diagnostic-report.md)。按顺序收集：

1. 走的是哪条链路（Harness V2 / 老兼容接口 / build open 接口）、租户与用户上下文、`mcpCode`、时间范围；
2. Controller 入口、Service 分支和带 `mcpCode` / `mcpInstanceId` 的日志；
3. 目录行、平台实例行、租户实例行、凭证行、用户凭据行的只读数据；
4. 前端请求参数、响应体和 UI 显示条件；
5. 根因、修复点、回归测试与残余风险。

**`success=false` 的消息常常指错方向** —— 例如 `MCP credential is not configured` 的真实原因可能是 V2 不支持该载体。不要把错误文案直接当根因。

### 4. 实施和验证

- 生产代码变更后，用 [实现检查表](templates/implementation-checklist.md) 检查契约、测试、迁移和文档。
- 新增 Flyway 脚本前，扫描目标目录最大版本号并用真实当前时间生成 **14 位**时间戳；只用 PostgreSQL 语法，不修改已发布迁移。
- **tmanage 的迁移必须同时进升级补丁包**（`src/main/patch` 文件 + `datamodel.xml` 登记双份），改完跑 `.kiro/scripts/check-tmanage-patch-mirror.sh`；kdmanage 不走补丁包。
- 涉及凭证、密钥时复用现有加密能力：实例凭证走 AES TypeHandler，用户个人凭据走 `EnvelopeCrypto`（ENV2），不要自造。
- 改鉴权方式后跑 `scripts/check-auth-method-sync.sh`。

## 高风险边界

- `tenant_id = 0` 同时表示「平台共享目录行」和「OFFICIAL 的平台级实例/凭证行」。写路径必须用 `findTenantInstance`（显式带租户），读路径用 `resolveEffectiveInstance`（租户行优先、回落平台行）；不能用无 `ORDER BY` 的 `LIMIT 1`。
- `param_providers = OFFICIAL` 按约定**同时蕴含「服务端也是金蝶自营」**，灵基身份因此免租户确认。把服务端在第三方的 MCP 标成 OFFICIAL 会造成静默的隐私外泄。见 steering `mcp-official-implies-kingdee-hosted`。
- 「能不能新配」与「运行时能不能用」是两个独立维度。`AK_SK` 当前**已在开放白名单但 Harness V2 没有分支**，配出来走 V2 必然失败。
- `stateless_capable` 是三态（`null` 没探过 / `0` 有状态 / `1` 可无状态）。库里必须保留三态，只在出 bundle 时压成 `false`。
- 已发布表禁止破坏性变更（删列、改类型、改名、缩长度）。`t_tmanage_mcp_user_bearer` 已发布，禁止改结构。见 steering `db-migration-forward-only`。
- 派生工具行持有凭证副本，停用实例后旧密钥仍在该行。改凭证流向时要一并考虑这份副本。

## 常见误判

| 误判 | 正确做法 |
|---|---|
| 只看 `auth_method` 就判断凭证由谁填 | 必须同时看 `param_providers`；同一个 `BEARER` 在 OFFICIAL 与 PERSONAL 下行为完全不同。 |
| `gotToken=false` 表示凭证没配好 | 它是「凭据是否就绪」的闸门。`NONE` 恒 `true`；要和 `success` 一起读。 |
| `NONE` 表示不发任何请求头 | 真实语义是「不额外注入 Authorization」，目录 `headers_json` 的静态头照样发出去。 |
| 纯 `PERSONAL` 不需要租户实例 | 需要 —— 实例是**工具清单的归属锚点**；但它不落任何凭证行。两个判定取值刻意不同。 |
| 在 kwork 走得通的 OAuth 配置在 console 也走得通 | 两侧 PKCE 默认取向相反：kwork 兜底策略默认发 PKCE，console 只有 `OAUTH2_PKCE` 才发。 |
| 改了 `McpHubProductToolsService` 就覆盖所有 bundle | `kderp` / `lingee` 走聚合层 `withTenantCredentialScope`，是另一条路径。 |
| 「可能并发」「可能缓存」可以直接作为根因 | 先用日志、代码路径、数据记录与唯一约束现状证实。 |

## 可选环境检查

若当前环境可运行 Node.js：

```bash
node scripts/check-mcp-module-layout.mjs /path/to/MCP_Hub
```

只检查预期工程与关键文件是否存在，不读业务数据、不改工作区。

改动鉴权方式后再跑（需 bash，从工作区根执行）：

```bash
bash scripts/check-auth-method-sync.sh /path/to/MCP_Hub
```

它校验前后端开放白名单是否一致、有没有只认 `OAUTH2` 的单值判断、白名单里的值在 V2 有没有分支。脚本通过不代表业务逻辑正确，仍需按本技能的证据链排查。

## 交付标准

完成时应给出：修改或核查的文件、关键结论的代码证据、执行过的验证、未验证的环境前提，以及仍需用户决定的事项。不要把临时推断表述为已验证事实。
