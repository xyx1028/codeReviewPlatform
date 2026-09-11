# DeepSeek Harness 原生代码审核 Agent 最终架构

> 状态：已实现并完成本地验收；本文是当前架构与后续变更的唯一 V3 基准
> 最终数据库基线：按顺序应用 `0001..0023`
> 核心收口迁移：`0019_single_harness_execution.sql`、`0020_remove_model_provider.sql`
> DeepSeek Harness：`0.1.5-rc.1`
> ACP Client：`@agentclientprotocol/sdk@1.4.0`
> 启动入口：`dsh --profile code-review-acp --patch <attempt-route.patch.yml>`

## 0. 不可破坏的架构约束

平台只有一种代码审核执行方式：**DeepSeek Harness ACP Agent**。

- 每个 Story Task attempt 启动一个隔离的 Harness 子进程、一个 ACP Session、一个 Review Agent 和一个业务 prompt。
- Agent 在同一个 Loop 中自主交替搜索、阅读、分析、压缩上下文和修正提交；平台不编排固定的检索/分析阶段。
- 代码只从 Job 固定的四仓库精确 Commit 快照读取，不创建候选源码副本或 Task code workspace。
- Worker 只调用一套 canonical、无版本后缀的数据库 RPC。
- 模型配置页没有执行方式选择；所有新 Job 都进入 Harness。
- Worker 不声明支持的引擎集合，也不进行平台协议版本协商。
- 不存在运行时回退路径。失败的 Harness attempt 只能按同一架构重试，不能改用已退役实现。

`analysis_job.execution_engine` 仅为历史结果来源字段：新 Job 恒为 `deepseek-harness-acp`；历史行可继续读取。它不是配置项、路由条件或回退开关。

## 1. 最终数据流

```text
管理员维护模型配置与 Vault API Key
  → 用户创建分析 Job
  → 数据库冻结模型参数、分支与任务集合
  → Worker 准备四仓库精确 Commit snapshot
  → 数据库领取 Story Task，签发 claim token 与 lease
  → Worker 按 Task 从 Vault 读取模型凭据
  → 创建 AttemptControlBroker 与私有 DSH_HOME
  → 启动一个 DeepSeek Harness ACP 进程
  → Agent 通过四个只读快照工具自主检索和阅读
  → submit_review_result
  → Broker 校验 claim、Evidence、覆盖与结果结构
  → 单事务提交 Agent result/run/evidence/task status
  → 全部 Story 成功后汇总为正式评审结果
```

Worker 管理页只显示三类阶段：

```text
PREPARING → AGENT → FINALIZING
```

业务进度只读取 `agent_status`，不映射或伪造已删除的阶段状态。

## 2. Job、Task 与 attempt

### 2.1 Job 冻结内容

建单时数据库冻结：

- 模型配置 ID、显示名、Base URL、模型名；
- `context_window`、`max_output_tokens`；
- Agent 总请求、retry、compaction 预算；
- `max_parallel_tasks` 与请求超时；
- 请求分支、Story 集合；
- 准备阶段解析出的四仓库精确 Commit SHA。

后续修改模型配置只影响新 Job，不改写在途 Job 的 snapshot。

### 2.2 Task claim

每次领取 Task 时数据库：

1. 增加 `agent_attempt`；
2. 生成一次性明文 `claim_token`；
3. 数据库只保存 token 摘要；
4. 绑定 `task_id + worker_id + agent_attempt + lease`；
5. 创建或重置对应的 `analysis_agent_run`。

明文 token 只存在于当前 Worker/attempt 内存，并贯穿 heartbeat、模型密钥读取、Broker 调用、提交与失败上报。新 attempt 会使旧 token 永久失效，阻止迟到写入和 ABA 问题。

### 2.3 不可变边界

- Task 不切换执行实现。
- Job 不切换分支、模型 snapshot 或 Commit。
- lease 丢失后，工具调用、模型执行和数据库保存都必须终止。
- 已提交结果不能由后续 attempt 覆盖。

