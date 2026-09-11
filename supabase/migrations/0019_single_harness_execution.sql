-- ---------------------------------------------------------------------------
-- 0019：平台收敛为唯一的 DeepSeek Harness ACP 执行链路。
--
-- 目标：
--   * 删除 legacy-openai 两阶段运行入口，以及平台业务 RPC 的 v1/v2 区分；
--   * 新模型、新 Job、领取、重试、汇总只允许 DeepSeek Harness ACP；
--   * 移除 Worker supported_engines / protocol_version 能力交叉逻辑；
--   * 保留 analysis_job.execution_engine 作为历史来源字段，不改写已完成结果；
--   * 保留 Vault/API Key。它是 Harness provider 凭据，不是旧两阶段执行链路。
--
-- 这是前滚迁移。0017/0018 已部署，不得回改。
-- ---------------------------------------------------------------------------

begin;

------------------------------------------------------------------------------
-- 1. 封存尚未结束的 legacy Job；历史成功/失败结果保持原样可读
------------------------------------------------------------------------------

update public.analysis_story_task task
set agent_status = 'FAILED',
    worker_id = null,
    lease_expires_at = null,
    heartbeat_at = null,
    claim_token_digest = null,
    error_code = 'LEGACY_ENGINE_RETIRED',
    error_message = 'legacy two-stage execution was retired; this historical job cannot be resumed',
    finished_at = coalesce(task.finished_at, now())
where task.job_id in (
  select job.id
  from public.analysis_job job
  where job.execution_engine = 'legacy-openai'
    and job.status in ('QUEUED', 'PREPARING_CODE', 'PROCESSING', 'FINALIZING')
);

update public.analysis_job job
set status = 'FAILED',
    worker_id = null,
    locked_at = null,
    finalizer_worker_id = null,
    finalize_lease_expires_at = null,
    error_code = 'LEGACY_ENGINE_RETIRED',
    error_message = 'legacy two-stage execution was retired; create a new Harness analysis job',
    finished_at = coalesce(job.finished_at, now())
where job.execution_engine = 'legacy-openai'
  and job.status in ('QUEUED', 'PREPARING_CODE', 'PROCESSING', 'FINALIZING');

------------------------------------------------------------------------------
-- 2. 删除双引擎、旧两阶段和 _v2 RPC；后文只重建一套 canonical API
------------------------------------------------------------------------------

-- 管理与建单函数先删除，避免后续删除模型配置列时存在依赖。
drop function if exists public.enqueue_analysis_job(uuid);
drop function if exists public.retry_analysis_job(uuid);
drop function if exists public.build_model_snapshot(uuid);
drop function if exists public.list_enabled_model_configs();
drop function if exists public.admin_list_model_configs();
drop function if exists public.admin_list_analysis_workers();
drop function if exists public.list_active_analysis_workers();
drop function if exists public.admin_set_model_execution_engine(
  uuid, uuid, text, integer, integer, integer, integer, integer
);
drop function if exists public.admin_set_model_execution_engine(
  uuid, text, integer, integer, integer, integer, integer
);

-- 0015 当前生效的带审计模型管理签名；后文改为原子写入 Agent 参数。
drop function if exists public.admin_create_model_config(
  uuid, text, text, text, text, uuid, integer, integer, text, text
);
drop function if exists public.admin_update_model_config(
  uuid, uuid, text, text, text, text, uuid, integer, integer, text, text
);

-- 旧无后缀（legacy/v1）Worker RPC。
drop function if exists public.heartbeat_analysis_worker(text, integer, integer);
drop function if exists public.claim_job_for_preparation(text, integer);
drop function if exists public.save_repository_snapshots(uuid, text, jsonb);
drop function if exists public.claim_next_story_task(text, integer);
drop function if exists public.heartbeat_story_task(uuid, text, integer);
drop function if exists public.get_model_secret_for_job(uuid, text);
drop function if exists public.save_retrieval_result(uuid, text, jsonb, text, text);
drop function if exists public.save_analysis_result(uuid, text, jsonb, text, text);
drop function if exists public.fail_story_task(uuid, text, text, text, text);
drop function if exists public.claim_job_for_finalization(text, integer);
drop function if exists public.list_analysis_story_tasks_for_worker(uuid);
drop function if exists public.complete_analysis_job(uuid, text, jsonb, jsonb);
drop function if exists public.fail_claimed_analysis_job(uuid, text, text, text);

-- 0017 的平台 v2 Worker RPC。
drop function if exists public.heartbeat_analysis_worker_v2(
  text, integer, integer, text[], integer, jsonb
);
drop function if exists public.claim_job_for_preparation_v2(text, text[], integer, integer);
drop function if exists public.save_repository_snapshots_v2(uuid, text, jsonb);
drop function if exists public.claim_next_story_task_v2(text, text[], integer, integer);
drop function if exists public.heartbeat_story_task_v2(uuid, text, uuid, integer);
drop function if exists public.get_model_secret_for_story_task_v2(uuid, text, uuid);
drop function if exists public.claim_job_for_finalization_v2(text, text[], integer, integer);
drop function if exists public.list_completed_story_tasks_v2(uuid);
drop function if exists public.complete_analysis_job_v2(uuid, text, jsonb, jsonb);
drop function if exists public.fail_claimed_analysis_job_v2(uuid, text, text, text);
drop function if exists public.worker_effective_engines(text, text[], integer);

