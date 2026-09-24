-- 20260924095026_skill_ai_optimization_require_review_results_test.sql
--
-- V1.22：技能 AI 优化的证据门禁。
--
-- 复现线上那次失败的前置条件：技能被一个 Analysis Job 冻结引用过，但那个 Job 一条
-- ai_review_result 都没产出。旧门禁只数引用，于是放行；模型拿到一份全 0 的统计，按
-- "证据不足宁可少改"返回空改动集，解析器判为输出不合规并重试三次。
--
-- 断言：
--   1. 引用数 1 / 结论数 0 时，两个证据函数都报 review_result_count = 0；
--   2. 这种状态下 admin_enqueue_skill_ai_optimization 以 SKILL_OPTIMIZATION_NO_EVIDENCE 拒绝；
--   3. 有了结论之后同一个技能可以入队，且 review_result_count 跟着变 1；
--   4. Worker 侧证据 RPC 与管理员侧口径一致（同一个 review_result_count）；
--   5. 从未被引用的技能仍然被拒（旧行为不变）。

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
  v_admin uuid := '22200000-0000-4000-a000-000000000001';
  v_model uuid := '22200000-0000-4000-a000-000000000010';
  v_batch uuid := '22200000-0000-4000-a000-000000000020';
  v_secret uuid;
  v_skill uuid;
  v_lonely uuid;
  v_story uuid;
  v_import uuid;
  v_upload uuid;
  v_manifest jsonb;
  v_evidence jsonb;
  v_task jsonb;
  v_claim jsonb;
  v_request uuid;
  v_error text;
