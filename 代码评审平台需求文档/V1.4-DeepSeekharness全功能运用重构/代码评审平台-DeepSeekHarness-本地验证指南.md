# 代码评审平台 V1.4：本地验证指南

> 适用范围：V1.4（DeepSeekHarness 全能力默认开启）本地改动的自查与上线前验证
> 关联文档：[`全能力流程架构`](./代码评审平台-DeepSeekHarness-全能力流程架构.md) ·
> [`最终执行方案`](./代码评审平台-DeepSeekHarness-最终执行方案.md)
> 最后一次实测：2026-09-12，macOS + Node v26.5.0 + Docker 29.7.2。本文档中每条命令与"通过的
> 样子"都是当天实际跑出来的输出，不是照抄设计稿。

## 0. 一句话

本地改完代码，**先跑第 2 节的 7 条命令全绿，再确认第 4 节的数据库迁移已应用，才能重新部署
Worker 镜像**。只重新部署镜像是不够的。

## 0.1 缺陷总表（本轮共修 22 项）

想快速了解"改了什么、为什么"看这张表就够；每项的实测证据在对应章节。

| 严重度 | 缺陷 | 后果 | 章节 |
|---|---|---|---|
| 阻塞 | 根 Agent 令牌写在 attempt patch 文件里 | 沙箱 Shell 可读整个文件系统 → 子 Agent 能读到令牌冒充根 Agent 提交 | 8、13 |
| 阻塞 | 会话恢复的兼容键两侧拼法不一致 | 每次 Worker 重启都恢复失败 | 8 |
| 阻塞 | 会话恢复的三处 API 错用（能力检测 `=== true`、`ctx.onNotification` 不存在、workspace 路径随机） | 恢复路径从未真实执行过 | 16 |
| 阻塞 | `backgroundMode: 'continuable'` | 子 Agent 停在 `[ready]` **永不执行**，多 Agent 编排完全不成立 | 11 |
| 严重 | 没有下发 child `toolFilter` | 子 Agent 拿到含提交工具的全部 30 个工具 | 11、17 |
| 严重 | `enableRunInBackground` 后台 job 静默失败 | 真实模型偏爱这条路，结果委派全程无效却表面成功 | 11、17 |
| 严重 | 后台委派的身份归属用时序推断 | 异步委派下 `IDENTITY_UNRESOLVED`，job 直接 failed | 17 |
| 严重 | 授权层拿 `toolName` 校验审计路由 | catch-22：被拒的 Agent 没权限上报自己被拒，治理审计凭空消失 | 12 |
| 严重 | `tree_digest` 含节点状态 | `finish-agent` 上报失败或并发结束时，**合法提交被误拒**（钱已花完） | 18 |
| 严重 | 资源限额是死代码 | fork bomb 与内存炸弹无实际防护 | 8 |
| 严重 | 收敛三钩子（Workflow 取消 / Jobs / DB fencing）未接线 | 生产路径全程空转，被测试手工注入掩盖 | 8 |
| 中 | `flushAudit` 失败丢数据 | 数据库抖一下，那批审计永久消失 | 12 |
| 中 | 预算耗尽报成 `-32603` 匿名协议错误 | 运维看不出真实原因 | 20 |
| 中 | 取消报成 `AGENT_ATTEMPT_FAILED` | 数据库与界面上取消和崩溃无法区分 | 20 |
| 中 | 日志脱敏缺**源码**与**网页正文** | §7.11 的两类禁止内容没有防线 | 22 |
| 中 | `endReason` 不区分租约丢失 / Worker 关停 | 事故复盘无从判断发生了什么 | 8 |
| 中 | 分层预算 DB RPC 未接线、失败路径 usage 不落库 | 失败/取消的 attempt 花费在库里是 0 | 8 |
| 中 | 0027 弄坏了 0017 的 SQL 测试 | 测试套件在全新库上不通过，无法区分"我改坏了"与"本来就坏" | 18 |
| 中 | 静默 catch × 4（三处身份解析、`finish-agent`、token 上报） | 每处都隐藏了一个真实缺口 | 17 |
| 轻 | `jobs`/`workflow` 并发上限未下传 Harness | §4 冻结的 policy 成为不生效的文档 | 8 |
| 轻 | `rejectedSubmissions` 无上界 | 失控子 Agent 能刷爆日志（实测一轮 64 条） | 12 |
| 轻 | 完成日志缺 compaction/retry/token 分项 | 分项计量在运维视角不可验证 | 14 |

> 一个贯穿全程的模式：**22 项里有 6 项是被"失败时静默吞异常"藏住的**，其中两项让核心能力完全
> 不工作。`.catch(() => undefined)` 值得作为代码审查的固定检查项，判据是"这个失败会被另一个
> 独立信号暴露吗"，答案为否就必须留痕。
>
> 另一个模式：**"只有 mock 覆盖"的代码路径，本轮无一例外都是坏的**（多 Agent 编排、会话恢复、
> 后台委派、取消矩阵）。判据不是"有没有测试"，而是"这条路真的跑起来过吗"。

---

## 1. 为什么不能只跑 `npm test`

V1.4 有一批"逻辑对但没接上"的风险点，普通单元测试看不出来，原因是单元测试把
`startProcess` 打了桩——**它根本不会真的启动 Harness 进程**。

举两个实际发生过的例子：

| 现象 | 单元测试为什么是绿的 |
|---|---|
| Session 恢复在生产必然失败 | 写 checkpoint 存的是 `0.1.5-rc.1/v3`，判定时却拿 `0.1.5-rc.1` 去比。测试桩里直接塞了裸版本号，恰好相等 |
| Profile 配置键名写错，Harness 起不来 | 单元测试只检查生成的 JSON 内容对不对，不检查 Harness 认不认这个键 |

所以本地验证分两层：

- **基础验证**（第 2 节前 5 条）：编译、类型、单元测试、前端构建、代码规范；
- **深度验证**（第 2 节后 2 条）：默认关闭，需要手动开开关，**会真的启动 dsh 进程和 Docker
  容器**。这两条是唯一能验证进程启动、凭据传递、资源限额的地方，不能省。

---

## 2. 本地验证命令（按顺序）

直接复制整块执行：

```bash
cd /Users/kingdee/codeReviewPlatform

# ---- 基础验证（约 10 秒）----
npm run worker:typecheck      # 1. Worker 类型检查
npm run worker:build          # 2. Worker 编译（后面两条深度验证依赖它，必须先跑）
npm run test:worker           # 3. Worker 单元测试
npm run build                 # 4. 前端类型检查 + 构建
npm run lint                  # 5. 代码规范

# ---- 深度验证（约 30 秒，会启动真实进程 / 容器）----
RUN_ACP_INTEGRATION=1 RUN_LINUX_PROCESS_TREE=1 npm run test:worker

# ---- 部署配置自检 ----
docker compose -f docker-compose.worker.yml config > /dev/null && echo "compose OK"
```

### 每条命令的预期结果

