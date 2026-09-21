\set ON_ERROR_STOP on
\timing off

-- V1.13.1：候选归属依据（match_reason）与剔除数（excluded_candidate_count）
-- 断言范围只限本测试自己建的 fixture，不依赖库里既有数据。

begin;
set local client_min_messages=warning;

create or replace function pg_temp.assert(p_condition boolean,p_message text)
returns void language plpgsql as $$
begin
  if p_condition is distinct from true then raise exception 'ASSERT FAILED: %',p_message; end if;
end;
$$;

do $test$
declare
  v_owner uuid:='03205801-1000-4000-a000-000000000001';
  v_worker text:='v1131-attribution-test-worker';
  v_secret uuid;
  v_pepper text;
  v_discovery uuid;
  v_claim jsonb;
  v_token uuid;
  v_view jsonb;
  v_result jsonb;
  v_error text;
  v_reasons text[];
begin
  insert into auth.users(id,email) values (v_owner,'v1131-owner@example.invalid')
  on conflict(id) do nothing;
  insert into public.user_profile(id,role,display_name) values (v_owner,'REVIEWER','V1.13.1 本人')
  on conflict(id) do update set role=excluded.role,display_name=excluded.display_name;

  select secret.decrypted_secret into v_pepper
  from vault.decrypted_secrets secret
  where secret.name='analysis_identity_pepper'
  order by secret.created_at desc limit 1;
  if coalesce(v_pepper,'')='' then
    v_pepper:='v1131-attribution-test-pepper-not-a-real-secret';
    select vault.create_secret(v_pepper,'analysis_identity_pepper') into v_secret;
  end if;

  ----------------------------------------------------------------------------
  -- 0. 新列存在，且旧签名不再留着当后门
  ----------------------------------------------------------------------------
  perform pg_temp.assert((
    select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='complete_git_email_discovery')=1,
    'complete_git_email_discovery has exactly one signature (old 8-arg overload dropped)');
  perform pg_temp.assert(
    has_function_privilege('service_role',
      'public.complete_git_email_discovery(uuid,text,uuid,text,text,integer,boolean,jsonb,integer)','EXECUTE')
    and not has_function_privilege('authenticated',
      'public.complete_git_email_discovery(uuid,text,uuid,text,text,integer,boolean,jsonb,integer)','EXECUTE'),
    'only service_role may complete a discovery');

  ----------------------------------------------------------------------------
  -- 1. 回填带 match_reason 的候选 + 剔除数
  ----------------------------------------------------------------------------
  perform set_config('request.jwt.claims',json_build_object(
    'sub',v_owner::text,'role','authenticated')::text,true);
  set local role authenticated;
  v_discovery:=public.enqueue_my_git_email_discovery('jin_gu');
  reset role;

  v_claim:=public.claim_next_git_email_discovery(v_worker,90);
  perform pg_temp.assert((v_claim->>'id')::uuid=v_discovery,'the worker claims the queued discovery');
  v_token:=(v_claim->>'claim_token')::uuid;

  v_result:=public.complete_git_email_discovery(
    v_discovery,v_worker,v_token,'2956','jin_gu',40,false,
    jsonb_build_array(
      jsonb_build_object(
        'email','jin_gu@kingdee.com',
        'author_names',jsonb_build_array('jin_gu'),
        'commit_count',100,
        'last_committed_at','2026-09-19T10:00:00+08:00',
        'repositories',jsonb_build_object('kdmanage-backend',60,'tmanage-backend',40),
        'merge_request_refs',jsonb_build_array('kdmanage-backend!1796'),
        'match_reason','GITLAB_EMAIL_MATCH'
      ),
      jsonb_build_object(
        'email','kingdee@m2607-0072.local',
        'author_names',jsonb_build_array('jin_gu'),
        'commit_count',4,
        'last_committed_at','2026-09-10T10:00:00+08:00',
        'repositories',jsonb_build_object('tmanage-frontend',4),
        'merge_request_refs',jsonb_build_array('tmanage-frontend!1835'),
        'match_reason','AUTHOR_NAME_MATCH'
      ),
      -- 未知依据（旧/新版本混跑）不该让整次反查失败，落成 null
      jsonb_build_object(
        'email','weird@kingdee.com',
        'author_names',jsonb_build_array('jin_gu'),
        'commit_count',1,
        'repositories',jsonb_build_object('tmanage-backend',1),
        'merge_request_refs',jsonb_build_array('tmanage-backend!3653'),
        'match_reason','SOMETHING_ELSE'
      )
    ),
    13);
  perform pg_temp.assert((v_result->>'candidate_count')::integer=3
    and (v_result->>'excluded_candidate_count')::integer=13,
    'complete returns both the kept and the excluded counts');

  select array_agg(match_reason order by commit_count desc) into v_reasons
  from public.git_identity_email_candidate where discovery_id=v_discovery;
  perform pg_temp.assert(v_reasons=array['GITLAB_EMAIL_MATCH','AUTHOR_NAME_MATCH',null]::text[],
    'match_reason is stored per candidate; an unknown reason degrades to null instead of failing');

  ----------------------------------------------------------------------------
  -- 2. 本人读到的视图带上依据与剔除数；明文仍只有自己看得到，指纹不出库
  ----------------------------------------------------------------------------
  perform set_config('request.jwt.claims',json_build_object(
    'sub',v_owner::text,'role','authenticated')::text,true);
  set local role authenticated;
  v_view:=public.get_my_git_email_discovery(v_discovery);
  perform pg_temp.assert((v_view->>'excluded_candidate_count')::integer=13,
    'the requester sees how many foreign emails were dropped');
  perform pg_temp.assert(
    (v_view->'candidates'->0->>'match_reason')='GITLAB_EMAIL_MATCH'
    and (v_view->'candidates'->0->>'email')='jin_gu@kingdee.com'
    and (v_view->'candidates'->2->>'match_reason') is null,
    'each candidate carries its attribution reason');
  perform pg_temp.assert(v_view::text not like '%email_fingerprint%'
    and v_view::text !~ '[0-9a-f]{64}',
    'the fingerprint never leaves the database');
  reset role;

  ----------------------------------------------------------------------------
  -- 3. 库侧约束：只接受四个取值
  ----------------------------------------------------------------------------
  begin
    update public.git_identity_email_candidate
    set match_reason='NOT_A_REASON'
    where discovery_id=v_discovery;
    perform pg_temp.assert(false,'match_reason must be constrained');
  exception when check_violation then
    null;
  end;

  ----------------------------------------------------------------------------
  -- 4. 剔除数不能为负
  ----------------------------------------------------------------------------
  begin
    update public.git_identity_email_discovery
    set excluded_candidate_count=-1 where id=v_discovery;
    perform pg_temp.assert(false,'excluded_candidate_count must be non-negative');
  exception when check_violation then
    null;
  end;

  ----------------------------------------------------------------------------
  -- 5. 旧 Worker（不传新参数）仍能完成：默认 0，match_reason 为 null
  ----------------------------------------------------------------------------
  perform set_config('request.jwt.claims',json_build_object(
    'sub',v_owner::text,'role','authenticated')::text,true);
  set local role authenticated;
  v_discovery:=public.enqueue_my_git_email_discovery('jin_gu');
  reset role;
  v_claim:=public.claim_next_git_email_discovery(v_worker,90);
  v_token:=(v_claim->>'claim_token')::uuid;
  v_result:=public.complete_git_email_discovery(
    p_discovery_id=>v_discovery,
    p_worker_id=>v_worker,
    p_claim_token=>v_token,
    p_gitlab_user_id=>'2956',
    p_gitlab_display_name=>'jin_gu',
    p_merge_request_count=>40,
    p_partial=>false,
    p_candidates=>jsonb_build_array(jsonb_build_object(
      'email','legacy@kingdee.com',
      'author_names',jsonb_build_array('jin_gu'),
      'commit_count',2,
      'repositories',jsonb_build_object('tmanage-backend',2),
      'merge_request_refs',jsonb_build_array('tmanage-backend!1')
    )));
  perform pg_temp.assert((v_result->>'excluded_candidate_count')::integer=0,
    'a pre-V1.13.1 worker call still succeeds and records zero exclusions');
  perform pg_temp.assert((
    select match_reason is null from public.git_identity_email_candidate
    where discovery_id=v_discovery)=true,
    'candidates written by an old worker keep a null reason');

  -- 租约丢失的路径没有因为加参数而变化
  begin
    perform public.complete_git_email_discovery(
      v_discovery,v_worker,gen_random_uuid(),'2956','jin_gu',40,false,'[]'::jsonb,0);
    perform pg_temp.assert(false,'a wrong claim token cannot complete');
  exception when others then
    get stacked diagnostics v_error=message_text;
    perform pg_temp.assert(v_error='TASK_LEASE_LOST','lease checks still fail closed');
  end;

  raise notice 'V1.13.1 commit attribution assertions passed';
end;
$test$;

rollback;
