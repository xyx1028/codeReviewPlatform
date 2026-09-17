--
-- compute_analysis_run_rollup：零行 SELECT INTO 不得把 NOT NULL 列写成 NULL。
--
-- 守的是一个会**永久**卡住的失败：一个 attempt 如果从没上报过
-- ATTEMPT_INSTRUMENTATION_REPORTED（RUNTIME_EVENTS_ENABLED 之前的历史 run，或在上报前
-- 就被租约回收打断的 run），那次 SELECT INTO 选不到行，PL/pgSQL 会把 v_events_reported /
-- v_events_dropped 置成 NULL；于是 `= 0` 判定变成 NULL、兜底分支被跳过、NULL 撞上
-- events_reported 的 NOT NULL 约束抛异常。而 backfill_analysis_run_rollups 把异常吞进
-- `failed` 计数，运维看到的只是 `computed:0 failed:28` 一轮一轮重复。
--
-- 覆盖：
--   1. 零事件的终态 run 能算出 rollup，且 events_reported / events_dropped = 0。
--   2. 有 ATTEMPT_INSTRUMENTATION_REPORTED 时，仍以 payload 上报值为准（没被兜底覆盖）。
--   3. 有事件但没有 instrumentation 上报时，退回"数原始事件"。
--   4. backfill_analysis_run_rollups 对零事件 run 记进 computed，而不是 failed。
--   5. 非终态 run 仍然被 ROLLUP_RUN_NOT_TERMINAL 拒绝（本次修复不放宽这条闸门）。
--
-- 整个测试在一个 rollback 事务内完成，不污染库。

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

-- ---------------------------------------------------------------------------
-- 夹具：batch -> story -> job -> task -> 三个 agent_run
--
-- requested_by 必须是真实 auth.users 行（有外键），所以取库里第一个用户而不是硬编码。
-- capability_policy_snapshot 取当前 active manifest 的 default_policy，否则
-- freeze_v4_job_manifest_and_policy_hash 触发器会以 V4_CAPABILITY_POLICY_MISSING 拒绝插入。
-- ---------------------------------------------------------------------------
create or replace function pg_temp.fixture()
returns void language plpgsql as $$
declare
  v_user uuid;
  v_model uuid;
  v_policy jsonb;
