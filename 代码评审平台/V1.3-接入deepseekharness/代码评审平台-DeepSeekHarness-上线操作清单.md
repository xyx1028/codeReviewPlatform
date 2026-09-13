# 代码评审平台 V3 - 单 DeepSeek Harness 上线操作清单

> 适用版本：`@deepseek-ai/dsh@0.1.5-rc.1` + `@agentclientprotocol/sdk@1.4.0`
> 架构基准：同目录 `DEEPSEEK_HARNESS_REFACTOR_PLAN.md`
> 数据库最终基线：按顺序应用 `0001..0023`
> 重要：平台只有 DeepSeek Harness ACP 一种审核方式，没有执行方式切换或旧链路回退。

本文是当前可执行 runbook。所有远端迁移、生产部署和缩扩容操作均需负责人确认；本地验收成功不等于远端已经发布。

## 0. 发布影响与前置确认

`0019_single_harness_execution.sql` 会：

- 将尚未结束的历史旧任务封存为 `LEGACY_ENGINE_RETIRED`；
- 删除已退役运行入口、固定阶段 RPC 和带版本后缀的 Worker RPC；
- 删除模型执行方式、旧 prompt 配置、Worker 引擎能力/协议字段；
- 重建唯一 canonical Worker API；
- 强制所有新 Job 使用 DeepSeek Harness ACP。

`0020_remove_model_provider.sql` 会删除模型 `provider` 并更改模型管理 RPC 签名。`0021..0023` 继续补充批次创建人、模型删除约束及 Vault secret 原子清理。

因此发布是**数据库 + Edge Function + 前端 + Worker**的协调升级。应用 `0019` 后，依赖旧接口的 Worker 镜像不能继续运行。

发布前必须确认：

- [ ] 已备份数据库或具备可验证的恢复点；
- [ ] 已确认在途历史任务的封存影响；
- [ ] 已准备与最终 schema 匹配的 Worker、Edge Function 和前端制品；
- [ ] 已保留一个与 `0019+` canonical API 兼容的上一个 Worker 镜像；
- [ ] 已安排 1 个 Worker、1 个小 Job 的真实 smoke test。

## 1. 本地发布门槛

### 1.1 重建最终 schema

```bash
supabase db reset --no-seed
```

预期：迁移从 `0001` 顺序执行到 `0023`，无错误结束。

### 1.2 数据库回归

本机若有 `psql`：

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

没有宿主 `psql` 时可使用本地 Supabase 数据库容器：

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

预期标记：

```text
ALL_AI_AUTOMATION_MVP_TESTS_PASSED
ALL_AGENT_EXECUTION_ENGINE_TESTS_PASSED
ALL_EXECUTION_ENGINE_ACTOR_TESTS_PASSED
ALL_SINGLE_HARNESS_EXECUTION_TESTS_PASSED
ALL_REMOVE_MODEL_PROVIDER_TESTS_PASSED
```

### 1.3 应用构建与测试

```bash
npm run worker:typecheck
npm run worker:build
npm run test:worker
npm run build
npm run lint
```

真实 ACP 集成测试需要满足测试文件定义的环境开关和本地 Harness 条件；普通测试跳过它们不等于容器内真实模型验证已完成。

### 1.4 残留检查

确认生产源码与部署配置中：

- 不存在按执行方式分派的 Worker；
- 不存在固定检索/分析 pipeline；
- 不存在带版本后缀的 Worker RPC 调用；
- 不存在 Worker 引擎集合或协议版本环境变量；
- 模型页面没有执行方式/provider/旧 prompt 配置；
- Worker 页面只显示 `PREPARING / AGENT / FINALIZING`。

历史迁移、历史 Job 来源字段和明确归档的排障记录可以保留，不应误判为当前执行入口。

## 2. 远端发布步骤

### 步骤 1：只读核对迁移状态

```bash
supabase migration list --linked
supabase db push --linked --dry-run
```

人工确认待应用文件、目标项目、备份和维护窗口。不要根据本文假设远端已到某个迁移编号。

### 步骤 2：经批准后应用迁移

```bash
supabase db push --linked
supabase migration list --linked
```

应用后先不要恢复大流量。检查日志，确认 `0019..0023` 中实际待发布的迁移均按顺序完成。

