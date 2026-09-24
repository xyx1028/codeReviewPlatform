-- 20260924050153_skill_ai_optimization_full_bundle_test.sql
--
-- V1.19 第三段的数据库契约：证据里的任务批次、模型重写次数、diff 取数的脚本标记。
--
-- 断言：
--   1. `referenced_batches` 给出批次身份（名称 + 周次 + 冻结的技能版本 + 结论数），
--      同一批次重跑会出现多条（按 job 列出，前端再归并）
--   2. 从未被引用的技能返回空数组而不是 null
--   3. Worker 侧证据 RPC 与管理员侧**同一份批次数据**
--   4. `model_attempts` 由提交类 RPC 写入；成功至少 1，失败可以是 0
--   5. 加参数后**没有留下旧重载**（旧重载会让 model_attempts 永远是 0）
--   6. diff 取数带 `contains_scripts` 与 `model_attempts`，且仍然不带任何正文

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
  v_admin uuid := '19f10000-0000-4000-a000-000000000001';
  v_reviewer uuid := '19f10000-0000-4000-a000-000000000002';
  v_model uuid := '19f10000-0000-4000-a000-000000000010';
  v_batch uuid := '19f10000-0000-4000-a000-000000000020';
  v_secret uuid;
  v_job_a uuid;
  v_job_b uuid;
  v_skill uuid;
  v_lonely uuid;
  v_story uuid;
  v_import uuid;
  v_upload uuid;
  v_manifest jsonb;
  v_evidence jsonb;
  v_batches jsonb;
  v_task jsonb;
  v_claim jsonb;
  v_token uuid;
  v_request uuid;
  v_sources jsonb;
