# 代码评审平台 V3 - DeepSeek Harness 接入问题排查与修复记录

> **历史归档**：本文记录 `0017/0018` 过渡期的真实联调事实，不是当前架构或上线手册。
> 当前平台已由 `0019/0020` 收敛为唯一 DeepSeek Harness ACP 链路；正文中的执行方式切换、旧接口、版本化 RPC 和能力协商均不得用于现行运维。
> 记录范围：`0017` 迁移推上远端之后的真实联调过程
> 当时结论：Agent 链路已跑通并用真实模型验证；共修复 7 个问题，其中 3 个是既有代码问题
> 当前文档：同目录 `DEEPSEEK_HARNESS_REFACTOR_PLAN.md`（最终架构）、`代码评审平台-V3-DeepSeekHarness-上线操作清单.md`（现行部署步骤）

---

## 0. 一句话总结

联调暴露的问题分两类：**三个功能缺陷**（都会让流程停住）和**四个可观测性缺口**（让缺陷难以定位）。
后者其实更麻烦 —— 第一次失败时平台侧几乎拿不到任何线索，前两轮排查都是靠推测，直到把日志补齐才拿到决定性证据。

修完之后两个原本失败的需求都能产出结论。

---

## 1. 问题一：模型管理页保存失败

**现象**：编辑模型点确定，报 `Edge Function returned a non-2xx status code`。

**根因**：`0017` 新增的 `admin_set_model_execution_engine` 用 `ensure_admin()` 判断管理员，
而它依赖 `auth.uid()`。这个函数唯一的调用方是 `admin-model-config` Edge Function，
后者用 **service_role** key 调 RPC 且不携带用户 JWT，所以 `auth.uid()` 恒为 NULL，
校验必然抛 `ADMIN role required`。

仓库既有约定是显式传 `p_actor_id` 再 `assert_actor_is_admin(p_actor_id)`
（`admin_create_model_config`、`admin_update_model_config` 都是这个写法），`0017` 漏了这条约定。

**为什么 `0017` 的测试没抓到**：测试 fixture 里 `set_config('request.jwt.claims', ...)`
在整个事务内一直有效，测试里 `auth.uid()` 恰好有值，把这条路径掩盖了。

**修复**：新增 `0018_execution_engine_admin_actor.sql`

- 重建函数，第一个参数改为 `p_actor_id`，改用 `assert_actor_is_admin`
- 执行权限只留 `service_role`，前端不再直连（同时移除了 `api.ts` 里没有调用方的封装）
- 删掉旧的 7 参数签名。这是有意的：半升级状态（推了迁移但没重新部署 Function）会直接报
  "函数不存在"，而不是以不校验管理员的方式静默通过

**顺带修的同类既有缺陷**：`admin_get_model_secret_id`（`0010` 9.4）同样是只授权 service_role
却用 `ensure_admin()`，在它唯一被允许的调用路径上永远失败。仓库里目前没有调用方（只在
Edge Function 的依赖注释里被提到），所以线上没暴露，但照着注释去用就会踩到。

**排查方法值得留下**：不是靠 grep 猜，而是直接查数据库 ——

```sql
-- 授予了 service_role、却靠 auth.uid()/ensure_admin() 判权的函数
select p.proname, pg_get_function_identity_arguments(p.oid)
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and (p.prosrc like '%ensure_admin%' or p.prosrc like '%auth.uid%')
  and has_function_privilege('service_role', p.oid, 'execute')
  and not has_function_privilege('authenticated', p.oid, 'execute');
```

只命中两个：上面那个真缺陷，以及 `audit_review_batch_created`（`review_batch` 上的触发器函数，
用 `auth.uid()` 是正确的）。

**留下的规则**：凡是由 Edge Function 以 service_role 调用的数据库函数，都不能用
`auth.uid()` / `ensure_admin()` 判权，必须显式接收 `p_actor_id`。写这类 RPC 的测试时，
必须保证 `request.jwt.claims` 为空，否则测试会掩盖问题。

---

## 2. 问题二（既有）：前端错误信息永远是通用文案

