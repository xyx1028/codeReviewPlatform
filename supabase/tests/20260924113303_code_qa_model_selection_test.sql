-- V1.23c：问答的模型选型改成「平台实际在跑的那个」。
--
-- 这份测试来自一次真实的本地端到端失败（2026-09-24）。第一版规则是
-- `order by created_at, id limit 1`（最早创建的启用配置），它确实确定，但**确定地选错**：
-- 本地库里有 2026-09-17 创建、后来被弃用但没停用的配置，Key 是 18 字节占位串；而平台最近
-- 5 个分析任务全部在用 2026-09-23 创建的那个。表现是 dsh 启动后才报
--   `the API key resolved from CODE_QA_MODEL_API_KEY contains characters no HTTP header can carry`
-- —— 运维会去查"问答为什么连不上模型"，而真正的原因是选错了配置。
--
-- 所以这里正面钉住三条：
--   1. 有分析任务时，选中的就是**最近一个分析任务**用的那个配置；
--   2. 没有可用分析任务时，回退到**最近创建的**启用且有 Key 的配置（不是最早的）；
--   3. 没有 Key 的配置**永远不被选中**（否则只是把失败从入队推迟到 spawn 之后）。
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
  v_owner uuid := '25000000-0000-4000-a000-000000000001';
  -- 三个配置：老的有 Key、新的有 Key、最新的**没有** Key。
  v_old   uuid := '25000000-0000-4000-c000-000000000001';
  v_new   uuid := '25000000-0000-4000-c000-000000000002';
  v_nokey uuid := '25000000-0000-4000-c000-000000000003';
  v_secret_old uuid;
  v_secret_new uuid;
  v_conv jsonb;
  v_turn jsonb;
  v_chosen uuid;
  -- analysis_job 有若干 NOT NULL 与 V4 策略触发器，直接抄一行既有 Job 的这些列。
  v_tpl public.analysis_job;
