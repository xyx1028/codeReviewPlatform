--
-- 跨 attempt 恢复必须显式 opt-in（V1.9 混跑保护）。
--
-- 守的是发布窗口里的一个具体事故：`supabase db push` 之后、Worker 还没重建之前，
-- 旧 Worker 仍在领任务。旧 Worker 不认识 `source_agent_attempt`，会按自己的 attempt 号
-- 派生路径，于是 profile hash 必然不匹配；而它的拒绝路径是 fail closed，会终止 attempt。
-- 结果是同一份历史 checkpoint 把这个 task 的每一次新 attempt 都毒死。
--
-- 覆盖：
--   1. 不传 `p_allow_cross_attempt`（旧 Worker 的 3 键调用）→ 只看当前 attempt，
--      上一次 attempt 的 checkpoint **不**返回。
--   2. 显式传 true（新 Worker）→ 返回上一次 attempt 的候选并带 source_agent_attempt。
--   3. 函数只剩一个重载（3 参旧签名已 drop，避免 PostgREST 多候选）。
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

create or replace function pg_temp.fixture()
returns void language plpgsql as $$
declare
  v_user uuid;
  v_model uuid;
  v_policy jsonb;
begin
  select id into v_user from auth.users order by created_at limit 1;
  if v_user is null then raise exception 'FIXTURE: no auth.users row'; end if;
  select id into v_model from public.ai_model_config order by created_at limit 1;
  if v_model is null then raise exception 'FIXTURE: no ai_model_config row'; end if;
  select default_policy into v_policy from public.v4_harness_manifest where is_active limit 1;
  if v_policy is null then raise exception 'FIXTURE: no active v4_harness_manifest'; end if;

  insert into public.review_batch (id, name, week_code, default_branch)
  values ('dddddddd-0000-0000-0000-000000000001', 'resume-opt-in', '2026-W38', 'feature_dev');

  insert into public.review_story (id, batch_id, story_code, story_name, owners_text)
  values ('dddddddd-0000-0000-0000-000000000002', 'dddddddd-0000-0000-0000-000000000001',
          'US-OPTIN-1', 'resume opt in', 'tester');

  insert into public.analysis_job (
    id, batch_id, model_config_id, model_snapshot, requested_branch, requested_by,
    status, execution_engine, total_stories, policy_version, capability_policy_snapshot
  ) values (
    'dddddddd-0000-0000-0000-000000000003', 'dddddddd-0000-0000-0000-000000000001',
    v_model, '{}'::jsonb, 'feature_dev', v_user,
    'PROCESSING', 'deepseek-harness-acp', 1, 4, v_policy
  );

  insert into public.analysis_story_task (
    id, job_id, story_id, agent_status, agent_attempt, worker_id,
    lease_expires_at, heartbeat_at, claim_token_digest, started_at
  ) values (
    'dddddddd-0000-0000-0000-000000000004', 'dddddddd-0000-0000-0000-000000000003',
    'dddddddd-0000-0000-0000-000000000002', 'RUNNING', 2, 'worker-optin',
    now() + interval '10 minutes', now(),
    public.agent_claim_token_digest('dddddddd-0000-0000-0000-0000000000ff'::uuid),
    now() - interval '30 minutes'
  );

  -- attempt 1：被打断，留下 checkpoint。
  insert into public.analysis_agent_run (
    id, task_id, job_id, agent_attempt, worker_id, status, error_code,
    started_at, finished_at, sealed_at, session_revision
  ) values (
    'dddddddd-0000-0000-0000-000000000011', 'dddddddd-0000-0000-0000-000000000004',
    'dddddddd-0000-0000-0000-000000000003', 1, 'worker-old', 'FAILED', 'WORKER_LOST',
    now() - interval '30 minutes', now() - interval '20 minutes', now() - interval '20 minutes', 2
  );

  -- attempt 2：当前在跑，自己没有 checkpoint。
  insert into public.analysis_agent_run (
    id, task_id, job_id, agent_attempt, worker_id, status, started_at, session_revision
  ) values (
    'dddddddd-0000-0000-0000-000000000012', 'dddddddd-0000-0000-0000-000000000004',
    'dddddddd-0000-0000-0000-000000000003', 2, 'worker-optin', 'RUNNING',
    now() - interval '1 minute', 3
  );

  insert into public.analysis_session_checkpoint (
    agent_run_id, session_id, session_revision, storage_locator, content_hash,
    event_count, harness_version, profile_hash, status, retention_until, prefix_bytes
  ) values (
    'dddddddd-0000-0000-0000-000000000011', 'session-optin-1', 2,
    '/workspace/agent-sessions/attempt-1/--slug--/session-optin-1/session.v3.jsonl',
    'sha256:prefix-1', 7, '0.1.5-rc.1/v3', 'profile-1', 'OPEN',
    now() + interval '7 days', 300
  );
end;
$$;

select pg_temp.fixture();

-- ---------------------------------------------------------------------------
-- 1. 旧 Worker 的 3 键调用：拿不到上一次 attempt 的候选
-- ---------------------------------------------------------------------------
do $test$
declare v_result jsonb;
begin
  v_result := public.load_resumable_analysis_attempt(
    'dddddddd-0000-0000-0000-000000000004', 'worker-optin',
    'dddddddd-0000-0000-0000-0000000000ff'::uuid
  );
  perform pg_temp.assert(v_result is null,
    'without the opt-in flag a previous-attempt checkpoint must stay invisible: an old worker '
    || 'would fail closed on it and poison every later attempt');
end;
$test$;

-- ---------------------------------------------------------------------------
-- 2. 新 Worker 显式 opt-in：拿到候选并带来源 attempt
-- ---------------------------------------------------------------------------
do $test$
declare v_result jsonb;
begin
  v_result := public.load_resumable_analysis_attempt(
    'dddddddd-0000-0000-0000-000000000004', 'worker-optin',
    'dddddddd-0000-0000-0000-0000000000ff'::uuid,
    true
  );
  perform pg_temp.assert(v_result is not null, 'the opt-in caller must receive the candidate');
  perform pg_temp.assert(v_result ->> 'session_id' = 'session-optin-1',
    'candidate session mismatch: ' || coalesce(v_result ->> 'session_id', 'NULL'));
  perform pg_temp.assert((v_result ->> 'source_agent_attempt')::integer = 1,
    'source_agent_attempt must be 1, got ' || coalesce(v_result ->> 'source_agent_attempt', 'NULL'));
  perform pg_temp.assert((v_result ->> 'prefix_bytes')::bigint = 300,
    'prefix_bytes must come back, got ' || coalesce(v_result ->> 'prefix_bytes', 'NULL'));
end;
$test$;

-- ---------------------------------------------------------------------------
-- 3. 只剩一个重载
-- ---------------------------------------------------------------------------
do $test$
declare v_count integer;
begin
  select count(*) into v_count
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'load_resumable_analysis_attempt';
  perform pg_temp.assert(v_count = 1,
    'the 3-argument overload must be dropped, got ' || v_count || ' overloads');
end;
$test$;

rollback;
