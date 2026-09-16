-- Keep low-volume TASK lifecycle anchors in every full monitoring snapshot.
--
-- The console refreshes its projections with a full snapshot every 12 seconds.
-- Previously that snapshot returned only the newest 200 events across the whole
-- batch. In a busy batch, high-volume MODEL/TOOL events displaced the early
-- TASK_CLAIMED / TASK_REPOSITORIES_* rows, so the frontend no longer had enough
-- facts to build the "任务阶段" group even though those rows still existed.
--
-- Incremental cursor reads are unchanged. A full snapshot now returns the newest
-- 200 events plus every committed TASK-scope event for the batch, deduplicated by
-- id. TASK events are intentionally low-volume lifecycle anchors; detailed
-- MODEL/TOOL history remains bounded and paged exactly as before.

create or replace function public.get_analysis_runtime_console(
  p_batch_id uuid,
  p_since_event_id bigint default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_watermark bigint;
  v_batch public.review_batch;
  v_job public.analysis_job;
  v_events jsonb := '[]'::jsonb;
  v_task_ids uuid[] := array[]::uuid[];
  v_next bigint;
  v_count integer := 0;
  v_limit integer;
  v_tasks jsonb := '[]'::jsonb;
  v_lag bigint := 0;
  v_min_id bigint;
  v_requires_full boolean := false;
begin
  -- 监控台一律用 manage 语义：can_view_review_batch 只校验角色不校验归属（§6.7）。
  if coalesce(auth.role(), '') = 'service_role' then
    null;
  else
    perform public.ensure_manage_review_batch(p_batch_id);
  end if;

  select * into v_batch from public.review_batch where id = p_batch_id;
  if v_batch.id is null then
    raise exception 'batch not found';
  end if;

  select * into v_job
  from public.analysis_job
  where batch_id = p_batch_id
  order by
    case when status in ('QUEUED', 'PREPARING_CODE', 'PROCESSING', 'FINALIZING')
         then 0 else 1 end,
    created_at desc
  limit 1;

  v_watermark := pg_snapshot_xmin(pg_current_snapshot())::text::bigint;
  v_limit := case when p_since_event_id is null then 200 else 500 end;

  select coalesce(min(id), 0) into v_min_id from public.analysis_runtime_event;
  v_requires_full := p_since_event_id is not null
    and v_min_id > 0
    and p_since_event_id < v_min_id - 1;

  with eligible as (
    select event.*
    from public.analysis_runtime_event event
    where event.batch_id = p_batch_id
      and (p_since_event_id is null or event.id > p_since_event_id)
      and (
        event.xact_id < v_watermark
        -- 逃生阀：一个长事务不能把整条监控链路卡住。Reporter 单次 flush 有 10 秒硬超时。
        or event.received_at < now() - interval '30 seconds'
      )
  ),
  recent as (
    select eligible.*
    from eligible
    order by
      case when p_since_event_id is null then eligible.id end desc nulls last,
      case when p_since_event_id is not null then eligible.id end asc nulls last
    limit v_limit
  ),
  picked as (
    select recent.* from recent
    union all
    select task_event.*
    from eligible task_event
    where p_since_event_id is null
      and task_event.scope = 'TASK'
      and not exists (select 1 from recent where recent.id = task_event.id)
  )
  select
    coalesce(jsonb_agg(
      jsonb_build_object(
        'event_id', picked.id,
        'event_uuid', picked.event_uuid,
        'batch_id', picked.batch_id,
        'job_id', picked.job_id,
        'task_id', picked.task_id,
        'agent_run_id', picked.agent_run_id,
        'agent_node_id', picked.agent_node_id,
        'worker_id', picked.worker_id,
        'scope', picked.scope,
        'event_type', picked.event_type,
        'activity_code', picked.activity_code,
        'phase', picked.phase,
        'status', picked.status,
        'correlation_id', picked.correlation_id,
        'parent_correlation_id', picked.parent_correlation_id,
        'error_code', picked.error_code,
        'duration_ms', picked.duration_ms,
        'payload', picked.payload,
        'occurred_at', picked.occurred_at,
        'received_at', picked.received_at,
        'clock_skewed', picked.clock_skewed
      ) order by picked.id
    ), '[]'::jsonb),
    max(picked.id),
    count(*),
    coalesce(array_agg(distinct picked.task_id) filter (where picked.task_id is not null),
             array[]::uuid[])
    into v_events, v_next, v_count, v_task_ids
  from picked;

  if v_job.id is not null then
    select coalesce(jsonb_agg(rows.task_dto order by rows.story_code), '[]'::jsonb)
      into v_tasks
    from (
      select
        story.story_code,
        jsonb_build_object(
          'task_id', task.id,
          'story_id', story.id,
          'story_code', story.story_code,
          'story_name', story.story_name,
          'project_name', story.project_name,
          'application_name', story.application_name,
          'agent_status', task.agent_status,
          'agent_attempt', task.agent_attempt,
          'worker_id', task.worker_id,
          'lease_expires_at', task.lease_expires_at,
          'heartbeat_at', task.heartbeat_at,
          'error_code', task.error_code,
          'started_at', task.started_at,
          'finished_at', task.finished_at,
          'last_event_at', (
            select max(event.occurred_at) from public.analysis_runtime_event event
            where event.task_id = task.id
          ),
          'attempts', coalesce((
            select jsonb_agg(attempts.attempt_dto order by attempts.agent_attempt)
            from (
              select
                run.agent_attempt,
                jsonb_build_object(
                  'agent_run_id', run.id,
                  'agent_attempt', run.agent_attempt,
                  'status', run.status,
                  'worker_id', run.worker_id,
                  'model_label', run.model_label,
                  'error_code', run.error_code,
                  'started_at', run.started_at,
                  'committed_at', run.committed_at,
                  'finished_at', run.finished_at,
                  'cancel_requested_at', run.cancel_requested_at,
                  'cancel_reason', run.cancel_reason,
                  'sealed_at', run.sealed_at,
                  'session_revision', run.session_revision,
                  'attempt_phase_code', run.attempt_phase_code,
                  'attempt_phase_started_at', run.attempt_phase_started_at,
                  'agent_count', run.agent_count,
                  'max_depth_reached', run.max_depth_reached,
                  'model_requests', run.model_requests,
                  'tool_calls', run.tool_calls,
                  'input_tokens', run.input_tokens,
                  'output_tokens', run.output_tokens,
                  'resume_count', run.resume_count,
                  'agents', coalesce((
                    select jsonb_agg(agents.agent_dto
                      order by agents.delegation_depth, agents.started_at)
                    from (
                      select
                        node.delegation_depth,
                        node.started_at,
                        jsonb_build_object(
                          'agent_node_id', node.id,
                          'agent_id', node.agent_id,
                          'agent_role', node.agent_role,
                          'provider', node.provider,
                          'delegation_depth', node.delegation_depth,
                          'status', node.status,
                          'model_requests', node.model_requests,
                          'tool_calls', node.tool_calls,
                          'evidence_produced', node.evidence_produced,
                          'input_tokens', node.input_tokens,
                          'output_tokens', node.output_tokens,
                          'error_code', node.error_code,
                          'started_at', node.started_at,
                          'finished_at', node.finished_at,
                          'current_activity_scope', node.current_activity_scope,
                          'current_activity_code', node.current_activity_code,
                          'current_activity_status', node.current_activity_status,
                          'current_correlation_id', node.current_correlation_id,
                          'current_tool_name', node.current_tool_name,
                          'current_activity_started_at', node.current_activity_started_at,
                          'current_activity_updated_at', node.current_activity_updated_at,
                          'open_correlations', coalesce((
                            select jsonb_agg(jsonb_build_object(
                              'correlation_id', started.correlation_id,
                              'scope', started.scope,
                              'event_type', started.event_type,
                              'activity_code', started.activity_code,
                              'tool_name', started.payload ->> 'tool_name',
                              'model_request_kind', started.payload ->> 'model_request_kind',
                              'started_at', started.occurred_at
                            ) order by started.occurred_at)
                            from public.analysis_runtime_event started
                            where started.agent_node_id = node.id
                              and started.phase = 'STARTED'
                              and not exists (
                                select 1 from public.analysis_runtime_event terminal
                                where terminal.agent_run_id = started.agent_run_id
                                  and terminal.correlation_id = started.correlation_id
                                  and terminal.phase = 'TERMINAL'
                              )
                          ), '[]'::jsonb)
                        ) as agent_dto
                      from public.analysis_agent_node node
                      where node.agent_run_id = run.id
                    ) agents
                  ), '[]'::jsonb)
                ) as attempt_dto
              from public.analysis_agent_run run
              where run.task_id = task.id
            ) attempts
          ), '[]'::jsonb)
        ) as task_dto
      from public.analysis_story_task task
      join public.review_story story on story.id = task.story_id
      where task.job_id = v_job.id
        and (p_since_event_id is null or task.id = any (v_task_ids))
    ) rows;
  end if;

  select coalesce((extract(epoch from (now() - min(event.received_at))) * 1000)::bigint, 0)
    into v_lag
  from public.analysis_runtime_event event
  where event.batch_id = p_batch_id and event.xact_id >= v_watermark;

  return jsonb_build_object(
    'batch', jsonb_build_object(
      'batch_id', v_batch.id,
      'batch_name', v_batch.name,
      'job_id', v_job.id,
      'job_status', v_job.status,
      'total_stories', coalesce(v_job.total_stories, 0),
      'pending_stories', coalesce((
        select count(*) from public.analysis_story_task task
        where task.job_id = v_job.id and task.agent_status = 'PENDING'
      ), 0),
      'running_stories', coalesce((
        select count(*) from public.analysis_story_task task
        where task.job_id = v_job.id and task.agent_status = 'RUNNING'
      ), 0),
      'succeeded_stories', coalesce((
        select count(*) from public.analysis_story_task task
        where task.job_id = v_job.id and task.agent_status = 'SUCCEEDED'
      ), 0),
      'failed_stories', coalesce((
        select count(*) from public.analysis_story_task task
        where task.job_id = v_job.id and task.agent_status = 'FAILED'
      ), 0),
      'last_event_id', (
        select max(event.id) from public.analysis_runtime_event event
        where event.batch_id = p_batch_id
          and (event.xact_id < v_watermark
               or event.received_at < now() - interval '30 seconds')
      ),
      'last_event_at', (
        select max(event.occurred_at) from public.analysis_runtime_event event
        where event.batch_id = p_batch_id
          and (event.xact_id < v_watermark
               or event.received_at < now() - interval '30 seconds')
      )
    ),
    'tasks', v_tasks,
    'events', v_events,
    'cursor', jsonb_build_object(
      'requested_after', p_since_event_id,
      -- 只推进到本次返回中已过提交水位的最大 id，不是表内 max(id)。
      'next_event_id', coalesce(v_next, p_since_event_id),
      -- Full snapshots may contain more than v_limit rows because TASK anchors
      -- are added separately. Only incremental reads use count-based paging.
      'has_more', p_since_event_id is not null and v_count >= v_limit,
      'requires_full_snapshot', v_requires_full,
      'server_time', now(),
      'watermark_lag_ms', v_lag
    )
  );
end;
$$;

revoke execute on function public.get_analysis_runtime_console(uuid, bigint)
  from public, anon;
grant execute on function public.get_analysis_runtime_console(uuid, bigint)
  to authenticated, service_role;
