-- V1.19 技能AI优化（第三段）：证据里列出任务批次、记录模型自检重写次数、
-- diff 取数带上"这份草稿含不含脚本"。
--
-- 三件事都来自同一次产品反馈：
--
--   1. **列出任务批次。** 原来只给"被 N 个 Job 引用过"。Job id 对管理员没有意义 ——
--      他记得的是"第 39 周那个批次评得不准"。不给批次，他就没法判断这些证据来自哪一轮评审、
--      更没法回到那个批次去看原始结论。
--   2. **记录重写次数。** AI 改完必须过一次结构自检，不通过要让它自己改。既然重写会真实
--      发生，就必须能看见发生了几次 —— 一个"第 3 次才过"的结果和"一次就过"的结果，
--      管理员对它的信任程度不一样。
--   3. **草稿含不含脚本。** 白名单放开到整包之后，模型可以新增 `scripts/` 下的文件。
--      这类版本发布时必须额外确认（`SKILL_SCRIPTS_NOT_ACKNOWLEDGED` 是既有门禁），
--      所以前端必须**在点发布之前**就知道，而不是被一个错误码挡住才知道。

begin;

------------------------------------------------------------------------------
-- 0. 重申 20260924034553 里的两条硬约束（幂等）
--
-- 为什么要在这里再写一遍：那个文件在本地开发过程中被修订过几次（补表级 revoke、把两个外键
-- 从 restrict 改成 cascade/set null），而云端可能在任意一次修订之间就被 push 过去了。
-- 迁移是"已经发生过的事实"，事后改文件不会让已应用它的环境重新执行 —— 唯一可靠的收敛方式是
-- 在**新**迁移里重申一次。两条语句都幂等，已经是目标状态时什么都不做。
--
-- 具体后果各自很明确：
--   * 少了 revoke：`authenticated` 仍持有这张队列表的表级 select/insert（RLS 无策略仍然拦得住
--     行，但"连表都碰不到"这条断言会失败，可审计性下降）；
--   * FK 留 restrict：一个**曾经被 AI 优化过**的技能再也删不掉，报的还是裸外键错误。
------------------------------------------------------------------------------

revoke all on table public.skill_ai_optimization_request from public, anon, authenticated;

alter table public.skill_ai_optimization_request
  drop constraint if exists skill_ai_optimization_request_source_version_id_fkey,
  add constraint skill_ai_optimization_request_source_version_id_fkey
    foreign key (source_version_id) references public.review_skill_version(id) on delete cascade;

alter table public.skill_ai_optimization_request
  drop constraint if exists skill_ai_optimization_request_model_config_id_fkey,
  add constraint skill_ai_optimization_request_model_config_id_fkey
    foreign key (model_config_id) references public.ai_model_config(id) on delete set null;

