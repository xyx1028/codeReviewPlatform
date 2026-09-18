-- 并发闸门取"冻结上限"与"实时闸门"的较小值（V1.9.1）。
--
-- 文件名说明：与本批次前三个迁移同序列，秒数继续 +1（本机 `date -u` 当前返回
-- 2026091714xxxx，按真实 UTC 命名会排到 20260917143807 之前）。
--
-- ## 现象与取证
--
-- 26 个需求、同一套平台、同一条内网代理链路，三个模型的实测差距：
--
-- | 模型 | 整批耗时 | 需求/分钟 | 单次模型请求中位数 | 实测并发峰值 |
-- |---|---|---|---|---|
-- | qwen3.6-flash（公网直连） | 11.1 分 | 2.34 | — | 8 |
-- | glm5.3-flash（内网代理） | 16.8 分 | 1.55 | 5.9 秒 | 8 |
-- | kimi-k3（内网代理） | 63.0 分 | 0.46 | 27.0 秒 | 8 |
-- | kimi-k3（同配置改成 16 并发） | 63.1 分 | 0.41 | 65.7 秒 | 16 |
--
-- 最后两行是这份迁移存在的理由：把 kimi-k3 的并发从 8 提到 16 之后
--
--   * 吞吐**没有**提高（0.46 → 0.41 需求/分钟，略降）；
--   * 单次模型请求延迟涨了 2.4 倍（27 → 65.7 秒）；
--   * 于是单个 attempt 从 ~15 分钟变成 40~55 分钟，顺带触发租约接管与重跑。
--
-- 这是"服务端已经饱和"的典型特征：超过容量之后，额外并发只产生排队延迟，不产生吞吐。
--
-- ## 这份迁移要修的缺陷
--
-- `claim_next_story_task` 的并发判定读的是 `ai_model_config.max_parallel_tasks` 的**实时值**，
-- 而这个 Job 的其它一切（capability policy、模型路由、技能目录、Harness manifest）都按
-- Job 冻结。后果是真实发生过的：job `189a4302` 的 `model_snapshot.max_parallel_tasks` 是 8，
-- 但因为配置在它执行途中被改成 16，实测并发峰值就是 16 —— 一个已经在跑的批次被静默放大到
-- 冻结值的两倍，而放大的结果是上面那张表的最后一行。
--
-- ## 新规则：`least(冻结上限, 实时闸门)`
--
-- 两个方向刻意不对称：
--
--   * **调高实时值不能突破 Job 冻结的上限。** 在途批次的执行包络必须稳定，否则"这个批次
--     会跑多久"取决于中途有没有人动过配置。
--   * **调低实时值立刻生效，包括在途批次。** 这是事故期间唯一有效的收窄手段 —— 模型端被
--     打满时必须能马上限流，如果这时闸门只认冻结值，运维就没有任何办法。
--
-- 快照缺失（0027 之前创建、仍在 PROCESSING 的旧 Job）时退回实时值；两者都缺时仍是 4。
--
-- 签名不变（text, integer），所以直接 `create or replace`，不产生重载。

begin;

