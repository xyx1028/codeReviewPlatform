-- V1.11 Worker/数据库最终契约回归；全程事务内执行并 rollback。

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
-- 1. 新契约签名与最小权限。
------------------------------------------------------------------------------

do $test$
begin
  perform pg_temp.assert(
    to_regprocedure('public.match_analysis_git_identities(jsonb)') is not null,
    'service-role bulk identity matcher exists');
  perform pg_temp.assert(
    to_regprocedure('public.get_story_commit_diff_archive_metadata(uuid,text,uuid,uuid)') is not null,
    'claim-fenced diff metadata getter exists');
  perform pg_temp.assert(
    has_function_privilege('service_role','public.match_analysis_git_identities(jsonb)','EXECUTE')
    and not has_function_privilege('authenticated','public.match_analysis_git_identities(jsonb)','EXECUTE')
    and not has_function_privilege('anon','public.match_analysis_git_identities(jsonb)','EXECUTE'),
    'identity matcher is service-role only');
  perform pg_temp.assert(
    has_function_privilege('service_role',
      'public.get_story_commit_diff_archive_metadata(uuid,text,uuid,uuid)','EXECUTE')
    and not has_function_privilege('authenticated',
      'public.get_story_commit_diff_archive_metadata(uuid,text,uuid,uuid)','EXECUTE'),
    'diff metadata getter is service-role only');
  perform pg_temp.assert(
    not has_function_privilege('authenticated',
      'public.freeze_analysis_job_scope_inputs(uuid,text)','EXECUTE')
    and not has_function_privilege('authenticated',
      'public.claim_next_story_task(text,integer)','EXECUTE'),
    'trusted freeze and claim RPCs remain unavailable to browsers');
end;
$test$;

------------------------------------------------------------------------------
-- 2. Fixture：前一成功 V2、当前 V2、一个兼容 V1，以及规范身份 pepper。
------------------------------------------------------------------------------

do $test$
declare
  v_admin uuid:='11330000-1000-4000-a000-000000000001';
  v_model uuid:='11330000-2000-4000-a000-000000000001';
  v_batch_prior uuid:='11330000-3000-4000-a000-000000000001';
  v_batch_v1 uuid:='11330000-3000-4000-a000-000000000002';
  v_batch_v2 uuid:='11330000-3000-4000-a000-000000000003';
  v_story_v1 uuid:='11330000-4000-4000-a000-000000000001';
  v_story_v2 uuid:='11330000-4000-4000-a000-000000000002';
  v_prior_job uuid:='11330000-5000-4000-a000-000000000001';
  v_job_v1 uuid:='11330000-5000-4000-a000-000000000002';
  v_job_v2 uuid:='11330000-5000-4000-a000-000000000003';
  v_task_v1 uuid:='11330000-6000-4000-a000-000000000001';
  v_task_v2 uuid:='11330000-6000-4000-a000-000000000002';
  v_developer uuid:='11330000-7000-4000-a000-000000000001';
  v_git_identity uuid:='11330000-7000-4000-a000-000000000002';
  v_secret uuid;
  v_pepper uuid;
  v_rule_version uuid;
  v_rule_hash text;
  v_fingerprint text;
  v_repo text;
  v_index integer:=0;
  v_head text;
