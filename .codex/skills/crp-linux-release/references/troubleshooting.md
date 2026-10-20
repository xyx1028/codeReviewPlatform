# 按第一条真实错误排查

先区分：Git 登录 / 配置预览 / 数据库迁移 / Function 加载 / Worker 排空与启动 / Web 检查 / 业务功能。不要因一次 Started 就跳过后面的错误。

## Git 或脚本找不到

- `Username for https://git.kingdee.com` 是等待交互登录，不是卡住。凭据由用户在终端输入。
- `release.sh: No such file`：确认目录为 `/home/kduser/crp/app`，检查 git 分支和拉取结果，确认脚本已随 release 提交。`~/crp/supabase` 是基础服务目录，不是应用 Git 工作树。
- dirty worktree、ff-only 失败时保护机器上的修改，不做 reset --hard 或整份覆盖机器配置来让发布继续。

## 锁占用

锁文件：应用上一级 `/home/kduser/crp/.crp-platform-release.lock` 与 `.crp-migration.lock`。

旧脚本曾让常驻 Git credential-cache 继承 FD 9，脚本退出后仍持锁约 30 分钟；当前两个脚本的 git_cached 都用 `9>&-` 防止继承。先查有无正在发布的进程，不能看见锁文件就删：

```bash
ps -ef | grep -E '[a]pply-migrations.sh|[s]upabase db push|[r]elease.sh'
```

确认不是另一轮真实发布、且符合旧凭据缓存遗留场景时，可以让用户执行：

```bash
git credential-cache exit
flock -n -E 75 /home/kduser/crp/.crp-migration.lock -c 'echo "迁移锁空闲"'
```

这只退出本用户内存 Git 凭据缓存，下次可能重新登录。返回 75 是仍有锁冲突。未解除时继续定位进程/命名空间，不删除锁文件、不任意 kill、也不反复重跑迁移。

## 网络与连接断开

创建 default bridge 后跳板机断连，且机器控制台还可登录时，先核对网络 subnet 和实际路由。172.20.30.51 曾是 last-login 的对端地址，不能据此断言它就是某个跳板机网站域名的 DNS IP。

检查 `docker network ls`、对应 network inspect、`ip route get 对端IP`，再决定是否需要恢复路由。删除网络可能有 active endpoints，需先有计划地停止对应应用；禁止把宿主机的 ens160 地址当成 Docker 网桥去改。已有网络固定为 10.255.0.0/24；普通发布不应新增 bridge。

## Functions unhealthy / 9000 connection refused

```bash
cd /home/kduser/crp/supabase
docker compose ps functions
docker logs --tail 100 supabase-edge-functions
docker inspect supabase-edge-functions \
  --format '{{range .State.Health.Log}}{{println .Output}}{{end}}'
```

已知原因：

- 原官方 main 需要公网 `jsr:@panva/jose`，Linux 不能出公网；r3 镜像预热依赖。
- 原 `deno-cache` 命名卷挂载到 `/root/.cache/deno` 会遮住镜像内缓存。保留 Functions 源码挂载，只移除缓存卷挂载；不能删整个源码目录或数据库卷。
- 历史临时 main `Deno.serve(() => new Response('Edge Functions runtime is ready'))` 虽 healthy，但所有业务路径都返回这句话，实际没加载函数。不能用它当永久修复。

只有改了外部依赖才重建缓存基础镜像；普通 Function 更新由 release 子脚本复制整个函数目录。

## Skill / Storage 下载失败

`SKILL_BUNDLE_DOWNLOAD_FAILED` 先看：

```bash
docker logs --since 15m --tail 100 supabase-storage
```

若看到文件后端 `ENOENT`，说明数据库有索引但实际 ZIP 没搬过来，不是模型密钥错误。需要原文件、原 bucket 和原路径一起恢复，或在平台发布新技能版本后让新评审选择它。直接重试冻结旧版本的历史任务可能再次失败。不要手工把文件复制到日志里的 version UUID 磁盘布局。

历史导出只有 SQL，不含 Storage 实际文件和 Vault 解密数据；导入 storage.objects 不等于附件已可读。Linux 不能访问旧云端，Mac 对旧云 Storage 曾收到 402：需先确定云端服务限制或使用经批准的手工文件迁移，而不是让 Linux 下载或重复传同一份 SQL 压缩包。

