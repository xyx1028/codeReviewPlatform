-- Make leases held by a Worker with no recent heartbeat visible to admins.
-- These are not live slots: they are recovered on graceful shutdown or lease expiry.

begin;

create or replace function public.admin_list_recovery_story_leases()
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

  select coalesce(jsonb_agg(jsonb_build_object(
    'worker_id', task.worker_id,
    'phase', 'AGENT',
    'batch_id', batch.id,
    'batch_name', batch.name,
    'week_code', batch.week_code,
    'batch_status', batch.status,
    'job_id', job.id,
    'job_status', job.status,
    'requested_branch', job.requested_branch,
    'job_started_at', job.started_at,
    'task_id', task.id,
    'story_id', story.id,
    'story_code', story.story_code,
    'story_name', story.story_name,
    'heartbeat_at', task.heartbeat_at,
    'lease_expires_at', task.lease_expires_at
  ) order by task.lease_expires_at, batch.name, story.story_code), '[]'::jsonb)
    into v_result
  from public.analysis_story_task task
  join public.analysis_job job on job.id = task.job_id
  join public.review_batch batch on batch.id = job.batch_id
  join public.review_story story on story.id = task.story_id
  where job.execution_engine = 'deepseek-harness-acp'
    and task.worker_id is not null
    and task.lease_expires_at >= now()
    and task.agent_status not in ('SUCCEEDED', 'FAILED')
    and not exists (
      select 1
      from public.analysis_worker_heartbeat heartbeat
      where heartbeat.worker_id = task.worker_id
        and heartbeat.last_seen_at >= now() - interval '20 seconds'
    );

  return v_result;
end;
$$;

revoke execute on function public.admin_list_recovery_story_leases()
  from public, anon;
grant execute on function public.admin_list_recovery_story_leases() to authenticated;

commit;
