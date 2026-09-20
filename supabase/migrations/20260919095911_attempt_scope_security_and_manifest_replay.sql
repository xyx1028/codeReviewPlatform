-- V1.11 independent final-review database critical fixes.
-- Forward-only: run-scoped triage, atomic V2 final gate, scope/session continuity,
-- and idempotent generated Harness manifest replay.

begin;


create or replace function public.guard_v4_harness_manifest_replay()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing public.v4_harness_manifest;
begin
  perform pg_advisory_xact_lock(hashtext('v4_harness_manifest_insert'));
  select * into v_existing from public.v4_harness_manifest
  where manifest_revision=new.manifest_revision for update;
  if v_existing.manifest_revision is null then return new; end if;
  if v_existing.contract_version is distinct from new.contract_version
     or v_existing.harness_version is distinct from new.harness_version
     or v_existing.manifest_hash is distinct from new.manifest_hash
     or v_existing.default_policy is distinct from new.default_policy then
    raise exception 'V4_HARNESS_MANIFEST_REVISION_CONFLICT';
  end if;
  if new.is_active then
    update public.v4_harness_manifest set is_active=false
    where is_active and manifest_revision<>new.manifest_revision;
    update public.v4_harness_manifest set is_active=true
    where manifest_revision=new.manifest_revision and not is_active;
  end if;
  return null;
end;
$$;

drop trigger if exists guard_v4_harness_manifest_replay on public.v4_harness_manifest;
create trigger guard_v4_harness_manifest_replay
before insert on public.v4_harness_manifest
for each row execute function public.guard_v4_harness_manifest_replay();

