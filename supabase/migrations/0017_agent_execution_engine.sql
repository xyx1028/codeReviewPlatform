-- 0017_agent_execution_engine.sql
-- 引入 Agent 执行引擎（DeepSeek Harness ACP 单 Agent）所需的数据库支持：
--  * analysis_job.execution_engine（对 Job 永久不可变）与 ai_model_config.execution_engine；
--  * analysis_story_task 的 Agent 状态/输出/claim token 摘要；
--  * analysis_agent_run / analysis_agent_evidence：每次 attempt 的运行记录与已验证证据台账；
--  * analysis_worker_heartbeat 的 capabilities/protocol_version 注册；
--  * 全部 v1 Worker RPC 在数据库层收敛为只处理 legacy Job（fencing）；
--  * v2 Worker RPC 按 Worker 能力领取，并提供 Agent 结果的单事务原子提交。
--
-- 兼容性说明：
--  * 纯加法迁移。既有 legacy 链路（0010 + 0016）的行为不变：新增列全部带默认值，
--    v1 RPC 只增加 execution_engine = 'legacy-openai' 的过滤条件。
--  * 旧版本 Worker 镜像只会调用 v1 RPC，因此在数据库层就无法领取或写入 ACP Job，
--    不依赖镜像自觉。这是灰度期间两种引擎并存的唯一可靠隔离手段。
--  * Job 的 execution_engine 一旦写入不可修改；回滚到 legacy 只能新建 replacement Job。
--  * claim token 只在数据库中保存 sha256 摘要，明文仅在领取时返回给 Worker 内存。
--  * 沿用 0010 的约定：不使用 enum 类型，一律 text + check；域错误用裸大写 marker。

begin;

------------------------------------------------------------------------------
-- 1. 引擎取值域与模型配置的默认引擎
------------------------------------------------------------------------------

-- 引擎与 ai_model_config.provider 是两个维度：provider 描述模型协议，
-- execution_engine 描述平台用哪套执行链路。不从 provider 推导引擎。
alter table public.ai_model_config
  add column if not exists execution_engine text not null default 'legacy-openai';

alter table public.ai_model_config
  drop constraint if exists ai_model_config_execution_engine_check;
alter table public.ai_model_config
  add constraint ai_model_config_execution_engine_check
  check (execution_engine in ('legacy-openai', 'deepseek-harness-acp'));

-- Agent 引擎需要的额外模型参数（上下文窗口/单次最大输出/预算），
-- 带保守默认值，legacy 链路不读取这些列。
alter table public.ai_model_config
  add column if not exists context_window integer not null default 131072,
  add column if not exists max_output_tokens integer not null default 8192,
  add column if not exists agent_max_model_requests integer not null default 40,
  add column if not exists agent_max_retry_requests integer not null default 6,
  add column if not exists agent_max_compaction_requests integer not null default 4;

alter table public.ai_model_config
  drop constraint if exists ai_model_config_agent_budget_check;
alter table public.ai_model_config
  add constraint ai_model_config_agent_budget_check
  check (
    context_window between 8192 and 4194304
    and max_output_tokens between 256 and 262144
    and agent_max_model_requests between 1 and 500
    and agent_max_retry_requests between 0 and 100
    and agent_max_compaction_requests between 0 and 100
  );

------------------------------------------------------------------------------
-- 2. analysis_job.execution_engine：写入即不可变
------------------------------------------------------------------------------

alter table public.analysis_job
  add column if not exists execution_engine text not null default 'legacy-openai';

alter table public.analysis_job
  drop constraint if exists analysis_job_execution_engine_check;
alter table public.analysis_job
  add constraint analysis_job_execution_engine_check
  check (execution_engine in ('legacy-openai', 'deepseek-harness-acp'));

create index if not exists idx_analysis_job_engine_status
on public.analysis_job(execution_engine, status, created_at);

-- 同一个 Job 内禁止切换引擎：attempt 之间静默回退会让结果来源无法追溯，
-- 回滚必须通过新建 replacement Job 表达。
create or replace function public.enforce_analysis_job_engine_immutable()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.execution_engine is distinct from old.execution_engine then
    raise exception 'execution_engine is immutable for an existing analysis job';
  end if;
  return new;
end;
$$;

drop trigger if exists enforce_analysis_job_engine_immutable on public.analysis_job;
create trigger enforce_analysis_job_engine_immutable
before update of execution_engine on public.analysis_job
for each row execute function public.enforce_analysis_job_engine_immutable();

revoke execute on function public.enforce_analysis_job_engine_immutable()
  from public, anon, authenticated;

------------------------------------------------------------------------------
-- 3. analysis_story_task：Agent 状态、输出与 claim token 摘要
------------------------------------------------------------------------------

alter table public.analysis_story_task
  add column if not exists agent_status text not null default 'PENDING',
  add column if not exists agent_attempt integer not null default 0,
  add column if not exists agent_output jsonb,
  add column if not exists agent_model text,
  add column if not exists agent_prompt_version text,
  -- 只保存摘要：明文 token 若落在前端可 select 的表里就等于没有 token。
  add column if not exists claim_token_digest text;

alter table public.analysis_story_task
  drop constraint if exists analysis_story_task_agent_status_check;
