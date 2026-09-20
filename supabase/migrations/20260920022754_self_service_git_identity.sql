-- V1.12 Git 身份自助维护：把「谁的 Git 邮箱」从管理员代录改成本人在个人中心维护。
--
-- 设计边界：
--   * developer_identity 新增 auth_user_id，一个账号最多绑定一条开发人员身份；
--   * 原始邮箱仍然只作为 RPC 参数出现，HMAC 在数据库内计算，明文不入表、不回显、不进日志；
--   * 自助 RPC 只能读写「属于调用者自己」的那条身份，越权由 auth.uid() 边界拒绝，不靠前端；
--   * 删除采用停用（verification_status='DISABLED' + valid_until），因为 Job 快照以
--     on delete restrict 引用历史身份行，硬删会破坏已完成分析的可追溯性；
--   * 管理员页保留为只读总览与冲突处置入口，admin_* RPC 一字未动语义，只补一个 auth_bound 字段。

begin;

------------------------------------------------------------------------------
-- 1. 账号 ↔ 开发人员身份绑定
------------------------------------------------------------------------------

alter table public.developer_identity
  add column if not exists auth_user_id uuid references auth.users(id) on delete set null;

create unique index if not exists uq_developer_identity_auth_user
on public.developer_identity(auth_user_id) where auth_user_id is not null;

comment on column public.developer_identity.auth_user_id is
  'Platform account that maintains this developer identity in 个人中心. Null means administrator-entered and unclaimed.';

-- 自助写入需要一个与 ADMIN/AI/Worker 区分开的审计来源。
alter table public.analysis_scope_decision_audit
  drop constraint if exists analysis_scope_decision_audit_source_check,
  add constraint analysis_scope_decision_audit_source_check
    check (source in ('ADMIN', 'RULE_ENGINE', 'AI', 'WORKER', 'DATABASE', 'USER'));

------------------------------------------------------------------------------
-- 2. 读：只返回调用者自己的身份与脱敏邮箱
------------------------------------------------------------------------------

create or replace function public.get_my_git_identity()
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_developer public.developer_identity;
begin
  if v_actor is null then
    raise exception 'AUTH_REQUIRED';
  end if;

  select * into v_developer
  from public.developer_identity
  where auth_user_id = v_actor;

  if v_developer.id is null then
    return jsonb_build_object(
      'developer_id', null,
      'display_name', null,
      'employee_code', null,
      'status', null,
      'revision', null,
      'identities', '[]'::jsonb
    );
  end if;

  return jsonb_build_object(
    'developer_id', v_developer.id,
    'display_name', v_developer.display_name,
    'employee_code', v_developer.employee_code,
    'status', v_developer.status,
    'revision', v_developer.revision,
    'identities', coalesce((
      select jsonb_agg(jsonb_build_object(
        'git_identity_id', git.id,
        'provider', git.provider,
        'masked_email', git.masked_email,
        'email_domain', git.email_domain,
        'author_name_aliases', git.author_name_aliases,
        'gitlab_username', git.gitlab_username,
        'gitlab_user_id', git.gitlab_user_id,
        'verification_status', git.verification_status,
        'git_revision', git.revision,
        'valid_until', git.valid_until,
        'updated_at', git.updated_at
      ) order by git.created_at)
      from public.developer_git_identity git
      where git.developer_identity_id = v_developer.id
    ), '[]'::jsonb)
  );
end;
$$;

------------------------------------------------------------------------------
-- 3. 写：本人新增 / 修改自己的 Git 邮箱
------------------------------------------------------------------------------

