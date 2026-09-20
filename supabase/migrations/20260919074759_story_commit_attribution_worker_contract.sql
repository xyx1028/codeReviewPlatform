-- V1.11 Worker/数据库最终契约补齐。
--
-- 安全边界：
--   * 不修改前两份已应用 migration；本文件只以前滚方式覆盖同签名 RPC；
--   * raw email 仅作为 service-role RPC 的瞬时参数参与 Vault pepper HMAC，
--     不写表、不写审计、不回显；
--   * diff getter 只返回 claim-fenced 固定 metadata，Storage 正文仍由 Worker
--     使用 service-role 和平台路径策略受控读取；
--   * v1 claim、技能快照、模型快照和 task fencing 语义保持不变。

begin;

------------------------------------------------------------------------------
-- 1. 冻结“上一个成功 Job 的四仓 HEAD”，使 preparation 重试不会读到漂移基线。
------------------------------------------------------------------------------

alter table public.analysis_job
  add column if not exists previous_repository_heads jsonb;

create or replace function public.enforce_analysis_job_scope_identity_immutable()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.analysis_context_version = 2
     and old.scope_status in ('READY','DEGRADED')
     and (
       new.analysis_context_version is distinct from old.analysis_context_version
       or new.commit_window_days is distinct from old.commit_window_days
       or new.attribution_algorithm_version is distinct from old.attribution_algorithm_version
       or new.story_input_catalog_hash is distinct from old.story_input_catalog_hash
       or new.identity_snapshot_hash is distinct from old.identity_snapshot_hash
       or new.repository_manifest_hash is distinct from old.repository_manifest_hash
       or new.selected_scope_hash is distinct from old.selected_scope_hash
       or new.previous_repository_heads is distinct from old.previous_repository_heads
       or new.required_worker_scope_version is distinct from old.required_worker_scope_version
       or new.attribution_rule_version_id is distinct from old.attribution_rule_version_id
       or new.ruleset_hash is distinct from old.ruleset_hash
     ) then
    raise exception 'ANALYSIS_JOB_SCOPE_IDENTITY_IMMUTABLE';
  end if;
  return new;
end;
$$;

-- 每个可信 preparation 写 RPC 都顺便推进 lease 水位；所有权和状态仍先行校验。
create or replace function public.assert_analysis_scope_job_writer(
  p_job_id uuid,
  p_worker_id text,
  p_allowed_statuses text[]
)
returns public.analysis_job
language plpgsql
security definer
set search_path = public
as $$
declare v_job public.analysis_job;
begin
  select * into v_job from public.analysis_job where id=p_job_id for update;
  if v_job.id is null then raise exception 'JOB_NOT_FOUND'; end if;
  if v_job.analysis_context_version <> 2 or v_job.required_worker_scope_version <> 2 then
    raise exception 'STORY_COMMIT_SCOPE_V2_REQUIRED';
  end if;
  if v_job.worker_id is distinct from p_worker_id then raise exception 'JOB_LEASE_LOST'; end if;
  if not (v_job.status = any(p_allowed_statuses)) then raise exception 'JOB_SCOPE_STATE_INVALID'; end if;

  update public.analysis_job
  set locked_at=now()
  where id=p_job_id
  returning * into v_job;
  return v_job;
end;
$$;

create or replace function public.analysis_job_frozen_scope_input_payload(p_job_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'stories', coalesce((
      select jsonb_agg(jsonb_build_object(
        'task_id', task.id,
        'story_id', story.story_id,
        'story_code', story.story_code,
        'story_name', story.story_name,
        'owners_text', story.owners_text,
        'normalized_developer_ids', to_jsonb(story.normalized_developer_ids),
        'project_name', story.project_name,
        'application_name', story.application_name,
        'release_window', story.release_window,
        'requirement_context', story.requirement_context,
        'input_hash', story.input_hash
      ) order by story.story_code collate "C", task.id)
      from public.analysis_job_story_snapshot story
      join public.analysis_story_task task
        on task.job_id=story.job_id and task.story_id=story.story_id
      where story.job_id=p_job_id
    ), '[]'::jsonb),
    'identities', coalesce((
      select jsonb_agg(jsonb_build_object(
        'developer_id', identity.source_developer_identity_id,
        'display_name', identity.developer_display_name,
        'email_fingerprint', identity.email_fingerprint,
        'author_name_aliases', to_jsonb(identity.author_name_aliases),
        'verification_status', identity.verification_status
      ) order by identity.source_developer_identity_id, identity.source_git_identity_id)
      from public.analysis_job_identity_snapshot identity
      where identity.job_id=p_job_id
    ), '[]'::jsonb),
    'previous_repository_heads', coalesce(job.previous_repository_heads, jsonb_build_object(
      'kdmanage-backend',null,'kdmanage-frontend',null,
      'tmanage-backend',null,'tmanage-frontend',null
    ))
  )
  from public.analysis_job job
  where job.id=p_job_id;
