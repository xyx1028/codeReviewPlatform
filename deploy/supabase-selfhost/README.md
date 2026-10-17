# 内网自部署（V1.48 + V1.49 + V1.50）模板与脚本

执行方案在
[`需求开发评审一致性平台/V1.48-内网自部署Supabase/需求开发评审一致性平台-V1.48内网自部署Supabase-最终执行方案.md`](../../需求开发评审一致性平台/V1.48-内网自部署Supabase/需求开发评审一致性平台-V1.48内网自部署Supabase-最终执行方案.md)。
这个目录是方案 §9「可提交的模板和脚本」那一项的落地，**只含占位值，不含任何密钥**。

真正的部署动作（连服务器、生成密钥、推迁移、起容器）由部署同事在公司 Linux 上执行；
这里的东西都没有在公司服务器上跑过，验证状态见方案 §10。

## 目录

```text
deploy/supabase-selfhost/
  docker-compose.crp.yml        # Supabase 官方 compose 的覆盖层：端口收回环 + 共享网络别名
  Dockerfile.edge-runtime-cache # 预热 Edge Functions 依赖的 linux/amd64 运行时镜像
  worker.override.yml           # Worker 仅接入固定的 Supabase 网络
  worker.image.yml              # Worker 指向统一应用镜像，关闭本机构建
  docker-compose.web.yml        # 同一应用镜像以 Web 入口运行，仅回环暴露 4180
  web-server.mjs                # SPA 深链接回退与静态缓存，无额外运行时镜像
  env/
    supabase.env.nonsecret.example   # 自部署 Supabase .env 的非秘密部分
    frontend.env.selfhost.example    # 前端构建（.env.selfhost.local）
    worker.selfhost.env.example      # Worker（.docker/worker.selfhost.env）
    mcp.env.selfhost.example         # 远程 MCP（mcp/code-review-mcp/.env.selfhost.local）
  nginx/
    review.conf                 # 前端 SPA + HTTPS（含深链接回退）
    supabase.conf               # Supabase API 的 HTTPS 入口（Studio 不对外）
    http-smoke.conf             # 证书下发前临时 HTTP 冒烟，不能与上述两个 HTTPS 配置并存
    mcp.conf                    # MCP /mcp 转发（关缓冲、保留鉴权与会话头）
  systemd/
    crp-mcp.service             # MCP 常驻（EnvironmentFile，不依赖 node --env-file）
  scripts/
    preflight.sh                # 目标服务器环境自检（只读）
    apply-migrations.sh         # release 临时检出 + 数据库增量迁移 + Edge Functions
    release.sh                  # 日常总发布：迁移/Functions + Worker drain + Web
    build-edge-runtime-cache.sh # 构建并推送预热 Functions 依赖的 linux/amd64 镜像
    backup.sh                   # 数据库 + Storage + 配置 + Session 卷备份（只读）
    restore-verify.sh           # 恢复到**临时库**做验证，不碰在服务的库
```

## 顺序

```text
0. preflight.sh                 → 把 ❌ 全部解决或在方案里写明替代做法
1. 官方发行版 + 生成密钥         → 方案 §9.B
2. .env 合并 nonsecret 模板 + docker-compose.crp.yml → sh run.sh start
3. 配置 Functions 运行时变量 → 方案 §7.4
4. scripts/apply-migrations.sh --dry-run，确认后 --apply → 迁移 + Functions
5. 建管理员 / MCP 专用 REVIEWER / 普通账号；配模型、Git 身份、Skill
6. CI 每个 release 只构建一个统一应用镜像；Linux 用同一 digest 分别启动 Worker 与 Web → Nginx 反向代理到 4180
7. Worker：worker.selfhost.env + worker.override.yml + worker.image.yml，1 副本
8. MCP：mcp.env.selfhost.local + systemd + nginx（mcp.conf）
9. backup.sh → restore-verify.sh → 服务器重启验收
```

## 日常发布（V1.50）

CI 成功后会给出一个统一应用镜像。日常发布只需要在公司 Linux 的
`/home/kduser/crp/app` 执行总脚本；它不会构建镜像，使用的就是 CI 已推送的镜像。

首次拿到 V1.50 时，先把包含脚本的 release 同步一次：

```bash
cd /home/kduser/crp/app
git pull --ff-only origin release
```

