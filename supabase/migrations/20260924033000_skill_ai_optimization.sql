-- V1.19 技能AI优化：新表 + 认领/心跳/提交 RPC + 只读证据聚合 RPC。
--
-- 设计原则（详见「代码评审平台需求文档/V1.19-技能AI优化/最终执行方案.md」）：
--   1. 不新发明发布/哈希/不可变逻辑 —— AI 产出的内容最终仍要走既有的
--      review_skill_upload 校验管线（admin_register_skill_upload /
--      admin_record_skill_upload_validation / admin_publish_review_skill_version），
--      这里只新增「怎么产生一份待发布 upload」的前置流程。
--   2. 认领/心跳/提交 = 照抄本仓库现成的 claim_token + service_role 写回范式
--      （story task 系列 RPC），浏览器不能自报"AI 已生成成功"。
--   3. 同一技能同一时间只允许一条进行中任务：靠一个部分唯一索引在数据库层面保证，
--      不是靠应用层"先查再插"的竞态检查。

begin;

------------------------------------------------------------------------------
-- 1. 新表
------------------------------------------------------------------------------

create table if not exists public.skill_ai_optimization_request (
  id                 uuid primary key default gen_random_uuid(),
  skill_id           uuid not null references public.review_skill(id) on delete cascade,
  source_version_id  uuid not null references public.review_skill_version(id) on delete restrict,
  requested_by       uuid references auth.users(id) on delete set null,
  status             text not null default 'QUEUED'
    check (status in ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED')),
  worker_id          text,
  claim_token_digest text,
  lease_expires_at   timestamptz,
  heartbeat_at       timestamptz,
  result_upload_id   uuid references public.review_skill_upload(id) on delete set null,
  changed_paths      text[] not null default '{}'::text[],
  ai_summary         text,
  error_code         text,
  error_message      text,
  created_at         timestamptz not null default now(),
  started_at         timestamptz,
  finished_at        timestamptz
);

comment on table public.skill_ai_optimization_request is
  'V1.19: one row per "AI optimize this skill from its review history" attempt. '
  'Worker claims a QUEUED row, calls the model, repackages a ZIP with only the '
  'changed text files replaced, and pushes it through the existing '
  'review_skill_upload validation pipeline; this table only tracks task lifecycle, '
  'never file content.';

create index if not exists idx_skill_ai_optimization_request_skill
on public.skill_ai_optimization_request(skill_id, created_at desc);

create index if not exists idx_skill_ai_optimization_request_queue
on public.skill_ai_optimization_request(status, created_at)
where status = 'QUEUED';

-- 同一技能同一时间只允许一条进行中（QUEUED/RUNNING）的任务；
-- 由数据库唯一索引兜底，而不是应用层"先查再插"的竞态检查。
create unique index if not exists uq_skill_ai_optimization_inflight
on public.skill_ai_optimization_request(skill_id)
where status in ('QUEUED', 'RUNNING');

alter table public.skill_ai_optimization_request enable row level security;
-- 不开放任何 RLS 策略：这张表只通过下面的 security definer RPC 读写，
-- 直连 select/insert 一律被 RLS 拒绝（没有策略 = 默认拒绝）。

------------------------------------------------------------------------------
-- 2. 认领门禁辅助函数（照抄 assert_analysis_scope_task_claim 的模式）
------------------------------------------------------------------------------

create or replace function public.assert_skill_ai_optimization_claim(
  p_request_id uuid,
  p_worker_id text,
  p_claim_token uuid
)
returns public.skill_ai_optimization_request
language plpgsql
security definer
set search_path = public
as $$
declare
  v_request public.skill_ai_optimization_request;
begin
  select * into v_request
  from public.skill_ai_optimization_request
  where id = p_request_id
  for update;

  if v_request.id is null
     or v_request.status <> 'RUNNING'
     or v_request.worker_id is distinct from p_worker_id
     or v_request.lease_expires_at is null
     or v_request.lease_expires_at < now()
     or p_claim_token is null
     or v_request.claim_token_digest is distinct from public.agent_claim_token_digest(p_claim_token) then
    raise exception 'TASK_LEASE_LOST';
  end if;

  return v_request;
end;
$$;

revoke execute on function public.assert_skill_ai_optimization_claim(uuid, text, uuid)
  from public, anon, authenticated;
grant execute on function public.assert_skill_ai_optimization_claim(uuid, text, uuid) to service_role;

------------------------------------------------------------------------------
-- 3. 只读证据聚合（ADMIN 可见，authenticated + ensure_admin）
------------------------------------------------------------------------------

/*
 * 按技能聚合「历史评审证据」。
 *
 * 引用链路：analysis_job_skill_snapshot（哪个 Job 冻结过这个技能版本）
 *   → analysis_job.batch_id（那个 Job 属于哪个批次）
 *   → review_story / ai_import_record（那个批次里当前生效的一版 AI 结论）
 *   → ai_review_result（结论本体）→ human_review（人工复核，可能没有）。
 *
 * 只做统计与截断抽样，不返回代码证据（ai_code_evidence）或超出摘要长度的原文——
 * 这个 RPC 的消费者是「决定要不要优化」的管理员，不是重新做一次代码评审。
 */
create or replace function public.admin_get_skill_review_evidence(p_skill_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_skill public.review_skill;
  v_referenced_jobs integer;
  v_verdict jsonb;
  v_human jsonb;
  v_samples jsonb;
begin
  perform public.ensure_admin();

  select * into v_skill from public.review_skill where id = p_skill_id;
  if v_skill.id is null then
    raise exception 'SKILL_NOT_FOUND';
  end if;

  select count(distinct snapshot.job_id) into v_referenced_jobs
  from public.analysis_job_skill_snapshot snapshot
  where snapshot.source_skill_id = p_skill_id;

  with evidence as (
    select distinct
      result.id as result_id,
      story.story_code,
      result.verdict,
      result.summary,
      hr.result as human_result,
      hr.comment as human_comment
    from public.analysis_job_skill_snapshot snapshot
    join public.analysis_job job on job.id = snapshot.job_id
    join public.review_story story on story.batch_id = job.batch_id
    join public.ai_import_record air
      on air.batch_id = job.batch_id and air.is_active
    join public.ai_review_result result
      on result.story_id = story.id and result.ai_import_record_id = air.id
    left join public.human_review hr
      on hr.story_id = story.id and hr.ai_review_result_id = result.id
    where snapshot.source_skill_id = p_skill_id
  )
  select
    jsonb_build_object(
      'IMPLEMENTED', count(*) filter (where verdict = 'IMPLEMENTED'),
      'PARTIAL', count(*) filter (where verdict = 'PARTIAL'),
      'NOT_IMPLEMENTED', count(*) filter (where verdict = 'NOT_IMPLEMENTED'),
      'UNCERTAIN', count(*) filter (where verdict = 'UNCERTAIN')
    ),
    jsonb_build_object(
      'CORRECT', count(*) filter (where human_result = 'CORRECT'),
      'PARTIALLY_CORRECT', count(*) filter (where human_result = 'PARTIALLY_CORRECT'),
      'INCORRECT', count(*) filter (where human_result = 'INCORRECT'),
      'NEED_DISCUSSION', count(*) filter (where human_result = 'NEED_DISCUSSION')
    )
  into v_verdict, v_human
  from evidence;

  -- 抽样优先给"人工标了问题"的条目（错/部分对/需讨论），这才是对优化真正有用的信号；
  -- 不够 20 条时用其它结论补齐。
  select coalesce(jsonb_agg(row_data), '[]'::jsonb) into v_samples
  from (
    select jsonb_build_object(
      'story_code', story_code,
      'verdict', verdict,
      'summary', left(coalesce(summary, ''), 500),
      'human_review_result', human_result,
      'human_review_comment', case when human_comment is null then null else left(human_comment, 300) end
    ) as row_data
    from (
      select *,
        case when human_result in ('INCORRECT', 'PARTIALLY_CORRECT', 'NEED_DISCUSSION') then 0 else 1 end as priority
      from (
        select distinct
          result.id as result_id,
          story.story_code,
          result.verdict,
          result.summary,
          hr.result as human_result,
          hr.comment as human_comment
        from public.analysis_job_skill_snapshot snapshot
        join public.analysis_job job on job.id = snapshot.job_id
        join public.review_story story on story.batch_id = job.batch_id
        join public.ai_import_record air
          on air.batch_id = job.batch_id and air.is_active
        join public.ai_review_result result
          on result.story_id = story.id and result.ai_import_record_id = air.id
        left join public.human_review hr
          on hr.story_id = story.id and hr.ai_review_result_id = result.id
        where snapshot.source_skill_id = p_skill_id
      ) evidence_rows
    ) prioritized
    order by priority, story_code
    limit 20
  ) sampled;

  return jsonb_build_object(
    'skill_id', p_skill_id,
    'referenced_job_count', coalesce(v_referenced_jobs, 0),
    'verdict_counts', v_verdict,
    'human_review_counts', v_human,
    'sample_findings', v_samples
  );
end;
$$;

revoke execute on function public.admin_get_skill_review_evidence(uuid) from public, anon;
grant execute on function public.admin_get_skill_review_evidence(uuid) to authenticated, service_role;

------------------------------------------------------------------------------
-- 4. 入队 + 轮询（ADMIN，authenticated）
------------------------------------------------------------------------------

create or replace function public.skill_ai_optimization_request_to_jsonb(
  p_request public.skill_ai_optimization_request
)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'id', p_request.id,
    'skill_id', p_request.skill_id,
    'source_version_id', p_request.source_version_id,
    'status', p_request.status,
    'result_upload_id', p_request.result_upload_id,
    'changed_paths', to_jsonb(p_request.changed_paths),
    'ai_summary', p_request.ai_summary,
    'error_code', p_request.error_code,
    'error_message', p_request.error_message,
    'created_at', p_request.created_at,
    'started_at', p_request.started_at,
    'finished_at', p_request.finished_at
  );
$$;

/*
 * 入队是幂等的：技能已有一条进行中（QUEUED/RUNNING）的任务时，直接返回那一条，
 * 不创建第二条、也不报错——前端重复点「开始 AI 优化」或者关闭重开弹窗，
 * 看到的都是同一条任务，而不是"并发覆盖"或者"莫名其妙的冲突错误"。
 */
create or replace function public.admin_enqueue_skill_ai_optimization(p_skill_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_skill public.review_skill;
  v_existing public.skill_ai_optimization_request;
  v_evidence_count integer;
  v_new public.skill_ai_optimization_request;
begin
  perform public.ensure_admin();

  select * into v_skill from public.review_skill where id = p_skill_id for update;
  if v_skill.id is null then
    raise exception 'SKILL_NOT_FOUND';
  end if;
  if v_skill.current_version_id is null or v_skill.status <> 'PUBLISHED' then
    raise exception 'SKILL_NOT_PUBLISHED';
  end if;

  select * into v_existing
  from public.skill_ai_optimization_request
  where skill_id = p_skill_id and status in ('QUEUED', 'RUNNING')
  order by created_at desc
  limit 1;
  if v_existing.id is not null then
    return public.skill_ai_optimization_request_to_jsonb(v_existing);
  end if;

  select count(distinct snapshot.job_id) into v_evidence_count
  from public.analysis_job_skill_snapshot snapshot
  where snapshot.source_skill_id = p_skill_id;
  if coalesce(v_evidence_count, 0) = 0 then
    raise exception 'SKILL_OPTIMIZATION_NO_EVIDENCE';
  end if;

  insert into public.skill_ai_optimization_request (
    skill_id, source_version_id, requested_by, status
  ) values (
    p_skill_id, v_skill.current_version_id, auth.uid(), 'QUEUED'
  )
  returning * into v_new;

  return public.skill_ai_optimization_request_to_jsonb(v_new);
exception when unique_violation then
  -- 竞态兜底：两次几乎同时的点击都通过了上面的 select，唯一索引让其中一次插入失败。
  select * into v_existing
  from public.skill_ai_optimization_request
  where skill_id = p_skill_id and status in ('QUEUED', 'RUNNING')
  order by created_at desc
  limit 1;
  return public.skill_ai_optimization_request_to_jsonb(v_existing);
end;
$$;

revoke execute on function public.admin_enqueue_skill_ai_optimization(uuid) from public, anon;
grant execute on function public.admin_enqueue_skill_ai_optimization(uuid) to authenticated, service_role;

/*
 * 按技能查最近一条优化任务，供前端轮询与"刷新/重新打开弹窗后恢复状态"用。
 * 没有任何任务时返回 null，前端据此显示"还没有优化过"而不是报错。
 */
create or replace function public.admin_get_skill_ai_optimization_task(p_skill_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_request public.skill_ai_optimization_request;
begin
  perform public.ensure_admin();

  select * into v_request
  from public.skill_ai_optimization_request
  where skill_id = p_skill_id
  order by created_at desc
  limit 1;

  if v_request.id is null then
    return null;
  end if;
  return public.skill_ai_optimization_request_to_jsonb(v_request);
end;
$$;

revoke execute on function public.admin_get_skill_ai_optimization_task(uuid) from public, anon;
grant execute on function public.admin_get_skill_ai_optimization_task(uuid) to authenticated, service_role;

------------------------------------------------------------------------------
-- 5. Worker 认领 / 心跳 / 提交（service_role 专用）
------------------------------------------------------------------------------

/*
 * 认领一条 QUEUED 任务。
 *
 * 返回值里带上 Worker 后续要用的全部定位信息（技能名、当前发布版本的归档定位、
 * 请求人 id），这样 Worker 不需要再调用任何 authenticated-only 的 admin_* RPC——
 * 那些 RPC 靠 auth.uid() 判定身份，service_role 调用时 auth.uid() 是 null，会被
 * ensure_admin() 直接拒绝。claim_token 只在这次返回里出现一次，落库的只有它的摘要。
 */
create or replace function public.claim_next_skill_ai_optimization_task(p_worker_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_request public.skill_ai_optimization_request;
  v_version public.review_skill_version;
  v_skill public.review_skill;
  v_claim_token uuid;
begin
  if p_worker_id is null or btrim(p_worker_id) = '' then
    raise exception 'worker_id is required';
  end if;

  select * into v_request
  from public.skill_ai_optimization_request
  where status = 'QUEUED'
  order by created_at
  for update skip locked
  limit 1;

  if v_request.id is null then
    return null;
  end if;

  v_claim_token := gen_random_uuid();
  update public.skill_ai_optimization_request
  set status = 'RUNNING',
      worker_id = p_worker_id,
      claim_token_digest = public.agent_claim_token_digest(v_claim_token),
      lease_expires_at = now() + interval '10 minutes',
      heartbeat_at = now(),
      started_at = coalesce(started_at, now())
  where id = v_request.id
  returning * into v_request;

  select * into v_version from public.review_skill_version where id = v_request.source_version_id;
  select * into v_skill from public.review_skill where id = v_request.skill_id;
  if v_version.id is null or v_skill.id is null then
    -- 技能或版本在排队期间被删除（版本不可变删除受限，理论上不会发生；技能同理受
    -- Job 引用限制）。既然已经领到了任务，就把它标失败而不是让 Worker 拿到半份数据。
    update public.skill_ai_optimization_request
    set status = 'FAILED', error_code = 'SKILL_NOT_FOUND', finished_at = now()
    where id = v_request.id;
    return null;
  end if;

  return jsonb_build_object(
    'request_id', v_request.id,
    'worker_id', p_worker_id,
    'claim_token', v_claim_token,
    'skill_id', v_skill.id,
    'skill_name', v_skill.name,
    'requested_by', v_request.requested_by,
    'source_version_id', v_version.id,
    'source_version', v_version.version,
    'archive_bucket', v_version.archive_bucket,
    'archive_object_key', v_version.archive_object_key,
    'archive_sha256', v_version.archive_sha256
  );
end;
$$;

revoke execute on function public.claim_next_skill_ai_optimization_task(text)
  from public, anon, authenticated;
grant execute on function public.claim_next_skill_ai_optimization_task(text) to service_role;

create or replace function public.heartbeat_skill_ai_optimization_task(
  p_request_id uuid,
  p_worker_id text,
  p_claim_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.assert_skill_ai_optimization_claim(p_request_id, p_worker_id, p_claim_token);
  update public.skill_ai_optimization_request
  set lease_expires_at = now() + interval '10 minutes',
      heartbeat_at = now()
  where id = p_request_id;
  return true;
end;
$$;

revoke execute on function public.heartbeat_skill_ai_optimization_task(uuid, text, uuid)
  from public, anon, authenticated;
grant execute on function public.heartbeat_skill_ai_optimization_task(uuid, text, uuid) to service_role;

/*
 * 成功提交。upload_id 必须已经是 VALIDATED 状态、且属于同一个技能——
 * 这两条校验保证"提交成功"的前提是内容已经走过与人工上传完全相同的
 * fail-closed 校验，不存在"Worker 直接自报成功"的旁路。
 */
create or replace function public.submit_skill_ai_optimization_result(
  p_request_id uuid,
  p_worker_id text,
  p_claim_token uuid,
  p_upload_id uuid,
  p_changed_paths text[],
  p_ai_summary text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_request public.skill_ai_optimization_request;
  v_upload public.review_skill_upload;
begin
  v_request := public.assert_skill_ai_optimization_claim(p_request_id, p_worker_id, p_claim_token);

  select * into v_upload from public.review_skill_upload where id = p_upload_id;
  if v_upload.id is null or v_upload.skill_id <> v_request.skill_id then
    raise exception 'SKILL_OPTIMIZATION_UPLOAD_INVALID';
  end if;
  if v_upload.status <> 'VALIDATED' then
    raise exception 'SKILL_OPTIMIZATION_UPLOAD_INVALID';
  end if;
  if coalesce(array_length(p_changed_paths, 1), 0) = 0 then
    raise exception 'SKILL_OPTIMIZATION_UPLOAD_INVALID';
  end if;

  update public.skill_ai_optimization_request
  set status = 'SUCCEEDED',
      result_upload_id = p_upload_id,
      changed_paths = p_changed_paths,
      ai_summary = left(coalesce(p_ai_summary, ''), 4000),
      error_code = null,
      error_message = null,
      worker_id = null,
      claim_token_digest = null,
      lease_expires_at = null,
      finished_at = now()
  where id = p_request_id
  returning * into v_request;

  return public.skill_ai_optimization_request_to_jsonb(v_request);
end;
$$;

revoke execute on function public.submit_skill_ai_optimization_result(uuid, text, uuid, uuid, text[], text)
  from public, anon, authenticated;
grant execute on function public.submit_skill_ai_optimization_result(uuid, text, uuid, uuid, text[], text)
  to service_role;

create or replace function public.submit_skill_ai_optimization_failure(
  p_request_id uuid,
  p_worker_id text,
  p_claim_token uuid,
  p_error_code text,
  p_error_message text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_request public.skill_ai_optimization_request;
begin
  v_request := public.assert_skill_ai_optimization_claim(p_request_id, p_worker_id, p_claim_token);

  update public.skill_ai_optimization_request
  set status = 'FAILED',
      error_code = p_error_code,
      error_message = left(coalesce(p_error_message, ''), 500),
      worker_id = null,
      claim_token_digest = null,
      lease_expires_at = null,
      finished_at = now()
  where id = p_request_id
  returning * into v_request;

  return public.skill_ai_optimization_request_to_jsonb(v_request);
end;
$$;

revoke execute on function public.submit_skill_ai_optimization_failure(uuid, text, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.submit_skill_ai_optimization_failure(uuid, text, uuid, text, text)
  to service_role;

/*
 * 心跳超时回收：单租约即回收（不是"两次心跳都失联才回收"那一档更保守的策略）。
 *
 * 这类任务并发量天然很低（同一技能同一时间最多一条，触发方式又是管理员手动点击），
 * 不需要 story task 那一套为高并发抢占设计的两次确认机制；单租约超时直接回 QUEUED
 * 让下一个 Worker 重新认领，足够且更简单。
 */
create or replace function public.reclaim_stale_skill_ai_optimization_leases()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  with reclaimed as (
    update public.skill_ai_optimization_request
    set status = 'QUEUED',
        worker_id = null,
        claim_token_digest = null,
        lease_expires_at = null
    where status = 'RUNNING' and lease_expires_at < now()
    returning id
  )
  select count(*) into v_count from reclaimed;
  return coalesce(v_count, 0);
end;
$$;

revoke execute on function public.reclaim_stale_skill_ai_optimization_leases()
  from public, anon, authenticated;
grant execute on function public.reclaim_stale_skill_ai_optimization_leases() to service_role;

commit;
