-- 只有标题的需求也允许导入（2026-09-24 产品决定撤掉 LINKY_IMPORT_STORY_NO_REQUIREMENT_SOURCE）。
--
-- 这份测试盯住三件事：
--   1. 正文空、附件 0 个时提交成功，且 requirement_detail 落 null（不用标题伪造正文）；
--   2. 附件形状不合法（缺 sha256）时故事仍然入库，只是附件行为 0 —— 以前这会整条拒绝；
--   3. 仍然保留的两道门禁（编号必填、必须在单子上）没有被一起撤掉。
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
  v_admin uuid := '22000000-0000-4000-a000-000000000001';
  v_batch uuid := '22000000-0000-4000-b000-000000000001';
  v_request uuid;
  v_claim jsonb;
  v_token uuid;
  v_story uuid;
  v_context jsonb;
  v_error text;
  v_count integer;
begin
  insert into auth.users (id, email) values (v_admin, 'admin_title_only@example.com')
  on conflict (id) do nothing;
  insert into public.user_profile (id, role) values (v_admin, 'ADMIN')
  on conflict (id) do update set role = excluded.role;
  insert into public.review_batch (id, name, week_code, status, default_branch, created_by) values
    (v_batch, '只有标题的需求', 'TITLE-ONLY-W01', 'DRAFT', 'feature_dev', v_admin);

  perform set_config('request.jwt.claims',
    json_build_object('sub', v_admin::text, 'role', 'authenticated')::text, true);
  v_request := public.request_linky_batch_import(
    v_batch, '工具开发组', array['US-2026-009302', 'US-2026-009306'], null, 'R20260918'
  );

  perform set_config('request.jwt.claims', null, true);
  set local role service_role;
  v_claim := public.claim_next_linky_batch_import('worker-title-only', 900);
  v_token := (v_claim ->> 'claim_token')::uuid;

  ----------------------------------------------------------------------------
  -- 1. 正文空 + 附件 0 个：照样入库。
  ----------------------------------------------------------------------------
  v_story := public.commit_linky_batch_story(v_request, 'worker-title-only', v_token,
    jsonb_build_object(
      'story_code', 'US-2026-009302',
      'title', '【console】新增SaaS连接器做账套唯一性校验',
      'workspace_name', '工具开发组',
      'status_label', '基线测试完成'
    ),
    '[]'::jsonb);
  perform pg_temp.assert(v_story is not null, 'a title-only story is imported');
  perform pg_temp.assert(
    (select requirement_detail is null
        and story_name = '【console】新增SaaS连接器做账套唯一性校验'
        and source_system = 'LINKY'
     from public.review_story where id = v_story),
    'the title is stored as story_name and requirement_detail stays null'
  );
  select count(*) into v_count from public.review_story_attachment where story_id = v_story;
  perform pg_temp.assert(v_count = 0, 'no attachment rows are invented');

  -- 提示词上下文里 detailed_description 这个键必须缺席，而不是被标题填上。
  select public.review_story_requirement_context(story.*) into v_context
  from public.review_story story where story.id = v_story;
  perform pg_temp.assert(not (v_context ? 'detailed_description'),
    'an empty requirement body is absent from the prompt context, not faked from the title');

  ----------------------------------------------------------------------------
  -- 2. 附件形状不合法：故事仍然入库，附件行为 0。
  ----------------------------------------------------------------------------
  v_story := public.commit_linky_batch_story(v_request, 'worker-title-only', v_token,
    jsonb_build_object('story_code', 'US-2026-009306', 'title', 'mcp-hub 增加云之家鉴权'),
    jsonb_build_array(jsonb_build_object('linky_attachment_id', 'bad', 'filename', 'b.md')));
  perform pg_temp.assert(v_story is not null, 'a malformed attachment no longer blocks the story');
  select count(*) into v_count from public.review_story_attachment where story_id = v_story;
  perform pg_temp.assert(v_count = 0, 'malformed attachment rows are dropped');

  perform pg_temp.assert(
    (select stories_committed = 2 and attachments_stored = 0
     from public.linky_batch_import_request where id = v_request),
    'both title-only stories advance the counters'
  );

  ----------------------------------------------------------------------------
  -- 3. 保留的门禁没有被一起撤掉。
  ----------------------------------------------------------------------------
  begin
    perform public.commit_linky_batch_story(v_request, 'worker-title-only', v_token,
      jsonb_build_object('story_code', '   ', 'title', 'x'), '[]'::jsonb);
    raise exception 'a story without a code must still be rejected';
  exception when others then
    v_error := SQLERRM;
    perform pg_temp.assert(v_error like '%LINKY_IMPORT_STORY_CODE_REQUIRED%',
      'the story code is still required');
  end;

  begin
    perform public.commit_linky_batch_story(v_request, 'worker-title-only', v_token,
      jsonb_build_object('story_code', 'US-9999', 'title', 'x'), '[]'::jsonb);
    raise exception 'an unrequested story must still be rejected';
  exception when others then
    v_error := SQLERRM;
    perform pg_temp.assert(v_error like '%LINKY_IMPORT_STORY_NOT_REQUESTED%',
      'only the stories on this request may be committed');
  end;

  raise notice 'title-only import test passed';
end;
$test$;

select 'ALL_TITLE_ONLY_IMPORT_TESTS_PASSED' as result;

rollback;
