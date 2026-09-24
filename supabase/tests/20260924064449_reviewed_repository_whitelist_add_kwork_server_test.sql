-- 20260924064449_reviewed_repository_whitelist_add_kwork_server_test.sql
--
-- 受评审仓库白名单扩到 5 个之后的数据库契约。
--
-- 断言以"这一处漏改会怎样静默出错"组织：
--   1. 目录函数就是 5 个仓，且 kwork-server 的 GitLab 路径**不在** kwork/manage/ 下
--   2. 空 HEAD 对象的键集合跟着白名单走（少一个键 = 增量分析走错分支）
--   3. 两个 CHECK 约束接受新仓、仍然拒绝表外的名字
--   4. `save_repository_snapshots` 要求数量等于白名单长度：送 4 个必须被拒
--   5. 续跑判定用"本次送来的数量"而不是全局长度（否则扩仓前冻结的 Job 会被误判 HEAD 漂移）
--   6. commit manifest 与 MR 采集都接受 kwork-server（后者还要拿到正确的项目路径）
--   7. 运行监控的字段允许列表保留 kwork-server（否则那个仓的事件被静默丢弃）

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
  v_admin uuid := '1ab00000-0000-4000-a000-000000000001';
  v_model uuid := '1ab00000-0000-4000-a000-000000000010';
  v_batch uuid := '1ab00000-0000-4000-a000-000000000020';
  v_secret uuid;
  v_job uuid;
  v_story uuid;
  v_names text[];
  v_heads jsonb;
  v_payload jsonb;
  v_snapshots jsonb;
  v_error text;
