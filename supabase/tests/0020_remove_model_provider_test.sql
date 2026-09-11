-- 0020_remove_model_provider_test.sql
-- 0001..0020 最终模型 schema、actor RPC 签名、快照与默认预算测试。
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
  v_admin uuid := '20000000-0000-4000-a000-0000000000a1';
  v_reviewer uuid := '20000000-0000-4000-a000-0000000000a2';
  v_secret_1 uuid := '20000000-0000-4000-b000-0000000000b1';
  v_secret_2 uuid := '20000000-0000-4000-b000-0000000000b2';
  v_model uuid;
  v_old_secret uuid;
  v_snapshot jsonb;
  v_list_row jsonb;
  v_count integer;
  v_budget integer;
  v_name text;
  v_create_signature text :=
    'public.admin_create_model_config(uuid,text,text,text,uuid,integer,integer,integer,integer,integer,integer,integer)';
  v_update_signature text :=
    'public.admin_update_model_config(uuid,uuid,text,text,text,uuid,integer,integer,integer,integer,integer,integer,integer)';
  v_snapshot_keys text[] := array[
    'model_config_id',
    'display_name',
    'base_url',
    'model_name',
    'max_parallel_tasks',
    'request_timeout_ms',
    'context_window',
    'max_output_tokens',
    'agent_max_model_requests',
    'agent_max_retry_requests',
    'agent_max_compaction_requests'
  ];
