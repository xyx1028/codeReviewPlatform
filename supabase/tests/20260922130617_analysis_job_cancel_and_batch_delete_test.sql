\set ON_ERROR_STOP on
\timing off

-- V1.15：Job 级停止 + 批次删除。
-- 断言范围只限本测试自己建的 fixture，不依赖库里既有数据；整体 begin/rollback。

begin;
set local client_min_messages=warning;

create or replace function pg_temp.assert(p_condition boolean,p_message text)
returns void language plpgsql as $$
begin
  if p_condition is distinct from true then raise exception 'ASSERT FAILED: %',p_message; end if;
end;
$$;

create or replace function pg_temp.assert_error(p_sql text,p_contains text,p_msg text)
returns void language plpgsql as $$
declare
  v_error text;
begin
  begin
    execute p_sql;
  exception when others then
    v_error := sqlerrm;
    if p_contains is not null and position(p_contains in v_error) = 0 then
      raise exception 'ASSERT FAILED: % -- expected error containing "%", got "%"',
        p_msg, p_contains, v_error;
    end if;
    return;
  end;
  raise exception 'ASSERT FAILED: % -- expected an exception', p_msg;
end;
$$;

do $test$
declare
  v_admin uuid := '11150000-0000-4000-a000-0000000000a1';
  v_viewer uuid := '11150000-0000-4000-a000-0000000000a2';
  v_model uuid := '11150000-0000-4000-b000-0000000000b1';
  v_secret uuid := '11150000-0000-4000-b000-0000000000bf';
  v_batch uuid := '11150000-0000-4000-c000-0000000000c1';
  v_batch_2 uuid := '11150000-0000-4000-c000-0000000000c2';
  v_job uuid := '11150000-0000-4000-d000-0000000000d1';
  v_job_2 uuid := '11150000-0000-4000-d000-0000000000d2';
  v_story uuid := '11150000-0000-4000-e000-0000000000e1';
  v_story_2 uuid := '11150000-0000-4000-e000-0000000000e2';
  v_task uuid := '11150000-0000-4000-f000-0000000000f1';
  v_task_2 uuid := '11150000-0000-4000-f000-0000000000f2';
  v_run uuid := '11150000-0000-4000-a100-0000000000a1';
  v_run_2 uuid := '11150000-0000-4000-a100-0000000000a2';
  v_snap uuid := '11150000-0000-4000-a200-0000000000a1';
  v_commit uuid := '11150000-0000-4000-a300-0000000000a1';
  v_scope uuid := '11150000-0000-4000-a400-0000000000a1';
  v_candidate uuid := '11150000-0000-4000-a500-0000000000a1';
  v_token uuid := '11150000-0000-4000-a600-0000000000a1';
  v_model_snapshot jsonb;
  v_result jsonb;
  v_first_cancel timestamptz;
  v_text text;
  v_count integer;
