-- V1.11 需求提交归属：把 foundation 对象接入现有 enqueue / preparation / monitoring 主链。
-- 只做前滚集成；旧 enqueue_analysis_job(uuid) 与 V1 状态机保持不变。

begin;

------------------------------------------------------------------------------
-- 1. 可选 MR 元数据只预留可信数据模型；首版明确 UNAVAILABLE，不在数据库内联网。
------------------------------------------------------------------------------

alter table public.analysis_repository_snapshot
  add column if not exists mr_enrichment_status text not null default 'UNAVAILABLE',
  add column if not exists mr_enrichment_error_code text;

alter table public.analysis_repository_snapshot
  drop constraint if exists analysis_repository_snapshot_mr_enrichment_status_check,
  add constraint analysis_repository_snapshot_mr_enrichment_status_check
    check (mr_enrichment_status in ('UNAVAILABLE', 'PENDING', 'COMPLETE', 'PARTIAL', 'FAILED'));

create table if not exists public.analysis_repository_merge_request (
  id uuid primary key default gen_random_uuid(),
  snapshot_id uuid not null references public.analysis_repository_snapshot(id) on delete cascade,
  provider_project_id text not null check (btrim(provider_project_id) <> ''),
  merge_request_iid bigint not null check (merge_request_iid > 0),
  source_branch text not null check (btrim(source_branch) <> ''),
  target_branch text not null check (btrim(target_branch) <> ''),
  title text not null,
  structured_story_ids text[] not null default array[]::text[],
  author_display_name text,
  merged_at timestamptz,
  merge_commit_sha text check (merge_commit_sha is null or merge_commit_sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
  squash_commit_sha text check (squash_commit_sha is null or squash_commit_sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
  metadata_hash text not null check (metadata_hash ~ '^(sha256:)?[0-9a-f]{64}$'),
  collected_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (snapshot_id, provider_project_id, merge_request_iid)
);

create table if not exists public.analysis_merge_request_commit (
  merge_request_id uuid not null references public.analysis_repository_merge_request(id) on delete cascade,
  commit_id uuid not null references public.analysis_repository_commit(id) on delete restrict,
  membership_type text not null check (membership_type in ('COMMIT', 'MERGE_COMMIT', 'SQUASH_COMMIT')),
  created_at timestamptz not null default now(),
  primary key (merge_request_id, commit_id, membership_type)
);

create index if not exists idx_analysis_repository_mr_snapshot
on public.analysis_repository_merge_request(snapshot_id, merge_request_iid);
create index if not exists idx_analysis_mr_commit_commit
on public.analysis_merge_request_commit(commit_id);

alter table public.analysis_repository_merge_request enable row level security;
alter table public.analysis_merge_request_commit enable row level security;
revoke all on table public.analysis_repository_merge_request from anon, authenticated;
revoke all on table public.analysis_merge_request_commit from anon, authenticated;
grant select, insert on table public.analysis_repository_merge_request to service_role;
grant select, insert on table public.analysis_merge_request_commit to service_role;

comment on table public.analysis_repository_merge_request is
  'Optional future MR metadata. V1.11 base deployment never fabricates rows when GitLab API collection is unavailable.';
comment on column public.analysis_repository_snapshot.mr_enrichment_status is
  'Explicit capability fact. Base deployment remains UNAVAILABLE; empty MR rows must not be interpreted as zero matching MRs.';

------------------------------------------------------------------------------
-- 2. V2 enqueue。保留 enqueue_analysis_job(uuid) 唯一旧签名，避免既有浏览器和回归断裂。
------------------------------------------------------------------------------

create or replace function public.enqueue_analysis_job_with_context(
  p_batch_id uuid,
  p_analysis_context_version integer default 1,
  p_commit_window_days integer default 21
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_batch public.review_batch;
  v_enabled boolean;
  v_secret uuid;
  v_snapshot jsonb;
  v_policy jsonb;
  v_job_id uuid;
  v_story_count integer;
  v_rule_version public.analysis_attribution_rule_version;
begin
  perform public.ensure_manage_review_batch(p_batch_id);

  if p_analysis_context_version not in (1, 2) then
    raise exception 'ANALYSIS_CONTEXT_VERSION_INVALID';
  end if;
  if p_commit_window_days not in (14, 21, 28) then
    raise exception 'COMMIT_WINDOW_DAYS_INVALID';
  end if;

  select * into v_batch from public.review_batch where id = p_batch_id for update;
  if v_batch.id is null then raise exception 'batch not found'; end if;
  if v_batch.status = 'COMPLETED' then
    raise exception 'batch is completed and read-only; reopen it first';
  end if;
  if v_batch.default_branch is null
     or v_batch.default_branch not in ('feature_dev', 'feature_sit', 'release') then
    raise exception 'batch default_branch must be feature_dev, feature_sit, or release';
  end if;
  if v_batch.ai_model_config_id is null then raise exception 'batch has no model selected'; end if;
  if exists (select 1 from public.ai_import_record where batch_id = p_batch_id) then
    raise exception 'AI result already exists for this batch';
  end if;
  if exists (
    select 1 from public.analysis_job
    where batch_id = p_batch_id
      and status in ('QUEUED', 'PREPARING_CODE', 'PREPARING_SCOPE', 'PROCESSING', 'FINALIZING')
  ) then
    raise exception 'an active analysis job already exists for this batch';
  end if;

  select count(*) into v_story_count from public.review_story where batch_id = p_batch_id;
  if v_story_count = 0 then raise exception 'no stories imported for this batch'; end if;

  select enabled, api_key_secret_id into v_enabled, v_secret
  from public.ai_model_config where id = v_batch.ai_model_config_id;
  if v_enabled is null then raise exception 'model config not found'; end if;
  if not v_enabled then raise exception 'MODEL_CONFIG_DISABLED'; end if;
  if not public.model_config_has_api_key(v_secret) then raise exception 'MODEL_SECRET_MISSING'; end if;

  if p_analysis_context_version = 2 then
    select version.* into v_rule_version
    from public.analysis_attribution_rule_set rule_set
    join public.analysis_attribution_rule_version version
      on version.id = rule_set.current_published_version_id
    where rule_set.rule_set_code = 'STORY_COMMIT_ATTRIBUTION'
      and rule_set.enabled
      and version.status = 'PUBLISHED'
    for share of version;
    if v_rule_version.id is null then raise exception 'PUBLISHED_ATTRIBUTION_RULESET_REQUIRED'; end if;
    if v_rule_version.ruleset_hash is distinct from public.attribution_rule_version_hash(v_rule_version.id) then
      raise exception 'ATTRIBUTION_RULESET_MISMATCH';
    end if;
  end if;

  v_snapshot := public.build_model_snapshot(v_batch.ai_model_config_id);
  v_policy := public.build_v4_capability_policy(v_batch.ai_model_config_id);
  update public.review_batch set ai_model_snapshot = v_snapshot where id = p_batch_id;

  insert into public.analysis_job (
    batch_id, model_config_id, model_snapshot, requested_branch,
    status, requested_by, total_stories, execution_engine,
    policy_version, capability_policy_snapshot, policy_hash,
    analysis_context_version, commit_window_days, scope_status,
    required_worker_scope_version, attribution_algorithm_version,
    attribution_rule_version_id, ruleset_hash
  ) values (
    p_batch_id, v_batch.ai_model_config_id, v_snapshot, v_batch.default_branch,
    'QUEUED', auth.uid(), v_story_count, 'deepseek-harness-acp',
    4, v_policy, encode(sha256(v_policy::text::bytea), 'hex'),
    p_analysis_context_version, p_commit_window_days,
    case when p_analysis_context_version = 2 then 'PREPARING' else 'LEGACY' end,
    case when p_analysis_context_version = 2 then 2 else 1 end,
    case when p_analysis_context_version = 2 then 'story-attribution-v2' else null end,
    case when p_analysis_context_version = 2 then v_rule_version.id else null end,
    case when p_analysis_context_version = 2 then v_rule_version.ruleset_hash else null end
  ) returning id into v_job_id;

  perform public.freeze_analysis_job_skill_catalog(v_job_id);

  insert into public.analysis_story_task (job_id, story_id)
  select v_job_id, story.id
  from public.review_story story
  where story.batch_id = p_batch_id;

  return v_job_id;
end;
$$;

create or replace function public.enqueue_analysis_job(p_batch_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
begin
  return public.enqueue_analysis_job_with_context(p_batch_id, 1, 21);
end;
$$;

revoke execute on function public.enqueue_analysis_job_with_context(uuid,integer,integer)
  from public, anon;
grant execute on function public.enqueue_analysis_job_with_context(uuid,integer,integer)
  to authenticated;
revoke execute on function public.enqueue_analysis_job(uuid) from public, anon;
grant execute on function public.enqueue_analysis_job(uuid) to authenticated;

------------------------------------------------------------------------------
-- 3. 输入冻结尊重 enqueue 已冻结的规则版本，不读取之后切换的“当前版本”。
------------------------------------------------------------------------------

create or replace function public.freeze_analysis_job_scope_inputs(p_job_id uuid,p_worker_id text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_job public.analysis_job;
  v_version public.analysis_attribution_rule_version;
  v_story_hash text;
  v_identity_hash text;
begin
  v_job := public.assert_analysis_scope_job_writer(
    p_job_id, p_worker_id, array['PREPARING_CODE','PREPARING_SCOPE']
  );

  if v_job.attribution_rule_version_id is not null then
    select * into v_version
    from public.analysis_attribution_rule_version
    where id = v_job.attribution_rule_version_id and status = 'PUBLISHED';
  else
    select version.* into v_version
    from public.analysis_attribution_rule_set rule_set
    join public.analysis_attribution_rule_version version
      on version.id = rule_set.current_published_version_id
    where rule_set.rule_set_code = 'STORY_COMMIT_ATTRIBUTION'
      and rule_set.enabled and version.status = 'PUBLISHED';
  end if;
  if v_version.id is null then raise exception 'PUBLISHED_ATTRIBUTION_RULESET_REQUIRED'; end if;
  if v_version.ruleset_hash is distinct from public.attribution_rule_version_hash(v_version.id)
     or (v_job.ruleset_hash is not null and v_job.ruleset_hash is distinct from v_version.ruleset_hash) then
    raise exception 'ATTRIBUTION_RULESET_MISMATCH';
  end if;

  if exists(select 1 from public.analysis_job_story_snapshot where job_id = p_job_id) then
    select story_input_catalog_hash, identity_snapshot_hash
      into v_story_hash, v_identity_hash
    from public.analysis_job where id = p_job_id;
    update public.analysis_job
    set status = 'PREPARING_SCOPE', scope_status = 'PREPARING',
        scope_requested_at = coalesce(scope_requested_at, now())
    where id = p_job_id and status = 'PREPARING_CODE';
    return jsonb_build_object(
      'story_input_catalog_hash', v_story_hash,
      'identity_snapshot_hash', v_identity_hash,
      'rule_version_id', v_version.id,
      'ruleset_hash', v_version.ruleset_hash,
      'idempotent', true
    );
  end if;

  insert into public.analysis_job_story_snapshot(
    job_id,story_id,story_code,story_name,owners_text,normalized_developer_ids,
    project_name,application_name,release_window,requirement_context,input_hash
  )
  select p_job_id,story.id,story.story_code,story.story_name,story.owners_text,
    array(
      select distinct developer.id
      from public.developer_identity developer
      where developer.status='VERIFIED' and exists(
        select 1
        from regexp_split_to_table(story.owners_text,'[，,、；;]') as owner(owner_token)
        where btrim(owner.owner_token)=developer.display_name
           or (developer.employee_code is not null and btrim(owner.owner_token) in (
             developer.display_name||'（'||developer.employee_code||'）',
             developer.display_name||'('||developer.employee_code||')'
           ))
      ) order by developer.id
    ),story.project_name,story.application_name,story.release_window,
    jsonb_strip_nulls(jsonb_build_object(
      'detailed_description',story.source_data->'详细描述',
      'related_features',story.source_data->'关联特性',
      'source_status',story.source_status
    )),
    encode(digest(convert_to(concat_ws(E'\n',story.story_code,story.story_name,story.owners_text,
      coalesce(story.project_name,''),coalesce(story.application_name,''),
      coalesce(story.release_window,''),jsonb_strip_nulls(jsonb_build_object(
        'detailed_description',story.source_data->'详细描述',
        'related_features',story.source_data->'关联特性',
        'source_status',story.source_status))::text),'UTF8'),'sha256'),'hex')
  from public.analysis_story_task task
  join public.review_story story on story.id=task.story_id
  where task.job_id=p_job_id
  order by story.story_code;

  insert into public.analysis_job_identity_snapshot(
    job_id,source_developer_identity_id,source_git_identity_id,developer_display_name,
    employee_code,identity_status,provider,email_fingerprint,masked_email,email_domain,
    author_name_aliases,gitlab_username,gitlab_user_id,verification_status,snapshot_hash
  )
  select p_job_id,developer.id,git.id,developer.display_name,developer.employee_code,
    developer.status,git.provider,git.email_fingerprint,git.masked_email,git.email_domain,
    git.author_name_aliases,git.gitlab_username,git.gitlab_user_id,git.verification_status,
    encode(digest(convert_to(concat_ws(E'\n',developer.id::text,git.id::text,
      developer.display_name,coalesce(developer.employee_code,''),developer.status,
      git.provider,coalesce(git.email_fingerprint,''),coalesce(git.masked_email,''),
      coalesce(git.email_domain,''),array_to_string(git.author_name_aliases,E'\n'),
      coalesce(git.gitlab_username,''),coalesce(git.gitlab_user_id,''),
      git.verification_status),'UTF8'),'sha256'),'hex')
  from public.developer_identity developer
  join public.developer_git_identity git on git.developer_identity_id=developer.id
  where developer.status <> 'DISABLED' and git.verification_status <> 'DISABLED'
    and git.valid_from <= now() and (git.valid_until is null or git.valid_until > now())
  order by developer.id,git.id;

  select encode(digest(convert_to(coalesce(string_agg(input_hash,E'\n' order by story_code),'empty'),
    'UTF8'),'sha256'),'hex')
  into v_story_hash
  from public.analysis_job_story_snapshot where job_id=p_job_id;

  select encode(digest(convert_to(coalesce(string_agg(snapshot_hash,E'\n' order by source_git_identity_id),
    'empty'),'UTF8'),'sha256'),'hex')
  into v_identity_hash
  from public.analysis_job_identity_snapshot where job_id=p_job_id;

  update public.analysis_job
  set status='PREPARING_SCOPE', scope_status='PREPARING',
      scope_requested_at=coalesce(scope_requested_at,now()),
      attribution_rule_version_id=v_version.id, ruleset_hash=v_version.ruleset_hash,
      story_input_catalog_hash=v_story_hash, identity_snapshot_hash=v_identity_hash,
      attribution_algorithm_version=coalesce(attribution_algorithm_version,'story-attribution-v2')
  where id=p_job_id;

  return jsonb_build_object(
    'story_input_catalog_hash',v_story_hash,
    'identity_snapshot_hash',v_identity_hash,
    'rule_version_id',v_version.id,
    'ruleset_hash',v_version.ruleset_hash,
    'idempotent',false
  );
end;
$$;

revoke execute on function public.freeze_analysis_job_scope_inputs(uuid,text)
  from public, anon, authenticated;
grant execute on function public.freeze_analysis_job_scope_inputs(uuid,text) to service_role;

------------------------------------------------------------------------------
-- 4. preparation claim：V1 不设能力门槛；V2 只给声明 scope v2 的 Worker。
------------------------------------------------------------------------------

create or replace function public.claim_job_for_preparation(
  p_worker_id text,
  p_lease_seconds integer default 900
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.analysis_job;
  v_ruleset jsonb;
begin
  if p_worker_id is null or btrim(p_worker_id) = '' then raise exception 'worker_id is required'; end if;
  if p_lease_seconds is null or p_lease_seconds < 30 then p_lease_seconds := 900; end if;

  select job.* into v_job
  from public.analysis_job job
  where job.execution_engine = 'deepseek-harness-acp'
    and (
      job.status = 'QUEUED'
      or (job.status = 'PREPARING_CODE'
          and (job.locked_at is null
               or job.locked_at + make_interval(secs => p_lease_seconds) < now()))
    )
    and (
      job.analysis_context_version = 1
      or exists (
        select 1 from public.analysis_worker_heartbeat heartbeat
        where heartbeat.worker_id = p_worker_id
          and heartbeat.capabilities->>'storyCommitScopeVersion' ~ '^[0-9]+$'
          and (heartbeat.capabilities->>'storyCommitScopeVersion')::integer
              >= job.required_worker_scope_version
      )
    )
  order by job.created_at, job.id
  for update skip locked
  limit 1;

  if v_job.id is null then return null; end if;

  update public.analysis_job
  set status='PREPARING_CODE', worker_id=p_worker_id, attempt=attempt+1,
      locked_at=now(), started_at=coalesce(started_at,now())
  where id=v_job.id
  returning * into v_job;

  if v_job.analysis_context_version = 2 then
    select jsonb_build_object(
      'version_id', version.id,
      'version', version.version,
      'schema_version', version.schema_version,
      'hash', version.ruleset_hash,
      'config', version.canonical_config
    ) into v_ruleset
    from public.analysis_attribution_rule_version version
    where version.id=v_job.attribution_rule_version_id and version.status='PUBLISHED';
    if v_ruleset is null then raise exception 'PUBLISHED_ATTRIBUTION_RULESET_REQUIRED'; end if;
  end if;

  return jsonb_build_object(
    'job', jsonb_build_object(
      'id',v_job.id,
      'batch_id',v_job.batch_id,
      'model_config_id',v_job.model_config_id,
      'requested_branch',v_job.requested_branch,
      'total_stories',v_job.total_stories,
      'analysis_context_version',v_job.analysis_context_version,
      'commit_window_days',v_job.commit_window_days,
      'required_worker_scope_version',v_job.required_worker_scope_version
    ),
    'model',v_job.model_snapshot,
    'analysis_context_version',v_job.analysis_context_version,
    'window',jsonb_build_object(
      'days',v_job.commit_window_days,
      'requested_at',v_job.scope_requested_at
    ),
    'ruleset',v_ruleset
  );
end;
$$;

revoke execute on function public.claim_job_for_preparation(text,integer)
  from public, anon, authenticated;
grant execute on function public.claim_job_for_preparation(text,integer) to service_role;

------------------------------------------------------------------------------
-- 5. 四仓 HEAD 保存：V1 原样进入 PROCESSING；V2 冻结输入并进入 PREPARING_SCOPE。
------------------------------------------------------------------------------

create or replace function public.save_repository_snapshots(
  p_job_id uuid,
  p_worker_id text,
  p_snapshots jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.analysis_job;
  v_snap jsonb;
begin
  select * into v_job from public.analysis_job where id=p_job_id for update;
  if v_job.id is null then raise exception 'job not found'; end if;
  if v_job.execution_engine <> 'deepseek-harness-acp' then raise exception 'LEGACY_ENGINE_RETIRED'; end if;
  if v_job.status <> 'PREPARING_CODE' then raise exception 'job is not in PREPARING_CODE state'; end if;
  if v_job.worker_id is distinct from p_worker_id then raise exception 'JOB_LEASE_LOST'; end if;
  if jsonb_typeof(p_snapshots) <> 'array' then raise exception 'snapshots must be an array'; end if;

  delete from public.analysis_repository_snapshot where job_id=p_job_id;

  for v_snap in select * from jsonb_array_elements(p_snapshots)
  loop
    insert into public.analysis_repository_snapshot(
      job_id,repository_name,requested_branch,commit_sha,commit_subject,
      head_sha,head_resolved_at,enumeration_status,mr_enrichment_status
    ) values (
      p_job_id,v_snap->>'repository_name',
      coalesce(v_snap->>'requested_branch',v_job.requested_branch),
      v_snap->>'commit_sha',nullif(v_snap->>'commit_subject',''),
      case when v_job.analysis_context_version=2 then lower(v_snap->>'commit_sha') else null end,
      case when v_job.analysis_context_version=2 then now() else null end,
      case when v_job.analysis_context_version=2 then 'PENDING' else null end,
      'UNAVAILABLE'
    );
  end loop;

  if (select count(*) from public.analysis_repository_snapshot where job_id=p_job_id) <> 4 then
    raise exception 'exactly 4 repository snapshots are required';
  end if;

  if v_job.analysis_context_version = 1 then
    update public.analysis_job set status='PROCESSING' where id=p_job_id;
  else
    perform public.freeze_analysis_job_scope_inputs(p_job_id,p_worker_id);
  end if;
end;
$$;

revoke execute on function public.save_repository_snapshots(uuid,text,jsonb)
  from public, anon, authenticated;
grant execute on function public.save_repository_snapshots(uuid,text,jsonb) to service_role;

------------------------------------------------------------------------------
-- 6. 监控 summary：直接匹配 useRuntimeAnalysisScope.ts，并保留旧别名字段。
------------------------------------------------------------------------------

create or replace function public.get_analysis_story_scope_summary(p_task_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_job public.analysis_job;
  v_scope public.analysis_story_scope;
  v_repositories jsonb;
  v_expansions jsonb;
begin
  select job.* into v_job
  from public.analysis_story_task task
  join public.analysis_job job on job.id=task.job_id
  where task.id=p_task_id;
  if v_job.id is null then return null; end if;
  perform public.ensure_view_review_batch(v_job.batch_id);

  select * into v_scope
  from public.analysis_story_scope
  where task_id=p_task_id
  order by generation desc limit 1;
  if v_scope.id is null then return null; end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'repository_name',snapshot.repository_name,
    'base_sha',snapshot.base_sha,
    'head_sha',coalesce(snapshot.head_sha,lower(snapshot.commit_sha)),
    'range_source',coalesce(snapshot.range_source,'UNAVAILABLE'),
    'commit_count',snapshot.commit_count,
    'enumeration_status',coalesce(snapshot.enumeration_status,'PENDING'),
    'range_start_at',coalesce(snapshot.range_start_at,
      coalesce(v_job.scope_requested_at,snapshot.prepared_at)
        - make_interval(days => v_job.commit_window_days)),
    'range_end_at',coalesce(snapshot.range_end_at,
      coalesce(v_job.scope_requested_at,snapshot.prepared_at)),
    'resolved_at',coalesce(snapshot.head_resolved_at,snapshot.prepared_at)
  ) order by snapshot.repository_name),'[]'::jsonb)
  into v_repositories
  from public.analysis_repository_snapshot snapshot
  where snapshot.job_id=v_job.id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id',expansion.id,
    'attempt',run.agent_attempt,
    'agent_label',coalesce(node.agent_role,'root-reviewer'),
    'from_level',expansion.from_level,
    'to_level',expansion.to_level,
    'reason_code',expansion.reason_code,
    'occurred_at',expansion.created_at
  ) order by expansion.created_at,expansion.id),'[]'::jsonb)
  into v_expansions
  from public.analysis_scope_expansion expansion
  join public.analysis_agent_run run on run.id=expansion.agent_run_id
  left join public.analysis_agent_node node on node.id=expansion.agent_node_id
  where expansion.task_id=p_task_id;

  return jsonb_build_object(
    'task_id',p_task_id,
    'generation',v_scope.generation,
    'status',v_scope.status,
    'mode',v_scope.scope_mode,
    'error_code',v_scope.scope_error_code,
    'window_days',v_job.commit_window_days,
    'candidate_count',v_scope.candidate_count,
    'strong_count',v_scope.strong_count,
    'ai_related_count',v_scope.ai_related_count,
    'ai_uncertain_count',v_scope.ai_uncertain_count,
    'read_count',(select count(distinct candidate_id)
      from public.analysis_story_commit_access where task_id=p_task_id),
    'reverted_count',(select count(*) from public.analysis_story_commit_candidate
      where scope_id=v_scope.id and effective_status='REVERTED'),
    'current_scope_level',v_scope.current_scope_level,
    'algorithm_version',v_scope.algorithm_version,
    'manifest_hash',v_scope.candidate_manifest_hash,
    'repositories',v_repositories,
    'expansions',v_expansions,
    -- 兼容 foundation 初版调用方。
    'scope_status',v_scope.status,
    'scope_mode',v_scope.scope_mode,
    'scope_error_code',v_scope.scope_error_code,
    'ai_candidate_count',v_scope.ai_candidate_count,
    'degradation_reasons',v_scope.degradation_reasons,
    'frozen_at',v_scope.frozen_at
  );
end;
$$;

------------------------------------------------------------------------------
-- 7. commits 分页：新增五参数同名重载供 hook adapter 使用；旧三参数仍可用。
------------------------------------------------------------------------------

create or replace function public.get_analysis_story_scope_commits(
  p_task_id uuid,
  p_generation integer,
  p_view text,
  p_cursor text,
  p_limit integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_job public.analysis_job;
  v_scope public.analysis_story_scope;
  v_offset integer;
  v_limit integer:=least(greatest(coalesce(p_limit,20),1),100);
  v_total integer;
  v_items jsonb;
begin
  if p_view not in ('SELECTED','CANDIDATE','EXCLUDED') then
    raise exception 'ANALYSIS_SCOPE_VIEW_INVALID';
  end if;
  if p_cursor is null or p_cursor='' then v_offset:=0;
  elsif p_cursor ~ '^[0-9]+$' then v_offset:=p_cursor::integer;
  else raise exception 'ANALYSIS_SCOPE_CURSOR_INVALID';
  end if;

  select job.* into v_job
  from public.analysis_story_task task
  join public.analysis_job job on job.id=task.job_id
  where task.id=p_task_id;
  if v_job.id is null then return null; end if;
  perform public.ensure_view_review_batch(v_job.batch_id);

  select * into v_scope from public.analysis_story_scope
  where task_id=p_task_id and generation=p_generation;
  if v_scope.id is null then
    return jsonb_build_object('task_id',p_task_id,'generation',p_generation,
      'items','[]'::jsonb,'next_cursor',null,'total',0);
  end if;

  with candidate_rows as (
    select candidate.id,candidate.generation,candidate.tier,candidate.rank_score,
      candidate.reason_codes,candidate.effective_status,snapshot.repository_name,
      repo_commit.sha,repo_commit.committed_at,repo_commit.author_name,
      repo_commit.author_email_masked,repo_commit.subject,repo_commit.files_changed,
      repo_commit.additions,repo_commit.deletions,
      verdict.verdict,
      (select count(*) from public.analysis_story_commit_access access
        where access.candidate_id=candidate.id) as read_count
    from public.analysis_story_commit_candidate candidate
    join public.analysis_repository_commit repo_commit on repo_commit.id=candidate.commit_id
    join public.analysis_repository_snapshot snapshot on snapshot.id=repo_commit.snapshot_id
    left join lateral (
      select relevance.verdict
      from public.analysis_story_commit_relevance_verdict relevance
      where relevance.candidate_id=candidate.id
      order by relevance.created_at desc,relevance.id desc limit 1
    ) verdict on true
    where candidate.scope_id=v_scope.id
  ), filtered as (
    select * from candidate_rows row
    where (p_view='SELECTED' and (row.tier='STRONG' or row.verdict in ('RELATED','UNCERTAIN')))
       or (p_view='CANDIDATE' and row.tier in ('AI_CANDIDATE','WEAK','CONFLICT')
           and (row.verdict is null or row.verdict='UNRELATED'))
       or (p_view='EXCLUDED' and row.tier='EXCLUDED')
  )
  select count(*) into v_total from filtered;

  with candidate_rows as (
    select candidate.id,candidate.generation,candidate.tier,candidate.rank_score,
      candidate.reason_codes,candidate.effective_status,snapshot.repository_name,
      repo_commit.sha,repo_commit.committed_at,repo_commit.author_name,
      repo_commit.author_email_masked,repo_commit.subject,repo_commit.files_changed,
      repo_commit.additions,repo_commit.deletions,
      verdict.verdict,
      (select count(*) from public.analysis_story_commit_access access
        where access.candidate_id=candidate.id) as read_count
    from public.analysis_story_commit_candidate candidate
    join public.analysis_repository_commit repo_commit on repo_commit.id=candidate.commit_id
    join public.analysis_repository_snapshot snapshot on snapshot.id=repo_commit.snapshot_id
    left join lateral (
      select relevance.verdict
      from public.analysis_story_commit_relevance_verdict relevance
      where relevance.candidate_id=candidate.id
      order by relevance.created_at desc,relevance.id desc limit 1
    ) verdict on true
    where candidate.scope_id=v_scope.id
  ), filtered as (
    select * from candidate_rows row
    where (p_view='SELECTED' and (row.tier='STRONG' or row.verdict in ('RELATED','UNCERTAIN')))
       or (p_view='CANDIDATE' and row.tier in ('AI_CANDIDATE','WEAK','CONFLICT')
           and (row.verdict is null or row.verdict='UNRELATED'))
       or (p_view='EXCLUDED' and row.tier='EXCLUDED')
  ), page as (
    select * from filtered
    order by case tier when 'STRONG' then 1 when 'AI_CANDIDATE' then 2
      when 'WEAK' then 3 when 'CONFLICT' then 4 else 5 end,
      rank_score desc,id
    offset v_offset limit v_limit
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'candidate_id',id,
    'generation',generation,
    'view',p_view,
    'relation_status',case
      when tier='EXCLUDED' then 'EXCLUDED'
      when tier='STRONG' then 'AUTO_SELECTED'
      when verdict='RELATED' then 'AI_RELATED'
      when verdict='UNRELATED' then 'AI_UNRELATED'
      else 'AI_UNCERTAIN' end,
    'effective_status',effective_status,
    'repository_name',repository_name,
    'short_sha',left(sha,12),
    'committed_at',committed_at,
    'author_display_name',author_name,
    'author_email_masked',author_email_masked,
    'subject',subject,
    'files_changed',files_changed,
    'additions',additions,
    'deletions',deletions,
    'reason_codes',reason_codes,
    'actually_read',read_count>0,
    'read_count',read_count
  ) order by case tier when 'STRONG' then 1 when 'AI_CANDIDATE' then 2
      when 'WEAK' then 3 when 'CONFLICT' then 4 else 5 end,
      rank_score desc,id),'[]'::jsonb)
  into v_items from page;

  return jsonb_build_object(
    'task_id',p_task_id,
    'generation',v_scope.generation,
    'items',v_items,
    'next_cursor',case when v_offset+v_limit<v_total then (v_offset+v_limit)::text else null end,
    'total',v_total
  );
end;
$$;

revoke execute on function public.get_analysis_story_scope_summary(uuid) from public, anon;
grant execute on function public.get_analysis_story_scope_summary(uuid) to authenticated, service_role;
revoke execute on function public.get_analysis_story_scope_commits(uuid,integer,text,text,integer)
  from public, anon;
grant execute on function public.get_analysis_story_scope_commits(uuid,integer,text,text,integer)
  to authenticated, service_role;

------------------------------------------------------------------------------
-- 8. 规则 catalog 返回 hook 所需对象；没有可信 gold set 时返回空集合且模拟 RPC 不可用。
------------------------------------------------------------------------------

create or replace function public.admin_get_attribution_rule_catalog()
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_catalog jsonb;
begin
  perform public.ensure_admin();

  select jsonb_build_object(
    'rule_set_id',rule_set.id,
    'rule_set_name',rule_set.display_name,
    'current_published_version_id',rule_set.current_published_version_id,
    'versions',coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',version.id,
        'version',version.version,
        'status',version.status,
        'revision',version.revision,
        'ruleset_hash',version.ruleset_hash,
        'source_version_id',version.source_version_id,
        'rules',coalesce((
          select jsonb_agg(jsonb_build_object(
            'id',rule.id,
            'rule_code',rule.rule_code,
            'display_name',rule.display_name,
            'description',rule.description,
            'priority',rule.priority,
            'enabled',rule.enabled,
            'capability',case rule.capability
              when 'MR_OPTIONAL' then 'MR_ENHANCED'
              when 'SYSTEM' then 'RANGE_GATE'
              else 'GIT_BASE' end,
            'match',case when rule.condition_tree ? 'all' then 'ALL' else 'ANY' end,
            'conditions',coalesce((
              select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
                'id',rule.id::text||':'||condition.ordinality::text,
                'field',case condition.item->>'field'
                  when 'commit.story_tokens' then 'commit.unstructured_story_ids'
                  when 'commit.body_story_tokens' then 'commit.unstructured_story_ids'
                  when 'commit.files' then 'commit.file_modules'
                  when 'commit.is_bot' then 'commit.is_bot_or_generated'
                  when 'commit.is_generated' then 'commit.is_bot_or_generated'
                  when 'commit.mr_membership' then 'mr.commit_membership'
                  when 'identity.status' then 'commit.author_identity'
                  when 'scope.candidate_count' then 'repository.enumeration_status'
                  when 'scope.rule_conflict' then 'repository.enumeration_status'
                  else condition.item->>'field' end,
                'operator',condition.item->>'operator',
                'value',condition.item->'value'
              )) order by condition.ordinality)
              from jsonb_array_elements(case
                when rule.condition_tree ? 'all' then rule.condition_tree->'all'
                else rule.condition_tree->'any' end)
                with ordinality as condition(item,ordinality)
            ),'[]'::jsonb),
            'action',jsonb_build_object(
              'type',rule.action_type,
              'reason_code',rule.reason_code
            ),
            'system_locked',rule.system_locked
          ) order by rule.priority desc,rule.sort_order,rule.rule_code collate "C")
          from public.analysis_attribution_rule rule
          where rule.version_id=version.id
        ),'[]'::jsonb),
        'validation',case when version.validated_at is null then null else jsonb_build_object(
          'passed',true,
          'validated_revision',version.revision,
          'issues','[]'::jsonb,
          'validated_at',version.validated_at
        ) end,
        'latest_simulation',(
          select jsonb_build_object(
            'passed',test.passed,
            'sample_set_id',test.sample_set_id,
            'sample_set_label',test.sample_set_id,
            'simulated_revision',version.revision,
            'simulated_at',test.executed_at,
            'metrics',jsonb_build_object(
              'gold_strong_false_positive_count',coalesce((test.metrics->>'strong_false_positive_count')::integer,0),
              'strong_selected_delta',coalesce((test.diff_summary->>'strong_selected_delta')::integer,0),
              'ai_candidate_delta',coalesce((test.diff_summary->>'ai_candidate_delta')::integer,0),
              'excluded_delta',coalesce((test.diff_summary->>'excluded_delta')::integer,0),
              'conflict_delta',coalesce((test.diff_summary->>'conflict_delta')::integer,0),
              'global_fallback_delta',coalesce((test.diff_summary->>'global_fallback_delta')::integer,0)
            ),
            'blocking_reasons',case when test.failure_code is null then '[]'::jsonb
              else jsonb_build_array(test.failure_code) end
          )
          from public.analysis_attribution_rule_test_run test
          where test.version_id=version.id
          order by test.executed_at desc,test.id desc limit 1
        ),
        'created_by_name',(select profile.display_name from public.user_profile profile
          where profile.id=version.created_by),
        'created_at',version.created_at,
        'published_by_name',(select profile.display_name from public.user_profile profile
          where profile.id=version.published_by),
        'published_at',version.published_at,
        'publish_reason',version.publish_reason,
        'referenced_job_count',(select count(*) from public.analysis_job job
          where job.attribution_rule_version_id=version.id)
      ) order by version.version desc,version.created_at desc)
      from public.analysis_attribution_rule_version version
      where version.rule_set_id=rule_set.id
    ),'[]'::jsonb),
    -- 当前没有数据库内冻结 gold-set catalog；绝不由浏览器伪造模拟样本。
    'sample_sets','[]'::jsonb,
    'mr_enhanced_available',false
  ) into v_catalog
  from public.analysis_attribution_rule_set rule_set
  where rule_set.rule_set_code='STORY_COMMIT_ATTRIBUTION';

  return v_catalog;
