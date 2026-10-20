# Linux 配置定位与已知部署快照

最近整理：2026-10-20。事实来源：用户提供的 Linux 发布／Nginx 输出、Mac 网络测试及项目当前脚本。下文注明已确认和待执行事项；登录状态、TLS、镜像标签和文件数量可能变化，排障时重新验证。

## 新对话先恢复的进度

- **最近已在线确认（2026-10-20，用户完整 Linux 发布日志）**：代码 `27a8056`、镜像 `release_202610201021209` 完成统一发布；数据库已是最新，三个 Functions 无变化；4 个旧 Worker 全部排空后重建，每副本并发 2 并恢复领取任务，Web、MCP 健康检查通过，成功写入 `last-release.env`。这是启动／健康证据，不等于 Linky 或完整评审的业务验收。
- **已确认入口（2026-10-19，用户 Linux／Mac 输出）**：MCP `http://crp-review.kingdee.com/mcp` 已经由 Nginx 转发；服务器 `/healthz` 返回 `status=ok`，Mac 请求域名 `/mcp` 未带令牌得到 MCP 的 JSON 401。证明入口可达并拒绝匿名，不证明已通过带令牌握手或真实评审。
- **当前进度（2026-10-20）**：Linky 地址修正已完成上述正式发布，但用户随后提供“用户故事”页持续转圈的截图，业务验收未通过。只读检查线上 runtime-config 的 Linky 覆盖为空，实际 JS 已包含新域名且没有旧地址。新域名跨组列表第 1、2 页均超过 25 秒超时；指定“工具开发组”约 0.7 秒返回 200。不要重新误判成旧域名或重新运行地址替换。
- **本地待发布修复 V1.57**：按用户“做分页”的要求，看板改为真正的 page/page_size 分页（默认每页 20 条），不连续预取 12 页；请求含正文设置 15 秒超时，并可直接输入完整项目组名称查询。导入页保留原按组勾选逻辑；候选读取仅一页、不阻塞已选组。前端 272 项测试、类型检查、构建及版本校验通过；尚未提交／构建／Linux 发布，也未做新版本浏览器交互验收。下一步应用户提交、CI、统一发布再验证；旧 `27a8056` 的发布成功不能当成 V1.57 已上线。分页不能证明上游单次聚合已经变快，超时时仍需按组查询或上游优化。
- **发布前不能漏**：检查 Linux 前端 runtime-config、Worker env、MCP env 是否写死旧 Linky 地址。修正命令在仓库 `deploy/supabase-selfhost/README.md` 的“Linky 旧域名修正（2026-10-20）”小节；仅改默认值和更新镜像不会覆盖这些机器文件。确认后再 dry-run、apply。

## 机器、代码与目录

| 项目 | 当前约定或最后确认值 |
|---|---|
| 机器 / 用户 | `v-agentcon-env` / `kduser`，宿主机 IP 最后确认为 `172.18.54.40` |
| 访问方式 | 公司跳板机终端；网络故障时使用 IT 资产页面的虚拟机控制台 |
| GitLab 仓库 | `https://git.kingdee.com/kwork-code-review/kwork-code-review.git`，`release` 分支 |
| Mac 项目路径 | `/Users/kingdee/codeReviewPlatform` |
| Linux 应用工作树 | `/home/kduser/crp/app` |
| Supabase 安装目录 | `/home/kduser/crp/supabase` |
| 统一发布脚本 | 应用工作树内 `deploy/supabase-selfhost/scripts/release.sh` |
| 正式迁移/Functions 子脚本 | 应用工作树内 `deploy/supabase-selfhost/scripts/apply-migrations.sh` |
| 浏览器运行时配置 | `/home/kduser/crp/web/runtime-config.js`，只允许客户端公开配置 |
| Worker 秘密配置 | `/home/kduser/crp/app/.docker/worker.selfhost.env` |
| MCP 秘密配置 | `/home/kduser/crp/app/.docker/mcp.selfhost.env`；正式发布自动初始化并保留凭证 |
| Supabase 秘密配置 | `/home/kduser/crp/supabase/.env` |
| Supabase CLI | `/home/kduser/.local/bin/supabase`；曾安装 v2.117.0，当前版本需查询 |
| 最近成功发布记录 | `/home/kduser/crp/last-release.env`（只有镜像/代码/时间等非秘密项） |
| Functions 实际源目录 | `/home/kduser/crp/supabase/volumes/functions/` |
| Storage 实际源目录 | 通常为 Supabase `volumes/storage/`，最终看 storage 容器挂载 |

