-- V1.13 补齐 Git 邮箱行的「编辑」与「删除」两个自助操作。
--
-- ## 编辑的范围是可填内容，不含邮箱
--
-- 一行 Git 身份里有两类东西：
--
--   * **验证得来的**：`email_fingerprint` / `masked_email` / `email_domain`。它们只能由
--     GitLab 反查后落库（20260920045313 已把手输入口收回），编辑接口一律不碰；
--   * **用户填写的**：`author_name_aliases`（作者别名）与 `gitlab_username`。它们就是页面
--     表格里展示的两列，写错了必须能改 —— 反查时自动带出来的别名可能是
--     `kingdee` 这种机器默认值，跟需求里的写法差很远。
--
-- 别名是弱匹配来源（NAME_ALIAS，仅在邮箱对不上时兜底），本人编辑只影响自己的归属，
-- 权限边界与管理员代录时相同，因此不降级 `verification_status`：
-- 邮箱是否可信跟别名叫什么无关。
--
-- ## 删除 vs 停用
--
-- `analysis_job_identity_snapshot.source_git_identity_id` 是 `on delete restrict`：
-- 一旦某次分析冻结过这条身份，硬删就会切断那次分析结论的可追溯链。所以：
--
--   * 没被任何 Job 快照引用过（刚配错、还没跑过分析）→ 允许真删，表里不留垃圾行；
--   * 已被引用 → 以 `GIT_IDENTITY_IN_USE` 明确拒绝，并让用户改用「停用」。
--     绝不把这种情况偷偷降级成停用：用户点的是删除，得到的却是另一件事，比报错更糟。
--
-- 删除前先把 masked_email 写进 append-only 审计，所以删掉的行也留得下痕迹。

begin;

------------------------------------------------------------------------------
-- 1. 编辑：作者别名 + GitLab 用户名
------------------------------------------------------------------------------

create or replace function public.update_my_git_identity_details(
  p_git_identity_id uuid,
  p_author_name_aliases text[] default null,
  p_gitlab_username text default null,
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
  v_aliases text[];
  v_username text;
  v_before jsonb;
begin
  if v_actor is null then raise exception 'AUTH_REQUIRED'; end if;

  select * into v_developer from public.developer_identity where auth_user_id = v_actor;
  if v_developer.id is null then raise exception 'DEVELOPER_IDENTITY_NOT_FOUND'; end if;

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
  if v_git.verification_status = 'DISABLED' then
    -- 已停用的行不该还能改：它不参与匹配，改它只会让人误以为生效了。
    raise exception 'GIT_IDENTITY_DISABLED';
  end if;

  -- 去空白、去空串、去重，保持稳定顺序；整体为空则存 NULL 而不是 '{}'，
  -- 让 developer_git_identity_check1 的 cardinality 判定行为一致。
  select coalesce(array_agg(alias order by alias), null) into v_aliases
  from (
    select distinct btrim(unnest) as alias
    from unnest(coalesce(p_author_name_aliases, array[]::text[]))
    where nullif(btrim(unnest), '') is not null
  ) cleaned;

  if v_aliases is not null then
    if array_length(v_aliases, 1) > 10 then raise exception 'GIT_IDENTITY_TOO_MANY_ALIASES'; end if;
    if exists (select 1 from unnest(v_aliases) a where char_length(a) > 64 or a ~ '[[:cntrl:]]') then
      raise exception 'GIT_IDENTITY_ALIAS_INVALID';
    end if;
  end if;

  v_username := nullif(btrim(coalesce(p_gitlab_username, '')), '');
  if v_username is not null and v_username !~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,48}$' then
    raise exception 'GITLAB_USERNAME_INVALID';
  end if;

  -- 邮箱指纹为空的行（纯别名匹配）不能把别名和用户名同时清空，否则整行没有任何可匹配依据。
  if v_git.email_fingerprint is null and v_aliases is null and v_username is null
     and v_git.gitlab_user_id is null then
    raise exception 'GIT_IDENTITY_WOULD_MATCH_NOTHING';
  end if;

  v_before := jsonb_build_object(
    'author_name_aliases', v_git.author_name_aliases,
    'gitlab_username', v_git.gitlab_username
  );

  update public.developer_git_identity
  set author_name_aliases = v_aliases,
      gitlab_username = v_username,
      revision = revision + 1,
      updated_by = v_actor,
      updated_at = now()
  where id = v_git.id
  returning * into v_git;

  insert into public.analysis_scope_decision_audit(
    decision_type, source, actor_id, reason_codes, before_state, after_state
  ) values (
    'IDENTITY_CONFIG', 'USER', v_actor, array['SELF_GIT_IDENTITY_EDITED'], v_before,
    jsonb_build_object(
      'developer_id', v_developer.id,
      'git_identity_id', v_git.id,
      'masked_email', v_git.masked_email,
      'author_name_aliases', v_git.author_name_aliases,
      'gitlab_username', v_git.gitlab_username
    )
  );

  return jsonb_build_object(
    'git_identity_id', v_git.id,
    'git_revision', v_git.revision,
    'author_name_aliases', v_git.author_name_aliases,
    'gitlab_username', v_git.gitlab_username,
    'verification_status', v_git.verification_status
  );