begin
  insert into auth.users(id,email) values(v_admin,'v111-contract-admin@example.invalid')
  on conflict(id) do nothing;
  insert into public.user_profile(id,role,display_name)
  values(v_admin,'ADMIN','V1.11 contract admin')
  on conflict(id) do update set role='ADMIN',display_name=excluded.display_name;

  set local role service_role;
  v_secret:=public.admin_vault_create_secret(
    'v111-contract-model-not-a-real-key','v111_contract_model_key');
  select vault.create_secret(
    'v111-contract-pepper-not-a-real-secret','analysis_identity_pepper') into v_pepper;
  reset role;

  v_fingerprint:=encode(extensions.hmac(
    convert_to('dev.owner@example.invalid','UTF8'),
    convert_to('v111-contract-pepper-not-a-real-secret','UTF8'),'sha256'),'hex');

  insert into public.developer_identity(
    id,display_name,employee_code,status,created_by,updated_by
  ) values(v_developer,'开发甲','E-3301','VERIFIED',v_admin,v_admin);
  insert into public.developer_git_identity(
    id,developer_identity_id,provider,email_fingerprint,masked_email,email_domain,
    author_name_aliases,verification_status,created_by,updated_by
  ) values(
    v_git_identity,v_developer,'gitlab',v_fingerprint,'d***@example.invalid',
    'example.invalid',array['Dev Owner'],'VERIFIED',v_admin,v_admin
  );

  insert into public.ai_model_config(
    id,display_name,base_url,model_name,api_key_secret_id,enabled,max_parallel_tasks,
    request_timeout_ms,context_window,max_output_tokens,agent_max_model_requests,
    agent_max_retry_requests,agent_max_compaction_requests,created_by
  ) values(
    v_model,'V1.11 contract model','https://model-contract.example.invalid','contract-model',
    v_secret,true,4,123456,131072,8192,120,6,4,v_admin
  );
  insert into public.review_batch(id,name,week_code,default_branch,ai_model_config_id,created_by)
  values
    (v_batch_prior,'prior V2','V111-CONTRACT-PRIOR','feature_dev',v_model,v_admin),
    (v_batch_v1,'legacy V1','V111-CONTRACT-V1','feature_dev',v_model,v_admin),
    (v_batch_v2,'current V2','V111-CONTRACT-V2','feature_dev',v_model,v_admin);
  insert into public.review_story(
    id,batch_id,story_code,story_name,owners_text,project_name,application_name,
    release_window,source_data
  ) values
    (v_story_v1,v_batch_v1,'REQ-LEGACY','legacy whole-repository review','开发甲',
      'legacy-project','legacy-app','2026-W38',jsonb_build_object('详细描述','legacy source data')),
    (v_story_v2,v_batch_v2,'REQ-SCOPE','precise commit review','开发甲（E-3301）',
      'order-project','order-app','2026-W38',
      jsonb_build_object('详细描述','frozen detail','关联特性','batch close'));

  select version.id,version.ruleset_hash into v_rule_version,v_rule_hash
  from public.analysis_attribution_rule_set rule_set
  join public.analysis_attribution_rule_version version
    on version.id=rule_set.current_published_version_id
  where rule_set.rule_set_code='STORY_COMMIT_ATTRIBUTION';

  insert into public.analysis_job(
    id,batch_id,model_config_id,model_snapshot,requested_branch,status,requested_by,
    worker_id,total_stories,execution_engine,policy_version,capability_policy_snapshot,
    policy_hash,analysis_context_version,commit_window_days,scope_status,
    required_worker_scope_version,attribution_algorithm_version,
    attribution_rule_version_id,ruleset_hash,created_at,finished_at
  ) values(
    v_prior_job,v_batch_prior,v_model,'{}'::jsonb,'feature_dev','SUCCEEDED',v_admin,
    null,0,'deepseek-harness-acp',4,jsonb_build_object('fixture','prior'),repeat('1',64),
    2,21,'READY',2,'story-attribution-v2',v_rule_version,v_rule_hash,
    '2026-09-18T00:00:00Z','2026-09-18T01:00:00Z'
  );

  foreach v_repo in array array[
    'kdmanage-backend','kdmanage-frontend','tmanage-backend','tmanage-frontend'
  ] loop
    v_index:=v_index+1;
    v_head:=repeat(substr('abcd',v_index,1),40);
    insert into public.analysis_repository_snapshot(
      job_id,repository_name,requested_branch,commit_sha,head_sha,commit_subject,
      enumeration_status,commit_count,commit_manifest_hash
    ) values(
      v_prior_job,v_repo,'feature_dev',v_head,v_head,'prior head','COMPLETE',0,repeat('a',64)
    );
  end loop;

  insert into public.analysis_job(
    id,batch_id,model_config_id,model_snapshot,requested_branch,status,requested_by,
    total_stories,execution_engine,policy_version,capability_policy_snapshot,policy_hash,
    analysis_context_version,commit_window_days,scope_status,required_worker_scope_version,
    skill_catalog_hash,skill_snapshot_version,created_at
  ) values(
    v_job_v1,v_batch_v1,v_model,jsonb_build_object(
      'model_config_id',v_model,'display_name','frozen model','base_url','https://frozen.example.invalid',
      'model_name','frozen-name','network_access_mode','DIRECT','max_parallel_tasks',4,
      'request_timeout_ms',123456
    ),'feature_dev','PROCESSING',v_admin,1,'deepseek-harness-acp',4,
    jsonb_build_object('fixture','v1'),repeat('2',64),1,21,'LEGACY',1,
    public.empty_skill_catalog_hash(),1,'2026-09-19T00:01:00Z'
  );
  insert into public.analysis_story_task(id,job_id,story_id)
  values(v_task_v1,v_job_v1,v_story_v1);
  foreach v_repo in array array[
    'kdmanage-backend','kdmanage-frontend','tmanage-backend','tmanage-frontend'
  ] loop
    insert into public.analysis_repository_snapshot(
      job_id,repository_name,requested_branch,commit_sha,commit_subject
    ) values(v_job_v1,v_repo,'feature_dev',repeat('e',40),'legacy head');
  end loop;

  insert into public.analysis_job(
    id,batch_id,model_config_id,model_snapshot,requested_branch,status,requested_by,
    worker_id,total_stories,execution_engine,policy_version,capability_policy_snapshot,
    policy_hash,harness_version,capability_contract_hash,
    analysis_context_version,commit_window_days,scope_status,required_worker_scope_version,
    attribution_algorithm_version,attribution_rule_version_id,ruleset_hash,
    skill_catalog_hash,skill_snapshot_version,created_at,locked_at
  ) values(
    v_job_v2,v_batch_v2,v_model,jsonb_build_object(
      'model_config_id',v_model,'display_name','frozen model','base_url','https://frozen.example.invalid',
      'model_name','frozen-name','network_access_mode','DIRECT','max_parallel_tasks',4,
      'request_timeout_ms',123456
    ),'feature_dev','PREPARING_CODE',v_admin,'worker-scope',1,'deepseek-harness-acp',4,
    jsonb_build_object('fixture','v2'),repeat('3',64),'0.1.5-rc.1',repeat('4',64),
    2,21,'PREPARING',2,'story-attribution-v2',v_rule_version,v_rule_hash,
    public.empty_skill_catalog_hash(),1,'2026-09-19T00:02:00Z',now()-interval '1 hour'
  );
  insert into public.analysis_story_task(id,job_id,story_id)
  values(v_task_v2,v_job_v2,v_story_v2);
  v_index:=0;
  foreach v_repo in array array[
    'kdmanage-backend','kdmanage-frontend','tmanage-backend','tmanage-frontend'
  ] loop
    v_index:=v_index+1;
    v_head:=repeat(substr('5678',v_index,1),40);
    insert into public.analysis_repository_snapshot(
      job_id,repository_name,requested_branch,commit_sha,head_sha,commit_subject,
      head_resolved_at,enumeration_status,mr_enrichment_status
    ) values(
      v_job_v2,v_repo,'feature_dev',v_head,v_head,'current head',now(),'PENDING','UNAVAILABLE'
    );
  end loop;
