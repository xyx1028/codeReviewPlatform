---
name: crp-linux-release
description: 代码评审／代码审核平台 codeReviewPlatform 的线上设计、部署拓扑、访问链路、配置、发布和故障上下文。用户询问该平台的线上情况时使用；维护可跨对话恢复的线上配置及待办，随已确认的变更同步更新。与其他项目或纯本地业务实现无关。
---

# 代码评审平台：线上配置与公司 Linux 发布

帮助用户继续维护已经部署的 CRP 平台。使用中文、短说明和可直接粘贴的 Linux 命令；用户常通过跳板机手动执行，容易忘记路径和操作顺序。

## 用户约定：每次线上问题都先读，随配置变更维护

- 用户问到本平台线上设计、服务职责、调用链、配置位置、域名、运行状态、发布或排障时，都先使用本 Skill；不要只在用户提到“Linux 发布”时触发。
- 新对话先读本入口，再从 [environment.md](references/environment.md) 恢复相关配置、最近确认记录和未完成事项。用户只问下一条命令时，给一个步骤，不一次要求整套诊断。
- 线上配置、部署流程或状态变更后，在同一任务结束前同步更新相关参考；若工作方式或触发范围变化，再更新本入口／UI 元数据。只更新有新证据的条目，保持单一正文，不另复制一份技能。
- 记录确认日期与来源（当前源码、本机测试、用户 Linux 输出或远程只读检查）。明确区分“配置约定”“已在线验证”“已改代码／待部署”“尚不确定”；构建成功不代表上线，旧部署记录不代表今天仍正常。
- 若只是提出方案或给出命令、尚未收到执行结果，记录为待执行；收到用户结果后再更新状态。不能承诺后台监控或自动获知用户在别处的更改。
- 只记录地址、路径、字段名和脱敏检查结论，不保存密码、token、service-role key、用户会话或完整 env。凭据生成／读取与凭据已经轮换是不同事件，不能混记。
- 项目规则 `AGENTS.md` 指向此技能；用户级 `~/.codex/skills/crp-linux-release` 链接指向当前项目技能，方便新对话发现。换机器或链接失效时以当前检出为准恢复，不假设链接永远有效。

## 先识别目标和信息来源

- 项目检出：本机 `/Users/kingdee/codeReviewPlatform`；公司 Linux 工作目录 `/home/kduser/crp/app`。从当前检出定位下面文件，不要求每个对话都在固定 Mac 路径。
- 用户只问“下一步运行什么”时，先看是否有待处理配置（例如 Linky 旧地址尚未替换），再给下方合适的一步。解释设置或排障时，再读 [environment.md](references/environment.md) 或 [troubleshooting.md](references/troubleshooting.md)，不要一次要求几十项检查。
- 先核对当前仓库的 [release.sh](../../../deploy/supabase-selfhost/scripts/release.sh) 和相关覆盖层。参考文件中的历史部署成功是用户日志证据，不等于今天机器仍处于相同状态。没有远程连接时，让用户在 Linux 运行必要命令并提供输出，不能把 Mac Docker 当成远程 Linux。
- 本 Skill 本身不授权提交、推送或生产发布。遵循用户当前明确授权；已授权的下一步不重复索要许可。通常由用户自行提交/推送并在 Linux 执行，AI 修改代码和解释结果。

## 日常入口

工程根目录的 [Linux发布说明.md](../../../Linux发布说明.md) 保存可直接复制的日常发布命令；用户明确要求直接正式发布，默认不指定镜像，无需先预览。

前提：用户已提交/推送 GitLab `release`，对应的 CI 应用镜像已构建成功。流水线只构建镜像；K8s 部署节点不负责这台 Linux 的 Docker Compose。

让用户在 `kduser@v-agentcon-env` 的宿主机终端执行（跳板机 SSH 和虚拟机控制台都可操作同一机器；不是在某个业务容器内部执行）：

```bash
cd /home/kduser/crp/app

git pull --ff-only origin release && \
bash deploy/supabase-selfhost/scripts/release.sh --apply
```