随后先预览，再确认真实发布。`--dry-run` 不改数据库、Functions、Web 或 Worker；`--apply`
会先同步 release，脚本本身有更新时自动以新版本重新执行。首次可能要求输入一次 GitLab 凭据，
迁移阶段仍由 Supabase CLI 交互确认。未传 `--image` 时，脚本会查询 Nexus 的精确应用组件，自动选择
最大的 `release_时间戳` 标签；不会选择同仓库的 `/cache` 镜像。

```bash
# 自动选择 Nexus 最新 release_ 时间戳镜像。
bash deploy/supabase-selfhost/scripts/release.sh --dry-run

# 自动选择并执行完整发布。
bash deploy/supabase-selfhost/scripts/release.sh --apply

# 先预览本次 release 的 SQL 迁移与 Function 差异。
bash deploy/supabase-selfhost/scripts/release.sh --dry-run \
  --image 'mirrors.kingdee.com/kingdee/lingee/patch/kwork-code-review:release_<构建号>'

# 确认预览后执行完整发布。
bash deploy/supabase-selfhost/scripts/release.sh --apply \
  --image 'mirrors.kingdee.com/kingdee/lingee/patch/kwork-code-review:release_<构建号>'
```

若需要固定发布某一次流水线制品，则显式传 `--image`。自动查询失败时，交互终端会提示粘贴镜像地址；
非交互调用必须显式传 `--image`。自动模式只比较 CI 使用的 `release_数字时间戳` 标签，不按 Nexus 页面
更新时间排序。

迁移和总发布脚本会将自身的锁文件描述符从 Git 子进程中关闭；Git 的内存凭据缓存守护进程因此不会在
脚本结束后继续占用发布锁。若曾运行旧版本脚本且提示“另一轮迁移正在运行”，可以执行
`git credential-cache exit` 清掉仅内存中的 Git 登录缓存，然后重试；下一次 Git 操作会重新要求登录。

真实发布顺序固定为：同步 `release` → 增量 SQL → Edge Functions → 拉统一镜像 → Worker
排空并更新 → Web 更新 → 本机健康检查。默认启动 **4 个 Worker，每个并发处理 2 条需求任务**（最多 8 条，仍受模型并发限额约束）。
公司 `worker.override.yml` 明确设置 `WORKER_STORY_CONCURRENCY=2`，覆盖旧 env 文件中的 1；
不需要手改密钥文件。发布检查要求全部 4 个副本均启动且并发为 2 才通过。
Worker 有在途任务时会停止领取新任务并等待其自行结束，
不会强制中断；默认最多等 3600 秒，可传 `--worker-timeout <秒>` 调整。成功后，脚本将当前和上一次
应用镜像写入 `/home/kduser/crp/last-release.env`，文件不包含任何密钥。

总脚本不会改 Nginx、TLS 证书、浏览器运行时配置或 Worker 环境文件；这些是机器配置，不能被一次
应用发布覆盖。数据库迁移仅前滚，应用镜像回退也不会自动回滚已执行的 SQL 或 Functions。

迁移与 Function 子步骤由仓库内的 `deploy/supabase-selfhost/scripts/apply-migrations.sh` 提供，
`release.sh --apply` 会在发布过程中自动调用它。之前单独放在公司 Linux
`/home/kduser/crp/apply-migrations.sh` 的副本不再作为日常入口。每次运行时，子脚本在 `/tmp`
下临时拉取 GitLab `release` 分支的 `supabase/`，运行结束（包括失败）就删除临时检出；不再维护持久的
`migration-source`。Git 内存缓存让 clone 与稀疏检出的请求共用 GitLab 凭据
（缓存 30 分钟，不写密码文件）。随后使用 `/home/kduser/crp/supabase/.env` 中的数据库口令生成仅指向 `127.0.0.1:54342`
的连接串。默认只预览；`--apply` 会再预览一次，由 CLI 交互确认数据库迁移，然后复制变更的
Function 目录、重启容器并测试两个必需函数。Function 加载失败会恢复旧文件，但已经成功的
数据库迁移不会回滚。脚本不运行 seed、`db reset` 或云端 linked 项目。发布前确保脚本本身
已被同步到公司 Linux。

### 离线 Edge Functions 镜像

公司 Linux 不需要在 Function 启动或首次调用时访问 `jsr.io`、`esm.sh`、npmjs。覆盖层已把
`functions` 服务固定为公司的缓存镜像：

```text
kcr.kingdee.com/ai-2030/supabase:edge-runtime-v1.76.2-crp-r3
```

