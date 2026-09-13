-- 0032_analysis_runtime_monitoring_test.sql
-- 0001..0033 最终 schema 下的 V1.5 真实运行监控台测试。
-- 以库属主执行；整个脚本在单事务中运行并最终 ROLLBACK。
--
-- 覆盖方案 §10.1 的验收矩阵：
--   幂等（同一 event_uuid 重试只产生一行、投影只更新一次）；
--   Task fencing（worker / claim token / attempt / lease 四要素）与 Job 层 fencing；
--   Lineage（未解析到 node 的事件被丢弃并计数，不使整批失败）；
--   Projection（乱序不回退、不同 correlation 的 TERMINAL 不覆盖新活动）；
--   投影清理（终态后运行态清空 + 未闭合 correlation 补写 TOOL_CALL_CANCELLED）；
--   游标水位（未过水位的事件不返回，next_event_id 不越过它，逃生阀生效）；
--   权限（ADMIN / 批次创建者可读，anon 全拒，内部函数对所有角色不可执行，
--         三个诊断 RPC 不授予 authenticated）；
--   Payload allowlist（prompt / command / api_key / 绝对路径落库后不存在）；
--   Retention（活动 Job 不清理、按 p_limit 限量、汇总表行数不变）；
--   event_day 确定性（含 clock_skewed 钳制）；
--   汇总正确性（tool_ms_sum > tool_ms_union、busy <= wall、归因等式成立）、
--   汇总容错（rollup_version = 0 可被 backfill 补算）与幂等；
--   get_analysis_run_trend 分组白名单；
--   get_analysis_attempt_diagnostics 的 timeline_truncated 不静默截断。
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

-- 把事件行伪装成"来自一个已提交的老事务"，让 §6.1.3 的水位裁剪在单事务测试里可断言。
create or replace function pg_temp.settle_events(p_batch_id uuid)
returns void language plpgsql as $$
begin
  update public.analysis_runtime_event
  set xact_id = 1
  where batch_id = p_batch_id and xact_id > 1;
end;
$$;

------------------------------------------------------------------------------
-- A. Schema、签名与授权
------------------------------------------------------------------------------

do $test$
declare
  v_signature text;
  v_count integer;
  v_service_only text[] := array[
    'public.report_analysis_runtime_event_batch(text,uuid,uuid,uuid,integer,jsonb,integer)',
    'public.purge_analysis_runtime_events(integer)',
    'public.compute_analysis_run_rollup(uuid)',
    'public.backfill_analysis_run_rollups(integer)',
    'public.seal_analysis_runtime_projection(uuid,text)',
    'public.analysis_runtime_intervals(uuid,text[])',
    'public.analysis_runtime_union_ms(uuid,text[],uuid)',
    'public.analysis_runtime_max_overlap(uuid,text[])',
    'public.analysis_runtime_max_concurrent_agents(uuid)'
  ];
  v_diagnostic_rpcs text[] := array[
    'public.get_analysis_attempt_diagnostics(uuid,integer)',
    'public.get_analysis_run_trend(text[],timestamptz,uuid,text)',
    'public.get_analysis_runtime_findings(uuid,timestamptz)'
  ];
  v_browser_rpcs text[] := array[
    'public.admin_list_active_analysis_batches()',
    'public.get_analysis_runtime_console(uuid,bigint)'
  ];
  v_internal text[] := array[
    'public.insert_analysis_runtime_event(uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,text,text,text,text,text,text,integer,timestamptz,jsonb)',
    'public.apply_analysis_runtime_projection(bigint,text,text,text,text,text,uuid,uuid,text,jsonb,timestamptz)'
  ];
  v_columns text[] := array[
    'current_activity_scope', 'current_activity_code', 'current_activity_status',
    'current_correlation_id', 'current_tool_name', 'current_activity_started_at',
    'current_activity_updated_at', 'current_activity_event_id'
  ];
  v_column text;
begin
  perform pg_temp.assert(
    to_regclass('public.analysis_runtime_event') is not null,
    'analysis_runtime_event exists'
  );
  perform pg_temp.assert(
    to_regclass('public.analysis_agent_run_rollup') is not null,
    'analysis_agent_run_rollup exists'
  );

  -- 事件表启用 RLS 且浏览器角色完全无权限（首版不直接 SELECT）。
  select count(*) into v_count from pg_class cls
  join pg_namespace ns on ns.oid = cls.relnamespace
  where ns.nspname = 'public' and cls.relname = 'analysis_runtime_event'
    and cls.relrowsecurity;
  perform pg_temp.assert(v_count = 1, 'analysis_runtime_event has RLS enabled');

  select count(*) into v_count from pg_class cls
  join pg_namespace ns on ns.oid = cls.relnamespace
  where ns.nspname = 'public' and cls.relname = 'analysis_agent_run_rollup'
    and cls.relrowsecurity;
  perform pg_temp.assert(v_count = 1, 'analysis_agent_run_rollup has RLS enabled');

  perform pg_temp.assert(
    not has_table_privilege('authenticated', 'public.analysis_runtime_event', 'SELECT')
      and not has_table_privilege('authenticated', 'public.analysis_runtime_event', 'INSERT')
      and not has_table_privilege('authenticated', 'public.analysis_runtime_event', 'UPDATE')
      and not has_table_privilege('authenticated', 'public.analysis_runtime_event', 'DELETE'),
    'authenticated has no direct privilege on the runtime event table'
  );
  perform pg_temp.assert(
    not has_table_privilege('anon', 'public.analysis_runtime_event', 'SELECT'),
    'anon cannot read the runtime event table'
  );
  perform pg_temp.assert(
    not has_table_privilege('authenticated', 'public.analysis_agent_run_rollup', 'SELECT')
      and not has_table_privilege('anon', 'public.analysis_agent_run_rollup', 'SELECT'),
    'the rollup table is not reachable from the browser'
  );

  -- 投影列存在，且 current_activity_event_id 是裸 bigint（无外键）。
  foreach v_column in array v_columns loop
    select count(*) into v_count from information_schema.columns
    where table_schema = 'public' and table_name = 'analysis_agent_node'
      and column_name = v_column;
    perform pg_temp.assert(v_count = 1, format('analysis_agent_node.%s exists', v_column));
  end loop;

  select count(*) into v_count from information_schema.columns
  where table_schema = 'public' and table_name = 'analysis_agent_run'
    and column_name in ('attempt_phase_code', 'attempt_phase_started_at', 'attempt_phase_event_id');
  perform pg_temp.assert(v_count = 3, 'analysis_agent_run carries the attempt phase projection');

  select count(*) into v_count
  from pg_constraint con
  join pg_class cls on cls.oid = con.conrelid
  where cls.relname = 'analysis_agent_node' and con.contype = 'f'
    and 'current_activity_event_id' = any (
      select att.attname from pg_attribute att
      where att.attrelid = cls.oid and att.attnum = any (con.conkey)
    );
  perform pg_temp.assert(
    v_count = 0, 'current_activity_event_id has no foreign key (cursor semantics, not relational)'
  );

  -- service_role-only 函数。
  foreach v_signature in array v_service_only loop
    perform pg_temp.assert(
      to_regprocedure(v_signature) is not null, format('function exists: %s', v_signature)
    );
    perform pg_temp.assert(
      has_function_privilege('service_role', v_signature, 'EXECUTE'),
      format('service_role can execute: %s', v_signature)
    );
    perform pg_temp.assert(
      not has_function_privilege('authenticated', v_signature, 'EXECUTE')
        and not has_function_privilege('anon', v_signature, 'EXECUTE'),
      format('browser roles cannot execute: %s', v_signature)
    );
  end loop;

  -- 诊断 RPC 只给 service_role：浏览器根本拿不到（方案 §6.10 / §15）。
  foreach v_signature in array v_diagnostic_rpcs loop
    perform pg_temp.assert(
      to_regprocedure(v_signature) is not null, format('diagnostic RPC exists: %s', v_signature)
    );
    perform pg_temp.assert(
      has_function_privilege('service_role', v_signature, 'EXECUTE'),
      format('service_role can execute: %s', v_signature)
    );
    perform pg_temp.assert(
      not has_function_privilege('authenticated', v_signature, 'EXECUTE'),
      format('authenticated is NOT granted the diagnostic RPC: %s', v_signature)
    );
    perform pg_temp.assert(
      not has_function_privilege('anon', v_signature, 'EXECUTE'),
      format('anon is NOT granted the diagnostic RPC: %s', v_signature)
    );
  end loop;

  -- 浏览器查询 RPC。
  foreach v_signature in array v_browser_rpcs loop
    perform pg_temp.assert(
      has_function_privilege('authenticated', v_signature, 'EXECUTE'),
      format('authenticated can execute: %s', v_signature)
    );
    perform pg_temp.assert(
      not has_function_privilege('anon', v_signature, 'EXECUTE'),
      format('anon cannot execute: %s', v_signature)
    );
  end loop;

  -- 内部函数对所有角色都不可执行。
  foreach v_signature in array v_internal loop
    perform pg_temp.assert(
      to_regprocedure(v_signature) is not null, format('internal function exists: %s', v_signature)
    );
    perform pg_temp.assert(
      not has_function_privilege('service_role', v_signature, 'EXECUTE')
        and not has_function_privilege('authenticated', v_signature, 'EXECUTE')
        and not has_function_privilege('anon', v_signature, 'EXECUTE')
        and not has_function_privilege('public', v_signature, 'EXECUTE'),
      format('no role can execute the internal function: %s', v_signature)
    );
  end loop;

  -- 只允许一个签名，避免出现绕过 allowlist 的重载。
  select count(*) into v_count from pg_proc proc
  join pg_namespace ns on ns.oid = proc.pronamespace
  where ns.nspname = 'public' and proc.proname = 'report_analysis_runtime_event_batch';
  perform pg_temp.assert(v_count = 1, 'the batch writer has exactly one signature');
end;
$test$;

------------------------------------------------------------------------------
-- B. 事件目录与 payload allowlist（纯函数，无 fixture）
------------------------------------------------------------------------------

do $test$
declare
  v_catalog jsonb := public.analysis_runtime_event_catalog();
  v_payload jsonb;
