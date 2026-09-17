-- 20260917130000_model_network_access_mode_test.sql
--
-- V1.7 阶段二契约回归。每条断言对应方案 §3 的一条验收标准：
--
--   §3.2  network_access_mode ∈ {DIRECT, HOST_PROXY}，默认 DIRECT，既有行全部 DIRECT
--   §3.5  网络类型随 Job 冻结进 model_snapshot
--   §3.1  create / update 能设置它，且**没有留下不接收它的旧重载**
--   审计   变更被记进 batch_operation_log 的 changed_fields，且既有逐字段 diff 未被破坏

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

-- ---------------------------------------------------------------------------
-- 1. 列、约束与既有数据
-- ---------------------------------------------------------------------------

do $test$
begin
  perform pg_temp.assert(
    (select column_default like '%DIRECT%' and is_nullable = 'NO'
     from information_schema.columns
     where table_schema = 'public' and table_name = 'ai_model_config'
       and column_name = 'network_access_mode'),
    'network_access_mode is NOT NULL with a DIRECT default'
  );

  -- 既有模型一律 DIRECT：这是"改造前后行为一致"的全部依据，也是 DashScope 不再 403 的原因。
  perform pg_temp.assert(
    not exists (select 1 from public.ai_model_config where network_access_mode <> 'DIRECT'),
    'every pre-existing model config stays DIRECT'
  );

  -- check 约束真的拦得住非法值（api_key_secret_id 是 NOT NULL，给个占位 UUID 即可，
  -- 整个事务最后 rollback）。
  begin
    insert into public.ai_model_config (
      display_name, base_url, model_name, api_key_secret_id, network_access_mode
    ) values ('bad', 'https://x.invalid', 'm', gen_random_uuid(), 'PROXY');
    perform pg_temp.assert(false, 'an unknown network_access_mode must be rejected');
  exception when check_violation then
    null;
  end;

  -- 校验函数按稳定错误码拒绝，而不是静默归一。
  begin
    perform public.assert_network_access_mode('direct');
    perform pg_temp.assert(false, 'lowercase mode must be rejected');
  exception when others then
    perform pg_temp.assert(
      sqlerrm like '%MODEL_NETWORK_ACCESS_MODE_INVALID%',
      'invalid mode raises MODEL_NETWORK_ACCESS_MODE_INVALID, got: ' || sqlerrm
    );
  end;
  perform pg_temp.assert(public.assert_network_access_mode('HOST_PROXY') = 'HOST_PROXY', 'valid mode passes');
end;
$test$;

-- ---------------------------------------------------------------------------
-- 2. 没有残留旧重载
-- ---------------------------------------------------------------------------

do $test$
begin
  -- 留一个不接收网络类型的旧重载 = "页面改了网络类型但没生效"的后门。
  perform pg_temp.assert(
    (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'admin_create_model_config') = 1,
    'exactly one admin_create_model_config overload'
  );
  perform pg_temp.assert(
    (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'admin_update_model_config') = 1,
    'exactly one admin_update_model_config overload'
  );
  perform pg_temp.assert(
    (select pg_get_function_arguments(p.oid) like '%p_network_access_mode%'
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'admin_create_model_config'),
    'create accepts p_network_access_mode'
  );
  perform pg_temp.assert(
    (select pg_get_function_arguments(p.oid) like '%p_network_access_mode%'
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'admin_update_model_config'),
    'update accepts p_network_access_mode'
  );
  -- 返回冻结 locator 之外，这两个 RPC 都不能给浏览器。
  perform pg_temp.assert(
    not exists (
      select 1 from information_schema.role_routine_grants
      where specific_schema = 'public'
        and routine_name in ('admin_create_model_config', 'admin_update_model_config')
        and grantee in ('authenticated', 'anon')
    ),
    'model config writes stay service-role only'
  );
end;
$test$;

-- ---------------------------------------------------------------------------
-- 3. 端到端：create → 快照冻结 → update → 审计
-- ---------------------------------------------------------------------------

do $test$
declare
  v_admin uuid := '17000000-0000-4000-a000-000000000001';
  v_secret uuid;
  v_model uuid;
  v_batch uuid := '17000000-0000-4000-c000-000000000001';
  v_job uuid;
  v_snapshot jsonb;
  v_test_id uuid;
