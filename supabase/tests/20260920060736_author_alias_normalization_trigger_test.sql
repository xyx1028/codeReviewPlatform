\set ON_ERROR_STOP on
\timing off

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
  v_dev uuid;
  v_git uuid;
  v_aliases text[];
  v_error text;
begin
  insert into public.developer_identity(display_name,status)
  values('别名规范化','VERIFIED') returning id into v_dev;

  ----------------------------------------------------------------------------
  -- 1. 插入路径：去空白、丢空串、去重
  ----------------------------------------------------------------------------
  insert into public.developer_git_identity(
    developer_identity_id,provider,email_fingerprint,masked_email,email_domain,
    author_name_aliases,verification_status)
  values(v_dev,'git',repeat('a',64),'x***@kingdee.com','kingdee.com',
    array['  薛宇轩 ','薛宇轩','','   ','yuxuan_xue'],'VERIFIED')
  returning id, author_name_aliases into v_git, v_aliases;
  perform pg_temp.assert(v_aliases=array['yuxuan_xue','薛宇轩'] or v_aliases=array['薛宇轩','yuxuan_xue'],
    'insert trims, drops blanks and de-duplicates');
  perform pg_temp.assert(cardinality(v_aliases)=2,'the duplicate and the blanks are gone');

  ----------------------------------------------------------------------------
  -- 2. 更新路径也走同一套（不是只在 insert 上装了个样子）
  ----------------------------------------------------------------------------
  update public.developer_git_identity
  set author_name_aliases=array[' a ','a','b']
  where id=v_git returning author_name_aliases into v_aliases;
  perform pg_temp.assert(v_aliases=array['a','b'],'update is normalized the same way');

  ----------------------------------------------------------------------------
  -- 3. "没有别名"只有一种表示：空数组
  --
  -- 这一列是 not null default '{}'，所以 NULL 根本不是可存储的状态。
  -- 20260920061119 让触发器把 NULL 收敛成空数组，而不是放它去撞约束
  -- （那会给用户一句 "null value in column ... violates not-null constraint"）。
  ----------------------------------------------------------------------------
  update public.developer_git_identity set author_name_aliases=null where id=v_git
  returning author_name_aliases into v_aliases;
  perform pg_temp.assert(v_aliases=array[]::text[],'NULL is coerced to the empty array');
  update public.developer_git_identity set author_name_aliases=array[]::text[] where id=v_git
  returning author_name_aliases into v_aliases;
  perform pg_temp.assert(v_aliases=array[]::text[],'an empty array stays an empty array');

  ----------------------------------------------------------------------------
  -- 4. 超限一律报错，绝不静默截断
  ----------------------------------------------------------------------------
  begin
    update public.developer_git_identity
    set author_name_aliases=array['1','2','3','4','5','6','7','8','9','10','11']
    where id=v_git;
    perform pg_temp.assert(false,'more than ten aliases must raise');
  exception when others then
    get stacked diagnostics v_error=message_text;
    perform pg_temp.assert(v_error='AUTHOR_ALIAS_LIMIT_EXCEEDED','the cap raises instead of truncating');
  end;
  begin
    update public.developer_git_identity set author_name_aliases=array[repeat('n',65)] where id=v_git;
    perform pg_temp.assert(false,'an over-long alias must raise');
  exception when others then
    get stacked diagnostics v_error=message_text;
    perform pg_temp.assert(v_error='GIT_IDENTITY_ALIAS_INVALID','length is enforced on the table');
  end;
  begin
    update public.developer_git_identity set author_name_aliases=array[e'a\tb'] where id=v_git;
    perform pg_temp.assert(false,'a control character must raise');
  exception when others then
    get stacked diagnostics v_error=message_text;
    perform pg_temp.assert(v_error='GIT_IDENTITY_ALIAS_INVALID','control characters are rejected on the table');
  end;
  -- 去重之后才数数：11 个里有重复时不该误报超限
  update public.developer_git_identity
  set author_name_aliases=array['1','1','2','3','4','5','6','7','8','9','10']
  where id=v_git returning author_name_aliases into v_aliases;
  perform pg_temp.assert(cardinality(v_aliases)=10,'the cap counts de-duplicated aliases');

  ----------------------------------------------------------------------------
  -- 5. 这就是收口的意义：从候选绑定这条路也被同一套规则覆盖
  ----------------------------------------------------------------------------
  -- upsert_my_git_identity_from_candidate 自己只卡 cardinality>10，
  -- 但它最终也要写这张表，所以脏别名同样进不去。
  begin
    insert into public.developer_git_identity(
      developer_identity_id,provider,email_fingerprint,masked_email,email_domain,
      author_name_aliases,verification_status)
    values(v_dev,'git',repeat('b',64),'y***@kingdee.com','kingdee.com',
      array[repeat('m',100)],'VERIFIED');
    perform pg_temp.assert(false,'no write path can bypass the alias rules');
  exception when others then
    get stacked diagnostics v_error=message_text;
    perform pg_temp.assert(v_error='GIT_IDENTITY_ALIAS_INVALID','every write path shares one boundary');
  end;
end;
$test$;

rollback;
