-- 0027_v4_harness_all_capabilities_test.sql
-- 0001..0027 最终 schema 下的 V4 全能力治理面测试。
-- 以库属主执行；整个脚本在单事务中运行并最终 ROLLBACK。
--
-- 覆盖本方案第 10 节验收矩阵中由数据库负责的那些行：
--   默认能力（Policy 冻结、capability 全开、danger-full-access 不可达）；
--   一键启动（enqueue 单参数即冻结全部上下文）；
--   Spawn/Fork（lineage、depth、并发与总数上限）；
--   Submit（child 直接 / 伪造 root / 并行提交全部拒绝）；
--   Evidence（producer 归属、跨 tree 拒绝、Artifact 不能冒充现有实现）；
--   Budget（root + children + retry + compaction 不突破总 cap）；
--   Persistence（checkpoint、fencing、resume）；
--   Cancel（用户取消、stale reclaim 后旧 attempt 全面失效）；
--   UI/RBAC（VIEWER 只读、浏览器拿不到 service-role RPC）。
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

------------------------------------------------------------------------------
-- A. Schema、签名与授权
------------------------------------------------------------------------------

do $test$
declare
  v_signature text;
  v_count integer;
  v_v4_worker_rpcs text[] := array[
    'public.register_analysis_agent_node(uuid,text,uuid,integer,text,text,text,text,text,text)',
    'public.mark_analysis_agent_node_terminal(uuid,text,uuid,integer,text,text,text)',
    'public.reserve_analysis_agent_budget(uuid,text,uuid,integer,text,text,integer)',
    'public.commit_analysis_agent_usage(uuid,text,uuid,integer,jsonb,jsonb)',
    'public.append_analysis_tool_audit(uuid,text,uuid,integer,jsonb,jsonb)',
    'public.save_analysis_session_checkpoint(uuid,text,uuid,integer,text,integer,text,text,integer,text,text,text)',
    'public.load_resumable_analysis_attempt(uuid,text,uuid)',
    'public.save_analysis_artifact(uuid,text,uuid,integer,text,text,text,text,bigint,text)',
    'public.record_analysis_attempt_profile(uuid,text,uuid,integer,text,text,text,text,text,text,text)',
    'public.heartbeat_analysis_attempt(uuid,text,uuid,integer)'
  ];
  v_browser_rpcs text[] := array[
    'public.request_analysis_attempt_cancel(uuid,text)',
    'public.get_analysis_agent_run_detail(uuid)',
    'public.enqueue_analysis_job(uuid)'
  ];
  v_tables text[] := array[
    'analysis_agent_node', 'analysis_tool_audit', 'analysis_permission_decision',
    'analysis_session_checkpoint', 'analysis_artifact'
  ];
  v_table text;
