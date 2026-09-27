-- 20260927045147_linky_import_auto_enqueue_analysis_test.sql
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
  v_user uuid := '31000000-0000-4000-a000-000000000001';
  v_model uuid := '31000000-0000-4000-a000-000000000002';
  v_batch uuid := '31000000-0000-4000-b000-000000000001';
  v_secret uuid;
  v_request uuid;
  v_claim jsonb;
  v_token uuid;
  v_job uuid;
  v_error text;
begin
  insert into auth.users (id, email)
  values (v_user, 'v131-auto-analysis@example.invalid')
  on conflict (id) do nothing;
  insert into public.user_profile (id, role, display_name)
  values (v_user, 'ADMIN', 'V1.31 自动分析测试')
  on conflict (id) do update set role = excluded.role, display_name = excluded.display_name;

  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', v_user::text, 'role', 'authenticated')::text,
    true
  );
  set local role service_role;
  v_secret := public.admin_vault_create_secret('v131-not-a-real-key', 'v131_auto_key');
  reset role;

  insert into public.ai_model_config (
    id, display_name, base_url, model_name, api_key_secret_id, enabled, max_parallel_tasks, created_by
  ) values (
    v_model, 'V1.31 auto model', 'https://v131-model.example.invalid', 'v131-model', v_secret, true, 1, v_user
  );
  insert into public.review_batch (
    id, name, week_code, status, default_branch, ai_model_config_id, created_by
  ) values (
    v_batch, 'V1.31 自动冻结', 'V131-AUTO', 'DRAFT', 'release', v_model, v_user
  );

  -- 新 RPC 只创建待冻结单并记录自动分析意图；此刻绝不允许先有 Job。
  v_request := public.request_linky_batch_import_for_analysis(
    v_batch, '平台开发组', array['US-V131-001'], null, 'R20261016', 7
  );
  perform pg_temp.assert(
    (select analysis_context_version = 2
        and commit_window_days = 7
        and analysis_status = 'PENDING'
        and requested_by = v_user
     from public.linky_batch_import_request where id = v_request),
    'start analysis freezes V2 intent and requester on the import request'
  );
  perform pg_temp.assert(
    not exists (select 1 from public.analysis_job where batch_id = v_batch),
    'no analysis job exists before Worker completes the requirement snapshot'
  );
  perform pg_temp.assert(
    has_function_privilege(
      'authenticated',
      'public.request_linky_batch_import_for_analysis(uuid,text,text[],uuid,text,integer)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'public.complete_linky_batch_import(uuid,text,uuid)',
      'EXECUTE'
    ),
    'browser can request the orchestration but cannot complete it'
  );

  set local role service_role;
  v_claim := public.claim_next_linky_batch_import('worker-v131-auto', 900);
  perform pg_temp.assert((v_claim ->> 'id')::uuid = v_request, 'queued auto-analysis import is claimable');
  v_token := (v_claim ->> 'claim_token')::uuid;
  perform public.commit_linky_batch_story(
    v_request,
    'worker-v131-auto',
    v_token,
    jsonb_build_object(
      'story_code', 'US-V131-001',
      'title', '自动冻结后开始分析',
      'workspace_name', '平台开发组',
      'status_label', '需求编写完成',
      'requirement_detail', '验证需求快照完成后才能入队自动分析。'
    ),
    '[]'::jsonb
  );
  perform public.complete_linky_batch_import(v_request, 'worker-v131-auto', v_token);
  reset role;

  select analysis_job_id into v_job
  from public.linky_batch_import_request where id = v_request;
  perform pg_temp.assert(v_job is not null, 'completed requirement snapshot automatically creates an analysis job');
  perform pg_temp.assert(
    (select status = 'SUCCEEDED' and analysis_status = 'QUEUED'
     from public.linky_batch_import_request where id = v_request),
    'import and analysis orchestration retain separate successful states'
  );
  perform pg_temp.assert(
    (select requested_by = v_user
        and analysis_context_version = 2
        and commit_window_days = 7
        and total_stories = 1
     from public.analysis_job where id = v_job),
    'automatic job uses the original requester and frozen V2 analysis window'
  );
  perform pg_temp.assert(
    (select count(*) = 1 from public.analysis_story_task where job_id = v_job),
    'automatic job receives only the fully frozen story set'
  );
end;
$test$;

select 'ALL_V131_LINKY_IMPORT_AUTO_ANALYSIS_TESTS_PASSED' as result;

rollback;
