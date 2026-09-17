-- 20260917030000_model_connectivity_test_queue_test.sql
-- V1.7：模型连接测试队列的权限、fencing、密钥读取与安全投影契约。
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
  v_admin uuid := '17000000-0000-4000-a000-000000000001';
  v_reviewer uuid := '17000000-0000-4000-a000-000000000002';
  v_model uuid := '17000000-0000-4000-b000-000000000001';
  v_secret uuid;
  v_test_id uuid;
  v_same_id uuid;
  v_claim jsonb;
  v_token uuid;
  v_other_token uuid := '17000000-0000-4000-c000-0000000000ff';
  v_result jsonb;
  v_error text;
  v_rls boolean;
begin
  insert into auth.users (id, email) values
    (v_admin, 'admin_17_conn@example.com'),
    (v_reviewer, 'reviewer_17_conn@example.com')
  on conflict (id) do nothing;
  insert into public.user_profile (id, role) values
    (v_admin, 'ADMIN'),
    (v_reviewer, 'REVIEWER')
  on conflict (id) do update set role = excluded.role;

  set local role service_role;
  v_secret := public.admin_vault_create_secret(
    '17-connectivity-test-not-a-real-key',
    '17_connectivity_test_key'
  );
  reset role;

  insert into public.ai_model_config (
    id, display_name, base_url, model_name, api_key_secret_id,
    enabled, max_parallel_tasks, request_timeout_ms, created_by
  ) values (
    v_model, 'Model 17 connectivity', 'http://ai.internal.example/sz1/inference/usr-x/inf-y/',
    'kimi-k3', v_secret, true, 2, 180000, v_admin
  );

  -- 1. 表默认拒绝：RLS 开启且普通角色没有任何表级权限。
  select relrowsecurity into v_rls
  from pg_class where oid = 'public.model_connectivity_test'::regclass;
  perform pg_temp.assert(v_rls, 'model_connectivity_test has RLS enabled');
  perform pg_temp.assert(
    not has_table_privilege('authenticated', 'public.model_connectivity_test', 'select')
      and not has_table_privilege('authenticated', 'public.model_connectivity_test', 'insert')
      and not has_table_privilege('anon', 'public.model_connectivity_test', 'select'),
    'browser roles cannot touch the queue table directly'
  );

  -- 2. Worker RPC 只授予 service_role。
  perform pg_temp.assert(
    not has_function_privilege(
      'authenticated',
      'public.claim_next_model_connectivity_test(text, integer)',
      'execute'
    )
      and not has_function_privilege(
        'authenticated',
        'public.get_model_secret_for_connectivity_test(uuid, text, uuid)',
        'execute'
      )
      and has_function_privilege(
        'service_role',
        'public.claim_next_model_connectivity_test(text, integer)',
        'execute'
      ),
    'worker RPCs are service-role only'
  );

  -- 3. 非 ADMIN 不能排队。
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', v_reviewer::text, 'role', 'authenticated')::text,
    true
  );
  begin
    perform public.enqueue_model_connectivity_test(v_model);
    raise exception 'REVIEWER must not enqueue a connectivity test';
  exception when others then
    v_error := SQLERRM;
    perform pg_temp.assert(
      v_error not like 'REVIEWER must not%',
      'non-ADMIN enqueue is rejected'
    );
  end;

  -- 4. ADMIN 排队，并且重复点击复用同一条活动任务。
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', v_admin::text, 'role', 'authenticated')::text,
    true
  );
  v_test_id := public.enqueue_model_connectivity_test(v_model);
  v_same_id := public.enqueue_model_connectivity_test(v_model);
  perform pg_temp.assert(v_test_id = v_same_id, 'one active test per model config');

  -- 5. 安全投影不含 URL、worker、租约与 claim 摘要。
  v_result := public.get_model_connectivity_test(v_test_id);
  perform pg_temp.assert(v_result->>'status' = 'QUEUED', 'a fresh test starts QUEUED');
  perform pg_temp.assert(
    not (v_result ? 'base_url_snapshot')
      and not (v_result ? 'worker_id')
      and not (v_result ? 'claim_token_digest')
      and not (v_result ? 'lease_expires_at'),
    'the browser projection exposes no endpoint, worker or fencing fields'
  );

  set local role service_role;

  -- 6. claim 返回明文 token，但绝不返回摘要。
  v_claim := public.claim_next_model_connectivity_test('worker-17-a', 90);
  perform pg_temp.assert(v_claim->>'id' = v_test_id::text, 'the queued test is claimed');
  perform pg_temp.assert(
    v_claim->>'status' = 'RUNNING'
      and (v_claim->>'attempt')::integer = 1
      and v_claim->>'base_url_snapshot' = 'http://ai.internal.example/sz1/inference/usr-x/inf-y/'
      and v_claim->>'model_name_snapshot' = 'kimi-k3'
      -- 探测超时上限 30 秒：配置的 180 秒不能让一次连通性测试长期占用租约。
      and (v_claim->>'request_timeout_ms_snapshot')::integer = 30000,
    'the claim carries the frozen endpoint snapshot and a clamped timeout'
  );
  perform pg_temp.assert(
    not (v_claim ? 'claim_token_digest') and (v_claim ? 'claim_token'),
    'the claim returns the plaintext token only'
  );
  v_token := (v_claim->>'claim_token')::uuid;
  perform pg_temp.assert(
    (select claim_token_digest = public.agent_claim_token_digest(v_token)
     from public.model_connectivity_test where id = v_test_id),
    'only the token digest is stored'
  );

  -- 7. 已被领取的任务不会被第二个 Worker 重复领取。
  perform pg_temp.assert(
    public.claim_next_model_connectivity_test('worker-17-b', 90) is null,
    'a claimed test is not handed to another worker'
  );

  -- 8. 错误 worker 或错误 token 不能续租、读密钥或写终态。
  perform pg_temp.assert(
    not public.heartbeat_model_connectivity_test(v_test_id, 'worker-17-b', v_token, 90),
    'heartbeat requires the owning worker'
  );
  perform pg_temp.assert(
    not public.heartbeat_model_connectivity_test(v_test_id, 'worker-17-a', v_other_token, 90),
    'heartbeat requires the matching claim token'
  );
  perform pg_temp.assert(
    public.heartbeat_model_connectivity_test(v_test_id, 'worker-17-a', v_token, 90),
    'the owning worker renews its lease'
  );
  begin
    perform public.get_model_secret_for_connectivity_test(v_test_id, 'worker-17-a', v_other_token);
    raise exception 'secret read must be fenced';
  exception when others then
    perform pg_temp.assert(SQLERRM like '%TASK_LEASE_LOST%', 'a stale claim cannot read the key');
  end;
  perform pg_temp.assert(
    public.get_model_secret_for_connectivity_test(v_test_id, 'worker-17-a', v_token)
      = '17-connectivity-test-not-a-real-key',
    'the owning worker reads the current Vault key'
  );
  perform pg_temp.assert(
    not public.complete_model_connectivity_test(v_test_id, 'worker-17-b', v_token, 200, 12),
    'completion requires the owning worker'
  );
  -- 非 2xx 绝不能被写成成功。
  perform pg_temp.assert(
    not public.complete_model_connectivity_test(v_test_id, 'worker-17-a', v_token, 403, 12),
    'a non-2xx status cannot be recorded as success'
  );

  -- 9. 失败落稳定错误码，并原子清空租约与 token。
  perform pg_temp.assert(
    public.fail_model_connectivity_test(
      v_test_id, 'worker-17-a', v_token, 'MODEL_NETWORK_ERROR', '无法连接模型端点', null, 900
    ),
    'the owning worker records a failure'
  );
  v_result := public.get_model_connectivity_test(v_test_id);
  perform pg_temp.assert(
    v_result->>'status' = 'FAILED'
      and v_result->>'error_code' = 'MODEL_NETWORK_ERROR'
      and (v_result->>'latency_ms')::integer = 900
      and v_result->>'status_code' is null,
    'the failure result is visible to the browser projection'
  );
  perform pg_temp.assert(
    (select worker_id is null and lease_expires_at is null and claim_token_digest is null
     from public.model_connectivity_test where id = v_test_id),
    'a terminal test releases its lease and token'
  );
  -- 迟到的写入不能改变已终结的测试。
  perform pg_temp.assert(
    not public.complete_model_connectivity_test(v_test_id, 'worker-17-a', v_token, 200, 10)
      and not public.fail_model_connectivity_test(
        v_test_id, 'worker-17-a', v_token, 'MODEL_TIMEOUT', '超时', null, 10
      ),
    'a terminal test rejects late writes'
  );

  -- 10. 关停释放回队列，可被下一个 Worker 接管并成功。
  reset role;
  v_test_id := public.enqueue_model_connectivity_test(v_model);
  set local role service_role;
  v_claim := public.claim_next_model_connectivity_test('worker-17-a', 90);
  v_token := (v_claim->>'claim_token')::uuid;
  perform pg_temp.assert(
    public.release_model_connectivity_test_claim(v_test_id, 'worker-17-a', v_token),
    'a shutting-down worker releases its claim'
  );
  perform pg_temp.assert(
    (select status = 'QUEUED' and worker_id is null
     from public.model_connectivity_test where id = v_test_id),
    'a released test returns to the queue'
  );
  v_claim := public.claim_next_model_connectivity_test('worker-17-b', 90);
  perform pg_temp.assert(
    v_claim->>'id' = v_test_id::text and (v_claim->>'attempt')::integer = 2,
    'the requeued test is taken over with a new attempt'
  );
  v_token := (v_claim->>'claim_token')::uuid;
  perform pg_temp.assert(
    public.complete_model_connectivity_test(v_test_id, 'worker-17-b', v_token, 200, 74),
    'the new owner records success'
  );
  v_result := public.get_model_connectivity_test(v_test_id);
  perform pg_temp.assert(
    v_result->>'status' = 'SUCCEEDED'
      and (v_result->>'status_code')::integer = 200
      and (v_result->>'latency_ms')::integer = 74
      and v_result->>'error_code' is null,
    'the success result is visible with its latency'
  );
  reset role;

  -- 11. Vault 里查不到密钥时不排队（列本身 not null，所以指向一个不存在的 secret）。
  update public.ai_model_config
  set api_key_secret_id = '17000000-0000-4000-e000-0000000000ee'
  where id = v_model;
  begin
    perform public.enqueue_model_connectivity_test(v_model);
    raise exception 'enqueue without a key must fail';
  exception when others then
    perform pg_temp.assert(
      SQLERRM like '%MODEL_SECRET_MISSING%',
      'a model without a Vault key cannot be tested'
    );
  end;
end;
$test$;

select 'ALL_MODEL_CONNECTIVITY_TEST_QUEUE_TESTS_PASSED' as result;

rollback;
