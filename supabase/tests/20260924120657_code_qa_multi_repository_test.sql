-- V1.23d：一个会话挂多个仓库。
--
-- 盯住的点：
--   1. 多仓库能建、去重、排序（勾选顺序不该产生两份不同的上下文）；
--   2. 非法集合被拒：空、超出白名单、重复、超过数量上限；
--   3. 每个仓库各自冻结 commit，且只能冻结一次；
--   4. 认领时 Worker 拿到完整的仓库集合与 SHA 映射；
--   5. 不在会话范围内的仓库不能冻结；
--   6. 旧的单值签名 `create_code_qa_conversation(text, text, text)` **已经不存在** ——
--      留着它就等于留一条绕过多仓库校验的旧路径。
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
  v_conv jsonb;
  v_conv_id uuid;
  v_turn jsonb;
  v_turn_id uuid;
  v_claim jsonb;
  v_token uuid;
  v_sha text;
  v_detail jsonb;
  v_count integer;
  v_all text[];
begin
  insert into auth.users (id, email) values (v_owner, 'qa_multi@example.com')
  on conflict (id) do nothing;
  insert into public.user_profile (id, role) values (v_owner, 'VIEWER')
  on conflict (id) do update set role = excluded.role;

  perform set_config('request.jwt.claims',
    json_build_object('sub', v_owner::text, 'role', 'authenticated')::text, true);

  ----------------------------------------------------------------------------
  -- 1. 多仓库建会话：去重 + 排序。
  ----------------------------------------------------------------------------
  -- 刻意乱序且带重复，验证 RPC 自己收拾干净。
  v_conv := public.create_code_qa_conversation(
    array['kdmanage-frontend', 'kdmanage-backend', 'kdmanage-frontend'],
    'release', '跨端问题');
  v_conv_id := (v_conv ->> 'id')::uuid;

  perform pg_temp.assert(
    v_conv -> 'repositories' = '["kdmanage-backend","kdmanage-frontend"]'::jsonb,
    'repositories must be de-duplicated and sorted so the same selection always '
    || 'produces the same context');
  perform pg_temp.assert(v_conv -> 'commit_shas' = '{}'::jsonb,
    'nothing frozen before the first turn');
  perform pg_temp.assert(v_conv ->> 'branch' = 'release', 'branch stays a single value');

  ----------------------------------------------------------------------------
  -- 2. 非法集合被拒。
  ----------------------------------------------------------------------------
  begin
    perform public.create_code_qa_conversation(array[]::text[], 'release', null);
    perform pg_temp.assert(false, 'empty repository set must be rejected');
  exception when others then
    perform pg_temp.assert(sqlerrm like '%CODE_QA_REPOSITORY_REQUIRED%',
      'empty set: ' || sqlerrm);
  end;

  begin
    perform public.create_code_qa_conversation(array['   '], 'release', null);
    perform pg_temp.assert(false, 'blank-only repository set must be rejected');
  exception when others then
    perform pg_temp.assert(sqlerrm like '%CODE_QA_REPOSITORY_REQUIRED%',
      'blank set: ' || sqlerrm);
  end;

  begin
    perform public.create_code_qa_conversation(
      array['kdmanage-backend', 'not-a-repo'], 'release', null);
    perform pg_temp.assert(false, 'a repository outside the whitelist must be rejected');
  exception when check_violation then null;
  end;

  -- 全部白名单仓库一次挂上：应当刚好在上限内（上限 = 白名单数量）。
  v_all := public.analysis_allowed_repository_names();
  v_conv := public.create_code_qa_conversation(v_all, 'feature_dev', '全部仓库');
  perform pg_temp.assert(
    jsonb_array_length(v_conv -> 'repositories') = public.analysis_allowed_repository_count(),
    'the whole whitelist must fit exactly at the cap');

  -- 校验函数本身（CHECK 调用它，所以单独钉一次）。
  perform pg_temp.assert(
    public.code_qa_repositories_valid(array['kdmanage-backend']), 'single repo is valid');
  perform pg_temp.assert(
    not public.code_qa_repositories_valid(array['kdmanage-backend','kdmanage-backend']),
    'duplicates are invalid (they would mount the same snapshot twice)');
  perform pg_temp.assert(
    not public.code_qa_repositories_valid(array[]::text[]), 'empty is invalid');
  perform pg_temp.assert(
    not public.code_qa_repositories_valid(null), 'null is invalid');

  ----------------------------------------------------------------------------
  -- 3 + 4. 认领拿到完整集合；每个仓库各自冻结。
  ----------------------------------------------------------------------------
  v_turn := public.request_code_qa_turn(v_conv_id, '转派之后前端的待办列表怎么刷新？');
  v_turn_id := (v_turn ->> 'id')::uuid;

  perform set_config('request.jwt.claims', null, true);
  set local role service_role;

  v_claim := public.claim_next_code_qa_turn('worker-multi', 600);
  perform pg_temp.assert((v_claim ->> 'turn_id')::uuid = v_turn_id, 'claimed the right turn');
  v_token := (v_claim ->> 'claim_token')::uuid;
  perform pg_temp.assert(
    v_claim -> 'repositories' = '["kdmanage-backend","kdmanage-frontend"]'::jsonb,
    'the worker receives the full repository set');
  perform pg_temp.assert(v_claim -> 'commit_shas' = '{}'::jsonb, 'nothing frozen yet');
  perform pg_temp.assert(v_claim ->> 'branch' = 'release', 'one branch for all repositories');

  -- 后端先冻结。
  v_sha := public.bind_code_qa_conversation_snapshot(
    v_turn_id, 'worker-multi', v_token, 'kdmanage-backend', repeat('a', 40));
  perform pg_temp.assert(v_sha = repeat('a', 40), 'backend sha frozen');

  -- 前端独立冻结，互不影响。
  v_sha := public.bind_code_qa_conversation_snapshot(
    v_turn_id, 'worker-multi', v_token, 'kdmanage-frontend', repeat('b', 40));
  perform pg_temp.assert(v_sha = repeat('b', 40), 'frontend sha frozen independently');

  select commit_shas into v_detail from public.code_qa_conversation where id = v_conv_id;
  perform pg_temp.assert(v_detail ->> 'kdmanage-backend' = repeat('a', 40), 'backend stored');
  perform pg_temp.assert(v_detail ->> 'kdmanage-frontend' = repeat('b', 40), 'frontend stored');

  -- 冻结只有一次：用不同 SHA 再调，返回既有值。
  v_sha := public.bind_code_qa_conversation_snapshot(
    v_turn_id, 'worker-multi', v_token, 'kdmanage-backend', repeat('c', 40));
  perform pg_temp.assert(v_sha = repeat('a', 40),
    'per-repository freeze happens once; a later turn must not rebase one repository '
    || 'while the others stay put');

  ----------------------------------------------------------------------------
  -- 5. 不在会话范围内的仓库不能冻结。
  ----------------------------------------------------------------------------
  begin
    perform public.bind_code_qa_conversation_snapshot(
      v_turn_id, 'worker-multi', v_token, 'tmanage-backend', repeat('d', 40));
    perform pg_temp.assert(false, 'out-of-scope repository must be rejected');
  exception when others then
    perform pg_temp.assert(sqlerrm like '%CODE_QA_REPOSITORY_NOT_IN_CONVERSATION%',
      'out-of-scope: ' || sqlerrm);
  end;

  ----------------------------------------------------------------------------
  -- 6. 第二轮拿到两个仓库都已冻结的映射。
  ----------------------------------------------------------------------------
  perform public.submit_code_qa_turn_result(
    v_turn_id, 'worker-multi', v_token, '前端在 X 处刷新，后端在 Y 处推送。',
    jsonb_build_object(
      'commit_shas', jsonb_build_object(
        'kdmanage-backend', repeat('a', 40),
        'kdmanage-frontend', repeat('b', 40)),
      'repositories', jsonb_build_array('kdmanage-backend', 'kdmanage-frontend'),
      'files_read', jsonb_build_array(
        'kdmanage-backend/src/A.java', 'kdmanage-frontend/src/b.vue'),
      'resumed', false));

  set local role none;
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_owner::text, 'role', 'authenticated')::text, true);
  v_turn := public.request_code_qa_turn(v_conv_id, '那后端推送用的是什么通道？');
  v_turn_id := (v_turn ->> 'id')::uuid;

  perform set_config('request.jwt.claims', null, true);
  set local role service_role;
  v_claim := public.claim_next_code_qa_turn('worker-multi', 600);
  perform pg_temp.assert((v_claim ->> 'turn_id')::uuid = v_turn_id, 'second turn claimed');
  perform pg_temp.assert(
    v_claim -> 'commit_shas' ->> 'kdmanage-backend' = repeat('a', 40)
    and v_claim -> 'commit_shas' ->> 'kdmanage-frontend' = repeat('b', 40),
    'the second turn reuses both frozen shas');

  ----------------------------------------------------------------------------
  -- 7. 旧的单值签名必须已经不存在。
  ----------------------------------------------------------------------------
  set local role none;
  select count(*) into v_count
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'create_code_qa_conversation';
  perform pg_temp.assert(v_count = 1,
    'exactly one create_code_qa_conversation overload must exist; a leftover single-repo '
    || 'signature would be a path that bypasses the multi-repository checks');

  select count(*) into v_count
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'bind_code_qa_conversation_snapshot';
  perform pg_temp.assert(v_count = 1,
    'exactly one bind_code_qa_conversation_snapshot overload (the one taking a repository)');

  -- 旧列必须已经删掉：留一个永远为空的兼容列会让后面每个读它的地方都要判断看哪一列。
  select count(*) into v_count from information_schema.columns
  where table_schema = 'public' and table_name = 'code_qa_conversation'
    and column_name in ('repository', 'commit_sha');
  perform pg_temp.assert(v_count = 0, 'the single-repository columns must be gone');

  raise notice 'V1.23d code QA multi-repository test: all assertions passed';
end;
$test$;

rollback;
