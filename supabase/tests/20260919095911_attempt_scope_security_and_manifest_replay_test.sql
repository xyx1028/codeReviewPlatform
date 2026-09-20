-- V1.11 independent final-review critical database regressions; transactionally rolled back.
\set ON_ERROR_STOP on
\timing off
\set QUIET on

begin;
set local client_min_messages=warning;

create or replace function pg_temp.assert(p_cond boolean,p_msg text)
returns void language plpgsql as $$
begin
  if p_cond is null or not p_cond then raise exception 'ASSERT FAILED: %',p_msg; end if;
end;
$$;

------------------------------------------------------------------------------
-- 1. Final schema, grants and manifest r3 replay behavior.
------------------------------------------------------------------------------

do $test$
declare
  v_error text;
begin
  perform pg_temp.assert(
    (select count(*)=1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname='save_agent_review_result'),
    'save_agent_review_result has no stale overload');
  perform pg_temp.assert(
    (select count(*)=1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname='claim_next_story_task'),
    'claim_next_story_task has no stale overload');
  perform pg_temp.assert(
    (select count(*)=1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname='save_analysis_session_checkpoint'),
    'save_analysis_session_checkpoint has no stale overload');
  perform pg_temp.assert(
    (select count(*)=1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname='load_resumable_analysis_attempt'),
    'load_resumable_analysis_attempt has no stale overload');
  perform pg_temp.assert(
    has_function_privilege('service_role',
      'public.save_agent_review_result(uuid,text,uuid,integer,jsonb,jsonb,jsonb,text,text,text,integer,integer,text,text,text)','EXECUTE')
    and not has_function_privilege('authenticated',
      'public.save_agent_review_result(uuid,text,uuid,integer,jsonb,jsonb,jsonb,text,text,text,integer,integer,text,text,text)','EXECUTE'),
    'final result writer remains service-role only');

  perform pg_temp.assert(exists(select 1 from public.v4_harness_manifest where manifest_revision=3),
    'r3 manifest exists before replay');

  -- Equivalent to the generated r3 update+insert flow. The BEFORE INSERT guard must
  -- reactivate the identical row and skip its duplicate primary-key insert.
  update public.v4_harness_manifest set is_active=false where is_active;
  insert into public.v4_harness_manifest(
    manifest_revision,contract_version,harness_version,manifest_hash,default_policy,is_active
  ) select manifest_revision,contract_version,harness_version,manifest_hash,default_policy,true
    from public.v4_harness_manifest where manifest_revision=3;
  update public.v4_harness_manifest set is_active=false where is_active;
  insert into public.v4_harness_manifest(
    manifest_revision,contract_version,harness_version,manifest_hash,default_policy,is_active
  ) select manifest_revision,contract_version,harness_version,manifest_hash,default_policy,true
    from public.v4_harness_manifest where manifest_revision=3;

  perform pg_temp.assert(
    (select count(*)=1 from public.v4_harness_manifest where manifest_revision=3)
    and (select is_active from public.v4_harness_manifest where manifest_revision=3)
    and (select count(*)=1 from public.v4_harness_manifest where is_active),
    'two identical r3 replays leave one active r3 row');

  begin
    insert into public.v4_harness_manifest(
      manifest_revision,contract_version,harness_version,manifest_hash,default_policy,is_active
    ) select manifest_revision,contract_version,harness_version||'-conflict',manifest_hash,
      default_policy,true from public.v4_harness_manifest where manifest_revision=3;
    perform pg_temp.assert(false,'same revision with conflicting content must fail closed');
  exception when others then
    get stacked diagnostics v_error=message_text;
    perform pg_temp.assert(v_error like '%V4_HARNESS_MANIFEST_REVISION_CONFLICT%',
      'conflicting r3 replay returns the stable conflict code');
  end;
  perform pg_temp.assert((select count(*)=1 from public.v4_harness_manifest where is_active),
    'conflicting replay does not disturb the unique active row');
end;
$test$;

------------------------------------------------------------------------------
-- 2. V2 fixture: one frozen generation with N=2 AI triage candidates and files.
------------------------------------------------------------------------------