end;
$test$;

------------------------------------------------------------------------------
-- 3. 批量身份规范化不回显/持久化 raw email；freeze 返回完整冻结明细和 previous heads。
------------------------------------------------------------------------------

do $test$
declare
  v_job uuid:='11330000-5000-4000-a000-000000000003';
  v_raw text:='  Dev.Owner@Example.Invalid  ';
  v_match jsonb;
  v_frozen jsonb;
  v_retry jsonb;
  v_before timestamptz;
  v_snapshots jsonb;
  v_error text;
begin
  set local role service_role;
  v_match:=public.match_analysis_git_identities(jsonb_build_array(jsonb_build_object(
    'input_id','commit-author-1','provider','gitlab','email',v_raw
  )));
  perform pg_temp.assert(jsonb_array_length(v_match)=1
      and v_match->0->>'match_status'='MATCHED'
      and v_match->0->>'developer_id'='11330000-7000-4000-a000-000000000001'
      and v_match->0->>'masked_email'='d***@example.invalid'
      and v_match->0->>'email_fingerprint' ~ '^[0-9a-f]{64}$',
    'bulk matcher normalizes case/space and returns canonical masked identity');
  perform pg_temp.assert(v_match::text not ilike '%dev.owner@example.invalid%'
      and v_match::text not ilike '%Dev.Owner@Example.Invalid%',
    'bulk matcher never echoes raw email');
  perform pg_temp.assert(not exists(
      select 1 from public.developer_git_identity
      where to_jsonb(developer_git_identity)::text ilike '%dev.owner@example.invalid%'
    ),'raw email is absent from identity tables');

  select locked_at into v_before from public.analysis_job where id=v_job;
  v_frozen:=public.freeze_analysis_job_scope_inputs(v_job,'worker-scope');
  perform pg_temp.assert(jsonb_array_length(v_frozen->'stories')=1
      and jsonb_array_length(v_frozen->'identities')=1,
    'freeze returns every frozen story and identity');
  perform pg_temp.assert(v_frozen->'stories'->0->>'task_id'='11330000-6000-4000-a000-000000000002'
      and v_frozen->'stories'->0->>'story_code'='REQ-SCOPE'
      and v_frozen->'stories'->0->>'input_hash' ~ '^[0-9a-f]{64}$'
      and v_frozen->'stories'->0->'requirement_context'->>'detailed_description'='frozen detail'
      and jsonb_array_length(v_frozen->'stories'->0->'normalized_developer_ids')=1,
    'freeze story payload matches Worker FrozenScopeStory contract');
  perform pg_temp.assert(v_frozen->'identities'->0->>'display_name'='开发甲'
      and v_frozen->'identities'->0->>'email_fingerprint' ~ '^[0-9a-f]{64}$'
      and jsonb_array_length(v_frozen->'identities'->0->'author_name_aliases')=1,
    'freeze identity payload matches Worker FrozenScopeIdentity contract');
  perform pg_temp.assert(v_frozen->'previous_repository_heads'->>'kdmanage-backend'=repeat('a',40)
      and v_frozen->'previous_repository_heads'->>'kdmanage-frontend'=repeat('b',40)
      and v_frozen->'previous_repository_heads'->>'tmanage-backend'=repeat('c',40)
      and v_frozen->'previous_repository_heads'->>'tmanage-frontend'=repeat('d',40),
    'freeze returns all four previous successful repository heads');
  perform pg_temp.assert((select locked_at>v_before and status='PREPARING_SCOPE'
      from public.analysis_job where id=v_job),
    'trusted preparation write advances lease and enters PREPARING_SCOPE');

  v_retry:=public.freeze_analysis_job_scope_inputs(v_job,'worker-scope');
  perform pg_temp.assert((v_retry->>'idempotent')::boolean
      and v_retry->'stories'=v_frozen->'stories'
      and v_retry->'identities'=v_frozen->'identities'
      and v_retry->'previous_repository_heads'=v_frozen->'previous_repository_heads',
    'freeze retry returns the same frozen payload');

  select jsonb_agg(jsonb_build_object(
    'repository_name',snapshot.repository_name,
    'requested_branch',snapshot.requested_branch,
    'commit_sha',snapshot.commit_sha,
    'commit_subject',snapshot.commit_subject
  ) order by snapshot.repository_name) into v_snapshots
  from public.analysis_repository_snapshot snapshot where snapshot.job_id=v_job;
  perform public.save_repository_snapshots(v_job,'worker-scope',v_snapshots);
  perform pg_temp.assert((select count(*)=4 from public.analysis_repository_snapshot where job_id=v_job),
    'same-head PREPARING_SCOPE retry preserves frozen repository rows');

  begin
    v_snapshots:=jsonb_set(v_snapshots,'{0,commit_sha}',to_jsonb(repeat('9',40)));
    perform public.save_repository_snapshots(v_job,'worker-scope',v_snapshots);
    perform pg_temp.assert(false,'reclaim may not mix a moved HEAD into frozen inputs');
  exception when others then
    get stacked diagnostics v_error=message_text;
    perform pg_temp.assert(v_error like '%PREPARATION_RECLAIM_HEAD_MISMATCH%',
      'moved HEAD retry fails closed');
  end;
  reset role;
