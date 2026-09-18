--
-- reclaim_stale_story_task_leases：必须**两条心跳同时陈旧**才接管在途 attempt。
--
-- 守的是一次真实的、每次都很贵的失败：一个正在跑模型请求的副本因为可用性心跳晚了
-- 20 秒被判掉线，它手上的 attempt 被接管、`agent_attempt+1` 从零重跑，20~40 分钟
-- 模型时间和对应 token 直接损失。
--
-- 覆盖：
--   1. 只有可用性心跳陈旧（attempt 自己的租约心跳还在动）→ **不接管**。
--   2. 只有租约心跳陈旧（副本可用性心跳还在动）→ **不接管**。
--   3. 两条都陈旧 → 接管：run 判 WORKER_LOST + sealed + revision+1，task 回 PENDING。
--   4. 可用性心跳整行缺失 + 租约心跳陈旧 → 接管（容器真的没了）。
--   5. 已 SUCCEEDED 的 task 永不被接管（已提交结果绝不重跑）。
--   6. 函数仍然只有 0 参数一个重载（避免 PostgREST 空 body 撞上多候选）。
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
-- 夹具：一个 PROCESSING 的 V4 Job + 5 个 task，每个 task 一个 RUNNING run。
--
-- requested_by 取库里第一个真实用户（外键约束），capability_policy_snapshot 取当前
-- active manifest 的 default_policy，否则冻结触发器会拒绝插入。
-- ---------------------------------------------------------------------------
create or replace function pg_temp.fixture()
returns void language plpgsql as $$
declare
  v_user uuid;
  v_model uuid;
  v_policy jsonb;
  v_case record;
begin
  select id into v_user from auth.users order by created_at limit 1;
  if v_user is null then raise exception 'FIXTURE: no auth.users row'; end if;
  select id into v_model from public.ai_model_config order by created_at limit 1;
  if v_model is null then raise exception 'FIXTURE: no ai_model_config row'; end if;
  select default_policy into v_policy from public.v4_harness_manifest where is_active limit 1;
  if v_policy is null then raise exception 'FIXTURE: no active v4_harness_manifest'; end if;

  insert into public.review_batch (id, name, week_code, default_branch)
  values ('bbbbbbbb-0000-0000-0000-000000000001', 'reclaim-grace-test', '2026-W38', 'feature_dev');

  insert into public.analysis_job (
    id, batch_id, model_config_id, model_snapshot, requested_branch, requested_by,
    status, execution_engine, total_stories, policy_version, capability_policy_snapshot
  ) values (
    'bbbbbbbb-0000-0000-0000-000000000003', 'bbbbbbbb-0000-0000-0000-000000000001',
    v_model, '{}'::jsonb, 'feature_dev', v_user,
    'PROCESSING', 'deepseek-harness-acp', 5, 4, v_policy
  );

  -- 五个场景，每个一套 story/task/run/worker 心跳。
  for v_case in
    select *
    from (values
      -- 用例 1：可用性心跳陈旧（5 分钟），租约心跳新鲜（10 秒）→ 不该接管。
      (1, 'worker-only-availability-stale', interval '5 minutes', interval '10 seconds', true),
      -- 用例 2：可用性心跳新鲜（3 秒），租约心跳陈旧（5 分钟）→ 不该接管。
      (2, 'worker-only-task-stale',         interval '3 seconds', interval '5 minutes', true),
      -- 用例 3：两条都陈旧 → 接管。
      (3, 'worker-both-stale',              interval '5 minutes', interval '5 minutes', true),
      -- 用例 4：没有可用性心跳行 + 租约心跳陈旧 → 接管。
      (4, 'worker-heartbeat-missing',       null::interval,       interval '5 minutes', false),
      -- 用例 5：任务已 SUCCEEDED，两条都陈旧 → 永不接管。
      (5, 'worker-succeeded',               interval '5 minutes', interval '5 minutes', true)
    ) as t(idx, worker_id, worker_age, task_age, has_heartbeat_row)
  loop
    insert into public.review_story (id, batch_id, story_code, story_name, owners_text)
    values (
      ('bbbbbbbb-0000-0000-0000-00000000001' || v_case.idx)::uuid,
      'bbbbbbbb-0000-0000-0000-000000000001',
      'US-RECLAIM-' || v_case.idx, 'reclaim grace ' || v_case.idx, 'tester'
    );

    insert into public.analysis_story_task (
      id, job_id, story_id, agent_status, agent_attempt, worker_id,
      lease_expires_at, heartbeat_at, claim_token_digest, started_at
    ) values (
      ('bbbbbbbb-0000-0000-0000-00000000002' || v_case.idx)::uuid,
      'bbbbbbbb-0000-0000-0000-000000000003',
      ('bbbbbbbb-0000-0000-0000-00000000001' || v_case.idx)::uuid,
      case when v_case.idx = 5 then 'SUCCEEDED' else 'RUNNING' end,
      1, v_case.worker_id,
      -- 租约本身仍然有效（15 分钟）：这正是接管判据要处理的窗口。
      now() + interval '10 minutes',
      now() - v_case.task_age,
      -- claim token digest 只要非空即可，这里不走 claim RPC。
      encode(sha256(('token-' || v_case.idx)::bytea), 'hex'),
      now() - interval '20 minutes'
    );

    insert into public.analysis_agent_run (
      id, task_id, job_id, agent_attempt, worker_id, status, started_at, session_revision
    ) values (
      ('bbbbbbbb-0000-0000-0000-00000000003' || v_case.idx)::uuid,
      ('bbbbbbbb-0000-0000-0000-00000000002' || v_case.idx)::uuid,
      'bbbbbbbb-0000-0000-0000-000000000003',
      1, v_case.worker_id, 'RUNNING', now() - interval '20 minutes', 7
    );

    if v_case.has_heartbeat_row then
      insert into public.analysis_worker_heartbeat (worker_id, last_seen_at, slots, current_tasks)
      values (v_case.worker_id, now() - v_case.worker_age, 2, 1)
      on conflict (worker_id) do update set last_seen_at = excluded.last_seen_at;
    end if;
  end loop;
