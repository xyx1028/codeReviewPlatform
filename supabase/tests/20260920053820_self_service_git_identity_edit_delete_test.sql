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
  v_owner uuid:='05382000-1000-4000-a000-000000000001';
  v_other uuid:='05382000-1000-4000-a000-000000000002';
  v_dev_owner uuid;
  v_dev_other uuid;
  v_fresh uuid;      -- 没进过分析快照，可真删
  v_analysed uuid;   -- 已被 Job 冻结，只能停用
  v_alias_only uuid; -- 没有邮箱指纹，靠别名匹配
  v_batch uuid;
  v_model uuid;
  v_job uuid;
  v_result jsonb;
  v_error text;
begin
  insert into auth.users(id,email) values
    (v_owner,'v113-edit-owner@example.invalid'),
    (v_other,'v113-edit-other@example.invalid')
  on conflict(id) do nothing;
  insert into public.user_profile(id,role,display_name) values
    (v_owner,'REVIEWER','编辑本人'),(v_other,'REVIEWER','另一个人')
  on conflict(id) do update set role=excluded.role;

  insert into public.developer_identity(display_name,status,auth_user_id)
  values('编辑本人','VERIFIED',v_owner) returning id into v_dev_owner;
  insert into public.developer_identity(display_name,status,auth_user_id)
  values('另一个人','VERIFIED',v_other) returning id into v_dev_other;

  insert into public.developer_git_identity(
    developer_identity_id,provider,email_fingerprint,masked_email,email_domain,
    author_name_aliases,gitlab_username,verification_status)
  values(v_dev_owner,'git',repeat('a',64),'f***@kingdee.com','kingdee.com',
    array['kingdee'],'yuxuan_xue','VERIFIED') returning id into v_fresh;
  insert into public.developer_git_identity(
    developer_identity_id,provider,email_fingerprint,masked_email,email_domain,
    author_name_aliases,verification_status)
  values(v_dev_owner,'git',repeat('b',64),'a***@kingdee.com','kingdee.com',
    array['old'],'VERIFIED') returning id into v_analysed;
  insert into public.developer_git_identity(
    developer_identity_id,provider,author_name_aliases,verification_status)
  values(v_dev_owner,'git',array['只有别名'],'UNVERIFIED') returning id into v_alias_only;

  ----------------------------------------------------------------------------
  -- 1. 编辑：改的是自己填的两列，验证得来的邮箱一个字节都不动
  ----------------------------------------------------------------------------
  perform set_config('request.jwt.claims',json_build_object(
    'sub',v_owner::text,'role','authenticated')::text,true);
  set local role authenticated;
  v_result:=public.update_my_git_identity_details(
    v_fresh, array['  薛宇轩 ','xueyuxuan','薛宇轩',''], ' yuxuan_xue ', 1);
  reset role;
  perform pg_temp.assert(
    v_result->'author_name_aliases'=jsonb_build_array('xueyuxuan','薛宇轩')
    or v_result->'author_name_aliases'=jsonb_build_array('薛宇轩','xueyuxuan'),
    'aliases are trimmed, de-duplicated and emptied entries dropped');
  perform pg_temp.assert(v_result->>'gitlab_username'='yuxuan_xue','the username is trimmed');
  perform pg_temp.assert((v_result->>'git_revision')::int=2,'the revision moves forward');
  perform pg_temp.assert((
    select email_fingerprint=repeat('a',64) and masked_email='f***@kingdee.com'
       and email_domain='kingdee.com' and verification_status='VERIFIED'
    from public.developer_git_identity where id=v_fresh),
    'editing the typed fields never touches the verified email or downgrades it');
  perform pg_temp.assert(exists(
    select 1 from public.analysis_scope_decision_audit
    where actor_id=v_owner and 'SELF_GIT_IDENTITY_EDITED'=any(reason_codes)
      and before_state->'author_name_aliases'=jsonb_build_array('kingdee')),
    'the edit is audited with the previous aliases');

  ----------------------------------------------------------------------------
  -- 2. 编辑的校验与越权
  ----------------------------------------------------------------------------
  perform set_config('request.jwt.claims',json_build_object(
    'sub',v_owner::text,'role','authenticated')::text,true);
  set local role authenticated;
  begin
    perform public.update_my_git_identity_details(v_fresh,array['ok'],'bad username!',null);
    perform pg_temp.assert(false,'a malformed GitLab username must be rejected');
  exception when others then
    get stacked diagnostics v_error=message_text;
    perform pg_temp.assert(v_error='GITLAB_USERNAME_INVALID','malformed username returns a stable code');
  end;
  begin
    perform public.update_my_git_identity_details(v_fresh,array[repeat('n',65)],null,null);
    perform pg_temp.assert(false,'an over-long alias must be rejected');
  exception when others then
    get stacked diagnostics v_error=message_text;
    perform pg_temp.assert(v_error='GIT_IDENTITY_ALIAS_INVALID','over-long alias returns a stable code');
  end;
  begin
    perform public.update_my_git_identity_details(v_fresh,array['a','b','c','d','e','f','g','h','i','j','k'],null,null);
    perform pg_temp.assert(false,'more than ten aliases must be rejected');
  exception when others then
    get stacked diagnostics v_error=message_text;
    perform pg_temp.assert(v_error='GIT_IDENTITY_TOO_MANY_ALIASES','alias cap returns a stable code');
  end;
  begin
    perform public.update_my_git_identity_details(v_fresh,array['x'],null,99);
    perform pg_temp.assert(false,'a stale revision must be rejected');
  exception when others then
    get stacked diagnostics v_error=message_text;
    perform pg_temp.assert(v_error='REVISION_CONFLICT','optimistic locking still applies');
  end;
  -- 纯别名行清空后就什么都匹配不到了，必须拒绝而不是留一行死数据
  begin
    perform public.update_my_git_identity_details(v_alias_only,array[]::text[],null,null);
    perform pg_temp.assert(false,'clearing the only matchable field must be rejected');
  exception when others then
    get stacked diagnostics v_error=message_text;
    perform pg_temp.assert(v_error='GIT_IDENTITY_WOULD_MATCH_NOTHING','the row must keep something to match on');
  end;
  reset role;

  -- 别人的行既不能编辑也不能删除，且对外表现为"不存在"
  perform set_config('request.jwt.claims',json_build_object(
    'sub',v_other::text,'role','authenticated')::text,true);
  set local role authenticated;
  begin
    perform public.update_my_git_identity_details(v_fresh,array['偷改'],null,null);
    perform pg_temp.assert(false,'editing somebody else identity must fail');
  exception when others then
    get stacked diagnostics v_error=message_text;
    perform pg_temp.assert(v_error='GIT_IDENTITY_NOT_FOUND','another member row is simply not found');
  end;
  begin
    perform public.delete_my_git_identity(v_fresh,null);
    perform pg_temp.assert(false,'deleting somebody else identity must fail');
  exception when others then
    get stacked diagnostics v_error=message_text;
    perform pg_temp.assert(v_error='GIT_IDENTITY_NOT_FOUND','and neither can it be deleted');
  end;
  reset role;
  perform pg_temp.assert((
    select author_name_aliases @> array['薛宇轩'] from public.developer_git_identity where id=v_fresh),
    'the row survived both cross-account attempts unchanged');

  ----------------------------------------------------------------------------
  -- 3. 删除：没进过分析快照的行真删，并留下审计
  ----------------------------------------------------------------------------
  perform set_config('request.jwt.claims',json_build_object(
    'sub',v_owner::text,'role','authenticated')::text,true);
  set local role authenticated;
  v_result:=public.delete_my_git_identity(v_fresh,2);
  reset role;
  perform pg_temp.assert((v_result->>'deleted')::boolean,'a never-analysed row is hard-deleted');
  perform pg_temp.assert(
    not exists(select 1 from public.developer_git_identity where id=v_fresh),
    'the row is really gone, not just disabled');
  perform pg_temp.assert(exists(
    select 1 from public.analysis_scope_decision_audit
    where actor_id=v_owner and 'SELF_GIT_IDENTITY_DELETED'=any(reason_codes)
      and before_state->>'masked_email'='f***@kingdee.com'),
    'the deleted row leaves a masked trace behind');

  ----------------------------------------------------------------------------
  -- 4. 删除：已被 Job 冻结的行不能删（否则切断分析结论的追溯链）
  ----------------------------------------------------------------------------
  insert into public.review_batch(name,week_code,default_branch) values('v113 编辑删除','2026-W38','feature_dev')
  returning id into v_batch;
  insert into public.ai_model_config(display_name,base_url,model_name,api_key_secret_id)
  values('v113-edit-model','https://example.invalid','m',gen_random_uuid()) returning id into v_model;
  insert into public.analysis_job(
    batch_id,model_config_id,model_snapshot,requested_branch,requested_by,
    policy_version,capability_policy_snapshot)
  values(v_batch,v_model,'{}'::jsonb,'feature_dev',v_owner,
    4,jsonb_build_object('test_fixture',true)) returning id into v_job;
  insert into public.analysis_job_identity_snapshot(
    job_id,source_developer_identity_id,source_git_identity_id,developer_display_name,
    identity_status,provider,author_name_aliases,verification_status,snapshot_hash)
  values(v_job,v_dev_owner,v_analysed,'编辑本人','VERIFIED','git',array['old'],'VERIFIED',repeat('c',64));

  perform set_config('request.jwt.claims',json_build_object(
    'sub',v_owner::text,'role','authenticated')::text,true);
  set local role authenticated;
  begin
    perform public.delete_my_git_identity(v_analysed,null);
    perform pg_temp.assert(false,'an analysed row must not be hard-deleted');
  exception when others then
    get stacked diagnostics v_error=message_text;
    perform pg_temp.assert(v_error='GIT_IDENTITY_IN_USE',
      'the caller is told to disable it instead of getting a raw FK violation');
  end;
  -- 停用这条路仍然通，而且不会悄悄替代删除
  v_result:=public.disable_my_git_identity(v_analysed,null);
  reset role;
  perform pg_temp.assert(v_result->>'verification_status'='DISABLED',
    'disabling remains the supported path for an analysed row');
  perform pg_temp.assert(exists(select 1 from public.developer_git_identity where id=v_analysed),
    'and it keeps the row so the job snapshot stays traceable');

  ----------------------------------------------------------------------------
  -- 5. 已停用的行不再可编辑（改它只会让人误以为生效了）
  ----------------------------------------------------------------------------
  perform set_config('request.jwt.claims',json_build_object(
    'sub',v_owner::text,'role','authenticated')::text,true);
  set local role authenticated;
  begin
    perform public.update_my_git_identity_details(v_analysed,array['x'],null,null);
    perform pg_temp.assert(false,'a disabled row must not be editable');
  exception when others then
    get stacked diagnostics v_error=message_text;
    perform pg_temp.assert(v_error='GIT_IDENTITY_DISABLED','disabled rows return a stable code');
  end;
  reset role;

  ----------------------------------------------------------------------------
  -- 6. 权限面
  ----------------------------------------------------------------------------
  perform pg_temp.assert(
    has_function_privilege('authenticated','public.update_my_git_identity_details(uuid,text[],text,integer)','EXECUTE')
    and has_function_privilege('authenticated','public.delete_my_git_identity(uuid,integer)','EXECUTE'),
    'members can edit and delete their own rows');
  perform pg_temp.assert(
    not has_function_privilege('anon','public.update_my_git_identity_details(uuid,text[],text,integer)','EXECUTE')
    and not has_function_privilege('anon','public.delete_my_git_identity(uuid,integer)','EXECUTE'),
    'anon can do neither');
end;
$test$;

rollback;
