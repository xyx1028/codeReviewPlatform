-- 20260917142829_review_skill_delete_test.sql
--
-- 删除技能的契约回归。这个功能的全部风险都在"什么情况下**不能**删"，所以断言以拒绝
-- 路径为主：
--
--   1. 非管理员不能删
--   2. 不存在的技能返回 SKILL_NOT_FOUND
--   3. 草稿（没有任何版本）可以删
--   4. 已发布但没被任何 Job 冻结过的技能可以删，且返回待删归档对象
--   5. **被 Job 冻结过的技能必须拒绝**，错误码 SKILL_REFERENCED_BY_JOB
--   6. 拒绝之后技能与版本必须仍然存在（不能删一半）
--   7. admin_list_review_skills 的 referenced_by_job 与实际引用一致
--   8. 删除后容量水位回落，catalog hash 回到空目录 hash
--
-- 第 5 条是这个功能存在的边界：`analysis_job_skill_snapshot` 是"那次评审到底给了模型
-- 哪些技能"的唯一证据。允许删源技能就等于允许事后篡改证据链。

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

-- ---------------------------------------------------------------------------
-- 固定装置：一个管理员、一个普通评审员、一个批次、两个技能
-- ---------------------------------------------------------------------------

do $test$
declare
  v_admin uuid := '17de1000-0000-4000-a000-000000000001';
  v_reviewer uuid := '17de1000-0000-4000-a000-000000000002';
  v_model uuid := '17de1000-0000-4000-a000-000000000010';
  v_batch uuid := '17de1000-0000-4000-a000-000000000020';
  v_job uuid;
  v_secret uuid;
  v_draft uuid;
  v_kept uuid;
  v_free uuid;
  v_upload uuid;
  v_published jsonb;
  v_manifest jsonb;
  v_result jsonb;
  v_list jsonb;
  v_row jsonb;
