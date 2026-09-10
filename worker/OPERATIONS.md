# Worker 运维与部署手册

本文覆盖《代码评审平台-AI 自动化 MVP 最终执行方案》第 15、16、17、18、23、25 节中
Worker、Docker 与运维部分的落地说明。仅涉及后台分析 Worker，不改动前端与数据库结构。

## 1. 组件概览

后台 Worker 位于 `worker/`，独立于前端构建：

- `worker:build` → `tsc -p tsconfig.worker.json`，产物在 `dist-worker/`。
- `worker:start` → `node dist-worker/index.js`。
- `worker:dev` → `tsx worker/src/index.ts`（本地开发热运行）。
- `test:worker` → `vitest run worker`（单元测试）。

Worker 主动轮询 Supabase，不监听任何入站端口；只需出站访问 Supabase、GitLab
（`git.kingdee.com`）与所选模型 API。

## 2. Worker Secret 清单（方案 §15.1）

以下变量在启动时被严格校验（见 `worker/src/config.ts`），缺失或非法即拒绝启动：

| 变量 | 必填 | 说明 |
|---|---|---|
| `SUPABASE_URL` | 是 | Supabase 项目地址（须为合法 URL） |
| `SUPABASE_SERVICE_ROLE_KEY` | 是 | 仅供 Worker 使用，禁止进入浏览器 |
| `WORKER_ID` | 是 | 每副本唯一，容器内由 hostname 自动生成 |
| `GIT_AUTH_MODE` | 否 | `local`（默认，复用本机凭据）或 `token`（容器） |
| `GITLAB_BASE_URL` | 否 | 默认 `https://git.kingdee.com`；仅允许可信 HTTP(S) origin，仓库路径仍由白名单固定 |
| `GITLAB_DEPLOY_USER` | token 模式必填 | 只读 Deploy 用户 |
| `GITLAB_DEPLOY_TOKEN` | token 模式必填 | 只读 Deploy Token |
| `WORKSPACE_ROOT` | 否 | 默认 `/workspace/jobs` |
| `CODE_CACHE_ROOT` | 否 | 默认 `/workspace/cache` |
| `POLL_INTERVAL_MS` | 否 | 默认 5000 |
| `STORY_TASK_LEASE_SECONDS` | 否 | 默认 900（15 分钟租约） |
| `HEARTBEAT_INTERVAL_MS` | 否 | 默认 30000，必须小于租约毫秒数 |
| `WORKER_STORY_CONCURRENCY` | 否 | 默认 2，每副本并发槽位 |

模型 Base URL / Model / API Key **不来自环境变量**，而是按批次从 `ai_model_config` +
Supabase Vault 读取（`get_model_secret_for_job`），仅在任务内存中存活。

禁止项（方案 §15.3）：不得使用 `VITE_MODEL_API_KEY`、`VITE_SUPABASE_SERVICE_ROLE_KEY`；
不得把 Git Token 拼进会被日志打印的 URL；不得提交 `.env`；不得在错误中返回 Authorization。
`Dockerfile.worker` 与 `docker-compose.worker.yml` 均不写入任何密钥，Secret 由平台注入。

## 3. GitLab 只读凭据

- 本地 MVP 使用 `GIT_AUTH_MODE=local`，复用当前机器已验证可用的 Git Credential Helper。
- 容器/内网使用 `GIT_AUTH_MODE=token`，配置只读 Deploy Token 或专用只读账号。
- token 模式下凭据通过 `http.extraHeader` 注入（见 `worker/src/git/prepare.ts`），
  不拼进 remote URL，避免出现在日志中。
- 仓库白名单固定为四个（`worker/src/git/repositories.ts`），不接受任意 URL。

## 4. 本地运行（方案 §16）

前置检查：

```bash
node --version && npm --version && git --version && rg --version
git ls-remote --heads https://git.kingdee.com/kwork/manage/kdmanage-backend.git refs/heads/feature_dev
```

对 4 个仓库 × 3 个分支重复分支检查。

启动：

```bash
npm ci
npm run worker:build
# 在安全位置准备 .env（不提交），然后：
npm run worker:start
```

## 5. 容器部署（方案 §17）

构建与启动（本地与内网同一命令）：

```bash
docker compose -f docker-compose.worker.yml up -d --scale worker=4
```

