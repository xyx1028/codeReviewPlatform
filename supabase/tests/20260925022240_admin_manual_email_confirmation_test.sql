-- V1.24 管理员手动确认待验证邮箱。
-- 整份测试在 rollback 内执行，不保留任何用户或审计数据。

\set ON_ERROR_STOP on
\timing off
\set QUIET on

begin;
set local client_min_messages = warning;

create or replace function pg_temp.assert(p_cond boolean, p_msg text)
returns void language plpgsql as $$
begin
  if p_cond is null or not p_cond then
    raise exception 'ASSERT FAILED: %', p_msg;
  end if;
end;
$$;

create or replace function pg_temp.act_as(p_user_id uuid)
returns void language plpgsql as $$
begin
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', p_user_id::text, 'role', 'authenticated')::text,
    true
  );
  perform set_config('role', 'authenticated', true);
end;
$$;

create or replace function pg_temp.act_as_postgres()
returns void language plpgsql as $$
begin
  perform set_config('role', 'postgres', true);
end;
$$;

create or replace function pg_temp.confirm_as(p_actor uuid, p_target uuid)
returns void language plpgsql as $$
begin
  perform pg_temp.act_as(p_actor);
  perform public.admin_confirm_user_email(p_target);
  perform pg_temp.act_as_postgres();
end;
$$;

create or replace function pg_temp.confirm_error(p_actor uuid, p_target uuid)
returns text language plpgsql as $$
declare v_message text;
begin
  perform pg_temp.act_as(p_actor);
  begin
    perform public.admin_confirm_user_email(p_target);
    v_message := '(no error)';
  exception when others then
    v_message := sqlerrm;
  end;
  perform pg_temp.act_as_postgres();
  return v_message;
end;
$$;

-- auth.users 的注册触发器会自动建 user_profile，夹具保持与生产注册链路一致。
insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, created_at, updated_at
) values
  ('22222222-aaaa-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'email-admin@test.local', 'x', now(), now()),
  ('22222222-aaaa-0000-0000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'email-viewer@test.local', 'x', now(), now()),
  ('22222222-aaaa-0000-0000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'email-pending@test.local', 'x', now(), now()),
  ('22222222-aaaa-0000-0000-000000000004', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'email-confirmed@test.local', 'x', now(), now());

update auth.users
set email_confirmed_at = now()
where id = '22222222-aaaa-0000-0000-000000000004';

update public.user_profile
set role = case id
  when '22222222-aaaa-0000-0000-000000000001'::uuid then 'ADMIN'
  when '22222222-aaaa-0000-0000-000000000002'::uuid then 'VIEWER'
  else 'REVIEWER'
end,
display_name = split_part((select email from auth.users where auth.users.id = user_profile.id), '@', 1)
where id in (
  '22222222-aaaa-0000-0000-000000000001',
  '22222222-aaaa-0000-0000-000000000002',
  '22222222-aaaa-0000-0000-000000000003',
  '22222222-aaaa-0000-0000-000000000004'
);

-- ADMIN 能确认待验证账号，状态和审计都由数据库生成。
do $test$
declare v_result record;
begin
  perform pg_temp.act_as('22222222-aaaa-0000-0000-000000000001'::uuid);
  select * into v_result from public.admin_confirm_user_email('22222222-aaaa-0000-0000-000000000003'::uuid);
  perform pg_temp.act_as_postgres();

  perform pg_temp.assert(v_result.email = 'email-pending@test.local', 'RPC must return the confirmed user');
  perform pg_temp.assert(v_result.email_confirmed_at is not null, 'RPC result must expose a confirmation timestamp');
  perform pg_temp.assert(
    (select email_confirmed_at is not null from auth.users where id = '22222222-aaaa-0000-0000-000000000003') is true,
    'auth.users.email_confirmed_at must be written');
  perform pg_temp.assert(
    (select count(*) from public.admin_email_verification_audit
      where confirmed_user_id = '22222222-aaaa-0000-0000-000000000003'
        and confirmed_by = '22222222-aaaa-0000-0000-000000000001') = 1,
    'a successful confirmation must leave one actor-and-target audit record');
end;
$test$;

-- 已验证账号不能重复确认，也不能制造第二条审计。
do $test$
begin
  perform pg_temp.assert(
    pg_temp.confirm_error(
      '22222222-aaaa-0000-0000-000000000001'::uuid,
      '22222222-aaaa-0000-0000-000000000003'::uuid
    ) like '%EMAIL_ALREADY_CONFIRMED%',
    'a second confirmation must be refused');
  perform pg_temp.assert(
    (select count(*) from public.admin_email_verification_audit
      where confirmed_user_id = '22222222-aaaa-0000-0000-000000000003') = 1,
    'a refused repeat must not add an audit row');
  perform pg_temp.assert(
    pg_temp.confirm_error(
      '22222222-aaaa-0000-0000-000000000001'::uuid,
      '22222222-aaaa-0000-0000-000000000004'::uuid
    ) like '%EMAIL_ALREADY_CONFIRMED%',
    'a pre-confirmed user must be refused');
end;
$test$;

-- 非管理员与不存在账号都必须被拒绝。
do $test$
begin
  perform pg_temp.assert(
    pg_temp.confirm_error(
      '22222222-aaaa-0000-0000-000000000002'::uuid,
      '22222222-aaaa-0000-0000-000000000004'::uuid
    ) like '%ADMIN role required%',
    'a non-admin must not confirm an email');
  perform pg_temp.assert(
    pg_temp.confirm_error(
      '22222222-aaaa-0000-0000-000000000001'::uuid,
      '99999999-9999-9999-9999-999999999999'::uuid
    ) like '%USER_NOT_FOUND%',
    'an unknown user must be refused');
end;
$test$;

-- 授权：anon 不可调用；authenticated 可到达 RPC，但实际 ADMIN 判定在函数内部。
do $test$
begin
  perform pg_temp.act_as_postgres();
  perform pg_temp.assert(
    not has_function_privilege('anon', 'public.admin_confirm_user_email(uuid)', 'execute'),
    'anon must not execute admin_confirm_user_email');
  perform pg_temp.assert(
    has_function_privilege('authenticated', 'public.admin_confirm_user_email(uuid)', 'execute'),
    'authenticated must be able to enter the RPC so ensure_admin can enforce the role');
  perform pg_temp.assert(
    not has_table_privilege('authenticated', 'public.admin_email_verification_audit', 'insert'),
    'clients must not forge email-confirmation audit records');
end;
$test$;

rollback;