begin
  -- ---- 1. 目录函数 --------------------------------------------------------
  v_names := public.analysis_allowed_repository_names();
  perform pg_temp.assert(
    v_names = array[
      'kdmanage-backend','kdmanage-frontend','kwork-server',
      'tmanage-backend','tmanage-frontend'
    ],
    'the catalog lists exactly the five reviewed repositories, sorted; got: '
      || array_to_string(v_names, ',')
  );
  perform pg_temp.assert(
    public.analysis_allowed_repository_count() = 5,
    'the count helper agrees with the name list'
  );
  -- kwork-server 的路径与前四个不同。任何"用名字拼 kwork/manage/ 前缀"的实现都会在这里失败。
  perform pg_temp.assert(
    public.analysis_repository_gitlab_project('kwork-server') = 'kwork/kwork-server',
    'kwork-server maps to kwork/kwork-server, not kwork/manage/kwork-server'
  );
  perform pg_temp.assert(
    public.analysis_repository_gitlab_project('tmanage-backend') = 'kwork/manage/tmanage-backend',
    'the original four keep their kwork/manage/ project paths'
  );
  perform pg_temp.assert(
    public.analysis_repository_gitlab_project('not-a-repo') is null,
    'an unknown name maps to null so callers can raise REPOSITORY_NOT_ALLOWED'
  );

  -- ---- 2. 空 HEAD 对象 ----------------------------------------------------
  v_heads := public.analysis_empty_repository_heads();
  perform pg_temp.assert(
    (select count(*) from jsonb_object_keys(v_heads)) = 5,
    'the empty-heads object has one key per whitelisted repository'
  );
  perform pg_temp.assert(
    v_heads ? 'kwork-server' and v_heads->>'kwork-server' is null,
    'kwork-server is present with a null head rather than missing entirely'
  );

  -- ---- 3. CHECK 约束 ------------------------------------------------------
  -- 装置：一个批次 + 一个 Job（Job 必须由 enqueue_analysis_job 建，手写 insert 会被
  -- manifest/policy 冻结触发器以 V4_CAPABILITY_POLICY_MISSING 拒掉）。
  insert into auth.users (id, email) values (v_admin, 'admin_repo_whitelist@example.com')
  on conflict (id) do nothing;
  insert into public.user_profile (id, role) values (v_admin, 'ADMIN')
  on conflict (id) do update set role = 'ADMIN';
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', v_admin::text, 'role', 'authenticated')::text,
    true
  );

  set local role service_role;
  v_secret := public.admin_vault_create_secret('repo-whitelist-not-a-real-key', 'repo_whitelist_key');
  reset role;

  insert into public.ai_model_config (
    id, display_name, base_url, model_name, api_key_secret_id,
    enabled, max_parallel_tasks, created_by
  ) values (
    v_model, 'Repo whitelist model', 'https://model-repo.example.com', 'model-repo',
    v_secret, true, 4, v_admin
  );
  insert into public.review_batch (id, name, week_code, default_branch, ai_model_config_id, created_by)
  values (v_batch, 'Repo whitelist batch', '2026-W39', 'feature_dev', v_model, v_admin);
  insert into public.review_story (id, batch_id, story_code, story_name, owners_text, source_data)
  values (gen_random_uuid(), v_batch, 'REPO-1', '扩仓需求', 'dev-a', '{}'::jsonb)
  returning id into v_story;

  v_job := public.enqueue_analysis_job(v_batch);

  -- 新仓必须能插进快照表。
  insert into public.analysis_repository_snapshot (
    job_id, repository_name, requested_branch, commit_sha
  ) values (v_job, 'kwork-server', 'feature_dev', repeat('a', 40));
  perform pg_temp.assert(
    exists (
      select 1 from public.analysis_repository_snapshot
      where job_id = v_job and repository_name = 'kwork-server'
    ),
    'the snapshot CHECK accepts kwork-server'
  );
  -- 表外的名字仍然要拒。
  begin
    insert into public.analysis_repository_snapshot (
      job_id, repository_name, requested_branch, commit_sha
    ) values (v_job, 'evil-repo', 'feature_dev', repeat('b', 40));
    perform pg_temp.assert(false, 'an unlisted repository name must still be rejected');
  exception when check_violation then
    null;
  end;
  delete from public.analysis_repository_snapshot where job_id = v_job;

  -- ---- 4. 快照数量契约 ----------------------------------------------------
  set local role service_role;
  update public.analysis_job
  set status = 'PREPARING_CODE', worker_id = 'worker-repo-whitelist', analysis_context_version = 1
  where id = v_job;

  -- 只送 4 个（旧 Worker 的行为）必须被拒，且错误信息要报出期望数量。
  select jsonb_agg(jsonb_build_object(
    'repository_name', name, 'requested_branch', 'feature_dev', 'commit_sha', repeat('c', 40)
  ))
  into v_snapshots
  from unnest(array[
    'kdmanage-backend','kdmanage-frontend','tmanage-backend','tmanage-frontend'
  ]) as name;
  begin
    perform public.save_repository_snapshots(v_job, 'worker-repo-whitelist', v_snapshots);
    perform pg_temp.assert(false, 'a four-repository snapshot set must be rejected now');
  exception when others then
    v_error := sqlerrm;
    perform pg_temp.assert(
      v_error like '%exactly 5 repository snapshots are required%',
      'the rejection names the expected count, got: ' || v_error
    );
  end;

  -- 送全 5 个就通过，并且新仓真的落进了快照表。
  select jsonb_agg(jsonb_build_object(
    'repository_name', name, 'requested_branch', 'feature_dev', 'commit_sha', repeat('d', 40)
  ))
  into v_snapshots
  from unnest(public.analysis_allowed_repository_names()) as name;
  perform public.save_repository_snapshots(v_job, 'worker-repo-whitelist', v_snapshots);
  perform pg_temp.assert(
    (select count(*) from public.analysis_repository_snapshot where job_id = v_job) = 5,
    'all five repositories are frozen'
  );
  perform pg_temp.assert(
    exists (
      select 1 from public.analysis_repository_snapshot
      where job_id = v_job and repository_name = 'kwork-server'
    ),
    'kwork-server survives the canonical snapshot RPC'
  );

  -- ---- 6. commit manifest 与 MR 采集接受新仓 ------------------------------
  -- 两个 RPC 都要求 Job 处于 scope 准备态且 worker 持有租约；这里只验"仓库名不再被拒"，
  -- 所以拿错误码来区分：REPOSITORY_NOT_ALLOWED 表示白名单没打通，其它错误码都算通过。
  begin
    perform public.save_analysis_repository_commit_manifest(
      v_job, 'worker-repo-whitelist', 'kwork-server', '{}'::jsonb, repeat('e', 64)
    );
  exception when others then
    v_error := sqlerrm;
    perform pg_temp.assert(
      v_error not like '%REPOSITORY_NOT_ALLOWED%',
      'the commit manifest RPC accepts kwork-server, got: ' || v_error
    );
  end;
  begin
    perform public.save_analysis_repository_merge_requests(
      v_job, 'worker-repo-whitelist', 'kwork-server', 'UNAVAILABLE',
      'MR_METADATA_UNAVAILABLE', '[]'::jsonb
    );
  exception when others then
    v_error := sqlerrm;
    perform pg_temp.assert(
      v_error not like '%REPOSITORY_NOT_ALLOWED%',
      'the MR enrichment RPC accepts kwork-server, got: ' || v_error
    );
  end;

  -- ---- 7. 运行监控字段允许列表 --------------------------------------------
  -- 用 REPOSITORY_PREPARE_COMPLETED：它是事件目录里真正带 repository_name 的事件类型之一
  -- （另两个是 STARTED / FAILED）。拿一个不带这个键的事件类型去测，只会测到"目录里没这个键"。
  v_payload := public.analysis_runtime_event_payload(
    'REPOSITORY_PREPARE_COMPLETED',
    jsonb_build_object('repository_name', 'kwork-server')
  );
  perform pg_temp.assert(
    v_payload->>'repository_name' = 'kwork-server',
    'the runtime event allowlist keeps kwork-server instead of silently dropping it'
  );
  v_payload := public.analysis_runtime_event_payload(
    'REPOSITORY_PREPARE_COMPLETED',
    jsonb_build_object('repository_name', 'evil-repo')
  );
  perform pg_temp.assert(
    not (v_payload ? 'repository_name'),
    'an unlisted repository name is still dropped from runtime events'
  );