旧 `/home/kduser/crp/apply-migrations.sh` 和 `migration-source` 是早期手动副本/检出，日常入口已改为仓库内 release.sh。参考模板部分写 `/srv/crp`，不是本机器的真实部署目录。

不要 `source` 官方 Supabase `.env`：有带空格的值，曾导致 `Organization: command not found`；按需使用现有脚本的解析器，且不输出密钥。密钥值、GitLab token、数据库密码不放进 Skill，也不让用户整份贴出 env。

## Compose、网络和端口

| 服务 | Compose 项目 / 容器 | 入口 |
|---|---|---|
| Supabase | `crp-selfhost` / `supabase-db`、`supabase-envoy`、`supabase-edge-functions` 等 | 宿主机 API `127.0.0.1:54341` → 网关容器 `8000` |
| Worker | `crp-selfhost-worker` / `crp-selfhost-worker-worker-1` 到 `-4` | 无入站端口，访问 `http://crp-supabase-api:8000` |
| Web | `crp-selfhost-web` / `crp-selfhost-web-web-1` | `127.0.0.1:4180` → 容器 `8080` |
| MCP | `crp-selfhost-mcp` / `crp-selfhost-mcp-mcp-1` | `127.0.0.1:8848` → 容器 `8848`；首次发布后才存在 |
| Session pooler | Supabase `supavisor` / `supabase-pooler` | `127.0.0.1:54342` → `5432` |
| Transaction pooler | 同上 | `127.0.0.1:54343` → `6543` |

- 共享网络 `crp-selfhost-net`，Linux 已确认 subnet `10.255.0.0/24`；Worker / Web / MCP 只加入这一现有 external 网络。
- 禁止在普通重发时另建自动分配的 default bridge：172.x 曾与公司路由冲突导致跳板机断连。增加 network 要先确认公司批准的地址段，而不是自动再分一个 172.x。
- Linux 实际 `docker-compose.crp.yml` 手工补过 ipam 和公司镜像映射。仓库同名模板没有完整复刻这些机器配置，不能整份复制覆盖。模板或注释不能当成当前运行证据。
- `worker.override.yml` 的 `environment.WORKER_STORY_CONCURRENCY="2"` 优先于旧 env 文件中的 1；发布脚本 `worker_replicas=4`。
- Worker 使用三个 Compose：根 `docker-compose.worker.yml`、`deploy/supabase-selfhost/worker.override.yml`、`deploy/supabase-selfhost/worker.image.yml`。后者通过 `CRP_APP_IMAGE` 禁用 build，重启时不能忘记网络覆盖层。
- MCP 使用 `deploy/supabase-selfhost/docker-compose.mcp.yml`。`scripts/bootstrap-mcp.py` 通过本机 Auth API 创建或复用 `crp-mcp-system@internal.invalid`（REVIEWER，显示名“MCP 系统账号”），自动生成密码和调用凭证，默认 `glm5.3-flash` 解析为配置 id；原凭证不轮换、不输出。无新 SQL 迁移，service-role key 不进入 MCP 容器。历史 systemd 示例的 `/srv/crp/app` 路径不是当前实际目录，也不应与容器同时监听 8848。
- Supabase env 已配置 `COMPOSE_PROJECT_NAME=crp-selfhost` 和 `COMPOSE_FILE=docker-compose.yml:docker-compose.crp.yml`，在 Supabase 目录执行 `docker compose`。