## 3. 单 Harness Agent runtime

### 3.1 每 attempt 一个进程

`DeepSeekHarnessAcpEngine` 为每个 attempt 完成：

1. 创建 `AbortController` 与 Broker；
2. 物化私有 `DSH_HOME` 和 profile；
3. 生成不含 API Key 值的 route patch；
4. 启动 `dsh` ACP 子进程；
5. `initialize → session/new → session/prompt`；
6. 等待 terminal submission；
7. 正常关闭 Session 和子进程；
8. revoke Broker，并清理 socket、profile、cwd 和临时目录。

异常、取消、lease 丢失或 Worker 退出时，Supervisor 负责 cancel、EOF、TERM/KILL 和清理。成功路径由 terminal tool 自然结束 turn，不以 cancel 模拟成功。

### 3.2 一个 Agent Loop

Agent 在一次 prompt 中可多轮：

```text
搜索 → 阅读 → 推理 → 补查调用链 → 上下文压缩 → 修正 → 提交
```

平台不预先截断候选集，因此 Agent 可以在固定快照内继续补查。第一版禁止 subagent、fork、workflow 和后台 Agent，确保一条 Task lease 只对应一个模型流。

### 3.3 Profile 能力面

启用：

- ACP Session 与 Agent Loop；
- OpenAI-compatible 模型 adapter；
- token meter、retry、automatic compaction、tool-result pruning；
- 易失 SessionPersistence；
- model-budget-governor；
- snapshot-tools；
- review-control terminal tool。

不向模型暴露：

- shell、命令执行、jobs；
- 通用 filesystem、编辑或写文件；
- web、browser、远程 MCP；
- 用户 instructions、skills、commands；
- subagent、workflow、自修改；
- 动态模型或 provider 切换。

Harness 某些底层 sandbox/subprocess 服务是 Agent runtime 的内部依赖；安全验收以**模型可见 tool schema**为准。模型只能看到四个只读代码工具和 `submit_review_result`。

## 4. SnapshotStore 与只读工具

### 4.1 精确 Commit

准备阶段为四个白名单仓库解析并保存精确 Commit SHA。后续所有读取都绑定 `<repository, commit_sha>`，禁止回退到分支最新 HEAD。

可信读取优先使用 Git object：

- 文件枚举：Commit tree；
- 内容搜索：指定 Commit；
- 文件读取：`<commit>:<path>` 对应 blob；
- 提交历史：受限 Commit 查询。

工作树只承担本地 cache/materialization；模型不能看到 cache 根路径，也不能指定任意仓库根。

### 4.2 模型可见工具

- `search_code`
- `find_files`
- `read_code`
- `list_commits`
- `submit_review_result`（唯一 terminal tool）

前四个工具由 profile-local 插件代理到 Worker Broker。不存在独立 Snapshot MCP 进程，也不在 `session/new` 中加载用户或 workspace MCP。

### 4.3 路径与容量策略

Broker 对每次调用校验：

- repository/Commit allowlist；
- 规范化相对路径、越界、绝对路径、NUL、符号链接和敏感路径；
- 文件类型、行范围、返回字节、累计代码量和超时；
- blob/content hash；
- claim token、lease、abort 与 run 状态。

Agent 从未获得 SnapshotStore 路径、Supabase 凭据或 Git 凭据。

## 5. Broker、Evidence 与 terminal submission

### 5.1 AttemptControlBroker

每个 attempt 有独立本地 Unix socket。Harness 插件只持：

- 当前 socket 路径；
- 当前 claim token。

Broker 持有并统一执行：

- lease 与取消检查；
- SnapshotStore 访问；
- Evidence/Search Ledger；
- 模型请求许可与预算；
- terminal submission 校验；
- 数据库原子提交。

heartbeat 失败、lease 到期、Job 失败或 Worker shutdown 会立即 revoke Broker。提交成功后 run 进入 sealed 状态，所有迟到工具调用都被拒绝。