**现象**：上面那个故障在页面上只显示一句 `non-2xx status code`，看不到真实原因。

**根因**：`src/lib/api.ts` 的 `invokeAdminModelConfig` 把 `error.context` 当普通对象读
`context.body`。但 supabase-js v2 里 `context` 是 `Response`，`body` 是 ReadableStream ——
而 ReadableStream 也是 object，所以类型判断通过、取值为 undefined，最终退回 SDK 的通用文案。

同一个文件里的 `invokeWechatAuth` 写法是对的（`context instanceof Response` +
`await context.clone().json()`），属于两处实现不一致。

**修复**：对齐 `invokeWechatAuth` 的写法。

这个问题不是本次重构引入的，但它是上面那个故障难以定位的直接原因。

---

## 3. 问题三（既有）：Edge Function 丢弃数据库错误原因

**根因**：`handleCreate` / `handleUpdate` 的失败分支一律返回
`failed to create/update model config`，真实原因（`ADMIN role required`、
`unsupported execution engine` 等）被吞掉。

**修复**：新增 `reason()` / `failure()` 辅助函数，失败分支带上真实原因，并写入函数日志的
`reason` 字段。只透传 `message`，不带 `details`/`hint`，避免把 SQL 片段或行数据带出去。

**一处刻意的例外**：`createVaultSecret` 保持不透传 —— 它的唯一入参就是 API Key 明文，
任何回显路径都可能把它带出去。代码里加了注释说明这是有意的，别"顺手统一"。

---

## 4. 问题四：Job 卡在"代码准备 0/4"不动

**现象**：`代码准备` 一直停在 `0/4 仓库`，仓库快照表为空，Job 状态 `PREPARING_CODE`，
`error_code` 是 null，`updated_at` 从领取那一刻起就没变过。

**关键线索**：4 个仓库的 cache 目录时间戳都被更新了 —— 说明 git 抓取其实**成功了**，
但快照没写进数据库，而且没记任何错误。

**根因**：`prepare-job.ts` 调的是 **v1** 方法：

```ts
await jobsDb.saveRepositorySnapshots(...)   // v1
await jobsDb.failClaimedAnalysisJob(...)    // v1
```

而 `0017` 给所有 v1 RPC 加了 legacy fencing，对非 legacy 引擎直接抛 `ENGINE_NOT_SUPPORTED`。
实际经过是：

1. git 抓取 4 个仓库成功
2. `saveRepositorySnapshots`（v1）→ `ENGINE_NOT_SUPPORTED`
3. catch 里想记错误，用的 `failClaimedAnalysisJob` **也是 v1** → 又被 fence 掉 →
   异常被 `.catch()` 吞掉，只写了日志
4. Job 停在 `PREPARING_CODE`，`error_code` 为 null

第 3 步是最坑的一环：连"失败"都记不下来，所以页面上既不报错也不推进。

**修复**：改用 `saveRepositorySnapshotsV2` / `failClaimedAnalysisJobV2`。这两个 v2 RPC 是
引擎无关的，legacy 和 ACP 都走同一条，与 `index.ts` 已经全面改用 v2 保持一致。

**全仓排查结论**：只有这一处 misrouted。另外三处 v1 调用都在 legacy 分支里
（`process-story-task.ts`、`factory.ts` 的 `getModelSecretForJob`、`index.ts` 的
`failStoryTask`），ACP 走的是 `heartbeatStoryTaskV2` / `getModelSecretForStoryTask` /
`failAgentReview`。

**为什么测试没抓到**（这一条最重要）：

- `prepare-job.test.ts` 的假 `JobsDb` 只 stub 了被调用的那两个方法，v1/v2 都"存在"，
  所以调哪个都能过
- 更根本的是 **`tsconfig.worker.json` 排除了 `*.test.ts`，测试文件从来没被类型检查过**，
  假对象和真接口可以无限漂移

两件都补了：

- 测试改成复刻真实 fencing —— 假 `JobsDb` 的 v1 方法在 ACP 引擎下会抛
  `ENGINE_NOT_SUPPORTED`，并断言 v1 完全没被调用。实测把代码改回 v1 会有 4 项失败
