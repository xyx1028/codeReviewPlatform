# 代码评审平台 Docker Worker 启动命令手册

本手册只管理本机 Docker Desktop 中的 **Worker**。Vercel 前端和云 Supabase 不会被这些命令重启或重新部署。

## 0. 先记住这三个位置

```text
项目目录：/Users/kingdee/codeReviewPlatform
Docker 配置：/Users/kingdee/codeReviewPlatform/.docker/worker.env
Compose 文件：/Users/kingdee/codeReviewPlatform/docker-compose.worker.yml
```

`worker.env` 中包含 Supabase service role 和 GitLab Token，绝对不要截图、发到聊天、提交 Git 或写进 Dockerfile。

## 1. 第一次启动前

确认 Docker Desktop 已打开，并且已经填写好 `.docker/worker.env`。

如果此前在 Terminal 中手动执行过 `npm run worker:start`，请先回到原 Terminal，按 `Control + C` 停掉所有手动 Worker；不要让手动 Worker 和 Docker Worker 同时抢任务。

进入项目目录：

```bash
cd /Users/kingdee/codeReviewPlatform
```

## 2. 第一次启动：先运行 1 个 Worker

```bash
docker compose -f docker-compose.worker.yml up -d --build --scale worker=1
```

这条命令会：

1. 使用当前 `worker/` 代码构建 Worker 镜像；
2. 在后台启动 1 个 Worker 容器；
3. 启动时自动读取 `.docker/worker.env`；
4. 不会部署 Vercel，也不会启动前端。

查看最近 100 行日志：

```bash
docker compose -f docker-compose.worker.yml logs --tail=100 worker
```

如果没有红色报错，继续下一步。

## 3. 扩容为 2 个 Worker

```bash
docker compose -f docker-compose.worker.yml up -d --scale worker=2
```

这会保留已运行的第一个 Worker，再启动第二个。配置中每个 Worker 同时最多处理 2 个需求，因此：

```text
2 个 Worker × 每个 2 个并发 = 最多 4 个需求同时处理
```

查看两个容器是否都在运行：

```bash
docker compose -f docker-compose.worker.yml ps
```

## 4. 日常查看

实时持续查看日志，按 `Control + C` 退出查看（不会停止 Worker）：

```bash
docker compose -f docker-compose.worker.yml logs -f worker
```

查看最近日志：

```bash
docker compose -f docker-compose.worker.yml logs --tail=100 worker
```

查看容器状态：

```bash
docker compose -f docker-compose.worker.yml ps
```

## 5. 修改 Worker 代码后更新

若修改了 `worker/`、`Dockerfile.worker` 或 `package.json`，先等待正在处理的任务完成，再执行：

```bash
docker compose -f docker-compose.worker.yml up -d --build --scale worker=2
```

Docker 会使用新代码制作镜像，并用新镜像替换 Worker 容器，最后保持 2 个 Worker。

> 若旧 Worker 正在处理任务时强制更新，该任务会中断，等待租约过期后由 Worker 重新领取；因此推荐在没有任务运行时更新。

## 6. 只修改 `.docker/worker.env` 后更新

例如更换 GitLab Token、Supabase service role 或调整并发数后，配置不会进入镜像，只需重建容器：

```bash
docker compose -f docker-compose.worker.yml up -d --force-recreate --scale worker=2
```

`--force-recreate` 表示使用新配置重新创建容器；不需要 `--build`。

## 7. 停止、重启和恢复

停止并删除本项目的 Worker 容器：

```bash
docker compose -f docker-compose.worker.yml down
```

重新启动已有 Worker 容器，不重新构建镜像：

```bash
docker compose -f docker-compose.worker.yml restart worker
```

再次启动两个 Worker：

```bash
docker compose -f docker-compose.worker.yml up -d --scale worker=2
```

## 8. 常用命令速查

```bash
# 首次或 Worker 代码更新：构建并启动 1 个 Worker
docker compose -f docker-compose.worker.yml up -d --build --scale worker=1

# 正常运行：确保有 2 个 Worker
docker compose -f docker-compose.worker.yml up -d --scale worker=2

# 看状态
docker compose -f docker-compose.worker.yml ps

# 看实时日志
docker compose -f docker-compose.worker.yml logs -f worker

# 配置或 Token 改过后重新创建 Worker
docker compose -f docker-compose.worker.yml up -d --force-recreate --scale worker=2

# 停止 Docker Worker
docker compose -f docker-compose.worker.yml down
```

## 9. 出错时怎么做

先执行：

```bash
docker compose -f docker-compose.worker.yml logs --tail=150 worker
```

把报错文本发给 Codex 即可；不要发送 `.docker/worker.env` 的内容、Supabase service role 或 GitLab Token。
