-- V4：DeepSeek Harness 全能力默认开启 —— expand migration。
--
-- 这个迁移采用 expand + direct-enable：新增表、列、索引和 RPC，不删除 V3 历史数据；
-- 历史 V3 数据保持可读，但不提供 V3/V4 分阶段 admission。迁移部署后，所有新建 Job
-- 直接使用 V4，V4 Worker 只领取 `policy_version = 4`。contract migration 留到 V4 稳定运行并
-- 过完数据保留期之后。
--
-- 它落地本方案第 6 节的数据模型：
--   * ai_model_config：V4 capability policy 默认值与全部分层限额；
--   * analysis_job：冻结 policy_version / capability_policy_snapshot / harness 版本与 hash；
--   * analysis_agent_run：root session/agent 身份、tree digest、session revision、真实 usage；
--   * analysis_agent_evidence：producer Agent / Session / Tool Call 与 evidence origin；
--   * analysis_agent_node：Agent Tree 每个节点一行；
--   * analysis_tool_audit / analysis_permission_decision：只存安全元数据；
--   * analysis_session_checkpoint：JSONL locator 与 revision，不存会话原文；
--   * analysis_artifact：候选 Patch / 测试报告等生成物。
--
-- 三条不可绕过的约束由数据库自己保证，而不是只靠 Worker 自律：
--   1. 只有 root 节点能提交（save_agent_review_result 校验 root_agent_id 与节点 role）；
--   2. 一个 task 最多一条 COMMITTED run（沿用 0017 的唯一索引）；
--   3. 迟到的 attempt / session revision 被 fence，写入直接失败。

begin;

------------------------------------------------------------------------------
-- 1. ai_model_config：V4 policy 默认值
------------------------------------------------------------------------------

alter table public.ai_model_config
  -- Agent Tree
  add column if not exists max_agents_per_attempt integer not null default 8,
  add column if not exists max_delegation_depth integer not null default 2,
  add column if not exists max_concurrent_children integer not null default 4,
  add column if not exists max_parallel_tool_calls integer not null default 8,
  add column if not exists max_concurrent_jobs_per_owner integer not null default 4,
  -- 分层模型预算
  add column if not exists agent_max_total_requests integer not null default 160,
  add column if not exists agent_max_root_requests integer not null default 80,
  add column if not exists agent_max_child_requests integer not null default 32,
  add column if not exists agent_max_ralph_rounds integer not null default 12,
  -- Web 出口
  add column if not exists web_max_requests_per_attempt integer not null default 20,
  add column if not exists web_max_response_bytes bigint not null default 2097152,
  add column if not exists web_max_total_bytes bigint not null default 20971520,
  add column if not exists web_allowed_domains text[] not null default array[]::text[],
  -- Workspace / Sandbox
  add column if not exists workspace_max_bytes bigint not null default 2147483648,
  add column if not exists workspace_max_files integer not null default 100000,
  add column if not exists sandbox_max_processes integer not null default 64,
  add column if not exists sandbox_command_timeout_ms integer not null default 60000,
  -- Workflow / Jobs
  add column if not exists workflow_max_concurrent_steps integer not null default 4,
  add column if not exists workflow_max_runtime_ms integer not null default 900000,
  add column if not exists jobs_max_runtime_ms integer not null default 300000,
  -- Session
  add column if not exists session_checkpoint_every_events integer not null default 100,
  add column if not exists session_retention_days integer not null default 7;

alter table public.ai_model_config
  drop constraint if exists ai_model_config_v4_limits_check;
alter table public.ai_model_config
  add constraint ai_model_config_v4_limits_check
  check (
    max_agents_per_attempt between 1 and 64
    and max_delegation_depth between 0 and 8
    and max_concurrent_children between 1 and 32
    and max_parallel_tool_calls between 1 and 64
    and max_concurrent_jobs_per_owner between 1 and 64
    and agent_max_total_requests between 1 and 10000
    and agent_max_root_requests between 1 and 10000
    and agent_max_child_requests between 1 and 10000
    and agent_max_ralph_rounds between 0 and 256
    -- 分项不得超过总量：Worker 侧还会再 clamp 一次，但数据库不接受矛盾的配置。
    and agent_max_root_requests <= agent_max_total_requests
    and agent_max_child_requests <= agent_max_total_requests
    and agent_max_retry_requests <= agent_max_total_requests
    and agent_max_compaction_requests <= agent_max_total_requests
    and web_max_requests_per_attempt between 0 and 10000
    and web_max_response_bytes between 1024 and 1073741824
    and web_max_total_bytes between 1024 and 109951162777
    and workspace_max_bytes between 1048576 and 1099511627776
    and workspace_max_files between 100 and 10000000
    and sandbox_max_processes between 1 and 4096
    and sandbox_command_timeout_ms between 1000 and 600000
    and workflow_max_concurrent_steps between 1 and 32
    and workflow_max_runtime_ms between 1000 and 86400000
    and jobs_max_runtime_ms between 1000 and 86400000
    and session_checkpoint_every_events between 1 and 100000
    and session_retention_days between 1 and 365
  );

comment on column public.ai_model_config.web_allowed_domains is
  'V4 Web egress allowlist. Empty means the model may call web tools but every '
  'destination is refused, which is the safe default until an operator adds domains.';

------------------------------------------------------------------------------
-- 2. build_v4_capability_policy：把配置行投影成一份完整 Policy snapshot
--
--    capability 布尔值在这里固定为 true —— “默认开启”是策略生成时的事实，不是用户
--    可以逐项勾选的开关。danger-full-access 与 out-of-process provider 永远为假。
------------------------------------------------------------------------------

create or replace function public.build_v4_capability_policy(p_model_config_id uuid)
returns jsonb
language sql
security definer
set search_path = public
stable
as $$
  select jsonb_build_object(
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
      'commandTimeoutMs', cfg.sandbox_command_timeout_ms,
      'maxProcessesPerAttempt', cfg.sandbox_max_processes,
      'maxWorkspaceBytes', cfg.workspace_max_bytes,
      'maxWorkspaceFiles', cfg.workspace_max_files
    ),
    'agents', jsonb_build_object(
      'maxAgentsPerAttempt', cfg.max_agents_per_attempt,
      'maxDelegationDepth', cfg.max_delegation_depth,
      'maxConcurrentChildren', cfg.max_concurrent_children,
      'allowOutOfProcessProviders', false
    ),
    'workflow', jsonb_build_object(
      'maxConcurrentSteps', cfg.workflow_max_concurrent_steps,
      'maxRuntimeMs', cfg.workflow_max_runtime_ms
    ),
    'jobs', jsonb_build_object(
      'maxConcurrentJobsPerOwner', cfg.max_concurrent_jobs_per_owner,
      'maxRuntimeMs', cfg.jobs_max_runtime_ms
    ),
    'parallelTools', jsonb_build_object(
      'maxPerStep', cfg.max_parallel_tool_calls,
      'mutationToolsSerial', true
    ),
    'modelBudget', jsonb_build_object(
      'maxTotalRequests', cfg.agent_max_total_requests,
      'maxRootRequests', cfg.agent_max_root_requests,
      'maxChildRequests', cfg.agent_max_child_requests,
      'maxRetryRequests', cfg.agent_max_retry_requests,
      'maxCompactionRequests', cfg.agent_max_compaction_requests,
      'maxRalphRounds', cfg.agent_max_ralph_rounds
    ),
    'web', jsonb_build_object(
      'maxRequestsPerAttempt', cfg.web_max_requests_per_attempt,
      'maxResponseBytes', cfg.web_max_response_bytes,
      'maxTotalBytes', cfg.web_max_total_bytes,
      'allowHttp', false,
      'allowedPorts', jsonb_build_array(443),
      'allowedDomains', to_jsonb(cfg.web_allowed_domains),
      'denyPrivateNetworks', true,
      'maxRedirects', 3,
      'requestTimeoutMs', 20000
    ),
    'session', jsonb_build_object(
      'checkpointEveryEvents', cfg.session_checkpoint_every_events,
      'retentionDays', cfg.session_retention_days,
      'encryptAtRest', true,
      'resumeOnWorkerRestart', true
    )
  )
  from public.ai_model_config cfg
  where cfg.id = p_model_config_id;
$$;

revoke execute on function public.build_v4_capability_policy(uuid)
  from public, anon, authenticated;
grant execute on function public.build_v4_capability_policy(uuid) to service_role;

------------------------------------------------------------------------------
-- 3. analysis_job：冻结 V4 policy 与 Harness 版本
------------------------------------------------------------------------------

alter table public.analysis_job
  add column if not exists policy_version integer not null default 4,
  add column if not exists capability_policy_snapshot jsonb not null default '{}'::jsonb,
  add column if not exists harness_version text,
  add column if not exists capability_contract_hash text,
  add column if not exists profile_hash text,
  add column if not exists policy_hash text;

alter table public.analysis_job
  drop constraint if exists analysis_job_policy_version_check;
alter table public.analysis_job
  add constraint analysis_job_policy_version_check
  check (policy_version in (3, 4));

create index if not exists idx_analysis_job_policy_version
on public.analysis_job(policy_version, status, created_at);

comment on column public.analysis_job.policy_version is
  'Frozen capability contract generation. V4 Workers only claim tasks whose job is 4; '
  'legacy rows keep 3 and stay readable.';

-- 已存在的历史 Job 属于 V3 语义：把它们标成 3，避免 V4 Worker 误领。
update public.analysis_job set policy_version = 3
where capability_policy_snapshot = '{}'::jsonb
  and status in ('SUCCEEDED', 'FAILED');

-- 冻结即不可变：同一个 Job 内改 policy 会让结果来源无法追溯，回滚必须新建 Job。
create or replace function public.enforce_analysis_job_policy_immutable()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.policy_version is distinct from old.policy_version then
    raise exception 'analysis_job.policy_version is immutable';
  end if;
  if old.capability_policy_snapshot <> '{}'::jsonb
     and new.capability_policy_snapshot is distinct from old.capability_policy_snapshot then
    raise exception 'analysis_job.capability_policy_snapshot is immutable once frozen';
  end if;
  return new;
end;
$$;

drop trigger if exists enforce_analysis_job_policy_immutable on public.analysis_job;
create trigger enforce_analysis_job_policy_immutable
before update on public.analysis_job
for each row execute function public.enforce_analysis_job_policy_immutable();

------------------------------------------------------------------------------
-- 4. analysis_agent_run：root 身份、fencing 与真实 usage
------------------------------------------------------------------------------

alter table public.analysis_agent_run
  add column if not exists root_session_id text,
  add column if not exists root_agent_id text,
  add column if not exists policy_hash text,
  add column if not exists tree_digest text,
  add column if not exists session_revision integer not null default 0,
  add column if not exists cancel_requested_at timestamptz,
  add column if not exists cancel_reason text,
  add column if not exists sealed_at timestamptz,
  -- 真实 usage：以 governor / provider 为真源，不再用 Broker tool call 数冒充。
  add column if not exists model_requests integer not null default 0,
  add column if not exists root_model_requests integer not null default 0,
  add column if not exists child_model_requests integer not null default 0,
  add column if not exists ralph_rounds integer not null default 0,
  add column if not exists input_tokens bigint,
  add column if not exists output_tokens bigint,
  add column if not exists cost_micros bigint,
  add column if not exists web_requests integer not null default 0,
  add column if not exists web_bytes bigint not null default 0,
  add column if not exists agent_count integer not null default 1,
  add column if not exists max_depth_reached integer not null default 0,
  add column if not exists resume_count integer not null default 0,
  add column if not exists last_checkpoint_at timestamptz;