| # | 命令 | 通过的样子 | 它证明了什么 |
|---|---|---|---|
| 1 | `worker:typecheck` | 除 npm 自己的两行提示（`> codereviewplatform@0.0.0 ...`）外**没有输出** | Worker 侧类型无错。多出任何 `error TS...` 就是有错 |
| 2 | `worker:build` | 同上，除 npm 提示外无输出 | 编译产物写入 `dist-worker/` |
| 3 | `test:worker` | `Test Files 27 passed \| 8 skipped`<br>`Tests 482 passed \| 15 skipped` | 单元逻辑正确。**这里必然有 8 个 skipped 文件**（默认关闭的深度测试），由第 6 条、第 10 节与第 19 节分别打开 |
| 4 | `build` | `✓ built in ...ms` | 前端能编译。`chunks are larger than 500 kB` 是既有告警，不是错误 |
| 5 | `lint` | `Found 0 warnings and 0 errors.` | 代码规范 |
| 6 | 深度验证 | `Test Files 33 passed \| 2 skipped`<br>`Tests 494 passed \| 3 skipped` | 见下方说明。剩下那 1 个 skipped 是真实模型 E2E，见第 10 节 |
| 7 | `compose config` | `compose OK` | compose 文件语法有效 |

> 判断技巧：第 3 条**必须**有若干 skip（默认关闭的深度测试），第 6 条**必须**只剩 2 个 skip
> （真实模型与真实仓库那两条，都需要 API Key）。

### 第 6 条到底验证了什么

第 3 条跳过的 3 个文件在这里全部打开：

**`RUN_ACP_INTEGRATION=1`**（打开 2 个文件，共 4 个用例）—— 启动真实的 `dsh` 进程。模型被脚本
驱动，**不需要真的模型 API Key，也不联网**。

`acp-runtime.integration.test.ts`（3 个用例）：

1. 全能力 Profile 能启动。这一条最关键：Profile 里的插件配置键名如果写错，Harness 会直接
   拒绝启动，只有真的起一次进程才发现得了。
2. 模型看到的工具面正好等于契约规定的集合，不多不少。
3. 走完整链路：搜索代码 → 读代码 → 提交伪造证据被拒 → 提交合法结果成功。这条同时证明了
   **凭据通过环境变量传给插件后 Broker 调用是通的**。

`v4-all-capabilities-e2e.test.ts`（1 个用例）—— 这是执行方案**第 11 节 22 项的本地可跑部分**，
在**同一个 root attempt** 内串起真实 dsh 进程、真实全能力 Profile、真实 Broker（走 Unix
socket）、Agent Tree 与分层预算，覆盖其中 12 项：创建 Goal、Skills 在册、Agent list、并行只读
工具、Web 出口代发、overlay 写文件、Sandbox Shell 与 Jobs、产出 Artifact、根 Agent 提交、
只提交一次、sealed 后迟到调用被拒、资源清理。

**`RUN_LINUX_PROCESS_TREE=1`**（打开 1 个文件，2 个用例）—— 需要 Docker 在运行，在真实 Linux
容器里验证 Agent 起的构建/测试进程能被整棵回收干净（开发机是 macOS，这个必须在容器里测）。

耗时：整块约 30 秒，其中 Linux 容器那两条各占 11 秒左右，属正常。

> 第 6 条跑完还会剩 1 个 skipped：那是**真实模型 E2E**，需要 API Key 且会产生费用，所以单独
> 一个开关，见第 10 节。

---

## 3. 测试输出里的 JSON 日志是正常的

跑测试时会刷出大量这种行：

```json
{"level":"error","event":"agent_attempt_failed","error_code":"SESSION_FENCED", ...}
{"level":"info","event":"attempt_drained","reason":"ATTEMPT_FAILED", ...}
```

**这些不是失败**。测试在故意制造异常场景（会话被别的 Worker 抢占、日志损坏、恢复次数超限），
验证系统是否安全拒绝。**只看最后的 `Test Files` / `Tests` 汇总行**即可。

---

## 4. 数据库验证（重要，容易漏）

### 4.1 本地验证

这一版新增两个迁移：`0027_v4_harness_all_capabilities.sql` 与
`0028_tree_digest_excludes_status.sql`（后者见第 18 节）。

**先查本地库有没有应用它**（只读，安全）：

```bash
docker exec -i supabase_db_codeReviewPlatform \
  psql -U postgres -d postgres -tAc \
  "select count(*) from pg_proc where proname='commit_analysis_agent_usage';"
```

- 返回 `1` → 已应用，**跳过 reset**，直接跑下面的契约测试；
- 返回 `0` → 需要重建本地库（见下方 ⚠️）：

```bash
supabase db reset --no-seed      # 预期迁移 0001 顺序执行到 0028
```

跑**全部** SQL 测试（本机没装 `psql`，走数据库容器；每个文件自身用 `BEGIN...ROLLBACK`，
**不留测试数据**）。只跑 0027 是不够的——本轮就是靠跑全套才发现 0027 把 0017 的测试弄坏了：

```bash
for t in 0010_ai_automation_mvp_test 0017_agent_execution_engine_test \
         0018_execution_engine_admin_actor_test 0019_single_harness_execution_test \
         0020_remove_model_provider_test 0027_v4_harness_all_capabilities_test; do
  printf "%-46s " "$t"
  docker exec -i supabase_db_codeReviewPlatform \
    psql -v ON_ERROR_STOP=1 -U postgres -d postgres < "supabase/tests/${t}.sql" 2>&1 \
    | grep -oE "ALL_[A-Z_]*PASSED|ERROR:.*" | head -1
done
```

通过的样子——六行全部是 `ALL_..._PASSED`：

```
0010_ai_automation_mvp_test                    ALL_AI_AUTOMATION_MVP_TESTS_PASSED
0017_agent_execution_engine_test               ALL_AGENT_EXECUTION_ENGINE_TESTS_PASSED
0018_execution_engine_admin_actor_test         ALL_EXECUTION_ENGINE_ACTOR_TESTS_PASSED
0019_single_harness_execution_test             ALL_SINGLE_HARNESS_EXECUTION_TESTS_PASSED
0020_remove_model_provider_test                ALL_REMOVE_MODEL_PROVIDER_TESTS_PASSED
0027_v4_harness_all_capabilities_test          ALL_V4_HARNESS_CAPABILITY_TESTS_PASSED
```

> ⚠️ `supabase db reset` 会**清空本地数据库**，所以上面先做了检查——已应用就不需要 reset。
> 只对本地库执行，**绝不要对 linked/远端项目执行 reset、push 或测试脚本**。
> 容器名如果不同，用 `docker ps --format '{{.Names}}' | grep supabase_db` 查实际名字。

### 4.2 上线前：确认目标库已有 0027

这是**最容易漏的一步**。V4 Worker 依赖 0027 新增的一批 RPC，库里没有的话 Worker 起来了也
领不到任务。用这条只读语句检查（安全，不改数据）：

```sql
select count(*) from pg_proc where proname = 'commit_analysis_agent_usage';
```

本机没装 `psql`，可以在 **Supabase 控制台的 SQL Editor** 里直接执行；或者在有 `psql` 的机器上：

```bash
psql "$目标库连接串" -c "select count(*) from pg_proc where proname='commit_analysis_agent_usage';"
```

- 返回 `1` → 0027 已应用，可以部署镜像；
- 返回 `0` → **先应用迁移，再部署镜像**。

---

## 5. 要不要配置什么

