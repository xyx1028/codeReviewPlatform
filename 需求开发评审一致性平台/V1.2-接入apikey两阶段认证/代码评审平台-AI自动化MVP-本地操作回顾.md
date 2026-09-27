# 代码评审平台 AI 自动化 MVP：本地操作回顾

> 适用项目：`/Users/kingdee/codeReviewPlatform`  
> 适用环境：macOS、本机前端、本机单 Worker、Supabase 云项目  
> 整理日期：2026-09-09  
> 用途：记录本次从配置到验证的完整过程，供以后按步骤复现。  
>
> **安全提醒：本文不记录任何真实 API Key、Supabase Secret 或 GitLab Token。所有 `<...>` 都必须替换为自己的值，且不要把真实 Key 发到聊天、提交到 Git 或写入前端环境变量。**

---

## 1. 先理解系统由什么组成

本项目的 AI 自动化功能由四部分组成：

```text
前端 src/
  → 用户创建批次、配置模型、点击“开始 AI 分析”、查看结果

Supabase 数据库 + Vault
  → 保存批次、任务、仓库快照、模型配置和分析结果
  → Vault 保存模型 API Key

admin-model-config Edge Function
  → 模型管理后端接口
  → 验证 ADMIN 身份
  → 安全写入/轮换 Vault 中的模型 Key
  → 执行模型最小连接测试

Worker（worker/）
  → 从 Supabase 领取任务
  → 获取四个 GitLab 仓库指定 Commit
  → 执行阶段一代码检索
  → 执行阶段二 AI 分析
  → 将结果写回 Supabase
```

### `worker/`、`Dockerfile.worker`、`docker-compose.worker.yml` 的区别

```text
worker/                     Worker 的实际业务代码
Dockerfile.worker           如何把 Worker 代码制作成 Docker 镜像
docker-compose.worker.yml   如何启动和管理一个或多个 Worker 容器
```

第一次本机验证直接运行单 Worker，不需要 Docker Compose。等单 Worker 跑通后，再验证 4 个容器并发。

---

## 2. 本次实际使用的环境

- 项目目录：`/Users/kingdee/codeReviewPlatform`
- 前端地址：`http://localhost:5173`
- Supabase 类型：云项目（不是本机 `supabase start`）
- Supabase Project Ref：`vbwstwwlhxkkcmqdulev`
- GitLab：复用当前 Mac 已有的 Git Credential Helper
- Worker：本机直接运行，ID 为 `local-worker-1`
- 模型接口类型：`openai-compatible`
- 模型 Base URL：`https://dashscope.aliyuncs.com/compatible-mode/v1`
- 模型名：`qwen3.6-flash`
- 第一次验证最大并发：`1`

### 已验证过的代码门禁

```text
前端构建：成功，1723 modules transformed
Worker 构建：成功
Worker 测试：16 个文件、132 项全部通过
Oxlint：通过
GitLab 分支连通性：4 仓库 × 3 分支，12/12 通过
Worker Docker 镜像：构建成功
```

---

## 3. Secret 应该放在哪里

### 3.1 前端 `.env.local`

路径：

```text
/Users/kingdee/codeReviewPlatform/.env.local
```

只允许：

```dotenv
VITE_SUPABASE_URL=<Supabase URL>
VITE_SUPABASE_ANON_KEY=<Supabase Publishable/Anon Key>
```

前端禁止放：

```text
SUPABASE_SERVICE_ROLE_KEY
模型 API Key
GitLab Token
```

### 3.2 Worker 安全配置

路径：

```text
/Users/kingdee/.config/code-review-platform/worker.env
```

它在项目目录之外，不提交 Git。

### 3.3 模型 API Key

模型 API Key 只在前端 ADMIN 的“模型管理”页面填写，经过 `admin-model-config` 写入 Supabase Vault。

如果 Key 曾经被粘贴到聊天、日志或文档，应立即在模型供应商控制台吊销并创建新 Key，不要继续使用旧 Key。

---

## 4. 安装和连接 Supabase CLI

### 4.1 安装 CLI