$$;

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
  v_previous_heads jsonb;
  v_payload jsonb;
begin
  v_job := public.assert_analysis_scope_job_writer(
    p_job_id,p_worker_id,array['PREPARING_CODE','PREPARING_SCOPE']
  );

  if v_job.attribution_rule_version_id is not null then
    select * into v_version
    from public.analysis_attribution_rule_version
    where id=v_job.attribution_rule_version_id and status='PUBLISHED';
  else
    select version.* into v_version
    from public.analysis_attribution_rule_set rule_set
    join public.analysis_attribution_rule_version version
      on version.id=rule_set.current_published_version_id
    where rule_set.rule_set_code='STORY_COMMIT_ATTRIBUTION'
      and rule_set.enabled and version.status='PUBLISHED';
  end if;
  if v_version.id is null then raise exception 'PUBLISHED_ATTRIBUTION_RULESET_REQUIRED'; end if;
  if v_version.ruleset_hash is distinct from public.attribution_rule_version_hash(v_version.id)
     or (v_job.ruleset_hash is not null and v_job.ruleset_hash is distinct from v_version.ruleset_hash) then
    raise exception 'ATTRIBUTION_RULESET_MISMATCH';
  end if;

  if v_job.previous_repository_heads is null then
    select jsonb_object_agg(repositories.repository_name, previous.head_sha order by repositories.repository_name)
    into v_previous_heads
    from (values
      ('kdmanage-backend'::text),('kdmanage-frontend'::text),
      ('tmanage-backend'::text),('tmanage-frontend'::text)
    ) repositories(repository_name)
    left join lateral (
      select coalesce(snapshot.head_sha,lower(snapshot.commit_sha)) as head_sha
      from public.analysis_job prior_job
      join public.analysis_repository_snapshot snapshot on snapshot.job_id=prior_job.id
      where prior_job.id<>v_job.id
        and prior_job.analysis_context_version=2
        and prior_job.status='SUCCEEDED'
        and prior_job.requested_branch=v_job.requested_branch
        and prior_job.created_at<v_job.created_at
        and snapshot.repository_name=repositories.repository_name
        and coalesce(snapshot.head_sha,lower(snapshot.commit_sha)) is not null
      order by prior_job.finished_at desc nulls last,prior_job.created_at desc,prior_job.id desc
      limit 1
    ) previous on true;
    update public.analysis_job
    set previous_repository_heads=v_previous_heads
    where id=p_job_id
    returning * into v_job;
  end if;

  if exists(select 1 from public.analysis_job_story_snapshot where job_id=p_job_id) then
    select story_input_catalog_hash,identity_snapshot_hash
      into v_story_hash,v_identity_hash
    from public.analysis_job where id=p_job_id;
    update public.analysis_job
    set status='PREPARING_SCOPE',scope_status='PREPARING',
        scope_requested_at=coalesce(scope_requested_at,now()),locked_at=now()
    where id=p_job_id and status in ('PREPARING_CODE','PREPARING_SCOPE');
    v_payload:=public.analysis_job_frozen_scope_input_payload(p_job_id);
    return jsonb_build_object(
      'story_input_catalog_hash',v_story_hash,
      'identity_snapshot_hash',v_identity_hash,
      'rule_version_id',v_version.id,
      'ruleset_hash',v_version.ruleset_hash,
      'idempotent',true
    ) || v_payload;
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
  where developer.status<>'DISABLED' and git.verification_status<>'DISABLED'
    and git.valid_from<=now() and (git.valid_until is null or git.valid_until>now())
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
  set status='PREPARING_SCOPE',scope_status='PREPARING',
      scope_requested_at=coalesce(scope_requested_at,now()),locked_at=now(),
      attribution_rule_version_id=v_version.id,ruleset_hash=v_version.ruleset_hash,
      story_input_catalog_hash=v_story_hash,identity_snapshot_hash=v_identity_hash,
      attribution_algorithm_version=coalesce(attribution_algorithm_version,'story-attribution-v2')
  where id=p_job_id;

  v_payload:=public.analysis_job_frozen_scope_input_payload(p_job_id);
  return jsonb_build_object(
    'story_input_catalog_hash',v_story_hash,
    'identity_snapshot_hash',v_identity_hash,
    'rule_version_id',v_version.id,
    'ruleset_hash',v_version.ruleset_hash,
    'idempotent',false
  ) || v_payload;