## 域名与 Nginx

最后用户实际使用：前端 `http://crp-review.kingdee.com`，API `http://crp-supabase.kingdee.com`；公司内网/VPN访问。HTTPS 证书当时仍待申请，后续须查询，不能擅自改成 HTTPS 或添加跳转。

Nginx 在宿主机按 Host 分流，同一监听端口可以服务两个域名：前端到 `127.0.0.1:4180`，API 到 `127.0.0.1:54341`。只转发允许的 Supabase API 前缀，不公开 Studio 根路径。模板在项目 `deploy/supabase-selfhost/nginx/`；已安装配置目录用 `sudo nginx -T` 确认，不能猜 conf.d/sites-enabled 是否存在。

- 用户 2026-10-19 的 `nginx -T` 确认活动站点为 `/etc/nginx/sites-enabled/crp-http-smoke`；修改前用 `readlink -f` 确认实际文件。主配置 `/etc/nginx/nginx.conf`；Supabase 转发片段 `/etc/nginx/snippets/crp-supabase-proxy.conf`。
- 现有前端站点里已增加 `location = /mcp` → `http://127.0.0.1:8848`，保留 Authorization、Mcp-Session-Id，请求使用 HTTP/1.1、关闭缓冲与缓存、读写超时 3600 秒。不要安装仓库 `mcp.conf` 中的示例独立域名／HTTPS 站点去覆盖当前入口。
- 用户已执行 `nginx -t` 和 `systemctl reload nginx`，配置备份目录 `/home/kduser/crp/nginx-backups/`。这里的精确匹配只包含 `/mcp`，不要自动认为 `/mcp/` 或域名 `/healthz` 已转发。
- MCP 采用 Bearer 调用凭证，保存在机器 `.docker/mcp.selfhost.env` 的 `CRP_MCP_TOKENS`；当前实现无自动过期，正常重启和发布保留原值。只记录位置及轮换状态，绝不记录实际值。曾建议更换用户公开粘贴过的凭据，尚未收到轮换完成的证据。

## Linky 当前接口与调用路径

- 新基础地址：`https://linky.kingdee.com/quality-platform/api/linky`；帮助页为该地址加 `/stories/help`。基础地址不带 `/stories` 或 `/help`；HTTPS 默认端口 443。
- 旧入口：`https://feature.kingdee.com:2055/quality-platform/api/linky`。2026-10-19 实测列表返回 HTTP 400，正文为上游 `401 invalid token`；这说明当时旧取数服务访问上游被拒绝，不足以证明 token 本身过期，也不能推断新入口同样故障。
- 2026-10-20 Mac 实测新入口：无调用方 token 的列表、指定工作区列表、真实故事详情及附件列表均 HTTP 200。帮助页明确调用方不验权，数据来自服务端配置的 Linky 账号范围。无需把 MCP Bearer 令牌传给它。
- 浏览器实时列表：`src/lib/linky-live.ts` 直接从使用者电脑请求；`runtime-config.js` 中 `linkyApiBaseUrl` 优先于构建变量 `VITE_LINKY_API_BASE_URL` 和代码默认值。因此页面故障不能直接归因于 Linux Worker。
- 正式导入：前端提交 `request_linky_batch_import`，Linux Worker 按 `LINKY_API_BASE_URL` 获取并冻结正文／附件。MCP 提交前的只读核对使用 `CRP_LINKY_API_BASE_URL`。三者分别检查，不能只修浏览器。
- Mac 的容器 DIRECT 和本机 MCP Node fetch 曾不通；本地 Worker 容器沿用 HOST_PROXY 后新入口列表、详情、附件列表成功。Mac 的代理需求不能直接套到 Linux，Linux 新入口可达性尚待确认；不擅改网络模式、路由、证书验证。

