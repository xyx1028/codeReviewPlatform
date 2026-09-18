--
-- Session 续跑真正可用（V1.9）：checkpoint 前缀 + 跨 attempt 恢复候选。
--
-- 守的是"恢复机器全在但从不生效"这个具体失败：改造前
--   * checkpoint 只在 turn 正常返回时写一次（云端库整张表只有 1 行），
--   * `load_resumable_analysis_attempt` 只查当前 attempt 的 run，而每次 claim 都
--     `agent_attempt+1`，所以候选恒为空。
--
-- 覆盖：
--   1. `prefix_bytes` 落库，并随周期 checkpoint 的 upsert 前进（不新增行）。
--   2. 跨 attempt：attempt 1 的 checkpoint 能被 attempt 2 找到，并带出 source_agent_attempt。
--   3. `session_revision` 返回 greatest(当前 run, checkpoint + 1)，fencing 只前进。
--   4. `resume_count` 沿 attempt 链累加（恢复链路有界）。
--   5. 任何一次 attempt 已 COMMITTED → 一律不恢复（已提交结果绝不重跑）。
--   6. 当前 run 已封存或已请求取消 → 不恢复。
--   7. `save_analysis_session_checkpoint` 只剩一个重载（旧 13 参签名已 drop）。
--
-- 注：`load_resumable_analysis_attempt` 的第 4 个参数 `p_allow_cross_attempt` 由紧随其后的
-- `20260917143807` 引入（跨 attempt 判定改成显式 opt-in，保护发布窗口里尚未升级的 Worker）。
-- 本测试跑在完整迁移链之上，所以显式传 true —— 那正是新 Worker 的调用方式。
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
-- 夹具：一个 PROCESSING 的 V4 Job，一个 task（当前 attempt = 2），两个 run。
--
-- attempt 1 = 被容器重建打断的那一次（FAILED + WORKER_LOST + sealed，reclaim 的产物），
-- attempt 2 = 接管后新领取的那一次（RUNNING）。这正是线上事故后的真实形态。
-- ---------------------------------------------------------------------------
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
  values ('cccccccc-0000-0000-0000-000000000001', 'resume-across-attempts', '2026-W38', 'feature_dev');

  insert into public.review_story (id, batch_id, story_code, story_name, owners_text)
  values ('cccccccc-0000-0000-0000-000000000002', 'cccccccc-0000-0000-0000-000000000001',
          'US-RESUME-1', 'resume across attempts', 'tester');

  insert into public.analysis_job (
    id, batch_id, model_config_id, model_snapshot, requested_branch, requested_by,
    status, execution_engine, total_stories, policy_version, capability_policy_snapshot
  ) values (
    'cccccccc-0000-0000-0000-000000000003', 'cccccccc-0000-0000-0000-000000000001',
    v_model, '{}'::jsonb, 'feature_dev', v_user,
    'PROCESSING', 'deepseek-harness-acp', 1, 4, v_policy
  );

  -- claim token 明文只在测试里出现；库里只有 digest。
  insert into public.analysis_story_task (
    id, job_id, story_id, agent_status, agent_attempt, worker_id,
    lease_expires_at, heartbeat_at, claim_token_digest, started_at
  ) values (
    'cccccccc-0000-0000-0000-000000000004', 'cccccccc-0000-0000-0000-000000000003',
    'cccccccc-0000-0000-0000-000000000002', 'RUNNING', 2, 'worker-resume',
    now() + interval '10 minutes', now(),
    public.agent_claim_token_digest('cccccccc-0000-0000-0000-0000000000ff'::uuid),
    now() - interval '30 minutes'
  );

  -- attempt 1：被接管，已封存。它的 checkpoint 正是要被继续的那一份。
  insert into public.analysis_agent_run (
    id, task_id, job_id, agent_attempt, worker_id, status, error_code,
    started_at, finished_at, sealed_at, session_revision, resume_count,
    root_agent_id, root_session_id, policy_hash
  ) values (
    'cccccccc-0000-0000-0000-000000000011', 'cccccccc-0000-0000-0000-000000000004',
    'cccccccc-0000-0000-0000-000000000003', 1, 'worker-old', 'FAILED', 'WORKER_LOST',
    now() - interval '30 minutes', now() - interval '20 minutes', now() - interval '20 minutes',
    2, 0, 'root-attempt-1', 'session-attempt-1', 'policy-hash-1'
  );

  -- attempt 2：当前在跑的那一次。
  insert into public.analysis_agent_run (
    id, task_id, job_id, agent_attempt, worker_id, status, started_at, session_revision
  ) values (
    'cccccccc-0000-0000-0000-000000000012', 'cccccccc-0000-0000-0000-000000000004',
    'cccccccc-0000-0000-0000-000000000003', 2, 'worker-resume', 'RUNNING',
    now() - interval '1 minute', 3
  );
end;
$$;

select pg_temp.fixture();

-- ---------------------------------------------------------------------------
-- 1. prefix_bytes 落库；周期 checkpoint 覆盖同一行而不是新增行
-- ---------------------------------------------------------------------------
do $test$
declare
  v_rows integer;
  v_prefix bigint;
  v_events integer;
