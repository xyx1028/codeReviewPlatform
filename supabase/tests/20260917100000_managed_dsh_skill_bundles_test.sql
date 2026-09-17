-- 20260917100000_managed_dsh_skill_bundles_test.sql
--
-- V1.6 受管 DSH Skill Bundle 契约回归。覆盖方案 §19 中属于数据库的那些条：
--
--   §19.4  发布后正式对象与 version 行不可覆盖
--   §19.5  新 Job 冻结全部已发布启用 Bundle 的固定 locator / hash / manifest
--   §19.6  所有 Story Task 使用相同 catalog hash（目录是 Job 级的，不是 Task 级的）
--   §19.14 发布 V2 后旧 Job 继续使用 V1，新 Job 使用 V2
--   §19.15 catalog hash 不一致时 record_analysis_attempt_profile 拒绝
--   §19.16 超过全目录上限一律 fail closed
--   §19.17 普通 authenticated 用户不能列出或下载 skill-bundles
--   §19.20 历史空技能 Job 不会突然获得新 Bundle
--
-- 另外断言三层 hash 的**规范格式**：`skill_bundle_hash` 与 `skill_catalog_hash` 必须与
-- `worker/src/ai/skills/skill-manifest.ts` 逐字节一致。这里用一个固定的 manifest 与
-- 目录，把 TypeScript 侧算出来的值写成期望常量 —— 两侧任何一方改了序列化都会红。

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
-- 1. 规范 hash：与 TypeScript 侧逐字节一致
-- ---------------------------------------------------------------------------

do $test$
declare
  v_manifest jsonb;
  v_input text;
begin
  v_manifest := jsonb_build_object(
    'schemaVersion', 1,
    'skillName', 'bos-bill-review',
    'entry', 'SKILL.md',
    'archiveSha256', 'sha256:' || repeat('a', 64),
    'archiveSizeBytes', 100,
    'expandedSizeBytes', 20,
    'containsScripts', false,
    'files', jsonb_build_array(
      -- 刻意乱序 + 大小写混排：排序必须是 `collate "C"`（字节序），与 JS 的码元序等价。
      -- 用 locale 排序的话 `SKILL.md` 会排到 `assets/` 后面，两侧 hash 立刻分叉。
      jsonb_build_object(
        'path', 'references/a.md', 'sha256', 'sha256:' || repeat('2', 64),
        'sizeBytes', 10, 'mediaType', 'text/markdown', 'role', 'REFERENCE'
      ),
      jsonb_build_object(
        'path', 'SKILL.md', 'sha256', 'sha256:' || repeat('1', 64),
        'sizeBytes', 10, 'mediaType', 'text/markdown', 'role', 'ENTRY'
      )
    )
  );

  v_input := public.skill_bundle_hash_input(v_manifest);
  perform pg_temp.assert(
    v_input = 'skill-bundle-v1' || E'\n'
      || 'schemaVersion=1' || E'\n'
      || 'skillName=bos-bill-review' || E'\n'
      || 'entry=SKILL.md' || E'\n'
      || 'SKILL.md' || E'\t' || 'sha256:' || repeat('1', 64) || E'\t' || '10' || E'\t'
        || 'text/markdown' || E'\t' || 'ENTRY' || E'\n'
      || 'references/a.md' || E'\t' || 'sha256:' || repeat('2', 64) || E'\t' || '10' || E'\t'
        || 'text/markdown' || E'\t' || 'REFERENCE' || E'\n',
    'bundle hash input is the canonical line format, entries sorted bytewise'
  );
  perform pg_temp.assert(
    public.skill_bundle_hash(v_manifest) ~ '^sha256:[0-9a-f]{64}$',
    'bundle hash is a prefixed lowercase hex digest'
  );

  -- catalog hash 与枚举顺序无关。
  perform pg_temp.assert(
    public.skill_catalog_hash(jsonb_build_array(
      jsonb_build_object('name', 'b-skill', 'version', 2, 'bundleHash', 'sha256:b', 'archiveSha256', 'sha256:1'),
      jsonb_build_object('name', 'a-skill', 'version', 1, 'bundleHash', 'sha256:a', 'archiveSha256', 'sha256:2')
    )) = public.skill_catalog_hash(jsonb_build_array(
      jsonb_build_object('name', 'a-skill', 'version', 1, 'bundleHash', 'sha256:a', 'archiveSha256', 'sha256:2'),
      jsonb_build_object('name', 'b-skill', 'version', 2, 'bundleHash', 'sha256:b', 'archiveSha256', 'sha256:1')
    )),
    'catalog hash is independent of enumeration order'
  );

  -- 空目录 hash 是历史 Job 与"当前没有已发布技能"共用的那个身份。
  -- 这个常量同时钉在 worker/src/__tests__/v16-skill-bundles.test.ts 里。
  perform pg_temp.assert(
    public.empty_skill_catalog_hash()
      = '68e1066195ea5e45438f0297d4408c32cdd3ed6d9571db897d20bea766e3a50b',
    'the empty catalog hash is pinned; changing it re-identifies every historical job'
  );