| 项目 | 要不要配 | 说明 |
|---|---|---|
| `REVIEW_BROKER_ACCESS_TOKEN` | **不要配** | Worker 每次 attempt 自己生成并注入给 Harness 子进程，运维不需要也不应该配置 |
| `REVIEW_ROOT_CAPABILITY_TOKEN` | **不要配** | 同上 |
| `AGENT_SESSION_RETENTION_DAYS` | 可选 | Session 日志保留天数，默认 7，范围 1–365 |
| compose 资源上限 | **必须核对** | 见下方 |

### 必须核对：容器资源上限

`docker-compose.worker.yml` 这一版新增了三项，它们不是容量规划参数，而是沙箱边界的一部分：

```yaml
pids_limit: 512      # 进程数硬墙，挡 fork bomb
mem_limit: 6g        # 内存上限，挡内存炸弹
ulimits:
  nofile: { soft: 4096, hard: 8192 }
  core: 0            # 不产生 core dump（可能含内存里的凭据）
```

**上线前先算一遍内存**：

```
默认 4 副本 × mem_limit 6g = 24 GB
```

宿主机内存不够就下调 `mem_limit` 或减少副本数。

**调整 `pids_limit` 时注意下限**：它必须 ≥ `maxProcessesPerAttempt(64) × 每副本 story
槽位数(2)` 再加 Worker 自身开销，调得太小会让正常的构建/测试**随机失败**，而且报错信息很难
定位。

---

## 6. 部署顺序

```bash
# 1. 本地验证全绿（第 2 节）
# 2. 确认目标库已有 0027（第 4.2 节）；没有就先应用迁移
# 3. 核对宿主机内存够不够（第 5 节）
# 4. 构建并滚动重启
docker compose -f docker-compose.worker.yml up -d --build --scale worker=4
# 5. 连通性检查
npm run worker:check-connectivity
# 6. 观察日志
docker compose -f docker-compose.worker.yml logs -f --tail=100 worker
```

**滚动重启期间新旧 Worker 共存是安全的**，已核对过三点：新 Worker 能正确恢复旧 Worker 写下
的会话 checkpoint；新增的两个用量 RPC 只有新 Worker 会调用；凭据传递完全发生在单个 Worker
进程与它自己的 Harness 子进程之间，不存在跨 Worker 约定。

---

## 7. 排错表

| 现象 | 原因 | 怎么办 |
|---|---|---|
| 第 6 条仍显示 `skipped` | 环境变量没生效 | 确认写成 `RUN_ACP_INTEGRATION=1 npm run ...`，等号两边无空格 |
| 第 6 条报找不到 `dist-worker` 或插件 | 没先编译 | 先跑 `npm run worker:build` |
| 第 6 条 Linux 那两条超时/报错 | Docker 没运行 | 启动 Docker Desktop；只想跑集成测试就单独用 `RUN_ACP_INTEGRATION=1` |
| 启动时报 `credential environment variable ... would survive into sandboxed shell children` | 有人改了凭据环境变量名，新名字不含 `KEY`/`TOKEN`/`SECRET`/`PASSWORD` | 改回符合规则的名字。这是安全闸门，见第 8 节 |
| 启动时报 `carries a credential-shaped field` | 有人把令牌写回了 attempt patch 文件 | 令牌必须走环境变量，不能落盘。见第 8 节 |
| 运行中报 `SESSION_FORMAT_UNSUPPORTED` | 会话格式/版本变了，按设计拒绝恢复 | 正常行为，平台会开新 attempt，不需要处理 |
| 构建/测试随机报 `fork: Resource temporarily unavailable` | `pids_limit` 太小 | 按第 5 节的下限调大 |
| Worker 起来了但一直领不到任务 | 目标库缺 0027 | 见第 4.2 节 |

---

## 8. 这一版改了什么（便于回溯）

对照执行方案审查后修复的问题，按重要性排列：

| 编号 | 问题 | 修复方式 |
|---|---|---|
| B1 | 根 Agent 的令牌写在 attempt patch 文件里，而沙箱 Shell 能读整个文件系统——子 Agent 可以读到令牌冒充根 Agent 提交，击穿"根 Agent 唯一提交"边界 | 令牌改走环境变量，变量名命中 Harness 的凭据剥离规则（Harness 在启动模型可见的 Shell 前会按变量名丢弃 `KEY`/`TOKEN`/`SECRET`/`PASSWORD`）。加了两道启动期闸门防回退 |
| B2 | Session 恢复在生产必然失败（写入与判定用了不同格式的版本串） | 两侧强制走同一个函数构造兼容键。**已用注入原缺陷的方式验证回归测试有效** |
| B3 | 资源限额是死代码，fork bomb 和内存炸弹实际无防护 | 用 `sh -c 'ulimit …; exec dsh …'` 启动 Harness，限额由所有后代继承；内存和进程数硬墙交给容器 |
| S1 | 收敛时的 Workflow 取消和数据库 fencing 三个钩子没接线，生产路径全程空转（测试因为手工注入而是绿的） | 钩子类型改为"必填且可为 null"，强制每个构造点表态，测试再也无法与生产脱节 |
| S2 | 租约丢失、Worker 关停、用户取消三种情况都被记成"用户取消" | 新增原因判定，三者分开记录 |
| S3 | 分层预算的两个数据库 RPC 从未被调用；失败/取消的 attempt 用量在库里是 0 | 两个 RPC 都接上；用量在**每条**终态路径落库 |

另外修正了一处误报：Shell 并**没有**继承模型 API Key，Harness 自己的子进程层会按变量名剥离
凭据。原代码注释表述不准，已改正并加断言锁住这条依赖。

### 过程中发现的一个自身错误

第一版 B3 修复用了 `ulimit -u 64` 限制进程数，实测直接报 `fork: Resource temporarily
unavailable`。原因：这个限额**按用户 ID 全局计数**，不是按进程树计数，而容器默认共享宿主的
用户命名空间——4 个副本的同一个用户会合并计数。上线后会表现为正常构建随机失败。已改为交给
容器的 `pids_limit`（按容器计数，是正确的原语）。

---

## 9. 本地验证覆盖不到的部分

执行方案第 11 节要求：**用一个真实固定 Commit 的小 Job，在同一个 attempt 内证明 22 项能力**。

本地覆盖分两块：第 2 节第 6 条的 smoke E2E（脚本模型）证明了平台管道，第 10 节的真实模型
E2E 证明了模型自主行为。合起来的实测结论见第 10 节的表格。

**字面意义的第 11 节已完成**，见第 19 节：`v4-real-repo-e2e.test.ts` 已用 GitLab 上的真实
commit `3755ca6f36b0` 跑通（12.4 MB 真实源码物化、Evidence 绑定真实 blob）。

> 早先本节记录"GitLab 不可达所以做不了"。那是环境的**瞬时**状态：该主机的连通性时有时无
> （同一条命令可能一次 52 秒跑通、下一次 68 毫秒报 `ls-remote` 失败）。判定"环境阻塞"之前
> 应当多试几次并用 `curl` 单独确认。

---

## 10. 真实模型 E2E（已实测）

第 2 节第 6 条里的模型是脚本，证明不了"模型真的会用这些能力"。所以另有一条真实模型测试：

```bash
# 前置：.env.local 里配好 REVIEW_MODEL_API_KEY / E2E_MODEL_BASE_URL / E2E_MODEL_NAME
set -a; . ./.env.local; set +a
npm run worker:build
RUN_REAL_MODEL_E2E=1 npx vitest run worker/src/__tests__/v4-real-model-e2e.test.ts

# 换模型或调预算
E2E_MODEL_NAME=deepseek-v4-pro E2E_MAX_MODEL_REQUESTS=60 \
  RUN_REAL_MODEL_E2E=1 npx vitest run worker/src/__tests__/v4-real-model-e2e.test.ts
```

