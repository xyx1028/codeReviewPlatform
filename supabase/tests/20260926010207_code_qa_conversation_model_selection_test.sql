\set ON_ERROR_STOP on
\timing off
\set QUIET on

begin;
set local client_min_messages = warning;

create or replace function pg_temp.assert(p_cond boolean, p_msg text)
returns void language plpgsql as $$
begin
  if p_cond is null or not p_cond then
    raise exception 'ASSERT FAILED: %', p_msg;
  end if;
end;
$$;

do $test$
declare
  v_owner uuid := '26000000-0000-4000-a000-000000000001';
  v_model_a uuid := '26000000-0000-4000-c000-000000000001';
  v_model_b uuid := '26000000-0000-4000-c000-000000000002';
  v_secret_a uuid;
  v_secret_b uuid;
  v_conversation jsonb;
  v_turn jsonb;
  v_conversation_id uuid;
  v_turn_id uuid;
  v_count integer;
begin
  insert into auth.users (id, email) values (v_owner, 'code_qa_session_model@example.com')
  on conflict (id) do nothing;
  insert into public.user_profile (id, role) values (v_owner, 'VIEWER')
  on conflict (id) do update set role = excluded.role;

  v_secret_a := vault.create_secret('sk-session-model-a', 'qa_session_model_a_' || gen_random_uuid()::text);
  v_secret_b := vault.create_secret('sk-session-model-b', 'qa_session_model_b_' || gen_random_uuid()::text);

  insert into public.ai_model_config (
    id, display_name, base_url, model_name, api_key_secret_id, enabled,
    request_timeout_ms, max_output_tokens, network_access_mode, created_by, created_at
  ) values
    (v_model_a, '会话模型 A', 'https://model-a.invalid/v1', 'model-a', v_secret_a, true,
     120000, 8192, 'DIRECT', v_owner, '2026-01-01T00:00:00Z'),
    (v_model_b, '会话模型 B', 'https://model-b.invalid/v1', 'model-b', v_secret_b, true,
     120000, 8192, 'DIRECT', v_owner, '2026-02-01T00:00:00Z');

  perform set_config('request.jwt.claims',
    json_build_object('sub', v_owner::text, 'role', 'authenticated')::text, true);

  -- 新签名强制模型，旧签名必须消失，不能保留绕过模型校验的重载。
  perform pg_temp.assert(
    to_regprocedure('public.create_code_qa_conversation(text[],text,text)') is null,
    'the old create conversation overload must be removed');
  perform pg_temp.assert(
    to_regprocedure('public.create_code_qa_conversation(text[],text,uuid,text)') is not null,
    'the new create conversation overload must exist');

  begin
    perform public.create_code_qa_conversation(array['kdmanage-backend'], 'release', null, '缺模型');
    perform pg_temp.assert(false, 'new conversations must require a selected model');
  exception when others then
    perform pg_temp.assert(sqlerrm like '%MODEL_CONFIG_REQUIRED%',
      'missing model must have a stable error code, got: ' || sqlerrm);
  end;

  v_conversation := public.create_code_qa_conversation(
    array['kdmanage-backend'], 'release', v_model_a, '模型锁定会话'
  );
  v_conversation_id := (v_conversation ->> 'id')::uuid;

  perform pg_temp.assert(v_conversation ->> 'selected_model_config_id' = v_model_a::text,
    'conversation response exposes the selected model id');
  perform pg_temp.assert(v_conversation ->> 'selected_model_display_name' = '会话模型 A',
    'conversation response exposes a safe display-name snapshot');
  perform pg_temp.assert(
    exists (
      select 1 from public.code_qa_conversation
      where id = v_conversation_id
        and selected_model_config_id = v_model_a
        and selected_model_display_name = '会话模型 A'
    ),
    'selected model is persisted on the conversation');

  -- 即便 B 更晚创建，A 被用户选中后第一轮必须冻结 A。
  v_turn := public.request_code_qa_turn(v_conversation_id, '第一问');
  v_turn_id := (v_turn ->> 'id')::uuid;
  perform pg_temp.assert(
    exists (
      select 1 from public.code_qa_turn
      where id = v_turn_id and model_config_id = v_model_a
        and base_url_snapshot = 'https://model-a.invalid/v1'
        and model_name_snapshot = 'model-a'
    ),
    'first turn uses the explicitly selected model, not automatic selection');

  -- 收尾第一轮，模拟 Worker 已完成，验证后续轮次仍锁定 A。
  update public.code_qa_turn set status = 'SUCCEEDED', stage = 'DONE', finished_at = now()
  where id = v_turn_id;
  v_turn := public.request_code_qa_turn(v_conversation_id, '第二问');
  perform pg_temp.assert(
    exists (
      select 1 from public.code_qa_turn
      where id = (v_turn ->> 'id')::uuid and model_config_id = v_model_a
    ),
    'later turns in the same conversation keep the selected model');

  -- 已被会话选择的模型不允许改变真正的模型身份，避免后续轮次悄悄打到别的端点。
  begin
    update public.ai_model_config set model_name = 'model-a-replaced' where id = v_model_a;
    perform pg_temp.assert(false, 'selected model identity must be immutable');
  exception when others then
    perform pg_temp.assert(sqlerrm like '%code Q&A conversation%',
      'selected-model immutability must be enforced, got: ' || sqlerrm);
  end;

  -- 模型停用后不回退 B：新轮次必须明确失败。
  update public.code_qa_turn set status = 'SUCCEEDED', stage = 'DONE', finished_at = now()
  where id = (v_turn ->> 'id')::uuid;
  update public.ai_model_config set enabled = false where id = v_model_a;
  begin
    perform public.request_code_qa_turn(v_conversation_id, '停用后的问题');
    perform pg_temp.assert(false, 'disabled selected model must not fall back');
  exception when others then
    perform pg_temp.assert(sqlerrm like '%MODEL_CONFIG_DISABLED%',
      'disabled selected model must report a stable error, got: ' || sqlerrm);
  end;

  -- 建会话时同样拒绝停用配置。
  begin
    perform public.create_code_qa_conversation(array['kdmanage-backend'], 'release', v_model_a, '停用模型');
    perform pg_temp.assert(false, 'disabled model cannot be selected for a new conversation');
  exception when others then
    perform pg_temp.assert(sqlerrm like '%MODEL_CONFIG_DISABLED%',
      'disabled selection must report a stable error, got: ' || sqlerrm);
  end;

  select count(*) into v_count
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'create_code_qa_conversation';
  perform pg_temp.assert(v_count = 1,
    'only one create conversation RPC overload may remain');

  perform pg_temp.assert(
    not has_function_privilege('anon', 'public.create_code_qa_conversation(text[], text, uuid, text)'::regprocedure, 'execute')
    and has_function_privilege('authenticated', 'public.create_code_qa_conversation(text[], text, uuid, text)'::regprocedure, 'execute'),
    'only authenticated users can create model-selected conversations');

  raise notice 'V1.27 code QA session model selection test: all assertions passed';
end;
$test$;

rollback;
