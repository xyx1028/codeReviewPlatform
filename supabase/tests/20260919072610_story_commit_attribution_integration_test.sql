-- V1.11 需求提交归属主链集成回归测试；全程事务内执行并 rollback。

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

------------------------------------------------------------------------------
-- 1. 签名与权限：旧 enqueue 唯一签名保留，新 context RPC 显式创建 V2。
------------------------------------------------------------------------------

do $test$
declare
  v_count integer;
begin
  perform pg_temp.assert(to_regprocedure('public.enqueue_analysis_job(uuid)') is not null,
    'legacy enqueue_analysis_job(uuid) remains available');
  select count(*) into v_count
  from pg_proc proc join pg_namespace ns on ns.oid=proc.pronamespace
  where ns.nspname='public' and proc.proname='enqueue_analysis_job';
  perform pg_temp.assert(v_count=1,'legacy enqueue keeps exactly one signature');
  perform pg_temp.assert(
    to_regprocedure('public.enqueue_analysis_job_with_context(uuid,integer,integer)') is not null,
    'context-aware enqueue exists');
  perform pg_temp.assert(
    has_function_privilege('authenticated',
      'public.enqueue_analysis_job_with_context(uuid,integer,integer)','EXECUTE')
    and not has_function_privilege('anon',
      'public.enqueue_analysis_job_with_context(uuid,integer,integer)','EXECUTE'),
    'context-aware enqueue is authenticated-only');
  perform pg_temp.assert(
    to_regprocedure('public.get_analysis_story_scope_commits(uuid,integer,text,text,integer)') is not null,
    'typed monitoring commit page overload exists');
  perform pg_temp.assert(
    not has_function_privilege('authenticated',
      'public.admin_record_attribution_rule_test_run(uuid,uuid,text,text,jsonb,jsonb,boolean,text)','EXECUTE'),
    'browser cannot record a trusted gold-set pass');
  perform pg_temp.assert(
    has_function_privilege('authenticated',
      'public.admin_simulate_attribution_rule_draft(uuid,integer,text)','EXECUTE'),
    'browser simulation endpoint exists but fails closed without trusted sample executor');
end;
$test$;

------------------------------------------------------------------------------
-- 2. V1/V2 enqueue → claim → save snapshots 状态转换和冻结输入。
------------------------------------------------------------------------------

do $test$
declare
  v_admin uuid:='11220000-1000-4000-a000-000000000001';
  v_model uuid:='11220000-2000-4000-a000-000000000001';
  v_batch_v1 uuid:='11220000-3000-4000-a000-000000000001';
  v_batch_v2 uuid:='11220000-3000-4000-a000-000000000002';
  v_story_v1 uuid:='11220000-4000-4000-a000-000000000001';
  v_story_v2 uuid:='11220000-4000-4000-a000-000000000002';
  v_job_v1 uuid;
  v_job_v2 uuid;
  v_secret uuid;
  v_identity jsonb;
  v_claim jsonb;
  v_snapshots jsonb;
  v_error text;
