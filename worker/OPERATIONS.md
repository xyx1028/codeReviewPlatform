# Worker 运维与部署手册

> 当前基线：V3 单 DeepSeek Harness ACP 架构
> 架构说明：`代码评审平台/v3/DEEPSEEK_HARNESS_REFACTOR_PLAN.md`
> 上线清单：`代码评审平台/v3/代码评审平台-V3-DeepSeekHarness-上线操作清单.md`

本文仅描述当前 Worker。平台没有固定检索/分析阶段、执行方式选择、版本化 Worker RPC 或旧实现回退。

## 1. 组件概览

后台 Worker 位于 `worker/`，独立于前端构建：

```bash
npm run worker:typecheck
npm run worker:build              # tsc -p tsconfig.worker.json → dist-worker/
npm run worker:start              # node dist-worker/index.js
npm run worker:dev                # tsx worker/src/index.ts
npm run test:worker               # vitest run worker
npm run worker:check-connectivity # Git + Supabase/Vault + 最小模型 ping
```

Worker 主动轮询 Supabase，不监听入站端口。每个 Story Task attempt 启动一个私有 DeepSeek Harness ACP 子进程，由一个 Agent 在固定 Commit 快照上自主搜索、阅读、分析并通过 terminal tool 提交结果。

出站依赖：

- Supabase/PostgREST；
- 白名单 GitLab；
- 当前模型配置的 OpenAI-compatible endpoint。

## 2. Worker 环境变量

`worker/src/config.ts` 会严格校验以下配置：

| 变量 | 必填 | 默认值 | 说明 |
|---|---|---|---|
| `SUPABASE_URL` | 是 | — | Supabase 项目 URL |
| `SUPABASE_SERVICE_ROLE_KEY` | 是 | — | 仅 Worker 使用，禁止进入浏览器 |
| `WORKER_ID` | 是 | — | 每副本唯一；compose 由容器 hostname 生成 |
| `GIT_AUTH_MODE` | 否 | `local` | `local` 或 `token` |
| `GITLAB_BASE_URL` | 否 | `https://git.kingdee.com` | 仅允许无凭据、无 path/query/hash 的 HTTP(S) origin |
| `GITLAB_DEPLOY_USER` | token 模式 | — | 只读 Deploy 用户 |
| `GITLAB_DEPLOY_TOKEN` | token 模式 | — | 只读 Deploy Token |
| `WORKSPACE_ROOT` | 否 | `/workspace/jobs` | 当前只用于 Worker instance lock，不存 Task 源码 |
| `CODE_CACHE_ROOT` | 否 | `/workspace/cache` | 精确 Commit 快照 cache |
| `AGENT_ATTEMPTS_ROOT` | 否 | `/workspace/agent-attempts` | 每 attempt 私有 `DSH_HOME` 临时树 |
| `POLL_INTERVAL_MS` | 否 | `5000` | 轮询间隔，500–600000 |
| `STORY_TASK_LEASE_SECONDS` | 否 | `900` | Task lease，30–7200 秒 |
| `HEARTBEAT_INTERVAL_MS` | 否 | `30000` | 必须小于 lease 毫秒数 |
| `WORKER_STORY_CONCURRENCY` | 否 | `2` | 每副本槽位，1–20 |
| `LOG_LEVEL` | 否 | `info` | 日志级别 |

不要设置任何 Worker 引擎集合或平台协议版本变量；最终 Worker 没有这些配置。

模型 Base URL、模型名、预算和 API Key 不来自 Worker 静态环境变量。它们来自 Job 冻结的模型 snapshot 与 Supabase Vault。

## 3. Secret 生命周期

### 3.1 Supabase service role

- 只注入 Worker 进程；
- 不写镜像、前端、普通表或日志；
- Harness 子进程和工具插件拿不到 service role；
- 所有 Worker RPC 由 `JobsDb` 统一调用。

### 3.2 模型 API Key

1. Worker 成功领取 Story Task，获得明文 claim token；
2. 调用 `get_model_secret_for_story_task`；
3. 数据库校验 task、worker、token 摘要和 lease；
4. Worker 只向当前 Harness 子进程注入 `REVIEW_MODEL_API_KEY`；
5. route patch 仅引用环境变量名，不写 Key 值；
6. attempt 结束后子进程和临时环境销毁。

禁止使用 `VITE_MODEL_API_KEY` 或把模型 Key 放进 Worker `.env` 作为长期配置。API Key 不得进入 profile、patch、config hash、错误或日志。

### 3.2.1 Broker 凭据（V4）

每 attempt 的 Broker bearer token 与根 Agent capability token **只经环境变量**传给 Harness
子进程，不写进 attempt patch 文件：

| 变量 | 内容 |
|---|---|
| `REVIEW_BROKER_ACCESS_TOKEN` | 该 attempt 的 Broker bearer token |
| `REVIEW_ROOT_CAPABILITY_TOKEN` | 根 Agent 的 capability token |

两者都由 Worker 在 spawn 时生成并注入，运维**不需要也不应当**配置它们。

为什么不能落盘：patch 文件写在 `AGENT_ATTEMPTS_ROOT/attempt-*/` 下（0600，属主是 worker
用户），而 Sandbox Shell 以同一个用户运行，且 `workspace-write` 沙箱**只限制写、不限制读**
（`@deepseek-ai/dsh-sandbox-local` 的三档 profile 分别是 bwrap `--ro-bind / /`、
Landlock `readOnly: ["/"]`、Seatbelt `(allow default)`）。凭据写进该文件，等于任何拿到
Shell 的子 Agent 都能读到根 Agent 的令牌并冒充它提交 —— 直接击穿"根 Agent 唯一提交"。

为什么环境变量安全：Harness 在 spawn 模型可见的 Shell 之前会重建环境
（`@deepseek-ai/dsh-subprocess` 的 `scrubbedParentEnv()`），按**变量名**丢弃所有匹配
`/KEY|PASSWORD|SECRET|TOKEN/i` 以及所有 `DSH_*` 的条目。上表两个名字与
`REVIEW_MODEL_API_KEY` 都命中该规则，因此它们存在于 Harness 进程内（插件可读）而不存在于
Shell 子进程内。

**重命名这三个变量前必须确认新名字仍然命中该规则**，否则凭据会随环境泄漏给模型。启动路径
上有机械检查（`assertCredentialEnvIsScrubbed`），名字不合规时 Worker 直接启动失败；另有
`assertPatchHasNoCredentials` 在 materialize 时拒绝任何把令牌塞回 patch 的改动。

### 3.2.2 沙箱资源上限（V4）

Worker 用 `sh -c 'ulimit …; exec dsh …'` 启动 Harness，rlimit 由**所有后代继承**，因此
Sandbox Shell 与 Jobs 起的每个构建、测试、静态检查进程都受同一组上限约束：

| 限额 | 施加位置 | 来源 |
|---|---|---|
| 打开文件数 | `ulimit -n 1024`（继承） | 固定值 |
| 单文件大小 | `ulimit -f`（继承） | policy `sandbox.maxWorkspaceBytes` |
| core dump | `ulimit -c 0`（继承） | 固定值；core 可能含内存里的凭据 |
| RSS（内存炸弹） | 容器 `mem_limit` / `memswap_limit` | Linux 的 `RLIMIT_RSS` 早已不生效；`ulimit -v` 限制虚拟地址空间，而 Node 需要大量 VA，设了会起不来 |
| 进程数（fork bomb） | 容器 `pids_limit` | policy `sandbox.maxProcessesPerAttempt` × `WORKER_STORY_CONCURRENCY` + 开销 |
| 单条命令 CPU 时限 | bash-sandbox `commandTimeoutMs` | policy `sandbox.commandTimeoutMs` |

两项**刻意不用** rlimit，都是实测结论：

- `ulimit -t`（CPU 时间）会在累计耗时到点后杀掉整个 attempt，而不是那条跑飞的命令；
- `ulimit -u`（RLIMIT_NPROC）按 **UID 全局计数**而不是按进程树计数，而容器默认共享宿主
  user namespace —— 同一个 `worker` UID 的所有副本会合并计到一个上限里，设成
  `maxProcessesPerAttempt` 会让正常构建随机报 `fork: Resource temporarily unavailable`。
  fork bomb 的正确原语是 cgroup 的 `pids_limit`（按容器计数，不依赖进程自律）。

**扩容时必须同步核对 `pids_limit`**：它要 ≥ `maxProcessesPerAttempt × WORKER_STORY_CONCURRENCY`
再加 Worker/init 开销，调小会让正常构建随机失败。`WorkspacePolicy.recommendedContainerPidLimit()`
给出建议值。

### 3.3 Git 凭据

- 本地可使用 `GIT_AUTH_MODE=local` 复用 Credential Helper；
- 容器使用 `GIT_AUTH_MODE=token` 与只读专用账号；
- token 通过 `http.extraHeader` 注入，不拼进 remote URL；
- 仓库清单固定在 `worker/src/git/repositories.ts`，不接受任意仓库 URL。

## 4. 本地运行

前置检查：

```bash
node --version
npm --version
git --version
rg --version
git ls-remote --heads \
  https://git.kingdee.com/kwork/manage/kdmanage-backend.git \
  refs/heads/feature_dev
```

安装、构建并启动：

```bash
npm ci
npm run worker:typecheck
npm run worker:build
# 在安全位置注入必需环境变量，然后：
npm run worker:start
```

不要使用两个进程共享同一个 `WORKER_ID`。Instance lock 会拒绝明显的本机重复实例；跨主机唯一性仍由部署平台保证。

## 5. 容器部署

首次使用时，在项目目录准备本机专用配置。真实文件受 `.gitignore` 保护，
只留在这台 Docker 主机；不要把它写入 `Dockerfile` 或提交 Git：

```bash
cp .docker/worker.env.example .docker/worker.env
chmod 600 .docker/worker.env
```

在 `.docker/worker.env` 填入 Supabase service role 与只读 GitLab Deploy Token。
不要直接复制 Mac 上的 Worker 配置文件：其中的 `WORKER_ID` 与运行目录属于
宿主机，容器会使用自己的路径并自动生成每副本唯一 ID。
之后 Compose 会自动加载该文件，无需在启动命令中传 `--env-file`。

构建与启动：

```bash
docker compose -f docker-compose.worker.yml build
docker compose -f docker-compose.worker.yml up -d --scale worker=4
```

默认拓扑为 4 副本 × 2 槽位，Worker 理论容量 8。实际同一模型并发仍受数据库中的 `max_parallel_tasks` 限制；上线前还需评估供应商 RPM、TPM 和费用。

安全基线：

- 非 root `worker` 用户；
- `no-new-privileges:true`；
- 不发布端口；
- `/tmp` 使用 tmpfs；
- 每副本独立匿名 `/workspace` volume；
- `restart: unless-stopped`；
- 每容器唯一 `WORKER_ID`。

