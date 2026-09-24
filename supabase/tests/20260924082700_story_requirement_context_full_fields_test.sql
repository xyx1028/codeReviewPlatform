--
-- V1.21：需求全量上下文冻结函数测试。
--
-- 盯住四件事：
--   1. LINKY 故事的全部需求字段都进 requirement_context（这次新增的 9 个键逐个断言）；
--   2. source_fields 按来源分流：LINKY 给 field_values，EXCEL 给整行 source_data，
--      且 LINKY 的 list_item **不**混进来；
--   3. EXCEL 历史批次的正文回退链没退化（requirement_detail → description → 详细描述）；
--   4. 空值仍然让键缺席，而不是塞空串或用标题伪造正文（20260924080010 的行为保持不变）。
--
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
  v_admin uuid := '23000000-0000-4000-a000-000000000001';
  v_batch uuid := '23000000-0000-4000-b000-000000000001';
  v_linky uuid := '23000000-0000-4000-c000-000000000001';
  v_excel uuid := '23000000-0000-4000-c000-000000000002';
  v_legacy uuid := '23000000-0000-4000-c000-000000000003';
  v_bare uuid := '23000000-0000-4000-c000-000000000004';
  v_ctx jsonb;
begin
  insert into auth.users (id, email) values (v_admin, 'admin_req_ctx@example.com')
  on conflict (id) do nothing;
  insert into public.user_profile (id, role) values (v_admin, 'ADMIN')
  on conflict (id) do update set role = excluded.role;
  insert into public.review_batch (id, name, week_code, status, default_branch, created_by) values
    (v_batch, '需求全量上下文', 'REQCTX-W01', 'DRAFT', 'feature_dev', v_admin);

  --------------------------------------------------------------------------
  -- 1. LINKY 故事：全部字段。
  --------------------------------------------------------------------------
  insert into public.review_story (
    id, batch_id, story_code, story_name, owners_text,
    requirement_handlers, test_handlers, project_name, cloud_name, application_name,
    iteration_name, release_window, source_status, source_data, source_system,
    requirement_detail, subject_name, story_url
  ) values (
    v_linky, v_batch, 'US-2026-009302', '【console】新增SaaS连接器做账套唯一性校验',
    '张三、李四',
    '王五', '赵六', '工具开发组', '协同云', 'console',
    '2026年9月迭代', 'R20260918', '基线测试完成',
    jsonb_build_object(
      'source', 'LINKY',
      'field_values', jsonb_build_object(
        'gf_description', '正文原文',
        'gf_name', '【console】新增SaaS连接器做账套唯一性校验',
        'tf_custom_priority', '高'
      ),
      'list_item', jsonb_build_object('status', '基线测试完成', 'noise', 'list-only')
    ),
    'LINKY', '需求正文：账套唯一性校验', '连接器治理', 'https://linky.example.com/i/1'
  );
  insert into public.review_story_attachment (
    story_id, linky_attachment_id, filename, content_type, size_bytes, storage_path, content_sha256
  ) values (
    v_linky, 'att-1', 'PRD.md', 'text/markdown', 128,
    'batch/23000000-0000-4000-b000-000000000001/att-1.md', repeat('a', 64)
  );

  select public.review_story_requirement_context(story.*) into v_ctx
  from public.review_story story where story.id = v_linky;

  perform pg_temp.assert(v_ctx ->> 'story_code' = 'US-2026-009302', 'story_code is frozen');
  perform pg_temp.assert(
    v_ctx ->> 'story_name' = '【console】新增SaaS连接器做账套唯一性校验', 'story_name is frozen');
  perform pg_temp.assert(v_ctx ->> 'source_system' = 'LINKY', 'source_system is frozen');
  perform pg_temp.assert(
    v_ctx ->> 'story_url' = 'https://linky.example.com/i/1', 'story_url is frozen');
  perform pg_temp.assert(
    v_ctx ->> 'detailed_description' = '需求正文：账套唯一性校验',
    'the LINKY body comes from requirement_detail');
  perform pg_temp.assert(
    not (v_ctx ? 'acceptance_criteria'),
    'Linky supplies no acceptance criteria, so the key stays absent instead of empty');
  perform pg_temp.assert(
    v_ctx ->> 'related_features' = '连接器治理', 'related features come from subject_name');
  perform pg_temp.assert(v_ctx ->> 'source_status' = '基线测试完成', 'source status is frozen');
  perform pg_temp.assert(v_ctx ->> 'iteration' = '2026年9月迭代', 'iteration is frozen');
  perform pg_temp.assert(v_ctx ->> 'release_window' = 'R20260918',
    'the release window is frozen (it used to be read by the Worker but never written)');
  perform pg_temp.assert(v_ctx ->> 'project_name' = '工具开发组', 'project name is frozen');
  perform pg_temp.assert(v_ctx ->> 'cloud_name' = '协同云', 'cloud name is frozen');
  perform pg_temp.assert(v_ctx ->> 'application_name' = 'console', 'application name is frozen');
  perform pg_temp.assert(v_ctx ->> 'developers' = '张三、李四', 'developers are frozen');
  perform pg_temp.assert(v_ctx ->> 'requirement_handlers' = '王五',
    'requirement handlers are frozen');
  perform pg_temp.assert(v_ctx ->> 'test_handlers' = '赵六', 'test handlers are frozen');

  -- source_fields：LINKY 只给 field_values，list_item 不许混进来。
  perform pg_temp.assert(
    v_ctx -> 'source_fields' ->> 'gf_description' = '正文原文',
    'LINKY source_fields carries the raw structured fields');
  perform pg_temp.assert(
    v_ctx -> 'source_fields' ->> 'tf_custom_priority' = '高',
    'fields without a dedicated column are still handed to the model');
  perform pg_temp.assert(
    not (v_ctx -> 'source_fields' ? 'noise') and not (v_ctx ? 'list_item'),
    'the list-endpoint projection is not duplicated into the context');

  perform pg_temp.assert(
    jsonb_array_length(v_ctx -> 'attachments') = 1
      and v_ctx -> 'attachments' -> 0 ->> 'filename' = 'PRD.md'
      and v_ctx -> 'attachments' -> 0 ->> 'sha256' = repeat('a', 64),
    'the attachment manifest survives the rewrite');

  --------------------------------------------------------------------------
  -- 2. EXCEL 历史批次：整行 source_data + 中文列名回退。
  --------------------------------------------------------------------------
  insert into public.review_story (
    id, batch_id, story_code, story_name, owners_text, source_data
  ) values (
    v_excel, v_batch, 'EX-001', 'Excel 老需求', '孙七',
    jsonb_build_object('详细描述', 'Excel 里的需求正文', '验收标准', '可导出 CSV',
                       '关联特性', '导出能力', '其它列', '也要给 AI')
  );

  select public.review_story_requirement_context(story.*) into v_ctx
  from public.review_story story where story.id = v_excel;

  perform pg_temp.assert(v_ctx ->> 'source_system' = 'EXCEL', 'EXCEL stays the default source');
  perform pg_temp.assert(
    v_ctx ->> 'detailed_description' = 'Excel 里的需求正文',
    'the EXCEL body still falls back to source_data->>详细描述');
  perform pg_temp.assert(
    v_ctx ->> 'acceptance_criteria' = '可导出 CSV', 'EXCEL acceptance criteria fall back too');
  perform pg_temp.assert(
    v_ctx ->> 'related_features' = '导出能力', 'EXCEL related features fall back too');
  perform pg_temp.assert(
    v_ctx -> 'source_fields' ->> '其它列' = '也要给 AI',
    'the whole EXCEL row is handed over, including columns without a platform field');
  perform pg_temp.assert(
    not (v_ctx ? 'iteration') and not (v_ctx ? 'release_window')
      and not (v_ctx ? 'story_url'),
    'absent values stay absent instead of becoming empty strings');

  --------------------------------------------------------------------------
  -- 3. source_data 为空对象时不产出空壳键。
  --------------------------------------------------------------------------
  insert into public.review_story (
    id, batch_id, story_code, story_name, owners_text, requirement_detail, source_data
  ) values (
    v_legacy, v_batch, 'EX-002', '没有源字段的老需求', '周八',
    '正文在 requirement_detail 上', '{}'::jsonb
  );

  select public.review_story_requirement_context(story.*) into v_ctx
  from public.review_story story where story.id = v_legacy;
  perform pg_temp.assert(
    v_ctx ->> 'detailed_description' = '正文在 requirement_detail 上',
    'requirement_detail wins over the EXCEL fallback');
  perform pg_temp.assert(
    not (v_ctx ? 'source_fields'), 'an empty source_data does not produce an empty object');

  --------------------------------------------------------------------------
  -- 4. 只有标题的需求：正文键必须缺席。
  --------------------------------------------------------------------------
  insert into public.review_story (
    id, batch_id, story_code, story_name, owners_text, source_system, source_data
  ) values (
    v_bare, v_batch, 'US-2026-009306', 'mcp-hub 增加云之家鉴权', '未分配', 'LINKY', '{}'::jsonb
  );

  select public.review_story_requirement_context(story.*) into v_ctx
  from public.review_story story where story.id = v_bare;
  perform pg_temp.assert(
    not (v_ctx ? 'detailed_description'),
    'an empty requirement body is absent from the context, not faked from the title');
  perform pg_temp.assert(
    not (v_ctx ? 'attachments'), 'a story without attachments has no attachments key');
  perform pg_temp.assert(
    v_ctx ->> 'story_name' = 'mcp-hub 增加云之家鉴权',
    'the title is still frozen so the model knows what the story is called');

  --------------------------------------------------------------------------
  -- 5. 授权面没有被顺手放开。
  --------------------------------------------------------------------------
  perform pg_temp.assert(
    not has_function_privilege('anon', 'public.review_story_requirement_context(public.review_story)', 'execute'),
    'anon cannot execute the freeze helper');
  perform pg_temp.assert(
    has_function_privilege('service_role', 'public.review_story_requirement_context(public.review_story)', 'execute')
      and has_function_privilege('authenticated', 'public.review_story_requirement_context(public.review_story)', 'execute'),
    'service_role and authenticated keep execute');

  raise notice 'requirement context full-field test passed';
end;
$test$;

select 'ALL_REQUIREMENT_CONTEXT_FULL_FIELD_TESTS_PASSED' as result;

rollback;