它不连数据库、不连 GitLab：本地现造两个真实 git 仓库（约 40 个文件，6 条验收标准，其中第 6 条
故意只实现一半），真实 dsh 进程、真实全能力 Profile、真实 Broker 走 Unix socket，只有模型是
外部的。`commitReview` 与数据库钩子都是内存替身。

**断言策略分两层**，这个区分是这条测试可信的前提：

- **硬断言**：无论模型怎么做都必须成立的安全不变量——最多提交一次、提交主体必须是平台生成的
  根身份、入库 Evidence 必须绑定固定 Commit 与真实 blob、模型请求不超预算、收敛后零存活进程、
  attempt 目录删干净。这些失败就是缺陷。
- **观测报告**：模型这一次用了哪些能力。**不做硬断言**——模型有权判断"这个任务不需要子 Agent"，
  那不是缺陷。

### 实测结果（2026-09-12，deepseek-v4-pro）

| 观测项 | 场景一：模型自主判断 | 场景二：需求要求按模块并行 |
|---|---|---|
| 结果 | committed | committed |
| 模型请求 | 13（root 13 / child 0） | **19（root 9 / child 10）** |
| 真实 token | 输入 33999 / 输出 8610 | 输入 44239 / 输出 18875 |
| Agent 总数 | 1 | **5** |
| 最大委派深度 | 0 | **1** |
| 根工具面 | 30 个 | 30 个 |
| 委派类工具 | 未使用 | **subagent** |
| Broker 路由 | 无 register-agent | **含 register-agent** |
| Evidence | 23 | 17 |
| 收敛 | COMMITTED，存活进程 0 | 同 |

场景一里模型不委派是**正确判断**（任务一个上下文读得完，而 Prompt 明确要求"不要无节制地创建
子 Agent"）。场景二用需求文本明确要求并行，才把子 Agent 治理路径逼出来。

### 真实模型验证到的（脚本模型证明不了的）

1. `todo_write` 被真实调用——Todo 能力在真实决策下生效；
2. 一次运行中模型编造了 evidenceId，平台返回 `EVIDENCE_ID_UNKNOWN` 拒绝，模型改正后重新提交
   成功——**证据校验的"拒绝—改正—重提交"在非脚本条件下成立**；
3. **真实多 Agent 编排**：root 派出 4 个子 Agent，子 Agent 注册进 authority ledger、走分层预算
   （10 次 child 请求）、贡献证据，最终由 root 唯一提交一次；
4. 预算与 token 是 provider 上报的真值；
5. 真实物化只读快照与收敛清理（0 存活进程）。

### ⚠️ 这一节此前写错过，务必注意

早先版本的本文档写着"委派未触发，但这是模型的正确判断，不是缺陷"。**那个结论是错的。**

真相是：多 Agent 编排当时**完全不工作**，三个配置缺陷叠加导致的（见第 11 节）。因为委派失败
是静默的——模型调用 `subagent` 拿到一个 id，然后什么也等不到，只好自己把活干完，最后照样成功
提交——所以从外部看起来就像"模型选择不委派"。

教训：**"模型没用某个能力"不能直接推断为"模型判断不需要"**，必须先证明该能力真的可用。判据是
`agent_count`（来自 authority ledger）与 `child_model_requests`（来自分层预算账本）这两个平台侧
的硬计数，而不是模型的行为表现。

---

## 11. 多 Agent 编排的三个缺陷（已修复）

这一批是本轮测试挖出来的，**比其他所有问题都严重**：架构文档第 3 节的核心卖点"Harness 自动
规划、拆分、多 Agent 并行执行"在修复前**完全不成立**。

三个配置缺陷叠加：

| # | 缺陷 | 实测证据 | 修复 |
|---|---|---|---|
| 1 | `tool-subagent` 配成 `backgroundMode: 'continuable'` | `subagent` 立即返回 `started subagent <id>`，子 Agent 停在 `[ready]` **永不执行**；8 轮 `list_agents` 状态不变，显式 `send_message` 也不动；ledger Agent 数恒为 1、child 请求恒为 0 | 改为 `one-shot` |
| 2 | 没有下发 child `toolFilter` | 子 Agent 拿到与根 Agent 完全相同的 30 个工具，**含 `submit_review_result`** | 新增 `childToolSurface()`，下发 21 个工具的 allow 列表 |
| 3 | `enableRunInBackground` 默认开启 | `run_in_background: true` 的 job 状态 running → **failed**，子 Agent 一次请求都没发，`job_output` 只回 `[status: failed, error]`，平台侧无任何错误 | 关闭该参数 |

缺陷 1 的根因是语义不匹配：continuable 是为"父 Agent 在**后续 turn** 收子 Agent 完成通知"设计的，
而本平台一次 attempt 只驱动一个 root turn（`runSingleAcpTurn`），turn 一结束引擎就收敛。

缺陷 3 最阴险：真实模型看到需求里写"并行核查"就优先选后台模式，拿到 job id、调 `job_output`、
什么也等不到，然后自己把活干完——**表面成功提交，实际委派全程无效**。

修复后三条委派路径实测（`v4-subagent-diagnosis`，脚本模型）：

```
subagent        ledger Agent 数: 2   child 请求: 1
subagent_fork   ledger Agent 数: 2   child 请求: 1
workflow        ledger Agent 数: 3   child 请求: 10
```

### 残留已解决：workflow 子 Agent 工具面现已收窄

> 本节此前记录 workflow 子 Agent 无法收窄，那是基于"收窄只能靠 `tool-subagent` 的 `toolFilter`
> 配置"这个前提。前提是错的——见第 18 节，已用 `agent/created` + `tools.restrict()` 统一解决。

`toolFilter` 配在 `tool-subagent` 工具上，而 workflow 走 `workflow-worker-thread` 直连 provider，
其 `agent(prompt, opts)` → `startAgent()` 只转发 `prompt`/`schema`/`provider`/`model`，**不转发
toolFilter**。所以单靠那条配置，workflow 子 Agent 仍然看得见全部 30 个工具。

当时实测对照：

```
subagent 场景：子 Agent 请求 tools=21 submitTool=no    ← 收窄生效
workflow 场景：子 Agent 请求 tools=30 submitTool=YES   ← 收窄不生效
```

即便如此**安全底线当时也成立**：让 workflow 子 Agent 真的调用 `submit_review_result` 30 多次，
`commitReview` 调用次数为 **0**，每次都收到明确拒绝。root-only 提交没有被突破。

## 12. 审计链路的两个缺陷（已修复）

排查上面那个残留风险时又挖出两个，都属于"静默吞掉失败"这一类：