alter table public.analysis_story_task
  add constraint analysis_story_task_agent_status_check
  check (agent_status in ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED'));

alter table public.analysis_story_task
  drop constraint if exists analysis_story_task_agent_attempt_check;
alter table public.analysis_story_task
  add constraint analysis_story_task_agent_attempt_check
  check (agent_attempt >= 0);

create index if not exists idx_analysis_story_task_agent
on public.analysis_story_task(job_id, agent_status);

------------------------------------------------------------------------------
-- 4. analysis_agent_run：每个 attempt 一条运行记录
------------------------------------------------------------------------------

create table if not exists public.analysis_agent_run (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.analysis_story_task(id) on delete cascade,
  job_id uuid not null references public.analysis_job(id) on delete cascade,
  agent_attempt integer not null check (agent_attempt >= 1),
  worker_id text not null,
  execution_engine text not null
    check (execution_engine in ('legacy-openai', 'deepseek-harness-acp')),
  status text not null default 'RUNNING'
    check (status in ('RUNNING', 'COMMITTED', 'FAILED')),
  profile_config_hash text,
  prompt_version text,
  model_label text,
  -- 计量由 Worker 侧 governor / broker 提供，模型自报的用量不作为真源。
  tool_calls integer not null default 0 check (tool_calls >= 0),
  evidence_shown integer not null default 0 check (evidence_shown >= 0),
  searches_run integer not null default 0 check (searches_run >= 0),
  retry_requests integer not null default 0 check (retry_requests >= 0),
  compaction_requests integer not null default 0 check (compaction_requests >= 0),
  error_code text,
  error_message text,
  started_at timestamptz not null default now(),
  committed_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (task_id, agent_attempt)
);

create index if not exists idx_analysis_agent_run_job
on public.analysis_agent_run(job_id, status);

create index if not exists idx_analysis_agent_run_task
on public.analysis_agent_run(task_id);

-- 一个 task 最多只能有一条 COMMITTED 运行：迟到的 attempt 无法写第二份结果。
create unique index if not exists uq_analysis_agent_run_committed
on public.analysis_agent_run(task_id)
where status = 'COMMITTED';

drop trigger if exists touch_analysis_agent_run_updated_at on public.analysis_agent_run;
create trigger touch_analysis_agent_run_updated_at
before update on public.analysis_agent_run
for each row execute function public.touch_updated_at();

------------------------------------------------------------------------------
-- 5. analysis_agent_evidence：已验证证据台账
--    记录模型实际被展示、并由 Worker 按精确 Commit 重读校验过的范围。
------------------------------------------------------------------------------

create table if not exists public.analysis_agent_evidence (
  id uuid primary key default gen_random_uuid(),
  agent_run_id uuid not null references public.analysis_agent_run(id) on delete cascade,
  evidence_id text not null,
  repository_name text not null,
  commit_sha text not null,
  file_path text not null,
  blob_sha text not null,
  start_line integer not null check (start_line >= 1),
  end_line integer not null check (end_line >= 1),
  content_hash text not null,
  evidence_type text not null
    check (evidence_type in ('现有实现', '缺失依据', '风险依据')),
  description text not null,
  created_at timestamptz not null default now(),
  unique (agent_run_id, evidence_id),
  check (start_line <= end_line),
  check (repository_name in (
    'kdmanage-backend', 'kdmanage-frontend',
    'tmanage-backend', 'tmanage-frontend'
  )),
  check (commit_sha ~ '^[0-9a-f]{40}$'),
  check (blob_sha ~ '^[0-9a-f]{40}$')
);

create index if not exists idx_analysis_agent_evidence_run
on public.analysis_agent_evidence(agent_run_id);

------------------------------------------------------------------------------
-- 6. Worker 能力注册
------------------------------------------------------------------------------

alter table public.analysis_worker_heartbeat
  add column if not exists supported_engines text[] not null
    default array['legacy-openai']::text[],
  add column if not exists protocol_version integer not null default 1,
  add column if not exists capabilities jsonb not null default '{}'::jsonb;

alter table public.analysis_worker_heartbeat
  drop constraint if exists analysis_worker_heartbeat_protocol_check;
alter table public.analysis_worker_heartbeat
  add constraint analysis_worker_heartbeat_protocol_check
  check (protocol_version >= 1);

------------------------------------------------------------------------------
-- 7. RLS：新表默认拒绝前端直读，只经 RPC
------------------------------------------------------------------------------

alter table public.analysis_agent_run enable row level security;
alter table public.analysis_agent_evidence enable row level security;

-- Agent 运行记录属于运行元数据，登录用户可读自己有权管理的批次。
drop policy if exists "read agent run for managed batch" on public.analysis_agent_run;
create policy "read agent run for managed batch" on public.analysis_agent_run
for select to authenticated using (
  exists (
    select 1 from public.analysis_job job
    where job.id = analysis_agent_run.job_id
      and public.can_manage_review_batch(job.batch_id)
  )
);

-- 证据台账包含 blob 摘要与路径，同样按批次管理权可读；写入仅 definer RPC。
drop policy if exists "read agent evidence for managed batch" on public.analysis_agent_evidence;
create policy "read agent evidence for managed batch" on public.analysis_agent_evidence
for select to authenticated using (
  exists (
    select 1
    from public.analysis_agent_run run
    join public.analysis_job job on job.id = run.job_id
    where run.id = analysis_agent_evidence.agent_run_id
      and public.can_manage_review_batch(job.batch_id)
  )
);

grant select on public.analysis_agent_run to authenticated;
grant select on public.analysis_agent_evidence to authenticated;

-- 0010 的意图是"模型配置与 Worker 心跳不给前端直读，一律走 RPC"，但那依赖
-- 环境的默认权限恰好没有授予表级 select。不同 Postgres/Supabase 环境的
-- ALTER DEFAULT PRIVILEGES 并不一致，所以这里把意图显式化：即使某个环境
-- 默认授予了 select，这两张表也拿不到表级权限。
revoke select on public.ai_model_config from anon, authenticated;
revoke select on public.analysis_worker_heartbeat from anon, authenticated;

------------------------------------------------------------------------------
-- 8. 辅助函数
------------------------------------------------------------------------------

-- claim token 摘要：数据库只保存摘要，比较时同样只比较摘要。
create or replace function public.agent_claim_token_digest(p_token uuid)
returns text
language sql
immutable
set search_path = public
as $$
  select case
    when p_token is null then null
    else encode(sha256(p_token::text::bytea), 'hex')
  end;
$$;

revoke execute on function public.agent_claim_token_digest(uuid)
  from public, anon, authenticated;
grant execute on function public.agent_claim_token_digest(uuid) to service_role;

-- Worker 声明的引擎能力与注册记录求交集：只信任两边都承认的引擎。
-- 未注册的 Worker 得到空集合，因此领不到任何任务。
create or replace function public.worker_effective_engines(
  p_worker_id text,
  p_declared_engines text[],
  p_protocol_version integer
)
returns text[]
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_registered text[];
  v_registered_protocol integer;
  v_effective text[];
begin
  if p_worker_id is null or btrim(p_worker_id) = '' then
    raise exception 'worker_id is required';
  end if;

  select supported_engines, protocol_version
    into v_registered, v_registered_protocol
  from public.analysis_worker_heartbeat
  where worker_id = p_worker_id;

  if v_registered is null then
    -- 未注册（或未心跳）不允许领取：能力必须先落库才能交叉校验。
    return array[]::text[];
  end if;

  -- 调用参数与注册记录必须一致，避免只凭调用参数提权。
  if p_protocol_version is null or p_protocol_version <> v_registered_protocol then
    return array[]::text[];
  end if;

  select coalesce(array_agg(engine), array[]::text[])
    into v_effective
  from unnest(coalesce(p_declared_engines, array[]::text[])) as engine
  where engine = any(v_registered);

  return v_effective;
end;
$$;

revoke execute on function public.worker_effective_engines(text, text[], integer)
  from public, anon, authenticated;
grant execute on function public.worker_effective_engines(text, text[], integer)
  to service_role;

-- Job 级 advisory lock key，与 0016 的 fail_story_task 保持同一命名空间。
create or replace function public.analysis_job_lock_key(p_job_id uuid)
returns bigint
language sql
immutable
set search_path = public
as $$
  select ('x' || substr(md5('analysis_job:' || p_job_id::text), 1, 16))::bit(64)::bigint;
$$;

revoke execute on function public.analysis_job_lock_key(uuid)
  from public, anon, authenticated;
grant execute on function public.analysis_job_lock_key(uuid) to service_role;

------------------------------------------------------------------------------
-- 9. v1 Worker RPC 的 legacy fencing
--    旧镜像只会调用这些函数；在数据库层拒绝 ACP Job 是唯一可靠的隔离。
------------------------------------------------------------------------------

-- 9.1 准备阶段领取：只看 legacy Job
create or replace function public.claim_job_for_preparation(
  p_worker_id text,
  p_lease_seconds integer default 900
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.analysis_job;
begin
  if p_worker_id is null or btrim(p_worker_id) = '' then
    raise exception 'worker_id is required';
  end if;
  if p_lease_seconds is null or p_lease_seconds < 30 then
    p_lease_seconds := 900;
  end if;

  select * into v_job
  from public.analysis_job
  where execution_engine = 'legacy-openai'
    and (
      status = 'QUEUED'
      or (
        status = 'PREPARING_CODE'
        and (locked_at is null or locked_at + make_interval(secs => p_lease_seconds) < now())
      )
    )
  order by created_at
  for update skip locked
  limit 1;

  if v_job.id is null then
    return null;
  end if;

  update public.analysis_job
  set status = 'PREPARING_CODE',
      worker_id = p_worker_id,
      attempt = attempt + 1,
      locked_at = now(),
      started_at = coalesce(started_at, now())
  where id = v_job.id
  returning * into v_job;

  return jsonb_build_object(
    'job', jsonb_build_object(
      'id', v_job.id,
      'batch_id', v_job.batch_id,
      'model_config_id', v_job.model_config_id,
      'requested_branch', v_job.requested_branch,
      'total_stories', v_job.total_stories,
      'execution_engine', v_job.execution_engine
    ),
    'model', v_job.model_snapshot
  );
end;
$$;

-- 9.2 快照保存：只允许 legacy Job
create or replace function public.save_repository_snapshots(
  p_job_id uuid,
  p_worker_id text,
  p_snapshots jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.analysis_job
    where id = p_job_id and execution_engine = 'legacy-openai'
  ) then
    raise exception 'ENGINE_NOT_SUPPORTED';
  end if;

  perform public.save_repository_snapshots_v2(p_job_id, p_worker_id, p_snapshots);
end;
$$;

-- 9.3 任务领取：只看 legacy Job
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
  v_model_config_id uuid;
  v_max_parallel integer;
  v_lock_key bigint;
  v_active integer;
  v_story public.review_story;
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
    and job.execution_engine = 'legacy-openai'
    and task.retrieval_status <> 'FAILED'
    and task.analysis_status <> 'FAILED'
    and not (task.retrieval_status = 'SUCCEEDED' and task.analysis_status = 'SUCCEEDED')
    and (task.lease_expires_at is null or task.lease_expires_at < now())
  order by job.created_at, task.created_at
  for update of task skip locked
  limit 1;

  if v_task.id is null then
    return null;
  end if;

  select job.* into v_job from public.analysis_job job where job.id = v_task.job_id;
  v_model_config_id := v_job.model_config_id;

  select max_parallel_tasks into v_max_parallel
  from public.ai_model_config where id = v_model_config_id;
  if v_max_parallel is null then
    v_max_parallel := 4;
  end if;

  v_lock_key := ('x' || substr(md5(v_model_config_id::text), 1, 16))::bit(64)::bigint;
  perform pg_advisory_xact_lock(v_lock_key);

  select count(*) into v_active
  from public.analysis_story_task t
  join public.analysis_job j on j.id = t.job_id
  where j.model_config_id = v_model_config_id
    and t.lease_expires_at is not null
    and t.lease_expires_at >= now();

  if v_active >= v_max_parallel then
    return null;
  end if;

  update public.analysis_story_task
  set worker_id = p_worker_id,
      lease_expires_at = now() + make_interval(secs => p_lease_seconds),
      heartbeat_at = now(),
      retrieval_status = case
        when retrieval_status = 'SUCCEEDED' then retrieval_status else 'RUNNING' end,
      retrieval_attempt = case
        when retrieval_status = 'SUCCEEDED' then retrieval_attempt else retrieval_attempt + 1 end,
      analysis_status = case
        when retrieval_status = 'SUCCEEDED' and analysis_status <> 'SUCCEEDED'
          then 'RUNNING' else analysis_status end,
      analysis_attempt = case
        when retrieval_status = 'SUCCEEDED' and analysis_status <> 'SUCCEEDED'
          then analysis_attempt + 1 else analysis_attempt end,
      started_at = coalesce(started_at, now())
  where id = v_task.id
  returning * into v_task;

  select * into v_story from public.review_story where id = v_task.story_id;

  return to_jsonb(v_task)
    || jsonb_build_object(
      'job', jsonb_build_object(
        'id', v_job.id,
        'batch_id', v_job.batch_id,
        'model_config_id', v_job.model_config_id,
        'requested_branch', v_job.requested_branch,
        'total_stories', v_job.total_stories,
        'execution_engine', v_job.execution_engine
      ),
      'model', v_job.model_snapshot,
      'snapshots', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'repository_name', s.repository_name,
          'requested_branch', s.requested_branch,
          'commit_sha', s.commit_sha,
          'commit_subject', s.commit_subject
        ) order by s.repository_name), '[]'::jsonb)
        from public.analysis_repository_snapshot s
        where s.job_id = v_job.id
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