begin
  insert into auth.users (id, email) values
    (v_admin, 'admin_v119f@example.com'),
    (v_reviewer, 'reviewer_v119f@example.com')
  on conflict (id) do nothing;
  insert into public.user_profile (id, role) values
    (v_admin, 'ADMIN'), (v_reviewer, 'REVIEWER')
  on conflict (id) do update set role = excluded.role;

  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', v_admin::text, 'role', 'authenticated')::text,
    true
  );

  set local role service_role;
  v_secret := public.admin_vault_create_secret('v119f-not-a-real-key', 'v119f_key');
  reset role;

  insert into public.ai_model_config (
    id, display_name, base_url, model_name, api_key_secret_id,
    enabled, max_parallel_tasks, request_timeout_ms, network_access_mode, created_by
  ) values (
    v_model, 'V119f model', 'https://model-v119f.example.com/v1', 'model-v119f',
    v_secret, true, 4, 120000, 'DIRECT', v_admin
  );
  insert into public.review_batch (id, name, week_code, default_branch, ai_model_config_id, created_by)
  values (v_batch, 'V119f 第 39 周评审', '2026-W39', 'feature_dev', v_model, v_admin);
  insert into public.review_story (id, batch_id, story_code, story_name, owners_text, source_data)
  values (gen_random_uuid(), v_batch, 'V119F-1', '权限校验需求', 'dev-a', '{}'::jsonb)
  returning id into v_story;

  set local role service_role;
  v_manifest := jsonb_build_object(
    'schemaVersion', 1,
    'entry', 'SKILL.md',
    'archiveSha256', 'sha256:' || repeat('a', 64),
    'archiveSizeBytes', 1024,
    'expandedSizeBytes', 2048,
    'containsScripts', false,
    'files', jsonb_build_array(jsonb_build_object(
      'path', 'SKILL.md', 'sha256', 'sha256:' || repeat('1', 64),
      'sizeBytes', 64, 'mediaType', 'text/markdown', 'role', 'ENTRY'
    ))
  );

  v_skill := public.admin_create_review_skill(v_admin, 'v119f-target-skill', 'V119f 目标技能');
  v_upload := public.admin_register_skill_upload(
    v_admin, v_skill, 'staging/' || v_admin::text || '/' || gen_random_uuid()::text || '.zip'
  );
  perform public.admin_record_skill_upload_validation(
    v_admin, v_upload, 'sha256:' || repeat('a', 64), 1024,
    v_manifest || jsonb_build_object('skillName', 'v119f-target-skill'),
    2048, 1, false,
    jsonb_build_object('name', 'v119f-target-skill', 'description', '目标技能描述')
  );
  perform public.admin_publish_review_skill_version(
    v_admin, v_upload, v_skill::text || '/versions/1/' || repeat('a', 64) || '.zip'
  );

  v_lonely := public.admin_create_review_skill(v_admin, 'v119f-lonely-skill', 'V119f 无证据技能');
  v_upload := public.admin_register_skill_upload(
    v_admin, v_lonely, 'staging/' || v_admin::text || '/' || gen_random_uuid()::text || '.zip'
  );
  perform public.admin_record_skill_upload_validation(
    v_admin, v_upload, 'sha256:' || repeat('d', 64), 1024,
    v_manifest || jsonb_build_object(
      'skillName', 'v119f-lonely-skill', 'archiveSha256', 'sha256:' || repeat('d', 64)
    ),
    2048, 1, false,
    jsonb_build_object('name', 'v119f-lonely-skill', 'description', '无证据技能描述')
  );
  perform public.admin_publish_review_skill_version(
    v_admin, v_upload, v_lonely::text || '/versions/1/' || repeat('d', 64) || '.zip'
  );

  -- 只让目标技能进快照，并**冻结两次**（同一批次重跑）。
  perform public.admin_set_review_skill_enabled(v_admin, v_lonely, false);
  reset role;
  v_job_a := public.enqueue_analysis_job(v_batch);
  -- 第二个 Job 必须在第一个终态之后才能建（既有的单活约束），这里直接把它标完成。
  update public.analysis_job set status = 'SUCCEEDED' where id = v_job_a;
  v_job_b := public.enqueue_analysis_job(v_batch);
  set local role service_role;
  perform public.admin_set_review_skill_enabled(v_admin, v_lonely, true);

  insert into public.ai_import_record (
    batch_id, version, is_active, imported_by,
    baseline_branch, baseline_commit, ai_model, analyzed_at
  ) values (
    v_batch, 1, true, v_admin, 'feature_dev', repeat('9', 40), 'model-v119f', now()
  ) returning id into v_import;
  insert into public.ai_review_result (story_id, ai_import_record_id, verdict, confidence, summary)
  values (v_story, v_import, 'IMPLEMENTED', 90, '认为权限校验已实现');

  -- ---- 1/2. referenced_batches -------------------------------------------
  reset role;
  v_evidence := public.admin_get_skill_review_evidence(v_skill);
  v_batches := v_evidence->'referenced_batches';
  perform pg_temp.assert(
    jsonb_array_length(v_batches) = 2,
    'both jobs of the same batch are listed (the frontend groups them)'
  );
  perform pg_temp.assert(
    v_batches->0->>'batch_name' = 'V119f 第 39 周评审'
      and v_batches->0->>'week_code' = '2026-W39'
      and (v_batches->0->>'skill_version')::integer = 1
      and (v_batches->0->>'result_count')::integer = 1,
    'a batch entry carries name, week code, frozen skill version and result count'
  );
  perform pg_temp.assert(
    (v_batches->0->>'job_created_at') >= (v_batches->1->>'job_created_at'),
    'batch entries come back newest first'
  );
  perform pg_temp.assert(
    jsonb_array_length(
      public.admin_get_skill_review_evidence(v_lonely)->'referenced_batches'
    ) = 0,
    'a never-referenced skill reports an empty batch array, not null'
  );

  -- ---- 4/5. model_attempts ------------------------------------------------
  perform pg_temp.assert(
    (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'submit_skill_ai_optimization_result') = 1,
    'no stale overload of submit_skill_ai_optimization_result survives'
  );
  perform pg_temp.assert(
    (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'submit_skill_ai_optimization_failure') = 1,
    'no stale overload of submit_skill_ai_optimization_failure survives'
  );
  perform pg_temp.assert(
    not has_function_privilege(
      'authenticated',
      'public.submit_skill_ai_optimization_result(uuid, text, uuid, uuid, text[], text, integer)',
      'execute')
    and has_function_privilege(
      'service_role',
      'public.submit_skill_ai_optimization_result(uuid, text, uuid, uuid, text[], text, integer)',
      'execute'),
    'the widened submit RPC is still service-role only'
  );

  v_task := public.admin_enqueue_skill_ai_optimization(v_skill);
  v_request := (v_task->>'id')::uuid;
  perform pg_temp.assert(
    (v_task->>'model_attempts')::integer = 0,
    'a queued task has not called the model yet'
  );

  set local role service_role;
  v_claim := public.claim_next_skill_ai_optimization_task('worker-v119f');
  v_token := (v_claim->>'claim_token')::uuid;

  -- Worker 侧证据必须与管理员侧同一份批次数据。
  v_evidence := public.get_skill_review_evidence_for_optimization(v_request, 'worker-v119f', v_token);
  perform pg_temp.assert(
    jsonb_array_length(v_evidence->'referenced_batches') = 2
      and v_evidence->'referenced_batches'->0->>'batch_name' = 'V119f 第 39 周评审',
    'the worker-side evidence RPC returns the same batches'
  );

  -- 失败写回：attempts 可以是 3（用尽重写次数）。
  v_task := public.submit_skill_ai_optimization_failure(
    v_request, 'worker-v119f', v_token,
    'SKILL_OPTIMIZATION_MODEL_OUTPUT_INVALID', 'AI 连续三次写出不合规的包', 3
  );
  perform pg_temp.assert(
    v_task->>'status' = 'FAILED' and (v_task->>'model_attempts')::integer = 3,
    'a failure records how many times the model was asked'
  );

  -- 成功写回：attempts = 2（第一次自检没过、AI 自己改了一次）。
  reset role;
  v_task := public.admin_enqueue_skill_ai_optimization(v_skill);
  v_request := (v_task->>'id')::uuid;
  set local role service_role;
  v_claim := public.claim_next_skill_ai_optimization_task('worker-v119f');
  v_token := (v_claim->>'claim_token')::uuid;

  v_upload := public.admin_register_skill_upload(
    v_admin, v_skill, 'staging/' || v_admin::text || '/' || gen_random_uuid()::text || '.zip'
  );
  perform public.admin_record_skill_upload_validation(
    v_admin, v_upload, 'sha256:' || repeat('b', 64), 1024,
    v_manifest || jsonb_build_object(
      'skillName', 'v119f-target-skill', 'archiveSha256', 'sha256:' || repeat('b', 64),
      'containsScripts', true
    ),
    2048, 1, true,
    jsonb_build_object('name', 'v119f-target-skill', 'description', 'AI 优化后的描述')
  );
  v_task := public.submit_skill_ai_optimization_result(
    v_request, 'worker-v119f', v_token, v_upload,
    array['SKILL.md', 'scripts/check.sh'], 'AI 自检后补了一个检查脚本', 2
  );
  perform pg_temp.assert(
    v_task->>'status' = 'SUCCEEDED' and (v_task->>'model_attempts')::integer = 2,
    'a success records the rewrite count'
  );
  perform pg_temp.assert(
    v_task->'changed_paths' = jsonb_build_array('SKILL.md', 'scripts/check.sh'),
    'changed paths may now cover several files across the bundle'
  );

  -- ---- 6. diff 取数 -------------------------------------------------------
  v_sources := public.admin_get_skill_optimization_diff_sources(v_admin, v_request);
  perform pg_temp.assert(
    (v_sources->>'contains_scripts')::boolean,
    'diff sources tell the browser the draft carries scripts BEFORE it offers publish'
  );
  perform pg_temp.assert(
    (v_sources->>'model_attempts')::integer = 2
      and (v_sources->>'after_file_count')::integer = 1,
    'diff sources carry the attempt count and the resulting file count'
  );
  -- 正文绝不经过数据库：这个 RPC 一个正文字段都不该有。
  perform pg_temp.assert(
    not (v_sources ? 'before_text') and not (v_sources ? 'after_text')
      and not (v_sources ? 'bundle_manifest'),
    'diff sources never carry file contents'
  );
end;
$test$;

rollback;
