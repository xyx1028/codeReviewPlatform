-- V1.13 调整：候选列表按产品要求展示邮箱原文。
--
-- ## 这改动了一条既有边界，所以先把代价写清楚
--
-- V1.11 起的约束是"邮箱明文不进表、不进返回值、不进日志"。而"让浏览器看到原文"在架构上
-- 必然要求明文落库一次：候选是 Worker 异步写入、浏览器随后轮询读出的，两者之间没有别的通道。
--
-- 因此这里**只放开临时候选表**，范围压到最小：
--
--   * `git_identity_email_candidate.email_plain`：明文，仅用于展示。它的生命周期跟着一次查找 ——
--     同一个人再查一次会先 delete 掉旧候选（见 complete_git_email_discovery），
--     账号删除时随 discovery 级联消失，2 小时后连保存都不再接受（GIT_EMAIL_DISCOVERY_EXPIRED）。
--   * **正式身份表 `developer_git_identity` 一个字节明文都不存**，仍然只有 HMAC 指纹 + 脱敏值。
--     upsert_my_git_identity_from_candidate 只读候选的 fingerprint/masked/domain，不碰 email_plain。
--   * 读取仍然只经 get_my_git_email_discovery，边界是 auth.uid()：只能看到自己的候选。
--   * Worker 日志、审计表、运行事件一律不记邮箱（脱敏的也不记），这条没有变。

begin;

alter table public.git_identity_email_candidate
  add column if not exists email_plain text;

comment on column public.git_identity_email_candidate.email_plain is
  'Plaintext commit email of a short-lived candidate, shown to its owner only. '
  'Never copied into developer_git_identity, which stores the HMAC fingerprint and masked form only.';

-- 回填明文：与 20260920032058 的版本逐字相同，只多写一列。
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
      discovery_id, email_fingerprint, masked_email, email_domain, email_plain,
      author_names, commit_count, last_committed_at, repositories, merge_request_refs
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

-- 读取：多返回一个 email（明文，仅本人可见）。指纹依旧不出库。
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
        'email', candidate.email_plain,
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

commit;
