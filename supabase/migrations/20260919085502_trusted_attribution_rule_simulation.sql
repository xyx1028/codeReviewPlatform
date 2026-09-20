-- V1.11 归属规则管理可信模拟闭环。
-- SYSTEM_SAFETY_CONTRACT_V1 只验证数据库安全契约，不评估效果、准确率或召回率。

begin;

alter table public.analysis_attribution_rule_test_run
  add column if not exists simulation_kind text,
  add column if not exists contract_version text,
  add column if not exists simulated_revision integer,
  add column if not exists simulated_ruleset_hash text,
  add column if not exists contract_result jsonb not null default '{}'::jsonb;

alter table public.analysis_attribution_rule_test_run
  drop constraint if exists analysis_attribution_rule_test_run_simulation_kind_check,
  add constraint analysis_attribution_rule_test_run_simulation_kind_check
    check (simulation_kind is null or simulation_kind in ('SYSTEM_SAFETY_CONTRACT')),
  drop constraint if exists analysis_attribution_rule_test_run_contract_version_check,
  add constraint analysis_attribution_rule_test_run_contract_version_check
    check (contract_version is null or contract_version = 'SYSTEM_SAFETY_CONTRACT_V1'),
  drop constraint if exists analysis_attribution_rule_test_run_simulated_revision_check,
  add constraint analysis_attribution_rule_test_run_simulated_revision_check
    check (simulated_revision is null or simulated_revision >= 1),
  drop constraint if exists analysis_attribution_rule_test_run_simulated_hash_check,
  add constraint analysis_attribution_rule_test_run_simulated_hash_check
    check (simulated_ruleset_hash is null or simulated_ruleset_hash ~ '^(sha256:)?[0-9a-f]{64}$');

create index if not exists idx_attribution_rule_test_trusted_revision
on public.analysis_attribution_rule_test_run(
  version_id, simulation_kind, contract_version, simulated_revision, executed_at desc
);

create or replace function public.attribution_rule_system_projection_hash(p_version_id uuid)
returns text
language sql
stable
set search_path = public, extensions
as $$
  select encode(digest(convert_to(coalesce(jsonb_agg(jsonb_build_object(
    'ruleCode',rule.rule_code,
    'displayName',rule.display_name,
    'description',rule.description,
    'priority',rule.priority,
    'enabled',rule.enabled,
    'capability',rule.capability,
    'when',rule.condition_tree,
    'action',jsonb_build_object('type',rule.action_type,'reasonCode',rule.reason_code),
    'systemLocked',rule.system_locked,
    'sortOrder',rule.sort_order
  ) order by rule.priority desc,rule.sort_order,rule.rule_code collate "C"),'[]'::jsonb)::text,'UTF8'),'sha256'),'hex')
  from public.analysis_attribution_rule rule
  where rule.version_id=p_version_id and rule.system_locked;
$$;

create or replace function public.attribution_rule_safety_contract_v1_sample_hash()
returns text
language sql
immutable
set search_path = public, extensions
as $$
  select encode(digest(convert_to(
    'SYSTEM_SAFETY_CONTRACT_V1|system=4669d4537bd82a172e7ebe438eff4e3c560f0a6b3775fb69f12561fed93c5d5b|actions=ADD_AI_CANDIDATE,DOWNRANK_CANDIDATE|priority=300..500|schema=1',
    'UTF8'),'sha256'),'hex');
$$;

create or replace function public.attribution_rule_safety_contract_v1(p_version_id uuid)
returns jsonb
language plpgsql
stable
set search_path = public
as $$
declare
  v_version public.analysis_attribution_rule_version;
  v_rule public.analysis_attribution_rule;
  v_condition jsonb;
  v_conditions jsonb;
  v_issues jsonb := '[]'::jsonb;
  v_system_count integer := 0;
  v_custom_count integer := 0;
  v_condition_count integer := 0;
  v_system_hash text;
  v_expected_system_hash constant text := '4669d4537bd82a172e7ebe438eff4e3c560f0a6b3775fb69f12561fed93c5d5b';
  v_field text;
  v_operator text;