begin
  insert into auth.users (id, email) values (v_owner, 'qa_model_pick@example.com')
  on conflict (id) do nothing;
  insert into public.user_profile (id, role) values (v_owner, 'VIEWER')
  on conflict (id) do update set role = excluded.role;

  -- 先把本地库里既有的启用配置全部停用，让这个用例只看自己造的三条。
  -- 事务结束会 rollback，不影响真实数据。
  update public.ai_model_config set enabled = false where enabled;

  v_secret_old := vault.create_secret('sk-old', 'pick_old_' || gen_random_uuid()::text);
  v_secret_new := vault.create_secret('sk-new', 'pick_new_' || gen_random_uuid()::text);

  insert into public.ai_model_config (
    id, display_name, base_url, model_name, api_key_secret_id, enabled,
    request_timeout_ms, max_output_tokens, network_access_mode, created_by, created_at
  ) values
    (v_old, '老配置（有 Key）', 'https://old.invalid/v1', 'old-model', v_secret_old, true,
     120000, 8192, 'DIRECT', v_owner, '2020-01-01T00:00:00Z'),
    (v_new, '新配置（有 Key）', 'https://new.invalid/v1', 'new-model', v_secret_new, true,
     120000, 8192, 'DIRECT', v_owner, '2020-06-01T00:00:00Z'),
    -- api_key_secret_id 是 NOT NULL，所以"没有 Key"只能用一个**在 vault 里不存在**的
    -- secret id 来表达 —— 这正是 model_config_has_api_key 的判据（exists in vault.secrets），
    -- 也正是线上"管理员删了 secret 但没停用配置"的真实形态。
    (v_nokey, '最新但没 Key', 'https://nokey.invalid/v1', 'nokey-model',
     '25000000-0000-4000-9999-000000000001', true,
     120000, 8192, 'DIRECT', v_owner, '2020-12-01T00:00:00Z');

  perform set_config('request.jwt.claims',
    json_build_object('sub', v_owner::text, 'role', 'authenticated')::text, true);

  ----------------------------------------------------------------------------
  -- 2 + 3. 没有分析任务时：回退到最近创建的**有 Key** 的配置 = v_new。
  --        最早的 v_old 不该赢（那是第一版的 bug），没 Key 的 v_nokey 也不该赢。
  ----------------------------------------------------------------------------
  v_conv := public.create_code_qa_conversation(array['kdmanage-backend'], 'release', '选型-回退');
  v_turn := public.request_code_qa_turn((v_conv ->> 'id')::uuid, '问题一');

  select model_config_id into v_chosen
  from public.code_qa_turn where id = (v_turn ->> 'id')::uuid;

  perform pg_temp.assert(v_chosen = v_new,
    'fallback must pick the NEWEST enabled config that has a key, not the oldest '
    || '(V1.23a picked the oldest and hit an abandoned placeholder key)');
  perform pg_temp.assert(v_chosen <> v_nokey,
    'a config without an api key must never be selected');
  perform pg_temp.assert(v_chosen <> v_old,
    'the oldest config must not win by default');

  -- 快照确实来自被选中的那个配置。
  perform pg_temp.assert(
    exists (
      select 1 from public.code_qa_turn
      where id = (v_turn ->> 'id')::uuid
        and base_url_snapshot = 'https://new.invalid/v1'
        and model_name_snapshot = 'new-model'
    ),
    'snapshot columns come from the selected config');

  ----------------------------------------------------------------------------
  -- 1. 有分析任务时：跟着最近那个任务用的配置走（即使它不是最近创建的）。
  ----------------------------------------------------------------------------
  -- 造一个用 v_old 的分析任务（比 v_new 的创建时间新，但模型是老的那个）。
  insert into public.review_batch (id, name, week_code, status, default_branch, created_by)
  values ('25000000-0000-4000-b000-000000000001', '选型测试批次', 'PICK-W01', 'DRAFT',
          'feature_dev', v_owner);
  select * into v_tpl from public.analysis_job order by created_at desc limit 1;
  if v_tpl.id is null then
    raise exception 'this test needs at least one existing analysis_job row to copy invariants from';
  end if;

  insert into public.analysis_job (
    id, batch_id, model_config_id, model_snapshot, requested_branch, status, requested_by,
    created_at, execution_engine, policy_version, capability_policy_snapshot, harness_version
  ) values (
    '25000000-0000-4000-f000-000000000001', '25000000-0000-4000-b000-000000000001',
    v_old, v_tpl.model_snapshot, 'feature_dev', 'QUEUED', v_owner,
    now(), v_tpl.execution_engine, v_tpl.policy_version, v_tpl.capability_policy_snapshot,
    v_tpl.harness_version
  );

  v_conv := public.create_code_qa_conversation(array['kdmanage-backend'], 'release', '选型-跟随任务');
  v_turn := public.request_code_qa_turn((v_conv ->> 'id')::uuid, '问题二');

  select model_config_id into v_chosen
  from public.code_qa_turn where id = (v_turn ->> 'id')::uuid;

  perform pg_temp.assert(v_chosen = v_old,
    'with analysis jobs present, code QA must follow the model the platform actually '
    || 'runs on (the most recent job''s config), so answers match review verdicts');

  ----------------------------------------------------------------------------
  -- 边界：最近的任务用了一个没 Key 的配置时跳过它，不能选一个调不通的模型。
  ----------------------------------------------------------------------------
  -- 第二个 Job 必须放在另一个批次：uq_analysis_job_active_batch 只允许每个批次一个在途 Job。
  insert into public.review_batch (id, name, week_code, status, default_branch, created_by)
  values ('25000000-0000-4000-b000-000000000002', '选型测试批次2', 'PICK-W02', 'DRAFT',
          'feature_dev', v_owner);
  insert into public.analysis_job (
    id, batch_id, model_config_id, model_snapshot, requested_branch, status, requested_by,
    created_at, execution_engine, policy_version, capability_policy_snapshot, harness_version
  ) values (
    '25000000-0000-4000-f000-000000000002', '25000000-0000-4000-b000-000000000002',
    v_nokey, v_tpl.model_snapshot, 'feature_dev', 'QUEUED', v_owner,
    now() + interval '1 minute', v_tpl.execution_engine, v_tpl.policy_version,
    v_tpl.capability_policy_snapshot, v_tpl.harness_version
  );

  v_conv := public.create_code_qa_conversation(array['kdmanage-backend'], 'release', '选型-跳过无Key');
  v_turn := public.request_code_qa_turn((v_conv ->> 'id')::uuid, '问题三');

  select model_config_id into v_chosen
  from public.code_qa_turn where id = (v_turn ->> 'id')::uuid;

  perform pg_temp.assert(v_chosen = v_old,
    'a job whose config has no key must be skipped, not selected');

  ----------------------------------------------------------------------------
  -- 边界：一个可用配置都没有时入队即失败，且区分"没配置"与"没 Key"。
  ----------------------------------------------------------------------------
  update public.ai_model_config set enabled = false where id in (v_old, v_new);
  -- 只剩 v_nokey 启用（有配置但没 Key）→ MODEL_SECRET_MISSING。
  v_conv := public.create_code_qa_conversation(array['kdmanage-backend'], 'release', '选型-无Key');
  begin
    perform public.request_code_qa_turn((v_conv ->> 'id')::uuid, '问题四');
    perform pg_temp.assert(false, 'must fail when no usable config exists');
  exception when others then
    perform pg_temp.assert(sqlerrm like '%MODEL_SECRET_MISSING%',
      'enabled-but-keyless must report MODEL_SECRET_MISSING (admin should add a key), got: '
      || sqlerrm);
  end;

  update public.ai_model_config set enabled = false where id = v_nokey;
  -- 一个启用配置都没有 → MODEL_CONFIG_NOT_FOUND。
  v_conv := public.create_code_qa_conversation(array['kdmanage-backend'], 'release', '选型-无配置');
  begin
    perform public.request_code_qa_turn((v_conv ->> 'id')::uuid, '问题五');
    perform pg_temp.assert(false, 'must fail when nothing is enabled');
  exception when others then
    perform pg_temp.assert(sqlerrm like '%MODEL_CONFIG_NOT_FOUND%',
      'nothing enabled must report MODEL_CONFIG_NOT_FOUND (admin should create one), got: '
      || sqlerrm);
  end;

  raise notice 'V1.23c code QA model selection test: all assertions passed';
end;
$test$;

rollback;
