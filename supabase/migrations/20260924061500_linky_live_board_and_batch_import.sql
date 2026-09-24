-- V1.20 修订：看板改为浏览器直连 Linky，导入改为「批次确认时冻结」。
--
-- 为什么调方向：需求在 Linky 那边随时在改，看板要的是**现在**的样子；而 AI 结论必须
-- 可复现，批次要的是**当时**的样子。两者诉求相反，所以分开处理：
--
--   看板  浏览器直连 Linky（接口 CORS 全开，使用者在内网/VPN 上即可），不落任何库。
--         因此 20260924051800 建的镜像三表（linky_story_catalog(+_attachment)、
--         linky_sync_request）在这一版之后不再有读取方。**本迁移不删它们** ——
--         删表是破坏性动作，留给运维确认后单独执行。
--   批次  在「原始需求导入」页选定项目组 + 发布窗口 + 勾选的故事，确认那一刻下一张
--         导入单；Worker 在内网侧逐条取正文与附件字节，写进 review_story(+_attachment)
--         与 story-attachments。附件字节仍然按批次冻结，sha256 由平台算。
--
-- 为什么不让浏览器直接把抓到的内容写库：那等于让前端提供"需求正文"这一评审输入，
-- 平台无从判断它是不是真的来自 Linky。Worker 抓 = 内容来源始终在服务端。

begin;

------------------------------------------------------------------------------
-- 1. 按批次的导入队列
------------------------------------------------------------------------------