begin
  select * into v_version
  from public.analysis_attribution_rule_version
  where id=p_version_id;
  if v_version.id is null then raise exception 'RULE_VERSION_NOT_FOUND'; end if;

  select count(*) into v_system_count
  from public.analysis_attribution_rule
  where version_id=p_version_id and system_locked;
  v_system_hash := public.attribution_rule_system_projection_hash(p_version_id);

  if v_system_count <> 13 then
    v_issues := v_issues || jsonb_build_array(jsonb_build_object(
      'code','SYSTEM_RULE_SET_INCOMPLETE','message','固定系统规则必须完整保留 13 条。'));
  end if;
  if v_system_hash is distinct from v_expected_system_hash then
    v_issues := v_issues || jsonb_build_array(jsonb_build_object(
      'code','SYSTEM_RULE_CONTRACT_MISMATCH','message','系统锁定规则与 SYSTEM_SAFETY_CONTRACT_V1 不一致。'));
  end if;

  for v_rule in
    select * from public.analysis_attribution_rule
    where version_id=p_version_id and not system_locked
    order by rule_code collate "C"
  loop
    v_custom_count := v_custom_count + 1;
    if v_rule.action_type not in ('ADD_AI_CANDIDATE','DOWNRANK_CANDIDATE') then
      v_issues := v_issues || jsonb_build_array(jsonb_build_object(
        'code','CUSTOM_RULE_ACTION_FORBIDDEN','message','管理员规则只能加入 AI 候选或降低候选优先级。','rule_id',v_rule.id));
    end if;
    if v_rule.priority not between 300 and 500 then
      v_issues := v_issues || jsonb_build_array(jsonb_build_object(
        'code','CUSTOM_PRIORITY_OUT_OF_RANGE','message','管理员规则优先级必须位于 300–500。','rule_id',v_rule.id));
    end if;
    if v_rule.capability not in ('GIT_BASE','MR_OPTIONAL') then
      v_issues := v_issues || jsonb_build_array(jsonb_build_object(
        'code','CUSTOM_CAPABILITY_FORBIDDEN','message','管理员规则不能声明系统安全能力。','rule_id',v_rule.id));
    end if;

    if jsonb_typeof(v_rule.condition_tree) <> 'object'
       or ((v_rule.condition_tree ? 'all') = (v_rule.condition_tree ? 'any'))
       or (v_rule.condition_tree - 'all' - 'any') <> '{}'::jsonb then
      v_issues := v_issues || jsonb_build_array(jsonb_build_object(
        'code','CUSTOM_CONDITION_TREE_INVALID','message','条件树必须且只能包含非空 all 或 any 条件组。','rule_id',v_rule.id));
      continue;
    end if;

    v_conditions := case when v_rule.condition_tree ? 'all'
      then v_rule.condition_tree->'all' else v_rule.condition_tree->'any' end;
    if jsonb_typeof(v_conditions) <> 'array'
       or jsonb_array_length(v_conditions) not between 1 and 20 then
      v_issues := v_issues || jsonb_build_array(jsonb_build_object(
        'code','CUSTOM_CONDITION_LIST_INVALID','message','管理员规则必须包含 1–20 个受控条件。','rule_id',v_rule.id));
      continue;
    end if;

    for v_condition in select item from jsonb_array_elements(v_conditions) as condition(item)
    loop
      v_condition_count := v_condition_count + 1;
      if jsonb_typeof(v_condition) <> 'object'
         or (v_condition - 'field' - 'operator' - 'value') <> '{}'::jsonb then
        v_issues := v_issues || jsonb_build_array(jsonb_build_object(
          'code','CUSTOM_CONDITION_INVALID','message','条件只能包含 field、operator 和可选 value。','rule_id',v_rule.id));
        continue;
      end if;
      v_field := v_condition->>'field';
      v_operator := v_condition->>'operator';
      if v_field not in (
        'story.current_code','story.other_codes','commit.structured_story_ids','commit.story_tokens',
        'commit.body_story_tokens','commit.sha','commit.parent_shas','commit.reachability',
        'commit.author_identity','commit.committed_at','commit.files','commit.is_revert',
        'commit.reverted_sha','commit.is_bot','commit.is_generated','commit.mr_membership',
        'commit.support_signal','mr.capability_status','mr.structured_story_ids',
        'repository.enumeration_status','identity.status','scope.candidate_count','scope.rule_conflict'
      ) then
        v_issues := v_issues || jsonb_build_array(jsonb_build_object(
          'code','CUSTOM_RULE_FIELD_FORBIDDEN','message','管理员规则使用了未授权字段。','rule_id',v_rule.id));
      end if;
      if v_operator not in (
        'EXACT_CURRENT_STORY_TOKEN','EXACT_OTHER_STORY_TOKEN','EQUALS','IN_ENUM',
        'VERIFIED_IDENTITY_MATCH','WITHIN_FROZEN_WINDOW','MODULE_OVERLAP',
        'BELONGS_TO_EXPLICIT_MR','REVERTS_RELATED_COMMIT','IS_TRUE','IS_FALSE'
      ) then
        v_issues := v_issues || jsonb_build_array(jsonb_build_object(
          'code','CUSTOM_RULE_OPERATOR_FORBIDDEN','message','管理员规则使用了未授权算子。','rule_id',v_rule.id));
      end if;
    end loop;
  end loop;

  return jsonb_build_object(
    'passed',jsonb_array_length(v_issues)=0,
    'contract_version','SYSTEM_SAFETY_CONTRACT_V1',
    'assessment_scope','DATABASE_SAFETY_CONTRACT_ONLY',
    'effect_metrics_evaluated',false,
    'system_rule_expected_count',13,
    'system_rule_count',v_system_count,
    'custom_rule_count',v_custom_count,
    'condition_count',v_condition_count,
    'expected_system_hash',v_expected_system_hash,
    'actual_system_hash',v_system_hash,
    'issues',v_issues
  );
