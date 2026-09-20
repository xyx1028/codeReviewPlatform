-- V1.11 归属规则可信数据库安全契约模拟回归。
-- 全部测试位于事务内并 rollback，不保留用户、草稿、发布版本或测试记录。

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

insert into auth.users(id,email) values
  ('11110000-a000-4000-a000-000000000001','trusted-rule-admin@example.invalid'),
  ('11110000-a000-4000-a000-000000000002','trusted-rule-member@example.invalid')
on conflict(id) do nothing;
insert into public.user_profile(id,display_name,role) values
  ('11110000-a000-4000-a000-000000000001','规则管理员','ADMIN'),
  ('11110000-a000-4000-a000-000000000002','普通成员','REVIEWER')
on conflict(id) do update set display_name=excluded.display_name,role=excluded.role;

------------------------------------------------------------------------------
-- 1. 权限、固定样本与 catalog 草稿读模型
------------------------------------------------------------------------------

do $test$
declare
  v_catalog jsonb;
  v_error text;
  v_count integer;
begin
  perform pg_temp.assert(
    has_function_privilege('authenticated',
      'public.admin_simulate_attribution_rule_draft(uuid,integer,text)','EXECUTE'),
    'authenticated can invoke ADMIN-gated trusted simulation RPC'
  );
  perform pg_temp.assert(
    not has_function_privilege('anon',
      'public.admin_simulate_attribution_rule_draft(uuid,integer,text)','EXECUTE'),
    'anon cannot execute trusted simulation RPC'
  );
  perform pg_temp.assert(
    not has_function_privilege('authenticated',
      'public.admin_record_attribution_rule_test_run(uuid,uuid,text,text,jsonb,jsonb,boolean,text)','EXECUTE'),
    'browser cannot submit passed or metrics through the legacy trusted-writer RPC'
  );
  select count(*) into v_count
  from pg_proc proc join pg_namespace ns on ns.oid=proc.pronamespace
  where ns.nspname='public' and proc.proname='admin_simulate_attribution_rule_draft';
  perform pg_temp.assert(v_count=1,'there is exactly one simulation overload and it accepts no passed/metrics input');

  perform set_config('request.jwt.claims',json_build_object(
    'sub','11110000-a000-4000-a000-000000000002','role','authenticated')::text,true);
  begin
    perform public.admin_get_attribution_rule_catalog();
    perform pg_temp.assert(false,'non-admin catalog call must fail');
  exception when others then
    get stacked diagnostics v_error=message_text;
    perform pg_temp.assert(v_error like '%ADMIN_REQUIRED%' or lower(v_error) like '%admin%',
      'non-admin catalog is denied, got: '||v_error);
  end;

  perform set_config('request.jwt.claims',json_build_object(
    'sub','11110000-a000-4000-a000-000000000001','role','authenticated')::text,true);
  v_catalog:=public.admin_get_attribution_rule_catalog();
  perform pg_temp.assert(
    v_catalog->'sample_sets'->0->>'id'='SYSTEM_SAFETY_CONTRACT_V1'
    and v_catalog->'sample_sets'->0->>'evaluation_kind'='SYSTEM_SAFETY_CONTRACT'
    and (v_catalog->'sample_sets'->0->>'story_count')::integer=0
    and (v_catalog->'sample_sets'->0->>'commit_count')::integer=0,
    'catalog exposes the fixed safety contract and does not pretend to contain effect samples'
  );
  perform pg_temp.assert(
    v_catalog->'sample_sets'->0->>'description' like '%revision%hash%',
    'catalog explains revision/hash safety checks'
  );
end;
$test$;

------------------------------------------------------------------------------
-- 2. 真实闭环：创建可读草稿、校验、拒绝伪造测试、可信模拟、发布
------------------------------------------------------------------------------

do $test$
declare
  v_source uuid:='11110000-0000-4000-a000-000000000101';
  v_admin uuid:='11110000-a000-4000-a000-000000000001';
  v_draft uuid;
  v_catalog jsonb;
  v_valid jsonb;
  v_sim jsonb;
  v_publish jsonb;
  v_error text;
  v_test_count integer;
  v_audit_count integer;
