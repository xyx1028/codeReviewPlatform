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
  v_member uuid:='04531300-1000-4000-a000-000000000001';
  v_error text;
begin
  insert into auth.users(id,email) values (v_member,'v113-revoke@example.invalid')
  on conflict(id) do nothing;
  insert into public.user_profile(id,role,display_name)
  values (v_member,'REVIEWER','V1.13 普通成员')
  on conflict(id) do update set role=excluded.role,display_name=excluded.display_name;

  ----------------------------------------------------------------------------
  -- 1. 手输邮箱这条路对普通成员已经关闭（权限层面，不是靠前端隐藏）
  ----------------------------------------------------------------------------
  perform pg_temp.assert(
    not has_function_privilege('authenticated',
      'public.upsert_my_git_identity_from_email(uuid,text,text,text,text[],text,text,integer)',
      'EXECUTE'),
    'authenticated can no longer self-declare a Git email');
  perform pg_temp.assert(
    not has_function_privilege('anon',
      'public.upsert_my_git_identity_from_email(uuid,text,text,text,text[],text,text,integer)',
      'EXECUTE'),
    'anon stays locked out');
  perform pg_temp.assert(
    has_function_privilege('service_role',
      'public.upsert_my_git_identity_from_email(uuid,text,text,text,text[],text,text,integer)',
      'EXECUTE'),
    'service_role keeps the function for operational use');

  perform set_config('request.jwt.claims',json_build_object(
    'sub',v_member::text,'role','authenticated')::text,true);
  set local role authenticated;
  begin
    perform public.upsert_my_git_identity_from_email(
      null,'普通成员',null,'typed@example.invalid',array[]::text[],null,null,null);
    perform pg_temp.assert(false,'a member must not be able to call the manual path');
  exception when insufficient_privilege then
    null;  -- 期望的结果：权限不足
  when others then
    get stacked diagnostics v_error=message_text;
    perform pg_temp.assert(v_error ilike '%permission denied%',
      'the manual path fails with a permission error, not a business error');
  end;
  reset role;

  ----------------------------------------------------------------------------
  -- 2. 反查这条路不受影响
  ----------------------------------------------------------------------------
  perform pg_temp.assert(
    has_function_privilege('authenticated','public.enqueue_my_git_email_discovery(text,integer)','EXECUTE')
    and has_function_privilege('authenticated','public.get_my_git_email_discovery(uuid)','EXECUTE')
    and has_function_privilege('authenticated',
      'public.upsert_my_git_identity_from_candidate(uuid,text,text,text[],text,text,uuid,integer)','EXECUTE'),
    'the GitLab-verified path stays open to members');

  ----------------------------------------------------------------------------
  -- 3. 管理员代录入口仍在（新人还没提过 MR 时的唯一兜底）
  ----------------------------------------------------------------------------
  perform pg_temp.assert(
    has_function_privilege('authenticated',
      'public.admin_upsert_developer_git_identity_from_email(uuid,uuid,text,text,text,text[],text,text,text,text,integer)',
      'EXECUTE'),
    'administrators can still enter an email on behalf of someone (ensure_admin is the boundary)');
end;
$test$;

rollback;
