-- V1.6：受管的 DSH Skill Bundle（管理、冻结、注入）
--
-- 这份迁移建立四件事，缺任何一件"技能供给链"都不成立：
--
--   1. **身份与不可变版本**：`review_skill` 保存技能身份与状态，`review_skill_version`
--      保存**已发布且不可变**的版本（locator + 三层 hash + 规范 manifest）。
--   2. **受控上传态**：`review_skill_upload` 是 staging 校验结果的落点。没有它，
--      "先 validate 再 publish"就必须让浏览器把 manifest/hash 自报回来 —— 而 §15
--      明确禁止相信浏览器提交的 bucket/key/hash。
--   3. **Job 冻结**：`analysis_job_skill_snapshot` 把创建 Job 那一刻"全部已发布且启用"
--      的版本复制成快照，`analysis_job.skill_catalog_hash` 是这份集合的身份。
--      管理员之后发布 V2 或停用技能，只影响新 Job。
--   4. **调用审计**：`analysis_skill_invocation` 记录哪个 Agent 在什么时候加载了哪个
--      不可变版本，不记录 Bundle 正文。
--
-- 关键取舍：
--
--   * **归档字节不进数据库。** ZIP 存专用私有 bucket `skill-bundles`，数据库只存
--     bucket/key/hash。signed URL 是短期凭据，永远不作为冻结 locator。
--   * **catalog / bundle hash 用行式规范格式，不用 jsonb::text。** Postgres 的
--     `jsonb::text` 会渲染成 `{"a": 1}`（带空格、键按长度排序），而 JS 的
--     `JSON.stringify` 渲染成 `{"a":1}`。两侧各自序列化必然对不上，而"Worker 必须
--     独立重算"这条要求两侧算出同一个值。所以规范格式是显式的行式文本（见
--     `skill_bundle_hash_input` / `skill_catalog_hash`），SQL 与 TypeScript 都能
--     逐字节复现。
--   * **历史 Job 固定为空技能目录。** 已存在的 `analysis_job` 拿到
--     `skill_snapshot_version = 0` 与 empty catalog hash，重启后不会突然加载后来
--     发布的技能。

------------------------------------------------------------------------------
-- 1. 规范 hash 与命名工具
------------------------------------------------------------------------------

-- 技能名：kebab-case，作为 `<DSH_HOME>/skills/<name>/` 的目录名，所以不能出现任何
-- 路径字符。这里是唯一的准入闸门，前端提示不算。
create or replace function public.is_valid_skill_name(p_name text)
returns boolean
language sql
immutable
as $$
  select p_name is not null
     and p_name ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
     and length(p_name) between 2 and 64;
$$;

comment on function public.is_valid_skill_name(text) is
  'kebab-case only. The name becomes a directory under the per-attempt DSH_HOME, so '
  'dots, slashes and uppercase are rejected at the door.';

/*
 * 单个 Bundle 的规范 hash 输入。
 *
 * 只包含"内容身份"：schema 版本、技能名、入口、以及按路径排序的
 * (path, sha256, sizeBytes, mediaType, role)。刻意不含 ZIP entry 顺序、mtime、
 * Unix mode 和压缩参数 —— 同一份逻辑文件集合用不同压缩参数打包两次，bundle_hash
 * 必须相同，否则 Worker 的 cache 命中率会被打包器的随机性摧毁。
 */
create or replace function public.skill_bundle_hash_input(p_manifest jsonb)
returns text
language sql
immutable
as $$
  select 'skill-bundle-v1' || E'\n'
      || 'schemaVersion=' || coalesce(p_manifest->>'schemaVersion', '1') || E'\n'
      || 'skillName=' || coalesce(p_manifest->>'skillName', '') || E'\n'
      || 'entry=' || coalesce(p_manifest->>'entry', 'SKILL.md') || E'\n'
      || coalesce(
           (
             select string_agg(
               (file->>'path') || E'\t' || (file->>'sha256') || E'\t'
                 || (file->>'sizeBytes') || E'\t' || (file->>'mediaType') || E'\t'
                 || (file->>'role') || E'\n',
               '' order by (file->>'path') collate "C"
             )
             from jsonb_array_elements(coalesce(p_manifest->'files', '[]'::jsonb)) as file
           ),
           ''
         );
$$;

create or replace function public.skill_bundle_hash(p_manifest jsonb)
returns text
language sql
immutable
as $$
  select 'sha256:' || encode(sha256(public.skill_bundle_hash_input(p_manifest)::bytea), 'hex');
$$;

/*
 * 全技能目录的规范 hash。
 *
 * 输入是 `[{name, version, bundleHash, archiveSha256}, ...]`，按 name 排序后逐行拼接。
 * 顺序由 name 决定而不是由插入顺序决定：同一集合无论怎样枚举都必须得到同一个
 * catalog hash，否则"所有 Story Task 共用同一个 catalog hash"这条无从验证。
 */
create or replace function public.skill_catalog_hash(p_entries jsonb)
returns text
language sql
immutable
as $$
  select encode(
    sha256(
      (
        'skill-catalog-v1' || E'\n'
        || coalesce(
             (
               select string_agg(
                 (entry->>'name') || E'\t' || (entry->>'version') || E'\t'
                   || (entry->>'bundleHash') || E'\t' || (entry->>'archiveSha256') || E'\n',
                 '' order by (entry->>'name') collate "C"
               )
               from jsonb_array_elements(coalesce(p_entries, '[]'::jsonb)) as entry
             ),
             ''
           )
      )::bytea
    ),
    'hex'
  );
$$;

-- 空目录的 hash 是一个常量，但必须由同一个函数算出来，不能手抄一个字面量：
-- 手抄的那份一旦与函数不一致，历史 Job 与新 Job 的"空目录"就成了两个不同的身份。
create or replace function public.empty_skill_catalog_hash()
returns text
language sql
immutable
as $$
  select public.skill_catalog_hash('[]'::jsonb);
$$;

------------------------------------------------------------------------------
-- 2. 容量上限（方案 §8）
--
-- 上限写成函数而不是散落的字面量：校验服务、发布事务和冻结逻辑必须用同一组数字，
-- 三处各写一份的结果是"上传通过了但冻结时炸掉"。
------------------------------------------------------------------------------

create or replace function public.skill_bundle_limits()
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'archiveBytes', 10 * 1024 * 1024,
    'expandedBytes', 50 * 1024 * 1024,
    'entryCount', 200,
    'fileBytes', 10 * 1024 * 1024,
    'entryFileBytes', 64 * 1024,
    'pathDepth', 8,
    'pathBytes', 240,
    'compressionRatio', 20,
    'validateMs', 30000,
    'catalogBundles', 50,
    'descriptionChars', 500,
    'catalogRenderBytes', 32 * 1024,
    'catalogArchiveBytes', 100 * 1024 * 1024,
    'catalogExpandedBytes', 256 * 1024 * 1024
  );
$$;

------------------------------------------------------------------------------
-- 3. review_skill / review_skill_version / review_skill_upload
------------------------------------------------------------------------------