| # | 缺陷 | 后果 | 修复 |
|---|---|---|---|
| 1 | 授权层对**所有**非注册路由都拿 `envelope.toolName` 校验权限 | "上报我调用 `submit_review_result` 被拒了"被当成"我要调用 `submit_review_result`"，必然 403 —— **被拒的 Agent 恰恰没有权限上报自己被拒**。实测子 Agent 被正确拒绝 30+ 次，`rejected_submissions` 与 `analysis_permission_decision` 里一条记录都没有 | 审计路由的 `toolName` 是被审计对象而非调用对象，不再参与权限校验；路由自身的 `usageReport` capability 照常校验 |
| 2 | `flushAudit` 先 `splice` 取走再落库，失败只记日志 | 数据库抖一下，那批工具审计与 permission decision 永久消失 | 失败后重排队（上界 2048），由后续 flush 重试；超界丢弃显式记入日志 |

另外把 `rejectedSubmissions` 加了上界（20 条）并新增 `rejectedSubmissionTotal` 真实总数——一个
循环重试的子 Agent 实测一轮就能产生 64 条，无界数组等于把日志交给模型行为控制。

两条修复都有回归测试锁住（`v4-broker-authority.test.ts`），并已用注入原缺陷的方式验证有效：
注入后精确失败于 `expected 403 to be 200` 与 `expected 0 to be greater than 0`。

## 13. 生产镜像内的沙箱实测（安全模型前提核验）

前面几节的安全推理都依赖一个前提：**`workspace-write` 沙箱只限制写、不限制读**。这一节是在
真实 Worker 镜像里用真实 Landlock 启动器实测的结果，不是推理。

先确认沙箱可用：镜像内 `probe()` 返回 `"full"`，即 Landlock 完全可用，Shell / Filesystem 工具在
生产可用（如果沙箱不可用，`dsh-sandbox-local` 会 fail closed，Shell 工具直接不能用）。

再复刻 `workspace-write` 的 profile（`readOnly:["/"]` + `readWrite:["/dev/null","/tmp",workspace]`）
逐项测试：

| 操作 | 结果 |
|---|---|
| 读 workspace 外的文件（`/etc/passwd`） | **允许** |
| 读 attempt 目录（DSH_HOME 所在） | **允许** |
| 写 workspace 内 | 允许 |
| 写 workspace 外（attempt 目录） | 拒绝 |
| 写 `/etc` | 拒绝 |
| 写 `/tmp` | 允许 |

两个结论：

1. **凭据绝不能落盘。** 沙箱外可读被实测确认，所以 attempt patch 文件里的令牌一定会被拿到
   Shell 的子 Agent 读到。第 8 节 B1 那个修复（凭据走命中剥离规则的环境变量）不是"更好的做法"，
   而是**唯一可行**的做法。
2. **写隔离在生产上确实生效**（§7.4）：固定快照、attempt 目录、系统路径都写不了。

### 为什么不装 bubblewrap

bwrap 档的 `--tmpfs /tmp` 本来能把 Broker socket 挡在沙箱视野外。但实测在默认 Docker 容器里
bwrap 起不来：

```
bwrap: Creating new namespace failed: Operation not permitted
```

Docker 默认 seccomp 拦住了非特权用户创建 namespace。要让它可用得 `--privileged` 或放开 seccomp
——用更大的削弱换更小的加固，不划算。所以镜像**刻意不装**，生产上生效的是 Landlock 档。

## 14. 第 11 节第 14/15 项已验证（自动压缩与结果裁剪）

用 `DIAG_TOOL=bigread` 反复读一个 8000 行大文件，通过调小上下文窗口做 A/B：

| 上下文窗口 | 压缩请求数 | 请求体字节（最大值＝末次值） |
|---|---|---|
| 8192 | **8** | 133072 |
| 131072 | **0** | 340568 |

- **第 15 项（自动上下文压缩）**：小窗口下触发 8 次，且被分层预算按 `compaction` 分类计量——
  §7.6-8"compaction usage 纳入预算和审计"成立。
- **第 14 项（工具结果裁剪）**：大窗口下压缩为 0，但 26 次大范围读取后请求体仍稳定在 340568
  不再增长。压缩没参与，上下文却有界，这**隔离出了裁剪单独在起作用**。

顺带修了一个可观测性缺口：`agent_attempt_finished` 此前只记 `model_requests` 与 root/child 分解，
不记 `compaction_requests` / `retry_requests` / token——分项计量在运维视角不可验证。现已补齐。

## 15. 后台进程回收实测（`jobs: null` 不是缺口）

引擎给 `AttemptTreeController` 传的 `jobs` 是 `null`（平台没有 Harness Job 清单可枚举）。实测这
不构成清理缺口——用 `DIAG_TOOL=job` 起明显活过 attempt 的后台进程：

| 场景 | 平台报告存活进程 | 外部 `pgrep` 独立核实 |
|---|---|---|
| `nohup sleep &`（同进程组） | 0 | 0 残留 |
| `setsid sleep &`（脱离进程组） | 0 | 0 残留 |

两种都零残留，`cleanup_failed=false`。而且平台侧的 Job 登记也看不到 `setsid` 出去的孙进程，所以
补一个 Job 登记路由并不会提高清理保证——真正兜底的是 `session/cancel` 加进程组回收，再加容器边界。



## 16. 会话恢复的三个缺陷（已修复，第 11 节第 16 项）

`v4-session-resume-wiring` 单测覆盖的是**判定逻辑**，证明不了"真实 dsh 到底认不认
`session/resume`"。新增 `v4-session-resume-real.test.ts` 跑两阶段真实进程（阶段一留一个未提交
会话，阶段二用阶段一写下的 checkpoint 恢复），一次挖出三个缺陷——**恢复路径此前从未真实执行过，
所以里面的错误一路没被发现**：

| # | 缺陷 | 实测报错 | 修复 |
|---|---|---|---|
| 1 | 能力检测写成 `sessionCapabilities?.resume === true`，而 dsh 声明的是 `resume: {}`（空对象） | `the agent advertises neither session/resume nor session/load` | 改为"键存在且不是 false/null"即视为支持（`{}` 与 `true` 都接受） |
| 2 | 恢复路径调 `ctx.onNotification(...)`，而 SDK 的 ClientContext 只有 `buildSession / attachSession / request / notify` | `ctx.onNotification is not a function` | 把 `session/update` 订阅移到 **app 层**（`app.onNotification`），仅在恢复时注册，避免与 builder 内部消费冲突 |
| 3 | attempt workspace 用 `mkdtempSync` 生成**随机**路径 | Harness 的 `resumeSession` 校验 `sameDirectory(persisted.cwd, params.cwd)`，重启后 cwd 必然不同 → `session cwd does not match` | 目录名改为按 `sha256(taskId:agentAttempt)` **确定性派生**，并复用已存在目录（保留上次 attempt 写出的 overlay 与 Artifact） |

三个叠加的后果：**§7.7 的完成标准"Worker 重启后可继续同一未提交 Session"从未成立**。整套 JSONL
持久卷、checkpoint、`session_revision`、单写者锁与 fencing 机器都在正常工作，但没有一次真正恢复过
会话——每次重启都 fail closed 开新 attempt（好在是 fail closed，不是静默从零开始）。

修复后实测：

```
阶段一 session:   7950c593-...
阶段一兼容键:     0.1.5-rc.1/v3
日志落点:         <sessionRoot>/attempt-<digest>/.../session.v3.jsonl
阶段二 resumed:   true      ← 真实 dsh 接受了 session/resume
```

> 顺带一个必须记住的约束：**attempt workspace 路径现在是确定性的**。
> `AGENT_ATTEMPTS_ROOT` 必须是持久卷（compose 里已经是 `worker-attempts`），否则重启后目录消失，
> cwd 校验同样过不了。

