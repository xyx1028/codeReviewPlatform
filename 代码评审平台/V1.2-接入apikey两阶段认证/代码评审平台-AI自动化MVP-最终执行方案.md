# 代码评审平台 AI 自动化 MVP 最终执行方案

> 版本：V1.1  
> 日期：2026-09-09  
> 实施对象：`/Users/kingdee/codeReviewPlatform`  
> 部署形态：Vercel 前端 + Supabase + 本地/公司内网 Worker  
> 本文定位：作为本轮 MVP 的执行基线；此前 DevOps 自动取数方案仅作为后续参考。

## 1. 最终决策

本轮 MVP 不开发 DevOps 自动连接器。需求来源保留现有人工流程：

```text
DevOps 按 Scrum 团队、发布窗口筛选
        ↓
人工导出 Excel
        ↓
上传到代码评审平台
```

上传需求以后，自动完成以下流程：

```text
读取批次选择的代码分支
        ↓
拉取 kwork/manage 下 4 个仓库的同名分支
        ↓
锁定每个仓库实际分析的 Commit SHA
        ↓
将本批次每条需求拆成可并发领取的任务
        ↓
多个 Worker 并发处理不同需求
        ↓
AI 阶段一：检索与当前需求相关的代码
        ↓
冻结检索结果
        ↓
AI 阶段二：根据当前需求和检索结果完成一致性分析
        ↓
写入现有 AI 结果、代码证据表
        ↓
人工复核
```

本轮只有两个 AI 阶段：

1. AI 检索代码。
2. AI 分析需求与代码。

拉取代码、校验分支、记录 Commit、校验模型输出属于基础设施步骤，不增加新的 AI 阶段。

本期同时纳入：

- 多 Worker 需求级并发；20 条需求可以被多个 Worker 同时处理。
- 模型管理界面；可以配置多个模型及各自 API Key。
- 创建批次时选择本批次使用的模型。
- 批次保存模型快照，后续修改模型配置不改变已开始任务的审计信息。

## 2. 已确认的事实

### 2.1 现有平台能力

当前工程已经具备：

- React + Vite + TypeScript 前端。
- Vercel 部署配置。
- Supabase Auth、PostgreSQL、Storage 和 RLS。
- 创建评审批次。
- 创建批次时选择 `feature_dev`、`feature_sit` 或 `release`。
- DevOps Excel 上传、预览、校验和需求入库。
- AI Excel 模板下载及人工导入。
- `ai_import_record`、`ai_review_result`、`ai_code_evidence` 数据结构。
- AI 结果与批次分支一致性校验。
- 人工复核、统计看板和批次完成/重新打开。

当前尚未实现：

- 后台分析 Worker。
- GitLab 自动拉取。
- AI 阶段一代码检索。
- AI 阶段二自动分析。
- 自动分析任务状态界面。
- 自动结果写入 RPC。
- 多 Worker 需求级并发。
- 模型配置、密钥安全存储和批次模型选择。
- DeepSeek Harness 接入。

### 2.2 GitLab 结构

`https://git.kingdee.com/kwork/manage` 是 GitLab 项目组，不是一个可直接克隆的单仓库。当前包含：

| 逻辑名称 | 仓库地址 |
|---|---|
| kdmanage-backend | `https://git.kingdee.com/kwork/manage/kdmanage-backend.git` |
| kdmanage-frontend | `https://git.kingdee.com/kwork/manage/kdmanage-frontend.git` |
| tmanage-backend | `https://git.kingdee.com/kwork/manage/tmanage-backend.git` |
| tmanage-frontend | `https://git.kingdee.com/kwork/manage/tmanage-frontend.git` |

2026-09-09 已在当前电脑验证：

- 4 个仓库均可访问。
- `feature_dev`、`feature_sit`、`release` 在 4 个仓库中均存在。
- 4 个仓库的 `feature_dev` 均已成功浅克隆。
- 克隆后 Commit SHA 与远端分支 HEAD 一致。
- 4 个浅克隆合计约 86 MB。

上述 SHA 和大小只是验证快照，程序不得写死。

### 2.3 网络边界

- 当前使用者默认连接公司 VPN。
- 本地 Worker 可以访问 GitLab，已经验证。
- 正式 Worker 将部署在公司内网。
- 因此 GitLab 网络可达性不再视为主要方案风险，但必须保留为部署验收项。
- Vercel 只承载前端，不负责长期 Git 工作区和 AI 长任务。

## 3. MVP 范围

### 3.1 本轮必须完成

- 保留 DevOps Excel 手工导入。
- 在 AI 结果页面增加“开始 AI 分析”。
- 通过 Supabase 创建分析任务。
- 提供模型管理界面，可以新增、编辑、启用和停用模型配置。
- 每个模型配置可以使用不同 API Key，密钥加密保存且不返回前端。
- 创建批次时必须选择一个已启用模型。
- Worker 从 Supabase 领取任务。
- Worker 根据批次分支准备 4 个仓库。
- 对每个仓库记录完整 Commit SHA。
- 将批次需求拆为需求级任务。
- 多个 Worker 使用数据库行锁并发领取不同需求。
- 每条需求执行 AI 检索阶段。
- 冻结每条需求的检索结果。
- 每条需求执行 AI 分析阶段。
- 严格校验结构化结果。
- 自动写入现有 AI 结果和代码证据表。
- 前端显示任务进度、失败原因和最终结果。
- 支持失败后按原 Commit 快照重试。
- Worker 支持本地运行和 Docker 容器运行。
- Worker 支持水平扩容和任务租约回收。
- 支持模型级最大并发限制，避免不同 API Key 被打爆。
- 为后续 DeepSeek Harness 保留统一接口。

### 3.2 本轮明确不做

- DevOps 自动登录、自动查询或浏览器扩展。
- 自动修改代码。
- 自动提交、推送或创建 Merge Request。
- 向量数据库、Embedding 或长期代码索引。
- 多 AI 角色讨论或投票。
- 根据需求内容自动选择模型；本期由用户在创建批次时明确选择。
- 复杂工作流平台。
- 跨批次的复杂优先级调度；本期优先保证单批次内需求并发。
- 将完整仓库一次性发送给模型。
- 用 Vercel Function 执行完整代码分析任务。

### 3.3 后续版本

- DeepSeek Harness。
- 增量索引和缓存。
- DevOps 自动取数。
- 分析历史多版本对比。

## 4. 总体架构

```text
┌─────────────────────────────────────────────────────────┐
│ Vercel                                                   │
│ React 前端                                               │
│ - 创建批次                                               │
│ - 管理模型并为批次选择模型                               │
│ - 上传 DevOps Excel                                      │
│ - 发起 AI 分析                                           │
│ - 展示进度、结果、人工复核                               │
└──────────────────────┬──────────────────────────────────┘
                       │ Supabase SDK
                       ▼
┌─────────────────────────────────────────────────────────┐
│ Supabase                                                 │
│ - 用户和权限                                             │
│ - 批次与需求                                             │
│ - analysis_job                                           │
│ - 仓库快照                                               │
│ - 模型元数据与 Vault 密钥引用                            │
│ - 第一阶段检索记录                                       │
│ - 现有 AI 结果与代码证据                                 │
└──────────────────────┬──────────────────────────────────┘
                       │ Worker 主动轮询，无需公网入站端口
                       ▼
┌─────────────────────────────────────────────────────────┐
│ 本地/公司内网 Worker Pool                                │
│ - Git 分支校验与代码准备                                 │
│ - 多 Worker 并发领取需求任务                             │
│ - AI 检索工具                                            │
│ - AI Harness                                             │
│ - 结果校验与持久化                                       │
└───────────────┬──────────────────────────┬──────────────┘
                │                          │
                ▼                          ▼
       git.kingdee.com               模型 API
```