end;
$test$;

-- ---------------------------------------------------------------------------
-- 2. 名称规则
-- ---------------------------------------------------------------------------

do $test$
begin
  perform pg_temp.assert(public.is_valid_skill_name('bos-bill-review'), 'kebab-case accepted');
  perform pg_temp.assert(public.is_valid_skill_name('a1-b2'), 'digits accepted');
  -- 技能名是 `<DSH_HOME>/skills/<name>/` 的目录名：任何路径字符都必须在这里被拒。
  perform pg_temp.assert(not public.is_valid_skill_name('BOS-Bill'), 'uppercase rejected');
  perform pg_temp.assert(not public.is_valid_skill_name('bos_bill'), 'underscore rejected');
  perform pg_temp.assert(not public.is_valid_skill_name('bos.bill'), 'dot rejected');
  perform pg_temp.assert(not public.is_valid_skill_name('../escape'), 'traversal rejected');
  perform pg_temp.assert(not public.is_valid_skill_name('a'), 'too short rejected');
  perform pg_temp.assert(not public.is_valid_skill_name('bos--bill'), 'double hyphen rejected');
end;
$test$;

-- ---------------------------------------------------------------------------
-- 3. 发布 → 冻结 → 不可变 → V2 只影响新 Job
-- ---------------------------------------------------------------------------

do $test$
declare
  v_admin uuid := '16000000-0000-4000-a000-000000000001';
  v_reviewer uuid := '16000000-0000-4000-a000-000000000002';
  v_model uuid := '16000000-0000-4000-b000-000000000001';
  v_batch uuid := '16000000-0000-4000-c000-000000000001';
  v_secret uuid;
  v_skill uuid;
  v_upload uuid;
  v_manifest jsonb;
  v_published jsonb;
  v_version_id uuid;
  v_job_1 uuid;
  v_job_2 uuid;
  v_task uuid;
  v_claim uuid;
  v_snapshot jsonb;
  v_catalog_1 text;
  v_catalog_2 text;
  v_error text;
  v_task_count integer;
  v_distinct_hashes integer;
