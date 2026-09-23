--
-- Git 身份邮箱改为明文存储与显示
--
-- ## 为什么改
--
-- 这套平台只在内部使用，成员的公司邮箱本来就公开（提交记录、MR、GitLab 用户页上都是明文）。
-- 原设计只存 HMAC 指纹 + `x***@domain` 掩码，代价是每天都在付：
--
--   * 列表上看不出这一行到底是谁的邮箱 —— 同一个首字母 + 同一个域名的人会并排出现，
--     `j***@kingdee.com` 在实测数据里就同时是 jin_gu 与 junjie_xiang 两行；
--   * 管理员编辑弹窗无法回显，只想改个作者别名也得把整个邮箱重打一遍，打错还会多出一行；
--   * 明文其实早就在库里了：`git_identity_email_candidate.email_plain` 存着反查出来的候选邮箱，
--     并且已经通过 `get_my_git_email_discovery` 返回给本人。掩码只拦住了管理员自己。
--
-- ## 改什么、不改什么
--
--   * 新增 `developer_git_identity.author_email` 明文列，并从候选表按指纹回填历史行；
--   * `email_fingerprint` 仍然是归属匹配与 Job 身份快照的唯一键，**一个字都不动**。明文只用于
--     界面显示与编辑回显，提交侧（`analysis_repository_commit.author_email_masked`）本次不动；
--   * `masked_email` 保留：审计行引用它，回填不到明文的历史行也还要靠它显示。
--
-- 可重复应用：加列、加约束、回填、触发器、函数替换都是幂等的。
--

begin;

------------------------------------------------------------------------------
-- 1. 明文列
------------------------------------------------------------------------------

alter table public.developer_git_identity
  add column if not exists author_email text;

alter table public.developer_git_identity
  drop constraint if exists developer_git_identity_author_email_check;
alter table public.developer_git_identity
  add constraint developer_git_identity_author_email_check
  check (
    author_email is null
    or (
      char_length(author_email) <= 320
      and author_email ~ '^[^@[:space:][:cntrl:]]{1,64}@[^@[:space:][:cntrl:]]{1,255}$'
      and author_email = lower(author_email)
    )
  );

comment on column public.developer_git_identity.author_email is
  '提交里的 Git author email 明文，仅用于界面显示与编辑回显；归属匹配一律用 email_fingerprint。'
  '历史行可能为 null（改造前从未存过明文，且候选表里也没有对应指纹）。';

------------------------------------------------------------------------------
-- 2. 回填历史行：明文来自本人反查出来的候选
------------------------------------------------------------------------------

update public.developer_git_identity git
set author_email = candidate.email_plain
from (
  select distinct on (email_fingerprint) email_fingerprint, lower(email_plain) as email_plain
  from public.git_identity_email_candidate
  where email_plain is not null
  order by email_fingerprint, created_at desc
) candidate
where git.author_email is null
  and git.email_fingerprint = candidate.email_fingerprint
  and candidate.email_plain ~ '^[^@[:space:][:cntrl:]]{1,64}@[^@[:space:][:cntrl:]]{1,255}$';

------------------------------------------------------------------------------
-- 3. 自助路径的明文补齐
--
-- 本人绑定走 upsert_my_git_identity_from_candidate / _from_email，两者都很长且逻辑密集。
-- 与其重抄一遍，不如让明文在写入时自动补齐：指纹能在候选表里找到明文就带上。
-- 这样两个函数保持原样，新旧 Worker/前端混跑期间也不会有行为差。
------------------------------------------------------------------------------

create or replace function public.fill_git_identity_author_email()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.author_email is null and new.email_fingerprint is not null then
    select lower(candidate.email_plain) into new.author_email
    from public.git_identity_email_candidate candidate
    where candidate.email_fingerprint = new.email_fingerprint
      and candidate.email_plain is not null
    order by candidate.created_at desc
    limit 1;
  end if;
  return new;
end;
$$;

comment on function public.fill_git_identity_author_email() is
  '写入 Git 身份时，若调用方没给明文邮箱，则按指纹从反查候选里补一个。';