end;
$$;

select pg_temp.fixture();

-- ---------------------------------------------------------------------------
-- 执行一次接管扫描
-- ---------------------------------------------------------------------------
create temporary table pg_temp_reclaim_result as
select public.reclaim_stale_story_task_leases() as reclaimed;

-- ---------------------------------------------------------------------------
-- 1. 只有可用性心跳陈旧 → 不接管
-- ---------------------------------------------------------------------------
do $test$
declare v_status text; v_worker text; v_run_status text;
begin
  select agent_status, worker_id into v_status, v_worker
  from public.analysis_story_task where id = 'bbbbbbbb-0000-0000-0000-000000000021';
  perform pg_temp.assert(v_status = 'RUNNING',
    'availability-only stale: task must stay RUNNING, got ' || coalesce(v_status, 'NULL'));
  perform pg_temp.assert(v_worker = 'worker-only-availability-stale',
    'availability-only stale: worker_id must be kept');
  select status into v_run_status from public.analysis_agent_run
  where id = 'bbbbbbbb-0000-0000-0000-000000000031';
  perform pg_temp.assert(v_run_status = 'RUNNING',
    'availability-only stale: run must stay RUNNING, got ' || coalesce(v_run_status, 'NULL'));
end;
$test$;

-- ---------------------------------------------------------------------------
-- 2. 只有租约心跳陈旧 → 不接管
-- ---------------------------------------------------------------------------
do $test$
declare v_status text; v_run_status text;
begin
  select agent_status into v_status
  from public.analysis_story_task where id = 'bbbbbbbb-0000-0000-0000-000000000022';
  perform pg_temp.assert(v_status = 'RUNNING',
    'task-heartbeat-only stale: task must stay RUNNING, got ' || coalesce(v_status, 'NULL'));
  select status into v_run_status from public.analysis_agent_run
  where id = 'bbbbbbbb-0000-0000-0000-000000000032';
  perform pg_temp.assert(v_run_status = 'RUNNING',
    'task-heartbeat-only stale: run must stay RUNNING');
end;
$test$;

-- ---------------------------------------------------------------------------
-- 3. 两条都陈旧 → 接管
-- ---------------------------------------------------------------------------
do $test$
declare
  v_status text; v_worker text; v_lease timestamptz; v_digest text;
  v_run_status text; v_code text; v_sealed timestamptz; v_revision integer; v_message text;
