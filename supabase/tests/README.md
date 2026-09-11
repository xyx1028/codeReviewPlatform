# supabase/tests

数据库最终态回归测试（纯 SQL，不依赖 pgTAP）。这些脚本面向按顺序应用迁移 `0001..0023` 后的 schema，而不是各迁移刚落地时的历史中间态。当前测试文件重点覆盖 `0010`、`0017..0020` 引入并由后续迁移保留的最终契约；`0021..0023` 必须先正常应用。

## 测试文件

- `0010_ai_automation_mvp_test.sql`：最终模型快照、ACP 建单、准备、四仓快照、canonical task claim、claim token 与密钥读取基础链路。
- `0017_agent_execution_engine_test.sql`：claim-token/attempt fencing，Agent commit、fail、retry、finalize 及正式结果落库。
- `0018_execution_engine_admin_actor_test.sql`：删除执行方式切换入口后，`admin_get_model_secret_id` 的显式 actor、无 JWT service-role 调用和角色权限。
- `0019_single_harness_execution_test.sql`：唯一无版本 Worker RPC；旧固定阶段、带版本后缀 RPC 和引擎协商入口不存在；新 Job 固定 ACP、历史 insert/retry fencing、历史来源字段与 Worker overview 三阶段。
- `0020_remove_model_provider_test.sql`：最终模型表无 provider/engine/prompt，provider-free create/update 签名、显式 actor 权限、快照字段和默认请求预算 `120`。

测试文件名沿用对应迁移编号，属于迁移历史标识，不表示当前存在多种执行方式。

每个文件均满足：

- `\set ON_ERROR_STOP on`，任一断言失败立即终止；
- 单个 `BEGIN ... ROLLBACK`，正常结束不留下测试数据；
- 使用独立固定 UUID/周次命名空间；
- 通过 `pg_temp.assert*` 与异常子事务断言，不需要 pgTAP；
- 输出一个唯一成功标记，便于 CI 判定。

## 本地执行

前置条件：本地 Supabase 已启动；使用库属主（通常 `postgres`）连接，因为测试会写 `auth.users`、检查 catalog，并用 `SET LOCAL ROLE` 探测 `authenticated` / `service_role` 权限。

重建本地数据库：

```bash
supabase db reset --no-seed
```

预期迁移从 `0001` 顺序执行到 `0023`。不要对 linked/远端项目执行 reset、push 或测试脚本，也不要为了测试停止本地 Supabase。

### 方式一：宿主机 `psql`

```bash
export TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:54322/postgres'

for test in \
  supabase/tests/0010_ai_automation_mvp_test.sql \
  supabase/tests/0017_agent_execution_engine_test.sql \
  supabase/tests/0018_execution_engine_admin_actor_test.sql \
  supabase/tests/0019_single_harness_execution_test.sql \
  supabase/tests/0020_remove_model_provider_test.sql
do
  psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f "$test" || exit 1
done
```

若本地端口或密码不同，以 `supabase status` 显示的本地数据库连接信息为准。

### 方式二：本地 Supabase 数据库容器

macOS 未安装 `psql` 时可直接使用本地数据库容器：

```bash
for test in \
  supabase/tests/0010_ai_automation_mvp_test.sql \
  supabase/tests/0017_agent_execution_engine_test.sql \
  supabase/tests/0018_execution_engine_admin_actor_test.sql \
  supabase/tests/0019_single_harness_execution_test.sql \
  supabase/tests/0020_remove_model_provider_test.sql
do
  docker exec -i supabase_db_codeReviewPlatform \
    psql -v ON_ERROR_STOP=1 -U postgres -d postgres < "$test" || exit 1
done
```

若项目目录名不同，先通过 `docker ps --format '{{.Names}}'` 确认实际 `supabase_db_*` 容器名。

预期成功标记依次为：

- `ALL_AI_AUTOMATION_MVP_TESTS_PASSED`
- `ALL_AGENT_EXECUTION_ENGINE_TESTS_PASSED`
- `ALL_EXECUTION_ENGINE_ACTOR_TESTS_PASSED`
- `ALL_SINGLE_HARNESS_EXECUTION_TESTS_PASSED`
- `ALL_REMOVE_MODEL_PROVIDER_TESTS_PASSED`
