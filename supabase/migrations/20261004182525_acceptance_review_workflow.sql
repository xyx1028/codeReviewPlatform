-- V1.43: platform-owned acceptance review and mandatory independent verification.
begin;

-- Existing jobs stay on the contract they were created with. Only new jobs default to V1.
alter table public.analysis_job add column if not exists review_workflow_version smallint not null default 0;
alter table public.analysis_job alter column review_workflow_version set default 1;
alter table public.analysis_job drop constraint if exists analysis_job_review_workflow_version_check;
alter table public.analysis_job add constraint analysis_job_review_workflow_version_check check (review_workflow_version in (0,1));
alter table public.ai_review_result add column if not exists acceptance_review jsonb;
alter table public.ai_code_evidence add column if not exists evidence_id text;
-- Independent platform roots coexist; the run's original root stays its publishing anchor.
drop index if exists public.uq_analysis_agent_node_root;
create unique index if not exists uq_analysis_agent_node_root_session
on public.analysis_agent_node(agent_run_id,session_id) where provider='root';

create table if not exists public.analysis_review_phase (
  agent_run_id uuid not null references public.analysis_agent_run(id) on delete cascade,
  phase text not null check (phase in ('EXTRACT','INVESTIGATE','VERIFY')),
  supplement_round smallint not null check (supplement_round between 0 and 1),
  root_agent_id text not null check (btrim(root_agent_id) <> ''),
  root_session_id text not null check (btrim(root_session_id) <> ''),
  result jsonb,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  primary key (agent_run_id,phase,supplement_round),
  check ((result is null) = (completed_at is null)),
  check (phase <> 'EXTRACT' or supplement_round=0)
);
alter table public.analysis_review_phase enable row level security;
revoke all on public.analysis_review_phase from public,anon,authenticated;
grant all on public.analysis_review_phase to service_role;

create or replace function public.enforce_review_workflow_version_immutable()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.review_workflow_version is distinct from old.review_workflow_version then
    raise exception 'REVIEW_WORKFLOW_VERSION_IMMUTABLE';
  end if;
  return new;
end;
$$;
drop trigger if exists review_workflow_version_immutable on public.analysis_job;
create trigger review_workflow_version_immutable before update on public.analysis_job
for each row execute function public.enforce_review_workflow_version_immutable();

-- Internal guard: serialize every phase operation on the same fenced run.
create or replace function public.assert_analysis_review_run(
  p_task_id uuid,p_worker_id text,p_claim_token uuid,p_agent_attempt integer
) returns public.analysis_agent_run language plpgsql security definer set search_path = '' as $$
declare v_task public.analysis_story_task; v_run public.analysis_agent_run;
begin
  v_task := public.assert_analysis_scope_task_claim(p_task_id,p_worker_id,p_claim_token);
  if v_task.agent_attempt is distinct from p_agent_attempt then raise exception 'TASK_LEASE_LOST'; end if;
  select * into v_run from public.analysis_agent_run where task_id=p_task_id and agent_attempt=p_agent_attempt for update;
  if v_run.id is null then raise exception 'AGENT_IDENTITY_INVALID'; end if;
  if v_run.sealed_at is not null then raise exception 'ATTEMPT_ALREADY_SEALED'; end if;
  if v_run.cancel_requested_at is not null then raise exception 'AGENT_TREE_CANCELLED'; end if;
  if not exists (select 1 from public.analysis_job where id=v_run.job_id and review_workflow_version=1) then
    raise exception 'REVIEW_WORKFLOW_VERSION_REQUIRED';
  end if;
  return v_run;
end;
$$;
revoke all on function public.assert_analysis_review_run(uuid,text,uuid,integer) from public,anon,authenticated,service_role;

