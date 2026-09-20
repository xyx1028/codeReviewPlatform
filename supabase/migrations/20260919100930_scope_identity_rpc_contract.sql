-- V1.11 integration audit: make the Worker-supplied scope identity explicit at
-- the final-result and Session-checkpoint RPC boundaries. The canonical writers
-- remain the previous functions, renamed to private service internals; wrappers
-- validate after invoking them so any mismatch rolls the whole transaction back.

begin;

-- Rename the canonical 10-argument writer once. Replays keep the internal name.
do $migration$
begin
  if to_regprocedure('public.save_agent_review_result_v111_internal(uuid,text,uuid,integer,jsonb,jsonb,jsonb,text,text,text)') is null then
    if to_regprocedure('public.save_agent_review_result(uuid,text,uuid,integer,jsonb,jsonb,jsonb,text,text,text)') is null then
      raise exception 'save_agent_review_result canonical writer is missing';
    end if;
    alter function public.save_agent_review_result(
      uuid,text,uuid,integer,jsonb,jsonb,jsonb,text,text,text
    ) rename to save_agent_review_result_v111_internal;
  elsif to_regprocedure('public.save_agent_review_result(uuid,text,uuid,integer,jsonb,jsonb,jsonb,text,text,text)') is not null then
    drop function public.save_agent_review_result(
      uuid,text,uuid,integer,jsonb,jsonb,jsonb,text,text,text
    );
  end if;
end;
$migration$;

