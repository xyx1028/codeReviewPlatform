-- V1.32：自动分析的 Linky 需求准备失败后，允许原管理者安全重试同一张导入单。
-- 不复制需求范围：同一行保留项目组、窗口、分析上下文与原请求人，Worker claim 时再重置进度。

begin;

create or replace function public.retry_linky_batch_import_for_analysis(p_request_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_request public.linky_batch_import_request;
  v_batch public.review_batch;
  v_enabled boolean;
  v_secret uuid;
  v_active_request uuid;
begin
  select * into v_request
  from public.linky_batch_import_request
  where id = p_request_id
  for update;
  if v_request.id is null then raise exception 'LINKY_IMPORT_NOT_FOUND'; end if;

  perform public.ensure_manage_review_batch(v_request.batch_id);

  if v_request.status <> 'FAILED' then
    raise exception 'LINKY_IMPORT_RETRY_NOT_FAILED';
  end if;
  if v_request.analysis_context_version is null
     or v_request.commit_window_days is null
     or v_request.analysis_status <> 'PENDING' then
    raise exception 'LINKY_IMPORT_RETRY_NOT_AUTOMATIC';
  end if;

  -- 与首次“开始分析”使用相同的当前时刻门禁。失败时的授权、模型或密钥不应被重试沿用。
  select * into v_batch from public.review_batch where id = v_request.batch_id for update;
  if v_batch.id is null then raise exception 'batch not found'; end if;
  if v_batch.status = 'COMPLETED' then raise exception 'BATCH_READ_ONLY'; end if;
  if v_batch.default_branch is null
     or v_batch.default_branch not in ('feature_dev', 'feature_sit', 'release') then
    raise exception 'batch default_branch must be feature_dev, feature_sit, or release';
  end if;
  if v_batch.ai_model_config_id is null then raise exception 'batch has no model selected'; end if;
  if exists (select 1 from public.ai_import_record where batch_id = v_request.batch_id) then
    raise exception 'BATCH_READ_ONLY';
  end if;
  if exists (
    select 1 from public.analysis_job
    where batch_id = v_request.batch_id
      and status in ('QUEUED', 'PREPARING_CODE', 'PREPARING_SCOPE', 'PROCESSING', 'FINALIZING')
  ) then
    raise exception 'ACTIVE_JOB_EXISTS';
  end if;

  select enabled, api_key_secret_id into v_enabled, v_secret
  from public.ai_model_config where id = v_batch.ai_model_config_id;
  if v_enabled is null then raise exception 'model config not found'; end if;
  if not v_enabled then raise exception 'MODEL_CONFIG_DISABLED'; end if;
  if not public.model_config_has_api_key(v_secret) then raise exception 'MODEL_SECRET_MISSING'; end if;

  -- 与创建导入单的路径共用批次粒度锁，避免一个失败单重试时又并发创建另一张活动单。
  perform pg_advisory_xact_lock(hashtext('linky_batch_import:' || v_request.batch_id::text));
  select request.id into v_active_request
  from public.linky_batch_import_request request
  where request.batch_id = v_request.batch_id
    and request.id <> v_request.id
    and request.status in ('QUEUED', 'RUNNING')
  order by request.created_at desc
  limit 1;
  if v_active_request is not null then
    raise exception 'LINKY_IMPORT_RETRY_ACTIVE';
  end if;

  update public.linky_batch_import_request
  set status = 'QUEUED',
      worker_id = null,
      lease_expires_at = null,
      heartbeat_at = null,
      claim_token_digest = null,
      error_code = null,
      error_message = null,
      started_at = null,
      finished_at = null,
      updated_at = now()
  where id = v_request.id;

  return v_request.id;
end;
$$;

revoke execute on function public.retry_linky_batch_import_for_analysis(uuid) from public, anon;
grant execute on function public.retry_linky_batch_import_for_analysis(uuid) to authenticated;

commit;