begin
  perform set_config('request.jwt.claims',json_build_object(
    'sub',v_admin::text,'role','authenticated')::text,true);
  v_draft:=public.admin_create_attribution_rule_draft(v_source);
  v_catalog:=public.admin_get_attribution_rule_catalog();
  perform pg_temp.assert(exists(
    select 1 from jsonb_array_elements(v_catalog->'versions') version
    where (version->>'id')::uuid=v_draft
      and version->>'status'='DRAFT'
      and jsonb_array_length(version->'rules')=13
  ),'newly created draft is immediately readable from admin_get_attribution_rule_catalog');

  v_valid:=public.admin_validate_attribution_rule_draft(v_draft);
  perform pg_temp.assert(
    (v_valid->>'passed')::boolean
    and (v_valid->>'validated_revision')::integer=1
    and jsonb_array_length(v_valid->'issues')=0,
    'copied system baseline passes database safety validation'
  );

  -- 即使 trusted service-role 旧接口写入 passed=true，也不能满足新的数据库模拟发布门禁。
  perform public.admin_record_attribution_rule_test_run(
    v_admin,v_draft,'SYSTEM_SAFETY_CONTRACT_V1',repeat('1',64),
    jsonb_build_object('strong_false_positive_count',0),'{}'::jsonb,true,null
  );
  begin
    perform public.admin_publish_attribution_rule_version(v_draft,1,'legacy row must not publish');
    perform pg_temp.assert(false,'legacy/fabricated result must not unlock publish');
  exception when others then
    get stacked diagnostics v_error=message_text;
    perform pg_temp.assert(v_error like '%RULE_SIMULATION_REQUIRED%',
      'publish requires database-generated current-revision safety run, got: '||v_error);
  end;

  select count(*) into v_test_count from public.analysis_attribution_rule_test_run where version_id=v_draft;
  select count(*) into v_audit_count from public.analysis_attribution_rule_audit
  where version_id=v_draft and action='SIMULATE';
  v_sim:=public.admin_simulate_attribution_rule_draft(v_draft,1,'SYSTEM_SAFETY_CONTRACT_V1');
  perform pg_temp.assert(
    (v_sim->>'passed')::boolean
    and v_sim->>'evaluation_kind'='SYSTEM_SAFETY_CONTRACT'
    and v_sim->>'contract_version'='SYSTEM_SAFETY_CONTRACT_V1'
    and v_sim->>'assessment_note' like '%不评估规则效果%'
    and (v_sim->'metrics'->>'effect_metrics_available')::boolean=false
    and (v_sim->'contract_checks'->>'system_rule_count')::integer=13
    and (v_sim->'contract_checks'->>'failed_check_count')::integer=0,
    'database returns a real safety-contract result rather than an effect/recall claim'
  );
  perform pg_temp.assert(
    (select count(*) from public.analysis_attribution_rule_test_run where version_id=v_draft)=v_test_count+1
    and (select count(*) from public.analysis_attribution_rule_audit
      where version_id=v_draft and action='SIMULATE')=v_audit_count+1
    and exists(
      select 1
      from public.analysis_attribution_rule_test_run run
      join public.analysis_attribution_rule_audit audit
        on audit.version_id=run.version_id
       and audit.action='SIMULATE'
       and audit.after_state->>'test_run_id'=run.id::text
      where run.id=(v_sim->>'test_run_id')::uuid
        and run.simulation_kind='SYSTEM_SAFETY_CONTRACT'
        and run.contract_version='SYSTEM_SAFETY_CONTRACT_V1'
        and run.simulated_revision=1
        and run.simulated_ruleset_hash=(select ruleset_hash
          from public.analysis_attribution_rule_version where id=v_draft)
    ),'trusted simulation atomically appends its test fact and matching audit fact'
  );

  v_publish:=public.admin_publish_attribution_rule_version(v_draft,1,'可信数据库安全契约通过');
  perform pg_temp.assert(
    (v_publish->>'version_id')::uuid=v_draft
    and (select status='PUBLISHED' from public.analysis_attribution_rule_version where id=v_draft)
    and (select current_published_version_id=v_draft
      from public.analysis_attribution_rule_set where rule_set_code='STORY_COMMIT_ATTRIBUTION'),
    'current validated revision/hash publishes after trusted simulation'
  );
end;
$test$;

------------------------------------------------------------------------------
-- 3. 固定 sample id、revision/hash 绑定，保存后旧模拟失效
------------------------------------------------------------------------------

do $test$
declare
  v_admin uuid:='11110000-a000-4000-a000-000000000001';
  v_source uuid;
  v_draft uuid;
  v_rules jsonb;
  v_revision integer;
  v_error text;
