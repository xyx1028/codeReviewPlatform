\set ON_ERROR_STOP on
begin;
set local client_min_messages=warning;
create or replace function pg_temp.assert(p_ok boolean,p_message text)
returns void language plpgsql as $$ begin
  if p_ok is distinct from true then raise exception 'ASSERT FAILED: %',p_message; end if;
end; $$;
create or replace function pg_temp.assert_raises(p_sql text,p_error text)
returns void language plpgsql as $$
begin
  begin execute p_sql;
  exception when others then
    if strpos(sqlerrm,p_error)=0 then raise exception 'Expected %, got %',p_error,sqlerrm; end if;
    return;
  end;
  raise exception 'Expected exception %',p_error;
end; $$;

do $test$
declare
  v_admin uuid:=gen_random_uuid(); v_model uuid:=gen_random_uuid(); v_secret uuid;
  v_batch uuid:=gen_random_uuid(); v_story uuid:=gen_random_uuid(); v_job uuid:=gen_random_uuid();
  v_task uuid:=gen_random_uuid(); v_run uuid:=gen_random_uuid(); v_token uuid:=gen_random_uuid();
  v_worker text:='v143-sql-test'; v_root text:='v143-investigator'; v_session text:='v143-investigator-session';
  v_points jsonb:='[{"id":"C1","description":"取消订单释放库存","needsClarification":false,"sources":[{"sourceId":"body","quote":"取消订单释放库存"}]}]';
  v_report jsonb:='{"findings":[{"criterionId":"C1","verdict":"UNCERTAIN","reason":"尚不能确认调用链","evidenceIds":[]}],"risks":[]}';
  v_final jsonb; v_sql text; v_round integer;
