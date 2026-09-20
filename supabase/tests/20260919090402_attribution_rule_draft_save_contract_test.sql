-- V1.11 归属规则草稿保存白名单收敛测试；事务内 rollback。

\set ON_ERROR_STOP on
\timing off
\set QUIET on

begin;
set local client_min_messages = warning;

create or replace function pg_temp.assert(p_cond boolean,p_msg text)
returns void language plpgsql as $$
begin
  if p_cond is null or not p_cond then raise exception 'ASSERT FAILED: %',p_msg; end if;
end;
$$;

insert into auth.users(id,email)
values('11110000-a000-4000-a000-000000000011','draft-save-admin@example.invalid')
on conflict(id) do nothing;
insert into public.user_profile(id,display_name,role)
values('11110000-a000-4000-a000-000000000011','草稿保存管理员','ADMIN')
on conflict(id) do update set display_name=excluded.display_name,role=excluded.role;

do $test$
declare
  v_admin uuid:='11110000-a000-4000-a000-000000000011';
  v_source uuid:='11110000-0000-4000-a000-000000000101';
  v_draft uuid;
  v_rules jsonb;
  v_good_custom jsonb;
  v_revision integer;
  v_error text;
begin
  perform pg_temp.assert(
    has_function_privilege('authenticated',
      'public.admin_save_attribution_rule_draft(uuid,integer,jsonb)','EXECUTE')
    and not has_function_privilege('anon',
      'public.admin_save_attribution_rule_draft(uuid,integer,jsonb)','EXECUTE'),
    'draft save is authenticated ADMIN-gated and unavailable to anon'
  );

  perform set_config('request.jwt.claims',json_build_object(
    'sub',v_admin::text,'role','authenticated')::text,true);
  v_draft:=public.admin_create_attribution_rule_draft(v_source);
  v_rules:=public.attribution_rule_version_config(v_draft)->'rules';
  v_good_custom:=jsonb_build_object(
    'ruleCode','ATTR_CUSTOM_TRUSTED_FIELDS',
    'displayName','可信字段候选规则',
    'description','只把受控线索加入 AI 候选。',
    'priority',300,
    'enabled',true,
    'capability','GIT_BASE',
    'when',jsonb_build_object('all',jsonb_build_array(
      jsonb_build_object('field','commit.support_signal','operator','IN_ENUM','value',jsonb_build_array('VERIFIED_AUTHOR')),
      jsonb_build_object('field','identity.status','operator','EQUALS','value','VERIFIED'),
      jsonb_build_object('field','scope.candidate_count','operator','EQUALS','value',0)
    )),
    'action',jsonb_build_object('type','ADD_AI_CANDIDATE','reasonCode','CUSTOM_TRUSTED_FIELDS'),
    'systemLocked',false,
    'sortOrder',1000
  );
  v_revision:=public.admin_save_attribution_rule_draft(
    v_draft,1,v_rules||jsonb_build_array(v_good_custom));
  perform pg_temp.assert(
    v_revision=2
    and exists(select 1 from public.analysis_attribution_rule
      where version_id=v_draft and rule_code='ATTR_CUSTOM_TRUSTED_FIELDS'
        and priority=300 and action_type='ADD_AI_CANDIDATE')
    and (public.attribution_rule_safety_contract_v1(v_draft)->>'passed')::boolean,
    'save accepts the complete database field/operator whitelist and preserves the fixed contract'
  );
  perform pg_temp.assert(
    (public.admin_validate_attribution_rule_draft(v_draft)->>'passed')::boolean
    and (public.admin_simulate_attribution_rule_draft(
      v_draft,2,'SYSTEM_SAFETY_CONTRACT_V1')->>'passed')::boolean,
    'saved custom candidate completes validate and trusted simulation'
  );

  -- 保存失败必须原子回滚，不增加 revision，也不覆盖已保存规则。
  begin
    perform public.admin_save_attribution_rule_draft(
      v_draft,2,v_rules||jsonb_build_array(v_good_custom||jsonb_build_object(
        'ruleCode','ATTR_CUSTOM_UNSAFE_ACTION',
        'action',jsonb_build_object('type','SELECT_STRONG','reasonCode','UNSAFE_ACTION')
      )));
    perform pg_temp.assert(false,'unsafe custom action must fail at save');
  exception when others then
    get stacked diagnostics v_error=message_text;
    perform pg_temp.assert(v_error like '%CUSTOM_RULE_ACTION_FORBIDDEN%',
      'unsafe action raises stable error, got: '||v_error);
  end;
  perform pg_temp.assert(
    (select revision=2 from public.analysis_attribution_rule_version where id=v_draft)
    and (select count(*)=1 from public.analysis_attribution_rule
      where version_id=v_draft and not system_locked),
    'rejected save leaves revision and prior custom rules unchanged'
  );

  begin
    perform public.admin_save_attribution_rule_draft(
      v_draft,2,v_rules||jsonb_build_array(v_good_custom||jsonb_build_object(
        'ruleCode','ATTR_CUSTOM_UNSAFE_PRIORITY','priority',299
      )));
    perform pg_temp.assert(false,'unsafe custom priority must fail at save');
  exception when others then
    get stacked diagnostics v_error=message_text;
    perform pg_temp.assert(v_error like '%CUSTOM_PRIORITY_OUT_OF_RANGE%',
      'unsafe priority raises stable error, got: '||v_error);
  end;

  begin
    perform public.admin_save_attribution_rule_draft(
      v_draft,2,v_rules||jsonb_build_array(v_good_custom||jsonb_build_object(
        'ruleCode','ATTR_CUSTOM_UNSAFE_FIELD',
        'when',jsonb_build_object('all',jsonb_build_array(
          jsonb_build_object('field','database.secret','operator','RUN_SCRIPT')
        ))
      )));
    perform pg_temp.assert(false,'unsafe custom field/operator must fail at save');
  exception when others then
    get stacked diagnostics v_error=message_text;
    perform pg_temp.assert(v_error like '%CUSTOM_RULE_FIELD_FORBIDDEN%'
      or v_error like '%CUSTOM_RULE_OPERATOR_FORBIDDEN%',
      'unsafe field/operator raises stable error, got: '||v_error);
  end;
end;
$test$;

rollback;
