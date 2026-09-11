# 代码评审平台 AI 自动化 MVP：操作、配置与验证指南

> 文档位置：桌面  
> 项目目录：`/Users/kingdee/codeReviewPlatform`  
> 适用环境：本地开发、测试/预发布、公司内网 Worker  
> 更新时间：2026-09-09

---

## 1. 先看结论

当前代码已经实现完成，并通过本地构建、数据库回归、Worker 单元测试、并发 E2E 和容器 E2E。
你现在可以直接做两类验证：

1. **不需要新凭据的本地验证**：代码构建、132 项 Worker 测试、当前电脑访问 GitLab 的 12 个分支检查。
2. **完整测试/预发布验证**：需要测试 Supabase、service-role、GitLab 只读 Deploy Token，以及已经在 Vault 中配置的新模型 Key。

完整验收必须在**测试/预发布环境**先做。不要把 Worker 直接连接生产：Worker 启动后会轮询并领取数据库中的待处理任务。

---

## 2. 三类配置必须分开

### 2.1 前端配置：可以进入浏览器

项目根目录创建 `.env.local`：

```dotenv
VITE_SUPABASE_URL=<测试或预发布 Supabase URL>
VITE_SUPABASE_ANON_KEY=<Supabase anon key>
```

前端只能有这两个值。禁止配置：

```text
VITE_SUPABASE_SERVICE_ROLE_KEY
VITE_MODEL_API_KEY
VITE_GITLAB_DEPLOY_TOKEN
```

### 2.2 Worker 配置：只能放在安全环境文件或容器 Secret 中

推荐位置：

```text
/Users/kingdee/.config/code-review-platform/worker.env
```

不要把 Worker 环境文件放在桌面或项目目录，也不要提交 Git。

### 2.3 模型 API Key：只能通过 ADMIN“模型管理”页面写入 Vault

模型 Key 不写进前端 `.env.local`，也不写进 Worker 环境变量。正确流程是：

```text
ADMIN 页面输入新 Key
  → admin-model-config Edge Function
  → Supabase Vault
  → ai_model_config 只保存 secret UUID
```

旧需求文档中出现过的模型 Key 必须先在供应商控制台轮换或吊销，不要继续使用。

---

## 3. 首次准备清单

准备以下内容：

- [ ] Node.js 24、npm、Git、ripgrep、Docker Desktop。
- [ ] 测试或预发布 Supabase 项目。
- [ ] 数据库已应用 `0001` 到 `0010` 迁移。
- [ ] 已部署 `admin-model-config` Edge Function。
- [ ] 前端有 `VITE_SUPABASE_URL` 和 `VITE_SUPABASE_ANON_KEY`。
- [ ] 一个 ADMIN 用户和至少一个 REVIEWER 用户。
- [ ] GitLab 只读 Deploy User/Token，只授予读取四个仓库的权限。
- [ ] 一个新模型 API Key，且供应商允许发送公司代码片段。
- [ ] 模型配置已启用，Provider 首次验收使用 `openai-compatible`。
- [ ] 明确模型并发上限，建议先用 4 或 8。

固定仓库：

```text
kdmanage-backend
kdmanage-frontend
tmanage-backend
tmanage-frontend
```

固定允许分支：

```text
feature_dev
feature_sit
release
```

---

## 4. 安装与本地代码验证

打开终端：

```bash
cd /Users/kingdee/codeReviewPlatform
npm ci
```

执行全部本地门禁：

```bash
npm run build
npm run worker:build
npm run test:worker
npx oxlint src worker supabase
git diff --check
```

当前版本的预期结果：

```text
前端：1723 modules transformed，build 成功
Worker：16 个测试文件、132 项测试通过
Oxlint：0 warning / 0 error
git diff --check：无输出且退出码 0
```

如果这里只是测试代码，不需要 Supabase service-role、模型 Key 或 Deploy Token。

---

## 5. 只验证当前电脑访问 GitLab

当前电脑已有可用 Git Credential Helper 时执行：

```bash
cd /Users/kingdee/codeReviewPlatform
npm run worker:build

CONNECTIVITY_COMPONENTS=git \
GIT_AUTH_MODE=local \
npm run worker:check-connectivity
```

成功条件：

```json
{
  "event": "connectivity_summary",
  "ok": true,
  "total": 12,
  "passed": 12,
  "failed": 0
}
```

这会对 4 个仓库 × 3 个分支执行 `git ls-remote`，不会克隆代码。

注意：这只能证明当前电脑访问 GitLab 成功，不能替代正式内网容器的三方验收。

---

## 6. 配置前端

