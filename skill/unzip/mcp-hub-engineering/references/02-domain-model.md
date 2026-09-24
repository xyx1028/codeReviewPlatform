# MCP Hub 领域模型与边界

## 1. 核心记录

```text
t_kdmanage_mcp（运营维护）
   │ 审核通过 → POST /api/backend/mcp-service/import
   ↓
t_tmanage_mcp（console 目录，tenant_id=0，租户只读）
   ├─ OFFICIAL：导入时把真值搬进平台级实例 + 凭证行（tenant_id=0，全局一条）
   ├─ 租户启用 → t_tmanage_mcp_instance（tenant_id=租户）+ t_tmanage_mcp_instance_credential
   │     └─ 测试连接拉清单 → t_tmanage_mcp_tool（绑 mcp_instance_id）
   │           └─ Harness 经 /product-tools/mcphub 直接发现并调用   ← 当前主链路
   └─ 租户发布 → t_tmanage_tool（source_mcp_code 非空）+ t_tmanage_tool_resource
         └─ kwork 经 /api/backend/tool/** 消费                      ← 旧链路，仍在跑
```

**「发布为工具」与 Harness 的实例发现是两套概念**：只要实例已启用且有实例工具清单，
`/product-tools/mcphub` 就会返回它，不要求先写入 `t_tmanage_tool`。

跨系统幂等一律用业务编码：`mcp_code` / `type_code` / `provider_code` / `tenant_code`。
对端主键只写进 `source_*_id` 供排查，**不得作为本侧外键**。

## 2. 两个正交维度，缺一个就会判错

| 维度 | 字段 | 表达什么 |
|---|---|---|
| 鉴权方式 | `auth_method` | 凭证长什么样、怎么注入 |
| 参数提供方 | `param_providers` | 凭证**由谁填**（CSV，含 `OFFICIAL` / `ADMIN` / `PERSONAL`） |

| 提供方 | 下发时 | console 侧谁来补 |
|---|---|---|
| `OFFICIAL` | 原样下发 | 不用补，搬进**平台级**凭证行，全租户共用一份 |
| `ADMIN` | **清空秘密 value**，只发地址与 key 结构 | 租户启用实例填本企业凭证 |
| `PERSONAL` | 保留 key、value 强制清空 | **终端用户**逐人提供（V2 下由 console 托管收集） |

`param_providers` 现实现是两个 contains 判断，所以 `OFFICIAL,ADMIN` 能表达「官方默认 + 租户覆盖」，
但**表达不了「Header A 官方、Header B 个人」** —— 要那种粒度就是协议变更。

## 3. console 侧五层与租户归属

```text
平台共享层  tenant_id=0 / data_scope=0(VENDOR)
  目录主表与子表、OFFICIAL 的平台实例行与平台凭证行（全局一条）
租户实例层  tenant_id=租户 / data_scope=8(TENANT)
  ADMIN、客户端凭证+ADMIN、以及全部 PERSONAL 的实例行与凭证行
租户身份选择层
  t_tmanage_mcp_lingee_identity_selection，每租户每 mcp_code 一行，与实例生命周期无关
用户凭据层  tenant_id + user_id
  t_tmanage_mcp_user_bearer / t_tmanage_mcp_user_api_key / t_user_oauth / t_oauth_token_log
租户发布层  tenant_id=租户
  t_tmanage_tool（source_mcp_code 非空）+ t_tmanage_tool_resource
```

`TierTenantInnerInterceptor` 对标了 `@NeedProviderScope` 的表：SELECT 放宽为
`(tenant_id = 0 OR tenant_id = ?)`，UPDATE/DELETE 保持严格 `tenant_id = ?` —— 即「全局一份、租户只读」。

因此 `disableInstance` 只作用于租户行，取不到就直接返回；**误取平台行会一行都改不到却静默成功**。

## 4. 四个容易混淆的边界

**实例凭据 vs 用户凭据**：`t_tmanage_mcp_instance_credential` 是租户/平台**管理员**配的，一个实例一份；
用户凭据层按 `(tenant_id, user_id, mcp_instance_id)` 隔离。**`PERSONAL` 的凭据一律不进实例凭据表** ——
`enableInstance` 明确拒绝 PERSONAL 提交实例凭证并清掉残留行。

**要不要启用实例 vs 要不要落凭证**：两个判定分工不同，纯 `PERSONAL` 非 OAuth 的取值刻意不同 ——
`requiresTenantInstance` 为 `true`（实例是**工具清单的归属锚点**），
`requiresTenantInstanceForCredentials` 为 `false`。早期两者同一个实现，导致 PERSONAL 跳过启用直接发布，
发布出的工具运行时无资源可调。

**`t_tmanage_mcp_tool` 的两级**：`tenant_id=0 + mcp_instance_id=NULL` 是平台共享模板；
租户实测行绑实际实例。实例行唯一索引 `(mcp_instance_id, tool_name) WHERE mcp_instance_id IS NOT NULL`
是**条件索引**，平台模板行不参与。Harness 优先取整组实例行，无实例行才回退平台模板。

**`is_deleted` 只用于真正删除**：平台普通下架只把 `mcp_status` 标 `OFF_SHELF`，目录、实例、凭证、
派生工具全部保留，用户现有工具继续运行。软删行不占部分唯一索引，允许停用后复活或重新发布。