-- 9.4 心跳：ACP 任务必须用 v2（带 claim token），v1 只续 legacy
create or replace function public.heartbeat_story_task(
  p_task_id uuid,
  p_worker_id text,
  p_lease_seconds integer default 900
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ok boolean;
begin
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
    and exists (
      select 1 from public.analysis_job job
      where job.id = task.job_id and job.execution_engine = 'legacy-openai'
    )
  returning true into v_ok;

  return coalesce(v_ok, false);
end;
$$;

-- 9.5 两阶段结果保存与失败：只允许 legacy
create or replace function public.save_retrieval_result(
  p_task_id uuid,
  p_worker_id text,
  p_result jsonb,
  p_retrieval_model text default null,
  p_prompt_version text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job_id uuid;
  v_held boolean;
  v_engine text;
begin
  select task.job_id,
         (task.worker_id = p_worker_id
          and task.lease_expires_at is not null
          and task.lease_expires_at >= now()),
         job.execution_engine
    into v_job_id, v_held, v_engine
  from public.analysis_story_task task
  join public.analysis_job job on job.id = task.job_id
  where task.id = p_task_id
  for update of task;

  if v_job_id is null then
    raise exception 'task not found';
  end if;
  if v_engine <> 'legacy-openai' then
    raise exception 'ENGINE_NOT_SUPPORTED';
  end if;
  if not coalesce(v_held, false) then
    raise exception 'TASK_LEASE_LOST';
  end if;

  update public.analysis_story_task
  set retrieval_output = p_result,
      retrieval_status = 'SUCCEEDED',
      retrieval_model = coalesce(p_retrieval_model, retrieval_model),
      retrieval_prompt_version = coalesce(p_prompt_version, retrieval_prompt_version),
      heartbeat_at = now()
  where id = p_task_id;

  update public.analysis_job
  set retrieved_stories = (
    select count(*) from public.analysis_story_task
    where job_id = v_job_id and retrieval_status = 'SUCCEEDED'
  )
  where id = v_job_id;
end;
$$;

create or replace function public.save_analysis_result(
  p_task_id uuid,
  p_worker_id text,
  p_result jsonb,
  p_analysis_model text default null,
  p_prompt_version text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job_id uuid;
  v_held boolean;
  v_retrieval_ok boolean;
  v_engine text;
begin
  select task.job_id,
         (task.worker_id = p_worker_id
          and task.lease_expires_at is not null
          and task.lease_expires_at >= now()),
         (task.retrieval_status = 'SUCCEEDED'),
         job.execution_engine
    into v_job_id, v_held, v_retrieval_ok, v_engine
  from public.analysis_story_task task
  join public.analysis_job job on job.id = task.job_id
  where task.id = p_task_id
  for update of task;

  if v_job_id is null then
    raise exception 'task not found';
  end if;
  if v_engine <> 'legacy-openai' then
    raise exception 'ENGINE_NOT_SUPPORTED';
  end if;
  if not coalesce(v_held, false) then
    raise exception 'TASK_LEASE_LOST';
  end if;
  if not coalesce(v_retrieval_ok, false) then
    raise exception 'retrieval stage must succeed before analysis';
  end if;

  update public.analysis_story_task
  set analysis_output = p_result,
      analysis_status = 'SUCCEEDED',
      analysis_model = coalesce(p_analysis_model, analysis_model),
      analysis_prompt_version = coalesce(p_prompt_version, analysis_prompt_version),
      heartbeat_at = now(),
      finished_at = now()
  where id = p_task_id;

  update public.analysis_job
  set analyzed_stories = (
    select count(*) from public.analysis_story_task
    where job_id = v_job_id and analysis_status = 'SUCCEEDED'
  )
  where id = v_job_id;
end;
$$;

-- 9.6 fail_story_task：保留 0016 的 Job 级串行化与批量撤租，加引擎围栏
create or replace function public.fail_story_task(
  p_task_id uuid,
  p_worker_id text,
  p_stage text,
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
  v_held boolean;
begin
  if p_stage is null or p_stage not in ('retrieval', 'analysis') then
    raise exception 'stage must be retrieval or analysis';
  end if;

  select task.job_id, job.execution_engine into v_job_id, v_engine
  from public.analysis_story_task task
  join public.analysis_job job on job.id = task.job_id
  where task.id = p_task_id;

  if v_job_id is null then
    raise exception 'task not found';
  end if;
  if v_engine <> 'legacy-openai' then
    raise exception 'ENGINE_NOT_SUPPORTED';
  end if;

  perform pg_advisory_xact_lock(public.analysis_job_lock_key(v_job_id));

  select (
    task.worker_id = p_worker_id
    and task.lease_expires_at is not null
    and task.lease_expires_at >= now()
  ) into v_held
  from public.analysis_story_task task
  where task.id = p_task_id
  for update;

  if not found then
    raise exception 'task not found';
  end if;
  if not coalesce(v_held, false) then
    raise exception 'TASK_LEASE_LOST';
  end if;

  update public.analysis_story_task task
  set retrieval_status = case
        when task.id = p_task_id and p_stage = 'retrieval' then 'FAILED'
        when task.retrieval_status = 'RUNNING' then 'PENDING'
        else task.retrieval_status
      end,
      analysis_status = case
        when task.id = p_task_id and p_stage = 'analysis' then 'FAILED'
        when task.analysis_status = 'RUNNING' then 'PENDING'
        else task.analysis_status
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

-- 9.7 密钥读取、汇总领取与完成：v1 只服务 legacy
create or replace function public.get_model_secret_for_job(p_job_id uuid, p_worker_id text)
returns text
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_secret_id uuid;
  v_secret text;
  v_status text;
  v_engine text;
begin
  if p_worker_id is null or btrim(p_worker_id) = '' then
    raise exception 'worker_id is required';
  end if;

  select job.status, job.execution_engine, cfg.api_key_secret_id
    into v_status, v_engine, v_secret_id
  from public.analysis_job job
  join public.ai_model_config cfg on cfg.id = job.model_config_id
  where job.id = p_job_id;

  if v_status is null then
    raise exception 'job not found';
  end if;
  if v_engine <> 'legacy-openai' then
    raise exception 'ENGINE_NOT_SUPPORTED';
  end if;
  if v_status <> 'PROCESSING' then
    raise exception 'job is not processing';
  end if;
  if not exists (
    select 1 from public.analysis_story_task t
    where t.job_id = p_job_id
      and t.worker_id = p_worker_id
      and t.lease_expires_at is not null
      and t.lease_expires_at >= now()
  ) then
    raise exception 'TASK_LEASE_LOST';
  end if;

  if not public.model_config_has_api_key(v_secret_id) then
    raise exception 'MODEL_SECRET_MISSING';
  end if;

  select decrypted_secret into v_secret
  from vault.decrypted_secrets
  where id = v_secret_id;

  if v_secret is null then
    raise exception 'MODEL_SECRET_MISSING';
  end if;

  return v_secret;
end;
$$;

create or replace function public.claim_job_for_finalization(
  p_worker_id text,
  p_lease_seconds integer default 900
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.analysis_job;
begin
  if p_worker_id is null or btrim(p_worker_id) = '' then
    raise exception 'worker_id is required';
  end if;
  if p_lease_seconds is null or p_lease_seconds < 30 then
    p_lease_seconds := 900;
  end if;

  select job.* into v_job
  from public.analysis_job job
  where job.execution_engine = 'legacy-openai'
    and (
      (
        job.status = 'PROCESSING'
        and not exists (
          select 1 from public.analysis_story_task t
          where t.job_id = job.id
            and not (t.retrieval_status = 'SUCCEEDED' and t.analysis_status = 'SUCCEEDED')
        )
      )
      or (
        job.status = 'FINALIZING'
        and (job.finalize_lease_expires_at is null or job.finalize_lease_expires_at < now())
      )
    )
  order by job.created_at
  for update skip locked
  limit 1;

  if v_job.id is null then
    return null;
  end if;

  update public.analysis_job
  set status = 'FINALIZING',
      finalizer_worker_id = p_worker_id,
      finalize_lease_expires_at = now() + make_interval(secs => p_lease_seconds)
  where id = v_job.id
  returning * into v_job;

  return jsonb_build_object(
    'job', jsonb_build_object(
      'id', v_job.id,
      'batch_id', v_job.batch_id,
      'model_config_id', v_job.model_config_id,
      'requested_branch', v_job.requested_branch,
      'total_stories', v_job.total_stories,
      'execution_engine', v_job.execution_engine
    ),
    'model', v_job.model_snapshot,
    'snapshots', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'repository_name', s.repository_name,
        'requested_branch', s.requested_branch,
        'commit_sha', s.commit_sha,
        'commit_subject', s.commit_subject
      ) order by s.repository_name), '[]'::jsonb)
      from public.analysis_repository_snapshot s
      where s.job_id = v_job.id
    )
  );
end;
$$;

create or replace function public.list_analysis_story_tasks_for_worker(p_job_id uuid)
returns jsonb
language sql
security definer
set search_path = public
stable
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', t.id,
    'job_id', t.job_id,
    'story_id', t.story_id,
    'story_code', s.story_code,
    'story_name', s.story_name,
    'retrieval_status', t.retrieval_status,
    'analysis_status', t.analysis_status,
    'analysis_output', t.analysis_output
  ) order by s.story_code), '[]'::jsonb)
  from public.analysis_story_task t
  join public.review_story s on s.id = t.story_id
  join public.analysis_job j on j.id = t.job_id
  where t.job_id = p_job_id
    and j.execution_engine = 'legacy-openai';
$$;

-- complete_analysis_job / fail_claimed_analysis_job：加引擎围栏后委派给 v2
create or replace function public.complete_analysis_job(
  p_job_id uuid,
  p_worker_id text,
  p_results jsonb,
  p_evidence jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.analysis_job
    where id = p_job_id and execution_engine = 'legacy-openai'
  ) then
    raise exception 'ENGINE_NOT_SUPPORTED';
  end if;

  return public.complete_analysis_job_v2(p_job_id, p_worker_id, p_results, p_evidence);
end;
$$;

create or replace function public.fail_claimed_analysis_job(
  p_job_id uuid,
  p_worker_id text,
  p_error_code text,
  p_error_message text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.analysis_job
    where id = p_job_id and execution_engine = 'legacy-openai'
  ) then
    raise exception 'ENGINE_NOT_SUPPORTED';
  end if;

  perform public.fail_claimed_analysis_job_v2(p_job_id, p_worker_id, p_error_code, p_error_message);
end;
$$;

------------------------------------------------------------------------------
-- 10. v2 Worker RPC：按 Worker 能力领取，两种引擎共用
------------------------------------------------------------------------------