/*
 * 同理重申入队时的**模型选择规则**。
 *
 * 它在 20260924034553 里被修订过一次：从"随便挑一个启用的配置"改成"产出这些证据的那个模型"
 * （引用过该技能的最近一个 Job 所用的模型配置）。差别不是风格问题 —— 前者会随着管理员
 * 新增/停用配置悄悄换模型，于是同一技能两次优化结果失去可比性，而这次优化的输入恰恰是
 * 那些 Job 产出的评审结论。
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
  v_model public.ai_model_config;
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

  select cfg.* into v_model
  from public.analysis_job_skill_snapshot snapshot
  join public.analysis_job job on job.id = snapshot.job_id
  join public.ai_model_config cfg on cfg.id = job.model_config_id
  where snapshot.source_skill_id = p_skill_id and cfg.enabled
  order by job.created_at desc, job.id desc
  limit 1;
  if v_model.id is null then
    -- 那个模型被停用了：退回最早创建的启用配置（确定性优先于"最新"）。
    select * into v_model
    from public.ai_model_config
    where enabled
    order by created_at, id
    limit 1;
  end if;
  if v_model.id is null then
    raise exception 'MODEL_CONFIG_NOT_FOUND';
  end if;
  if not public.model_config_has_api_key(v_model.api_key_secret_id) then
    raise exception 'MODEL_SECRET_MISSING';
  end if;

  insert into public.skill_ai_optimization_request (
    skill_id, source_version_id, requested_by, status,
    model_config_id, base_url_snapshot, model_name_snapshot,
    request_timeout_ms_snapshot, network_access_mode_snapshot
  ) values (
    p_skill_id, v_skill.current_version_id, auth.uid(), 'QUEUED',
    v_model.id, v_model.base_url, v_model.model_name,
    v_model.request_timeout_ms, v_model.network_access_mode
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

------------------------------------------------------------------------------
-- 1. 模型重写次数
------------------------------------------------------------------------------

alter table public.skill_ai_optimization_request
  add column if not exists model_attempts integer not null default 0;

comment on column public.skill_ai_optimization_request.model_attempts is
  'V1.19: how many times the model was called for this request, including rewrites '
  'triggered by a failed structure self-check. 1 = accepted on the first try.';

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
    'model_attempts', p_request.model_attempts,
    'error_code', p_request.error_code,
    'error_message', p_request.error_message,
    'created_at', p_request.created_at,
    'started_at', p_request.started_at,
    'finished_at', p_request.finished_at
  );
$$;

------------------------------------------------------------------------------
-- 2. 提交类 RPC 加 p_model_attempts
--
-- 加参数**必须**先 drop 旧签名：`create or replace` 改不了签名，它会留下一个旧重载，
-- 而那条旧路径会把 model_attempts 永远停在 0。
------------------------------------------------------------------------------

drop function if exists public.submit_skill_ai_optimization_result(
  uuid, text, uuid, uuid, text[], text
);

create or replace function public.submit_skill_ai_optimization_result(
  p_request_id uuid,
  p_worker_id text,
  p_claim_token uuid,
  p_upload_id uuid,
  p_changed_paths text[],
  p_ai_summary text,
  p_model_attempts integer default 1
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
  -- VALIDATED 是"已经走过与人工上传完全相同的 fail-closed 校验"的唯一证明。
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
      model_attempts = greatest(coalesce(p_model_attempts, 1), 1),
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

revoke execute on function public.submit_skill_ai_optimization_result(
  uuid, text, uuid, uuid, text[], text, integer
) from public, anon, authenticated;
grant execute on function public.submit_skill_ai_optimization_result(
  uuid, text, uuid, uuid, text[], text, integer
) to service_role;

drop function if exists public.submit_skill_ai_optimization_failure(
  uuid, text, uuid, text, text
);

create or replace function public.submit_skill_ai_optimization_failure(
  p_request_id uuid,
  p_worker_id text,
  p_claim_token uuid,
  p_error_code text,
  p_error_message text,
  p_model_attempts integer default 0
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
      model_attempts = greatest(coalesce(p_model_attempts, 0), 0),
      worker_id = null,
      claim_token_digest = null,
      lease_expires_at = null,
      finished_at = now()
  where id = p_request_id
  returning * into v_request;

  return public.skill_ai_optimization_request_to_jsonb(v_request);
end;
$$;

revoke execute on function public.submit_skill_ai_optimization_failure(
  uuid, text, uuid, text, text, integer
) from public, anon, authenticated;
grant execute on function public.submit_skill_ai_optimization_failure(
  uuid, text, uuid, text, text, integer
) to service_role;

------------------------------------------------------------------------------
-- 3. 证据聚合：加 referenced_batches
--
-- 一个技能可能被同一批次的多个 Job 引用（重跑），所以按 (batch, job) 列出并带上 Job 的
-- 创建时间与状态：管理员要区分"这是那次失败的重跑"还是"那是当时真正的评审"。
------------------------------------------------------------------------------

create or replace function public.skill_review_evidence_batches(p_skill_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(row_data order by job_created_at desc nulls last, batch_name), '[]'::jsonb)
  from (
    select
      jsonb_build_object(
        'batch_id', batch.id,
        'batch_name', batch.name,
        'week_code', batch.week_code,
        'job_id', job.id,
        'job_status', job.status,
        'job_created_at', job.created_at,
        'skill_version', snapshot.source_version,
        'result_count', (
          select count(*)
          from public.review_story story
          join public.ai_import_record air
            on air.batch_id = story.batch_id and air.is_active
          join public.ai_review_result result
            on result.story_id = story.id and result.ai_import_record_id = air.id
          where story.batch_id = batch.id
        )
      ) as row_data,
      batch.name as batch_name,
      job.created_at as job_created_at
    from public.analysis_job_skill_snapshot snapshot
    join public.analysis_job job on job.id = snapshot.job_id
    join public.review_batch batch on batch.id = job.batch_id
    where snapshot.source_skill_id = p_skill_id
  ) rows;
$$;

comment on function public.skill_review_evidence_batches(uuid) is
  'V1.19: which review batches (and which job inside them) froze this skill. Job ids mean '
  'nothing to an administrator; batch name + week code is what he remembers.';

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
    ),
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'story_code', story_code,
          'verdict', verdict,
          'summary', left(coalesce(summary, ''), 500),
          'human_review_result', human_result,
          'human_review_comment',
            case when human_comment is null then null else left(human_comment, 300) end
        )
        order by
          case when human_result in ('INCORRECT', 'PARTIALLY_CORRECT', 'NEED_DISCUSSION')
            then 0 else 1 end,
          story_code
      ),
      '[]'::jsonb
    )
  into v_verdict, v_human, v_samples
  from evidence;

  return jsonb_build_object(
    'skill_id', p_skill_id,
    'referenced_job_count', coalesce(v_referenced_jobs, 0),
    'referenced_batches', public.skill_review_evidence_batches(p_skill_id),
    'verdict_counts', v_verdict,
    'human_review_counts', v_human,
    'sample_findings', (
      select coalesce(jsonb_agg(item), '[]'::jsonb)
      from (
        select item from jsonb_array_elements(coalesce(v_samples, '[]'::jsonb)) as item limit 20
      ) capped
    )
  );
end;
$$;

revoke execute on function public.admin_get_skill_review_evidence(uuid) from public, anon;
grant execute on function public.admin_get_skill_review_evidence(uuid) to authenticated, service_role;

/*
 * Worker 侧同口径。
 *
 * 它与上面那个函数必须返回**同一份数字**（门禁不同而已）：管理员在页面上看到的证据与模型
 * 看到的分叉时，"AI 依据这些证据改的"这句话就无从核对。所以批次也一并给模型 —— 提示词里
 * 会渲染成"这些 Job 属于以下评审批次"。
 */
