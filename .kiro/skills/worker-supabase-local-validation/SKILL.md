---
name: worker-supabase-local-validation
description: 在本工作区修改 Worker、Worker 镜像或启动配置、Worker 相关脚本、Supabase migration/RPC/RLS/触发器/Storage、或 supabase/functions 时必须使用；要求 AI 先用本地 Supabase 和本地 Worker 完成验证，再把提交代码、数据库推送、Function 部署和云端配置 Worker 更新整理成由用户手动执行的发布清单。
---

# Worker 与 Supabase 本地验证、手动发布流程

本 Skill 是本仓库的强制交付流程。目标是让 AI 安全完成本地开发和验证，同时不误改云端环境。

## 1. 必须触发的范围

出现以下任一改动时必须使用本 Skill：

- `worker/**`、`Dockerfile.worker`、`docker-compose.worker.yml`；
- 会影响 Worker 构建或运行的 `scripts/**`、`package.json`、TypeScript 配置；
- `supabase/migrations/**`、`supabase/tests/**`，以及数据库表、RPC、RLS、触发器、Storage 策略；
- `supabase/functions/**` 或影响本地 Supabase / Edge Function 的配置；
- 同时涉及前端、数据库和 Worker 的完整业务流程。

纯文档或与上述运行链路无关的纯前端改动不触发。

若新增或修改迁移，还必须同时遵守 `$supabase-migration-naming`；若属于新需求开发，还要遵守 `$feature-execution-document`。

## 2. 环境边界

本地验证使用：

- 本地 Supabase：`http://127.0.0.1:54321`；
- 本地 Worker 配置：`.docker/worker.local.env`；
- 本地 Compose 项目：`codereviewplatform-local`；
- 本地 Worker 数量：1。

默认情况下，AI 只能操作本地 Supabase 和本地 Worker。除非用户明确要求执行发布，否则 AI 不得：

- `git commit` 或 `git push`；
- 执行真实的 `supabase db push`；
- 部署 Edge Function；
- 重建或重启 `codereviewplatform` 项目下连接云端 Supabase 的 Worker；
- 输出、截图或提交 `.env` 中的密钥。

**绝对禁止重建/重置数据库。** 完整清单见 `.kiro/steering/database-never-reset.md`（always 生效）。
要点：`supabase db reset`（本地或 linked）、`supabase stop --no-backup`、任何 `down -v`、
`drop database` / `drop schema public cascade` / 无 where 的批量删除，AI 一律不执行 ——
用户要求也不例外，只输出命令由用户自己执行。迁移文件能重建结构，重建不了账号、模型密钥、
批次、AI 结论和人工确认记录。

Worker 侧相反：它是无状态服务，镜像与容器随便重建、重启、扩缩容（有在途任务时用
`npm run worker:release` 先排空）。

执行 Docker 操作前，先阅读：

```text
需求开发评审一致性平台/docker命令/Docker Worker 启动命令手册.md
```

## 3. 开始验证前

1. 根据改动范围选择下面对应的验证步骤；混合改动要合并执行。
2. 确认 Docker Desktop 和本地 Supabase 可用：

```bash
supabase status
```

若未启动，再运行：

```bash
supabase start
```

3. 重建 Worker 前先确认没有本地任务正在执行。`--force-recreate` 会中断容器内的在途任务，但不会删除 named volume。任何 `down` 命令都不得附加 `-v`。

## 4. Worker、镜像或 Worker 脚本改动

先执行与改动相关的静态检查和测试，至少包括：

```bash
npm run worker:typecheck
npm run worker:build
npm run test:worker
```

按需补充针对性测试、`npm run lint` 和前端构建。

确认没有在途任务后，重新构建镜像并只更新本地 Worker：

```bash
WORKER_ENV_FILE=.docker/worker.local.env docker compose -p codereviewplatform-local -f docker-compose.worker.yml up -d --build --force-recreate --scale worker=1
```

验证容器状态和启动日志：

```bash
docker compose -p codereviewplatform-local -f docker-compose.worker.yml ps --all
docker logs --tail 100 codereviewplatform-local-worker-1
```

验收不能只看容器存在：容器必须为 `Up`，日志中应出现 `worker_started`，并且要实际跑通本次改动涉及的本地业务流程。

如果只修改 `.docker/worker.local.env`，无需构建镜像，使用：

```bash
WORKER_ENV_FILE=.docker/worker.local.env docker compose -p codereviewplatform-local -f docker-compose.worker.yml up -d --no-build --force-recreate --scale worker=1
```

## 5. Supabase migration、RPC 或策略改动

迁移必须新建，禁止修改已经存在的迁移。命名、幂等性和配套 SQL 测试遵守 `$supabase-migration-naming`。

把待验证迁移应用到本地数据库：

```bash
supabase migration up --local
```

执行本次改动对应的 SQL 测试：

```bash
docker exec -i supabase_db_codeReviewPlatform psql -v ON_ERROR_STOP=1 -U postgres -d postgres < supabase/tests/<对应测试文件>.sql
```

SQL 测试应使用 `begin; ... rollback;`，避免遗留测试数据。跨多个数据库对象的改动要运行所有受影响的 SQL 测试，不能只验证迁移命令成功。

如果本机数据库容器名不同，先用 `docker ps` 找到实际的 `supabase_db_*`，不得猜测云端或其他项目容器。

## 6. Supabase Edge Function 改动

使用本地 Supabase 验证 Function，可运行：

```bash
supabase functions serve
```

然后通过本地应用链路或针对性请求验证改动。不得在命令、日志或回复中展开密钥。

注意：`supabase db push` 只推送数据库迁移，不会部署 Edge Function。Function 改动必须在最终发布清单中单独列出：

```bash
supabase functions deploy <function-name>
```

## 7. 发布前只读检查

本地验证通过后，先检查迁移历史和云端待推送内容：

```bash
supabase migration list --local
supabase migration list --linked
supabase db push --linked --dry-run --skip-vault
```

如果 linked migration 历史不一致、dry-run 失败，或无法确认目标项目，立即停止并报告，不能继续真实推送，也不能先更新云端配置 Worker。

## 8. 完成后的交付格式

AI 的最终回复必须分成三部分：

1. **本地已验证**：列出实际通过的检查、SQL 测试、本地 Worker 状态和业务流程；
2. **未执行或阻塞**：明确列出未运行的检查、失败原因，以及所有尚未执行的云端写操作；
3. **你手动发布**：只列出本次改动真正需要的步骤。

常规手动发布顺序如下：

1. 用户检查并提交/推送代码；
2. 有数据库迁移时，在 dry-run 成功后由用户执行：

   ```bash
   supabase db push
   ```

3. 有 Edge Function 改动时，由用户逐个执行：

   ```bash
   supabase functions deploy <function-name>
   ```

4. 有 Worker 代码、镜像或云端 Worker 配置改动时，先确认云端配置 Worker 没有在途任务，再由用户执行：

   ```bash
   WORKER_ENV_FILE=.docker/worker.env docker compose -p codereviewplatform -f docker-compose.worker.yml up -d --no-build --force-recreate --scale worker=4
   ```

这里使用 `--no-build` 的前提是：本地验证阶段已经在同一台 Mac 的 Docker Desktop 中成功构建并验证了最新的 `codereviewplatform-worker:latest` 镜像。如果以后 Worker 真正迁移到远程服务器，应改成镜像仓库的 build/push/pull 发布流程，不能继续套用本机共享镜像的假设。

没有涉及的发布步骤不要让用户执行。不得把“本地验证通过”描述成“云端已经发布成功”。