begin
  select id into v_user from auth.users order by created_at limit 1;
  if v_user is null then
    raise exception 'FIXTURE: no auth.users row to own the job';
  end if;
  select id into v_model from public.ai_model_config order by created_at limit 1;
  if v_model is null then
    raise exception 'FIXTURE: no ai_model_config row';
  end if;
  select default_policy into v_policy from public.v4_harness_manifest where is_active limit 1;
  if v_policy is null then
    raise exception 'FIXTURE: no active v4_harness_manifest';
  end if;

  insert into public.review_batch (id, name, week_code, default_branch)
  values ('aaaaaaaa-0000-0000-0000-000000000001', 'rollup-null-test', '2026-W38', 'feature_dev');

  insert into public.review_story (id, batch_id, story_code, story_name, owners_text)
  values ('aaaaaaaa-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001',
          'US-ROLLUP-1', 'rollup null guard', 'tester');

  insert into public.analysis_job (
    id, batch_id, model_config_id, model_snapshot, requested_branch, requested_by,
    status, execution_engine, total_stories, policy_version, capability_policy_snapshot
  ) values (
    'aaaaaaaa-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000001',
    v_model, '{}'::jsonb, 'feature_dev', v_user,
    'PROCESSING', 'deepseek-harness-acp', 1, 4, v_policy
  );

  insert into public.analysis_story_task (id, job_id, story_id, agent_status, agent_attempt)
  values ('aaaaaaaa-0000-0000-0000-000000000004', 'aaaaaaaa-0000-0000-0000-000000000003',
          'aaaaaaaa-0000-0000-0000-000000000002', 'FAILED', 1);

  -- run 1：零事件（本次修复的主目标）。
  insert into public.analysis_agent_run (
    id, task_id, job_id, agent_attempt, worker_id, status, started_at, finished_at
  ) values (
    'aaaaaaaa-0000-0000-0000-000000000011', 'aaaaaaaa-0000-0000-0000-000000000004',
    'aaaaaaaa-0000-0000-0000-000000000003', 1, 'worker-test', 'FAILED',
    now() - interval '60 seconds', now()
  );

  -- run 2：带 instrumentation 上报。
  insert into public.analysis_agent_run (
    id, task_id, job_id, agent_attempt, worker_id, status, started_at, finished_at
  ) values (
    'aaaaaaaa-0000-0000-0000-000000000012', 'aaaaaaaa-0000-0000-0000-000000000004',
    'aaaaaaaa-0000-0000-0000-000000000003', 2, 'worker-test', 'COMMITTED',
    now() - interval '60 seconds', now()
  );

  -- run 3：有事件但没有 instrumentation 上报。
  insert into public.analysis_agent_run (
    id, task_id, job_id, agent_attempt, worker_id, status, started_at, finished_at
  ) values (
    'aaaaaaaa-0000-0000-0000-000000000013', 'aaaaaaaa-0000-0000-0000-000000000004',
    'aaaaaaaa-0000-0000-0000-000000000003', 3, 'worker-test', 'FAILED',
    now() - interval '60 seconds', now()
  );

  -- run 4：仍在跑，用来确认终态闸门没被放宽。
  insert into public.analysis_agent_run (
    id, task_id, job_id, agent_attempt, worker_id, status, started_at
  ) values (
    'aaaaaaaa-0000-0000-0000-000000000014', 'aaaaaaaa-0000-0000-0000-000000000004',
    'aaaaaaaa-0000-0000-0000-000000000003', 4, 'worker-test', 'RUNNING',
    now() - interval '60 seconds'
  );
end;
$$;

select pg_temp.fixture();

-- 事件表有若干 NOT NULL 且无默认值的列（batch_id / scope / event_uuid / event_day），
-- 全部显式给值；agent_attempt 不是这张表的列，事件通过 agent_run_id 归属到 attempt。
create or replace function pg_temp.add_event(
  p_run_id uuid, p_event_type text, p_phase text, p_payload jsonb
) returns void language plpgsql as $$
begin
  insert into public.analysis_runtime_event (
    event_uuid, batch_id, job_id, task_id, agent_run_id, scope,
    event_type, phase, occurred_at, event_day, payload
  ) values (
    gen_random_uuid(),
    'aaaaaaaa-0000-0000-0000-000000000001',
    'aaaaaaaa-0000-0000-0000-000000000003',
    'aaaaaaaa-0000-0000-0000-000000000004',
    p_run_id, 'ATTEMPT',
    p_event_type, p_phase, now(), current_date, p_payload
  );
end;
$$;

select pg_temp.add_event(
  'aaaaaaaa-0000-0000-0000-000000000012',
  'ATTEMPT_INSTRUMENTATION_REPORTED', 'TERMINAL',
  jsonb_build_object('events_reported', 77, 'events_dropped', 5)
);
select pg_temp.add_event('aaaaaaaa-0000-0000-0000-000000000013', 'ATTEMPT_STARTED', 'STARTED', '{}'::jsonb);
select pg_temp.add_event('aaaaaaaa-0000-0000-0000-000000000013', 'ATTEMPT_TERMINAL', 'TERMINAL', '{}'::jsonb);

-- ---------------------------------------------------------------------------
-- 1. 零事件的终态 run 能算出 rollup（修复前这里抛 NOT NULL 违约）
-- ---------------------------------------------------------------------------
do $test$
declare
  v_reported integer;
  v_dropped integer;
  v_rows integer;
