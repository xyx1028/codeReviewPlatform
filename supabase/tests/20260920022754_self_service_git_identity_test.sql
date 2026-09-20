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

-- V1.13 起 upsert_my_git_identity_from_email 已收回 authenticated 的执行权（见
-- 20260920045313_git_email_manual_entry_revoked.sql）。这份测试继续守住它的**业务语义**
-- （只写 UNVERIFIED、越权拒绝、乐观锁、停用保留历史），所以调用时不再切到 authenticated 角色；
-- auth.uid() 仍由 request.jwt.claims 决定，越权断言照旧有效。权限面由那个迁移自己的测试覆盖。
do $test$
declare
  v_owner uuid:='02275400-1000-4000-a000-000000000001';
  v_other uuid:='02275400-1000-4000-a000-000000000002';
  v_admin uuid:='02275400-1000-4000-a000-000000000003';
  v_secret uuid;
  v_result jsonb;
  v_view jsonb;
  v_developer uuid;
  v_git uuid;
  v_second uuid;
  v_revision integer;
  v_preset uuid;
  v_error text;
  v_email text:='Self.Owner+V112@Example.Invalid';
  v_normalized text:='self.owner+v112@example.invalid';
  v_expected text;
  v_pepper text:='v112-self-service-test-pepper-not-a-real-secret';begin
  insert into auth.users(id,email) values
    (v_owner,'v112-self-owner@example.invalid'),
    (v_other,'v112-self-other@example.invalid'),
    (v_admin,'v112-self-admin@example.invalid')
  on conflict(id) do nothing;
  insert into public.user_profile(id,role,display_name) values
    (v_owner,'REVIEWER','V1.12 本人'),
    (v_other,'REVIEWER','V1.12 他人'),
    (v_admin,'ADMIN','V1.12 管理员')
  on conflict(id) do update set role=excluded.role,display_name=excluded.display_name;

  -- pepper 可能已经在本机配置过：有就复用它，没有才建一个测试用的。
  -- 直接 create_secret 会撞 vault 的 name 唯一索引，让测试结果取决于本机残留状态。
  select secret.decrypted_secret into v_pepper
  from vault.decrypted_secrets secret
  where secret.name='analysis_identity_pepper'
  order by secret.created_at desc limit 1;
  if coalesce(v_pepper,'')='' then
    v_pepper:='v112-self-service-test-pepper-not-a-real-secret';
    select vault.create_secret(v_pepper,'analysis_identity_pepper') into v_secret;
  end if;
  v_expected:=encode(extensions.hmac(
    convert_to(v_normalized,'UTF8'),convert_to(v_pepper,'UTF8'),'sha256'
  ),'hex');

  ----------------------------------------------------------------------------
  -- 1. 本人首次自助配置：建身份 + 绑定账号 + 只存 HMAC 与脱敏邮箱
  ----------------------------------------------------------------------------
  perform set_config('request.jwt.claims',json_build_object(
    'sub',v_owner::text,'role','authenticated'
  )::text,true);
  v_result:=public.upsert_my_git_identity_from_email(
    null,'自助人员甲','E-V112-A',v_email,array['Self Owner'],'self-owner','9001'
  );
  v_view:=public.get_my_git_identity();
  reset role;

  v_developer:=(v_result->>'developer_id')::uuid;
  v_git:=(v_result->>'git_identity_id')::uuid;
  perform pg_temp.assert(v_result->>'masked_email'='s***@example.invalid',
    'self-service returns only the masked email');
  perform pg_temp.assert(v_result::text not ilike '%'||v_normalized||'%',
    'raw email is never returned');
  perform pg_temp.assert(
    (select auth_user_id=v_owner and status='VERIFIED'
     from public.developer_identity where id=v_developer),
    'developer identity is bound to the calling account and verified');
  perform pg_temp.assert(
    (select email_fingerprint=v_expected and masked_email='s***@example.invalid'
       and email_domain='example.invalid' and provider='gitlab'
       -- V1.13 起手输邮箱一律落 UNVERIFIED：没有 GitLab 提交作为证据，
       -- "已验证"只能来自 upsert_my_git_identity_from_candidate。
       and verification_status='UNVERIFIED'
     from public.developer_git_identity where id=v_git),
    'database stores pepper HMAC and masked identity, and a typed email stays UNVERIFIED');
  perform pg_temp.assert(
    (select to_jsonb(git)::text not ilike '%'||v_normalized||'%'
     from public.developer_git_identity git where git.id=v_git),
    'raw email is not persisted');
  perform pg_temp.assert(v_view->>'display_name'='自助人员甲'
    and jsonb_array_length(v_view->'identities')=1
    and v_view->'identities'->0->>'masked_email'='s***@example.invalid',
    'get_my_git_identity returns the caller own record');
  perform pg_temp.assert(v_view::text not ilike '%'||v_expected||'%',
    'fingerprint is not exposed to the browser');
  perform pg_temp.assert(exists(
    select 1 from public.analysis_scope_decision_audit
    where actor_id=v_owner and source='USER' and decision_type='IDENTITY_CONFIG'
      and 'SELF_IDENTITY_CREATED'=any(reason_codes)
  ),'self-service creation is audited with source USER');

  ----------------------------------------------------------------------------
  -- 2. 另一个账号看不到、也改不了别人的身份
  ----------------------------------------------------------------------------
  perform set_config('request.jwt.claims',json_build_object(
    'sub',v_other::text,'role','authenticated'
  )::text,true);
  set local role authenticated;
  v_view:=public.get_my_git_identity();
  reset role;
  perform pg_temp.assert(v_view->>'developer_id' is null
    and jsonb_array_length(v_view->'identities')=0,
    'a different account sees an empty own identity');
  begin
    perform public.upsert_my_git_identity_from_email(
      v_git,'自助人员乙',null,'hijack@example.invalid'
    );
    perform pg_temp.assert(false,'must not edit another account Git identity');
  exception when others then
    get stacked diagnostics v_error=message_text;
    perform pg_temp.assert(v_error='GIT_IDENTITY_NOT_FOUND',
      'editing a foreign Git identity fails closed');
  end;
  begin
    perform public.disable_my_git_identity(v_git);
    perform pg_temp.assert(false,'must not disable another account Git identity');
  exception when others then
    get stacked diagnostics v_error=message_text;
    perform pg_temp.assert(v_error in ('GIT_IDENTITY_NOT_FOUND','DEVELOPER_IDENTITY_NOT_FOUND'),
      'disabling a foreign Git identity fails closed');
  end;
  -- 同一个 Git 邮箱不能被第二个人占用
  begin
    perform public.upsert_my_git_identity_from_email(
      null,'自助人员乙',null,v_email
    );
    perform pg_temp.assert(false,'must not bind an email already owned by someone else');
  exception when others then
    get stacked diagnostics v_error=message_text;
    perform pg_temp.assert(v_error='GIT_EMAIL_ALREADY_BOUND',
      'duplicate Git email is rejected with a stable code');
  end;
  reset role;

  ----------------------------------------------------------------------------
  -- 3. 本人编辑既有行：revision 针对 Git 行，改邮箱不产生新行
  ----------------------------------------------------------------------------
  select revision into v_revision from public.developer_git_identity where id=v_git;
  perform set_config('request.jwt.claims',json_build_object(
    'sub',v_owner::text,'role','authenticated'
  )::text,true);
  v_result:=public.upsert_my_git_identity_from_email(
    v_git,'自助人员甲','E-V112-A','Second.Mail@Example.Invalid',
    array['Self Owner','selfowner'],'self-owner','9001',v_revision
  );
  begin
    perform public.upsert_my_git_identity_from_email(
      v_git,'自助人员甲','E-V112-A','third.mail@example.invalid',
      array[]::text[],null,null,v_revision
    );
    perform pg_temp.assert(false,'stale revision must be rejected');
  exception when others then
    get stacked diagnostics v_error=message_text;
    perform pg_temp.assert(v_error='REVISION_CONFLICT','stale revision returns REVISION_CONFLICT');
  end;
  -- 新增第二个邮箱
  v_second:=(public.upsert_my_git_identity_from_email(
    null,'自助人员甲','E-V112-A','work.mail@example.invalid'
  )->>'git_identity_id')::uuid;
  reset role;

  perform pg_temp.assert((v_result->>'git_identity_id')::uuid=v_git
    and v_result->>'masked_email'='s***@example.invalid',
    'editing updates the same Git identity row');
  perform pg_temp.assert(
    (select count(*) from public.developer_git_identity where developer_identity_id=v_developer)=2,
    'editing reuses the row; only the explicit add creates a second one');

  ----------------------------------------------------------------------------
  -- 4. 停用：保留行、关闭有效期、不再进入 Job 冻结集合
  ----------------------------------------------------------------------------
  perform set_config('request.jwt.claims',json_build_object(
    'sub',v_owner::text,'role','authenticated'
  )::text,true);
  set local role authenticated;
  v_result:=public.disable_my_git_identity(v_second);
  reset role;
  perform pg_temp.assert(v_result->>'verification_status'='DISABLED',
    'disable marks the row DISABLED instead of deleting it');
  perform pg_temp.assert(
    (select valid_until is not null and valid_until>valid_from
     from public.developer_git_identity where id=v_second),
    'disable closes the validity window without violating the range check');
  perform pg_temp.assert(
    (select count(*) from public.developer_git_identity where developer_identity_id=v_developer)=2,
    'disable keeps history rows for frozen Job snapshots');

  ----------------------------------------------------------------------------
  -- 5. 管理员代录后本人认领同一条身份，而不是撞员工号唯一键
  ----------------------------------------------------------------------------
  insert into public.developer_identity(display_name,employee_code,status)
  values('预置人员丙','E-V112-C','UNVERIFIED') returning id into v_preset;
  perform set_config('request.jwt.claims',json_build_object(
    'sub',v_other::text,'role','authenticated'
  )::text,true);
  v_result:=public.upsert_my_git_identity_from_email(
    null,'预置人员丙','E-V112-C','preset.claim@example.invalid'
  );
  reset role;
  perform pg_temp.assert((v_result->>'developer_id')::uuid=v_preset
    and (v_result->>'claimed_existing_developer')::boolean,
    'an unclaimed administrator-entered developer row is claimed by its owner');
  perform pg_temp.assert(
    (select auth_user_id=v_other and status='VERIFIED'
     from public.developer_identity where id=v_preset),
    'claiming binds the account and verifies the identity');
  perform pg_temp.assert(exists(
    select 1 from public.analysis_scope_decision_audit
    where actor_id=v_other and source='USER' and 'SELF_IDENTITY_CLAIMED'=any(reason_codes)
  ),'claiming is audited');

  ----------------------------------------------------------------------------
  -- 6. 权限面：authenticated 可调自助 RPC，anon 不可；管理员总览多出 auth_bound
  ----------------------------------------------------------------------------
  perform pg_temp.assert(
    has_function_privilege('authenticated','public.get_my_git_identity()','EXECUTE')
    and has_function_privilege('authenticated','public.disable_my_git_identity(uuid,integer)','EXECUTE')
    -- V1.13：手输邮箱这条路已经收回，成员只能走 GitLab 反查的候选。
    and not has_function_privilege('authenticated',
      'public.upsert_my_git_identity_from_email(uuid,text,text,text,text[],text,text,integer)','EXECUTE'),
    'members may read and disable their own identity, but can no longer self-declare an email');
  perform pg_temp.assert(
    not has_function_privilege('anon','public.get_my_git_identity()','EXECUTE')
    and not has_function_privilege('anon',
      'public.upsert_my_git_identity_from_email(uuid,text,text,text,text[],text,text,integer)','EXECUTE')
    and not has_function_privilege('anon','public.disable_my_git_identity(uuid,integer)','EXECUTE'),
    'anon cannot call the self-service RPCs');
  perform pg_temp.assert(
    (select count(*) from pg_proc proc join pg_namespace ns on ns.oid=proc.pronamespace
     where ns.nspname='public' and proc.proname='upsert_my_git_identity_from_email')=1,
    'no stale overload of the self-service RPC');

  perform set_config('request.jwt.claims',json_build_object(
    'sub',v_admin::text,'role','authenticated'
  )::text,true);
  set local role authenticated;
  v_view:=public.admin_list_developer_git_identities();
  reset role;
  perform pg_temp.assert(exists(
    select 1 from jsonb_array_elements(v_view) item
    where (item->>'developer_id')::uuid=v_developer and (item->>'auth_bound')::boolean
  ),'admin overview reports which identities are account-bound');
  perform pg_temp.assert(v_view::text not ilike '%'||v_expected||'%',
    'admin overview does not expose fingerprints');
end;
$test$;

rollback;
