-- 20260924051800_linky_story_direct_import_test.sql
-- V1.20：review_story 的结构化列、需求附件表、Storage 策略、需求上下文（含 Excel 回退）。
--
-- 这份用例在 2026-09-24 被精简过一次：原版还覆盖了镜像层（linky_story_catalog 等）与它的
-- 同步队列，而那条路径当天就被改成"浏览器直连 Linky"，相关对象已由
-- 20260924064500_drop_retired_linky_mirror.sql 删除。删掉那些段落而不是留着注释掉的代码 ——
-- 一份断言不存在对象的测试只会在下一次有人跑它时制造噪声。
--
-- 现役导入链路（linky_batch_import_request 及其 RPC）的契约在
-- 20260924061500_linky_live_board_and_batch_import_test.sql 里。
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
  v_batch uuid := '20000000-0000-4000-b000-000000000001';
  v_story uuid;
  v_excel_story uuid;
  v_context jsonb;
  v_rls boolean;
begin
  insert into auth.users (id, email) values
    (v_admin, 'admin_v120@example.com'),
    (v_reviewer, 'reviewer_v120@example.com')
  on conflict (id) do nothing;
  insert into public.user_profile (id, role) values
    (v_admin, 'ADMIN'), (v_reviewer, 'REVIEWER')
  on conflict (id) do update set role = excluded.role;

  insert into public.review_batch (id, name, week_code, status, default_branch, created_by) values
    (v_batch, 'V1.20 Linky 批次', 'V120-W01', 'DRAFT', 'feature_dev', v_reviewer);

  ----------------------------------------------------------------------------
  -- 1. 冻结附件表：RLS 开启，authenticated 只读，anon 全关。
  ----------------------------------------------------------------------------
  select relrowsecurity into v_rls
  from pg_class where oid = 'public.review_story_attachment'::regclass;
  perform pg_temp.assert(v_rls, 'review_story_attachment has RLS enabled');
  perform pg_temp.assert(
    has_table_privilege('authenticated', 'public.review_story_attachment', 'select')
    and not has_table_privilege('authenticated', 'public.review_story_attachment', 'insert')
    and not has_table_privilege('authenticated', 'public.review_story_attachment', 'update')
    and not has_table_privilege('authenticated', 'public.review_story_attachment', 'delete'),
    'frozen attachments are read-only for authenticated'
  );
  perform pg_temp.assert(
    not has_table_privilege('anon', 'public.review_story_attachment', 'select'),
    'anon cannot read frozen attachments'
  );

  ----------------------------------------------------------------------------
  -- 2. review_story 的结构化列存在且带约束。
  ----------------------------------------------------------------------------
  perform pg_temp.assert(
    (select count(*) = 8 from information_schema.columns
     where table_schema = 'public' and table_name = 'review_story'
       and column_name in ('source_system', 'requirement_detail', 'subject_name',
         'linky_issue_id', 'linky_workspace_id', 'linky_workspace_name', 'story_url', 'synced_at')),
    'all eight structured columns exist'
  );
  perform pg_temp.assert(
    exists (select 1 from pg_constraint where conname = 'review_story_source_system_check'),
    'source_system is constrained to EXCEL / LINKY'
  );
  begin
    insert into public.review_story (batch_id, story_code, story_name, owners_text, source_system)
    values (v_batch, 'BAD-SOURCE', 'x', 'y', 'JIRA');
    raise exception 'an unknown source_system must be rejected';
  exception when check_violation then
    null;
  end;

  ----------------------------------------------------------------------------
  -- 3. 负责人拼接：team 为 null 时绝不编造人名。
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
  perform pg_temp.assert(
    public.linky_team_names(jsonb_build_object('test', '[]'::jsonb), 'test') is null,
    'an empty role list yields null, not an empty string'
  );

  ----------------------------------------------------------------------------
  -- 4. 需求上下文：LINKY 读结构化列（含冻结附件），Excel 历史批次回退到中文列名。
  ----------------------------------------------------------------------------
  insert into public.review_story (
    batch_id, story_code, story_name, owners_text, requirement_handlers, test_handlers,
    project_name, iteration_name, release_window, source_status,
    source_system, requirement_detail, subject_name
  ) values (
    v_batch, 'US-2026-012147', 'mcphub 增加 oauth 无 secret 鉴权', '王鹏程、史陈龙',
    '何翘楚', null, '工具开发组', '202610-1（0928-1016）', 'R20261016', '需求编写完成',
    'LINKY', 'mcphub 需要支持标准 OAuth 授权码 + PKCE 模式。', '【MCP】能力增强与体验优化'
  ) returning id into v_story;

  insert into public.review_story_attachment (
    story_id, linky_attachment_id, filename, content_type, size_bytes,
    storage_path, content_sha256
  ) values (
    v_story, '01a08f41-08cb-7940-9a40-05e931d46aa0', 'prd.html', 'text/html; charset=utf-8',
    21465, 'batch/' || v_batch || '/01a08f41-08cb-7940-9a40-05e931d46aa0.html', repeat('a', 64)
  );

  select public.review_story_requirement_context(story) into v_context
  from public.review_story story where story.id = v_story;
  perform pg_temp.assert(
    v_context ->> 'detailed_description' like 'mcphub 需要支持标准 OAuth%'
    and v_context ->> 'related_features' = '【MCP】能力增强与体验优化'
    and v_context ->> 'iteration' = '202610-1（0928-1016）'
    and v_context ->> 'source_status' = '需求编写完成'
    and jsonb_array_length(v_context -> 'attachments') = 1
    and v_context -> 'attachments' -> 0 ->> 'filename' = 'prd.html'
    and v_context -> 'attachments' -> 0 ->> 'sha256' = repeat('a', 64),
    'LINKY stories expose requirement text and frozen attachments to the freeze step'
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
  -- 5. Storage bucket 与写策略。
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
        and coalesce(qual, '') || coalesce(with_check, '') like '%story-attachments%'
    ),
    'browsers get no write policy on the attachment bucket'
  );

  ----------------------------------------------------------------------------
  -- 6. 镜像层确实已经删除（防止将来有人"顺手"把它加回来）。
  ----------------------------------------------------------------------------
  perform pg_temp.assert(
    not exists (
      select 1 from information_schema.tables
      where table_schema = 'public'
        and table_name in ('linky_story_catalog', 'linky_story_catalog_attachment',
                           'linky_sync_request')
    ),
    'the retired mirror layer stays deleted'
  );
end;
$test$;

select 'ALL_LINKY_STORY_DIRECT_IMPORT_TESTS_PASSED' as result;

rollback;
