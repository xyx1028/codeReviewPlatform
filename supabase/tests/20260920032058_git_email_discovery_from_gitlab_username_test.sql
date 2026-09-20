\set ON_ERROR_STOP on
\timing off

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
  v_owner uuid:='03205800-1000-4000-a000-000000000001';
  v_other uuid:='03205800-1000-4000-a000-000000000002';
  v_worker text:='v113-discovery-test-worker';
  v_secret uuid;
  v_pepper text;
  v_discovery uuid;
  v_claim jsonb;
  v_token uuid;
  v_view jsonb;
  v_result jsonb;
  v_candidate uuid;
  v_second_candidate uuid;
  v_git uuid;
  v_expected text;
  v_error text;
  v_email text:='YuXuan.Xue@Kingdee.Com';
  v_normalized text:='yuxuan.xue@kingdee.com';
begin
  insert into auth.users(id,email) values
    (v_owner,'v113-owner@example.invalid'),
    (v_other,'v113-other@example.invalid')
  on conflict(id) do nothing;
  insert into public.user_profile(id,role,display_name) values
    (v_owner,'REVIEWER','V1.13 本人'),
    (v_other,'REVIEWER','V1.13 他人')
  on conflict(id) do update set role=excluded.role,display_name=excluded.display_name;

  select secret.decrypted_secret into v_pepper
  from vault.decrypted_secrets secret
  where secret.name='analysis_identity_pepper'
  order by secret.created_at desc limit 1;
  if coalesce(v_pepper,'')='' then
    v_pepper:='v113-discovery-test-pepper-not-a-real-secret';
    select vault.create_secret(v_pepper,'analysis_identity_pepper') into v_secret;
  end if;
  v_expected:=encode(extensions.hmac(
    convert_to(v_normalized,'UTF8'),convert_to(v_pepper,'UTF8'),'sha256'),'hex');

  ----------------------------------------------------------------------------
  -- 1. 下单：只接受合法 GitLab 用户名，重复点按复用同一行
  ----------------------------------------------------------------------------
  perform set_config('request.jwt.claims',json_build_object(
    'sub',v_owner::text,'role','authenticated')::text,true);
  set local role authenticated;
  begin
    perform public.enqueue_my_git_email_discovery('bad name!');
    perform pg_temp.assert(false,'invalid GitLab username must be rejected');
  exception when others then
    get stacked diagnostics v_error=message_text;
    perform pg_temp.assert(v_error='GITLAB_USERNAME_INVALID','invalid username returns a stable code');
  end;
  v_discovery:=public.enqueue_my_git_email_discovery('yuxuan_xue');
  perform pg_temp.assert(public.enqueue_my_git_email_discovery('yuxuan_xue')=v_discovery,
    'a second click reuses the active discovery instead of queueing a duplicate');
  v_view:=public.get_my_git_email_discovery(v_discovery);
  perform pg_temp.assert(v_view->>'status'='QUEUED'
    and v_view->>'gitlab_username'='yuxuan_xue'
    and jsonb_array_length(v_view->'candidates')=0,
    'a fresh discovery is QUEUED with no candidates');
  reset role;

  ----------------------------------------------------------------------------
  -- 2. 别人读不到这条查询
  ----------------------------------------------------------------------------
  perform set_config('request.jwt.claims',json_build_object(
    'sub',v_other::text,'role','authenticated')::text,true);
  set local role authenticated;
  begin
    perform public.get_my_git_email_discovery(v_discovery);
    perform pg_temp.assert(false,'another account must not read this discovery');
  exception when others then
    get stacked diagnostics v_error=message_text;
    perform pg_temp.assert(v_error='GIT_EMAIL_DISCOVERY_NOT_FOUND','foreign discovery read fails closed');
  end;
  reset role;

  ----------------------------------------------------------------------------
  -- 3. Worker 领取 + 回填候选：库内算 HMAC，明文不落库
  ----------------------------------------------------------------------------
  perform pg_temp.assert(
    not has_function_privilege('authenticated','public.claim_next_git_email_discovery(text,integer)','EXECUTE'),
    'authenticated cannot claim discovery work');

  v_claim:=public.claim_next_git_email_discovery(v_worker,90);
  perform pg_temp.assert((v_claim->>'id')::uuid=v_discovery
    and v_claim->>'gitlab_username'='yuxuan_xue'
    and v_claim->>'claim_token' is not null,
    'the worker claims the queued discovery');
  -- 领取结果里不能出现请求人，Worker 不需要知道是谁在查
  perform pg_temp.assert(v_claim::text not ilike '%'||v_owner::text||'%',
    'claim payload does not expose the requester');
  v_token:=(v_claim->>'claim_token')::uuid;
  perform pg_temp.assert(public.claim_next_git_email_discovery(v_worker,90) is null,
    'a running discovery is not claimed twice');
  perform pg_temp.assert(public.heartbeat_git_email_discovery(v_discovery,v_worker,v_token,90),
    'heartbeat extends the lease');
  perform pg_temp.assert(not public.heartbeat_git_email_discovery(v_discovery,v_worker,gen_random_uuid(),90),
    'a wrong claim token cannot heartbeat');

  v_result:=public.complete_git_email_discovery(
    v_discovery,v_worker,v_token,'1001','薛宇轩',7,false,
    jsonb_build_array(
      jsonb_build_object(
        'email',v_email,
        'author_names',jsonb_build_array('薛宇轩','yuxuan_xue'),
        'commit_count',12,
        'last_committed_at','2026-09-18T10:00:00+08:00',
        'repositories',jsonb_build_object('tmanage-backend',9,'kdmanage-backend',3),
        'merge_request_refs',jsonb_build_array('tmanage-backend!3725')
      ),
      jsonb_build_object(
        'email','17751361028@163.com',
        'author_names',jsonb_build_array('xyx'),
        'commit_count',3,
        'last_committed_at','2026-09-11T09:00:00+08:00',
        'repositories',jsonb_build_object('tmanage-backend',3),
        'merge_request_refs',jsonb_build_array('tmanage-backend!3611')
      ),
      -- 残缺的 author 字段必须被跳过，而不是让整次回填失败
      jsonb_build_object('email','not-an-email','commit_count',1)
    )
  );
  perform pg_temp.assert((v_result->>'candidate_count')::integer=2,
    'invalid author emails are skipped instead of failing the whole callback');
  perform pg_temp.assert(
    (select email_fingerprint=v_expected and masked_email='y***@kingdee.com' and email_domain='kingdee.com'
     from public.git_identity_email_candidate
     where discovery_id=v_discovery and masked_email='y***@kingdee.com'),
    'candidate stores the pepper HMAC and masked email');
  -- V1.13 调整（20260920050223）：候选行为了在页面上展示原文，会存 email_plain。
  -- 边界收在这里：只有这张临时表存明文，且必须是规范化后的小写形式。
  perform pg_temp.assert(
    (select email_plain=v_normalized
     from public.git_identity_email_candidate
     where discovery_id=v_discovery and masked_email='y***@kingdee.com'),
    'the short-lived candidate row keeps the normalized plaintext for display');

  ----------------------------------------------------------------------------
  -- 4. 本人看到的是脱敏候选，且没有指纹
  ----------------------------------------------------------------------------
  perform set_config('request.jwt.claims',json_build_object(
    'sub',v_owner::text,'role','authenticated')::text,true);
  set local role authenticated;
  v_view:=public.get_my_git_email_discovery(v_discovery);
  reset role;
  perform pg_temp.assert(v_view->>'status'='SUCCEEDED'
    and (v_view->>'candidate_count')::integer=2
    and (v_view->>'merge_request_count')::integer=7
    and v_view->>'gitlab_user_id'='1001',
    'the requester sees the finished discovery');
  perform pg_temp.assert(v_view->'candidates'->0->>'masked_email'='y***@kingdee.com'
    and (v_view->'candidates'->0->>'commit_count')::integer=12
    and v_view->'candidates'->0->'author_names' ? '薛宇轩',
    'candidates are ordered by commit count and carry the real author names');
  perform pg_temp.assert(v_view::text not ilike '%'||v_expected||'%',
    'the fingerprint never reaches the browser');
  perform pg_temp.assert(v_view->'candidates'->0->>'email'=v_normalized,
    'the requester does see the plaintext of their own candidate');
  v_candidate:=(v_view->'candidates'->0->>'candidate_id')::uuid;
  v_second_candidate:=(v_view->'candidates'->1->>'candidate_id')::uuid;

  ----------------------------------------------------------------------------
  -- 5. 点选候选保存 = VERIFIED，别名默认取 GitLab 里的作者名
  ----------------------------------------------------------------------------
  perform set_config('request.jwt.claims',json_build_object(
    'sub',v_owner::text,'role','authenticated')::text,true);
  set local role authenticated;
  v_result:=public.upsert_my_git_identity_from_candidate(v_candidate,'薛宇轩','E-V113');
  reset role;
  v_git:=(v_result->>'git_identity_id')::uuid;
  perform pg_temp.assert(v_result->>'verification_status'='VERIFIED'
    and v_result->>'masked_email'='y***@kingdee.com',
    'selecting a candidate saves a VERIFIED identity');
  perform pg_temp.assert(
    (select email_fingerprint=v_expected
       and gitlab_username='yuxuan_xue' and gitlab_user_id='1001'
       and author_name_aliases @> array['薛宇轩']
     from public.developer_git_identity where id=v_git),
    'the saved row reuses the candidate fingerprint and GitLab identity');
  -- 这一条是整个设计的底线：明文可以出现在临时候选里，但绝不进正式身份表。
  perform pg_temp.assert(
    (select to_jsonb(git)::text not ilike '%'||v_normalized||'%'
     from public.developer_git_identity git where git.id=v_git),
    'the identity row still holds no plaintext email');

  ----------------------------------------------------------------------------
  -- 6. 门禁：别人的候选、过期的查询都不能用来伪造已验证身份
  ----------------------------------------------------------------------------
  perform set_config('request.jwt.claims',json_build_object(
    'sub',v_other::text,'role','authenticated')::text,true);
  set local role authenticated;
  begin
    perform public.upsert_my_git_identity_from_candidate(v_candidate,'冒用的人');
    perform pg_temp.assert(false,'another account must not use this candidate');
  exception when others then
    get stacked diagnostics v_error=message_text;
    perform pg_temp.assert(v_error='GIT_EMAIL_CANDIDATE_NOT_FOUND','foreign candidate fails closed');
  end;
  reset role;

  update public.git_identity_email_discovery
  set finished_at=now()-interval '3 hours' where id=v_discovery;
  perform set_config('request.jwt.claims',json_build_object(
    'sub',v_owner::text,'role','authenticated')::text,true);
  set local role authenticated;
  begin
    perform public.upsert_my_git_identity_from_candidate(v_second_candidate,'薛宇轩','E-V113');
    perform pg_temp.assert(false,'a stale discovery must not be usable');
  exception when others then
    get stacked diagnostics v_error=message_text;
    perform pg_temp.assert(v_error='GIT_EMAIL_DISCOVERY_EXPIRED','stale discovery returns a stable code');
  end;
  reset role;

  ----------------------------------------------------------------------------
  -- 7. 手输邮箱只能得到 UNVERIFIED
  ----------------------------------------------------------------------------
  -- V1.13 起这个函数只剩 service_role 能调（见 20260920045313），所以这里不切角色；
  -- 这一段守的是"手输只能落 UNVERIFIED"这条语义，权限面由那个迁移自己的测试覆盖。
  perform set_config('request.jwt.claims',json_build_object(
    'sub',v_owner::text,'role','authenticated')::text,true);
  v_result:=public.upsert_my_git_identity_from_email(
    null,'薛宇轩','E-V113','typed.by.hand@example.invalid',array[]::text[],null,null,null);
  perform pg_temp.assert(v_result->>'verification_status'='UNVERIFIED',
    'a typed email is stored as UNVERIFIED because it carries no evidence');
  perform pg_temp.assert(exists(
    select 1 from public.analysis_scope_decision_audit
    where actor_id=v_owner and 'MANUAL_EMAIL_UNVERIFIED'=any(reason_codes)),
    'the manual path is audited as unverified');
  perform pg_temp.assert(exists(
    select 1 from public.analysis_scope_decision_audit
    where actor_id=v_owner and 'GITLAB_COMMIT_VERIFIED'=any(reason_codes)),
    'the candidate path is audited with its GitLab evidence');

  ----------------------------------------------------------------------------
  -- 8. 失败与释放
  ----------------------------------------------------------------------------
  perform set_config('request.jwt.claims',json_build_object(
    'sub',v_other::text,'role','authenticated')::text,true);
  set local role authenticated;
  v_discovery:=public.enqueue_my_git_email_discovery('ghost_user');
  reset role;
  v_claim:=public.claim_next_git_email_discovery(v_worker,90);
  v_token:=(v_claim->>'claim_token')::uuid;
  perform pg_temp.assert(public.release_git_email_discovery_claim(v_discovery,v_worker,v_token),
    'a worker can requeue its own claim on shutdown');
  perform pg_temp.assert(
    (select status='QUEUED' from public.git_identity_email_discovery where id=v_discovery),
    'released work goes back to QUEUED');
  v_claim:=public.claim_next_git_email_discovery(v_worker,90);
  v_token:=(v_claim->>'claim_token')::uuid;
  perform pg_temp.assert(public.fail_git_email_discovery(
    v_discovery,v_worker,v_token,'GITLAB_USER_NOT_FOUND','GitLab 上没有这个用户名'),
    'the worker can record a stable failure');
  perform pg_temp.assert(
    (select status='FAILED' and error_code='GITLAB_USER_NOT_FOUND'
     from public.git_identity_email_discovery where id=v_discovery),
    'failure keeps the stable error code for the UI');

  ----------------------------------------------------------------------------
  -- 9. 权限面
  ----------------------------------------------------------------------------
  perform pg_temp.assert(
    has_function_privilege('authenticated','public.enqueue_my_git_email_discovery(text,integer)','EXECUTE')
    and has_function_privilege('authenticated','public.get_my_git_email_discovery(uuid)','EXECUTE')
    and has_function_privilege('authenticated',
      'public.upsert_my_git_identity_from_candidate(uuid,text,text,text[],text,text,uuid,integer)','EXECUTE'),
    'authenticated may call the three self-service RPCs');
  perform pg_temp.assert(
    not has_function_privilege('anon','public.enqueue_my_git_email_discovery(text,integer)','EXECUTE')
    and not has_function_privilege('anon','public.get_my_git_email_discovery(uuid)','EXECUTE')
    and not has_function_privilege('authenticated',
      'public.complete_git_email_discovery(uuid,text,uuid,text,text,integer,boolean,jsonb)','EXECUTE'),
    'anon is locked out and the worker callbacks stay service-role only');
  perform pg_temp.assert(
    (select count(*) from pg_class where relname in
      ('git_identity_email_discovery','git_identity_email_candidate') and relrowsecurity)=2,
    'both new tables have RLS enabled');
  perform pg_temp.assert(
    not has_table_privilege('authenticated','public.git_identity_email_candidate','SELECT'),
    'candidates are reachable only through the RPC');
end;
$test$;

rollback;