-- 这两个名称本来就无版本后缀，但需要去掉 engine 分支/列依赖后重建。
drop function if exists public.save_agent_review_result(
  uuid, text, uuid, integer, jsonb, jsonb, jsonb, text, text, text
);
drop function if exists public.fail_agent_review(uuid, text, uuid, text, text);

------------------------------------------------------------------------------
-- 3. Schema 收口
------------------------------------------------------------------------------

-- 模型配置不再选择执行引擎，也不再保存旧两阶段 prompt 版本。
alter table public.ai_model_config
  drop constraint if exists ai_model_config_execution_engine_check;
alter table public.ai_model_config
  drop column if exists execution_engine,
  drop column if exists retrieval_prompt_version,
  drop column if exists analysis_prompt_version;

-- Agent 请求默认预算采用真实模型验证后的 120；现有显式配置不覆盖。
alter table public.ai_model_config
  alter column agent_max_model_requests set default 120;

-- Job 字段只作历史 provenance：旧完成记录保留 legacy 值，新记录固定 ACP。
alter table public.analysis_job
  alter column execution_engine set default 'deepseek-harness-acp';
comment on column public.analysis_job.execution_engine is
  'Historical execution provenance. New jobs are always deepseek-harness-acp; legacy rows are read-only.';

create or replace function public.enforce_new_analysis_job_harness_only()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.execution_engine <> 'deepseek-harness-acp' then
    raise exception 'LEGACY_ENGINE_RETIRED';
  end if;
  return new;
end;
$$;

drop trigger if exists enforce_new_analysis_job_harness_only on public.analysis_job;
create trigger enforce_new_analysis_job_harness_only
before insert on public.analysis_job
for each row execute function public.enforce_new_analysis_job_harness_only();

revoke execute on function public.enforce_new_analysis_job_harness_only()
  from public, anon, authenticated;

-- Worker 不再声明引擎集合或平台协议版本；capabilities 保留非版本化运行信息。
alter table public.analysis_worker_heartbeat
  drop constraint if exists analysis_worker_heartbeat_protocol_check;
alter table public.analysis_worker_heartbeat
  drop column if exists supported_engines,
  drop column if exists protocol_version;

-- Agent run 只可能来自 Harness，不再重复存一列恒定引擎。
alter table public.analysis_agent_run
  drop column if exists execution_engine;

-- 审计白名单加入 Agent 参数；历史日志中的两阶段字段仍允许读取。
alter table public.batch_operation_log
  drop constraint if exists batch_operation_log_safe_values_check;
alter table public.batch_operation_log
  add constraint batch_operation_log_safe_values_check
  check (
    (coalesce(old_values, '{}'::jsonb) - array[
      'display_name', 'provider', 'model_name', 'max_parallel_tasks',
      'request_timeout_ms', 'retrieval_prompt_version', 'analysis_prompt_version',
      'context_window', 'max_output_tokens', 'agent_max_model_requests',
      'agent_max_retry_requests', 'agent_max_compaction_requests', 'enabled'
    ]) = '{}'::jsonb
    and (coalesce(new_values, '{}'::jsonb) - array[
      'display_name', 'provider', 'model_name', 'max_parallel_tasks',
      'request_timeout_ms', 'retrieval_prompt_version', 'analysis_prompt_version',
      'context_window', 'max_output_tokens', 'agent_max_model_requests',
      'agent_max_retry_requests', 'agent_max_compaction_requests', 'enabled'
    ]) = '{}'::jsonb
    and coalesce(changed_fields, array[]::text[]) <@ array[
      'display_name', 'provider', 'base_url', 'model_name', 'max_parallel_tasks',
      'request_timeout_ms', 'retrieval_prompt_version', 'analysis_prompt_version',
      'context_window', 'max_output_tokens', 'agent_max_model_requests',
      'agent_max_retry_requests', 'agent_max_compaction_requests',
      'enabled', 'api_key'
    ]::text[]
    and coalesce(jsonb_typeof(old_values -> 'display_name') = 'string', true)
    and coalesce(jsonb_typeof(old_values -> 'provider') = 'string', true)
    and coalesce(jsonb_typeof(old_values -> 'model_name') = 'string', true)
    and coalesce(jsonb_typeof(old_values -> 'max_parallel_tasks') = 'number', true)
    and coalesce(jsonb_typeof(old_values -> 'request_timeout_ms') = 'number', true)
    and coalesce(jsonb_typeof(old_values -> 'retrieval_prompt_version') = 'string', true)
    and coalesce(jsonb_typeof(old_values -> 'analysis_prompt_version') = 'string', true)
    and coalesce(jsonb_typeof(old_values -> 'context_window') = 'number', true)
    and coalesce(jsonb_typeof(old_values -> 'max_output_tokens') = 'number', true)
    and coalesce(jsonb_typeof(old_values -> 'agent_max_model_requests') = 'number', true)
    and coalesce(jsonb_typeof(old_values -> 'agent_max_retry_requests') = 'number', true)
    and coalesce(jsonb_typeof(old_values -> 'agent_max_compaction_requests') = 'number', true)
    and coalesce(jsonb_typeof(old_values -> 'enabled') = 'boolean', true)
    and coalesce(jsonb_typeof(new_values -> 'display_name') = 'string', true)
    and coalesce(jsonb_typeof(new_values -> 'provider') = 'string', true)
    and coalesce(jsonb_typeof(new_values -> 'model_name') = 'string', true)
    and coalesce(jsonb_typeof(new_values -> 'max_parallel_tasks') = 'number', true)
    and coalesce(jsonb_typeof(new_values -> 'request_timeout_ms') = 'number', true)
    and coalesce(jsonb_typeof(new_values -> 'retrieval_prompt_version') = 'string', true)
    and coalesce(jsonb_typeof(new_values -> 'analysis_prompt_version') = 'string', true)
    and coalesce(jsonb_typeof(new_values -> 'context_window') = 'number', true)
    and coalesce(jsonb_typeof(new_values -> 'max_output_tokens') = 'number', true)
    and coalesce(jsonb_typeof(new_values -> 'agent_max_model_requests') = 'number', true)
    and coalesce(jsonb_typeof(new_values -> 'agent_max_retry_requests') = 'number', true)
    and coalesce(jsonb_typeof(new_values -> 'agent_max_compaction_requests') = 'number', true)
    and coalesce(jsonb_typeof(new_values -> 'enabled') = 'boolean', true)
  );