begin
  perform set_config('request.jwt.claims',json_build_object(
    'sub',v_admin::text,'role','authenticated')::text,true);
  select current_published_version_id into v_source
  from public.analysis_attribution_rule_set where rule_set_code='STORY_COMMIT_ATTRIBUTION';
  v_draft:=public.admin_create_attribution_rule_draft(v_source);
  perform public.admin_validate_attribution_rule_draft(v_draft);

  begin
    perform public.admin_simulate_attribution_rule_draft(v_draft,1,'gold-v1');
    perform pg_temp.assert(false,'arbitrary sample id must be rejected');
  exception when others then
    get stacked diagnostics v_error=message_text;
    perform pg_temp.assert(v_error like '%RULE_SAMPLE_SET_NOT_ALLOWED%',
      'only fixed safety sample id is accepted, got: '||v_error);
  end;
  perform public.admin_simulate_attribution_rule_draft(v_draft,1,'SYSTEM_SAFETY_CONTRACT_V1');

  v_rules:=public.attribution_rule_version_config(v_draft)->'rules';
  v_revision:=public.admin_save_attribution_rule_draft(v_draft,1,v_rules);
  perform pg_temp.assert(v_revision=2,'saving the draft increments revision');
  perform public.admin_validate_attribution_rule_draft(v_draft);
  begin
    perform public.admin_simulate_attribution_rule_draft(v_draft,1,'SYSTEM_SAFETY_CONTRACT_V1');
    perform pg_temp.assert(false,'stale expected revision must fail');
  exception when others then
    get stacked diagnostics v_error=message_text;
    perform pg_temp.assert(v_error like '%REVISION_CONFLICT%',
      'stale simulation raises REVISION_CONFLICT, got: '||v_error);
  end;
  begin
    perform public.admin_publish_attribution_rule_version(v_draft,2,'old run must be stale');
    perform pg_temp.assert(false,'old revision simulation must not unlock publish');
  exception when others then
    get stacked diagnostics v_error=message_text;
    perform pg_temp.assert(v_error like '%RULE_SIMULATION_REQUIRED%',
      'publish is bound to current revision/hash, got: '||v_error);
  end;
  perform pg_temp.assert(
    (public.admin_simulate_attribution_rule_draft(v_draft,2,'SYSTEM_SAFETY_CONTRACT_V1')->>'passed')::boolean,
    'current revision can be simulated after re-validation'
  );
end;
$test$;

------------------------------------------------------------------------------
-- 4. system mutation 与 unsafe custom action/field/operator/priority 均由数据库识别
------------------------------------------------------------------------------

do $test$
declare
  v_admin uuid:='11110000-a000-4000-a000-000000000001';
  v_source uuid:='11110000-0000-4000-a000-000000000101';
  v_system_draft uuid;
  v_custom_draft uuid;
  v_valid jsonb;
  v_sim jsonb;
  v_codes text[];
  v_error text;
