-- 真实运行收敛修复：submit_review_result 在最后一次模型流真正结束前就会原子提交。
-- 0032 的终态 seal 因此先补 MODEL_REQUEST_FAILED(ATTEMPT_COMMITTED)，随后 usage-reporter
-- 又送来同 correlation 的 MODEL_REQUEST_COMPLETED，形成双 TERMINAL 并污染请求数与归因。
--
-- 修复坚持两个边界：
--   1. 事件表仍然 append-only，不 UPDATE/DELETE 历史事实；
--   2. fencing 不放宽，仍由 report_analysis_runtime_event_batch 决定谁能写。
--
-- 对成功提交触发的合成闭合，把最终模型请求记为 COMPLETED；提交工具本身若已落 STARTED，
-- 也记为 COMPLETED，其它并行工具仍是 CANCELLED。随后到达的真实终态按
-- (agent_run_id, correlation_id) first-terminal-wins 丢弃，不再产生第二条终态。

create or replace function public.normalize_analysis_runtime_terminal_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.phase <> 'TERMINAL'
     or new.agent_run_id is null
     or nullif(btrim(coalesce(new.correlation_id, '')), '') is null then
    return new;
  end if;

  -- first-terminal-wins：正常 Reporter 串行发送，唯一需要竞争的是终态 seal 与迟到的
  -- provider/tool 终态。拒绝后者比保留两条互相矛盾的事实更安全。
  if exists (
    select 1
    from public.analysis_runtime_event existing
    where existing.agent_run_id = new.agent_run_id
      and existing.correlation_id = new.correlation_id
      and existing.phase = 'TERMINAL'
  ) then
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

revoke execute on function public.normalize_analysis_runtime_terminal_insert()
  from public, anon, authenticated, service_role;

drop trigger if exists normalize_analysis_runtime_terminal_insert
  on public.analysis_runtime_event;
create trigger normalize_analysis_runtime_terminal_insert
before insert on public.analysis_runtime_event
for each row execute function public.normalize_analysis_runtime_terminal_insert();

comment on function public.normalize_analysis_runtime_terminal_insert() is
  'Normalizes ATTEMPT_COMMITTED synthetic closures and enforces one terminal event per run correlation without mutating append-only history.';