begin
  select agent_status, worker_id, lease_expires_at, claim_token_digest
    into v_status, v_worker, v_lease, v_digest
  from public.analysis_story_task where id = 'bbbbbbbb-0000-0000-0000-000000000023';
  perform pg_temp.assert(v_status = 'PENDING',
    'both stale: task must return to PENDING, got ' || coalesce(v_status, 'NULL'));
  perform pg_temp.assert(v_worker is null, 'both stale: worker_id must be cleared');
  perform pg_temp.assert(v_lease is null, 'both stale: lease must be cleared');
  perform pg_temp.assert(v_digest is null, 'both stale: claim token digest must be cleared');

  select status, error_code, sealed_at, session_revision, error_message
    into v_run_status, v_code, v_sealed, v_revision, v_message
  from public.analysis_agent_run where id = 'bbbbbbbb-0000-0000-0000-000000000033';
  perform pg_temp.assert(v_run_status = 'FAILED', 'both stale: run must be FAILED');
  perform pg_temp.assert(v_code = 'WORKER_LOST', 'both stale: error_code must be WORKER_LOST');
  perform pg_temp.assert(v_sealed is not null, 'both stale: run must be sealed for fencing');
  perform pg_temp.assert(v_revision = 8,
    'both stale: session_revision must advance 7 -> 8, got ' || coalesce(v_revision::text, 'NULL'));
  -- 诊断信息必须带上两个陈旧时长，否则复盘无法区分"进程没了"和"某条心跳链路卡住"。
  perform pg_temp.assert(v_message like '%worker heartbeat%' or v_message like '%last seen%',
    'both stale: error_message must describe the observed staleness, got ' || coalesce(v_message, 'NULL'));
end;
$test$;

-- ---------------------------------------------------------------------------
-- 4. 可用性心跳整行缺失 + 租约心跳陈旧 → 接管
-- ---------------------------------------------------------------------------
do $test$
declare v_status text; v_code text; v_message text;
begin
  select agent_status into v_status
  from public.analysis_story_task where id = 'bbbbbbbb-0000-0000-0000-000000000024';
  perform pg_temp.assert(v_status = 'PENDING',
    'missing heartbeat row: task must return to PENDING, got ' || coalesce(v_status, 'NULL'));
  select error_code, error_message into v_code, v_message
  from public.analysis_agent_run where id = 'bbbbbbbb-0000-0000-0000-000000000034';
  perform pg_temp.assert(v_code = 'WORKER_LOST', 'missing heartbeat row: run must be WORKER_LOST');
  perform pg_temp.assert(v_message like '%never%',
    'missing heartbeat row: message must say the worker was never seen, got ' || coalesce(v_message, 'NULL'));
end;
$test$;

-- ---------------------------------------------------------------------------
-- 5. 已 SUCCEEDED 的 task 永不接管
-- ---------------------------------------------------------------------------
do $test$
declare v_status text; v_worker text;
begin
  select agent_status, worker_id into v_status, v_worker
  from public.analysis_story_task where id = 'bbbbbbbb-0000-0000-0000-000000000025';
  perform pg_temp.assert(v_status = 'SUCCEEDED',
    'succeeded task must never be reclaimed, got ' || coalesce(v_status, 'NULL'));
  perform pg_temp.assert(v_worker = 'worker-succeeded',
    'succeeded task must keep its worker_id');
end;
$test$;

-- ---------------------------------------------------------------------------
-- 6. 接管计数 = 2（用例 3、4），且函数仍然只有一个 0 参重载
-- ---------------------------------------------------------------------------
do $test$
declare v_reclaimed integer; v_overloads integer;
begin
  select reclaimed into v_reclaimed from pg_temp_reclaim_result;
  perform pg_temp.assert(v_reclaimed = 2,
    'exactly the two genuinely-lost tasks must be reclaimed, got ' || coalesce(v_reclaimed::text, 'NULL'));

  select count(*) into v_overloads
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'reclaim_stale_story_task_leases';
  perform pg_temp.assert(v_overloads = 1,
    'reclaim_stale_story_task_leases must have exactly one overload, got ' || coalesce(v_overloads::text, 'NULL'));
end;
$test$;

rollback;
