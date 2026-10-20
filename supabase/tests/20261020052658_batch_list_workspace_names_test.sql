\set ON_ERROR_STOP on
begin;
set local client_min_messages=warning;
create or replace function pg_temp.assert(p_ok boolean,p_message text)
returns void language plpgsql as $$ begin
  if p_ok is distinct from true then raise exception 'ASSERT FAILED: %',p_message; end if;
end; $$;

do $test$
declare
  v_admin uuid := gen_random_uuid();
  v_frozen uuid := gen_random_uuid();   -- 已冻结需求的批次
  v_pending uuid := gen_random_uuid();  -- 只有导入单、还没有需求的批次
  v_legacy uuid := gen_random_uuid();   -- Excel 时代：没有项目组
  v_multi uuid := gen_random_uuid();    -- 跨两个项目组
  v_names text[];
  v_count integer;
begin
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                          email_confirmed_at, created_at, updated_at)
  values (v_admin, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
          'v162-admin@example.com', 'x', now(), now(), now());
  update public.user_profile set role = 'ADMIN', display_name = 'V162 管理员' where id = v_admin;

  insert into public.review_batch (id, name, week_code, default_branch, created_by) values
    (v_frozen,  'V162 已冻结', 'V162-FROZEN',  'release',     v_admin),
    (v_pending, 'V162 待导入', 'V162-PENDING', 'feature_dev', v_admin),
    (v_legacy,  'V162 历史',   'V162-LEGACY',  'release',     v_admin),
    (v_multi,   'V162 跨组',   'V162-MULTI',   'release',     v_admin);

  -- 1. 已冻结需求：项目组来自需求快照
  insert into public.review_story (batch_id, story_code, story_name, owners_text, linky_workspace_name)
  values (v_frozen, 'US-V162-1', '需求一', '张三', '工具开发组'),
         (v_frozen, 'US-V162-2', '需求二', '张三', '工具开发组');

  -- 2. 跨两个项目组：要能各自列出，并且有序
  insert into public.review_story (batch_id, story_code, story_name, owners_text, linky_workspace_name)
  values (v_multi, 'US-V162-3', '需求三', '张三', '前端开发组'),
         (v_multi, 'US-V162-4', '需求四', '张三', '工具开发组');

  -- 3. 只有导入单、没有需求（导入排队中或导入失败）
  insert into public.linky_batch_import_request
    (batch_id, workspace_name, story_codes, stories_total, requested_by)
  values (v_pending, '灵基Foundation', array['US-V162-9'], 1, v_admin);

  -- 4. Excel 时代的历史批次：有需求但没有项目组
  insert into public.review_story (batch_id, story_code, story_name, owners_text, linky_workspace_name)
  values (v_legacy, 'US-V162-5', '历史需求', '李四', null);

  perform set_config('request.jwt.claims',
    json_build_object('sub', v_admin::text, 'role', 'authenticated')::text, true);

  select workspace_names into v_names
  from public.list_review_batches_with_creator() where id = v_frozen;
  perform pg_temp.assert(v_names = array['工具开发组'],
    format('已冻结批次应只列出一个项目组，实际 %s', v_names));

  select workspace_names into v_names
  from public.list_review_batches_with_creator() where id = v_multi;
  perform pg_temp.assert(v_names = array['前端开发组','工具开发组'],
    format('跨组批次应按名称有序列出两个，实际 %s', v_names));

  select workspace_names into v_names
  from public.list_review_batches_with_creator() where id = v_pending;
  perform pg_temp.assert(v_names = array['灵基Foundation'],
    format('空批次应退到导入单的项目组，实际 %s', v_names));

  select workspace_names into v_names
  from public.list_review_batches_with_creator() where id = v_legacy;
  perform pg_temp.assert(v_names = array[]::text[],
    format('历史批次没有项目组时应为空数组而不是 null，实际 %s', v_names));

  -- 原有字段一个都不能丢
  perform pg_temp.assert(
    exists (select 1 from public.list_review_batches_with_creator()
            where id = v_frozen and creator_name = 'V162 管理员'
              and week_code = 'V162-FROZEN' and default_branch = 'release'),
    '原有字段（创建人/发布周期/代码基线）必须保持不变');

  -- 没有留下旧重载：改了返回列集合必须是 drop 后重建，不是多一个重载
  select count(*) into v_count from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'list_review_batches_with_creator';
  perform pg_temp.assert(v_count = 1, format('不应存在重载，实际 %s 个', v_count));

  -- 授权：匿名不可执行，登录用户可执行
  perform pg_temp.assert(
    not has_function_privilege('anon', 'public.list_review_batches_with_creator()', 'EXECUTE'),
    'anon 不应能执行批次列表');
  perform pg_temp.assert(
    has_function_privilege('authenticated', 'public.list_review_batches_with_creator()', 'EXECUTE'),
    'authenticated 应能执行批次列表');

  -- 聚合用的索引存在
  perform pg_temp.assert(
    exists (select 1 from pg_indexes
            where tablename = 'review_story' and indexname = 'idx_review_story_batch_workspace'),
    '应存在 (batch_id, linky_workspace_name) 索引');
end;
$test$;

rollback;
