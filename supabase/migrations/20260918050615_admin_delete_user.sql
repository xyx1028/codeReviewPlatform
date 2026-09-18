-- 管理员删除用户（V1.10）。
--
-- ## 为什么"删除用户"必须先是一个判定
--
-- `auth.users` 被 8 张业务表以 `NO ACTION` 引用（实测 pg_constraint）：
-- `review_batch.created_by`、`analysis_job.requested_by`、`human_review.reviewer_id`、
-- `ai_import_record.imported_by`、`import_file.uploaded_by`、`ai_model_config.created_by`、
-- `model_connectivity_test.requested_by`、`batch_operation_log.performed_by`。
--
-- 这些是业务与审计归属。把它们改成级联删除可以让"删除用户"永远成功，代价是删掉一个人
-- 就顺手销毁他建过的批次、跑过的分析和审阅记录 —— 那不是删用户，那是删证据。所以外键
-- 一律不动，改为：**只允许删除没有业务痕迹的账号**，其余明确拒绝并说清原因。
--
-- 会跟着删的只有账号自身的附属数据（`user_profile`、四张微信表、auth 的会话/身份），
-- 会被置空的只有技能的作者字段（`review_skill.created_by` 等，SET NULL）—— 技能版本
-- 本身不可变，作者信息丢失不影响任何功能。
--
-- ## 三道门禁
--
--   1. `CANNOT_DELETE_SELF`：不能删自己（避免管理员把自己锁在外面）；
--   2. `CANNOT_DELETE_LAST_ADMIN`：不能删最后一个管理员（与 admin_update_user_role 里
--      "不能降级最后一个管理员"同一条保护，否则平台会没有管理员）；
--   3. `USER_HAS_REFERENCES`：有业务引用时拒绝，并逐表返回条数。
--
-- 判定函数被"影响评估"和"执行删除"共用，所以弹窗里看到的规则与执行时生效的规则是同一份。
-- 两次调用之间数据变了（例如那个人刚建了一个批次），执行时仍会拒绝 —— 这是对的。
--
-- ## 审计
--
-- `user_admin_audit` 存**快照**且 `deleted_user_id` 不加外键：加了外键，审计就会随被删
-- 用户一起消失，那样的审计等于没有。

begin;

