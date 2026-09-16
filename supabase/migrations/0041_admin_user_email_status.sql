-- 用户管理列表暴露邮箱验证状态。
--
-- 背景：user_profile 行是 auth.users 的插入触发器（0001 的 create_profile_for_new_user）建的，
-- 注册那一刻就存在，跟邮箱验证没关系。于是「注册了但没点验证邮件」的账号在用户管理页里
-- 和正常账号长得一模一样，管理员只能去 Supabase 后台一个个翻 auth.users 才能看出谁卡住了。
--
-- 这里把 auth.users.email_confirmed_at 和 last_sign_in_at 一起带出来：前者是能不能登录的判据，
-- 后者用于区分「验证了但从没进来过」和「一直在用」。两个函数返回同一套列，所以一起改，
-- 否则改角色后前端拿到的行会比列表少字段。
--
-- 返回类型变了，create or replace 改不了 returns table，必须先 drop。
begin;

drop function if exists public.admin_list_users();
drop function if exists public.admin_update_user_role(uuid, text);

create or replace function public.admin_list_users()
returns table (
  id uuid,
  email text,
  display_name text,
  role text,
  email_confirmed_at timestamptz,
  last_sign_in_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.ensure_admin();

  return query
  select
    profile.id,
    auth_user.email::text,
    profile.display_name,
    profile.role,
    auth_user.email_confirmed_at,
    auth_user.last_sign_in_at,
    profile.created_at,
    profile.updated_at
  from public.user_profile profile
  join auth.users auth_user on auth_user.id = profile.id
  order by profile.created_at desc;
end;
$$;

create or replace function public.admin_update_user_role(p_user_id uuid, p_role text)
returns table (
  id uuid,
  email text,
  display_name text,
  role text,
  email_confirmed_at timestamptz,
  last_sign_in_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current_role text;
  v_admin_count integer;
begin
  perform public.ensure_admin();

  if p_role not in ('ADMIN', 'REVIEWER', 'VIEWER') then
    raise exception 'invalid role: %', p_role;
  end if;

  select profile.role into v_current_role
  from public.user_profile profile
  where profile.id = p_user_id;

  if v_current_role is null then
    raise exception 'user profile not found';
  end if;

  if v_current_role = 'ADMIN' and p_role <> 'ADMIN' then
    perform 1 from public.user_profile where role = 'ADMIN' for update;
    select count(*) into v_admin_count from public.user_profile where role = 'ADMIN';

    if v_admin_count <= 1 then
      raise exception 'cannot downgrade the last administrator';
    end if;
  end if;

  update public.user_profile profile
  set role = p_role
  where profile.id = p_user_id;

  return query
  select
    profile.id,
    auth_user.email::text,
    profile.display_name,
    profile.role,
    auth_user.email_confirmed_at,
    auth_user.last_sign_in_at,
    profile.created_at,
    profile.updated_at
  from public.user_profile profile
  join auth.users auth_user on auth_user.id = profile.id
  where profile.id = p_user_id;
end;
$$;

revoke execute on function public.admin_list_users() from public, anon;
revoke execute on function public.admin_update_user_role(uuid, text) from public, anon;
grant execute on function public.admin_list_users() to authenticated;
grant execute on function public.admin_update_user_role(uuid, text) to authenticated;

commit;