它在构建阶段真实加载官方分发器和三个项目 Function，把 Deno 的 JS、类型定义和 NPM 元数据写进
镜像缓存；运行时仍从 `volumes/functions/` 挂载 Function 源码。因此普通的 SQL/Function 发布无需
重新构建镜像。只有新增 Function 或新增/升级远程依赖时，才重建一个新标签并更新
`docker-compose.crp.yml` 的 `functions.image`。

官方 compose 原本还会挂载一个名为 `deno-cache` 的 Docker 卷到 `/root/.cache/deno`。覆盖层通过
`volumes: !override` 移除了这个卷；否则空卷会盖住镜像内已预热的缓存，Functions 会再次尝试访问公网。

在已登录 KCR 的构建机上执行以下命令创建新标签；`CRP_SUPABASE_DOCKER_DIR` 指向此前下载的
官方 `self-hosted/v0.8.2` 的 `docker/` 目录。脚本会把 Functions 暂存到系统临时目录，构建完成
即删除，不会把它们提交到镜像的运行时源码目录。

```bash
CRP_SUPABASE_DOCKER_DIR=/Users/kingdee/crp-selfhost/supabase-source/docker \
  bash deploy/supabase-selfhost/scripts/build-edge-runtime-cache.sh \
  edge-runtime-v1.76.2-crp-r4
```

首次在 Linux 使用此镜像：

```bash
cd /home/kduser/crp/supabase
docker compose pull functions
docker compose up -d --no-deps --force-recreate functions
docker compose ps functions
```

这只重建 Functions 容器，不会重新执行数据库迁移，也不会影响其他 Supabase 服务。

## 三个最容易踩的点

**Compose 版本。** `docker-compose.crp.yml` 用 `ports: !override` 把 Supabase 的 8000
收到 `127.0.0.1:54341`。Compose < 2.24.4 时 `!override` 不生效，ports 会**合并**，
结果是 8000 仍然暴露在 `0.0.0.0` —— 部署看起来成功，实际上公司网里谁都能直连数据库 API。
`preflight.sh` 会检查这一条。

**前端运行时配置。** 当前公司 DevOps 的通用构建服务没有 Docker build args，因此前端镜像不写入
`VITE_*` 值。镜像带有空的 `public/runtime-config.js`；Linux 把真实的 `runtime-config.js` 只读挂载到
容器里。改 Supabase 浏览器地址、anon key 或 Linky 地址时，只改这个 Linux 文件并重启 Web 容器，不需要
重新构建镜像。它会发送给浏览器，所以只能写公开的 anon key，绝不能放 service-role key、数据库密码、GitLab
Token 或模型 API key。

**统一应用镜像运行。** Worker 与前端共用同一个 release 镜像摘要：Worker 保持默认启动命令，
Web 服务通过 Compose 把命令改成 `node web-server.mjs`。两者仍是两个独立容器，因此可以分别查看日志、
重启和扩容；只是只需要一条流水线产出和一次镜像拉取。两个服务都只加入既有的
`crp-selfhost-net`，不会创建自动分配的 Docker 默认网络。Web 只绑定 `127.0.0.1:4180`；公司浏览器
经宿主机 Nginx 的 HTTPS 域名访问。首次创建浏览器配置后，用同一个 `CRP_APP_IMAGE` 部署：

```bash
mkdir -p /home/kduser/crp/web
cp deploy/supabase-selfhost/env/frontend.runtime-config.js.example \
  /home/kduser/crp/web/runtime-config.js
chmod 644 /home/kduser/crp/web/runtime-config.js
# 编辑 /home/kduser/crp/web/runtime-config.js：填正式 Supabase HTTPS 地址与 .env 中的 ANON_KEY

export CRP_APP_IMAGE='mirrors.kingdee.com/kingdee/lingee/patch/kwork-code-review@sha256:<digest>'
export CRP_WEB_RUNTIME_CONFIG=/home/kduser/crp/web/runtime-config.js

docker compose -p crp-selfhost-web -f deploy/supabase-selfhost/docker-compose.web.yml up -d
WORKER_ENV_FILE=.docker/worker.selfhost.env \
  docker compose -p crp-selfhost-worker \
    -f docker-compose.worker.yml \
    -f deploy/supabase-selfhost/worker.override.yml \
    -f deploy/supabase-selfhost/worker.image.yml \
    up -d --no-build --scale worker=1
```