create or replace function public.upsert_my_git_identity_from_email(
  p_git_identity_id uuid,
  p_display_name text,
  p_employee_code text,
  p_email text,
  p_author_name_aliases text[] default array[]::text[],
  p_gitlab_username text default null,
  p_gitlab_user_id text default null,
  p_expected_revision integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, vault, extensions
as $$
declare
  v_actor uuid := auth.uid();
  v_display_name text;
  v_employee_code text;
  v_email text;
  v_domain text;
  v_local text;
  v_masked text;
  v_pepper text;
  v_fingerprint text;
  v_developer public.developer_identity;
  v_git public.developer_git_identity;
  v_claimed boolean := false;
  v_created boolean := false;
begin
  if v_actor is null then
    raise exception 'AUTH_REQUIRED';
  end if;

  v_display_name := btrim(coalesce(p_display_name, ''));
  if v_display_name = '' then
    raise exception 'DEVELOPER_DISPLAY_NAME_REQUIRED';
  end if;
  if char_length(v_display_name) > 64 then
    raise exception 'DEVELOPER_DISPLAY_NAME_TOO_LONG';
  end if;
  v_employee_code := nullif(btrim(coalesce(p_employee_code, '')), '');

  v_email := lower(btrim(coalesce(p_email, '')));
  if char_length(v_email) > 320
     or v_email !~ '^[^@[:space:][:cntrl:]]{1,64}@[^@[:space:][:cntrl:]]{1,255}$' then
    raise exception 'IDENTITY_EMAIL_INVALID';
  end if;
  if cardinality(coalesce(p_author_name_aliases, array[]::text[])) > 10 then
    raise exception 'AUTHOR_ALIAS_LIMIT_EXCEEDED';
  end if;

  select secret.decrypted_secret into v_pepper
  from vault.decrypted_secrets secret
  where secret.name = 'analysis_identity_pepper'
  order by secret.created_at desc
  limit 1;
  if coalesce(v_pepper, '') = '' then
    raise exception 'IDENTITY_PEPPER_MISSING';
  end if;

  v_local := split_part(v_email, '@', 1);
  v_domain := split_part(v_email, '@', 2);
  v_masked := left(v_local, 1) || '***@' || v_domain;
  v_fingerprint := encode(hmac(
    convert_to(v_email, 'UTF8'),
    convert_to(v_pepper, 'UTF8'),
    'sha256'
  ), 'hex');

  select * into v_developer
  from public.developer_identity
  where auth_user_id = v_actor
  for update;

  if v_developer.id is null then
    -- 管理员先代录、本人后登录的迁移路径：同名同员工号且尚未被任何账号认领时认领它，
    -- 否则 uq_developer_identity_employee_code 会让自助保存变成一条看不懂的唯一键冲突。
    select * into v_developer
    from public.developer_identity developer
    where developer.auth_user_id is null
      and lower(btrim(developer.display_name)) = lower(v_display_name)
      and coalesce(lower(developer.employee_code), '') = coalesce(lower(v_employee_code), '')
    order by developer.created_at
    limit 1
    for update;
    v_claimed := v_developer.id is not null;
  end if;

  if v_developer.id is not null and v_developer.status in ('CONFLICT', 'DISABLED') then
    raise exception 'DEVELOPER_IDENTITY_LOCKED';
  end if;

  if v_employee_code is not null and exists (
    select 1 from public.developer_identity other
    where lower(other.employee_code) = lower(v_employee_code)
      and other.id is distinct from v_developer.id
  ) then
    raise exception 'DEVELOPER_EMPLOYEE_CODE_CONFLICT';
  end if;

  if v_developer.id is null then
    insert into public.developer_identity(
      display_name, employee_code, status, auth_user_id, created_by, updated_by
    ) values (
      v_display_name, v_employee_code, 'VERIFIED', v_actor, v_actor, v_actor
    ) returning * into v_developer;
    v_created := true;
  else
    -- p_expected_revision 只针对被编辑的那条 Git 邮箱行；开发人员行的 revision 与它不同步，
    -- 拿同一个值去比会在正常编辑时误报 REVISION_CONFLICT。
    update public.developer_identity
    set display_name = v_display_name,
        employee_code = v_employee_code,
        status = 'VERIFIED',
        auth_user_id = v_actor,
        revision = revision + 1,
        updated_by = v_actor,
        updated_at = now()
    where id = v_developer.id
    returning * into v_developer;
  end if;

  -- 同一个 Git 邮箱不能同时属于两个人：先给出可读错误，再兜住并发下的唯一键冲突。
  if exists (
    select 1 from public.developer_git_identity git
    where git.email_fingerprint = v_fingerprint
      and git.verification_status in ('VERIFIED', 'UNVERIFIED')
      and git.valid_until is null
      and git.developer_identity_id <> v_developer.id
  ) then
    raise exception 'GIT_EMAIL_ALREADY_BOUND';
  end if;

  if p_git_identity_id is null then
    insert into public.developer_git_identity(
      developer_identity_id, provider, email_fingerprint, masked_email, email_domain,
      author_name_aliases, gitlab_username, gitlab_user_id, verification_status,
      created_by, updated_by
    ) values (
      v_developer.id, 'gitlab', v_fingerprint, v_masked, v_domain,
      coalesce(p_author_name_aliases, array[]::text[]),
      nullif(btrim(coalesce(p_gitlab_username, '')), ''),
      nullif(btrim(coalesce(p_gitlab_user_id, '')), ''),
      'VERIFIED', v_actor, v_actor
    ) returning * into v_git;
  else
    select * into v_git
    from public.developer_git_identity
    where id = p_git_identity_id
    for update;
    if v_git.id is null or v_git.developer_identity_id <> v_developer.id then
      raise exception 'GIT_IDENTITY_NOT_FOUND';
    end if;
    if p_expected_revision is not null and v_git.revision <> p_expected_revision then
      raise exception 'REVISION_CONFLICT';
    end if;
    update public.developer_git_identity
    set email_fingerprint = v_fingerprint,
        masked_email = v_masked,
        email_domain = v_domain,
        author_name_aliases = coalesce(p_author_name_aliases, array[]::text[]),
        gitlab_username = nullif(btrim(coalesce(p_gitlab_username, '')), ''),
        gitlab_user_id = nullif(btrim(coalesce(p_gitlab_user_id, '')), ''),
        verification_status = 'VERIFIED',
        valid_until = null,
        revision = revision + 1,
        updated_by = v_actor,
        updated_at = now()
    where id = v_git.id
    returning * into v_git;
  end if;

  insert into public.analysis_scope_decision_audit(
    decision_type, source, actor_id, reason_codes, after_state
  ) values (
    'IDENTITY_CONFIG', 'USER', v_actor,
    case
      when v_created then array['SELF_IDENTITY_CREATED']
      when v_claimed then array['SELF_IDENTITY_CLAIMED']
      else array['SELF_IDENTITY_UPDATED']
    end,
    jsonb_build_object(
      'developer_id', v_developer.id,
      'git_identity_id', v_git.id,
      'masked_email', v_git.masked_email,
      'verification_status', v_git.verification_status
    )
  );

  return jsonb_build_object(
    'developer_id', v_developer.id,
    'git_identity_id', v_git.id,
    'developer_revision', v_developer.revision,
    'git_revision', v_git.revision,
    'masked_email', v_git.masked_email,
    'claimed_existing_developer', v_claimed
  );
exception when unique_violation then
  raise exception 'GIT_EMAIL_ALREADY_BOUND';
end;
$$;

------------------------------------------------------------------------------
-- 4. 停用：本人移除自己的某个 Git 邮箱（保留历史行，Job 快照仍可追溯）
------------------------------------------------------------------------------

create or replace function public.disable_my_git_identity(
  p_git_identity_id uuid,
  p_expected_revision integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_developer public.developer_identity;
  v_git public.developer_git_identity;
begin
  if v_actor is null then
    raise exception 'AUTH_REQUIRED';
  end if;

  select * into v_developer
  from public.developer_identity
  where auth_user_id = v_actor;
  if v_developer.id is null then
    raise exception 'DEVELOPER_IDENTITY_NOT_FOUND';
  end if;

  select * into v_git
  from public.developer_git_identity
  where id = p_git_identity_id
  for update;
  if v_git.id is null or v_git.developer_identity_id <> v_developer.id then
    raise exception 'GIT_IDENTITY_NOT_FOUND';
  end if;
  if p_expected_revision is not null and v_git.revision <> p_expected_revision then
    raise exception 'REVISION_CONFLICT';
  end if;

  update public.developer_git_identity
  set verification_status = 'DISABLED',
      -- valid_until 必须严格大于 valid_from；同一事务内 now() 与 valid_from 可能相等。
      valid_until = greatest(now(), v_git.valid_from + interval '1 millisecond'),
      revision = revision + 1,
      updated_by = v_actor,
      updated_at = now()
  where id = v_git.id
  returning * into v_git;

  insert into public.analysis_scope_decision_audit(
    decision_type, source, actor_id, reason_codes, after_state
  ) values (
    'IDENTITY_CONFIG', 'USER', v_actor, array['SELF_IDENTITY_DISABLED'],
    jsonb_build_object(
      'developer_id', v_developer.id,
      'git_identity_id', v_git.id,
      'masked_email', v_git.masked_email,
      'verification_status', v_git.verification_status
    )
  );

  return jsonb_build_object(
    'git_identity_id', v_git.id,
    'git_revision', v_git.revision,
    'verification_status', v_git.verification_status
  );
end;
$$;

------------------------------------------------------------------------------
-- 5. 管理员总览补一列：这条身份是否已经由本人账号维护
------------------------------------------------------------------------------

create or replace function public.admin_list_developer_git_identities()
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
begin
  perform public.ensure_admin();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'developer_id', developer.id,
      'display_name', developer.display_name,
      'employee_code', developer.employee_code,
      'status', developer.status,
      'revision', developer.revision,
      'auth_bound', developer.auth_user_id is not null,
      'git_identity_id', git.id,
      'provider', git.provider,
      'masked_email', git.masked_email,
      'email_domain', git.email_domain,
      'author_name_aliases', git.author_name_aliases,
      'gitlab_username', git.gitlab_username,
      'gitlab_user_id', git.gitlab_user_id,
      'verification_status', git.verification_status,
      'git_revision', git.revision,
      'updated_at', greatest(developer.updated_at, git.updated_at)
    ) order by developer.display_name, git.created_at)
    from public.developer_identity developer
    join public.developer_git_identity git on git.developer_identity_id = developer.id
  ), '[]'::jsonb);
