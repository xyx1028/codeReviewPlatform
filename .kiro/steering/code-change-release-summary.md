---
inclusion: always
---

# 代码改动完成后的发布操作摘要（强制）

每次完成任何代码改动并准备向用户报告结果时，最终回复必须包含一个简短的 **“需要你执行”** 区块。必须包含“提交代码、Supabase 数据库、Edge Function、Worker 镜像、Worker 更新”五项。

必须逐项明确本次是否需要以下操作，使用 `需要` 或 `不需要`，不得含糊。凡标记为“需要”，必须在该项下给出**本次实际可复制执行的完整命令**；禁止使用 `<函数名>`、`...`、`按实际情况替换` 等占位表达：

```text
需要你执行：
- 提交代码：需要 / 不需要
  - 需要时：给出本次精确的 git add -- <实际修改文件> 和 git commit -m "<实际提交说明>" 命令
- Supabase 数据库：需要 / 不需要
  - 需要时：supabase db push
- Edge Function：需要 / 不需要
  - 需要时：直接给出本次实际函数的完整命令，例如 `supabase functions deploy admin-model-config`
- Worker 镜像：需要 / 不需要重建
  - 需要时：docker compose -f docker-compose.worker.yml build worker
- Worker 更新：需要 / 不需要
  - 需要时：先确认没有在途任务；数据库迁移必须先于 Worker 更新。
  - 给出本次实际的更新命令，例如：npm run worker:release -- --scale 4
```

规则：
- 只有实际修改了 `supabase/migrations/**`、数据库 RPC/RLS/策略时，才写“Supabase 数据库：需要”。
- 只有实际修改了 `supabase/functions/<name>/**` 时，才写对应的 Function 部署命令；未改 Function 时必须明确写“不需要”。
- 修改了 `worker/**`、`Dockerfile.worker`、`docker-compose.worker.yml` 或会进入 Worker 镜像的 Worker 依赖/构建配置时，必须写“Worker 镜像：需要重建”和“Worker 更新：需要”。
- 纯前端改动必须明确写三项均“不需要”。
- 云端发布、迁移、Function 部署或 Worker 重启未获用户明确要求时，AI 只列清单，绝不代为执行。
- 若本次尚未完成代码或本地验证未完成，不得给出“可以发布”的结论；应明确写“当前无需执行，待本地验证完成后再给最终清单”。
