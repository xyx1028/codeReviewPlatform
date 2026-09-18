--
-- 趋势报表的"每次模型请求"口径（V1.9.1）。
--
-- 守的是一个诊断能力：只有 wall_ms 与 model_ms_union 时，无法区分"模型端每次请求就慢"
-- 与"我们请求次数太多 / 上下文太大"。实测中 kimi-k3 的请求次数更少、上下文更小，却比
-- glm5.3-flash 慢 4 倍 —— 病因完全在单请求延迟上，而这一点在旧报表里看不见。
--
-- 覆盖：
--   1. `model_ms_per_request_p50/_p95` 按 run 先做除法再取分位数（不是先求和再除）。
--   2. `model_requests_p50` 与 `input_tokens_per_request_p50` 一并给出，三项可交叉判读。
--   3. `model_requests = 0` 的 run 不参与除法（否则除零或污染分位数）。
--   4. 分组维度白名单与错误码未被放宽（TREND_GROUP_BY_INVALID 仍然拒绝）。
--   5. 函数仍然只有一个重载。
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
-- 夹具：两个模型标签，各两条 rollup。
--
-- 数字刻意取成"先除后取中位数"与"先求和再除"结果不同，这样第 1 条断言才有区分力：
--   fast-model: (10000ms/10=1000ms/req) 与 (60000ms/20=3000ms/req) → 中位数 2000
--               先求和再除 = 70000/30 = 2333 → 两者不同。
--   slow-model: (60000/2=30000) 与 (120000/2=60000) → 中位数 45000
-- ---------------------------------------------------------------------------
create or replace function pg_temp.fixture()
returns void language plpgsql as $$
declare
  v_user uuid;
  v_model uuid;
  v_policy jsonb;
  v_case record;
  v_idx integer;
begin
  select id into v_user from auth.users order by created_at limit 1;
  if v_user is null then raise exception 'FIXTURE: no auth.users row'; end if;
  select id into v_model from public.ai_model_config order by created_at limit 1;
  if v_model is null then raise exception 'FIXTURE: no ai_model_config row'; end if;
  select default_policy into v_policy from public.v4_harness_manifest where is_active limit 1;
  if v_policy is null then raise exception 'FIXTURE: no active v4_harness_manifest'; end if;

  insert into public.review_batch (id, name, week_code, default_branch)
  values ('ffffffff-0000-0000-0000-000000000001', 'trend-per-request', '2026-W38', 'feature_dev');

  insert into public.analysis_job (
    id, batch_id, model_config_id, model_snapshot, requested_branch, requested_by,
    status, execution_engine, total_stories, policy_version, capability_policy_snapshot
  ) values (
    'ffffffff-0000-0000-0000-000000000003', 'ffffffff-0000-0000-0000-000000000001',
    v_model, '{}'::jsonb, 'feature_dev', v_user,
    'SUCCEEDED', 'deepseek-harness-acp', 4, 4, v_policy
  );

  -- 每个 task 一个自己的 story：(job_id, story_id) 有唯一约束。
  for v_idx in 1..5 loop
    insert into public.review_story (id, batch_id, story_code, story_name, owners_text)
    values (
      ('ffffffff-0000-0000-0000-00000000009' || v_idx)::uuid,
      'ffffffff-0000-0000-0000-000000000001',
      'US-TREND-' || v_idx, 'trend per request ' || v_idx, 'tester'
    );
  end loop;

  -- 每条 rollup 一个自己的 task：`uq_analysis_agent_run_committed` 约束一个 task 只能有
  -- 一个 COMMITTED run，而这套夹具需要 5 条终态 run。
  for v_idx in 1..5 loop
    insert into public.analysis_story_task (id, job_id, story_id, agent_status, agent_attempt)
    values (
      ('ffffffff-0000-0000-0000-00000000000' || v_idx)::uuid,
      'ffffffff-0000-0000-0000-000000000003',
      ('ffffffff-0000-0000-0000-00000000009' || v_idx)::uuid, 'SUCCEEDED', 1
    );
  end loop;

  for v_case in
    select *
    from (values
      (1, 'fast-model',  10000,  10,  200000),
      (2, 'fast-model',  60000,  20, 1200000),
      (3, 'slow-model',  60000,   2,   80000),
      (4, 'slow-model', 120000,   2,  100000),
      -- 第 5 条：没有模型请求的 run（例如启动即失败），不能参与除法。
      (5, 'slow-model',      0,   0,       0)
    ) as t(idx, label, model_ms, reqs, in_tok)
  loop
    insert into public.analysis_agent_run (
      id, task_id, job_id, agent_attempt, worker_id, status, started_at, finished_at
    ) values (
      ('ffffffff-0000-0000-0000-00000000001' || v_case.idx)::uuid,
      ('ffffffff-0000-0000-0000-00000000000' || v_case.idx)::uuid,
      'ffffffff-0000-0000-0000-000000000003',
      1, 'worker-trend', 'COMMITTED',
      now() - interval '10 minutes', now() - interval '5 minutes'
    );

    insert into public.analysis_agent_run_rollup (
      agent_run_id, task_id, job_id, batch_id, agent_attempt, terminal_status,
      model_label, policy_hash, wall_ms, setup_ms, model_ms_union, tool_ms_union,
      platform_tool_ms_union, busy_ms_union, teardown_ms, agent_idle_ms, unattributed_ms,
      model_requests, tool_calls, input_tokens, output_tokens,
      events_reported, events_dropped, rollup_version, started_at, finished_at
    ) values (
      ('ffffffff-0000-0000-0000-00000000001' || v_case.idx)::uuid,
      ('ffffffff-0000-0000-0000-00000000000' || v_case.idx)::uuid,
      'ffffffff-0000-0000-0000-000000000003',
      'ffffffff-0000-0000-0000-000000000001', 1, 'COMMITTED',
      v_case.label, 'policy-trend', v_case.model_ms + 1000, 500, v_case.model_ms, 10,
      10, v_case.model_ms, 200, 100, 200,
      v_case.reqs, 20, v_case.in_tok, 1000,
      10, 0, 1, now() - interval '10 minutes', now() - interval '5 minutes'
    );
  end loop;
