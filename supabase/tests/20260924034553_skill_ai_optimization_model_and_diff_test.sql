-- 20260924034553_skill_ai_optimization_model_and_diff_test.sql
--
-- V1.19 技能AI优化的数据库契约回归。覆盖两个迁移
-- （20260924033000_skill_ai_optimization.sql 建表与基础 RPC，
--   20260924034553_skill_ai_optimization_model_and_diff.sql 补模型快照/证据/diff 取数）。
--
-- 断言以**拒绝路径**为主，因为这条链路的全部风险都在"什么情况下不该产出一份可发布的草稿"：
--
--   1. 表默认拒绝：RLS 开启且浏览器角色没有任何表级权限
--   2. Worker 写回类 RPC 只授予 service_role；查询/入队类才给 authenticated
--   3. 非 ADMIN 不能查证据、不能入队
--   4. 没有已发布版本的技能不能优化（SKILL_NOT_PUBLISHED）
--   5. 从未被 Job 引用的技能不能优化（SKILL_OPTIMIZATION_NO_EVIDENCE）
--   6. 证据聚合的口径：Job 计数、结论分布、人工复核分布、抽样优先给"人工标了问题"的
--   7. 入队幂等：重复点击复用同一条进行中任务，且唯一索引只允许一条在飞
--   8. 入队冻结模型快照（之后改模型配置不影响在途任务）
--   9. 认领返回 claim_token，落库只有摘要；错 token 的心跳/提交一律 TASK_LEASE_LOST
--  10. Worker 侧证据 RPC 与管理员侧**同一口径**
--  11. 成功提交必须指向一条 VALIDATED 且同技能的 upload，否则拒绝
--  12. diff 取数只回定位信息（不回正文），且任务未成功时拒绝
--  13. 心跳超时回收把任务打回 QUEUED

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
  v_admin uuid := '19a10000-0000-4000-a000-000000000001';
  v_reviewer uuid := '19a10000-0000-4000-a000-000000000002';
  v_model uuid := '19a10000-0000-4000-a000-000000000010';
  v_model_b uuid := '19a10000-0000-4000-a000-000000000011';
  v_batch uuid := '19a10000-0000-4000-a000-000000000020';
  v_secret uuid;
  v_secret_b uuid;
  v_job uuid;
  v_skill uuid;
  v_lonely uuid;
  v_draft uuid;
  v_story uuid;
  v_story_b uuid;
  v_import uuid;
  v_result_a uuid;
  v_result_b uuid;
  v_upload uuid;
  v_second_upload uuid;
  v_manifest jsonb;
  v_evidence jsonb;
  v_task jsonb;
  v_same jsonb;
  v_claim jsonb;
  v_token uuid;
  v_request uuid;
  v_sources jsonb;
  v_rls boolean;
