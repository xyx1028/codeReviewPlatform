-- A Worker that receives SIGTERM must not leave a valid lease behind until the
-- normal 15-minute expiry. The claim token ensures only the current holder can
-- release its own task; a late or already-committed attempt is a safe no-op.

begin;

create or replace function public.release_story_task_claim(
  p_task_id uuid,
  p_worker_id text,
  p_claim_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job_id uuid;
  v_engine text;
  v_attempt integer;
  v_ok boolean;
begin
  if p_claim_token is null then
    return false;
  end if;

  select task.job_id, job.execution_engine
    into v_job_id, v_engine
  from public.analysis_story_task task
  join public.analysis_job job on job.id = task.job_id
  where task.id = p_task_id;

  if v_job_id is null or v_engine <> 'deepseek-harness-acp' then
    return false;
  end if;

  perform pg_advisory_xact_lock(public.analysis_job_lock_key(v_job_id));

  select task.agent_attempt,
         (
           task.worker_id = p_worker_id
           and task.lease_expires_at is not null
           and task.lease_expires_at >= now()
           and task.claim_token_digest = public.agent_claim_token_digest(p_claim_token)
         )
    into v_attempt, v_ok
  from public.analysis_story_task task
  where task.id = p_task_id
  for update;

  if not coalesce(v_ok, false) then
    return false;
  end if;

  -- Keep an auditable failed run, but put the story itself back into the queue.
  -- The next claimant receives a new claim token and a higher agent_attempt.
  update public.analysis_agent_run
  set status = 'FAILED',
      error_code = 'WORKER_SHUTDOWN',
      error_message = 'worker stopped before the Agent attempt completed',
      finished_at = now()
  where task_id = p_task_id
    and agent_attempt = v_attempt
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
  where id = p_task_id;

  return true;
end;
$$;

revoke execute on function public.release_story_task_claim(uuid, text, uuid)
  from public, anon, authenticated;
grant execute on function public.release_story_task_claim(uuid, text, uuid)
  to service_role;

commit;
