-- 作者别名的清洗与上限收进一个触发器，让三条写入路径共用同一套规则。
--
-- ## 为什么用触发器而不是各改一遍函数
--
-- 现在有三处会写 `developer_git_identity.author_name_aliases`：
--
--   1. `upsert_my_git_identity_from_candidate`（本人按候选绑定，别名默认取提交里的真实作者名）；
--   2. `update_my_git_identity_details`（本人编辑，20260920053820）；
--   3. `upsert_developer_git_identity`（管理员代录）。
--
-- 它们此前各有一套宽严不同的校验：候选那条只卡 `cardinality > 10`，既不去空白也不去重，
-- 更不拦 200 字的别名；编辑那条才做了完整清洗。既然前端现在三处都放开了别名输入，
-- 这种不一致就是真实的入口差异 —— 走"新增"能塞进编辑接口会拒绝的数据。
--
-- 把规则放在表上，谁写都一样，也不必为了改一行校验去 replace 整个 150 行的函数
-- （那种复制粘贴式的 replace 本身就是漂移的来源）。
--
-- ## 规范化的选择
--
--   * 去首尾空白、丢掉空串、去重后按稳定顺序排列 —— 匹配时本来就是小写全等比较，
--     `' 薛宇轩 '` 与 `'薛宇轩'` 是同一个别名，存两份只会让上限 10 个更早被占满；
--   * NULL 保持 NULL、空数组保持空数组：`developer_git_identity_check1` 用
--     `cardinality(author_name_aliases) > 0` 判断"这行有没有可匹配依据"，
--     在这里擅自把两者互换会改变那条约束的行为；
--   * 超过 10 个、单个超 64 字、含控制字符一律 raise，不静默截断 ——
--     悄悄丢掉用户填的别名，比直接告诉他"最多 10 个"更糟。

begin;

create or replace function public.normalize_git_identity_author_aliases()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_cleaned text[];
begin
  if new.author_name_aliases is null then
    return new;
  end if;

  select coalesce(array_agg(alias order by alias), array[]::text[]) into v_cleaned
  from (
    select distinct btrim(candidate) as alias
    from unnest(new.author_name_aliases) as candidate
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

drop trigger if exists normalize_git_identity_author_aliases on public.developer_git_identity;
create trigger normalize_git_identity_author_aliases
before insert or update of author_name_aliases on public.developer_git_identity
for each row execute function public.normalize_git_identity_author_aliases();

comment on function public.normalize_git_identity_author_aliases() is
  'Single normalization point for author_name_aliases: trims, drops blanks, de-duplicates and '
  'enforces the 10 aliases / 64 chars / no control character limits on every write path '
  '(self-service bind, self-service edit, admin entry) instead of once per RPC.';

commit;
