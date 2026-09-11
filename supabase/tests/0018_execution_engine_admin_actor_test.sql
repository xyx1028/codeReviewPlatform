-- 0018_execution_engine_admin_actor_test.sql
-- 0001..0020 最终 schema 下的显式 actor 与已移除引擎管理入口测试。
-- 以库属主执行；整个脚本在单事务中运行并最终 ROLLBACK。
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

create or replace function pg_temp.assert_raises(p_sql text, p_contains text, p_msg text)
returns void language plpgsql as $$
declare
  v_error text;
begin
  begin
    execute p_sql;
  exception when others then
    v_error := sqlerrm;
    if p_contains is not null and position(p_contains in v_error) = 0 then
      raise exception 'ASSERT FAILED: % -- expected error containing "%", got "%"',
        p_msg, p_contains, v_error;
    end if;
    return;
  end;
  raise exception 'ASSERT FAILED: % -- expected an exception', p_msg;
end;
$$;

do $test$
declare
  v_admin uuid := '18000000-0000-4000-a000-0000000000a1';
  v_reviewer uuid := '18000000-0000-4000-a000-0000000000a2';
  v_model uuid := '18000000-0000-4000-b000-0000000000b1';
  v_secret uuid := '18000000-0000-4000-c000-0000000000c1';
  v_missing uuid := '18000000-0000-4000-b000-00000000beef';
  v_read uuid;
  v_count integer;
begin
  -- Edge Functions call actor-based model RPCs with service_role and no user JWT.
  perform set_config('request.jwt.claims', '', true);

  insert into auth.users (id, email) values
    (v_admin, 'admin_18_final_test@example.com'),
    (v_reviewer, 'reviewer_18_final_test@example.com')
  on conflict (id) do nothing;

  insert into public.user_profile (id, role) values
    (v_admin, 'ADMIN'),
    (v_reviewer, 'REVIEWER')
  on conflict (id) do update set role = excluded.role;

  insert into public.ai_model_config (
    id, display_name, base_url, model_name, api_key_secret_id,
    enabled, created_by
  ) values (
    v_model, 'Model 18 final', 'https://model-18.example.com',
    'model-18', v_secret, true, v_admin
  );

  select count(*) into v_count
  from pg_proc proc
  join pg_namespace namespace on namespace.oid = proc.pronamespace
  where namespace.nspname = 'public'
    and proc.proname = 'admin_set_model_execution_engine';
  perform pg_temp.assert(
    v_count = 0,
    'all admin_set_model_execution_engine overloads are removed'
  );

  perform pg_temp.assert(
    to_regprocedure('public.admin_get_model_secret_id(uuid)') is null,
    'actor-less secret-id getter is absent'
  );
  perform pg_temp.assert(
    to_regprocedure('public.admin_get_model_secret_id(uuid,uuid)') is not null,
    'explicit-actor secret-id getter remains available'
  );

  set local role service_role;
  select public.admin_get_model_secret_id(v_admin, v_model) into v_read;
  reset role;
  perform pg_temp.assert(
    v_read = v_secret,
    'ADMIN actor works with service_role even when auth.uid() is null'
  );

  perform pg_temp.assert_raises(
    format(
      'select public.admin_get_model_secret_id(%L,%L)',
      v_reviewer, v_model
    ),
    'ADMIN role required',
    'non-admin actor cannot read a model secret reference'
  );
  perform pg_temp.assert_raises(
    format(
      'select public.admin_get_model_secret_id(NULL::uuid,%L)',
      v_model
    ),
    'actor_id is required',
    'null actor is rejected explicitly'
  );
  perform pg_temp.assert_raises(
    format(
      'select public.admin_get_model_secret_id(%L,%L)',
      v_admin, v_missing
    ),
    'model config not found',
    'missing model config is reported'
  );

  perform pg_temp.assert(
    has_function_privilege(
      'service_role',
      'public.admin_get_model_secret_id(uuid,uuid)',
      'EXECUTE'
    ),
    'service_role can execute the actor-based getter'
  );
  perform pg_temp.assert(
    not has_function_privilege(
      'authenticated',
      'public.admin_get_model_secret_id(uuid,uuid)',
      'EXECUTE'
    )
      and not has_function_privilege(
        'anon',
        'public.admin_get_model_secret_id(uuid,uuid)',
        'EXECUTE'
      ),
    'browser roles cannot execute the actor-based getter'
  );
end;
$test$;

select 'ALL_EXECUTION_ENGINE_ACTOR_TESTS_PASSED' as result;
rollback;