create or replace function public.get_skill_review_evidence_for_optimization(
  p_request_id uuid,
  p_worker_id text,
  p_claim_token uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_request public.skill_ai_optimization_request;
  v_referenced_jobs integer;
  v_verdict jsonb;
  v_human jsonb;
  v_samples jsonb;
begin
  v_request := public.assert_skill_ai_optimization_claim(p_request_id, p_worker_id, p_claim_token);

  select count(distinct snapshot.job_id) into v_referenced_jobs
  from public.analysis_job_skill_snapshot snapshot
  where snapshot.source_skill_id = v_request.skill_id;

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
    where snapshot.source_skill_id = v_request.skill_id
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
    ),
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'story_code', story_code,
          'verdict', verdict,
          'summary', left(coalesce(summary, ''), 500),
          'human_review_result', human_result,
          'human_review_comment',
            case when human_comment is null then null else left(human_comment, 300) end
        )
        order by
          case when human_result in ('INCORRECT', 'PARTIALLY_CORRECT', 'NEED_DISCUSSION')
            then 0 else 1 end,
          story_code
      ),
      '[]'::jsonb
    )
  into v_verdict, v_human, v_samples
  from evidence;

  return jsonb_build_object(
    'skill_id', v_request.skill_id,
    'referenced_job_count', coalesce(v_referenced_jobs, 0),
    'referenced_batches', public.skill_review_evidence_batches(v_request.skill_id),
    'verdict_counts', v_verdict,
    'human_review_counts', v_human,
    'sample_findings', (
      select coalesce(jsonb_agg(item), '[]'::jsonb)
      from (
        select item from jsonb_array_elements(coalesce(v_samples, '[]'::jsonb)) as item limit 20
      ) capped
    )
  );