-- 10.1 Worker 注册/心跳：能力必须落库，v2 领取会与之交叉校验
create or replace function public.heartbeat_analysis_worker_v2(
  p_worker_id text,
  p_slots integer,
  p_current integer,
  p_supported_engines text[],
  p_protocol_version integer,
  p_capabilities jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_engines text[];
begin
  if p_worker_id is null or btrim(p_worker_id) = '' then
    raise exception 'worker_id is required';
  end if;
  if p_protocol_version is null or p_protocol_version < 1 then
    raise exception 'protocol_version must be at least 1';
  end if;

  -- 未知引擎一律拒绝注册，避免拼写错误变成"支持一切"。
  select coalesce(array_agg(distinct engine), array[]::text[]) into v_engines
  from unnest(coalesce(p_supported_engines, array[]::text[])) as engine
  where engine in ('legacy-openai', 'deepseek-harness-acp');

  if array_length(v_engines, 1) is null then
    raise exception 'at least one supported execution engine is required';
  end if;

  insert into public.analysis_worker_heartbeat (
    worker_id, slots, current_tasks, last_seen_at,
    supported_engines, protocol_version, capabilities
  ) values (
    p_worker_id,
    greatest(coalesce(p_slots, 0), 0),
    greatest(coalesce(p_current, 0), 0),
    now(),
    v_engines,
    p_protocol_version,
    coalesce(p_capabilities, '{}'::jsonb)
  )
  on conflict (worker_id) do update
  set slots = greatest(coalesce(excluded.slots, 0), 0),
      current_tasks = greatest(coalesce(excluded.current_tasks, 0), 0),
      last_seen_at = now(),
      supported_engines = excluded.supported_engines,
      protocol_version = excluded.protocol_version,
      capabilities = excluded.capabilities;
end;
$$;

-- 10.2 准备阶段领取（引擎感知）
create or replace function public.claim_job_for_preparation_v2(
  p_worker_id text,
  p_supported_engines text[],
  p_protocol_version integer,
  p_lease_seconds integer default 900
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.analysis_job;
  v_engines text[];
begin
  v_engines := public.worker_effective_engines(p_worker_id, p_supported_engines, p_protocol_version);
  if array_length(v_engines, 1) is null then
    return null;
  end if;
  if p_lease_seconds is null or p_lease_seconds < 30 then
    p_lease_seconds := 900;
  end if;

  select * into v_job
  from public.analysis_job
  where execution_engine = any(v_engines)
    and (
      status = 'QUEUED'
      or (
        status = 'PREPARING_CODE'
        and (locked_at is null or locked_at + make_interval(secs => p_lease_seconds) < now())
      )
    )
  order by created_at
  for update skip locked
  limit 1;

  if v_job.id is null then
    return null;
  end if;

  update public.analysis_job
  set status = 'PREPARING_CODE',
      worker_id = p_worker_id,
      attempt = attempt + 1,
      locked_at = now(),
      started_at = coalesce(started_at, now())
  where id = v_job.id
  returning * into v_job;

  return jsonb_build_object(
    'job', jsonb_build_object(
      'id', v_job.id,
      'batch_id', v_job.batch_id,
      'model_config_id', v_job.model_config_id,
      'requested_branch', v_job.requested_branch,
      'total_stories', v_job.total_stories,
      'execution_engine', v_job.execution_engine
    ),
    'model', v_job.model_snapshot
  );
end;
$$;

-- 10.3 快照保存（引擎无关；v1 是它的 legacy 围栏包装）
create or replace function public.save_repository_snapshots_v2(
  p_job_id uuid,
  p_worker_id text,
  p_snapshots jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_branch text;
  v_worker text;
  v_snap jsonb;
begin
  select status, requested_branch, worker_id into v_status, v_branch, v_worker
  from public.analysis_job where id = p_job_id for update;

  if v_status is null then
    raise exception 'job not found';
  end if;
  if v_status <> 'PREPARING_CODE' then
    raise exception 'job is not in PREPARING_CODE state';
  end if;
  if v_worker is distinct from p_worker_id then
    raise exception 'JOB_LEASE_LOST';
  end if;
  if jsonb_typeof(p_snapshots) <> 'array' then
    raise exception 'snapshots must be an array';
  end if;

  delete from public.analysis_repository_snapshot where job_id = p_job_id;

  for v_snap in select * from jsonb_array_elements(p_snapshots)
  loop
    insert into public.analysis_repository_snapshot (
      job_id, repository_name, requested_branch, commit_sha, commit_subject
    ) values (
      p_job_id,
      v_snap->>'repository_name',
      coalesce(v_snap->>'requested_branch', v_branch),
      v_snap->>'commit_sha',
      nullif(v_snap->>'commit_subject', '')
    );
  end loop;

  if (select count(*) from public.analysis_repository_snapshot where job_id = p_job_id) <> 4 then
    raise exception 'exactly 4 repository snapshots are required';
  end if;

  update public.analysis_job set status = 'PROCESSING' where id = p_job_id;
end;
$$;

-- 10.4 任务领取（引擎感知）。ACP 任务同时铸造一次性 claim token：
--      明文只返回给领取方，数据库仅保存摘要。
create or replace function public.claim_next_story_task_v2(
  p_worker_id text,
  p_supported_engines text[],
  p_protocol_version integer,
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
  v_engines text[];
  v_lock_key bigint;
  v_active integer;
  v_story public.review_story;
  v_token uuid;
begin
  v_engines := public.worker_effective_engines(p_worker_id, p_supported_engines, p_protocol_version);
  if array_length(v_engines, 1) is null then
    return null;
  end if;
  if p_lease_seconds is null or p_lease_seconds < 30 then
    p_lease_seconds := 900;
  end if;

  perform pg_advisory_xact_lock(hashtext('claim_next_story_task'));

  select task.* into v_task
  from public.analysis_story_task task
  join public.analysis_job job on job.id = task.job_id
  where job.status = 'PROCESSING'
    and job.execution_engine = any(v_engines)
    and (task.lease_expires_at is null or task.lease_expires_at < now())
    and (
      (
        job.execution_engine = 'legacy-openai'
        and task.retrieval_status <> 'FAILED'
        and task.analysis_status <> 'FAILED'
        and not (task.retrieval_status = 'SUCCEEDED' and task.analysis_status = 'SUCCEEDED')
      )
      or (
        job.execution_engine = 'deepseek-harness-acp'
        and task.agent_status not in ('SUCCEEDED', 'FAILED')
      )
    )
  order by job.created_at, task.created_at
  for update of task skip locked
  limit 1;

  if v_task.id is null then
    return null;
  end if;

  select job.* into v_job from public.analysis_job job where job.id = v_task.job_id;
  select cfg.* into v_cfg from public.ai_model_config cfg where cfg.id = v_job.model_config_id;

  -- 模型级严格并发：与 v1 共用同一把 advisory lock 和同一份在途统计,
  -- 两种引擎的在途任务合并计入同一个 max_parallel_tasks 上限。
  v_lock_key := ('x' || substr(md5(v_job.model_config_id::text), 1, 16))::bit(64)::bigint;
  perform pg_advisory_xact_lock(v_lock_key);

  select count(*) into v_active
  from public.analysis_story_task t
  join public.analysis_job j on j.id = t.job_id
  where j.model_config_id = v_job.model_config_id
    and t.lease_expires_at is not null
    and t.lease_expires_at >= now();

  if v_active >= coalesce(v_cfg.max_parallel_tasks, 4) then
    return null;
  end if;

  if v_job.execution_engine = 'deepseek-harness-acp' then
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

    insert into public.analysis_agent_run (
      task_id, job_id, agent_attempt, worker_id, execution_engine, status
    ) values (
      v_task.id, v_job.id, v_task.agent_attempt, p_worker_id, v_job.execution_engine, 'RUNNING'
    )
    on conflict (task_id, agent_attempt) do update
    set worker_id = excluded.worker_id,
        status = 'RUNNING',
        started_at = now(),
        error_code = null,
        error_message = null;
  else
    update public.analysis_story_task
    set worker_id = p_worker_id,
        lease_expires_at = now() + make_interval(secs => p_lease_seconds),
        heartbeat_at = now(),
        retrieval_status = case
          when retrieval_status = 'SUCCEEDED' then retrieval_status else 'RUNNING' end,
        retrieval_attempt = case
          when retrieval_status = 'SUCCEEDED' then retrieval_attempt else retrieval_attempt + 1 end,
        analysis_status = case
          when retrieval_status = 'SUCCEEDED' and analysis_status <> 'SUCCEEDED'
            then 'RUNNING' else analysis_status end,
        analysis_attempt = case
          when retrieval_status = 'SUCCEEDED' and analysis_status <> 'SUCCEEDED'
            then analysis_attempt + 1 else analysis_attempt end,
        started_at = coalesce(started_at, now())
    where id = v_task.id
    returning * into v_task;
  end if;

  select * into v_story from public.review_story where id = v_task.story_id;

  return (to_jsonb(v_task) - 'claim_token_digest')
    || jsonb_build_object(
      'execution_engine', v_job.execution_engine,
      -- 明文 token 只在这一次响应里出现；数据库只留摘要。
      'claim_token', v_token,
      'job', jsonb_build_object(
        'id', v_job.id,
        'batch_id', v_job.batch_id,
        'model_config_id', v_job.model_config_id,
        'requested_branch', v_job.requested_branch,
        'total_stories', v_job.total_stories,
        'execution_engine', v_job.execution_engine
      ),
      'model', v_job.model_snapshot || jsonb_build_object(
        'execution_engine', v_cfg.execution_engine,
        'context_window', v_cfg.context_window,
        'max_output_tokens', v_cfg.max_output_tokens,
        'request_timeout_ms', v_cfg.request_timeout_ms,
        'agent_max_model_requests', v_cfg.agent_max_model_requests,
        'agent_max_retry_requests', v_cfg.agent_max_retry_requests,
        'agent_max_compaction_requests', v_cfg.agent_max_compaction_requests
      ),
      'snapshots', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'repository_name', s.repository_name,
          'requested_branch', s.requested_branch,
          'commit_sha', s.commit_sha,
          'commit_subject', s.commit_subject
        ) order by s.repository_name), '[]'::jsonb)
        from public.analysis_repository_snapshot s
        where s.job_id = v_job.id
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

-- 10.5 心跳（引擎无关）。ACP 任务必须出示 claim token，
--      同一 Worker 的新 claim 会使旧 token 失效（覆盖 ABA）。
create or replace function public.heartbeat_story_task_v2(
  p_task_id uuid,
  p_worker_id text,
  p_claim_token uuid default null,
  p_lease_seconds integer default 900
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ok boolean;
begin
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
    and (
      task.claim_token_digest is null
      or task.claim_token_digest = public.agent_claim_token_digest(p_claim_token)
    )
  returning true into v_ok;

  return coalesce(v_ok, false);
end;
$$;

-- 10.6 按 Task 读取模型密钥（引擎无关，要求租约 + claim token）
create or replace function public.get_model_secret_for_story_task_v2(
  p_task_id uuid,
  p_worker_id text,
  p_claim_token uuid default null
)
returns text
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_secret_id uuid;
  v_secret text;
  v_ok boolean;
begin
  if p_worker_id is null or btrim(p_worker_id) = '' then
    raise exception 'worker_id is required';
  end if;

  select cfg.api_key_secret_id,
         (
           job.status = 'PROCESSING'
           and task.worker_id = p_worker_id
           and task.lease_expires_at is not null
           and task.lease_expires_at >= now()
           and (
             task.claim_token_digest is null
             or task.claim_token_digest = public.agent_claim_token_digest(p_claim_token)
           )
         )
    into v_secret_id, v_ok
  from public.analysis_story_task task
  join public.analysis_job job on job.id = task.job_id
  join public.ai_model_config cfg on cfg.id = job.model_config_id
  where task.id = p_task_id;

  if v_secret_id is null and v_ok is null then
    raise exception 'task not found';
  end if;
  if not coalesce(v_ok, false) then
    raise exception 'TASK_LEASE_LOST';
  end if;
  if not public.model_config_has_api_key(v_secret_id) then
    raise exception 'MODEL_SECRET_MISSING';
  end if;

  select decrypted_secret into v_secret
  from vault.decrypted_secrets
  where id = v_secret_id;

  if v_secret is null then
    raise exception 'MODEL_SECRET_MISSING';
  end if;

  return v_secret;
end;
$$;

-- 10.7 Agent 结果的单事务原子提交
--      结果、运行记录、证据台账与 task 状态要么全成、要么全不成。
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
  v_run_id uuid;
  v_evidence jsonb;
  v_committed_at timestamptz;
begin
  select * into v_task from public.analysis_story_task where id = p_task_id for update;
  if v_task.id is null then
    raise exception 'task not found';
  end if;

  select * into v_job from public.analysis_job where id = v_task.job_id for update;
  if v_job.execution_engine <> 'deepseek-harness-acp' then
    raise exception 'ENGINE_NOT_SUPPORTED';
  end if;
  if v_job.status <> 'PROCESSING' then
    raise exception 'job is not processing';
  end if;

  -- 租约 + claim token + attempt 三者齐备才允许提交；迟到的 attempt 被拒绝。
  if v_task.worker_id is distinct from p_worker_id
     or v_task.lease_expires_at is null
     or v_task.lease_expires_at < now() then
    raise exception 'TASK_LEASE_LOST';
  end if;
  if v_task.claim_token_digest is distinct from public.agent_claim_token_digest(p_claim_token) then
    raise exception 'AGENT_CLAIM_INVALID';
  end if;
  if p_agent_attempt is distinct from v_task.agent_attempt then
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

  v_committed_at := now();

  insert into public.analysis_agent_run (
    task_id, job_id, agent_attempt, worker_id, execution_engine, status,
    profile_config_hash, prompt_version, model_label,
    tool_calls, evidence_shown, searches_run, retry_requests, compaction_requests,
    committed_at, finished_at
  ) values (
    p_task_id, v_task.job_id, p_agent_attempt, p_worker_id, v_job.execution_engine, 'COMMITTED',
    p_config_hash, p_prompt_version, p_model_label,
    greatest(coalesce((p_usage->>'tool_calls')::integer, 0), 0),
    greatest(coalesce((p_usage->>'evidence_shown')::integer, 0), 0),
    greatest(coalesce((p_usage->>'searches_run')::integer, 0), 0),
    greatest(coalesce((p_usage->>'retry_requests')::integer, 0), 0),
    greatest(coalesce((p_usage->>'compaction_requests')::integer, 0), 0),
    v_committed_at, v_committed_at
  )
  on conflict (task_id, agent_attempt) do update
  set status = 'COMMITTED',
      worker_id = excluded.worker_id,
      profile_config_hash = excluded.profile_config_hash,
      prompt_version = excluded.prompt_version,
      model_label = excluded.model_label,
      tool_calls = excluded.tool_calls,
      evidence_shown = excluded.evidence_shown,
      searches_run = excluded.searches_run,
      retry_requests = excluded.retry_requests,
      compaction_requests = excluded.compaction_requests,
      committed_at = excluded.committed_at,
      finished_at = excluded.finished_at,
      error_code = null,
      error_message = null
  returning id into v_run_id;

  -- 证据台账：每条都必须携带 Worker 已按精确 Commit 重读校验过的事实。
  delete from public.analysis_agent_evidence where agent_run_id = v_run_id;

  if jsonb_typeof(p_evidence) = 'array' then
    for v_evidence in select * from jsonb_array_elements(p_evidence)
    loop
      -- 证据仓库必须属于本 Job 的快照，且 commit 必须与快照一致。
      if not exists (
        select 1 from public.analysis_repository_snapshot s
        where s.job_id = v_task.job_id
          and s.repository_name = v_evidence->>'repository_name'
          and lower(s.commit_sha) = lower(v_evidence->>'commit_sha')
      ) then
        raise exception 'EVIDENCE_PATH_INVALID';
      end if;

      insert into public.analysis_agent_evidence (
        agent_run_id, evidence_id, repository_name, commit_sha, file_path, blob_sha,
        start_line, end_line, content_hash, evidence_type, description
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
        v_evidence->>'description'
      );
    end loop;
  end if;

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

  -- ACP Job 用 analyzed_stories 表示"已产出结果的需求数"；
  -- retrieved_stories 属于旧两阶段语义，这里不写，避免制造假阶段。
  update public.analysis_job
  set analyzed_stories = (
    select count(*) from public.analysis_story_task
    where job_id = v_task.job_id and agent_status = 'SUCCEEDED'
  )
  where id = v_task.job_id;

  return jsonb_build_object('run_id', v_run_id, 'committed_at', v_committed_at);
end;
$$;

-- 10.8 Agent 失败：与 0016 同样撤销同 Job 全部在途租约
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
begin
  select task.job_id, job.execution_engine into v_job_id, v_engine
  from public.analysis_story_task task
  join public.analysis_job job on job.id = task.job_id
  where task.id = p_task_id;

  if v_job_id is null then
    raise exception 'task not found';
  end if;
  if v_engine <> 'deepseek-harness-acp' then
    raise exception 'ENGINE_NOT_SUPPORTED';
  end if;

  perform pg_advisory_xact_lock(public.analysis_job_lock_key(v_job_id));

  select task.agent_attempt,
         (
           task.worker_id = p_worker_id
           and task.lease_expires_at is not null
           and task.lease_expires_at >= now()
           and task.claim_token_digest = public.agent_claim_token_digest(p_claim_token)
         )
    into v_attempt, v_ok
  from public.analysis_story_task task
  where task.id = p_task_id
  for update;

  if not found then
    raise exception 'task not found';
  end if;
  if not coalesce(v_ok, false) then
    raise exception 'TASK_LEASE_LOST';
  end if;

  update public.analysis_agent_run
  set status = 'FAILED',
      error_code = p_error_code,
      error_message = p_error_message,
      finished_at = now()
  where task_id = p_task_id
    and agent_attempt = v_attempt
    and status <> 'COMMITTED';

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

-- 10.9 汇总领取（引擎感知：ACP 判定 agent_status，legacy 判定两阶段）
create or replace function public.claim_job_for_finalization_v2(
  p_worker_id text,
  p_supported_engines text[],
  p_protocol_version integer,
  p_lease_seconds integer default 900
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.analysis_job;
  v_engines text[];
begin
  v_engines := public.worker_effective_engines(p_worker_id, p_supported_engines, p_protocol_version);
  if array_length(v_engines, 1) is null then
    return null;
  end if;
  if p_lease_seconds is null or p_lease_seconds < 30 then
    p_lease_seconds := 900;
  end if;

  select job.* into v_job
  from public.analysis_job job
  where job.execution_engine = any(v_engines)
    and (
      (
        job.status = 'PROCESSING'
        and job.execution_engine = 'legacy-openai'
        and not exists (
          select 1 from public.analysis_story_task t
          where t.job_id = job.id
            and not (t.retrieval_status = 'SUCCEEDED' and t.analysis_status = 'SUCCEEDED')
        )
      )
      or (
        job.status = 'PROCESSING'
        and job.execution_engine = 'deepseek-harness-acp'
        and not exists (
          select 1 from public.analysis_story_task t
          where t.job_id = job.id and t.agent_status <> 'SUCCEEDED'
        )
      )
      or (
        job.status = 'FINALIZING'
        and (job.finalize_lease_expires_at is null or job.finalize_lease_expires_at < now())
      )
    )
  order by job.created_at
  for update skip locked
  limit 1;

  if v_job.id is null then
    return null;
  end if;

  update public.analysis_job
  set status = 'FINALIZING',
      finalizer_worker_id = p_worker_id,
      finalize_lease_expires_at = now() + make_interval(secs => p_lease_seconds)
  where id = v_job.id
  returning * into v_job;

  return jsonb_build_object(
    'job', jsonb_build_object(
      'id', v_job.id,
      'batch_id', v_job.batch_id,
      'model_config_id', v_job.model_config_id,
      'requested_branch', v_job.requested_branch,
      'total_stories', v_job.total_stories,
      'execution_engine', v_job.execution_engine
    ),
    'model', v_job.model_snapshot,
    'snapshots', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'repository_name', s.repository_name,
        'requested_branch', s.requested_branch,
        'commit_sha', s.commit_sha,
        'commit_subject', s.commit_subject
      ) order by s.repository_name), '[]'::jsonb)
      from public.analysis_repository_snapshot s
      where s.job_id = v_job.id
    )
  );
