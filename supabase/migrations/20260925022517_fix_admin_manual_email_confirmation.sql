-- 前滚修复 admin_confirm_user_email 的 PL/pgSQL 名称歧义。
-- 返回表的 OUT 列 id 会成为函数变量，因此 UPDATE 中必须限定 auth.users 的 id。

begin;

create or replace function public.admin_confirm_user_email(p_user_id uuid)
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
  v_email text;
  v_display_name text;
  v_email_confirmed_at timestamptz;
  v_actor uuid := auth.uid();
  v_actor_email text;
  v_actor_display_name text;
begin
  perform public.ensure_admin();

  select
    auth_user.email::text,
    profile.display_name,
    auth_user.email_confirmed_at
  into v_email, v_display_name, v_email_confirmed_at
  from auth.users auth_user
  join public.user_profile profile on profile.id = auth_user.id
  where auth_user.id = p_user_id
  for update of auth_user;

  if not found then
    raise exception 'USER_NOT_FOUND';
  end if;

  if v_email_confirmed_at is not null then
    raise exception 'EMAIL_ALREADY_CONFIRMED';
  end if;

  select auth_user.email::text into v_actor_email
  from auth.users auth_user
  where auth_user.id = v_actor;
  select profile.display_name into v_actor_display_name
  from public.user_profile profile
  where profile.id = v_actor;

  update auth.users as auth_user
  set email_confirmed_at = now(), updated_at = now()
  where auth_user.id = p_user_id;

  insert into public.admin_email_verification_audit (
    confirmed_user_id,
    confirmed_email,
    confirmed_display_name,
    confirmed_by,
    confirmed_by_email,
    confirmed_by_display_name
  ) values (
    p_user_id,
    v_email,
    v_display_name,
    v_actor,
    v_actor_email,
    v_actor_display_name
  );

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

revoke execute on function public.admin_confirm_user_email(uuid) from public, anon;
grant execute on function public.admin_confirm_user_email(uuid) to authenticated;

commit;
