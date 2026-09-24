# 接口与 UI 地图

## 1. kdmanage 运营通道

前缀 `/api/v1/mcps`：分页、详情、新建、更新、删除、`submit-review`、`unpublish`、`resync`、
`versions`、`next-version`、`connection-test`、`aksk-connection-test`、`tool-test`、
`tools/{mcpToolId}/visibility`、`hub/stats`、`hub/type-counts`、`check-name`、`check-code`、
`icon/upload`、`tenant-options`，以及三个敏感项查看 `server-url/reveal`、`headers/reveal`、`url-params/reveal`。

类型前缀 `/api/v1/mcp-types`，供应商前缀 `/api/v1/mcp-providers`。

权限根 `environment.mcp_hub`，叶子 `view` / `create` / `update` / `delete` / `submit` / `unpublish`。
**敏感项查看除 `view` 外还要二次密码校验**，普通详情接口只返回掩码。

AK/SK 的连接测试**分两条路**：新建态走通用 `connection-test`（从 `headersJson` 取运营刚输入的明文），
编辑态走 `aksk-connection-test`（appSecret 加密存库、前端只有掩码）。

## 2. console 租户通道

前缀 `/api/mcp-service`：`GET /page`、`/category-counts`、`/sources`、`/{mcpCode}`、`/{mcpCode}/versions`、
`POST /{mcpCode}/view`、`POST /{mcpCode}/publish-as-tool`、`DELETE /{mcpCode}/published-tool`、
`POST /instance/enable`、`DELETE /{mcpCode}/instance`、`GET /{mcpCode}/instance/schema`、
`POST /connection-test`、`POST /oauth-discovery`。

我的工具前缀 `/api/my-tool`：`GET /page`、`GET /{id}`、`PUT /{id}/toggle-enabled`。

权限复用 `tmanage.mcp_hub`：`view`（查询）、`publish-as-tool`（实例启停、凭证、连接测试、发布）、
`unpublish`（撤销发布及我的工具启停）。

`instance/schema` 只返回 key 结构，逐项带 `sensitive` 与 `configured`。
**AK/SK 按归属分流**：`ADMIN` 返回 `AK_SK` 位置三项，`OFFICIAL` 一项都不返回（凭证在平台共享行里）。
客户端凭证不返回 Redirect URI（没有用户跳转，给了会误导运营去 IdP 注册）。
详情的 `serverUrlDisplay` 只保留地址主体、**去掉整个 query**（OFFICIAL 的密钥可能拼在 query 里）。

## 3. 对外：Harness（服务端，HMAC）

| 接口 | 用途 |
|---|---|
| `GET /api/backend/tenants/{tenantTid}/product-tools/mcphub`（+ `/page`） | 工具目录 bundle |
| `POST /api/backend/mcp-token/v2/mcp/credentials` | 凭据 V2 |
| `POST /api/backend/tool/lingee-identity` | 灵基身份签名材料 |
| `POST /api/backend/mcp-published-tool/mcp-tools/list` / `call` | 老兼容接口 |

`/api/backend/**` 由 `UnmaskHeaderInterceptor` 返回**原文**（kwork 需要真值）。
请求日志对 `mcp-published-tool/mcp-tools/**` 整段禁记 Body。

## 4. 对外：build（用户 Token，无 HMAC）

build 客户端拿不到也不应该拿到 HMAC 密钥，所以只用 `/api/open/**`：

| 接口 | 用途 |
|---|---|
| `POST /api/open/auth/token/code` → `/exchange` | 宿主签发一次性 code（10 分钟、一次性），build 换 `tua1_` Token |
| `GET /api/open/mcp-tools/mcphub`（+ `/page`） | 工具目录，**注意 `enableErpAccount: true` 才有 `mcpInstanceId`** |
| `POST /api/open/mcp/credentials` | 换凭据 |
| `POST /api/open/mcp/lingee-identity` | 身份头（由 console 代签，不下发私钥） |
| `GET /api/open/mcp/catalog-version` | 游标，变化后重新拉目录 |

鉴权必须用 `TENANT_USER` 而非 `TENANT_APP` —— 后者 `userId` 来自创建应用 Token 时绑定的固定用户，
而个人凭据三张表唯一键均含 `user_id`，用应用态会让**全租户共用同一份个人凭据**。

Token 失效表现为 **HTTP 401**，响应体是 `{"code":…,"message":…}`，不是业务层 `Result` 结构
（这一层由 Filter 返回，不走全局异常处理）。

open 版与 backend 版**共享** `McpHubProductToolsAggregationService`，聚合逻辑一致。
open 通道另有 `McpHubOpenAccessGate` 开关（非沙箱 namespace 且开关未开时跳过工具查询）。

## 5. 前端页面与判定入口

| 页面 / 文件 | 关注点 |
|---|---|
| `kdmanage-frontend/src/pages/McpHubPage.tsx` | 列表、卡片、操作 |
| `McpCreateDialog.tsx` / `McpUpdateDialog.tsx` | 鉴权方式下拉（存量值临时补入并标注）、清单校验 |
| `McpHubDetailModal.tsx` | 详情。**当前有一处 `=== 'OAUTH2'` 单值判断残留** |
| `components/mcp-hub/authMethod.ts` | `VISIBLE_AUTH_METHODS`、`OAUTH_FAMILY`、清单校验同口径函数 |
| `tmanage-frontend/src/pages/McpServicePage.tsx` | MCP 服务卡片。停用实例带二次确认 |
| `components/McpInstanceEnableModal.tsx` | 启用弹窗。**0 工具在这里被拦** |
| `utils/mcpServiceAccess.ts` | `requiresLingeeIdentitySelection` 等，**与后端必须同口径** |

卡片文案已定稿：「发布为工具」→ **添加连接器**，「取消发布」→ **取消连接器**，
启用态四种文案统一为 **启用MCP**，编辑态四种统一为 **更新MCP**。