do $fixture$
declare
  v_admin uuid:='11590000-1000-4000-a000-000000000001';
  v_model uuid:='11590000-2000-4000-a000-000000000001';
  v_batch uuid:='11590000-3000-4000-a000-000000000001';
  v_story uuid:='11590000-4000-4000-a000-000000000001';
  v_job uuid:='11590000-5000-4000-a000-000000000001';
  v_task uuid:='11590000-6000-4000-a000-000000000001';
  v_snapshot uuid:='11590000-7000-4000-a000-000000000001';
  v_commit_a uuid:='11590000-8000-4000-a000-000000000001';
  v_commit_b uuid:='11590000-8000-4000-a000-000000000002';
  v_scope uuid:='11590000-9000-4000-a000-000000000001';
  v_rule_version uuid;
  v_rule_hash text;
  v_policy jsonb;
  v_secret uuid;
begin
  insert into auth.users(id,email) values(v_admin,'attempt-scope-test@example.invalid');
  insert into public.user_profile(id,role,display_name)
  values(v_admin,'ADMIN','Attempt scope test')
  on conflict(id) do update set role=excluded.role,display_name=excluded.display_name;
  set local role service_role;
  v_secret:=public.admin_vault_create_secret(
    'attempt-scope-test-not-a-real-key','attempt_scope_test_model_key');
  reset role;
  select default_policy into v_policy from public.v4_harness_manifest where is_active;
  select version.id,version.ruleset_hash into v_rule_version,v_rule_hash
  from public.analysis_attribution_rule_set rule_set
  join public.analysis_attribution_rule_version version
    on version.id=rule_set.current_published_version_id
  where rule_set.rule_set_code='STORY_COMMIT_ATTRIBUTION';

  insert into public.ai_model_config(
    id,display_name,base_url,model_name,api_key_secret_id,enabled,max_parallel_tasks,request_timeout_ms,
    context_window,max_output_tokens,agent_max_model_requests,agent_max_retry_requests,
    agent_max_compaction_requests,created_by
  ) values(
    v_model,'attempt scope model','https://attempt-scope.example.invalid','scope-model',v_secret,true,4,
    123456,131072,8192,120,6,4,v_admin
  );
  insert into public.review_batch(id,name,week_code,default_branch,ai_model_config_id,created_by)
  values(v_batch,'attempt scope batch','V111-ATTEMPT-SCOPE','feature_dev',v_model,v_admin);
  insert into public.review_story(
    id,batch_id,story_code,story_name,owners_text,project_name,application_name,source_data
  ) values(
    v_story,v_batch,'REQ-ATTEMPT','attempt isolated triage','owner','project','application',
    jsonb_build_object('详细描述','frozen requirement')
  );
  insert into public.analysis_job(
    id,batch_id,model_config_id,model_snapshot,requested_branch,status,requested_by,
    total_stories,execution_engine,policy_version,capability_policy_snapshot,policy_hash,
    analysis_context_version,commit_window_days,scope_status,required_worker_scope_version,
    attribution_algorithm_version,attribution_rule_version_id,ruleset_hash,
    story_input_catalog_hash,identity_snapshot_hash,repository_manifest_hash,selected_scope_hash,
    skill_catalog_hash,skill_snapshot_version,created_at
  ) values(
    v_job,v_batch,v_model,jsonb_build_object(
      'max_parallel_tasks',4,'context_window',131072,'max_output_tokens',8192,
      'agent_max_model_requests',120,'agent_max_retry_requests',6,
      'agent_max_compaction_requests',4,'request_timeout_ms',123456
    ),'feature_dev','PROCESSING',v_admin,1,'deepseek-harness-acp',4,v_policy,repeat('0',64),
    2,21,'READY',2,'story-attribution-v2',v_rule_version,v_rule_hash,
    repeat('1',64),repeat('2',64),repeat('3',64),repeat('4',64),
    public.empty_skill_catalog_hash(),1,now()-interval '1 minute'
  );
  insert into public.analysis_story_task(id,job_id,story_id) values(v_task,v_job,v_story);
  insert into public.analysis_job_story_snapshot(
    job_id,story_id,story_code,story_name,owners_text,requirement_context,input_hash
  ) values(v_job,v_story,'REQ-ATTEMPT','attempt isolated triage','owner',
    jsonb_build_object('detailed_description','frozen requirement'),repeat('5',64));
  insert into public.analysis_repository_snapshot(
    id,job_id,repository_name,requested_branch,commit_sha,head_sha,enumeration_status,
    commit_count,commit_manifest_hash
  ) values(v_snapshot,v_job,'kdmanage-backend','feature_dev',repeat('a',40),repeat('a',40),
    'COMPLETE',2,repeat('6',64));
  insert into public.analysis_repository_commit(
    id,snapshot_id,sha,sequence_no,author_name,committed_at,subject,files_changed,
    additions,deletions,effective_status
  ) values
    (v_commit_a,v_snapshot,repeat('b',40),0,'Author A',now()-interval '2 days',
      'candidate A',1,10,1,'EFFECTIVE'),
    (v_commit_b,v_snapshot,repeat('c',40),1,'Author B',now()-interval '1 day',
      'candidate B',1,5,2,'EFFECTIVE');
  insert into public.analysis_commit_file(commit_id,file_order,path,change_type,additions,deletions)
  values(v_commit_a,0,'src/a.ts','MODIFIED',10,1),
        (v_commit_b,0,'src/b.ts','MODIFIED',5,2);
  insert into public.analysis_story_scope(
    id,task_id,generation,scope_mode,status,current_scope_level,algorithm_version,ruleset_hash,
    candidate_manifest_hash,candidate_count,strong_count,ai_candidate_count,
    triage_required_count,triage_completed_count,triage_complete,frozen_at
  ) values(v_scope,v_task,1,'HYBRID_CANDIDATES','READY','PRIMARY','story-attribution-v2',
    v_rule_hash,repeat('7',64),2,0,2,2,0,false,now());
  insert into public.analysis_story_commit_candidate(
    id,scope_id,task_id,generation,commit_id,tier,selection_source,rank_score,reason_codes
  ) values
    ('11590000-a000-4000-a000-000000000001',v_scope,v_task,1,v_commit_a,
      'AI_CANDIDATE','IDENTITY_WINDOW',500,array['OWNER_WINDOW_MODULE']),
    ('11590000-a000-4000-a000-000000000002',v_scope,v_task,1,v_commit_b,
      'WEAK','FALLBACK',300,array['BOT_OR_GENERATED']);
  insert into public.analysis_worker_heartbeat(worker_id,slots,current_tasks,capabilities)
  values('worker-attempt-a',2,0,jsonb_build_object('storyCommitScopeVersion',2)),
        ('worker-attempt-b',2,0,jsonb_build_object('storyCommitScopeVersion',2)),
        ('worker-v1',2,0,'{}'::jsonb);