生产需在目标 Linux/容器环境额外验证：进程树回收、CPU/RSS/FD 限制、egress allowlist、DNS/redirect 策略和模型 endpoint TLS。每 attempt 一个子进程本身不等于完整 OS 安全域。

## 6. 运行目录与清理

### 6.1 Snapshot cache

`CODE_CACHE_ROOT` 保存四个白名单仓库的精确 Commit materialization。业务读取绑定数据库记录的 Commit SHA；cache miss 只补取该 SHA，不回退分支 HEAD。

模型不能直接访问 cache 路径。`search_code`、`find_files`、`read_code` 和 `list_commits` 通过 Broker 校验 repository、Commit、path、blob、范围和预算后读取。

### 6.2 Attempt 临时树

`AGENT_ATTEMPTS_ROOT` 下每个 attempt 创建私有 `DSH_HOME`，包含：

- `code-review-acp` profile 物化结果；
- 不含 Key 值的 route patch；
- 当前 attempt 的非源码临时配置。

Broker socket、Agent cwd 和其他临时路径同样按 attempt 隔离。结束时必须清理 profile、socket、cwd 和子进程。

这里不创建：

- 候选源码目录；
- Task code workspace；
- Session JSONL；
- 工具原始结果文件；
- 第二棵仓库副本。

### 6.3 `WORKSPACE_ROOT`

当前生产入口只用它放置 Worker instance lock。不要依赖历史的 `jobs/<job>/tasks/.../code` 目录结构，也不要用目录是否为空判断 Task 是否完成。

### 6.4 Orphan 处理

发现残留 attempt 时：

1. 先确认对应 Worker PID/容器和 Task lease 已失效；
2. 保存不含源码/密钥的 run ID、PID、exit/signal 与 cleanup 日志；
3. 终止仍存活的当前 attempt 进程树；
4. 只删除已确认无主的 attempt 叶子；
5. 不递归清理共享 cache 或未知目录。

## 7. 单 Task 执行生命周期

```text
claim_next_story_task
  → claim token + lease
  → get_model_secret_for_story_task
  → AttemptControlBroker
  → 私有 DSH_HOME/profile/route
  → dsh ACP initialize + session/new + session/prompt
  → Agent Loop + 只读 Snapshot tools
  → submit_review_result
  → Broker 校验 Evidence/Coverage/claim
  → save_agent_review_result 原子提交
  → session close + 子进程回收 + attempt 清理
```

heartbeat 每 30 秒续租。lease 丢失后 Broker revoke；后续工具、提交和数据库迟到写均应失败。

全部 Task 成功后，Worker 领取 `FINALIZING`，只读取 `agent_output` 与数据库已验证 Evidence，生成正式 `ai_review_result/ai_code_evidence`。

## 8. 模型预算与并发

配置分两处，互不重叠：

**「模型管理」页（模型接入）**

| 字段 | 默认值 | 作用 |
|---|---:|---|
| `context_window` | 131072 | 传给 `llm-pi-ai` 的上下文窗口 |
| `max_output_tokens` | 8192 | 传给 `llm-pi-ai` 的单次输出上限 |
| `max_parallel_tasks` | 4 | 同一模型的并发 Task 闸门，claim 时实时读取 |
| `request_timeout_ms` | 180000 | 平台侧超时：Broker IPC、Git 准备、连通性测试。**不是**模型 HTTP 超时 |

**「默认能力策略」页（V4 policy，按模型维护，随新建 Job 冻结）**

请求次数预算全部在这里：`maxTotalRequests` / `maxRootRequests` / `maxChildRequests` /
`maxRetryRequests` / `maxCompactionRequests` / `maxRalphRounds`，另有沙箱、Agent Tree、
并行工具、Workflow / Jobs、Web allowlist 和 Session 限额。

`ai_model_config.agent_max_model_requests` 不再由任何页面维护：0027 之后新建的 Job 一定
带完整 policy snapshot，这一列只在 snapshot 缺失（0027 之前创建、仍在途的 Job）时用于
`fallbackPolicyFromModel` 兜底。`agent_max_retry_requests` / `agent_max_compaction_requests`
两列仍是 `build_v4_capability_policy` 的取值来源，但唯一写入口是策略页——策略页那条路径
带「分项不超过总量」校验和 `v4_capability_policy_audit` 审计。

model-budget-governor 在 provider 请求前计量普通、retry 和 compaction 请求。预算耗尽会让当前 attempt 以稳定错误结束，不会绕过上限继续调用。

调优顺序：先看 `analysis_agent_run` 的真实请求、retry、compaction、工具和 Evidence 计数，再调整预算。不要只根据单个 Task 的耗时盲目增加总请求上限。

## 9. 日志与审计

结构化日志可包含：

- timestamp、level、worker/job/task/run ID；
- `PREPARING / AGENT / FINALIZING` 阶段；
- 工具名、耗时、计数、字节数；
- 模型请求分类与 usage 摘要；
- profile/config hash；
- 子进程 PID、exit/signal、回收耗时；
- lease 与 cleanup 结果。

禁止输出：

- 模型 API Key、service role、Git token、Authorization；
- claim token、Broker 认证信息；
- prompt、需求全文、模型完整响应；
- 源码、snippet、工具结果；
- ACP 原始 event payload。

日志必须经过 `worker/src/security/redaction.ts`。排障时使用 ID/hash/计数关联，不临时打开源码或密钥日志。

## 10. 连通性验收

### 10.1 完整探针

正式镜像内置 `worker:check-connectivity`：

1. 对固定 4 仓库 × `feature_dev / feature_sit / release` 执行精确 `git ls-remote`；
2. 使用 service role 读取启用模型的非敏感元数据并验证 Vault secret 可读；
3. 对模型 `chat/completions` 仅发送极短 `ping`，不发送需求、prompt 或代码。

在权限为 `0600`、不纳入版本库的文件中准备：

```dotenv
SUPABASE_URL=<staging-or-production-url>
SUPABASE_SERVICE_ROLE_KEY=<secret-platform-injection>
GIT_AUTH_MODE=token
GITLAB_BASE_URL=https://git.kingdee.com
GITLAB_DEPLOY_USER=<read-only-user>
GITLAB_DEPLOY_TOKEN=<read-only-token>
CONNECTIVITY_MODEL_CONFIG_ID=<enabled-model-config-uuid>
CONNECTIVITY_TIMEOUT_MS=30000
```

执行：

```bash
chmod 600 /secure/path/worker-connectivity.env
docker run --rm \
  --env-file /secure/path/worker-connectivity.env \
  codereviewplatform-worker:latest \
  npm run worker:check-connectivity
```

成功条件：退出码 0，`connectivity_summary.ok=true`、`failed=0`。输出不得包含 URL、请求/响应体或任何密钥。

直接模型 `ping` 只是网络/凭据探针。生产审核始终由 DeepSeek Harness adapter 执行。

### 10.2 仅 Git 的本机检查

```bash
npm run worker:build
CONNECTIVITY_COMPONENTS=git GIT_AUTH_MODE=local npm run worker:check-connectivity
```

局部检查不能替代正式三方验收。

## 11. 每周运行流程

1. 确认 Worker 在线、每副本 ID 唯一、槽位符合预期；
2. 确认本周模型启用且连接检查通过；
3. 创建批次并选择正确分支/模型；
4. 上传并核对 Story 数量；
5. 启动分析，确认四仓库 Commit snapshot；
6. 观察 `PREPARING → AGENT → FINALIZING`；
7. 抽查 Agent run 用量、verified Evidence 和最终结果；
8. 人工评审并完成批次。

不要再检查候选文件列表或阶段间 workspace；当前架构没有这些产物。

## 12. 故障处理与重试

常见错误：

| 类型 | 处理 |
|---|---|
| Git 瞬时失败 | 核对网络/凭据，按原 Commit 重试 |
| 分支/Commit 不存在 | 核对分支，不回退 HEAD |
| 模型 429/5xx/超时 | 查看 retry 与总预算，修复后重试 |
| `MODEL_BUDGET_EXHAUSTED` | 评估需求范围与实际 usage 后调整预算 |
| `AGENT_NO_SUBMISSION` | 检查 prompt、terminal tool 与模型行为 |
| Evidence/Coverage 校验失败 | 依据 receipt/hash 修复，不绕过校验 |
| `TASK_LEASE_LOST` / claim 无效 | 不接受迟到结果；确认 Worker/网络后生成新 attempt |
| Vault/密钥错误 | 在模型管理中轮换 Key，勿写入 Worker 环境 |
| `LEGACY_ENGINE_RETIRED` | 历史任务不可恢复；创建新的 Harness Job |

重试会增加 `agent_attempt` 并签发新 claim token。禁止复用旧 token、手改状态或切换到另一种实现。

一个 Task 的致命错误可能使整个 Job 失败并释放 sibling lease，这是防止不完整结果进入 finalizer 的预期行为。

## 13. Worker 重启与扩缩容

重启：

1. 停止创建新 Job；
2. 观察当前 Task，允许完成或记录失败；
3. 重启容器；
4. 确认旧 attempt 进程/socket/profile 已回收；
5. 先用 1 个副本执行小 Job；
6. 再恢复目标副本数。

扩缩容：

- 每副本必须有唯一 `WORKER_ID`；
- 不共享可写 `/workspace` volume；
- 缩容前观察当前 lease；
- 数据库 `max_parallel_tasks` 是同一模型配置的最终 Task 并发阀门；
- 不需要也不允许配置不同副本的“执行能力”。

镜像回退只允许回到与当前 canonical 单 Harness RPC 兼容的版本。依赖已删除数据库接口的旧镜像不能启动。

## 14. 发布验收

```bash
supabase db reset --no-seed
npm run worker:typecheck
npm run worker:build
npm run test:worker
npm run build
npm run lint
```

发布环境还必须完成：

- [ ] 三方连通性探针退出码 0；
- [ ] 单副本、单小 Job 的真实 Harness attempt 成功；
- [ ] 模型可见工具只有五个 allowlist 工具；
- [ ] Evidence 绑定精确 Commit/blob/range；
- [ ] API Key/claim token/源码不进入文件和日志；
- [ ] 正常、失败、lease lost、重启后无孤儿；
- [ ] 扩容后并发、RPM/TPM 与费用在预算内。

---

# 15. V4 多 Agent 全能力默认开启运维

> 适用基线：V4 DeepSeek Harness 全能力默认开启（多 Agent Tree、Session JSONL 持久化、
> Sandbox Shell、Web egress、Workflow/Subagent/Jobs）。
> 执行方案：`代码评审平台/v4-DeepSeekharness全功能运用重构增强/代码评审平台-V4-DeepSeekHarness-全能力默认开启执行方案.md`（第 7.11、9、12 节）。
>
> V4 与前面章节的关系：第 1–14 节描述的单 Task 生命周期、Secret 生命周期、连通性验收
> 仍然成立。本章只补充 V4 新增的运维面，不重复也不推翻既有约束。“默认全开”是**用户**
> 语义；本章的熔断开关是**运维**在事故期间的临时收窄手段，二者不冲突。

