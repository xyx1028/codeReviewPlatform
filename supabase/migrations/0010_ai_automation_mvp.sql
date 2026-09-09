-- 0010_ai_automation_mvp.sql
-- AI 自动化 MVP：模型配置 + Vault 密钥、批次模型选择与锁定、
-- analysis_job / analysis_repository_snapshot / analysis_story_task、
-- 多 Worker 需求级并发（SKIP LOCKED + 租约/心跳/迟到写拒绝）、
-- 模型级严格并发（advisory lock）、检索/分析保存、原子 complete/fail/retry。
--
-- 兼容性说明：
--  * 兼容 0008 触发器 validate_ai_import_metadata：complete_analysis_job 写入
--    ai_import_record 时会填充 baseline_branch(=批次分支)、baseline_commit、
--    ai_model、analyzed_at，满足触发器强校验。
--  * 兼容 0005：review_story 已删除 description / acceptance_criteria 列，
--    因此本迁移不引用这两列；需求文本由 Worker 从 story_name/source_data 组装。
--  * 所有 Worker RPC（claim/save/heartbeat/secret/complete/fail）只授权 service_role。
--  * 浏览器可读接口一律不返回 api_key_secret_id。

begin;

------------------------------------------------------------------------------
-- 0. Vault 扩展与权限收敛
------------------------------------------------------------------------------

create extension if not exists supabase_vault with schema vault;

-- 强制撤销普通角色对解密视图的访问；只有 service_role / postgres 可读。
revoke all on vault.decrypted_secrets from anon, authenticated;
revoke all on vault.secrets from anon, authenticated;

------------------------------------------------------------------------------
-- 1. 模型配置表 ai_model_config
------------------------------------------------------------------------------