end;
$fixture$;

------------------------------------------------------------------------------
-- 3. Attempt A reaches N/N; B must begin at 0/N and cannot final-save early.
------------------------------------------------------------------------------

do $test$
declare
  v_task uuid:='11590000-6000-4000-a000-000000000001';
  v_claim_a jsonb; v_claim_b jsonb; v_scope jsonb; v_resume jsonb;
  v_token_a uuid; v_token_b uuid; v_run_a uuid; v_run_b uuid;
  v_digest text; v_policy text; v_revision integer; v_error text; v_receipt jsonb;
begin
  set local role service_role;
  v_claim_a:=public.claim_next_story_task('worker-attempt-a',900);
  reset role;
  v_token_a:=(v_claim_a->>'claim_token')::uuid;
  v_run_a:=(v_claim_a->>'agent_run_id')::uuid;
  perform pg_temp.assert((v_claim_a->>'agent_attempt')::integer=1,'A is attempt 1');

  set local role service_role;
  v_scope:=public.get_story_task_analysis_scope(v_task,'worker-attempt-a',v_token_a);
  reset role;
  perform pg_temp.assert((v_scope->>'triage_completed_count')::integer=0
      and (v_scope->>'triage_required_count')::integer=2
      and not (v_scope->>'triage_complete')::boolean,
    'A starts at 0/N');
  perform pg_temp.assert(jsonb_array_length(v_scope->'candidates'->0->'files')=1
      and v_scope->'candidates'->0->'files'->0->>'path'='src/a.ts'
      and not (v_scope->'candidates'->0->>'selected')::boolean,
    'scope getter exposes commit files and untriaged candidates are not PRIMARY selected');

  set local role service_role;
  begin
    perform public.save_analysis_session_checkpoint(
      v_task,'worker-attempt-a',v_token_a,1,'session-attempt-a',1,
      '/workspace/agent-sessions/attempt-a/session.v3.jsonl','sha256:a',10,
      '0.1.5-rc.1/v3','profile-hash-a','OPEN',public.empty_skill_catalog_hash(),100,
      'wrong-scope-hash',
      (select attribution_ruleset_hash from public.analysis_agent_run where id=v_run_a)
    );
    perform pg_temp.assert(false,'checkpoint must reject a Worker scope mismatch');
  exception when others then
    get stacked diagnostics v_error=message_text;
    perform pg_temp.assert(v_error like '%SESSION_ANALYSIS_SCOPE_MISMATCH%',
      'checkpoint rejects explicit Worker scope mismatch');
  end;
  perform pg_temp.assert(not exists(select 1 from public.analysis_session_checkpoint
    where agent_run_id=v_run_a),'rejected checkpoint leaves no row');

  perform public.save_analysis_session_checkpoint(
    v_task,'worker-attempt-a',v_token_a,1,'session-attempt-a',1,
    '/workspace/agent-sessions/attempt-a/session.v3.jsonl','sha256:a',10,
    '0.1.5-rc.1/v3','profile-hash-a','OPEN',public.empty_skill_catalog_hash(),100,
    public.analysis_agent_run_scope_hash(v_run_a),
    (select attribution_ruleset_hash from public.analysis_agent_run where id=v_run_a)
  );
  perform public.submit_story_commit_relevance_verdict(
    v_task,'worker-attempt-a',v_token_a,v_run_a,
    '11590000-a000-4000-a000-000000000001',1,'UNCERTAIN',
    array['DIFF_UNAVAILABLE'],0.5,array[]::uuid[],'A cannot read candidate one');
  perform public.submit_story_commit_relevance_verdict(
    v_task,'worker-attempt-a',v_token_a,v_run_a,
    '11590000-a000-4000-a000-000000000002',1,'UNCERTAIN',
    array['DIFF_UNAVAILABLE'],0.5,array[]::uuid[],'A cannot read candidate two');
  v_scope:=public.get_story_task_analysis_scope(v_task,'worker-attempt-a',v_token_a);
  reset role;
  perform pg_temp.assert((v_scope->>'triage_completed_count')::integer=2
      and (v_scope->>'triage_complete')::boolean,
    'A reaches N/N');
  perform pg_temp.assert((v_scope->'candidates'->0->>'selected')::boolean
      and v_scope->'candidates'->0->>'selection_level'='PRIMARY',
    'current-run UNCERTAIN is distinctly PRIMARY selected');
  perform pg_temp.assert((select analysis_scope_hash=public.analysis_agent_run_scope_hash(v_run_a)
      and attribution_ruleset_hash=(select attribution_ruleset_hash from public.analysis_agent_run where id=v_run_a)
    from public.analysis_session_checkpoint where agent_run_id=v_run_a),
    'checkpoint persists the run scope identity and attribution ruleset');

  -- Model a failed/requeued A without invoking fail_agent_review, whose product semantics
  -- intentionally fail the entire Job. This is the stale-takeover retry shape.
  update public.analysis_agent_run set status='FAILED',sealed_at=now(),finished_at=now()
  where id=v_run_a;
  update public.analysis_story_task set agent_status='PENDING',worker_id=null,
    lease_expires_at=null,heartbeat_at=null,claim_token_digest=null,error_code=null,error_message=null
  where id=v_task;

  set local role service_role;
  v_claim_b:=public.claim_next_story_task('worker-attempt-b',900);
  reset role;
  v_token_b:=(v_claim_b->>'claim_token')::uuid;
  v_run_b:=(v_claim_b->>'agent_run_id')::uuid;
  perform pg_temp.assert((v_claim_b->>'agent_attempt')::integer=2,'B is attempt 2');
  set local role service_role;
  v_scope:=public.get_story_task_analysis_scope(v_task,'worker-attempt-b',v_token_b);
  reset role;
  perform pg_temp.assert((v_scope->>'triage_completed_count')::integer=0
      and (v_scope->>'triage_required_count')::integer=2
      and not (v_scope->>'triage_complete')::boolean,
    'B cannot inherit A completion and starts at 0/N');
  perform pg_temp.assert((select triage_completed_count=0 and not triage_complete
    from public.analysis_story_scope where task_id=v_task and generation=1),
    'claim also resets the shared current-attempt projection');

  -- Recovery fails closed on scope drift, while profile_hash remains available as
  -- the independent second gate after a successful scope check.
  update public.analysis_session_checkpoint set analysis_scope_hash='tampered'
  where agent_run_id=v_run_a;
  begin
    set local role service_role;
    perform public.load_resumable_analysis_attempt(v_task,'worker-attempt-b',v_token_b,true);
    reset role;
    perform pg_temp.assert(false,'tampered analysis scope must not resume');
  exception when others then
    reset role;
    get stacked diagnostics v_error=message_text;
    perform pg_temp.assert(v_error like '%SESSION_ANALYSIS_SCOPE_MISMATCH%',
      'scope mismatch has its explicit recovery code');
  end;
  update public.analysis_session_checkpoint
  set analysis_scope_hash=public.analysis_agent_run_scope_hash(v_run_a)
  where agent_run_id=v_run_a;
  set local role service_role;
  v_resume:=public.load_resumable_analysis_attempt(v_task,'worker-attempt-b',v_token_b,true);
  reset role;
  perform pg_temp.assert(v_resume->>'analysis_scope_hash'=public.analysis_agent_run_scope_hash(v_run_b)
      and v_resume->>'attribution_ruleset_hash'=(select attribution_ruleset_hash
        from public.analysis_agent_run where id=v_run_b)
      and v_resume->>'profile_hash'='profile-hash-a',
    'successful recovery returns scope/ruleset plus profile_hash second gate');

  insert into public.analysis_agent_node(
    agent_run_id,agent_id,session_id,agent_role,provider,delegation_depth,tool_policy_hash
  ) values(v_run_b,'agent-root-b','session-root-b','root-reviewer','root',0,'tool-policy-b');
  set local role service_role;
  v_digest:=public.analysis_agent_tree_digest(v_run_b);
  reset role;
  select policy_hash,session_revision into v_policy,v_revision
  from public.analysis_agent_run where id=v_run_b;

  begin
    set local role service_role;
    perform public.save_agent_review_result(
      v_task,'worker-attempt-b',v_token_b,2,
      jsonb_build_object('verdict','IMPLEMENTED','confidence',90,'summary','too early'),
      '[]'::jsonb,jsonb_build_object(
        'root_agent_id','agent-root-b','root_session_id','session-root-b',
        'tree_digest',v_digest,'session_revision',v_revision,'policy_hash',v_policy
      ),null,null,null,
      1,2,repeat('7',64),public.analysis_agent_run_scope_hash(v_run_b),
      (select attribution_ruleset_hash from public.analysis_agent_run where id=v_run_b)
    );
    reset role;
    perform pg_temp.assert(false,'B cannot save final before its own N/N');
  exception when others then
    reset role;
    get stacked diagnostics v_error=message_text;
    perform pg_temp.assert(v_error like '%ANALYSIS_SCOPE_TRIAGE_INCOMPLETE%0/2%',
      'atomic final gate reports B current-run 0/2');
  end;
  perform pg_temp.assert((select agent_status='RUNNING' and agent_output is null
    from public.analysis_story_task where id=v_task),
    'rejected final save writes no result');

  set local role service_role;
  perform public.submit_story_commit_relevance_verdict(
    v_task,'worker-attempt-b',v_token_b,v_run_b,
    '11590000-a000-4000-a000-000000000001',2,'UNCERTAIN',
    array['DIFF_UNAVAILABLE'],0.5,array[]::uuid[],'B cannot read candidate one');
  perform public.submit_story_commit_relevance_verdict(
    v_task,'worker-attempt-b',v_token_b,v_run_b,
    '11590000-a000-4000-a000-000000000002',2,'UNCERTAIN',
    array['DIFF_UNAVAILABLE'],0.5,array[]::uuid[],'B cannot read candidate two');

  begin
    perform public.save_agent_review_result(
      v_task,'worker-attempt-b',v_token_b,2,
      jsonb_build_object('verdict','IMPLEMENTED','confidence',91,'summary','wrong identity'),
      '[]'::jsonb,jsonb_build_object(
        'root_agent_id','agent-root-b','root_session_id','session-root-b',
        'tree_digest',v_digest,'session_revision',v_revision,'policy_hash',v_policy
      ),null,'agent-review-v2','scope-model',
      1,2,'wrong-manifest-hash',public.analysis_agent_run_scope_hash(v_run_b),
      (select attribution_ruleset_hash from public.analysis_agent_run where id=v_run_b)
    );
    perform pg_temp.assert(false,'final save must reject a Worker manifest mismatch');
  exception when others then
    get stacked diagnostics v_error=message_text;
    perform pg_temp.assert(v_error like '%ANALYSIS_SCOPE_IDENTITY_MISMATCH%',
      'final save rejects explicit Worker scope identity mismatch');
  end;
  perform pg_temp.assert((select agent_status='RUNNING' and agent_output is null
    from public.analysis_story_task where id=v_task)
    and (select status='RUNNING' from public.analysis_agent_run where id=v_run_b),
    'scope-mismatched final save rolls back every canonical result write');

  v_receipt:=public.save_agent_review_result(
    v_task,'worker-attempt-b',v_token_b,2,
    jsonb_build_object('verdict','IMPLEMENTED','confidence',91,'summary','B completed N/N'),
    '[]'::jsonb,jsonb_build_object(
      'root_agent_id','agent-root-b','root_session_id','session-root-b',
      'tree_digest',v_digest,'session_revision',v_revision,'policy_hash',v_policy
    ),null,'agent-review-v2','scope-model',
    1,2,repeat('7',64),public.analysis_agent_run_scope_hash(v_run_b),
    (select attribution_ruleset_hash from public.analysis_agent_run where id=v_run_b)
  );
  reset role;
  perform pg_temp.assert(v_receipt->>'run_id'=v_run_b::text
      and (select agent_status='SUCCEEDED' from public.analysis_story_task where id=v_task)
      and (select status='COMMITTED' from public.analysis_agent_run where id=v_run_b),
    'B succeeds only after its own N/N');
