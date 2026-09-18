-- 趋势报表增加"每次模型请求"的口径（V1.9.1）。
--
-- 文件名说明：与本批次前四个迁移同序列，秒数继续 +1。
--
-- ## 为什么必须有这几个字段
--
-- 用户看到"有些任务执行了 40 几分钟"，而现有趋势报表只有 `wall_ms` 与 `model_ms_union`。
-- 这两个数字**无法区分**两种完全不同的病因：
--
--   * 模型端每次请求就很慢（平台无能为力，只能换模型或降并发）；
--   * 我们发的请求次数太多 / 每次上下文太大（平台可以优化）。
--
-- 实测数据说明这个区分有多关键（26 个需求、同一套平台、同一条内网代理链路）：
--
-- | 模型 | 整批耗时 | 每次模型请求中位数 | 每次请求输入 token 中位数 | 请求次数中位数 |
-- |---|---|---|---|---|
-- | glm5.3-flash | 16.8 分 | 5.9 秒 | 36810 | 36 |
-- | kimi-k3 | 63.0 分 | 27.0~65.7 秒 | 26176 | 22 |
--
-- kimi-k3 的请求**更少**、上下文**更小**，却慢 4 倍 —— 病因完全在模型端的单请求延迟上。
-- 没有 `model_ms_per_request` 这个口径，这个结论只能靠人工翻 rollup 算除法，
-- 而"一个需要人工算除法才能看见的指标"在事故里等于不存在。
--
-- 新增四个分组指标：
--   * `model_ms_per_request_p50` / `_p95`：单次模型请求耗时（模型端速度）；
--   * `input_tokens_per_request_p50`：单次请求的输入规模（上下文膨胀）；
--   * `model_requests_p50`：一次 attempt 的模型往返次数（编排效率）。
--
-- 三者相乘约等于 `model_ms_union`，所以任何一次变慢都能被归到具体一项上：
-- 是模型变慢了、上下文变大了，还是来回变多了。
--
-- 签名不变（text[], timestamptz, uuid, text），直接 `create or replace`，不产生重载。

begin;