begin
  perform pg_temp.assert(
    v_catalog ? 'TOOL_CALL_STARTED' and v_catalog ? 'MODEL_REQUEST_COMPLETED'
      and v_catalog ? 'ATTEMPT_COMMITTED' and v_catalog ? 'TASK_CLAIMED',
    'the catalog registers the core event types'
  );
  -- Phase 3 之前平台没有 Workflow / Harness Job 的真实生命周期边界，
  -- 因此这些事件类型必须无法产生，UI 才不会展示伪造的步骤树。
  perform pg_temp.assert(
    not (v_catalog ? 'WORKFLOW_STARTED') and not (v_catalog ? 'WORKFLOW_STEP_STARTED')
      and not (v_catalog ? 'HARNESS_JOB_STARTED'),
    'Workflow / Harness Job event types are absent before Phase 3'
  );
  perform pg_temp.assert(
    v_catalog #>> '{TOOL_CALL_STARTED,phase}' = 'STARTED'
      and v_catalog #>> '{TOOL_CALL_COMPLETED,phase}' = 'TERMINAL'
      and (v_catalog #> '{PINS_VERIFIED}') -> 'phase' is null,
    'phase is STARTED / TERMINAL for lifecycles and null for point events'
  );

  -- allowlist：白名单外的键一律丢弃，绝不透传内容或凭据。
  v_payload := public.analysis_runtime_event_payload('TOOL_CALL_COMPLETED', jsonb_build_object(
    'tool_name', 'bash',
    'agent_role', 'implementation-child',
    'duration_ms', 1234,
    'exit_code', -9,
    'output_bytes', 4096,
    'truncated', true,
    'prompt', 'you are a reviewer',
    'command', 'rm -rf /',
    'api_key', 'sk-live-should-never-land',
    'file_path', '/Users/kingdee/secret.ts',
    'stdout', 'lots of output',
    'authorization', 'Bearer abc.def.ghi',
    'url', 'https://internal.example.com/?token=1'
  ));
  perform pg_temp.assert(
    v_payload ? 'tool_name' and v_payload ? 'agent_role' and v_payload ? 'duration_ms'
      and v_payload ? 'exit_code' and v_payload ? 'output_bytes' and v_payload ? 'truncated',
    'the allowlisted diagnostic fields survive'
  );
  perform pg_temp.assert(
    not (v_payload ? 'prompt') and not (v_payload ? 'command') and not (v_payload ? 'api_key')
      and not (v_payload ? 'file_path') and not (v_payload ? 'stdout')
      and not (v_payload ? 'authorization') and not (v_payload ? 'url'),
    'prompt / command / api_key / absolute path / stdout / header / URL are all dropped'
  );
  perform pg_temp.assert(
    (v_payload ->> 'exit_code')::integer = -9,
    'exit_code keeps negative signal values'
  );

  -- 枚举校验：伪造的角色 / 工具名 / 仓库名被丢弃。
  v_payload := public.analysis_runtime_event_payload('TOOL_CALL_STARTED', jsonb_build_object(
    'tool_name', 'definitely_not_a_real_tool',
    'agent_role', 'super-admin-child',
    'provider', 'root'
  ));
  perform pg_temp.assert(
    not (v_payload ? 'tool_name') and not (v_payload ? 'agent_role') and v_payload ? 'provider',
    'unknown tool names and agent roles are rejected, valid providers survive'
  );

  v_payload := public.analysis_runtime_event_payload('REPOSITORY_PREPARE_STARTED',
    jsonb_build_object('repository_name', 'some-other-repo'));
  perform pg_temp.assert(
    not (v_payload ? 'repository_name'), 'repository_name must come from the frozen enum'
  );

  -- reason_code 只接受稳定机器码，不接受异常 message。
  v_payload := public.analysis_runtime_event_payload('TOOL_CALL_DENIED',
    jsonb_build_object('reason_code', 'connect ECONNREFUSED /tmp/crp-broker-1/x.sock'));
  perform pg_temp.assert(
    not (v_payload ? 'reason_code'), 'a raw exception message is not a reason_code'
  );
  v_payload := public.analysis_runtime_event_payload('TOOL_CALL_DENIED',
    jsonb_build_object('reason_code', 'TOOL_NOT_ALLOWED_FOR_ROLE'));
  perform pg_temp.assert(
    v_payload ->> 'reason_code' = 'TOOL_NOT_ALLOWED_FOR_ROLE', 'a stable reason code survives'
  );

  perform pg_temp.assert(
    public.analysis_runtime_event_payload('NOT_A_REAL_EVENT', '{"a":1}'::jsonb) = '{}'::jsonb,
    'an unknown event type yields an empty payload'
  );
end;
$test$;

------------------------------------------------------------------------------
-- C. 端到端：Job → Task → Attempt → Agent → 工具/模型 → 终态 → 汇总
------------------------------------------------------------------------------

do $test$
declare
  v_admin uuid := '32000000-0000-4000-a000-0000000000a1';
  v_reviewer uuid := '32000000-0000-4000-a000-0000000000a2';
  v_viewer uuid := '32000000-0000-4000-a000-0000000000a3';
  v_model uuid := '32000000-0000-4000-b000-0000000000b1';
  v_secret uuid;
  v_batch uuid := '32000000-0000-4000-c000-0000000000c1';
  v_batch_active uuid := '32000000-0000-4000-c000-0000000000c2';
  v_story uuid := '32000000-0000-4000-e000-0000000000e1';
  v_story_active uuid := '32000000-0000-4000-e000-0000000000e2';
  v_worker text := 'worker-32-runtime';
  v_job uuid;
  v_job_active uuid;
  v_task uuid;
  v_token uuid;
  v_attempt integer;
  v_envelope jsonb;
  v_run uuid;
  v_root_node uuid;
  v_child_node uuid;
  v_result jsonb;
  v_console jsonb;
  v_diag jsonb;
  v_started timestamptz;
  v_event_id bigint;
  v_event_id_2 bigint;
  v_count integer;
  v_text text;
  v_uuid uuid := '32000000-0000-4000-f000-000000000001';
  v_day date;
  v_skewed boolean;
  v_rollup public.analysis_agent_run_rollup;
  v_wall integer;
  v_purged integer;
  v_rollup_rows integer;
  v_lag bigint;
begin
  insert into auth.users (id, email) values
    (v_admin, 'admin_32_runtime@example.com'),
    (v_reviewer, 'reviewer_32_runtime@example.com'),
    (v_viewer, 'viewer_32_runtime@example.com')
  on conflict (id) do nothing;

  insert into public.user_profile (id, role) values (v_admin, 'ADMIN')
  on conflict (id) do update set role = 'ADMIN';
  insert into public.user_profile (id, role) values (v_reviewer, 'REVIEWER')
  on conflict (id) do update set role = 'REVIEWER';
  insert into public.user_profile (id, role) values (v_viewer, 'VIEWER')
  on conflict (id) do update set role = 'VIEWER';

  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', v_admin::text, 'role', 'authenticated')::text,
    true
  );

  set local role service_role;
  v_secret := public.admin_vault_create_secret('sk-32-runtime', 'ai_key_32_runtime');
  reset role;

  insert into public.ai_model_config (
    id, display_name, base_url, model_name, api_key_secret_id,
    enabled, max_parallel_tasks, created_by
  ) values (
    v_model, 'Model 32 runtime', 'https://model-32.example.com', 'model-32',
    v_secret, true, 4, v_admin
  );

  insert into public.review_batch (
    id, name, week_code, status, default_branch, created_by, ai_model_config_id
  ) values
    (v_batch, 'V1.5 runtime console', 'WK-32-RT-001',
     'WAITING_AI_RESULT', 'feature_dev', v_admin, v_model),
    (v_batch_active, 'V1.5 runtime console active', 'WK-32-RT-002',
     'WAITING_AI_RESULT', 'feature_dev', v_admin, v_model);

  insert into public.review_story (
    id, batch_id, story_code, story_name, owners_text, source_data
  ) values
    (v_story, v_batch, 'ST-32-RT-001', 'Runtime story', 'owner', '{}'::jsonb),
    (v_story_active, v_batch_active, 'ST-32-RT-002', 'Active story', 'owner', '{}'::jsonb);

  v_job := public.enqueue_analysis_job(v_batch);
  v_job_active := public.enqueue_analysis_job(v_batch_active);

  ---------------------------------------------------------------------------
  -- C1. Job 层状态迁移原子产生 JOB_* 事件
  ---------------------------------------------------------------------------
  update public.analysis_job
  set status = 'PREPARING_CODE', worker_id = v_worker, locked_at = now()
  where id = v_job;

  select count(*) into v_count from public.analysis_runtime_event
  where job_id = v_job and event_type = 'JOB_PREPARATION_STARTED';
  perform pg_temp.assert(v_count = 1, 'claiming a job for preparation writes JOB_PREPARATION_STARTED');
  select worker_id into v_text from public.analysis_runtime_event
  where job_id = v_job and event_type = 'JOB_PREPARATION_STARTED';
  perform pg_temp.assert(v_text = v_worker, 'the job preparation event carries the holder worker');
  select count(*) into v_count from public.analysis_runtime_event
  where job_id = v_job and event_type = 'JOB_PREPARATION_STARTED' and task_id is not null;
  perform pg_temp.assert(v_count = 0, 'JOB scope events never carry a task id');

  ---------------------------------------------------------------------------
  -- C2. Job 层 fencing：只有持有者可以上报 JOB_* 事件
  ---------------------------------------------------------------------------
  set local role service_role;
  perform pg_temp.assert_raises(
    format(
      'select public.report_analysis_runtime_event_batch(%L,%L,null,null,null,%L::jsonb)',
      'worker-32-impostor', v_job,
      jsonb_build_array(jsonb_build_object(
        'event_uuid', gen_random_uuid(), 'event_type', 'REPOSITORY_PREPARE_STARTED',
        'occurred_at', now(), 'payload', jsonb_build_object('repository_name', 'kdmanage-backend')
      ))::text
    ),
    'RUNTIME_EVENT_FENCE_REJECTED',
    'a non-holder worker cannot write JOB scope events'
  );

  v_result := public.report_analysis_runtime_event_batch(
    v_worker, v_job, null, null, null,
    jsonb_build_array(
      jsonb_build_object(
        'event_uuid', gen_random_uuid(), 'event_type', 'REPOSITORY_PREPARE_STARTED',
        'occurred_at', now(),
        'payload', jsonb_build_object('repository_name', 'kdmanage-backend')
      ),
      jsonb_build_object(
        'event_uuid', gen_random_uuid(), 'event_type', 'REPOSITORY_PREPARE_COMPLETED',
        'occurred_at', now(), 'duration_ms', 4200,
        'payload', jsonb_build_object('repository_name', 'kdmanage-backend', 'duration_ms', 4200)
      )
    )
  );
  reset role;
  perform pg_temp.assert(
    (v_result->>'accepted')::integer = 2, 'the holder worker can write repository prepare events'
  );

  insert into public.analysis_repository_snapshot (
    job_id, repository_name, requested_branch, commit_sha
  ) values
    (v_job, 'kdmanage-backend', 'feature_dev', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
    (v_job, 'tmanage-backend', 'feature_dev', 'cccccccccccccccccccccccccccccccccccccccc');
  update public.analysis_job set status = 'PROCESSING' where id = v_job;

  select count(*) into v_count from public.analysis_runtime_event
  where job_id = v_job and event_type = 'JOB_SNAPSHOTS_FROZEN';
  perform pg_temp.assert(v_count = 1, 'freezing snapshots writes JOB_SNAPSHOTS_FROZEN');

  select id into v_task from public.analysis_story_task where job_id = v_job;

  ---------------------------------------------------------------------------
  -- C3. claim 原子产生 TASK_CLAIMED 与 ATTEMPT_STARTED
  ---------------------------------------------------------------------------
  set local role service_role;
  v_envelope := public.claim_next_story_task(v_worker, 900);
  reset role;
  perform pg_temp.assert((v_envelope->>'id')::uuid = v_task, 'the task is claimed');

  v_token := (v_envelope->>'claim_token')::uuid;
  v_attempt := (v_envelope->>'agent_attempt')::integer;
  v_run := (v_envelope->>'agent_run_id')::uuid;

  -- 把这次 attempt 的起点回拨 10 分钟，后续所有人造事件都落在一条可验证的时间线上，
  -- 这样 §6.9.2 的归因等式与区间并集可以断言到毫秒。
  update public.analysis_agent_run set started_at = now() - interval '10 minutes'
  where id = v_run;
  select started_at into v_started from public.analysis_agent_run where id = v_run;

  select count(*) into v_count from public.analysis_runtime_event
  where task_id = v_task and event_type = 'TASK_CLAIMED';
  perform pg_temp.assert(v_count = 1, 'claim_next_story_task writes TASK_CLAIMED in-transaction');
  select count(*) into v_count from public.analysis_runtime_event
  where agent_run_id = v_run and event_type = 'ATTEMPT_STARTED';
  perform pg_temp.assert(v_count = 1, 'creating the run writes ATTEMPT_STARTED');
  perform pg_temp.assert(
    (select (payload->>'attempt_number')::integer from public.analysis_runtime_event
     where task_id = v_task and event_type = 'TASK_CLAIMED') = v_attempt,
    'TASK_CLAIMED carries the incremented attempt number'
  );

  ---------------------------------------------------------------------------
  -- C4. Task fencing 四要素
  ---------------------------------------------------------------------------
  set local role service_role;
  perform pg_temp.assert_raises(
    format(
      'select public.report_analysis_runtime_event_batch(%L,%L,%L,%L,%s,%L::jsonb)',
      'worker-32-impostor', v_job, v_task, v_token, v_attempt,
      jsonb_build_array(jsonb_build_object(
        'event_uuid', gen_random_uuid(), 'event_type', 'PINS_VERIFIED', 'occurred_at', now()
      ))::text
    ),
    'RUNTIME_EVENT_FENCE_REJECTED', 'a wrong worker id is refused'
  );
  perform pg_temp.assert_raises(
    format(
      'select public.report_analysis_runtime_event_batch(%L,%L,%L,%L,%s,%L::jsonb)',
      v_worker, v_job, v_task, gen_random_uuid(), v_attempt,
      jsonb_build_array(jsonb_build_object(
        'event_uuid', gen_random_uuid(), 'event_type', 'PINS_VERIFIED', 'occurred_at', now()
      ))::text
    ),
    'RUNTIME_EVENT_FENCE_REJECTED', 'a wrong claim token is refused'
  );
  perform pg_temp.assert_raises(
    format(
      'select public.report_analysis_runtime_event_batch(%L,%L,%L,%L,%s,%L::jsonb)',
      v_worker, v_job, v_task, v_token, v_attempt + 5,
      jsonb_build_array(jsonb_build_object(
        'event_uuid', gen_random_uuid(), 'event_type', 'PINS_VERIFIED', 'occurred_at', now()
      ))::text
    ),
    'RUNTIME_EVENT_FENCE_REJECTED', 'a wrong attempt number is refused'
  );
  reset role;

  -- 过期 lease 也必须被拒（收敛路径的 session_revision 逃生门在 C11 单独验证）。
  update public.analysis_story_task set lease_expires_at = now() - interval '1 minute'
  where id = v_task;
  set local role service_role;
  perform pg_temp.assert_raises(
    format(
      'select public.report_analysis_runtime_event_batch(%L,%L,%L,%L,%s,%L::jsonb)',
      v_worker, v_job, v_task, v_token, v_attempt,
      jsonb_build_array(jsonb_build_object(
        'event_uuid', gen_random_uuid(), 'event_type', 'PINS_VERIFIED', 'occurred_at', now()
      ))::text
    ),
    'RUNTIME_EVENT_FENCE_REJECTED', 'an expired lease is refused'
  );
  reset role;
  update public.analysis_story_task set lease_expires_at = now() + interval '15 minutes'
  where id = v_task;

  ---------------------------------------------------------------------------
  -- C5. Agent 注册原子产生 ROOT_AGENT_REGISTERED / AGENT_REGISTERED
  ---------------------------------------------------------------------------
  set local role service_role;
  perform public.record_analysis_attempt_profile(
    v_task, v_worker, v_token, v_attempt,
    '0.1.5-rc.1', (select capability_contract_hash from public.analysis_job where id = v_job),
    'profile-hash-32', v_envelope->>'policy_hash', 'agent-root', 'session-root', 'digest-32'
  );
  v_root_node := (public.register_analysis_agent_node(
    v_task, v_worker, v_token, v_attempt,
    'agent-root', 'session-root', null, 'root-reviewer', 'root', 'tool-policy-root'
  )->>'node_id')::uuid;
  v_child_node := (public.register_analysis_agent_node(
    v_task, v_worker, v_token, v_attempt,
    'agent-child', 'session-child', 'agent-root', 'implementation-child', 'spawn',
    'tool-policy-child'
  )->>'node_id')::uuid;
  reset role;

  update public.analysis_agent_node set started_at = v_started where agent_run_id = v_run;

  select count(*) into v_count from public.analysis_runtime_event
  where agent_node_id = v_root_node and event_type = 'ROOT_AGENT_REGISTERED';
  perform pg_temp.assert(v_count = 1, 'the root node registration writes ROOT_AGENT_REGISTERED');
  select count(*) into v_count from public.analysis_runtime_event
  where agent_node_id = v_child_node and event_type = 'AGENT_REGISTERED';
  perform pg_temp.assert(v_count = 1, 'a child node registration writes AGENT_REGISTERED');
  perform pg_temp.assert(
    (select payload->>'agent_role' from public.analysis_runtime_event
     where agent_node_id = v_child_node and event_type = 'AGENT_REGISTERED')
      = 'implementation-child',
    'the agent registration event carries the role'
  );

  ---------------------------------------------------------------------------
  -- C6. 幂等：同一个 event_uuid 重试 10 次只产生一行，投影只更新一次
  ---------------------------------------------------------------------------
  set local role service_role;
  for v_count in 1..10 loop
    v_result := public.report_analysis_runtime_event_batch(
      v_worker, v_job, v_task, v_token, v_attempt,
      jsonb_build_array(jsonb_build_object(
        'event_uuid', v_uuid,
        'event_type', 'TOOL_CALL_STARTED',
        'occurred_at', v_started + interval '65 seconds',
        'agent_id', 'agent-root',
        'correlation_id', 'corr-idem-1',
        'payload', jsonb_build_object('tool_name', 'bash', 'agent_role', 'root-reviewer')
      ))
    );
  end loop;
  reset role;

  select count(*) into v_count from public.analysis_runtime_event where event_uuid = v_uuid;
  perform pg_temp.assert(v_count = 1, 'ten retries of one event_uuid produce exactly one row');
  perform pg_temp.assert(
    (v_result->>'duplicated')::integer = 1 and (v_result->>'accepted')::integer = 1,
    'the writer reports the retry as duplicated'
  );
  select id into v_event_id from public.analysis_runtime_event where event_uuid = v_uuid;
  perform pg_temp.assert(
    (select current_activity_event_id from public.analysis_agent_node where id = v_root_node)
      = v_event_id,
    'the projection points at the single stored event'
  );
  perform pg_temp.assert(
    (select current_activity_status from public.analysis_agent_node where id = v_root_node)
      = 'RUNNING'
    and (select current_tool_name from public.analysis_agent_node where id = v_root_node) = 'bash'
    and (select current_correlation_id from public.analysis_agent_node where id = v_root_node)
      = 'corr-idem-1',
    'a STARTED event puts the node into a RUNNING tool activity'
  );

  ---------------------------------------------------------------------------
  -- C7. Payload allowlist 落库后不存在敏感键
  ---------------------------------------------------------------------------
  set local role service_role;
  perform public.report_analysis_runtime_event_batch(
    v_worker, v_job, v_task, v_token, v_attempt,
    jsonb_build_array(
      jsonb_build_object(
        'event_uuid', gen_random_uuid(),
        'event_type', 'TOOL_CALL_STARTED',
        'occurred_at', v_started + interval '70 seconds',
        'agent_id', 'agent-child',
        'correlation_id', 'corr-payload-guard',
        'payload', jsonb_build_object(
          'tool_name', 'bash',
          'prompt', 'system prompt body',
          'command', 'cat ~/.ssh/id_rsa',
          'api_key', 'sk-live-leak',
          'file_path', '/Users/kingdee/codeReviewPlatform/src/App.tsx',
          'storage_locator', '/workspace/agent-sessions/abc.jsonl'
        )
      ),
      jsonb_build_object(
        'event_uuid', gen_random_uuid(),
        'event_type', 'TOOL_CALL_COMPLETED',
        'occurred_at', v_started + interval '75 seconds',
        'agent_id', 'agent-child',
        'correlation_id', 'corr-payload-guard',
        'duration_ms', 5000,
        'payload', jsonb_build_object('tool_name', 'bash', 'duration_ms', 5000)
      )
    )
  );
  reset role;

  select payload into v_result from public.analysis_runtime_event
  where correlation_id = 'corr-payload-guard' and phase = 'STARTED';
  perform pg_temp.assert(
    not (v_result ? 'prompt') and not (v_result ? 'command') and not (v_result ? 'api_key')
      and not (v_result ? 'file_path') and not (v_result ? 'storage_locator'),
    'sensitive payload keys never reach the table'
  );
  perform pg_temp.assert(v_result ->> 'tool_name' = 'bash', 'the allowlisted tool name survives');

  perform pg_temp.assert(
    not exists (
      select 1 from public.analysis_runtime_event
      where payload::text ~* '(bearer |api_key|sk-live|/Users/|/workspace/|ssh)'
    ),
    'no runtime event payload contains a credential or an absolute path'
  );

  ---------------------------------------------------------------------------
  -- C8. Lineage：解析不到 node 的事件被丢弃并计数，不使整批失败
  ---------------------------------------------------------------------------
  set local role service_role;
  v_result := public.report_analysis_runtime_event_batch(
    v_worker, v_job, v_task, v_token, v_attempt,
    jsonb_build_array(
      jsonb_build_object(
        'event_uuid', gen_random_uuid(), 'event_type', 'TOOL_CALL_STARTED',
        'occurred_at', v_started + interval '68 seconds',
        'agent_id', 'agent-not-registered-yet',
        'correlation_id', 'corr-ghost',
        'payload', jsonb_build_object('tool_name', 'read')
      ),
      jsonb_build_object(
        'event_uuid', gen_random_uuid(), 'event_type', 'PINS_VERIFIED',
        'occurred_at', v_started + interval '5 seconds'
      ),
      jsonb_build_object(
        'event_uuid', gen_random_uuid(), 'event_type', 'TOTALLY_MADE_UP_EVENT',
        'occurred_at', now()
      )
    )
  );
  reset role;
  perform pg_temp.assert(
    (v_result->>'dropped_unresolved_agent')::integer = 1
      and (v_result->>'dropped_invalid')::integer = 1
      and (v_result->>'accepted')::integer = 1,
    'unresolved agents and unknown event types are dropped and counted, the batch still lands'
  );
  perform pg_temp.assert(
    not exists (select 1 from public.analysis_runtime_event where correlation_id = 'corr-ghost'),
    'the unresolved-agent event is not stored'
  );
  perform pg_temp.assert(
    not exists (
      select 1 from public.analysis_runtime_event where event_type = 'TOTALLY_MADE_UP_EVENT'
    ),
    'an unregistered event type cannot be stored'
  );

  ---------------------------------------------------------------------------
  -- C9. 投影：不同 correlation 的 TERMINAL 不覆盖更新的活动
  ---------------------------------------------------------------------------
  set local role service_role;
  perform public.report_analysis_runtime_event_batch(
    v_worker, v_job, v_task, v_token, v_attempt,
    jsonb_build_array(jsonb_build_object(
      'event_uuid', gen_random_uuid(), 'event_type', 'TOOL_CALL_STARTED',
      'occurred_at', v_started + interval '80 seconds',
      'agent_id', 'agent-root', 'correlation_id', 'corr-newer',
      'payload', jsonb_build_object('tool_name', 'grep')
    ))
  );
  -- 迟到的旧 correlation 终态。
  perform public.report_analysis_runtime_event_batch(
    v_worker, v_job, v_task, v_token, v_attempt,
    jsonb_build_array(jsonb_build_object(
      'event_uuid', gen_random_uuid(), 'event_type', 'TOOL_CALL_COMPLETED',
      'occurred_at', v_started + interval '85 seconds',
      'agent_id', 'agent-root', 'correlation_id', 'corr-idem-1',
      'duration_ms', 20000,
      'payload', jsonb_build_object('tool_name', 'bash', 'duration_ms', 20000)
    ))
  );
  reset role;

  perform pg_temp.assert(
    (select current_correlation_id from public.analysis_agent_node where id = v_root_node)
      = 'corr-newer'
    and (select current_activity_status from public.analysis_agent_node where id = v_root_node)
      = 'RUNNING'
    and (select current_tool_name from public.analysis_agent_node where id = v_root_node) = 'grep',
    'a stale TERMINAL for another correlation does not overwrite the newer activity'
  );

  -- 同 correlation 的 TERMINAL 才闭合投影。
  set local role service_role;
  perform public.report_analysis_runtime_event_batch(
    v_worker, v_job, v_task, v_token, v_attempt,
    jsonb_build_array(jsonb_build_object(
      'event_uuid', gen_random_uuid(), 'event_type', 'TOOL_CALL_COMPLETED',
      'occurred_at', v_started + interval '90 seconds',
      'agent_id', 'agent-root', 'correlation_id', 'corr-newer',
      'duration_ms', 10000,
      'payload', jsonb_build_object('tool_name', 'grep', 'duration_ms', 10000)
    ))
  );
  reset role;
  perform pg_temp.assert(
    (select current_activity_status from public.analysis_agent_node where id = v_root_node)
      = 'COMPLETED',
    'the matching TERMINAL closes the projection'
  );

  ---------------------------------------------------------------------------
  -- C9a. 成功提交收敛：合成终态成功且同 correlation 只能有一个 TERMINAL
  ---------------------------------------------------------------------------
  set local role service_role;
  perform public.report_analysis_runtime_event_batch(
    v_worker, v_job, v_task, v_token, v_attempt,
    jsonb_build_array(jsonb_build_object(
      'event_uuid', gen_random_uuid(), 'event_type', 'MODEL_REQUEST_STARTED',
      'occurred_at', v_started, 'agent_id', 'agent-root',
      'correlation_id', 'corr-commit-final',
      'payload', jsonb_build_object('model_request_kind', 'loop')
    ))
  );
  reset role;

  -- 模拟 run 终态 trigger 的 seal 插入；0033 的 BEFORE INSERT 会把成功提交导致的
  -- MODEL_REQUEST_FAILED 规范成 COMPLETED。
  v_uuid := gen_random_uuid();
  perform public.insert_analysis_runtime_event(
    v_uuid, v_batch, v_job, v_task, v_run, v_root_node, v_worker,
    null, 'MODEL_REQUEST_FAILED', null, null, null,
    'corr-commit-final', null, 'ATTEMPT_COMMITTED', 1, v_started,
    jsonb_build_object('model_request_kind', 'loop', 'duration_ms', 1)
  );
  perform pg_temp.assert(
    (select event_type = 'MODEL_REQUEST_COMPLETED' and error_code is null
     from public.analysis_runtime_event
     where agent_run_id = v_run and correlation_id = 'corr-commit-final'
       and phase = 'TERMINAL'),
    'ATTEMPT_COMMITTED closes the final model request as COMPLETED, not FAILED'
  );

  -- usage-reporter 在提交 RPC 返回后才看到 provider finish；这条迟到真实终态必须被
  -- first-terminal-wins 吞掉，append-only 表里不能出现互相矛盾的第二条终态。
  set local role service_role;
  v_result := public.report_analysis_runtime_event_batch(
    v_worker, v_job, v_task, v_token, v_attempt,
    jsonb_build_array(jsonb_build_object(
      'event_uuid', gen_random_uuid(), 'event_type', 'MODEL_REQUEST_COMPLETED',
      'occurred_at', v_started + interval '1 millisecond',
      'agent_id', 'agent-root', 'correlation_id', 'corr-commit-final',
      'duration_ms', 1,
      'payload', jsonb_build_object('model_request_kind', 'loop', 'duration_ms', 1)
    ))
  );
  reset role;
  perform pg_temp.assert(
    (v_result ->> 'accepted')::integer = 1
      and (v_result ->> 'duplicated')::integer = 1,
    'a first-terminal-wins suppression is reported as a handled semantic duplicate'
  );
  perform pg_temp.assert(
    (select count(*) from public.analysis_runtime_event
     where agent_run_id = v_run and correlation_id = 'corr-commit-final'
       and phase = 'TERMINAL') = 1,
    'a late provider terminal cannot create a second terminal for one correlation'
  );

  -- 首个已落库终态的同 event_uuid 网络重试由 UUID 幂等计一次；不能再叠加 semantic duplicate。
  set local role service_role;
  v_result := public.report_analysis_runtime_event_batch(
    v_worker, v_job, v_task, v_token, v_attempt,
    jsonb_build_array(jsonb_build_object(
      'event_uuid', v_uuid, 'event_type', 'MODEL_REQUEST_COMPLETED',
      'occurred_at', v_started, 'agent_id', 'agent-root',
      'correlation_id', 'corr-commit-final', 'duration_ms', 1,
      'payload', jsonb_build_object('model_request_kind', 'loop', 'duration_ms', 1)
    ))
  );
  reset role;
  perform pg_temp.assert(
    (v_result ->> 'accepted')::integer = 1
      and (v_result ->> 'duplicated')::integer = 1,
    'a stored terminal event_uuid retry is counted once, not as both UUID and semantic duplicate'
  );

  ---------------------------------------------------------------------------
  -- C10. event_day 对重试与时钟钳制都是确定性的
  ---------------------------------------------------------------------------
  set local role service_role;
  perform public.report_analysis_runtime_event_batch(
    v_worker, v_job, v_task, v_token, v_attempt,
    jsonb_build_array(jsonb_build_object(
      'event_uuid', '32000000-0000-4000-f000-000000000002',
      'event_type', 'ACP_TURN_STARTED',
      -- 远未来时间：必须被钳制、置 clock_skewed，而不是被丢弃。
      'occurred_at', now() + interval '10 days'
    ))
  );
  reset role;
  select clock_skewed into v_skewed from public.analysis_runtime_event
  where event_uuid = '32000000-0000-4000-f000-000000000002';
  perform pg_temp.assert(
    v_skewed, 'an out-of-range occurred_at is kept but flagged as clock_skewed'
  );
  perform pg_temp.assert(
    (select event_day = occurred_at::date from public.analysis_runtime_event
     where event_uuid = '32000000-0000-4000-f000-000000000002'),
    'event_day is derived from the clamped occurred_at'
  );
  perform pg_temp.assert(
    (select event_day = current_date from public.analysis_runtime_event
     where event_uuid = '32000000-0000-4000-f000-000000000002'),
    'the clamp target is deterministic (today), so a retry lands on the same event_day'
  );

  ---------------------------------------------------------------------------
  -- C11. 归因数据集：可重叠的工具区间 + 模型区间 + setup / teardown 边界
  ---------------------------------------------------------------------------
  set local role service_role;
  perform public.report_analysis_runtime_event_batch(
    v_worker, v_job, v_task, v_token, v_attempt,
    jsonb_build_array(
      jsonb_build_object(
        'event_uuid', gen_random_uuid(), 'event_type', 'ATTEMPT_STARTED',
        'occurred_at', v_started
      ),
      jsonb_build_object(
        'event_uuid', gen_random_uuid(), 'event_type', 'HARNESS_PROCESS_STARTED',
        'occurred_at', v_started + interval '30 seconds'
      ),
      jsonb_build_object(
        'event_uuid', gen_random_uuid(), 'event_type', 'TOOL_CALL_STARTED',
        'occurred_at', v_started + interval '60 seconds', 'agent_id', 'agent-root',
        'correlation_id', 'corr-T1', 'payload', jsonb_build_object('tool_name', 'bash')
      ),
      jsonb_build_object(
        'event_uuid', gen_random_uuid(), 'event_type', 'TOOL_CALL_STARTED',
        'occurred_at', v_started + interval '90 seconds', 'agent_id', 'agent-child',
        'correlation_id', 'corr-T2', 'payload', jsonb_build_object('tool_name', 'edit')
      ),
      jsonb_build_object(
        'event_uuid', gen_random_uuid(), 'event_type', 'TOOL_CALL_COMPLETED',
        'occurred_at', v_started + interval '120 seconds', 'agent_id', 'agent-root',
        'correlation_id', 'corr-T1', 'duration_ms', 60000,
        'payload', jsonb_build_object('tool_name', 'bash', 'duration_ms', 60000)
      ),
      jsonb_build_object(
        'event_uuid', gen_random_uuid(), 'event_type', 'TOOL_CALL_COMPLETED',
        'occurred_at', v_started + interval '150 seconds', 'agent_id', 'agent-child',
        'correlation_id', 'corr-T2', 'duration_ms', 60000,
        'payload', jsonb_build_object('tool_name', 'edit', 'duration_ms', 60000)
      ),
      jsonb_build_object(
        'event_uuid', gen_random_uuid(), 'event_type', 'MODEL_REQUEST_STARTED',
        'occurred_at', v_started + interval '160 seconds', 'agent_id', 'agent-root',
        'correlation_id', 'corr-M1',
        'payload', jsonb_build_object('model_request_kind', 'loop')
      ),
      jsonb_build_object(
        'event_uuid', gen_random_uuid(), 'event_type', 'MODEL_REQUEST_COMPLETED',
        'occurred_at', v_started + interval '200 seconds', 'agent_id', 'agent-root',
        'correlation_id', 'corr-M1', 'duration_ms', 40000,
        'payload', jsonb_build_object(
          'model_request_kind', 'loop', 'input_tokens', 1000, 'output_tokens', 200,
          'duration_ms', 40000
        )
      ),
      -- provider 不报 token 时仍然要有终态（方案 §7.5）；token 保持 null。
      jsonb_build_object(
        'event_uuid', gen_random_uuid(), 'event_type', 'MODEL_REQUEST_COMPLETED',
        'occurred_at', v_started + interval '180 seconds', 'agent_id', 'agent-child',
        'correlation_id', 'corr-M2', 'duration_ms', 5000,
        'payload', jsonb_build_object('model_request_kind', 'retry', 'collapsed', true,
                                      'duration_ms', 5000)
      ),
      -- 一个永不闭合的工具调用：终态时必须被补写成 TOOL_CALL_CANCELLED。
      jsonb_build_object(
        'event_uuid', gen_random_uuid(), 'event_type', 'TOOL_CALL_STARTED',
        'occurred_at', v_started + interval '170 seconds', 'agent_id', 'agent-child',
        'correlation_id', 'corr-orphan', 'payload', jsonb_build_object('tool_name', 'web_fetch')
      ),
      jsonb_build_object(
        'event_uuid', gen_random_uuid(), 'event_type', 'ATTEMPT_INSTRUMENTATION_REPORTED',
        'occurred_at', now(),
        'payload', jsonb_build_object('events_reported', 42, 'events_dropped', 0)
      )
    )
  );
  reset role;

  perform pg_temp.assert(
    (select count(*) from public.analysis_runtime_intervals(v_run, array['TOOL'])) = 6,
    'every tool correlation reported so far is reconstructed'
  );
  perform pg_temp.assert(
    public.analysis_runtime_union_ms(v_run, array['TOOL']) = 90000,
    'the tool interval union merges the two overlapping calls into 90s'
  );
  perform pg_temp.assert(
    public.analysis_runtime_max_overlap(v_run, array['TOOL']) >= 2,
    'max concurrent tools sees the overlap'
  );
  perform pg_temp.assert(
    (select count(*) from public.analysis_runtime_intervals(v_run, array['MODEL', 'TOOL'])
     where not closed) = 1,
    'exactly one correlation is still open before convergence'
  );

  ---------------------------------------------------------------------------
  -- C12. 游标水位裁剪（§6.1.3）
  ---------------------------------------------------------------------------
  perform pg_temp.settle_events(v_batch);

  -- 现在再写一条"仍在未提交事务里"的事件（本事务的 xact_id 尚未提交）。
  set local role service_role;
  perform public.report_analysis_runtime_event_batch(
    v_worker, v_job, v_task, v_token, v_attempt,
    jsonb_build_array(jsonb_build_object(
      'event_uuid', gen_random_uuid(), 'event_type', 'SESSION_SLOT_ACQUIRED',
      'occurred_at', now()
    ))
  );
  reset role;
  select max(id) into v_event_id_2 from public.analysis_runtime_event where batch_id = v_batch;
  select max(id) into v_event_id from public.analysis_runtime_event
  where batch_id = v_batch and xact_id = 1;
  perform pg_temp.assert(
    v_event_id_2 > v_event_id, 'the unsettled event took a higher id than every settled one'
  );

  v_console := public.get_analysis_runtime_console(v_batch, null);
  perform pg_temp.assert(
    (v_console #>> '{cursor,next_event_id}')::bigint = v_event_id,
    'next_event_id stops at the newest event that passed the commit watermark'
  );
  perform pg_temp.assert(
    not exists (
      select 1 from jsonb_array_elements(v_console -> 'events') as event
      where (event ->> 'event_id')::bigint = v_event_id_2
    ),
    'an event whose writing transaction has not committed is never returned'
  );
  perform pg_temp.assert(
    (v_console #>> '{cursor,watermark_lag_ms}')::bigint >= 0
      and v_console #>> '{cursor,server_time}' is not null,
    'the cursor reports a watermark lag and a server time'
  );
  perform pg_temp.assert(
    (v_console #>> '{cursor,requires_full_snapshot}')::boolean = false,
    'a fresh snapshot does not demand a reset'
  );

  -- 逃生阀：超过 30 秒的事件即使未过水位也必须可见，否则一个长事务会卡住整条链路。
  update public.analysis_runtime_event
  set received_at = now() - interval '45 seconds'
  where id = v_event_id_2;
  v_console := public.get_analysis_runtime_console(v_batch, null);
  perform pg_temp.assert(
    (v_console #>> '{cursor,next_event_id}')::bigint = v_event_id_2,
    'the 30 second escape valve releases a long-pending event'
  );
  update public.analysis_runtime_event set xact_id = 1 where id = v_event_id_2;

  -- 增量补拉：cursor 之后的事件、以及受影响的 task 投影。
  v_console := public.get_analysis_runtime_console(v_batch, v_event_id);
  perform pg_temp.assert(
    jsonb_array_length(v_console -> 'events') = 1,
    'the cursor path returns only events after the cursor'
  );
  perform pg_temp.assert(
    (v_console #>> '{cursor,has_more}')::boolean = false,
    'a short cursor page reports has_more = false'
  );
  perform pg_temp.assert(
    (public.get_analysis_runtime_console(v_batch, -1) #>> '{cursor,requires_full_snapshot}')
      ::boolean = true,
    'a cursor older than the oldest surviving event demands a full snapshot'
  );

  -- 快照包含 Agent Tree、当前活动与未闭合 correlation。
  v_console := public.get_analysis_runtime_console(v_batch, null);
  perform pg_temp.assert(
    jsonb_array_length(v_console -> 'tasks') = 1
      and jsonb_array_length(v_console #> '{tasks,0,attempts}') = 1
      and jsonb_array_length(v_console #> '{tasks,0,attempts,0,agents}') = 2,
    'the snapshot walks batch -> task -> attempt -> agents'
  );
  perform pg_temp.assert(
    (select count(*) from jsonb_array_elements(v_console #> '{tasks,0,attempts,0,agents}') as agent
     where jsonb_array_length(agent -> 'open_correlations') > 0) = 1,
    'exactly one agent still has an unclosed correlation'
  );
  perform pg_temp.assert(
    (v_console #>> '{tasks,0,agent_status}') = 'RUNNING'
      and (v_console #>> '{tasks,0,attempts,0,attempt_phase_code}') is not null,
    'the task snapshot exposes agent_status and the attempt phase projection'
  );
  perform pg_temp.assert(
    not (v_console -> 'tasks' -> 0 ? 'retrieval_status')
      and not (v_console -> 'tasks' -> 0 ? 'analysis_status'),
    'the DTO never leaks the two legacy status columns'
  );
  perform pg_temp.assert(
    v_console::text not like '%cost_micros%', 'cost_micros never appears in the console DTO'
  );

  ---------------------------------------------------------------------------
  -- C13. 权限：ADMIN / 批次创建者可读，其他角色被拒
  ---------------------------------------------------------------------------
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', v_viewer::text, 'role', 'authenticated')::text, true
  );
  perform pg_temp.assert_raises(
    format('select public.get_analysis_runtime_console(%L, null)', v_batch),
    'batch management permission required', 'a VIEWER cannot read the runtime console'
  );
  perform pg_temp.assert_raises(
    'select public.admin_list_active_analysis_batches()',
    'ADMIN role required', 'a VIEWER cannot list active batches'
  );
  perform pg_temp.assert_raises(
    format('select public.get_analysis_attempt_diagnostics(%L, null)', v_task),
    'ADMIN role required', 'a VIEWER cannot run the diagnostic RPC'
  );

  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', v_reviewer::text, 'role', 'authenticated')::text, true
  );
  perform pg_temp.assert_raises(
    format('select public.get_analysis_runtime_console(%L, null)', v_batch),
    'batch management permission required',
    'a REVIEWER who does not own the batch cannot read the runtime console'
  );

  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', v_admin::text, 'role', 'authenticated')::text, true
  );
  perform pg_temp.assert(
    jsonb_array_length(public.admin_list_active_analysis_batches() -> 'batches') >= 1,
    'an ADMIN sees the active batches'
  );

  ---------------------------------------------------------------------------
  -- C14. Attempt 终态：原子事件 + 清投影 + 补写未闭合 correlation + 汇总
  ---------------------------------------------------------------------------
  set local role service_role;
  perform public.fail_agent_review(
    v_task, v_worker, v_token, 'HARNESS_PROCESS_CRASHED', 'harness exited unexpectedly'
  );
  reset role;

  perform pg_temp.assert(
    (select status from public.analysis_agent_run where id = v_run) = 'FAILED',
    'the business terminal state landed'
  );
  select count(*) into v_count from public.analysis_runtime_event
  where agent_run_id = v_run and event_type = 'ATTEMPT_FAILED';
  perform pg_temp.assert(v_count = 1, 'fail_agent_review writes ATTEMPT_FAILED in the same transaction');
  select count(*) into v_count from public.analysis_runtime_event
  where agent_run_id = v_run and event_type = 'TOOL_CALL_CANCELLED'
    and correlation_id = 'corr-orphan';
  perform pg_temp.assert(
    v_count = 1, 'the unclosed tool correlation is backfilled with TOOL_CALL_CANCELLED'
  );
  select count(*) into v_count from public.analysis_agent_node
  where agent_run_id = v_run
    and (current_activity_scope is not null or current_activity_status is not null
         or current_correlation_id is not null);
  perform pg_temp.assert(
    v_count = 0, 'no node keeps a running current_activity after the attempt terminal'
  );
  select count(*) into v_count from public.analysis_runtime_event
  where agent_run_id = v_run and event_type = 'AGENT_CANCELLED';
  perform pg_temp.assert(v_count = 2, 'both agent nodes emit a terminal agent event');
  perform pg_temp.assert(
    (select count(*) from public.analysis_runtime_intervals(v_run, array['MODEL', 'TOOL'])
     where not closed) = 0,
    'after convergence there is no unclosed correlation left'
  );

  ---------------------------------------------------------------------------
  -- C15. 汇总正确性：sum > union、busy <= wall、归因等式成立
  ---------------------------------------------------------------------------
  select * into v_rollup from public.analysis_agent_run_rollup where agent_run_id = v_run;
  perform pg_temp.assert(v_rollup.agent_run_id is not null, 'the attempt terminal wrote a rollup row');
  perform pg_temp.assert(v_rollup.rollup_version = 1, 'the rollup was computed, not just marked');
  perform pg_temp.assert(
    v_rollup.tool_ms_sum > v_rollup.tool_ms_union,
    'tool_ms_sum exceeds tool_ms_union because two agents overlapped'
  );
  perform pg_temp.assert(
    v_rollup.busy_ms_union <= v_rollup.wall_ms, 'busy_ms_union never exceeds wall_ms'
  );
  perform pg_temp.assert(
    v_rollup.setup_ms + v_rollup.busy_ms_union + v_rollup.teardown_ms
      + v_rollup.unattributed_ms = v_rollup.wall_ms,
    'the attribution equation holds exactly: setup + busy_union + teardown + unattributed = wall'
  );
  perform pg_temp.assert(
    v_rollup.setup_ms between 29000 and 31000,
    'setup_ms is the ATTEMPT_STARTED -> HARNESS_PROCESS_STARTED distance'
  );
  perform pg_temp.assert(
    v_rollup.terminal_status = 'FAILED'
      and v_rollup.terminal_error_code = 'HARNESS_PROCESS_CRASHED',
    'the rollup records the terminal status and stable error code'
  );
  perform pg_temp.assert(
    v_rollup.model_requests_by_kind ? 'loop' and v_rollup.model_requests_by_kind ? 'retry',
    'model requests are bucketed by kind'
  );
  perform pg_temp.assert(
    (v_rollup.tool_ms_by_name ? 'bash') and (v_rollup.tool_ms_by_name ? 'edit'),
    'tool wall time is attributed per tool name'
  );
  perform pg_temp.assert(
    jsonb_array_length(v_rollup.per_agent) = 2, 'the rollup carries a per-agent segment'
  );
  perform pg_temp.assert(
    v_rollup.events_reported = 42 and v_rollup.events_dropped = 0,
    'instrumentation health comes from the reported counters'
  );
  perform pg_temp.assert(
    v_rollup.max_concurrent_agents >= 2, 'two concurrently running agents are detected'
  );
  perform pg_temp.assert(
    v_rollup.harness_version = '0.1.5-rc.1' and v_rollup.policy_hash is not null
      and v_rollup.capability_contract_hash is not null,
    'the run fingerprint is stored for cross-run comparison'
  );

  ---------------------------------------------------------------------------
  -- C16. 汇总幂等与容错补算
  ---------------------------------------------------------------------------
  v_wall := v_rollup.wall_ms;
  set local role service_role;
  perform public.compute_analysis_run_rollup(v_run);
  reset role;
  select count(*) into v_count from public.analysis_agent_run_rollup where agent_run_id = v_run;
  perform pg_temp.assert(v_count = 1, 'recomputing the rollup keeps exactly one row');
  perform pg_temp.assert(
    (select computed_at from public.analysis_agent_run_rollup where agent_run_id = v_run)
      >= v_rollup.computed_at,
    'recomputation refreshes computed_at'
  );

  update public.analysis_agent_run_rollup set rollup_version = 0 where agent_run_id = v_run;
  set local role service_role;
  v_result := public.backfill_analysis_run_rollups(50);
  reset role;
  perform pg_temp.assert(
    (v_result->>'computed')::integer >= 1, 'backfill recomputes rollup_version = 0 rows'
  );
  perform pg_temp.assert(
    (select rollup_version from public.analysis_agent_run_rollup where agent_run_id = v_run) = 1,
    'the pending marker is cleared by the backfill'
  );

  ---------------------------------------------------------------------------
  -- C17. 诊断 RPC
  ---------------------------------------------------------------------------
  set local role service_role;
  v_diag := public.get_analysis_attempt_diagnostics(v_task, null);
  reset role;
  perform pg_temp.assert(
    v_diag #>> '{fingerprint,model_label}' is not null
      or v_diag ? 'fingerprint', 'the diagnostic pack carries a run fingerprint'
  );
  perform pg_temp.assert(
    (v_diag #>> '{attribution,wall_ms}')::integer = v_wall,
    'the diagnostic attribution matches the rollup'
  );
  perform pg_temp.assert(
    (v_diag ->> 'timeline_truncated')::boolean = false,
    'a small attempt is not truncated'
  );
  perform pg_temp.assert(
    jsonb_array_length(v_diag -> 'slowest_tools') >= 3
      and jsonb_array_length(v_diag -> 'phases') >= 3,
    'the diagnostic pack exposes slowest tools and the phase sequence'
  );
  perform pg_temp.assert(
    v_diag #>> '{instrumentation_health,events_reported}' = '42'
      and v_diag #>> '{instrumentation_health,events_dropped}' = '0',
    'the diagnostic pack states its own credibility first'
  );
  perform pg_temp.assert(
    jsonb_array_length(v_diag -> 'open_at_end') = 0,
    'nothing is left open at the end of a properly sealed attempt'
  );
  perform pg_temp.assert(
    v_diag::text not like '%/Users/%' and v_diag::text not like '%sk-live%',
    'the diagnostic pack contains no absolute path or credential'
  );

  set local role service_role;
  perform pg_temp.assert(
    jsonb_array_length(
      public.get_analysis_run_trend(array['model_label', 'policy_hash'],
        now() - interval '1 day', null, null) -> 'groups'
    ) >= 1,
    'the trend RPC groups whitelisted dimensions'
  );
  perform pg_temp.assert_raises(
    'select public.get_analysis_run_trend(array[''wall_ms; drop table x''], now() - interval ''1 day'')',
    'TREND_GROUP_BY_INVALID',
    'a group-by dimension outside the whitelist is refused, never concatenated into SQL'
  );
  perform pg_temp.assert_raises(
    'select public.get_analysis_run_trend(array[''model_label''], now(), null, ''MAYBE'')',
    'TREND_TERMINAL_STATUS_INVALID', 'the terminal status filter is validated'
  );

  v_result := public.get_analysis_runtime_findings(null, now() - interval '1 day');
  reset role;
  perform pg_temp.assert(
    v_result ? 'findings', 'the findings RPC returns a findings array'
  );

  ---------------------------------------------------------------------------
  -- C17a. §15 门槛：unattributed 超过 40% 时必须自己报出来，并给出下一步插桩位置
  ---------------------------------------------------------------------------
  -- 把这次 attempt 的归因改成"一半时间无法解释"，其余桶等比缩小以保持等式成立。
  update public.analysis_agent_run_rollup
  set unattributed_ms = (wall_ms * 0.5)::integer,
      busy_ms_union = (wall_ms * 0.5)::integer - setup_ms - teardown_ms
  where agent_run_id = v_run;

  set local role service_role;
  v_result := public.get_analysis_runtime_findings(null, now() - interval '1 day');
  reset role;
  perform pg_temp.assert(
    exists (
      select 1 from jsonb_array_elements(v_result -> 'findings') as finding
      where finding ->> 'code' = 'HIGH_UNATTRIBUTED_TIME'
        and (finding ->> 'agent_run_id')::uuid = v_run
    ),
    'unattributed_ms / wall_ms > 0.4 时 findings 主动报 HIGH_UNATTRIBUTED_TIME'
  );
  set local role service_role;
  v_diag := public.get_analysis_attempt_diagnostics(v_task, null);
  reset role;
  perform pg_temp.assert(
    (v_diag #>> '{instrumentation_health,unattributed_pct}')::numeric >= 40,
    '诊断包如实报出偏高的 unattributed_pct，不把它摊进其它桶'
  );
  perform pg_temp.assert(
    jsonb_array_length(v_diag -> 'instrumentation_gaps') >= 4
      and (select bool_and(gap ? 'code' and gap ? 'reason' and gap ? 'falls_into')
           from jsonb_array_elements(v_diag -> 'instrumentation_gaps') as gap),
    'unattributed 偏高时诊断包同时给出"下一步该插哪里"的机器可读清单'
  );

  -- 还原成真实值，后面的断言仍然基于真实归因。
  set local role service_role;
  perform public.compute_analysis_run_rollup(v_run);
  reset role;
  perform pg_temp.assert(
    (select setup_ms + busy_ms_union + teardown_ms + unattributed_ms = wall_ms
     from public.analysis_agent_run_rollup where agent_run_id = v_run),
    '重算后归因等式仍然成立'
  );

  ---------------------------------------------------------------------------
  -- C17b. §1.2 的 AI 诊断问题逐条走一遍（不是纸面声明）
  --
  --   §15 上线门槛要求"§1.2 表里每个 AI 诊断问题都能被 §6.10 的某个 RPC 实际回答"。
  --   下面每个断言对应表里一行；断言不过就说明那一行是空头承诺。
  ---------------------------------------------------------------------------
  set local role service_role;
  v_diag := public.get_analysis_attempt_diagnostics(v_task, null);
  v_result := public.get_analysis_run_trend(
    array['model_label', 'policy_hash'], now() - interval '1 day', null, null
  );
  reset role;

  -- 归因①：这次 attempt 共 N 分钟，分别花在准备、模型、工具、收敛、无法解释各多少。
  perform pg_temp.assert(
    v_diag #> '{attribution,wall_ms}' is not null
      and v_diag #> '{attribution,setup_ms}' is not null
      and v_diag #> '{attribution,model_ms_union}' is not null
      and v_diag #> '{attribution,tool_ms_union}' is not null
      and v_diag #> '{attribution,teardown_ms}' is not null
      and v_diag #> '{attribution,unattributed_ms}' is not null,
    'Q1 时间花在哪：attribution 五个桶全部可读'
  );
  -- 归因②：哪个工具、哪个 Agent、哪次模型请求吃掉了最多墙钟时间。
  perform pg_temp.assert(
    jsonb_array_length(v_diag -> 'slowest_tools') > 0
      and (v_diag #>> '{slowest_tools,0,duration_ms}')::bigint >= 0
      and (v_diag #>> '{slowest_tools,0,tool_name}') is not null
      and jsonb_array_length(v_diag -> 'slowest_model_requests') > 0,
    'Q2 谁最慢：slowest_tools / slowest_model_requests 带工具名与耗时'
  );
  perform pg_temp.assert(
    exists (
      select 1 from jsonb_array_elements(v_diag -> 'agents') as agent
      where agent ? 'tool_ms' and agent ? 'model_ms'
    ),
    'Q2 谁最慢（按 Agent）：per-agent 段带 tool_ms / model_ms'
  );
  -- 归因③：有多少时间是"Agent 已注册但没有任何未闭合请求"的空转。
  perform pg_temp.assert(
    v_diag #> '{attribution,agent_idle_ms}' is not null
      and exists (
        select 1 from jsonb_array_elements(v_diag -> 'agents') as agent where agent ? 'idle_ms'
      ),
    'Q3 空转：agent_idle_ms 与 per-agent idle_ms 都在'
  );
  -- 并发④：子 Agent 是真并行还是被串行化了。
  perform pg_temp.assert(
    (v_diag #>> '{attribution,max_concurrent_agents}')::integer >= 1
      and v_diag #> '{attribution,max_concurrent_tools}' is not null,
    'Q4 并行度：max_concurrent_agents / max_concurrent_tools 可读'
  );
  -- 回归⑤：同一模型、同一 policy 下，本周 attempt 比上周慢了多少。
  perform pg_temp.assert(
    jsonb_array_length(v_result -> 'groups') >= 1
      and (v_result #> '{groups,0,wall_ms_p95}') is not null
      and (v_result #> '{groups,0,wall_ms_p50}') is not null,
    'Q5 跨周对比：趋势 RPC 返回分组 p50/p95'
  );
  -- 回归⑥：我上次的优化生效了吗（按 profile / policy / harness 分组）。
  set local role service_role;
  perform pg_temp.assert(
    jsonb_array_length(
      public.get_analysis_run_trend(
        array['profile_config_hash', 'harness_version', 'capability_contract_hash'],
        now() - interval '1 day', null, null
      ) -> 'groups'
    ) >= 1,
    'Q6 优化前后对比：可按 profile / harness / contract 指纹分组'
  );
  reset role;
  -- 失败⑦：这个 error_code 历史上出现过几次，都在哪个阶段。
  perform pg_temp.assert(
    exists (
      select 1 from jsonb_array_elements(v_diag -> 'failures') as failure
      where failure ? 'occurrences' and failure ? 'first_seen_at' and failure ? 'event_type'
    )
    and (v_result #> '{groups,0,terminal_error_codes}') is not null,
    'Q7 错误码历史：failures 按码聚合 + 趋势里有 terminal_error_codes 分布'
  );
  -- 失败⑧：失败的 attempt 在失败前最后一个成功边界是什么。
  perform pg_temp.assert(
    jsonb_array_length(v_diag -> 'phases') >= 3
      and (v_diag #>> '{phases,0,occurred_at}') is not null,
    'Q8 最后一个成功边界：phases 是可倒查的阶段序列'
  );
  -- 浪费⑨：有多少模型请求是 retry / compaction，即非有效推进。
  perform pg_temp.assert(
    (v_diag #> '{attribution,model_requests_by_kind}') ? 'retry'
      or (v_diag #> '{attribution,model_requests_by_kind}') ? 'loop',
    'Q9 非有效推进：model_requests_by_kind 分桶可读'
  );
  -- 浪费⑩：子 Agent 冲撞提交权、被角色策略拒绝了多少次。
  perform pg_temp.assert(
    (select count(*) from public.analysis_runtime_event
     where agent_run_id = v_run and event_type = 'TOOL_CALL_DENIED') >= 0
      and (select tool_calls_denied from public.analysis_agent_run_rollup
           where agent_run_id = v_run) is not null,
    'Q10 提交权冲撞：TOOL_CALL_DENIED 计数 + 汇总表 tool_calls_denied'
  );
  -- 浪费⑪：有没有 Agent 产出了 0 条证据却烧了大量预算。
  perform pg_temp.assert(
    exists (
      select 1 from jsonb_array_elements(v_diag -> 'agents') as agent
      where agent ? 'evidence_produced' and agent ? 'model_requests'
    ),
    'Q11 零产出 Agent：per-agent 同时给出 evidence_produced 与 model_requests'
  );
  -- 盲区⑫：我们的插桩有没有漏。
  perform pg_temp.assert(
    v_diag #> '{instrumentation_health,unattributed_pct}' is not null
      and jsonb_array_length(v_diag -> 'instrumentation_gaps') > 0
      and exists (
        select 1 from jsonb_array_elements(v_diag -> 'instrumentation_gaps') as gap
        where gap ->> 'code' = 'DB_ROUNDTRIP_NOT_INSTRUMENTED'
          and gap ->> 'falls_into' = 'unattributed_ms'
      ),
    'Q12 盲区：unattributed_pct + 机器可读的 instrumentation_gaps 清单'
  );
  -- 环境⑬：慢是模型侧还是平台侧。
  --
  --   §1.2 把依据写成 model_ms_union / tool_ms_union / db_ms，但 db_ms 在 §6.9.1 的表结构里
  --   根本不存在。这里按真实语义拆成"模型侧 / 平台工具侧 / Harness 工具侧"，
  --   而"数据库往返"这一项作为已知盲区显式登记在 instrumentation_gaps 里 ——
  --   不造一个名字像、语义不对的数字。
  perform pg_temp.assert(
    v_diag #> '{attribution,model_ms_union}' is not null
      and v_diag #> '{attribution,platform_tool_ms_union}' is not null
      and v_diag #> '{attribution,harness_tool_ms_union}' is not null,
    'Q13 模型侧 vs 平台侧：三项耗时可分别读出'
  );
  perform pg_temp.assert(
    (v_diag #>> '{attribution,platform_tool_ms_union}')::bigint
      + (v_diag #>> '{attribution,harness_tool_ms_union}')::bigint
      = (v_diag #>> '{attribution,tool_ms_union}')::bigint,
    'Q13 平台侧 + Harness 侧 = 工具总并集，没有第三个隐藏桶'
  );
  -- 可比性⑭：两次 run 的差异只在哪个维度。
  perform pg_temp.assert(
    v_diag #> '{fingerprint,harness_version}' is not null
      and v_diag #> '{fingerprint,capability_contract_hash}' is not null
      and v_diag #> '{fingerprint,policy_hash}' is not null
      and (v_diag -> 'fingerprint') ? 'profile_config_hash'
      and (v_diag -> 'fingerprint') ? 'model_label',
    'Q14 run 指纹：模型路由 + 四个 hash 齐全'
  );

  ---------------------------------------------------------------------------
  -- C17c. §10.4 敏感信息泄漏扫描（对整份 DTO，而不是抽查几个字段）
  --
  --   分两类扫：
  --     * 禁止的 **键名**，按 `"key":` 精确匹配。不能按裸子串匹配 ——
  --       `prompt_version` 是 run 指纹的合法字段，按子串扫 'prompt' 会把它误判。
  --     * 禁止的 **内容形态**，按子串匹配（凭据、URL、绝对路径、session locator）。
  ---------------------------------------------------------------------------
  v_console := public.get_analysis_runtime_console(v_batch, null);
  foreach v_text in array array[
    'prompt', 'stdout', 'stderr', 'command', 'arguments', 'response',
    'api_key', 'apikey', 'secret', 'password', 'authorization', 'cookie',
    'storage_locator', 'claim_token', 'claim_token_digest', 'agent_capability',
    'file_path', 'workspace_path', 'url', 'query',
    'cost_micros',                          -- §4.4：不接入计费
    'retrieval_status', 'analysis_status',  -- §4.3：另两套历史状态列
    'error_message'                         -- 原始异常 message 绝不进监控 DTO
  ] loop
    perform pg_temp.assert(
      position(format('"%s":', v_text) in lower(v_console::text)) = 0,
      format('runtime console DTO 不含禁止键名：%s', v_text)
    );
    perform pg_temp.assert(
      position(format('"%s":', v_text) in lower(v_diag::text)) = 0,
      format('attempt diagnostics DTO 不含禁止键名：%s', v_text)
    );
  end loop;

  foreach v_text in array array[
    'bearer ',                    -- Authorization 头
    'eyj',                        -- JWT
    'sk-',                        -- 模型密钥
    'glpat-', 'gldeploy-',        -- GitLab 凭据
    'https://', 'http://',        -- 完整 URL 与 query string
    '/users/', '/home/', '/workspace/', '/tmp/crp-',
    '.jsonl'                      -- Session locator
  ] loop
    perform pg_temp.assert(
      position(v_text in lower(v_console::text)) = 0,
      format('runtime console DTO 不含敏感内容形态：%s', v_text)
    );
    perform pg_temp.assert(
      position(v_text in lower(v_diag::text)) = 0,
      format('attempt diagnostics DTO 不含敏感内容形态：%s', v_text)
    );
  end loop;

  -- prompt_version 是合法的指纹字段：确认上面的键名扫描没有把它连带干掉。
  perform pg_temp.assert(
    (v_diag -> 'fingerprint') ? 'prompt_version',
    'prompt_version 作为 run 指纹字段仍然保留（键名扫描不误伤它）'
  );

  -- 事件表本身也扫一遍：allowlist 是在写入侧生效的，这里验证结果。
  perform pg_temp.assert(
    not exists (
      select 1 from public.analysis_runtime_event
      where payload::text ~* '(bearer |eyj|sk-|api_key|apikey|secret|password|https?://|/users/|/home/|/workspace/|\.jsonl)'
    ),
    'analysis_runtime_event.payload 全表无凭据、URL、绝对路径或 session locator'
  );

  ---------------------------------------------------------------------------
  -- C17d. §6.7 / §10.5：单次返回上限 500 条，超出时 has_more = true
  ---------------------------------------------------------------------------
  -- 直接批量写入是为了造量：这一段测的是**查询侧**的分页与游标语义，
  -- 写入侧的 allowlist 与 fencing 已由 C4/C6/C7/C8 覆盖。
  insert into public.analysis_runtime_event (
    event_uuid, xact_id, batch_id, job_id, task_id, agent_run_id, worker_id,
    scope, event_type, activity_code, phase, occurred_at, event_day
  )
  select
    gen_random_uuid(), 1, v_batch, v_job, v_task, v_run, v_worker,
    'ATTEMPT', 'ACP_TURN_STARTED', 'MODEL_ORCHESTRATION', null,
    now() - make_interval(secs => seq), (now() - make_interval(secs => seq))::date
  from generate_series(1, 620) as seq;

  select min(id) - 1 into v_event_id from public.analysis_runtime_event
  where batch_id = v_batch;
  v_console := public.get_analysis_runtime_console(v_batch, v_event_id);
  perform pg_temp.assert(
    jsonb_array_length(v_console -> 'events') = 500,
    '游标模式单次最多返回 500 条事件'
  );
  perform pg_temp.assert(
    (v_console #>> '{cursor,has_more}')::boolean = true,
    '超过一页时 has_more = true，前端据此立即继续补拉而不是等下一个 interval'
  );
  perform pg_temp.assert(
    (v_console #>> '{cursor,next_event_id}')::bigint
      = (select max((event ->> 'event_id')::bigint)
         from jsonb_array_elements(v_console -> 'events') as event),
    'next_event_id 等于本次返回的最大 id，不是表内 max(id)'
  );
  -- 快照模式的上限是 200 条：它服务"打开页面先看到最近发生了什么"。
  v_console := public.get_analysis_runtime_console(v_batch, null);
  perform pg_temp.assert(
    jsonb_array_length(v_console -> 'events') = 200,
    '快照模式返回最近 200 条事件'
  );

  ---------------------------------------------------------------------------
  -- C18. Retention：活动 Job 不清理、按 p_limit 限量、汇总表行数不变
  ---------------------------------------------------------------------------
  -- fail_agent_review 已经把第一个 Job 置为 FAILED（终态）；第二个批次留作活动 Job。
  perform pg_temp.assert(
    (select status from public.analysis_job where id = v_job) = 'FAILED',
    'the first job reached a terminal state'
  );
  update public.analysis_job
  set status = 'PREPARING_CODE', worker_id = v_worker, locked_at = now()
  where id = v_job_active;

  select count(*) into v_count from public.analysis_runtime_event where job_id = v_job_active;
  perform pg_temp.assert(v_count >= 1, 'the active job has runtime events of its own');

  select count(*) into v_rollup_rows from public.analysis_agent_run_rollup;

  -- 只把活动 Job 的事件标成过期：一条都不能被清掉。
  update public.analysis_runtime_event set retention_until = now() - interval '1 day'
  where job_id = v_job_active;
  set local role service_role;
  v_purged := public.purge_analysis_runtime_events(50000);
  reset role;
  perform pg_temp.assert(v_purged = 0, 'events of a non-terminal job are never purged');
  select count(*) into v_count from public.analysis_runtime_event where job_id = v_job_active;
  perform pg_temp.assert(v_count >= 1, 'the active job keeps every event');

  -- 终态 Job 的过期事件按 p_limit 限量删除。
  select count(*) into v_count from public.analysis_runtime_event where job_id = v_job;
  perform pg_temp.assert(v_count > 2, 'the terminal job has more than two events');
  update public.analysis_runtime_event set retention_until = now() - interval '1 day'
  where job_id = v_job;

  set local role service_role;
  v_purged := public.purge_analysis_runtime_events(1);
  reset role;
  perform pg_temp.assert(v_purged = 1, 'purge honours p_limit exactly');

  set local role service_role;
  v_purged := public.purge_analysis_runtime_events(100000);
  reset role;
  perform pg_temp.assert(v_purged >= 1, 'the remaining expired events of a terminal job are purged');
  select count(*) into v_count from public.analysis_runtime_event where job_id = v_job;
  perform pg_temp.assert(v_count = 0, 'all expired events of the terminal job are gone');
  select count(*) into v_count from public.analysis_runtime_event where job_id = v_job_active;
  perform pg_temp.assert(v_count >= 1, 'the active job survived the purge untouched');
  select count(*) into v_count from public.analysis_agent_run_rollup;
  perform pg_temp.assert(
    v_count = v_rollup_rows,
    'purging events leaves analysis_agent_run_rollup untouched: the baseline must survive'
  );
  perform pg_temp.assert(
    (select wall_ms from public.analysis_agent_run_rollup where agent_run_id = v_run) = v_wall,
    'the rollup still answers cross-month trend questions after its events expired'
  );
  -- §15 门槛：事件清理跑过一轮后，趋势查询仍然可用。
  -- 事件是可丢的细节，汇总是不可丢的基线 —— 这条断言就是那句话的可执行形式。
  set local role service_role;
  v_result := public.get_analysis_run_trend(
    array['model_label', 'policy_hash'], now() - interval '1 day', null, null
  );
  reset role;
  perform pg_temp.assert(
    jsonb_array_length(v_result -> 'groups') >= 1
      and (v_result #> '{groups,0,wall_ms_p95}') is not null,
    'purge 之后跨运行趋势查询仍然返回分组与 p95'
  );
  perform pg_temp.assert(
    (select count(*) from public.analysis_runtime_event where agent_run_id = v_run) = 0,
    '该 attempt 的原始事件确实已经被清掉了（趋势不是靠事件表答出来的）'
  );

  ---------------------------------------------------------------------------
  -- C19. 旧 Worker 兼容：不上报事件时业务链路完全不受影响
  ---------------------------------------------------------------------------
  select count(*) into v_count from public.analysis_story_task where job_id = v_job_active;
  perform pg_temp.assert(v_count = 1, 'the second job still has its story task');
  set local role service_role;
  perform pg_temp.assert(
    public.claim_next_story_task('worker-32-legacy', 900) is null,
    'a PREPARING_CODE job hands out no story task, exactly as before 0032'
  );
  reset role;

  raise notice 'runtime monitoring end-to-end assertions passed';
end;
$test$;

------------------------------------------------------------------------------
-- D. 成功标记
------------------------------------------------------------------------------

do $$
begin
  raise notice 'ALL_ANALYSIS_RUNTIME_MONITORING_TESTS_PASSED';
end;
$$;

select 'ALL_ANALYSIS_RUNTIME_MONITORING_TESTS_PASSED' as result;

rollback;