drop trigger if exists trg_fill_git_identity_author_email on public.developer_git_identity;
create trigger trg_fill_git_identity_author_email
  before insert or update of email_fingerprint, author_email
  on public.developer_git_identity
  for each row execute function public.fill_git_identity_author_email();

------------------------------------------------------------------------------
-- 4. 管理员代录：明文直接落库并回传
------------------------------------------------------------------------------

create or replace function public.admin_upsert_developer_git_identity_from_email(
  p_developer_id uuid,
  p_git_identity_id uuid,
  p_display_name text,
  p_employee_code text,
  p_email text,
  p_author_name_aliases text[] default array[]::text[],
  p_gitlab_username text default null,
  p_gitlab_user_id text default null,
  p_developer_status text default 'VERIFIED',
  p_verification_status text default 'VERIFIED',
  p_expected_revision integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, vault, extensions
as $$
declare
  v_actor uuid := auth.uid();
  v_email text;
  v_domain text;
  v_local text;
  v_masked text;
  v_pepper text;
  v_fingerprint text;
  v_result jsonb;
begin
  perform public.ensure_admin();

  v_email := lower(btrim(coalesce(p_email,'')));
  if char_length(v_email) > 320
     or v_email !~ '^[^@[:space:][:cntrl:]]{1,64}@[^@[:space:][:cntrl:]]{1,255}$' then
    raise exception 'IDENTITY_EMAIL_INVALID';
  end if;

  select secret.decrypted_secret into v_pepper
  from vault.decrypted_secrets secret
  where secret.name='analysis_identity_pepper'
  order by secret.created_at desc
  limit 1;
  if coalesce(v_pepper,'')='' then raise exception 'IDENTITY_PEPPER_MISSING'; end if;

  v_local := split_part(v_email,'@',1);
  v_domain := split_part(v_email,'@',2);
  v_masked := left(v_local,1)||'***@'||v_domain;
  v_fingerprint := encode(hmac(
    convert_to(v_email,'UTF8'),
    convert_to(v_pepper,'UTF8'),
    'sha256'
  ),'hex');

  v_result := public.admin_upsert_developer_git_identity(
    v_actor,
    p_developer_id,
    p_git_identity_id,
    p_display_name,
    p_employee_code,
    p_developer_status,
    'gitlab',
    v_fingerprint,
    v_masked,
    v_domain,
    coalesce(p_author_name_aliases,array[]::text[]),
    p_gitlab_username,
    p_gitlab_user_id,
    p_verification_status,
    p_expected_revision
  );

  -- 明文由管理员当场输入，直接落库（触发器只负责调用方没给明文的情况）。
  update public.developer_git_identity
  set author_email = v_email
  where id = (v_result->>'git_identity_id')::uuid
    and author_email is distinct from v_email;

  return v_result || jsonb_build_object(
    'masked_email',v_masked,
    'author_email',v_email,
    'provider','gitlab'
  );
end;
$$;

revoke execute on function public.admin_upsert_developer_git_identity_from_email(
  uuid,uuid,text,text,text,text[],text,text,text,text,integer
) from public,anon;
grant execute on function public.admin_upsert_developer_git_identity_from_email(
  uuid,uuid,text,text,text,text[],text,text,text,text,integer
) to authenticated,service_role;

-- 原注释说"明文永不存储也不返回"，现在两者都做了，注释必须跟上。
comment on function public.admin_upsert_developer_git_identity_from_email(
  uuid,uuid,text,text,text,text[],text,text,text,text,integer
) is 'ADMIN only. HMACs the normalized Git email with Vault analysis_identity_pepper for matching, '
  'and also stores the plaintext in developer_git_identity.author_email for display/edit (internal tool, corporate emails are public).';

------------------------------------------------------------------------------
-- 5. 两个读取口暴露明文
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
      'author_email', git.author_email,
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

create or replace function public.get_my_git_identity()
returns jsonb
language plpgsql
security definer
set search_path = public
stable
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
        'author_email', git.author_email,
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

commit;