```bash
brew install supabase/tap/supabase
```

检查版本：

```bash
supabase --version
```

本次安装版本：

```text
2.117.0
```

如果 Homebrew 已安装但终端提示找不到 `supabase`：

```bash
eval "$(/opt/homebrew/bin/brew shellenv)"
supabase --version
```

### 4.2 登录 Supabase

```bash
supabase login
```

按提示打开浏览器并完成登录。不要把登录链接、验证码或 Access Token 发给别人。

成功标志：

```text
You are now logged in. Happy coding!
```

### 4.3 关联云项目

```bash
cd /Users/kingdee/codeReviewPlatform
supabase link --project-ref vbwstwwlhxkkcmqdulev
```

`vbwstwwlhxkkcmqdulev` 来自：

```text
https://vbwstwwlhxkkcmqdulev.supabase.co
        └────────┬─────────┘
             Project Ref
```

它不是密码。成功标志：

```text
Finished supabase link.
```

---

## 5. 执行数据库迁移 `0010`

之前的 `0001～0009` 是在 Supabase SQL Editor 手工执行，因此 `0010` 也继续手工执行，避免 CLI 因缺少历史记录而重复推送旧迁移。

> 不要直接运行 `supabase db push`，除非已经确认远程迁移历史完整。

### 5.1 复制 SQL 到剪贴板

```bash
pbcopy < /Users/kingdee/codeReviewPlatform/supabase/migrations/0010_ai_automation_mvp.sql
```

这条命令只复制，不执行 SQL。

### 5.2 在 Supabase 执行

1. 打开 Supabase Dashboard。
2. 进入当前项目。
3. 打开 **SQL Editor**。
4. 新建查询。
5. 按 `Command + V` 粘贴。
6. 点击 **Run**。

### 5.3 验证表已创建

```sql
select
  to_regclass('public.ai_model_config') as ai_model_config,
  to_regclass('public.analysis_job') as analysis_job,
  to_regclass('public.analysis_story_task') as analysis_story_task,
  to_regclass('public.analysis_repository_snapshot') as repository_snapshot;
```

四项都应返回表名，而不是 `null`。

---

## 6. 部署模型管理 Edge Function

### 6.1 它是什么

本地代码：

```text
supabase/functions/admin-model-config/index.ts
```

它不是 SQL，而是运行在 Supabase 云端的 TypeScript 后端函数，负责：

- 检查登录用户是否为 ADMIN；
- 新增和修改模型配置；
- 将模型 Key 写入 Vault；
- 轮换旧模型 Key；
- 发送最小 `ping` 测试模型连接。

### 6.2 部署函数

```bash
cd /Users/kingdee/codeReviewPlatform
supabase functions deploy admin-model-config
```

固定命令格式：

```text
supabase functions deploy <函数目录名称>
```

本次成功输出：

```text
Deployed Functions on project vbwstwwlhxkkcmqdulev: admin-model-config
```

检查函数：

```bash
supabase functions list
```

应能看到：

```text
admin-model-config
```

### 6.3 设置本机前端访问白名单

```bash
supabase secrets set ALLOWED_ORIGINS='http://localhost:5173,http://127.0.0.1:5173'
```

`ALLOWED_ORIGINS` 不是模型密钥，它只是允许调用 Edge Function 的浏览器地址列表。

检查变量名称：

```bash
supabase secrets list
```

Supabase 托管环境会自动向函数提供 `SUPABASE_URL`、`SUPABASE_ANON_KEY` 和 `SUPABASE_SERVICE_ROLE_KEY`，不需要把它们写进函数源码。

---

## 7. 创建本机 Worker 配置

### 7.1 创建目录和文件

```bash
mkdir -p /Users/kingdee/.config/code-review-platform
chmod 700 /Users/kingdee/.config/code-review-platform

touch /Users/kingdee/.config/code-review-platform/worker.env
chmod 600 /Users/kingdee/.config/code-review-platform/worker.env

nano /Users/kingdee/.config/code-review-platform/worker.env
```

### 7.2 本机单 Worker 最小配置