create or replace function public.analysis_agent_run_scope_hash(p_agent_run_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case
    when job.analysis_context_version<>2 then null
    when run.story_input_catalog_hash is null
      or run.identity_snapshot_hash is null
      or run.repository_manifest_hash is null
      or run.selected_scope_hash is null
      or run.attribution_algorithm_version is null
      or run.attribution_ruleset_hash is null
      or run.scope_generation is null
      or story.input_hash is null
      or scope.candidate_manifest_hash is null then null
    else array_to_string(array[
      run.story_input_catalog_hash,
      run.identity_snapshot_hash,
      run.repository_manifest_hash,
      run.selected_scope_hash,
      run.attribution_algorithm_version,
      run.attribution_ruleset_hash,
      story.input_hash,
      scope.candidate_manifest_hash,
      run.scope_generation::text
    ],':')
  end
  from public.analysis_agent_run run
  join public.analysis_job job on job.id=run.job_id
  join public.analysis_story_task task on task.id=run.task_id
  left join public.analysis_job_story_snapshot story
    on story.job_id=run.job_id and story.story_id=task.story_id
  left join public.analysis_story_scope scope
    on scope.task_id=run.task_id and scope.generation=run.scope_generation
  where run.id=p_agent_run_id;
$$;

create or replace function public.claim_next_story_task(
  p_worker_id text,
  p_lease_seconds integer default 900
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_task public.analysis_story_task;
  v_job public.analysis_job;
  v_cfg public.ai_model_config;
  v_lock_key bigint;
  v_active integer;
  v_story public.review_story;
  v_token uuid;
  v_model jsonb;
  v_policy jsonb;
  v_revision integer;
  v_run public.analysis_agent_run;
  v_frozen_parallel integer;
  v_live_parallel integer;
  v_parallel integer;
  v_scope_generation integer;
begin
  if p_worker_id is null or btrim(p_worker_id)='' then raise exception 'worker_id is required'; end if;
  if p_lease_seconds is null or p_lease_seconds<30 then p_lease_seconds:=900; end if;

  perform pg_advisory_xact_lock(hashtext('claim_next_story_task'));

  select task.* into v_task
  from public.analysis_story_task task
  join public.analysis_job job on job.id=task.job_id
  where job.status='PROCESSING'
    and job.execution_engine='deepseek-harness-acp'
    and job.policy_version=4
    and (task.lease_expires_at is null or task.lease_expires_at<now())
    and task.agent_status not in ('SUCCEEDED','FAILED')
    and (
      job.analysis_context_version=1
      or exists(
        select 1 from public.analysis_worker_heartbeat heartbeat
        where heartbeat.worker_id=p_worker_id
          and heartbeat.capabilities->>'storyCommitScopeVersion' ~ '^[0-9]+$'
          and (heartbeat.capabilities->>'storyCommitScopeVersion')::integer
              >=job.required_worker_scope_version
      )
    )
  order by job.created_at,task.created_at
  for update of task skip locked
  limit 1;

  if v_task.id is null then return null; end if;

  select * into v_job from public.analysis_job where id=v_task.job_id;
  select * into v_cfg from public.ai_model_config where id=v_job.model_config_id;

  v_lock_key:=('x'||substr(md5(v_job.model_config_id::text),1,16))::bit(64)::bigint;
  perform pg_advisory_xact_lock(v_lock_key);

  select count(*) into v_active
  from public.analysis_story_task task
  join public.analysis_job job on job.id=task.job_id
  where job.model_config_id=v_job.model_config_id
    and task.lease_expires_at is not null and task.lease_expires_at>=now();

  v_frozen_parallel:=nullif(v_job.model_snapshot->>'max_parallel_tasks','')::integer;
  v_live_parallel:=v_cfg.max_parallel_tasks;
  v_parallel:=coalesce(least(
    coalesce(v_frozen_parallel,v_live_parallel),coalesce(v_live_parallel,v_frozen_parallel)
  ),4);
  if v_active>=v_parallel then return null; end if;

  v_token:=gen_random_uuid();
  update public.analysis_story_task
  set worker_id=p_worker_id,lease_expires_at=now()+make_interval(secs=>p_lease_seconds),
      heartbeat_at=now(),agent_status='RUNNING',agent_attempt=agent_attempt+1,
      claim_token_digest=public.agent_claim_token_digest(v_token),
      started_at=coalesce(started_at,now())
  where id=v_task.id
  returning * into v_task;

  v_policy:=case when v_job.capability_policy_snapshot='{}'::jsonb
    then public.build_v4_capability_policy(v_job.model_config_id)
    else v_job.capability_policy_snapshot end;

  select coalesce(max(run.session_revision),0)+1 into v_revision
  from public.analysis_agent_run run where run.task_id=v_task.id;
  select max(scope.generation) into v_scope_generation
  from public.analysis_story_scope scope where scope.task_id=v_task.id and scope.frozen_at is not null;

  insert into public.analysis_agent_run(
    task_id,job_id,agent_attempt,worker_id,status,policy_hash,session_revision,
    story_input_catalog_hash,identity_snapshot_hash,repository_manifest_hash,
    selected_scope_hash,attribution_algorithm_version,attribution_ruleset_hash,scope_generation
  ) values(
    v_task.id,v_job.id,v_task.agent_attempt,p_worker_id,'RUNNING',
    encode(sha256(v_policy::text::bytea),'hex'),v_revision,
    v_job.story_input_catalog_hash,v_job.identity_snapshot_hash,v_job.repository_manifest_hash,
    v_job.selected_scope_hash,v_job.attribution_algorithm_version,v_job.ruleset_hash,v_scope_generation
  )
  on conflict(task_id,agent_attempt) do update
  set worker_id=excluded.worker_id,status='RUNNING',started_at=now(),
      session_revision=excluded.session_revision,cancel_requested_at=null,cancel_reason=null,
      sealed_at=null,error_code=null,error_message=null,
      story_input_catalog_hash=excluded.story_input_catalog_hash,
      identity_snapshot_hash=excluded.identity_snapshot_hash,
      repository_manifest_hash=excluded.repository_manifest_hash,
      selected_scope_hash=excluded.selected_scope_hash,
      attribution_algorithm_version=excluded.attribution_algorithm_version,
      attribution_ruleset_hash=excluded.attribution_ruleset_hash,
      scope_generation=excluded.scope_generation
  returning * into v_run;

  -- Shared scope counters are only a current-attempt projection. A newly claimed
  -- attempt must start at 0/N even when a previous run completed N/N.
  if v_job.analysis_context_version=2 then
    update public.analysis_story_scope
    set triage_completed_count=0,ai_related_count=0,ai_uncertain_count=0,
        triage_complete=(triage_required_count=0),updated_at=now()
    where task_id=v_task.id and generation=v_run.scope_generation;
  end if;

  select * into v_story from public.review_story where id=v_task.story_id;

  v_model:=v_job.model_snapshot||jsonb_build_object(
    'context_window',coalesce(nullif(v_job.model_snapshot->>'context_window','')::integer,v_cfg.context_window),
    'max_output_tokens',coalesce(nullif(v_job.model_snapshot->>'max_output_tokens','')::integer,v_cfg.max_output_tokens),
    'agent_max_model_requests',coalesce(nullif(v_job.model_snapshot->>'agent_max_model_requests','')::integer,v_cfg.agent_max_model_requests),
    'agent_max_retry_requests',coalesce(nullif(v_job.model_snapshot->>'agent_max_retry_requests','')::integer,v_cfg.agent_max_retry_requests),
    'agent_max_compaction_requests',coalesce(nullif(v_job.model_snapshot->>'agent_max_compaction_requests','')::integer,v_cfg.agent_max_compaction_requests),
    'effective_max_parallel_tasks',v_parallel
  );

  return (to_jsonb(v_task)-'claim_token_digest')||jsonb_build_object(
    'claim_token',v_token,
    'agent_run_id',v_run.id,
    'session_revision',v_run.session_revision,
    'policy_version',v_job.policy_version,
    'capability_policy',v_policy,
    'policy_hash',v_run.policy_hash,
    'harness_version',v_job.harness_version,
    'capability_contract_hash',v_job.capability_contract_hash,
    'job',jsonb_build_object(
      'id',v_job.id,'batch_id',v_job.batch_id,'model_config_id',v_job.model_config_id,
      'requested_branch',v_job.requested_branch,'total_stories',v_job.total_stories,
      'policy_version',v_job.policy_version,
      'analysis_context_version',v_job.analysis_context_version,
      'commit_window_days',v_job.commit_window_days,
      'required_worker_scope_version',v_job.required_worker_scope_version,
      'story_input_catalog_hash',v_job.story_input_catalog_hash,
      'identity_snapshot_hash',v_job.identity_snapshot_hash,
      'repository_manifest_hash',v_job.repository_manifest_hash,
      'selected_scope_hash',v_job.selected_scope_hash,
      'attribution_algorithm_version',v_job.attribution_algorithm_version,
      'ruleset_hash',v_job.ruleset_hash,
      'skill_catalog_hash',v_job.skill_catalog_hash,
      'skill_snapshot_version',v_job.skill_snapshot_version
    ),
    'model',v_model,
    'snapshots',(
      select coalesce(jsonb_agg(jsonb_build_object(
        'repository_name',snapshot.repository_name,
        'requested_branch',snapshot.requested_branch,
        'commit_sha',snapshot.commit_sha,
        'commit_subject',snapshot.commit_subject
      ) order by snapshot.repository_name),'[]'::jsonb)
      from public.analysis_repository_snapshot snapshot where snapshot.job_id=v_job.id
    ),
    'story',jsonb_build_object(
      'story_id',v_story.id,'story_code',v_story.story_code,'story_name',v_story.story_name,
      'description',null,'acceptance_criteria',null,
      'project_name',v_story.project_name,'application_name',v_story.application_name,
      'source_data',v_story.source_data
    )
  );
end;
$$;

create or replace function public.get_story_task_analysis_scope(
  p_task_id uuid,p_worker_id text,p_claim_token uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_task public.analysis_story_task;
  v_run public.analysis_agent_run;
  v_scope public.analysis_story_scope;
  v_story public.analysis_job_story_snapshot;
  v_completed integer;
  v_required integer;
begin
  v_task:=public.assert_analysis_scope_task_claim(p_task_id,p_worker_id,p_claim_token);
  select * into v_run from public.analysis_agent_run
  where task_id=p_task_id and agent_attempt=v_task.agent_attempt;
  if v_run.id is null then raise exception 'AGENT_RUN_MISMATCH'; end if;
  select * into v_scope from public.analysis_story_scope
  where task_id=p_task_id and generation=v_run.scope_generation and frozen_at is not null;
  if v_scope.id is null then raise exception 'ANALYSIS_SCOPE_NOT_FROZEN'; end if;
  select snapshot.* into v_story from public.analysis_job_story_snapshot snapshot
  where snapshot.job_id=v_task.job_id and snapshot.story_id=v_task.story_id;
  if v_story.id is null then raise exception 'ANALYSIS_SCOPE_INPUTS_MISSING'; end if;

  select count(*) into v_required
  from public.analysis_story_commit_candidate candidate
  where candidate.scope_id=v_scope.id and candidate.generation=v_run.scope_generation
    and candidate.tier in ('AI_CANDIDATE','WEAK');
  select count(*) into v_completed
  from public.analysis_story_commit_relevance_verdict verdict
  join public.analysis_story_commit_candidate candidate on candidate.id=verdict.candidate_id
  where verdict.agent_run_id=v_run.id and verdict.triage_revision=v_run.agent_attempt
    and candidate.scope_id=v_scope.id and candidate.generation=v_run.scope_generation
    and candidate.tier in ('AI_CANDIDATE','WEAK');

  return jsonb_build_object(
    'task_id',p_task_id,'generation',v_scope.generation,'scope_mode',v_scope.scope_mode,
    'status',v_scope.status,'current_scope_level',v_scope.current_scope_level,
    'algorithm_version',v_scope.algorithm_version,'ruleset_hash',v_scope.ruleset_hash,
    'candidate_manifest_hash',v_scope.candidate_manifest_hash,
    'story_input_hash',v_story.input_hash,'requirement_context',v_story.requirement_context,
    'scope_error_code',v_scope.scope_error_code,'degradation_reasons',v_scope.degradation_reasons,
    'candidate_count',v_scope.candidate_count,'strong_count',v_scope.strong_count,
    'ai_candidate_count',v_scope.ai_candidate_count,'triage_revision',v_run.agent_attempt,
    'triage_required_count',v_required,'triage_completed_count',v_completed,
    'triage_complete',(v_completed=v_required),
    'candidates',coalesce((select jsonb_agg(jsonb_build_object(
      'candidate_id',candidate.id,'tier',candidate.tier,'rank_score',candidate.rank_score,
      'reason_codes',candidate.reason_codes,'repository',snapshot.repository_name,
      'commit_sha',repo_commit.sha,'short_sha',left(repo_commit.sha,12),'subject',repo_commit.subject,
      'author_name',repo_commit.author_name,'author_email_masked',repo_commit.author_email_masked,
      'committed_at',repo_commit.committed_at,'files_changed',repo_commit.files_changed,
      'additions',repo_commit.additions,'deletions',repo_commit.deletions,
      'effective_status',candidate.effective_status,'diff_status',coalesce(archive.status,'UNAVAILABLE'),
      'files',coalesce(files.items,'[]'::jsonb),'triage_verdict',verdict.verdict,
      'selected',(candidate.tier='STRONG' or coalesce(verdict.verdict in ('RELATED','UNCERTAIN'),false)),
      'selection_level',case when candidate.tier='STRONG' or coalesce(verdict.verdict in ('RELATED','UNCERTAIN'),false)
        then 'PRIMARY' else null end
    ) order by case candidate.tier when 'STRONG' then 1 when 'AI_CANDIDATE' then 2
        when 'WEAK' then 3 else 4 end,candidate.rank_score desc,candidate.id)
      from public.analysis_story_commit_candidate candidate
      join public.analysis_repository_commit repo_commit on repo_commit.id=candidate.commit_id
      join public.analysis_repository_snapshot snapshot on snapshot.id=repo_commit.snapshot_id
      left join public.analysis_commit_diff_archive archive
        on archive.commit_id=repo_commit.id and archive.job_id=v_task.job_id
      left join lateral (
        select relevance.verdict
        from public.analysis_story_commit_relevance_verdict relevance
        where relevance.agent_run_id=v_run.id and relevance.candidate_id=candidate.id
          and relevance.triage_revision=v_run.agent_attempt
        limit 1
      ) verdict on true
      left join lateral (
        select jsonb_agg(jsonb_build_object(
          'path',file.path,'old_path',file.old_path,'change_type',file.change_type,
          'additions',file.additions,'deletions',file.deletions,'is_binary',file.is_binary
        ) order by file.file_order) as items
        from public.analysis_commit_file file where file.commit_id=repo_commit.id
      ) files on true
      where candidate.scope_id=v_scope.id and candidate.generation=v_run.scope_generation),'[]'::jsonb)
  );
end;
$$;

create or replace function public.submit_story_commit_relevance_verdict(
  p_task_id uuid,p_worker_id text,p_claim_token uuid,p_agent_run_id uuid,p_candidate_id uuid,
  p_triage_revision integer,p_verdict text,p_reason_codes text[],p_confidence numeric,
  p_diff_access_ids uuid[],p_summary text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_task public.analysis_story_task;
  v_run public.analysis_agent_run;
  v_candidate public.analysis_story_commit_candidate;
  v_scope public.analysis_story_scope;
  v_existing public.analysis_story_commit_relevance_verdict;
  v_hash text; v_required integer; v_completed integer; v_related integer; v_uncertain integer;
  v_allowed text[]:=array['CODE_SEMANTIC_MATCH','MODULE_MATCH','CALL_CHAIN_MATCH','TEST_CHANGE_MATCH',
    'CONFIG_SCHEMA_MATCH','DIFFERENT_FEATURE','INSUFFICIENT_CONTEXT','DIFF_UNAVAILABLE','REVERT_OR_REPLACEMENT_UNCLEAR'];
begin
  v_task:=public.assert_analysis_scope_task_claim(p_task_id,p_worker_id,p_claim_token);
  select * into v_run from public.analysis_agent_run
  where id=p_agent_run_id and task_id=p_task_id and agent_attempt=v_task.agent_attempt for update;
  if v_run.id is null then raise exception 'AGENT_RUN_MISMATCH'; end if;
  if p_triage_revision is distinct from v_run.agent_attempt then raise exception 'TRIAGE_CONTEXT_MISMATCH'; end if;
  select * into v_candidate from public.analysis_story_commit_candidate
  where id=p_candidate_id and task_id=p_task_id and generation=v_run.scope_generation;
  if v_candidate.id is null or v_candidate.tier not in ('AI_CANDIDATE','WEAK') then
    raise exception 'CANDIDATE_NOT_AI_TRIAGE';
  end if;
  select * into v_scope from public.analysis_story_scope
  where id=v_candidate.scope_id and generation=v_run.scope_generation and frozen_at is not null;
  if v_scope.id is null then raise exception 'ANALYSIS_SCOPE_NOT_FROZEN'; end if;
  if p_verdict not in ('RELATED','UNRELATED','UNCERTAIN')
     or not (coalesce(p_reason_codes,array[]::text[]) <@ v_allowed) then raise exception 'TRIAGE_VERDICT_INVALID'; end if;
  if char_length(coalesce(p_summary,'')) not between 1 and 500 then raise exception 'TRIAGE_SUMMARY_INVALID'; end if;
  if exists(select 1 from unnest(coalesce(p_diff_access_ids,array[]::uuid[])) access_id
    where not exists(select 1 from public.analysis_story_commit_access access
      where access.id=access_id and access.task_id=p_task_id and access.candidate_id=p_candidate_id
        and access.agent_run_id=p_agent_run_id and access.access_kind='DIFF')) then
    raise exception 'DIFF_ACCESS_EVIDENCE_INVALID';
  end if;
  if cardinality(coalesce(p_diff_access_ids,array[]::uuid[]))=0
     and not ('DIFF_UNAVAILABLE'=any(p_reason_codes) or 'INSUFFICIENT_CONTEXT'=any(p_reason_codes)) then
    raise exception 'DIFF_ACCESS_REQUIRED';
  end if;
  if cardinality(coalesce(p_diff_access_ids,array[]::uuid[]))=0 and p_verdict<>'UNCERTAIN' then
    raise exception 'UNREADABLE_DIFF_REQUIRES_UNCERTAIN';
  end if;
  v_hash:=encode(digest(convert_to(concat_ws(E'\n',p_candidate_id::text,p_triage_revision::text,p_verdict,
    array_to_string(p_reason_codes,','),coalesce(p_confidence::text,''),
    array_to_string(coalesce(p_diff_access_ids,array[]::uuid[]),','),p_summary),'UTF8'),'sha256'),'hex');
  select * into v_existing from public.analysis_story_commit_relevance_verdict
  where agent_run_id=p_agent_run_id and candidate_id=p_candidate_id and triage_revision=p_triage_revision;
  if v_existing.id is not null then
    if v_existing.payload_hash<>v_hash then raise exception 'TRIAGE_VERDICT_CONFLICT'; end if;
  else
    insert into public.analysis_story_commit_relevance_verdict(
      task_id,candidate_id,agent_run_id,triage_revision,verdict,reason_codes,confidence,diff_access_ids,summary,payload_hash
    ) values(p_task_id,p_candidate_id,p_agent_run_id,p_triage_revision,p_verdict,p_reason_codes,p_confidence,
      coalesce(p_diff_access_ids,array[]::uuid[]),p_summary,v_hash);
    insert into public.analysis_scope_decision_audit(
      job_id,task_id,candidate_id,decision_type,source,agent_run_id,reason_codes,after_state
    ) values(v_task.job_id,p_task_id,p_candidate_id,'AI_RELEVANCE','AI',p_agent_run_id,p_reason_codes,
      jsonb_build_object('verdict',p_verdict,'triage_revision',p_triage_revision,'generation',v_run.scope_generation));
  end if;
  select count(*) into v_required from public.analysis_story_commit_candidate candidate
  where candidate.scope_id=v_scope.id and candidate.generation=v_run.scope_generation
    and candidate.tier in ('AI_CANDIDATE','WEAK');
  select count(*),count(*) filter(where relevance.verdict='RELATED'),
    count(*) filter(where relevance.verdict='UNCERTAIN')
  into v_completed,v_related,v_uncertain
  from public.analysis_story_commit_relevance_verdict relevance
  join public.analysis_story_commit_candidate candidate on candidate.id=relevance.candidate_id
  where relevance.agent_run_id=v_run.id and relevance.triage_revision=v_run.agent_attempt
    and candidate.scope_id=v_scope.id and candidate.generation=v_run.scope_generation
    and candidate.tier in ('AI_CANDIDATE','WEAK');
  update public.analysis_story_scope set triage_completed_count=v_completed,ai_related_count=v_related,
    ai_uncertain_count=v_uncertain,triage_complete=(v_completed=v_required),updated_at=now()
  where id=v_scope.id;
  return jsonb_build_object('completed_count',v_completed,'required_count',v_required,
    'triage_complete',v_completed=v_required,'generation',v_run.scope_generation,
    'triage_revision',v_run.agent_attempt);
end;
$$;

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
  p_prefix_bytes bigint default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run public.analysis_agent_run;
  v_retention integer;
  v_id uuid;
begin
  select run.* into v_run
  from public.analysis_agent_run run
  join public.analysis_story_task task on task.id = run.task_id
  where run.task_id = p_task_id
    and run.agent_attempt = p_agent_attempt
    and task.worker_id = p_worker_id
    and task.lease_expires_at is not null
    and task.lease_expires_at >= now()
    and p_claim_token is not null
    and task.claim_token_digest = public.agent_claim_token_digest(p_claim_token)
  for update of run;

  if v_run.id is null then
    raise exception 'TASK_LEASE_LOST';
  end if;
  -- fencing：revision 只能前进。落后的写入来自被接管的旧 Worker。
  if p_session_revision < v_run.session_revision then
    raise exception 'SESSION_FENCED';
  end if;

  select coalesce((job.capability_policy_snapshot #>> '{session,retentionDays}')::integer, 7)
  into v_retention
  from public.analysis_job job where job.id = v_run.job_id;

  insert into public.analysis_session_checkpoint (
    agent_run_id, session_id, session_revision, storage_locator, content_hash,
    event_count, harness_version, profile_hash, status, retention_until,
    skill_catalog_hash, prefix_bytes, analysis_scope_hash, attribution_ruleset_hash
  ) values (
    v_run.id, p_session_id, p_session_revision, p_storage_locator, p_content_hash,
    greatest(coalesce(p_event_count, 0), 0), p_harness_version, p_profile_hash,
    coalesce(p_status, 'OPEN'), now() + make_interval(days => v_retention),
    p_skill_catalog_hash, p_prefix_bytes,
    public.analysis_agent_run_scope_hash(v_run.id), v_run.attribution_ruleset_hash
  )
  on conflict (session_id, session_revision) do update
  set storage_locator = excluded.storage_locator,
      content_hash = excluded.content_hash,
      event_count = excluded.event_count,
      status = excluded.status,
      retention_until = excluded.retention_until,
      skill_catalog_hash = coalesce(excluded.skill_catalog_hash, public.analysis_session_checkpoint.skill_catalog_hash),
      analysis_scope_hash = excluded.analysis_scope_hash,
      attribution_ruleset_hash = excluded.attribution_ruleset_hash,
      -- 周期 checkpoint 会反复覆盖同一行：前缀只会变长，绝不回退。
      prefix_bytes = excluded.prefix_bytes
  returning id into v_id;

  update public.analysis_agent_run
  set session_revision = greatest(session_revision, p_session_revision),
      last_checkpoint_at = now()
  where id = v_run.id;

  return jsonb_build_object('checkpoint_id', v_id, 'session_revision', p_session_revision);
end;
$$;

create or replace function public.load_resumable_analysis_attempt(
  p_task_id uuid,
  p_worker_id text,
  p_claim_token uuid,
  p_allow_cross_attempt boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_task public.analysis_story_task;
  v_run public.analysis_agent_run;
  v_job public.analysis_job;
  v_candidate record;
  v_revision integer;
  v_resume_count integer;
  v_cross boolean := coalesce(p_allow_cross_attempt, false);
begin
  select * into v_task from public.analysis_story_task where id = p_task_id;
  if v_task.id is null then
    return null;
  end if;
  -- claim 四要素校验：只有当前持有者能问"我能不能接着上一次跑"。
  if v_task.worker_id is distinct from p_worker_id
     or p_claim_token is null
     or v_task.claim_token_digest is distinct from public.agent_claim_token_digest(p_claim_token) then
    return null;
  end if;
  -- 已成功的 task 不存在"继续"，只存在"重复提交"。
  if v_task.agent_status = 'SUCCEEDED' then
    return null;
  end if;

  select * into v_run from public.analysis_agent_run
  where task_id = p_task_id and agent_attempt = v_task.agent_attempt
  for update;
  if v_run.id is null
     or v_run.status = 'COMMITTED'
     or v_run.sealed_at is not null
     or v_run.cancel_requested_at is not null then
    return null;
  end if;

  -- 这个 task 的任何一次 attempt 提交过结果 → 绝不恢复。
  if exists (
    select 1 from public.analysis_agent_run run
    where run.task_id = p_task_id and run.status = 'COMMITTED'
  ) then
    return null;
  end if;

  select * into v_job from public.analysis_job where id = v_run.job_id;
  if coalesce((v_job.capability_policy_snapshot #>> '{session,resumeOnWorkerRestart}')::boolean, true)
     is not true then
    return null;
  end if;

  /*
   * 候选 = 这个 task 里最新的一条可用 checkpoint。
   *
   * `v_cross` 为假时退回迁移前的语义：只看当前 attempt 自己的 run。那条路径专门留给
   * 尚未升级的 Worker —— 它们的拒绝是 fail closed，不能让它们看到历史候选。
   */
  select cp.session_id,
         cp.session_revision,
         cp.storage_locator,
         cp.content_hash,
         cp.prefix_bytes,
         cp.harness_version,
         cp.profile_hash,
         cp.skill_catalog_hash,
         cp.analysis_scope_hash,
         cp.attribution_ruleset_hash,
         source_run.id as source_run_id,
         source_run.agent_attempt as source_agent_attempt,
         source_run.policy_hash as source_policy_hash,
         source_run.root_agent_id as source_root_agent_id,
         source_run.root_session_id as source_root_session_id,
         source_run.resume_count as source_resume_count
    into v_candidate
  from public.analysis_session_checkpoint cp
  join public.analysis_agent_run source_run on source_run.id = cp.agent_run_id
  where source_run.task_id = p_task_id
    and source_run.status <> 'COMMITTED'
    and cp.status in ('OPEN', 'SEALED')
    and (v_cross or source_run.agent_attempt = v_task.agent_attempt)
  order by cp.session_revision desc, cp.created_at desc
  limit 1;

  if v_candidate.session_id is null then
    return null;
  end if;

  -- Scope continuity is the first independent recovery gate. profile_hash is
  -- still returned below and remains the Worker's second, stricter gate.
  if v_job.analysis_context_version=2
     and (v_candidate.analysis_scope_hash is distinct from public.analysis_agent_run_scope_hash(v_run.id)
       or v_candidate.attribution_ruleset_hash is distinct from v_run.attribution_ruleset_hash) then
    raise exception 'SESSION_ANALYSIS_SCOPE_MISMATCH';
  end if;

  -- fencing revision：既要超过当前 run 的水位，也要超过 checkpoint 的水位。
  v_revision := greatest(v_run.session_revision, v_candidate.session_revision + 1);
  -- 恢复次数沿 attempt 链累加，Worker 侧据此判上限（MAX_SESSION_RESUMES）。
  v_resume_count := coalesce(v_candidate.source_resume_count, 0) + 1;

  update public.analysis_agent_run
  set resume_count = v_resume_count,
      session_revision = v_revision,
      -- 恢复的是同一个会话，所以 root 身份沿用被恢复 attempt 的那一份；缺失时留空，
      -- 由 record_analysis_attempt_profile 在物化 profile 后写入。
      root_agent_id = coalesce(root_agent_id, v_candidate.source_root_agent_id),
      root_session_id = coalesce(root_session_id, v_candidate.source_root_session_id)
  where id = v_run.id;

  return jsonb_build_object(
    'agent_run_id', v_run.id,
    'root_session_id', coalesce(v_run.root_session_id, v_candidate.source_root_session_id),
    'root_agent_id', coalesce(v_run.root_agent_id, v_candidate.source_root_agent_id),
    'session_id', v_candidate.session_id,
    'session_revision', v_revision,
    'storage_locator', v_candidate.storage_locator,
    'content_hash', v_candidate.content_hash,
    'prefix_bytes', v_candidate.prefix_bytes,
    'harness_version', v_candidate.harness_version,
    'profile_hash', v_candidate.profile_hash,
    'analysis_scope_hash', v_candidate.analysis_scope_hash,
    'attribution_ruleset_hash', v_candidate.attribution_ruleset_hash,
    -- policy hash 取被恢复 attempt 的那一份：门禁比的是"这段历史是在哪套 policy 下产生的"。
    'policy_hash', coalesce(v_candidate.source_policy_hash, v_run.policy_hash),
    'skill_catalog_hash', v_candidate.skill_catalog_hash,
    'job_skill_catalog_hash', v_job.skill_catalog_hash,
    'resume_count', v_resume_count,
    -- Worker 用它派生 Session 目录 / Workspace 目录 / root agent id，
    -- 从而让本次 attempt 的 profile hash 与 checkpoint 里记的那份一致。
    'source_agent_attempt', v_candidate.source_agent_attempt,
    'source_agent_run_id', v_candidate.source_run_id
  );
end;
$$;

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
  p_model_label text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_task public.analysis_story_task;
  v_job public.analysis_job;
  v_run public.analysis_agent_run;
  v_run_id uuid;
  v_root public.analysis_agent_node;
  v_evidence jsonb;
  v_producer uuid;
  v_committed_at timestamptz;
  v_root_agent_id text := nullif(p_usage->>'root_agent_id', '');
  v_root_session_id text := nullif(p_usage->>'root_session_id', '');
  v_tree_digest text := nullif(p_usage->>'tree_digest', '');
  v_db_tree_digest text;
  v_session_revision integer := nullif(p_usage->>'session_revision', '')::integer;
  v_policy_hash text := nullif(p_usage->>'policy_hash', '');
  v_scope public.analysis_story_scope;
  v_triage_required integer;
  v_triage_completed integer;
begin
  select * into v_task from public.analysis_story_task where id = p_task_id for update;
  if v_task.id is null then
    raise exception 'task not found';
  end if;

  select * into v_job from public.analysis_job where id = v_task.job_id for update;
  if v_job.execution_engine <> 'deepseek-harness-acp' then
    raise exception 'LEGACY_ENGINE_RETIRED';
  end if;
  if v_job.status <> 'PROCESSING' then
    raise exception 'job is not processing';
  end if;
  if v_task.worker_id is distinct from p_worker_id
     or v_task.lease_expires_at is null
     or v_task.lease_expires_at < now() then
    raise exception 'TASK_LEASE_LOST';
  end if;
  if p_claim_token is null
     or v_task.claim_token_digest is distinct from public.agent_claim_token_digest(p_claim_token)
     or p_agent_attempt is distinct from v_task.agent_attempt then
    raise exception 'AGENT_CLAIM_INVALID';
  end if;
  if jsonb_typeof(p_result) <> 'object' then
    raise exception 'result must be an object';
  end if;
  if exists (
    select 1 from public.analysis_agent_run
    where task_id = p_task_id and status = 'COMMITTED'
  ) then
    raise exception 'AGENT_RESULT_ALREADY_COMMITTED';
  end if;

  select * into v_run from public.analysis_agent_run
  where task_id = p_task_id and agent_attempt = p_agent_attempt
  for update;

  -- V4 的数据库层独立、完整地强制 root-only 与 fencing；任何可信元数据缺失都
  -- fail closed，不能依赖 Worker“记得传”。
  if v_job.policy_version = 4 then
    if v_run.id is null then
      raise exception 'AGENT_IDENTITY_INVALID';
    end if;
    if v_run.sealed_at is not null then
      raise exception 'ATTEMPT_ALREADY_SEALED';
    end if;
    if v_run.cancel_requested_at is not null then
      raise exception 'AGENT_TREE_CANCELLED';
    end if;

    select * into v_root from public.analysis_agent_node
    where agent_run_id = v_run.id and provider = 'root';
    if v_root.id is null
       or v_root_agent_id is null
       or v_root.agent_id <> v_root_agent_id then
      raise exception 'SUBMIT_ROOT_ONLY';
    end if;
    if v_root_session_id is null or v_root.session_id <> v_root_session_id then
      raise exception 'SUBMIT_ROOT_ONLY';
    end if;
    if v_root.status = 'CANCELLED' then
      raise exception 'AGENT_TREE_CANCELLED';
    end if;
    if v_root.status <> 'RUNNING' then
      raise exception 'SUBMIT_ROOT_ONLY';
    end if;

    if v_session_revision is null
       or v_session_revision <> v_run.session_revision then
      raise exception 'SESSION_FENCED';
    end if;
    if v_policy_hash is null
       or v_run.policy_hash is null
       or v_policy_hash <> v_run.policy_hash
       or v_policy_hash <> v_job.policy_hash then
      raise exception 'AGENT_IDENTITY_INVALID';
    end if;

    v_db_tree_digest := public.analysis_agent_tree_digest(v_run.id);
    if v_tree_digest is null or v_tree_digest <> v_db_tree_digest then
      raise exception 'AGENT_IDENTITY_INVALID';
    end if;
  end if;

  -- V1 keeps its historical submission semantics. V2 may commit only when the
  -- current run, its frozen generation and its current triage revision have one
  -- verdict for every AI_CANDIDATE/WEAK candidate. This check and result writes
  -- are in this same transaction under task/job/run row locks.
  if v_job.analysis_context_version=2 then
    if v_run.id is null
       or v_run.scope_generation is null
       or v_run.selected_scope_hash is distinct from v_job.selected_scope_hash
       or v_run.attribution_ruleset_hash is distinct from v_job.ruleset_hash then
      raise exception 'ANALYSIS_SCOPE_IDENTITY_MISMATCH';
    end if;

    select * into v_scope
    from public.analysis_story_scope scope
    where scope.task_id=p_task_id
      and scope.generation=v_run.scope_generation
      and scope.frozen_at is not null
    for update;
    if v_scope.id is null
       or v_scope.ruleset_hash is distinct from v_run.attribution_ruleset_hash
       or v_scope.generation is distinct from v_run.scope_generation then
      raise exception 'ANALYSIS_SCOPE_IDENTITY_MISMATCH';
    end if;

    select count(*) into v_triage_required
    from public.analysis_story_commit_candidate candidate
    where candidate.scope_id=v_scope.id
      and candidate.generation=v_run.scope_generation
      and candidate.tier in ('AI_CANDIDATE','WEAK');

    select count(*) into v_triage_completed
    from public.analysis_story_commit_relevance_verdict verdict
    join public.analysis_story_commit_candidate candidate
      on candidate.id=verdict.candidate_id
    where verdict.agent_run_id=v_run.id
      and verdict.triage_revision=v_run.agent_attempt
      and candidate.scope_id=v_scope.id
      and candidate.generation=v_run.scope_generation
      and candidate.tier in ('AI_CANDIDATE','WEAK');

    if v_triage_completed<>v_triage_required then
      raise exception 'ANALYSIS_SCOPE_TRIAGE_INCOMPLETE: %/%',
        v_triage_completed,v_triage_required;
    end if;
  end if;

  v_committed_at := now();

  insert into public.analysis_agent_run (
    task_id, job_id, agent_attempt, worker_id, status,
    profile_config_hash, prompt_version, model_label,
    tool_calls, evidence_shown, searches_run, retry_requests, compaction_requests,
    model_requests, root_model_requests, child_model_requests,
    web_requests, web_bytes, input_tokens, output_tokens,
    root_agent_id, root_session_id, tree_digest, policy_hash,
    session_revision, sealed_at, committed_at, finished_at
  ) values (
    p_task_id, v_task.job_id, p_agent_attempt, p_worker_id, 'COMMITTED',
    p_config_hash, p_prompt_version, p_model_label,
    greatest(coalesce((p_usage->>'tool_calls')::integer, 0), 0),
    greatest(coalesce((p_usage->>'evidence_shown')::integer, 0), 0),
    greatest(coalesce((p_usage->>'searches_run')::integer, 0), 0),
    greatest(coalesce((p_usage->>'retry_requests')::integer, 0), 0),
    greatest(coalesce((p_usage->>'compaction_requests')::integer, 0), 0),
    greatest(coalesce((p_usage->>'model_requests')::integer, 0), 0),
    greatest(coalesce((p_usage->>'root_model_requests')::integer, 0), 0),
    greatest(coalesce((p_usage->>'child_model_requests')::integer, 0), 0),
    greatest(coalesce((p_usage->>'web_requests')::integer, 0), 0),
    greatest(coalesce((p_usage->>'web_bytes')::bigint, 0), 0),
    nullif(p_usage->>'input_tokens', '')::bigint,
    nullif(p_usage->>'output_tokens', '')::bigint,
    v_root_agent_id, v_root_session_id, v_tree_digest,
    coalesce(v_policy_hash, encode(sha256(v_job.capability_policy_snapshot::text::bytea), 'hex')),
    coalesce(v_session_revision, 1), v_committed_at, v_committed_at, v_committed_at
  )
  on conflict (task_id, agent_attempt) do update
  set status = 'COMMITTED',
      worker_id = excluded.worker_id,
      profile_config_hash = excluded.profile_config_hash,
      prompt_version = excluded.prompt_version,
      model_label = excluded.model_label,
      tool_calls = greatest(public.analysis_agent_run.tool_calls, excluded.tool_calls),
      evidence_shown = greatest(public.analysis_agent_run.evidence_shown, excluded.evidence_shown),
      searches_run = greatest(public.analysis_agent_run.searches_run, excluded.searches_run),
      retry_requests = greatest(public.analysis_agent_run.retry_requests, excluded.retry_requests),
      compaction_requests = greatest(
        public.analysis_agent_run.compaction_requests, excluded.compaction_requests
      ),
      model_requests = greatest(public.analysis_agent_run.model_requests, excluded.model_requests),
      root_model_requests = greatest(
        public.analysis_agent_run.root_model_requests, excluded.root_model_requests
      ),
      child_model_requests = greatest(
        public.analysis_agent_run.child_model_requests, excluded.child_model_requests
      ),
      web_requests = greatest(public.analysis_agent_run.web_requests, excluded.web_requests),
      web_bytes = greatest(public.analysis_agent_run.web_bytes, excluded.web_bytes),
      input_tokens = coalesce(excluded.input_tokens, public.analysis_agent_run.input_tokens),
      output_tokens = coalesce(excluded.output_tokens, public.analysis_agent_run.output_tokens),
      root_agent_id = coalesce(excluded.root_agent_id, public.analysis_agent_run.root_agent_id),
      root_session_id = coalesce(
        excluded.root_session_id, public.analysis_agent_run.root_session_id
      ),
      tree_digest = coalesce(excluded.tree_digest, public.analysis_agent_run.tree_digest),
      session_revision = greatest(
        public.analysis_agent_run.session_revision, excluded.session_revision
      ),
      sealed_at = excluded.sealed_at,
      committed_at = excluded.committed_at,
      finished_at = excluded.finished_at,
      error_code = null,
      error_message = null
  returning id into v_run_id;

  delete from public.analysis_agent_evidence where agent_run_id = v_run_id;

  if jsonb_typeof(p_evidence) = 'array' then
    for v_evidence in select * from jsonb_array_elements(p_evidence)
    loop
      -- 只有 pinned snapshot 证据需要落在冻结 Commit 上；Artifact 证据走
      -- analysis_artifact，绝不能冒充"现有实现"。
      if coalesce(v_evidence->>'evidence_origin', 'PINNED_SNAPSHOT') <> 'PINNED_SNAPSHOT' then
        raise exception 'EVIDENCE_ORIGIN_INVALID';
      end if;
      if not exists (
        select 1 from public.analysis_repository_snapshot snapshot
        where snapshot.job_id = v_task.job_id
          and snapshot.repository_name = v_evidence->>'repository_name'
          and lower(snapshot.commit_sha) = lower(v_evidence->>'commit_sha')
      ) then
        raise exception 'EVIDENCE_PATH_INVALID';
      end if;

      v_producer := null;
      if v_evidence->>'producer_agent_id' is not null then
        select id into v_producer from public.analysis_agent_node
        where agent_run_id = v_run_id and agent_id = v_evidence->>'producer_agent_id';
        -- 证据的生产者必须属于当前 Agent Tree。跨 tree 引用直接拒绝。
        if v_producer is null then
          raise exception 'EVIDENCE_AGENT_INVALID';
        end if;
      end if;

      insert into public.analysis_agent_evidence (
        agent_run_id, evidence_id, repository_name, commit_sha, file_path, blob_sha,
        start_line, end_line, content_hash, evidence_type, description,
        producer_agent_node_id, producer_session_id, tool_call_id,
        evidence_origin, policy_hash, session_revision
      ) values (
        v_run_id,
        v_evidence->>'evidence_id',
        v_evidence->>'repository_name',
        lower(v_evidence->>'commit_sha'),
        v_evidence->>'file_path',
        lower(v_evidence->>'blob_sha'),
        (v_evidence->>'start_line')::integer,
        (v_evidence->>'end_line')::integer,
        v_evidence->>'content_hash',
        v_evidence->>'evidence_type',
        v_evidence->>'description',
        v_producer,
        v_evidence->>'producer_session_id',
        v_evidence->>'tool_call_id',
        'PINNED_SNAPSHOT',
        coalesce(v_policy_hash, v_run.policy_hash),
        coalesce(v_session_revision, 1)
      );
    end loop;
  end if;

  -- 提交成功即封存整棵 Agent Tree：迟到的 child 不能再改变结果。
  update public.analysis_agent_node
  set status = case when status = 'RUNNING' then 'FINISHED' else status end,
      finished_at = coalesce(finished_at, v_committed_at)
  where agent_run_id = v_run_id;

  update public.analysis_story_task
  set agent_status = 'SUCCEEDED',
      agent_output = p_result,
      agent_model = coalesce(p_model_label, agent_model),
      agent_prompt_version = coalesce(p_prompt_version, agent_prompt_version),
      claim_token_digest = null,
      worker_id = null,
      lease_expires_at = null,
      heartbeat_at = now(),
      finished_at = v_committed_at
  where id = p_task_id;

  update public.analysis_job
  set analyzed_stories = (
    select count(*) from public.analysis_story_task
    where job_id = v_task.job_id and agent_status = 'SUCCEEDED'
  )
  where id = v_task.job_id;

  return jsonb_build_object(
    'run_id', v_run_id,
    'committed_at', v_committed_at,
    'sealed', true
  );
end;
$$;

revoke execute on function public.guard_v4_harness_manifest_replay() from public,anon,authenticated;
revoke execute on function public.analysis_agent_run_scope_hash(uuid) from public,anon,authenticated;
grant execute on function public.analysis_agent_run_scope_hash(uuid) to service_role;

revoke execute on function public.claim_next_story_task(text,integer) from public,anon,authenticated;
grant execute on function public.claim_next_story_task(text,integer) to service_role;
revoke execute on function public.get_story_task_analysis_scope(uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.get_story_task_analysis_scope(uuid,text,uuid) to service_role;
revoke execute on function public.submit_story_commit_relevance_verdict(uuid,text,uuid,uuid,uuid,integer,text,text[],numeric,uuid[],text) from public,anon,authenticated;
grant execute on function public.submit_story_commit_relevance_verdict(uuid,text,uuid,uuid,uuid,integer,text,text[],numeric,uuid[],text) to service_role;
revoke execute on function public.save_analysis_session_checkpoint(uuid,text,uuid,integer,text,integer,text,text,integer,text,text,text,text,bigint) from public,anon,authenticated;
grant execute on function public.save_analysis_session_checkpoint(uuid,text,uuid,integer,text,integer,text,text,integer,text,text,text,text,bigint) to service_role;
revoke execute on function public.load_resumable_analysis_attempt(uuid,text,uuid,boolean) from public,anon,authenticated;
grant execute on function public.load_resumable_analysis_attempt(uuid,text,uuid,boolean) to service_role;
revoke execute on function public.save_agent_review_result(uuid,text,uuid,integer,jsonb,jsonb,jsonb,text,text,text) from public,anon,authenticated;
grant execute on function public.save_agent_review_result(uuid,text,uuid,integer,jsonb,jsonb,jsonb,text,text,text) to service_role;

comment on function public.guard_v4_harness_manifest_replay() is
  'Identical revision replay restores that row as active and skips INSERT; conflicting content fails closed.';
comment on function public.analysis_agent_run_scope_hash(uuid) is
  'Canonical V2 analysisScopeIdentity used by the Worker profile and session checkpoint recovery gate.';

commit;