create table if not exists public.review_skill (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check (public.is_valid_skill_name(name)),
  display_name text not null check (btrim(display_name) <> ''),
  status text not null default 'DRAFT'
    check (status in ('DRAFT', 'VALIDATING', 'PUBLISHED', 'DISABLED', 'VALIDATION_FAILED')),
  current_version_id uuid,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.review_skill is
  'Skill identity and lifecycle. Never bound to a project, module, repository or code '
  'path in V1.6: every published+enabled skill is frozen into every new job.';

create table if not exists public.review_skill_version (
  id uuid primary key default gen_random_uuid(),
  skill_id uuid not null references public.review_skill(id) on delete restrict,
  version integer not null check (version >= 1),
  description text not null check (btrim(description) <> ''),
  when_to_use text,
  archive_bucket text not null default 'skill-bundles'
    check (archive_bucket = 'skill-bundles'),
  archive_object_key text not null,
  archive_sha256 text not null check (archive_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  archive_size_bytes bigint not null check (archive_size_bytes > 0),
  bundle_hash text not null check (bundle_hash ~ '^sha256:[0-9a-f]{64}$'),
  bundle_manifest jsonb not null,
  expanded_size_bytes bigint not null check (expanded_size_bytes > 0),
  file_count integer not null check (file_count >= 1),
  contains_scripts boolean not null default false,
  published_by uuid references auth.users(id) on delete set null,
  published_at timestamptz not null default now(),
  unique (skill_id, version),
  unique (archive_bucket, archive_object_key)
);

comment on table public.review_skill_version is
  'Immutable published versions. Rows and the archive object they point at can never '
  'change once a job snapshot references them.';

create index if not exists idx_review_skill_version_skill
on public.review_skill_version(skill_id, version desc);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'review_skill_current_version_fk'
  ) then
    alter table public.review_skill
      add constraint review_skill_current_version_fk
      foreign key (current_version_id)
      references public.review_skill_version(id) on delete restrict;
  end if;
end $$;

/*
 * staging 上传的校验结果。
 *
 * 它存在的唯一理由是：`validate` 与 `publish` 是两次 HTTP 调用，而 publish 绝不能
 * 相信浏览器把上一步算出的 manifest/hash 再报回来。校验结果必须落在服务端，publish
 * 只按 upload id 取用。
 *
 * 这些行是短命的：`expires_at` 之后由保留期任务连同 staging 对象一起清理。
 */
create table if not exists public.review_skill_upload (
  id uuid primary key default gen_random_uuid(),
  skill_id uuid not null references public.review_skill(id) on delete cascade,
  uploaded_by uuid references auth.users(id) on delete set null,
  staging_bucket text not null default 'skill-bundles'
    check (staging_bucket = 'skill-bundles'),
  staging_object_key text not null unique,
  status text not null default 'PENDING'
    check (status in ('PENDING', 'VALIDATED', 'FAILED', 'CONSUMED', 'EXPIRED')),
  archive_sha256 text check (archive_sha256 is null or archive_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  archive_size_bytes bigint check (archive_size_bytes is null or archive_size_bytes > 0),
  bundle_hash text check (bundle_hash is null or bundle_hash ~ '^sha256:[0-9a-f]{64}$'),
  bundle_manifest jsonb,
  /*
   * 入口文件解析出来的 frontmatter（`{name, description, whenToUse?}`）。
   *
   * 它是 description 的**唯一可信来源**：dsh 的 `skill-filesystem` 读的就是 `SKILL.md`
   * 的 frontmatter，所以让管理员在发布页另外敲一段 description 必然产生两个真相 ——
   * 目录页显示 A、模型看到 B，而且没有任何机制会发现。发布时由 RPC 从这里取值。
   */
  entry_frontmatter jsonb,
  expanded_size_bytes bigint,
  file_count integer,
  contains_scripts boolean not null default false,
  error_code text,
  error_message text,
  created_at timestamptz not null default now(),
  validated_at timestamptz,
  expires_at timestamptz not null default now() + interval '24 hours'
);

create index if not exists idx_review_skill_upload_skill
on public.review_skill_upload(skill_id, created_at desc);

-- `create table if not exists` 对已存在的表什么都不做，所以新列必须显式 alter。
-- 这一句让迁移可以在"表已建、列后加"的环境里重复执行 —— 那正是开发机的常态。
alter table public.review_skill_upload
  add column if not exists entry_frontmatter jsonb;

create index if not exists idx_review_skill_upload_expiry
on public.review_skill_upload(expires_at)
where status in ('PENDING', 'VALIDATED', 'FAILED');

------------------------------------------------------------------------------
-- 4. 不可变性：已发布版本禁止改写
------------------------------------------------------------------------------

create or replace function public.review_skill_version_is_immutable()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'UPDATE' then
    -- 一个字段都不许改。"只改 description 应该没关系"是错的：description 进入
    -- catalog hash 的渲染预算，也进入 Job 快照，改它等于让已冻结的 Job 目录漂移。
    raise exception 'SKILL_VERSION_IMMUTABLE';
  end if;
  if tg_op = 'DELETE' then
    if exists (
      select 1 from public.analysis_job_skill_snapshot snapshot
      where snapshot.source_version_id = old.id
    ) then
      raise exception 'SKILL_OBJECT_REFERENCED';
    end if;
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists review_skill_version_immutable on public.review_skill_version;
create trigger review_skill_version_immutable
before update or delete on public.review_skill_version
for each row execute function public.review_skill_version_is_immutable();

------------------------------------------------------------------------------
-- 5. Job 冻结快照
------------------------------------------------------------------------------

create table if not exists public.analysis_job_skill_snapshot (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.analysis_job(id) on delete cascade,
  source_skill_id uuid not null references public.review_skill(id) on delete restrict,
  source_version_id uuid not null references public.review_skill_version(id) on delete restrict,
  source_version integer not null check (source_version >= 1),
  name text not null,
  description text not null,
  when_to_use text,
  archive_bucket text not null check (archive_bucket = 'skill-bundles'),
  archive_object_key text not null,
  archive_sha256 text not null,
  archive_size_bytes bigint not null check (archive_size_bytes > 0),
  bundle_hash text not null,
  bundle_manifest jsonb not null,
  expanded_size_bytes bigint not null check (expanded_size_bytes > 0),
  file_count integer not null check (file_count >= 1),
  contains_scripts boolean not null default false,
  created_at timestamptz not null default now(),
  unique (job_id, name)
);

comment on table public.analysis_job_skill_snapshot is
  'Frozen per-job copy of every published+enabled skill version. Recovery reads this, '
  'never the currently published set: a restarted worker must rebuild the same tree.';

create index if not exists idx_analysis_job_skill_snapshot_job
on public.analysis_job_skill_snapshot(job_id, name);

create index if not exists idx_analysis_job_skill_snapshot_version
on public.analysis_job_skill_snapshot(source_version_id);

-- 快照同样不可变：Job 一旦冻结，目录只能整体作废（随 Job 删除），不能局部改写。
create or replace function public.analysis_job_skill_snapshot_is_immutable()
returns trigger
language plpgsql
as $$
begin
  raise exception 'SKILL_VERSION_IMMUTABLE';
end;
$$;

drop trigger if exists analysis_job_skill_snapshot_immutable
on public.analysis_job_skill_snapshot;
create trigger analysis_job_skill_snapshot_immutable
before update on public.analysis_job_skill_snapshot
for each row execute function public.analysis_job_skill_snapshot_is_immutable();

------------------------------------------------------------------------------
-- 6. 调用审计
------------------------------------------------------------------------------

create table if not exists public.analysis_skill_invocation (
  id bigserial primary key,
  agent_run_id uuid not null references public.analysis_agent_run(id) on delete cascade,
  agent_node_id uuid references public.analysis_agent_node(id) on delete set null,
  skill_snapshot_id uuid references public.analysis_job_skill_snapshot(id) on delete set null,
  skill_name text not null,
  skill_version integer,
  bundle_hash text not null,
  /* 只允许安全的规范相对路径（资源读取），绝不存资源正文。 */
  resource_relative_path text,
  invoked_at timestamptz not null default now()
);

comment on table public.analysis_skill_invocation is
  'Which agent loaded which immutable bundle when. Never stores SKILL.md text, '
  'resource bytes, script bodies or signed URLs.';

create index if not exists idx_analysis_skill_invocation_run
on public.analysis_skill_invocation(agent_run_id, invoked_at);

create index if not exists idx_analysis_skill_invocation_snapshot
on public.analysis_skill_invocation(skill_snapshot_id);

------------------------------------------------------------------------------
-- 7. 现有表扩列
------------------------------------------------------------------------------

alter table public.analysis_job
  add column if not exists skill_catalog_hash text,
  add column if not exists skill_snapshot_version integer not null default 0,
  add column if not exists skill_bundle_count integer not null default 0,
  add column if not exists skill_archive_bytes bigint not null default 0,
  add column if not exists skill_expanded_bytes bigint not null default 0;

-- 历史 Job 固定为空目录。这一句是 §17「历史 Job」的全部实现：不写它，旧 Job 的
-- catalog hash 是 null，Worker 无从判断"该 Job 就是没有技能"与"该 Job 的目录丢了"。
update public.analysis_job
set skill_catalog_hash = public.empty_skill_catalog_hash()
where skill_catalog_hash is null;

alter table public.analysis_job
  alter column skill_catalog_hash set default public.empty_skill_catalog_hash();

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'analysis_job'
      and column_name = 'skill_catalog_hash' and is_nullable = 'YES'
  ) then
    alter table public.analysis_job alter column skill_catalog_hash set not null;
  end if;
end $$;

alter table public.analysis_agent_run
  add column if not exists skill_catalog_hash text;

alter table public.analysis_session_checkpoint
  add column if not exists skill_catalog_hash text;

-- §16 调用审计：扩展现有工具审计的白名单字段，不新增 Broker 路由。
alter table public.analysis_tool_audit
  add column if not exists skill_snapshot_id uuid
    references public.analysis_job_skill_snapshot(id) on delete set null,
  add column if not exists skill_name text,
  add column if not exists skill_bundle_hash text,
  add column if not exists resource_relative_path text;

-- §16 运行汇总。
alter table public.analysis_agent_run_rollup
  add column if not exists skill_catalog_count integer not null default 0,
  add column if not exists skill_catalog_bytes bigint not null default 0,
  add column if not exists skill_bundle_download_bytes bigint not null default 0,
  add column if not exists skill_cache_hits integer not null default 0,
  add column if not exists skill_cache_misses integer not null default 0,
  add column if not exists skill_loaded_count integer not null default 0,
  add column if not exists skill_resource_reads integer not null default 0,
  add column if not exists skill_script_runs integer not null default 0;

------------------------------------------------------------------------------
-- 8. RLS
------------------------------------------------------------------------------

alter table public.review_skill enable row level security;
alter table public.review_skill_version enable row level security;
alter table public.review_skill_upload enable row level security;
alter table public.analysis_job_skill_snapshot enable row level security;
alter table public.analysis_skill_invocation enable row level security;

-- 浏览器只读，且只有 ADMIN。写入一律经 service-role 的管理 RPC：
-- 一个能直接 insert `review_skill_version` 的浏览器等于可以自报 locator 和 hash。
drop policy if exists "admins read review skill" on public.review_skill;
create policy "admins read review skill" on public.review_skill
for select to authenticated using (public.is_admin());

drop policy if exists "admins read review skill version" on public.review_skill_version;
create policy "admins read review skill version" on public.review_skill_version
for select to authenticated using (public.is_admin());

drop policy if exists "admins read review skill upload" on public.review_skill_upload;
create policy "admins read review skill upload" on public.review_skill_upload
for select to authenticated using (public.is_admin());

drop policy if exists "read job skill snapshot for managed batch"
on public.analysis_job_skill_snapshot;
create policy "read job skill snapshot for managed batch" on public.analysis_job_skill_snapshot
for select to authenticated
using (
  exists (
    select 1 from public.analysis_job job
    where job.id = analysis_job_skill_snapshot.job_id
      and public.can_manage_review_batch(job.batch_id)
  )
);

drop policy if exists "read skill invocation for managed batch"
on public.analysis_skill_invocation;
create policy "read skill invocation for managed batch" on public.analysis_skill_invocation
for select to authenticated
using (
  exists (
    select 1
    from public.analysis_agent_run run
    join public.analysis_job job on job.id = run.job_id
    where run.id = analysis_skill_invocation.agent_run_id
      and public.can_manage_review_batch(job.batch_id)
  )
);

------------------------------------------------------------------------------
-- 9. 专用私有 Storage bucket
--
-- 刻意不给 `authenticated` 任何 SELECT/INSERT/UPDATE/DELETE 策略：
--
--   * 上传走 service-role 签发的 signed upload URL（凭 token 授权，不经 RLS）；
--   * 下载走 ADMIN 请求、service-role 签发的短期 signed URL；
--   * Worker 用 service-role 按冻结 locator 直接下载。
--
-- 因此"普通 authenticated 用户不能列出或下载 skill-bundles"是**没有策略**的结果，
-- 而不是某条策略写对了的结果 —— 这比写一条 `using (false)` 更难被误改。
------------------------------------------------------------------------------

insert into storage.buckets (id, name, public)
values ('skill-bundles', 'skill-bundles', false)
on conflict (id) do update set public = false;

-- 旧策略清理：这个 bucket 从来不该有任何 authenticated 策略，写在这里是为了让
-- 重复执行的迁移把手工加过的策略收回去。
drop policy if exists "authenticated read skill bundles" on storage.objects;
drop policy if exists "authenticated write skill bundles" on storage.objects;

/*
 * 正式对象的删除保护。
 *
 * `storage.objects` 属于 supabase_storage_admin，迁移未必有权在它上面建触发器 ——
 * 托管环境和本地 CLI 的角色不同。所以这里用 DO 块尝试，失败只发通知：
 * 保护的第一道仍然是"没有 DELETE 策略 + 正式 key 只由服务端生成"，触发器是加固。
 */
create or replace function public.protect_referenced_skill_objects()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.bucket_id <> 'skill-bundles' then
    return old;
  end if;
  if exists (
    select 1 from public.analysis_job_skill_snapshot snapshot
    where snapshot.archive_bucket = old.bucket_id
      and snapshot.archive_object_key = old.name
  ) then
    raise exception 'SKILL_OBJECT_REFERENCED';
  end if;
  return old;
end;
$$;

do $$
begin
  begin
    drop trigger if exists protect_referenced_skill_objects on storage.objects;
    create trigger protect_referenced_skill_objects
    before delete on storage.objects
    for each row execute function public.protect_referenced_skill_objects();
  exception
    when insufficient_privilege or undefined_table then
      raise notice
        'skill-bundles object deletion guard not installed (insufficient privilege on storage.objects); '
        'retention relies on the absence of DELETE policies plus server-generated keys';
  end;
end $$;

------------------------------------------------------------------------------
-- 10. 管理 RPC（service-role，显式 actor）
------------------------------------------------------------------------------

create or replace function public.admin_create_review_skill(
  p_actor_id uuid,
  p_name text,
  p_display_name text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  perform public.assert_actor_is_admin(p_actor_id);
  if not public.is_valid_skill_name(p_name) then
    raise exception 'SKILL_NAME_INVALID';
  end if;
  if p_display_name is null or btrim(p_display_name) = '' then
    raise exception 'SKILL_DISPLAY_NAME_REQUIRED';
  end if;

  insert into public.review_skill (name, display_name, status, created_by)
  values (btrim(p_name), btrim(p_display_name), 'DRAFT', p_actor_id)
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.admin_register_skill_upload(
  p_actor_id uuid,
  p_skill_id uuid,
  p_staging_object_key text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_skill public.review_skill;
begin
  perform public.assert_actor_is_admin(p_actor_id);
  select * into v_skill from public.review_skill where id = p_skill_id;
  if v_skill.id is null then
    raise exception 'SKILL_NOT_FOUND';
  end if;
  -- staging key 必须落在调用者自己的隔离前缀下，且由服务端拼装。这里再校验一次：
  -- 一个能把 key 指到 `<skill-id>/versions/...` 的上传等于可以覆盖正式对象。
  if p_staging_object_key is null
     or p_staging_object_key <> ('staging/' || p_actor_id::text || '/'
          || split_part(p_staging_object_key, '/', 3))
     or split_part(p_staging_object_key, '/', 3) !~ '^[0-9a-f-]{36}\.zip$' then
    raise exception 'SKILL_UPLOAD_INVALID';
  end if;

  insert into public.review_skill_upload (
    skill_id, uploaded_by, staging_object_key, status
  ) values (p_skill_id, p_actor_id, p_staging_object_key, 'PENDING')
  returning id into v_id;

  update public.review_skill
  set status = case when status = 'PUBLISHED' then 'PUBLISHED' else 'DRAFT' end,
      updated_at = now()
  where id = p_skill_id;

  return v_id;
end;
$$;

/*
 * 落校验结果。
 *
 * manifest 由 Edge Function 在服务端解析归档后生成；这里**重算** bundle_hash 而不是
 * 采信入参，于是"数据库里的 bundle_hash 一定等于 manifest 的规范 hash"成为一条
 * 结构性事实，Worker 独立重算时才有可比对的锚点。
 */
create or replace function public.admin_record_skill_upload_validation(
  p_actor_id uuid,
  p_upload_id uuid,
  p_archive_sha256 text,
  p_archive_size_bytes bigint,
  p_bundle_manifest jsonb,
  p_expanded_size_bytes bigint,
  p_file_count integer,
  p_contains_scripts boolean,
  p_entry_frontmatter jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_upload public.review_skill_upload;
  v_skill public.review_skill;
  v_limits jsonb := public.skill_bundle_limits();
  v_hash text;
begin
  perform public.assert_actor_is_admin(p_actor_id);
  select * into v_upload from public.review_skill_upload where id = p_upload_id for update;
  if v_upload.id is null then
    raise exception 'SKILL_UPLOAD_NOT_FOUND';
  end if;
  if v_upload.status = 'CONSUMED' then
    raise exception 'SKILL_UPLOAD_ALREADY_PUBLISHED';
  end if;
  select * into v_skill from public.review_skill where id = v_upload.skill_id;

  if coalesce(p_bundle_manifest->>'skillName', '') <> v_skill.name then
    raise exception 'SKILL_BUNDLE_INVALID';
  end if;
  if coalesce(p_bundle_manifest->>'entry', '') <> 'SKILL.md' then
    raise exception 'SKILL_BUNDLE_INVALID';
  end if;
  if p_archive_size_bytes > (v_limits->>'archiveBytes')::bigint
     or p_expanded_size_bytes > (v_limits->>'expandedBytes')::bigint
     or p_file_count > (v_limits->>'entryCount')::integer then
    raise exception 'SKILL_BUNDLE_LIMIT_EXCEEDED';
  end if;

  -- frontmatter 是发布的前置条件，不是可选元数据：没有它，dsh 会静默忽略整个技能。
  if p_entry_frontmatter is null
     or coalesce(p_entry_frontmatter->>'name', '') <> v_skill.name
     or coalesce(btrim(p_entry_frontmatter->>'description'), '') = '' then
    raise exception 'SKILL_BUNDLE_INVALID';
  end if;
  if char_length(p_entry_frontmatter->>'description')
       > (v_limits->>'descriptionChars')::integer then
    raise exception 'SKILL_CATALOG_LIMIT_EXCEEDED';
  end if;

  v_hash := public.skill_bundle_hash(p_bundle_manifest);

  update public.review_skill_upload
  set status = 'VALIDATED',
      archive_sha256 = p_archive_sha256,
      archive_size_bytes = p_archive_size_bytes,
      bundle_hash = v_hash,
      bundle_manifest = p_bundle_manifest,
      entry_frontmatter = p_entry_frontmatter,
      expanded_size_bytes = p_expanded_size_bytes,
      file_count = p_file_count,
      contains_scripts = coalesce(p_contains_scripts, false),
      error_code = null,
      error_message = null,
      validated_at = now()
  where id = p_upload_id;

  return jsonb_build_object('upload_id', p_upload_id, 'bundle_hash', v_hash);
end;
$$;

create or replace function public.admin_record_skill_upload_failure(
  p_actor_id uuid,
  p_upload_id uuid,
  p_error_code text,
  p_error_message text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.assert_actor_is_admin(p_actor_id);
  update public.review_skill_upload
  set status = 'FAILED',
      error_code = p_error_code,
      -- 只存我们自己产生的稳定错误码与一行原因，绝不存归档内容片段。
      error_message = left(coalesce(p_error_message, ''), 300),
      validated_at = now()
  where id = p_upload_id and status <> 'CONSUMED';

  update public.review_skill skill
  set status = case when skill.status = 'PUBLISHED' then 'PUBLISHED' else 'VALIDATION_FAILED' end,
      updated_at = now()
  where skill.id = (select skill_id from public.review_skill_upload where id = p_upload_id);
  return true;
end;
$$;

/*
 * 发布：把校验过的 staging 结果提升成不可变版本。
 *
 * 入参只有 upload id 和正式 key，其余全部从服务端已落库的校验结果里取 —— 这就是
 * §15「不接受浏览器自报的正式 bucket/key/hash」的落点。
 */
-- 旧的 6 参数重载（description / when_to_use 由调用方给）必须先删掉：留着它等于留一条
-- 可以让浏览器自定义 description 的旁路，而那条路会让库里的文本与模型看到的文本分叉。
drop function if exists public.admin_publish_review_skill_version(
  uuid, uuid, text, text, text, boolean
);
drop function if exists public.admin_record_skill_upload_validation(
  uuid, uuid, text, bigint, jsonb, bigint, integer, boolean
);

create or replace function public.admin_publish_review_skill_version(
  p_actor_id uuid,
  p_upload_id uuid,
  p_archive_object_key text,
  p_acknowledge_scripts boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_upload public.review_skill_upload;
  v_skill public.review_skill;
  v_limits jsonb := public.skill_bundle_limits();
  v_version integer;
  v_version_id uuid;
  v_description text;
  v_when_to_use text;
begin
  perform public.assert_actor_is_admin(p_actor_id);
  select * into v_upload from public.review_skill_upload where id = p_upload_id for update;
  if v_upload.id is null then
    raise exception 'SKILL_UPLOAD_NOT_FOUND';
  end if;
  if v_upload.status <> 'VALIDATED' then
    raise exception 'SKILL_UPLOAD_NOT_VALIDATED';
  end if;
  if v_upload.expires_at < now() then
    raise exception 'SKILL_UPLOAD_EXPIRED';
  end if;
  /*
   * description 与 whenToUse **从 frontmatter 取**，不接受调用方另给一段文字。
   *
   * 理由是"只有一个真相"：dsh 在首轮目录里渲染的是 `SKILL.md` frontmatter 里的
   * description。若数据库里存的是管理员另敲的一段，那么管理页显示的、审计里记的、
   * 和模型实际看到的就是三份不同的文本，而且没有任何机制会发现这个分叉。
   */
  v_description := btrim(coalesce(v_upload.entry_frontmatter->>'description', ''));
  v_when_to_use := nullif(btrim(coalesce(v_upload.entry_frontmatter->>'whenToUse', '')), '');
  if v_description = '' then
    raise exception 'SKILL_DESCRIPTION_REQUIRED';
  end if;
  if char_length(v_description) > (v_limits->>'descriptionChars')::integer then
    raise exception 'SKILL_CATALOG_LIMIT_EXCEEDED';
  end if;
  if v_upload.contains_scripts and coalesce(p_acknowledge_scripts, false) is not true then
    -- 含可执行指令资源的版本必须显式确认。这不是提示，是准入条件。
    raise exception 'SKILL_SCRIPTS_NOT_ACKNOWLEDGED';
  end if;

  select * into v_skill from public.review_skill where id = v_upload.skill_id for update;

  -- 正式 key 内容寻址且不可变：`<skill-id>/versions/<version>/<archive-sha>.zip`。
  select coalesce(max(version), 0) + 1 into v_version
  from public.review_skill_version where skill_id = v_skill.id;

  if p_archive_object_key is distinct from (
    v_skill.id::text || '/versions/' || v_version::text || '/'
      || replace(v_upload.archive_sha256, 'sha256:', '') || '.zip'
  ) then
    raise exception 'SKILL_OBJECT_KEY_INVALID';
  end if;

  insert into public.review_skill_version (
    skill_id, version, description, when_to_use,
    archive_bucket, archive_object_key, archive_sha256, archive_size_bytes,
    bundle_hash, bundle_manifest, expanded_size_bytes, file_count,
    contains_scripts, published_by
  ) values (
    v_skill.id, v_version, v_description, v_when_to_use,
    'skill-bundles', p_archive_object_key, v_upload.archive_sha256, v_upload.archive_size_bytes,
    v_upload.bundle_hash, v_upload.bundle_manifest, v_upload.expanded_size_bytes,
    v_upload.file_count, v_upload.contains_scripts, p_actor_id
  ) returning id into v_version_id;

  update public.review_skill
  set current_version_id = v_version_id,
      status = 'PUBLISHED',
      updated_at = now()
  where id = v_skill.id;

  update public.review_skill_upload
  set status = 'CONSUMED'
  where id = p_upload_id;

  return jsonb_build_object(
    'skill_id', v_skill.id,
    'version_id', v_version_id,
    'version', v_version,
    'bundle_hash', v_upload.bundle_hash,
    'contains_scripts', v_upload.contains_scripts
  );
end;
$$;

create or replace function public.admin_set_review_skill_enabled(
  p_actor_id uuid,
  p_skill_id uuid,
  p_enabled boolean
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_skill public.review_skill;
begin
  perform public.assert_actor_is_admin(p_actor_id);
  select * into v_skill from public.review_skill where id = p_skill_id for update;
  if v_skill.id is null then
    raise exception 'SKILL_NOT_FOUND';
  end if;

  if p_enabled then
    if v_skill.current_version_id is null then
      raise exception 'SKILL_NOT_PUBLISHED';
    end if;
    update public.review_skill
    set status = 'PUBLISHED', updated_at = now() where id = p_skill_id;
  else
    update public.review_skill
    set status = 'DISABLED', updated_at = now() where id = p_skill_id;
  end if;
  return true;
end;
$$;

create or replace function public.admin_disable_review_skill(p_actor_id uuid, p_skill_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  return public.admin_set_review_skill_enabled(p_actor_id, p_skill_id, false);
end;
$$;

/*
 * 目录总览：列表 + 全局容量水位。
 *
 * 容量在这里算而不是在前端加总：前端只能看到它拿到的那一页，而 §14.1 顶部那五行
 * 说的是"全部启用技能"的水位。
 */
create or replace function public.admin_list_review_skills()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_limits jsonb := public.skill_bundle_limits();
  v_skills jsonb;
  v_enabled record;
begin
  perform public.ensure_admin();

  select coalesce(jsonb_agg(row order by row->>'name'), '[]'::jsonb) into v_skills
  from (
    select jsonb_build_object(
      'id', skill.id,
      'name', skill.name,
      'display_name', skill.display_name,
      'status', skill.status,
      'current_version_id', skill.current_version_id,
      'current_version', version.version,
      'description', version.description,
      'when_to_use', version.when_to_use,
      'file_count', version.file_count,
      'archive_size_bytes', version.archive_size_bytes,
      'expanded_size_bytes', version.expanded_size_bytes,
      'contains_scripts', coalesce(version.contains_scripts, false),
      'bundle_hash', version.bundle_hash,
      'published_at', version.published_at,
      'published_by_name', publisher.display_name,
      'updated_at', skill.updated_at,
      'version_count', (
        select count(*) from public.review_skill_version v where v.skill_id = skill.id
      ),
      'latest_upload', (
        select jsonb_build_object(
          'id', upload.id,
          'status', upload.status,
          'error_code', upload.error_code,
          'error_message', upload.error_message,
          'file_count', upload.file_count,
          'archive_size_bytes', upload.archive_size_bytes,
          'expanded_size_bytes', upload.expanded_size_bytes,
          'contains_scripts', upload.contains_scripts,
          'bundle_manifest', upload.bundle_manifest,
          'entry_frontmatter', upload.entry_frontmatter,
          'created_at', upload.created_at
        )
        from public.review_skill_upload upload
        where upload.skill_id = skill.id and upload.status <> 'CONSUMED'
        order by upload.created_at desc limit 1
      )
    ) as row
    from public.review_skill skill
    left join public.review_skill_version version on version.id = skill.current_version_id
    left join public.user_profile publisher on publisher.id = version.published_by
  ) rows;

  select
    count(*) as bundles,
    coalesce(sum(version.archive_size_bytes), 0) as archive_bytes,
    coalesce(sum(version.expanded_size_bytes), 0) as expanded_bytes,
    coalesce(sum(
      octet_length(skill.name) + octet_length(version.description)
        + octet_length(coalesce(version.when_to_use, ''))
    ), 0) as render_bytes,
    count(*) filter (where version.contains_scripts) as script_bundles
  into v_enabled
  from public.review_skill skill
  join public.review_skill_version version on version.id = skill.current_version_id
  where skill.status = 'PUBLISHED';

  return jsonb_build_object(
    'limits', v_limits,
    'skills', v_skills,
    'capacity', jsonb_build_object(
      'enabled_bundles', v_enabled.bundles,
      'archive_bytes', v_enabled.archive_bytes,
      'expanded_bytes', v_enabled.expanded_bytes,
      'catalog_render_bytes', v_enabled.render_bytes,
      'script_bundles', v_enabled.script_bundles,
      'catalog_hash', public.current_skill_catalog_hash()
    )
  );
end;
$$;

create or replace function public.admin_get_review_skill(p_skill_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row jsonb;
begin
  perform public.ensure_admin();
  select jsonb_build_object(
    'id', skill.id,
    'name', skill.name,
    'display_name', skill.display_name,
    'status', skill.status,
    'current_version_id', skill.current_version_id,
    'versions', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', version.id,
        'version', version.version,
        'description', version.description,
        'when_to_use', version.when_to_use,
        'archive_object_key', version.archive_object_key,
        'archive_sha256', version.archive_sha256,
        'archive_size_bytes', version.archive_size_bytes,
        'bundle_hash', version.bundle_hash,
        'bundle_manifest', version.bundle_manifest,
        'expanded_size_bytes', version.expanded_size_bytes,
        'file_count', version.file_count,
        'contains_scripts', version.contains_scripts,
        'published_at', version.published_at
      ) order by version.version desc), '[]'::jsonb)
      from public.review_skill_version version where version.skill_id = skill.id
    )
  ) into v_row
  from public.review_skill skill
  where skill.id = p_skill_id;
  return v_row;
end;
$$;

/*
 * ADMIN 请求下载已发布 Bundle 时用的 locator。
 *
 * 只返回 bucket/key，不返回 signed URL：URL 由 Edge Function 用 service-role 现签，
 * 短期有效，且不落库、不进日志。
 */
create or replace function public.admin_get_skill_version_locator(
  p_actor_id uuid,
  p_version_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_version public.review_skill_version;
begin
  perform public.assert_actor_is_admin(p_actor_id);
  select * into v_version from public.review_skill_version where id = p_version_id;
  if v_version.id is null then
    raise exception 'SKILL_VERSION_NOT_FOUND';
  end if;
  return jsonb_build_object(
    'bucket', v_version.archive_bucket,
    'object_key', v_version.archive_object_key
  );
end;
$$;

create or replace function public.admin_get_skill_upload(p_actor_id uuid, p_upload_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row jsonb;
begin
  perform public.assert_actor_is_admin(p_actor_id);
  select jsonb_build_object(
    'id', upload.id,
    'skill_id', upload.skill_id,
    'skill_name', skill.name,
    'status', upload.status,
    'staging_bucket', upload.staging_bucket,
    'staging_object_key', upload.staging_object_key,
    'archive_sha256', upload.archive_sha256,
    'archive_size_bytes', upload.archive_size_bytes,
    'bundle_hash', upload.bundle_hash,
    'bundle_manifest', upload.bundle_manifest,
    'entry_frontmatter', upload.entry_frontmatter,
    'expanded_size_bytes', upload.expanded_size_bytes,
    'file_count', upload.file_count,
    'contains_scripts', upload.contains_scripts,
    'error_code', upload.error_code,
    'error_message', upload.error_message,
    'expires_at', upload.expires_at
  ) into v_row
  from public.review_skill_upload upload
  join public.review_skill skill on skill.id = upload.skill_id
  where upload.id = p_upload_id;
  if v_row is null then
    raise exception 'SKILL_UPLOAD_NOT_FOUND';
  end if;
  return v_row;
end;
$$;

------------------------------------------------------------------------------
-- 11. 当前目录与 Job 冻结
------------------------------------------------------------------------------

create or replace function public.current_skill_catalog_entries()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'skill_id', skill.id,
    'version_id', version.id,
    'version', version.version,
    'name', skill.name,
    'description', version.description,
    'when_to_use', version.when_to_use,
    'archive_bucket', version.archive_bucket,
    'archive_object_key', version.archive_object_key,
    'archive_sha256', version.archive_sha256,
    'archive_size_bytes', version.archive_size_bytes,
    'bundle_hash', version.bundle_hash,
    'bundle_manifest', version.bundle_manifest,
    'expanded_size_bytes', version.expanded_size_bytes,
    'file_count', version.file_count,
    'contains_scripts', version.contains_scripts
  ) order by skill.name), '[]'::jsonb)
  from public.review_skill skill
  join public.review_skill_version version on version.id = skill.current_version_id
  where skill.status = 'PUBLISHED';
$$;

create or replace function public.current_skill_catalog_hash()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select public.skill_catalog_hash((
    select coalesce(jsonb_agg(jsonb_build_object(
      'name', entry->>'name',
      'version', entry->>'version',
      'bundleHash', entry->>'bundle_hash',
      'archiveSha256', entry->>'archive_sha256'
    )), '[]'::jsonb)
    from jsonb_array_elements(public.current_skill_catalog_entries()) as entry
  ));
$$;

/*
 * 冻结一个 Job 的技能目录。
 *
 * 在 enqueue 的同一个事务里跑，容量上限在这里 fail closed：让一个超限的 Job 进队列，
 * 等 Worker 下载到第 51 个包再失败，等于把治理成本推给运行时。
 */
create or replace function public.freeze_analysis_job_skill_catalog(p_job_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_limits jsonb := public.skill_bundle_limits();
  v_entries jsonb := public.current_skill_catalog_entries();
  v_entry jsonb;
  v_count integer := jsonb_array_length(v_entries);
  v_archive_bytes bigint := 0;
  v_expanded_bytes bigint := 0;
  v_render_bytes bigint := 0;
  v_hash text;
begin
  if v_count > (v_limits->>'catalogBundles')::integer then
    raise exception 'SKILL_CATALOG_LIMIT_EXCEEDED';
  end if;

  for v_entry in select * from jsonb_array_elements(v_entries)
  loop
    if char_length(v_entry->>'description') > (v_limits->>'descriptionChars')::integer then
      raise exception 'SKILL_CATALOG_LIMIT_EXCEEDED';
    end if;
    v_archive_bytes := v_archive_bytes + (v_entry->>'archive_size_bytes')::bigint;
    v_expanded_bytes := v_expanded_bytes + (v_entry->>'expanded_size_bytes')::bigint;
    v_render_bytes := v_render_bytes
      + octet_length(v_entry->>'name')
      + octet_length(v_entry->>'description')
      + octet_length(coalesce(v_entry->>'when_to_use', ''));

    insert into public.analysis_job_skill_snapshot (
      job_id, source_skill_id, source_version_id, source_version,
      name, description, when_to_use,
      archive_bucket, archive_object_key, archive_sha256, archive_size_bytes,
      bundle_hash, bundle_manifest, expanded_size_bytes, file_count, contains_scripts
    ) values (
      p_job_id,
      (v_entry->>'skill_id')::uuid,
      (v_entry->>'version_id')::uuid,
      (v_entry->>'version')::integer,
      v_entry->>'name',
      v_entry->>'description',
      nullif(v_entry->>'when_to_use', ''),
      v_entry->>'archive_bucket',
      v_entry->>'archive_object_key',
      v_entry->>'archive_sha256',
      (v_entry->>'archive_size_bytes')::bigint,
      v_entry->>'bundle_hash',
      v_entry->'bundle_manifest',
      (v_entry->>'expanded_size_bytes')::bigint,
      (v_entry->>'file_count')::integer,
      (v_entry->>'contains_scripts')::boolean
    );
  end loop;

  if v_archive_bytes > (v_limits->>'catalogArchiveBytes')::bigint
     or v_expanded_bytes > (v_limits->>'catalogExpandedBytes')::bigint
     or v_render_bytes > (v_limits->>'catalogRenderBytes')::bigint then
    raise exception 'SKILL_CATALOG_LIMIT_EXCEEDED';
  end if;

  v_hash := public.skill_catalog_hash((
    select coalesce(jsonb_agg(jsonb_build_object(
      'name', entry->>'name',
      'version', entry->>'version',
      'bundleHash', entry->>'bundle_hash',
      'archiveSha256', entry->>'archive_sha256'
    )), '[]'::jsonb)
    from jsonb_array_elements(v_entries) as entry
  ));

  update public.analysis_job
  set skill_catalog_hash = v_hash,
      -- snapshot_version 0 专门留给"迁移前的历史 Job"；冻结过目录的 Job 一律 >= 1。
      skill_snapshot_version = 1,
      skill_bundle_count = v_count,
      skill_archive_bytes = v_archive_bytes,
      skill_expanded_bytes = v_expanded_bytes
  where id = p_job_id;

  return jsonb_build_object(
    'catalog_hash', v_hash,
    'bundle_count', v_count,
    'archive_bytes', v_archive_bytes,
    'expanded_bytes', v_expanded_bytes
  );
end;
$$;

------------------------------------------------------------------------------
-- 12. enqueue_analysis_job：冻结 policy 的同时冻结技能目录
--
-- 整体重写而不是加一个 after-insert 触发器：冻结必须与 Job 插入同事务，且超限时
-- 要能把整个 enqueue 回滚掉。触发器能做到前者，但会把 §8 的上限错误藏在一个
-- 与调用点无关的地方。
------------------------------------------------------------------------------

create or replace function public.enqueue_analysis_job(p_batch_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_batch public.review_batch;
  v_enabled boolean;
  v_secret uuid;
  v_snapshot jsonb;
  v_policy jsonb;
  v_job_id uuid;
  v_story_count integer;
begin
  perform public.ensure_manage_review_batch(p_batch_id);

  select * into v_batch from public.review_batch where id = p_batch_id for update;
  if v_batch.id is null then
    raise exception 'batch not found';
  end if;
  if v_batch.status = 'COMPLETED' then
    raise exception 'batch is completed and read-only; reopen it first';
  end if;
  if v_batch.default_branch is null
     or v_batch.default_branch not in ('feature_dev', 'feature_sit', 'release') then
    raise exception 'batch default_branch must be feature_dev, feature_sit, or release';
  end if;
  if v_batch.ai_model_config_id is null then
    raise exception 'batch has no model selected';
  end if;
  if exists (select 1 from public.ai_import_record where batch_id = p_batch_id) then
    raise exception 'AI result already exists for this batch';
  end if;
  if exists (
    select 1 from public.analysis_job
    where batch_id = p_batch_id
      and status in ('QUEUED', 'PREPARING_CODE', 'PROCESSING', 'FINALIZING')
  ) then
    raise exception 'an active analysis job already exists for this batch';
  end if;

  select count(*) into v_story_count from public.review_story where batch_id = p_batch_id;
  if v_story_count = 0 then
    raise exception 'no stories imported for this batch';
  end if;

  select enabled, api_key_secret_id into v_enabled, v_secret
  from public.ai_model_config where id = v_batch.ai_model_config_id;
  if v_enabled is null then
    raise exception 'model config not found';
  end if;
  if not v_enabled then
    raise exception 'MODEL_CONFIG_DISABLED';
  end if;
  if not public.model_config_has_api_key(v_secret) then
    raise exception 'MODEL_SECRET_MISSING';
  end if;

  v_snapshot := public.build_model_snapshot(v_batch.ai_model_config_id);
  -- 用户不勾选任何能力：Policy 由程序在这里一次性冻结，全部默认开启。
  v_policy := public.build_v4_capability_policy(v_batch.ai_model_config_id);
  update public.review_batch set ai_model_snapshot = v_snapshot where id = p_batch_id;

  insert into public.analysis_job (
    batch_id, model_config_id, model_snapshot, requested_branch,
    status, requested_by, total_stories, execution_engine,
    policy_version, capability_policy_snapshot, policy_hash
  ) values (
    p_batch_id, v_batch.ai_model_config_id, v_snapshot, v_batch.default_branch,
    'QUEUED', (select auth.uid()), v_story_count, 'deepseek-harness-acp',
    4, v_policy, encode(sha256(v_policy::text::bytea), 'hex')
  ) returning id into v_job_id;

  -- V1.6：冻结全部"已发布且启用"的技能版本。全部 Story Task 共用这一份目录。
  perform public.freeze_analysis_job_skill_catalog(v_job_id);

  insert into public.analysis_story_task (job_id, story_id)
  select v_job_id, story.id
  from public.review_story story
  where story.batch_id = p_batch_id;

  return v_job_id;
end;
$$;

------------------------------------------------------------------------------
-- 13. Worker 侧：claim-fenced 取冻结目录
------------------------------------------------------------------------------

create or replace function public.get_story_task_skill_snapshot(
  p_task_id uuid,
  p_worker_id text,
  p_claim_token uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_task public.analysis_story_task;
  v_job public.analysis_job;
begin
  select * into v_task from public.analysis_story_task where id = p_task_id;
  if v_task.id is null
     or v_task.worker_id is distinct from p_worker_id
     or v_task.lease_expires_at is null
     or v_task.lease_expires_at < now()
     or p_claim_token is null
     or v_task.claim_token_digest is distinct from public.agent_claim_token_digest(p_claim_token)
  then
    raise exception 'TASK_LEASE_LOST';
  end if;

  select * into v_job from public.analysis_job where id = v_task.job_id;

  return jsonb_build_object(
    'job_id', v_job.id,
    'snapshot_version', v_job.skill_snapshot_version,
    'catalog_hash', v_job.skill_catalog_hash,
    'archive_bytes', v_job.skill_archive_bytes,
    'expanded_bytes', v_job.skill_expanded_bytes,
    'bundles', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'snapshot_id', snapshot.id,
        'name', snapshot.name,
        'description', snapshot.description,
        'when_to_use', snapshot.when_to_use,
        'version', snapshot.source_version,
        'archive_bucket', snapshot.archive_bucket,
        'archive_object_key', snapshot.archive_object_key,
        'archive_sha256', snapshot.archive_sha256,
        'archive_size_bytes', snapshot.archive_size_bytes,
        'bundle_hash', snapshot.bundle_hash,
        'bundle_manifest', snapshot.bundle_manifest,
        'expanded_size_bytes', snapshot.expanded_size_bytes,
        'file_count', snapshot.file_count,
        'contains_scripts', snapshot.contains_scripts
      ) order by snapshot.name), '[]'::jsonb)
      from public.analysis_job_skill_snapshot snapshot
      where snapshot.job_id = v_job.id
    )
  );
end;
$$;

------------------------------------------------------------------------------
-- 14. profile / checkpoint 记录 catalog hash
--
-- 两个函数都要多一个参数。加参数只能 drop + create：`create or replace` 改不了签名，
-- 而"再加一个重载"会留下一条不校验 catalog hash 的旧路径 —— 那正是 §12 要求
-- fail closed 的地方。
------------------------------------------------------------------------------

drop function if exists public.record_analysis_attempt_profile(
  uuid, text, uuid, integer, text, text, text, text, text, text, text
);

create or replace function public.record_analysis_attempt_profile(
  p_task_id uuid,
  p_worker_id text,
  p_claim_token uuid,
  p_agent_attempt integer,
  p_harness_version text,
  p_capability_contract_hash text,
  p_profile_hash text,
  p_policy_hash text,
  p_root_agent_id text default null,
  p_root_session_id text default null,
  p_tree_digest text default null,
  p_skill_catalog_hash text default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_task public.analysis_story_task;
  v_job public.analysis_job;
  v_run public.analysis_agent_run;
begin
  select * into v_task from public.analysis_story_task where id = p_task_id;
  if v_task.id is null
     or v_task.worker_id is distinct from p_worker_id
     or v_task.lease_expires_at is null
     or v_task.lease_expires_at < now()
     or p_claim_token is null
     or v_task.claim_token_digest is distinct from public.agent_claim_token_digest(p_claim_token)
     or p_agent_attempt is distinct from v_task.agent_attempt then
    return false;
  end if;

  select * into v_job from public.analysis_job where id = v_task.job_id for update;
  select * into v_run from public.analysis_agent_run
  where task_id = p_task_id and agent_attempt = p_agent_attempt
  for update;

  if v_run.id is null
     or nullif(p_harness_version, '') is null
     or nullif(p_capability_contract_hash, '') is null
     or nullif(p_profile_hash, '') is null
     or nullif(p_policy_hash, '') is null
     or nullif(p_root_agent_id, '') is null
     or nullif(p_root_session_id, '') is null
     or nullif(p_tree_digest, '') is null then
    raise exception 'AGENT_IDENTITY_INVALID';
  end if;
  if v_job.harness_version is not null
     and v_job.harness_version <> p_harness_version then
    raise exception 'SESSION_FORMAT_UNSUPPORTED';
  end if;
  if v_job.capability_contract_hash is not null
     and v_job.capability_contract_hash <> p_capability_contract_hash then
    raise exception 'SESSION_FORMAT_UNSUPPORTED';
  end if;
  if v_job.policy_hash is distinct from p_policy_hash
     or (v_run.policy_hash is not null and v_run.policy_hash <> p_policy_hash)
     or (v_run.root_agent_id is not null and v_run.root_agent_id <> p_root_agent_id)
     or (v_run.root_session_id is not null and v_run.root_session_id <> p_root_session_id) then
    raise exception 'AGENT_IDENTITY_INVALID';
  end if;
  /*
   * Worker 报出来的 catalog hash 必须等于 Job 冻结的那一份。
   *
   * 这是"Worker 独立重算"的兑现点：Worker 从 snapshot 逐个下载、解包、重算
   * bundle hash，再合成 catalog hash。它与库里冻结值不等，只可能是对象被换过、
   * 解析逻辑漂移，或 Worker 读了当前已发布集合而不是 Job 快照 —— 三种都不能放行。
   */
  if p_skill_catalog_hash is not null
     and v_job.skill_catalog_hash is not null
     and p_skill_catalog_hash <> v_job.skill_catalog_hash then
    raise exception 'SESSION_SKILL_SET_MISMATCH';
  end if;

  update public.analysis_job
  set harness_version = coalesce(harness_version, p_harness_version),
      capability_contract_hash = coalesce(capability_contract_hash, p_capability_contract_hash),
      profile_hash = coalesce(profile_hash, p_profile_hash)
  where id = v_job.id;

  update public.analysis_agent_run
  set policy_hash = p_policy_hash,
      root_agent_id = p_root_agent_id,
      root_session_id = p_root_session_id,
      tree_digest = p_tree_digest,
      skill_catalog_hash = coalesce(p_skill_catalog_hash, skill_catalog_hash)
  where id = v_run.id;

  return true;
end;
$$;

drop function if exists public.save_analysis_session_checkpoint(
  uuid, text, uuid, integer, text, integer, text, text, integer, text, text, text
);

create or replace function public.save_analysis_session_checkpoint(
  p_task_id uuid,
  p_worker_id text,
  p_claim_token uuid,
  p_agent_attempt integer,
  p_session_id text,
  p_session_revision integer,
  p_storage_locator text,
  p_content_hash text,
  p_event_count integer,
  p_harness_version text,
  p_profile_hash text default null,
  p_status text default 'OPEN',
  p_skill_catalog_hash text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run public.analysis_agent_run;
  v_retention integer;
  v_id uuid;
begin
  select run.* into v_run
  from public.analysis_agent_run run
  join public.analysis_story_task task on task.id = run.task_id
  where run.task_id = p_task_id
    and run.agent_attempt = p_agent_attempt
    and task.worker_id = p_worker_id
    and task.lease_expires_at is not null
    and task.lease_expires_at >= now()
    and p_claim_token is not null
    and task.claim_token_digest = public.agent_claim_token_digest(p_claim_token)
  for update of run;

  if v_run.id is null then
    raise exception 'TASK_LEASE_LOST';
  end if;
  -- fencing：revision 只能前进。落后的写入来自被接管的旧 Worker。
  if p_session_revision < v_run.session_revision then
    raise exception 'SESSION_FENCED';
  end if;

  select coalesce((job.capability_policy_snapshot #>> '{session,retentionDays}')::integer, 7)
  into v_retention
  from public.analysis_job job where job.id = v_run.job_id;

  insert into public.analysis_session_checkpoint (
    agent_run_id, session_id, session_revision, storage_locator, content_hash,
    event_count, harness_version, profile_hash, skill_catalog_hash, status, retention_until
  ) values (
    v_run.id, p_session_id, p_session_revision, p_storage_locator, p_content_hash,
    greatest(coalesce(p_event_count, 0), 0), p_harness_version, p_profile_hash,
    coalesce(p_skill_catalog_hash, v_run.skill_catalog_hash),
    coalesce(p_status, 'OPEN'), now() + make_interval(days => v_retention)
  )
  on conflict (session_id, session_revision) do update
  set storage_locator = excluded.storage_locator,
      content_hash = excluded.content_hash,
      event_count = excluded.event_count,
      status = excluded.status,
      skill_catalog_hash = coalesce(
        excluded.skill_catalog_hash, analysis_session_checkpoint.skill_catalog_hash
      ),
      retention_until = excluded.retention_until
  returning id into v_id;

  update public.analysis_agent_run
  set session_revision = greatest(session_revision, p_session_revision),
      last_checkpoint_at = now()
  where id = v_run.id;

  return jsonb_build_object('checkpoint_id', v_id, 'session_revision', p_session_revision);
end;
$$;

/*
 * 恢复候选多带两个字段。
 *
 * `load_resumable_analysis_attempt` 的返回类型不变（jsonb），所以这里可以直接
 * `create or replace`；补的是 checkpoint 的 skill catalog hash 与 Job 冻结值，
 * 让 Worker 能在 spawn dsh **之前**把两者和自己重算的值三方对齐。
 */
create or replace function public.load_resumable_analysis_attempt(
  p_task_id uuid,
  p_worker_id text,
  p_claim_token uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_task public.analysis_story_task;
  v_run public.analysis_agent_run;
  v_checkpoint public.analysis_session_checkpoint;
  v_job public.analysis_job;
begin
  select * into v_task from public.analysis_story_task where id = p_task_id;
  if v_task.id is null then
    return null;
  end if;
  if v_task.worker_id is distinct from p_worker_id
     or p_claim_token is null
     or v_task.claim_token_digest is distinct from public.agent_claim_token_digest(p_claim_token) then
    return null;
  end if;

  select * into v_run from public.analysis_agent_run
  where task_id = p_task_id and agent_attempt = v_task.agent_attempt;
  if v_run.id is null or v_run.status = 'COMMITTED' or v_run.sealed_at is not null then
    return null;
  end if;
  if v_run.cancel_requested_at is not null then
    return null;
  end if;

  select * into v_job from public.analysis_job where id = v_run.job_id;
  if coalesce((v_job.capability_policy_snapshot #>> '{session,resumeOnWorkerRestart}')::boolean, true)
     is not true then
    return null;
  end if;

  select * into v_checkpoint from public.analysis_session_checkpoint
  where agent_run_id = v_run.id and status in ('OPEN', 'SEALED')
  order by session_revision desc
  limit 1;

  if v_checkpoint.id is null then
    return null;
  end if;

  update public.analysis_agent_run
  set resume_count = resume_count + 1,
      session_revision = v_checkpoint.session_revision + 1
  where id = v_run.id;

  return jsonb_build_object(
    'agent_run_id', v_run.id,
    'root_session_id', v_run.root_session_id,
    'root_agent_id', v_run.root_agent_id,
    'session_id', v_checkpoint.session_id,
    'session_revision', v_checkpoint.session_revision + 1,
    'storage_locator', v_checkpoint.storage_locator,
    'content_hash', v_checkpoint.content_hash,
    'harness_version', v_checkpoint.harness_version,
    'profile_hash', v_checkpoint.profile_hash,
    'policy_hash', v_run.policy_hash,
    'skill_catalog_hash', v_checkpoint.skill_catalog_hash,
    'job_skill_catalog_hash', v_job.skill_catalog_hash,
    'resume_count', v_run.resume_count + 1
  );
end;
$$;

------------------------------------------------------------------------------
-- 15. 工具审计带 skill 字段并派生调用审计
--
-- 不新增 Broker 路由、不新增 RPC：`tools/pre-execute` 已经覆盖全部 30 个模型工具，
-- 所以 skill 的加载与资源读取都在同一条上报通道里。
------------------------------------------------------------------------------

create or replace function public.append_analysis_tool_audit(
  p_task_id uuid,
  p_worker_id text,
  p_claim_token uuid,
  p_agent_attempt integer,
  p_entries jsonb,
  p_decisions jsonb default '[]'::jsonb
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run_id uuid;
  v_job_id uuid;
  v_entry jsonb;
  v_written integer := 0;
  v_node_id uuid;
  v_snapshot_id uuid;
  v_skill_name text;
  v_bundle_hash text;
  v_resource_path text;
  v_audit_id bigint;
begin
  select run.id, run.job_id into v_run_id, v_job_id
  from public.analysis_agent_run run
  join public.analysis_story_task task on task.id = run.task_id
  where run.task_id = p_task_id
    and run.agent_attempt = p_agent_attempt
    and task.worker_id = p_worker_id
    and p_claim_token is not null
    and task.claim_token_digest = public.agent_claim_token_digest(p_claim_token);

  if v_run_id is null then
    return 0;
  end if;

  if jsonb_typeof(p_entries) = 'array' then
    for v_entry in select * from jsonb_array_elements(p_entries)
    loop
      v_node_id := (
        select id from public.analysis_agent_node
        where agent_run_id = v_run_id and agent_id = v_entry->>'agent_id'
      );
      v_skill_name := nullif(v_entry->>'skill_name', '');
      v_bundle_hash := nullif(v_entry->>'skill_bundle_hash', '');
      -- 只接受安全的规范相对路径。带 `..`、绝对路径或反斜杠的一律丢弃字段，
      -- 而不是"存下来以后再说"：审计表不是攻击载荷的转运站。
      v_resource_path := nullif(v_entry->>'resource_relative_path', '');
      if v_resource_path is not null
         and (v_resource_path ~ '(^/)|(\\)|(^[A-Za-z]:)|(\.\.)|(^\s)|(\s$)') then
        v_resource_path := null;
      end if;

      -- snapshot id 由服务端按 (job, name, bundle_hash) 反查，不采信上报的 id。
      v_snapshot_id := null;
      if v_skill_name is not null then
        select snapshot.id into v_snapshot_id
        from public.analysis_job_skill_snapshot snapshot
        where snapshot.job_id = v_job_id
          and snapshot.name = v_skill_name
          and (v_bundle_hash is null or snapshot.bundle_hash = v_bundle_hash);
      end if;

      insert into public.analysis_tool_audit (
        agent_run_id, agent_node_id, session_id, tool_call_id, tool_name,
        permission_verdict, error_code, started_at, finished_at, duration_ms,
        request_bytes, response_bytes, budget_reservation,
        skill_snapshot_id, skill_name, skill_bundle_hash, resource_relative_path
      ) values (
        v_run_id,
        v_node_id,
        v_entry->>'session_id',
        v_entry->>'tool_call_id',
        v_entry->>'tool_name',
        coalesce(v_entry->>'permission_verdict', 'ALLOW'),
        v_entry->>'error_code',
        coalesce((v_entry->>'started_at')::timestamptz, now()),
        (v_entry->>'finished_at')::timestamptz,
        (v_entry->>'duration_ms')::integer,
        greatest(coalesce((v_entry->>'request_bytes')::integer, 0), 0),
        greatest(coalesce((v_entry->>'response_bytes')::integer, 0), 0),
        coalesce(v_entry->'budget_reservation', '{}'::jsonb),
        v_snapshot_id, v_skill_name, v_bundle_hash, v_resource_path
      ) returning id into v_audit_id;
      v_written := v_written + 1;

      -- 一次成功的 `skill` 调用就是一次技能加载：派生一行调用审计。
      if v_entry->>'tool_name' = 'skill'
         and coalesce(v_entry->>'permission_verdict', 'ALLOW') = 'ALLOW'
         and v_skill_name is not null then
        insert into public.analysis_skill_invocation (
          agent_run_id, agent_node_id, skill_snapshot_id, skill_name,
          skill_version, bundle_hash, resource_relative_path, invoked_at
        ) values (
          v_run_id, v_node_id, v_snapshot_id, v_skill_name,
          (select source_version from public.analysis_job_skill_snapshot
            where id = v_snapshot_id),
          coalesce(v_bundle_hash, ''),
          v_resource_path,
          coalesce((v_entry->>'started_at')::timestamptz, now())
        );
      end if;
    end loop;
  end if;

  if jsonb_typeof(p_decisions) = 'array' then
    for v_entry in select * from jsonb_array_elements(p_decisions)
    loop
      insert into public.analysis_permission_decision (
        agent_run_id, agent_node_id, agent_role, tool_name,
        policy_layer, decision, reason_code, policy_hash
      ) values (
        v_run_id,
        (select id from public.analysis_agent_node
          where agent_run_id = v_run_id and agent_id = v_entry->>'agent_id'),
        coalesce(v_entry->>'agent_role', 'root-reviewer'),
        v_entry->>'tool_name',
        coalesce(v_entry->>'policy_layer', 'broker'),
        coalesce(v_entry->>'decision', 'DENY'),
        coalesce(v_entry->>'reason_code', 'UNSPECIFIED'),
        v_entry->>'policy_hash'
      );
      v_written := v_written + 1;
    end loop;
  end if;

  return v_written;
end;
$$;

------------------------------------------------------------------------------
-- 16. staging 清理
------------------------------------------------------------------------------

create or replace function public.expire_review_skill_uploads(p_limit integer default 500)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_keys jsonb;
begin
  with expired as (
    select id, staging_bucket, staging_object_key
    from public.review_skill_upload
    where status in ('PENDING', 'VALIDATED', 'FAILED')
      and expires_at < now()
    order by expires_at
    limit greatest(coalesce(p_limit, 500), 1)
  ), marked as (
    update public.review_skill_upload upload
    set status = 'EXPIRED'
    where upload.id in (select id from expired)
    returning upload.staging_bucket, upload.staging_object_key
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'bucket', staging_bucket, 'object_key', staging_object_key
  )), '[]'::jsonb) into v_keys
  from marked;

  -- 只返回要删的 key：删对象要走 Storage API，数据库不该假装自己能做这件事。
  return jsonb_build_object('objects', v_keys);
end;
$$;

------------------------------------------------------------------------------
-- 17. 权限
------------------------------------------------------------------------------

revoke execute on function public.admin_create_review_skill(uuid, text, text)
from public, anon, authenticated;
grant execute on function public.admin_create_review_skill(uuid, text, text) to service_role;

revoke execute on function public.admin_register_skill_upload(uuid, uuid, text)
from public, anon, authenticated;
grant execute on function public.admin_register_skill_upload(uuid, uuid, text) to service_role;

revoke execute on function public.admin_record_skill_upload_validation(
  uuid, uuid, text, bigint, jsonb, bigint, integer, boolean, jsonb
) from public, anon, authenticated;
grant execute on function public.admin_record_skill_upload_validation(
  uuid, uuid, text, bigint, jsonb, bigint, integer, boolean, jsonb
) to service_role;

revoke execute on function public.admin_record_skill_upload_failure(uuid, uuid, text, text)
from public, anon, authenticated;
grant execute on function public.admin_record_skill_upload_failure(uuid, uuid, text, text)
to service_role;

revoke execute on function public.admin_publish_review_skill_version(
  uuid, uuid, text, boolean
) from public, anon, authenticated;
grant execute on function public.admin_publish_review_skill_version(
  uuid, uuid, text, boolean
) to service_role;

revoke execute on function public.admin_get_skill_version_locator(uuid, uuid)
from public, anon, authenticated;
grant execute on function public.admin_get_skill_version_locator(uuid, uuid) to service_role;

revoke execute on function public.admin_get_skill_upload(uuid, uuid)
from public, anon, authenticated;
grant execute on function public.admin_get_skill_upload(uuid, uuid) to service_role;

revoke execute on function public.admin_set_review_skill_enabled(uuid, uuid, boolean)
from public, anon, authenticated;
grant execute on function public.admin_set_review_skill_enabled(uuid, uuid, boolean)
to service_role;

revoke execute on function public.admin_disable_review_skill(uuid, uuid)
from public, anon, authenticated;
grant execute on function public.admin_disable_review_skill(uuid, uuid) to service_role;

-- 列表与详情由浏览器直接调用：它们只读、且函数体第一句就是 ensure_admin()。
revoke execute on function public.admin_list_review_skills() from public, anon;
grant execute on function public.admin_list_review_skills() to authenticated, service_role;

revoke execute on function public.admin_get_review_skill(uuid) from public, anon;
grant execute on function public.admin_get_review_skill(uuid) to authenticated, service_role;

-- Worker only。这条绝不能给 authenticated：它返回冻结 locator。
revoke execute on function public.get_story_task_skill_snapshot(uuid, text, uuid)
from public, anon, authenticated;
grant execute on function public.get_story_task_skill_snapshot(uuid, text, uuid) to service_role;

revoke execute on function public.freeze_analysis_job_skill_catalog(uuid)
from public, anon, authenticated;
grant execute on function public.freeze_analysis_job_skill_catalog(uuid) to service_role;

revoke execute on function public.current_skill_catalog_entries()
from public, anon, authenticated;
grant execute on function public.current_skill_catalog_entries() to service_role;

revoke execute on function public.current_skill_catalog_hash() from public, anon;
grant execute on function public.current_skill_catalog_hash() to authenticated, service_role;

revoke execute on function public.expire_review_skill_uploads(integer)
from public, anon, authenticated;
grant execute on function public.expire_review_skill_uploads(integer) to service_role;

revoke execute on function public.protect_referenced_skill_objects()
from public, anon, authenticated;

revoke execute on function public.record_analysis_attempt_profile(
  uuid, text, uuid, integer, text, text, text, text, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.record_analysis_attempt_profile(
  uuid, text, uuid, integer, text, text, text, text, text, text, text, text
) to service_role;

revoke execute on function public.save_analysis_session_checkpoint(
  uuid, text, uuid, integer, text, integer, text, text, integer, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.save_analysis_session_checkpoint(
  uuid, text, uuid, integer, text, integer, text, text, integer, text, text, text, text
) to service_role;

grant execute on function public.is_valid_skill_name(text) to authenticated, service_role;
grant execute on function public.skill_bundle_limits() to authenticated, service_role;
revoke execute on function public.skill_bundle_hash(jsonb) from public, anon;
grant execute on function public.skill_bundle_hash(jsonb) to service_role;
revoke execute on function public.skill_bundle_hash_input(jsonb) from public, anon;
grant execute on function public.skill_bundle_hash_input(jsonb) to service_role;
revoke execute on function public.skill_catalog_hash(jsonb) from public, anon;
grant execute on function public.skill_catalog_hash(jsonb) to service_role;
grant execute on function public.empty_skill_catalog_hash() to authenticated, service_role;
