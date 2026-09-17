-- V1.7：模型连接测试由本地 Worker 执行。
-- 浏览器只负责排队和读取安全结果；API Key 仅在有效 Worker claim 下从 Vault 读取。

begin;

create table public.model_connectivity_test (
  id uuid primary key default gen_random_uuid(),
  model_config_id uuid not null references public.ai_model_config(id) on delete cascade,
  requested_by uuid not null references auth.users(id),
  status text not null default 'QUEUED'
    check (status in ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED')),
  attempt integer not null default 0 check (attempt >= 0),
  worker_id text,
  lease_expires_at timestamptz,
  heartbeat_at timestamptz,
  claim_token_digest text,
  base_url_snapshot text not null,
  model_name_snapshot text not null,
  request_timeout_ms_snapshot integer not null
    check (request_timeout_ms_snapshot between 1000 and 600000),
  status_code integer check (status_code between 100 and 599),
  latency_ms integer check (latency_ms >= 0),
  error_code text,
  error_message text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index model_connectivity_test_queue_idx
  on public.model_connectivity_test(status, created_at);
create unique index model_connectivity_test_one_active_per_model_idx
  on public.model_connectivity_test(model_config_id)
  where status in ('QUEUED', 'RUNNING');

alter table public.model_connectivity_test enable row level security;
revoke all on table public.model_connectivity_test from public, anon, authenticated;

create or replace function public.enqueue_model_connectivity_test(p_model_config_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cfg public.ai_model_config;
  v_existing uuid;
  v_id uuid;
begin
  perform public.ensure_admin();
  if p_model_config_id is null then
    raise exception 'model_config_id is required';
  end if;

  perform pg_advisory_xact_lock(hashtext('model_connectivity_test:' || p_model_config_id::text));
  select * into v_cfg from public.ai_model_config where id = p_model_config_id;
  if v_cfg.id is null then
    raise exception 'model config not found';
  end if;
  if not public.model_config_has_api_key(v_cfg.api_key_secret_id) then
    raise exception 'MODEL_SECRET_MISSING';
  end if;

  select test.id into v_existing
  from public.model_connectivity_test test
  where test.model_config_id = p_model_config_id
    and test.status in ('QUEUED', 'RUNNING')
  order by test.created_at desc
  limit 1;
  if v_existing is not null then
    return v_existing;
  end if;

  insert into public.model_connectivity_test (
    model_config_id, requested_by, base_url_snapshot, model_name_snapshot,
    request_timeout_ms_snapshot
  ) values (
    v_cfg.id, auth.uid(), v_cfg.base_url, v_cfg.model_name,
    least(greatest(coalesce(v_cfg.request_timeout_ms, 30000), 1000), 30000)
  ) returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.get_model_connectivity_test(p_test_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_test public.model_connectivity_test;
begin
  perform public.ensure_admin();
  select * into v_test from public.model_connectivity_test where id = p_test_id;
  if v_test.id is null then
    raise exception 'model connectivity test not found';
  end if;
  return jsonb_build_object(
    'id', v_test.id,
    'model_config_id', v_test.model_config_id,
    'status', v_test.status,
    'attempt', v_test.attempt,
    'status_code', v_test.status_code,
    'latency_ms', v_test.latency_ms,
    'error_code', v_test.error_code,
    'error_message', v_test.error_message,
    'started_at', v_test.started_at,
    'finished_at', v_test.finished_at,
    'created_at', v_test.created_at,
    'updated_at', v_test.updated_at
  );
end;
$$;

create or replace function public.claim_next_model_connectivity_test(
  p_worker_id text,
  p_lease_seconds integer default 90
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_test public.model_connectivity_test;
  v_token uuid;
begin
  if p_worker_id is null or btrim(p_worker_id) = '' then
    raise exception 'worker_id is required';
  end if;
  if p_lease_seconds is null or p_lease_seconds < 45 then
    p_lease_seconds := 90;
  end if;

  select test.* into v_test
  from public.model_connectivity_test test
  where test.status = 'QUEUED'
     or (test.status = 'RUNNING' and test.lease_expires_at < now())
  order by test.created_at
  for update skip locked
  limit 1;
  if v_test.id is null then
    return null;
  end if;

  v_token := gen_random_uuid();
  update public.model_connectivity_test
  set status = 'RUNNING',
      attempt = attempt + 1,
      worker_id = p_worker_id,
      lease_expires_at = now() + make_interval(secs => p_lease_seconds),
      heartbeat_at = now(),
      claim_token_digest = public.agent_claim_token_digest(v_token),
      status_code = null,
      latency_ms = null,
      error_code = null,
      error_message = null,
      started_at = coalesce(started_at, now()),
      finished_at = null,
      updated_at = now()
  where id = v_test.id
  returning * into v_test;

  return (to_jsonb(v_test)
    - 'claim_token_digest'
    - 'requested_by')
    || jsonb_build_object('claim_token', v_token);
end;
$$;

create or replace function public.heartbeat_model_connectivity_test(
  p_test_id uuid,
  p_worker_id text,
  p_claim_token uuid,
  p_lease_seconds integer default 90
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
  if p_lease_seconds is null or p_lease_seconds < 45 then p_lease_seconds := 90; end if;
  update public.model_connectivity_test test
  set heartbeat_at = now(),
      lease_expires_at = now() + make_interval(secs => p_lease_seconds),
      updated_at = now()
  where test.id = p_test_id
    and test.status = 'RUNNING'
    and test.worker_id = p_worker_id
    and test.lease_expires_at >= now()
    and test.claim_token_digest = public.agent_claim_token_digest(p_claim_token)
  returning true into v_ok;
  return coalesce(v_ok, false);
end;
$$;

create or replace function public.get_model_secret_for_connectivity_test(
  p_test_id uuid,
  p_worker_id text,
  p_claim_token uuid
)
returns text
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_secret_id uuid;
  v_secret text;
  v_ok boolean;
begin
  select cfg.api_key_secret_id,
         test.status = 'RUNNING'
         and test.worker_id = p_worker_id
         and test.lease_expires_at >= now()
         and p_claim_token is not null
         and test.claim_token_digest = public.agent_claim_token_digest(p_claim_token)
    into v_secret_id, v_ok
  from public.model_connectivity_test test
  join public.ai_model_config cfg on cfg.id = test.model_config_id
  where test.id = p_test_id;

  if v_ok is null then raise exception 'model connectivity test not found'; end if;
  if not v_ok then raise exception 'TASK_LEASE_LOST'; end if;
  if not public.model_config_has_api_key(v_secret_id) then
    raise exception 'MODEL_SECRET_MISSING';
  end if;
  select decrypted_secret into v_secret from vault.decrypted_secrets where id = v_secret_id;
  if v_secret is null then raise exception 'MODEL_SECRET_MISSING'; end if;
  return v_secret;
end;
$$;

create or replace function public.complete_model_connectivity_test(
  p_test_id uuid,
  p_worker_id text,
  p_claim_token uuid,
  p_status_code integer,
  p_latency_ms integer
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ok boolean;
begin
  update public.model_connectivity_test test
  set status = 'SUCCEEDED', status_code = p_status_code,
      latency_ms = greatest(coalesce(p_latency_ms, 0), 0),
      error_code = null, error_message = null,
      worker_id = null, lease_expires_at = null, heartbeat_at = null,
      claim_token_digest = null, finished_at = now(), updated_at = now()
  where test.id = p_test_id
    and test.status = 'RUNNING'
    and test.worker_id = p_worker_id
    and test.lease_expires_at >= now()
    and p_claim_token is not null
    and test.claim_token_digest = public.agent_claim_token_digest(p_claim_token)
    and p_status_code between 200 and 299
  returning true into v_ok;
  return coalesce(v_ok, false);
end;
$$;

create or replace function public.fail_model_connectivity_test(
  p_test_id uuid,
  p_worker_id text,
  p_claim_token uuid,
  p_error_code text,
  p_error_message text,
  p_status_code integer default null,
  p_latency_ms integer default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ok boolean;
begin
  update public.model_connectivity_test test
  set status = 'FAILED',
      status_code = case when p_status_code between 100 and 599 then p_status_code else null end,
      latency_ms = greatest(coalesce(p_latency_ms, 0), 0),
      error_code = left(coalesce(nullif(p_error_code, ''), 'MODEL_TEST_FAILED'), 80),
      error_message = left(coalesce(nullif(p_error_message, ''), '模型连接测试失败'), 300),
      worker_id = null, lease_expires_at = null, heartbeat_at = null,
      claim_token_digest = null, finished_at = now(), updated_at = now()
  where test.id = p_test_id
    and test.status = 'RUNNING'
    and test.worker_id = p_worker_id
    and test.lease_expires_at >= now()
    and p_claim_token is not null
    and test.claim_token_digest = public.agent_claim_token_digest(p_claim_token)
  returning true into v_ok;
  return coalesce(v_ok, false);
end;
$$;

create or replace function public.release_model_connectivity_test_claim(
  p_test_id uuid,
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
  update public.model_connectivity_test test
  set status = 'QUEUED', worker_id = null, lease_expires_at = null,
      heartbeat_at = null, claim_token_digest = null, updated_at = now()
  where test.id = p_test_id
    and test.status = 'RUNNING'
    and test.worker_id = p_worker_id
    and p_claim_token is not null
    and test.claim_token_digest = public.agent_claim_token_digest(p_claim_token)
  returning true into v_ok;
  return coalesce(v_ok, false);
end;
$$;

revoke execute on function public.enqueue_model_connectivity_test(uuid) from public, anon;
grant execute on function public.enqueue_model_connectivity_test(uuid) to authenticated, service_role;
revoke execute on function public.get_model_connectivity_test(uuid) from public, anon;
grant execute on function public.get_model_connectivity_test(uuid) to authenticated, service_role;

revoke execute on function public.claim_next_model_connectivity_test(text, integer) from public, anon, authenticated;
revoke execute on function public.heartbeat_model_connectivity_test(uuid, text, uuid, integer) from public, anon, authenticated;
revoke execute on function public.get_model_secret_for_connectivity_test(uuid, text, uuid) from public, anon, authenticated;
revoke execute on function public.complete_model_connectivity_test(uuid, text, uuid, integer, integer) from public, anon, authenticated;
revoke execute on function public.fail_model_connectivity_test(uuid, text, uuid, text, text, integer, integer) from public, anon, authenticated;
revoke execute on function public.release_model_connectivity_test_claim(uuid, text, uuid) from public, anon, authenticated;

grant execute on function public.claim_next_model_connectivity_test(text, integer) to service_role;
grant execute on function public.heartbeat_model_connectivity_test(uuid, text, uuid, integer) to service_role;
grant execute on function public.get_model_secret_for_connectivity_test(uuid, text, uuid) to service_role;
grant execute on function public.complete_model_connectivity_test(uuid, text, uuid, integer, integer) to service_role;
grant execute on function public.fail_model_connectivity_test(uuid, text, uuid, text, text, integer, integer) to service_role;
grant execute on function public.release_model_connectivity_test_claim(uuid, text, uuid) to service_role;

commit;
