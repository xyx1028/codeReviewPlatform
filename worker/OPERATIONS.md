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

模型配置默认：

| 字段 | 默认值 |
|---|---:|
| `context_window` | 131072 |
| `max_output_tokens` | 8192 |
| `agent_max_model_requests` | 120 |
| `agent_max_retry_requests` | 6 |
| `agent_max_compaction_requests` | 4 |
| `max_parallel_tasks` | 4 |

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
