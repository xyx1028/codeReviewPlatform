-- 0021：允许管理员删除从未被批次或分析任务引用的模型配置。
-- 历史操作日志与 AI 导入记录保留，仅将模型外键置空；Vault 密钥由 Edge
-- Function 在数据库事务成功后清理。

begin;

-- 模型删除后仍保留审计日志和历史 AI 导入展示信息。
alter table public.batch_operation_log
  drop constraint if exists batch_operation_log_model_config_id_fkey;
alter table public.batch_operation_log
  add constraint batch_operation_log_model_config_id_fkey
  foreign key (model_config_id) references public.ai_model_config(id) on delete set null;

alter table public.ai_import_record
  drop constraint if exists ai_import_record_ai_model_config_id_fkey;
alter table public.ai_import_record
  add constraint ai_import_record_ai_model_config_id_fkey
  foreign key (ai_model_config_id) references public.ai_model_config(id) on delete set null;

-- 删除事件进入既有模型审计日志；模型对象删除后 model_config_id 会被置空，
-- model_display_name_snapshot 继续承担历史展示。
alter table public.batch_operation_log
  drop constraint if exists batch_operation_log_action_check,
  drop constraint if exists batch_operation_log_event_shape_check;

alter table public.batch_operation_log
  add constraint batch_operation_log_action_check
  check (action in (
    'BATCH_CREATED', 'BATCH_DELETED', 'COMPLETE', 'REOPEN',
    'MODEL_DISPLAY_NAME_UPDATED', 'MODEL_CONFIG_CREATED',
    'MODEL_CONFIG_UPDATED', 'MODEL_CONFIG_DELETED'
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
      and model_display_name_snapshot is not null
      and changed_fields is not null
      and cardinality(changed_fields) > 0
      and jsonb_typeof(old_values) = 'object'
      and jsonb_typeof(new_values) = 'object'
    )
    or
    (
      action = 'MODEL_CONFIG_DELETED'
      and batch_id is null
      and model_display_name_snapshot is not null
      and changed_fields is null
      and old_values is null
      and new_values is null
      and api_key_changed = false
    )
  );

create or replace function public.admin_delete_model_config(
  p_actor_id uuid,
  p_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing public.ai_model_config;
begin
  perform public.assert_actor_is_admin(p_actor_id);

  select * into v_existing
  from public.ai_model_config
  where id = p_id
  for update;

  if v_existing.id is null then
    raise exception 'MODEL_CONFIG_NOT_FOUND';
  end if;

  if exists (
    select 1 from public.review_batch batch where batch.ai_model_config_id = p_id
  ) or exists (
    select 1 from public.analysis_job job where job.model_config_id = p_id
  ) then
    raise exception 'MODEL_CONFIG_REFERENCED';
  end if;

  insert into public.batch_operation_log (
    batch_id,
    action,
    model_config_id,
    model_display_name_snapshot,
    performed_by
  ) values (
    null,
    'MODEL_CONFIG_DELETED',
    v_existing.id,
    v_existing.display_name,
    p_actor_id
  );

  delete from public.ai_model_config where id = p_id;
  return v_existing.api_key_secret_id;
end;
$$;

revoke execute on function public.admin_delete_model_config(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.admin_delete_model_config(uuid, uuid)
  to service_role;

commit;