------------------------------------------------------------------------------
-- 4. 模型管理：Agent 参数与元数据同一事务写入
------------------------------------------------------------------------------

create or replace function public.admin_create_model_config(
  p_actor_id uuid,
  p_display_name text,
  p_provider text,
  p_base_url text,
  p_model_name text,
  p_api_key_secret_id uuid,
  p_max_parallel_tasks integer default 4,
  p_request_timeout_ms integer default 180000,
  p_context_window integer default 131072,
  p_max_output_tokens integer default 8192,
  p_agent_max_model_requests integer default 120,
  p_agent_max_retry_requests integer default 6,
  p_agent_max_compaction_requests integer default 4
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_display_name text;
  v_base_url text;
  v_model_name text;
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

  v_display_name := btrim(p_display_name);
  v_base_url := btrim(p_base_url);
  v_model_name := btrim(p_model_name);

  insert into public.ai_model_config (
    display_name, provider, base_url, model_name, api_key_secret_id,
    max_parallel_tasks, request_timeout_ms, context_window, max_output_tokens,
    agent_max_model_requests, agent_max_retry_requests,
    agent_max_compaction_requests, created_by
  ) values (
    v_display_name, p_provider, v_base_url, v_model_name, p_api_key_secret_id,
    p_max_parallel_tasks, p_request_timeout_ms, p_context_window, p_max_output_tokens,
    p_agent_max_model_requests, p_agent_max_retry_requests,
    p_agent_max_compaction_requests, p_actor_id
  ) returning id into v_id;

  insert into public.batch_operation_log (
    batch_id, action, model_config_id, model_display_name_snapshot,
    changed_fields, new_values, api_key_changed, performed_by
  ) values (
    null, 'MODEL_CONFIG_CREATED', v_id, v_display_name,
    array[
      'display_name', 'provider', 'base_url', 'model_name',
      'max_parallel_tasks', 'request_timeout_ms', 'context_window',
      'max_output_tokens', 'agent_max_model_requests',
      'agent_max_retry_requests', 'agent_max_compaction_requests', 'api_key'
    ],
    jsonb_build_object(
      'display_name', v_display_name,
      'provider', p_provider,
      'model_name', v_model_name,
      'max_parallel_tasks', p_max_parallel_tasks,
      'request_timeout_ms', p_request_timeout_ms,
      'context_window', p_context_window,
      'max_output_tokens', p_max_output_tokens,
      'agent_max_model_requests', p_agent_max_model_requests,
      'agent_max_retry_requests', p_agent_max_retry_requests,
      'agent_max_compaction_requests', p_agent_max_compaction_requests
    ),
    true,
    p_actor_id
  );

  return v_id;
end;
$$;

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
  p_context_window integer default null,
  p_max_output_tokens integer default null,
  p_agent_max_model_requests integer default null,
  p_agent_max_retry_requests integer default null,
  p_agent_max_compaction_requests integer default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing public.ai_model_config;
  v_updated public.ai_model_config;
  v_referenced boolean;
  v_new_display_name text;
  v_changed_fields text[] := array[]::text[];
  v_old_values jsonb := '{}'::jsonb;
  v_new_values jsonb := '{}'::jsonb;
  v_api_key_changed boolean := false;
begin
  perform public.assert_actor_is_admin(p_actor_id);

  select * into v_existing
  from public.ai_model_config
  where id = p_id
  for update;

  if v_existing.id is null then
    raise exception 'model config not found';
  end if;

  v_referenced := exists (
    select 1 from public.review_batch batch where batch.ai_model_config_id = p_id
  ) or exists (
    select 1 from public.analysis_job job where job.model_config_id = p_id
  );

  if v_referenced then
    if (p_provider is not null and p_provider <> v_existing.provider)
      or (p_base_url is not null and btrim(p_base_url) <> v_existing.base_url)
      or (p_model_name is not null and btrim(p_model_name) <> v_existing.model_name) then
      raise exception 'provider/base_url/model_name are immutable once referenced by a batch';
    end if;
  end if;

  if p_provider is not null and p_provider not in ('openai-compatible', 'deepseek-harness') then
    raise exception 'invalid provider';
  end if;

  v_new_display_name := coalesce(nullif(btrim(p_display_name), ''), v_existing.display_name);

  update public.ai_model_config set
    display_name = v_new_display_name,
    provider = coalesce(p_provider, provider),
    base_url = coalesce(nullif(btrim(p_base_url), ''), base_url),
    model_name = coalesce(nullif(btrim(p_model_name), ''), model_name),
    api_key_secret_id = coalesce(p_new_api_key_secret_id, api_key_secret_id),
    max_parallel_tasks = coalesce(p_max_parallel_tasks, max_parallel_tasks),
    request_timeout_ms = coalesce(p_request_timeout_ms, request_timeout_ms),
    context_window = coalesce(p_context_window, context_window),
    max_output_tokens = coalesce(p_max_output_tokens, max_output_tokens),
    agent_max_model_requests = coalesce(p_agent_max_model_requests, agent_max_model_requests),
    agent_max_retry_requests = coalesce(p_agent_max_retry_requests, agent_max_retry_requests),
    agent_max_compaction_requests =
      coalesce(p_agent_max_compaction_requests, agent_max_compaction_requests)
  where id = p_id
  returning * into v_updated;

  if v_existing.display_name is distinct from v_updated.display_name then
    v_changed_fields := array_append(v_changed_fields, 'display_name');
    v_old_values := v_old_values || jsonb_build_object('display_name', v_existing.display_name);
    v_new_values := v_new_values || jsonb_build_object('display_name', v_updated.display_name);
  end if;
  if v_existing.provider is distinct from v_updated.provider then
    v_changed_fields := array_append(v_changed_fields, 'provider');
    v_old_values := v_old_values || jsonb_build_object('provider', v_existing.provider);
    v_new_values := v_new_values || jsonb_build_object('provider', v_updated.provider);
  end if;
  if v_existing.base_url is distinct from v_updated.base_url then
    v_changed_fields := array_append(v_changed_fields, 'base_url');
  end if;
  if v_existing.model_name is distinct from v_updated.model_name then
    v_changed_fields := array_append(v_changed_fields, 'model_name');
    v_old_values := v_old_values || jsonb_build_object('model_name', v_existing.model_name);
    v_new_values := v_new_values || jsonb_build_object('model_name', v_updated.model_name);
  end if;
  if v_existing.max_parallel_tasks is distinct from v_updated.max_parallel_tasks then
    v_changed_fields := array_append(v_changed_fields, 'max_parallel_tasks');
    v_old_values := v_old_values || jsonb_build_object(
      'max_parallel_tasks', v_existing.max_parallel_tasks
    );
    v_new_values := v_new_values || jsonb_build_object(
      'max_parallel_tasks', v_updated.max_parallel_tasks
    );
  end if;
  if v_existing.request_timeout_ms is distinct from v_updated.request_timeout_ms then
    v_changed_fields := array_append(v_changed_fields, 'request_timeout_ms');
    v_old_values := v_old_values || jsonb_build_object(
      'request_timeout_ms', v_existing.request_timeout_ms
    );
    v_new_values := v_new_values || jsonb_build_object(
      'request_timeout_ms', v_updated.request_timeout_ms
    );
  end if;
  if v_existing.context_window is distinct from v_updated.context_window then
    v_changed_fields := array_append(v_changed_fields, 'context_window');
    v_old_values := v_old_values || jsonb_build_object('context_window', v_existing.context_window);
    v_new_values := v_new_values || jsonb_build_object('context_window', v_updated.context_window);
  end if;
  if v_existing.max_output_tokens is distinct from v_updated.max_output_tokens then
    v_changed_fields := array_append(v_changed_fields, 'max_output_tokens');
    v_old_values := v_old_values || jsonb_build_object(
      'max_output_tokens', v_existing.max_output_tokens
    );
    v_new_values := v_new_values || jsonb_build_object(
      'max_output_tokens', v_updated.max_output_tokens
    );
  end if;
  if v_existing.agent_max_model_requests is distinct from v_updated.agent_max_model_requests then
    v_changed_fields := array_append(v_changed_fields, 'agent_max_model_requests');
    v_old_values := v_old_values || jsonb_build_object(
      'agent_max_model_requests', v_existing.agent_max_model_requests
    );
    v_new_values := v_new_values || jsonb_build_object(
      'agent_max_model_requests', v_updated.agent_max_model_requests
    );
  end if;
  if v_existing.agent_max_retry_requests is distinct from v_updated.agent_max_retry_requests then
    v_changed_fields := array_append(v_changed_fields, 'agent_max_retry_requests');
    v_old_values := v_old_values || jsonb_build_object(
      'agent_max_retry_requests', v_existing.agent_max_retry_requests
    );
    v_new_values := v_new_values || jsonb_build_object(
      'agent_max_retry_requests', v_updated.agent_max_retry_requests
    );
  end if;
  if v_existing.agent_max_compaction_requests is distinct from v_updated.agent_max_compaction_requests then
    v_changed_fields := array_append(v_changed_fields, 'agent_max_compaction_requests');
    v_old_values := v_old_values || jsonb_build_object(
      'agent_max_compaction_requests', v_existing.agent_max_compaction_requests
    );
    v_new_values := v_new_values || jsonb_build_object(
      'agent_max_compaction_requests', v_updated.agent_max_compaction_requests
    );
  end if;

  v_api_key_changed := p_new_api_key_secret_id is not null
    and p_new_api_key_secret_id is distinct from v_existing.api_key_secret_id;
  if v_api_key_changed then
    v_changed_fields := array_append(v_changed_fields, 'api_key');
  end if;

  if cardinality(v_changed_fields) > 0 then
    insert into public.batch_operation_log (
      batch_id, action, model_config_id, model_display_name_snapshot,
      changed_fields, old_values, new_values, api_key_changed, performed_by
    ) values (
      null, 'MODEL_CONFIG_UPDATED', p_id, v_updated.display_name,
      v_changed_fields, v_old_values, v_new_values, v_api_key_changed, p_actor_id
    );
  end if;

  if v_api_key_changed then
    return v_existing.api_key_secret_id;
  end if;
  return null;
end;
$$;

------------------------------------------------------------------------------
-- 5. 无密钥模型列表与完整 Agent 快照
------------------------------------------------------------------------------

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
    public.model_config_has_api_key(cfg.api_key_secret_id),
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
  context_window integer,
  max_output_tokens integer,
  agent_max_model_requests integer,
  agent_max_retry_requests integer,
  agent_max_compaction_requests integer,
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
    public.model_config_has_api_key(cfg.api_key_secret_id),
    cfg.max_parallel_tasks,
    cfg.request_timeout_ms,
    cfg.context_window,
    cfg.max_output_tokens,
    cfg.agent_max_model_requests,
    cfg.agent_max_retry_requests,
    cfg.agent_max_compaction_requests,
    exists (select 1 from public.review_batch batch where batch.ai_model_config_id = cfg.id)
      or exists (select 1 from public.analysis_job job where job.model_config_id = cfg.id),
    cfg.created_by,
    cfg.created_at,
    cfg.updated_at
  from public.ai_model_config cfg
  order by cfg.created_at desc;
end;
$$;

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
    'context_window', cfg.context_window,
    'max_output_tokens', cfg.max_output_tokens,
    'agent_max_model_requests', cfg.agent_max_model_requests,
    'agent_max_retry_requests', cfg.agent_max_retry_requests,
    'agent_max_compaction_requests', cfg.agent_max_compaction_requests
  )
  from public.ai_model_config cfg
  where cfg.id = p_model_config_id;