### 步骤 3：部署模型管理 Edge Function

```bash
supabase functions deploy admin-model-config
```

最终 Function 必须：

- 使用无 provider、无执行方式参数的模型管理 RPC；
- 以显式 `p_actor_id` 校验管理员；
- 更新密钥时只在服务端处理 Vault secret；
- 删除模型时依赖 `0023` 在数据库事务内同时删除配置与 secret；
- 不把 API Key、Authorization 或数据库错误对象写入响应/日志。

### 步骤 4：构建并发布前端

```bash
npm run build
```

页面验证：

- 模型管理页没有执行方式和 provider 选择；
- Agent 参数始终可见，默认总模型请求预算为 120；
- 自动分析只显示代码准备、Agent 审核、结果汇总语义；
- Worker 管理页没有引擎能力或协议版本列；
- 历史旧任务若展示，明确标记为不可恢复且不能重试。

### 步骤 5：构建 Worker 镜像

```bash
docker compose -f docker-compose.worker.yml build
```

镜像必须包含：

- `dist-worker/`；
- DeepSeek Harness 与 ACP 精确依赖；
- `worker/harness/code-review-acp/` profile 模板；
- volatile session、budget governor、review control、snapshot tools 插件；
- `git` 与 `rg`；
- 非 root `worker` 用户。

不要配置或恢复任何“支持引擎列表/协议版本”变量。所有副本运行同一 Harness profile。

### 步骤 6：目标网络连通性检查

在权限为 `0600` 且不进入版本库的环境文件中准备 Worker/Supabase/Git 凭据，然后使用正式镜像执行：

```bash
chmod 600 /secure/path/worker-connectivity.env
docker run --rm \
  --env-file /secure/path/worker-connectivity.env \
  codereviewplatform-worker:latest \
  npm run worker:check-connectivity
```

成功条件：Git 白名单、Supabase/Vault 和最小模型 `ping` 均成功，退出码为 0。模型探针直接请求 `chat/completions` 仅用于连通性，不代表生产审核绕过 Harness。

### 步骤 7：单副本 smoke test

```bash
docker compose -f docker-compose.worker.yml up -d --scale worker=1
docker compose -f docker-compose.worker.yml ps
docker compose -f docker-compose.worker.yml logs worker
```

创建 1 个小 Job，核对：

- Job 完成 `PREPARING_CODE → PROCESSING → FINALIZING → SUCCEEDED`；
- Task 完成 `PENDING → RUNNING → SUCCEEDED`；
- Worker 页面只出现 `PREPARING / AGENT / FINALIZING`；
- `analysis_agent_run` 有请求/工具/压缩摘要；
- 最终 Evidence 的 repository、Commit、blob、path、range 可核对；
- 模型只看到四个只读工具和 `submit_review_result`；
- attempt 结束后没有残留 socket、profile、Session JSONL 或源码副本；
- 日志中没有 API Key、claim token、源码和模型完整响应。

### 步骤 8：逐步扩容

```bash
docker compose -f docker-compose.worker.yml up -d --scale worker=4
```

默认 4 副本 × 2 槽位，理论 Worker 容量为 8；同一模型的实际上限仍受 `max_parallel_tasks` 约束。扩容期间观察模型 RPM/TPM、请求预算、Task lease、失败率和清理结果。

## 3. 最终数据库核对

在只读会话中检查：

```sql
-- 新 Job 默认且只允许 Harness；历史来源字段仍可读。
select column_default
from information_schema.columns
where table_schema = 'public'
  and table_name = 'analysis_job'
  and column_name = 'execution_engine';

-- 模型配置不再含执行方式、provider 或旧 prompt 字段。
select column_name
from information_schema.columns
where table_schema = 'public'
  and table_name = 'ai_model_config'
  and column_name in (
    'execution_engine', 'provider',
    'retrieval_prompt_version', 'analysis_prompt_version'
  );
-- 期望 0 行

-- Worker 心跳不再含引擎能力/协议版本字段。
select column_name
from information_schema.columns
where table_schema = 'public'
  and table_name = 'analysis_worker_heartbeat'
  and column_name in ('supported_engines', 'protocol_version');
-- 期望 0 行

-- 不应存在带版本后缀或已退役阶段 RPC。
select proname
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and (
    p.proname like '%\_v2' escape '\'
    or p.proname in ('save_retrieval_result', 'save_analysis_result', 'fail_story_task')
  );
-- 期望 0 行
```