- 新增 `tsconfig.worker.test.json` + `npm run worker:typecheck`，把测试文件纳入类型检查。
  顺手修掉了它暴露的 4 个既有类型错误（缺 import、假 `StoryTask` 缺 4 个必填字段）。
  假数据工厂改成先显式标注类型再 `Object.assign`，以后接口加字段会直接编译报错

这个机制后来真的起了作用：给 `BrokerUsageSnapshot` 加字段时，它立刻指出某个测试的假数据缺字段。

---

## 5. 问题五：Worker 管理页的引擎标签来回跳变

**现象**：同一个 Worker，刷新页面时"支持的执行引擎"有时显示两个引擎、有时只显示一个。

**根因**：不是代码问题，是**同一个 `worker_id` 上跑了两个进程**。四个进程共用两个
`worker_id`，每个都按 5 秒一次往 `analysis_worker_heartbeat` 的同一行 upsert 自己的能力声明，
页面显示取决于最后一次写入是谁。

（成因是排查过程中我起的诊断进程没关，与产品无关。但暴露的机制是真的。）

**为什么值得修**：这次能发现是因为两组配置不同。如果两个进程配置**相同**，重复启动完全无声无息：
页面显示 2 个在线 Worker，实际 4 个进程在抢任务。数据库层不会写坏数据（任务领取有行级锁 +
一次性 claim token），但会有两个副作用 ——

- 并发被低估：页面显示 `0/4` 槽位，实际 `0/8`，可能超出模型的 `max_parallel_tasks`
- `current_tasks` 不准：两个进程各报自己的活跃数，互相覆盖

**修复**：新增 `worker/src/coordination/instance-lock.ts`。启动时在 `WORKSPACE_ROOT` 下用
`open(..., 'wx')` 原子创建按 `worker_id` 命名的锁文件，写入持有者 PID：

- 持有者存活 → 拒绝启动，退出码 1，日志给出持有者 PID 和三条处置办法
- 持有者已退出（崩溃留下的陈旧锁）→ 接管，正常启动

第二条是必要的。只做"有锁就拒绝"的话，Worker 崩一次就再也起不来，比原问题更糟。

几个刻意的设计选择：

- **锁放在进程入口而不是 `startWorker` 内**：这是部署约束不是运行时逻辑，放进去会让所有单元
  测试都得跟文件锁打交道
- **文件名带原始 id 的短摘要**：`worker_id` 在容器里由 hostname 生成，可能含不适合做文件名的
  字符，得净化；但净化会让 `a/b` 和 `a:b` 撞成同名文件，等于把两个不同副本误判成重复。
  所以是 `worker-<净化后>-<sha256前8位>.lock`
- **`release()` 只删属于自己的锁**：若本进程曾被判定为已退出、锁被别人接管，此时删锁会误删对方的

已知边界：两个进程用同一 `worker_id` 但**不同 `WORKSPACE_ROOT`** 时锁抓不到。这种配置本身
不该出现，没为它加复杂度。

---

## 6. 问题六：Agent 预算耗尽（`budget exhausted (limit 40)`）

这是最花时间的一个，因为前两轮判断都错了。值得完整记下来。

### 6.1 现象

```
分析失败（-32603）
Internal error: turn failed: attempt loop request budget exhausted (limit 40)
```

消息来自我们自己的 `model-budget-governor`：40 次 loop 模型请求打满，第 41 次在发出 HTTP
请求之前被拒。拒绝会终止 agent 的 turn。

### 6.2 两个被推翻的判断

**第一次判断（错）**："`tool_calls: 0` 说明模型一次工具都没调用，可能看不到工具。"

核对代码后发现 **`fail_agent_review` 根本不接收 usage 参数** —— 库里那些 0 是建 run 时的
初始值，不代表任何事实。如果照这个结论去改工具注册或权限白名单，就是在修一个不存在的问题。

**第二次判断（错）**："预算耗在反复提交被拒上，调大到 120 即可。"

补齐日志后拿到真实分解，这个判断也是错的（见下）。

