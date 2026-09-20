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

do $test$
begin
  perform pg_temp.assert(
    to_regprocedure('public.save_analysis_repository_merge_requests(uuid,text,text,text,text,jsonb)') is not null,
    'MR enrichment RPC exists');
  perform pg_temp.assert(
    has_function_privilege('service_role',
      'public.save_analysis_repository_merge_requests(uuid,text,text,text,text,jsonb)','EXECUTE')
    and not has_function_privilege('authenticated',
      'public.save_analysis_repository_merge_requests(uuid,text,text,text,text,jsonb)','EXECUTE')
    and not has_function_privilege('anon',
      'public.save_analysis_repository_merge_requests(uuid,text,text,text,text,jsonb)','EXECUTE'),
    'MR enrichment RPC is service-role only');
  perform pg_temp.assert(
    not has_table_privilege('authenticated','public.analysis_repository_merge_request','INSERT')
    and not has_table_privilege('authenticated','public.analysis_repository_merge_request','UPDATE')
    and not has_table_privilege('authenticated','public.analysis_merge_request_commit','INSERT'),
    'browser roles cannot write MR facts');
end;
$test$;

do $test$
declare
  v_user uuid := '11440000-1000-4000-a000-000000000001';
  v_model uuid := '11440000-2000-4000-a000-000000000001';
  v_batch uuid := '11440000-3000-4000-a000-000000000001';
  v_job uuid := '11440000-4000-4000-a000-000000000001';
  v_snapshot uuid := '11440000-5000-4000-a000-000000000001';
  v_secret uuid;
  v_result jsonb;
  v_payload jsonb;
  v_wrong_owner_rejected boolean := false;
  v_sha_commit text := repeat('a',40);
  v_sha_merge text := repeat('b',40);
  v_sha_squash text := repeat('c',40);
  v_sha_outside text := repeat('d',40);