若需要严格对应某次 CI、自动查询选到了旧标签，或仓库查询失败，在 **两条命令中使用同一个** `--image '完整镜像引用'`，从实际 CI 产物复制，不从构建号猜地址。不要把历史成功标签固定为以后发布的默认值。

脚本内部的 clone / fetch 使用 30 分钟内存 Git 凭据缓存，不写明文凭据；初始 `git pull` 仍可能独立提示登录。提示用户名/密码时需用户在终端输入，不索取聊天中的密码。

## 实际动作与边界

按当前实现解释：

1. 省略 `--image` 时查询 Nexus；正式发布再同步 GitLab release，脚本变化时用新脚本继续执行。
2. 先校验 Worker/Web 配置，再运行 `bootstrap-mcp.py`。dry-run 只预览；apply 通过本机 Auth API 创建或复用 MCP 专用 REVIEWER 系统账号、生成并保留本地随机凭证，默认 `glm5.3-flash` 解析成准确模型 id，最后校验 MCP Compose。账号和密码不用手填；不把 service-role key 写进 MCP 配置，不索取或输出凭证。同名非托管账号、托管账号密码遗失或角色被管理员修改时停止，不强行重置。
3. 调用仓库内 `apply-migrations.sh`，临时检出 release 的 `supabase/`，先预览再增量执行迁移，使用本机自部署数据库；复制有变化的 Function 目录，重启并做加载检查，退出时删除临时检出。
4. 拉取同一应用镜像供 Worker / Web / MCP 使用。
5. drain 全部旧 Worker，等待在途任务自然结束（默认最多 3600 秒，可用 `--worker-timeout` 调整），重建 **4 个副本、每副本同时处理 2 条需求任务**；最大任务容量 8 仍受模型并发上限和任务条件限制，不能称为固定 8 个系统线程。
6. 检查全部四个 Worker 的启动日志和实际并发配置；更新 Web、检查 `127.0.0.1:4180/__health`；更新 MCP 独立容器，检查 `127.0.0.1:8848/healthz` 与容器健康状态；成功后记录 `/home/kduser/crp/last-release.env`。

`--dry-run` 不同步应用工作树、不改数据库/Functions/容器/镜像，但仍联网查询、临时拉取代码并可能请求 Git 登录。此前的 `git pull` 会更新工作树。首次 MCP 对外访问还需 Nginx 正确转发 `/mcp`；本机健康检查不证明客户端已能从公司网络访问。

脚本不是数据搬迁或备份工具：不复制云端业务记录、Storage 实际文件、Vault 密钥；不改 Nginx/TLS、浏览器配置或 Worker env。MCP env 的缺失默认项由初始化补齐，已有身份及凭证保留。SQL 迁移不会因后续失败自动回滚，Function 部署失败仅恢复本轮 Function 文件。不要承诺平台发布失败会整体回滚。

## 成功后该怎么说

日志出现 `发布完成`、四副本检查和 Web 健康通过后，报告实际代码/镜像与启动检查结果。再让用户刷新平台验证本次功能（例如原始 Mac/Windows 技能 ZIP 的检测、发布和一次新评审）。健康检查通过不代表模型、附件、GitLab 或完整评审已验证。

只出现 `Started`、`worker_started` 或配置校验通过，不能直接说整个评审平台功能都正常。

## 配置和故障路由

- 路径、端口、网络、域名、密钥文件位置、最近已知部署：读 [environment.md](references/environment.md)。
- 锁占用、路由冲突、Function 离线依赖、缺文件、上传失败：读 [troubleshooting.md](references/troubleshooting.md)，先给一个有区分力的检查，按第一条真实错误继续。
- 修改 Worker/Functions 或发布行为时，使用项目现有 `worker-supabase-local-validation`；新增功能同时遵守 `feature-execution-document` 和版本同步要求。单纯回答发布命令不必重复执行本地构建。
- 首次搬迁云端数据库时也先用本技能恢复线上背景，但搬迁属于单独任务：先审计目标和导出内容，再制定迁移；不能用日常 `release.sh` 或旧的清表命令直接恢复。
