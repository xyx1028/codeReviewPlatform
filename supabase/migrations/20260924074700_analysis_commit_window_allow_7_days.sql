-- V1.20.1 分析窗口放开 7 天。
--
-- 为什么要动数据库：候选集有两道闸门 —— analysis_job 的 CHECK 约束和
-- enqueue_analysis_job_with_context 里的 COMMIT_WINDOW_DAYS_INVALID 校验。
-- 只在前端加一个选项，点「开始分析」会被 RPC 直接拒掉。
--
-- 函数正文取自库内当前定义，只改校验那一行，避免回退此前的改动。

alter table public.analysis_job
  drop constraint if exists analysis_job_commit_window_days_check,
  add constraint analysis_job_commit_window_days_check
    check (commit_window_days in (7, 14, 21, 28));

CREATE OR REPLACE FUNCTION public.enqueue_analysis_job_with_context(p_batch_id uuid, p_analysis_context_version integer DEFAULT 1, p_commit_window_days integer DEFAULT 21)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_batch public.review_batch;
  v_enabled boolean;
  v_secret uuid;
  v_snapshot jsonb;
  v_policy jsonb;
  v_job_id uuid;
  v_story_count integer;
  v_rule_version public.analysis_attribution_rule_version;
begin
  perform public.ensure_manage_review_batch(p_batch_id);

  if p_analysis_context_version not in (1, 2) then
    raise exception 'ANALYSIS_CONTEXT_VERSION_INVALID';
  end if;
  if p_commit_window_days not in (7, 14, 21, 28) then
    raise exception 'COMMIT_WINDOW_DAYS_INVALID';
  end if;

  select * into v_batch from public.review_batch where id = p_batch_id for update;
  if v_batch.id is null then raise exception 'batch not found'; end if;
  if v_batch.status = 'COMPLETED' then
    raise exception 'batch is completed and read-only; reopen it first';
  end if;
  if v_batch.default_branch is null
     or v_batch.default_branch not in ('feature_dev', 'feature_sit', 'release') then
    raise exception 'batch default_branch must be feature_dev, feature_sit, or release';
  end if;
  if v_batch.ai_model_config_id is null then raise exception 'batch has no model selected'; end if;
  if exists (select 1 from public.ai_import_record where batch_id = p_batch_id) then
    raise exception 'AI result already exists for this batch';
  end if;
  if exists (
    select 1 from public.analysis_job
    where batch_id = p_batch_id
      and status in ('QUEUED', 'PREPARING_CODE', 'PREPARING_SCOPE', 'PROCESSING', 'FINALIZING')
  ) then
    raise exception 'an active analysis job already exists for this batch';
  end if;

  select count(*) into v_story_count from public.review_story where batch_id = p_batch_id;
  if v_story_count = 0 then raise exception 'no stories imported for this batch'; end if;

  select enabled, api_key_secret_id into v_enabled, v_secret
  from public.ai_model_config where id = v_batch.ai_model_config_id;
  if v_enabled is null then raise exception 'model config not found'; end if;
  if not v_enabled then raise exception 'MODEL_CONFIG_DISABLED'; end if;
  if not public.model_config_has_api_key(v_secret) then raise exception 'MODEL_SECRET_MISSING'; end if;

  if p_analysis_context_version = 2 then
    select version.* into v_rule_version
    from public.analysis_attribution_rule_set rule_set
    join public.analysis_attribution_rule_version version
      on version.id = rule_set.current_published_version_id
    where rule_set.rule_set_code = 'STORY_COMMIT_ATTRIBUTION'
      and rule_set.enabled
      and version.status = 'PUBLISHED'
    for share of version;
    if v_rule_version.id is null then raise exception 'PUBLISHED_ATTRIBUTION_RULESET_REQUIRED'; end if;
    if v_rule_version.ruleset_hash is distinct from public.attribution_rule_version_hash(v_rule_version.id) then
      raise exception 'ATTRIBUTION_RULESET_MISMATCH';
    end if;
  end if;

  v_snapshot := public.build_model_snapshot(v_batch.ai_model_config_id);
  v_policy := public.build_v4_capability_policy(v_batch.ai_model_config_id);
  update public.review_batch set ai_model_snapshot = v_snapshot where id = p_batch_id;

  insert into public.analysis_job (
    batch_id, model_config_id, model_snapshot, requested_branch,
    status, requested_by, total_stories, execution_engine,
    policy_version, capability_policy_snapshot, policy_hash,
    analysis_context_version, commit_window_days, scope_status,
    required_worker_scope_version, attribution_algorithm_version,
    attribution_rule_version_id, ruleset_hash
  ) values (
    p_batch_id, v_batch.ai_model_config_id, v_snapshot, v_batch.default_branch,
    'QUEUED', auth.uid(), v_story_count, 'deepseek-harness-acp',
    4, v_policy, encode(sha256(v_policy::text::bytea), 'hex'),
    p_analysis_context_version, p_commit_window_days,
    case when p_analysis_context_version = 2 then 'PREPARING' else 'LEGACY' end,
    case when p_analysis_context_version = 2 then 2 else 1 end,
    case when p_analysis_context_version = 2 then 'story-attribution-v2' else null end,
    case when p_analysis_context_version = 2 then v_rule_version.id else null end,
    case when p_analysis_context_version = 2 then v_rule_version.ruleset_hash else null end
  ) returning id into v_job_id;

  perform public.freeze_analysis_job_skill_catalog(v_job_id);

  insert into public.analysis_story_task (job_id, story_id)
  select v_job_id, story.id
  from public.review_story story
  where story.batch_id = p_batch_id;

  return v_job_id;
end;
$function$;
