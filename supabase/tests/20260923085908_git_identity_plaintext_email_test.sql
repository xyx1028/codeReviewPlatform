\set ON_ERROR_STOP on
\timing off

-- Git 身份明文邮箱的行为断言。
-- 断言四件事：约束只放行规范化后的邮箱、触发器能按指纹补明文、
-- 显式写入的明文不被覆盖、两个读取口都带上 author_email 且指纹仍是唯一匹配键。

begin;
set local client_min_messages=warning;

create or replace function pg_temp.assert(p_condition boolean,p_message text)
returns void language plpgsql as $$
begin
  if p_condition is distinct from true then raise exception 'ASSERT FAILED: %',p_message; end if;
end;
$$;

do $test$
declare
  v_developer uuid;
  v_git uuid;
  v_discovery uuid;
  v_requester uuid;
  v_email text := 'plain.case@kingdee.com';
  v_fingerprint text := repeat('a',64);
  v_stored text;
  v_failed boolean;
begin
  select id into v_requester from auth.users order by created_at limit 1;
  perform pg_temp.assert(v_requester is not null,'测试需要至少一个 auth 用户');

  insert into public.developer_identity(display_name,status)
  values('明文邮箱用例','VERIFIED') returning id into v_developer;

  ----------------------------------------------------------------------------
  -- 1. 约束：大写、缺 @ 一律拒绝
  ----------------------------------------------------------------------------
  v_failed := false;
  begin
    insert into public.developer_git_identity(
      developer_identity_id,provider,email_fingerprint,masked_email,email_domain,author_email
    ) values (v_developer,'gitlab',repeat('b',64),'P***@kingdee.com','kingdee.com','Plain.Case@kingdee.com');
  exception when check_violation then v_failed := true;
  end;
  perform pg_temp.assert(v_failed,'大写明文必须被 CHECK 拒绝');

  v_failed := false;
  begin
    insert into public.developer_git_identity(
      developer_identity_id,provider,email_fingerprint,masked_email,email_domain,author_email
    ) values (v_developer,'gitlab',repeat('c',64),'p***@kingdee.com','kingdee.com','not-an-email');
  exception when check_violation then v_failed := true;
  end;
  perform pg_temp.assert(v_failed,'缺 @ 的明文必须被 CHECK 拒绝');

  ----------------------------------------------------------------------------
  -- 2. 触发器：调用方没给明文时，按指纹从反查候选里补
  ----------------------------------------------------------------------------
  insert into public.git_identity_email_discovery(requested_by,gitlab_username,status)
  values(v_requester,'plain_case','SUCCEEDED') returning id into v_discovery;
  insert into public.git_identity_email_candidate(
    discovery_id,email_fingerprint,masked_email,email_domain,email_plain
  ) values(v_discovery,v_fingerprint,'p***@kingdee.com','kingdee.com',v_email);

  insert into public.developer_git_identity(
    developer_identity_id,provider,email_fingerprint,masked_email,email_domain
  ) values (v_developer,'gitlab',v_fingerprint,'p***@kingdee.com','kingdee.com')
  returning id, author_email into v_git, v_stored;
  perform pg_temp.assert(v_stored = v_email,
    format('触发器应补出 %s，实际 %s',v_email,coalesce(v_stored,'(null)')));

  ----------------------------------------------------------------------------
  -- 3. 显式写入的明文不被触发器覆盖
  ----------------------------------------------------------------------------
  update public.developer_git_identity
  set author_email='explicit.value@kingdee.com'
  where id=v_git
  returning author_email into v_stored;
  perform pg_temp.assert(v_stored='explicit.value@kingdee.com','显式写入的明文不能被触发器覆盖');

  ----------------------------------------------------------------------------
  -- 4. 两个读取口都暴露明文；明文列不参与任何索引/唯一约束（指纹才是匹配键）
  ----------------------------------------------------------------------------
  perform pg_temp.assert(
    pg_get_functiondef('public.admin_list_developer_git_identities()'::regprocedure) like '%author_email%',
    'admin_list_developer_git_identities 必须返回 author_email');
  perform pg_temp.assert(
    pg_get_functiondef('public.get_my_git_identity()'::regprocedure) like '%author_email%',
    'get_my_git_identity 必须返回 author_email');
  perform pg_temp.assert(
    not exists (
      select 1 from pg_index i
      join pg_attribute a on a.attrelid=i.indrelid and a.attnum = any(i.indkey)
      where i.indrelid='public.developer_git_identity'::regclass
        and a.attname='author_email'
    ),
    'author_email 不应进入任何索引或唯一约束');

  raise notice 'git identity plaintext email: all assertions passed';
end;
$test$;

rollback;