### 6.3 排查过程中修的可观测性缺口

第一次失败时平台侧几乎没有线索，以下每一处都是补上之后才拿到证据的：

| 缺口 | 表现 | 修法 |
|---|---|---|
| `runSingleAcpTurn` 里 `void session.prompt(p).catch(() => undefined)` | prompt 请求的失败原因被直接丢弃。协议层错误走 JSON-RPC 不走 stderr，所以失败只剩一个 `cancelled` | 捕获成 `promptError` 随 turn 结果返回 |
| 失败日志只记 `child_stderr_bytes` | dsh 子进程 stderr 的内容被扔掉，只留字节数 | 记录脱敏后的尾部 4000 字符（取尾不取头：启动噪音在前、真实原因在后，截断处带标记） |
| `!committed` 分支没有任何诊断日志 | `AGENT_NO_SUBMISSION` / `AGENT_TURN_INCOMPLETE` 走正常返回不是异常，上面两个修复都不触发 —— 而这恰好是最常见的失败路径 | 新增 `agent_attempt_no_submission` 日志 |
| governor 的 denial 被 `HARNESS_PLUGIN_DIAGNOSTICS=1` 挡着 | 预算拒绝是终止性事件，却默认静默 | 改为无条件写 stderr，并带完整分项计数（只有计数，无模型内容） |
| broker 只统计工具调用总数 | 分不清预算是花在检索阅读还是反复提交被拒 | `usage()` 新增 `toolCallsByName` 和 `rejectedSubmissions` |
| turn 抛错时 agent 侧工具名丢失 | 分不清"模型没调用提交工具"和"调用了但没到达 Worker" | `runSingleAcpTurn` 新增 `onToolCall` 回调，逐次上报 |

### 6.4 真正的根因

补齐日志后重跑，拿到决定性证据：

```json
{
  "error_message": "attempt loop request budget exhausted (limit 40)",
  "tool_calls_by_name":  {"search-code": 39, "read-code": 17, "find-files": 5},
  "agent_tool_calls":    {"search_snapshot_code": 39, "read_snapshot_code": 17, "find_snapshot_files": 5},
  "rejected_submissions": []
}
```

**agent 侧压根没有 `submit_review_result`**，`rejected_submissions` 也全空。所以不是"提交被拒
反复重试"，而是**模型从头到尾没调用过提交工具，一直在检索直到预算被硬闸切断**。

另一个需求更极端：42 次搜索只读了 6 次 —— 在反复换关键词搜而不收敛。

原因在 prompt：原来只说"你可以多轮使用工具，自己决定检索顺序、深度和何时补查"，
既没告诉模型有预算，也没给收敛条件。模型不知道无限检索的代价是整个 attempt 归零。

### 6.5 修复

**`agent-review-v1.ts` 加收敛规则和预算告知**：

- 明确告知硬上限次数，以及"耗尽即本次审核直接失败、不产出任何结论，比提交一个证据不足的
  结论差得多"
- 用掉约一半预算仍未定位实现，就应停止扩大检索、转为提交 UNCERTAIN，并在 summary 写清
  查过哪些仓库、用过哪些关键词、为什么无法确定
- 同一关键词换写法反复搜没有收益，连续几次无新增信息就立刻收敛
- 宁可提交诚实的 UNCERTAIN，也不要因预算耗尽什么都不交

预算数字从 `budgets.maxLoopRequests` 传入，不是硬编码。

### 6.6 实测数据

| 需求 | 改前（预算 40） | 改后（预算 40） | 改后（预算 120） |
|---|---|---|---|
| PRJ-00773807 | 失败，0 次提交 | **成功**，9 条证据 | — |
| PRJ-00774030 | 失败，0 次提交 | 仍失败，0 次提交 | **成功**，4 条证据 |

PRJ-00774030 在 120 预算下实际用了 49 次工具调用（search 23 / read 20 / find 5 / submit 1），
一次提交通过，没有被拒。

**结论：prompt 改动和调大预算两件都需要。** prompt 让模型愿意收敛，但复杂需求的检索量确实
超过 40。建议把「每次尝试的模型请求上限」设为 **120**。

