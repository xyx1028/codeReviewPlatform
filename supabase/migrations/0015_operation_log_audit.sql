begin;

------------------------------------------------------------------------------
-- 1. 扩展统一操作日志：对象快照 + 安全的模型字段差异
------------------------------------------------------------------------------

alter table public.batch_operation_log
  add column if not exists batch_name_snapshot text,
  add column if not exists batch_week_code_snapshot text,
  add column if not exists model_display_name_snapshot text,
  add column if not exists changed_fields text[],
  add column if not exists old_values jsonb,
  add column if not exists new_values jsonb,
  add column if not exists api_key_changed boolean not null default false;

alter table public.batch_operation_log
  drop constraint if exists batch_operation_log_action_check,
  drop constraint if exists batch_operation_log_event_shape_check,
  drop constraint if exists batch_operation_log_safe_values_check;

-- 为已有日志回填对象快照，后续对象删除/改名不影响历史审计语义。
update public.batch_operation_log operation_log
set
  batch_name_snapshot = batch.name,
  batch_week_code_snapshot = batch.week_code
from public.review_batch batch
where operation_log.batch_id = batch.id
  and (operation_log.batch_name_snapshot is null or operation_log.batch_week_code_snapshot is null);

update public.batch_operation_log operation_log
set model_display_name_snapshot = coalesce(
  operation_log.new_model_display_name,
  operation_log.old_model_display_name,
  model.display_name
)
from public.ai_model_config model
where operation_log.model_config_id = model.id
  and operation_log.model_display_name_snapshot is null;

-- 删除批次时保留日志；对象展示依赖上面的名称/周标识快照。
alter table public.batch_operation_log
  drop constraint if exists batch_operation_log_batch_id_fkey;

alter table public.batch_operation_log
  add constraint batch_operation_log_batch_id_fkey
  foreign key (batch_id) references public.review_batch(id) on delete set null;

alter table public.batch_operation_log
  add constraint batch_operation_log_action_check
  check (action in (
    'BATCH_CREATED', 'BATCH_DELETED', 'COMPLETE', 'REOPEN',
    'MODEL_DISPLAY_NAME_UPDATED', 'MODEL_CONFIG_CREATED', 'MODEL_CONFIG_UPDATED'
  ));

alter table public.batch_operation_log
  add constraint batch_operation_log_event_shape_check
  check (
    (
      action in ('BATCH_CREATED', 'BATCH_DELETED', 'COMPLETE', 'REOPEN')
      and batch_name_snapshot is not null
      and batch_week_code_snapshot is not null
      and model_config_id is null
      and old_model_display_name is null
      and new_model_display_name is null
      and changed_fields is null
      and old_values is null
      and new_values is null
      and api_key_changed = false
    )
    or
    (
      action = 'MODEL_DISPLAY_NAME_UPDATED'
      and batch_id is null
      and model_config_id is not null
      and model_display_name_snapshot is not null
      and old_model_display_name is not null
      and new_model_display_name is not null
      and old_model_display_name is distinct from new_model_display_name
      and changed_fields is null
      and old_values is null
      and new_values is null
      and api_key_changed = false
    )
    or
    (
      action = 'MODEL_CONFIG_CREATED'
      and batch_id is null
      and model_config_id is not null
      and model_display_name_snapshot is not null
      and changed_fields is not null
      and cardinality(changed_fields) > 0
      and old_values is null
      and jsonb_typeof(new_values) = 'object'
    )
    or
    (
      action = 'MODEL_CONFIG_UPDATED'
      and batch_id is null
      and model_config_id is not null
      and model_display_name_snapshot is not null
      and changed_fields is not null
      and cardinality(changed_fields) > 0
      and jsonb_typeof(old_values) = 'object'
      and jsonb_typeof(new_values) = 'object'
    )
  );

-- 模型审计 JSON 只允许显式白名单字段；API Key、Base URL、Secret ID 与令牌值均不得落库。
alter table public.batch_operation_log
  add constraint batch_operation_log_safe_values_check
  check (
    (coalesce(old_values, '{}'::jsonb) - array[
      'display_name', 'provider', 'model_name', 'max_parallel_tasks',
      'request_timeout_ms', 'retrieval_prompt_version', 'analysis_prompt_version', 'enabled'
    ]) = '{}'::jsonb
    and (coalesce(new_values, '{}'::jsonb) - array[
      'display_name', 'provider', 'model_name', 'max_parallel_tasks',
      'request_timeout_ms', 'retrieval_prompt_version', 'analysis_prompt_version', 'enabled'
    ]) = '{}'::jsonb
    and coalesce(changed_fields, array[]::text[]) <@ array[
      'display_name', 'provider', 'base_url', 'model_name', 'max_parallel_tasks',
      'request_timeout_ms', 'retrieval_prompt_version', 'analysis_prompt_version', 'enabled', 'api_key'
    ]::text[]
    and coalesce(jsonb_typeof(old_values -> 'display_name') = 'string', true)
    and coalesce(jsonb_typeof(old_values -> 'provider') = 'string', true)
    and coalesce(jsonb_typeof(old_values -> 'model_name') = 'string', true)
    and coalesce(jsonb_typeof(old_values -> 'max_parallel_tasks') = 'number', true)
    and coalesce(jsonb_typeof(old_values -> 'request_timeout_ms') = 'number', true)
    and coalesce(jsonb_typeof(old_values -> 'retrieval_prompt_version') = 'string', true)
    and coalesce(jsonb_typeof(old_values -> 'analysis_prompt_version') = 'string', true)
    and coalesce(jsonb_typeof(old_values -> 'enabled') = 'boolean', true)
    and coalesce(jsonb_typeof(new_values -> 'display_name') = 'string', true)
    and coalesce(jsonb_typeof(new_values -> 'provider') = 'string', true)
    and coalesce(jsonb_typeof(new_values -> 'model_name') = 'string', true)
    and coalesce(jsonb_typeof(new_values -> 'max_parallel_tasks') = 'number', true)
    and coalesce(jsonb_typeof(new_values -> 'request_timeout_ms') = 'number', true)
    and coalesce(jsonb_typeof(new_values -> 'retrieval_prompt_version') = 'string', true)
    and coalesce(jsonb_typeof(new_values -> 'analysis_prompt_version') = 'string', true)
    and coalesce(jsonb_typeof(new_values -> 'enabled') = 'boolean', true)
  );

