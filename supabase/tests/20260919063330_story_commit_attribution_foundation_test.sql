-- V1.11 需求提交归属数据库基础层回归测试。
-- 测试全部位于事务内并 rollback，不保留账号、Job、规则草稿或审计数据。

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
-- 1. Schema、RLS、GRANT 与系统预制规则
------------------------------------------------------------------------------

do $test$
declare v_table text; v_rls boolean; v_count integer; v_version uuid:='11110000-0000-4000-a000-000000000101'; v_error text;
begin
  foreach v_table in array array[
    'analysis_attribution_rule_set','analysis_attribution_rule_version','analysis_attribution_rule',
    'analysis_attribution_rule_test_run','analysis_attribution_rule_audit','developer_identity',
    'developer_git_identity','analysis_job_identity_snapshot','analysis_job_story_snapshot',
    'analysis_repository_commit','analysis_commit_file','analysis_story_scope',
    'analysis_story_commit_candidate','analysis_commit_diff_archive','analysis_story_commit_access',
    'analysis_story_commit_relevance_verdict','analysis_scope_expansion','analysis_scope_decision_audit'
  ] loop
    select c.relrowsecurity into v_rls from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relname=v_table;
    perform pg_temp.assert(coalesce(v_rls,false),'RLS enabled on '||v_table);
  end loop;

  select count(*) into v_count from public.analysis_attribution_rule where version_id=v_version;
  perform pg_temp.assert(v_count=13,'all 13 mandatory system attribution rules are seeded');
  perform pg_temp.assert(
    (select status='PUBLISHED' and ruleset_hash=public.attribution_rule_version_hash(id)
     from public.analysis_attribution_rule_version where id=v_version),
    'seed rule version is published and its hash matches canonical rules'
  );
  perform pg_temp.assert(
    (select current_published_version_id=v_version from public.analysis_attribution_rule_set
      where rule_set_code='STORY_COMMIT_ATTRIBUTION'),
    'system rule set points at seeded immutable version'
  );

  begin
    update public.analysis_attribution_rule_version set publish_reason='tampered' where id=v_version;
    perform pg_temp.assert(false,'published rule version cannot be updated');
  exception when others then
    get stacked diagnostics v_error=message_text;
    perform pg_temp.assert(v_error like '%ATTRIBUTION_RULE_VERSION_IMMUTABLE%',
      'published version update raises immutable error, got: '||v_error);
  end;
  begin
    update public.analysis_attribution_rule set priority=1
    where id='11110001-0000-4000-a000-000000000001';
    perform pg_temp.assert(false,'published rule cannot be updated');
  exception when others then
    get stacked diagnostics v_error=message_text;
    perform pg_temp.assert(v_error like '%ATTRIBUTION_RULE_VERSION_IMMUTABLE%',
      'published rule update raises immutable error, got: '||v_error);
  end;

  perform pg_temp.assert(
    not has_function_privilege('authenticated',
      'public.save_analysis_repository_commit_manifest(uuid,text,text,jsonb,text)','EXECUTE'),
    'authenticated cannot write repository manifests'
  );
  perform pg_temp.assert(
    has_function_privilege('service_role',
      'public.save_analysis_repository_commit_manifest(uuid,text,text,jsonb,text)','EXECUTE'),
    'service_role can execute repository manifest RPC'
  );
  perform pg_temp.assert(
    not has_function_privilege('authenticated',
      'public.submit_story_commit_relevance_verdict(uuid,text,uuid,uuid,uuid,integer,text,text[],numeric,uuid[],text)','EXECUTE'),
    'authenticated cannot self-report AI relevance'
  );
  perform pg_temp.assert(
    not has_table_privilege('authenticated','public.analysis_repository_commit','SELECT'),
    'authenticated cannot directly read commit fingerprints/message bodies'
  );
  perform pg_temp.assert(
    not has_table_privilege('authenticated','public.analysis_commit_diff_archive','SELECT'),
    'authenticated cannot directly read diff locators'
  );
  perform pg_temp.assert(
    not exists(select 1 from pg_policies where schemaname='storage' and tablename='objects'
      and coalesce(roles::text,'') like '%authenticated%'
      and (qual like '%analysis-commit-diffs%' or with_check like '%analysis-commit-diffs%')),
    'private diff bucket has no authenticated object policy'
  );
end;
$test$;

