------------------------------------------------------------------------------
-- V1.22b：把模型的输出上限随请求冻结
--
-- 线上第二次失败（`skill_ai_optimization_request` 最新一行）：
--
--   error_code   = SKILL_OPTIMIZATION_MODEL_OUTPUT_INVALID
--   error_message= "the model output contains no JSON object"
--   model_attempts = 3，耗时 10:14:12 → 10:18:01（每次约 76 秒）
--
-- 真相不是"模型不会写 JSON"，而是**输出被 token 上限截断**：
--
--   * 三个启用的模型配置全部 `max_output_tokens = 8192`；
--   * 而 Worker 硬编码 `max_tokens: 60000` 发出去，端点按自己的上限截断；
--   * 被截断的正文停在字符串中间，没有任何 `}`，于是 `extractJsonObject` 报
--     "没有 JSON 对象"，三次都一样；
--   * 平台**看不见**这件事，因为响应里的 `finish_reason` 从来没被读过。
--
-- 失败的那个技能：SKILL.md 6826 字节 + 7 份 references（每份 3~5 KB）。协议要求模型把
-- 改过的文件整篇回写，一旦它同时改两三份资料，输出必然超过 8192 token。
--
-- 这个迁移只做一件事：把模型配置的 `max_output_tokens` 随请求冻结下来，让 Worker 用
-- 模型真实的上限发请求、并据此告诉模型"你这次最多能写多少"。
-- 光改 Worker 不行 —— 它的输入只有 claim 返回的那份快照。
--
-- 只增一列 + 两个 `create or replace`，签名不变，可重复应用。
------------------------------------------------------------------------------

alter table public.skill_ai_optimization_request
  add column if not exists max_output_tokens_snapshot integer;

comment on column public.skill_ai_optimization_request.max_output_tokens_snapshot is
  'V1.22b：入队时冻结的 ai_model_config.max_output_tokens。Worker 用它作为 max_tokens，'
  '并在提示词里把输出预算告诉模型。null = 升级前的历史行，Worker 回退到编译默认。';

------------------------------------------------------------------------------
-- 1. 入队时写入快照
--
-- 与 20260924095026 逐行一致（含 V1.22 的"必须有评审结论"门禁），只多一列。
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

  -- V1.22：门禁是"有几条评审结论"，口径与两个证据函数的 evidence CTE 逐字一致。
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
    request_timeout_ms_snapshot, network_access_mode_snapshot,
    max_output_tokens_snapshot
  ) values (
    p_skill_id, v_skill.current_version_id, auth.uid(), 'QUEUED',
    v_model.id, v_model.base_url, v_model.model_name,
    v_model.request_timeout_ms, v_model.network_access_mode,
    v_model.max_output_tokens
  )
  returning * into v_new;

  return public.skill_ai_optimization_request_to_jsonb(v_new);
exception when unique_violation then
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
-- 2. 认领时把快照交给 Worker
--
-- 与 20260924034553 的版本逐行一致，只在返回体里多一个键。
------------------------------------------------------------------------------

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
    update public.skill_ai_optimization_request
    set status = 'FAILED', error_code = 'SKILL_NOT_FOUND', finished_at = now(),
        worker_id = null, claim_token_digest = null, lease_expires_at = null
    where id = v_request.id;
    return null;
  end if;

  if v_request.model_config_id is null
     or coalesce(btrim(v_request.base_url_snapshot), '') = ''
     or coalesce(btrim(v_request.model_name_snapshot), '') = '' then
    update public.skill_ai_optimization_request
    set status = 'FAILED', error_code = 'MODEL_CONFIG_NOT_FOUND', finished_at = now(),
        worker_id = null, claim_token_digest = null, lease_expires_at = null
    where id = v_request.id;
    return null;
  end if;
  if v_request.requested_by is null then
    update public.skill_ai_optimization_request
    set status = 'FAILED', error_code = 'SKILL_OPTIMIZATION_ACTOR_MISSING', finished_at = now(),
        worker_id = null, claim_token_digest = null, lease_expires_at = null
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
    'archive_sha256', v_version.archive_sha256,
    'bundle_manifest', v_version.bundle_manifest,
    'model_config_id', v_request.model_config_id,
    'base_url_snapshot', v_request.base_url_snapshot,
    'model_name_snapshot', v_request.model_name_snapshot,
    'request_timeout_ms_snapshot', coalesce(v_request.request_timeout_ms_snapshot, 180000),
    'network_access_mode_snapshot', v_request.network_access_mode_snapshot,
    -- V1.22b：null = 历史行，Worker 回退到编译默认。
    'max_output_tokens_snapshot', v_request.max_output_tokens_snapshot
  );
end;
$$;

revoke execute on function public.claim_next_skill_ai_optimization_task(text)
  from public, anon, authenticated;
grant execute on function public.claim_next_skill_ai_optimization_task(text) to service_role;