在项目根目录创建文件：

```bash
cd /Users/kingdee/codeReviewPlatform
cat > .env.local <<'EOF'
VITE_SUPABASE_URL=<测试或预发布 Supabase URL>
VITE_SUPABASE_ANON_KEY=<Supabase anon key>
EOF
```

请将尖括号内容替换成真实测试值，然后启动：

```bash
npm run dev
```

浏览器打开 Vite 输出的本地地址，通常是：

```text
http://localhost:5173
```

生产构建检查：

```bash
npm run build
```

---

## 7. 配置数据库和 Edge Function

### 7.1 数据库迁移

迁移文件：

```text
/Users/kingdee/codeReviewPlatform/supabase/migrations/0010_ai_automation_mvp.sql
```

如果目标 Supabase 已经应用 `0001` 到 `0009`，只应用未执行的 `0010`。推荐使用已经链接到**测试项目**的 Supabase CLI：

```bash
cd /Users/kingdee/codeReviewPlatform
supabase db push
```

如果本机没有 Supabase CLI，可以在 Supabase Dashboard 的 SQL Editor 中对测试项目执行 `0010_ai_automation_mvp.sql`。

重要：

- 不要在未备份、未审批的生产库直接执行。
- `SUPABASE_SERVICE_ROLE_KEY` 不是 PostgreSQL 数据库密码，不能拿它替代数据库连接串。
- 应用后确认 Vault 已启用，`anon/authenticated` 无法读取 `vault.decrypted_secrets`。

### 7.2 部署模型管理 Edge Function

函数目录：

```text
supabase/functions/admin-model-config
```

在已链接的测试 Supabase 项目执行：

```bash
supabase functions deploy admin-model-config
```

配置允许访问前端的域名：

```bash
supabase secrets set \
  ALLOWED_ORIGINS='http://localhost:5173,https://test-review.example.com'
```

请把 `test-review.example.com` 替换成真实测试前端域名。托管 Supabase 通常自动向 Edge Function 提供 `SUPABASE_URL`、`SUPABASE_ANON_KEY`、`SUPABASE_SERVICE_ROLE_KEY`；自托管环境需要由平台安全注入。

不要使用 `*` 作为 CORS Origin。

---

## 8. 在 ADMIN 页面配置模型

1. 使用 ADMIN 用户登录。
2. 打开“模型管理”。
3. 点击新增模型。
4. 填写：

```text
展示名称：例如“通义测试模型”
Provider：openai-compatible
Base URL：供应商的 OpenAI 兼容 API 基地址
Model Name：供应商实际模型名
API Key：新申请或已轮换的 Key
最大并发：建议先填 4 或 8
请求超时：按供应商情况配置
启用状态：启用
```

5. 点击“测试连接”。测试只发送 `ping` 和 `max_tokens=1`，不发送需求或代码。
6. 保存并启用。

为了执行容器连通性检查，需要模型配置 UUID。可在 Supabase Dashboard SQL Editor 查询，不返回任何 secret：

```sql
select
  id,
  display_name,
  provider,
  base_url,
  model_name,
  enabled,
  max_parallel_tasks
from public.ai_model_config
order by created_at desc;
```

把需要验收的 `id` 记为 `CONNECTIVITY_MODEL_CONFIG_ID`。

---

## 9. 申请 GitLab 只读凭据

推荐使用 Deploy Token 或专用只读账号：

- 只授予 `read_repository`。
- 不授予写仓库、API 管理或管理员权限。
- 仅覆盖四个固定仓库。
- 设置合理有效期并定期轮换。

需要得到：

```text
GITLAB_DEPLOY_USER
GITLAB_DEPLOY_TOKEN
```

Worker 不会把 Token 拼入 Git URL，而是通过 `http.extraHeader` 注入。

---

## 10. 创建安全的 Worker 环境文件

执行：

```bash
mkdir -p /Users/kingdee/.config/code-review-platform
chmod 700 /Users/kingdee/.config/code-review-platform
umask 077
nano /Users/kingdee/.config/code-review-platform/worker.env
```

文件内容：

```dotenv
SUPABASE_URL=<测试或预发布 Supabase URL>
SUPABASE_SERVICE_ROLE_KEY=<测试或预发布 service-role key>

GIT_AUTH_MODE=token
GITLAB_BASE_URL=https://git.kingdee.com
GITLAB_DEPLOY_USER=<只读 Deploy User>
GITLAB_DEPLOY_TOKEN=<只读 Deploy Token>

CONNECTIVITY_MODEL_CONFIG_ID=<已启用模型配置 UUID>
CONNECTIVITY_TIMEOUT_MS=30000

POLL_INTERVAL_MS=5000
STORY_TASK_LEASE_SECONDS=900
HEARTBEAT_INTERVAL_MS=30000
WORKER_STORY_CONCURRENCY=2
LOG_LEVEL=info
```

