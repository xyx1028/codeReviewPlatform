-- 0017_agent_execution_engine_test.sql
-- 0001..0020 最终 schema 下的 claim-token fencing 与 Agent 状态机测试。
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
  v_admin uuid := '17000000-0000-4000-a000-0000000000a1';
  v_model uuid := '17000000-0000-4000-b000-0000000000b1';
  v_batch uuid := '17000000-0000-4000-c000-0000000000c1';
  v_job uuid := '17000000-0000-4000-d000-0000000000d1';
  v_story_1 uuid := '17000000-0000-4000-e000-0000000000e1';
  v_story_2 uuid := '17000000-0000-4000-e000-0000000000e2';
  v_task_1 uuid := '17000000-0000-4000-f000-0000000000f1';
  v_task_2 uuid := '17000000-0000-4000-f000-0000000000f2';
  v_secret uuid := '17000000-0000-4000-b000-0000000000ff';
  v_foreign_token uuid := '17000000-0000-4000-a000-0000000000ff';
  v_worker text := 'worker-17-agent';
  v_snapshot jsonb;
  v_envelope jsonb;
  v_commit jsonb;
  v_results jsonb;
  v_completed jsonb;
  v_token_1 uuid;
  v_token_2 uuid;
  v_token_3 uuid;
  v_attempt integer;
  v_count integer;
  v_text text;
  v_ok boolean;
  v_import uuid;