默认拓扑：4 副本 × 每副本 2 槽位 = 并发容量 8。实际并发上限仍由模型
`max_parallel_tasks` 控制。要让 20 条需求全部同时处理，可扩容副本或提高
`WORKER_STORY_CONCURRENCY`；上线前先确认模型供应商的并发数、RPM、TPM 与费用上限，
建议从默认 8 并发开始压测。

安全要求（已在 `Dockerfile.worker` / compose 落地）：

- 以非 root 用户 `worker` 运行；`security_opt: no-new-privileges`。
- 不发布任何端口（出站-only）。
- `restart: unless-stopped`。
- 每副本唯一 `WORKER_ID`（由 hostname 生成）。
- 每副本可使用独立 workspace；同机多个 Worker 也可共享 `WORKSPACE_ROOT`，每次 claim
  通过独立 attempt 叶子隔离，禁止启动时递归清理共享目录。

## 6. Cache 与 Task 工作目录生命周期（方案 §17.3）

```
/workspace/cache/<repository>/<commit-sha>/
  # 完整、可复用的只读 Commit 快照，仅供阶段一检索

/workspace/jobs/<job-id>/tasks/<task-id>/<claim-attempt>/
├── manifest.json
└── code/
    └── <repository>/
        └── <candidate-relative-path>
            # 只物理复制当前需求的候选完整文件
```

`claim-attempt` 由 `retrieval_attempt`、`analysis_attempt` 与 Worker ID 的短哈希组成。
同一 Task 租约过期后可能被另一个 Worker 接管；新旧 Worker 使用不同 attempt 叶子，
不会共享可写目录。这里**不会**创建 `<job-id>/repositories`，也不会将四个完整仓库复制到
Job 目录。

处理边界如下：

1. 阶段一的 `searchCode` / `findFiles` / `readCode` / `gitLog` 只访问完整 cache 快照。
2. 阶段一返回候选后，Worker 拒绝链接和非普通文件，将去重后的候选完整文件物理复制到
   Task attempt 的 `code/`，并记录仓库、Commit SHA、规范化路径、大小和 SHA-256。
3. 阶段二 snippets、模型上下文及最终证据文件行数校验只使用 Task workspace；不能将
   cache 作为阶段二仓库根目录。
4. 当前 claim 完成或失败后，只递归删除自己创建的 attempt；`task/tasks/job` 父目录仅在
   为空时通过非递归删除清理。因此 Worker 空闲或任务完成后 `jobs` 为空是正常现象。

安全与恢复规则：

- cache 按完整 SHA 命名，重试和不同 Task 复用同一只读快照。cache 只能由 Worker 的
  原子发布流程写入并保持只读；不得允许其他同账号进程在任务期间修改快照内容。
- 每个候选文件上限 1 MiB，每个 Task workspace 总上限 12 MiB。
- Worker 启动时不扫描、也不递归删除 UUID Job 目录，避免两个本机 Worker 共享
  `WORKSPACE_ROOT` 时互删正在使用的目录。
- 进程崩溃可能留下 orphan attempt。当前优先保证并发安全，不按 FAILED、租约过期或心跳
  失联自动删除；运维人员确认没有进程仍使用该 attempt 后再人工清理。
- 接管 Worker 从数据库中的 `retrieval_output` 重新物化自己的 workspace，不依赖前一个
  Worker 留下的目录。

## 7. 日志与审计（方案 §18）

结构化 JSON 日志（`worker/src/logger.ts`）至少包含 timestamp、level、worker_id、
job_id、batch_id、story_code、stage、event、duration_ms。所有输出经过脱敏
（`worker/src/security/redaction.ts`）：绝不打印模型 API Key、service role key、
Git Token、Authorization Header、大段源代码。

## 8. 上线运行手册（方案 §23）

每周使用：检查 Worker 在线 → 检查本周模型启用且连接正常 → 导出 Excel → 建批次
选正确分支与模型 → 上传 Excel 核对数量 → 开始 AI 分析 → 检查 4 仓库快照与并发 →
等待成功 → 抽查阶段一候选 → 人工确认 → 完成批次。

任务失败处理：