-- ---------------------------------------------------------------------------
-- 1. 审计表
-- ---------------------------------------------------------------------------
create table if not exists public.user_admin_audit (
  id uuid primary key default gen_random_uuid(),
  action text not null default 'DELETE_USER'
    check (action in ('DELETE_USER')),
  -- 刻意不加外键：被删用户的行已经不存在，加外键会让这条审计无法写入/无法留存。
  deleted_user_id uuid not null,
  deleted_email text,
  deleted_display_name text,
  deleted_role text,
  deleted_user_created_at timestamptz,
  -- 操作者仍然存在，所以这里保留外键；他日后被删时置空，审计文本仍在快照列里。
  deleted_by uuid references auth.users(id) on delete set null,
  deleted_by_email text,
  deleted_by_display_name text,
  /** 一并删除 / 置空的条数快照，便于事后回答"当时到底动了什么"。 */
  cascade_summary jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_user_admin_audit_created
on public.user_admin_audit(created_at desc);

comment on table public.user_admin_audit is
  'Admin user-deletion audit. Snapshot columns only: the deleted account no longer '
  'exists, so nothing here may depend on it via a foreign key.';

alter table public.user_admin_audit enable row level security;

drop policy if exists "admins read user admin audit" on public.user_admin_audit;
create policy "admins read user admin audit" on public.user_admin_audit
  for select to authenticated
  using (public.is_admin());

-- 写入只经 RPC（security definer）。不给任何角色直接 insert/update/delete。
revoke insert, update, delete on public.user_admin_audit from authenticated, anon;

-- ---------------------------------------------------------------------------
-- 2. 共用判定：这个账号现在能不能删，删了会动到什么
--
-- 返回 jsonb 而不是多个 out 参数：调用方（影响评估 RPC 与删除 RPC）需要的是同一份完整
-- 结论，拆成多个标量会让两处各自拼装，规则就会分叉。
-- ---------------------------------------------------------------------------
create or replace function public.evaluate_user_deletion(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile public.user_profile;
  v_email text;
  v_user_created_at timestamptz;
  v_blocking jsonb := '[]'::jsonb;
  v_admin_count integer;
  v_code text := null;
  v_count integer;
  v_ref record;
begin
  select profile.* into v_profile from public.user_profile profile where profile.id = p_user_id;
  select auth_user.email::text, auth_user.created_at
    into v_email, v_user_created_at
  from auth.users auth_user where auth_user.id = p_user_id;

  if v_profile.id is null and v_email is null then
    return jsonb_build_object(
      'can_delete', false,
      'code', 'USER_NOT_FOUND',
      'blocking_references', '[]'::jsonb,
      'cascade_counts', '{}'::jsonb,
      'nullify_counts', '{}'::jsonb
    );
  end if;

  -- 逐张 NO ACTION 表统计。表名与中文标签一起返回：前端不该自己维护这张映射，
  -- 否则数据库加了新引用而前端不知道，界面上就会出现"未知原因不能删"。
  for v_ref in
    select *
    from (values
      ('review_batch',            'created_by',   '创建的评审批次'),
      ('analysis_job',            'requested_by', '发起的 AI 分析任务'),
      ('human_review',            'reviewer_id',  '提交的人工确认'),
      ('ai_import_record',        'imported_by',  '导入的 AI 结果'),
      ('import_file',             'uploaded_by',  '上传的导入文件'),
      ('ai_model_config',         'created_by',   '创建的模型配置'),
      ('model_connectivity_test', 'requested_by', '发起的模型连接测试'),
      ('batch_operation_log',     'performed_by', '产生的操作日志')
    ) as t(table_name, column_name, label)
  loop
    execute format('select count(*) from public.%I where %I = $1', v_ref.table_name, v_ref.column_name)
      into v_count using p_user_id;
    if v_count > 0 then
      v_blocking := v_blocking || jsonb_build_object(
        'table', v_ref.table_name,
        'label', v_ref.label,
        'count', v_count
      );
    end if;
  end loop;

  -- 门禁优先级：自己 > 最后一个管理员 > 业务引用。
  -- 顺序有意义：一个管理员删自己时，最该看到的是"不能删自己"，而不是"你还有 3 个批次"。
  if p_user_id = auth.uid() then
    v_code := 'CANNOT_DELETE_SELF';
  else
    if v_profile.role = 'ADMIN' then
      select count(*) into v_admin_count from public.user_profile where role = 'ADMIN';
      if v_admin_count <= 1 then
        v_code := 'CANNOT_DELETE_LAST_ADMIN';
      end if;
    end if;
    if v_code is null and jsonb_array_length(v_blocking) > 0 then
      v_code := 'USER_HAS_REFERENCES';
    end if;
  end if;

  return jsonb_build_object(
    'can_delete', v_code is null,
    'code', v_code,
    'user', jsonb_build_object(
      'id', p_user_id,
      'email', v_email,
      'display_name', v_profile.display_name,
      'role', v_profile.role,
      'created_at', v_user_created_at
    ),
    'blocking_references', v_blocking,
    -- 会一并删除的附属数据。数量为 0 也返回，前端据此写"无"。
    'cascade_counts', jsonb_build_object(
      'wechat_identity', (select count(*) from public.wechat_identity where user_id = p_user_id),
      'auth_sessions', (select count(*) from auth.sessions where user_id = p_user_id),
      'auth_identities', (select count(*) from auth.identities where user_id = p_user_id)
    ),
    -- 会被置空（SET NULL）的引用。这些不阻止删除，但必须让管理员事先知道。
    'nullify_counts', jsonb_build_object(
      'review_skill', (select count(*) from public.review_skill where created_by = p_user_id),
      'review_skill_version', (select count(*) from public.review_skill_version where published_by = p_user_id),
      'review_skill_upload', (select count(*) from public.review_skill_upload where uploaded_by = p_user_id)
    )
  );
end;
$$;

-- 内部判定函数：只给两个 RPC 用，不直接暴露给前端。
revoke execute on function public.evaluate_user_deletion(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. 影响评估（只读）
-- ---------------------------------------------------------------------------
create or replace function public.admin_get_user_deletion_impact(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.ensure_admin();
  return public.evaluate_user_deletion(p_user_id);
end;
$$;

revoke execute on function public.admin_get_user_deletion_impact(uuid) from public, anon;
grant execute on function public.admin_get_user_deletion_impact(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. 执行删除
-- ---------------------------------------------------------------------------
create or replace function public.admin_delete_user(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_impact jsonb;
  v_actor uuid := auth.uid();
  v_actor_email text;
  v_actor_name text;
  v_deleted integer;
begin
  perform public.ensure_admin();

  -- 判定与执行之间可能有并发写入，所以这里重新评估一次，绝不相信前端传来的结论。
  v_impact := public.evaluate_user_deletion(p_user_id);
  if (v_impact ->> 'can_delete')::boolean is not true then
    -- 错误码直接抛给前端；文案由前端按码渲染，数据库不返回 UI 文本。
    raise exception '%', coalesce(v_impact ->> 'code', 'USER_DELETE_REFUSED');
  end if;

  select auth_user.email::text into v_actor_email from auth.users auth_user where auth_user.id = v_actor;
  select profile.display_name into v_actor_name from public.user_profile profile where profile.id = v_actor;

  -- 先写审计再删除：反过来的话，删除成功而审计失败就永久失去了这条记录。
  insert into public.user_admin_audit (
    deleted_user_id, deleted_email, deleted_display_name, deleted_role,
    deleted_user_created_at, deleted_by, deleted_by_email, deleted_by_display_name,
    cascade_summary
  ) values (
    p_user_id,
    v_impact -> 'user' ->> 'email',
    v_impact -> 'user' ->> 'display_name',
    v_impact -> 'user' ->> 'role',
    nullif(v_impact -> 'user' ->> 'created_at', '')::timestamptz,
    v_actor, v_actor_email, v_actor_name,
    jsonb_build_object(
      'cascade_counts', v_impact -> 'cascade_counts',
      'nullify_counts', v_impact -> 'nullify_counts'
    )
  );

  /*
   * 遗留刷新令牌。
   *
   * `auth.refresh_tokens` 只有 `session_id` 外键（CASCADE），没有 `user_id` 外键 ——
   * 所以带 session 的令牌会随会话级联删掉，而**旧版 GoTrue 留下的 session_id 为空的
   * 令牌删不到**。留着它们等于给一个已经不存在的账号留了一把还能换 token 的钥匙。
   * user_id 在这张表里是 varchar，所以要转成文本比较。
   */
  delete from auth.refresh_tokens where user_id = p_user_id::text;

  -- 删 auth.users：user_profile、四张微信表、auth 的会话/身份/MFA 由外键级联清理。
  delete from auth.users where id = p_user_id;
  get diagnostics v_deleted = row_count;
  if v_deleted = 0 then
    raise exception 'USER_NOT_FOUND';
  end if;

  return jsonb_build_object(
    'deleted', true,
    'user', v_impact -> 'user',
    'cascade_counts', v_impact -> 'cascade_counts',
    'nullify_counts', v_impact -> 'nullify_counts'
  );
end;
$$;

revoke execute on function public.admin_delete_user(uuid) from public, anon;
grant execute on function public.admin_delete_user(uuid) to authenticated;

commit;