begin
  insert into auth.users (id, email)
  values (v_admin, 'admin_17_final_test@example.com')
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
    v_model, 'Model 17 final', 'https://model-17.example.com', 'model-17',
    v_secret, true, 4, v_admin
  );
  v_snapshot := public.build_model_snapshot(v_model);

  insert into public.review_batch (
    id, name, week_code, status, default_branch, created_by,
    ai_model_config_id, ai_model_snapshot
  ) values (
    v_batch, 'Agent state machine test', 'WK-17-FINAL-001',
    'WAITING_AI_RESULT', 'feature_dev', v_admin, v_model, v_snapshot
  );

  insert into public.review_story (
    id, batch_id, story_code, story_name, owners_text, source_data
  ) values
    (v_story_1, v_batch, 'ST-17-FINAL-001', 'First agent story', 'owner', '{}'::jsonb),
    (v_story_2, v_batch, 'ST-17-FINAL-002', 'Second agent story', 'owner', '{}'::jsonb);

  insert into public.analysis_job (
    id, batch_id, model_config_id, model_snapshot, requested_branch,
    status, requested_by, total_stories, created_at
  ) values (
    v_job, v_batch, v_model, v_snapshot, 'feature_dev',
    'PROCESSING', v_admin, 2, '2000-01-01 00:00:00+00'
  );

  insert into public.analysis_story_task (
    id, job_id, story_id, created_at
  ) values
    (v_task_1, v_job, v_story_1, '2000-01-01 00:00:01+00'),
    (v_task_2, v_job, v_story_2, '2000-01-01 00:00:02+00');

  insert into public.analysis_repository_snapshot (
    job_id, repository_name, requested_branch, commit_sha
  ) values
    (v_job, 'kdmanage-backend', 'feature_dev', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
    (v_job, 'kdmanage-frontend', 'feature_dev', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'),
    (v_job, 'tmanage-backend', 'feature_dev', 'cccccccccccccccccccccccccccccccccccccccc'),
    (v_job, 'tmanage-frontend', 'feature_dev', 'dddddddddddddddddddddddddddddddddddddddd');

  -- First claim, lease expiry, then same-worker reclaim: the old token must lose.
  set local role service_role;
  v_envelope := public.claim_next_story_task(v_worker, 900);
  reset role;
  perform pg_temp.assert(
    (v_envelope->>'id')::uuid = v_task_1,
    'the first task is claimed deterministically'
  );
  v_token_1 := (v_envelope->>'claim_token')::uuid;
  perform pg_temp.assert(
    (v_envelope->>'agent_attempt')::integer = 1,
    'first claim opens attempt one'
  );

  update public.analysis_story_task
  set lease_expires_at = now() - interval '1 second'
  where id = v_task_1;

  set local role service_role;
  v_envelope := public.claim_next_story_task(v_worker, 900);
  reset role;
  perform pg_temp.assert(
    (v_envelope->>'id')::uuid = v_task_1,
    'expired task is reclaimed before later pending work'
  );
  v_token_2 := (v_envelope->>'claim_token')::uuid;
  v_attempt := (v_envelope->>'agent_attempt')::integer;
  perform pg_temp.assert(v_attempt = 2, 'reclaim increments the agent attempt');
  perform pg_temp.assert(v_token_2 <> v_token_1, 'reclaim mints a fresh token');

  set local role service_role;
  v_ok := public.heartbeat_story_task(v_task_1, v_worker, v_token_1, 900);
  reset role;
  perform pg_temp.assert(not v_ok, 'stale token cannot heartbeat after reclaim');

  perform pg_temp.assert_raises(
    format(
      'select public.save_agent_review_result(%L,%L,%L,1,%L::jsonb,%L::jsonb)',
      v_task_1, v_worker, v_token_1,
      '{"verdict":"IMPLEMENTED"}', '[]'
    ),
    'AGENT_CLAIM_INVALID',
    'stale token and attempt cannot commit after reclaim'
  );

  set local role service_role;
  v_commit := public.save_agent_review_result(
    v_task_1,
    v_worker,
    v_token_2,
    2,
    jsonb_build_object(
      'verdict', 'IMPLEMENTED', 'confidence', 95, 'summary', 'done'
    ),
    '[]'::jsonb,
    jsonb_build_object('tool_calls', 3, 'searches_run', 1),
    'config-hash-17',
    'agent-review-v1',
    'Model 17 final / model-17'
  );
  reset role;
  perform pg_temp.assert(v_commit ? 'run_id', 'commit returns an Agent run id');

  select agent_status,
         worker_id is null and lease_expires_at is null and claim_token_digest is null
    into v_text, v_ok
  from public.analysis_story_task
  where id = v_task_1;
  perform pg_temp.assert(v_text = 'SUCCEEDED', 'commit succeeds the task');
  perform pg_temp.assert(v_ok, 'commit releases lease and burns token');

  select count(*) into v_count
  from public.analysis_agent_run
  where task_id = v_task_1 and agent_attempt = 2 and status = 'COMMITTED';
  perform pg_temp.assert(v_count = 1, 'exactly the current attempt is committed');

  -- A valid failure fails the job; a foreign token cannot do so.
  set local role service_role;
  v_envelope := public.claim_next_story_task(v_worker, 900);
  reset role;
  perform pg_temp.assert(
    (v_envelope->>'id')::uuid = v_task_2,
    'second task is claimed after first commit'
  );
  v_token_2 := (v_envelope->>'claim_token')::uuid;

  perform pg_temp.assert_raises(
    format(
      'select public.fail_agent_review(%L,%L,%L,%L,%L)',
      v_task_2, v_worker, v_foreign_token, 'FOREIGN', 'must fail'
    ),
    'TASK_LEASE_LOST',
    'foreign token cannot fail an Agent task'
  );

  set local role service_role;
  perform public.fail_agent_review(
    v_task_2, v_worker, v_token_2, 'AGENT_TEST_FAILURE', 'forced failure'
  );
  reset role;

  select status into v_text from public.analysis_job where id = v_job;
  perform pg_temp.assert(v_text = 'FAILED', 'Agent failure fails the job');
  select agent_status into v_text from public.analysis_story_task where id = v_task_2;
  perform pg_temp.assert(v_text = 'FAILED', 'failing task is marked FAILED');
  select agent_status into v_text from public.analysis_story_task where id = v_task_1;
  perform pg_temp.assert(v_text = 'SUCCEEDED', 'committed sibling stays SUCCEEDED');

  -- Retry keeps committed work, resets unfinished work, and closes stale runs.
  perform public.retry_analysis_job(v_job);
  select status into v_text from public.analysis_job where id = v_job;
  perform pg_temp.assert(v_text = 'PROCESSING', 'retry reuses four snapshots');
  select agent_status into v_text from public.analysis_story_task where id = v_task_1;
  perform pg_temp.assert(v_text = 'SUCCEEDED', 'retry preserves committed task');
  select agent_status into v_text from public.analysis_story_task where id = v_task_2;
  perform pg_temp.assert(v_text = 'PENDING', 'retry resets failed task to PENDING');
  select count(*) into v_count
  from public.analysis_agent_run
  where job_id = v_job and status = 'RUNNING';
  perform pg_temp.assert(v_count = 0, 'retry closes every dangling Agent run');

  set local role service_role;
  v_envelope := public.claim_next_story_task(v_worker, 900);
  reset role;
  v_token_3 := (v_envelope->>'claim_token')::uuid;
  perform pg_temp.assert(
    (v_envelope->>'id')::uuid = v_task_2
      and (v_envelope->>'agent_attempt')::integer = 2,
    'retried task starts a new fenced attempt'
  );
  perform pg_temp.assert(v_token_3 <> v_token_2, 'retry claim uses a new token');

  set local role service_role;
  perform public.save_agent_review_result(
    v_task_2,
    v_worker,
    v_token_3,
    2,
    jsonb_build_object(
      'verdict', 'PARTIAL', 'confidence', 70, 'summary', 'partial'
    ),
    '[]'::jsonb
  );
  reset role;

  -- Finalize through the canonical API and persist one formal result per story.
  set local role service_role;
  v_envelope := public.claim_job_for_finalization('worker-17-finalizer', 900);
  reset role;
  perform pg_temp.assert(
    v_envelope->'job'->>'id' = v_job::text,
    'all committed tasks make the job finalizable'
  );

  set local role service_role;
  v_completed := public.list_completed_story_tasks(v_job);
  reset role;
  perform pg_temp.assert(
    jsonb_array_length(v_completed) = 2,
    'canonical completed-task list returns both Agent outputs'
  );
  perform pg_temp.assert(
    not exists (
      select 1
      from jsonb_array_elements(v_completed) item
      where item->>'agent_status' <> 'SUCCEEDED' or item->'output' is null
    ),
    'finalizer sees only committed Agent outputs'
  );

  v_results := jsonb_build_array(
    jsonb_build_object(
      'story_code', 'ST-17-FINAL-001', 'verdict', 'IMPLEMENTED',
      'confidence', 95, 'summary', 'done'
    ),
    jsonb_build_object(
      'story_code', 'ST-17-FINAL-002', 'verdict', 'PARTIAL',
      'confidence', 70, 'summary', 'partial'
    )
  );

  set local role service_role;
  v_import := public.complete_analysis_job(
    v_job,
    'worker-17-finalizer',
    v_results,
    jsonb_build_array(jsonb_build_object(
      'story_code', 'ST-17-FINAL-001',
      'repository_name', 'kdmanage-backend',
      'file_path', 'src/service.ts',
      'start_line', 10,
      'end_line', 20,
      'evidence_type', '现有实现',
      'description', 'verified implementation'
    ))
  );
  reset role;

  perform pg_temp.assert(v_import is not null, 'finalize returns an import id');
  select status into v_text from public.analysis_job where id = v_job;
  perform pg_temp.assert(v_text = 'SUCCEEDED', 'finalize succeeds the job');
  select count(*) into v_count
  from public.ai_review_result
  where ai_import_record_id = v_import;
  perform pg_temp.assert(v_count = 2, 'finalize writes two formal review results');
  select commit_sha into v_text
  from public.ai_code_evidence evidence
  join public.ai_review_result result on result.id = evidence.ai_review_result_id
  where result.ai_import_record_id = v_import
  limit 1;
  perform pg_temp.assert(
    v_text = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'formal evidence commit is sourced from the frozen snapshot'
  );
end;
$test$;

select 'ALL_AGENT_EXECUTION_ENGINE_TESTS_PASSED' as result;
rollback;