begin
  insert into auth.users(id,email) values(v_user,'v111-mr-admin@example.invalid')
  on conflict(id) do nothing;
  insert into public.user_profile(id,role,display_name)
  values(v_user,'ADMIN','V1.11 MR test admin')
  on conflict(id) do update set role='ADMIN',display_name=excluded.display_name;

  select vault.create_secret('not-a-real-model-key','v111_mr_test_model_key') into v_secret;
  insert into public.ai_model_config(
    id,display_name,base_url,model_name,api_key_secret_id,enabled,max_parallel_tasks,
    request_timeout_ms,created_by
  ) values(
    v_model,'V1.11 MR test model','https://model.example.invalid','test-model',
    v_secret,true,1,10000,v_user
  );
  insert into public.review_batch(
    id,name,week_code,default_branch,ai_model_config_id,created_by
  ) values(v_batch,'V1.11 MR batch','V111-MR-TEST','feature_dev',v_model,v_user);
  insert into public.analysis_job(
    id,batch_id,model_config_id,model_snapshot,requested_branch,status,requested_by,
    worker_id,total_stories,execution_engine,policy_version,capability_policy_snapshot,
    policy_hash,analysis_context_version,commit_window_days,scope_status,
    required_worker_scope_version,attribution_algorithm_version
  ) values(
    v_job,v_batch,v_model,'{}'::jsonb,'feature_dev','PREPARING_SCOPE',v_user,
    'worker-mr-owner',0,'deepseek-harness-acp',4,jsonb_build_object('fixture','mr'),repeat('1',64),
    2,21,'PREPARING',2,'story-attribution-v2'
  );
  insert into public.analysis_repository_snapshot(
    id,job_id,repository_name,requested_branch,commit_sha,head_sha,commit_subject,
    enumeration_status,commit_count,commit_manifest_hash,mr_enrichment_status
  ) values(
    v_snapshot,v_job,'kdmanage-backend','feature_dev',v_sha_merge,v_sha_merge,'head',
    'COMPLETE',3,repeat('2',64),'UNAVAILABLE'
  );
  insert into public.analysis_repository_commit(
    snapshot_id,sha,sequence_no,author_name,committed_at,subject,effective_status
  ) values
    (v_snapshot,v_sha_commit,0,'Dev','2026-09-19T00:00:00Z','feature commit','EFFECTIVE'),
    (v_snapshot,v_sha_merge,1,'Dev','2026-09-19T00:01:00Z','merge commit','EFFECTIVE'),
    (v_snapshot,v_sha_squash,2,'Dev','2026-09-19T00:02:00Z','squash commit','EFFECTIVE');

  v_payload := jsonb_build_array(jsonb_build_object(
    'provider_project_id','kwork/manage/kdmanage-backend',
    'merge_request_iid',17,
    'title','Story-Id: REQ-001',
    'description','MR description',
    'source_branch','feature/REQ-001-demo',
    'target_branch','feature_dev',
    'author_username','developer',
    'author_provider_id','77',
    'author_display_name','Developer',
    'provider_created_at','2026-09-18T00:00:00Z',
    'provider_updated_at','2026-09-19T00:00:00Z',
    'merged_at','2026-09-19T00:00:00Z',
    'merge_commit_sha',v_sha_merge,
    'squash_commit_sha',v_sha_squash,
    'structured_story_ids',jsonb_build_array('REQ-001'),
    'metadata_hash','sha256:'||repeat('3',64),
    'collected_at','2026-09-19T00:05:00Z',
    'commits',jsonb_build_array(
      jsonb_build_object('sha',v_sha_commit,'membership_type','COMMIT'),
      jsonb_build_object('sha',v_sha_merge,'membership_type','MERGE_COMMIT'),
      jsonb_build_object('sha',v_sha_squash,'membership_type','SQUASH_COMMIT'),
      jsonb_build_object('sha',v_sha_outside,'membership_type','COMMIT')
    )
  ));

  begin
    perform public.save_analysis_repository_merge_requests(
      v_job,'worker-not-owner','kdmanage-backend','COMPLETE',null,v_payload
    );
  exception when others then
    v_wrong_owner_rejected := position('JOB_LEASE_LOST' in sqlerrm) > 0;
  end;
  perform pg_temp.assert(v_wrong_owner_rejected,'wrong worker is rejected by job fencing');

  v_result := public.save_analysis_repository_merge_requests(
    v_job,'worker-mr-owner','kdmanage-backend','COMPLETE',null,v_payload
  );
  perform pg_temp.assert((v_result->>'merge_request_count')::integer=1,'one MR saved');
  perform pg_temp.assert((v_result->>'relation_count')::integer=3,
    'only three commits in the frozen manifest are related');
  perform pg_temp.assert((select count(*)=1 from public.analysis_repository_merge_request
    where snapshot_id=v_snapshot and merge_request_iid=17
      and description='MR description' and author_username='developer'
      and author_provider_id='77'
      and provider_created_at='2026-09-18T00:00:00Z'::timestamptz
      and provider_updated_at='2026-09-19T00:00:00Z'::timestamptz),
    'all requested MR metadata columns are persisted');
  perform pg_temp.assert((select count(*)=3
    from public.analysis_merge_request_commit relation
    join public.analysis_repository_merge_request mr on mr.id=relation.merge_request_id
    where mr.snapshot_id=v_snapshot),
    'commit, merge and squash memberships are persisted without outside commits');
  perform pg_temp.assert((select array_agg(membership_type order by membership_type)
    from public.analysis_merge_request_commit relation
    join public.analysis_repository_merge_request mr on mr.id=relation.merge_request_id
    where mr.snapshot_id=v_snapshot)
    = array['COMMIT','MERGE_COMMIT','SQUASH_COMMIT'],
    'membership types remain distinct');

  -- Same batch can be retried before scope freeze without duplicate facts.
  perform public.save_analysis_repository_merge_requests(
    v_job,'worker-mr-owner','kdmanage-backend','COMPLETE',null,v_payload
  );
  perform pg_temp.assert((select count(*)=1 from public.analysis_repository_merge_request
    where snapshot_id=v_snapshot),'retry replaces the same snapshot MR set');
  perform pg_temp.assert((select count(*)=3
    from public.analysis_merge_request_commit relation
    join public.analysis_repository_merge_request mr on mr.id=relation.merge_request_id
    where mr.snapshot_id=v_snapshot),'retry does not duplicate memberships');

  perform public.save_analysis_repository_merge_requests(
    v_job,'worker-mr-owner','kdmanage-backend','UNAVAILABLE','MR_METADATA_UNAVAILABLE','[]'::jsonb
  );
  perform pg_temp.assert((select mr_enrichment_status='UNAVAILABLE'
      and mr_enrichment_error_code='MR_METADATA_UNAVAILABLE'
      from public.analysis_repository_snapshot where id=v_snapshot),
    'unconfigured capability is persisted explicitly');
  perform pg_temp.assert((select count(*)=0 from public.analysis_repository_merge_request
    where snapshot_id=v_snapshot),'unavailable status never fabricates empty MR facts');
end;
$test$;

rollback;
