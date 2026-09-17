-- 修复：终态 attempt 的 rollup 对"从未上报过 instrumentation"的 run 永久算不出来。
--
-- 症状：Worker 每轮都打印 `run_rollup_backfilled computed:0 failed:28`，数字一轮不变。
-- 2026-09-17 批次 032bea72 的日志里 10:43 / 10:49 / 10:53 / 10:59 四轮都是 28，
-- 说明这不是"还没算完"，而是同一批 run 每次都抛同一个异常。
--
-- 根因见函数体内注释：`compute_analysis_run_rollup` 里查 ATTEMPT_INSTRUMENTATION_REPORTED
-- 的那次 SELECT INTO 在零行时把变量置成 NULL，导致兜底分支被跳过、NULL 撞上 NOT NULL 约束。
-- 本迁移只改这一处，其余逻辑逐字保持不变（函数体取自当前生效定义）。
--
-- 只替换函数体，签名不变，因此用 create or replace 即可，无需重新 grant。
-- 可重复应用。
--
-- 文件名说明：生成时的真实 UTC 时刻是 20260917113326，但目录里已存在
-- 20260917143802_configurable_skill_catalog_limits.sql。迁移按**字典序**应用，用真实时刻会
-- 把本迁移插到那几个已应用的迁移之前，这正是 supabase-migration-naming 与
-- scripts/v4-harness-manifest.mjs 的字典序守卫明确禁止的。因此按"同批次撞号则秒数加一"的
-- 规则取现有最大值 +1 秒，把先后关系显式写死在文件名里。