采用 Worker Pool 主动轮询 Supabase 的原因：

- 公司内网 Worker 不需要对公网开放 HTTP 端口。
- Vercel 不需要直接访问公司内网。
- Worker 只需要出站访问 Supabase、GitLab 和获批模型 API。
- Worker 暂停时任务仍保存在数据库，租约到期后可由其他 Worker 继续领取。
- 多个 Worker 通过 `FOR UPDATE SKIP LOCKED` 领取不同需求，不会重复分析。

推荐的 MVP 并发拓扑：

```text
一个批次：20 条需求
        ↓
analysis_story_task：20 条待处理任务
        ↓
Worker-1 ─┬─ 需求 1：检索 → 分析
Worker-2 ─┼─ 需求 2：检索 → 分析
Worker-3 ─┼─ 需求 3：检索 → 分析
Worker-4 ─┴─ 需求 4：检索 → 分析
        ↓
完成后继续领取剩余需求，直到 20 条全部完成
```

本地和内网默认统一部署 4 个 Worker 容器、每个容器 2 个并发槽位，总执行容量为 8 条需求。模型额度允许时，可继续提升 Worker 数量或每个 Worker 的槽位；最大实际并发仍由模型配置控制，而不是写死在前端。

## 5. 用户操作流程

### 5.1 正常流程

1. 值班人员连接公司 VPN。
2. 在 DevOps 中按 Scrum 团队和发布窗口筛选。
3. 导出 Excel。
4. 在平台创建代码评审批次。
5. 选择默认代码基线分支。
6. 选择本批次使用的模型。
7. 上传并确认 DevOps Excel。
8. 进入“AI 结果管理”。
9. 点击“开始 AI 分析”。
10. 页面显示代码准备、并发任务、AI 检索、AI 分析进度。
11. 成功后进入评审列表进行人工确认。

### 5.2 启动分析前置条件

只有同时满足以下条件时按钮才可用：

- 当前用户有管理该批次的权限。
- 批次未完成。
- 批次已选择受支持分支。
- 批次已选择一个当前可用的模型配置。
- 所选模型已经安全配置 API Key。
- 已导入至少一条需求。
- 当前不存在运行中的分析任务。
- 当前批次尚未产生 AI 结果。

## 6. 分支和 Commit 一致性

### 6.1 唯一分支来源

Worker 不接受浏览器额外传入的分支名。唯一可信来源是：

```text
review_batch.default_branch
```

创建任务时，数据库 RPC 将该值复制到：

```text
analysis_job.requested_branch
```

任务创建以后禁止修改批次分支。

### 6.2 仓库准备算法

对 4 个仓库逐一执行：

1. 使用固定仓库白名单取得 URL。
2. 查询 `refs/heads/{requested_branch}`。
3. 分支不存在时立即失败。
4. 取得远端完整 HEAD SHA。
5. 以浅历史方式获取该分支。
6. 校验本地 `FETCH_HEAD` 与刚解析的 SHA 一致。
7. 将 SHA 写入 `analysis_repository_snapshot`。
8. 后续所有检索只允许访问该快照目录。

禁止行为：

- 不允许回退到仓库默认分支。
- 不允许使用模糊匹配分支名。
- 不允许模型决定分支。
- 不允许模型改写 Commit SHA。
- 不允许多个仓库使用不同的分支名。

### 6.3 推荐 Git 命令逻辑

以下为逻辑示例，实际代码必须使用 `spawn(command, args)`，不能拼接 Shell 字符串：

```bash
git ls-remote --exit-code --heads <repo-url> refs/heads/<branch>

git init <workspace>/<repo-name>
git -C <workspace>/<repo-name> remote add origin <repo-url>
git -C <workspace>/<repo-name> fetch --depth 1 origin refs/heads/<branch>
git -C <workspace>/<repo-name> checkout --detach FETCH_HEAD
git -C <workspace>/<repo-name> rev-parse HEAD
```

若 `ls-remote` 与 `fetch` 之间分支发生移动，以实际成功获取的 `FETCH_HEAD` 为本次快照，并再次查询确认该 Commit 来自目标分支；无法确认则失败，不继续分析。

### 6.4 基线记录格式

写入现有 `ai_import_record.baseline_commit`：

```json
{
  "actual_branch": "feature_dev",
  "commits": [
    { "repository": "kdmanage-backend", "sha": "<full-sha>", "subject": "<subject>" },
    { "repository": "kdmanage-frontend", "sha": "<full-sha>", "subject": "<subject>" },
    { "repository": "tmanage-backend", "sha": "<full-sha>", "subject": "<subject>" },
    { "repository": "tmanage-frontend", "sha": "<full-sha>", "subject": "<subject>" }
  ]
}
```

### 6.5 批次模型快照

创建批次时保存模型配置 ID；开始分析时再冻结不含密钥的模型快照：

```json
{
  "model_config_id": "<uuid>",
  "display_name": "Qwen 主账号",
  "provider": "openai-compatible",
  "base_url": "<model-base-url>",
  "model_name": "<model-name>",
  "retrieval_prompt_version": "retrieval-v1",
  "analysis_prompt_version": "analysis-v1"
}
```

快照不得包含 API Key、Vault secret ID 或 Authorization Header。任务开始后，即使管理员编辑模型展示名称、地址或默认参数，本次任务仍使用任务快照；密钥轮换只改变认证材料，不改变模型审计信息。

## 7. 数据库改造

新增迁移建议命名：

```text
supabase/migrations/0010_ai_automation_mvp.sql
```

### 7.1 ai_model_config

```sql
create extension if not exists supabase_vault with schema vault;

create table public.ai_model_config (
  id uuid primary key default gen_random_uuid(),
  display_name text not null,
  provider text not null,
  base_url text not null,
  model_name text not null,
  api_key_secret_id uuid not null unique,
  enabled boolean not null default true,
  max_parallel_tasks integer not null default 4
    check (max_parallel_tasks between 1 and 20),
  request_timeout_ms integer not null default 180000
    check (request_timeout_ms between 10000 and 600000),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

允许多个配置使用相同 `provider + base_url + model_name`，因为用户可能为同一模型配置不同账号和 API Key；使用 `display_name` 区分，例如“Qwen 主账号”和“Qwen 备用账号”。

`api_key_secret_id` 只保存 Supabase Vault 中密钥的 UUID，不保存明文。普通前端查询结果不得返回该字段。

### 7.2 review_batch 模型字段

```sql
alter table public.review_batch
  add column ai_model_config_id uuid references public.ai_model_config(id),
  add column ai_model_snapshot jsonb;