## 15.1 完整环境变量清单（含 V4 新增）

除第 2 节已列的变量外，`worker/src/config.ts` 还校验以下 V4 变量：

| 变量 | 必填 | 默认值 | 说明 |
|---|---|---|---|
| `AGENT_SESSION_ROOT` | 否 | `/workspace/agent-sessions` | Session JSONL 持久卷根目录。**必须是持久卷**，否则 Worker 重启无法恢复 Session。内容含真实源码，需 0700、静态加密、保留期。 |
| `AGENT_SESSION_VOLUME_MAX_BYTES` | 否 | `21474836480`（20GiB） | Session 卷容量上限，范围 64MiB–4TiB。超过即按最旧优先回收并告警。 |
| `AGENT_SESSION_RETENTION_DAYS` | 否 | `7` | 卷级 Session 回收保留期（天），范围 1–365。与 §4 policy 的 `session.retentionDays` 默认一致；回收是跨所有 Job 的卷级动作，因此取这个可运维的全局值，而不是某一个 Job 冻结的 policy。单个 Job 的 policy 仍决定它自己 checkpoint 的 `retention_until`。 |
| `ORPHAN_WORKSPACE_MAX_AGE_MS` | 否 | `21600000`（6h） | 孤儿 Workspace 最大存活时长，范围 60s–7d。 |
| `HARNESS_CAPABILITY_CONTRACT` | 否 | 镜像内 `worker/harness/code-review-acp/v4-capability-contract.json` | 契约文件覆盖路径，一般不需要设置。 |

运维紧急熔断开关（环境变量，值为空 / `0` / `false` 一律视为未设置）：

| 变量 | 收窄效果 |
|---|---|
| `V4_BREAKER_DISABLE_WEB` | 关闭 `web_search` / `web_fetch` 能力 |
| `V4_BREAKER_DISABLE_SHELL_WRITE` | 关闭 `shell`，Sandbox 回退 `read-only` |
| `V4_BREAKER_DISABLE_SUBAGENTS` | 关闭 subagent spawn/fork/ralph，委派深度归零、每 attempt 仅 1 个 Agent |
| `V4_BREAKER_DISABLE_WORKFLOW` | 关闭 `workflow` 能力 |

启用熔断后 Worker 每次组装 policy 都会记录 `v4_emergency_breakers_active` 事件（携带
`breakers` 列表）。这些开关**不写入数据库、不改用户配置**：事故解除后从容器环境移除变量
并滚动重启，即恢复 V4 默认全开语义。不要用它们做长期功能裁剪。

模型 Base URL、模型名、预算、API Key 仍来自 Job 冻结的模型 snapshot 与 Supabase Vault，
不是 Worker 静态环境变量。

## 15.2 运行目录、持久卷与保留期

`docker-compose.worker.yml` 为四个运行根目录分别声明 named volume：

| 卷 | 挂载点 | 是否持久 | 是否可多副本共享 | 说明 |
|---|---|---|---|---|
| `worker-sessions` | `AGENT_SESSION_ROOT` | **必须持久** | 是（受单写者锁保护） | Session JSONL，重启恢复的唯一依据，含源码 |
| `worker-cache` | `CODE_CACHE_ROOT` | 建议持久 | 是（按 Commit 寻址） | 四仓库精确 Commit 快照 |
| `worker-attempts` | `AGENT_ATTEMPTS_ROOT` | 可短暂 | 是（按 attempt 隔离） | 每 attempt 私有 DSH_HOME，结束即删 |
| `worker-jobs` | `WORKSPACE_ROOT` | 可短暂 | 每副本按 `WORKER_ID` | Worker instance lock |

Session 卷为什么必须持久：Session JSONL 是 Worker 重启后重放、继续未提交 Session 的唯一
依据（`session.resumeOnWorkerRestart=true`）。放在匿名卷 / tmpfs / attempt 临时目录都会让
“恢复”退化成“从零重来”，浪费预算并可能重复外部副作用。多副本共享同一 Session 卷是安全的：
目录名由 `task+attempt` 派生，并由**双层单写者锁**保护——本地 `.writer.lock`（`O_EXCL`）挡
同机竞争，数据库 `session_revision` fencing 挡跨机竞争；并发接管会以 `SESSION_FENCED` 拒绝，
不会写出交错 JSONL。同 Worker 同 attempt 的进程重启会记录 `session_writer_lock_reclaimed`
并正常接管自己的锁。

保留期与磁盘告警阀值：

| 对象 | 保留期 | 回收方 | 磁盘告警 |
|---|---|---|---|
| Session JSONL | `session.retentionDays`（默认 7 天） | `session-retention` 周期扫描 | 卷用量 > 80% `AGENT_SESSION_VOLUME_MAX_BYTES` 预警；> 100% 记 `session_volume_over_capacity` 并按最旧优先回收 |
| Workspace / attempt 临时树 | attempt 结束即删；孤儿 > `ORPHAN_WORKSPACE_MAX_AGE_MS`（默认 6h） | `overlay-cleaner` / 周期清理 | 卷所在磁盘 > 85% 告警 |
| Artifact（Patch/报告） | `analysis_artifact.retention_until`（随 checkpoint 保留期） | 保留期到期后随记录清理 | 同 Session 卷磁盘告警 |

正常回收路径的成功事件：`session_retention_completed`、`overlay_cleanup_completed`。失败事件：
`session_retention_scan_failed`、`session_retention_delete_failed`、`workspace_cleanup_failed`、
`overlay_cleanup_failed`、`process_tree_cleanup_failed`、`periodic_cleanup_failed`——出现即需排查
（多为磁盘满、权限或残留进程持有文件句柄）。

宿主机侧：Session 卷所在磁盘必须启用静态加密；卷目录保持 0700 且属于容器内非 root
`worker` 用户（镜像已预置，空卷首次挂载即继承该权限）。

## 15.3 RPM / TPM / 模型费用告警

V4 是多 Agent，单个 Job 的模型请求量显著高于 V3。分层预算由 `model-budget-governor` 在
provider 请求前计量（root / child / retry / compaction 分类），耗尽以稳定错误结束当前
attempt，不会绕过上限继续调用。

告警来源与阈值建议：

- **供应商侧 RPM/TPM**：以模型供应商配额为硬上限，设置 80% 预警。V4 扩容前必须重新评估，
  因为 4 副本 × 2 槽位 × 多 Agent 的峰值请求远高于 V3。
- **数据库侧并发**：`max_parallel_tasks` 是同一模型配置的最终 Task 并发阀门。
- **单 attempt 预算**：`modelBudget.maxTotalRequests`（默认 160）等，见 policy 默认值。
- **费用**：以 `analysis_agent_node` 的 `input_tokens` / `output_tokens` 聚合估算，按周对账。

按 run 汇总 token 与请求，用于费用与预算告警：

```sql
-- 单个 Job 的分层 token 与请求量（费用估算 / 异常放大检测）
select
  node.agent_run_id,
  count(*)                          as agent_count,
  sum(node.model_requests)          as model_requests,
  sum(node.tool_calls)              as tool_calls,
  sum(coalesce(node.input_tokens, 0))  as input_tokens,
  sum(coalesce(node.output_tokens, 0)) as output_tokens
from public.analysis_agent_node node
where node.agent_run_id = '<agent_run_id>'
group by node.agent_run_id;
```

调优顺序不变：先看真实的 per-Agent 请求 / retry / compaction / 工具 / Evidence 计数，再调预算；
不要凭单个 Task 耗时盲目抬高总请求上限。

## 15.4 Agent / Job / 进程孤儿检查

### 进程孤儿

`acp-process-supervisor.ts` 以 `detached: true` 让每个 attempt 的 `dsh` 独立成进程组，回收时
逐级升级（`terminate` → 组 `SIGTERM` → 组 `SIGKILL`），最后用 `ps -eo pid=,pgid=,stat=` 读全表
按 `pgid` 过滤，确认组内没有存活进程。**镜像必须装 `procps` 提供 `ps`**，否则无法确认后代
进程（构建 / 测试 / 静态检查）已回收，会记 `process_tree_cleanup_failed`。

两条在真实 Linux 容器里实测出来的注意事项（测试见
`worker/src/__tests__/v4-process-tree-linux.test.ts`，`RUN_LINUX_PROCESS_TREE=1` 开启）：

1. **组信号是必须的，不是保险。** 只终止直接子进程时，Shell / Jobs 起的孙辈进程会继续运行
   （实测留下 3 个存活的 `sleep`）。所以 `detached: true` 那一位是"能否回收整棵进程树"的
   全部区别所在。
2. **僵尸不等于未回收。** 组 `SIGKILL` 之后，后代先变成僵尸（`ps` 的 `stat` 列为 `Z`），要等
   父进程 wait 掉才从进程表消失 —— 而它们的父进程刚好也被同一次信号杀了。因此：
   - `listProcessGroup()` 按 `stat` 排除 `Z`，否则每一次用过 Shell 的 attempt 都会误报
     `process_tree_cleanup_failed`，真正的回收失败会被这些噪音盖住；
   - **容器必须有 init 进程收僵尸**（`docker-compose.worker.yml` 的 `init: true`，Docker 会注入
     tini 作为 PID 1）。没有它时 PID 1 就是 Worker 自己，而 libuv 只 wait 它亲手 spawn 的子进程，
     继承来的孤儿会永久挂着，最终撞上容器的 PID 上限。实测：不加 `init` 时组内留下 2 个
     `state=Z`；加了之后组为空。

`ps -g <pgid>` **不能**用来选进程组：procps 的 `-g` 选的是 session，而 procps-ng 4.0.2 不支持
`--pgid` 长选项。按 `pgid` 列自己过滤是唯一精确的做法。

容器内核对残留进程：

```bash
# 进入某副本，查看是否只剩 npm / node 主进程，无游离的构建/测试进程；
# STAT 列出现 Z 说明 init 没在收尸，检查 compose 的 init: true 是否生效
docker compose -f docker-compose.worker.yml exec worker \
  ps -eo pid,ppid,pgid,stat,comm

# 确认 PID 1 是 tini（init 已注入），而不是 node 本身
docker compose -f docker-compose.worker.yml exec worker ps -o pid=,comm= -p 1
```

### Agent Tree 孤儿（数据库）

```sql
-- 仍标记 RUNNING 但所属 run 已结束的 Agent 节点（疑似孤儿 / 未正常收敛）
select node.agent_run_id, node.agent_id, node.agent_role, node.provider,
       node.delegation_depth, node.status, node.started_at
from public.analysis_agent_node node
join public.analysis_agent_run run on run.id = node.agent_run_id
where node.status = 'RUNNING'
  and run.status in ('FAILED', 'COMPLETED', 'CANCELLED')
order by node.started_at;
```

### Job / Task 孤儿