begin
  -- 新 Worker RPC 存在且只有 service_role 能执行。
  foreach v_signature in array v_v4_worker_rpcs loop
    perform pg_temp.assert(
      to_regprocedure(v_signature) is not null,
      format('V4 worker RPC exists: %s', v_signature)
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

  -- 浏览器 RPC 存在，登录用户可执行，anon 不可。
  foreach v_signature in array v_browser_rpcs loop
    perform pg_temp.assert(
      to_regprocedure(v_signature) is not null,
      format('browser RPC exists: %s', v_signature)
    );
    perform pg_temp.assert(
      has_function_privilege('authenticated', v_signature, 'EXECUTE'),
      format('authenticated can execute: %s', v_signature)
    );
    perform pg_temp.assert(
      not has_function_privilege('anon', v_signature, 'EXECUTE'),
      format('anon cannot execute: %s', v_signature)
    );
  end loop;

  -- 关键点：修改过的 RPC 没有留下旧重载。多一个重载就等于多一条绕过 V4 校验的路径。
  select count(*) into v_count from pg_proc proc
  join pg_namespace ns on ns.oid = proc.pronamespace
  where ns.nspname = 'public' and proc.proname = 'save_agent_review_result';
  perform pg_temp.assert(v_count = 1, 'save_agent_review_result has exactly one signature');

  select count(*) into v_count from pg_proc proc
  join pg_namespace ns on ns.oid = proc.pronamespace
  where ns.nspname = 'public' and proc.proname = 'claim_next_story_task';
  perform pg_temp.assert(v_count = 1, 'claim_next_story_task has exactly one signature');

  select count(*) into v_count from pg_proc proc
  join pg_namespace ns on ns.oid = proc.pronamespace
  where ns.nspname = 'public' and proc.proname = 'enqueue_analysis_job';
  perform pg_temp.assert(v_count = 1, 'enqueue_analysis_job has exactly one signature');

  select count(*) into v_count from pg_proc proc
  join pg_namespace ns on ns.oid = proc.pronamespace
  where ns.nspname = 'public' and proc.proname ~ '_v4$';
  perform pg_temp.assert(v_count = 0, 'no _v4-suffixed overload remains');

  -- 新表启用了 RLS。
  foreach v_table in array v_tables loop
    select count(*) into v_count from pg_class cls
    join pg_namespace ns on ns.oid = cls.relnamespace
    where ns.nspname = 'public' and cls.relname = v_table and cls.relrowsecurity;
    perform pg_temp.assert(v_count = 1, format('%s has RLS enabled', v_table));
  end loop;

  -- Session checkpoint 与 permission decision 不给浏览器：前者含存储 locator。
  perform pg_temp.assert(
    not has_table_privilege('authenticated', 'public.analysis_session_checkpoint', 'SELECT')
      and not has_table_privilege('authenticated', 'public.analysis_permission_decision', 'SELECT'),
    'session checkpoints and permission decisions are not readable by the browser'
  );
end;
$test$;

------------------------------------------------------------------------------
-- B. 端到端治理面
------------------------------------------------------------------------------

do $test$
declare
  v_admin uuid := '27000000-0000-4000-a000-0000000000a1';
  v_viewer uuid := '27000000-0000-4000-a000-0000000000a2';
  v_model uuid := '27000000-0000-4000-b000-0000000000b1';
  v_secret uuid;
  v_batch uuid := '27000000-0000-4000-c000-0000000000c1';
  v_story uuid := '27000000-0000-4000-e000-0000000000e1';
  v_worker text := 'worker-27-v4';
  v_worker_b text := 'worker-27-v4-b';
  v_job uuid;
  v_task uuid;
  v_token uuid;
  v_attempt integer;
  v_envelope jsonb;
  v_policy jsonb;
  v_node jsonb;
  v_verdict jsonb;
  v_commit jsonb;
  v_detail jsonb;
  v_heartbeat jsonb;
  v_resume jsonb;
  v_run uuid;
  v_count integer;
  v_text text;
  v_i2 text;
  v_profile_hash text;
  v_submit_identity jsonb;
  v_ok boolean;
  v_i integer;
begin
  insert into auth.users (id, email) values
    (v_admin, 'admin_27_v4@example.com'),
    (v_viewer, 'viewer_27_v4@example.com')
  on conflict (id) do nothing;

  insert into public.user_profile (id, role) values (v_admin, 'ADMIN')
  on conflict (id) do update set role = 'ADMIN';
  insert into public.user_profile (id, role) values (v_viewer, 'VIEWER')
  on conflict (id) do update set role = 'VIEWER';

  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', v_admin::text, 'role', 'authenticated')::text,
    true
  );

  set local role service_role;
  v_secret := public.admin_vault_create_secret('sk-27-v4-test', 'ai_key_27_v4_test');
  reset role;

  insert into public.ai_model_config (
    id, display_name, base_url, model_name, api_key_secret_id,
    enabled, max_parallel_tasks, created_by,
    -- 小预算便于在测试里真正打满上限。
    agent_max_total_requests, agent_max_root_requests, agent_max_child_requests,
    agent_max_retry_requests, agent_max_compaction_requests,
    max_agents_per_attempt, max_delegation_depth
  ) values (
    v_model, 'Model 27 V4', 'https://model-27.example.com', 'model-27',
    v_secret, true, 4, v_admin,
    6, 3, 2, 1, 1,
    3, 1
  );

  insert into public.review_batch (
    id, name, week_code, status, default_branch, created_by, ai_model_config_id
  ) values (
    v_batch, 'V4 capability governance', 'WK-27-V4-001',
    'WAITING_AI_RESULT', 'feature_dev', v_admin, v_model
  );

  insert into public.review_story (
    id, batch_id, story_code, story_name, owners_text, source_data
  ) values (v_story, v_batch, 'ST-27-V4-001', 'V4 story', 'owner', '{}'::jsonb);

  ---------------------------------------------------------------------------
  -- B1. 一键启动：单参数 enqueue 冻结 policy_version、snapshot 与 hash。
  ---------------------------------------------------------------------------
  v_job := public.enqueue_analysis_job(v_batch);

  select policy_version, capability_policy_snapshot, policy_hash
    into v_attempt, v_policy, v_text
  from public.analysis_job where id = v_job;

  perform pg_temp.assert(v_attempt = 4, 'enqueue freezes policy_version = 4');
  perform pg_temp.assert(
    v_policy #>> '{version}' = '4', 'frozen snapshot carries the V4 version'
  );
  perform pg_temp.assert(v_text ~ '^[0-9a-f]{64}$', 'enqueue stores a policy hash');
  perform pg_temp.assert(
    v_text = public.v4_policy_hash(v_policy),
    'enqueue policy hash uses the Worker-compatible canonical JSON algorithm'
  );
  perform pg_temp.assert(
    (select capability_contract_hash from public.analysis_job where id = v_job) =
      (select manifest_hash from public.v4_harness_manifest where is_active),
    'enqueue freezes the active Harness manifest hash'
  );

  -- 默认开启：20 个能力布尔值全部为 true，用户没有勾选任何东西。
  select count(*) into v_count
  from jsonb_each(v_policy->'capabilities') entry
  where entry.value = 'true'::jsonb;
  perform pg_temp.assert(v_count = 20, 'all 20 V4 capabilities default to enabled');
  select count(*) into v_count
  from jsonb_each(v_policy->'capabilities') entry
  where entry.value <> 'true'::jsonb;
  perform pg_temp.assert(v_count = 0, 'no capability defaults to disabled');

  -- 不属于全能力的两项永远为假。
  perform pg_temp.assert(
    (v_policy #>> '{sandbox,dangerFullAccess}') = 'false',
    'danger-full-access is never part of the frozen policy'
  );
  perform pg_temp.assert(
    (v_policy #>> '{agents,allowOutOfProcessProviders}') = 'false',
    'out-of-process subagent providers stay off'
  );
  perform pg_temp.assert(
    (v_policy #>> '{sandbox,defaultMode}') = 'workspace-write',
    'shell defaults to workspace-write'
  );
  perform pg_temp.assert(
    (v_policy #>> '{parallelTools,mutationToolsSerial}') = 'true',
    'mutation tools stay serial'
  );
  perform pg_temp.assert(
    (v_policy #>> '{web,allowHttp}') = 'false'
      and (v_policy #>> '{web,denyPrivateNetworks}') = 'true',
    'web egress refuses plaintext and private networks'
  );

  -- 冻结即不可变。
  perform pg_temp.assert_raises(
    format('update public.analysis_job set policy_version = 3 where id = %L', v_job),
    'immutable',
    'policy_version cannot be changed after freezing'
  );
  perform pg_temp.assert_raises(
    format(
      'update public.analysis_job set capability_policy_snapshot = ''{"version":4}''::jsonb where id = %L',
      v_job
    ),
    'immutable',
    'the frozen capability snapshot cannot be rewritten'
  );

  update public.analysis_job set status = 'PROCESSING' where id = v_job;
  insert into public.analysis_repository_snapshot (
    job_id, repository_name, requested_branch, commit_sha
  ) values
    (v_job, 'kdmanage-backend', 'feature_dev', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
    (v_job, 'tmanage-backend', 'feature_dev', 'cccccccccccccccccccccccccccccccccccccccc');

  select id into v_task from public.analysis_story_task where job_id = v_job;

  ---------------------------------------------------------------------------
  -- B2. claim 返回完整 policy snapshot 与 fencing token。
  ---------------------------------------------------------------------------
  set local role service_role;
  v_envelope := public.claim_next_story_task(v_worker, 900);
  reset role;

  perform pg_temp.assert((v_envelope->>'id')::uuid = v_task, 'V4 task is claimed');
  perform pg_temp.assert(
    (v_envelope->>'policy_version')::integer = 4, 'claim reports the policy version'
  );
  perform pg_temp.assert(
    v_envelope->'capability_policy' #>> '{capabilities,workflow}' = 'true',
    'claim hands the worker the whole capability policy'
  );
  perform pg_temp.assert(
    (v_envelope->>'session_revision')::integer = 1, 'the first attempt starts at revision 1'
  );
  perform pg_temp.assert(v_envelope ? 'policy_hash', 'claim reports the policy hash');
  perform pg_temp.assert(v_envelope ? 'agent_run_id', 'claim reports the agent run id');

  v_token := (v_envelope->>'claim_token')::uuid;
  v_attempt := (v_envelope->>'agent_attempt')::integer;
  v_run := (v_envelope->>'agent_run_id')::uuid;

  ---------------------------------------------------------------------------
  -- B3. 回填 Harness / profile / policy 版本，并冻结 Harness 版本。
  ---------------------------------------------------------------------------
  set local role service_role;
  v_ok := public.record_analysis_attempt_profile(
    v_task, v_worker, v_token, v_attempt,
    '0.1.5-rc.1', (select capability_contract_hash from public.analysis_job where id = v_job), 'profile-hash-27',
    v_envelope->>'policy_hash', 'agent-root', 'session-root', 'tree-digest-1'
  );
  reset role;
  perform pg_temp.assert(v_ok, 'the worker can record the resolved profile identity');

  select harness_version, profile_hash into v_text, v_profile_hash
  from public.analysis_job where id = v_job;
  perform pg_temp.assert(v_text = '0.1.5-rc.1', 'Harness version is frozen on the job');
  perform pg_temp.assert(
    v_profile_hash = 'profile-hash-27', 'the resolved profile hash is recorded on the job'
  );

  perform pg_temp.assert_raises(
    format(
      'select public.record_analysis_attempt_profile(%L,%L,%L,%s,%L,%L,%L,%L,%L,%L,%L)',
      v_task, v_worker, v_token, v_attempt,
      '0.2.0', (select capability_contract_hash from public.analysis_job where id = v_job), 'profile-hash-27', v_envelope->>'policy_hash',
      'agent-root', 'session-root', 'tree-digest-1'
    ),
    'SESSION_FORMAT_UNSUPPORTED',
    'a second Harness version inside one job is refused'
  );
  perform pg_temp.assert_raises(
    format(
      'select public.record_analysis_attempt_profile(%L,%L,%L,%s,%L,%L,%L,%L,%L,%L,%L)',
      v_task, v_worker, v_token, v_attempt,
      '0.1.5-rc.1', 'contract-hash-drifted', 'profile-hash-27',
      v_envelope->>'policy_hash', 'agent-root', 'session-root', 'tree-digest-1'
    ),
    'SESSION_FORMAT_UNSUPPORTED',
    'a changed capability contract hash is refused'
  );

  -- 即使 Worker 持有合法 claim，没有注册 root 节点也不能利用 DB 提交路径。
  perform pg_temp.assert_raises(
    format(
      'select public.save_agent_review_result(%L,%L,%L,%s,%L::jsonb,%L::jsonb,%L::jsonb)',
      v_task, v_worker, v_token, v_attempt,
      '{"verdict":"IMPLEMENTED","confidence":90,"summary":"no root"}', '[]',
      jsonb_build_object(
        'root_agent_id', 'agent-root', 'root_session_id', 'session-root',
        'tree_digest', 'tree-digest-1', 'session_revision', 1,
        'policy_hash', v_envelope->>'policy_hash'
      )::text
    ),
    'SUBMIT_ROOT_ONLY',
    'a V4 attempt without a registered root fails closed'
  );

  ---------------------------------------------------------------------------
  -- B4. Agent Tree：root、lineage、depth 与总数上限。
  ---------------------------------------------------------------------------
  set local role service_role;
  v_node := public.register_analysis_agent_node(
    v_task, v_worker, v_token, v_attempt,
    'agent-root', 'session-root', null, 'root-reviewer', 'root', 'tool-policy-root'
  );
  reset role;
  perform pg_temp.assert(
    (v_node->>'delegation_depth')::integer = 0, 'the root node sits at depth 0'
  );

  -- 重复注册是幂等的，不会造出第二个 root。
  set local role service_role;
  v_verdict := public.register_analysis_agent_node(
    v_task, v_worker, v_token, v_attempt,
    'agent-root', 'session-root', null, 'root-reviewer', 'root', 'tool-policy-root'
  );
  reset role;
  perform pg_temp.assert(
    v_verdict->>'node_id' = v_node->>'node_id', 'registering the root twice is idempotent'
  );

  -- 父节点必须已注册：伪造 lineage 被拒绝。
  perform pg_temp.assert_raises(
    format(
      'select public.register_analysis_agent_node(%L,%L,%L,%s,%L,%L,%L,%L,%L,%L)',
      v_task, v_worker, v_token, v_attempt,
      'agent-ghost-child', 'session-ghost', 'agent-not-registered',
      'research-child', 'spawn', 'tool-policy-child'
    ),
    'AGENT_IDENTITY_INVALID',
    'a child cannot claim a parent that was never registered'
  );

  -- 无父节点的非 root 也被拒绝。
  perform pg_temp.assert_raises(
    format(
      'select public.register_analysis_agent_node(%L,%L,%L,%s,%L,%L,null,%L,%L,%L)',
      v_task, v_worker, v_token, v_attempt,
      'agent-orphan', 'session-orphan', 'research-child', 'spawn', 'tool-policy-child'
    ),
    'AGENT_IDENTITY_INVALID',
    'a spawn child must name its parent'
  );

  set local role service_role;
  v_node := public.register_analysis_agent_node(
    v_task, v_worker, v_token, v_attempt,
    'agent-child-1', 'session-child-1', 'agent-root',
    'research-child', 'spawn', 'tool-policy-child'
  );
  reset role;
  perform pg_temp.assert(
    (v_node->>'delegation_depth')::integer = 1, 'a spawn child sits one level deeper'
  );

  -- maxDelegationDepth = 1：孙节点必须被拒绝。
  perform pg_temp.assert_raises(
    format(
      'select public.register_analysis_agent_node(%L,%L,%L,%s,%L,%L,%L,%L,%L,%L)',
      v_task, v_worker, v_token, v_attempt,
      'agent-grandchild', 'session-grandchild', 'agent-child-1',
      'research-child', 'spawn', 'tool-policy-child'
    ),
    'AGENT_TREE_LIMIT_EXCEEDED',
    'delegation depth beyond the frozen limit is refused'
  );

  set local role service_role;
  perform public.register_analysis_agent_node(
    v_task, v_worker, v_token, v_attempt,
    'Agent-child-2', 'session-child-2', 'agent-root',
    'implementation-child', 'fork', 'tool-policy-impl'
  );
  reset role;

  -- maxAgentsPerAttempt = 3：第 4 个节点被拒绝。
  perform pg_temp.assert_raises(
    format(
      'select public.register_analysis_agent_node(%L,%L,%L,%s,%L,%L,%L,%L,%L,%L)',
      v_task, v_worker, v_token, v_attempt,
      'agent-child-3', 'session-child-3', 'agent-root',
      'critic-child', 'spawn', 'tool-policy-critic'
    ),
    'AGENT_TREE_LIMIT_EXCEEDED',
    'the agent count limit is enforced per attempt'
  );

  select agent_count, max_depth_reached into v_count, v_i
  from public.analysis_agent_run where id = v_run;
  perform pg_temp.assert(v_count = 3, 'the run tracks the live agent count');
  perform pg_temp.assert(v_i = 1, 'the run tracks the deepest delegation reached');

  -- 已结束的父节点不能再造子节点。
  set local role service_role;
  v_ok := public.mark_analysis_agent_node_terminal(
    v_task, v_worker, v_token, v_attempt, 'Agent-child-2', 'FINISHED'
  );
  reset role;
  perform pg_temp.assert(v_ok, 'a node can be marked terminal');
  perform pg_temp.assert_raises(
    format(
      'select public.register_analysis_agent_node(%L,%L,%L,%s,%L,%L,%L,%L,%L,%L)',
      v_task, v_worker, v_token, v_attempt,
      'agent-late', 'session-late', 'Agent-child-2',
      'research-child', 'spawn', 'tool-policy-child'
    ),
    'AGENT_TREE_CANCELLED',
    'a finished parent cannot spawn a late child'
  );

  ---------------------------------------------------------------------------
  -- B5. 分层预算：总量 hard cap 与分项上限都在 provider 之前生效。
  ---------------------------------------------------------------------------
  -- maxRootRequests = 3。
  for v_i in 1..3 loop
    set local role service_role;
    v_verdict := public.reserve_analysis_agent_budget(
      v_task, v_worker, v_token, v_attempt, 'agent-root', 'loop', 1
    );
    reset role;
    perform pg_temp.assert(
      (v_verdict->>'allowed')::boolean,
      format('root model request %s is admitted', v_i)
    );
  end loop;

  set local role service_role;
  v_verdict := public.reserve_analysis_agent_budget(
    v_task, v_worker, v_token, v_attempt, 'agent-root', 'loop', 1
  );
  reset role;
  perform pg_temp.assert(
    not (v_verdict->>'allowed')::boolean
      and v_verdict->>'code' = 'MODEL_BUDGET_EXHAUSTED'
      and v_verdict->>'scope' = 'root',
    'the root per-agent budget is enforced'
  );

  -- maxChildRequests = 2，按子 Agent 各自计。
  for v_i in 1..2 loop
    set local role service_role;
    v_verdict := public.reserve_analysis_agent_budget(
      v_task, v_worker, v_token, v_attempt, 'agent-child-1', 'loop', 1
    );
    reset role;
    perform pg_temp.assert((v_verdict->>'allowed')::boolean, 'child requests are admitted');
  end loop;

  set local role service_role;
  v_verdict := public.reserve_analysis_agent_budget(
    v_task, v_worker, v_token, v_attempt, 'agent-child-1', 'loop', 1
  );
  reset role;
  perform pg_temp.assert(
    v_verdict->>'scope' = 'child', 'the child per-agent budget is enforced'
  );

  -- 总量 = 6，已用 5；retry 还能占一个，之后 compaction 撞总量上限。
  set local role service_role;
  v_verdict := public.reserve_analysis_agent_budget(
    v_task, v_worker, v_token, v_attempt, 'agent-root', 'retry', 1
  );
  reset role;
  perform pg_temp.assert((v_verdict->>'allowed')::boolean, 'the retry budget is separate');

  set local role service_role;
  v_verdict := public.reserve_analysis_agent_budget(
    v_task, v_worker, v_token, v_attempt, 'agent-root', 'compaction', 1
  );
  reset role;
  perform pg_temp.assert(
    not (v_verdict->>'allowed')::boolean and v_verdict->>'scope' = 'total',
    'root + children + retry + compaction never exceed the total hard cap'
  );

  select model_requests, root_model_requests, child_model_requests, retry_requests
    into v_count, v_i, v_attempt, v_verdict
  from public.analysis_agent_run where id = v_run;
  perform pg_temp.assert(v_count = 6, 'the run records the real model request total');
  perform pg_temp.assert(v_i = 3, 'root requests are counted separately');
  perform pg_temp.assert(v_attempt = 2, 'child requests are counted separately');
  v_attempt := (select agent_attempt from public.analysis_story_task where id = v_task);

  -- 未注册的 Agent 拿不到预算。
  set local role service_role;
  v_verdict := public.reserve_analysis_agent_budget(
    v_task, v_worker, v_token, v_attempt, 'agent-unregistered', 'loop', 1
  );
  reset role;
  perform pg_temp.assert(
    v_verdict->>'code' = 'AGENT_IDENTITY_INVALID',
    'an unregistered agent cannot reserve budget'
  );

  ---------------------------------------------------------------------------
  -- B6. 工具审计与权限判定只存元数据。
  ---------------------------------------------------------------------------
  set local role service_role;
  v_count := public.append_analysis_tool_audit(
    v_task, v_worker, v_token, v_attempt,
    jsonb_build_array(
      jsonb_build_object(
        'agent_id', 'agent-child-1', 'session_id', 'session-child-1',
        'tool_call_id', 'call-1', 'tool_name', 'read_snapshot_code',
        'permission_verdict', 'ALLOW', 'duration_ms', 12,
        'request_bytes', 200, 'response_bytes', 4000
      ),
      jsonb_build_object(
        'agent_id', 'agent-child-1', 'tool_name', 'submit_review_result',
        'permission_verdict', 'DENY', 'error_code', 'SUBMIT_ROOT_ONLY'
      )
    ),
    jsonb_build_array(
      jsonb_build_object(
        'agent_id', 'agent-child-1', 'agent_role', 'research-child',
        'tool_name', 'submit_review_result', 'policy_layer', 'role',
        'decision', 'DENY', 'reason_code', 'SUBMIT_ROOT_ONLY'
      )
    )
  );
  reset role;
  perform pg_temp.assert(v_count = 3, 'tool audit and permission rows are appended');

  select count(*) into v_count from public.analysis_tool_audit
  where agent_run_id = v_run and permission_verdict = 'DENY';
  perform pg_temp.assert(v_count = 1, 'a denied tool call is audited');

  select count(*) into v_count from public.analysis_permission_decision
  where agent_run_id = v_run and reason_code = 'SUBMIT_ROOT_ONLY';
  perform pg_temp.assert(v_count = 1, 'the deny reason is recorded');

  ---------------------------------------------------------------------------
  -- B7. Session checkpoint 与 fencing。
  ---------------------------------------------------------------------------
  set local role service_role;
  v_verdict := public.save_analysis_session_checkpoint(
    v_task, v_worker, v_token, v_attempt, 'session-root', 1,
    '/sessions/attempt-27/session-root.jsonl', 'content-hash-1', 42, '0.1.5-rc.1',
    'profile-hash-27', 'OPEN'
  );
  reset role;
  perform pg_temp.assert(
    (v_verdict->>'session_revision')::integer = 1, 'a checkpoint records its revision'
  );

  set local role service_role;
  perform public.save_analysis_session_checkpoint(
    v_task, v_worker, v_token, v_attempt, 'session-root', 2,
    '/sessions/attempt-27/session-root.jsonl', 'content-hash-2', 90, '0.1.5-rc.1',
    'profile-hash-27', 'OPEN'
  );
  reset role;

  -- revision 只能前进：落后的写入来自被接管的旧 Worker。
  perform pg_temp.assert_raises(
    format(
      'select public.save_analysis_session_checkpoint(%L,%L,%L,%s,%L,1,%L,%L,10,%L)',
      v_task, v_worker, v_token, v_attempt, 'session-root',
      '/sessions/attempt-27/session-root.jsonl', 'content-hash-stale', '0.1.5-rc.1'
    ),
    'SESSION_FENCED',
    'a stale session revision is fenced'
  );

  select session_revision into v_count from public.analysis_agent_run where id = v_run;
  perform pg_temp.assert(v_count = 2, 'the run tracks the newest session revision');

  -- 同 Worker 重启后可以恢复，并且 revision 再前进一格。
  set local role service_role;
  v_resume := public.load_resumable_analysis_attempt(v_task, v_worker, v_token);
  reset role;
  perform pg_temp.assert(
    v_resume is not null and (v_resume->>'session_revision')::integer = 3,
    'a restarted worker resumes at the next revision'
  );
  perform pg_temp.assert(
    v_resume->>'storage_locator' = '/sessions/attempt-27/session-root.jsonl',
    'resume returns the JSONL locator, not the session body'
  );
  perform pg_temp.assert(
    (v_resume->>'resume_count')::integer = 1, 'resume attempts are counted'
  );

  -- 别的 Worker 拿不到这个 Session。
  set local role service_role;
  perform pg_temp.assert(
    public.load_resumable_analysis_attempt(v_task, v_worker_b, v_token) is null,
    'another worker cannot resume this session'
  );
  reset role;

  ---------------------------------------------------------------------------
  -- B8. Artifact：属于当前 tree，且不能冒充现有实现。
  ---------------------------------------------------------------------------
  set local role service_role;
  v_verdict := public.save_analysis_artifact(
    v_task, v_worker, v_token, v_attempt, 'agent-child-1',
    'PATCH', 'overlay/kdmanage-backend/fix.patch', 'artifact-hash-1', 2048
  );
  reset role;
  perform pg_temp.assert(v_verdict ? 'artifact_id', 'an artifact is stored with its producer');

  perform pg_temp.assert_raises(
    format(
      'select public.save_analysis_artifact(%L,%L,%L,%s,%L,%L,%L,%L,10)',
      v_task, v_worker, v_token, v_attempt, 'agent-not-in-tree',
      'PATCH', 'overlay/x.patch', 'artifact-hash-2'
    ),
    'AGENT_IDENTITY_INVALID',
    'an artifact cannot be attributed to an agent outside the tree'
  );

  ---------------------------------------------------------------------------
  -- B9. 提交：只有已注册的 root 能提交。
  ---------------------------------------------------------------------------
  set local role service_role;
  v_text := public.analysis_agent_tree_digest(v_run);
  reset role;
  -- 这个值由 TypeScript 侧的 AgentAuthorityLedger.treeDigest() 对同一批节点算出，两侧必须逐字
  -- 一致（同样的字段、同样的 '|' 分隔、同样的字节序排序）。迁移 0028 之后摘要不再含节点状态。
  perform pg_temp.assert(
    v_text = 'a041ed448d6f53a32c022dfa4f84b9e6b822b6e289c10613742a251c78d19f60',
    'the PostgreSQL tree digest uses C ordering and matches TypeScript for mixed-case agent ids'
  );

  -- 摘要必须与节点状态无关（迁移 0028）。
  --
  -- 曾经是相关的，代价是一条真实的误拒路径：子 Agent 结束时的 finish-agent 上报失败、或子
  -- Agent 恰好与提交并发结束时，Worker 侧算 FINISHED、数据库侧算 RUNNING，两者不等 →
  -- save_agent_review_result 抛 AGENT_IDENTITY_INVALID，一次完全合法的提交在模型费用花完之后
  -- 被拒。这里把 agent-child-1 也标成终态，摘要必须不变。
  set local role service_role;
  v_ok := public.mark_analysis_agent_node_terminal(
    v_task, v_worker, v_token, v_attempt, 'agent-child-1', 'CANCELLED'
  );
  v_i2 := public.analysis_agent_tree_digest(v_run);
  reset role;
  perform pg_temp.assert(v_ok, 'a running child can be marked terminal');
  perform pg_temp.assert(
    v_i2 = v_text,
    'the tree digest must not change when a node status changes'
  );
  v_submit_identity := jsonb_build_object(
    'root_agent_id', 'agent-root',
    'root_session_id', 'session-root',
    'tree_digest', v_text,
    'session_revision', 3,
    'policy_hash', v_envelope->>'policy_hash'
  );

  -- 子 Agent 伪装成 root。
  perform pg_temp.assert_raises(
    format(
      'select public.save_agent_review_result(%L,%L,%L,%s,%L::jsonb,%L::jsonb,%L::jsonb)',
      v_task, v_worker, v_token, v_attempt,
      '{"verdict":"IMPLEMENTED","confidence":90,"summary":"child tried"}',
      '[]',
      (v_submit_identity || jsonb_build_object('root_agent_id', 'agent-child-1'))::text
    ),
    'SUBMIT_ROOT_ONLY',
    'a child agent identity cannot commit the review'
  );

  -- 完全不报身份。
  perform pg_temp.assert_raises(
    format(
      'select public.save_agent_review_result(%L,%L,%L,%s,%L::jsonb,%L::jsonb)',
      v_task, v_worker, v_token, v_attempt,
      '{"verdict":"IMPLEMENTED","confidence":90,"summary":"anonymous"}', '[]'
    ),
    'SUBMIT_ROOT_ONLY',
    'an anonymous submission is refused once a root node is registered'
  );

  -- root id 正确但 session 不符。
  perform pg_temp.assert_raises(
    format(
      'select public.save_agent_review_result(%L,%L,%L,%s,%L::jsonb,%L::jsonb,%L::jsonb)',
      v_task, v_worker, v_token, v_attempt,
      '{"verdict":"IMPLEMENTED","confidence":90,"summary":"wrong session"}', '[]',
      (v_submit_identity || jsonb_build_object('root_session_id', 'session-forged'))::text
    ),
    'SUBMIT_ROOT_ONLY',
    'a forged root session is refused'
  );

  -- policy hash 不符（profile 被换过）。
  perform pg_temp.assert_raises(
    format(
      'select public.save_agent_review_result(%L,%L,%L,%s,%L::jsonb,%L::jsonb,%L::jsonb)',
      v_task, v_worker, v_token, v_attempt,
      '{"verdict":"IMPLEMENTED","confidence":90,"summary":"wrong policy"}', '[]',
      (v_submit_identity || jsonb_build_object(
        'policy_hash', '0000000000000000000000000000000000000000000000000000000000000000'
      ))::text
    ),
    'AGENT_IDENTITY_INVALID',
    'a submission carrying a foreign policy hash is refused'
  );

  -- 落后的 session revision。
  perform pg_temp.assert_raises(
    format(
      'select public.save_agent_review_result(%L,%L,%L,%s,%L::jsonb,%L::jsonb,%L::jsonb)',
      v_task, v_worker, v_token, v_attempt,
      '{"verdict":"IMPLEMENTED","confidence":90,"summary":"stale"}', '[]',
      (v_submit_identity || jsonb_build_object('session_revision', 1))::text
    ),
    'SESSION_FENCED',
    'a submission from a fenced session revision is refused'
  );

  -- 未来 revision 同样不能越过当前数据库 fence。
  perform pg_temp.assert_raises(
    format(
      'select public.save_agent_review_result(%L,%L,%L,%s,%L::jsonb,%L::jsonb,%L::jsonb)',
      v_task, v_worker, v_token, v_attempt,
      '{"verdict":"IMPLEMENTED","confidence":90,"summary":"future"}', '[]',
      (v_submit_identity || jsonb_build_object('session_revision', 99))::text
    ),
    'SESSION_FENCED',
    'a future session revision cannot advance the database fence during submit'
  );

  -- tree digest 必须由数据库按已注册 lineage 独立重算。
  perform pg_temp.assert_raises(
    format(
      'select public.save_agent_review_result(%L,%L,%L,%s,%L::jsonb,%L::jsonb,%L::jsonb)',
      v_task, v_worker, v_token, v_attempt,
      '{"verdict":"IMPLEMENTED","confidence":90,"summary":"forged tree"}', '[]',
      (v_submit_identity || jsonb_build_object('tree_digest', repeat('0', 64)))::text
    ),
    'AGENT_IDENTITY_INVALID',
    'a forged Agent Tree digest is refused'
  );

  -- Artifact 冒充现有实现证据。
  perform pg_temp.assert_raises(
    format(
      'select public.save_agent_review_result(%L,%L,%L,%s,%L::jsonb,%L::jsonb,%L::jsonb)',
      v_task, v_worker, v_token, v_attempt,
      '{"verdict":"IMPLEMENTED","confidence":90,"summary":"artifact as proof"}',
      json_build_array(json_build_object(
        'evidence_id', 'ev-artifact', 'repository_name', 'kdmanage-backend',
        'commit_sha', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        'file_path', 'src/New.java', 'blob_sha', repeat('1', 40),
        'start_line', 1, 'end_line', 5, 'content_hash', 'h',
        'evidence_type', '现有实现', 'description', 'generated',
        'evidence_origin', 'GENERATED_ARTIFACT'
      ))::text,
      v_submit_identity::text
    ),
    'EVIDENCE_ORIGIN_INVALID',
    'a generated artifact cannot prove an existing implementation'
  );

  -- 证据的 producer 不在当前 tree 内。
  perform pg_temp.assert_raises(
    format(
      'select public.save_agent_review_result(%L,%L,%L,%s,%L::jsonb,%L::jsonb,%L::jsonb)',
      v_task, v_worker, v_token, v_attempt,
      '{"verdict":"IMPLEMENTED","confidence":90,"summary":"foreign producer"}',
      json_build_array(json_build_object(
        'evidence_id', 'ev-foreign', 'repository_name', 'kdmanage-backend',
        'commit_sha', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        'file_path', 'src/Order.java', 'blob_sha', repeat('2', 40),
        'start_line', 1, 'end_line', 5, 'content_hash', 'h',
        'evidence_type', '现有实现', 'description', 'from another tree',
        'producer_agent_id', 'agent-from-another-attempt'
      ))::text,
      v_submit_identity::text
    ),
    'EVIDENCE_AGENT_INVALID',
    'evidence produced outside this agent tree is refused'
  );

  ---------------------------------------------------------------------------
  -- B10. root 提交成功：child 证据被采纳，attempt 被封存。
  ---------------------------------------------------------------------------
  set local role service_role;
  v_commit := public.save_agent_review_result(
    v_task, v_worker, v_token, v_attempt,
    jsonb_build_object('verdict', 'IMPLEMENTED', 'confidence', 92, 'summary', 'root submitted'),
    jsonb_build_array(jsonb_build_object(
      'evidence_id', 'ev-child-1',
      'repository_name', 'kdmanage-backend',
      'commit_sha', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'file_path', 'src/Order.java',
      'blob_sha', repeat('3', 40),
      'start_line', 10,
      'end_line', 40,
      'content_hash', 'content-hash-child-1',
      'evidence_type', '现有实现',
      'description', 'child agent found the implementation',
      'producer_agent_id', 'agent-child-1',
      'producer_session_id', 'session-child-1',
      'tool_call_id', 'call-1'
    )),
    jsonb_build_object(
      'tool_calls', 9, 'evidence_shown', 4, 'searches_run', 3,
      'model_requests', 6, 'root_model_requests', 3, 'child_model_requests', 2,
      'retry_requests', 1, 'web_requests', 2, 'web_bytes', 4096,
      'input_tokens', 12000, 'output_tokens', 3400,
      'root_agent_id', 'agent-root', 'root_session_id', 'session-root',
      'tree_digest', v_text, 'session_revision', 3,
      'policy_hash', v_envelope->>'policy_hash'
    ),
    'config-hash-27', 'agent-review-v1', 'Model 27 V4 / model-27'
  );
  reset role;
  perform pg_temp.assert((v_commit->>'sealed')::boolean, 'a committed attempt is sealed');

  select sealed_at is not null, model_requests, input_tokens
    into v_ok, v_count, v_i
  from public.analysis_agent_run where id = v_run;
  perform pg_temp.assert(v_ok, 'the run records the seal');
  perform pg_temp.assert(v_count = 6, 'real model request counts survive the commit');
  perform pg_temp.assert(v_i = 12000, 'provider token usage is stored when reported');

  select count(*) into v_count from public.analysis_agent_evidence
  where agent_run_id = v_run
    and producer_agent_node_id = (
      select id from public.analysis_agent_node
      where agent_run_id = v_run and agent_id = 'agent-child-1'
    )
    and evidence_origin = 'PINNED_SNAPSHOT';
  perform pg_temp.assert(v_count = 1, 'child evidence is attributed to its producer');

  -- 封存后整棵树不再有 RUNNING 节点。
  select count(*) into v_count from public.analysis_agent_node
  where agent_run_id = v_run and status = 'RUNNING';
  perform pg_temp.assert(v_count = 0, 'committing finishes every live agent node');

  -- 迟到的第二次提交被挡住。第一道闸是 lease：提交成功即烧掉 claim token 并释放租约，
  -- 所以重放同一个 token 撞的是 TASK_LEASE_LOST 而不是唯一性约束 —— 这正是我们想要的
  -- 顺序：身份先失效，结果层不必依赖唯一索引兜底。
  perform pg_temp.assert_raises(
    format(
      'select public.save_agent_review_result(%L,%L,%L,%s,%L::jsonb,%L::jsonb,%L::jsonb)',
      v_task, v_worker, v_token, v_attempt,
      '{"verdict":"PARTIAL","confidence":50,"summary":"late"}', '[]',
      v_submit_identity::text
    ),
    'TASK_LEASE_LOST',
    'replaying a committed submission is refused because the claim was burned'
  );

  -- 唯一提交约束仍然是最后一道：直接插入第二条 COMMITTED run 必须失败。
  select count(*) into v_count from public.analysis_agent_run
  where task_id = v_task and status = 'COMMITTED';
  perform pg_temp.assert(v_count = 1, 'exactly one committed run exists for the task');
  perform pg_temp.assert_raises(
    format(
      'insert into public.analysis_agent_run (task_id, job_id, agent_attempt, worker_id, status)'
      || ' values (%L,%L,%s,%L,''COMMITTED'')',
      v_task, v_job, v_attempt + 99, v_worker
    ),
    'uq_analysis_agent_run_committed',
    'the database refuses a second committed run for one task'
  );

  ---------------------------------------------------------------------------
  -- B11. 只读详情 RPC：VIEWER 可读，且只有安全元数据。
  ---------------------------------------------------------------------------
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', v_viewer::text, 'role', 'authenticated')::text,
    true
  );
  v_detail := public.get_analysis_agent_run_detail(v_task);
  perform pg_temp.assert(v_detail is not null, 'a VIEWER can read the agent run detail');
  perform pg_temp.assert(
    jsonb_array_length(v_detail->'agents') = 3, 'the detail exposes the whole agent tree'
  );
  perform pg_temp.assert(
    (v_detail #>> '{usage,model_requests}')::integer = 6,
    'the detail exposes real model usage'
  );
  perform pg_temp.assert(
    jsonb_array_length(v_detail->'artifacts') = 1, 'the detail lists artifact metadata'
  );
  -- 浏览器不该拿到源码、Session locator 和 Prompt。
  perform pg_temp.assert(
    not (v_detail::text like '%storage_locator%')
      and not (v_detail::text like '%.jsonl%')
      and not (v_detail::text like '%content_hash":"content-hash-child-1%'),
    'the browser payload carries no session locator and no evidence content hash'
  );

  -- VIEWER 不能取消。
  perform pg_temp.assert_raises(
    format('select public.request_analysis_attempt_cancel(%L)', v_task),
    'permission required',
    'a VIEWER cannot cancel an attempt'
  );

  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', v_admin::text, 'role', 'authenticated')::text,
    true
  );
end;
$test$;

------------------------------------------------------------------------------
-- C. 取消与 stale reclaim 后旧 attempt 全面失效
------------------------------------------------------------------------------

do $test$
declare
  v_admin uuid := '27000000-0000-4000-a000-0000000000b1';
  v_model uuid := '27000000-0000-4000-b000-0000000000c1';
  v_secret uuid;
  v_batch uuid := '27000000-0000-4000-c000-0000000000d1';
  v_story uuid := '27000000-0000-4000-e000-0000000000f1';
  v_worker text := 'worker-27-cancel';
  v_job uuid;
  v_task uuid;
  v_token uuid;
  v_attempt integer;
  v_envelope jsonb;
  v_heartbeat jsonb;
  v_run uuid;
  v_count integer;
  v_ok boolean;
begin
  insert into auth.users (id, email) values (v_admin, 'admin_27_cancel@example.com')
  on conflict (id) do nothing;
  insert into public.user_profile (id, role) values (v_admin, 'ADMIN')
  on conflict (id) do update set role = 'ADMIN';
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', v_admin::text, 'role', 'authenticated')::text,
    true
  );

  set local role service_role;
  v_secret := public.admin_vault_create_secret('sk-27-cancel-test', 'ai_key_27_cancel_test');
  reset role;

  insert into public.ai_model_config (
    id, display_name, base_url, model_name, api_key_secret_id,
    enabled, max_parallel_tasks, created_by
  ) values (
    v_model, 'Model 27 cancel', 'https://model-27c.example.com', 'model-27c',
    v_secret, true, 4, v_admin
  );

  insert into public.review_batch (
    id, name, week_code, status, default_branch, created_by, ai_model_config_id
  ) values (
    v_batch, 'V4 cancel governance', 'WK-27-V4-002',
    'WAITING_AI_RESULT', 'feature_dev', v_admin, v_model
  );

  insert into public.review_story (
    id, batch_id, story_code, story_name, owners_text, source_data
  ) values (v_story, v_batch, 'ST-27-V4-002', 'cancel story', 'owner', '{}'::jsonb);

  v_job := public.enqueue_analysis_job(v_batch);
  update public.analysis_job set status = 'PROCESSING' where id = v_job;
  insert into public.analysis_repository_snapshot (
    job_id, repository_name, requested_branch, commit_sha
  ) values (v_job, 'kdmanage-backend', 'feature_dev', repeat('a', 40));
  select id into v_task from public.analysis_story_task where job_id = v_job;

  set local role service_role;
  v_envelope := public.claim_next_story_task(v_worker, 900);
  reset role;
  v_token := (v_envelope->>'claim_token')::uuid;
  v_attempt := (v_envelope->>'agent_attempt')::integer;
  v_run := (v_envelope->>'agent_run_id')::uuid;

  set local role service_role;
  perform public.record_analysis_attempt_profile(
    v_task, v_worker, v_token, v_attempt,
    '0.1.5-rc.1', (select job.capability_contract_hash from public.analysis_job job join public.analysis_story_task task on task.job_id = job.id where task.id = v_task), 'profile-hash-cancel',
    v_envelope->>'policy_hash', 'root-c', 'session-c', 'initial-tree-c'
  );
  perform public.register_analysis_agent_node(
    v_task, v_worker, v_token, v_attempt,
    'root-c', 'session-c', null, 'root-reviewer', 'root', 'hash-root'
  );
  perform public.register_analysis_agent_node(
    v_task, v_worker, v_token, v_attempt,
    'child-c', 'session-cc', 'root-c', 'research-child', 'spawn', 'hash-child'
  );
  reset role;

  -- 心跳在被取消之前报告 lease_held 且未取消。
  set local role service_role;
  v_heartbeat := public.heartbeat_analysis_attempt(v_task, v_worker, v_token, 900);
  reset role;
  perform pg_temp.assert(
    (v_heartbeat->>'lease_held')::boolean
      and not (v_heartbeat->>'cancel_requested')::boolean,
    'a healthy attempt heartbeats without a cancel flag'
  );

  -- 无 JWT claims 的非 service-role 会话必须默认拒绝，不能绕过批次授权。
  perform set_config('request.jwt.claims', '', true);
  set local role authenticated;
  perform pg_temp.assert_raises(
    format('select public.request_analysis_attempt_cancel(%L)', v_task),
    'authentication required',
    'a claim-less caller cannot cancel an attempt'
  );
  reset role;
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', v_admin::text, 'role', 'authenticated')::text,
    true
  );

  -- 用户取消：下一次心跳同一趟往返就带回取消信号。
  perform pg_temp.assert(
    public.request_analysis_attempt_cancel(v_task, 'USER_CANCELLED'),
    'an ADMIN can cancel a running attempt'
  );

  set local role service_role;
  v_heartbeat := public.heartbeat_analysis_attempt(v_task, v_worker, v_token, 900);
  reset role;
  perform pg_temp.assert(
    (v_heartbeat->>'cancel_requested')::boolean
      and v_heartbeat->>'cancel_reason' = 'USER_CANCELLED',
    'the cancel request reaches the worker on the very next heartbeat'
  );

  -- 取消后不能再注册 Agent、不能再拿预算、不能再提交。
  perform pg_temp.assert_raises(
    format(
      'select public.register_analysis_agent_node(%L,%L,%L,%s,%L,%L,%L,%L,%L,%L)',
      v_task, v_worker, v_token, v_attempt,
      'child-after-cancel', 'session-x', 'root-c',
      'research-child', 'spawn', 'hash-child'
    ),
    'AGENT_TREE_CANCELLED',
    'no new agent may be registered after cancellation'
  );

  set local role service_role;
  perform pg_temp.assert(
    public.reserve_analysis_agent_budget(
      v_task, v_worker, v_token, v_attempt, 'root-c', 'loop', 1
    )->>'code' = 'AGENT_TREE_CANCELLED',
    'no model request may be reserved after cancellation'
  );
  reset role;

  perform pg_temp.assert_raises(
    format(
      'select public.save_agent_review_result(%L,%L,%L,%s,%L::jsonb,%L::jsonb,%L::jsonb)',
      v_task, v_worker, v_token, v_attempt,
      '{"verdict":"IMPLEMENTED","confidence":90,"summary":"after cancel"}', '[]',
      '{"root_agent_id":"root-c"}'
    ),
    'AGENT_TREE_CANCELLED',
    'a cancelled attempt cannot commit'
  );

  -- fail 路径：fence、封存并取消整棵树。
  set local role service_role;
  perform public.fail_agent_review(
    v_task, v_worker, v_token, 'AGENT_TREE_CANCELLED', 'user cancelled the attempt'
  );
  reset role;

  select count(*) into v_count from public.analysis_agent_node
  where agent_run_id = v_run and status = 'RUNNING';
  perform pg_temp.assert(v_count = 0, 'failing an attempt cancels every live agent node');

  select sealed_at is not null and session_revision > 1 into v_ok
  from public.analysis_agent_run where id = v_run;
  perform pg_temp.assert(v_ok, 'failing an attempt seals it and advances the fence');

  ---------------------------------------------------------------------------
  -- stale reclaim：Worker 心跳过期后旧 attempt 被 fence。
  ---------------------------------------------------------------------------
  update public.analysis_job set status = 'PROCESSING', error_code = null where id = v_job;
  update public.analysis_story_task
  set agent_status = 'PENDING', worker_id = null, lease_expires_at = null,
      claim_token_digest = null, finished_at = null, error_code = null
  where id = v_task;

  set local role service_role;
  v_envelope := public.claim_next_story_task(v_worker, 900);
  reset role;
  v_token := (v_envelope->>'claim_token')::uuid;
  v_attempt := (v_envelope->>'agent_attempt')::integer;
  v_run := (v_envelope->>'agent_run_id')::uuid;
  perform pg_temp.assert(
    (v_envelope->>'session_revision')::integer > 2,
    'a new attempt starts strictly above the previous fence'
  );

  set local role service_role;
  perform public.record_analysis_attempt_profile(
    v_task, v_worker, v_token, v_attempt,
    '0.1.5-rc.1', (select job.capability_contract_hash from public.analysis_job job join public.analysis_story_task task on task.job_id = job.id where task.id = v_task), 'profile-hash-cancel',
    v_envelope->>'policy_hash', 'root-d', 'session-d', 'initial-tree-d'
  );
  perform public.register_analysis_agent_node(
    v_task, v_worker, v_token, v_attempt,
    'root-d', 'session-d', null, 'root-reviewer', 'root', 'hash-root'
  );
  reset role;

  -- 没有近期的 worker 心跳行，reclaim 应当接管这一条。
  delete from public.analysis_worker_heartbeat where worker_id = v_worker;
  set local role service_role;
  v_count := public.reclaim_stale_story_task_leases();
  reset role;
  perform pg_temp.assert(v_count >= 1, 'a lost worker lease is reclaimed');

  select count(*) into v_count from public.analysis_agent_node
  where agent_run_id = v_run and status = 'CANCELLED';
  perform pg_temp.assert(v_count = 1, 'reclaim cancels the abandoned agent tree');

  select sealed_at is not null into v_ok
  from public.analysis_agent_run where id = v_run;
  perform pg_temp.assert(v_ok, 'reclaim seals the abandoned attempt');

  -- 旧 token 现在什么都做不了。
  set local role service_role;
  perform pg_temp.assert(
    not (public.heartbeat_analysis_attempt(v_task, v_worker, v_token, 900)->>'lease_held')::boolean,
    'a reclaimed attempt cannot heartbeat with its old token'
  );
  perform pg_temp.assert(
    public.load_resumable_analysis_attempt(v_task, v_worker, v_token) is null,
    'a sealed attempt is not resumable'
  );
  reset role;

  perform pg_temp.assert_raises(
    format(
      'select public.save_agent_review_result(%L,%L,%L,%s,%L::jsonb,%L::jsonb,%L::jsonb)',
      v_task, v_worker, v_token, v_attempt,
      '{"verdict":"IMPLEMENTED","confidence":90,"summary":"zombie"}', '[]',
      '{"root_agent_id":"root-d"}'
    ),
    'TASK_LEASE_LOST',
    'a reclaimed attempt cannot commit with its old token'
  );
end;
$test$;

select 'ALL_V4_HARNESS_CAPABILITY_TESTS_PASSED' as result;

rollback;