begin
  ----------------------------------------------------------------------------
  -- 0. fixture
  ----------------------------------------------------------------------------
  insert into auth.users(id,email) values
    (v_admin,'v115-admin@example.invalid'),
    (v_viewer,'v115-viewer@example.invalid')
  on conflict(id) do nothing;
  insert into public.user_profile(id,role) values (v_admin,'ADMIN'),(v_viewer,'VIEWER')
  on conflict(id) do update set role=excluded.role;

  insert into public.ai_model_config(
    id,display_name,base_url,model_name,api_key_secret_id,enabled,max_parallel_tasks,created_by
  ) values (v_model,'V1.15 model','https://model-v115.example.invalid','model-v115',v_secret,true,4,v_admin);
  v_model_snapshot := public.build_model_snapshot(v_model);

  perform set_config('request.jwt.claims',
    json_build_object('sub',v_admin::text,'role','authenticated')::text, true);

  insert into public.review_batch(
    id,name,week_code,status,default_branch,created_by,ai_model_config_id,ai_model_snapshot
  ) values
    (v_batch,'V1.15 停止与删除','WK-V115-001','WAITING_AI_RESULT','release',v_admin,v_model,v_model_snapshot),
    (v_batch_2,'V1.15 未取消对照','WK-V115-002','WAITING_AI_RESULT','release',v_admin,v_model,v_model_snapshot);

  insert into public.review_story(id,batch_id,story_code,story_name,owners_text,source_data) values
    (v_story,v_batch,'ST-V115-001','停止用需求','owner','{}'::jsonb),
    (v_story_2,v_batch_2,'ST-V115-002','对照需求','owner','{}'::jsonb);

  insert into public.analysis_job(
    id,batch_id,model_config_id,model_snapshot,requested_branch,status,requested_by,total_stories,
    -- 与 enqueue_analysis_job 冻结的字段对齐：缺了它们 freeze_v4_job_manifest_and_policy_hash
    -- 会以 V4_CAPABILITY_POLICY_MISSING 拒绝插入。
    capability_policy_snapshot,policy_hash
  ) values
    (v_job,v_batch,v_model,v_model_snapshot,'release','PROCESSING',v_admin,1,
     public.build_v4_capability_policy(v_model),
     encode(sha256((public.build_v4_capability_policy(v_model))::text::bytea),'hex')),
    (v_job_2,v_batch_2,v_model,v_model_snapshot,'release','PROCESSING',v_admin,1,
     public.build_v4_capability_policy(v_model),
     encode(sha256((public.build_v4_capability_policy(v_model))::text::bytea),'hex'));

  insert into public.analysis_story_task(id,job_id,story_id,agent_status,worker_id,
    lease_expires_at,heartbeat_at,claim_token_digest,agent_attempt)
  values
    (v_task,v_job,v_story,'RUNNING','worker-v115',now()+interval '10 minutes',now(),
     public.agent_claim_token_digest(v_token),1),
    (v_task_2,v_job_2,v_story_2,'RUNNING','worker-v115',now()+interval '10 minutes',now(),
     public.agent_claim_token_digest(v_token),1);

  insert into public.analysis_agent_run(id,task_id,job_id,agent_attempt,worker_id,status) values
    (v_run,v_task,v_job,1,'worker-v115','RUNNING'),
    (v_run_2,v_task_2,v_job_2,1,'worker-v115','RUNNING');

  ----------------------------------------------------------------------------
  -- 1. 取消意图列存在
  ----------------------------------------------------------------------------
  perform pg_temp.assert((
    select count(*) from information_schema.columns
    where table_schema='public' and table_name='analysis_job'
      and column_name in ('cancel_requested_at','cancel_requested_by','cancel_reason'))=3,
    'analysis_job carries the V1.15 cancel columns');
  perform pg_temp.assert(
    has_function_privilege('authenticated','public.request_analysis_job_cancel(uuid,text)','EXECUTE')
    and has_function_privilege('service_role','public.request_analysis_job_cancel(uuid,text)','EXECUTE')
    and not has_function_privilege('anon','public.request_analysis_job_cancel(uuid,text)','EXECUTE'),
    'job cancel is granted to authenticated/service_role only');

  ----------------------------------------------------------------------------
  -- 2. 授权与参数校验
  ----------------------------------------------------------------------------
  perform pg_temp.assert_error(
    format('select public.request_analysis_job_cancel(%L,%L)',v_job,'not a code'),
    'CANCEL_REASON_INVALID','free-text cancel reasons are rejected');
  perform pg_temp.assert_error(
    format('select public.request_analysis_job_cancel(%L)','11150000-0000-4000-d000-00000000dead'),
    'job not found','unknown job is rejected');

  perform set_config('request.jwt.claims',
    json_build_object('sub',v_viewer::text,'role','authenticated')::text, true);
  perform pg_temp.assert_error(
    format('select public.request_analysis_job_cancel(%L)',v_job),
    'batch management permission required','VIEWER cannot stop a job');

  perform set_config('request.jwt.claims','',true);
  perform pg_temp.assert_error(
    format('select public.request_analysis_job_cancel(%L)',v_job),
    'authentication required','anonymous callers cannot stop a job');

  ----------------------------------------------------------------------------
  -- 3. 管理员停止运行中的任务
  ----------------------------------------------------------------------------
  perform set_config('request.jwt.claims',
    json_build_object('sub',v_admin::text,'role','authenticated')::text, true);
  v_result := public.request_analysis_job_cancel(v_job,'USER_CANCELLED');

  perform pg_temp.assert((v_result->>'already_terminal')::boolean is false,
    'first stop is not reported as already terminal');
  perform pg_temp.assert((v_result->>'cancelled_attempts')::integer=1,
    'the single running attempt received the cancel intent');
  perform pg_temp.assert((
    select status='FAILED' and error_code='JOB_CANCELLED' and cancel_requested_at is not null
       and cancel_requested_by=v_admin and cancel_reason='USER_CANCELLED'
       and finished_at is not null and worker_id is null
    from public.analysis_job where id=v_job),
    'the stopped job is terminal with a stable JOB_CANCELLED code');
  perform pg_temp.assert((
    select cancel_requested_at is not null and cancel_reason='USER_CANCELLED'
    from public.analysis_agent_run where id=v_run),
    'the running attempt carries cancel_requested_at for the Worker heartbeat');

  -- 停止之后不再有需求被领取：claim 只看 status='PROCESSING'。
  perform pg_temp.assert((
    select count(*) from public.analysis_story_task task
    join public.analysis_job job on job.id=task.job_id
    where task.id=v_task and job.status='PROCESSING')=0,
    'a stopped job is no longer claimable');

  ----------------------------------------------------------------------------
  -- 4. 幂等：重复停止不改写第一次的时间，且报告终态
  ----------------------------------------------------------------------------
  select cancel_requested_at into v_first_cancel from public.analysis_job where id=v_job;
  v_result := public.request_analysis_job_cancel(v_job,'OPERATOR_BREAKER');
  perform pg_temp.assert((v_result->>'already_terminal')::boolean is true,
    'stopping a terminal job reports already_terminal');
  perform pg_temp.assert((
    select cancel_requested_at=v_first_cancel and cancel_reason='USER_CANCELLED'
    from public.analysis_job where id=v_job),
    'the first cancel intent is preserved');

  ----------------------------------------------------------------------------
  -- 5. 在途 attempt 收敛时保留"被停止"，不被 attempt 失败码盖掉
  ----------------------------------------------------------------------------
  set local role service_role;
  perform public.fail_agent_review(v_task,'worker-v115',v_token,
    'AGENT_TREE_CANCELLED','the attempt was cancelled (USER_CANCELLED)');
  reset role;

  perform pg_temp.assert((
    select error_code='JOB_CANCELLED' from public.analysis_job where id=v_job),
    'a cancelled job keeps JOB_CANCELLED after the attempt converges');
  perform pg_temp.assert((
    select error_code='AGENT_TREE_CANCELLED' and status='FAILED' and sealed_at is not null
    from public.analysis_agent_run where id=v_run),
    'the attempt itself still records AGENT_TREE_CANCELLED');

  -- 对照：没有被停止的 Job 仍然由 attempt 的失败码决定终态（回归保护）。
  set local role service_role;
  perform public.fail_agent_review(v_task_2,'worker-v115',v_token,
    'MODEL_CONNECT_FAILED','connection error');
  reset role;
  perform pg_temp.assert((
    select status='FAILED' and error_code='MODEL_CONNECT_FAILED' and cancel_requested_at is null
    from public.analysis_job where id=v_job_2),
    'an uncancelled job still reports the attempt error code');

  ----------------------------------------------------------------------------
  -- 6. 删除批次：活动任务时拒绝
  ----------------------------------------------------------------------------
  update public.analysis_job set status='PROCESSING', finished_at=null where id=v_job;
  perform pg_temp.assert_error(
    format('select public.delete_review_batch(%L)',v_batch),
    'BATCH_HAS_ACTIVE_ANALYSIS_JOB','an active analysis job blocks batch deletion');
  update public.analysis_job set status='FAILED', finished_at=now() where id=v_job;

  ----------------------------------------------------------------------------
  -- 7. 删除批次：V1.11 分析链（含 on delete restrict 的行）可以被清掉
  ----------------------------------------------------------------------------
  insert into public.analysis_job_story_snapshot(
    job_id,story_id,story_code,story_name,owners_text,input_hash
  ) values (v_job,v_story,'ST-V115-001','停止用需求','owner',repeat('a',64));

  insert into public.analysis_repository_snapshot(
    id,job_id,repository_name,requested_branch,commit_sha
  ) values (v_snap,v_job,'kdmanage-backend','release',repeat('b',40));

  insert into public.analysis_repository_commit(
    id,snapshot_id,sha,sequence_no,author_name,committed_at,subject
  ) values (v_commit,v_snap,repeat('c',40),0,'Dev',now(),'feat: V1.15');

  insert into public.analysis_commit_file(commit_id,file_order,path,change_type)
  values (v_commit,0,'docs/openapi/ERP租户域名迁移.md','ADDED');

  insert into public.analysis_story_scope(
    id,task_id,generation,scope_mode,algorithm_version,ruleset_hash,candidate_manifest_hash
  ) values (v_scope,v_task,1,'HYBRID_CANDIDATES','story-attribution-v2',repeat('d',64),repeat('e',64));

  insert into public.analysis_story_commit_candidate(
    id,scope_id,task_id,generation,commit_id,tier,selection_source,reason_codes
  ) values (v_candidate,v_scope,v_task,1,v_commit,'STRONG','RULE',array['STORY_ID_TRAILER']);

  insert into public.analysis_story_commit_relevance_verdict(
    task_id,candidate_id,agent_run_id,triage_revision,verdict,reason_codes,summary,payload_hash
  ) values (v_task,v_candidate,v_run,1,'RELATED',array['CODE_MATCHES_STORY'],'相关',repeat('f',64));

  -- 先证明缺口真实存在：直接删 review_story 会被 RESTRICT 外键挡住。
  perform pg_temp.assert_error(
    format('delete from public.review_story where id=%L',v_story),
    'analysis_job_story_snapshot','a frozen story snapshot still protects a single story row');

  perform public.delete_review_batch(v_batch);

  perform pg_temp.assert((select count(*) from public.review_batch where id=v_batch)=0,
    'the batch row is gone');
  perform pg_temp.assert((select count(*) from public.review_story where batch_id=v_batch)=0,
    'batch stories are gone');
  perform pg_temp.assert((select count(*) from public.analysis_job where batch_id=v_batch)=0,
    'analysis jobs are gone');
  perform pg_temp.assert((select count(*) from public.analysis_repository_commit where id=v_commit)=0,
    'frozen commits are gone');
  perform pg_temp.assert((select count(*) from public.analysis_story_commit_candidate where id=v_candidate)=0,
    'commit candidates are gone');
  perform pg_temp.assert((select count(*) from public.analysis_story_commit_relevance_verdict where task_id=v_task)=0,
    'relevance verdicts are gone');
  select count(*) into v_count from public.batch_operation_log
  where batch_id is null and action='BATCH_DELETED' and batch_week_code_snapshot='WK-V115-001';
  perform pg_temp.assert(v_count=1,
    'deletion is still audited (batch_id becomes null via on delete set null)');

  raise notice 'V1.15 analysis job cancel + batch delete test passed';
end;
$test$;

rollback;