create or replace function public.populate_operation_log_object_snapshot()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.batch_id is not null
    and (new.batch_name_snapshot is null or new.batch_week_code_snapshot is null) then
    select batch.name, batch.week_code
      into new.batch_name_snapshot, new.batch_week_code_snapshot
    from public.review_batch batch
    where batch.id = new.batch_id;
  end if;

  if new.model_config_id is not null and new.model_display_name_snapshot is null then
    select model.display_name into new.model_display_name_snapshot
    from public.ai_model_config model
    where model.id = new.model_config_id;
  end if;

  return new;
end;
$$;

drop trigger if exists populate_operation_log_object_snapshot on public.batch_operation_log;
create trigger populate_operation_log_object_snapshot
before insert on public.batch_operation_log
for each row execute function public.populate_operation_log_object_snapshot();

-- 批次日志所有登录用户可读；模型配置审计仅管理员可读。
drop policy if exists "authenticated read batch operation log" on public.batch_operation_log;
create policy "read permitted operation logs" on public.batch_operation_log
for select to authenticated using (
  action in ('BATCH_CREATED', 'BATCH_DELETED', 'COMPLETE', 'REOPEN')
  or public.is_admin()
);

------------------------------------------------------------------------------
-- 2. 批次创建/删除审计
------------------------------------------------------------------------------

create or replace function public.audit_review_batch_created()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.batch_operation_log (
    batch_id,
    action,
    batch_name_snapshot,
    batch_week_code_snapshot,
    performed_by
  ) values (
    new.id,
    'BATCH_CREATED',
    new.name,
    new.week_code,
    coalesce((select auth.uid()), new.created_by)
  );
  return new;
end;
$$;

drop trigger if exists audit_review_batch_created on public.review_batch;
create trigger audit_review_batch_created
after insert on public.review_batch
for each row execute function public.audit_review_batch_created();