**流水线先测连通，再发布。** `scripts/pipeline-deploy.py` 的默认 `tcp-check` 只检查 DevOps
执行器能否解析并连接目标 Linux `172.18.54.40:22` 的 SSH 端口。当前 DevOps 节点界面不能
设置变量，所以该只读探测目标暂时写在脚本内；它不登录、不传密码、不改服务器。通过后再由受保护
SSH/JumpServer 凭据执行单独的身份校验，最后才开放人工审批后的迁移、Functions、Worker 与前端发布。

**容器里的 localhost 不是宿主机。** Worker 与 MCP 若作为容器运行，Supabase 地址用
`http://crp-supabase-api:8000`（本目录的 override 提供的别名）；Mac 上那套
`host.docker.internal` 在 Linux 上不存在。反之，若 MCP 作为宿主机 systemd 进程运行，
用 `http://127.0.0.1:54341`。

## 备份与恢复

```bash
sudo -u crp bash deploy/supabase-selfhost/scripts/backup.sh
# 把 /srv/crp/backups/<时间戳>/ 复制到独立位置（含密钥，按密钥对待）
bash deploy/supabase-selfhost/scripts/restore-verify.sh /srv/crp/backups/<时间戳>
```

三件事是实测踩出来的，不是设计洁癖：

**必须用 `supabase_admin` 导出和恢复。** 自部署里的 `postgres` **不是 superuser**
（`rolsuper=f`）。用它恢复会报 `permission denied for table secrets` —— 那是 Vault，
也就是**模型 API Key 恢复不出来**。实测：`postgres` 恢复 2 errors，`supabase_admin` 0 errors。
用 `DB_SUPERUSER=` 可以改，但改之前脚本会先检查它是不是 superuser。

**`roles.sql` 只核对、绝不执行。** `pg_dumpall --roles-only` 里是 `CREATE ROLE` /
`ALTER ROLE ... PASSWORD` / `GRANT` 这类**集群级**语句，灌进在服务的集群会改掉现有角色的
口令与成员关系。脚本只解析它、列出角色、检查目标集群是否已具备。真正要灌角色的场合只有
"全新空集群"，那一步由人工确认目标后执行。
（它仍然必须备份：只 dump 一个库、在新集群恢复会缺 `authenticated` / `service_role`，
**RLS 直接失效**，而那种恢复看起来是成功的。）

**不吞恢复错误。** `ON_ERROR_STOP=0` + `|| true` 会让一份丢了密钥的备份"验证通过"。
脚本把 pg_restore 的错误全量打印并判定失败，核对项里也包含 `vault_secrets` 计数。

`restore-verify.sh` 只往新建的临时库恢复，拒绝把 `CHECK_DB` 设成 `postgres` / `template*` /
`_supabase`，并在"恢复目标＝备份来源同一集群"时明确提示。整机重建时"起新实例再灌备份"那一步
不写进脚本：它需要先确认目标，手滑一次不可回头。

两个脚本都不执行 `docker compose down -v`、不 drop 业务库、不 `db reset`。

## 证书下发前的 HTTP 冒烟

DNS 已分配 `crp-review.kingdee.com` 与 `crp-supabase.kingdee.com`。证书未到位时，可临时在公司内网通过 HTTP 验证链路，不能用于登录、上传或正式使用。

1. Linux 先确认公司网络允许访问 80 端口；DNS 记录中显示 443 不代表 80 一定已开放。
2. 只安装 `http-smoke.conf`，不要同时安装 `review.conf`、`supabase.conf`：

```bash
sudo install -D -m 644 deploy/supabase-selfhost/nginx/snippets/crp-supabase-proxy.conf \
  /etc/nginx/snippets/crp-supabase-proxy.conf
sudo install -m 644 deploy/supabase-selfhost/nginx/http-smoke.conf \
  /etc/nginx/conf.d/crp-http-smoke.conf
sudo nginx -t && sudo systemctl reload nginx
```

3. 把 `env/frontend.runtime-config.http-smoke.js.example` 复制为 Linux 的 `/home/kduser/crp/web/runtime-config.js`，仅填写 Supabase `.env` 的 `ANON_KEY`，然后重启 Web 容器。访问：

```text
http://crp-review.kingdee.com
```

4. 证书下发后，删除 `/etc/nginx/conf.d/crp-http-smoke.conf`，恢复 `review.conf` 与 `supabase.conf`，并把 `runtime-config.js` 的 API 地址改回 `https://crp-supabase.kingdee.com`。
