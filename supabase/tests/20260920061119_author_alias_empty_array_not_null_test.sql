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
  v_owner uuid:='06111900-1000-4000-a000-000000000001';
  v_dev uuid;
  v_git uuid;
  v_alias_only uuid;
  v_result jsonb;
  v_aliases text[];
  v_error text;
begin
  insert into auth.users(id,email) values(v_owner,'v113-alias-empty@example.invalid')
  on conflict(id) do nothing;
  insert into public.user_profile(id,role,display_name) values(v_owner,'REVIEWER','清空别名')
  on conflict(id) do update set display_name=excluded.display_name;
  insert into public.developer_identity(display_name,status,auth_user_id)
  values('清空别名','VERIFIED',v_owner) returning id into v_dev;
  insert into public.developer_git_identity(
    developer_identity_id,provider,email_fingerprint,masked_email,email_domain,
    author_name_aliases,gitlab_username,verification_status)
  values(v_dev,'git',repeat('a',64),'p***@kingdee.com','kingdee.com',
    array['old','older'],'yuxuan_xue','VERIFIED') returning id into v_git;

  ----------------------------------------------------------------------------
  -- 1. 回归：清空别名不再撞 NOT NULL（这是 20260920053820 的缺陷）
  ----------------------------------------------------------------------------
  perform set_config('request.jwt.claims',json_build_object(
    'sub',v_owner::text,'role','authenticated')::text,true);
  set local role authenticated;
  v_result:=public.update_my_git_identity_details(v_git,array[]::text[],'yuxuan_xue',1);
  reset role;
  perform pg_temp.assert(v_result->'author_name_aliases'=jsonb_build_array(),
    'clearing every alias now succeeds and returns an empty list');
  perform pg_temp.assert((
    select author_name_aliases=array[]::text[] from public.developer_git_identity where id=v_git),
    'the stored representation of "no aliases" is the empty array, never NULL');

  -- 传 NULL 与传空数组是同一件事，不是一个会炸的特例
  perform set_config('request.jwt.claims',json_build_object(
    'sub',v_owner::text,'role','authenticated')::text,true);
  set local role authenticated;
  v_result:=public.update_my_git_identity_details(v_git,null,'yuxuan_xue',null);
  reset role;
  perform pg_temp.assert(v_result->'author_name_aliases'=jsonb_build_array(),
    'passing NULL means the same as passing an empty array');

  ----------------------------------------------------------------------------
  -- 2. 触发器把 NULL 收敛成空数组，任何直写路径都碰不到 NOT NULL
  ----------------------------------------------------------------------------
  update public.developer_git_identity set author_name_aliases=null where id=v_git
  returning author_name_aliases into v_aliases;
  perform pg_temp.assert(v_aliases=array[]::text[],'a direct NULL write is coerced, not rejected');

  ----------------------------------------------------------------------------
  -- 3. 清洗与上限仍然生效（这次修复没有顺手放宽边界）
  ----------------------------------------------------------------------------
  perform set_config('request.jwt.claims',json_build_object(
    'sub',v_owner::text,'role','authenticated')::text,true);
  set local role authenticated;
  v_result:=public.update_my_git_identity_details(
    v_git,array['  薛宇轩 ','薛宇轩','','yuxuan_xue'],'yuxuan_xue',null);
  reset role;
  perform pg_temp.assert(
    v_result->'author_name_aliases'=jsonb_build_array('yuxuan_xue','薛宇轩'),
    'trim / de-duplicate / drop blanks still happen, in a stable order');
  perform set_config('request.jwt.claims',json_build_object(
    'sub',v_owner::text,'role','authenticated')::text,true);
  set local role authenticated;
  begin
    perform public.update_my_git_identity_details(v_git,array[repeat('n',65)],null,null);
    perform pg_temp.assert(false,'an over-long alias must still be rejected');
  exception when others then
    get stacked diagnostics v_error=message_text;
    perform pg_temp.assert(v_error='GIT_IDENTITY_ALIAS_INVALID','the table-level rule reports it');
  end;
  begin
    perform public.update_my_git_identity_details(
      v_git,array['1','2','3','4','5','6','7','8','9','10','11'],null,null);
    perform pg_temp.assert(false,'more than ten aliases must still be rejected');
  exception when others then
    get stacked diagnostics v_error=message_text;
    perform pg_temp.assert(v_error='AUTHOR_ALIAS_LIMIT_EXCEEDED','the cap still applies');
  end;
  reset role;

  ----------------------------------------------------------------------------
  -- 4. 纯别名行仍然不能被清成"什么都匹配不到"
  ----------------------------------------------------------------------------
  insert into public.developer_git_identity(
    developer_identity_id,provider,author_name_aliases,verification_status)
  values(v_dev,'git',array['只有别名'],'UNVERIFIED') returning id into v_alias_only;
  perform set_config('request.jwt.claims',json_build_object(
    'sub',v_owner::text,'role','authenticated')::text,true);
  set local role authenticated;
  begin
    perform public.update_my_git_identity_details(v_alias_only,array[]::text[],null,null);
    perform pg_temp.assert(false,'an alias-only row must not be emptied');
  exception when others then
    get stacked diagnostics v_error=message_text;
    perform pg_temp.assert(v_error='GIT_IDENTITY_WOULD_MATCH_NOTHING',
      'the empty array does not sneak past that guard');
  end;
  -- 但保留 GitLab 用户名就可以清别名：那行还有东西可匹配
  v_result:=public.update_my_git_identity_details(v_alias_only,array[]::text[],'yuxuan_xue',null);
  reset role;
  perform pg_temp.assert(v_result->'author_name_aliases'=jsonb_build_array(),
    'clearing aliases is allowed once another matchable field remains');
end;
$test$;

rollback;