end;
$test$;

-- ---------------------------------------------------------------------------
-- 5. 续跑判定：用"本次送来的数量"而不是全局白名单长度
--
-- 单独一个块，因为它需要一个 analysis_context_version=2 且已经冻结过 story 快照的 Job，
-- 装置与上面那组互相干扰。
-- ---------------------------------------------------------------------------
do $test2$
declare
  v_admin uuid := '1ab00000-0000-4000-a000-000000000001';
  v_batch uuid := '1ab00000-0000-4000-a000-000000000021';
  v_model uuid := '1ab00000-0000-4000-a000-000000000010';
  v_job uuid;
  v_snapshots jsonb;
  v_error text;
begin
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', v_admin::text, 'role', 'authenticated')::text,
    true
  );
  insert into public.review_batch (id, name, week_code, default_branch, ai_model_config_id, created_by)
  values (v_batch, 'Repo whitelist reclaim batch', '2026-W40', 'feature_dev', v_model, v_admin);
  insert into public.review_story (batch_id, story_code, story_name, owners_text, source_data)
  values (v_batch, 'REPO-2', '续跑需求', 'dev-b', '{}'::jsonb);

  v_job := public.enqueue_analysis_job(v_batch);

  set local role service_role;
  update public.analysis_job
  set status = 'PREPARING_SCOPE', worker_id = 'worker-reclaim', analysis_context_version = 2
  where id = v_job;

  -- 模拟"扩仓之前冻结的 Job"：库里只有 4 行快照，而且已经冻结过 story 输入。
  insert into public.analysis_repository_snapshot (
    job_id, repository_name, requested_branch, commit_sha, head_sha, enumeration_status
  )
  select v_job, name, 'feature_dev', repeat('f', 40), repeat('f', 40), 'PENDING'
  from unnest(array[
    'kdmanage-backend','kdmanage-frontend','tmanage-backend','tmanage-frontend'
  ]) as name;
  -- input_hash 是这张表的必填列；这里只要"存在已冻结的 story 输入"这一事实，
  -- 取什么值不影响被测的续跑判定。
  insert into public.analysis_job_story_snapshot (
    job_id, story_id, story_code, story_name, owners_text, input_hash
  )
  select v_job, story.id, story.story_code, story.story_name, story.owners_text, repeat('1', 64)
  from public.review_story story where story.batch_id = v_batch;

  -- 新 Worker 送 5 个：库里 4 行 ≠ 送来 5 个，必须以 HEAD 漂移拒绝，
  -- 而**不是**混合两代输入。
  select jsonb_agg(jsonb_build_object(
    'repository_name', name, 'requested_branch', 'feature_dev', 'commit_sha', repeat('f', 40)
  ))
  into v_snapshots
  from unnest(public.analysis_allowed_repository_names()) as name;
  begin
    perform public.save_repository_snapshots(v_job, 'worker-reclaim', v_snapshots);
    perform pg_temp.assert(false, 'a 4-repo job must not silently accept a 5-repo takeover');
  exception when others then
    v_error := sqlerrm;
    perform pg_temp.assert(
      v_error like '%PREPARATION_RECLAIM_HEAD_MISMATCH%',
      'the takeover is refused as a head mismatch, got: ' || v_error
    );
  end;
end;
$test2$;

rollback;