create or replace function public.get_analysis_run_trend(
  p_group_by text[] default array['model_label', 'policy_hash'],
  p_since timestamptz default now() - interval '30 days',
  p_batch_id uuid default null,
  p_terminal_status text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_allowed text[] := array[
    'model_label', 'policy_hash', 'profile_config_hash', 'harness_version',
    'terminal_status', 'day'
  ];
  v_dim text;
  v_keys text[] := array[]::text[];
  v_exprs text[] := array[]::text[];
  v_sql text;
  v_result jsonb;
begin
  if p_group_by is null or array_length(p_group_by, 1) is null then
    raise exception 'TREND_GROUP_BY_REQUIRED';
  end if;
  if p_terminal_status is not null
     and p_terminal_status not in ('COMMITTED', 'FAILED', 'CANCELLED') then
    raise exception 'TREND_TERMINAL_STATUS_INVALID';
  end if;

  foreach v_dim in array p_group_by loop
    if not (v_dim = any (v_allowed)) then
      raise exception 'TREND_GROUP_BY_INVALID';
    end if;
    v_keys := v_keys || v_dim;
    if v_dim = 'day' then
      v_exprs := v_exprs || 'to_jsonb(rollup.finished_at::date)';
    else
      v_exprs := v_exprs || format('to_jsonb(rollup.%I)', v_dim);
    end if;
  end loop;

  v_sql := format($fmt$
    select coalesce(jsonb_agg(grouped.entry order by grouped.total desc), '[]'::jsonb)
    from (
      select
        count(*) as total,
        jsonb_build_object(
          'group', jsonb_build_object(%s),
          'count', count(*),
          'failed', count(*) filter (where rollup.terminal_status = 'FAILED'),
          'failure_rate', round(
            (count(*) filter (where rollup.terminal_status = 'FAILED'))::numeric
            / greatest(count(*), 1), 4),
          'wall_ms_p50', percentile_cont(0.5) within group (order by rollup.wall_ms),
          'wall_ms_p95', percentile_cont(0.95) within group (order by rollup.wall_ms),
          'wall_ms_max', max(rollup.wall_ms),
          'setup_ms_p50', percentile_cont(0.5) within group (order by rollup.setup_ms),
          'model_ms_union_p50', percentile_cont(0.5) within group (order by rollup.model_ms_union),
          -- 单次模型请求耗时：区分"模型端慢"与"我们请求多"的唯一口径。
          -- 只统计真的发过模型请求的 run（除以 0 没有意义，也会污染分位数）。
          'model_ms_per_request_p50', percentile_cont(0.5) within group (
            order by (rollup.model_ms_union::numeric / rollup.model_requests)
          ) filter (where coalesce(rollup.model_requests, 0) > 0),
          'model_ms_per_request_p95', percentile_cont(0.95) within group (
            order by (rollup.model_ms_union::numeric / rollup.model_requests)
          ) filter (where coalesce(rollup.model_requests, 0) > 0),
          -- 单次请求的输入规模：上下文膨胀会同时推高延迟与费用。
          'input_tokens_per_request_p50', percentile_cont(0.5) within group (
            order by (rollup.input_tokens::numeric / rollup.model_requests)
          ) filter (where coalesce(rollup.model_requests, 0) > 0
                      and rollup.input_tokens is not null),
          -- 一次 attempt 的模型往返次数：编排效率。
          'model_requests_p50', percentile_cont(0.5) within group (
            order by rollup.model_requests
          ) filter (where rollup.model_requests is not null),
          'tool_ms_union_p50', percentile_cont(0.5) within group (order by rollup.tool_ms_union),
          'platform_tool_ms_union_p50', percentile_cont(0.5)
            within group (order by rollup.platform_tool_ms_union),
          'busy_ms_union_p50', percentile_cont(0.5) within group (order by rollup.busy_ms_union),
          'teardown_ms_p50', percentile_cont(0.5) within group (order by rollup.teardown_ms),
          'agent_idle_ms_p50', percentile_cont(0.5) within group (order by rollup.agent_idle_ms),
          'unattributed_ms_p50', percentile_cont(0.5)
            within group (order by rollup.unattributed_ms),
          'unattributed_pct', round(
            (sum(rollup.unattributed_ms)::numeric * 100) / greatest(sum(rollup.wall_ms), 1), 2),
          'terminal_error_codes', coalesce(jsonb_object_agg(
            rollup.terminal_error_code, 1) filter (where rollup.terminal_error_code is not null),
            '{}'::jsonb),
          'events_dropped', sum(rollup.events_dropped)
        ) as entry
      from public.analysis_agent_run_rollup rollup
      where rollup.finished_at >= $1
        and rollup.rollup_version > 0
        and ($2::uuid is null or rollup.batch_id = $2)
        and ($3::text is null or rollup.terminal_status = $3)
      group by %s
    ) grouped
  $fmt$,
    (
      select string_agg(format('%L, %s', v_keys[idx], v_exprs[idx]), ', ')
      from generate_subscripts(v_keys, 1) as idx
    ),
    array_to_string(v_exprs, ', ')
  );

  execute v_sql into v_result using p_since, p_batch_id, p_terminal_status;

  return jsonb_build_object(
    'server_time', now(),
    'since', p_since,
    'group_by', to_jsonb(v_keys),
    'groups', coalesce(v_result, '[]'::jsonb)
  );
end;
$$;

-- 诊断 RPC 只给 service_role：它不经前端，也不授予 authenticated。
revoke execute on function public.get_analysis_run_trend(text[], timestamptz, uuid, text)
  from public, anon, authenticated;
grant execute on function public.get_analysis_run_trend(text[], timestamptz, uuid, text)
  to service_role;

commit;
