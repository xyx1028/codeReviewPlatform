-- V1.19 技能AI优化（第二段）：把"这次优化用哪个模型"冻结进任务行，
-- 给 Worker 一条 service-role 的证据读取通道，并给 diff 视图一个受控的取数入口。
--
-- 为什么不写在 20260924033000 里：那个文件已经应用过，按仓库规则迁移只增不改。
--
-- 三件事，每一件都对应一条"上一版跑不起来"的具体原因：
--
--   1. **模型冻结**。上一版的认领 RPC 只返回技能与归档定位，Worker 拿不到 base_url /
--      model_name / 超时 / 网络类型，也拿不到 Vault 里的 Key —— 它根本没法调模型。
--      快照在**入队**时取（而不是认领时），于是"管理员点下去那一刻用的是哪个模型"
--      是一条确定的事实，中途改模型配置不影响在途任务，与批次冻结模型同一个原则。
--   2. **证据读取**。`admin_get_skill_review_evidence` 的第一句是 `ensure_admin()`，
--      它依赖 `auth.uid()`；service_role 调用时 `auth.uid()` 是 null，必然被拒。
--      所以 Worker 需要一条同口径、但用 claim_token 而不是用户身份做门禁的通道。
--   3. **diff 取数**。前端要逐文件看 diff，就必须拿到两侧正文；而正文既不在这张新表里
--      （刻意不存），也不在浏览器能读的 bucket 里（skill-bundles 没有任何 authenticated
--      策略）。这里只返回**定位信息**，由 Edge Function 用 service-role 读字节、
--      解出文本再回给前端 —— 不新增存储通道，也不把正文落进数据库。

begin;

------------------------------------------------------------------------------
-- 1. 任务行上的模型快照
------------------------------------------------------------------------------

-- `create table if not exists` 对已存在的表是 no-op，所以新列必须显式 alter。
alter table public.skill_ai_optimization_request
  add column if not exists model_config_id uuid references public.ai_model_config(id) on delete set null,
  add column if not exists base_url_snapshot text,
  add column if not exists model_name_snapshot text,
  add column if not exists request_timeout_ms_snapshot integer,
  add column if not exists network_access_mode_snapshot text;

comment on column public.skill_ai_optimization_request.base_url_snapshot is
  'V1.19: frozen at enqueue time. Changing the model config afterwards must not '
  'retarget an in-flight optimization.';

/*
 * 表级权限收回。
 *
 * 上一版只开了 RLS 且不建任何策略 —— 那已经让直连 select 拿不到行，但 Supabase 的默认
 * 权限仍然把 `authenticated` 的表级 select/insert 授了出去。两者的区别在于**可审计性**：
 * 一条 `has_table_privilege` 断言能证明"浏览器角色连这张表都碰不到"，而"RLS 没有策略
 * 所以默认拒绝"要靠读迁移才能确认。队列表与连接测试队列同规格，一律 revoke。
 */
revoke all on table public.skill_ai_optimization_request from public, anon, authenticated;

/*
 * 外键删除行为修正。
 *
 * 上一版把 `source_version_id` 写成 `on delete restrict`，`model_config_id` 也是 restrict。
 * 本地全链路实测（2026-09-24）撞上了它的后果：一个**曾经被 AI 优化过**的技能再也删不掉 ——
 * `admin_delete_review_skill` 会在删除版本行时被这条外键挡住，而且报的是裸 FK 错误，
 * 不是任何一个领域错误码，管理员完全看不出该怎么办。
 *
 * 正确的语义：
 *
 *   * `source_version_id` → cascade。优化请求是技能版本的**派生物**，不是独立事实；
 *     技能版本只有在"整个技能被删、且没有任何 Job 引用它"时才会消失，那时留着一条指向
 *     不存在版本的优化记录没有意义。`skill_id` 本来就是 cascade，两者现在一致了。
 *   * `model_config_id` → set null。"这次优化用了哪个模型"的审计事实已经冻在
 *     `base_url_snapshot` / `model_name_snapshot` 里，所以清掉外键不丢信息；留 restrict
 *     反而会让一个用过一次的模型配置永远删不掉。
 */
alter table public.skill_ai_optimization_request
  drop constraint if exists skill_ai_optimization_request_source_version_id_fkey,
  add constraint skill_ai_optimization_request_source_version_id_fkey
    foreign key (source_version_id) references public.review_skill_version(id) on delete cascade;

alter table public.skill_ai_optimization_request
  drop constraint if exists skill_ai_optimization_request_model_config_id_fkey,
  add constraint skill_ai_optimization_request_model_config_id_fkey
    foreign key (model_config_id) references public.ai_model_config(id) on delete set null;

