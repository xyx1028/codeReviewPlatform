-- V1.31：将 Linky 冻结作为「开始分析」的首道服务端工序。
--
-- 浏览器只把尚未提交的选择暂存在会话中；真正的分析意图随导入单入库。
-- Worker 完成所有需求快照后，本迁移覆盖的 complete RPC 才会创建 Job，
-- 因而不存在 Job 读取半成品需求集合的窗口。

begin;

alter table public.linky_batch_import_request
  add column if not exists analysis_context_version integer,
  add column if not exists commit_window_days integer,
  add column if not exists analysis_status text not null default 'NOT_REQUESTED',
  add column if not exists analysis_job_id uuid references public.analysis_job(id) on delete set null,
  add column if not exists analysis_error_code text,
  add column if not exists analysis_error_message text;

-- 历史导入单没有自动启动意图；重复应用时明确修正旧行的空投影。
update public.linky_batch_import_request
set analysis_status = 'NOT_REQUESTED'
where analysis_status is null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.linky_batch_import_request'::regclass
      and conname = 'linky_batch_import_analysis_context_check'
  ) then
    alter table public.linky_batch_import_request
      add constraint linky_batch_import_analysis_context_check
      check (analysis_context_version is null or analysis_context_version in (1, 2));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.linky_batch_import_request'::regclass
      and conname = 'linky_batch_import_commit_window_check'
  ) then
    alter table public.linky_batch_import_request
      add constraint linky_batch_import_commit_window_check
      check (commit_window_days is null or commit_window_days in (7, 14, 21, 28));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.linky_batch_import_request'::regclass
      and conname = 'linky_batch_import_analysis_status_check'
  ) then
    alter table public.linky_batch_import_request
      add constraint linky_batch_import_analysis_status_check
      check (analysis_status in ('NOT_REQUESTED', 'PENDING', 'QUEUED', 'FAILED'));
  end if;
end;
$$;

comment on column public.linky_batch_import_request.analysis_context_version is
  'V1.31：非空表示此需求冻结完成后必须自动创建的分析上下文版本。';
comment on column public.linky_batch_import_request.commit_window_days is
  'V1.31：开始分析时冻结的精准提交分析窗口。';
comment on column public.linky_batch_import_request.analysis_status is
  'V1.31：自动分析编排状态；导入状态与分析状态故意分开，冻结成功不能被入队失败伪装成导入失败。';