begin
  perform public.compute_analysis_run_rollup('aaaaaaaa-0000-0000-0000-000000000011');

  select count(*) into v_rows from public.analysis_agent_run_rollup
  where agent_run_id = 'aaaaaaaa-0000-0000-0000-000000000011';
  perform pg_temp.assert(v_rows = 1, 'zero-event run must produce exactly one rollup row');

  select events_reported, events_dropped into v_reported, v_dropped
  from public.analysis_agent_run_rollup
  where agent_run_id = 'aaaaaaaa-0000-0000-0000-000000000011';
  perform pg_temp.assert(v_reported = 0, 'zero-event run: events_reported must be 0, got ' || coalesce(v_reported::text, 'NULL'));
  perform pg_temp.assert(v_dropped = 0, 'zero-event run: events_dropped must be 0, got ' || coalesce(v_dropped::text, 'NULL'));
end;
$test$;

-- ---------------------------------------------------------------------------
-- 2. 有上报时以 payload 为准：兜底不能盖掉真实上报值
-- ---------------------------------------------------------------------------
do $test$
declare
  v_reported integer;
  v_dropped integer;
begin
  perform public.compute_analysis_run_rollup('aaaaaaaa-0000-0000-0000-000000000012');
  select events_reported, events_dropped into v_reported, v_dropped
  from public.analysis_agent_run_rollup
  where agent_run_id = 'aaaaaaaa-0000-0000-0000-000000000012';
  perform pg_temp.assert(v_reported = 77, 'reported run: events_reported must come from payload (77), got ' || coalesce(v_reported::text, 'NULL'));
  perform pg_temp.assert(v_dropped = 5, 'reported run: events_dropped must come from payload (5), got ' || coalesce(v_dropped::text, 'NULL'));
end;
$test$;

-- ---------------------------------------------------------------------------
-- 3. 有事件但没上报：退回数原始事件（兜底分支必须真的执行）
-- ---------------------------------------------------------------------------
do $test$
declare
  v_reported integer;
  v_dropped integer;
begin
  perform public.compute_analysis_run_rollup('aaaaaaaa-0000-0000-0000-000000000013');
  select events_reported, events_dropped into v_reported, v_dropped
  from public.analysis_agent_run_rollup
  where agent_run_id = 'aaaaaaaa-0000-0000-0000-000000000013';
  perform pg_temp.assert(v_reported = 2, 'unreported run: events_reported must fall back to raw count (2), got ' || coalesce(v_reported::text, 'NULL'));
  perform pg_temp.assert(v_dropped = 0, 'unreported run: events_dropped must be 0, got ' || coalesce(v_dropped::text, 'NULL'));
end;
$test$;

-- ---------------------------------------------------------------------------
-- 4. backfill 把零事件 run 记进 computed，而不是 failed
-- ---------------------------------------------------------------------------
do $test$
declare
  v_result jsonb;
begin
  -- 先清掉已算出的 rollup，让这三个 run 重新成为 backfill 候选。
  delete from public.analysis_agent_run_rollup
  where job_id = 'aaaaaaaa-0000-0000-0000-000000000003';

  v_result := public.backfill_analysis_run_rollups(500);

  -- 库里可能还有别的历史候选，所以断言"至少算出了我们这三个、且一个都没失败"。
  perform pg_temp.assert(
    (v_result ->> 'failed')::integer = 0,
    'backfill must not fail any candidate, got failed=' || (v_result ->> 'failed')
  );
  perform pg_temp.assert(
    (v_result ->> 'computed')::integer >= 3,
    'backfill must compute at least the three terminal runs, got computed=' || (v_result ->> 'computed')
  );
  perform pg_temp.assert(
    (select count(*) from public.analysis_agent_run_rollup
     where job_id = 'aaaaaaaa-0000-0000-0000-000000000003') = 3,
    'backfill must write a rollup for each of the three terminal runs'
  );
end;
$test$;