------------------------------------------------------------------------------
-- 2. 身份管理：只保存 fingerprint/脱敏值，冲突 fail closed
------------------------------------------------------------------------------

do $test$
declare
  v_admin uuid:='11110000-1000-4000-a000-000000000001';
  v_one jsonb; v_error text;
begin
  insert into auth.users(id,email) values(v_admin,'admin-v111@example.invalid') on conflict(id) do nothing;
  insert into public.user_profile(id,role) values(v_admin,'ADMIN') on conflict(id) do update set role='ADMIN';

  set local role service_role;
  v_one:=public.admin_upsert_developer_git_identity(
    v_admin,null,null,'开发甲','E-1001','VERIFIED','gitlab',repeat('a',64),
    'd***@example.invalid','example.invalid',array['Dev A'],'dev-a','1001','VERIFIED',null
  );
  perform pg_temp.assert(v_one->>'developer_id' is not null,'identity upsert returns developer id');
  perform pg_temp.assert(
    (select masked_email='d***@example.invalid' and email_fingerprint=repeat('a',64)
     from public.developer_git_identity where id=(v_one->>'git_identity_id')::uuid),
    'identity stores only fingerprint and masked display'
  );
  perform pg_temp.assert(
    not exists(select 1 from public.developer_git_identity where to_jsonb(developer_git_identity)::text like '%dev-a@example.invalid%'),
    'raw email is not persisted'
  );

  begin
    perform public.admin_upsert_developer_git_identity(
      v_admin,null,null,'开发乙','E-1002','VERIFIED','gitlab',repeat('a',64),
      'x***@example.invalid','example.invalid',array['Dev B'],'dev-b','1002','VERIFIED',null
    );
    perform pg_temp.assert(false,'one active fingerprint cannot map to two developers');
  exception when others then
    get stacked diagnostics v_error=message_text;
    perform pg_temp.assert(v_error like '%EMAIL_FINGERPRINT_CONFLICT%',
      'fingerprint collision raises stable error, got: '||v_error);
  end;
  reset role;
end;
$test$;

------------------------------------------------------------------------------
-- 3. v2 Job：输入冻结、四仓 commit manifest、候选冻结、Attempt 门禁与监控
------------------------------------------------------------------------------

do $test$
declare
  v_admin uuid:='11110000-1000-4000-a000-000000000001';
  v_model uuid:='11110000-2000-4000-a000-000000000001';
  v_batch uuid:='11110000-3000-4000-a000-000000000001';
  v_story uuid:='11110000-4000-4000-a000-000000000001';
  v_job uuid:='11110000-5000-4000-a000-000000000001';
  v_task uuid:='11110000-6000-4000-a000-000000000001';
  v_candidate uuid:='11110000-7000-4000-a000-000000000001';
  v_run uuid:='11110000-8000-4000-a000-000000000001';
  v_claim uuid:='11110000-9000-4000-a000-000000000001';
  v_secret uuid; v_repo text; v_manifest jsonb; v_scopes jsonb;
  v_result jsonb; v_scope_json jsonb; v_summary jsonb; v_commits jsonb;
  v_access uuid; v_access_again uuid; v_expansion uuid; v_error text;
  v_sha text:=repeat('a',40); v_base text:=repeat('b',40); v_rule_hash text;