-- 浏览器从 AI 结果管理页点「开始分析」时调用。选择范围由此刻冻结进导入单，
-- 完成后由 Worker/数据库继续，用户关闭或跳转页面不影响。
create or replace function public.request_linky_batch_import_for_analysis(
  p_batch_id uuid,
  p_workspace_name text,
  p_story_codes text[],
  p_workspace_id uuid default null,
  p_release_window text default null,
  p_commit_window_days integer default 21
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_batch public.review_batch;
  v_enabled boolean;
  v_secret uuid;
  v_request_id uuid;
begin
  perform public.ensure_manage_review_batch(p_batch_id);

  if p_commit_window_days not in (7, 14, 21, 28) then
    raise exception 'COMMIT_WINDOW_DAYS_INVALID';
  end if;

  -- 这些是开始分析的前置条件，而不是导入的前置条件；提前校验使用户不必等一次
  -- 内网导入之后才得知模型或分支不可用。
  select * into v_batch from public.review_batch where id = p_batch_id for update;
  if v_batch.id is null then raise exception 'batch not found'; end if;
  if v_batch.status = 'COMPLETED' then raise exception 'BATCH_READ_ONLY'; end if;
  if v_batch.default_branch is null
     or v_batch.default_branch not in ('feature_dev', 'feature_sit', 'release') then
    raise exception 'batch default_branch must be feature_dev, feature_sit, or release';
  end if;
  if v_batch.ai_model_config_id is null then raise exception 'batch has no model selected'; end if;
  if exists (select 1 from public.ai_import_record where batch_id = p_batch_id) then
    raise exception 'BATCH_READ_ONLY';
  end if;
  if exists (
    select 1 from public.analysis_job
    where batch_id = p_batch_id
      and status in ('QUEUED', 'PREPARING_CODE', 'PREPARING_SCOPE', 'PROCESSING', 'FINALIZING')
  ) then
    raise exception 'ACTIVE_JOB_EXISTS';
  end if;

  select enabled, api_key_secret_id into v_enabled, v_secret
  from public.ai_model_config where id = v_batch.ai_model_config_id;
  if v_enabled is null then raise exception 'model config not found'; end if;
  if not v_enabled then raise exception 'MODEL_CONFIG_DISABLED'; end if;
  if not public.model_config_has_api_key(v_secret) then raise exception 'MODEL_SECRET_MISSING'; end if;

  v_request_id := public.request_linky_batch_import(
    p_batch_id,
    p_workspace_name,
    p_story_codes,
    p_workspace_id,
    p_release_window
  );

  -- 同一批次的活动导入单具有幂等性。重复点「开始分析」只会复用同一张单，并冻结
  -- 第一次有效开始动作的分析窗口；不能让后一次点击悄悄改掉将来 Job 的范围。
  update public.linky_batch_import_request
  set analysis_context_version = coalesce(analysis_context_version, 2),
      commit_window_days = coalesce(commit_window_days, p_commit_window_days),
      analysis_status = case when analysis_status = 'QUEUED' then 'QUEUED' else 'PENDING' end,
      analysis_error_code = null,
      analysis_error_message = null,
      updated_at = now()
  where id = v_request_id;

  return v_request_id;
end;
$$;

-- 导入成功以后，只有持有当前 claim 的 Worker 才能进入这一段。创建 Job 前恢复
-- 原请求人的 JWT sub：既复用 enqueue 的完整权限/模型/规则/快照门禁，也让
-- analysis_job.requested_by 保持为真实操作人，而不是 Worker service-role。
create or replace function public.complete_linky_batch_import(
  p_request_id uuid,
  p_worker_id text,
  p_claim_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_request public.linky_batch_import_request;
  v_job_id uuid;
  v_error_code text;
  v_error_message text;
begin
  v_request := public.assert_linky_batch_import_claim(p_request_id, p_worker_id, p_claim_token);

  update public.linky_batch_import_request
  set status = 'SUCCEEDED',
      worker_id = null,
      lease_expires_at = null,
      heartbeat_at = null,
      claim_token_digest = null,
      finished_at = now(),
      updated_at = now()
  where id = p_request_id;

  -- 至少落了一条需求才推进批次状态：一条都没成功时 runner 会走 fail RPC，
  -- 所以这里不会给空批次创建 Job。
  if exists (select 1 from public.review_story where batch_id = v_request.batch_id) then
    update public.review_batch
    set status = 'WAITING_AI_RESULT', updated_at = now()
    where id = v_request.batch_id and status in ('DRAFT', 'WAITING_AI_RESULT');
  end if;

  if v_request.analysis_status = 'PENDING' then
    if v_request.requested_by is null then
      update public.linky_batch_import_request
      set analysis_status = 'FAILED',
          analysis_error_code = 'LINKY_ANALYSIS_REQUESTER_MISSING',
          analysis_error_message = '自动分析缺少原始请求人，未创建分析任务',
          updated_at = now()
      where id = p_request_id;
      return true;
    end if;

    begin
      perform set_config(
        'request.jwt.claims',
        json_build_object('sub', v_request.requested_by::text, 'role', 'authenticated')::text,
        true
      );
      v_job_id := public.enqueue_analysis_job_with_context(
        v_request.batch_id,
        coalesce(v_request.analysis_context_version, 2),
        coalesce(v_request.commit_window_days, 21)
      );

      update public.linky_batch_import_request
      set analysis_status = 'QUEUED',
          analysis_job_id = v_job_id,
          analysis_error_code = null,
          analysis_error_message = null,
          updated_at = now()
      where id = p_request_id;
    exception when others then
      get stacked diagnostics v_error_code = returned_sqlstate, v_error_message = message_text;
      update public.linky_batch_import_request
      set analysis_status = 'FAILED',
          analysis_error_code = left(coalesce(v_error_code, 'LINKY_ANALYSIS_ENQUEUE_FAILED'), 80),
          analysis_error_message = left(coalesce(v_error_message, '需求已冻结，但自动创建分析任务失败'), 300),
          updated_at = now()
      where id = p_request_id;
    end;
  end if;

  return true;
end;
$$;

revoke execute on function public.request_linky_batch_import_for_analysis(
  uuid, text, text[], uuid, text, integer
) from public, anon;
grant execute on function public.request_linky_batch_import_for_analysis(
  uuid, text, text[], uuid, text, integer
) to authenticated;

revoke execute on function public.complete_linky_batch_import(uuid, text, uuid)
  from public, anon, authenticated;
grant execute on function public.complete_linky_batch_import(uuid, text, uuid)
  to service_role;

commit;