## 镜像与凭据配置

- 应用统一镜像仓库：`mirrors.kingdee.com/kingdee/lingee/patch/kwork-code-review`；新构建的 Web、Worker 和 MCP 使用同一镜像，以不同启动命令运行。旧标签在构建时未包含 MCP，首次发布必须选含 MCP 的新产物。
- 当前自动选择实现：Nexus `/service/rest/v1/search`，repository=`docker-hosted`，name 精确匹配 `kingdee/lingee/patch/kwork-code-review`，从返回结果中过滤 `release_` 加 15 位数字并取最大值；不选 `/cache` 和凭空假设的 `release-current`。
- 当前脚本没有遍历 Nexus continuationToken；标签增长、返回分页或多流水线时，应核对产物并显式指定 `--image`，不能保证“最新标签”一定对应刚提交的代码。
- Functions 基础镜像：`kcr.kingdee.com/ai-2030/supabase:edge-runtime-v1.76.2-crp-r3`，含离线 Deno/npm 依赖缓存。只改 Function 代码无需重建基础镜像；新增/变更未缓存外部依赖时才需要重新构建预热镜像。
- `.env` 保存 `POSTGRES_PASSWORD`、`ANON_KEY`、`SERVICE_ROLE_KEY` 等，Worker env 保存服务端密钥和 GitLab 配置。前端配置只放 `supabaseUrl`、公开 anon key、微信开关、Linky 地址，不能放 service role 或数据库密码。
- 模型密钥通过平台模型管理写入 Linux 的 Vault，不应直接复用云端密文或复制进前端。

## 只读检查示例（Linux）

```bash
hostname
cat /home/kduser/crp/last-release.env

docker ps --filter label=com.docker.compose.project=crp-selfhost-worker \
  --format '{{.Names}} {{.Status}}'

docker network inspect crp-selfhost-net \
  --format '{{range .IPAM.Config}}{{.Subnet}}{{end}}'

curl -fsS --max-time 5 http://127.0.0.1:4180/__health
```

检查某个副本的任务并发只输出这个非秘密值：

```bash
docker exec crp-selfhost-worker-worker-1 node -e \
  'console.log(process.env.WORKER_STORY_CONCURRENCY)'
```

Auth 健康检查不带 apikey 可能返回 401，不能据此认定服务故障。不要通过输出 env 来取密钥发给对话。

## 历史完成情况（不是未来默认值）

- 2026-10-20 用户完整日志确认：代码 `27a8056`，镜像 `mirrors.kingdee.com/kingdee/lingee/patch/kwork-code-review:release_202610201021209`，五步发布均完成。Supabase CLI 的更新提示是信息，日志中没有阻塞发布的错误。
- 2026-10-19 用户完整日志确认：代码 `28ae61d`、镜像 `release_202610191618029`，MCP 系统账号／默认模型检查及 Worker、Web、MCP 更新通过；之后另行配置并验证 Nginx 的 `/mcp` 入口。
- 2026-10-19 用户日志确认：代码 `4d9e50a`，镜像 `release_202610190952146`，旧四副本已排空，新的四副本各并发 2，Worker 启动检查和 Web 健康检查通过。此时没有实际技能重新上传成功的后续证据。
- 此前导入云端数据库：核对用户 17、用户资料 17、批次 4、需求 58、Storage 元数据 25。实际文件当时尚未迁移：review-files 14、skill-bundles 7、story-attachments 4；Vault 未导出。用户随后开始手工补模型密钥和上传技能，不能说这些缺项永远未完成，需检查当前状态。
- 数据导入跳过四张空的新版 Auth 表和 4 条 one_time_tokens；原 SQL 与兼容副本在 Linux `/home/kduser/crp/cloud-import-20261016-051535`，Mac 原导出在 `/Users/kingdee/crp-cloud-export`。这只是历史恢复产物，日常发布绝不再次清表导入。
