--
-- 管理员删除用户（V1.10）。
--
-- 守的是"删除用户"这件事上最容易出的三种错：
--   * 为了让删除总能成功而级联删掉业务历史（那是删证据，不是删用户）；
--   * 抛裸外键错误，管理员看不懂也不知道该怎么办；
--   * 审计随被删用户一起消失。
--
-- 覆盖：
--   1. 干净账号（无任何业务引用）能删：auth.users / user_profile 都消失。
--   2. 有业务引用 → USER_HAS_REFERENCES，并逐表给出中文标签与条数；数据一行不动。
--   3. 删自己 → CANNOT_DELETE_SELF（优先级高于业务引用）。
--   4. 最后一个管理员 → CANNOT_DELETE_LAST_ADMIN；还有别的管理员时可以删。
--   5. 不存在的用户 → USER_NOT_FOUND。
--   6. 审计快照落库，且 deleted_user_id 没有外键（否则删完就写不进/留不住）。
--   7. SET NULL 引用（技能作者）不阻止删除，删后置空。
--   8. 影响评估是只读的。
--   9. 非管理员一律拒绝；两个 RPC 都没授予 anon。
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
-- 夹具
--
-- 直接插 auth.users：GoTrue 的注册流程在测试里不可用，而 create_profile_for_new_user
-- 触发器会自动补出 user_profile 行 —— 这正是生产里 profile 的来源，所以夹具与生产同构。
--
-- 四个角色：
--   actor  = 执行删除的管理员（另有一个 admin2 保证"最后一个管理员"不被误触发）
--   clean  = 干净账号（可删）
--   dirty  = 有业务引用（不可删）
--   skills = 只被 SET NULL 引用（可删）
-- ---------------------------------------------------------------------------
create or replace function pg_temp.fixture()
returns void language plpgsql as $$
declare
  v_model uuid;
  v_id uuid;
  v_case record;
begin
  for v_case in
    select *
    from (values
      ('11111111-aaaa-0000-0000-000000000001'::uuid, 'actor@test.local',  'ADMIN'),
      ('11111111-aaaa-0000-0000-000000000002'::uuid, 'admin2@test.local', 'ADMIN'),
      ('11111111-aaaa-0000-0000-000000000003'::uuid, 'clean@test.local',  'REVIEWER'),
      ('11111111-aaaa-0000-0000-000000000004'::uuid, 'dirty@test.local',  'REVIEWER'),
      ('11111111-aaaa-0000-0000-000000000005'::uuid, 'skills@test.local', 'VIEWER')
    ) as t(id, email, role)
  loop
    insert into auth.users (id, instance_id, aud, role, email, encrypted_password, created_at, updated_at)
    values (v_case.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            v_case.email, 'x', now(), now());
    -- 触发器建的 profile 默认 REVIEWER，按用例改成目标角色。
    update public.user_profile set role = v_case.role, display_name = split_part(v_case.email, '@', 1)
    where id = v_case.id;
  end loop;

  -- dirty 用户的业务痕迹：一个批次 + 一条操作日志（两张不同的 NO ACTION 表）。
  insert into public.review_batch (id, name, week_code, default_branch, created_by)
  values ('11111111-bbbb-0000-0000-000000000001', 'dirty-batch', '2026-W38', 'feature_dev',
          '11111111-aaaa-0000-0000-000000000004');
  -- action 有白名单约束，用真实动作值。
  insert into public.batch_operation_log (batch_id, action, performed_by)
  values ('11111111-bbbb-0000-0000-000000000001', 'BATCH_CREATED', '11111111-aaaa-0000-0000-000000000004');

  -- skills 用户只被 SET NULL 引用。
  insert into public.review_skill (id, name, display_name, status, created_by)
  values ('11111111-cccc-0000-0000-000000000001', 'skill-for-deletion-test',
          '删除测试技能', 'DRAFT', '11111111-aaaa-0000-0000-000000000005');
end;
$$;

select pg_temp.fixture();

/*
 * 冒充登录用户。
 *
 * ensure_admin() 走 auth.uid()，它读的是请求级 GUC `request.jwt.claims`。测试里用
 * set local 注入，等价于以那个用户的身份调用 RPC —— 这是唯一能真实覆盖"删自己"和
 * "非管理员被拒"两条门禁的办法。
 */
create or replace function pg_temp.act_as(p_user_id uuid)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user_id::text, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end;
$$;

create or replace function pg_temp.act_as_postgres()
returns void language plpgsql as $$
begin
  perform set_config('role', 'postgres', true);