## 17. 后台并行委派与统一工具面收窄（已修复）

### 后台委派此前必然失败，根因在平台自己的身份归属

`subagent` 带 `run_in_background: true` 时，job 状态 running → **failed**，子 Agent 一次模型请求
都没发。追到子进程 stderr 才看到真因：

```
[usage-reporter] IDENTITY_UNRESOLVED {"kind":"loop","hasSession":true}
```

平台判断"子 Agent 的父是谁"用的是**时序推断**——"当前正在执行委派工具的那个 Agent 就是父"。这个
不变量对同步委派成立，对后台委派**不成立**：`subagent` 立即返回 job id，`post-execute` 清掉委派
标记之后子 Agent 才异步启动，那一刻栈上已经没有委派了 → 身份解析失败 → 模型请求被 fail closed
拒绝 → job failed。而失败原因既不进平台日志也不给模型，表现成"后台委派静默无效"。

**修复**：lineage 的第一来源改为 Harness 写在子会话头部的 `parentSession` / `delegationDepth`
（`dsh-subagent` 的 `childSessionMeta`），由 Harness 设置、模型无法伪造、**与同步异步无关**；
时序推断降为兜底。头部指向未注册的父、或没有 `origin === 'subagent'` 标记时**不做任何猜测**，
仍然 fail closed。

修复后实测（两个后台子 Agent 并行）：

```
ledger 记录 Agent 数: 3     （root + 2）
预算账本 child 请求:  2
Broker 路由计数:      register-agent: 2
job 状态:             两个都 [status: completed]，各自带回结论
```

真实模型（deepseek-v4-pro）也确认走通：调用链是 `subagent` → `job_list` → `job_output`，
Agent 5 个、child 12 次请求、提交一次、收敛 0 存活进程。因此 `enableRunInBackground` 已恢复开启——
默认仍是阻塞（`backgroundMode: 'one-shot'`），模型需要并行时可以显式转后台。

### 顺带修掉第三个"静默吞掉失败"

`usage-reporter` 里 `.resolve(...).catch(() => null)` 把身份解析失败的原因整个扔了，只留一行
`IDENTITY_UNRESOLVED` —— 正是这个吞掉让上面那个根因埋了很久。现在会带出 `cause`（错误码+消息）。

这是本轮第三次遇到同类缺陷（前两次见第 12 节）。**"失败时静默降级/吞异常"是这个代码库里反复出现
的模式，值得作为专项检查项。**

### 子 Agent 工具面收窄改为统一入口

`tool-subagent` 的 `toolFilter` 配置只作用于经那个工具创建的子 Agent。改为监听 `agent/created`，
对新 Agent 的 scoped context 调 `tools.restrict({ allow: childTools })` —— 这是唯一覆盖**全部**
委派路径的收窄点。判据同样用权威会话头部的 `origin === 'subagent'`，因此根 Agent 不会被误收窄。

四条路径实测（子 Agent 请求的工具面）：

| 委派方式 | 子 Agent 工具数 | 含提交工具 |
|---|---|---|
| `subagent`（阻塞） | 21 | 否 |
| `subagent_fork` | 21 | 否 |
| `workflow` | 21 | 否 |
| `subagent`（后台并行） | 21 | 否 |

`allow` 名单若包含当前 composition 未注册的工具，`restrict()` 会抛错；那种情况退到
`deny: ['submit_review_result']` 的最低保证，并写 stderr 留痕——两级都失败才放弃，绝不静默还原成
根 Agent 的全集。

诊断测试里"子 Agent 不得看到提交工具"已从观测项提升为**硬断言**。

### 静默 catch 专项排查（本轮共修 7 处）

第 12 节与本节前半已修 3 处，随后做了一次全仓排查（`grep .catch(() => undefined|null)`），
在 20 处命中里又找出 4 处会隐藏真实缺口的：

| 位置 | 隐藏了什么 | 修复 |
|---|---|---|
| `snapshot-tools` / `review-control-tool` / `platform-web` 三处身份解析 | 各自 `resolve().catch(() => null)` 后抛一句笼统的"没有可验证的身份"——错误码被扔掉。正是这个模式让后台委派的 `AGENT_IDENTITY_INVALID` 藏了很久 | 抽出 `resolveCallerIdentity()`，失败时抛出**带错误码与原因**的错误 |
| `agent-identity` 的 `finish-agent` 上报 | 上报失败后本地令牌照删，而 DB 里节点停在 RUNNING —— 两侧 `tree_digest` 不一致，表现为**合法提交被 `AGENT_IDENTITY_INVALID` 误拒**的随机故障 | 失败写 stderr 留痕 |
| `usage-reporter` 的 token 上报 | token 用量静默丢失，库里 usage 偏小，成本核对失真 | 失败记 `USAGE_REPORT_FAILED` |

剩下 13 处是合理的（收敛路径上的 `terminate()` / `close()` / `session/cancel` 等——那里"尽力而为"
是正确语义，且失败会由 `surviving_pids` / `cleanup_failed` 这些独立信号暴露）。

> 这条经验值得固化：**本轮 7 个缺陷里有 4 个是被静默 catch 藏住的**，包括两个让核心能力完全
> 不工作的缺陷。`.catch(() => undefined)` 应作为代码审查的固定检查项——判据是"这个失败会被
> 另一个独立信号暴露吗？"，答案为否就必须留痕。

## 18. tree_digest 与 SQL 测试套件（已修复）

### tree_digest 含节点状态会误拒合法提交（迁移 0028）

`analysis_agent_tree_digest` 与 Worker 侧的 `treeDigest()` 都把 `status` 计入摘要。摘要要证明的是
"提交时看到的这棵树就是数据库里注册过的那棵树"，状态对这个结论没有贡献，却引入了一条真实的
误拒路径：

1. 子 Agent 结束时 Worker 调 `/attempt/finish-agent`。这次上报失败（数据库抖动）时，本地账本已是
   FINISHED，数据库仍是 RUNNING；
2. 根 Agent 提交，Worker 用 FINISHED 算摘要、数据库用 RUNNING 算摘要；
3. 两者必然不等 → `save_agent_review_result` 抛 `AGENT_IDENTITY_INVALID`。

一次**完全合法**的提交被拒，而且是在模型费用全部花完之后。同一个窗口在"子 Agent 恰好与提交并发
结束"时也会命中，与上报是否失败无关。

实测证据（同一棵树，root + 一个子 Agent）：

```
子 Agent RUNNING  摘要: 8a7381d47fb66494…
子 Agent FINISHED 摘要: 8af71c685807b8da…   ← 不同
```

**修复**：新增迁移 `0028_tree_digest_excludes_status.sql`，摘要只覆盖身份与血缘
（agent_id、父 agent_id、role、provider、delegation_depth、tool_policy_hash），TS 侧同步去掉
`status`。未注册的 Agent、被改过父节点的 Agent、角色或工具策略不符的 Agent 仍然会让摘要不匹配，
**安全性质不变**；节点状态仍逐节点持久化在 `analysis_agent_node.status`，可追溯性不损失。

两侧一致性已交叉核对：同一批节点，TypeScript 与 PostgreSQL 都得出
`a041ed448d6f53a32c022dfa4f84b9e6b822b6e289c10613742a251c78d19f60`。新增断言：节点状态变化时
摘要必须不变（TS 与 SQL 两侧各一条）。

