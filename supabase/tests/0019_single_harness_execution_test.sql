-- 0019_single_harness_execution_test.sql
-- 0001..0020 最终 schema 下的单 Harness API、历史来源与 Worker 概览测试。
-- 以库属主执行；整个脚本在单事务中运行并最终 ROLLBACK。
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

create or replace function pg_temp.assert_raises(p_sql text, p_contains text, p_msg text)
returns void language plpgsql as $$
declare
  v_error text;
begin
  begin
    execute p_sql;
  exception when others then
    v_error := sqlerrm;
    if p_contains is not null and position(p_contains in v_error) = 0 then
      raise exception 'ASSERT FAILED: % -- expected error containing "%", got "%"',
        p_msg, p_contains, v_error;
    end if;
    return;
  end;
  raise exception 'ASSERT FAILED: % -- expected an exception', p_msg;
end;
$$;

do $test$
declare
  v_admin uuid := '19000000-0000-4000-a000-0000000000a1';
  v_model uuid := '19000000-0000-4000-b000-0000000000b1';
  v_secret uuid := '19000000-0000-4000-b000-0000000000ff';
  v_batch_default uuid := '19000000-0000-4000-c000-0000000000c1';
  v_batch_history uuid := '19000000-0000-4000-c000-0000000000c2';
  v_batch_prep uuid := '19000000-0000-4000-c000-0000000000c3';
  v_batch_agent uuid := '19000000-0000-4000-c000-0000000000c4';
  v_batch_final uuid := '19000000-0000-4000-c000-0000000000c5';
  v_job_default uuid := '19000000-0000-4000-d000-0000000000d1';
  v_job_history uuid := '19000000-0000-4000-d000-0000000000d2';
  v_job_prep uuid := '19000000-0000-4000-d000-0000000000d3';
  v_job_agent uuid := '19000000-0000-4000-d000-0000000000d4';
  v_job_final uuid := '19000000-0000-4000-d000-0000000000d5';
  v_story_agent uuid := '19000000-0000-4000-e000-0000000000e1';
  v_task_agent uuid := '19000000-0000-4000-f000-0000000000f1';
  v_snapshot jsonb;
  v_overview jsonb;
  v_worker_row jsonb;
  v_signature text;
  v_engine text;
  v_count integer;
  v_canonical text[] := array[
    'public.heartbeat_analysis_worker(text,integer,integer,jsonb)',
    'public.claim_job_for_preparation(text,integer)',
    'public.save_repository_snapshots(uuid,text,jsonb)',
    'public.claim_next_story_task(text,integer)',
    'public.heartbeat_story_task(uuid,text,uuid,integer)',
    'public.get_model_secret_for_story_task(uuid,text,uuid)',
    'public.save_agent_review_result(uuid,text,uuid,integer,jsonb,jsonb,jsonb,text,text,text)',
    'public.fail_agent_review(uuid,text,uuid,text,text)',
    'public.claim_job_for_finalization(text,integer)',
    'public.list_completed_story_tasks(uuid)',
    'public.complete_analysis_job(uuid,text,jsonb,jsonb)',
    'public.fail_claimed_analysis_job(uuid,text,text,text)'
  ];
  v_retired text[] := array[
    'public.heartbeat_analysis_worker(text,integer,integer)',
    'public.heartbeat_story_task(uuid,text,integer)',
    'public.get_model_secret_for_job(uuid,text)',
    'public.save_retrieval_result(uuid,text,jsonb,text,text)',
    'public.save_analysis_result(uuid,text,jsonb,text,text)',
    'public.fail_story_task(uuid,text,text,text,text)',
    'public.list_analysis_story_tasks_for_worker(uuid)',
    'public.heartbeat_analysis_worker_v2(text,integer,integer,text[],integer,jsonb)',
    'public.claim_job_for_preparation_v2(text,text[],integer,integer)',
    'public.save_repository_snapshots_v2(uuid,text,jsonb)',
    'public.claim_next_story_task_v2(text,text[],integer,integer)',
    'public.heartbeat_story_task_v2(uuid,text,uuid,integer)',
    'public.get_model_secret_for_story_task_v2(uuid,text,uuid)',
    'public.claim_job_for_finalization_v2(text,text[],integer,integer)',
    'public.list_completed_story_tasks_v2(uuid)',
    'public.complete_analysis_job_v2(uuid,text,jsonb,jsonb)',
    'public.fail_claimed_analysis_job_v2(uuid,text,text,text)',
    'public.worker_effective_engines(text,text[],integer)'
  ];
