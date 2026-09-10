begin;

-- 登录用户只能修改自己的显示名称；不接收用户 ID 或角色，避免越权修改资料。
drop function if exists public.update_my_display_name(text);

create or replace function public.update_my_display_name(p_display_name text)
returns public.user_profile
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_display_name text := nullif(btrim(p_display_name), '');
  v_profile public.user_profile;
begin
  if v_user_id is null then
    raise exception 'login required';
  end if;

  if v_display_name is null then
    raise exception 'display name is required';
  end if;

  if char_length(v_display_name) > 32 then
    raise exception 'display name must not exceed 32 characters';
  end if;

  if v_display_name ~ '[[:cntrl:]]' then
    raise exception 'display name contains invalid control characters';
  end if;

  update public.user_profile
  set display_name = v_display_name
  where id = v_user_id
  returning * into v_profile;

  if v_profile.id is null then
    raise exception 'user profile not found';
  end if;

  return v_profile;
end;
$$;

revoke execute on function public.update_my_display_name(text) from public, anon;
grant execute on function public.update_my_display_name(text) to authenticated;

commit;
