-- 0010_ai_automation_mvp_test.sql
-- 0001..0020 最终 schema 下的 AI 自动化基础链路回归测试。
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
  v_admin uuid := '10000000-0000-4000-a000-0000000000a1';
  v_model uuid := '10000000-0000-4000-b000-0000000000b1';
  v_batch uuid := '10000000-0000-4000-c000-0000000000c1';
  v_secret uuid;
  v_job uuid;
  v_snapshot jsonb;
  v_envelope jsonb;
  v_snapshots jsonb;
  v_task uuid;
  v_token uuid;
  v_wrong_token uuid := '10000000-0000-4000-d000-0000000000d9';
  v_count integer;
  v_text text;
  v_ok boolean;
begin
  insert into auth.users (id, email)
  values (v_admin, 'admin_10_final_test@example.com')
  on conflict (id) do nothing;

  insert into public.user_profile (id, role)
  values (v_admin, 'ADMIN')
  on conflict (id) do update set role = 'ADMIN';

  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', v_admin::text, 'role', 'authenticated')::text,
    true
  );

  set local role service_role;
  v_secret := public.admin_vault_create_secret(
    'sk-10-final-test', 'ai_key_10_final_test'
  );
  reset role;

  insert into public.ai_model_config (
    id, display_name, base_url, model_name, api_key_secret_id,
    enabled, max_parallel_tasks, created_by
  ) values (
    v_model, 'Model 10 final', 'https://model-10.example.com', 'model-10',
    v_secret, true, 2, v_admin
  );

  insert into public.review_batch (
    id, name, week_code, status, default_branch, created_by, ai_model_config_id
  ) values (
    v_batch, 'AI automation final test', 'WK-10-FINAL-001',
    'WAITING_AI_RESULT', 'feature_dev', v_admin, v_model
  );

  insert into public.review_story (
    batch_id, story_code, story_name, owners_text, source_data
  ) values
    (v_batch, 'ST-10-FINAL-001', 'First story', 'owner', '{}'::jsonb),
    (v_batch, 'ST-10-FINAL-002', 'Second story', 'owner', '{}'::jsonb);

  v_snapshot := public.build_model_snapshot(v_model);
  perform pg_temp.assert(v_snapshot is not null, 'model snapshot is built');
  perform pg_temp.assert(
    not (v_snapshot ?| array[
      'api_key_secret_id', 'provider', 'execution_engine',
      'retrieval_prompt_version', 'analysis_prompt_version'
    ]),
    'snapshot excludes secrets, provider, engine and legacy prompts'
  );
  perform pg_temp.assert(
    (v_snapshot->>'agent_max_model_requests')::integer = 120,
    'new model uses the final request budget default'
  );

  v_job := public.enqueue_analysis_job(v_batch);
  perform pg_temp.assert(v_job is not null, 'enqueue returns a job id');

  select execution_engine, to_jsonb(requested_branch), total_stories
    into v_text, v_snapshot, v_count
  from public.analysis_job
  where id = v_job;
  perform pg_temp.assert(
    v_text = 'deepseek-harness-acp',
    'new jobs are fixed to deepseek-harness-acp'
  );
  perform pg_temp.assert(
    v_snapshot = to_jsonb('feature_dev'::text),
    'job freezes the branch'
  );
  perform pg_temp.assert(v_count = 2, 'one task is created per story');

  select count(*) into v_count
  from public.analysis_story_task
  where job_id = v_job;
  perform pg_temp.assert(v_count = 2, 'enqueue created two story tasks');

  set local role service_role;
  v_envelope := public.claim_job_for_preparation('worker-10-prep', 900);
  reset role;

  perform pg_temp.assert(
    v_envelope->'job'->>'id' = v_job::text,
    'canonical preparation RPC claims the queued job'
  );
  perform pg_temp.assert(
    not (v_envelope->'job' ? 'execution_engine'),
    'canonical preparation envelope has no engine negotiation field'
  );

  v_snapshots := jsonb_build_array(
    jsonb_build_object('repository_name', 'kdmanage-backend',
      'commit_sha', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
    jsonb_build_object('repository_name', 'kdmanage-frontend',
      'commit_sha', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'),
    jsonb_build_object('repository_name', 'tmanage-backend',
      'commit_sha', 'cccccccccccccccccccccccccccccccccccccccc'),
    jsonb_build_object('repository_name', 'tmanage-frontend',
      'commit_sha', 'dddddddddddddddddddddddddddddddddddddddd')
  );

  perform pg_temp.assert_raises(
    format(
      'select public.save_repository_snapshots(%L, %L, %L::jsonb)',
      v_job, 'worker-10-wrong', v_snapshots::text
    ),
    'JOB_LEASE_LOST',
    'a non-owner cannot save repository snapshots'
  );

  set local role service_role;
  perform public.save_repository_snapshots(v_job, 'worker-10-prep', v_snapshots);
  v_envelope := public.claim_next_story_task('worker-10-agent', 900);
  reset role;

  perform pg_temp.assert(v_envelope is not null, 'canonical task claim returns a task');
  perform pg_temp.assert(
    v_envelope ? 'claim_token'
      and v_envelope ? 'job'
      and v_envelope ? 'model'
      and v_envelope ? 'snapshots'
      and v_envelope ? 'story',
    'task claim returns the canonical envelope'
  );
  perform pg_temp.assert(
    not (v_envelope ? 'claim_token_digest')
      and not (v_envelope ? 'execution_engine'),
    'claim does not leak the token digest or expose engine negotiation'
  );

  v_task := (v_envelope->>'id')::uuid;
  v_token := (v_envelope->>'claim_token')::uuid;

  select agent_status, agent_attempt,
         claim_token_digest = public.agent_claim_token_digest(v_token)
    into v_text, v_count, v_ok
  from public.analysis_story_task
  where id = v_task;
  perform pg_temp.assert(v_text = 'RUNNING', 'claimed task enters RUNNING');
  perform pg_temp.assert(v_count = 1, 'first claim creates attempt one');
  perform pg_temp.assert(v_ok, 'only the claim token digest is persisted');

  set local role service_role;
  v_ok := public.heartbeat_story_task(v_task, 'worker-10-agent', v_token, 900);
  reset role;
  perform pg_temp.assert(v_ok, 'valid claim token renews the task lease');

  set local role service_role;
  v_ok := public.heartbeat_story_task(
    v_task, 'worker-10-agent', v_wrong_token, 900
  );
  reset role;
  perform pg_temp.assert(not v_ok, 'foreign claim token cannot renew the lease');

  set local role service_role;
  select public.get_model_secret_for_story_task(
    v_task, 'worker-10-agent', v_token
  ) into v_text;
  reset role;
  perform pg_temp.assert(v_text = 'sk-10-final-test', 'valid claim reads the model key');

  perform pg_temp.assert(
    has_function_privilege(
      'service_role',
      'public.claim_next_story_task(text,integer)',
      'EXECUTE'
    )
      and not has_function_privilege(
        'authenticated',
        'public.claim_next_story_task(text,integer)',
        'EXECUTE'
      ),
    'canonical Worker RPC is service_role-only'
  );
end;
$test$;

select 'ALL_AI_AUTOMATION_MVP_TESTS_PASSED' as result;
rollback;
