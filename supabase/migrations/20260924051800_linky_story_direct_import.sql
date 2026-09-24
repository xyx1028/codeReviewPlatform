-- V1.20：用户故事直连 Linky（镜像 + 同步队列 + 冻结附件）。
--
-- 三层数据，边界刻意分开：
--
--   上游  Linky 取数接口（内网/VPN 专属，只有 Worker 所在的网络能到）
--   镜像  linky_story_catalog(+_attachment) + bucket story-attachments
--         —— Worker 用 service-role 写，前端只读。看板的全部筛选与分面都查它，
--            所以 Linky 挂掉、或使用者不在内网时，看板依然可用。
--   冻结  review_story(+_attachment) —— 导入那一刻从镜像复制，批次内不可变。
--         分析链路只读冻结层，上游后续改动不会让在跑的批次含义漂移
--         （与 repo commit SHA、技能目录冻结是同一条原则）。
--
-- 附件字节只存一份：冻结层的 storage_path 直接引用镜像层那个对象，不拷贝字节；
-- 被任何批次引用的对象永不删除（同"技能版本被 Job 快照引用即不可删"）。
-- 导入时记下 sha256，Worker 物化到 attempt workspace 时重算比对，不符即 fail closed。

begin;

------------------------------------------------------------------------------
-- 1. 镜像层：Linky 用户故事目录
------------------------------------------------------------------------------

create table if not exists public.linky_story_catalog (
  -- Linky issue 的 UUID。它是唯一稳定标识：story_code 可读但按工作区计数，
  -- 跨工作区可能重复。
  issue_id uuid primary key,
  story_code text not null,
  title text not null,
  workspace_id uuid not null,
  workspace_name text not null,
  -- 列表端点给的可读状态（详情端点给的是内部码，不能用）。
  status_label text,
  assignee_name text,
  -- iteration / release_window / subject 的**可读名只有列表端点有**，
  -- 详情里只有 tf_* 的 UUID。所以同步必须列表 + 详情两份数据合并。
  iteration text,
  release_window text,
  subject_name text,
  -- 需求正文。实测上游 description 恒空，正文在 field_values.gf_description。
  requirement_detail text,
  -- {"req":[{"id","name"}],"dev":[...],"test":[...]}；解析失败时为 null。
  team jsonb,
  team_resolve_error text,
  -- 回链 Linky 的地址。上游不提供，由 Worker 在配了 LINKY_WEB_BASE_URL 时拼出；
  -- 没配就是 null，前端隐藏链接 —— 不编造 URL。
  story_url text,
  raw jsonb not null default '{}'::jsonb,
  list_synced_at timestamptz not null default now(),
  detail_synced_at timestamptz,
  attachment_count integer not null default 0 check (attachment_count >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, story_code)
);

create index if not exists linky_story_catalog_workspace_idx
  on public.linky_story_catalog(workspace_name, release_window, story_code);
create index if not exists linky_story_catalog_code_idx
  on public.linky_story_catalog(story_code);

create table if not exists public.linky_story_catalog_attachment (
  id uuid primary key default gen_random_uuid(),
  issue_id uuid not null references public.linky_story_catalog(issue_id) on delete cascade,
  linky_attachment_id text not null,
  filename text not null,
  content_type text,
  size_bytes bigint check (size_bytes is null or size_bytes >= 0),
  storage_path text,
  content_sha256 text,
  fetch_status text not null default 'PENDING'
    check (fetch_status in ('PENDING', 'STORED', 'SKIPPED', 'FAILED')),
  fetch_error text,
  synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (issue_id, linky_attachment_id)
);

create index if not exists linky_story_catalog_attachment_status_idx
  on public.linky_story_catalog_attachment(fetch_status, synced_at);

------------------------------------------------------------------------------
-- 2. 同步队列（结构与命名沿用 20260917030000 模型连接测试队列）
------------------------------------------------------------------------------

create table if not exists public.linky_sync_request (
  id uuid primary key default gen_random_uuid(),
  -- LIST：只抓列表（便宜，用于刷新组/窗口分面）。
  -- FULL：列表 + 详情 + 附件字节，按 release_window 限定范围，
  --       避免一次拉几百条详情。
  depth text not null check (depth in ('LIST', 'FULL')),
  workspace_id uuid,
  workspace_name text,
  release_window text,
  -- 幂等合并用的归一化范围键，由 enqueue 计算。
  scope_key text not null,
  status text not null default 'QUEUED'
    check (status in ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED')),
  attempt integer not null default 0 check (attempt >= 0),
  worker_id text,
  claim_token_digest text,
  lease_expires_at timestamptz,
  heartbeat_at timestamptz,
  stories_synced integer check (stories_synced is null or stories_synced >= 0),
  details_synced integer check (details_synced is null or details_synced >= 0),
  attachments_stored integer check (attachments_stored is null or attachments_stored >= 0),
  attachments_failed integer check (attachments_failed is null or attachments_failed >= 0),
  bytes_downloaded bigint check (bytes_downloaded is null or bytes_downloaded >= 0),
  error_code text,
  error_message text,
  requested_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz not null default now()
);

create index if not exists linky_sync_request_queue_idx
  on public.linky_sync_request(status, created_at);
create unique index if not exists linky_sync_request_one_active_scope_idx
  on public.linky_sync_request(scope_key)
  where status in ('QUEUED', 'RUNNING');

------------------------------------------------------------------------------
-- 3. 冻结层：review_story 结构化列 + 需求附件
------------------------------------------------------------------------------

alter table public.review_story
  add column if not exists source_system text not null default 'EXCEL',
  add column if not exists requirement_detail text,
  add column if not exists subject_name text,
  add column if not exists linky_issue_id uuid,
  add column if not exists linky_workspace_id uuid,
  add column if not exists linky_workspace_name text,
  add column if not exists story_url text,
  add column if not exists synced_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'review_story_source_system_check'
  ) then
    alter table public.review_story
      add constraint review_story_source_system_check
      check (source_system in ('EXCEL', 'LINKY'));
  end if;
end $$;

create index if not exists review_story_linky_issue_idx
  on public.review_story(linky_issue_id)
  where linky_issue_id is not null;

comment on column public.review_story.source_system is
  '需求来源通道：EXCEL 为 V1.20 之前的 Excel 导入（历史批次），LINKY 为直连接口导入。';
comment on column public.review_story.requirement_detail is
  '需求正文。LINKY 来源取自 field_values.gf_description；Excel 历史批次为 null，'
  '冻结时回退到 source_data->''详细描述''。';
-- 0039 把 iteration_name 标为"已停用"，理由是 Excel 侧供不上值。V1.20 起
-- Linky 列表端点直接给可读迭代名，于是这一列重新启用 —— 语义和当初一致，
-- 不新造 iteration_label 这类同义列。
comment on column public.review_story.iteration_name is
  '迭代阶段可读名。V1.20 起由 Linky 列表的 iteration 写入；Excel 历史批次可能为空。';