begin
  insert into auth.users(id,email)
  values(v_admin,'admin-v111-integration@example.invalid') on conflict(id) do nothing;
  insert into public.user_profile(id,role,display_name)
  values(v_admin,'ADMIN','V1.11 集成测试管理员')
  on conflict(id) do update set role='ADMIN',display_name=excluded.display_name;
  perform set_config('request.jwt.claims',
    json_build_object('sub',v_admin::text,'role','authenticated')::text,true);

  set local role service_role;
  v_secret:=public.admin_vault_create_secret(
    'v111-integration-not-a-real-key','v111_integration_test_key');
  v_identity:=public.admin_upsert_developer_git_identity(
    v_admin,null,null,'开发甲','E-2201','VERIFIED','gitlab',repeat('2',64),
    'd***@example.invalid','example.invalid',array['Dev Integration'],
    'dev-integration','2201','VERIFIED',null
  );
  reset role;

  insert into public.ai_model_config(
    id,display_name,base_url,model_name,api_key_secret_id,enabled,max_parallel_tasks,created_by
  ) values(
    v_model,'V1.11 integration model','https://model-v111-integration.example.invalid',
    'v111-integration-model',v_secret,true,4,v_admin
  );

  insert into public.review_batch(
    id,name,week_code,default_branch,ai_model_config_id,created_by
  ) values
    (v_batch_v1,'V1.11 V1 compatibility','V111-INTEGRATION-V1','feature_dev',v_model,v_admin),
    (v_batch_v2,'V1.11 V2 scope','V111-INTEGRATION-V2','feature_dev',v_model,v_admin);
  insert into public.review_story(
    id,batch_id,story_code,story_name,owners_text,project_name,application_name,
    release_window,source_data
  ) values
    (v_story_v1,v_batch_v1,'REQ-V1','旧全仓任务','开发甲','订单','订单服务','2026-W38',
      jsonb_build_object('详细描述','验证 V1 状态机不变')),
    (v_story_v2,v_batch_v2,'REQ-V2','精准提交任务','开发甲','订单','订单服务','2026-W38',
      jsonb_build_object('详细描述','冻结精准提交上下文','关联特性','批量关闭'));

  v_snapshots:=jsonb_build_array(
    jsonb_build_object('repository_name','kdmanage-backend','requested_branch','feature_dev',
      'commit_sha',repeat('a',40),'commit_subject','head a'),
    jsonb_build_object('repository_name','kdmanage-frontend','requested_branch','feature_dev',
      'commit_sha',repeat('b',40),'commit_subject','head b'),
    jsonb_build_object('repository_name','tmanage-backend','requested_branch','feature_dev',
      'commit_sha',repeat('c',40),'commit_subject','head c'),
    jsonb_build_object('repository_name','tmanage-frontend','requested_branch','feature_dev',
      'commit_sha',repeat('d',40),'commit_subject','head d')
  );

  -- 旧单参调用只创建 V1，scope 字段保持 LEGACY。
  v_job_v1:=public.enqueue_analysis_job(v_batch_v1);
  perform pg_temp.assert((select analysis_context_version=1 and scope_status='LEGACY'
      and required_worker_scope_version=1
      from public.analysis_job where id=v_job_v1),
    'legacy enqueue defaults to V1/LEGACY');

  set local role service_role;
  v_claim:=public.claim_job_for_preparation('worker-v1',900);
  perform pg_temp.assert(v_claim->'job'->>'id'=v_job_v1::text
      and (v_claim->>'analysis_context_version')::integer=1
      and (v_claim->'window'->>'days')::integer=21
      and v_claim->'ruleset'='null'::jsonb,
    'V1 claim keeps old job/model envelope and adds nullable context metadata');
  perform public.save_repository_snapshots(v_job_v1,'worker-v1',v_snapshots);
  reset role;
  perform pg_temp.assert((select status='PROCESSING' and scope_status='LEGACY'
      and story_input_catalog_hash is null and identity_snapshot_hash is null
      from public.analysis_job where id=v_job_v1),
    'V1 snapshots still move directly to PROCESSING without V2 freezing');

  -- Context-aware enqueue freezes immutable rule identity before Worker claim.
  v_job_v2:=public.enqueue_analysis_job_with_context(v_batch_v2,2,14);
  perform pg_temp.assert((select analysis_context_version=2 and commit_window_days=14
      and scope_status='PREPARING' and required_worker_scope_version=2
      and attribution_rule_version_id is not null and ruleset_hash is not null
      and story_input_catalog_hash is null and identity_snapshot_hash is null
      from public.analysis_job where id=v_job_v2),
    'V2 enqueue freezes rule version/hash and requests scope preparation');

  set local role service_role;
  v_claim:=public.claim_job_for_preparation('worker-without-scope-v2',900);
  perform pg_temp.assert(v_claim is null,
    'worker without storyCommitScopeVersion cannot claim V2 job');

  insert into public.analysis_worker_heartbeat(worker_id,slots,current_tasks,capabilities)
  values('worker-scope-v2',2,0,jsonb_build_object('storyCommitScopeVersion',2))
  on conflict(worker_id) do update set capabilities=excluded.capabilities,last_seen_at=now();

  v_claim:=public.claim_job_for_preparation('worker-scope-v2',900);
  perform pg_temp.assert(v_claim->'job'->>'id'=v_job_v2::text
      and (v_claim->>'analysis_context_version')::integer=2
      and (v_claim->'window'->>'days')::integer=14
      and v_claim->'ruleset'->>'version_id' is not null
      and v_claim->'ruleset'->>'hash'=(select ruleset_hash from public.analysis_job where id=v_job_v2)
      and jsonb_typeof(v_claim->'ruleset'->'config')='object',
    'V2 claim returns frozen analysis_context_version/window/ruleset');

  perform public.save_repository_snapshots(v_job_v2,'worker-scope-v2',v_snapshots);
  reset role;

  perform pg_temp.assert((select status='PREPARING_SCOPE' and scope_status='PREPARING'
      and story_input_catalog_hash is not null and identity_snapshot_hash is not null
      and scope_requested_at is not null
      from public.analysis_job where id=v_job_v2),
    'V2 snapshots freeze story/identity inputs and move to PREPARING_SCOPE');
  perform pg_temp.assert((select count(*)=1 from public.analysis_job_story_snapshot
      where job_id=v_job_v2),
    'V2 has one immutable story snapshot per task');
  perform pg_temp.assert((select count(*)=1 from public.analysis_job_identity_snapshot
      where job_id=v_job_v2 and source_git_identity_id=(v_identity->>'git_identity_id')::uuid),
    'V2 freezes the verified developer identity');
  perform pg_temp.assert((select count(*)=4 and bool_and(mr_enrichment_status='UNAVAILABLE')
      from public.analysis_repository_snapshot where job_id=v_job_v2),
    'all four repositories explicitly report optional MR metadata unavailable');

  begin
    perform public.enqueue_analysis_job_with_context(v_batch_v2,3,21);
    perform pg_temp.assert(false,'invalid context version must fail');
  exception when others then
    get stacked diagnostics v_error=message_text;
    perform pg_temp.assert(v_error like '%ANALYSIS_CONTEXT_VERSION_INVALID%',
      'invalid context version has stable error');
  end;