begin
  perform set_config('request.jwt.claims',json_build_object('sub',v_admin::text,'role','authenticated')::text,true);

  set local role service_role;
  v_secret:=public.admin_vault_create_secret('v111-test-not-a-real-key','v111_scope_test_key');
  reset role;

  insert into public.ai_model_config(
    id,display_name,base_url,model_name,api_key_secret_id,enabled,max_parallel_tasks,created_by
  ) values(v_model,'V1.11 test model','https://model-v111.example.invalid','v111-model',v_secret,true,4,v_admin);
  insert into public.review_batch(id,name,week_code,default_branch,ai_model_config_id,created_by)
  values(v_batch,'V1.11 scope batch','V111-DB-FOUNDATION','feature_dev',v_model,v_admin);
  insert into public.review_story(
    id,batch_id,story_code,story_name,owners_text,project_name,application_name,release_window,source_data
  ) values(v_story,v_batch,'REQ-001','精准提交分析','开发甲','订单','订单服务','2026-W38',
    jsonb_build_object('详细描述','验证提交归属','关联特性','批量关闭'));
  insert into public.analysis_job(
    id,batch_id,model_config_id,model_snapshot,requested_branch,status,requested_by,worker_id,total_stories,
    policy_version,capability_policy_snapshot,
    analysis_context_version,commit_window_days,scope_status,required_worker_scope_version,
    attribution_algorithm_version
  ) values(v_job,v_batch,v_model,'{}','feature_dev','PREPARING_CODE',v_admin,'worker-v111',1,
    4,jsonb_build_object('test_fixture',true),
    2,21,'PREPARING',2,'story-attribution-v2');
  insert into public.analysis_story_task(id,job_id,story_id) values(v_task,v_job,v_story);

  set local role service_role;
  v_result:=public.freeze_analysis_job_scope_inputs(v_job,'worker-v111');
  perform pg_temp.assert(v_result->>'ruleset_hash' is not null,'job freezes current published ruleset');
  perform pg_temp.assert(
    (select status='PREPARING_SCOPE' and story_input_catalog_hash is not null
      and identity_snapshot_hash is not null and attribution_rule_version_id is not null
     from public.analysis_job where id=v_job),
    'input freeze moves v2 job to PREPARING_SCOPE with all input hashes'
  );
  perform pg_temp.assert(
    (select count(*)=1 from public.analysis_job_story_snapshot where job_id=v_job),
    'every job story has one immutable input snapshot'
  );
  perform pg_temp.assert(
    (select requirement_context ? 'detailed_description' and cardinality(normalized_developer_ids)=1
     from public.analysis_job_story_snapshot where job_id=v_job),
    'allowlisted requirement context and exact verified developer identity are frozen'
  );
  begin
    update public.analysis_job_story_snapshot set story_name='tampered' where job_id=v_job;
    perform pg_temp.assert(false,'story snapshot cannot be changed');
  exception when others then
    get stacked diagnostics v_error=message_text;
    perform pg_temp.assert(v_error like '%ANALYSIS_SCOPE_INPUT_IMMUTABLE%',
      'story snapshot update raises immutable error');
  end;

  foreach v_repo in array array['kdmanage-backend','kdmanage-frontend','tmanage-backend','tmanage-frontend']
  loop
    v_manifest:=jsonb_build_object(
      'base_sha',v_base,'head_sha',v_sha,'head_subject','REQ-001 implementation',
      'range_source','TIME_DERIVED','range_start_at','2026-08-29T00:00:00Z',
      'range_end_at','2026-09-19T00:00:00Z','head_resolved_at','2026-09-19T00:00:00Z',
      'ancestry_status','VERIFIED','enumeration_status','COMPLETE',
      'commit_count',case when v_repo='kdmanage-backend' then 1 else 0 end,
      'commits',case when v_repo='kdmanage-backend' then jsonb_build_array(jsonb_build_object(
        'sha',v_sha,'sequence_no',0,'parent_shas',jsonb_build_array(v_base),'tree_sha',repeat('c',40),
        'author_name','Dev A','author_email_fingerprint',repeat('a',64),
        'author_email_masked','d***@example.invalid','authored_at','2026-09-18T08:00:00Z',
        'committer_name','Dev A','committer_email_fingerprint',repeat('a',64),
        'committer_email_masked','d***@example.invalid','committed_at','2026-09-18T08:01:00Z',
        'subject','REQ-001 batch close','message_body','Story-Id: REQ-001',
        'trailers',jsonb_build_object('Story-Id',jsonb_build_array('REQ-001')),
        'structured_story_ids',jsonb_build_array('REQ-001'),'is_merge',false,'is_revert',false,
        'files_changed',1,'additions',12,'deletions',2,'binary_files',0,'effective_status','EFFECTIVE',
        'files',jsonb_build_array(jsonb_build_object('file_order',0,'path','order/service.ts',
          'change_type','MODIFIED','additions',12,'deletions',2,'binary',false))
      )) else '[]'::jsonb end
    );
    v_result:=public.save_analysis_repository_commit_manifest(
      v_job,'worker-v111',v_repo,v_manifest,repeat('d',64)
    );
    perform pg_temp.assert((v_result->>'commit_count')::integer=case when v_repo='kdmanage-backend' then 1 else 0 end,
      'repository manifest saves expected complete count for '||v_repo);
    -- 相同 hash/payload 重试必须返回同一 snapshot，不重复 commit。
    v_result:=public.save_analysis_repository_commit_manifest(
      v_job,'worker-v111',v_repo,v_manifest,repeat('d',64)
    );
    perform pg_temp.assert((v_result->>'idempotent')::boolean,'repository manifest retry is idempotent');
  end loop;
  perform pg_temp.assert(
    (select count(*)=4 and bool_and(enumeration_status='COMPLETE')
     from public.analysis_repository_snapshot where job_id=v_job),
    'all four repositories have explicit complete manifests'
  );
  perform pg_temp.assert(
    (select count(*)=1 from public.analysis_repository_commit repo_commit
      join public.analysis_repository_snapshot snapshot on snapshot.id=repo_commit.snapshot_id where snapshot.job_id=v_job),
    'complete manifest persists exactly its commit topology'
  );
  perform pg_temp.assert(
    (select author_email_fingerprint=repeat('a',64) and author_email_masked='d***@example.invalid'
     from public.analysis_repository_commit limit 1),
    'commit metadata stores fingerprint and masked email, never raw email'
  );
  v_result:=public.save_analysis_commit_diff_archives(v_job,'worker-v111',jsonb_build_array(jsonb_build_object(
    'repository_name','kdmanage-backend','sha',v_sha,'status','AVAILABLE',
    'storage_object_prefix',v_job::text||'/kdmanage-backend/'||v_sha||'/'||repeat('d',64)||'/',
    'archive_sha256',repeat('f',64),'size_bytes',1024,'chunk_count',1
  )));
  perform pg_temp.assert((v_result->>'archive_count')::integer=1 and
    (select status='AVAILABLE' from public.analysis_commit_diff_archive where job_id=v_job),
    'trusted Worker saves immutable diff archive metadata with canonical prefix'
  );

  select ruleset_hash into v_rule_hash from public.analysis_job where id=v_job;
  v_scopes:=jsonb_build_array(jsonb_build_object(
    'task_id',v_task,'generation',1,'scope_mode','DEVELOPER_WINDOW','status','PREPARING',
    'candidate_manifest_hash',repeat('d',64),'degradation_reasons',jsonb_build_array('NO_EXPLICIT_LINK'),
    'candidates',jsonb_build_array(jsonb_build_object(
      'candidate_id',v_candidate,'repository_name','kdmanage-backend','sha',v_sha,
      'tier','AI_CANDIDATE','selection_source','IDENTITY_WINDOW','rank_score',500,
      'reason_codes',jsonb_build_array('OWNER_WINDOW_MODULE'),'identity_match_type','VERIFIED_EMAIL',
      'story_match_location','NONE','rule_code','ATTR_OWNER_WINDOW_MODULE_CANDIDATE','effective_status','EFFECTIVE'
    ))
  ));
  v_result:=public.save_analysis_story_scopes(v_job,'worker-v111','story-attribution-v2',v_scopes,repeat('e',64));
  perform pg_temp.assert((v_result->>'scope_count')::integer=1,'one story scope is prepared');
  v_result:=public.finalize_analysis_story_scope(v_job,'worker-v111',1);
  perform pg_temp.assert(v_result->>'scope_status'='READY','complete candidate scope finalizes READY');
  perform pg_temp.assert(
    (select frozen_at is not null and candidate_count=1 and ai_candidate_count=1 and not triage_complete
     from public.analysis_story_scope where task_id=v_task),
    'candidate manifest freezes with one required AI verdict'
  );
  begin
    update public.analysis_job set ruleset_hash=repeat('9',64) where id=v_job;
    perform pg_temp.assert(false,'frozen Job ruleset/hash cannot drift');
  exception when others then
    get stacked diagnostics v_error=message_text;
    perform pg_temp.assert(v_error like '%ANALYSIS_JOB_SCOPE_IDENTITY_IMMUTABLE%',
      'frozen Job identity update raises stable immutable error');
  end;
  begin
    update public.analysis_story_commit_candidate set rank_score=999 where id=v_candidate;
    perform pg_temp.assert(false,'frozen candidate cannot be rewritten');
  exception when others then
    get stacked diagnostics v_error=message_text;
    perform pg_temp.assert(v_error like '%ANALYSIS_SCOPE_CANDIDATE_IMMUTABLE%',
      'frozen candidate update raises stable immutable error');
  end;

  -- Simulate canonical task claim/run produced by the existing Worker RPC.
  begin
    update public.analysis_story_task set worker_id='old-worker',lease_expires_at=now()+interval '15 minutes',
      heartbeat_at=now(),agent_status='RUNNING',agent_attempt=1,claim_token_digest=public.agent_claim_token_digest(v_claim)
    where id=v_task;
    perform pg_temp.assert(false,'worker without scope v2 capability cannot claim a v2 task');
  exception when others then
    get stacked diagnostics v_error=message_text;
    perform pg_temp.assert(v_error like '%WORKER_STORY_COMMIT_SCOPE_UNSUPPORTED%',
      'old worker claim is rejected by database capability gate');
  end;
  insert into public.analysis_worker_heartbeat(worker_id,slots,current_tasks,capabilities)
  values('worker-v111',2,0,jsonb_build_object('storyCommitScopeVersion',2))
  on conflict(worker_id) do update set capabilities=excluded.capabilities,last_seen_at=now();
  update public.analysis_story_task set worker_id='worker-v111',lease_expires_at=now()+interval '15 minutes',
    heartbeat_at=now(),agent_status='RUNNING',agent_attempt=1,claim_token_digest=public.agent_claim_token_digest(v_claim)
  where id=v_task;
  insert into public.analysis_agent_run(id,task_id,job_id,agent_attempt,worker_id,status,scope_generation)
  values(v_run,v_task,v_job,1,'worker-v111','RUNNING',1);

  v_scope_json:=public.get_story_task_analysis_scope(v_task,'worker-v111',v_claim);
  perform pg_temp.assert(v_scope_json->>'candidate_manifest_hash'=repeat('d',64),
    'claimed task reads only frozen generation/hash');
  perform pg_temp.assert(v_scope_json::text not like '%dev-a@example.invalid%',
    'Worker scope envelope does not expose raw email');
  begin
    perform public.get_story_task_analysis_scope(v_task,'worker-v111',gen_random_uuid());
    perform pg_temp.assert(false,'wrong claim token must be rejected');
  exception when others then
    get stacked diagnostics v_error=message_text;
    perform pg_temp.assert(v_error like '%TASK_LEASE_LOST%','wrong token raises TASK_LEASE_LOST');
  end;

  v_access:=public.record_story_commit_access(v_task,'worker-v111',v_claim,v_run,null,v_candidate,null,
    'tool-call-1','DIFF',null,null,1024,20,false,repeat('f',64));
  v_access_again:=public.record_story_commit_access(v_task,'worker-v111',v_claim,v_run,null,v_candidate,null,
    'tool-call-1','DIFF',null,null,1024,20,false,repeat('f',64));
  perform pg_temp.assert(v_access=v_access_again,'identical diff access retry is idempotent');

  v_result:=public.submit_story_commit_relevance_verdict(v_task,'worker-v111',v_claim,v_run,v_candidate,1,
    'RELATED',array['CODE_SEMANTIC_MATCH','MODULE_MATCH'],0.900,array[v_access],
    '变更新增批量关闭服务路径并与需求模块一致');
  perform pg_temp.assert((v_result->>'triage_complete')::boolean and (v_result->>'completed_count')::integer=1,
    'N/N valid AI verdicts complete triage');
  -- 完全相同的网络重试返回已有终态。
  v_result:=public.submit_story_commit_relevance_verdict(v_task,'worker-v111',v_claim,v_run,v_candidate,1,
    'RELATED',array['CODE_SEMANTIC_MATCH','MODULE_MATCH'],0.900,array[v_access],
    '变更新增批量关闭服务路径并与需求模块一致');
  perform pg_temp.assert((v_result->>'triage_complete')::boolean,'same verdict payload is idempotent');
  begin
    perform public.submit_story_commit_relevance_verdict(v_task,'worker-v111',v_claim,v_run,v_candidate,1,
      'UNRELATED',array['DIFFERENT_FEATURE'],0.100,array[v_access],'不同功能');
    perform pg_temp.assert(false,'different retry payload must conflict');
  exception when others then
    get stacked diagnostics v_error=message_text;
    perform pg_temp.assert(v_error like '%TRIAGE_VERDICT_CONFLICT%',
      'different payload raises TRIAGE_VERDICT_CONFLICT, got: '||v_error);
  end;

  v_expansion:=public.record_analysis_scope_expansion(v_task,'worker-v111',v_claim,v_run,null,
    'PRIMARY','RELATED','CALLER_CALLEE_TRACE');
  perform pg_temp.assert(
    (select current_scope_level='RELATED' from public.analysis_story_scope where task_id=v_task),
    'scope expands monotonically PRIMARY to RELATED'
  );
  begin
    perform public.record_analysis_scope_expansion(v_task,'worker-v111',v_claim,v_run,null,
      'PRIMARY','GLOBAL','CANDIDATES_INSUFFICIENT');
    perform pg_temp.assert(false,'stale from-level cannot skip current projection');
  exception when others then
    get stacked diagnostics v_error=message_text;
    perform pg_temp.assert(v_error like '%SCOPE_EXPANSION_FROM_MISMATCH%',
      'stale expansion raises from mismatch');
  end;

  reset role;
  v_summary:=public.get_analysis_story_scope_summary(v_task);
  v_commits:=public.get_analysis_story_scope_commits(v_task,0,50);
  perform pg_temp.assert((v_summary->>'read_count')::integer=1 and v_summary->>'current_scope_level'='RELATED',
    'monitor summary derives read count and actual expansion projection');
  perform pg_temp.assert((v_commits->>'total')::integer=1 and jsonb_array_length(v_commits->'items')=1,
    'monitor commit RPC paginates frozen candidates');
  perform pg_temp.assert(v_commits::text not like '%aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa%'
    and v_commits::text not like '%Story-Id: REQ-001%',
    'monitor output excludes email fingerprint and commit body');
  perform pg_temp.assert(
    public.record_story_commit_attribution_feedback(v_task,v_candidate,'RELATED','人工核对 diff 与最终代码一致') is not null,
    'ADMIN feedback appends an audit sample without rewriting historical candidate'
  );