end;
$$;

------------------------------------------------------------------------------
-- 2. PREPARING_SCOPE lease/reclaim：同 HEAD 续跑；HEAD 漂移时 fail closed。
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
  if p_worker_id is null or btrim(p_worker_id)='' then raise exception 'worker_id is required'; end if;
  if p_lease_seconds is null or p_lease_seconds<30 then p_lease_seconds:=900; end if;

  select job.* into v_job
  from public.analysis_job job
  where job.execution_engine='deepseek-harness-acp'
    and (
      job.status='QUEUED'
      or (job.status in ('PREPARING_CODE','PREPARING_SCOPE')
          and (job.locked_at is null
               or job.locked_at+make_interval(secs=>p_lease_seconds)<now()))
    )
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
  order by job.created_at,job.id
  for update skip locked
  limit 1;

  if v_job.id is null then return null; end if;

  update public.analysis_job
  set status='PREPARING_CODE',worker_id=p_worker_id,attempt=attempt+1,
      locked_at=now(),started_at=coalesce(started_at,now())
  where id=v_job.id
  returning * into v_job;

  if v_job.analysis_context_version=2 then
    select jsonb_build_object(
      'version_id',version.id,'version',version.version,
      'schema_version',version.schema_version,'hash',version.ruleset_hash,
      'config',version.canonical_config
    ) into v_ruleset
    from public.analysis_attribution_rule_version version
    where version.id=v_job.attribution_rule_version_id and version.status='PUBLISHED';
    if v_ruleset is null then raise exception 'PUBLISHED_ATTRIBUTION_RULESET_REQUIRED'; end if;
  end if;

  return jsonb_build_object(
    'job',jsonb_build_object(
      'id',v_job.id,'batch_id',v_job.batch_id,'model_config_id',v_job.model_config_id,
      'requested_branch',v_job.requested_branch,'total_stories',v_job.total_stories,
      'analysis_context_version',v_job.analysis_context_version,
      'commit_window_days',v_job.commit_window_days,
      'required_worker_scope_version',v_job.required_worker_scope_version
    ),
    'model',v_job.model_snapshot,
    'analysis_context_version',v_job.analysis_context_version,
    'window',jsonb_build_object('days',v_job.commit_window_days,'requested_at',v_job.scope_requested_at),
    'ruleset',v_ruleset
  );
end;
$$;

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
  v_existing_inputs boolean;
begin
  select * into v_job from public.analysis_job where id=p_job_id for update;
  if v_job.id is null then raise exception 'job not found'; end if;
  if v_job.execution_engine<>'deepseek-harness-acp' then raise exception 'LEGACY_ENGINE_RETIRED'; end if;
  if v_job.status not in ('PREPARING_CODE','PREPARING_SCOPE') then
    raise exception 'job is not in a preparation state';
  end if;
  if v_job.worker_id is distinct from p_worker_id then raise exception 'JOB_LEASE_LOST'; end if;
  if jsonb_typeof(p_snapshots)<>'array' or jsonb_array_length(p_snapshots)<>4 then
    raise exception 'exactly 4 repository snapshots are required';
  end if;
  if (select count(distinct value->>'repository_name') from jsonb_array_elements(p_snapshots) value)<>4
     or exists(
       select 1 from jsonb_array_elements(p_snapshots) value
       where value->>'repository_name' not in (
         'kdmanage-backend','kdmanage-frontend','tmanage-backend','tmanage-frontend'
       ) or lower(coalesce(value->>'commit_sha','')) !~ '^[0-9a-f]{40}([0-9a-f]{24})?$'
     ) then
    raise exception 'REPOSITORY_SNAPSHOT_SET_INVALID';
  end if;

  select exists(select 1 from public.analysis_job_story_snapshot where job_id=p_job_id)
  into v_existing_inputs;

  -- PREPARING_SCOPE 被接管或 HTTP 重试时，保留已经冻结的 commit/scope/audit。
  -- 只有四仓 HEAD 与第一次冻结完全一致才允许续跑；分支已移动则由 Worker 的
  -- catch 路径调用 fail_claimed_analysis_job，绝不混合两代输入。
  if v_job.analysis_context_version=2 and v_existing_inputs then
    if (select count(*) from public.analysis_repository_snapshot where job_id=p_job_id)<>4
       or exists(
         select 1
         from jsonb_array_elements(p_snapshots) value
         left join public.analysis_repository_snapshot snapshot
           on snapshot.job_id=p_job_id
          and snapshot.repository_name=value->>'repository_name'
         where snapshot.id is null
            or lower(snapshot.commit_sha)<>lower(value->>'commit_sha')
       ) then
      raise exception 'PREPARATION_RECLAIM_HEAD_MISMATCH';
    end if;
    update public.analysis_job set locked_at=now() where id=p_job_id;
    perform public.freeze_analysis_job_scope_inputs(p_job_id,p_worker_id);
    return;
  end if;

  delete from public.analysis_repository_snapshot where job_id=p_job_id;
  for v_snap in select * from jsonb_array_elements(p_snapshots)
  loop
    insert into public.analysis_repository_snapshot(
      job_id,repository_name,requested_branch,commit_sha,commit_subject,
      head_sha,head_resolved_at,enumeration_status,mr_enrichment_status
    ) values(
      p_job_id,v_snap->>'repository_name',
      coalesce(v_snap->>'requested_branch',v_job.requested_branch),
      lower(v_snap->>'commit_sha'),nullif(v_snap->>'commit_subject',''),
      case when v_job.analysis_context_version=2 then lower(v_snap->>'commit_sha') else null end,
      case when v_job.analysis_context_version=2 then now() else null end,
      case when v_job.analysis_context_version=2 then 'PENDING' else null end,
      'UNAVAILABLE'
    );
  end loop;

  if v_job.analysis_context_version=1 then
    update public.analysis_job set status='PROCESSING' where id=p_job_id;
  else
    perform public.freeze_analysis_job_scope_inputs(p_job_id,p_worker_id);
  end if;