end;
$$;

------------------------------------------------------------------------------
-- 6. 最小权限
------------------------------------------------------------------------------

revoke execute on function public.get_my_git_identity() from public, anon;
grant execute on function public.get_my_git_identity() to authenticated, service_role;

revoke execute on function public.upsert_my_git_identity_from_email(
  uuid, text, text, text, text[], text, text, integer
) from public, anon;
grant execute on function public.upsert_my_git_identity_from_email(
  uuid, text, text, text, text[], text, text, integer
) to authenticated, service_role;

revoke execute on function public.disable_my_git_identity(uuid, integer) from public, anon;
grant execute on function public.disable_my_git_identity(uuid, integer) to authenticated, service_role;

comment on function public.get_my_git_identity() is
  'Returns only the caller own developer identity and masked Git emails; never a raw email or fingerprint.';
comment on function public.upsert_my_git_identity_from_email(
  uuid, text, text, text, text[], text, text, integer
) is 'Self-service. Binds developer_identity to auth.uid(); HMACs the email with Vault analysis_identity_pepper and never stores or returns it.';
comment on function public.disable_my_git_identity(uuid, integer) is
  'Self-service soft removal: marks the caller own Git identity DISABLED and closes its validity window; history rows stay for frozen Job snapshots.';

commit;
