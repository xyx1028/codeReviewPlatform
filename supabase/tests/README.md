# supabase/tests

数据库最终态回归测试（纯 SQL，不依赖 pgTAP）。这些脚本面向按顺序应用迁移 `0001..0032` 后的 schema，而不是各迁移刚落地时的历史中间态。当前测试文件重点覆盖 `0010`、`0017..0020` 引入并由后续迁移保留的最终契约、`0027` 的 V4 全能力默认开启契约，以及 `0032` 的 V1.5 真实运行监控台契约；`0021..0032` 必须先正常应用。

## 测试文件

- `0010_ai_automation_mvp_test.sql`：最终模型快照、ACP 建单、准备、四仓快照、canonical task claim、claim token 与密钥读取基础链路。
- `0017_agent_execution_engine_test.sql`：claim-token/attempt fencing，Agent commit、fail、retry、finalize 及正式结果落库。
- `0018_execution_engine_admin_actor_test.sql`：删除执行方式切换入口后，`admin_get_model_secret_id` 的显式 actor、无 JWT service-role 调用和角色权限。
- `0019_single_harness_execution_test.sql`：**历史文件，已不在常规执行清单内，不要修改它。**
  它写在 `0031` 之前，用裸 `insert into public.analysis_job (...)`（不带
  `capability_policy_snapshot`）造 fixture；`0031` 给该表加了
  `freeze_v4_job_manifest_and_policy_hash` 这个 `before insert` 触发器后，这种造法会以
  `V4_CAPABILITY_POLICY_MISSING` 中止。文件保持原样作为当时那一版契约的记录，它覆盖的
  最终态断言由 `0031_manifest_freeze_and_worker_overview_test.sql` 用 0031 之后仍然成立的
  fixture 方式重新覆盖。
- `0020_remove_model_provider_test.sql`：最终模型表无 provider/engine/prompt，provider-free create/update 签名、显式 actor 权限、快照字段和默认请求预算 `120`。
- `0028_tree_digest_excludes_status.sql` 无独立测试文件：它只替换 `analysis_agent_tree_digest`，
  相关契约（摘要与节点状态无关、且与 TypeScript 侧逐字一致）在
  `0027_v4_harness_all_capabilities_test.sql` 里断言。
- `0027_v4_harness_all_capabilities_test.sql`：V4 全能力默认开启契约——`policy_version = 4` 任务领取、能力 policy 默认全开、Agent Tree 新表（`analysis_agent_node`/`analysis_tool_audit`/`analysis_permission_decision`/`analysis_session_checkpoint`/`analysis_artifact`）的约束与 RLS、唯一提交权与 Evidence origin 约束、Session checkpoint 只存 locator/hash 不存原文。
- `0029_platform_default_capability_policy.sql` 无独立测试文件：平台默认 policy 由
  `0027_v4_harness_all_capabilities_test.sql` 断言。
- `0031_manifest_freeze_and_worker_overview_test.sql`：`0031` 的冻结契约——缺少
  `capability_policy_snapshot` 的 `policy_version = 4` 插入 fail closed、`enqueue` 冻结 active
  manifest 身份与 canonical policy hash、冻结后 manifest/policy hash/`execution_engine` 均不可变、
  claim 创建的 run 继承 Job 冻结的 policy hash；并接续覆盖 `0019` 中与 fixture 造法无关的最终态
  断言（新 Job 固定 ACP、legacy 插入被挡、历史 legacy Job 不能 retry 且值仍可读、
  `admin_list_analysis_workers()` 只有 PREPARING / AGENT / FINALIZING 三阶段且不再暴露引擎协商元数据）。
- `0032_analysis_runtime_monitoring_test.sql`：V1.5 真实运行监控台契约——事件表 `analysis_runtime_event` 的
  幂等（同一 `event_uuid` 重试只产生一行、投影只更新一次）、Job 层与 Task 层分层 fencing、lineage 未解析
  丢弃计数、payload allowlist（prompt/command/api_key/绝对路径落库后不存在）、`event_day` 与时钟钳制的
  确定性、当前活动投影的单调与 correlation 配对、终态清投影 + 未闭合 correlation 补写
  `TOOL_CALL_CANCELLED`、`xact_id` 提交水位裁剪与 30 秒逃生阀、`get_analysis_runtime_console` 的权限
  （ADMIN / 批次创建者 manage 语义）、`analysis_agent_run_rollup` 的归因等式
  （`setup + busy_union + teardown + unattributed = wall`）与 `tool_ms_sum > tool_ms_union`、汇总幂等与
  `rollup_version = 0` 补算、保留期清理不触及汇总表、三个诊断 RPC 不授予 `authenticated`、
  `get_analysis_run_trend` 分组维度白名单；
  §1.2 的 14 个 AI 诊断问题**逐条**断言（每条都指向 §6.10 某个 RPC 的具体字段，不是纸面声明）；
  §10.4 对 `get_analysis_runtime_console` 与 `get_analysis_attempt_diagnostics` 的**整份 DTO**
  做禁止键名 + 敏感内容形态双重扫描（键名按 `"key":` 精确匹配，避免把合法的
  `prompt_version` 误判成 prompt 正文）；
  §6.7 的单页 500 条上限与 `has_more` / `next_event_id` 语义；
  `unattributed_ms / wall_ms > 0.4` 时 `HIGH_UNATTRIBUTED_TIME` 主动报出并给出
  机器可读的 `instrumentation_gaps`；
  事件被清理之后跨运行趋势查询仍然可用（事件是可丢的细节，汇总是不可丢的基线）。

测试文件名沿用对应迁移编号，属于迁移历史标识，不表示当前存在多种执行方式。
历史测试文件一旦落库就不再修改：schema 演进使某个历史 fixture 造法失效时，新增测试文件承接它的最终态断言，并在上面标注被谁接续。

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

预期迁移从 `0001` 顺序执行到 `0032`。不要对 linked/远端项目执行 reset、push 或测试脚本，也不要为了测试停止本地 Supabase。

### 方式一：宿主机 `psql`

```bash
export TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:54322/postgres'

for test in \
  supabase/tests/0010_ai_automation_mvp_test.sql \
  supabase/tests/0017_agent_execution_engine_test.sql \
  supabase/tests/0018_execution_engine_admin_actor_test.sql \
  supabase/tests/0020_remove_model_provider_test.sql \
  supabase/tests/0027_v4_harness_all_capabilities_test.sql \
  supabase/tests/0031_manifest_freeze_and_worker_overview_test.sql \
  supabase/tests/0032_analysis_runtime_monitoring_test.sql
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
  supabase/tests/0020_remove_model_provider_test.sql \
  supabase/tests/0027_v4_harness_all_capabilities_test.sql \
  supabase/tests/0031_manifest_freeze_and_worker_overview_test.sql \
  supabase/tests/0032_analysis_runtime_monitoring_test.sql
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
- `ALL_REMOVE_MODEL_PROVIDER_TESTS_PASSED`
- `ALL_V4_HARNESS_CAPABILITY_TESTS_PASSED`
- `ALL_MANIFEST_FREEZE_AND_OVERVIEW_TESTS_PASSED`
- `ALL_ANALYSIS_RUNTIME_MONITORING_TESTS_PASSED`

`0019_single_harness_execution_test.sql` 不在这份清单里：见上文「测试文件」一节的说明。
历史测试文件与历史迁移一样不修改；契约变化通过新增测试文件承接。