用**新迁移**而不是回改 0027：0027 可能已经应用到某些环境，前滚替换函数才是安全做法。

### 0027 弄坏了 0017 的 SQL 测试，此前没人发现

在全新库上（`supabase db reset` 之后）跑全套 SQL 测试，`0017_agent_execution_engine_test` 失败。
逐步定位到三个原因，全部是 0027 引入的新契约没有回灌到老测试：

| 现象 | 原因 |
|---|---|
| `ASSERT FAILED: the first task is claimed deterministically` | `claim_next_story_task` 只领 `policy_version = 4` 的 Job，而老测试直接 insert 的 Job 拿的是默认值——默认值本身是 4，所以其实能领；真正卡住的是后续链路 |
| `SUBMIT_ROOT_ONLY` | V4 提交要求数据库里已注册 root Agent 节点 |
| `AGENT_IDENTITY_INVALID`（两处） | `record_analysis_attempt_profile` 要求 `p_tree_digest` 非空，且 `job.policy_hash` 必须与上报值一致——老测试的 Job 直接 insert，没有 `capability_policy_snapshot` / `policy_hash` |

**修复**：把 0017 的测试现代化到 V4 语义——Job 夹具与 `enqueue_analysis_job` 冻结的字段对齐
（`capability_policy_snapshot` + `policy_hash`），提交前按真实顺序
`record_analysis_attempt_profile` → `register_analysis_agent_node(root)` → `save_agent_review_result`，
并抽了一个 `pg_temp.v4_identity()` 辅助函数拼可信身份。它覆盖的 claim-token fencing、唯一提交、
重试与 finalize 在 V4 下依然是有效契约，测试意图没有变。

> **教训**：0027 的作者更新了 0027 自己的测试，但没有回过头跑 0001..0026 的测试。本文档第 4 节
> 原先也只让跑 0027 那一个文件——已改成跑全套六个。

## 19. 真实仓库 E2E（第 11 节字面要求，已完成）

方案第 11 节要的是"用一个**真实固定 Commit** 的小 Job"。前面的真实模型 E2E 用的是本地现造的
git 仓库，覆盖不到取回链路与真实工程规模。新增 `v4-real-repo-e2e.test.ts` 补上这一段：

```bash
set -a; . ./.docker/worker.env; . ./.env.local; set +a
RUN_REAL_REPO_E2E=1 npx vitest run worker/src/__tests__/v4-real-repo-e2e.test.ts

# 可覆盖：E2E_REPO / E2E_BRANCH / E2E_COMMIT
```

它覆盖本地造仓库覆盖不到的四件事：

1. `prepareRepository()` / `prepareRepositoryAtSnapshot()` 的真实浅取、SHA 校验与只读缓存发布
   （不传 `E2E_COMMIT` 走前者，传了走后者，两条生产路径各覆盖一次）；
2. 真实工程规模下的检索（文件数、目录深度、非 ASCII 路径与内容）；
3. Evidence 绑定的是**真实 commit 的真实 blob**，由平台从固定快照重新读出；
4. 固定 Commit 只读物化到 Workspace 后，Shell / Filesystem 看到的是真实源码树。

实测结果（deepseek-v4-pro）：

```
仓库:      kdmanage-backend
commit:    3755ca6f36b0
提交主题:  Merge branch 'cherry-pick-9e10a8c1' into 'feature_dev'
结果:      committed
模型请求:  9 / 上限 40
Evidence:  5           ← 全部断言绑定真实 commit SHA 与 40 位 blob SHA
Workspace: 12414018 字节（12.4 MB 真实源码物化）
收敛:      COMMITTED，存活进程 0，attempt 目录已清空
```

两个实用注意点：

- **GitLab 连通性在本环境时有时无**。同一条命令可能一次 52 秒跑通、下一次 68 毫秒就报
  `git fetch failed: ls-remote`。失败时先用
  `curl -sS -o /dev/null -w '%{http_code}\n' https://git.kingdee.com/` 确认网络，别误当成产品缺陷。
- **快照缓存是只读的**（`chmodReadOnlyRecursive` 设 0500/0400），直接 `rm -rf` 会 `ENOTEMPTY`。
  测试清理里先 `chmod -R u+rwX` 再删。生产上代码缓存按 SHA 长期复用，不需要删。

## 20. 取消收敛矩阵与两个错误码缺陷（已修复）

方案 §7.8.6 要求区分五种收敛触发。此前只有内存对象的单测覆盖，而取消牵涉引擎、Broker、
ACP 客户端、Harness 子进程、进程组回收五层，任何一层没接上，表现都是"看起来取消了，其实
有东西还在跑"。新增 `v4-cancel-convergence.test.ts` 在**真实 dsh 进程 + 真实子 Agent**
下逐一验证：

```bash
RUN_ACP_INTEGRATION=1 npx vitest run worker/src/__tests__/v4-cancel-convergence.test.ts
```

四个场景实测结果：

| 场景 | 收敛原因 | 错误码 | 取消的 Agent 数 | 存活进程 |
|---|---|---|---|---|
| 用户取消 | `USER_CANCELLED` | `AGENT_TREE_CANCELLED` | 2 | 0 |
| 租约丢失 | `LEASE_LOST` | `AGENT_TREE_CANCELLED` | 2 | 0 |
| Worker 关停 | `WORKER_SHUTDOWN` | `AGENT_TREE_CANCELLED` | 2 | 0 |
| 预算耗尽 | `BUDGET_EXHAUSTED` | `MODEL_BUDGET_EXHAUSTED` | 2 | 0 |

每个场景都断言：收敛原因是预期那一个、不产生任何 commit、进程组回收干净、attempt 目录清空、
admission 先关后收敛。取消发生在模型真的跑起来之后（断言 `模型命中 ≥ 2`），否则用例什么都没验证。

### 缺陷一：预算耗尽被报成匿名协议错误

`usage-reporter` 把预算拒绝作为 chunk 交给模型（这样模型能看懂并停下），Harness 随后把它变成一个
JSON-RPC 内部错误 —— 实测引擎收到的 code 是 **`-32603`**，和"预算"两个字毫无关系，于是收敛原因
落到 `ATTEMPT_FAILED`。运维看到的是一个匿名协议错误，而真实原因是撞了模型预算上限。这违反
§7.6-9"预算耗尽…返回稳定错误码"与 §7.8.6。

**修复**：`BrokerUsageSnapshot` 新增 `deniedModelRequests`（来自预算账本的 `denied` 计数，三处
`denied++` 全部返回 `MODEL_BUDGET_EXHAUSTED`，信号干净）。只要它 > 0，引擎就以
`MODEL_BUDGET_EXHAUSTED` / `BUDGET_EXHAUSTED` 为准，并把底层错误附在消息里。no-submission 与
catch 两条分支都覆盖 —— 实测走的是 catch 那条。

### 缺陷二：取消在数据库与界面上与崩溃无法区分

三种取消触发的 `errorCode` 都是 `AGENT_ATTEMPT_FAILED`。收敛原因在 `attempt_drained` 日志里是对的，
但落到 DB 与 UI 的错误码是笼统失败 —— 用户点了取消，界面上看起来像跑挂了。§9 为此定义了
`AGENT_TREE_CANCELLED`。