begin
  insert into auth.users (id, email) values (v_admin, 'admin_v122@example.com')
  on conflict (id) do nothing;
  insert into public.user_profile (id, role) values (v_admin, 'ADMIN')
  on conflict (id) do update set role = excluded.role;

  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', v_admin::text, 'role', 'authenticated')::text,
    true
  );

  set local role service_role;
  v_secret := public.admin_vault_create_secret('v122-not-a-real-key', 'v122_key');
  reset role;

  insert into public.ai_model_config (
    id, display_name, base_url, model_name, api_key_secret_id,
    enabled, max_parallel_tasks, request_timeout_ms, network_access_mode, created_by
  ) values (
    v_model, 'V122 model', 'https://model-v122.example.com/v1', 'model-v122',
    v_secret, true, 4, 120000, 'DIRECT', v_admin
  );
  insert into public.review_batch (id, name, week_code, default_branch, ai_model_config_id, created_by)
  values (v_batch, 'V122 第 39 周评审', '2026-W39', 'feature_dev', v_model, v_admin);
  insert into public.review_story (id, batch_id, story_code, story_name, owners_text, source_data)
  values (gen_random_uuid(), v_batch, 'V122-1', '权限校验需求', 'dev-a', '{}'::jsonb)
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

  v_skill := public.admin_create_review_skill(v_admin, 'v122-target-skill', 'V122 目标技能');
  v_upload := public.admin_register_skill_upload(
    v_admin, v_skill, 'staging/' || v_admin::text || '/' || gen_random_uuid()::text || '.zip'
  );
  perform public.admin_record_skill_upload_validation(
    v_admin, v_upload, 'sha256:' || repeat('a', 64), 1024,
    v_manifest || jsonb_build_object('skillName', 'v122-target-skill'),
    2048, 1, false,
    jsonb_build_object('name', 'v122-target-skill', 'description', '目标技能描述')
  );
  perform public.admin_publish_review_skill_version(
    v_admin, v_upload, v_skill::text || '/versions/1/' || repeat('a', 64) || '.zip'
  );

  v_lonely := public.admin_create_review_skill(v_admin, 'v122-lonely-skill', 'V122 无引用技能');
  v_upload := public.admin_register_skill_upload(
    v_admin, v_lonely, 'staging/' || v_admin::text || '/' || gen_random_uuid()::text || '.zip'
  );
  perform public.admin_record_skill_upload_validation(
    v_admin, v_upload, 'sha256:' || repeat('d', 64), 1024,
    v_manifest || jsonb_build_object(
      'skillName', 'v122-lonely-skill', 'archiveSha256', 'sha256:' || repeat('d', 64)
    ),
    2048, 1, false,
    jsonb_build_object('name', 'v122-lonely-skill', 'description', '无引用技能描述')
  );
  perform public.admin_publish_review_skill_version(
    v_admin, v_upload, v_lonely::text || '/versions/1/' || repeat('d', 64) || '.zip'
  );

  -- 只让目标技能进 Job 快照。
  perform public.admin_set_review_skill_enabled(v_admin, v_lonely, false);
  reset role;
  perform public.enqueue_analysis_job(v_batch);
  set local role service_role;
  perform public.admin_set_review_skill_enabled(v_admin, v_lonely, true);
  reset role;

  ----------------------------------------------------------------------------
  -- 1. 引用数 1、结论数 0：这正是线上那个技能的状态。
  ----------------------------------------------------------------------------
  v_evidence := public.admin_get_skill_review_evidence(v_skill);
  perform pg_temp.assert(
    (v_evidence->>'referenced_job_count')::integer = 1,
    'the skill is referenced by exactly one job'
  );
  perform pg_temp.assert(
    (v_evidence->>'review_result_count')::integer = 0,
    'being referenced by a job does not mean there are review conclusions'
  );

  ----------------------------------------------------------------------------
  -- 2. 门禁拒绝：不让它进入模型阶段烧三次调用。
  ----------------------------------------------------------------------------
  begin
    perform public.admin_enqueue_skill_ai_optimization(v_skill);
    raise exception 'a skill without any review conclusion must not be queued';
  exception when others then
    v_error := SQLERRM;
    perform pg_temp.assert(
      v_error like '%SKILL_OPTIMIZATION_NO_EVIDENCE%',
      'the gate rejects with SKILL_OPTIMIZATION_NO_EVIDENCE, got: ' || v_error
    );
  end;
  perform pg_temp.assert(
    (select count(*) from public.skill_ai_optimization_request where skill_id = v_skill) = 0,
    'no request row is created when the gate rejects'
  );

  ----------------------------------------------------------------------------
  -- 5. 从未被引用的技能仍然被拒（旧行为不变）。
  ----------------------------------------------------------------------------
  v_evidence := public.admin_get_skill_review_evidence(v_lonely);
  perform pg_temp.assert(
    (v_evidence->>'referenced_job_count')::integer = 0
      and (v_evidence->>'review_result_count')::integer = 0,
    'a never-referenced skill reports zero on both counters'
  );
  begin
    perform public.admin_enqueue_skill_ai_optimization(v_lonely);
    raise exception 'a never-referenced skill must not be queued';
  exception when others then
    v_error := SQLERRM;
    perform pg_temp.assert(
      v_error like '%SKILL_OPTIMIZATION_NO_EVIDENCE%',
      'the never-referenced skill is still rejected'
    );
  end;

  ----------------------------------------------------------------------------
  -- 3. 有结论之后可以入队。
  ----------------------------------------------------------------------------
  set local role service_role;
  insert into public.ai_import_record (
    batch_id, version, is_active, imported_by,
    baseline_branch, baseline_commit, ai_model, analyzed_at
  ) values (
    v_batch, 1, true, v_admin, 'feature_dev', repeat('9', 40), 'model-v122', now()
  ) returning id into v_import;
  insert into public.ai_review_result (story_id, ai_import_record_id, verdict, confidence, summary)
  values (v_story, v_import, 'IMPLEMENTED', 90, '认为权限校验已实现');
  reset role;

  v_evidence := public.admin_get_skill_review_evidence(v_skill);
  perform pg_temp.assert(
    (v_evidence->>'review_result_count')::integer = 1
      and (v_evidence->'verdict_counts'->>'IMPLEMENTED')::integer = 1,
    'the conclusion count and the verdict distribution come from the same query'
  );

  v_task := public.admin_enqueue_skill_ai_optimization(v_skill);
  v_request := (v_task->>'id')::uuid;
  perform pg_temp.assert(v_request is not null, 'the skill can be queued once it has a conclusion');

  ----------------------------------------------------------------------------
  -- 4. Worker 侧口径一致。
  ----------------------------------------------------------------------------
  set local role service_role;
  v_claim := public.claim_next_skill_ai_optimization_task('worker-v122');
  perform pg_temp.assert(
    (v_claim->>'request_id')::uuid = v_request,
    'the worker claims the request we just queued'
  );
  v_evidence := public.get_skill_review_evidence_for_optimization(
    v_request, 'worker-v122', (v_claim->>'claim_token')::uuid
  );
  perform pg_temp.assert(
    (v_evidence->>'review_result_count')::integer = 1,
    'the worker-side evidence RPC reports the same conclusion count'
  );
  reset role;

  raise notice 'skill ai optimization evidence gate test passed';
end;
$test$;

select 'ALL_SKILL_AI_OPTIMIZATION_EVIDENCE_GATE_TESTS_PASSED' as result;

rollback;
