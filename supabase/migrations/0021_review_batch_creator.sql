-- 评审列表需要展示创建人，但不应向所有登录用户开放完整用户目录。
-- 通过受控 RPC 仅返回批次创建人的显示名称。

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
  creator_name text
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
    end as creator_name
  from public.review_batch batch
  left join public.user_profile profile on profile.id = batch.created_by
  order by batch.created_at desc;
end;
$$;

revoke execute on function public.list_review_batches_with_creator() from public, anon;
grant execute on function public.list_review_batches_with_creator() to authenticated;