end;
$$;

create or replace function public.admin_validate_attribution_rule_draft(p_draft_version_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_version public.analysis_attribution_rule_version;
  v_config jsonb;
  v_hash text;
  v_result jsonb;
  v_actor uuid := auth.uid();
begin
  perform public.ensure_admin();
  select * into v_version from public.analysis_attribution_rule_version
  where id=p_draft_version_id for update;
  if v_version.id is null or v_version.status not in ('DRAFT','VALIDATED') then
    raise exception 'RULE_DRAFT_NOT_EDITABLE';
  end if;

  v_config := public.attribution_rule_version_config(v_version.id);
  v_hash := public.attribution_rule_version_hash(v_version.id);
  v_result := public.attribution_rule_safety_contract_v1(v_version.id);

  if (v_result->>'passed')::boolean then
    update public.analysis_attribution_rule_version
    set status='VALIDATED',canonical_config=v_config,ruleset_hash=v_hash,validated_at=now()
    where id=v_version.id;
  else
    update public.analysis_attribution_rule_version
    set status='DRAFT',canonical_config=v_config,ruleset_hash=null,validated_at=null
    where id=v_version.id;
  end if;

  insert into public.analysis_attribution_rule_audit(
    rule_set_id,version_id,action,actor_id,after_state
  ) values (
    v_version.rule_set_id,v_version.id,'VALIDATE',v_actor,
    jsonb_build_object('revision',v_version.revision,'ruleset_hash',v_hash,'contract_result',v_result)
  );

  return jsonb_build_object(
    'valid',(v_result->>'passed')::boolean,
    'passed',(v_result->>'passed')::boolean,
    'ruleset_hash',case when (v_result->>'passed')::boolean then v_hash else null end,
    'revision',v_version.revision,
    'validated_revision',v_version.revision,
    'validated_at',case when (v_result->>'passed')::boolean then now() else null end,
    'issues',v_result->'issues'
  );
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
  v_actor uuid := auth.uid();
  v_config jsonb;
  v_hash text;
  v_contract jsonb;
  v_issues jsonb;
  v_metrics jsonb;
  v_passed boolean;
  v_run_id uuid;
  v_sample_hash text := public.attribution_rule_safety_contract_v1_sample_hash();
  v_blocking_reasons jsonb;
begin
  perform public.ensure_admin();
  if p_sample_set_id is distinct from 'SYSTEM_SAFETY_CONTRACT_V1' then
    raise exception 'RULE_SAMPLE_SET_NOT_ALLOWED';
  end if;

  select * into v_version from public.analysis_attribution_rule_version
  where id=p_draft_version_id for update;
  if v_version.id is null or v_version.status <> 'VALIDATED' then
    raise exception 'RULE_VERSION_NOT_VALIDATED';
  end if;
  if v_version.revision <> p_expected_revision then raise exception 'REVISION_CONFLICT'; end if;

  v_config := public.attribution_rule_version_config(v_version.id);
  v_hash := public.attribution_rule_version_hash(v_version.id);
  v_contract := public.attribution_rule_safety_contract_v1(v_version.id);
  v_issues := v_contract->'issues';

  if v_version.canonical_config is distinct from v_config then
    v_issues := v_issues || jsonb_build_array(jsonb_build_object(
      'code','CANONICAL_CONFIG_MISMATCH','message','已校验的规范配置与当前规则不一致。'));
  end if;
  if v_version.ruleset_hash is distinct from v_hash then
    v_issues := v_issues || jsonb_build_array(jsonb_build_object(
      'code','RULESET_HASH_MISMATCH','message','已校验 hash 与当前规则不一致。'));
  end if;

  v_passed := jsonb_array_length(v_issues)=0;
  v_metrics := jsonb_build_object(
    'effect_metrics_available',false,
    'system_rule_expected_count',(v_contract->>'system_rule_expected_count')::integer,
    'system_rule_count',(v_contract->>'system_rule_count')::integer,
    'custom_rule_count',(v_contract->>'custom_rule_count')::integer,
    'condition_count',(v_contract->>'condition_count')::integer,
    'failed_check_count',jsonb_array_length(v_issues)
  );
  select coalesce(jsonb_agg(issue->>'code' order by issue->>'code'),'[]'::jsonb)
  into v_blocking_reasons
  from jsonb_array_elements(v_issues) issue;

  insert into public.analysis_attribution_rule_test_run(
    version_id,sample_set_id,sample_set_hash,metrics,diff_summary,passed,failure_code,
    executed_by,simulation_kind,contract_version,simulated_revision,
    simulated_ruleset_hash,contract_result
  ) values (
    v_version.id,'SYSTEM_SAFETY_CONTRACT_V1',v_sample_hash,v_metrics,
    jsonb_build_object(
      'assessment_scope','DATABASE_SAFETY_CONTRACT_ONLY',
      'effect_metrics_evaluated',false,
      'note','本结果不是效果、准确率或召回率评估。'
    ),v_passed,case when v_passed then null else 'SYSTEM_SAFETY_CONTRACT_FAILED' end,
    v_actor,'SYSTEM_SAFETY_CONTRACT','SYSTEM_SAFETY_CONTRACT_V1',v_version.revision,
    v_hash,jsonb_set(v_contract,'{issues}',v_issues)
  ) returning id into v_run_id;

  insert into public.analysis_attribution_rule_audit(
    rule_set_id,version_id,action,actor_id,after_state
  ) values (
    v_version.rule_set_id,v_version.id,'SIMULATE',v_actor,
    jsonb_build_object(
      'test_run_id',v_run_id,'passed',v_passed,'revision',v_version.revision,
      'ruleset_hash',v_hash,'contract_version','SYSTEM_SAFETY_CONTRACT_V1'
    )
  );

  return jsonb_build_object(
    'test_run_id',v_run_id,
    'passed',v_passed,
    'evaluation_kind','SYSTEM_SAFETY_CONTRACT',
    'contract_version','SYSTEM_SAFETY_CONTRACT_V1',
    'assessment_note','仅检查数据库安全契约，不评估规则效果、准确率或召回率。',
    'sample_set_id','SYSTEM_SAFETY_CONTRACT_V1',
    'sample_set_label','系统安全契约 V1（非效果/召回率评估）',
    'simulated_revision',v_version.revision,
    'simulated_ruleset_hash',v_hash,
    'simulated_at',now(),
    'metrics',v_metrics,
    'contract_checks',jsonb_build_object(
      'system_rule_expected_count',(v_contract->>'system_rule_expected_count')::integer,
      'system_rule_count',(v_contract->>'system_rule_count')::integer,
      'custom_rule_count',(v_contract->>'custom_rule_count')::integer,
      'condition_count',(v_contract->>'condition_count')::integer,
      'failed_check_count',jsonb_array_length(v_issues)
    ),
    'blocking_reasons',v_blocking_reasons
  );
end;
$$;

create or replace function public.admin_publish_attribution_rule_version(
  p_draft_version_id uuid,
  p_expected_revision integer,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_version public.analysis_attribution_rule_version;
  v_actor uuid := auth.uid();
  v_hash text;
  v_contract jsonb;
  v_sample_hash text := public.attribution_rule_safety_contract_v1_sample_hash();
begin
  perform public.ensure_admin();
  select * into v_version from public.analysis_attribution_rule_version
  where id=p_draft_version_id for update;
  if v_version.id is null or v_version.status <> 'VALIDATED' then
    raise exception 'RULE_VERSION_NOT_VALIDATED';
  end if;
  if v_version.revision <> p_expected_revision then raise exception 'REVISION_CONFLICT'; end if;
  if coalesce(btrim(p_reason),'')='' then raise exception 'PUBLISH_REASON_REQUIRED'; end if;

  v_hash := public.attribution_rule_version_hash(v_version.id);
  v_contract := public.attribution_rule_safety_contract_v1(v_version.id);
  if not (v_contract->>'passed')::boolean then raise exception 'SYSTEM_SAFETY_CONTRACT_FAILED'; end if;
  if v_version.canonical_config is distinct from public.attribution_rule_version_config(v_version.id)
     or v_version.ruleset_hash is distinct from v_hash then
    raise exception 'ATTRIBUTION_RULESET_MISMATCH';
  end if;
  if not exists (
    select 1 from public.analysis_attribution_rule_test_run test
    where test.version_id=v_version.id
      and test.simulation_kind='SYSTEM_SAFETY_CONTRACT'
      and test.contract_version='SYSTEM_SAFETY_CONTRACT_V1'
      and test.sample_set_id='SYSTEM_SAFETY_CONTRACT_V1'
      and test.sample_set_hash=v_sample_hash
      and test.simulated_revision=v_version.revision
      and test.simulated_ruleset_hash=v_hash
      and test.passed
  ) then
    raise exception 'RULE_SIMULATION_REQUIRED';
  end if;

  update public.analysis_attribution_rule_version
  set status='PUBLISHED',published_by=v_actor,published_at=now(),publish_reason=btrim(p_reason)
  where id=v_version.id;
  update public.analysis_attribution_rule_set
  set current_published_version_id=v_version.id,updated_at=now()
  where id=v_version.rule_set_id;
  insert into public.analysis_attribution_rule_audit(
    rule_set_id,version_id,action,actor_id,reason,after_state
  ) values (
    v_version.rule_set_id,v_version.id,'PUBLISH',v_actor,btrim(p_reason),
    jsonb_build_object(
      'ruleset_hash',v_hash,'revision',v_version.revision,
      'contract_version','SYSTEM_SAFETY_CONTRACT_V1'
    )
  );
  return jsonb_build_object(
    'version_id',v_version.id,'version',v_version.version,
    'revision',v_version.revision,'ruleset_hash',v_hash
  );
end;
$$;

create or replace function public.admin_restore_attribution_rule_version(
  p_source_version_id uuid,p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_source public.analysis_attribution_rule_version;
  v_actor uuid:=auth.uid();
  v_id uuid;
  v_next integer;
  v_contract jsonb;
begin
  perform public.ensure_admin();
  if coalesce(btrim(p_reason),'')='' then raise exception 'RESTORE_REASON_REQUIRED'; end if;
  select * into v_source from public.analysis_attribution_rule_version
  where id=p_source_version_id and status='PUBLISHED';
  if v_source.id is null then raise exception 'PUBLISHED_RULE_VERSION_NOT_FOUND'; end if;
  v_contract := public.attribution_rule_safety_contract_v1(v_source.id);
  if not (v_contract->>'passed')::boolean then raise exception 'SYSTEM_SAFETY_CONTRACT_FAILED'; end if;
  if v_source.canonical_config is distinct from public.attribution_rule_version_config(v_source.id)
     or v_source.ruleset_hash is distinct from public.attribution_rule_version_hash(v_source.id) then
    raise exception 'ATTRIBUTION_RULESET_MISMATCH';
  end if;

  select coalesce(max(version),0)+1 into v_next
  from public.analysis_attribution_rule_version
  where rule_set_id=v_source.rule_set_id;
  insert into public.analysis_attribution_rule_version(
    rule_set_id,version,status,revision,schema_version,canonical_config,ruleset_hash,
    source_version_id,created_by,validated_at,published_by,published_at,publish_reason
  ) values (
    v_source.rule_set_id,v_next,'PUBLISHED',1,1,v_source.canonical_config,v_source.ruleset_hash,
    v_source.id,v_actor,now(),v_actor,now(),btrim(p_reason)
  ) returning id into v_id;
  insert into public.analysis_attribution_rule(
    version_id,rule_code,display_name,description,priority,enabled,capability,
    condition_tree,action_type,reason_code,system_locked,sort_order
  ) select v_id,rule_code,display_name,description,priority,enabled,capability,
    condition_tree,action_type,reason_code,system_locked,sort_order
  from public.analysis_attribution_rule where version_id=v_source.id;
  update public.analysis_attribution_rule_set
  set current_published_version_id=v_id,updated_at=now()
  where id=v_source.rule_set_id;
  insert into public.analysis_attribution_rule_audit(
    rule_set_id,version_id,action,actor_id,reason,after_state
  ) values (
    v_source.rule_set_id,v_id,'RESTORE',v_actor,btrim(p_reason),
    jsonb_build_object(
      'source_version_id',v_source.id,'ruleset_hash',v_source.ruleset_hash,
      'contract_version','SYSTEM_SAFETY_CONTRACT_V1'
    )
  );
  return jsonb_build_object(
    'version_id',v_id,'version',v_next,'revision',1,
    'ruleset_hash',v_source.ruleset_hash
  );
end;
$$;

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
                'field',condition.item->>'field',
                'operator',condition.item->>'operator',
                'value',condition.item->'value'
              )) order by condition.ordinality)
              from jsonb_array_elements(case
                when rule.condition_tree ? 'all' then rule.condition_tree->'all'
                else rule.condition_tree->'any' end
              ) with ordinality as condition(item,ordinality)
            ),'[]'::jsonb),
            'action',jsonb_build_object('type',rule.action_type,'reason_code',rule.reason_code),
            'system_locked',rule.system_locked
          ) order by rule.priority desc,rule.sort_order,rule.rule_code collate "C")
          from public.analysis_attribution_rule rule
          where rule.version_id=version.id
        ),'[]'::jsonb),
        'validation',case when version.validated_at is null then null else jsonb_build_object(
          'passed',true,'validated_revision',version.revision,'issues','[]'::jsonb,
          'validated_at',version.validated_at
        ) end,
        'latest_simulation',(
          select jsonb_build_object(
            'passed',test.passed,
            'evaluation_kind','SYSTEM_SAFETY_CONTRACT',
            'contract_version',test.contract_version,
            'assessment_note','仅检查数据库安全契约，不评估规则效果、准确率或召回率。',
            'sample_set_id',test.sample_set_id,
            'sample_set_label','系统安全契约 V1（非效果/召回率评估）',
            'simulated_revision',test.simulated_revision,
            'simulated_ruleset_hash',test.simulated_ruleset_hash,
            'simulated_at',test.executed_at,
            'metrics',test.metrics,
            'contract_checks',jsonb_build_object(
              'system_rule_expected_count',coalesce((test.metrics->>'system_rule_expected_count')::integer,13),
              'system_rule_count',coalesce((test.metrics->>'system_rule_count')::integer,0),
              'custom_rule_count',coalesce((test.metrics->>'custom_rule_count')::integer,0),
              'condition_count',coalesce((test.metrics->>'condition_count')::integer,0),
              'failed_check_count',coalesce((test.metrics->>'failed_check_count')::integer,0)
            ),
            'blocking_reasons',coalesce((select jsonb_agg(issue->>'code' order by issue->>'code')
              from jsonb_array_elements(test.contract_result->'issues') issue),'[]'::jsonb)
          )
          from public.analysis_attribution_rule_test_run test
          where test.version_id=version.id
            and test.simulation_kind='SYSTEM_SAFETY_CONTRACT'
            and test.contract_version='SYSTEM_SAFETY_CONTRACT_V1'
            and test.simulated_revision=version.revision
            and test.simulated_ruleset_hash=version.ruleset_hash
          order by test.executed_at desc,test.id desc limit 1
        ),
        'created_by_name',(select coalesce(profile.display_name,auth_user.email)
          from auth.users auth_user left join public.user_profile profile on profile.id=auth_user.id
          where auth_user.id=version.created_by),
        'created_at',version.created_at,
        'published_by_name',(select coalesce(profile.display_name,auth_user.email)
          from auth.users auth_user left join public.user_profile profile on profile.id=auth_user.id
          where auth_user.id=version.published_by),
        'published_at',version.published_at,
        'publish_reason',version.publish_reason,
        'referenced_job_count',(select count(*) from public.analysis_job job
          where job.attribution_rule_version_id=version.id)
      ) order by
        case version.status when 'VALIDATED' then 0 when 'DRAFT' then 1 else 2 end,
        version.version desc,version.created_at desc
      )
      from public.analysis_attribution_rule_version version
      where version.rule_set_id=rule_set.id
    ),'[]'::jsonb),
    'sample_sets',jsonb_build_array(jsonb_build_object(
      'id','SYSTEM_SAFETY_CONTRACT_V1',
      'label','系统安全契约 V1（非效果/召回率评估）',
      'frozen_at','2026-09-19T08:55:02Z',
      'story_count',0,
      'commit_count',0,
      'evaluation_kind','SYSTEM_SAFETY_CONTRACT',
      'description','只检查系统规则完整性及自定义规则的动作、字段、算子、优先级、revision 与 hash。'
    )),
    'mr_enhanced_available',false
  ) into v_catalog
  from public.analysis_attribution_rule_set rule_set
  where rule_set.rule_set_code='STORY_COMMIT_ATTRIBUTION';
  return v_catalog;
