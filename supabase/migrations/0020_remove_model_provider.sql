-- 0020：删除无业务作用的模型 Provider。
-- 0019 已将平台收敛为唯一的 DeepSeek Harness ACP 链路；所有模型端点均使用
-- OpenAI-compatible chat/completions，因此 Provider 不再表达任何行为差异。

begin;

-- 返回结构和函数体依赖 provider 列，先删除再按新契约重建。
drop function if exists public.list_enabled_model_configs();
drop function if exists public.admin_list_model_configs();
drop function if exists public.admin_create_model_config(
  uuid, text, text, text, text, uuid,
  integer, integer, integer, integer, integer, integer, integer
);
drop function if exists public.admin_update_model_config(
  uuid, uuid, text, text, text, text, uuid,
  integer, integer, integer, integer, integer, integer, integer
);

-- 配置被引用后仍禁止修改实际端点与模型名。
drop trigger if exists enforce_ai_model_config_immutable on public.ai_model_config;
create or replace function public.enforce_ai_model_config_immutable()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.base_url is distinct from old.base_url
     or new.model_name is distinct from old.model_name then
    if exists (select 1 from public.review_batch b where b.ai_model_config_id = old.id)
       or exists (select 1 from public.analysis_job j where j.model_config_id = old.id) then
      raise exception 'base_url/model_name are immutable once referenced by a batch';
    end if;
  end if;
  return new;
end;
$$;

create trigger enforce_ai_model_config_immutable
before update of base_url, model_name on public.ai_model_config
for each row execute function public.enforce_ai_model_config_immutable();

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

-- 清理已经冻结在批次/任务快照中的冗余键。
update public.review_batch
set ai_model_snapshot = ai_model_snapshot - 'provider'
where ai_model_snapshot ? 'provider';

update public.analysis_job
set model_snapshot = model_snapshot - 'provider'
where model_snapshot ? 'provider';

-- 0019 的完成函数很长，仅移除模型标签中的旧快照键；目标片段不存在时中止，
-- 防止迁移静默留下新任务标签退化为兜底值。
do $migration$
declare
  v_definition text;
  v_updated text;
  v_old text := E'    (v_job.model_snapshot->>''provider'') || '' / '' ||\n';
begin
  select pg_get_functiondef(
    'public.complete_analysis_job(uuid,text,jsonb,jsonb)'::regprocedure
  ) into v_definition;
  v_updated := replace(v_definition, v_old, '');
  if v_updated = v_definition then
    raise exception 'complete_analysis_job provider label fragment not found';
  end if;
  execute v_updated;
end;
$migration$;

alter table public.ai_model_config drop column provider;

create or replace function public.admin_create_model_config(
  p_actor_id uuid,
  p_display_name text,
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
    display_name, base_url, model_name, api_key_secret_id,
    max_parallel_tasks, request_timeout_ms, context_window, max_output_tokens,
    agent_max_model_requests, agent_max_retry_requests,
    agent_max_compaction_requests, created_by
  ) values (
    v_display_name, v_base_url, v_model_name, p_api_key_secret_id,
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
      'display_name', 'base_url', 'model_name', 'max_parallel_tasks',
      'request_timeout_ms', 'context_window', 'max_output_tokens',
      'agent_max_model_requests', 'agent_max_retry_requests',
      'agent_max_compaction_requests', 'api_key'
    ],
    jsonb_build_object(
      'display_name', v_display_name,
      'model_name', v_model_name,
      'max_parallel_tasks', p_max_parallel_tasks,
      'request_timeout_ms', p_request_timeout_ms,
      'context_window', p_context_window,
      'max_output_tokens', p_max_output_tokens,
      'agent_max_model_requests', p_agent_max_model_requests,
      'agent_max_retry_requests', p_agent_max_retry_requests,
      'agent_max_compaction_requests', p_agent_max_compaction_requests
    ),
    true, p_actor_id
  );

  return v_id;
end;
$$;