保存后执行：

```bash
chmod 600 /Users/kingdee/.config/code-review-platform/worker.env
```

说明：

- Compose 会用容器 hostname 自动产生唯一 `WORKER_ID`，不需要在这个文件手工设置。
- 如果不用 Compose、而是直接运行 `npm run worker:start`，则必须额外设置唯一的 `WORKER_ID`。
- `CONNECTIVITY_MODEL_CONFIG_ID` 只用于连通性检查；实际任务使用批次所选模型。
- 模型 API Key 不应出现在该文件中，它必须在 Vault 中。

---

## 11. 完整三方连通性验证（建议先做）

### 11.1 构建正式 Worker 镜像

```bash
cd /Users/kingdee/codeReviewPlatform

docker build \
  -f Dockerfile.worker \
  -t codereviewplatform-worker:validation \
  .
```

### 11.2 在目标网络运行验证

```bash
docker run --rm \
  --env-file /Users/kingdee/.config/code-review-platform/worker.env \
  codereviewplatform-worker:validation \
  npm run worker:check-connectivity
```

工具会检查：

```text
GitLab：4 仓库 × 3 分支 = 12 项
Supabase/PostgREST + Vault：1 项
模型 API 最小 ping：1 项
合计：14 项
```

完整成功判据：

```json
{
  "event": "connectivity_summary",
  "ok": true,
  "total": 14,
  "passed": 14,
  "failed": 0
}
```

退出码说明：

```text
0：全部通过
1：某个网络、鉴权、分支、Vault 或模型探针失败
2：环境变量缺失或格式错误
```

该检查不会输出 URL、Key、Token、Authorization Header、请求体或响应体。模型只接收 `ping`，不会接收需求或代码。

如果不是 `14/14`，不要启动正式 Worker，先看本文第 18 节排错。

---

## 12. 数据库回归测试

测试脚本：

```text
supabase/tests/0010_ai_automation_mvp_test.sql
```

仅在测试数据库或可回滚环境运行：

```bash
cd /Users/kingdee/codeReviewPlatform

psql -v ON_ERROR_STOP=1 \
  -U postgres \
  -d your_test_database \
  -f supabase/tests/0010_ai_automation_mvp_test.sql
```

目标库必须已经按顺序应用 `0001` 到 `0010`，执行用户需要能 `set local role` 到 `authenticated/service_role`。

成功标记：

```text
ALL_AI_AUTOMATION_MVP_TESTS_PASSED
```

脚本整体使用 `BEGIN ... ROLLBACK`，正常完成不保留测试数据，但仍禁止在生产库运行。

---

## 13. 启动 4 个 Worker

先确认：

- [ ] 当前连接的是测试/预发布 Supabase。
- [ ] 第 11 节完整连通性为 14/14。
- [ ] 模型供应商允许发送公司代码片段。
- [ ] 模型并发和费用上限已确认。
- [ ] 没有不应被处理的测试库待领取任务。

启动：

```bash
cd /Users/kingdee/codeReviewPlatform

docker compose \
  --env-file /Users/kingdee/.config/code-review-platform/worker.env \
  -f docker-compose.worker.yml \
  up -d --build --scale worker=4
```

查看容器：

```bash
docker compose \
  --env-file /Users/kingdee/.config/code-review-platform/worker.env \
  -f docker-compose.worker.yml \
  ps
```

查看日志：

```bash
docker compose \
  --env-file /Users/kingdee/.config/code-review-platform/worker.env \
  -f docker-compose.worker.yml \
  logs -f --tail=100 worker
```

预期：

```text
4 个 Worker 容器运行
每个 Worker slots=2
总槽位=8
每个 Worker ID 唯一
无入站端口暴露
```

停止：

```bash
docker compose \
  --env-file /Users/kingdee/.config/code-review-platform/worker.env \
  -f docker-compose.worker.yml \
  down
```

不要使用 `docker compose down -v`，除非你明确要删除本地 Worker workspace 卷。

---

## 14. 做一次完整业务验收

### 14.1 创建测试批次

1. ADMIN 登录前端。
2. 创建测试批次。
3. 选择允许分支之一：`feature_dev`、`feature_sit` 或 `release`。
4. 必须选择已启用、已配置 Key 的模型。
5. 上传 DevOps Excel。
6. 核对需求数量，建议正式并发验收使用 20 条需求。