end;
$$;

revoke execute on function public.attribution_rule_system_projection_hash(uuid) from public, anon, authenticated;
grant execute on function public.attribution_rule_system_projection_hash(uuid) to service_role;
revoke execute on function public.attribution_rule_safety_contract_v1_sample_hash() from public, anon, authenticated;
grant execute on function public.attribution_rule_safety_contract_v1_sample_hash() to service_role;
revoke execute on function public.attribution_rule_safety_contract_v1(uuid) from public, anon, authenticated;
grant execute on function public.attribution_rule_safety_contract_v1(uuid) to service_role;
revoke execute on function public.admin_validate_attribution_rule_draft(uuid) from public, anon;
grant execute on function public.admin_validate_attribution_rule_draft(uuid) to authenticated;
revoke execute on function public.admin_simulate_attribution_rule_draft(uuid,integer,text) from public, anon;
grant execute on function public.admin_simulate_attribution_rule_draft(uuid,integer,text) to authenticated;
revoke execute on function public.admin_publish_attribution_rule_version(uuid,integer,text) from public, anon;
grant execute on function public.admin_publish_attribution_rule_version(uuid,integer,text) to authenticated;
revoke execute on function public.admin_restore_attribution_rule_version(uuid,text) from public, anon;
grant execute on function public.admin_restore_attribution_rule_version(uuid,text) to authenticated;
revoke execute on function public.admin_get_attribution_rule_catalog() from public, anon;
grant execute on function public.admin_get_attribution_rule_catalog() to authenticated;

comment on function public.admin_simulate_attribution_rule_draft(uuid,integer,text) is
  'ADMIN-only database safety-contract simulation. Accepts only SYSTEM_SAFETY_CONTRACT_V1; caller cannot submit passed, metrics, revision hash, or test rows.';
comment on function public.attribution_rule_safety_contract_v1(uuid) is
  'Fixed V1 database safety contract; this is not an effectiveness, accuracy, or recall evaluation.';

commit;
