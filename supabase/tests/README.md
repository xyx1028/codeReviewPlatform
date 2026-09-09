# supabase/tests

数据库层回归测试（纯 SQL，不依赖 pgTAP）。

## 0010_ai_automation_mvp_test.sql

针对迁移 `0010_ai_automation_mvp.sql`（AI 自动化 MVP：模型配置 + Vault 密钥、
批次模型选择与锁定、`analysis_job` / `analysis_repository_snapshot` /
`analysis_story_task`、多 Worker 需求级并发与租约/心跳、检索/分析保存、
原子 complete/fail/retry、权限收敛）的行为断言测试。

覆盖内容：

- 模型快照不含 `api_key_secret_id`；新批次必须先选模型；分支唯一复制到 job；
  20 条 story 拆成 20 个 task。
- `claim_job_for_preparation` / `claim_next_story_task` 返回 JSON 信封；保存 4 个
  仓库快照；`max_parallel_tasks=4` 时第 5 次领取为 `null`（另有一个配置为 8 的模型
  说明可扩展）；task 唯一。
- 心跳正确/错误 owner；租约过期后被其它 worker 接管；迟到写被拒 `TASK_LEASE_LOST`。
- 保存检索/分析进度与 `attempt` 语义（领取才 +1，保存不重复自增）；
  `fail_story_task` 令整个 job `FAILED`；`retry_analysis_job` 复用 4 个仓库快照并
  保留已成功的检索结果。
- finalizer 唯一 / 租约接管；失租 finalizer 的失败写入被拒；非法
  `complete_analysis_job` 的事务回滚（用 `BEGIN...EXCEPTION` 子事务验证异常与
  “无残留结果”）；合法 complete 一次写入正式结果、重复被拒；证据 `commit_sha`
  强制取自快照。
- `authenticated` 不能直接 `select ai_model_config` / Vault 解密视图，也不能执行
  Worker / secret RPC；无密钥列表 RPC 返回列不含任何 secret id；`service_role`
  授权存在。
- 产生自动结果后，现有 `human_review` 仍可插入与查询。

### 运行方式

前置：目标库已按顺序应用 `0001..0010`，以库属主（通常 `postgres`）连接
（脚本内部使用 `set local role` 切换 `authenticated` / `service_role` 做权限探针，
因此执行角色需要具备这些角色的成员资格）。

```bash
# 对已应用 0001-0010 的库执行（Supabase 本地或任意 PostgreSQL 均可）
psql -v ON_ERROR_STOP=1 -U postgres -d <database> \
  -f supabase/tests/0010_ai_automation_mvp_test.sql
```

- 脚本自带 `\set ON_ERROR_STOP on`。任一断言失败会 `RAISE EXCEPTION` 并使
  `psql` 以非零码退出。
- 全部通过时输出且仅输出成功标记：`ALL_AI_AUTOMATION_MVP_TESTS_PASSED`。

判定成功（CI 建议）：

```bash
psql -v ON_ERROR_STOP=1 -U postgres -d <database> \
  -f supabase/tests/0010_ai_automation_mvp_test.sql \
  | grep -q ALL_AI_AUTOMATION_MVP_TESTS_PASSED
```

### 重要提醒：只在测试 / 事务环境执行

- 脚本整体包裹在单个 `BEGIN ... ROLLBACK` 中，正常执行结束**不留任何数据**。
- 使用固定的高熵测试 UUID（`10……` 命名空间）与 `WK-10TEST-001` 周次编码，
  避免与真实数据冲突；但仍应**只对测试库 / 可回滚事务环境执行**，不要在生产库上运行。
- 兼容真实 Vault 与测试 Vault 桩：密钥写入统一走 `public.admin_vault_create_secret`
  包装函数，两种环境下都存在，无需直接依赖 `vault.*`。
- 不依赖 pgTAP：断言用临时函数 `pg_temp.assert*` + `RAISE EXCEPTION` 实现；
  “某操作必须失败/回滚”的场景用 `BEGIN ... EXCEPTION` 子事务块验证。