### 6.7 顺带发现的一个配置陷阱

排查中我的探针传错了预算键名（`maxModelRequests` 而不是 `maxLoopRequests`），结果 profile
沿用模板占位值 `1/1`，第一次模型请求就被拒、agent fiber 被销毁，表现是
`turn cancelled` + stderr 全空 + 0 个 update —— 完全无法诊断。

试过把校验交给插件 schema，实测**不会**变成响亮失败。所以改成 worker 侧在 spawn 之前校验
（`assertBudgets`）：dsh 内部的失败在诊断上是黑箱，这类配置错误必须挡在外面，由带日志和
错误落库的一侧报出来。现在会明确报出缺哪个键。

需要说明：这个键名不匹配只发生在探针里（纯 JS 绕过了类型），**产品代码是对的** ——
factory 构造的是四个正确键，这也是线上能报出 "limit 40" 的原因。核对过才没照着错误的复现
去改产品代码。

---

## 7. 集成测试的覆盖盲区

`acp-runtime.integration.test.ts` 用的是**本地脚本化的假模型服务**
（`startMockModelServer`）。它验证了管道（profile、broker、工具、提交、`concludeTurn`），
但"真实模型 + 真实 provider 适配器"这条路从未被覆盖。

本次联调暴露的问题里，问题六完全落在这个盲区内 —— 假模型永远按脚本调用工具，
不会表现出"不收敛"。

已通过临时探针在真实模型上验证过链路（含四仓库 + 真实需求），但那是一次性脚本，
没有固化成测试。**这仍是一个已知盲区**：目前没有任何自动化测试能捕获"模型行为层面"的回归。

---

## 8. 修改文件清单

**数据库**

- `supabase/migrations/0018_execution_engine_admin_actor.sql`（新增，纯修正，不动表结构）
- `supabase/tests/0018_execution_engine_admin_actor_test.sql`（新增）
- `supabase/tests/0017_agent_execution_engine_test.sql`（改：新签名 + 显式 service_role 角色）

**Worker**

- `worker/src/pipeline/prepare-job.ts`（v1 → v2）
- `worker/src/coordination/instance-lock.ts`（新增单实例保护）
- `worker/src/index.ts`（入口接单实例锁）
- `worker/src/ai/acp/acp-client.ts`（`promptError`、`onToolCall`、`describeProtocolError`）
- `worker/src/ai/acp/profile-materializer.ts`（`assertBudgets`）
- `worker/src/ai/control/attempt-control-broker.ts`（`toolCallsByName`、`rejectedSubmissions`）
- `worker/src/ai/runtime/deepseek-harness-acp-engine.ts`（三条路径的诊断日志、`tailOf`）
- `worker/src/ai/prompts/agent-review-v1.ts`（收敛规则 + 预算告知）
- `worker/harness/code-review-acp/cordis.patch.yml`（去掉误导性的预算占位值）
- `worker/src/harness-plugins/model-budget-governor/index.ts`（denial 无条件落 stderr）

**前端与 Edge Function**

- `src/lib/api.ts`（错误透传修复；移除无调用方的引擎封装）
- `src/pages/WorkerManagementPage.tsx`（移除每行重复的"协议 v2"）
- `src/types.ts`（说明 `protocol_version` 为何保留但不展示）
- `supabase/functions/admin-model-config/index.ts`（传 actor + 透传错误原因）

**工程基建**

- `tsconfig.worker.test.json`（新增，测试文件类型检查）
- `package.json`（新增 `worker:typecheck`）
- `docker-compose.worker.yml`（透传 `WORKER_SUPPORTED_ENGINES` / `AGENT_ATTEMPTS_ROOT`）

---

## 9. 验证状态

```
npm run test:worker                        22 passed / 1 skipped（289 passed / 2 skipped）
RUN_ACP_INTEGRATION=1 npx vitest run worker 24 files / 291 tests 全通过（真实 dsh 进程）
npm run worker:typecheck                   0 错误（含全部测试文件）
npm run build                              通过
npx oxlint src worker supabase             exit 0
git diff --check                           通过
supabase db reset --no-seed                0001..0018 全部应用
0010 / 0017 / 0018 三套 SQL 套件            全部 PASSED
```