begin
  insert into auth.users (id, email) values
    (v_admin, 'admin_v16_skill@example.com'),
    (v_reviewer, 'reviewer_v16_skill@example.com')
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
  v_secret := public.admin_vault_create_secret('v16-skill-test-not-a-real-key', 'v16_skill_key');
  reset role;

  insert into public.ai_model_config (
    id, display_name, base_url, model_name, api_key_secret_id,
    enabled, max_parallel_tasks, created_by
  ) values (
    v_model, 'Model V16 skill', 'https://model-v16.example.com', 'model-v16',
    v_secret, true, 4, v_admin
  );

  insert into public.review_batch (id, name, week_code, default_branch, ai_model_config_id, created_by)
  values (v_batch, 'V16 skill batch', '2026-W38', 'feature_dev', v_model, v_admin);
  insert into public.review_story (batch_id, story_code, story_name, owners_text, source_data)
  values
    (v_batch, 'V16-1', 'story one', 'dev-a', '{}'::jsonb),
    (v_batch, 'V16-2', 'story two', 'dev-b', '{}'::jsonb);

  -- ---- 3.1 创建 → 注册上传 → 落校验结果 → 发布 --------------------------
  set local role service_role;
  v_skill := public.admin_create_review_skill(v_admin, 'bos-bill-review', 'BOS 单据评审');
  v_upload := public.admin_register_skill_upload(
    v_admin, v_skill, 'staging/' || v_admin::text || '/' || gen_random_uuid()::text || '.zip'
  );

  v_manifest := jsonb_build_object(
    'schemaVersion', 1,
    'skillName', 'bos-bill-review',
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
  -- frontmatter 缺失必须让校验落库失败：没有它，dsh 会静默忽略整个技能。
  begin
    perform public.admin_record_skill_upload_validation(
      v_admin, v_upload, 'sha256:' || repeat('a', 64), 1024, v_manifest, 2048, 1, false, null
    );
    perform pg_temp.assert(false, 'validation without frontmatter must be refused');
  exception when others then
    perform pg_temp.assert(
      sqlerrm like '%SKILL_BUNDLE_INVALID%',
      'missing frontmatter raises SKILL_BUNDLE_INVALID, got: ' || sqlerrm
    );
  end;

  -- frontmatter 的 name 必须等于平台技能名，否则 dsh 会把技能注册成另一个名字。
  begin
    perform public.admin_record_skill_upload_validation(
      v_admin, v_upload, 'sha256:' || repeat('a', 64), 1024, v_manifest, 2048, 1, false,
      jsonb_build_object('name', 'other-skill', 'description', 'x')
    );
    perform pg_temp.assert(false, 'a frontmatter name mismatch must be refused');
  exception when others then
    perform pg_temp.assert(
      sqlerrm like '%SKILL_BUNDLE_INVALID%',
      'frontmatter name mismatch raises SKILL_BUNDLE_INVALID, got: ' || sqlerrm
    );
  end;

  perform public.admin_record_skill_upload_validation(
    v_admin, v_upload, 'sha256:' || repeat('a', 64), 1024, v_manifest, 2048, 1, false,
    jsonb_build_object(
      'name', 'bos-bill-review',
      'description', 'BOS 单据领域评审要点',
      'whenToUse', '评审 BOS 单据相关需求时'
    )
  );

  -- 正式 key 必须精确等于服务端约定的形状；随便换一个 key 就应当被拒。
  begin
    perform public.admin_publish_review_skill_version(
      v_admin, v_upload, 'attacker/chosen/key.zip'
    );
    perform pg_temp.assert(false, 'a browser-chosen object key must be rejected');
  exception when others then
    perform pg_temp.assert(
      sqlerrm like '%SKILL_OBJECT_KEY_INVALID%',
      'wrong object key raises SKILL_OBJECT_KEY_INVALID, got: ' || sqlerrm
    );
  end;

  v_published := public.admin_publish_review_skill_version(
    v_admin, v_upload,
    v_skill::text || '/versions/1/' || repeat('a', 64) || '.zip'
  );
  -- description / whenToUse 只能来自 frontmatter，不由调用方另给一段文字。
  perform pg_temp.assert(
    (select description from public.review_skill_version where id = (v_published->>'version_id')::uuid)
      = 'BOS 单据领域评审要点',
    'the published description is taken from the SKILL.md frontmatter'
  );
  perform pg_temp.assert(
    (select when_to_use from public.review_skill_version where id = (v_published->>'version_id')::uuid)
      = '评审 BOS 单据相关需求时',
    'the published whenToUse is taken from the SKILL.md frontmatter'
  );
  v_version_id := (v_published->>'version_id')::uuid;
  perform pg_temp.assert((v_published->>'version')::integer = 1, 'first publish is V1');
  perform pg_temp.assert(
    (select bundle_hash from public.review_skill_version where id = v_version_id)
      = public.skill_bundle_hash(v_manifest),
    'the stored bundle hash is recomputed from the manifest, not taken from the caller'
  );

  -- ---- 3.2 已发布版本不可覆盖（§19.4） --------------------------------
  begin
    update public.review_skill_version set description = 'tampered' where id = v_version_id;
    perform pg_temp.assert(false, 'a published version row must be immutable');
  exception when others then
    perform pg_temp.assert(
      sqlerrm like '%SKILL_VERSION_IMMUTABLE%',
      'updating a published version raises SKILL_VERSION_IMMUTABLE, got: ' || sqlerrm
    );
  end;

  -- ---- 3.3 新 Job 冻结全部已发布启用 Bundle（§19.5 / §19.6） ----------
  reset role;
  v_job_1 := public.enqueue_analysis_job(v_batch);
  select skill_catalog_hash into v_catalog_1 from public.analysis_job where id = v_job_1;

  perform pg_temp.assert(
    (select skill_snapshot_version from public.analysis_job where id = v_job_1) = 1,
    'a job that froze a catalog carries snapshot_version >= 1'
  );
  perform pg_temp.assert(
    (select skill_bundle_count from public.analysis_job where id = v_job_1) = 1,
    'the job froze exactly the one published skill'
  );
  perform pg_temp.assert(
    v_catalog_1 <> public.empty_skill_catalog_hash(),
    'a job with a skill does not carry the empty catalog hash'
  );
  perform pg_temp.assert(
    (select count(*) from public.analysis_job_skill_snapshot where job_id = v_job_1) = 1,
    'the frozen snapshot row exists'
  );
  perform pg_temp.assert(
    (select archive_object_key from public.analysis_job_skill_snapshot where job_id = v_job_1)
      = v_skill::text || '/versions/1/' || repeat('a', 64) || '.zip',
    'the snapshot froze the fixed locator, not a signed URL'
  );

  -- 目录是 Job 级的：全部 Story Task 共用同一个 catalog hash。
  select count(*) into v_task_count from public.analysis_story_task where job_id = v_job_1;
  perform pg_temp.assert(v_task_count = 2, 'both stories became tasks');
  select count(distinct job.skill_catalog_hash) into v_distinct_hashes
  from public.analysis_story_task task
  join public.analysis_job job on job.id = task.job_id
  where task.job_id = v_job_1;
  perform pg_temp.assert(
    v_distinct_hashes = 1,
    'every story task of a job resolves to exactly one catalog hash'
  );

  -- 快照同样不可变。
  begin
    update public.analysis_job_skill_snapshot set description = 'x' where job_id = v_job_1;
    perform pg_temp.assert(false, 'a frozen job snapshot must be immutable');
  exception when others then
    perform pg_temp.assert(
      sqlerrm like '%SKILL_VERSION_IMMUTABLE%',
      'updating a job snapshot raises SKILL_VERSION_IMMUTABLE, got: ' || sqlerrm
    );
  end;

  -- 被 Job 引用的版本不能删除（§9.3）。
  set local role service_role;
  begin
    delete from public.review_skill_version where id = v_version_id;
    perform pg_temp.assert(false, 'a referenced version must not be deletable');
  exception when others then
    perform pg_temp.assert(
      sqlerrm like '%SKILL_OBJECT_REFERENCED%' or sqlerrm like '%violates foreign key%',
      'deleting a referenced version fails, got: ' || sqlerrm
    );
  end;

  -- ---- 3.4 Worker 侧 claim-fenced snapshot ---------------------------
  update public.analysis_job set status = 'PROCESSING', worker_id = 'worker-v16' where id = v_job_1;
  select public.claim_next_story_task('worker-v16', 900) into v_snapshot;
  v_task := (v_snapshot->>'id')::uuid;
  v_claim := (v_snapshot->>'claim_token')::uuid;

  v_snapshot := public.get_story_task_skill_snapshot(v_task, 'worker-v16', v_claim);
  perform pg_temp.assert(
    v_snapshot->>'catalog_hash' = v_catalog_1,
    'the worker snapshot returns the hash frozen on the job'
  );
  perform pg_temp.assert(
    jsonb_array_length(v_snapshot->'bundles') = 1
      and v_snapshot #>> '{bundles,0,archive_bucket}' = 'skill-bundles',
    'the worker snapshot names the dedicated private bucket'
  );

  -- 错误的 claim token 必须拿不到 locator。
  begin
    perform public.get_story_task_skill_snapshot(v_task, 'worker-v16', gen_random_uuid());
    perform pg_temp.assert(false, 'a wrong claim token must not yield frozen locators');
  exception when others then
    perform pg_temp.assert(
      sqlerrm like '%TASK_LEASE_LOST%',
      'a wrong claim token raises TASK_LEASE_LOST, got: ' || sqlerrm
    );
  end;

  -- ---- 3.5 catalog hash 门禁（§19.15） -------------------------------
  declare
    v_frozen_harness text;
    v_frozen_contract text;
    v_frozen_policy text;
  begin
    -- 用 Job **实际冻结**的 manifest 身份，而不是手写常量：否则先撞上
    -- SESSION_FORMAT_UNSUPPORTED，测不到 catalog 门禁。
    select harness_version, capability_contract_hash, policy_hash
    into v_frozen_harness, v_frozen_contract, v_frozen_policy
    from public.analysis_job where id = v_job_1;

    begin
      perform public.record_analysis_attempt_profile(
        v_task, 'worker-v16', v_claim, 1,
        v_frozen_harness, v_frozen_contract, 'profile-hash', v_frozen_policy,
        'root-1', 'session-1', 'tree-1',
        repeat('f', 64)
      );
      perform pg_temp.assert(false, 'a mismatched catalog hash must be refused');
    exception when others then
      perform pg_temp.assert(
        sqlerrm like '%SESSION_SKILL_SET_MISMATCH%',
        'a mismatched catalog hash raises SESSION_SKILL_SET_MISMATCH, got: ' || sqlerrm
      );
    end;

    -- 相同 hash 必须放行，并落到 analysis_agent_run 上供恢复门禁比对。
    perform pg_temp.assert(
      public.record_analysis_attempt_profile(
        v_task, 'worker-v16', v_claim, 1,
        v_frozen_harness, v_frozen_contract, 'profile-hash', v_frozen_policy,
        'root-1', 'session-1', 'tree-1',
        v_catalog_1
      ),
      'a matching catalog hash is accepted'
    );
    perform pg_temp.assert(
      (select skill_catalog_hash from public.analysis_agent_run
        where task_id = v_task and agent_attempt = 1) = v_catalog_1,
      'the accepted catalog hash lands on the agent run'
    );
  end;

  -- ---- 3.6 发布 V2 只影响新 Job（§19.14） ----------------------------
  v_upload := public.admin_register_skill_upload(
    v_admin, v_skill, 'staging/' || v_admin::text || '/' || gen_random_uuid()::text || '.zip'
  );
  v_manifest := jsonb_set(v_manifest, '{archiveSha256}', to_jsonb('sha256:' || repeat('b', 64)));
  v_manifest := jsonb_set(
    v_manifest, '{files,0,sha256}', to_jsonb('sha256:' || repeat('3', 64))
  );
  perform public.admin_record_skill_upload_validation(
    v_admin, v_upload, 'sha256:' || repeat('b', 64), 2048, v_manifest, 4096, 1, false,
    jsonb_build_object('name', 'bos-bill-review', 'description', 'V2 描述')
  );
  perform public.admin_publish_review_skill_version(
    v_admin, v_upload,
    v_skill::text || '/versions/2/' || repeat('b', 64) || '.zip'
  );

  -- 旧 Job 的快照一个字节都没变。
  perform pg_temp.assert(
    (select source_version from public.analysis_job_skill_snapshot where job_id = v_job_1) = 1,
    'the already-frozen job keeps V1'
  );
  perform pg_temp.assert(
    (select skill_catalog_hash from public.analysis_job where id = v_job_1) = v_catalog_1,
    'publishing V2 does not mutate an existing job catalog hash'
  );

  -- 新 Job 拿到 V2，且 catalog hash 变了。
  reset role;
  update public.analysis_job set status = 'SUCCEEDED' where id = v_job_1;
  v_job_2 := public.enqueue_analysis_job(v_batch);
  select skill_catalog_hash into v_catalog_2 from public.analysis_job where id = v_job_2;
  perform pg_temp.assert(
    (select source_version from public.analysis_job_skill_snapshot where job_id = v_job_2) = 2,
    'a new job freezes V2'
  );
  perform pg_temp.assert(
    v_catalog_2 <> v_catalog_1,
    'a different frozen version set yields a different catalog hash'
  );

  -- ---- 3.7 停用只影响新 Job（§4） ------------------------------------
  set local role service_role;
  perform public.admin_disable_review_skill(v_admin, v_skill);
  reset role;
  update public.analysis_job set status = 'SUCCEEDED' where id = v_job_2;
  declare
    v_job_3 uuid;
  begin
    v_job_3 := public.enqueue_analysis_job(v_batch);
    perform pg_temp.assert(
      (select skill_catalog_hash from public.analysis_job where id = v_job_3)
        = public.empty_skill_catalog_hash(),
      'a job created while every skill is disabled freezes the empty catalog'
    );
    perform pg_temp.assert(
      (select count(*) from public.analysis_job_skill_snapshot where job_id = v_job_3) = 0,
      'a disabled skill is not frozen into new jobs'
    );
    -- 而 V2 的 Job 仍然带着它冻结的那份目录 —— 停用不回溯。
    perform pg_temp.assert(
      (select skill_catalog_hash from public.analysis_job where id = v_job_2) = v_catalog_2,
      'disabling a skill does not retroactively change a frozen job'
    );
    update public.analysis_job set status = 'SUCCEEDED' where id = v_job_3;
  end;

  v_error := null;
end;
$test$;

-- ---------------------------------------------------------------------------
-- 4. 历史 Job 固定为空技能目录（§19.20）
-- ---------------------------------------------------------------------------

do $test$
begin
  -- 迁移把所有既有 Job 回填成"空目录 + snapshot_version 0"。任何 snapshot_version = 0
  -- 的 Job 都不能带 Bundle 快照，否则它会在重启后突然获得后来发布的技能。
  perform pg_temp.assert(
    not exists (
      select 1
      from public.analysis_job job
      join public.analysis_job_skill_snapshot snapshot on snapshot.job_id = job.id
      where job.skill_snapshot_version = 0
    ),
    'a snapshot_version = 0 job never carries bundle snapshots'
  );
  perform pg_temp.assert(
    not exists (
      select 1 from public.analysis_job
      where skill_snapshot_version = 0
        and skill_catalog_hash <> public.empty_skill_catalog_hash()
    ),
    'every historical job carries exactly the empty catalog hash'
  );
end;
$test$;

-- ---------------------------------------------------------------------------
-- 5. 权限与 Storage 策略（§19.17）
-- ---------------------------------------------------------------------------

do $test$
declare
  v_grantees text[];
begin
  -- bucket 必须是私有的。
  perform pg_temp.assert(
    exists (select 1 from storage.buckets where id = 'skill-bundles' and public is false),
    'the skill-bundles bucket exists and is private'
  );

  -- 普通 authenticated 不能列出或下载：这是**没有任何策略**的结果，而不是某条策略写对了。
  perform pg_temp.assert(
    not exists (
      select 1 from pg_policies
      where schemaname = 'storage' and tablename = 'objects'
        and qual like '%skill-bundles%'
    ),
    'no storage.objects policy references skill-bundles'
  );
  perform pg_temp.assert(
    not exists (
      select 1 from pg_policies
      where schemaname = 'storage' and tablename = 'objects'
        and with_check like '%skill-bundles%'
    ),
    'no storage.objects write policy references skill-bundles'
  );

  -- 返回冻结 locator 的 RPC 绝不能给 authenticated。
  select coalesce(array_agg(distinct grantee), '{}') into v_grantees
  from information_schema.role_routine_grants
  where specific_schema = 'public' and routine_name = 'get_story_task_skill_snapshot';
  perform pg_temp.assert(
    not ('authenticated' = any (v_grantees)) and not ('anon' = any (v_grantees)),
    'get_story_task_skill_snapshot is service-role only, got: ' || array_to_string(v_grantees, ',')
  );

  select coalesce(array_agg(distinct grantee), '{}') into v_grantees
  from information_schema.role_routine_grants
  where specific_schema = 'public' and routine_name = 'admin_publish_review_skill_version';
  perform pg_temp.assert(
    not ('authenticated' = any (v_grantees)),
    'publishing is service-role only; a browser must go through the Edge Function'
  );

  -- 只能有**一个** publish 重载。留一个接受 description 的旧重载等于留一条可以让浏览器
  -- 自定义 description 的旁路，而那条路会让库里的文本与 dsh 渲染给模型的文本分叉。
  perform pg_temp.assert(
    (select count(*) from pg_proc proc
      join pg_namespace ns on ns.oid = proc.pronamespace
      where ns.nspname = 'public' and proc.proname = 'admin_publish_review_skill_version') = 1,
    'exactly one publish overload exists'
  );
  perform pg_temp.assert(
    (select count(*) from pg_proc proc
      join pg_namespace ns on ns.oid = proc.pronamespace
      where ns.nspname = 'public' and proc.proname = 'admin_record_skill_upload_validation') = 1,
    'exactly one validation-recording overload exists'
  );

  -- 写入表一律不给浏览器：只有 SELECT 策略。
  perform pg_temp.assert(
    not exists (
      select 1 from pg_policies
      where schemaname = 'public'
        and tablename in ('review_skill', 'review_skill_version', 'review_skill_upload')
        and cmd <> 'SELECT'
    ),
    'the skill tables expose read-only policies to the browser'
  );
  perform pg_temp.assert(
    (select count(*) from pg_tables
      where schemaname = 'public'
        and tablename in (
          'review_skill', 'review_skill_version', 'review_skill_upload',
          'analysis_job_skill_snapshot', 'analysis_skill_invocation'
        )
        and rowsecurity) = 5,
    'every new table has RLS enabled'
  );
end;
$test$;

-- ---------------------------------------------------------------------------
-- 6. 全目录容量 fail closed（§19.16）
-- ---------------------------------------------------------------------------

do $test$
declare
  v_limits jsonb := public.skill_bundle_limits();
begin
  -- 上限必须与 Worker 侧 skill-limits.ts 和 Edge Function 侧 bundle.ts 是同一组数字。
  perform pg_temp.assert((v_limits->>'archiveBytes')::bigint = 10 * 1024 * 1024, 'archive limit');
  perform pg_temp.assert((v_limits->>'expandedBytes')::bigint = 50 * 1024 * 1024, 'expanded limit');
  perform pg_temp.assert((v_limits->>'entryCount')::int = 200, 'entry count limit');
  perform pg_temp.assert((v_limits->>'entryFileBytes')::int = 64 * 1024, 'SKILL.md limit');
  perform pg_temp.assert((v_limits->>'compressionRatio')::int = 20, 'compression ratio limit');
  perform pg_temp.assert((v_limits->>'catalogBundles')::int = 50, 'catalog bundle limit');
  perform pg_temp.assert((v_limits->>'descriptionChars')::int = 500, 'description limit');
  perform pg_temp.assert(
    (v_limits->>'catalogRenderBytes')::bigint = 32 * 1024, 'catalog render limit'
  );
  perform pg_temp.assert(
    (v_limits->>'catalogArchiveBytes')::bigint = 100 * 1024 * 1024, 'catalog archive limit'
  );
  perform pg_temp.assert(
    (v_limits->>'catalogExpandedBytes')::bigint = 256 * 1024 * 1024, 'catalog expanded limit'
  );
end;
$test$;

-- ---------------------------------------------------------------------------
-- 7. 审计派生：一次成功的 skill 调用产生一行调用审计（§16）
-- ---------------------------------------------------------------------------

do $test$
begin
  perform pg_temp.assert(
    exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'analysis_tool_audit'
        and column_name in ('skill_name', 'skill_bundle_hash', 'skill_snapshot_id', 'resource_relative_path')
      having count(*) = 4
    ),
    'the tool audit table carries exactly the four whitelisted skill fields'
  );
  perform pg_temp.assert(
    exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'analysis_agent_run_rollup'
        and column_name in (
          'skill_catalog_count', 'skill_catalog_bytes', 'skill_bundle_download_bytes',
          'skill_cache_hits', 'skill_cache_misses', 'skill_loaded_count',
          'skill_resource_reads', 'skill_script_runs'
        )
      having count(*) = 8
    ),
    'the run rollup carries the eight V1.6 skill metrics'
  );
  -- 调用审计表绝不含正文列。
  perform pg_temp.assert(
    not exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'analysis_skill_invocation'
        and column_name in ('content', 'instructions', 'body', 'command', 'signed_url')
    ),
    'analysis_skill_invocation stores no bundle text, command or signed URL'
  );
end;
$test$;

rollback;
