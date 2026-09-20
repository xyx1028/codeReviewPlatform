-- V1.12 配套修复：append-only 事实表允许"删除账号时把 actor 置空"，但仍禁止任何人改写它。
--
-- 为什么必须在这一版处理：
--   自助维护 Git 身份后，每个普通成员保存一次都会在 analysis_scope_decision_audit 留下
--   一条 actor_id 指向自己的审计。该外键声明的是 on delete set null，而 append-only 触发器
--   拒绝所有 UPDATE —— 于是 delete auth.users 会在外键的级联 UPDATE 上炸成
--   APPEND_ONLY_RECORD_IMMUTABLE（GoTrue admin 删除接口表现为 500），
--   「删除用户」对所有配置过 Git 邮箱的人直接失效。本地实测确认过这条路径。
--
-- 边界：只放行"由外键动作驱动（pg_trigger_depth()>1）、把某一列从非 NULL 置成 NULL、
-- 其余列一字不变"的 UPDATE。人为改写事实、把值改成另一个值、或直接 DELETE 仍然被拒。
--
-- 已知但不在本迁移范围内的同族问题（发布人被删时同样会撞上"整行不可变"）：
--   * public.review_skill_version.published_by（trigger review_skill_version_is_immutable）
--   * public.analysis_attribution_rule_version.created_by / published_by
--     （trigger enforce_attribution_rule_version_immutable，仅 status='PUBLISHED' 的行）
-- 它们只影响发布过技能或归属规则版本的管理员账号，与本次自助身份链路无关，留待对应功能修复。

begin;

create or replace function public.reject_append_only_mutation()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_old jsonb;
  v_new jsonb;
  v_column text;
begin
  -- 父 Job/Batch 的受控级联清理会在嵌套触发器中进入；直接覆盖或直接删除事实仍拒绝。
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then
    return old;
  end if;

  -- 外键 on delete set null 驱动的置空：删除账号时只允许丢掉 actor 的 uuid，
  -- 审计文本、时间、reason_codes 和 before/after 快照必须逐字保留。
  if tg_op = 'UPDATE' and pg_trigger_depth() > 1 then
    v_old := to_jsonb(old);
    v_new := to_jsonb(new);
    for v_column in select jsonb_object_keys(v_old)
    loop
      if v_old -> v_column is distinct from v_new -> v_column then
        if jsonb_typeof(v_new -> v_column) <> 'null' or jsonb_typeof(v_old -> v_column) = 'null' then
          raise exception 'APPEND_ONLY_RECORD_IMMUTABLE';
        end if;
      end if;
    end loop;
    return new;
  end if;

  raise exception 'APPEND_ONLY_RECORD_IMMUTABLE';
end;
$$;

comment on function public.reject_append_only_mutation() is
  'Append-only guard. Permits only controlled cascade deletes and foreign-key driven '
  'set-null of a referencing column; every other update or delete is rejected.';

revoke execute on function public.reject_append_only_mutation() from public, anon, authenticated;

-- 影响评估补两项：删除账号时会被置空的归属/身份痕迹，管理员应当事先看到。
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
    'cascade_counts', jsonb_build_object(
      'wechat_identity', (select count(*) from public.wechat_identity where user_id = p_user_id),
      'auth_sessions', (select count(*) from auth.sessions where user_id = p_user_id),
      'auth_identities', (select count(*) from auth.identities where user_id = p_user_id)
    ),
    'nullify_counts', jsonb_build_object(
      'review_skill', (select count(*) from public.review_skill where created_by = p_user_id),
      'review_skill_version', (select count(*) from public.review_skill_version where published_by = p_user_id),
      'review_skill_upload', (select count(*) from public.review_skill_upload where uploaded_by = p_user_id),
      -- V1.12：自助维护的 Git 身份会退回"管理员代录/未认领"，历史 Job 快照不受影响。
      'developer_identity', (select count(*) from public.developer_identity where auth_user_id = p_user_id),
      'analysis_scope_decision_audit', (select count(*) from public.analysis_scope_decision_audit where actor_id = p_user_id)
    )
  );
end;
$$;

revoke execute on function public.evaluate_user_deletion(uuid) from public, anon, authenticated;

commit;