CREATE OR REPLACE FUNCTION public.compute_analysis_run_rollup(p_agent_run_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_run public.analysis_agent_run;
  v_job public.analysis_job;
  v_started timestamptz;
  v_finished timestamptz;
  v_wall bigint;
  v_setup bigint := 0;
  v_teardown bigint := 0;
  v_busy bigint := 0;
  v_model_union bigint := 0;
  v_tool_union bigint := 0;
  v_platform_union bigint := 0;
  v_model_sum bigint := 0;
  v_tool_sum bigint := 0;
  v_idle bigint := 0;
  v_unattributed bigint;
  v_attempt_started timestamptz;
  v_process_started timestamptz;
  v_last_terminal timestamptz;
  v_kinds jsonb := '{}'::jsonb;
  v_tool_ms jsonb := '{}'::jsonb;
  v_tool_calls_by_name jsonb := '{}'::jsonb;
  v_per_agent jsonb := '[]'::jsonb;
  v_model_requests integer := 0;
  v_model_denied integer := 0;
  v_tool_calls integer := 0;
  v_tool_denied integer := 0;
  v_tool_failed integer := 0;
  v_events_reported integer := 0;
  v_events_dropped integer := 0;
  v_end_reason text;
  v_cap integer := 2147483647;
begin
  select * into v_run from public.analysis_agent_run where id = p_agent_run_id;
  if v_run.id is null then
    raise exception 'agent run not found';
  end if;
  if v_run.status not in ('COMMITTED', 'FAILED') then
    raise exception 'ROLLUP_RUN_NOT_TERMINAL';
  end if;
  select * into v_job from public.analysis_job where id = v_run.job_id;

  v_started := v_run.started_at;
  v_finished := coalesce(v_run.finished_at, v_run.committed_at, now());
  if v_finished < v_started then
    v_finished := v_started;
  end if;
  v_wall := least((extract(epoch from (v_finished - v_started)) * 1000)::bigint, v_cap);

  select min(occurred_at) into v_attempt_started
  from public.analysis_runtime_event
  where agent_run_id = p_agent_run_id and event_type = 'ATTEMPT_STARTED';

  select min(occurred_at) into v_process_started
  from public.analysis_runtime_event
  where agent_run_id = p_agent_run_id and event_type = 'HARNESS_PROCESS_STARTED';

  select max(occurred_at) into v_last_terminal
  from public.analysis_runtime_event
  where agent_run_id = p_agent_run_id and phase = 'TERMINAL';

  if v_attempt_started is not null and v_process_started is not null then
    v_setup := greatest(
      0, (extract(epoch from (v_process_started - v_attempt_started)) * 1000)::bigint
    );
  end if;
  if v_last_terminal is not null then
    v_teardown := greatest(
      0, (extract(epoch from (v_finished - v_last_terminal)) * 1000)::bigint
    );
  end if;

  v_setup := least(v_setup, v_wall);
  v_teardown := least(v_teardown, greatest(v_wall - v_setup, 0));

  v_model_union := public.analysis_runtime_union_ms(p_agent_run_id, array['MODEL']);
  v_tool_union := public.analysis_runtime_union_ms(p_agent_run_id, array['TOOL']);
  -- 平台侧（Broker → 冻结快照 / 提交）与 Harness 侧的分界。
  v_platform_union := public.analysis_runtime_tool_union_ms(
    p_agent_run_id, public.analysis_runtime_platform_tool_names()
  );
  v_busy := public.analysis_runtime_union_ms(p_agent_run_id, array['MODEL', 'TOOL']);
  v_busy := least(v_busy, greatest(v_wall - v_setup - v_teardown, 0));
  v_model_union := least(v_model_union, v_wall);
  v_tool_union := least(v_tool_union, v_wall);
  v_platform_union := least(v_platform_union, v_wall);
  v_unattributed := greatest(v_wall - v_setup - v_busy - v_teardown, 0);

  select
    least(coalesce(sum(case when interval_row.scope = 'MODEL'
      then (extract(epoch from (interval_row.end_at - interval_row.start_at)) * 1000)::bigint
      else 0 end), 0), v_cap),
    least(coalesce(sum(case when interval_row.scope = 'TOOL'
      then (extract(epoch from (interval_row.end_at - interval_row.start_at)) * 1000)::bigint
      else 0 end), 0), v_cap)
    into v_model_sum, v_tool_sum
  from public.analysis_runtime_intervals(p_agent_run_id, array['MODEL', 'TOOL']) as interval_row;

  -- per-Agent 段 + agent_idle_ms：已注册未终态但没有任何未闭合 correlation 的时长。
  select
    coalesce(jsonb_agg(agent_row.entry order by agent_row.depth, agent_row.started_at), '[]'::jsonb),
    coalesce(sum(agent_row.idle_ms), 0)
    into v_per_agent, v_idle
  from (
    select
      node.delegation_depth as depth,
      node.started_at,
      greatest(
        0,
        (extract(epoch from (
          coalesce(node.finished_at, node.cancelled_at, v_finished) - node.started_at
        )) * 1000)::bigint
        - public.analysis_runtime_union_ms(p_agent_run_id, array['MODEL', 'TOOL'], node.id)
      ) as idle_ms,
      jsonb_build_object(
        'agent_id', node.agent_id,
        'agent_node_id', node.id,
        'role', node.agent_role,
        'provider', node.provider,
        'depth', node.delegation_depth,
        'status', node.status,
        'model_requests', node.model_requests,
        'tool_calls', node.tool_calls,
        'tool_ms', public.analysis_runtime_union_ms(p_agent_run_id, array['TOOL'], node.id),
        'model_ms', public.analysis_runtime_union_ms(p_agent_run_id, array['MODEL'], node.id),
        'evidence_produced', node.evidence_produced,
        'idle_ms', greatest(
          0,
          (extract(epoch from (
            coalesce(node.finished_at, node.cancelled_at, v_finished) - node.started_at
          )) * 1000)::bigint
          - public.analysis_runtime_union_ms(p_agent_run_id, array['MODEL', 'TOOL'], node.id)
        )
      ) as entry
    from public.analysis_agent_node node
    where node.agent_run_id = p_agent_run_id
  ) agent_row;

  select coalesce(jsonb_object_agg(kind_row.kind, kind_row.total), '{}'::jsonb)
    into v_kinds
  from (
    select coalesce(interval_row.model_request_kind, 'other') as kind, count(*) as total
    from public.analysis_runtime_intervals(p_agent_run_id, array['MODEL']) as interval_row
    group by 1
  ) kind_row;

  select
    coalesce(jsonb_object_agg(tool_row.name, tool_row.total_ms), '{}'::jsonb),
    coalesce(jsonb_object_agg(tool_row.name, tool_row.calls), '{}'::jsonb)
    into v_tool_ms, v_tool_calls_by_name
  from (
    select
      coalesce(interval_row.tool_name, 'unknown') as name,
      sum((extract(epoch from (interval_row.end_at - interval_row.start_at)) * 1000)::bigint) as total_ms,
      count(*) as calls
    from public.analysis_runtime_intervals(p_agent_run_id, array['TOOL']) as interval_row
    group by 1
  ) tool_row;

  select
    count(*) filter (where event_type in ('MODEL_REQUEST_COMPLETED', 'MODEL_REQUEST_FAILED')),
    count(*) filter (where event_type = 'MODEL_REQUEST_DENIED'),
    count(*) filter (where event_type in (
      'TOOL_CALL_COMPLETED', 'TOOL_CALL_FAILED', 'TOOL_CALL_CANCELLED'
    )),
    count(*) filter (where event_type = 'TOOL_CALL_DENIED'),
    count(*) filter (where event_type = 'TOOL_CALL_FAILED')
    into v_model_requests, v_model_denied, v_tool_calls, v_tool_denied, v_tool_failed
  from public.analysis_runtime_event
  where agent_run_id = p_agent_run_id;

  select
    coalesce((payload ->> 'events_reported')::integer, 0),
    coalesce((payload ->> 'events_dropped')::integer, 0)
    into v_events_reported, v_events_dropped
  from public.analysis_runtime_event
  where agent_run_id = p_agent_run_id
    and event_type = 'ATTEMPT_INSTRUMENTATION_REPORTED'
  order by id desc
  limit 1;

  -- 零行 SELECT INTO 会把目标变量置成 NULL。
  --
  -- 这是这个函数唯一一处"可能一行都选不到"的 SELECT INTO：一个 attempt 如果从没上报过
  -- ATTEMPT_INSTRUMENTATION_REPORTED（RUNTIME_EVENTS_ENABLED 之前的历史 run，或者在上报
  -- 之前就被租约回收打断的 run），这里就是零行。此时 PL/pgSQL 会把 v_events_reported /
  -- v_events_dropped 双双置为 NULL —— 声明处的 `:= 0` 和 select 列表里的 coalesce 都拦不住，
  -- 因为前者被覆盖、后者根本没被求值。
  --
  -- 后果是连锁的：下面的 `= 0` 变成 NULL（既不真也不假），于是"没有上报就退回数原始事件"
  -- 这条兜底分支被跳过，NULL 一路带到 insert，撞上 events_reported / events_dropped 的
  -- NOT NULL 约束抛异常。而 backfill_analysis_run_rollups 把每个异常都吞进 `failed` 计数，
  -- 既不记错误码也不记 run id，于是运维看到的只是 `computed:0 failed:28` 一轮一轮重复 ——
  -- 同一批 run 永远算不出来，且没有任何线索指向原因。
  v_events_reported := coalesce(v_events_reported, 0);
  v_events_dropped := coalesce(v_events_dropped, 0);

  if v_events_reported = 0 then
    select count(*) into v_events_reported
    from public.analysis_runtime_event where agent_run_id = p_agent_run_id;
    -- count(*) 是聚合，恒返回一行，所以这里不会再出现零行置 NULL。
    v_events_reported := coalesce(v_events_reported, 0);
  end if;

  v_end_reason := case
    when v_run.cancel_reason = 'WORKER_LOST' then 'LEASE_LOST'
    when v_run.cancel_reason = 'WORKER_SHUTDOWN' then 'WORKER_SHUTDOWN'
    when v_run.cancel_reason = 'USER_CANCELLED' then 'USER_CANCELLED'
    when v_run.error_code = 'WORKER_LOST' then 'LEASE_LOST'
    when v_run.error_code = 'WORKER_SHUTDOWN' then 'WORKER_SHUTDOWN'
    else null
  end;

  insert into public.analysis_agent_run_rollup (
    agent_run_id, task_id, job_id, batch_id, agent_attempt, worker_id,
    model_label, harness_version, capability_contract_hash, profile_config_hash,
    policy_hash, prompt_version, policy_version,
    terminal_status, terminal_error_code, end_reason, resumed, resume_count,
    wall_ms, setup_ms, model_ms_union, tool_ms_union, platform_tool_ms_union,
    busy_ms_union, teardown_ms,
    agent_idle_ms, unattributed_ms, model_ms_sum, tool_ms_sum,
    agent_count, max_depth, max_concurrent_agents, max_concurrent_tools,
    model_requests, model_requests_by_kind, model_requests_denied,
    tool_calls, tool_calls_denied, tool_calls_failed,
    tool_ms_by_name, tool_calls_by_name,
    input_tokens, output_tokens, evidence_count, artifact_count, rejected_submissions,
    per_agent, events_reported, events_dropped,
    started_at, finished_at, computed_at, rollup_version
  ) values (
    v_run.id, v_run.task_id, v_run.job_id, v_job.batch_id, v_run.agent_attempt,
    v_run.worker_id,
    v_run.model_label, v_job.harness_version, v_job.capability_contract_hash,
    v_run.profile_config_hash, v_run.policy_hash, v_run.prompt_version,
    v_job.policy_version,
    v_run.status, v_run.error_code, v_end_reason,
    v_run.resume_count > 0, v_run.resume_count,
    v_wall::integer, v_setup::integer, v_model_union::integer, v_tool_union::integer,
    v_platform_union::integer,
    v_busy::integer, v_teardown::integer, least(v_idle, v_cap)::integer,
    v_unattributed::integer, v_model_sum::integer, v_tool_sum::integer,
    v_run.agent_count, v_run.max_depth_reached,
    greatest(public.analysis_runtime_max_concurrent_agents(v_run.id), 1),
    public.analysis_runtime_max_overlap(v_run.id, array['TOOL']),
    v_model_requests, v_kinds, v_model_denied,
    v_tool_calls, v_tool_denied, v_tool_failed,
    v_tool_ms, v_tool_calls_by_name,
    v_run.input_tokens, v_run.output_tokens,
    (select count(*) from public.analysis_agent_evidence where agent_run_id = v_run.id),
    (select count(*) from public.analysis_artifact where agent_run_id = v_run.id),
    (select count(*) from public.analysis_permission_decision
      where agent_run_id = v_run.id and decision = 'DENY' and reason_code like 'SUBMIT%'),
    v_per_agent, v_events_reported, v_events_dropped,
    v_started, v_finished, now(), 1
  )
  on conflict (agent_run_id) do update
  set task_id = excluded.task_id,
      job_id = excluded.job_id,
      batch_id = excluded.batch_id,
      agent_attempt = excluded.agent_attempt,
      worker_id = excluded.worker_id,
      model_label = excluded.model_label,
      harness_version = excluded.harness_version,
      capability_contract_hash = excluded.capability_contract_hash,
      profile_config_hash = excluded.profile_config_hash,
      policy_hash = excluded.policy_hash,
      prompt_version = excluded.prompt_version,
      policy_version = excluded.policy_version,
      terminal_status = excluded.terminal_status,
      terminal_error_code = excluded.terminal_error_code,
      end_reason = excluded.end_reason,
      resumed = excluded.resumed,
      resume_count = excluded.resume_count,
      wall_ms = excluded.wall_ms,
      setup_ms = excluded.setup_ms,
      model_ms_union = excluded.model_ms_union,
      tool_ms_union = excluded.tool_ms_union,
      platform_tool_ms_union = excluded.platform_tool_ms_union,
      busy_ms_union = excluded.busy_ms_union,
      teardown_ms = excluded.teardown_ms,
      agent_idle_ms = excluded.agent_idle_ms,
      unattributed_ms = excluded.unattributed_ms,
      model_ms_sum = excluded.model_ms_sum,
      tool_ms_sum = excluded.tool_ms_sum,
      agent_count = excluded.agent_count,
      max_depth = excluded.max_depth,
      max_concurrent_agents = excluded.max_concurrent_agents,
      max_concurrent_tools = excluded.max_concurrent_tools,
      model_requests = excluded.model_requests,
      model_requests_by_kind = excluded.model_requests_by_kind,
      model_requests_denied = excluded.model_requests_denied,
      tool_calls = excluded.tool_calls,
      tool_calls_denied = excluded.tool_calls_denied,
      tool_calls_failed = excluded.tool_calls_failed,
      tool_ms_by_name = excluded.tool_ms_by_name,
      tool_calls_by_name = excluded.tool_calls_by_name,
      input_tokens = excluded.input_tokens,
      output_tokens = excluded.output_tokens,
      evidence_count = excluded.evidence_count,
      artifact_count = excluded.artifact_count,
      rejected_submissions = excluded.rejected_submissions,
      per_agent = excluded.per_agent,
      events_reported = excluded.events_reported,
      events_dropped = excluded.events_dropped,
      started_at = excluded.started_at,
      finished_at = excluded.finished_at,
      computed_at = now(),
      rollup_version = 1;

  return jsonb_build_object(
    'agent_run_id', v_run.id,
    'wall_ms', v_wall,
    'setup_ms', v_setup,
    'busy_ms_union', v_busy,
    'teardown_ms', v_teardown,
    'unattributed_ms', v_unattributed,
    'rollup_version', 1
  );
end;
$function$;