沿用第 6.4、12 节原则：先确认对应 Worker PID/容器与 Task lease 已失效，再回收 attempt 叶子；
不递归清理共享 cache。lease 与孤儿状态可结合 `analysis_agent_run` 与 Task 记录判断。

### Session 孤儿

```sql
-- 已过保留期但尚未标记 EXPIRED 的 Session checkpoint（应被 retention 回收）
select session_id, session_revision, status, storage_locator, retention_until
from public.analysis_session_checkpoint
where retention_until < now()
  and status <> 'EXPIRED'
order by retention_until;
```

> 注意：`storage_locator` 是宿主路径，属敏感字段，仅在受控排障场景查看，不得转贴进普通日志
> 或工单；日志侧已由 `redaction.ts` 只保留 basename。

## 15.5 Session corruption runbook

触发信号：`SESSION_RECOVERY_FAILED` / `SESSION_FORMAT_UNSUPPORTED` 错误码，或 checkpoint
状态被标记为 `CORRUPT` / `UNSUPPORTED`。

### 先分清三种形态，它们的处置完全不同

Session 日志由 `dsh-session-persistence-jsonl` 写在持久卷上，布局是
`<AGENT_SESSION_ROOT>/attempt-<摘要>/<workspace-slug>/<sessionId>/session.v3.jsonl`。

平台把编码显式设为 `compression: 'none'`（明文换行分隔），不是插件默认的 zstd 帧。这个选择
有两条运维含义：

- **日志可以直接读。** 事故里人能一眼看到尾部发生了什么，不需要先解码。
- **平台能自己验证已提交前缀。** 压缩形态下只能通过 backend 读，"committed 部分是否损坏"
  只有等 resume 真的失败才知道。

三种形态：

| 形态 | 判据 | 是否可恢复 | 处置 |
|---|---|---:|---|
| **崩溃残尾** | 最后一行 JSON 不完整，之前每行都完整 | 可恢复 | 无需干预。backend 丢弃残尾并补写合成收尾，Worker 正常 resume |
| **已提交前缀损坏** | 中间某行无法解析 | 不可恢复 | `SESSION_RECOVERY_FAILED`。保留原文，让平台开新 attempt |
| **格式/策略不匹配** | 文件名的 `vN` 或 policy hash 与当前不符 | 不可恢复 | `SESSION_FORMAT_UNSUPPORTED`。同上，绝不改写 JSONL |

**崩溃残尾不是故障。** 一个健康的系统在每次 Worker 被强杀后都会留下残尾；把它当损坏处理
等于"只有从没崩过的会话才能恢复"，resume 就形同虚设。

### 处置

1. **不修改、不删除 JSONL 原文**。它是审计与取证依据，也是唯一能区分上面三种形态的东西。
2. 手工判断形态（明文日志可以直接看）：

   ```bash
   # 最后一行是否完整 JSON —— 完整说明不是残尾问题
   tail -n 1 <storage_locator> | python3 -c 'import sys,json; json.loads(sys.stdin.read()); print("last record complete")'

   # 已提交前缀是否都能解析（排除最后一行）
   head -n -1 <storage_locator> | python3 -c '
   import sys,json
   for i, line in enumerate(sys.stdin, 1):
       if line.strip():
           try: json.loads(line)
           except Exception: print("corrupt committed record", i); break
   else: print("committed prefix is intact")'
   ```
3. 定位受影响 Session：

   ```sql
   select session_id, session_revision, status, content_hash, storage_locator
   from public.analysis_session_checkpoint
   where status in ('CORRUPT', 'UNSUPPORTED')
   order by created_at desc;
   ```
4. 将 checkpoint 标记为不可恢复由 Worker 侧完成；运维只需确认该 attempt 已收敛为终止态
   （`SESSION_FENCED` / `SESSION_RECOVERY_FAILED` 属终止错误码，见第 15.8）。
4. 通过正常重试路径创建**新 attempt**（新 `agent_attempt` + 新 claim token），不复用旧 token、
   不手改状态、不篡改旧 JSONL。
5. 若是 Harness 版本升级导致的格式不兼容（`SESSION_FORMAT_UNSUPPORTED`），按第 12.3 回滚原则
   处理：标记不兼容、创建新 attempt，不回滚数据库、不改 JSONL。
6. 已提交结果绝不重跑。

## 15.6 Web egress 故障 runbook

正常事件：`web_egress_completed`（记 `url` = origin+path、status、bytes、redirects）、
`web_egress_redirect`（记每一跳的 origin+path）。拒绝以 `WEB_EGRESS_DENIED` 返回。

常见故障与处置：

| 现象 | 可能原因 | 处置 |
|---|---|---|
| 全部 `WEB_EGRESS_DENIED`，allowlist 为空 | policy `web.allowedDomains` 未配置 | 该 attempt 无可达目的地属预期；如需放行，在模型/policy snapshot 补白名单域名，不改 Worker 代码 |
| 目的地被拒 | 命中内网 / IP 字面量 / 非白名单端口 / 平台基础设施主机 | 属安全策略预期；核对目标域名是否应加入白名单 |
| `too many redirects` | 跳转超过 `web.maxRedirects` | 核对目标站点跳转链；必要时调 policy，不放宽内网限制 |
| content-type 被拒 | 响应非可读文本 | 属预期；Web 工具只读文本 |
| 大面积 Web 超时 / 供应商故障 | 网络或外部站点问题 | 启用 `V4_BREAKER_DISABLE_WEB` 临时熔断，事故解除后移除并滚动重启 |

排障只用 `web_egress_*` 事件里的 origin+path、status、bytes 关联，**绝不打开 URL query/fragment
或网页正文**（`redaction.ts` 已强制只保留 origin+path）。

## 15.7 紧急熔断开关用法

场景：某类能力正在造成事故（如 Web egress 打爆供应商、Shell 写入触发磁盘或安全问题、
子 Agent 放大失控、Workflow 卡死）。

步骤：

1. 在 `.docker/worker.env` 或部署平台注入对应 `V4_BREAKER_DISABLE_*=1`。
2. 滚动重启 Worker（见第 15.9），使新 policy 生效。
3. 确认日志出现 `v4_emergency_breakers_active` 且 `breakers` 含对应项。
4. 事故解除后**移除**该环境变量并再次滚动重启，恢复 V4 默认全开。

注意：熔断只收窄不放开；用户配置与数据库 policy 语义保持默认全开不变。不要把熔断当作
长期开关，也不要用它替代 policy snapshot 调参。

## 15.8 第 9 节错误码表与处理动作

16 个稳定错误码定义在 `worker/src/ai/policy/v4-errors.ts`（`V4_ERROR_CODES`），与
`worker/harness/code-review-acp/v4-capability-contract.json` 的 `errorCodes` 一致，contract test
比对两边。稳定含义：UI 分类、运维告警、回滚判定按码走，消息可改但不含源码/Prompt/凭据。

标记说明：`终止` = attempt 不可能成功应立即收敛（`isTerminalV4Error`）；`可自纠` = 模型可换
工具/URL/证据再试，不终止 turn（`isModelCorrectableV4Error`）。

| 错误码 | 含义 | 类别 | 运维/重试处理动作 |
|---|---|---|---|
| `AGENT_IDENTITY_INVALID` | Agent capability 或 lineage 无效 | — | 疑似令牌伪造/重放；检查 `analysis_agent_node` lineage，勿放宽校验 |
| `AGENT_ROLE_DENIED` | 当前 role 无权调用该工具 | 可自纠 | 正常治理拒绝；无需干预，模型应换工具 |
| `SUBMIT_ROOT_ONLY` | 非根 Agent 尝试提交 | 可自纠 | 预期约束；唯一提交权归 root |
| `AGENT_TREE_LIMIT_EXCEEDED` | Agent 数量或深度超限 | 可自纠 | 检查 `maxAgentsPerAttempt`/`maxDelegationDepth`；失控时用 `V4_BREAKER_DISABLE_SUBAGENTS` |
| `AGENT_TREE_CANCELLED` | Agent Tree 已取消 | 终止 | 由 cancel/drain 触发；确认进程树已回收 |
| `MODEL_BUDGET_EXHAUSTED` | 模型预算耗尽 | 终止 | 评估需求范围与真实 usage 后调 `modelBudget`，勿盲目抬上限 |
| `TOOL_BUDGET_EXHAUSTED` | Tool/Web/Workspace 预算耗尽 | 可自纠 | 检查对应预算项与 attempt 是否异常放大 |
| `WORKSPACE_POLICY_DENIED` | Filesystem/Shell 越界 | 可自纠 | 预期沙箱拒绝；持续越界排查 prompt/工具行为 |
| `WEB_EGRESS_DENIED` | Web 目的地或请求被拒 | 可自纠 | 见 15.6；必要时调白名单或熔断 Web |
| `SESSION_FENCED` | Session 被新 Worker/attempt 接管 | 终止 | 并发写保护预期行为；确认无重复实例后走新 attempt |
| `SESSION_FORMAT_UNSUPPORTED` | Harness/Session 格式不兼容 | 终止 | 按 12.3：标记不兼容、创建新 attempt、不改 JSONL |
| `SESSION_RECOVERY_FAILED` | Session 无法安全恢复 | 终止 | 见 15.5 Session corruption runbook |
| `EVIDENCE_AGENT_INVALID` | Evidence 不属于当前 Agent Tree | 可自纠 | 证据归属校验失败；勿绕过校验 |
| `EVIDENCE_ORIGIN_INVALID` | Artifact 被错误用于证明现有实现 | 可自纠 | 仅 `PINNED_SNAPSHOT` 可证明代码已存在，Artifact 只能支撑建议 |
| `ATTEMPT_ALREADY_SEALED` | Attempt 已提交或终止 | 终止 | 拒绝迟到写入，属预期 fencing |
| `PROCESS_TREE_CLEANUP_FAILED` | 后代进程未完全回收 | 终止 | 见 15.4；确认 `procps` 可用、无残留构建/测试进程 |

## 15.9 V4 扩缩容与滚动重启

在第 13 节原则基础上补充 V4 特有步骤。

滚动重启：

1. 停止创建新 Job，关闭 admission（观察 `attempt_admission_closed`）。
2. 对活跃 Agent Tree 执行 cancel/drain（观察 `attempt_cancel_requested` → `attempt_drained`）。
3. 逐副本重启，`stop_grace_period: 30s` 内完成 ACP 取消与 lease 释放。
4. 确认旧 attempt 的进程树、socket、profile、`.writer.lock` 已回收（无 `process_tree_cleanup_failed`）。
5. 因 Session 卷持久，重启后 Worker 会尝试恢复未提交 Session（`session_writer_lock_reclaimed`
   属正常接管）；先用 1 个副本跑小 Job 验证恢复链路。
6. 再恢复目标副本数。

扩缩容：