end;
$$;

revoke execute on function public.get_skill_review_evidence_for_optimization(uuid, text, uuid)
  from public, anon, authenticated;
grant execute on function public.get_skill_review_evidence_for_optimization(uuid, text, uuid)
  to service_role;

------------------------------------------------------------------------------
-- 4. diff 取数：带上 contains_scripts 与 model_attempts
--
-- 白名单放开到整包之后模型可以新增 `scripts/` 下的文件。这类版本发布时必须显式确认
-- （`SKILL_SCRIPTS_NOT_ACKNOWLEDGED`），所以前端必须**在点发布之前**就知道，而不是撞上
-- 一个错误码才知道。
------------------------------------------------------------------------------

create or replace function public.admin_get_skill_optimization_diff_sources(
  p_actor_id uuid,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_request public.skill_ai_optimization_request;
  v_skill public.review_skill;
  v_version public.review_skill_version;
  v_upload public.review_skill_upload;
begin
  perform public.assert_actor_is_admin(p_actor_id);

  select * into v_request from public.skill_ai_optimization_request where id = p_request_id;
  if v_request.id is null then
    raise exception 'SKILL_OPTIMIZATION_NOT_FOUND';
  end if;
  if v_request.status <> 'SUCCEEDED' or v_request.result_upload_id is null then
    raise exception 'SKILL_OPTIMIZATION_NOT_READY';
  end if;

  select * into v_skill from public.review_skill where id = v_request.skill_id;
  select * into v_version from public.review_skill_version where id = v_request.source_version_id;
  select * into v_upload from public.review_skill_upload where id = v_request.result_upload_id;
  if v_skill.id is null or v_version.id is null or v_upload.id is null then
    raise exception 'SKILL_OPTIMIZATION_NOT_READY';
  end if;
  -- staging 对象在 24h 后由保留期任务清理；过期的草稿没有可比对的"新"一侧。
  if v_upload.status not in ('VALIDATED', 'CONSUMED') then
    raise exception 'SKILL_UPLOAD_NOT_VALIDATED';
  end if;

  return jsonb_build_object(
    'request_id', v_request.id,
    'skill_id', v_skill.id,
    'skill_name', v_skill.name,
    'status', v_request.status,
    'ai_summary', v_request.ai_summary,
    'model_attempts', v_request.model_attempts,
    'changed_paths', to_jsonb(v_request.changed_paths),
    'before_bucket', v_version.archive_bucket,
    'before_object_key', v_version.archive_object_key,
    'before_version', v_version.version,
    'after_bucket', v_upload.staging_bucket,
    'after_object_key', v_upload.staging_object_key,
    'after_upload_id', v_upload.id,
    'after_upload_status', v_upload.status,
    'after_expires_at', v_upload.expires_at,
    -- 发布前就要知道：含脚本的版本必须额外确认，撞错误码才知道太晚了。
    'contains_scripts', coalesce(v_upload.contains_scripts, false),
    'after_file_count', v_upload.file_count
  );
end;
$$;

revoke execute on function public.admin_get_skill_optimization_diff_sources(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.admin_get_skill_optimization_diff_sources(uuid, uuid) to service_role;

commit;