```dotenv
SUPABASE_URL=<当前 Supabase URL>
SUPABASE_SERVICE_ROLE_KEY=<当前 Supabase 的服务端 Secret/Service Role Key>
WORKER_ID=local-worker-1
WORKSPACE_ROOT=/Users/kingdee/.cache/code-review-platform/jobs
CODE_CACHE_ROOT=/Users/kingdee/.cache/code-review-platform/cache
```

说明：

- `SUPABASE_URL`：Worker 连接哪个 Supabase。
- `SUPABASE_SERVICE_ROLE_KEY`：Worker 使用的高权限服务端凭据，不能给浏览器。
- `WORKER_ID`：Worker 唯一标识。
- `WORKSPACE_ROOT`：本机任务临时工作目录。
- `CODE_CACHE_ROOT`：四个 Git 仓库的本机代码缓存目录。

模型 API Key 不放进这个文件。

保存 `nano`：

```text
Ctrl + O
回车
Ctrl + X
```

### 7.3 创建本机工作目录

```bash
mkdir -p /Users/kingdee/.cache/code-review-platform/jobs
mkdir -p /Users/kingdee/.cache/code-review-platform/cache
chmod -R 700 /Users/kingdee/.cache/code-review-platform
```

确认配置文件权限：

```bash
chmod 600 /Users/kingdee/.config/code-review-platform/worker.env
ls -l /Users/kingdee/.config/code-review-platform/worker.env
```

预期类似：

```text
-rw-------
```

---

## 8. 启动前端

打开终端 A：

```bash
cd /Users/kingdee/codeReviewPlatform
npm run dev
```

浏览器打开：

```text
http://localhost:5173
```

终端会持续运行，这是正常现象。停止时按 `Ctrl + C`。

---

## 9. 在 ADMIN 页面配置模型

1. 使用 ADMIN 用户登录。
2. 打开左侧“模型管理”。
3. 点击“新增模型”。
4. 填写：

```text
模型名称：通义千问测试模型
Provider：openai-compatible
Base URL：https://dashscope.aliyuncs.com/compatible-mode/v1
Model：qwen3.6-flash
API Key：填写新创建、未泄露的 Key
最大并发：1
请求超时：180 秒
启用：是
```

为什么 Provider 选 `openai-compatible`：DashScope 的该地址提供 OpenAI 兼容接口；`alibaba-cn` 是其他系统中的供应商标签，不是本项目当前支持的 Provider 值。

5. 保存。
6. 点击“测试连接”。
7. 看到“连接测试通过”。
8. 确认 API Key 显示“已配置”、模型处于启用状态。

本次截图已确认模型连接测试通过。

---

## 10. 编译和启动 Worker

### 10.1 什么时候需要编译

修改过 `worker/` 代码后执行：

```bash
cd /Users/kingdee/codeReviewPlatform
npm run worker:build
```

它将：

```text
worker/src/*.ts
```

编译到：

```text
dist-worker/
```

没有修改 Worker 代码时，不需要每次重复编译。

### 10.2 启动 Worker

打开终端 B：

```bash
cd /Users/kingdee/codeReviewPlatform

set -a
source /Users/kingdee/.config/code-review-platform/worker.env
set +a

npm run worker:start
```


# 终端 1
cd /Users/kingdee/codeReviewPlatform

set -a && source ~/.config/code-review-platform/worker.env && set +a && npm run worker:start

# 终端 2
cd /Users/kingdee/codeReviewPlatform

set -a && source ~/.config/code-review-platform/worker.env && set +a && WORKER_ID=local-worker-2 npm run worker:start


解释：

- `set -a`：后续读取的配置自动导出为环境变量。
- `source ...worker.env`：加载 Worker 配置。
- `set +a`：结束自动导出。
- `npm run worker:start`：运行 `dist-worker/index.js`。

成功标志：

```json
{"level":"info","worker_id":"local-worker-1","event":"worker_started"}
```

Worker 会持续轮询任务，所以终端一直不退出是正常现象。停止时按 `Ctrl + C`。

---

## 11. 创建小批次并验证