## 上传报错

- 办公安全助手明确“禁止外发”时，是安全策略证据；联系 IT 对前端和 API 域名按流程放行，不关闭安全软件或换渠道绕过。用户 2026-10-17 反馈域名拦截已由 IT 处理，后续仍需按当次证据判断。
- `entry path contains characters outside the allowed set`：V1.51 已兼容 Mac 元数据、Windows 附加文件和唯一一层外部目录。先确认新 Function 与 Worker 镜像均已部署，再查包内真实业务路径；不要每次都要求手工清理 ZIP。
- Nginx 413、CORS、HTTP 500 和 Failed to fetch 不能混为一谈。先看实际请求状态及 Functions/Storage/Nginx 对应日志。不要输出 Authorization、signed URL、文件正文或整份 env。
- 业务路径仍拒绝中文/空格、路径穿越、符号链接、ZIP64、加密和多技能混装。兼容打包元数据不意味着放开所有安全规则。

## 模型测试一直排队

API Key 显示已配置但测试 QUEUED 时，连接测试由 Worker 执行。先查 Worker 是否停止及是否有领取任务/网络错误；不要直接认定 Key 错误。若停机是迁移维护的一部分，先核对历史任务再恢复 Worker，而不是不看任务就启动。

## Linky 列表／导入失败

先读 environment.md 的 Linky 进度与地址。当前正式入口为 `https://linky.kingdee.com/quality-platform/api/linky`，不是旧 `feature.kingdee.com:2055`。

- 页面“用户故事”／“原始需求导入”的实时列表由浏览器直连；先在使用者电脑测试。正式导入失败再检查 Worker 的地址和网络模式；MCP 校验失败检查 MCP 的独立地址配置。
- 只给出“HTTP 400”不足以判断原因；用不带任何 token 的只读请求取错误正文。旧入口曾返回 `{"detail":"Linky 返回错误（401）：invalid token"}`，新入口已实测 200，不要继续把旧入口的结果当成当前新入口故障，也不要让用户把 MCP token 填给 Linky。
- 对方说“域名换了”时，逐字比较协议、域名、端口和路径。此前提供的旧 `/help` 页与页面域名完全相同；2026-10-20 新帮助页才变成 `linky.kingdee.com`。帮助页 200 不等于取数成功，应测试 `/stories`，取得真实编号后再查详情。
- 代码／镜像已更新但页面仍显示旧入口时，检查运行时挂载配置和显式 env 覆盖。先修正机器文件，再由统一发布完成 Worker 排空重建、Web 与 MCP 更新；不直接打断在途任务。
- 持续转圈也可能是全量聚合慢：2026-10-20 线上资源已确认新域名，而跨组列表第 1、2 页都超过 25 秒、单组约 0.7 秒。旧页面连续请求最多 12 页且无超时，表格是本地分页。V1.57 本地已改真实接口分页和 15 秒超时／手动按组查询，尚待发布；不要把这个问题说成发布失败、数据库异常或 token 失效。接口分页只减少前端预取，若单个上游跨组请求仍慢，需按组缩小范围或由上游优化。

只检查服务连通性、不打印业务数据的命令（确认是用户电脑还是 Linux 后再给）：

```bash
curl --noproxy '*' -sS --connect-timeout 5 --max-time 30 \
  -o /dev/null -w 'Linky：HTTP %{http_code}\n' \
  'https://linky.kingdee.com/quality-platform/api/linky/stories?page=1&page_size=1'
```

若非 200，再取响应正文区分上游业务错误、代理拒绝、CORS 与真实网络超时。Mac 成功不能替代 Linux 容器成功；不为验证连接而批量下载业务数据或重跑评审。

## 旧的权限和离线环境问题

- Worker 无法创建 `/workspace/jobs/*.lock` 且 EACCES：核对镜像运行 UID/GID 和实际命名卷所有权。不要默认改成 root 或 chmod 777。
- `nginx: command not found`：Nginx 尚未安装，不能继续猜配置目录；当前机器后来已安装，仍需以命令查询为准。
- 本机 Mac 曾对 localhost POST 出现 `UND_ERR_SOCKET` / 非 Supabase 的 `@error=resource not found`；本地解析测试通过不能冒充真实上传通过，更不能据此判断远程 Linux 同样失败。