create or replace function public.begin_analysis_review_phase(
  p_task_id uuid,p_worker_id text,p_claim_token uuid,p_agent_attempt integer,
  p_phase text,p_round integer,p_agent_id text,p_session_id text
) returns void language plpgsql security definer set search_path = '' as $$
declare v_run public.analysis_agent_run; v_existing public.analysis_review_phase; v_previous public.analysis_review_phase;
begin
  v_run := public.assert_analysis_review_run(p_task_id,p_worker_id,p_claim_token,p_agent_attempt);
  if p_phase is null or p_phase not in ('EXTRACT','INVESTIGATE','VERIFY') or p_round is null or p_round not between 0 and 1
     or coalesce(btrim(p_agent_id),'')='' or coalesce(btrim(p_session_id),'')='' then raise exception 'REVIEW_PHASE_INVALID'; end if;
  select * into v_existing from public.analysis_review_phase where agent_run_id=v_run.id and phase=p_phase and supplement_round=p_round;
  if v_existing.agent_run_id is not null then
    if v_existing.root_agent_id is distinct from p_agent_id or v_existing.root_session_id is distinct from p_session_id then raise exception 'REVIEW_PHASE_IDENTITY_MISMATCH'; end if;
    return;
  end if;
  if exists(select 1 from public.analysis_review_phase where agent_run_id=v_run.id and completed_at is null) then raise exception 'REVIEW_PHASE_STILL_RUNNING'; end if;
  if p_phase='EXTRACT' then
    if p_round<>0 or exists(select 1 from public.analysis_review_phase where agent_run_id=v_run.id) then raise exception 'REVIEW_PHASE_ORDER_INVALID'; end if;
  elsif p_phase='INVESTIGATE' then
    select * into v_previous from public.analysis_review_phase where agent_run_id=v_run.id
      and phase=case when p_round=0 then 'EXTRACT' else 'VERIFY' end and supplement_round=case when p_round=0 then 0 else p_round-1 end;
    if v_previous.completed_at is null then raise exception 'REVIEW_PHASE_ORDER_INVALID'; end if;
  else
    select * into v_previous from public.analysis_review_phase where agent_run_id=v_run.id and phase='INVESTIGATE' and supplement_round=p_round;
    if v_previous.completed_at is null then raise exception 'REVIEW_PHASE_ORDER_INVALID'; end if;
    if p_agent_id=v_previous.root_agent_id or p_session_id=v_previous.root_session_id
       or p_agent_id=v_run.root_agent_id or p_session_id=v_run.root_session_id
       or exists(select 1 from public.analysis_review_phase where agent_run_id=v_run.id and phase='VERIFY' and (root_agent_id=p_agent_id or root_session_id=p_session_id)) then
      raise exception 'REVIEW_INDEPENDENT_ROOT_REQUIRED';
    end if;
  end if;
  if p_phase<>'VERIFY' and (p_agent_id is distinct from v_run.root_agent_id or p_session_id is distinct from v_run.root_session_id) then raise exception 'REVIEW_PHASE_IDENTITY_MISMATCH'; end if;
  insert into public.analysis_review_phase(agent_run_id,phase,supplement_round,root_agent_id,root_session_id)
  values(v_run.id,p_phase,p_round,p_agent_id,p_session_id);
end;
$$;