begin
  -- 第一次（turn 刚开始）
  perform public.save_analysis_session_checkpoint(
    'cccccccc-0000-0000-0000-000000000004', 'worker-resume',
    'cccccccc-0000-0000-0000-0000000000ff'::uuid, 2,
    'session-attempt-2', 4,
    '/workspace/agent-sessions/attempt-x/--slug--/session-attempt-2/session.v3.jsonl',
    'sha256:aaa', 2, '0.1.5-rc.1/v3', 'profile-hash-2', 'OPEN', null, 120
  );
  -- 一分钟后再写一次：日志长了，前缀也长了。
  perform public.save_analysis_session_checkpoint(
    'cccccccc-0000-0000-0000-000000000004', 'worker-resume',
    'cccccccc-0000-0000-0000-0000000000ff'::uuid, 2,
    'session-attempt-2', 4,
    '/workspace/agent-sessions/attempt-x/--slug--/session-attempt-2/session.v3.jsonl',
    'sha256:bbb', 5, '0.1.5-rc.1/v3', 'profile-hash-2', 'OPEN', null, 480
  );

  select count(*) into v_rows from public.analysis_session_checkpoint
  where session_id = 'session-attempt-2';
  perform pg_temp.assert(v_rows = 1,
    'periodic checkpoints must upsert one row per (session_id, revision), got ' || v_rows);

  select prefix_bytes, event_count into v_prefix, v_events
  from public.analysis_session_checkpoint where session_id = 'session-attempt-2';
  perform pg_temp.assert(v_prefix = 480,
    'prefix_bytes must advance to 480, got ' || coalesce(v_prefix::text, 'NULL'));
  perform pg_temp.assert(v_events = 5,
    'event_count must advance to 5, got ' || coalesce(v_events::text, 'NULL'));
end;
$test$;

-- ---------------------------------------------------------------------------
-- 2~4. 跨 attempt 候选：来源 attempt、revision 水位、resume_count 累加
-- ---------------------------------------------------------------------------
do $test$
declare
  v_result jsonb;
  v_run_resume integer;
  v_run_revision integer;
begin
  -- attempt 1 留下的 checkpoint（revision 2，与 attempt 1 的 run 一致）。
  insert into public.analysis_session_checkpoint (
    agent_run_id, session_id, session_revision, storage_locator, content_hash,
    event_count, harness_version, profile_hash, status, retention_until, prefix_bytes
  ) values (
    'cccccccc-0000-0000-0000-000000000011', 'session-attempt-1', 2,
    '/workspace/agent-sessions/attempt-1/--slug--/session-attempt-1/session.v3.jsonl',
    'sha256:prefix-1', 42, '0.1.5-rc.1/v3', 'profile-hash-1', 'OPEN',
    now() + interval '7 days', 900
  );

  v_result := public.load_resumable_analysis_attempt(
    'cccccccc-0000-0000-0000-000000000004', 'worker-resume',
    'cccccccc-0000-0000-0000-0000000000ff'::uuid, true
  );

  perform pg_temp.assert(v_result is not null,
    'a checkpoint from a previous attempt must be resumable (this is the whole fix)');
  -- 注意：session-attempt-2 的 checkpoint（revision 4）比 attempt 1 的更新，所以它才是候选。
  perform pg_temp.assert(v_result ->> 'session_id' = 'session-attempt-2',
    'the newest checkpoint wins, got ' || coalesce(v_result ->> 'session_id', 'NULL'));
  perform pg_temp.assert((v_result ->> 'source_agent_attempt')::integer = 2,
    'source_agent_attempt must identify which attempt owns the checkpoint, got '
    || coalesce(v_result ->> 'source_agent_attempt', 'NULL'));
  perform pg_temp.assert((v_result ->> 'prefix_bytes')::bigint = 480,
    'prefix_bytes must come back for the prefix check, got '
    || coalesce(v_result ->> 'prefix_bytes', 'NULL'));
  -- revision = greatest(当前 run 3, checkpoint 4 + 1) = 5
  perform pg_temp.assert((v_result ->> 'session_revision')::integer = 5,
    'session_revision must be greatest(run, checkpoint+1) = 5, got '
    || coalesce(v_result ->> 'session_revision', 'NULL'));
  perform pg_temp.assert((v_result ->> 'resume_count')::integer = 1,
    'resume_count must advance along the attempt chain, got '
    || coalesce(v_result ->> 'resume_count', 'NULL'));

  select resume_count, session_revision into v_run_resume, v_run_revision
  from public.analysis_agent_run where id = 'cccccccc-0000-0000-0000-000000000012';
  perform pg_temp.assert(v_run_resume = 1, 'the current run must record resume_count = 1');
  perform pg_temp.assert(v_run_revision = 5, 'the current run must record revision 5');
end;
$test$;

