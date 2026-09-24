# MCP Hub 关键流程

## 1. 下发同步：kdmanage → console

触发点只有四个：审核通过（先结算 `expires_at` 再 POST）、手工 `resync`（仅已上架，**不续期**）、
`McpHubToolRefreshJob` 刷到变化后自动 resync、普通下架 / 真正删除。草稿保存与驳回不下发。

**没有定时对账或重试任务**，打开开关不会自动补发历史数据，必须逐条 `resync`。所以 `PUBLISHED` ≠ 已下发。

接收端 `McpHubService.importFromBackend` 顺序：

1. 以 `mcpCode` 获取导入锁；
2. 校验 AK/SK 只能是单一 `OFFICIAL` 或单一 `ADMIN`（`validateImportedAuthProvider`），`PERSONAL` 与混合值拒收；
3. 按 `providerCode` upsert 供应商 → 按 `typeCode` upsert 类型并解析**本侧** ID；
4. 按 `mcpCode` upsert 目录主行，历史软删行**按原 id 复活**（保证派生工具的 `mcp_id` 引用不断）；
5. `OFFICIAL` 时把真值搬进平台实例 + 凭证行 —— **必须在主行落库之后**（平台行需要目录行 id）；
6. 同步工具、i18n、版本、租户范围；
7. `PERSONAL` 时清理不再合法的租户凭证。

`view_count` 是 console 行为数据，**导入不得覆盖**。`enabled` 不下发（共享目录上的开关会变成全租户开关）。

### 子表三态语义不一致，别按同一条规则理解

| 子表 | 缺失/null | `[]` | 非空数组 |
|---|---|---|---|
| `tools` | 保留 | **物理删除清空** | delete 后全量重建 |
| `i18n` | 保留 | 删除后仍补 `zh-CN` 兜底行，**不会真空** | 按 locale 去重重建，缺 `zh-CN` 补兜底 |
| `versions` | 保留 | 无动作 | 按 `version_no` upsert，**从不删除** |

工具只发 `visible=1`，所以关闭某个工具后重新下发会从 console 目录移除它。AK/SK 恒发 `tools=[]`。

## 2. 租户启用实例

| 组合 | 要启用吗 | 落凭证吗 |
|---|---|---|
| `OFFICIAL`（含 AK/SK、客户端凭证） | 否，直接发布 | 平台凭证行已就绪 |
| `ADMIN`（含 AK/SK） | 是 | 是，填本企业凭证 |
| 纯 `PERSONAL` | **是**（清单锚点） | **否** |
| `PERSONAL` + OAuth 授权码 | 是，配 Client（四项全可选、可自动发现） | 存 OAuth Client |
| 客户端凭证 + `ADMIN` | 是，**三项必填** | 是 |

客户端凭证三项必填是硬校验：缺任一项 100% 换不到 token，必须当场拦住。

**重新启用会复活软删行**（`selectLatestIdIncludingDeleted` + `reviveById`）保持 `instanceId` 稳定；
复活只置 `is_deleted=0`，**不恢复任何业务字段与状态**，避免带着过期凭证诈尸。

**0 工具的实例在「启用」这一步就被前端拦住**（`McpInstanceEnableModal`）。放在启用而非发布，
是因为发布报错时管理员已经离开那个弹窗了。这道**只能在前端** —— `enableInstance` 那一刻后端拿不到工具数，
首次启用时那次测试的清单必然已被丢弃（清单要按 `mcp_instance_id` 落，而实例行是 `enableInstance` 才创建的）。

## 3. 发布为工具的四道守卫

1. **一个可运行接口都没有就拒绝**（`rejectPublishWithoutRunnableResource`），**没有「只告警放行」这一档**；
2. 0 工具实例在启用时已被拦（见上）；
3. 灵基身份未确认时拒绝（非 OFFICIAL 且 `need_lingee_identity=1`）；
4. `tool_code` 冲突拒绝 —— 派生编码就是 `mcpCode`（截断 60），与既有普通工具同名会撞唯一索引。

发布按「当前目录 + 当前有效实例」**整组重写**连接配置：有效实例 = 租户行优先、回落平台行。
`OAUTH` 位置的凭证行必须**显式还原到 Tool 的 OAuth 专用列**，落进 `headersJson` 会让 client_id/secret
被当请求头发出去、而换 token 环节拿不到值。派生行 5 个 OAuth 列都标 `updateStrategy=ALWAYS`，
否则清空动作进不了 SQL（dev 曾出现 `oauth_client_id` 残留 `'0'` 且重发也刷不掉）。

## 4. 取消发布

「取消发布」与「我的工具」手动停用共用 `deactivateDerivedTool`：`enabled=0` + 写 `disable_reason`，
行与资源都保留，并调 `notifyToolDeactivateOrThrow` 把 kwork 既有安装置 inactive；
通知失败（404 除外）向上抛并回滚。两个入口唯一区别是停用原因。

单元路由下游异常被包成 `CellFanoutException`，必须先 `unwrapDownstream` 再按状态码分类 ——
否则 kwork 的 404（本就没有安装记录）会被当系统异常抛成 500。

## 5. 工具清单定时刷新：四条任务，cron 两两错开

| 任务 | 位置 | 分钟 | 目标 |
|---|---|---|---|
| `PublishedToolResourceRefreshJob` | kdmanage | 0、30 | 工具管理线 `t_kdmanage_tool` |
| `McpHubToolRefreshJob` | kdmanage | 20、50 | MCP Hub `t_kdmanage_mcp_tool`，**只管 OFFICIAL**，刷完自动 resync |
| `McpToolCatalogRefreshJob` | console | 5、35 | 租户实例清单（ADMIN / PERSONAL + OFFICIAL 平台行到租户资源表的投影） |
| `ToolResourceRefreshJob` | console | 15、45 | 工具管理线自建工具资源 |

**源头必须由 kdmanage 侧刷**：链是三段的（`t_kdmanage_mcp_tool` → console 平台行 → 各租户资源表），
console 只能对齐后两段。少了 `McpHubToolRefreshJob`，后两段对齐的只是一份旧快照。
反过来 ADMIN / PERSONAL 平台侧探不到（凭证在租户/用户手上），只能由 console 刷。

要点：增量合并（按 `tool_name` 比对，不冲掉 `visible` 勾选）；轮转游标按「最久没刷的排前面」；
游标推进口径是**「尝试过」就推进**（否则永远探不通的目标会卡住队首）；只刷「本地已有清单行」的实例
（清单为空说明从未探通，首次获取应是管理员显式动作）。

## 6. 个人认证（console 托管）

V2 返回 `success=false` + `redirectUrl` → 用户打开 console 认证页 → 凭一次性票据免登录 →
提交后**实时 `tools/list` 校验** → 按用户 ENV2 加密落库 → 写 `t_oauth_token_log` 审计 → 调用方重新拉 V2。

安全机制全部在 `McpPersonalAuthService`，Redis key 都是**分钟级 TTL**：票据、浏览器绑定、
会话标识、CSRF、提交限流、提交锁。排查时扫不到 key 是正常的，且真实 key 带 namespace 前缀（dev 上是 `dev:`）。

⚠️ 认证页搬到 console 后 **postMessage 会静默失效** —— console 用自己 redirect-uri-base 推出的 origin，
与 kwork 前端不同源，浏览器直接丢弃消息。不能只依赖它通知。
