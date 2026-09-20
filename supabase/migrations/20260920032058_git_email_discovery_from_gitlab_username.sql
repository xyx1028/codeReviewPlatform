-- V1.13 用 GitLab 用户名反查本人的提交邮箱，点选候选后保存为已验证 Git 身份。
--
-- ## 为什么要有这一层
--
-- V1.12 让每个人在个人中心自己填 Git author email。但"填对"这件事没有任何校验：
-- 填错一个字符不会报错，只会让归属规则在作者维度上永远匹配不到他，而且没人会发现。
-- 所以这一版把"人打字"换成"从他自己的 MR 里反查出来、他只负责点选"。
--
-- ## 数据流
--
--   浏览器只提交 GitLab 用户名 → 队列行（QUEUED）
--   本地 Worker 领取（它能访问 git.kingdee.com；Supabase 云端访问不到，所以必须由 Worker 做）
--     /users?username= → /projects/:id/merge_requests?author_id= → /merge_requests/:iid/commits
--   Worker 把 [邮箱, 作者名, 提交数, 最近提交时间, 仓库, MR 引用] 交回
--   数据库在函数内部算 HMAC，只落 fingerprint + 脱敏邮箱，明文当场丢弃
--   浏览器只看到 y***@kingdee.com 这种脱敏候选，点选后按 candidate_id 保存
--
-- 因此：**明文邮箱既不进浏览器，也不进任何表**。它只存在于 Worker 内存里的 GitLab 响应，
-- 以及这个 complete RPC 的参数中 —— 后者与既有的 match_analysis_git_identities 完全同构。
--
-- ## 验证语义
--
--   点选候选保存 → verification_status='VERIFIED'（有他自己 MR 里的提交作为证据）
--   手输邮箱保存 → verification_status='UNVERIFIED'（没有证据，页面必须标出来）
--
-- 归属规则里的 VERIFIED_IDENTITY_MATCH 只认 VERIFIED，所以"未验证"不会污染分析结论。

begin;

------------------------------------------------------------------------------
-- 1. 队列表与候选表
------------------------------------------------------------------------------

