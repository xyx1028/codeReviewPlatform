---
name: supabase-migration-naming
description: 在本工作区新增或改动数据库结构、RPC、RLS 策略、Storage 策略、触发器时必须使用；规定迁移文件必须以精确到秒的 14 位 UTC 时间戳命名（同一天多个迁移靠时分秒区分先后）、既有迁移一律只增不改、以及新迁移必须可重复应用。适用于任何会往 supabase/migrations/ 落文件的任务，包括只改一个函数或补一个列的小改动。
---

# 数据库迁移命名与增改规则

本 Skill 是硬性约束，不是命名偏好。命名错了会**改变迁移的执行顺序**，"顺手改一下已有迁移"会让不同环境的数据库结构悄悄分叉。两者都不会在本地报错，只会在别的环境炸。

## 1. 什么时候触发

任何会往 `supabase/migrations/` 落文件的任务，都必须执行本 Skill：

- 新增或修改表、列、索引、约束、类型；
- 新增或修改函数 / RPC、触发器、RLS 策略、Storage bucket 与策略、授权（grant/revoke）；
- 回填或修正历史数据；
- 只是给某个既有函数加一个参数、补一个列 —— **同样触发**，小改动才最容易被顺手写进旧文件。

## 2. 硬规则 A：文件名必须是精确到秒的 UTC 时间戳前缀

```text
supabase/migrations/YYYYMMDDHHMMSS_<snake_case_描述>.sql
```

14 位必须全部是**真实的当前 UTC 时刻**，精确到秒：`YYYY`+`MM`+`DD`+`HH`+`MM`+`SS`。

时间戳一律用命令取，不要手写：

```bash
date -u +%Y%m%d%H%M%S
```

例（同一天的三个迁移，靠时分秒区分先后）：

```text
supabase/migrations/20260917100317_managed_dsh_skill_bundles.sql
supabase/migrations/20260917104502_v4_harness_manifest_r2.sql
supabase/migrations/20260917153048_model_connectivity_test_queue.sql
```

**只精确到天是错的**，哪怕后面补足 14 位：

```text
20260917000000_xxx.sql   ← 禁止：用零填充当天时间
20260917100000_xxx.sql   ← 禁止：整点凑数，不是真实时刻
20260917_xxx.sql         ← 禁止：位数不足
```

原因和四位序号同类：一天里往往要提交多个脚本，而**顺序完全由文件名字典序决定**。当天时间被填成 `000000` 或 `100000` 这类整值时，第二个迁移只能靠人猜一个"更大的整值"，一旦两次撞上同一个值，两个迁移的先后就变成了不确定的，而依赖关系（先建表、后改契约）恰恰藏在这个顺序里。

同一天多次提交的具体要求：

- **每个**迁移各自取一次 `date -u +%Y%m%d%H%M%S`，不要复用上一个迁移的时间戳再手改几位；
- 若同一批次里两个文件取到了同一秒，把后一个的秒数**加 1**，让先后关系显式写死在文件名里；
- 描述部分照旧 snake_case，不影响顺序，但要能一眼看出改了什么。

**禁止四位序号**（`0042_xxx.sql`），即使目录里还留着历史上的 `0001_`…`0041_`。

理由是机制层面的，不是风格：**迁移按字典序应用**，而 `'0' < '2'`，所以

```text
0042_v4_harness_manifest_r2.sql                ← 排在前面
20260917100317_managed_dsh_skill_bundles.sql   ← 排在后面
```

一个后写的四位序号迁移会**先于**同批次的时间戳迁移执行。本仓库真实踩到过这个坑：切换 Harness 契约哈希的迁移排到了建技能表的迁移之前，结果是"契约对上了但新 RPC 还不存在"的空档 —— 而那正是 `worker/OPERATIONS.md` §17.2 明确警告要避免的顺序。

配套要求：

- 时间戳用 **UTC**，14 位，不带分隔符，且时、分、秒都是真实值；
- 新文件名必须**严格大于**目录里现有的最大文件名（字典序），否则新迁移会插到已有迁移之前；
- 同一批次里有先后依赖时，用不同的时间戳把顺序写进文件名，不要靠"我知道该先跑哪个"。

Harness manifest 迁移用仓库自带的生成器，不要手写文件名：

```bash
# 不传参数即按当前 UTC 时间生成；它会拒绝四位序号，并做字典序守卫。
npm run harness:manifest:new-migration
```

## 3. 硬规则 B：已存在的迁移文件一律只增不改

**不要编辑 `supabase/migrations/` 里任何已经存在的文件**，哪怕只是改一个字符、补一个 `if not exists`、修一个注释错别字。

原因：迁移是**已经发生过的事实**。别的环境（云端、同事机器、CI）可能已经应用过旧版本，编辑文件不会让那些环境重新执行，只会让"文件内容"与"数据库实际状态"分叉，而且没有任何机制会发现。