end;
$test$;

------------------------------------------------------------------------------
-- 4. V1 keeps the old no-triage final-save semantics.
------------------------------------------------------------------------------

do $test$
declare
  v_admin uuid:='11590000-1000-4000-a000-000000000001';
  v_model uuid:='11590000-2000-4000-a000-000000000001';
  v_batch uuid:='11590000-3000-4000-a000-000000000002';
  v_story uuid:='11590000-4000-4000-a000-000000000002';
  v_job uuid:='11590000-5000-4000-a000-000000000002';
  v_task uuid:='11590000-6000-4000-a000-000000000002';
  v_policy jsonb; v_claim jsonb; v_run uuid; v_token uuid;
  v_digest text; v_policy_hash text; v_revision integer; v_receipt jsonb;
begin
  select default_policy into v_policy from public.v4_harness_manifest where is_active;
  insert into public.review_batch(id,name,week_code,default_branch,ai_model_config_id,created_by)
  values(v_batch,'legacy save batch','V111-LEGACY-SAVE','feature_dev',v_model,v_admin);
  insert into public.review_story(id,batch_id,story_code,story_name,owners_text)
  values(v_story,v_batch,'REQ-LEGACY-SAVE','legacy final save','owner');
  insert into public.analysis_job(
    id,batch_id,model_config_id,model_snapshot,requested_branch,status,requested_by,
    total_stories,execution_engine,policy_version,capability_policy_snapshot,policy_hash,
    analysis_context_version,scope_status,required_worker_scope_version,
    skill_catalog_hash,skill_snapshot_version,created_at
  ) values(v_job,v_batch,v_model,jsonb_build_object('max_parallel_tasks',4),
    'feature_dev','PROCESSING',v_admin,1,'deepseek-harness-acp',4,v_policy,repeat('0',64),
    1,'LEGACY',1,public.empty_skill_catalog_hash(),1,now());
  insert into public.analysis_story_task(id,job_id,story_id) values(v_task,v_job,v_story);

  set local role service_role;
  v_claim:=public.claim_next_story_task('worker-v1',900);
  reset role;
  v_token:=(v_claim->>'claim_token')::uuid;
  v_run:=(v_claim->>'agent_run_id')::uuid;
  insert into public.analysis_agent_node(
    agent_run_id,agent_id,session_id,agent_role,provider,delegation_depth,tool_policy_hash
  ) values(v_run,'agent-root-v1','session-root-v1','root-reviewer','root',0,'tool-policy-v1');
  set local role service_role;
  v_digest:=public.analysis_agent_tree_digest(v_run);
  reset role;
  select policy_hash,session_revision into v_policy_hash,v_revision
  from public.analysis_agent_run where id=v_run;
  set local role service_role;
  v_receipt:=public.save_agent_review_result(
    v_task,'worker-v1',v_token,1,
    jsonb_build_object('verdict','IMPLEMENTED','confidence',80,'summary','legacy no triage'),
    '[]'::jsonb,jsonb_build_object(
      'root_agent_id','agent-root-v1','root_session_id','session-root-v1',
      'tree_digest',v_digest,'session_revision',v_revision,'policy_hash',v_policy_hash
    ),null,'agent-review-v1','scope-model'
  );
  reset role;
  perform pg_temp.assert(v_receipt->>'run_id'=v_run::text
      and (select agent_status='SUCCEEDED' from public.analysis_story_task where id=v_task),
    'V1 final save remains independent of V2 triage');
end;
$test$;

rollback;
