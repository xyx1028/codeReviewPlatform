-- 0029_platform_default_capability_policy.sql
-- 历史过渡迁移：0030 起默认策略由 v4-capability-contract.json 生成并存入版本表。
-- 请勿在后续升级中修改本文件或复制这里的 JSON。
-- 管理端展示平台统一的 V4 默认能力策略，不再依赖某个模型配置。
-- 任务运行时仍由 build_v4_capability_policy(uuid) 按模型配置冻结实际资源上限。

begin;

-- PostgreSQL 不能通过 create or replace 改变函数参数，因此先移除旧签名。
drop function if exists public.admin_get_v4_capability_policy(uuid);

create function public.admin_get_v4_capability_policy()
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
begin
  perform public.ensure_admin();

  return jsonb_build_object(
    'version', 4,
    'capabilities', jsonb_build_object(
      'instructions', true,
      'skills', true,
      'goal', true,
      'plan', true,
      'todo', true,
      'ralph', true,
      'subagentSpawn', true,
      'subagentFork', true,
      'subagentControl', true,
      'workflow', true,
      'jobs', true,
      'shell', true,
      'filesystem', true,
      'webSearch', true,
      'webFetch', true,
      'parallelTools', true,
      'autoCompaction', true,
      'sessionPersistence', true,
      'sessionResume', true,
      'artifacts', true
    ),
    'sandbox', jsonb_build_object(
      'defaultMode', 'workspace-write',
      'dangerFullAccess', false,
      'commandTimeoutMs', 60000,
      'maxProcessesPerAttempt', 64,
      'maxWorkspaceBytes', 2147483648,
      'maxWorkspaceFiles', 100000
    ),
    'agents', jsonb_build_object(
      'maxAgentsPerAttempt', 8,
      'maxDelegationDepth', 2,
      'maxConcurrentChildren', 4,
      'allowOutOfProcessProviders', false
    ),
    'workflow', jsonb_build_object(
      'maxConcurrentSteps', 4,
      'maxRuntimeMs', 900000
    ),
    'jobs', jsonb_build_object(
      'maxConcurrentJobsPerOwner', 4,
      'maxRuntimeMs', 300000
    ),
    'parallelTools', jsonb_build_object(
      'maxPerStep', 8,
      'mutationToolsSerial', true
    ),
    'modelBudget', jsonb_build_object(
      'maxTotalRequests', 160,
      'maxRootRequests', 80,
      'maxChildRequests', 32,
      'maxRetryRequests', 12,
      'maxCompactionRequests', 8,
      'maxRalphRounds', 12
    ),
    'web', jsonb_build_object(
      'maxRequestsPerAttempt', 20,
      'maxResponseBytes', 2097152,
      'maxTotalBytes', 20971520,
      'allowHttp', false,
      'allowedPorts', jsonb_build_array(443),
      'allowedDomains', jsonb_build_array(),
      'denyPrivateNetworks', true,
      'maxRedirects', 3,
      'requestTimeoutMs', 20000
    ),
    'session', jsonb_build_object(
      'checkpointEveryEvents', 100,
      'retentionDays', 7,
      'encryptAtRest', true,
      'resumeOnWorkerRestart', true
    )
  );
end;
$$;

revoke execute on function public.admin_get_v4_capability_policy()
  from public, anon;
grant execute on function public.admin_get_v4_capability_policy()
  to authenticated, service_role;

comment on function public.admin_get_v4_capability_policy() is
  'ADMIN only: returns the platform-wide V4 default capability policy shown by the read-only UI.';

commit;