create or replace function public.save_agent_review_result(
  p_task_id uuid,
  p_worker_id text,
  p_claim_token uuid,
  p_agent_attempt integer,
  p_result jsonb,
  p_evidence jsonb,
  p_usage jsonb default '{}'::jsonb,
  p_config_hash text default null,
  p_prompt_version text default null,
  p_model_label text default null,
  p_scope_generation integer default null,
  p_triage_revision integer default null,
  p_candidate_manifest_hash text default null,
  p_analysis_scope_hash text default null,
  p_attribution_ruleset_hash text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_result jsonb;
  v_run public.analysis_agent_run;
  v_job public.analysis_job;
  v_scope public.analysis_story_scope;
begin
  -- The internal function performs all legacy claim/root/tree/session/policy,
  -- evidence and current-run N/N checks. A later exception in this wrapper rolls
  -- every one of those writes back in the same transaction.
  v_result := public.save_agent_review_result_v111_internal(
    p_task_id,p_worker_id,p_claim_token,p_agent_attempt,p_result,p_evidence,p_usage,
    p_config_hash,p_prompt_version,p_model_label
  );

  select * into v_run from public.analysis_agent_run
  where task_id=p_task_id and agent_attempt=p_agent_attempt;
  select * into v_job from public.analysis_job where id=v_run.job_id;

  if v_job.analysis_context_version=2 then
    select * into v_scope from public.analysis_story_scope
    where task_id=p_task_id and generation=v_run.scope_generation and frozen_at is not null;

    if p_scope_generation is distinct from v_run.scope_generation
       or p_triage_revision is distinct from v_run.agent_attempt
       or p_candidate_manifest_hash is distinct from v_scope.candidate_manifest_hash
       or p_analysis_scope_hash is distinct from public.analysis_agent_run_scope_hash(v_run.id)
       or p_attribution_ruleset_hash is distinct from v_run.attribution_ruleset_hash then
      raise exception 'ANALYSIS_SCOPE_IDENTITY_MISMATCH';
    end if;
  end if;

  return v_result;
end;
$$;

revoke all on function public.save_agent_review_result_v111_internal(
  uuid,text,uuid,integer,jsonb,jsonb,jsonb,text,text,text
) from public,anon,authenticated,service_role;
revoke execute on function public.save_agent_review_result(
  uuid,text,uuid,integer,jsonb,jsonb,jsonb,text,text,text,integer,integer,text,text,text
) from public,anon,authenticated;
grant execute on function public.save_agent_review_result(
  uuid,text,uuid,integer,jsonb,jsonb,jsonb,text,text,text,integer,integer,text,text,text
) to service_role;

-- Rename the canonical 14-argument checkpoint writer once.
do $migration$
begin
  if to_regprocedure('public.save_analysis_session_checkpoint_v111_internal(uuid,text,uuid,integer,text,integer,text,text,integer,text,text,text,text,bigint)') is null then
    if to_regprocedure('public.save_analysis_session_checkpoint(uuid,text,uuid,integer,text,integer,text,text,integer,text,text,text,text,bigint)') is null then
      raise exception 'save_analysis_session_checkpoint canonical writer is missing';
    end if;
    alter function public.save_analysis_session_checkpoint(
      uuid,text,uuid,integer,text,integer,text,text,integer,text,text,text,text,bigint
    ) rename to save_analysis_session_checkpoint_v111_internal;
  elsif to_regprocedure('public.save_analysis_session_checkpoint(uuid,text,uuid,integer,text,integer,text,text,integer,text,text,text,text,bigint)') is not null then
    drop function public.save_analysis_session_checkpoint(
      uuid,text,uuid,integer,text,integer,text,text,integer,text,text,text,text,bigint
    );
  end if;
end;
$migration$;

create or replace function public.save_analysis_session_checkpoint(
  p_task_id uuid,
  p_worker_id text,
  p_claim_token uuid,
  p_agent_attempt integer,
  p_session_id text,
  p_session_revision integer,
  p_storage_locator text,
  p_content_hash text,
  p_event_count integer,
  p_harness_version text,
  p_profile_hash text default null,
  p_status text default 'OPEN',
  p_skill_catalog_hash text default null,
  p_prefix_bytes bigint default null,
  p_analysis_scope_hash text default null,
  p_attribution_ruleset_hash text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_result jsonb;
  v_run public.analysis_agent_run;
  v_job public.analysis_job;
begin
  -- The internal writer first validates claim/session fencing and writes the
  -- DB-derived identities. Any explicit identity mismatch below rolls it back.
  v_result := public.save_analysis_session_checkpoint_v111_internal(
    p_task_id,p_worker_id,p_claim_token,p_agent_attempt,p_session_id,p_session_revision,
    p_storage_locator,p_content_hash,p_event_count,p_harness_version,p_profile_hash,
    p_status,p_skill_catalog_hash,p_prefix_bytes
  );

  select * into v_run from public.analysis_agent_run
  where task_id=p_task_id and agent_attempt=p_agent_attempt;
  select * into v_job from public.analysis_job where id=v_run.job_id;

  if v_job.analysis_context_version=2
     and (p_analysis_scope_hash is distinct from public.analysis_agent_run_scope_hash(v_run.id)
       or p_attribution_ruleset_hash is distinct from v_run.attribution_ruleset_hash) then
    raise exception 'SESSION_ANALYSIS_SCOPE_MISMATCH';
  end if;

  return v_result;
end;
$$;

revoke all on function public.save_analysis_session_checkpoint_v111_internal(
  uuid,text,uuid,integer,text,integer,text,text,integer,text,text,text,text,bigint
) from public,anon,authenticated,service_role;
revoke execute on function public.save_analysis_session_checkpoint(
  uuid,text,uuid,integer,text,integer,text,text,integer,text,text,text,text,bigint,text,text
) from public,anon,authenticated;
grant execute on function public.save_analysis_session_checkpoint(
  uuid,text,uuid,integer,text,integer,text,text,integer,text,text,text,text,bigint,text,text
) to service_role;

comment on function public.save_agent_review_result(
  uuid,text,uuid,integer,jsonb,jsonb,jsonb,text,text,text,integer,integer,text,text,text
) is 'Canonical result writer plus required V2 generation/revision/manifest/scope/ruleset identity fencing.';
comment on function public.save_analysis_session_checkpoint(
  uuid,text,uuid,integer,text,integer,text,text,integer,text,text,text,text,bigint,text,text
) is 'Canonical checkpoint writer plus explicit V2 Worker scope/ruleset identity fencing.';

commit;
