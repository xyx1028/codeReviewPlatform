-- V1.23 产品代码问答：会话与轮次的门禁、队列与冻结语义。
--
-- 这份测试盯住的是那些"写错了也不会报错、只会在用户面前表现成怪事"的点：
--   1. 会话归属：别人的会话读不到、改不了、删不掉，且不存在与无权限回同一个错误码；
--   2. 同一会话只允许一轮在飞（唯一索引 + 显式检查两道）；
--   3. commit_sha 只能冻结一次，第二次调用返回既有值而不是覆盖（多轮引用一致性）；
--   4. stage 只能向前，回退被拒（页面文字不会来回跳）；
--   5. 模型快照在入队时冻结；没有启用配置时入队即失败，不建行；
--   6. 空答案不能落成 SUCCEEDED；
--   7. 失联租约可回收，否则唯一索引会永久堵住那个会话；
--   8. code_qa_turn 对 authenticated 没有任何 RLS 策略（只能走 RPC）。
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
  v_owner  uuid := '23000000-0000-4000-a000-000000000001';
  v_other  uuid := '23000000-0000-4000-a000-000000000002';
  v_model  uuid := '23000000-0000-4000-c000-000000000001';
  v_secret uuid;
  v_conv jsonb;
  v_conv_id uuid;
  v_turn jsonb;
  v_turn_id uuid;
  v_claim jsonb;
  v_token uuid;
  v_error text;
  v_sha text;
  v_detail jsonb;
  v_count integer;
  v_policies integer;
  v_expected_model uuid;
