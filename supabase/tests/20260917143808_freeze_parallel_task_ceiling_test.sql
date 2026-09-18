--
-- 并发闸门 = least(Job 冻结上限, 实时闸门)（V1.9.1）。
--
-- 守的是一次实测到的真实放大：job 189a4302 的 model_snapshot.max_parallel_tasks 是 8，
-- 但配置在它执行途中被改成 16，于是实测并发峰值就是 16 —— 而 kimi-k3 在 16 并发下
-- 吞吐没涨（0.46 → 0.41 需求/分钟）、单请求延迟涨了 2.4 倍（27 → 65.7 秒），
-- 单个 attempt 从 ~15 分钟变成 40~55 分钟。
--
-- 覆盖：
--   1. 实时值 > 冻结值 → 按冻结值封顶（在途批次不被放大）。
--   2. 实时值 < 冻结值 → 按实时值收窄，立刻生效（事故期间必须能限流）。
--   3. 快照没有这个字段（旧 Job）→ 用实时值。
--   4. 返回的 model 里带 effective_max_parallel_tasks，便于解释"为什么只有 N 个在跑"。
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
-- 夹具：一个模型配置 + 一个 PROCESSING Job（快照并发=2）+ 3 个 PENDING 任务。
--
-- 用小数字（2）让"闸门是否生效"只需要领两三次就能观察到。
-- ---------------------------------------------------------------------------
create or replace function pg_temp.fixture(p_snapshot_parallel jsonb, p_live_parallel integer)
returns void language plpgsql as $$
declare
  v_user uuid;
  v_model uuid;
  v_policy jsonb;
  v_idx integer;
begin
  select id into v_user from auth.users order by created_at limit 1;
  if v_user is null then raise exception 'FIXTURE: no auth.users row'; end if;
  select default_policy into v_policy from public.v4_harness_manifest where is_active limit 1;
  if v_policy is null then raise exception 'FIXTURE: no active v4_harness_manifest'; end if;

  -- 独立的模型配置：不动库里既有配置的并发值。
  -- api_key_secret_id 既有外键（vault.secrets）又有唯一约束，所以为测试单独建一个
  -- vault secret。整个测试在事务里 rollback，这条 secret 不会留下。
  insert into public.ai_model_config (
    id, display_name, model_name, base_url, api_key_secret_id,
    max_parallel_tasks, enabled, created_by
  ) values (
    'eeeeeeee-0000-0000-0000-0000000000c0', 'parallel-gate-test', 'gate-model',
    'http://model.invalid/v1',
    vault.create_secret('not-a-real-key', 'parallel-gate-test-' || gen_random_uuid()::text),
    p_live_parallel, true, v_user
  );

  insert into public.review_batch (id, name, week_code, default_branch)
  values ('eeeeeeee-0000-0000-0000-000000000001', 'parallel-gate', '2026-W38', 'feature_dev');

  insert into public.analysis_job (
    id, batch_id, model_config_id, model_snapshot, requested_branch, requested_by,
    status, execution_engine, total_stories, policy_version, capability_policy_snapshot
  ) values (
    'eeeeeeee-0000-0000-0000-000000000003', 'eeeeeeee-0000-0000-0000-000000000001',
    'eeeeeeee-0000-0000-0000-0000000000c0',
    -- 冻结快照：并发上限按参数给，其余字段留空走 coalesce 兜底。
    p_snapshot_parallel,
    'feature_dev', v_user, 'PROCESSING', 'deepseek-harness-acp', 3, 4, v_policy
  );

  for v_idx in 1..3 loop
    insert into public.review_story (id, batch_id, story_code, story_name, owners_text)
    values (
      ('eeeeeeee-0000-0000-0000-00000000001' || v_idx)::uuid,
      'eeeeeeee-0000-0000-0000-000000000001',
      'US-GATE-' || v_idx, 'parallel gate ' || v_idx, 'tester'
    );
    insert into public.analysis_story_task (id, job_id, story_id, agent_status, agent_attempt)
    values (
      ('eeeeeeee-0000-0000-0000-00000000002' || v_idx)::uuid,
      'eeeeeeee-0000-0000-0000-000000000003',
      ('eeeeeeee-0000-0000-0000-00000000001' || v_idx)::uuid,
      'PENDING', 0
    );
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- 1. 实时值(9) > 冻结值(2) → 只能领 2 个（在途批次不被放大）
-- ---------------------------------------------------------------------------
savepoint case_ceiling;
select pg_temp.fixture(jsonb_build_object('max_parallel_tasks', 2), 9);