end;
$$;

-- 10.10 汇总输入（引擎感知）。ACP 的证据来自平台校验过的台账，
--       不再二次相信模型自报的证据。
create or replace function public.list_completed_story_tasks_v2(p_job_id uuid)
returns jsonb
language sql
security definer
set search_path = public
stable
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', t.id,
    'job_id', t.job_id,
    'story_id', t.story_id,
    'story_code', s.story_code,
    'story_name', s.story_name,
    'execution_engine', j.execution_engine,
    'retrieval_status', t.retrieval_status,
    'analysis_status', t.analysis_status,
    'agent_status', t.agent_status,
    'output', case
      when j.execution_engine = 'deepseek-harness-acp' then t.agent_output
      else t.analysis_output
    end,
    'verified_evidence', case
      when j.execution_engine = 'deepseek-harness-acp' then (
        select coalesce(jsonb_agg(jsonb_build_object(
          'evidence_id', e.evidence_id,
          'repository_name', e.repository_name,
          'commit_sha', e.commit_sha,
          'file_path', e.file_path,
          'start_line', e.start_line,
          'end_line', e.end_line,
          'evidence_type', e.evidence_type,
          'description', e.description
        ) order by e.file_path, e.start_line), '[]'::jsonb)
        from public.analysis_agent_run run
        join public.analysis_agent_evidence e on e.agent_run_id = run.id
        where run.task_id = t.id and run.status = 'COMMITTED'
      )
      else '[]'::jsonb
    end
  ) order by s.story_code), '[]'::jsonb)
  from public.analysis_story_task t
  join public.review_story s on s.id = t.story_id
  join public.analysis_job j on j.id = t.job_id
  where t.job_id = p_job_id;