- 每副本唯一 `WORKER_ID`（compose 由 hostname 派生）。
- `worker-sessions` / `worker-cache` 可多副本共享（分别由单写者锁与内容寻址保证安全）；
  `worker-jobs` instance lock 按 `WORKER_ID` 区分。
- 扩容**前**必须重新评估供应商 RPM/TPM/费用：多 Agent 峰值远高于 V3。
- `max_parallel_tasks` 是同一模型配置的最终并发阀门。
- 缩容前观察当前 lease 与活跃 Agent Tree，等待收敛或安全终止。
- 镜像回退只允许回到能读取扩展 schema 的兼容版本（见 12.3）。

## 15.10 生产切换与回滚原则（第 12 节）

生产切换（expand/contract，摘自 12.2）：

1. 在非生产或预发布环境完成 Release Gate、连通性、安全和全能力小 Job；
2. 停止创建新分析 Job；
3. 等待或安全终止全部存量 attempt，并确认不存在 `QUEUED`、`PREPARING_CODE`、`PROCESSING`、`FINALIZING` 状态的旧 Job；
4. 部署 Session/Web/Workspace 依赖与持久卷（先 `docker volume create` / compose 声明的
   `worker-sessions` 等，确认加密与备份）；
5. 在同一受控发布窗口先应用 DB expand migration 0027，再部署全部 V4 Worker；
6. 执行迁移后健康检查和受控 V4 smoke Job；
7. 确认新 Job 的 `policy_version`、policy snapshot 和 policy hash 均为 V4；
8. 恢复用户“开始 AI 分析”入口，此后所有新 Job 直接使用 V4；
9. 观察 Agent Tree、预算、错误率、磁盘与模型成本；
10. 达到稳定窗口后确认发布完成，保留期满后再做 contract migration。

回滚原则（12.3，硬约束）：

- 不直接回滚数据库 migration，优先前滚修复；
- 停止 V4 新 Job，关闭 Worker admission；
- cancel/drain 活跃 V4 Agent Tree；
- 回滚到能读取扩展 schema 的兼容 Worker；
- **已提交结果绝不重跑**；
- Session 格式不兼容标记 `SESSION_FORMAT_UNSUPPORTED`，创建新 attempt，不篡改 JSONL；
- 外部副作用通过 Artifact/Workspace/Audit 清理，不通过删除数据库记录掩盖；
- 紧急情况下运维可用熔断开关关闭 Web/Shell-write/Subagent/Workflow，但用户配置仍保持
  V4 默认全开语义，事故解除后恢复。

## 15.11 日志字段白名单与禁止记录项

所有日志必须经过 `worker/src/security/redaction.ts`。

允许记录（白名单）：

- Job / Task / Attempt / Root / Agent / Parent / Session ID；
- Tool 名、permission verdict、耗时、请求/响应字节数；
- Budget reserve/commit/deny；
- Session revision / checkpoint（locator 仅 basename，见下）；
- Cancel reason；
- Harness / profile / policy / tool-policy hash；
- Artifact metadata（类型、大小、content hash、verification status）。

禁止记录（`redaction.ts` 已强制）：

- Prompt、需求全文、源码、工具正文；
- **Session JSONL 内容**（transcript body）；
- API Key、service role、Git token、claim token、Broker/agent **capability token**（base64url 长串）；
- Authorization header（Bearer / Basic）；
- **Web URL 的 query 与 fragment、网页正文**（只允许 origin+path）；
- **storage locator 的完整宿主路径**（只保留 basename）。

排障一律用 ID / hash / 计数关联，不临时打开源码或密钥日志。

## 15.12 新表审计查询示例

```sql
-- (1) Agent Tree 结构：一次 run 的父子关系、角色、来源与状态
select node.agent_id, node.agent_role, node.provider, node.delegation_depth,
       node.status, node.parent_agent_node_id, node.error_code
from public.analysis_agent_node node
where node.agent_run_id = '<agent_run_id>'
order by node.delegation_depth, node.started_at;

-- (2) 工具审计：只含安全元数据（无正文/URL query），排查被拒工具
select ta.started_at, ta.tool_name, ta.permission_verdict, ta.error_code,
       ta.duration_ms, ta.request_bytes, ta.response_bytes
from public.analysis_tool_audit ta
where ta.agent_run_id = '<agent_run_id>'
  and ta.permission_verdict = 'DENY'
order by ta.started_at;

-- (3) 权限判定：哪一层策略拒绝了工具（global/role/child-filter/broker/lease/budget）
select pd.decided_at, pd.agent_role, pd.tool_name, pd.policy_layer,
       pd.decision, pd.reason_code
from public.analysis_permission_decision pd
where pd.agent_run_id = '<agent_run_id>'
  and pd.decision = 'DENY'
order by pd.decided_at;

-- (4) Session checkpoint：locator/hash/事件数/保留期（原文不入库）
select sc.session_id, sc.session_revision, sc.status, sc.event_count,
       sc.content_hash, sc.retention_until
from public.analysis_session_checkpoint sc
where sc.agent_run_id = '<agent_run_id>'
order by sc.session_revision desc;

-- (5) Artifact：候选 Patch/报告的类型、大小、校验状态与保留期
select a.artifact_type, a.workspace_path, a.size_bytes, a.content_hash,
       a.verification_status, a.retention_until
from public.analysis_artifact a
where a.agent_run_id = '<agent_run_id>'
order by a.created_at;
```

> `storage_locator` 为宿主路径属敏感字段，仅在受控排障查看，不得转贴到普通日志/工单。

---

# 16. V1.5 真实运行监控台运维

> 适用基线：迁移已应用到 `0032_analysis_runtime_monitoring.sql`。
> 执行方案：`代码评审平台/V1.5-加入agent运行监控体系/代码评审平台-V1.5真实运行监控台-最终执行方案.md`。
>
> 与第 15 节的关系：V4 的运维面（Session 卷、熔断、孤儿检查、错误码表）全部照旧。
> 本章只补运行监控这条**旁路**的运维面。它是旁路的含义很具体：事件链路整条挂掉，
> 分析任务照常跑完 —— 监控事件不参与 lease heartbeat、预算控制或提交校验。
> 因此**监控故障不是生产事故**，不要因为监控台显示不出来就去重启在跑的 attempt。

## 16.1 新增环境变量

| 变量 | 必填 | 默认值 | 说明 |
|---|---|---|---|
| `RUNTIME_EVENTS_ENABLED` | 否 | `true` | 关闭后 Worker 完全不上报，现有分析流程不受任何影响。只接受明确的真假值：拼错（`ture`）会让 Worker 启动即报 `ConfigError`，而不是被当成 `false` 静默关掉监控。 |
| `RUNTIME_EVENT_FLUSH_MS` | 否 | `800` | Reporter 定时 flush 间隔，范围 50–10000。**同时是工具生命周期的折叠窗口**：在这个窗口内闭合的工具只落一条 TERMINAL，不会出现「正在调用」态。 |
| `RUNTIME_EVENT_QUEUE_MAX` | 否 | `512` | 单 attempt 队列上限，范围 32–20000。溢出时按优先级丢弃并计数。 |
| `RUNTIME_EVENT_BATCH_MAX` | 否 | `64` | 单批最大事件数，范围 1–500。 |
| `RUNTIME_EVENT_RETENTION_DAYS` | 否 | `30` | 事件保留天数，范围 1–365。必须与数据库 `analysis_runtime_event.retention_until` 的默认值一致。 |

调大 `RUNTIME_EVENT_FLUSH_MS` 的唯一正当理由是事件量压不住（见 16.6）。代价是：窗口内
完成的工具全部看不到「正在调用」，只出现在已完成历史里。调小到 50–200ms 会让事件量接近
「每工具 2 行」，除排查插桩问题外不要这么做。

## 16.2 保留期清理与汇总补算的调度归属

仓库**没有 pg_cron**，也没有任何数据库侧定时器。清理与补算挂在 Worker 的
`runPeriodicCleanup()` 上（`worker/src/index.ts`，已有 10 分钟节流），与孤儿 Workspace
回收、Session 卷保留期共用同一个节流窗口：

| 动作 | 调用 | 频率 | 语义 |
|---|---|---|---|
| 事件保留期清理 | `purge_analysis_runtime_events(50000)` | ≤ 每 10 分钟一次/副本 | 只删 `retention_until < now()` **且所属 Job 已终态**的事件，按 `p_limit` 限量 |
| 汇总补算 | `backfill_analysis_run_rollups(200)` | 同上 | 补算 `rollup_version = 0`（终态事务里汇总失败）或缺行的 attempt |

两条硬约束：

1. **按批限量不是性能优化，是正确性要求。** 一次删几百万行会持有一个长事务，而
   `get_analysis_runtime_console` 的游标水位是 `pg_snapshot_xmin`：长事务会把水位钉住，
   前端于是看到「确认延迟」并停止推进游标。50000 是在本地实测下单批 100ms 级的量。
2. **`analysis_agent_run_rollup` 永不参与清理。** 事件是可丢的细节（30 天），汇总是不可丢
   的基线 —— 跨月的「优化前后对比」只能靠它。`purge_analysis_runtime_events` 里没有任何
   触及它的语句，`0032` 的测试对此有断言。

如果要改成运维侧定时任务（例如把 Worker 的这段关掉、用外部 cron 调 RPC），必须**二选一**，
不要两边都开：两个调用者同时分批删同一批行只会互相锁等。改动时同步更新这张表。

## 16.3 三级停写手段

按影响面从小到大，事故时**从上往下**用：

| 级别 | 动作 | 影响 | 恢复 |
|---|---|---|---|
| 1 | 让管理员不访问 `/monitoring` | 只停读，事件继续写 | 无需操作 |
| 2 | `RUNTIME_EVENTS_ENABLED=false` + 滚动重启 Worker | 停止产生**新**事件，历史事件与投影保留；保住新 Worker 的其他修复 | 改回 `true` 再滚动重启 |
| 3 | `revoke execute on function public.report_analysis_runtime_event_batch(text,uuid,uuid,uuid,integer,jsonb,integer) from service_role;` | 数据库侧硬停写 | `grant execute ... to service_role;` |

第 3 级的关键行为：Worker 会识别 `42501 / insufficient_privilege` 并**自动进入静默模式** ——
停止上报、清空队列、每 5 分钟最多记一条 `runtime_event_silenced`。它不会持续刷错误日志，
也不会因为上报失败影响工具执行或模型调用。看到 `runtime_event_silenced` 就说明有人执行了
第 3 级（或权限配置出错），需要立刻确认是不是预期动作。

**回滚自由度**：首版没有改 `v4-capability-contract.json`，manifest 哈希不变，所以新旧 Worker
可以混跑同一批次。回退 Worker 镜像不需要排空活动批次。这条自由度在 Phase 3（Workflow/Job
实例树）落地后会消失 —— 那次变更会改哈希，必须配排空窗口。

## 16.4 告警项与判据

Worker 侧结构化日志（经 `worker/src/logger.ts`，字段已脱敏）：

