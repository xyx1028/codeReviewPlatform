-- Let a healthy Worker take over an Agent task after its previous Worker has
-- missed the availability heartbeat window. The advisory lock makes cleanup
-- and claiming serialize with the existing claim_next_story_task RPC.

begin;

create or replace function public.reclaim_stale_story_task_leases()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer := 0;
  v_task record;
begin
  perform pg_advisory_xact_lock(hashtext('claim_next_story_task'));

  for v_task in
    select task.id, task.agent_attempt
    from public.analysis_story_task task
    join public.analysis_job job on job.id = task.job_id
    where job.status = 'PROCESSING'
      and job.execution_engine = 'deepseek-harness-acp'
      and task.worker_id is not null
      and task.lease_expires_at >= now()
      and task.agent_status not in ('SUCCEEDED', 'FAILED')
      and not exists (
        select 1
        from public.analysis_worker_heartbeat heartbeat
        where heartbeat.worker_id = task.worker_id
          and heartbeat.last_seen_at >= now() - interval '20 seconds'
      )
    for update of task skip locked
  loop
    update public.analysis_agent_run
    set status = 'FAILED',
        error_code = 'WORKER_LOST',
        error_message = 'Worker heartbeat expired; task was requeued for takeover',
        finished_at = now()
    where task_id = v_task.id
      and agent_attempt = v_task.agent_attempt
      and status = 'RUNNING';

    update public.analysis_story_task
    set agent_status = 'PENDING',
        worker_id = null,
        lease_expires_at = null,
        heartbeat_at = null,
        claim_token_digest = null,
        error_code = null,
        error_message = null,
        finished_at = null
    where id = v_task.id;

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

revoke execute on function public.reclaim_stale_story_task_leases()
  from public, anon, authenticated;
grant execute on function public.reclaim_stale_story_task_leases()
  to service_role;

commit;
