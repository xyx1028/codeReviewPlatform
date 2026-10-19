---
name: crp-linux-release
description: 指导代码评审平台 codeReviewPlatform 在公司 Linux 上的日常发布、部署配置定位与故障排查。用户问流水线构建后运行什么、忘记统一发布脚本或 Linux 路径、Worker 四副本并发、Functions 或 Storage 部署问题时使用；不用于其他项目或首次云端数据搬迁。
---

# 代码评审平台：公司 Linux 统一发布

帮助用户继续维护已经部署的 CRP 平台。使用中文、短说明和可直接粘贴的 Linux 命令；用户常通过跳板机手动执行，容易忘记路径和操作顺序。

## 先识别目标和信息来源

- 项目检出：本机 `/Users/kingdee/codeReviewPlatform`；公司 Linux 工作目录 `/home/kduser/crp/app`。从当前检出定位下面文件，不要求每个对话都在固定 Mac 路径。
- 用户只问“下一步运行什么”时，给下方命令即可。解释设置或排障时，再读 [environment.md](references/environment.md) 或 [troubleshooting.md](references/troubleshooting.md)，不要一次要求几十项检查。
- 先核对当前仓库的 [release.sh](../../../deploy/supabase-selfhost/scripts/release.sh) 和相关覆盖层。参考文件中的历史部署成功是用户日志证据，不等于今天机器仍处于相同状态。没有远程连接时，让用户在 Linux 运行必要命令并提供输出，不能把 Mac Docker 当成远程 Linux。
- 本 Skill 本身不授权提交、推送或生产发布。遵循用户当前明确授权；已授权的下一步不重复索要许可。通常由用户自行提交/推送并在 Linux 执行，AI 修改代码和解释结果。

## 日常入口

前提：用户已提交/推送 GitLab `release`，对应的 CI 应用镜像已构建成功。流水线只构建镜像；K8s 部署节点不负责这台 Linux 的 Docker Compose。

让用户在 `kduser@v-agentcon-env` 的宿主机终端执行（跳板机 SSH 和虚拟机控制台都可操作同一机器；不是在某个业务容器内部执行）：

```bash
cd /home/kduser/crp/app

git pull --ff-only origin release && \
bash deploy/supabase-selfhost/scripts/release.sh --dry-run
```

预览成功后执行：

```bash
bash deploy/supabase-selfhost/scripts/release.sh --apply
```

若需要严格对应某次 CI、自动查询选到了旧标签，或仓库查询失败，在 **两条命令中使用同一个** `--image '完整镜像引用'`，从实际 CI 产物复制，不从构建号猜地址。不要把历史成功标签固定为以后发布的默认值。

脚本内部的 clone / fetch 使用 30 分钟内存 Git 凭据缓存，不写明文凭据；初始 `git pull` 仍可能独立提示登录。提示用户名/密码时需用户在终端输入，不索取聊天中的密码。

## 实际动作与边界

按当前实现解释：

1. 省略 `--image` 时查询 Nexus；正式发布再同步 GitLab release，脚本变化时用新脚本继续执行。
2. 调用仓库内 `apply-migrations.sh`，临时检出 release 的 `supabase/`，先预览再增量执行迁移，使用本机自部署数据库；复制有变化的 Function 目录，重启并做加载检查，退出时删除临时检出。
3. 拉取同一应用镜像供 Worker / Web 使用。
4. drain 全部旧 Worker，等待在途任务自然结束（默认最多 3600 秒，可用 `--worker-timeout` 调整），重建 **4 个副本、每副本同时处理 2 条需求任务**；最大任务容量 8 仍受模型并发上限和任务条件限制，不能称为固定 8 个系统线程。
5. 检查全部四个 Worker 的启动日志和实际并发配置；更新 Web、检查 `127.0.0.1:4180/__health`；成功后记录 `/home/kduser/crp/last-release.env`。

`--dry-run` 不同步应用工作树、不改数据库/Functions/容器/镜像，但仍联网查询、临时拉取代码并可能请求 Git 登录。此前的 `git pull` 会更新工作树。

脚本不是数据搬迁或备份工具：不复制云端业务记录、Storage 实际文件、Vault 密钥；不改 Nginx/TLS/运行时配置或含秘密的 env 文件。SQL 迁移不会因后续失败自动回滚，Function 部署失败仅恢复本轮 Function 文件。不要承诺平台发布失败会整体回滚。

## 成功后该怎么说

日志出现 `发布完成`、四副本检查和 Web 健康通过后，报告实际代码/镜像与启动检查结果。再让用户刷新平台验证本次功能（例如原始 Mac/Windows 技能 ZIP 的检测、发布和一次新评审）。健康检查通过不代表模型、附件、GitLab 或完整评审已验证。

只出现 `Started`、`worker_started` 或配置校验通过，不能直接说整个评审平台功能都正常。

## 配置和故障路由

- 路径、端口、网络、域名、密钥文件位置、最近已知部署：读 [environment.md](references/environment.md)。
- 锁占用、路由冲突、Function 离线依赖、缺文件、上传失败：读 [troubleshooting.md](references/troubleshooting.md)，先给一个有区分力的检查，按第一条真实错误继续。
- 修改 Worker/Functions 或发布行为时，使用项目现有 `worker-supabase-local-validation`；新增功能同时遵守 `feature-execution-document` 和版本同步要求。单纯回答发布命令不必重复执行本地构建。
- 首次搬迁云端数据库属于单独任务：先审计目标和导出内容，再制定迁移；不能用日常 `release.sh` 或旧的清表命令直接恢复。