create or replace function public.admin_update_model_config(
  p_actor_id uuid,
  p_id uuid,
  p_display_name text default null,
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

  select * into v_existing from public.ai_model_config where id = p_id for update;
  if v_existing.id is null then
    raise exception 'model config not found';
  end if;

  v_referenced := exists (
    select 1 from public.review_batch batch where batch.ai_model_config_id = p_id
  ) or exists (
    select 1 from public.analysis_job job where job.model_config_id = p_id
  );

  if v_referenced and (
    (p_base_url is not null and btrim(p_base_url) <> v_existing.base_url)
    or (p_model_name is not null and btrim(p_model_name) <> v_existing.model_name)
  ) then
    raise exception 'base_url/model_name are immutable once referenced by a batch';
  end if;

  v_new_display_name := coalesce(nullif(btrim(p_display_name), ''), v_existing.display_name);

  update public.ai_model_config set
    display_name = v_new_display_name,
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
    v_old_values := v_old_values || jsonb_build_object('max_parallel_tasks', v_existing.max_parallel_tasks);
    v_new_values := v_new_values || jsonb_build_object('max_parallel_tasks', v_updated.max_parallel_tasks);
  end if;
  if v_existing.request_timeout_ms is distinct from v_updated.request_timeout_ms then
    v_changed_fields := array_append(v_changed_fields, 'request_timeout_ms');
    v_old_values := v_old_values || jsonb_build_object('request_timeout_ms', v_existing.request_timeout_ms);
    v_new_values := v_new_values || jsonb_build_object('request_timeout_ms', v_updated.request_timeout_ms);
  end if;
  if v_existing.context_window is distinct from v_updated.context_window then
    v_changed_fields := array_append(v_changed_fields, 'context_window');
    v_old_values := v_old_values || jsonb_build_object('context_window', v_existing.context_window);
    v_new_values := v_new_values || jsonb_build_object('context_window', v_updated.context_window);
  end if;
  if v_existing.max_output_tokens is distinct from v_updated.max_output_tokens then
    v_changed_fields := array_append(v_changed_fields, 'max_output_tokens');
    v_old_values := v_old_values || jsonb_build_object('max_output_tokens', v_existing.max_output_tokens);
    v_new_values := v_new_values || jsonb_build_object('max_output_tokens', v_updated.max_output_tokens);
  end if;
  if v_existing.agent_max_model_requests is distinct from v_updated.agent_max_model_requests then
    v_changed_fields := array_append(v_changed_fields, 'agent_max_model_requests');
    v_old_values := v_old_values || jsonb_build_object('agent_max_model_requests', v_existing.agent_max_model_requests);
    v_new_values := v_new_values || jsonb_build_object('agent_max_model_requests', v_updated.agent_max_model_requests);
  end if;
  if v_existing.agent_max_retry_requests is distinct from v_updated.agent_max_retry_requests then
    v_changed_fields := array_append(v_changed_fields, 'agent_max_retry_requests');
    v_old_values := v_old_values || jsonb_build_object('agent_max_retry_requests', v_existing.agent_max_retry_requests);
    v_new_values := v_new_values || jsonb_build_object('agent_max_retry_requests', v_updated.agent_max_retry_requests);
  end if;
  if v_existing.agent_max_compaction_requests is distinct from v_updated.agent_max_compaction_requests then
    v_changed_fields := array_append(v_changed_fields, 'agent_max_compaction_requests');
    v_old_values := v_old_values || jsonb_build_object('agent_max_compaction_requests', v_existing.agent_max_compaction_requests);
    v_new_values := v_new_values || jsonb_build_object('agent_max_compaction_requests', v_updated.agent_max_compaction_requests);
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

create or replace function public.list_enabled_model_configs()
returns table (
  id uuid,
  display_name text,
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
    cfg.id, cfg.display_name, cfg.base_url, cfg.model_name, cfg.enabled,
    public.model_config_has_api_key(cfg.api_key_secret_id),
    cfg.max_parallel_tasks, cfg.request_timeout_ms, cfg.created_at, cfg.updated_at
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
    cfg.id, cfg.display_name, cfg.base_url, cfg.model_name, cfg.enabled,
    public.model_config_has_api_key(cfg.api_key_secret_id),
    cfg.max_parallel_tasks, cfg.request_timeout_ms,
    cfg.context_window, cfg.max_output_tokens,
    cfg.agent_max_model_requests, cfg.agent_max_retry_requests,
    cfg.agent_max_compaction_requests,
    exists (select 1 from public.review_batch batch where batch.ai_model_config_id = cfg.id)
      or exists (select 1 from public.analysis_job job where job.model_config_id = cfg.id),
    cfg.created_by, cfg.created_at, cfg.updated_at
  from public.ai_model_config cfg
  order by cfg.created_at desc;
end;
$$;

revoke execute on function public.admin_create_model_config(
  uuid, text, text, text, uuid,
  integer, integer, integer, integer, integer, integer, integer
) from public, anon, authenticated;
grant execute on function public.admin_create_model_config(
  uuid, text, text, text, uuid,
  integer, integer, integer, integer, integer, integer, integer
) to service_role;

revoke execute on function public.admin_update_model_config(
  uuid, uuid, text, text, text, uuid,
  integer, integer, integer, integer, integer, integer, integer
) from public, anon, authenticated;
grant execute on function public.admin_update_model_config(
  uuid, uuid, text, text, text, uuid,
  integer, integer, integer, integer, integer, integer, integer
) to service_role;

revoke execute on function public.list_enabled_model_configs() from public, anon;
revoke execute on function public.admin_list_model_configs() from public, anon;
grant execute on function public.list_enabled_model_configs() to authenticated;
grant execute on function public.admin_list_model_configs() to authenticated;

commit;