end;
$$;

/*
 * 以某个用户的身份调 RPC，然后立刻切回 postgres。
 *
 * 断言本身必须以 postgres 执行：`authenticated` 读 auth.users 会 permission denied，
 * 而这套测试恰恰要断言"auth.users 里的行没了/还在"。SECURITY DEFINER 的 RPC 内部以
 * 函数所有者身份运行，所以不受影响。
 */
create or replace function pg_temp.impact_as(p_actor uuid, p_target uuid)
returns jsonb language plpgsql as $$
declare v jsonb;
begin
  perform pg_temp.act_as(p_actor);
  v := public.admin_get_user_deletion_impact(p_target);
  perform pg_temp.act_as_postgres();
  return v;
end;
$$;

create or replace function pg_temp.delete_as(p_actor uuid, p_target uuid)
returns jsonb language plpgsql as $$
declare v jsonb;
begin
  perform pg_temp.act_as(p_actor);
  v := public.admin_delete_user(p_target);
  perform pg_temp.act_as_postgres();
  return v;
end;
$$;

/** 期望被拒：返回错误文本，同时保证身份切回 postgres。 */
create or replace function pg_temp.delete_expect_error(p_actor uuid, p_target uuid)
returns text language plpgsql as $$
declare v_msg text;
begin
  perform pg_temp.act_as(p_actor);
  begin
    perform public.admin_delete_user(p_target);
    v_msg := '(no error)';
  exception when others then
    v_msg := sqlerrm;
  end;
  perform pg_temp.act_as_postgres();
  return v_msg;
end;
$$;

create or replace function pg_temp.impact_expect_error(p_actor uuid, p_target uuid)
returns text language plpgsql as $$
declare v_msg text;
begin
  perform pg_temp.act_as(p_actor);
  begin
    perform public.admin_get_user_deletion_impact(p_target);
    v_msg := '(no error)';
  exception when others then
    v_msg := sqlerrm;
  end;
  perform pg_temp.act_as_postgres();
  return v_msg;
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. 非管理员一律被拒
-- ---------------------------------------------------------------------------
do $test$
begin
  perform pg_temp.assert(
    pg_temp.impact_expect_error(
      '11111111-aaaa-0000-0000-000000000003'::uuid,  -- REVIEWER
      '11111111-aaaa-0000-0000-000000000004'::uuid) like '%ADMIN role required%',
    'a non-admin must not evaluate deletions');
  perform pg_temp.assert(
    pg_temp.delete_expect_error(
      '11111111-aaaa-0000-0000-000000000003'::uuid,
      '11111111-aaaa-0000-0000-000000000003'::uuid) like '%ADMIN role required%',
    'a non-admin must not delete users');
end;
$test$;

-- ---------------------------------------------------------------------------
-- 2. 有业务引用 → 拒绝，并逐表报数；且影响评估是只读的（第 8 条）
-- ---------------------------------------------------------------------------
do $test$
declare
  v_impact jsonb;
  v_labels text;
  v_batches_before integer;
  v_batches_after integer;
  v_failed boolean := false;
begin
  select count(*) into v_batches_before from public.review_batch;

  v_impact := pg_temp.impact_as(
    '11111111-aaaa-0000-0000-000000000001'::uuid,   -- actor(ADMIN)
    '11111111-aaaa-0000-0000-000000000004'::uuid);  -- dirty
  perform pg_temp.assert((v_impact ->> 'can_delete')::boolean is false,
    'a user with business references must not be deletable');
  perform pg_temp.assert(v_impact ->> 'code' = 'USER_HAS_REFERENCES',
    'code must be USER_HAS_REFERENCES, got ' || coalesce(v_impact ->> 'code', 'NULL'));
  perform pg_temp.assert(jsonb_array_length(v_impact -> 'blocking_references') = 2,
    'both referencing tables must be reported, got '
    || jsonb_array_length(v_impact -> 'blocking_references')::text);

  select string_agg(item ->> 'label', '|' order by item ->> 'label')
    into v_labels
  from jsonb_array_elements(v_impact -> 'blocking_references') as item;
  perform pg_temp.assert(v_labels like '%创建的评审批次%' and v_labels like '%产生的操作日志%',
    'labels must be human readable, got ' || coalesce(v_labels, 'NULL'));
  perform pg_temp.assert(
    (select (item ->> 'count')::integer from jsonb_array_elements(v_impact -> 'blocking_references') as item
      where item ->> 'table' = 'review_batch') = 1,
    'the批次 count must be 1');

  -- 只读：评估不能动数据。
  select count(*) into v_batches_after from public.review_batch;
  perform pg_temp.assert(v_batches_before = v_batches_after, 'impact evaluation must not modify data');

  -- 执行删除同样被拒，且不留审计。
  v_failed := pg_temp.delete_expect_error(
    '11111111-aaaa-0000-0000-000000000001'::uuid,
    '11111111-aaaa-0000-0000-000000000004'::uuid) like '%USER_HAS_REFERENCES%';
  perform pg_temp.assert(v_failed, 'delete must be refused for a referenced user');
  perform pg_temp.assert(
    (select count(*) from public.user_admin_audit
      where deleted_user_id = '11111111-aaaa-0000-0000-000000000004') = 0,
    'a refused deletion must not write an audit row');
  perform pg_temp.assert(
    (select count(*) from auth.users where id = '11111111-aaaa-0000-0000-000000000004') = 1,
    'the referenced user must still exist');