begin
  perform set_config('request.jwt.claims',json_build_object(
    'sub',v_admin::text,'role','authenticated')::text,true);

  v_system_draft:=public.admin_create_attribution_rule_draft(v_source);
  update public.analysis_attribution_rule set priority=899
  where version_id=v_system_draft and rule_code='ATTR_EXPLICIT_COMMIT_STORY_ID';
  v_valid:=public.admin_validate_attribution_rule_draft(v_system_draft);
  select array_agg(issue->>'code') into v_codes from jsonb_array_elements(v_valid->'issues') issue;
  perform pg_temp.assert(
    not (v_valid->>'passed')::boolean
    and 'SYSTEM_RULE_CONTRACT_MISMATCH'=any(v_codes),
    'database validation detects a mutated system rule'
  );
  -- 模拟一个被外部特权操作错误标成 VALIDATED 的草稿；可信模拟仍必须 fail closed 并落真实失败事实。
  update public.analysis_attribution_rule_version
  set status='VALIDATED',canonical_config=public.attribution_rule_version_config(id),
      ruleset_hash=public.attribution_rule_version_hash(id),validated_at=now()
  where id=v_system_draft;
  v_sim:=public.admin_simulate_attribution_rule_draft(
    v_system_draft,1,'SYSTEM_SAFETY_CONTRACT_V1');
  perform pg_temp.assert(
    not (v_sim->>'passed')::boolean
    and (v_sim->'contract_checks'->>'failed_check_count')::integer>0
    and exists(select 1 from public.analysis_attribution_rule_test_run
      where id=(v_sim->>'test_run_id')::uuid and not passed
        and failure_code='SYSTEM_SAFETY_CONTRACT_FAILED'),
    'trusted simulation records the real failed system-contract result'
  );
  begin
    perform public.admin_publish_attribution_rule_version(v_system_draft,1,'unsafe system mutation');
    perform pg_temp.assert(false,'failed contract cannot publish');
  exception when others then
    get stacked diagnostics v_error=message_text;
    perform pg_temp.assert(v_error like '%SYSTEM_SAFETY_CONTRACT_FAILED%',
      'system mutation is blocked at publish, got: '||v_error);
  end;

  v_custom_draft:=public.admin_create_attribution_rule_draft(v_source);
  insert into public.analysis_attribution_rule(
    version_id,rule_code,display_name,description,priority,enabled,capability,
    condition_tree,action_type,reason_code,system_locked,sort_order
  ) values
    (v_custom_draft,'ATTR_TEST_UNSAFE_ACTION','越权动作','不能强关联',500,true,'GIT_BASE',
      '{"all":[{"field":"commit.files","operator":"MODULE_OVERLAP"}]}'::jsonb,
      'SELECT_STRONG','TEST_UNSAFE_ACTION',false,1000),
    (v_custom_draft,'ATTR_TEST_UNSAFE_SCHEMA','越权条件','字段、算子和优先级都越权',299,true,'GIT_BASE',
      '{"all":[{"field":"database.secret","operator":"RUN_SCRIPT"}]}'::jsonb,
      'ADD_AI_CANDIDATE','TEST_UNSAFE_SCHEMA',false,1001);
  v_valid:=public.admin_validate_attribution_rule_draft(v_custom_draft);
  select array_agg(issue->>'code') into v_codes from jsonb_array_elements(v_valid->'issues') issue;
  perform pg_temp.assert(
    not (v_valid->>'passed')::boolean
    and 'CUSTOM_RULE_ACTION_FORBIDDEN'=any(v_codes)
    and 'CUSTOM_PRIORITY_OUT_OF_RANGE'=any(v_codes)
    and 'CUSTOM_RULE_FIELD_FORBIDDEN'=any(v_codes)
    and 'CUSTOM_RULE_OPERATOR_FORBIDDEN'=any(v_codes),
    'database safety contract rejects unsafe custom action, priority, field and operator'
  );
end;
$test$;

------------------------------------------------------------------------------
-- 5. 恢复产生新发布版本；普通成员不能模拟
------------------------------------------------------------------------------

do $test$
declare
  v_admin uuid:='11110000-a000-4000-a000-000000000001';
  v_member uuid:='11110000-a000-4000-a000-000000000002';
  v_source uuid;
  v_restore jsonb;
  v_error text;
begin
  perform set_config('request.jwt.claims',json_build_object(
    'sub',v_admin::text,'role','authenticated')::text,true);
  select current_published_version_id into v_source
  from public.analysis_attribution_rule_set where rule_set_code='STORY_COMMIT_ATTRIBUTION';
  v_restore:=public.admin_restore_attribution_rule_version(v_source,'恢复可信发布快照');
  perform pg_temp.assert(
    (v_restore->>'version_id')::uuid<>v_source
    and (select status='PUBLISHED'
      and source_version_id=v_source
      and ruleset_hash=public.attribution_rule_version_hash(id)
      from public.analysis_attribution_rule_version where id=(v_restore->>'version_id')::uuid)
    and (public.attribution_rule_safety_contract_v1((v_restore->>'version_id')::uuid)->>'passed')::boolean,
    'restore creates a new immutable published version that still satisfies the fixed contract'
  );

  perform set_config('request.jwt.claims',json_build_object(
    'sub',v_member::text,'role','authenticated')::text,true);
  begin
    perform public.admin_simulate_attribution_rule_draft(
      v_source,1,'SYSTEM_SAFETY_CONTRACT_V1');
    perform pg_temp.assert(false,'non-admin simulation must fail');
  exception when others then
    get stacked diagnostics v_error=message_text;
    perform pg_temp.assert(v_error like '%ADMIN_REQUIRED%' or lower(v_error) like '%admin%',
      'non-admin simulation is denied, got: '||v_error);
  end;
end;
$test$;

rollback;
