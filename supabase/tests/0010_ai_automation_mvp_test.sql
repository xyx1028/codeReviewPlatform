-- 0010_ai_automation_mvp_test.sql
-- ---------------------------------------------------------------------------
-- AI 自动化 MVP（迁移 0010..0016）行为回归测试。
--
-- 运行要求：
--   * 目标库已按顺序应用 0001..0016（真实 Supabase 或本地 Postgres 均可）。
--   * 以超级用户 / 库属主（通常 postgres）执行，需能 `set local role`。
--   * 使用 psql 并开启 ON_ERROR_STOP，任一断言失败即以非零码退出。
--
-- 安全性：
--   * 整个脚本包裹在单个 BEGIN ... ROLLBACK 事务里，执行结束不留任何数据。
--   * 只使用固定的高熵测试 UUID（10-前缀命名空间），避免与真实数据冲突。
--   * 兼容真实 Vault 与测试 Vault 桩：密钥写入统一通过 public.admin_vault_create_secret，
--     该 public 包装在两种环境下都存在。
--
-- 断言方式：不依赖 pgTAP。用 DO 块 + RAISE EXCEPTION 实现断言；
-- 需要验证“某操作必须失败/回滚”的场景，使用 BEGIN ... EXCEPTION 子事务块。
-- ---------------------------------------------------------------------------

\set ON_ERROR_STOP on
\timing off
\set QUIET on

begin;

-- 收紧噪声，仅显示 WARNING 及以上（我们用 RAISE EXCEPTION 表达失败）。
set local client_min_messages = warning;

-- ---------------------------------------------------------------------------
-- 0. 通用断言辅助（临时函数，事务结束随 ROLLBACK 消失）
-- ---------------------------------------------------------------------------

create or replace function pg_temp.assert(p_cond boolean, p_msg text)
returns void language plpgsql as $$
begin
  if p_cond is null or p_cond = false then
    raise exception 'ASSERT FAILED: %', p_msg;
  end if;
end;
$$;

-- 断言某段 SQL 会抛出异常（可选：错误信息包含指定子串）。
create or replace function pg_temp.assert_raises(p_sql text, p_contains text, p_msg text)
returns void language plpgsql as $$
declare
  v_err text;
begin
  begin
    execute p_sql;
  exception when others then
    v_err := sqlerrm;
    if p_contains is not null and position(p_contains in v_err) = 0 then
      raise exception 'ASSERT FAILED: % — expected error containing "%", got "%"',
        p_msg, p_contains, v_err;
    end if;
    return;
  end;
  raise exception 'ASSERT FAILED: % — expected an exception but none was raised', p_msg;
end;
$$;

-- 以 authenticated 角色 + 指定用户身份执行只读探针，返回是否命中/命中行数由调用方约定。
-- 这里封装“切换到 authenticated 并设置 jwt claims -> 执行 -> 复位为库属主”。
create or replace function pg_temp.as_authenticated_count(p_uid uuid, p_sql text)
returns bigint language plpgsql as $$
declare
  v_count bigint;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid::text, 'role', 'authenticated')::text, true);
  set local role authenticated;
  execute p_sql into v_count;
  reset role;
  return v_count;
end;
$$;

-- 以 authenticated 身份执行一段 SQL，期望其失败（权限/RLS 拒绝）。
create or replace function pg_temp.as_authenticated_expect_error(p_uid uuid, p_sql text, p_msg text)
returns void language plpgsql as $$
declare
  v_raised boolean := false;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid::text, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    execute p_sql;
  exception when others then
    v_raised := true;
  end;
  reset role;
  if not v_raised then
    raise exception 'ASSERT FAILED: % — expected authenticated call to be denied but it succeeded', p_msg;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 1. 固定测试数据 UUID（高熵命名空间，避免与真实数据冲突）
-- ---------------------------------------------------------------------------

do $fixture$
declare
  -- 用户
  v_admin       uuid := '10000000-0000-4000-a000-0000000000a1';
  v_reviewer    uuid := '10000000-0000-4000-a000-0000000000a2';
  v_outsider    uuid := '10000000-0000-4000-a000-0000000000a3';
  -- 模型
  v_model_a     uuid := '10000000-0000-4000-b000-0000000000b1'; -- max_parallel_tasks=4
  v_model_b     uuid := '10000000-0000-4000-b000-0000000000b2'; -- max_parallel_tasks=8（可扩展）
  v_secret_a    uuid;
  v_secret_b    uuid;
  -- 批次
  v_batch       uuid := '10000000-0000-4000-c000-0000000000c1';
  -- 其它临时
  v_job         uuid;
  v_snap_json   jsonb;
  v_env         jsonb;
  v_task        uuid;
  v_import      uuid;
  v_cnt         integer;
  v_txt         text;
  v_bool        boolean;
  v_arr         jsonb;
  v_story_codes text[];
  v_results     jsonb;
  v_evidence    jsonb;
  v_snap_sha    text;
  v_first_task  uuid;
  v_second_task uuid;
  v_result_env  jsonb;
  v_first_task_ret integer;
