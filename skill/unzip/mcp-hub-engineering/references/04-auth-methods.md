# 鉴权方式矩阵

## 1. 「能不能新配」与「运行时能不能用」是两个独立维度

判断某个方式能不能跑，必须分开查这两列。

| `auth_method` | 能新配 | Harness V2 | 老链路 `mcp-published-tool` |
|---|---|---|---|
| `NONE` | ✅ | ✅ 恒 `gotToken=true` | ✅ |
| `BEARER` | ✅ | ✅ `buildPersonalBearerItem` | ✅ |
| `OAUTH2` | ✅ | ✅ | ✅ |
| `OAUTH2_PKCE` | ✅ | ✅ 发 `code_challenge` | ✅ |
| `YZJ_OAUTH` | ✅ | ✅ `buildYzjItem` | ✅ |
| `AK_SK` | ✅ | ❌ **无分支，静默失败** | ✅ Gateway 分支 |
| `API_KEY` | ❌ 不在选项内 | ✅ `buildPersonalApiKeyItem`（console 托管） | ✅ |
| `URL_PARAM` | ❌ | ❌ 不支持该载体 | ✅ |
| `OAUTH2_CLIENT_CREDENTIALS` | ❌ | ❌ 未编排 | ❌ |

## 2. `AK_SK` 当前是一个真实缺口

`OPEN_AUTH_METHODS` 由 `fceb1044 feat(mcp-hub): 开放 AK/SK 鉴权方式` 放开，前后端都是 6 项一致。
但 `McpCredentialsV2Service` **没有 AK_SK 取值分支** —— 全文件只有 `schemaType()` 里一个
`case "AK_SK" -> "aksk"` 字符串映射。

V2 分支顺序：

```text
isOAuthAuthMethod       → OAuth
AUTH_YZJ_OAUTH          → buildYzjItem
PERSONAL && BEARER      → buildPersonalBearerItem
PERSONAL && API_KEY     → buildPersonalApiKeyItem
其余                     → 静态凭据循环，只收 HEADER 位置
```

AK/SK 的凭据在 `AK_SK` 位置，落到最后一支被静默跳过 → `headers` 为空 → `success=false` +
`MCP credential is not configured`。

**净效果**：运营按正常流程就能配出一个「kdmanage 连接测试通过、工具清单也拉到了、
Harness 一调就报凭据未配置」的 MCP。出路二选一：给 V2 补分支，或从两处白名单同时撤回只留存量。

## 3. 组合约束显式抛错，绝不静默改写

`normalizeAuthFields` 对非法组合一律抛错：

- `AK_SK` 只允许单一 `OFFICIAL` 或单一 `ADMIN`，**禁止 `PERSONAL`** —— 换回来的
  `cosmic_mcp_token` 是应用级凭证，且运行时接口只有一个 `token` 入参，承载不了 appId + appSecret 两项；
- OAuth 授权码两种模式强制 `PERSONAL`；
- OAuth 客户端凭证只允许单一 `OFFICIAL` / `ADMIN`；
- `PERSONAL` 只允许 `URL_PARAM` / `BEARER` / `YZJ_OAUTH` / OAuth 授权码。

**为什么不静默改写**：把 ADMIN/PERSONAL 悄悄换成 OFFICIAL，等于把调用方提交的租户/个人密钥
当官方密钥原样下发给所有租户。

## 4. 白名单两处必须同步

后端 `McpHubService.OPEN_AUTH_METHODS`，前端 `kdmanage-frontend/src/components/mcp-hub/authMethod.ts`
的 `VISIBLE_AUTH_METHODS`。前端只是少让运营踩错，绕过界面由后端 `requireOpenAuthMethod` 兜底。

**不在集合里 ≠ 失效**：它只拦「把 auth_method 改成未开放值」，存量行的读取、下发、运行时分流照原样走。
`auth_method` 列上**没有** CHECK 约束（给已发布列加约束属破坏性变更，且存量必须能读写）。

编辑存量时后端按「值是否变更」判定：保持原值可继续维护，切到另一个未开放值才拒绝；
前端会把当前值临时补进下拉并标注「存量」，所以从存量方式迁到开放方式这条正当路径是通的。

