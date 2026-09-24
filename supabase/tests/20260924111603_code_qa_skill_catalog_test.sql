-- V1.23b：技能状态过滤修正 + Worker 侧当前技能目录通道。
--
-- 这份测试存在的唯一理由是第一版那个 bug：`code_qa_catalog()` 过滤
-- `status = 'ENABLED'`，而 `review_skill.status` 根本没有这个值。后果是问答页的
-- 「可用模块技能」永远为空，而且**没有任何错误码**——页面看起来正常，只是模型少了
-- 一整层模块知识。所以这里正面钉住：
--
--   1. PUBLISHED 的技能出现在 code_qa_catalog() 里；
--   2. DISABLED / DRAFT 的不出现；
--   3. code_qa_catalog() 的技能集合与 current_skill_catalog_entries() 完全一致
--      （口径单一事实来源，防止将来两处再次漂移）；
--   4. get_code_qa_skill_catalog 的形状与 get_story_task_skill_snapshot 一致，
--      且只发给持有租约的 Worker；
--   5. 产品侧那份**不含**归档定位（object key / sha256 / hash）。
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
  v_owner    uuid := '24000000-0000-4000-a000-000000000001';
  v_model    uuid := '24000000-0000-4000-c000-000000000001';
  v_secret   uuid;
  v_pub_skill uuid := '24000000-0000-4000-d000-000000000001';
  v_dis_skill uuid := '24000000-0000-4000-d000-000000000002';
  v_pub_ver  uuid := '24000000-0000-4000-e000-000000000001';
  v_dis_ver  uuid := '24000000-0000-4000-e000-000000000002';
  v_conv     jsonb;
  v_conv_id  uuid;
  v_turn     jsonb;
  v_turn_id  uuid;
  v_claim    jsonb;
  v_token    uuid;
  v_catalog  jsonb;
  v_worker_catalog jsonb;
  v_names    text[];
  v_live_names text[];
  v_bundle   jsonb;
  v_manifest jsonb := jsonb_build_object(
    'files', jsonb_build_array(
      jsonb_build_object('path', 'SKILL.md', 'sha256', repeat('a', 64), 'bytes', 120)
    )
  );