-- ---------------------------------------------------------------------------
-- 5. 终态闸门未被放宽：RUNNING 的 run 仍然被拒
-- ---------------------------------------------------------------------------
do $test$
declare
  v_code text;
begin
  begin
    perform public.compute_analysis_run_rollup('aaaaaaaa-0000-0000-0000-000000000014');
    perform pg_temp.assert(false, 'a RUNNING run must not be rolled up');
  exception when others then
    v_code := sqlerrm;
  end;
  perform pg_temp.assert(
    v_code like '%ROLLUP_RUN_NOT_TERMINAL%',
    'non-terminal run must be refused with ROLLUP_RUN_NOT_TERMINAL, got: ' || coalesce(v_code, 'NULL')
  );
end;
$test$;

-- ---------------------------------------------------------------------------
-- 6. 生产实际形态：已存在 rollup_version = 0 的存根行 + 有事件但无 instrumentation
--
-- 云端积压的 28 行就是这个形态（实测：rollup_version=0、events_reported=0，
-- 对应的 run 各有 4 条事件但 ATTEMPT_INSTRUMENTATION_REPORTED 为 0）。它走的是 upsert 的
-- **update** 分支，与用例 1 的 insert 分支不同，所以必须单独钉住：修复前这里同样抛
-- NOT NULL 违约，于是 backfill 每轮 failed +1 且永远升不上 version 1。
-- ---------------------------------------------------------------------------
do $test$
declare
  v_version integer;
  v_reported integer;
begin
  -- 造一个已经有存根行的 run：wall_ms / started_at / finished_at 是 NOT NULL 且无默认值。
  insert into public.analysis_agent_run (
    id, task_id, job_id, agent_attempt, worker_id, status, started_at, finished_at
  ) values (
    'aaaaaaaa-0000-0000-0000-000000000015', 'aaaaaaaa-0000-0000-0000-000000000004',
    'aaaaaaaa-0000-0000-0000-000000000003', 5, 'worker-test', 'FAILED',
    now() - interval '30 seconds', now()
  );
  perform pg_temp.add_event('aaaaaaaa-0000-0000-0000-000000000015', 'ATTEMPT_STARTED', 'STARTED', '{}'::jsonb);
  perform pg_temp.add_event('aaaaaaaa-0000-0000-0000-000000000015', 'HARNESS_PROCESS_STARTED', 'STARTED', '{}'::jsonb);
  perform pg_temp.add_event('aaaaaaaa-0000-0000-0000-000000000015', 'MODEL_REQUEST_COMPLETED', 'TERMINAL', '{}'::jsonb);
  perform pg_temp.add_event('aaaaaaaa-0000-0000-0000-000000000015', 'ATTEMPT_TERMINAL', 'TERMINAL', '{}'::jsonb);

  insert into public.analysis_agent_run_rollup (
    agent_run_id, task_id, job_id, batch_id, agent_attempt, worker_id,
    terminal_status, wall_ms, started_at, finished_at,
    events_reported, events_dropped, rollup_version
  ) values (
    'aaaaaaaa-0000-0000-0000-000000000015', 'aaaaaaaa-0000-0000-0000-000000000004',
    'aaaaaaaa-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000001',
    5, 'worker-test', 'FAILED', 30000, now() - interval '30 seconds', now(),
    0, 0, 0
  );

  perform public.compute_analysis_run_rollup('aaaaaaaa-0000-0000-0000-000000000015');

  select rollup_version, events_reported into v_version, v_reported
  from public.analysis_agent_run_rollup
  where agent_run_id = 'aaaaaaaa-0000-0000-0000-000000000015';

  perform pg_temp.assert(v_version = 1, 'stub rollup must be upgraded to version 1, got ' || coalesce(v_version::text, 'NULL'));
  perform pg_temp.assert(v_reported = 4, 'stub rollup must pick up the raw event count (4), got ' || coalesce(v_reported::text, 'NULL'));
end;
$test$;

rollback;
