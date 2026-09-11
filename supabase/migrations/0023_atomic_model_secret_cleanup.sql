-- 0023：模型配置与 Vault secret 原子删除。
-- 0022 的提交后清理在 Edge 进程失败时可能留下无法定位的 secret。本迁移将
-- secret 清理纳入同一数据库事务：任一步失败，模型配置和 secret 均回滚。

begin;

-- AI 导入历史仍遵循既有批次生命周期（删除批次时级联删除）。若存在异常的
-- 独立导入引用，继续由 FK 阻止模型删除，而不是静默解除审计关联。
alter table public.ai_import_record
  drop constraint if exists ai_import_record_ai_model_config_id_fkey;
alter table public.ai_import_record
  add constraint ai_import_record_ai_model_config_id_fkey
  foreign key (ai_model_config_id) references public.ai_model_config(id);

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

  if not public.admin_vault_delete_secret(v_existing.api_key_secret_id) then
    raise exception 'MODEL_SECRET_CLEANUP_FAILED';
  end if;

  delete from public.ai_model_config where id = p_id;
  return v_existing.id;
end;
$$;

revoke execute on function public.admin_delete_model_config(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.admin_delete_model_config(uuid, uuid)
  to service_role;

commit;
