-- 0034 把 first-terminal-wins 抑制登记为 semantic duplicate。BEFORE INSERT 早于
-- ON CONFLICT：若首个已落库 TERMINAL 以相同 event_uuid 重试，0032 raw writer 已按 UUID
-- 计 duplicated=1，trigger 不应再次增加 semantic duplicate。

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

  if exists (
    select 1
    from public.analysis_runtime_event existing
    where existing.agent_run_id = new.agent_run_id
      and existing.correlation_id = new.correlation_id
      and existing.phase = 'TERMINAL'
  ) then
    -- 相同 event_uuid 的网络重试已由 raw writer 的预检查计入 duplicated；只有新 UUID
    -- 表达的第二终态才需要额外登记为 semantic duplicate。
    if not exists (
      select 1
      from public.analysis_runtime_event existing_uuid
      where existing_uuid.event_uuid = new.event_uuid
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
    end if;
    return null;
  end if;

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

comment on function public.normalize_analysis_runtime_terminal_insert() is
  'Normalizes successful synthetic closures and enforces first-terminal-wins; new-UUID suppressed terminals are counted once as semantic duplicates.';