create or replace function public.delete_review_batch(p_batch_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_batch public.review_batch;
begin
  perform public.ensure_manage_review_batch(p_batch_id);

  select * into v_batch
  from public.review_batch
  where id = p_batch_id
  for update;

  if v_batch.id is null then
    raise exception 'batch not found';
  end if;

  insert into public.batch_operation_log (
    batch_id,
    action,
    batch_name_snapshot,
    batch_week_code_snapshot,
    performed_by
  ) values (
    v_batch.id,
    'BATCH_DELETED',
    v_batch.name,
    v_batch.week_code,
    (select auth.uid())
  );

  delete from public.review_batch where id = p_batch_id;
end;
$$;

------------------------------------------------------------------------------
-- 3. 模型创建/配置更新/启停审计（与配置写入保持同一事务）
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
    max_parallel_tasks, request_timeout_ms,
    retrieval_prompt_version, analysis_prompt_version, created_by
  ) values (
    v_display_name, p_provider, v_base_url, v_model_name,
    p_api_key_secret_id, p_max_parallel_tasks, p_request_timeout_ms,
    p_retrieval_prompt_version, p_analysis_prompt_version, p_actor_id
  ) returning id into v_id;

  insert into public.batch_operation_log (
    batch_id,
    action,
    model_config_id,
    model_display_name_snapshot,
    changed_fields,
    new_values,
    api_key_changed,
    performed_by
  ) values (
    null,
    'MODEL_CONFIG_CREATED',
    v_id,
    v_display_name,
    array[
      'display_name', 'provider', 'base_url', 'model_name',
      'max_parallel_tasks', 'request_timeout_ms',
      'retrieval_prompt_version', 'analysis_prompt_version', 'api_key'
    ],
    jsonb_build_object(
      'display_name', v_display_name,
      'provider', p_provider,
      'model_name', v_model_name,
      'max_parallel_tasks', p_max_parallel_tasks,
      'request_timeout_ms', p_request_timeout_ms,
      'retrieval_prompt_version', p_retrieval_prompt_version,
      'analysis_prompt_version', p_analysis_prompt_version
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
  p_retrieval_prompt_version text default null,
  p_analysis_prompt_version text default null
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
    retrieval_prompt_version = coalesce(nullif(btrim(p_retrieval_prompt_version), ''), retrieval_prompt_version),
    analysis_prompt_version = coalesce(nullif(btrim(p_analysis_prompt_version), ''), analysis_prompt_version)
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
    v_old_values := v_old_values || jsonb_build_object('max_parallel_tasks', v_existing.max_parallel_tasks);
    v_new_values := v_new_values || jsonb_build_object('max_parallel_tasks', v_updated.max_parallel_tasks);
  end if;
  if v_existing.request_timeout_ms is distinct from v_updated.request_timeout_ms then
    v_changed_fields := array_append(v_changed_fields, 'request_timeout_ms');
    v_old_values := v_old_values || jsonb_build_object('request_timeout_ms', v_existing.request_timeout_ms);
    v_new_values := v_new_values || jsonb_build_object('request_timeout_ms', v_updated.request_timeout_ms);
  end if;
  if v_existing.retrieval_prompt_version is distinct from v_updated.retrieval_prompt_version then
    v_changed_fields := array_append(v_changed_fields, 'retrieval_prompt_version');
    v_old_values := v_old_values || jsonb_build_object('retrieval_prompt_version', v_existing.retrieval_prompt_version);
    v_new_values := v_new_values || jsonb_build_object('retrieval_prompt_version', v_updated.retrieval_prompt_version);
  end if;
  if v_existing.analysis_prompt_version is distinct from v_updated.analysis_prompt_version then
    v_changed_fields := array_append(v_changed_fields, 'analysis_prompt_version');
    v_old_values := v_old_values || jsonb_build_object('analysis_prompt_version', v_existing.analysis_prompt_version);
    v_new_values := v_new_values || jsonb_build_object('analysis_prompt_version', v_updated.analysis_prompt_version);
  end if;

  v_api_key_changed := p_new_api_key_secret_id is not null
    and p_new_api_key_secret_id is distinct from v_existing.api_key_secret_id;
  if v_api_key_changed then
    v_changed_fields := array_append(v_changed_fields, 'api_key');
  end if;

  if cardinality(v_changed_fields) > 0 then
    insert into public.batch_operation_log (
      batch_id,
      action,
      model_config_id,
      model_display_name_snapshot,
      changed_fields,
      old_values,
      new_values,
      api_key_changed,
      performed_by
    ) values (
      null,
      'MODEL_CONFIG_UPDATED',
      p_id,
      v_updated.display_name,
      v_changed_fields,
      v_old_values,
      v_new_values,
      v_api_key_changed,
      p_actor_id
    );
  end if;

  if v_api_key_changed then
    return v_existing.api_key_secret_id;
  end if;
  return null;
end;
$$;

create or replace function public.admin_set_model_enabled(p_id uuid, p_enabled boolean)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing public.ai_model_config;
  v_actor_id uuid := (select auth.uid());
begin
  perform public.ensure_admin();

  select * into v_existing
  from public.ai_model_config
  where id = p_id
  for update;

  if v_existing.id is null then
    raise exception 'model config not found';
  end if;

  if v_existing.enabled is distinct from p_enabled then
    update public.ai_model_config set enabled = p_enabled where id = p_id;

    insert into public.batch_operation_log (
      batch_id,
      action,
      model_config_id,
      model_display_name_snapshot,
      changed_fields,
      old_values,
      new_values,
      performed_by
    ) values (
      null,
      'MODEL_CONFIG_UPDATED',
      p_id,
      v_existing.display_name,
      array['enabled'],
      jsonb_build_object('enabled', v_existing.enabled),
      jsonb_build_object('enabled', p_enabled),
      v_actor_id
    );
  end if;

  return p_id;
end;
$$;

------------------------------------------------------------------------------
-- 4. 权限收敛
------------------------------------------------------------------------------

revoke execute on function public.populate_operation_log_object_snapshot() from public, anon, authenticated;
revoke execute on function public.audit_review_batch_created() from public, anon, authenticated;
revoke execute on function public.admin_create_model_config(uuid, text, text, text, text, uuid, integer, integer, text, text) from public, anon, authenticated;
revoke execute on function public.admin_update_model_config(uuid, uuid, text, text, text, text, uuid, integer, integer, text, text) from public, anon, authenticated;
revoke execute on function public.admin_set_model_enabled(uuid, boolean) from public, anon;
revoke execute on function public.delete_review_batch(uuid) from public, anon;

grant execute on function public.admin_create_model_config(uuid, text, text, text, text, uuid, integer, integer, text, text) to service_role;
grant execute on function public.admin_update_model_config(uuid, uuid, text, text, text, text, uuid, integer, integer, text, text) to service_role;
grant execute on function public.admin_set_model_enabled(uuid, boolean) to authenticated, service_role;
grant execute on function public.delete_review_batch(uuid) to authenticated;

commit;