真实模型端到端：四仓库 + 真实需求两次成功提交，证据带 `commit_sha` / `blob_sha`。

---

## 10. 已知未解决项

按优先级排列。都不阻塞使用。

**1. `fail_agent_review` 不落 usage 计数**

失败的 attempt 在 `analysis_agent_run` 里 `tool_calls` / `searches_run` / `retry_requests`
全是 0（建 run 时的初始值）。成功路径的 `save_agent_review_result` 是会写的，失败路径丢了。

后果：失败原因和用量都不在库里，历史失败无从追溯，调预算没有数据依据。本次排查就差点因此误判。
需要一个 `0019` 迁移给 `fail_agent_review` 增加 `p_usage jsonb` 参数。

**2. 容器内的真实 Agent 运行未验证**

已验证：镜像构建成功、容器内 profile 模板与 4 个插件都能解析、`dsh` 的 `bin.js` 存在、
git + ripgrep 可用、非 root 运行、`/workspace/agent-attempts` 属主正确。

未验证：在容器内真实跑通一次完整 Agent attempt。所有真实模型验证都是在 **macOS 宿主**上做的。

具体风险：dsh 的 sandbox 相关服务行（`subprocess`、`sandbox`、`sandbox-policy`、
`bash-sandbox`）在 profile 中必须保持启用，而 compose 里设了
`security_opt: no-new-privileges:true`。两者在 Linux 容器内是否兼容无法在 macOS 上验证。
失败特征信号是 `cannot create effect on inactive context` 或 `flush on a closed handle`。

**3. `TASK_LEASE_LOST` 日志级别偏高**

```
"event":"fail_agent_review_error","error_message":"rpc fail_agent_review failed: TASK_LEASE_LOST"
```

这是设计行为：`fail_agent_review` 会撤销同 Job 其他任务的租约（一个需求失败即整个 Job 失败）。
先失败的任务撤了兄弟租约，后失败的任务记录失败时自己的租约已经没了。

后果是第二个任务的 run 行会停在 `RUNNING`，重试时 `retry_analysis_job` 会收敛成 `FAILED`，
不影响正确性。但日志级别是 error，看起来像故障。

**4. 提交被拒时的反馈可以更有用**

目前拒绝只回一个错误码。实测见过 `EVIDENCE_RANGE_OUTSIDE` 和 `EVIDENCE_ID_UNKNOWN`，
每次拒绝就是一个完整往返。可以把"你读过的合法 evidenceId 和对应行号范围"一并回给模型，
让它一次改对而不是猜。

这项要等第 1 项做完拿到数据后再评估 —— 在知道重提交到底占多少预算之前做它属于凭感觉。

**5. 模型行为层面没有自动化测试**

见第 7 节。集成测试用假模型，捕获不了"模型不收敛"这类回归。

---

## 11. 这次留下的几条经验

**用数据库查，不要用 grep 猜。** 排查"还有哪些函数有同类问题"时，`has_function_privilege` +
`prosrc` 的组合查询给出的是完备答案，grep 只能给出线索。

**先确认字段是否真的被写过，再据此推断。** `tool_calls: 0` 看起来是观测值，实际是从未被写入
的初始值。差点因此去修一个不存在的问题。

**复现失败之后要先核对复现本身是否正确。** 探针传错预算键名造成的"cancelled"和线上的
"budget exhausted"是两个不同故障，如果直接照着探针的现象改产品代码就改错了。

**测试里的假对象必须被类型检查。** 假 `JobsDb` 与真接口漂移是问题四能溜过测试的根本原因。
加上 `worker:typecheck` 之后，这类漂移在编译期就会暴露 —— 后续给 `BrokerUsageSnapshot`
加字段时它立刻生效了。

**默认静默的诊断等于没有诊断。** governor 的 denial 原本被环境变量挡着，而它恰好是终止性
事件唯一的线索。终止性事件的日志不该有开关。
