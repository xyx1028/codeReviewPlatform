-- V1.7 阶段二：模型网络类型（DIRECT / HOST_PROXY）
--
-- 用**模型自己的属性**决定它走不走本机代理，取代阶段一的"目标域名白名单"。
--
-- 白名单错在抽象层次：它把"这个模型在哪张网上"编码成了代理进程的一个环境变量。后果是
-- 实测出来的两个缺陷：
--
--   1. 公网模型被误伤 —— 连接测试无条件把请求送进代理，代理发现主机不在白名单就回
--      HTTP 403，用户看到的却是"模型返回 403"，而真正的拒绝方是我们自己；
--   2. 正式评审链路根本没走代理 —— 代理只接在"测试连接"上，于是内网模型能测通、真跑
--      评审时必然失败。绿灯之后才失败是最坏的一种不一致。
--
-- 默认值是 `DIRECT`：既有模型行为一字不变，DashScope 的 403 因此消失。

------------------------------------------------------------------------------
-- 1. 模型配置增列
------------------------------------------------------------------------------

alter table public.ai_model_config
  add column if not exists network_access_mode text not null default 'DIRECT';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'ai_model_config_network_access_mode_check'
  ) then
    alter table public.ai_model_config
      add constraint ai_model_config_network_access_mode_check
      check (network_access_mode in ('DIRECT', 'HOST_PROXY'));
  end if;
end $$;

comment on column public.ai_model_config.network_access_mode is
  'DIRECT = worker reaches the endpoint directly. HOST_PROXY = worker must reach it through '
  'the operator-configured loopback proxy on the Docker host. Frozen into model_snapshot per '
  'job so a config change mid-run cannot move an in-flight attempt onto another network.';

/**
 * 取值校验函数。
 *
 * 单独抽出来是因为它有三个调用点（create / update / 测试入队），而"某一处漏校验"的后果
 * 是一个既不直连也不走代理的模型：Worker 侧的解析会 fail closed，但那时错误已经离开了
 * 它真正的来源。
 */
create or replace function public.assert_network_access_mode(p_mode text)
returns text
language plpgsql
immutable
as $$
begin
  if p_mode is null or p_mode not in ('DIRECT', 'HOST_PROXY') then
    raise exception 'MODEL_NETWORK_ACCESS_MODE_INVALID';
  end if;
  return p_mode;
end;
$$;

------------------------------------------------------------------------------
-- 2. 模型快照带上网络类型
--
-- 这是"任务执行期间改配置不影响在跑的 Job"的落点：`enqueue_analysis_job` 把
-- build_model_snapshot() 的结果冻结进 analysis_job.model_snapshot，Worker 只读那一份。
------------------------------------------------------------------------------

create or replace function public.build_model_snapshot(p_model_config_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'model_config_id', cfg.id,
    'display_name', cfg.display_name,
    'base_url', cfg.base_url,
    'model_name', cfg.model_name,
    'max_parallel_tasks', cfg.max_parallel_tasks,
    'request_timeout_ms', cfg.request_timeout_ms,
    'context_window', cfg.context_window,
    'max_output_tokens', cfg.max_output_tokens,
    'agent_max_model_requests', cfg.agent_max_model_requests,
    'agent_max_retry_requests', cfg.agent_max_retry_requests,
    'agent_max_compaction_requests', cfg.agent_max_compaction_requests,
    -- 冻结网络类型。缺省 'DIRECT' 只服务理论上的空值，列本身是 not null default 'DIRECT'。
    'network_access_mode', coalesce(cfg.network_access_mode, 'DIRECT')
  )
  from public.ai_model_config cfg
  where cfg.id = p_model_config_id;
$$;

------------------------------------------------------------------------------
-- 3. 连接测试快照
--
-- `model_connectivity_test` 已经快照了 base_url / model_name / timeout；网络类型属于
-- 同一族事实（"这次测试该怎么发请求"），所以放在一起冻结，而不是让 Worker 再回查配置 ——
-- 回查会让"测试期间改了配置"变成一个无法复现的竞态。
------------------------------------------------------------------------------