| 日志事件 | 级别 | 含义 | 处理动作 |
|---|---|---|---|
| `runtime_event_silenced` | error | 权限被回收或配置异常，已停止上报 | **立即告警**。确认是不是有人执行了 16.3 第 3 级 |
| `runtime_event_dropped` | warn | 队列溢出丢弃了事件（含 event_type 与队列深度） | **立即告警**。丢弃会让归因偏小；先看是否需要调大 `RUNTIME_EVENT_QUEUE_MAX` |
| `runtime_event_queue_high` | warn | 队列超过上限 80% | 观察。持续出现说明 flush 跟不上产出 |
| `runtime_event_flush_failed` | warn | 单批上报失败（带第几次重试与稳定错误码） | 偶发忽略；连续出现查数据库连通性 |
| `runtime_event_attempt_summary` | warn | attempt 收敛时有丢弃/静默/整批失败 | 与上面几条合并看 |
| `runtime_event_tool_drift` | warn | ACP 侧观测到的工具调用数 > 插件上报数 | **插桩漏洞信号**。说明 `tools/pre-execute` 漏了某条路径，或上报被丢。只用来发现问题，不要用它补数据 |
| `attempt_rollup` | info | 每次 attempt 终态一行自包含归因 | 不告警。它是数据库汇总失败时的备份通道，字段名与 `analysis_agent_run_rollup` 列名逐字一致 |
| `runtime_event_purged` / `run_rollup_backfilled` | info | 清理与补算的行数 | 不告警。连续多轮 `failed > 0` 才查 |

数据库侧聚合（手工查询或做成 ADMIN 只读 RPC）：

```sql
-- (1) 活动 task 超过 15 秒没有事件，但 Worker 心跳仍在线 → 事件链路异常
select task.id, task.worker_id, max(event.occurred_at) as last_event_at
from public.analysis_story_task task
join public.analysis_job job on job.id = task.job_id
left join public.analysis_runtime_event event on event.task_id = task.id
join public.analysis_worker_heartbeat hb on hb.worker_id = task.worker_id
where task.agent_status = 'RUNNING'
  and job.status = 'PROCESSING'
  and hb.last_seen_at >= now() - interval '20 seconds'
group by task.id, task.worker_id
having coalesce(max(event.occurred_at), 'epoch'::timestamptz) < now() - interval '15 seconds';

-- (2) 事件到达延迟 p95（received_at - occurred_at）。> 5 秒持续 5 分钟 → 数据库或网络拥塞
select percentile_cont(0.95) within group (
         order by extract(epoch from (received_at - occurred_at)) * 1000
       ) as receive_lag_p95_ms
from public.analysis_runtime_event
where received_at >= now() - interval '5 minutes';

-- (3) 提交水位滞后。> 30 秒 → 有长事务，游标逃生阀已生效
select coalesce(
         (extract(epoch from (now() - min(received_at))) * 1000)::bigint, 0
       ) as watermark_lag_ms
from public.analysis_runtime_event
where xact_id >= pg_snapshot_xmin(pg_current_snapshot())::text::bigint;

-- (4) 未闭合超过 5 分钟的 correlation，且 run 已终态
--     → §6.2 规则 5 的清理有漏洞（终态时应当补写 TOOL_CALL_CANCELLED）
select started.agent_run_id, started.correlation_id, started.occurred_at,
       started.payload ->> 'tool_name' as tool_name
from public.analysis_runtime_event started
join public.analysis_agent_run run on run.id = started.agent_run_id
where started.phase = 'STARTED'
  and started.occurred_at < now() - interval '5 minutes'
  and run.status <> 'RUNNING'
  and not exists (
    select 1 from public.analysis_runtime_event terminal
    where terminal.agent_run_id = started.agent_run_id
      and terminal.correlation_id = started.correlation_id
      and terminal.phase = 'TERMINAL'
  );

-- (5) 表容量与最早事件。增长超出 16.6 的测算预算 → 运维告警
select count(*) as rows, min(received_at) as oldest, max(received_at) as newest,
       pg_size_pretty(pg_total_relation_size('public.analysis_runtime_event')) as size
from public.analysis_runtime_event;

-- (6) 清理连续失败的信号：终态 Job 仍有大量过期事件
select count(*) as expired_rows_on_terminal_jobs
from public.analysis_runtime_event event
join public.analysis_job job on job.id = event.job_id
where event.retention_until < now() - interval '1 day'
  and job.status in ('SUCCEEDED', 'FAILED');

-- (7) 汇总待补算积压：rollup_version = 0 或缺行
select count(*) as pending_rollups
from public.analysis_agent_run run
left join public.analysis_agent_run_rollup rollup on rollup.agent_run_id = run.id
where run.status in ('COMMITTED', 'FAILED')
  and (rollup.agent_run_id is null or rollup.rollup_version = 0);
```

告警阈值汇总：`runtime_event_dropped > 0` 立即；`runtime_event_silenced` 立即；
receive lag p95 > 5 秒持续 5 分钟；watermark lag > 30 秒；未闭合 correlation > 5 分钟且 run
已终态；`pending_rollups` 连续两个小时不下降。

## 16.5 AI 诊断取数（只读）

三个诊断 RPC **不授予 `authenticated`**，浏览器拿不到；取数通道是仓库内的只读 CLI：

```bash
npm run monitor:attempt  -- --task <task_id> [--attempt N] [--format md|json]
npm run monitor:trend    -- --group-by model_label,policy_hash --since 30d
npm run monitor:findings -- --since 7d
```

约束（都是硬要求）：

- 默认连**本地** Supabase。`SUPABASE_URL` 指向非本地地址时脚本直接报错，除非显式加
  `--remote`；`--remote` 还要在 TTY 里输入 `yes` 二次确认。
- 凭据从环境变量或既有 `.env.local` / `.docker/worker.env` 读取，**绝不打印**。
- 输出前做一次敏感模式扫描（Bearer / JWT / `sk-` / URL / 宿主机绝对路径 / `.jsonl`），
  命中即拒绝输出并报错。命中说明数据库 payload allowlist 出现回归，先查
  `analysis_runtime_event_payload` 与插桩点，**不要绕过这个检查**。
- 输出开头固定打印 `instrumentation_health`（`events_dropped` / `unattributed_pct` /
  `timeline_truncated`）：先说清这份数据能不能采信，再看结论。

`attempt` 子命令还会返回机器可读的 `instrumentation_gaps`，明确列出**没有插桩**的部分
（Worker→Supabase RPC 往返、Harness 内部编排、被折叠的快工具 STARTED、Phase 3 之前的
Workflow/Job 实例树）。它们全部落在 `unattributed_ms` 里 —— 看到 `unattributed_pct` 偏高
先对照这张清单，而不是怀疑归因算错。

## 16.6 事件量与切分区时机

`0032` **不建分区**，但保留了 `event_day` 列（由钳制后的 `occurred_at` 确定性推导，对重试
稳定）。不分区的原因是分区表的唯一约束必须包含分区键，`unique (event_uuid)` 建不出来，而
退成 `unique (event_uuid, received_at)` 会让幂等彻底失效。

单批次事件量估算（已按 800ms 折叠规则）：

```text
事件数 ≈ 需求数 × (
    Attempt 阶段事件 ~12
  + Agent 注册/终态 × 2 × Agent 数
  + 工具事件：快工具 × 1 + 慢工具 × 2
  + 模型事件：模型请求数 × 2
) + Job 层事件 ~10
```

用生产数据校准（不要用估算值做容量决策）：

```sql
-- 每次 attempt 的实际工具调用数与慢调用占比
select agent_run_id,
       count(*) as tool_calls,
       count(*) filter (where duration_ms >= 800) as slow_calls
from public.analysis_tool_audit
group by agent_run_id
order by tool_calls desc
limit 50;

-- 慢调用整体占比：> 40% 说明折叠收益低，考虑调大 RUNTIME_EVENT_FLUSH_MS
select round(
         100.0 * count(*) filter (where duration_ms >= 800) / greatest(count(*), 1), 1
       ) as slow_pct
from public.analysis_tool_audit;

-- 每次 attempt 的模型请求数与 Agent 数
select agent_attempt, model_requests, agent_count
from public.analysis_agent_run
where status in ('COMMITTED', 'FAILED')
order by model_requests desc
limit 50;
```

切分区的触发条件：**单日事件超过 100 万，或表行数接近 5000 万**。届时另开一个 contract
migration 做「建分区表 → 搬数据 → 改名切换」，需要停机窗口。因为 `event_day` 已经在，那次
迁移把约束换成 `unique (event_uuid, event_day)` 即可，**不需要改任何 Worker 或前端代码**。

把实测到的数字写回本节，不要让它长期停留在「估算」状态。

## 16.7 上线顺序与验收

必须 expand-first：

1. 备份数据库，记录当前迁移版本与 `v4_harness_manifest` 的 `is_active` 行。
2. 测试环境顺序应用到 `0032`，跑 `supabase/tests/0032_analysis_runtime_monitoring_test.sql`
   与 `0031_manifest_freeze_and_worker_overview_test.sql`，确认两个成功标记。
3. 用**旧 Worker**跑一个小批次，证明 expand 向后兼容（旧 Worker 不上报事件，业务不受影响）。
4. 构建新 Worker：`npm run worker:build`（内含 `harness:manifest:check`），确认输出的
   manifest 哈希**与部署前一致**。不一致就说明有人改了契约，停止发布。
5. 先滚动部署 1 个副本，跑单需求 smoke，逐项核对：
   - 事件链路：`analysis_runtime_event` 有 `JOB_* / TASK_CLAIMED / ATTEMPT_* / AGENT_* / TOOL_* / MODEL_*`；
   - 时间线里能看到 `bash` / `edit` / `grep` 这类 harness origin 工具，**不只是 5 个平台快照工具**；
   - node 投影 `current_activity_*` 在跑的时候非空、终态后被清空；
   - `open_correlations` 能显示卡住的工具；
   - `analysis_agent_run.tool_calls` **没有**因为监控上报被放大（对比同规模的历史 attempt）；
   - 敏感字段扫描：跑一次 `npm run monitor:attempt`，脚本自带扫描，命中即失败。
6. 滚动部署其余副本，观察 16.4 的全部告警项。
7. 部署前端 `/monitoring`（导航仅 ADMIN）。
8. 执行权限验收：非创建者 REVIEWER 与 VIEWER 调用 `get_analysis_runtime_console` 必须被
   服务端拒绝（`batch management permission required`）；非 ADMIN 调用
   `admin_list_active_analysis_batches` 必须报 `ADMIN role required`。
9. 稳定后再考虑 Phase 3（Workflow/Job 实例树，**需要独立 manifest 迁移与排空窗口**）与
   Phase 5（Realtime，独立灰度）。首版不依赖它们。

