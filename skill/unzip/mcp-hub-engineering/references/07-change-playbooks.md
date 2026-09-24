# MCP Hub 改造 Playbook

## 1. 新增或修改一种鉴权方式

先跑基线：`bash scripts/check-auth-method-sync.sh <工作区根>`。改完再跑，只应看到自己那几项的变化。

kdmanage 侧首查 `service/mcphub/McpHubService`：`OPEN_AUTH_METHODS`（白名单）、
`normalizeAuthFields`（组合约束，**一律显式抛错**）、`requiresPlatformConnectionTest`、
`requiresToolListOnSave`、`probeStatelessCapability`、下发脱敏 `isOfficialProvider` + `clearOauthFields`、
`maskSecrets`；新值属 OAuth 家族时加进 `McpAuthMethods`；前端同步 `authMethod.ts` 的 `VISIBLE_AUTH_METHODS`。

console 侧首查 `service/McpHubService`：`validateImportedAuthProvider`（导入侧二次校验，
跨系统不能只信上游）、`requiresTenantInstance` 与 `requiresTenantInstanceForCredentials`
（**取值刻意不同**）、`extractOfficialCredentialsToPlatformInstance`；
再看 `McpCredentialsV2Service`（**最容易漏**）、`McpHubProductToolsService.credentialScopeOf`、
`McpPublishedToolInvocationService.runtimeHeaders`、前端 `mcpServiceAccess.ts`。

**新分支必须插在静态凭据循环之前** —— 那个循环只收 `HEADER` 位置，落到它就是静默失败。
凭据选对 `param_location`：`HEADER` / `URL_PARAM` 是要发出去的；`AK_SK` 三项与 `OAUTH` 四项
是「拿去换 token」的输入，混进 `HEADER` 会让每个读取方都得先摘出去。

**开放任何新值前先确认它在 V2 有分支**，否则就是 `AK_SK` 现在的状态（详见 04）。

## 2. 新增 MCP 字段或状态

影响面：实体、DTO/VO、Mapper/SQL、Flyway、下发 payload、`importFromBackend`、
`ensurePlatformInstance`、前端类型/表单/列表、i18n、测试。

- 新增 Flyway 文件名必须用真实当前时间生成的 **14 位**时间戳，且大于目录最大版本；
- 只用 PostgreSQL 语法（`COMMENT ON`、`CREATE INDEX`），不用 MySQL 的内联 `COMMENT` / `MODIFY COLUMN`；
- **不改已发布迁移**，修正另建新迁移；
- **tmanage 的迁移必须同时进升级补丁包**（`src/main/patch` 文件 + `datamodel.xml` 登记双份），
  改完跑 `.kiro/scripts/check-tmanage-patch-mirror.sh`，五项全 0 才算过；kdmanage 不走补丁包；
- 确认字段是否需要跨端同步、版本快照、i18n 覆盖，以及目录级还是实例级；
- 「探测结论」类字段按三态存（`null` / `0` / `1`）+ 配 `*_probed_at`，两列都标 `updateStrategy=ALWAYS`。

## 3. 给 Harness bundle 加协议字段

**至少 3 处**，只改 1 处必然漏：

1. `McpHubProductToolsService.toLegacyBundle`（`clusterCode` 形态）；
2. `McpHubProductToolsService.toErpAccountBundle`（`mcpInstanceId` 形态，`enableErpAccount=true` 走它）——
   **两处字段集必须一致**，否则带不带该参数会返回不同结构；
3. `McpHubProductToolsAggregationService.withTenantCredentialScope`（`kderp` / `lingee` 走这里，
   **当前硬编码** `credentialScope="tenant"` + `statelessCapable=true`，不要照抄这个风格）。

另需确认：Mapper 投影 SQL 带上该列；字段源头在 kdmanage 时走一遍下发链路。
backend 与 open 两个入口共享聚合服务，第 3 处改一次两个入口都生效。

口径：**显式给值不要让字段缺失**（让调用方少一个分支，也让「console 已支持」在响应里可见）；
三态只在出 bundle 时压平；相互独立的字段（`credentialScope` 与 `claimsScope`）不要互相推导。

加字段时问一句：调用方在没有这个字段时会怎么猜？猜错的失败点离真实原因有多远？
离得远的必须补字段（`serverType` 当初就是这么加的）。

## 4. 改动灵基身份链路

