-- 0037_admin_configurable_v4_capability_policy_test.sql
-- ADMIN 可配置资源限额、权限、审计与 frozen Job 不变回归。
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

do $test$
declare
  v_admin uuid := '37000000-0000-4000-a000-000000000001';
  v_reviewer uuid := '37000000-0000-4000-a000-000000000002';
  v_model uuid := '37000000-0000-4000-b000-000000000001';
  v_batch uuid := '37000000-0000-4000-c000-000000000001';
  v_job uuid := '37000000-0000-4000-d000-000000000001';
  v_secret uuid;
  v_model_snapshot jsonb;
  v_old_policy jsonb;
  v_new_policy jsonb;
  v_frozen_policy jsonb;
  v_frozen_hash text;
  v_manifest_hash text;
  v_manifest_policy jsonb;
  v_error text;
begin
  insert into auth.users (id, email) values
    (v_admin, 'admin_37_policy@example.com'),
    (v_reviewer, 'reviewer_37_policy@example.com')
  on conflict (id) do nothing;

  insert into public.user_profile (id, role) values
    (v_admin, 'ADMIN'),
    (v_reviewer, 'REVIEWER')
  on conflict (id) do update set role = excluded.role;

  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', v_admin::text, 'role', 'authenticated')::text,
    true
  );

  set local role service_role;
  v_secret := public.admin_vault_create_secret(
    '0037-policy-test-not-a-real-key',
    '0037_policy_test_key'
  );
  reset role;

  insert into public.ai_model_config (
    id, display_name, base_url, model_name, api_key_secret_id,
    enabled, max_parallel_tasks, created_by
  ) values (
    v_model, 'Model 37 policy', 'https://model-37.example.com', 'model-37',
    v_secret, true, 4, v_admin
  );

  v_old_policy := public.admin_get_v4_capability_policy(v_model);
  perform pg_temp.assert(
    v_old_policy #>> '{modelBudget,maxTotalRequests}' = '240'
      and v_old_policy #>> '{modelBudget,maxRootRequests}' = '120',
    '0036 defaults are visible through the parameterized ADMIN policy RPC'
  );
  perform pg_temp.assert(
    v_old_policy #>> '{sandbox,dangerFullAccess}' = 'false'
      and v_old_policy #>> '{agents,allowOutOfProcessProviders}' = 'false'
      and v_old_policy #>> '{parallelTools,mutationToolsSerial}' = 'true',
    'security invariants remain locked before updates'
  );

  select manifest_hash, default_policy
  into v_manifest_hash, v_manifest_policy
  from public.v4_harness_manifest
  where is_active;

  v_model_snapshot := public.build_model_snapshot(v_model);
  insert into public.review_batch (
    id, name, week_code, status, default_branch, created_by,
    ai_model_config_id, ai_model_snapshot
  ) values (
    v_batch, 'Policy 37 frozen batch', 'WK-37-POLICY-001',
    'WAITING_AI_RESULT', 'feature_dev', v_admin, v_model, v_model_snapshot
  );
  insert into public.analysis_job (
    id, batch_id, model_config_id, model_snapshot, requested_branch,
    status, requested_by, total_stories, capability_policy_snapshot
  ) values (
    v_job, v_batch, v_model, v_model_snapshot, 'feature_dev',
    'FAILED', v_admin, 0, v_old_policy
  );
  select capability_policy_snapshot, policy_hash
  into v_frozen_policy, v_frozen_hash
  from public.analysis_job where id = v_job;

  v_new_policy := public.admin_update_v4_capability_policy(
    p_model_config_id => v_model,
    p_sandbox_command_timeout_ms => 90000,
    p_sandbox_max_processes => 96,
    p_workspace_max_bytes => 3221225472,
    p_workspace_max_files => 120000,
    p_max_agents_per_attempt => 10,
    p_max_delegation_depth => 3,
    p_max_concurrent_children => 5,
    p_workflow_max_concurrent_steps => 6,
    p_workflow_max_runtime_ms => 1200000,
    p_max_concurrent_jobs_per_owner => 6,
    p_jobs_max_runtime_ms => 600000,
    p_max_parallel_tool_calls => 10,
    p_agent_max_total_requests => 260,
    p_agent_max_root_requests => 130,
    p_agent_max_child_requests => 40,
    p_agent_max_retry_requests => 14,
    p_agent_max_compaction_requests => 9,
    p_agent_max_ralph_rounds => 16,
    p_web_max_requests_per_attempt => 30,
    p_web_max_response_bytes => 3145728,
    p_web_max_total_bytes => 31457280,
    p_web_allowed_domains => array['API.EXAMPLE.COM', 'api.example.com', 'docs.example.com', ''],
    p_session_checkpoint_every_events => 150,
    p_session_retention_days => 14
  );

  perform pg_temp.assert(
    v_new_policy #>> '{modelBudget,maxTotalRequests}' = '260'
      and v_new_policy #>> '{modelBudget,maxRootRequests}' = '130'
      and v_new_policy #>> '{agents,maxAgentsPerAttempt}' = '10'
      and v_new_policy #>> '{session,retentionDays}' = '14',
    'ADMIN update returns the exact effective policy for future Jobs'
  );
  perform pg_temp.assert(
    v_new_policy #> '{web,allowedDomains}' = '["api.example.com", "docs.example.com"]'::jsonb,
    'web domains are normalized, deduplicated and sorted'
  );
  perform pg_temp.assert(
    v_new_policy #>> '{sandbox,dangerFullAccess}' = 'false'
      and v_new_policy #>> '{agents,allowOutOfProcessProviders}' = 'false'
      and v_new_policy #>> '{parallelTools,mutationToolsSerial}' = 'true'
      and v_new_policy #>> '{web,allowHttp}' = 'false'
      and v_new_policy #> '{web,allowedPorts}' = '[443]'::jsonb
      and v_new_policy #>> '{web,denyPrivateNetworks}' = 'true'
      and v_new_policy #>> '{session,encryptAtRest}' = 'true',
    'ADMIN update cannot alter contract-locked safety invariants'
  );

  perform pg_temp.assert(
    (select capability_policy_snapshot = v_frozen_policy
       and policy_hash = v_frozen_hash
     from public.analysis_job where id = v_job),
    'existing Job policy snapshot and hash remain unchanged'
  );
  perform pg_temp.assert(
    (select manifest_hash = v_manifest_hash and default_policy = v_manifest_policy
     from public.v4_harness_manifest where is_active),
    'active manifest policy and hash remain unchanged'
  );
  perform pg_temp.assert(
    (select count(*) = 1
     from public.v4_capability_policy_audit
     where model_config_id = v_model
       and changed_by = v_admin
       and old_policy = v_old_policy
       and new_policy = v_new_policy),
    'one safe audit row records the ADMIN policy change'
  );

  begin
    perform public.admin_update_v4_capability_policy(
      p_model_config_id => v_model,
      p_sandbox_command_timeout_ms => 90000,
      p_sandbox_max_processes => 96,
      p_workspace_max_bytes => 3221225472,
      p_workspace_max_files => 120000,
      p_max_agents_per_attempt => 10,
      p_max_delegation_depth => 3,
      p_max_concurrent_children => 5,
      p_workflow_max_concurrent_steps => 6,
      p_workflow_max_runtime_ms => 1200000,
      p_max_concurrent_jobs_per_owner => 6,
      p_jobs_max_runtime_ms => 600000,
      p_max_parallel_tool_calls => 10,
      p_agent_max_total_requests => 100,
      p_agent_max_root_requests => 101,
      p_agent_max_child_requests => 40,
      p_agent_max_retry_requests => 14,
      p_agent_max_compaction_requests => 9,
      p_agent_max_ralph_rounds => 16,
      p_web_max_requests_per_attempt => 30,
      p_web_max_response_bytes => 3145728,
      p_web_max_total_bytes => 31457280,
      p_web_allowed_domains => array['api.example.com'],
      p_session_checkpoint_every_events => 150,
      p_session_retention_days => 14
    );
    raise exception 'ASSERT FAILED: inconsistent budget was accepted';
  exception when others then
    v_error := sqlerrm;
    perform pg_temp.assert(
      position('V4_POLICY_BUDGET_INCONSISTENT' in v_error) > 0,
      'inconsistent scoped budget is rejected'
    );
  end;

  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', v_reviewer::text, 'role', 'authenticated')::text,
    true
  );
  begin
    perform public.admin_get_v4_capability_policy(v_model);
    raise exception 'ASSERT FAILED: non-ADMIN policy read was accepted';
  exception when others then
    v_error := sqlerrm;
    perform pg_temp.assert(
      position('ADMIN role required' in v_error) > 0,
      'non-ADMIN policy read is rejected'
    );
  end;
end;
$test$;

rollback;
\echo '0037 configurable V4 capability policy tests passed'
