-- 20260924061500_linky_live_board_and_batch_import_test.sql
-- V1.20 修订：批次导入单的权限、fencing、逐条提交与批次状态推进。
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
  v_admin uuid := '21000000-0000-4000-a000-000000000001';
  v_reviewer uuid := '21000000-0000-4000-a000-000000000002';
  v_viewer uuid := '21000000-0000-4000-a000-000000000003';
  v_batch uuid := '21000000-0000-4000-b000-000000000001';
  v_other_batch uuid := '21000000-0000-4000-b000-000000000002';
  v_request uuid;
  v_same uuid;
  v_claim jsonb;
  v_token uuid;
  v_story uuid;
  v_context jsonb;
  v_error text;
  v_count integer;
  v_rls boolean;
begin
  insert into auth.users (id, email) values
    (v_admin, 'admin_v120r@example.com'),
    (v_reviewer, 'reviewer_v120r@example.com'),
    (v_viewer, 'viewer_v120r@example.com')
  on conflict (id) do nothing;
  insert into public.user_profile (id, role) values
    (v_admin, 'ADMIN'), (v_reviewer, 'REVIEWER'), (v_viewer, 'VIEWER')
  on conflict (id) do update set role = excluded.role;

  insert into public.review_batch (id, name, week_code, status, default_branch, created_by) values
    (v_batch, 'V1.20 实时导入', 'V120R-W01', 'DRAFT', 'feature_dev', v_reviewer),
    (v_other_batch, 'V1.20 他人批次', 'V120R-W02', 'DRAFT', 'feature_dev', v_admin);

  ----------------------------------------------------------------------------
  -- 1. 权限与 RLS。
  ----------------------------------------------------------------------------
  select relrowsecurity into v_rls
  from pg_class where oid = 'public.linky_batch_import_request'::regclass;
  perform pg_temp.assert(v_rls, 'import queue has RLS enabled');
  perform pg_temp.assert(
    has_table_privilege('authenticated', 'public.linky_batch_import_request', 'select')
    and not has_table_privilege('authenticated', 'public.linky_batch_import_request', 'insert')
    and not has_table_privilege('anon', 'public.linky_batch_import_request', 'select'),
    'import queue is read-only for authenticated and invisible to anon'
  );
  perform pg_temp.assert(
    not has_function_privilege('authenticated', 'public.claim_next_linky_batch_import(text,integer)', 'execute')
    and not has_function_privilege('authenticated', 'public.commit_linky_batch_story(uuid,text,uuid,jsonb,jsonb)', 'execute')
    and not has_function_privilege('authenticated', 'public.complete_linky_batch_import(uuid,text,uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public.unreferenced_story_attachment_paths(text[])', 'execute'),
    'worker-only RPCs are not granted to authenticated'
  );
  perform pg_temp.assert(
    has_function_privilege('authenticated', 'public.request_linky_batch_import(uuid,text,text[],uuid,text)', 'execute')
    and has_function_privilege('authenticated', 'public.get_latest_linky_batch_import(uuid)', 'execute'),
    'user-facing RPCs are granted to authenticated'
  );

  ----------------------------------------------------------------------------
  -- 2. 下单：角色、范围、勾选校验、幂等。
  ----------------------------------------------------------------------------
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_viewer::text, 'role', 'authenticated')::text, true);
  begin
    perform public.request_linky_batch_import(v_batch, '工具开发组', array['US-1']);
    raise exception 'VIEWER must not request an import';
  exception when others then
    v_error := SQLERRM;
    perform pg_temp.assert(v_error not like 'VIEWER must not%', 'VIEWER is rejected');
  end;

  perform set_config('request.jwt.claims',
    json_build_object('sub', v_reviewer::text, 'role', 'authenticated')::text, true);

  begin
    perform public.request_linky_batch_import(v_batch, '   ', array['US-1']);
    raise exception 'empty workspace must fail';
  exception when others then
    v_error := SQLERRM;
    perform pg_temp.assert(v_error like '%LINKY_IMPORT_WORKSPACE_REQUIRED%',
      'workspace defines where this batch requirements come from');
  end;

  begin
    perform public.request_linky_batch_import(v_batch, '工具开发组', array[]::text[]);
    raise exception 'empty selection must fail';
  exception when others then
    v_error := SQLERRM;
    perform pg_temp.assert(v_error like '%LINKY_IMPORT_EMPTY_SELECTION%', 'empty selection rejected');
  end;

  begin
    perform public.request_linky_batch_import(v_other_batch, '工具开发组', array['US-1']);
    raise exception 'a REVIEWER must not import into someone else batch';
  exception when others then
    v_error := SQLERRM;
    perform pg_temp.assert(v_error not like 'a REVIEWER must not%',
      'batch authorization is enforced by the RPC');
  end;

  v_request := public.request_linky_batch_import(
    v_batch, '工具开发组', array['US-2026-012147', 'US-2026-011941', '  ', 'US-2026-012147'],
    null, 'R20261016'
  );
  perform pg_temp.assert(
    (select array_length(story_codes, 1) = 2 and stories_total = 2
     from public.linky_batch_import_request where id = v_request),
    'story codes are de-duplicated and blanks dropped'
  );
  v_same := public.request_linky_batch_import(v_batch, '工具开发组', array['US-2026-012147']);
  perform pg_temp.assert(v_request = v_same, 'one active request per batch (idempotent)');
  select count(*) into v_count from public.linky_batch_import_request where batch_id = v_batch;
  perform pg_temp.assert(v_count = 1, 'no second row for the same batch');

  ----------------------------------------------------------------------------
  -- 3. Worker 链路：claim → 逐条提交 → complete。
  ----------------------------------------------------------------------------
  perform set_config('request.jwt.claims', null, true);
  set local role service_role;

  v_claim := public.claim_next_linky_batch_import('worker-v120r', 900);
  perform pg_temp.assert(v_claim is not null and (v_claim ->> 'id')::uuid = v_request,
    'the queued request is claimable');
  v_token := (v_claim ->> 'claim_token')::uuid;
  perform pg_temp.assert(v_claim ? 'claim_token' and not v_claim ? 'claim_token_digest',
    'claim returns the token but never the digest');
  perform pg_temp.assert(public.claim_next_linky_batch_import('worker-other', 900) is null,
    'a leased request is not handed to a second worker');
  perform pg_temp.assert(
    public.heartbeat_linky_batch_import(v_request, 'worker-v120r', v_token, 900),
    'heartbeat renews the lease'
  );
  perform pg_temp.assert(
    not public.heartbeat_linky_batch_import(v_request, 'worker-v120r', gen_random_uuid(), 900),
    'a wrong claim token cannot renew the lease'
  );

  -- 正文与附件都为空的故事也允许导入（2026-09-24 起撤掉了那道门禁），
  -- 相关断言见 20260924080010_linky_import_allow_title_only_test.sql。

  -- 不在单子上的编号不许提交。
  begin
    perform public.commit_linky_batch_story(v_request, 'worker-v120r', v_token,
      jsonb_build_object('story_code', 'US-9999', 'title', 'x', 'requirement_detail', 'y'),
      '[]'::jsonb);
    raise exception 'an unrequested story must be rejected';
  exception when others then
    v_error := SQLERRM;
    perform pg_temp.assert(v_error like '%LINKY_IMPORT_STORY_NOT_REQUESTED%',
      'only the stories on this request may be committed');
  end;

  -- 租约不对时不许写。
  begin
    perform public.commit_linky_batch_story(v_request, 'worker-v120r', gen_random_uuid(),
      jsonb_build_object('story_code', 'US-2026-012147', 'title', 'x', 'requirement_detail', 'y'),
      '[]'::jsonb);
    raise exception 'a wrong claim token must not write review_story';
  exception when others then
    v_error := SQLERRM;
    perform pg_temp.assert(v_error like '%LINKY_IMPORT_LEASE_LOST%', 'commits are fenced');
  end;

  v_story := public.commit_linky_batch_story(v_request, 'worker-v120r', v_token,
    jsonb_build_object(
      'story_code', 'US-2026-012147',
      'issue_id', '3677a47f-94ef-45ce-b279-c3ee8e97be13',
      'title', 'mcphub 增加 oauth 无 secret 鉴权',
      'workspace_id', '3bb2fffc-1b01-49a5-8e01-f1890d687894',
      'workspace_name', '工具开发组',
      'status_label', '需求编写完成',
      'assignee_name', '何翘楚',
      'iteration', '202610-1（0928-1016）',
      'release_window', 'R20261016',
      'subject_name', '【MCP】能力增强与体验优化',
      'requirement_detail', 'mcphub 需要支持标准 OAuth 授权码 + PKCE 模式。',
      'team', jsonb_build_object(
        'req', jsonb_build_array(jsonb_build_object('name', '何翘楚')),
        'dev', jsonb_build_array(jsonb_build_object('name', '王鹏程'), jsonb_build_object('name', '史陈龙')),
        'test', jsonb_build_array()
      ),
      'field_values', jsonb_build_object('gf_number', 'US-2026-012147')
    ),
    jsonb_build_array(jsonb_build_object(
      'linky_attachment_id', '01a08f41-08cb-7940-9a40-05e931d46aa0',
      'filename', 'prd.html',
      'content_type', 'text/html; charset=utf-8',
      'size_bytes', '21465',
      'storage_path', 'batch/' || v_batch || '/01a08f41-08cb-7940-9a40-05e931d46aa0.html',
      'sha256', 'AABBCC0011223344556677889900aabbccddeeff00112233445566778899aabb'
    ))
  );
  perform pg_temp.assert(v_story is not null, 'the story row is created');
  perform pg_temp.assert(
    (select source_system = 'LINKY'
        and owners_text = '王鹏程、史陈龙'
        and requirement_handlers = '何翘楚'
        and test_handlers is null
        and project_name = '工具开发组'
        and iteration_name = '202610-1（0928-1016）'
        and release_window = 'R20261016'
        and source_status = '需求编写完成'
        and subject_name = '【MCP】能力增强与体验优化'
        and requirement_detail like 'mcphub 需要支持标准 OAuth%'
     from public.review_story where id = v_story),
    'structured columns are populated from the worker payload'
  );
  perform pg_temp.assert(
    (select count(*) = 1 and bool_and(content_sha256 = lower(content_sha256))
     from public.review_story_attachment where story_id = v_story),
    'the attachment row is frozen with a lower-case digest'
  );
  perform pg_temp.assert(
    (select stories_committed = 1 and attachments_stored = 1
     from public.linky_batch_import_request where id = v_request),
    'progress counters advance per story'
  );

  -- 重复提交同一条：更新而不是重复插入，附件整段重放。
  -- 提交的语义是**整体替换**（Worker 每次都送完整 payload），所以这里也送全字段；
  -- 只送一半会把没送的列覆盖成 null —— 那是正确行为，不是 bug。
  perform public.commit_linky_batch_story(v_request, 'worker-v120r', v_token,
    jsonb_build_object('story_code', 'US-2026-012147', 'title', '改了标题',
      'requirement_detail', '改了正文', 'workspace_name', '工具开发组',
      'iteration', '202610-1（0928-1016）', 'release_window', 'R20261016',
      'status_label', '需求编写完成', 'subject_name', '【MCP】能力增强与体验优化'),
    '[]'::jsonb);
  select count(*) into v_count from public.review_story where batch_id = v_batch;
  perform pg_temp.assert(v_count = 1, 'no duplicate story rows');
  select count(*) into v_count from public.review_story_attachment where story_id = v_story;
  perform pg_temp.assert(v_count = 0, 'attachments are replayed, not accumulated');

  -- 再提交一次（完整 payload + 一个新附件），供后面的孤儿判定用例使用。
  perform public.commit_linky_batch_story(v_request, 'worker-v120r', v_token,
    jsonb_build_object('story_code', 'US-2026-012147', 'title', '改了标题',
      'requirement_detail', '改了正文', 'workspace_name', '工具开发组',
      'iteration', '202610-1（0928-1016）', 'release_window', 'R20261016',
      'status_label', '需求编写完成', 'subject_name', '【MCP】能力增强与体验优化'),
    jsonb_build_array(jsonb_build_object(
      'linky_attachment_id', 'att-x', 'filename', 'a.md', 'size_bytes', '10',
      'storage_path', 'batch/' || v_batch || '/att-x.md',
      'sha256', repeat('a', 64)
    ))
  );

  perform pg_temp.assert(
    public.record_linky_batch_story_failure(v_request, 'worker-v120r', v_token,
      'US-2026-011941', 'LINKY_NOT_FOUND', '上游删了', 0),
    'per-story failures are recorded'
  );
  perform pg_temp.assert(
    (select jsonb_array_length(stories_failed) = 1
        and stories_failed -> 0 ->> 'story_code' = 'US-2026-011941'
     from public.linky_batch_import_request where id = v_request),
    'the failure list names the story and the reason'
  );

  perform pg_temp.assert(
    public.complete_linky_batch_import(v_request, 'worker-v120r', v_token),
    'the request completes under a valid lease'
  );
  perform pg_temp.assert(
    (select status = 'SUCCEEDED' and claim_token_digest is null and worker_id is null
     from public.linky_batch_import_request where id = v_request),
    'completion clears the lease'
  );
  perform pg_temp.assert(
    (select status = 'WAITING_AI_RESULT' from public.review_batch where id = v_batch),
    'the batch moves out of DRAFT once at least one story landed'
  );

  ----------------------------------------------------------------------------
  -- 4. 需求上下文仍然从结构化列取（冻结函数共用它）。
  ----------------------------------------------------------------------------
  reset role;
  select public.review_story_requirement_context(story) into v_context
  from public.review_story story where story.id = v_story;
  perform pg_temp.assert(
    v_context ->> 'detailed_description' = '改了正文'
      and v_context ->> 'iteration' = '202610-1（0928-1016）'
      and v_context ->> 'related_features' = '【MCP】能力增强与体验优化'
      and jsonb_array_length(v_context -> 'attachments') = 1
      and v_context -> 'attachments' -> 0 ->> 'filename' = 'a.md',
    'requirement context reads the structured columns and the frozen attachments'
  );

  ----------------------------------------------------------------------------
  -- 5. 附件对象的孤儿判定。
  ----------------------------------------------------------------------------
  set local role service_role;
  perform pg_temp.assert(
    public.unreferenced_story_attachment_paths(array[
      'batch/' || v_batch || '/att-x.md',
      'batch/' || v_batch || '/never-referenced.md'
    ]) = array['batch/' || v_batch || '/never-referenced.md'],
    'only unreferenced objects are eligible for cleanup'
  );
  reset role;
end;
$test$;

select 'ALL_LINKY_LIVE_BOARD_TESTS_PASSED' as result;

rollback;
