-- V1.23c 产品代码问答：改用「平台实际在跑的那个模型」，而不是「最早创建的启用配置」。
--
-- 第一版的规则是 `order by created_at, id limit 1`，理由写的是"确定性"。它确实确定，
-- 但**确定地选错了**：本地与云端都存在早期创建、后来被弃用但没有停用的配置，它们的 Key
-- 往往是占位值。本地端到端实测（2026-09-24）就栽在这里 —— 问答选中了 2026-09-17 创建的
-- `kimi-k3`（Key 是 18 字节的占位串），而平台最近 5 个分析任务全部在用 `glm5.3-flash`。
-- 表现是 dsh 启动后报
--   `the API key resolved from CODE_QA_MODEL_API_KEY contains characters no HTTP header can carry`
-- 而运维会去查"问答为什么连不上模型"，方向完全错了：链路没问题，是选错了配置。
--
-- 新规则按优先级：
--
--   1. **最近一个分析任务用的那个配置**（要求仍然启用且有 Key）。
--      这是平台里唯一能表达"我们现在真的在用哪个模型"的事实 —— 它由管理员建批次时选定，
--      并且被真实跑过。顺带的好处是：产品在问答里看到的口径与评审结论出自同一个模型。
--   2. 回退到**最近创建的**启用且有 Key 的配置。
--      管理员换模型时是"新增一条"，所以最新的那条才代表当前意图；最早的那条最可能是弃用的。
--   3. 一个都没有 → 入队即失败（MODEL_CONFIG_NOT_FOUND / MODEL_SECRET_MISSING）。
--
-- 两条回退都要求 `model_config_has_api_key`：一个没有 Key 的配置无论多"新"都不该被选中，
-- 否则只是把失败从入队推迟到 spawn 之后。
--
-- 幂等：create or replace。

create or replace function public.request_code_qa_turn(
  p_conversation_id uuid,
  p_question text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_conversation public.code_qa_conversation;
  v_model public.ai_model_config;
  v_new public.code_qa_turn;
begin
  v_conversation := public.assert_code_qa_conversation_owner(p_conversation_id);

  if nullif(btrim(p_question), '') is null then
    raise exception 'CODE_QA_QUESTION_REQUIRED';
  end if;

  if exists (
    select 1 from public.code_qa_turn
    where conversation_id = p_conversation_id and status in ('QUEUED', 'RUNNING')
  ) then
    raise exception 'CODE_QA_TURN_IN_FLIGHT';
  end if;

  -- 1. 平台实际在跑的那个模型：最近一个分析任务用过的配置。
  select cfg.* into v_model
  from public.analysis_job job
  join public.ai_model_config cfg on cfg.id = job.model_config_id
  where cfg.enabled
    and public.model_config_has_api_key(cfg.api_key_secret_id)
  order by job.created_at desc, job.id desc
  limit 1;

  -- 2. 还没跑过任何分析任务（全新环境）：取最近创建的可用配置。
  if v_model.id is null then
    select * into v_model
    from public.ai_model_config
    where enabled
      and public.model_config_has_api_key(api_key_secret_id)
    order by created_at desc, id desc
    limit 1;
  end if;

  -- 3. 区分"没有启用配置"和"有配置但没 Key"：两者的处置不同（前者建配置，后者补 Key）。
  if v_model.id is null then
    if exists (select 1 from public.ai_model_config where enabled) then
      raise exception 'MODEL_SECRET_MISSING';
    end if;
    raise exception 'MODEL_CONFIG_NOT_FOUND';
  end if;

  insert into public.code_qa_turn (
    conversation_id, asked_by, question, status, stage,
    model_config_id, base_url_snapshot, model_name_snapshot,
    request_timeout_ms_snapshot, network_access_mode_snapshot, max_output_tokens_snapshot
  ) values (
    p_conversation_id, auth.uid(), btrim(p_question), 'QUEUED', 'QUEUED',
    v_model.id, v_model.base_url, v_model.model_name,
    v_model.request_timeout_ms, v_model.network_access_mode, v_model.max_output_tokens
  )
  returning * into v_new;

  update public.code_qa_conversation
  set last_turn_at = now(),
      updated_at = now(),
      -- 第一个问题顺手当标题（截断），省掉"新对话"这种没信息的列表项。
      title = case
        when title = '新对话'
          then left(btrim(p_question), 60)
        else title
      end
  where id = p_conversation_id;

  return jsonb_build_object(
    'id', v_new.id,
    'conversation_id', v_new.conversation_id,
    'question', v_new.question,
    'status', v_new.status,
    'stage', v_new.stage,
    'created_at', v_new.created_at
  );
exception when unique_violation then
  -- 竞态兜底：两次几乎同时的提交都通过了上面的 exists 检查。
  raise exception 'CODE_QA_TURN_IN_FLIGHT';
end;
$$;

revoke execute on function public.request_code_qa_turn(uuid, text) from public, anon;
grant execute on function public.request_code_qa_turn(uuid, text) to authenticated, service_role;

comment on function public.request_code_qa_turn(uuid, text) is
  'V1.23c: enqueue one code Q&A turn. Model selection follows what the platform '
  'actually runs on (the config used by the most recent analysis job), falling back '
  'to the newest enabled config that has a key. Picking the OLDEST enabled config '
  '(V1.23a) deterministically selected abandoned configs with placeholder keys.';