-- ---------------------------------------------------------------------------
-- 2b. 只保留旧 attempt 的 checkpoint 时，候选就是它，并带出 attempt 1
-- ---------------------------------------------------------------------------
do $test$
declare v_result jsonb; v_source_policy text;
begin
  delete from public.analysis_session_checkpoint where session_id = 'session-attempt-2';
  -- 复位 fencing 状态，只测"候选选择"。
  update public.analysis_agent_run set resume_count = 0, session_revision = 3
  where id = 'cccccccc-0000-0000-0000-000000000012';

  -- policy_hash 由 analysis_agent_run 的冻结触发器写入（不是测试硬编码的值），
  -- 所以断言要拿库里那一行的真值来比。
  select policy_hash into v_source_policy from public.analysis_agent_run
  where id = 'cccccccc-0000-0000-0000-000000000011';

  v_result := public.load_resumable_analysis_attempt(
    'cccccccc-0000-0000-0000-000000000004', 'worker-resume',
    'cccccccc-0000-0000-0000-0000000000ff'::uuid, true
  );
  perform pg_temp.assert(v_result is not null, 'attempt-1 checkpoint must be resumable');
  perform pg_temp.assert(v_result ->> 'session_id' = 'session-attempt-1',
    'candidate must be the attempt-1 session, got ' || coalesce(v_result ->> 'session_id', 'NULL'));
  perform pg_temp.assert((v_result ->> 'source_agent_attempt')::integer = 1,
    'source_agent_attempt must be 1, got ' || coalesce(v_result ->> 'source_agent_attempt', 'NULL'));
  -- policy hash 取被恢复 attempt 的那一份：门禁比的是"这段历史在哪套 policy 下产生"。
  perform pg_temp.assert(v_result ->> 'policy_hash' = v_source_policy,
    'policy_hash must come from the resumed attempt, got ' || coalesce(v_result ->> 'policy_hash', 'NULL'));
  -- root 身份沿用被恢复的那一次：恢复的是同一个会话。
  perform pg_temp.assert(v_result ->> 'root_session_id' = 'session-attempt-1',
    'root_session_id must come from the resumed attempt, got ' || coalesce(v_result ->> 'root_session_id', 'NULL'));
  -- revision = greatest(3, 2+1) = 3
  perform pg_temp.assert((v_result ->> 'session_revision')::integer = 3,
    'revision must never go backwards, got ' || coalesce(v_result ->> 'session_revision', 'NULL'));
end;
$test$;

-- ---------------------------------------------------------------------------
-- 5. 任何一次 attempt 已 COMMITTED → 不恢复
-- ---------------------------------------------------------------------------
do $test$
declare v_result jsonb;
begin
  update public.analysis_agent_run set status = 'COMMITTED'
  where id = 'cccccccc-0000-0000-0000-000000000011';

  v_result := public.load_resumable_analysis_attempt(
    'cccccccc-0000-0000-0000-000000000004', 'worker-resume',
    'cccccccc-0000-0000-0000-0000000000ff'::uuid, true
  );
  perform pg_temp.assert(v_result is null,
    'a task with any committed attempt must never resume: committed results are never re-run');

  update public.analysis_agent_run set status = 'FAILED'
  where id = 'cccccccc-0000-0000-0000-000000000011';
end;
$test$;

-- ---------------------------------------------------------------------------
-- 6. 当前 run 已封存 / 已请求取消 → 不恢复
-- ---------------------------------------------------------------------------
do $test$
declare v_result jsonb;
begin
  update public.analysis_agent_run set sealed_at = now()
  where id = 'cccccccc-0000-0000-0000-000000000012';
  v_result := public.load_resumable_analysis_attempt(
    'cccccccc-0000-0000-0000-000000000004', 'worker-resume',
    'cccccccc-0000-0000-0000-0000000000ff'::uuid, true
  );
  perform pg_temp.assert(v_result is null, 'a sealed current run must not resume');

  update public.analysis_agent_run set sealed_at = null, cancel_requested_at = now()
  where id = 'cccccccc-0000-0000-0000-000000000012';
  v_result := public.load_resumable_analysis_attempt(
    'cccccccc-0000-0000-0000-000000000004', 'worker-resume',
    'cccccccc-0000-0000-0000-0000000000ff'::uuid, true
  );
  perform pg_temp.assert(v_result is null, 'a cancelled attempt must not resume');

  update public.analysis_agent_run set cancel_requested_at = null
  where id = 'cccccccc-0000-0000-0000-000000000012';
end;
$test$;

-- ---------------------------------------------------------------------------
-- 6b. 错误的 claim token → 不返回任何东西
-- ---------------------------------------------------------------------------
do $test$
declare v_result jsonb;
begin
  v_result := public.load_resumable_analysis_attempt(
    'cccccccc-0000-0000-0000-000000000004', 'worker-resume',
    '00000000-0000-0000-0000-000000000000'::uuid
  );
  perform pg_temp.assert(v_result is null, 'a wrong claim token must not receive a candidate');
end;
$test$;

-- ---------------------------------------------------------------------------
-- 7. save_analysis_session_checkpoint 只剩一个重载
-- ---------------------------------------------------------------------------
do $test$
declare v_count integer;
begin
  select count(*) into v_count
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'save_analysis_session_checkpoint';
  perform pg_temp.assert(v_count = 1,
    'the pre-V1.9 13-argument overload must be dropped, got ' || v_count || ' overloads');
end;
$test$;

rollback;
