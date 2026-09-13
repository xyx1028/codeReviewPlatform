-- 0031_manifest_freeze_and_worker_overview_test.sql
-- 0001..0032 最终 schema 下的 manifest / policy-hash 冻结契约与 Worker 三阶段总览测试。
-- 以库属主执行；整个脚本在单事务中运行并最终 ROLLBACK。
--
-- 为什么需要这个新文件（不要去改 0019 那个历史测试）：
--   `0031_freeze_manifest_and_canonical_policy_hash.sql` 给 `analysis_job` 加了
--   `before insert` 触发器 `freeze_v4_job_manifest_and_policy_hash`，要求任何
--   `policy_version = 4` 的 Job 在插入时必须已经带上 `capability_policy_snapshot`。
--   `0019_single_harness_execution_test.sql` 写在 0031 之前，它用裸
--   `insert into public.analysis_job (...)`（不带 policy snapshot）造 fixture，
--   因此在 0031+ 的 schema 上会以 `V4_CAPABILITY_POLICY_MISSING` 中止。
--   历史测试文件保持原样（它是当时那一版契约的记录），这里用 0031 之后仍然成立的
--   fixture 方式重新覆盖同一批最终态断言，并顺带把 0031 自己的冻结契约断言下来。
--
-- 覆盖：
--   0031：active manifest 缺失/policy snapshot 缺失时 fail closed；
--         manifest 身份与 canonical policy hash 冻结即不可变；
--         claim 创建的 run 继承 Job 冻结的 policy hash。
--   0019（最终态、与 fixture 造法无关的部分）：
--         新 Job 固定 `deepseek-harness-acp`、legacy 插入被挡、`execution_engine`
--         插入后不可变、历史 legacy Job 不能 retry 且值仍可读、
--         `admin_list_analysis_workers()` 只有 PREPARING / AGENT / FINALIZING 三阶段
--         且不再暴露引擎协商元数据。
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
  v_admin uuid := '31000000-0000-4000-a000-0000000000a1';
  v_model uuid := '31000000-0000-4000-b000-0000000000b1';
  v_secret uuid;
  v_batch_prep uuid := '31000000-0000-4000-c000-0000000000c1';
  v_batch_agent uuid := '31000000-0000-4000-c000-0000000000c2';
  v_batch_final uuid := '31000000-0000-4000-c000-0000000000c3';
  v_batch_history uuid := '31000000-0000-4000-c000-0000000000c4';
  v_story_prep uuid := '31000000-0000-4000-e000-0000000000e1';
  v_story_agent uuid := '31000000-0000-4000-e000-0000000000e2';
  v_story_final uuid := '31000000-0000-4000-e000-0000000000e3';
  v_story_history uuid := '31000000-0000-4000-e000-0000000000e4';
  v_job_history uuid := '31000000-0000-4000-d000-0000000000d4';
  v_job_prep uuid;
  v_job_agent uuid;
  v_job_final uuid;
  v_snapshot jsonb;
  v_policy jsonb;
  v_manifest public.v4_harness_manifest;
  v_engine text;
  v_hash text;
  v_overview jsonb;
  v_worker_row jsonb;
  v_task_agent uuid;
  v_envelope jsonb;