end;
$test$;

------------------------------------------------------------------------------
-- 4. Scope 写入幂等、最终 claim 完整 hash/model/skill 契约、scope 与 diff getter。
------------------------------------------------------------------------------

do $test$
declare
  v_job uuid:='11330000-5000-4000-a000-000000000003';
  v_task uuid:='11330000-6000-4000-a000-000000000002';
  v_candidate uuid:='11330000-8000-4000-a000-000000000001';
  v_snapshot uuid;
  v_commit uuid:='11330000-8000-4000-a000-000000000002';
  v_scope_payload jsonb;
  v_saved jsonb;
  v_claim jsonb;
  v_scope jsonb;
  v_metadata jsonb;
  v_skill jsonb;
  v_claim_token uuid;
  v_error text;
begin
  update public.analysis_repository_snapshot
  set base_sha=repeat('0',40),range_source='TIME_DERIVED',
      range_start_at=now()-interval '21 days',range_end_at=now(),
      ancestry_status='VERIFIED',enumeration_status='COMPLETE',
      commit_count=0,commit_manifest_hash=repeat('5',64)
  where job_id=v_job;
  select id into v_snapshot from public.analysis_repository_snapshot
  where job_id=v_job and repository_name='kdmanage-backend';
  update public.analysis_repository_snapshot set commit_count=1 where id=v_snapshot;
  insert into public.analysis_repository_commit(
    id,snapshot_id,sha,sequence_no,author_name,author_email_fingerprint,
    author_email_masked,committed_at,subject,files_changed,additions,deletions,effective_status
  ) values(
    v_commit,v_snapshot,repeat('6',40),0,'Dev Owner',
    (select email_fingerprint from public.developer_git_identity
      where id='11330000-7000-4000-a000-000000000002'),
    'd***@example.invalid',now()-interval '1 day','REQ-SCOPE implementation',1,10,2,'EFFECTIVE'
  );
  update public.analysis_job set repository_manifest_hash=repeat('7',64) where id=v_job;

  v_scope_payload:=jsonb_build_array(jsonb_build_object(
    'task_id',v_task,'generation',1,'scope_mode','EXACT_STORY_COMMITS','status','PREPARING',
    'candidate_manifest_hash',repeat('8',64),'degradation_reasons','[]'::jsonb,
    'candidates',jsonb_build_array(jsonb_build_object(
      'candidate_id',v_candidate,'repository_name','kdmanage-backend','sha',repeat('6',40),
      'tier','STRONG','selection_source','RULE','rank_score',900,
      'reason_codes',jsonb_build_array('EXPLICIT_STORY_ID'),'identity_match_type','VERIFIED_EMAIL',
      'story_match_location','COMMIT_TRAILER','rule_code','ATTR_EXPLICIT_COMMIT_STORY_ID',
      'effective_status','EFFECTIVE'
    ))
  ));

  set local role service_role;
  v_saved:=public.save_analysis_story_scopes(
    v_job,'worker-scope','story-attribution-v2',v_scope_payload,repeat('9',64));
  perform pg_temp.assert(not (v_saved->>'idempotent')::boolean,
    'first scope catalog save writes the frozen candidate set');
  v_saved:=public.save_analysis_story_scopes(
    v_job,'worker-scope','story-attribution-v2',v_scope_payload,repeat('9',64));
  perform pg_temp.assert((v_saved->>'idempotent')::boolean,
    'same scope catalog retry is idempotent and preserves audit rows');

  perform public.save_analysis_commit_diff_archives(v_job,'worker-scope',jsonb_build_array(
    jsonb_build_object(
      'repository_name','kdmanage-backend','sha',repeat('6',40),'status','AVAILABLE',
      'storage_object_prefix',v_job::text||'/kdmanage-backend/'||repeat('6',40)||'/'||repeat('5',64)||'/',
      'archive_sha256',repeat('a',64),'size_bytes',2048,'chunk_count',2
    )
  ));
  perform public.finalize_analysis_story_scope(v_job,'worker-scope',1);
  reset role;

  -- V1 does not need a scope capability heartbeat and keeps all old envelope fields.
  set local role service_role;
  v_claim:=public.claim_next_story_task('worker-v1-compatible',900);
  perform pg_temp.assert(v_claim->>'id'='11330000-6000-4000-a000-000000000001'
      and (v_claim->'job'->>'analysis_context_version')::integer=1
      and v_claim->'job'->>'story_input_catalog_hash' is null
      and v_claim->'story'->>'story_code'='REQ-LEGACY'
      and jsonb_array_length(v_claim->'snapshots')=4
      and v_claim->'model'->>'network_access_mode'='DIRECT'
      and (v_claim->'model'->>'request_timeout_ms')::integer=123456
      and v_claim->>'claim_token' is not null,
    'V1 claim remains compatible with story/snapshot/model/policy/token semantics');
  update public.analysis_story_task
  set agent_status='SUCCEEDED',lease_expires_at=null,heartbeat_at=null,worker_id=null,
      claim_token_digest=null
  where id='11330000-6000-4000-a000-000000000001';

  v_claim:=public.claim_next_story_task('worker-without-v2',900);
  perform pg_temp.assert(v_claim is null,'worker without capability cannot claim V2 task');
  insert into public.analysis_worker_heartbeat(worker_id,slots,current_tasks,capabilities)
  values('worker-v2',2,0,jsonb_build_object('storyCommitScopeVersion',2))
  on conflict(worker_id) do update set capabilities=excluded.capabilities,last_seen_at=now();

  v_claim:=public.claim_next_story_task('worker-v2',900);
  perform pg_temp.assert(v_claim->>'id'=v_task::text
      and (v_claim->'job'->>'analysis_context_version')::integer=2
      and v_claim->'job'->>'story_input_catalog_hash'=(select story_input_catalog_hash from public.analysis_job where id=v_job)
      and v_claim->'job'->>'identity_snapshot_hash'=(select identity_snapshot_hash from public.analysis_job where id=v_job)
      and v_claim->'job'->>'repository_manifest_hash'=repeat('7',64)
      and v_claim->'job'->>'selected_scope_hash'=repeat('9',64)
      and v_claim->'job'->>'ruleset_hash'=(select ruleset_hash from public.analysis_job where id=v_job)
      and v_claim->'job'->>'attribution_algorithm_version'='story-attribution-v2',
    'V2 claim returns every Worker continuity hash');
  perform pg_temp.assert(v_claim->'job'->>'skill_catalog_hash'=public.empty_skill_catalog_hash(),
    'V2 claim preserves frozen skill catalog hash');
  perform pg_temp.assert((v_claim->'job'->>'skill_snapshot_version')::integer=1,
    'V2 claim preserves frozen skill snapshot version');
  perform pg_temp.assert(v_claim->'model'->>'network_access_mode'='DIRECT'
      and (v_claim->'model'->>'effective_max_parallel_tasks')::integer=4,
    'V2 claim preserves model network mode and effective parallel gate');
  perform pg_temp.assert(v_claim->>'harness_version'=(select harness_version from public.analysis_job where id=v_job)
      and v_claim->>'capability_contract_hash'=(select capability_contract_hash from public.analysis_job where id=v_job),
    'V2 claim preserves frozen Harness fields');
  perform pg_temp.assert((select story_input_catalog_hash=(select story_input_catalog_hash from public.analysis_job where id=v_job)
      and identity_snapshot_hash=(select identity_snapshot_hash from public.analysis_job where id=v_job)
      and repository_manifest_hash=repeat('7',64)
      and selected_scope_hash=repeat('9',64)
      and attribution_algorithm_version='story-attribution-v2'
      and attribution_ruleset_hash=(select ruleset_hash from public.analysis_job where id=v_job)
      and scope_generation=1
    from public.analysis_agent_run where id=(v_claim->>'agent_run_id')::uuid),
    'claimed run snapshots the same continuity identity');

  v_claim_token:=(v_claim->>'claim_token')::uuid;
  v_skill:=public.get_story_task_skill_snapshot(v_task,'worker-v2',v_claim_token);
  perform pg_temp.assert(v_skill->>'catalog_hash'=public.empty_skill_catalog_hash()
      and jsonb_typeof(v_skill->'bundles')='array',
    'existing claim-fenced skill snapshot getter remains compatible');

  v_scope:=public.get_story_task_analysis_scope(v_task,'worker-v2',v_claim_token);
  perform pg_temp.assert(v_scope->>'story_input_hash'=(select input_hash
        from public.analysis_job_story_snapshot where job_id=v_job)
      and v_scope->'requirement_context'->>'detailed_description'='frozen detail'
      and v_scope->>'candidate_manifest_hash'=repeat('8',64),
    'scope getter returns frozen story_input_hash and requirement_context');

  v_metadata:=public.get_story_commit_diff_archive_metadata(
    v_task,'worker-v2',v_claim_token,v_candidate);
  perform pg_temp.assert(v_metadata->>'status'='AVAILABLE'
      and v_metadata->>'storage_bucket'='analysis-commit-diffs'
      and v_metadata->>'archive_sha256'=repeat('a',64)
      and (v_metadata->>'size_bytes')::integer=2048
      and (v_metadata->>'chunk_count')::integer=2
      and v_metadata ? 'storage_object_prefix',
    'diff getter returns immutable archive metadata needed for controlled Storage read');
  perform pg_temp.assert(v_metadata::text not like '%.patch%'
      and not (v_metadata ? 'body') and not (v_metadata ? 'signed_url'),
    'diff getter returns neither archive body nor signed URL');

  begin
    perform public.get_story_commit_diff_archive_metadata(
      v_task,'worker-v2',gen_random_uuid(),v_candidate);
    perform pg_temp.assert(false,'wrong claim token must not read diff metadata');
  exception when others then
    get stacked diagnostics v_error=message_text;
    perform pg_temp.assert(v_error like '%TASK_LEASE_LOST%',
      'diff metadata getter preserves task claim fencing');
  end;
  reset role;