回滚：前端回退到无 `/monitoring` 的版本即可（事件表保留，不做 destructive down migration）；
Worker 用 16.3 第 2 级；数据库用第 3 级。页面看到 `last_event_at` 陈旧时显示「监控数据已暂停」，
**不得把任务判定为失败**。

---

# 17. V1.6：受管 DSH Skill Bundle

管理员在前端维护多文件 Skill Bundle；版本元数据与冻结快照进数据库，归档字节进专用私有
对象存储；创建 Analysis Job 时冻结**全部已发布且启用**的版本；Worker 下载、校验、缓存
不可变 Bundle，并在每次 attempt 启动前物化到私有 `DSH_HOME/skills/<name>/`。

一句话记住边界：**技能包不物化到代码 Workspace。** Workspace 只放被评审代码、可写
overlay、artifacts 和临时文件；Skill Bundle 属于 dsh 运行配置，生命周期跟随 per-attempt
`DSH_HOME`。

## 17.1 新增环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `SKILL_CACHE_ROOT` | `/workspace/skill-cache` | 共享只读 Skill Cache 根。**必须是命名卷** |
| `SKILL_CACHE_MAX_BYTES` | `4294967296`（4 GiB） | 超过即按最后访问时间从旧到新回收 |
| `MODEL_IMAGE_INPUT_ENABLED` | `false` | 模型路由是否声明 image 输入。决定 `assets/*.png` 能不能被 `read_image` 读到，见 17.9 |

Compose 已声明 `worker-skill-cache` 卷。它与 Session 卷有一个关键区别：

* **Session 卷必须备份、必须加密**：Session JSONL 是恢复未提交会话的唯一依据，丢了就没了。
* **Skill Cache 卷不需要备份**：里面每一个 bundle 都能按 Job 冻结的 locator 从对象存储
  重新下载。回收是无损的，所以容量上限可以设得比较紧 —— 卷满会让所有在跑的 attempt 一起
  失败，而重新下载只多花一次带宽。

多副本共享同一个 cache 卷是**设计意图**：内容按 `bundle_hash` 寻址、发布后只读，并发发布
由临时目录 + 原子 `rename` 裁决（失败者清理自己的临时目录并复用胜出者）。这里刻意不用文件
锁 —— 锁需要持有者活着，而 Worker 可能在任何时刻被 kill，留下一把永不释放的锁。

## 17.2 上线顺序

1. 应用迁移 `supabase/migrations/20260917100000_managed_dsh_skill_bundles.sql`。它建表、
   建私有 `skill-bundles` bucket、装 RLS 与不可变触发器、改 `enqueue_analysis_job`，并把
   **全部历史 Job 回填成空技能目录**（`skill_snapshot_version = 0` +
   `empty_skill_catalog_hash()`）。
2. 应用 `supabase/migrations/20260917121000_v4_harness_manifest_r2.sql`。它只做一件事：把
   `skill-badge` 从 `enabledPlugins` 移到 `disabledPlugins`，与已安装 base bundle 的真实
   状态对齐。**它会换掉 contract hash**，所以必须在没有在途 Job 的窗口里做（见 17.7）。
3. 部署 Edge Function：`supabase functions deploy skill-bundle-admin`（**不要**
   `--no-verify-jwt`），并设置 `ALLOWED_ORIGINS`。
4. 部署前端（`/skills`，导航仅 ADMIN）。
5. 发布初始 Bundle，确认列表里的容量水位与 catalog hash 都出来了。
6. 部署带 `worker-skill-cache` 卷的新 Worker。
7. 建一个新 Job，逐项核对：
   - `analysis_job.skill_snapshot_version = 1`、`skill_catalog_hash` 非空且不等于空目录 hash；
   - `analysis_job_skill_snapshot` 的 `archive_object_key` 是固定 locator（不是 signed URL）；
   - Worker 日志出现 `skill_bundle_provisioned`（首次 `CACHE_MISS` + `DOWNLOADED`）与
     `agent_attempt_skills_materialized`；
   - 第二个 Story Task 的日志里 `skill_cache_hits` 增长、`skill_bundle_download_bytes` 为 0；
   - `agent_attempt_started` 之前没有任何技能相关错误码。

## 17.3 三层 hash 与"哪一层坏了"

| hash | 证明什么 | 不能证明什么 |
|---|---|---|
| `archive_sha256` | 下载的**字节**完整 | 不能证明它是同一份逻辑内容（同一份文件用不同压缩参数重打包，字节就变了） |
| `bundle_hash` | 展开后的**逻辑文件集合**一致 | 不能证明这个集合属于本 Job |
| `skill_catalog_hash` | 本 Job 冻结的**集合身份**一致 | — |

规范格式是显式的行式文本（`skill-bundle-v1` / `skill-catalog-v1`），SQL 与 TypeScript 逐
字节一致，排序用 `collate "C"` 对齐 JS 的码元序。**刻意不用 JSON 序列化**：Postgres 的
`jsonb::text` 渲染成 `{"a": 1}`，`JSON.stringify` 渲染成 `{"a":1}`，两侧各自序列化必然
对不上。`src/lib/__tests__/skill-limits-consistency.test.ts` 机械守住这一点。

## 17.4 错误码表

| 码 | 触发 | 处理动作 |
|---|---|---|
| `SKILL_BUNDLE_DOWNLOAD_FAILED` | 对象存储不可达 / 404 / 字节数不符 | 查 Storage 可用性与 service-role key；对象是否被误删（`analysis_job_skill_snapshot` 引用的对象**不该**可删） |
| `SKILL_ARCHIVE_HASH_MISMATCH` | 下载字节的 SHA-256 与冻结值不同 | **按安全事件处理**：已发布对象本应不可覆盖，出现即说明有人绕过了发布链路 |
| `SKILL_BUNDLE_INVALID` | 归档结构非法、`SKILL.md` frontmatter 非法，或 Worker 重算的 bundle hash / 展开大小 / 脚本标记与冻结值不符 | 同上；若是刚发布的包，先看 Edge Function 的 `validation_rejected` 日志 |
| `SKILL_BUNDLE_LIMIT_EXCEEDED` | 超出单包或全目录上限 | 管理员减包或拆技能。**不要**上调上限来"解决"它，上限保护的是首轮上下文与磁盘 |
| `SKILL_CACHE_CORRUPT` | 共享 cache 内容与它的 bundle hash 不再一致 | 自愈：Worker 会删掉该目录并重新下载。反复出现说明卷有问题 |
| `SESSION_SKILL_SET_MISMATCH` | Job 冻结目录、checkpoint 记录、Worker 重算三方不一致 | 不恢复，开新 attempt。若持续出现，核对是否有旧 Worker 在跑 |

全部是**终态**：方案 §12 明确不允许回退到空技能、不允许改用当前已发布版本、不允许静默
新建 Session。一个"少了三个技能但跑完了"的评审结论比一个明确失败的 attempt 危险得多 ——
它看起来是有效结果。

## 17.5 告警判据

| 指标 | 判据 | 含义 |
|---|---|---|
| `SKILL_ARCHIVE_HASH_MISMATCH` / `SKILL_BUNDLE_INVALID` | 出现 ≥ 1 次 | 安全事件，立刻查 |
| `skill_cache_misses / (hits + misses)` | 稳态 > 0.3 | cache 卷太小或被反复回收；核对 `SKILL_CACHE_MAX_BYTES` |
| `skill_cache_reclaimed` | 每小时 > 5 次 | 同上 |
| `SKILL_BUNDLE_LIMIT_EXCEEDED` | 出现 | 目录已撞上限，新 Job 会建不出来 |
| Skill Cache 卷用量 | > 85% | 回收没跟上；卷满会让所有 attempt 失败 |
| 含脚本技能数 | 变化 | 每一次增减都应当有对应的发布审计 |

查询示例：

```sql
-- 冻结目录与实际调用的对照：哪些技能被冻结了却从没被加载过？
select snapshot.name, snapshot.source_version, count(invocation.id) as loads
from public.analysis_job_skill_snapshot snapshot
left join public.analysis_skill_invocation invocation
  on invocation.skill_snapshot_id = snapshot.id
where snapshot.job_id = $1
group by snapshot.name, snapshot.source_version
order by loads, snapshot.name;

-- 资源读取分布（只有安全的规范相对路径，没有正文）。
select skill_name, resource_relative_path, count(*)
from public.analysis_tool_audit
where agent_run_id = $1 and skill_name is not null
group by skill_name, resource_relative_path
order by 3 desc;

-- 目录容量水位（与管理页顶部那五行同源）。
select public.admin_list_review_skills() -> 'capacity';
```

## 17.6 清理归属

| 对象 | 谁清 | 依据 |
|---|---|---|
| staging 上传对象与行 | `expire_review_skill_uploads()`（返回要删的 key，由调用方走 Storage API 删） | `expires_at`，默认 24 小时 |
| 正式对象 | **不清**。有 `analysis_job_skill_snapshot` 引用即永久保留 | 迁移装了 `storage.objects` 的 before-delete 触发器；即使触发器因权限装不上，`skill-bundles` 也没有任何 DELETE 策略 |
| Skill Cache | Worker 每次 attempt 启动前按容量 + 最后访问时间回收，本次要用的 hash 排除在外 | `SKILL_CACHE_MAX_BYTES` |
| per-attempt `DSH_HOME/skills` | 正常收敛随 profile cleanup 删；崩溃残留由 attempt orphan cleaner 回收 | — |

物化后的技能树是 `0500`（目录）/ `0400`（文件）。删除只读树需要先放宽权限 —— cleanup 会
先调 `relaxSkillTree`。**不要手工 `rm -rf` 一个 attempt 树**：失败是静默的，表现是磁盘几周
后慢慢满。

## 17.7 回滚

1. 暂停新 Job（前端不再触发 enqueue）。
2. 排空或取消带 Bundle snapshot 的 Job（`analysis_job.skill_snapshot_version >= 1`）。
3. 回滚 Worker / 前端 / Edge Function。
4. **保留**数据库版本行、manifest、正式对象与审计。不做 destructive down migration：
   已发布对象与快照是"这个 Job 当时用的是什么"的唯一证据。
5. 旧 Worker 不得 claim 带 Bundle snapshot 的新 Job —— 它不理解那份快照，会用空技能目录
   跑出一个看起来有效的结论。r2 迁移的 contract hash 变更正好提供了这道闸门：旧 Worker 的
   契约摘要与新 Job 冻结的不同，`factory.ts` 会以 `SESSION_FORMAT_UNSUPPORTED` 拒绝。

## 17.8 为什么 frontmatter 是发布前置条件

dsh 的 `skill-filesystem.parseSkillFile` 对以下情况**只写一行 `logger.warn` 然后 return**：

* 缺 YAML frontmatter；
* frontmatter 里没有非空的 `name` 或 `description`；
* `name` 不是合法 dsh 技能名；
* 出现 `disableModelInvocation` / `modelInvocable` / `userInvocable` 这类旧式驼峰键。