begin
  insert into auth.users (id, email) values (v_owner, 'qa_skill_owner@example.com')
  on conflict (id) do nothing;
  insert into public.user_profile (id, role) values (v_owner, 'VIEWER')
  on conflict (id) do update set role = excluded.role;

  v_secret := vault.create_secret('sk-qa-skill', 'qa_skill_key_' || gen_random_uuid()::text);
  insert into public.ai_model_config (
    id, display_name, base_url, model_name, api_key_secret_id, enabled,
    request_timeout_ms, max_output_tokens, network_access_mode, created_by, created_at
  ) values (
    v_model, 'QA 技能测试模型', 'https://example.invalid/v1', 'test-model', v_secret, true,
    120000, 8192, 'DIRECT', v_owner, '1970-01-01T00:00:00Z'
  );

  ----------------------------------------------------------------------------
  -- 两个技能：一个 PUBLISHED，一个 DISABLED。
  ----------------------------------------------------------------------------
  insert into public.review_skill (id, name, display_name, status, created_by) values
    (v_pub_skill, 'qa-published-module', '已发布模块', 'DRAFT', v_owner),
    (v_dis_skill, 'qa-disabled-module', '已停用模块', 'DRAFT', v_owner);

  insert into public.review_skill_version (
    id, skill_id, version, description, when_to_use,
    archive_bucket, archive_object_key, archive_sha256, archive_size_bytes,
    bundle_hash, bundle_manifest, expanded_size_bytes, file_count, contains_scripts,
    published_by, published_at
  ) values
    (v_pub_ver, v_pub_skill, 1, '讲清已发布模块的业务背景', '问到这个模块时读它',
     'skill-bundles', 'skills/qa-published-module/v1.zip', 'sha256:' || repeat('b', 64), 2048,
     'sha256:' || repeat('c', 64), v_manifest, 4096, 1, false, v_owner, now()),
    (v_dis_ver, v_dis_skill, 1, '停用模块的说明', null,
     'skill-bundles', 'skills/qa-disabled-module/v1.zip', 'sha256:' || repeat('d', 64), 1024,
     'sha256:' || repeat('e', 64), v_manifest, 2048, 1, false, v_owner, now());

  update public.review_skill set current_version_id = v_pub_ver, status = 'PUBLISHED'
  where id = v_pub_skill;
  update public.review_skill set current_version_id = v_dis_ver, status = 'DISABLED'
  where id = v_dis_skill;

  ----------------------------------------------------------------------------
  -- 1~3. 产品侧目录：PUBLISHED 进、DISABLED 不进，且与单一事实来源一致。
  ----------------------------------------------------------------------------
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_owner::text, 'role', 'authenticated')::text, true);

  v_catalog := public.code_qa_catalog();

  select array_agg(entry->>'name' order by entry->>'name') into v_names
  from jsonb_array_elements(v_catalog -> 'skills') as entry;

  perform pg_temp.assert(v_names @> array['qa-published-module'],
    'PUBLISHED skill must appear in code_qa_catalog (the V1.23a bug made this list always empty)');
  perform pg_temp.assert(not (v_names @> array['qa-disabled-module']),
    'DISABLED skill must not appear');

  -- 口径必须与 current_skill_catalog_entries() 完全一致。
  select array_agg(entry->>'name' order by entry->>'name') into v_live_names
  from jsonb_array_elements(public.current_skill_catalog_entries()) as entry;
  perform pg_temp.assert(v_names = v_live_names,
    'code_qa_catalog skills must match current_skill_catalog_entries exactly; '
    || 'two filters drift silently');

  -- 产品侧不含归档定位。
  select entry into v_bundle
  from jsonb_array_elements(v_catalog -> 'skills') as entry
  where entry->>'name' = 'qa-published-module';
  perform pg_temp.assert(not (v_bundle ? 'archive_object_key'),
    'product-facing catalog must not expose archive object keys');
  perform pg_temp.assert(not (v_bundle ? 'bundle_hash'),
    'product-facing catalog must not expose bundle hashes');
  perform pg_temp.assert(v_bundle->>'description' = '讲清已发布模块的业务背景',
    'description comes from the published version');

  -- 仓库与分支照常返回。
  perform pg_temp.assert(jsonb_array_length(v_catalog -> 'repositories') >= 5,
    'repository catalog present');
  perform pg_temp.assert(v_catalog -> 'branches' = jsonb_build_array('feature_dev','feature_sit','release'),
    'three branches');

  ----------------------------------------------------------------------------
  -- 4. Worker 侧目录：形状与 get_story_task_skill_snapshot 一致。
  ----------------------------------------------------------------------------
  v_conv := public.create_code_qa_conversation(array['kdmanage-backend'], 'release', null);
  v_conv_id := (v_conv ->> 'id')::uuid;
  v_turn := public.request_code_qa_turn(v_conv_id, '这个模块怎么实现的？');
  v_turn_id := (v_turn ->> 'id')::uuid;

  perform set_config('request.jwt.claims', null, true);
  set local role service_role;

  v_claim := public.claim_next_code_qa_turn('worker-qa-skill', 600);
  perform pg_temp.assert((v_claim ->> 'turn_id')::uuid = v_turn_id, 'claimed the turn');
  v_token := (v_claim ->> 'claim_token')::uuid;

  v_worker_catalog := public.get_code_qa_skill_catalog(v_turn_id, 'worker-qa-skill', v_token);

  perform pg_temp.assert(v_worker_catalog ? 'catalog_hash', 'worker catalog carries a hash');
  perform pg_temp.assert(length(v_worker_catalog ->> 'catalog_hash') = 64,
    'catalog hash is a sha256 hex');
  perform pg_temp.assert(v_worker_catalog -> 'job_id' = 'null'::jsonb,
    'code QA has no job id (it uses the CURRENT catalog, not a frozen snapshot)');

  select entry into v_bundle
  from jsonb_array_elements(v_worker_catalog -> 'bundles') as entry
  where entry->>'name' = 'qa-published-module';
  perform pg_temp.assert(v_bundle is not null, 'published bundle present for the worker');
  -- 逐字段钉住形状：Worker 用同一个 parseFrozenSkillCatalog 解析，缺一个键就变 undefined。
  perform pg_temp.assert(v_bundle->>'archive_bucket' = 'skill-bundles', 'bucket');
  perform pg_temp.assert(v_bundle->>'archive_object_key' = 'skills/qa-published-module/v1.zip', 'object key');
  perform pg_temp.assert(v_bundle->>'archive_sha256' = 'sha256:' || repeat('b', 64), 'archive sha256');
  perform pg_temp.assert((v_bundle->>'archive_size_bytes')::bigint = 2048, 'archive size');
  perform pg_temp.assert(v_bundle->>'bundle_hash' = 'sha256:' || repeat('c', 64), 'bundle hash');
  perform pg_temp.assert(v_bundle ? 'bundle_manifest', 'manifest present');
  perform pg_temp.assert((v_bundle->>'expanded_size_bytes')::bigint = 4096, 'expanded size');
  perform pg_temp.assert((v_bundle->>'file_count')::integer = 1, 'file count');
  perform pg_temp.assert((v_bundle->>'contains_scripts')::boolean = false, 'contains scripts');
  perform pg_temp.assert(v_bundle->>'snapshot_id' = v_pub_ver::text,
    'snapshot_id falls back to the immutable version id');
  perform pg_temp.assert((v_bundle->>'version')::integer = 1, 'version');

  -- DISABLED 的不给 Worker。
  perform pg_temp.assert(not exists (
    select 1 from jsonb_array_elements(v_worker_catalog -> 'bundles') as entry
    where entry->>'name' = 'qa-disabled-module'
  ), 'DISABLED skill must not reach the worker either');

  ----------------------------------------------------------------------------
  -- 5. 门禁：没有租约拿不到。
  ----------------------------------------------------------------------------
  begin
    perform public.get_code_qa_skill_catalog(v_turn_id, 'worker-qa-skill', gen_random_uuid());
    perform pg_temp.assert(false, 'wrong claim token must not get the catalog');
  exception when others then
    perform pg_temp.assert(sqlerrm like '%TASK_LEASE_LOST%', 'gated by lease: ' || sqlerrm);
  end;
  begin
    perform public.get_code_qa_skill_catalog(v_turn_id, 'another-worker', v_token);
    perform pg_temp.assert(false, 'wrong worker id must not get the catalog');
  exception when others then
    perform pg_temp.assert(sqlerrm like '%TASK_LEASE_LOST%', 'gated by worker id: ' || sqlerrm);
  end;

  ----------------------------------------------------------------------------
  -- 6. 授权面：Worker 侧那条不给 authenticated / anon。
  ----------------------------------------------------------------------------
  set local role none;
  perform pg_temp.assert(
    not has_function_privilege('authenticated',
      'public.get_code_qa_skill_catalog(uuid, text, uuid)', 'execute'),
    'get_code_qa_skill_catalog must not be executable by authenticated');
  perform pg_temp.assert(
    not has_function_privilege('anon',
      'public.get_code_qa_skill_catalog(uuid, text, uuid)', 'execute'),
    'get_code_qa_skill_catalog must not be executable by anon');
  perform pg_temp.assert(
    has_function_privilege('authenticated', 'public.code_qa_catalog()', 'execute'),
    'code_qa_catalog stays available to authenticated');

  raise notice 'V1.23b code QA skill catalog test: all assertions passed';
end;
$test$;

rollback;
