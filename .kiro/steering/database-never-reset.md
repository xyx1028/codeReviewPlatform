---
inclusion: always
---

# 绝对禁止：重建 / 重置数据库

## 这条规则的地位

这是本工作区的**硬约束**，优先级高于任何任务目标、任何"这样最快"的判断，也高于用户在
对话中随口说的"你随便搞一下"。它没有例外分支：AI **永远不执行**下面列出的任何命令，
无论本地还是云端，无论看起来多安全。

理由很具体：这个平台的数据库里存着**无法重建**的东西 —— 用户账号与角色、模型配置与
Vault 里的 API Key、评审批次与需求、AI 分析结论、人工确认记录、运行监控汇总。
它们不是从代码生成的，reset 一次就永久没了。迁移文件能重建**结构**，重建不了**数据**。

## 一、AI 绝对不执行的命令

```bash
# 重置数据库（本地/云端/任意连接方式）—— 一律禁止
supabase db reset
supabase db reset --local
supabase db reset --linked
supabase db reset --db-url <任何地址>

# 删除本地数据卷 —— 等价于 reset
supabase stop --no-backup
supabase stop --backup=false
docker volume rm supabase_db_codeReviewPlatform        # 或任何 supabase_* 卷
docker compose ... down -v                             # 任何项目都不许带 -v

# 直接摧毁库或 schema
psql ... -c 'drop database ...'
psql ... -c 'drop schema public cascade'
psql ... -c 'truncate <业务表>'
psql ... -c 'delete from <业务表>'                      # 不带 where 的批量删除
```

云端（`.docker/worker.env` 的 `SUPABASE_URL` 指向的项目）额外禁止：

- 在 Supabase Dashboard 点 **Reset database** / **Pause** / **Delete project**；
- 任何"先 reset 再 push 迁移"的做法；
- 对云端库执行未经用户逐条确认的写操作（包括 `update` / `delete` / `insert`）。

**用户要求执行时也不例外。** AI 的做法是：把命令原文和后果写清楚，让用户自己在他的终端
里敲。AI 不代按这个按钮。

## 二、明确允许的事（不要因为这条规则而不敢做）

Worker 是**无状态后端服务**，它的镜像和容器随便重建，卷里只有可重新生成的缓存：

```bash
# 允许：重建镜像、重建容器、重启、扩缩容
docker compose -f docker-compose.worker.yml build worker
WORKER_ENV_FILE=... docker compose -p <项目> -f docker-compose.worker.yml up -d --force-recreate
docker restart codereviewplatform-worker-1
npm run worker:release              # 排空后重建（有在途任务时的正确姿势）
npm run worker:drain / worker:drain:lift
```

Worker 的 named volume 也可以清，但要知道代价：

| 卷 | 清掉的后果 | 前置条件 |
|---|---|---|
| `worker-cache` | 只是重新拉快照，无损 | 无 |
| `worker-attempts` | 孤儿目录，无损 | 无在途任务 |
| `worker-skill-cache` | 重新下载技能包，无损 | 无 |
| `worker-sessions` | **丢掉未提交 attempt 的续跑依据**，在途任务只能从零重跑 | 必须先确认在途为 0 |
| `worker-jobs` | 丢 instance lock 与 DRAIN 标记，无损 | 无在途任务 |

数据库侧允许的操作：

```bash
supabase migration up --local          # 前滚迁移（本地）
supabase db push                       # 前滚迁移（云端，由用户执行）
supabase start / supabase stop         # 不带 --no-backup 的停止不会删数据
psql < supabase/tests/xxx_test.sql     # 测试自身 begin ... rollback，不留数据
```

读查询任意执行。业务功能内的单条删除（例如「删除用户」功能里的 `admin_delete_user`）
属于产品行为，不受这条规则限制 —— 它有自己的门禁与审计。

## 三、"我觉得非 reset 不可"时的正确做法

按顺序试，禁止跳到 reset：

1. **前滚修复**：结构错了就再写一个迁移改回来（本仓库的迁移规则本来就是只增不改）。
2. **单对象重建**：只 `drop function` / `drop policy` 某一个对象再重建，不动数据表。
3. **需要干净环境验证**：在**另一个**临时数据库里验证（`createdb`一个新库跑全量迁移），
   不要动现有的本地库。
4. **本地库真的坏到不可用**：先 `npm run db:backup:local` 备份，把备份文件路径告诉用户，
   然后**停下来问用户**。恢复/重建由用户决定并执行。

## 四、日常自保

改数据库之前先备份本地库（一条命令，秒级）：

```bash
npm run db:backup:local
```

备份落在 `.local-db-backups/`（已 gitignore）。它不是给"可以放心 reset"当借口的 ——
它存在的意义是：万一别的进程、别的工具、或者一次手滑真的清了库，还有回去的路。