$$;

------------------------------------------------------------------------------
-- 6. 建单与重试：永远只产生/恢复 Harness Job
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
  update public.review_batch set ai_model_snapshot = v_snapshot where id = p_batch_id;

  insert into public.analysis_job (
    batch_id, model_config_id, model_snapshot, requested_branch,
    status, requested_by, total_stories, execution_engine
  ) values (
    p_batch_id, v_batch.ai_model_config_id, v_snapshot, v_batch.default_branch,
    'QUEUED', (select auth.uid()), v_story_count, 'deepseek-harness-acp'
  ) returning id into v_job_id;

  insert into public.analysis_story_task (job_id, story_id)
  select v_job_id, story.id
  from public.review_story story
  where story.batch_id = p_batch_id;

  return v_job_id;
end;
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

  if v_job.execution_engine <> 'deepseek-harness-acp' then
    raise exception 'LEGACY_ENGINE_RETIRED';
  end if;
  if v_job.status <> 'FAILED' then
    raise exception 'only FAILED jobs can be retried';
  end if;
  if exists (select 1 from public.ai_import_record where batch_id = v_job.batch_id) then
    raise exception 'RESULT_ALREADY_EXISTS';
  end if;

  select count(*) into v_snapshot_count
  from public.analysis_repository_snapshot where job_id = p_job_id;

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

  update public.analysis_agent_run
  set status = 'FAILED',
      finished_at = coalesce(finished_at, now())
  where job_id = p_job_id
    and status = 'RUNNING';

  update public.analysis_job
  set status = case when v_snapshot_count = 4 then 'PROCESSING' else 'QUEUED' end,
      worker_id = null,
      locked_at = null,
      finalizer_worker_id = null,
      finalize_lease_expires_at = null,
      error_code = null,
      error_message = null,
      finished_at = null
  where id = p_job_id;

  return p_job_id;
