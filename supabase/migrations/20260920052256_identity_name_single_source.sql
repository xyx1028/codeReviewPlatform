-- V1.13 收敛：「我是谁」只在个人中心的基本资料里维护一次。
--
-- ## 为什么改
--
-- 上一版把「开发人员姓名/员工号」放在 Git 身份卡片里单独维护，于是同一个人要在两个地方各写
-- 一遍名字：基本资料里的用户名，和 Git 身份里的开发人员姓名。它们指的是同一件事 ——
-- 需求表里「开发人员」那一栏（真实格式是「向俊杰（41865）」，姓名 + 员工号），
-- 分开维护只会让两者悄悄不一致，而不一致的后果是归属规则对不上人却不报错。
--
-- 所以：**基本资料里的用户名 + 员工号就是与需求对齐的那一份**，保存时同步写进
-- developer_identity。Git 身份卡片不再问姓名。
--
-- ## 边界
--
--   * 没有 developer_identity（还没绑过邮箱）时只更新 user_profile，不创建空身份 ——
--     身份的创建入口仍然只有"绑定一个经 GitLab 验证的邮箱"；
--   * 身份被标 CONFLICT / DISABLED 时拒绝同步（交管理员处理），但用户名照常能改：
--     用户名是账号资料，不该被身份冲突卡住；
--   * 员工号唯一（不区分大小写），冲突时以 DEVELOPER_EMPLOYEE_CODE_CONFLICT 拒绝整个操作；
--   * 上一版的 update_my_developer_profile 收回 authenticated 权限，避免留两个入口各写一半。

begin;

create or replace function public.update_my_identity_profile(
  p_display_name text,
  p_employee_code text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_display_name text;
  v_employee_code text;
  v_profile public.user_profile;
  v_developer public.developer_identity;
  v_before jsonb;
begin
  if v_actor is null then raise exception 'AUTH_REQUIRED'; end if;

  v_display_name := nullif(btrim(coalesce(p_display_name, '')), '');
  if v_display_name is null then raise exception 'DEVELOPER_DISPLAY_NAME_REQUIRED'; end if;
  -- 32 是 user_profile 侧既有的上限（developer_identity 允许 64），取更严的那个。
  if char_length(v_display_name) > 32 then raise exception 'DEVELOPER_DISPLAY_NAME_TOO_LONG'; end if;
  if v_display_name ~ '[[:cntrl:]]' then raise exception 'DEVELOPER_DISPLAY_NAME_INVALID'; end if;
  v_employee_code := nullif(btrim(coalesce(p_employee_code, '')), '');
  if v_employee_code is not null and (char_length(v_employee_code) > 32 or v_employee_code ~ '[[:cntrl:]]') then
    raise exception 'DEVELOPER_EMPLOYEE_CODE_INVALID';
  end if;

  select * into v_developer
  from public.developer_identity
  where auth_user_id = v_actor
  for update;

  if v_developer.id is not null then
    if v_developer.status in ('CONFLICT', 'DISABLED') then raise exception 'DEVELOPER_IDENTITY_LOCKED'; end if;
    if v_employee_code is not null and exists (
      select 1 from public.developer_identity other
      where lower(other.employee_code) = lower(v_employee_code)
        and other.id <> v_developer.id
    ) then
      raise exception 'DEVELOPER_EMPLOYEE_CODE_CONFLICT';
    end if;
  end if;

  update public.user_profile
  set display_name = v_display_name
  where id = v_actor
  returning * into v_profile;
  if v_profile.id is null then raise exception 'USER_PROFILE_NOT_FOUND'; end if;

  if v_developer.id is not null then
    v_before := jsonb_build_object(
      'display_name', v_developer.display_name,
      'employee_code', v_developer.employee_code
    );
    update public.developer_identity
    set display_name = v_display_name,
        employee_code = v_employee_code,
        revision = revision + 1,
        updated_by = v_actor,
        updated_at = now()
    where id = v_developer.id
    returning * into v_developer;

    insert into public.analysis_scope_decision_audit(
      decision_type, source, actor_id, reason_codes, before_state, after_state
    ) values (
      'IDENTITY_CONFIG', 'USER', v_actor, array['SELF_IDENTITY_RENAMED'], v_before,
      jsonb_build_object(
        'developer_id', v_developer.id,
        'display_name', v_developer.display_name,
        'employee_code', v_developer.employee_code
      )
    );
  end if;

  return jsonb_build_object(
    'profile', jsonb_build_object(
      'id', v_profile.id,
      'display_name', v_profile.display_name,
      'role', v_profile.role
    ),
    'developer_id', v_developer.id,
    'employee_code', v_developer.employee_code,
    'developer_revision', v_developer.revision
  );
end;
$$;

revoke execute on function public.update_my_identity_profile(text, text) from public, anon;
grant execute on function public.update_my_identity_profile(text, text) to authenticated, service_role;

comment on function public.update_my_identity_profile(text, text) is
  'Single place where a member declares who they are: updates user_profile.display_name and, '
  'when a developer identity exists, mirrors name + employee code into it so the attribution '
  'rules can line the account up with the 开发人员 column of a requirement.';

-- 只保留一个入口：上一版那个只改 developer_identity 的函数不再给成员调用。
revoke execute on function public.update_my_developer_profile(text, text) from public, anon, authenticated;
grant execute on function public.update_my_developer_profile(text, text) to service_role;

comment on function public.update_my_developer_profile(text, text) is
  'service_role only since 20260920052256. Members use update_my_identity_profile, which keeps '
  'user_profile.display_name and developer_identity in sync instead of letting them drift apart.';

commit;
