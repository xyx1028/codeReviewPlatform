--
-- V1.8 技能目录容量上限平台级可配置契约回归。
--
-- 覆盖：
--   1. 出厂默认 = 升级前现值（50 / 32KiB / 100MiB / 256MiB）。
--   2. skill_bundle_limits() 的目录四项来自配置表；单包上限仍是常量。
--   3. 改配置后 skill_bundle_limits() 目录项随之变化。
--   4. admin_update_skill_catalog_limits 区间校验（越界拒绝，稳定错误码）。
--   5. 一次成功更新落一行审计。
--   6. get_story_task_skill_snapshot 结构含 catalog_limits 键（历史 Job 为 null 亦合法）。
--
-- 整个测试在一个 rollback 事务内完成，不污染库。

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
-- 1. 出厂默认 = 现值
-- ---------------------------------------------------------------------------
do $test$
declare
  v public.skill_catalog_limits_config;
begin
  select * into v from public.skill_catalog_limits_config where id = 1;
  perform pg_temp.assert(v.catalog_bundles = 50, 'default catalogBundles=50');
  perform pg_temp.assert(v.catalog_render_bytes = 32 * 1024, 'default render=32KiB');
  perform pg_temp.assert(v.catalog_archive_bytes = 100 * 1024 * 1024, 'default archive=100MiB');
  perform pg_temp.assert(v.catalog_expanded_bytes = 256 * 1024 * 1024, 'default expanded=256MiB');
end;
$test$;

-- ---------------------------------------------------------------------------
-- 2 & 3. skill_bundle_limits() 目录项读表；单包项仍常量；改配置随之变化
-- ---------------------------------------------------------------------------
do $test$
declare
  v_limits jsonb;
begin
  v_limits := public.skill_bundle_limits();
  perform pg_temp.assert((v_limits->>'catalogBundles')::int = 50, 'bundle_limits catalogBundles reads table');
  perform pg_temp.assert((v_limits->>'archiveBytes')::bigint = 10 * 1024 * 1024, 'single bundle archive still constant');
  perform pg_temp.assert((v_limits->>'descriptionChars')::int = 500, 'descriptionChars still constant');

  update public.skill_catalog_limits_config set catalog_bundles = 123 where id = 1;
  v_limits := public.skill_bundle_limits();
  perform pg_temp.assert((v_limits->>'catalogBundles')::int = 123, 'bundle_limits tracks config change');
  -- 还原到出厂默认，避免影响后续断言
  update public.skill_catalog_limits_config set catalog_bundles = 50 where id = 1;
end;
$test$;

-- ---------------------------------------------------------------------------
-- 4 & 5. RPC 区间校验 + 审计落行（需要 admin 身份）
-- ---------------------------------------------------------------------------
do $test$
declare
  v_uid uuid := '00000000-0000-0000-0000-0000000000a8';
  v_audit_before bigint;
  v_audit_after bigint;
begin
  insert into auth.users (id, email) values (v_uid, 'v18-test-admin@test.local')
    on conflict (id) do nothing;
  insert into public.user_profile (id, role) values (v_uid, 'ADMIN')
    on conflict (id) do update set role = 'ADMIN';

  select count(*) into v_audit_before from public.skill_catalog_limits_audit;

  -- 模拟 authenticated + jwt sub = 该 admin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_uid::text, 'role', 'authenticated')::text, true);

  -- 合法更新
  perform public.admin_update_skill_catalog_limits(60, 65536, 209715200, 536870912);

  -- 越界：bundles 太大
  begin
    perform public.admin_update_skill_catalog_limits(999, 65536, 209715200, 536870912);
    raise exception 'SHOULD_HAVE_REJECTED bundles';
  exception when others then
    perform pg_temp.assert(sqlerrm = 'SKILL_CATALOG_LIMITS_OUT_OF_RANGE', 'bundles out of range code');
  end;

  -- 越界：render 太大
  begin
    perform public.admin_update_skill_catalog_limits(60, 999999999, 209715200, 536870912);
    raise exception 'SHOULD_HAVE_REJECTED render';
  exception when others then
    perform pg_temp.assert(sqlerrm = 'SKILL_CATALOG_LIMITS_OUT_OF_RANGE', 'render out of range code');
  end;

  perform set_config('role', 'postgres', true);
  reset role;

  select count(*) into v_audit_after from public.skill_catalog_limits_audit;
  -- 只有那一次合法更新落审计；两次越界在校验阶段就抛错，不落行。
  perform pg_temp.assert(v_audit_after = v_audit_before + 1, 'exactly one audit row for the valid update');
end;
$test$;

-- ---------------------------------------------------------------------------
-- 6. 快照 RPC 结构含 catalog_limits 键
-- ---------------------------------------------------------------------------
do $test$
begin
  -- 函数定义体里必须出现 catalog_limits 键（结构性断言，不依赖具体 Job 数据）。
  perform pg_temp.assert(
    pg_get_functiondef('public.get_story_task_skill_snapshot(uuid,text,uuid)'::regprocedure)
      like '%''catalog_limits''%',
    'snapshot RPC returns catalog_limits key'
  );
  -- analysis_job 必须有 skill_catalog_limits 列。
  perform pg_temp.assert(
    exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'analysis_job'
        and column_name = 'skill_catalog_limits'
    ),
    'analysis_job.skill_catalog_limits column exists'
  );
end;
$test$;

rollback;