第一次只使用 1～3 条需求，不要直接使用 20 条，便于排错并控制模型费用。

1. 进入“代码评审”。
2. 点击“创建代码评审”。
3. 填写批次名称。
4. 选择允许分支：`feature_dev`、`feature_sit` 或 `release`。
5. 选择已配置的模型。
6. 上传测试 Excel。
7. 进入“AI结果管理”。

### 11.1 开始前检查

页面前置条件应全部为绿色：

```text
有管理该批次的权限
批次未完成
已选择受支持分支
已选择可用模型（启用且已配置密钥）
已导入至少一条需求
当前没有运行中的分析任务
当前批次尚未产生 AI 结果
```

状态说明：

```text
最大并发 1 · 活跃 0
```

表示同一时间最多处理 1 条需求，目前没有需求占用模型。

```text
Worker 在线 1 · 处理中 0
```

表示 Worker 已在线，但还没有领取任务。

准备完成后点击：

```text
开始 AI 分析
```

### 11.2 正常流程

```text
准备 4 个仓库快照
→ 阶段一 AI 检索
→ 冻结候选代码片段
→ 阶段二 AI 分析
→ 校验证据路径、行号和 Commit
→ 保存结果
→ 批次进入 REVIEWING
```

本机小规模成功条件：

- 4/4 仓库准备成功；
- AI 检索全部完成；
- AI 分析全部完成；
- 页面有 verdict、confidence 和代码证据；
- 批次进入 `REVIEWING`；
- 可以继续人工复核。

---

## 12. 本次遇到的错误及处理

### 12.1 `ENOENT`：`/workspace/cache` 不存在

错误示例：

```text
ENOENT: no such file or directory, mkdir '/workspace/cache/...'
```

原因：

- `/workspace/...` 是 Docker 容器中的默认目录；
- 本次 Worker 直接运行在 macOS；
- 本机没有该路径。

修复：在 `worker.env` 添加：

```dotenv
WORKSPACE_ROOT=/Users/kingdee/.cache/code-review-platform/jobs
CODE_CACHE_ROOT=/Users/kingdee/.cache/code-review-platform/cache
```

并创建目录：

```bash
mkdir -p /Users/kingdee/.cache/code-review-platform/jobs
mkdir -p /Users/kingdee/.cache/code-review-platform/cache
chmod -R 700 /Users/kingdee/.cache/code-review-platform
```

然后重启 Worker，再点击“按原 Commit 重试”。

### 12.2 `GIT_FETCH_FAILED`

含义：Worker 已进入 Git 阶段，但获取代码快照失败。

先检查本机 GitLab 连接：

```bash
cd /Users/kingdee/codeReviewPlatform

CONNECTIVITY_COMPONENTS=git \
GIT_AUTH_MODE=local \
npm run worker:check-connectivity
```

成功结果：

```json
{
  "event": "connectivity_summary",
  "ok": true,
  "total": 12,
  "passed": 12,
  "failed": 0
}
```

本次最终重试后四个仓库均准备成功，说明 Git 获取链路已恢复。

### 12.3 `EVIDENCE_PATH_INVALID`

本次实际错误：阶段二模型返回了一个不属于阶段一候选文件的证据路径。

含义：

```text
阶段一只给模型一批冻结材料
→ 阶段二引用了未提供的文件
→ 系统认为证据可能是模型推断或编造
→ 拒绝保存结果
```

这不是 Supabase、模型 Key、GitLab 或 Worker 配置错误，而是 Worker 阶段二证据约束和自动纠错不完整。

#### 已完成的代码修复

修改文件：

```text
worker/src/ai/schemas.ts
worker/src/ai/prompts/analysis-v1.ts
worker/src/ai/openai-compatible-harness.ts
worker/src/pipeline/analyze-story.ts
```

修复内容：

- 阶段二提示词加入实际冻结代码的证据白名单；
- 模型必须逐字复制 repository 和 filePath；
- evidence 行号必须落在实际提供的代码范围；
- 没有足够证据时要求返回 `UNCERTAIN` 和空 evidence；
- 证据路径或行号错误时允许模型自动修正一次；
- 第二次仍错误才失败，并保留准确错误码；
- 统一 `./src/A.java` 与 `src/A.java` 路径格式；
- 保存前仍保留仓库、文件、行号、Commit 最终安全校验。