do $test$
declare
  v_first jsonb;
  v_second jsonb;
  v_third jsonb;
begin
  v_first := public.claim_next_story_task('worker-gate-1', 900);
  v_second := public.claim_next_story_task('worker-gate-2', 900);
  v_third := public.claim_next_story_task('worker-gate-3', 900);

  perform pg_temp.assert(v_first is not null, 'first claim must succeed');
  perform pg_temp.assert(v_second is not null, 'second claim must succeed');
  perform pg_temp.assert(v_third is null,
    'the third claim must be refused: the frozen ceiling is 2, raising live config to 9 '
    || 'must not amplify an in-flight job');
  perform pg_temp.assert(
    (v_first -> 'model' ->> 'effective_max_parallel_tasks')::integer = 2,
    'effective_max_parallel_tasks must report the frozen ceiling, got '
    || coalesce(v_first -> 'model' ->> 'effective_max_parallel_tasks', 'NULL'));
end;
$test$;
rollback to savepoint case_ceiling;

-- ---------------------------------------------------------------------------
-- 2. 实时值(1) < 冻结值(8) → 只能领 1 个（事故限流立刻生效）
-- ---------------------------------------------------------------------------
savepoint case_throttle;
select pg_temp.fixture(jsonb_build_object('max_parallel_tasks', 8), 1);

do $test$
declare v_first jsonb; v_second jsonb;
begin
  v_first := public.claim_next_story_task('worker-gate-1', 900);
  v_second := public.claim_next_story_task('worker-gate-2', 900);
  perform pg_temp.assert(v_first is not null, 'first claim must succeed');
  perform pg_temp.assert(v_second is null,
    'lowering the live gate to 1 must take effect immediately, even for an in-flight job');
  perform pg_temp.assert(
    (v_first -> 'model' ->> 'effective_max_parallel_tasks')::integer = 1,
    'effective gate must be the live value when it is lower');
end;
$test$;
rollback to savepoint case_throttle;

-- ---------------------------------------------------------------------------
-- 3. 快照没有 max_parallel_tasks（旧 Job）→ 用实时值(2)
-- ---------------------------------------------------------------------------
savepoint case_legacy;
select pg_temp.fixture('{}'::jsonb, 2);

do $test$
declare v_first jsonb; v_second jsonb; v_third jsonb;
begin
  v_first := public.claim_next_story_task('worker-gate-1', 900);
  v_second := public.claim_next_story_task('worker-gate-2', 900);
  v_third := public.claim_next_story_task('worker-gate-3', 900);
  perform pg_temp.assert(v_first is not null and v_second is not null,
    'a legacy job without the snapshot field must fall back to the live gate');
  perform pg_temp.assert(v_third is null, 'the live gate of 2 must still cap the third claim');
  perform pg_temp.assert(
    (v_first -> 'model' ->> 'effective_max_parallel_tasks')::integer = 2,
    'effective gate must be the live value when the snapshot lacks it');
end;
$test$;
rollback to savepoint case_legacy;

-- ---------------------------------------------------------------------------
-- 4. 函数仍然只有一个重载（签名未变）
-- ---------------------------------------------------------------------------
do $test$
declare v_count integer;
begin
  select count(*) into v_count
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'claim_next_story_task';
  perform pg_temp.assert(v_count = 1,
    'claim_next_story_task must keep exactly one overload, got ' || v_count);
end;
$test$;

rollback;
