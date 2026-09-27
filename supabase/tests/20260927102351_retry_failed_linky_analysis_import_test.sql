\set ON_ERROR_STOP on
\timing off
\set QUIET on

begin;
set local client_min_messages = warning;

create or replace function pg_temp.assert(p_cond boolean, p_msg text)
returns void language plpgsql as $$
begin
  if p_cond is null or not p_cond then
    raise exception 'ASSERT FAILED: %', p_msg;
  end if;
end;
$$;

do $test$
declare
  v_user uuid := '32000000-0000-4000-a000-000000000001';
  v_viewer uuid := '32000000-0000-4000-a000-000000000002';
  v_model uuid := '32000000-0000-4000-a000-000000000003';
  v_batch uuid := '32000000-0000-4000-b000-000000000001';
  v_secret uuid;
  v_request uuid;
  v_retry uuid;
  v_claim jsonb;
  v_token uuid;
  v_error text;
begin
  insert into auth.users (id, email) values
    (v_user, 'v132-retry@example.invalid'),
    (v_viewer, 'v132-viewer@example.invalid')
  on conflict (id) do nothing;
  insert into public.user_profile (id, role, display_name) values
    (v_user, 'ADMIN', 'V1.32 重试测试'),
    (v_viewer, 'VIEWER', 'V1.32 无权重试测试')
  on conflict (id) do update set role = excluded.role, display_name = excluded.display_name;

  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', v_user::text, 'role', 'authenticated')::text,
    true
  );
  set local role service_role;
  v_secret := public.admin_vault_create_secret('v132-not-a-real-key', 'v132_retry_key');
  reset role;

  insert into public.ai_model_config (
    id, display_name, base_url, model_name, api_key_secret_id, enabled, max_parallel_tasks, created_by
  ) values (
    v_model, 'V1.32 retry model', 'https://v132-model.example.invalid', 'v132-model', v_secret, true, 1, v_user
  );
  insert into public.review_batch (
    id, name, week_code, status, default_branch, ai_model_config_id, created_by
  ) values (
    v_batch, 'V1.32 失败后重试', 'V132-RETRY', 'DRAFT', 'release', v_model, v_user
  );

  v_request := public.request_linky_batch_import_for_analysis(
    v_batch, '平台开发组', array['US-V132-001', 'US-V132-002'], null, 'R20261016', 14
  );

  set local role service_role;
  v_claim := public.claim_next_linky_batch_import('worker-v132-first', 900);
  v_token := (v_claim ->> 'claim_token')::uuid;
  perform public.record_linky_batch_story_failure(
    v_request, 'worker-v132-first', v_token, 'US-V132-001', 'LINKY_PROXY_UNREACHABLE', '宿主机代理不可用', 1
  );
  perform public.fail_linky_batch_import(
    v_request, 'worker-v132-first', v_token, 'LINKY_PROXY_UNREACHABLE', '宿主机代理不可用'
  );
  reset role;

  perform pg_temp.assert(
    (select status = 'FAILED' and attempt = 1 and stories_failed <> '[]'::jsonb
     from public.linky_batch_import_request where id = v_request),
    'first automatic preparation attempt is recorded as failed'
  );
  perform pg_temp.assert(
    has_function_privilege('authenticated', 'public.retry_linky_batch_import_for_analysis(uuid)', 'EXECUTE')
    and not has_function_privilege('anon', 'public.retry_linky_batch_import_for_analysis(uuid)', 'EXECUTE'),
    'only authenticated callers receive the retry RPC'
  );

  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', v_viewer::text, 'role', 'authenticated')::text,
    true
  );
  begin
    perform public.retry_linky_batch_import_for_analysis(v_request);
    raise exception 'viewer must not retry another batch';
  exception when others then
    v_error := SQLERRM;
    perform pg_temp.assert(v_error not like 'viewer must not%', 'retry enforces batch management permission');
  end;

  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', v_user::text, 'role', 'authenticated')::text,
    true
  );
  v_retry := public.retry_linky_batch_import_for_analysis(v_request);
  perform pg_temp.assert(v_retry = v_request, 'retry reuses the same import request instead of creating a duplicate');
  perform pg_temp.assert(
    (select status = 'QUEUED'
        and workspace_name = '平台开发组'
        and release_window = 'R20261016'
        and story_codes = array['US-V132-001', 'US-V132-002']
        and analysis_context_version = 2
        and commit_window_days = 14
        and analysis_status = 'PENDING'
        and error_code is null
        and error_message is null
        and worker_id is null
        and started_at is null
        and finished_at is null
     from public.linky_batch_import_request where id = v_request),
    'retry preserves frozen range and analysis intent but clears the terminal failure state'
  );

  set local role service_role;
  v_claim := public.claim_next_linky_batch_import('worker-v132-retry', 900);
  reset role;
  perform pg_temp.assert(
    (v_claim ->> 'id')::uuid = v_request
    and (v_claim ->> 'attempt')::integer = 2
    and (v_claim -> 'stories_failed') = '[]'::jsonb
    and (v_claim ->> 'attachments_failed')::integer = 0,
    'the next Worker claim is the second attempt and resets previous per-attempt progress'
  );
end;
$test$;

select 'ALL_V132_LINKY_IMPORT_RETRY_TESTS_PASSED' as result;

rollback;
