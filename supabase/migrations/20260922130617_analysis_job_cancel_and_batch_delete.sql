-- V1.15 分析任务停止与批次删除。
--
-- 解决两个线上缺口：
--
-- 1. 停不下来。界面上只有单个 attempt 的取消（request_analysis_attempt_cancel），
--    没有 Job 级停止；而且取消一个 attempt 之后，PENDING 的需求仍会被 Worker 继续领取。
--
-- 2. 删不掉。delete_review_batch 依赖级联删除，但级联里有多条 on delete restrict 边
--    （analysis_job_story_snapshot.story_id → review_story，candidate/verdict/access →
--    commit/candidate）。RESTRICT 是立即检查的，即使那些行在同一次级联里稍后也会被删掉，
--    删除仍然当场失败，用户看到的是原始外键报文。
--
-- 设计要点：
--   * 停止后 Job 立刻置为终态 FAILED + error_code='JOB_CANCELLED'。"不再被领取"必须立即
--     生效 —— claim_next_story_task 只领 status='PROCESSING'，否则收敛期间 PENDING 的需求
--     还会被抓走。刻意不新增 CANCELLED 状态：那会牵动 Worker 领取、finalizer 与监控台的
--     全部状态分支，而"被停止"用稳定错误码表达已经足够。
--   * 不清 task lease。让在途 attempt 走正常路径（heartbeat 读到 cancel_requested → abort →
--     fail_agent_review）收敛并写完审计，而不是制造一堆 TASK_LEASE_LOST。
--   * fail_agent_review 因此必须保留 Job 的取消原因：否则在途 attempt 收敛时会把
--     JOB_CANCELLED 覆盖成 AGENT_TREE_CANCELLED，界面上"人停的"就变成"Agent 挂了"。

------------------------------------------------------------------------------
-- 1. 取消意图列
------------------------------------------------------------------------------

alter table public.analysis_job
  add column if not exists cancel_requested_at timestamptz,
  add column if not exists cancel_requested_by uuid,
  add column if not exists cancel_reason text;

comment on column public.analysis_job.cancel_requested_at is
  'V1.15：用户停止该分析任务的时刻。非空表示终态原因是"被停止"，不是执行失败。';

------------------------------------------------------------------------------
-- 2. Job 级停止
------------------------------------------------------------------------------

