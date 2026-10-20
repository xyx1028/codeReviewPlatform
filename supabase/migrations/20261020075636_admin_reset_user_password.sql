-- V1.65 管理员代重置用户密码。
--
-- 为什么需要它：内网自部署的 GoTrue 没有可用的发信服务（SMTP 仍是官方示例的占位值），
-- V1.64 的自助找回密码在现网发不出邮件。这条路径完全不碰邮件：管理员设一个临时密码，
-- 线下转交，用户登录后自己改掉。
--
-- 边界：浏览器不允许直接写 auth.users，所以密码哈希由本 SECURITY DEFINER RPC 生成；
-- 明文密码只在管理员那一次请求里出现，既不落库也不进审计表。
-- 重置同时清掉该账号的全部登录态 —— 旧密码可能已经泄露，这正是要重置的原因。

begin;

create table if not exists public.admin_password_reset_audit (
  id uuid primary key default gen_random_uuid(),
  reset_user_id uuid not null,
  reset_email text,
  reset_display_name text,
  reset_by uuid references auth.users(id) on delete set null,
  reset_by_email text,
  reset_by_display_name text,
  sessions_revoked integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists idx_admin_password_reset_audit_user_created
  on public.admin_password_reset_audit(reset_user_id, created_at desc);

comment on table public.admin_password_reset_audit is
  'Append-only audit snapshots for an ADMIN resetting another account password. Never stores the password itself.';

alter table public.admin_password_reset_audit enable row level security;

drop policy if exists "admins read password reset audit" on public.admin_password_reset_audit;
create policy "admins read password reset audit" on public.admin_password_reset_audit
  for select to authenticated
  using (public.is_admin());

-- 浏览器只可经下方 SECURITY DEFINER RPC 写入；"谁给谁改过密码"这件事不能由客户端伪造。
revoke all on table public.admin_password_reset_audit from public, anon, authenticated;

create or replace function public.admin_reset_user_password(p_user_id uuid, p_password text)
returns table (
  id uuid,
  email text,
  display_name text,
  role text,
  email_confirmed_at timestamptz,
  sessions_revoked integer,
  reset_self boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_actor_email text;
  v_actor_display_name text;
  v_email text;
  v_display_name text;
  v_sessions integer := 0;
begin
  perform public.ensure_admin();

  if p_password is null or p_password = '' then
    raise exception 'PASSWORD_REQUIRED';
  end if;
  -- 两端空格在"复制给同事"的转交过程里几乎必然丢失，设进去等于设了一个谁都登不进的密码。
  if p_password <> btrim(p_password) then
    raise exception 'PASSWORD_HAS_EDGE_SPACE';
  end if;
  if length(p_password) < 8 then
    raise exception 'PASSWORD_TOO_SHORT';
  end if;
  -- bcrypt 只取前 72 字节，超出部分被静默丢弃。与其让管理员以为设了个长密码，不如直接拒绝。
  if octet_length(p_password) > 72 then
    raise exception 'PASSWORD_TOO_LONG';
  end if;

  -- 锁住 auth 行：两个管理员同时重置时，后一个必须看到前一个的结果，而不是交错写哈希。
  select auth_user.email::text, profile.display_name
  into v_email, v_display_name
  from auth.users auth_user
  join public.user_profile profile on profile.id = auth_user.id
  where auth_user.id = p_user_id
  for update of auth_user;

  if not found then
    raise exception 'USER_NOT_FOUND';
  end if;

  -- 微信注册的账号邮箱是占位的 @wechat.invalid，没有邮箱密码登录通道，给它设密码没有意义。
  if v_email like '%@wechat.invalid' then
    raise exception 'WECHAT_ONLY_ACCOUNT';
  end if;

  select auth_user.email::text into v_actor_email
  from auth.users auth_user
  where auth_user.id = v_actor;
  select profile.display_name into v_actor_display_name
  from public.user_profile profile
  where profile.id = v_actor;

  update auth.users as auth_user
  -- 代价参数显式写 10，与 GoTrue 自己写密码时的默认 bcrypt cost 一致；
  -- pgcrypto 的 gen_salt('bf') 默认只有 6，留下一个比平台其它密码更弱的哈希。
  set encrypted_password = extensions.crypt(p_password, extensions.gen_salt('bf', 10)),
      updated_at = now()
  where auth_user.id = p_user_id;

  -- 删 session 会按外键级联删掉绑定它的 refresh token；历史上没有 session 的 token 单独吊销。
  with removed as (
    delete from auth.sessions where user_id = p_user_id returning 1
  )
  select count(*) into v_sessions from removed;

  update auth.refresh_tokens
  set revoked = true, updated_at = now()
  where user_id = p_user_id::text
    and revoked is distinct from true;

  insert into public.admin_password_reset_audit (
    reset_user_id,
    reset_email,
    reset_display_name,
    reset_by,
    reset_by_email,
    reset_by_display_name,
    sessions_revoked
  ) values (
    p_user_id,
    v_email,
    v_display_name,
    v_actor,
    v_actor_email,
    v_actor_display_name,
    v_sessions
  );

  return query
  select
    profile.id,
    auth_user.email::text,
    profile.display_name,
    profile.role,
    auth_user.email_confirmed_at,
    v_sessions,
    (p_user_id = v_actor)
  from public.user_profile profile
  join auth.users auth_user on auth_user.id = profile.id
  where profile.id = p_user_id;
end;
$$;

revoke execute on function public.admin_reset_user_password(uuid, text) from public, anon;
grant execute on function public.admin_reset_user_password(uuid, text) to authenticated;

commit;