### 14.2 启动分析

1. 打开 AI 结果页面。
2. 点击“开始 AI 分析”。
3. 查看四个仓库快照。
4. 确认每个仓库显示完整 40 位 Commit SHA。
5. 查看在线 Worker、总槽位、处理中 story 和运行时间。

### 14.3 成功判据

- [ ] 4 个仓库都使用批次选择的同一分支。
- [ ] 4 个仓库都有 40 位 SHA。
- [ ] 20 条需求都有阶段一检索结果。
- [ ] 阶段一没有最终实现结论。
- [ ] 阶段二使用冻结代码上下文。
- [ ] 每条需求都有固定 verdict、confidence 和结构化证据。
- [ ] 证据路径、行号和 SHA 校验通过。
- [ ] 最大并发不超过模型配置，例如上限 8 时峰值不超过 8。
- [ ] 全部 story 完成前没有正式 `ai_import_record`。
- [ ] 完成后只有 1 条正式导入版本，没有重复结果。
- [ ] 批次进入 `REVIEWING`。
- [ ] REVIEWER 可以继续完成人工复核。

### 14.4 故障接管验证

仅在测试环境：

1. 分析过程中停止一个 Worker 容器。
2. 等待其任务租约到期。
3. 确认其他 Worker 接管。
4. 确认没有重复正式结果。
5. 恢复到 4 个 Worker。

不要在生产批次上故意停止 Worker 做演练。

---

## 15. 每周日常操作

1. 检查 4 个 Worker 是否在线，总槽位是否为 8。
2. 检查计划使用的模型已启用，连接测试正常。
3. 从 DevOps 导出当周 Excel。
4. 创建批次，选择正确分支和模型。
5. 上传 Excel，核对需求数与字段映射。
6. 点击“开始 AI 分析”。
7. 检查 4 个仓库快照和 Commit SHA。
8. 等待任务完成。
9. 抽查阶段一候选文件。
10. 进入评审列表做人工确认。
11. 完成批次。

保留的人工兜底：如果自动分析不可用，仍可使用原有人工 Excel AI 结果导入流程。

---

## 16. 重试规则

前端“按原 Commit 重试”会继续使用原来的四仓库 SHA，不会偷偷拉取最新代码。

适合重试：

```text
MODEL_RATE_LIMITED
MODEL_TIMEOUT
模型 5xx
临时 Git 获取失败
Schema 修正后重新分析
```

不要盲目重试：

```text
GIT_AUTH_FAILED：先更新 Deploy Token
GIT_BRANCH_MISSING：先确认批次分支，不允许自动回退
MODEL_AUTH_FAILED：先在 ADMIN 页面轮换模型 Key
MODEL_SECRET_MISSING：检查 Vault 和模型配置
EVIDENCE_PATH_INVALID：检查模型输出或 Harness
```

只有确实需要最新代码时才创建新批次。

---

## 17. 密钥轮换

### 模型 Key

1. 在供应商控制台创建新 Key。
2. ADMIN 进入“模型管理”，编辑模型。
3. 输入新 Key 并保存。
4. 执行“测试连接”。
5. 确认通过后，在供应商控制台吊销旧 Key。

编辑模型时 Key 留空表示不轮换；页面永远不会回显旧 Key。

### GitLab Deploy Token

1. 创建新的只读 Token。
2. 更新安全环境文件或容器 Secret。
3. 重新运行 14 项连通性检查。
4. 滚动重启 Worker。
5. 确认新 Token 正常后吊销旧 Token。

### Supabase service-role

service-role 权限极高。轮换必须通过 Supabase 平台流程，并同步更新 Worker Secret。禁止放入前端或普通数据库表。

---

## 18. 常见错误排查