create table if not exists public.git_identity_email_discovery (
  id uuid primary key default gen_random_uuid(),
  requested_by uuid not null references auth.users(id) on delete cascade,
  gitlab_username text not null check (gitlab_username ~ '^[A-Za-z0-9][A-Za-z0-9_.\-]{0,48}$'),
  lookback_days integer not null default 365 check (lookback_days between 30 and 730),
  status text not null default 'QUEUED'
    check (status in ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED')),
  attempt integer not null default 0 check (attempt >= 0),
  worker_id text,
  lease_expires_at timestamptz,
  heartbeat_at timestamptz,
  claim_token_digest text,
  gitlab_user_id text,
  gitlab_display_name text,
  merge_request_count integer not null default 0 check (merge_request_count >= 0),
  candidate_count integer not null default 0 check (candidate_count >= 0),
  partial boolean not null default false,
  error_code text,
  error_message text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists git_identity_email_discovery_queue_idx
on public.git_identity_email_discovery(status, created_at);
create index if not exists git_identity_email_discovery_requester_idx
on public.git_identity_email_discovery(requested_by, created_at desc);
-- 同一个人同时只排一个查询：连点按钮不会排出一堆重复任务。
create unique index if not exists git_identity_email_discovery_one_active_idx
on public.git_identity_email_discovery(requested_by)
where status in ('QUEUED', 'RUNNING');

create table if not exists public.git_identity_email_candidate (
  id uuid primary key default gen_random_uuid(),
  discovery_id uuid not null references public.git_identity_email_discovery(id) on delete cascade,
  email_fingerprint text not null check (email_fingerprint ~ '^[0-9a-f]{64}$'),
  masked_email text not null,
  email_domain text not null,
  author_names text[] not null default array[]::text[],
  commit_count integer not null default 0 check (commit_count >= 0),
  last_committed_at timestamptz,
  repositories jsonb not null default '{}'::jsonb,
  merge_request_refs text[] not null default array[]::text[],
  created_at timestamptz not null default now(),
  unique (discovery_id, email_fingerprint)
);

create index if not exists git_identity_email_candidate_discovery_idx
on public.git_identity_email_candidate(discovery_id, commit_count desc);

alter table public.git_identity_email_discovery enable row level security;
alter table public.git_identity_email_candidate enable row level security;
-- 指纹不给浏览器：两张表都只能经 RPC 访问。
revoke all on table public.git_identity_email_discovery from public, anon, authenticated;
revoke all on table public.git_identity_email_candidate from public, anon, authenticated;

------------------------------------------------------------------------------
-- 2. 本人侧：下单与读结果
------------------------------------------------------------------------------

create or replace function public.enqueue_my_git_email_discovery(
  p_gitlab_username text,
  p_lookback_days integer default 365
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_username text;
  v_existing uuid;
  v_recent integer;
  v_id uuid;
begin
  if v_actor is null then raise exception 'AUTH_REQUIRED'; end if;
  v_username := btrim(coalesce(p_gitlab_username, ''));
  if v_username !~ '^[A-Za-z0-9][A-Za-z0-9_.\-]{0,48}$' then
    raise exception 'GITLAB_USERNAME_INVALID';
  end if;

  -- 同一个用户的排队请求串行化，避免并发插入撞唯一索引后抛出看不懂的错误。
  perform pg_advisory_xact_lock(hashtext('git_email_discovery:' || v_actor::text));

  select discovery.id into v_existing
  from public.git_identity_email_discovery discovery
  where discovery.requested_by = v_actor
    and discovery.status in ('QUEUED', 'RUNNING')
  order by discovery.created_at desc
  limit 1;
  if v_existing is not null then
    return v_existing;
  end if;

  -- 反查会打 GitLab API，必须有速率上限；10 分钟 20 次足够正常使用。
  select count(*) into v_recent
  from public.git_identity_email_discovery discovery
  where discovery.requested_by = v_actor
    and discovery.created_at > now() - interval '10 minutes';
  if v_recent >= 20 then
    raise exception 'GIT_EMAIL_DISCOVERY_RATE_LIMITED';
  end if;

  insert into public.git_identity_email_discovery (
    requested_by, gitlab_username, lookback_days
  ) values (
    v_actor, v_username, least(greatest(coalesce(p_lookback_days, 365), 30), 730)
  ) returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.get_my_git_email_discovery(p_discovery_id uuid)
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_discovery public.git_identity_email_discovery;
begin
  if v_actor is null then raise exception 'AUTH_REQUIRED'; end if;
  select * into v_discovery
  from public.git_identity_email_discovery
  where id = p_discovery_id and requested_by = v_actor;
  if v_discovery.id is null then raise exception 'GIT_EMAIL_DISCOVERY_NOT_FOUND'; end if;

  return jsonb_build_object(
    'discovery_id', v_discovery.id,
    'gitlab_username', v_discovery.gitlab_username,
    'gitlab_user_id', v_discovery.gitlab_user_id,
    'gitlab_display_name', v_discovery.gitlab_display_name,
    'status', v_discovery.status,
    'attempt', v_discovery.attempt,
    'lookback_days', v_discovery.lookback_days,
    'merge_request_count', v_discovery.merge_request_count,
    'candidate_count', v_discovery.candidate_count,
    'partial', v_discovery.partial,
    'error_code', v_discovery.error_code,
    'error_message', v_discovery.error_message,
    'created_at', v_discovery.created_at,
    'started_at', v_discovery.started_at,
    'finished_at', v_discovery.finished_at,
    'claimed', v_discovery.worker_id is not null,
    'candidates', coalesce((
      select jsonb_agg(jsonb_build_object(
        'candidate_id', candidate.id,
        'masked_email', candidate.masked_email,
        'email_domain', candidate.email_domain,
        'author_names', candidate.author_names,
        'commit_count', candidate.commit_count,
        'last_committed_at', candidate.last_committed_at,
        'repositories', candidate.repositories,
        'merge_request_refs', candidate.merge_request_refs,
        'already_bound', exists (
          select 1 from public.developer_git_identity git
          where git.email_fingerprint = candidate.email_fingerprint
            and git.verification_status in ('VERIFIED', 'UNVERIFIED')
            and git.valid_until is null
        )
      ) order by candidate.commit_count desc, candidate.masked_email)
      from public.git_identity_email_candidate candidate
      where candidate.discovery_id = v_discovery.id
    ), '[]'::jsonb)
  );
end;
$$;

------------------------------------------------------------------------------
-- 3. Worker 侧：领取、心跳、回填、失败、释放
------------------------------------------------------------------------------

create or replace function public.claim_next_git_email_discovery(
  p_worker_id text,
  p_lease_seconds integer default 90
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_discovery public.git_identity_email_discovery;
  v_token uuid;
begin
  if p_worker_id is null or btrim(p_worker_id) = '' then
    raise exception 'worker_id is required';
  end if;
  if p_lease_seconds is null or p_lease_seconds < 45 then p_lease_seconds := 90; end if;

  select discovery.* into v_discovery
  from public.git_identity_email_discovery discovery
  where discovery.status = 'QUEUED'
     or (discovery.status = 'RUNNING' and discovery.lease_expires_at < now())
  order by discovery.created_at
  for update skip locked
  limit 1;
  if v_discovery.id is null then return null; end if;

  -- 反复领取失败的任务不再无限重试：三次后以稳定错误码收口。
  if v_discovery.attempt >= 3 then
    update public.git_identity_email_discovery
    set status = 'FAILED',
        error_code = 'GIT_EMAIL_DISCOVERY_ATTEMPTS_EXHAUSTED',
        error_message = '多次尝试仍未完成，请稍后重试',
        worker_id = null, lease_expires_at = null, heartbeat_at = null,
        claim_token_digest = null, finished_at = now(), updated_at = now()
    where id = v_discovery.id;
    return null;
  end if;

  v_token := gen_random_uuid();
  update public.git_identity_email_discovery
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
  where id = v_discovery.id
  returning * into v_discovery;

  return jsonb_build_object(
    'id', v_discovery.id,
    'gitlab_username', v_discovery.gitlab_username,
    'lookback_days', v_discovery.lookback_days,
    'attempt', v_discovery.attempt,
    'claim_token', v_token
  );
end;
$$;

create or replace function public.heartbeat_git_email_discovery(
  p_discovery_id uuid,
  p_worker_id text,
  p_claim_token uuid,
  p_lease_seconds integer default 90
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare v_ok boolean;
begin
  if p_claim_token is null then return false; end if;
  if p_lease_seconds is null or p_lease_seconds < 45 then p_lease_seconds := 90; end if;
  update public.git_identity_email_discovery discovery
  set heartbeat_at = now(),
      lease_expires_at = now() + make_interval(secs => p_lease_seconds),
      updated_at = now()
  where discovery.id = p_discovery_id
    and discovery.status = 'RUNNING'
    and discovery.worker_id = p_worker_id
    and discovery.lease_expires_at >= now()
    and discovery.claim_token_digest = public.agent_claim_token_digest(p_claim_token)
  returning true into v_ok;
  return coalesce(v_ok, false);
end;
$$;

/**
 * 回填候选。原始邮箱只作为参数出现：库内算 HMAC 后只写指纹与脱敏值，明文不落任何列。
 *
 * p_candidates: [{ email, author_names[], commit_count, last_committed_at,
 *                  repositories{name:count}, merge_request_refs[] }]
 */
create or replace function public.complete_git_email_discovery(
  p_discovery_id uuid,
  p_worker_id text,
  p_claim_token uuid,
  p_gitlab_user_id text,
  p_gitlab_display_name text,
  p_merge_request_count integer,
  p_partial boolean,
  p_candidates jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, vault, extensions
as $$
declare
  v_discovery public.git_identity_email_discovery;
  v_pepper text;
  v_item jsonb;
  v_email text;
  v_local text;
  v_domain text;
  v_masked text;
  v_fingerprint text;
  v_count integer := 0;
begin
  select * into v_discovery
  from public.git_identity_email_discovery
  where id = p_discovery_id
  for update;
  if v_discovery.id is null then raise exception 'GIT_EMAIL_DISCOVERY_NOT_FOUND'; end if;
  if v_discovery.status <> 'RUNNING'
     or v_discovery.worker_id is distinct from p_worker_id
     or v_discovery.lease_expires_at is null
     or v_discovery.lease_expires_at < now()
     or p_claim_token is null
     or v_discovery.claim_token_digest is distinct from public.agent_claim_token_digest(p_claim_token) then
    raise exception 'TASK_LEASE_LOST';
  end if;
  if jsonb_typeof(coalesce(p_candidates, '[]'::jsonb)) <> 'array'
     or jsonb_array_length(coalesce(p_candidates, '[]'::jsonb)) > 50 then
    raise exception 'GIT_EMAIL_CANDIDATE_LIST_INVALID';
  end if;

  select secret.decrypted_secret into v_pepper
  from vault.decrypted_secrets secret
  where secret.name = 'analysis_identity_pepper'
  order by secret.created_at desc
  limit 1;
  if coalesce(v_pepper, '') = '' then raise exception 'IDENTITY_PEPPER_MISSING'; end if;

  delete from public.git_identity_email_candidate where discovery_id = p_discovery_id;

  for v_item in select * from jsonb_array_elements(coalesce(p_candidates, '[]'::jsonb))
  loop
    v_email := lower(btrim(coalesce(v_item->>'email', '')));
    -- 无效或超长的作者邮箱直接跳过：GitLab 里确实存在机器人和残缺的 author 字段。
    continue when char_length(v_email) > 320
      or v_email !~ '^[^@[:space:][:cntrl:]]{1,64}@[^@[:space:][:cntrl:]]{1,255}$';
    v_local := split_part(v_email, '@', 1);
    v_domain := split_part(v_email, '@', 2);
    v_masked := left(v_local, 1) || '***@' || v_domain;
    v_fingerprint := encode(hmac(
      convert_to(v_email, 'UTF8'),
      convert_to(v_pepper, 'UTF8'),
      'sha256'
    ), 'hex');

    insert into public.git_identity_email_candidate (
      discovery_id, email_fingerprint, masked_email, email_domain,
      author_names, commit_count, last_committed_at, repositories, merge_request_refs
    ) values (
      p_discovery_id, v_fingerprint, v_masked, v_domain,
      (select coalesce(array_agg(distinct left(name, 64)), array[]::text[])
       from jsonb_array_elements_text(coalesce(v_item->'author_names', '[]'::jsonb)) name
       where btrim(name) <> ''),
      greatest(coalesce((v_item->>'commit_count')::integer, 0), 0),
      nullif(v_item->>'last_committed_at', '')::timestamptz,
      case when jsonb_typeof(coalesce(v_item->'repositories', '{}'::jsonb)) = 'object'
        then v_item->'repositories' else '{}'::jsonb end,
      (select coalesce(array_agg(distinct left(ref, 80)), array[]::text[])
       from jsonb_array_elements_text(coalesce(v_item->'merge_request_refs', '[]'::jsonb)) ref
       where btrim(ref) <> '')
    )
    on conflict (discovery_id, email_fingerprint) do update
    set commit_count = greatest(git_identity_email_candidate.commit_count, excluded.commit_count),
        last_committed_at = greatest(git_identity_email_candidate.last_committed_at, excluded.last_committed_at),
        author_names = excluded.author_names,
        repositories = excluded.repositories,
        merge_request_refs = excluded.merge_request_refs;
    v_count := v_count + 1;
  end loop;

  update public.git_identity_email_discovery
  set status = 'SUCCEEDED',
      gitlab_user_id = nullif(btrim(coalesce(p_gitlab_user_id, '')), ''),
      gitlab_display_name = nullif(btrim(coalesce(p_gitlab_display_name, '')), ''),
      merge_request_count = greatest(coalesce(p_merge_request_count, 0), 0),
      candidate_count = (select count(*) from public.git_identity_email_candidate where discovery_id = p_discovery_id),
      partial = coalesce(p_partial, false),
      error_code = null,
      error_message = null,
      worker_id = null, lease_expires_at = null, heartbeat_at = null, claim_token_digest = null,
      finished_at = now(), updated_at = now()
  where id = p_discovery_id
  returning * into v_discovery;

  return jsonb_build_object(
    'discovery_id', v_discovery.id,
    'candidate_count', v_discovery.candidate_count,
    'accepted_count', v_count
  );
end;
$$;

create or replace function public.fail_git_email_discovery(
  p_discovery_id uuid,
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
declare v_ok boolean;
begin
  update public.git_identity_email_discovery discovery
  set status = 'FAILED',
      error_code = left(coalesce(nullif(btrim(p_error_code), ''), 'GIT_EMAIL_DISCOVERY_FAILED'), 80),
      error_message = left(coalesce(nullif(btrim(p_error_message), ''), '查找提交邮箱失败'), 300),
      worker_id = null, lease_expires_at = null, heartbeat_at = null,
      claim_token_digest = null, finished_at = now(), updated_at = now()
  where discovery.id = p_discovery_id
    and discovery.status = 'RUNNING'
    and discovery.worker_id = p_worker_id
    and discovery.lease_expires_at >= now()
    and p_claim_token is not null
    and discovery.claim_token_digest = public.agent_claim_token_digest(p_claim_token)
  returning true into v_ok;
  return coalesce(v_ok, false);
end;
$$;

create or replace function public.release_git_email_discovery_claim(
  p_discovery_id uuid,
  p_worker_id text,
  p_claim_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare v_ok boolean;
begin
  update public.git_identity_email_discovery discovery
  set status = 'QUEUED', worker_id = null, lease_expires_at = null,
      heartbeat_at = null, claim_token_digest = null, updated_at = now()
  where discovery.id = p_discovery_id
    and discovery.status = 'RUNNING'
    and discovery.worker_id = p_worker_id
    and p_claim_token is not null
    and discovery.claim_token_digest = public.agent_claim_token_digest(p_claim_token)
  returning true into v_ok;
  return coalesce(v_ok, false);
end;
$$;

------------------------------------------------------------------------------
-- 4. 保存：点选候选 = 已验证
------------------------------------------------------------------------------

/**
 * 按候选保存。浏览器提交的是 candidate_id，不是邮箱 —— 指纹、脱敏值、域名全部取自
 * 候选行，前端没有任何机会伪造一个"已验证"的身份。
 */
create or replace function public.upsert_my_git_identity_from_candidate(
  p_candidate_id uuid,
  p_display_name text,
  p_employee_code text default null,
  p_author_name_aliases text[] default null,
  p_gitlab_username text default null,
  p_gitlab_user_id text default null,
  p_git_identity_id uuid default null,
  p_expected_revision integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_display_name text;
  v_employee_code text;
  v_candidate public.git_identity_email_candidate;
  v_discovery public.git_identity_email_discovery;
  v_developer public.developer_identity;
  v_git public.developer_git_identity;
  v_aliases text[];
  v_claimed boolean := false;
  v_created boolean := false;
begin
  if v_actor is null then raise exception 'AUTH_REQUIRED'; end if;

  select candidate.* into v_candidate
  from public.git_identity_email_candidate candidate
  join public.git_identity_email_discovery discovery on discovery.id = candidate.discovery_id
  where candidate.id = p_candidate_id and discovery.requested_by = v_actor;
  if v_candidate.id is null then raise exception 'GIT_EMAIL_CANDIDATE_NOT_FOUND'; end if;
  select * into v_discovery from public.git_identity_email_discovery where id = v_candidate.discovery_id;
  if v_discovery.status <> 'SUCCEEDED' then raise exception 'GIT_EMAIL_DISCOVERY_NOT_READY'; end if;
  -- 候选是一次查询的快照。放任它长期有效等于把"已验证"变成一句旧话。
  if v_discovery.finished_at is null or v_discovery.finished_at < now() - interval '2 hours' then
    raise exception 'GIT_EMAIL_DISCOVERY_EXPIRED';
  end if;

  v_display_name := btrim(coalesce(p_display_name, ''));
  if v_display_name = '' then raise exception 'DEVELOPER_DISPLAY_NAME_REQUIRED'; end if;
  if char_length(v_display_name) > 64 then raise exception 'DEVELOPER_DISPLAY_NAME_TOO_LONG'; end if;
  v_employee_code := nullif(btrim(coalesce(p_employee_code, '')), '');

  -- 别名默认用 GitLab 提交里真实出现过的作者名，省得本人再猜一遍自己的 user.name。
  v_aliases := coalesce(p_author_name_aliases, v_candidate.author_names, array[]::text[]);
  if cardinality(v_aliases) > 10 then raise exception 'AUTHOR_ALIAS_LIMIT_EXCEEDED'; end if;

  select * into v_developer from public.developer_identity where auth_user_id = v_actor for update;
  if v_developer.id is null then
    select * into v_developer
    from public.developer_identity developer
    where developer.auth_user_id is null
      and lower(btrim(developer.display_name)) = lower(v_display_name)
      and coalesce(lower(developer.employee_code), '') = coalesce(lower(v_employee_code), '')
    order by developer.created_at
    limit 1
    for update;
    v_claimed := v_developer.id is not null;
  end if;
  if v_developer.id is not null and v_developer.status in ('CONFLICT', 'DISABLED') then
    raise exception 'DEVELOPER_IDENTITY_LOCKED';
  end if;
  if v_employee_code is not null and exists (
    select 1 from public.developer_identity other
    where lower(other.employee_code) = lower(v_employee_code)
      and other.id is distinct from v_developer.id
  ) then
    raise exception 'DEVELOPER_EMPLOYEE_CODE_CONFLICT';
  end if;

  if v_developer.id is null then
    insert into public.developer_identity(
      display_name, employee_code, status, auth_user_id, created_by, updated_by
    ) values (
      v_display_name, v_employee_code, 'VERIFIED', v_actor, v_actor, v_actor
    ) returning * into v_developer;
    v_created := true;
  else
    update public.developer_identity
    set display_name = v_display_name,
        employee_code = v_employee_code,
        status = 'VERIFIED',
        auth_user_id = v_actor,
        revision = revision + 1,
        updated_by = v_actor,
        updated_at = now()
    where id = v_developer.id
    returning * into v_developer;
  end if;

  if exists (
    select 1 from public.developer_git_identity git
    where git.email_fingerprint = v_candidate.email_fingerprint
      and git.verification_status in ('VERIFIED', 'UNVERIFIED')
      and git.valid_until is null
      and git.developer_identity_id <> v_developer.id
  ) then
    raise exception 'GIT_EMAIL_ALREADY_BOUND';
  end if;

  if p_git_identity_id is null then
    insert into public.developer_git_identity(
      developer_identity_id, provider, email_fingerprint, masked_email, email_domain,
      author_name_aliases, gitlab_username, gitlab_user_id, verification_status,
      created_by, updated_by
    ) values (
      v_developer.id, 'gitlab', v_candidate.email_fingerprint, v_candidate.masked_email,
      v_candidate.email_domain, v_aliases,
      coalesce(nullif(btrim(coalesce(p_gitlab_username, '')), ''), v_discovery.gitlab_username),
      coalesce(nullif(btrim(coalesce(p_gitlab_user_id, '')), ''), v_discovery.gitlab_user_id),
      'VERIFIED', v_actor, v_actor
    ) returning * into v_git;
  else
    select * into v_git from public.developer_git_identity where id = p_git_identity_id for update;
    if v_git.id is null or v_git.developer_identity_id <> v_developer.id then
      raise exception 'GIT_IDENTITY_NOT_FOUND';
    end if;
    if p_expected_revision is not null and v_git.revision <> p_expected_revision then
      raise exception 'REVISION_CONFLICT';
    end if;
    update public.developer_git_identity
    set email_fingerprint = v_candidate.email_fingerprint,
        masked_email = v_candidate.masked_email,
        email_domain = v_candidate.email_domain,
        author_name_aliases = v_aliases,
        gitlab_username = coalesce(nullif(btrim(coalesce(p_gitlab_username, '')), ''), v_discovery.gitlab_username),
        gitlab_user_id = coalesce(nullif(btrim(coalesce(p_gitlab_user_id, '')), ''), v_discovery.gitlab_user_id),
        verification_status = 'VERIFIED',
        valid_until = null,
        revision = revision + 1,
        updated_by = v_actor,
        updated_at = now()
    where id = v_git.id
    returning * into v_git;
  end if;

  insert into public.analysis_scope_decision_audit(
    decision_type, source, actor_id, reason_codes, after_state
  ) values (
    'IDENTITY_CONFIG', 'USER', v_actor,
    case
      when v_created then array['SELF_IDENTITY_CREATED', 'GITLAB_COMMIT_VERIFIED']
      when v_claimed then array['SELF_IDENTITY_CLAIMED', 'GITLAB_COMMIT_VERIFIED']
      else array['SELF_IDENTITY_UPDATED', 'GITLAB_COMMIT_VERIFIED']
    end,
    jsonb_build_object(
      'developer_id', v_developer.id,
      'git_identity_id', v_git.id,
      'masked_email', v_git.masked_email,
      'verification_status', v_git.verification_status,
      'discovery_id', v_discovery.id,
      'gitlab_username', v_discovery.gitlab_username,
      'commit_count', v_candidate.commit_count
    )
  );

  return jsonb_build_object(
    'developer_id', v_developer.id,
    'git_identity_id', v_git.id,
    'developer_revision', v_developer.revision,
    'git_revision', v_git.revision,
    'masked_email', v_git.masked_email,
    'verification_status', v_git.verification_status,
    'claimed_existing_developer', v_claimed
  );
exception when unique_violation then
  raise exception 'GIT_EMAIL_ALREADY_BOUND';
end;
$$;

/**
 * 手输邮箱（回退路径）现在落 UNVERIFIED。
 *
 * V1.12 这里写的是 VERIFIED —— 那等于把"自己声称"当成"已验证"。有了反查之后，
 * "已验证"必须有他自己 MR 里的提交作为证据，手输一律标成未验证并在页面上写明。
 */
create or replace function public.upsert_my_git_identity_from_email(
  p_git_identity_id uuid,
  p_display_name text,
  p_employee_code text,
  p_email text,
  p_author_name_aliases text[] default array[]::text[],
  p_gitlab_username text default null,
  p_gitlab_user_id text default null,
  p_expected_revision integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, vault, extensions
as $$
declare
  v_actor uuid := auth.uid();
  v_display_name text;
  v_employee_code text;
  v_email text;
  v_domain text;
  v_local text;
  v_masked text;
  v_pepper text;
  v_fingerprint text;
  v_developer public.developer_identity;
  v_git public.developer_git_identity;
  v_claimed boolean := false;
  v_created boolean := false;
begin
  if v_actor is null then
    raise exception 'AUTH_REQUIRED';
  end if;

  v_display_name := btrim(coalesce(p_display_name, ''));
  if v_display_name = '' then
    raise exception 'DEVELOPER_DISPLAY_NAME_REQUIRED';
  end if;
  if char_length(v_display_name) > 64 then
    raise exception 'DEVELOPER_DISPLAY_NAME_TOO_LONG';
  end if;
  v_employee_code := nullif(btrim(coalesce(p_employee_code, '')), '');

  v_email := lower(btrim(coalesce(p_email, '')));
  if char_length(v_email) > 320
     or v_email !~ '^[^@[:space:][:cntrl:]]{1,64}@[^@[:space:][:cntrl:]]{1,255}$' then
    raise exception 'IDENTITY_EMAIL_INVALID';
  end if;
  if cardinality(coalesce(p_author_name_aliases, array[]::text[])) > 10 then
    raise exception 'AUTHOR_ALIAS_LIMIT_EXCEEDED';
  end if;

  select secret.decrypted_secret into v_pepper
  from vault.decrypted_secrets secret
  where secret.name = 'analysis_identity_pepper'
  order by secret.created_at desc
  limit 1;
  if coalesce(v_pepper, '') = '' then
    raise exception 'IDENTITY_PEPPER_MISSING';
  end if;

  v_local := split_part(v_email, '@', 1);
  v_domain := split_part(v_email, '@', 2);
  v_masked := left(v_local, 1) || '***@' || v_domain;
  v_fingerprint := encode(hmac(
    convert_to(v_email, 'UTF8'),
    convert_to(v_pepper, 'UTF8'),
    'sha256'
  ), 'hex');

  select * into v_developer
  from public.developer_identity
  where auth_user_id = v_actor
  for update;

  if v_developer.id is null then
    select * into v_developer
    from public.developer_identity developer
    where developer.auth_user_id is null
      and lower(btrim(developer.display_name)) = lower(v_display_name)
      and coalesce(lower(developer.employee_code), '') = coalesce(lower(v_employee_code), '')
    order by developer.created_at
    limit 1
    for update;
    v_claimed := v_developer.id is not null;
  end if;

  if v_developer.id is not null and v_developer.status in ('CONFLICT', 'DISABLED') then
    raise exception 'DEVELOPER_IDENTITY_LOCKED';
  end if;

  if v_employee_code is not null and exists (
    select 1 from public.developer_identity other
    where lower(other.employee_code) = lower(v_employee_code)
      and other.id is distinct from v_developer.id
  ) then
    raise exception 'DEVELOPER_EMPLOYEE_CODE_CONFLICT';
  end if;

  if v_developer.id is null then
    insert into public.developer_identity(
      display_name, employee_code, status, auth_user_id, created_by, updated_by
    ) values (
      v_display_name, v_employee_code, 'VERIFIED', v_actor, v_actor, v_actor
    ) returning * into v_developer;
    v_created := true;
  else
    update public.developer_identity
    set display_name = v_display_name,
        employee_code = v_employee_code,
        status = 'VERIFIED',
        auth_user_id = v_actor,
        revision = revision + 1,
        updated_by = v_actor,
        updated_at = now()
    where id = v_developer.id
    returning * into v_developer;
  end if;

  if exists (
    select 1 from public.developer_git_identity git
    where git.email_fingerprint = v_fingerprint
      and git.verification_status in ('VERIFIED', 'UNVERIFIED')
      and git.valid_until is null
      and git.developer_identity_id <> v_developer.id
  ) then
    raise exception 'GIT_EMAIL_ALREADY_BOUND';
  end if;

  if p_git_identity_id is null then
    insert into public.developer_git_identity(
      developer_identity_id, provider, email_fingerprint, masked_email, email_domain,
      author_name_aliases, gitlab_username, gitlab_user_id, verification_status,
      created_by, updated_by
    ) values (
      v_developer.id, 'gitlab', v_fingerprint, v_masked, v_domain,
      coalesce(p_author_name_aliases, array[]::text[]),
      nullif(btrim(coalesce(p_gitlab_username, '')), ''),
      nullif(btrim(coalesce(p_gitlab_user_id, '')), ''),
      'UNVERIFIED', v_actor, v_actor
    ) returning * into v_git;
  else
    select * into v_git
    from public.developer_git_identity
    where id = p_git_identity_id
    for update;
    if v_git.id is null or v_git.developer_identity_id <> v_developer.id then
      raise exception 'GIT_IDENTITY_NOT_FOUND';
    end if;
    if p_expected_revision is not null and v_git.revision <> p_expected_revision then
      raise exception 'REVISION_CONFLICT';
    end if;
    update public.developer_git_identity
    set email_fingerprint = v_fingerprint,
        masked_email = v_masked,
        email_domain = v_domain,
        author_name_aliases = coalesce(p_author_name_aliases, array[]::text[]),
        gitlab_username = nullif(btrim(coalesce(p_gitlab_username, '')), ''),
        gitlab_user_id = nullif(btrim(coalesce(p_gitlab_user_id, '')), ''),
        verification_status = 'UNVERIFIED',
        valid_until = null,
        revision = revision + 1,
        updated_by = v_actor,
        updated_at = now()
    where id = v_git.id
    returning * into v_git;
  end if;

  insert into public.analysis_scope_decision_audit(
    decision_type, source, actor_id, reason_codes, after_state
  ) values (
    'IDENTITY_CONFIG', 'USER', v_actor,
    case
      when v_created then array['SELF_IDENTITY_CREATED', 'MANUAL_EMAIL_UNVERIFIED']
      when v_claimed then array['SELF_IDENTITY_CLAIMED', 'MANUAL_EMAIL_UNVERIFIED']
      else array['SELF_IDENTITY_UPDATED', 'MANUAL_EMAIL_UNVERIFIED']
    end,
    jsonb_build_object(
      'developer_id', v_developer.id,
      'git_identity_id', v_git.id,
      'masked_email', v_git.masked_email,
      'verification_status', v_git.verification_status
    )
  );

  return jsonb_build_object(
    'developer_id', v_developer.id,
    'git_identity_id', v_git.id,
    'developer_revision', v_developer.revision,
    'git_revision', v_git.revision,
    'masked_email', v_git.masked_email,
    'verification_status', v_git.verification_status,
    'claimed_existing_developer', v_claimed
  );
exception when unique_violation then
  raise exception 'GIT_EMAIL_ALREADY_BOUND';
end;
$$;

------------------------------------------------------------------------------
-- 5. 最小权限
------------------------------------------------------------------------------

revoke execute on function public.enqueue_my_git_email_discovery(text, integer) from public, anon;
grant execute on function public.enqueue_my_git_email_discovery(text, integer) to authenticated, service_role;
revoke execute on function public.get_my_git_email_discovery(uuid) from public, anon;
grant execute on function public.get_my_git_email_discovery(uuid) to authenticated, service_role;
revoke execute on function public.upsert_my_git_identity_from_candidate(
  uuid, text, text, text[], text, text, uuid, integer
) from public, anon;
grant execute on function public.upsert_my_git_identity_from_candidate(
  uuid, text, text, text[], text, text, uuid, integer
) to authenticated, service_role;

revoke execute on function public.claim_next_git_email_discovery(text, integer) from public, anon, authenticated;
revoke execute on function public.heartbeat_git_email_discovery(uuid, text, uuid, integer) from public, anon, authenticated;
revoke execute on function public.complete_git_email_discovery(uuid, text, uuid, text, text, integer, boolean, jsonb) from public, anon, authenticated;
revoke execute on function public.fail_git_email_discovery(uuid, text, uuid, text, text) from public, anon, authenticated;
revoke execute on function public.release_git_email_discovery_claim(uuid, text, uuid) from public, anon, authenticated;

grant execute on function public.claim_next_git_email_discovery(text, integer) to service_role;
grant execute on function public.heartbeat_git_email_discovery(uuid, text, uuid, integer) to service_role;
grant execute on function public.complete_git_email_discovery(uuid, text, uuid, text, text, integer, boolean, jsonb) to service_role;
grant execute on function public.fail_git_email_discovery(uuid, text, uuid, text, text) to service_role;
grant execute on function public.release_git_email_discovery_claim(uuid, text, uuid) to service_role;

comment on table public.git_identity_email_discovery is
  'Queue of GitLab username -> commit email lookups executed by the local Worker. Stores no raw email.';
comment on table public.git_identity_email_candidate is
  'Masked commit-email candidates discovered from the requester own merge requests. Fingerprint only; never a raw email.';
comment on function public.upsert_my_git_identity_from_candidate(
  uuid, text, text, text[], text, text, uuid, integer
) is 'Self-service save with GitLab commit evidence: fingerprint comes from the candidate row, so the browser cannot forge a VERIFIED identity.';
comment on function public.upsert_my_git_identity_from_email(
  uuid, text, text, text, text[], text, text, integer
) is 'Manual fallback. Always stores UNVERIFIED because a typed email carries no evidence.';

commit;
