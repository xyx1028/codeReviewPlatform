begin;

------------------------------------------------------------------------------
-- 1. AI 报告关联稳定的模型配置 ID
--
-- ai_model 继续保留为执行时原始文本；页面展示名称优先按本列查询当前
-- ai_model_config.display_name。无法可靠识别的早期人工报告保持 null，禁止
-- 通过自由文本模糊关联，避免审计错配。
------------------------------------------------------------------------------

alter table public.ai_import_record
  add column if not exists ai_model_config_id uuid references public.ai_model_config(id);

create index if not exists idx_ai_import_record_model_config
on public.ai_import_record(ai_model_config_id);

-- 避免受控回填触发 touch_updated_at，保留历史报告原始更新时间。
alter table public.ai_import_record disable trigger touch_ai_import_record_updated_at;

-- 优先从批次的稳定模型关联回填历史报告。
update public.ai_import_record import_record
set ai_model_config_id = batch.ai_model_config_id
from public.review_batch batch
where import_record.batch_id = batch.id
  and import_record.ai_model_config_id is null
  and batch.ai_model_config_id is not null;

-- 自动任务可作为第二个可靠来源；同一批次开始任务后模型不可变。
update public.ai_import_record import_record
set ai_model_config_id = job.model_config_id
from public.analysis_job job
where import_record.batch_id = job.batch_id
  and import_record.ai_model_config_id is null
  and job.model_config_id is not null;

alter table public.ai_import_record enable trigger touch_ai_import_record_updated_at;

-- 所有后续人工导入和自动分析结果都由数据库从批次补齐模型 ID，调用方
-- 无需也不能通过导入文件指定另一个模型配置。
create or replace function public.populate_ai_import_model_config_id()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_batch_model_config_id uuid;
begin
  select batch.ai_model_config_id into v_batch_model_config_id
  from public.review_batch batch
  where batch.id = new.batch_id;

  if new.ai_model_config_id is not null
    and new.ai_model_config_id is distinct from v_batch_model_config_id then
    raise exception 'AI import model must match the batch model';
  end if;

  -- 关联只能由批次模型派生；批次未配置模型时必须保持 null。
  new.ai_model_config_id := v_batch_model_config_id;

  return new;
end;
$$;

drop trigger if exists populate_ai_import_model_config_id on public.ai_import_record;
create trigger populate_ai_import_model_config_id
before insert or update of batch_id, ai_model_config_id on public.ai_import_record
for each row execute function public.populate_ai_import_model_config_id();

------------------------------------------------------------------------------
-- 2. 安全的当前模型名称查询
--
-- 包含停用模型，确保历史记录仍能显示当前名称；只返回 ID 和展示名称，
-- 不暴露 base_url、API Key、Vault secret UUID 或其他模型配置。
------------------------------------------------------------------------------

create or replace function public.list_model_display_names()
returns table (
  id uuid,
  display_name text
)
language sql
security definer
set search_path = public
stable
as $$
  select config.id, config.display_name
  from public.ai_model_config config
  order by config.display_name, config.id;
$$;

revoke execute on function public.list_model_display_names() from public, anon;
grant execute on function public.list_model_display_names() to authenticated;

------------------------------------------------------------------------------
-- 3. 扩展现有操作日志以支持全局模型名称修改事件
------------------------------------------------------------------------------

alter table public.batch_operation_log
  alter column batch_id drop not null,
  add column if not exists model_config_id uuid references public.ai_model_config(id),
  add column if not exists old_model_display_name text,
  add column if not exists new_model_display_name text,
  add column if not exists performed_by_display_name text;

alter table public.batch_operation_log
  drop constraint if exists batch_operation_log_action_check;

alter table public.batch_operation_log
  add constraint batch_operation_log_action_check
  check (action in ('COMPLETE', 'REOPEN', 'MODEL_DISPLAY_NAME_UPDATED'));

alter table public.batch_operation_log
  add constraint batch_operation_log_event_shape_check
  check (
    (
      action in ('COMPLETE', 'REOPEN')
      and batch_id is not null
      and model_config_id is null
      and old_model_display_name is null
      and new_model_display_name is null
    )
    or
    (
      action = 'MODEL_DISPLAY_NAME_UPDATED'
      and batch_id is null
      and model_config_id is not null
      and old_model_display_name is not null
      and new_model_display_name is not null
      and old_model_display_name is distinct from new_model_display_name
    )
  );

create index if not exists idx_batch_operation_log_model_config
on public.batch_operation_log(model_config_id)
where model_config_id is not null;

-- 保存操作发生时的操作者名称，避免用户后续改名影响历史审计展示。
update public.batch_operation_log operation_log
set performed_by_display_name = profile.display_name
from public.user_profile profile
where operation_log.performed_by = profile.id
  and operation_log.performed_by_display_name is null;

create or replace function public.populate_operation_log_actor_name()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.performed_by_display_name is null and new.performed_by is not null then
    select profile.display_name into new.performed_by_display_name
    from public.user_profile profile
    where profile.id = new.performed_by;
  end if;
  return new;
end;
$$;

drop trigger if exists populate_operation_log_actor_name on public.batch_operation_log;
create trigger populate_operation_log_actor_name
before insert on public.batch_operation_log
for each row execute function public.populate_operation_log_actor_name();

------------------------------------------------------------------------------
-- 4. 模型更新与名称审计在同一个数据库事务内完成
------------------------------------------------------------------------------

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
  v_referenced boolean;
  v_new_display_name text;
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

  -- 已被引用后，Provider / Base URL / Model 不可变（保证审计可追溯）。
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
  where id = p_id;

  if v_new_display_name is distinct from v_existing.display_name then
    insert into public.batch_operation_log (
      batch_id,
      action,
      model_config_id,
      old_model_display_name,
      new_model_display_name,
      performed_by
    ) values (
      null,
      'MODEL_DISPLAY_NAME_UPDATED',
      p_id,
      v_existing.display_name,
      v_new_display_name,
      p_actor_id
    );
  end if;

  -- 保持原调用协议：轮换 Key 时返回旧 secret UUID 给 Edge Function 清理。
  -- 该 UUID 不写入任何操作日志。
  if p_new_api_key_secret_id is not null
    and p_new_api_key_secret_id <> v_existing.api_key_secret_id then
    return v_existing.api_key_secret_id;
  end if;
  return null;
end;
$$;

-- 新增触发器函数不对客户端开放；模型更新 RPC 仍仅允许 service_role 调用。
revoke execute on function public.populate_ai_import_model_config_id() from public, anon, authenticated;
revoke execute on function public.populate_operation_log_actor_name() from public, anon, authenticated;
revoke execute on function public.admin_update_model_config(uuid, uuid, text, text, text, text, uuid, integer, integer, text, text) from public, anon, authenticated;
grant execute on function public.admin_update_model_config(uuid, uuid, text, text, text, text, uuid, integer, integer, text, text) to service_role;

commit;