end;
$test$;

------------------------------------------------------------------------------
-- 3. 监控 summary/commits 精确匹配 hook：repositories、expansions、view 字段。
------------------------------------------------------------------------------

do $test$
declare
  v_admin uuid:='11220000-1000-4000-a000-000000000001';
  v_job uuid;
  v_task uuid;
  v_snapshot uuid;
  v_commit uuid:='11220000-5000-4000-a000-000000000001';
  v_scope uuid:='11220000-6000-4000-a000-000000000001';
  v_candidate uuid:='11220000-7000-4000-a000-000000000001';
  v_run uuid:='11220000-8000-4000-a000-000000000001';
  v_node uuid:='11220000-9000-4000-a000-000000000001';
  v_summary jsonb;
  v_commits jsonb;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub',v_admin::text,'role','authenticated')::text,true);
  select id into v_job from public.analysis_job
  where batch_id='11220000-3000-4000-a000-000000000002';
  select id into v_task from public.analysis_story_task where job_id=v_job;

  update public.analysis_repository_snapshot
  set base_sha=repeat('e',40),range_source='TIME_DERIVED',
      range_start_at='2026-09-05T00:00:00Z',range_end_at='2026-09-19T00:00:00Z',
      ancestry_status='VERIFIED',enumeration_status='COMPLETE',commit_count=0,
      commit_manifest_hash=repeat('3',64),head_resolved_at='2026-09-19T00:00:00Z'
  where job_id=v_job;
  select id into v_snapshot from public.analysis_repository_snapshot
  where job_id=v_job and repository_name='kdmanage-backend';
  update public.analysis_repository_snapshot set commit_count=1 where id=v_snapshot;

  insert into public.analysis_repository_commit(
    id,snapshot_id,sha,sequence_no,author_name,author_email_masked,
    committed_at,subject,files_changed,additions,deletions,effective_status
  ) values(
    v_commit,v_snapshot,repeat('f',40),0,'Dev Integration','d***@example.invalid',
    '2026-09-18T08:00:00Z','REQ-V2 precise change',2,20,3,'EFFECTIVE'
  );
  insert into public.analysis_story_scope(
    id,task_id,generation,scope_mode,status,current_scope_level,algorithm_version,
    ruleset_hash,candidate_manifest_hash,candidate_count,strong_count,frozen_at
  ) values(
    v_scope,v_task,1,'EXACT_STORY_COMMITS','READY','RELATED','story-attribution-v2',
    (select ruleset_hash from public.analysis_job where id=v_job),repeat('4',64),1,1,now()
  );
  insert into public.analysis_story_commit_candidate(
    id,scope_id,task_id,generation,commit_id,tier,selection_source,rank_score,
    reason_codes,effective_status
  ) values(
    v_candidate,v_scope,v_task,1,v_commit,'STRONG','RULE',900,
    array['EXPLICIT_STORY_ID'],'EFFECTIVE'
  );
  insert into public.analysis_agent_run(
    id,task_id,job_id,agent_attempt,worker_id,status
  ) values(v_run,v_task,v_job,2,'worker-scope-v2','RUNNING');
  insert into public.analysis_agent_node(
    id,agent_run_id,agent_id,session_id,parent_agent_node_id,agent_role,provider,
    delegation_depth,status,tool_policy_hash
  ) values(
    v_node,v_run,'root-v111','session-v111',null,'root-reviewer','root',0,'RUNNING',repeat('5',64)
  );
  insert into public.analysis_scope_expansion(
    task_id,agent_run_id,agent_node_id,from_level,to_level,reason_code
  ) values(v_task,v_run,v_node,'PRIMARY','RELATED','CALLER_CALLEE_TRACE');
  insert into public.analysis_story_commit_access(
    task_id,candidate_id,agent_run_id,agent_node_id,tool_call_id,access_kind,
    bytes_returned,diff_lines,truncated
  ) values(v_task,v_candidate,v_run,v_node,'tool-v111','DIFF',1024,20,false);

  v_summary:=public.get_analysis_story_scope_summary(v_task);
  perform pg_temp.assert(v_summary->>'status'='READY'
      and v_summary->>'mode'='EXACT_STORY_COMMITS'
      and (v_summary->>'window_days')::integer=14
      and jsonb_array_length(v_summary->'repositories')=4
      and jsonb_array_length(v_summary->'expansions')=1,
    'summary exposes hook status/mode/window/repositories/expansions');
  perform pg_temp.assert(v_summary->'repositories'->0 ? 'repository_name'
      and v_summary->'repositories'->0 ? 'base_sha'
      and v_summary->'repositories'->0 ? 'head_sha'
      and v_summary->'repositories'->0 ? 'resolved_at',
    'repository summary has RuntimeRepositoryScope fields');
  perform pg_temp.assert(v_summary->'expansions'->0->>'attempt'='2'
      and v_summary->'expansions'->0->>'agent_label'='root-reviewer'
      and v_summary->'expansions'->0->>'occurred_at' is not null,
    'expansion summary has RuntimeScopeExpansion fields');

  v_commits:=public.get_analysis_story_scope_commits(v_task,1,'SELECTED',null,20);
  perform pg_temp.assert(v_commits->>'task_id'=v_task::text
      and (v_commits->>'generation')::integer=1
      and (v_commits->>'total')::integer=1
      and jsonb_array_length(v_commits->'items')=1,
    'selected commit page returns requested frozen generation');
  perform pg_temp.assert(v_commits->'items'->0->>'view'='SELECTED'
      and v_commits->'items'->0->>'relation_status'='AUTO_SELECTED'
      and v_commits->'items'->0->>'repository_name'='kdmanage-backend'
      and v_commits->'items'->0->>'author_display_name'='Dev Integration'
      and (v_commits->'items'->0->>'actually_read')::boolean
      and (v_commits->'items'->0->>'read_count')::integer=1,
    'commit row matches RuntimeAnalysisScopeCommit view/read fields');
  perform pg_temp.assert(v_commits::text not like '%'||repeat('2',64)||'%'
      and v_commits::text not like '%Story-Id:%',
    'monitor pages exclude identity fingerprints and commit bodies');

  v_commits:=public.get_analysis_story_scope_commits(v_task,1,'CANDIDATE',null,20);
  perform pg_temp.assert((v_commits->>'total')::integer=0,
    'view filter does not leak selected rows into candidate tab');