begin
  ---------------------------------------------------------------------------
  -- 0. Fixture：一个 ADMIN、一个可用模型、四个批次各一条需求
  ---------------------------------------------------------------------------
  insert into auth.users (id, email)
  values (v_admin, 'admin_31_freeze@example.com')
  on conflict (id) do nothing;
  insert into public.user_profile (id, role) values (v_admin, 'ADMIN')
  on conflict (id) do update set role = 'ADMIN';

  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', v_admin::text, 'role', 'authenticated')::text,
    true
  );

  set local role service_role;
  v_secret := public.admin_vault_create_secret('sk-31-freeze', 'ai_key_31_freeze');
  reset role;

  insert into public.ai_model_config (
    id, display_name, base_url, model_name, api_key_secret_id,
    enabled, max_parallel_tasks, created_by
  ) values (
    v_model, 'Model 31 freeze', 'https://model-31.example.com', 'model-31',
    v_secret, true, 4, v_admin
  );

  v_snapshot := public.build_model_snapshot(v_model);
  v_policy := public.build_v4_capability_policy(v_model);
  select * into v_manifest from public.v4_harness_manifest where is_active;
  perform pg_temp.assert(
    v_manifest.manifest_revision is not null,
    '0030 seeded exactly one active Harness manifest'
  );

  insert into public.review_batch (
    id, name, week_code, status, default_branch, created_by,
    ai_model_config_id, ai_model_snapshot
  ) values
    (v_batch_prep, 'Preparing overview', 'WK-31-FRZ-001',
      'WAITING_AI_RESULT', 'feature_dev', v_admin, v_model, v_snapshot),
    (v_batch_agent, 'Agent overview', 'WK-31-FRZ-002',
      'WAITING_AI_RESULT', 'feature_dev', v_admin, v_model, v_snapshot),
    (v_batch_final, 'Finalizing overview', 'WK-31-FRZ-003',
      'WAITING_AI_RESULT', 'feature_dev', v_admin, v_model, v_snapshot),
    (v_batch_history, 'Historical legacy job', 'WK-31-FRZ-004',
      'WAITING_AI_RESULT', 'feature_dev', v_admin, v_model, v_snapshot);

  insert into public.review_story (
    id, batch_id, story_code, story_name, owners_text, source_data
  ) values
    (v_story_prep, v_batch_prep, 'ST-31-FRZ-001', 'Prep story', 'owner', '{}'::jsonb),
    (v_story_agent, v_batch_agent, 'ST-31-FRZ-002', 'Agent story', 'owner', '{}'::jsonb),
    (v_story_final, v_batch_final, 'ST-31-FRZ-003', 'Final story', 'owner', '{}'::jsonb),
    (v_story_history, v_batch_history, 'ST-31-FRZ-004', 'History story', 'owner', '{}'::jsonb);

  ---------------------------------------------------------------------------
  -- 1. 0031 冻结契约：policy snapshot 缺失即 fail closed
  ---------------------------------------------------------------------------
  perform pg_temp.assert_raises(
    format(
      'insert into public.analysis_job '
      || '(batch_id,model_config_id,model_snapshot,requested_branch,status,requested_by,total_stories) '
      || 'values (%L,%L,%L::jsonb,%L,%L,%L,0)',
      v_batch_prep, v_model, v_snapshot::text, 'feature_dev', 'FAILED', v_admin
    ),
    'V4_CAPABILITY_POLICY_MISSING',
    'a policy_version = 4 job cannot be inserted without a frozen capability policy'
  );

  ---------------------------------------------------------------------------
  -- 2. enqueue 冻结 manifest 身份与 canonical policy hash，且冻结后不可变
  ---------------------------------------------------------------------------
  v_job_prep := public.enqueue_analysis_job(v_batch_prep);

  select execution_engine, policy_hash into v_engine, v_hash
  from public.analysis_job where id = v_job_prep;
  perform pg_temp.assert(
    v_engine = 'deepseek-harness-acp', 'new jobs are fixed to deepseek-harness-acp'
  );
  perform pg_temp.assert(
    v_hash = public.v4_policy_hash(v_policy),
    'the frozen policy hash uses the canonical JSON algorithm, not jsonb::text'
  );
  perform pg_temp.assert(
    (select harness_version from public.analysis_job where id = v_job_prep)
      = v_manifest.harness_version
    and (select capability_contract_hash from public.analysis_job where id = v_job_prep)
      = v_manifest.manifest_hash,
    'enqueue freezes the active manifest identity onto the job'
  );

  perform pg_temp.assert_raises(
    format(
      'update public.analysis_job set capability_contract_hash = %L where id = %L',
      'drifted-hash', v_job_prep
    ),
    'immutable',
    'the frozen contract hash cannot be rewritten'
  );
  perform pg_temp.assert_raises(
    format('update public.analysis_job set policy_hash = %L where id = %L', 'x', v_job_prep),
    'immutable',
    'the canonical policy hash cannot be rewritten'
  );
  perform pg_temp.assert_raises(
    format(
      'update public.analysis_job set execution_engine = %L where id = %L',
      'legacy-openai', v_job_prep
    ),
    'immutable',
    'the historical execution engine is immutable after insert'
  );

  ---------------------------------------------------------------------------
  -- 3. legacy 引擎：新插入被挡，历史行仍可读但不能 retry
  ---------------------------------------------------------------------------
  perform pg_temp.assert_raises(
    format(
      'insert into public.analysis_job '
      || '(id,batch_id,model_config_id,model_snapshot,requested_branch,status,requested_by,'
      || 'total_stories,execution_engine,capability_policy_snapshot) '
      || 'values (%L,%L,%L,%L::jsonb,%L,%L,%L,0,%L,%L::jsonb)',
      v_job_history, v_batch_history, v_model, v_snapshot::text,
      'feature_dev', 'FAILED', v_admin, 'legacy-openai', v_policy::text
    ),
    'LEGACY_ENGINE_RETIRED',
    'a new legacy-openai job insert is rejected'
  );

  -- 模拟 0019 之前留下的历史失败行：policy_version = 3 的行不经过 V4 冻结触发器。
  alter table public.analysis_job
    disable trigger enforce_new_analysis_job_harness_only;
  insert into public.analysis_job (
    id, batch_id, model_config_id, model_snapshot, requested_branch,
    status, requested_by, total_stories, execution_engine, policy_version
  ) values (
    v_job_history, v_batch_history, v_model, v_snapshot, 'feature_dev',
    'FAILED', v_admin, 0, 'legacy-openai', 3
  );
  alter table public.analysis_job
    enable trigger enforce_new_analysis_job_harness_only;

  perform pg_temp.assert_raises(
    format('select public.retry_analysis_job(%L)', v_job_history),
    'LEGACY_ENGINE_RETIRED',
    'a historical legacy job cannot be retried'
  );
  select execution_engine into v_engine
  from public.analysis_job where id = v_job_history;
  perform pg_temp.assert(
    v_engine = 'legacy-openai',
    'the historical engine value stays readable after the rejected retry'
  );

  ---------------------------------------------------------------------------
  -- 4. claim 创建的 run 继承 Job 冻结的 policy hash（0031 的 run 侧触发器）
  ---------------------------------------------------------------------------
  v_job_agent := public.enqueue_analysis_job(v_batch_agent);
  update public.analysis_job set status = 'PROCESSING' where id = v_job_agent;

  set local role service_role;
  v_envelope := public.claim_next_story_task('worker-31-agent', 900);
  reset role;
  perform pg_temp.assert(v_envelope is not null, 'the V4 story task is claimable');
  v_task_agent := (v_envelope->>'id')::uuid;
  perform pg_temp.assert(
    (select policy_hash from public.analysis_agent_run
     where id = (v_envelope->>'agent_run_id')::uuid)
      = (select policy_hash from public.analysis_job where id = v_job_agent),
    'the run inherits the job-frozen canonical policy hash'
  );

  ---------------------------------------------------------------------------
  -- 5. Worker 总览：只有 PREPARING / AGENT / FINALIZING 三阶段
  ---------------------------------------------------------------------------
  update public.analysis_job
  set status = 'PREPARING_CODE', worker_id = 'worker-31-prep', locked_at = now()
  where id = v_job_prep;

  v_job_final := public.enqueue_analysis_job(v_batch_final);
  update public.analysis_job
  set status = 'FINALIZING',
      finalizer_worker_id = 'worker-31-final',
      finalize_lease_expires_at = now() + interval '10 minutes'
  where id = v_job_final;

  set local role service_role;
  perform public.heartbeat_analysis_worker(
    'worker-31-prep', 2, 1, '{"runtime":"test"}'::jsonb
  );
  perform public.heartbeat_analysis_worker(
    'worker-31-agent', 2, 1, '{"runtime":"test"}'::jsonb
  );
  perform public.heartbeat_analysis_worker(
    'worker-31-final', 2, 1, '{"runtime":"test"}'::jsonb
  );
  reset role;

  set local role authenticated;
  v_overview := public.admin_list_analysis_workers();
  reset role;

  select item into v_worker_row
  from jsonb_array_elements(v_overview->'workers') item
  where item->>'worker_id' = 'worker-31-prep';
  perform pg_temp.assert(
    exists (
      select 1 from jsonb_array_elements(v_worker_row->'assignments') assignment
      where assignment->>'phase' = 'PREPARING'
    ),
    'overview reports the PREPARING assignment'
  );

  select item into v_worker_row
  from jsonb_array_elements(v_overview->'workers') item
  where item->>'worker_id' = 'worker-31-agent';
  perform pg_temp.assert(
    exists (
      select 1 from jsonb_array_elements(v_worker_row->'assignments') assignment
      where assignment->>'phase' = 'AGENT'
    ),
    'overview reports the AGENT assignment'
  );

  select item into v_worker_row
  from jsonb_array_elements(v_overview->'workers') item
  where item->>'worker_id' = 'worker-31-final';
  perform pg_temp.assert(
    exists (
      select 1 from jsonb_array_elements(v_worker_row->'assignments') assignment
      where assignment->>'phase' = 'FINALIZING'
    ),
    'overview reports the FINALIZING assignment'
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

select 'ALL_MANIFEST_FREEZE_AND_OVERVIEW_TESTS_PASSED' as result;
rollback;