end;
$$;

------------------------------------------------------------------------------
-- 7. 唯一 Worker API：无版本后缀、无引擎能力参数
------------------------------------------------------------------------------

create or replace function public.heartbeat_analysis_worker(
  p_worker_id text,
  p_slots integer,
  p_current integer,
  p_capabilities jsonb default '{}'::jsonb
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

  insert into public.analysis_worker_heartbeat (
    worker_id, slots, current_tasks, last_seen_at, capabilities
  ) values (
    p_worker_id,
    greatest(coalesce(p_slots, 0), 0),
    greatest(coalesce(p_current, 0), 0),
    now(),
    coalesce(p_capabilities, '{}'::jsonb)
  )
  on conflict (worker_id) do update
  set slots = greatest(coalesce(excluded.slots, 0), 0),
      current_tasks = greatest(coalesce(excluded.current_tasks, 0), 0),
      last_seen_at = now(),
      capabilities = excluded.capabilities;
end;
$$;

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
  where execution_engine = 'deepseek-harness-acp'
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
      'total_stories', v_job.total_stories
    ),
    'model', v_job.model_snapshot
  );
end;
$$;

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
  v_engine text;
  v_snap jsonb;
begin
  select status, requested_branch, worker_id, execution_engine
    into v_status, v_branch, v_worker, v_engine
  from public.analysis_job where id = p_job_id for update;

  if v_status is null then
    raise exception 'job not found';
  end if;
  if v_engine <> 'deepseek-harness-acp' then
    raise exception 'LEGACY_ENGINE_RETIRED';
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

  insert into public.analysis_agent_run (
    task_id, job_id, agent_attempt, worker_id, status
  ) values (
    v_task.id, v_job.id, v_task.agent_attempt, p_worker_id, 'RUNNING'
  )
  on conflict (task_id, agent_attempt) do update
  set worker_id = excluded.worker_id,
      status = 'RUNNING',
      started_at = now(),
      error_code = null,
      error_message = null;

  select * into v_story from public.review_story where id = v_task.story_id;

  -- 0017 创建中的 ACP Job 快照可能尚无预算字段；只为这些在途 Job 从配置补齐。
  v_model := v_job.model_snapshot || jsonb_build_object(
    'context_window', coalesce(
      nullif(v_job.model_snapshot->>'context_window', '')::integer,
      v_cfg.context_window
    ),
    'max_output_tokens', coalesce(
      nullif(v_job.model_snapshot->>'max_output_tokens', '')::integer,
      v_cfg.max_output_tokens
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
      'job', jsonb_build_object(
        'id', v_job.id,
        'batch_id', v_job.batch_id,
        'model_config_id', v_job.model_config_id,
        'requested_branch', v_job.requested_branch,
        'total_stories', v_job.total_stories
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
declare
  v_ok boolean;
begin
  if p_claim_token is null then
    return false;
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
  returning true into v_ok;

  return coalesce(v_ok, false);
end;
$$;

create or replace function public.get_model_secret_for_story_task(
  p_task_id uuid,
  p_worker_id text,
  p_claim_token uuid
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
  if p_claim_token is null then
    raise exception 'AGENT_CLAIM_INVALID';
  end if;

  select cfg.api_key_secret_id,
         (
           job.status = 'PROCESSING'
           and job.execution_engine = 'deepseek-harness-acp'
           and task.worker_id = p_worker_id
           and task.lease_expires_at is not null
           and task.lease_expires_at >= now()
           and task.claim_token_digest = public.agent_claim_token_digest(p_claim_token)
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

  v_committed_at := now();

  insert into public.analysis_agent_run (
    task_id, job_id, agent_attempt, worker_id, status,
    profile_config_hash, prompt_version, model_label,
    tool_calls, evidence_shown, searches_run, retry_requests, compaction_requests,
    committed_at, finished_at
  ) values (
    p_task_id, v_task.job_id, p_agent_attempt, p_worker_id, 'COMMITTED',
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

  delete from public.analysis_agent_evidence where agent_run_id = v_run_id;

  if jsonb_typeof(p_evidence) = 'array' then
    for v_evidence in select * from jsonb_array_elements(p_evidence)
    loop
      if not exists (
        select 1 from public.analysis_repository_snapshot snapshot
        where snapshot.job_id = v_task.job_id
          and snapshot.repository_name = v_evidence->>'repository_name'
          and lower(snapshot.commit_sha) = lower(v_evidence->>'commit_sha')
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

  update public.analysis_job
  set analyzed_stories = (
    select count(*) from public.analysis_story_task
    where job_id = v_task.job_id and agent_status = 'SUCCEEDED'
  )
  where id = v_task.job_id;

  return jsonb_build_object('run_id', v_run_id, 'committed_at', v_committed_at);
end;
$$;

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
  where job.execution_engine = 'deepseek-harness-acp'
    and (
      (
        job.status = 'PROCESSING'
        and not exists (
          select 1 from public.analysis_story_task task
          where task.job_id = job.id and task.agent_status <> 'SUCCEEDED'
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
      'total_stories', v_job.total_stories
    ),
    'model', v_job.model_snapshot,
    'snapshots', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'repository_name', snapshot.repository_name,
        'requested_branch', snapshot.requested_branch,
        'commit_sha', snapshot.commit_sha,
        'commit_subject', snapshot.commit_subject
      ) order by snapshot.repository_name), '[]'::jsonb)
      from public.analysis_repository_snapshot snapshot
      where snapshot.job_id = v_job.id
    )
  );
end;
$$;

create or replace function public.list_completed_story_tasks(p_job_id uuid)
returns jsonb
language sql
security definer
set search_path = public
stable
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', task.id,
    'job_id', task.job_id,
    'story_id', task.story_id,
    'story_code', story.story_code,
    'story_name', story.story_name,
    'agent_status', task.agent_status,
    'output', task.agent_output,
    'verified_evidence', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'evidence_id', evidence.evidence_id,
        'repository_name', evidence.repository_name,
        'commit_sha', evidence.commit_sha,
        'file_path', evidence.file_path,
        'start_line', evidence.start_line,
        'end_line', evidence.end_line,
        'evidence_type', evidence.evidence_type,
        'description', evidence.description
      ) order by evidence.file_path, evidence.start_line), '[]'::jsonb)
      from public.analysis_agent_run run
      join public.analysis_agent_evidence evidence on evidence.agent_run_id = run.id
      where run.task_id = task.id and run.status = 'COMMITTED'
    )
  ) order by story.story_code), '[]'::jsonb)
  from public.analysis_story_task task
  join public.review_story story on story.id = task.story_id
  join public.analysis_job job on job.id = task.job_id
  where task.job_id = p_job_id
    and job.execution_engine = 'deepseek-harness-acp';