end;
$test$;

-- ---------------------------------------------------------------------------
-- 3. 删自己被拒（优先级高于业务引用）
-- ---------------------------------------------------------------------------
do $test$
declare v_impact jsonb;
begin
  v_impact := pg_temp.impact_as(
    '11111111-aaaa-0000-0000-000000000001'::uuid,
    '11111111-aaaa-0000-0000-000000000001'::uuid);
  perform pg_temp.assert(v_impact ->> 'code' = 'CANNOT_DELETE_SELF',
    'self-deletion must report CANNOT_DELETE_SELF, got ' || coalesce(v_impact ->> 'code', 'NULL'));
  perform pg_temp.assert(
    pg_temp.delete_expect_error(
      '11111111-aaaa-0000-0000-000000000001'::uuid,
      '11111111-aaaa-0000-0000-000000000001'::uuid) like '%CANNOT_DELETE_SELF%',
    'an admin must not delete themselves');
end;
$test$;

-- ---------------------------------------------------------------------------
-- 1 & 6. 干净账号能删；审计留快照
-- ---------------------------------------------------------------------------
do $test$
declare
  v_result jsonb;
  v_audit public.user_admin_audit;
begin
  v_result := pg_temp.delete_as(
    '11111111-aaaa-0000-0000-000000000001'::uuid,
    '11111111-aaaa-0000-0000-000000000003'::uuid);

  perform pg_temp.assert((v_result ->> 'deleted')::boolean, 'the clean user must be deleted');
  perform pg_temp.assert(
    (select count(*) from auth.users where id = '11111111-aaaa-0000-0000-000000000003') = 0,
    'auth.users row must be gone');
  perform pg_temp.assert(
    (select count(*) from public.user_profile where id = '11111111-aaaa-0000-0000-000000000003') = 0,
    'user_profile must cascade away');

  select * into v_audit from public.user_admin_audit
  where deleted_user_id = '11111111-aaaa-0000-0000-000000000003';
  perform pg_temp.assert(v_audit.id is not null, 'an audit row must exist');
  perform pg_temp.assert(v_audit.deleted_email = 'clean@test.local',
    'audit must snapshot the email, got ' || coalesce(v_audit.deleted_email, 'NULL'));
  perform pg_temp.assert(v_audit.deleted_role = 'REVIEWER', 'audit must snapshot the role');
  perform pg_temp.assert(v_audit.deleted_by = '11111111-aaaa-0000-0000-000000000001',
    'audit must record who deleted');
  perform pg_temp.assert(v_audit.deleted_by_email = 'actor@test.local',
    'audit must snapshot the actor email');
end;
$test$;

-- ---------------------------------------------------------------------------
-- 6b. 审计表的 deleted_user_id 不能有外键（否则删完就留不住）
-- ---------------------------------------------------------------------------
do $test$
declare v_fk integer;
begin
  select count(*) into v_fk
  from pg_constraint con
  join unnest(con.conkey) as k(attnum) on true
  join pg_attribute att on att.attrelid = con.conrelid and att.attnum = k.attnum
  where con.conrelid = 'public.user_admin_audit'::regclass
    and con.contype = 'f'
    and att.attname = 'deleted_user_id';
  perform pg_temp.assert(v_fk = 0,
    'deleted_user_id must NOT have a foreign key: the audit outlives the account');
end;
$test$;

