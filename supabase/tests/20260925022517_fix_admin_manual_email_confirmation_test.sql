-- 回归：admin_confirm_user_email 的 UPDATE 必须限定 auth.users.id，不能与返回 OUT 列 id 冲突。

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

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, created_at, updated_at
) values
  ('22222222-bbbb-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'email-fix-admin@test.local', 'x', now(), now()),
  ('22222222-bbbb-0000-0000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'email-fix-target@test.local', 'x', now(), now());

update public.user_profile
set role = 'ADMIN'
where id = '22222222-bbbb-0000-0000-000000000001';

select set_config(
  'request.jwt.claims',
  json_build_object('sub', '22222222-bbbb-0000-0000-000000000001', 'role', 'authenticated')::text,
  true
);
select set_config('role', 'authenticated', true);

do $test$
declare v_result record;
begin
  select * into v_result
  from public.admin_confirm_user_email('22222222-bbbb-0000-0000-000000000002'::uuid);
  perform pg_temp.assert(v_result.email_confirmed_at is not null,
    'the fixed RPC must return a non-null confirmation timestamp');
end;
$test$;

select set_config('role', 'postgres', true);
select pg_temp.assert(
  (select email_confirmed_at is not null from auth.users where id = '22222222-bbbb-0000-0000-000000000002') is true,
  'the fixed RPC must update auth.users.email_confirmed_at'
);

rollback;
