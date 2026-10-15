-- =============================================================================
-- 本地开发专用 Seed —— 预制一个系统管理员账号
--
-- 用途：每次 `supabase db reset` 后自动重建一个固定的管理员账号，
--       免去「注册 → 去 Mailpit 点确认邮件 → 申领初始管理员」的手工流程。
--
-- ⚠️ 仅限本地！本文件通过 config.toml 的 [db.seed] 在 `db reset` 时执行，
--    不会被 `supabase db push` 推送到云端（seed 不是 migration）。
--    切勿把这段逻辑复制进 supabase/migrations/。
--
-- 幂等：可重复执行，不会产生重复用户；已存在则只刷新密码/确认状态/角色。
-- =============================================================================

do $$
declare
  -- ↓↓↓ 需要改账号/密码就改这三行 ↓↓↓
  v_email    text := 'admin@local.test';
  v_password text := 'Admin123456';
  v_name     text := '本地管理员';
  -- ↑↑↑ ------------------------------ ↑↑↑
  v_user_id  uuid;
begin
  -- 复用已存在的同邮箱用户，否则新建
  select id into v_user_id from auth.users where email = v_email;

  if v_user_id is null then
    v_user_id := gen_random_uuid();

    insert into auth.users (
      instance_id, id, aud, role, email,
      encrypted_password, email_confirmed_at,
      confirmation_token, recovery_token, email_change_token_new,
      email_change,
      raw_app_meta_data, raw_user_meta_data,
      created_at, updated_at,
      is_sso_user, is_anonymous
    ) values (
      '00000000-0000-0000-0000-000000000000',
      v_user_id, 'authenticated', 'authenticated', v_email,
      crypt(v_password, gen_salt('bf')), now(),
      '', '', '',
      '',
      '{"provider":"email","providers":["email"]}'::jsonb,
      jsonb_build_object('sub', v_user_id::text, 'email', v_email,
                         'email_verified', true, 'phone_verified', false, 'name', v_name),
      now(), now(),
      false, false
    );

    -- 邮箱密码登录需要一条 identity 记录
    insert into auth.identities (
      provider_id, user_id, identity_data, provider, created_at, updated_at
    ) values (
      v_user_id, v_user_id,
      jsonb_build_object('sub', v_user_id::text, 'email', v_email, 'email_verified', true),
      'email', now(), now()
    );
  else
    -- 已存在：刷新密码 + 确保邮箱已确认
    update auth.users
    set encrypted_password = crypt(v_password, gen_salt('bf')),
        email_confirmed_at = coalesce(email_confirmed_at, now()),
        confirmation_token = '',
        recovery_token = '',
        email_change_token_new = '',
        email_change = '',
        updated_at = now()
    where id = v_user_id;
  end if;

  -- 触发器 create_profile_for_new_user 会以 REVIEWER 建 profile；
  -- 这里确保存在且强制升级为 ADMIN。
  insert into public.user_profile (id, display_name, role)
  values (v_user_id, v_name, 'ADMIN')
  on conflict (id) do update set role = 'ADMIN', updated_at = now();

  raise notice 'Seed admin ready: % (id=%)', v_email, v_user_id;
end $$;