end;
$test$;

------------------------------------------------------------------------------
-- 4. 规则 catalog 对齐 hook；无可信样本时不伪造 gold-set 模拟。
------------------------------------------------------------------------------

do $test$
declare
  v_admin uuid:='11220000-1000-4000-a000-000000000001';
  v_catalog jsonb;
  v_current uuid;
  v_draft uuid;
  v_revision integer;
  v_error text;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub',v_admin::text,'role','authenticated')::text,true);
  perform pg_temp.assert(jsonb_typeof(public.admin_list_attribution_rule_sets())='array',
    'foundation list RPC keeps its array contract for the existing frontend adapter');
  v_catalog:=public.admin_get_attribution_rule_catalog();
  perform pg_temp.assert(jsonb_typeof(v_catalog)='object'
      and v_catalog->>'rule_set_id' is not null
      and v_catalog->>'rule_set_name'='需求提交归属规则'
      and jsonb_typeof(v_catalog->'versions')='array'
      and jsonb_array_length(v_catalog->'versions')>=1,
    'catalog is one AttributionRuleCatalog object');
  perform pg_temp.assert(jsonb_array_length(v_catalog->'sample_sets')=1
      and v_catalog->'sample_sets'->0->>'id'='SYSTEM_SAFETY_CONTRACT_V1'
      and not (v_catalog->>'mr_enhanced_available')::boolean,
    'catalog exposes only the trusted safety-contract sample and no live MR capability');
  perform pg_temp.assert(v_catalog->'versions'->0 ? 'rules'
      and v_catalog->'versions'->0 ? 'validation'
      and v_catalog->'versions'->0 ? 'latest_simulation'
      and v_catalog->'versions'->0 ? 'referenced_job_count',
    'catalog version matches AttributionRuleVersion top-level fields');
  perform pg_temp.assert(v_catalog->'versions'->0->'rules'->0 ? 'rule_code'
      and v_catalog->'versions'->0->'rules'->0 ? 'conditions'
      and v_catalog->'versions'->0->'rules'->0->'action' ? 'reason_code'
      and v_catalog->'versions'->0->'rules'->0 ? 'system_locked',
    'catalog rules use hook snake_case visual-editor shape');

  v_current:=(v_catalog->>'current_published_version_id')::uuid;
  v_draft:=public.admin_create_attribution_rule_draft(v_current);
  select revision into v_revision from public.analysis_attribution_rule_version where id=v_draft;
  begin
    perform public.admin_simulate_attribution_rule_draft(v_draft,v_revision,'browser-made-gold-set');
    perform pg_temp.assert(false,'browser cannot simulate against a self-invented sample');
  exception when others then
    get stacked diagnostics v_error=message_text;
    perform pg_temp.assert(v_error like '%RULE_SAMPLE_SET_NOT_ALLOWED%',
      'simulation only accepts the database-owned fixed safety contract');
  end;
end;
$test$;

------------------------------------------------------------------------------
-- 5. 可选 MR 表只提供受保护 API 数据模型，普通浏览器不能直读/写。
------------------------------------------------------------------------------

do $test$
declare
  v_table text;
  v_rls boolean;
begin
  foreach v_table in array array[
    'analysis_repository_merge_request','analysis_merge_request_commit'
  ] loop
    select cls.relrowsecurity into v_rls
    from pg_class cls join pg_namespace ns on ns.oid=cls.relnamespace
    where ns.nspname='public' and cls.relname=v_table;
    perform pg_temp.assert(coalesce(v_rls,false),v_table||' has RLS enabled');
    perform pg_temp.assert(not has_table_privilege('authenticated','public.'||v_table,'SELECT')
        and not has_table_privilege('authenticated','public.'||v_table,'INSERT'),
      v_table||' is not browser-readable or writable');
  end loop;
end;
$test$;

rollback;