**修复**：signal 被 abort（或原始码本就是 `AGENT_TREE_CANCELLED`）时报 `AGENT_TREE_CANCELLED`，
具体是哪一种触发由 `attempt_drained` 的 reason 与数据库的 `cancel_reason` 区分。

## 21. 机械核对：RPC 参数名与列引用（全部通过）

参数名或列名写错只在**运行时**报错，本地类型检查完全看不出来。用实库做了两轮机械核对：

| 核对项 | 范围 | 结果 |
|---|---|---|
| Worker 的 RPC 调用 | 24 个调用点 | ✓ 函数名与 `p_` 参数名全部存在于 `pg_proc` |
| 前端的 RPC 调用 | 22 个 | ✓ 同上 |
| 前端的 `select()` 列引用 | 14 处 select、10 个显式列（含嵌套关系 `rel(a,b)`） | ✓ 全部存在于 `information_schema.columns` |
| Worker 调用的 RPC 是否有 SQL 测试 | 22 个 | ✓ 全部在 `supabase/tests/*.sql` 中出现 |

核对脚本在本文件的提交记录里；重跑方式是对着本地库执行
`select proname, proargnames from pg_proc` 与 `information_schema.columns` 做集合比较。
**建议把这两项加进上线前检查**：它们是纯机械的，几秒钟就能跑完，却能挡住一类只在生产暴露的断裂。

## 22. 日志脱敏逐条核对与两处缺口（已修复）

方案 §7.11 列了禁止记录的内容清单。此前只有零散的脱敏测试，从未逐条核对过。对着清单构造真实
形态的样本跑了一遍，**14 类里有 2 类完全没被脱敏**：

| 禁止类别 | 核对前 | 修复 |
|---|---|---|
| **源码** | ✗ `{ sourceCode: ... }`、`{ content: ... }`（快照读取结果的字段名就叫 `content`）原样进日志 | 加 `sourcecode`/`codecontent`/`filecontent`/`rangecontent`/`codesnippet`/`snippet` 子串，并对 `content` 用**完整键名**匹配 |
| **网页正文** | ✗ `{ pageBody: ... }`、`{ body: ... }` 原样进日志 | 加 `pagebody`/`pagecontent`/`responsebody`/`htmlbody`/`bodytext`，并对 `body` 用完整键名匹配 |

其余 12 类（Prompt 全文、需求全文、工具正文、Session JSONL、API Key、service role、Git token、
claim token、Broker token、capability token、Authorization 头、Web URL query/fragment）核对通过。

为什么 `content` / `body` 必须用**完整键名**而不是子串：`contentHash` / `content_hash` /
`responseBytes` / `requestBytes` 是**必须能记**的安全字段（全仓 53 处引用），用子串会把它们一起
打掉，等于用一个安全修复换来一个排查能力的倒退。`code` 刻意不在列内——`{ code:
'AGENT_IDENTITY_INVALID' }` 是排查的主要依据。

当时并无活跃泄漏点（没有代码真的把这两类字段传进 logger），所以这是纵深防御的缺口而非在线事故。
但键名黑名单的意义恰恰是防住后加的代码——缺项就等于这道防线对源码和网页正文不存在。

回归测试已锁住三件事：两类必须脱敏、安全字段必须保留、其余 12 类逐条确认。已用注入原缺陷的
方式验证有效（注入后精确失败于 `expected '{"sourceCode":...}' not to contain ...`）。

## 23. 恢复被拒不篡改会话日志（§12.3，已实测）

§12.3 要求"Session 格式不兼容时标记 `SESSION_FORMAT_UNSUPPORTED`，创建新 attempt，**不篡改
JSONL**"。日志里可能是跑了很久的长任务，被拒的一方擅自截断或删除它，就等于销毁唯一的取证材料。

结构上先确认：会话模块里所有可能改动磁盘的调用只有锁文件的 `writeFileSync` / `rmSync`，从不碰
JSONL。再在 `v4-session-resume-real.test.ts` 里加了阶段三实测——用一个必然被拒的 `policy_hash`
触发拒绝，然后逐字节核对：

```
恢复被拒: SESSION_FORMAT_UNSUPPORTED
日志大小: 不变
日志 sha256: 不变（逐字节一致）
```

## 24. 仍未验证 / 仍未做

**第 11 节 22 项**：本地已全部有覆盖。第 14/15 项见第 14 节，第 16 项见第 16 节，
真实固定 Commit 见第 19 节。仍需人工确认的只有"真实模型跑批中途 kill 掉 Worker 进程"这种更贴近
事故的形态——本地用的是两阶段引擎调用，会话日志与 cwd 一致性走的是同一条生产代码路径。

**已完成的实测**：取消收敛五触发矩阵（第 20 节）、RPC 参数名与列引用机械核对（第 21 节）、
日志脱敏逐条核对（第 22 节）、恢复被拒不篡改日志（第 23 节）。

**仍未做的工程项**（都不影响核心安全边界）：

1. `pwsh` 无条件禁用 vs 方案 §3.1 写的"按 OS 开启"——Linux/macOS 部署下硬禁用等价且更安全，
   属文档-实现语义偏差；
2. web policy 的 `maxRedirects`/`requestTimeoutMs` 未登记进方案 §4（实现有、文档没写）；
3. 方案 7.10 清单里 `WorkerManagementPage.tsx` / `admin-model-config` 本次未改动，需确认是文档
   过时还是漏做；
4. **Release Gate 里本地做不了的运维演练**：迁移演练、扩容、磁盘满、网络失败注入、回滚演练、
   告警上线。其中"回滚"的两条关键不变量已在本地验证——已提交结果不重跑（`load_resumable_attempt`
   对已提交 attempt 返回 null，`save_agent_review_result` 抛 `AGENT_RESULT_ALREADY_COMMITTED`）、
   Session 格式不兼容时不篡改 JSONL（第 23 节）；剩下的是真实环境的容量与网络演练。

**已确认上线策略：本次迁移直接启用 V4。** `analysis_job.policy_version` 在迁移 0027 中默认
为 4，`enqueue_analysis_job` 也显式冻结 V4 policy；这与产品决策一致。不保留默认 V3 的过渡期，
也不新增后续 policy flip 迁移。生产 Release Gate 和存量 attempt drain 必须在应用 0027 前完成；
应用迁移并部署 V4 Worker 后，所有新建 Job 直接使用 V4。方案 §12.2 与 `worker/OPERATIONS.md`
已按该流程统一。

已解决/已排除：后台 job 根因（第 17 节）、workflow 工具面（第 17 节）、`tree_digest` 误拒
（第 19 节，迁移 0028）、0017 SQL 测试（第 19 节）、Jobs 精确取消（第 15 节，实测不是缺口）、
bubblewrap（第 13 节，默认容器里不可用）。

**一个值得专项检查的模式**：本轮共修 **7 处**"失败时静默吞掉异常"，其中 4 处隐藏了真实缺口
（含两个让核心能力完全不工作的缺陷）。详见第 17 节末的专项排查。

**Release Gate 里本地做不了的**：迁移演练、扩容、磁盘满、网络失败、回滚演练、告警上线。

**结论：本地全绿 ≠ 可以部署直接启用 V4 的生产版本。** 上线前仍需在能访问内网 GitLab 的环境跑一次真实仓库
的小 Job，并对照执行方案第 13 节逐项确认。