alter table public.analysis_agent_run
  drop constraint if exists analysis_agent_run_v4_usage_check;
alter table public.analysis_agent_run
  add constraint analysis_agent_run_v4_usage_check
  check (
    session_revision >= 0
    and model_requests >= 0
    and root_model_requests >= 0
    and child_model_requests >= 0
    and ralph_rounds >= 0
    and web_requests >= 0
    and web_bytes >= 0
    and agent_count >= 0
    and max_depth_reached >= 0
    and resume_count >= 0
    and (input_tokens is null or input_tokens >= 0)
    and (output_tokens is null or output_tokens >= 0)
    and (cost_micros is null or cost_micros >= 0)
  );

comment on column public.analysis_agent_run.session_revision is
  'Monotonic fencing token. A write carrying a revision lower than the stored one '
  'belongs to a superseded Worker and is refused.';

comment on column public.analysis_agent_run.model_requests is
  'Real model requests counted by the in-process budget governor before the provider '
  'was contacted. Never derived from broker tool-call counts.';

create index if not exists idx_analysis_agent_run_cancel
on public.analysis_agent_run(task_id)
where cancel_requested_at is not null and sealed_at is null;

------------------------------------------------------------------------------
-- 5. analysis_agent_node：Agent Tree
------------------------------------------------------------------------------

create table if not exists public.analysis_agent_node (
  id uuid primary key default gen_random_uuid(),
  agent_run_id uuid not null references public.analysis_agent_run(id) on delete cascade,
  agent_id text not null,
  session_id text not null,
  parent_agent_node_id uuid references public.analysis_agent_node(id) on delete cascade,
  agent_role text not null
    check (agent_role in (
      'root-reviewer', 'research-child', 'implementation-child',
      'critic-child', 'workflow-child'
    )),
  provider text not null
    check (provider in ('root', 'spawn', 'fork', 'workflow', 'ralph')),
  delegation_depth integer not null check (delegation_depth between 0 and 8),
  status text not null default 'RUNNING'
    check (status in ('RUNNING', 'FINISHED', 'FAILED', 'CANCELLED')),
  tool_policy_hash text not null,
  -- 分 Agent usage：UI 需要回答"预算花在哪个子 Agent 上"。
  model_requests integer not null default 0 check (model_requests >= 0),
  tool_calls integer not null default 0 check (tool_calls >= 0),
  evidence_produced integer not null default 0 check (evidence_produced >= 0),
  input_tokens bigint check (input_tokens is null or input_tokens >= 0),
  output_tokens bigint check (output_tokens is null or output_tokens >= 0),
  error_code text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  -- 同一次 run 内 agent_id 唯一：注册两次同一个 id 说明 lineage 被伪造或重放。
  unique (agent_run_id, agent_id),
  -- root 节点没有父节点，子节点必须有：depth 与 parent 的一致性在这里就挡住。
  check ((provider = 'root') = (parent_agent_node_id is null)),
  check ((provider = 'root') = (delegation_depth = 0)),
  check ((provider = 'root') = (agent_role = 'root-reviewer'))
);

create index if not exists idx_analysis_agent_node_run
on public.analysis_agent_node(agent_run_id, delegation_depth);

create index if not exists idx_analysis_agent_node_parent
on public.analysis_agent_node(parent_agent_node_id);

-- 一次 run 只有一个 root。
create unique index if not exists uq_analysis_agent_node_root
on public.analysis_agent_node(agent_run_id)
where provider = 'root';

-- 数据库独立计算 Agent Tree 摘要，不能把 Worker 自报的 tree_digest 原样当成校验结果。
-- 字段顺序与 AgentAuthorityLedger.treeDigest() 完全一致。
create or replace function public.analysis_agent_tree_digest(p_agent_run_id uuid)
returns text
language sql
security definer
set search_path = public
stable
as $$
  select encode(
    sha256(convert_to(coalesce(string_agg(row_value, E'\n' order by row_value collate "C"), ''), 'UTF8')),
    'hex'
  )
  from (
    select concat_ws(
      '|', node.agent_id, coalesce(parent.agent_id, '-'), node.agent_role, node.provider,
      node.delegation_depth::text, node.status, node.tool_policy_hash
    ) as row_value
    from public.analysis_agent_node node
    left join public.analysis_agent_node parent on parent.id = node.parent_agent_node_id
    where node.agent_run_id = p_agent_run_id
  ) rows;
$$;

revoke execute on function public.analysis_agent_tree_digest(uuid) from public, anon, authenticated;
grant execute on function public.analysis_agent_tree_digest(uuid) to service_role;

------------------------------------------------------------------------------
-- 6. analysis_agent_evidence：producer 归属与 origin
------------------------------------------------------------------------------

alter table public.analysis_agent_evidence
  add column if not exists producer_agent_node_id uuid
    references public.analysis_agent_node(id) on delete set null,
  add column if not exists producer_session_id text,
  add column if not exists tool_call_id text,
  add column if not exists evidence_origin text not null default 'PINNED_SNAPSHOT',
  add column if not exists policy_hash text,
  add column if not exists session_revision integer not null default 0;

alter table public.analysis_agent_evidence
  drop constraint if exists analysis_agent_evidence_origin_check;
alter table public.analysis_agent_evidence
  add constraint analysis_agent_evidence_origin_check
  check (evidence_origin in ('PINNED_SNAPSHOT', 'GENERATED_ARTIFACT'));

comment on column public.analysis_agent_evidence.evidence_origin is
  'Only PINNED_SNAPSHOT may prove that code already exists. Workspace-generated '
  'content is GENERATED_ARTIFACT and can only support a suggestion.';

create index if not exists idx_analysis_agent_evidence_producer
on public.analysis_agent_evidence(producer_agent_node_id);

------------------------------------------------------------------------------
-- 7. analysis_tool_audit：只存安全元数据，不存工具正文
------------------------------------------------------------------------------