```

- 新批次创建时必须选择 `enabled = true` 的模型。
- 历史批次允许暂时为空，在开始分析前补选一次。
- 一旦存在活动分析任务或 AI 结果，禁止修改批次模型。
- `ai_model_snapshot` 在创建分析任务时由数据库生成，不接受浏览器任意 JSON。

### 7.3 analysis_job

```sql
create table public.analysis_job (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.review_batch(id) on delete cascade,
  model_config_id uuid not null references public.ai_model_config(id),
  model_snapshot jsonb not null,
  requested_branch text not null
    check (requested_branch in ('feature_dev', 'feature_sit', 'release')),
  status text not null default 'QUEUED'
    check (status in (
      'QUEUED', 'PREPARING_CODE', 'PROCESSING', 'FINALIZING',
      'SUCCEEDED', 'FAILED'
    )),
  requested_by uuid not null references auth.users(id),
  worker_id text,
  attempt integer not null default 0 check (attempt >= 0),
  total_stories integer not null default 0,
  retrieved_stories integer not null default 0,
  analyzed_stories integer not null default 0,
  error_code text,
  error_message text,
  locked_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index uq_analysis_job_active_batch
on public.analysis_job(batch_id)
where status in ('QUEUED', 'PREPARING_CODE', 'PROCESSING', 'FINALIZING');

create index idx_analysis_job_status_created
on public.analysis_job(status, created_at);
```

### 7.4 analysis_repository_snapshot

```sql
create table public.analysis_repository_snapshot (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.analysis_job(id) on delete cascade,
  repository_name text not null,
  requested_branch text not null,
  commit_sha text not null,
  commit_subject text,
  prepared_at timestamptz not null default now(),
  unique (job_id, repository_name),
  check (repository_name in (
    'kdmanage-backend', 'kdmanage-frontend',
    'tmanage-backend', 'tmanage-frontend'
  )),
  check (requested_branch in ('feature_dev', 'feature_sit', 'release')),
  check (commit_sha ~ '^[0-9A-Fa-f]{40}([0-9A-Fa-f]{24})?$')
);
```

不要保存容器绝对路径。路径仅在当前 Worker 实例中有意义，任务重启时可以根据快照重新准备。

### 7.5 analysis_story_task

```sql
create table public.analysis_story_task (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.analysis_job(id) on delete cascade,
  story_id uuid not null references public.review_story(id) on delete cascade,
  retrieval_status text not null default 'PENDING'
    check (retrieval_status in ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED')),
  analysis_status text not null default 'PENDING'
    check (analysis_status in ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED')),
  worker_id text,
  lease_expires_at timestamptz,
  heartbeat_at timestamptz,
  retrieval_model text,
  analysis_model text,
  retrieval_prompt_version text,
  analysis_prompt_version text,
  retrieval_output jsonb,
  analysis_output jsonb,
  retrieval_attempt integer not null default 0,
  analysis_attempt integer not null default 0,
  error_code text,
  error_message text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (job_id, story_id)
);

create index idx_analysis_story_task_job
on public.analysis_story_task(job_id, retrieval_status, analysis_status);
```

`retrieval_output` 只保存搜索条件、文件路径、行号、选择原因和内容哈希；默认不把完整源代码片段长期保存到 Supabase。

### 7.6 必须新增的 RPC

| RPC | 调用者 | 职责 |
|---|---|---|
| `admin_list_model_configs()` | ADMIN | 返回无密钥的模型配置列表和“是否已配置密钥” |
| `admin_upsert_model_config(...)` | ADMIN Edge Function | 创建/更新模型元数据和 Vault 密钥引用 |
| `admin_set_model_enabled(id, enabled)` | ADMIN | 启用或停用模型，不删除历史引用 |
| `set_batch_model(batch_id, model_config_id)` | 批次管理者 | 为未开始任务的批次选择已启用模型 |
| `enqueue_analysis_job(batch_id)` | 登录用户 | 校验权限和前置条件，复制批次分支，建立任务和 story task |
| `claim_job_for_preparation(worker_id)` | service role | 领取一个 QUEUED 批次并准备统一仓库快照 |
| `save_repository_snapshots(job_id, snapshots)` | service role | 原子保存 4 个仓库快照 |
| `claim_next_story_task(worker_id, lease_seconds)` | service role | 多 Worker 使用行锁领取一条需求任务 |
| `heartbeat_story_task(task_id, worker_id)` | service role | 延长租约，避免长模型请求被重复领取 |
| `save_retrieval_result(task_id, result)` | service role | 保存阶段一结果及进度 |
| `save_analysis_result(task_id, result)` | service role | 保存阶段二待汇总结果 |
| `get_model_secret_for_job(job_id)` | service role | 从 Vault 返回本任务密钥，仅供 Worker 内存使用 |
| `complete_analysis_job(job_id, model, results, evidence)` | service role | 校验并原子写入现有 AI 结果表 |
| `fail_analysis_job(job_id, code, message)` | service role | 记录失败状态和可展示错误 |
| `retry_analysis_job(job_id)` | 批次管理者 | 只允许 FAILED 任务按原快照重试 |

`claim_job_for_preparation` 和 `claim_next_story_task` 必须使用：

```sql
for update skip locked
```

多个 Worker 同时调用时，每条需求也只能被一个 Worker 领取。

需求任务采用租约而不是永久锁定：

- Worker 领取时设置 `worker_id` 和 `lease_expires_at`。
- 运行中每 30 秒更新 `heartbeat_at` 并延长租约。
- Worker 崩溃且租约到期后，其他 Worker 可以重新领取。
- 原 Worker 恢复后写结果时，必须再次校验自己仍持有租约。
- 重复或过期 Worker 的写入必须被数据库拒绝。

### 7.7 complete_analysis_job 写入规则

该 RPC 必须在一个数据库事务中：

1. 锁定 `analysis_job`。
2. 校验任务处于 `FINALIZING`，且所有需求任务均已成功完成两个 AI 阶段。
3. 校验批次未完成且没有既有 AI 导入记录。
4. 校验任务分支等于 `review_batch.default_branch`。
5. 校验 4 个仓库快照齐全。
6. 校验每条需求都有分析结果。
7. 创建 `ai_import_record`，`import_file_id` 设为 `null`。
8. 写入 `ai_review_result`。
9. 写入 `ai_code_evidence`。
10. 将该 AI 版本设为当前生效版本。
11. 将 `review_batch.status` 更新为 `REVIEWING`。
12. 将 `analysis_job.status` 更新为 `SUCCEEDED`。

任何一步失败都必须整体回滚，不能出现半批次结果。

最终汇总必须由数据库锁保证只能执行一次；任意 Worker 都可以尝试触发，只有第一个获得任务行锁的 Worker真正执行。

### 7.8 Vault 与权限

- 普通登录用户只可查看其有权查看的任务。
- 只有管理员或批次创建者可以创建、重试任务。
- 只有 ADMIN 能管理模型和提交 API Key。
- 模型列表对有创建批次权限的用户可读，但只返回无密钥字段。
- API Key 使用 Supabase Vault 加密存储。
- `vault.decrypted_secrets` 必须撤销 `anon` 和 `authenticated` 访问权限。
- API Key 的创建、轮换和读取只能通过受限函数或服务端函数完成。
- `claim/save/complete/fail` RPC 只授权 `service_role`。
- 浏览器不得持有 `SUPABASE_SERVICE_ROLE_KEY`。
- Worker 不应复用普通用户的 Supabase Token。

## 8. Worker 工程结构

建议直接放入现有仓库，独立构建和运行：

```text
codeReviewPlatform/
├── src/                         # 现有前端
├── worker/
│   └── src/
│       ├── index.ts             # 轮询入口
│       ├── config.ts            # 环境变量校验
│       ├── db/
│       │   ├── client.ts
│       │   ├── jobs.ts
│       │   └── models.ts
│       ├── git/
│       │   ├── repositories.ts  # 固定仓库白名单
│       │   ├── prepare.ts
│       │   └── verify.ts
│       ├── tools/
│       │   ├── search-code.ts
│       │   ├── find-files.ts
│       │   ├── read-code.ts
│       │   └── git-log.ts
│       ├── ai/
│       │   ├── harness.ts
│       │   ├── openai-compatible.ts
│       │   ├── schemas.ts
│       │   └── prompts/
│       │       ├── retrieval-v1.ts
│       │       └── analysis-v1.ts
│       ├── pipeline/
│       │   ├── prepare-job.ts
│       │   ├── process-story-task.ts
│       │   ├── finalize-job.ts
│       │   ├── retrieve-story.ts
│       │   └── analyze-story.ts
│       ├── coordination/
│       │   ├── lease.ts
│       │   └── heartbeat.ts
│       └── security/
│           ├── path-policy.ts
│           └── redaction.ts
├── tsconfig.worker.json
├── supabase/functions/
│   └── admin-model-config/      # 管理模型密钥，短请求
├── Dockerfile.worker
└── docker-compose.worker.yml
```

### 8.1 仓库白名单

MVP 不提供由用户输入任意 Git URL 的能力：

```ts
export const REPOSITORIES = [
  {
    name: 'kdmanage-backend',
    url: 'https://git.kingdee.com/kwork/manage/kdmanage-backend.git',
  },
  {
    name: 'kdmanage-frontend',
    url: 'https://git.kingdee.com/kwork/manage/kdmanage-frontend.git',
  },
  {
    name: 'tmanage-backend',
    url: 'https://git.kingdee.com/kwork/manage/tmanage-backend.git',
  },
  {
    name: 'tmanage-frontend',
    url: 'https://git.kingdee.com/kwork/manage/tmanage-frontend.git',
  },
] as const
```

## 9. 模型管理和批次选择

### 9.1 模型管理界面

仅 ADMIN 可进入“模型管理”，界面包含：

```text
模型名称          供用户识别，例如“Qwen 主账号”
Provider          openai-compatible / 后续 deepseek-harness
Base URL          模型兼容接口地址
Model             实际模型名称
API Key           密码输入框；编辑时不回显原值
最大并发需求数    1～20
请求超时          10～600 秒
是否启用          已停用模型不能用于新批次
```

列表只展示：

- 展示名称、Provider、Base URL、模型名称。
- “API Key 已配置/未配置”，不展示原文和尾号。
- 最大并发、启用状态、创建人和更新时间。
- 已被历史批次引用的模型只允许停用，不允许物理删除。

### 9.2 API Key 写入流程

```text
ADMIN 在模型管理界面输入 API Key
        ↓ HTTPS + 当前用户 JWT
Supabase Edge Function：admin-model-config
        ↓ 再次校验 ADMIN 身份
调用 vault.create_secret() 或安全轮换函数
        ↓
ai_model_config 只保存 secret UUID
        ↓
响应前端时移除 API Key 和 secret UUID
```

Edge Function 必须：

- 禁止打印请求体。
- 禁止打印上游 Authorization Header。
- 创建成功后立即清空局部明文引用。
- 更新模型但 API Key 留空时保留原密钥。
- 输入新 API Key 时先创建新 secret、更新引用，成功后再清理旧 secret。
- 提供“测试连接”，只发送最小测试请求，不携带代码或需求。

Supabase Vault 将秘密以认证加密形式保存在数据库中；能访问 `vault.decrypted_secrets` 的角色仍可读取明文，因此权限收敛是强制要求。

### 9.3 批次选择模型

创建代码评审弹窗增加必选项：

```text
批次名称                 必填
周标识                   必填
默认代码基线分支         必填
本批次分析模型           必填，只显示已启用且已配置 Key 的模型
备注                     可选
```

批次列表增加“分析模型”列。历史批次如果没有模型，在第一次启动分析前允许补选一次。

任务入队时由数据库生成模型快照。任务创建后：

- 不允许修改该批次模型。
- 管理员停用模型不终止已经开始的任务。
- API Key 被轮换后，未完成任务使用新密钥继续访问同一模型配置。
- 如必须切换模型重新比较结果，应创建新批次；MVP 不在同一批次产生多模型版本。

为了保证历史可追溯：

- 尚未被任何批次引用的配置可以修改 Provider、Base URL 和 Model。
- 已被批次引用后，Provider、Base URL 和 Model 视为不可变；需要变更时复制成新配置。
- 已被引用的配置仍允许轮换 API Key、修改并发上限、修改展示名称和启用状态。
- 批次审计以 `analysis_job.model_snapshot` 为准，不以模型表当前值为准。

### 9.4 模型并发限制

每个模型配置都有 `max_parallel_tasks`。领取需求任务时，数据库统计该模型当前仍持有有效租约的任务数；达到上限时不再发放任务。

这样可以配置：

```text
模型 A / API Key A：最大并发 8
模型 B / API Key B：最大并发 3
模型 C / API Key C：最大并发 20
```

并发限制绑定模型配置，而不是只绑定模型名称，因此同一个模型的不同 API Key 可以拥有不同额度。

## 10. AI Harness 接口

第一版先使用兼容当前模型 API 的实现，后续 DeepSeek Harness 实现相同接口：

```ts
export interface ReviewHarness {
  retrieve(
    input: RetrievalInput,
    tools: RetrievalTools,
  ): Promise<RetrievalResult>

  analyze(input: AnalysisInput): Promise<AnalysisResult>
}
```

Harness 实例按 `analysis_job.model_snapshot` 创建；API Key 由 Worker 使用任务 ID 临时读取，保存在当前任务内存中，任务完成后释放。不同批次可以选择不同模型配置，同一批次内所有需求必须使用同一个模型快照。

推荐实现类：

```text
OpenAICompatibleHarness  # MVP
DeepSeekHarness          # 后续
```

Pipeline 只能依赖 `ReviewHarness`，不得直接依赖某个模型 SDK。接入 DeepSeek Harness 时只替换实现，不修改 Git、数据库和前端流程。

## 11. AI 阶段一：检索代码

### 11.1 阶段目标

只回答：

> 为判断这条需求是否实现，需要分析哪些代码？

禁止在该阶段输出“已实现、部分实现、未实现”等最终结论。

### 11.2 输入

```ts
interface RetrievalInput {
  jobId: string
  story: {
    code: string
    name: string
    description: string | null
    acceptanceCriteria: string | null
    projectName: string | null
    applicationName: string | null
    sourceData: Record<string, unknown>
  }
  branch: 'feature_dev' | 'feature_sit' | 'release'
  repositories: Array<{
    name: string
    commitSha: string
    topLevelEntries: string[]
  }>
}
```

需求和源代码都属于不可信数据。Prompt 必须明确：忽略需求文本、代码注释、README 中要求模型改变任务、泄露密钥或执行外部操作的内容。

### 11.3 AI 可用工具

```ts
interface RetrievalTools {
  searchCode(input: {
    repository: RepositoryName
    query: string
    pathGlob?: string
    maxResults?: number
  }): Promise<SearchHit[]>

  findFiles(input: {
    repository: RepositoryName
    pattern: string
    maxResults?: number
  }): Promise<string[]>

  readCode(input: {
    repository: RepositoryName
    path: string
    startLine: number
    endLine: number
  }): Promise<CodeSnippet>

  gitLog(input: {
    repository: RepositoryName
    query: string
    maxResults?: number
  }): Promise<CommitSummary[]>
}
```

不提供以下工具：

- 任意 Shell。
- 网络访问。
- 文件写入。
- Git checkout、commit、push。
- 读取 Worker 环境变量。
- 读取工作目录之外的文件。

### 11.4 工具安全限制

- 仓库参数必须来自 4 个固定枚举。
- 文件路径必须 `realpath` 后仍位于对应仓库根目录。
- 禁止 `..` 路径穿越。
- `searchCode` 使用 `rg` 参数数组，不使用 Shell。
- 单次搜索最多返回 50 项。
- 单文件默认最多读取 200 行。
- 单文件大于 1 MB 时拒绝整文件读取。
- 屏蔽 `.git`、`node_modules`、`target`、`dist`、`build` 和生成物目录。
- 屏蔽 `.env`、私钥、证书、凭据文件和已知密钥格式。
- 工具返回值需要截断，并记录是否发生截断。

### 11.5 检索策略

AI 应优先执行：

1. 在 4 个仓库 Git 日志中搜索完整需求编号。
2. 在代码中搜索完整需求编号。
3. 从名称、描述和验收标准提取领域词、接口名、字段名。
4. 判断更可能属于管理端还是租户端、前端还是后端。
5. 查找接口入口、Service、Mapper、前端调用和测试。
6. 沿调用链补充必要文件。
7. 形成候选代码清单并结束阶段一。

### 11.6 阶段一输出

```ts
interface RetrievalResult {
  storyCode: string
  summary: string
  queries: Array<{
    repository: RepositoryName
    query: string
    hitCount: number
  }>
  searchedRepositories: RepositoryName[]
  candidates: Array<{
    repository: RepositoryName
    filePath: string
    startLine: number
    endLine: number
    symbolName?: string
    reason: string
  }>
  insufficientEvidence: boolean
}
```

初始限制建议：

- 每条需求最多 12 次检索工具调用。
- 最多保留 12 个候选代码片段。
- 单片段最多 200 行。
- 合计发送到第二阶段的代码不超过约 60,000 字符。
- 无结果也必须记录搜索过的仓库和关键词。

## 12. AI 阶段二：需求与代码分析

### 12.1 阶段目标

只使用阶段一冻结的候选代码进行判断：

> 当前批次指定分支的代码是否满足需求和验收标准？

阶段二不再调用代码搜索工具。证据不足时输出 `UNCERTAIN`，不能猜测。

### 12.2 输入

```ts
interface AnalysisInput {
  story: RetrievalInput['story']
  branch: string
  repositorySnapshots: Array<{
    name: RepositoryName
    commitSha: string
  }>
  retrieval: RetrievalResult
  snippets: Array<{
    repository: RepositoryName
    commitSha: string
    filePath: string
    startLine: number
    endLine: number
    content: string
  }>
}
```

### 12.3 输出

```ts
interface AnalysisResult {
  storyCode: string
  verdict: 'IMPLEMENTED' | 'PARTIAL' | 'NOT_IMPLEMENTED' | 'UNCERTAIN'
  confidence: number
  summary: string
  implementedContent: string | null
  missingContent: string | null
  risks: string | null
  testPoints: string | null
  aiRemark: string | null
  evidence: Array<{
    repository: RepositoryName
    filePath: string
    symbolName?: string
    startLine: number
    endLine: number
    evidenceType: '现有实现' | '缺失依据' | '风险依据'
    description: string
  }>
}
```

### 12.4 输出硬校验

- `storyCode` 必须与当前需求一致。
- `verdict` 必须属于固定枚举。
- `confidence` 必须是 0～100 整数。
- `IMPLEMENTED` 和 `PARTIAL` 至少需要一条“现有实现”证据。
- 每条证据必须来自阶段一候选文件。
- 行号必须位于实际文件范围内。
- 文件必须存在于本次 Commit 快照。
- Commit SHA 由 Worker 根据仓库快照补入，不信任模型填写值。
- 没有找到代码不能直接判定 `NOT_IMPLEMENTED`，默认应为 `UNCERTAIN`。
- JSON Schema 校验失败允许在同一阶段修复一次；仍失败则任务失败。

## 13. 任务执行策略

### 13.1 MVP 并发

- Worker 是可水平扩容的无状态副本。
- 本地和内网默认启动 4 个 Worker 容器，每个容器同时处理 2 条需求。
- 一个批次的 20 条需求拆成 20 条 `analysis_story_task`。
- 多个 Worker 通过数据库行锁领取不同需求。
- 每个 Worker 对领取的单条需求连续完成“阶段一检索 → 阶段二分析”。
- 一个 Worker完成一条需求后继续领取下一条，直到批次全部完成。
- 实际并发上限取以下最小值：模型配置 `max_parallel_tasks`、在线 Worker 容量、当前待处理需求数。
- MVP 优先保证一个批次内并发；多个批次同时排队时按任务创建时间处理。

示例：20 条需求、4 个 Worker、每个 2 个槽位、模型最大并发 8，则同时处理 8 条；如果模型最大并发设置为 4，实际只同时处理 4 条。

### 13.2 代码快照在多 Worker 中的使用

代码快照只解析一次，Commit SHA 对全批次统一。每个 Worker 在本机缓存目录中检查对应 SHA：

```text
/workspace/cache/<repository>/<commit-sha>/
```

- 同一 Worker 处理多条需求时复用缓存，不重复拉取。
- 不同容器副本可以各自缓存同一 SHA；4 仓库浅克隆实测约 86 MB，MVP 可接受。
- 如果多个 Worker 共享一个磁盘，必须使用文件锁准备缓存，完成后以原子重命名发布只读目录。
- Worker 不得从另一个任务的可写工作区读取代码。
- 缓存只按完整 SHA 命名，不能只按分支名命名。

### 13.3 原子性

阶段一中间结果允许逐条保存，便于失败续跑。正式 AI 结果只在全部需求完成后一次性写入现有结果表。

因此：

- Worker 崩溃后，可以复用已完成的检索结果。
- 不会让用户看到半批次正式结论。
- 某条需求证据不足但成功输出 `UNCERTAIN`，不视为技术失败。

### 13.4 租约、重试与最终汇总

- Git 网络瞬时错误：指数退避重试 2 次。
- 模型 429、超时或 5xx：指数退避重试 2 次。
- JSON Schema 错误：同阶段修复 1 次。
- 权限、分支不存在、密钥无效：不自动重试。
- 用户点击“重试”必须复用原 `analysis_repository_snapshot` 中的 SHA。
- 如果用户希望使用最新代码，必须创建新批次，不能静默更新旧任务快照。
- Worker 每 30 秒续租；建议初始租约 15 分钟。
- 租约过期的任务可被其他 Worker 领取，原 Worker 的迟到结果会被拒绝。
- 最后一条需求完成后，任一 Worker 可尝试将任务切换到 `FINALIZING`。
- 最终汇总使用数据库行锁和唯一约束，确保只生成一个正式 AI 版本。
- 某条需求重试耗尽后，将该 story task 标记为 `FAILED`，同时停止发放该批次尚未领取的新任务。
- 已经持有租约的 Worker 在进入下一 AI 阶段前重新检查 job 状态；批次已失败则停止并释放租约。
- 人工重试只重置失败和未完成需求，已经成功的两阶段结果继续复用。

## 14. 前端改造

### 14.1 AI 结果管理页

保留现有人工 AI Excel 导入作为兜底，但主入口调整为：

```text
┌─────────────────────────────────────────────┐
│ 自动 AI 分析                                │
│ 分支：feature_dev                           │
│ 需求：36 条                                 │
│ 模型：Qwen 主账号 / <model-name>            │
│ 最大并发：8                                 │
│                                             │
│ [开始 AI 分析]                              │
└─────────────────────────────────────────────┘
```

运行中显示：

```text
代码准备        已完成（4/4 仓库）
并发 Worker      4 个在线 / 4 个处理中
AI 检索         12/20
AI 分析         9/20
处理中需求      PRJ-001、PRJ-002、PRJ-003、PRJ-004
已运行          00:18:32
```

失败时显示：

- 可理解的错误说明。
- 失败步骤。
- 是否可重试。
- “按原 Commit 重试”按钮。
- 不展示 Token、完整模型响应或包含敏感信息的命令行。

### 14.2 前端 API

在 `src/lib/api.ts` 增加：

```ts
enqueueAnalysisJob(batchId: string)
getLatestAnalysisJob(batchId: string)
listRepositorySnapshots(jobId: string)
listAnalysisStoryTasks(jobId: string)
retryAnalysisJob(jobId: string)
listEnabledModelConfigs()
adminListModelConfigs()
adminCreateModelConfig(input)
adminUpdateModelConfig(id, input)
adminSetModelEnabled(id, enabled)
setBatchModel(batchId, modelConfigId)
```

前端只使用无密钥类型：

```ts
interface AiModelConfigSummary {
  id: string
  display_name: string
  provider: string
  base_url: string
  model_name: string
  enabled: boolean
  has_api_key: boolean
  max_parallel_tasks: number
  request_timeout_ms: number
  created_at: string
  updated_at: string
}

interface CreateBatchInput {
  name: string
  week_code: string
  default_branch: 'feature_dev' | 'feature_sit' | 'release'
  ai_model_config_id: string
  remark?: string | null
}
```

ADMIN 左侧导航新增“模型管理”。模型表单的 API Key 字段使用密码框，编辑页面始终为空；留空表示不轮换，绝不把旧值加载到浏览器。

使用 React Query 每 3～5 秒刷新运行中任务。MVP 不要求 WebSocket。

### 14.3 与现有页面兼容

- 自动完成后仍写入现有 `ai_import_record`。
- `import_file_id` 为 `null`，现有下载按钮保持禁用即可。
- 现有评审列表和详情页继续读取当前生效 AI 版本。
- 自动结果成功后，批次状态仍变为 `REVIEWING`。
- 当前“一个批次只能导入一次 AI 结果”的规则继续保留。
- `ai_import_record.ai_model` 写入模型快照中的 Provider、Model 和配置展示名称，不写 API Key。
- 一个批次只选择一个模型；20 条并发需求都使用同一个模型快照。

## 15. 配置与密钥

### 15.1 Worker 环境变量

```dotenv
SUPABASE_URL=<supabase-url>
SUPABASE_SERVICE_ROLE_KEY=<service-role-key>

GIT_AUTH_MODE=local
GITLAB_BASE_URL=https://git.kingdee.com
GITLAB_DEPLOY_USER=<deploy-user>
GITLAB_DEPLOY_TOKEN=<deploy-token>

WORKER_ID=<unique-worker-id>
WORKSPACE_ROOT=/workspace/jobs
CODE_CACHE_ROOT=/workspace/cache
POLL_INTERVAL_MS=5000
STORY_TASK_LEASE_SECONDS=900
HEARTBEAT_INTERVAL_MS=30000
WORKER_STORY_CONCURRENCY=2
```

模型 Base URL、Model、超时和 API Key 改为按批次从 `ai_model_config + Vault` 读取，不再使用一组全局 `MODEL_*` 环境变量。

本地 MVP 可使用 `GIT_AUTH_MODE=local`，复用当前电脑已经验证可用的 Git Credential Helper。容器部署使用只读 Deploy Token 或专用只读账号。

### 15.2 安全前置

现有旧需求说明文件中出现过明文模型 API Key。实施前必须：

1. 在模型供应商控制台废弃或轮换旧 Key。
2. 使用新 Key 配置 Worker Secret。
3. 检查 Git 历史、Vercel 环境变量和构建日志中是否存在旧 Key。
4. 不在本文、代码、数据库普通表或聊天记录中再次复制真实 Key。

### 15.3 禁止项

- 不得使用 `VITE_MODEL_API_KEY`。
- 不得使用 `VITE_SUPABASE_SERVICE_ROLE_KEY`。
- 不得将 Git Token 拼进会被日志打印的 URL。
- 不得把 `.env` 提交 Git。
- 不得在错误信息中返回模型请求 Authorization Header。
- 不得将完整源代码永久保存在 Supabase。

Supabase Vault 官方说明：Secret 在数据库磁盘中以认证加密方式保存，但 `vault.decrypted_secrets` 能按权限解密读取，因此必须严格撤销普通角色访问：[Supabase Vault](https://supabase.com/docs/guides/database/vault)。模型配置管理属于短请求，可使用 Edge Function；代码拉取和多轮 AI 分析仍由内网 Worker 执行：[Supabase Edge Functions](https://supabase.com/docs/guides/functions)。

## 16. 本地运行

### 16.1 前置检查

```bash
node --version
npm --version
git --version
rg --version
git ls-remote --heads \
  https://git.kingdee.com/kwork/manage/kdmanage-backend.git \
  refs/heads/feature_dev
```

对 4 个仓库和 3 个分支执行相同检查。

### 16.2 推荐 npm 脚本

```json
{
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "worker:dev": "tsx worker/src/index.ts",
    "worker:build": "tsc -p tsconfig.worker.json",
    "worker:start": "node dist-worker/index.js",
    "test:worker": "vitest run worker"
  }
}
```

### 16.3 启动顺序

1. 应用 `0010_ai_automation_mvp.sql`。
2. 在本地安全位置配置 Worker `.env`。
3. 启动前端。
4. 使用 Docker Compose 启动 4 个 Worker 容器，每个容器 2 个并发槽位。
5. 创建测试批次并选择 `feature_dev`。
6. 导入少量脱敏测试需求。
7. 点击“开始 AI 分析”。
8. 检查仓库快照、阶段进度和最终结果。

## 17. 容器部署

### 17.1 Dockerfile 参考

```dockerfile
FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ripgrep ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.worker.json ./
COPY worker ./worker
RUN npm run worker:build

ENV NODE_ENV=production
ENV WORKSPACE_ROOT=/workspace/jobs

CMD ["npm", "run", "worker:start"]
```

### 17.2 部署要求

- 容器运行在公司内网。
- 容器能够访问 `git.kingdee.com`。
- 容器能够出站访问 Supabase 和模型 API。
- Secret 由容器平台注入，不写入镜像。
- `/workspace/jobs` 只允许 Worker 用户访问。
- 容器使用非 root 用户运行。
- 禁止特权模式。
- `restart: unless-stopped` 或等价重启策略。
- MVP 不对公网暴露端口。
- 本地和内网默认运行 4 个 Worker 容器，每个容器设置 `WORKER_STORY_CONCURRENCY=2`，总容量为 8；根据所选模型的 API 额度调整。
- 每个副本必须有唯一 `WORKER_ID`；建议由容器名或 Pod 名自动生成。

Docker Compose 示例：

```bash
docker compose -f docker-compose.worker.yml up -d --scale worker=4
```

上述命令同时用于本地 MVP 和内网部署。默认每个容器 2 个槽位，因此总执行容量为 8。如果需要让 20 条需求全部同时处理，可扩容 Worker 或提高 `WORKER_STORY_CONCURRENCY`。上线前必须先确认模型供应商的并发数、RPM、TPM 和费用上限；推荐先从默认 8 并发压测，不直接默认 20 并发。

### 17.3 工作目录生命周期

```text
/workspace/jobs/<job-id>/
├── kdmanage-backend/
├── kdmanage-frontend/
├── tmanage-backend/
└── tmanage-frontend/
```

- 成功或最终失败后清理目录。
- Worker 重启时扫描遗留目录。
- 只有目录名能够解析为数据库任务 UUID 时才允许清理。
- 禁止针对 `/workspace` 或环境变量未解析的路径执行递归删除。
- 如任务重启，依据数据库中的 Commit SHA 重新获取代码。

## 18. 日志与审计

每条日志至少包含：

```text
timestamp
level
worker_id
job_id
batch_id
story_code（处理需求时）
stage
event
duration_ms
```

不得记录：

- 模型 API Key。
- Supabase service role key。
- Git Token。
- Authorization Header。
- 完整 Prompt 中的大段源代码。
- Excel 中无关的个人信息。

关键审计信息必须入库：

- 任务请求人和时间。
- 批次分支。
- 4 个仓库 Commit SHA。
- 检索和分析模型名称。
- 两阶段 Prompt 版本。
- 每条需求检索到的文件和行号。
- 每条需求最终结论和证据。
- 错误码、重试次数和完成时间。

## 19. 错误码

| 错误码 | 含义 | 是否可自动重试 |
|---|---|---:|
| `GIT_AUTH_FAILED` | GitLab 鉴权失败 | 否 |
| `GIT_BRANCH_MISSING` | 某仓库缺少所选分支 | 否 |
| `GIT_FETCH_FAILED` | Git 获取失败 | 是，2 次 |
| `GIT_SHA_MISMATCH` | 分支快照校验失败 | 是，重新解析一次 |
| `MODEL_AUTH_FAILED` | 模型 Key 无效 | 否 |
| `MODEL_CONFIG_DISABLED` | 入队前所选模型已停用 | 否 |
| `MODEL_SECRET_MISSING` | Vault 中找不到对应 API Key | 否 |
| `MODEL_RATE_LIMITED` | 模型限流 | 是 |
| `MODEL_TIMEOUT` | 模型超时 | 是 |
| `RETRIEVAL_SCHEMA_INVALID` | 阶段一输出格式错误 | 修复 1 次 |
| `ANALYSIS_SCHEMA_INVALID` | 阶段二输出格式错误 | 修复 1 次 |
| `EVIDENCE_PATH_INVALID` | 证据路径越界或不存在 | 否 |
| `EVIDENCE_LINE_INVALID` | 证据行号无效 | 否 |
| `BATCH_BRANCH_CHANGED` | 批次分支与任务不一致 | 否 |
| `RESULT_ALREADY_EXISTS` | 批次已有 AI 结果 | 否 |
| `TASK_LEASE_LOST` | Worker 已失去需求任务租约 | 由其他 Worker 接管 |
| `JOB_INTERNAL_ERROR` | 未分类内部错误 | 人工判断 |

## 20. 测试计划

### 20.1 单元测试

- 分支枚举校验。
- 仓库白名单校验。
- 路径穿越拦截。
- 搜索结果截断。
- 阶段一 JSON Schema。
- 阶段二 JSON Schema。
- 证据文件和行号校验。
- Commit SHA 格式校验。
- 日志脱敏。
- Harness 适配器契约测试。
- 模型配置输入校验和密钥字段脱敏。
- 模型级最大并发计算。
- 租约领取、续租、过期和迟到写入拒绝。

### 20.2 集成测试

- 4 个仓库、3 个分支远端检查。
- 4 个仓库按同一分支获取并记录 SHA。
- 4 个 Worker 容器、每个 2 个槽位同时领取 20 条需求，任何需求不被重复领取。
- 当模型最大并发不少于 8 时，应能观察到最多 8 条需求同时持有有效租约。
- 模型最大并发为 4 时，即使启动 20 个 Worker，也只有 4 条需求获得有效租约。
- Worker 重启或崩溃后，租约到期任务由其他 Worker 接管。
- 模型 A、模型 B 使用不同 Vault Secret，批次只能读取自己选择模型的密钥。
- 模型配置被修改后，已开始任务的无密钥快照保持不变。
- 模型 429、超时、无效 JSON 的重试。
- 自动结果成功写入现有结果表。
- 自动结果能被现有评审列表读取。
- 批次完成后不能再发起任务。
- 已有人工 AI 导入结果时不能再自动分析。

### 20.3 安全测试

- 前端构建产物中不存在模型 Key、Git Token 和 service role key。
- 普通用户无法读取 `api_key_secret_id` 和 `vault.decrypted_secrets`。
- 管理界面编辑模型时不回显旧 API Key。
- 输入 `../../` 无法读取仓库外文件。
- 模型无法调用任意 Shell。
- 代码注释中的提示注入不会改变任务目标。
- 日志不会输出 Authorization Header。
- `.env`、私钥和证书不会进入模型上下文。

### 20.4 端到端测试

使用一个小批次，包含：

- 一条明确已实现需求。
- 一条部分实现需求。
- 一条证据不足需求。
- 一条会命中前后端多个仓库的需求。

核验：

1. 前端显示的分支等于创建批次时选择的分支。
2. 4 个仓库快照分支一致。
3. 阶段一不输出最终结论。
4. 阶段二没有搜索仓库。
5. 每条证据能在对应 SHA 的文件和行号中复现。
6. `UNCERTAIN` 不被错误显示为 `NOT_IMPLEMENTED`。
7. 最终结果能够完成人工复核。

另使用一个包含 20 条需求的并发批次，核验：

1. 本地启动 4 个 Worker 容器，每个容器配置 2 个并发槽位。
2. 当模型最大并发不少于 8 时，最多 8 条需求同时处于处理状态。
3. 每条需求只由一个有效租约持有者写入。
4. 同一批次全部使用相同模型快照、分支和 4 个仓库 SHA。
5. 个别 Worker 崩溃后，其他 Worker 能接管且不产生重复结果。
6. 全部需求完成前不写入正式 AI 版本。

## 21. MVP 验收标准

满足以下全部条件才算完成：

- [ ] DevOps Excel 继续可以正常导入。
- [ ] 创建批次时的分支成为 Worker 唯一分支来源。
- [ ] ADMIN 可以创建多个模型配置，并为每个配置输入不同 API Key。
- [ ] API Key 已进入 Vault，模型列表和浏览器网络响应均不返回密钥。
- [ ] 创建批次时必须选择已启用模型。
- [ ] 分析任务保存不含密钥的模型快照。
- [ ] 4 个仓库都按该分支成功准备。
- [ ] 任一仓库缺分支时任务失败且不回退。
- [ ] 4 个完整 Commit SHA 已入库。
- [ ] 每条需求都有阶段一检索记录。
- [ ] 本地与内网均可启动 4 个 Worker 容器 × 每个 2 个槽位。
- [ ] 20 条需求可以按最多 8 条一组并发领取和处理。
- [ ] 模型级最大并发限制真实生效。
- [ ] Worker 崩溃后的租约任务可以安全接管。
- [ ] 阶段一只产生候选代码，不产生实现结论。
- [ ] 阶段二只使用冻结代码上下文。
- [ ] 阶段二产生固定枚举、置信度和结构化证据。
- [ ] 证据文件、行号和 Commit 全部通过程序校验。
- [ ] 全批次结果通过一个事务写入。
- [ ] 前端能展示进度、失败和结果。
- [ ] Worker 重启不会生成重复正式结果。
- [ ] 模型 Key、Git Token、service role key 不出现在前端和数据库普通表。
- [ ] 本地 Worker 端到端通过。
- [ ] 内网容器完成 GitLab、Supabase、模型 API 连通性验收。
- [ ] 人工复核流程继续可用。

## 22. 实施顺序

### 阶段 A：数据库与任务入口，2～3 人日

- [ ] 新增 `0010_ai_automation_mvp.sql`。
- [ ] 新增模型配置表和 3 张任务相关表。
- [ ] 启用并收敛 Supabase Vault 权限。
- [ ] 实现模型管理 Edge Function。
- [ ] 实现 enqueue、准备任务 claim、需求任务 claim、lease、save、complete、fail、retry RPC。
- [ ] 增加 RLS 和 service role 权限。
- [ ] 增加批次分支锁定规则。
- [ ] 前端增加任务 API 类型。

完成标志：管理员能安全配置两个不同 API Key 的模型；前端能创建任务；多个模拟 Worker 能并发领取不同需求。

### 阶段 B：Git 代码准备，1～2 人日

- [ ] 建立 4 仓库白名单。
- [ ] 实现分支存在性检查。
- [ ] 实现浅获取和 SHA 校验。
- [ ] 保存仓库快照。
- [ ] 实现安全工作目录和清理。
- [ ] 验证 3 个分支。

完成标志：任一批次都能得到 4 个可复现的代码快照。

### 阶段 C：AI 检索，2～3 人日

- [ ] 定义 `ReviewHarness`。
- [ ] 实现安全只读代码工具。
- [ ] 编写 retrieval-v1 Prompt。
- [ ] 实现阶段一输出 Schema。
- [ ] 实现调用次数和上下文限制。
- [ ] 保存检索记录。
- [ ] 支持需求任务租约和心跳。
- [ ] 支持模型级并发限制。

完成标志：每条需求得到可解释的候选文件与行号，不输出最终结论。

### 阶段 D：AI 分析与入库，2～3 人日

- [ ] 编写 analysis-v1 Prompt。
- [ ] 实现阶段二输出 Schema。
- [ ] 实现证据路径、行号、Commit 校验。
- [ ] 实现 `complete_analysis_job`。
- [ ] 复用现有结果与人工复核页面。

完成标志：测试批次自动产生可复核的正式 AI 结果。

### 阶段 E：模型管理、并发前端与容器，3～4 人日

- [ ] 增加模型管理页面、连接测试和启用/停用。
- [ ] 创建批次增加模型必选项。
- [ ] AI 结果页增加“开始 AI 分析”。
- [ ] 展示仓库、在线 Worker、并发数和逐需求进度。
- [ ] 展示错误和按原 SHA 重试。
- [ ] 增加 Worker Dockerfile。
- [ ] 使用 4 个 Worker 容器 × 每个 2 个槽位完成 20 条需求并发测试。
- [ ] 完成本地和内网环境验收。

完成标志：值班人员不再下载 AI 模板、复制 Prompt、手工拉代码或手工上传 AI 结果。

### 总体工作量

单人 MVP 预计约 12～16 个工作日。增加的工作量主要来自模型密钥安全管理、需求级分布式租约、多 Worker 并发和并发状态展示；最大质量不确定项仍是模型在实际需求上的检索准确率。

## 23. 上线运行手册

### 23.1 每周使用

1. 检查 Worker 在线。
2. 检查本周计划使用的模型为启用状态且连接测试正常。
3. 在 DevOps 导出当周 Excel。
4. 创建批次，选择正确分支和模型。
5. 上传 Excel 并检查需求数量。
6. 点击“开始 AI 分析”。
7. 查看 4 个仓库快照和并发 Worker 是否正常。
8. 等待任务成功。
9. 抽查阶段一候选文件。
10. 进入评审列表进行人工确认。
11. 完成批次。

### 23.2 任务失败

1. 查看错误码，不先删除批次。
2. 鉴权错误：更新 Worker Secret 后重启 Worker。
3. 分支缺失：确认是否选错分支；禁止自动回退。
4. 模型限流或超时：按原 SHA 重试。
5. Schema 或证据校验失败：保留检索记录，修正 Prompt/Harness 后重试。
6. 只有确实需要最新代码时才创建新批次。

### 23.3 Worker 重启

1. 停止领取新任务。
2. 等待当前模型请求结束或记录失败。
3. 重启容器。
4. Worker 根据数据库任务和仓库快照恢复。
5. 确认没有重复 `ai_import_record`。

## 24. DeepSeek Harness 后续接入

DeepSeek Harness 只需要实现：

```ts
class DeepSeekHarness implements ReviewHarness {
  retrieve(input, tools) {
    // 调用本地 DeepSeek Harness 执行检索阶段
  }

  analyze(input) {
    // 调用本地 DeepSeek Harness 执行分析阶段
  }
}
```

必须继续遵守：

- 阶段一不能产生最终结论。
- 阶段二不能访问阶段一之外的代码。
- 输出必须通过同一 JSON Schema。
- 工具必须由 Worker 提供，Harness 不获得任意系统权限。
- 数据库仍保存模型、Prompt 版本、分支和 Commit。

如果 DeepSeek Harness 本身需要读取整个工作区，应单独评估其权限边界，不可默认赋予容器宿主机目录访问权。

## 25. 最终交付物清单

```text
数据库
├── 0010_ai_automation_mvp.sql
├── Vault 密钥管理
└── 并发 RPC、租约与 RLS 验证脚本

Worker
├── Git 代码准备
├── 两阶段 ReviewHarness
├── 多 Worker 需求队列、租约与心跳
├── 4 个只读代码工具
├── JSON Schema 校验
├── 结果入库
├── 日志与重试
├── 单元/集成测试
└── Dockerfile

前端
├── 模型管理界面
├── 批次模型选择
├── 开始 AI 分析按钮
├── 任务进度
├── 仓库快照
├── 错误与重试
└── 复用现有评审结果页面

运维
├── Worker Secret 清单
├── GitLab 只读凭据
├── 内网连通性检查
└── 上线与故障处理手册
```

## 26. 开工前最终检查

- [ ] 轮换旧需求文件中出现过的模型 API Key。
- [ ] 确认模型服务允许发送公司源代码片段。
- [ ] 确认内网 Worker 可以访问 Supabase 和模型 API。
- [ ] 申请容器使用的 GitLab 只读凭据。
- [ ] 明确第一批允许用户选择的模型配置。
- [ ] 确认首批模型配置及各自允许的最大并发数。
- [ ] 确认 Supabase Vault 已启用且权限验证通过。
- [ ] 确认 4 个仓库全部纳入分析范围。
- [ ] 确认 `feature_dev / feature_sit / release` 仍是唯一允许分支。
- [ ] 对当前 `src/App.tsx`、`src/App.css` 的未提交修改做好保留，实施时不得覆盖。

## 27. 最终结论

该 MVP 可以执行，且关键技术链路已经具备足够可信度：

- DevOps Excel 继续手工导入，规避 DevOps 登录和内部接口风险。
- 本地 GitLab 连通性、4 仓库和 3 分支已验证。
- 当前数据库已有批次分支、AI 结果和代码证据结构。
- 新增 Worker 后即可实现分支锁定、代码准备和自动模型调用。
- 多 Worker 可以对同一批次的不同需求并发执行，20 条需求无需串行等待。
- 模型管理和批次模型选择纳入本期，多个模型配置可以绑定不同加密 API Key。
- 两阶段 AI 边界清晰：先检索代码，再分析需求与冻结代码上下文。
- 后续 DeepSeek Harness 可通过统一接口替换，不需要重写业务流程。

按本文的 A → E 阶段依次实施，可以先在本机完成端到端 MVP，再将同一个 Worker 镜像部署到公司内网。