end;
$$;

------------------------------------------------------------------------------
-- 2. 删除：没进过分析快照才允许，否则要求改用停用
------------------------------------------------------------------------------

create or replace function public.delete_my_git_identity(
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
  v_snapshot_count integer;
begin
  if v_actor is null then raise exception 'AUTH_REQUIRED'; end if;

  select * into v_developer from public.developer_identity where auth_user_id = v_actor;
  if v_developer.id is null then raise exception 'DEVELOPER_IDENTITY_NOT_FOUND'; end if;

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

  select count(*) into v_snapshot_count
  from public.analysis_job_identity_snapshot
  where source_git_identity_id = v_git.id;
  if v_snapshot_count > 0 then
    -- 交给前端翻译成"这条邮箱参与过 N 次分析，只能停用"。不静默降级成停用。
    raise exception 'GIT_IDENTITY_IN_USE';
  end if;

  -- 先审计后删除：行没了，痕迹还在（脱敏邮箱，不含明文）。
  insert into public.analysis_scope_decision_audit(
    decision_type, source, actor_id, reason_codes, before_state
  ) values (
    'IDENTITY_CONFIG', 'USER', v_actor, array['SELF_GIT_IDENTITY_DELETED'],
    jsonb_build_object(
      'developer_id', v_developer.id,
      'git_identity_id', v_git.id,
      'masked_email', v_git.masked_email,
      'email_domain', v_git.email_domain,
      'gitlab_username', v_git.gitlab_username,
      'verification_status', v_git.verification_status
    )
  );

  delete from public.developer_git_identity where id = v_git.id;

  return jsonb_build_object('git_identity_id', v_git.id, 'deleted', true);
end;
$$;

------------------------------------------------------------------------------
-- 3. 最小权限
------------------------------------------------------------------------------

revoke execute on function public.update_my_git_identity_details(uuid, text[], text, integer)
  from public, anon;
grant execute on function public.update_my_git_identity_details(uuid, text[], text, integer)
  to authenticated, service_role;

revoke execute on function public.delete_my_git_identity(uuid, integer) from public, anon;
grant execute on function public.delete_my_git_identity(uuid, integer) to authenticated, service_role;

comment on function public.update_my_git_identity_details(uuid, text[], text, integer) is
  'Lets a member fix the two fields they typed themselves (author aliases, GitLab username) on '
  'their own Git identity row. Never touches the verified email fingerprint or its masked form.';

comment on function public.delete_my_git_identity(uuid, integer) is
  'Hard-deletes a Git identity row that no analysis job has frozen yet; raises '
  'GIT_IDENTITY_IN_USE otherwise so the caller uses disable_my_git_identity and keeps history auditable.';

commit;
