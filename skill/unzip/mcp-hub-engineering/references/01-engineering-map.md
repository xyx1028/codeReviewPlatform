# MCP Hub 工程地图

## 1. 阅读顺序

1. 先判断在说四个面里的哪一个（下节），名字相近但归属不同；
2. 再沿「kdmanage 运营 → 下发 → console 目录 → 租户实例 → 对外接口」定位；
3. 最后确认调用方走的是 Harness V2、老兼容接口还是 build 的 open 接口。

## 2. 四个面，别混着讲

| 面 | 位置 | 主表 | 有「发布」这一步吗 |
|---|---|---|---|
| ① 平台工具管理 | kdmanage `/tools` | `t_kdmanage_tool` | 无，审核通过下发即可用 |
| ② **MCP Hub** | kdmanage `/mcp-hub` | `t_kdmanage_mcp` | 无（下发到 console 目录） |
| ③ console 工具管理 | tmanage `/tool` | `t_tmanage_tool`（`source_mcp_code IS NULL`） | 无 |
| ④ **MCP 服务 / 我的工具** | tmanage `/mcp-service`、`/my-tool` | `t_tmanage_mcp` → `t_tmanage_tool` | **有，且有前置校验** |

本技能只管 ② 和 ④。①③ 作对照系出现时会显式标注。

名字相近但**不属于** MCP Hub：`t_kdmanage_mcp_service`（独立 MCP Service 实例管理）、
`t_kdmanage_mcp_connector_type`、`t_kdmanage_mcp_app` / `t_tmanage_mcp_app`、
`t_tmanage_mcp_toolset`（旧工具集配置）、`t_tmanage_tool_tenant_credential`（工具管理线的租户凭证表）。

## 3. kdmanage 后端关键符号

目录 `kdmanage-backend/kdmanage-backend/src/main/java/com/kingdee/kwork/manage/`：

| 符号 | 职责 |
|---|---|
| `controller/.../McpController` | `/api/v1/mcps` 全部入口 |
| `service/mcphub/McpHubService` | 主 Service。`OPEN_AUTH_METHODS`、`normalizeAuthFields`、`requireOpenAuthMethod`、`requiresPlatformConnectionTest`、`requiresToolListOnSave`、`probeStatelessCapability`、`clearOauthFields`、`maskSecrets` |
| `service/mcphub/McpAuthMethods` | 鉴权方式判定收口：`isOAuthFamily` / `isAuthorizationCode` / `isClientCredentials` / `isPkceEnabled` |
| `service/mcphub/McpAkSkAuthSupport` | AK/SK 签名与 Gateway 寻址 |
| `service/McpClientService`（**不在 mcphub 子包**） | 连接测试、`tools/list`、`Mcp-Session-Id` 探测 |
| `service/McpEnterpriseResourceSyncService`（**不在 mcphub 子包**） | MCP 独立下发，不改工具管理线的下发 Service |
| `job/McpHubToolRefreshJob` | 已上架 OFFICIAL 清单定时刷新 + 自动 resync |

前端 `kdmanage-frontend/src/`：`pages/McpHubPage.tsx`、`McpCreateDialog.tsx`、`McpUpdateDialog.tsx`、
`McpHubDetailModal.tsx`、`components/mcp-hub/authMethod.ts`（`VISIBLE_AUTH_METHODS`、`OAUTH_FAMILY`）。

## 4. tmanage(console) 后端关键符号

目录 `tmanage-backend/tmanage/src/main/java/com/kingdee/kwork/tmanage/`：

| 符号 | 职责 |
|---|---|
| `service/McpHubService` | console 主 Service。`importFromBackend`、`extractOfficialCredentialsToPlatformInstance`、`enableInstance`、`disableInstance`、`publishAsTool`、`requiresTenantInstance`、`requiresLingeeIdentitySelection` |
| `service/McpCredentialsV2Service` | **Harness V2 凭据**。`buildYzjItem` / `buildPersonalBearerItem` / `buildPersonalApiKeyItem`，其余落静态凭据循环 |
| `service/McpHubProductToolsService` | bundle 构造：`toLegacyBundle` / `toErpAccountBundle`、`credentialScopeOf`、`claimsScopeOf` |
| `service/McpHubProductToolsAggregationService` | 聚合层。ERP/独立部署 bundle 走 `withTenantCredentialScope`（**含硬编码**） |
| `service/McpPersonalAuthService` | console 托管个人认证页：票据、CSRF、限流、提交锁 |
| `service/McpOAuthService` | OAuth 授权码全流程、刷新、解绑 |
| `service/McpCredentialMigrationService` | 从 kwork 迁入个人凭据 |
| `service/McpPublishedToolInvocationService` | 老兼容接口的运行时注入 |
| `service/McpToolCatalogRefreshService` + `task/McpToolCatalogRefreshJob` | 租户实例清单定时刷新 |
| `identity/McpLingeeIdentityResolver` | 身份项求值、`parseSelectedKeys`、`dependsOnCurrentUser` |
| `service/ToolService` | `resolveHubLingeeIdentity`、签名策略与密钥选择、`isKderpMcp` |

前端 `tmanage-frontend/src/`：`pages/McpServicePage.tsx`、`components/McpInstanceEnableModal.tsx`、
`utils/mcpServiceAccess.ts`（与后端同口径的 `requiresLingeeIdentitySelection`）。

## 5. 只读参考：kwork-server

已有一套「工具级」个人凭据与 OAuth 实现，MCP Hub 是把同样能力重新落到 console，寻址口径从工具换成 MCP 实例。
读它对照协议细节；**不要为 MCP Hub 需求改它**。两侧 `t_user_oauth` 同名不同构、不同库。
详见 steering `kwork-server-mcp-auth-reference`。

## 6. 配套文档

`MCP Hub/` 下按用户故事组织：`设计/架构与数据流.md`、`设计/表设计.md`、`用户故事/PRJ-*.md`、
`接口/`（导航层，无出入参）、`归档/`（**全量出入参在这里**，四份接口文档共 29 个 JSON 示例）。
