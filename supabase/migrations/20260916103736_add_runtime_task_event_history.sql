-- The batch console deliberately keeps only a small recent window. A selected
-- task needs an independent, cursor-paginated history so busy sibling tasks do
-- not evict its earlier Attempt / Agent / model / tool facts.

create or replace function public.get_analysis_runtime_task_events(
  p_task_id uuid,
  p_before_event_id bigint default null,
  p_limit integer default 80
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_task public.analysis_story_task;
  v_job public.analysis_job;
  v_limit integer := least(greatest(coalesce(p_limit, 80), 1), 200);
  v_events jsonb := '[]'::jsonb;
  v_next_before bigint;
  v_has_more boolean := false;
  v_total bigint := 0;
begin
  if p_task_id is null then
    raise exception 'task_id is required';
  end if;

  select * into v_task
  from public.analysis_story_task
  where id = p_task_id;

  if v_task.id is null then
    raise exception 'task not found';
  end if;

  select * into v_job
  from public.analysis_job
  where id = v_task.job_id;

  if v_job.id is null then
    raise exception 'job not found';
  end if;

  -- The browser role must be allowed to manage the owning batch. service_role
  -- is reserved for Worker / operational verification and bypasses user auth.
  if coalesce(current_setting('request.jwt.claim.role', true), '') <> 'service_role' then
    perform public.ensure_manage_review_batch(v_job.batch_id);
  end if;

  select count(*) into v_total
  from public.analysis_runtime_event event
  where event.task_id = p_task_id
    and event.scope <> 'TASK';

  with page as materialized (
    select event.*
    from public.analysis_runtime_event event
    where event.task_id = p_task_id
      and event.scope <> 'TASK'
      and (p_before_event_id is null or event.id < p_before_event_id)
    order by event.id desc
    limit v_limit + 1
  ),
  selected as (
    select page.*
    from page
    order by page.id desc
    limit v_limit
  )
  select
    coalesce(jsonb_agg(
      jsonb_build_object(
        'event_id', selected.id,
        'event_uuid', selected.event_uuid,
        'batch_id', selected.batch_id,
        'job_id', selected.job_id,
        'task_id', selected.task_id,
        'agent_run_id', selected.agent_run_id,
        'agent_node_id', selected.agent_node_id,
        'worker_id', selected.worker_id,
        'scope', selected.scope,
        'event_type', selected.event_type,
        'activity_code', selected.activity_code,
        'phase', selected.phase,
        'status', selected.status,
        'correlation_id', selected.correlation_id,
        'parent_correlation_id', selected.parent_correlation_id,
        'error_code', selected.error_code,
        'duration_ms', selected.duration_ms,
        'payload', selected.payload,
        'occurred_at', selected.occurred_at,
        'received_at', selected.received_at,
        'clock_skewed', selected.clock_skewed
      ) order by selected.id
    ), '[]'::jsonb),
    min(selected.id),
    (select count(*) > v_limit from page)
    into v_events, v_next_before, v_has_more
  from selected;

  return jsonb_build_object(
    'task_id', v_task.id,
    'batch_id', v_job.batch_id,
    'total_events', v_total,
    'events', v_events,
    'cursor', jsonb_build_object(
      'requested_before', p_before_event_id,
      'next_before_event_id', case when v_has_more then v_next_before else null end,
      'has_more', v_has_more,
      'page_size', v_limit,
      'server_time', now()
    )
  );
end;
$$;

revoke execute on function public.get_analysis_runtime_task_events(uuid, bigint, integer)
  from public, anon;
grant execute on function public.get_analysis_runtime_task_events(uuid, bigint, integer)
  to authenticated, service_role;

comment on function public.get_analysis_runtime_task_events(uuid, bigint, integer) is
  'Manage-authorized, newest-first cursor pages for one task runtime timeline.';
