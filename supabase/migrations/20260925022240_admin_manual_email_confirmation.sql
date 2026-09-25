-- 管理员手动确认待验证邮箱。
--
-- 邮箱是否已验证的唯一事实是 auth.users.email_confirmed_at。浏览器不允许直接更新
-- auth.users；本 RPC 先以 ensure_admin() 判定操作者，再锁定目标行、只允许 null -> now()
-- 的单向转换，并将目标与操作者快照写入审计表。

begin;

create table if not exists public.admin_email_verification_audit (
  id uuid primary key default gen_random_uuid(),
  confirmed_user_id uuid not null,
  confirmed_email text,
  confirmed_display_name text,
  confirmed_by uuid references auth.users(id) on delete set null,
  confirmed_by_email text,
  confirmed_by_display_name text,
  created_at timestamptz not null default now()
);

create index if not exists idx_admin_email_verification_audit_confirmed_user_created
  on public.admin_email_verification_audit(confirmed_user_id, created_at desc);

comment on table public.admin_email_verification_audit is
  'Append-only audit snapshots for an ADMIN manually confirming a pending user email.';

alter table public.admin_email_verification_audit enable row level security;

drop policy if exists "admins read email verification audit" on public.admin_email_verification_audit;
create policy "admins read email verification audit" on public.admin_email_verification_audit
  for select to authenticated
  using (public.is_admin());

-- 浏览器只可经下方 SECURITY DEFINER RPC 写入；审计事实不能由客户端伪造。
revoke all on table public.admin_email_verification_audit from public, anon, authenticated;

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

  -- 锁住 auth 行，让两个并发请求中最多一个能完成 null -> 已验证 的状态转换。
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

  update auth.users
  set email_confirmed_at = now(), updated_at = now()
  where id = p_user_id;

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