begin
  insert into auth.users (id, email) values
    (v_admin, 'admin_v119_opt@example.com'),
    (v_reviewer, 'reviewer_v119_opt@example.com')
  on conflict (id) do nothing;
  insert into public.user_profile (id, role) values
    (v_admin, 'ADMIN'), (v_reviewer, 'REVIEWER')
  on conflict (id) do update set role = excluded.role;

  -- `enqueue_analysis_job` 的门禁是 `ensure_manage_review_batch`，它看 `auth.uid()`。
  -- 装置阶段就把身份设成 ADMIN，否则冻结 Job 那一步会以"batch management permission
  -- required"失败，而那与被测功能无关。
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', v_admin::text, 'role', 'authenticated')::text,
    true
  );

  set local role service_role;
  v_secret := public.admin_vault_create_secret('v119-not-a-real-key', 'v119_opt_key');
  v_secret_b := public.admin_vault_create_secret('v119-not-a-real-key-b', 'v119_opt_key_b');
  reset role;

  insert into public.ai_model_config (
    id, display_name, base_url, model_name, api_key_secret_id,
    enabled, max_parallel_tasks, request_timeout_ms, network_access_mode, created_by
  ) values (
    v_model, 'V119 model', 'https://model-v119.example.com/v1', 'model-v119',
    v_secret, true, 4, 120000, 'DIRECT', v_admin
  );
  insert into public.review_batch (id, name, week_code, default_branch, ai_model_config_id, created_by)
  values (v_batch, 'V119 batch', '2026-W39', 'feature_dev', v_model, v_admin);
  insert into public.review_story (id, batch_id, story_code, story_name, owners_text, source_data)
  values (gen_random_uuid(), v_batch, 'V119-1', 'story one', 'dev-a', '{}'::jsonb)
  returning id into v_story;
  insert into public.review_story (id, batch_id, story_code, story_name, owners_text, source_data)
  values (gen_random_uuid(), v_batch, 'V119-2', 'story two', 'dev-b', '{}'::jsonb)
  returning id into v_story_b;

  -- ---- 1. 表默认拒绝 ------------------------------------------------------
  select relrowsecurity into v_rls
  from pg_class where oid = 'public.skill_ai_optimization_request'::regclass;
  perform pg_temp.assert(v_rls, 'skill_ai_optimization_request has RLS enabled');
  perform pg_temp.assert(
    not has_table_privilege('authenticated', 'public.skill_ai_optimization_request', 'select')
      and not has_table_privilege('authenticated', 'public.skill_ai_optimization_request', 'insert')
      and not has_table_privilege('anon', 'public.skill_ai_optimization_request', 'select'),
    'browser roles cannot touch the optimization queue table directly'
  );

  -- ---- 2. 权限分层 --------------------------------------------------------
  perform pg_temp.assert(
    not has_function_privilege(
      'authenticated', 'public.claim_next_skill_ai_optimization_task(text)', 'execute')
    and not has_function_privilege(
      'authenticated',
      'public.submit_skill_ai_optimization_result(uuid, text, uuid, uuid, text[], text)',
      'execute')
    and not has_function_privilege(
      'authenticated',
      'public.get_model_secret_for_skill_ai_optimization(uuid, text, uuid)', 'execute')
    and not has_function_privilege(
      'authenticated',
      'public.get_skill_review_evidence_for_optimization(uuid, text, uuid)', 'execute')
    and not has_function_privilege(
      'authenticated',
      'public.admin_get_skill_optimization_diff_sources(uuid, uuid)', 'execute'),
    'worker/edge RPCs are service-role only'
  );
  perform pg_temp.assert(
    has_function_privilege(
      'service_role', 'public.claim_next_skill_ai_optimization_task(text)', 'execute')
    and has_function_privilege(
      'authenticated', 'public.admin_get_skill_review_evidence(uuid)', 'execute')
    and has_function_privilege(
      'authenticated', 'public.admin_enqueue_skill_ai_optimization(uuid)', 'execute')
    and has_function_privilege(
      'authenticated', 'public.admin_get_skill_ai_optimization_task(uuid)', 'execute'),
    'browser RPCs are granted to authenticated (with ensure_admin inside)'
  );
  -- 改过签名的函数不能留旧重载：留着它等于留一条不带模型快照的认领路径。
  perform pg_temp.assert(
    (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'claim_next_skill_ai_optimization_task') = 1,
    'claim_next_skill_ai_optimization_task has exactly one overload'
  );

  -- ---- 装置：一个已发布技能 + 一个被 Job 冻结的快照 -----------------------
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

  v_skill := public.admin_create_review_skill(v_admin, 'v119-target-skill', 'V119 目标技能');
  v_upload := public.admin_register_skill_upload(
    v_admin, v_skill, 'staging/' || v_admin::text || '/' || gen_random_uuid()::text || '.zip'
  );
  perform public.admin_record_skill_upload_validation(
    v_admin, v_upload, 'sha256:' || repeat('a', 64), 1024,
    v_manifest || jsonb_build_object('skillName', 'v119-target-skill'),
    2048, 1, false,
    jsonb_build_object('name', 'v119-target-skill', 'description', '目标技能描述')
  );
  perform public.admin_publish_review_skill_version(
    v_admin, v_upload, v_skill::text || '/versions/1/' || repeat('a', 64) || '.zip'
  );

  -- 一个已发布但从未被 Job 引用的技能（第 5 条用它）
  v_lonely := public.admin_create_review_skill(v_admin, 'v119-lonely-skill', 'V119 无证据技能');
  v_upload := public.admin_register_skill_upload(
    v_admin, v_lonely, 'staging/' || v_admin::text || '/' || gen_random_uuid()::text || '.zip'
  );
  perform public.admin_record_skill_upload_validation(
    v_admin, v_upload, 'sha256:' || repeat('d', 64), 1024,
    v_manifest || jsonb_build_object(
      'skillName', 'v119-lonely-skill', 'archiveSha256', 'sha256:' || repeat('d', 64)
    ),
    2048, 1, false,
    jsonb_build_object('name', 'v119-lonely-skill', 'description', '无证据技能描述')
  );
  perform public.admin_publish_review_skill_version(
    v_admin, v_upload, v_lonely::text || '/versions/1/' || repeat('d', 64) || '.zip'
  );

  -- 一个连版本都没有的草稿（第 4 条用它）
  v_draft := public.admin_create_review_skill(v_admin, 'v119-draft-skill', 'V119 草稿技能');

  -- 只让目标技能进 Job 快照。
  perform public.admin_set_review_skill_enabled(v_admin, v_lonely, false);
  v_job := public.enqueue_analysis_job(v_batch);
  perform public.admin_set_review_skill_enabled(v_admin, v_lonely, true);
  perform pg_temp.assert(
    exists (
      select 1 from public.analysis_job_skill_snapshot
      where job_id = v_job and source_skill_id = v_skill
    ),
    'the target skill is frozen into the job snapshot'
  );

  -- 评审结论 + 人工复核。
  insert into public.ai_import_record (
    id, batch_id, version, is_active, imported_by,
    baseline_branch, baseline_commit, ai_model, analyzed_at
  )
  values (
    gen_random_uuid(), v_batch, 1, true, v_admin,
    'feature_dev', repeat('9', 40), 'model-v119', now()
  )
  returning id into v_import;
  insert into public.ai_review_result (id, story_id, ai_import_record_id, verdict, confidence, summary)
  values (gen_random_uuid(), v_story, v_import, 'IMPLEMENTED', 90, '第一条结论摘要')
  returning id into v_result_a;
  insert into public.ai_review_result (id, story_id, ai_import_record_id, verdict, confidence, summary)
  values (gen_random_uuid(), v_story_b, v_import, 'UNCERTAIN', 40, '第二条结论摘要')
  returning id into v_result_b;
  insert into public.human_review (story_id, ai_review_result_id, reviewer_id, result, comment)
  values (v_story_b, v_result_b, v_reviewer, 'INCORRECT', '这条评审判错了，漏了权限校验');

  -- ---- 3. 非 ADMIN 被拒 ---------------------------------------------------
  reset role;
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', v_reviewer::text, 'role', 'authenticated')::text,
    true
  );
  begin
    perform public.admin_get_skill_review_evidence(v_skill);
    perform pg_temp.assert(false, 'a non-admin must not read skill review evidence');
  exception when others then
    perform pg_temp.assert(
      sqlerrm not like '%ASSERT FAILED%',
      'non-admin evidence read raises, got: ' || sqlerrm
    );
  end;
  begin
    perform public.admin_enqueue_skill_ai_optimization(v_skill);
    perform pg_temp.assert(false, 'a non-admin must not enqueue an optimization');
  exception when others then
    perform pg_temp.assert(
      sqlerrm not like '%ASSERT FAILED%',
      'non-admin enqueue raises, got: ' || sqlerrm
    );
  end;

  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', v_admin::text, 'role', 'authenticated')::text,
    true
  );

  -- ---- 4. 没有已发布版本不能优化 -----------------------------------------
  begin
    perform public.admin_enqueue_skill_ai_optimization(v_draft);
    perform pg_temp.assert(false, 'an unpublished skill must not be optimized');
  exception when others then
    perform pg_temp.assert(
      sqlerrm like '%SKILL_NOT_PUBLISHED%',
      'unpublished skill raises SKILL_NOT_PUBLISHED, got: ' || sqlerrm
    );
  end;

  -- ---- 5. 没有历史证据不能优化 -------------------------------------------
  begin
    perform public.admin_enqueue_skill_ai_optimization(v_lonely);
    perform pg_temp.assert(false, 'a skill with no job history must not be optimized');
  exception when others then
    perform pg_temp.assert(
      sqlerrm like '%SKILL_OPTIMIZATION_NO_EVIDENCE%',
      'no-evidence skill raises SKILL_OPTIMIZATION_NO_EVIDENCE, got: ' || sqlerrm
    );
  end;
  -- 前端据此提前禁用按钮，所以证据查询必须把"0 个 Job"如实说出来。
  v_evidence := public.admin_get_skill_review_evidence(v_lonely);
  perform pg_temp.assert(
    (v_evidence->>'referenced_job_count')::integer = 0,
    'a never-referenced skill reports zero jobs instead of failing'
  );
  perform pg_temp.assert(
    jsonb_array_length(v_evidence->'sample_findings') = 0,
    'a never-referenced skill has no sample findings'
  );

  -- ---- 6. 证据口径 --------------------------------------------------------
  v_evidence := public.admin_get_skill_review_evidence(v_skill);
  perform pg_temp.assert(
    (v_evidence->>'referenced_job_count')::integer = 1,
    'the target skill reports exactly one referencing job'
  );
  perform pg_temp.assert(
    (v_evidence->'verdict_counts'->>'IMPLEMENTED')::integer = 1
      and (v_evidence->'verdict_counts'->>'UNCERTAIN')::integer = 1
      and (v_evidence->'verdict_counts'->>'PARTIAL')::integer = 0,
    'verdict counts follow the active ai_import_record'
  );
  perform pg_temp.assert(
    (v_evidence->'human_review_counts'->>'INCORRECT')::integer = 1
      and (v_evidence->'human_review_counts'->>'CORRECT')::integer = 0,
    'human review counts only count rows that exist'
  );
  perform pg_temp.assert(
    jsonb_array_length(v_evidence->'sample_findings') = 2,
    'both findings are sampled'
  );
  -- 抽样顺序是功能的一部分：人工标了问题的条目必须排在前面，否则 20 条上限会把
  -- 最有用的信号截掉。
  perform pg_temp.assert(
    v_evidence->'sample_findings'->0->>'story_code' = 'V119-2',
    'findings flagged INCORRECT by a human are sampled first'
  );
  perform pg_temp.assert(
    v_evidence->'sample_findings'->0->>'human_review_comment' like '%漏了权限校验%',
    'the human comment travels with the sampled finding'
  );

  -- ---- 7/8. 入队：幂等 + 模型快照 ----------------------------------------
  v_task := public.admin_enqueue_skill_ai_optimization(v_skill);
  v_same := public.admin_enqueue_skill_ai_optimization(v_skill);
  perform pg_temp.assert(v_task->>'status' = 'QUEUED', 'a fresh optimization starts QUEUED');
  perform pg_temp.assert(
    v_task->>'id' = v_same->>'id',
    'a second click reuses the in-flight task instead of creating a second one'
  );
  v_request := (v_task->>'id')::uuid;
  perform pg_temp.assert(
    (select count(*) from public.skill_ai_optimization_request
     where skill_id = v_skill and status in ('QUEUED', 'RUNNING')) = 1,
    'only one in-flight optimization exists per skill'
  );
  -- 投影不能泄露租约与 claim 摘要：浏览器拿到它就能伪造心跳。
  perform pg_temp.assert(
    not (v_task ? 'claim_token_digest') and not (v_task ? 'worker_id')
      and not (v_task ? 'lease_expires_at'),
    'the browser projection hides worker_id, lease and claim digest'
  );
  perform pg_temp.assert(
    (select base_url_snapshot from public.skill_ai_optimization_request where id = v_request)
      = 'https://model-v119.example.com/v1'
    and (select model_name_snapshot from public.skill_ai_optimization_request where id = v_request)
      = 'model-v119'
    and (select request_timeout_ms_snapshot from public.skill_ai_optimization_request where id = v_request)
      = 120000,
    'the model endpoint is frozen into the request row at enqueue time'
  );

  -- 之后新增另一个启用的模型配置也不能改变已入队任务的目标。
  insert into public.ai_model_config (
    id, display_name, base_url, model_name, api_key_secret_id,
    enabled, max_parallel_tasks, request_timeout_ms, network_access_mode, created_by
  ) values (
    v_model_b, 'V119 model B', 'https://model-v119-b.example.com/v1', 'model-v119-b',
    v_secret_b, true, 4, 60000, 'DIRECT', v_admin
  );
  perform pg_temp.assert(
    (select base_url_snapshot from public.skill_ai_optimization_request where id = v_request)
      = 'https://model-v119.example.com/v1',
    'adding another model config does not retarget an in-flight optimization'
  );

  -- ---- 9. 认领 / 心跳 / fencing -------------------------------------------
  set local role service_role;
  v_claim := public.claim_next_skill_ai_optimization_task('worker-v119');
  perform pg_temp.assert(v_claim is not null, 'the queued task is claimable');
  perform pg_temp.assert(
    (v_claim->>'request_id')::uuid = v_request,
    'the claim points at the queued request'
  );
  perform pg_temp.assert(
    v_claim->>'skill_name' = 'v119-target-skill'
      and v_claim->>'archive_bucket' = 'skill-bundles'
      and v_claim->>'base_url_snapshot' = 'https://model-v119.example.com/v1'
      and v_claim->>'model_name_snapshot' = 'model-v119'
      and (v_claim->>'requested_by')::uuid = v_admin,
    'the claim carries everything the worker needs (skill, archive, model, actor)'
  );
  v_token := (v_claim->>'claim_token')::uuid;
  perform pg_temp.assert(v_token is not null, 'the claim returns a claim token');
  perform pg_temp.assert(
    (select claim_token_digest from public.skill_ai_optimization_request where id = v_request)
      = public.agent_claim_token_digest(v_token),
    'only the claim token digest is persisted'
  );
  perform pg_temp.assert(
    public.claim_next_skill_ai_optimization_task('worker-v119-other') is null,
    'a claimed task is not handed to a second worker'
  );
  perform pg_temp.assert(
    public.heartbeat_skill_ai_optimization_task(v_request, 'worker-v119', v_token),
    'the claim owner can renew its lease'
  );
  begin
    perform public.heartbeat_skill_ai_optimization_task(v_request, 'worker-v119', gen_random_uuid());
    perform pg_temp.assert(false, 'a wrong claim token must not renew the lease');
  exception when others then
    perform pg_temp.assert(
      sqlerrm like '%TASK_LEASE_LOST%',
      'a wrong claim token raises TASK_LEASE_LOST, got: ' || sqlerrm
    );
  end;
  begin
    perform public.submit_skill_ai_optimization_failure(
      v_request, 'worker-v119-impostor', v_token, 'X', 'y'
    );
    perform pg_temp.assert(false, 'another worker must not write the result');
  exception when others then
    perform pg_temp.assert(
      sqlerrm like '%TASK_LEASE_LOST%',
      'a foreign worker raises TASK_LEASE_LOST, got: ' || sqlerrm
    );
  end;

  -- ---- 10. Worker 侧证据与管理员侧同口径 ---------------------------------
  v_evidence := public.get_skill_review_evidence_for_optimization(v_request, 'worker-v119', v_token);
  perform pg_temp.assert(
    (v_evidence->>'referenced_job_count')::integer = 1
      and (v_evidence->'verdict_counts'->>'UNCERTAIN')::integer = 1
      and (v_evidence->'human_review_counts'->>'INCORRECT')::integer = 1
      and v_evidence->'sample_findings'->0->>'story_code' = 'V119-2',
    'the worker-side evidence RPC matches the admin-side one'
  );
  begin
    perform public.get_skill_review_evidence_for_optimization(
      v_request, 'worker-v119', gen_random_uuid()
    );
    perform pg_temp.assert(false, 'evidence must not be readable without a valid claim');
  exception when others then
    perform pg_temp.assert(
      sqlerrm like '%TASK_LEASE_LOST%',
      'worker-side evidence is claim fenced, got: ' || sqlerrm
    );
  end;

  -- ---- 11. 成功提交必须指向一条 VALIDATED 且同技能的 upload ---------------
  -- 11a. PENDING（未校验）的 upload 必须被拒。
  v_second_upload := public.admin_register_skill_upload(
    v_admin, v_skill, 'staging/' || v_admin::text || '/' || gen_random_uuid()::text || '.zip'
  );
  begin
    perform public.submit_skill_ai_optimization_result(
      v_request, 'worker-v119', v_token, v_second_upload, array['SKILL.md'], 'summary'
    );
    perform pg_temp.assert(false, 'an unvalidated upload must not be accepted as a result');
  exception when others then
    perform pg_temp.assert(
      sqlerrm like '%SKILL_OPTIMIZATION_UPLOAD_INVALID%',
      'an unvalidated upload raises SKILL_OPTIMIZATION_UPLOAD_INVALID, got: ' || sqlerrm
    );
  end;

  -- 11b. 属于别的技能的 upload 必须被拒。
  v_upload := public.admin_register_skill_upload(
    v_admin, v_lonely, 'staging/' || v_admin::text || '/' || gen_random_uuid()::text || '.zip'
  );
  perform public.admin_record_skill_upload_validation(
    v_admin, v_upload, 'sha256:' || repeat('e', 64), 1024,
    v_manifest || jsonb_build_object(
      'skillName', 'v119-lonely-skill', 'archiveSha256', 'sha256:' || repeat('e', 64)
    ),
    2048, 1, false,
    jsonb_build_object('name', 'v119-lonely-skill', 'description', '别的技能的描述')
  );
  begin
    perform public.submit_skill_ai_optimization_result(
      v_request, 'worker-v119', v_token, v_upload, array['SKILL.md'], 'summary'
    );
    perform pg_temp.assert(false, 'an upload for another skill must not be accepted');
  exception when others then
    perform pg_temp.assert(
      sqlerrm like '%SKILL_OPTIMIZATION_UPLOAD_INVALID%',
      'a cross-skill upload raises SKILL_OPTIMIZATION_UPLOAD_INVALID, got: ' || sqlerrm
    );
  end;

  -- 11c. 空 changed_paths 必须被拒：一份"什么都没改"的草稿没有发布价值。
  perform public.admin_record_skill_upload_validation(
    v_admin, v_second_upload, 'sha256:' || repeat('f', 64), 1024,
    v_manifest || jsonb_build_object(
      'skillName', 'v119-target-skill', 'archiveSha256', 'sha256:' || repeat('f', 64)
    ),
    2048, 1, false,
    jsonb_build_object('name', 'v119-target-skill', 'description', 'AI 优化后的描述')
  );
  begin
    perform public.submit_skill_ai_optimization_result(
      v_request, 'worker-v119', v_token, v_second_upload, array[]::text[], 'summary'
    );
    perform pg_temp.assert(false, 'a result with no changed files must not be accepted');
  exception when others then
    perform pg_temp.assert(
      sqlerrm like '%SKILL_OPTIMIZATION_UPLOAD_INVALID%',
      'an empty changed_paths raises SKILL_OPTIMIZATION_UPLOAD_INVALID, got: ' || sqlerrm
    );
  end;

  -- 11d. 正常提交。
  v_task := public.submit_skill_ai_optimization_result(
    v_request, 'worker-v119', v_token, v_second_upload,
    array['SKILL.md'], 'AI 依据 1 条人工标错的结论补充了权限校验要点'
  );
  perform pg_temp.assert(v_task->>'status' = 'SUCCEEDED', 'the result lands as SUCCEEDED');
  perform pg_temp.assert(
    (v_task->>'result_upload_id')::uuid = v_second_upload,
    'the result points at the validated upload'
  );
  perform pg_temp.assert(
    v_task->'changed_paths' = jsonb_build_array('SKILL.md'),
    'changed paths are reported back to the browser'
  );
  perform pg_temp.assert(
    (select claim_token_digest from public.skill_ai_optimization_request where id = v_request) is null,
    'a finished task releases its claim'
  );
  -- 同一份提交不能重放：租约已释放，再提交必须 TASK_LEASE_LOST。
  begin
    perform public.submit_skill_ai_optimization_result(
      v_request, 'worker-v119', v_token, v_second_upload, array['SKILL.md'], 'again'
    );
    perform pg_temp.assert(false, 'a finished task must not accept a second result');
  exception when others then
    perform pg_temp.assert(
      sqlerrm like '%TASK_LEASE_LOST%',
      'replaying a submission raises TASK_LEASE_LOST, got: ' || sqlerrm
    );
  end;

  -- ---- 12. diff 取数 ------------------------------------------------------
  v_sources := public.admin_get_skill_optimization_diff_sources(v_admin, v_request);
  perform pg_temp.assert(
    v_sources->>'before_object_key' = v_skill::text || '/versions/1/' || repeat('a', 64) || '.zip'
      and v_sources->>'before_bucket' = 'skill-bundles'
      and v_sources->>'after_bucket' = 'skill-bundles'
      and (v_sources->>'after_upload_id')::uuid = v_second_upload,
    'diff sources locate both sides by bucket/key only'
  );
  perform pg_temp.assert(
    v_sources->'changed_paths' = jsonb_build_array('SKILL.md')
      and v_sources->>'ai_summary' like '%权限校验要点%',
    'diff sources carry the changed paths and the AI summary'
  );
  -- 正文绝不经过数据库：这个 RPC 一个正文字段都不该有。
  perform pg_temp.assert(
    not (v_sources ? 'before_text') and not (v_sources ? 'after_text')
      and not (v_sources ? 'bundle_manifest'),
    'diff sources never carry file contents'
  );
  begin
    perform public.admin_get_skill_optimization_diff_sources(v_reviewer, v_request);
    perform pg_temp.assert(false, 'a non-admin actor must not read diff sources');
  exception when others then
    perform pg_temp.assert(
      sqlerrm not like '%ASSERT FAILED%',
      'diff sources require an ADMIN actor, got: ' || sqlerrm
    );
  end;

  -- ---- 13. 心跳超时回收 --------------------------------------------------
  reset role;
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', v_admin::text, 'role', 'authenticated')::text,
    true
  );
  v_task := public.admin_enqueue_skill_ai_optimization(v_skill);
  v_request := (v_task->>'id')::uuid;
  set local role service_role;
  v_claim := public.claim_next_skill_ai_optimization_task('worker-v119-stale');
  perform pg_temp.assert(
    (v_claim->>'request_id')::uuid = v_request,
    'a new optimization is claimable after the previous one finished'
  );
  update public.skill_ai_optimization_request
  set lease_expires_at = now() - interval '1 minute'
  where id = v_request;
  perform pg_temp.assert(
    public.reclaim_stale_skill_ai_optimization_leases() = 1,
    'an expired lease is reclaimed'
  );
  perform pg_temp.assert(
    (select status from public.skill_ai_optimization_request where id = v_request) = 'QUEUED'
      and (select worker_id from public.skill_ai_optimization_request where id = v_request) is null,
    'a reclaimed task goes back to QUEUED with no owner'
  );
  -- 诊断类 RPC 在任务未成功时必须拒绝，而不是回一份半成品定位信息。
  begin
    perform public.admin_get_skill_optimization_diff_sources(v_admin, v_request);
    perform pg_temp.assert(false, 'diff sources must not exist before a task succeeds');
  exception when others then
    perform pg_temp.assert(
      sqlerrm like '%SKILL_OPTIMIZATION_NOT_READY%',
      'an unfinished task raises SKILL_OPTIMIZATION_NOT_READY, got: ' || sqlerrm
    );
  end;

  -- ---- 14. 优化记录不能把技能与模型配置锁死 -------------------------------
  --
  -- 这一条是本地全链路实测（2026-09-24）撞出来的：`source_version_id` 一开始写成
  -- `on delete restrict`，于是一个**曾经被 AI 优化过**的技能再也删不掉，报的还是裸外键
  -- 错误而不是任何领域错误码。优化请求是技能版本的派生物，不该反过来给它上锁。
  perform pg_temp.assert(
    (select confdeltype from pg_constraint
     where conrelid = 'public.skill_ai_optimization_request'::regclass
       and conname = 'skill_ai_optimization_request_source_version_id_fkey') = 'c',
    'source_version_id cascades, so an optimized skill stays deletable'
  );
  perform pg_temp.assert(
    (select confdeltype from pg_constraint
     where conrelid = 'public.skill_ai_optimization_request'::regclass
       and conname = 'skill_ai_optimization_request_model_config_id_fkey') = 'n',
    'model_config_id nulls out, so a used model config stays deletable'
  );

  -- 真的删一次：Job 快照先没了，技能才允许删（这是 V1.6 的既有门禁，不是本次新增的）。
  delete from public.analysis_job where id = v_job;
  perform pg_temp.assert(
    (public.admin_delete_review_skill(v_admin, v_skill)->>'deleted')::boolean,
    'a previously optimized skill is still deletable once no job references it'
  );
  perform pg_temp.assert(
    not exists (select 1 from public.skill_ai_optimization_request where skill_id = v_skill),
    'its optimization requests go away with it'
  );
end;
$test$;

rollback;
