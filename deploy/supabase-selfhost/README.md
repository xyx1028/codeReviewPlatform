# 内网自部署（V1.48）模板与脚本

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
  worker.override.yml           # Worker 接入 Supabase 的 compose 网络、1 副本
  env/
    supabase.env.nonsecret.example   # 自部署 Supabase .env 的非秘密部分
    frontend.env.selfhost.example    # 前端构建（.env.selfhost.local）
    worker.selfhost.env.example      # Worker（.docker/worker.selfhost.env）
    mcp.env.selfhost.example         # 远程 MCP（mcp/code-review-mcp/.env.selfhost.local）
  nginx/
    review.conf                 # 前端 SPA + HTTPS（含深链接回退）
    supabase.conf               # Supabase API 对外入口（Studio 不对外）
    mcp.conf                    # MCP /mcp 转发（关缓冲、保留鉴权与会话头）
  systemd/
    crp-mcp.service             # MCP 常驻（EnvironmentFile，不依赖 node --env-file）
  scripts/
    preflight.sh                # 目标服务器环境自检（只读）
    apply-migrations.sh         # GitLab release 更新 + 数据库增量迁移 + Edge Functions
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
6. npm run build:selfhost → dist/ 发到 nginx（review.conf）
7. Worker：worker.selfhost.env + worker.override.yml，1 副本
8. MCP：mcp.env.selfhost.local + systemd + nginx（mcp.conf）
9. backup.sh → restore-verify.sh → 服务器重启验收
```

将更新脚本固定放在公司 Linux 的 `/home/kduser/crp/apply-migrations.sh`。每次运行时，脚本在
`/tmp` 下临时拉取 GitLab `release` 分支的 `supabase/`，运行结束（包括失败）就删除临时检出；
不再维护持久的 `migration-source`。Git 内存缓存让 clone 与稀疏检出的请求共用 GitLab 凭据
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

**构建时写死的前端配置。** `VITE_*` 是 `vite build` 时写进产物的。换域名或换 anon key
之后必须重新 `npm run build:selfhost` 并重新发布 `dist/`；改服务器上的 `.env` 不会生效，
页面还会连旧地址。

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
