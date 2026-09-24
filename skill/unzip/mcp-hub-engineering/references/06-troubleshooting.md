# MCP Hub 排障 Runbook

## 通用取证顺序

1. **先确认走的是哪条链路** —— Harness V2（`mcp-token/v2/mcp/credentials`）、老兼容接口
   （`mcp-published-tool/**`）、还是 build 的 open 接口。三条链路对同一 MCP 的支持度不同。
2. 记下 `mcpCode`、`mcpInstanceId`、`tenantId`、`userId` 与时间范围。
3. Controller 入口 → Service 分支 → Mapper/SQL，沿路看带 `mcpCode` / `mcpInstanceId` 的日志。
4. 只读查数据：目录行 → 平台实例行 → 租户实例行 → 凭证行 → 用户凭据行 → 派生工具行。
5. 前端请求参数、响应体与 UI 显示条件。
6. 给出根因、修复点、回归测试与残余风险。

非 dev 库（`_sit` / `_uat` / `_biz` / `_fi` / `_i18n`）默认只读，写操作先取得确认。
库清单与账密口径见 steering `db-environments-and-migration-versioning`。

## 错误文案会指错方向

| 看到的 | 可能的真实原因 |
|---|---|
| `MCP credential is not configured` | V2 不支持该载体（`AK_SK` / `URL_PARAM` 落到只收 HEADER 的静态凭据循环被静默跳过），**不是运营没配** |
| `MCP personal credential header name is not configured` | 早期实现读了实例凭据表，而纯 PERSONAL 的实例凭据行一律为空；Header 名应只从目录行 `headers_json` 取 |
| `gotToken=false` | 对 `NONE` 是异常（它恒 `true`）；对其他方式表示凭据未就绪，要和 `success` 一起读 |
| 「授权完成却拿不到结果」 | 强制 PKCE 的服务配成了 `OAUTH2`（只有 `OAUTH2_PKCE` 发 `code_challenge`） |
| `DOWNSTREAM_SERVER_ERROR: 令牌非法` | 云之家拿错了服务：用了 SSO token（29 位）而非委托授权 accessToken（32 位） |
| `UNAUTHORIZED: gateway authority denied` | 云之家 token 合法但接口没开权限，与上一条性质完全不同 |
| `400 Session ID missing` | 把「没探过」当成「可无状态」，跳过了 `initialize` 握手 |
| 取消发布报 500 | `CellFanoutException` 未解包，kwork 的 404 被当系统异常 |

## 静默失败的六个常见形态

**工具在 Harness 里发现不到**：先看实例是否 `ENABLED`，再看 `t_tmanage_mcp_tool` 有没有**绑该
`mcp_instance_id`** 的行。Harness 优先取实例行，无实例行才回退平台模板；纯 PERSONAL 不随目录下发清单，
清单只能由 console 侧测试连接实拉。

**bundle 字段缺失或恒为默认值**：确认该 MCP 走的是 `toLegacyBundle`、`toErpAccountBundle`
还是聚合层 `withTenantCredentialScope`（`kderp` / `lingee` 走后者，且**含硬编码**）。
另确认 Mapper 投影 SQL 带上了该列 —— 实体里恒 null 是最容易漏的。

**某实例全部工具失败且与凭证无关**：查 `serverType`。实例表没有这一列，租户把 `server_url`
覆盖成 SSE 端点时 bundle 里的协议仍是目录值，失败点在传输层。

**身份项「展示与实际下发不一致」**：`displayLingeeIdentitySelectedKeys` 在免确认时必须返回 `null`
（全选）且**不读授权表**。照读会把实际会下发的 `mail` / `phone` 显示成「不下发」。
存量常留着该 MCP 还是 ADMIN / PERSONAL 时期的勾选行。

**反复弹认证页 / V2 查不到绑定**：个人凭据分错表（Bearer 类进 `t_tmanage_mcp_user_bearer`、
API Key 类进 `t_tmanage_mcp_user_api_key`）；或迁移时按三列去重而 API Key 唯一键是四列（含 `param_key`）；
或读取侧漏了 `status = 1` 过滤。

**改了配置但不生效**：DDL 手工执行过导致 `flyway_schema_history` 与仓库脚本失配、后续脚本被静默跳过；
或迁移版本号撞上另一分支已应用的版本（Flyway 判定「已应用」→ 静默跳过，日志无线索）。

## Redis 排查两个坑

**key 带 namespace 前缀**：`NamespacePrefixKeySerializer` 给所有 key 透明加 `{kwork.namespace}:`。
代码里写 `mcp:personal-auth:x`，Redis 里实际是 `dev:mcp:personal-auth:x`。
按字面前缀扫会稳定命中 0 个，看起来像「功能没生效」。

**MCP 认证类 key 全是短 TTL**：票据、绑定、CSRF、锁、OAuth state 都在分钟级，用完即删。
空闲时扫出 0 个是正常的，必须先触发一次流程再在窗口内扫。

只用 `SCAN`（`redis-cli --scan --pattern`）+ `GET` / `TTL` / `TYPE`。
这台 Redis 是多环境共用，`FLUSHDB` / `KEYS *` 一律禁止。

## 加解密相关

**解密失败会静默返回原文**：`CryptoUtils.decrypt` 失败时原样返回，所以坏密文（密钥轮换、跨环境拷数据、
密文截断）会被当明文用下去，下游报错与密钥毫无关联。

**AK/SK AppSecret 有四处落点、加密口径不统一**：kdmanage 明文 → console 目录列（受开关控制、当前明文）
→ 实例凭证行（强制 AES）→ 派生工具 `headers_json`（强制 AES）。排查时先确认读的是哪一处。

**用户凭据层用 ENV2 而非透明 AES**：为与 kwork-server `CryptoUtil` 逐字节兼容，迁移可原样搬密文。
MEK 两侧共用 `kwork.tool.secret-encrypt-key`，换它会让两侧全部存量密文失效。

## 只读核对 SQL 的起点

```sql
-- 目录行与归属
SELECT mcp_code, mcp_status, auth_method, param_providers, need_lingee_identity,
       stateless_capable, server_type
FROM t_tmanage_mcp WHERE mcp_code = ? AND is_deleted = 0;

-- 平台行与租户行并存情况（注意 tenant_id=0 是平台行）
SELECT id, tenant_id, instance_status, connection_tested, stateless_capable, is_deleted
FROM t_tmanage_mcp_instance WHERE mcp_code = ?;

-- 实例清单行 vs 平台模板行
SELECT mcp_instance_id, count(*) FROM t_tmanage_mcp_tool
WHERE mcp_id = (SELECT id FROM t_tmanage_mcp WHERE mcp_code = ? AND is_deleted = 0)
GROUP BY mcp_instance_id;

-- 迁移是否真的应用了
SELECT version, description, success FROM flyway_schema_history ORDER BY version DESC LIMIT 20;
```

不要把「可能并发」「可能缓存」直接写成根因，必须用日志、代码路径或数据记录支持。
