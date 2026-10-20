-- V1.65 管理员代重置用户密码。
-- 整份测试在 rollback 内执行，不保留任何用户、会话或审计数据。

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

create or replace function pg_temp.reset_error(p_actor uuid, p_target uuid, p_password text)
returns text language plpgsql as $$
declare v_message text;
begin
  perform pg_temp.act_as(p_actor);
  begin
    perform public.admin_reset_user_password(p_target, p_password);
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
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at
) values
  ('33333333-bbbb-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'pw-admin@test.local', extensions.crypt('admin-original', extensions.gen_salt('bf')), now(), now(), now()),
  ('33333333-bbbb-0000-0000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'pw-viewer@test.local', extensions.crypt('viewer-original', extensions.gen_salt('bf')), now(), now(), now()),
  ('33333333-bbbb-0000-0000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'pw-target@test.local', extensions.crypt('target-original', extensions.gen_salt('bf')), now(), now(), now()),
  ('33333333-bbbb-0000-0000-000000000004', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'pw-pending@test.local', extensions.crypt('pending-original', extensions.gen_salt('bf')), null, now(), now()),
  ('33333333-bbbb-0000-0000-000000000005', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'openid-x@wechat.invalid', extensions.crypt('wechat-original', extensions.gen_salt('bf')), now(), now(), now());

update public.user_profile
set role = case id
  when '33333333-bbbb-0000-0000-000000000001'::uuid then 'ADMIN'
  when '33333333-bbbb-0000-0000-000000000002'::uuid then 'VIEWER'
  else 'REVIEWER'
end,
display_name = split_part((select email from auth.users where auth.users.id = user_profile.id), '@', 1)
where id in (
  '33333333-bbbb-0000-0000-000000000001',
  '33333333-bbbb-0000-0000-000000000002',
  '33333333-bbbb-0000-0000-000000000003',
  '33333333-bbbb-0000-0000-000000000004',
  '33333333-bbbb-0000-0000-000000000005'
);

-- 目标账号先有两条登录态：一条带 session 的 refresh token，一条历史遗留（session_id 为空）。
insert into auth.sessions (id, user_id, created_at, updated_at)
values
  ('33333333-cccc-0000-0000-000000000001', '33333333-bbbb-0000-0000-000000000003', now(), now()),
  ('33333333-cccc-0000-0000-000000000002', '33333333-bbbb-0000-0000-000000000003', now(), now());

insert into auth.refresh_tokens (instance_id, token, user_id, revoked, created_at, updated_at, session_id)
values
  ('00000000-0000-0000-0000-000000000000', 'pw-token-with-session', '33333333-bbbb-0000-0000-000000000003', false, now(), now(), '33333333-cccc-0000-0000-000000000001'),
  ('00000000-0000-0000-0000-000000000000', 'pw-token-legacy', '33333333-bbbb-0000-0000-000000000003', false, now(), now(), null);

-- ADMIN 能重置他人密码：哈希换新、全部登录态清空、审计落一行、明文不进审计。
do $test$
declare
  v_result record;
  v_old_hash text;
begin
  select encrypted_password into v_old_hash from auth.users where id = '33333333-bbbb-0000-0000-000000000003';

  perform pg_temp.act_as('33333333-bbbb-0000-0000-000000000001'::uuid);
  select * into v_result
  from public.admin_reset_user_password('33333333-bbbb-0000-0000-000000000003'::uuid, 'Temp-Pass-9xQ');
  perform pg_temp.act_as_postgres();

  perform pg_temp.assert(v_result.email = 'pw-target@test.local', 'RPC must return the target account');
  perform pg_temp.assert(v_result.reset_self is false, 'resetting someone else must report reset_self = false');
  perform pg_temp.assert(v_result.sessions_revoked = 2, 'both sessions must be reported as revoked');
  perform pg_temp.assert(v_result.email_confirmed_at is not null, 'RPC must expose the mailbox state so the UI can warn');

  perform pg_temp.assert(
    (select encrypted_password from auth.users where id = '33333333-bbbb-0000-0000-000000000003') <> v_old_hash,
    'the stored password hash must change');
  perform pg_temp.assert(
    (select encrypted_password = extensions.crypt('Temp-Pass-9xQ', encrypted_password)
       from auth.users where id = '33333333-bbbb-0000-0000-000000000003'),
    'the new hash must verify against the password the admin set');
  -- GoTrue 自己写密码用 bcrypt cost 10；这里必须一致，否则平台里会混进一批更弱的哈希。
  perform pg_temp.assert(
    (select encrypted_password like '$2a$10$%' from auth.users where id = '33333333-bbbb-0000-0000-000000000003'),
    'the hash must be bcrypt with cost 10, matching what GoTrue writes');
  perform pg_temp.assert(
    (select encrypted_password <> 'Temp-Pass-9xQ'
       from auth.users where id = '33333333-bbbb-0000-0000-000000000003'),
    'the password must never be stored in clear text');

  perform pg_temp.assert(
    (select count(*) from auth.sessions where user_id = '33333333-bbbb-0000-0000-000000000003') = 0,
    'all sessions of the target account must be deleted');
  perform pg_temp.assert(
    (select count(*) from auth.refresh_tokens
      where user_id = '33333333-bbbb-0000-0000-000000000003' and revoked is not true) = 0,
    'no usable refresh token may survive, including legacy rows without a session');

  perform pg_temp.assert(
    (select count(*) from public.admin_password_reset_audit
      where reset_user_id = '33333333-bbbb-0000-0000-000000000003'
        and reset_by = '33333333-bbbb-0000-0000-000000000001'
        and sessions_revoked = 2) = 1,
    'a successful reset must leave exactly one actor-and-target audit row');
end;
$test$;

-- 管理员重置自己的密码：允许，但必须如实告诉前端这是自己（前端要据此登出）。
do $test$
declare v_result record;
begin
  perform pg_temp.act_as('33333333-bbbb-0000-0000-000000000001'::uuid);
  select * into v_result
  from public.admin_reset_user_password('33333333-bbbb-0000-0000-000000000001'::uuid, 'Self-Reset-7kM');
  perform pg_temp.act_as_postgres();

  perform pg_temp.assert(v_result.reset_self is true, 'resetting your own account must report reset_self = true');
  perform pg_temp.assert(
    (select encrypted_password = extensions.crypt('Self-Reset-7kM', encrypted_password)
       from auth.users where id = '33333333-bbbb-0000-0000-000000000001'),
    'self reset must also write the new hash');
end;
$test$;

-- 未验证邮箱的账号照常重置，但 RPC 必须把邮箱状态暴露出来，不替管理员偷偷标记已验证。
do $test$
declare v_result record;
begin
  perform pg_temp.act_as('33333333-bbbb-0000-0000-000000000001'::uuid);
  select * into v_result
  from public.admin_reset_user_password('33333333-bbbb-0000-0000-000000000004'::uuid, 'Pending-Pass-3n');
  perform pg_temp.act_as_postgres();

  perform pg_temp.assert(v_result.email_confirmed_at is null, 'an unconfirmed mailbox must stay unconfirmed');
  perform pg_temp.assert(
    (select email_confirmed_at is null from auth.users where id = '33333333-bbbb-0000-0000-000000000004'),
    'resetting a password must not silently confirm the mailbox');
end;
$test$;

-- 密码规则、未知账号、微信-only 账号、非管理员：全部拒绝，且不留审计。
do $test$
declare v_audit_before integer;
begin
  select count(*) into v_audit_before from public.admin_password_reset_audit;

  perform pg_temp.assert(
    pg_temp.reset_error('33333333-bbbb-0000-0000-000000000001'::uuid, '33333333-bbbb-0000-0000-000000000003'::uuid, '')
      like '%PASSWORD_REQUIRED%',
    'an empty password must be refused');
  perform pg_temp.assert(
    pg_temp.reset_error('33333333-bbbb-0000-0000-000000000001'::uuid, '33333333-bbbb-0000-0000-000000000003'::uuid, 'Short1!')
      like '%PASSWORD_TOO_SHORT%',
    'a password shorter than 8 characters must be refused');
  perform pg_temp.assert(
    pg_temp.reset_error('33333333-bbbb-0000-0000-000000000001'::uuid, '33333333-bbbb-0000-0000-000000000003'::uuid, ' Temp-Pass-9xQ ')
      like '%PASSWORD_HAS_EDGE_SPACE%',
    'leading or trailing spaces must be refused, they get lost when handing the password over');
  perform pg_temp.assert(
    pg_temp.reset_error('33333333-bbbb-0000-0000-000000000001'::uuid, '33333333-bbbb-0000-0000-000000000003'::uuid, repeat('a', 73))
      like '%PASSWORD_TOO_LONG%',
    'bcrypt silently truncates beyond 72 bytes, so it must be refused instead');
  perform pg_temp.assert(
    pg_temp.reset_error('33333333-bbbb-0000-0000-000000000001'::uuid, '99999999-9999-9999-9999-999999999999'::uuid, 'Temp-Pass-9xQ')
      like '%USER_NOT_FOUND%',
    'an unknown account must be refused');
  perform pg_temp.assert(
    pg_temp.reset_error('33333333-bbbb-0000-0000-000000000001'::uuid, '33333333-bbbb-0000-0000-000000000005'::uuid, 'Temp-Pass-9xQ')
      like '%WECHAT_ONLY_ACCOUNT%',
    'a WeChat-only account has no email login, so it must be refused');
  perform pg_temp.assert(
    pg_temp.reset_error('33333333-bbbb-0000-0000-000000000002'::uuid, '33333333-bbbb-0000-0000-000000000003'::uuid, 'Temp-Pass-9xQ')
      like '%ADMIN role required%',
    'a non-admin must not reset anybody password');

  perform pg_temp.assert(
    (select count(*) from public.admin_password_reset_audit) = v_audit_before,
    'refused attempts must not add audit rows');
  perform pg_temp.assert(
    (select encrypted_password = extensions.crypt('wechat-original', encrypted_password)
       from auth.users where id = '33333333-bbbb-0000-0000-000000000005'),
    'a refused reset must leave the stored hash untouched');
end;
$test$;

-- 授权：anon 不可调用；authenticated 可到达 RPC，ADMIN 判定在函数内部；审计不可被客户端伪造。
do $test$
begin
  perform pg_temp.act_as_postgres();
  perform pg_temp.assert(
    not has_function_privilege('anon', 'public.admin_reset_user_password(uuid, text)', 'execute'),
    'anon must not execute admin_reset_user_password');
  perform pg_temp.assert(
    has_function_privilege('authenticated', 'public.admin_reset_user_password(uuid, text)', 'execute'),
    'authenticated must be able to enter the RPC so ensure_admin can enforce the role');
  perform pg_temp.assert(
    not has_table_privilege('authenticated', 'public.admin_password_reset_audit', 'insert'),
    'clients must not forge password-reset audit records');
  perform pg_temp.assert(
    not has_table_privilege('anon', 'public.admin_password_reset_audit', 'select'),
    'anon must not read password-reset audit records');
  -- 只应存在一个重载，否则会留下一条不带校验的旧调用路径。
  perform pg_temp.assert(
    (select count(*) from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'admin_reset_user_password') = 1,
    'exactly one admin_reset_user_password overload must exist');
end;
$test$;

rollback;
