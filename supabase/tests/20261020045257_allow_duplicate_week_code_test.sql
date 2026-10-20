\set ON_ERROR_STOP on
begin;
set local client_min_messages=warning;
create or replace function pg_temp.assert(p_ok boolean,p_message text)
returns void language plpgsql as $$ begin
  if p_ok is distinct from true then raise exception 'ASSERT FAILED: %',p_message; end if;
end; $$;
create or replace function pg_temp.assert_raises(p_sql text,p_error text)
returns void language plpgsql as $$
begin
  begin execute p_sql;
  exception when others then
    if strpos(sqlerrm,p_error)=0 then raise exception 'Expected %, got %',p_error,sqlerrm; end if;
    return;
  end;
  raise exception 'Expected exception %',p_error;
end; $$;

do $test$
declare
  v_a uuid := gen_random_uuid();
  v_b uuid := gen_random_uuid();
  v_c uuid := gen_random_uuid();
  v_cycle text := '20261020';
  v_count integer;
begin
  -- 1. 结构：week_code 上不再有唯一约束，也不再有唯一索引。
  perform pg_temp.assert(
    not exists (
      select 1
      from pg_constraint con
      join pg_attribute att
        on att.attrelid = con.conrelid and att.attnum = con.conkey[1]
      where con.conrelid = 'public.review_batch'::regclass
        and con.contype = 'u'
        and array_length(con.conkey, 1) = 1
        and att.attname = 'week_code'
    ),
    'week_code 上不应再有唯一约束');

  perform pg_temp.assert(
    not exists (
      select 1 from pg_index idx
      join pg_attribute att
        on att.attrelid = idx.indrelid and att.attnum = any(idx.indkey)
      where idx.indrelid = 'public.review_batch'::regclass
        and idx.indisunique
        and att.attname = 'week_code'
    ),
    'week_code 上不应再有唯一索引');

  -- 2. week_code 仍然必填 —— 这次只放开唯一性，没有放开非空。
  perform pg_temp.assert(
    (select attnotnull from pg_attribute
      where attrelid = 'public.review_batch'::regclass and attname = 'week_code'),
    'week_code 仍须是 not null');

  perform pg_temp.assert_raises(
    $q$insert into public.review_batch (id, name, week_code, default_branch)
       values (gen_random_uuid(), '缺发布周期', null, 'release')$q$,
    'null value in column "week_code"');

  -- 3. 核心行为：同一个发布周期可以有多个批次。
  insert into public.review_batch (id, name, week_code, default_branch)
  values (v_a, '同周期批次 A', v_cycle, 'release');
  insert into public.review_batch (id, name, week_code, default_branch)
  values (v_b, '同周期批次 B', v_cycle, 'feature_dev');
  insert into public.review_batch (id, name, week_code, default_branch)
  values (v_c, '同周期批次 C', v_cycle, 'feature_sit');

  select count(*) into v_count from public.review_batch where week_code = v_cycle;
  perform pg_temp.assert(v_count = 3, format('同一发布周期应能有 3 个批次，实际 %s', v_count));

  -- 4. 主键仍然各自独立：放开的是发布周期，不是批次身份。
  perform pg_temp.assert(
    (select count(distinct id) from public.review_batch where week_code = v_cycle) = 3,
    '三个批次应各有独立 id');

  -- 5. 补的非唯一索引存在（同周期多批次之后"按周期查"会成为常见查法）。
  perform pg_temp.assert(
    exists (select 1 from pg_indexes
      where tablename = 'review_batch' and indexname = 'idx_review_batch_week_code'),
    '应存在 week_code 的非唯一索引');
end;
$test$;

rollback;