end;
$test$;

------------------------------------------------------------------------------
-- 4. 规则草稿生命周期：锁定系统规则、模拟门禁、发布新版本、恢复产生新版本
------------------------------------------------------------------------------

do $test$
declare
  v_admin uuid:='11110000-1000-4000-a000-000000000001';
  v_source uuid:='11110000-0000-4000-a000-000000000101';
  v_draft uuid; v_revision integer; v_rules jsonb; v_valid jsonb; v_publish jsonb; v_restore jsonb;
  v_error text;
begin
  perform set_config('request.jwt.claims',json_build_object('sub',v_admin::text,'role','authenticated')::text,true);
  v_draft:=public.admin_create_attribution_rule_draft(v_source);
  select revision into v_revision from public.analysis_attribution_rule_version where id=v_draft;
  v_valid:=public.admin_validate_attribution_rule_draft(v_draft);
  perform pg_temp.assert((v_valid->>'valid')::boolean,'copied draft passes structural validation');
  begin
    perform public.admin_publish_attribution_rule_version(v_draft,v_revision,'without simulation');
    perform pg_temp.assert(false,'publish requires trusted simulation result');
  exception when others then
    get stacked diagnostics v_error=message_text;
    perform pg_temp.assert(v_error like '%RULE_SIMULATION_REQUIRED%',
      'publish without simulation raises RULE_SIMULATION_REQUIRED');
  end;

  perform public.admin_simulate_attribution_rule_draft(
    v_draft,v_revision,'SYSTEM_SAFETY_CONTRACT_V1'
  );
  v_publish:=public.admin_publish_attribution_rule_version(v_draft,v_revision,'数据库基础层回归测试');
  perform pg_temp.assert(v_publish->>'version_id'=v_draft::text,'validated simulated draft publishes atomically');
  perform pg_temp.assert(
    (select current_published_version_id=v_draft from public.analysis_attribution_rule_set
      where id='11110000-0000-4000-a000-000000000001'),
    'publish atomically switches current version'
  );

  v_restore:=public.admin_restore_attribution_rule_version(v_source,'恢复已验证系统基线');
  perform pg_temp.assert((v_restore->>'version_id')::uuid not in (v_source,v_draft),
    'restore creates a new immutable published version instead of rewriting history');
  perform pg_temp.assert(
    (select count(*)=13 from public.analysis_attribution_rule where version_id=(v_restore->>'version_id')::uuid),
    'restored version copies the complete rule catalog');
end;
$test$;

rollback;