comment on column public.review_story.project_name is
  '所属项目。LINKY 来源写入 Linky 工作区名（项目组），保持既有统计看板与提示词字段可用。';

create table if not exists public.review_story_attachment (
  id uuid primary key default gen_random_uuid(),
  story_id uuid not null references public.review_story(id) on delete cascade,
  linky_attachment_id text not null,
  filename text not null,
  content_type text,
  size_bytes bigint check (size_bytes is null or size_bytes >= 0),
  -- 引用镜像层对象，不拷贝字节。
  storage_path text not null,
  content_sha256 text not null,
  created_at timestamptz not null default now(),
  unique (story_id, linky_attachment_id)
);

create index if not exists review_story_attachment_storage_idx
  on public.review_story_attachment(storage_path);

------------------------------------------------------------------------------
-- 4. RLS：镜像与附件对登录用户只读，写只走 definer RPC / service_role
------------------------------------------------------------------------------

alter table public.linky_story_catalog enable row level security;
alter table public.linky_story_catalog_attachment enable row level security;
alter table public.linky_sync_request enable row level security;
alter table public.review_story_attachment enable row level security;

revoke all on table public.linky_story_catalog from anon;
revoke all on table public.linky_story_catalog_attachment from anon;
revoke all on table public.linky_sync_request from anon;
revoke all on table public.review_story_attachment from anon;

revoke insert, update, delete, truncate on table public.linky_story_catalog from authenticated;
revoke insert, update, delete, truncate on table public.linky_story_catalog_attachment from authenticated;
revoke insert, update, delete, truncate on table public.linky_sync_request from authenticated;
revoke insert, update, delete, truncate on table public.review_story_attachment from authenticated;

grant select on table public.linky_story_catalog to authenticated;
grant select on table public.linky_story_catalog_attachment to authenticated;
grant select on table public.linky_sync_request to authenticated;
grant select on table public.review_story_attachment to authenticated;

grant all on table public.linky_story_catalog to service_role;
grant all on table public.linky_story_catalog_attachment to service_role;
grant all on table public.linky_sync_request to service_role;
grant all on table public.review_story_attachment to service_role;

drop policy if exists "authenticated read linky catalog" on public.linky_story_catalog;
create policy "authenticated read linky catalog" on public.linky_story_catalog
  for select to authenticated using (true);

drop policy if exists "authenticated read linky catalog attachments"
  on public.linky_story_catalog_attachment;
create policy "authenticated read linky catalog attachments" on public.linky_story_catalog_attachment
  for select to authenticated using (true);

-- 看板要显示"上次同步什么时候、成功没有、失败原因是什么"，所以队列行对登录用户可读。
-- 队列里不存任何秘密（claim_token 只存摘要，且这一列不在前端读取的列清单里）。
drop policy if exists "authenticated read linky sync requests" on public.linky_sync_request;
create policy "authenticated read linky sync requests" on public.linky_sync_request
  for select to authenticated using (true);

drop policy if exists "authenticated read review story attachments" on public.review_story_attachment;
create policy "authenticated read review story attachments" on public.review_story_attachment
  for select to authenticated using (true);

------------------------------------------------------------------------------
-- 5. Storage：需求附件私有 bucket
------------------------------------------------------------------------------

insert into storage.buckets (id, name, public)
values ('story-attachments', 'story-attachments', false)
on conflict (id) do update set public = false;

-- 读：登录用户可读（前端用 60 秒 signed URL 下载，与 review-files 同一套做法）。
drop policy if exists "authenticated read story attachments" on storage.objects;
create policy "authenticated read story attachments" on storage.objects
  for select to authenticated using (bucket_id = 'story-attachments');

-- 写：不给任何 authenticated 策略。附件只由 Worker 以 service-role 写入，
-- 对象 key 由服务端生成，浏览器无法投放任意文件。
drop policy if exists "authenticated write story attachments" on storage.objects;

create or replace function public.protect_referenced_story_attachment_objects()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.bucket_id <> 'story-attachments' then
    return old;
  end if;
  if exists (
    select 1 from public.review_story_attachment attachment
    where attachment.storage_path = old.name
  ) then
    raise exception 'STORY_ATTACHMENT_OBJECT_REFERENCED';
  end if;
  return old;
end;
$$;

-- storage.objects 属于 supabase_storage_admin，迁移未必有权建触发器（托管环境与
-- 本地 CLI 的角色不同）。失败只发通知：第一道保护仍是"没有 DELETE 策略 + key 由
-- 服务端生成"，触发器是加固。
do $$
begin
  begin
    drop trigger if exists protect_referenced_story_attachment_objects on storage.objects;
    create trigger protect_referenced_story_attachment_objects
    before delete on storage.objects
    for each row execute function public.protect_referenced_story_attachment_objects();
  exception
    when insufficient_privilege or undefined_table then
      raise notice
        'story-attachments object deletion guard not installed (insufficient privilege on '
        'storage.objects); retention relies on the absence of DELETE policies plus '
        'server-generated keys';
  end;
end $$;

------------------------------------------------------------------------------
-- 6. 辅助函数
------------------------------------------------------------------------------

-- team 里的姓名拼成平台既有的 owners_text 形式（顿号分隔）。
-- team 为 null（team_resolve_error 非空）时返回 null —— 绝不编造人名。
create or replace function public.linky_team_names(p_team jsonb, p_role text)
returns text
language sql
immutable
set search_path = public
as $$
  select nullif(
    string_agg(member.name, '、' order by member.ordinality),
    ''
  )
  from jsonb_array_elements(
    case
      when p_team is null or jsonb_typeof(p_team -> p_role) <> 'array' then '[]'::jsonb
      else p_team -> p_role
    end
  ) with ordinality as entry(value, ordinality)
  cross join lateral (
    select btrim(coalesce(entry.value ->> 'name', '')) as name, entry.ordinality
  ) member
  where member.name <> '';
$$;

-- 冻结需求快照时送给模型的需求上下文。
--
-- 只有这一个地方定义它：freeze_analysis_job_scope_inputs 里 requirement_context 与
-- input_hash 两处都调用它，避免两份表达式漂移（V1.11 就是靠人工保持一致的）。
--
-- LINKY 来源读结构化列；EXCEL 历史批次回退到 source_data 里的中文列名，
-- 因此旧批次重跑冻结的行为与 V1.20 之前完全一致。
create or replace function public.review_story_requirement_context(p_story public.review_story)
returns jsonb
language sql
stable
set search_path = public
as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'detailed_description', coalesce(
      to_jsonb(nullif(btrim(coalesce(p_story.requirement_detail, '')), '')),
      p_story.source_data -> '详细描述'
    ),
    'related_features', coalesce(
      to_jsonb(nullif(btrim(coalesce(p_story.subject_name, '')), '')),
      p_story.source_data -> '关联特性'
    ),
    'source_status', to_jsonb(p_story.source_status),
    'iteration', to_jsonb(nullif(btrim(coalesce(p_story.iteration_name, '')), '')),
    'attachments', (
      select jsonb_agg(
        jsonb_build_object(
          'filename', attachment.filename,
          'content_type', attachment.content_type,
          'size_bytes', attachment.size_bytes,
          'sha256', attachment.content_sha256,
          'storage_path', attachment.storage_path
        )
        order by attachment.filename, attachment.linky_attachment_id
      )
      from public.review_story_attachment attachment
      where attachment.story_id = p_story.id
    )
  ));
