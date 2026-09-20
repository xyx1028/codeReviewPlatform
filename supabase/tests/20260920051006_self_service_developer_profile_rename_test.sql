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

-- 20260920052256 起这个函数只剩 service_role 能调：成员改名统一走
-- update_my_identity_profile（它会同时写 user_profile 与 developer_identity，避免两者漂移）。
-- 这份测试继续守住它的**业务语义**，所以调用时不再切到 authenticated 角色；
-- auth.uid() 仍由 request.jwt.claims 决定，越权断言照旧有效。
do $test$
declare
  v_owner uuid:='05100600-1000-4000-a000-000000000001';
  v_other uuid:='05100600-1000-4000-a000-000000000002';
  v_developer uuid;
  v_other_developer uuid;
  v_result jsonb;
  v_error text;
begin
  insert into auth.users(id,email) values
    (v_owner,'v113-rename-owner@example.invalid'),
    (v_other,'v113-rename-other@example.invalid')
  on conflict(id) do nothing;
  insert into public.user_profile(id,role,display_name) values
    (v_owner,'REVIEWER','V1.13 改名的人'),
    (v_other,'REVIEWER','V1.13 另一个人')
  on conflict(id) do update set role=excluded.role,display_name=excluded.display_name;

  ----------------------------------------------------------------------------
  -- 1. 还没有身份行时明确拒绝：身份只能由"绑定已验证邮箱"创建
  ----------------------------------------------------------------------------
  perform set_config('request.jwt.claims',json_build_object(
    'sub',v_owner::text,'role','authenticated')::text,true);
  begin
    perform public.update_my_developer_profile('薛宇轩','69171');
    perform pg_temp.assert(false,'renaming without an identity row must fail');
  exception when others then
    get stacked diagnostics v_error=message_text;
    perform pg_temp.assert(v_error='DEVELOPER_IDENTITY_NOT_FOUND',
      'renaming before binding an email returns a stable code');
  end;
  reset role;

  insert into public.developer_identity(display_name,employee_code,status,auth_user_id)
  values('17751361028',null,'VERIFIED',v_owner) returning id into v_developer;
  insert into public.developer_identity(display_name,employee_code,status,auth_user_id)
  values('别人','E-OTHER','VERIFIED',v_other) returning id into v_other_developer;

  ----------------------------------------------------------------------------
  -- 2. 只改姓名/员工号，不需要碰邮箱
  ----------------------------------------------------------------------------
  perform set_config('request.jwt.claims',json_build_object(
    'sub',v_owner::text,'role','authenticated')::text,true);
  v_result:=public.update_my_developer_profile('薛宇轩','69171');
  reset role;
  perform pg_temp.assert(v_result->>'display_name'='薛宇轩'
    and v_result->>'employee_code'='69171'
    and (v_result->>'revision')::integer=2,
    'the caller can rename their own developer identity');
  perform pg_temp.assert(
    (select display_name='薛宇轩' and employee_code='69171' and status='VERIFIED'
     from public.developer_identity where id=v_developer),
    'the rename lands on the row and keeps the verified status');
  perform pg_temp.assert(exists(
    select 1 from public.analysis_scope_decision_audit
    where actor_id=v_owner and 'SELF_IDENTITY_RENAMED'=any(reason_codes)
      and before_state->>'display_name'='17751361028'
      and after_state->>'display_name'='薛宇轩'),
    'the rename is audited with the old and new name');

  ----------------------------------------------------------------------------
  -- 3. 空姓名、超长姓名、员工号冲突都明确拒绝
  ----------------------------------------------------------------------------
  perform set_config('request.jwt.claims',json_build_object(
    'sub',v_owner::text,'role','authenticated')::text,true);
  begin
    perform public.update_my_developer_profile('   ',null);
    perform pg_temp.assert(false,'an empty name must be rejected');
  exception when others then
    get stacked diagnostics v_error=message_text;
    perform pg_temp.assert(v_error='DEVELOPER_DISPLAY_NAME_REQUIRED','empty name returns a stable code');
  end;
  begin
    perform public.update_my_developer_profile(repeat('名',65),null);
    perform pg_temp.assert(false,'an over-long name must be rejected');
  exception when others then
    get stacked diagnostics v_error=message_text;
    perform pg_temp.assert(v_error='DEVELOPER_DISPLAY_NAME_TOO_LONG','over-long name returns a stable code');
  end;
  begin
    perform public.update_my_developer_profile('薛宇轩','e-other');
    perform pg_temp.assert(false,'taking another developer employee code must be rejected');
  exception when others then
    get stacked diagnostics v_error=message_text;
    perform pg_temp.assert(v_error='DEVELOPER_EMPLOYEE_CODE_CONFLICT',
      'employee code conflict is case-insensitive and returns a stable code');
  end;

  ----------------------------------------------------------------------------
  -- 4. 改不到别人身上：函数只认 auth.uid()，没有"改哪一行"的参数
  ----------------------------------------------------------------------------
  perform set_config('request.jwt.claims',json_build_object(
    'sub',v_other::text,'role','authenticated')::text,true);
  perform public.update_my_developer_profile('另一个人改了自己',null);
  perform pg_temp.assert(
    (select display_name='薛宇轩' from public.developer_identity where id=v_developer)
    and (select display_name='另一个人改了自己' from public.developer_identity where id=v_other_developer),
    'each account only ever renames its own identity');

  ----------------------------------------------------------------------------
  -- 5. 身份被标 CONFLICT / DISABLED 时交给管理员，不让本人自己改
  ----------------------------------------------------------------------------
  update public.developer_identity set status='CONFLICT' where id=v_developer;
  perform set_config('request.jwt.claims',json_build_object(
    'sub',v_owner::text,'role','authenticated')::text,true);
  begin
    perform public.update_my_developer_profile('想绕过冲突',null);
    perform pg_temp.assert(false,'a conflicted identity must not be renamed by its owner');
  exception when others then
    get stacked diagnostics v_error=message_text;
    perform pg_temp.assert(v_error='DEVELOPER_IDENTITY_LOCKED','locked identity returns a stable code');
  end;

  ----------------------------------------------------------------------------
  -- 6. 权限面
  ----------------------------------------------------------------------------
  perform pg_temp.assert(
    not has_function_privilege('authenticated','public.update_my_developer_profile(text,text)','EXECUTE')
    and not has_function_privilege('anon','public.update_my_developer_profile(text,text)','EXECUTE'),
    'since 20260920052256 members go through update_my_identity_profile instead');
  perform pg_temp.assert(
    has_function_privilege('service_role','public.update_my_developer_profile(text,text)','EXECUTE'),
    'service_role keeps it for operational use');
  perform pg_temp.assert(
    has_function_privilege('authenticated','public.update_my_identity_profile(text,text)','EXECUTE'),
    'the single member-facing entry is update_my_identity_profile');
end;
$test$;

rollback;