begin
  ----------------------------------------------------------------------------
  -- 准备：两个用户 + 一个带 Key 的启用模型配置。
  ----------------------------------------------------------------------------
  insert into auth.users (id, email) values
    (v_owner, 'qa_owner@example.com'),
    (v_other, 'qa_other@example.com')
  on conflict (id) do nothing;
  insert into public.user_profile (id, role) values
    (v_owner, 'VIEWER'), (v_other, 'VIEWER')
  on conflict (id) do update set role = excluded.role;

  -- Vault secret：model_config_has_api_key 要求它真实存在。
  --
  -- created_at 设成 1970 只是让这条测试配置**不会**意外赢得选型（V1.23c 的规则是
  -- "最近一个分析任务用过的" → 回退"最近创建的"）。用例不假设哪个配置会被选中，
  -- 而是用同一条规则算出期望值再比对。
  v_secret := vault.create_secret('sk-code-qa-test', 'code_qa_test_key_' || gen_random_uuid()::text);
  insert into public.ai_model_config (
    id, display_name, base_url, model_name, api_key_secret_id, enabled,
    request_timeout_ms, max_output_tokens, network_access_mode, created_by, created_at
  ) values (
    v_model, 'QA 测试模型', 'https://example.invalid/v1', 'test-model', v_secret, true,
    120000, 8192, 'DIRECT', v_owner, '1970-01-01T00:00:00Z'
  );

  ----------------------------------------------------------------------------
  -- 1. 建会话（owner 身份）。
  ----------------------------------------------------------------------------
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_owner::text, 'role', 'authenticated')::text, true);

  v_conv := public.create_code_qa_conversation(array['kdmanage-backend'], 'release', null);
  v_conv_id := (v_conv ->> 'id')::uuid;
  perform pg_temp.assert(v_conv_id is not null, 'conversation created');
  perform pg_temp.assert(v_conv ->> 'title' = '新对话', 'default title');
  perform pg_temp.assert(v_conv -> 'commit_shas' = '{}'::jsonb, 'commit_sha starts null');
  perform pg_temp.assert((v_conv ->> 'has_session')::boolean = false, 'no dsh session yet');
  -- dsh_session_id 绝不出给浏览器。
  perform pg_temp.assert(not (v_conv ? 'dsh_session_id'), 'dsh_session_id never exposed');

  -- 白名单外的仓库/分支被 CHECK 拒绝。
  begin
    perform public.create_code_qa_conversation(array['not-a-repo'], 'release', null);
    perform pg_temp.assert(false, 'repository whitelist must reject unknown repo');
  exception when check_violation then null;
  end;
  begin
    perform public.create_code_qa_conversation(array['kdmanage-backend'], 'main', null);
    perform pg_temp.assert(false, 'branch whitelist must reject unknown branch');
  exception when check_violation then null;
  end;

  ----------------------------------------------------------------------------
  -- 2. 入队一轮：模型快照被冻结，标题被第一个问题替换。
  ----------------------------------------------------------------------------
  v_turn := public.request_code_qa_turn(v_conv_id, '  工单转派后原受理人的待办怎么处理？  ');
  v_turn_id := (v_turn ->> 'id')::uuid;
  perform pg_temp.assert(v_turn ->> 'status' = 'QUEUED', 'turn queued');
  perform pg_temp.assert(v_turn ->> 'stage' = 'QUEUED', 'stage queued');
  -- 前后空白被裁掉。
  perform pg_temp.assert(v_turn ->> 'question' = '工单转派后原受理人的待办怎么处理？',
    'question trimmed');

  /*
   * 模型快照必须冻结自**选型规则实际选中的那个配置**（V1.23c 起）。
   *
   * 规则：最近一个分析任务用过的启用且有 Key 的配置 → 回退到最近创建的启用且有 Key 的。
   * 这里不硬编码"应该是哪一个"，而是用同一条规则算出期望值再比对 —— 硬编码会让这个用例
   * 依赖本地库里恰好有哪些配置（第一版就是这么坏掉的）。
   */
  select cfg.id into v_expected_model
  from public.analysis_job job
  join public.ai_model_config cfg on cfg.id = job.model_config_id
  where cfg.enabled and public.model_config_has_api_key(cfg.api_key_secret_id)
  order by job.created_at desc, job.id desc
  limit 1;
  if v_expected_model is null then
    select id into v_expected_model
    from public.ai_model_config
    where enabled and public.model_config_has_api_key(api_key_secret_id)
    order by created_at desc, id desc
    limit 1;
  end if;
  perform pg_temp.assert(v_expected_model is not null,
    'the selection rule must resolve some usable model config');

  select count(*) into v_count from public.code_qa_turn turn
  join public.ai_model_config cfg on cfg.id = turn.model_config_id
  where turn.id = v_turn_id
    and turn.model_config_id = v_expected_model
    and turn.base_url_snapshot = cfg.base_url
    and turn.model_name_snapshot = cfg.model_name
    and turn.request_timeout_ms_snapshot = cfg.request_timeout_ms
    and turn.max_output_tokens_snapshot = cfg.max_output_tokens
    and turn.network_access_mode_snapshot = cfg.network_access_mode;
  perform pg_temp.assert(v_count = 1,
    'model snapshot must be frozen at enqueue from the config the rule selected');

  -- 选中的配置必须启用且有 Key。没有 Key 的配置被选中只是把失败从入队推迟到 spawn 之后 ——
  -- 本地实测踩过：旧规则选了一个 Key 是占位串的弃用配置，dsh 启动后才报错。
  perform pg_temp.assert(
    exists (
      select 1 from public.ai_model_config
      where id = v_expected_model
        and enabled
        and public.model_config_has_api_key(api_key_secret_id)
    ),
    'the selected config must be enabled and actually have a key');

  select title into v_error from public.code_qa_conversation where id = v_conv_id;
  perform pg_temp.assert(v_error = '工单转派后原受理人的待办怎么处理？',
    'first question becomes the title');

  ----------------------------------------------------------------------------
  -- 3. 同一会话第二轮在飞被拒。
  ----------------------------------------------------------------------------
  begin
    perform public.request_code_qa_turn(v_conv_id, '第二个问题');
    perform pg_temp.assert(false, 'a second in-flight turn must be rejected');
  exception when others then
    perform pg_temp.assert(sqlerrm like '%CODE_QA_TURN_IN_FLIGHT%',
      'expected CODE_QA_TURN_IN_FLIGHT, got: ' || sqlerrm);
  end;

  -- 空问题被拒。
  begin
    perform public.request_code_qa_turn(v_conv_id, '   ');
    perform pg_temp.assert(false, 'blank question must be rejected');
  exception when others then
    perform pg_temp.assert(sqlerrm like '%CODE_QA_QUESTION_REQUIRED%'
      or sqlerrm like '%CODE_QA_TURN_IN_FLIGHT%', 'blank question rejected: ' || sqlerrm);
  end;

  ----------------------------------------------------------------------------
  -- 4. 在飞时不能删会话。
  ----------------------------------------------------------------------------
  begin
    perform public.delete_code_qa_conversation(v_conv_id);
    perform pg_temp.assert(false, 'delete must be blocked while a turn is in flight');
  exception when others then
    perform pg_temp.assert(sqlerrm like '%CODE_QA_TURN_IN_FLIGHT%',
      'expected CODE_QA_TURN_IN_FLIGHT on delete, got: ' || sqlerrm);
  end;

  ----------------------------------------------------------------------------
  -- 5. 别人的会话：读不到、改不了、删不掉，且错误码与"不存在"相同。
  ----------------------------------------------------------------------------
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_other::text, 'role', 'authenticated')::text, true);

  begin
    perform public.get_code_qa_conversation(v_conv_id);
    perform pg_temp.assert(false, 'other user must not read the conversation');
  exception when others then
    perform pg_temp.assert(sqlerrm like '%CODE_QA_CONVERSATION_NOT_FOUND%',
      'expected NOT_FOUND for other owner, got: ' || sqlerrm);
  end;
  begin
    perform public.rename_code_qa_conversation(v_conv_id, '劫持标题');
    perform pg_temp.assert(false, 'other user must not rename');
  exception when others then
    perform pg_temp.assert(sqlerrm like '%CODE_QA_CONVERSATION_NOT_FOUND%',
      'rename must be denied: ' || sqlerrm);
  end;
  begin
    perform public.request_code_qa_turn(v_conv_id, '我能往别人会话里提问吗');
    perform pg_temp.assert(false, 'other user must not ask into the conversation');
  exception when others then
    perform pg_temp.assert(sqlerrm like '%CODE_QA_CONVERSATION_NOT_FOUND%',
      'ask must be denied: ' || sqlerrm);
  end;
  -- 不存在的 uuid 回同一个错误码（不泄露"存在性"）。
  begin
    perform public.get_code_qa_conversation('23000000-0000-4000-9999-999999999999');
    perform pg_temp.assert(false, 'unknown id must raise');
  exception when others then
    perform pg_temp.assert(sqlerrm like '%CODE_QA_CONVERSATION_NOT_FOUND%',
      'unknown id uses the same code: ' || sqlerrm);
  end;

  -- 别人的会话不出现在他的列表里。
  perform pg_temp.assert(
    jsonb_array_length(public.list_code_qa_conversations()) = 0,
    'other user sees no conversations');

  ----------------------------------------------------------------------------
  -- 6. Worker 认领：拿到会话级仓库/分支与模型快照。
  ----------------------------------------------------------------------------
  perform set_config('request.jwt.claims', null, true);
  set local role service_role;

  v_claim := public.claim_next_code_qa_turn('worker-code-qa', 600);
  perform pg_temp.assert(v_claim is not null, 'worker claims the queued turn');
  perform pg_temp.assert((v_claim ->> 'turn_id')::uuid = v_turn_id, 'claimed the right turn');
  v_token := (v_claim ->> 'claim_token')::uuid;
  perform pg_temp.assert(v_token is not null, 'claim token returned once');
  perform pg_temp.assert(v_claim -> 'repositories' = '["kdmanage-backend"]'::jsonb,
    'repository set from conversation');
  perform pg_temp.assert(v_claim ->> 'branch' = 'release', 'branch from conversation');
  perform pg_temp.assert(v_claim -> 'commit_shas' = '{}'::jsonb, 'first turn has no frozen sha');
  perform pg_temp.assert(v_claim ->> 'dsh_session_id' is null, 'first turn has no dsh session');
  -- Worker 必须拿到调模型需要的全部快照字段（它是 service_role，调不了 admin_* RPC）。
  -- 断言"与轮次行一致"而不是硬编码某个 base_url：选型规则由上面那段独立验证。
  perform pg_temp.assert(
    exists (
      select 1 from public.code_qa_turn turn
      where turn.id = v_turn_id
        and v_claim ->> 'base_url_snapshot' = turn.base_url_snapshot
        and v_claim ->> 'model_name_snapshot' = turn.model_name_snapshot
        and (v_claim ->> 'request_timeout_ms_snapshot')::integer = turn.request_timeout_ms_snapshot
        and (v_claim ->> 'max_output_tokens_snapshot')::integer = turn.max_output_tokens_snapshot
    ),
    'model snapshot handed to worker must match the frozen row exactly');
  perform pg_temp.assert(v_claim ->> 'base_url_snapshot' is not null,
    'worker cannot call a model without a base url');

  -- 只落摘要，不落明文 token。
  select count(*) into v_count from public.code_qa_turn
  where id = v_turn_id
    and claim_token_digest = public.agent_claim_token_digest(v_token)
    and status = 'RUNNING'
    and stage = 'PREPARING_CODE';
  perform pg_temp.assert(v_count = 1, 'claim stores only the digest and moves to PREPARING_CODE');

  -- 队列已空。
  perform pg_temp.assert(public.claim_next_code_qa_turn('worker-code-qa-2', 600) is null,
    'no second claimable turn');

  ----------------------------------------------------------------------------
  -- 7. stage 只能向前。
  ----------------------------------------------------------------------------
  perform pg_temp.assert(
    public.report_code_qa_turn_stage(v_turn_id, 'worker-code-qa', v_token, 'EXPLORING'),
    'advance to EXPLORING');
  -- 回退被拒（返回 false，不抛错，也不改值）。
  perform pg_temp.assert(
    public.report_code_qa_turn_stage(v_turn_id, 'worker-code-qa', v_token, 'PREPARING_CODE') = false,
    'stage must not go backwards');
  select stage into v_error from public.code_qa_turn where id = v_turn_id;
  perform pg_temp.assert(v_error = 'EXPLORING', 'stage stays at EXPLORING after a rejected rewind');
  begin
    perform public.report_code_qa_turn_stage(v_turn_id, 'worker-code-qa', v_token, 'NOPE');
    perform pg_temp.assert(false, 'unknown stage must raise');
  exception when others then
    perform pg_temp.assert(sqlerrm like '%CODE_QA_STAGE_INVALID%', 'bad stage: ' || sqlerrm);
  end;

  ----------------------------------------------------------------------------
  -- 8. commit_sha 只冻结一次。
  ----------------------------------------------------------------------------
  v_sha := public.bind_code_qa_conversation_snapshot(
    v_turn_id, 'worker-code-qa', v_token, 'kdmanage-backend',
    'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678');
  perform pg_temp.assert(v_sha = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678', 'sha frozen');

  -- 第二次用**不同**的 SHA 调用：必须返回既有值，不覆盖。
  v_sha := public.bind_code_qa_conversation_snapshot(
    v_turn_id, 'worker-code-qa', v_token, 'kdmanage-backend',
    'ffffffffffffffffffffffffffffffffffffffff');
  perform pg_temp.assert(v_sha = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
    'the frozen sha wins; a later turn must not silently rebase the conversation');
  select commit_shas ->> 'kdmanage-backend' into v_error
  from public.code_qa_conversation where id = v_conv_id;
  perform pg_temp.assert(v_error = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
    'stored sha unchanged');

  -- 非法 SHA 被拒。
  begin
    perform public.bind_code_qa_conversation_snapshot(
      v_turn_id, 'worker-code-qa', v_token, 'kdmanage-backend', 'HEAD');
    perform pg_temp.assert(false, 'non-sha must be rejected');
  exception when others then
    perform pg_temp.assert(sqlerrm like '%CODE_QA_COMMIT_SHA_INVALID%', 'bad sha: ' || sqlerrm);
  end;

  -- 不在会话范围内的仓库不能冻结：写错仓库名会往映射里塞一个永远读不到的键，
  -- 而那种错误没有任何症状（V1.23d）。
  begin
    perform public.bind_code_qa_conversation_snapshot(
      v_turn_id, 'worker-code-qa', v_token, 'tmanage-backend', repeat('a', 40));
    perform pg_temp.assert(false, 'a repository outside the conversation must be rejected');
  exception when others then
    perform pg_temp.assert(sqlerrm like '%CODE_QA_REPOSITORY_NOT_IN_CONVERSATION%',
      'out-of-scope repository: ' || sqlerrm);
  end;

  ----------------------------------------------------------------------------
  -- 9. DSH session id 写回会话。
  ----------------------------------------------------------------------------
  perform pg_temp.assert(
    public.bind_code_qa_conversation_session(
      v_turn_id, 'worker-code-qa', v_token, 'dsh-session-0001', 'catalog-hash-aaa'),
    'session id bound');
  select dsh_session_id || '|' || skill_catalog_hash into v_error
  from public.code_qa_conversation where id = v_conv_id;
  perform pg_temp.assert(v_error = 'dsh-session-0001|catalog-hash-aaa', 'session + catalog stored');

  ----------------------------------------------------------------------------
  -- 10. Key 只发给持有租约的 Worker。
  ----------------------------------------------------------------------------
  perform pg_temp.assert(
    public.get_model_secret_for_code_qa_turn(v_turn_id, 'worker-code-qa', v_token) is not null,
    'lease holder gets the key');
  begin
    perform public.get_model_secret_for_code_qa_turn(v_turn_id, 'worker-code-qa', gen_random_uuid());
    perform pg_temp.assert(false, 'wrong claim token must not get the key');
  exception when others then
    perform pg_temp.assert(sqlerrm like '%TASK_LEASE_LOST%', 'key gated by lease: ' || sqlerrm);
  end;
  begin
    perform public.get_model_secret_for_code_qa_turn(v_turn_id, 'another-worker', v_token);
    perform pg_temp.assert(false, 'wrong worker id must not get the key');
  exception when others then
    perform pg_temp.assert(sqlerrm like '%TASK_LEASE_LOST%', 'key gated by worker id: ' || sqlerrm);
  end;

  ----------------------------------------------------------------------------
  -- 11. 空答案不能落成 SUCCEEDED。
  ----------------------------------------------------------------------------
  begin
    perform public.submit_code_qa_turn_result(v_turn_id, 'worker-code-qa', v_token, '   ', '{}'::jsonb);
    perform pg_temp.assert(false, 'empty answer must not succeed');
  exception when others then
    perform pg_temp.assert(sqlerrm like '%CODE_QA_ANSWER_EMPTY%', 'empty answer: ' || sqlerrm);
  end;

  ----------------------------------------------------------------------------
  -- 12. 提交成功 + 证据。
  ----------------------------------------------------------------------------
  perform pg_temp.assert(
    public.submit_code_qa_turn_result(
      v_turn_id, 'worker-code-qa', v_token,
      '转派后原受理人的待办会被关闭，见 src/task/TransferService.java',
      jsonb_build_object(
        'commit_shas', jsonb_build_object(
          'kdmanage-backend', 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'),
        'files_read', jsonb_build_array('src/task/TransferService.java'),
        'skills_used', jsonb_build_array('kdmanage-backend-engineering'),
        'resumed', false,
        'tool_call_count', 7
      )),
    'result submitted');

  select status || '|' || stage into v_error from public.code_qa_turn where id = v_turn_id;
  perform pg_temp.assert(v_error = 'SUCCEEDED|DONE', 'terminal status and stage');

  -- 租约已经用过了，但 submit 之后行不再是 RUNNING，所以同一个 token 不能再提交。
  begin
    perform public.submit_code_qa_turn_result(v_turn_id, 'worker-code-qa', v_token, '再来一次', '{}'::jsonb);
    perform pg_temp.assert(false, 'a terminal turn must not accept another result');
  exception when others then
    perform pg_temp.assert(sqlerrm like '%TASK_LEASE_LOST%', 'terminal turn is closed: ' || sqlerrm);
  end;

  ----------------------------------------------------------------------------
  -- 13. owner 读回：答案与证据都在，且能再提下一轮。
  ----------------------------------------------------------------------------
  set local role none;
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_owner::text, 'role', 'authenticated')::text, true);

  v_detail := public.get_code_qa_conversation(v_conv_id);
  perform pg_temp.assert(jsonb_array_length(v_detail -> 'turns') = 1, 'one turn visible');
  perform pg_temp.assert(
    (v_detail -> 'turns' -> 0 ->> 'answer') like '%TransferService.java%', 'answer readable');
  perform pg_temp.assert(
    (v_detail -> 'turns' -> 0 -> 'evidence' -> 'commit_shas' ->> 'kdmanage-backend')
      = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678', 'evidence carries the commit sha');
  perform pg_temp.assert((v_detail ->> 'has_session')::boolean = true, 'session flag visible');
  perform pg_temp.assert(
    v_detail -> 'commit_shas' ->> 'kdmanage-backend'
      = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
    'frozen sha visible to the owner');
  perform pg_temp.assert(v_detail -> 'repositories' = '["kdmanage-backend"]'::jsonb,
    'repository set visible to the owner');
  perform pg_temp.assert(v_detail ->> 'model_label' is null, 'conversation has no model label');
  -- 轮次带回答它的模型显示名。断言"与选中的配置一致"而不是硬编码名字。
  perform pg_temp.assert(
    (v_detail -> 'turns' -> 0 ->> 'model_label')
      = (select display_name from public.ai_model_config where id = v_expected_model),
    'turn carries the display name of the model that answered it');

  -- 终态之后可以提下一轮。
  v_turn := public.request_code_qa_turn(v_conv_id, '那转派记录在哪张表？');
  perform pg_temp.assert(v_turn ->> 'status' = 'QUEUED', 'next turn can be queued');
  v_turn_id := (v_turn ->> 'id')::uuid;
  -- 标题不被第二个问题覆盖。
  select title into v_error from public.code_qa_conversation where id = v_conv_id;
  perform pg_temp.assert(v_error = '工单转派后原受理人的待办怎么处理？', 'title set only once');

  ----------------------------------------------------------------------------
  -- 14. 第二轮认领时，会话冻结的 SHA 与 session id 都交给 Worker。
  ----------------------------------------------------------------------------
  perform set_config('request.jwt.claims', null, true);
  set local role service_role;
  v_claim := public.claim_next_code_qa_turn('worker-code-qa', 600);
  perform pg_temp.assert((v_claim ->> 'turn_id')::uuid = v_turn_id, 'second turn claimed');
  perform pg_temp.assert(
    v_claim -> 'commit_shas' ->> 'kdmanage-backend'
      = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
    'second turn reuses the frozen sha');
  perform pg_temp.assert(v_claim ->> 'dsh_session_id' = 'dsh-session-0001',
    'second turn resumes the same dsh session');

  ----------------------------------------------------------------------------
  -- 15. 失联租约回收：否则唯一索引永久堵住这个会话。
  ----------------------------------------------------------------------------
  update public.code_qa_turn set lease_expires_at = now() - interval '1 minute'
  where id = v_turn_id;
  perform pg_temp.assert(public.reclaim_stale_code_qa_turn_leases() >= 1, 'stale lease reclaimed');
  select status || '|' || stage into v_error from public.code_qa_turn where id = v_turn_id;
  perform pg_temp.assert(v_error = 'QUEUED|QUEUED', 'reclaimed turn is queued again');
  select count(*) into v_count from public.code_qa_turn
  where id = v_turn_id and worker_id is null and claim_token_digest is null;
  perform pg_temp.assert(v_count = 1, 'reclaim clears the claim');

  ----------------------------------------------------------------------------
  -- 16. code_qa_turn 对 authenticated 没有任何 RLS 策略。
  ----------------------------------------------------------------------------
  set local role none;
  select count(*) into v_policies from pg_policies
  where schemaname = 'public' and tablename = 'code_qa_turn';
  perform pg_temp.assert(v_policies = 0,
    'code_qa_turn must have no RLS policy; it is RPC-only');

  select count(*) into v_count from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname in ('code_qa_turn', 'code_qa_conversation')
    and c.relrowsecurity;
  perform pg_temp.assert(v_count = 2, 'RLS enabled on both tables');

  -- 会话表只给 owner 的 select，没有 insert/update/delete 策略。
  select count(*) into v_count from pg_policies
  where schemaname = 'public' and tablename = 'code_qa_conversation' and cmd <> 'SELECT';
  perform pg_temp.assert(v_count = 0,
    'browser must not be able to write code_qa_conversation directly');

  ----------------------------------------------------------------------------
  -- 17. Worker 侧 RPC 不授予 authenticated。
  ----------------------------------------------------------------------------
  select count(*) into v_count
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in (
      'claim_next_code_qa_turn', 'heartbeat_code_qa_turn', 'report_code_qa_turn_stage',
      'bind_code_qa_conversation_snapshot', 'bind_code_qa_conversation_session',
      'get_model_secret_for_code_qa_turn', 'submit_code_qa_turn_result',
      'submit_code_qa_turn_failure', 'reclaim_stale_code_qa_turn_leases',
      'assert_code_qa_turn_claim'
    )
    and has_function_privilege('authenticated', p.oid, 'execute');
  perform pg_temp.assert(v_count = 0,
    'no worker-side code QA RPC may be executable by authenticated');

  -- 反面：产品用的那些必须对 authenticated 可执行。
  select count(*) into v_count
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in (
      'code_qa_catalog', 'create_code_qa_conversation', 'list_code_qa_conversations',
      'get_code_qa_conversation', 'rename_code_qa_conversation',
      'delete_code_qa_conversation', 'request_code_qa_turn'
    )
    and has_function_privilege('authenticated', p.oid, 'execute');
  perform pg_temp.assert(v_count = 7, 'all seven product-facing RPCs are granted to authenticated');

  -- anon 一个都不能碰。
  select count(*) into v_count
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname like '%code_qa%'
    and has_function_privilege('anon', p.oid, 'execute');
  perform pg_temp.assert(v_count = 0, 'anon must not execute any code QA function');

  raise notice 'V1.23 code QA conversation test: all assertions passed';
end;
$test$;

rollback;