------------------------------------------------------------------------------
-- 2. 入队：同时冻结模型快照
--
-- 签名不变（p_skill_id uuid），所以 create or replace 就够，不会留下旧重载。
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

  select count(distinct snapshot.job_id) into v_evidence_count
  from public.analysis_job_skill_snapshot snapshot
  where snapshot.source_skill_id = p_skill_id;
  if coalesce(v_evidence_count, 0) = 0 then
    raise exception 'SKILL_OPTIMIZATION_NO_EVIDENCE';
  end if;

  /*
   * 模型选择：**产出这些证据的那个模型**。
   *
   * 具体是"引用过这个技能的最近一个 Job 所用的模型配置"。刻意不让前端传
   * model_config_id（那等于让浏览器指定花谁的钱、走哪条网络），也刻意不"随便挑一个启用
   * 的配置"：
   *
   *   * 优化的输入是这些 Job 产出的评审结论，用同一个模型改技能，改前改后才可比；
   *   * 这个规则是确定的 —— 同一技能重复触发一定落在同一个模型上，而"随便挑一个"会
   *     随着管理员新增/停用配置悄悄换模型，两次优化结果失去可比性。
   *
   * 那个模型被停用时退回"最早创建的启用配置"，一个都没有就 fail closed。
   */
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
-- 3. 认领：把模型快照一起交给 Worker
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

  /*
   * 缺模型快照 / 缺请求人 = 这条任务永远跑不完，直接终态失败而不是交给 Worker。
   *
   * 请求人不是审计装饰：AI 产出必须走与人工上传**完全相同**的校验 RPC，而那些 RPC 的
   * 第一句是 `assert_actor_is_admin(p_actor_id)`。没有请求人，Worker 连 staging 上传
   * 都注册不了 —— 与其让它跑到最后一步才失败，不如在认领时就说清原因。
   */
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
    'network_access_mode_snapshot', v_request.network_access_mode_snapshot
  );
end;
$$;

revoke execute on function public.claim_next_skill_ai_optimization_task(text)
  from public, anon, authenticated;
grant execute on function public.claim_next_skill_ai_optimization_task(text) to service_role;

------------------------------------------------------------------------------
-- 4. Worker 侧的模型密钥读取（claim_token 门禁，照抄连接测试链路）
------------------------------------------------------------------------------

create or replace function public.get_model_secret_for_skill_ai_optimization(
  p_request_id uuid,
  p_worker_id text,
  p_claim_token uuid
)
returns text
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_secret_id uuid;
  v_secret text;
begin
  perform public.assert_skill_ai_optimization_claim(p_request_id, p_worker_id, p_claim_token);

  select cfg.api_key_secret_id into v_secret_id
  from public.skill_ai_optimization_request request
  join public.ai_model_config cfg on cfg.id = request.model_config_id
  where request.id = p_request_id;

  if v_secret_id is null or not public.model_config_has_api_key(v_secret_id) then
    raise exception 'MODEL_SECRET_MISSING';
  end if;
  select decrypted_secret into v_secret from vault.decrypted_secrets where id = v_secret_id;
  if v_secret is null then
    raise exception 'MODEL_SECRET_MISSING';
  end if;
  return v_secret;
end;
$$;

revoke execute on function public.get_model_secret_for_skill_ai_optimization(uuid, text, uuid)
  from public, anon, authenticated;
grant execute on function public.get_model_secret_for_skill_ai_optimization(uuid, text, uuid)
  to service_role;

------------------------------------------------------------------------------
-- 5. Worker 侧的证据读取
--
-- 口径与 admin_get_skill_review_evidence **完全一致**（同一个函数体，只是门禁不同）：
-- 管理员在页面上看到的统计与模型看到的必须是同一份数字，否则"AI 依据这些证据改的"
-- 这句话无从核对。
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
    'verdict_counts', v_verdict,
    'human_review_counts', v_human,
    -- Worker 侧只取前 20 条，与前端同一个口径（jsonb 没有 limit，只能截 array）。
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
-- 6. diff 取数：只给定位信息，不给正文
--
-- 调用方是 Edge Function（service_role + 显式 actor），与 admin_get_skill_upload /
-- admin_get_skill_version_locator 同一个模式：actor 必须是 ADMIN，函数只回 bucket/key。
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
    'changed_paths', to_jsonb(v_request.changed_paths),
    'before_bucket', v_version.archive_bucket,
    'before_object_key', v_version.archive_object_key,
    'before_version', v_version.version,
    'after_bucket', v_upload.staging_bucket,
    'after_object_key', v_upload.staging_object_key,
    'after_upload_id', v_upload.id,
    'after_upload_status', v_upload.status,
    'after_expires_at', v_upload.expires_at
  );
end;
$$;

revoke execute on function public.admin_get_skill_optimization_diff_sources(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.admin_get_skill_optimization_diff_sources(uuid, uuid) to service_role;

commit;