begin
  ---------------------------------------------------------------------------
  -- 1a. auth.users + user_profile（触发器会自动建 profile；随后设定角色）
  ---------------------------------------------------------------------------
  insert into auth.users (id, email) values
    (v_admin,    'admin_10test@example.com'),
    (v_reviewer, 'reviewer_10test@example.com'),
    (v_outsider, 'outsider_10test@example.com')
  on conflict (id) do nothing;

  -- 保证 profile 存在并设定角色（不同环境触发器行为不完全一致，这里兜底 upsert）
  insert into public.user_profile (id, role) values (v_admin, 'ADMIN')
    on conflict (id) do update set role = 'ADMIN';
  insert into public.user_profile (id, role) values (v_reviewer, 'REVIEWER')
    on conflict (id) do update set role = 'REVIEWER';
  insert into public.user_profile (id, role) values (v_outsider, 'VIEWER')
    on conflict (id) do update set role = 'VIEWER';

  -- 以 admin 身份运行后续 SECURITY DEFINER RPC（其内部读取 auth.uid()）。
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_admin::text, 'role', 'authenticated')::text, true);

  ---------------------------------------------------------------------------
  -- 1b. 通过 service_role Vault 包装写入两个密钥（兼容真实/桩）
  ---------------------------------------------------------------------------
  set local role service_role;
  v_secret_a := public.admin_vault_create_secret('sk-test-key-a-10test', 'ai_key_a_10test');
  v_secret_b := public.admin_vault_create_secret('sk-test-key-b-10test', 'ai_key_b_10test');
  reset role;

  ---------------------------------------------------------------------------
  -- 1c. 两个模型配置（A: max_parallel=4；B: max_parallel=8 —— 说明可扩展到 8）
  ---------------------------------------------------------------------------
  insert into public.ai_model_config
    (id, display_name, provider, base_url, model_name, api_key_secret_id, enabled, max_parallel_tasks, created_by)
  values
    (v_model_a, 'Model A 10test', 'openai-compatible', 'https://a.example.com', 'model-a',
       v_secret_a, true, 4, v_admin),
    (v_model_b, 'Model B 10test', 'deepseek-harness',  'https://b.example.com', 'model-b',
       v_secret_b, true, 8, v_admin);

  ---------------------------------------------------------------------------
  -- 1d. 批次 + 20 条需求
  ---------------------------------------------------------------------------
  insert into public.review_batch (id, name, week_code, status, default_branch, created_by)
  values (v_batch, 'AI MVP Test Batch', 'WK-10TEST-001', 'WAITING_AI_RESULT', 'feature_dev', v_reviewer);

  insert into public.review_story (batch_id, story_code, story_name, owners_text, project_name, application_name, source_data)
  select v_batch,
         'ST-10T-' || lpad(g::text, 3, '0'),
         'Story ' || g,
         'owner' || g,
         'proj', 'app',
         jsonb_build_object('idx', g)
  from generate_series(1, 20) g;

  -- =========================================================================
  -- 断言组 A：模型快照、批次模型选择、job 创建、20 story -> 20 task
  -- =========================================================================

  -- A1. 模型快照不含 api_key_secret_id（也不含任何 secret 字段）
  v_snap_json := public.build_model_snapshot(v_model_a);
  perform pg_temp.assert(v_snap_json is not null, 'build_model_snapshot returns json');
  perform pg_temp.assert(not (v_snap_json ? 'api_key_secret_id'),
    'model snapshot must NOT contain api_key_secret_id');
  perform pg_temp.assert(not (v_snap_json::text ilike '%secret%'),
    'model snapshot must not mention any secret field');
  perform pg_temp.assert(v_snap_json->>'model_config_id' = v_model_a::text,
    'snapshot has model_config_id');

  -- A2. 新批次必须先选模型：未选模型入队应失败
  update public.review_batch set ai_model_config_id = null where id = v_batch;
  perform pg_temp.assert_raises(
    format('select public.enqueue_analysis_job(%L)', v_batch),
    'no model selected',
    'enqueue must fail when batch has no model');

  -- A2b. 选择模型（set_batch_model 校验启用 + 有密钥）
  perform public.set_batch_model(v_batch, v_model_a);
  select ai_model_config_id into v_txt from public.review_batch where id = v_batch;
  perform pg_temp.assert(v_txt = v_model_a::text, 'set_batch_model recorded model A');

  -- A3. 入队：分支唯一复制到 job；20 story -> 20 task
  v_job := public.enqueue_analysis_job(v_batch);
  perform pg_temp.assert(v_job is not null, 'enqueue returns a job id');

  select requested_branch, total_stories into v_txt, v_cnt
  from public.analysis_job where id = v_job;
  perform pg_temp.assert(v_txt = 'feature_dev',
    'job.requested_branch copied uniquely from batch.default_branch');
  perform pg_temp.assert(v_cnt = 20, 'job.total_stories = 20');

  select count(*) into v_cnt from public.analysis_story_task where job_id = v_job;
  perform pg_temp.assert(v_cnt = 20, '20 stories decompose into exactly 20 tasks');

  -- job.model_snapshot 也不含 secret
  select model_snapshot into v_snap_json from public.analysis_job where id = v_job;
  perform pg_temp.assert(not (v_snap_json ? 'api_key_secret_id'),
    'job.model_snapshot must not contain api_key_secret_id');

  -- 批次冻结快照同样无密钥
  select ai_model_snapshot into v_snap_json from public.review_batch where id = v_batch;
  perform pg_temp.assert(not (v_snap_json ? 'api_key_secret_id'),
    'batch.ai_model_snapshot must not contain api_key_secret_id');

  -- =========================================================================
  -- 断言组 B：claim_job_for_preparation / save_repository_snapshots / claim_next_story_task
  -- =========================================================================

  -- B1. 领取准备任务：JSON 信封含 job + model
  set local role service_role;
  v_env := public.claim_job_for_preparation('w-prep-1', 900);
  reset role;
  perform pg_temp.assert(v_env is not null, 'claim_job_for_preparation returns envelope');
  perform pg_temp.assert(v_env ? 'job' and v_env ? 'model', 'preparation envelope has job + model keys');
  perform pg_temp.assert(v_env->'job'->>'id' = v_job::text, 'envelope job id matches');
  perform pg_temp.assert(v_env->'job'->>'requested_branch' = 'feature_dev', 'envelope branch matches');
  perform pg_temp.assert(not (v_env->'model' ? 'api_key_secret_id'),
    'preparation envelope model must not contain api_key_secret_id');

  select status into v_txt from public.analysis_job where id = v_job;
  perform pg_temp.assert(v_txt = 'PREPARING_CODE', 'job moved to PREPARING_CODE');

  -- B2. 保存 4 个仓库快照，job -> PROCESSING
  v_snap_sha := repeat('a', 40);
  v_snap_json := jsonb_build_array(
    jsonb_build_object('repository_name','kdmanage-backend','commit_sha', v_snap_sha,'commit_subject','c1'),
    jsonb_build_object('repository_name','kdmanage-frontend','commit_sha', v_snap_sha,'commit_subject','c2'),
    jsonb_build_object('repository_name','tmanage-backend','commit_sha', v_snap_sha,'commit_subject','c3'),
    jsonb_build_object('repository_name','tmanage-frontend','commit_sha', v_snap_sha,'commit_subject','c4')
  );

  -- 错误 owner 保存应被拒绝（JOB_LEASE_LOST）
  perform pg_temp.assert_raises(
    format('select public.save_repository_snapshots(%L, %L, %L::jsonb)', v_job, 'w-prep-WRONG', v_snap_json::text),
    'JOB_LEASE_LOST',
    'save_repository_snapshots rejects wrong worker');

  -- 错误 owner 同样不能把准备中的 job 迟到写成 FAILED。
  perform pg_temp.assert_raises(
    format('select public.fail_claimed_analysis_job(%L, %L, %L, %L)',
      v_job, 'w-prep-WRONG', 'GIT_BRANCH_MISSING', 'late failure'),
    'JOB_LEASE_LOST',
    'late preparation failure is rejected');
  select status into v_txt from public.analysis_job where id = v_job;
  perform pg_temp.assert(v_txt = 'PREPARING_CODE',
    'wrong-owner preparation failure leaves the job PREPARING_CODE');

  -- 少于 4 个快照应被拒绝
  perform pg_temp.assert_raises(
    format('select public.save_repository_snapshots(%L, %L, %L::jsonb)', v_job, 'w-prep-1',
      (v_snap_json - 0)::text),
    'exactly 4 repository snapshots',
    'save_repository_snapshots requires exactly 4');

  -- 正确保存 4 个快照
  set local role service_role;
  perform public.save_repository_snapshots(v_job, 'w-prep-1', v_snap_json);
  reset role;

  select count(*) into v_cnt from public.analysis_repository_snapshot where job_id = v_job;
  perform pg_temp.assert(v_cnt = 4, 'exactly 4 repository snapshots saved');
  select status into v_txt from public.analysis_job where id = v_job;
  perform pg_temp.assert(v_txt = 'PROCESSING', 'job moved to PROCESSING after snapshots');

  -- B3. claim_next_story_task：JSON 信封 + task 唯一 + max_parallel=4 时第 5 个为 null
  set local role service_role;
  v_result_env := public.claim_next_story_task('w-task-1', 900);
  reset role;
  perform pg_temp.assert(v_result_env is not null, 'claim_next_story_task returns envelope');
  perform pg_temp.assert(v_result_env ? 'job' and v_result_env ? 'model'
    and v_result_env ? 'snapshots' and v_result_env ? 'story',
    'story task envelope has job/model/snapshots/story');
  perform pg_temp.assert(jsonb_array_length(v_result_env->'snapshots') = 4,
    'story task envelope carries 4 snapshots');
  perform pg_temp.assert(not (v_result_env->'model' ? 'api_key_secret_id'),
    'story task envelope model has no api_key_secret_id');
  v_first_task := (v_result_env->>'id')::uuid;
  perform pg_temp.assert(v_first_task is not null, 'envelope carries task id');

  -- 领取阶段：检索 RUNNING，attempt 从 0->1（仅 1 次）
  select retrieval_status, retrieval_attempt into v_txt, v_cnt
  from public.analysis_story_task where id = v_first_task;
  perform pg_temp.assert(v_txt = 'RUNNING', 'claimed task retrieval RUNNING');
  perform pg_temp.assert(v_cnt = 1, 'retrieval_attempt incremented exactly once on claim');

  -- 再领取 3 个（累计 4 个持租约任务，达到 model A 上限）
  set local role service_role;
  v_result_env := public.claim_next_story_task('w-task-2', 900);
  perform pg_temp.assert(v_result_env is not null, 'claim task 2');
  v_result_env := public.claim_next_story_task('w-task-3', 900);
  perform pg_temp.assert(v_result_env is not null, 'claim task 3');
  v_result_env := public.claim_next_story_task('w-task-4', 900);
  perform pg_temp.assert(v_result_env is not null, 'claim task 4');
  v_second_task := (v_result_env->>'id')::uuid;

  -- 第 5 次领取：model A max_parallel_tasks=4，应返回 null（严格模型级并发）
  v_result_env := public.claim_next_story_task('w-task-5', 900);
  reset role;
  perform pg_temp.assert(v_result_env is null,
    'the 5th claim must be null at max_parallel_tasks=4 (model B is configured with 8 to demonstrate scalability)');

  -- task 唯一：4 个领取到的 task_id 互不相同
  select count(distinct id) into v_cnt
  from public.analysis_story_task
  where job_id = v_job and worker_id in ('w-task-1','w-task-2','w-task-3','w-task-4');
  perform pg_temp.assert(v_cnt = 4, 'four distinct tasks claimed (task uniqueness)');

  -- =========================================================================
  -- 断言组 C：heartbeat 正确/错误 owner；租约过期接管；迟到 save 拒绝 TASK_LEASE_LOST
  -- =========================================================================

  -- C1. 正确 owner 心跳成功
  set local role service_role;
  v_bool := public.heartbeat_story_task(v_first_task, 'w-task-1', 900);
  reset role;
  perform pg_temp.assert(v_bool = true, 'heartbeat succeeds for correct owner');

  -- C2. 错误 owner 心跳失败（返回 false）
  set local role service_role;
  v_bool := public.heartbeat_story_task(v_first_task, 'w-task-WRONG', 900);
  reset role;
  perform pg_temp.assert(v_bool = false, 'heartbeat fails for wrong owner');

  -- C3. 租约过期后可被其它 worker 接管。
  --     为确定性验证“接管的正是过期任务”，需要让 first_task 成为唯一可领取任务，
  --     同时不撑爆 model A 的并发上限（=4）。策略：
  --       * 让 first_task 租约过期（唯一“可领取”任务）。
  --       * 其余 16 个从未领取(PENDING、无 worker)的任务临时标记为两阶段 SUCCEEDED，
  --         这样它们既不可领取、也不计入并发在途数（succeeded 被排除）。
  --       * 已领取的 w-task-2/3/4（含 second_task）保持有效租约不动，
  --         以便后续 fail_story_task 验证仍成立；它们持有效租约故不可被领取，
  --         在途数=3 < 4，允许接管发放。
  update public.analysis_story_task
  set retrieval_status = 'SUCCEEDED', analysis_status = 'SUCCEEDED'
  where job_id = v_job and worker_id is null;

  update public.analysis_story_task
  set lease_expires_at = now() - interval '1 minute'
  where id = v_first_task;

  set local role service_role;
  v_result_env := public.claim_next_story_task('w-takeover', 900);
  reset role;
  perform pg_temp.assert(v_result_env is not null, 'expired lease task can be taken over');
  perform pg_temp.assert((v_result_env->>'id')::uuid = v_first_task,
    'takeover picks the expired task');

  -- C4. 迟到 save：原 owner w-task-1 已失去租约，保存检索结果应被拒绝 TASK_LEASE_LOST
  perform pg_temp.assert_raises(
    format('select public.save_retrieval_result(%L, %L, %L::jsonb)', v_first_task, 'w-task-1', '{"k":"v"}'),
    'TASK_LEASE_LOST',
    'late save_retrieval_result by old owner rejected with TASK_LEASE_LOST');

  -- =========================================================================
  -- 断言组 D：save retrieval/analysis 进度、attempt 仅 1、fail 令 job FAILED、retry 复用
  -- =========================================================================

  -- 现在 first_task 由 w-takeover 持有。保存检索结果。
  -- 保存检索结果不应改变 attempt（attempt 只在领取时 +1）。
  set local role service_role;
  perform public.save_retrieval_result(v_first_task, 'w-takeover',
    '{"findings":"ok"}'::jsonb, 'model-a', 'retrieval-v1');
  reset role;

  select retrieval_status, retrieval_attempt into v_txt, v_cnt
  from public.analysis_story_task where id = v_first_task;
  perform pg_temp.assert(v_txt = 'SUCCEEDED', 'retrieval SUCCEEDED after save');
  -- first_task 共被领取两次（初次 w-task-1 + 接管 w-takeover），故 attempt = 2；
  -- 关键性质：保存动作本身不增加 attempt（仅领取时 +1，无重复自增）。
  perform pg_temp.assert(v_cnt = 2,
    'retrieval_attempt equals number of claims (initial + takeover); save does not bump it');

  -- save_retrieval_result 会把 job.retrieved_stories 同步为“检索成功任务数”。
  -- 因本组前面为构造接管场景把 16 个未领取任务直接标记为 SUCCEEDED，
  -- 故此处断言 job 计数 == 表内检索成功任务数（RPC 计数与真实状态一致），
  -- 且该计数包含刚保存成功的 first_task。
  select count(*) into v_cnt from public.analysis_story_task
    where job_id = v_job and retrieval_status = 'SUCCEEDED';
  select retrieved_stories into v_first_task_ret from public.analysis_job where id = v_job;
  perform pg_temp.assert(v_first_task_ret = v_cnt,
    'job.retrieved_stories equals count of retrieval-succeeded tasks');
  perform pg_temp.assert(v_first_task_ret >= 1,
    'job.retrieved_stories progressed to include the saved task');

  -- 分析阶段：first_task 仍持 w-takeover 租约且检索已成功；直接保存分析结果。
  set local role service_role;
  perform public.save_analysis_result(v_first_task, 'w-takeover',
    '{"verdict":"IMPLEMENTED"}'::jsonb, 'model-a', 'analysis-v1');
  reset role;

  select analysis_status into v_txt from public.analysis_story_task where id = v_first_task;
  perform pg_temp.assert(v_txt = 'SUCCEEDED', 'analysis SUCCEEDED after save');
  select count(*) into v_cnt from public.analysis_story_task
    where job_id = v_job and analysis_status = 'SUCCEEDED';
  select analyzed_stories into v_first_task_ret from public.analysis_job where id = v_job;
  perform pg_temp.assert(v_first_task_ret = v_cnt,
    'job.analyzed_stories equals count of analysis-succeeded tasks');
  perform pg_temp.assert(v_first_task_ret >= 1,
    'job.analyzed_stories progressed to include the saved task');

  -- D2. fail_story_task 令整个 job FAILED，并撤销同 Job 的全部任务租约。
  --     使用 second_task（w-task-4 持有且租约有效）。
  select retrieval_output, analysis_output into v_arr, v_snap_json
  from public.analysis_story_task where id = v_first_task;
  select id into v_task from public.analysis_story_task
  where job_id = v_job and worker_id = 'w-task-3';

  set local role service_role;
  perform public.fail_story_task(v_second_task, 'w-task-4', 'analysis', 'E_TEST', 'boom');
  reset role;

  select status into v_txt from public.analysis_job where id = v_job;
  perform pg_temp.assert(v_txt = 'FAILED', 'single task failure marks whole job FAILED');
  select analysis_status into v_txt from public.analysis_story_task where id = v_second_task;
  perform pg_temp.assert(v_txt = 'FAILED', 'failed task analysis_status FAILED');
  perform pg_temp.assert(not exists (
    select 1 from public.analysis_story_task
    where job_id = v_job
      and (retrieval_status = 'RUNNING' or analysis_status = 'RUNNING')
  ), 'job failure leaves no task stage RUNNING');
  perform pg_temp.assert(not exists (
    select 1 from public.analysis_story_task
    where job_id = v_job
      and (worker_id is not null or lease_expires_at is not null or heartbeat_at is not null)
  ), 'job failure clears all sibling task ownership and leases');
  perform pg_temp.assert((
    select worker_id is null and locked_at is null
      and finalizer_worker_id is null and finalize_lease_expires_at is null
    from public.analysis_job where id = v_job
  ), 'job failure clears all job-level ownership');
  perform pg_temp.assert((
    select retrieval_status = 'PENDING' and analysis_status = 'PENDING'
    from public.analysis_story_task where id = v_task
  ), 'running sibling returns to PENDING without being marked FAILED');
  perform pg_temp.assert((
    select retrieval_status = 'SUCCEEDED' and analysis_status = 'SUCCEEDED'
      and retrieval_output = v_arr and analysis_output = v_snap_json
    from public.analysis_story_task where id = v_first_task
  ), 'job failure preserves completed task status and outputs');

  set local role service_role;
  v_bool := public.heartbeat_story_task(v_task, 'w-task-3', 900);
  reset role;
  perform pg_temp.assert(v_bool = false, 'revoked sibling lease cannot heartbeat');
  perform pg_temp.assert_raises(
    format('select public.save_retrieval_result(%L, %L, %L::jsonb)', v_task, 'w-task-3', '{"late":true}'),
    'TASK_LEASE_LOST',
    'revoked sibling lease rejects late retrieval save');
  perform pg_temp.assert_raises(
    format('select public.save_analysis_result(%L, %L, %L::jsonb)', v_first_task, 'w-takeover', '{"late":true}'),
    'TASK_LEASE_LOST',
    'completed task old owner cannot write after job failure');
  set local role service_role;
  v_result_env := public.claim_next_story_task('w-after-failure', 900);
  reset role;
  perform pg_temp.assert(v_result_env is null, 'FAILED job offers no further story tasks');

  -- D2b. 错误 owner 调用 fail_story_task -> TASK_LEASE_LOST
  --      重新造一个持租约任务用于验证错误 owner 被拒。
  perform pg_temp.assert_raises(
    format('select public.fail_story_task(%L, %L, %L, %L, %L)', v_first_task, 'nobody', 'analysis', 'X', 'y'),
    'TASK_LEASE_LOST',
    'fail_story_task rejects non-owner with TASK_LEASE_LOST');

  -- D3. retry_analysis_job：复用 4 个快照，保留已成功的 retrieval
  --     记录 retry 前 first_task 的 retrieval_output（应保留）。
  select retrieval_output into v_arr from public.analysis_story_task where id = v_first_task;
  perform pg_temp.assert(v_arr is not null, 'first_task has retrieval_output before retry');

  perform public.retry_analysis_job(v_job);

  -- 快照仍是 4 个（复用）
  select count(*) into v_cnt from public.analysis_repository_snapshot where job_id = v_job;
  perform pg_temp.assert(v_cnt = 4, 'retry reuses the same 4 repository snapshots');

  -- 因为已有快照，retry 回到 PROCESSING
  select status into v_txt from public.analysis_job where id = v_job;
  perform pg_temp.assert(v_txt = 'PROCESSING', 'retry returns job to PROCESSING (snapshots present)');

  -- first_task 已完成两阶段：retry 保留其成功状态与 retrieval_output
  select retrieval_status, analysis_status, retrieval_output
    into v_txt, v_snap_sha, v_arr
  from public.analysis_story_task where id = v_first_task;
  perform pg_temp.assert(v_txt = 'SUCCEEDED' and v_snap_sha = 'SUCCEEDED',
    'retry preserves fully-succeeded task both stages');
  perform pg_temp.assert(v_arr is not null,
    'retry preserves already-succeeded retrieval_output');

  -- second_task（曾 FAILED）被重置为 PENDING，租约/错误清空
  select retrieval_status, analysis_status, worker_id, error_code
    into v_txt, v_snap_sha, v_snap_json, v_result_env
  from public.analysis_story_task where id = v_second_task;
  perform pg_temp.assert(v_txt = 'PENDING' and v_snap_sha = 'PENDING',
    'retry resets previously-failed task to PENDING');

  -- =========================================================================
  -- 断言组 E：finalizer 唯一/租约接管；非法 complete 事务行为；合法 complete 一次写、重复拒绝；
  --           evidence SHA 强制来自 snapshot
  -- =========================================================================
  -- 为进入 finalize，需要让全部 20 个 task 两阶段成功。
  -- first_task 已成功；把其余 19 个直接置为成功（测试内直接改表，模拟 worker 完成）。
  update public.analysis_story_task
  set retrieval_status = 'SUCCEEDED',
      analysis_status  = 'SUCCEEDED',
      retrieval_output = coalesce(retrieval_output, '{"findings":"ok"}'::jsonb),
      analysis_output  = coalesce(analysis_output, '{"verdict":"IMPLEMENTED"}'::jsonb),
      worker_id = null,
      lease_expires_at = null
  where job_id = v_job;

  -- E1. 领取 finalize：唯一 finalizer + 租约
  set local role service_role;
  v_env := public.claim_job_for_finalization('w-fin-1', 900);
  reset role;
  perform pg_temp.assert(v_env is not null, 'claim_job_for_finalization returns envelope');
  perform pg_temp.assert(v_env->'job'->>'id' = v_job::text, 'finalize envelope job matches');
  select status, finalizer_worker_id into v_txt, v_snap_sha from public.analysis_job where id = v_job;
  perform pg_temp.assert(v_txt = 'FINALIZING', 'job moved to FINALIZING');
  perform pg_temp.assert(v_snap_sha = 'w-fin-1', 'finalizer_worker_id recorded');

  -- E1b. 第二个 finalizer 在租约有效期内无法接管（返回 null）
  set local role service_role;
  v_env := public.claim_job_for_finalization('w-fin-2', 900);
  reset role;
  perform pg_temp.assert(v_env is null, 'finalization is unique while lease valid');

  -- E1c. 非 owner 不能把当前 finalizer 的 job 迟到写成 FAILED。
  perform pg_temp.assert_raises(
    format('select public.fail_claimed_analysis_job(%L, %L, %L, %L)',
      v_job, 'w-fin-WRONG', 'JOB_INTERNAL_ERROR', 'late failure'),
    'JOB_LEASE_LOST',
    'late finalizer failure is rejected');
  select status into v_txt from public.analysis_job where id = v_job;
  perform pg_temp.assert(v_txt = 'FINALIZING',
    'wrong-owner failure leaves the job FINALIZING');

  -- 组装合法 results：覆盖全部 20 个 story_code，各一次
  select array_agg(story_code order by story_code) into v_story_codes
  from public.review_story where batch_id = v_batch;

  select jsonb_agg(jsonb_build_object(
           'story_code', sc,
           'verdict', 'IMPLEMENTED',
           'confidence', 90,
           'summary', 'ok'))
    into v_results
  from unnest(v_story_codes) sc;

  -- E2. 非法 complete（结果数量不足）应回滚且不产生任何 ai_import_record。
  --     用 assert_raises（内部 BEGIN..EXCEPTION 子事务）验证异常并保证回滚。
  v_arr := (select jsonb_agg(e) from (select e from jsonb_array_elements(v_results) e limit 5) s);
  perform pg_temp.assert_raises(
    format('select public.complete_analysis_job(%L, %L, %L::jsonb, %L::jsonb)',
      v_job, 'w-fin-1', v_arr::text, '[]'),
    'does not match required stories',
    'complete rejects wrong results count');
  -- 事务行为：非法 complete 后不应写入结果
  select count(*) into v_cnt from public.ai_import_record where batch_id = v_batch;
  perform pg_temp.assert(v_cnt = 0, 'illegal complete produced NO ai_import_record (atomic rollback)');

  -- E2b. evidence 引用非快照仓库 -> EVIDENCE_PATH_INVALID（且回滚）
  v_evidence := jsonb_build_array(jsonb_build_object(
      'story_code', v_story_codes[1],
      'repository_name', 'not-a-snapshot-repo',
      'file_path', 'src/x.ts',
      'evidence_type', '现有实现',
      'description', 'd'));
  perform pg_temp.assert_raises(
    format('select public.complete_analysis_job(%L, %L, %L::jsonb, %L::jsonb)',
      v_job, 'w-fin-1', v_results::text, v_evidence::text),
    'EVIDENCE_PATH_INVALID',
    'complete rejects evidence whose repo is not in snapshots');
  select count(*) into v_cnt from public.ai_import_record where batch_id = v_batch;
  perform pg_temp.assert(v_cnt = 0, 'illegal evidence complete produced NO record (atomic rollback)');

  -- E3. 合法 complete：一次写入正式结果；evidence commit_sha 强制取快照 SHA。
  --     故意传入错误的 commit_sha，验证被快照 SHA 覆盖。
  v_evidence := jsonb_build_array(jsonb_build_object(
      'story_code', v_story_codes[1],
      'repository_name', 'kdmanage-backend',
      'commit_sha', repeat('f', 40),   -- 错误值，应被忽略
      'file_path', 'src/main.ts',
      'start_line', 10, 'end_line', 20,
      'evidence_type', '现有实现',
      'description', 'evidence one'));

  set local role service_role;
  v_import := public.complete_analysis_job(v_job, 'w-fin-1', v_results, v_evidence);
  reset role;
  perform pg_temp.assert(v_import is not null, 'legal complete returns import id');

  select count(*) into v_cnt from public.ai_import_record where batch_id = v_batch;
  perform pg_temp.assert(v_cnt = 1, 'legal complete writes exactly one ai_import_record');

  select count(*) into v_cnt from public.ai_review_result where ai_import_record_id = v_import;
  perform pg_temp.assert(v_cnt = 20, 'legal complete writes 20 ai_review_result rows');

  -- evidence SHA 强制来自快照（应为 'aaaa...'，而不是传入的 'ffff...'）
  select commit_sha into v_snap_sha
  from public.ai_code_evidence ev
  join public.ai_review_result r on r.id = ev.ai_review_result_id
  where r.ai_import_record_id = v_import
  limit 1;
  perform pg_temp.assert(v_snap_sha = repeat('a', 40),
    'evidence commit_sha is forced from snapshot, not from caller input');

  -- job -> SUCCEEDED；批次 -> REVIEWING
  select status into v_txt from public.analysis_job where id = v_job;
  perform pg_temp.assert(v_txt = 'SUCCEEDED', 'job SUCCEEDED after complete');
  select status into v_txt from public.review_batch where id = v_batch;
  perform pg_temp.assert(v_txt = 'REVIEWING', 'batch moved to REVIEWING after complete');

  -- E4. 重复 complete 被拒绝（job 不再 FINALIZING）
  perform pg_temp.assert_raises(
    format('select public.complete_analysis_job(%L, %L, %L::jsonb, %L::jsonb)',
      v_job, 'w-fin-1', v_results::text, '[]'),
    'not in FINALIZING state',
    'duplicate complete is rejected');

  -- =========================================================================
  -- 断言组 F：权限收敛（authenticated 不能直接访问敏感对象/RPC；service_role 授权存在）
  -- =========================================================================

  -- F1. authenticated 不能直接 select ai_model_config。
  --     0010 既未对 authenticated 授予表级 SELECT，又设置了 RLS policy using(false)；
  --     两道防线中任一都使直接查询被拒（表级权限先行 -> permission denied）。
  perform pg_temp.as_authenticated_expect_error(v_admin,
    'select count(*) from public.ai_model_config',
    'authenticated cannot directly read ai_model_config (even as ADMIN)');

  -- F1b. 确认 RLS 兜底 policy 存在且为 using(false)（即使将来放开表级权限也拒绝）。
  perform pg_temp.assert(exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'ai_model_config'
      and cmd = 'SELECT' and qual = 'false'
  ), 'ai_model_config has a SELECT RLS policy hard-denying (using false)');

  -- F2. authenticated 不能读取 vault 解密视图
  perform pg_temp.as_authenticated_expect_error(v_admin,
    'select count(*) from vault.decrypted_secrets',
    'authenticated must not read vault.decrypted_secrets');
  perform pg_temp.as_authenticated_expect_error(v_admin,
    'select count(*) from vault.secrets',
    'authenticated must not read vault.secrets');

  -- F3. authenticated 不能执行 Worker / secret RPC
  perform pg_temp.as_authenticated_expect_error(v_reviewer,
    format('select public.claim_next_story_task(%L, 900)', 'x'),
    'authenticated must not execute claim_next_story_task');
  perform pg_temp.as_authenticated_expect_error(v_reviewer,
    format('select public.complete_analysis_job(%L, %L, %L::jsonb, %L::jsonb)', v_job, 'x', '[]', '[]'),
    'authenticated must not execute complete_analysis_job');
  perform pg_temp.as_authenticated_expect_error(v_reviewer,
    format('select public.get_model_secret_for_job(%L, %L)', v_job, 'x'),
    'authenticated must not execute get_model_secret_for_job');
  perform pg_temp.as_authenticated_expect_error(v_reviewer,
    format('select public.admin_vault_create_secret(%L, %L)', 's', 'n'),
    'authenticated must not execute admin_vault_create_secret');
  perform pg_temp.as_authenticated_expect_error(v_reviewer,
    format('select public.admin_get_model_secret_by_config(%L)', v_model_a),
    'authenticated must not execute admin_get_model_secret_by_config');

  -- F4. 无密钥列表 RPC：返回列不含任何 secret id 字段（列名层面）
  --     以有建批次权限的 reviewer 调用 list_enabled_model_configs。
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_reviewer::text, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into v_cnt
  from public.list_enabled_model_configs() cfg
  where cfg.id in (v_model_a, v_model_b);
  reset role;
  perform pg_temp.assert(v_cnt = 2, 'list_enabled_model_configs returns both enabled+keyed models');

  -- 列名不包含 secret id：检查返回记录的 json 键
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_reviewer::text, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select to_jsonb(t) into v_snap_json
  from public.list_enabled_model_configs() t where t.id = v_model_a;
  reset role;
  perform pg_temp.assert(not (v_snap_json ? 'api_key_secret_id'),
    'list_enabled_model_configs output has no api_key_secret_id column');
  perform pg_temp.assert(v_snap_json ? 'has_api_key',
    'list_enabled_model_configs exposes has_api_key boolean instead of secret id');

  -- admin_list_model_configs 同样不含 secret id
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_admin::text, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select to_jsonb(t) into v_snap_json
  from public.admin_list_model_configs() t where t.id = v_model_a;
  reset role;
  perform pg_temp.assert(not (v_snap_json ? 'api_key_secret_id'),
    'admin_list_model_configs output has no api_key_secret_id column');

  -- F5. service_role 授权存在：核心 Worker RPC 对 service_role 有 EXECUTE。
  perform pg_temp.assert(
    has_function_privilege('service_role', 'public.claim_next_story_task(text, integer)', 'EXECUTE'),
    'service_role has EXECUTE on claim_next_story_task');
  perform pg_temp.assert(
    has_function_privilege('service_role', 'public.fail_story_task(uuid, text, text, text, text)', 'EXECUTE'),
    'service_role has EXECUTE on fail_story_task');
  perform pg_temp.assert(
    has_function_privilege('service_role', 'public.complete_analysis_job(uuid, text, jsonb, jsonb)', 'EXECUTE'),
    'service_role has EXECUTE on complete_analysis_job');
  perform pg_temp.assert(
    has_function_privilege('service_role', 'public.get_model_secret_for_job(uuid, text)', 'EXECUTE'),
    'service_role has EXECUTE on get_model_secret_for_job');
  perform pg_temp.assert(
    has_function_privilege('service_role', 'public.fail_claimed_analysis_job(uuid, text, text, text)', 'EXECUTE'),
    'service_role has EXECUTE on fail_claimed_analysis_job');
  perform pg_temp.assert(
    has_function_privilege('service_role', 'public.admin_vault_create_secret(text, text)', 'EXECUTE'),
    'service_role has EXECUTE on admin_vault_create_secret');
  -- authenticated 明确没有这些执行权限
  perform pg_temp.assert(
    not has_function_privilege('authenticated', 'public.claim_next_story_task(text, integer)', 'EXECUTE'),
    'authenticated has NO EXECUTE on claim_next_story_task');
  perform pg_temp.assert(
    not has_function_privilege('authenticated', 'public.fail_story_task(uuid, text, text, text, text)', 'EXECUTE'),
    'authenticated has NO EXECUTE on fail_story_task');
  perform pg_temp.assert(
    not has_function_privilege('authenticated', 'public.complete_analysis_job(uuid, text, jsonb, jsonb)', 'EXECUTE'),
    'authenticated has NO EXECUTE on complete_analysis_job');
  perform pg_temp.assert(
    not has_function_privilege('authenticated', 'public.fail_claimed_analysis_job(uuid, text, text, text)', 'EXECUTE'),
    'authenticated has NO EXECUTE on fail_claimed_analysis_job');

  -- =========================================================================
  -- 断言组 G：自动结果产生后，现有 human_review 仍可插入与查询
  -- =========================================================================
  -- 批次当前 REVIEWING，reviewer 是批次 owner，可写 human_review。
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_reviewer::text, 'role', 'authenticated')::text, true);
  set local role authenticated;

  insert into public.human_review (story_id, ai_review_result_id, reviewer_id, result, comment)
  select r.story_id, r.id, v_reviewer, 'CORRECT', 'looks good'
  from public.ai_review_result r
  where r.ai_import_record_id = v_import
  order by r.id
  limit 1;

  select count(*) into v_cnt
  from public.human_review hr
  join public.ai_review_result r on r.id = hr.ai_review_result_id
  where r.ai_import_record_id = v_import and hr.reviewer_id = v_reviewer;
  reset role;

  perform pg_temp.assert(v_cnt = 1,
    'human_review can be inserted and queried against AI-automation results');

  raise notice 'internal checks completed';
end;
$fixture$;

-- ---------------------------------------------------------------------------
-- 成功标记：所有断言均已通过（任一失败会在上方 RAISE EXCEPTION 并中止事务）。
-- ---------------------------------------------------------------------------
do $$
begin
  raise notice '%', 'ALL_AI_AUTOMATION_MVP_TESTS_PASSED';
end;
$$;

select 'ALL_AI_AUTOMATION_MVP_TESTS_PASSED' as result;

rollback;