create table if not exists public.linky_batch_import_request (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.review_batch(id) on delete cascade,
  -- 这批需求的来源定义：项目组 +（可选）发布窗口。它同时是给人看的审计线索 ——
  -- 「这个批次分析的是工具开发组 R20261016 这一窗口的需求」。
  workspace_id uuid,
  workspace_name text not null,
  release_window text,
  -- 勾选的故事编号。上限 500：一次导入要逐条取详情与附件，再多就该拆批次了。
  story_codes text[] not null,
  status text not null default 'QUEUED'
    check (status in ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED')),
  attempt integer not null default 0 check (attempt >= 0),
  worker_id text,
  claim_token_digest text,
  lease_expires_at timestamptz,
  heartbeat_at timestamptz,
  stories_total integer not null default 0 check (stories_total >= 0),
  stories_committed integer not null default 0 check (stories_committed >= 0),
  attachments_stored integer not null default 0 check (attachments_stored >= 0),
  attachments_failed integer not null default 0 check (attachments_failed >= 0),
  bytes_downloaded bigint not null default 0 check (bytes_downloaded >= 0),
  -- 逐条失败原因：[{story_code, code, message}]。一条故事取不到不该让整批回滚，
  -- 但必须让人看见是哪几条、为什么。
  stories_failed jsonb not null default '[]'::jsonb,
  error_code text,
  error_message text,
  requested_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint linky_batch_import_story_codes_bounded
    check (array_length(story_codes, 1) between 1 and 500)
);

create index if not exists linky_batch_import_queue_idx
  on public.linky_batch_import_request(status, created_at);
create index if not exists linky_batch_import_batch_idx
  on public.linky_batch_import_request(batch_id, created_at desc);
-- 一个批次同时只允许一张在途导入单：两张单子并行写同一批 review_story 会互相覆盖。
create unique index if not exists linky_batch_import_one_active_per_batch_idx
  on public.linky_batch_import_request(batch_id)
  where status in ('QUEUED', 'RUNNING');

alter table public.linky_batch_import_request enable row level security;
revoke all on table public.linky_batch_import_request from anon;
revoke insert, update, delete, truncate
  on table public.linky_batch_import_request from authenticated;
grant select on table public.linky_batch_import_request to authenticated;
grant all on table public.linky_batch_import_request to service_role;

-- 导入进度要在批次页显示，所以队列行对登录用户可读（不含 claim_token_digest 的用法：
-- 前端的 select 列清单里没有它，RPC 投影也剥掉了它）。
drop policy if exists "authenticated read linky batch imports"
  on public.linky_batch_import_request;
create policy "authenticated read linky batch imports" on public.linky_batch_import_request
  for select to authenticated using (true);

comment on table public.linky_batch_import_request is
  'V1.20：按批次的需求导入单。前端只提交「组 + 窗口 + 勾选编号」，正文与附件由 Worker '
  '在内网侧取，于确认那一刻冻结进 review_story(+_attachment)。';

------------------------------------------------------------------------------
-- 2. 用户侧 RPC
------------------------------------------------------------------------------

create or replace function public.request_linky_batch_import(
  p_batch_id uuid,
  p_workspace_name text,
  p_story_codes text[],
  p_workspace_id uuid default null,
  p_release_window text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_batch public.review_batch;
  v_codes text[];
  v_existing uuid;
  v_id uuid;
begin
  perform public.ensure_manage_review_batch(p_batch_id);

  if p_workspace_name is null or btrim(p_workspace_name) = '' then
    raise exception 'LINKY_IMPORT_WORKSPACE_REQUIRED';
  end if;

  -- 去重 + 去空白，顺带把顺序固定下来，方便复跑比对。
  select array_agg(distinct code order by code) into v_codes
  from unnest(coalesce(p_story_codes, array[]::text[])) as entry(code)
  where btrim(coalesce(code, '')) <> '';
  if v_codes is null or array_length(v_codes, 1) is null then
    raise exception 'LINKY_IMPORT_EMPTY_SELECTION';
  end if;
  if array_length(v_codes, 1) > 500 then
    raise exception 'LINKY_IMPORT_TOO_MANY_STORIES';
  end if;

  select * into v_batch from public.review_batch where id = p_batch_id for update;
  if v_batch.id is null then raise exception 'batch not found'; end if;
  if v_batch.status = 'COMPLETED' then raise exception 'BATCH_READ_ONLY'; end if;
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

  perform pg_advisory_xact_lock(hashtext('linky_batch_import:' || p_batch_id::text));
  select request.id into v_existing
  from public.linky_batch_import_request request
  where request.batch_id = p_batch_id and request.status in ('QUEUED', 'RUNNING')
  order by request.created_at desc
  limit 1;
  if v_existing is not null then
    -- 幂等：用户连点两次确认，返回同一张单子而不是排第二张。
    return v_existing;
  end if;

  insert into public.linky_batch_import_request (
    batch_id, workspace_id, workspace_name, release_window, story_codes,
    stories_total, requested_by
  ) values (
    p_batch_id, p_workspace_id, btrim(p_workspace_name),
    nullif(btrim(coalesce(p_release_window, '')), ''), v_codes,
    array_length(v_codes, 1), auth.uid()
  )
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.get_linky_batch_import(p_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_request public.linky_batch_import_request;
begin
  select * into v_request from public.linky_batch_import_request where id = p_request_id;
  if v_request.id is null then raise exception 'LINKY_IMPORT_NOT_FOUND'; end if;
  return to_jsonb(v_request) - 'claim_token_digest';
end;
$$;

/** 批次页要显示「上一次导入是什么范围、成功几条」。 */
create or replace function public.get_latest_linky_batch_import(p_batch_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_request public.linky_batch_import_request;
begin
  perform public.ensure_manage_review_batch(p_batch_id);
  select * into v_request from public.linky_batch_import_request
  where batch_id = p_batch_id order by created_at desc limit 1;
  if v_request.id is null then return null; end if;
  return to_jsonb(v_request) - 'claim_token_digest';
end;
$$;

------------------------------------------------------------------------------
-- 3. Worker 侧 RPC
------------------------------------------------------------------------------

create or replace function public.claim_next_linky_batch_import(
  p_worker_id text,
  p_lease_seconds integer default 900
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_request public.linky_batch_import_request;
  v_token uuid;
begin
  if p_worker_id is null or btrim(p_worker_id) = '' then
    raise exception 'worker_id is required';
  end if;
  if p_lease_seconds is null or p_lease_seconds < 60 then p_lease_seconds := 900; end if;

  select request.* into v_request
  from public.linky_batch_import_request request
  where request.status = 'QUEUED'
     or (request.status = 'RUNNING' and request.lease_expires_at < now())
  order by request.created_at
  for update skip locked
  limit 1;
  if v_request.id is null then return null; end if;

  v_token := gen_random_uuid();
  update public.linky_batch_import_request
  set status = 'RUNNING',
      attempt = attempt + 1,
      worker_id = p_worker_id,
      lease_expires_at = now() + make_interval(secs => p_lease_seconds),
      heartbeat_at = now(),
      claim_token_digest = public.agent_claim_token_digest(v_token),
      -- 重新认领即重新计数：上一次可能只提交了一半。
      stories_committed = 0,
      attachments_stored = 0,
      attachments_failed = 0,
      bytes_downloaded = 0,
      stories_failed = '[]'::jsonb,
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

create or replace function public.heartbeat_linky_batch_import(
  p_request_id uuid,
  p_worker_id text,
  p_claim_token uuid,
  p_lease_seconds integer default 900
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
  if p_lease_seconds is null or p_lease_seconds < 60 then p_lease_seconds := 900; end if;
  update public.linky_batch_import_request request
  set heartbeat_at = now(),
      lease_expires_at = now() + make_interval(secs => p_lease_seconds),
      updated_at = now()
  where request.id = p_request_id
    and request.status = 'RUNNING'
    and request.worker_id = p_worker_id
    and request.lease_expires_at >= now()
    and request.claim_token_digest = public.agent_claim_token_digest(p_claim_token)
  returning true into v_ok;
  return coalesce(v_ok, false);
end;
$$;

create or replace function public.assert_linky_batch_import_claim(
  p_request_id uuid,
  p_worker_id text,
  p_claim_token uuid
)
returns public.linky_batch_import_request
language plpgsql
security definer
set search_path = public
as $$
declare
  v_request public.linky_batch_import_request;
begin
  select * into v_request from public.linky_batch_import_request
  where id = p_request_id for update;
  if v_request.id is null then raise exception 'LINKY_IMPORT_NOT_FOUND'; end if;
  if v_request.status <> 'RUNNING'
     or v_request.worker_id is distinct from p_worker_id
     or v_request.lease_expires_at is null
     or v_request.lease_expires_at < now()
     or p_claim_token is null
     or v_request.claim_token_digest is distinct from public.agent_claim_token_digest(p_claim_token)
  then
    raise exception 'LINKY_IMPORT_LEASE_LOST';
  end if;
  return v_request;
end;
$$;

/**
 * 提交一条故事（含附件元数据）。
 *
 * 逐条提交而不是整批一次：一次导入可能有几十条，逐条落库让进度条是真的，
 * 也让"第 7 条取不到"不至于把前 6 条一起回滚。
 *
 * 正文为空直接拒绝：那正是 V1.20 要消灭的状态（AI 在不知道需求内容的情况下判断代码）。
 */
create or replace function public.commit_linky_batch_story(
  p_request_id uuid,
  p_worker_id text,
  p_claim_token uuid,
  p_story jsonb,
  p_attachments jsonb default '[]'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_request public.linky_batch_import_request;
  v_code text := btrim(coalesce(p_story ->> 'story_code', ''));
  v_detail text := nullif(btrim(coalesce(p_story ->> 'requirement_detail', '')), '');
  v_team jsonb := case when jsonb_typeof(p_story -> 'team') = 'object' then p_story -> 'team' else null end;
  v_story_id uuid;
  v_attachments integer := 0;
  v_bytes bigint := 0;
begin
  v_request := public.assert_linky_batch_import_claim(p_request_id, p_worker_id, p_claim_token);

  if v_code = '' then raise exception 'LINKY_IMPORT_STORY_CODE_REQUIRED'; end if;
  if not (v_code = any(v_request.story_codes)) then
    -- 只允许提交这张单子上勾选过的故事，防止一个 Worker 往批次里塞别的需求。
    raise exception 'LINKY_IMPORT_STORY_NOT_REQUESTED';
  end if;
  if v_detail is null then raise exception 'LINKY_IMPORT_STORY_TEXT_REQUIRED'; end if;

  insert into public.review_story (
    batch_id, story_code, story_name, owners_text, requirement_handlers, test_handlers,
    project_name, iteration_name, release_window, source_status, source_data,
    source_system, requirement_detail, subject_name, linky_issue_id,
    linky_workspace_id, linky_workspace_name, story_url, synced_at
  ) values (
    v_request.batch_id,
    v_code,
    coalesce(nullif(btrim(coalesce(p_story ->> 'title', '')), ''), v_code),
    coalesce(
      nullif(public.linky_team_names(v_team, 'dev'), ''),
      nullif(btrim(coalesce(p_story ->> 'assignee_name', '')), ''),
      '未分配'
    ),
    public.linky_team_names(v_team, 'req'),
    public.linky_team_names(v_team, 'test'),
    coalesce(
      nullif(btrim(coalesce(p_story ->> 'workspace_name', '')), ''),
      v_request.workspace_name
    ),
    nullif(btrim(coalesce(p_story ->> 'iteration', '')), ''),
    coalesce(
      nullif(btrim(coalesce(p_story ->> 'release_window', '')), ''),
      v_request.release_window
    ),
    nullif(btrim(coalesce(p_story ->> 'status_label', '')), ''),
    jsonb_strip_nulls(jsonb_build_object(
      'source', 'LINKY',
      'imported_by_request', to_jsonb(p_request_id),
      'linky_issue_id', p_story -> 'issue_id',
      'workspace_id', p_story -> 'workspace_id',
      'workspace_name', p_story -> 'workspace_name',
      'iteration', p_story -> 'iteration',
      'release_window', p_story -> 'release_window',
      'subject', p_story -> 'subject_name',
      'status_label', p_story -> 'status_label',
      'assignee', p_story -> 'assignee_name',
      'team', v_team,
      'team_resolve_error', p_story -> 'team_resolve_error',
      'field_values', p_story -> 'field_values',
      'list_item', p_story -> 'list_item'
    )),
    'LINKY',
    v_detail,
    nullif(btrim(coalesce(p_story ->> 'subject_name', '')), ''),
    nullif(p_story ->> 'issue_id', '')::uuid,
    nullif(p_story ->> 'workspace_id', '')::uuid,
    coalesce(
      nullif(btrim(coalesce(p_story ->> 'workspace_name', '')), ''),
      v_request.workspace_name
    ),
    nullif(btrim(coalesce(p_story ->> 'story_url', '')), ''),
    now()
  )
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
  returning id into v_story_id;

  -- 附件按本次抓取结果整段重放：上游删了的附件不该留在批次里。
  delete from public.review_story_attachment where story_id = v_story_id;
  if jsonb_typeof(p_attachments) = 'array' then
    insert into public.review_story_attachment (
      story_id, linky_attachment_id, filename, content_type, size_bytes,
      storage_path, content_sha256
    )
    select
      v_story_id,
      btrim(item ->> 'linky_attachment_id'),
      btrim(item ->> 'filename'),
      nullif(btrim(coalesce(item ->> 'content_type', '')), ''),
      nullif(item ->> 'size_bytes', '')::bigint,
      btrim(item ->> 'storage_path'),
      lower(btrim(item ->> 'sha256'))
    from jsonb_array_elements(p_attachments) as entry(item)
    where coalesce(item ->> 'linky_attachment_id', '') <> ''
      and coalesce(item ->> 'filename', '') <> ''
      and coalesce(item ->> 'storage_path', '') <> ''
      and lower(btrim(coalesce(item ->> 'sha256', ''))) ~ '^[0-9a-f]{64}$'
    on conflict (story_id, linky_attachment_id) do nothing;
    select count(*), coalesce(sum(size_bytes), 0) into v_attachments, v_bytes
    from public.review_story_attachment where story_id = v_story_id;
  end if;

  update public.linky_batch_import_request
  set stories_committed = stories_committed + 1,
      attachments_stored = attachments_stored + coalesce(v_attachments, 0),
      bytes_downloaded = bytes_downloaded + coalesce(v_bytes, 0),
      updated_at = now()
  where id = p_request_id;

  return v_story_id;
end;
$$;

create or replace function public.record_linky_batch_story_failure(
  p_request_id uuid,
  p_worker_id text,
  p_claim_token uuid,
  p_story_code text,
  p_error_code text,
  p_error_message text,
  p_attachments_failed integer default 0
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.assert_linky_batch_import_claim(p_request_id, p_worker_id, p_claim_token);
  update public.linky_batch_import_request
  set stories_failed = stories_failed || jsonb_build_array(jsonb_build_object(
        'story_code', left(coalesce(p_story_code, ''), 80),
        'code', left(coalesce(nullif(btrim(coalesce(p_error_code, '')), ''), 'LINKY_IMPORT_STORY_FAILED'), 80),
        'message', left(coalesce(p_error_message, ''), 200)
      )),
      attachments_failed = attachments_failed + greatest(coalesce(p_attachments_failed, 0), 0),
      updated_at = now()
  where id = p_request_id;
  return true;
end;
$$;

create or replace function public.complete_linky_batch_import(
  p_request_id uuid,
  p_worker_id text,
  p_claim_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_request public.linky_batch_import_request;
begin
  v_request := public.assert_linky_batch_import_claim(p_request_id, p_worker_id, p_claim_token);

  update public.linky_batch_import_request
  set status = 'SUCCEEDED',
      worker_id = null,
      lease_expires_at = null,
      heartbeat_at = null,
      claim_token_digest = null,
      finished_at = now(),
      updated_at = now()
  where id = p_request_id;

  -- 至少落了一条需求才推进批次状态：一条都没成功时批次应当留在 DRAFT，
  -- 否则用户会在「AI 结果」页面对一个空批次点开始分析。
  if exists (select 1 from public.review_story where batch_id = v_request.batch_id) then
    update public.review_batch
    set status = 'WAITING_AI_RESULT', updated_at = now()
    where id = v_request.batch_id and status in ('DRAFT', 'WAITING_AI_RESULT');
  end if;
  return true;
end;
$$;

create or replace function public.fail_linky_batch_import(
  p_request_id uuid,
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
  update public.linky_batch_import_request request
  set status = 'FAILED',
      error_code = left(coalesce(nullif(btrim(coalesce(p_error_code, '')), ''), 'LINKY_IMPORT_FAILED'), 80),
      error_message = left(coalesce(nullif(btrim(coalesce(p_error_message, '')), ''), 'Linky 需求导入失败'), 300),
      worker_id = null,
      lease_expires_at = null,
      heartbeat_at = null,
      claim_token_digest = null,
      finished_at = now(),
      updated_at = now()
  where request.id = p_request_id
    and request.status = 'RUNNING'
    and request.worker_id = p_worker_id
    and p_claim_token is not null
    and request.claim_token_digest = public.agent_claim_token_digest(p_claim_token)
  returning true into v_ok;
  return coalesce(v_ok, false);
end;
$$;

create or replace function public.release_linky_batch_import_claim(
  p_request_id uuid,
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
  update public.linky_batch_import_request request
  set status = 'QUEUED',
      worker_id = null,
      lease_expires_at = null,
      heartbeat_at = null,
      claim_token_digest = null,
      updated_at = now()
  where request.id = p_request_id
    and request.status = 'RUNNING'
    and request.worker_id = p_worker_id
    and p_claim_token is not null
    and request.claim_token_digest = public.agent_claim_token_digest(p_claim_token)
  returning true into v_ok;
  return coalesce(v_ok, false);
end;
$$;

------------------------------------------------------------------------------
-- 4. 附件对象的孤儿判定
--
-- 附件对象现在按批次存（key `batch/<batch_id>/...`）。批次删除会级联掉
-- review_story_attachment 行，但 Storage 对象留在 bucket 里 —— 与 review-files 的
-- 现状一致。Worker 空闲时列桶并用这个函数判定哪些可以删。
------------------------------------------------------------------------------

create or replace function public.unreferenced_story_attachment_paths(p_paths text[])
returns text[]
language sql
security definer
set search_path = public
stable
as $$
  select coalesce(array_agg(candidate.path order by candidate.path), array[]::text[])
  from unnest(coalesce(p_paths, array[]::text[])) as candidate(path)
  where not exists (
    select 1 from public.review_story_attachment attachment
    where attachment.storage_path = candidate.path
  )
  and not exists (
    -- 旧镜像层的对象也可能仍被引用；这一版不再写它，但不能顺手删掉别人的字节。
    select 1 from public.linky_story_catalog_attachment mirror
    where mirror.storage_path = candidate.path
  );
$$;

------------------------------------------------------------------------------
-- 5. 旧镜像路径标注为停用（不删表，删表由运维单独确认）
------------------------------------------------------------------------------

comment on table public.linky_story_catalog is
  '已停用（V1.20 修订）：看板改为浏览器直连 Linky，不再有读取方。表与数据保留，'
  '删除需运维单独确认。';
comment on table public.linky_sync_request is
  '已停用（V1.20 修订）：镜像同步队列不再被 Worker 消费。表与数据保留。';

------------------------------------------------------------------------------
-- 6. 授权
------------------------------------------------------------------------------

revoke execute on function public.request_linky_batch_import(uuid, text, text[], uuid, text)
  from public, anon;
grant execute on function public.request_linky_batch_import(uuid, text, text[], uuid, text)
  to authenticated;

revoke execute on function public.get_linky_batch_import(uuid) from public, anon;
grant execute on function public.get_linky_batch_import(uuid) to authenticated, service_role;

revoke execute on function public.get_latest_linky_batch_import(uuid) from public, anon;
grant execute on function public.get_latest_linky_batch_import(uuid) to authenticated;

revoke execute on function public.claim_next_linky_batch_import(text, integer)
  from public, anon, authenticated;
grant execute on function public.claim_next_linky_batch_import(text, integer) to service_role;

revoke execute on function public.heartbeat_linky_batch_import(uuid, text, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.heartbeat_linky_batch_import(uuid, text, uuid, integer)
  to service_role;

revoke execute on function public.assert_linky_batch_import_claim(uuid, text, uuid)
  from public, anon, authenticated;
grant execute on function public.assert_linky_batch_import_claim(uuid, text, uuid) to service_role;

revoke execute on function public.commit_linky_batch_story(uuid, text, uuid, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.commit_linky_batch_story(uuid, text, uuid, jsonb, jsonb)
  to service_role;

revoke execute on function public.record_linky_batch_story_failure(
  uuid, text, uuid, text, text, text, integer
) from public, anon, authenticated;
grant execute on function public.record_linky_batch_story_failure(
  uuid, text, uuid, text, text, text, integer
) to service_role;

revoke execute on function public.complete_linky_batch_import(uuid, text, uuid)
  from public, anon, authenticated;
grant execute on function public.complete_linky_batch_import(uuid, text, uuid) to service_role;

revoke execute on function public.fail_linky_batch_import(uuid, text, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.fail_linky_batch_import(uuid, text, uuid, text, text) to service_role;

revoke execute on function public.release_linky_batch_import_claim(uuid, text, uuid)
  from public, anon, authenticated;
grant execute on function public.release_linky_batch_import_claim(uuid, text, uuid) to service_role;

revoke execute on function public.unreferenced_story_attachment_paths(text[])
  from public, anon, authenticated;
grant execute on function public.unreferenced_story_attachment_paths(text[]) to service_role;

commit;