$$;

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
  select * into v_job from public.analysis_job where id = p_job_id for update;
  if v_job.id is null then
    raise exception 'job not found';
  end if;
  if v_job.execution_engine <> 'deepseek-harness-acp' then
    raise exception 'LEGACY_ENGINE_RETIRED';
  end if;
  if v_job.status <> 'FINALIZING' then
    raise exception 'job is not in FINALIZING state (status=%)', v_job.status;
  end if;
  if v_job.finalizer_worker_id is distinct from p_worker_id
     or v_job.finalize_lease_expires_at is null
     or v_job.finalize_lease_expires_at < now() then
    raise exception 'JOB_LEASE_LOST';
  end if;

  select count(*) into v_pending
  from public.analysis_story_task
  where job_id = p_job_id and agent_status <> 'SUCCEEDED';
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
    raise exception 'results must cover each story exactly once (distinct=%, required=%)',
      v_distinct, v_required;
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_results) as value
    where not exists (
      select 1 from public.review_story story
      where story.batch_id = v_job.batch_id and story.story_code = value->>'story_code'
    )
  ) then
    raise exception 'results reference unknown story code';
  end if;

  v_model_label := coalesce(
    (v_job.model_snapshot->>'display_name') || ' / ' ||
    (v_job.model_snapshot->>'provider') || ' / ' ||
    (v_job.model_snapshot->>'model_name') || ' / DeepSeek Harness Agent',
    'ai-automation / DeepSeek Harness Agent'
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
    jsonb_build_object(
      'actual_branch', v_batch.default_branch,
      'execution_engine', 'deepseek-harness-acp',
      'commits', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'repository', repository_name,
          'sha', commit_sha,
          'subject', commit_subject
        ) order by repository_name), '[]'::jsonb)
        from public.analysis_repository_snapshot where job_id = p_job_id
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
      if v_snap_sha is null
         or coalesce(nullif(v_evidence->>'file_path', ''), '') = ''
         or (v_evidence->>'file_path') like '/%'
         or (v_evidence->>'file_path') like '%..%' then
        raise exception 'EVIDENCE_PATH_INVALID';
      end if;

      v_start := nullif(v_evidence->>'start_line', '')::integer;
      v_end := nullif(v_evidence->>'end_line', '')::integer;
      if (v_start is not null and v_start < 1)
         or (v_end is not null and v_end < 1)
         or (v_start is not null and v_end is not null and v_start > v_end) then
        raise exception 'EVIDENCE_LINE_INVALID';
      end if;

      select result.id into v_result_id
      from public.ai_review_result result
      join public.review_story story on story.id = result.story_id
      where result.ai_import_record_id = v_import_id
        and story.story_code = v_evidence->>'story_code';
      if v_result_id is null then
        raise exception 'evidence references story without result: %',
          v_evidence->>'story_code';
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

  select * into v_job from public.analysis_job where id = p_job_id for update;
  if v_job.id is null then
    raise exception 'job not found';
  end if;
  if v_job.execution_engine <> 'deepseek-harness-acp' then
    raise exception 'LEGACY_ENGINE_RETIRED';
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
-- 8. Worker 管理页：只存在代码准备 / Agent / 汇总三种阶段
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
      heartbeat.last_seen_at
    from public.analysis_worker_heartbeat heartbeat
    where heartbeat.last_seen_at >= now() - interval '20 seconds'
  ),
  raw_assignments as (
    select
      job.worker_id,
      'PREPARING'::text as phase,
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
      and job.execution_engine = 'deepseek-harness-acp'

    union all

    select
      task.worker_id,
      'AGENT'::text as phase,
      batch.id,
      batch.name,
      batch.week_code,
      batch.status,
      job.id,
      job.status,
      job.requested_branch,
      job.started_at,
      task.id,
      story.id,
      story.story_code,
      story.story_name,
      task.heartbeat_at,
      task.lease_expires_at
    from public.analysis_story_task task
    join online_workers worker on worker.worker_id = task.worker_id
    join public.analysis_job job on job.id = task.job_id
    join public.review_batch batch on batch.id = job.batch_id
    join public.review_story story on story.id = task.story_id
    where job.execution_engine = 'deepseek-harness-acp'
      and task.lease_expires_at >= now()
      and task.agent_status not in ('SUCCEEDED', 'FAILED')

    union all

    select
      job.finalizer_worker_id,
      'FINALIZING'::text,
      batch.id,
      batch.name,
      batch.week_code,
      batch.status,
      job.id,
      job.status,
      job.requested_branch,
      job.started_at,
      null::uuid,
      null::uuid,
      null::text,
      null::text,
      worker.last_seen_at,
      job.finalize_lease_expires_at
    from public.analysis_job job
    join online_workers worker on worker.worker_id = job.finalizer_worker_id
    join public.review_batch batch on batch.id = job.batch_id
    where job.status = 'FINALIZING'
      and job.execution_engine = 'deepseek-harness-acp'
      and job.finalize_lease_expires_at >= now()
  ),
  worker_assignments as (
    select
      assignment.worker_id,
      jsonb_agg(jsonb_build_object(
        'phase', assignment.phase,
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
      ) order by assignment.batch_name, assignment.story_code nulls first, assignment.phase)
        as assignments
    from raw_assignments assignment
    group by assignment.worker_id
  ),
  worker_rows as (
    select
      worker.worker_id,
      worker.slots,
      worker.reported_current_tasks,
      worker.last_seen_at,
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
      select jsonb_agg(jsonb_build_object(
        'worker_id', worker_id,
        'slots', slots,
        'reported_current_tasks', reported_current_tasks,
        'last_seen_at', last_seen_at,
        'online', true,
        'working', working,
        'assignments', assignments
      ) order by worker_id)
      from worker_rows
    ), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;