end;
$$;

-- save_analysis_story_scopes 是单事务写全部 scope；客户端只丢回包时，第二次调用
-- 应按 catalog identity 返回成功，而不是删除已有 audit/candidate 再建。
create or replace function public.save_analysis_story_scopes(
  p_job_id uuid,
  p_worker_id text,
  p_algorithm_version text,
  p_scopes jsonb,
  p_scope_catalog_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.analysis_job; v_scope_input jsonb; v_candidate jsonb;
  v_scope_id uuid; v_task_id uuid; v_commit_id uuid; v_rule_id uuid;
  v_generation integer; v_scope_count integer:=0;
begin
  v_job:=public.assert_analysis_scope_job_writer(p_job_id,p_worker_id,array['PREPARING_SCOPE']);
  if p_algorithm_version is distinct from v_job.attribution_algorithm_version then
    raise exception 'ATTRIBUTION_ALGORITHM_MISMATCH';
  end if;
  if p_scope_catalog_hash !~ '^(sha256:)?[0-9a-f]{64}$' or jsonb_typeof(p_scopes)<>'array' then
    raise exception 'SCOPE_MANIFEST_INVALID';
  end if;
  if jsonb_array_length(p_scopes)<>(select count(*) from public.analysis_story_task where job_id=p_job_id) then
    raise exception 'ALL_STORY_SCOPES_REQUIRED';
  end if;

  if v_job.selected_scope_hash=p_scope_catalog_hash
     and (select count(*) from public.analysis_story_scope scope
          join public.analysis_story_task task on task.id=scope.task_id
          where task.job_id=p_job_id and scope.algorithm_version=p_algorithm_version)
         =(select count(*) from public.analysis_story_task where job_id=p_job_id) then
    return jsonb_build_object(
      'scope_count',jsonb_array_length(p_scopes),
      'scope_catalog_hash',p_scope_catalog_hash,'idempotent',true
    );
  end if;

  for v_scope_input in select * from jsonb_array_elements(p_scopes)
  loop
    v_task_id:=(v_scope_input->>'task_id')::uuid;
    v_generation:=coalesce((v_scope_input->>'generation')::integer,1);
    if not exists(select 1 from public.analysis_story_task where id=v_task_id and job_id=p_job_id) then
      raise exception 'SCOPE_TASK_JOB_MISMATCH';
    end if;
    if jsonb_array_length(coalesce(v_scope_input->'candidates','[]'::jsonb))>200 then
      raise exception 'STORY_CANDIDATE_LIMIT_EXCEEDED';
    end if;
    select id into v_scope_id from public.analysis_story_scope
    where task_id=v_task_id and generation=v_generation for update;
    if v_scope_id is not null then raise exception 'ANALYSIS_SCOPE_IDENTITY_CONFLICT'; end if;

    insert into public.analysis_story_scope(
      task_id,generation,scope_mode,status,current_scope_level,algorithm_version,ruleset_hash,
      candidate_manifest_hash,scope_error_code,degradation_reasons
    ) values(
      v_task_id,v_generation,v_scope_input->>'scope_mode',coalesce(v_scope_input->>'status','PREPARING'),
      coalesce(v_scope_input->>'current_scope_level',
        case when v_scope_input->>'scope_mode'='GLOBAL_FALLBACK' then 'GLOBAL' else 'PRIMARY' end),
      p_algorithm_version,v_job.ruleset_hash,v_scope_input->>'candidate_manifest_hash',
      nullif(v_scope_input->>'scope_error_code',''),
      array(select value from jsonb_array_elements_text(coalesce(v_scope_input->'degradation_reasons','[]'::jsonb)) value)
    ) returning id into v_scope_id;

    for v_candidate in select * from jsonb_array_elements(coalesce(v_scope_input->'candidates','[]'::jsonb))
    loop
      select repo_commit.id into v_commit_id
      from public.analysis_repository_commit repo_commit
      join public.analysis_repository_snapshot snapshot on snapshot.id=repo_commit.snapshot_id
      where snapshot.job_id=p_job_id and snapshot.repository_name=v_candidate->>'repository_name'
        and repo_commit.sha=lower(v_candidate->>'sha');
      if v_commit_id is null then raise exception 'CANDIDATE_COMMIT_NOT_IN_JOB_MANIFEST'; end if;
      select rule.id into v_rule_id from public.analysis_attribution_rule rule
      where rule.version_id=v_job.attribution_rule_version_id and rule.rule_code=v_candidate->>'rule_code';
      if v_candidate->>'selection_source'='RULE' and v_rule_id is null then
        raise exception 'CANDIDATE_RULE_NOT_IN_FROZEN_VERSION';
      end if;
      insert into public.analysis_story_commit_candidate(
        id,scope_id,task_id,generation,commit_id,tier,selection_source,rank_score,
        reason_codes,identity_match_type,story_match_location,matched_rule_id,effective_status
      ) values(
        (v_candidate->>'candidate_id')::uuid,v_scope_id,v_task_id,v_generation,v_commit_id,
        v_candidate->>'tier',v_candidate->>'selection_source',coalesce((v_candidate->>'rank_score')::numeric,0),
        array(select value from jsonb_array_elements_text(v_candidate->'reason_codes') value),
        nullif(v_candidate->>'identity_match_type',''),nullif(v_candidate->>'story_match_location',''),
        v_rule_id,coalesce(v_candidate->>'effective_status','UNKNOWN')
      );
      insert into public.analysis_scope_decision_audit(
        job_id,task_id,candidate_id,decision_type,source,reason_codes,after_state
      ) values(
        p_job_id,v_task_id,(v_candidate->>'candidate_id')::uuid,
        case when v_candidate->>'tier'='EXCLUDED' then 'AUTO_EXCLUDE' else 'AUTO_SELECT' end,
        'RULE_ENGINE',array(select value from jsonb_array_elements_text(v_candidate->'reason_codes') value),
        jsonb_build_object('tier',v_candidate->>'tier','generation',v_generation)
      );
    end loop;
    update public.analysis_story_scope scope set
      candidate_count=(select count(*) from public.analysis_story_commit_candidate c where c.scope_id=scope.id),
      strong_count=(select count(*) from public.analysis_story_commit_candidate c where c.scope_id=scope.id and c.tier='STRONG'),
      ai_candidate_count=(select count(*) from public.analysis_story_commit_candidate c where c.scope_id=scope.id and c.tier in ('AI_CANDIDATE','WEAK')),
      triage_required_count=(select count(*) from public.analysis_story_commit_candidate c where c.scope_id=scope.id and c.tier in ('AI_CANDIDATE','WEAK'))
    where scope.id=v_scope_id;
    v_scope_count:=v_scope_count+1;
  end loop;
  update public.analysis_job set selected_scope_hash=p_scope_catalog_hash,locked_at=now() where id=p_job_id;
  return jsonb_build_object('scope_count',v_scope_count,'scope_catalog_hash',p_scope_catalog_hash,'idempotent',false);
end;
$$;

------------------------------------------------------------------------------
-- 3. 最终 task claim：完整保留现行 V4/技能/模型语义，补齐 v2 identity。
------------------------------------------------------------------------------

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

------------------------------------------------------------------------------
-- 4. v2 scope 读取补齐冻结 Story hash/context；diff 只暴露安全 metadata。
------------------------------------------------------------------------------

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
  v_scope public.analysis_story_scope;
  v_story public.analysis_job_story_snapshot;
begin
  v_task:=public.assert_analysis_scope_task_claim(p_task_id,p_worker_id,p_claim_token);
  select * into v_scope from public.analysis_story_scope
  where task_id=p_task_id and frozen_at is not null
  order by generation desc limit 1;
  if v_scope.id is null then raise exception 'ANALYSIS_SCOPE_NOT_FROZEN'; end if;
  select snapshot.* into v_story
  from public.analysis_job_story_snapshot snapshot
  where snapshot.job_id=v_task.job_id and snapshot.story_id=v_task.story_id;
  if v_story.id is null then raise exception 'ANALYSIS_SCOPE_INPUTS_MISSING'; end if;

  return jsonb_build_object(
    'task_id',p_task_id,'generation',v_scope.generation,'scope_mode',v_scope.scope_mode,
    'status',v_scope.status,'current_scope_level',v_scope.current_scope_level,
    'algorithm_version',v_scope.algorithm_version,'ruleset_hash',v_scope.ruleset_hash,
    'candidate_manifest_hash',v_scope.candidate_manifest_hash,
    'story_input_hash',v_story.input_hash,
    'requirement_context',v_story.requirement_context,
    'scope_error_code',v_scope.scope_error_code,'degradation_reasons',v_scope.degradation_reasons,
    'candidate_count',v_scope.candidate_count,'strong_count',v_scope.strong_count,
    'ai_candidate_count',v_scope.ai_candidate_count,'triage_complete',v_scope.triage_complete,
    'candidates',coalesce((select jsonb_agg(jsonb_build_object(
      'candidate_id',candidate.id,'tier',candidate.tier,'rank_score',candidate.rank_score,
      'reason_codes',candidate.reason_codes,'repository',snapshot.repository_name,
      'short_sha',left(repo_commit.sha,12),'subject',repo_commit.subject,
      'author_name',repo_commit.author_name,'author_email_masked',repo_commit.author_email_masked,
      'committed_at',repo_commit.committed_at,'files_changed',repo_commit.files_changed,
      'additions',repo_commit.additions,'deletions',repo_commit.deletions,
      'effective_status',candidate.effective_status,
      'diff_status',coalesce(archive.status,'UNAVAILABLE')
    ) order by case candidate.tier when 'STRONG' then 1 when 'AI_CANDIDATE' then 2
        when 'WEAK' then 3 else 4 end,candidate.rank_score desc,candidate.id)
      from public.analysis_story_commit_candidate candidate
      join public.analysis_repository_commit repo_commit on repo_commit.id=candidate.commit_id
      join public.analysis_repository_snapshot snapshot on snapshot.id=repo_commit.snapshot_id
      left join public.analysis_commit_diff_archive archive
        on archive.commit_id=repo_commit.id and archive.job_id=v_task.job_id
      where candidate.scope_id=v_scope.id),'[]'::jsonb)
  );
end;
$$;

create or replace function public.get_story_commit_diff_archive_metadata(
  p_task_id uuid,
  p_worker_id text,
  p_claim_token uuid,
  p_candidate_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_task public.analysis_story_task;
  v_row jsonb;
begin
  v_task:=public.assert_analysis_scope_task_claim(p_task_id,p_worker_id,p_claim_token);
  select jsonb_build_object(
    'candidate_id',candidate.id,
    'repository_name',snapshot.repository_name,
    'commit_sha',repo_commit.sha,
    'status',coalesce(archive.status,'UNAVAILABLE'),
    'storage_bucket',archive.storage_bucket,
    'storage_object_prefix',archive.storage_object_prefix,
    'archive_sha256',archive.archive_sha256,
    'size_bytes',coalesce(archive.size_bytes,0),
    'chunk_count',coalesce(archive.chunk_count,0),
    'error_code',archive.error_code
  ) into v_row
  from public.analysis_story_scope scope
  join public.analysis_story_commit_candidate candidate on candidate.scope_id=scope.id
  join public.analysis_repository_commit repo_commit on repo_commit.id=candidate.commit_id
  join public.analysis_repository_snapshot snapshot on snapshot.id=repo_commit.snapshot_id
  left join public.analysis_commit_diff_archive archive
    on archive.commit_id=repo_commit.id and archive.job_id=v_task.job_id
  where scope.task_id=p_task_id and scope.frozen_at is not null
    and scope.generation=(select max(current_scope.generation)
      from public.analysis_story_scope current_scope
      where current_scope.task_id=p_task_id and current_scope.frozen_at is not null)
    and candidate.id=p_candidate_id
    and candidate.task_id=p_task_id;
  if v_row is null then raise exception 'CANDIDATE_TASK_MISMATCH'; end if;
  return v_row;
end;
$$;

------------------------------------------------------------------------------
-- 5. service-role 批量规范化身份匹配：raw email 不落库、不回显。
------------------------------------------------------------------------------

create or replace function public.match_analysis_git_identities(p_authors jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, vault, extensions
as $$
declare
  v_pepper text;
  v_item jsonb;
  v_email text;
  v_provider text;
  v_fingerprint text;
  v_domain text;
  v_input_id text;
  v_matches integer;
  v_match record;
  v_result jsonb:='[]'::jsonb;
begin
  if jsonb_typeof(p_authors)<>'array' or jsonb_array_length(p_authors)>1000 then
    raise exception 'IDENTITY_MATCH_INPUT_INVALID';
  end if;
  select secret.decrypted_secret into v_pepper
  from vault.decrypted_secrets secret
  where secret.name='analysis_identity_pepper'
  order by secret.created_at desc
  limit 1;
  if coalesce(v_pepper,'')='' then raise exception 'IDENTITY_PEPPER_MISSING'; end if;

  if exists(
    select 1
    from jsonb_array_elements(p_authors) item
    group by item->>'input_id'
    having item->>'input_id' is null or btrim(item->>'input_id')=''
       or count(*)>1
  ) then raise exception 'IDENTITY_MATCH_INPUT_ID_INVALID'; end if;

  for v_item in select * from jsonb_array_elements(p_authors)
  loop
    v_input_id:=v_item->>'input_id';
    v_email:=lower(btrim(coalesce(v_item->>'email','')));
    v_provider:=lower(btrim(coalesce(v_item->>'provider','gitlab')));
    if v_provider not in ('git','gitlab') then raise exception 'IDENTITY_PROVIDER_INVALID'; end if;
    if char_length(v_email)>320
       or v_email !~ '^[^@[:space:][:cntrl:]]{1,64}@[^@[:space:][:cntrl:]]{1,255}$' then
      raise exception 'IDENTITY_EMAIL_INVALID';
    end if;

    v_fingerprint:=encode(hmac(convert_to(v_email,'UTF8'),convert_to(v_pepper,'UTF8'),'sha256'),'hex');
    v_domain:=split_part(v_email,'@',2);
    select count(distinct identity.developer_identity_id) into v_matches
    from public.developer_git_identity identity
    join public.developer_identity developer on developer.id=identity.developer_identity_id
    where identity.provider=v_provider
      and identity.email_fingerprint=v_fingerprint
      and developer.status='VERIFIED'
      and identity.verification_status='VERIFIED'
      and identity.valid_from<=now()
      and (identity.valid_until is null or identity.valid_until>now());

    select identity.developer_identity_id as developer_id,
      developer.display_name,identity.verification_status,
      identity.author_name_aliases
    into v_match
    from public.developer_git_identity identity
    join public.developer_identity developer on developer.id=identity.developer_identity_id
    where identity.provider=v_provider
      and identity.email_fingerprint=v_fingerprint
      and developer.status='VERIFIED'
      and identity.verification_status='VERIFIED'
      and identity.valid_from<=now()
      and (identity.valid_until is null or identity.valid_until>now())
    order by identity.created_at,identity.id
    limit 1;

    v_result:=v_result||jsonb_build_array(jsonb_build_object(
      'input_id',v_input_id,
      'provider',v_provider,
      'email_fingerprint',v_fingerprint,
      'masked_email',left(v_email,1)||'***@'||v_domain,
      'match_status',case when v_matches=0 then 'UNMATCHED'
                          when v_matches=1 then 'MATCHED' else 'CONFLICT' end,
      'developer_id',case when v_matches=1 then v_match.developer_id else null end,
      'display_name',case when v_matches=1 then v_match.display_name else null end,
      'verification_status',case when v_matches=1 then v_match.verification_status else null end,
      'author_name_aliases',case when v_matches=1 then to_jsonb(v_match.author_name_aliases)
                                 else '[]'::jsonb end
    ));
  end loop;
  return v_result;
end;
$$;

------------------------------------------------------------------------------
-- 6. PREPARING_SCOPE 失败收敛：与 PREPARING_CODE 使用同一 worker_id fencing。
------------------------------------------------------------------------------

create or replace function public.fail_claimed_analysis_job(
  p_job_id uuid,
  p_worker_id text,
  p_error_code text,
  p_error_message text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_job public.analysis_job;
begin
  if p_worker_id is null or btrim(p_worker_id)='' then raise exception 'worker_id is required'; end if;
  select * into v_job from public.analysis_job where id=p_job_id for update;
  if v_job.id is null then raise exception 'job not found'; end if;
  if v_job.execution_engine<>'deepseek-harness-acp' then raise exception 'LEGACY_ENGINE_RETIRED'; end if;
  if v_job.status in ('SUCCEEDED','FAILED') then return; end if;

  if v_job.status in ('PREPARING_CODE','PREPARING_SCOPE') then
    if v_job.worker_id is distinct from p_worker_id then raise exception 'JOB_LEASE_LOST'; end if;
  elsif v_job.status='FINALIZING' then
    if v_job.finalizer_worker_id is distinct from p_worker_id
       or v_job.finalize_lease_expires_at is null
       or v_job.finalize_lease_expires_at<now() then
      raise exception 'JOB_LEASE_LOST';
    end if;
  else
    raise exception 'job is not in a worker-claimed state (status=%)',v_job.status;
  end if;

  update public.analysis_job
  set status='FAILED',scope_status=case when analysis_context_version=2 then 'FAILED' else scope_status end,
      scope_error_code=case when analysis_context_version=2 then p_error_code else scope_error_code end,
      error_code=p_error_code,error_message=p_error_message,finished_at=now()
  where id=p_job_id;
end;
$$;

------------------------------------------------------------------------------
-- 7. 最小权限。helper 不成为浏览器 API；两条新 Worker 通道仅 service_role。
------------------------------------------------------------------------------

revoke execute on function public.analysis_job_frozen_scope_input_payload(uuid)
  from public,anon,authenticated;
grant execute on function public.analysis_job_frozen_scope_input_payload(uuid) to service_role;

revoke execute on function public.assert_analysis_scope_job_writer(uuid,text,text[])
  from public,anon,authenticated;
grant execute on function public.assert_analysis_scope_job_writer(uuid,text,text[]) to service_role;

revoke execute on function public.freeze_analysis_job_scope_inputs(uuid,text)
  from public,anon,authenticated;
grant execute on function public.freeze_analysis_job_scope_inputs(uuid,text) to service_role;

revoke execute on function public.claim_job_for_preparation(text,integer)
  from public,anon,authenticated;
grant execute on function public.claim_job_for_preparation(text,integer) to service_role;

revoke execute on function public.save_repository_snapshots(uuid,text,jsonb)
  from public,anon,authenticated;
grant execute on function public.save_repository_snapshots(uuid,text,jsonb) to service_role;

revoke execute on function public.save_analysis_story_scopes(uuid,text,text,jsonb,text)
  from public,anon,authenticated;
grant execute on function public.save_analysis_story_scopes(uuid,text,text,jsonb,text) to service_role;

revoke execute on function public.claim_next_story_task(text,integer)
  from public,anon,authenticated;
grant execute on function public.claim_next_story_task(text,integer) to service_role;

revoke execute on function public.get_story_task_analysis_scope(uuid,text,uuid)
  from public,anon,authenticated;
grant execute on function public.get_story_task_analysis_scope(uuid,text,uuid) to service_role;

revoke execute on function public.get_story_commit_diff_archive_metadata(uuid,text,uuid,uuid)
  from public,anon,authenticated;
grant execute on function public.get_story_commit_diff_archive_metadata(uuid,text,uuid,uuid)
  to service_role;

revoke execute on function public.match_analysis_git_identities(jsonb)
  from public,anon,authenticated;
grant execute on function public.match_analysis_git_identities(jsonb) to service_role;

revoke execute on function public.fail_claimed_analysis_job(uuid,text,text,text)
  from public,anon,authenticated;
grant execute on function public.fail_claimed_analysis_job(uuid,text,text,text) to service_role;

revoke execute on function public.enforce_analysis_job_scope_identity_immutable()
  from public,anon,authenticated;

comment on function public.match_analysis_git_identities(jsonb) is
  'Service-role batch normalization/matching. Raw email exists only in call memory; output contains fingerprint and masked email, never raw email.';
comment on function public.get_story_commit_diff_archive_metadata(uuid,text,uuid,uuid) is
  'Claim-fenced immutable diff archive metadata. Returns no body and no signed URL; Worker performs controlled service-role Storage reads.';
comment on column public.analysis_job.previous_repository_heads is
  'Four repository heads frozen when V2 scope inputs are first frozen; never recomputed for an existing Job.';

commit;