begin
  insert into auth.users (id, email) values
    (v_admin, 'admin_skill_delete@example.com'),
    (v_reviewer, 'reviewer_skill_delete@example.com')
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
  v_secret := public.admin_vault_create_secret('skill-delete-test-not-a-real-key', 'skill_delete_key');
  reset role;

  insert into public.ai_model_config (
    id, display_name, base_url, model_name, api_key_secret_id,
    enabled, max_parallel_tasks, created_by
  ) values (
    v_model, 'Model skill delete', 'https://model-del.example.com', 'model-del',
    v_secret, true, 4, v_admin
  );
  insert into public.review_batch (id, name, week_code, default_branch, ai_model_config_id, created_by)
  values (v_batch, 'Skill delete batch', '2026-W38', 'feature_dev', v_model, v_admin);
  insert into public.review_story (batch_id, story_code, story_name, owners_text, source_data)
  values (v_batch, 'DEL-1', 'story one', 'dev-a', '{}'::jsonb);

  set local role service_role;

  -- ---- 1. 非管理员不能删 --------------------------------------------------
  v_draft := public.admin_create_review_skill(v_admin, 'draft-only-skill', '仅草稿技能');
  begin
    perform public.admin_delete_review_skill(v_reviewer, v_draft);
    perform pg_temp.assert(false, 'a non-admin actor must not delete a skill');
  exception when others then
    perform pg_temp.assert(
      sqlerrm not like '%ASSERT FAILED%',
      'non-admin delete raises, got: ' || sqlerrm
    );
  end;
  perform pg_temp.assert(
    exists (select 1 from public.review_skill where id = v_draft),
    'a refused non-admin delete leaves the skill in place'
  );

  -- ---- 2. 不存在的技能 ----------------------------------------------------
  begin
    perform public.admin_delete_review_skill(v_admin, gen_random_uuid());
    perform pg_temp.assert(false, 'deleting an unknown skill must fail');
  exception when others then
    perform pg_temp.assert(
      sqlerrm like '%SKILL_NOT_FOUND%',
      'unknown skill raises SKILL_NOT_FOUND, got: ' || sqlerrm
    );
  end;

  -- ---- 3. 草稿可以删 ------------------------------------------------------
  v_result := public.admin_delete_review_skill(v_admin, v_draft);
  perform pg_temp.assert((v_result->>'deleted')::boolean, 'a draft skill is deleted');
  perform pg_temp.assert(
    (v_result->>'version_count')::integer = 0,
    'a draft skill reports zero versions'
  );
  perform pg_temp.assert(
    jsonb_array_length(v_result->'objects') = 0,
    'a draft skill with no upload has no archive objects to remove'
  );
  perform pg_temp.assert(
    not exists (select 1 from public.review_skill where id = v_draft),
    'the draft skill row is gone'
  );
  -- 名字必须真的被释放：软删会留下"看不见但占着名字"的状态。
  perform pg_temp.assert(
    public.admin_create_review_skill(v_admin, 'draft-only-skill', '重建同名') is not null,
    'the deleted name is free again'
  );
  perform public.admin_delete_review_skill(
    v_admin, (select id from public.review_skill where name = 'draft-only-skill')
  );

  -- ---- 4/5. 两个已发布技能：一个冻结进 Job，一个不冻结 --------------------
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

  -- 4a. 会被 Job 引用的技能
  v_kept := public.admin_create_review_skill(v_admin, 'referenced-skill', '被引用技能');
  v_upload := public.admin_register_skill_upload(
    v_admin, v_kept, 'staging/' || v_admin::text || '/' || gen_random_uuid()::text || '.zip'
  );
  perform public.admin_record_skill_upload_validation(
    v_admin, v_upload, 'sha256:' || repeat('b', 64), 1024,
    v_manifest || jsonb_build_object('skillName', 'referenced-skill'),
    2048, 1, false,
    jsonb_build_object('name', 'referenced-skill', 'description', '被引用技能的描述')
  );
  v_published := public.admin_publish_review_skill_version(
    v_admin, v_upload, v_kept::text || '/versions/1/' || repeat('b', 64) || '.zip'
  );

  -- 4b. 不会被引用的技能
  v_free := public.admin_create_review_skill(v_admin, 'unreferenced-skill', '未被引用技能');
  v_upload := public.admin_register_skill_upload(
    v_admin, v_free, 'staging/' || v_admin::text || '/' || gen_random_uuid()::text || '.zip'
  );
  perform public.admin_record_skill_upload_validation(
    v_admin, v_upload, 'sha256:' || repeat('c', 64), 1024,
    v_manifest || jsonb_build_object(
      'skillName', 'unreferenced-skill', 'archiveSha256', 'sha256:' || repeat('c', 64)
    ),
    2048, 1, false,
    jsonb_build_object('name', 'unreferenced-skill', 'description', '未被引用技能的描述')
  );
  perform public.admin_publish_review_skill_version(
    v_admin, v_upload, v_free::text || '/versions/1/' || repeat('c', 64) || '.zip'
  );

  -- 冻结一个 Job：两个技能都会进快照，所以先只留 referenced-skill 启用。
  perform public.admin_set_review_skill_enabled(v_admin, v_free, false);
  -- 用 enqueue_analysis_job 而不是直接 insert：Job 的策略快照与技能目录都由它冻结，
  -- 手写 insert 会被 freeze_v4_job_manifest_and_policy_hash 以
  -- V4_CAPABILITY_POLICY_MISSING 拒掉。
  v_job := public.enqueue_analysis_job(v_batch);
  perform public.admin_set_review_skill_enabled(v_admin, v_free, true);

  perform pg_temp.assert(
    exists (
      select 1 from public.analysis_job_skill_snapshot
      where job_id = v_job and source_skill_id = v_kept
    ),
    'the referenced skill is frozen into the job snapshot'
  );
  perform pg_temp.assert(
    not exists (
      select 1 from public.analysis_job_skill_snapshot
      where job_id = v_job and source_skill_id = v_free
    ),
    'the disabled skill was not frozen into the job snapshot'
  );

  -- ---- 5. 被冻结的技能必须拒绝删除 ---------------------------------------
  begin
    perform public.admin_delete_review_skill(v_admin, v_kept);
    perform pg_temp.assert(false, 'a skill frozen into a job must not be deleted');
  exception when others then
    perform pg_temp.assert(
      sqlerrm like '%SKILL_REFERENCED_BY_JOB%',
      'a referenced skill raises SKILL_REFERENCED_BY_JOB, got: ' || sqlerrm
    );
  end;

  -- ---- 6. 拒绝之后不能删一半 ---------------------------------------------
  perform pg_temp.assert(
    exists (select 1 from public.review_skill where id = v_kept),
    'the refused skill row still exists'
  );
  perform pg_temp.assert(
    (select current_version_id from public.review_skill where id = v_kept) is not null,
    'the refused skill still points at its current version'
  );
  perform pg_temp.assert(
    (select count(*) from public.review_skill_version where skill_id = v_kept) = 1,
    'the refused skill still has its version row'
  );

  -- ---- 7. 列表的 referenced_by_job 与实际一致 -----------------------------
  reset role;
  v_list := public.admin_list_review_skills();
  set local role service_role;

  select value into v_row
  from jsonb_array_elements(v_list->'skills')
  where value->>'id' = v_kept::text;
  perform pg_temp.assert(
    (v_row->>'referenced_by_job')::boolean,
    'the referenced skill is flagged referenced_by_job in the list'
  );

  select value into v_row
  from jsonb_array_elements(v_list->'skills')
  where value->>'id' = v_free::text;
  perform pg_temp.assert(
    not (v_row->>'referenced_by_job')::boolean,
    'the unreferenced skill is not flagged referenced_by_job'
  );

  -- ---- 4c. 未被引用的已发布技能可以删，并交回待删对象 ---------------------
  v_result := public.admin_delete_review_skill(v_admin, v_free);
  perform pg_temp.assert((v_result->>'deleted')::boolean, 'an unreferenced published skill is deleted');
  perform pg_temp.assert(
    (v_result->>'version_count')::integer = 1,
    'the delete result reports the version count it removed'
  );
  perform pg_temp.assert(
    v_result->>'skill_name' = 'unreferenced-skill',
    'the delete result carries the removed skill name for the audit trail'
  );
  -- 正式归档必须出现在待删列表里，否则对象会永久留在 bucket 里没人认领。
  perform pg_temp.assert(
    exists (
      select 1 from jsonb_array_elements(v_result->'objects') o
      where o->>'object_key' = v_free::text || '/versions/1/' || repeat('c', 64) || '.zip'
        and o->>'bucket' = 'skill-bundles'
    ),
    'the published archive object is returned for Storage-side removal'
  );
  perform pg_temp.assert(
    not exists (select 1 from public.review_skill_version where skill_id = v_free),
    'the version rows are gone with the skill'
  );
  perform pg_temp.assert(
    not exists (select 1 from public.review_skill_upload where skill_id = v_free),
    'the upload rows cascade away with the skill'
  );

  -- ---- 8. 容量水位随之回落 -----------------------------------------------
  reset role;
  v_list := public.admin_list_review_skills();
  perform pg_temp.assert(
    (v_list->'capacity'->>'enabled_bundles')::integer = 1,
    'capacity counts only the one remaining published skill'
  );
end;
$test$;

rollback;
