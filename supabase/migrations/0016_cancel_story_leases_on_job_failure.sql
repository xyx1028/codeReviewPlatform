begin;

------------------------------------------------------------------------------
-- 1. 单需求失败时原子停止同 Job 的所有在途任务
------------------------------------------------------------------------------

create or replace function public.fail_story_task(
  p_task_id uuid,
  p_worker_id text,
  p_stage text,
  p_error_code text,
  p_error_message text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job_id uuid;
  v_lock_key bigint;
  v_held boolean;
begin
  if p_stage is null or p_stage not in ('retrieval', 'analysis') then
    raise exception 'stage must be retrieval or analysis';
  end if;

  -- 先确定 Job，再在锁任何 task 行之前串行化同 Job 的失败处理。
  -- 避免两个 sibling 同时失败时各持一行、再批量更新对方而死锁。
  select task.job_id into v_job_id
  from public.analysis_story_task task
  where task.id = p_task_id;

  if v_job_id is null then
    raise exception 'task not found';
  end if;

  v_lock_key := (
    'x' || substr(md5('analysis_job:' || v_job_id::text), 1, 16)
  )::bit(64)::bigint;
  perform pg_advisory_xact_lock(v_lock_key);

  -- 获取 Job 锁后重新校验目标 task 的租约；后到的失败调用会因首个
  -- 事务已撤销全部租约而得到 TASK_LEASE_LOST。
  select (
    task.worker_id = p_worker_id
    and task.lease_expires_at is not null
    and task.lease_expires_at >= now()
  ) into v_held
  from public.analysis_story_task task
  where task.id = p_task_id
  for update;

  if not found then
    raise exception 'task not found';
  end if;
  if not coalesce(v_held, false) then
    raise exception 'TASK_LEASE_LOST';
  end if;

  update public.analysis_story_task task
  set retrieval_status = case
        when task.id = p_task_id and p_stage = 'retrieval' then 'FAILED'
        when task.retrieval_status = 'RUNNING' then 'PENDING'
        else task.retrieval_status
      end,
      analysis_status = case
        when task.id = p_task_id and p_stage = 'analysis' then 'FAILED'
        when task.analysis_status = 'RUNNING' then 'PENDING'
        else task.analysis_status
      end,
      worker_id = null,
      lease_expires_at = null,
      heartbeat_at = null,
      error_code = case
        when task.id = p_task_id then p_error_code else task.error_code
      end,
      error_message = case
        when task.id = p_task_id then p_error_message else task.error_message
      end,
      finished_at = case
        when task.id = p_task_id then now() else task.finished_at
      end
  where task.job_id = v_job_id;

  update public.analysis_job
  set status = 'FAILED',
      worker_id = null,
      locked_at = null,
      finalizer_worker_id = null,
      finalize_lease_expires_at = null,
      error_code = p_error_code,
      error_message = p_error_message,
      finished_at = now()
  where id = v_job_id
    and status <> 'SUCCEEDED';
end;
$$;

revoke execute on function public.fail_story_task(uuid, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.fail_story_task(uuid, text, text, text, text)
  to service_role;

------------------------------------------------------------------------------
-- 2. 一次性清理升级前已 FAILED Job 遗留的租约和 RUNNING 状态
------------------------------------------------------------------------------

update public.analysis_story_task task
set retrieval_status = case
      when task.retrieval_status = 'RUNNING' then 'PENDING'
      else task.retrieval_status
    end,
    analysis_status = case
      when task.analysis_status = 'RUNNING' then 'PENDING'
      else task.analysis_status
    end,
    worker_id = null,
    lease_expires_at = null,
    heartbeat_at = null
from public.analysis_job job
where job.id = task.job_id
  and job.status = 'FAILED'
  and (
    task.retrieval_status = 'RUNNING'
    or task.analysis_status = 'RUNNING'
    or task.worker_id is not null
    or task.lease_expires_at is not null
    or task.heartbeat_at is not null
  );

update public.analysis_job job
set worker_id = null,
    locked_at = null,
    finalizer_worker_id = null,
    finalize_lease_expires_at = null
where job.status = 'FAILED'
  and (
    job.worker_id is not null
    or job.locked_at is not null
    or job.finalizer_worker_id is not null
    or job.finalize_lease_expires_at is not null
  );

commit;