------------------------------------------------------------------------------
-- 9. 最小权限：Worker 仅 service_role；用户 API 维持原角色边界
------------------------------------------------------------------------------

revoke execute on function public.admin_create_model_config(
  uuid, text, text, text, text, uuid, integer, integer,
  integer, integer, integer, integer, integer
) from public, anon, authenticated;
grant execute on function public.admin_create_model_config(
  uuid, text, text, text, text, uuid, integer, integer,
  integer, integer, integer, integer, integer
) to service_role;

revoke execute on function public.admin_update_model_config(
  uuid, uuid, text, text, text, text, uuid, integer, integer,
  integer, integer, integer, integer, integer
) from public, anon, authenticated;
grant execute on function public.admin_update_model_config(
  uuid, uuid, text, text, text, text, uuid, integer, integer,
  integer, integer, integer, integer, integer
) to service_role;

revoke execute on function public.build_model_snapshot(uuid)
  from public, anon, authenticated;
revoke execute on function public.list_enabled_model_configs() from public, anon;
revoke execute on function public.admin_list_model_configs() from public, anon;
grant execute on function public.list_enabled_model_configs() to authenticated;
grant execute on function public.admin_list_model_configs() to authenticated;

revoke execute on function public.enqueue_analysis_job(uuid) from public, anon;
revoke execute on function public.retry_analysis_job(uuid) from public, anon;
grant execute on function public.enqueue_analysis_job(uuid) to authenticated;
grant execute on function public.retry_analysis_job(uuid) to authenticated;