## 5. 两档授权码必须同时开放

`OAUTH2`（授权码，不带 PKCE）与 `OAUTH2_PKCE`（+ `code_challenge_method=S256`）的差别是**真实报文**
而非文案。console 侧 `McpOAuthService` 只有 `OAUTH2_PKCE` 才发 `code_challenge`，
所以强制 PKCE 的服务（如 Notion MCP）配成 2.0 会「授权页跳得通、用户能登录、换 token 必被拒」，
界面只表现为「授权完成却拿不到结果」，定位成本极高。

曾以「报文只差一个字段，不必让运营区分」为由只开一档并标成「OAuth 2.1」，正因如此撞上 Notion。

**三个 OAuth 值按运行时行为编码，不按协议版本** —— 2.1 授权码与 2.0 授权码 + PKCE 发出去完全相同，
报文里没有版本声明字段。所以**不需要** `oauth_protocol_version` / `oauth_grant_type` / `oauth_pkce_mode`
这类补偿列。

## 6. 判定必须收口

全仓 `== "OAUTH2"` 等值判定曾有 92 处。细分出 `OAUTH2_PKCE` 后一律换 `McpAuthMethods.isOAuthFamily`
（后端）/ `isOAuthFamily`、`OAUTH_FAMILY`（前端），否则新值**静默**落到非 OAuth 分支 —— 不报错，只是不生效。
**禁止在业务代码里散写三值 or 判断。**

当前已知残留一处：`kdmanage-frontend/src/pages/McpHubDetailModal.tsx` 用 `=== 'OAUTH2'` 控制
「OAuth 2.1 配置」提示块，于是 `OAUTH2_PKCE` 的 MCP 详情里这块不显示，且标题文案与判据错位。

## 7. 别拿 kwork-server 反推 console

两侧 PKCE 默认取向**相反**：

| | 默认发 PKCE 吗 | 依据 |
|---|---|---|
| kwork-server | **是** | 策略工厂按 `toolCode` 精确匹配，未注册回落 `CommonOAuthStrategy`，其 `usePkce()` 返回 true |
| console | **否** | 由 `auth_method` 显式指定 |

同一个第三方在 kwork 走得通、在 console 走不通，这个差异是首要怀疑点。

## 8. `NONE` 的两条契约

**`gotToken` 恒 `true`**：代码是 `setGotToken(none || hasCredential)`。它是「凭据是否就绪」的闸门，
不是「有没有凭据」—— 无鉴权本就没有要注入的凭证，回 `false` 会被 Harness 判成「凭证没拿到」而拒绝调用。

**headers 不一定为空**：真实语义是「不额外注入 Authorization」，不是「不发任何头」。
`buildHeaders(headersJson)` 无条件执行。前端选 `NONE` 时只是不渲染 Headers 面板，**后端不校验**，
绕过界面给 `NONE` 带 `headersJson`，那些头会被存下、下发、并照发出去。

**别用 `NONE` 代替云之家**：云之家 `tools/list` 免鉴权但 `tools/call` 必须带用户 token，
不带直接返回 `USER_TOKEN_INVALID`。云之家配 `YZJ_OAUTH`。

## 9. `YZJ_OAUTH` 的两个服务名字极像、用途完全不同

| 服务 | 端点 | 返回 | 长度 | 用途 |
|---|---|---|---|---|
| `MCPTokenService.getYZJToken(Long)` ✅ | `getDelegatedAccessToken` | `data.accessToken` | 32 位 | **调 API 的凭证** |
| `YZJTokenService.getYZJToken(String,String)` ❌ | `acqcode` → `acqssoinfo`（DES） | `data.token` | 29 位 | 免登跳转 SSO token，网关不认 |

拿错会得到 `DOWNSTREAM_SERVER_ERROR: 令牌非法`；而正确链路同一用户回的是
`UNAUTHORIZED: gateway authority denied`（token 合法但接口没开权限）。两种性质完全不同的错误。

换不到 token 时 `success=false` 且**不返回 `redirectUrl`** —— 云之家没有可跳转的授权页。