| 错误/现象 | 处理方式 |
|---|---|
| `CONNECTIVITY_CONFIG_MISSING` | 检查 Worker 环境文件是否缺变量，确认 `--env-file` 路径正确 |
| `GIT_AUTH_FAILED` | 检查 Deploy User/Token 和 `read_repository` 权限 |
| `GIT_BRANCH_MISSING` | 检查四个仓库是否都有所选分支；禁止回退到其他分支 |
| `SUPABASE_HTTP_401/403` | 检查 Supabase URL 和 service-role 是否来自同一测试项目 |
| `VAULT_RPC_HTTP_401/403/404` | 检查 `0010` 是否已应用、RPC 权限和 Vault 是否启用 |
| `MODEL_CONFIG_NOT_FOUND` | 检查 `CONNECTIVITY_MODEL_CONFIG_ID` |
| `MODEL_CONFIG_DISABLED` | 在 ADMIN 页面启用模型 |
| `MODEL_SECRET_MISSING` | 重新在 ADMIN 页面配置新模型 Key |
| `MODEL_HTTP_401/403` | Key 无效、未授权或已被供应商吊销 |
| `MODEL_HTTP_429` | 降低 `max_parallel_tasks` 或联系供应商提高额度 |
| `MODEL_TIMEOUT` | 检查网络、Base URL 和模型超时配置 |
| Worker 数为 0 | 检查 Compose、容器日志、Supabase URL/service-role |
| Worker 有 4 个但总槽位不是 8 | 检查 `WORKER_STORY_CONCURRENCY=2` |
| 批次一直 `PREPARING_CODE` | 检查 GitLab 鉴权、分支和四仓库网络 |
| `TASK_LEASE_LOST` | Worker 已失去租约，迟到写被安全拒绝；通常等待新 Worker 接管 |
| `RESULT_ALREADY_EXISTS` | 已存在正式结果，不要重复完成同一批次 |

日志禁止包含任何 Key。如果日志中意外出现 Key，立即停止、清理日志并轮换该 Key。

---

## 19. 安全红线

- 不把 service-role、模型 Key、Git Token 发到聊天、邮件或工单正文。
- 不把 Secret 放到桌面文档、项目源码、Git、前端环境变量或普通数据库表。
- 不使用旧需求文档中出现过的模型 Key。
- 不把 Token 拼进 Git URL。
- 不把完整源代码长期保存到 Supabase。
- 不在未审批的生产数据库执行迁移或 SQL 回归脚本。
- 不在生产环境直接做 Worker 崩溃演练。
- 不确认模型供应商数据政策前，不发送公司代码片段。

---

## 20. 最短操作路径

如果环境已经准备好，只需按下面顺序执行：

```bash
cd /Users/kingdee/codeReviewPlatform

# 1. 代码验证
npm ci
npm run build
npm run worker:build
npm run test:worker
npx oxlint src worker supabase

# 2. 构建镜像
docker build -f Dockerfile.worker -t codereviewplatform-worker:validation .

# 3. 完整三方连通性验证
docker run --rm \
  --env-file /Users/kingdee/.config/code-review-platform/worker.env \
  codereviewplatform-worker:validation \
  npm run worker:check-connectivity

# 4. 只有在上一步14/14后，才启动4个Worker
docker compose \
  --env-file /Users/kingdee/.config/code-review-platform/worker.env \
  -f docker-compose.worker.yml \
  up -d --build --scale worker=4

# 5. 启动前端
npm run dev
```

然后在前端：

```text
ADMIN配置模型 → 创建测试批次 → 选分支和模型 → 上传Excel
→ 开始AI分析 → 检查快照/进度/结果 → REVIEWER人工复核
```

---

## 21. 当前还需要你提供或确认的内容

当前代码仓库没有配置真实运行凭据。要完成正式内网验收，需要：

- [ ] 测试/预发布 `SUPABASE_URL`。
- [ ] 对应的 `SUPABASE_SERVICE_ROLE_KEY`。
- [ ] GitLab 只读 `GITLAB_DEPLOY_USER/TOKEN`。
- [ ] ADMIN 页面中已启用模型的 UUID。
- [ ] 已轮换的新模型 API Key，并已安全写入 Vault。
- [ ] 允许在目标公司内网运行验证容器。
- [ ] 确认模型服务允许发送公司代码片段。

不要把上述 Key 发给我或写进本桌面文档。请通过本机安全环境文件或容器 Secret 平台配置。

---

## 22. 验收完成的最终标志

以下全部成立才算正式完成：

- [ ] 本地构建、Worker 测试、lint 全部通过。
- [ ] SQL 回归输出 `ALL_AI_AUTOMATION_MVP_TESTS_PASSED`。
- [ ] 目标内网容器连通性 `14/14`、退出码 0。
- [ ] 4 个 Worker 在线，每个 2 槽位，总槽位 8。
- [ ] 测试批次 20 条需求全部完成。
- [ ] 模型最大并发限制没有越界。
- [ ] 4 个仓库快照和 SHA 正确。
- [ ] 阶段一无结论，阶段二只使用冻结上下文。
- [ ] 正式结果只写入一次，没有重复。
- [ ] 人工复核可继续使用。
- [ ] 旧模型 Key 已在供应商控制台轮换或吊销。
- [ ] 没有 Secret 进入前端、日志、源码或普通表。

达到以上条件后，才可以把环境标记为“AI 自动化 MVP 验收完成”。