要改既有对象，在**新**迁移文件里覆盖：

| 要做的事 | 正确写法 |
|---|---|
| 改函数体（签名不变） | `create or replace function public.foo(...)` |
| 改函数签名（加/删参数） | 先 `drop function if exists public.foo(<精确旧签名>);` 再 `create or replace function public.foo(<新签名>)`，然后重新 `grant` |
| 加列 | `alter table public.t add column if not exists c ...;` |
| 改约束 | `alter table public.t drop constraint if exists x, add constraint x ...;` |
| 改策略 | `drop policy if exists "n" on public.t;` 再 `create policy "n" ...` |

改签名时必须显式 `drop`：`create or replace` **改不了签名**，它会创建一个**新的重载**，留下一条不带新校验的旧调用路径。那条路径就是绕过新约束的后门。

**禁止 destructive down migration。** 回滚靠"再写一个前进的迁移"，不靠反向删除已发生的事实。

## 4. 硬规则 C：新迁移必须可重复应用

同一个文件可能在开发机上被应用多次（改完再跑一遍），所以它必须幂等：

- 建表用 `create table if not exists`；
- 建索引用 `create index if not exists`；
- 建策略先 `drop policy if exists`；
- 函数用 `create or replace`（改签名时先 `drop ... if exists`）。

**最容易漏的一条**：`create table if not exists` 对**已存在**的表什么都不做——写在建表语句里的新列不会被加上。所以新列必须单独显式声明：

```sql
create table if not exists public.t ( ... );

-- `create table if not exists` 对已存在的表是 no-op，所以新列必须显式 alter。
alter table public.t
  add column if not exists new_col jsonb;
```

本仓库真实踩到过：`review_skill_upload` 加 `entry_frontmatter` 时只写在建表语句里，重复应用后列没出现，直到 SQL 测试报 `column "entry_frontmatter" does not exist` 才发现。

## 5. 配套：测试与验证

每个新迁移应有同名测试：

```text
supabase/tests/<迁移文件名去掉 .sql>_test.sql
```

例：`supabase/tests/20260917100317_managed_dsh_skill_bundles_test.sql`（时间戳与迁移逐字相同，包含时分秒）。

写法沿用 `supabase/tests/` 现有约定：`begin;` … `rollback;` 包住，用 `pg_temp.assert(...)` 断言，不依赖 pgTAP。

必须实际跑通，不能只写不跑：

```bash
# 应用迁移
psql -v ON_ERROR_STOP=1 -f supabase/migrations/<新迁移>.sql
# 跑测试（自身 rollback，不留数据）
psql -v ON_ERROR_STOP=1 -f supabase/tests/<新迁移>_test.sql
```

再额外验证一次**从零应用**：在一个事务里先 drop 掉本迁移创建的对象、再整份应用、最后 `rollback`。这能抓住"只有在我这台机器的既有状态下才跑得通"的迁移。

## 6. 环境边界：先确认改的是哪个库

应用迁移前必须先确认目标库，不要假设。本仓库有两套：

- 本地 Supabase 容器（`supabase_db_*`）；
- 云端项目（Worker 的 `SUPABASE_URL` 指向它）。

**Worker 用的可能不是你验证的那个库。** 真实发生过：迁移全部应用在本地容器上并验证通过，而 Docker Worker 连的是云端项目，云端连表都没有，于是新 Worker 拒绝所有新 Job。

确认方法：读 `.docker/worker.env` 的 `SUPABASE_URL`，或在 Worker 容器里 `printenv SUPABASE_URL`。

**对云端/共享库应用迁移是难以回退的动作，必须先取得用户明确同意**，并说明：目标项目、要跑的文件与顺序、在途任务数、失败后的处置。

## 7. 完成检查

提交前逐项确认：

- 新迁移文件名是 14 位 UTC 时间戳前缀，时分秒取自 `date -u +%Y%m%d%H%M%S` 的真实值，没有 `000000` / `100000` 这类凑整值；
- 同一天的多个迁移各有不同的秒级时间戳，先后顺序与实际依赖一致；
- 新文件名字典序大于目录里现有全部文件；
- `git status supabase/migrations/` 里**只有 `??`（新增），没有任何 `M`（修改）**；
- 既有对象的变更是在新文件里 `create or replace` / `drop ... if exists` 覆盖的，旧迁移一字未动；
- 改过签名的函数重新 `grant`/`revoke` 过，且没有留下旧重载（可用 `pg_proc` 计数断言）；
- 新列用显式 `alter table ... add column if not exists` 声明，不只写在 `create table if not exists` 里；
- 整份迁移可重复应用，且"从零应用"验证过；
- 有对应的 `supabase/tests/*_test.sql` 并实际跑通；
- 明确说清改的是本地库还是云端库；动云端前已获得用户同意。