revoke execute on function public.heartbeat_analysis_worker(text, integer, integer, jsonb)
  from public, anon, authenticated;
revoke execute on function public.claim_job_for_preparation(text, integer)
  from public, anon, authenticated;
revoke execute on function public.save_repository_snapshots(uuid, text, jsonb)
  from public, anon, authenticated;
revoke execute on function public.claim_next_story_task(text, integer)
  from public, anon, authenticated;
revoke execute on function public.heartbeat_story_task(uuid, text, uuid, integer)
  from public, anon, authenticated;
revoke execute on function public.get_model_secret_for_story_task(uuid, text, uuid)
  from public, anon, authenticated;
revoke execute on function public.save_agent_review_result(
  uuid, text, uuid, integer, jsonb, jsonb, jsonb, text, text, text
) from public, anon, authenticated;
revoke execute on function public.fail_agent_review(uuid, text, uuid, text, text)
  from public, anon, authenticated;
revoke execute on function public.claim_job_for_finalization(text, integer)
  from public, anon, authenticated;
revoke execute on function public.list_completed_story_tasks(uuid)
  from public, anon, authenticated;
revoke execute on function public.complete_analysis_job(uuid, text, jsonb, jsonb)
  from public, anon, authenticated;
revoke execute on function public.fail_claimed_analysis_job(uuid, text, text, text)
  from public, anon, authenticated;

grant execute on function public.heartbeat_analysis_worker(text, integer, integer, jsonb)
  to service_role;
grant execute on function public.claim_job_for_preparation(text, integer)
  to service_role;
grant execute on function public.save_repository_snapshots(uuid, text, jsonb)
  to service_role;
grant execute on function public.claim_next_story_task(text, integer)
  to service_role;
grant execute on function public.heartbeat_story_task(uuid, text, uuid, integer)
  to service_role;
grant execute on function public.get_model_secret_for_story_task(uuid, text, uuid)
  to service_role;
grant execute on function public.save_agent_review_result(
  uuid, text, uuid, integer, jsonb, jsonb, jsonb, text, text, text
) to service_role;
grant execute on function public.fail_agent_review(uuid, text, uuid, text, text)
  to service_role;
grant execute on function public.claim_job_for_finalization(text, integer)
  to service_role;
grant execute on function public.list_completed_story_tasks(uuid)
  to service_role;
grant execute on function public.complete_analysis_job(uuid, text, jsonb, jsonb)
  to service_role;
grant execute on function public.fail_claimed_analysis_job(uuid, text, text, text)
  to service_role;

revoke execute on function public.admin_list_analysis_workers() from public, anon;
grant execute on function public.admin_list_analysis_workers() to authenticated;

commit;
