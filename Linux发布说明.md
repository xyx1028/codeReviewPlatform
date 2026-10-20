# 镜像构建完成后的 Linux 发布命令

适用：代码已推送到 GitLab `release` 分支，对应 CI 应用镜像已构建并推送成功。
在 `kduser@v-agentcon-env` 的 Linux 宿主机终端执行。

## 1. 直接发布

```bash
cd /home/kduser/crp/app
git pull --ff-only origin release && \
bash deploy/supabase-selfhost/scripts/release.sh --apply
```

**直接正式发布，不需要先预览，也不需要指定镜像。** 脚本默认查询 Nexus，选择应用仓库中最新的 `release_` 时间戳镜像。核对日志中的代码版本和镜像是否符合本次构建。

统一脚本会同步 `release`、执行增量数据库迁移、更新有变化的 Functions、拉取镜像，排空旧 Worker 后更新 4 个 Worker（每个副本并发处理 2 条需求任务），随后更新 Web、MCP 并做健康检查。等待 Worker 在途任务结束时可能耗时较长，默认最多等待 3600 秒。数据库迁移如提示确认，核对列表后按提示操作。

## 2. 确认结果

检查终端是否出现“发布完成”，以及 Worker、Web、MCP 检查是否通过。成功记录保存在：

```bash
cat /home/kduser/crp/last-release.env
```

然后刷新平台，验证本次修改的实际功能。健康检查通过仅说明服务启动检查通过。

## 常见提示

- GitLab 提示 `Username` / `Password`：在终端输入有效凭据，输入密码时没有字符回显是正常的。若使用个人访问令牌，在 `Password` 处输入有仓库读取权限的令牌；不要将凭据写进本文件或发到聊天。
- `HTTP Basic: Access denied`：认证失败，检查用户名及凭据后重试当前步骤。
- Supabase CLI 提示有新版本：仅更新提示不代表发布失败，查看是否存在实际错误。
- 默认镜像查询失败、选到旧标签或确实需要固定某次 CI 产物时，才在发布命令中追加 `--image 'CI产物的完整镜像地址'`，不要猜测或沿用历史标签。

发布脚本：`deploy/supabase-selfhost/scripts/release.sh`。线上配置和排障背景见 [.codex/skills/crp-linux-release/SKILL.md](.codex/skills/crp-linux-release/SKILL.md)。