begin
  perform pg_temp.assert((select relrowsecurity from pg_class where oid='public.analysis_review_phase'::regclass),'phase records have RLS');
  perform pg_temp.assert(not has_table_privilege('authenticated','public.analysis_review_phase','SELECT'),'browser cannot read internal drafts');
  perform pg_temp.assert(has_function_privilege('service_role','public.begin_analysis_review_phase(uuid,text,uuid,integer,text,integer,text,text)','EXECUTE'),'platform may start a phase');
  perform pg_temp.assert(not has_function_privilege('authenticated','public.begin_analysis_review_phase(uuid,text,uuid,integer,text,integer,text,text)','EXECUTE'),'browser cannot start a phase');
  perform pg_temp.assert(not has_function_privilege('service_role','public.assert_acceptance_review_final(uuid,integer,jsonb,jsonb)','EXECUTE'),'internal gate is not a bypass API');
  insert into auth.users(id,email) values(v_admin,v_admin::text||'@example.test');
  insert into public.user_profile(id,role) values(v_admin,'ADMIN') on conflict(id) do update set role='ADMIN';
  select vault.create_secret('v143-fake-test-key',v_admin::text) into v_secret;
  insert into public.ai_model_config(id,display_name,base_url,model_name,api_key_secret_id,created_by)
  values(v_model,'V143 SQL test','https://example.test','test',v_secret,v_admin);
  insert into public.review_batch(id,name,week_code,default_branch,created_by)
  values(v_batch,'V143 SQL test',v_batch::text,'feature_dev',v_admin);
  insert into public.review_story(id,batch_id,story_code,story_name,owners_text)
  values(v_story,v_batch,'V143-SQL','取消订单','tester');
  insert into public.analysis_job(id,batch_id,model_config_id,model_snapshot,requested_branch,requested_by,capability_policy_snapshot)
  values(v_job,v_batch,v_model,'{}','feature_dev',v_admin,public.build_v4_capability_policy(v_model));
  perform pg_temp.assert((select review_workflow_version=1 from public.analysis_job where id=v_job),'new jobs require the workflow');
  perform pg_temp.assert_raises(format('update public.analysis_job set review_workflow_version=0 where id=%L',v_job),'REVIEW_WORKFLOW_VERSION_IMMUTABLE');
  insert into public.analysis_worker_heartbeat(worker_id,slots,current_tasks,capabilities)
  values('v143-old-sql-worker',1,0,'{"storyCommitScopeVersion":2}');
  perform pg_temp.assert((public.claim_job_for_preparation('v143-old-sql-worker',900)#>>'{job,id}') is distinct from v_job::text,'old workers cannot prepare V1 workflow jobs');
  update public.analysis_job set status='FINALIZING',finalize_lease_expires_at=now()-interval '1 minute' where id=v_job;
  perform pg_temp.assert((public.claim_job_for_finalization('v143-old-sql-worker',900)#>>'{job,id}') is distinct from v_job::text,'old workers cannot finalize V1 workflow jobs');
  update public.analysis_job set status='QUEUED',finalize_lease_expires_at=null where id=v_job;
  insert into public.analysis_story_task(id,job_id,story_id,worker_id,lease_expires_at,agent_status,agent_attempt,claim_token_digest)
  values(v_task,v_job,v_story,v_worker,now()+interval '10 minutes','RUNNING',1,public.agent_claim_token_digest(v_token));
  insert into public.analysis_agent_run(id,task_id,job_id,agent_attempt,worker_id,root_agent_id,root_session_id)
  values(v_run,v_task,v_job,1,v_worker,v_root,v_session);
  perform public.register_analysis_agent_node(v_task,v_worker,v_token,1,v_root,v_session,null,'root-reviewer','root',repeat('a',64));

  perform pg_temp.assert_raises(format('select public.begin_analysis_review_phase(%L,%L,%L,1,''VERIFY'',0,''b'',''b-session'')',v_task,v_worker,v_token),'REVIEW_PHASE_ORDER_INVALID');
  perform pg_temp.assert_raises(format('select public.begin_analysis_review_phase(%L,%L,%L,1,''EXTRACT'',0,%L,%L)',v_task,v_worker,gen_random_uuid(),v_root,v_session),'TASK_LEASE_LOST');
  perform public.begin_analysis_review_phase(v_task,v_worker,v_token,1,'EXTRACT',0,v_root,v_session);
  perform pg_temp.assert_raises(format('select public.begin_analysis_review_phase(%L,%L,%L,1,''INVESTIGATE'',0,%L,%L)',v_task,v_worker,v_token,v_root,v_session),'REVIEW_PHASE_STILL_RUNNING');
  perform pg_temp.assert_raises(format('select public.save_analysis_review_phase(%L,%L,%L,1,''EXTRACT'',0,%L,''[]'')',v_task,v_worker,v_token,v_root),'REVIEW_CRITERIA_INVALID');
  perform public.save_analysis_review_phase(v_task,v_worker,v_token,1,'EXTRACT',0,v_root,v_points);
  perform public.save_analysis_review_phase(v_task,v_worker,v_token,1,'EXTRACT',0,v_root,v_points);
  perform pg_temp.assert_raises(format('select public.save_agent_review_result(%L,%L,%L,1,''{}'',''[]'')',v_task,v_worker,v_token),'REVIEW_INDEPENDENT_VERIFICATION_REQUIRED');

  for v_round in 0..1 loop
    perform public.begin_analysis_review_phase(v_task,v_worker,v_token,1,'INVESTIGATE',v_round,v_root,v_session);
    perform pg_temp.assert_raises(format('select public.save_analysis_review_phase(%L,%L,%L,1,''INVESTIGATE'',%s,%L,%L)',v_task,v_worker,v_token,v_round,v_root,
      jsonb_build_object('agentId',v_root,'report',jsonb_set(v_report,'{findings}','[]'),'evidence','[]'::jsonb)::text),'REVIEW_CRITERIA_COVERAGE_INVALID');
    perform pg_temp.assert_raises(format('select public.save_analysis_review_phase(%L,%L,%L,1,''INVESTIGATE'',%s,%L,%L)',v_task,v_worker,v_token,v_round,v_root,
      jsonb_build_object('agentId',v_root,'report',jsonb_set(v_report,'{risks}','[{"id":"R1","criterionIds":["C99"],"title":"遗漏场景","trigger":"重复取消","impact":"库存增加","certainty":"SUSPECTED","origin":"UNKNOWN","evidenceIds":[]}]'),'evidence','[]'::jsonb)::text),'REVIEW_RISK_INVALID');
    perform public.save_analysis_review_phase(v_task,v_worker,v_token,1,'INVESTIGATE',v_round,v_root,jsonb_build_object('agentId',v_root,'report',v_report,'evidence','[]'::jsonb));
    perform pg_temp.assert_raises(format('select public.begin_analysis_review_phase(%L,%L,%L,1,''VERIFY'',%s,%L,%L)',v_task,v_worker,v_token,v_round,v_root,v_session),'REVIEW_INDEPENDENT_ROOT_REQUIRED');
    perform pg_temp.assert_raises(format('select public.register_analysis_agent_node(%L,%L,%L,1,''unapproved'',''unapproved-session'',null,''root-reviewer'',''root'',%L)',v_task,v_worker,v_token,repeat('a',64)),'AGENT_IDENTITY_INVALID');
    perform public.begin_analysis_review_phase(v_task,v_worker,v_token,1,'VERIFY',v_round,'verifier-'||v_round,'verifier-session-'||v_round);
    perform public.register_analysis_agent_node(v_task,v_worker,v_token,1,'verifier-'||v_round,'verifier-session-'||v_round,null,'root-reviewer','root',repeat('a',64));
    perform pg_temp.assert((select root_agent_id=v_root and root_session_id=v_session from public.analysis_agent_run where id=v_run),'peer registration preserves publishing anchor');
    perform public.save_analysis_review_phase(v_task,v_worker,v_token,1,'VERIFY',v_round,'verifier-'||v_round,jsonb_build_object('agentId','verifier-'||v_round,'report',v_report,'evidence','[]'::jsonb));
  end loop;
  perform pg_temp.assert((select count(*)=3 from public.analysis_agent_node where agent_run_id=v_run and provider='root'),'three platform roots may coexist');
  perform pg_temp.assert_raises(format('select public.begin_analysis_review_phase(%L,%L,%L,1,''INVESTIGATE'',2,%L,%L)',v_task,v_worker,v_token,v_root,v_session),'REVIEW_PHASE_INVALID');
  v_final:=v_report||jsonb_build_object('version',1,'criteria',v_points,'supplementRounds',1,'sources','[]'::jsonb,
    'verification',jsonb_build_object('status','CONFIRMED','investigationAgentId',v_root,'verificationAgentId','verifier-1','disagreementIds','[]'::jsonb,'riskDisagreementIds','[]'::jsonb));
  perform public.assert_acceptance_review_final(v_task,1,jsonb_build_object('acceptanceReview',v_final),'[]');
  perform pg_temp.assert_raises(format('select public.assert_acceptance_review_final(%L,1,%L,''[]'')',v_task,
    jsonb_build_object('acceptanceReview',jsonb_set(v_final,'{risks}','[{"id":"invented-risk"}]'))::text),'REVIEW_RISK_INVALID');
  perform pg_temp.assert_raises(format('select public.assert_acceptance_review_final(%L,1,%L,''[]'')',v_task,
    jsonb_build_object('acceptanceReview',jsonb_set(v_final,'{findings,0,verdict}','"IMPLEMENTED"'))::text),'REVIEW_FINAL_VERDICT_INVALID');
  perform pg_temp.assert_raises(format('select public.assert_acceptance_review_final(%L,1,%L,''[]'')',v_task,
    jsonb_build_object('acceptanceReview',jsonb_set(v_final,'{findings,0,evidenceIds}','["forged"]'))::text),'REVIEW_EVIDENCE_BINDING_INVALID');
  update public.analysis_review_phase set result=jsonb_set(result,'{report,findings,0,verdict}','"NOT_IMPLEMENTED"')
  where agent_run_id=v_run and phase='INVESTIGATE' and supplement_round=1;
  v_final:=jsonb_set(v_final,'{findings,0,disagreement}','{"investigationVerdict":"NOT_IMPLEMENTED","reviewVerdict":"UNCERTAIN"}');
  v_final:=jsonb_set(v_final,'{verification,status}','"DISAGREEMENT"');
  perform public.assert_acceptance_review_final(v_task,1,jsonb_build_object('acceptanceReview',v_final),'[]');
  perform pg_temp.assert_raises(format('select public.assert_acceptance_review_final(%L,1,%L,''[]'')',v_task,
    jsonb_build_object('acceptanceReview',jsonb_set(v_final,'{verification,status}','"CONFIRMED"'))::text),'REVIEW_VERIFICATION_STATUS_INVALID');
  perform pg_temp.assert((select agent_status='RUNNING' from public.analysis_story_task where id=v_task),'phase submissions do not settle task claim');
  perform pg_temp.assert((select count(*)=0 from public.ai_review_result where story_id=v_story),'drafts are not published');
  -- A verified risk cannot reuse investigation-owned evidence, even with a valid receipt ID.
  update public.analysis_review_phase set result=jsonb_set(result,'{report,risks}',
    '[{"id":"R1","criterionIds":["C1"],"title":"重复释放","trigger":"重复取消","impact":"库存增加","certainty":"CONFIRMED","origin":"UNKNOWN","evidenceIds":["ev-risk"]}]')
  where agent_run_id=v_run and phase in ('INVESTIGATE','VERIFY') and supplement_round=1;
  v_final:=jsonb_set(v_final,'{risks}','[{"id":"R1","criterionIds":["C1"],"title":"重复释放","trigger":"重复取消","impact":"库存增加","certainty":"CONFIRMED","origin":"UNKNOWN","evidenceIds":["ev-risk"]}]');
  perform pg_temp.assert_raises(format('select public.assert_acceptance_review_final(%L,1,%L,%L)',v_task,
    jsonb_build_object('acceptanceReview',v_final)::text,jsonb_build_array(jsonb_build_object('evidence_id','ev-risk','producer_agent_id',v_root))::text),'REVIEW_INDEPENDENT_EVIDENCE_REQUIRED');
  perform public.assert_acceptance_review_final(v_task,1,jsonb_build_object('acceptanceReview',v_final),
    '[{"evidence_id":"ev-risk","producer_agent_id":"verifier-1"}]');
end;
$test$;
select 'ALL_V143_WORKFLOW_SQL_TESTS_PASSED';
rollback;