### 5.2 Evidence Ledger

模型真实看到代码时，Broker 在内存登记：

```text
evidence_id / task / attempt / tool ordinal
repository / commit / path / blob
actual line range / content hash / returned bytes
```

最终证据必须引用 Ledger 中的有效 ID。repository、Commit、path、blob 和范围由平台补齐并复验，不信任模型自报字段。

搜索同时产生 coverage receipt。`NOT_IMPLEMENTED` 必须有四仓库充分、未截断、未超时的搜索覆盖；覆盖不足时只能继续检索或提交 `UNCERTAIN`。

### 5.3 Terminal tool

`submit_review_result` 的处理顺序：

1. 校验结果 schema；
2. 校验 verdict 与 Evidence/Coverage 规则；
3. 重新校验 claim、attempt、lease 和 hashes；
4. 调用 `save_agent_review_result`；
5. 收到 committed receipt 后才 `concludeTurn()`。

可修正的校验错误作为 tool failure 返回，Agent 可在同一 Loop 中补查后重提；基础设施、租约或授权错误直接终止 attempt。若 prompt 自然结束但没有 committed receipt，任务以 `AGENT_NO_SUBMISSION` 失败，不解析普通 assistant 文本。

## 6. Session 与凭据

### 6.1 零 Session 源码留存

真实代码运行使用内存型 SessionPersistence：

- ACP event、工具结果、compaction checkpoint 不写 JSONL；
- 完整 Ledger 只存在于 Broker 内存；
- 数据库只保存最终结果、用量和被引用证据的 metadata/hash；
- 进程退出后 Session 不可恢复。

`AGENT_ATTEMPTS_ROOT` 只承载每 attempt 的 profile/config 临时树。正常、失败和取消路径都必须清理；不得在其中创建源码副本。

### 6.2 API Key 生命周期

API Key 仍存于 Supabase Vault，但它只是 Harness model adapter 的凭据，不是另一条审核链路。

1. Worker 领取 Task 后调用 `get_model_secret_for_story_task`；
2. 数据库校验 worker、claim token 与 lease；
3. Worker 将密钥仅注入当前子进程临时环境变量 `REVIEW_MODEL_API_KEY`；
4. route patch 只保存环境变量名，不保存值；
5. 日志、config hash、profile 文件和数据库均不记录明文；
6. 子进程结束后引用随进程销毁。

模型 Base URL 仍可指向 OpenAI-compatible `chat/completions` 服务，但生产审核请求由 Harness adapter 发起。`worker:check-connectivity` 的直接最小 `ping` 仅是部署探针，不是生产审核实现。

## 7. 模型预算与并发

模型配置包含：

| 字段 | 默认值 | 语义 |
|---|---:|---|
| `context_window` | 131072 | Harness 上下文窗口 |
| `max_output_tokens` | 8192 | 单次模型输出上限 |
| `agent_max_model_requests` | 120 | 每 attempt 总模型请求硬上限 |
| `agent_max_retry_requests` | 6 | provider retry 上限 |
| `agent_max_compaction_requests` | 4 | compaction 请求上限 |
| `max_parallel_tasks` | 4 | 同一模型配置的并发 Task lease 上限 |

model-budget-governor 在 adapter 边界计量普通、retry 与 compaction 请求；超限时在发起下一次 provider 请求前失败。ACP update 只用于展示，不作为权威预算来源。

Worker 自身还受 `WORKER_STORY_CONCURRENCY` 限制。实际并发上限是 Worker 槽位与模型配置并发上限的共同结果。

## 8. 数据库最终契约

### 8.1 Canonical Worker RPC

Worker 只调用以下无版本后缀接口：

1. `heartbeat_analysis_worker`
2. `claim_job_for_preparation`
3. `save_repository_snapshots`
4. `claim_next_story_task`
5. `heartbeat_story_task`
6. `get_model_secret_for_story_task`
7. `save_agent_review_result`
8. `fail_agent_review`
9. `claim_job_for_finalization`
10. `list_completed_story_tasks`
11. `complete_analysis_job`
12. `fail_claimed_analysis_job`