-- ---------------------------------------------------------------------------
-- 7. SET NULL 引用不阻止删除，删后置空
-- ---------------------------------------------------------------------------
do $test$
declare v_impact jsonb; v_creator uuid;
begin
  v_impact := pg_temp.impact_as(
    '11111111-aaaa-0000-0000-000000000001'::uuid,
    '11111111-aaaa-0000-0000-000000000005'::uuid);
  perform pg_temp.assert((v_impact ->> 'can_delete')::boolean,
    'a user referenced only by SET NULL columns must be deletable, got code '
    || coalesce(v_impact ->> 'code', 'NULL'));
  perform pg_temp.assert((v_impact -> 'nullify_counts' ->> 'review_skill')::integer = 1,
    'the impact must warn that 1 skill author will be cleared');

  perform pg_temp.delete_as(
    '11111111-aaaa-0000-0000-000000000001'::uuid,
    '11111111-aaaa-0000-0000-000000000005'::uuid);
  select created_by into v_creator from public.review_skill
  where id = '11111111-cccc-0000-0000-000000000001';
  perform pg_temp.assert(v_creator is null, 'the skill author must be set to NULL, not deleted');
  perform pg_temp.assert(
    (select count(*) from public.review_skill where id = '11111111-cccc-0000-0000-000000000001') = 1,
    'the skill itself must survive');
end;
$test$;

-- ---------------------------------------------------------------------------
-- 4. 最后一个管理员
-- ---------------------------------------------------------------------------
do $test$
declare v_impact jsonb;
begin
  perform pg_temp.act_as_postgres();
  -- 两个管理员时：删其中一个是允许的。
  update public.user_profile set role = 'ADMIN' where id = '11111111-aaaa-0000-0000-000000000002';
  v_impact := pg_temp.impact_as(
    '11111111-aaaa-0000-0000-000000000001'::uuid,
    '11111111-aaaa-0000-0000-000000000002'::uuid);
  perform pg_temp.assert((v_impact ->> 'can_delete')::boolean,
    'deleting an admin is allowed while another admin remains, got code '
    || coalesce(v_impact ->> 'code', 'NULL'));

  -- 只剩一个管理员时：他不可删。判定函数直接验证（走 RPC 会先撞上"不能删自己"）。
  --
  -- 注意要把**库里其它所有** ADMIN 一起降级：本地库有真实用户，而判定函数统计的是
  -- 全表管理员数（生产语义就该是全表）。整个测试在事务里 rollback，不会影响真实数据。
  perform pg_temp.act_as_postgres();
  update public.user_profile set role = 'VIEWER'
  where role = 'ADMIN' and id <> '11111111-aaaa-0000-0000-000000000002';
  v_impact := public.evaluate_user_deletion('11111111-aaaa-0000-0000-000000000002'::uuid);
  perform pg_temp.assert(v_impact ->> 'code' = 'CANNOT_DELETE_LAST_ADMIN',
    'the last administrator must not be deletable, got ' || coalesce(v_impact ->> 'code', 'NULL'));
end;
$test$;

-- ---------------------------------------------------------------------------
-- 5. 不存在的用户
-- ---------------------------------------------------------------------------
do $test$
declare v_impact jsonb;
begin
  perform pg_temp.act_as_postgres();
  v_impact := public.evaluate_user_deletion('99999999-9999-9999-9999-999999999999'::uuid);
  perform pg_temp.assert(v_impact ->> 'code' = 'USER_NOT_FOUND',
    'a missing user must report USER_NOT_FOUND, got ' || coalesce(v_impact ->> 'code', 'NULL'));
end;
$test$;

-- ---------------------------------------------------------------------------
-- 授权面：两个 RPC 都不能给 anon；内部判定函数不给 authenticated
-- ---------------------------------------------------------------------------
do $test$
begin
  perform pg_temp.act_as_postgres();
  perform pg_temp.assert(
    not has_function_privilege('anon', 'public.admin_delete_user(uuid)', 'execute'),
    'anon must not execute admin_delete_user');
  perform pg_temp.assert(
    not has_function_privilege('anon', 'public.admin_get_user_deletion_impact(uuid)', 'execute'),
    'anon must not execute admin_get_user_deletion_impact');
  perform pg_temp.assert(
    has_function_privilege('authenticated', 'public.admin_delete_user(uuid)', 'execute'),
    'authenticated must be able to call the admin RPC (ensure_admin gates it)');
  perform pg_temp.assert(
    not has_function_privilege('authenticated', 'public.evaluate_user_deletion(uuid)', 'execute'),
    'the internal evaluator must not be exposed to authenticated');
end;
$test$;

rollback;