create table if not exists public.analysis_tool_audit (
  id bigserial primary key,
  agent_run_id uuid not null references public.analysis_agent_run(id) on delete cascade,
  agent_node_id uuid references public.analysis_agent_node(id) on delete set null,
  session_id text,
  tool_call_id text,
  tool_name text not null,
  permission_verdict text not null
    check (permission_verdict in ('ALLOW', 'DENY', 'CANCELLED')),
  error_code text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  duration_ms integer check (duration_ms is null or duration_ms >= 0),
  request_bytes integer not null default 0 check (request_bytes >= 0),
  response_bytes integer not null default 0 check (response_bytes >= 0),
  budget_reservation jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_analysis_tool_audit_run
on public.analysis_tool_audit(agent_run_id, started_at);

create index if not exists idx_analysis_tool_audit_node
on public.analysis_tool_audit(agent_node_id);

comment on table public.analysis_tool_audit is
  'Security metadata only: no prompt, no source code, no tool payload, no URL query.';

------------------------------------------------------------------------------
-- 8. analysis_permission_decision：策略判定审计
------------------------------------------------------------------------------

create table if not exists public.analysis_permission_decision (
  id bigserial primary key,
  agent_run_id uuid not null references public.analysis_agent_run(id) on delete cascade,
  agent_node_id uuid references public.analysis_agent_node(id) on delete set null,
  agent_role text not null,
  tool_name text not null,
  policy_layer text not null
    check (policy_layer in ('global', 'role', 'child-filter', 'broker', 'lease', 'budget')),
  decision text not null check (decision in ('ALLOW', 'DENY')),
  reason_code text not null,
  policy_hash text,
  decided_at timestamptz not null default now()
);

create index if not exists idx_analysis_permission_decision_run
on public.analysis_permission_decision(agent_run_id, decided_at);

------------------------------------------------------------------------------
-- 9. analysis_session_checkpoint：JSONL locator，不存会话原文
------------------------------------------------------------------------------

create table if not exists public.analysis_session_checkpoint (
  id uuid primary key default gen_random_uuid(),
  agent_run_id uuid not null references public.analysis_agent_run(id) on delete cascade,
  session_id text not null,
  session_revision integer not null check (session_revision >= 0),
  storage_locator text not null,
  content_hash text not null,
  event_count integer not null default 0 check (event_count >= 0),
  harness_version text not null,
  profile_hash text,
  status text not null default 'OPEN'
    check (status in ('OPEN', 'SEALED', 'CORRUPT', 'UNSUPPORTED', 'EXPIRED')),
  created_at timestamptz not null default now(),
  retention_until timestamptz not null,
  unique (session_id, session_revision)
);

create index if not exists idx_analysis_session_checkpoint_run
on public.analysis_session_checkpoint(agent_run_id, session_revision desc);

create index if not exists idx_analysis_session_checkpoint_retention
on public.analysis_session_checkpoint(retention_until)
where status <> 'EXPIRED';

comment on table public.analysis_session_checkpoint is
  'Locator + hash only. Session JSONL bodies stay on the encrypted worker volume '
  'and are never stored in ordinary database columns.';

------------------------------------------------------------------------------
-- 10. analysis_artifact：候选 Patch / 测试报告
------------------------------------------------------------------------------

create table if not exists public.analysis_artifact (
  id uuid primary key default gen_random_uuid(),
  agent_run_id uuid not null references public.analysis_agent_run(id) on delete cascade,
  producer_agent_node_id uuid references public.analysis_agent_node(id) on delete set null,
  artifact_type text not null
    check (artifact_type in ('PATCH', 'TEST_REPORT', 'BUILD_LOG', 'STATIC_ANALYSIS', 'NOTE')),
  workspace_path text not null,
  content_hash text not null,
  size_bytes bigint not null check (size_bytes >= 0),
  storage_locator text,
  verification_status text not null default 'UNVERIFIED'
    check (verification_status in ('UNVERIFIED', 'VERIFIED', 'REJECTED')),
  created_at timestamptz not null default now(),
  retention_until timestamptz not null,
  unique (agent_run_id, workspace_path, content_hash)
);

create index if not exists idx_analysis_artifact_run
on public.analysis_artifact(agent_run_id, created_at);

comment on table public.analysis_artifact is
  'Workspace-generated content. An artifact may support a suggested change; it can '
  'never prove that the pinned commit already implements a story.';

------------------------------------------------------------------------------
-- 11. RLS：新表默认拒绝浏览器直读，只经 RPC / service_role
------------------------------------------------------------------------------

alter table public.analysis_agent_node enable row level security;
alter table public.analysis_tool_audit enable row level security;
alter table public.analysis_permission_decision enable row level security;
alter table public.analysis_session_checkpoint enable row level security;
alter table public.analysis_artifact enable row level security;

-- Agent Tree 与工具审计只暴露安全元数据，可以按批次授权给管理者读。
drop policy if exists "read agent node for managed batch" on public.analysis_agent_node;
create policy "read agent node for managed batch" on public.analysis_agent_node
for select to authenticated
using (
  exists (
    select 1
    from public.analysis_agent_run run
    join public.analysis_job job on job.id = run.job_id
    where run.id = analysis_agent_node.agent_run_id
      and public.can_manage_review_batch(job.batch_id)
  )
);

drop policy if exists "read tool audit for managed batch" on public.analysis_tool_audit;
create policy "read tool audit for managed batch" on public.analysis_tool_audit
for select to authenticated
using (
  exists (
    select 1
    from public.analysis_agent_run run
    join public.analysis_job job on job.id = run.job_id
    where run.id = analysis_tool_audit.agent_run_id
      and public.can_manage_review_batch(job.batch_id)
  )
);

drop policy if exists "read artifact metadata for managed batch" on public.analysis_artifact;
create policy "read artifact metadata for managed batch" on public.analysis_artifact
for select to authenticated
using (
  exists (
    select 1
    from public.analysis_agent_run run
    join public.analysis_job job on job.id = run.job_id
    where run.id = analysis_artifact.agent_run_id
      and public.can_manage_review_batch(job.batch_id)
  )
);

-- permission decision 与 session checkpoint 只给 service_role：前者是策略内部推理，
-- 后者含存储 locator，都不需要出现在浏览器里。
grant select on public.analysis_agent_node to authenticated;
grant select on public.analysis_tool_audit to authenticated;
grant select on public.analysis_artifact to authenticated;

revoke all on public.analysis_permission_decision from anon, authenticated;
revoke all on public.analysis_session_checkpoint from anon, authenticated;

------------------------------------------------------------------------------
-- 12. 新增 RPC
------------------------------------------------------------------------------

-- 12.1 注册一个 Agent Tree 节点。
--
-- lineage 由数据库校验：父节点必须存在、必须属于同一次 run、深度必须递增，并且不能
-- 超过 policy 冻结的上限。Worker 侧还有一层 ledger，但可信 lineage 的最终仲裁在这里。
create or replace function public.register_analysis_agent_node(
  p_task_id uuid,
  p_worker_id text,
  p_claim_token uuid,
  p_agent_attempt integer,
  p_agent_id text,
  p_session_id text,
  p_parent_agent_id text,
  p_agent_role text,
  p_provider text,
  p_tool_policy_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_task public.analysis_story_task;
  v_job public.analysis_job;
  v_run public.analysis_agent_run;
  v_parent public.analysis_agent_node;
  v_depth integer := 0;
  v_count integer;
  v_policy jsonb;
  v_node_id uuid;
begin
  select * into v_task from public.analysis_story_task where id = p_task_id for update;
  if v_task.id is null then
    raise exception 'task not found';
  end if;
  if v_task.worker_id is distinct from p_worker_id
     or v_task.lease_expires_at is null
     or v_task.lease_expires_at < now()
     or p_claim_token is null
     or v_task.claim_token_digest is distinct from public.agent_claim_token_digest(p_claim_token)
     or p_agent_attempt is distinct from v_task.agent_attempt then
    raise exception 'TASK_LEASE_LOST';
  end if;

  select * into v_job from public.analysis_job where id = v_task.job_id;
  v_policy := v_job.capability_policy_snapshot;

  select * into v_run from public.analysis_agent_run
  where task_id = p_task_id and agent_attempt = p_agent_attempt
  for update;
  if v_run.id is null then
    raise exception 'AGENT_IDENTITY_INVALID';
  end if;
  if v_run.sealed_at is not null then
    raise exception 'ATTEMPT_ALREADY_SEALED';
  end if;
  if v_run.cancel_requested_at is not null then
    raise exception 'AGENT_TREE_CANCELLED';
  end if;

  if p_provider = 'root' then
    -- root identity 由 record_analysis_attempt_profile 先行冻结。注册阶段只能确认同一个
    -- 平台身份，不能用另一个 root 覆盖 run 上的可信锚点。
    if v_run.root_agent_id is null
       or v_run.root_session_id is null
       or v_run.root_agent_id <> p_agent_id
       or v_run.root_session_id <> p_session_id then
      raise exception 'AGENT_IDENTITY_INVALID';
    end if;
    v_depth := 0;
  else
    if p_parent_agent_id is null then
      raise exception 'AGENT_IDENTITY_INVALID';
    end if;
    select * into v_parent from public.analysis_agent_node
    where agent_run_id = v_run.id and agent_id = p_parent_agent_id;
    if v_parent.id is null then
      raise exception 'AGENT_IDENTITY_INVALID';
    end if;
    -- 已结束的父节点不能再造子节点：迟到的 spawn 必须被挡住。
    if v_parent.status <> 'RUNNING' then
      raise exception 'AGENT_TREE_CANCELLED';
    end if;
    v_depth := v_parent.delegation_depth + 1;
  end if;

  if v_depth > coalesce((v_policy #>> '{agents,maxDelegationDepth}')::integer, 2) then
    raise exception 'AGENT_TREE_LIMIT_EXCEEDED';
  end if;

  select count(*) into v_count from public.analysis_agent_node where agent_run_id = v_run.id;
  if v_count >= coalesce((v_policy #>> '{agents,maxAgentsPerAttempt}')::integer, 8)
     and p_provider <> 'root' then
    raise exception 'AGENT_TREE_LIMIT_EXCEEDED';
  end if;

  insert into public.analysis_agent_node (
    agent_run_id, agent_id, session_id, parent_agent_node_id,
    agent_role, provider, delegation_depth, tool_policy_hash
  ) values (
    v_run.id, p_agent_id, p_session_id, v_parent.id,
    p_agent_role, p_provider, v_depth, p_tool_policy_hash
  )
  on conflict (agent_run_id, agent_id) do nothing
  returning id into v_node_id;

  if v_node_id is null then
    -- 重复注册：同一个 agent_id 已经存在。返回既有节点，让重试幂等。
    select id into v_node_id from public.analysis_agent_node
    where agent_run_id = v_run.id and agent_id = p_agent_id;
  end if;

  update public.analysis_agent_run
  set agent_count = (select count(*) from public.analysis_agent_node where agent_run_id = v_run.id),
      max_depth_reached = greatest(max_depth_reached, v_depth),
      root_agent_id = case when p_provider = 'root' then p_agent_id else root_agent_id end,
      root_session_id = case when p_provider = 'root' then p_session_id else root_session_id end
  where id = v_run.id;

  return jsonb_build_object(
    'node_id', v_node_id,
    'delegation_depth', v_depth,
    'agent_run_id', v_run.id
  );
end;
$$;

-- 12.2 标记节点终态。
create or replace function public.mark_analysis_agent_node_terminal(
  p_task_id uuid,
  p_worker_id text,
  p_claim_token uuid,
  p_agent_attempt integer,
  p_agent_id text,
  p_status text,
  p_error_code text default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run_id uuid;
  v_ok boolean;
begin
  select run.id into v_run_id
  from public.analysis_agent_run run
  join public.analysis_story_task task on task.id = run.task_id
  where run.task_id = p_task_id
    and run.agent_attempt = p_agent_attempt
    and task.worker_id = p_worker_id
    and task.lease_expires_at is not null
    and task.lease_expires_at >= now()
    and p_claim_token is not null
    and task.claim_token_digest = public.agent_claim_token_digest(p_claim_token);

  if v_run_id is null then
    return false;
  end if;
  if p_status not in ('FINISHED', 'FAILED', 'CANCELLED') then
    raise exception 'invalid terminal status: %', p_status;
  end if;

  update public.analysis_agent_node
  set status = p_status,
      error_code = coalesce(p_error_code, error_code),
      finished_at = now(),
      cancelled_at = case when p_status = 'CANCELLED' then now() else cancelled_at end
  where agent_run_id = v_run_id
    and agent_id = p_agent_id
    and status = 'RUNNING'
  returning true into v_ok;

  return coalesce(v_ok, false);
end;
$$;

-- 12.3 预留分层预算。
--
-- 在 provider 被调用之前原子预留：并行子 Agent 同时请求时，总量 hard cap 靠这一次
-- update ... where 的原子性保证，而不是靠读后写。
create or replace function public.reserve_analysis_agent_budget(
  p_task_id uuid,
  p_worker_id text,
  p_claim_token uuid,
  p_agent_attempt integer,
  p_agent_id text,
  p_kind text,
  p_count integer default 1
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run public.analysis_agent_run;
  v_policy jsonb;
  v_node public.analysis_agent_node;
  v_limit_total integer;
  v_limit_kind integer;
  v_is_root boolean;
begin
  if p_count is null or p_count < 1 then
    p_count := 1;
  end if;

  select run.* into v_run
  from public.analysis_agent_run run
  join public.analysis_story_task task on task.id = run.task_id
  where run.task_id = p_task_id
    and run.agent_attempt = p_agent_attempt
    and task.worker_id = p_worker_id
    and task.lease_expires_at is not null
    and task.lease_expires_at >= now()
    and p_claim_token is not null
    and task.claim_token_digest = public.agent_claim_token_digest(p_claim_token)
  for update of run;

  if v_run.id is null then
    return jsonb_build_object('allowed', false, 'code', 'TASK_LEASE_LOST');
  end if;
  if v_run.sealed_at is not null then
    return jsonb_build_object('allowed', false, 'code', 'ATTEMPT_ALREADY_SEALED');
  end if;
  if v_run.cancel_requested_at is not null then
    return jsonb_build_object('allowed', false, 'code', 'AGENT_TREE_CANCELLED');
  end if;

  select job.capability_policy_snapshot into v_policy
  from public.analysis_job job where job.id = v_run.job_id;

  select * into v_node from public.analysis_agent_node
  where agent_run_id = v_run.id and agent_id = p_agent_id;
  if v_node.id is null then
    return jsonb_build_object('allowed', false, 'code', 'AGENT_IDENTITY_INVALID');
  end if;
  v_is_root := v_node.provider = 'root';

  v_limit_total := coalesce((v_policy #>> '{modelBudget,maxTotalRequests}')::integer, 160);
  if v_run.model_requests + p_count > v_limit_total then
    return jsonb_build_object(
      'allowed', false, 'code', 'MODEL_BUDGET_EXHAUSTED', 'scope', 'total'
    );
  end if;

  if p_kind = 'retry' then
    v_limit_kind := coalesce((v_policy #>> '{modelBudget,maxRetryRequests}')::integer, 12);
    if v_run.retry_requests + p_count > v_limit_kind then
      return jsonb_build_object(
        'allowed', false, 'code', 'MODEL_BUDGET_EXHAUSTED', 'scope', 'retry'
      );
    end if;
  elsif p_kind = 'compaction' then
    v_limit_kind := coalesce((v_policy #>> '{modelBudget,maxCompactionRequests}')::integer, 8);
    if v_run.compaction_requests + p_count > v_limit_kind then
      return jsonb_build_object(
        'allowed', false, 'code', 'MODEL_BUDGET_EXHAUSTED', 'scope', 'compaction'
      );
    end if;
  elsif v_is_root then
    v_limit_kind := coalesce((v_policy #>> '{modelBudget,maxRootRequests}')::integer, 80);
    if v_run.root_model_requests + p_count > v_limit_kind then
      return jsonb_build_object(
        'allowed', false, 'code', 'MODEL_BUDGET_EXHAUSTED', 'scope', 'root'
      );
    end if;
  else
    v_limit_kind := coalesce((v_policy #>> '{modelBudget,maxChildRequests}')::integer, 32);
    if v_node.model_requests + p_count > v_limit_kind then
      return jsonb_build_object(
        'allowed', false, 'code', 'MODEL_BUDGET_EXHAUSTED', 'scope', 'child'
      );
    end if;
  end if;

  update public.analysis_agent_run
  set model_requests = model_requests + p_count,
      root_model_requests = root_model_requests
        + case when v_is_root and p_kind not in ('retry', 'compaction') then p_count else 0 end,
      child_model_requests = child_model_requests
        + case when not v_is_root and p_kind not in ('retry', 'compaction') then p_count else 0 end,
      retry_requests = retry_requests + case when p_kind = 'retry' then p_count else 0 end,
      compaction_requests = compaction_requests
        + case when p_kind = 'compaction' then p_count else 0 end,
      ralph_rounds = ralph_rounds + case when p_kind = 'ralph' then p_count else 0 end
  where id = v_run.id;

  update public.analysis_agent_node
  set model_requests = model_requests + p_count
  where id = v_node.id;

  return jsonb_build_object('allowed', true, 'reserved', p_count);
end;
$$;

-- 12.4 提交真实 usage。
create or replace function public.commit_analysis_agent_usage(
  p_task_id uuid,
  p_worker_id text,
  p_claim_token uuid,
  p_agent_attempt integer,
  p_usage jsonb,
  p_per_agent jsonb default '[]'::jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run_id uuid;
  v_entry jsonb;
begin
  select run.id into v_run_id
  from public.analysis_agent_run run
  join public.analysis_story_task task on task.id = run.task_id
  where run.task_id = p_task_id
    and run.agent_attempt = p_agent_attempt
    and task.worker_id = p_worker_id
    and p_claim_token is not null
    and task.claim_token_digest = public.agent_claim_token_digest(p_claim_token);

  if v_run_id is null then
    return false;
  end if;

  update public.analysis_agent_run
  set tool_calls = greatest(tool_calls, coalesce((p_usage->>'tool_calls')::integer, 0)),
      evidence_shown = greatest(evidence_shown, coalesce((p_usage->>'evidence_shown')::integer, 0)),
      searches_run = greatest(searches_run, coalesce((p_usage->>'searches_run')::integer, 0)),
      -- usage 单调不减：迟到的旧快照不能把真实计数改小。
      model_requests = greatest(model_requests, coalesce((p_usage->>'model_requests')::integer, 0)),
      retry_requests = greatest(retry_requests, coalesce((p_usage->>'retry_requests')::integer, 0)),
      compaction_requests = greatest(
        compaction_requests, coalesce((p_usage->>'compaction_requests')::integer, 0)
      ),
      web_requests = greatest(web_requests, coalesce((p_usage->>'web_requests')::integer, 0)),
      web_bytes = greatest(web_bytes, coalesce((p_usage->>'web_bytes')::bigint, 0)),
      -- token 只有 provider 报了才存；没有就保持 null，不臆造。
      input_tokens = case
        when p_usage ? 'input_tokens' and p_usage->>'input_tokens' is not null
        then greatest(coalesce(input_tokens, 0), (p_usage->>'input_tokens')::bigint)
        else input_tokens end,
      output_tokens = case
        when p_usage ? 'output_tokens' and p_usage->>'output_tokens' is not null
        then greatest(coalesce(output_tokens, 0), (p_usage->>'output_tokens')::bigint)
        else output_tokens end
  where id = v_run_id;

  if jsonb_typeof(p_per_agent) = 'array' then
    for v_entry in select * from jsonb_array_elements(p_per_agent)
    loop
      update public.analysis_agent_node
      set model_requests = greatest(
            model_requests, coalesce((v_entry->>'model_requests')::integer, 0)
          ),
          tool_calls = greatest(tool_calls, coalesce((v_entry->>'tool_calls')::integer, 0)),
          evidence_produced = greatest(
            evidence_produced, coalesce((v_entry->>'evidence_produced')::integer, 0)
          ),
          input_tokens = case
            when v_entry ? 'input_tokens' and v_entry->>'input_tokens' is not null
            then (v_entry->>'input_tokens')::bigint else input_tokens end,
          output_tokens = case
            when v_entry ? 'output_tokens' and v_entry->>'output_tokens' is not null
            then (v_entry->>'output_tokens')::bigint else output_tokens end
      where agent_run_id = v_run_id
        and agent_id = v_entry->>'agent_id';
    end loop;
  end if;

  return true;
end;
$$;

-- 12.5 工具审计与权限判定（批量追加，避免每次工具调用一次往返）。
create or replace function public.append_analysis_tool_audit(
  p_task_id uuid,
  p_worker_id text,
  p_claim_token uuid,
  p_agent_attempt integer,
  p_entries jsonb,
  p_decisions jsonb default '[]'::jsonb
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run_id uuid;
  v_entry jsonb;
  v_written integer := 0;
begin
  select run.id into v_run_id
  from public.analysis_agent_run run
  join public.analysis_story_task task on task.id = run.task_id
  where run.task_id = p_task_id
    and run.agent_attempt = p_agent_attempt
    and task.worker_id = p_worker_id
    and p_claim_token is not null
    and task.claim_token_digest = public.agent_claim_token_digest(p_claim_token);

  if v_run_id is null then
    return 0;
  end if;

  if jsonb_typeof(p_entries) = 'array' then
    for v_entry in select * from jsonb_array_elements(p_entries)
    loop
      insert into public.analysis_tool_audit (
        agent_run_id, agent_node_id, session_id, tool_call_id, tool_name,
        permission_verdict, error_code, started_at, finished_at, duration_ms,
        request_bytes, response_bytes, budget_reservation
      ) values (
        v_run_id,
        (select id from public.analysis_agent_node
          where agent_run_id = v_run_id and agent_id = v_entry->>'agent_id'),
        v_entry->>'session_id',
        v_entry->>'tool_call_id',
        v_entry->>'tool_name',
        coalesce(v_entry->>'permission_verdict', 'ALLOW'),
        v_entry->>'error_code',
        coalesce((v_entry->>'started_at')::timestamptz, now()),
        (v_entry->>'finished_at')::timestamptz,
        (v_entry->>'duration_ms')::integer,
        greatest(coalesce((v_entry->>'request_bytes')::integer, 0), 0),
        greatest(coalesce((v_entry->>'response_bytes')::integer, 0), 0),
        coalesce(v_entry->'budget_reservation', '{}'::jsonb)
      );
      v_written := v_written + 1;
    end loop;
  end if;

  if jsonb_typeof(p_decisions) = 'array' then
    for v_entry in select * from jsonb_array_elements(p_decisions)
    loop
      insert into public.analysis_permission_decision (
        agent_run_id, agent_node_id, agent_role, tool_name,
        policy_layer, decision, reason_code, policy_hash
      ) values (
        v_run_id,
        (select id from public.analysis_agent_node
          where agent_run_id = v_run_id and agent_id = v_entry->>'agent_id'),
        coalesce(v_entry->>'agent_role', 'root-reviewer'),
        v_entry->>'tool_name',
        coalesce(v_entry->>'policy_layer', 'broker'),
        coalesce(v_entry->>'decision', 'DENY'),
        coalesce(v_entry->>'reason_code', 'UNSPECIFIED'),
        v_entry->>'policy_hash'
      );
      v_written := v_written + 1;
    end loop;
  end if;

  return v_written;
end;
$$;

-- 12.6 保存 Session checkpoint 并推进 fencing revision。
create or replace function public.save_analysis_session_checkpoint(
  p_task_id uuid,
  p_worker_id text,
  p_claim_token uuid,
  p_agent_attempt integer,
  p_session_id text,
  p_session_revision integer,
  p_storage_locator text,
  p_content_hash text,
  p_event_count integer,
  p_harness_version text,
  p_profile_hash text default null,
  p_status text default 'OPEN'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run public.analysis_agent_run;
  v_retention integer;
  v_id uuid;
begin
  select run.* into v_run
  from public.analysis_agent_run run
  join public.analysis_story_task task on task.id = run.task_id
  where run.task_id = p_task_id
    and run.agent_attempt = p_agent_attempt
    and task.worker_id = p_worker_id
    and task.lease_expires_at is not null
    and task.lease_expires_at >= now()
    and p_claim_token is not null
    and task.claim_token_digest = public.agent_claim_token_digest(p_claim_token)
  for update of run;

  if v_run.id is null then
    raise exception 'TASK_LEASE_LOST';
  end if;
  -- fencing：revision 只能前进。落后的写入来自被接管的旧 Worker。
  if p_session_revision < v_run.session_revision then
    raise exception 'SESSION_FENCED';
  end if;

  select coalesce((job.capability_policy_snapshot #>> '{session,retentionDays}')::integer, 7)
  into v_retention
  from public.analysis_job job where job.id = v_run.job_id;

  insert into public.analysis_session_checkpoint (
    agent_run_id, session_id, session_revision, storage_locator, content_hash,
    event_count, harness_version, profile_hash, status, retention_until
  ) values (
    v_run.id, p_session_id, p_session_revision, p_storage_locator, p_content_hash,
    greatest(coalesce(p_event_count, 0), 0), p_harness_version, p_profile_hash,
    coalesce(p_status, 'OPEN'), now() + make_interval(days => v_retention)
  )
  on conflict (session_id, session_revision) do update
  set storage_locator = excluded.storage_locator,
      content_hash = excluded.content_hash,
      event_count = excluded.event_count,
      status = excluded.status,
      retention_until = excluded.retention_until
  returning id into v_id;

  update public.analysis_agent_run
  set session_revision = greatest(session_revision, p_session_revision),
      last_checkpoint_at = now()
  where id = v_run.id;

  return jsonb_build_object('checkpoint_id', v_id, 'session_revision', p_session_revision);
end;
$$;

-- 12.7 找回一个可恢复的 attempt。
--
-- 只在同一个 Worker 重启后调用：跨 Worker 接管走 reclaim + 新 attempt，不共享 Session。
create or replace function public.load_resumable_analysis_attempt(
  p_task_id uuid,
  p_worker_id text,
  p_claim_token uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_task public.analysis_story_task;
  v_run public.analysis_agent_run;
  v_checkpoint public.analysis_session_checkpoint;
  v_job public.analysis_job;
begin
  select * into v_task from public.analysis_story_task where id = p_task_id;
  if v_task.id is null then
    return null;
  end if;
  if v_task.worker_id is distinct from p_worker_id
     or p_claim_token is null
     or v_task.claim_token_digest is distinct from public.agent_claim_token_digest(p_claim_token) then
    return null;
  end if;

  select * into v_run from public.analysis_agent_run
  where task_id = p_task_id and agent_attempt = v_task.agent_attempt;
  if v_run.id is null or v_run.status = 'COMMITTED' or v_run.sealed_at is not null then
    return null;
  end if;
  if v_run.cancel_requested_at is not null then
    return null;
  end if;

  select * into v_job from public.analysis_job where id = v_run.job_id;
  if coalesce((v_job.capability_policy_snapshot #>> '{session,resumeOnWorkerRestart}')::boolean, true)
     is not true then
    return null;
  end if;

  select * into v_checkpoint from public.analysis_session_checkpoint
  where agent_run_id = v_run.id and status in ('OPEN', 'SEALED')
  order by session_revision desc
  limit 1;

  if v_checkpoint.id is null then
    return null;
  end if;

  update public.analysis_agent_run
  set resume_count = resume_count + 1,
      session_revision = v_checkpoint.session_revision + 1
  where id = v_run.id;

  return jsonb_build_object(
    'agent_run_id', v_run.id,
    'root_session_id', v_run.root_session_id,
    'root_agent_id', v_run.root_agent_id,
    'session_id', v_checkpoint.session_id,
    'session_revision', v_checkpoint.session_revision + 1,
    'storage_locator', v_checkpoint.storage_locator,
    'content_hash', v_checkpoint.content_hash,
    'harness_version', v_checkpoint.harness_version,
    'profile_hash', v_checkpoint.profile_hash,
    'policy_hash', v_run.policy_hash,
    'resume_count', v_run.resume_count + 1
  );
end;
$$;

-- 12.8 请求取消一个 attempt（用户点取消 / 运维熔断）。
create or replace function public.request_analysis_attempt_cancel(
  p_task_id uuid,
  p_reason text default 'USER_CANCELLED'
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job_id uuid;
  v_ok boolean;
begin
  select task.job_id into v_job_id
  from public.analysis_story_task task where task.id = p_task_id;
  if v_job_id is null then
    raise exception 'task not found';
  end if;

  -- 授权默认拒绝：只有 service_role 或带有效 JWT 且能管理批次的用户可以取消。
  if coalesce(auth.role(), '') = 'service_role' then
    null;
  elsif nullif(current_setting('request.jwt.claims', true), '') is null then
    raise exception 'authentication required';
  else
    perform public.ensure_manage_review_batch(
      (select batch_id from public.analysis_job where id = v_job_id)
    );
  end if;

  update public.analysis_agent_run
  set cancel_requested_at = coalesce(cancel_requested_at, now()),
      cancel_reason = coalesce(cancel_reason, p_reason)
  where task_id = p_task_id
    and status = 'RUNNING'
    and sealed_at is null
  returning true into v_ok;

  return coalesce(v_ok, false);
end;
$$;

revoke execute on function public.request_analysis_attempt_cancel(uuid, text)
from public, anon;
grant execute on function public.request_analysis_attempt_cancel(uuid, text)
to authenticated, service_role;

-- 12.9 保存一个 Artifact。
create or replace function public.save_analysis_artifact(
  p_task_id uuid,
  p_worker_id text,
  p_claim_token uuid,
  p_agent_attempt integer,
  p_producer_agent_id text,
  p_artifact_type text,
  p_workspace_path text,
  p_content_hash text,
  p_size_bytes bigint,
  p_storage_locator text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run public.analysis_agent_run;
  v_node_id uuid;
  v_retention integer;
  v_id uuid;
begin
  select run.* into v_run
  from public.analysis_agent_run run
  join public.analysis_story_task task on task.id = run.task_id
  where run.task_id = p_task_id
    and run.agent_attempt = p_agent_attempt
    and task.worker_id = p_worker_id
    and task.lease_expires_at is not null
    and task.lease_expires_at >= now()
    and p_claim_token is not null
    and task.claim_token_digest = public.agent_claim_token_digest(p_claim_token);

  if v_run.id is null then
    raise exception 'TASK_LEASE_LOST';
  end if;
  if v_run.sealed_at is not null then
    raise exception 'ATTEMPT_ALREADY_SEALED';
  end if;

  select id into v_node_id from public.analysis_agent_node
  where agent_run_id = v_run.id and agent_id = p_producer_agent_id;
  if v_node_id is null then
    raise exception 'AGENT_IDENTITY_INVALID';
  end if;

  select coalesce((job.capability_policy_snapshot #>> '{session,retentionDays}')::integer, 7)
  into v_retention
  from public.analysis_job job where job.id = v_run.job_id;

  insert into public.analysis_artifact (
    agent_run_id, producer_agent_node_id, artifact_type, workspace_path,
    content_hash, size_bytes, storage_locator, retention_until
  ) values (
    v_run.id, v_node_id, p_artifact_type, p_workspace_path,
    p_content_hash, greatest(coalesce(p_size_bytes, 0), 0), p_storage_locator,
    now() + make_interval(days => v_retention)
  )
  on conflict (agent_run_id, workspace_path, content_hash) do update
  set storage_locator = excluded.storage_locator,
      size_bytes = excluded.size_bytes
  returning id into v_id;

  return jsonb_build_object('artifact_id', v_id);
end;
$$;

------------------------------------------------------------------------------
-- 13. 修改既有 RPC
------------------------------------------------------------------------------

-- 13.1 enqueue：冻结 V4 policy。
--
-- 签名保持 V3 的单参数形态。这不是保守：`enqueue_analysis_job` 由浏览器调用，而
-- Harness 版本、profile hash 和 contract hash 只有 Worker 在物化 profile 之后才知道，
-- 它们通过 13.7 的 `record_analysis_attempt_profile` 回填。把它们做成 enqueue 的参数
-- 会同时产生两个后果：多出一个可以绕过 V4 校验的旧重载，以及让浏览器决定 Harness
-- 版本 —— 两者都不能接受。
create or replace function public.enqueue_analysis_job(p_batch_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_batch public.review_batch;
  v_enabled boolean;
  v_secret uuid;
  v_snapshot jsonb;
  v_policy jsonb;
  v_job_id uuid;
  v_story_count integer;
begin
  perform public.ensure_manage_review_batch(p_batch_id);

  select * into v_batch from public.review_batch where id = p_batch_id for update;
  if v_batch.id is null then
    raise exception 'batch not found';
  end if;
  if v_batch.status = 'COMPLETED' then
    raise exception 'batch is completed and read-only; reopen it first';
  end if;
  if v_batch.default_branch is null
     or v_batch.default_branch not in ('feature_dev', 'feature_sit', 'release') then
    raise exception 'batch default_branch must be feature_dev, feature_sit, or release';
  end if;
  if v_batch.ai_model_config_id is null then
    raise exception 'batch has no model selected';
  end if;
  if exists (select 1 from public.ai_import_record where batch_id = p_batch_id) then
    raise exception 'AI result already exists for this batch';
  end if;
  if exists (
    select 1 from public.analysis_job
    where batch_id = p_batch_id
      and status in ('QUEUED', 'PREPARING_CODE', 'PROCESSING', 'FINALIZING')
  ) then
    raise exception 'an active analysis job already exists for this batch';
  end if;

  select count(*) into v_story_count from public.review_story where batch_id = p_batch_id;
  if v_story_count = 0 then
    raise exception 'no stories imported for this batch';
  end if;

  select enabled, api_key_secret_id into v_enabled, v_secret
  from public.ai_model_config where id = v_batch.ai_model_config_id;
  if v_enabled is null then
    raise exception 'model config not found';
  end if;
  if not v_enabled then
    raise exception 'MODEL_CONFIG_DISABLED';
  end if;
  if not public.model_config_has_api_key(v_secret) then
    raise exception 'MODEL_SECRET_MISSING';
  end if;

  v_snapshot := public.build_model_snapshot(v_batch.ai_model_config_id);
  -- 用户不勾选任何能力：Policy 由程序在这里一次性冻结，全部默认开启。
  v_policy := public.build_v4_capability_policy(v_batch.ai_model_config_id);
  update public.review_batch set ai_model_snapshot = v_snapshot where id = p_batch_id;

  insert into public.analysis_job (
    batch_id, model_config_id, model_snapshot, requested_branch,
    status, requested_by, total_stories, execution_engine,
    policy_version, capability_policy_snapshot, policy_hash
  ) values (
    p_batch_id, v_batch.ai_model_config_id, v_snapshot, v_batch.default_branch,
    'QUEUED', (select auth.uid()), v_story_count, 'deepseek-harness-acp',
    4, v_policy, encode(sha256(v_policy::text::bytea), 'hex')
  ) returning id into v_job_id;

  insert into public.analysis_story_task (job_id, story_id)
  select v_job_id, story.id
  from public.review_story story
  where story.batch_id = p_batch_id;

  return v_job_id;
end;
$$;

-- 13.2 claim：返回完整 V4 policy snapshot 与 fencing token。
--
-- 签名与 V3 一致（text, integer）。给它加一个 policy_version 参数会留下一个 2 参数的
-- 旧重载，而 PostgreSQL 对两参数调用优先精确匹配旧函数 —— V4 Worker 会静默拿到 V3
-- 行为。所以过滤条件写死在函数体里：V4 Worker 只领 policy_version = 4。
create or replace function public.claim_next_story_task(
  p_worker_id text,
  p_lease_seconds integer default 900
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_task public.analysis_story_task;
  v_job public.analysis_job;
  v_cfg public.ai_model_config;
  v_lock_key bigint;
  v_active integer;
  v_story public.review_story;
  v_token uuid;
  v_model jsonb;
  v_policy jsonb;
  v_revision integer;
  v_run public.analysis_agent_run;
begin
  if p_worker_id is null or btrim(p_worker_id) = '' then
    raise exception 'worker_id is required';
  end if;
  if p_lease_seconds is null or p_lease_seconds < 30 then
    p_lease_seconds := 900;
  end if;

  perform pg_advisory_xact_lock(hashtext('claim_next_story_task'));

  select task.* into v_task
  from public.analysis_story_task task
  join public.analysis_job job on job.id = task.job_id
  where job.status = 'PROCESSING'
    and job.execution_engine = 'deepseek-harness-acp'
    -- V4 Worker 只领 policy_version = 4 的任务；已完结的历史 Job 标成 3，不会被领。
    and job.policy_version = 4
    and (task.lease_expires_at is null or task.lease_expires_at < now())
    and task.agent_status not in ('SUCCEEDED', 'FAILED')
  order by job.created_at, task.created_at
  for update of task skip locked
  limit 1;

  if v_task.id is null then
    return null;
  end if;

  select job.* into v_job from public.analysis_job job where job.id = v_task.job_id;
  select cfg.* into v_cfg from public.ai_model_config cfg where cfg.id = v_job.model_config_id;

  v_lock_key := ('x' || substr(md5(v_job.model_config_id::text), 1, 16))::bit(64)::bigint;
  perform pg_advisory_xact_lock(v_lock_key);

  select count(*) into v_active
  from public.analysis_story_task task
  join public.analysis_job job on job.id = task.job_id
  where job.model_config_id = v_job.model_config_id
    and task.lease_expires_at is not null
    and task.lease_expires_at >= now();

  if v_active >= coalesce(v_cfg.max_parallel_tasks, 4) then
    return null;
  end if;

  v_token := gen_random_uuid();
  update public.analysis_story_task
  set worker_id = p_worker_id,
      lease_expires_at = now() + make_interval(secs => p_lease_seconds),
      heartbeat_at = now(),
      agent_status = 'RUNNING',
      agent_attempt = agent_attempt + 1,
      claim_token_digest = public.agent_claim_token_digest(v_token),
      started_at = coalesce(started_at, now())
  where id = v_task.id
  returning * into v_task;

  -- policy snapshot 缺失只可能出现在 0027 之前创建、仍在 PROCESSING 的在途 Job：
  -- 按当前配置补齐，而不是把 null 传给 Worker。
  v_policy := case
    when v_job.capability_policy_snapshot = '{}'::jsonb
    then public.build_v4_capability_policy(v_job.model_config_id)
    else v_job.capability_policy_snapshot
  end;

  -- fencing revision 在同一个 task 上全局单调，而不是每个 attempt 从 1 重新开始。
  -- 从 1 重新开始的后果是：被接管的旧 attempt 可能持有更高的 revision，从而"反超"
  -- 新 attempt 的写入检查。取全表最大值加一，任何迟到的写入都必然落后。
  select coalesce(max(run.session_revision), 0) + 1 into v_revision
  from public.analysis_agent_run run
  where run.task_id = v_task.id;

  insert into public.analysis_agent_run (
    task_id, job_id, agent_attempt, worker_id, status,
    policy_hash, session_revision
  ) values (
    v_task.id, v_job.id, v_task.agent_attempt, p_worker_id, 'RUNNING',
    encode(sha256(v_policy::text::bytea), 'hex'), v_revision
  )
  on conflict (task_id, agent_attempt) do update
  set worker_id = excluded.worker_id,
      status = 'RUNNING',
      started_at = now(),
      session_revision = excluded.session_revision,
      cancel_requested_at = null,
      cancel_reason = null,
      sealed_at = null,
      error_code = null,
      error_message = null
  returning * into v_run;

  select * into v_story from public.review_story where id = v_task.story_id;

  v_model := v_job.model_snapshot || jsonb_build_object(
    'context_window', coalesce(
      nullif(v_job.model_snapshot->>'context_window', '')::integer, v_cfg.context_window
    ),
    'max_output_tokens', coalesce(
      nullif(v_job.model_snapshot->>'max_output_tokens', '')::integer, v_cfg.max_output_tokens
    ),
    'agent_max_model_requests', coalesce(
      nullif(v_job.model_snapshot->>'agent_max_model_requests', '')::integer,
      v_cfg.agent_max_model_requests
    ),
    'agent_max_retry_requests', coalesce(
      nullif(v_job.model_snapshot->>'agent_max_retry_requests', '')::integer,
      v_cfg.agent_max_retry_requests
    ),
    'agent_max_compaction_requests', coalesce(
      nullif(v_job.model_snapshot->>'agent_max_compaction_requests', '')::integer,
      v_cfg.agent_max_compaction_requests
    )
  );

  return (to_jsonb(v_task) - 'claim_token_digest')
    || jsonb_build_object(
      'claim_token', v_token,
      'agent_run_id', v_run.id,
      'session_revision', v_run.session_revision,
      'policy_version', v_job.policy_version,
      'capability_policy', v_policy,
      'policy_hash', v_run.policy_hash,
      'harness_version', v_job.harness_version,
      'capability_contract_hash', v_job.capability_contract_hash,
      'job', jsonb_build_object(
        'id', v_job.id,
        'batch_id', v_job.batch_id,
        'model_config_id', v_job.model_config_id,
        'requested_branch', v_job.requested_branch,
        'total_stories', v_job.total_stories,
        'policy_version', v_job.policy_version
      ),
      'model', v_model,
      'snapshots', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'repository_name', snapshot.repository_name,
          'requested_branch', snapshot.requested_branch,
          'commit_sha', snapshot.commit_sha,
          'commit_subject', snapshot.commit_subject
        ) order by snapshot.repository_name), '[]'::jsonb)
        from public.analysis_repository_snapshot snapshot
        where snapshot.job_id = v_job.id
      ),
      'story', jsonb_build_object(
        'story_id', v_story.id,
        'story_code', v_story.story_code,
        'story_name', v_story.story_name,
        'description', null,
        'acceptance_criteria', null,
        'project_name', v_story.project_name,
        'application_name', v_story.application_name,
        'source_data', v_story.source_data
      )
    );
end;
$$;

-- 13.3 heartbeat：一次往返同时续租并返回取消状态。
--
-- V3 的 `heartbeat_story_task` 返回 boolean，返回类型无法用 create or replace 改，
-- 而"用户取消要等下一轮轮询才生效"是不可接受的延迟。因此真正的实现放在这个新函数里，
-- 旧签名降级为它的包装器 —— 既没有版本后缀重载，也只有一条代码路径。
create or replace function public.heartbeat_analysis_attempt(
  p_task_id uuid,
  p_worker_id text,
  p_claim_token uuid,
  p_lease_seconds integer default 900
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_task public.analysis_story_task;
  v_run public.analysis_agent_run;
begin
  if p_claim_token is null then
    return jsonb_build_object('lease_held', false, 'cancel_requested', false);
  end if;
  if p_lease_seconds is null or p_lease_seconds < 30 then
    p_lease_seconds := 900;
  end if;

  update public.analysis_story_task task
  set heartbeat_at = now(),
      lease_expires_at = now() + make_interval(secs => p_lease_seconds)
  where task.id = p_task_id
    and task.worker_id = p_worker_id
    and task.lease_expires_at is not null
    and task.lease_expires_at >= now()
    and task.claim_token_digest = public.agent_claim_token_digest(p_claim_token)
    and exists (
      select 1 from public.analysis_job job
      where job.id = task.job_id
        and job.execution_engine = 'deepseek-harness-acp'
        and job.status = 'PROCESSING'
    )
  returning * into v_task;

  if v_task.id is null then
    return jsonb_build_object('lease_held', false, 'cancel_requested', false);
  end if;

  select * into v_run from public.analysis_agent_run
  where task_id = p_task_id and agent_attempt = v_task.agent_attempt;

  return jsonb_build_object(
    'lease_held', true,
    'cancel_requested', v_run.cancel_requested_at is not null,
    'cancel_reason', v_run.cancel_reason,
    'sealed', v_run.sealed_at is not null,
    'session_revision', coalesce(v_run.session_revision, 0),
    'lease_expires_at', v_task.lease_expires_at
  );
end;
$$;

create or replace function public.heartbeat_story_task(
  p_task_id uuid,
  p_worker_id text,
  p_claim_token uuid,
  p_lease_seconds integer default 900
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  return coalesce(
    (public.heartbeat_analysis_attempt(
      p_task_id, p_worker_id, p_claim_token, p_lease_seconds
    )->>'lease_held')::boolean,
    false
  );
end;
$$;

-- 13.7 回填 attempt 的 Harness / profile / policy 版本与 tree digest。
--
-- 这些值只有在 Worker 物化完 profile 之后才存在，而 Job 是浏览器建的，所以它们在这里
-- 回填。同一个 Job 内第一次回填即冻结 Harness 版本；后续 attempt 报出不同版本会被拒绝，
-- 否则"生产 Job 能追溯到唯一 Harness/profile/policy 组合"就不成立。
create or replace function public.record_analysis_attempt_profile(
  p_task_id uuid,
  p_worker_id text,
  p_claim_token uuid,
  p_agent_attempt integer,
  p_harness_version text,
  p_capability_contract_hash text,
  p_profile_hash text,
  p_policy_hash text,
  p_root_agent_id text default null,
  p_root_session_id text default null,
  p_tree_digest text default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_task public.analysis_story_task;
  v_job public.analysis_job;
  v_run public.analysis_agent_run;
begin
  select * into v_task from public.analysis_story_task where id = p_task_id;
  if v_task.id is null
     or v_task.worker_id is distinct from p_worker_id
     or v_task.lease_expires_at is null
     or v_task.lease_expires_at < now()
     or p_claim_token is null
     or v_task.claim_token_digest is distinct from public.agent_claim_token_digest(p_claim_token)
     or p_agent_attempt is distinct from v_task.agent_attempt then
    return false;
  end if;

  select * into v_job from public.analysis_job where id = v_task.job_id for update;
  select * into v_run from public.analysis_agent_run
  where task_id = p_task_id and agent_attempt = p_agent_attempt
  for update;

  if v_run.id is null
     or nullif(p_harness_version, '') is null
     or nullif(p_capability_contract_hash, '') is null
     or nullif(p_profile_hash, '') is null
     or nullif(p_policy_hash, '') is null
     or nullif(p_root_agent_id, '') is null
     or nullif(p_root_session_id, '') is null
     or nullif(p_tree_digest, '') is null then
    raise exception 'AGENT_IDENTITY_INVALID';
  end if;
  if v_job.harness_version is not null
     and v_job.harness_version <> p_harness_version then
    raise exception 'SESSION_FORMAT_UNSUPPORTED';
  end if;
  if v_job.capability_contract_hash is not null
     and v_job.capability_contract_hash <> p_capability_contract_hash then
    raise exception 'SESSION_FORMAT_UNSUPPORTED';
  end if;
  if v_job.policy_hash is distinct from p_policy_hash
     or (v_run.policy_hash is not null and v_run.policy_hash <> p_policy_hash)
     or (v_run.root_agent_id is not null and v_run.root_agent_id <> p_root_agent_id)
     or (v_run.root_session_id is not null and v_run.root_session_id <> p_root_session_id) then
    raise exception 'AGENT_IDENTITY_INVALID';
  end if;

  update public.analysis_job
  set harness_version = coalesce(harness_version, p_harness_version),
      capability_contract_hash = coalesce(capability_contract_hash, p_capability_contract_hash),
      profile_hash = coalesce(profile_hash, p_profile_hash)
  where id = v_job.id;

  update public.analysis_agent_run
  set policy_hash = p_policy_hash,
      root_agent_id = p_root_agent_id,
      root_session_id = p_root_session_id,
      tree_digest = p_tree_digest
  where id = v_run.id;

  return true;
end;
$$;

-- 13.4 save：校验 root identity、tree digest、session revision 与 policy hash。
--
-- 签名与 V3 完全一致。V4 的身份字段通过 `p_usage` 携带（`root_agent_id`、
-- `root_session_id`、`tree_digest`、`session_revision`、`policy_hash`）—— 它们和 usage
-- 一样都是"Worker 观测到的 attempt 元数据"，都不来自模型自报。给函数加参数会留下一个
-- 不做 root 校验的旧重载，那等于把 root-only 的第三层校验做成可绕过的。
create or replace function public.save_agent_review_result(
  p_task_id uuid,
  p_worker_id text,
  p_claim_token uuid,
  p_agent_attempt integer,
  p_result jsonb,
  p_evidence jsonb,
  p_usage jsonb default '{}'::jsonb,
  p_config_hash text default null,
  p_prompt_version text default null,
  p_model_label text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_task public.analysis_story_task;
  v_job public.analysis_job;
  v_run public.analysis_agent_run;
  v_run_id uuid;
  v_root public.analysis_agent_node;
  v_evidence jsonb;
  v_producer uuid;
  v_committed_at timestamptz;
  v_root_agent_id text := nullif(p_usage->>'root_agent_id', '');
  v_root_session_id text := nullif(p_usage->>'root_session_id', '');
  v_tree_digest text := nullif(p_usage->>'tree_digest', '');
  v_db_tree_digest text;
  v_session_revision integer := nullif(p_usage->>'session_revision', '')::integer;
  v_policy_hash text := nullif(p_usage->>'policy_hash', '');
begin
  select * into v_task from public.analysis_story_task where id = p_task_id for update;
  if v_task.id is null then
    raise exception 'task not found';
  end if;

  select * into v_job from public.analysis_job where id = v_task.job_id for update;
  if v_job.execution_engine <> 'deepseek-harness-acp' then
    raise exception 'LEGACY_ENGINE_RETIRED';
  end if;
  if v_job.status <> 'PROCESSING' then
    raise exception 'job is not processing';
  end if;
  if v_task.worker_id is distinct from p_worker_id
     or v_task.lease_expires_at is null
     or v_task.lease_expires_at < now() then
    raise exception 'TASK_LEASE_LOST';
  end if;
  if p_claim_token is null
     or v_task.claim_token_digest is distinct from public.agent_claim_token_digest(p_claim_token)
     or p_agent_attempt is distinct from v_task.agent_attempt then
    raise exception 'AGENT_CLAIM_INVALID';
  end if;
  if jsonb_typeof(p_result) <> 'object' then
    raise exception 'result must be an object';
  end if;
  if exists (
    select 1 from public.analysis_agent_run
    where task_id = p_task_id and status = 'COMMITTED'
  ) then
    raise exception 'AGENT_RESULT_ALREADY_COMMITTED';
  end if;

  select * into v_run from public.analysis_agent_run
  where task_id = p_task_id and agent_attempt = p_agent_attempt
  for update;

  -- V4 的数据库层独立、完整地强制 root-only 与 fencing；任何可信元数据缺失都
  -- fail closed，不能依赖 Worker“记得传”。
  if v_job.policy_version = 4 then
    if v_run.id is null then
      raise exception 'AGENT_IDENTITY_INVALID';
    end if;
    if v_run.sealed_at is not null then
      raise exception 'ATTEMPT_ALREADY_SEALED';
    end if;
    if v_run.cancel_requested_at is not null then
      raise exception 'AGENT_TREE_CANCELLED';
    end if;

    select * into v_root from public.analysis_agent_node
    where agent_run_id = v_run.id and provider = 'root';
    if v_root.id is null
       or v_root_agent_id is null
       or v_root.agent_id <> v_root_agent_id then
      raise exception 'SUBMIT_ROOT_ONLY';
    end if;
    if v_root_session_id is null or v_root.session_id <> v_root_session_id then
      raise exception 'SUBMIT_ROOT_ONLY';
    end if;
    if v_root.status = 'CANCELLED' then
      raise exception 'AGENT_TREE_CANCELLED';
    end if;
    if v_root.status <> 'RUNNING' then
      raise exception 'SUBMIT_ROOT_ONLY';
    end if;

    if v_session_revision is null
       or v_session_revision <> v_run.session_revision then
      raise exception 'SESSION_FENCED';
    end if;
    if v_policy_hash is null
       or v_run.policy_hash is null
       or v_policy_hash <> v_run.policy_hash
       or v_policy_hash <> v_job.policy_hash then
      raise exception 'AGENT_IDENTITY_INVALID';
    end if;

    v_db_tree_digest := public.analysis_agent_tree_digest(v_run.id);
    if v_tree_digest is null or v_tree_digest <> v_db_tree_digest then
      raise exception 'AGENT_IDENTITY_INVALID';
    end if;
  end if;

  v_committed_at := now();

  insert into public.analysis_agent_run (
    task_id, job_id, agent_attempt, worker_id, status,
    profile_config_hash, prompt_version, model_label,
    tool_calls, evidence_shown, searches_run, retry_requests, compaction_requests,
    model_requests, root_model_requests, child_model_requests,
    web_requests, web_bytes, input_tokens, output_tokens,
    root_agent_id, root_session_id, tree_digest, policy_hash,
    session_revision, sealed_at, committed_at, finished_at
  ) values (
    p_task_id, v_task.job_id, p_agent_attempt, p_worker_id, 'COMMITTED',
    p_config_hash, p_prompt_version, p_model_label,
    greatest(coalesce((p_usage->>'tool_calls')::integer, 0), 0),
    greatest(coalesce((p_usage->>'evidence_shown')::integer, 0), 0),
    greatest(coalesce((p_usage->>'searches_run')::integer, 0), 0),
    greatest(coalesce((p_usage->>'retry_requests')::integer, 0), 0),
    greatest(coalesce((p_usage->>'compaction_requests')::integer, 0), 0),
    greatest(coalesce((p_usage->>'model_requests')::integer, 0), 0),
    greatest(coalesce((p_usage->>'root_model_requests')::integer, 0), 0),
    greatest(coalesce((p_usage->>'child_model_requests')::integer, 0), 0),
    greatest(coalesce((p_usage->>'web_requests')::integer, 0), 0),
    greatest(coalesce((p_usage->>'web_bytes')::bigint, 0), 0),
    nullif(p_usage->>'input_tokens', '')::bigint,
    nullif(p_usage->>'output_tokens', '')::bigint,
    v_root_agent_id, v_root_session_id, v_tree_digest,
    coalesce(v_policy_hash, encode(sha256(v_job.capability_policy_snapshot::text::bytea), 'hex')),
    coalesce(v_session_revision, 1), v_committed_at, v_committed_at, v_committed_at
  )
  on conflict (task_id, agent_attempt) do update
  set status = 'COMMITTED',
      worker_id = excluded.worker_id,
      profile_config_hash = excluded.profile_config_hash,
      prompt_version = excluded.prompt_version,
      model_label = excluded.model_label,
      tool_calls = greatest(public.analysis_agent_run.tool_calls, excluded.tool_calls),
      evidence_shown = greatest(public.analysis_agent_run.evidence_shown, excluded.evidence_shown),
      searches_run = greatest(public.analysis_agent_run.searches_run, excluded.searches_run),
      retry_requests = greatest(public.analysis_agent_run.retry_requests, excluded.retry_requests),
      compaction_requests = greatest(
        public.analysis_agent_run.compaction_requests, excluded.compaction_requests
      ),
      model_requests = greatest(public.analysis_agent_run.model_requests, excluded.model_requests),
      root_model_requests = greatest(
        public.analysis_agent_run.root_model_requests, excluded.root_model_requests
      ),
      child_model_requests = greatest(
        public.analysis_agent_run.child_model_requests, excluded.child_model_requests
      ),
      web_requests = greatest(public.analysis_agent_run.web_requests, excluded.web_requests),
      web_bytes = greatest(public.analysis_agent_run.web_bytes, excluded.web_bytes),
      input_tokens = coalesce(excluded.input_tokens, public.analysis_agent_run.input_tokens),
      output_tokens = coalesce(excluded.output_tokens, public.analysis_agent_run.output_tokens),
      root_agent_id = coalesce(excluded.root_agent_id, public.analysis_agent_run.root_agent_id),
      root_session_id = coalesce(
        excluded.root_session_id, public.analysis_agent_run.root_session_id
      ),
      tree_digest = coalesce(excluded.tree_digest, public.analysis_agent_run.tree_digest),
      session_revision = greatest(
        public.analysis_agent_run.session_revision, excluded.session_revision
      ),
      sealed_at = excluded.sealed_at,
      committed_at = excluded.committed_at,
      finished_at = excluded.finished_at,
      error_code = null,
      error_message = null
  returning id into v_run_id;

  delete from public.analysis_agent_evidence where agent_run_id = v_run_id;

  if jsonb_typeof(p_evidence) = 'array' then
    for v_evidence in select * from jsonb_array_elements(p_evidence)
    loop
      -- 只有 pinned snapshot 证据需要落在冻结 Commit 上；Artifact 证据走
      -- analysis_artifact，绝不能冒充"现有实现"。
      if coalesce(v_evidence->>'evidence_origin', 'PINNED_SNAPSHOT') <> 'PINNED_SNAPSHOT' then
        raise exception 'EVIDENCE_ORIGIN_INVALID';
      end if;
      if not exists (
        select 1 from public.analysis_repository_snapshot snapshot
        where snapshot.job_id = v_task.job_id
          and snapshot.repository_name = v_evidence->>'repository_name'
          and lower(snapshot.commit_sha) = lower(v_evidence->>'commit_sha')
      ) then
        raise exception 'EVIDENCE_PATH_INVALID';
      end if;

      v_producer := null;
      if v_evidence->>'producer_agent_id' is not null then
        select id into v_producer from public.analysis_agent_node
        where agent_run_id = v_run_id and agent_id = v_evidence->>'producer_agent_id';
        -- 证据的生产者必须属于当前 Agent Tree。跨 tree 引用直接拒绝。
        if v_producer is null then
          raise exception 'EVIDENCE_AGENT_INVALID';
        end if;
      end if;

      insert into public.analysis_agent_evidence (
        agent_run_id, evidence_id, repository_name, commit_sha, file_path, blob_sha,
        start_line, end_line, content_hash, evidence_type, description,
        producer_agent_node_id, producer_session_id, tool_call_id,
        evidence_origin, policy_hash, session_revision
      ) values (
        v_run_id,
        v_evidence->>'evidence_id',
        v_evidence->>'repository_name',
        lower(v_evidence->>'commit_sha'),
        v_evidence->>'file_path',
        lower(v_evidence->>'blob_sha'),
        (v_evidence->>'start_line')::integer,
        (v_evidence->>'end_line')::integer,
        v_evidence->>'content_hash',
        v_evidence->>'evidence_type',
        v_evidence->>'description',
        v_producer,
        v_evidence->>'producer_session_id',
        v_evidence->>'tool_call_id',
        'PINNED_SNAPSHOT',
        coalesce(v_policy_hash, v_run.policy_hash),
        coalesce(v_session_revision, 1)
      );
    end loop;
  end if;

  -- 提交成功即封存整棵 Agent Tree：迟到的 child 不能再改变结果。
  update public.analysis_agent_node
  set status = case when status = 'RUNNING' then 'FINISHED' else status end,
      finished_at = coalesce(finished_at, v_committed_at)
  where agent_run_id = v_run_id;

  update public.analysis_story_task
  set agent_status = 'SUCCEEDED',
      agent_output = p_result,
      agent_model = coalesce(p_model_label, agent_model),
      agent_prompt_version = coalesce(p_prompt_version, agent_prompt_version),
      claim_token_digest = null,
      worker_id = null,
      lease_expires_at = null,
      heartbeat_at = now(),
      finished_at = v_committed_at
  where id = p_task_id;

  update public.analysis_job
  set analyzed_stories = (
    select count(*) from public.analysis_story_task
    where job_id = v_task.job_id and agent_status = 'SUCCEEDED'
  )
  where id = v_task.job_id;

  return jsonb_build_object(
    'run_id', v_run_id,
    'committed_at', v_committed_at,
    'sealed', true
  );
end;
$$;

-- 13.5 fail：先 fence/revoke，再终止整棵 Agent Tree。
create or replace function public.fail_agent_review(
  p_task_id uuid,
  p_worker_id text,
  p_claim_token uuid,
  p_error_code text,
  p_error_message text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job_id uuid;
  v_engine text;
  v_attempt integer;
  v_ok boolean;
  v_run_id uuid;
begin
  select task.job_id, job.execution_engine into v_job_id, v_engine
  from public.analysis_story_task task
  join public.analysis_job job on job.id = task.job_id
  where task.id = p_task_id;

  if v_job_id is null then
    raise exception 'task not found';
  end if;
  if v_engine <> 'deepseek-harness-acp' then
    raise exception 'LEGACY_ENGINE_RETIRED';
  end if;

  perform pg_advisory_xact_lock(public.analysis_job_lock_key(v_job_id));

  select task.agent_attempt,
         (
           p_claim_token is not null
           and task.worker_id = p_worker_id
           and task.lease_expires_at is not null
           and task.lease_expires_at >= now()
           and task.claim_token_digest = public.agent_claim_token_digest(p_claim_token)
         )
    into v_attempt, v_ok
  from public.analysis_story_task task
  where task.id = p_task_id
  for update;

  if not coalesce(v_ok, false) then
    raise exception 'TASK_LEASE_LOST';
  end if;

  -- 顺序是 fence → 终止节点 → 落错误：反过来会给迟到的 child 留下写入窗口。
  update public.analysis_agent_run
  set status = 'FAILED',
      error_code = p_error_code,
      error_message = p_error_message,
      cancel_requested_at = coalesce(cancel_requested_at, now()),
      cancel_reason = coalesce(cancel_reason, p_error_code),
      sealed_at = coalesce(sealed_at, now()),
      session_revision = session_revision + 1,
      finished_at = now()
  where task_id = p_task_id
    and agent_attempt = v_attempt
    and status <> 'COMMITTED'
  returning id into v_run_id;

  if v_run_id is not null then
    update public.analysis_agent_node
    set status = 'CANCELLED',
        error_code = coalesce(error_code, p_error_code),
        cancelled_at = coalesce(cancelled_at, now()),
        finished_at = coalesce(finished_at, now())
    where agent_run_id = v_run_id
      and status = 'RUNNING';

    update public.analysis_session_checkpoint
    set status = 'SEALED'
    where agent_run_id = v_run_id and status = 'OPEN';
  end if;

  update public.analysis_story_task task
  set agent_status = case
        when task.id = p_task_id then 'FAILED'
        when task.agent_status = 'RUNNING' then 'PENDING'
        else task.agent_status
      end,
      worker_id = null,
      lease_expires_at = null,
      heartbeat_at = null,
      claim_token_digest = null,
      error_code = case when task.id = p_task_id then p_error_code else task.error_code end,
      error_message = case when task.id = p_task_id then p_error_message else task.error_message end,
      finished_at = case when task.id = p_task_id then now() else task.finished_at end
  where task.job_id = v_job_id;

  update public.analysis_job
  set status = 'FAILED',
      worker_id = null,
      locked_at = null,
      finalizer_worker_id = null,
      finalize_lease_expires_at = null,
      error_code = p_error_code,
      error_message = p_error_message,
      finished_at = now()
  where id = v_job_id
    and status <> 'SUCCEEDED';
end;
$$;

-- 13.6 stale reclaim：旧 attempt 的工具、usage 和提交立即失效。
create or replace function public.reclaim_stale_story_task_leases()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer := 0;
  v_task record;
begin
  perform pg_advisory_xact_lock(hashtext('claim_next_story_task'));

  for v_task in
    select task.id, task.agent_attempt
    from public.analysis_story_task task
    join public.analysis_job job on job.id = task.job_id
    where job.status = 'PROCESSING'
      and job.execution_engine = 'deepseek-harness-acp'
      and task.worker_id is not null
      and task.lease_expires_at >= now()
      and task.agent_status not in ('SUCCEEDED', 'FAILED')
      and not exists (
        select 1
        from public.analysis_worker_heartbeat heartbeat
        where heartbeat.worker_id = task.worker_id
          and heartbeat.last_seen_at >= now() - interval '20 seconds'
      )
    for update of task skip locked
  loop
    -- fence 掉旧 attempt：revision 前进 + sealed，让它此后的任何写入都失败。
    update public.analysis_agent_run
    set status = 'FAILED',
        error_code = 'WORKER_LOST',
        error_message = 'Worker heartbeat expired; task was requeued for takeover',
        cancel_requested_at = coalesce(cancel_requested_at, now()),
        cancel_reason = coalesce(cancel_reason, 'WORKER_LOST'),
        sealed_at = coalesce(sealed_at, now()),
        session_revision = session_revision + 1,
        finished_at = now()
    where task_id = v_task.id
      and agent_attempt = v_task.agent_attempt
      and status = 'RUNNING';

    update public.analysis_agent_node node
    set status = 'CANCELLED',
        cancelled_at = coalesce(node.cancelled_at, now()),
        finished_at = coalesce(node.finished_at, now())
    where node.status = 'RUNNING'
      and node.agent_run_id in (
        select run.id from public.analysis_agent_run run
        where run.task_id = v_task.id and run.agent_attempt = v_task.agent_attempt
      );

    update public.analysis_story_task
    set agent_status = 'PENDING',
        worker_id = null,
        lease_expires_at = null,
        heartbeat_at = null,
        claim_token_digest = null,
        error_code = null,
        error_message = null,
        finished_at = null
    where id = v_task.id;

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

------------------------------------------------------------------------------
-- 14. 前端只读 RPC：Agent Tree / Usage / Audit 摘要
--
--     浏览器拿到的只有安全元数据：不含源码、Prompt、Session JSONL、token 和 Key。
------------------------------------------------------------------------------

-- VIEWER 只读：能看批次就能看这个批次的 Agent 运行摘要，但不能启动或取消。
-- 0007 只定义了 manage 语义，V4 详情页需要一个明确的 view 语义。
create or replace function public.can_view_review_batch(p_batch_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.review_batch batch
    join public.user_profile profile on profile.id = (select auth.uid())
    where batch.id = p_batch_id
      and profile.role in ('ADMIN', 'REVIEWER', 'VIEWER')
  );
$$;

create or replace function public.ensure_view_review_batch(p_batch_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.can_view_review_batch(p_batch_id) then
    raise exception 'batch read permission required';
  end if;
end;
$$;

revoke execute on function public.can_view_review_batch(uuid) from public, anon;
grant execute on function public.can_view_review_batch(uuid) to authenticated, service_role;
revoke execute on function public.ensure_view_review_batch(uuid) from public, anon;
grant execute on function public.ensure_view_review_batch(uuid) to authenticated, service_role;

create or replace function public.get_analysis_agent_run_detail(p_task_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_job_id uuid;
  v_batch_id uuid;
  v_run public.analysis_agent_run;
begin
  select task.job_id, job.batch_id into v_job_id, v_batch_id
  from public.analysis_story_task task
  join public.analysis_job job on job.id = task.job_id
  where task.id = p_task_id;

  if v_job_id is null then
    return null;
  end if;
  perform public.ensure_view_review_batch(v_batch_id);

  select * into v_run from public.analysis_agent_run
  where task_id = p_task_id
  order by agent_attempt desc
  limit 1;

  if v_run.id is null then
    return null;
  end if;

  return jsonb_build_object(
    'run_id', v_run.id,
    'task_id', v_run.task_id,
    'job_id', v_run.job_id,
    'agent_attempt', v_run.agent_attempt,
    'status', v_run.status,
    'policy_hash', v_run.policy_hash,
    'tree_digest', v_run.tree_digest,
    'session_revision', v_run.session_revision,
    'resume_count', v_run.resume_count,
    'cancel_requested_at', v_run.cancel_requested_at,
    'cancel_reason', v_run.cancel_reason,
    'sealed_at', v_run.sealed_at,
    'error_code', v_run.error_code,
    'started_at', v_run.started_at,
    'committed_at', v_run.committed_at,
    'finished_at', v_run.finished_at,
    'usage', jsonb_build_object(
      'model_requests', v_run.model_requests,
      'root_model_requests', v_run.root_model_requests,
      'child_model_requests', v_run.child_model_requests,
      'retry_requests', v_run.retry_requests,
      'compaction_requests', v_run.compaction_requests,
      'ralph_rounds', v_run.ralph_rounds,
      'tool_calls', v_run.tool_calls,
      'evidence_shown', v_run.evidence_shown,
      'searches_run', v_run.searches_run,
      'web_requests', v_run.web_requests,
      'web_bytes', v_run.web_bytes,
      'input_tokens', v_run.input_tokens,
      'output_tokens', v_run.output_tokens,
      'agent_count', v_run.agent_count,
      'max_depth_reached', v_run.max_depth_reached
    ),
    'agents', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'node_id', node.id,
        'agent_id', node.agent_id,
        'parent_node_id', node.parent_agent_node_id,
        'agent_role', node.agent_role,
        'provider', node.provider,
        'delegation_depth', node.delegation_depth,
        'status', node.status,
        'model_requests', node.model_requests,
        'tool_calls', node.tool_calls,
        'evidence_produced', node.evidence_produced,
        'error_code', node.error_code,
        'started_at', node.started_at,
        'finished_at', node.finished_at
      ) order by node.delegation_depth, node.started_at), '[]'::jsonb)
      from public.analysis_agent_node node
      where node.agent_run_id = v_run.id
    ),
    'tool_summary', (
      select coalesce(jsonb_agg(row_to_json(summary)::jsonb), '[]'::jsonb)
      from (
        select audit.tool_name,
               audit.permission_verdict,
               count(*)::integer as call_count,
               coalesce(sum(audit.duration_ms), 0)::integer as total_duration_ms
        from public.analysis_tool_audit audit
        where audit.agent_run_id = v_run.id
        group by audit.tool_name, audit.permission_verdict
        order by audit.tool_name
      ) summary
    ),
    'artifacts', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'artifact_id', artifact.id,
        'artifact_type', artifact.artifact_type,
        'workspace_path', artifact.workspace_path,
        'content_hash', artifact.content_hash,
        'size_bytes', artifact.size_bytes,
        'verification_status', artifact.verification_status,
        'created_at', artifact.created_at
      ) order by artifact.created_at), '[]'::jsonb)
      from public.analysis_artifact artifact
      where artifact.agent_run_id = v_run.id
    ),
    'evidence', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'evidence_id', evidence.evidence_id,
        'repository_name', evidence.repository_name,
        'file_path', evidence.file_path,
        'start_line', evidence.start_line,
        'end_line', evidence.end_line,
        'evidence_type', evidence.evidence_type,
        'evidence_origin', evidence.evidence_origin,
        'description', evidence.description,
        'producer_agent_node_id', evidence.producer_agent_node_id
      ) order by evidence.repository_name, evidence.file_path), '[]'::jsonb)
      from public.analysis_agent_evidence evidence
      where evidence.agent_run_id = v_run.id
    )
  );
end;
$$;

-- 管理员查看默认能力策略。普通启动流程不展示任何开关。
create or replace function public.admin_get_v4_capability_policy(p_model_config_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
begin
  perform public.ensure_admin();
  return public.build_v4_capability_policy(p_model_config_id);
end;
$$;

------------------------------------------------------------------------------
-- 15. 授权：写 RPC 一律 service-role only
------------------------------------------------------------------------------

do $$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'public.register_analysis_agent_node(uuid, text, uuid, integer, text, text, text, text, text, text)',
    'public.mark_analysis_agent_node_terminal(uuid, text, uuid, integer, text, text, text)',
    'public.reserve_analysis_agent_budget(uuid, text, uuid, integer, text, text, integer)',
    'public.commit_analysis_agent_usage(uuid, text, uuid, integer, jsonb, jsonb)',
    'public.append_analysis_tool_audit(uuid, text, uuid, integer, jsonb, jsonb)',
    'public.save_analysis_session_checkpoint(uuid, text, uuid, integer, text, integer, text, text, integer, text, text, text)',
    'public.load_resumable_analysis_attempt(uuid, text, uuid)',
    'public.save_analysis_artifact(uuid, text, uuid, integer, text, text, text, text, bigint, text)',
    'public.record_analysis_attempt_profile(uuid, text, uuid, integer, text, text, text, text, text, text, text)',
    'public.claim_next_story_task(text, integer)',
    'public.heartbeat_analysis_attempt(uuid, text, uuid, integer)',
    'public.heartbeat_story_task(uuid, text, uuid, integer)',
    'public.save_agent_review_result(uuid, text, uuid, integer, jsonb, jsonb, jsonb, text, text, text)',
    'public.fail_agent_review(uuid, text, uuid, text, text)',
    'public.reclaim_stale_story_task_leases()'
  ]
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', v_signature);
    execute format('grant execute on function %s to service_role', v_signature);
  end loop;
end;
$$;

-- 取消与只读详情由登录用户按批次权限调用；RPC 内部自己做授权检查。
revoke execute on function public.request_analysis_attempt_cancel(uuid, text)
  from public, anon;
grant execute on function public.request_analysis_attempt_cancel(uuid, text)
  to authenticated, service_role;

revoke execute on function public.get_analysis_agent_run_detail(uuid) from public, anon;
grant execute on function public.get_analysis_agent_run_detail(uuid)
  to authenticated, service_role;

revoke execute on function public.admin_get_v4_capability_policy(uuid) from public, anon;
grant execute on function public.admin_get_v4_capability_policy(uuid)
  to authenticated, service_role;

-- enqueue 保持 V3 的单参数签名与授权：浏览器点一次"开始 AI 分析"就调用它。
revoke execute on function public.enqueue_analysis_job(uuid) from public, anon;
grant execute on function public.enqueue_analysis_job(uuid)
  to authenticated, service_role;

commit;