后果是一个**没有任何平台错误码的静默失败**：Bundle 发布成功、Job 冻结成功、Worker 下载
校验物化全部成功、`<DSH_HOME>/skills/<name>/SKILL.md` 确实在磁盘上 —— 而模型的首轮目录里
就是没有这个技能。排查时唯一的线索藏在 Harness 子进程的 stderr 里。

所以平台在**发布**时就拒。校验器（Worker 与 Edge Function 各一份）只接受一个很窄的 YAML
子集（平铺 `key: value`）：接受集合必须是 dsh 接受集合的子集，宽容的自制解析器会放过
dsh 会拒的东西，把问题推回运行时。额外两条比 dsh 更严的规则：

* frontmatter 的 `name` 必须**等于**平台技能名。dsh 只要求它形如合法名字，于是一个目录叫
  `a`、frontmatter 写 `b` 的 Bundle 会被注册成 `b` —— 冻结目录的身份、审计归因和
  `skill(name)` 调用会全部对不上。
* `disable-model-invocation: true` 直接拒。这个平台唯一的技能消费者就是模型，发布一个
  模型不可调用的包只会白占首轮目录预算。

`description` / `whenToUse` **只**来自 frontmatter。数据库里的那份是投影，发布 RPC 从
`review_skill_upload.entry_frontmatter` 取值，不接受调用方另给一段文字 —— 否则管理页显示的、
审计里记的和模型实际看到的会是三份不同的文本，而且没有任何机制会发现这个分叉。

## 17.9 图片资源需要一条声明了 image 输入的模型路由

技能包可以带 `assets/*.png|jpg|webp|gif`，模型用 `read_image` 读它们。但 `read_image` 的
准入检查读的是**模型路由声明的输入模态**，而 `llm-pi-ai` 的默认值是 `['text']`。不显式
声明的后果是实测出来的：

```
Error: cannot read "…/assets/flow.png" as an image:
model "…" does not declare image input; switch to an image-capable model to read images
```

所以 attempt patch **总是显式声明**模态，取值由 `MODEL_IMAGE_INPUT_ENABLED` 决定：

| 取值 | 声明 | 后果 |
|---|---|---|
| `false`（默认） | `['text']` | 图片在发出去**之前**被拒，错误可读且明确指向配置 |
| `true` | `['text','image']` | 图片真的被读进上下文 |

默认取 false 是刻意的：dsh 自己的注释说得很直白 —— under-claiming 在图片发出去之前就拒绝
它，over-claiming 会把图片发给一个处理不了它的 provider，**两个错误的代价不一样**。打开
之前必须确认端点真的接受图片输入。

关掉时含图片的 Bundle 仍然可以发布 —— 那些字节对人和脚本仍有价值，只是模型读不到。这一点
写在这里而不是留给现场猜。

两种取值都有真实进程用例覆盖：`worker/src/__tests__/v16-skill-dsh-runtime.test.ts`。

## 17.10 §19 验收标准怎么复跑

§19 的 20 条里，有 5 条问的是"dsh 实际做了什么"，只能由真实进程回答：

```bash
# 真实 dsh 进程 + 脚本化 mock 模型端点，秒级，不烧任何真实预算。
RUN_ACP_INTEGRATION=1 npx vitest run worker/src/__tests__/v16-skill-dsh-runtime.test.ts
```

它逐条断言：

| 断言 | 覆盖 |
|---|---|
| 首轮请求含 name + description，**不含** SKILL.md 正文与资源正文 | §19.9 |
| `skill(name)` 结果含正文，且 `Base directory for this skill:` 正好是 per-attempt 物化目录 | §19.10 |
| 绝对 resourceBase 下的文本资源可读；图片按 17.9 的两种模态各断言一次 | §19.11 |
| 只调 `skill` 时 Workspace 内哨兵不出现；显式 `bash` 调用时出现 | §19.12 |
| Workspace 里同名的 `.dsh/skills` 技能全程不可见 | §19.13 |
| 脚本对 Workspace 之外的写被沙箱拦住（`sandbox: file access denied`） | §7.4 |

哨兵**必须**放在 Workspace 之内。放在外面时沙箱会拦住写入，于是"脚本跑了但写被拦"和
"脚本没跑"长得一模一样 —— 那条断言就退化成永远为真。这是写这份用例时实测踩到的坑。

数据库侧的那些条（§19.4/5/6/14/15/16/17/20）由
`supabase/tests/20260917100000_managed_dsh_skill_bundles_test.sql` 覆盖：

```bash
psql -v ON_ERROR_STOP=1 -f supabase/tests/20260917100000_managed_dsh_skill_bundles_test.sql
```

## 17.11 脚本类 Bundle 的风险与关闭方式

DSH **不会**因为加载技能而执行任何脚本。但拥有 `bash` 的 Agent 可以按绝对路径显式运行
`scripts/` 下的文件，受角色权限、Sandbox、命令超时与容器资源限制约束。物化时统一 `0400`、
不继承 ZIP 的 executable bit —— 但要说清楚：**`bash x.sh` 不需要 `+x`**，把 mode 位当成
执行闸门是危险的误解。

若生产安全要求不能接受这个语义，正确的做法是**通过部署策略不发布脚本类 Bundle**（发布页
的额外确认就是这个闸门的落点），而不是假设"文件没有 +x 就不能执行"。紧急情况下可以用
`V4_BREAKER_DISABLE_SHELL_WRITE` 把沙箱压到 `read-only`，但那会同时关掉实现型 Agent 的
全部写操作。

---

# 18. V1.7：模型网络类型（公网 / 内网）

模型走不走宿主机代理，由**模型自己的属性**决定，不再由代理侧的域名白名单决定。

| 模型网络类型 | 数据库取值 | 访问方式 |
|---|---|---|
| 公网模型 | `DIRECT`（默认） | Worker 直接请求 |
| 内网模型 | `HOST_PROXY` | Worker 经 `host.docker.internal:17890` 本机代理请求 |

在页面「模型管理 → 网络类型」里选。既有模型全部是 `DIRECT`，所以这次改造对它们零影响。

## 18.1 为什么不再用域名白名单

阶段一把判断放在代理侧（`MODEL_VPN_PROXY_ALLOWED_HOSTS`），实测出两个缺陷：

1. **公网模型被误伤。** 连接测试无条件把请求送进代理，代理发现主机不在白名单就回
   `HTTP 403` —— 管理员看到"模型返回 403"，而真正的拒绝方是我们自己的代理。
2. **正式评审链路没走代理。** 代理只接在"测试连接"上，于是内网模型**测得通、真跑必挂**。
   绿灯之后才失败是最坏的一种不一致。

现在两条链路共用同一个判定函数（`worker/src/model-connectivity/network-mode.ts`
的 `resolveModelNetworkRoute`），不可能再分叉。

## 18.2 冻结语义

网络类型随 Job 冻结进 `analysis_job.model_snapshot`，随连接测试冻结进
`model_connectivity_test.network_access_mode_snapshot`。任务执行期间管理员改配置，**不会**
把在跑的 attempt 搬到另一张网上。

在途旧 Job 的快照里没有这个字段，缺失一律按 `DIRECT` 处理 —— 那是改造前的行为。

## 18.3 未配置代理时的行为

`HOST_PROXY` 的模型落到一台**没有**配 `MODEL_CONNECTIVITY_PROXY_*` 的 Worker 上时，
连接测试与正式评审都以稳定错误码 `MODEL_PROXY_NOT_CONFIGURED` 失败，错误文案直接指向
Worker 配置。

**绝不静默直连**：内网域名交给公网 DNS 解析可能命中一个同名的外部主机，而 API Key 会
跟着请求发出去。

## 18.4 正式评审链路的机制与已知代价

`llm-pi-ai` 没有 per-provider 代理配置，底层 `@earendil-works/pi-ai` 也没有自定义 fetch
钩子，所以只能用 Node 的环境代理：给 dsh 子进程注入
`NODE_USE_ENV_PROXY=1` + `HTTP(S)_PROXY`。实测三组对照确认了必要条件（只设
`HTTPS_PROXY` 会被 Node 24 忽略）。

**已知代价**：`@deepseek-ai/dsh-subprocess` 的 `scrubbedParentEnv()` 只按
`/KEY|PASSWORD|SECRET|TOKEN/i` 与 `DSH_*` 过滤变量名，所以这些变量会被 Agent 的 `bash`
继承（真实 dsh 进程实测确认，见
`worker/src/__tests__/v17-model-network-dsh.test.ts`）。也就是说：**选了内网模型的 attempt，
Agent 的 Shell 命令也能经这条代理访问公司内网。**

边界与缓解：

- 只有 `HOST_PROXY` 的 attempt 会下传，公网模型的 attempt 完全不受影响；
- 容器本来就有公网出口（Shell 网络访问与 platform-web 白名单不等价，V1.6 §7.4 已承担），
  本次增量只是**内网可达性**；
- 代理要求认证、只监听 `127.0.0.1`、只放行 80/443（`MODEL_VPN_PROXY_ALLOWED_PORTS` 可覆盖）；
- 代理拒绝 loopback、链路本地/云元数据、Docker 管理地址与通配地址（`isDeniedTarget`，有单测）；
- `agent_attempt_started` 日志带 `model_via_host_proxy`，这件事在审计里可见。

不接受这个语义时，正确做法是**不把模型标成内网模型**（改回公网并另想办法打通网络），
而不是指望 mode 位或环境变量顺序去阻止它。

## 18.5 代理保留的边界

删掉的是域名白名单。保留的是：

| 边界 | 位置 |
|---|---|
| Basic 认证（`timingSafeEqual` 比较） | `isAuthorized` |
| 仅监听 `127.0.0.1` | `MODEL_VPN_PROXY_BIND` |
| 仅放行 80/443（可覆盖） | `MODEL_VPN_PROXY_ALLOWED_PORTS` |
| 拒绝 loopback / 云元数据 / Docker 管理地址 / 通配地址 | `isDeniedTarget`（纯函数，有单测） |
| 日志不含 Authorization / API Key / 请求正文 | `logEvent` 的固定字段 |

## 18.6 怎么复跑验证

```bash
# 单测：判定函数 + 代理 SSRF 守卫 + claim 字段映射
npx vitest run worker/src/__tests__/v17-model-network-mode.test.ts

# 真实 dsh 进程：代理环境按模式下传，且记录 Shell 继承这一代价
RUN_ACP_INTEGRATION=1 npx vitest run worker/src/__tests__/v17-model-network-dsh.test.ts

# 数据库契约：默认 DIRECT、快照冻结、无残留重载、审计逐字段 diff 未被破坏
psql -v ON_ERROR_STOP=1 -f supabase/tests/20260917130000_model_network_access_mode_test.sql
```

端到端（本地库 + 本地 Worker 容器 + 真实 launchd 代理）三个场景的实测结果见
`需求开发评审一致性平台/V1.7-内网模型连接/…-最终执行方案.md` 第 10 节。
