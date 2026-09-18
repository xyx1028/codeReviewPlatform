# skill-bundle-admin

受管 DSH Skill Bundle 的上传、校验、发布与下载服务（V1.6，方案 §6.1 / §14 / §15）。

## 为什么需要一个 Edge Function

上传链路上有三件事**不能**交给浏览器：

1. **解析归档并生成 manifest。** manifest 决定 `bundle_hash`，而 `bundle_hash` 是 Job
   冻结的身份。让浏览器算它等于让上传方定义"这个 Bundle 是什么"。
2. **决定正式对象 key。** 正式 key 是 `<skill-id>/versions/<version>/<archive-sha256>.zip`。
   浏览器能决定 key 就能覆盖一个已发布版本。
3. **持有 service-role。** `skill-bundles` 是私有 bucket，普通 `authenticated`
   没有任何 SELECT/INSERT/UPDATE/DELETE 策略。

## 动作

| action | 谁调用 | 做什么 |
|---|---|---|
| `create-skill` | 管理页 | 创建技能身份（name 一旦创建不可改） |
| `create-upload` | 管理页 | 注册一次 staging 上传，返回短期 signed upload token |
| `validate` | 管理页 | service-role 下载 staging ZIP → 安全解析 → 落库校验结果与文件树 |
| `publish` | 管理页 | 写不可变正式对象 → 落不可变版本行 → 清理 staging |
| `set-enabled` | 管理页 | 启用 / 停用（只影响**新** Job） |
| `create-download-url` | 管理页 | 已发布 Bundle 的短期 signed path（仅 ADMIN；浏览器用公开 Supabase origin 补全） |

浏览器直接上传到 staging（用 `create-upload` 返回的 token），**不**上传到正式 key。

## 安全约束

- 只接受已登录且 `user_profile.role = 'ADMIN'` 的调用者；角色由 service-role 直查，
  不依赖 RLS 细节，也不相信 JWT 里的自定义 claim。
- 不接受浏览器自报的 bucket / key / hash / manifest。数据库还会用
  `public.skill_bundle_hash()` 对服务端生成的 manifest **再算一次** —— 于是
  "库里的 bundle_hash 等于 manifest 的规范 hash"是一条结构性事实。
- 正式对象 `upsert: false`：已发布对象永不覆盖。
- signed path（含 token）只走响应体：不落库、不进日志，永远不作为冻结 locator；
  Function 不返回由内部 `SUPABASE_URL` 拼出的 origin。
- 日志只记事件与非敏感计数（文件数、字节数、是否含脚本）；键名命中
  `key|secret|token|authorization|password|url` 的字段被直接丢弃。

## SKILL.md frontmatter 是发布前置条件

dsh 的 `skill-filesystem` 缺 frontmatter 时只写一行 `logger.warn` 就忽略整个技能 —— 一个
**没有任何平台错误码的静默失败**。所以 `validate` 会强制：

- 第一行是 `---`，且有闭合的 `---`；
- frontmatter 里 `name` 等于平台技能名、`description` 非空；
- 只接受平铺 `key: value`（缩进 / 嵌套结构直接拒，因为"能解析"不等于"我们知道它意味着什么"）；
- 拒绝 `disableModelInvocation` / `modelInvocable` / `userInvocable` 这类 dsh 会抛错的旧式键；
- 拒绝 `disable-model-invocation: true`（模型是这个平台唯一的技能消费者）。

`description` 与 `whenToUse` 由 `publish` 从落库的 frontmatter 取，**不接受**调用方另给
一段文字：那会让库里的文本与 dsh 渲染给模型的文本分叉。所以 `publish` 的请求体里没有
这两个字段。

## 与 Worker 的关系

Worker **不用**这个函数，也不用 signed URL。它按 claim-fenced RPC
（`get_story_task_skill_snapshot`）拿到冻结 locator，用 service-role 直接下载，并
**独立重算** `archive_sha256` 与 `bundle_hash`。两条路径故意不共享代码：共享就只剩
一次判断，"三层 hash"会退化成同一个声明被抄了三遍。

对应实现：`worker/src/ai/skills/`。

## 部署

```bash
# 需要 JWT 校验（默认行为），不要用 --no-verify-jwt。
supabase functions deploy skill-bundle-admin

# CORS 白名单：逗号分隔，绝不通配 '*'。本地端口始终兼容。
supabase secrets set ALLOWED_ORIGINS="https://your-app.example.com"
```

`SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` 由平台注入，
不需要手工配置。

## 前置迁移

`supabase/migrations/20260917100000_managed_dsh_skill_bundles.sql`：它创建表、私有
bucket、RLS、不可变触发器，以及本函数依赖的全部 `admin_*` RPC（仅授权 `service_role`）。

## 容量上限

与 SQL 的 `public.skill_bundle_limits()` 和 Worker 的
`worker/src/ai/skills/skill-limits.ts` 是同一组数字：单包 10 MiB 归档 / 50 MiB 展开 /
200 entry / 单文件 10 MiB / `SKILL.md` 64 KiB / 深度 8 / 路径 240 字节 / 压缩比 20:1 /
校验 30 秒。任何超限 fail closed 并返回稳定错误码，不静默截断。
