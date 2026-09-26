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
  v_owner uuid := '26000000-0000-4000-b000-000000000001';
  v_other uuid := '26000000-0000-4000-b000-000000000002';
  v_model uuid := '26000000-0000-4000-d000-000000000001';
  v_secret uuid;
  v_first jsonb;
  v_second jsonb;
  v_updated jsonb;
  v_list jsonb;
  v_first_id uuid;
  v_second_id uuid;
begin
  insert into auth.users (id, email) values
    (v_owner, 'code_qa_pinning_owner@example.com'),
    (v_other, 'code_qa_pinning_other@example.com')
  on conflict (id) do nothing;
  insert into public.user_profile (id, role) values
    (v_owner, 'VIEWER'),
    (v_other, 'VIEWER')
  on conflict (id) do update set role = excluded.role;

  v_secret := vault.create_secret('sk-code-qa-pinning', 'qa_pinning_' || gen_random_uuid()::text);
  insert into public.ai_model_config (
    id, display_name, base_url, model_name, api_key_secret_id, enabled,
    request_timeout_ms, max_output_tokens, network_access_mode, created_by, created_at
  ) values (
    v_model, '置顶测试模型', 'https://pinning.invalid/v1', 'pinning-model', v_secret, true,
    120000, 8192, 'DIRECT', v_owner, '2026-01-01T00:00:00Z'
  ) on conflict (id) do update set
    enabled = true,
    api_key_secret_id = excluded.api_key_secret_id;

  perform set_config('request.jwt.claims',
    json_build_object('sub', v_owner::text, 'role', 'authenticated')::text, true);

  v_first := public.create_code_qa_conversation(
    array['kdmanage-backend'], 'release', v_model, '先创建的会话'
  );
  v_second := public.create_code_qa_conversation(
    array['kdmanage-backend'], 'release', v_model, '后创建的会话'
  );
  v_first_id := (v_first ->> 'id')::uuid;
  v_second_id := (v_second ->> 'id')::uuid;

  -- 不同创建时间让取消置顶后的普通会话排序可精确断言。
  update public.code_qa_conversation
  set created_at = case id
    when v_first_id then '2026-01-01T00:00:00Z'::timestamptz
    when v_second_id then '2026-01-02T00:00:00Z'::timestamptz
  end
  where id in (v_first_id, v_second_id);

  perform pg_temp.assert(
    (public.code_qa_conversation_to_jsonb((select c from public.code_qa_conversation c where c.id = v_first_id)) ->> 'is_pinned')::boolean = false,
    'legacy/default conversation projection must be unpinned');

  v_updated := public.set_code_qa_conversation_pinned(v_first_id, true);
  perform pg_temp.assert(
    (v_updated ->> 'is_pinned')::boolean
      and exists (select 1 from public.code_qa_conversation where id = v_first_id and pinned_at is not null),
    'pinning must persist and return a safe is_pinned projection');

  v_list := public.list_code_qa_conversations();
  perform pg_temp.assert(
    (v_list -> 0 ->> 'id')::uuid = v_first_id
      and (v_list -> 0 ->> 'is_pinned')::boolean,
    'pinned conversation must appear before newer unpinned conversation');

  perform public.set_code_qa_conversation_pinned(v_first_id, false);
  v_list := public.list_code_qa_conversations();
  perform pg_temp.assert(
    (v_list -> 0 ->> 'id')::uuid = v_second_id
      and not ((v_list -> 0) ? 'pinned_at'),
    'unpinning must restore recent-activity order without exposing pinned_at');
  perform pg_temp.assert(
    not exists (select 1 from public.code_qa_conversation where id = v_first_id and pinned_at is not null),
    'unpinning must clear the persisted state');

  perform set_config('request.jwt.claims',
    json_build_object('sub', v_other::text, 'role', 'authenticated')::text, true);
  begin
    perform public.set_code_qa_conversation_pinned(v_first_id, true);
    perform pg_temp.assert(false, 'a different user must not pin another owner''s conversation');
  exception when others then
    perform pg_temp.assert(sqlerrm like '%CODE_QA_CONVERSATION_NOT_FOUND%',
      'cross-owner pinning must use the non-enumerating error, got: ' || sqlerrm);
  end;

  perform pg_temp.assert(
    not has_function_privilege('anon', 'public.set_code_qa_conversation_pinned(uuid, boolean)'::regprocedure, 'execute')
      and has_function_privilege('authenticated', 'public.set_code_qa_conversation_pinned(uuid, boolean)'::regprocedure, 'execute'),
    'only authenticated users can call the pinning RPC');

  raise notice 'V1.30 code QA conversation pinning test: all assertions passed';
end;
$test$;

rollback;