create or replace function public.save_analysis_review_phase(
  p_task_id uuid,p_worker_id text,p_claim_token uuid,p_agent_attempt integer,
  p_phase text,p_round integer,p_agent_id text,p_result jsonb
) returns void language plpgsql security definer set search_path = '' as $$
declare v_run public.analysis_agent_run; v_phase public.analysis_review_phase; v_points jsonb; v_item jsonb; v_id text; v_count integer;
begin
  v_run := public.assert_analysis_review_run(p_task_id,p_worker_id,p_claim_token,p_agent_attempt);
  select * into v_phase from public.analysis_review_phase where agent_run_id=v_run.id and phase=p_phase and supplement_round=p_round for update;
  if v_phase.agent_run_id is null or v_phase.root_agent_id is distinct from p_agent_id then raise exception 'REVIEW_PHASE_IDENTITY_MISMATCH'; end if;
  if v_phase.completed_at is not null then
    if v_phase.result is distinct from p_result then raise exception 'REVIEW_PHASE_ALREADY_SUBMITTED'; end if;
    return;
  end if;
  if p_phase='EXTRACT' then
    if jsonb_typeof(p_result) is distinct from 'array' then raise exception 'REVIEW_CRITERIA_INVALID'; end if;
    v_count:=jsonb_array_length(p_result);
    if v_count not between 1 and 64 then raise exception 'REVIEW_CRITERIA_INVALID'; end if;
    for v_item in select value from jsonb_array_elements(p_result) with ordinality items(value,n)
      where value->>'id' is distinct from 'C'||n::text or coalesce(btrim(value->>'description'),'')=''
        or jsonb_typeof(value->'needsClarification') is distinct from 'boolean'
        or jsonb_typeof(value->'sources') is distinct from 'array'
    loop raise exception 'REVIEW_CRITERIA_INVALID'; end loop;
    if exists(select 1 from jsonb_array_elements(p_result) where jsonb_array_length(value->'sources')=0) then raise exception 'REVIEW_CRITERIA_INVALID'; end if;
  else
    select result into v_points from public.analysis_review_phase where agent_run_id=v_run.id and phase='EXTRACT' and supplement_round=0 and completed_at is not null;
    if jsonb_typeof(p_result) is distinct from 'object' or p_result->>'agentId' is distinct from p_agent_id
       or jsonb_typeof(p_result#>'{report,findings}') is distinct from 'array'
       or jsonb_typeof(p_result#>'{report,risks}') is distinct from 'array'
       or jsonb_typeof(p_result->'evidence') is distinct from 'array' then raise exception 'REVIEW_PHASE_RESULT_INVALID'; end if;
    if jsonb_array_length(p_result#>'{report,findings}')<>jsonb_array_length(v_points) then raise exception 'REVIEW_CRITERIA_COVERAGE_INVALID'; end if;
    select count(distinct value->>'criterionId') into v_count from jsonb_array_elements(p_result#>'{report,findings}');
    if v_count<>jsonb_array_length(v_points) then raise exception 'REVIEW_CRITERIA_COVERAGE_INVALID'; end if;
    for v_item in select value from jsonb_array_elements(p_result#>'{report,findings}') loop
      v_id:=v_item->>'criterionId';
      if not exists(select 1 from jsonb_array_elements(v_points) where value->>'id'=v_id)
         or coalesce(v_item->>'verdict','') not in ('IMPLEMENTED','PARTIAL','NOT_IMPLEMENTED','UNCERTAIN')
         or coalesce(btrim(v_item->>'reason'),'')=''
         or jsonb_typeof(v_item->'evidenceIds') is distinct from 'array' then raise exception 'REVIEW_CRITERIA_COVERAGE_INVALID'; end if;
      if v_item->>'verdict'<>'UNCERTAIN' and exists(select 1 from jsonb_array_elements(v_points) where value->>'id'=v_id and value->>'needsClarification'='true') then raise exception 'REVIEW_CRITERIA_CLARIFICATION_REQUIRED'; end if;
      if exists(select 1 from jsonb_array_elements_text(v_item->'evidenceIds') refs(id) where not exists(select 1 from jsonb_array_elements(p_result->'evidence') where value->>'evidenceId'=refs.id)) then raise exception 'REVIEW_EVIDENCE_BINDING_INVALID'; end if;
      if v_item->>'verdict' in ('IMPLEMENTED','PARTIAL') and not exists(select 1 from jsonb_array_elements(p_result->'evidence') where value->>'evidenceType'='现有实现' and v_item->'evidenceIds' ? (value->>'evidenceId')) then raise exception 'REVIEW_IMPLEMENTATION_EVIDENCE_REQUIRED'; end if;
    end loop;
    if jsonb_array_length(p_result#>'{report,risks}')>64 or
       (select count(distinct value->>'id') from jsonb_array_elements(p_result#>'{report,risks}'))<>jsonb_array_length(p_result#>'{report,risks}') then raise exception 'REVIEW_RISK_INVALID'; end if;
    for v_item in select value from jsonb_array_elements(p_result#>'{report,risks}') loop
      if coalesce(btrim(v_item->>'id'),'')='' or coalesce(btrim(v_item->>'title'),'')=''
         or coalesce(btrim(v_item->>'trigger'),'')='' or coalesce(btrim(v_item->>'impact'),'')=''
         or coalesce(v_item->>'certainty','') not in ('CONFIRMED','SUSPECTED')
         or coalesce(v_item->>'origin','') not in ('INTRODUCED','MISSING_SCENARIO','EXISTING','UNKNOWN')
         or jsonb_typeof(v_item->'criterionIds') is distinct from 'array'
         or jsonb_typeof(v_item->'evidenceIds') is distinct from 'array' then raise exception 'REVIEW_RISK_INVALID'; end if;
      if exists(select 1 from jsonb_array_elements_text(v_item->'criterionIds') refs(id) where not exists(select 1 from jsonb_array_elements(v_points) where value->>'id'=refs.id)) then raise exception 'REVIEW_RISK_INVALID'; end if;
      if exists(select 1 from jsonb_array_elements_text(v_item->'evidenceIds') refs(id) where not exists(select 1 from jsonb_array_elements(p_result->'evidence') where value->>'evidenceId'=refs.id)) then raise exception 'REVIEW_EVIDENCE_BINDING_INVALID'; end if;
      if v_item->>'certainty'='CONFIRMED' and jsonb_array_length(v_item->'evidenceIds')=0 then raise exception 'REVIEW_RISK_INVALID'; end if;
    end loop;
  end if;
  update public.analysis_review_phase set result=p_result,completed_at=now() where agent_run_id=v_run.id and phase=p_phase and supplement_round=p_round;
end;
$$;
revoke all on function public.begin_analysis_review_phase(uuid,text,uuid,integer,text,integer,text,text) from public,anon,authenticated;
grant execute on function public.begin_analysis_review_phase(uuid,text,uuid,integer,text,integer,text,text) to service_role;
revoke all on function public.save_analysis_review_phase(uuid,text,uuid,integer,text,integer,text,jsonb) from public,anon,authenticated;
grant execute on function public.save_analysis_review_phase(uuid,text,uuid,integer,text,integer,text,jsonb) to service_role;

-- Patch existing canonical writers in place: preserve all current scope/claim gates.
create or replace function pg_temp.patch_review_function(p_signature text,p_old text,p_new text)
returns void language plpgsql as $$
declare v_sql text; v_old text; v_new text;
begin
  -- Dashboard-applied functions may retain CRLF, while repository SQL uses LF.
  -- Normalize both the function source and anchors before matching; keep the
  -- missing-target guard so an unexpected function version still fails closed.
  v_sql:=replace(pg_get_functiondef(p_signature::regprocedure),chr(13)||chr(10),chr(10));
  v_old:=replace(p_old,chr(13)||chr(10),chr(10));
  v_new:=replace(p_new,chr(13)||chr(10),chr(10));
  if strpos(v_sql,v_new)>0 then return; end if;
  if strpos(v_sql,v_old)=0 then raise exception 'V143 patch target missing: %',p_signature; end if;
  execute replace(v_sql,v_old,v_new);
end;
$$;

select pg_temp.patch_review_function('public.claim_next_story_task(text,integer)',
  $old$'analysis_context_version',v_job.analysis_context_version,$old$,
  $new$'analysis_context_version',v_job.analysis_context_version,
      'review_workflow_version',v_job.review_workflow_version,$new$);
select pg_temp.patch_review_function('public.claim_next_story_task(text,integer)',
  $old$and task.agent_status not in ('SUCCEEDED','FAILED')$old$,
  $new$and task.agent_status not in ('SUCCEEDED','FAILED')
    and (job.review_workflow_version=0 or exists (
      select 1 from public.analysis_worker_heartbeat review_worker
      where review_worker.worker_id=p_worker_id and review_worker.capabilities->>'acceptanceReviewWorkflowVersion'='1'
    ))$new$);

select pg_temp.patch_review_function('public.register_analysis_agent_node(uuid,text,uuid,integer,text,text,text,text,text,text)',
  $old$or v_run.root_agent_id <> p_agent_id
       or v_run.root_session_id <> p_session_id$old$,
  $new$or ((v_run.root_agent_id <> p_agent_id or v_run.root_session_id <> p_session_id)
         and not exists(select 1 from public.analysis_review_phase phase
           where phase.agent_run_id=v_run.id and phase.phase='VERIFY' and phase.completed_at is null
             and phase.root_agent_id=p_agent_id and phase.root_session_id=p_session_id))
       or p_parent_agent_id is not null or p_agent_role <> 'root-reviewer'$new$);
select pg_temp.patch_review_function('public.register_analysis_agent_node(uuid,text,uuid,integer,text,text,text,text,text,text)',
  $old$and p_provider <> 'root'$old$,
  $new$and not exists(select 1 from public.analysis_agent_node where agent_run_id=v_run.id and agent_id=p_agent_id)$new$);
select pg_temp.patch_review_function('public.register_analysis_agent_node(uuid,text,uuid,integer,text,text,text,text,text,text)',
  $old$root_agent_id = case when p_provider = 'root' then p_agent_id else root_agent_id end,
      root_session_id = case when p_provider = 'root' then p_session_id else root_session_id end$old$,
  $new$root_agent_id = coalesce(root_agent_id,p_agent_id),
      root_session_id = coalesce(root_session_id,p_session_id)$new$);
select pg_temp.patch_review_function('public.save_agent_review_result_v111_internal(uuid,text,uuid,integer,jsonb,jsonb,jsonb,text,text,text)',
  $old$where agent_run_id = v_run.id and provider = 'root';$old$,
  $new$where agent_run_id = v_run.id and provider = 'root' and agent_id = v_run.root_agent_id;$new$);

-- Final gate is a separate internal function so the public writer remains the only publishing RPC.
select pg_temp.patch_review_function('public.claim_job_for_preparation(text,integer)',
  $old$where job.execution_engine='deepseek-harness-acp'$old$,
  $new$where job.execution_engine='deepseek-harness-acp'
    and (job.review_workflow_version=0 or exists (
      select 1 from public.analysis_worker_heartbeat review_worker
      where review_worker.worker_id=p_worker_id and review_worker.capabilities->>'acceptanceReviewWorkflowVersion'='1'
    ))$new$);
select pg_temp.patch_review_function('public.claim_job_for_finalization(text,integer)',
  $old$where job.execution_engine = 'deepseek-harness-acp'$old$,
  $new$where job.execution_engine = 'deepseek-harness-acp'
    and (job.review_workflow_version=0 or exists (
      select 1 from public.analysis_worker_heartbeat review_worker
      where review_worker.worker_id=p_worker_id and review_worker.capabilities->>'acceptanceReviewWorkflowVersion'='1'
    ))$new$);

create or replace function public.assert_acceptance_review_final(p_task_id uuid,p_agent_attempt integer,p_result jsonb,p_evidence jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare v_run public.analysis_agent_run; v_version integer; v_extract public.analysis_review_phase; v_investigate public.analysis_review_phase; v_verify public.analysis_review_phase;
  v_report jsonb; v_round integer; v_point jsonb; v_first jsonb; v_second jsonb; v_final jsonb; v_item jsonb; v_id text;
  v_disagrees boolean:=false; v_ref text; v_root text; v_expected jsonb;
begin
  select * into v_run from public.analysis_agent_run where task_id=p_task_id and agent_attempt=p_agent_attempt;
  select review_workflow_version into v_version from public.analysis_job where id=v_run.job_id;
  if v_version=0 then
    if p_result->'acceptanceReview' is not null and p_result->'acceptanceReview'<>'null'::jsonb then raise exception 'REVIEW_WORKFLOW_VERSION_REQUIRED'; end if;
    return;
  end if;
  v_report:=p_result->'acceptanceReview';
  if v_version is distinct from 1 or jsonb_typeof(v_report) is distinct from 'object' or v_report->>'version' is distinct from '1'
     or coalesce(v_report->>'supplementRounds','') not in ('0','1') then raise exception 'REVIEW_INDEPENDENT_VERIFICATION_REQUIRED'; end if;
  v_round:=(v_report->>'supplementRounds')::integer;
  select * into v_extract from public.analysis_review_phase where agent_run_id=v_run.id and phase='EXTRACT' and supplement_round=0;
  select * into v_investigate from public.analysis_review_phase where agent_run_id=v_run.id and phase='INVESTIGATE' and supplement_round=v_round;
  select * into v_verify from public.analysis_review_phase where agent_run_id=v_run.id and phase='VERIFY' and supplement_round=v_round;
  if v_extract.completed_at is null or v_investigate.completed_at is null or v_verify.completed_at is null
     or exists(select 1 from public.analysis_review_phase where agent_run_id=v_run.id and (completed_at is null or supplement_round>v_round))
     or v_verify.root_agent_id=v_investigate.root_agent_id or v_verify.root_session_id=v_investigate.root_session_id
     or v_report#>>'{verification,investigationAgentId}' is distinct from v_investigate.root_agent_id
     or v_report#>>'{verification,verificationAgentId}' is distinct from v_verify.root_agent_id
     or v_report->'criteria' is distinct from v_extract.result then raise exception 'REVIEW_INDEPENDENT_VERIFICATION_REQUIRED'; end if;
  if jsonb_typeof(v_report->'findings') is distinct from 'array' or jsonb_typeof(v_report->'risks') is distinct from 'array' then raise exception 'REVIEW_FINAL_INVALID'; end if;
  if jsonb_array_length(v_report->'findings')<>jsonb_array_length(v_extract.result)
     or (select count(distinct value->>'criterionId') from jsonb_array_elements(v_report->'findings'))<>jsonb_array_length(v_extract.result) then raise exception 'REVIEW_CRITERIA_COVERAGE_INVALID'; end if;
  for v_point in select value from jsonb_array_elements(v_extract.result) loop
    v_id:=v_point->>'id';
    select value into v_first from jsonb_array_elements(v_investigate.result#>'{report,findings}') where value->>'criterionId'=v_id;
    select value into v_second from jsonb_array_elements(v_verify.result#>'{report,findings}') where value->>'criterionId'=v_id;
    select value into v_final from jsonb_array_elements(v_report->'findings') where value->>'criterionId'=v_id;
    if v_final is null or v_final->>'verdict' is distinct from (case when v_first->>'verdict'=v_second->>'verdict' then v_second->>'verdict' else 'UNCERTAIN' end)
       or jsonb_typeof(v_final->'evidenceIds') is distinct from 'array' then raise exception 'REVIEW_FINAL_VERDICT_INVALID'; end if;
    if v_first->>'verdict'<>v_second->>'verdict' and (
       v_final#>>'{disagreement,investigationVerdict}' is distinct from v_first->>'verdict'
       or v_final#>>'{disagreement,reviewVerdict}' is distinct from v_second->>'verdict') then raise exception 'REVIEW_DISAGREEMENT_MUST_BE_RETAINED'; end if;
    v_disagrees:=v_disagrees or v_first->>'verdict'<>v_second->>'verdict';
    v_expected:=case when v_first->>'verdict'=v_second->>'verdict' then v_second->'evidenceIds'
      else (select coalesce(jsonb_agg(distinct ref),'[]') from jsonb_array_elements(v_first->'evidenceIds'||(v_second->'evidenceIds')) refs(ref)) end;
    if not ((v_final->'evidenceIds') @> v_expected and v_expected @> (v_final->'evidenceIds')) then raise exception 'REVIEW_EVIDENCE_BINDING_INVALID'; end if;
    -- Resolve producer ancestry from trusted DB nodes, never a model-supplied role label.
    for v_ref in select value from jsonb_array_elements_text(v_second->'evidenceIds') loop
      with recursive lineage as (
        select node.* from public.analysis_agent_node node
        where node.agent_run_id=v_run.id and node.agent_id=(select value->>'producer_agent_id' from jsonb_array_elements(p_evidence) where value->>'evidence_id'=v_ref)
        union all select parent.* from public.analysis_agent_node parent join lineage child on child.parent_agent_node_id=parent.id
      ) select agent_id into v_root from lineage where parent_agent_node_id is null;
      if v_root is distinct from v_verify.root_agent_id then raise exception 'REVIEW_INDEPENDENT_EVIDENCE_REQUIRED'; end if;
    end loop;
  end loop;
  if (select count(distinct value->>'id') from jsonb_array_elements(v_report->'risks'))<>jsonb_array_length(v_report->'risks')
     or exists(select 1 from jsonb_array_elements(v_report->'risks') final_risk where not exists(
       select 1 from jsonb_array_elements((v_investigate.result#>'{report,risks}')||(v_verify.result#>'{report,risks}')) phase_risk where phase_risk->>'id'=final_risk->>'id')) then raise exception 'REVIEW_RISK_INVALID'; end if;
  for v_id in select value->>'id' from jsonb_array_elements(v_investigate.result#>'{report,risks}')
    union select value->>'id' from jsonb_array_elements(v_verify.result#>'{report,risks}') loop
    select value into v_first from jsonb_array_elements(v_investigate.result#>'{report,risks}') where value->>'id'=v_id;
    select value into v_second from jsonb_array_elements(v_verify.result#>'{report,risks}') where value->>'id'=v_id;
    select value into v_final from jsonb_array_elements(v_report->'risks') where value->>'id'=v_id;
    if v_final is null then raise exception 'REVIEW_RISK_MUST_BE_RETAINED'; end if;
    if v_first is null or v_second is null or v_first->>'certainty' is distinct from v_second->>'certainty'
       or v_first->>'origin' is distinct from v_second->>'origin'
       or not ((v_first->'criterionIds') @> (v_second->'criterionIds') and (v_second->'criterionIds') @> (v_first->'criterionIds')) then
      v_disagrees:=true;
      if v_final->>'certainty' is distinct from 'SUSPECTED' or coalesce(btrim(v_final->>'reviewNote'),'')='' then raise exception 'REVIEW_RISK_DISAGREEMENT_MUST_BE_RETAINED'; end if;
      v_expected:=coalesce(v_first->'evidenceIds','[]')||coalesce(v_second->'evidenceIds','[]');
    else
      if v_final->>'certainty' is distinct from v_second->>'certainty' then raise exception 'REVIEW_RISK_INVALID'; end if;
      v_expected:=v_second->'evidenceIds';
    end if;
    if v_final->>'origin' is distinct from coalesce(v_second->>'origin',v_first->>'origin')
       or v_final->'criterionIds' is distinct from coalesce(v_second->'criterionIds',v_first->'criterionIds')
       or jsonb_typeof(v_final->'criterionIds') is distinct from 'array'
       or jsonb_typeof(v_final->'evidenceIds') is distinct from 'array'
       or not ((v_final->'evidenceIds') @> v_expected and v_expected @> (v_final->'evidenceIds')) then raise exception 'REVIEW_RISK_INVALID'; end if;
    for v_ref in select value from jsonb_array_elements_text(coalesce(v_second->'evidenceIds','[]')) loop
      with recursive lineage as (
        select node.* from public.analysis_agent_node node
        where node.agent_run_id=v_run.id and node.agent_id=(select value->>'producer_agent_id' from jsonb_array_elements(p_evidence) where value->>'evidence_id'=v_ref)
        union all select parent.* from public.analysis_agent_node parent join lineage child on child.parent_agent_node_id=parent.id
      ) select agent_id into v_root from lineage where parent_agent_node_id is null;
      if v_root is distinct from v_verify.root_agent_id then raise exception 'REVIEW_INDEPENDENT_EVIDENCE_REQUIRED'; end if;
    end loop;
  end loop;
  if v_disagrees and v_round=0 then raise exception 'REVIEW_SUPPLEMENT_REQUIRED'; end if;
  if v_report#>>'{verification,status}' is distinct from (case when v_disagrees then 'DISAGREEMENT' else 'CONFIRMED' end) then raise exception 'REVIEW_VERIFICATION_STATUS_INVALID'; end if;
  for v_item in select value from jsonb_array_elements(v_report->'findings') union all select value from jsonb_array_elements(v_report->'risks') loop
    if jsonb_typeof(v_item->'evidenceIds') is distinct from 'array' then raise exception 'REVIEW_EVIDENCE_BINDING_INVALID'; end if;
    if exists(select 1 from jsonb_array_elements_text(v_item->'evidenceIds') refs(id) where not exists(select 1 from jsonb_array_elements(p_evidence) where value->>'evidence_id'=refs.id)) then raise exception 'REVIEW_EVIDENCE_BINDING_INVALID'; end if;
  end loop;
end;
$$;
revoke all on function public.assert_acceptance_review_final(uuid,integer,jsonb,jsonb) from public,anon,authenticated,service_role;
select pg_temp.patch_review_function('public.save_agent_review_result(uuid,text,uuid,integer,jsonb,jsonb,jsonb,text,text,text,integer,integer,text,text,text)',
  $old$v_result := public.save_agent_review_result_v111_internal($old$,
  $new$perform public.assert_acceptance_review_final(p_task_id,p_agent_attempt,p_result,p_evidence);
  v_result := public.save_agent_review_result_v111_internal($new$);

select pg_temp.patch_review_function('public.complete_analysis_job(uuid,text,jsonb,jsonb)',
  $old$if not public.is_valid_analysis_detail_items(v_result->'analysis_detail_items') then$old$,
  $new$if v_job.review_workflow_version=1 and not exists (
      select 1 from public.analysis_story_task committed_task
      where committed_task.job_id=p_job_id and committed_task.story_id=v_story_id
        and committed_task.agent_status='SUCCEEDED'
        and jsonb_typeof(committed_task.agent_output->'acceptanceReview')='object'
        and committed_task.agent_output->'acceptanceReview'=v_result->'acceptance_review'
    ) then raise exception 'REVIEW_FINAL_REPORT_MISMATCH'; end if;
    if not public.is_valid_analysis_detail_items(v_result->'analysis_detail_items') then$new$);
select pg_temp.patch_review_function('public.complete_analysis_job(uuid,text,jsonb,jsonb)',
  $old$analysis_detail_items
    ) values ($old$,
  $new$analysis_detail_items, acceptance_review
    ) values ($new$);
select pg_temp.patch_review_function('public.complete_analysis_job(uuid,text,jsonb,jsonb)',
  $old$v_result->'analysis_detail_items'
    );$old$,
  $new$v_result->'analysis_detail_items', v_result->'acceptance_review'
    );$new$);
select pg_temp.patch_review_function('public.complete_analysis_job(uuid,text,jsonb,jsonb)',
  $old$symbol_name, start_line, end_line, evidence_type, evidence_summary, description$old$,
  $new$symbol_name, start_line, end_line, evidence_type, evidence_summary, description, evidence_id$new$);
select pg_temp.patch_review_function('public.complete_analysis_job(uuid,text,jsonb,jsonb)',
  $old$v_evidence->>'description'
      );$old$,
  $new$v_evidence->>'description', v_evidence->>'evidence_id'
      );$new$);

comment on column public.ai_review_result.acceptance_review is 'V1.43 fixed acceptance points, per-point verdict/evidence and mandatory independent verification; NULL for historical reports.';
notify pgrst,'reload schema';
commit;
