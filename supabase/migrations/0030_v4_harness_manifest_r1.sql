-- Generated from worker/harness/code-review-acp/v4-capability-contract.json.
-- Do not edit the policy JSON by hand; update the manifest and generate a new migration.
-- v4-manifest-revision: 1
-- v4-manifest-source-sha256: 0961926949bae700caa1e62d5b4603a309c308cac7da3490957a56bb24f46f25
-- v4-manifest-hash: aebe967b3add73f7d47ad3d2ce8d2729a91718fff934fcc2d256bb553e17617c

begin;

create table if not exists public.v4_harness_manifest (
  manifest_revision integer primary key check (manifest_revision > 0),
  contract_version integer not null check (contract_version > 0),
  harness_version text not null check (btrim(harness_version) <> ''),
  manifest_hash text not null unique check (manifest_hash ~ '^[0-9a-f]{64}$'),
  default_policy jsonb not null check (jsonb_typeof(default_policy) = 'object'),
  is_active boolean not null default false,
  created_at timestamptz not null default now()
);

create unique index if not exists uq_v4_harness_manifest_one_active
  on public.v4_harness_manifest (is_active)
  where is_active;

alter table public.v4_harness_manifest enable row level security;
revoke all on table public.v4_harness_manifest from public, anon, authenticated;
grant select, insert, update on table public.v4_harness_manifest to service_role;

insert into public.v4_harness_manifest (
  manifest_revision, contract_version, harness_version, manifest_hash, default_policy, is_active
) values (
  1,
  4,
  '0.1.5-rc.1',
  'aebe967b3add73f7d47ad3d2ce8d2729a91718fff934fcc2d256bb553e17617c',
  '{"version":4,"capabilities":{"instructions":true,"skills":true,"goal":true,"plan":true,"todo":true,"ralph":true,"subagentSpawn":true,"subagentFork":true,"subagentControl":true,"workflow":true,"jobs":true,"shell":true,"filesystem":true,"webSearch":true,"webFetch":true,"parallelTools":true,"autoCompaction":true,"sessionPersistence":true,"sessionResume":true,"artifacts":true},"sandbox":{"defaultMode":"workspace-write","dangerFullAccess":false,"commandTimeoutMs":60000,"maxProcessesPerAttempt":64,"maxWorkspaceBytes":2147483648,"maxWorkspaceFiles":100000},"agents":{"maxAgentsPerAttempt":8,"maxDelegationDepth":2,"maxConcurrentChildren":4,"allowOutOfProcessProviders":false},"workflow":{"maxConcurrentSteps":4,"maxRuntimeMs":900000},"jobs":{"maxConcurrentJobsPerOwner":4,"maxRuntimeMs":300000},"parallelTools":{"maxPerStep":8,"mutationToolsSerial":true},"modelBudget":{"maxTotalRequests":160,"maxRootRequests":80,"maxChildRequests":32,"maxRetryRequests":12,"maxCompactionRequests":8,"maxRalphRounds":12},"web":{"maxRequestsPerAttempt":20,"maxResponseBytes":2097152,"maxTotalBytes":20971520,"allowHttp":false,"allowedPorts":[443],"allowedDomains":[],"denyPrivateNetworks":true,"maxRedirects":3,"requestTimeoutMs":20000},"session":{"checkpointEveryEvents":100,"retentionDays":7,"encryptAtRest":true,"resumeOnWorkerRestart":true}}'::jsonb,
  true
);

-- 实际任务继续允许模型配置覆盖资源上限，但能力开关和安全基线只来自 active manifest。
create or replace function public.build_v4_capability_policy(p_model_config_id uuid)
returns jsonb
language sql
security definer
set search_path = public
stable
as $$
  select manifest.default_policy || jsonb_build_object(
    'sandbox', (manifest.default_policy->'sandbox') || jsonb_build_object(
      'commandTimeoutMs', cfg.sandbox_command_timeout_ms,
      'maxProcessesPerAttempt', cfg.sandbox_max_processes,
      'maxWorkspaceBytes', cfg.workspace_max_bytes,
      'maxWorkspaceFiles', cfg.workspace_max_files
    ),
    'agents', (manifest.default_policy->'agents') || jsonb_build_object(
      'maxAgentsPerAttempt', cfg.max_agents_per_attempt,
      'maxDelegationDepth', cfg.max_delegation_depth,
      'maxConcurrentChildren', cfg.max_concurrent_children
    ),
    'workflow', (manifest.default_policy->'workflow') || jsonb_build_object(
      'maxConcurrentSteps', cfg.workflow_max_concurrent_steps,
      'maxRuntimeMs', cfg.workflow_max_runtime_ms
    ),
    'jobs', (manifest.default_policy->'jobs') || jsonb_build_object(
      'maxConcurrentJobsPerOwner', cfg.max_concurrent_jobs_per_owner,
      'maxRuntimeMs', cfg.jobs_max_runtime_ms
    ),
    'parallelTools', (manifest.default_policy->'parallelTools') || jsonb_build_object(
      'maxPerStep', cfg.max_parallel_tool_calls
    ),
    'modelBudget', (manifest.default_policy->'modelBudget') || jsonb_build_object(
      'maxTotalRequests', cfg.agent_max_total_requests,
      'maxRootRequests', cfg.agent_max_root_requests,
      'maxChildRequests', cfg.agent_max_child_requests,
      'maxRetryRequests', cfg.agent_max_retry_requests,
      'maxCompactionRequests', cfg.agent_max_compaction_requests,
      'maxRalphRounds', cfg.agent_max_ralph_rounds
    ),
    'web', (manifest.default_policy->'web') || jsonb_build_object(
      'maxRequestsPerAttempt', cfg.web_max_requests_per_attempt,
      'maxResponseBytes', cfg.web_max_response_bytes,
      'maxTotalBytes', cfg.web_max_total_bytes,
      'allowedDomains', to_jsonb(cfg.web_allowed_domains)
    ),
    'session', (manifest.default_policy->'session') || jsonb_build_object(
      'checkpointEveryEvents', cfg.session_checkpoint_every_events,
      'retentionDays', cfg.session_retention_days
    )
  )
  from public.ai_model_config cfg
  cross join lateral (
    select registered.default_policy
    from public.v4_harness_manifest registered
    where registered.is_active
    limit 1
  ) manifest
  where cfg.id = p_model_config_id;
$$;

revoke execute on function public.build_v4_capability_policy(uuid)
  from public, anon, authenticated;
grant execute on function public.build_v4_capability_policy(uuid) to service_role;

create or replace function public.admin_get_v4_capability_policy()
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_policy jsonb;
begin
  perform public.ensure_admin();
  select manifest.default_policy into v_policy
  from public.v4_harness_manifest manifest
  where manifest.is_active;
  if v_policy is null then
    raise exception 'V4_HARNESS_MANIFEST_MISSING';
  end if;
  return v_policy;
end;
$$;

revoke execute on function public.admin_get_v4_capability_policy()
  from public, anon;
grant execute on function public.admin_get_v4_capability_policy()
  to authenticated, service_role;

comment on table public.v4_harness_manifest is
  'Versioned deployment copies generated from v4-capability-contract.json. Active revision affects only newly enqueued jobs.';
comment on function public.admin_get_v4_capability_policy() is
  'ADMIN only: returns the active platform-wide V4 default policy.';

commit;
