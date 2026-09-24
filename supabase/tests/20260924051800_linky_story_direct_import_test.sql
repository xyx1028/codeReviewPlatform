-- 20260924051800_linky_story_direct_import_test.sql
-- V1.20：Linky 镜像表、同步队列 fencing、导入门禁、需求上下文（含 Excel 回退）。
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
  v_admin uuid := '20000000-0000-4000-a000-000000000001';
  v_reviewer uuid := '20000000-0000-4000-a000-000000000002';
  v_viewer uuid := '20000000-0000-4000-a000-000000000003';
  v_batch uuid := '20000000-0000-4000-b000-000000000001';
  v_other_batch uuid := '20000000-0000-4000-b000-000000000002';
  v_issue_a uuid := '20000000-0000-4000-c000-00000000000a';
  v_issue_b uuid := '20000000-0000-4000-c000-00000000000b';
  v_workspace uuid := '20000000-0000-4000-d000-000000000001';
  v_sync uuid;
  v_sync_same uuid;
  v_claim jsonb;
  v_token uuid;
  v_detail jsonb;
  v_attachment uuid;
  v_story uuid;
  v_excel_story uuid;
  v_context jsonb;
  v_result jsonb;
  v_error text;
  v_count integer;
  v_rls boolean;
begin
  insert into auth.users (id, email) values
    (v_admin, 'admin_v120@example.com'),
    (v_reviewer, 'reviewer_v120@example.com'),
    (v_viewer, 'viewer_v120@example.com')
  on conflict (id) do nothing;
  insert into public.user_profile (id, role) values
    (v_admin, 'ADMIN'),
    (v_reviewer, 'REVIEWER'),
    (v_viewer, 'VIEWER')
  on conflict (id) do update set role = excluded.role;

  insert into public.review_batch (id, name, week_code, status, default_branch, created_by) values
    (v_batch, 'V1.20 Linky 批次', 'V120-W01', 'DRAFT', 'feature_dev', v_reviewer),
    (v_other_batch, 'V1.20 他人批次', 'V120-W02', 'DRAFT', 'feature_dev', v_admin);

  ----------------------------------------------------------------------------
  -- 1. 镜像与队列：RLS 开启，authenticated 只读，Worker RPC 只给 service_role。
  ----------------------------------------------------------------------------
  select relrowsecurity into v_rls
  from pg_class where oid = 'public.linky_story_catalog'::regclass;
  perform pg_temp.assert(v_rls, 'linky_story_catalog has RLS enabled');

  perform pg_temp.assert(
    has_table_privilege('authenticated', 'public.linky_story_catalog', 'select')
    and not has_table_privilege('authenticated', 'public.linky_story_catalog', 'insert')
    and not has_table_privilege('authenticated', 'public.linky_story_catalog', 'update')
    and not has_table_privilege('authenticated', 'public.linky_story_catalog', 'delete'),
    'catalog mirror is read-only for authenticated'
  );
  perform pg_temp.assert(
    not has_table_privilege('anon', 'public.linky_story_catalog', 'select')
    and not has_table_privilege('anon', 'public.linky_sync_request', 'select')
    and not has_table_privilege('anon', 'public.review_story_attachment', 'select'),
    'anon cannot read any V1.20 table'
  );
  perform pg_temp.assert(
    has_table_privilege('authenticated', 'public.review_story_attachment', 'select')
    and not has_table_privilege('authenticated', 'public.review_story_attachment', 'insert'),
    'frozen attachments are read-only for authenticated'
  );

  perform pg_temp.assert(
    not has_function_privilege('authenticated', 'public.claim_next_linky_sync(text,integer)', 'execute')
    and not has_function_privilege('authenticated', 'public.upsert_linky_story_catalog(uuid,text,uuid,jsonb)', 'execute')
    and not has_function_privilege('authenticated', 'public.upsert_linky_story_detail(uuid,text,uuid,uuid,jsonb,jsonb)', 'execute')
    and not has_function_privilege('authenticated', 'public.record_linky_catalog_attachment(uuid,text,uuid,uuid,text,text,text,bigint,text)', 'execute')
    and not has_function_privilege('authenticated', 'public.complete_linky_sync(uuid,text,uuid,integer,integer,integer,integer,bigint)', 'execute')
    and not has_function_privilege('authenticated', 'public.list_linky_catalog_attachments_for_cleanup(integer,integer)', 'execute'),
    'worker-only RPCs are not granted to authenticated'
  );
  perform pg_temp.assert(
    has_function_privilege('authenticated', 'public.enqueue_linky_sync(text,uuid,text,text)', 'execute')
    and has_function_privilege('authenticated', 'public.import_linky_stories_from_catalog(uuid,uuid[],boolean)', 'execute')
    and has_function_privilege('authenticated', 'public.get_linky_catalog_facets(uuid)', 'execute'),
    'user-facing RPCs are granted to authenticated'
  );

  ----------------------------------------------------------------------------
  -- 2. enqueue_linky_sync：角色门禁、范围校验、幂等合并、冷却。
  ----------------------------------------------------------------------------
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_viewer::text, 'role', 'authenticated')::text, true);
  begin
    perform public.enqueue_linky_sync('LIST', null, null, null);
    raise exception 'VIEWER must not enqueue a sync';
  exception when others then
    v_error := SQLERRM;
    perform pg_temp.assert(v_error like '%LINKY_SYNC_FORBIDDEN%', 'VIEWER enqueue is rejected');
  end;

  perform set_config('request.jwt.claims',
    json_build_object('sub', v_reviewer::text, 'role', 'authenticated')::text, true);

  begin
    perform public.enqueue_linky_sync('FULL', null, null, null);
    raise exception 'FULL without a workspace must fail';
  exception when others then
    v_error := SQLERRM;
    perform pg_temp.assert(v_error like '%LINKY_SYNC_SCOPE_REQUIRED%',
      'FULL sync requires a workspace scope');
  end;

  begin
    perform public.enqueue_linky_sync('EVERYTHING', null, null, null);
    raise exception 'unknown depth must fail';
  exception when others then
    v_error := SQLERRM;
    perform pg_temp.assert(v_error like '%LINKY_SYNC_DEPTH_INVALID%', 'depth is validated');
  end;

  v_sync := public.enqueue_linky_sync('FULL', v_workspace, '工具开发组', 'R20261016');
  v_sync_same := public.enqueue_linky_sync('FULL', v_workspace, '工具开发组', 'R20261016');
  perform pg_temp.assert(v_sync = v_sync_same, 'same scope merges into one active request');
  select count(*) into v_count from public.linky_sync_request where scope_key like 'FULL|%';
  perform pg_temp.assert(v_count = 1, 'merging does not create a second row');

  begin
    perform public.enqueue_linky_sync('LIST', null, null, null);
    raise exception 'cooldown must reject a second scope within 30s';
  exception when others then
    v_error := SQLERRM;
    perform pg_temp.assert(v_error like '%LINKY_SYNC_TOO_FREQUENT%', 'per-user cooldown applies');
  end;

  ----------------------------------------------------------------------------
  -- 3. Worker 链路：claim → upsert 列表 → upsert 详情 → 附件 → complete。
  ----------------------------------------------------------------------------
  perform set_config('request.jwt.claims', null, true);
  set local role service_role;

  v_claim := public.claim_next_linky_sync('worker-v120', 600);
  perform pg_temp.assert(v_claim is not null and (v_claim ->> 'id')::uuid = v_sync,
    'the queued request is claimable');
  v_token := (v_claim ->> 'claim_token')::uuid;
  perform pg_temp.assert(v_claim ? 'claim_token' and not v_claim ? 'claim_token_digest',
    'claim returns the token but never the digest');
  perform pg_temp.assert(
    public.heartbeat_linky_sync(v_sync, 'worker-v120', v_token, 600),
    'heartbeat renews the lease'
  );
  perform pg_temp.assert(
    not public.heartbeat_linky_sync(v_sync, 'worker-v120', gen_random_uuid(), 600),
    'a wrong claim token cannot renew the lease'
  );
  perform pg_temp.assert(public.claim_next_linky_sync('worker-other', 600) is null,
    'a leased request is not handed to a second worker');

  perform pg_temp.assert(
    public.upsert_linky_story_catalog(v_sync, 'worker-v120', v_token, jsonb_build_array(
      jsonb_build_object(
        'issue_id', v_issue_a, 'story_code', 'US-2026-012147', 'title', 'mcphub 增加 oauth 无 secret 鉴权',
        'workspace_id', v_workspace, 'workspace_name', '工具开发组',
        'status_label', '需求编写完成', 'assignee_name', '何翘楚',
        'iteration', '202610-1（0928-1016）', 'release_window', 'R20261016',
        'subject_name', '【MCP】能力增强与体验优化'
      ),
      jsonb_build_object(
        'issue_id', v_issue_b, 'story_code', 'US-2026-011941', 'title', 'MCP HUB 上架增加可见范围',
        'workspace_id', v_workspace, 'workspace_name', '工具开发组',
        'status_label', '需求编写完成', 'assignee_name', '何翘楚',
        'iteration', '202610-1（0928-1016）', 'release_window', 'R20261016',
        'subject_name', '【MCP】能力增强与体验优化'
      ),
      -- 缺字段的条目被静默跳过，不许整批失败。
      jsonb_build_object('issue_id', null, 'story_code', 'US-BROKEN')
    )) = 2,
    'list upsert writes exactly the well-formed items'
  );

  begin
    perform public.upsert_linky_story_catalog(v_sync, 'worker-v120', gen_random_uuid(), '[]'::jsonb);
    raise exception 'a wrong claim token must not write the mirror';
  exception when others then
    v_error := SQLERRM;
    perform pg_temp.assert(v_error like '%LINKY_SYNC_LEASE_LOST%', 'mirror writes are fenced');
  end;

  v_detail := public.upsert_linky_story_detail(
    v_sync, 'worker-v120', v_token, v_issue_a,
    jsonb_build_object(
      'requirement_detail', 'mcphub 需要支持标准 OAuth 授权码 + PKCE 模式。',
      'team', jsonb_build_object(
        'req', jsonb_build_array(jsonb_build_object('id', gen_random_uuid(), 'name', '何翘楚')),
        'dev', jsonb_build_array(
          jsonb_build_object('id', gen_random_uuid(), 'name', '王鹏程'),
          jsonb_build_object('id', gen_random_uuid(), 'name', '史陈龙')
        ),
        'test', jsonb_build_array()
      ),
      'field_values', jsonb_build_object('gf_number', 'US-2026-012147')
    ),
    jsonb_build_array(jsonb_build_object(
      'linky_attachment_id', '01a08f41-08cb-7940-9a40-05e931d46aa0',
      'filename', 'prd.html', 'content_type', 'text/html; charset=utf-8', 'size_bytes', '21465'
    ))
  );
  perform pg_temp.assert(
    jsonb_array_length(v_detail -> 'pending_attachments') = 1,
    'a brand new attachment is reported as pending download'
  );
  select attachment_count into v_count from public.linky_story_catalog where issue_id = v_issue_a;
  perform pg_temp.assert(v_count = 1, 'attachment_count is projected onto the catalog row');

  v_attachment := (v_detail -> 'pending_attachments' -> 0 ->> 'id')::uuid;

  begin
    perform public.record_linky_catalog_attachment(
      v_sync, 'worker-v120', v_token, v_attachment, 'STORED', null, null, null, null
    );
    raise exception 'STORED without storage_path/sha must fail';
  exception when others then
    v_error := SQLERRM;
    perform pg_temp.assert(v_error like '%LINKY_ATTACHMENT_STORAGE_REQUIRED%',
      'STORED requires both the object key and the digest');
  end;

  perform pg_temp.assert(
    public.record_linky_catalog_attachment(
      v_sync, 'worker-v120', v_token, v_attachment, 'STORED',
      'catalog/' || v_workspace || '/01a08f41-prd.html',
      'AABBCC0011223344556677889900aabbccddeeff00112233445566778899aabb', 21465, null
    ),
    'attachment download result is recorded'
  );
  perform pg_temp.assert(
    (select content_sha256 = lower(content_sha256)
     from public.linky_story_catalog_attachment where id = v_attachment),
    'the digest is normalised to lower case'
  );

  -- 第二次同步同一条详情：已 STORED 的附件不再进待下载清单。
  -- 详情 upsert 的语义是**整体替换**（team 为 null 是上游解析降级的合法结果，
  -- 不能靠"这次没传就保留上次"来掩盖），所以这里必须送完整 payload。
  v_detail := public.upsert_linky_story_detail(
    v_sync, 'worker-v120', v_token, v_issue_a,
    jsonb_build_object(
      'requirement_detail', 'mcphub 需要支持标准 OAuth 授权码 + PKCE 模式。',
      'team', jsonb_build_object(
        'req', jsonb_build_array(jsonb_build_object('name', '何翘楚')),
        'dev', jsonb_build_array(
          jsonb_build_object('name', '王鹏程'),
          jsonb_build_object('name', '史陈龙')
        ),
        'test', jsonb_build_array()
      )
    ),
    jsonb_build_array(jsonb_build_object(
      'linky_attachment_id', '01a08f41-08cb-7940-9a40-05e931d46aa0',
      'filename', 'prd.html', 'content_type', 'text/html; charset=utf-8', 'size_bytes', '21465'
    ))
  );
  perform pg_temp.assert(
    jsonb_array_length(v_detail -> 'pending_attachments') = 0,
    'an already stored attachment is not downloaded again'
  );

  perform pg_temp.assert(
    public.complete_linky_sync(v_sync, 'worker-v120', v_token, 2, 1, 1, 0, 21465),
    'sync completes under a valid lease'
  );
  perform pg_temp.assert(
    (select status = 'SUCCEEDED' and claim_token_digest is null and worker_id is null
     from public.linky_sync_request where id = v_sync),
    'completion clears the lease'
  );

  ----------------------------------------------------------------------------
  -- 4. 导入门禁。
  ----------------------------------------------------------------------------
  reset role;
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_reviewer::text, 'role', 'authenticated')::text, true);

  begin
    perform public.import_linky_stories_from_catalog(v_batch, array[]::uuid[], false);
    raise exception 'empty selection must fail';
  exception when others then
    v_error := SQLERRM;
    perform pg_temp.assert(v_error like '%LINKY_IMPORT_EMPTY_SELECTION%',
      'an empty selection is rejected');
  end;

  begin
    -- issue_b 只做过 LIST，没有正文。
    perform public.import_linky_stories_from_catalog(v_batch, array[v_issue_b], false);
    raise exception 'importing a story without requirement text must fail';
  exception when others then
    v_error := SQLERRM;
    perform pg_temp.assert(v_error like '%LINKY_DETAIL_NOT_SYNCED%',
      'a story without a FULL sync cannot be imported');
  end;

  begin
    perform public.import_linky_stories_from_catalog(
      v_batch, array['20000000-0000-4000-c000-0000000000ff'::uuid], false
    );
    raise exception 'an unknown issue must fail';
  exception when others then
    v_error := SQLERRM;
    perform pg_temp.assert(v_error like '%LINKY_STORY_NOT_IN_CATALOG%',
      'only mirrored stories can be imported');
  end;

  -- 别人创建的批次：REVIEWER 不能导入。
  begin
    perform public.import_linky_stories_from_catalog(v_other_batch, array[v_issue_a], false);
    raise exception 'a REVIEWER must not import into someone else batch';
  exception when others then
    v_error := SQLERRM;
    perform pg_temp.assert(v_error not like 'a REVIEWER must not%',
      'batch authorization is enforced by the RPC');
  end;

  -- 附件还没落盘时默认拒绝。
  set local role service_role;
  update public.linky_story_catalog_attachment
  set fetch_status = 'FAILED', fetch_error = '下载超时'
  where id = v_attachment;
  reset role;
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_reviewer::text, 'role', 'authenticated')::text, true);
  begin
    perform public.import_linky_stories_from_catalog(v_batch, array[v_issue_a], false);
    raise exception 'pending attachments must block the import by default';
  exception when others then
    v_error := SQLERRM;
    perform pg_temp.assert(v_error like '%LINKY_ATTACHMENTS_NOT_READY%',
      'missing attachment bytes block the import unless explicitly allowed');
  end;

  set local role service_role;
  update public.linky_story_catalog_attachment
  set fetch_status = 'STORED', fetch_error = null
  where id = v_attachment;
  reset role;
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_reviewer::text, 'role', 'authenticated')::text, true);

  ----------------------------------------------------------------------------
  -- 5. 导入成功：结构化字段直接落库，没有任何字段映射。
  ----------------------------------------------------------------------------
  v_result := public.import_linky_stories_from_catalog(v_batch, array[v_issue_a], false);
  perform pg_temp.assert(
    (v_result ->> 'inserted')::int = 1 and (v_result ->> 'updated')::int = 0
    and (v_result ->> 'attachments')::int = 1,
    'import reports one new story with one attachment'
  );

  select id into v_story from public.review_story
  where batch_id = v_batch and story_code = 'US-2026-012147';
  perform pg_temp.assert(v_story is not null, 'the story row exists');
  perform pg_temp.assert(
    (select source_system = 'LINKY'
        and story_name = 'mcphub 增加 oauth 无 secret 鉴权'
        and owners_text = '王鹏程、史陈龙'
        and requirement_handlers = '何翘楚'
        and test_handlers is null
        and project_name = '工具开发组'
        and iteration_name = '202610-1（0928-1016）'
        and release_window = 'R20261016'
        and source_status = '需求编写完成'
        and subject_name = '【MCP】能力增强与体验优化'
        and requirement_detail like 'mcphub 需要支持标准 OAuth%'
        and linky_issue_id = v_issue_a
        and linky_workspace_name = '工具开发组'
     from public.review_story where id = v_story),
    'every structured column is populated straight from the mirror'
  );
  perform pg_temp.assert(
    (select status = 'WAITING_AI_RESULT' from public.review_batch where id = v_batch),
    'the batch moves out of DRAFT'
  );
  perform pg_temp.assert(
    (select count(*) = 1 and bool_and(content_sha256 = lower(content_sha256))
     from public.review_story_attachment where story_id = v_story),
    'the frozen attachment references the mirrored object'
  );

  -- 再导一次同一条：更新而不是重复插入。
  v_result := public.import_linky_stories_from_catalog(v_batch, array[v_issue_a], false);
  perform pg_temp.assert(
    (v_result ->> 'inserted')::int = 0 and (v_result ->> 'updated')::int = 1,
    're-importing updates in place'
  );
  select count(*) into v_count from public.review_story where batch_id = v_batch;
  perform pg_temp.assert(v_count = 1, 'no duplicate story rows');
  select count(*) into v_count from public.review_story_attachment where story_id = v_story;
  perform pg_temp.assert(v_count = 1, 'no duplicate attachment rows');

  ----------------------------------------------------------------------------
  -- 6. 需求上下文：LINKY 读结构化列，Excel 历史批次回退到中文列名。
  ----------------------------------------------------------------------------
  select public.review_story_requirement_context(story) into v_context
  from public.review_story story where story.id = v_story;
  perform pg_temp.assert(
    v_context ->> 'detailed_description' like 'mcphub 需要支持标准 OAuth%'
    and v_context ->> 'related_features' = '【MCP】能力增强与体验优化'
    and v_context ->> 'iteration' = '202610-1（0928-1016）'
    and v_context ->> 'source_status' = '需求编写完成'
    and jsonb_array_length(v_context -> 'attachments') = 1
    and v_context -> 'attachments' -> 0 ->> 'filename' = 'prd.html',
    'LINKY stories expose requirement text and attachments to the freeze step'
  );

  insert into public.review_story (
    batch_id, story_code, story_name, owners_text, source_data
  ) values (
    v_batch, 'EXCEL-0001', '历史 Excel 需求', '张三',
    jsonb_build_object('详细描述', '这是 Excel 时代的需求正文', '关联特性', '旧特性')
  ) returning id into v_excel_story;

  select public.review_story_requirement_context(story) into v_context
  from public.review_story story where story.id = v_excel_story;
  perform pg_temp.assert(
    v_context ->> 'detailed_description' = '这是 Excel 时代的需求正文'
    and v_context ->> 'related_features' = '旧特性'
    and not v_context ? 'attachments',
    'Excel-era batches keep working through the source_data fallback'
  );

  ----------------------------------------------------------------------------
  -- 7. 辅助函数与清理契约。
  ----------------------------------------------------------------------------
  perform pg_temp.assert(public.linky_team_names(null, 'dev') is null,
    'a missing team never fabricates names');
  perform pg_temp.assert(
    public.linky_team_names(jsonb_build_object('dev', jsonb_build_array(
      jsonb_build_object('name', '甲'), jsonb_build_object('name', ' '),
      jsonb_build_object('name', '乙')
    )), 'dev') = '甲、乙',
    'blank names are dropped and the rest joined with the platform separator'
  );

  set local role service_role;
  perform pg_temp.assert(
    public.linky_catalog_attachment_is_referenced(
      'catalog/' || v_workspace || '/01a08f41-prd.html'
    ),
    'an imported attachment object counts as referenced'
  );
  -- 被引用的对象既不出现在清理清单里，也不能被标记为已清理。
  update public.linky_story_catalog_attachment
  set synced_at = now() - interval '90 days' where id = v_attachment;
  perform pg_temp.assert(
    jsonb_array_length(public.list_linky_catalog_attachments_for_cleanup(30, 100)) = 0,
    'referenced objects are excluded from cleanup even when old'
  );
  perform pg_temp.assert(
    not public.mark_linky_catalog_attachment_purged(v_attachment),
    'a referenced attachment cannot be marked purged'
  );

  delete from public.review_story_attachment where story_id = v_story;
  perform pg_temp.assert(
    jsonb_array_length(public.list_linky_catalog_attachments_for_cleanup(30, 100)) = 1,
    'an unreferenced old object becomes eligible for cleanup'
  );
  perform pg_temp.assert(
    public.mark_linky_catalog_attachment_purged(v_attachment),
    'purging resets the row so a later FULL sync re-downloads it'
  );
  perform pg_temp.assert(
    (select fetch_status = 'PENDING' and storage_path is null and content_sha256 is null
     from public.linky_story_catalog_attachment where id = v_attachment),
    'purged rows keep their metadata but lose the object reference'
  );
  reset role;

  ----------------------------------------------------------------------------
  -- 8. 分面 RPC 返回真实计数。
  ----------------------------------------------------------------------------
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_reviewer::text, 'role', 'authenticated')::text, true);
  v_result := public.get_linky_catalog_facets(v_workspace);
  perform pg_temp.assert((v_result ->> 'total')::int = 2, 'facets count the mirrored stories');
  perform pg_temp.assert(
    exists (
      select 1 from jsonb_array_elements(v_result -> 'release_windows') as entry(item)
      where item ->> 'value' = 'R20261016' and (item ->> 'count')::int = 2
    ),
    'release window facet is derived from real data'
  );

  ----------------------------------------------------------------------------
  -- 9. Storage bucket 与删除保护。
  ----------------------------------------------------------------------------
  perform pg_temp.assert(
    exists (select 1 from storage.buckets where id = 'story-attachments' and not public),
    'the story-attachments bucket exists and is private'
  );
  perform pg_temp.assert(
    not exists (
      select 1 from pg_policies
      where schemaname = 'storage' and tablename = 'objects'
        and cmd in ('INSERT', 'UPDATE', 'DELETE')
        and qual is not null
        and qual like '%story-attachments%'
    ),
    'browsers get no write policy on the attachment bucket'
  );
end;
$test$;

select 'ALL_LINKY_STORY_DIRECT_IMPORT_TESTS_PASSED' as result;

rollback;
