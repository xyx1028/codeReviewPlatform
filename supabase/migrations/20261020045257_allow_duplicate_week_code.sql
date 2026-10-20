-- 允许发布周期重复（V1.61）
--
-- 背景：`review_batch.week_code`（页面上的「发布周期」）从 0001 起就是 `not null unique`。
-- 这条唯一性在产品上不成立 —— 同一个发布周期下本来就可能有多个批次（按模块拆、按代码基线
-- 拆、重跑一次评审），而唯一约束把它们挡在了"创建批次"那一步，报出来的还是一句
-- `duplicate key value violates unique constraint "review_batch_week_code_key"`。
--
-- 这条约束还逼出了一处不该存在的复杂度：远程 MCP 为了不撞唯一键，必须给自动生成的发布周期
-- 加上时分秒和随机后缀（`20261019-MCP174949-20be86`），结果在批次列表里和人工批次的
-- `20261016` 完全不是一类值。去掉唯一性之后，MCP 可以和页面一样只写 8 位日期。
--
-- 保留 `not null`：发布周期在页面上是必填项，这一点没有变化。
--
-- 影响范围：没有任何 RPC / RLS / 前端逻辑按 `week_code` 唯一定位批次（已全仓检索确认，
-- 唯一的另一处引用是 `operation_log.batch_week_code_snapshot`，那是删除批次时留存的快照
-- 副本，与唯一性无关）。因此这是一次纯放宽，既有数据与在途任务都不受影响。
--
-- 回滚：不提供 down migration（本仓库禁止）。若将来真要恢复唯一性，需要另写一个前进的
-- 迁移，并且**先处理掉届时已经存在的重复值** —— 直接加约束会失败。

do $$
declare
  v_constraint text;
begin
  -- 按"唯一且只约束 week_code 这一列"去找，而不是写死约束名：
  -- 名字是建表时由 Postgres 隐式生成的，不同环境若手工重建过可能叫别的。
  for v_constraint in
    select con.conname
    from pg_constraint con
    join pg_attribute att
      on att.attrelid = con.conrelid
     and att.attnum = con.conkey[1]
    where con.conrelid = 'public.review_batch'::regclass
      and con.contype = 'u'
      and array_length(con.conkey, 1) = 1
      and att.attname = 'week_code'
  loop
    execute format('alter table public.review_batch drop constraint %I', v_constraint);
  end loop;
end;
$$;

-- 兜底：按默认名再删一次（上面的循环已经覆盖，这一行只为可重复应用时语义更直白）。
alter table public.review_batch
  drop constraint if exists review_batch_week_code_key;

-- 唯一索引随约束一起消失。这里补一个**非唯一**索引：批次列表按 created_at 排序，
-- 目前没有按 week_code 过滤的查询，但"同一发布周期下有哪些批次"是这次放开之后
-- 必然会出现的查法，留一个索引比将来再加便宜。
create index if not exists idx_review_batch_week_code
  on public.review_batch (week_code);

comment on column public.review_batch.week_code is
  'V1.61：发布周期（页面上年/月/日拼成的 YYYYMMDD）。必填但**不唯一** —— 同一周期下允许多个批次。';
