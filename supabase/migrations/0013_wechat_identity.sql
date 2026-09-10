begin;

------------------------------------------------------------------------------
-- 微信开放平台身份与 Supabase Auth 用户的私有映射
------------------------------------------------------------------------------

create table if not exists public.wechat_identity (
  id uuid primary key default gen_random_uuid(),
  app_id text not null,
  openid text not null,
  unionid text,
  user_id uuid not null references auth.users(id) on delete cascade,
  nickname text,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_login_at timestamptz not null default now(),
  unique (app_id, openid),
  unique (app_id, unionid),
  unique (user_id)
);

comment on table public.wechat_identity is
  'Private mapping between WeChat Open Platform identities and Supabase Auth users.';

drop trigger if exists touch_wechat_identity_updated_at on public.wechat_identity;
create trigger touch_wechat_identity_updated_at
before update on public.wechat_identity
for each row execute function public.touch_updated_at();

alter table public.wechat_identity enable row level security;

------------------------------------------------------------------------------
-- 短期 OAuth 请求与一次性交接凭据
------------------------------------------------------------------------------

create table if not exists public.wechat_oauth_attempt (
  state_hash text primary key check (length(state_hash) = 64),
  mode text not null check (mode in ('LOGIN', 'BIND')),
  user_id uuid references auth.users(id) on delete cascade,
  redirect_to text not null,
  browser_nonce_hash text check (browser_nonce_hash is null or length(browser_nonce_hash) = 64),
  client_nonce_hash text check (client_nonce_hash is null or length(client_nonce_hash) = 64),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  check (
    (mode = 'LOGIN' and user_id is null and browser_nonce_hash is not null and client_nonce_hash is not null)
    or (mode = 'BIND' and user_id is not null and browser_nonce_hash is null and client_nonce_hash is null)
  )
);

create index if not exists idx_wechat_oauth_attempt_expires_at
on public.wechat_oauth_attempt(expires_at);

create table if not exists public.wechat_login_handoff (
  ticket_hash text primary key check (length(ticket_hash) = 64),
  user_id uuid not null references auth.users(id) on delete cascade,
  client_nonce_hash text not null check (length(client_nonce_hash) = 64),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table if not exists public.wechat_binding_handoff (
  ticket_hash text primary key check (length(ticket_hash) = 64),
  user_id uuid not null references auth.users(id) on delete cascade,
  openid text not null,
  unionid text,
  nickname text not null,
  avatar_url text,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

alter table public.wechat_oauth_attempt enable row level security;
alter table public.wechat_login_handoff enable row level security;
alter table public.wechat_binding_handoff enable row level security;

-- 微信标识与临时凭据不得经 Data API 暴露给浏览器。
revoke all on table
  public.wechat_identity,
  public.wechat_oauth_attempt,
  public.wechat_login_handoff,
  public.wechat_binding_handoff
from public, anon, authenticated;

grant select, insert, update, delete on table
  public.wechat_identity,
  public.wechat_oauth_attempt,
  public.wechat_login_handoff,
  public.wechat_binding_handoff
  to service_role;

commit;