全部由 `service_role` 调用。Task 范围的 heartbeat、secret、commit 与 fail 必须携带 claim token；数据库保存摘要并核验 attempt fencing。

### 8.2 Schema 收口

`0019` 完成：

- 封存尚未结束的历史旧任务，并写入 `LEGACY_ENGINE_RETIRED`；
- 删除已退役运行入口和固定阶段 RPC；
- 重建唯一 canonical Worker API；
- 删除模型执行方式与两阶段 prompt 配置；
- 删除 Worker 引擎能力/协议字段；
- 新 Job 强制 Harness；
- 默认模型请求预算调整为 120。

`0020` 进一步删除模型 `provider` 字段并重建无 provider 的模型管理 RPC。`0021..0023` 在此最终态上补充批次创建人、模型删除约束和模型配置/Vault secret 原子清理，不改变单 Harness 执行契约。

### 8.3 历史数据

允许保留：

- 已完成历史 Job 的 `analysis_job.execution_engine` 来源值；
- 旧迁移文件及 V1/V2 目录中的历史方案；
- 明确标注为归档的联调排障记录。

这些内容不得作为当前 Worker 路由、部署参数或数据库接口依据。

## 9. 状态、失败与重试

### 9.1 状态机

```text
Job: QUEUED → PREPARING_CODE → PROCESSING → FINALIZING → SUCCEEDED
Task: PENDING → RUNNING → SUCCEEDED
```

任一不可恢复错误可进入 `FAILED`。最终汇总只读取 `agent_output` 与数据库中已验证的 Evidence。

### 9.2 失败原则

- lease/token 不匹配：拒绝迟到写，不做部分提交；
- 模型限流或临时 5xx：由受预算约束的 retry 处理；
- schema/Evidence 可修正错误：在同一 Agent Loop 内修正；
- prompt 无 terminal submission：任务失败；
- 快照、授权、密钥或 cleanup 错误：以稳定错误码失败；
- 一个 Task 的致命失败会收敛 Job 和 sibling lease，避免产生不完整汇总。

重试始终重新领取 Task、增加 attempt、生成新 token，并继续使用同一 Harness 架构与冻结 snapshot。禁止同一 Job 或 Task 改用其他实现。

### 9.3 回退与回滚

平台没有执行方式回退。发布故障时：

1. 停止创建新分析 Job；
2. 缩容或停止 Worker，保护数据库现场；
3. 修复后部署与 canonical API 兼容的 Worker 镜像；
4. 按错误码重试或新建 Job。

数据库迁移只前滚。只能回退到已经兼容 `0019+` 单 Harness schema 的镜像；不得启动依赖已删除接口的旧镜像。

## 10. 代码结构

```text
worker/src/ai/runtime/
  contracts.ts
  factory.ts
  deepseek-harness-acp-engine.ts
  errors.ts

worker/src/ai/acp/
  acp-client.ts
  acp-process-supervisor.ts
  profile-materializer.ts

worker/src/ai/control/
  attempt-control-broker.ts

worker/src/ai/snapshot/
  snapshot-store.ts
  git-object-reader.ts
  evidence-ledger.ts
  search-coverage-ledger.ts
  deterministic-verifier.ts

worker/src/ai/prompts/
  agent-review-v1.ts        # prompt 自身的版本，不是 Worker API 版本

worker/src/harness-plugins/
  volatile-session-persistence/
  model-budget-governor/
  review-control-tool/
  snapshot-tools/

worker/harness/code-review-acp/
  package.json
  cordis.patch.yml
  pnpm-workspace.yaml
  README.md
```

Worker 入口直接构造唯一的 `DeepSeekHarnessAcpEngine`。不存在按执行方式分派的工厂、旧审核客户端或固定阶段 pipeline。

## 11. 安全与可观测性

允许记录：