end;
$$;

create or replace function public.admin_simulate_attribution_rule_draft(
  p_draft_version_id uuid,
  p_expected_revision integer,
  p_sample_set_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_version public.analysis_attribution_rule_version;
begin
  perform public.ensure_admin();
  select * into v_version
  from public.analysis_attribution_rule_version
  where id=p_draft_version_id;
  if v_version.id is null or v_version.status not in ('DRAFT','VALIDATED') then
    raise exception 'RULE_DRAFT_NOT_EDITABLE';
  end if;
  if v_version.revision <> p_expected_revision then raise exception 'REVISION_CONFLICT'; end if;
  if coalesce(btrim(p_sample_set_id),'')='' then raise exception 'SAMPLE_SET_REQUIRED'; end if;
  raise exception 'RULE_SIMULATION_UNAVAILABLE';
end;
$$;

revoke execute on function public.admin_get_attribution_rule_catalog() from public, anon;
grant execute on function public.admin_get_attribution_rule_catalog() to authenticated, service_role;
revoke execute on function public.admin_simulate_attribution_rule_draft(uuid,integer,text)
  from public, anon;
grant execute on function public.admin_simulate_attribution_rule_draft(uuid,integer,text)
  to authenticated;

comment on function public.admin_simulate_attribution_rule_draft(uuid,integer,text) is
  'Fail-closed browser endpoint until a trusted frozen gold-set executor is deployed. Browser input can never record passed=true.';

commit;
