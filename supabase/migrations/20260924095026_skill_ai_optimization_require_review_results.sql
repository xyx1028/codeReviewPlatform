------------------------------------------------------------------------------
-- V1.22：技能 AI 优化的证据门禁改为"有评审结论"
--
-- 线上实测（云端 `skill_ai_optimization_request` 两条 FAILED 行）：
--
--   error_code   = SKILL_OPTIMIZATION_MODEL_OUTPUT_INVALID
--   error_message= "the model changed nothing"
--   model_attempts = 3
--
-- 那个技能被 1 个 Analysis Job 引用过，但那个 Job **一条评审结论都没产出**：
-- verdict_counts 全 0、sample_findings 为空。于是提示词把"引用过 1 个 Job、0 条结论"
-- 递给模型，而系统提示词第 9 条明确要求"不要编造证据里没有的业务事实；证据不足时宁可
-- 少改" —— 模型照做，返回了空改动集；解析器把"没有改动"判为输出不合规，回灌原因重试，
-- 3 次都是同一份空证据，于是必然烧掉 3 次模型调用后失败。
--
-- 也就是说：这不是"AI 不按规范写"，而是**平台自己要求它别改，又把不改判为错误**。
--
-- 入队门禁只数"有几个 Job 引用过这个技能"，这是错的口径：Job 引用技能发生在冻结阶段，
-- 与它是否产出过结论无关。正确的口径是"有没有可学习的评审结论"，也就是
-- `ai_review_result` 的条数 —— 与两个证据函数渲染给模型的那份统计同源。
--
-- 本迁移：
--   1. 两个证据函数各加一个 `review_result_count` 字段（前端与 Worker 都据此判定可用性）；
--   2. `admin_enqueue_skill_ai_optimization` 的门禁从"有引用"改成"有结论"。
--
-- 只 `create or replace` 三个函数，签名全部不变；没有表结构变化，可重复应用。
------------------------------------------------------------------------------

------------------------------------------------------------------------------
-- 1. 管理员看到的证据（前端 /skills 的 AI 优化弹窗）
------------------------------------------------------------------------------

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
  v_results integer;
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
    count(*),
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
  into v_results, v_verdict, v_human, v_samples
  from evidence;

  return jsonb_build_object(
    'skill_id', p_skill_id,
    'referenced_job_count', coalesce(v_referenced_jobs, 0),
    -- V1.22：可用性的真实判据。referenced_job_count 只说明"被冻结进过某个 Job"。
    'review_result_count', coalesce(v_results, 0),
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

------------------------------------------------------------------------------
-- 2. Worker 取的同一份证据（门禁不同，口径必须一致）
------------------------------------------------------------------------------

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
  v_results integer;
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
    count(*),
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
  into v_results, v_verdict, v_human, v_samples
  from evidence;

  return jsonb_build_object(
    'skill_id', v_request.skill_id,
    'referenced_job_count', coalesce(v_referenced_jobs, 0),
    'review_result_count', coalesce(v_results, 0),
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
-- 3. 入队门禁：必须有评审结论
--
-- 除门禁那一段以外与 20260924050153 逐行一致（模型选择规则、竞态兜底都不动）。
------------------------------------------------------------------------------

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

  /*
   * V1.22：门禁从"有几个 Job 引用过"改成"有几条评审结论"。
   *
   * 口径与两个证据函数的 `evidence` CTE 逐字一致 —— 必须一致，否则会出现
   * "门禁放行、但递给模型的统计全是 0"这种自相矛盾的输入，而模型对着全 0 的证据
   * 唯一正确的回答就是"不改"，然后被解析器判为输出不合规。
   */
  select count(*) into v_evidence_count
  from (
    select distinct result.id
    from public.analysis_job_skill_snapshot snapshot
    join public.analysis_job job on job.id = snapshot.job_id
    join public.review_story story on story.batch_id = job.batch_id
    join public.ai_import_record air
      on air.batch_id = job.batch_id and air.is_active
    join public.ai_review_result result
      on result.story_id = story.id and result.ai_import_record_id = air.id
    where snapshot.source_skill_id = p_skill_id
  ) results;
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

comment on function public.admin_enqueue_skill_ai_optimization(uuid) is
  'V1.22：入队一次技能 AI 优化。门禁是"这个技能至少有 1 条 ai_review_result 可学习"，'
  '不是"被 Job 引用过" —— 引用发生在冻结阶段，与是否产出结论无关。';
