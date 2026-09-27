# Docker Worker 启动命令（简版）

## 现在有哪两套 Worker

| 用途 | 连接哪里 | 配置文件 | Worker 数量 |
|---|---|---|---:|
| 本地 | 本地 Supabase | `.docker/worker.local.env` | 1 |
| 云端配置 | 云端 Supabase | `.docker/worker.env` | 4 |

两套 Worker 都运行在这台 Mac 的 Docker Desktop 中。“云端配置”不代表已经部署到云服务器；Mac 或 Docker 停止后，两套 Worker 都会停止。

## 每次先做

打开 Docker Desktop，然后进入项目目录：

```bash
cd /Users/kingdee/codeReviewPlatform
```

## 启动本地 Worker

先启动本地 Supabase：

```bash
supabase start
```

再启动 1 个本地 Worker：

```bash
WORKER_ENV_FILE=.docker/worker.local.env docker compose -p codereviewplatform-local -f docker-compose.worker.yml up -d --no-build --scale worker=4
```

## 启动云端配置 Worker

```bash
WORKER_ENV_FILE=.docker/worker.env docker compose -p codereviewplatform -f docker-compose.worker.yml up -d --no-build --scale worker=4
```

## 查看运行状态

```bash
docker ps --filter name=codereviewplatform
```

正常会看到：

```text
codereviewplatform-local-worker-1
codereviewplatform-worker-1
codereviewplatform-worker-2
codereviewplatform-worker-3
codereviewplatform-worker-4
```

## 查看日志

```bash
# 本地 Worker
docker logs -f codereviewplatform-local-worker-1

# 云端配置 Worker
docker logs -f codereviewplatform-worker-1
```

按 `Control + C` 退出日志查看，不会停止 Worker。

## 停止 Worker

```bash
# 只停止本地 Worker
WORKER_ENV_FILE=.docker/worker.local.env docker compose -p codereviewplatform-local -f docker-compose.worker.yml down

# 只停止云端配置 Worker
WORKER_ENV_FILE=.docker/worker.env docker compose -p codereviewplatform -f docker-compose.worker.yml down
```

不要在 `down` 后面添加 `-v`，否则会删除对应的数据卷。

## 修改后怎么更新

> **先读这一条。** `--force-recreate` 会**销毁正在跑任务的容器**。一次 attempt 是 20~40
> 分钟模型时间，被销毁之后平台只能 `agent_attempt+1` 从零重跑。2026-09-17 19:59 就是这么
> 丢掉 8 个在途 attempt、47.9 分钟模型时间和对应 token 的（数据库里 8 行 `WORKER_LOST`）。
>
> 所以：**有在途任务时不要手敲 `--force-recreate`，用 drain 脚本。**
>
> ```bash
> # 云端配置 Worker：排空 → 重建 → 恢复领取，一条命令
> npm run worker:release -- --scale 4
>
> # 本地 Worker（顺带重建镜像）
> bash scripts/worker-drain-restart.sh --project codereviewplatform-local \
>   --env-file .docker/worker.local.env --scale 1 --build
>
> # 只想让池子停止领新任务（不重建），例如准备下班或排查问题
> npm run worker:drain
> # 恢复领取
> npm run worker:drain:lift
> ```
>
> 脚本会先写共享卷上的 `/workspace/jobs/DRAIN`（各副本 5 秒内停止领取，**在途任务继续
> 跑完**），等到每个副本写出 `/workspace/jobs/DRAINED.<worker-id>` 之后才重建，最后删掉
> sentinel。想自己看进度：
>
> ```bash
> docker exec $(docker ps -q -f label=com.docker.compose.project=codereviewplatform | head -1) \
>   ls /workspace/jobs
> ```
>
> 想确认某个副本真的空了，看日志里的 `worker_drain_complete`。

### 修改了 Worker 代码

第一步：重新构建镜像并更新本地 Worker（本地池通常没有在途任务，可以直接重建）。

```bash
WORKER_ENV_FILE=.docker/worker.local.env docker compose -p codereviewplatform-local -f docker-compose.worker.yml up -d --build --force-recreate --scale worker=4
```

第二步：使用本地前端和本地 Supabase 验证。

第三步：验证通过后，更新云端配置 Worker。**有在途任务就用 drain 脚本**：

```bash
npm run worker:release -- --scale 4
```

确认池子空闲时才可以直接重建：

```bash
WORKER_ENV_FILE=.docker/worker.env docker compose -p codereviewplatform -f docker-compose.worker.yml up -d --no-build --force-recreate --scale worker=4
```

云端配置 Worker 不需要再次 `--build`，因为两套 Worker 都在同一个 Docker Desktop 中，共用刚刚在本地验证过的 `codereviewplatform-worker:latest` 镜像。

如果同时有数据库迁移：**必须先 `supabase db push`，再重建 Worker**。反过来会让新 Worker
在旧库上写不了 checkpoint（日志 `session_checkpoint_failed`），续跑暂时失效。

### 只修改了配置文件

只改本地 `.docker/worker.local.env`：

```bash
WORKER_ENV_FILE=.docker/worker.local.env docker compose -p codereviewplatform-local -f docker-compose.worker.yml up -d --no-build --force-recreate --scale worker=1
```

只改云端配置 `.docker/worker.env`：

```bash
WORKER_ENV_FILE=.docker/worker.env docker compose -p codereviewplatform -f docker-compose.worker.yml up -d --no-build --force-recreate --scale worker=4
```

`--force-recreate` 会重新创建容器。命名卷不会删除，但**正在执行的任务会被中断并从零重跑**，
所以要么先用 `npm run worker:drain` 等池子排空，要么直接用 `npm run worker:release`。

配置文件中包含密钥，不要截图、发送或提交 Git。
