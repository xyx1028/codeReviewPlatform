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
WORKER_ENV_FILE=.docker/worker.local.env docker compose -p codereviewplatform-local -f docker-compose.worker.yml up -d --no-build --scale worker=1
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

### 修改了 Worker 代码

第一步：重新构建镜像并更新本地 Worker。

```bash
WORKER_ENV_FILE=.docker/worker.local.env docker compose -p codereviewplatform-local -f docker-compose.worker.yml up -d --build --force-recreate --scale worker=1
```

第二步：使用本地前端和本地 Supabase 验证。

第三步：验证通过后，更新云端配置 Worker。

```bash
WORKER_ENV_FILE=.docker/worker.env docker compose -p codereviewplatform -f docker-compose.worker.yml up -d --no-build --force-recreate --scale worker=4
```

云端配置 Worker 不需要再次 `--build`，因为两套 Worker 都在同一个 Docker Desktop 中，共用刚刚在本地验证过的 `codereviewplatform-worker:latest` 镜像。

### 只修改了配置文件

只改本地 `.docker/worker.local.env`：

```bash
WORKER_ENV_FILE=.docker/worker.local.env docker compose -p codereviewplatform-local -f docker-compose.worker.yml up -d --no-build --force-recreate --scale worker=1
```

只改云端配置 `.docker/worker.env`：

```bash
WORKER_ENV_FILE=.docker/worker.env docker compose -p codereviewplatform -f docker-compose.worker.yml up -d --no-build --force-recreate --scale worker=4
```

`--force-recreate` 会重新创建容器。命名卷不会删除，但正在执行的任务会被中断，所以要先等待任务结束。

配置文件中包含密钥，不要截图、发送或提交 Git。