$$;

create or replace function public.linky_catalog_attachment_is_referenced(p_storage_path text)
returns boolean
language sql
stable
set search_path = public
as $$
  select exists (
    select 1 from public.review_story_attachment attachment
    where attachment.storage_path = p_storage_path
  );
$$;

create or replace function public.linky_sync_scope_key(
  p_depth text,
  p_workspace_id uuid,
  p_workspace_name text,
  p_release_window text
)
returns text
language sql
immutable
set search_path = public
as $$
  select concat_ws(
    '|',
    coalesce(p_depth, ''),
    coalesce(p_workspace_id::text, ''),
    lower(btrim(coalesce(p_workspace_name, ''))),
    btrim(coalesce(p_release_window, ''))
  );
$$;

-- 队列租约校验。claim_token 只以 sha256 摘要存库，和既有队列同一套。
create or replace function public.assert_linky_sync_claim(
  p_sync_id uuid,
  p_worker_id text,
  p_claim_token uuid
)
returns public.linky_sync_request
language plpgsql
security definer
set search_path = public
as $$
declare
  v_request public.linky_sync_request;
begin
  select * into v_request from public.linky_sync_request where id = p_sync_id for update;
  if v_request.id is null then
    raise exception 'LINKY_SYNC_NOT_FOUND';
  end if;
  if v_request.status <> 'RUNNING'
     or v_request.worker_id is distinct from p_worker_id
     or v_request.lease_expires_at is null
     or v_request.lease_expires_at < now()
     or p_claim_token is null
     or v_request.claim_token_digest is distinct from public.agent_claim_token_digest(p_claim_token)
  then
    raise exception 'LINKY_SYNC_LEASE_LOST';
  end if;
  return v_request;
end;
$$;

------------------------------------------------------------------------------
-- 7. 用户侧 RPC
------------------------------------------------------------------------------