end;
$$;

select pg_temp.fixture();

-- ---------------------------------------------------------------------------
-- 1~3. 每次请求耗时 / 请求次数 / 每次输入 token
-- ---------------------------------------------------------------------------
do $test$
declare
  v_result jsonb;
  v_fast jsonb;
  v_slow jsonb;
begin
  v_result := public.get_analysis_run_trend(
    array['model_label'], now() - interval '1 hour',
    'ffffffff-0000-0000-0000-000000000001'::uuid, null
  );

  select entry into v_fast
  from jsonb_array_elements(v_result -> 'groups') as entry
  where entry -> 'group' ->> 'model_label' = 'fast-model';
  select entry into v_slow
  from jsonb_array_elements(v_result -> 'groups') as entry
  where entry -> 'group' ->> 'model_label' = 'slow-model';

  perform pg_temp.assert(v_fast is not null and v_slow is not null,
    'both model labels must appear in the trend');

  -- 先除后取中位数：fast = median(1000, 3000) = 2000ms。
  -- 先求和再除会得到 2333ms —— 那个口径会把"少数超长请求"抹平，正是要避免的。
  perform pg_temp.assert(
    round((v_fast ->> 'model_ms_per_request_p50')::numeric) = 2000,
    'fast-model per-request p50 must be 2000ms (median of per-run ratios), got '
    || coalesce(v_fast ->> 'model_ms_per_request_p50', 'NULL'));
  perform pg_temp.assert(
    round((v_slow ->> 'model_ms_per_request_p50')::numeric) = 45000,
    'slow-model per-request p50 must be 45000ms, got '
    || coalesce(v_slow ->> 'model_ms_per_request_p50', 'NULL'));
  -- p95 必须比 p50 大（分位数真的在按 run 排序，而不是返回同一个值）。
  perform pg_temp.assert(
    (v_slow ->> 'model_ms_per_request_p95')::numeric
      > (v_slow ->> 'model_ms_per_request_p50')::numeric,
    'p95 must exceed p50 for slow-model');

  -- 请求次数中位数：fast = median(10, 20) = 15；slow = median(2, 2, 0) = 2
  -- （第 5 条 run 的 model_requests=0 参与次数统计但不参与除法）。
  perform pg_temp.assert((v_fast ->> 'model_requests_p50')::numeric = 15,
    'fast-model model_requests_p50 must be 15, got ' || coalesce(v_fast ->> 'model_requests_p50', 'NULL'));

  -- 每次请求输入 token：fast = median(20000, 60000) = 40000
  perform pg_temp.assert(
    round((v_fast ->> 'input_tokens_per_request_p50')::numeric) = 40000,
    'fast-model input tokens per request p50 must be 40000, got '
    || coalesce(v_fast ->> 'input_tokens_per_request_p50', 'NULL'));

  -- 关键：慢模型的"每次请求"远高于快模型，而它的请求次数更少 —— 这正是本次要能看见的事实。
  perform pg_temp.assert(
    (v_slow ->> 'model_ms_per_request_p50')::numeric
      > (v_fast ->> 'model_ms_per_request_p50')::numeric
    and (v_slow ->> 'model_requests_p50')::numeric
      < (v_fast ->> 'model_requests_p50')::numeric,
    'the report must be able to show "slower per request despite fewer requests"');
end;
$test$;

-- ---------------------------------------------------------------------------
-- 4. model_requests = 0 的 run 不导致除零，也不污染分位数
-- ---------------------------------------------------------------------------
do $test$
declare v_result jsonb; v_slow jsonb;
begin
  -- 上面已经插了一条 model_requests=0 的 run；能跑到这里说明没有除零异常。
  v_result := public.get_analysis_run_trend(
    array['model_label'], now() - interval '1 hour',
    'ffffffff-0000-0000-0000-000000000001'::uuid, null
  );
  select entry into v_slow
  from jsonb_array_elements(v_result -> 'groups') as entry
  where entry -> 'group' ->> 'model_label' = 'slow-model';
  perform pg_temp.assert((v_slow ->> 'count')::integer = 3,
    'the zero-request run must still be counted, got ' || coalesce(v_slow ->> 'count', 'NULL'));
  perform pg_temp.assert(round((v_slow ->> 'model_ms_per_request_p50')::numeric) = 45000,
    'the zero-request run must not enter the per-request percentile');
end;
$test$;

-- ---------------------------------------------------------------------------
-- 5. 分组白名单未放宽 + 只有一个重载
-- ---------------------------------------------------------------------------
do $test$
declare v_failed boolean := false; v_count integer;
begin
  begin
    perform public.get_analysis_run_trend(array['worker_id'], now() - interval '1 hour', null, null);
  exception when others then
    v_failed := (sqlerrm like '%TREND_GROUP_BY_INVALID%');
  end;
  perform pg_temp.assert(v_failed, 'an unlisted group-by dimension must still be rejected');

  select count(*) into v_count
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'get_analysis_run_trend';
  perform pg_temp.assert(v_count = 1,
    'get_analysis_run_trend must keep exactly one overload, got ' || v_count);
end;
$test$;

rollback;