begin
  insert into auth.users (id, email) values (v_admin, 'admin_v17_net@example.com')
  on conflict (id) do nothing;
  insert into public.user_profile (id, role) values (v_admin, 'ADMIN')
  on conflict (id) do update set role = 'ADMIN';
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', v_admin::text, 'role', 'authenticated')::text, true
  );

  set local role service_role;
  v_secret := public.admin_vault_create_secret('v17-net-not-a-real-key', 'v17_net_key');

  -- 3.1 create 默认 DIRECT
  v_model := public.admin_create_model_config(
    v_admin, 'V17 Net Model', 'https://model-v17.example.com', 'model-v17', v_secret
  );
  perform pg_temp.assert(
    (select network_access_mode from public.ai_model_config where id = v_model) = 'DIRECT',
    'create defaults to DIRECT'
  );

  -- 3.2 update 改成内网模型，且审计记下这次变更
  perform public.admin_update_model_config(
    v_admin, v_model, null, null, null, null, null, null, null, null, null, null, null, 'HOST_PROXY'
  );
  perform pg_temp.assert(
    (select network_access_mode from public.ai_model_config where id = v_model) = 'HOST_PROXY',
    'update switches the model to HOST_PROXY'
  );

  /*
   * 断言"存在这样一行"，而不是"最新一行是"。
   *
   * `now()` 在同一个事务里是常量，主键又是随机 uuid，所以同事务写入的多条审计行既没有
   * 时间先后也没有可排序的主键 —— 任何"取最新一条"的写法在这里都是不确定的。这是写这份
   * 用例时实测踩到的。
   */
  perform pg_temp.assert(
    exists (
      select 1 from public.batch_operation_log
      where model_config_id = v_model and action = 'MODEL_CONFIG_UPDATED'
        and 'network_access_mode' = any (changed_fields)
        and old_values->>'network_access_mode' = 'DIRECT'
        and new_values->>'network_access_mode' = 'HOST_PROXY'
    ),
    'an audit row records both sides of the network_access_mode change'
  );

  -- 既有的逐字段 diff 没有被破坏：改一个无关字段必须只记那一个字段。
  perform public.admin_update_model_config(v_admin, v_model, 'V17 Net Model Renamed');
  perform pg_temp.assert(
    exists (
      select 1 from public.batch_operation_log
      where model_config_id = v_model and action = 'MODEL_CONFIG_UPDATED'
        and changed_fields = array['display_name']
    ),
    'per-field diffing still records a lone display_name change'
  );
  -- 而且不该出现"把无关字段一并记进去"的行。
  perform pg_temp.assert(
    not exists (
      select 1 from public.batch_operation_log
      where model_config_id = v_model and action = 'MODEL_CONFIG_UPDATED'
        and 'display_name' = any (changed_fields)
        and 'network_access_mode' = any (changed_fields)
    ),
    'a rename must not be recorded as also changing the network mode'
  );

  -- 3.3 非法取值被 RPC 拒
  begin
    perform public.admin_update_model_config(
      v_admin, v_model, null, null, null, null, null, null, null, null, null, null, null, 'VPN'
    );
    perform pg_temp.assert(false, 'an invalid mode must be rejected by the RPC');
  exception when others then
    perform pg_temp.assert(
      sqlerrm like '%MODEL_NETWORK_ACCESS_MODE_INVALID%',
      'RPC rejects invalid mode with the stable code, got: ' || sqlerrm
    );
  end;

  -- 3.4 模型快照带上网络类型（Job 冻结的依据）
  v_snapshot := public.build_model_snapshot(v_model);
  perform pg_temp.assert(
    v_snapshot ? 'network_access_mode' and v_snapshot->>'network_access_mode' = 'HOST_PROXY',
    'build_model_snapshot freezes the network access mode'
  );

  -- 3.5 连接测试入队时也冻结它，并且与配置同源
  v_test_id := public.enqueue_model_connectivity_test(v_model);
  perform pg_temp.assert(
    (select network_access_mode_snapshot from public.model_connectivity_test where id = v_test_id)
      = 'HOST_PROXY',
    'enqueue_model_connectivity_test snapshots the mode'
  );
  -- 入队后把配置改回公网：已入队的那次测试不受影响（避免不可复现的竞态）。
  perform public.admin_update_model_config(
    v_admin, v_model, null, null, null, null, null, null, null, null, null, null, null, 'DIRECT'
  );
  perform pg_temp.assert(
    (select network_access_mode_snapshot from public.model_connectivity_test where id = v_test_id)
      = 'HOST_PROXY',
    'an already-queued test keeps the mode it was enqueued with'
  );

  -- 3.6 列表 RPC 暴露它（前端据此显示"内网/公网"）
  reset role;
  perform pg_temp.assert(
    (select count(*) from public.admin_list_model_configs() where id = v_model
       and network_access_mode = 'DIRECT') = 1,
    'admin_list_model_configs exposes network_access_mode'
  );

  -- 3.7 Job 冻结：改配置不影响已创建的 Job
  set local role service_role;
  perform public.admin_update_model_config(
    v_admin, v_model, null, null, null, null, null, null, null, null, null, null, null, 'HOST_PROXY'
  );
  reset role;

  insert into public.review_batch (id, name, week_code, default_branch, ai_model_config_id, created_by)
  values (v_batch, 'V17 net batch', '2026-W38', 'feature_dev', v_model, v_admin);
  insert into public.review_story (batch_id, story_code, story_name, owners_text, source_data)
  values (v_batch, 'V17-1', 'story', 'dev', '{}'::jsonb);
  v_job := public.enqueue_analysis_job(v_batch);
  perform pg_temp.assert(
    (select model_snapshot->>'network_access_mode' from public.analysis_job where id = v_job)
      = 'HOST_PROXY',
    'the job froze HOST_PROXY'
  );

  set local role service_role;
  perform public.admin_update_model_config(
    v_admin, v_model, null, null, null, null, null, null, null, null, null, null, null, 'DIRECT'
  );
  reset role;
  perform pg_temp.assert(
    (select model_snapshot->>'network_access_mode' from public.analysis_job where id = v_job)
      = 'HOST_PROXY',
    'changing the config mid-run does not move an in-flight job onto another network'
  );
end;
$test$;

rollback;