-- 触发一次同步。
--
-- 幂等合并：同范围已有 QUEUED/RUNNING 时直接返回那一行的 id，而不是排第二条 ——
-- 看板上多人同时点刷新是常态。
-- 冷却：同一用户 30 秒内只允许发起一次新请求，防止把上游打爆。
create or replace function public.enqueue_linky_sync(
  p_depth text,
  p_workspace_id uuid default null,
  p_workspace_name text default null,
  p_release_window text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_depth text := upper(btrim(coalesce(p_depth, '')));
  v_workspace_name text := nullif(btrim(coalesce(p_workspace_name, '')), '');
  v_release_window text := nullif(btrim(coalesce(p_release_window, '')), '');
  v_scope_key text;
  v_existing uuid;
  v_id uuid;
begin
  if not public.can_create_review_batch() then
    raise exception 'LINKY_SYNC_FORBIDDEN';
  end if;
  if v_depth not in ('LIST', 'FULL') then
    raise exception 'LINKY_SYNC_DEPTH_INVALID';
  end if;
  if v_depth = 'FULL' and p_workspace_id is null and v_workspace_name is null then
    -- FULL 会逐条取详情与附件。不限定工作区就是"把所有工作区的所有故事拉一遍"，
    -- 那不是刷新，那是压测。
    raise exception 'LINKY_SYNC_SCOPE_REQUIRED';
  end if;

  v_scope_key := public.linky_sync_scope_key(
    v_depth, p_workspace_id, v_workspace_name, v_release_window
  );
  perform pg_advisory_xact_lock(hashtext('linky_sync:' || v_scope_key));

  select request.id into v_existing
  from public.linky_sync_request request
  where request.scope_key = v_scope_key
    and request.status in ('QUEUED', 'RUNNING')
  order by request.created_at desc
  limit 1;
  if v_existing is not null then
    return v_existing;
  end if;

  if exists (
    select 1 from public.linky_sync_request request
    where request.requested_by = auth.uid()
      and request.created_at > now() - interval '30 seconds'
  ) then
    raise exception 'LINKY_SYNC_TOO_FREQUENT';
  end if;

  insert into public.linky_sync_request (
    depth, workspace_id, workspace_name, release_window, scope_key, requested_by
  ) values (
    v_depth, p_workspace_id, v_workspace_name, v_release_window, v_scope_key, auth.uid()
  )
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.get_linky_sync(p_sync_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_request public.linky_sync_request;
begin
  select * into v_request from public.linky_sync_request where id = p_sync_id;
  if v_request.id is null then
    raise exception 'LINKY_SYNC_NOT_FOUND';
  end if;
  return to_jsonb(v_request) - 'claim_token_digest';
end;
$$;

-- 看板分面。266 条量级下完全可以前端算，但组/窗口/迭代/状态四组计数用 SQL
-- group by 更直接，也避免把 requirement_detail 这种大字段拉到浏览器只为了数个数。
create or replace function public.get_linky_catalog_facets(p_workspace_id uuid default null)
returns jsonb
language sql
security definer
set search_path = public
stable
as $$
  with scoped as (
    select * from public.linky_story_catalog
    where p_workspace_id is null or workspace_id = p_workspace_id
  )
  select jsonb_build_object(
    'total', (select count(*) from scoped),
    'workspaces', coalesce((
      select jsonb_agg(entry order by entry ->> 'workspace_name')
      from (
        select jsonb_build_object(
          'workspace_id', workspace_id,
          'workspace_name', workspace_name,
          'count', count(*),
          'list_synced_at', max(list_synced_at),
          'detail_synced_at', max(detail_synced_at)
        ) as entry
        from public.linky_story_catalog
        group by workspace_id, workspace_name
      ) workspaces
    ), '[]'::jsonb),
    'release_windows', coalesce((
      select jsonb_agg(entry order by entry ->> 'value' desc)
      from (
        select jsonb_build_object('value', coalesce(nullif(release_window, ''), ''), 'count', count(*)) as entry
        from scoped group by coalesce(nullif(release_window, ''), '')
      ) windows
    ), '[]'::jsonb),
    'iterations', coalesce((
      select jsonb_agg(entry order by entry ->> 'value' desc)
      from (
        select jsonb_build_object('value', coalesce(nullif(iteration, ''), ''), 'count', count(*)) as entry
        from scoped group by coalesce(nullif(iteration, ''), '')
      ) iterations
    ), '[]'::jsonb),
    'statuses', coalesce((
      select jsonb_agg(entry order by entry ->> 'value')
      from (
        select jsonb_build_object('value', coalesce(nullif(status_label, ''), ''), 'count', count(*)) as entry
        from scoped group by coalesce(nullif(status_label, ''), '')
      ) statuses
    ), '[]'::jsonb),
    'assignees', coalesce((
      select jsonb_agg(entry order by entry ->> 'value')
      from (
        select jsonb_build_object('value', coalesce(nullif(assignee_name, ''), ''), 'count', count(*)) as entry
        from scoped group by coalesce(nullif(assignee_name, ''), '')
      ) assignees
    ), '[]'::jsonb)
  );
$$;

-- 从镜像导入到批次：纯 SQL 复制，不下载任何东西。
--
-- 拒绝条件写在这里而不是前端：批次只读、已有 AI 结果、有在途 job、故事没做过
-- FULL 同步（正文会是空的）、附件还没落盘。每一条都返回稳定错误码。
create or replace function public.import_linky_stories_from_catalog(
  p_batch_id uuid,
  p_issue_ids uuid[],
  p_allow_missing_attachments boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_batch public.review_batch;
  v_requested integer;
  v_found integer;
  v_missing_detail integer;
  v_pending_attachments integer;
  v_inserted integer := 0;
  v_updated integer := 0;
  v_attachments integer := 0;
begin
  perform public.ensure_manage_review_batch(p_batch_id);

  if p_issue_ids is null or array_length(p_issue_ids, 1) is null then
    raise exception 'LINKY_IMPORT_EMPTY_SELECTION';
  end if;
  v_requested := array_length(p_issue_ids, 1);

  select * into v_batch from public.review_batch where id = p_batch_id for update;
  if v_batch.id is null then
    raise exception 'batch not found';
  end if;
  if v_batch.status = 'COMPLETED' then
    raise exception 'BATCH_READ_ONLY';
  end if;
  if exists (select 1 from public.ai_import_record where batch_id = p_batch_id) then
    raise exception 'BATCH_READ_ONLY';
  end if;
  if exists (
    select 1 from public.analysis_job
    where batch_id = p_batch_id
      and status in ('QUEUED', 'PREPARING_CODE', 'PREPARING_SCOPE', 'PROCESSING', 'FINALIZING')
  ) then
    raise exception 'ACTIVE_JOB_EXISTS';
  end if;

  select count(*) into v_found
  from public.linky_story_catalog catalog
  where catalog.issue_id = any(p_issue_ids);
  if v_found <> v_requested then
    raise exception 'LINKY_STORY_NOT_IN_CATALOG';
  end if;

  select count(*) into v_missing_detail
  from public.linky_story_catalog catalog
  where catalog.issue_id = any(p_issue_ids)
    and (catalog.detail_synced_at is null
         or btrim(coalesce(catalog.requirement_detail, '')) = '');
  if v_missing_detail > 0 then
    -- 没有正文的故事导进去，AI 又要在不知道需求内容的情况下判断代码 ——
    -- 这正是 V1.20 要消灭的状态，所以这里直接拒绝，让用户先刷 FULL。
    raise exception 'LINKY_DETAIL_NOT_SYNCED';
  end if;

  select count(*) into v_pending_attachments
  from public.linky_story_catalog_attachment attachment
  where attachment.issue_id = any(p_issue_ids)
    and attachment.fetch_status in ('PENDING', 'FAILED');
  if v_pending_attachments > 0 and not coalesce(p_allow_missing_attachments, false) then
    raise exception 'LINKY_ATTACHMENTS_NOT_READY';
  end if;

  with source as (
    select catalog.* from public.linky_story_catalog catalog
    where catalog.issue_id = any(p_issue_ids)
  ),
  upserted as (
    insert into public.review_story (
      batch_id, story_code, story_name, owners_text, requirement_handlers, test_handlers,
      project_name, iteration_name, release_window, source_status, source_data,
      source_system, requirement_detail, subject_name, linky_issue_id,
      linky_workspace_id, linky_workspace_name, story_url, synced_at
    )
    select
      p_batch_id,
      source.story_code,
      source.title,
      coalesce(
        nullif(public.linky_team_names(source.team, 'dev'), ''),
        nullif(btrim(coalesce(source.assignee_name, '')), ''),
        '未分配'
      ),
      public.linky_team_names(source.team, 'req'),
      public.linky_team_names(source.team, 'test'),
      source.workspace_name,
      nullif(btrim(coalesce(source.iteration, '')), ''),
      nullif(btrim(coalesce(source.release_window, '')), ''),
      nullif(btrim(coalesce(source.status_label, '')), ''),
      jsonb_strip_nulls(jsonb_build_object(
        'source', 'LINKY',
        'linky_issue_id', to_jsonb(source.issue_id),
        'workspace_id', to_jsonb(source.workspace_id),
        'workspace_name', to_jsonb(source.workspace_name),
        'iteration', to_jsonb(nullif(btrim(coalesce(source.iteration, '')), '')),
        'release_window', to_jsonb(nullif(btrim(coalesce(source.release_window, '')), '')),
        'subject', to_jsonb(nullif(btrim(coalesce(source.subject_name, '')), '')),
        'status_label', to_jsonb(nullif(btrim(coalesce(source.status_label, '')), '')),
        'assignee', to_jsonb(nullif(btrim(coalesce(source.assignee_name, '')), '')),
        'team', source.team,
        'team_resolve_error', to_jsonb(source.team_resolve_error),
        'field_values', source.raw -> 'field_values',
        'list_item', source.raw -> 'list_item'
      )),
      'LINKY',
      source.requirement_detail,
      nullif(btrim(coalesce(source.subject_name, '')), ''),
      source.issue_id,
      source.workspace_id,
      source.workspace_name,
      source.story_url,
      coalesce(source.detail_synced_at, now())
    from source
    on conflict (batch_id, story_code) do update set
      story_name = excluded.story_name,
      owners_text = excluded.owners_text,
      requirement_handlers = excluded.requirement_handlers,
      test_handlers = excluded.test_handlers,
      project_name = excluded.project_name,
      iteration_name = excluded.iteration_name,
      release_window = excluded.release_window,
      source_status = excluded.source_status,
      source_data = excluded.source_data,
      source_system = excluded.source_system,
      requirement_detail = excluded.requirement_detail,
      subject_name = excluded.subject_name,
      linky_issue_id = excluded.linky_issue_id,
      linky_workspace_id = excluded.linky_workspace_id,
      linky_workspace_name = excluded.linky_workspace_name,
      story_url = excluded.story_url,
      synced_at = excluded.synced_at,
      updated_at = now()
    returning id, (xmax = 0) as inserted
  )
  select
    count(*) filter (where inserted),
    count(*) filter (where not inserted)
  into v_inserted, v_updated
  from upserted;

  -- 附件按"当前镜像状态"整段重放：删掉不再存在的，写入已落盘的。
  delete from public.review_story_attachment attachment
  using public.review_story story
  where attachment.story_id = story.id
    and story.batch_id = p_batch_id
    and story.linky_issue_id = any(p_issue_ids);

  insert into public.review_story_attachment (
    story_id, linky_attachment_id, filename, content_type, size_bytes,
    storage_path, content_sha256
  )
  select story.id, source.linky_attachment_id, source.filename, source.content_type,
         source.size_bytes, source.storage_path, source.content_sha256
  from public.linky_story_catalog_attachment source
  join public.review_story story
    on story.batch_id = p_batch_id and story.linky_issue_id = source.issue_id
  where source.issue_id = any(p_issue_ids)
    and source.fetch_status = 'STORED'
    and source.storage_path is not null
    and source.content_sha256 is not null;
  v_attachments := (
    select count(*)
    from public.review_story_attachment attachment
    join public.review_story story on story.id = attachment.story_id
    where story.batch_id = p_batch_id and story.linky_issue_id = any(p_issue_ids)
  );

  update public.review_batch
  set status = 'WAITING_AI_RESULT', updated_at = now()
  where id = p_batch_id and status in ('DRAFT', 'WAITING_AI_RESULT');

  return jsonb_build_object(
    'batch_id', p_batch_id,
    'requested', v_requested,
    'inserted', coalesce(v_inserted, 0),
    'updated', coalesce(v_updated, 0),
    'attachments', coalesce(v_attachments, 0),
    'attachments_missing', v_pending_attachments
  );
end;
$$;

------------------------------------------------------------------------------
-- 8. Worker 侧 RPC（全部只授 service_role）
------------------------------------------------------------------------------

create or replace function public.claim_next_linky_sync(
  p_worker_id text,
  p_lease_seconds integer default 600
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_request public.linky_sync_request;
  v_token uuid;
begin
  if p_worker_id is null or btrim(p_worker_id) = '' then
    raise exception 'worker_id is required';
  end if;
  if p_lease_seconds is null or p_lease_seconds < 60 then
    p_lease_seconds := 600;
  end if;

  select request.* into v_request
  from public.linky_sync_request request
  where request.status = 'QUEUED'
     or (request.status = 'RUNNING' and request.lease_expires_at < now())
  order by request.created_at
  for update skip locked
  limit 1;
  if v_request.id is null then
    return null;
  end if;

  v_token := gen_random_uuid();
  update public.linky_sync_request
  set status = 'RUNNING',
      attempt = attempt + 1,
      worker_id = p_worker_id,
      lease_expires_at = now() + make_interval(secs => p_lease_seconds),
      heartbeat_at = now(),
      claim_token_digest = public.agent_claim_token_digest(v_token),
      error_code = null,
      error_message = null,
      started_at = coalesce(started_at, now()),
      finished_at = null,
      updated_at = now()
  where id = v_request.id
  returning * into v_request;

  return (to_jsonb(v_request) - 'claim_token_digest' - 'requested_by')
    || jsonb_build_object('claim_token', v_token);
end;
$$;

create or replace function public.heartbeat_linky_sync(
  p_sync_id uuid,
  p_worker_id text,
  p_claim_token uuid,
  p_lease_seconds integer default 600
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ok boolean;
begin
  if p_claim_token is null then return false; end if;
  if p_lease_seconds is null or p_lease_seconds < 60 then p_lease_seconds := 600; end if;
  update public.linky_sync_request request
  set heartbeat_at = now(),
      lease_expires_at = now() + make_interval(secs => p_lease_seconds),
      updated_at = now()
  where request.id = p_sync_id
    and request.status = 'RUNNING'
    and request.worker_id = p_worker_id
    and request.lease_expires_at >= now()
    and request.claim_token_digest = public.agent_claim_token_digest(p_claim_token)
  returning true into v_ok;
  return coalesce(v_ok, false);
end;
$$;

-- 列表项批量 upsert。requirement_detail / team / 附件不在这里动 ——
-- LIST 深度不该把上一次 FULL 同步的正文抹掉。
create or replace function public.upsert_linky_story_catalog(
  p_sync_id uuid,
  p_worker_id text,
  p_claim_token uuid,
  p_items jsonb
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer := 0;
begin
  perform public.assert_linky_sync_claim(p_sync_id, p_worker_id, p_claim_token);
  if jsonb_typeof(p_items) <> 'array' then
    raise exception 'LINKY_ITEMS_INVALID';
  end if;
  if jsonb_array_length(p_items) = 0 then
    return 0;
  end if;

  insert into public.linky_story_catalog as target (
    issue_id, story_code, title, workspace_id, workspace_name, status_label,
    assignee_name, iteration, release_window, subject_name, story_url, raw, list_synced_at
  )
  select
    (item ->> 'issue_id')::uuid,
    btrim(item ->> 'story_code'),
    btrim(item ->> 'title'),
    (item ->> 'workspace_id')::uuid,
    btrim(item ->> 'workspace_name'),
    nullif(btrim(coalesce(item ->> 'status_label', '')), ''),
    nullif(btrim(coalesce(item ->> 'assignee_name', '')), ''),
    nullif(btrim(coalesce(item ->> 'iteration', '')), ''),
    nullif(btrim(coalesce(item ->> 'release_window', '')), ''),
    nullif(btrim(coalesce(item ->> 'subject_name', '')), ''),
    nullif(btrim(coalesce(item ->> 'story_url', '')), ''),
    jsonb_build_object('list_item', coalesce(item -> 'list_item', item)),
    now()
  from jsonb_array_elements(p_items) as entry(item)
  where coalesce(item ->> 'issue_id', '') <> ''
    and coalesce(item ->> 'story_code', '') <> ''
    and coalesce(item ->> 'workspace_id', '') <> ''
  on conflict (issue_id) do update set
    story_code = excluded.story_code,
    title = excluded.title,
    workspace_id = excluded.workspace_id,
    workspace_name = excluded.workspace_name,
    status_label = excluded.status_label,
    assignee_name = excluded.assignee_name,
    iteration = excluded.iteration,
    release_window = excluded.release_window,
    subject_name = excluded.subject_name,
    story_url = coalesce(excluded.story_url, target.story_url),
    raw = target.raw || excluded.raw,
    list_synced_at = excluded.list_synced_at,
    updated_at = now();

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- 详情 + 附件清单。返回"还需要下载字节的附件"，已经 STORED 的不再重复下载。
create or replace function public.upsert_linky_story_detail(
  p_sync_id uuid,
  p_worker_id text,
  p_claim_token uuid,
  p_issue_id uuid,
  p_detail jsonb,
  p_attachments jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pending jsonb;
begin
  perform public.assert_linky_sync_claim(p_sync_id, p_worker_id, p_claim_token);
  if p_issue_id is null then
    raise exception 'LINKY_ISSUE_ID_REQUIRED';
  end if;
  if not exists (select 1 from public.linky_story_catalog where issue_id = p_issue_id) then
    raise exception 'LINKY_STORY_NOT_IN_CATALOG';
  end if;

  update public.linky_story_catalog catalog
  set requirement_detail = nullif(btrim(coalesce(p_detail ->> 'requirement_detail', '')), ''),
      team = case when jsonb_typeof(p_detail -> 'team') = 'object' then p_detail -> 'team' else null end,
      team_resolve_error = nullif(btrim(coalesce(p_detail ->> 'team_resolve_error', '')), ''),
      story_url = coalesce(nullif(btrim(coalesce(p_detail ->> 'story_url', '')), ''), catalog.story_url),
      raw = catalog.raw || jsonb_build_object(
        'field_values', coalesce(p_detail -> 'field_values', '{}'::jsonb)
      ),
      detail_synced_at = now(),
      updated_at = now()
  where catalog.issue_id = p_issue_id;

  if jsonb_typeof(p_attachments) = 'array' then
    delete from public.linky_story_catalog_attachment attachment
    where attachment.issue_id = p_issue_id
      and attachment.linky_attachment_id not in (
        select btrim(item ->> 'linky_attachment_id')
        from jsonb_array_elements(p_attachments) as entry(item)
        where coalesce(item ->> 'linky_attachment_id', '') <> ''
      );

    insert into public.linky_story_catalog_attachment as target (
      issue_id, linky_attachment_id, filename, content_type, size_bytes, synced_at
    )
    select
      p_issue_id,
      btrim(item ->> 'linky_attachment_id'),
      btrim(item ->> 'filename'),
      nullif(btrim(coalesce(item ->> 'content_type', '')), ''),
      nullif(item ->> 'size_bytes', '')::bigint,
      now()
    from jsonb_array_elements(p_attachments) as entry(item)
    where coalesce(item ->> 'linky_attachment_id', '') <> ''
      and coalesce(item ->> 'filename', '') <> ''
    on conflict (issue_id, linky_attachment_id) do update set
      filename = excluded.filename,
      content_type = excluded.content_type,
      size_bytes = excluded.size_bytes,
      synced_at = excluded.synced_at,
      updated_at = now();
  else
    delete from public.linky_story_catalog_attachment where issue_id = p_issue_id;
  end if;

  update public.linky_story_catalog catalog
  set attachment_count = (
    select count(*) from public.linky_story_catalog_attachment attachment
    where attachment.issue_id = p_issue_id
  )
  where catalog.issue_id = p_issue_id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', attachment.id,
    'linky_attachment_id', attachment.linky_attachment_id,
    'filename', attachment.filename,
    'content_type', attachment.content_type,
    'size_bytes', attachment.size_bytes
  ) order by attachment.filename), '[]'::jsonb)
  into v_pending
  from public.linky_story_catalog_attachment attachment
  where attachment.issue_id = p_issue_id
    and (attachment.fetch_status <> 'STORED' or attachment.storage_path is null);

  return jsonb_build_object('pending_attachments', v_pending);
end;
$$;

create or replace function public.record_linky_catalog_attachment(
  p_sync_id uuid,
  p_worker_id text,
  p_claim_token uuid,
  p_attachment_id uuid,
  p_status text,
  p_storage_path text default null,
  p_sha256 text default null,
  p_size bigint default null,
  p_error text default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text := upper(btrim(coalesce(p_status, '')));
  v_ok boolean;
begin
  perform public.assert_linky_sync_claim(p_sync_id, p_worker_id, p_claim_token);
  if v_status not in ('STORED', 'SKIPPED', 'FAILED') then
    raise exception 'LINKY_ATTACHMENT_STATUS_INVALID';
  end if;
  if v_status = 'STORED'
     and (nullif(btrim(coalesce(p_storage_path, '')), '') is null
          or nullif(btrim(coalesce(p_sha256, '')), '') is null) then
    raise exception 'LINKY_ATTACHMENT_STORAGE_REQUIRED';
  end if;

  update public.linky_story_catalog_attachment attachment
  set fetch_status = v_status,
      storage_path = case when v_status = 'STORED' then btrim(p_storage_path) else attachment.storage_path end,
      content_sha256 = case when v_status = 'STORED' then lower(btrim(p_sha256)) else attachment.content_sha256 end,
      size_bytes = case when v_status = 'STORED' and p_size is not null then p_size else attachment.size_bytes end,
      fetch_error = case when v_status = 'STORED' then null else left(nullif(btrim(coalesce(p_error, '')), ''), 300) end,
      synced_at = now(),
      updated_at = now()
  where attachment.id = p_attachment_id
  returning true into v_ok;
  return coalesce(v_ok, false);
end;
$$;

create or replace function public.complete_linky_sync(
  p_sync_id uuid,
  p_worker_id text,
  p_claim_token uuid,
  p_stories_synced integer default 0,
  p_details_synced integer default 0,
  p_attachments_stored integer default 0,
  p_attachments_failed integer default 0,
  p_bytes_downloaded bigint default 0
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ok boolean;
begin
  update public.linky_sync_request request
  set status = 'SUCCEEDED',
      stories_synced = greatest(coalesce(p_stories_synced, 0), 0),
      details_synced = greatest(coalesce(p_details_synced, 0), 0),
      attachments_stored = greatest(coalesce(p_attachments_stored, 0), 0),
      attachments_failed = greatest(coalesce(p_attachments_failed, 0), 0),
      bytes_downloaded = greatest(coalesce(p_bytes_downloaded, 0), 0),
      error_code = null,
      error_message = null,
      worker_id = null,
      lease_expires_at = null,
      heartbeat_at = null,
      claim_token_digest = null,
      finished_at = now(),
      updated_at = now()
  where request.id = p_sync_id
    and request.status = 'RUNNING'
    and request.worker_id = p_worker_id
    and request.lease_expires_at >= now()
    and p_claim_token is not null
    and request.claim_token_digest = public.agent_claim_token_digest(p_claim_token)
  returning true into v_ok;
  return coalesce(v_ok, false);
end;
$$;

create or replace function public.fail_linky_sync(
  p_sync_id uuid,
  p_worker_id text,
  p_claim_token uuid,
  p_error_code text,
  p_error_message text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ok boolean;
begin
  update public.linky_sync_request request
  set status = 'FAILED',
      error_code = left(coalesce(nullif(btrim(coalesce(p_error_code, '')), ''), 'LINKY_SYNC_FAILED'), 80),
      error_message = left(coalesce(nullif(btrim(coalesce(p_error_message, '')), ''), 'Linky 同步失败'), 300),
      worker_id = null,
      lease_expires_at = null,
      heartbeat_at = null,
      claim_token_digest = null,
      finished_at = now(),
      updated_at = now()
  where request.id = p_sync_id
    and request.status = 'RUNNING'
    and request.worker_id = p_worker_id
    and p_claim_token is not null
    and request.claim_token_digest = public.agent_claim_token_digest(p_claim_token)
  returning true into v_ok;
  return coalesce(v_ok, false);
end;
$$;

create or replace function public.release_linky_sync_claim(
  p_sync_id uuid,
  p_worker_id text,
  p_claim_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ok boolean;
begin
  update public.linky_sync_request request
  set status = 'QUEUED',
      worker_id = null,
      lease_expires_at = null,
      heartbeat_at = null,
      claim_token_digest = null,
      updated_at = now()
  where request.id = p_sync_id
    and request.status = 'RUNNING'
    and request.worker_id = p_worker_id
    and p_claim_token is not null
    and request.claim_token_digest = public.agent_claim_token_digest(p_claim_token)
  returning true into v_ok;
  return coalesce(v_ok, false);
end;
$$;

-- 缓存清理：未被任何批次引用、且超过保留期的镜像附件对象可以删字节。
-- 元数据行保留，状态回到 PENDING，下一次 FULL 同步会重新下载。
create or replace function public.list_linky_catalog_attachments_for_cleanup(
  p_retention_days integer default 30,
  p_limit integer default 200
)
returns jsonb
language sql
security definer
set search_path = public
stable
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', attachment.id,
    'storage_path', attachment.storage_path
  ) order by attachment.synced_at), '[]'::jsonb)
  from public.linky_story_catalog_attachment attachment
  where attachment.fetch_status = 'STORED'
    and attachment.storage_path is not null
    and attachment.synced_at < now() - make_interval(days => greatest(coalesce(p_retention_days, 30), 1))
    and not public.linky_catalog_attachment_is_referenced(attachment.storage_path)
  limit greatest(coalesce(p_limit, 200), 1);
$$;

create or replace function public.mark_linky_catalog_attachment_purged(p_attachment_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ok boolean;
begin
  update public.linky_story_catalog_attachment attachment
  set fetch_status = 'PENDING',
      storage_path = null,
      content_sha256 = null,
      fetch_error = null,
      synced_at = now(),
      updated_at = now()
  where attachment.id = p_attachment_id
    and attachment.storage_path is not null
    and not public.linky_catalog_attachment_is_referenced(attachment.storage_path)
  returning true into v_ok;
  return coalesce(v_ok, false);
end;
$$;

------------------------------------------------------------------------------
-- 9. 需求快照冻结函数升级
--
-- 只改 requirement_context 与 input_hash 两处表达式：都改成调用
-- review_story_requirement_context(story)。其余逻辑与 20260919074759 一致。
------------------------------------------------------------------------------

create or replace function public.freeze_analysis_job_scope_inputs(p_job_id uuid, p_worker_id text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_job public.analysis_job;
  v_version public.analysis_attribution_rule_version;
  v_story_hash text;
  v_identity_hash text;
  v_previous_heads jsonb;
  v_payload jsonb;
begin
  v_job := public.assert_analysis_scope_job_writer(
    p_job_id,p_worker_id,array['PREPARING_CODE','PREPARING_SCOPE']
  );

  if v_job.attribution_rule_version_id is not null then
    select * into v_version
    from public.analysis_attribution_rule_version
    where id=v_job.attribution_rule_version_id and status='PUBLISHED';
  else
    select version.* into v_version
    from public.analysis_attribution_rule_set rule_set
    join public.analysis_attribution_rule_version version
      on version.id=rule_set.current_published_version_id
    where rule_set.rule_set_code='STORY_COMMIT_ATTRIBUTION'
      and rule_set.enabled and version.status='PUBLISHED';
  end if;
  if v_version.id is null then raise exception 'PUBLISHED_ATTRIBUTION_RULESET_REQUIRED'; end if;
  if v_version.ruleset_hash is distinct from public.attribution_rule_version_hash(v_version.id)
     or (v_job.ruleset_hash is not null and v_job.ruleset_hash is distinct from v_version.ruleset_hash) then
    raise exception 'ATTRIBUTION_RULESET_MISMATCH';
  end if;

  if v_job.previous_repository_heads is null then
    select jsonb_object_agg(repositories.repository_name, previous.head_sha order by repositories.repository_name)
    into v_previous_heads
    from (values
      ('kdmanage-backend'::text),('kdmanage-frontend'::text),
      ('tmanage-backend'::text),('tmanage-frontend'::text)
    ) repositories(repository_name)
    left join lateral (
      select coalesce(snapshot.head_sha,lower(snapshot.commit_sha)) as head_sha
      from public.analysis_job prior_job
      join public.analysis_repository_snapshot snapshot on snapshot.job_id=prior_job.id
      where prior_job.id<>v_job.id
        and prior_job.analysis_context_version=2
        and prior_job.status='SUCCEEDED'
        and prior_job.requested_branch=v_job.requested_branch
        and prior_job.created_at<v_job.created_at
        and snapshot.repository_name=repositories.repository_name
        and coalesce(snapshot.head_sha,lower(snapshot.commit_sha)) is not null
      order by prior_job.finished_at desc nulls last,prior_job.created_at desc,prior_job.id desc
      limit 1
    ) previous on true;
    update public.analysis_job
    set previous_repository_heads=v_previous_heads
    where id=p_job_id
    returning * into v_job;
  end if;

  if exists(select 1 from public.analysis_job_story_snapshot where job_id=p_job_id) then
    select story_input_catalog_hash,identity_snapshot_hash
      into v_story_hash,v_identity_hash
    from public.analysis_job where id=p_job_id;
    update public.analysis_job
    set status='PREPARING_SCOPE',scope_status='PREPARING',
        scope_requested_at=coalesce(scope_requested_at,now()),locked_at=now()
    where id=p_job_id and status in ('PREPARING_CODE','PREPARING_SCOPE');
    v_payload:=public.analysis_job_frozen_scope_input_payload(p_job_id);
    return jsonb_build_object(
      'story_input_catalog_hash',v_story_hash,
      'identity_snapshot_hash',v_identity_hash,
      'rule_version_id',v_version.id,
      'ruleset_hash',v_version.ruleset_hash,
      'idempotent',true
    ) || v_payload;
  end if;

  insert into public.analysis_job_story_snapshot(
    job_id,story_id,story_code,story_name,owners_text,normalized_developer_ids,
    project_name,application_name,release_window,requirement_context,input_hash
  )
  select p_job_id,story.id,story.story_code,story.story_name,story.owners_text,
    array(
      select distinct developer.id
      from public.developer_identity developer
      where developer.status='VERIFIED' and exists(
        select 1
        from regexp_split_to_table(story.owners_text,'[，,、；;]') as owner(owner_token)
        where btrim(owner.owner_token)=developer.display_name
           or (developer.employee_code is not null and btrim(owner.owner_token) in (
             developer.display_name||'（'||developer.employee_code||'）',
             developer.display_name||'('||developer.employee_code||')'
           ))
      ) order by developer.id
    ),story.project_name,story.application_name,story.release_window,
    public.review_story_requirement_context(story),
    encode(digest(convert_to(concat_ws(E'\n',story.story_code,story.story_name,story.owners_text,
      coalesce(story.project_name,''),coalesce(story.application_name,''),
      coalesce(story.release_window,''),
      public.review_story_requirement_context(story)::text),'UTF8'),'sha256'),'hex')
  from public.analysis_story_task task
  join public.review_story story on story.id=task.story_id
  where task.job_id=p_job_id
  order by story.story_code;

  insert into public.analysis_job_identity_snapshot(
    job_id,source_developer_identity_id,source_git_identity_id,developer_display_name,
    employee_code,identity_status,provider,email_fingerprint,masked_email,email_domain,
    author_name_aliases,gitlab_username,gitlab_user_id,verification_status,snapshot_hash
  )
  select p_job_id,developer.id,git.id,developer.display_name,developer.employee_code,
    developer.status,git.provider,git.email_fingerprint,git.masked_email,git.email_domain,
    git.author_name_aliases,git.gitlab_username,git.gitlab_user_id,git.verification_status,
    encode(digest(convert_to(concat_ws(E'\n',developer.id::text,git.id::text,
      developer.display_name,coalesce(developer.employee_code,''),developer.status,
      git.provider,coalesce(git.email_fingerprint,''),coalesce(git.masked_email,''),
      coalesce(git.email_domain,''),array_to_string(git.author_name_aliases,E'\n'),
      coalesce(git.gitlab_username,''),coalesce(git.gitlab_user_id,''),
      git.verification_status),'UTF8'),'sha256'),'hex')
  from public.developer_identity developer
  join public.developer_git_identity git on git.developer_identity_id=developer.id
  where developer.status<>'DISABLED' and git.verification_status<>'DISABLED'
    and git.valid_from<=now() and (git.valid_until is null or git.valid_until>now())
  order by developer.id,git.id;

  select encode(digest(convert_to(coalesce(string_agg(input_hash,E'\n' order by story_code),'empty'),
    'UTF8'),'sha256'),'hex')
  into v_story_hash
  from public.analysis_job_story_snapshot where job_id=p_job_id;

  select encode(digest(convert_to(coalesce(string_agg(snapshot_hash,E'\n' order by source_git_identity_id),
    'empty'),'UTF8'),'sha256'),'hex')
  into v_identity_hash
  from public.analysis_job_identity_snapshot where job_id=p_job_id;

  update public.analysis_job
  set status='PREPARING_SCOPE',scope_status='PREPARING',
      scope_requested_at=coalesce(scope_requested_at,now()),locked_at=now(),
      attribution_rule_version_id=v_version.id,ruleset_hash=v_version.ruleset_hash,
      story_input_catalog_hash=v_story_hash,identity_snapshot_hash=v_identity_hash,
      attribution_algorithm_version=coalesce(attribution_algorithm_version,'story-attribution-v2')
  where id=p_job_id;

  v_payload:=public.analysis_job_frozen_scope_input_payload(p_job_id);
  return jsonb_build_object(
    'story_input_catalog_hash',v_story_hash,
    'identity_snapshot_hash',v_identity_hash,
    'rule_version_id',v_version.id,
    'ruleset_hash',v_version.ruleset_hash,
    'idempotent',false
  ) || v_payload;
end;
$$;

------------------------------------------------------------------------------
-- 10. 授权
------------------------------------------------------------------------------

revoke execute on function public.linky_team_names(jsonb, text) from public, anon;
grant execute on function public.linky_team_names(jsonb, text) to authenticated, service_role;

revoke execute on function public.review_story_requirement_context(public.review_story)
  from public, anon;
grant execute on function public.review_story_requirement_context(public.review_story)
  to authenticated, service_role;

revoke execute on function public.linky_catalog_attachment_is_referenced(text) from public, anon;
grant execute on function public.linky_catalog_attachment_is_referenced(text) to service_role;

revoke execute on function public.linky_sync_scope_key(text, uuid, text, text) from public, anon;
grant execute on function public.linky_sync_scope_key(text, uuid, text, text)
  to authenticated, service_role;

revoke execute on function public.enqueue_linky_sync(text, uuid, text, text) from public, anon;
grant execute on function public.enqueue_linky_sync(text, uuid, text, text)
  to authenticated, service_role;

revoke execute on function public.get_linky_sync(uuid) from public, anon;
grant execute on function public.get_linky_sync(uuid) to authenticated, service_role;

revoke execute on function public.get_linky_catalog_facets(uuid) from public, anon;
grant execute on function public.get_linky_catalog_facets(uuid) to authenticated, service_role;

revoke execute on function public.import_linky_stories_from_catalog(uuid, uuid[], boolean)
  from public, anon;
grant execute on function public.import_linky_stories_from_catalog(uuid, uuid[], boolean)
  to authenticated;

revoke execute on function public.assert_linky_sync_claim(uuid, text, uuid)
  from public, anon, authenticated;
grant execute on function public.assert_linky_sync_claim(uuid, text, uuid) to service_role;

revoke execute on function public.claim_next_linky_sync(text, integer)
  from public, anon, authenticated;
grant execute on function public.claim_next_linky_sync(text, integer) to service_role;

revoke execute on function public.heartbeat_linky_sync(uuid, text, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.heartbeat_linky_sync(uuid, text, uuid, integer) to service_role;

revoke execute on function public.upsert_linky_story_catalog(uuid, text, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.upsert_linky_story_catalog(uuid, text, uuid, jsonb) to service_role;

revoke execute on function public.upsert_linky_story_detail(uuid, text, uuid, uuid, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.upsert_linky_story_detail(uuid, text, uuid, uuid, jsonb, jsonb)
  to service_role;

revoke execute on function public.record_linky_catalog_attachment(
  uuid, text, uuid, uuid, text, text, text, bigint, text
) from public, anon, authenticated;
grant execute on function public.record_linky_catalog_attachment(
  uuid, text, uuid, uuid, text, text, text, bigint, text
) to service_role;

revoke execute on function public.complete_linky_sync(
  uuid, text, uuid, integer, integer, integer, integer, bigint
) from public, anon, authenticated;
grant execute on function public.complete_linky_sync(
  uuid, text, uuid, integer, integer, integer, integer, bigint
) to service_role;

revoke execute on function public.fail_linky_sync(uuid, text, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.fail_linky_sync(uuid, text, uuid, text, text) to service_role;

revoke execute on function public.release_linky_sync_claim(uuid, text, uuid)
  from public, anon, authenticated;
grant execute on function public.release_linky_sync_claim(uuid, text, uuid) to service_role;

revoke execute on function public.list_linky_catalog_attachments_for_cleanup(integer, integer)
  from public, anon, authenticated;
grant execute on function public.list_linky_catalog_attachments_for_cleanup(integer, integer)
  to service_role;

revoke execute on function public.mark_linky_catalog_attachment_purged(uuid)
  from public, anon, authenticated;
grant execute on function public.mark_linky_catalog_attachment_purged(uuid) to service_role;

revoke execute on function public.protect_referenced_story_attachment_objects()
  from public, anon, authenticated;

commit;
