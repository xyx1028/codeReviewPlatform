begin;

-- 后台任务管理按 Worker 查询有效任务归属时使用。
create index if not exists idx_analysis_story_task_worker_lease
on public.analysis_story_task(worker_id, lease_expires_at)
where worker_id is not null;

create index if not exists idx_analysis_job_preparation_worker
on public.analysis_job(worker_id, status)
where worker_id is not null;

create index if not exists idx_analysis_job_finalizer_worker
on public.analysis_job(finalizer_worker_id, status)
where finalizer_worker_id is not null;

-- 管理员只读：返回当前在线 Worker 及其正在处理的批次/任务。
-- Worker 可以并发处理多个需求，因此 assignments 必须保留为数组。
create or replace function public.admin_list_analysis_workers()
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_result jsonb;
begin
  perform public.ensure_admin();

  with online_workers as (
    select
      heartbeat.worker_id,
      heartbeat.slots,
      heartbeat.current_tasks as reported_current_tasks,
      heartbeat.last_seen_at
    from public.analysis_worker_heartbeat heartbeat
    where heartbeat.last_seen_at >= now() - interval '20 seconds'
  ),
  raw_assignments as (
    -- 代码准备阶段由 analysis_job.worker_id 持有。
    select
      job.worker_id,
      'PREPARING'::text as phase,
      batch.id as batch_id,
      batch.name as batch_name,
      batch.week_code,
      batch.status as batch_status,
      job.id as job_id,
      job.status as job_status,
      job.requested_branch,
      job.started_at as job_started_at,
      null::uuid as task_id,
      null::uuid as story_id,
      null::text as story_code,
      null::text as story_name,
      worker.last_seen_at as heartbeat_at,
      null::timestamptz as lease_expires_at
    from public.analysis_job job
    join online_workers worker on worker.worker_id = job.worker_id
    join public.review_batch batch on batch.id = job.batch_id
    where job.status = 'PREPARING_CODE'

    union all

    -- 需求检索/分析阶段以仍有效的 story task 租约为准。
    select
      task.worker_id,
      case
        when task.retrieval_status = 'SUCCEEDED' then 'ANALYSIS'::text
        else 'RETRIEVAL'::text
      end as phase,
      batch.id as batch_id,
      batch.name as batch_name,
      batch.week_code,
      batch.status as batch_status,
      job.id as job_id,
      job.status as job_status,
      job.requested_branch,
      job.started_at as job_started_at,
      task.id as task_id,
      story.id as story_id,
      story.story_code,
      story.story_name,
      task.heartbeat_at,
      task.lease_expires_at
    from public.analysis_story_task task
    join online_workers worker on worker.worker_id = task.worker_id
    join public.analysis_job job on job.id = task.job_id
    join public.review_batch batch on batch.id = job.batch_id
    join public.review_story story on story.id = task.story_id
    where task.lease_expires_at >= now()
      and task.retrieval_status <> 'FAILED'
      and task.analysis_status <> 'FAILED'
      and not (
        task.retrieval_status = 'SUCCEEDED'
        and task.analysis_status = 'SUCCEEDED'
      )

    union all

    -- 结果汇总阶段由仍持有有效汇总租约的 finalizer 持有。
    select
      job.finalizer_worker_id as worker_id,
      'FINALIZING'::text as phase,
      batch.id as batch_id,
      batch.name as batch_name,
      batch.week_code,
      batch.status as batch_status,
      job.id as job_id,
      job.status as job_status,
      job.requested_branch,
      job.started_at as job_started_at,
      null::uuid as task_id,
      null::uuid as story_id,
      null::text as story_code,
      null::text as story_name,
      worker.last_seen_at as heartbeat_at,
      job.finalize_lease_expires_at as lease_expires_at
    from public.analysis_job job
    join online_workers worker on worker.worker_id = job.finalizer_worker_id
    join public.review_batch batch on batch.id = job.batch_id
    where job.status = 'FINALIZING'
      and job.finalize_lease_expires_at >= now()
  ),
  worker_assignments as (
    select
      assignment.worker_id,
      jsonb_agg(
        jsonb_build_object(
          'phase', assignment.phase,
          'batch_id', assignment.batch_id,
          'batch_name', assignment.batch_name,
          'week_code', assignment.week_code,
          'batch_status', assignment.batch_status,
          'job_id', assignment.job_id,
          'job_status', assignment.job_status,
          'requested_branch', assignment.requested_branch,
          'job_started_at', assignment.job_started_at,
          'task_id', assignment.task_id,
          'story_id', assignment.story_id,
          'story_code', assignment.story_code,
          'story_name', assignment.story_name,
          'heartbeat_at', assignment.heartbeat_at,
          'lease_expires_at', assignment.lease_expires_at
        )
        order by assignment.batch_name, assignment.story_code nulls first, assignment.phase
      ) as assignments
    from raw_assignments assignment
    group by assignment.worker_id
  ),
  worker_rows as (
    select
      worker.worker_id,
      worker.slots,
      worker.reported_current_tasks,
      worker.last_seen_at,
      coalesce(assignments.assignments, '[]'::jsonb) as assignments,
      coalesce(jsonb_array_length(assignments.assignments), 0) > 0 as working
    from online_workers worker
    left join worker_assignments assignments on assignments.worker_id = worker.worker_id
  )
  select jsonb_build_object(
    'generated_at', now(),
    'online_count', (select count(*) from worker_rows),
    'working_count', (select count(*) from worker_rows where working),
    'idle_count', (select count(*) from worker_rows where not working),
    'total_slots', coalesce((select sum(slots) from worker_rows), 0),
    'reported_current_tasks', coalesce((select sum(reported_current_tasks) from worker_rows), 0),
    'workers', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'worker_id', worker_id,
          'slots', slots,
          'reported_current_tasks', reported_current_tasks,
          'last_seen_at', last_seen_at,
          'online', true,
          'working', working,
          'assignments', assignments
        )
        order by worker_id
      )
      from worker_rows
    ), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;

revoke execute on function public.admin_list_analysis_workers() from public, anon;
grant execute on function public.admin_list_analysis_workers() to authenticated;

commit;