不要删除 `analysis_job.execution_engine`：它承担已完成历史 Job 的来源审计，但不参与新任务配置。

## 4. 故障处理与回滚

### 4.1 不允许的操作

- 不把模型配置“切回”另一种执行方式；最终 schema 中没有该入口。
- 不让同一 Job/Task 用另一套实现重跑。
- 不启动依赖已删除 RPC 的旧 Worker 镜像。
- 不手工清空 claim token 摘要或强改 Task 状态绕过 fencing。
- 不回改已经发布的 migration 文件。

### 4.2 Worker 发布故障

1. 停止创建新 Job；
2. 将 Worker 缩容为 0 或停止服务；
3. 保存脱敏日志和失败 Job/Task/run ID；
4. 部署修复镜像，或回退到**已兼容 `0019+` canonical API**的上一个镜像；
5. 恢复 1 个副本并执行 smoke test；
6. 通过平台重试功能生成新 attempt/token，再逐步扩容。

### 4.3 数据库迁移故障

迁移只前滚。不要手工 down 或改写历史文件：

- 发布前问题：不要执行 push，先修复新 migration；
- 发布中失败：保持 Worker 停止，记录已应用状态，编写前滚修复；
- 发布后问题：使用备份制定恢复方案，或前滚修复；不要尝试恢复已删除的审核链路。

### 4.4 模型质量或成本问题

- 调整模型、prompt 或 Agent 预算；
- 缩小 Job 或 Task 范围；
- 依据 `analysis_agent_run` 的请求、retry、compaction 与 token 数据分析；
- 修复后重试或创建新 Job。

这些操作始终继续使用同一 Harness 架构。

## 5. 安全核对

- [ ] service role 只在 Worker/Edge Function Secret 平台中；
- [ ] API Key 只存 Vault，attempt 中仅通过 `REVIEW_MODEL_API_KEY` 临时注入；
- [ ] route/profile/config hash 不含密钥值；
- [ ] Git token 通过 `http.extraHeader` 注入，不拼接 URL；
- [ ] Worker 无入站端口，以非 root 用户运行；
- [ ] 模型无 shell、写文件、web、subagent 或任意 MCP；
- [ ] Snapshot 读取固定 Commit，不回退 HEAD；
- [ ] claim token 在数据库只保存摘要；
- [ ] Session 不写 JSONL，结果只通过 terminal tool 提交；
- [ ] 日志和错误输出经过脱敏。

## 6. 当前本地验收记录（2026-09-09）

- `supabase db reset --no-seed`：`0001..0023` 成功；
- 五套最终态 SQL：全部通过；
- `npm run worker:typecheck`：通过；
- `npm run worker:build`：通过；
- `npm run test:worker`：20 个文件、226 项通过，2 项真实 ACP 测试按环境开关跳过；
- `npm run build`：通过；
- `npm run lint`：通过；
- 生产源码与部署配置残留扫描：无可执行旧链路或版本化 Worker RPC。

未由这组本地命令证明的事项：远端迁移/部署状态、目标 Linux 容器中的真实模型 attempt、生产 egress/资源限制，以及本机未安装 `deno` 时的独立 `deno check`。这些必须在实际发布环境补验。

## 7. 最终上线勾选表

```text
[ ] 数据库备份/恢复点已确认
[ ] migration list 与 linked dry-run 已人工核对
[ ] 本地 reset、五套 SQL、Worker 测试、build、lint 全绿
[ ] 经批准应用待发布迁移，远端 migration list 正确
[ ] admin-model-config Edge Function 已部署
[ ] 前端已发布且无执行方式/provider 入口
[ ] Worker 镜像已构建并通过三方连通性检查
[ ] 单副本、单小 Job 的真实 Harness attempt 成功
[ ] Evidence、预算、日志脱敏与 attempt 清理已核对
[ ] 扩容期间 lease、并发和模型成本正常
[ ] 只保留与 canonical 单 Harness API 兼容的回退镜像
```
