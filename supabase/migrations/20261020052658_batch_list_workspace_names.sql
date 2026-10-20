-- 评审列表增加「项目组」（V1.62）
--
-- 背景：评审列表上能看到发布周期、状态、代码基线、模型、创建人，但看不到这批需求来自哪个
-- 项目组。而项目组恰恰是最常用的筛选维度 —— 一个人通常只关心自己组的评审。
--
-- 项目组为什么是推导出来的：`review_batch` 本身没有项目组列，也不该有。一个批次的项目组
-- 是它**里面的需求**决定的（`review_story.linky_workspace_name`，由 Worker 在内网取数时
-- 冻结）。这里不新增列、不做冗余存储，直接在列表 RPC 里聚合，理由是：
--   · 冗余列需要在导入、重试、删除需求等每条路径上维护一致性，而它只服务一个展示列；
--   · 批次数量是人工创建的量级（几十到几百），聚合成本可以忽略。
--
-- 两级来源，顺序刻意：
--   1. `review_story.linky_workspace_name` —— 已经冻结进批次的需求，这是事实；
--   2. 批次里还没有需求时，退到最近一张导入单的 `workspace_name` —— 这覆盖"导入排队中"
--      和"导入失败"两种状态。后者尤其有用：一个空批次能显示出它**本来要导入哪个组**，
--      否则列表上只有一个没有任何线索的空行。
--   3. 两者都没有 → 返回空数组。Excel 时代导入的历史批次就是这种情况（实测本地库里
--      那个 26 条需求的批次 `linky_workspace_name` 全为 null），如实留空，不编造。
--
-- 返回 text[] 而不是单个 text：一个批次理论上可以含多个项目组的需求（导入是按组发起的，
-- 但同一批次可以发起多次导入）。前端按数组渲染与筛选，不在这里拼字符串 —— 拼了就没法
-- 按单个项目组精确过滤。
--
-- 注意：这里必须 drop 后重建，不能只用 create or replace ——
-- `create or replace function` 改不了 RETURNS TABLE 的列集合。

drop function if exists public.list_review_batches_with_creator();

create or replace function public.list_review_batches_with_creator()
returns table (
  id uuid,
  name text,
  week_code text,
  status text,
  default_branch text,
  remark text,
  created_by uuid,
  completed_at timestamptz,
  ai_model_config_id uuid,
  ai_model_snapshot jsonb,
  created_at timestamptz,
  updated_at timestamptz,
  creator_name text,
  workspace_names text[]
)
language plpgsql
security definer
set search_path = public
stable
as $$
begin
  if (select auth.uid()) is null then
    raise exception 'login required';
  end if;

  return query
  select
    batch.id,
    batch.name,
    batch.week_code,
    batch.status,
    batch.default_branch,
    batch.remark,
    batch.created_by,
    batch.completed_at,
    batch.ai_model_config_id,
    batch.ai_model_snapshot,
    batch.created_at,
    batch.updated_at,
    case
      when batch.created_by is null then null
      else coalesce(nullif(btrim(profile.display_name), ''), '用户')
    end as creator_name,
    coalesce(
      -- 1. 已冻结进批次的需求所属项目组（排序固定，便于前端稳定渲染）
      (
        select array_agg(distinct story.linky_workspace_name order by story.linky_workspace_name)
        from public.review_story story
        where story.batch_id = batch.id
          and nullif(btrim(story.linky_workspace_name), '') is not null
      ),
      -- 2. 批次里还没有需求时，退到最近一张导入单想导入的项目组
      (
        select array[nullif(btrim(request.workspace_name), '')]
        from public.linky_batch_import_request request
        where request.batch_id = batch.id
          and nullif(btrim(request.workspace_name), '') is not null
        order by request.created_at desc
        limit 1
      ),
      -- 3. 都没有（Excel 时代的历史批次）：如实留空
      array[]::text[]
    ) as workspace_names
  from public.review_batch batch
  left join public.user_profile profile on profile.id = batch.created_by
  order by batch.created_at desc;
end;
$$;

revoke execute on function public.list_review_batches_with_creator() from public, anon;
grant execute on function public.list_review_batches_with_creator() to authenticated;

comment on function public.list_review_batches_with_creator() is
  'V1.62：评审列表。workspace_names 由需求快照聚合得到，批次为空时退到最近一张导入单；'
  '两者都没有时为空数组（Excel 时代的历史批次）。';

-- 聚合要按 batch_id 过滤 review_story，补一个索引。
create index if not exists idx_review_story_batch_workspace
  on public.review_story (batch_id, linky_workspace_name);
