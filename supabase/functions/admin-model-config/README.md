# admin-model-config Edge Function

管理 AI 模型配置及其 API Key 的短请求 Edge Function。属于 AI 自动化 MVP 的数据库/服务端部分，配合迁移 `0010_ai_automation_mvp.sql`。

## 职责

- 严格校验调用者为已登录的 **ADMIN**（校验 JWT + `user_profile.role = 'ADMIN'`）。
- `create`：写入 Vault 密钥，`ai_model_config` 只保存 secret UUID。
- `update`：更新模型元数据；传入 `api_key` 时轮换密钥（先建新 secret → 更新引用 → 删除旧 secret）；留空表示不轮换。
- `test`：对模型接口发起最小连通性探测（`messages:[{role:'user',content:'ping'}], max_tokens:1`），不携带任何代码或需求。

## 安全约束（强制）

- 绝不打印请求体、API Key、Authorization Header 或 Vault secret 明文。`logEvent` 会过滤含 key/secret/token/authorization/password 的字段。
- 响应体绝不返回 `api_key_secret_id` 或 API Key。
- 密钥写入 Supabase Vault；`ai_model_config` 仅保存 secret UUID。
- 使用完毕立即将局部明文引用置为 `null`。
- 元数据写入失败时回收本次新建的 Vault secret，避免悬挂密钥。

## 依赖的数据库函数（仅授权 `service_role`）

| RPC | 用途 |
|---|---|
| `admin_create_model_config(...)` | 创建模型元数据 + secret 引用 |
| `admin_update_model_config(...)` | 更新元数据 / 轮换 secret 引用（返回旧 secret id） |
| `admin_set_model_enabled(id, enabled)` | 启用 / 停用（前端可直接调用，函数内 `ensure_admin` 兜底） |
| `admin_get_model_secret_id(id)` | 服务端读取 secret id |
| `admin_vault_create_secret(secret, name)` | 写入 Vault，返回 secret UUID（public 包装，避免暴露 vault schema） |
| `admin_vault_delete_secret(secret_id)` | 删除旧 Vault secret（轮换/回滚清理） |
| `admin_get_model_secret_by_config(id)` | 测试连接时读取密钥明文（仅服务端内存） |

本函数使用 `SUPABASE_SERVICE_ROLE_KEY` 调用上述仅 `service_role` 可执行的 RPC。Vault 访问通过 public 包装 RPC 完成，无需向 PostgREST 暴露 `vault` schema。

## 环境变量

由 Supabase 平台自动注入，无需写入镜像或代码库：

```
SUPABASE_URL
SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY
```

## 请求示例

所有请求为 `POST`，需带调用者的 `Authorization: Bearer <user-jwt>`。

创建：

```json
{
  "action": "create",
  "display_name": "Qwen 主账号",
  "provider": "openai-compatible",
  "base_url": "https://api.example.com/v1",
  "model_name": "qwen-max",
  "api_key": "sk-...",
  "max_parallel_tasks": 8,
  "request_timeout_ms": 180000
}
```

更新（轮换密钥，留空 `api_key` 则不轮换）：

```json
{ "action": "update", "id": "<uuid>", "api_key": "sk-new-...", "max_parallel_tasks": 4 }
```

连通性测试：

```json
{ "action": "test", "id": "<uuid>" }
```

响应示例：`{"ok": true, "statusCode": 200}`。响应绝不含密钥。

## 本地开发

```bash
supabase functions serve admin-model-config --env-file supabase/functions/.env.local
```

## 部署

```bash
supabase functions deploy admin-model-config
```
