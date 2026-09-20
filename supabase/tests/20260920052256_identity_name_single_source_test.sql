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
  v_owner uuid:='05225600-1000-4000-a000-000000000001';
  v_other uuid:='05225600-1000-4000-a000-000000000002';
  v_developer uuid;
  v_result jsonb;
  v_error text;
begin
  insert into auth.users(id,email) values
    (v_owner,'v113-single-owner@example.invalid'),
    (v_other,'v113-single-other@example.invalid')
  on conflict(id) do nothing;
  insert into public.user_profile(id,role,display_name) values
    (v_owner,'REVIEWER','旧用户名'),
    (v_other,'REVIEWER','另一个人')
  on conflict(id) do update set role=excluded.role,display_name=excluded.display_name;

  ----------------------------------------------------------------------------
  -- 1. 还没绑邮箱时：只改账号资料，不创建空的开发人员身份
  ----------------------------------------------------------------------------
  perform set_config('request.jwt.claims',json_build_object(
    'sub',v_owner::text,'role','authenticated')::text,true);
  set local role authenticated;
  v_result:=public.update_my_identity_profile('薛宇轩','69171');
  reset role;
  perform pg_temp.assert(v_result->'profile'->>'display_name'='薛宇轩'
    and v_result->>'developer_id' is null,
    'without an identity row only the account profile changes');
  perform pg_temp.assert(
    (select display_name='薛宇轩' from public.user_profile where id=v_owner),
    'the account display name is updated');
  perform pg_temp.assert(
    not exists(select 1 from public.developer_identity where auth_user_id=v_owner),
    'no empty developer identity is created as a side effect');

  ----------------------------------------------------------------------------
  -- 2. 绑过邮箱之后：同一次保存把姓名与员工号同步进开发人员身份
  ----------------------------------------------------------------------------
  insert into public.developer_identity(display_name,employee_code,status,auth_user_id)
  values('薛宇轩','69171','VERIFIED',v_owner) returning id into v_developer;

  perform set_config('request.jwt.claims',json_build_object(
    'sub',v_owner::text,'role','authenticated')::text,true);
  set local role authenticated;
  v_result:=public.update_my_identity_profile('薛某某','E-69171');
  reset role;
  perform pg_temp.assert((v_result->>'developer_id')::uuid=v_developer
    and v_result->>'employee_code'='E-69171',
    'the identity is mirrored in the same call');
  perform pg_temp.assert(
    (select display_name='薛某某' and employee_code='E-69171'
     from public.developer_identity where id=v_developer)
    and (select display_name='薛某某' from public.user_profile where id=v_owner),
    'account profile and developer identity can no longer drift apart');
  perform pg_temp.assert(exists(
    select 1 from public.analysis_scope_decision_audit
    where actor_id=v_owner and 'SELF_IDENTITY_RENAMED'=any(reason_codes)
      and before_state->>'display_name'='薛宇轩'
      and after_state->>'display_name'='薛某某'),
    'the mirrored rename is audited with before/after');

  ----------------------------------------------------------------------------
  -- 3. 校验与冲突
  ----------------------------------------------------------------------------
  insert into public.developer_identity(display_name,employee_code,status,auth_user_id)
  values('另一个人','E-OTHER','VERIFIED',v_other);

  perform set_config('request.jwt.claims',json_build_object(
    'sub',v_owner::text,'role','authenticated')::text,true);
  set local role authenticated;
  begin
    perform public.update_my_identity_profile('  ',null);
    perform pg_temp.assert(false,'an empty name must be rejected');
  exception when others then
    get stacked diagnostics v_error=message_text;
    perform pg_temp.assert(v_error='DEVELOPER_DISPLAY_NAME_REQUIRED','empty name returns a stable code');
  end;
  begin
    perform public.update_my_identity_profile(repeat('名',33),null);
    perform pg_temp.assert(false,'a name over 32 characters must be rejected');
  exception when others then
    get stacked diagnostics v_error=message_text;
    perform pg_temp.assert(v_error='DEVELOPER_DISPLAY_NAME_TOO_LONG','over-long name returns a stable code');
  end;
  begin
    perform public.update_my_identity_profile('薛某某','e-other');
    perform pg_temp.assert(false,'taking another employee code must be rejected');
  exception when others then
    get stacked diagnostics v_error=message_text;
    perform pg_temp.assert(v_error='DEVELOPER_EMPLOYEE_CODE_CONFLICT',
      'employee code conflict is case-insensitive');
  end;
  reset role;
  -- 冲突被拒时整个操作回滚，用户名不能被改掉一半
  perform pg_temp.assert(
    (select display_name='薛某某' from public.user_profile where id=v_owner),
    'a rejected save leaves nothing half-written');

  ----------------------------------------------------------------------------
  -- 4. 身份被锁时拒绝（交管理员），但这不该影响别人
  ----------------------------------------------------------------------------
  update public.developer_identity set status='CONFLICT' where id=v_developer;
  perform set_config('request.jwt.claims',json_build_object(
    'sub',v_owner::text,'role','authenticated')::text,true);
  set local role authenticated;
  begin
    perform public.update_my_identity_profile('想绕过冲突',null);
    perform pg_temp.assert(false,'a locked identity must not be renamed by its owner');
  exception when others then
    get stacked diagnostics v_error=message_text;
    perform pg_temp.assert(v_error='DEVELOPER_IDENTITY_LOCKED','locked identity returns a stable code');
  end;
  reset role;

  ----------------------------------------------------------------------------
  -- 5. 权限面：成员只有这一个入口，旧的单表入口已收回
  ----------------------------------------------------------------------------
  perform pg_temp.assert(
    has_function_privilege('authenticated','public.update_my_identity_profile(text,text)','EXECUTE'),
    'members may declare who they are');
  perform pg_temp.assert(
    not has_function_privilege('anon','public.update_my_identity_profile(text,text)','EXECUTE'),
    'anon cannot');
  perform pg_temp.assert(
    not has_function_privilege('authenticated','public.update_my_developer_profile(text,text)','EXECUTE'),
    'the old developer-only rename is no longer callable by members');
  perform pg_temp.assert(
    has_function_privilege('service_role','public.update_my_developer_profile(text,text)','EXECUTE'),
    'service_role keeps it for operational use');
end;
$test$;

rollback;
