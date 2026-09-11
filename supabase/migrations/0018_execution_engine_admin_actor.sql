-- ---------------------------------------------------------------------------
-- 0018：修正 admin_set_model_execution_engine 的管理员校验方式。
--
-- 背景（真实故障）：0017 里该函数用 ensure_admin()，它依赖 auth.uid()。但这个
-- 函数的唯一调用方是 admin-model-config Edge Function，而 Edge Function 用
-- service_role key 调 RPC 且不携带用户 JWT，因此 auth.uid() 为 NULL，
-- ensure_admin() 必然抛 'ADMIN role required'，导致模型管理页保存一律失败。
--
-- 0017 的测试没抓到，是因为 fixture 里 set_config('request.jwt.claims', ...)
-- 在整个事务内一直有效，测试里 auth.uid() 恰好有值。0018 的测试显式清空
-- claims，复现 Edge Function 的真实调用条件。
--
-- 修正方式与 0010/0012/0015 的既有约定一致：由调用方显式传入 p_actor_id，
-- 函数内用 assert_actor_is_admin(p_actor_id) 校验，权限只授予 service_role。
-- 这样管理员身份来自 Edge Function 已验证过的 JWT，而不是数据库会话状态。
--
-- 纯修正迁移：不改任何表结构，不改任何数据。
-- ---------------------------------------------------------------------------

begin;

-- 参数表变了（新增 p_actor_id 作为第一个参数），create or replace 会产生重载而
-- 不是替换，因此必须先删旧签名。删掉旧签名同时也保证：万一 Edge Function 尚未
-- 更新，调用会直接报"函数不存在"，而不是以无 actor 的方式静默通过。
drop function if exists public.admin_set_model_execution_engine(
  uuid, text, integer, integer, integer, integer, integer);

create or replace function public.admin_set_model_execution_engine(
  p_actor_id uuid,
  p_id uuid,
  p_execution_engine text,
  p_context_window integer default null,
  p_max_output_tokens integer default null,
  p_agent_max_model_requests integer default null,
  p_agent_max_retry_requests integer default null,
  p_agent_max_compaction_requests integer default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.assert_actor_is_admin(p_actor_id);

  if p_execution_engine not in ('legacy-openai', 'deepseek-harness-acp') then
    raise exception 'unsupported execution engine: %', p_execution_engine;
  end if;

  update public.ai_model_config
  set execution_engine = p_execution_engine,
      context_window = coalesce(p_context_window, context_window),
      max_output_tokens = coalesce(p_max_output_tokens, max_output_tokens),
      agent_max_model_requests = coalesce(p_agent_max_model_requests, agent_max_model_requests),
      agent_max_retry_requests = coalesce(p_agent_max_retry_requests, agent_max_retry_requests),
      agent_max_compaction_requests =
        coalesce(p_agent_max_compaction_requests, agent_max_compaction_requests)
  where id = p_id;

  if not found then
    raise exception 'model config not found';
  end if;
end;
$$;

-- 与 admin_create_model_config / admin_update_model_config 一致：只有
-- service_role 能执行。前端不再直连这个 RPC，引擎变更只经过带审计的
-- Edge Function 路径。
--
-- 注：这里 revoke 里保留 authenticated 是必要的。0017 曾把执行权限授予
-- authenticated，drop function 虽然会一并丢弃 grant，但显式 revoke 让"前端不得
-- 直连"这条约束写在迁移里，而不是依赖 drop 的副作用。
revoke execute on function public.admin_set_model_execution_engine(
  uuid, uuid, text, integer, integer, integer, integer, integer)
  from public, anon, authenticated;
grant execute on function public.admin_set_model_execution_engine(
  uuid, uuid, text, integer, integer, integer, integer, integer)
  to service_role;

-- ---------------------------------------------------------------------------
-- 同类既有缺陷：admin_get_model_secret_id（0010 9.4）
--
-- 它和上面修掉的问题是同一个成因，只是一直没被触发：
--   * 权限只授予 service_role（0010 第 2005/2010 行）；
--   * 却用 ensure_admin() 判权，而 ensure_admin() 依赖 auth.uid()。
-- 也就是说，在它唯一被允许的调用路径上，这个函数永远抛 'ADMIN role required'。
-- 目前仓库里没有任何调用方（只在 Edge Function 的依赖注释里被提到），所以线上
-- 没有表现出故障，但只要有人按注释去用它就会立刻踩到。
--
-- 这里按同一约定修正而不是删除：删除是不可逆的 schema 变更，而这个函数的用途
-- （只取 secret 引用、不取明文）是合理的，值得保留成可用状态。
-- ---------------------------------------------------------------------------

drop function if exists public.admin_get_model_secret_id(uuid);

create or replace function public.admin_get_model_secret_id(
  p_actor_id uuid,
  p_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_secret uuid;
begin
  perform public.assert_actor_is_admin(p_actor_id);
  select api_key_secret_id into v_secret from public.ai_model_config where id = p_id;
  if v_secret is null then
    raise exception 'model config not found';
  end if;
  return v_secret;
end;
$$;

revoke execute on function public.admin_get_model_secret_id(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.admin_get_model_secret_id(uuid, uuid)
  to service_role;

commit;