- 先看错误码，不要先删批次。
- 鉴权错误：更新 Worker Secret 后重启。
- 分支缺失：确认是否选错分支；禁止自动回退。
- 模型限流/超时：按原 SHA 重试。
- Schema/证据校验失败：保留检索记录，修正 Prompt/Harness 后重试。
- 仅在确需最新代码时创建新批次。

Worker 重启：停止领取新任务 → 等当前模型请求结束或记录失败 → 重启容器 →
依据数据库任务与仓库快照恢复 → 确认无重复 `ai_import_record`。

## 9. 错误码与重试（方案 §13.4、§19）

- Git 瞬时错误 / 模型 429、超时、5xx：指数退避重试 2 次。
- JSON Schema 错误：同阶段修复 1 次，仍失败则任务失败。
- 权限、分支不存在、密钥无效：不自动重试。
- 租约每 30 秒续租，初始 15 分钟；租约过期任务由其他 Worker 接管，迟到写入被拒绝
  （`TASK_LEASE_LOST`）。

## 10. 内网连通性验收（方案 §21、§26）

### 10.1 一条命令执行三方验收

最终 Worker 镜像内置 `worker:check-connectivity`。默认执行：

1. 对固定 4 仓库 × `feature_dev / feature_sit / release` 执行 12 次精确
   `git ls-remote`，不克隆代码。
2. 使用 service role 访问 Supabase PostgREST，读取指定启用模型的非敏感元数据，并调用
   `admin_get_model_secret_by_config` 验证 Vault 密钥可用。
3. 对模型 `/chat/completions` 只发送
   `{model, messages:[{role:"user",content:"ping"}], max_tokens:1}`；不发送需求、Prompt 或代码。

在目标内网的安全目录创建权限为 `0600`、不纳入版本库的环境文件：

```dotenv
SUPABASE_URL=<test-or-staging-supabase-url>
SUPABASE_SERVICE_ROLE_KEY=<injected-by-secret-platform>
GIT_AUTH_MODE=token
GITLAB_BASE_URL=https://git.kingdee.com
GITLAB_DEPLOY_USER=<read-only-deploy-user>
GITLAB_DEPLOY_TOKEN=<read-only-deploy-token>
CONNECTIVITY_MODEL_CONFIG_ID=<enabled-openai-compatible-model-uuid>
CONNECTIVITY_TIMEOUT_MS=30000
```

使用与正式 Worker 完全相同的镜像和网络执行：

```bash
chmod 600 /secure/path/worker-connectivity.env
docker run --rm \
  --env-file /secure/path/worker-connectivity.env \
  codereviewplatform-worker:latest \
  npm run worker:check-connectivity
```

成功条件：进程退出码为 `0`，最终 `connectivity_summary.ok=true`、`failed=0`，其中
Git 共 12 项、Supabase/Vault 1 项、模型 1 项。退出码 `1` 表示探针失败，`2` 表示配置缺失或
非法。输出只包含组件、固定目标名、HTTP 状态码、Commit SHA、耗时和安全错误码；不会输出
URL、请求/响应体、API Key、Git Token、service role key 或 Authorization Header。

可在当前机器先只复验 Git 白名单；该模式不要求 Supabase/模型凭据：

```bash
npm run worker:build
CONNECTIVITY_COMPONENTS=git GIT_AUTH_MODE=local npm run worker:check-connectivity
```

`CONNECTIVITY_COMPONENTS` 可取 `git,supabase,model` 的子集；选择 `model` 时会自动加入
Supabase/Vault 前置检查。正式验收必须使用默认三项，不能以局部检查替代。

### 10.2 验收后人工确认

- [ ] 默认三项自动验收退出码为 0，并保存不含密钥的 JSONL 输出作为部署证据。
- [ ] Supabase Vault 已启用；正式 SQL 回归已证明 `vault.decrypted_secrets` 对
  `anon/authenticated` 撤权，相关 RPC 仅授权 `service_role`。
- [ ] service role key 只存在于 Worker/容器 Secret 平台，未进入前端、镜像或普通表。
- [ ] 用 `docker compose -f docker-compose.worker.yml up -d --scale worker=4` 启动 4 副本，
  确认每个副本上报 2 个槽位和唯一 `WORKER_ID`。
- [ ] 已在模型供应商控制台轮换旧需求文件中出现过的模型 API Key。