begin
  -- Final model table has neither provider/engine nor legacy prompt columns.
  select count(*) into v_count
  from information_schema.columns
  where table_schema = 'public'
    and table_name = 'ai_model_config'
    and column_name in (
      'provider', 'execution_engine',
      'retrieval_prompt_version', 'analysis_prompt_version'
    );
  perform pg_temp.assert(
    v_count = 0,
    'ai_model_config has no provider, engine or legacy prompt columns'
  );

  perform pg_temp.assert(
    to_regprocedure(v_create_signature) is not null,
    'final provider-free create signature exists'
  );
  perform pg_temp.assert(
    to_regprocedure(v_update_signature) is not null,
    'final provider-free update signature exists'
  );
  perform pg_temp.assert(
    to_regprocedure(
      'public.admin_create_model_config(uuid,text,text,text,text,uuid,integer,integer,integer,integer,integer,integer,integer)'
    ) is null,
    'provider-bearing create signature is absent'
  );
  perform pg_temp.assert(
    to_regprocedure(
      'public.admin_update_model_config(uuid,uuid,text,text,text,text,uuid,integer,integer,integer,integer,integer,integer,integer)'
    ) is null,
    'provider-bearing update signature is absent'
  );

  select count(*) into v_count
  from pg_proc proc
  join pg_namespace namespace on namespace.oid = proc.pronamespace
  where namespace.nspname = 'public'
    and proc.proname = 'admin_create_model_config';
  perform pg_temp.assert(v_count = 1, 'create has exactly one overload');
  select count(*) into v_count
  from pg_proc proc
  join pg_namespace namespace on namespace.oid = proc.pronamespace
  where namespace.nspname = 'public'
    and proc.proname = 'admin_update_model_config';
  perform pg_temp.assert(v_count = 1, 'update has exactly one overload');

  perform pg_temp.assert(
    has_function_privilege('service_role', v_create_signature, 'EXECUTE')
      and has_function_privilege('service_role', v_update_signature, 'EXECUTE'),
    'service_role can call create and update'
  );
  perform pg_temp.assert(
    not has_function_privilege('authenticated', v_create_signature, 'EXECUTE')
      and not has_function_privilege('authenticated', v_update_signature, 'EXECUTE')
      and not has_function_privilege('anon', v_create_signature, 'EXECUTE')
      and not has_function_privilege('anon', v_update_signature, 'EXECUTE'),
    'browser roles cannot call create or update'
  );

  insert into auth.users (id, email) values
    (v_admin, 'admin_20_final_test@example.com'),
    (v_reviewer, 'reviewer_20_final_test@example.com')
  on conflict (id) do nothing;
  insert into public.user_profile (id, role) values
    (v_admin, 'ADMIN'),
    (v_reviewer, 'REVIEWER')
  on conflict (id) do update set role = excluded.role;

  -- Explicit actor validation must work with no request JWT.
  perform set_config('request.jwt.claims', '', true);
  set local role service_role;
  v_model := public.admin_create_model_config(
    v_admin,
    'Model 20 final',
    'https://model-20.example.com',
    'model-20',
    v_secret_1
  );
  reset role;

  perform pg_temp.assert(v_model is not null, 'ADMIN actor creates a model without JWT');
  select display_name, agent_max_model_requests
    into v_name, v_budget
  from public.ai_model_config
  where id = v_model;
  perform pg_temp.assert(v_name = 'Model 20 final', 'created model is persisted');
  perform pg_temp.assert(v_budget = 120, 'new model request budget defaults to 120');

  set local role service_role;
  v_old_secret := public.admin_update_model_config(
    v_admin, v_model, 'Model 20 renamed'
  );
  reset role;
  perform pg_temp.assert(v_old_secret is null, 'metadata-only update returns no old secret');
  select display_name, agent_max_model_requests
    into v_name, v_budget
  from public.ai_model_config
  where id = v_model;
  perform pg_temp.assert(v_name = 'Model 20 renamed', 'update accepts explicit actor');
  perform pg_temp.assert(v_budget = 120, 'omitted budget preserves 120');

  set local role service_role;
  v_old_secret := public.admin_update_model_config(
    v_admin, v_model, null, null, null, v_secret_2
  );
  reset role;
  perform pg_temp.assert(
    v_old_secret = v_secret_1,
    'key rotation returns the previous secret reference'
  );

  perform pg_temp.assert_raises(
    format(
      'select public.admin_create_model_config(NULL::uuid,%L,%L,%L,%L::uuid)',
      'x', 'https://x.example.com', 'x', v_secret_1
    ),
    'actor_id is required',
    'create rejects a null actor'
  );
  perform pg_temp.assert_raises(
    format(
      'select public.admin_create_model_config(%L,%L,%L,%L,%L::uuid)',
      v_reviewer, 'x', 'https://x.example.com', 'x', v_secret_1
    ),
    'ADMIN role required',
    'create rejects a non-admin actor'
  );
  perform pg_temp.assert_raises(
    format(
      'select public.admin_update_model_config(NULL::uuid,%L,%L)',
      v_model, 'x'
    ),
    'actor_id is required',
    'update rejects a null actor'
  );
  perform pg_temp.assert_raises(
    format(
      'select public.admin_update_model_config(%L,%L,%L)',
      v_reviewer, v_model, 'x'
    ),
    'ADMIN role required',
    'update rejects a non-admin actor'
  );

  v_snapshot := public.build_model_snapshot(v_model);
  perform pg_temp.assert(
    (select count(*) from jsonb_object_keys(v_snapshot)) = cardinality(v_snapshot_keys)
      and v_snapshot ?& v_snapshot_keys,
    'new snapshot contains exactly the final eleven keys'
  );
  perform pg_temp.assert(
    not (v_snapshot ?| array[
      'provider', 'execution_engine', 'api_key_secret_id',
      'retrieval_prompt_version', 'analysis_prompt_version'
    ]),
    'snapshot excludes provider, engine, prompts and secret id'
  );
  perform pg_temp.assert(
    (v_snapshot->>'agent_max_model_requests')::integer = 120,
    'snapshot freezes the default request budget 120'
  );

  -- Browser-facing admin list follows the same provider-free shape.
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', v_admin::text, 'role', 'authenticated')::text,
    true
  );
  set local role authenticated;
  select to_jsonb(config) into v_list_row
  from public.admin_list_model_configs() config
  where config.id = v_model;
  reset role;

  perform pg_temp.assert(v_list_row is not null, 'ADMIN list returns the new model');
  perform pg_temp.assert(
    not (v_list_row ?| array[
      'provider', 'execution_engine', 'api_key_secret_id',
      'retrieval_prompt_version', 'analysis_prompt_version'
    ]),
    'ADMIN list does not expose removed or secret fields'
  );
  perform pg_temp.assert(
    (v_list_row->>'agent_max_model_requests')::integer = 120,
    'ADMIN list reports the final request budget'
  );
end;
$test$;

select 'ALL_REMOVE_MODEL_PROVIDER_TESTS_PASSED' as result;
rollback;