$$;

-- 10.11 完成任务（引擎无关；v1 是它的 legacy 围栏包装）
create or replace function public.complete_analysis_job_v2(
  p_job_id uuid,
  p_worker_id text,
  p_results jsonb,
  p_evidence jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.analysis_job;
  v_batch public.review_batch;
  v_import_id uuid;
  v_version integer;
  v_result jsonb;
  v_evidence jsonb;
  v_story_id uuid;
  v_result_id uuid;
  v_pending integer;
  v_snapshot_count integer;
  v_model_label text;
  v_required integer;
  v_provided integer;
  v_distinct integer;
  v_repo text;
  v_snap_sha text;
  v_start integer;
  v_end integer;
begin
  select * into v_job from public.analysis_job where id = p_job_id for update;
  if v_job.id is null then
    raise exception 'job not found';
  end if;

  if v_job.status <> 'FINALIZING' then
    raise exception 'job is not in FINALIZING state (status=%)', v_job.status;
  end if;
  if v_job.finalizer_worker_id is distinct from p_worker_id then
    raise exception 'JOB_LEASE_LOST';
  end if;
  if v_job.finalize_lease_expires_at is null or v_job.finalize_lease_expires_at < now() then
    raise exception 'JOB_LEASE_LOST';
  end if;

  -- 完成条件按引擎判定。
  if v_job.execution_engine = 'deepseek-harness-acp' then
    select count(*) into v_pending
    from public.analysis_story_task
    where job_id = p_job_id and agent_status <> 'SUCCEEDED';
  else
    select count(*) into v_pending
    from public.analysis_story_task
    where job_id = p_job_id
      and not (retrieval_status = 'SUCCEEDED' and analysis_status = 'SUCCEEDED');
  end if;
  if v_pending > 0 then
    raise exception 'still % story task(s) not fully succeeded', v_pending;
  end if;

  select * into v_batch from public.review_batch where id = v_job.batch_id for update;
  if v_batch.status = 'COMPLETED' then
    raise exception 'batch is completed and read-only';
  end if;
  if exists (select 1 from public.ai_import_record where batch_id = v_job.batch_id) then
    raise exception 'RESULT_ALREADY_EXISTS';
  end if;

  if v_job.requested_branch is distinct from v_batch.default_branch then
    raise exception 'BATCH_BRANCH_CHANGED';
  end if;

  select count(*) into v_snapshot_count
  from public.analysis_repository_snapshot where job_id = p_job_id;
  if v_snapshot_count <> 4 then
    raise exception 'repository snapshots incomplete (found %)', v_snapshot_count;
  end if;

  if jsonb_typeof(p_results) <> 'array' then
    raise exception 'results must be an array';
  end if;

  select count(*) into v_required from public.review_story where batch_id = v_job.batch_id;
  v_provided := jsonb_array_length(p_results);
  if v_provided <> v_required then
    raise exception 'results count % does not match required stories %', v_provided, v_required;
  end if;

  select count(distinct value->>'story_code') into v_distinct
  from jsonb_array_elements(p_results) as value;
  if v_distinct <> v_required then
    raise exception 'results must cover each story exactly once (distinct=%, required=%)', v_distinct, v_required;
  end if;

  if exists (
    select 1 from jsonb_array_elements(p_results) as value
    where not exists (
      select 1 from public.review_story s
      where s.batch_id = v_job.batch_id and s.story_code = value->>'story_code'
    )
  ) then
    raise exception 'results reference unknown story code';
  end if;

  -- 模型标签额外带上引擎，便于审计一条结果来自哪套执行链路。
  v_model_label := coalesce(
    (v_job.model_snapshot->>'display_name') || ' / ' ||
    (v_job.model_snapshot->>'provider') || ' / ' ||
    (v_job.model_snapshot->>'model_name') || ' / ' || v_job.execution_engine,
    'ai-automation / ' || v_job.execution_engine
  );

  select coalesce(max(version), 0) + 1 into v_version
  from public.ai_import_record where batch_id = v_job.batch_id;

  update public.ai_import_record set is_active = false where batch_id = v_job.batch_id;

  insert into public.ai_import_record (
    batch_id, import_file_id, version, baseline_branch, baseline_commit,
    ai_model, analyzed_at, imported_by, is_active
  ) values (
    v_job.batch_id,
    null,
    v_version,
    v_batch.default_branch,
    (
      jsonb_build_object(
        'actual_branch', v_batch.default_branch,
        'execution_engine', v_job.execution_engine,
        'commits', (
          select coalesce(jsonb_agg(jsonb_build_object(
            'repository', repository_name,
            'sha', commit_sha,
            'subject', commit_subject
          ) order by repository_name), '[]'::jsonb)
          from public.analysis_repository_snapshot where job_id = p_job_id
        )
      )
    )::text,
    v_model_label,
    now(),
    v_job.requested_by,
    true
  ) returning id into v_import_id;

  for v_result in select * from jsonb_array_elements(p_results)
  loop
    select id into v_story_id from public.review_story
    where batch_id = v_job.batch_id and story_code = v_result->>'story_code';
    if v_story_id is null then
      raise exception 'unknown story code: %', v_result->>'story_code';
    end if;

    insert into public.ai_review_result (
      story_id, ai_import_record_id, verdict, confidence, summary,
      implemented_content, missing_content, risks, test_points, ai_remark
    ) values (
      v_story_id, v_import_id,
      nullif(v_result->>'verdict', ''),
      nullif(v_result->>'confidence', '')::integer,
      nullif(v_result->>'summary', ''),
      nullif(v_result->>'implemented_content', ''),
      nullif(v_result->>'missing_content', ''),
      nullif(v_result->>'risks', ''),
      nullif(v_result->>'test_points', ''),
      nullif(v_result->>'ai_remark', '')
    );
  end loop;

  if jsonb_typeof(p_evidence) = 'array' then
    for v_evidence in select * from jsonb_array_elements(p_evidence)
    loop
      v_repo := v_evidence->>'repository_name';

      select commit_sha into v_snap_sha
      from public.analysis_repository_snapshot
      where job_id = p_job_id and repository_name = v_repo;
      if v_snap_sha is null then
        raise exception 'EVIDENCE_PATH_INVALID';
      end if;

      if coalesce(nullif(v_evidence->>'file_path', ''), '') = '' then
        raise exception 'EVIDENCE_PATH_INVALID';
      end if;
      if (v_evidence->>'file_path') like '/%'
         or (v_evidence->>'file_path') like '%..%' then
        raise exception 'EVIDENCE_PATH_INVALID';
      end if;

      v_start := nullif(v_evidence->>'start_line', '')::integer;
      v_end := nullif(v_evidence->>'end_line', '')::integer;
      if v_start is not null and v_start < 1 then
        raise exception 'EVIDENCE_LINE_INVALID';
      end if;
      if v_end is not null and v_end < 1 then
        raise exception 'EVIDENCE_LINE_INVALID';
      end if;
      if v_start is not null and v_end is not null and v_start > v_end then
        raise exception 'EVIDENCE_LINE_INVALID';
      end if;

      select result.id into v_result_id
      from public.ai_review_result result
      join public.review_story story on story.id = result.story_id
      where result.ai_import_record_id = v_import_id
        and story.story_code = v_evidence->>'story_code';

      if v_result_id is null then
        raise exception 'evidence references story without result: %', v_evidence->>'story_code';
      end if;

      insert into public.ai_code_evidence (
        ai_review_result_id, repository_name, commit_sha, file_path,
        symbol_name, start_line, end_line, evidence_type, description
      ) values (
        v_result_id,
        v_repo,
        v_snap_sha,
        v_evidence->>'file_path',
        nullif(v_evidence->>'symbol_name', ''),
        v_start,
        v_end,
        v_evidence->>'evidence_type',
        v_evidence->>'description'
      );
    end loop;
  end if;

  update public.review_batch set status = 'REVIEWING'
  where id = v_job.batch_id and status <> 'COMPLETED';

  update public.analysis_job
  set status = 'SUCCEEDED', finished_at = now()
  where id = p_job_id;

  return v_import_id;
end;
$$;

-- 10.12 已领取 Job 的失败（引擎无关）
create or replace function public.fail_claimed_analysis_job_v2(
  p_job_id uuid,
  p_worker_id text,
  p_error_code text,
  p_error_message text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.analysis_job;
begin
  if p_worker_id is null or btrim(p_worker_id) = '' then
    raise exception 'worker_id is required';
  end if;

  select * into v_job from public.analysis_job where id = p_job_id for update;
  if v_job.id is null then
    raise exception 'job not found';
  end if;
  if v_job.status in ('SUCCEEDED', 'FAILED') then
    return;
  end if;

  if v_job.status = 'PREPARING_CODE' then
    if v_job.worker_id is distinct from p_worker_id then
      raise exception 'JOB_LEASE_LOST';
    end if;
  elsif v_job.status = 'FINALIZING' then
    if v_job.finalizer_worker_id is distinct from p_worker_id
       or v_job.finalize_lease_expires_at is null
       or v_job.finalize_lease_expires_at < now() then
      raise exception 'JOB_LEASE_LOST';
    end if;
  else
    raise exception 'job is not in a worker-claimed state (status=%)', v_job.status;
  end if;

  update public.analysis_job
  set status = 'FAILED',
      error_code = p_error_code,
      error_message = p_error_message,
      finished_at = now()
  where id = p_job_id;
end;
$$;

------------------------------------------------------------------------------
-- 11. Job 创建时冻结引擎（默认仍是 legacy，管理员显式开启才会变）
------------------------------------------------------------------------------

-- 与 0010 的版本保持逐字一致的校验顺序与错误文案，唯一变化是把模型配置的
-- execution_engine 冻结进新建的 Job。
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
  v_engine text;
  v_snapshot jsonb;
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

  select enabled, api_key_secret_id, execution_engine
    into v_enabled, v_secret, v_engine
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

  update public.review_batch
  set ai_model_snapshot = v_snapshot
  where id = p_batch_id;

  -- 引擎在这里冻结，之后对该 Job 永久不可变。
  insert into public.analysis_job (
    batch_id, model_config_id, model_snapshot, requested_branch,
    status, requested_by, total_stories, execution_engine
  ) values (
    p_batch_id, v_batch.ai_model_config_id, v_snapshot, v_batch.default_branch,
    'QUEUED', (select auth.uid()), v_story_count, v_engine
  ) returning id into v_job_id;

  insert into public.analysis_story_task (job_id, story_id)
  select v_job_id, story.id
  from public.review_story story
  where story.batch_id = p_batch_id;

  return v_job_id;
end;
$$;

------------------------------------------------------------------------------
-- 12. 管理端：读取与设置引擎（不改动既有 create/update 签名）
------------------------------------------------------------------------------

drop function if exists public.list_enabled_model_configs();
create or replace function public.list_enabled_model_configs()
returns table (
  id uuid,
  display_name text,
  provider text,
  base_url text,
  model_name text,
  enabled boolean,
  has_api_key boolean,
  max_parallel_tasks integer,
  request_timeout_ms integer,
  execution_engine text,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = public
stable
as $$
begin
  if not public.can_create_review_batch() then
    raise exception 'batch creation permission required';
  end if;

  return query
  select
    cfg.id,
    cfg.display_name,
    cfg.provider,
    cfg.base_url,
    cfg.model_name,
    cfg.enabled,
    public.model_config_has_api_key(cfg.api_key_secret_id) as has_api_key,
    cfg.max_parallel_tasks,
    cfg.request_timeout_ms,
    cfg.execution_engine,
    cfg.created_at,
    cfg.updated_at
  from public.ai_model_config cfg
  where cfg.enabled = true
    and public.model_config_has_api_key(cfg.api_key_secret_id)
  order by cfg.display_name;
end;
$$;

drop function if exists public.admin_list_model_configs();
create or replace function public.admin_list_model_configs()
returns table (
  id uuid,
  display_name text,
  provider text,
  base_url text,
  model_name text,
  enabled boolean,
  has_api_key boolean,
  max_parallel_tasks integer,
  request_timeout_ms integer,
  retrieval_prompt_version text,
  analysis_prompt_version text,
  execution_engine text,
  context_window integer,
  max_output_tokens integer,
  agent_max_model_requests integer,
  agent_max_retry_requests integer,
  agent_max_compaction_requests integer,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = public
stable
as $$
begin
  perform public.ensure_admin();

  return query
  select
    cfg.id,
    cfg.display_name,
    cfg.provider,
    cfg.base_url,
    cfg.model_name,
    cfg.enabled,
    public.model_config_has_api_key(cfg.api_key_secret_id) as has_api_key,
    cfg.max_parallel_tasks,
    cfg.request_timeout_ms,
    cfg.retrieval_prompt_version,
    cfg.analysis_prompt_version,
    cfg.execution_engine,
    cfg.context_window,
    cfg.max_output_tokens,
    cfg.agent_max_model_requests,
    cfg.agent_max_retry_requests,
    cfg.agent_max_compaction_requests,
    cfg.created_at,
    cfg.updated_at
  from public.ai_model_config cfg
  order by cfg.display_name;
end;
$$;

-- 单独的引擎设置入口：只影响之后新建的 Job，运行中的 Job 不受影响。
create or replace function public.admin_set_model_execution_engine(
  p_id uuid,
  p_execution_engine text,
  p_context_window integer default null,
  p_max_output_tokens integer default null,
  p_agent_max_model_requests integer default null,
  p_agent_max_retry_requests integer default null,
  p_agent_max_compaction_requests integer default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.ensure_admin();

  if p_execution_engine not in ('legacy-openai', 'deepseek-harness-acp') then
    raise exception 'unsupported execution engine: %', p_execution_engine;
  end if;

  update public.ai_model_config
  set execution_engine = p_execution_engine,
      context_window = coalesce(p_context_window, context_window),
      max_output_tokens = coalesce(p_max_output_tokens, max_output_tokens),
      agent_max_model_requests = coalesce(p_agent_max_model_requests, agent_max_model_requests),
      agent_max_retry_requests = coalesce(p_agent_max_retry_requests, agent_max_retry_requests),
      agent_max_compaction_requests =
        coalesce(p_agent_max_compaction_requests, agent_max_compaction_requests)
  where id = p_id;

  if not found then
    raise exception 'model config not found';
  end if;
end;
$$;

------------------------------------------------------------------------------
-- 12b. 重试：ACP Job 必须同时重置 Agent 状态，否则 Task 会永久停在 FAILED
------------------------------------------------------------------------------

create or replace function public.retry_analysis_job(p_job_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.analysis_job;
  v_snapshot_count integer;
begin
  select * into v_job from public.analysis_job where id = p_job_id for update;
  if v_job.id is null then
    raise exception 'job not found';
  end if;

  perform public.ensure_manage_review_batch(v_job.batch_id);

  if v_job.status <> 'FAILED' then
    raise exception 'only FAILED jobs can be retried';
  end if;

  if exists (select 1 from public.ai_import_record where batch_id = v_job.batch_id) then
    raise exception 'RESULT_ALREADY_EXISTS';
  end if;

  select count(*) into v_snapshot_count
  from public.analysis_repository_snapshot where job_id = p_job_id;

  if v_job.execution_engine = 'deepseek-harness-acp' then
    -- 已提交的 Task 保留结果；其余回到 PENDING 并烧掉旧 claim token。
    -- agent_attempt 保持累加，这样一次 attempt 只对应一条 run 记录。
    update public.analysis_story_task
    set agent_status = 'PENDING',
        agent_output = null,
        worker_id = null,
        lease_expires_at = null,
        heartbeat_at = null,
        claim_token_digest = null,
        error_code = null,
        error_message = null,
        finished_at = null
    where job_id = p_job_id
      and agent_status <> 'SUCCEEDED';

    -- 未提交的运行记录标记为 FAILED，避免与新 attempt 混淆。
    update public.analysis_agent_run
    set status = 'FAILED',
        finished_at = coalesce(finished_at, now())
    where job_id = p_job_id
      and status = 'RUNNING';
  else
    update public.analysis_story_task
    set retrieval_status = case
          when retrieval_status = 'SUCCEEDED' then 'SUCCEEDED' else 'PENDING' end,
        analysis_status = case
          when retrieval_status = 'SUCCEEDED' and analysis_status = 'SUCCEEDED'
            then 'SUCCEEDED' else 'PENDING' end,
        retrieval_output = case
          when retrieval_status = 'SUCCEEDED' then retrieval_output else null end,
        analysis_output = case
          when retrieval_status = 'SUCCEEDED' and analysis_status = 'SUCCEEDED'
            then analysis_output else null end,
        worker_id = null,
        lease_expires_at = null,
        heartbeat_at = null,
        error_code = null,
        error_message = null,
        finished_at = case
          when retrieval_status = 'SUCCEEDED' and analysis_status = 'SUCCEEDED'
            then finished_at else null end
    where job_id = p_job_id
      and not (retrieval_status = 'SUCCEEDED' and analysis_status = 'SUCCEEDED');
  end if;

  update public.analysis_job
  set status = case when v_snapshot_count = 4 then 'PROCESSING' else 'QUEUED' end,
      worker_id = null,
      locked_at = null,
      finalizer_worker_id = null,
      finalize_lease_expires_at = null,
      error_code = null,
      error_message = null,
      finished_at = null
  where id = p_job_id
  returning * into v_job;

  return v_job.id;
end;
$$;

------------------------------------------------------------------------------
-- 12c. Worker 概览：引擎感知的阶段判定 + 上报已注册能力
--      旧版本从 retrieval/analysis 推导阶段，ACP Task 会一直显示为"AI 检索"。
------------------------------------------------------------------------------

create or replace function public.admin_list_analysis_workers()
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_result jsonb;
begin
  perform public.ensure_admin();

  with online_workers as (
    select
      heartbeat.worker_id,
      heartbeat.slots,
      heartbeat.current_tasks as reported_current_tasks,
      heartbeat.last_seen_at,
      heartbeat.supported_engines,
      heartbeat.protocol_version
    from public.analysis_worker_heartbeat heartbeat
    where heartbeat.last_seen_at >= now() - interval '20 seconds'
  ),
  raw_assignments as (
    select
      job.worker_id,
      'PREPARING'::text as phase,
      job.execution_engine,
      batch.id as batch_id,
      batch.name as batch_name,
      batch.week_code,
      batch.status as batch_status,
      job.id as job_id,
      job.status as job_status,
      job.requested_branch,
      job.started_at as job_started_at,
      null::uuid as task_id,
      null::uuid as story_id,
      null::text as story_code,
      null::text as story_name,
      worker.last_seen_at as heartbeat_at,
      null::timestamptz as lease_expires_at
    from public.analysis_job job
    join online_workers worker on worker.worker_id = job.worker_id
    join public.review_batch batch on batch.id = job.batch_id
    where job.status = 'PREPARING_CODE'

    union all

    select
      task.worker_id,
      case
        when job.execution_engine = 'deepseek-harness-acp' then 'AGENT'::text
        when task.retrieval_status = 'SUCCEEDED' then 'ANALYSIS'::text
        else 'RETRIEVAL'::text
      end as phase,
      job.execution_engine,
      batch.id as batch_id,
      batch.name as batch_name,
      batch.week_code,
      batch.status as batch_status,
      job.id as job_id,
      job.status as job_status,
      job.requested_branch,
      job.started_at as job_started_at,
      task.id as task_id,
      story.id as story_id,
      story.story_code,
      story.story_name,
      task.heartbeat_at,
      task.lease_expires_at
    from public.analysis_story_task task
    join online_workers worker on worker.worker_id = task.worker_id
    join public.analysis_job job on job.id = task.job_id
    join public.review_batch batch on batch.id = job.batch_id
    join public.review_story story on story.id = task.story_id
    where task.lease_expires_at >= now()
      and (
        (
          job.execution_engine = 'legacy-openai'
          and task.retrieval_status <> 'FAILED'
          and task.analysis_status <> 'FAILED'
          and not (
            task.retrieval_status = 'SUCCEEDED'
            and task.analysis_status = 'SUCCEEDED'
          )
        )
        or (
          job.execution_engine = 'deepseek-harness-acp'
          and task.agent_status not in ('SUCCEEDED', 'FAILED')
        )
      )

    union all

    select
      job.finalizer_worker_id as worker_id,
      'FINALIZING'::text as phase,
      job.execution_engine,
      batch.id as batch_id,
      batch.name as batch_name,
      batch.week_code,
      batch.status as batch_status,
      job.id as job_id,
      job.status as job_status,
      job.requested_branch,
      job.started_at as job_started_at,
      null::uuid as task_id,
      null::uuid as story_id,
      null::text as story_code,
      null::text as story_name,
      worker.last_seen_at as heartbeat_at,
      job.finalize_lease_expires_at as lease_expires_at
    from public.analysis_job job
    join online_workers worker on worker.worker_id = job.finalizer_worker_id
    join public.review_batch batch on batch.id = job.batch_id
    where job.status = 'FINALIZING'
      and job.finalize_lease_expires_at >= now()
  ),
  worker_assignments as (
    select
      assignment.worker_id,
      jsonb_agg(
        jsonb_build_object(
          'phase', assignment.phase,
          'execution_engine', assignment.execution_engine,
          'batch_id', assignment.batch_id,
          'batch_name', assignment.batch_name,
          'week_code', assignment.week_code,
          'batch_status', assignment.batch_status,
          'job_id', assignment.job_id,
          'job_status', assignment.job_status,
          'requested_branch', assignment.requested_branch,
          'job_started_at', assignment.job_started_at,
          'task_id', assignment.task_id,
          'story_id', assignment.story_id,
          'story_code', assignment.story_code,
          'story_name', assignment.story_name,
          'heartbeat_at', assignment.heartbeat_at,
          'lease_expires_at', assignment.lease_expires_at
        )
        order by assignment.batch_name, assignment.story_code nulls first, assignment.phase
      ) as assignments
    from raw_assignments assignment
    group by assignment.worker_id
  ),
  worker_rows as (
    select
      worker.worker_id,
      worker.slots,
      worker.reported_current_tasks,
      worker.last_seen_at,
      worker.supported_engines,
      worker.protocol_version,
      coalesce(assignments.assignments, '[]'::jsonb) as assignments,
      coalesce(jsonb_array_length(assignments.assignments), 0) > 0 as working
    from online_workers worker
    left join worker_assignments assignments on assignments.worker_id = worker.worker_id
  )
  select jsonb_build_object(
    'generated_at', now(),
    'online_count', (select count(*) from worker_rows),
    'working_count', (select count(*) from worker_rows where working),
    'idle_count', (select count(*) from worker_rows where not working),
    'total_slots', coalesce((select sum(slots) from worker_rows), 0),
    'reported_current_tasks', coalesce((select sum(reported_current_tasks) from worker_rows), 0),
    'workers', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'worker_id', worker_id,
          'slots', slots,
          'reported_current_tasks', reported_current_tasks,
          'last_seen_at', last_seen_at,
          'online', true,
          'working', working,
          'supported_engines', to_jsonb(supported_engines),
          'protocol_version', protocol_version,
          'assignments', assignments
        )
        order by worker_id
      )
      from worker_rows
    ), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;

revoke execute on function public.admin_list_analysis_workers() from public, anon;
grant execute on function public.admin_list_analysis_workers() to authenticated;

------------------------------------------------------------------------------
-- 13. 权限：新函数一律先撤销再按角色授权
------------------------------------------------------------------------------

revoke execute on function public.heartbeat_analysis_worker_v2(text, integer, integer, text[], integer, jsonb)
  from public, anon, authenticated;
revoke execute on function public.claim_job_for_preparation_v2(text, text[], integer, integer)
  from public, anon, authenticated;
revoke execute on function public.save_repository_snapshots_v2(uuid, text, jsonb)
  from public, anon, authenticated;
revoke execute on function public.claim_next_story_task_v2(text, text[], integer, integer)
  from public, anon, authenticated;
revoke execute on function public.heartbeat_story_task_v2(uuid, text, uuid, integer)
  from public, anon, authenticated;
revoke execute on function public.get_model_secret_for_story_task_v2(uuid, text, uuid)
  from public, anon, authenticated;
revoke execute on function public.save_agent_review_result(uuid, text, uuid, integer, jsonb, jsonb, jsonb, text, text, text)
  from public, anon, authenticated;
revoke execute on function public.fail_agent_review(uuid, text, uuid, text, text)
  from public, anon, authenticated;
revoke execute on function public.claim_job_for_finalization_v2(text, text[], integer, integer)
  from public, anon, authenticated;
revoke execute on function public.list_completed_story_tasks_v2(uuid)
  from public, anon, authenticated;
revoke execute on function public.complete_analysis_job_v2(uuid, text, jsonb, jsonb)
  from public, anon, authenticated;
revoke execute on function public.fail_claimed_analysis_job_v2(uuid, text, text, text)
  from public, anon, authenticated;

grant execute on function public.heartbeat_analysis_worker_v2(text, integer, integer, text[], integer, jsonb)
  to service_role;
grant execute on function public.claim_job_for_preparation_v2(text, text[], integer, integer)
  to service_role;
grant execute on function public.save_repository_snapshots_v2(uuid, text, jsonb)
  to service_role;
grant execute on function public.claim_next_story_task_v2(text, text[], integer, integer)
  to service_role;
grant execute on function public.heartbeat_story_task_v2(uuid, text, uuid, integer)
  to service_role;
grant execute on function public.get_model_secret_for_story_task_v2(uuid, text, uuid)
  to service_role;
grant execute on function public.save_agent_review_result(uuid, text, uuid, integer, jsonb, jsonb, jsonb, text, text, text)
  to service_role;
grant execute on function public.fail_agent_review(uuid, text, uuid, text, text)
  to service_role;
grant execute on function public.claim_job_for_finalization_v2(text, text[], integer, integer)
  to service_role;
grant execute on function public.list_completed_story_tasks_v2(uuid)
  to service_role;
grant execute on function public.complete_analysis_job_v2(uuid, text, jsonb, jsonb)
  to service_role;
grant execute on function public.fail_claimed_analysis_job_v2(uuid, text, text, text)
  to service_role;

-- 重建后的前端 RPC 需要重新授权（drop function 会一并丢弃 grant）。
revoke execute on function public.list_enabled_model_configs() from public, anon;
revoke execute on function public.admin_list_model_configs() from public, anon;
grant execute on function public.list_enabled_model_configs() to authenticated;
grant execute on function public.admin_list_model_configs() to authenticated;

revoke execute on function public.admin_set_model_execution_engine(uuid, text, integer, integer, integer, integer, integer)
  from public, anon;
grant execute on function public.admin_set_model_execution_engine(uuid, text, integer, integer, integer, integer, integer)
  to authenticated, service_role;

commit;

