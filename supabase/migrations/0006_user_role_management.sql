drop function if exists public.admin_list_users();

create or replace function public.admin_list_users()
returns table (
  id uuid,
  email text,
  display_name text,
  role text,
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
    profile.created_at,
    profile.updated_at
  from public.user_profile profile
  join auth.users auth_user on auth_user.id = profile.id
  order by profile.created_at desc;
end;
$$;

drop function if exists public.admin_update_user_role(uuid, text);

create or replace function public.admin_update_user_role(p_user_id uuid, p_role text)
returns table (
  id uuid,
  email text,
  display_name text,
  role text,
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
