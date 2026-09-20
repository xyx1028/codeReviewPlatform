-- 修缺陷：清空作者别名会撞 NOT NULL。
--
-- `developer_git_identity.author_name_aliases` 是 `not null default '{}'`，
-- 但 20260920053820 的 `update_my_git_identity_details` 在别名被清空时写的是 NULL，
-- 于是"把别名全删掉"这个完全正常的操作会以
-- `null value in column "author_name_aliases" ... violates not-null constraint`
-- 失败 —— 一句用户完全看不懂、前端也翻译不了的报错。
--
-- 正确的表示是空数组：**这张表里"没有别名"只有一种写法**。
-- 20260920060736 的规范化触发器也一并把 NULL 收敛成 '{}'，
-- 这样任何写入路径都不可能再把 NULL 送到约束面前。
--
-- 连带调整：判断"这行还有没有可匹配依据"从 `is null` 改成 `cardinality = 0`，
-- 否则空数组会绕过 GIT_IDENTITY_WOULD_MATCH_NOTHING 那道门。

begin;

create or replace function public.normalize_git_identity_author_aliases()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_cleaned text[];
begin
  -- 列本身是 not null，所以 NULL 不是一种可存储的状态；把它当"没有别名"处理，
  -- 而不是让它一路走到约束那里变成一句天书。
  select coalesce(array_agg(alias order by alias), array[]::text[]) into v_cleaned
  from (
    select distinct btrim(candidate) as alias
    from unnest(coalesce(new.author_name_aliases, array[]::text[])) as candidate
    where nullif(btrim(candidate), '') is not null
  ) cleaned;

  if cardinality(v_cleaned) > 10 then
    raise exception 'AUTHOR_ALIAS_LIMIT_EXCEEDED';
  end if;
  if exists (select 1 from unnest(v_cleaned) alias where char_length(alias) > 64) then
    raise exception 'GIT_IDENTITY_ALIAS_INVALID';
  end if;
  if exists (select 1 from unnest(v_cleaned) alias where alias ~ '[[:cntrl:]]') then
    raise exception 'GIT_IDENTITY_ALIAS_INVALID';
  end if;

  new.author_name_aliases := v_cleaned;
  return new;
end;
$$;

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
    raise exception 'GIT_IDENTITY_DISABLED';
  end if;

  -- 清洗与上限由表上的 normalize_git_identity_author_aliases 统一负责；
  -- 这里只把入参落成"空数组 = 没有别名"这一种表示。
  v_aliases := coalesce(p_author_name_aliases, array[]::text[]);

  v_username := nullif(btrim(coalesce(p_gitlab_username, '')), '');
  if v_username is not null and v_username !~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,48}$' then
    raise exception 'GITLAB_USERNAME_INVALID';
  end if;

  -- 没有邮箱指纹的行靠别名或 GitLab 身份匹配；全清空就再也匹配不到任何提交。
  if v_git.email_fingerprint is null
     and cardinality(array_remove(v_aliases, '')) = 0
     and v_username is null
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

revoke execute on function public.update_my_git_identity_details(uuid, text[], text, integer)
  from public, anon;
grant execute on function public.update_my_git_identity_details(uuid, text[], text, integer)
  to authenticated, service_role;

commit;