end;
$test$;

------------------------------------------------------------------------------
-- 5. PREPARING_SCOPE stale lease 可接管；旧 Worker 失去 fencing；新 Worker 可失败收敛。
------------------------------------------------------------------------------

do $test$
declare
  v_admin uuid:='11330000-1000-4000-a000-000000000001';
  v_model uuid:='11330000-2000-4000-a000-000000000001';
  v_batch uuid:='11330000-3000-4000-a000-000000000004';
  v_job uuid:='11330000-5000-4000-a000-000000000004';
  v_rule_version uuid;
  v_rule_hash text;
  v_claim jsonb;
  v_error text;
begin
  insert into public.review_batch(id,name,week_code,default_branch,ai_model_config_id,created_by)
  values(v_batch,'stale PREPARING_SCOPE','V111-CONTRACT-RECLAIM','feature_dev',v_model,v_admin);
  select version.id,version.ruleset_hash into v_rule_version,v_rule_hash
  from public.analysis_attribution_rule_set rule_set
  join public.analysis_attribution_rule_version version
    on version.id=rule_set.current_published_version_id
  where rule_set.rule_set_code='STORY_COMMIT_ATTRIBUTION';
  insert into public.analysis_job(
    id,batch_id,model_config_id,model_snapshot,requested_branch,status,requested_by,
    worker_id,total_stories,execution_engine,policy_version,capability_policy_snapshot,
    policy_hash,analysis_context_version,commit_window_days,scope_status,
    required_worker_scope_version,attribution_algorithm_version,
    attribution_rule_version_id,ruleset_hash,created_at,locked_at
  ) values(
    v_job,v_batch,v_model,'{}'::jsonb,'feature_dev','PREPARING_SCOPE',v_admin,
    'dead-worker',1,'deepseek-harness-acp',4,jsonb_build_object('fixture','reclaim'),repeat('b',64),
    2,21,'PREPARING',2,'story-attribution-v2',v_rule_version,v_rule_hash,
    '2026-09-19T00:03:00Z',now()-interval '2 hours'
  );
  insert into public.analysis_worker_heartbeat(worker_id,slots,current_tasks,capabilities)
  values('replacement-worker',2,0,jsonb_build_object('storyCommitScopeVersion',2))
  on conflict(worker_id) do update set capabilities=excluded.capabilities,last_seen_at=now();

  set local role service_role;
  v_claim:=public.claim_job_for_preparation('replacement-worker',900);
  perform pg_temp.assert(v_claim->'job'->>'id'=v_job::text
      and (v_claim->'job'->>'analysis_context_version')::integer=2
      and (select status='PREPARING_CODE' and worker_id='replacement-worker' and attempt=1
        from public.analysis_job where id=v_job),
    'expired PREPARING_SCOPE lease is reclaimed by a V2-capable worker');

  update public.analysis_job set status='PREPARING_SCOPE' where id=v_job;
  begin
    perform public.fail_claimed_analysis_job(v_job,'dead-worker','OLD_OWNER','must be fenced');
    perform pg_temp.assert(false,'old owner may not fail a reclaimed PREPARING_SCOPE job');
  exception when others then
    get stacked diagnostics v_error=message_text;
    perform pg_temp.assert(v_error like '%JOB_LEASE_LOST%',
      'PREPARING_SCOPE failure keeps worker_id fencing');
  end;

  perform public.fail_claimed_analysis_job(
    v_job,'replacement-worker','SCOPE_PREPARATION_FAILED','expected fixture failure');
  perform pg_temp.assert((select status='FAILED' and scope_status='FAILED'
      and error_code='SCOPE_PREPARATION_FAILED' and scope_error_code='SCOPE_PREPARATION_FAILED'
      and finished_at is not null from public.analysis_job where id=v_job),
    'current owner can converge PREPARING_SCOPE to FAILED without a stuck job');
  reset role;
end;
$test$;

rollback;