修复后验证：

```text
Worker TypeScript 构建成功
16 个测试文件通过
132 项测试全部通过
Oxlint 通过
git diff --check 通过
```

#### 应用修复后的重试步骤

当前运行中的旧 Worker 不会自动加载新代码，必须重启。

1. 在 Worker 终端按：

```text
Ctrl + C
```

2. 重新启动：

```bash
cd /Users/kingdee/codeReviewPlatform

set -a
source /Users/kingdee/.config/code-review-platform/worker.env
set +a

npm run worker:start
```

3. 页面显示 `Worker 在线 1` 后点击：

```text
按原 Commit 重试
```

本次重试会复用已有的四仓库快照和成功的阶段一检索，主要重新执行阶段二。

不需要：

- 重新部署 Edge Function；
- 重新执行 `0010`；
- 重新配置模型；
- 重启前端。

---

## 13. 日常最短启动流程

数据库、Edge Function、模型和 `worker.env` 只需首次配置。以后本机使用通常只需两个终端。

### 终端 A：启动前端

```bash
cd /Users/kingdee/codeReviewPlatform
npm run dev
```

### 终端 B：启动 Worker

```bash
cd /Users/kingdee/codeReviewPlatform
set -a
source /Users/kingdee/.config/code-review-platform/worker.env
set +a
npm run worker:start
```

然后浏览器打开：

```text
http://localhost:5173
```

如果修改过 Worker 源码，启动前多执行一次：

```bash
npm run worker:build
```

---

## 14. 可选：以后使用 Docker 运行 Worker

本机单 Worker 成功后，再考虑 Docker。Docker 容器无法直接使用 macOS 的 Git Credential Helper，因此通常需要 GitLab 只读 Deploy User/Token，并在 `worker.env` 中增加容器专用配置。

启动 4 个 Worker 的正式命令：

```bash
cd /Users/kingdee/codeReviewPlatform

docker compose \
  --env-file /Users/kingdee/.config/code-review-platform/worker.env \
  -f docker-compose.worker.yml \
  up -d --build --scale worker=4
```

查看状态：

```bash
docker compose \
  --env-file /Users/kingdee/.config/code-review-platform/worker.env \
  -f docker-compose.worker.yml \
  ps
```

停止：

```bash
docker compose \
  --env-file /Users/kingdee/.config/code-review-platform/worker.env \
  -f docker-compose.worker.yml \
  down
```

第一次本机功能验证不需要执行这一节。

---

## 15. 安全注意事项

- 不要把 Supabase Service Role、模型 Key、GitLab Token 发到聊天。
- 不要把 Secret 写进 `.env.local` 或任何 `VITE_` 变量。
- 不要把 Worker Secret 写进源码、Dockerfile 或 Git。
- 模型 Key 只通过“模型管理”页面写入 Vault。
- Key 一旦粘贴到聊天或日志，立即吊销并轮换。
- 不要把生产 Supabase 用于首次迁移、SQL 回归或故障演练。
- 不要为了让任务通过而放宽证据路径校验；没有证据应返回 `UNCERTAIN`。

---

## 16. 当前状态与下一步

截至本文整理时：

- Supabase CLI 已安装并登录；
- 云项目已关联；
- `0010` 已执行；
- `admin-model-config` 已部署；
- 本机 Origin 白名单已设置；
- 模型已配置、启用并通过连接测试；
- Worker 已成功启动；
- 四仓库准备和阶段一检索已跑通；
- 阶段二证据路径问题已完成代码修复；
- 修复后的 Worker 构建、132 项测试和 lint 已通过。

下一步：

```text
停止旧 Worker
→ 启动新编译的 Worker
→ 页面点击“按原 Commit 重试”
→ 检查 AI 分析是否达到 1/1
→ 检查批次是否进入 REVIEWING
→ 检查结果和代码证据
```