begin
  -- There is one canonical, unversioned Worker surface and it is service_role-only.
  foreach v_signature in array v_canonical loop
    perform pg_temp.assert(
      to_regprocedure(v_signature) is not null,
      format('canonical Worker RPC exists: %s', v_signature)
    );
    perform pg_temp.assert(
      has_function_privilege('service_role', v_signature, 'EXECUTE'),
      format('service_role can execute: %s', v_signature)
    );
    perform pg_temp.assert(
      not has_function_privilege('authenticated', v_signature, 'EXECUTE')
        and not has_function_privilege('anon', v_signature, 'EXECUTE'),
      format('browser roles cannot execute: %s', v_signature)
    );
  end loop;

  foreach v_signature in array v_retired loop
    perform pg_temp.assert(
      to_regprocedure(v_signature) is null,
      format('retired Worker RPC is absent: %s', v_signature)
    );
  end loop;

  select count(*) into v_count
  from pg_proc proc
  join pg_namespace namespace on namespace.oid = proc.pronamespace
  where namespace.nspname = 'public'
    and (proc.proname ~ '_v2$'
      or proc.proname = 'worker_effective_engines'
      or proc.proname = 'admin_set_model_execution_engine');
  perform pg_temp.assert(
    v_count = 0,
    'no _v2, capability-intersection or engine-switch overload remains'
  );

  -- Historical provenance/two-stage columns remain readable, but new APIs ignore them.
  select count(*) into v_count
  from information_schema.columns
  where table_schema = 'public'
    and (table_name, column_name) in (
      ('analysis_job', 'execution_engine'),
      ('analysis_job', 'retrieved_stories'),
      ('analysis_story_task', 'retrieval_status'),
      ('analysis_story_task', 'analysis_status'),
      ('analysis_story_task', 'retrieval_model'),
      ('analysis_story_task', 'analysis_model'),
      ('analysis_story_task', 'retrieval_prompt_version'),
      ('analysis_story_task', 'analysis_prompt_version'),
      ('analysis_story_task', 'retrieval_output'),
      ('analysis_story_task', 'analysis_output'),
      ('analysis_story_task', 'retrieval_attempt'),
      ('analysis_story_task', 'analysis_attempt')
    );
  perform pg_temp.assert(v_count = 12, 'historical provenance fields are retained');
  perform pg_temp.assert(
    not exists (
      select 1 from information_schema.columns
      where table_schema = 'public'
        and table_name = 'analysis_agent_run'
        and column_name = 'execution_engine'
    ),
    'Agent runs no longer duplicate the fixed engine'
  );

  insert into auth.users (id, email)
  values (v_admin, 'admin_19_final_test@example.com')
  on conflict (id) do nothing;
  insert into public.user_profile (id, role)
  values (v_admin, 'ADMIN')
  on conflict (id) do update set role = 'ADMIN';

  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', v_admin::text, 'role', 'authenticated')::text,
    true
  );

  insert into public.ai_model_config (
    id, display_name, base_url, model_name, api_key_secret_id,
    enabled, max_parallel_tasks, created_by
  ) values (
    v_model, 'Model 19 final', 'https://model-19.example.com', 'model-19',
    v_secret, true, 4, v_admin
  );
  v_snapshot := public.build_model_snapshot(v_model);

  insert into public.review_batch (
    id, name, week_code, status, default_branch, created_by,
    ai_model_config_id, ai_model_snapshot
  ) values
    (v_batch_default, 'Default source test', 'WK-19-FINAL-001',
      'WAITING_AI_RESULT', 'feature_dev', v_admin, v_model, v_snapshot),
    (v_batch_history, 'Historical source test', 'WK-19-FINAL-002',
      'WAITING_AI_RESULT', 'feature_dev', v_admin, v_model, v_snapshot),
    (v_batch_prep, 'Preparing overview test', 'WK-19-FINAL-003',
      'WAITING_AI_RESULT', 'feature_dev', v_admin, v_model, v_snapshot),
    (v_batch_agent, 'Agent overview test', 'WK-19-FINAL-004',
      'WAITING_AI_RESULT', 'feature_dev', v_admin, v_model, v_snapshot),
    (v_batch_final, 'Finalizing overview test', 'WK-19-FINAL-005',
      'WAITING_AI_RESULT', 'feature_dev', v_admin, v_model, v_snapshot);

  -- Omitted source gets ACP; explicitly inserting legacy is fenced.
  insert into public.analysis_job (
    id, batch_id, model_config_id, model_snapshot, requested_branch,
    status, requested_by, total_stories
  ) values (
    v_job_default, v_batch_default, v_model, v_snapshot, 'feature_dev',
    'FAILED', v_admin, 0
  );
  select execution_engine into v_engine
  from public.analysis_job where id = v_job_default;
  perform pg_temp.assert(
    v_engine = 'deepseek-harness-acp',
    'new jobs default to deepseek-harness-acp'
  );

  perform pg_temp.assert_raises(
    format(
      'insert into public.analysis_job '
      || '(id,batch_id,model_config_id,model_snapshot,requested_branch,status,requested_by,total_stories,execution_engine) '
      || 'values (%L,%L,%L,%L::jsonb,%L,%L,%L,0,%L)',
      v_job_history, v_batch_history, v_model, v_snapshot::text,
      'feature_dev', 'FAILED', v_admin, 'legacy-openai'
    ),
    'LEGACY_ENGINE_RETIRED',
    'new legacy job insert is rejected'
  );

  perform pg_temp.assert_raises(
    format(
      'update public.analysis_job set execution_engine = %L where id = %L',
      'legacy-openai', v_job_default
    ),
    'immutable',
    'historical source is immutable after insert'
  );

  -- Simulate a pre-0019 historical failed row to prove retry is fenced, not deleted.
  alter table public.analysis_job
    disable trigger enforce_new_analysis_job_harness_only;
  insert into public.analysis_job (
    id, batch_id, model_config_id, model_snapshot, requested_branch,
    status, requested_by, total_stories, execution_engine
  ) values (
    v_job_history, v_batch_history, v_model, v_snapshot, 'feature_dev',
    'FAILED', v_admin, 0, 'legacy-openai'
  );
  alter table public.analysis_job
    enable trigger enforce_new_analysis_job_harness_only;

  perform pg_temp.assert_raises(
    format('select public.retry_analysis_job(%L)', v_job_history),
    'LEGACY_ENGINE_RETIRED',
    'historical legacy job cannot be retried'
  );
  select execution_engine into v_engine
  from public.analysis_job where id = v_job_history;
  perform pg_temp.assert(
    v_engine = 'legacy-openai',
    'historical source value remains readable after rejected retry'
  );

  -- Build one live assignment for each and only each final overview phase.
  insert into public.analysis_job (
    id, batch_id, model_config_id, model_snapshot, requested_branch,
    status, requested_by, total_stories, worker_id, locked_at
  ) values (
    v_job_prep, v_batch_prep, v_model, v_snapshot, 'feature_dev',
    'PREPARING_CODE', v_admin, 0, 'worker-19-prep', now()
  );

  insert into public.review_story (
    id, batch_id, story_code, story_name, owners_text, source_data
  ) values (
    v_story_agent, v_batch_agent, 'ST-19-FINAL-001',
    'Agent assignment', 'owner', '{}'::jsonb
  );
  insert into public.analysis_job (
    id, batch_id, model_config_id, model_snapshot, requested_branch,
    status, requested_by, total_stories
  ) values (
    v_job_agent, v_batch_agent, v_model, v_snapshot, 'feature_dev',
    'PROCESSING', v_admin, 1
  );
  insert into public.analysis_story_task (
    id, job_id, story_id, agent_status, agent_attempt,
    worker_id, lease_expires_at, heartbeat_at, claim_token_digest
  ) values (
    v_task_agent, v_job_agent, v_story_agent, 'RUNNING', 1,
    'worker-19-agent', now() + interval '10 minutes', now(), repeat('a', 64)
  );

  insert into public.analysis_job (
    id, batch_id, model_config_id, model_snapshot, requested_branch,
    status, requested_by, total_stories,
    finalizer_worker_id, finalize_lease_expires_at
  ) values (
    v_job_final, v_batch_final, v_model, v_snapshot, 'feature_dev',
    'FINALIZING', v_admin, 0,
    'worker-19-final', now() + interval '10 minutes'
  );

  set local role service_role;
  perform public.heartbeat_analysis_worker(
    'worker-19-prep', 2, 1, '{"runtime":"test"}'::jsonb
  );
  perform public.heartbeat_analysis_worker(
    'worker-19-agent', 2, 1, '{"runtime":"test"}'::jsonb
  );
  perform public.heartbeat_analysis_worker(
    'worker-19-final', 2, 1, '{"runtime":"test"}'::jsonb
  );
  reset role;

  set local role authenticated;
  v_overview := public.admin_list_analysis_workers();
  reset role;

  select item into v_worker_row
  from jsonb_array_elements(v_overview->'workers') item
  where item->>'worker_id' = 'worker-19-prep';
  perform pg_temp.assert(
    exists (
      select 1 from jsonb_array_elements(v_worker_row->'assignments') assignment
      where assignment->>'phase' = 'PREPARING'
    ),
    'overview reports PREPARING assignment'
  );

  select item into v_worker_row
  from jsonb_array_elements(v_overview->'workers') item
  where item->>'worker_id' = 'worker-19-agent';
  perform pg_temp.assert(
    exists (
      select 1 from jsonb_array_elements(v_worker_row->'assignments') assignment
      where assignment->>'phase' = 'AGENT'
    ),
    'overview reports AGENT assignment'
  );

  select item into v_worker_row
  from jsonb_array_elements(v_overview->'workers') item
  where item->>'worker_id' = 'worker-19-final';
  perform pg_temp.assert(
    exists (
      select 1 from jsonb_array_elements(v_worker_row->'assignments') assignment
      where assignment->>'phase' = 'FINALIZING'
    ),
    'overview reports FINALIZING assignment'
  );

  perform pg_temp.assert(
    not exists (
      select 1
      from jsonb_array_elements(v_overview->'workers') worker
      cross join lateral jsonb_array_elements(worker->'assignments') assignment
      where assignment->>'phase' not in ('PREPARING', 'AGENT', 'FINALIZING')
    ),
    'overview exposes no retired two-stage phase'
  );
  perform pg_temp.assert(
    not exists (
      select 1
      from jsonb_array_elements(v_overview->'workers') worker
      where worker ?| array[
        'supported_engines', 'protocol_version', 'execution_engine', 'capabilities'
      ]
    ),
    'overview no longer exposes engine negotiation metadata'
  );
  perform pg_temp.assert(
    not exists (
      select 1
      from jsonb_array_elements(v_overview->'workers') worker
      cross join lateral jsonb_array_elements(worker->'assignments') assignment
      where assignment ? 'execution_engine'
    ),
    'overview assignments do not repeat the fixed engine'
  );
end;
$test$;

select 'ALL_SINGLE_HARNESS_EXECUTION_TESTS_PASSED' as result;
rollback;
