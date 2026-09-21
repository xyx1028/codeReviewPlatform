--
-- V1.13.1：反查出来的候选邮箱必须属于**这个** GitLab 用户
--
-- 原实现只按 author_id 过滤 MR，不过滤 MR 里的提交。审核人会提 `feature_sit -> release`
-- 这类集成 MR，里面带着全组人的提交，于是他的候选列表里排第一的往往是别人的邮箱
-- （实测 jin_gu：14 个候选，第一个是 hook_wang@kingdee.com 的 156 条提交）。
--
-- Worker 侧改成逐个邮箱要求可核对的归属依据，这里只做两件事：
--   1. 把依据（match_reason）连同候选一起落库，让界面能说清"它为什么在列表里"；
--   2. 记下被剔除的邮箱个数（excluded_candidate_count），界面照实显示，
--      不让人以为平台只读到了一个邮箱。
--
-- 兼容：两列都可空 / 有默认值；complete_git_email_discovery 的新参数带默认值，
-- 发布窗口里未更新的 Worker 仍能调用（此时 excluded_candidate_count 记 0、match_reason 为 null）。

begin;

alter table public.git_identity_email_candidate
  add column if not exists match_reason text;

alter table public.git_identity_email_candidate
  drop constraint if exists git_identity_email_candidate_match_reason_check;
alter table public.git_identity_email_candidate
  add constraint git_identity_email_candidate_match_reason_check
  check (match_reason is null or match_reason in (
    'GITLAB_EMAIL_MATCH',
    'AUTHOR_NAME_MATCH',
    'EMAIL_LOCAL_MATCH',
    'SOLE_AUTHOR_IN_OWN_MERGE_REQUEST'
  ));

comment on column public.git_identity_email_candidate.match_reason is
  'Why this commit email is attributed to the queried GitLab user. '
  'Null only for rows written by pre-V1.13.1 workers.';

alter table public.git_identity_email_discovery
  add column if not exists excluded_candidate_count integer not null default 0;

alter table public.git_identity_email_discovery
  drop constraint if exists git_identity_email_discovery_excluded_count_check;
alter table public.git_identity_email_discovery
  add constraint git_identity_email_discovery_excluded_count_check
  check (excluded_candidate_count >= 0);

comment on column public.git_identity_email_discovery.excluded_candidate_count is
  'Commit emails that were read but belong to somebody else (other people''s commits '
  'carried by integration merge requests the user opened).';

------------------------------------------------------------------------------
-- complete_git_email_discovery：加一个带默认值的参数，并写入 match_reason
-- 加参数会改签名，而 create or replace 改不了签名（会留下旧重载当后门），所以先 drop。
------------------------------------------------------------------------------

drop function if exists public.complete_git_email_discovery(
  uuid, text, uuid, text, text, integer, boolean, jsonb);

create or replace function public.complete_git_email_discovery(
  p_discovery_id uuid,
  p_worker_id text,
  p_claim_token uuid,
  p_gitlab_user_id text,
  p_gitlab_display_name text,
  p_merge_request_count integer,
  p_partial boolean,
  p_candidates jsonb,
  p_excluded_candidate_count integer default 0
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
  v_reason text;
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
    -- 未知依据当成"没有依据"（null）而不是报错：Worker 与库的版本差不该让整次反查失败。
    v_reason := nullif(btrim(coalesce(v_item->>'match_reason', '')), '');
    if v_reason is not null and v_reason not in (
      'GITLAB_EMAIL_MATCH', 'AUTHOR_NAME_MATCH', 'EMAIL_LOCAL_MATCH', 'SOLE_AUTHOR_IN_OWN_MERGE_REQUEST'
    ) then
      v_reason := null;
    end if;

    insert into public.git_identity_email_candidate (
      discovery_id, email_fingerprint, masked_email, email_domain, email_plain,
      author_names, commit_count, last_committed_at, repositories, merge_request_refs, match_reason
    ) values (
      p_discovery_id, v_fingerprint, v_masked, v_domain, v_email,
      (select coalesce(array_agg(distinct left(name, 64)), array[]::text[])
       from jsonb_array_elements_text(coalesce(v_item->'author_names', '[]'::jsonb)) name
       where btrim(name) <> ''),
      greatest(coalesce((v_item->>'commit_count')::integer, 0), 0),
      nullif(v_item->>'last_committed_at', '')::timestamptz,
      case when jsonb_typeof(coalesce(v_item->'repositories', '{}'::jsonb)) = 'object'
        then v_item->'repositories' else '{}'::jsonb end,
      (select coalesce(array_agg(distinct left(ref, 80)), array[]::text[])
       from jsonb_array_elements_text(coalesce(v_item->'merge_request_refs', '[]'::jsonb)) ref
       where btrim(ref) <> ''),
      v_reason
    )
    on conflict (discovery_id, email_fingerprint) do update
    set commit_count = greatest(git_identity_email_candidate.commit_count, excluded.commit_count),
        last_committed_at = greatest(git_identity_email_candidate.last_committed_at, excluded.last_committed_at),
        author_names = excluded.author_names,
        repositories = excluded.repositories,
        merge_request_refs = excluded.merge_request_refs,
        match_reason = excluded.match_reason;
    v_count := v_count + 1;
  end loop;

  update public.git_identity_email_discovery
  set status = 'SUCCEEDED',
      gitlab_user_id = nullif(btrim(coalesce(p_gitlab_user_id, '')), ''),
      gitlab_display_name = nullif(btrim(coalesce(p_gitlab_display_name, '')), ''),
      merge_request_count = greatest(coalesce(p_merge_request_count, 0), 0),
      candidate_count = (select count(*) from public.git_identity_email_candidate where discovery_id = p_discovery_id),
      excluded_candidate_count = greatest(coalesce(p_excluded_candidate_count, 0), 0),
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
    'excluded_candidate_count', v_discovery.excluded_candidate_count,
    'accepted_count', v_count
  );
end;
$$;

revoke execute on function public.complete_git_email_discovery(
  uuid, text, uuid, text, text, integer, boolean, jsonb, integer) from public, anon, authenticated;
grant execute on function public.complete_git_email_discovery(
  uuid, text, uuid, text, text, integer, boolean, jsonb, integer) to service_role;

------------------------------------------------------------------------------
-- get_my_git_email_discovery：多返回归属依据与剔除数
------------------------------------------------------------------------------

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
    'excluded_candidate_count', v_discovery.excluded_candidate_count,
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
        'email', candidate.email_plain,
        'masked_email', candidate.masked_email,
        'email_domain', candidate.email_domain,
        'author_names', candidate.author_names,
        'commit_count', candidate.commit_count,
        'last_committed_at', candidate.last_committed_at,
        'repositories', candidate.repositories,
        'merge_request_refs', candidate.merge_request_refs,
        'match_reason', candidate.match_reason,
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

revoke execute on function public.get_my_git_email_discovery(uuid) from public, anon;
grant execute on function public.get_my_git_email_discovery(uuid) to authenticated, service_role;

commit;
