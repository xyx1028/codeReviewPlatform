-- 0033 的 first-terminal-wins trigger 会用 RETURN NULL 抑制同 correlation 的迟到 TERMINAL。
-- 0032 batch writer 把“成功处理（含 event_uuid 幂等重试）”都计入 accepted，并另外用
-- duplicated 标明没有新增事实的调用；但 trigger 抑制发生在 event_uuid 预检查之后，导致
-- 迟到 TERMINAL 被计 accepted=1、duplicated=0。
--
-- 本迁移不改变 append-only、fencing 或 accepted 的兼容语义，只让 trigger 在当前事务的
-- session-local counter 中登记抑制次数，由 API wrapper 合并进 duplicated。

create or replace function public.normalize_analysis_runtime_terminal_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_suppressed integer;
begin
  if new.phase <> 'TERMINAL'
     or new.agent_run_id is null
     or nullif(btrim(coalesce(new.correlation_id, '')), '') is null then
    return new;
  end if;

  -- first-terminal-wins：正常 Reporter 串行发送，唯一需要竞争的是终态 seal 与迟到的
  -- provider/tool 终态。登记为 semantic duplicate 后拒绝后者。
  if exists (
    select 1
    from public.analysis_runtime_event existing
    where existing.agent_run_id = new.agent_run_id
      and existing.correlation_id = new.correlation_id
      and existing.phase = 'TERMINAL'
  ) then
    v_suppressed := coalesce(
      nullif(current_setting('code_review.runtime_terminal_duplicates', true), '')::integer,
      0
    );
    perform set_config(
      'code_review.runtime_terminal_duplicates',
      (v_suppressed + 1)::text,
      true
    );
    return null;
  end if;

  -- 成功提交本身证明最后一次模型请求已经产出了可验证、可提交的结果；它不是模型失败。
  if new.error_code = 'ATTEMPT_COMMITTED'
     and new.scope = 'MODEL'
     and new.event_type = 'MODEL_REQUEST_FAILED' then
    new.event_type := 'MODEL_REQUEST_COMPLETED';
    new.status := 'COMPLETED';
    new.error_code := null;
  elsif new.error_code = 'ATTEMPT_COMMITTED'
        and new.scope = 'TOOL'
        and new.event_type = 'TOOL_CALL_CANCELLED'
        and new.payload ->> 'tool_name' = 'submit_review_result' then
    new.event_type := 'TOOL_CALL_COMPLETED';
    new.status := 'COMPLETED';
    new.error_code := null;
  end if;

  return new;
end;
$$;

-- 保留 0032 实现作为不可直接调用的 raw writer；wrapper 只修正结果计数，不接触 fencing。
alter function public.report_analysis_runtime_event_batch(
  text, uuid, uuid, uuid, integer, jsonb, integer
) rename to report_analysis_runtime_event_batch_raw;

revoke execute on function public.report_analysis_runtime_event_batch_raw(
  text, uuid, uuid, uuid, integer, jsonb, integer
) from public, anon, authenticated, service_role;

create function public.report_analysis_runtime_event_batch(
  p_worker_id text,
  p_job_id uuid,
  p_task_id uuid default null,
  p_claim_token uuid default null,
  p_agent_attempt integer default null,
  p_events jsonb default '[]'::jsonb,
  p_session_revision integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_result jsonb;
  v_suppressed integer;
  v_duplicated integer;
begin
  perform set_config('code_review.runtime_terminal_duplicates', '0', true);

  v_result := public.report_analysis_runtime_event_batch_raw(
    p_worker_id,
    p_job_id,
    p_task_id,
    p_claim_token,
    p_agent_attempt,
    p_events,
    p_session_revision
  );

  v_suppressed := coalesce(
    nullif(current_setting('code_review.runtime_terminal_duplicates', true), '')::integer,
    0
  );
  v_duplicated := coalesce((v_result ->> 'duplicated')::integer, 0) + v_suppressed;

  return jsonb_set(v_result, '{duplicated}', to_jsonb(v_duplicated), true);
end;
$$;

revoke execute on function public.report_analysis_runtime_event_batch(
  text, uuid, uuid, uuid, integer, jsonb, integer
) from public, anon, authenticated;
grant execute on function public.report_analysis_runtime_event_batch(
  text, uuid, uuid, uuid, integer, jsonb, integer
) to service_role;

comment on function public.report_analysis_runtime_event_batch(
  text, uuid, uuid, uuid, integer, jsonb, integer
) is
  'Fenced runtime event writer. accepted means handled; duplicated includes event_uuid retries and first-terminal-wins suppression.';