- job/task/run/session correlation ID；
- step、工具名、耗时、计数、退出码；
- profile/config hash；
- 请求分类与用量摘要；
- Evidence/Search receipt 数量和 hash 校验状态；
- lease、cleanup 和进程回收结果。

禁止记录：

- API Key、service role、Git token、Authorization；
- claim token 或 Broker socket 凭据；
- prompt、需求全文、模型完整响应；
- 源码、snippet、工具原始结果；
- Session event payload。

容器以非 root 用户运行、无入站端口并启用 `no-new-privileges`。模型只能通过 Broker 访问快照。生产仍应在目标 Linux/容器环境验证进程树回收、资源限制和 egress 策略；不能仅凭“每 attempt 一个子进程”宣称形成完整 OS 安全域。

## 12. 发布顺序

1. 备份并人工核对远端迁移状态。
2. 在本地执行 `supabase db reset --no-seed` 与最终态 SQL 回归。
3. 经负责人批准后按顺序应用待发布迁移。
4. 部署与最终 RPC 签名匹配的 `admin-model-config` Edge Function。
5. 发布移除执行方式选择的前端。
6. 构建并部署单 Harness Worker 镜像；所有副本使用同一能力面。
7. 先运行 1 个 Worker、1 个小 Job，再逐步扩容。
8. 核对 Agent run、证据、预算、清理和最终导入结果。

迁移、Edge Function、前端和 Worker 必须视为同一发布单元。远端迁移必须由用户明确批准；不得自动 push。

## 13. 验收基线

### 13.1 自动检查

```bash
supabase db reset --no-seed

# 在本地 Supabase PostgreSQL 中运行：
supabase/tests/0010_ai_automation_mvp_test.sql
supabase/tests/0017_agent_execution_engine_test.sql
supabase/tests/0018_execution_engine_admin_actor_test.sql
supabase/tests/0019_single_harness_execution_test.sql
supabase/tests/0020_remove_model_provider_test.sql

npm run worker:typecheck
npm run worker:build
npm run test:worker
npm run build
npm run lint
```

`0019_single_harness_execution_test.sql` 必须证明：旧运行入口和带版本后缀的 Worker RPC 不存在、新 Job 固定 Harness、claim token fencing 生效、Worker overview 只有三阶段。

### 13.2 当前本地结果（2026-09-09）

- 数据库迁移 `0001..0023` reset 成功；
- 五套最终态 SQL 测试全部输出预期成功标记；
- Worker typecheck/build 成功；
- Worker：20 个测试文件、226 项通过；2 项真实 ACP 集成测试按环境开关跳过；
- 前端生产构建成功；
- `oxlint src worker supabase` 成功；
- 生产源码与部署配置中无可执行的已退役链路、版本化 Worker RPC 或引擎能力协商。

### 13.3 生产前人工门槛

- [ ] 远端迁移状态与待发布列表已人工确认并备份。
- [ ] Edge Function、前端和 Worker 使用同一发布版本。
- [ ] 容器内连通性检查通过。
- [ ] 目标 Linux 容器中用真实模型完成 1 个小 Task。
- [ ] 模型只看到五个允许工具。
- [ ] API Key 不出现在文件、dump、日志或错误中。
- [ ] Evidence 全部绑定 Job 的精确 Commit/blob/range。
- [ ] 正常、失败、lease lost 与重启后无孤儿进程/socket/profile。
- [ ] 模型请求、retry、compaction 均受预算约束。
- [ ] 扩容后不超过模型 `max_parallel_tasks`。

## 14. 文档边界

- 本文：当前 V3 架构事实来源。
- `代码评审平台-V3-DeepSeekHarness-上线操作清单.md`：当前发布 runbook。
- `worker/OPERATIONS.md`：当前 Worker 日常运维手册。
- `代码评审平台-V3-DeepSeekHarness-问题排查与修复记录.md`：迁移期间的历史联调记录，仅供复盘。
- `代码评审平台/V1/`、`代码评审平台/V2/`：历史方案，不是当前实现或运维依据。
