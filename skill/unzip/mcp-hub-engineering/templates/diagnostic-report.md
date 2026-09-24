# MCP Hub 诊断报告

## 现象与复现

- 报错文案原文：
- 走的链路：Harness V2 / `mcp-published-tool` 老接口 / build open 接口
- `mcpCode` / `mcpInstanceId` / `tenantId` / `userId`：
- 时间范围与环境（host + 库名）：
- 可复现步骤：

> 提醒：错误文案常指错方向。`MCP credential is not configured` 的真实原因可能是 V2 不支持该载体。

## 证据链

| 层 | 查了什么 | 结论 | 证据 |
|---|---|---|---|
| Controller 入口 |  |  |  |
| Service 分支 |  |  |  |
| 目录行 `t_tmanage_mcp` |  |  |  |
| 平台实例行（`tenant_id=0`） |  |  |  |
| 租户实例行 |  |  |  |
| 凭证行 / 用户凭据行 |  |  |  |
| 工具清单行（实例行 or 平台模板） |  |  |  |
| 派生工具行 |  |  |  |
| 前端请求/响应 |  |  |  |

## 排除项

- [ ] 不是 V2 缺载体分支（静态凭据循环只收 `HEADER`）
- [ ] 不是平台行/租户行取错（`findTenantInstance` vs `resolveEffectiveInstance`）
- [ ] 不是清单挂在平台模板而非实例行
- [ ] 不是 Redis key 漏了 namespace 前缀 / 短 TTL 已过期
- [ ] 不是迁移被静默跳过（`flyway_schema_history` 与仓库脚本失配）
- [ ] 不是解密失败静默返回原文

## 根因与修复

- 根因（必须有代码路径或数据记录支持）：
- 修复点：
- 回归测试：
- 残余风险与未验证前提：

> 不要把「可能并发」「可能缓存」直接写成根因。
