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
  v_admin uuid:='13354900-1000-4000-a000-000000000001';
  v_user uuid:='13354900-1000-4000-a000-000000000002';
  v_secret uuid;
  v_result jsonb;
  v_developer uuid;
  v_git uuid;
  v_expected text;
  v_error text;
  v_email text:='Dev.Owner+V111@Example.Invalid';
  v_normalized text:='dev.owner+v111@example.invalid';
  v_pepper text:='v111-admin-entry-test-pepper-not-a-real-secret';
begin
  insert into auth.users(id,email) values
    (v_admin,'v111-admin-entry@example.invalid'),
    (v_user,'v111-normal-entry@example.invalid')
  on conflict(id) do nothing;
  insert into public.user_profile(id,role,display_name) values
    (v_admin,'ADMIN','V1.11 identity admin'),
    (v_user,'REVIEWER','V1.11 normal user')
  on conflict(id) do update set role=excluded.role,display_name=excluded.display_name;

  -- 本机可能已经配过 pepper（真实使用或另一个测试留下）。无条件 create_secret 会撞
  -- vault 的 name 唯一索引，让测试结果取决于环境残留，所以有就复用它。
  declare v_existing_pepper text;
  begin
    select secret.decrypted_secret into v_existing_pepper
    from vault.decrypted_secrets secret
    where secret.name='analysis_identity_pepper'
    order by secret.created_at desc limit 1;
    if coalesce(v_existing_pepper,'')<>'' then
      v_pepper:=v_existing_pepper;
    else
      select vault.create_secret(v_pepper,'analysis_identity_pepper') into v_secret;
    end if;
  end;
  v_expected:=encode(extensions.hmac(
    convert_to(v_normalized,'UTF8'),convert_to(v_pepper,'UTF8'),'sha256'
  ),'hex');

  perform set_config('request.jwt.claims',json_build_object(
    'sub',v_admin::text,'role','authenticated'
  )::text,true);
  set local role authenticated;
  v_result:=public.admin_upsert_developer_git_identity_from_email(
    null,null,'开发人员甲','E-V111',v_email,array['Dev Owner'],'dev-owner','gitlab-1001'
  );
  reset role;

  v_developer:=(v_result->>'developer_id')::uuid;
  v_git:=(v_result->>'git_identity_id')::uuid;
  perform pg_temp.assert(v_result->>'masked_email'='d***@example.invalid',
    'RPC returns only normalized masked email');
  perform pg_temp.assert(
    (select email_fingerprint=v_expected and masked_email='d***@example.invalid'
       and email_domain='example.invalid' and provider='gitlab'
     from public.developer_git_identity where id=v_git),
    'database stores pepper HMAC and masked identity');
  perform pg_temp.assert(
    (select to_jsonb(identity)::text not ilike '%dev.owner+v111@example.invalid%'
     from public.developer_git_identity identity where id=v_git),
    'raw email is not persisted in Git identity row');
  perform pg_temp.assert(v_result::text not ilike '%dev.owner+v111@example.invalid%',
    'raw email is not returned');

  perform set_config('request.jwt.claims',json_build_object(
    'sub',v_user::text,'role','authenticated'
  )::text,true);
  set local role authenticated;
  begin
    perform public.admin_upsert_developer_git_identity_from_email(
      null,null,'越权人员',null,'unauthorized@example.invalid'
    );
    perform pg_temp.assert(false,'non-admin must not configure Git identity');
  exception when others then
    get stacked diagnostics v_error=message_text;
    perform pg_temp.assert(v_error ilike '%admin%' or v_error ilike '%permission%',
      'non-admin receives an authorization error');
  end;
  reset role;

  perform pg_temp.assert(
    has_function_privilege('authenticated',
      'public.admin_upsert_developer_git_identity_from_email(uuid,uuid,text,text,text,text[],text,text,text,text,integer)',
      'EXECUTE'),
    'authenticated may call wrapper; ensure_admin remains the security boundary');
  perform pg_temp.assert(
    not has_function_privilege('anon',
      'public.admin_upsert_developer_git_identity_from_email(uuid,uuid,text,text,text,text[],text,text,text,text,integer)',
      'EXECUTE'),
    'anon cannot call wrapper');
end;
$test$;

rollback;