alter table public.model_connectivity_test
  add column if not exists network_access_mode_snapshot text not null default 'DIRECT';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'model_connectivity_test_network_mode_snapshot_check'
  ) then
    alter table public.model_connectivity_test
      add constraint model_connectivity_test_network_mode_snapshot_check
      check (network_access_mode_snapshot in ('DIRECT', 'HOST_PROXY'));
  end if;
end $$;

create or replace function public.enqueue_model_connectivity_test(p_model_config_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_cfg public.ai_model_config;
  v_existing uuid;
  v_id uuid;
begin
  perform public.ensure_admin();
  if p_model_config_id is null then
    raise exception 'model_config_id is required';
  end if;

  perform pg_advisory_xact_lock(hashtext('model_connectivity_test:' || p_model_config_id::text));
  select * into v_cfg from public.ai_model_config where id = p_model_config_id;
  if v_cfg.id is null then
    raise exception 'model config not found';
  end if;
  if not public.model_config_has_api_key(v_cfg.api_key_secret_id) then
    raise exception 'MODEL_SECRET_MISSING';
  end if;

  select test.id into v_existing
  from public.model_connectivity_test test
  where test.model_config_id = p_model_config_id
    and test.status in ('QUEUED', 'RUNNING')
  order by test.created_at desc
  limit 1;
  if v_existing is not null then
    return v_existing;
  end if;

  insert into public.model_connectivity_test (
    model_config_id, requested_by, base_url_snapshot, model_name_snapshot,
    request_timeout_ms_snapshot, network_access_mode_snapshot
  ) values (
    v_cfg.id, auth.uid(), v_cfg.base_url, v_cfg.model_name,
    least(greatest(coalesce(v_cfg.request_timeout_ms, 30000), 1000), 30000),
    -- 与 base_url / model_name 同源同语义：这次测试"该怎么发请求"必须在入队时定格，
    -- 否则测试期间改配置会变成一个无法复现的竞态。
    public.assert_network_access_mode(coalesce(v_cfg.network_access_mode, 'DIRECT'))
  ) returning id into v_id;
  return v_id;
end;
$function$;

------------------------------------------------------------------------------
-- 4. 两个 admin RPC 与列表 RPC 增加网络类型
--
-- 下面三段是**在既有定义上增量修改**得来的，不是重写。
--
-- 这一点必须说清楚：`admin_update_model_config` 里有一整套逐字段 diff（把变更写进
-- `batch_operation_log` 的 changed_fields / old_values / new_values / api_key_changed）。
-- 凭记忆重写这个函数会静默丢掉模型配置的审计能力 —— 而"审计没了"不会有任何测试报错。
-- 所以这里以 `pg_get_functiondef()` 的原文为底，只插入 network_access_mode 相关的行。
--
-- 加参数与改返回类型都只能 drop + create：
--   * `create or replace` 改不了签名，会留下一个**不接收网络类型**的旧重载 —— 那就是
--     "页面改了网络类型但没生效"的后门；
--   * 列表 RPC 返回 TABLE(...)，加一列等于改返回类型，PostgreSQL 直接拒绝 replace。
------------------------------------------------------------------------------

drop function if exists public.admin_create_model_config(
  uuid, text, text, text, uuid, integer, integer, integer, integer, integer, integer, integer
);

drop function if exists public.admin_update_model_config(
  uuid, uuid, text, text, text, uuid, integer, integer, integer, integer, integer, integer, integer
);

drop function if exists public.admin_list_model_configs();

-- create
CREATE OR REPLACE FUNCTION public.admin_create_model_config(p_actor_id uuid, p_display_name text, p_base_url text, p_model_name text, p_api_key_secret_id uuid, p_max_parallel_tasks integer DEFAULT 4, p_request_timeout_ms integer DEFAULT 180000, p_context_window integer DEFAULT 131072, p_max_output_tokens integer DEFAULT 8192, p_agent_max_model_requests integer DEFAULT 120, p_agent_max_retry_requests integer DEFAULT 6, p_agent_max_compaction_requests integer DEFAULT 4, p_network_access_mode text DEFAULT 'DIRECT')
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_id uuid;
  v_display_name text;
  v_base_url text;
  v_model_name text;
begin
  perform public.assert_actor_is_admin(p_actor_id);

  if p_display_name is null or btrim(p_display_name) = '' then
    raise exception 'display_name is required';
  end if;
  if p_base_url is null or btrim(p_base_url) = '' then
    raise exception 'base_url is required';
  end if;
  if p_model_name is null or btrim(p_model_name) = '' then
    raise exception 'model_name is required';
  end if;
  if p_api_key_secret_id is null then
    raise exception 'api_key_secret_id is required';
  end if;

  v_display_name := btrim(p_display_name);
  v_base_url := btrim(p_base_url);
  v_model_name := btrim(p_model_name);

  insert into public.ai_model_config (
    display_name, base_url, model_name, api_key_secret_id,
    max_parallel_tasks, request_timeout_ms, context_window, max_output_tokens,
    agent_max_model_requests, agent_max_retry_requests,
    agent_max_compaction_requests, network_access_mode, created_by
  ) values (
    v_display_name, v_base_url, v_model_name, p_api_key_secret_id,
    p_max_parallel_tasks, p_request_timeout_ms, p_context_window, p_max_output_tokens,
    p_agent_max_model_requests, p_agent_max_retry_requests,
    p_agent_max_compaction_requests,
    public.assert_network_access_mode(coalesce(p_network_access_mode, 'DIRECT')), p_actor_id
  ) returning id into v_id;

  insert into public.batch_operation_log (
    batch_id, action, model_config_id, model_display_name_snapshot,
    changed_fields, new_values, api_key_changed, performed_by
  ) values (
    null, 'MODEL_CONFIG_CREATED', v_id, v_display_name,
    array[
      'display_name', 'base_url', 'model_name', 'max_parallel_tasks',
      'request_timeout_ms', 'context_window', 'max_output_tokens',
      'agent_max_model_requests', 'agent_max_retry_requests',
      'agent_max_compaction_requests', 'network_access_mode', 'api_key'
    ],
    jsonb_build_object(
      'display_name', v_display_name,
      'model_name', v_model_name,
      'max_parallel_tasks', p_max_parallel_tasks,
      'request_timeout_ms', p_request_timeout_ms,
      'context_window', p_context_window,
      'max_output_tokens', p_max_output_tokens,
      'agent_max_model_requests', p_agent_max_model_requests,
      'agent_max_retry_requests', p_agent_max_retry_requests,
      'agent_max_compaction_requests', p_agent_max_compaction_requests,
      'network_access_mode', coalesce(p_network_access_mode, 'DIRECT')
    ),
    true, p_actor_id
  );

  return v_id;
end;
$function$
;

-- update
CREATE OR REPLACE FUNCTION public.admin_update_model_config(p_actor_id uuid, p_id uuid, p_display_name text DEFAULT NULL::text, p_base_url text DEFAULT NULL::text, p_model_name text DEFAULT NULL::text, p_new_api_key_secret_id uuid DEFAULT NULL::uuid, p_max_parallel_tasks integer DEFAULT NULL::integer, p_request_timeout_ms integer DEFAULT NULL::integer, p_context_window integer DEFAULT NULL::integer, p_max_output_tokens integer DEFAULT NULL::integer, p_agent_max_model_requests integer DEFAULT NULL::integer, p_agent_max_retry_requests integer DEFAULT NULL::integer, p_agent_max_compaction_requests integer DEFAULT NULL::integer, p_network_access_mode text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_existing public.ai_model_config;
  v_updated public.ai_model_config;
  v_referenced boolean;
  v_new_display_name text;
  v_changed_fields text[] := array[]::text[];
  v_old_values jsonb := '{}'::jsonb;
  v_new_values jsonb := '{}'::jsonb;
  v_api_key_changed boolean := false;
begin
  perform public.assert_actor_is_admin(p_actor_id);

  select * into v_existing from public.ai_model_config where id = p_id for update;
  if v_existing.id is null then
    raise exception 'model config not found';
  end if;

  v_referenced := exists (
    select 1 from public.review_batch batch where batch.ai_model_config_id = p_id
  ) or exists (
    select 1 from public.analysis_job job where job.model_config_id = p_id
  );

  if v_referenced and (
    (p_base_url is not null and btrim(p_base_url) <> v_existing.base_url)
    or (p_model_name is not null and btrim(p_model_name) <> v_existing.model_name)
  ) then
    raise exception 'base_url/model_name are immutable once referenced by a batch';
  end if;

  v_new_display_name := coalesce(nullif(btrim(p_display_name), ''), v_existing.display_name);

  update public.ai_model_config set
    display_name = v_new_display_name,
    base_url = coalesce(nullif(btrim(p_base_url), ''), base_url),
    model_name = coalesce(nullif(btrim(p_model_name), ''), model_name),
    api_key_secret_id = coalesce(p_new_api_key_secret_id, api_key_secret_id),
    max_parallel_tasks = coalesce(p_max_parallel_tasks, max_parallel_tasks),
    request_timeout_ms = coalesce(p_request_timeout_ms, request_timeout_ms),
    context_window = coalesce(p_context_window, context_window),
    max_output_tokens = coalesce(p_max_output_tokens, max_output_tokens),
    agent_max_model_requests = coalesce(p_agent_max_model_requests, agent_max_model_requests),
    agent_max_retry_requests = coalesce(p_agent_max_retry_requests, agent_max_retry_requests),
    agent_max_compaction_requests =
      coalesce(p_agent_max_compaction_requests, agent_max_compaction_requests),
    -- null 表示"不改"，与其余可选参数一致；给了值就必须合法（非法取值直接抛，
    -- 不落一个既不直连也不走代理的中间态）。
    network_access_mode = case
      when p_network_access_mode is null then network_access_mode
      else public.assert_network_access_mode(p_network_access_mode)
    end
  where id = p_id
  returning * into v_updated;

  if v_existing.display_name is distinct from v_updated.display_name then
    v_changed_fields := array_append(v_changed_fields, 'display_name');
    v_old_values := v_old_values || jsonb_build_object('display_name', v_existing.display_name);
    v_new_values := v_new_values || jsonb_build_object('display_name', v_updated.display_name);
  end if;
  if v_existing.base_url is distinct from v_updated.base_url then
    v_changed_fields := array_append(v_changed_fields, 'base_url');
  end if;
  if v_existing.model_name is distinct from v_updated.model_name then
    v_changed_fields := array_append(v_changed_fields, 'model_name');
    v_old_values := v_old_values || jsonb_build_object('model_name', v_existing.model_name);
    v_new_values := v_new_values || jsonb_build_object('model_name', v_updated.model_name);
  end if;
  if v_existing.max_parallel_tasks is distinct from v_updated.max_parallel_tasks then
    v_changed_fields := array_append(v_changed_fields, 'max_parallel_tasks');
    v_old_values := v_old_values || jsonb_build_object('max_parallel_tasks', v_existing.max_parallel_tasks);
    v_new_values := v_new_values || jsonb_build_object('max_parallel_tasks', v_updated.max_parallel_tasks);
  end if;
  if v_existing.request_timeout_ms is distinct from v_updated.request_timeout_ms then
    v_changed_fields := array_append(v_changed_fields, 'request_timeout_ms');
    v_old_values := v_old_values || jsonb_build_object('request_timeout_ms', v_existing.request_timeout_ms);
    v_new_values := v_new_values || jsonb_build_object('request_timeout_ms', v_updated.request_timeout_ms);
  end if;
  if v_existing.context_window is distinct from v_updated.context_window then
    v_changed_fields := array_append(v_changed_fields, 'context_window');
    v_old_values := v_old_values || jsonb_build_object('context_window', v_existing.context_window);
    v_new_values := v_new_values || jsonb_build_object('context_window', v_updated.context_window);
  end if;
  if v_existing.max_output_tokens is distinct from v_updated.max_output_tokens then
    v_changed_fields := array_append(v_changed_fields, 'max_output_tokens');
    v_old_values := v_old_values || jsonb_build_object('max_output_tokens', v_existing.max_output_tokens);
    v_new_values := v_new_values || jsonb_build_object('max_output_tokens', v_updated.max_output_tokens);
  end if;
  if v_existing.agent_max_model_requests is distinct from v_updated.agent_max_model_requests then
    v_changed_fields := array_append(v_changed_fields, 'agent_max_model_requests');
    v_old_values := v_old_values || jsonb_build_object('agent_max_model_requests', v_existing.agent_max_model_requests);
    v_new_values := v_new_values || jsonb_build_object('agent_max_model_requests', v_updated.agent_max_model_requests);
  end if;
  if v_existing.agent_max_retry_requests is distinct from v_updated.agent_max_retry_requests then
    v_changed_fields := array_append(v_changed_fields, 'agent_max_retry_requests');
    v_old_values := v_old_values || jsonb_build_object('agent_max_retry_requests', v_existing.agent_max_retry_requests);
    v_new_values := v_new_values || jsonb_build_object('agent_max_retry_requests', v_updated.agent_max_retry_requests);
  end if;
  if v_existing.agent_max_compaction_requests is distinct from v_updated.agent_max_compaction_requests then
    v_changed_fields := array_append(v_changed_fields, 'agent_max_compaction_requests');
    v_old_values := v_old_values || jsonb_build_object('agent_max_compaction_requests', v_existing.agent_max_compaction_requests);
    v_new_values := v_new_values || jsonb_build_object('agent_max_compaction_requests', v_updated.agent_max_compaction_requests);
  end if;

  if v_existing.network_access_mode is distinct from v_updated.network_access_mode then
    v_changed_fields := array_append(v_changed_fields, 'network_access_mode');
    v_old_values := v_old_values
      || jsonb_build_object('network_access_mode', v_existing.network_access_mode);
    v_new_values := v_new_values
      || jsonb_build_object('network_access_mode', v_updated.network_access_mode);
  end if;

  v_api_key_changed := p_new_api_key_secret_id is not null
    and p_new_api_key_secret_id is distinct from v_existing.api_key_secret_id;
  if v_api_key_changed then
    v_changed_fields := array_append(v_changed_fields, 'api_key');
  end if;

  if cardinality(v_changed_fields) > 0 then
    insert into public.batch_operation_log (
      batch_id, action, model_config_id, model_display_name_snapshot,
      changed_fields, old_values, new_values, api_key_changed, performed_by
    ) values (
      null, 'MODEL_CONFIG_UPDATED', p_id, v_updated.display_name,
      v_changed_fields, v_old_values, v_new_values, v_api_key_changed, p_actor_id
    );
  end if;

  if v_api_key_changed then
    return v_existing.api_key_secret_id;
  end if;
  return null;
end;
$function$
;

-- list
CREATE OR REPLACE FUNCTION public.admin_list_model_configs()
 RETURNS TABLE(id uuid, display_name text, base_url text, model_name text, enabled boolean, has_api_key boolean, max_parallel_tasks integer, request_timeout_ms integer, context_window integer, max_output_tokens integer, agent_max_model_requests integer, agent_max_retry_requests integer, agent_max_compaction_requests integer, network_access_mode text, is_referenced boolean, created_by uuid, created_at timestamp with time zone, updated_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  perform public.ensure_admin();

  return query
  select
    cfg.id, cfg.display_name, cfg.base_url, cfg.model_name, cfg.enabled,
    public.model_config_has_api_key(cfg.api_key_secret_id),
    cfg.max_parallel_tasks, cfg.request_timeout_ms,
    cfg.context_window, cfg.max_output_tokens,
    cfg.agent_max_model_requests, cfg.agent_max_retry_requests,
    cfg.agent_max_compaction_requests,
    cfg.network_access_mode,
    exists (select 1 from public.review_batch batch where batch.ai_model_config_id = cfg.id)
      or exists (select 1 from public.analysis_job job where job.model_config_id = cfg.id),
    cfg.created_by, cfg.created_at, cfg.updated_at
  from public.ai_model_config cfg
  order by cfg.created_at desc;
end;
$function$
;

------------------------------------------------------------------------------
-- 7. 审计值白名单加上 network_access_mode
--
-- `batch_operation_log` 有一条 `safe_values_check`：它限定 old_values / new_values 的键与
-- changed_fields 的元素只能来自一份允许列表。这层约束是**有意**的 —— 它保证审计表不会
-- 顺手记下 base_url、api_key 之类不该长期留存的东西。
--
-- 所以新增一个被审计的字段必须显式扩这份列表，而不是绕过它。这一点是实测撞出来的：
-- 不扩的话，改网络类型的 update 会以 check_violation 整个失败 —— 约束确实在起作用。
------------------------------------------------------------------------------

alter table public.batch_operation_log
  drop constraint if exists batch_operation_log_safe_values_check;

alter table public.batch_operation_log
  add constraint batch_operation_log_safe_values_check
  CHECK ((((COALESCE(old_values, '{}'::jsonb) - ARRAY['network_access_mode'::text, 'display_name'::text, 'provider'::text, 'model_name'::text, 'max_parallel_tasks'::text, 'request_timeout_ms'::text, 'retrieval_prompt_version'::text, 'analysis_prompt_version'::text, 'context_window'::text, 'max_output_tokens'::text, 'agent_max_model_requests'::text, 'agent_max_retry_requests'::text, 'agent_max_compaction_requests'::text, 'enabled'::text]) = '{}'::jsonb) AND ((COALESCE(new_values, '{}'::jsonb) - ARRAY['network_access_mode'::text, 'display_name'::text, 'provider'::text, 'model_name'::text, 'max_parallel_tasks'::text, 'request_timeout_ms'::text, 'retrieval_prompt_version'::text, 'analysis_prompt_version'::text, 'context_window'::text, 'max_output_tokens'::text, 'agent_max_model_requests'::text, 'agent_max_retry_requests'::text, 'agent_max_compaction_requests'::text, 'enabled'::text]) = '{}'::jsonb) AND (COALESCE(changed_fields, ARRAY[]::text[]) <@ ARRAY['network_access_mode'::text, 'display_name'::text, 'provider'::text, 'base_url'::text, 'model_name'::text, 'max_parallel_tasks'::text, 'request_timeout_ms'::text, 'retrieval_prompt_version'::text, 'analysis_prompt_version'::text, 'context_window'::text, 'max_output_tokens'::text, 'agent_max_model_requests'::text, 'agent_max_retry_requests'::text, 'agent_max_compaction_requests'::text, 'enabled'::text, 'api_key'::text]) AND COALESCE((jsonb_typeof((old_values -> 'display_name'::text)) = 'string'::text), true) AND COALESCE((jsonb_typeof((old_values -> 'provider'::text)) = 'string'::text), true) AND COALESCE((jsonb_typeof((old_values -> 'model_name'::text)) = 'string'::text), true) AND COALESCE((jsonb_typeof((old_values -> 'max_parallel_tasks'::text)) = 'number'::text), true) AND COALESCE((jsonb_typeof((old_values -> 'request_timeout_ms'::text)) = 'number'::text), true) AND COALESCE((jsonb_typeof((old_values -> 'retrieval_prompt_version'::text)) = 'string'::text), true) AND COALESCE((jsonb_typeof((old_values -> 'analysis_prompt_version'::text)) = 'string'::text), true) AND COALESCE((jsonb_typeof((old_values -> 'context_window'::text)) = 'number'::text), true) AND COALESCE((jsonb_typeof((old_values -> 'max_output_tokens'::text)) = 'number'::text), true) AND COALESCE((jsonb_typeof((old_values -> 'agent_max_model_requests'::text)) = 'number'::text), true) AND COALESCE((jsonb_typeof((old_values -> 'agent_max_retry_requests'::text)) = 'number'::text), true) AND COALESCE((jsonb_typeof((old_values -> 'agent_max_compaction_requests'::text)) = 'number'::text), true) AND COALESCE((jsonb_typeof((old_values -> 'enabled'::text)) = 'boolean'::text), true) AND COALESCE((jsonb_typeof((new_values -> 'display_name'::text)) = 'string'::text), true) AND COALESCE((jsonb_typeof((new_values -> 'provider'::text)) = 'string'::text), true) AND COALESCE((jsonb_typeof((new_values -> 'model_name'::text)) = 'string'::text), true) AND COALESCE((jsonb_typeof((new_values -> 'max_parallel_tasks'::text)) = 'number'::text), true) AND COALESCE((jsonb_typeof((new_values -> 'request_timeout_ms'::text)) = 'number'::text), true) AND COALESCE((jsonb_typeof((new_values -> 'retrieval_prompt_version'::text)) = 'string'::text), true) AND COALESCE((jsonb_typeof((new_values -> 'analysis_prompt_version'::text)) = 'string'::text), true) AND COALESCE((jsonb_typeof((new_values -> 'context_window'::text)) = 'number'::text), true) AND COALESCE((jsonb_typeof((new_values -> 'max_output_tokens'::text)) = 'number'::text), true) AND COALESCE((jsonb_typeof((new_values -> 'agent_max_model_requests'::text)) = 'number'::text), true) AND COALESCE((jsonb_typeof((new_values -> 'agent_max_retry_requests'::text)) = 'number'::text), true) AND COALESCE((jsonb_typeof((new_values -> 'agent_max_compaction_requests'::text)) = 'number'::text), true) AND COALESCE((jsonb_typeof((new_values -> 'enabled'::text)) = 'boolean'::text), true)))
;

------------------------------------------------------------------------------
-- 6. 权限
------------------------------------------------------------------------------

revoke execute on function public.admin_create_model_config(
  uuid, text, text, text, uuid, integer, integer, integer, integer, integer, integer, integer, text
) from public, anon, authenticated;
grant execute on function public.admin_create_model_config(
  uuid, text, text, text, uuid, integer, integer, integer, integer, integer, integer, integer, text
) to service_role;

revoke execute on function public.admin_update_model_config(
  uuid, uuid, text, text, text, uuid, integer, integer, integer, integer, integer, integer, integer, text
) from public, anon, authenticated;
grant execute on function public.admin_update_model_config(
  uuid, uuid, text, text, text, uuid, integer, integer, integer, integer, integer, integer, integer, text
) to service_role;

revoke execute on function public.assert_network_access_mode(text) from public, anon;
grant execute on function public.assert_network_access_mode(text) to authenticated, service_role;

revoke execute on function public.admin_list_model_configs() from public, anon;
grant execute on function public.admin_list_model_configs() to authenticated, service_role;

revoke execute on function public.enqueue_model_connectivity_test(uuid) from public, anon;
grant execute on function public.enqueue_model_connectivity_test(uuid) to authenticated, service_role;

revoke execute on function public.build_model_snapshot(uuid) from public, anon, authenticated;
grant execute on function public.build_model_snapshot(uuid) to service_role;