唯一判据是 `McpHubService.requiresLingeeIdentitySelection`
（`need_lingee_identity == 1 && !isOfficialProvided`），**8 个决策点**全部走它，不允许在别处重写：
卡片单条路径、`detail`、`requiresTenantConfiguration`、`displayLingeeIdentitySelectedKeys`、
`saveIdentitySelection` 早退、`publishAsTool` 拒绝、**卡片批量/分页路径**、`instanceSchema`。
归档文档的「7 个决策点」清单漏了分页那处，只改单条会让列表页与分页结果不一致。

运行时三处判据当前**有一处不一致**：`ToolService.resolveHubLingeeIdentity` 是
`INTERNAL || containsOfficialProvider`，而 `McpHubProductToolsService.claimsScopeOf`
**只有** `containsOfficialProvider`。当前不可复现（`kderp`/`lingee` 走聚合层、`INTERNAL` 行拿不到实例），
但**新增第三条平台预置渠道时会立刻暴露**。

免确认时 `selectedKeys` 必须传 `null`（语义是**全选**），且**不要求授权行存在**。
免确认后启用弹窗不会打开，所以详情弹窗必须能只读展示身份项，否则租户从「先看后勾」退化成「看不到」。

签名：`isKderpMcp` **只认字面量 `kderp`**，不要把新渠道加进去（租户 ERP RSA 密钥只属于 kderp）。
新渠道改算法只改目录行 `identity_sign_alg` 这一列。Console **不签 JWT**，只下发签名材料。

前端 `mcpServiceAccess.ts` 必须同口径，否则出现「前端给确认入口、后端抛无需启用」的死角。

## 5. 新增个人凭据载体

**默认建新表**，除非形状和校验规则与某张现表完全一致。Bearer 只有一个 `Authorization` 且强制前缀；
API Key 是目录声明的 N 个裸值 Header，两者校验规则无法共用，且 Bearer 那张表**已发布禁止改结构**。

改动点：迁移建表（唯一键含 `user_id`，带 `mcp_code` / `verified_at` / `status`）→ 实体与 Mapper
（密文列**不挂 TypeHandler**，由 `EnvelopeCrypto` 处理）→ `McpPersonalAuthController` 加
`GET`（渲染表单）+ `POST`（提交）一对 → `McpPersonalAuthService`（票据校验 → 表单校验 →
**实时 `tools/list` 验证** → 加密落库 → 写审计）→ `McpCredentialsV2Service` 加分支 →
`OAuthTokenLog` 加 `operate_type` → 迁移服务按 `fsecret_type` 分流 → 老链路注入分支。

协议不给有效期的载体**不要凭空加 `expires_at`**，失效用 `status` 表达，读取侧带 `status = 1`。

## 6. 最小验证矩阵

| 改动 | 至少验证 |
|---|---|
| kdmanage Service/Controller | 新建该方式的 MCP 能测通、清单非空且有 `visible` 项、能提审下发 |
| 下发脱敏 | 非 OFFICIAL 时 console 目录行的秘密 value 已清空、只剩 key 模板 |
| console 实例与发布 | 按 `requiresTenantInstance` 预期走通「启用 → 测试连接 → 发布」 |
| **Harness V2** | `success=true`，核对 `authCarriers.headers` / `gotToken` / `oauthSchema.type` |
| 老链路 | `mcp-published-tool/mcp-tools/call` 也通 |
| bundle 字段 | backend + open 两入口、两种 bundle、分页版、三类 MCP（普通 / `kderp` / `lingee`） |
| 灵基身份 | 非 OFFICIAL 未确认时拒绝发布；OFFICIAL 免确认且详情可只读看到身份项；存量脏勾选行仍显示全选 |
| 个人凭据 | 错误凭据被 `tools/list` 拦住不落库；票据重放与换浏览器都被拦；换用户拿不到别人凭据 |
| Flyway | 文件名 14 位、大于目录最大版本、PG 语法、幂等；tmanage 另跑 patch mirror 自检 |
| 前端 | TypeScript 构建、对应 Vitest 用例、与后端判定同口径 |
| 存量回归 | 老数据仍能读、能编辑（保持原值）、能下发 |

完整实施前先填 [需求分析模板](../templates/requirement-analysis.md)，
完成后逐项勾选 [实现检查表](../templates/implementation-checklist.md)。
