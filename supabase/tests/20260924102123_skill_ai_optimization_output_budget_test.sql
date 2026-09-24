-- 20260924102123_skill_ai_optimization_output_budget_test.sql
--
-- V1.22b：把模型的输出上限随请求冻结。
--
-- 为什么需要这一列：线上三个模型配置都是 max_output_tokens = 8192，而 Worker 按 60000
-- 发 max_tokens，端点静默截断，错误表现成"输出里没有 JSON 对象"。Worker 的输入只有
-- claim 返回的那份快照，所以这一列必须由数据库交给它。
--
-- 断言：
--   1. 列存在，且入队时写入模型配置的值；
--   2. claim 的返回体里带 max_output_tokens_snapshot；
--   3. 历史行（列为 null）不会被伪造成某个数字 —— Worker 据此回退到编译默认。

\set ON_ERROR_STOP on
\timing off
\set QUIET on

begin;
set local client_min_messages = warning;

create or replace function pg_temp.assert(p_cond boolean, p_msg text)
returns void language plpgsql as $$
begin
  if p_cond is null or not p_cond then
    raise exception 'ASSERT FAILED: %', p_msg;
  end if;
end;
$$;

do $test$
declare
  v_admin uuid := '22b00000-0000-4000-a000-000000000001';
  v_model uuid := '22b00000-0000-4000-a000-000000000010';
  v_batch uuid := '22b00000-0000-4000-a000-000000000020';
  v_secret uuid;
  v_skill uuid;
  v_story uuid;
  v_import uuid;
  v_upload uuid;
  v_manifest jsonb;
  v_task jsonb;
  v_claim jsonb;
  v_request uuid;
begin
  insert into auth.users (id, email) values (v_admin, 'admin_v122b@example.com')
  on conflict (id) do nothing;
  insert into public.user_profile (id, role) values (v_admin, 'ADMIN')
  on conflict (id) do update set role = excluded.role;

  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', v_admin::text, 'role', 'authenticated')::text,
    true
  );

  set local role service_role;
  v_secret := public.admin_vault_create_secret('v122b-not-a-real-key', 'v122b_key');
  reset role;

  -- 线上三个配置都是 8192，这里照同一个值建。
  insert into public.ai_model_config (
    id, display_name, base_url, model_name, api_key_secret_id,
    enabled, max_parallel_tasks, request_timeout_ms, network_access_mode,
    context_window, max_output_tokens, created_by
  ) values (
    v_model, 'V122b model', 'https://model-v122b.example.com/v1', 'model-v122b',
    v_secret, true, 4, 180000, 'DIRECT', 131072, 8192, v_admin
  );
  insert into public.review_batch (id, name, week_code, default_branch, ai_model_config_id, created_by)
  values (v_batch, 'V122b 批次', '2026-W39', 'feature_dev', v_model, v_admin);
  insert into public.review_story (id, batch_id, story_code, story_name, owners_text, source_data)
  values (gen_random_uuid(), v_batch, 'V122B-1', '需求', 'dev-a', '{}'::jsonb)
  returning id into v_story;

  set local role service_role;
  v_manifest := jsonb_build_object(
    'schemaVersion', 1,
    'entry', 'SKILL.md',
    'archiveSha256', 'sha256:' || repeat('b', 64),
    'archiveSizeBytes', 1024,
    'expandedSizeBytes', 2048,
    'containsScripts', false,
    'files', jsonb_build_array(jsonb_build_object(
      'path', 'SKILL.md', 'sha256', 'sha256:' || repeat('2', 64),
      'sizeBytes', 64, 'mediaType', 'text/markdown', 'role', 'ENTRY'
    ))
  );
  v_skill := public.admin_create_review_skill(v_admin, 'v122b-skill', 'V122b 技能');
  v_upload := public.admin_register_skill_upload(
    v_admin, v_skill, 'staging/' || v_admin::text || '/' || gen_random_uuid()::text || '.zip'
  );
  perform public.admin_record_skill_upload_validation(
    v_admin, v_upload, 'sha256:' || repeat('b', 64), 1024,
    v_manifest || jsonb_build_object('skillName', 'v122b-skill'),
    2048, 1, false,
    jsonb_build_object('name', 'v122b-skill', 'description', 'V122b 技能描述')
  );
  perform public.admin_publish_review_skill_version(
    v_admin, v_upload, v_skill::text || '/versions/1/' || repeat('b', 64) || '.zip'
  );
  reset role;

  perform public.enqueue_analysis_job(v_batch);

  set local role service_role;
  insert into public.ai_import_record (
    batch_id, version, is_active, imported_by,
    baseline_branch, baseline_commit, ai_model, analyzed_at
  ) values (
    v_batch, 1, true, v_admin, 'feature_dev', repeat('8', 40), 'model-v122b', now()
  ) returning id into v_import;
  insert into public.ai_review_result (story_id, ai_import_record_id, verdict, confidence, summary)
  values (v_story, v_import, 'PARTIAL', 70, '部分实现');
  reset role;

  ----------------------------------------------------------------------------
  -- 1. 入队写入快照
  ----------------------------------------------------------------------------
  v_task := public.admin_enqueue_skill_ai_optimization(v_skill);
  v_request := (v_task->>'id')::uuid;
  perform pg_temp.assert(
    (select max_output_tokens_snapshot from public.skill_ai_optimization_request
     where id = v_request) = 8192,
    'the model output limit is frozen onto the request row'
  );

  ----------------------------------------------------------------------------
  -- 2. claim 把它交给 Worker
  ----------------------------------------------------------------------------
  set local role service_role;
  v_claim := public.claim_next_skill_ai_optimization_task('worker-v122b');
  perform pg_temp.assert(
    (v_claim->>'request_id')::uuid = v_request,
    'the worker claims the request we just queued'
  );
  perform pg_temp.assert(
    (v_claim->>'max_output_tokens_snapshot')::integer = 8192,
    'the claim payload carries the output budget (the worker has no other way to learn it)'
  );
  perform pg_temp.assert(
    (v_claim->>'request_timeout_ms_snapshot')::integer = 180000
      and v_claim->>'model_name_snapshot' = 'model-v122b',
    'the existing snapshot fields still come back unchanged'
  );

  ----------------------------------------------------------------------------
  -- 3. 历史行保持 null，不伪造数字
  ----------------------------------------------------------------------------
  update public.skill_ai_optimization_request
  set status = 'QUEUED', worker_id = null, claim_token_digest = null,
      lease_expires_at = null, max_output_tokens_snapshot = null
  where id = v_request;
  v_claim := public.claim_next_skill_ai_optimization_task('worker-v122b');
  perform pg_temp.assert(
    v_claim->'max_output_tokens_snapshot' = 'null'::jsonb,
    'a pre-upgrade row reports null instead of an invented number'
  );
  reset role;

  raise notice 'skill ai optimization output budget test passed';
end;
$test$;

select 'ALL_SKILL_AI_OPTIMIZATION_OUTPUT_BUDGET_TESTS_PASSED' as result;

rollback;