create or replace function public.claim_next_story_task(
  p_worker_id text,
  p_lease_seconds integer default 900
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_task public.analysis_story_task;
  v_job public.analysis_job;
  v_cfg public.ai_model_config;
  v_lock_key bigint;
  v_active integer;
  v_story public.review_story;
  v_token uuid;
  v_model jsonb;
  v_policy jsonb;
  v_revision integer;
  v_run public.analysis_agent_run;
  v_frozen_parallel integer;
  v_live_parallel integer;
  v_parallel integer;
begin
  if p_worker_id is null or btrim(p_worker_id) = '' then
    raise exception 'worker_id is required';
  end if;
  if p_lease_seconds is null or p_lease_seconds < 30 then
    p_lease_seconds := 900;
  end if;

  perform pg_advisory_xact_lock(hashtext('claim_next_story_task'));

  select task.* into v_task
  from public.analysis_story_task task
  join public.analysis_job job on job.id = task.job_id
  where job.status = 'PROCESSING'
    and job.execution_engine = 'deepseek-harness-acp'
    -- V4 Worker 只领 policy_version = 4 的任务；已完结的历史 Job 标成 3，不会被领。
    and job.policy_version = 4
    and (task.lease_expires_at is null or task.lease_expires_at < now())
    and task.agent_status not in ('SUCCEEDED', 'FAILED')
  order by job.created_at, task.created_at
  for update of task skip locked
  limit 1;

  if v_task.id is null then
    return null;
  end if;

  select job.* into v_job from public.analysis_job job where job.id = v_task.job_id;
  select cfg.* into v_cfg from public.ai_model_config cfg where cfg.id = v_job.model_config_id;

  v_lock_key := ('x' || substr(md5(v_job.model_config_id::text), 1, 16))::bit(64)::bigint;
  perform pg_advisory_xact_lock(v_lock_key);

  select count(*) into v_active
  from public.analysis_story_task task
  join public.analysis_job job on job.id = task.job_id
  where job.model_config_id = v_job.model_config_id
    and task.lease_expires_at is not null
    and task.lease_expires_at >= now();

  -- 冻结上限：Job 创建时 model_snapshot 里记下的那个值。
  v_frozen_parallel := nullif(v_job.model_snapshot->>'max_parallel_tasks', '')::integer;
  -- 实时闸门：管理员当前配置的值，事故期间用来立刻收窄。
  v_live_parallel := v_cfg.max_parallel_tasks;
  v_parallel := coalesce(
    least(
      coalesce(v_frozen_parallel, v_live_parallel),
      coalesce(v_live_parallel, v_frozen_parallel)
    ),
    4
  );

  if v_active >= v_parallel then
    return null;
  end if;

  v_token := gen_random_uuid();
  update public.analysis_story_task
  set worker_id = p_worker_id,
      lease_expires_at = now() + make_interval(secs => p_lease_seconds),
      heartbeat_at = now(),
      agent_status = 'RUNNING',
      agent_attempt = agent_attempt + 1,
      claim_token_digest = public.agent_claim_token_digest(v_token),
      started_at = coalesce(started_at, now())
  where id = v_task.id
  returning * into v_task;

  -- policy snapshot 缺失只可能出现在 0027 之前创建、仍在 PROCESSING 的在途 Job：
  -- 按当前配置补齐，而不是把 null 传给 Worker。
  v_policy := case
    when v_job.capability_policy_snapshot = '{}'::jsonb
    then public.build_v4_capability_policy(v_job.model_config_id)
    else v_job.capability_policy_snapshot
  end;

  -- fencing revision 在同一个 task 上全局单调，而不是每个 attempt 从 1 重新开始。
  -- 从 1 重新开始的后果是：被接管的旧 attempt 可能持有更高的 revision，从而"反超"
  -- 新 attempt 的写入检查。取全表最大值加一，任何迟到的写入都必然落后。
  select coalesce(max(run.session_revision), 0) + 1 into v_revision
  from public.analysis_agent_run run
  where run.task_id = v_task.id;

  insert into public.analysis_agent_run (
    task_id, job_id, agent_attempt, worker_id, status,
    policy_hash, session_revision
  ) values (
    v_task.id, v_job.id, v_task.agent_attempt, p_worker_id, 'RUNNING',
    encode(sha256(v_policy::text::bytea), 'hex'), v_revision
  )
  on conflict (task_id, agent_attempt) do update
  set worker_id = excluded.worker_id,
      status = 'RUNNING',
      started_at = now(),
      session_revision = excluded.session_revision,
      cancel_requested_at = null,
      cancel_reason = null,
      sealed_at = null,
      error_code = null,
      error_message = null
  returning * into v_run;

  select * into v_story from public.review_story where id = v_task.story_id;

  v_model := v_job.model_snapshot || jsonb_build_object(
    'context_window', coalesce(
      nullif(v_job.model_snapshot->>'context_window', '')::integer, v_cfg.context_window
    ),
    'max_output_tokens', coalesce(
      nullif(v_job.model_snapshot->>'max_output_tokens', '')::integer, v_cfg.max_output_tokens
    ),
    'agent_max_model_requests', coalesce(
      nullif(v_job.model_snapshot->>'agent_max_model_requests', '')::integer,
      v_cfg.agent_max_model_requests
    ),
    'agent_max_retry_requests', coalesce(
      nullif(v_job.model_snapshot->>'agent_max_retry_requests', '')::integer,
      v_cfg.agent_max_retry_requests
    ),
    'agent_max_compaction_requests', coalesce(
      nullif(v_job.model_snapshot->>'agent_max_compaction_requests', '')::integer,
      v_cfg.agent_max_compaction_requests
    ),
    -- 本次领取实际生效的并发闸门。写进 model 让 Worker 日志与监控台能解释
    -- "为什么只有 N 个在跑"，而不必让人去猜是配置还是冻结值起了作用。
    'effective_max_parallel_tasks', v_parallel
  );

  return (to_jsonb(v_task) - 'claim_token_digest')
    || jsonb_build_object(
      'claim_token', v_token,
      'agent_run_id', v_run.id,
      'session_revision', v_run.session_revision,
      'policy_version', v_job.policy_version,
      'capability_policy', v_policy,
      'policy_hash', v_run.policy_hash,
      'harness_version', v_job.harness_version,
      'capability_contract_hash', v_job.capability_contract_hash,
      'job', jsonb_build_object(
        'id', v_job.id,
        'batch_id', v_job.batch_id,
        'model_config_id', v_job.model_config_id,
        'requested_branch', v_job.requested_branch,
        'total_stories', v_job.total_stories,
        'policy_version', v_job.policy_version
      ),
      'model', v_model,
      'snapshots', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'repository_name', snapshot.repository_name,
          'requested_branch', snapshot.requested_branch,
          'commit_sha', snapshot.commit_sha,
          'commit_subject', snapshot.commit_subject
        ) order by snapshot.repository_name), '[]'::jsonb)
        from public.analysis_repository_snapshot snapshot
        where snapshot.job_id = v_job.id
      ),
      'story', jsonb_build_object(
        'story_id', v_story.id,
        'story_code', v_story.story_code,
        'story_name', v_story.story_name,
        'description', null,
        'acceptance_criteria', null,
        'project_name', v_story.project_name,
        'application_name', v_story.application_name,
        'source_data', v_story.source_data
      )
    );
end;
$$;

revoke execute on function public.claim_next_story_task(text, integer)
  from public, anon, authenticated;
grant execute on function public.claim_next_story_task(text, integer)
  to service_role;

commit;