create or replace function public.request_analysis_job_cancel(
  p_job_id uuid,
  p_reason text default 'USER_CANCELLED'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.analysis_job;
  v_reason text;
  v_cancelled integer := 0;
  v_actor uuid;
begin
  if p_job_id is null then raise exception 'job_id is required'; end if;
  -- 原因只接受稳定标识符，避免把任意文本写进审计列。
  v_reason := coalesce(nullif(btrim(p_reason), ''), 'USER_CANCELLED');
  if v_reason !~ '^[A-Z][A-Z0-9_]{2,63}$' then
    raise exception 'CANCEL_REASON_INVALID';
  end if;

  select * into v_job from public.analysis_job where id = p_job_id;
  if v_job.id is null then raise exception 'job not found'; end if;

  -- 授权默认拒绝，与 request_analysis_attempt_cancel 完全一致。
  if coalesce(auth.role(), '') = 'service_role' then
    null;
  elsif nullif(current_setting('request.jwt.claims', true), '') is null then
    raise exception 'authentication required';
  else
    perform public.ensure_manage_review_batch(v_job.batch_id);
  end if;

  perform pg_advisory_xact_lock(public.analysis_job_lock_key(p_job_id));
  select * into v_job from public.analysis_job where id = p_job_id for update;

  if v_job.status in ('SUCCEEDED', 'FAILED') then
    return jsonb_build_object(
      'job_id', v_job.id,
      'job_status', v_job.status,
      'already_terminal', true,
      'cancelled_attempts', 0
    );
  end if;

  v_actor := (select auth.uid());

  -- 给所有在跑的 attempt 发取消意图：Worker 在下一次 heartbeat_analysis_attempt
  -- 里读到 cancel_requested 后中止整棵 Agent Tree。
  with cancelled as (
    update public.analysis_agent_run
    set cancel_requested_at = coalesce(cancel_requested_at, now()),
        cancel_reason = coalesce(cancel_reason, v_reason)
    where job_id = p_job_id
      and status = 'RUNNING'
      and sealed_at is null
    returning 1
  )
  select count(*) into v_cancelled from cancelled;

  update public.analysis_job
  set cancel_requested_at = coalesce(cancel_requested_at, now()),
      cancel_requested_by = coalesce(cancel_requested_by, v_actor),
      cancel_reason = coalesce(cancel_reason, v_reason),
      status = 'FAILED',
      worker_id = null,
      locked_at = null,
      finalizer_worker_id = null,
      finalize_lease_expires_at = null,
      error_code = 'JOB_CANCELLED',
      error_message = '分析任务已被用户停止',
      finished_at = now()
  where id = p_job_id;

  return jsonb_build_object(
    'job_id', p_job_id,
    'job_status', 'FAILED',
    'already_terminal', false,
    'cancelled_attempts', v_cancelled
  );
end;
$$;

revoke execute on function public.request_analysis_job_cancel(uuid, text) from public, anon;
grant execute on function public.request_analysis_job_cancel(uuid, text) to authenticated, service_role;

------------------------------------------------------------------------------
-- 3. fail_agent_review：被停止的 Job 保留取消原因
--
-- 与 0027 的定义逐字相同，只改最后那条 update 的 error_code / error_message：
-- cancel_requested_at 非空时不覆盖，让"被停止"盖过单个 attempt 的失败码。
------------------------------------------------------------------------------

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
  v_run_id uuid;
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

  -- 顺序是 fence → 终止节点 → 落错误：反过来会给迟到的 child 留下写入窗口。
  update public.analysis_agent_run
  set status = 'FAILED',
      error_code = p_error_code,
      error_message = p_error_message,
      cancel_requested_at = coalesce(cancel_requested_at, now()),
      cancel_reason = coalesce(cancel_reason, p_error_code),
      sealed_at = coalesce(sealed_at, now()),
      session_revision = session_revision + 1,
      finished_at = now()
  where task_id = p_task_id
    and agent_attempt = v_attempt
    and status <> 'COMMITTED'
  returning id into v_run_id;

  if v_run_id is not null then
    update public.analysis_agent_node
    set status = 'CANCELLED',
        error_code = coalesce(error_code, p_error_code),
        cancelled_at = coalesce(cancelled_at, now()),
        finished_at = coalesce(finished_at, now())
    where agent_run_id = v_run_id
      and status = 'RUNNING';

    update public.analysis_session_checkpoint
    set status = 'SEALED'
    where agent_run_id = v_run_id and status = 'OPEN';
  end if;

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
      -- V1.15：被用户停止的 Job 不让 attempt 的失败码盖掉停止原因。
      error_code = case when cancel_requested_at is null then p_error_code else coalesce(error_code, p_error_code) end,
      error_message = case when cancel_requested_at is null then p_error_message else coalesce(error_message, p_error_message) end,
      finished_at = now()
  where id = v_job_id
    and status <> 'SUCCEEDED';
end;
$$;

------------------------------------------------------------------------------
-- 4. delete_review_batch：活动守卫 + 按依赖顺序清理
--
-- 与 0015 的定义相比新增两件事：活动分析任务时明确拒绝；删除批次前按依赖顺序清掉
-- V1.11 分析链里那些 on delete restrict 的行（它们的 RESTRICT 是为了防止单独删掉被
-- 冻结分析引用的需求/提交，这里是整批销毁，顺序删除即可，不需要放宽外键语义）。
------------------------------------------------------------------------------

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

  -- 运行中的任务不能直接删：Worker 正持有 lease 并会继续写入，删除会制造孤儿写入与
  -- 无法解释的失败。要求先停止（request_analysis_job_cancel）。
  if exists (
    select 1 from public.analysis_job
    where batch_id = p_batch_id
      and status in ('QUEUED', 'PREPARING_CODE', 'PREPARING_SCOPE', 'PROCESSING', 'FINALIZING')
  ) then
    raise exception 'BATCH_HAS_ACTIVE_ANALYSIS_JOB';
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

  -- 4.1 先删需求任务。append-only 的事实表（relevance_verdict / commit_access /
  -- scope_expansion / scope_decision_audit）只接受**级联**删除：它们的触发器在
  -- pg_trigger_depth() > 1 时放行，直接 delete 会被 APPEND_ONLY_RECORD_IMMUTABLE 拒绝。
  -- 删 task 同时带走 scope 与 candidate，于是后面删 commit 时再没有 RESTRICT 引用。
  delete from public.analysis_story_task
  where job_id in (select id from public.analysis_job where batch_id = p_batch_id);

  -- 4.2 其余 RESTRICT 引用 commit 的行（这两张表没有 append-only 触发器）
  delete from public.analysis_commit_diff_archive
  where job_id in (select id from public.analysis_job where batch_id = p_batch_id);

  delete from public.analysis_merge_request_commit
  where commit_id in (
    select commit.id from public.analysis_repository_commit commit
    join public.analysis_repository_snapshot snapshot on snapshot.id = commit.snapshot_id
    join public.analysis_job job on job.id = snapshot.job_id
    where job.batch_id = p_batch_id
  );

  -- 4.3 commit 行（analysis_commit_file 等剩余子表是 CASCADE）
  delete from public.analysis_repository_commit
  where snapshot_id in (
    select snapshot.id from public.analysis_repository_snapshot snapshot
    join public.analysis_job job on job.id = snapshot.job_id
    where job.batch_id = p_batch_id
  );

  -- 4.4 Job 整棵树（story/identity/skill 快照、repository snapshot、agent run 等都是 CASCADE）。
  -- 这一步同时解掉 analysis_job_story_snapshot.story_id → review_story 的 RESTRICT。
  delete from public.analysis_job where batch_id = p_batch_id;

  delete from public.review_batch where id = p_batch_id;
end;
$$;

revoke execute on function public.delete_review_batch(uuid) from public, anon;
grant execute on function public.delete_review_batch(uuid) to authenticated;
