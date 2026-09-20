-- V1.11 归属规则草稿保存契约收敛。
-- 本迁移晚于可信模拟迁移；不回改已经应用的历史迁移。

begin;

create or replace function public.admin_save_attribution_rule_draft(
  p_draft_version_id uuid,
  p_expected_revision integer,
  p_rules jsonb
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_version public.analysis_attribution_rule_version;
  v_rule jsonb;
  v_condition jsonb;
  v_conditions jsonb;
  v_existing public.analysis_attribution_rule;
  v_actor uuid := auth.uid();
  v_before jsonb;
  v_contract jsonb;
  v_field text;
  v_operator text;
begin
  perform public.ensure_admin();
  select * into v_version from public.analysis_attribution_rule_version
  where id=p_draft_version_id for update;
  if v_version.id is null or v_version.status not in ('DRAFT','VALIDATED') then
    raise exception 'RULE_DRAFT_NOT_EDITABLE';
  end if;
  if v_version.revision <> p_expected_revision then raise exception 'REVISION_CONFLICT'; end if;
  if jsonb_typeof(p_rules) <> 'array'
     or jsonb_array_length(p_rules) < 13
     or jsonb_array_length(p_rules) > 100 then
    raise exception 'RULE_LIST_INVALID';
  end if;
  v_before := public.attribution_rule_version_config(v_version.id);

  for v_rule in select value from jsonb_array_elements(p_rules)
  loop
    if jsonb_typeof(v_rule) <> 'object' then raise exception 'RULE_INVALID'; end if;
    if coalesce(v_rule->>'ruleCode','') !~ '^ATTR_[A-Z0-9_]{3,80}$' then
      raise exception 'RULE_CODE_INVALID';
    end if;

    if coalesce((v_rule->>'systemLocked')::boolean,false) then
      select * into v_existing
      from public.analysis_attribution_rule
      where version_id=v_version.id
        and rule_code=v_rule->>'ruleCode'
        and system_locked;
      if v_existing.id is null then raise exception 'SYSTEM_RULE_UNKNOWN'; end if;
      if v_existing.action_type is distinct from v_rule->'action'->>'type'
         or v_existing.reason_code is distinct from v_rule->'action'->>'reasonCode'
         or v_existing.condition_tree is distinct from v_rule->'when'
         or v_existing.priority is distinct from (v_rule->>'priority')::integer then
        raise exception 'SYSTEM_RULE_IMMUTABLE';
      end if;
      continue;
    end if;

    if coalesce(btrim(v_rule->>'displayName'),'')=''
       or coalesce(btrim(v_rule->>'description'),'')='' then
      raise exception 'CUSTOM_RULE_TEXT_REQUIRED';
    end if;
    if (v_rule->>'priority')::integer not between 300 and 500 then
      raise exception 'CUSTOM_PRIORITY_OUT_OF_RANGE';
    end if;
    if coalesce(v_rule->>'capability','') not in ('GIT_BASE','MR_OPTIONAL') then
      raise exception 'CUSTOM_CAPABILITY_FORBIDDEN';
    end if;
    if coalesce(v_rule->'action'->>'type','') not in ('ADD_AI_CANDIDATE','DOWNRANK_CANDIDATE') then
      raise exception 'CUSTOM_RULE_ACTION_FORBIDDEN';
    end if;
    if coalesce(v_rule->'action'->>'reasonCode','') !~ '^[A-Z][A-Z0-9_]{2,80}$' then
      raise exception 'CUSTOM_REASON_CODE_INVALID';
    end if;
    if jsonb_typeof(v_rule->'when') <> 'object'
       or (((v_rule->'when') ? 'all') = ((v_rule->'when') ? 'any'))
       or ((v_rule->'when') - 'all' - 'any') <> '{}'::jsonb then
      raise exception 'CUSTOM_CONDITION_TREE_INVALID';
    end if;
    v_conditions := case when (v_rule->'when') ? 'all'
      then v_rule->'when'->'all' else v_rule->'when'->'any' end;
    if jsonb_typeof(v_conditions) <> 'array'
       or jsonb_array_length(v_conditions) not between 1 and 20 then
      raise exception 'CUSTOM_CONDITION_LIST_INVALID';
    end if;

    for v_condition in select value from jsonb_array_elements(v_conditions)
    loop
      if jsonb_typeof(v_condition) <> 'object'
         or (v_condition - 'field' - 'operator' - 'value') <> '{}'::jsonb then
        raise exception 'CUSTOM_CONDITION_INVALID';
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
      ) then raise exception 'CUSTOM_RULE_FIELD_FORBIDDEN'; end if;
      if v_operator not in (
        'EXACT_CURRENT_STORY_TOKEN','EXACT_OTHER_STORY_TOKEN','EQUALS','IN_ENUM',
        'VERIFIED_IDENTITY_MATCH','WITHIN_FROZEN_WINDOW','MODULE_OVERLAP',
        'BELONGS_TO_EXPLICIT_MR','REVERTS_RELATED_COMMIT','IS_TRUE','IS_FALSE'
      ) then raise exception 'CUSTOM_RULE_OPERATOR_FORBIDDEN'; end if;
    end loop;
  end loop;

  delete from public.analysis_attribution_rule
  where version_id=v_version.id and not system_locked;
  for v_rule in select value from jsonb_array_elements(p_rules)
  loop
    if not coalesce((v_rule->>'systemLocked')::boolean,false) then
      insert into public.analysis_attribution_rule(
        version_id,rule_code,display_name,description,priority,enabled,capability,
        condition_tree,action_type,reason_code,system_locked,sort_order
      ) values (
        v_version.id,v_rule->>'ruleCode',btrim(v_rule->>'displayName'),btrim(v_rule->>'description'),
        (v_rule->>'priority')::integer,coalesce((v_rule->>'enabled')::boolean,true),
        v_rule->>'capability',v_rule->'when',v_rule->'action'->>'type',
        v_rule->'action'->>'reasonCode',false,coalesce((v_rule->>'sortOrder')::integer,0)
      );
    end if;
  end loop;

  v_contract := public.attribution_rule_safety_contract_v1(v_version.id);
  if not (v_contract->>'passed')::boolean then
    raise exception 'SYSTEM_SAFETY_CONTRACT_FAILED';
  end if;

  update public.analysis_attribution_rule_version
  set status='DRAFT',revision=revision+1,
      canonical_config=public.attribution_rule_version_config(id),
      ruleset_hash=null,validated_at=null
  where id=v_version.id
  returning revision into p_expected_revision;
  insert into public.analysis_attribution_rule_audit(
    rule_set_id,version_id,action,actor_id,before_state,after_state
  ) values (
    v_version.rule_set_id,v_version.id,'SAVE_DRAFT',v_actor,
    v_before,public.attribution_rule_version_config(v_version.id)
  );
  return p_expected_revision;
end;
$$;

revoke execute on function public.admin_save_attribution_rule_draft(uuid,integer,jsonb)
  from public, anon;
grant execute on function public.admin_save_attribution_rule_draft(uuid,integer,jsonb)
  to authenticated;

comment on function public.admin_save_attribution_rule_draft(uuid,integer,jsonb) is
  'ADMIN-only optimistic draft save. System rules remain locked; custom rules are limited to candidate/downrank actions, priority 300..500 and SYSTEM_SAFETY_CONTRACT_V1 fields/operators.';

commit;