create table if not exists public.ai_model_config (
  id uuid primary key default gen_random_uuid(),
  display_name text not null,
  provider text not null check (provider in ('openai-compatible', 'deepseek-harness')),
  base_url text not null,
  model_name text not null,
  api_key_secret_id uuid not null unique,
  enabled boolean not null default true,
  max_parallel_tasks integer not null default 4
    check (max_parallel_tasks between 1 and 20),
  request_timeout_ms integer not null default 180000
    check (request_timeout_ms between 10000 and 600000),
  retrieval_prompt_version text not null default 'retrieval-v1',
  analysis_prompt_version text not null default 'analysis-v1',
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists touch_ai_model_config_updated_at on public.ai_model_config;
create trigger touch_ai_model_config_updated_at
before update on public.ai_model_config
for each row execute function public.touch_updated_at();

-- 已被批次或分析任务引用后，provider/base_url/model_name 不可变（审计可追溯）。
-- DB 触发器兜底，无论通过何种路径更新都强制约束。
create or replace function public.enforce_ai_model_config_immutable()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.provider is distinct from old.provider
     or new.base_url is distinct from old.base_url
     or new.model_name is distinct from old.model_name then
    if exists (select 1 from public.review_batch b where b.ai_model_config_id = old.id)
       or exists (select 1 from public.analysis_job j where j.model_config_id = old.id) then
      raise exception 'provider/base_url/model_name are immutable once referenced by a batch';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists enforce_ai_model_config_immutable on public.ai_model_config;
create trigger enforce_ai_model_config_immutable
before update of provider, base_url, model_name on public.ai_model_config
for each row execute function public.enforce_ai_model_config_immutable();

------------------------------------------------------------------------------
-- 2. review_batch 模型字段
------------------------------------------------------------------------------

alter table public.review_batch
  add column if not exists ai_model_config_id uuid references public.ai_model_config(id),
  add column if not exists ai_model_snapshot jsonb;

------------------------------------------------------------------------------
-- 3. analysis_job
------------------------------------------------------------------------------

create table if not exists public.analysis_job (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.review_batch(id) on delete cascade,
  model_config_id uuid not null references public.ai_model_config(id),
  model_snapshot jsonb not null,
  requested_branch text not null
    check (requested_branch in ('feature_dev', 'feature_sit', 'release')),
  status text not null default 'QUEUED'
    check (status in (
      'QUEUED', 'PREPARING_CODE', 'PROCESSING', 'FINALIZING',
      'SUCCEEDED', 'FAILED'
    )),
  requested_by uuid not null references auth.users(id),
  worker_id text,
  finalizer_worker_id text,
  finalize_lease_expires_at timestamptz,
  attempt integer not null default 0 check (attempt >= 0),
  total_stories integer not null default 0,
  retrieved_stories integer not null default 0,
  analyzed_stories integer not null default 0,
  error_code text,
  error_message text,
  locked_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 每个批次只允许一个活动任务
create unique index if not exists uq_analysis_job_active_batch
on public.analysis_job(batch_id)
where status in ('QUEUED', 'PREPARING_CODE', 'PROCESSING', 'FINALIZING');

create index if not exists idx_analysis_job_status_created
on public.analysis_job(status, created_at);

create index if not exists idx_analysis_job_batch
on public.analysis_job(batch_id);

create index if not exists idx_analysis_job_model_config
on public.analysis_job(model_config_id);

drop trigger if exists touch_analysis_job_updated_at on public.analysis_job;
create trigger touch_analysis_job_updated_at
before update on public.analysis_job
for each row execute function public.touch_updated_at();

------------------------------------------------------------------------------
-- 4. analysis_repository_snapshot
------------------------------------------------------------------------------

create table if not exists public.analysis_repository_snapshot (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.analysis_job(id) on delete cascade,
  repository_name text not null,
  requested_branch text not null,
  commit_sha text not null,
  commit_subject text,
  prepared_at timestamptz not null default now(),
  unique (job_id, repository_name),
  check (repository_name in (
    'kdmanage-backend', 'kdmanage-frontend',
    'tmanage-backend', 'tmanage-frontend'
  )),
  check (requested_branch in ('feature_dev', 'feature_sit', 'release')),
  check (commit_sha ~ '^[0-9A-Fa-f]{40}([0-9A-Fa-f]{24})?$')
);

create index if not exists idx_analysis_repo_snapshot_job
on public.analysis_repository_snapshot(job_id);

------------------------------------------------------------------------------
-- 5. analysis_story_task
------------------------------------------------------------------------------

create table if not exists public.analysis_story_task (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.analysis_job(id) on delete cascade,
  story_id uuid not null references public.review_story(id) on delete cascade,
  retrieval_status text not null default 'PENDING'
    check (retrieval_status in ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED')),
  analysis_status text not null default 'PENDING'
    check (analysis_status in ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED')),
  worker_id text,
  lease_expires_at timestamptz,
  heartbeat_at timestamptz,
  retrieval_model text,
  analysis_model text,
  retrieval_prompt_version text,
  analysis_prompt_version text,
  retrieval_output jsonb,
  analysis_output jsonb,
  retrieval_attempt integer not null default 0,
  analysis_attempt integer not null default 0,
  error_code text,
  error_message text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (job_id, story_id)
);

create index if not exists idx_analysis_story_task_job
on public.analysis_story_task(job_id, retrieval_status, analysis_status);

create index if not exists idx_analysis_story_task_lease
on public.analysis_story_task(lease_expires_at);

drop trigger if exists touch_analysis_story_task_updated_at on public.analysis_story_task;
create trigger touch_analysis_story_task_updated_at
before update on public.analysis_story_task
for each row execute function public.touch_updated_at();

------------------------------------------------------------------------------
-- 5b. analysis_worker_heartbeat：Worker 在线状态（容量/处理中）
------------------------------------------------------------------------------

create table if not exists public.analysis_worker_heartbeat (
  worker_id text primary key,
  slots integer not null default 0 check (slots >= 0),
  current_tasks integer not null default 0 check (current_tasks >= 0),
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists idx_analysis_worker_heartbeat_seen
on public.analysis_worker_heartbeat(last_seen_at);

------------------------------------------------------------------------------
-- 6. 批次模型锁定触发器
--    一旦存在活动分析任务或 AI 结果，禁止修改批次模型；
--    Provider/BaseURL/Model 一旦被批次引用视为不可变（在 admin_upsert 中处理）。
------------------------------------------------------------------------------

create or replace function public.validate_review_batch_model()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'UPDATE'
     and new.ai_model_config_id is distinct from old.ai_model_config_id then
    if exists (select 1 from public.analysis_job where batch_id = old.id)
       or exists (select 1 from public.ai_import_record where batch_id = old.id) then
      raise exception 'batch model cannot change after an analysis job or AI result exists';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists validate_review_batch_model on public.review_batch;
create trigger validate_review_batch_model
before update of ai_model_config_id on public.review_batch
for each row execute function public.validate_review_batch_model();

-- 一旦存在分析任务，批次分支锁定（保证任务快照与批次分支一致）。
create or replace function public.validate_review_batch_branch()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'UPDATE'
     and new.default_branch is distinct from old.default_branch then
    if exists (select 1 from public.analysis_job where batch_id = old.id) then
      raise exception 'batch branch cannot change after an analysis job exists';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists validate_review_batch_branch on public.review_batch;
create trigger validate_review_batch_branch
before update of default_branch on public.review_batch
for each row execute function public.validate_review_batch_branch();

------------------------------------------------------------------------------
-- 7. RLS
------------------------------------------------------------------------------

alter table public.ai_model_config enable row level security;
alter table public.analysis_job enable row level security;
alter table public.analysis_repository_snapshot enable row level security;
alter table public.analysis_story_task enable row level security;
alter table public.analysis_worker_heartbeat enable row level security;

-- ai_model_config：不给 authenticated 直接 select（避免暴露 api_key_secret_id）。
-- 前端读取一律通过 list_enabled_model_configs() / admin_list_model_configs() RPC。
-- service_role 绕过 RLS，可全量访问。
drop policy if exists "no direct authenticated read model config" on public.ai_model_config;
create policy "no direct authenticated read model config" on public.ai_model_config
for select to authenticated using (false);

-- analysis_job：登录用户可读自己有权管理的批次任务。
drop policy if exists "read analysis job for managed batch" on public.analysis_job;
create policy "read analysis job for managed batch" on public.analysis_job
for select to authenticated using (
  public.can_manage_review_batch(batch_id)
);

drop policy if exists "read repo snapshot for managed batch" on public.analysis_repository_snapshot;
create policy "read repo snapshot for managed batch" on public.analysis_repository_snapshot
for select to authenticated using (
  exists (
    select 1 from public.analysis_job job
    where job.id = analysis_repository_snapshot.job_id
      and public.can_manage_review_batch(job.batch_id)
  )
);

drop policy if exists "read story task for managed batch" on public.analysis_story_task;
create policy "read story task for managed batch" on public.analysis_story_task
for select to authenticated using (
  exists (
    select 1 from public.analysis_job job
    where job.id = analysis_story_task.job_id
      and public.can_manage_review_batch(job.batch_id)
  )
);

-- 写操作不开放给 authenticated（仅 SECURITY DEFINER RPC 或 service_role）。

-- analysis_worker_heartbeat：不给 authenticated 直接 select，一律通过
-- list_active_analysis_workers() RPC 只读近 15 秒活跃状态；写入仅 service RPC。
drop policy if exists "no direct authenticated read worker heartbeat" on public.analysis_worker_heartbeat;
create policy "no direct authenticated read worker heartbeat" on public.analysis_worker_heartbeat
for select to authenticated using (false);

------------------------------------------------------------------------------
-- 8. 无密钥列表 RPC
------------------------------------------------------------------------------

-- 8.0 判断某 config 是否在 Vault 中确实存在密钥记录（不解密明文）
create or replace function public.model_config_has_api_key(p_secret_id uuid)
returns boolean
language sql
security definer
set search_path = public, vault
stable
as $$
  select p_secret_id is not null
     and exists (select 1 from vault.secrets s where s.id = p_secret_id);
$$;

-- 8.1 有创建批次权限的用户：只返回启用且已配置密钥的模型（无密钥字段）
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
    cfg.created_at,
    cfg.updated_at
  from public.ai_model_config cfg
  where cfg.enabled = true
    and public.model_config_has_api_key(cfg.api_key_secret_id)
  order by cfg.display_name;
end;
$$;

-- 8.2 ADMIN：返回全部模型配置（含停用），永远不返回 api_key_secret_id
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
  is_referenced boolean,
  created_by uuid,
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
    exists (select 1 from public.review_batch b where b.ai_model_config_id = cfg.id)
      or exists (select 1 from public.analysis_job j where j.model_config_id = cfg.id) as is_referenced,
    cfg.created_by,
    cfg.created_at,
    cfg.updated_at
  from public.ai_model_config cfg
  order by cfg.created_at desc;
end;
$$;

------------------------------------------------------------------------------
-- 9. 模型管理 RPC（供 admin-model-config Edge Function 调用）
------------------------------------------------------------------------------

-- 9.0 校验指定用户为 ADMIN（供 service-role 调用的管理 RPC 使用，不依赖 auth.uid）
create or replace function public.assert_actor_is_admin(p_actor_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_actor_id is null then
    raise exception 'actor_id is required';
  end if;
  if not exists (
    select 1 from public.user_profile where id = p_actor_id and role = 'ADMIN'
  ) then
    raise exception 'ADMIN role required';
  end if;
end;
$$;

-- 9.1 创建模型配置：由 Edge Function 先写 Vault secret，再传入 secret_id
create or replace function public.admin_create_model_config(
  p_actor_id uuid,
  p_display_name text,
  p_provider text,
  p_base_url text,
  p_model_name text,
  p_api_key_secret_id uuid,
  p_max_parallel_tasks integer default 4,
  p_request_timeout_ms integer default 180000,
  p_retrieval_prompt_version text default 'retrieval-v1',
  p_analysis_prompt_version text default 'analysis-v1'
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  perform public.assert_actor_is_admin(p_actor_id);

  if p_display_name is null or btrim(p_display_name) = '' then
    raise exception 'display_name is required';
  end if;
  if p_provider not in ('openai-compatible', 'deepseek-harness') then
    raise exception 'invalid provider';
  end if;
  if p_base_url is null or btrim(p_base_url) = '' then
    raise exception 'base_url is required';
  end if;
  if p_model_name is null or btrim(p_model_name) = '' then
    raise exception 'model_name is required';
  end if;
  if p_api_key_secret_id is null then
    raise exception 'api_key_secret_id is required';
  end if;

  insert into public.ai_model_config (
    display_name, provider, base_url, model_name, api_key_secret_id,
    max_parallel_tasks, request_timeout_ms,
    retrieval_prompt_version, analysis_prompt_version, created_by
  ) values (
    btrim(p_display_name), p_provider, btrim(p_base_url), btrim(p_model_name),
    p_api_key_secret_id, p_max_parallel_tasks, p_request_timeout_ms,
    p_retrieval_prompt_version, p_analysis_prompt_version, p_actor_id
  ) returning id into v_id;

  return v_id;
end;
$$;

-- 9.2 更新模型配置。p_new_api_key_secret_id 非空时轮换引用并返回旧 secret_id 供清理。
create or replace function public.admin_update_model_config(
  p_actor_id uuid,
  p_id uuid,
  p_display_name text default null,
  p_provider text default null,
  p_base_url text default null,
  p_model_name text default null,
  p_new_api_key_secret_id uuid default null,
  p_max_parallel_tasks integer default null,
  p_request_timeout_ms integer default null,
  p_retrieval_prompt_version text default null,
  p_analysis_prompt_version text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_referenced boolean;
  v_old_secret uuid;
begin
  perform public.assert_actor_is_admin(p_actor_id);

  if not exists (select 1 from public.ai_model_config where id = p_id) then
    raise exception 'model config not found';
  end if;

  v_referenced := exists (select 1 from public.review_batch b where b.ai_model_config_id = p_id)
    or exists (select 1 from public.analysis_job j where j.model_config_id = p_id);

  -- 已被引用后，Provider / Base URL / Model 不可变（保证审计可追溯）
  if v_referenced then
    if (p_provider is not null and p_provider <> (select provider from public.ai_model_config where id = p_id))
       or (p_base_url is not null and btrim(p_base_url) <> (select base_url from public.ai_model_config where id = p_id))
       or (p_model_name is not null and btrim(p_model_name) <> (select model_name from public.ai_model_config where id = p_id)) then
      raise exception 'provider/base_url/model_name are immutable once referenced by a batch';
    end if;
  end if;

  if p_provider is not null and p_provider not in ('openai-compatible', 'deepseek-harness') then
    raise exception 'invalid provider';
  end if;

  select api_key_secret_id into v_old_secret from public.ai_model_config where id = p_id;

  update public.ai_model_config set
    display_name = coalesce(nullif(btrim(p_display_name), ''), display_name),
    provider = coalesce(p_provider, provider),
    base_url = coalesce(nullif(btrim(p_base_url), ''), base_url),
    model_name = coalesce(nullif(btrim(p_model_name), ''), model_name),
    api_key_secret_id = coalesce(p_new_api_key_secret_id, api_key_secret_id),
    max_parallel_tasks = coalesce(p_max_parallel_tasks, max_parallel_tasks),
    request_timeout_ms = coalesce(p_request_timeout_ms, request_timeout_ms),
    retrieval_prompt_version = coalesce(nullif(btrim(p_retrieval_prompt_version), ''), retrieval_prompt_version),
    analysis_prompt_version = coalesce(nullif(btrim(p_analysis_prompt_version), ''), analysis_prompt_version)
  where id = p_id;

  -- 轮换时返回旧 secret_id，交由 Edge Function 在更新引用成功后删除
  if p_new_api_key_secret_id is not null and p_new_api_key_secret_id <> v_old_secret then
    return v_old_secret;
  end if;
  return null;
end;
$$;

-- 9.3 启用 / 停用（不删除历史引用）
create or replace function public.admin_set_model_enabled(p_id uuid, p_enabled boolean)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.ensure_admin();
  update public.ai_model_config set enabled = p_enabled where id = p_id;
  if not found then
    raise exception 'model config not found';
  end if;
  return p_id;
end;
$$;

-- 9.4 供 Edge Function 读取指定 config 的 secret_id（仅在服务端使用，绝不返回前端）
create or replace function public.admin_get_model_secret_id(p_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_secret uuid;
begin
  perform public.ensure_admin();
  select api_key_secret_id into v_secret from public.ai_model_config where id = p_id;
  if v_secret is null then
    raise exception 'model config not found';
  end if;
  return v_secret;
end;
$$;

-- 9.5 Vault 包装 RPC（public schema，仅 service_role）
--     由于 PostgREST 默认不暴露 vault schema，Edge Function 通过以下 public 包装
--     完成密钥写入/轮换/删除/测试读取，全部集中在服务端并受权限收敛保护。

-- 写入新密钥，返回 secret UUID
create or replace function public.admin_vault_create_secret(p_secret text, p_name text)
returns uuid
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_id uuid;
begin
  -- 该函数只授权 service_role；Edge Function 已先行校验 ADMIN。
  v_id := vault.create_secret(p_secret, p_name, 'ai_model_config api key');
  return v_id;
end;
$$;

-- 删除旧密钥（轮换或回滚时清理），失败不抛出以免阻断主流程
create or replace function public.admin_vault_delete_secret(p_secret_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, vault
as $$
begin
  delete from vault.secrets where id = p_secret_id;
  return true;
exception when others then
  return false;
end;
$$;

-- 供“测试连接”读取指定 config 的密钥明文（仅服务端内存使用，绝不返回前端存储）
create or replace function public.admin_get_model_secret_by_config(p_id uuid)
returns text
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_secret_id uuid;
  v_secret text;
begin
  select api_key_secret_id into v_secret_id from public.ai_model_config where id = p_id;
  if v_secret_id is null then
    raise exception 'model config not found';
  end if;
  select decrypted_secret into v_secret from vault.decrypted_secrets where id = v_secret_id;
  if v_secret is null then
    raise exception 'MODEL_SECRET_MISSING';
  end if;
  return v_secret;
end;
$$;

------------------------------------------------------------------------------
-- 10. set_batch_model：为未开始任务的批次选择已启用模型
------------------------------------------------------------------------------

create or replace function public.set_batch_model(p_batch_id uuid, p_model_config_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_enabled boolean;
  v_secret uuid;
begin
  perform public.ensure_manage_review_batch(p_batch_id);

  if exists (select 1 from public.analysis_job where batch_id = p_batch_id)
     or exists (select 1 from public.ai_import_record where batch_id = p_batch_id) then
    raise exception 'batch model cannot change after an analysis job or AI result exists';
  end if;

  select enabled, api_key_secret_id into v_enabled, v_secret
  from public.ai_model_config where id = p_model_config_id;

  if v_enabled is null then
    raise exception 'model config not found';
  end if;
  if not v_enabled then
    raise exception 'model config is disabled';
  end if;
  if not public.model_config_has_api_key(v_secret) then
    raise exception 'model config has no API key configured';
  end if;

  update public.review_batch
  set ai_model_config_id = p_model_config_id
  where id = p_batch_id;

  return p_batch_id;
end;
$$;

------------------------------------------------------------------------------
-- 11. 模型快照构造（不含密钥）
------------------------------------------------------------------------------

create or replace function public.build_model_snapshot(p_model_config_id uuid)
returns jsonb
language sql
security definer
set search_path = public
stable
as $$
  select jsonb_build_object(
    'model_config_id', cfg.id,
    'display_name', cfg.display_name,
    'provider', cfg.provider,
    'base_url', cfg.base_url,
    'model_name', cfg.model_name,
    'max_parallel_tasks', cfg.max_parallel_tasks,
    'request_timeout_ms', cfg.request_timeout_ms,
    'retrieval_prompt_version', cfg.retrieval_prompt_version,
    'analysis_prompt_version', cfg.analysis_prompt_version
  )
  from public.ai_model_config cfg
  where cfg.id = p_model_config_id;
$$;

------------------------------------------------------------------------------
-- 12. enqueue_analysis_job：校验前置条件、复制分支、建 job + story task
------------------------------------------------------------------------------

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

  -- 已有 AI 结果不再自动分析
  if exists (select 1 from public.ai_import_record where batch_id = p_batch_id) then
    raise exception 'AI result already exists for this batch';
  end if;

  -- 不允许存在活动任务（同时由 uq_analysis_job_active_batch 兜底）
  if exists (
    select 1 from public.analysis_job
    where batch_id = p_batch_id
      and status in ('QUEUED', 'PREPARING_CODE', 'PROCESSING', 'FINALIZING')
  ) then
    raise exception 'an active analysis job already exists for this batch';
  end if;

  -- 至少一条需求
  select count(*) into v_story_count from public.review_story where batch_id = p_batch_id;
  if v_story_count = 0 then
    raise exception 'no stories imported for this batch';
  end if;

  -- 模型必须启用且已配置密钥
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

  -- 冻结批次快照（不含密钥）
  update public.review_batch
  set ai_model_snapshot = v_snapshot
  where id = p_batch_id;

  insert into public.analysis_job (
    batch_id, model_config_id, model_snapshot, requested_branch,
    status, requested_by, total_stories
  ) values (
    p_batch_id, v_batch.ai_model_config_id, v_snapshot, v_batch.default_branch,
    'QUEUED', (select auth.uid()), v_story_count
  ) returning id into v_job_id;

  insert into public.analysis_story_task (job_id, story_id)
  select v_job_id, story.id
  from public.review_story story
  where story.batch_id = p_batch_id;

  return v_job_id;
end;
$$;

------------------------------------------------------------------------------
-- 13. Worker RPC：领取准备任务、保存仓库快照
------------------------------------------------------------------------------

-- 13.1 领取一个 QUEUED job（或回收超时 PREPARING_CODE）进入 PREPARING_CODE
--      使用 FOR UPDATE SKIP LOCKED 并加租约（locked_at + p_lease_seconds）。
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
  where status = 'QUEUED'
     or (
       status = 'PREPARING_CODE'
       and (locked_at is null or locked_at + make_interval(secs => p_lease_seconds) < now())
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
      'total_stories', v_job.total_stories
    ),
    'model', v_job.model_snapshot
  );
end;
$$;

-- 13.2 原子保存 4 个仓库快照，完成后置 job 为 PROCESSING
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

  -- 必须齐全 4 个仓库
  if (select count(*) from public.analysis_repository_snapshot where job_id = p_job_id) <> 4 then
    raise exception 'exactly 4 repository snapshots are required';
  end if;

  update public.analysis_job set status = 'PROCESSING' where id = p_job_id;
end;
$$;

------------------------------------------------------------------------------
-- 14. 需求任务领取（SKIP LOCKED + 严格模型级并发 advisory lock + 租约）
------------------------------------------------------------------------------

create or replace function public.claim_next_story_task(p_worker_id text, p_lease_seconds integer default 900)
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
  v_result jsonb;
begin
  if p_worker_id is null or btrim(p_worker_id) = '' then
    raise exception 'worker_id is required';
  end if;
  if p_lease_seconds is null or p_lease_seconds < 30 then
    p_lease_seconds := 900;
  end if;

  -- 全局短 advisory xact lock：串行化领取判定窗口，避免并发超发。
  perform pg_advisory_xact_lock(hashtext('claim_next_story_task'));

  -- 选取一个可领取的任务：所属 job 处于 PROCESSING，且
  --   * 尚未完成检索或分析
  --   * 未失败
  --   * 无有效租约（lease 为空或已过期）
  select task.* into v_task
  from public.analysis_story_task task
  join public.analysis_job job on job.id = task.job_id
  where job.status = 'PROCESSING'
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

  -- 取所属 job 的模型配置与并发上限
  select job.* into v_job from public.analysis_job job where job.id = v_task.job_id;
  v_model_config_id := v_job.model_config_id;

  select max_parallel_tasks into v_max_parallel
  from public.ai_model_config where id = v_model_config_id;
  if v_max_parallel is null then
    v_max_parallel := 4;
  end if;

  -- 严格模型级并发：以 model_config_id 派生 advisory lock，串行化领取判定，
  -- 防止并发领取超过 max_parallel_tasks。事务级 advisory lock，事务结束自动释放。
  v_lock_key := ('x' || substr(md5(v_model_config_id::text), 1, 16))::bit(64)::bigint;
  perform pg_advisory_xact_lock(v_lock_key);

  -- 统计该模型配置当前仍持有有效租约的任务数
  select count(*) into v_active
  from public.analysis_story_task t
  join public.analysis_job j on j.id = t.job_id
  where j.model_config_id = v_model_config_id
    and t.lease_expires_at is not null
    and t.lease_expires_at >= now()
    and not (t.retrieval_status = 'SUCCEEDED' and t.analysis_status = 'SUCCEEDED')
    and t.retrieval_status <> 'FAILED'
    and t.analysis_status <> 'FAILED';

  if v_active >= v_max_parallel then
    -- 达到上限，本次不发放；advisory lock 随事务结束释放。
    return null;
  end if;

  -- 领取：正确设置 retrieval / analysis 的 RUNNING 与 attempt。
  --   * 检索未完成：进入检索阶段（RUNNING + retrieval_attempt+1）。
  --   * 检索已成功、分析未完成：进入分析阶段（RUNNING + analysis_attempt+1）。
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

  v_result := to_jsonb(v_task)
    || jsonb_build_object(
      'job', jsonb_build_object(
        'id', v_job.id,
        'batch_id', v_job.batch_id,
        'model_config_id', v_job.model_config_id,
        'requested_branch', v_job.requested_branch,
        'total_stories', v_job.total_stories
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
        -- 0005 已删除 description / acceptance_criteria 列，契约要求置 null。
        'description', null,
        'acceptance_criteria', null,
        'project_name', v_story.project_name,
        'application_name', v_story.application_name,
        'source_data', v_story.source_data
      )
    );

  return v_result;
end;
$$;

------------------------------------------------------------------------------
-- 15. 心跳续租（校验租约仍归属该 worker）
------------------------------------------------------------------------------

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

  update public.analysis_story_task
  set heartbeat_at = now(),
      lease_expires_at = now() + make_interval(secs => p_lease_seconds)
  where id = p_task_id
    and worker_id = p_worker_id
    and lease_expires_at is not null
    and lease_expires_at >= now()
  returning true into v_ok;

  return coalesce(v_ok, false);
end;
$$;

------------------------------------------------------------------------------
-- 15b. 需求级失败：校验租约，标记 task 对应阶段 FAILED 并将 job 置 FAILED
------------------------------------------------------------------------------

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
  v_held boolean;
begin
  if p_stage not in ('retrieval', 'analysis') then
    raise exception 'stage must be retrieval or analysis';
  end if;

  select job_id,
         (worker_id = p_worker_id and lease_expires_at is not null and lease_expires_at >= now())
    into v_job_id, v_held
  from public.analysis_story_task
  where id = p_task_id
  for update;

  if v_job_id is null then
    raise exception 'task not found';
  end if;
  if not coalesce(v_held, false) then
    raise exception 'TASK_LEASE_LOST';
  end if;

  update public.analysis_story_task
  set retrieval_status = case when p_stage = 'retrieval' then 'FAILED' else retrieval_status end,
      analysis_status = case when p_stage = 'analysis' then 'FAILED' else analysis_status end,
      error_code = p_error_code,
      error_message = p_error_message,
      heartbeat_at = now(),
      finished_at = now()
  where id = p_task_id;

  -- 单条需求失败即整个 job 失败（不回退，符合可信性要求）。
  update public.analysis_job
  set status = 'FAILED',
      error_code = p_error_code,
      error_message = p_error_message,
      finished_at = now()
  where id = v_job_id
    and status not in ('SUCCEEDED', 'FAILED');
end;
$$;

------------------------------------------------------------------------------
-- 16. 保存检索结果（阶段一），迟到写拒绝
------------------------------------------------------------------------------

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
begin
  -- 校验租约仍归属该 worker 且未过期
  select job_id,
         (worker_id = p_worker_id and lease_expires_at is not null and lease_expires_at >= now())
    into v_job_id, v_held
  from public.analysis_story_task
  where id = p_task_id
  for update;

  if v_job_id is null then
    raise exception 'task not found';
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

  -- 更新 job 检索进度
  update public.analysis_job
  set retrieved_stories = (
    select count(*) from public.analysis_story_task
    where job_id = v_job_id and retrieval_status = 'SUCCEEDED'
  )
  where id = v_job_id;
end;
$$;

------------------------------------------------------------------------------
-- 17. 保存分析结果（阶段二），迟到写拒绝
------------------------------------------------------------------------------

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
begin
  select job_id,
         (worker_id = p_worker_id and lease_expires_at is not null and lease_expires_at >= now()),
         (retrieval_status = 'SUCCEEDED')
    into v_job_id, v_held, v_retrieval_ok
  from public.analysis_story_task
  where id = p_task_id
  for update;

  if v_job_id is null then
    raise exception 'task not found';
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

------------------------------------------------------------------------------
-- 18. 从 Vault 读取本任务密钥（仅 service_role / Worker 内存使用）
------------------------------------------------------------------------------

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
begin
  if p_worker_id is null or btrim(p_worker_id) = '' then
    raise exception 'worker_id is required';
  end if;

  select job.status, cfg.api_key_secret_id
    into v_status, v_secret_id
  from public.analysis_job job
  join public.ai_model_config cfg on cfg.id = job.model_config_id
  where job.id = p_job_id;

  if v_status is null then
    raise exception 'job not found';
  end if;

  -- 仅 PROCESSING 且该 worker 在该 job 持有有效任务租约时允许读取密钥。
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

------------------------------------------------------------------------------
-- 18b. 模型级并发状态（前端/运维只读展示）
------------------------------------------------------------------------------

create or replace function public.get_model_concurrency_status(p_model_config_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_max integer;
  v_active integer;
begin
  select max_parallel_tasks into v_max
  from public.ai_model_config where id = p_model_config_id;
  if v_max is null then
    raise exception 'model config not found';
  end if;

  select count(*) into v_active
  from public.analysis_story_task t
  join public.analysis_job j on j.id = t.job_id
  where j.model_config_id = p_model_config_id
    and t.lease_expires_at is not null
    and t.lease_expires_at >= now()
    and not (t.retrieval_status = 'SUCCEEDED' and t.analysis_status = 'SUCCEEDED')
    and t.retrieval_status <> 'FAILED'
    and t.analysis_status <> 'FAILED';

  return jsonb_build_object(
    'model_config_id', p_model_config_id,
    'max_parallel_tasks', v_max,
    'active_tasks', v_active,
    'available_slots', greatest(0, v_max - v_active)
  );
end;
$$;

------------------------------------------------------------------------------
-- 19. 原子完成任务：一次性写入现有 AI 结果表
------------------------------------------------------------------------------

------------------------------------------------------------------------------
-- 19. 领取可汇总的 job（所有任务成功的 PROCESSING，或回收超时 FINALIZING）
------------------------------------------------------------------------------

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
  where (
      -- 所有任务两阶段都成功的 PROCESSING
      job.status = 'PROCESSING'
      and not exists (
        select 1 from public.analysis_story_task t
        where t.job_id = job.id
          and not (t.retrieval_status = 'SUCCEEDED' and t.analysis_status = 'SUCCEEDED')
      )
    )
    or (
      -- 回收超时的 FINALIZING
      job.status = 'FINALIZING'
      and (job.finalize_lease_expires_at is null or job.finalize_lease_expires_at < now())
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
      'total_stories', v_job.total_stories
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

-- 汇总所需：某 job 的逐需求任务（含 story_code + analysis_output）
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
  where t.job_id = p_job_id;
$$;

------------------------------------------------------------------------------
-- 19c. 原子完成任务：一次性写入现有 AI 结果表（仅当前 finalizer 可执行）
------------------------------------------------------------------------------

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
  -- 1. 锁定 job（唯一执行者：必须是当前 finalizer 且租约有效）
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

  -- 2. 所有需求任务两阶段均成功
  select count(*) into v_pending
  from public.analysis_story_task
  where job_id = p_job_id
    and not (retrieval_status = 'SUCCEEDED' and analysis_status = 'SUCCEEDED');
  if v_pending > 0 then
    raise exception 'still % story task(s) not fully succeeded', v_pending;
  end if;

  -- 3. 批次状态与既有结果
  select * into v_batch from public.review_batch where id = v_job.batch_id for update;
  if v_batch.status = 'COMPLETED' then
    raise exception 'batch is completed and read-only';
  end if;
  if exists (select 1 from public.ai_import_record where batch_id = v_job.batch_id) then
    raise exception 'RESULT_ALREADY_EXISTS';
  end if;

  -- 4. 分支一致性
  if v_job.requested_branch is distinct from v_batch.default_branch then
    raise exception 'BATCH_BRANCH_CHANGED';
  end if;

  -- 5. 4 个仓库快照齐全
  select count(*) into v_snapshot_count
  from public.analysis_repository_snapshot where job_id = p_job_id;
  if v_snapshot_count <> 4 then
    raise exception 'repository snapshots incomplete (found %)', v_snapshot_count;
  end if;

  -- 6. 强校验 results：数量 = 批次需求总数，且 story 唯一并覆盖全部需求
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

  -- 每个 story_code 必须属于本批次
  if exists (
    select 1 from jsonb_array_elements(p_results) as value
    where not exists (
      select 1 from public.review_story s
      where s.batch_id = v_job.batch_id and s.story_code = value->>'story_code'
    )
  ) then
    raise exception 'results reference unknown story code';
  end if;

  -- 模型标签（不含密钥）— 满足 0008 ai_model 非空校验
  v_model_label := coalesce(
    (v_job.model_snapshot->>'display_name') || ' / ' ||
    (v_job.model_snapshot->>'provider') || ' / ' ||
    (v_job.model_snapshot->>'model_name'),
    'ai-automation'
  );

  select coalesce(max(version), 0) + 1 into v_version
  from public.ai_import_record where batch_id = v_job.batch_id;

  update public.ai_import_record set is_active = false where batch_id = v_job.batch_id;

  -- 7. 创建 ai_import_record（import_file_id 为 null）
  insert into public.ai_import_record (
    batch_id,
    import_file_id,
    version,
    baseline_branch,
    baseline_commit,
    ai_model,
    analyzed_at,
    imported_by,
    is_active
  ) values (
    v_job.batch_id,
    null,
    v_version,
    v_batch.default_branch,
    (
      jsonb_build_object(
        'actual_branch', v_batch.default_branch,
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

  -- 8. 写入 ai_review_result
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

  -- 9. 写入 ai_code_evidence
  --    证据 commit_sha 一律以快照 SHA 为准（不信任传参）；校验仓库/路径/行号。
  if jsonb_typeof(p_evidence) = 'array' then
    for v_evidence in select * from jsonb_array_elements(p_evidence)
    loop
      v_repo := v_evidence->>'repository_name';

      -- 证据仓库必须是本任务快照中的仓库；commit_sha 取自快照。
      select commit_sha into v_snap_sha
      from public.analysis_repository_snapshot
      where job_id = p_job_id and repository_name = v_repo;
      if v_snap_sha is null then
        raise exception 'EVIDENCE_PATH_INVALID';
      end if;

      -- 路径必填、不允许越界（.. 或绝对路径）
      if coalesce(nullif(v_evidence->>'file_path', ''), '') = '' then
        raise exception 'EVIDENCE_PATH_INVALID';
      end if;
      if (v_evidence->>'file_path') like '/%'
         or (v_evidence->>'file_path') like '%..%' then
        raise exception 'EVIDENCE_PATH_INVALID';
      end if;

      -- 行号校验：如提供则必须为正整数且 start <= end
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

  -- 10 & 11. 批次进入 REVIEWING
  update public.review_batch set status = 'REVIEWING'
  where id = v_job.batch_id and status <> 'COMPLETED';

  -- 12. job 完成
  update public.analysis_job
  set status = 'SUCCEEDED', finished_at = now()
  where id = p_job_id;

  return v_import_id;
end;
$$;

------------------------------------------------------------------------------
-- 20. 失败任务
------------------------------------------------------------------------------

create or replace function public.fail_analysis_job(
  p_job_id uuid,
  p_error_code text,
  p_error_message text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
begin
  select status into v_status from public.analysis_job where id = p_job_id for update;
  if v_status is null then
    raise exception 'job not found';
  end if;
  if v_status in ('SUCCEEDED', 'FAILED') then
    return;
  end if;

  update public.analysis_job
  set status = 'FAILED',
      error_code = p_error_code,
      error_message = p_error_message,
      finished_at = now()
  where id = p_job_id;
end;
$$;

-- Worker 仅使用 owner-safe 版本：准备或汇总失败时，只有当前 claim owner
-- 可以把任务置为 FAILED。失租 Worker 的迟到失败写入会被拒绝。
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
declare
  v_job public.analysis_job;
begin
  if p_worker_id is null or btrim(p_worker_id) = '' then
    raise exception 'worker_id is required';
  end if;

  select * into v_job
  from public.analysis_job
  where id = p_job_id
  for update;

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

revoke execute on function public.fail_claimed_analysis_job(uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function public.fail_claimed_analysis_job(uuid, text, text, text)
  to service_role;

------------------------------------------------------------------------------
-- 20b. Worker 在线心跳（service RPC）+ 近 15 秒活跃状态只读（authenticated）
------------------------------------------------------------------------------

create or replace function public.heartbeat_analysis_worker(
  p_worker_id text,
  p_slots integer,
  p_current integer
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_worker_id is null or btrim(p_worker_id) = '' then
    raise exception 'worker_id is required';
  end if;

  insert into public.analysis_worker_heartbeat (worker_id, slots, current_tasks, last_seen_at)
  values (p_worker_id, greatest(coalesce(p_slots, 0), 0), greatest(coalesce(p_current, 0), 0), now())
  on conflict (worker_id) do update
  set slots = greatest(coalesce(excluded.slots, 0), 0),
      current_tasks = greatest(coalesce(excluded.current_tasks, 0), 0),
      last_seen_at = now();
end;
$$;

-- 前端只读：近 15 秒在线 Worker 汇总（在线数 / 处理中数 / 总槽位）。
create or replace function public.list_active_analysis_workers()
returns jsonb
language sql
security definer
set search_path = public
stable
as $$
  select jsonb_build_object(
    'online', count(*),
    'processing', coalesce(sum(current_tasks), 0),
    'slots', coalesce(sum(slots), 0)
  )
  from public.analysis_worker_heartbeat
  where last_seen_at >= now() - interval '15 seconds';
$$;

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

  -- 已产生 AI 结果则不再重试
  if exists (select 1 from public.ai_import_record where batch_id = v_job.batch_id) then
    raise exception 'RESULT_ALREADY_EXISTS';
  end if;

  -- 复用原仓库快照；若已准备好则回到 PROCESSING，否则回到 QUEUED 重新准备
  select count(*) into v_snapshot_count
  from public.analysis_repository_snapshot where job_id = p_job_id;

  -- 重置失败/未完成的需求任务；已成功两阶段的复用。
  -- 成功的 retrieval 可复用（保留 retrieval_output）；分析输出与失败态输出正确清空。
  update public.analysis_story_task
  set retrieval_status = case
        when retrieval_status = 'SUCCEEDED' then 'SUCCEEDED' else 'PENDING' end,
      analysis_status = case
        when retrieval_status = 'SUCCEEDED' and analysis_status = 'SUCCEEDED'
          then 'SUCCEEDED' else 'PENDING' end,
      -- 未成功的 retrieval 清空其输出；已成功的保留以复用
      retrieval_output = case
        when retrieval_status = 'SUCCEEDED' then retrieval_output else null end,
      -- 未两阶段成功的清空分析输出
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
-- 22. 权限：撤销 public/anon，按角色授权
------------------------------------------------------------------------------

-- 通用/前端可用 RPC（authenticated）
revoke execute on function public.validate_review_batch_model() from public, anon, authenticated;
revoke execute on function public.build_model_snapshot(uuid) from public, anon, authenticated;

revoke execute on function public.list_enabled_model_configs() from public, anon;
revoke execute on function public.admin_list_model_configs() from public, anon;
revoke execute on function public.set_batch_model(uuid, uuid) from public, anon;
revoke execute on function public.enqueue_analysis_job(uuid) from public, anon;
revoke execute on function public.retry_analysis_job(uuid) from public, anon;

grant execute on function public.list_enabled_model_configs() to authenticated;
grant execute on function public.admin_list_model_configs() to authenticated;
grant execute on function public.set_batch_model(uuid, uuid) to authenticated;
grant execute on function public.enqueue_analysis_job(uuid) to authenticated;
grant execute on function public.retry_analysis_job(uuid) to authenticated;

-- 前端只读辅助 RPC
revoke execute on function public.model_config_has_api_key(uuid) from public, anon, authenticated;
revoke execute on function public.get_model_concurrency_status(uuid) from public, anon;
revoke execute on function public.list_active_analysis_workers() from public, anon;
grant execute on function public.get_model_concurrency_status(uuid) to authenticated, service_role;
grant execute on function public.list_active_analysis_workers() to authenticated, service_role;

-- 内部触发器/辅助函数：一律不授予前端
revoke execute on function public.validate_review_batch_branch() from public, anon, authenticated;
revoke execute on function public.enforce_ai_model_config_immutable() from public, anon, authenticated;
revoke execute on function public.assert_actor_is_admin(uuid) from public, anon, authenticated;
grant execute on function public.assert_actor_is_admin(uuid) to service_role;

-- 模型管理 RPC：仅 service_role（由 admin-model-config Edge Function 以 service key 调用）
revoke execute on function public.admin_create_model_config(uuid, text, text, text, text, uuid, integer, integer, text, text) from public, anon, authenticated;
revoke execute on function public.admin_update_model_config(uuid, uuid, text, text, text, text, uuid, integer, integer, text, text) from public, anon, authenticated;
revoke execute on function public.admin_set_model_enabled(uuid, boolean) from public, anon;
revoke execute on function public.admin_get_model_secret_id(uuid) from public, anon, authenticated;
grant execute on function public.admin_create_model_config(uuid, text, text, text, text, uuid, integer, integer, text, text) to service_role;
grant execute on function public.admin_update_model_config(uuid, uuid, text, text, text, text, uuid, integer, integer, text, text) to service_role;
-- 启用/停用属于纯元数据操作，允许 ADMIN 直接调用（函数内 ensure_admin 兜底）
grant execute on function public.admin_set_model_enabled(uuid, boolean) to authenticated, service_role;
grant execute on function public.admin_get_model_secret_id(uuid) to service_role;

-- Vault 包装 RPC：仅 service_role
revoke execute on function public.admin_vault_create_secret(text, text) from public, anon, authenticated;
revoke execute on function public.admin_vault_delete_secret(uuid) from public, anon, authenticated;
revoke execute on function public.admin_get_model_secret_by_config(uuid) from public, anon, authenticated;
grant execute on function public.admin_vault_create_secret(text, text) to service_role;
grant execute on function public.admin_vault_delete_secret(uuid) to service_role;
grant execute on function public.admin_get_model_secret_by_config(uuid) to service_role;

-- Worker RPC：仅 service_role
revoke execute on function public.claim_job_for_preparation(text, integer) from public, anon, authenticated;
revoke execute on function public.save_repository_snapshots(uuid, text, jsonb) from public, anon, authenticated;
revoke execute on function public.claim_next_story_task(text, integer) from public, anon, authenticated;
revoke execute on function public.heartbeat_story_task(uuid, text, integer) from public, anon, authenticated;
revoke execute on function public.fail_story_task(uuid, text, text, text, text) from public, anon, authenticated;
revoke execute on function public.save_retrieval_result(uuid, text, jsonb, text, text) from public, anon, authenticated;
revoke execute on function public.save_analysis_result(uuid, text, jsonb, text, text) from public, anon, authenticated;
revoke execute on function public.get_model_secret_for_job(uuid, text) from public, anon, authenticated;
revoke execute on function public.claim_job_for_finalization(text, integer) from public, anon, authenticated;
revoke execute on function public.list_analysis_story_tasks_for_worker(uuid) from public, anon, authenticated;
revoke execute on function public.complete_analysis_job(uuid, text, jsonb, jsonb) from public, anon, authenticated;
revoke execute on function public.fail_analysis_job(uuid, text, text) from public, anon, authenticated;
revoke execute on function public.heartbeat_analysis_worker(text, integer, integer) from public, anon, authenticated;

grant execute on function public.claim_job_for_preparation(text, integer) to service_role;
grant execute on function public.save_repository_snapshots(uuid, text, jsonb) to service_role;
grant execute on function public.claim_next_story_task(text, integer) to service_role;
grant execute on function public.heartbeat_story_task(uuid, text, integer) to service_role;
grant execute on function public.fail_story_task(uuid, text, text, text, text) to service_role;
grant execute on function public.save_retrieval_result(uuid, text, jsonb, text, text) to service_role;
grant execute on function public.save_analysis_result(uuid, text, jsonb, text, text) to service_role;
grant execute on function public.get_model_secret_for_job(uuid, text) to service_role;
grant execute on function public.claim_job_for_finalization(text, integer) to service_role;
grant execute on function public.list_analysis_story_tasks_for_worker(uuid) to service_role;
grant execute on function public.complete_analysis_job(uuid, text, jsonb, jsonb) to service_role;
grant execute on function public.fail_analysis_job(uuid, text, text) to service_role;
grant execute on function public.heartbeat_analysis_worker(text, integer, integer) to service_role;

-- 表级 select 授权：新任务表对 authenticated 只读（RLS 兜底管理者范围）；
-- ai_model_config 不授权直接 select（避免密钥列泄露），只通过 RPC 读取。
-- analysis_worker_heartbeat 也不直接授权（只通过 list_active_analysis_workers）。
grant select on public.analysis_job to authenticated;
grant select on public.analysis_repository_snapshot to authenticated;
grant select on public.analysis_story_task to authenticated;

commit;
